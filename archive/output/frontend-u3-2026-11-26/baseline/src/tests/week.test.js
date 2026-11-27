import { describe, expect, it } from 'vitest'
import { deadlineSlot, slotClock, slotDeadlineLabel, weekDaysOf, weekGrid, weekRangeLabel, weekStartOf } from '../domains/week'

const NOW = new Date('2026-11-18T10:00:00+08:00') // 北京周三
const task = (id, title, value, precision = 'datetime', extra = {}) => ({
  id, kind: 'task', title, status: 'todo', deadline: value ? { value, precision, source: 'manual' } : { value: null, precision: 'none' }, ...extra,
})

describe('周起始与范围', () => {
  it('周三回退到本周一', () => {
    expect(weekStartOf('2026-11-18')).toBe('2026-11-16')
  })
  it('周日属于上一周（周一为首）', () => {
    expect(weekStartOf('2026-11-22')).toBe('2026-11-16')
    expect(weekStartOf('2026-11-23')).toBe('2026-11-23')
  })
  it('跨月与跨年周正确', () => {
    expect(weekStartOf('2026-12-01')).toBe('2026-11-30')
    expect(weekDaysOf('2026-12-28')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'])
    expect(weekRangeLabel('2026-12-28')).toBe('12.28 — 1.3')
  })
  it('周范围标题', () => {
    expect(weekRangeLabel('2026-11-16')).toBe('11.16 — 11.22')
  })
})

describe('截止落位', () => {
  it('naive  datetime 按北京墙上时间', () => {
    expect(deadlineSlot({ value: '2026-11-19T09:30', precision: 'datetime' })).toEqual({ day: '2026-11-19', minutes: 570 })
  })
  it('Z 偏移换算到北京同一时刻再落位（跨日）', () => {
    // 11-15T23:30Z = 北京 11-16 07:30
    expect(deadlineSlot({ value: '2026-11-15T23:30:00Z', precision: 'datetime' })).toEqual({ day: '2026-11-16', minutes: 450 })
  })
  it('仅日期 minutes=null', () => {
    expect(deadlineSlot({ value: '2026-11-20', precision: 'date' })).toEqual({ day: '2026-11-20', minutes: null })
  })
  it('无截止/非法返回 null', () => {
    expect(deadlineSlot({ value: null, precision: 'none' })).toBeNull()
    expect(deadlineSlot(null)).toBeNull()
    expect(deadlineSlot({ value: '2026-02-30', precision: 'date' })).toBeNull()
  })
})

describe('周网格', () => {
  const tasks = [
    task('t1', '晚截止', '2026-11-18T23:59:00+08:00'),
    task('t2', '早截止', '2026-11-18T09:00:00+08:00'),
    task('t3', '仅日期', '2026-11-18', 'date'),
    task('t4', '下周一', '2026-11-23T10:00:00+08:00'),
    task('t5', '无截止', null),
    task('t6', '已完成', '2026-11-19T14:00:00+08:00', 'datetime', { status: 'done' }),
    task('t7', '同事项另一时间', '2026-11-20T18:00:00+08:00', 'datetime', { matter_id: 'm1' }),
    task('t8', '同事项同日', '2026-11-18T10:45:00+08:00', 'datetime', { matter_id: 'm1' }),
  ]
  const grid = weekGrid(tasks, weekStartOf('2026-11-18'), NOW)

  it('7 列周一为首，今天标记正确', () => {
    expect(grid.days.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'])
    expect(grid.days.map((d) => d.isToday)).toEqual([false, false, true, false, false, false, false])
    expect(grid.days[2].weekday).toBe('周三')
  })
  it('列内按 0-24 点升序，仅日期置后', () => {
    expect(grid.days[2].items.map((i) => i.task.id)).toEqual(['t2', 't8', 't1', 't3'])
  })
  it('同事项多个时间落多个日期', () => {
    expect(grid.days[2].items.some((i) => i.task.id === 't8')).toBe(true)
    expect(grid.days[4].items.map((i) => i.task.id)).toEqual(['t7'])
  })
  it('周外任务不出现，无截止分离，done 保留', () => {
    expect(grid.count).toBe(6)
    expect(grid.undated.map((t) => t.id)).toEqual(['t5'])
    expect(grid.days[3].items.map((i) => i.task.id)).toEqual(['t6'])
  })
  it('空列留白（items 为空）', () => {
    expect(grid.days[0].items).toEqual([])
    expect(grid.days[5].items).toEqual([])
  })
})

describe('显示辅助', () => {
  it('钟点与截止标注', () => {
    expect(slotClock(570)).toBe('09:30')
    expect(slotClock(null)).toBe('')
    expect(slotDeadlineLabel({ value: '2026-11-22T23:59:00+08:00', precision: 'datetime' })).toBe('截止 11月22日 · 23:59')
    expect(slotDeadlineLabel({ value: '2026-11-20', precision: 'date' })).toBe('截止 11月20日')
  })
})