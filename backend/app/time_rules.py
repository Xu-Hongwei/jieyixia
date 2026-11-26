"""统一时间合法性校验 + 北京时间默认解释（产品默认中国标准时间，不跟随服务器/设备时区）。

两件事，单一来源，供请求校验（validation.py）与模型输出规范化（core.py）共用：

1. 严格日历/时钟/时区偏移校验。`datetime.fromisoformat` 会把 `+08:75` 静默归一成 `+09:15`、
   `+08:60` 归一成 `+09:00`——这是「用静默转换掩盖非法输入」。这里先显式校验偏移分钟 0-59、
   小时 0-23，再交给 fromisoformat 验日历/时钟。合法毫秒、闰日、跨年、明确偏移一律保留。

2. 北京时间（UTC+08:00 / Asia/Shanghai）业务解释。原文未注明时区的 naive datetime 在**业务计算**
   中按北京时间解释；原文明示其他偏移时保留实际含义，比较时转换成同一绝对时刻，绝不把偏移
   直接替换成 +08:00。date-only 值保留 YYYY-MM-DD，不补 23:59，逾期从北京时间次日 00:00 起判。

注意：本模块只做「解释/计算」，不改写模型输出的 value——value 仍忠实保留原文形状（naive 保持
naive，tz_known=False），产品默认解释由 warning 与元数据承载，不冒充原文事实。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

# 产品默认时区：中国标准时间 UTC+08:00（Asia/Shanghai，无夏令时）。不读服务器/设备本地时区。
BEIJING = timezone(timedelta(hours=8))

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_OFFSET_RE = re.compile(r"([+-])(\d{2}):(\d{2})$")


class TimeValueError(ValueError):
    """时间值非法：日历/时钟/时区偏移越界。调用方据此映射 422 或 invalid_output。"""


def _check_offset(value: str) -> None:
    match = _OFFSET_RE.search(value)
    if match:
        _sign, hh, mm = match.groups()
        if int(hh) > 23 or int(mm) > 59:
            raise TimeValueError(f"非法时区偏移（小时须 00-23、分钟须 00-59）：{value}")


def parse_iso_datetime(value: str) -> datetime:
    """严格解析 ISO datetime：先拒非法偏移，再验日历/时钟。保留合法毫秒/Z/明确偏移。"""
    _check_offset(value)
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise TimeValueError(f"非法日历日期时间：{value}") from exc


def parse_iso_date(value: str) -> datetime:
    """严格解析 YYYY-MM-DD：形状 + 真实日历（拒 2026-02-30）。"""
    if not _DATE_RE.match(value):
        raise TimeValueError(f"必须是 YYYY-MM-DD：{value}")
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise TimeValueError(f"非法日历日期：{value}") from exc


def interpret_instant(value: str) -> datetime:
    """业务计算用的绝对时刻：naive 按北京时间解释，明确偏移保留实际含义，统一转 UTC 比较。

    绝不把明确偏移替换成 +08:00——+00:00 的 09:00 与 +08:00 的 14:30 转成同一时刻后再比。
    """
    dt = parse_iso_datetime(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BEIJING)
    return dt.astimezone(timezone.utc)


def beijing_date_deadline_instant(date_str: str) -> datetime:
    """date-only 截止的逾期边界：北京时间次日 00:00（不补 23:59）。

    「2026-11-18」整天有效，从 2026-11-19T00:00:00+08:00 起判逾期。返回 aware datetime，
    供「今天/日期分组/逾期」按北京时间日界线统一计算（前端消费同一规则）。
    """
    day = parse_iso_date(date_str).date()
    nxt = day + timedelta(days=1)
    return datetime(nxt.year, nxt.month, nxt.day, 0, 0, 0, tzinfo=BEIJING)