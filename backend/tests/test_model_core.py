from __future__ import annotations

import json

import pytest

from app.model.base import ModelError
from app.model.core import parse_model_output


def nodes_field(nodes: list[dict]) -> dict:
    return {"key": "time_nodes", "value": nodes, "raw": "", "status": "candidate"}


def synth_node(response):
    """deadline-only 输出合成的节点（role=unknown，deadline 缺席，节点保留供人工选择）。"""
    tn = next(f for f in response.fields if f.key == "time_nodes")
    return tn.value[0]


def test_multi_nodes_primary_is_earliest_and_deterministic():
    nodes = [
        {"label": "第二场", "raw": "2026年11月18日 19:00-20:00", "value": "2026-11-18T19:00:00", "basis": "explicit", "role": "event_start"},
        {"label": "提交截止", "raw": "2026年11月18日 14:30前", "value": "2026-11-18T14:30:00", "basis": "explicit", "role": "submission_deadline"},
    ]
    text = model_json(fields=[nodes_field(nodes)])
    first = parse(text)
    second = parse(text)
    dl = next(f for f in first.fields if f.key == "deadline")
    assert dl.value == "2026-11-18T14:30:00", "仅 submission_deadline 参与选主，活动开始不参与"
    assert dl.status.value == "candidate"
    assert [f.value for f in first.fields if f.key == "deadline"] == [f.value for f in second.fields if f.key == "deadline"]
    tn = next(f for f in first.fields if f.key == "time_nodes")
    assert len(tn.value) == 2, "全部节点保留"


def test_relative_node_model_computed_marks_derived():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "消息日期2026年11月17日，下周五17:00", "value": "2026-11-27T17:00:00", "basis": "relative",
         "role": "submission_deadline", "reference_at": "2026-11-17", "reference_source": "message_date",
         "message_date": "2026-11-17"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-27T17:00:00"
    assert dl.derived is True
    assert dl.status.value == "unresolved"


def test_same_day_capture_is_not_a_reliable_reference():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "明天17:00", "value": "2026-11-18T17:00:00", "basis": "relative",
         "role": "submission_deadline", "reference_at": "2026-11-17", "reference_source": "captured"},
    ])])
    response = parse(text)  # 当天保存、无消息日期、无用户指定
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert tn.value[0]["value"] is None, "保存日永远不是可靠参照，当天也不行"
    assert not any(f.key == "deadline" and f.value for f in response.fields)


def test_relative_with_user_reference_from_request_kept():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "明天17:00", "value": "2026-11-18T17:00:00", "basis": "relative",
         "role": "submission_deadline", "reference_at": "2026-11-17", "reference_source": "user"},
    ])])
    response = parse(text, user_reference_at="2026-11-17")
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-18T17:00:00"
    assert dl.derived is True


