from __future__ import annotations

import json

import pytest

from app.model.base import ModelError
from app.model.core import parse_model_output

CAPTURED = "2026-11-17T09:12:00+08:00"  # 周二


def nodes_field(nodes: list[dict]) -> dict:
    return {"key": "time_nodes", "value": nodes, "raw": "", "status": "candidate"}


def test_multi_nodes_primary_is_earliest_and_deterministic():
    nodes = [
        {"label": "第二场", "raw": "2026年11月18日 19:00-20:00", "value": "2026-11-18T19:00:00", "basis": "explicit"},
        {"label": "第一场", "raw": "2026年11月18日 14:30-15:30", "value": "2026-11-18T14:30:00", "basis": "explicit"},
    ]
    text = model_json(fields=[nodes_field(nodes)])
    first = parse(text)
    second = parse(text)
    dl = next(f for f in first.fields if f.key == "deadline")
    assert dl.value == "2026-11-18T14:30:00", "选最早节点，与输入顺序无关"
    assert dl.status.value == "candidate"
    assert [f.value for f in first.fields if f.key == "deadline"] == [f.value for f in second.fields if f.key == "deadline"]
    tn = next(f for f in first.fields if f.key == "time_nodes")
    assert len(tn.value) == 2, "全部节点保留"


def test_relative_node_model_computed_marks_derived():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "下周五17:00", "value": "2026-11-27T17:00:00", "basis": "relative"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-27T17:00:00"
    assert dl.derived is True
    assert dl.status.value == "unresolved"


def test_node_missing_year_is_inferred_and_flagged():
    text = model_json(fields=[nodes_field([
        {"label": "报名", "raw": "9月19日17:00", "value": "2026-09-19T17:00:00", "basis": "explicit"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.derived is True
    assert dl.status.value == "unresolved"
    assert any(w.code == "date_year_inferred" for w in response.warnings)


def test_model_and_backend_same_warning_deduped():
    text = model_json(
        fields=[{"key": "deadline", "value": "2026-11-19T18:00", "raw": "2026年11月19日18:00", "status": "candidate"}],
        warnings=[{"code": "timezone_unspecified", "message": "模型自报", "field_key": "deadline"}],
    )
    response = parse(text)
    tz = [w for w in response.warnings if w.code == "timezone_unspecified"]
    assert len(tz) == 1


def test_duplicate_keys_deduped():
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-20", "raw": "2026年11月20日", "status": "candidate"},
        {"key": "deadline", "value": "2026-11-21", "raw": "2026年11月21日", "status": "candidate"},
    ])
    response = parse(text)
    dls = [f for f in response.fields if f.key == "deadline"]
    assert len(dls) == 1
    assert dls[0].value == "2026-11-21"


def test_warning_codes_closed_and_backend_authoritative():
    text = model_json(warnings=[
        {"code": "relative_date_unresolved", "message": "模型自造同义码", "field_key": "deadline"},
        {"code": "totally_made_up", "message": "应被丢弃", "field_key": None},
        {"code": "timezone_unspecified", "message": "后端权威码，模型自报忽略", "field_key": "deadline"},
        {"code": "no_deadline_in_source", "message": "非后端码保留", "field_key": None},
    ])
    response = parse(text)
    codes = [w.code for w in response.warnings]
    assert codes == ["no_deadline_in_source"]


def test_superseded_node_excluded_from_primary():
    text = model_json(fields=[nodes_field([
        {"label": "旧截止", "raw": "由11月13日调整", "value": "2026-11-13T18:00:00", "basis": "superseded"},
        {"label": "新截止", "raw": "调整至11月15日18:00", "value": "2026-11-15T18:00:00", "basis": "explicit"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-15T18:00:00", "被取代的旧日期不参与选主"
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert len(tn.value) == 2, "旧节点仍保留供溯源"


def test_node_null_value_preserved_not_fabricated():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "月底前", "value": None, "basis": "relative"},
    ])])
    response = parse(text)
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert tn.value[0]["value"] is None
    assert not any(f.key == "deadline" and f.value for f in response.fields), "换算不出不编造"


def test_node_invalid_calendar_rejected():
    text = model_json(fields=[nodes_field([
        {"label": "x", "raw": "2026年2月30日", "value": "2026-02-30", "basis": "explicit"},
    ])])
    with pytest.raises(ModelError):
        parse(text)


def test_node_2400_folds_to_date_precision():
    text = model_json(fields=[nodes_field([
        {"label": "线上", "raw": "9月16日24:00", "value": "2026-09-16T24:00:00", "basis": "explicit"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-09-16"
    assert dl.precision == "date"


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
