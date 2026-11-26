"""契约 0.4.0（3B-0）：FocusSession/PlanItem 分版本校验与新旧 fixture 兼容。

v0 记录完全沿用 0.3.0 规则且新字段必须缺席；v1 要求开始快照、逐引用状态、
锚点与运行态一致、ended_at/outcome 成对。旧记录不因缺快照失效，不补造过去。
"""

from __future__ import annotations

import copy
import json

import pytest
from pydantic import ValidationError

from app._contract import FIXTURE_DIR, SCHEMA_VERSION
from contract.models import (
    ActionSnapshot,
    Fixture,
    FocusSession,
    PlanItem,
    TaskSnapshot,
)

START = "2026-11-20T09:00:00+08:00"
ANCHOR = "2026-11-20T09:25:00+08:00"
ENDED = "2026-11-20T09:40:00+08:00"

V0_MIN = {
    "id": "f", "workspace_id": "w", "task_id": "t", "action_id": "a",
    "started_at": START,
}
SNAP_T = {"title": "任务", "captured_at": START}
SNAP_A = {"text": "行动", "minutes": 25, "captured_at": START}
V1_MIN = dict(V0_MIN, record_version=1, task_snapshot=SNAP_T, action_snapshot=SNAP_A,
              task_ref_state="active", action_ref_state="active")


def test_schema_version_is_060():
    assert SCHEMA_VERSION == "0.6.0"


# ---------------------------------------------------------------- 旧记录兼容


@pytest.mark.parametrize("extra", [
    {},
    {"running": False},
    {"outcome": "partial", "ended_at": ENDED},
    {"outcome": "done", "ended_at": ENDED, "accumulated_ms": 1800000},
    {"outcome": "blocked", "blocker": "缺数据", "ended_at": ENDED},
])
def test_v0_records_stay_valid(extra):
    session = FocusSession.model_validate(dict(V0_MIN, **extra))
    assert session.record_version == 0
    assert session.task_snapshot is None and session.action_snapshot is None
    assert session.task_ref_state is None and session.action_ref_state is None


@pytest.mark.parametrize("field,value", [
    ("timer_anchor_at", ANCHOR),
    ("task_snapshot", SNAP_T),
    ("action_snapshot", SNAP_A),
    ("task_ref_state", "active"),
    ("action_ref_state", "deleted"),
])
def test_v0_rejects_v1_fields(field, value):
    with pytest.raises(ValidationError):
        FocusSession.model_validate(dict(V0_MIN, **{field: value}))


def test_v0_legacy_rules_unchanged():
    with pytest.raises(ValidationError):
        FocusSession.model_validate(dict(V0_MIN, running=True, outcome="done"))
    with pytest.raises(ValidationError):
        FocusSession.model_validate(dict(V0_MIN, outcome="blocked", blocker=None))
    with pytest.raises(ValidationError):
        FocusSession.model_validate(dict(V0_MIN, accumulated_ms=-1))


# ---------------------------------------------------------------- v1 正例


@pytest.mark.parametrize("extra", [
    {"running": True, "timer_anchor_at": ANCHOR},
    {},
    {"outcome": "done", "ended_at": ENDED},
    {"outcome": "partial", "ended_at": ENDED, "draft_md": "成果"},
    {"outcome": "blocked", "blocker": "缺数据", "ended_at": ENDED,
     "task_ref_state": "deleted", "action_ref_state": "deleted"},
    {"outcome": "partial", "ended_at": ENDED, "action_ref_state": "deleted"},
])
def test_v1_valid_shapes(extra):
    FocusSession.model_validate(dict(V1_MIN, **extra))


# ---------------------------------------------------------------- v1 负例


@pytest.mark.parametrize("mutation", [
    lambda p: p.pop("task_snapshot"),
    lambda p: p.pop("action_snapshot"),
    lambda p: p.pop("task_ref_state"),
    lambda p: p.pop("action_ref_state"),
    lambda p: p.update(running=True),
    lambda p: p.update(timer_anchor_at=ANCHOR),
    lambda p: p.update(outcome="done", ended_at=ENDED, timer_anchor_at=ANCHOR),
    lambda p: p.update(ended_at=ENDED),
    lambda p: p.update(outcome="partial"),
    lambda p: p.update(action_ref_state="deleted"),
    lambda p: p.update(task_ref_state="deleted"),
    lambda p: p.update(running=True, timer_anchor_at=ANCHOR, outcome="done"),
    lambda p: p.update(outcome="blocked", ended_at=ENDED),
])
def test_v1_invalid_shapes(mutation):
    payload = copy.deepcopy(V1_MIN)
    mutation(payload)
    with pytest.raises(ValidationError):
        FocusSession.model_validate(payload)


# ---------------------------------------------------------------- 快照值对象


