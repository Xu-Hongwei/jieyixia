import { describe, expect, it } from 'vitest'
import {
  beijingAddDays, beijingDateStr, beijingDayStartMs, beijingInstantLabel, beijingTodayLabel, beijingWeekday,
  interpretInstant, isOverdue, isToday, isValidDate, isValidTimeValue, nextBeijingMidnightMs, replaceClockKeepSeconds,
} from '../domains/time'

describe('isValidTimeValue 形状 + 日历 + 时钟 + 偏移', () => {
  it('合法日期与 datetime', () => {
    expect(isValidTimeValue('2026-11-20')).toBe(true)
    expect(isValidTimeValue('2026-11-20T17:00')).toBe(true)
    expect(isValidTimeValue('2026-11-20T17:00:00+08:00')).toBe(true)
    expect(isValidTimeValue('2026-11-20T17:00:00Z')).toBe(true)
  })
  it('日历非法拒绝', () => {
    expect(isValidTimeValue('2026-02-30')).toBe(false)
    expect(isValidTimeValue('2026-13-01')).toBe(false)
  })
  it('时钟非法拒绝', () => {
    expect(isValidTimeValue('2026-11-20T25:00')).toBe(false)
    expect(isValidTimeValue('2026-11-20T17:75')).toBe(false)
  })
  it('UTC 偏移非法拒绝', () => {
    expect(isValidTimeValue('2026-11-20T17:00:00+99:99')).toBe(false)
    expect(isValidTimeValue('2026-11-20T17:00:00+08:75')).toBe(false)
  })
  it('isValidDate 只收日期', () => {
    expect(isValidDate('2026-11-20')).toBe(true)
    expect(isValidDate('2026-11-20T17:00')).toBe(false)
  })
})

describe('isOverdue 口径', () => {
  const now = new Date('2026-11-18T10:00:00+08:00')
  it('date 型当天不判逾期，次日起算', () => {
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-11-18', precision: 'date' } }, now)).toBe(false)
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-11-17', precision: 'date' } }, now)).toBe(true)
  })
  it('datetime 带时区按绝对时刻', () => {
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-11-18T01:00:00Z', precision: 'datetime' } }, now)).toBe(true)
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-11-18T12:00:00+08:00', precision: 'datetime' } }, now)).toBe(false)
  })
  it('done 不判逾期', () => {
    expect(isOverdue({ status: 'done', deadline: { value: '2026-11-01', precision: 'date' } }, now)).toBe(false)
  })
})

