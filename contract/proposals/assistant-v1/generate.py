"""从本目录 models.py 导出 schema.json / typedefs.d.ts / limits.json，并核对 fixture 容器。

用法：
    python contract/proposals/assistant-v1/generate.py            生成 + 容器核对
    python contract/proposals/assistant-v1/generate.py --check    只校验生成物一致 + 容器核对

5B-1B 起 A 批类型已迁入正式契约：本目录 models.py 从 contract/assistant_models.py 再导出，
本生成器只为协议测试导出提案视角的生成物；正式生成物以 contract/generate.py 为准。
结构/语义/金标校验在 selftest.py；本脚本只保证「唯一来源 → 生成物」一致与样本容器合法。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from models import (
    ALL_PROPOSAL_MODELS,
    ASSISTANT_PROTOCOL_VERSION,
    LIMITS,
    PROPOSAL_ENDPOINTS,
    TARGET_BACKUP_FORMAT_VERSION,
    TARGET_DB_VERSION,
    TARGET_SCHEMA_VERSION,
    FixtureCase,
)

HERE = Path(__file__).resolve().parent
FIXTURE_DIR = HERE / "fixtures"


def build_schema() -> dict[str, Any]:
    defs: dict[str, Any] = {}
    for model in ALL_PROPOSAL_MODELS:
        schema = model.model_json_schema(ref_template="#/$defs/{model}")
        defs.update(schema.pop("$defs", {}))
        defs[model.__name__] = schema
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "截下来 工作助手协议提案 assistant-v1（历史提案；A 批已并入正式契约 0.5.0）",
        "assistant_protocol_version": ASSISTANT_PROTOCOL_VERSION,
        "target_schema_version": TARGET_SCHEMA_VERSION,
        "target_db_version": TARGET_DB_VERSION,
        "target_backup_format_version": TARGET_BACKUP_FORMAT_VERSION,
        "source_of_truth": "contract/proposals/assistant-v1/models.py（A 批再导出自 contract/assistant_models.py）",
        "x-limits": LIMITS,
        "endpoints": PROPOSAL_ENDPOINTS,
        "$defs": defs,
    }


def build_limits() -> dict[str, Any]:
    return {
        "assistant_protocol_version": ASSISTANT_PROTOCOL_VERSION,
        "source_of_truth": "contract/assistant_models.py LIMITS（经 contract/models.py 与本目录 models.py 再导出）",
        "note": "更低的已配置上限优先；单接口不得放宽全局保护。future_config 是 5B-1/3 接入映射，不是当前配置。",
        "limits": LIMITS,
    }


# ---------------------------------------------------------------- typedefs（与正式生成器同形，独立实现）


def ref_name(ref: str) -> str:
    return ref.rsplit("/", 1)[-1]


def ts_type(node: dict[str, Any]) -> str:
    if "$ref" in node:
        return ref_name(node["$ref"])
    if "enum" in node:
        return " | ".join(json.dumps(v, ensure_ascii=False) for v in node["enum"])
    if "const" in node:
        return json.dumps(node["const"], ensure_ascii=False)
    if "anyOf" in node:
        parts = [ts_type(x) for x in node["anyOf"]]
        return " | ".join(dict.fromkeys(parts))
    if "oneOf" in node:
        # Pydantic 判别联合（discriminator）导出 oneOf；必须生成联合类型，不能落 unknown。
        parts = [ts_type(x) for x in node["oneOf"]]
        return " | ".join(dict.fromkeys(parts))
    if "allOf" in node and len(node["allOf"]) == 1:
        return ts_type(node["allOf"][0])
    kind = node.get("type")
    if kind == "object":
        extra = node.get("additionalProperties")
        if isinstance(extra, dict):
            return f"Record<string, {ts_type(extra)}>"
        if "properties" in node:
            return inline_object(node)
        return "Record<string, unknown>"
    if kind == "array":
        return f"Array<{ts_type(node.get('items', {}))}>"
    if kind == "string":
        return "string"
    if kind in ("integer", "number"):
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "null":
        return "null"
    return "unknown"


def inline_object(node: dict[str, Any]) -> str:
    required = set(node.get("required", []))
    lines = []
    for key, sub in node.get("properties", {}).items():
        opt = "" if key in required else "?"
        lines.append(f"{key}{opt}: {ts_type(sub)};")
    return "{ " + " ".join(lines) + " }"


def emit_typedefs(defs: dict[str, Any]) -> str:
    out = [
        "// 生成物，请勿手改。来源：contract/proposals/assistant-v1/models.py",
        "// 协议提案 assistant_protocol_version " + ASSISTANT_PROTOCOL_VERSION
        + "；目标业务契约 " + TARGET_SCHEMA_VERSION + "（未生效）。生产代码不得 import 本文件。",
        "",
    ]
    for name, node in defs.items():
        desc = node.get("description")
        if desc:
            out.append(f"/** {desc.splitlines()[0]} */")
        if "enum" in node:
            out.append(f"export type {name} = {ts_type(node)};")
        elif node.get("type") == "object" and "properties" in node:
            required = set(node.get("required", []))
            out.append(f"export interface {name} {{")
            for key, sub in node.get("properties", {}).items():
                opt = "" if key in required else "?"
                title = sub.get("description")
                if title:
                    out.append(f"  /** {title.splitlines()[0]} */")
                out.append(f"  {key}{opt}: {ts_type(sub)};")
            out.append("}")
        else:
            out.append(f"export type {name} = {ts_type(node)};")
        out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------- fixture 容器核对


def load_fixture_cases() -> list[FixtureCase]:
    index_path = FIXTURE_DIR / "index.json"
    if not index_path.exists():
        print("[SKIP] fixtures/index.json 尚不存在")
        return []
    index = json.loads(index_path.read_text(encoding="utf-8"))
    entries = index.get("cases", [])
    ids: set[str] = set()
    cases: list[FixtureCase] = []
    for entry in entries:
        path = FIXTURE_DIR / entry["file"]
        if not path.exists():
            print(f"[FAIL] index 指向不存在的样本文件：{entry['file']}")
            raise SystemExit(1)
        raw = json.loads(path.read_text(encoding="utf-8"))
        try:
            case = FixtureCase.model_validate(raw)
        except ValidationError as exc:
            print(f"[FAIL] {entry['file']} 不符合 FixtureCase 容器")
            for err in exc.errors():
                print(f"       {'.'.join(str(x) for x in err['loc'])}: {err['msg']}")
            raise SystemExit(1)
        if case.id != entry["id"]:
            print(f"[FAIL] {entry['file']} id 与 index 不一致")
            raise SystemExit(1)
        if case.id in ids:
            print(f"[FAIL] 样本 id 重复：{case.id}")
            raise SystemExit(1)
        ids.add(case.id)
        cases.append(case)
    print(f"[OK] {len(cases)} 份样本容器合法（结构/语义/金标校验见 selftest.py）")
    return cases


def main() -> int:
    check_only = "--check" in sys.argv
    schema = build_schema()
    artifacts = {
        "schema.json": json.dumps(schema, ensure_ascii=False, indent=2) + "\n",
        "typedefs.d.ts": emit_typedefs(schema["$defs"]),
        "limits.json": json.dumps(build_limits(), ensure_ascii=False, indent=2) + "\n",
    }
    if check_only:
        bad = []
        for name, text in artifacts.items():
            path = HERE / name
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                bad.append(name)
        if bad:
            print(f"[FAIL] 生成物与 models.py 不一致：{bad}；请重新运行 generate.py")
            return 1
        print(f"[OK] 生成物一致（{len(schema['$defs'])} 个定义，{len(LIMITS)} 项限额）")
    else:
        for name, text in artifacts.items():
            (HERE / name).write_text(text, encoding="utf-8")
        print(f"[OK] 已生成 schema.json（{len(schema['$defs'])} 个定义）、typedefs.d.ts、limits.json")
    load_fixture_cases()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())