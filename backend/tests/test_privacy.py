"""隐私边界测试：PRD 第 365 行——图片与敏感内容不得进响应回显，也不得进普通日志。"""

from __future__ import annotations

import logging

from app.observability import configure_logging, log_event
from conftest import IMAGE_MARKER, TEXT_MARKER


def test_422_does_not_echo_image_base64(client, payload):
    body = payload()
    del body["captured_at"]
    response = client.post("/api/analyze", json=body)
    assert response.status_code == 422
    assert IMAGE_MARKER not in response.text


def test_422_does_not_echo_source_text(client, payload):
    body = payload("04-reference-paper")
    del body["captured_at"]
    response = client.post("/api/analyze", json=body)
    assert response.status_code == 422
    assert TEXT_MARKER not in response.text


def test_error_detail_strips_input_and_ctx(client, payload):
    body = payload()
    del body["captured_at"]
    detail = client.post("/api/analyze", json=body).json()["detail"]
    assert isinstance(detail, list) and detail
    for entry in detail:
        assert set(entry) == {"loc", "msg", "type"}


def test_log_event_redacts_forbidden_fields(capsys):
    configure_logging()
    log_event(
        "probe",
        source_id="src-01",
        image_base64=IMAGE_MARKER,
        raw=TEXT_MARKER,
        quote={"text": TEXT_MARKER},
        api_key="sk-secret",
    )
    captured = capsys.readouterr().err
    assert IMAGE_MARKER not in captured
    assert TEXT_MARKER not in captured
    assert "sk-secret" not in captured
    assert captured.count("[redacted]") == 4
    assert "src-01" in captured


def test_analyze_logs_carry_metadata_only(capsys, client, payload):
    response = client.post("/api/analyze", json=payload())
    assert response.status_code == 200
    captured = capsys.readouterr().err
    assert IMAGE_MARKER not in captured
    assert '"event": "analyze"' in captured
    assert '"source_id": "src-01"' in captured
    assert '"field_count": 6' in captured


def test_logger_does_not_propagate_to_root():
    configure_logging()
    assert logging.getLogger("jxl").propagate is False
