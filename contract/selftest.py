"""契约守卫的负向自测：证明 validator 真的会拒绝违规数据，而不是恒真。

    python contract/selftest.py
"""

from __future__ import annotations

import contextlib
import copy
import io
import json

from pydantic import ValidationError

from generate import FIXTURE_DIR, check_fixtures, load_fixtures
from models import (
    Action,
    ActionSnapshot,
    AnalyzeResponse,
    ApplicationEnvelope,
    ApplicationReceipt,
    AssistantDraft,
    BackupManifestV2,
    ChangeProposal,
    Deadline,
    DeadlineCandidate,
    Field,
    FocusSession,
    PlanItem,
    PlannedCancellation,
    PlanningInput,
    ProgressInput,
    ReplacementBaseline,
    ReplanScope,
    SuggestActionRequest,
    SuggestActionResponse,
    TaskSnapshot,
    TimeNode,
    UserConfirmation,
)

FAILURES: list[str] = []


def expect_reject(label: str, model, payload: dict) -> None:
    try:
        model.model_validate(payload)
    except ValidationError:
        print(f"  [拒绝] {label}")
        return
    FAILURES.append(f"{label}：违规数据竟然通过了 {model.__name__}")
    print(f"  [漏网] {label}")


def expect_accept(label: str, model, payload: dict) -> None:
    try:
        model.model_validate(payload)
    except ValidationError as exc:
        FAILURES.append(f"{label}：合法数据被 {model.__name__} 误拒（{exc.errors()[0]['msg']}）")
        print(f"  [误拒] {label}")
        return
    print(f"  [放行] {label}")


def expect_cross_fixture_reject(label: str, fixtures) -> None:
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = check_fixtures(fixtures)
    if code == 1:
        print(f"  [拒绝] {label}")
        return
    FAILURES.append(f"{label}：跨 fixture 不变量没有拦住")
    print(f"  [漏网] {label}")


