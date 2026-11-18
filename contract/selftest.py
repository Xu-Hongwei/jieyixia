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
    AnalyzeResponse,
    ChangeProposal,
    Deadline,
    Field,
    FocusSession,
    PlanItem,
    SuggestActionRequest,
    SuggestActionResponse,
    TimeNode,
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
    expect_reject("derived 确认却非用户来源（推算值确认必须 origin=user）", Field,
                  dict(field, status="confirmed", derived=True, origin="model"))
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
