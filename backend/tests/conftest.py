from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.guard import MODEL_QUOTA
from app.main import create_app
from app.providers import get_provider

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "fixtures"
IMAGE_MARKER = "BASE64_MARKER_" + "A" * 64
TEXT_MARKER = "TEXT_MARKER_敏感原文_" + "B" * 32


@pytest.fixture(autouse=True)
def _reset_model_quota():
    # 每日额度是进程级单例；测试间清零，避免跨用例累计触发 503
    MODEL_QUOTA.reset()
    yield
    MODEL_QUOTA.reset()


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
def client(monkeypatch):
    # API 测试与运行环境解耦：强制桩模式。否则 ambient JXL_PROVIDER=model 时每条
    # /api/analyze 用例都会真调付费模型 → 完整 API 测试停滞（此前停滞的根因）。
    monkeypatch.setenv("JXL_PROVIDER", "fixture")
    get_settings.cache_clear()
    get_provider.cache_clear()
    with TestClient(create_app()) as test_client:
        yield test_client
    get_settings.cache_clear()
    get_provider.cache_clear()


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
