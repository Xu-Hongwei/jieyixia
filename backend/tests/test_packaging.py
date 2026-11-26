"""打包一致性守卫：pyproject 版本与契约对齐；依赖锁存在、精确钉死、覆盖运行依赖且与当前环境一致。"""

from __future__ import annotations

import tomllib
from importlib.metadata import version
from pathlib import Path

from app._contract import SCHEMA_VERSION

BACKEND = Path(__file__).resolve().parents[1]
RUNTIME_ROOTS = {"fastapi", "uvicorn", "pydantic", "httpx", "pillow"}


def _pins(path: Path) -> dict[str, str]:
    pins = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, ver = line.partition("==")
        assert sep, f"锁文件必须精确钉死（==），发现：{line}"
        pins[name.lower()] = ver
    return pins


def test_pyproject_version_matches_contract():
    data = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))
    assert data["project"]["version"] == SCHEMA_VERSION


def test_runtime_lock_covers_all_runtime_dependencies():
    pins = _pins(BACKEND / "requirements.lock")
    assert RUNTIME_ROOTS <= set(pins)


def test_dev_lock_is_superset_and_includes_pytest():
    runtime = _pins(BACKEND / "requirements.lock")
    dev = _pins(BACKEND / "requirements-dev.lock")
    assert "pytest" in dev
    for name, ver in runtime.items():
        assert dev[name] == ver


def test_installed_runtime_versions_match_lock():
    # 漂移守卫：当前环境必须与锁一致；升级依赖须重跑全量测试后重新生成锁
    pins = _pins(BACKEND / "requirements.lock")
    for name in RUNTIME_ROOTS:
        assert version(name).lower() == pins[name].lower(), f"{name} 与 requirements.lock 不一致"