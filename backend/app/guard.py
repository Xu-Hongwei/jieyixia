"""公开接口滥用防护：可选鉴权 + 按 IP 限流 + 分析并发闸 + 每日模型调用额度。

全部进程内存实现，不建库不建表（PRD 约束）；多进程/多实例部署时各自计数，
公网大规模部署应换成网关层集中限流（文档注明）。

默认值宽松（60 次/分/IP、并发 4、每日 1000 次厂家调用），前端零改动即可联调；
鉴权默认关闭（JXL_API_TOKEN 留空），公网部署必须显式设置令牌。
healthz 永远开放：前端靠它探测「AI 暂不可用」降级态，且它不触发任何模型调用。
"""

from __future__ import annotations

import hmac
import threading
import time
from collections.abc import Callable
from datetime import datetime

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import get_settings
from .errors import send_error
from .model.base import ModelError
from .observability import log_event
from .time_rules import BEIJING


class TokenBucket:
    """按 key（客户端 IP）的令牌桶：容量=每分钟额度，匀速回填。

    同步端点跑在线程池里，必须加锁。桶表有界：超过 4096 个 key 时清掉
    一分钟内没活动的条目，防止伪造源 IP 撑爆内存。
    """

    def __init__(self, per_min: int) -> None:
        self._per_min = per_min
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        if self._per_min <= 0:
            return True
        now = time.monotonic()
        with self._lock:
            if len(self._buckets) > 4096:
                fresh = {k: v for k, v in self._buckets.items() if now - v[1] < 60.0}
                if len(fresh) > 4096:
                    # 伪造源 IP 洪水：只保留最近活跃的 4096 个，被丢弃的 key 重新计满额度
                    fresh = dict(sorted(fresh.items(), key=lambda kv: kv[1][1], reverse=True)[:4096])
                self._buckets = fresh
            tokens, last = self._buckets.get(key, (float(self._per_min), now))
            tokens = min(float(self._per_min), tokens + (now - last) * self._per_min / 60.0)
            if tokens < 1.0:
                self._buckets[key] = (tokens, now)
                return False
            self._buckets[key] = (tokens - 1.0, now)
            return True


class ConcurrencyGate:
    """分析并发闸：非阻塞获取，满了立即拒绝（503 降级），不排队占资源。"""

    def __init__(self, limit: int) -> None:
        self._sem = threading.Semaphore(limit) if limit > 0 else None

    def try_acquire(self) -> bool:
        return True if self._sem is None else self._sem.acquire(blocking=False)

    def release(self) -> None:
        if self._sem is not None:
            self._sem.release()


class DailyQuota:
    """每日真实厂家调用额度，按北京时间日界重置。

    计数单位是「一次厂家 HTTP 尝试」（含重试与切换 profile），因为每次尝试都可能计费；
    没有厂家价格表，不假装换算成钱。进程内存计数，重启清零（文档注明）。
    """

    def __init__(self, clock: Callable[[], datetime] | None = None) -> None:
        self._clock = clock or (lambda: datetime.now(BEIJING))
        self._lock = threading.Lock()
        self._day = None
        self._used = 0

    def consume(self) -> None:
        limit = get_settings().max_model_calls_per_day
        if limit <= 0:
            return
        today = self._clock().astimezone(BEIJING).date()
        with self._lock:
            if self._day != today:
                self._day, self._used = today, 0
            if self._used >= limit:
                log_event("model_quota_exhausted", day=str(today), limit=limit)
                raise ModelError("quota_exhausted", "今日模型调用额度已用尽，请改用仅保存", False)
            self._used += 1

    def reset(self) -> None:
        with self._lock:
            self._day, self._used = None, 0


MODEL_QUOTA = DailyQuota()


class GuardMiddleware:
    """拦 POST /api/analyze 与 POST /api/assistant/propose（同一 token/限流/并发实例）；
    放在 BodyLimit 外层，鉴权/限流拒绝发生在缓冲请求体之前。

    拒绝沿用契约 ApiError 结构（code 为开放字符串）：
      401 unauthorized     —— 令牌缺失/错误（仅配置了 JXL_API_TOKEN 时）
      429 rate_limited     —— 超过每分钟额度，retryable=true
      503 model_unavailable —— 并发满，走前端现有「仅保存」降级
    """

    _GUARDED_PATHS = frozenset({"/api/analyze", "/api/assistant/propose", "/api/qwen/analyze", "/api/qwen/propose", "/api/qwen/verify"})

    def __init__(self, app: ASGIApp, *, token: str, rate_limiter: TokenBucket, gate: ConcurrencyGate) -> None:
        self.app = app
        self._token = token
        self._rate = rate_limiter
        self._gate = gate

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] not in self._GUARDED_PATHS or scope["method"] != "POST":
            await self.app(scope, receive, send)
            return
        if self._token:
            supplied = Headers(scope=scope).get("authorization", "")
            if not hmac.compare_digest(supplied, "Bearer " + self._token):
                log_event("auth_rejected")
                await send_error(send, 401, "unauthorized", "缺少或错误的访问令牌", False)
                return
        ip = (scope.get("client") or ("unknown", 0))[0]
        if not self._rate.allow(ip):
            log_event("rate_limited", ip=ip)
            await send_error(send, 429, "rate_limited", "请求过于频繁，请稍后再试", True)
            return
        if not self._gate.try_acquire():
            log_event("concurrency_rejected")
            await send_error(send, 503, "model_unavailable", "分析并发已满，请稍后再试或仅保存", True)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            self._gate.release()
