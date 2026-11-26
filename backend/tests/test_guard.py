"""滥用防护回归：可选鉴权、按 IP 限流、分析并发闸、每日厂家调用额度。

全部用本地桩/假模型（httpx.MockTransport），不联网、零真实费用。
默认值必须宽松到前端零改动可联调；拒绝沿用契约 ApiError 结构。
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app._contract import FIXTURE_DIR, AnalyzeResponse
from app.config import get_settings
from app.guard import BEIJING, ConcurrencyGate, DailyQuota, TokenBucket
from app.main import create_app
from app.model.adapters import OpenAICompatibleAdapter
from app.model.base import ModelError, ModelProfile
from app.model.registry import ModelRouter
from app.providers import ModelProvider, get_provider
from helpers import PNG_1X1

BODY = {"source_id": "src-01", "kind": "image", "image_base64": "stub-marker",
        "captured_at": "2026-11-17T09:12:00+08:00"}
GOOD_BODY = {"choices": [{"message": {"content": json.dumps({
    "content_type": "notice",
    "fields": [{"key": "title", "value": "T", "raw": "原文", "status": "candidate"}],
})}}]}


@contextmanager
def guard_app(monkeypatch, client_ip=None, **env):
    monkeypatch.setenv("JXL_PROVIDER", "fixture")
    for key, value in env.items():
        monkeypatch.setenv(key, str(value))
    get_settings.cache_clear()
    get_provider.cache_clear()
    app = create_app()
    kwargs = {"client": (client_ip, 50000)} if client_ip else {}
    with TestClient(app, **kwargs) as test_client:
        yield app, test_client
    get_settings.cache_clear()
    get_provider.cache_clear()


# ---------------------------------------------------------------- 鉴权（默认关闭）


def test_auth_disabled_by_default_allows_analyze(monkeypatch):
    monkeypatch.delenv("JXL_API_TOKEN", raising=False)
    with guard_app(monkeypatch) as (_app, client):
        assert client.post("/api/analyze", json=BODY).status_code == 200


def test_auth_enabled_rejects_missing_and_wrong_token(monkeypatch):
    with guard_app(monkeypatch, JXL_API_TOKEN="test-token-0123456789") as (_app, client):
        missing = client.post("/api/analyze", json=BODY)
        assert missing.status_code == 401
        assert missing.json()["code"] == "unauthorized"
        assert missing.json()["retryable"] is False
        wrong = client.post("/api/analyze", json=BODY, headers={"Authorization": "Bearer nope"})
        assert wrong.status_code == 401
        ok = client.post("/api/analyze", json=BODY, headers={"Authorization": "Bearer test-token-0123456789"})
        assert ok.status_code == 200


def test_healthz_open_even_with_auth(monkeypatch):
    with guard_app(monkeypatch, JXL_API_TOKEN="test-token-0123456789") as (_app, client):
        response = client.get("/api/healthz")
        assert response.status_code == 200
        assert response.json()["model_ready"] is True


def test_auth_rejection_readable_cross_origin(monkeypatch):
    with guard_app(monkeypatch, JXL_API_TOKEN="test-token-0123456789") as (_app, client):
        response = client.post("/api/analyze", json=BODY, headers={"Origin": "http://localhost:5173"})
        assert response.status_code == 401
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_token_never_logged(monkeypatch):
    import logging

    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    logger = logging.getLogger("jxl")
    handler = Capture()
    logger.addHandler(handler)
    try:
        with guard_app(monkeypatch, JXL_API_TOKEN="test-token-0123456789") as (_app, client):
            client.post("/api/analyze", json=BODY, headers={"Authorization": "Bearer wrong"})
            client.post("/api/analyze", json=BODY, headers={"Authorization": "Bearer test-token-0123456789"})
    finally:
        logger.removeHandler(handler)
    joined = "\n".join(r.getMessage() for r in records)
    assert "test-token-0123456789" not in joined
    assert "Bearer" not in joined


# ---------------------------------------------------------------- 限流


def test_rate_limit_burst_then_429(monkeypatch):
    with guard_app(monkeypatch, JXL_RATE_LIMIT_PER_MIN=3) as (_app, client):
        for _ in range(3):
            assert client.post("/api/analyze", json=BODY).status_code == 200
        blocked = client.post("/api/analyze", json=BODY)
        assert blocked.status_code == 429
        assert blocked.json()["code"] == "rate_limited"
        assert blocked.json()["retryable"] is True


def test_rate_limit_isolated_per_ip(monkeypatch):
    monkeypatch.setenv("JXL_PROVIDER", "fixture")
    monkeypatch.setenv("JXL_RATE_LIMIT_PER_MIN", "1")
    get_settings.cache_clear()
    get_provider.cache_clear()
    app = create_app()
    with TestClient(app, client=("10.0.0.1", 50000)) as a, TestClient(app, client=("10.0.0.2", 50000)) as b:
        assert a.post("/api/analyze", json=BODY).status_code == 200
        assert a.post("/api/analyze", json=BODY).status_code == 429
        assert b.post("/api/analyze", json=BODY).status_code == 200
    get_settings.cache_clear()
    get_provider.cache_clear()


def test_rate_limit_zero_disables(monkeypatch):
    with guard_app(monkeypatch, JXL_RATE_LIMIT_PER_MIN=0) as (_app, client):
        for _ in range(10):
            assert client.post("/api/analyze", json=BODY).status_code == 200


def test_rate_limit_rejection_readable_cross_origin(monkeypatch):
    with guard_app(monkeypatch, JXL_RATE_LIMIT_PER_MIN=1) as (_app, client):
        client.post("/api/analyze", json=BODY)
        blocked = client.post("/api/analyze", json=BODY, headers={"Origin": "http://localhost:5173"})
        assert blocked.status_code == 429
        assert blocked.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_guard_rejects_before_body_buffered(monkeypatch):
    # Guard 在 BodyLimit 外层：第二个请求即使体积超限，也先被限流拒（429 而非 413），
    # 证明滥用请求不会先占用内存缓冲完整 body。
    with guard_app(monkeypatch, JXL_RATE_LIMIT_PER_MIN=1, JXL_MAX_BODY_BYTES=200) as (_app, client):
        assert client.post("/api/analyze", json=BODY).status_code == 200
        oversized = client.post("/api/analyze", content=b"x" * 4096,
                                headers={"Content-Type": "application/json"})
        assert oversized.status_code == 429


def test_token_bucket_refills_over_time(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr("app.guard.time.monotonic", lambda: clock[0])
    bucket = TokenBucket(60)
    for _ in range(60):
        assert bucket.allow("ip")
    assert not bucket.allow("ip")
    clock[0] += 1.0  # 60/min → 每秒回填 1 个
    assert bucket.allow("ip")
    assert not bucket.allow("ip")


def test_token_bucket_table_bounded(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr("app.guard.time.monotonic", lambda: clock[0])
    bucket = TokenBucket(60)
    for i in range(5000):
        bucket.allow(f"ip-{i}")
    assert len(bucket._buckets) <= 4097  # 清理发生在插入前，稳态上界 4096+1


# ---------------------------------------------------------------- 并发闸


def test_concurrency_gate_nonblocking():
    gate = ConcurrencyGate(1)
    assert gate.try_acquire()
    assert not gate.try_acquire()
    gate.release()
    assert gate.try_acquire()


def test_concurrency_gate_zero_disables():
    gate = ConcurrencyGate(0)
    for _ in range(100):
        assert gate.try_acquire()


def test_concurrency_full_returns_503_degradation(monkeypatch):
    response = AnalyzeResponse.model_validate(
        json.loads((FIXTURE_DIR / "01-course-assignment.json").read_text(encoding="utf-8"))["expected_analysis"]
    )

    class BlockingProvider:
        name = "fixture"
        ready = True
        source_ids: list = []

        def __init__(self):
            self.started = threading.Event()
            self.finish = threading.Event()

        def analyze(self, request):
            self.started.set()
            assert self.finish.wait(5), "测试阻塞超时"
            return response

    provider = BlockingProvider()
    with guard_app(monkeypatch, JXL_MAX_CONCURRENT_ANALYZE=1) as (app, client):
        app.dependency_overrides[get_provider] = lambda: provider
        result: dict = {}

        def first():
            result["first"] = client.post("/api/analyze", json=BODY)

        thread = threading.Thread(target=first)
        thread.start()
        assert provider.started.wait(5)
        second = client.post("/api/analyze", json=BODY)
        assert second.status_code == 503
        assert second.json()["code"] == "model_unavailable"
        provider.finish.set()
        thread.join(timeout=5)
        assert result["first"].status_code == 200
        # 闸已释放：后续请求恢复
        assert client.post("/api/analyze", json=BODY).status_code == 200


# ---------------------------------------------------------------- 每日费用额度


def test_daily_quota_counts_and_exhausts(monkeypatch):
    monkeypatch.setenv("JXL_MAX_MODEL_CALLS_PER_DAY", "2")
    get_settings.cache_clear()
    quota = DailyQuota(clock=lambda: datetime(2026, 11, 18, 12, 0, tzinfo=BEIJING))
    quota.consume()
    quota.consume()
    with pytest.raises(ModelError) as info:
        quota.consume()
    assert info.value.kind == "quota_exhausted"
    assert info.value.retryable is False
    get_settings.cache_clear()


def test_daily_quota_resets_at_beijing_midnight(monkeypatch):
    monkeypatch.setenv("JXL_MAX_MODEL_CALLS_PER_DAY", "1")
    get_settings.cache_clear()
    now = [datetime(2026, 11, 18, 15, 0, tzinfo=BEIJING)]
    quota = DailyQuota(clock=lambda: now[0])
    quota.consume()
    with pytest.raises(ModelError):
        quota.consume()
    # 2026-11-18T16:30Z == 北京 11-19 00:30：UTC 日界还没翻篇，北京日界必须翻篇
    now[0] = datetime(2026, 11, 18, 16, 30, tzinfo=timezone.utc)
    quota.consume()
    with pytest.raises(ModelError):
        quota.consume()
    get_settings.cache_clear()


def test_daily_quota_zero_disables(monkeypatch):
    monkeypatch.setenv("JXL_MAX_MODEL_CALLS_PER_DAY", "0")
    get_settings.cache_clear()
    quota = DailyQuota()
    for _ in range(100):
        quota.consume()
    get_settings.cache_clear()


def _model_app(monkeypatch, quota, handler):
    monkeypatch.setenv("JXL_PROVIDER", "model")
    get_settings.cache_clear()
    get_provider.cache_clear()
    profile = ModelProfile(name="a", protocol="openai", base_url="https://a.test/v1",
                           model="m", api_key_env="K_A", retries=0)
    adapter = OpenAICompatibleAdapter(profile, "k", httpx.MockTransport(handler))
    provider = ModelProvider(router=ModelRouter([adapter], attempt_gate=quota.consume))
    app = create_app()
    app.dependency_overrides[get_provider] = lambda: provider
    return app


def test_quota_exhaustion_maps_to_existing_503(monkeypatch):
    monkeypatch.setenv("JXL_MAX_MODEL_CALLS_PER_DAY", "1")
    get_settings.cache_clear()
    quota = DailyQuota(clock=lambda: datetime(2026, 11, 18, 12, 0, tzinfo=BEIJING))
    calls: list = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json=GOOD_BODY)

    app = _model_app(monkeypatch, quota, handler)
    body = dict(BODY, image_base64=PNG_1X1)
    with TestClient(app) as client:
        assert client.post("/api/analyze", json=body).status_code == 200
        blocked = client.post("/api/analyze", json=body)
    assert blocked.status_code == 503
    assert blocked.json()["code"] == "model_unavailable"
    assert len(calls) == 1, "额度耗尽后不得再发起厂家调用"
    get_settings.cache_clear()
    get_provider.cache_clear()


def test_quota_counts_retries_as_separate_paid_attempts(monkeypatch):
    monkeypatch.setenv("JXL_MAX_MODEL_CALLS_PER_DAY", "2")
    get_settings.cache_clear()
    quota = DailyQuota(clock=lambda: datetime(2026, 11, 18, 12, 0, tzinfo=BEIJING))
    calls: list = []

    def handler(request):
        calls.append(1)
        return httpx.Response(500, json={"error": {"message": "boom"}})

    monkeypatch.setenv("JXL_PROVIDER", "model")
    get_settings.cache_clear()
    get_provider.cache_clear()
    profile = ModelProfile(name="a", protocol="openai", base_url="https://a.test/v1",
                           model="m", api_key_env="K_A", retries=3)
    adapter = OpenAICompatibleAdapter(profile, "k", httpx.MockTransport(handler))
    provider = ModelProvider(router=ModelRouter([adapter], attempt_gate=quota.consume))
    app = create_app()
    app.dependency_overrides[get_provider] = lambda: provider
    with TestClient(app) as client:
        response = client.post("/api/analyze", json=dict(BODY, image_base64=PNG_1X1))
    assert response.status_code == 503
    assert len(calls) == 2, "额度 2 只允许 2 次真实尝试，重试也计费"
    get_settings.cache_clear()
    get_provider.cache_clear()


def test_fixture_mode_never_consumes_model_quota(monkeypatch):
    with guard_app(monkeypatch, JXL_MAX_MODEL_CALLS_PER_DAY=1) as (_app, client):
        assert client.post("/api/analyze", json=BODY).status_code == 200
        assert client.post("/api/analyze", json=BODY).status_code == 200