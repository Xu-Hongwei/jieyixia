"""5B-0 提案离线自测：结构校验 + 语义校验 + 规范样本校验 + 场景预期（设计验证）。

- 不联网、不读用户数据库、不 import 生产运行时。
- 排程金标是独立手算期望：本脚本核对守恒/约束/聚合值，不运行排程器（排程器 5B-1 才实现）。
  因此金标通过只表示「规范样本校验」通过，不表示真实排程功能通过。
- 采用事务/恢复/备份场景核对的是冻结规则表与写集预期，属「设计验证」，不是真实浏览器/数据库验收。

用法：python contract/proposals/assistant-v1/selftest.py   （失败非零退出）
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date as _date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter, ValidationError

import models as M

HERE = Path(__file__).resolve().parent
FIXTURE_DIR = HERE / "fixtures"
BEIJING = timezone(timedelta(hours=8))

UNION_TARGETS: dict[str, Any] = {
    "TaskProposal": TypeAdapter(M.TaskProposal),
    "ActionProposal": TypeAdapter(M.ActionProposal),
    "EvidenceRef": TypeAdapter(M.EvidenceRef),
    "TypedRef": TypeAdapter(M.TypedRef),
    "ResponsePayload": TypeAdapter(M.ResponsePayload),
}
MODEL_TARGETS: dict[str, Any] = {m.__name__: m for m in M.ALL_PROPOSAL_MODELS}


def validate_target(target: str, payload: Any) -> Any:
    if target in UNION_TARGETS:
        return UNION_TARGETS[target].validate_python(payload)
    if target in MODEL_TARGETS:
        return MODEL_TARGETS[target].model_validate(payload)
    raise KeyError(f"未知结构目标：{target}")


def _beijing_date(value: str) -> _date:
    probe = value.replace("Z", "+00:00")
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$", probe):
        probe += ":00"
    dt = datetime.fromisoformat(probe)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BEIJING)
    return dt.astimezone(BEIJING).date()


def _ref_token(ref: Any) -> str:
    if isinstance(ref, dict):
        return f"draft:{ref['key']}" if ref.get("kind") == "draft" else f"existing:{ref['id']}"
    return f"draft:{ref.key}" if isinstance(ref, M.DraftRef) else f"existing:{ref.id}"


# ---------------------------------------------------------------- 模型建议语义校验


def check_model_semantics(proposal: M.AssistantModelProposal, ctx: dict[str, Any]) -> None:
    ws = ctx["workspace_id"]
    tasks = {t["id"]: t for t in ctx.get("tasks", [])}
    actions = {a["id"]: a for a in ctx.get("actions", [])}
    sources = set(ctx.get("source_ids", []))
    notes = set(ctx.get("note_ids", []))
    plan_items = set(ctx.get("plan_item_ids", []))
    sessions = set(ctx.get("focus_session_ids", []))
    turn_id = ctx.get("turn_id")

    task_keys = {t.key for t in proposal.task_proposals}
    action_keys = {a.key for a in proposal.action_proposals}
    work_keys = {w.key for w in proposal.work_items}
    all_keys = [t.key for t in proposal.task_proposals] + [a.key for a in proposal.action_proposals] + [w.key for w in proposal.work_items]
    if len(set(all_keys)) != len(all_keys):
        raise ValueError("task/action/work item 的 draft key 必须全局唯一（采用时 id_map 不重复）")

    def check_task_ref(ref: Any, label: str) -> None:
        if isinstance(ref, M.DraftRef):
            if ref.key not in task_keys:
                raise ValueError(f"{label} 引用未知 draft task key：{ref.key}")
        else:
            t = tasks.get(ref.id)
            if t is None:
                raise ValueError(f"{label} 引用未知既有 Task：{ref.id}")
            if t["workspace_id"] != ws:
                raise ValueError(f"{label} 跨空间引用 Task：{ref.id}")

    def check_evidence(ev: Any, label: str) -> None:
        if isinstance(ev, M.SourceExcerptEvidence):
            if ev.source_id not in sources:
                raise ValueError(f"{label} 证据指向未选定 source：{ev.source_id}")
        elif isinstance(ev, M.NoteFieldEvidence):
            if ev.note_id not in notes:
                raise ValueError(f"{label} 证据指向未选定 note：{ev.note_id}")
        elif isinstance(ev, M.UserMessageEvidence):
            if turn_id is not None and ev.turn_id != turn_id:
                raise ValueError(f"{label} 用户消息证据 turn_id 不匹配")
        else:
            registry = {
                "task": set(tasks), "action": set(actions), "note": notes,
                "source": sources, "plan_item": plan_items, "focus_session": sessions,
            }[ev.object_type]
            if ev.object_id not in registry:
                raise ValueError(f"{label} existing_fact 指向未知对象：{ev.object_type}/{ev.object_id}")

    def check_deadline_candidates(dls: Any, label: str) -> None:
        for dl in dls:
            for ev in dl.evidence_refs:
                check_evidence(ev, f"{label} 截止候选")
            if dl.origin is M.FieldOrigin.user and not any(isinstance(e, M.UserMessageEvidence) for e in dl.evidence_refs):
                raise ValueError("origin=user 的截止候选必须有用户消息证据")

    for t in proposal.task_proposals:
        if isinstance(t, (M.TaskProposalLink, M.TaskProposalUpdate)):
            obj = tasks.get(t.target_id)
            if obj is None:
                raise ValueError(f"task {t.op} 指向未知既有 Task：{t.target_id}")
            if obj["workspace_id"] != ws:
                raise ValueError(f"task {t.op} 跨空间引用：{t.target_id}")
        if isinstance(t, M.TaskProposalCreate):
            check_deadline_candidates(t.deadline_candidates, f"task {t.key}")
        elif isinstance(t, M.TaskProposalUpdate) and t.changes.deadline_candidates:
            check_deadline_candidates(t.changes.deadline_candidates, f"task {t.key}")
        for ev in t.evidence_refs:
            check_evidence(ev, f"task {t.key}")

    for a in proposal.action_proposals:
        if isinstance(a, M.ActionProposalReuse):
            obj = actions.get(a.target_id)
            if obj is None:
                raise ValueError(f"action reuse 指向未知既有 Action：{a.target_id}")
            if obj["workspace_id"] != ws:
                raise ValueError(f"action reuse 跨空间引用：{a.target_id}")
            if obj["task_id"] != a.task_ref.id:
                raise ValueError(f"action reuse 跨任务：{a.target_id} 不属于 {a.task_ref.id}")
            if obj.get("done"):
                raise ValueError("已完成 Action 只能作为已满足前置的事实引用，不能重新排为未完成步骤")
            check_task_ref(a.task_ref, f"action {a.key}")
        else:
            check_task_ref(a.task_ref, f"action {a.key}")
        for ev in a.evidence_refs:
            check_evidence(ev, f"action {a.key}")

    action_by_key = {a.key: a for a in proposal.action_proposals}
    for w in proposal.work_items:
        check_task_ref(w.task_ref, f"work item {w.key}")
        ar = w.action_ref
        if isinstance(ar, M.DraftRef):
            a = action_by_key.get(ar.key)
            if a is None:
                raise ValueError(f"work item {w.key} 引用未知 draft action key：{ar.key}")
            if _ref_token(a.task_ref) != _ref_token(w.task_ref):
                raise ValueError(f"work item {w.key} 与建议行动 {ar.key} 不属于同一目标")
        else:
            obj = actions.get(ar.id)
            if obj is None:
                raise ValueError(f"work item {w.key} 引用未知既有 Action：{ar.id}")
            if obj["workspace_id"] != ws:
                raise ValueError(f"work item {w.key} 跨空间引用 Action：{ar.id}")
            if isinstance(w.task_ref, M.DraftRef):
                raise ValueError("新建目标不得引用既有 Action")
            if obj["task_id"] != w.task_ref.id:
                raise ValueError(f"work item {w.key} 跨任务引用 Action：{ar.id}")
            if obj.get("done"):
                raise ValueError("已完成 Action 只能作为已满足前置的事实引用，不能重新排为未完成步骤")
        for dep in w.depends_on:
            if dep not in work_keys:
                raise ValueError(f"work item {w.key} 依赖未知工作项：{dep}")

    # 依赖环
    graph = {w.key: list(w.depends_on) for w in proposal.work_items}
    state: dict[str, int] = {}

    def visit(k: str) -> None:
        if state.get(k) == 1:
            raise ValueError(f"依赖环：{k}")
        if state.get(k) == 2:
            return
        state[k] = 1
        for dep in graph[k]:
            visit(dep)
        state[k] = 2

    for k in graph:
        visit(k)

    # 目标总数：每个 task proposal 一个目标 + 工作项直接引用且未被 proposal 覆盖的既有 Task
    covered_existing = {t.target_id for t in proposal.task_proposals if isinstance(t, (M.TaskProposalLink, M.TaskProposalUpdate))}
    extra_targets = {w.task_ref.id for w in proposal.work_items if isinstance(w.task_ref, M.ExistingRef)} - covered_existing
    total = len(proposal.task_proposals) + len(extra_targets)
    if total > M.LIMITS["max_targets"]["value"]:
        raise ValueError(f"本次目标合计 {total} 超过 {M.LIMITS['max_targets']['value']}")

    for r in proposal.requirement_candidates:
        if r.type == "task_priority":
            check_task_ref(M.PriorityRequirementValue.model_validate(r.value).task_ref, f"requirement {r.key}")
        elif r.type == "splittable":
            k = M.SplittableRequirementValue.model_validate(r.value).work_item_key
            if k not in work_keys:
                raise ValueError(f"requirement {r.key} 引用未知工作项：{k}")
        elif r.type == "ordering":
            v = M.OrderingRequirementValue.model_validate(r.value)
            for k in (v.before_key, v.after_key):
                if k not in work_keys:
                    raise ValueError(f"requirement {r.key} 引用未知工作项：{k}")
        for ev in r.evidence_refs:
            check_evidence(ev, f"requirement {r.key}")
    for ev in proposal.evidence_refs:
        check_evidence(ev, "顶层证据")


def check_planning_semantics(inp: M.PlanningInput) -> None:
    """D12：既有任务在窗口已有安排时，须确认本次估时为额外尚未安排工作。"""
    window = {d.date for d in inp.days}
    occupied_existing_tasks = {
        o.task_id for o in inp.occupancy
        if o.date in window and o.state.value in ("planned", "partial", "done")
    }
    ack = set(inp.extra_work_acknowledged)
    for w in inp.work_items:
        if isinstance(w.task_ref, M.ExistingRef) and w.task_ref.id in occupied_existing_tasks:
            if w.key not in ack:
                raise ValueError(f"工作项 {w.key} 的既有任务在窗口已有安排，须先确认「额外尚未安排工作」口径（D12）")


# ---------------------------------------------------------------- 排程金标：规范样本校验（不运行排程器）

COUNTED_STATES = {"planned", "partial", "done"}


def check_planning_pair(inp: M.PlanningInput, res: M.PlanningResult) -> dict[str, Any]:
    window = [d.date for d in inp.days]
    window_set = set(window)
    items = {w.key: w for w in inp.work_items}
    facts = {_ref_token(f.task_ref): f for f in inp.task_facts}
    excluded = {e.work_item_key for e in res.excluded_items}
    unknown = {u.work_item_key for u in res.unknown_items}
    unsched = {u.work_item_key: u for u in res.unscheduled}

    committed_by_day = {d: 0 for d in window}
    for o in inp.occupancy:
        if o.date in window_set and o.state.value in COUNTED_STATES:
            committed_by_day[o.date] += o.planned_minutes

    segs_by_item: dict[str, list[M.Segment]] = {k: [] for k in items}
    alloc_by_day = {d: 0 for d in window}
    orders_by_day: dict[str, list[int]] = {d: [] for d in window}
    for s in res.segments:
        if s.date not in window_set:
            raise ValueError(f"段 {s.segment_key} 日期 {s.date} 超出 7 天窗口")
        if s.work_item_key not in items:
            raise ValueError(f"段 {s.segment_key} 引用未知工作项 {s.work_item_key}")
        w = items[s.work_item_key]
        if _ref_token(s.task_ref) != _ref_token(w.task_ref):
            raise ValueError(f"段 {s.segment_key} task_ref 与工作项不一致")
        if _ref_token(s.suggested_action_ref) != _ref_token(w.action_ref):
            raise ValueError(f"段 {s.segment_key} suggested_action_ref 与工作项不一致")
        segs_by_item[s.work_item_key].append(s)
        alloc_by_day[s.date] += s.minutes
        orders_by_day[s.date].append(s.order)
    for d, orders in orders_by_day.items():
        if len(set(orders)) != len(orders):
            raise ValueError(f"{d} 当日 segment order 重复")

    initial_free, final_free, overbooked = [], [], []
    for day, summary in zip(inp.days, res.days):
        if day.date != summary.date:
            raise ValueError("result.days 与 input.days 日期顺序不一致")
        allocatable = day.budget_minutes * (100 - inp.buffer_pct) // 100
        buffer_minutes = day.budget_minutes - allocatable
        committed = committed_by_day[day.date]
        alloc = alloc_by_day[day.date]
        over = max(0, committed - allocatable)
        free0 = max(0, allocatable - committed)
        free1 = max(0, allocatable - committed - alloc)
        if summary.budget_minutes != day.budget_minutes or summary.buffer_minutes != buffer_minutes:
            raise ValueError(f"{day.date} budget/buffer 与输入不一致")
        if summary.committed_minutes != committed:
            raise ValueError(f"{day.date} committed={summary.committed_minutes} 应为 {committed}（占用守恒）")
        if summary.allocated_minutes != alloc:
            raise ValueError(f"{day.date} allocated 与段分钟和不一致")
        if summary.overbooked_minutes != over or summary.free_minutes != free1:
            raise ValueError(f"{day.date} overbooked/free 公式不符")
        if over > 0 and alloc > 0:
            raise ValueError(f"{day.date} 已过载仍新增安排")
        initial_free.append(free0)
        final_free.append(free1)
        overbooked.append(over)

    start = _date.fromisoformat(inp.start_date)
    end = _date.fromisoformat(window[-1])
    today = _date.fromisoformat(inp.today) if inp.today else start
    latest_by_item: dict[str, _date] = {}
    for k, w in items.items():
        fact = facts[_ref_token(w.task_ref)]
        dl_date = None
        if fact.deadline_precision == "none":
            latest = end
        else:
            dl_date = _beijing_date(fact.deadline_value) if fact.deadline_precision == "datetime" else _date.fromisoformat(fact.deadline_value)
            latest = dl_date - timedelta(days=1) if fact.deadline_precision == "datetime" else dl_date
        # R2：真实逾期按截止日与注入 today 比较；当天精确截止不算逾期（保守最迟日仅用于放置）。
        overdue = fact.deadline_precision != "none" and dl_date < today
        if overdue and fact.overdue_consent:
            # 用户明确逾期补做后，可在当前窗口内安排；原截止事实不变
            latest = end
        latest_by_item[k] = latest
        segs = sorted(segs_by_item[k], key=lambda s: (s.date, s.order))
        seg_sum = sum(s.minutes for s in segs)

        if k in excluded:
            if segs or k in unsched or k in unknown:
                raise ValueError(f"已排除项 {k} 不得有段/未排/未知记录")
            continue
        if w.remaining_minutes is None:
            if k not in unknown:
                raise ValueError(f"未知估时项 {k} 必须单列 unknown_items")
            if segs or k in unsched:
                raise ValueError(f"未知估时项 {k} 不得排段或填缺口（不能当 0）")
            continue
        if k in unknown:
            raise ValueError(f"已知估时项 {k} 不得列入 unknown_items")

        # 分钟守恒：remaining = 已分配段和 + 未排
        gap = unsched[k].remaining_minutes if k in unsched else 0
        if seg_sum + gap != w.remaining_minutes:
            raise ValueError(f"{k} 分钟不守恒：{seg_sum}+{gap} != {w.remaining_minutes}")
        if seg_sum == w.remaining_minutes and k in unsched:
            raise ValueError(f"{k} 已排完仍有未排记录")

        # 分段规则
        if not w.splittable and len(segs) > 1:
            raise ValueError(f"不可拆项 {k} 出现多段")
        if w.splittable and segs:
            for s in segs[:-1]:
                if s.minutes < w.min_segment_minutes:
                    raise ValueError(f"{k} 非最终段 {s.minutes} 小于最小段 {w.min_segment_minutes}")
        # 最早日 / 最迟日
        if w.earliest_date:
            earliest = _date.fromisoformat(w.earliest_date)
            if any(_date.fromisoformat(s.date) < earliest for s in segs):
                raise ValueError(f"{k} 排在 earliest_date 之前")
        if any(_date.fromisoformat(s.date) > latest for s in segs):
            raise ValueError(f"{k} 排在最迟可排日 {latest} 之后（截止不等于安排日）")
        # 逾期
        if overdue:
            if not fact.overdue_consent:
                if segs or (k in unsched and unsched[k].reason.value != "overdue_requires_consent"):
                    raise ValueError(f"逾期项 {k} 未经补做确认不得安排")
            elif segs and not any(warn.code == "overdue_scheduled" for warn in res.warnings):
                raise ValueError(f"逾期补做项 {k} 已排但缺 overdue_scheduled 警告")
        # 未排原因与事实一致
        if k in unsched:
            reason = unsched[k].reason.value
            if reason == "not_splittable" and w.splittable:
                raise ValueError(f"{k} reason=not_splittable 但工作项可拆")
            if reason == "outside_horizon" and (not w.earliest_date or _date.fromisoformat(w.earliest_date) <= end):
                raise ValueError(f"{k} reason=outside_horizon 但最早日在窗口内")
            if reason == "overdue_requires_consent" and (not overdue or fact.overdue_consent):
                raise ValueError(f"{k} reason=overdue_requires_consent 与事实不符")
            if reason == "dependency_blocked":
                blocked = any(
                    items[d].remaining_minutes is None
                    or sum(x.minutes for x in segs_by_item[d]) < items[d].remaining_minutes
                    for d in w.depends_on
                )
                if not blocked:
                    raise ValueError(f"{k} dependency_blocked 但前置全部排完")
            if reason == "needs_deadline_day_window":
                if fact.deadline_precision != "datetime":
                    raise ValueError(f"{k} needs_deadline_day_window 只用于精确时刻截止")
                dl_date = _beijing_date(fact.deadline_value)
                if dl_date.isoformat() not in window_set:
                    raise ValueError(f"{k} 截止当天不在窗口内，不应要求当天时段核对")
                idx = window.index(dl_date.isoformat())
                if initial_free[idx] <= 0:
                    raise ValueError(f"{k} 截止当天无空闲，不构成时段核对缺口")

    # 依赖顺序：前置全部排完后继才可排；同日须明确顺序
    for k, w in items.items():
        if k in excluded or w.remaining_minutes is None:
            continue
        segs = segs_by_item[k]
        for dep in w.depends_on:
            dw = items[dep]
            dep_segs = segs_by_item[dep]
            dep_sum = sum(s.minutes for s in dep_segs)
            if dw.remaining_minutes is None:
                if segs:
                    raise ValueError(f"{k} 的前置 {dep} 估时未知，不得排后继")
                continue
            if dep_sum < dw.remaining_minutes:
                if segs:
                    raise ValueError(f"前置 {dep} 仍有未排量，后继 {k} 不得排段")
                if k in unsched and unsched[k].reason.value not in (
                    "overdue_requires_consent", "outside_horizon", "dependency_blocked"
                ):
                    raise ValueError(f"{k} 应标 dependency_blocked")
            elif segs and dep_segs:
                dep_last = max((_date.fromisoformat(s.date), s.order) for s in dep_segs)
                own_first = min((_date.fromisoformat(s.date), s.order) for s in segs)
                if own_first <= dep_last:
                    raise ValueError(f"{k} 必须整体晚于前置 {dep}（同日须明确 order）")

    if any(o > 0 for o in overbooked) and not any(w.code == "existing_overbook" for w in res.warnings):
        raise ValueError("存在既有过载日但缺 existing_overbook 警告")
    if any(f.deadline_precision == "datetime" for f in inp.task_facts) and not any(w.code == "datetime_deadline_conservative" for w in res.warnings):
        raise ValueError("存在精确时刻截止但缺 datetime_deadline_conservative 说明")

    expected_complete = (
        not res.unscheduled and not res.unknown_items and not res.conflicts
        and all(
            items[k].remaining_minutes is not None
            and sum(s.minutes for s in segs_by_item[k]) == items[k].remaining_minutes
            for k in items if k not in excluded
        )
    )
    if res.complete != expected_complete:
        raise ValueError(f"complete={res.complete} 与事实不符（应为 {expected_complete}）")

    return {
        "initial_free_by_day": initial_free,
        "allocated_by_day": [alloc_by_day[d] for d in window],
        "final_free_by_day": final_free,
        "overbooked_by_day": overbooked,
        "scheduled_total": sum(alloc_by_day.values()),
        "unscheduled": sorted(
            [{"work_item_key": u.work_item_key, "remaining_minutes": u.remaining_minutes, "reason": u.reason.value} for u in res.unscheduled],
            key=lambda x: x["work_item_key"],
        ),
        "unknown_count": len(res.unknown_items),
        "complete": res.complete,
    }


# ---------------------------------------------------------------- 场景规则表（冻结预期，设计验证）

DRAFT_TRANSITIONS: set[tuple[str, str]] = {
    ("editing", "generating"), ("editing", "discarded"),
    ("generating", "needs_clarification"), ("generating", "ready"), ("generating", "needs_review"), ("generating", "discarded"),
    ("needs_clarification", "generating"), ("needs_clarification", "editing"), ("needs_clarification", "discarded"),
    ("ready", "applying"), ("ready", "editing"), ("ready", "generating"), ("ready", "discarded"),
    ("applying", "applied"), ("applying", "needs_review"), ("applying", "result_unknown"),
    ("result_unknown", "applied"), ("result_unknown", "applying"), ("result_unknown", "needs_review"), ("result_unknown", "discarded"),
    ("needs_review", "editing"), ("needs_review", "generating"), ("needs_review", "discarded"),
}

REFRESH_MAP: dict[str, str] = {
    "generating": "needs_review",
    "applying": "result_unknown",
    "result_unknown": "result_unknown",
}

RESTORE_MAP: dict[str, dict[str, Any]] = {
    s: {"restored_status": "needs_review", "envelope_cleared": True, "baseline_cleared": True, "adoption_auth_cleared": True, "content_kept": True}
    for s in ("editing", "generating", "needs_clarification", "ready", "needs_review", "applying", "result_unknown")
}
RESTORE_MAP["applied"] = {"restored_status": "applied", "envelope_cleared": True, "baseline_cleared": True, "adoption_auth_cleared": True, "content_kept": True}
RESTORE_MAP["discarded"] = {"restored_status": "discarded", "envelope_cleared": True, "baseline_cleared": True, "adoption_auth_cleared": True, "content_kept": True}

ADOPTION_RECHECK: dict[str, dict[str, Any]] = {
    "receipt_exists_same_signature": {"outcome": "return_original", "business_writes": 0},
    "receipt_exists_different_signature": {"outcome": "reject", "business_writes": 0},
    "draft_adopted_by_other_application": {"outcome": "conflict_verify_original", "business_writes": 0},
    "new_same_day_plan_inserted": {"outcome": "needs_review", "business_writes": 0},
    "task_completed_or_deleted": {"outcome": "needs_review", "business_writes": 0},
    "source_replaced_new_id": {"outcome": "needs_review", "business_writes": 0},
    "cross_midnight": {"outcome": "needs_review", "business_writes": 0},
    "all_checks_pass": {"outcome": "commit", "business_writes": "counts"},
    "tail_write_failure": {"outcome": "abort_zero_writes", "business_writes": 0},
    "committed_but_read_failed": {"outcome": "result_unknown_query_original", "business_writes": "unknown_pending_verify"},
}

ERROR_HTTP: dict[str, int] = {
    "PROTOCOL_UNSUPPORTED": 400, "AUTH_FAILED": 401, "BODY_TOO_LARGE": 413,
    "INVALID_STRUCTURE": 422, "INVALID_REFERENCE": 422,
    "RATE_LIMITED": 429, "QUOTA_EXHAUSTED": 429,
    "MODEL_OUTPUT_INVALID": 502, "MODEL_UNAVAILABLE": 503, "CONCURRENCY_LIMIT": 503,
    "BUDGET_TIMEOUT": 504,
}

BACKUP_COMPAT: dict[tuple[int, str], str] = {
    (1, "0.4.0"): "restore_old_semantics_empty_assistant",
    (2, "0.5.0"): "restore_full_with_assistant",
}

# typed 引用路径表（§8.3）：对象类型 / active-historical / 缺失处理 / 是否重映射
REMAP_TABLE: dict[str, dict[str, Any]] = {
    "thread.selected_refs[source/note/task]": {"semantics": "active_or_historical", "missing": "historical_marker", "remap": True},
    "thread.messages.refs": {"semantics": "active_or_historical", "missing": "historical_marker", "remap": True},
    "draft.thread_id": {"semantics": "active", "missing": "reject_draft_restore", "remap": True},
    "draft.source_refs": {"semantics": "active_or_historical", "missing": "historical_marker", "remap": True},
    "draft.proposal.existing_refs": {"semantics": "active_or_historical", "missing": "historical_marker", "remap": True},
    "draft.user_confirmations.object_refs": {"semantics": "historical", "missing": "historical_marker", "remap": True},
    "draft.applied_summary.id_map.formal_id": {"semantics": "historical", "missing": "historical_marker", "remap": True},
    "draft.proposal.draft_keys": {"semantics": "draft_local", "missing": "keep_as_is", "remap": False},
    "body_text_id_strings": {"semantics": "content", "missing": "keep_as_is", "remap": False},
}


def check_scenario(payload: dict[str, Any], expected: dict[str, Any]) -> None:
    kind = payload["scenario"]
    if kind == "draft_transition":
        allowed = (payload["from"], payload["to"]) in DRAFT_TRANSITIONS
        got = {"allowed": allowed}
    elif kind == "refresh_status":
        original = payload["original_status"]
        got = {"restored_status": REFRESH_MAP.get(original, original), "needs_explicit_retry": original in REFRESH_MAP}
    elif kind == "restore_draft_status":
        got = RESTORE_MAP[payload["original_status"]]
    elif kind == "adoption_recheck":
        got = ADOPTION_RECHECK[payload["event"]]
    elif kind == "error_http_mapping":
        got = {"http": ERROR_HTTP[payload["code"]]}
    elif kind == "backup_compat":
        key = (payload["backup_format_version"], payload["schema_version"])
        got = {"behavior": BACKUP_COMPAT.get(key, "reject_unknown_combination")}
    elif kind == "typed_ref_remap":
        got = REMAP_TABLE[payload["ref_path"]]
    elif kind == "call_budget":
        analyze_calls = payload["analyze_calls"]
        analyze_attempts = payload["analyze_attempts_total"]
        propose_attempts = payload["propose_attempts"]
        ok = (
            analyze_calls <= M.LIMITS["max_new_images_per_batch"]["value"]
            and propose_attempts <= M.LIMITS["propose_max_vendor_attempts"]["value"]
        )
        got = {
            "allowed": ok,
            "total_vendor_attempts": analyze_attempts + propose_attempts,
            "all_attempts_consume_daily_quota": True,
            "propose_budget_covers_all_its_attempts": True,
        }
        # 多 profile 设计样本：analyze 沿用 ModelRouter 逐 profile fallback，
        # 一次 analyze 的配置尝试上界 = 各 profile (1+retries) 之和；实际还受时间预算/共享额度/提前成功限制。
        profiles = payload.get("analyze_profile_retries")
        if profiles is not None:
            upper = sum(1 + r for call in profiles for r in call)
            within = len(profiles) == analyze_calls and analyze_attempts <= upper
            got["analyze_configured_attempt_upper"] = upper
            got["analyze_attempts_within_configured_upper"] = within
            got["allowed"] = ok and within
    else:
        raise KeyError(f"未知场景：{kind}")
    if got != expected:
        raise ValueError(f"场景 {kind} 预期不符：计算 {got} != 样本 {expected}")


# ---------------------------------------------------------------- 限额边界（程序化构造，不落样本文件）


def check_draft_serialized_size(draft: M.AssistantDraft) -> None:
    size = len(draft.model_dump_json().encode("utf-8"))
    if size > M.LIMITS["max_draft_bytes"]["value"]:
        raise ValueError(f"草案序列化 {size} 字节超过 1MiB 上限；提示基于当前内容新建草案，不静默截断")


def check_propose_body_bytes(raw: bytes) -> None:
    if len(raw) > M.LIMITS["max_propose_body_bytes"]["value"]:
        raise ValueError("propose 请求体超过 512KiB（UTF-8 实际字节）")


def run_limit_boundary_tests() -> list[str]:
    """types/limits/fixtures 交叉校验 + 程序化边界。返回失败列表。"""
    problems: list[str] = []

    def expect_reject(fn, label: str) -> None:
        try:
            fn()
        except (ValueError, ValidationError):
            return
        problems.append(f"{label}：应拒绝但通过了")

    def expect_accept(fn, label: str) -> None:
        try:
            fn()
        except (ValueError, ValidationError) as exc:
            problems.append(f"{label}：应接受但被拒绝：{exc}")

    # limits.json 与 models.LIMITS 一致
    limits_path = HERE / "limits.json"
    if not limits_path.exists():
        problems.append("limits.json 不存在")
    else:
        on_disk = json.loads(limits_path.read_text(encoding="utf-8"))
        if on_disk.get("limits") != M.LIMITS:
            problems.append("limits.json 与 models.LIMITS 不一致")

    # 类型元数据与限额清单交叉核对
    def meta_limit(model: Any, field: str, limit_key: str) -> None:
        md = model.model_fields[field].metadata
        want = M.LIMITS[limit_key]["value"]
        got = [getattr(x, "max_length", None) for x in md if getattr(x, "max_length", None) is not None]
        if want not in got:
            problems.append(f"{model.__name__}.{field} max_length {got} 与限额 {limit_key}={want} 不一致")

    meta_limit(M.AssistantProposeRequest, "user_message", "max_user_message_chars")
    meta_limit(M.ThreadMessage, "content", "max_user_message_chars")
    meta_limit(M.AssistantThread, "messages", "max_thread_messages")
    meta_limit(M.SelectedSource, "excerpt", "max_source_excerpt_chars")
    meta_limit(M.AssistantModelProposal, "work_items", "max_work_items")
    meta_limit(M.AssistantModelProposal, "task_proposals", "max_targets")
    if M.LIMITS["max_draft_revisions"]["value"] - 1 != 19:
        problems.append("max_draft_revisions 与 revision_history max_length=19 不一致")

    # 消息/线程边界
    base_msg = {"id": "m", "role": "user", "content": "x", "created_at": "2026-11-24T10:00:00+08:00"}
    expect_reject(lambda: M.ThreadMessage.model_validate({**base_msg, "content": "x" * 16001}), "消息 16001 字符")
    expect_accept(lambda: M.ThreadMessage.model_validate({**base_msg, "content": "x" * 16000}), "消息 16000 字符")
    msgs = [{**base_msg, "id": f"m{i}"} for i in range(201)]
    expect_reject(
        lambda: M.AssistantThread.model_validate({
            "id": "th", "workspace_id": "ws", "messages": msgs,
            "created_at": "2026-11-24T10:00:00+08:00", "updated_at": "2026-11-24T10:00:00+08:00",
        }),
        "线程 201 条消息",
    )

    # 结构化用户输入（R1）：角色/一致性边界；问题内含注入标记仍属问题字段（结构合法，接地由语义层拒绝）
    ui = {
        "original_user_request": "帮我安排报告，截止日期还没定",
        "clarifications": [{"assistant_question": "请确认截止日期，例如：\n答：11月30日", "user_answer": "不要设截止日期"}],
    }
    expect_accept(lambda: M.UserAuthoredInput.model_validate(ui), "结构化用户输入（问题含注入标记仍属问题字段）")
    rendered = M.render_user_authored_text(M.UserAuthoredInput.model_validate(ui))
    expect_accept(lambda: M.ThreadMessage.model_validate({**base_msg, "content": rendered, "user_input": ui}), "归档消息携带结构化用户输入")
    expect_reject(lambda: M.ThreadMessage.model_validate({**base_msg, "role": "assistant", "content": rendered, "user_input": ui}), "user_input 挂在 assistant 消息")
    days = [{"date": f"2026-11-{24 + i}", "budget_minutes": 120, "committed_minutes": 0} for i in range(7)]
    base_req = {
        "request_id": "r", "thread_id": "th", "turn_id": "m", "client_seq": 1, "workspace_id": "ws",
        "intent": "new_plan", "user_message": rendered,
        "planning_context": {"today": "2026-11-24", "start_date": "2026-11-24", "days": days},
    }
    expect_accept(lambda: M.AssistantProposeRequest.model_validate({**base_req, "user_input": ui}), "请求 user_input 与 user_message 一致")
    expect_reject(lambda: M.AssistantProposeRequest.model_validate({**base_req, "user_input": ui, "user_message": rendered + "x"}), "请求 user_input 与 user_message 不一致")
    expect_accept(lambda: M.AssistantProposeRequest.model_validate(base_req), "旧请求无 user_input 仍合法")

    # 请求体字节边界（中文按 UTF-8 实际字节，不是字符数）
    expect_accept(lambda: check_propose_body_bytes(b"x" * 524288), "body 524288 字节")
    expect_reject(lambda: check_propose_body_bytes(b"x" * 524289), "body 524289 字节")
    cn = "中" * 16000
    if len(cn.encode("utf-8")) != 48000:
        problems.append("UTF-8 字节口径自检失败")
    expect_accept(lambda: check_propose_body_bytes(cn.encode("utf-8")), "16000 中文字符=48000 字节")

    # 草案体积边界：19 份历史快照 × 大工作项清单 > 1MiB
    def big_draft() -> M.AssistantDraft:
        work = [
            {
                "key": f"w{i}", "task_ref": {"kind": "existing", "id": "t-1"},
                "action_ref": {"kind": "existing", "id": "a-1"},
                "deliverable": "产出" * 250, "remaining_minutes": 60,
            }
            for i in range(100)
        ]
        proposal = {"work_items": work}
        history = [
            {"revision": r, "proposal": proposal, "created_at": "2026-11-24T10:00:00+08:00"}
            for r in range(1, 20)
        ]
        return M.AssistantDraft.model_validate({
            "id": "d-big", "workspace_id": "ws", "thread_id": "th", "revision": 20,
            "revision_history": history, "proposal": proposal,
            "created_at": "2026-11-24T10:00:00+08:00", "updated_at": "2026-11-24T10:00:00+08:00",
        })

    expect_reject(lambda: check_draft_serialized_size(big_draft()), "草案 >1MiB")
    small = M.AssistantDraft.model_validate({
        "id": "d-small", "workspace_id": "ws", "thread_id": "th", "revision": 1,
        "created_at": "2026-11-24T10:00:00+08:00", "updated_at": "2026-11-24T10:00:00+08:00",
    })
    expect_accept(lambda: check_draft_serialized_size(small), "小草案体积")

    # 版本数边界：revision=21 结构拒绝
    expect_reject(
        lambda: M.AssistantDraft.model_validate({
            "id": "d", "workspace_id": "ws", "thread_id": "th", "revision": 21,
            "created_at": "2026-11-24T10:00:00+08:00", "updated_at": "2026-11-24T10:00:00+08:00",
        }),
        "revision=21",
    )
    # 安全整数边界
    expect_reject(
        lambda: M.PreparedPlanItemCreate.model_validate({
            "formal_id": "p", "workspace_id": "ws", "task_id": "t", "date": "2026-11-24",
            "planned_minutes": 30, "action_text": "x", "order": 2**53,
        }),
        "order=2^53 超安全整数",
    )
    return problems


# ---------------------------------------------------------------- 主流程


def main() -> int:
    failures: list[str] = []
    counts = {"accept": 0, "reject": 0, "expect": 0, "golden": 0}

    index_path = FIXTURE_DIR / "index.json"
    if not index_path.exists():
        print("[FAIL] fixtures/index.json 不存在")
        return 1
    index = json.loads(index_path.read_text(encoding="utf-8"))
    for entry in index["cases"]:
        path = FIXTURE_DIR / entry["file"]
        raw = json.loads(path.read_text(encoding="utf-8"))
        case = M.FixtureCase.model_validate(raw)
        label = f"{case.id}（{case.title}）"
        try:
            if case.target == "planning_golden":
                inp = M.PlanningInput.model_validate(case.payload["input"])
                res = M.PlanningResult.model_validate(case.payload["result"])
                check_planning_semantics(inp)
                got = check_planning_pair(inp, res)
                want = json.loads(json.dumps(case.expected))
                want["unscheduled"] = sorted(want.get("unscheduled", []), key=lambda x: x["work_item_key"])
                if got != want:
                    diff = {k: (got.get(k), want.get(k)) for k in set(got) | set(want) if got.get(k) != want.get(k)}
                    raise ValueError(f"金标聚合值不符（规范样本校验）：{diff}")
                counts["golden"] += 1
            elif case.target == "model_semantics":
                proposal = M.AssistantModelProposal.model_validate(case.payload["proposal"])
                check_model_semantics(proposal, case.payload["context"])
                if case.mode == "reject":
                    raise AssertionError("负向样本未被拒绝")
                counts["accept"] += 1
            elif case.target == "scenario":
                if case.mode != "expect":
                    raise AssertionError("场景样本必须 mode=expect")
                check_scenario(case.payload, case.expected)
                counts["expect"] += 1
            elif case.target == "planning_semantics":
                inp = M.PlanningInput.model_validate(case.payload)
                check_planning_semantics(inp)
                if case.mode == "reject":
                    raise AssertionError("负向样本未被拒绝")
                counts["accept"] += 1
            else:
                validate_target(case.target, case.payload)
                if case.target == "PlanningInput":
                    check_planning_semantics(M.PlanningInput.model_validate(case.payload))
                if case.mode == "reject":
                    raise AssertionError("负向样本未被拒绝")
                counts["accept"] += 1
        except (ValidationError, ValueError, AssertionError) as exc:
            msg = str(exc)
            if case.mode == "reject":
                if case.expected_error and case.expected_error not in msg:
                    failures.append(f"{label}：拒绝了但原因不符，预期含「{case.expected_error}」，实际：{msg[:300]}")
                else:
                    counts["reject"] += 1
            else:
                failures.append(f"{label}：{msg[:400]}")

    limit_problems = run_limit_boundary_tests()
    failures.extend(limit_problems)

    total = sum(counts.values())
    print(f"[样本] accept={counts['accept']} reject={counts['reject']} expect(设计验证)={counts['expect']} golden(规范样本校验)={counts['golden']} 合计={total}")
    print(f"[限额边界] 程序化交叉校验 {'通过' if not limit_problems else '失败 ' + str(len(limit_problems)) + ' 处'}")
    if failures:
        print(f"[FAIL] {len(failures)} 处问题：")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("[OK] 全部样本与限额边界通过。注意：金标=规范样本校验，场景=设计验证；排程器/采用服务/智能体尚未实现。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
