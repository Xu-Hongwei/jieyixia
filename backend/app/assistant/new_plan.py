"""Model-facing shorthand for new tasks. The HTTP and scheduling contracts stay canonical."""

import re
from typing import Annotated, Literal

from pydantic import Field, StrictInt, StringConstraints, ValidationError, field_validator

from contract.models import (
    ContractModel, DeadlineCandidate, EvidenceRef, JS_SAFE_INT_MAX, LIMITS, NoteFieldEvidence,
    PendingDate, Priority, SourceExcerptEvidence, Strength, TimeNode, UserMessageEvidence,
)
from ..model.base import PlanOutputError
from ..observability import log_event
from ..time_rules import BEIJING, interpret_instant, parse_iso_date


# An inferred clock time must at least cite wording about a time of day.
_CLOCK_IN_QUOTE = re.compile(r"\d{1,2}[:：]\d{2}|[\d一二三四五六七八九十两半]+\s*[点时]|正午|午夜|零点|中午|凌晨|傍晚|上午|下午|晚上|半夜|noon|midnight|\b\d{1,2}\s*[ap]\.?m\b", re.I)


def uses_task_list(request) -> bool:
    # Existing-task links and edits to existing constraints need the full protocol.
    return (request.intent.value == "new_plan" and not request.selected_tasks and not request.selected_actions
            and not request.confirmed_requirements and not request.pending_requirements and not request.previous_draft)


def source_fields(sources):
    """Compact evidence references shared by the prompt and validation."""
    keys = dict.fromkeys((f.note_id, f.field_key) for s in sources for f in s.note_candidates
                         if f.status.value != "missing" and (f.value is not None or f.raw or f.quote_text))
    return dict(enumerate(keys, start=1))


def source_time_nodes(sources):
    """One request-local catalogue, in the same order for the prompt and its parser."""
    catalogue = {}
    for source in sources:
        for field in source.note_candidates:
            if (field.field_key != "time_nodes" or field.status.value not in ("confirmed", "candidate")
                    or not isinstance(field.value, list)):
                continue
            for item in field.value:
                try:
                    node = TimeNode.model_validate(item)
                    if (not node.value or node.basis == "superseded" or node.role not in ("submission_deadline", "event_start")
                            or node.precision not in ("date", "datetime")):
                        continue
                    if node.precision == "date":
                        parse_iso_date(node.value)
                    else:
                        if "T" not in node.value:
                            continue
                        interpret_instant(node.value)
                    if node.basis in ("relative", "inferred") and not (node.reference_at or node.message_date or field.status.value == "confirmed"):
                        continue
                except (ValidationError, ValueError, OverflowError):
                    continue
                catalogue[len(catalogue) + 1] = (field.note_id, node)
    return catalogue


class PlannedTask(ContractModel):
    pending_date: PendingDate | None = None
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    minutes: int = Field(strict=True, gt=0, le=JS_SAFE_INT_MAX)
    description: str = Field(default="", max_length=4000)
    completion_criteria: str | None = Field(default=None, max_length=2000)
    deadline_candidates: list[DeadlineCandidate] = Field(default_factory=list, max_length=10)
    evidence_refs: list[EvidenceRef] = Field(default_factory=list, max_length=20)
    fact_refs: list[Annotated[int, Field(strict=True, ge=1)]] = Field(default_factory=list, max_length=20)
    earliest_date: str | None = None
    time_nodes: list[Annotated[int, Field(strict=True, ge=1)]] = Field(default_factory=list, max_length=10)
    after: list[Annotated[int, Field(strict=True, ge=1)]] = Field(default_factory=list, max_length=20)
    priority: Priority = Priority.normal
    splittable: bool = True
    min_segment_minutes: int = Field(default=25, ge=1, le=240)

    @field_validator("after", mode="before")
    @classmethod
    def normalize_task_indices(cls, value):
        # An explicit single index and [index] express the same prerequisite.
        if type(value) is int or isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            return [
                int(i) if isinstance(i, str) and i.isascii() and i.isdecimal() and len(i) <= 3 else i
                for i in value
            ]
        return value


class PlanConstraint(ContractModel):
    type: Literal["daily_budget", "unavailable_days", "start_date", "min_segment_minutes"]
    value: StrictInt | str | list[str] | None
    strength: Strength = Strength.hard
    provenance: Literal["user", "source", "model"] = "model"
    evidence_refs: list[EvidenceRef] = Field(default_factory=list, max_length=20)


class ExternalStepSplitNeeded(PlanOutputError):
    def __init__(self, plan, index, before, after, event, passage):
        super().__init__("semantics", "同一项含现在可办及外部事件发生后才能办的两步。按原文拆开，后项保留待定事件。", f"tasks.{index}.title")
        self.plan = plan
        self.index = index
        self.before = before
        self.after = after
        self.event = event
        self.passage = passage


