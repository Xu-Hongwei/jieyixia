"""模型配置与运行配置校验回归：名称唯一/协议有效/类型与范围合法；配置问题尽早明确报告。"""

from __future__ import annotations

import json

import pytest

from app.config import ConfigError, get_settings
from app.model.base import ModelError
from app.model.registry import load_profiles


def _set(monkeypatch, profiles):
    monkeypatch.setenv("JXL_MODELS", json.dumps(profiles))
    monkeypatch.delenv("JXL_MODEL_ORDER", raising=False)


def _base(**kw):
    item = {"name": "a", "protocol": "openai", "base_url": "https://a.test/v1", "model": "m", "api_key_env": "K"}
    item.update(kw)
    return item


def test_valid_config_loads(monkeypatch):
    _set(monkeypatch, [_base(), _base(name="b")])
    assert [p.name for p in load_profiles()] == ["a", "b"]


def test_duplicate_name_rejected(monkeypatch):
    _set(monkeypatch, [_base(), _base()])
    with pytest.raises(ModelError) as info:
        load_profiles()
    assert "重复" in info.value.message


def test_unknown_protocol_rejected(monkeypatch):
    _set(monkeypatch, [_base(protocol="soap")])
    with pytest.raises(ModelError) as info:
        load_profiles()
    assert "协议" in info.value.message


@pytest.mark.parametrize("bad", ["90", 0, -1, 601, True])
def test_bad_timeout_rejected(monkeypatch, bad):
    _set(monkeypatch, [_base(timeout_s=bad)])
    with pytest.raises(ModelError):
        load_profiles()


@pytest.mark.parametrize("bad", [-1, 6, 1.5, "1", True])
def test_bad_retries_rejected(monkeypatch, bad):
    _set(monkeypatch, [_base(retries=bad)])
    with pytest.raises(ModelError):
        load_profiles()


@pytest.mark.parametrize("bad", [0, -1, 200001, "2048", True])
def test_bad_max_tokens_rejected(monkeypatch, bad):
    _set(monkeypatch, [_base(max_tokens=bad)])
    with pytest.raises(ModelError):
        load_profiles()


def test_bad_json_mode_rejected(monkeypatch):
    _set(monkeypatch, [_base(json_mode="yes")])
    with pytest.raises(ModelError):
        load_profiles()


def test_bad_extra_body_rejected(monkeypatch):
    _set(monkeypatch, [_base(extra_body=[])])
    with pytest.raises(ModelError):
        load_profiles()


@pytest.mark.parametrize("env,value", [
    ("JXL_PROVIDER", "bogus"),
    ("JXL_MAX_TEXT_CHARS", "0"),
    ("JXL_MAX_TEXT_CHARS", "abc"),
    ("JXL_MAX_IMAGE_BYTES", "-1"),
    ("JXL_ANALYZE_BUDGET_S", "0"),
    ("JXL_ANALYZE_BUDGET_S", "601"),
    ("JXL_ANALYZE_BUDGET_S", "abc"),
])
def test_bad_runtime_config_reports_early(monkeypatch, env, value):
    monkeypatch.setenv(env, value)
    get_settings.cache_clear()
    with pytest.raises(ConfigError):
        get_settings()
    get_settings.cache_clear()


@pytest.mark.parametrize("value", ["nan", "NaN", "inf", "-inf", "Infinity"])
def test_non_finite_budget_rejected(monkeypatch, value):
    monkeypatch.setenv("JXL_ANALYZE_BUDGET_S", value)
    get_settings.cache_clear()
    with pytest.raises(ConfigError) as info:
        get_settings()
    assert "有限" in str(info.value)
    get_settings.cache_clear()


@pytest.mark.parametrize("value", ["-1", "0", "abc", "1.5", "8.0"])
def test_body_limit_must_be_positive_integer(monkeypatch, value):
    # 负数/零/非整数一律明确报错，绝不静默换回默认值
    monkeypatch.setenv("JXL_MAX_BODY_BYTES", value)
    get_settings.cache_clear()
    with pytest.raises(ConfigError):
        get_settings()
    get_settings.cache_clear()


