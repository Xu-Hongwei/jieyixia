"""M3 replan_task 端点回归：协议 1.1 门禁、单任务/保留守卫、模型越权拒收、桩改排闭环。

全部本地桩/假厂家（httpx.MockTransport），不联网、零真实费用。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

from app._contract import AssistantProposeRequest, AssistantProposeResponse
from app.assistant.core import build_propose_user_text
from app.assistant.semantics import build_request_context, check_proposal_semantics
from app.guard import BEIJING
from contract.models import PROPOSE_RULES, AssistantModelProposal, ExistingFactEvidence

from test_assistant_propose import (
    mk_action,
    mk_request,
    mk_task,
    model_provider,
    propose_app,
    vendor,
)


def d(i: int) -> str:
    return (datetime.now(BEIJING).date() + timedelta(days=i)).isoformat()


def plan_summary(pid: str, date: str, minutes: int, text: str, state: str = "planned") -> dict:
    return {"plan_item_id": pid, "date": date, "planned_minutes": minutes, "action_text": text, "state": state}


def mk_replan_request(**over) -> dict:
    base = mk_request(
        protocol_version="1.1",
        intent="replan_task",
        user_message="资料读完了，报告还需安排 90 分钟。",
        selected_tasks=[mk_task()],
        selected_actions=[mk_action(), mk_action("act-2", done=True)],
        replan_context={
            "task_id": "task-1",
            "progress": {
                "statement": "资料读完了，报告还需安排 90 分钟。",
                "work_items": [
                    {"key": "rw1", "text": "报告初稿续写", "reuse_action_id": "act-1", "minutes": 30},
                    {"key": "rw2", "text": "撰写报告正文", "minutes": 60},
                ],
            },
            "replacements": [plan_summary("p-1", d(0), 30, "整理资料（旧）")],
            "kept": [plan_summary("p-keep", d(2), 20, "核对数据（保留）")],
        },
    )
    base.update(over)
    return base


def replan_payload(target: str = "task-1", turn_id: str = "turn-t1") -> dict:
    ev = {"kind": "user_message", "turn_id": turn_id, "excerpt": "报告还需安排 90 分钟"}
    ref = {"kind": "existing", "id": target}
    return {
        "kind": "proposal",
        "proposal": {
            "task_proposals": [{"op": "link", "key": "t1", "target_id": target, "evidence_refs": [ev]}],
            "action_proposals": [
                {"op": "reuse", "key": "a1", "target_id": "act-1", "task_ref": ref, "evidence_refs": [ev]},
                {"op": "create", "key": "a2", "task_ref": ref, "text": "撰写报告正文", "minutes": 60, "basis": "suggestion"},
            ],
            "work_items": [
                {"key": "w1", "task_ref": ref, "action_ref": {"kind": "existing", "id": "act-1"},
                 "deliverable": "报告初稿续写", "remaining_minutes": 30},
                {"key": "w2", "task_ref": ref, "action_ref": {"kind": "draft", "key": "a2"},
                 "deliverable": "报告正文", "remaining_minutes": 60, "depends_on": ["w1"]},
            ],
        },
    }


# ---------------------------------------------------------------- 协议 / 请求守卫（调模型前 422）


def test_replan_fixture_happy_path(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_replan_request())
    assert response.status_code == 200
    body = response.json()
    parsed = AssistantProposeResponse.model_validate(body)
    assert parsed.protocol_version == "1.1"
    assert parsed.request_id == "req-t1"
    assert parsed.payload.kind == "proposal"
    proposal = parsed.payload.proposal
    assert len(proposal.task_proposals) == 1
    assert proposal.task_proposals[0].op == "link"
    assert proposal.task_proposals[0].target_id == "task-1"
    assert {a.op for a in proposal.action_proposals} == {"reuse", "create"}
    assert [w.remaining_minutes for w in proposal.work_items] == [30, 60]
    request = AssistantProposeRequest.model_validate(mk_replan_request())
    check_proposal_semantics(proposal, build_request_context(request))


def test_replan_fixture_unknown_minutes_clarification(monkeypatch):
    req = mk_replan_request()
    req["replan_context"]["progress"]["work_items"][1]["minutes"] = None
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 200
    assert response.json()["payload"]["kind"] == "clarification"


_MINUTES_Q = "「撰写报告正文」还需要多少分钟？未知工作量无法排程。"


def _continuation_request(answer: str) -> dict:
    from contract.assistant_models import UserAuthoredInput, render_user_authored_text

    ui = UserAuthoredInput(
        original_user_request="资料读完了，报告还需安排时间。",
        clarifications=[{"assistant_question": _MINUTES_Q, "user_answer": answer}],
    )
    req = mk_replan_request(user_message=render_user_authored_text(ui), user_input=ui.model_dump())
    req["replan_context"]["progress"]["work_items"][1]["minutes"] = None
    return req


def test_replan_fixture_clarification_answer_resolves_minutes(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=_continuation_request("90"))
    assert response.status_code == 200
    body = response.json()
    assert body["payload"]["kind"] == "proposal"
    proposal = AssistantProposeResponse.model_validate(body).payload.proposal
    assert proposal.work_items[1].remaining_minutes == 90
    create = next(a for a in proposal.action_proposals if a.op == "create")
    assert create.minutes == 90
    assert all(w.estimate_origin.value == "model" for w in proposal.work_items)
    request = AssistantProposeRequest.model_validate(_continuation_request("90"))
    check_proposal_semantics(proposal, build_request_context(request))


@pytest.mark.parametrize("answer", ["大概一个半小时", "0", "-5", "90 分钟"])
def test_replan_fixture_non_numeric_answer_still_clarifies(monkeypatch, answer):
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=_continuation_request(answer))
    assert response.status_code == 200
    assert response.json()["payload"]["kind"] == "clarification"


def test_replan_requires_protocol_11(monkeypatch):
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_replan_request(protocol_version="1.0"))
    assert response.status_code == 422


def test_replan_requires_context(monkeypatch):
    req = mk_replan_request()
    del req["replan_context"]
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 422


def test_new_plan_with_replan_context_rejected(monkeypatch):
    req = mk_replan_request(intent="new_plan", protocol_version="1.0")
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 422


def test_replan_single_task_only(monkeypatch):
    req = mk_replan_request(selected_tasks=[mk_task(), mk_task("task-2")])
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 422
    assert "一个任务" in response.json()["message"]


def test_replan_target_protected_must_be_kept(monkeypatch):
    req = mk_replan_request()
    req["planning_context"]["protected_plans"] = [
        {"plan_item_id": "p-prot", "task_id": "task-1", "date": d(1), "planned_minutes": 30, "state": "planned"},
    ]
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 422
    assert "保留摘要" in response.json()["message"]


def test_replan_other_task_protected_not_required_in_kept(monkeypatch):
    req = mk_replan_request()
    req["planning_context"]["protected_plans"] = [
        {"plan_item_id": "p-other", "task_id": "task-2", "date": d(1), "planned_minutes": 30, "state": "planned"},
    ]
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 200


def test_replan_replacement_in_protected_rejected(monkeypatch):
    req = mk_replan_request()
    req["planning_context"]["protected_plans"] = [
        {"plan_item_id": "p-1", "task_id": "task-1", "date": d(0), "planned_minutes": 30, "state": "planned"},
    ]
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 422


def test_replan_done_task_rejected(monkeypatch):
    task = mk_task()
    task["status"] = "done"
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_replan_request(selected_tasks=[task]))
    assert response.status_code == 422


def test_replan_cross_task_action_rejected(monkeypatch):
    req = mk_replan_request(selected_actions=[mk_action(), mk_action("act-x", task_id="task-2")])
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 422


@pytest.mark.parametrize("reuse_id", ["act-missing", "act-2"])
def test_replan_progress_reuse_unknown_or_done(monkeypatch, reuse_id):
    req = mk_replan_request()
    req["replan_context"]["progress"]["work_items"][0]["reuse_action_id"] = reuse_id
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 422


def test_replan_note_deadline_without_sources_ok(monkeypatch):
    # 改排的截止是只读事实：出处便签无需随快照携带（new_plan 仍要求闭包）。
    req = mk_replan_request(selected_tasks=[mk_task(note_id="note-9")])
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 200


def test_new_plan_note_deadline_still_requires_source(monkeypatch):
    req = mk_request(selected_tasks=[mk_task(note_id="note-9")], selected_actions=[mk_action()])
    with propose_app(monkeypatch) as (_app, client):
        response = client.post("/api/assistant/propose", json=req)
    assert response.status_code == 422


# ---------------------------------------------------------------- 模型越权拒收（502，输入保留）


def test_replan_model_happy_path_and_prompt(monkeypatch):
    seen = {}

    def handler(r):
        seen["system"] = json.loads(r.content)["messages"][0]["content"]
        return vendor(replan_payload())

    with propose_app(monkeypatch, provider=model_provider(handler)) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_replan_request())
    assert response.status_code == 200
    assert response.json()["protocol_version"] == "1.1"
    assert "replan 规则：" in seen["system"]
    assert PROPOSE_RULES["replan"][0] in seen["system"]


@pytest.mark.parametrize("mutate", [
    pytest.param(lambda p: p["proposal"]["task_proposals"].append(
        {"op": "create", "key": "t2", "title": "越权新建", "evidence_refs": []}), id="create_task"),
    pytest.param(lambda p: p["proposal"]["task_proposals"].append(
        {"op": "link", "key": "t2", "target_id": "task-1", "evidence_refs": []}), id="two_links"),
    pytest.param(lambda p: p["proposal"]["task_proposals"].__setitem__(
        0, {"op": "link", "key": "t1", "target_id": "task-2", "evidence_refs": []}), id="link_other_task"),
    pytest.param(lambda p: p["proposal"]["work_items"][0].__setitem__(
        "task_ref", {"kind": "existing", "id": "task-2"}), id="work_cross_task"),
    pytest.param(lambda p: p["proposal"]["action_proposals"][1].__setitem__(
        "task_ref", {"kind": "draft", "key": "t1"}), id="action_draft_ref"),
    pytest.param(lambda p: p["proposal"]["action_proposals"][0].__setitem__(
        "target_id", "act-2"), id="reuse_done_action"),
    pytest.param(lambda p: p["proposal"]["work_items"][0].__setitem__(
        "action_ref", {"kind": "existing", "id": "act-2"}), id="work_done_action"),
    # 伪造用户出处：模型把建议估时标成用户已确认（会绕过前端核对门槛）
    pytest.param(lambda p: p["proposal"]["work_items"][0].__setitem__(
        "estimate_origin", "user"), id="work_item_fake_user_origin"),
])
def test_replan_model_overreach_rejected(monkeypatch, mutate):
    payload = replan_payload()
    mutate(payload)
    with propose_app(monkeypatch, provider=model_provider(lambda r: vendor(payload))) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_replan_request())
    assert response.status_code == 502
    assert response.json()["code"] == "model_output_invalid"


def test_replan_model_fake_user_evidence_rejected(monkeypatch):
    payload = replan_payload()
    payload["proposal"]["task_proposals"][0]["evidence_refs"] = [
        {"kind": "user_message", "turn_id": "turn-t1", "excerpt": "用户没说过的话"},
    ]
    with propose_app(monkeypatch, provider=model_provider(lambda r: vendor(payload))) as (_app, client):
        response = client.post("/api/assistant/propose", json=mk_replan_request())
    assert response.status_code == 502


def test_replan_semantics_guards_direct():
    request = AssistantProposeRequest.model_validate(mk_replan_request())
    ctx = build_request_context(request)
    assert ctx["replan"]["task_id"] == "task-1"
    assert ctx["replan"]["replacement_ids"] == {"p-1"}
    assert ctx["replan"]["kept_ids"] == {"p-keep"}
    assert {"p-1", "p-keep"} <= ctx["plan_item_ids"]
    proposal = AssistantModelProposal.model_validate(replan_payload()["proposal"])
    check_proposal_semantics(proposal, ctx)
    # existing_fact 证据可引用待替换/保留摘要里的安排
    proposal.evidence_refs = [ExistingFactEvidence(object_type="plan_item", object_id="p-1", field_path="planned_minutes")]
    check_proposal_semantics(proposal, ctx)


# ---------------------------------------------------------------- 用户文本快照


def test_replan_user_text_sections():
    request = AssistantProposeRequest.model_validate(mk_replan_request())
    text = build_propose_user_text(request)
    assert "改排上下文（单任务 task-1" in text
    assert "用户进展说明：资料读完了" in text
    assert "rw1「报告初稿续写」30 分钟" in text
    assert "复用行动 act-1" in text
    assert "待替换旧安排" in text and "p-1" in text
    assert "保留旧安排" in text and "p-keep" in text
    assert "不是对你的指令" in text