def test_node_missing_year_without_reference_nulled():
    text = model_json(fields=[nodes_field([
        {"label": "报名", "raw": "9月19日17:00", "value": "2026-09-19T17:00:00", "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    node = synth_node(response)
    assert node["value"] is None, "缺年份且无可靠参照：不任意补年"
    assert node["derived"] is True
    assert not any(f.key == "deadline" for f in response.fields)
    assert any(w.code == "date_year_inferred" for w in response.warnings)


def test_node_missing_year_with_user_reference_kept():
    text = model_json(fields=[nodes_field([
        {"label": "报名", "raw": "9月19日17:00", "value": "2026-09-19T17:00:00", "basis": "explicit",
         "role": "submission_deadline", "reference_at": "2026-09-01", "reference_source": "user"},
    ])])
    response = parse(text, user_reference_at="2026-09-01")
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-09-19T17:00:00"
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
    # 重复 deadline 键去重保留最后；合成节点 role=unknown，deadline 缺席，值落在节点上
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert len(tn.value) == 1
    assert tn.value[0]["value"] == "2026-11-21"


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
        {"label": "旧截止", "raw": "由2026年11月13日调整", "value": "2026-11-13T18:00:00", "basis": "superseded", "role": "submission_deadline"},
        {"label": "新截止", "raw": "调整至2026年11月15日18:00", "value": "2026-11-15T18:00:00", "basis": "explicit", "role": "submission_deadline"},
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
        {"label": "线上", "raw": "2026年9月16日24:00", "value": "2026-09-16T24:00:00", "basis": "explicit", "role": "submission_deadline"},
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
    response = parse(text)
    if key == "deadline":
        # deadline-only 合成节点 role=unknown，deadline 缺席；规范化值落在节点上
        assert synth_node(response)["value"] == expected
    else:
        assert response.fields[0].value == expected


def test_model_invented_year_without_reference_nulled():
    text = model_json(fields=[{
        "key": "deadline", "value": "2026-11-18T14:30:00+08:00",
        "raw": "11月18日 周三 14:30-15:30", "status": "candidate",
    }])
    response = parse(text)
    node = synth_node(response)
    assert node["value"] is None, "缺年份且无可靠参照：不任意补年"
    assert node["derived"] is True
    assert any(w.code == "date_year_inferred" for w in response.warnings)


def test_model_invented_timezone_stripped_with_reference():
    text = model_json(fields=[{
        "key": "deadline", "value": "2026-11-18T14:30:00+08:00",
        "raw": "11月18日 周三 14:30-15:30", "status": "candidate",
    }])
    response = parse(text, user_reference_at="2026-11-17")
    node = synth_node(response)
    assert node["value"] == "2026-11-18T14:30:00", "原文没有的时区必须剥掉"
    assert node["derived"] is True, "原文没有的年份属推算"
    codes = {w.code for w in response.warnings}
    assert "date_year_inferred" in codes
    assert "timezone_unspecified" in codes


def test_end_of_day_2400_folds_to_date_precision():
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-09-16T24:00:00", "raw": "2026年9月16日24:00", "status": "candidate"},
    ])
    node = synth_node(parse(text))
    assert node["value"] == "2026-09-16"
    assert node["precision"] == "date"


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
    node = synth_node(parse(text))
    assert node["precision"] == "date"
    assert node["tz_known"] is None

    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-19T18:00:00+08:00", "raw": "2026年11月19日18:00+08:00", "status": "candidate"},
    ])
    node = synth_node(parse(text))
    assert node["precision"] == "datetime"
    assert node["tz_known"] is True

    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-19T18:00", "raw": "2026年11月19日18:00", "status": "candidate"},
    ])
    node = synth_node(parse(text))
    assert node["precision"] == "datetime"
    assert node["tz_known"] is False


def test_naive_datetime_keeps_no_timezone_and_warns():
    from app.model.core import canonical_datetime

    assert canonical_datetime("2026-11-13T18:00") == "2026-11-13T18:00:00"
    text = model_json(fields=[{"key": "deadline", "value": "2026-11-13T18:00", "raw": "2026年11月13日18:00", "status": "candidate"}])
    response = parse(text)
    assert synth_node(response)["value"] == "2026-11-13T18:00:00"
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


def parse(text: str, user_reference_at: str | None = None):
    return parse_model_output(text, source_id="src-01", model_name="p1", user_reference_at=user_reference_at)


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


def test_relative_claimed_user_reference_without_request_is_null():
    text = model_json(fields=[nodes_field([
        {"label": "填写", "raw": "本周二下午4点前", "value": "2026-11-24T16:00:00", "basis": "relative",
         "role": "submission_deadline", "reference_at": "2026-11-17", "reference_source": "user"},
    ])])
    response = parse(text)  # 请求未带 reference_at
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert tn.value[0]["value"] is None, "不得借 user 名义在无用户指定时换算"


def test_range_value_nulled_not_guessed():
    text = model_json(fields=[nodes_field([
        {"label": "放假", "raw": "9月25日至9月27日", "value": "2026-09-25至2026-09-27", "basis": "explicit", "role": "event_start"},
    ])])
    response = parse(text)
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert tn.value[0]["value"] is None, "区间不猜单值"


def test_event_start_only_no_deadline():
    text = model_json(fields=[nodes_field([
        {"label": "放假开始", "raw": "2026年9月25日", "value": "2026-09-25", "basis": "explicit", "role": "event_start"},
        {"label": "补班", "raw": "9月20日", "value": "2026-09-20", "basis": "explicit", "role": "other"},
    ])])
    response = parse(text)
    assert not any(f.key == "deadline" for f in response.fields), "活动开始/补班不自动成为截止"
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert len(tn.value) == 2, "节点保留供用户选择"