describe('北京日界与设备时区无关', () => {
  it('UTC 16:30 已是北京次日，UTC 15:59 仍是北京当日', () => {
    expect(beijingDateStr(new Date('2026-11-18T16:30:00Z'))).toBe('2026-11-19')
    expect(beijingDateStr(new Date('2026-11-18T15:59:00Z'))).toBe('2026-11-18')
  })
  it('同一瞬时无论设备时区如何，北京日期唯一（仅依赖 getTime + 固定偏移）', () => {
    const instant = new Date('2026-11-18T16:30:00Z')
    expect(beijingDateStr(instant)).toBe('2026-11-19')
    expect(beijingDateStr(instant.getTime())).toBe('2026-11-19')
  })
  it('date 型逾期按北京日界：北京今天当天不逾期，次日起逾期', () => {
    const now = new Date('2026-11-18T16:30:00Z') // 北京 11-19 00:30
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-11-19', precision: 'date' } }, now)).toBe(false)
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-11-18', precision: 'date' } }, now)).toBe(true)
  })
  it('跨年 / 闰日边界', () => {
    const yearEnd = new Date('2026-12-31T16:30:00Z') // 北京 2027-01-01 00:30
    expect(beijingDateStr(yearEnd)).toBe('2027-01-01')
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-12-31', precision: 'date' } }, yearEnd)).toBe(true)
    expect(beijingAddDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(beijingAddDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(beijingAddDays('2028-02-29', 1)).toBe('2028-03-01')
  })
})

describe('interpretInstant：naive 按北京、明确偏移转同一时刻', () => {
  it('naive datetime 按北京墙上时间解释', () => {
    expect(interpretInstant('2026-11-18T10:00:00')).toBe(new Date('2026-11-18T02:00:00Z').getTime())
  })
  it('明确偏移保留实际时刻，不被替换成 +08:00', () => {
    expect(interpretInstant('2026-11-18T18:00:00+09:00')).toBe(new Date('2026-11-18T09:00:00Z').getTime())
    expect(interpretInstant('2026-11-18T01:00:00Z')).toBe(new Date('2026-11-18T01:00:00Z').getTime())
  })
  it('naive 与明确偏移指向同一绝对时刻则相等', () => {
    expect(interpretInstant('2026-11-18T17:00:00')).toBe(interpretInstant('2026-11-18T17:00:00+08:00'))
  })
  it('date-only 解释为北京当日 00:00', () => {
    expect(interpretInstant('2026-11-18')).toBe(beijingDayStartMs('2026-11-18'))
  })
  it('非法值返回 null', () => {
    expect(interpretInstant('2026-02-30')).toBeNull()
    expect(interpretInstant('2026-11-18T10:00:00+08:75')).toBeNull()
  })
  it('datetime 逾期：naive 与偏移按同一绝对时刻可比', () => {
    const now = new Date('2026-11-18T10:00:00+08:00') // 02:00Z
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-11-18T09:00:00', precision: 'datetime' } }, now)).toBe(true) // 北京 09:00 = 01:00Z < 02:00Z
    expect(isOverdue({ status: 'todo', deadline: { value: '2026-11-18T18:00:00+09:00', precision: 'datetime' } }, now)).toBe(false) // 09:00Z > 02:00Z，不逾期
  })
})

describe('今天分组 isToday', () => {
  const now = new Date('2026-11-18T16:30:00Z') // 北京 11-19
  it('date 型等于北京今天', () => {
    expect(isToday('2026-11-19', 'date', now)).toBe(true)
    expect(isToday('2026-11-18', 'date', now)).toBe(false)
  })
  it('datetime 型按北京日界归组', () => {
    expect(isToday('2026-11-19T00:30:00', 'datetime', now)).toBe(true)
    expect(isToday('2026-11-18T23:00:00Z', 'datetime', now)).toBe(true) // 北京 11-19 07:00
    expect(isToday('2026-11-18T15:00:00Z', 'datetime', now)).toBe(false) // 北京 11-18 23:00
  })
})

describe('快捷按钮日期数学 beijingAddDays', () => {
  it('今天 / 明天 / 7 天后', () => {
    expect(beijingAddDays('2026-11-18', 0)).toBe('2026-11-18')
    expect(beijingAddDays('2026-11-18', 1)).toBe('2026-11-19')
    expect(beijingAddDays('2026-11-18', 7)).toBe('2026-11-25')
  })
  it('月末进位', () => {
    expect(beijingAddDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(beijingAddDays('2026-01-31', 1)).toBe('2026-02-01')
  })
})

describe('beijingTodayLabel', () => {
  it('含北京日期与星期（UTC 16:30 已是北京 11-19）', () => {
    const label = beijingTodayLabel(new Date('2026-11-18T16:30:00Z'))
    expect(label.startsWith('2026年11月19日')).toBe(true)
    expect(/周[日一二三四五六]$/.test(label)).toBe(true)
  })
})

describe('beijingWeekday：日历网格星期与设备时区无关', () => {
  it('已知锚点（0=周日…6=周六）', () => {
    expect(beijingWeekday('2024-01-01')).toBe(1) // 周一
    expect(beijingWeekday('2024-02-29')).toBe(4) // 闰日周四
    expect(beijingWeekday('2026-11-19')).toBe(4) // 周四
    expect(beijingWeekday('2026-11-22')).toBe(0) // 周日
  })
  it('周一为首网格的 leading 偏移：2026-11-01 周日 → 6；2026-12-01 周二 → 1', () => {
    expect((beijingWeekday('2026-11-01') + 6) % 7).toBe(6)
    expect((beijingWeekday('2026-12-01') + 6) % 7).toBe(1)
  })
  it('加 7 天星期不变', () => {
    expect(beijingWeekday(beijingAddDays('2026-11-19', 7))).toBe(beijingWeekday('2026-11-19'))
  })
})
describe('beijingInstantLabel：收集时刻按原偏移换算到北京墙上时间', () => {
  it('Z 时刻换算 +8（04:57Z → 12:57 北京）', () => {
    expect(beijingInstantLabel('2026-11-19T04:57:13.714Z')).toBe('2026年11月19日 12:57（北京时间）')
  })
  it('跨日：Z 晚间换算到北京次日', () => {
    expect(beijingInstantLabel('2026-11-19T20:00:00Z')).toBe('2026年11月20日 04:00（北京时间）')
  })
  it('带 -05:00 偏移按原义换算（不替换偏移）', () => {
    expect(beijingInstantLabel('2026-11-19T04:57:00-05:00')).toBe('2026年11月19日 17:57（北京时间）')
  })
  it('naive 按北京墙上时间解释', () => {
    expect(beijingInstantLabel('2026-11-19T12:57')).toBe('2026年11月19日 12:57（北京时间）')
  })
  it('非法/空值回退原文或空串', () => {
    expect(beijingInstantLabel('2026-02-30T10:00Z')).toBe('2026-02-30T10:00Z')
    expect(beijingInstantLabel('')).toBe('')
  })
})

describe('nextBeijingMidnightMs：跨午夜动态刷新锚点', () => {
  it('北京晚间 → 次日北京子夜', () => {
    const now = new Date('2026-11-19T20:00:00+08:00')
    expect(nextBeijingMidnightMs(now)).toBe(Date.UTC(2026, 10, 19, 16, 0, 0))
  })
  it('北京子夜整点 → 再下一子夜', () => {
    const now = new Date('2026-11-19T00:00:00+08:00')
    expect(nextBeijingMidnightMs(now)).toBe(Date.UTC(2026, 10, 19, 16, 0, 0))
  })
  it('与设备时区无关（用 UTC ms 输入）', () => {
    const ms = Date.UTC(2026, 10, 19, 16, 0, 0) // 北京 11-20 00:00
    expect(nextBeijingMidnightMs(ms)).toBe(Date.UTC(2026, 10, 20, 16, 0, 0))
  })
})

describe('replaceClockKeepSeconds：主动改时间保留秒与偏移', () => {
  it('保留原文秒 + 偏移', () => {
    expect(replaceClockKeepSeconds('T17:00:30+08:00', '09:05')).toBe('T09:05:30+08:00')
  })
  it('保留 Z', () => {
    expect(replaceClockKeepSeconds('T17:00Z', '09:05')).toBe('T09:05Z')
  })
  it('naive 无偏移不补偏移', () => {
    expect(replaceClockKeepSeconds('T17:00', '09:05')).toBe('T09:05')
  })
  it('原文无时间尾巴 → 仅 HH:MM', () => {
    expect(replaceClockKeepSeconds('', '09:05')).toBe('T09:05')
  })
  it('清空时间 → 空尾巴（仅日期）', () => {
    expect(replaceClockKeepSeconds('T17:00:30+08:00', '')).toBe('')
  })
})
