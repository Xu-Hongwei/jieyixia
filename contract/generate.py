"""从 models.py（含 assistant_models.py）导出 schema.json / typedefs.d.ts / limits.json，并校验 fixtures。

用法：
    python contract/generate.py            生成 + 校验
    python contract/generate.py --check    只校验生成物一致 + fixtures
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
    FIELD_SCHEMA_LINKS,
    FIELD_SEMANTICS,
    LIMITS,
    SCHEMA_VERSION,
    STATUS_SEMANTICS,
    TIME_RULES,
    Fixture,
    RefState,
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
    # 嵌套 $defs 会覆盖同名定义，机器关联必须在全部定义合并后再并入
    for name, link in FIELD_SCHEMA_LINKS.items():
        if name in defs:
            defs[name].update(link)
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
        "x-limits": LIMITS,
        "endpoints": ENDPOINTS,
        "$defs": defs,
    }


def build_limits() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "source_of_truth": "contract/assistant_models.py LIMITS（经 contract/models.py 再导出）",
        "note": "更低的已配置上限优先；单接口不得放宽全局保护。future_config 是 5B-1/3 接入映射，不是当前配置。",
        "limits": LIMITS,
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
                need(field.raw != "" or field.status.value == "missing" or field.key == "time_nodes",
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
            owner = tasks.get(f.action.task_id)
            if owner:
                need(owner.workspace_id == f.action.workspace_id,
                     f"{f.id}: action 与所属 task 不在同一工作区")
        if f.focus_session:
            s = f.focus_session
            # v0.4：active（含 v0 缺省）必须解析到存在对象；deleted 是历史标识，必须解析不到
            if s.task_ref_state is RefState.deleted:
                need(s.task_id not in tasks, f"{f.id}: task_ref_state=deleted 但任务仍存在（假删除数据）")
            else:
                need(s.task_id in tasks, f"{f.id}: focus 指向不存在的 task")
                task = tasks.get(s.task_id)
                if task:
                    need(task.workspace_id == s.workspace_id,
                         f"{f.id}: focus 与 task 不在同一工作区")
            if s.action_ref_state is RefState.deleted:
                need(s.action_id not in actions, f"{f.id}: action_ref_state=deleted 但行动仍存在（假删除数据）")
            else:
                need(s.action_id in actions, f"{f.id}: focus 指向不存在的 action")
                action = actions.get(s.action_id)
                if action:
                    need(action.workspace_id == s.workspace_id,
                         f"{f.id}: focus 与 action 不在同一工作区")
                    need(action.task_id == s.task_id,
                         f"{f.id}: focus 的 action 不属于其 task")
            if s.plan_item_id:
                item = next((p for p in plan_items if p.id == s.plan_item_id), None)
                need(item is not None, f"{f.id}: focus 指向不存在的 plan_item")
                if item:
                    need(item.workspace_id == s.workspace_id and item.task_id == s.task_id,
                         f"{f.id}: focus.plan_item_id 必须属于同工作区、同任务")
        for p in f.plan_items:
            if p.task_ref_state is RefState.deleted:
                need(p.task_id not in tasks, f"{f.id}: plan_item task_ref_state=deleted 但任务仍存在")
            else:
                need(p.task_id in tasks, f"{f.id}: plan_item 指向不存在的 task")
                task = tasks.get(p.task_id)
                if task:
                    need(task.workspace_id == p.workspace_id,
                         f"{f.id}: plan_item 与 task 不在同一工作区")
            if p.focus_session_id:
                need(p.focus_session_id in sessions, f"{f.id}: plan_item 指向不存在的 focus")
                target = sessions.get(p.focus_session_id)
                if target:
                    need(target.ended_at is not None,
                         f"{f.id}: focus_session_id 快捷引用只能指向已结束会话")
                    need(target.workspace_id == p.workspace_id and target.task_id == p.task_id,
                         f"{f.id}: plan_item 快捷会话必须同工作区、同任务")
                    need(target.plan_item_id == p.id,
                         f"{f.id}: plan_item 快捷会话必须反向关联本条目（focus.plan_item_id）")
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

    # v0.4：同一工作区至多一份未结束会话（ended_at 为空，含暂停）
    unfinished_by_ws: dict[str, int] = {}
    for s in sessions.values():
        if s.ended_at is None:
            unfinished_by_ws[s.workspace_id] = unfinished_by_ws.get(s.workspace_id, 0) + 1
    for ws, count in unfinished_by_ws.items():
        need(count <= 1, f"工作区 {ws} 有 {count} 份未结束会话（含暂停，只允许 1 份）")

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
    schema = build_schema()
    artifacts = {
        "schema.json": json.dumps(schema, ensure_ascii=False, indent=2) + "\n",
        "typedefs.d.ts": emit_typedefs(schema["$defs"]),
        "limits.json": json.dumps(build_limits(), ensure_ascii=False, indent=2) + "\n",
    }
    if check_only:
        bad = []
        for name, text in artifacts.items():
            path = CONTRACT_DIR / name
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                bad.append(name)
        if bad:
            print(f"[FAIL] 生成物与 models.py 不一致：{bad}；请重新运行 generate.py")
            return 1
        print(f"[OK] 生成物一致（{len(schema['$defs'])} 个定义，{len(LIMITS)} 项限额）")
    else:
        for name, text in artifacts.items():
            (CONTRACT_DIR / name).write_text(text, encoding="utf-8")
        print(f"[OK] 已生成 schema.json（{len(schema['$defs'])} 个定义）、typedefs.d.ts、limits.json")

    if not FIXTURE_DIR.exists():
        print("[SKIP] fixtures/ 尚不存在")
        return 0
    return check_fixtures(load_fixtures())


if __name__ == "__main__":
    raise SystemExit(main())
