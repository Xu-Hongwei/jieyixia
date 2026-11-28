"""Review a new plan against selected event notices and named submission materials."""

import re
from collections import Counter, defaultdict
from datetime import date

from contract.models import ClarificationPayload, TimeNode
from pydantic import ValidationError

from ..model.base import PlanOutputError
from ..time_rules import BEIJING, interpret_instant


_DATE_RANGE = re.compile(
    r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?\s*(?:至|到|[-—–~～])\s*"
    r"(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})[日号]"
)
_EVENTS = (
    ("比赛", r"比赛|竞赛|赛事|马拉松|赛程|参赛"),
    ("培训", r"培训|讲习班"),
    ("会议", r"会议|研讨会|交流会|宣讲会"),
)
_PREPARATION = re.compile(r"报名|组队|准备|查询|确认|材料|通知|了解|申请|缴费|登记")
_MATERIALS = (
    re.compile(r"\bPDF\b|PDF(?=[报告文档])", re.I | re.ASCII),
    re.compile(r"源(?:代)?码|源程序"),
    re.compile(r"截图|截[取屏][^，。；、]{0,8}(?:结果图|屏幕)"),
)
_PRODUCE = re.compile(r"编写|撰写|制作|生成|导出|截取|整理|完成|准备|编制|拍摄|绘制")
_HAND_IN = re.compile(r"提交|上传|交付|递交|交齐")
_NEGATIVE = re.compile(r"无需|无须|不必|不需要|不用|不含|不提交|不上传|不包括|已有|已备好")
_PREP_ONLY = re.compile(r"(?:只|仅)(?:需|要|想)?(?:规划|安排|处理|做)?(?:报名|登记|准备材料)(?:事项|流程|步骤|任务)?(?:[，。！？；]|$)")


def _submission_dependencies(proposal, sources):
    # In a multi-notice plan titles alone cannot tie a PDF to the right submission.
    if len(sources) > 1:
        return
    tasks = {t.key: t for t in proposal.task_proposals if t.op == "create"}
    by_task = defaultdict(list)
    for w in proposal.work_items:
        if w.task_ref.kind == "draft":
            by_task[w.task_ref.key].append(w)
    units = [(t, by_task[k][0]) for k, t in tasks.items() if len(by_task[k]) == 1]
    by_key = {w.key: w for w in proposal.work_items}

    def follows(key, predecessor):
        pending, visited = [key], set()
        while pending:
            current = pending.pop()
            if current == predecessor:
                return True
            if current in by_key and current not in visited:
                visited.add(current)
                pending.extend(by_key[current].depends_on)
        return False

    for task, hand_in in units:
        if not _HAND_IN.search(task.title):
            continue
        # A bundle must explicitly name several required artifacts in the same sentence.
        for sentence in re.split(r"[。！？；\n]", task.description):
            if not _HAND_IN.search(sentence) or _NEGATIVE.search(sentence):
                continue
            required = [pattern for pattern in _MATERIALS if pattern.search(sentence)]
            if len(required) < 2:
                continue
            for pattern in required:
                matching = [w for t, w in units if t != task and _PRODUCE.search(t.title)
                            and pattern.search(t.title)]
                if len(matching) == 1:
                    producer = matching[0].key
                    if not follows(hand_in.key, producer) and not follows(producer, hand_in.key):
                        if len(hand_in.depends_on) == 20:
                            raise PlanOutputError("semantics", "提交项依赖过多，请合并同一交付物的制作环节。")
                        hand_in.depends_on.append(producer)


def _source_events(sources):
    for source in sources:
        for field in source.note_candidates:
            if field.field_key != "time_nodes" or field.status.value not in ("confirmed", "candidate") or not isinstance(field.value, list):
                continue
            for item in field.value:
                try:
                    node = TimeNode.model_validate(item)
                except ValidationError:
                    continue
                if node.basis == "superseded" or node.role not in ("event_start", "other", "unknown"):
                    continue
                if re.search(r"报名|申请|提交|征集|取消", node.label):
                    continue
                span = _DATE_RANGE.search(node.raw)
                event = next(((name, words) for name, words in _EVENTS if re.search(words, node.label)), None)
                if not event:
                    continue
                if span and (node.role == "event_start" or re.search(r"举行|举办|赛程|赛期|会期|开赛", node.label + node.raw)):
                    yield field.note_id, node, span, event
                elif node.role == "event_start" and node.value:
                    if node.derived and not (node.reference_at or node.message_date or field.status.value == "confirmed"):
                        continue
                    yield field.note_id, node, None, event


def _within_range(day, span, node):
    if not day:
        return False
    if not span:
        if node.precision == "datetime":
            try:
                return day == interpret_instant(node.value).astimezone(BEIJING).date().isoformat()
            except (ValueError, OverflowError):
                return False
        return day == node.value
    y1, m1, d1, y2, m2, d2 = span.groups()
    anchor = node.reference_at or node.message_date or node.value
    # A draft with a concrete year cannot satisfy a notice with an unresolved year.
    if not y1 and not anchor:
        return False
    year = int(y1 or anchor[:4])
    try:
        first = date(year, int(m1), int(d1))
        month = int(m2 or m1)
        last = date(int(y2 or (year + (month < first.month))), month, int(d2))
        return first <= date.fromisoformat(day) <= last
    except ValueError:
        return False


def review_new_plan(proposal, request):
    """Return a scope question if needed. Resulting edges undergo normal cycle validation."""
    _submission_dependencies(proposal, request.selected_sources)
    tasks = {t.key: t for t in proposal.task_proposals if t.op == "create"}
    user_input = request.user_input
    original = user_input.original_user_request if user_input else request.user_message
    events = list(_source_events(request.selected_sources))
    counts = Counter((note_id, family[0]) for note_id, _, _, family in events)
    for note_id, node, span, (name, words) in events:
        # Alternative sessions are handled by the planner's selection question.
        # One chosen session must not trigger a new question about every other start.
        if not span and counts[note_id, name] > 1:
            continue
        label = node.label[:80]
        when = span[0] if span else node.value
        question = f"资料写有「{label}」（{when}），需要把参加{name}也加入计划吗？"
        include, omit = f"安排参加{name}", "仅安排其他事项"
        answer = next((c.user_answer.strip() for c in reversed(user_input.clarifications)
                       if c.assistant_question == question), None) if user_input else None
        covered = False
        for w in proposal.work_items:
            task = tasks.get(w.task_ref.key) if w.task_ref.kind == "draft" else None
            if not task or _PREPARATION.search(task.title) or not re.search(words, task.title):
                continue
            if len(request.selected_sources) > 1 and not any(getattr(r, "note_id", None) == note_id for r in task.evidence_refs):
                continue
            if _within_range(w.earliest_date, span, node):
                covered = True
                break
        excluded = answer == omit or (answer and re.fullmatch(r"(?:不参加|不用参加|不安排|不用安排|无需参加)(?:本次)?(?:比赛|培训|会议)?[。！]?", answer))
        if excluded or _PREP_ONLY.search(answer if answer is not None else original):
            if covered:
                raise PlanOutputError("semantics", "用户只要求办理其他事项，请去掉参加活动的工作项。")
            continue
        if covered:
            continue
        if answer:
            raise PlanOutputError("semantics", "用户已答复活动范围。请结合答复及通知日期生成参加活动的工作项，填写举行期间的 earliest_date。")
        return ClarificationPayload.model_validate({"kind": "clarification", "questions": [{
            "question_id": "event-participation", "question": question, "options": [include, omit],
            "blocking_reason": "当前草案尚未安排该活动期间的参与任务。",
        }]})
    return None
