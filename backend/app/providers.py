"""Provider 注入：桩与真实模型共用同一个 router，切换只改环境变量。

JXL_PROVIDER=fixture  → FixtureProvider（读 fixtures，确定性、可复现）
JXL_PROVIDER=model    → ModelProvider（多厂家 profile + 失败降级）
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Protocol

from fastapi import Depends

from contract.models import (
    ActionProposalCreate,
    ActionProposalReuse,
    AssistantModelProposal,
    ClarificationPayload,
    ClarificationQuestion,
    DraftRef,
    ExistingFactEvidence,
    ExistingRef,
    JS_SAFE_INT_MAX,
    ProposalPayload,
    SourceExcerptEvidence,
    TaskProposalCreate,
    TaskProposalLink,
    UserMessageEvidence,
    WorkItemProposal,
)

from ._contract import (
    FIXTURE_DIR,
    AnalyzeRequest,
    AnalyzeResponse,
    AssistantProposeRequest,
    AssistantProposeResponse,
    Fixture,
    LIMITS,
)
from .assistant.core import build_propose_user_text, parse_propose_output, propose_response, review_snapshot
from .assistant.new_plan import ExternalStepSplitNeeded, source_time_nodes, uses_task_list
from .assistant.review_actions import apply_external_step_repair, external_step_repair_inputs, role_question
from .assistant.prompt import render_propose_system_prompt, render_task_list_prompt
from .config import get_settings
from .errors import ApiFault
from .model.base import ModelError, PlanOutputError
from .model.core import SYSTEM_PROMPT, _extract_json, build_user_text, parse_model_output
from .model.registry import ModelRouter, build_router
from .observability import log_event
from .validation import inspect_image, strip_data_url


class AnalyzeProvider(Protocol):
    name: str
    ready: bool

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResponse: ...


class FixtureProvider:
    name = "fixture"
    ready = True

    def __init__(self, fixture_dir: Path = FIXTURE_DIR) -> None:
        self._responses: dict[str, AnalyzeResponse] = {}
        self._kinds: dict[str, str] = {}
        for path in sorted(fixture_dir.glob("*.json")):
            if path.name == "index.json":
                continue
            fixture = Fixture.model_validate(json.loads(path.read_text(encoding="utf-8")))
            if fixture.source and fixture.expected_analysis:
                self._responses[fixture.source.id] = fixture.expected_analysis
                self._kinds[fixture.source.id] = fixture.source.kind.value

    @property
    def source_ids(self) -> list[str]:
        return sorted(self._responses)

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResponse:
        response = self._responses.get(request.source_id)
        if response is None:
            raise ApiFault(
                422,
                "unknown_source",
                f"桩服务没有该 source_id 的 fixture，可用：{', '.join(self.source_ids)}",
            )
        if self._kinds[request.source_id] != request.kind.value:
            raise ApiFault(422, "kind_mismatch", "请求的 kind 与该 fixture 的资料类型不一致")
        return response


def _to_fault(exc: ModelError) -> ApiFault:
    # 只把 kind 落日志，厂家返回的详情一律不外泄、也不进日志（可能含用户内容）
    log_event("model_error", kind=exc.kind, profile=exc.profile, retryable=exc.retryable)
    if exc.kind == "invalid_output":
        return ApiFault(422, "model_output_invalid", "未能从资料中提取有效字段，原资料已保留，可以重试或手动整理", True)
    return ApiFault(503, "model_unavailable", "模型暂不可用，请改用仅保存；原图已在本地保留", True)


class ModelProvider:
    name = "model"

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router

    def _ensure_router(self) -> ModelRouter:
        if self._router is None:
            self._router = build_router()
        return self._router

    @property
    def ready(self) -> bool:
        try:
            self._ensure_router()
        except ModelError:
            return False
        return True

    @property
    def source_ids(self) -> list[str]:
        return []

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResponse:
        try:
            router = self._ensure_router()
        except ModelError as exc:
            raise _to_fault(exc) from exc

        settings = get_settings()
        image_b64 = strip_data_url(request.image_base64) if request.image_base64 else None
        # 真实模型路径：先严格校验图片（base64/格式/字节/像素/完整解码），非法输入在调模型前拒绝
        media_type = (
            inspect_image(
                image_b64,
                max_bytes=settings.max_image_bytes,
                max_pixels=settings.max_image_pixels,
                max_side=settings.max_image_side,
            )
            if image_b64
            else "image/png"
        )

        def validate(text: str, profile_name: str) -> AnalyzeResponse:
            return parse_model_output(
                text,
                source_id=request.source_id,
                model_name=profile_name,
                user_reference_at=request.reference_at,
                max_output_chars=settings.max_output_chars,
            )

        try:
            response, profile_name = router.complete(
                system=SYSTEM_PROMPT,
                user_text=build_user_text(request),
                image_b64=image_b64,
                media_type=media_type,
                validate=validate,
                budget_s=settings.analyze_budget_s,
            )
        except ModelError as exc:
            raise _to_fault(exc) from exc

        log_event(
            "model_analyze",
            source_id=request.source_id,
            profile=profile_name,
            content_type=response.content_type.value,
            field_count=len(response.fields),
        )
        return response


@lru_cache(maxsize=1)
def get_provider() -> AnalyzeProvider:
    settings = get_settings()
    if settings.provider == "fixture":
        return FixtureProvider()
    if settings.provider == "model":
        return ModelProvider()
    raise ApiFault(503, "provider_unavailable", f"JXL_PROVIDER={settings.provider} 只能是 fixture 或 model")


ProviderDep = Annotated[AnalyzeProvider, Depends(get_provider)]


# ---------------------------------------------------------------- M2 propose


class ProposeProvider(Protocol):
    name: str
    ready: bool

    def propose(self, request: AssistantProposeRequest) -> AssistantProposeResponse: ...


def _propose_to_fault(exc: ModelError) -> ApiFault:
    log_event("propose_model_error", kind=exc.kind, profile=exc.profile, retryable=exc.retryable)
    if isinstance(exc, PlanOutputError):
        reason = {
            "json": "未能读出完整的方案",
            "size": "生成的方案过长",
            "shape": "方案字段未通过检查",
            "reference": "方案中的任务或工作项关联有误",
            "semantics": "方案的归属或依据未通过核对",
        }[exc.category]
        retry = "，自动修正后仍未通过" if exc.repair_attempted else ""
        return ApiFault(502, "model_output_invalid", f"{reason}{retry}。输入已保留，可以重新生成。",
                        True, {"stage": "propose", "category": exc.category, "path": exc.path, "attempts": exc.attempts})
    if exc.kind == "invalid_output":
        return ApiFault(502, "model_output_invalid", "未能读取规划服务的响应，输入已保留，可以重新生成。", True)
    if exc.kind == "timeout":
        return ApiFault(504, "propose_timeout", "生成总时限耗尽，输入已保留，可重新生成", True)
    if exc.kind == "quota_exhausted":
        return ApiFault(429, "quota_exhausted", "今日模型调用额度已用尽，输入已保留；本地手动功能照常", False)
    return ApiFault(503, "model_unavailable", "模型暂不可用，输入已保留；本地手动功能照常", True)


class FixtureProposeProvider:
    """确定性桩：按请求快照生成形状合法的建議，供离线开发与前端验证。

    触发词「澄清演示」→ clarification；否则 proposal。选定既有任务/行动时追加
    link/reuse 建议。桩输出不是真实模型理解，真实闭环验证必须走 model 模式。
    """

    name = "fixture"
    ready = True

    def propose(self, request: AssistantProposeRequest) -> AssistantProposeResponse:
        if "澄清演示" in request.user_message:
            payload = ClarificationPayload(questions=[
                ClarificationQuestion(
                    question_id="q1",
                    question="这份资料要求完成哪些具体内容？请补充说明。",
                    options=["按原文全部要求", "只做核心部分"],
                    blocking_reason="桩演示：缺少可拆解的具体要求。",
                ),
            ])
        elif request.replan_context is not None:
            payload = self._replan_payload(request)
        else:
            if request.selected_sources:
                s = request.selected_sources[0]
                ev = SourceExcerptEvidence(source_id=s.source_id, excerpt=(s.excerpt or "（桩）选定资料原文")[:2000])
            else:
                ev = UserMessageEvidence(turn_id=request.turn_id, excerpt=request.user_message[:2000])
            title = "完成资料要求（桩建议）"
            tasks = [
                TaskProposalCreate(
                    key="t1", title=title,
                    evidence_refs=[ev],
                ),
            ]
            actions = [
                ActionProposalCreate(key="a1", task_ref=DraftRef(key="t1"), text=title, minutes=105, basis="suggestion"),
            ]
            work = [
                WorkItemProposal(key="w1", task_ref=DraftRef(key="t1"), action_ref=DraftRef(key="a1"), deliverable=title, remaining_minutes=105),
            ]
            if request.selected_tasks:
                t = request.selected_tasks[0]
                tasks.append(TaskProposalLink(key="t2", target_id=t.id, evidence_refs=[ev]))
                reusable = next((a for a in request.selected_actions if a.task_id == t.id and not a.done), None)
                if reusable is not None:
                    actions.append(ActionProposalReuse(key="a3", target_id=reusable.id, task_ref=ExistingRef(id=t.id), evidence_refs=[ev]))
                    work.append(WorkItemProposal(
                        key="w3", task_ref=ExistingRef(id=t.id), action_ref=ExistingRef(id=reusable.id),
                        deliverable="既有行动续做", remaining_minutes=reusable.minutes,
                    ))
            payload = ProposalPayload(proposal=AssistantModelProposal(
                task_proposals=tasks, action_proposals=actions, work_items=work,
            ))
        return AssistantProposeResponse(
            protocol_version=request.protocol_version,
            request_id=request.request_id, thread_id=request.thread_id, turn_id=request.turn_id,
            client_seq=request.client_seq, workspace_id=request.workspace_id, payload=payload,
        )

    def _replan_payload(self, request: AssistantProposeRequest):
        """桩改排：单 link 目标任务 + 逐行复用/新建行动；未知分钟数 → 澄清。

        澄清续轮：回答是正整数时采用回答值（问题文本按本桩自己的格式精确匹配，不猜自由文本）。
        估时来源仍标 model（桩建议不是用户确认值），采用前须用户核对清单。
        """
        rc = request.replan_context
        if request.user_input is not None and request.user_input.original_user_request.strip():
            ev = UserMessageEvidence(turn_id=request.turn_id, excerpt=request.user_input.original_user_request[:2000])
        elif request.user_message.strip():
            ev = UserMessageEvidence(turn_id=request.turn_id, excerpt=request.user_message[:2000])
        else:
            ev = ExistingFactEvidence(object_type="task", object_id=rc.task_id)

        def minutes_question(text: str) -> str:
            return f"「{text}」还需要多少分钟？未知工作量无法排程。"

        def resolved(w) -> int | None:
            if w.minutes is not None:
                return w.minutes
            if request.user_input is None:
                return None
            q = minutes_question(w.text)
            for t in request.user_input.clarifications:
                a = t.user_answer.strip()
                if t.assistant_question == q and a.isdigit() and 0 < int(a) <= JS_SAFE_INT_MAX:
                    return int(a)
            return None

        minutes_of = {w.key: resolved(w) for w in rc.progress.work_items}
        unknown = next((w for w in rc.progress.work_items if minutes_of[w.key] is None), None)
        if unknown is not None:
            return ClarificationPayload(questions=[
                ClarificationQuestion(
                    question_id="q1",
                    question=minutes_question(unknown.text),
                    blocking_reason="桩演示：待安排清单存在未知分钟数，须用户补充。",
                ),
            ])
        actions = []
        work = []
        for i, w in enumerate(rc.progress.work_items, 1):
            m = minutes_of[w.key]
            if w.reuse_action_id is not None:
                akey = f"ra{i}"
                actions.append(ActionProposalReuse(key=akey, target_id=w.reuse_action_id, task_ref=ExistingRef(id=rc.task_id), evidence_refs=[ev]))
                aref = ExistingRef(id=w.reuse_action_id)
            else:
                akey = f"na{i}"
                actions.append(ActionProposalCreate(key=akey, task_ref=ExistingRef(id=rc.task_id), text=w.text, minutes=m, basis="suggestion"))
                aref = DraftRef(key=akey)
            work.append(WorkItemProposal(
                key=f"rw{i}", task_ref=ExistingRef(id=rc.task_id), action_ref=aref,
                deliverable=w.text, remaining_minutes=m,
                splittable=w.splittable, min_segment_minutes=w.min_segment_minutes if w.min_segment_minutes is not None else 25,
            ))
        return ProposalPayload(proposal=AssistantModelProposal(
            task_proposals=[TaskProposalLink(key="rtask", target_id=rc.task_id, evidence_refs=[ev])],
            action_proposals=actions, work_items=work,
        ))


class ModelProposeProvider:
    name = "model"

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router

    def _ensure_router(self) -> ModelRouter:
        if self._router is None:
            self._router = build_router(max_tokens_cap=LIMITS["propose_profile_max_tokens"]["value"])
        return self._router

    @property
    def ready(self) -> bool:
        try:
            self._ensure_router()
        except ModelError:
            return False
        return True

    def propose(self, request: AssistantProposeRequest) -> AssistantProposeResponse:
        try:
            router = self._ensure_router()
        except ModelError as exc:
            raise _propose_to_fault(exc) from exc
        settings = get_settings()
        compact = uses_task_list(request)
        if compact and (question := role_question(request)):
            log_event("plan_review", action="ask_user", reason="role_specific_plan")
            return propose_response(request, question)
        scoped_issue = None
        reviewing = False
        max_bytes = LIMITS["max_model_output_bytes"]["value"]

        def validate(text: str, profile_name: str) -> AssistantProposeResponse:
            nonlocal scoped_issue, reviewing
            raw = {}
            if isinstance(text, str) and len(text.encode("utf8")) <= max_bytes:
                try:
                    raw = _extract_json(text)
                except ModelError:
                    pass  # The normal validator supplies the public diagnostic.
            plan_text = text
            if reviewing and isinstance(raw.get("diagnosis"), str):
                plan_text = json.dumps({k: v for k, v in raw.items() if k != "diagnosis"}, ensure_ascii=False)
            try:
                if scoped_issue is not None:
                    return apply_external_step_repair(plan_text, scoped_issue, request, max_bytes)
                return parse_propose_output(plan_text, request, max_output_bytes=max_bytes)
            except PlanOutputError as issue:
                reviewing = True
                if scoped_issue is not None:
                    issue.repair_inputs = scoped_issue.repair_inputs
                elif isinstance(issue, ExternalStepSplitNeeded):
                    issue.repair_inputs = external_step_repair_inputs(request, issue)
                    if issue.repair_inputs:
                        scoped_issue = issue
                        log_event("plan_review", action="source_lookup", reason="external_step_split")
                issue.review_snapshot = review_snapshot(raw, scoped=scoped_issue is not None)
                raise

        try:
            response, profile_name = router.complete(
                system=(render_task_list_prompt(with_time_nodes=bool(source_time_nodes(request.selected_sources)),
                                                text_only=bool(request.selected_sources) and all(
                                                    s.kind == "text" and not s.note_candidates for s in request.selected_sources))
                        if compact else render_propose_system_prompt(request.intent.value)),
                user_text=build_propose_user_text(request),
                image_b64=None,
                media_type="image/png",
                validate=validate,
                budget_s=settings.propose_budget_s,
                max_attempts=settings.propose_max_attempts,
            )
        except ModelError as exc:
            raise _propose_to_fault(exc) from exc
        log_event(
            "model_propose",
            request_id=request.request_id,
            profile=profile_name,
            payload_kind=response.payload.kind,
        )
        return response


@lru_cache(maxsize=1)
def get_propose_provider() -> ProposeProvider:
    settings = get_settings()
    if settings.provider == "fixture":
        return FixtureProposeProvider()
    if settings.provider == "model":
        return ModelProposeProvider()
    raise ApiFault(503, "provider_unavailable", f"JXL_PROVIDER={settings.provider} 只能是 fixture 或 model")


ProposeProviderDep = Annotated[ProposeProvider, Depends(get_propose_provider)]