def main() -> int:
    base = json.loads((FIXTURE_DIR / "01-course-assignment.json").read_text(encoding="utf-8"))
    field = copy.deepcopy(base["expected_analysis"]["fields"][0])
    quote = {"text": "原文", "source_id": "src-01"}

    print("模型级守卫：")

    bad = dict(field, status="confirmed")
    expect_reject("AI 返回 confirmed 字段（规则 3）", AnalyzeResponse,
                  dict(base["expected_analysis"], fields=[bad]))

    bad = dict(field, status="missing", value="不该有的值")
    expect_reject("missing 字段带 value（F02 不补造）", Field, bad)

    bad = dict(field, status="unresolved", raw="", derived=False, quote=None)
    expect_reject("unresolved 既无原文也非推算（规则 7）", Field, bad)

    bad = dict(field, status="candidate", raw="有原文", quote=None)
    expect_reject("candidate 有原文却无 quote（规则 4）", Field, bad)

    expect_reject("截止时间无出处便签（决策项 5）", Deadline,
                  {"value": "2026-11-19", "precision": "date"})

    expect_reject("date 精度却带时刻（F07 不补 23:59）", Deadline,
                  {"value": "2026-11-19T23:59", "precision": "date", "from_note_id": "note-01"})

    expect_reject("precision=none 却有值", Deadline,
                  {"value": "2026-11-19", "precision": "none"})

    expect_reject("运行中会话已有 outcome", FocusSession, {
        "id": "f", "workspace_id": "w", "task_id": "t", "action_id": "a",
        "started_at": "2026-11-17T19:00:00+08:00", "running": True, "outcome": "done",
    })

    expect_reject("卡住却没记卡点（F10）", FocusSession, {
        "id": "f", "workspace_id": "w", "task_id": "t", "action_id": "a",
        "started_at": "2026-11-17T19:00:00+08:00", "running": False,
        "outcome": "blocked", "blocker": None,
    })

    expect_reject("accumulated_ms 为负", FocusSession, {
        "id": "f", "workspace_id": "w", "task_id": "t", "action_id": "a",
        "started_at": "2026-11-17T19:00:00+08:00", "accumulated_ms": -1,
    })

    expect_reject("关联专注却无实际用时（规则 12）", PlanItem, {
        "id": "p", "workspace_id": "w", "task_id": "t", "date": "2026-11-17",
        "planned_minutes": 30, "action_text": "x", "focus_session_id": "f",
        "actual_minutes": None,
    })

    expect_reject("计划条目排到时间槽（F13 只按天）", PlanItem, {
        "id": "p", "workspace_id": "w", "task_id": "t", "date": "2026-11-17T14:00",
        "planned_minutes": 30, "action_text": "x",
    })

    print("v0.4 分版本守卫（3B-0）：")
    v0_min = {
        "id": "f", "workspace_id": "w", "task_id": "t", "action_id": "a",
        "started_at": "2026-11-17T19:00:00+08:00",
    }
    snap_t = {"title": "任务", "captured_at": "2026-11-20T09:00:00+08:00"}
    snap_a = {"text": "行动", "minutes": 25, "captured_at": "2026-11-20T09:00:00+08:00"}
    v1_min = dict(v0_min, record_version=1, task_snapshot=snap_t, action_snapshot=snap_a,
                  task_ref_state="active", action_ref_state="active")
    anchor = "2026-11-20T09:25:00+08:00"
    ended = "2026-11-20T09:40:00+08:00"

    expect_accept("v0 旧暂停记录（0.3.0 形态）仍合法", FocusSession, dict(v0_min, running=False))
    expect_accept("v0 旧已结束记录无快照仍合法（不补造过去）", FocusSession,
                  dict(v0_min, outcome="partial", ended_at=ended))
    expect_accept("v1 运行中（锚点+快照+活引用）", FocusSession,
                  dict(v1_min, running=True, timer_anchor_at=anchor))
    expect_accept("v1 暂停（锚点空、快照在）", FocusSession, v1_min)
    expect_accept("v1 已结束（成对字段、锚点空）", FocusSession,
                  dict(v1_min, outcome="done", ended_at=ended))
    expect_accept("v1 已结束且两引用 deleted（历史标识）", FocusSession,
                  dict(v1_min, outcome="blocked", blocker="缺数据", ended_at=ended,
                       task_ref_state="deleted", action_ref_state="deleted"))

    expect_reject("v0 携带快照（混版）", FocusSession, dict(v0_min, task_snapshot=snap_t))
    expect_reject("v0 携带引用状态（混版）", FocusSession, dict(v0_min, task_ref_state="active"))
    expect_reject("v0 携带锚点（混版）", FocusSession, dict(v0_min, timer_anchor_at=anchor))
    expect_reject("v1 缺任务快照", FocusSession, {k: v for k, v in v1_min.items() if k != "task_snapshot"})
    expect_reject("v1 缺行动快照", FocusSession, {k: v for k, v in v1_min.items() if k != "action_snapshot"})
    expect_reject("v1 缺引用状态", FocusSession, {k: v for k, v in v1_min.items() if k != "task_ref_state"})
    expect_reject("v1 运行中缺锚点", FocusSession, dict(v1_min, running=True))
    expect_reject("v1 暂停却带锚点", FocusSession, dict(v1_min, timer_anchor_at=anchor))
    expect_reject("v1 已结束却带锚点", FocusSession,
                  dict(v1_min, outcome="done", ended_at=ended, timer_anchor_at=anchor))
    expect_reject("v1 只有 ended_at 没有 outcome", FocusSession, dict(v1_min, ended_at=ended))
    expect_reject("v1 只有 outcome 没有 ended_at", FocusSession, dict(v1_min, outcome="partial"))
    expect_reject("v1 未结束却断开行动引用", FocusSession, dict(v1_min, action_ref_state="deleted"))
    expect_reject("v1 暂停却断开任务引用", FocusSession, dict(v1_min, task_ref_state="deleted"))

    expect_reject("任务快照 precision=none 却有值", TaskSnapshot,
                  dict(snap_t, deadline_value="2026-11-24"))
    expect_reject("任务快照 date 精度却带时刻", TaskSnapshot,
                  dict(snap_t, deadline_value="2026-11-24T23:59:00+08:00", deadline_precision="date"))
    expect_reject("任务快照有精度却无值", TaskSnapshot, dict(snap_t, deadline_precision="date"))
    expect_reject("行动快照分钟非正", ActionSnapshot, dict(snap_a, minutes=0))
    expect_reject("行动快照文本为空", ActionSnapshot, dict(snap_a, text="  "))

    print("v0.4 复审 C2：事件时间真实日历/时刻/偏移：")
    expect_reject("v1 锚点不是日期（复审反例 1）", FocusSession,
                  dict(v1_min, running=True, timer_anchor_at="not-a-date"))
    expect_reject("v1 锚点非法日历+时刻+偏移（复审反例 2）", FocusSession,
                  dict(v1_min, running=True, timer_anchor_at="2026-02-30T25:90:00+99:99"))
    expect_reject("v1 锚点非法分钟偏移 +08:75（fromisoformat 会静默接受）", FocusSession,
                  dict(v1_min, running=True, timer_anchor_at="2026-11-20T09:25:00+08:75"))
    expect_reject("v1 started_at 不是日期", FocusSession, dict(v1_min, started_at="not-a-date"))
    expect_reject("v1 ended_at 非法日历日期", FocusSession,
                  dict(v1_min, outcome="done", ended_at="2026-02-30T10:00:00+08:00"))
    expect_reject("任务快照 captured_at 不是日期（复审反例 3）", TaskSnapshot,
                  dict(snap_t, captured_at="not-a-date"))
    expect_reject("任务快照截止非法日历日期（复审反例 4）", TaskSnapshot,
                  dict(snap_t, deadline_precision="date", deadline_value="2026-02-30"))
    expect_reject("任务快照 datetime 截止非法偏移", TaskSnapshot,
                  dict(snap_t, deadline_precision="datetime", deadline_value="2026-11-24T18:00:00+08:75"))
    expect_reject("行动快照 captured_at 不是日期", ActionSnapshot, dict(snap_a, captured_at="not-a-date"))
    expect_accept("v1 锚点合法闰日", FocusSession,
                  dict(v1_min, running=True, timer_anchor_at="2028-02-29T09:25:00+08:00"))
    expect_accept("v1 锚点合法半小时偏移 +05:30", FocusSession,
                  dict(v1_min, running=True, timer_anchor_at="2026-11-20T09:25:00+05:30"))
    expect_accept("v1 锚点合法 Z 偏移", FocusSession,
                  dict(v1_min, running=True, timer_anchor_at="2026-11-20T01:25:00Z"))
    expect_accept("v1 锚点合法 HH:MM 形状", FocusSession,
                  dict(v1_min, running=True, timer_anchor_at="2026-11-20T09:25+08:00"))
    expect_accept("任务快照截止合法闰日", TaskSnapshot,
                  dict(snap_t, deadline_precision="date", deadline_value="2028-02-29"))
    expect_accept("v0 旧记录时间字段保持 0.3.0 边界（不追溯收紧）", FocusSession,
                  dict(v0_min, started_at="2026-11-17 晚上"))

    expect_accept("历史计划条目允许任务已删（done+deleted）", PlanItem, {
        "id": "p", "workspace_id": "w", "task_id": "t-gone", "date": "2026-11-17",
        "planned_minutes": 30, "action_text": "x", "state": "done",
        "actual_minutes": 28, "focus_session_id": "f", "task_ref_state": "deleted",
    })
    expect_reject("未执行计划指向已删任务（planned+deleted）", PlanItem, {
        "id": "p", "workspace_id": "w", "task_id": "t-gone", "date": "2026-11-17",
        "planned_minutes": 30, "action_text": "x", "task_ref_state": "deleted",
    })

    expect_reject("无变化也生成变更候选（F06）", ChangeProposal, {
        "id": "c", "workspace_id": "w", "task_id": "t", "old_note_id": "n1",
        "new_note_id": "n2", "old_value": "2026-11-19", "new_value": "2026-11-19",
        "evidence": [quote], "created_at": "2026-11-17T18:05:00+08:00",
    })

    expect_reject("变更候选无证据", ChangeProposal, {
        "id": "c", "workspace_id": "w", "task_id": "t", "old_note_id": "n1",
        "new_note_id": "n2", "old_value": "2026-11-19", "new_value": "2026-11-21",
        "evidence": [], "created_at": "2026-11-17T18:05:00+08:00",
    })

    expect_reject("声称原文要求却无证据（F09 第 314 行）", SuggestActionResponse,
                  {"text": "先列提纲", "minutes": 30, "basis": "requirement", "evidence": None})

    expect_reject("把未确认字段喂给行动建议（规则 3）", SuggestActionRequest, {
        "task_id": "t", "title": "x", "available_minutes": 30,
        "confirmed_fields": [dict(field, status="candidate")],
    })

    good = base["expected_analysis"]
    expect_reject("v0.2 自创键 presentation_date", AnalyzeResponse,
                  dict(good, fields=[dict(good["fields"][0], key="presentation_date")]))
    expect_reject("v0.2 title 给数组（单值键）", AnalyzeResponse,
                  dict(good, fields=[dict(good["fields"][0], value=["a", "b"])]))
    expect_reject("v0.2 deadline 拼接多个截止节点", AnalyzeResponse,
                  dict(good, fields=[dict(good["fields"][2],
                       value="2026-11-17T12:00:00+08:00 (登记); 2026-11-20T18:00:00+08:00 (测验)")]))
    expect_reject("v0.2 derived 却标 candidate", AnalyzeResponse,
                  dict(good, fields=[dict(good["fields"][2], derived=True)]))
    expect_reject("derived 确认仍须非空值（D5，确认 null 绕过任务入口）", Field,
                  dict(field, status="confirmed", derived=True, origin="model", value=None))
    expect_reject("手动截止非法日历日期（2月30）", Deadline,
                  {"value": "2026-02-30", "precision": "date", "source": "manual",
                   "confirmed_at": "2026-11-18T09:00:00+08:00"})
    expect_reject("节点谎称保存日为参照来源（captured 不在枚举）", TimeNode,
                  {"label": "x", "raw": "明天", "value": "2026-11-18", "basis": "relative",
                   "derived": True, "reference_at": "2026-11-17", "reference_source": "captured"})
    expect_reject("v0.2 candidate 无值（契约级）", AnalyzeResponse,
                  dict(good, fields=[dict(good["fields"][0], value=None)]))
    expect_reject("v0.2 submit_to 给数组（单值键）", AnalyzeResponse,
                  dict(good, fields=[dict(good["fields"][4], value=["a", "b"])]))

    print("跨 fixture 不变量：")
    fixtures = load_fixtures()

    mutated = []
    for f in fixtures:
        if f.id == "05-task-and-focus" and f.task:
            new_deadline = Deadline(value="2026-11-21", precision="date",
                                    from_note_id="note-01",
                                    confirmed_at="2026-11-17T09:20:00+08:00")
            mutated.append(f.model_copy(update={"task": f.task.model_copy(update={"deadline": new_deadline})}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("候选未确认却已改写任务截止时间（F06 / 规则 3）", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "05-task-and-focus" and f.focus_session:
            mutated.append(f.model_copy(update={
                "focus_session": f.focus_session.model_copy(update={"running": True})}))
        elif f.id == "01-course-assignment":
            extra = FocusSession(id="focus-02", workspace_id="demo-ml-report", task_id="task-ml",
                                 action_id="action-01", started_at="2026-11-17T20:00:00+08:00",
                                 running=True)
            mutated.append(f.model_copy(update={"focus_session": extra}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("同时存在两个运行中专注会话（规则 8）", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "08-focus-v1-action-deleted":
            extra = Action(id="action-v1d-gone", workspace_id="demo-focus-v1d", task_id="task-v1d",
                           text="列讲稿大纲", minutes=20, created_at="2026-11-19T15:50:00+08:00")
            mutated.append(f.model_copy(update={"action": extra}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("deleted 引用仍解析到存在对象（假删除数据）", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "07-focus-v1-ended-done":
            items = [p.model_copy(update={"focus_session_id": "focus-v1r"}) for p in f.plan_items]
            mutated.append(f.model_copy(update={"plan_items": items}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("计划快捷引用指向运行中会话（只能指向已结束）", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "01-course-assignment":
            extra = FocusSession(id="focus-extra", workspace_id="demo-focus-v1", task_id="task-v1r",
                                 action_id="action-v1r", started_at="2026-11-20T10:00:00+08:00",
                                 running=False)
            mutated.append(f.model_copy(update={"focus_session": extra}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("同一工作区两份未结束会话（含暂停，3B 规则）", mutated)

    print("v0.4 复审 C1：跨记录归属（同工作区/同任务/计划反向关联）：")
    mutated = []
    for f in fixtures:
        if f.id == "06-focus-v1-running" and f.focus_session:
            mutated.append(f.model_copy(update={
                "focus_session": f.focus_session.model_copy(update={"workspace_id": "another-workspace"})}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("运行会话跨工作区引用任务/行动（复审反例 5）", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "06-focus-v1-running" and f.focus_session:
            mutated.append(f.model_copy(update={
                "focus_session": f.focus_session.model_copy(update={"action_id": "action-01"})}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("会话引用别的任务的行动（复审反例 6）", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "07-focus-v1-ended-done":
            items = [p.model_copy(update={"focus_session_id": "focus-legacy"}) for p in f.plan_items]
            mutated.append(f.model_copy(update={"plan_items": items}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("计划快捷引用指向无关已结束会话（复审反例 7）", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "07-focus-v1-ended-done" and f.focus_session:
            mutated.append(f.model_copy(update={
                "focus_session": f.focus_session.model_copy(update={"plan_item_id": None})}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("计划快捷会话未反向关联本条目（focus.plan_item_id 断开）", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "05-task-and-focus" and f.focus_session:
            mutated.append(f.model_copy(update={
                "focus_session": f.focus_session.model_copy(update={"plan_item_id": "plan-v1e"})}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("focus.plan_item_id 指向别的任务的计划条目", mutated)

    mutated = []
    for f in fixtures:
        if f.id == "06-focus-v1-running" and f.action:
            mutated.append(f.model_copy(update={
                "action": f.action.model_copy(update={"workspace_id": "another-workspace"})}))
        else:
            mutated.append(f)
    expect_cross_fixture_reject("action 与所属 task 不在同一工作区", mutated)

    print("time_nodes 机器关联（运行时 + 生成 schema 双重）：")
    expect_reject("time_nodes 的 value 不是数组", Field,
                  {"key": "time_nodes", "value": "不是数组", "status": "candidate"})
    expect_reject("time_nodes 节点 role 非法", Field,
                  {"key": "time_nodes", "value": [{"value": "2026-11-20", "role": "不是角色"}], "status": "candidate"})
    expect_reject("time_nodes 节点日历非法（2026-13-99）", Field,
                  {"key": "time_nodes", "value": [{"value": "2026-13-99"}], "status": "candidate"})
    expect_reject("time_node 非法 UTC 偏移 +99:99", TimeNode,
                  {"value": "2026-11-20T17:00:00+99:99", "derived": True, "basis": "relative"})

    from jsonschema import Draft202012Validator
    schema = json.loads((FIXTURE_DIR.parent / "contract" / "schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator({"$ref": "#/$defs/Field", "$defs": schema["$defs"]})
    if "if" not in schema["$defs"]["Field"] or "then" not in schema["$defs"]["Field"]:
        FAILURES.append("schema.json 的 Field 缺少 key=time_nodes → TimeNode[] 的 if/then 机器关联")
        print("  [漏网] Field if/then 机器关联缺失")
    else:
        print("  [存在] Field if/then 机器关联")

    def expect_schema_reject(label: str, payload: dict) -> None:
        if not validator.is_valid(payload):
            print(f"  [拒绝] {label}")
        else:
            FAILURES.append(f"{label}：生成 schema 竟然放行")
            print(f"  [漏网] {label}")

    expect_schema_reject("schema：time_nodes value 是字符串", {"key": "time_nodes", "value": "不是数组"})
    expect_schema_reject("schema：time_nodes 节点 role 非法",
                         {"key": "time_nodes", "value": [{"value": "2026-11-20", "role": "不是角色"}]})
    expect_schema_reject("schema：time_nodes 节点 basis 非法",
                         {"key": "time_nodes", "value": [{"value": "2026-11-20", "basis": "absolute"}]})
    good_nodes = {"key": "time_nodes", "value": [{"label": "x", "raw": "r", "value": "2026-11-20", "role": "unknown"}]}
    if validator.is_valid(good_nodes) and validator.is_valid({"key": "time_nodes", "value": None}) \
            and validator.is_valid({"key": "title", "value": "任意字符串"}):
        print("  [放行] 合法节点数组 / null / 其他键不受影响")
    else:
        FAILURES.append("schema 机器关联误伤合法数据")
        print("  [漏网] 合法数据被误拒")

    print("v0.5 助手持久类型守卫（5B-1B 归位，C1/C2 口径不放宽）：")
    ts = "2026-11-24T09:00:00+08:00"
    uc_task = {"confirmation_id": "c1", "draft_revision": 1, "object_type": "task",
               "object_id_or_key": "t-new", "id_scope": "draft", "confirmed_at": ts}
    expect_accept("task 确认显式 id_scope=draft", UserConfirmation, uc_task)
    expect_accept("task 确认显式 id_scope=formal", UserConfirmation, dict(uc_task, id_scope="formal"))
    expect_reject("task 确认缺 id_scope（C1）", UserConfirmation,
                  {k: v for k, v in uc_task.items() if k != "id_scope"})
    expect_reject("非 task 确认携带 id_scope（C1）", UserConfirmation,
                  {"confirmation_id": "c2", "draft_revision": 1, "object_type": "requirement",
                   "object_id_or_key": "r1", "id_scope": "draft", "confirmed_at": ts})
    uc_dl = dict(uc_task, field_path="deadline",
                 old_value=None, new_value={"value": "2026-11-25", "precision": "date"})
    expect_accept("deadline 确认显式 null 旧值 + 投影新值（C2）", UserConfirmation, uc_dl)
    expect_accept("deadline 确认双显式 null（明确无截止）", UserConfirmation,
                  dict(uc_task, field_path="deadline", old_value=None, new_value=None))
    expect_reject("deadline 确认缺 old_value（C2 缺失≠null）", UserConfirmation,
                  {k: v for k, v in uc_dl.items() if k != "old_value"})
    expect_reject("deadline 确认缺 new_value（C2）", UserConfirmation,
                  {k: v for k, v in uc_dl.items() if k != "new_value"})
    expect_reject("deadline 确认新值不是投影（C2）", UserConfirmation,
                  dict(uc_dl, new_value={"value": "2026-11-25", "precision": "date", "extra": 1}))
    expect_reject("deadline 确认非法日历日期", UserConfirmation,
                  dict(uc_dl, new_value={"value": "2026-02-30", "precision": "date"}))
    expect_accept("deadline 确认旧值允许无秒 datetime（不缩窄 0.4.0 可读集合）", UserConfirmation,
                  dict(uc_dl, old_value={"value": "2026-11-20T18:00", "precision": "datetime"}))

    ev = [{"kind": "user_message", "turn_id": "m1", "excerpt": "周五前交"}]
    expect_accept("date 截止候选带证据", DeadlineCandidate,
                  {"value": "2026-11-25", "precision": "date", "evidence_refs": ev})
    expect_reject("新候选 datetime 无秒（比旧事实严）", DeadlineCandidate,
                  {"value": "2026-11-25T18:00", "precision": "datetime", "evidence_refs": ev})
    expect_reject("relative 候选未标 derived", DeadlineCandidate,
                  {"value": "2026-11-25", "precision": "date", "basis": "relative", "evidence_refs": ev})
    expect_reject("有值候选无证据", DeadlineCandidate,
                  {"value": "2026-11-25", "precision": "date"})

    draft_min = {"id": "d1", "workspace_id": "w", "thread_id": "th1", "revision": 2,
                 "created_at": ts, "updated_at": ts}
    expect_accept("最小编辑草案", AssistantDraft, dict(draft_min, revision=1))
    expect_reject("历史版本不小于当前 revision", AssistantDraft,
                  dict(draft_min, revision_history=[{"revision": 2, "created_at": ts}]))
    expect_reject("历史版本重复", AssistantDraft,
                  dict(draft_min, revision_history=[{"revision": 1, "created_at": ts},
                                                    {"revision": 1, "created_at": ts}]))
    expect_reject("revision 超 20", AssistantDraft, dict(draft_min, revision=21))
    expect_reject("applied 缺 applied_summary", AssistantDraft, dict(draft_min, status="applied"))
    expect_reject("非 applied 携带 applied_summary", AssistantDraft,
                  dict(draft_min, applied_summary={
                      "application_id": "app1",
                      "counts": {"tasks_created": 0, "tasks_updated": 0, "actions_created": 0,
                                 "plan_items_created": 0, "source_fields_confirmed": 0},
                      "applied_at": ts}))

    # ---- M3 改排：范围/进展/基线/取消写集/回执的负向守卫 ----
    scope_ok = {"task_id": "t1", "start_date": "2026-11-25", "replacement_ids": ["pi1", "pi2"]}
    expect_accept("改排范围最小合法", ReplanScope, scope_ok)
    expect_reject("改排范围空替换集", ReplanScope, dict(scope_ok, replacement_ids=[]))
    expect_reject("改排范围替换集重复", ReplanScope, dict(scope_ok, replacement_ids=["pi1", "pi1"]))
    prog_ok = {"statement": "资料读完了", "work_items": [{"key": "pw1", "text": "写报告结论", "minutes": 90}]}
    expect_accept("进展清单最小合法", ProgressInput, prog_ok)
    expect_reject("进展清单分钟数为 0", ProgressInput,
                  {"work_items": [{"key": "pw1", "text": "写报告", "minutes": 0}]})
    expect_reject("进展清单 key 重复", ProgressInput,
                  {"work_items": [{"key": "pw1", "text": "a"}, {"key": "pw1", "text": "b"}]})
    expect_reject("进展清单为空", ProgressInput, {"work_items": []})

    days7 = [{"date": d, "budget_minutes": 120} for d in
             ("2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01")]
    pi_min = {"start_date": "2026-11-25", "days": days7}
    expect_accept("排程输入带替换集（有效占用已排除）", PlanningInput, dict(pi_min, replacement_ids=["pi1"]))
    expect_reject("排程输入替换集重复", PlanningInput, dict(pi_min, replacement_ids=["pi1", "pi1"]))
    expect_reject("有效占用仍含替换项（二次扣减风险）", PlanningInput,
                  dict(pi_min, replacement_ids=["pi1"],
                       occupancy=[{"plan_item_id": "pi1", "task_id": "t1", "date": "2026-11-25",
                                   "planned_minutes": 60, "state": "planned"}]))

    expect_reject("create 草案携带改排范围", AssistantDraft, dict(draft_min, revision=1, replan_scope=scope_ok))
    expect_reject("replan 草案缺范围与进展", AssistantDraft, dict(draft_min, revision=1, mode="replan"))
    expect_accept("replan 草案最小合法", AssistantDraft,
                  dict(draft_min, revision=1, mode="replan", replan_scope=scope_ok, progress_input=prog_ok))
    expect_reject("replan 草案替换集与排程输入不一致", AssistantDraft,
                  dict(draft_min, revision=1, mode="replan", replan_scope=scope_ok, progress_input=prog_ok,
                       planning_input=dict(pi_min, replacement_ids=["pi9"])))

    snap_ok = {"plan_item_id": "pi1", "task_id": "t1", "date": "2026-11-25",
               "planned_minutes": 60, "action_text": "读资料", "order": 1}
    expect_accept("旧安排完整快照最小合法", PlannedCancellation, {"plan_item_id": "pi1", "expected": snap_ok})
    expect_reject("取消项与预期快照 ID 不一致", PlannedCancellation, {"plan_item_id": "pi2", "expected": snap_ok})
    expect_reject("快照携带执行投入", PlannedCancellation,
                  {"plan_item_id": "pi1", "expected": dict(snap_ok, actual_minutes=0)})
    expect_reject("替换基线条目重复", ReplacementBaseline,
                  {"captured_at": ts, "items": [snap_ok, snap_ok]})

    counts0 = {"tasks_created": 0, "tasks_updated": 0, "actions_created": 0,
               "plan_items_created": 0, "source_fields_confirmed": 0}
    receipt_min = {"application_id": "app1", "draft_id": "d1", "draft_revision": 1,
                   "input_signature": "0" * 64, "counts": counts0, "committed_at": ts}
    expect_accept("create 回执缺省无取消", ApplicationReceipt, receipt_min)
    expect_reject("回执取消数量与计数不一致", ApplicationReceipt,
                  dict(receipt_min, cancelled_plan_item_ids=["pi1"], replan_task_id="t1"))
    expect_reject("回执取消集缺目标任务引用", ApplicationReceipt,
                  dict(receipt_min, counts=dict(counts0, plan_items_cancelled=1),
                       cancelled_plan_item_ids=["pi1"]))

    cap7 = [{"date": d["date"], "budget_minutes": 120, "buffer_minutes": 18,
             "committed_minutes": 0, "allocated_minutes": 0, "free_minutes": 102,
             "overbooked_minutes": 0} for d in days7]
    env_min = {"application_id": "app1", "workspace_id": "w", "draft_id": "d1", "draft_revision": 1,
               "input_signature": "0" * 64, "write_set": {},
               "fact_baseline": {"captured_at": ts}, "capacity_baseline": cap7, "issued_at": ts}
    expect_accept("create 信封缺省无取消", ApplicationEnvelope, env_min)
    expect_reject("create 信封夹带取消写集", ApplicationEnvelope,
                  dict(env_min, write_set={"plan_items_cancel": [{"plan_item_id": "pi1", "expected": snap_ok}]}))
    expect_reject("create 信封携带改排范围", ApplicationEnvelope, dict(env_min, replan_scope=scope_ok))
    env_replan = dict(env_min, mode="replan", replan_scope=scope_ok,
                      replacement_baseline={"captured_at": ts, "items": [snap_ok, dict(snap_ok, plan_item_id="pi2")]},
                      write_set={
                          "plan_items_create": [{"formal_id": "n1", "workspace_id": "w", "task_id": "t1",
                                                 "date": "2026-11-25", "planned_minutes": 90,
                                                 "action_text": "写报告结论", "order": 2}],
                          "plan_items_cancel": [{"plan_item_id": "pi1", "expected": snap_ok},
                                                {"plan_item_id": "pi2", "expected": dict(snap_ok, plan_item_id="pi2")}]})
    expect_accept("replan 信封取消集与选择相等", ApplicationEnvelope, env_replan)
    expect_reject("replan 信封取消集小于用户选择", ApplicationEnvelope,
                  dict(env_replan, write_set=dict(env_replan["write_set"],
                       plan_items_cancel=[{"plan_item_id": "pi1", "expected": snap_ok}])))
    expect_reject("replan 信封新安排为零（整批清空）", ApplicationEnvelope,
                  dict(env_replan, write_set={"plan_items_cancel": env_replan["write_set"]["plan_items_cancel"]}))

    sig = "0" * 64
    p4 = [{"path": p, "bytes": 10, "sha256": sig} for p in
          ("data/sources.json", "data/docs.json", "data/assistant_threads.json", "data/assistant_drafts.json")]
    manifest_ok = {"format": "jxl-backup", "backup_format_version": 2, "schema_version": "0.5.0",
                   "backup_id": "bk1", "exported_at": ts, "source_workspace": {"id": "w"},
                   "counts": {"assistant_thread_count": 0, "assistant_draft_count": 0},
                   "source_count": 0, "image_count": 0, "payloads": p4}
    expect_accept("v2 manifest 完整容器（D-3）", BackupManifestV2, manifest_ok)
    expect_accept("v2 manifest 0.6.0 内容（M3）", BackupManifestV2, dict(manifest_ok, schema_version="0.6.0"))
    expect_reject("v2 manifest 未知 schema 版本", BackupManifestV2, dict(manifest_ok, schema_version="0.7.0"))
    expect_reject("v2 manifest 缺 format（D-3 必填）", BackupManifestV2,
                  {k: v for k, v in manifest_ok.items() if k != "format"})
    expect_reject("v2 manifest 缺 source_count（D-3 必填）", BackupManifestV2,
                  {k: v for k, v in manifest_ok.items() if k != "source_count"})
    expect_reject("v2 manifest 缺助手 payload", BackupManifestV2, dict(manifest_ok, payloads=p4[:2]))
    expect_reject("v2 manifest 导出 assistant_ops", BackupManifestV2,
                  dict(manifest_ok, payloads=p4 + [{"path": "data/assistant_ops.json", "bytes": 1, "sha256": sig}]))
    expect_reject("v2 manifest counts 缺助手计数", BackupManifestV2, dict(manifest_ok, counts={}))

    print()
    if FAILURES:
        print(f"[FAIL] {len(FAILURES)} 条守卫失效：")
        for x in FAILURES:
            print(f"  - {x}")
        return 1
    print("[OK] 全部负向用例都被正确拒绝，守卫有效")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