def test_old_screenshot_relative_not_converted_from_capture():
    text = model_json(fields=[nodes_field([
        {"label": "填写", "raw": "本周二（5.12）下午4点前", "value": "2026-11-17T16:00:00", "basis": "relative",
         "role": "submission_deadline", "reference_at": "2026-11-17", "reference_source": "captured",
         "message_date": "2026-05-13"},
    ])])
    response = parse(text)
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert tn.value[0]["value"] is None, "旧截图不得拿保存日换算相对日期"
    assert not any(f.key == "deadline" and f.value for f in response.fields)


def test_relative_with_message_date_reference_kept():
    text = model_json(fields=[nodes_field([
        {"label": "填写", "raw": "本周二（5.12）下午4点前", "value": "2026-05-12T16:00:00", "basis": "relative",
         "role": "submission_deadline", "reference_at": "2026-05-13", "reference_source": "message_date",
         "message_date": "2026-05-13"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-05-12T16:00:00"
    assert dl.derived is True


def test_ambiguous_precision_deadline_absent_with_warning():
    text = model_json(fields=[nodes_field([
        {"label": "a", "raw": "2026年11月20日", "value": "2026-11-20", "basis": "explicit", "role": "submission_deadline"},
        {"label": "b", "raw": "2026年11月21日18:00", "value": "2026-11-21T18:00:00", "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    assert not any(f.key == "deadline" for f in response.fields), "精度/时区不可比较不猜"
    assert any(w.code == "deadline_unselectable" for w in response.warnings)


def test_manual_deadline_valid_and_note_source_required():
    from contract.models import Deadline
    manual = Deadline(value="2026-11-20", precision="date", source="manual", confirmed_at="2026-11-18T09:00:00+08:00")
    assert manual.from_note_id is None
    with pytest.raises(Exception):
        Deadline(value="2026-11-20", precision="date", source="note", confirmed_at="2026-11-18T09:00:00+08:00")
    with pytest.raises(Exception):
        Deadline(value="2026-11-20", precision="date", source="manual", from_note_id="note-01", confirmed_at="2026-11-18T09:00:00+08:00")


def test_confirmed_null_rejected():
    from contract.models import Field
    with pytest.raises(Exception):
        Field(key="deadline", value=None, raw="原文", status="confirmed")


def test_derived_confirmed_preserves_value_origin():
    from contract.models import Field
    # D4：用户确认模型推算值（未改值）→ derived+confirmed 合法，origin 保持 model，不伪装成 user
    f = Field(key="deadline", value="2026-11-25", raw="下周三课堂展示", status="confirmed",
              derived=True, origin="model", quote={"text": "下周三课堂展示", "source_id": "src-01"})
    assert f.derived is True and f.status.value == "confirmed" and f.origin.value == "model"
    # 用户实际改值 → origin=user 同样合法，保留 derived 与原文
    g = Field(key="deadline", value="2026-11-26", raw="下周三课堂展示", status="confirmed",
              derived=True, origin="user", quote={"text": "下周三课堂展示", "source_id": "src-01"})
    assert g.origin.value == "user" and g.derived is True
    # 确认 null 仍拒绝（D5）
    with pytest.raises(Exception):
        Field(key="deadline", value=None, raw="下周三课堂展示", status="confirmed",
              derived=True, origin="model", quote={"text": "下周三课堂展示", "source_id": "src-01"})


def test_deadline_only_explicit_goes_through_node_rules():
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-20", "raw": "2026年11月20日", "status": "candidate"},
    ])
    response = parse(text)
    node = synth_node(response)
    # D4：模型未给节点角色，合成节点 role=unknown，不伪造 submission_deadline；deadline 缺席交用户选择
    assert node["role"] == "unknown"
    assert node["value"] == "2026-11-20"
    assert not any(f.key == "deadline" for f in response.fields)


def test_deadline_only_relative_without_reference_is_nulled():
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-18", "raw": "明天", "status": "candidate"},
    ])
    response = parse(text)  # 无 message_date、无用户参照
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert tn.value[0]["value"] is None, "只给 deadline 也绕不过参照诚实规则"
    assert not any(f.key == "deadline" and f.value for f in response.fields)
    assert any(w.code == "relative_date_derived" for w in response.warnings)


def test_deadline_only_relative_with_digit_no_reference_nulled():
    # 复现：「明天下午5点前提交」含数字 5，不能用「raw 无数字」判相对；无参照必须置空
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-18T17:00:00", "raw": "明天下午5点前提交", "status": "candidate"},
    ])
    response = parse(text)
    assert synth_node(response)["value"] is None
    assert not any(f.key == "deadline" and f.value for f in response.fields)


def test_deadline_only_activity_start_not_promoted_to_submission():
    # 复现：活动开始即便有参照也不得被合成为提交截止（role=unknown，deadline 缺席）
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-18T17:00:00", "raw": "宣讲会明天下午5点开始", "status": "candidate"},
    ])
    response = parse(text, user_reference_at="2026-11-17")
    node = synth_node(response)
    assert node["role"] == "unknown"
    assert node["value"] == "2026-11-18T17:00:00", "节点保留供人工选择"
    assert not any(f.key == "deadline" for f in response.fields), "活动开始不自动升为提交截止"


def test_deadline_only_relative_with_user_reference_kept_as_node():
    text = model_json(fields=[
        {"key": "deadline", "value": "2026-11-18", "raw": "明天", "status": "candidate"},
    ])
    response = parse(text, user_reference_at="2026-11-17")
    node = synth_node(response)
    assert node["value"] == "2026-11-18"
    assert node["derived"] is True and node["role"] == "unknown"
    assert not any(f.key == "deadline" for f in response.fields), "角色未确认，deadline 缺席交用户选择"


def test_deadline_only_tutorial_relative_without_reference_nulled():
    text = model_json(content_type="tutorial", fields=[
        {"key": "deadline", "value": "2026-11-18", "raw": "明天", "status": "candidate"},
    ])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value is None and dl.status.value == "unresolved"


def test_cross_offset_deadline_compared_by_absolute_instant():
    text = model_json(fields=[nodes_field([
        {"label": "甲", "raw": "2026年11月18日09:00+00:00", "value": "2026-11-18T09:00:00+00:00",
         "basis": "explicit", "role": "submission_deadline"},
        {"label": "乙", "raw": "2026年11月18日14:30+08:00", "value": "2026-11-18T14:30:00+08:00",
         "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    # 14:30+08:00 = 06:30Z，早于 09:00Z；字符串比较会错选 09:00
    assert dl.value == "2026-11-18T14:30:00+08:00"


def test_deadline_calendar_illegal_rejected():
    from contract.models import Deadline
    with pytest.raises(Exception):
        Deadline(value="2026-02-30", precision="date", source="manual",
                 confirmed_at="2026-11-18T09:00:00+08:00")


def test_user_prompt_carries_reference_and_demotes_capture():
    from app.model.core import build_user_text
    from contract.models import AnalyzeRequest
    req = AnalyzeRequest(source_id="s", kind="text", text="明天交",
                         captured_at="2026-11-17T09:12:00+08:00", reference_at="2026-11-17")
    prompt = build_user_text(req)
    assert "用户指定参照日期" in prompt and "2026-11-17" in prompt
    assert "不得作为相对时间参照" in prompt
    req2 = AnalyzeRequest(source_id="s", kind="text", text="明天交",
                          captured_at="2026-11-17T09:12:00+08:00")
    assert "用户指定参照日期" not in build_user_text(req2)


def test_cross_year_relative_kept():
    # 12-31 的「明天」→ 次年 01-01：有可靠参照（消息日期）不得因跨年清空
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "明天17:00", "value": "2027-01-01T17:00:00", "basis": "relative",
         "role": "submission_deadline", "reference_at": "2026-12-31", "reference_source": "message_date",
         "message_date": "2026-12-31"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2027-01-01T17:00:00"
    assert dl.derived is True and dl.status.value == "unresolved"


def test_cross_year_inferred_kept():
    # 消息日期 12-31，原文「1月1日」补年 → 次年 01-01：inferred 跨年同样保留
    text = model_json(fields=[nodes_field([
        {"label": "报名", "raw": "1月1日17:00", "value": "2027-01-01T17:00:00", "basis": "inferred",
         "role": "submission_deadline", "reference_at": "2026-12-31", "reference_source": "message_date",
         "message_date": "2026-12-31"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2027-01-01T17:00:00"
    assert dl.derived is True


# ---- 第四轮：inferred 绕过可靠参照的漏洞（三次验收第 2 节三例 + 误标变体）----

@pytest.mark.parametrize("raw", ["三天后17:00提交", "收到通知后48小时内提交", "11月20日提交"])
def test_inferred_without_reference_nulled(raw):
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": raw, "value": "2038-11-20T17:00:00", "basis": "inferred", "role": "submission_deadline"},
    ])])
    response = parse(text)
    node = synth_node(response)
    assert node["value"] is None, "inferred 无可靠参照不得接受模型补出的年份/换算"
    assert node["derived"] is True
    assert not any(f.key == "deadline" for f in response.fields)


@pytest.mark.parametrize("raw", ["三天后17:00提交", "收到通知后48小时内提交", "11月20日提交"])
def test_inferred_with_user_reference_kept(raw):
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": raw, "value": "2038-11-20T17:00:00", "basis": "inferred",
         "role": "submission_deadline", "reference_at": "2038-11-17", "reference_source": "user"},
    ])])
    response = parse(text, user_reference_at="2038-11-17")
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2038-11-20T17:00:00", "有可靠参照时允许保留模型推算候选"
    assert dl.derived is True
    assert dl.status.value == "unresolved"


def test_inferred_with_message_date_reference_kept():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "11月20日提交", "value": "2026-11-20T17:00:00", "basis": "inferred",
         "role": "submission_deadline", "reference_at": "2026-11-10", "reference_source": "message_date",
         "message_date": "2026-11-10"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-20T17:00:00"
    assert dl.derived is True


@pytest.mark.parametrize("basis", ["explicit", "inferred"])
def test_mislabeled_relative_unknown_words_caught_by_year_check(basis):
    # 「三天后」不在相对词表内：不靠扩词表，value 年份不在原文 → 结构化拦下
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "三天后17:00提交", "value": "2038-11-20T17:00:00", "basis": basis, "role": "submission_deadline"},
    ])])
    response = parse(text)
    assert synth_node(response)["value"] is None


