"""输入校验回归：真实日历、base64/图片格式/字节/像素上限、文字与输出上限。

关键证明：非法输入在调用模型之前被拒绝（假厂家 transport 零调用）；
桩模式占位图片不受真实图片校验影响（不靠放宽生产校验兼容测试）。
"""

from __future__ import annotations

import base64
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.errors import ApiFault
from app.main import create_app
from app.model.adapters import OpenAICompatibleAdapter
from app.model.base import ModelProfile
from app.model.core import _normalize_node, parse_model_output
from app.model.registry import ModelRouter
from app.providers import ModelProvider, get_provider
from app.validation import inspect_image, validate_request_meta
from app._contract import AnalyzeRequest
from helpers import PNG_1X1, make_png_b64, make_png_header_b64, png_bytes, png_header_bytes


def _req(**kw) -> AnalyzeRequest:
    base = {"source_id": "src-x", "kind": "image", "image_base64": PNG_1X1,
            "captured_at": "2026-11-17T09:12:00+08:00"}
    base.update(kw)
    return AnalyzeRequest.model_validate(base)


# ---------------------------------------------------------------- 日历
@pytest.mark.parametrize("bad", ["2026-02-30", "2026-13-01", "2026-00-10", "2026-11-31"])
def test_reference_at_invalid_calendar_rejected(bad):
    with pytest.raises(ApiFault) as info:
        validate_request_meta(_req(reference_at=bad), max_text_chars=1000)
    assert info.value.status_code == 422
    assert info.value.code == "invalid_request"


@pytest.mark.parametrize("bad", ["2026-02-30T10:00:00+08:00", "2026-11-17T25:00:00+08:00", "2026-13-01T00:00:00Z"])
def test_captured_at_invalid_calendar_rejected(bad):
    with pytest.raises(ApiFault) as info:
        validate_request_meta(_req(captured_at=bad), max_text_chars=1000)
    assert info.value.status_code == 422


def test_valid_calendar_and_ms_offset_accepted():
    validate_request_meta(_req(reference_at="2026-11-17", captured_at="2026-11-17T15:21:06.663Z"), max_text_chars=1000)


@pytest.mark.parametrize("bad", [
    "2026-11-17T10:00:00+08:75",
    "2026-11-17T10:00:00+08:60",
    "2026-11-17T10:00:00+25:00",
])
def test_captured_at_illegal_offset_rejected(bad):
    with pytest.raises(ApiFault) as info:
        validate_request_meta(_req(captured_at=bad), max_text_chars=1000)
    assert info.value.status_code == 422
    assert info.value.code == "invalid_request"


def test_captured_at_legal_explicit_offsets_accepted():
    for good in ["2026-11-17T10:00:00+08:00", "2026-11-17T10:00:00-05:00", "2026-11-17T10:00:00Z", "2026-11-17T10:00:00"]:
        validate_request_meta(_req(captured_at=good), max_text_chars=1000)


@pytest.mark.parametrize("key", ["reference_at", "message_date"])
def test_node_reference_invalid_calendar_rejected(key):
    node = {"label": "x", "raw": "11月18日", "value": "2026-11-18", "basis": "inferred",
            "role": "event_start", "reference_source": "message_date",
            "reference_at": "2026-11-18", "message_date": "2026-11-18"}
    node[key] = "2026-02-30"
    with pytest.raises(Exception) as info:
        _normalize_node(node, user_reference_at=None)
    assert "日历" in str(info.value)


# ---------------------------------------------------------------- 图片
def test_invalid_base64_rejected():
    with pytest.raises(ApiFault) as info:
        inspect_image("!!!not-base64!!!", max_bytes=10**6, max_pixels=10**8, max_side=10**4)
    assert info.value.status_code == 422


def test_unknown_format_not_treated_as_png():
    hello = base64.b64encode(b"hello world plain text").decode()
    with pytest.raises(ApiFault) as info:
        inspect_image(hello, max_bytes=10**6, max_pixels=10**8, max_side=10**4)
    assert info.value.status_code == 422
    assert "格式" in info.value.detail[0]["msg"]


def test_decoded_bytes_cap():
    with pytest.raises(ApiFault) as info:
        inspect_image(PNG_1X1, max_bytes=10, max_pixels=10**8, max_side=10**4)
    assert info.value.status_code == 413
    assert info.value.code == "payload_too_large"


def test_pixel_cap():
    big = make_png_header_b64(20000, 20000)  # 400MP > 40MP
    with pytest.raises(ApiFault) as info:
        inspect_image(big, max_bytes=10**6, max_pixels=40_000_000, max_side=100_000)
    assert info.value.status_code == 413


def test_side_cap():
    wide = make_png_header_b64(20000, 10)
    with pytest.raises(ApiFault) as info:
        inspect_image(wide, max_bytes=10**6, max_pixels=10**9, max_side=10_000)
    assert info.value.status_code == 413


def test_real_png_and_data_url_accepted():
    assert inspect_image(PNG_1X1, max_bytes=10**6, max_pixels=10**8, max_side=10**4) == "image/png"
    assert inspect_image("data:image/png;base64," + PNG_1X1, max_bytes=10**6, max_pixels=10**8, max_side=10**4) == "image/png"
    assert inspect_image(make_png_b64(8, 8), max_bytes=10**6, max_pixels=10**8, max_side=10**4) == "image/png"


