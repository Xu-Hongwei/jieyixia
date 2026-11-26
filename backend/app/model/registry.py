"""多 profile 装载与失败降级。

配置里只写密钥的环境变量名（api_key_env），密钥本身留在各自 .env，
因此 JXL_MODELS 可以入库、可以发给队友。缺密钥的 profile 自动跳过。
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import httpx

from ..guard import MODEL_QUOTA
from ..observability import log_event
from .adapters import ADAPTERS, build_adapter
from .base import ModelError, ModelProfile

_FIELDS = {
    "name", "protocol", "model", "base_url", "base_url_env", "api_key_env",
    "timeout_s", "max_tokens", "json_mode", "retries", "extra_body",
}

_MAX_TIMEOUT_S = 600.0
_MAX_RETRIES = 5
_MAX_TOKENS = 200_000
# 剩余预算低于该切片时不再发起新尝试/退避，避免「预算已尽还再等一轮」
_MIN_SLICE_S = 0.05


def _validate_profile(profile: ModelProfile, seen: set[str]) -> None:
    """配置类型/范围/唯一性/协议校验：装载期即明确报错，不等分析时才暴露内部错误。"""
    for field in ("name", "protocol", "model", "api_key_env"):
        value = getattr(profile, field)
        if not isinstance(value, str) or not value.strip():
            raise ModelError("no_profile", f"profile 字段 {field} 必须是非空字符串", False, profile.name)
    if profile.name in seen:
        raise ModelError("no_profile", f"profile 名称重复：{profile.name}", False, profile.name)
    seen.add(profile.name)
    for field in ("base_url", "base_url_env"):
        value = getattr(profile, field)
        if not isinstance(value, str):
            raise ModelError("no_profile", f"profile {profile.name} {field} 必须是字符串", False, profile.name)
        if value and not value.strip():
            raise ModelError("no_profile", f"profile {profile.name} {field} 不能是空白字符串", False, profile.name)
    if profile.protocol not in ADAPTERS:
        raise ModelError(
            "no_profile",
            f"profile {profile.name} 协议非法：{profile.protocol}，可选 {', '.join(ADAPTERS)}",
            False,
            profile.name,
        )
    if isinstance(profile.timeout_s, bool) or not isinstance(profile.timeout_s, (int, float)):
        raise ModelError("no_profile", f"profile {profile.name} timeout_s 必须是数字", False, profile.name)
    if not 0 < profile.timeout_s <= _MAX_TIMEOUT_S:
        raise ModelError("no_profile", f"profile {profile.name} timeout_s 须在 (0, {_MAX_TIMEOUT_S}] 内", False, profile.name)
    if isinstance(profile.retries, bool) or not isinstance(profile.retries, int):
        raise ModelError("no_profile", f"profile {profile.name} retries 必须是整数", False, profile.name)
    if not 0 <= profile.retries <= _MAX_RETRIES:
        raise ModelError("no_profile", f"profile {profile.name} retries 须在 [0, {_MAX_RETRIES}] 内", False, profile.name)
    if isinstance(profile.max_tokens, bool) or not isinstance(profile.max_tokens, int):
        raise ModelError("no_profile", f"profile {profile.name} max_tokens 必须是整数", False, profile.name)
    if not 0 < profile.max_tokens <= _MAX_TOKENS:
        raise ModelError("no_profile", f"profile {profile.name} max_tokens 须在 (0, {_MAX_TOKENS}] 内", False, profile.name)
    if not isinstance(profile.json_mode, bool):
        raise ModelError("no_profile", f"profile {profile.name} json_mode 必须是布尔", False, profile.name)
    if not isinstance(profile.extra_body, dict):
        raise ModelError("no_profile", f"profile {profile.name} extra_body 必须是对象", False, profile.name)


def load_profiles() -> list[ModelProfile]:
    raw = os.environ.get("JXL_MODELS", "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ModelError("no_profile", f"JXL_MODELS 不是合法 JSON（{exc.msg}）", False) from exc
    if not isinstance(data, list):
        raise ModelError("no_profile", "JXL_MODELS 必须是数组", False)

    profiles: list[ModelProfile] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, dict):
            raise ModelError("no_profile", "JXL_MODELS 中存在非对象项", False)
        unknown = set(item) - _FIELDS
        if unknown:
            raise ModelError("no_profile", f"JXL_MODELS 含未知字段：{', '.join(sorted(unknown))}", False)
        try:
            profile = ModelProfile(**item)
        except TypeError as exc:
            raise ModelError("no_profile", "JXL_MODELS 缺少必填字段（name/protocol/model/api_key_env）", False) from exc
        if bool(profile.base_url) == bool(profile.base_url_env):
            raise ModelError(
                "no_profile",
                f"profile {profile.name} 必须且只能提供 base_url 或 base_url_env 之一",
                False,
            )
        _validate_profile(profile, seen)
        profiles.append(profile)

    order = os.environ.get("JXL_MODEL_ORDER", "").strip()
    if order:
        wanted = [x.strip() for x in order.split(",") if x.strip()]
        by_name = {p.name: p for p in profiles}
        missing = [n for n in wanted if n not in by_name]
        if missing:
            raise ModelError("no_profile", f"JXL_MODEL_ORDER 引用了未定义的 profile：{', '.join(missing)}", False)
        profiles = [by_name[n] for n in wanted]
    return profiles


class ModelRouter:
    def __init__(self, adapters: list, attempt_gate: Callable[[], None] | None = None) -> None:
        self._adapters = adapters
        self._attempt_gate = attempt_gate

    @property
    def names(self) -> list[str]:
        return [a.name for a in self._adapters]

    def complete(
        self,
        *,
        system: str,
        user_text: str,
        image_b64: str | None,
        media_type: str,
        validate: Callable[[str, str], Any] | None = None,
        budget_s: float | None = None,
        max_attempts: int | None = None,
    ) -> tuple[Any, str]:
        """按序尝试各 profile。validate 用于把「输出不合契约」也变成可降级的失败。

        budget_s 是整条分析的**统一总预算**：单请求、重试、退避等待、切换 profile 共用同一
        deadline；剩余不足即停止并抛 timeout（映射现有 503 降级），而不是只缩单模型 timeout。

        max_attempts 是本次调用全部实际厂家 HTTP 尝试的合计上限（propose 用，默认 None
        不限制，analyze 行为不变）。计数是每请求局部状态，绝不写回共享 router。
        """
        deadline = None if budget_s is None else time.monotonic() + budget_s
        attempts_left = max_attempts

        def remaining() -> float | None:
            return None if deadline is None else deadline - time.monotonic()

        def exhausted() -> ModelError:
            return ModelError("timeout", "分析总时限耗尽，停止继续尝试", True)

        kinds: list[str] = []
        for adapter in self._adapters:
            attempts = 1 + max(0, adapter.profile.retries)
            for attempt in range(attempts):
                if attempts_left is not None and attempts_left <= 0:
                    break
                rem = remaining()
                if rem is not None and rem <= _MIN_SLICE_S:
                    raise exhausted()
                if self._attempt_gate is not None:
                    # 每次厂家 HTTP 尝试（含重试/切换）都计一次费用额度；耗尽抛
                    # quota_exhausted 直接透传 → 现有 503 model_unavailable 降级
                    self._attempt_gate()
                if attempts_left is not None:
                    attempts_left -= 1
                try:
                    text = adapter.complete(
                        system=system, user_text=user_text, image_b64=image_b64, media_type=media_type,
                        deadline=deadline,
                    )
                    result = text if validate is None else validate(text, adapter.name)
                    return result, adapter.name
                except ModelError as exc:
                    kinds.append(exc.kind)
                    log_event(
                        "model_attempt_failed",
                        profile=exc.profile or adapter.name,
                        kind=exc.kind,
                        retryable=exc.retryable,
                        attempt=attempt + 1,
                    )
                    if not exc.retryable:
                        break
                    if attempt + 1 < attempts:
                        if attempts_left is not None and attempts_left <= 0:
                            break
                        backoff = min(0.5 * (2**attempt), 4.0)
                        rem = remaining()
                        if rem is not None and rem <= backoff + _MIN_SLICE_S:
                            raise exhausted()
                        time.sleep(backoff)
            if attempts_left is not None and attempts_left <= 0:
                break

        # 预算已尽（含读取中途被绝对截止终止）统一报 timeout，不论 profile 数量；映射现有 503 降级
        if deadline is not None and remaining() <= _MIN_SLICE_S:
            raise exhausted()
        if kinds and all(k == "invalid_output" for k in kinds):
            raise ModelError("invalid_output", "所有 profile 的输出都不符合契约", True)
        raise ModelError("unavailable", f"所有 profile 均不可用（{', '.join(sorted(set(kinds))) or '无可用配置'}）", True)


def build_router(transport: httpx.BaseTransport | None = None, *, max_tokens_cap: int | None = None) -> ModelRouter:
    profiles = load_profiles()
    adapters = []
    for profile in profiles:
        api_key = os.environ.get(profile.api_key_env, "").strip()
        if not api_key:
            log_event("model_profile_skipped", profile=profile.name, reason="missing_api_key", key_env=profile.api_key_env)
            continue
        base_url = os.environ.get(profile.base_url_env, "").strip() if profile.base_url_env else profile.base_url
        if not base_url:
            log_event("model_profile_skipped", profile=profile.name, reason="missing_base_url", base_url_env=profile.base_url_env)
            continue
        # propose 专用上限：只缩本次构建的 profile 副本，不改共享配置/analyze 默认值
        if max_tokens_cap is not None:
            profile = replace(profile, max_tokens=min(profile.max_tokens, max_tokens_cap))
        adapters.append(build_adapter(replace(profile, base_url=base_url), api_key, transport))

    if not adapters:
        raise ModelError(
            "no_profile",
            "没有可用的模型 profile：请设置 JXL_MODELS，并为其中至少一项的 api_key_env 提供密钥",
            False,
        )
    log_event("model_router_ready", profiles=[a.name for a in adapters])
    return ModelRouter(adapters, attempt_gate=MODEL_QUOTA.consume)