def test_invented_year_lie_about_user_reference_nulled():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "11月20日提交", "value": "2038-11-20T17:00:00", "basis": "inferred",
         "role": "submission_deadline", "reference_at": "2038-11-17", "reference_source": "user"},
    ])])
    response = parse(text)  # 请求里并没有 reference_at：谎称 user 不算可靠参照
    assert synth_node(response)["value"] is None


def test_deadline_only_field_invented_year_without_reference_nulled():
    text = model_json(fields=[
        {"key": "deadline", "value": "2038-11-20T17:00:00", "raw": "11月20日提交", "status": "candidate"},
    ])
    response = parse(text)
    node = synth_node(response)
    assert node["value"] is None, "字段级补年同样受统一参照约束"
    assert node["derived"] is True


def test_deadline_only_field_invented_year_with_user_reference_kept():
    text = model_json(fields=[
        {"key": "deadline", "value": "2038-11-20T17:00:00", "raw": "11月20日提交", "status": "candidate"},
    ])
    response = parse(text, user_reference_at="2038-11-17")
    node = synth_node(response)
    assert node["value"] == "2038-11-20T17:00:00"
    assert node["derived"] is True


def test_explicit_full_date_in_raw_needs_no_reference():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "2026年11月20日17:00前", "value": "2026-11-20T17:00:00", "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-20T17:00:00"
    assert dl.derived is False
    assert dl.status.value == "candidate"


