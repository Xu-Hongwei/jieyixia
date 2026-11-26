from __future__ import annotations

from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Receive, Scope, Send

from ._contract import SCHEMA_VERSION
from .api import analyze_router, health_router, propose_router
from .config import get_settings
from .errors import install_error_handlers, send_error
from .guard import ConcurrencyGate, GuardMiddleware, TokenBucket
from .model.base import ModelError
from .model.registry import build_router
from .observability import configure_logging, log_event, request_id_var
from .providers import get_provider


class BodyLimitMiddleware:
    """纯 ASGI 中间件：Content-Length 与 chunked 实际字节都拦。

    不能用 @app.middleware("http") 改 request._receive——BaseHTTPMiddleware 的
    call_next 读的是原始 receive，改了不生效。

    overrides 按路径覆盖上限与提示（propose 512KiB）；覆盖值不得放宽全局上限，
    由 create_app 取 min 保证。
    """

    _DEFAULT_MESSAGE = "请求体超出上限，请压缩图片后重试；原图已在本地保留"

    def __init__(self, app: ASGIApp, limit: int, overrides: dict[str, tuple[int, str]] | None = None) -> None:
        self.app = app
        self.limit = limit
        self._overrides = overrides or {}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit, message = self._overrides.get(scope["path"], (self.limit, self._DEFAULT_MESSAGE))
        declared = Headers(scope=scope).get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            log_event("body_rejected", declared_bytes=int(declared), limit=limit)
            await send_error(send, 413, "payload_too_large", message, True)
            return

        # 自己带上限地读完 body 再回放给下游。不能从 receive 里抛异常：
        # FastAPI 的 body 解析会把它吞成 400，拿不到我们想要的 413。
        # 逐条保留原始分片消息回放，不在中间件里 join 出第二份完整 body
        # （下游解析时自会拼接一份，峰值只有一份完整 body + 分片）。
        messages: list[dict] = []
        total = 0
        while True:
            message_in = await receive()
            if message_in["type"] == "http.disconnect":
                return
            total += len(message_in.get("body", b""))
            if total > limit:
                log_event("body_rejected", streamed_bytes=total, limit=limit)
                await send_error(send, 413, "payload_too_large", message, True)
                return
            messages.append(message_in)
            if not message_in.get("more_body", False):
                break

        pending = list(messages)

        async def replay_receive() -> dict:
            if pending:
                return pending.pop(0)
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)


class RequestIdMiddleware:
    """每请求生成 uuid4：注入 contextvar 供所有 log_event 携带，并回写 X-Request-ID 响应头。

    不信任客户端自带的 X-Request-ID（可伪造/碰撞），一律服务端生成。
    放在 Guard/BodyLimit 外层，401/429/413 等中间件直写响应也带 id。
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid4().hex
        token = request_id_var.set(request_id)

        async def send_with_id(message: dict) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            request_id_var.reset(token)


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        provider = get_provider()
        if settings.provider == "model":
            # 配置问题在启动期就明确报告（不含密钥），不等用户发起分析才暴露内部错误
            try:
                build_router()
            except ModelError as exc:
                log_event("model_config_error", kind=exc.kind, message=exc.message)
        log_event(
            "startup",
            provider=provider.name,
            source_ids=getattr(provider, "source_ids", []),
            max_body_bytes=settings.max_body_bytes,
            cors_origins=list(settings.cors_origins),
            auth_enabled=bool(settings.api_token),
            rate_limit_per_min=settings.rate_limit_per_min,
            max_concurrent_analyze=settings.max_concurrent_analyze,
            max_model_calls_per_day=settings.max_model_calls_per_day,
            propose_budget_s=settings.propose_budget_s,
            propose_max_attempts=settings.propose_max_attempts,
            propose_max_body_bytes=propose_body_limit,
        )
        yield

    app = FastAPI(title="截下来 API · 契约桩", version=SCHEMA_VERSION, lifespan=lifespan)
    install_error_handlers(app)
    propose_body_limit = min(settings.propose_max_body_bytes, settings.max_body_bytes)
    app.add_middleware(
        BodyLimitMiddleware,
        limit=settings.max_body_bytes,
        overrides={
            "/api/assistant/propose": (propose_body_limit, "请求体超出 512KiB，请缩小选定资料范围；原文已在本地保留"),
        },
    )
    app.add_middleware(
        GuardMiddleware,
        token=settings.api_token,
        rate_limiter=TokenBucket(settings.rate_limit_per_min),
        gate=ConcurrencyGate(settings.max_concurrent_analyze),
    )
    app.add_middleware(RequestIdMiddleware)
    # CORS 必须最外层（最后 add）：中间件直写的 401/429/413 只有经过 CORS 的 send 包装才带跨域头
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(analyze_router)
    app.include_router(propose_router)
    return app


app = create_app()
