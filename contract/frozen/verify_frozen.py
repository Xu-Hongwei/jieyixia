"""校验 contract/frozen/0.4.0 冻结快照完整性（只读，不生成、不覆盖任何文件）。

用法：
    python -X utf8 contract/frozen/verify_frozen.py

退出码 0 = 全部文件字节数与 SHA-256 与 SHA256SUMS.json 一致；1 = 缺失/被改动/多出未登记文件。
contract/generate.py 只写 contract/schema.json 与 contract/typedefs.d.ts，不写 frozen/；
本脚本供每批门禁与 v1 备份回归前确认冻结件未被新版生成覆盖。
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

FROZEN = Path(__file__).resolve().parent / "0.4.0"


def main() -> int:
    manifest = json.loads((FROZEN / "SHA256SUMS.json").read_text(encoding="utf-8"))
    expected: dict[str, dict] = manifest["files"]
    problems: list[str] = []

    actual_files = {
        p.relative_to(FROZEN).as_posix()
        for p in FROZEN.rglob("*")
        if p.is_file() and p.name != "SHA256SUMS.json"
    }
    for missing in sorted(set(expected) - actual_files):
        problems.append(f"缺失冻结文件：{missing}")
    for extra in sorted(actual_files - set(expected)):
        problems.append(f"未登记的多余文件：{extra}")

    for rel in sorted(set(expected) & actual_files):
        b = (FROZEN / rel).read_bytes()
        want = expected[rel]
        if len(b) != want["bytes"]:
            problems.append(f"{rel} 字节数 {len(b)} != 冻结值 {want['bytes']}")
        digest = hashlib.sha256(b).hexdigest()
        if digest != want["sha256"]:
            problems.append(f"{rel} sha256 {digest} != 冻结值 {want['sha256']}")

    if manifest.get("schema_version") != "0.4.0":
        problems.append("manifest.schema_version 必须是 0.4.0")
    schema = json.loads((FROZEN / "schema.json").read_text(encoding="utf-8"))
    if schema.get("schema_version") != "0.4.0":
        problems.append("冻结 schema.json 的 schema_version 必须是 0.4.0")

    if problems:
        print(f"[FAIL] 冻结快照校验：{len(problems)} 处问题")
        for p in problems:
            print(f"       - {p}")
        return 1
    print(f"[OK] 0.4.0 冻结快照完整：{len(expected)} 个文件字节数与 SHA-256 全部一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())