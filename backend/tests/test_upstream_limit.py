"""上游响应字节上限回归：超限在流式读取中途截断并释放连接，而不是先完整读进内存。

成功路径与错误路径都受限；真实本地假服务证明分段超大响应被中断且厂家检测到断开。
全部本地假模型，不联网、零真实费用。
"""

from __future__ import annotations

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.model.adapters import OpenAICompatibleAdapter
from app.model.base import ModelError, ModelProfile
from app.model.registry import ModelRouter
from app.providers import ModelProvider, get_provider
from helpers import PNG_1X1
from test_budget import _real_adapter, local_vendor

GOOD = {"choices": [{"message": {"content": json.dumps({
    "content_type": "notice",
    "fields": [{"key": "title", "value": "T", "raw": "原文", "status": "candidate"}],
})}}]}


def _adapter(handler, **kw) -> OpenAICompatibleAdapter:
    profile = ModelProfile(name="a", protocol="openai", base_url="https://a.test/v1",
                           model="m", api_key_env="K_A", **kw)
    return OpenAICompatibleAdapter(profile, "k", httpx.MockTransport(handler))


@pytest.fixture()
def cap_bytes(monkeypatch):
    def set_cap(value: int):
        monkeypatch.setenv("JXL_MAX_UPSTREAM_BYTES", str(value))
        get_settings.cache_clear()
    yield set_cap
    get_settings.cache_clear()


def test_oversized_success_body_rejected_before_json_parse(cap_bytes):
    cap_bytes(1024)
    adapter = _adapter(lambda request: httpx.Response(200, content=b"x" * 5000))
    with pytest.raises(ModelError) as info:
        adapter.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert info.value.kind == "invalid_output"
    assert "字节上限" in info.value.message


def test_under_cap_success_still_works(cap_bytes):
    cap_bytes(1024 * 1024)
    adapter = _adapter(lambda request: httpx.Response(200, json=GOOD))
    text = adapter.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert json.loads(text)["content_type"] == "notice"


def test_oversized_maps_to_existing_422_via_api(cap_bytes, monkeypatch):
    cap_bytes(1024)
    monkeypatch.setenv("JXL_PROVIDER", "model")
    get_settings.cache_clear()
    get_provider.cache_clear()
    adapter = _adapter(lambda request: httpx.Response(200, content=b"x" * 5000))
    provider = ModelProvider(router=ModelRouter([adapter]))
    app = create_app()
    app.dependency_overrides[get_provider] = lambda: provider
    body = {"source_id": "src-x", "kind": "image", "image_base64": PNG_1X1,
            "captured_at": "2026-11-17T09:12:00+08:00"}
    with TestClient(app) as client:
        response = client.post("/api/analyze", json=body)
    assert response.status_code == 422
    assert response.json()["code"] == "model_output_invalid"
    get_settings.cache_clear()
    get_provider.cache_clear()


def test_error_body_capped_and_status_still_classified(cap_bytes):
    cap_bytes(1024)
    adapter = _adapter(lambda request: httpx.Response(500, content=b"e" * 100_000))
    with pytest.raises(ModelError) as info:
        adapter.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert info.value.kind == "server"
    assert info.value.retryable is True
    assert "HTTP 500" in info.value.message
    assert len(info.value.message) < 300, "错误详情只取截断 body 的前 200 字符"


def test_error_detail_still_redacts_key(cap_bytes):
    cap_bytes(1024)
    secret = "sk-TEST-SECRET"
    profile = ModelProfile(name="a", protocol="openai", base_url="https://a.test/v1",
                           model="m", api_key_env="K_A")
    adapter = OpenAICompatibleAdapter(
        profile, secret,
        httpx.MockTransport(lambda request: httpx.Response(
            500, json={"error": {"message": f"boom {secret}"}})),
    )
    with pytest.raises(ModelError) as info:
        adapter.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert secret not in info.value.message
    assert "[redacted]" in info.value.message


# ---------------------------------------------------------------- 真实本地 HTTP 假服务


def test_real_huge_success_aborted_by_byte_cap_and_connection_released(cap_bytes):
    cap_bytes(65536)
    with local_vendor("huge_ok") as (url, server):
        router = ModelRouter([_real_adapter(url, retries=0)])
        start = time.perf_counter()
        with pytest.raises(ModelError) as info:
            router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", budget_s=5)
        elapsed = time.perf_counter() - start
        assert info.value.kind == "invalid_output"
        assert elapsed < 2.0, f"超大响应必须按字节上限中途截断，实际 {elapsed:.2f}s"
        time.sleep(0.3)
        assert server.disconnects, "截断后必须关闭响应释放连接，厂家应检测到断开"


def test_real_huge_error_body_capped_and_connection_released(cap_bytes):
    cap_bytes(65536)
    with local_vendor("huge_error") as (url, server):
        adapter = _real_adapter(url, retries=0)
        with pytest.raises(ModelError) as info:
            adapter.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
        assert info.value.kind == "server"
        time.sleep(0.3)
        assert server.disconnects, "错误体截断后连接也应释放"