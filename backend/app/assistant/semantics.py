"""M2 propose：请求快照内的引用闭包/语义校验（生产实现，不 import proposals）。

规则与 contract/proposals/assistant-v1/selftest.py check_model_semantics 同口径，
但作用域是本次请求携带的选定快照——后端无本地库，只做请求内闭包；
前端持久化/采用事务会再核对真实本地工作区。
"""

from __future__ import annotations

from typing import Any

from .._contract import AssistantProposeRequest, Intent
from contract.assistant_models import looks_like_composed_clarification
from contract.models import (
    LIMITS,
    ActionProposalReuse,
    AssistantModelProposal,
    DraftRef,
    ExistingFactEvidence,
    ExistingRef,
    FieldOrigin,
    NoteFieldEvidence,
    OrderingRequirementValue,
    PriorityRequirementValue,
    SourceExcerptEvidence,
    SplittableRequirementValue,
    TaskProposalCreate,
    TaskProposalLink,
    TaskProposalUpdate,
    UserMessageEvidence,
)


def build_request_context(request: AssistantProposeRequest) -> dict[str, Any]:
    ws = request.workspace_id
    plan_item_ids = {p.plan_item_id for p in request.planning_context.protected_plans}
    replan = None
    rc = request.replan_context
    if rc is not None:
        replacement_ids = {r.plan_item_id for r in rc.replacements}
        kept_ids = {k.plan_item_id for k in rc.kept}
        replan = {"task_id": rc.task_id, "replacement_ids": replacement_ids, "kept_ids": kept_ids}
        plan_item_ids |= replacement_ids | kept_ids
    return {
        "workspace_id": ws,
        "tasks": {t.id: {"id": t.id, "workspace_id": ws} for t in request.selected_tasks},
        "actions": {
            a.id: {"id": a.id, "workspace_id": ws, "task_id": a.task_id, "done": a.done}
            for a in request.selected_actions
        },
        "source_ids": {s.source_id for s in request.selected_sources},
        "note_ids": {c.note_id for s in request.selected_sources for c in s.note_candidates},
        "plan_item_ids": plan_item_ids,
        "focus_session_ids": set(),
        "turn_id": request.turn_id,
        "user_message": request.user_message,
        "user_input": request.user_input,
        "replan": replan,
    }


def _ref_token(ref: Any) -> str:
    return f"draft:{ref.key}" if isinstance(ref, DraftRef) else f"existing:{ref.id}"


# 用户段信任规则（P2 收口，差异文档 §8）：带 user_input 只读结构化字段；
# 旧请求的合成澄清文本（「原始要求：」前缀）零可信段——不解析问/答角色、不猜用户身份；
# 旧请求的普通文本（首轮原话/手动改值）整条可信。


def _user_input_segments(ui: Any) -> list[str]:
    segs = [ui.original_user_request] + [t.user_answer for t in ui.clarifications]
    return [s for s in (x.strip() for x in segs) if s]


def _user_authored_segments(text: str) -> list[str]:
    s = text or ""
    if looks_like_composed_clarification(s):
        return []
    return [s] if s.strip() else []


