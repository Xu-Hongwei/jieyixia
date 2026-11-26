from __future__ import annotations

import json
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from ._contract import (
    ASSISTANT_PROTOCOL_VERSIONS,
    AnalyzeRequest,
    AnalyzeResponse,
    AssistantProposeRequest,
    AssistantProposeResponse,
    HealthResponse,
    Intent,
)
from .assistant.semantics import check_request_semantics
from .config import get_settings
from .errors import ApiFault, _safe_errors
from .observability import log_event
from .providers import ProposeProviderDep, ProviderDep
from .validation import validate_request_meta

health_router = APIRouter(prefix="/api", tags=["health"])
analyze_router = APIRouter(prefix="/api", tags=["analyze"])
propose_router = APIRouter(prefix="/api/assistant", tags=["assistant"])


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
        # 故障注入只属于桩/测试模式；生产模型模式关闭，避免线上被外部触发降级
        if provider.name != "fixture":
            raise ApiFault(422, "invalid_request", "故障注入仅桩模式可用，生产模型模式已关闭", False)
        log_event("analyze_injected_failure", source_id=payload.source_id, status=int(fail))
        raise _stub_failure(fail)

    # 日历合法性 + 文字上限：在调用模型之前拒绝非法输入（沿用现有 422 结构）
    validate_request_meta(payload, max_text_chars=get_settings().max_text_chars)

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


def _propose_stub_failure(code: str) -> ApiFault:
    table = {
        "400": (400, "PROTOCOL_UNSUPPORTED", "协议版本不支持（桩注入）", False),
        "413": (413, "payload_too_large", "请求体超出 512KiB（桩注入）", True),
        "422": (422, "invalid_request", "请求非法（桩注入）", False),
        "429": (429, "quota_exhausted", "今日额度已用尽（桩注入）", False),
        "502": (502, "model_output_invalid", "模型输出非法（桩注入）", True),
        "503": (503, "model_unavailable", "模型不可用（桩注入）", True),
        "504": (504, "propose_timeout", "生成总时限耗尽（桩注入）", True),
    }
    status, error_code, message, retryable = table[code]
    return ApiFault(status, error_code, message, retryable)


@propose_router.post("/propose")
async def propose(
    request: Request,
    provider: ProposeProviderDep,
    fail: Annotated[
        Literal["400", "413", "422", "429", "502", "503", "504"] | None,
        Query(description="仅桩服务：强制触发对应错误，供前端验证降级路径"),
    ] = None,
) -> AssistantProposeResponse:
    # 先于 pydantic 解析检查协议版本：版本不符是 400，不是 422 结构错误
    raw = await request.body()
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ApiFault(422, "invalid_request", "请求体不是合法 JSON", False) from exc
    if not isinstance(data, dict):
        raise ApiFault(422, "invalid_request", "请求体顶层必须是对象", False)
    if data.get("protocol_version") not in ASSISTANT_PROTOCOL_VERSIONS:
        raise ApiFault(400, "PROTOCOL_UNSUPPORTED", f"协议版本不支持，仅支持 {'/'.join(ASSISTANT_PROTOCOL_VERSIONS)}", False)
    intent = data.get("intent")
    if intent not in {i.value for i in Intent}:
        raise ApiFault(422, "invalid_request", "intent 非法", False)
    if intent not in {Intent.new_plan.value, Intent.replan_task.value}:
        raise ApiFault(422, "unsupported_intent", "本版本支持 new_plan 与 replan_task；修改草稿与解释今天尚未开放", False)
    try:
        payload = AssistantProposeRequest.model_validate(data)
    except ValidationError as exc:
        raise ApiFault(422, "invalid_request", "请求不符合契约", False, _safe_errors(exc.errors())) from exc
    try:
        check_request_semantics(payload)
    except ValueError as exc:
        raise ApiFault(422, "invalid_request", str(exc), False) from exc

    if fail is not None:
        if provider.name != "fixture":
            raise ApiFault(422, "invalid_request", "故障注入仅桩模式可用，生产模型模式已关闭", False)
        log_event("propose_injected_failure", request_id=payload.request_id, status=int(fail))
        raise _propose_stub_failure(fail)

    started = time.perf_counter()
    response = await run_in_threadpool(provider.propose, payload)
    log_event(
        "propose",
        request_id=payload.request_id,
        thread_id=payload.thread_id,
        turn_id=payload.turn_id,
        provider=provider.name,
        payload_kind=response.payload.kind,
        duration_ms=round((time.perf_counter() - started) * 1000, 2),
    )
    return response
