"""从 models.py 导出 schema.json 与 typedefs.d.ts，并校验 fixtures。

用法：
    python contract/generate.py            生成 + 校验
    python contract/generate.py --check    只校验
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from models import (
    ALL_MODELS,
    CHAT_RULES,
    ENDPOINTS,
    EXCLUSION_RULES,
    FIELD_SEMANTICS,
    SCHEMA_VERSION,
    STATUS_SEMANTICS,
    TIME_RULES,
    Fixture,
)

ROOT = Path(__file__).resolve().parent.parent
CONTRACT_DIR = ROOT / "contract"
FIXTURE_DIR = ROOT / "fixtures"


# ---------------------------------------------------------------- schema


def build_schema() -> dict[str, Any]:
    defs: dict[str, Any] = {}
    for model in ALL_MODELS:
        schema = model.model_json_schema(ref_template="#/$defs/{model}")
        defs.update(schema.pop("$defs", {}))
        defs[model.__name__] = schema
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "截下来 API 与本地领域契约",
        "schema_version": SCHEMA_VERSION,
        "source_of_truth": "contract/models.py",
        "x-semantics": {
            "fields": FIELD_SEMANTICS,
            "status": STATUS_SEMANTICS,
            "time_rules": TIME_RULES,
            "chat_rules": CHAT_RULES,
            "exclusion_rules": EXCLUSION_RULES,
        },
        "endpoints": ENDPOINTS,
        "$defs": defs,
    }


# ---------------------------------------------------------------- typedefs


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
        "// 生成物，请勿手改。来源：contract/models.py（schema_version "
        + SCHEMA_VERSION
        + "）",
        "// 供 Vue 3 + JavaScript 项目在 jsconfig.json 开启 checkJs 后做编辑器与 CI 校验。",
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


# ---------------------------------------------------------------- 校验


def load_fixtures() -> list[Fixture]:
    files = sorted(FIXTURE_DIR.glob("*.json"))
    files = [f for f in files if f.name != "index.json"]
    fixtures = []
    for path in files:
        raw = json.loads(path.read_text(encoding="utf-8"))
        try:
            fixtures.append(Fixture.model_validate(raw))
        except ValidationError as exc:
            print(f"[FAIL] {path.name} 不符合 Fixture 契约")
            for err in exc.errors():
                print(f"       {'.'.join(str(x) for x in err['loc'])}: {err['msg']}")
            raise SystemExit(1)
    return fixtures


def check_fixtures(fixtures: list[Fixture]) -> int:
    problems: list[str] = []

    def need(cond: bool, msg: str) -> None:
        if not cond:
            problems.append(msg)

    sources = {f.source.id: f.source for f in fixtures if f.source}
    notes = {f.confirmed_note.id: f.confirmed_note for f in fixtures if f.confirmed_note}
    tasks = {f.task.id: f.task for f in fixtures if f.task}
    actions = {f.action.id: f.action for f in fixtures if f.action}
    sessions = {f.focus_session.id: f.focus_session for f in fixtures if f.focus_session}
    proposals = [f.change_proposal for f in fixtures if f.change_proposal]
    plan_items = [p for f in fixtures for p in f.plan_items]

    need(len(sources) == sum(1 for f in fixtures if f.source), "source id 重复")
    need(len(notes) == sum(1 for f in fixtures if f.confirmed_note), "note id 重复")

    for f in fixtures:
        if f.source and f.expected_analysis:
            for field in f.expected_analysis.fields:
                if field.quote:
                    need(
                        field.quote.source_id == f.source.id,
                        f"{f.id}: 字段 {field.key} 的 quote 指向了别的 source",
                    )
                need(field.raw != "" or field.status.value == "missing",
                     f"{f.id}: 字段 {field.key} 既无原文也非 missing")
        if f.confirmed_note:
            need(f.confirmed_note.source_id in sources, f"{f.id}: confirmed_note 指向不存在的 source")
            confirmed = [x for x in f.confirmed_note.fields if x.status.value == "confirmed"]
            need(len(confirmed) > 0, f"{f.id}: confirmed_note 没有任何已确认字段")
        if f.matter:
            for nid in f.matter.note_ids:
                need(nid in notes, f"{f.id}: matter 引用了不存在的便签 {nid}")
        if f.task:
            for nid in f.task.note_ids:
                need(nid in notes, f"{f.id}: task 引用了不存在的便签 {nid}")
            if f.task.deadline.from_note_id:
                origin = notes.get(f.task.deadline.from_note_id)
                need(origin is not None, f"{f.id}: deadline 出处便签不存在")
                if origin:
                    dl = next((x for x in origin.fields if x.key == "deadline"), None)
                    need(dl is not None and dl.status.value == "confirmed",
                         f"{f.id}: deadline 出处便签的 deadline 字段未确认（规则 3）")
                    if dl and dl.value is not None:
                        need(str(dl.value) == f.task.deadline.value,
                             f"{f.id}: task.deadline 与出处便签的已确认值不一致")
        if f.action:
            need(f.action.task_id in tasks, f"{f.id}: action 指向不存在的 task")
        if f.focus_session:
            need(f.focus_session.task_id in tasks, f"{f.id}: focus 指向不存在的 task")
            need(f.focus_session.action_id in actions, f"{f.id}: focus 指向不存在的 action")
            if f.focus_session.plan_item_id:
                need(any(p.id == f.focus_session.plan_item_id for p in plan_items),
                     f"{f.id}: focus 指向不存在的 plan_item")
        for p in f.plan_items:
            need(p.task_id in tasks, f"{f.id}: plan_item 指向不存在的 task")
            if p.focus_session_id:
                need(p.focus_session_id in sessions, f"{f.id}: plan_item 指向不存在的 focus")
        if f.change_proposal:
            cp = f.change_proposal
            need(cp.task_id in tasks, f"{f.id}: proposal 指向不存在的 task")
            need(cp.old_note_id in notes and cp.new_note_id in notes,
                 f"{f.id}: proposal 的新旧便签必须都存在")
            for q in cp.evidence:
                need(q.source_id in sources, f"{f.id}: proposal 证据指向不存在的 source")
        for dep in f.depends_on:
            need(any(x.id == dep for x in fixtures), f"{f.id}: depends_on {dep} 不存在")

    running = [s for s in sessions.values() if s.running]
    need(len(running) <= 1, f"同时存在 {len(running)} 个运行中专注会话（规则 8 只允许 1 个）")

    for cp in proposals:
        if cp.status.value == "pending":
            task = tasks.get(cp.task_id)
            if task:
                need(task.deadline.value == cp.old_value,
                     f"{cp.id}: 候选未确认，但任务截止时间已被改成新值（规则 3 / F06）")

    if problems:
        print(f"[FAIL] fixture 业务不变量校验：{len(problems)} 处问题")
        for p in problems:
            print(f"       - {p}")
        return 1
    print(f"[OK] {len(fixtures)} 份 fixture 通过结构与业务不变量校验")
    print(f"     sources={len(sources)} notes={len(notes)} tasks={len(tasks)} "
          f"actions={len(actions)} focus={len(sessions)} plan_items={len(plan_items)} "
          f"proposals={len(proposals)} running={len(running)}")
    return 0


# ---------------------------------------------------------------- main


def main() -> int:
    check_only = "--check" in sys.argv
    if not check_only:
        schema = build_schema()
        (CONTRACT_DIR / "schema.json").write_text(
            json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (CONTRACT_DIR / "typedefs.d.ts").write_text(
            emit_typedefs(schema["$defs"]), encoding="utf-8"
        )
        print(f"[OK] 已生成 schema.json（{len(schema['$defs'])} 个定义）与 typedefs.d.ts")

    if not FIXTURE_DIR.exists():
        print("[SKIP] fixtures/ 尚不存在")
        return 0
    return check_fixtures(load_fixtures())


if __name__ == "__main__":
    raise SystemExit(main())