def test_task_snapshot_precision_rules():
    TaskSnapshot.model_validate(dict(SNAP_T, deadline_value="2026-11-24", deadline_precision="date"))
    with pytest.raises(ValidationError):
        TaskSnapshot.model_validate(dict(SNAP_T, deadline_value="2026-11-24"))
    with pytest.raises(ValidationError):
        TaskSnapshot.model_validate(dict(SNAP_T, deadline_precision="date"))
    with pytest.raises(ValidationError):
        TaskSnapshot.model_validate(dict(SNAP_T, deadline_value="2026-11-24T23:59:00+08:00",
                                         deadline_precision="date"))


def test_action_snapshot_rules():
    ActionSnapshot.model_validate(SNAP_A)
    with pytest.raises(ValidationError):
        ActionSnapshot.model_validate(dict(SNAP_A, minutes=0))
    with pytest.raises(ValidationError):
        ActionSnapshot.model_validate(dict(SNAP_A, text="  "))


# ---------------------------------------------------------------- PlanItem 引用策略


def test_plan_item_history_may_detach():
    PlanItem.model_validate({
        "id": "p", "workspace_id": "w", "task_id": "t-gone", "date": "2026-11-17",
        "planned_minutes": 30, "action_text": "x", "state": "done",
        "actual_minutes": 28, "focus_session_id": "f", "task_ref_state": "deleted",
    })


def test_plan_item_planned_cannot_detach():
    with pytest.raises(ValidationError):
        PlanItem.model_validate({
            "id": "p", "workspace_id": "w", "task_id": "t-gone", "date": "2026-11-17",
            "planned_minutes": 30, "action_text": "x", "task_ref_state": "deleted",
        })


def test_plan_item_default_ref_state_active():
    item = PlanItem.model_validate({
        "id": "p", "workspace_id": "w", "task_id": "t", "date": "2026-11-17",
        "planned_minutes": 30, "action_text": "x",
    })
    assert item.task_ref_state.value == "active"


# ---------------------------------------------------------------- fixture 兼容


def test_all_fixtures_validate_including_new_ones():
    files = sorted(p for p in FIXTURE_DIR.glob("*.json") if p.name != "index.json")
    assert len(files) == 10
    loaded = [Fixture.model_validate(json.loads(p.read_text(encoding="utf-8"))) for p in files]
    by_id = {f.id: f for f in loaded}
    assert by_id["05-task-and-focus"].focus_session.record_version == 0
    assert by_id["10-focus-legacy-ended-v0"].focus_session.record_version == 0
    assert by_id["10-focus-legacy-ended-v0"].focus_session.ended_at is not None
    assert by_id["06-focus-v1-running"].focus_session.timer_anchor_at is not None
    ended = by_id["07-focus-v1-ended-done"].focus_session
    assert ended.outcome.value == "done" and ended.timer_anchor_at is None
    partial = by_id["08-focus-v1-action-deleted"].focus_session
    assert partial.task_ref_state.value == "active" and partial.action_ref_state.value == "deleted"
    gone = by_id["09-focus-v1-task-deleted"].focus_session
    assert gone.task_ref_state.value == "deleted" and gone.action_ref_state.value == "deleted"
    assert by_id["09-focus-v1-task-deleted"].task is None


def test_fixture_cross_invariants_pass():
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "contract"))
    from generate import check_fixtures, load_fixtures
    assert check_fixtures(load_fixtures()) == 0


def test_old_ended_fixture_not_rewritten_to_v1():
    raw = json.loads((FIXTURE_DIR / "10-focus-legacy-ended-v0.json").read_text(encoding="utf-8"))
    session = raw["focus_session"]
    for field in ("record_version", "timer_anchor_at", "task_snapshot", "action_snapshot",
                  "task_ref_state", "action_ref_state"):
        assert field not in session


# ---------------------------------------------------------------- 复审 C2：事件时间真实性


@pytest.mark.parametrize("field,value", [
    ("timer_anchor_at", "not-a-date"),
    ("timer_anchor_at", "2026-02-30T25:90:00+99:99"),
    ("timer_anchor_at", "2026-11-20T09:25:00+08:75"),
    ("timer_anchor_at", "2026-11-20T09:25:00+25:00"),
    ("started_at", "not-a-date"),
    ("started_at", "2026-02-30T09:00:00+08:00"),
])
def test_v1_rejects_invalid_event_times(field, value):
    payload = dict(V1_MIN, running=True, timer_anchor_at=ANCHOR)
    payload[field] = value
    with pytest.raises(ValidationError):
        FocusSession.model_validate(payload)


@pytest.mark.parametrize("ended_at", ["not-a-date", "2026-02-30T10:00:00+08:00",
                                      "2026-11-20T09:40:00+08:75"])
