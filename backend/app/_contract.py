"""把仓库根加入 sys.path，让 backend 直接 import 契约唯一来源 contract.models。

不复制契约、不另建模型：后端与前端共用同一份 Pydantic 定义。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from contract.models import (  # noqa: E402
    SCHEMA_VERSION,
    AnalyzeRequest,
    AnalyzeResponse,
    ApiError,
    ContentType,
    Field,
    FieldOrigin,
    FieldStatus,
    Fixture,
    HealthResponse,
    Quote,
    Warning,
)

FIXTURE_DIR = ROOT / "fixtures"

__all__ = [
    "ROOT",
    "FIXTURE_DIR",
    "SCHEMA_VERSION",
    "AnalyzeRequest",
    "AnalyzeResponse",
    "ApiError",
    "ContentType",
    "Field",
    "FieldOrigin",
    "FieldStatus",
    "Fixture",
    "HealthResponse",
    "Quote",
    "Warning",
]