def test_body_limit_valid_positive_integer_loads(monkeypatch):
    monkeypatch.setenv("JXL_MAX_BODY_BYTES", "1048576")
    get_settings.cache_clear()
    assert get_settings().max_body_bytes == 1048576
    get_settings.cache_clear()


@pytest.mark.parametrize("kw", [
    {"base_url": 123},
    {"base_url": "   "},
    {"base_url": ["https://a.test"]},
    {"base_url": "", "base_url_env": 123},
    {"base_url": "", "base_url_env": "  "},
])
def test_bad_base_url_type_or_blank_rejected(monkeypatch, kw):
    _set(monkeypatch, [_base(**kw)])
    with pytest.raises(ModelError):
        load_profiles()


def test_base_url_env_valid_loads(monkeypatch):
    _set(monkeypatch, [_base(base_url="", base_url_env="A_URL")])
    assert load_profiles()[0].base_url_env == "A_URL"

# ---------------------------------------------------------------- 第七轮：防护与上游上限配置


@pytest.mark.parametrize("name", ["JXL_RATE_LIMIT_PER_MIN", "JXL_MAX_CONCURRENT_ANALYZE", "JXL_MAX_MODEL_CALLS_PER_DAY"])
@pytest.mark.parametrize("value", ["-1", "abc", "1.5", "nan"])
def test_guard_config_rejects_negative_and_non_integer(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    with pytest.raises(ConfigError):
        get_settings()
    get_settings.cache_clear()


@pytest.mark.parametrize("name", ["JXL_RATE_LIMIT_PER_MIN", "JXL_MAX_CONCURRENT_ANALYZE", "JXL_MAX_MODEL_CALLS_PER_DAY"])
def test_guard_config_zero_is_explicit_disable(monkeypatch, name):
    monkeypatch.setenv(name, "0")
    get_settings.cache_clear()
    assert getattr(get_settings(), {
        "JXL_RATE_LIMIT_PER_MIN": "rate_limit_per_min",
        "JXL_MAX_CONCURRENT_ANALYZE": "max_concurrent_analyze",
        "JXL_MAX_MODEL_CALLS_PER_DAY": "max_model_calls_per_day",
    }[name]) == 0
    get_settings.cache_clear()


def test_guard_config_defaults(monkeypatch):
    for name in ("JXL_RATE_LIMIT_PER_MIN", "JXL_MAX_CONCURRENT_ANALYZE", "JXL_MAX_MODEL_CALLS_PER_DAY", "JXL_API_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    settings = get_settings()
    assert settings.rate_limit_per_min == 60
    assert settings.max_concurrent_analyze == 4
    assert settings.max_model_calls_per_day == 1000
    assert settings.api_token == ""
    get_settings.cache_clear()


def test_api_token_stripped(monkeypatch):
    monkeypatch.setenv("JXL_API_TOKEN", "  tok  ")
    get_settings.cache_clear()
    assert get_settings().api_token == "tok"
    get_settings.cache_clear()


@pytest.mark.parametrize("value", ["0", "-1", "abc", "1.5"])
def test_upstream_cap_must_be_positive_integer(monkeypatch, value):
    monkeypatch.setenv("JXL_MAX_UPSTREAM_BYTES", value)
    get_settings.cache_clear()
    with pytest.raises(ConfigError):
        get_settings()
    get_settings.cache_clear()


def test_upstream_cap_default_and_custom(monkeypatch):
    monkeypatch.delenv("JXL_MAX_UPSTREAM_BYTES", raising=False)
    get_settings.cache_clear()
    assert get_settings().max_upstream_bytes == 4 * 1024 * 1024
    monkeypatch.setenv("JXL_MAX_UPSTREAM_BYTES", "1048576")
    get_settings.cache_clear()
    assert get_settings().max_upstream_bytes == 1048576
    get_settings.cache_clear()