# ---------------------------------------------------------------- 统一时间合法性（非法偏移）
@pytest.mark.parametrize("bad_offset", ["+08:75", "+08:60", "+25:00", "+99:99"])
def test_node_illegal_offset_rejected(bad_offset):
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": f"2026年11月18日10:00{bad_offset}", "value": f"2026-11-18T10:00:00{bad_offset}",
         "basis": "explicit", "role": "submission_deadline"},
    ])])
    with pytest.raises(ModelError) as info:
        parse(text)
    assert info.value.kind == "invalid_output"


@pytest.mark.parametrize("bad_offset", ["+08:75", "+08:60"])
def test_deadline_field_illegal_offset_rejected(bad_offset):
    text = model_json(fields=[
        {"key": "deadline", "value": f"2026-11-18T10:00:00{bad_offset}", "raw": f"2026年11月18日10:00{bad_offset}", "status": "candidate"},
    ])
    with pytest.raises(ModelError) as info:
        parse(text)
    assert info.value.kind == "invalid_output"


def test_node_legal_leap_day_and_explicit_offset_kept():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "2028年2月29日10:00+08:00", "value": "2028-02-29T10:00:00+08:00",
         "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2028-02-29T10:00:00+08:00"
    assert dl.tz_known is True


# ---------------------------------------------------------------- 北京时间默认解释（选主）
def test_naive_and_explicit_datetime_comparable_by_beijing_instant():
    # naive 18:00 按北京解释 → 10:00 UTC；+00:00 09:00 → 09:00 UTC。后者更早，选为主且偏移保留
    text = model_json(fields=[nodes_field([
        {"label": "a", "raw": "2026年11月18日18:00", "value": "2026-11-18T18:00:00", "basis": "explicit", "role": "submission_deadline"},
        {"label": "b", "raw": "2026年11月18日09:00+00:00", "value": "2026-11-18T09:00:00+00:00", "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-18T09:00:00+00:00"
    assert dl.tz_known is True
    assert not any(w.code == "deadline_unselectable" for w in response.warnings), "naive 与明确偏移可按同一时刻比较，不再判不可比较"


def test_explicit_other_offset_not_replaced_with_beijing():
    # +09:00 的 18:00 实际 09:00 UTC，比 naive 18:00（北京 10:00 UTC）早；选主保留 +09:00 原值
    text = model_json(fields=[nodes_field([
        {"label": "a", "raw": "2026年11月18日18:00", "value": "2026-11-18T18:00:00", "basis": "explicit", "role": "submission_deadline"},
        {"label": "b", "raw": "2026年11月18日18:00+09:00", "value": "2026-11-18T18:00:00+09:00", "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-18T18:00:00+09:00", "明确偏移保留实际含义，绝不替换成 +08:00"


def test_naive_value_stays_naive_with_beijing_warning():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "2026年11月18日18:00", "value": "2026-11-18T18:00:00", "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    dl = next(f for f in response.fields if f.key == "deadline")
    assert dl.value == "2026-11-18T18:00:00", "value 忠实保留原文 naive 形状，不冒充补时区"
    assert dl.tz_known is False
    w = next(w for w in response.warnings if w.code == "timezone_unspecified")
    assert "北京" in w.message and "原文未注明时区" in w.message


# ---------------------------------------------------------------- 缺失日期不补今天
def test_missing_deadline_stays_absent_not_filled_with_today():
    text = model_json(content_type="reference", fields=[
        {"key": "title", "value": "参考资料", "raw": "参考资料", "status": "candidate"},
    ])
    response = parse(text)
    assert not any(f.key == "deadline" for f in response.fields), "无截止不拿今天兜底"


def test_missing_node_value_not_filled_with_today():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "尽快提交", "value": None, "basis": "explicit", "role": "submission_deadline"},
    ])])
    response = parse(text)
    tn = next(f for f in response.fields if f.key == "time_nodes")
    assert tn.value[0]["value"] is None
    assert not any(f.key == "deadline" and f.value for f in response.fields)


def test_missing_message_date_and_reference_not_auto_filled():
    text = model_json(fields=[nodes_field([
        {"label": "提交", "raw": "明天17:00", "value": "2026-11-18T17:00:00", "basis": "relative", "role": "submission_deadline"},
    ])])
    response = parse(text)  # 无 message_date / reference_at / 用户参照
    node = synth_node(response)
    assert node["message_date"] is None
    assert node["reference_at"] is None
    assert node["value"] is None, "无可靠参照不换算，更不拿今天兜底"