def test_v1_rejects_invalid_ended_at(ended_at):
    with pytest.raises(ValidationError):
        FocusSession.model_validate(dict(V1_MIN, outcome="done", ended_at=ended_at))


@pytest.mark.parametrize("anchor", [
    "2028-02-29T09:25:00+08:00",
    "2026-11-20T09:25:00+05:30",
    "2026-11-20T01:25:00Z",
    "2026-11-20T09:25+08:00",
    "2026-11-20T09:25:00.500+08:00",
])
def test_v1_accepts_legal_calendar_and_offsets(anchor):
    FocusSession.model_validate(dict(V1_MIN, running=True, timer_anchor_at=anchor))


def test_v0_time_fields_keep_030_boundary():
    # 0.3.0 未校验 v0 时间字段格式；不追溯收紧，旧合法数据不失效
    FocusSession.model_validate(dict(V0_MIN, started_at="2026-11-17 晚上"))
    FocusSession.model_validate(dict(V0_MIN, outcome="partial", ended_at="unknown"))


@pytest.mark.parametrize("payload", [
    dict(SNAP_T, captured_at="not-a-date"),
    dict(SNAP_T, deadline_precision="date", deadline_value="2026-02-30"),
    dict(SNAP_T, deadline_precision="date", deadline_value="2026-13-01"),
    dict(SNAP_T, deadline_precision="datetime", deadline_value="2026-11-24T18:00:00+08:75"),
    dict(SNAP_T, deadline_precision="datetime", deadline_value="2026-02-30T18:00:00+08:00"),
])
def test_task_snapshot_rejects_invalid_times(payload):
    with pytest.raises(ValidationError):
        TaskSnapshot.model_validate(payload)


def test_task_snapshot_accepts_leap_day_and_offsets():
    TaskSnapshot.model_validate(dict(SNAP_T, deadline_precision="date", deadline_value="2028-02-29"))
    TaskSnapshot.model_validate(dict(SNAP_T, deadline_precision="datetime",
                                     deadline_value="2026-11-24T18:00:00+05:30"))
    TaskSnapshot.model_validate(dict(SNAP_T, captured_at="2026-11-20T01:00:00Z"))


def test_action_snapshot_rejects_invalid_captured_at():
    with pytest.raises(ValidationError):
        ActionSnapshot.model_validate(dict(SNAP_A, captured_at="not-a-date"))
    with pytest.raises(ValidationError):
        ActionSnapshot.model_validate(dict(SNAP_A, captured_at="2026-02-30T09:00:00+08:00"))


# ---------------------------------------------------------------- 复审 C1：跨记录归属


def _raw_fixtures():
    files = sorted(p for p in FIXTURE_DIR.glob("*.json") if p.name != "index.json")
    return [json.loads(p.read_text(encoding="utf-8")) for p in files]


def _check_raw(raw, capsys):
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "contract"))
    # 必须用 generate 同源的 models 模块校验：RefState 跨模块实例 `is` 比较会失效
    import models as contract_source
    from generate import check_fixtures
    code = check_fixtures([contract_source.Fixture.model_validate(f) for f in raw])
    capsys.readouterr()
    return code


@pytest.mark.parametrize("fixture_id,path,value", [
    # 复审反例 5：运行会话跨工作区，任务/行动不动
    ("06-focus-v1-running", ("focus_session", "workspace_id"), "another-workspace"),
    # 复审反例 6：引用别的任务的行动（05 的 action-01）
    ("06-focus-v1-running", ("focus_session", "action_id"), "action-01"),
    # 复审反例 7：计划快捷引用指向无关已结束会话（10 的 focus-legacy）
    ("07-focus-v1-ended-done", ("plan_items", 0, "focus_session_id"), "focus-legacy"),
    # 快捷会话必须反向关联本条目
    ("07-focus-v1-ended-done", ("focus_session", "plan_item_id"), None),
    # focus.plan_item_id 必须同任务同空间
    ("05-task-and-focus", ("focus_session", "plan_item_id"), "plan-v1e"),
    # action 与所属 task 必须同工作区
    ("06-focus-v1-running", ("action", "workspace_id"), "another-workspace"),
])
def test_cross_record_ownership_rejected(fixture_id, path, value, capsys):
    raw = _raw_fixtures()
    target = next(f for f in raw if f["id"] == fixture_id)
    node = target
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    assert _check_raw(raw, capsys) == 1


def test_unmutated_fixtures_still_pass(capsys):
    assert _check_raw(_raw_fixtures(), capsys) == 0


def test_fixture_07_shortcut_is_mutually_linked():
    raw = next(f for f in _raw_fixtures() if f["id"] == "07-focus-v1-ended-done")
    assert raw["focus_session"]["plan_item_id"] == "plan-v1e"
    assert raw["plan_items"][0]["focus_session_id"] == "focus-v1e"