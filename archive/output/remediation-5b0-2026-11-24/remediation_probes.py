"""5B-0 整改验证探针：与审查探针同输入，断言修复后的正确接受/拒绝预期。
虚构数据、无网络、不读用户数据库、不改业务代码；结果写本目录，不覆盖审查原证据。
运行：python -X utf8 output/remediation-5b0-2026-11-24/remediation_probes.py
"""
import json
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PROPOSAL = ROOT / "contract/proposals/assistant-v1"
sys.path.insert(0, str(PROPOSAL))
sys.path.insert(0, str(ROOT))
import models as M
import selftest as S
import generate as G
from contract.models import Deadline

results = []


def accepts(fn):
    try:
        fn()
        return {"accepted": True}
    except ValueError as exc:
        return {"accepted": False, "error": str(exc)}


# R1：三种正式合法时间，既有事实快照必须与正式 Deadline 同样接受
for value in ["2026-11-26T09:00+08:00", "2026-11-26T09:00", "2026-11-26T09:00:00.123+08:00"]:
    data = dict(value=value, precision="datetime", source="manual", confirmed_at="2026-11-24T10:00:00+08:00")
    old = accepts(lambda: Deadline.model_validate(data))
    new = accepts(lambda: M.ExistingDeadline.model_validate(data))
    fact = accepts(lambda: M.PlanningTaskFact.model_validate(
        dict(task_ref={"kind": "existing", "id": "t-1"}, title="虚构目标", deadline_value=value, deadline_precision="datetime")))
    results.append({"probe": "R1_legacy_deadline", "value": value, "production_0_4": old, "proposal_existing": new, "proposal_plan_fact": fact})
    assert old["accepted"] and new["accepted"] and fact["accepted"]

# R1：非法日期/偏移仍拒绝；模型新候选保持严格（不放宽）
bad_date = accepts(lambda: M.ExistingDeadline.model_validate(
    dict(value="2026-02-30T09:00", precision="datetime", source="manual", confirmed_at="2026-11-24T10:00:00+08:00")))
bad_offset = accepts(lambda: M.ExistingDeadline.model_validate(
    dict(value="2026-11-26T09:00+08:75", precision="datetime", source="manual", confirmed_at="2026-11-24T10:00:00+08:00")))
strict_candidate = accepts(lambda: M.DeadlineCandidate.model_validate(
    dict(value="2026-11-26T09:00+08:00", precision="datetime",
         evidence_refs=[{"kind": "source_excerpt", "source_id": "s-1", "excerpt": "虚构截止"}])))
results.append({"probe": "R1_negatives_and_strict_candidate", "bad_date": bad_date, "bad_offset": bad_offset, "candidate_no_seconds": strict_candidate})
assert not bad_date["accepted"] and not bad_offset["accepted"] and not strict_candidate["accepted"]

# R2：判别联合不再丢成 unknown
schema = json.loads((PROPOSAL / "schema.json").read_text(encoding="utf-8"))
for model, prop in [("AssistantModelProposal", "task_proposals"), ("AssistantModelProposal", "action_proposals"), ("AssistantProposeResponse", "payload")]:
    ts = G.ts_type(schema["$defs"][model]["properties"][prop])
    results.append({"probe": "R2_typescript_union", "model": model, "field": prop, "generated_type": ts})
    assert "unknown" not in ts

# R3：direct/reuse 两条路径对已完成 Action 统一拒绝；未完成 direct 接受
ctx_done = dict(workspace_id="ws", tasks=[dict(id="t-1", workspace_id="ws")],
                actions=[dict(id="a-1", workspace_id="ws", task_id="t-1", done=True)],
                source_ids=["s-1"], note_ids=[], turn_id="turn-1")
ctx_open = dict(ctx_done, actions=[dict(id="a-1", workspace_id="ws", task_id="t-1", done=False)])
work = dict(key="w1", task_ref=dict(kind="existing", id="t-1"),
            action_ref=dict(kind="existing", id="a-1"), deliverable="fictional work", remaining_minutes=40)


