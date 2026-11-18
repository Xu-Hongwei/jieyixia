from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from ._contract import SCHEMA_VERSION, ApiError
from .api import analyze_router, health_router
from .config import get_settings
from .errors import install_error_handlers
from .observability import configure_logging, log_event
from .providers import get_provider


class BodyLimitMiddleware:
    """纯 ASGI 中间件：Content-Length 与 chunked 实际字节都拦。

    不能用 @app.middleware("http") 改 request._receive——BaseHTTPMiddleware 的
    call_next 读的是原始 receive，改了不生效。
    """

    def __init__(self, app: ASGIApp, limit: int) -> None:
        self.app = app
        self.limit = limit

    async def _reject(self, send: Send) -> None:
        body = ApiError(
            code="payload_too_large",
            message="请求体超出上限，请压缩图片后重试；原图已在本地保留",
            retryable=True,
        )
        response = JSONResponse(status_code=413, content=body.model_dump(mode="json"))
        await response(scope={"type": "http"}, receive=_empty_receive, send=send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        declared = Headers(scope=scope).get("content-length")
        if declared and declared.isdigit() and int(declared) > self.limit:
            log_event("body_rejected", declared_bytes=int(declared), limit=self.limit)
            await self._reject(send)
            return

        # 自己带上限地读完 body 再回放给下游。不能从 receive 里抛异常：
        # FastAPI 的 body 解析会把它吞成 400，拿不到我们想要的 413。
        chunks: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > self.limit:
                log_event("body_rejected", streamed_bytes=total, limit=self.limit)
                await self._reject(send)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break

        pending = [{"type": "http.request", "body": b"".join(chunks), "more_body": False}]

        async def replay_receive() -> dict:
            if pending:
                return pending.pop(0)
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)


async def _empty_receive() -> dict:
    return {"type": "http.request", "body": b"", "more_body": False}


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        provider = get_provider()
        log_event(
            "startup",
            provider=provider.name,
            source_ids=getattr(provider, "source_ids", []),
            max_body_bytes=settings.max_body_bytes,
            cors_origins=list(settings.cors_origins),
        )
        yield

    app = FastAPI(title="截下来 API · 契约桩", version=SCHEMA_VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_error_handlers(app)
    app.add_middleware(BodyLimitMiddleware, limit=settings.max_body_bytes)

    app.include_router(health_router)
    app.include_router(analyze_router)
    return app


app = create_app()
