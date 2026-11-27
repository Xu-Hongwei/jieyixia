"""M2 propose 提示词：由契约语义单一来源渲染生成，不手写散文规则。

规则来源 contract/assistant_http.py PROPOSE_RULES；限额来源 LIMITS；
输出形状与示例由正式模型实例直接 dump 生成，保证示例本身合契约。
"""

from __future__ import annotations

import json

from contract.models import (
    LIMITS,
    PROPOSE_RULES,
    ActionProposalCreate,
    ActionProposalReuse,
    AssistantModelProposal,
    Assumption,
    ClarificationPayload,
    ClarificationQuestion,
    DeadlineCandidate,
    DraftRef,
    ExistingFactEvidence,
    ExistingRef,
    NoteFieldEvidence,
    ProposalPayload,
    ProposalWarning,
    RequirementCandidate,
    SourceExcerptEvidence,
    TaskProposalCreate,
    TaskProposalLink,
    UserMessageEvidence,
    WorkItemProposal,
)

_PROMPT_LIMIT_KEYS = (
    "max_targets", "max_new_actions", "max_work_items", "max_clarification_questions",
    "max_source_excerpt_chars", "max_user_message_chars", "min_segment_minutes_min",
    "min_segment_minutes_max", "min_segment_minutes_default", "horizon_days",
)


def _example_proposal_payload() -> dict:
    ev = SourceExcerptEvidence(source_id="src-示例", excerpt="2026年11月27日18:00前提交课程报告")
    title = "撰写并提交课程报告"
    proposal = AssistantModelProposal(
        task_proposals=[
            TaskProposalCreate(
                key="t1", title=title,
                deadline_candidates=[
                    DeadlineCandidate(value="2026-11-27T18:00:00", precision="datetime", basis="explicit", evidence_refs=[ev]),
                ],
                evidence_refs=[ev],
            ),
        ],
        action_proposals=[
            ActionProposalCreate(key="a1", task_ref=DraftRef(key="t1"), text=title, minutes=105, basis="requirement", evidence_refs=[ev]),
        ],
        work_items=[
            WorkItemProposal(key="w1", task_ref=DraftRef(key="t1"), action_ref=DraftRef(key="a1"), deliverable=title, remaining_minutes=105, splittable=True),
        ],
    )
    return ProposalPayload(proposal=proposal).model_dump(mode="json")


def _example_replan_payload() -> dict:
    ev = UserMessageEvidence(turn_id="turn-示例", excerpt="报告还需安排 90 分钟")
    proposal = AssistantModelProposal(
        task_proposals=[
            TaskProposalLink(key="t1", target_id="task-示例", evidence_refs=[ev]),
        ],
        action_proposals=[
            ActionProposalReuse(key="a1", target_id="action-示例", task_ref=ExistingRef(id="task-示例"), evidence_refs=[ev]),
            ActionProposalCreate(key="a2", task_ref=ExistingRef(id="task-示例"), text="撰写报告正文", minutes=60, basis="suggestion"),
        ],
        work_items=[
            WorkItemProposal(key="w1", task_ref=ExistingRef(id="task-示例"), action_ref=ExistingRef(id="action-示例"), deliverable="报告初稿续写", remaining_minutes=30),
            WorkItemProposal(key="w2", task_ref=ExistingRef(id="task-示例"), action_ref=DraftRef(key="a2"), deliverable="报告正文", remaining_minutes=60, depends_on=["w1"]),
        ],
    )
    return ProposalPayload(proposal=proposal).model_dump(mode="json")


def _example_clarification_payload() -> dict:
    return ClarificationPayload(
        questions=[
            ClarificationQuestion(
                question_id="q1", question="报告需要包含对比分析吗？原文只写了「资料整理与结论」。",
                options=["需要", "不需要"], blocking_reason="原文未说明是否要求对比分析，影响行动拆解。",
            ),
        ],
    ).model_dump(mode="json")


def _type_label(node: dict) -> str:
    if "$ref" in node:
        return node["$ref"].rsplit("/", 1)[-1]
    if "enum" in node:
        return "|".join(str(v) for v in node["enum"])
    if "const" in node:
        return str(node["const"])
    if "anyOf" in node:
        return "|".join(dict.fromkeys(_type_label(x) for x in node["anyOf"]))
    if node.get("type") == "array":
        return _type_label(node.get("items", {})) + "[]"
    return str(node.get("type", "any"))


