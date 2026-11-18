"""Provider 注入：桩与真实模型共用同一个 router，切换只改环境变量。

JXL_PROVIDER=fixture  → FixtureProvider（读 fixtures，确定性、可复现）
JXL_PROVIDER=model    → ModelProvider（多厂家 profile + 失败降级）
"""

from __future__ import annotations

import base64
import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Protocol

from fastapi import Depends

from ._contract import FIXTURE_DIR, AnalyzeRequest, AnalyzeResponse, Fixture
from .config import get_settings
from .errors import ApiFault
from .model.base import ModelError
from .model.core import SYSTEM_PROMPT, build_user_text, parse_model_output
from .model.registry import ModelRouter, build_router
from .observability import log_event


class AnalyzeProvider(Protocol):
    name: str
    ready: bool

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResponse: ...


class FixtureProvider:
    name = "fixture"
    ready = True

    def __init__(self, fixture_dir: Path = FIXTURE_DIR) -> None:
        self._responses: dict[str, AnalyzeResponse] = {}
        self._kinds: dict[str, str] = {}
        for path in sorted(fixture_dir.glob("*.json")):
            if path.name == "index.json":
                continue
            fixture = Fixture.model_validate(json.loads(path.read_text(encoding="utf-8")))
            if fixture.source and fixture.expected_analysis:
                self._responses[fixture.source.id] = fixture.expected_analysis
                self._kinds[fixture.source.id] = fixture.source.kind.value

    @property
    def source_ids(self) -> list[str]:
        return sorted(self._responses)

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResponse:
        response = self._responses.get(request.source_id)
        if response is None:
            raise ApiFault(
                422,
                "unknown_source",
                f"桩服务没有该 source_id 的 fixture，可用：{', '.join(self.source_ids)}",
            )
        if self._kinds[request.source_id] != request.kind.value:
            raise ApiFault(422, "kind_mismatch", "请求的 kind 与该 fixture 的资料类型不一致")
        return response


def sniff_media_type(image_b64: str) -> str:
    """从字节头判类型，避免为 mime 改契约。兼容前端直接传 data URL。"""
    payload = image_b64.split(",", 1)[1] if image_b64.startswith("data:") else image_b64
    try:
        head = base64.b64decode(payload[:24])
    except (ValueError, TypeError):
        return "image/png"
    if head.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def _to_fault(exc: ModelError) -> ApiFault:
    # 只把 kind 落日志，厂家返回的详情一律不外泄、也不进日志（可能含用户内容）
    log_event("model_error", kind=exc.kind, profile=exc.profile, retryable=exc.retryable)
    if exc.kind == "invalid_output":
        return ApiFault(422, "model_output_invalid", "模型输出不符合契约，原图已在本地保留，可重试或手动整理", True)
    return ApiFault(503, "model_unavailable", "模型暂不可用，请改用仅保存；原图已在本地保留", True)


class ModelProvider:
    name = "model"

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router

    def _ensure_router(self) -> ModelRouter:
        if self._router is None:
            self._router = build_router()
        return self._router

    @property
    def ready(self) -> bool:
        try:
            self._ensure_router()
        except ModelError:
            return False
        return True

    @property
    def source_ids(self) -> list[str]:
        return []

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResponse:
        try:
            router = self._ensure_router()
        except ModelError as exc:
            raise _to_fault(exc) from exc

        image_b64 = request.image_base64
        media_type = sniff_media_type(image_b64) if image_b64 else "image/png"
        if image_b64 and image_b64.startswith("data:"):
            image_b64 = image_b64.split(",", 1)[1]

        def validate(text: str, profile_name: str) -> AnalyzeResponse:
            return parse_model_output(
                text,
                source_id=request.source_id,
                captured_at=request.captured_at,
                model_name=profile_name,
            )

        try:
            response, profile_name = router.complete(
                system=SYSTEM_PROMPT,
                user_text=build_user_text(request),
                image_b64=image_b64,
                media_type=media_type,
                validate=validate,
            )
        except ModelError as exc:
            raise _to_fault(exc) from exc

        log_event(
            "model_analyze",
            source_id=request.source_id,
            profile=profile_name,
            content_type=response.content_type.value,
            field_count=len(response.fields),
        )
        return response


@lru_cache(maxsize=1)
def get_provider() -> AnalyzeProvider:
    settings = get_settings()
    if settings.provider == "fixture":
        return FixtureProvider()
    if settings.provider == "model":
        return ModelProvider()
    raise ApiFault(503, "provider_unavailable", f"JXL_PROVIDER={settings.provider} 只能是 fixture 或 model")


ProviderDep = Annotated[AnalyzeProvider, Depends(get_provider)]
