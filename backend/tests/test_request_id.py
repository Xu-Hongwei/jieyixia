"""request_id 与请求体中间件回归：每请求唯一 id 贯穿响应头与日志；分片 body 原样回放不额外 join。"""

from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.providers import get_provider

BODY = {"source_id": "src-01", "kind": "image", "image_base64": "stub-marker",
        "captured_at": "2026-11-17T09:12:00+08:00"}


@pytest.fixture()
def app_client(monkeypatch):
    monkeypatch.setenv("JXL_PROVIDER", "fixture")
    get_settings.cache_clear()
    get_provider.cache_clear()
    with TestClient(create_app()) as client:
        yield client
    get_settings.cache_clear()
    get_provider.cache_clear()


def _capture_logs():
    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    logger = logging.getLogger("jxl")
    handler = Capture()
    logger.addHandler(handler)
    return records, lambda: logger.removeHandler(handler)


def test_success_response_carries_unique_request_id(app_client):
    a = app_client.post("/api/analyze", json=BODY)
    b = app_client.post("/api/analyze", json=BODY)
    assert a.status_code == b.status_code == 200
    ida, idb = a.headers["x-request-id"], b.headers["x-request-id"]
    assert len(ida) == 32 and len(idb) == 32
    assert ida != idb


def test_analyze_log_correlates_with_response_header(app_client):
    records, stop = _capture_logs()
    try:
        response = app_client.post("/api/analyze", json=BODY)
    finally:
        stop()
    events = [json.loads(r.getMessage()) for r in records]
    analyze = [e for e in events if e["event"] == "analyze"]
    assert analyze, "应记录 analyze 事件"
    assert analyze[0]["request_id"] == response.headers["x-request-id"]


def test_error_responses_also_carry_request_id(app_client):
    # 422（契约不符）与 503（桩注入降级）都经异常处理器，仍要带 id
    bad = app_client.post("/api/analyze", json={"source_id": "src-01"})
    assert bad.status_code == 422
    assert len(bad.headers["x-request-id"]) == 32
    degraded = app_client.post("/api/analyze?fail=503", json=BODY)
    assert degraded.status_code == 503
    assert len(degraded.headers["x-request-id"]) == 32


def test_body_limit_413_carries_request_id(monkeypatch):
    monkeypatch.setenv("JXL_PROVIDER", "fixture")
    monkeypatch.setenv("JXL_MAX_BODY_BYTES", "16")
    get_settings.cache_clear()
    get_provider.cache_clear()
    with TestClient(create_app()) as client:
        response = client.post("/api/analyze", json=BODY)
    assert response.status_code == 413
    assert len(response.headers["x-request-id"]) == 32
    get_settings.cache_clear()
    get_provider.cache_clear()


def test_guard_rejections_carry_request_id(monkeypatch):
    monkeypatch.setenv("JXL_PROVIDER", "fixture")
    monkeypatch.setenv("JXL_API_TOKEN", "test-token-0123456789")
    monkeypatch.setenv("JXL_RATE_LIMIT_PER_MIN", "1")
    get_settings.cache_clear()
    get_provider.cache_clear()
    with TestClient(create_app()) as client:
        unauthorized = client.post("/api/analyze", json=BODY)
        assert unauthorized.status_code == 401
        assert len(unauthorized.headers["x-request-id"]) == 32
        headers = {"Authorization": "Bearer test-token-0123456789"}
        assert client.post("/api/analyze", json=BODY, headers=headers).status_code == 200
        limited = client.post("/api/analyze", json=BODY, headers=headers)
        assert limited.status_code == 429
        assert len(limited.headers["x-request-id"]) == 32
    get_settings.cache_clear()
    get_provider.cache_clear()


def test_client_supplied_request_id_not_trusted(app_client):
    response = app_client.post("/api/analyze", json=BODY, headers={"X-Request-ID": "forged-id"})
    assert response.headers["x-request-id"] != "forged-id"
    assert len(response.headers["x-request-id"]) == 32


def test_chunked_body_replayed_intact(app_client):
    raw = json.dumps(BODY).encode()
    pieces = [raw[:20], raw[20:60], raw[60:]]

    def stream():
        yield from pieces

    response = app_client.post("/api/analyze", content=stream(),
                               headers={"Content-Type": "application/json"})
    assert response.status_code == 200
    assert response.json()["source_id"] == "src-01"


def test_chunked_oversized_body_rejected_413(monkeypatch):
    monkeypatch.setenv("JXL_PROVIDER", "fixture")
    monkeypatch.setenv("JXL_MAX_BODY_BYTES", "64")
    get_settings.cache_clear()
    get_provider.cache_clear()

    def stream():
        for _ in range(10):
            yield b"x" * 32

    with TestClient(create_app()) as client:
        response = client.post("/api/analyze", content=stream(),
                               headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"
    get_settings.cache_clear()
    get_provider.cache_clear()