def check_proposal_semantics(proposal: AssistantModelProposal, ctx: dict[str, Any]) -> None:
    ws = ctx["workspace_id"]
    tasks = ctx["tasks"]
    actions = ctx["actions"]
    sources = ctx["source_ids"]
    notes = ctx["note_ids"]
    plan_items = ctx["plan_item_ids"]
    sessions = ctx["focus_session_ids"]
    turn_id = ctx.get("turn_id")

    task_keys = {t.key for t in proposal.task_proposals}
    work_keys = {w.key for w in proposal.work_items}
    all_keys = (
        [t.key for t in proposal.task_proposals]
        + [a.key for a in proposal.action_proposals]
        + [w.key for w in proposal.work_items]
    )
    if len(set(all_keys)) != len(all_keys):
        raise ValueError("task/action/work item 的 draft key 必须全局唯一")

    # replan_task 越权守卫（PROPOSE_RULES.replan 同口径）：只许一个 link 指向目标任务；
    # 行动/工作项一律归属该任务。取消写集/完成状态/替换选择不在模型输出 schema 内，结构层已拒。
    replan = ctx.get("replan")
    if replan is not None:
        target = replan["task_id"]
        links = [t for t in proposal.task_proposals if isinstance(t, TaskProposalLink)]
        if len(proposal.task_proposals) != 1 or len(links) != 1 or links[0].target_id != target:
            raise ValueError("replan_task 只能输出一个 link 且必须指向 replan_context.task_id；不得新建或修改任务")
        for a in proposal.action_proposals:
            if not isinstance(a.task_ref, ExistingRef) or a.task_ref.id != target:
                raise ValueError(f"replan_task 行动 {a.key} 必须归属目标任务 {target}")
        for w in proposal.work_items:
            if not isinstance(w.task_ref, ExistingRef) or w.task_ref.id != target:
                raise ValueError(f"replan_task 工作项 {w.key} 必须归属目标任务 {target}")

    def check_task_ref(ref: Any, label: str) -> None:
        if isinstance(ref, DraftRef):
            if ref.key not in task_keys:
                raise ValueError(f"{label} 引用未知 draft task key：{ref.key}")
        else:
            t = tasks.get(ref.id)
            if t is None:
                raise ValueError(f"{label} 引用未选定既有 Task：{ref.id}")
            if t["workspace_id"] != ws:
                raise ValueError(f"{label} 跨空间引用 Task：{ref.id}")

    def check_evidence(ev: Any, label: str) -> None:
        if isinstance(ev, SourceExcerptEvidence):
            if ev.source_id not in sources:
                raise ValueError(f"{label} 证据指向未选定 source：{ev.source_id}")
        elif isinstance(ev, NoteFieldEvidence):
            if ev.note_id not in notes:
                raise ValueError(f"{label} 证据指向未选定 note：{ev.note_id}")
        elif isinstance(ev, UserMessageEvidence):
            if turn_id is not None and ev.turn_id != turn_id:
                raise ValueError(f"{label} 用户消息证据 turn_id 不匹配")
            # F1/R1/P2：用户原话证据必须出自真实用户输入。带 user_input 只读结构化字段；
            # 旧请求合成澄清文本零可信段（模型示例不取得用户身份）；旧普通文本整条可信。
            # 空摘录一律不接地。
            ui = ctx.get("user_input")
            if ui is not None:
                segments = _user_input_segments(ui)
            else:
                segments = _user_authored_segments(ctx.get("user_message") or "")
            excerpt = ev.excerpt or ""
            if not excerpt.strip() or not any(excerpt in seg for seg in segments):
                raise ValueError(f"{label} 用户消息证据摘录不在本轮用户输入中")
        else:
            registry = {
                "task": set(tasks), "action": set(actions), "note": notes,
                "source": sources, "plan_item": plan_items, "focus_session": sessions,
            }[ev.object_type]
            if ev.object_id not in registry:
                raise ValueError(f"{label} existing_fact 指向未选定对象：{ev.object_type}/{ev.object_id}")

    def check_deadline_candidates(dls: Any, label: str) -> None:
        for dl in dls:
            for ev in dl.evidence_refs:
                check_evidence(ev, f"{label} 截止候选")
            if dl.origin is FieldOrigin.user and not any(isinstance(e, UserMessageEvidence) for e in dl.evidence_refs):
                raise ValueError("origin=user 的截止候选必须有用户消息证据")

    for t in proposal.task_proposals:
        if isinstance(t, TaskProposalUpdate):
            raise ValueError("本版本不支持 update；模型不得输出修改既有对象的建议")
        if isinstance(t, TaskProposalLink):
            obj = tasks.get(t.target_id)
            if obj is None:
                raise ValueError(f"task link 指向未选定既有 Task：{t.target_id}")
            if obj["workspace_id"] != ws:
                raise ValueError(f"task link 跨空间引用：{t.target_id}")
        if isinstance(t, TaskProposalCreate):
            check_deadline_candidates(t.deadline_candidates, f"task {t.key}")
        for ev in t.evidence_refs:
            check_evidence(ev, f"task {t.key}")

    for a in proposal.action_proposals:
        if isinstance(a, ActionProposalReuse):
            obj = actions.get(a.target_id)
            if obj is None:
                raise ValueError(f"action reuse 指向未选定既有 Action：{a.target_id}")
            if obj["workspace_id"] != ws:
                raise ValueError(f"action reuse 跨空间引用：{a.target_id}")
            if obj["task_id"] != a.task_ref.id:
                raise ValueError(f"action reuse 跨任务：{a.target_id} 不属于 {a.task_ref.id}")
            if obj.get("done"):
                raise ValueError("已完成 Action 不能重新排为未完成步骤")
        check_task_ref(a.task_ref, f"action {a.key}")
        for ev in a.evidence_refs:
            check_evidence(ev, f"action {a.key}")

    action_by_key = {a.key: a for a in proposal.action_proposals}
    for w in proposal.work_items:
        # 模型只建议：工作项估时一律 model 来源。标 user 等于把模型估计伪装成用户已确认值，
        # 会绕过前端「核对并保存为本次清单」的门槛，必须在输出边界拒绝。
        if w.estimate_origin is not FieldOrigin.model:
            raise ValueError(f"work item {w.key} 估时只能标 estimate_origin=model（模型不得冒用用户来源）")
        check_task_ref(w.task_ref, f"work item {w.key}")
        ar = w.action_ref
        if isinstance(ar, DraftRef):
            a = action_by_key.get(ar.key)
            if a is None:
                raise ValueError(f"work item {w.key} 引用未知 draft action key：{ar.key}")
            if _ref_token(a.task_ref) != _ref_token(w.task_ref):
                raise ValueError(f"work item {w.key} 与建议行动 {ar.key} 不属于同一目标")
        else:
            obj = actions.get(ar.id)
            if obj is None:
                raise ValueError(f"work item {w.key} 引用未选定既有 Action：{ar.id}")
            if obj["workspace_id"] != ws:
                raise ValueError(f"work item {w.key} 跨空间引用 Action：{ar.id}")
            if isinstance(w.task_ref, DraftRef):
                raise ValueError("新建目标不得引用既有 Action")
            if obj["task_id"] != w.task_ref.id:
                raise ValueError(f"work item {w.key} 跨任务引用 Action：{ar.id}")
            if obj.get("done"):
                raise ValueError("已完成 Action 不能重新排为未完成步骤")
        for dep in w.depends_on:
            if dep not in work_keys:
                raise ValueError(f"work item {w.key} 依赖未知工作项：{dep}")

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

    # assumptions.related_keys 只能引用本版 work_items[].key（如 w1）；行动 key/任务 key/正式 ID/未知键
    # 在模型输出边界即拒绝（invalid_output → 预算内重试/降级），不留到前端才报 REF_MISSING。
    for a in proposal.assumptions:
        for k in a.related_keys:
            if k not in work_keys:
                raise ValueError(f"assumption {a.id} 的 related_keys 只能引用本版 work_items[].key，未知工作项：{k}")

    covered_existing = {t.target_id for t in proposal.task_proposals if isinstance(t, TaskProposalLink)}
    extra_targets = {w.task_ref.id for w in proposal.work_items if isinstance(w.task_ref, ExistingRef)} - covered_existing
    total = len(proposal.task_proposals) + len(extra_targets)
    if total > LIMITS["max_targets"]["value"]:
        raise ValueError(f"本次目标合计 {total} 超过 {LIMITS['max_targets']['value']}")

    for r in proposal.requirement_candidates:
        if r.type == "task_priority":
            check_task_ref(PriorityRequirementValue.model_validate(r.value).task_ref, f"requirement {r.key}")
        elif r.type == "splittable":
            k = SplittableRequirementValue.model_validate(r.value).work_item_key
            if k not in work_keys:
                raise ValueError(f"requirement {r.key} 引用未知工作项：{k}")
        elif r.type == "ordering":
            v = OrderingRequirementValue.model_validate(r.value)
            for k in (v.before_key, v.after_key):
                if k not in work_keys:
                    raise ValueError(f"requirement {r.key} 引用未知工作项：{k}")
        for ev in r.evidence_refs:
            check_evidence(ev, f"requirement {r.key}")
    for ev in proposal.evidence_refs:
        check_evidence(ev, "顶层证据")