def semantic(data, ctx):
    S.check_model_semantics(M.AssistantModelProposal.model_validate(data), ctx)


direct_done = accepts(lambda: semantic(dict(work_items=[work]), ctx_done))
reuse_done = accepts(lambda: semantic(dict(action_proposals=[dict(op="reuse", key="a-reuse", target_id="a-1", task_ref=dict(kind="existing", id="t-1"))]), ctx_done))
direct_open = accepts(lambda: semantic(dict(work_items=[work]), ctx_open))
results.append({"probe": "R3_completed_action", "direct_done": direct_done, "reuse_done": reuse_done, "direct_undone": direct_open})
assert not direct_done["accepted"] and not reuse_done["accepted"] and direct_open["accepted"]

# R4：update 截止候选与 create 同一套证据/来源规则
for origin, evidence in [("model", dict(kind="source_excerpt", source_id="unselected-source", excerpt="fictional deadline")),
                         ("user", dict(kind="source_excerpt", source_id="s-1", excerpt="not a user message"))]:
    dl = dict(value="2026-11-27", precision="date", origin=origin, evidence_refs=[evidence])
    update = dict(op="update", key="t-update", target_id="t-1", changes=dict(deadline_candidates=[dl]))
    create = dict(op="create", key="t-new", title="fictional task", deadline_candidates=[dl])
    u = accepts(lambda: semantic(dict(task_proposals=[update]), ctx_open))
    c = accepts(lambda: semantic(dict(task_proposals=[create]), ctx_open))
    results.append({"probe": "R4_update_deadline_evidence", "origin": origin, "update": u, "create_control": c})
    assert not u["accepted"] and not c["accepted"]
good_update = dict(op="update", key="t-update", target_id="t-1", changes=dict(deadline_candidates=[
    dict(value="2026-11-27", precision="date", origin="user",
         evidence_refs=[dict(kind="user_message", turn_id="turn-1", excerpt="截止改到周五")])]))
ok = accepts(lambda: semantic(dict(task_proposals=[good_update]), ctx_open))
results.append({"probe": "R4_legal_update", "update": ok})
assert ok["accepted"]

# R5：真实 ModelRouter 行为不变（两个 retries=1 profile → 一次 analyze 4 次尝试）；
# 提案场景按 Σ(1+retries) 计配置上界。不接真实模型、不动后端代码。
sys.path.insert(0, str(ROOT / "backend"))
from app.model.registry import ModelRouter
from app.model.base import ModelError, ModelProfile

attempts = []


class FakeAdapter:
    def __init__(self, name):
        self.name = name
        self.profile = ModelProfile(name=name, protocol="openai", model="fake", api_key_env="UNUSED", retries=1)

    def complete(self, **kwargs):
        attempts.append(self.name)
        raise ModelError("transport", "fictional failure", True, self.name)


with patch("app.model.registry.time.sleep"), patch("app.model.registry.log_event"):
    try:
        ModelRouter([FakeAdapter("a"), FakeAdapter("b")]).complete(system="", user_text="", image_b64=None, media_type="image/png", budget_s=120)
    except ModelError:
        pass
scenario_ok = accepts(lambda: S.check_scenario(
    {"scenario": "call_budget", "analyze_calls": 3, "analyze_attempts_total": 7, "propose_attempts": 2,
     "analyze_profile_retries": [[1, 1], [1, 1], [1, 1]]},
    {"allowed": True, "total_vendor_attempts": 9, "all_attempts_consume_daily_quota": True,
     "propose_budget_covers_all_its_attempts": True, "analyze_configured_attempt_upper": 12,
     "analyze_attempts_within_configured_upper": True}))
results.append({"probe": "R5_multi_profile_budget", "router_attempts": attempts, "count": len(attempts),
                "single_analyze_configured_upper": 4, "scenario_check": scenario_ok})
assert attempts == ["a", "a", "b", "b"] and scenario_ok["accepted"]

out = Path(__file__).with_name("remediation-probes.json")
out.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(results, ensure_ascii=False, indent=2))
print("All remediation expectations verified; no production files changed.")