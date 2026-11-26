"""统一时间合法性 + 北京时间默认解释的单一来源回归。

证明两件事：
1. 非法日历/时钟/时区偏移（+08:75、+08:60、+25:00）被拒绝，不被 fromisoformat 静默归一；
   合法毫秒/闰日/跨年/Z/明确偏移一律保留。
2. naive 按北京时间解释、明确偏移转同一绝对时刻比较（绝不把偏移替换成 +08:00）；
   date-only 逾期边界为北京时间次日 00:00，不补 23:59。
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.time_rules import (
    BEIJING,
    TimeValueError,
    beijing_date_deadline_instant,
    interpret_instant,
    parse_iso_date,
    parse_iso_datetime,
)


# ---------------------------------------------------------------- 非法偏移/日历/时钟
@pytest.mark.parametrize("bad", [
    "2026-11-18T10:00:00+08:75",
    "2026-11-18T10:00:00+08:60",
    "2026-11-18T10:00:00+25:00",
    "2026-11-18T10:00:00+99:99",
    "2026-11-18T10:00:00-08:75",
])
def test_illegal_offset_rejected_not_silently_normalized(bad):
    # fromisoformat 会把 +08:75 静默变成 +09:15；这里必须先拒绝
    with pytest.raises(TimeValueError):
        parse_iso_datetime(bad)


@pytest.mark.parametrize("bad", [
    "2026-02-30T10:00:00+08:00",
    "2026-13-01T00:00:00Z",
    "2026-11-18T25:00:00+08:00",
    "2026-11-18T10:61:00+08:00",
    "2026-11-31T10:00:00",
])
def test_illegal_calendar_or_clock_rejected(bad):
    with pytest.raises(TimeValueError):
        parse_iso_datetime(bad)


@pytest.mark.parametrize("good", [
    "2026-11-18T10:00:00",
    "2026-11-18T10:00:00.663Z",
    "2026-11-18T10:00:00+08:00",
    "2026-11-18T10:00:00-05:00",
    "2026-11-18T10:00:00+00:00",
    "2028-02-29T10:00:00+08:00",
    "2026-12-31T23:59:59Z",
    "2027-01-01T00:00:00+08:00",
])
def test_legal_ms_leap_crossyear_offset_preserved(good):
    dt = parse_iso_datetime(good)
    assert isinstance(dt, datetime)


def test_explicit_offset_keeps_actual_meaning():
    # +09:00 的 18:00 实际是 09:00 UTC，绝不能被当成 +08:00 的 18:00
    dt = parse_iso_datetime("2026-11-18T18:00:00+09:00")
    assert dt.utcoffset().total_seconds() == 9 * 3600
    assert dt.astimezone(timezone.utc).hour == 9


# ---------------------------------------------------------------- date-only
@pytest.mark.parametrize("bad", ["2026-02-30", "2026-13-01", "2026-11-31", "2026-1-1", "20261118", "2026-11-18T10:00:00"])
def test_bad_date_rejected(bad):
    with pytest.raises(TimeValueError):
        parse_iso_date(bad)


@pytest.mark.parametrize("good", ["2026-11-18", "2028-02-29", "2026-12-31", "2027-01-01"])
def test_good_date_accepted(good):
    assert parse_iso_date(good).strftime("%Y-%m-%d") == good


# ---------------------------------------------------------------- 北京时间解释
def test_naive_interpreted_as_beijing():
    # 原文未注明时区的 10:00 按北京时间解释 → 02:00 UTC（不跟随服务器/设备时区）
    assert interpret_instant("2026-11-18T10:00:00") == datetime(2026, 11, 18, 2, 0, 0, tzinfo=timezone.utc)


def test_naive_beijing_equals_explicit_plus08():
    assert interpret_instant("2026-11-18T14:30:00") == interpret_instant("2026-11-18T14:30:00+08:00")


def test_explicit_other_offset_converted_to_same_instant_not_replaced():
    # +00:00 的 09:00 与 +08:00 的 17:00 是同一时刻；naive 09:00 则是 01:00 UTC，三者不可混淆
    assert interpret_instant("2026-11-18T09:00:00+00:00") == interpret_instant("2026-11-18T17:00:00+08:00")
    assert interpret_instant("2026-11-18T09:00:00+00:00") != interpret_instant("2026-11-18T09:00:00")


def test_beijing_default_is_fixed_utc8():
    assert BEIJING.utcoffset(None).total_seconds() == 8 * 3600


# ---------------------------------------------------------------- date 逾期边界
def test_date_deadline_overdue_from_beijing_next_day_midnight():
    edge = beijing_date_deadline_instant("2026-11-18")
    assert edge == datetime(2026, 11, 19, 0, 0, 0, tzinfo=BEIJING)
    assert edge.hour == 0 and edge.minute == 0, "不补 23:59"
    # 当天 23:59（北京）仍有效，次日 00:00 起逾期
    assert datetime(2026, 11, 18, 23, 59, tzinfo=BEIJING) < edge
    assert datetime(2026, 11, 19, 0, 0, tzinfo=BEIJING) >= edge


def test_date_deadline_cross_year_boundary():
    assert beijing_date_deadline_instant("2026-12-31") == datetime(2027, 1, 1, 0, 0, 0, tzinfo=BEIJING)


def test_date_deadline_leap_day_boundary():
    assert beijing_date_deadline_instant("2028-02-29") == datetime(2028, 3, 1, 0, 0, 0, tzinfo=BEIJING)