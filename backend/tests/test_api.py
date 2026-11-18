from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app._contract import AnalyzeResponse, ApiError
from app.config import get_settings
from app.main import create_app
from app.providers import get_provider


@pytest.fixture()
def small_limit_app(monkeypatch):
    monkeypatch.setenv("JXL_MAX_BODY_BYTES", "1024")
    get_settings.cache_clear()
    get_provider.cache_clear()
    yield create_app()
    get_settings.cache_clear()
    get_provider.cache_clear()


def test_chunked_oversize_body_returns_413(small_limit_app):
    with TestClient(small_limit_app) as client:
        response = client.post(
            "/api/analyze",
            content=(b"x" * 2048 for _ in range(1)),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


def test_chunked_under_limit_body_still_works(small_limit_app, payload):
    body = json.dumps(payload()).encode()
    with TestClient(small_limit_app) as client:
        response = client.post(
            "/api/analyze",
            content=(body[i : i + 64] for i in range(0, len(body), 64)),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 200


def test_healthz_reports_model_ready(client):
    response = client.get("/api/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["model_ready"] is True
    assert body["schema_version"] == "0.2.0"


@pytest.mark.parametrize("fixture_id", ["01-course-assignment", "02-grading-supplement", "03-deadline-change", "04-reference-paper"])
def test_analyze_response_satisfies_contract(client, payload, fixtures, fixture_id):
    response = client.post("/api/analyze", json=payload(fixture_id))
    assert response.status_code == 200
    parsed = AnalyzeResponse.model_validate(response.json())
    assert parsed.source_id == fixtures[fixture_id]["source"]["id"]
    assert parsed.content_type.value == fixtures[fixture_id]["expected_analysis"]["content_type"]


def test_analyze_never_returns_confirmed_fields(client, payload, analysis_ids):
    for fixture_id in analysis_ids:
        body = client.post("/api/analyze", json=payload(fixture_id)).json()
        for field in body["fields"]:
            assert field["status"] != "confirmed", "规则 3：AI 不得返回已确认字段"
            assert field["origin"] == "model"


def test_analyze_candidate_fields_carry_quote(client, payload, analysis_ids):
    for fixture_id in analysis_ids:
        body = client.post("/api/analyze", json=payload(fixture_id)).json()
        for field in body["fields"]:
            if field["status"] in ("candidate", "unresolved") and field["raw"]:
                assert field["quote"], "规则 4：有原文就必须有引用"
                assert field["quote"]["source_id"] == body["source_id"]


def test_relative_date_stays_unresolved_and_derived(client, payload):
    body = client.post("/api/analyze", json=payload("02-grading-supplement")).json()
    field = next(f for f in body["fields"] if f["key"] == "deadline")
    assert field["status"] == "unresolved"
    assert field["derived"] is True
    assert field["raw"] == "下周三课堂展示"
    assert field["value"] == "2026-11-25"


def test_missing_field_keeps_null_value(client, payload):
    body = client.post("/api/analyze", json=payload("04-reference-paper")).json()
    field = next(f for f in body["fields"] if f["key"] == "deadline")
    assert field["status"] == "missing"
    assert field["value"] is None


def test_fixture_deliberate_ai_error_is_preserved(client, payload):
    body = client.post("/api/analyze", json=payload("01-course-assignment")).json()
    field = next(f for f in body["fields"] if f["key"] == "constraints")
    assert "300 字" in field["value"], "这是刻意安排的识别错误，供前端演示用户修正"
    assert "3000" in field["raw"]


def test_analyze_is_deterministic_and_stateless(client, payload):
    first = client.post("/api/analyze", json=payload()).json()
    second = client.post("/api/analyze", json=payload()).json()
    assert first == second


def test_unknown_source_returns_422(client, payload):
    response = client.post("/api/analyze", json=payload(source_id="src-does-not-exist"))
    assert response.status_code == 422
    assert response.json()["code"] == "unknown_source"


def test_kind_mismatch_returns_422(client, payload):
    response = client.post("/api/analyze", json=payload("04-reference-paper", kind="image", image_base64="x", text=None))
    assert response.status_code == 422
    assert response.json()["code"] == "kind_mismatch"


def test_missing_required_field_returns_422(client, payload):
    body = payload()
    del body["captured_at"]
    response = client.post("/api/analyze", json=body)
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"
    ApiError.model_validate(response.json())


def test_image_kind_without_base64_returns_422(client, payload):
    response = client.post("/api/analyze", json=payload(image_base64=None))
    assert response.status_code == 422


def test_captured_at_with_milliseconds_accepted(client, payload):
    response = client.post("/api/analyze", json=payload(captured_at="2026-11-17T15:21:06.663Z"))
    assert response.status_code == 200, "真实前端 toISOString() 带毫秒，契约必须接受"


@pytest.mark.parametrize("status", [413, 422, 503])
def test_injected_failure_matches_contract(client, payload, status):
    response = client.post(f"/api/analyze?fail={status}", json=payload())
    assert response.status_code == status
    error = ApiError.model_validate(response.json())
    assert error.retryable is True
    assert error.code


def test_oversize_content_length_returns_413(client, payload):
    response = client.post("/api/analyze", json=payload(), headers={"Content-Length": str(99 * 1024 * 1024)})
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


def test_invalid_fail_value_returns_422(client, payload):
    response = client.post("/api/analyze?fail=404", json=payload())
    assert response.status_code == 422
