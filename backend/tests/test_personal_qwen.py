from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest

from app import qwen
from app.errors import ApiFault


def test_verify_requires_valid_key_and_uses_fixed_catalog(client):
    key = "sk-unit-test-one"
    with patch("app.qwen.httpx.Client") as factory:
        assert client.post("/api/qwen/verify").status_code == 401
        factory.assert_not_called()
        get = factory.return_value.__enter__.return_value.get
        get.return_value = httpx.Response(200, json={"success": True}, request=httpx.Request("GET", qwen.HOST))
        result = client.post("/api/qwen/verify", headers={qwen.KEY_HEADER: key})
        assert result.json() == {"connected": True}
        assert get.call_args.args == (qwen.HOST + "/api/v1/models",)
        assert get.call_args.kwargs["params"]["model"] == qwen.MODEL
        assert get.call_args.kwargs["headers"] == {"Authorization": "Bearer " + key}
        get.return_value = httpx.Response(403, text=key)
        denied = client.post("/api/qwen/verify", headers={qwen.KEY_HEADER: key})
        assert denied.status_code == 403 and key not in denied.text


@pytest.mark.parametrize("image", [None, "image"])
def test_personal_analysis_keeps_keys_separate(image):
    payload = SimpleNamespace(image_base64=image)
    with patch("app.qwen.analyze", side_effect=lambda _, provider, fail: provider):
        providers = [qwen.personal_analyze(payload, SimpleNamespace(headers={qwen.KEY_HEADER: key}))
                     for key in ("sk-unit-test-one", "sk-unit-test-two")]
        adapters = [provider._router._adapters for provider in providers]
        assert all(len(group) == 1 and group[0].profile.model == "qwen3.8-flash" for group in adapters)
        assert all(group[0].profile.extra_body == {"enable_thinking": False} for group in adapters)
        assert [group[0]._key for group in adapters] == ["sk-unit-test-one", "sk-unit-test-two"]
        with pytest.raises(ApiFault):
            qwen.personal_analyze(payload, SimpleNamespace(headers={}))


def test_missing_key_on_propose_rejected_before_model(client):
    assert client.post("/api/qwen/propose", json={}).json()["code"] == "qwen_key_invalid"
