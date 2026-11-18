from __future__ import annotations

import time
from typing import Annotated, Literal

from fastapi import APIRouter, Query

from ._contract import AnalyzeRequest, AnalyzeResponse, HealthResponse
from .errors import ApiFault
from .observability import log_event
from .providers import ProviderDep

health_router = APIRouter(prefix="/api", tags=["health"])
analyze_router = APIRouter(prefix="/api", tags=["analyze"])


@health_router.get("/healthz")
def healthz(provider: ProviderDep) -> HealthResponse:
    return HealthResponse(model_ready=provider.ready)


def _stub_failure(code: str) -> ApiFault:
    if code == "413":
        return ApiFault(413, "payload_too_large", "图片超出体积上限，请压缩后重试；原图已在本地保留", True)
    if code == "422":
        return ApiFault(422, "model_output_invalid", "模型输出不符合契约（桩注入），原图已在本地保留", True)
    return ApiFault(503, "model_unavailable", "模型不可用（桩注入），请改用仅保存", True)


@analyze_router.post("/analyze")
def analyze(
    payload: AnalyzeRequest,
    provider: ProviderDep,
    fail: Annotated[
        Literal["413", "422", "503"] | None,
        Query(description="仅桩服务：强制触发对应错误，供前端验证三条降级路径"),
    ] = None,
) -> AnalyzeResponse:
    if fail is not None:
        log_event("analyze_injected_failure", source_id=payload.source_id, status=int(fail))
        raise _stub_failure(fail)

    started = time.perf_counter()
    response = provider.analyze(payload)
    log_event(
        "analyze",
        source_id=payload.source_id,
        provider=provider.name,
        content_type=response.content_type.value,
        field_count=len(response.fields),
        warning_codes=[w.code for w in response.warnings],
        duration_ms=round((time.perf_counter() - started) * 1000, 2),
    )
    return response
