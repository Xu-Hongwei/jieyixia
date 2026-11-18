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

from ..observability import log_event
from .adapters import build_adapter
from .base import ModelError, ModelProfile

_FIELDS = {
    "name", "protocol", "model", "base_url", "base_url_env", "api_key_env",
    "timeout_s", "max_tokens", "json_mode", "retries", "extra_body",
}


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
    def __init__(self, adapters: list) -> None:
        self._adapters = adapters

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
    ) -> tuple[Any, str]:
        """按序尝试各 profile。validate 用于把「输出不合契约」也变成可降级的失败。"""
        kinds: list[str] = []
        for adapter in self._adapters:
            attempts = 1 + max(0, adapter.profile.retries)
            for attempt in range(attempts):
                try:
                    text = adapter.complete(
                        system=system, user_text=user_text, image_b64=image_b64, media_type=media_type
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
                        time.sleep(min(0.5 * (2**attempt), 4.0))

        if kinds and all(k == "invalid_output" for k in kinds):
            raise ModelError("invalid_output", "所有 profile 的输出都不符合契约", True)
        raise ModelError("unavailable", f"所有 profile 均不可用（{', '.join(sorted(set(kinds))) or '无可用配置'}）", True)


def build_router(transport: httpx.BaseTransport | None = None) -> ModelRouter:
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
        adapters.append(build_adapter(replace(profile, base_url=base_url), api_key, transport))

    if not adapters:
        raise ModelError(
            "no_profile",
            "没有可用的模型 profile：请设置 JXL_MODELS，并为其中至少一项的 api_key_env 提供密钥",
            False,
        )
    log_event("model_router_ready", profiles=[a.name for a in adapters])
    return ModelRouter(adapters)
