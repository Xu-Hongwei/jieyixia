from __future__ import annotations

import httpx
import pytest

from app.model.adapters import AnthropicAdapter, GeminiAdapter, OpenAICompatibleAdapter, build_adapter
from app.model.base import ModelError, ModelProfile

KEY = "sk-TEST-SECRET-KEY"
IMAGE = "aGVsbG8="


def make_profile(protocol: str = "openai", **overrides) -> ModelProfile:
    base = {
        "name": "p1",
        "protocol": protocol,
        "model": "test-model",
        "base_url": "https://example.test/v1" if protocol == "openai" else "https://example.test",
        "api_key_env": "TEST_KEY",
    }
    base.update(overrides)
    return ModelProfile(**base)


def canned(payload: dict, status: int = 200):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler), seen


def call(adapter, image=IMAGE):
    return adapter.complete(system="SYS", user_text="USER", image_b64=image, media_type="image/png")


def test_openai_request_shape_and_text_extraction():
    transport, seen = canned({"choices": [{"message": {"content": '{"content_type":"reference"}'}}]})
    adapter = OpenAICompatibleAdapter(make_profile(), KEY, transport)
    assert call(adapter) == '{"content_type":"reference"}'
    request = seen["request"]
    assert str(request.url) == "https://example.test/v1/chat/completions"
    assert request.headers["Authorization"] == f"Bearer {KEY}"
    body = request.read()
    assert b'"response_format"' in body
    import json

    payload = json.loads(body)
    assert payload["messages"][0] == {"role": "system", "content": "SYS"}
    assert payload["messages"][1]["content"][1]["image_url"]["url"] == f"data:image/png;base64,{IMAGE}"


def test_openai_text_only_sends_plain_string_content():
    transport, seen = canned({"choices": [{"message": {"content": "{}"}}]})
    call(OpenAICompatibleAdapter(make_profile(), KEY, transport), image=None)
    import json

    payload = json.loads(seen["request"].read())
    assert payload["messages"][1]["content"] == "USER"


def test_openai_json_mode_can_be_disabled():
    transport, seen = canned({"choices": [{"message": {"content": "{}"}}]})
    call(OpenAICompatibleAdapter(make_profile(json_mode=False), KEY, transport))
    assert b"response_format" not in seen["request"].read()


def test_extra_body_is_merged_into_request():
    transport, seen = canned({"choices": [{"message": {"content": "{}"}}]})
    call(OpenAICompatibleAdapter(make_profile(extra_body={"enable_thinking": False}), KEY, transport))
    import json

    payload = json.loads(seen["request"].read())
    assert payload["enable_thinking"] is False


def test_anthropic_request_shape_and_text_extraction():
    transport, seen = canned({"content": [{"type": "text", "text": "A"}, {"type": "text", "text": "B"}]})
    assert call(AnthropicAdapter(make_profile("anthropic"), KEY, transport)) == "AB"
    request = seen["request"]
    assert str(request.url) == "https://example.test/v1/messages"
    assert request.headers["x-api-key"] == KEY
    assert request.headers["anthropic-version"] == "2023-06-01"
    import json

    payload = json.loads(request.read())
    assert payload["system"] == "SYS"
    assert payload["messages"][0]["content"][0]["source"]["media_type"] == "image/png"


def test_gemini_keeps_key_out_of_url():
    transport, seen = canned({"candidates": [{"content": {"parts": [{"text": "OK"}]}}]})
    assert call(GeminiAdapter(make_profile("gemini"), KEY, transport)) == "OK"
    request = seen["request"]
    assert KEY not in str(request.url)
    assert request.headers["x-goog-api-key"] == KEY
    assert str(request.url).endswith("/v1beta/models/test-model:generateContent")
    import json

    payload = json.loads(request.read())
    assert payload["contents"][0]["parts"][1]["inline_data"]["mime_type"] == "image/png"
    assert payload["generationConfig"]["responseMimeType"] == "application/json"


@pytest.mark.parametrize(
    "status,kind,retryable",
    [(401, "auth", False), (403, "auth", False), (429, "rate_limit", True), (500, "server", True), (503, "server", True), (400, "transport", False)],
)
def test_http_status_maps_to_model_error(status, kind, retryable):
    transport, _ = canned({"error": {"message": "nope"}}, status=status)
    with pytest.raises(ModelError) as info:
        call(OpenAICompatibleAdapter(make_profile(), KEY, transport))
    assert info.value.kind == kind
    assert info.value.retryable is retryable


def test_vendor_error_message_redacts_api_key():
    transport, _ = canned({"error": {"message": f"invalid key {KEY} supplied"}}, status=401)
    with pytest.raises(ModelError) as info:
        call(OpenAICompatibleAdapter(make_profile(), KEY, transport))
    assert KEY not in info.value.message
    assert "[redacted]" in info.value.message


def test_timeout_is_retryable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("too slow", request=request)

    with pytest.raises(ModelError) as info:
        call(OpenAICompatibleAdapter(make_profile(), KEY, httpx.MockTransport(handler)))
    assert info.value.kind == "timeout"
    assert info.value.retryable is True


def test_non_json_body_is_invalid_output():
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text="<html>not json</html>"))
    with pytest.raises(ModelError) as info:
        call(OpenAICompatibleAdapter(make_profile(), KEY, transport))
    assert info.value.kind == "invalid_output"


@pytest.mark.parametrize(
    "adapter_cls,protocol,payload",
    [
        (OpenAICompatibleAdapter, "openai", {"choices": []}),
        (AnthropicAdapter, "anthropic", {"content": None}),
        (GeminiAdapter, "gemini", {"candidates": []}),
    ],
)
def test_missing_response_structure_is_invalid_output(adapter_cls, protocol, payload):
    transport, _ = canned(payload)
    with pytest.raises(ModelError) as info:
        call(adapter_cls(make_profile(protocol), KEY, transport))
    assert info.value.kind == "invalid_output"


def test_unknown_protocol_is_rejected():
    with pytest.raises(ModelError) as info:
        build_adapter(make_profile("cohere"), KEY)
    assert info.value.kind == "no_profile"


def test_ambient_no_proxy_does_not_break_real_client(monkeypatch):
    """回归：httpx 把 NO_PROXY 里的 [::1] 当 URL 解析会抛 InvalidURL。

    必须走真实 client 构造（transport=None）才能复现，MockTransport 会绕过它。
    指向本机拒绝连接的端口，期望被包装成 transport 类 ModelError 而非裸 InvalidURL。
    """
    monkeypatch.setenv("NO_PROXY", "localhost,.localhost,127.0.0.1,127.0.0.0/8,[::1],::1")
    adapter = OpenAICompatibleAdapter(
        make_profile(base_url="http://127.0.0.1:1/v1", timeout_s=2), KEY, transport=None
    )
    with pytest.raises(ModelError) as info:
        call(adapter)
    assert info.value.kind in ("transport", "timeout"), "必须被包装成 ModelError，而不是裸 InvalidURL"
    assert info.value.retryable is True