def check_request_semantics(request: AssistantProposeRequest) -> None:
    """pydantic 之外的请求内闭包：既有事实引用必须来自本次选定快照。"""
    if request.intent not in (Intent.new_plan, Intent.replan_task):
        raise ValueError("unsupported_intent")
    ctx = build_request_context(request)
    notes = ctx["note_ids"]
    sources = ctx["source_ids"]
    actions = ctx["actions"]
    tasks = ctx["tasks"]
    plan_items = ctx["plan_item_ids"]

    if request.intent is Intent.replan_task:
        rc = request.replan_context
        if [t.id for t in request.selected_tasks] != [rc.task_id]:
            raise ValueError("replan_task 一次只调整一个任务：selected_tasks 必须恰好是目标任务")
        kept_ids = {k.plan_item_id for k in rc.kept}
        for p in request.planning_context.protected_plans:
            if p.task_id == rc.task_id and p.plan_item_id not in kept_ids:
                raise ValueError(f"目标任务的受保护安排必须列入保留摘要：{p.plan_item_id}")

    action_ids = set(actions)
    for t in request.selected_tasks:
        # replan 的截止是只读事实（模型不得变更），出处便签无需随快照携带；new_plan 仍要求闭包。
        if request.intent is Intent.new_plan and t.deadline.source == "note" and t.deadline.from_note_id is not None:
            if t.deadline.from_note_id not in notes:
                raise ValueError(f"task {t.id} 的截止出处便签不在本次选定快照：{t.deadline.from_note_id}")
        if t.current_action_id is not None:
            a = actions.get(t.current_action_id)
            if a is None or a["task_id"] != t.id:
                raise ValueError(f"task {t.id} 的 current_action_id 不在本次选定行动内：{t.current_action_id}")

    def check_snapshot_evidence(ev: Any, label: str) -> None:
        # 请求侧已确认要求可引用历史轮次的用户消息（turn 无法在请求内核对），
        # 但 source/note/existing_fact 必须落在本次快照内。
        if isinstance(ev, SourceExcerptEvidence):
            if ev.source_id not in sources:
                raise ValueError(f"{label} 证据指向未选定 source：{ev.source_id}")
        elif isinstance(ev, NoteFieldEvidence):
            if ev.note_id not in notes:
                raise ValueError(f"{label} 证据指向未选定 note：{ev.note_id}")
        elif isinstance(ev, ExistingFactEvidence):
            registry = {
                "task": set(tasks), "action": action_ids, "note": notes,
                "source": sources, "plan_item": plan_items, "focus_session": set(),
            }[ev.object_type]
            if ev.object_id not in registry:
                raise ValueError(f"{label} existing_fact 指向未选定对象：{ev.object_type}/{ev.object_id}")

    for r in request.confirmed_requirements:
        for ev in r.evidence_refs:
            check_snapshot_evidence(ev, f"confirmed requirement {r.requirement_id}")
    for r in request.pending_requirements:
        for ev in r.evidence_refs:
            check_snapshot_evidence(ev, f"pending requirement {r.key}")