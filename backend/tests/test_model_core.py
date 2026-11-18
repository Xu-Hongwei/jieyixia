from __future__ import annotations

import json

import pytest

from app.model.base import ModelError
from app.model.core import parse_model_output, resolve_relative_date

CAPTURED = "2026-11-17T09:12:00+08:00"  # 周二


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("下周三课堂展示", "2026-11-25"),
        ("下周五17:00前提交", "2026-11-27T17:00"),
        ("明天下午4点前", "2026-11-18T16:00"),
        ("明天交", "2026-11-18"),
        ("后天", "2026-11-19"),
        ("大后天", "2026-11-20"),
        ("今天", "2026-11-17"),
        ("本周五", "2026-11-20"),
        ("周五交作业", "2026-11-20"),
        ("周二交作业", "2026-11-24"),
        ("下下周一", "2026-11-30"),
        ("星期天", "2026-11-22"),
        ("2026年11月19日", None),
        ("", None),
    ],
)
def test_resolve_relative_date(raw, expected):
    assert resolve_relative_date(raw, CAPTURED) == expected


def test_resolve_relative_date_bad_reference_returns_none():
    assert resolve_relative_date("明天", "不是日期") is None


@pytest.mark.parametrize(
    "raw,expected,derived",
    [
        ("本周二（5.12）下午4点前完成填写", "2026-05-12T16:00", True),
        ("请于9月19日17:00前登录官网完成报名", "2026-09-19T17:00", True),
        ("最终提交时间为2026年11月13日18:00前", "2026-11-13T18:00", False),
        ("2026.5.13 师生培训", "2026-05-13", False),
        ("12月1日上午9:00-11:00", "2026-12-01T09:00", True),
        ("下周三课堂展示", None, False),
    ],
)
def test_extract_explicit_date(raw, expected, derived):
    from app.model.core import extract_explicit_date

    result = extract_explicit_date(raw, CAPTURED)
    if expected is None:
        assert result is None
    else:
        assert result == (expected, derived)


def test_explicit_date_in_parentheses_beats_relative_word():
    text = model_json(fields=[
        {"key": "deadline", "value": None, "raw": "本周二（5.12）下午4点前完成填写", "status": "unresolved"}
    ])
    field = parse(text).fields[0]
    assert field.value == "2026-05-12T16:00:00", "括号里的明确日期必须赢过相对词"
    assert field.derived is True
    assert field.status.value == "unresolved"


def test_month_day_without_year_is_recovered_not_dropped():
    text = model_json(fields=[
        {"key": "deadline", "value": None, "raw": "请于9月19日17:00前登录官网完成报名", "status": "unresolved"}
    ])
    response = parse(text)
    field = response.fields[0]
    assert field.value == "2026-09-19T17:00:00"
    assert field.derived is True
    assert any(w.code == "date_year_inferred" for w in response.warnings)


def test_full_date_with_year_becomes_candidate():
    text = model_json(fields=[
        {"key": "deadline", "value": None, "raw": "最终提交时间为2026年11月13日18:00前", "status": "unresolved"}
    ])
    field = parse(text).fields[0]
    assert field.value == "2026-11-13T18:00:00"
    assert field.derived is False
    assert field.status.value == "candidate"


@pytest.mark.parametrize(
    "key,value,raw,expected",
    [
        ("deadline", "2026-11-13T18:00:00+08:00", "2026年11月13日18:00:00+08:00", "2026-11-13T18:00:00+08:00"),
        ("deadline", "2026-11-13T18:00", "2026年11月13日18:00", "2026-11-13T18:00:00"),
        ("deadline", "2026-11-13T18:00:00Z", "2026年11月13日18:00:00Z", "2026-11-13T18:00:00+00:00"),
        ("deadline", "2026-11-19", "2026年11月19日", "2026-11-19"),
        ("title", "不是日期", "原文", "不是日期"),
    ],
)
def test_datetime_serialization_is_canonical(key, value, raw, expected):
    text = model_json(fields=[{"key": key, "value": value, "raw": raw, "status": "candidate"}])
    assert parse(text).fields[0].value == expected


def test_model_invented_year_and_timezone_are_stripped_and_flagged():
    text = model_json(fields=[{
        "key": "deadline", "value": "2026-11-18T14:30:00+08:00",
        "raw": "11月18日 周三 14:30-15:30", "status": "candidate",
    }])
    response = parse(text)
    field = response.fields[0]
    assert field.value == "2026-11-18T14:30:00", "原文没有的时区必须剥掉"
    assert field.derived is True, "原文没有的年份属推算"
    assert field.status.value == "unresolved"
    codes = {w.code for w in response.warnings}
    assert "date_year_inferred" in codes
    assert "timezone_unspecified" in codes


def test_end_of_day_2400_folds_to_date_precision():
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-09-16T24:00:00", "raw": "9月16日24:00", "status": "candidate"},
    ])
    f = parse(text).fields[0]
    assert f.value == "2026-09-16"
    assert f.precision == "date"