def external_step(title, passages):
    """Only split when the source explicitly gates the second action in a compound title."""
    parts = re.split(r"(?:并且|然后|并|以及|，再)", title, maxsplit=1)
    if len(parts) != 2 or min(map(len, parts)) < 2:
        return None
    before, after = parts
    if after[:2] in before:
        return None
    for passage in passages:
        for clause in re.split(r"[；;！!？?\n]", passage):
            # Some notices end the condition with a full stop before giving the instruction.
            for match in re.finditer(r"(?:^|[，,。])\s*(?P<event>[^，,。]{2,40}?)(?:之后|以后|后[方才]?|(?<=审核)。|(?<=审批)。)"
                                     r"[，,\s]*(?:方可|才能|才可|即可|再|自行|请|可|并)*"
                                     + re.escape(after[:2]) + r"[^，,。]{0,80}", clause):
                event = match["event"].strip()
                if (re.search(r"无需|不必|不用|不需要|无须|自行|本人", event)
                        or not re.search(r"收到|获准|通过|审核|审批|确认|反馈|公布|通知|到账|到货", event)):
                    continue
                return before, after, event, match[0].strip("，,。 ")
    return None


class NewTaskList(ContractModel):
    kind: Literal["task_list"]
    tasks: list[PlannedTask] = Field(min_length=1, max_length=LIMITS["max_targets"]["value"])
    constraints: list[PlanConstraint] = Field(default_factory=list, max_length=50)

    @field_validator("tasks", mode="before")
    @classmethod
    def normalize_event_markers(cls, rows):
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            return rows
        tasks = [dict(row) for row in rows]
        for task in tasks:
            if task.get("pending_date") is True and "event" in task and "offset_days" in task:
                task["pending_date"] = {key: task.pop(key) for key in ("event", "offset_days", "sets_deadline") if key in task}

        # A passive publication milestone may be omitted only when its dependents
        # already carry the event, and no real work or dated fact would be lost.
        markers = set()
        for index, task in enumerate(tasks, 1):
            title = task.get("title")
            if (set(task) <= {"title", "minutes", "description", "pending_date", "after", "fact_refs", "splittable"}
                    and isinstance(title, str) and re.fullmatch(r"等待[\w·]{0,40}(?:通知|公布|发布)", title)
                    and not re.search(r"填写|提交|上传|确认|联系|报名|转发|领取|打印|查询|回复|登记", title)
                    and (task.get("minutes") is None or type(task["minutes"]) is int and task["minutes"] == 0)
                    and not task.get("after")
                    and not (isinstance(task.get("pending_date"), dict) and task["pending_date"].get("sets_deadline"))):
                markers.add(index)
        if not markers or len(tasks) > LIMITS["max_targets"]["value"]:
            return tasks
        referenced = set()
        for index, task in enumerate(tasks, 1):
            deps = PlannedTask.normalize_task_indices(task.get("after", []))
            if not isinstance(deps, list) or any(type(i) is not int or not 1 <= i < index for i in deps) or len(set(deps)) != len(deps):
                return tasks
            task["after"] = deps
            for dep in markers.intersection(deps):
                if not isinstance(task.get("pending_date"), dict):
                    return tasks
                referenced.add(dep)
        if referenced != markers:
            return tasks
        kept = [i for i in range(1, len(tasks)+1) if i not in markers]
        renumber = {old: new for new, old in enumerate(kept, 1)}
        for i in kept:
            tasks[i-1]["after"] = [renumber[j] for j in tasks[i-1]["after"] if j not in markers]
        log_event("plan_review", action="local_normalization", reason="passive_notice", count=len(markers))
        return [tasks[i-1] for i in kept]

    def applicability_question(self, user_input) -> dict | None:
        """An explicitly conditional task needs a choice before it consumes capacity."""
        for i, task in enumerate(self.tasks):
            match = re.fullmatch(r"(.+?)[（(](?:如适用|若适用|如需|如果适用)[）)]", task.title)
            if not match:
                continue
            title = match[1].strip()
            question = f"这次需要安排「{title}」吗？"
            if user_input and any(c.assistant_question == question for c in user_input.clarifications):
                raise PlanOutputError("semantics", "用户已回答适用条件。按答复保留或移除该分支，勿再次标为如适用。", f"tasks.{i}.title")
            return {"kind": "clarification", "questions": [{"question_id": f"applicable-{i+1}",
                    "question": question, "options": [f"需要{title}", f"无需{title}"],
                    "blocking_reason": "资料中的这项工作有适用条件，需要确认后再安排。"}]}
        return None

    def as_proposal(self, sources) -> dict:
        catalogue = source_time_nodes(sources)
        fields = source_fields(sources)
        excerpts = {s.source_id: s.excerpt or "" for s in sources}
        note_fields = {(c.note_id, c.field_key) for s in sources for c in s.note_candidates}

        def check_evidence(refs, path):
            for ref in refs:
                if isinstance(ref, NoteFieldEvidence) and (ref.note_id, ref.field_key) not in note_fields:
                    raise PlanOutputError("reference", "请引用本轮选定资料中实际提供的便签字段。", path)
                if isinstance(ref, SourceExcerptEvidence) and (
                    not ref.excerpt.strip() or ref.excerpt not in excerpts.get(ref.source_id, "")
                ):
                    raise PlanOutputError("reference", "文字摘录须逐字来自该资料；截图请引用对应便签字段。", path)

        passages = [s.excerpt for s in sources if s.excerpt]
        for s in sources:
            for field in s.note_candidates:
                if field.status.value in ("confirmed", "candidate"):
                    passages.extend(value for value in (field.quote_text, field.raw) if value)
        tasks, actions, work = [], [], []
        timings = {}
        for n, task in enumerate(self.tasks, start=1):
            check_evidence(task.evidence_refs, f"tasks.{n - 1}.evidence_refs")
            for i, dl in enumerate(task.deadline_candidates):
                path = f"tasks.{n - 1}.deadline_candidates.{i}.evidence_refs"
                check_evidence(dl.evidence_refs, path)
                if (dl.basis == "inferred" and dl.precision == "datetime" and dl.evidence_refs
                        and all(isinstance(ref, (SourceExcerptEvidence, UserMessageEvidence)) for ref in dl.evidence_refs)
                        and not any(_CLOCK_IN_QUOTE.search(ref.excerpt) for ref in dl.evidence_refs)):
                    raise PlanOutputError("reference", "摘录没有给出截止时刻。确有截止日才保留 date 精度；"
                                          "建议提前准备只写入 description。", path)
            if any(i >= n for i in task.after) or len(set(task.after)) != len(task.after):
                raise PlanOutputError("reference", "按先后排列任务；after 只填此前任务的不重复序号，从 1 开始。",
                                      f"tasks.{n - 1}.after")
            task_ref = {"kind": "draft", "key": f"t{n}"}
            core = task.model_dump(mode="json", include={
                "title", "description", "completion_criteria", "deadline_candidates", "evidence_refs",
            })
            for candidate, value in zip(task.deadline_candidates, core["deadline_candidates"]):
                if candidate.precision != "datetime" or candidate.basis != "explicit" or not candidate.evidence_refs:
                    continue
                if not all(isinstance(ref, SourceExcerptEvidence) for ref in candidate.evidence_refs):
                    continue
                # Reduce precision only when the cited calendar date is literally present.
                # A real clock elsewhere in the source may qualify an abbreviated quotation.
                day = candidate.value[:10]
                year, month, date = day.split("-")
                quoted = " ".join(ref.excerpt for ref in candidate.evidence_refs)
                if ((day in quoted or f"{year}年{int(month)}月{int(date)}日" in quoted)
                        and not any(_CLOCK_IN_QUOTE.search(excerpts[ref.source_id]) for ref in candidate.evidence_refs)):
                    value.update(value=day, precision="date")
            earliest = task.earliest_date
            pending = task.pending_date
            if pending and pending.offset_days is not None:
                anchor = re.fullmatch(r"(.+?)(?:日期|时间)(?:的)?(?:公布|发布|公告)", pending.event)
                if anchor:
                    base = anchor[1]
                    # The date of publication can itself be a valid anchor. Only recover
                    # the event when the source states a before/after relation to it.
                    relation = re.escape(base) + (r"(?:之)?前" if pending.offset_days < 0 else
                                                  r"(?:之)?后" if pending.offset_days > 0 else r"(?:当日|当天)")
                    announcement = re.escape(base) + r"(?:日期|时间).{0,8}(?:公布|发布|公告)(?:之)?(?:前|后|当天|当日)"
                    if any(re.search(relation, p) for p in passages) and not any(re.search(announcement, p) for p in passages):
                        pending = pending.model_copy(update={"event": base})
            if len(sources) == 1 and (split := external_step(task.title, passages)):
                raise ExternalStepSplitNeeded(self, n-1, *split)
            parents = [timings[i] for i in task.after if i in timings]
            events = {parent.event for parent in parents}
            if pending is None and len(events) == 1 and not (earliest or task.deadline_candidates or task.time_nodes):
                pending = PendingDate(event=next(iter(events)), offset_days=None)
            if pending:
                if earliest or task.deadline_candidates or task.time_nodes:
                    raise PlanOutputError("semantics", "同一任务同时给了确定日期和待公布事件。拆开独立时间节点或采用已确认日期。", f"tasks.{n-1}.pending_date")
                # Printing an approved document has an external prerequisite.
                # Never turn an estimated lead day into permission to print it.
                if (re.search(r"打印|领取", task.title) and pending.offset_days is not None and not pending.sets_deadline
                        and (re.search(r"(审核|审批)通过后", task.description) or
                             any(re.search(r"审核|审批", self.tasks[i-1].title) for i in task.after))):
                    pending = pending.model_copy(update={"offset_days": None})
                timings[n] = pending
                core["pending_date"] = pending.model_dump()
            elif (re.search(r"参加|出席|到场|参赛|赴会", task.title)
                  and re.search(r"(?:日期|时间)(?:和地点)?(?:尚未公布|未公布|待公布|未定|待定|另行通知|需等待后续通知)", task.description)
                  and not (earliest or task.time_nodes)):
                raise PlanOutputError("semantics", "这项活动明确要等通知。请填写 pending_date 并为依赖它的任务标明相对日期。", f"tasks.{n-1}.pending_date")
            for i in task.after:
                before = timings.get(i)
                if before and (not pending or
                               (pending.event == before.event and pending.offset_days is not None and before.offset_days is not None
                                and pending.offset_days < before.offset_days)):
                    raise PlanOutputError("semantics", "前置任务的日期尚未确定。请核对事件及先后顺序；关系不明确时追问。", f"tasks.{n-1}.after")
            for index in task.fact_refs:
                if index not in fields:
                    raise PlanOutputError("reference", "请使用本轮资料字段编号。", f"tasks.{n - 1}.fact_refs")
                note_id, field_key = fields[index]
                evidence = {"kind": "note_field", "note_id": note_id, "field_key": field_key}
                if evidence not in core["evidence_refs"]:
                    core["evidence_refs"].append(evidence)
            start = None
            path = f"tasks.{n - 1}.time_nodes"
            if len(set(task.time_nodes)) != len(task.time_nodes):
                raise PlanOutputError("reference", "同一任务中每个时间节点只选一次。", path)
            for index in task.time_nodes:
                if index not in catalogue:
                    raise PlanOutputError("reference", "请选择本轮时间节点表中存在的序号。", path)
                note_id, node = catalogue[index]
                evidence = {"kind": "note_field", "note_id": note_id, "field_key": "time_nodes"}
                if evidence not in core["evidence_refs"]:
                    core["evidence_refs"].append(evidence)
                if node.role == "submission_deadline":
                    if task.deadline_candidates:
                        raise PlanOutputError("shape", "使用截止节点时只选节点，删除重复填写的截止候选。", path)
                    facts = {"value": node.value, "precision": node.precision, "basis": node.basis, "derived": node.derived}
                    existing = next((c for c in core["deadline_candidates"] if all(c[k] == v for k, v in facts.items())), None)
                    if existing is None:
                        core["deadline_candidates"].append({**facts, "evidence_refs": [evidence]})
                    elif evidence not in existing["evidence_refs"]:
                        existing["evidence_refs"].append(evidence)
                else:
                    if start is not None:
                        raise PlanOutputError("reference", "一项活动只能选择一个开始节点；时刻冲突且没有明确更新时，请询问用户。", path)
                    start = node.value
                    event_day = start if node.precision == "date" else interpret_instant(start).astimezone(BEIJING).date().isoformat()
                    if earliest and earliest != event_day:
                        raise PlanOutputError("reference", "活动最早执行日与来源日期冲突；保留活动开始节点。", path)
                    earliest = event_day
                    core["description"] = "\n".join(filter(None, [core["description"], f"活动开始：{start}"]))
            tasks.append({"op": "create", "key": f"t{n}", **core})
            actions.append({"op": "create", "key": f"a{n}", "task_ref": task_ref,
                            "text": task.title, "minutes": task.minutes, "basis": "suggestion"})
            work.append({"key": f"w{n}", "task_ref": task_ref, "action_ref": {"kind": "draft", "key": f"a{n}"},
                         "deliverable": task.title, "remaining_minutes": task.minutes,
                         "depends_on": [f"w{i}" for i in task.after],
                         "earliest_date": earliest, **task.model_dump(mode="json", include={"splittable", "min_segment_minutes", "priority"})})
        for i, constraint in enumerate(self.constraints):
            check_evidence(constraint.evidence_refs, f"constraints.{i}.evidence_refs")
        return {"kind": "proposal", "proposal": {
            "task_proposals": tasks, "action_proposals": actions, "work_items": work,
            "requirement_candidates": [dict(c.model_dump(mode="json"), key=f"r{n}")
                                       for n, c in enumerate(self.constraints, start=1)],
        }}
