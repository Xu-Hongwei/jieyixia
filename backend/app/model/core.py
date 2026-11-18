"""厂家无关的核心：prompt 渲染、输出解析、时间节点规范化与确定性选主。

V3-2：自然语言→ISO 由模型完成（标 basis），后端只做格式/日历/诚实性校验与选主，
不再用关键词正则解析自然语言。推算值必须标 derived + unresolved（PRD 规则 7）。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from pydantic import ValidationError

from .._contract import (
    AnalyzeRequest,
    AnalyzeResponse,
    ContentType,
    Field,
    FieldOrigin,
    FieldStatus,
    Quote,
    TimeNode,
    Warning,
    BACKEND_GENERATED_CODES,
    WARNING_CODES,
    WARNING_SYNONYMS,
)
from .base import ModelError
from .render_prompt import render_system_prompt

SYSTEM_PROMPT = render_system_prompt()

_ALLOWED_STATUS = {FieldStatus.candidate, FieldStatus.unresolved, FieldStatus.missing}
_DATETIME_SHAPE = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}:\d{2}|Z)?$")


def _fold_end_of_day(value: str) -> str:
    """中文通知常用「24:00」表示当日结束。24 点不是合法 ISO 时刻，折叠为 date 精度。"""
    match = re.match(r"^(\d{4}-\d{2}-\d{2})T24:00(:00)?([+-]\d{2}:\d{2}|Z)?$", value)
    return match.group(1) if match else value


def _check_calendar(value: str, key: str) -> None:
    """正则只查形状；日历合法性（2月30、13月、25点）必须真解析验证。"""
    if re.match(r"^\d{4}-\d{2}-\d{2}(T|$)", value):
        try:
            datetime.fromisoformat(value)
        except ValueError as exc:
            raise ModelError("invalid_output", f"字段 {key} 含非法日历值", True) from exc


def canonical_datetime(value: str) -> str:
    """统一 datetime 序列化：补秒、Z→+00:00；date-only 原样。

    缺时区**不补**：浏览器 toISOString() 永远是 UTC，用保存时区去补内容时刻会系统性错
    （中国通知的 18:00 是本地时间）。保留 naive 让前端按用户本地时区解析，并另加
    timezone_unspecified warning 明示未知。
    """
    match = _DATETIME_SHAPE.match(value)
    if not match:
        return value
    date, hour, minute, second, tz = match.groups()
    second = second or "00"
    if tz == "Z":
        tz = "+00:00"
    return f"{date}T{hour}:{minute}:{second}{tz}" if tz else f"{date}T{hour}:{minute}:{second}"


def build_user_text(request: AnalyzeRequest) -> str:
    lines = [f"保存时间（相对时间的参照）：{request.captured_at}"]
    if request.content_hint:
        lines.append(f"用户初判的内容类型（可推翻）：{request.content_hint.value}")
    if request.kind.value == "text":
        lines.append("以下是用户粘贴的文字资料：\n\n" + (request.text or ""))
    else:
        lines.append("以下是用户上传的截图，请识别其中的文字并整理。")
    return "\n\n".join(lines)


def _normalize_node(node: Any, captured_at: str) -> dict:
    """V3-2：规范化单个时间节点。模型负责 NL→ISO，后端只校验+诚实性核对。"""
    if not isinstance(node, dict):
        raise ModelError("invalid_output", "time_nodes 中存在非对象项", True)
    n = dict(node)
    raw = n.get("raw") or ""
    value = n.get("value")
    derived = n.get("basis") in ("relative", "inferred")
    precision = None
    tz_known = None
    if isinstance(value, str):
        value = canonical_datetime(value)
        value = _fold_end_of_day(value)
        _check_calendar(value, "time_nodes")
        year = re.match(r"^(\d{4})-\d{2}-\d{2}", value)
        if year and year.group(1) not in raw:
            derived = True
        if re.match(r"^\d{4}-\d{2}-\d{2}$", value):
            precision = "date"
        else:
            shape = _DATETIME_SHAPE.match(value)
            if shape:
                precision = "datetime"
                tz_known = shape.group(5) is not None
                if shape.group(5):
                    tz = shape.group(5)
                    if tz not in raw and not (tz == "+00:00" and "Z" in raw):
                        value = value[: -len(tz)]
                        tz_known = False
    n.update(value=value, precision=precision, tz_known=tz_known, derived=derived)
    try:
        return TimeNode.model_validate(n).model_dump(mode="json")
    except ValidationError as exc:
        raise ModelError("invalid_output", "time_node 不符合契约", True) from exc


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ModelError("invalid_output", "模型输出中找不到 JSON 对象", True)
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ModelError("invalid_output", f"模型输出不是合法 JSON（{exc.msg}）", True) from exc
    if not isinstance(parsed, dict):
        raise ModelError("invalid_output", "模型输出顶层不是对象", True)
    return parsed


def _build_field(raw_field: Any, source_id: str, captured_at: str) -> tuple[Field, bool, bool]:
    if not isinstance(raw_field, dict):
        raise ModelError("invalid_output", "fields 中存在非对象项", True)
    key = raw_field.get("key")
    if not isinstance(key, str) or not key:
        raise ModelError("invalid_output", "字段缺少 key", True)

    status_raw = raw_field.get("status", "candidate")
    try:
        status = FieldStatus(status_raw)
    except ValueError as exc:
        raise ModelError("invalid_output", f"字段 {key} 的 status 非法", True) from exc
    if status not in _ALLOWED_STATUS:
        raise ModelError("invalid_output", f"字段 {key} 不得由模型标记为 confirmed（规则 3）", True)

    raw = raw_field.get("raw") or ""
    if not isinstance(raw, str):
        raise ModelError("invalid_output", f"字段 {key} 的 raw 必须是字符串", True)

    value = raw_field.get("value")
    derived = False
    if key == "time_nodes":
        if not isinstance(value, list):
            raise ModelError("invalid_output", "time_nodes 必须是数组", True)
        value = [_normalize_node(n, captured_at) for n in value]

    downgraded = False
    if status is FieldStatus.candidate and value is None:
        status = FieldStatus.missing
        downgraded = True

    if isinstance(value, str):
        value = canonical_datetime(value)
        # 诚实性校验：模型可能自行补年份/时区。原文没有的，不算事实。
        year_match = re.match(r"^(\d{4})-\d{2}-\d{2}", value)
        if year_match and year_match.group(1) not in raw:
            derived = True
            status = FieldStatus.unresolved
        shape = _DATETIME_SHAPE.match(value)
        if shape and shape.group(5):
            tz = shape.group(5)
            present = tz in raw or (tz == "+00:00" and "Z" in raw)
            if not present:
                value = value[: -len(tz)]

    precision = None
    tz_known = None
    if isinstance(value, str):
        value = _fold_end_of_day(value)
        _check_calendar(value, key)
        if re.match(r"^\d{4}-\d{2}-\d{2}$", value):
            precision = "date"
        else:
            shape = _DATETIME_SHAPE.match(value)
            if shape:
                precision = "datetime"
                tz_known = shape.group(5) is not None

    quote = None
    if raw:
        quote_raw = raw_field.get("quote")
        quote_text = quote_raw.get("text") if isinstance(quote_raw, dict) else None
        quote = Quote(text=quote_text if isinstance(quote_text, str) and quote_text else raw, source_id=source_id)

    try:
        field = Field(
            key=key,
            value=None if status is FieldStatus.missing else value,
            raw=raw,
            origin=FieldOrigin.model,
            status=status,
            derived=derived,
            quote=quote,
            precision=precision,
            tz_known=tz_known,
        )
    except ValidationError as exc:
        raise ModelError("invalid_output", f"字段 {key} 不符合契约", True) from exc
    return field, derived, downgraded


def parse_model_output(
    text: str,
    *,
    source_id: str,
    captured_at: str,
    model_name: str,
) -> AnalyzeResponse:
    payload = _extract_json(text)

    try:
        content_type = ContentType(payload.get("content_type"))
    except ValueError as exc:
        raise ModelError("invalid_output", "content_type 非法", True) from exc

    raw_fields = payload.get("fields")
    if not isinstance(raw_fields, list) or not raw_fields:
        raise ModelError("invalid_output", "fields 必须是非空数组", True)

    fields: list[Field] = []
    normalized: list[str] = []
    downgraded: list[str] = []
    naive_tz: list[str] = []
    for item in raw_fields:
        field, derived, was_downgraded = _build_field(item, source_id, captured_at)
        fields.append(field)
        if derived:
            normalized.append(field.key)
        if was_downgraded:
            downgraded.append(field.key)
        if field.precision == "datetime" and field.tz_known is False:
            naive_tz.append(field.key)

    # 模型可能输出重复键：按键去重（保留最后一次），避免重复字段/重复 warning
    dedup: dict[str, Field] = {}
    for f in fields:
        dedup[f.key] = f
    fields = list(dedup.values())

    # V3-2：后端从 time_nodes 确定性选主（最早节点），消除模型选主 nondeterminism
    nodes_field = next((f for f in fields if f.key == "time_nodes"), None)
    if nodes_field and isinstance(nodes_field.value, list):
        valued = [n for n in nodes_field.value if n.get("value") and n.get("basis") != "superseded"]
        if valued:
            primary = min(valued, key=lambda n: n["value"])
            p_derived = bool(primary.get("derived"))
            p_raw = primary.get("raw") or ""
            new_dl = Field(
                key="deadline",
                value=primary["value"],
                raw=p_raw,
                origin=FieldOrigin.model,
                status=FieldStatus.unresolved if p_derived else FieldStatus.candidate,
                derived=p_derived,
                quote=Quote(text=p_raw, source_id=source_id) if p_raw else None,
                precision=primary.get("precision"),
                tz_known=primary.get("tz_known"),
            )
            existing = next((f for f in fields if f.key == "deadline"), None)
            if existing:
                fields[fields.index(existing)] = new_dl
            else:
                fields.append(new_dl)
    normalized = [f.key for f in fields if f.derived]
    naive_tz = [f.key for f in fields if f.precision == "datetime" and f.tz_known is False]

    warnings: list[Warning] = []
    for item in payload.get("warnings") or []:
        if isinstance(item, dict) and item.get("code") and item.get("message"):
            code = WARNING_SYNONYMS.get(str(item["code"]), str(item["code"]))
            if code not in WARNING_CODES or code in BACKEND_GENERATED_CODES:
                continue  # V3-3：码表封闭；后端权威码忽略模型自报
            warnings.append(
                Warning(
                    code=code,
                    message=str(item["message"])[:500],
                    field_key=item.get("field_key") if isinstance(item.get("field_key"), str) else None,
                )
            )
    for key in normalized:
        field = next(x for x in fields if x.key == key)
        if not re.search(r"\d{4}", field.raw):
            warnings.append(
                Warning(
                    code="date_year_inferred",
                    message=f"「{key}」原文只有月日没有年份，年份参照保存时间补全，属推测值，需用户确认",
                    field_key=key,
                )
            )
        else:
            warnings.append(
                Warning(
                    code="relative_date_derived",
                    message=f"「{key}」由保存时间换算得到，属推测值，需用户确认具体日期",
                    field_key=key,
                )
            )
    for key in downgraded:
        warnings.append(
            Warning(
                code="candidate_without_value",
                message=f"「{key}」模型标为 candidate 却未给值，已降级为 missing",
                field_key=key,
            )
        )
    for key in naive_tz:
        warnings.append(
            Warning(
                code="timezone_unspecified",
                message=f"「{key}」原文未写时区，保留为本地 naive 时间，由前端按用户时区解析；如需精确请用户确认",
                field_key=key,
            )
        )

    # 模型自报与后端生成可能同码同字段：去重，后端版本优先
    seen_warnings: dict[tuple, Warning] = {}
    for w in warnings:
        seen_warnings[(w.code, w.field_key)] = w
    warnings = list(seen_warnings.values())

    try:
        return AnalyzeResponse(
            source_id=source_id,
            content_type=content_type,
            fields=fields,
            warnings=warnings,
            analyzed_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            model_name=model_name,
        )
    except ValidationError as exc:
        raise ModelError("invalid_output", "模型输出整体不符合契约", True) from exc
