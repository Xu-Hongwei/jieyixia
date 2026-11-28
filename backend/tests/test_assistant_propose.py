"""M2 propose 端点回归：协议/结构/语义拒绝、共享防护、体积/尝试/总预算、错误映射、隐私。

全部本地桩/假厂家（httpx.MockTransport），不联网、零真实费用。
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from app._contract import AssistantProposeRequest, AssistantProposeResponse, ResponsePayload
from app.assistant.prompt import render_propose_system_prompt, render_task_list_prompt
from app.assistant.semantics import build_request_context, check_proposal_semantics, _user_authored_segments
from app.config import get_settings
from app.guard import BEIJING, MODEL_QUOTA
from app.main import create_app
from app.model.adapters import OpenAICompatibleAdapter
from app.model.base import ModelProfile
from app.model.registry import ModelRouter, build_router
from app.providers import (
    FixtureProposeProvider,
    ModelProposeProvider,
    get_propose_provider,
    get_provider,
)

PAYLOAD_ADAPTER = TypeAdapter(ResponsePayload)


@pytest.mark.parametrize("notice,expected", [
    ("展览会前三天交付。展览会日期待公布。", "展览会"),
    ("展览会日期公布前三天完成平台测试。", "展览会日期公布"),
])
def test_pending_offset_uses_the_event_identified_in_the_notice(notice, expected):
    from app.assistant.new_plan import NewTaskList
    req = AssistantProposeRequest.model_validate(mk_request(selected_sources=[dict(mk_source(), excerpt=notice)]))
    plan = NewTaskList.model_validate({"kind": "task_list", "tasks": [{"title": "交付测试结果", "minutes": 15,
        "pending_date": {"event": "展览会日期公布", "offset_days": -3, "sets_deadline": True}}]})
    assert plan.as_proposal(req.selected_sources)["proposal"]["task_proposals"][0]["pending_date"]["event"] == expected


def test_external_gate_is_grounded_in_the_following_action():
    from app.assistant.new_plan import external_step
    assert external_step("传送初稿并发布成品", ["传送初稿，客户确认后发布成品。"])[2] == "客户确认"
    assert external_step("传送初稿并发布成品", ["无需客户确认后发布成品。"]) is None
    assert external_step("传送初稿并发布成品", ["客户确认后支付尾款。"]) is None


@pytest.mark.parametrize("second_date,requested,ask", [
    ("5", "帮我排", True), ("2", "帮我排", False),
    ("5", "我作为复核方", False), ("5", "帮我们统筹各方", False),
])
def test_parallel_deadlines_only_ask_if_the_answer_changes_the_personal_plan(second_date, requested, ask):
    from app.assistant.review_actions import role_question
    excerpt = f"按身份确定。经办方于2026年12月2日前交付，复核方于2026年12月{second_date}日前交付。"
    req = AssistantProposeRequest.model_validate(mk_request(user_message=requested, selected_sources=[dict(mk_source(), excerpt=excerpt)]))
    assert bool(role_question(req)) is ask


@pytest.mark.parametrize("message,second_work,expected_options", [
    ("给我排一下学生和导师这边的工作", "审核材料", ["学生", "导师"]),
    ("请制定计划", "审核材料", ["学生", "导师"]),
    ("我是学生，给我排个计划", "审核材料", []),
    ("请统筹各方工作", "审核材料", []),
    ("给我排个计划", "提交反馈", []),
])
def test_role_question_compares_work_without_deadlines(message, second_work, expected_options):
    from app.assistant.review_actions import role_question
    excerpt = f"工作分工：学生负责提交反馈，导师负责{second_work}。"
    req = AssistantProposeRequest.model_validate(mk_request(user_message=message, selected_sources=[dict(mk_source(), excerpt=excerpt)]))
    question = role_question(req)
    assert (question.questions[0].options if question else []) == expected_options


@pytest.mark.parametrize("suffix,expected", [("前交付。", "date"), ("23:59:59前交付。", "datetime")])
def test_text_deadline_precision_follows_the_source(suffix, expected):
    from app.assistant.new_plan import NewTaskList
    excerpt = "2026年12月2日" + suffix
    req = AssistantProposeRequest.model_validate(mk_request(selected_sources=[dict(mk_source(), excerpt=excerpt)]))
    source = req.selected_sources[0]
    plan = NewTaskList.model_validate({"kind": "task_list", "tasks": [{"title": "交付", "minutes": 20,
        "deadline_candidates": [{"value": "2026-12-02T23:59:59", "precision": "datetime", "basis": "explicit",
                                 "evidence_refs": [{"kind": "source_excerpt", "source_id": source.source_id, "excerpt": excerpt}]}]}]})
    assert plan.as_proposal([source])["proposal"]["task_proposals"][0]["deadline_candidates"][0]["precision"] == expected

SECRET_MARKER = "USER-PRIVATE-要求原文-MARKER"


def mk_request(**over) -> dict:
    today = datetime.now(BEIJING).date()
    days = [
        {"date": (today + timedelta(days=i)).isoformat(), "budget_minutes": 60, "committed_minutes": 0}
        for i in range(7)
    ]
    base = {
        "protocol_version": "1.0",
        "request_id": "req-t1",
        "thread_id": "th-t1",
        "turn_id": "turn-t1",
        "client_seq": 1,
        "workspace_id": "ws-test",
        "intent": "new_plan",
        "user_message": "每天45分钟，周三没空，请拆解报告任务。" + SECRET_MARKER,
        "selected_sources": [],
        "selected_tasks": [],
        "selected_actions": [],
        "planning_context": {
            "timezone": "Asia/Shanghai",
            "today": today.isoformat(),
            "start_date": today.isoformat(),
            "horizon_days": 7,
            "days": days,
            "protected_plans": [],
        },
        "confirmed_requirements": [],
        "pending_requirements": [],
        "previous_draft": None,
    }
    base.update(over)
    return base


def mk_source(source_id: str = "src-1", note_id: str = "note-1") -> dict:
    return {
        "source_id": source_id,
        "kind": "text",
        "fingerprint": {"sha256": "ab" * 32, "bytes": 128},
        "excerpt": "周五交报告，包含资料整理与结论。",
        "note_candidates": [
            {"note_id": note_id, "field_key": "deadline", "value": "2026-11-27",
             "raw": "周五交报告", "origin": "model", "status": "candidate"},
        ],
    }


def mk_task(task_id: str = "task-1", note_id: str | None = None) -> dict:
    deadline = {"value": None, "precision": "none", "source": "note", "from_note_id": None, "confirmed_at": None}
    if note_id:
        deadline = {"value": "2026-11-27", "precision": "date", "source": "note",
                    "from_note_id": note_id, "confirmed_at": "2026-11-25T09:00:00+08:00"}
    return {"id": task_id, "title": "既有任务", "status": "todo", "deadline": deadline,
            "current_action_id": None, "updated_at": "2026-11-25T09:00:00+08:00"}


def mk_action(action_id: str = "act-1", task_id: str = "task-1", done: bool = False) -> dict:
    return {"id": action_id, "task_id": task_id, "text": "整理资料", "minutes": 45,
            "basis": "user", "done": done}


def vendor(payload: dict) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]})


def test_personal_qwen_propose_uses_own_key_and_contract(client, monkeypatch):
    from app.qwen import HOST, KEY_HEADER, MODEL, PersonalQwenAdapter

    def respond(self, url, headers, payload, deadline=None):
        assert url == HOST + "/compatible-mode/v1/chat/completions"
        assert headers["Authorization"] == "Bearer sk-personal-unit-test"
        assert payload["model"] == MODEL
        return vendor(proposal_payload()).json()

    monkeypatch.setattr(PersonalQwenAdapter, "_post", respond)
    response = client.post("/api/qwen/propose", headers={KEY_HEADER: "sk-personal-unit-test"}, json=mk_request())
    assert response.status_code == 200, response.text
    assert response.json()["payload"]["kind"] == "proposal"


def proposal_payload(source_id: str | None = None, turn_id: str = "turn-t1") -> dict:
    if source_id:
        ev = {"kind": "source_excerpt", "source_id": source_id, "excerpt": "周五交报告"}
    else:
        ev = {"kind": "user_message", "turn_id": turn_id, "excerpt": "每天45分钟"}
    start = datetime.now(BEIJING).date()
    return {
        "kind": "proposal",
        "proposal": {
            "task_proposals": [{
                "op": "create", "key": "t1", "title": "完成报告",
                "deadline_candidates": [{
                    "value": (start + timedelta(days=2)).isoformat(), "precision": "date",
                    "basis": "explicit", "evidence_refs": [ev],
                }],
                "evidence_refs": [ev],
            }],
            "action_proposals": [{
                "op": "create", "key": "a1", "task_ref": {"kind": "draft", "key": "t1"},
                "text": "整理资料", "minutes": 45, "basis": "suggestion",
            }],
            "work_items": [{
                "key": "w1", "task_ref": {"kind": "draft", "key": "t1"},
                "action_ref": {"kind": "draft", "key": "a1"},
                "deliverable": "资料清单", "remaining_minutes": 45,
            }],
        },
    }


def test_personal_plan_repairs_bad_dependency_using_original_material(client, monkeypatch):
    from app.qwen import KEY_HEADER, PersonalQwenAdapter

    calls = []
    def respond(self, url, headers, payload, deadline=None):
        calls.append(payload["messages"])
        plan = proposal_payload()
        plan["proposal"]["task_proposals"][0]["title"] = "校园马拉松报名"
        if len(calls) == 1:
            plan["proposal"]["work_items"][0]["depends_on"] = ["UNKNOWN_PRIVATE_KEY"]
        return vendor(plan).json()

    monkeypatch.setattr(PersonalQwenAdapter, "_post", respond)
    response = client.post("/api/qwen/propose", headers={KEY_HEADER: "sk-personal-unit-test"},
                           json=mk_request(user_message="校园马拉松报名，每天45分钟"))
    assert response.status_code == 200, response.text
    assert len(calls) == 2
    assert calls[1][1]["content"].startswith(calls[0][1]["content"])
    repair = calls[1][0]["content"][len(calls[0][0]["content"]):]
    assert "work_items.0.depends_on" in repair and "依赖" in repair
    assert "UNKNOWN_PRIVATE_KEY" not in repair


def test_second_diagnosis_uses_latest_draft_and_previous_explanation(client, monkeypatch):
    from app.qwen import KEY_HEADER, PersonalQwenAdapter

    messages = []
    def respond(self, url, headers, payload, deadline=None):
        messages.append(payload["messages"])
        task = {"title": "核验库存", "minutes": 30, "earliest_date": "2026-12-03"}
        plan = {"kind": "task_list", "tasks": [task]}
        if len(messages) == 1:
            plan["tasks"].append({"title": "等待借用人交单", "minutes": 0})
        elif len(messages) == 2:
            plan["diagnosis"] = "等待交单是外部条件，已去掉等待任务。"
            task["after"] = [1]
        else:
            plan["diagnosis"] = "核验库存不能依赖自身，去掉该引用。"
            task["description"] = "收到借用单后核验。"
        return vendor(plan).json()

    monkeypatch.setattr(PersonalQwenAdapter, "_post", respond)
    response = client.post("/api/qwen/propose", headers={KEY_HEADER: "sk-personal-unit-test"},
                           json=mk_request(user_message="我是保管人，12月3日收到借用单后核验库存。"))
    assert response.status_code == 200, response.text
    assert len(messages) == 3
    assert "等待借用人交单" in messages[1][1]["content"]
    assert "等待交单是外部条件" in messages[2][1]["content"]
    assert "tasks.0.after" in messages[2][0]["content"]
    assert "diagnosis" not in response.text
    work, = response.json()["payload"]["proposal"]["work_items"]
    assert work["deliverable"] == "核验库存" and work["depends_on"] == []


@pytest.mark.parametrize("limit", [1, 2, 3])
def test_shape_failure_reports_actual_attempts_and_safe_path(monkeypatch, limit):
    payload = proposal_payload()
    payload["proposal"]["work_items"][0]["sensitive-unknown-key"] = "sensitive-value"
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        return vendor(payload)
    with propose_app(monkeypatch, provider=model_provider(respond), JXL_PROPOSE_MAX_ATTEMPTS=limit) as (_, client):
        response = client.post("/api/assistant/propose", json=mk_request())
    assert response.status_code == 502
    error = response.json()
    assert error["detail"]["category"] == "shape"
    assert error["detail"]["attempts"] == len(calls) == limit
    assert "work_items" in error["detail"]["path"]
    assert ("自动修正后" in error["message"]) == (limit > 1)
    assert "sensitive-" not in response.text and "sensitive-" not in str(calls)


@pytest.mark.parametrize("matches", [True, False])
def test_relative_candidate_retains_evidence_when_missing_derived(monkeypatch, matches):
    payload = proposal_payload()
    candidate = payload["proposal"]["task_proposals"][0]["deadline_candidates"][0]
    source = mk_source()
    field = source["note_candidates"][0]
    field.update(derived=True, value=candidate["value"] if matches else "2040-05-01")
    candidate["basis"] = "relative"
    candidate["evidence_refs"] = [{"kind": "note_field", "note_id": field["note_id"], "field_key": "deadline"}]
    calls = []
    def respond(request):
        calls.append(1)
        return vendor(payload)
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        response = client.post("/api/assistant/propose", json=mk_request(selected_sources=[source]))
    if not matches:
        assert response.status_code == 502 and len(calls) == 3
        return
    assert response.status_code == 200, response.text
    saved = response.json()["payload"]["proposal"]["task_proposals"][0]["deadline_candidates"][0]
    assert saved["derived"] is True and saved["value"] == candidate["value"]
    assert saved["evidence_refs"] == candidate["evidence_refs"]
    assert len(calls) == 1


def adapter(name: str, handler, **kw) -> OpenAICompatibleAdapter:
    base = {"name": name, "protocol": "openai", "base_url": f"https://{name}.test/v1",
            "model": "m", "api_key_env": "K_" + name.upper(), "retries": 0}
    base.update(kw)
    return OpenAICompatibleAdapter(ModelProfile(**base), "sk-TEST", httpx.MockTransport(handler))


def test_pending_event_requires_date_rule_and_preserves_independent_preparation(monkeypatch):
    tasks = [{"title": "填写信息表", "minutes": 10},
             {"title": "参加开题会", "minutes": 60, "description": "会议日期待公布"},
             {"title": "修改终稿", "minutes": 45, "after": [2]}]
    updated = [tasks[0], dict(tasks[1], pending_date={"event": "开题会", "offset_days": 0}),
               dict(tasks[2], pending_date={"event": "开题会", "offset_days": 1})]
    attempts = iter([tasks, updated])
    with propose_app(monkeypatch, provider=model_provider(lambda _: vendor({"kind": "task_list", "tasks": next(attempts)}))) as (_, client):
        response = client.post("/api/assistant/propose", json=mk_request())
    assert response.status_code == 200, response.text
    proposal = response.json()["payload"]["proposal"]
    assert [t.get("pending_date") and t["pending_date"]["offset_days"] for t in proposal["task_proposals"]] == [None, 0, 1]
    assert all(not t["deadline_candidates"] for t in proposal["task_proposals"])


@pytest.mark.parametrize("invalid_patch", [False, True])
def test_personal_review_repairs_only_approval_task(client, monkeypatch, invalid_patch):
    from app.qwen import KEY_HEADER, PersonalQwenAdapter

    calls = []
    event = {"event": "报告会", "offset_days": -3, "sets_deadline": True}
    plan = {"kind": "task_list", "tasks": [
        {"title": "整理文件", "minutes": 10},
        {"title": "提交申请并打印报告", "description": "须完成导师审核。", "minutes": 30,
         "after": [1], "pending_date": event},
        {"title": "参加报告会", "minutes": 60, "after": [2], "pending_date": {"event": "报告会", "offset_days": 0}},
    ]}
    split = {"before_event": {"title": "提交申请", "minutes": 20, "description": "提交材料给导师审核"},
             "after_event": {"title": "打印报告", "minutes": 10, "description": "导师审核通过后打印"}}
    def respond(self, url, headers, payload, deadline=None):
        calls.append(payload["messages"])
        return vendor(plan if len(calls) == 1 or invalid_patch else split).json()

    monkeypatch.setattr(PersonalQwenAdapter, "_post", respond)
    source = mk_source()
    source["excerpt"] = "无关资料标记。完成导师审核。自行打印报告。"
    response = client.post("/api/qwen/propose", headers={KEY_HEADER: "sk-personal-unit-test"},
                           json=mk_request(selected_sources=[source]))
    assert len(calls) == (3 if invalid_patch else 2)
    assert "自行打印报告" in calls[1][1]["content"]
    assert "无关资料标记" not in str(calls[1]) and "整理文件" not in str(calls[1])
    if invalid_patch:
        assert response.status_code == 502 and response.json()["detail"]["attempts"] == 3
        return
    assert response.status_code == 200, response.text
    proposal = response.json()["payload"]["proposal"]
    assert [t["title"] for t in proposal["task_proposals"]] == ["整理文件", "提交申请", "打印报告", "参加报告会"]
    assert proposal["task_proposals"][1]["pending_date"] == event
    assert proposal["task_proposals"][2]["pending_date"]["offset_days"] is None
    assert [w["depends_on"] for w in proposal["work_items"]] == [[], ["w1"], ["w2"], ["w3"]]


@pytest.mark.parametrize("labels,choice", [
    (["硕士系统申请截止", "博士系统申请截止"], "硕士研究生"),
    (["承办方｜反馈期限", "委托方｜反馈期限"], "委托方"),
])
def test_personal_review_asks_for_missing_role_locally(client, monkeypatch, labels, choice):
    from app.qwen import KEY_HEADER, PersonalQwenAdapter
    calls = []
    def respond(self, url, headers, payload, deadline=None):
        calls.append(1)
        return vendor({"kind": "task_list", "tasks": [{"title": "填写信息表", "minutes": 10}]}).json()

    monkeypatch.setattr(PersonalQwenAdapter, "_post", respond)
    src = mk_source()
    src["note_candidates"][0].update(field_key="time_nodes", value=[
        {"label": label, "role": "submission_deadline", "basis": "relative", "raw": day}
        for label, day in zip(labels, ("会前三天", "会前一周"))])
    req = mk_request(user_message="请给我安排任务", selected_sources=[src])
    headers = {KEY_HEADER: "sk-personal-unit-test"}
    first = client.post("/api/qwen/propose", headers=headers, json=req).json()["payload"]
    assert first["kind"] == "clarification" and not calls
    from contract.assistant_models import UserAuthoredInput, render_user_authored_text
    user_input = UserAuthoredInput(original_user_request=req["user_message"], clarifications=[
        {"assistant_question": first["questions"][0]["question"], "user_answer": choice}])
    req.update(user_input=user_input.model_dump(), user_message=render_user_authored_text(user_input))
    response = client.post("/api/qwen/propose", headers=headers, json=req)
    assert response.status_code == 200, response.text
    assert response.json()["payload"]["kind"] == "proposal" and calls == [1]


def test_event_notice_marker_and_flat_dates_preserve_real_work():
    from app.assistant.new_plan import NewTaskList
    from pydantic import ValidationError

    tasks = [
        {"title": "等候室布置", "minutes": 15},
        {"title": "等待现场安排公布", "minutes": 0},
        {"title": "提交申请及审核", "minutes": 20, "after": [1, 2],
         "pending_date": True, "event": "报告会", "offset_days": -3, "sets_deadline": True},
        {"title": "打印文件", "minutes": 10, "after": [3]},
        {"title": "参加报告会", "minutes": 60, "after": [4], "pending_date": {"event": "报告会", "offset_days": 0}},
    ]
    plan = NewTaskList.model_validate({"kind": "task_list", "tasks": tasks}).as_proposal([])["proposal"]
    assert [t["title"] for t in plan["task_proposals"]] == [t["title"] for t in (tasks[0], *tasks[2:])]
    assert [w["depends_on"] for w in plan["work_items"]] == [[], ["w1"], ["w2"], ["w3"]]
    assert plan["task_proposals"][2]["pending_date"] == {"event": "报告会", "offset_days": None, "sets_deadline": False}
    tasks[1] = {"title": "等待现场安排公布并提交报名表", "minutes": 0}
    with pytest.raises(ValidationError):
        NewTaskList.model_validate({"kind": "task_list", "tasks": tasks})


def test_new_plan_task_list_produces_linked_schedulable_objects(monkeypatch):
    examples = [json.loads(line) for line in render_task_list_prompt().splitlines() if line.startswith('{"kind":')]
    illustrated, question = examples
    assert [len(t.get("deadline_candidates", [])) for t in illustrated["tasks"]] == [1, 1, 0]
    plan = {"kind": "task_list", "tasks": [
        {"title": "完成校园马拉松报名", "minutes": 15},
        {"title": "参加校园马拉松", "minutes": 90, "earliest_date": "2026-12-13",
         "splittable": False, "after": [1]},
    ]}
    src = mk_source()
    candidate = {"value": "2026-11-27", "precision": "date", "basis": "explicit",
                 "evidence_refs": [{"kind": "note_field", "note_id": "note-1", "field_key": "deadline"}]}
    src["excerpt"] = "11月27日报名截止，12月13日09:00起跑。"
    src["note_candidates"][0].update(raw="11月27日报名截止")
    plan["tasks"][0]["deadline_candidates"] = [candidate]
    plan["constraints"] = [{"type": "daily_budget", "value": 45, "provenance": "user"}]
    responses = iter([plan, question])
    def respond(request):
        prompt = json.loads(request.content)["messages"][0]["content"]
        assert prompt == render_task_list_prompt() and "work_items" not in prompt
        return vendor(next(responses))
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        req = mk_request(selected_sources=[src])
        first = client.post("/api/assistant/propose", json=req)
        assert first.status_code == 200, first.text
        p = PAYLOAD_ADAPTER.validate_python(first.json()["payload"]).proposal
        assert len(p.task_proposals) == len(p.action_proposals) == len(p.work_items) == 2
        for t, a, w in zip(p.task_proposals, p.action_proposals, p.work_items, strict=True):
            assert t.key == a.task_ref.key == w.task_ref.key and a.key == w.action_ref.key
            assert t.title == a.text == w.deliverable and a.minutes == w.remaining_minutes
        registration, race = p.work_items
        assert registration.earliest_date is None and race.earliest_date == "2026-12-13"
        assert race.depends_on == [registration.key] and race.splittable is False
        assert p.task_proposals[0].deadline_candidates[0].value == "2026-11-27"
        assert p.task_proposals[1].deadline_candidates == []
        assert p.requirement_candidates[0].value == 45
        second = client.post("/api/assistant/propose", json=req)
        assert second.status_code == 200 and second.json()["payload"]["kind"] == "clarification"


@pytest.mark.parametrize("bad_field, category", [
    ({"after": [1]}, "reference"),
    ({"minutes": 0}, "shape"),
    ({"task_ref": {"kind": "existing", "id": "wrong"}}, "shape"),
    ({"evidence_refs": [{"kind": "source_excerpt", "source_id": "src-1", "excerpt": "资料没有这句话"}]}, "reference"),
    ({"evidence_refs": [{"kind": "note_field", "note_id": "note-1", "field_key": "unseen"}]}, "reference"),
])
def test_invalid_compact_plan_can_repair_without_accepting_bad_task(monkeypatch, bad_field, category):
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        task = {"title": "提交报名", "minutes": 10}
        if len(calls) == 1:
            task.update(bad_field)
        return vendor({"kind": "task_list", "tasks": [task]})
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        result = client.post("/api/assistant/propose", json=mk_request(selected_sources=[mk_source()]))
    assert result.status_code == 200, result.text
    assert len(calls) == 2 and calls[1][1]["content"].startswith(calls[0][1]["content"])
    assert "上次方案未通过校验" in calls[1][0]["content"]
    assert "tasks.0" in calls[1][0]["content"]


def test_two_task_deadlines_get_targeted_repair(monkeypatch):
    plan = next(json.loads(line) for line in render_task_list_prompt().splitlines() if line.startswith('{"kind":'))
    fields = mk_source(note_id="示例便签")
    dates = [task["deadline_candidates"][0]["value"] for task in plan["tasks"][:2]]
    fields["note_candidates"][0].update(field_key="time_nodes", value=[
        {"value": date, "role": "submission_deadline"} for date in dates
    ])
    misplaced = {"kind": "task_list", "tasks": [{"title": "登记", "minutes": 10}], "deadline_candidates": []}
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        return vendor(misplaced if len(calls) == 1 else plan)
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        result = client.post("/api/assistant/propose", json=mk_request(selected_sources=[fields]))
    assert result.status_code == 200, result.text
    assert len(calls) == 2 and calls[1][1]["content"].startswith(calls[0][1]["content"])
    assert "tasks[i].deadline_candidates" in calls[1][0]["content"]
    proposal = result.json()["payload"]["proposal"]
    assert [[d["value"] for d in t["deadline_candidates"]] for t in proposal["task_proposals"]] == [[dates[0]], [dates[1]], []]
    assert proposal["work_items"][-1]["earliest_date"] == "2027-03-08"


@pytest.mark.parametrize("after", [1, "1", ["1"]])
def test_unambiguous_dependency_normalizes_without_retry(monkeypatch, after):
    calls = []
    def respond(request):
        calls.append(1)
        return vendor({"kind": "task_list", "tasks": [
            {"title": "预约", "minutes": 10}, {"title": "到场", "minutes": 30, "after": after}
        ]})
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        response = client.post("/api/assistant/propose", json=mk_request())
    assert response.status_code == 200 and len(calls) == 1
    assert response.json()["payload"]["proposal"]["work_items"][1]["depends_on"] == ["w1"]


def test_preparation_advice_is_not_a_clock_deadline(monkeypatch):
    source = mk_source()
    source["excerpt"] = "请准备一份自我介绍。"
    task = {"title": "准备自我介绍", "minutes": 15}
    candidate = {"value": "2027-06-05T23:59:59", "precision": "datetime", "basis": "inferred",
                 "derived": True, "evidence_refs": [{"kind": "source_excerpt", "source_id": source["source_id"],
                                                    "excerpt": source["excerpt"]}]}
    calls = []
    def respond(request):
        calls.append(json.loads(request.content)["messages"])
        fields = {"deadline_candidates": [candidate]} if len(calls) == 1 else {"description": "建议提前一天准备"}
        return vendor({"kind": "task_list", "tasks": [{**task, **fields}]})
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        response = client.post("/api/assistant/propose", json=mk_request(selected_sources=[source]))
    assert response.status_code == 200 and len(calls) == 2
    assert "摘录没有给出截止时刻" in calls[1][0]["content"]
    assert response.json()["payload"]["proposal"]["task_proposals"][0]["deadline_candidates"] == []


def test_model_selects_source_nodes_and_server_copies_temporal_facts(monkeypatch):
    source = mk_source()
    field = source["note_candidates"][0]
    field.update(field_key="time_nodes", value=[
        {"role": "submission_deadline", "basis": "superseded", "value": "2027-02-01", "precision": "date"},
        {"role": "submission_deadline", "value": "2027-03-02", "precision": "date"},
        {"role": "submission_deadline", "value": "2027-03-05T18:00:00", "precision": "datetime"},
        {"role": "event_start", "value": "2027-03-07T22:00:00Z", "precision": "datetime"},
    ])
    def respond(request):
        system, user = json.loads(request.content)["messages"]
        assert system["content"] == render_task_list_prompt(with_time_nodes=True)
        assert '"序号": 3' in user["content"] and '"序号": 4' not in user["content"]
        return vendor(next(json.loads(line) for line in system["content"].splitlines() if line.startswith('{"kind":')))
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        result = client.post("/api/assistant/propose", json=mk_request(selected_sources=[source]))
    assert result.status_code == 200, result.text
    p = result.json()["payload"]["proposal"]
    one, two, event = p["task_proposals"]
    assert one["deadline_candidates"][0]["value"] == "2027-03-02"
    assert two["deadline_candidates"][0]["value"] == "2027-03-05T18:00:00"
    assert event["deadline_candidates"] == [] and "2027-03-07T22:00:00Z" in event["description"]
    assert p["work_items"][2]["earliest_date"] == "2027-03-08"
    assert one["deadline_candidates"][0]["evidence_refs"] == event["evidence_refs"]
    assert event["evidence_refs"] == [{"kind":"note_field","note_id":"note-1","field_key":"time_nodes"}]


@pytest.mark.parametrize("selection", [[2], [1, 1]])
def test_unknown_and_duplicate_time_node_ids_are_rejected(monkeypatch, selection):
    source = mk_source()
    source["note_candidates"][0].update(field_key="time_nodes", value=[
        {"role": "submission_deadline", "value": "2026-11-17", "precision": "date"}
    ])
    def respond(request):
        return vendor({"kind":"task_list","tasks":[{"title":"登记","minutes":15,"time_nodes":selection}]})
    with propose_app(monkeypatch, provider=model_provider(respond), JXL_PROPOSE_MAX_ATTEMPTS=1) as (_, client):
        result = client.post("/api/assistant/propose",json=mk_request(selected_sources=[source]))
    assert result.status_code == 502 and result.json()["detail"]["path"] == "tasks.0.time_nodes"


def test_field_indices_and_corroborating_deadlines(monkeypatch):
    source = mk_source()
    field = source["note_candidates"][0]
    field.update(field_key="time_nodes", value=[{"role":"submission_deadline", "value":"2027-02-01", "precision":"date"}])
    second = dict(field, note_id="note-2")
    source["note_candidates"].append(second)
    def respond(request):
        return vendor({"kind":"task_list","tasks":[{"title":"登记","minutes":10,"time_nodes":[1,2],"fact_refs":[2]}]})
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        result = client.post("/api/assistant/propose", json=mk_request(selected_sources=[source]))
    assert result.status_code == 200, result.text
    task = result.json()["payload"]["proposal"]["task_proposals"][0]
    assert len(task["deadline_candidates"]) == 1
    assert {ref["note_id"] for ref in task["deadline_candidates"][0]["evidence_refs"]} == {"note-1","note-2"}
    assert len(task["evidence_refs"]) == 2


def test_explicitly_conditional_task_triggers_a_choice(monkeypatch):
    def respond(request):
        return vendor({"kind":"task_list","tasks":[{"title":"请假（如适用）","minutes":10}]})
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        result = client.post("/api/assistant/propose", json=mk_request())
    assert result.status_code == 200, result.text
    question = result.json()["payload"]["questions"][0]
    assert question["options"] == ["需要请假", "无需请假"]


def test_missing_event_range_and_both_scope_choices(monkeypatch):
    source = mk_source()
    source["note_candidates"][0].update(field_key="time_nodes", value=[
        {"label": "竞赛举行时间", "raw": "9月23日至27日举行", "role": "other", "value": None,
         "basis": "inferred", "derived": True, "reference_at": "2026-09-15", "reference_source": "user"}
    ])
    registration = {"title": "填写竞赛报名表", "minutes": 15}
    event = {"title": "参加建模比赛", "minutes": 90, "earliest_date": "2026-09-23"}
    tasks = [registration]

    def respond(request):
        return vendor({"kind": "task_list", "tasks": tasks})

    base = mk_request(selected_sources=[source], user_message="请按通知帮我规划")
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        def post(**changes):
            result = client.post("/api/assistant/propose", json={**base, **changes})
            assert result.status_code == 200, result.text
            return result.json()["payload"]

        question = post()["questions"][0]
        assert "9月23日至27日" in question["question"]
        assert post(user_message="只安排报名。")["kind"] == "proposal"
        assert post(user_message="只安排报名和参赛")["kind"] == "clarification"
        for answer in reversed(question["options"]):
            if answer == question["options"][0]:
                tasks.append(event)
            ui = UserAuthoredInput(original_user_request=base["user_message"],
                                   clarifications=[{"assistant_question":question["question"], "user_answer":answer}])
            p = post(user_input=ui.model_dump(), user_message=render_user_authored_text(ui))["proposal"]
            assert len(p["work_items"]) == len(tasks)
        event["earliest_date"] = "2026-09-18"
        assert post()["kind"] == "clarification"
        source["note_candidates"][0]["value"][0]["basis"] = "superseded"
        assert post()["kind"] == "proposal"


def test_notice_event_with_a_single_start_uses_beijing_day(monkeypatch):
    source = mk_source()
    source["note_candidates"][0].update(field_key="time_nodes", value=[
        {"label": "培训开始", "raw": "通知中的活动开始时刻", "role": "event_start",
         "value": "2027-03-07T22:00:00Z", "precision": "datetime"}
    ])
    tasks = [{"title": "培训报名", "minutes": 15}]
    def respond(request):
        return vendor({"kind": "task_list", "tasks": tasks})
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        req = mk_request(selected_sources=[source])
        assert client.post("/api/assistant/propose", json=req).json()["payload"]["kind"] == "clarification"
        tasks.append({"title": "参加培训", "minutes": 30, "time_nodes": [1]})
        p = client.post("/api/assistant/propose", json=req).json()["payload"]["proposal"]
        assert p["work_items"][-1]["earliest_date"] == "2027-03-08"


@pytest.mark.parametrize("sentence, extra_title, expected", [
    ("将 PDF 报告、源代码和两张截图打包上传。", None, ["w1", "w2", "w3"]),
    ("将 PDF 报告、源代码和两张截图打包上传。", "编写另一份源代码", ["w1", "w3"]),
    ("此次只上传提纲，无需提交 PDF、源代码和截图。", None, []),
])
def test_named_submission_dependencies(monkeypatch, sentence, extra_title, expected):
    tasks = [{"title": t, "minutes": 30} for t in ("撰写报告 PDF", "编写源代码", "截取实验结果图")]
    if extra_title:
        tasks.append({"title": extra_title, "minutes": 20})
    tasks.append({"title": "提交最终材料", "description": sentence, "minutes": 10})
    def respond(request):
        return vendor({"kind": "task_list", "tasks": tasks})
    with propose_app(monkeypatch, provider=model_provider(respond)) as (_, client):
        result = client.post("/api/assistant/propose", json=mk_request())
    assert result.status_code == 200, result.text
    work = result.json()["payload"]["proposal"]["work_items"]
    assert work[-1]["depends_on"] == expected
    assert all(not w["depends_on"] for w in work[:-1])


def test_selected_task_preserves_link_protocol(monkeypatch):
    def respond(request):
        assert json.loads(request.content)["messages"][0]["content"] == render_propose_system_prompt("new_plan")
        return vendor({"kind": "task_list", "tasks": [{"title": "不要重复创建", "minutes": 10}]})
    with propose_app(monkeypatch, provider=model_provider(respond), JXL_PROPOSE_MAX_ATTEMPTS=1) as (_, client):
        response = client.post("/api/assistant/propose", json=mk_request(selected_tasks=[mk_task()]))
    assert response.status_code == 502 and response.json()["detail"]["path"] == "kind"


@contextmanager
def propose_app(monkeypatch, provider=None, **env):
    monkeypatch.setenv("JXL_PROVIDER", "model" if provider is not None else "fixture")
    for key, value in env.items():
        monkeypatch.setenv(key, str(value))
    get_settings.cache_clear()
    get_provider.cache_clear()
    get_propose_provider.cache_clear()
    app = create_app()
    if provider is not None:
        app.dependency_overrides[get_propose_provider] = lambda: provider
    with TestClient(app) as client:
        yield app, client
    get_settings.cache_clear()
    get_provider.cache_clear()
    get_propose_provider.cache_clear()


def model_provider(handler, *, retries: int = 0, gate=None, profiles: int = 1) -> ModelProposeProvider:
    adapters = [adapter(f"p{i}", handler, retries=retries) for i in range(profiles)]
    return ModelProposeProvider(router=ModelRouter(adapters, attempt_gate=gate))


# ---------------------------------------------------------------- 桩模式闭环


def test_fixture_proposal_happy_path_and_correlation(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(selected_sources=[mk_source()]))
    assert response.status_code == 200
    body = response.json()
    parsed = AssistantProposeResponse.model_validate(body)
    assert parsed.request_id == "req-t1"
    assert parsed.thread_id == "th-t1"
    assert parsed.turn_id == "turn-t1"
    assert parsed.client_seq == 1
    assert parsed.workspace_id == "ws-test"
    assert parsed.payload.kind == "proposal"
    task, = parsed.payload.proposal.task_proposals
    action, = parsed.payload.proposal.action_proposals
    work, = parsed.payload.proposal.work_items
    assert task.title == action.text == work.deliverable
    assert action.task_ref.key == work.task_ref.key == task.key
    assert work.action_ref.key == action.key
    assert action.minutes == work.remaining_minutes
    assert task.deadline_candidates == []
    request = AssistantProposeRequest.model_validate(mk_request(selected_sources=[mk_source()]))
    check_proposal_semantics(parsed.payload.proposal, build_request_context(request))


def test_fixture_clarification_trigger(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message="澄清演示：要求不明"))
    assert response.status_code == 200
    payload = response.json()["payload"]
    assert payload["kind"] == "clarification"
    assert payload["ready"] is False
    assert 1 <= len(payload["questions"]) <= 3


def test_fixture_link_reuse_only_for_selected(monkeypatch):
    request = mk_request(
        selected_sources=[mk_source()],
        selected_tasks=[mk_task()],
        selected_actions=[mk_action()],
    )
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=request)
    assert response.status_code == 200
    proposal = response.json()["payload"]["proposal"]
    ops = {(t["op"], t.get("target_id")) for t in proposal["task_proposals"]}
    assert ("link", "task-1") in ops
    reuse = [a for a in proposal["action_proposals"] if a["op"] == "reuse"]
    assert reuse and reuse[0]["target_id"] == "act-1"


def test_fixture_fail_injection_all_codes(monkeypatch):
    expected = {"400": 400, "413": 413, "422": 422, "429": 429, "502": 502, "503": 503, "504": 504}
    with propose_app(monkeypatch) as (_app, client):
        for code, status in expected.items():
            response = client.post(f"/api/assistant/propose?fail={code}", json=mk_request())
            assert response.status_code == status, code


def test_fail_injection_closed_in_model_mode(monkeypatch):
    provider = model_provider(lambda r: vendor(proposal_payload()))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose?fail=503", json=mk_request())
    assert response.status_code == 422


# ---------------------------------------------------------------- 协议 / 结构 / 语义拒绝（调模型前）


def test_bad_protocol_version_is_400(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(protocol_version="0.9"))
    assert response.status_code == 400
    assert response.json()["code"] == "PROTOCOL_UNSUPPORTED"


def test_unsupported_intent_explicit_422(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        for intent in ("revise_draft", "explain_today"):
            response = client.post("/api/assistant/propose", json=mk_request(intent=intent))
            assert response.status_code == 422
            assert response.json()["code"] == "unsupported_intent"
        response = client.post("/api/assistant/propose", json=mk_request(intent="delete_all"))
        assert response.status_code == 422
        assert response.json()["code"] == "invalid_request"


@pytest.mark.parametrize("mutate", [
    lambda r: r.update(user_message="   "),
    lambda r: r["planning_context"].update(start_date="2020-01-01"),
    lambda r: r["planning_context"]["days"][3].update(date="2020-01-01"),
    lambda r: r.update(selected_tasks=[mk_task(), mk_task()]),
    lambda r: r.update(selected_tasks=[mk_task()], selected_actions=[mk_action(task_id="task-ghost")]),
    lambda r: r.update(selected_sources=[mk_source(), mk_source()]),
    lambda r: r["planning_context"]["days"].pop(),
    lambda r: r.update(client_seq=0),
])
def test_illegal_requests_rejected_before_vendor(monkeypatch, mutate):
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor(proposal_payload())

    provider = model_provider(handler)
    request = mk_request()
    mutate(request)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=request)
    assert response.status_code == 422
    assert calls == [], "非法请求不得到达厂家"


def test_deadline_provenance_note_must_be_in_snapshot(monkeypatch):
    request = mk_request(selected_tasks=[mk_task(note_id="note-ghost")])
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=request)
    assert response.status_code == 422
    assert "note-ghost" in response.json()["message"]


def test_requirement_evidence_must_be_in_snapshot(monkeypatch):
    request = mk_request(confirmed_requirements=[{
        "requirement_id": "r1", "version": 1, "type": "daily_budget", "value": 45,
        "strength": "hard", "confirmed_at": "2026-11-25T09:00:00+08:00",
        "evidence_refs": [{"kind": "source_excerpt", "source_id": "src-ghost", "excerpt": "x"}],
    }])
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=request)
    assert response.status_code == 422


def test_error_responses_do_not_echo_user_content(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(protocol_version="0.9"))
        assert SECRET_MARKER not in response.text
        response = client.post("/api/assistant/propose", json=mk_request(user_message=""))
        assert SECRET_MARKER not in response.text


# ---------------------------------------------------------------- 真实模型路径（假厂家）


def test_model_proposal_happy_path(monkeypatch):
    provider = model_provider(lambda r: vendor(proposal_payload(source_id="src-1")))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(selected_sources=[mk_source()]))
    assert response.status_code == 200
    body = response.json()
    assert body["payload"]["kind"] == "proposal"
    assert body["request_id"] == "req-t1"


def test_model_assumption_related_keys_valid_work_item(monkeypatch):
    payload = proposal_payload(source_id="src-1")
    payload["proposal"]["assumptions"] = [{"id": "as1", "text": "假设报告含图表整理", "related_keys": ["w1"]}]
    provider = model_provider(lambda r: vendor(payload))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(selected_sources=[mk_source()]))
    assert response.status_code == 200
    assert response.json()["payload"]["kind"] == "proposal"


def test_model_clarification_happy_path(monkeypatch):
    payload = {"kind": "clarification", "questions": [{
        "question_id": "q1", "question": "报告要对比分析吗？", "options": [],
        "blocking_reason": "原文未说明。",
    }], "ready": False}
    provider = model_provider(lambda r: vendor(payload))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request())
    assert response.status_code == 200
    assert response.json()["payload"]["kind"] == "clarification"


def test_forged_correlation_fields_rejected(monkeypatch):
    # 契约 extra=forbid：模型在 payload 里塞关联字段属于非法输出（502），
    # 响应关联字段一律服务端从请求复制，任何情况下不采信模型值。
    payload = proposal_payload()
    payload["request_id"] = "req-FORGED"
    payload["workspace_id"] = "ws-FORGED"
    provider = model_provider(lambda r: vendor(payload))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request())
    assert response.status_code == 502
    assert "req-FORGED" not in response.text
    assert "ws-FORGED" not in response.text


@pytest.mark.parametrize("bad_payload", [
    # 引用未选定 source
    {**proposal_payload(source_id="src-ghost")},
    # 伪造用户消息 turn
    {**proposal_payload(turn_id="turn-ghost")},
    # update 不支持
    {"kind": "proposal", "proposal": {"task_proposals": [{
        "op": "update", "key": "t1", "target_id": "task-1", "changes": {"title": "改"}}]}},
    # 依赖环（task/action 齐全，环是唯一非法点）
    {"kind": "proposal", "proposal": {
        "task_proposals": [{"op": "create", "key": "t1", "title": "T"}],
        "action_proposals": [{"op": "create", "key": "a1", "task_ref": {"kind": "draft", "key": "t1"},
                              "text": "x", "minutes": 30}],
        "work_items": [
            {"key": "w1", "task_ref": {"kind": "draft", "key": "t1"}, "action_ref": {"kind": "draft", "key": "a1"},
             "deliverable": "x", "depends_on": ["w2"]},
            {"key": "w2", "task_ref": {"kind": "draft", "key": "t1"}, "action_ref": {"kind": "draft", "key": "a1"},
             "deliverable": "y", "depends_on": ["w1"]},
        ]}},
    # explanation 不属于 new_plan
    {"kind": "explanation", "explanation": "今天做这些。", "fact_refs": []},
    # assumptions.related_keys 用行动 key（a1）——只能引用本版 work_items[].key
    {**proposal_payload(), "proposal": {**proposal_payload()["proposal"],
                                        "assumptions": [{"id": "as1", "text": "假设含图表", "related_keys": ["a1"]}]}},
    # assumptions.related_keys 用未知 key
    {**proposal_payload(), "proposal": {**proposal_payload()["proposal"],
                                        "assumptions": [{"id": "as1", "text": "假设含图表", "related_keys": ["w-ghost"]}]}},
    # 工作项冒用用户来源：模型只能建议（estimate_origin 只能是 model）
    {**proposal_payload(), "proposal": {**proposal_payload()["proposal"],
                                        "work_items": [{**proposal_payload()["proposal"]["work_items"][0],
                                                        "estimate_origin": "user"}]}},
    # 不是 JSON 对象
    {"kind": "proposal", "proposal": {"task_proposals": [{"op": "create", "key": "t1", "title": "T",
                                                          "deadline_candidates": [{"value": "2026-13-40", "precision": "date"}]}]}},
])
def test_illegal_model_output_502_after_three_attempts(monkeypatch, bad_payload):
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor(bad_payload)

    provider = model_provider(handler, retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(selected_sources=[mk_source()],
                                                                        selected_tasks=[mk_task()]))
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"
    assert len(calls) == 3, "propose 全部厂家尝试合计不得超过 3"


def test_forged_user_deadline_evidence_rejected(monkeypatch):
    # F1：模型伪造「用户明确要求」的原话不在本轮真实用户输入中 → 输出边界拒收（502，合计 3 次）。
    payload = json.loads(json.dumps(proposal_payload()))
    t = payload["proposal"]["task_proposals"][0]
    t["evidence_refs"] = [{"kind": "user_message", "turn_id": "turn-t1", "excerpt": "请拆解报告"}]
    t["deadline_candidates"][0].update(
        origin="user", value="2026-12-01", precision="date", basis="explicit",
        evidence_refs=[{"kind": "user_message", "turn_id": "turn-t1", "excerpt": "我明确要求在2026年12月1日之前完成"}],
    )
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor(payload)

    provider = model_provider(handler, retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message="请拆解报告，我还没有决定截止日期。"))
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"
    assert len(calls) == 3


def test_genuine_user_deadline_evidence_accepted(monkeypatch):
    # F1 正对照：用户原话证据摘录确在本轮用户输入中 → origin=user 候选通过（200），不误伤真实用户设定。
    payload = json.loads(json.dumps(proposal_payload()))
    ev = {"kind": "user_message", "turn_id": "turn-t1", "excerpt": "截止设为2026-12-01"}
    t = payload["proposal"]["task_proposals"][0]
    t["evidence_refs"] = [ev]
    t["deadline_candidates"][0].update(origin="user", value="2026-12-01", precision="date", basis="explicit", evidence_refs=[ev])
    provider = model_provider(lambda r: vendor(payload))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message="请把截止设为2026-12-01，谢谢。"))
    assert response.status_code == 200
    dl = response.json()["payload"]["proposal"]["task_proposals"][0]["deadline_candidates"][0]
    assert dl["origin"] == "user"


# R1：合成澄清消息中「问：」段是模型提问，不取得用户身份；只有原始要求/「答：」段可作 user_message 出处。
_COMPOSED_CLARIFICATION = (
    "原始要求：请拆解报告，截止还没有决定\n"
    "\n"
    "此前的澄清问题与我的回答：\n"
    "问：是否把截止设为2026-11-30？\n"
    "答：不要设截止日期\n"
    "\n"
    "请结合以上回答继续生成方案。"
)


def _r1_payload(excerpt):
    payload = json.loads(json.dumps(proposal_payload()))
    t = payload["proposal"]["task_proposals"][0]
    t["evidence_refs"] = [{"kind": "user_message", "turn_id": "turn-t1", "excerpt": "请拆解报告"}]
    t["deadline_candidates"][0].update(
        origin="user", value="2026-12-01", precision="date", basis="explicit",
        evidence_refs=[{"kind": "user_message", "turn_id": "turn-t1", "excerpt": excerpt}],
    )
    return payload


def test_r1_model_question_as_user_evidence_rejected(monkeypatch):
    # 摘录引用模型提问（问：段）→ 即使整条合成 user_message 含该文字，输出边界仍拒收（502，合计 3 次）。
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor(_r1_payload("是否把截止设为2026-11-30？"))

    provider = model_provider(handler, retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message=_COMPOSED_CLARIFICATION))
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"
    assert len(calls) == 3


def test_r1_machine_tail_as_user_evidence_rejected(monkeypatch):
    provider = model_provider(lambda r: vendor(_r1_payload("请结合以上回答继续生成方案。")), retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message=_COMPOSED_CLARIFICATION))
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"


def test_r1_empty_excerpt_rejected(monkeypatch):
    provider = model_provider(lambda r: vendor(_r1_payload("")), retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message=_COMPOSED_CLARIFICATION))
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"


def test_r1_legacy_composed_user_answer_rejected(monkeypatch):
    # P2 收口（差异文档 §8）：旧合成请求（无 user_input）零可信段——即使摘录是真实用户回答
    # 也不接地（无法可靠区分角色，须重新提交）；真实回答的正向覆盖见结构化用例。
    provider = model_provider(lambda r: vendor(_r1_payload("不要设截止日期")), retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message=_COMPOSED_CLARIFICATION))
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"


def test_r1_legacy_composed_original_requirement_rejected(monkeypatch):
    # P2 收口：旧合成请求的「原始要求」部分同样不取得可信身份（整条零可信段）。
    provider = model_provider(lambda r: vendor(_r1_payload("请拆解报告，截止还没有决定")), retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message=_COMPOSED_CLARIFICATION))
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"


def test_p2_legacy_plain_manual_message_accepted(monkeypatch):
    # 旧普通文本请求（首轮原话/手动改值，无合成前缀）整条可信——明确手动设置日期路径不受影响。
    payload = _r1_payload("我把截止设为 2026-12-01。")
    payload["proposal"]["task_proposals"][0]["evidence_refs"] = [
        {"kind": "user_message", "turn_id": "turn-t1", "excerpt": "我把截止设为 2026-12-01。"},
    ]
    provider = model_provider(lambda r: vendor(payload))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message="我把截止设为 2026-12-01。"))
    assert response.status_code == 200
    dl = response.json()["payload"]["proposal"]["task_proposals"][0]["deadline_candidates"][0]
    assert dl["origin"] == "user"


def test_p2_legacy_injected_example_rejected(monkeypatch):
    # 复验 P2 后端入口：旧请求问题内注入「答：截止设为2026-11-30」→ 不得作为用户证据。
    legacy = (
        "原始要求：帮我安排报告，截止日期还没定\n\n此前的澄清问题与我的回答：\n"
        "问：请确认截止日期。\n参考回答：\n答：截止设为2026-11-30\n答：不要设截止日期\n\n请结合以上回答继续生成方案。"
    )
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor(_r1_payload("截止设为2026-11-30"))

    provider = model_provider(handler, retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request(user_message=legacy))
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"
    assert len(calls) == 3


# R1 结构化：请求带 user_input 时出处核对只读结构化字段（原始要求/各轮回答），不解析文本；
# 模型问题内注入「答：…」行仍属 assistant_question，不取得用户身份。渲染用契约单一来源函数。
from contract.assistant_models import UserAuthoredInput, render_user_authored_text  # noqa: E402

_INJECTED_QUESTION = "请确认截止日期，例如：\n答：2026-11-30"
_STRUCTURED_UI = UserAuthoredInput.model_validate({
    "original_user_request": "请拆解报告，截止还没有决定",
    "clarifications": [{"assistant_question": _INJECTED_QUESTION, "user_answer": "不要设截止日期"}],
})
_STRUCTURED_MESSAGE = render_user_authored_text(_STRUCTURED_UI)


def _structured_request(**over):
    return mk_request(user_message=_STRUCTURED_MESSAGE, user_input=_STRUCTURED_UI.model_dump(), **over)


def test_r1_structured_injected_answer_line_rejected(monkeypatch):
    # 负对照：文本确实含注入「答：2026-11-30」行，但旧合成路径零可信段、结构化路径只读字段；
    # 两条路径都必须拒绝（502，合计 3 次）。
    assert "答：2026-11-30" in _STRUCTURED_MESSAGE
    assert _user_authored_segments(_STRUCTURED_MESSAGE) == []
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor(_r1_payload("2026-11-30"))

    provider = model_provider(handler, retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=_structured_request())
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"
    assert len(calls) == 3


def test_r1_structured_user_answer_accepted(monkeypatch):
    provider = model_provider(lambda r: vendor(_r1_payload("不要设截止日期")))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=_structured_request())
    assert response.status_code == 200
    dl = response.json()["payload"]["proposal"]["task_proposals"][0]["deadline_candidates"][0]
    assert dl["origin"] == "user"


def test_r1_structured_original_request_accepted(monkeypatch):
    provider = model_provider(lambda r: vendor(_r1_payload("请拆解报告，截止还没有决定")))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=_structured_request())
    assert response.status_code == 200


def test_r1_structured_empty_excerpt_rejected(monkeypatch):
    provider = model_provider(lambda r: vendor(_r1_payload("")), retries=5, profiles=2)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=_structured_request())
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"


def test_r1_structured_mismatch_rejected_before_model(monkeypatch):
    # user_input 渲染 ≠ user_message → 请求级 422，模型一次都不调。
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor(_r1_payload("不要设截止日期"))

    provider = model_provider(handler)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post(
            "/api/assistant/propose",
            json=mk_request(user_message=_COMPOSED_CLARIFICATION, user_input=_STRUCTURED_UI.model_dump()),
        )
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_request"
    assert len(calls) == 0


def test_attempt_cap_is_per_request_not_shared(monkeypatch):
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor({"kind": "explanation", "explanation": "x", "fact_refs": []})

    provider = model_provider(handler, retries=5)
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        assert client.post("/api/assistant/propose", json=mk_request()).status_code == 502
        assert client.post("/api/assistant/propose", json=mk_request()).status_code == 502
    assert len(calls) == 6, "每次请求的三次预算独立计数"


def test_total_budget_timeout_maps_504(monkeypatch):
    def slow(request):
        import time
        time.sleep(0.15)
        return httpx.Response(500, json={"error": {"message": "boom"}})

    provider = model_provider(slow, retries=3)
    with propose_app(monkeypatch, provider=provider, JXL_PROPOSE_BUDGET_S=0.1) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request())
    assert response.status_code == 504
    assert response.json()["code"] == "propose_timeout"


def test_vendor_unavailable_maps_503(monkeypatch):
    provider = model_provider(lambda r: httpx.Response(500, json={"error": {"message": "boom"}}))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request())
    assert response.status_code == 503
    assert response.json()["code"] == "model_unavailable"
    assert "boom" not in response.text


def test_no_profile_maps_503(monkeypatch):
    monkeypatch.delenv("JXL_MODELS", raising=False)
    with propose_app(monkeypatch, provider=ModelProposeProvider()) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_request())
    assert response.status_code == 503


# ---------------------------------------------------------------- 共享防护


def test_auth_shared_with_analyze(monkeypatch):
    with propose_app(monkeypatch, JXL_API_TOKEN="test-token-0123456789") as (_app, client):
        assert client.post("/api/assistant/propose", json=mk_request()).status_code == 401
        ok = client.post("/api/assistant/propose", json=mk_request(),
                         headers={"Authorization": "Bearer test-token-0123456789"})
        assert ok.status_code == 200


def test_rate_bucket_shared_with_analyze(monkeypatch):
    with propose_app(monkeypatch, JXL_RATE_LIMIT_PER_MIN=1) as (_app, client):
        assert client.post("/api/analyze", json={"source_id": "src-01", "kind": "text",
                                                "text": "你好", "captured_at": "2026-11-25T09:00:00+08:00"}).status_code in (200, 422)
        blocked = client.post("/api/assistant/propose", json=mk_request())
        assert blocked.status_code == 429
        assert blocked.json()["code"] == "rate_limited"


def test_concurrency_gate_shared_with_analyze(monkeypatch):
    class BlockingPropose:
        name = "fixture"
        ready = True

        def __init__(self):
            self.started = threading.Event()
            self.finish = threading.Event()

        def propose(self, request):
            self.started.set()
            assert self.finish.wait(5)
            return FixtureProposeProvider().propose(request)

    provider = BlockingPropose()
    with propose_app(monkeypatch, JXL_MAX_CONCURRENT_ANALYZE=1) as (app, client):
        app.dependency_overrides[get_propose_provider] = lambda: provider
        result: dict = {}

        def first():
            result["first"] = client.post("/api/assistant/propose", json=mk_request())

        thread = threading.Thread(target=first)
        thread.start()
        assert provider.started.wait(5)
        second = client.post("/api/analyze", json={"source_id": "src-01", "kind": "text",
                                                  "text": "你好", "captured_at": "2026-11-25T09:00:00+08:00"})
        assert second.status_code == 503, "analyze 与 propose 必须共用同一并发闸"
        provider.finish.set()
        thread.join(timeout=5)
        assert result["first"].status_code == 200


def test_daily_quota_shared_and_no_bypass(monkeypatch):
    calls: list = []

    def handler(request):
        calls.append(1)
        return vendor(proposal_payload())

    monkeypatch.setenv("JXL_MAX_MODEL_CALLS_PER_DAY", "1")
    get_settings.cache_clear()
    provider = ModelProposeProvider(router=ModelRouter(
        [adapter("p0", handler, retries=5)], attempt_gate=MODEL_QUOTA.consume))
    with propose_app(monkeypatch, provider=provider) as (_app, client):
        assert client.post("/api/assistant/propose", json=mk_request()).status_code == 200
        blocked = client.post("/api/assistant/propose", json=mk_request())
    assert blocked.status_code == 429
    assert blocked.json()["code"] == "quota_exhausted"
    assert len(calls) == 1, "额度耗尽后不得 fallback 绕过"


# ---------------------------------------------------------------- 体积上限


def test_propose_body_declared_over_512kib_413(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        big = b'{"padding":"' + b"x" * (600 * 1024) + b'"}'
        response = client.post("/api/assistant/propose", content=big,
                               headers={"Content-Type": "application/json"})
    assert response.status_code == 413
    assert response.json()["code"] == "payload_too_large"


def test_propose_body_chunked_over_512kib_413(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        chunks = [b"x" * (100 * 1024) for _ in range(6)]
        response = client.post("/api/assistant/propose", content=iter(chunks),
                               headers={"Content-Type": "application/json"})
    assert response.status_code == 413


def test_analyze_body_limit_unchanged(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        big = b'{"padding":"' + b"x" * (1024 * 1024) + b'"}'
        response = client.post("/api/analyze", content=big,
                               headers={"Content-Type": "application/json"})
    assert response.status_code != 413, "propose 的 512KiB 上限不得套到 analyze"


def test_propose_limit_cannot_exceed_global(monkeypatch):
    with propose_app(monkeypatch, JXL_MAX_BODY_BYTES=100 * 1024, JXL_PROPOSE_MAX_BODY_BYTES=512 * 1024) as (_app, client):
        big = b'{"padding":"' + b"x" * (200 * 1024) + b'"}'
        response = client.post("/api/assistant/propose", content=big,
                               headers={"Content-Type": "application/json"})
    assert response.status_code == 413


# ---------------------------------------------------------------- registry / profile


def test_build_router_max_tokens_cap_only_caps(monkeypatch):
    monkeypatch.setenv("JXL_MODELS", json.dumps([
        {"name": "a", "protocol": "openai", "base_url": "https://a.test/v1", "model": "m",
         "api_key_env": "K_A", "max_tokens": 20000},
    ]))
    monkeypatch.setenv("K_A", "sk-a")
    capped = build_router(max_tokens_cap=8192)
    assert capped._adapters[0].profile.max_tokens == 8192
    plain = build_router()
    assert plain._adapters[0].profile.max_tokens == 20000, "analyze 默认值不受 propose 上限影响"


def test_router_max_attempts_none_keeps_analyze_behavior():
    calls: list = []

    def flaky(request):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(500, json={"error": {"message": "boom"}})
        return vendor(proposal_payload())

    router = ModelRouter([adapter("a", flaky, retries=3)])
    text, name = router.complete(system="s", user_text="u", image_b64=None, media_type="image/png")
    assert len(calls) == 3
    assert json.loads(text)["kind"] == "proposal"


# ---------------------------------------------------------------- 提示词单一来源


def test_prompt_renders_all_contract_rules():
    from contract.models import PROPOSE_RULES

    prompt = render_propose_system_prompt()
    for section, rules in PROPOSE_RULES.items():
        for rule in rules:
            if section == "replan":
                assert rule not in prompt, "new_plan 提示词不得渲染 replan 段"
            else:
                assert rule in prompt, f"契约规则未进入提示词：{rule}"
    replan_prompt = render_propose_system_prompt("replan_task")
    for rules in PROPOSE_RULES.values():
        for rule in rules:
            assert rule in replan_prompt, f"契约规则未进入改排提示词：{rule}"


def test_prompt_examples_are_contract_valid():
    for intent in ("new_plan", "replan_task"):
        prompt = render_propose_system_prompt(intent)
        examples = [json.loads(line) for line in prompt.splitlines()
                    if line.startswith('{"kind":')]
        assert len(examples) == 2
        for example in examples:
            PAYLOAD_ADAPTER.validate_python(example)
        kinds = {e["kind"] for e in examples}
        assert kinds == {"proposal", "clarification"}
