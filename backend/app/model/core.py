"""厂家无关的核心：prompt、输出解析、相对日期规范化。

换厂家只换适配器，这里不动。相对日期由后端确定性换算，不交给模型自由发挥
（PRD 规则 7：未知日期不伪造，换算值必须标 derived + unresolved）。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
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
    Warning,
)
from .base import ModelError
from .render_prompt import render_system_prompt

SYSTEM_PROMPT = render_system_prompt()

_ALLOWED_STATUS = {FieldStatus.candidate, FieldStatus.unresolved, FieldStatus.missing}
_WEEKDAY = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
_RELATIVE_WEEK = re.compile(r"(下下|下|本|这)?(?:周|星期)([一二三四五六日天])")
_FULL_DATE = re.compile(r"(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?")
_MONTH_DAY = re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日")
_MONTH_DAY_DOT = re.compile(r"(?<!\d)(\d{1,2})[./](\d{1,2})(?!\d)")
_CLOCK = re.compile(r"(\d{1,2}):(\d{2})")
_CN_CLOCK = re.compile(r"(下午|晚上|上午|中午)?\s*(\d{1,2})\s*点")
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


def extract_explicit_date(raw: str, captured_at: str) -> tuple[str, bool] | None:
    """从原文抽明确日期。带年份 → derived=False；只有月日 → 参照保存时间补年份，derived=True。

    真实样本教训：「本周二（5.12）」这类相对词+括号明确日期，必须让明确日期赢；
    「9月19日17:00」这类缺年份月日不能整条丢掉。
    """
    try:
        base = datetime.fromisoformat(captured_at)
    except ValueError:
        return None
    match = _FULL_DATE.search(raw)
    if match:
        year, month, day = (int(x) for x in match.groups())
        derived = False
    else:
        match = _MONTH_DAY.search(raw) or _MONTH_DAY_DOT.search(raw)
        if not match:
            return None
        year = base.year
        month, day = (int(x) for x in match.groups())
        derived = True
    try:
        date = datetime(year, month, day)
    except ValueError:
        return None

    return date.strftime("%Y-%m-%d") + _clock_suffix(raw), derived


def build_user_text(request: AnalyzeRequest) -> str:
    lines = [f"保存时间（相对时间的参照）：{request.captured_at}"]
    if request.content_hint:
        lines.append(f"用户初判的内容类型（可推翻）：{request.content_hint.value}")
    if request.kind.value == "text":
        lines.append("以下是用户粘贴的文字资料：\n\n" + (request.text or ""))
    else:
        lines.append("以下是用户上传的截图，请识别其中的文字并整理。")
    return "\n\n".join(lines)


def _clock_suffix(raw: str) -> str:
    """从原文抽时刻后缀；没有则空串。相对日期与明确日期共用。"""
    hm = _CLOCK.search(raw)
    if hm:
        return f"T{int(hm.group(1)):02d}:{hm.group(2)}"
    cn = _CN_CLOCK.search(raw)
    if cn:
        hour = int(cn.group(2))
        if cn.group(1) in ("下午", "晚上") and hour < 12:
            hour += 12
        return f"T{hour:02d}:00"
    return ""


def resolve_relative_date(raw: str, captured_at: str) -> str | None:
    """把相对时间换算成 ISO 日期（原文带时刻则组合时刻）。换算不出就返回 None，绝不猜。"""
    try:
        base = datetime.fromisoformat(captured_at).date()
    except ValueError:
        return None
    text = raw.strip()
    if "大后天" in text:
        day = base + timedelta(days=3)
    elif "后天" in text:
        day = base + timedelta(days=2)
    elif "明天" in text:
        day = base + timedelta(days=1)
    elif "今天" in text or "今日" in text:
        day = base
    else:
        match = _RELATIVE_WEEK.search(text)
        if not match:
            return None
        prefix, target = match.group(1), _WEEKDAY[match.group(2)]
        if prefix in ("本", "这"):
            delta = target - base.weekday()
        elif prefix == "下":
            delta = target - base.weekday() + 7
        elif prefix == "下下":
            delta = target - base.weekday() + 14
        else:
            delta = (target - base.weekday()) % 7
            if delta == 0:
                delta = 7
        day = base + timedelta(days=delta)
    return day.isoformat() + _clock_suffix(text)


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
    if status is FieldStatus.unresolved and value is None:
        explicit = extract_explicit_date(raw, captured_at)
        if explicit:
            value, derived = explicit
            if not derived:
                status = FieldStatus.candidate
        else:
            resolved = resolve_relative_date(raw, captured_at)
            if resolved:
                value, derived = resolved, True

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

    warnings: list[Warning] = []
    for item in payload.get("warnings") or []:
        if isinstance(item, dict) and item.get("code") and item.get("message"):
            warnings.append(
                Warning(
                    code=str(item["code"])[:64],
                    message=str(item["message"])[:500],
                    field_key=item.get("field_key") if isinstance(item.get("field_key"), str) else None,
                )
            )
    for key in normalized:
        field = next(x for x in fields if x.key == key)
        if extract_explicit_date(field.raw, captured_at):
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
