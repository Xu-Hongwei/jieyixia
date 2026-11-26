from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.model.adapters import OpenAICompatibleAdapter
from app.model.base import ModelError, ModelProfile
from app.model.core import parse_model_output
from app.model.registry import ModelRouter, build_router, load_profiles
from app.providers import ModelProvider, get_provider
from helpers import PNG_1X1

KEY = "sk-TEST-SECRET"
PROFILES_JSON = json.dumps([
    {"name": "a", "protocol": "openai", "base_url": "https://a.test/v1", "model": "m", "api_key_env": "KEY_A"},
    {"name": "b", "protocol": "openai", "base_url": "https://b.test/v1", "model": "m", "api_key_env": "KEY_B"},
])
GOOD_BODY = {"choices": [{"message": {"content": json.dumps({
    "content_type": "notice",
    "fields": [{"key": "title", "value": "T", "raw": "原文", "status": "candidate"}],
})}}]}


def profile(name: str, **kw) -> ModelProfile:
    base = {"name": name, "protocol": "openai", "base_url": f"https://{name}.test/v1",
            "model": "m", "api_key_env": "KEY_" + name.upper()}
    base.update(kw)
    return ModelProfile(**base)


def adapter(name: str, handler, **kw) -> OpenAICompatibleAdapter:
    return OpenAICompatibleAdapter(profile(name, **kw), KEY, httpx.MockTransport(handler))


def ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=GOOD_BODY)


def fail(status: int):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "nope"}})
    return handler


def test_load_profiles_from_env(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", PROFILES_JSON)
    monkeypatch.delenv("JXL_MODEL_ORDER", raising=False)
    assert [p.name for p in load_profiles()] == ["a", "b"]


def test_load_profiles_respects_explicit_order(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", PROFILES_JSON)
    monkeypatch.setenv("JXL_MODEL_ORDER", "b,a")
    assert [p.name for p in load_profiles()] == ["b", "a"]


def test_load_profiles_rejects_unknown_field(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", json.dumps([{"name": "a", "protocol": "openai", "model": "m",
                                                 "base_url": "https://a.test", "api_key_env": "K",
                                                 "api_key": "sk-should-not-be-here"}]))
    with pytest.raises(ModelError) as info:
        load_profiles()
    assert info.value.kind == "no_profile"


def test_load_profiles_rejects_unknown_order_name(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", PROFILES_JSON)
    monkeypatch.setenv("JXL_MODEL_ORDER", "a,ghost")
    with pytest.raises(ModelError):
        load_profiles()


def test_build_router_resolves_base_url_from_env(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", json.dumps([
        {"name": "qwen", "protocol": "openai", "model": "m",
         "base_url_env": "MY_BASE", "api_key_env": "KEY_A"},
    ]))
    monkeypatch.setenv("MY_BASE", "https://gateway.test/v1")
    monkeypatch.setenv("KEY_A", "sk-a")
    router = build_router()
    assert router.names == ["qwen"]
    assert router._adapters[0].profile.base_url == "https://gateway.test/v1"


def test_build_router_skips_profile_with_missing_base_url_env(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", json.dumps([
        {"name": "qwen", "protocol": "openai", "model": "m",
         "base_url_env": "MY_BASE", "api_key_env": "KEY_A"},
    ]))
    monkeypatch.delenv("MY_BASE", raising=False)
    monkeypatch.setenv("KEY_A", "sk-a")
    with pytest.raises(ModelError) as info:
        build_router()
    assert info.value.kind == "no_profile"


def test_profile_rejects_both_base_url_forms(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", json.dumps([
        {"name": "x", "protocol": "openai", "model": "m", "api_key_env": "K",
         "base_url": "https://a.test", "base_url_env": "B"},
    ]))
    with pytest.raises(ModelError) as info:
        load_profiles()
    assert info.value.kind == "no_profile"


def test_empty_config_yields_no_profiles(monkeypatch):
    monkeypatch.delenv("JXL_MODELS", raising=False)
    assert load_profiles() == []


