from __future__ import annotations

import math
import os
from dataclasses import dataclass
from functools import lru_cache


class ConfigError(ValueError):
    """配置非法：启动期即抛出并明确报告，不等用户发起分析才暴露内部错误。"""


def _positive_int_env(name: str, default: int, *, maximum: int | None = None) -> int:
    raw = os.environ.get(name)
    if not raw or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{name} 必须是整数，收到 {raw!r}") from exc
    if value <= 0:
        raise ConfigError(f"{name} 必须为正数，收到 {value}")
    if maximum is not None and value > maximum:
        raise ConfigError(f"{name} 不得超过 {maximum}，收到 {value}")
    return value


def _nonneg_int_env(name: str, default: int, *, maximum: int | None = None) -> int:
    """0 是显式「关闭」语义（限流/并发/额度），负数与非整数一律拒绝。"""
    raw = os.environ.get(name)
    if not raw or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{name} 必须是整数，收到 {raw!r}") from exc
    if value < 0:
        raise ConfigError(f"{name} 不能为负数（0 表示关闭），收到 {value}")
    if maximum is not None and value > maximum:
        raise ConfigError(f"{name} 不得超过 {maximum}，收到 {value}")
    return value


def _float_env(name: str, default: float, *, maximum: float) -> float:
    raw = os.environ.get(name)
    if not raw or not raw.strip():
        return default
    try:
        value = float(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{name} 必须是数字，收到 {raw!r}") from exc
    if not math.isfinite(value):
        raise ConfigError(f"{name} 必须是有限数字（拒绝 NaN/Infinity），收到 {raw!r}")
    if value <= 0:
        raise ConfigError(f"{name} 必须为正数，收到 {value}")
    if value > maximum:
        raise ConfigError(f"{name} 不得超过 {maximum}，收到 {value}")
    return value


@dataclass(frozen=True)
class Settings:
    provider: str
    max_body_bytes: int
    cors_origins: tuple[str, ...]
    max_text_chars: int
    max_image_bytes: int
    max_image_pixels: int
    max_image_side: int
    max_output_chars: int
    analyze_budget_s: float
    max_upstream_bytes: int
    api_token: str
    rate_limit_per_min: int
    max_concurrent_analyze: int
    max_model_calls_per_day: int
    propose_budget_s: float
    propose_max_attempts: int
    propose_max_body_bytes: int


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    origins = os.environ.get("JXL_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    provider = os.environ.get("JXL_PROVIDER", "fixture")
    if provider not in ("fixture", "model"):
        raise ConfigError(f"JXL_PROVIDER={provider!r} 只能是 fixture 或 model")
    return Settings(
        provider=provider,
        max_body_bytes=_positive_int_env("JXL_MAX_BODY_BYTES", 8 * 1024 * 1024),
        cors_origins=tuple(x.strip() for x in origins.split(",") if x.strip()),
        max_text_chars=_positive_int_env("JXL_MAX_TEXT_CHARS", 20_000),
        max_image_bytes=_positive_int_env("JXL_MAX_IMAGE_BYTES", 6 * 1024 * 1024),
        max_image_pixels=_positive_int_env("JXL_MAX_IMAGE_PIXELS", 40_000_000),
        max_image_side=_positive_int_env("JXL_MAX_IMAGE_SIDE", 10_000),
        max_output_chars=_positive_int_env("JXL_MAX_OUTPUT_CHARS", 200_000),
        analyze_budget_s=_float_env("JXL_ANALYZE_BUDGET_S", 120.0, maximum=600.0),
        max_upstream_bytes=_positive_int_env("JXL_MAX_UPSTREAM_BYTES", 4 * 1024 * 1024),
        api_token=os.environ.get("JXL_API_TOKEN", "").strip(),
        rate_limit_per_min=_nonneg_int_env("JXL_RATE_LIMIT_PER_MIN", 60, maximum=1_000_000),
        max_concurrent_analyze=_nonneg_int_env("JXL_MAX_CONCURRENT_ANALYZE", 4, maximum=1024),
        max_model_calls_per_day=_nonneg_int_env("JXL_MAX_MODEL_CALLS_PER_DAY", 1000, maximum=1_000_000),
        propose_budget_s=_float_env("JXL_PROPOSE_BUDGET_S", 120.0, maximum=600.0),
        propose_max_attempts=_positive_int_env("JXL_PROPOSE_MAX_ATTEMPTS", 2, maximum=2),
        propose_max_body_bytes=_positive_int_env("JXL_PROPOSE_MAX_BODY_BYTES", 512 * 1024, maximum=8 * 1024 * 1024),
    )