def test_invalid_calendar_value_rejected():
    from app.model.base import ModelError as ME
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-02-30", "raw": "2026年2月30日", "status": "candidate"},
    ])
    with pytest.raises(ME):
        parse(text)


def test_requirement_accepts_string_array():
    text = model_json(fields=[
        {"key": "requirement", "value": ["提交 PDF", "附代码包"], "raw": "提交材料：PDF、代码包", "status": "candidate"},
    ])
    f = parse(text).fields[0]
    assert f.value == ["提交 PDF", "附代码包"]


def test_time_metadata_precision_and_tz_known():
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-19", "raw": "2026年11月19日", "status": "candidate"},
    ])
    f = parse(text).fields[0]
    assert f.precision == "date"
    assert f.tz_known is None

    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-19T18:00:00+08:00", "raw": "2026年11月19日18:00+08:00", "status": "candidate"},
    ])
    f = parse(text).fields[0]
    assert f.precision == "datetime"
    assert f.tz_known is True

    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-19T18:00", "raw": "2026年11月19日18:00", "status": "candidate"},
    ])
    f = parse(text).fields[0]
    assert f.precision == "datetime"
    assert f.tz_known is False


def test_naive_datetime_keeps_no_timezone_and_warns():
    from app.model.core import canonical_datetime

    assert canonical_datetime("2026-11-13T18:00") == "2026-11-13T18:00:00"
    text = model_json(fields=[{"key": "deadline", "value": "2026-11-13T18:00", "raw": "原文", "status": "candidate"}])
    response = parse(text)
    assert response.fields[0].value == "2026-11-13T18:00:00"
    assert any(w.code == "timezone_unspecified" for w in response.warnings)


def model_json(**overrides) -> str:
    base = {
        "content_type": "notice",
        "fields": [
            {"key": "title", "value": "课程报告", "raw": "机器学习课程报告", "status": "candidate",
             "quote": {"text": "机器学习课程报告"}}
        ],
        "warnings": [],
    }
    base.update(overrides)
    return json.dumps(base, ensure_ascii=False)


def parse(text: str):
    return parse_model_output(text, source_id="src-01", captured_at=CAPTURED, model_name="p1")


def test_parse_produces_contract_valid_response():
    response = parse(model_json())
    assert response.source_id == "src-01"
    assert response.model_name == "p1"
    field = response.fields[0]
    assert field.origin.value == "model"
    assert field.status.value == "candidate"
    assert field.quote.source_id == "src-01"


def test_parse_strips_markdown_fence():
    assert parse("```json\n" + model_json() + "\n```").content_type.value == "notice"


def test_parse_normalizes_relative_date_and_warns():
    text = model_json(fields=[
        {"key": "deadline", "value": None, "raw": "下周三课堂展示", "status": "unresolved"}
    ])
    response = parse(text)
    field = response.fields[0]
    assert field.value == "2026-11-25"
    assert field.derived is True
    assert field.status.value == "unresolved", "换算后仍待用户确认，不得自动 confirmed"
    assert any(w.code == "relative_date_derived" for w in response.warnings)


def test_parse_keeps_missing_field_null():
    text = model_json(fields=[{"key": "deadline", "value": "不该有的值", "raw": "", "status": "missing"}])
    field = parse(text).fields[0]
    assert field.value is None
    assert field.quote is None


def test_candidate_without_value_is_downgraded_to_missing():
    text = model_json(content_type="tutorial", fields=[
        {"key": "steps", "value": None, "raw": "原文其实有步骤", "status": "candidate"}
    ])
    response = parse(text)
    assert response.fields[0].status.value == "missing"
    assert any(w.code == "candidate_without_value" for w in response.warnings)


def test_parse_falls_back_to_raw_for_quote():
    text = model_json(fields=[{"key": "title", "value": "T", "raw": "原文片段", "status": "candidate"}])
    assert parse(text).fields[0].quote.text == "原文片段"


@pytest.mark.parametrize(
    "overrides",
    [
        {"content_type": "poem"},
        {"fields": []},
        {"fields": [{"key": "title", "value": "T", "raw": "原文", "status": "confirmed"}]},
        {"fields": [{"key": "title", "value": "T", "raw": "原文", "status": "weird"}]},
        {"fields": [{"value": "T", "raw": "原文", "status": "candidate"}]},
        {"fields": ["not-an-object"]},
    ],
)
def test_parse_rejects_contract_violations(overrides):
    with pytest.raises(ModelError) as info:
        parse(model_json(**overrides))
    assert info.value.kind == "invalid_output"


@pytest.mark.parametrize("text", ["完全不是 JSON", "", "{\"content_type\": ", "[]"])
def test_parse_rejects_non_object_output(text):
    with pytest.raises(ModelError) as info:
        parse(text)
    assert info.value.kind == "invalid_output"


def test_parse_error_message_does_not_leak_user_content():
    secret = "敏感原文内容ABC"
    with pytest.raises(ModelError) as info:
        parse(secret + " 不是 JSON")
    assert secret not in info.value.message