def test_build_router_skips_profiles_without_key(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", PROFILES_JSON)
    monkeypatch.delenv("JXL_MODEL_ORDER", raising=False)
    monkeypatch.setenv("KEY_A", "")
    monkeypatch.setenv("KEY_B", "sk-b")
    assert build_router().names == ["b"]


def test_build_router_without_any_key_raises(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", PROFILES_JSON)
    monkeypatch.delenv("KEY_A", raising=False)
    monkeypatch.delenv("KEY_B", raising=False)
    with pytest.raises(ModelError) as info:
        build_router()
    assert info.value.kind == "no_profile"


def test_router_falls_back_to_next_profile_on_rate_limit():
    calls: list[str] = []

    def first(request: httpx.Request) -> httpx.Response:
        calls.append("a")
        return httpx.Response(429, json={"error": {"message": "quota"}})

    def second(request: httpx.Request) -> httpx.Response:
        calls.append("b")
        return httpx.Response(200, json=GOOD_BODY)

    router = ModelRouter([adapter("a", first, retries=0), adapter("b", second, retries=0)])
    text, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert name == "b"
    assert calls == ["a", "b"]
    assert json.loads(text)["content_type"] == "notice"


def test_router_does_not_retry_non_retryable_auth():
    calls: list[str] = []

    def first(request: httpx.Request) -> httpx.Response:
        calls.append("a")
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    router = ModelRouter([adapter("a", first, retries=3), adapter("b", ok)])
    _, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert name == "b"
    assert calls == ["a"], "auth 错误不可重试，应立即换下一个 profile"


def test_router_honors_retries_on_server_error():
    calls: list[str] = []

    def flaky(request: httpx.Request) -> httpx.Response:
        calls.append("a")
        if len(calls) < 2:
            return httpx.Response(500, json={"error": {"message": "boom"}})
        return httpx.Response(200, json=GOOD_BODY)

    router = ModelRouter([adapter("a", flaky, retries=1)])
    _, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert name == "a"
    assert len(calls) == 2


def validator(text: str, name: str):
    return parse_model_output(text, source_id="src-x", model_name=name)


def test_router_falls_back_when_model_output_is_invalid():
    garbage = httpx.Response(200, json={"choices": [{"message": {"content": "不是 JSON"}}]})
    router = ModelRouter([adapter("a", lambda r: garbage), adapter("b", ok)])
    result, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", validate=validator)
    assert name == "b", "输出不合契约也应降级到下一个厂家"
    assert result.content_type.value == "notice"


def test_router_all_invalid_output_keeps_invalid_output_kind():
    bad = httpx.Response(200, json={"choices": [{"message": {"content": "不是 JSON"}}]})
    router = ModelRouter([adapter("a", lambda r: bad), adapter("b", lambda r: bad)])
    with pytest.raises(ModelError) as info:
        router.complete(system="s", user_text="u", image_b64=None, media_type="image/png", validate=validator)
    assert info.value.kind == "invalid_output"


def test_router_mixed_failures_report_unavailable():
    router = ModelRouter([adapter("a", fail(401)), adapter("b", fail(500))])
    with pytest.raises(ModelError) as info:
        router.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert info.value.kind == "unavailable"
    assert KEY not in info.value.message


def request_body() -> dict:
    # model 路径会做真实图片校验，必须喂真实 PNG（占位串会在调模型前被 422 拒绝）
    return {"source_id": "src-x", "kind": "image", "image_base64": PNG_1X1,
            "captured_at": "2026-11-17T09:12:00+08:00"}


def client_with(provider) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_provider] = lambda: provider
    return TestClient(app)


def test_analyze_via_model_provider_returns_contract_response():
    provider = ModelProvider(router=ModelRouter([adapter("a", ok)]))
    with client_with(provider) as client:
        response = client.post("/api/analyze", json=request_body())
    assert response.status_code == 200
    body = response.json()
    assert body["model_name"] == "a"
    assert body["fields"][0]["origin"] == "model"
    assert body["fields"][0]["status"] == "candidate"


def test_analyze_maps_model_unavailable_to_503():
    provider = ModelProvider(router=ModelRouter([adapter("a", fail(500))]))
    with client_with(provider) as client:
        response = client.post("/api/analyze", json=request_body())
    assert response.status_code == 503
    assert response.json()["code"] == "model_unavailable"


def test_analyze_maps_invalid_model_output_to_422():
    bad = httpx.Response(200, json={"choices": [{"message": {"content": "不是 JSON"}}]})
    provider = ModelProvider(router=ModelRouter([adapter("a", lambda r: bad)]))
    with client_with(provider) as client:
        response = client.post("/api/analyze", json=request_body())
    assert response.status_code == 422
    assert response.json()["code"] == "model_output_invalid"


def test_healthz_reports_not_ready_without_model_config(monkeypatch):
    monkeypatch.delenv("JXL_MODELS", raising=False)
    with client_with(ModelProvider()) as client:
        assert client.get("/api/healthz").json()["model_ready"] is False


def test_model_error_response_does_not_leak_key_or_image():
    provider = ModelProvider(router=ModelRouter([adapter("a", fail(401))]))
    with client_with(provider) as client:
        response = client.post("/api/analyze", json=request_body())
    assert KEY not in response.text
    assert PNG_1X1 not in response.text


def test_upstream_vendor_detail_not_echoed_in_response():
    # 完整上游异常/厂家详情（可能含用户内容）不得进入错误响应
    detail = "USER-PRIVATE-CONTENT-XYZ upstream traceback detail"
    bad = httpx.Response(500, json={"error": {"message": detail}})
    provider = ModelProvider(router=ModelRouter([adapter("a", lambda r: bad, retries=0)]))
    with client_with(provider) as client:
        response = client.post("/api/analyze", json=request_body())
    assert response.status_code == 503
    assert detail not in response.text
    assert "traceback" not in response.text.lower()
