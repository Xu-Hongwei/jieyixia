"""错误映射收敛到一处：任何异常都变成契约里的 ApiError 形状。

关键隐私点：FastAPI 默认的 422 响应会把请求 input 原样回显，
其中包含 image_base64。这里必须剥掉 input / ctx，只留 loc / msg / type。
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from ._contract import ApiError


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
                "msg": str(err.get("msg", "")),
                "type": str(err.get("type", "")),
            }
        )
    return safe


def _payload(status_code: int, code: str, message: str, retryable: bool, detail: Any) -> JSONResponse:
    body = ApiError(code=code, message=message, retryable=retryable, detail=detail)
    return JSONResponse(status_code=status_code, content=body.model_dump(mode="json"))


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
        return _payload(500, "internal_error", "服务内部错误", True, None)
