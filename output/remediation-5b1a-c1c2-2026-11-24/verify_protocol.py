# 5B-1A 复验 C1/C2 协议侧独立验证：id_scope 判别 + 显式字段在场（含解析/序列化往返）。
# 运行：python -X utf8 output/remediation-5b1a-c1c2-2026-11-24/verify_protocol.py
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "contract" / "proposals" / "assistant-v1"))
from models import UserConfirmation  # noqa: E402
from pydantic import ValidationError  # noqa: E402

BASE = {
    "confirmation_id": "cf-1", "draft_revision": 1, "object_type": "task",
    "object_id_or_key": "t-new", "id_scope": "draft", "field_path": "deadline",
    "old_value": None, "new_value": {"value": "2026-11-27", "precision": "date"},
    "confirmed_at": "2026-11-24T08:00:00+08:00",
}
rows = []


def rejects(name, payload, fragment):
    try:
        UserConfirmation.model_validate(payload)
    except ValidationError as e:
        assert fragment in str(e), f"{name}: 错误信息不含 {fragment}: {e}"
        rows.append({"case": name, "passed": True})
        return
    raise AssertionError(f"{name}: 应当拒绝但通过了")


# C1：task 型缺/错判别拒绝；非 task 携带判别拒绝。
p = dict(BASE); del p["id_scope"]
rejects("C1_task_missing_id_scope", p, "id_scope")
rejects("C1_task_bad_id_scope", {**BASE, "id_scope": "workspace"}, "id_scope")
rejects("C1_nontask_with_id_scope", {
    **BASE, "object_type": "note_field", "field_path": "title", "old_value": None, "new_value": None,
}, "id_scope")
rows.append({"case": "C1_formal_scope_accepted", "passed": bool(
    UserConfirmation.model_validate({**BASE, "id_scope": "formal", "object_id_or_key": "t-1"}))})

# C2：缺字段拒绝；显式 null 合法。
p = dict(BASE); del p["new_value"]
rejects("C2_missing_new_value", p, "显式携带 new_value")
p = dict(BASE); del p["old_value"]
rejects("C2_missing_old_value", p, "显式携带 old_value")
none_ok = UserConfirmation.model_validate({**BASE, "new_value": None})
assert none_ok.new_value is None and "new_value" in none_ok.model_fields_set
rows.append({"case": "C2_explicit_null_accepted", "passed": True})

# C2 往返：合法显式 null 经 dump→re-validate 不丢失；缺失输入在第一次解析即拒绝，无法进入往返。
for mode in ("python", "json"):
    dumped = none_ok.model_dump(mode=mode)
    assert "new_value" in dumped and dumped["new_value"] is None
    again = UserConfirmation.model_validate(json.loads(json.dumps(dumped)) if mode == "json" else dumped)
    assert again.new_value is None and "new_value" in again.model_fields_set
    rows.append({"case": f"C2_roundtrip_explicit_null_survives_{mode}", "passed": True})
# exclude_unset 也不得把显式提交的 null 洗掉（显式字段属于 fields_set）。
assert "new_value" in none_ok.model_dump(exclude_unset=True)
rows.append({"case": "C2_exclude_unset_keeps_explicit_null", "passed": True})

out = Path(__file__).resolve().parent / "results-protocol.json"
out.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(rows, ensure_ascii=False, indent=2))
print("ALL PROTOCOL C1/C2 CHECKS PASSED")