# ---------------------------------------------------------------- 完整解码：损坏/截断/仅文件头
def _real_image_bytes(fmt: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (255, 0, 0)).save(buf, format=fmt)
    return buf.getvalue()


def test_header_only_png_rejected_as_corrupt():
    # 24 字节级「仅签名+IHDR+IEND」无 IDAT：尺寸合法但无法完整解码，必须 422 而非进模型/500
    header_only = base64.b64encode(png_header_bytes(1, 1)).decode()
    with pytest.raises(ApiFault) as info:
        inspect_image(header_only, max_bytes=10**6, max_pixels=10**8, max_side=10**4)
    assert info.value.status_code == 422
    assert "损坏" in info.value.detail[0]["msg"]


def test_truncated_png_rejected():
    truncated = base64.b64encode(png_bytes(8, 8)[:20]).decode()
    with pytest.raises(ApiFault) as info:
        inspect_image(truncated, max_bytes=10**6, max_pixels=10**8, max_side=10**4)
    assert info.value.status_code == 422


@pytest.mark.parametrize("fmt,media", [("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_real_jpeg_webp_accepted_and_truncated_rejected(fmt, media):
    data = _real_image_bytes(fmt)
    assert inspect_image(base64.b64encode(data).decode(), max_bytes=10**6, max_pixels=10**8, max_side=10**4) == media
    with pytest.raises(ApiFault) as info:
        inspect_image(base64.b64encode(data[: len(data) // 2]).decode(), max_bytes=10**6, max_pixels=10**8, max_side=10**4)
    assert info.value.status_code == 422


def test_malformed_data_url_rejected_422_not_indexerror():
    # 缺逗号分隔的 data URL：旧实现 split(",",1)[1] 抛 IndexError→500；现在规范 422
    with pytest.raises(ApiFault) as info:
        inspect_image("data:image/png;base64", max_bytes=10**6, max_pixels=10**8, max_side=10**4)
    assert info.value.status_code == 422
    assert info.value.code == "invalid_request"


def test_pixel_cap_on_real_decodable_image():
    # 上限对「可完整解码」的真实图片同样生效（不只靠仅头 PNG 的声明尺寸）
    real = make_png_b64(200, 200)  # 40000 像素
    with pytest.raises(ApiFault) as info:
        inspect_image(real, max_bytes=10**6, max_pixels=10_000, max_side=10**4)
    assert info.value.status_code == 413


# ---------------------------------------------------------------- 文字 / 输出上限
def test_text_length_cap():
    req = AnalyzeRequest.model_validate({"source_id": "s", "kind": "text", "text": "字" * 11,
                                         "captured_at": "2026-11-17T09:12:00+08:00"})
    with pytest.raises(ApiFault) as info:
        validate_request_meta(req, max_text_chars=10)
    assert info.value.status_code == 422


def test_model_output_size_cap():
    with pytest.raises(Exception) as info:
        parse_model_output("x" * 11, source_id="s", model_name="m", max_output_chars=10)
    assert "上限" in str(info.value)


# ---------------------------------------------------------------- 非法输入不调用模型
def _counting_provider(counter: list):
    def handler(request: httpx.Request) -> httpx.Response:
        counter.append(request.url)
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    profile = ModelProfile(name="a", protocol="openai", base_url="https://a.test/v1", model="m", api_key_env="K")
    adapter = OpenAICompatibleAdapter(profile, "k", httpx.MockTransport(handler))
    return ModelProvider(router=ModelRouter([adapter]))


@pytest.mark.parametrize("overrides", [
    {"reference_at": "2026-02-30"},
    {"captured_at": "2026-02-30T10:00:00+08:00"},
    {"image_base64": base64.b64encode(b"not an image").decode()},
    {"image_base64": "!!!bad-base64!!!"},
    {"image_base64": base64.b64encode(png_header_bytes(1, 1)).decode()},
    {"image_base64": base64.b64encode(png_bytes(8, 8)[:20]).decode()},
    {"image_base64": "data:image/png;base64"},
])
def test_invalid_input_never_calls_model(overrides):
    counter: list = []
    app = create_app()
    app.dependency_overrides[get_provider] = lambda: _counting_provider(counter)
    body = {"source_id": "src-x", "kind": "image", "image_base64": PNG_1X1,
            "captured_at": "2026-11-17T09:12:00+08:00"}
    body.update(overrides)
    with TestClient(app) as client:
        response = client.post("/api/analyze", json=body)
    assert response.status_code == 422
    assert counter == [], "非法输入必须在调模型前被拒绝"


def test_fixture_placeholder_not_subject_to_real_image_validation(client, payload):
    # 桩模式占位 marker 不是真实图片，但桩不做内容校验 → 200；同一 marker 走 model 路径则 422
    response = client.post("/api/analyze", json=payload())
    assert response.status_code == 200
    counter: list = []
    app = create_app()
    app.dependency_overrides[get_provider] = lambda: _counting_provider(counter)
    with TestClient(app) as model_client:
        bad = model_client.post("/api/analyze", json=payload())
    assert bad.status_code == 422
    assert counter == []