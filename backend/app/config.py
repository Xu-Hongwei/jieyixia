from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    provider: str
    max_body_bytes: int
    cors_origins: tuple[str, ...]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    origins = os.environ.get("JXL_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    return Settings(
        provider=os.environ.get("JXL_PROVIDER", "fixture"),
        max_body_bytes=_int_env("JXL_MAX_BODY_BYTES", 8 * 1024 * 1024),
        cors_origins=tuple(x.strip() for x in origins.split(",") if x.strip()),
    )
