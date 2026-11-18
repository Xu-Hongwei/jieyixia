from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures"
IMAGE_MARKER = "BASE64_MARKER_" + "A" * 64
TEXT_MARKER = "TEXT_MARKER_敏感原文_" + "B" * 32


@pytest.fixture(scope="session")
def fixtures() -> dict[str, dict]:
    return {
        path.stem: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(FIXTURE_DIR.glob("*.json"))
        if path.name != "index.json"
    }


@pytest.fixture(scope="session")
def analysis_ids(fixtures: dict[str, dict]) -> list[str]:
    return [key for key, value in fixtures.items() if value["kind"] == "analysis"]


@pytest.fixture()
def client():
    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture()
def payload(fixtures: dict[str, dict]):
    def build(fixture_id: str = "01-course-assignment", **overrides) -> dict:
        request = dict(fixtures[fixture_id]["analyze_request"])
        if request.get("kind") == "image":
            request["image_base64"] = IMAGE_MARKER
        if request.get("kind") == "text":
            request["text"] = TEXT_MARKER
        request.update(overrides)
        return request

    return build
