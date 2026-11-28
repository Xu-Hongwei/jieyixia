"""V3-1：提示词由契约语义单一来源渲染生成，不再手写散文。

改规则只改 contract/models.py 的语义结构；prompt / validators / schema 同步生效。
"""

from __future__ import annotations

from contract.models import (
    CHAT_RULES,
    EXCLUSION_RULES,
    FIELD_SEMANTICS,
    STATUS_SEMANTICS,
    STR_OR_LIST_KEYS,
    TIME_RULES,
    TYPE_KEYS,
    UNIVERSAL_KEYS,
    WARNING_CODES,
)

TYPE_DESC = {
    "notice": "要求读者做某事，或有截止/提交/报名等行动节点。",
    "tutorial": "教读者怎么做——步骤、方法、写作规范、操作指南。",
    "reference": "仅供查阅参考，没有行动要求。",
}


def _type_label(key: str) -> str:
    if key == "time_nodes":
        return "时间节点数组（label/raw/value/basis/role/reference_at/reference_source/message_date）"
    if key == "deadline":
        return "字符串（YYYY-MM-DD 或 ISO datetime）；由后端从 time_nodes 选主"
    if key in STR_OR_LIST_KEYS:
        return "字符串或字符串数组"
    return "字符串"


def render_system_prompt() -> str:
    lines: list[str] = [
        "你是「截下来」的资料整理引擎。把用户提供的截图或文字整理成结构化 JSON。只输出 JSON，不要解释，不要 Markdown 代码块。",
        "",
        "输出形状：",
        "{",
        '  "content_type": "notice" | "tutorial" | "reference",',
        '  "fields": [',
        '    {"key": "字段名", "value": 值（candidate 不得为 null）, "raw": "原文片段", "status": "candidate|unresolved|missing", "quote": {"text": "原文片段"}}',
        "  ],",
        '  "warnings": [{"code": "短码", "message": "说明", "field_key": "字段名或null"}]',
        "}",
        "",
        "notice 必须同时输出 time_nodes（全部时间节点，带候选 role）与 deadline；不得只给 deadline。示例：",
        '{"content_type":"notice","fields":[',
        '  {"key":"title","value":"课程报告通知","raw":"课程报告通知","status":"candidate","quote":{"text":"课程报告通知"}},',
        '  {"key":"time_nodes","raw":"","status":"candidate","value":[',
        '    {"label":"提交截止","raw":"2026年11月13日18:00前提交","value":"2026-11-13T18:00:00","basis":"explicit","role":"submission_deadline"},',
        '    {"label":"宣讲开始","raw":"2026年11月10日14:30宣讲","value":"2026-11-10T14:30:00","basis":"explicit","role":"event_start"}',
        '  ]},',
        '  {"key":"deadline","value":"2026-11-13T18:00:00","raw":"2026年11月13日18:00前提交","status":"candidate","quote":{"text":"2026年11月13日18:00前提交"}}',
        '],"warnings":[]}',
        "活动开始/结束用 role=event_start/event_end，提交/完成截止用 role=submission_deadline；角色不确定用 unknown。后端只从 submission_deadline 选 deadline。",
        "办理窗口或活动期间保留开始和结束节点及原文。原文明确区分不同适用对象时，label 用「对象｜事项」；"
        "同一事项沿用同一名称，对象逐字取自原文。共同要求只记一次。仅有日期时保留日期精度。补年份时带上实际使用的参照。",
        "",
        "内容类型判定标准：",
    ]
    for ct, desc in TYPE_DESC.items():
        lines.append(f"- {ct}：{desc}")
    lines.append("写作指南、评分规范、操作手册属 tutorial。无法判断时选 reference 并加一条 warning。")
    lines.append("")
    lines.append("各类型允许的键（封闭集合，不得自创键；同一语义固定用列出的键）与语义：")
    for ct, extra in TYPE_KEYS.items():
        lines.append(f"- {ct}：")
        for key in sorted(UNIVERSAL_KEYS | extra):
            sem = FIELD_SEMANTICS[ct].get(key, "")
            lines.append(f"  - {key}（{_type_label(key)}）：{sem}")
    lines.append("任何日期都用 deadline 或 constraints 承载，不要自创 presentation_date 之类的键。")
    lines.append("")
    lines.append("status 语义：")
    for st, desc in STATUS_SEMANTICS.items():
        lines.append(f"- {st}：{desc}")
    lines.append("")
    lines.append("时间规则：")
    lines.extend(f"{i}. {r}" for i, r in enumerate(TIME_RULES, 1))
    lines.append("")
    lines.append("聊天窗口规则：")
    lines.extend(f"{i}. {r}" for i, r in enumerate(CHAT_RULES, 1))
    lines.append("")
    lines.append("排除与引用规则：")
    lines.extend(f"{i}. {r}" for i, r in enumerate(EXCLUSION_RULES, 1))
    lines.append("")
    lines.append("硬规则：")
    lines.append('1. 原文没写的信息一律 status="missing"、value=null、raw=""。绝不推测，绝不补造事实。')
    lines.append("2. candidate 字段必须给出非 null 的 value；给不出值就标 missing。")
    lines.append('3. 不要输出 status="confirmed"，确认只能由用户做。')
    lines.append("4. warnings.code 只能取：" + "、".join(sorted(WARNING_CODES)) + "；不要自造码。")
    return "\n".join(lines)