def _element_lines(model: type, label: str) -> list[str]:
    schema = model.model_json_schema(ref_template="#/$defs/{model}")
    props = schema.get("properties", {})
    doc = (model.__doc__ or "").strip().splitlines()[0] if model.__doc__ else ""
    fields = "、".join(f"{name}({_type_label(sub)})" for name, sub in props.items())
    head = f"- {label}：{doc}" if doc else f"- {label}"
    return [head, f"  字段：{fields}"]


def render_propose_system_prompt(intent: str = "new_plan") -> str:
    replan = intent == "replan_task"
    if replan:
        intro = (
            "你是「截下来」的任务拆解引擎。本次是调整一个既有任务的后续安排：根据用户进展说明与待安排清单，"
            "输出该任务的建议工作清单，或集中澄清问题。"
        )
        example = _example_replan_payload()
        element_header = "proposal 各数组的元素形状（封闭集合，不得自创字段；本次不得新建/修改任务，不得输出截止候选）："
        element_models = (
            (TaskProposalLink, "task_proposals[]（op=link 关联目标任务，唯一一条）"),
            (ActionProposalCreate, "action_proposals[]（op=create 新建，需用户确认）"),
            (ActionProposalReuse, "action_proposals[]（op=reuse 复用该任务未完成行动）"),
            (WorkItemProposal, "work_items[]（本次剩余工作）"),
            (Assumption, "assumptions[]（假设说明，元素必须是对象）"),
            (ProposalWarning, "warnings[]（风险提示，元素必须是对象）"),
            (RequirementCandidate, "requirement_candidates[]（约束候选）"),
            (ClarificationQuestion, "questions[]（澄清问题）"),
        )
    else:
        intro = "你是「截下来」的任务拆解引擎。根据用户本轮要求与选定资料快照，输出任务/行动/工作项建议，或集中澄清问题。"
        example = _example_proposal_payload()
        element_header = "proposal 各数组的元素形状（封闭集合，不得自创字段；update 本版本不支持，不要输出）："
        element_models = (
            (TaskProposalCreate, "task_proposals[]（op=create 新建）"),
            (TaskProposalLink, "task_proposals[]（op=link 关联既有）"),
            (ActionProposalCreate, "action_proposals[]（op=create 新建）"),
            (ActionProposalReuse, "action_proposals[]（op=reuse 复用既有）"),
            (WorkItemProposal, "work_items[]（本次剩余工作）"),
            (Assumption, "assumptions[]（假设说明，元素必须是对象）"),
            (ProposalWarning, "warnings[]（风险提示，元素必须是对象）"),
            (RequirementCandidate, "requirement_candidates[]（约束候选）"),
            (DeadlineCandidate, "deadline_candidates[]（截止候选）"),
            (ClarificationQuestion, "questions[]（澄清问题）"),
        )
    lines: list[str] = [
        intro,
        "你只建议，不确认、不排程、不创建正式对象；日期排程由本地规则计算，确认与采用由用户完成。",
        "",
        "输出形状（二选一）：",
        json.dumps(_example_clarification_payload(), ensure_ascii=False),
        json.dumps(example, ensure_ascii=False),
        "",
        element_header,
    ]
    for model, label in element_models:
        lines.extend(_element_lines(model, label))
    lines.append("")
    lines.append("证据 evidence_refs[] 四选一（kind 判别）：")
    for model in (SourceExcerptEvidence, NoteFieldEvidence, UserMessageEvidence, ExistingFactEvidence):
        lines.extend(_element_lines(model, model.__name__))
    lines.append("")
    for section, rules in PROPOSE_RULES.items():
        if section == "replan" and not replan:
            continue
        lines.append(f"{section} 规则：")
        lines.extend(f"{i}. {r}" for i, r in enumerate(rules, 1))
        lines.append("")
    lines.append("限额：")
    for key in _PROMPT_LIMIT_KEYS:
        item = LIMITS[key]
        lines.append(f"- {key}：{item['value']} {item['unit']}（{item['scope']}）")
    return "\n".join(lines)
