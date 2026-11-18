"""离线 golden 回归：重放录制的模型原始输出，验证 parse/契约/不变量，不打真模型。

    python regress_golden.py

golden 位于 samples/golden/（gitignore，含真实样本可能带 PII，不进仓库）。
改 prompt / schema / 解析逻辑后跑此脚本秒级回归；再按需跑真模型 13 案例复测。
"""

from __future__ import annotations

import json
import pathlib
import sys

from app._contract import AnalyzeResponse
from app.model.core import parse_model_output
from app.model.base import ModelError
from contract.models import DEADLINE_VALUE_RE, UNIVERSAL_KEYS, TYPE_KEYS

ALLOWED = {k: UNIVERSAL_KEYS | v for k, v in TYPE_KEYS.items()}
GOLDEN = pathlib.Path(__file__).resolve().parent.parent / "samples" / "golden"


def check(d: dict) -> list[str]:
    issues: list[str] = []
    try:
        AnalyzeResponse.model_validate(d)
    except Exception:
        issues.append("契约校验失败")
    dl = None
    for f in d["fields"]:
        if f["key"] not in ALLOWED[d["content_type"]]:
            issues.append("越界键" + f["key"])
        if f["status"] == "confirmed":
            issues.append("模型返回confirmed")
        if f["derived"] and f["status"] != "unresolved":
            issues.append("derived非unresolved")
        if f["raw"] and f["status"] in ("candidate", "unresolved") and not f["quote"]:
            issues.append(f"{f['key']}缺quote")
        if f["key"] == "deadline":
            dl = f
            if f["value"] is not None:
                if not DEADLINE_VALUE_RE.match(str(f["value"])):
                    issues.append("deadline格式非法")
                if f["precision"] not in ("date", "datetime"):
                    issues.append("缺precision")
                if f["precision"] == "datetime" and f["tz_known"] is None:
                    issues.append("缺tz_known")
    # deadline 键可缺席（契约允许，前端容忍）；存在才校验形状与元数据
    return issues


def main() -> int:
    files = sorted(GOLDEN.glob("*.json"))
    if not files:
        print("无 golden，先录制")
        return 1
    ok = 0
    for p in files:
        g = json.loads(p.read_text(encoding="utf-8"))
        try:
            d = parse_model_output(
                g["raw_model_output"], source_id=g["source_id"],
                captured_at=g["captured_at"], model_name=g["model_name"],
            ).model_dump(mode="json")
        except ModelError as e:
            print(f"{p.stem:<22} PARSE-FAIL {e.message}")
            continue
        issues = check(d)
        if not issues:
            ok += 1
        dl = next((f for f in d["fields"] if f["key"] == "deadline"), {})
        print(f"{p.stem:<22} {'OK ' if not issues else 'ISSUE'} deadline={dl.get('value')} p={dl.get('precision')} tz={dl.get('tz_known')}" + (f" -> {issues}" if issues else ""))
    print(f"\ngolden 回归通过 {ok}/{len(files)}")
    return 0 if ok == len(files) else 1


if __name__ == "__main__":
    sys.exit(main())
