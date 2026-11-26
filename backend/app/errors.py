"""错误映射收敛到一处：任何异常都变成契约里的 ApiError 形状。

关键隐私点：FastAPI 默认的 422 响应会把请求 input 原样回显，
其中包含 image_base64。这里必须剥掉 input / ctx，只留 loc / msg / type。
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from ._contract import ApiError
from .observability import log_event

# 防御性兜底：即使 pydantic msg 里混入长 base64（图片）也剥掉，且限制长度
_B64_RUN = re.compile(r"[A-Za-z0-9+/]{120,}={0,2}")


def _scrub(msg: str) -> str:
    return _B64_RUN.sub("[redacted]", msg)[:200]


class ApiFault(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        retryable: bool = False,
        detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable
        self.detail = detail


def _safe_errors(errors: Any) -> list[dict[str, Any]]:
    safe = []
    for err in errors:
        safe.append(
            {
                "loc": [str(x) for x in err.get("loc", [])],
                "msg": _scrub(str(err.get("msg", ""))),
                "type": str(err.get("type", "")),
            }
        )
    return safe


def _payload(status_code: int, code: str, message: str, retryable: bool, detail: Any) -> JSONResponse:
    body = ApiError(code=code, message=message, retryable=retryable, detail=detail)
    return JSONResponse(status_code=status_code, content=body.model_dump(mode="json"))


async def _empty_receive() -> dict:
    return {"type": "http.request", "body": b"", "more_body": False}


async def send_error(send: Any, status_code: int, code: str, message: str, retryable: bool) -> None:
    """纯 ASGI 中间件直写契约错误响应（不经路由）；CORS 在其外层才能带上跨域头。"""
    response = _payload(status_code, code, message, retryable, None)
    await response(scope={"type": "http"}, receive=_empty_receive, send=send)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiFault)
    async def _fault(request: Request, exc: ApiFault) -> JSONResponse:
        return _payload(exc.status_code, exc.code, exc.message, exc.retryable, exc.detail)

    @app.exception_handler(RequestValidationError)
    async def _request_invalid(request: Request, exc: RequestValidationError) -> JSONResponse:
        return _payload(422, "invalid_request", "请求不符合契约", False, _safe_errors(exc.errors()))

    @app.exception_handler(ValidationError)
    async def _model_invalid(request: Request, exc: ValidationError) -> JSONResponse:
        return _payload(
            422,
            "model_output_invalid",
            "模型输出不符合契约，原图已在本地保留，可重试或手动整理",
            True,
            _safe_errors(exc.errors()),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        # 只记异常类型，不记 message/traceback（可能含用户内容或上游详情）
        log_event("unhandled_error", kind=type(exc).__name__)
        return _payload(500, "internal_error", "服务内部错误", True, None)
