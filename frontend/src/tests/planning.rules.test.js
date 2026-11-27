// B1-02–B1-08：非金标规则测试（不同 key/预算/日期/输入排列），含冻结解释组合与宿主时区独立性。
// 全部虚构数据；基准日 2026-11-24 北京时间。
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { scheduleDaily } from '../domains/planning/schedule.js'
import { validatePlanningResult } from '../domains/planning/validate.js'
import { beijingAddDays } from '../domains/time.js'
import { START, mkDays, mkFact, mkWork, mkInput, mkOcc, segTuples, warningCodes } from './planning.helpers.js'

const D = (n) => beijingAddDays(START, n)
const run = (input, options) => {
  const result = scheduleDaily(input, options)
  validatePlanningResult(input, result)
  return result
}
const deepFreeze = (o) => {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}

describe('B1-02 容量/缓冲/过载/占用口径', () => {
  it('allocatable 向下取整：61×85% = 51，buffer=10', () => {
    const input = mkInput({ budgets: [61, 0, 0, 0, 0, 0, 0], works: [mkWork('k1', { remaining_minutes: 51 })] })
    const r = run(input)
    expect(r.days[0].buffer_minutes).toBe(10)
    expect(segTuples(r)).toEqual({ k1: [[START, 51, 1]] })
    expect(r.complete).toBe(true)
  })

  it('既有过载：不新增安排、不删旧占用，报 existing_overbook', () => {
    const input = mkInput({ budgets: [100, 0, 0, 0, 0, 0, 0], buffer: 0, occupancy: [mkOcc('p-x', { planned_minutes: 120 })], works: [mkWork('k1', { remaining_minutes: 30 })] })
    const r = run(input)
    expect(r.days[0]).toMatchObject({ committed_minutes: 120, allocated_minutes: 0, free_minutes: 0, overbooked_minutes: 20 })
    expect(r.unscheduled).toEqual([{ work_item_key: 'k1', remaining_minutes: 30, reason: 'no_capacity' }])
    expect(warningCodes(r)).toContain('existing_overbook')
    expect(r.complete).toBe(false)
  })

  it('done 占用不释放容量', () => {
    const input = mkInput({ occupancy: [mkOcc('p-d', { state: 'done', planned_minutes: 40 })], works: [mkWork('k1', { remaining_minutes: 30 })] })
    const r = run(input)
    expect(r.days[0].committed_minutes).toBe(40)
    expect(segTuples(r)).toEqual({ k1: [[D(1), 30, 1]] })
  })

  it('cancelled/moved 不占容量', () => {
    const input = mkInput({
      occupancy: [mkOcc('p-c', { state: 'cancelled', planned_minutes: 50 }), mkOcc('p-m', { state: 'moved', planned_minutes: 40 })],
      works: [mkWork('k1', { remaining_minutes: 51 })],
    })
    const r = run(input)
    expect(r.days[0].committed_minutes).toBe(0)
    expect(segTuples(r)).toEqual({ k1: [[START, 51, 1]] })
  })

  it('已删任务的 partial/done 历史仍占容量', () => {
    const input = mkInput({
      occupancy: [
        mkOcc('p-h1', { task_id: 't-gone', state: 'partial', task_ref_state: 'deleted', planned_minutes: 40 }),
        mkOcc('p-h2', { task_id: 't-gone', date: D(1), state: 'done', task_ref_state: 'deleted', planned_minutes: 20 }),
      ],
      works: [mkWork('k1', { remaining_minutes: 30 })],
    })
    const r = run(input)
    expect(r.days[0].committed_minutes).toBe(40)
    expect(r.days[1].committed_minutes).toBe(20)
    expect(segTuples(r)).toEqual({ k1: [[D(1), 30, 1]] })
  })

  it('未选中任务的窗口占用同样计入', () => {
    const input = mkInput({ occupancy: [mkOcc('p-o', { task_id: 't-unselected', planned_minutes: 40 })], works: [mkWork('k1', { remaining_minutes: 30 })] })
    const r = run(input)
    expect(r.days[0].committed_minutes).toBe(40)
    expect(segTuples(r)).toEqual({ k1: [[D(1), 30, 1]] })
  })
})

describe('B1-03 拆分/不可拆/最小段/短尾段', () => {
  it('首日 free=24 < 最小段 25：非尾段跳过，整段落次日', () => {
    const input = mkInput({ buffer: 0, budgets: [24, 60, 60, 60, 60, 60, 60], works: [mkWork('k1', { remaining_minutes: 50 })] })
    expect(segTuples(run(input))).toEqual({ k1: [[D(1), 50, 1]] })
  })

  it('最终尾段可以小于最小段：70 = 60 + 10', () => {
    const input = mkInput({ buffer: 0, works: [mkWork('k1', { remaining_minutes: 70 })] })
    expect(segTuples(run(input))).toEqual({ k1: [[START, 60, 1], [D(1), 10, 1]] })
  })

  it('恰好整段 fitting：60 单段', () => {
    const input = mkInput({ buffer: 0, works: [mkWork('k1', { remaining_minutes: 60 })] })
    expect(segTuples(run(input))).toEqual({ k1: [[START, 60, 1]] })
  })

  it('不可拆：首个放得下的整天整体安排', () => {
    const input = mkInput({ buffer: 0, budgets: [30, 70, 60, 60, 60, 60, 60], works: [mkWork('k1', { remaining_minutes: 70, splittable: false })] })
    expect(segTuples(run(input))).toEqual({ k1: [[D(1), 70, 1]] })
  })

  it('不可拆且无整天放得下：not_splittable，不偷偷拆分', () => {
    const input = mkInput({ works: [mkWork('k1', { remaining_minutes: 80, splittable: false })] })
    const r = run(input)
    expect(r.segments).toEqual([])
    expect(r.unscheduled).toEqual([{ work_item_key: 'k1', remaining_minutes: 80, reason: 'not_splittable' }])
    expect(r.complete).toBe(false)
  })
})

describe('B1-04 依赖：跨天前置/同日顺序/部分缺口/无关工作', () => {
  it('前置跨两天：后继最早日钳到前置最后段当日，同日 order 严格在后', () => {
    const input = mkInput({
      buffer: 0, budgets: [60, 100, 60, 60, 60, 60, 60],
      works: [mkWork('wa', { remaining_minutes: 100 }), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] })],
    })
    const r = run(input)
    expect(segTuples(r)).toEqual({ wa: [[START, 60, 1], [D(1), 40, 1]], wb: [[D(1), 30, 2]] })
    expect(r.complete).toBe(true)
  })

  it.each([
    ['overdue_requires_consent', { deadline_precision: 'date', deadline_value: D(-1) }, {}],
    ['outside_horizon', {}, { earliest_date: D(7) }],
  ])('前置未排完时保留后继自身的日期限制 %s', (reason, fact, work) => {
    const input = mkInput({
      budgets: Array(7).fill(0),
      facts: [mkFact('t-1'), mkFact('t-2', fact)],
      works: [mkWork('w1'), mkWork('w4', { task_ref: { kind: 'existing', id: 't-2' }, depends_on: ['w1'], ...work })],
    })
    const result = run(input)
    expect(result.segments).toHaveLength(0)
    expect(result.unscheduled).toContainEqual({ work_item_key: 'w4', remaining_minutes: 60, reason })
  })

  it('前置部分缺口：后继 dependency_blocked，不当作已完成', () => {
    const input = mkInput({
      buffer: 0, budgets: [30, 0, 0, 0, 0, 0, 0],
      works: [mkWork('wa', { remaining_minutes: 45 }), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] })],
    })
    const r = run(input)
    expect(r.unscheduled).toEqual([
      { work_item_key: 'wa', remaining_minutes: 15, reason: 'no_capacity' },
      { work_item_key: 'wb', remaining_minutes: 30, reason: 'dependency_blocked' },
    ])
  })

  it('前置缺口不影响无关工作继续排', () => {
    const input = mkInput({
      buffer: 0, budgets: [30, 10, 0, 0, 0, 0, 0],
      works: [mkWork('wa', { remaining_minutes: 45 }), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] }), mkWork('wc', { remaining_minutes: 10 })],
    })
    const r = run(input)
    expect(segTuples(r).wc).toEqual([[D(1), 10, 1]])
    expect(r.unscheduled.find((u) => u.work_item_key === 'wa')).toEqual({ work_item_key: 'wa', remaining_minutes: 15, reason: 'no_capacity' })
    expect(r.unscheduled.find((u) => u.work_item_key === 'wb').reason).toBe('dependency_blocked')
  })

  it('前置估时未知：后继不得排', () => {
    const input = mkInput({ works: [mkWork('wa', { remaining_minutes: null }), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] })] })
    const r = run(input)
    expect(r.unknown_items.map((u) => u.work_item_key)).toEqual(['wa'])
    expect(r.unscheduled).toEqual([{ work_item_key: 'wb', remaining_minutes: 30, reason: 'dependency_blocked' }])
    expect(r.complete).toBe(false)
  })

  it('被排除的前置不自动视为已满足', () => {
    const input = mkInput({ works: [mkWork('wa'), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] })] })
    const r = run(input, { excludedItems: [{ work_item_key: 'wa', reason: '用户本轮不做' }] })
    expect(r.excluded_items).toEqual([{ work_item_key: 'wa', excluded_by: 'user', reason: '用户本轮不做' }])
    expect(r.unscheduled).toEqual([{ work_item_key: 'wb', remaining_minutes: 30, reason: 'dependency_blocked' }])
    expect(r.complete).toBe(false)
  })
})

describe('B1-05 截止：date 当天可排/datetime 前一天/无截止/逾期补做', () => {
  it('date 截止允许截止当天安排，总截止不变', () => {
    const input = mkInput({ facts: [mkFact('t-1', { deadline_value: D(2), deadline_precision: 'date' })], works: [mkWork('k1', { remaining_minutes: 150 })] })
    const r = run(input)
    expect(segTuples(r)).toEqual({ k1: [[START, 51, 1], [D(1), 51, 1], [D(2), 48, 1]] })
    expect(r.complete).toBe(true)
    expect(input.task_facts[0].deadline_value).toBe(D(2))
  })

  it('datetime 截止最晚排前一天，并发保守说明', () => {
    const input = mkInput({ facts: [mkFact('t-1', { deadline_value: `${D(2)}T09:00:00+08:00`, deadline_precision: 'datetime' })], works: [mkWork('k1', { remaining_minutes: 80 })] })
    const r = run(input)
    expect(segTuples(r)).toEqual({ k1: [[START, 51, 1], [D(1), 29, 1]] })
    expect(warningCodes(r)).toContain('datetime_deadline_conservative')
    expect(r.complete).toBe(true)
  })

  it('无截止只受窗口约束：窗口末不是新截止，缺口 no_capacity', () => {
    const input = mkInput({ works: [mkWork('k1', { remaining_minutes: 400 })] })
    const r = run(input)
    expect(r.days.reduce((a, d) => a + d.allocated_minutes, 0)).toBe(357)
    expect(r.unscheduled).toEqual([{ work_item_key: 'k1', remaining_minutes: 43, reason: 'no_capacity' }])
    expect(input.task_facts[0].deadline_precision).toBe('none')
    expect(r.complete).toBe(false)
  })

  it('逾期未经确认不排；确认后补做、原截止不变、发 overdue_scheduled', () => {
    const past = beijingAddDays(START, -4)
    const noConsent = mkInput({ facts: [mkFact('t-1', { deadline_value: past, deadline_precision: 'date' })] })
    const r1 = run(noConsent)
    expect(r1.unscheduled).toEqual([{ work_item_key: 'w1', remaining_minutes: 60, reason: 'overdue_requires_consent' }])
    const consent = mkInput({ facts: [mkFact('t-1', { deadline_value: past, deadline_precision: 'date', overdue_consent: true })] })
    const r2 = run(consent)
    expect(segTuples(r2)).toEqual({ w1: [[START, 51, 1], [D(1), 9, 1]] })
    expect(warningCodes(r2)).toContain('overdue_scheduled')
    expect(consent.task_facts[0].deadline_value).toBe(past)
    expect(r2.complete).toBe(true)
  })

  it('截止远晚于窗口：钳到窗口末，不报错也不造截止', () => {
    const input = mkInput({ facts: [mkFact('t-1', { deadline_value: beijingAddDays(START, 20), deadline_precision: 'date' })] })
    const r = run(input)
    expect(segTuples(r)).toEqual({ w1: [[START, 51, 1], [D(1), 9, 1]] })
    expect(r.complete).toBe(true)
  })

  it('datetime 截止当天无空闲：缺口是 deadline_window 而非时段核对', () => {
    const input = mkInput({
      facts: [mkFact('t-1', { deadline_value: `${D(2)}T09:00:00+08:00`, deadline_precision: 'datetime' })],
      occupancy: [mkOcc('p-f', { date: D(2), planned_minutes: 51 })],
      works: [mkWork('k1', { remaining_minutes: 120 })],
    })
    const r = run(input)
    expect(r.unscheduled).toEqual([{ work_item_key: 'k1', remaining_minutes: 18, reason: 'deadline_window' }])
  })

  it('datetime 截止当天有容量但前一天放不下非尾段：needs_deadline_day_window', () => {
    const input = mkInput({
      budgets: [60, 60, 0, 0, 0, 0, 0],
      facts: [mkFact('t-1', { deadline_value: `${D(1)}T09:00:00+08:00`, deadline_precision: 'datetime' })],
      occupancy: [mkOcc('p-1', { planned_minutes: 31 })],
      works: [mkWork('k1', { remaining_minutes: 50 })],
    })
    const r = run(input)
    expect(r.unscheduled).toEqual([{ work_item_key: 'k1', remaining_minutes: 50, reason: 'needs_deadline_day_window' }])
    expect(r.complete).toBe(false)
  })
})

describe('B1-06 未知预算/未知估时/明确排除', () => {
  it('null 预算拒绝进入排程，不默认 0', () => {
    const input = mkInput({ budgets: [60, null, 60, 60, 60, 60, 60] })
    expect(() => scheduleDaily(input)).toThrow(/null 不得进入排程/)
  })

  it('未知估时单列 unknown，不当 0；已知项照常排', () => {
    const input = mkInput({ works: [mkWork('wu', { remaining_minutes: null }), mkWork('wk')] })
    const r = run(input)
    expect(r.unknown_items).toEqual([{ work_item_key: 'wu', reason: 'estimate_missing' }])
    expect(segTuples(r)).toEqual({ wk: [[START, 51, 1], [D(1), 9, 1]] })
    expect(r.complete).toBe(false)
  })

  it('明确排除项无段无缺口；其余排完则 complete', () => {
    const input = mkInput({ works: [mkWork('k1')] })
    const r = run(input, { excludedItems: [{ work_item_key: 'k1', reason: '用户决定本轮不做' }] })
    expect(r.segments).toEqual([])
    expect(r.unscheduled).toEqual([])
    expect(r.excluded_items).toEqual([{ work_item_key: 'k1', excluded_by: 'user', reason: '用户决定本轮不做' }])
    expect(r.complete).toBe(true)
  })
})

describe('B1-07 北京时间/跨午夜/闰月/跨年/宿主时区独立', () => {
  it('闰月窗口逐日正确：2028-02-27 起含 02-29', () => {
    const input = mkInput({ start: '2028-02-27', works: [mkWork('k1', { remaining_minutes: 30 })] })
    const r = run(input)
    expect(r.days.map((d) => d.date)).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02', '2028-03-03', '2028-03-04'])
    expect(segTuples(r)).toEqual({ k1: [['2028-02-27', 30, 1]] })
  })

  it('跨年窗口：2026-12-30 → 2027-01-05', () => {
    const input = mkInput({ start: '2026-12-30' })
    const r = run(input)
    expect(r.days.map((d) => d.date)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05'])
    expect(segTuples(r)).toEqual({ w1: [['2026-12-30', 51, 1], ['2026-12-31', 9, 1]] })
  })

  it('明确偏移/Z/naive 都换算到同一北京日界，绝不照抄原文日期', () => {
    const values = ['2026-11-26T01:00:00+08:00', '2026-11-25T20:00:00-05:00', '2026-11-25T16:30:00Z', '2026-11-26T09:00']
    for (const value of values) {
      const input = mkInput({ facts: [mkFact('t-1', { deadline_value: value, deadline_precision: 'datetime' })] })
      const r = run(input)
      expect(segTuples(r), value).toEqual({ w1: [[START, 51, 1], [D(1), 9, 1]] })
      expect(input.task_facts[0].deadline_value, value).toBe(value)
    }
  })

  it('宿主时区 America/New_York 与 Pacific/Kiritimati 下输出逐字节一致', () => {
    const input = mkInput({
      start: '2028-02-27',
      facts: [mkFact('t-1', { deadline_value: '2028-02-29T00:30:00+08:00', deadline_precision: 'datetime' })],
    })
    const local = scheduleDaily(input)
    const moduleUrl = new URL('../domains/planning/schedule.js', import.meta.url).href
    const code = `import { scheduleDaily } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(scheduleDaily(${JSON.stringify(input)})))`
    for (const tz of ['America/New_York', 'Pacific/Kiritimati']) {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
      expect(JSON.parse(out), tz).toEqual(local)
    }
  })
})

describe('B1-08 确定性/输入不可变/稳定排序', () => {
  it('工作项/占用数组乱序不改变语义输出', () => {
    const works = [mkWork('wa', { remaining_minutes: 100 }), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] }), mkWork('wc', { remaining_minutes: 20, priority: 'high' })]
    const occ = [mkOcc('p-1', { planned_minutes: 20 }), mkOcc('p-2', { date: D(1), planned_minutes: 10 })]
    const a = mkInput({ buffer: 0, works, occupancy: occ })
    const b = mkInput({ buffer: 0, works: [works[2], works[1], works[0]], occupancy: [occ[1], occ[0]] })
    expect(scheduleDaily(b)).toEqual(scheduleDaily(a))
  })

  it('深度冻结的输入可正常排程（纯函数不改输入）', () => {
    const input = deepFreeze(mkInput({ works: [mkWork('wa', { remaining_minutes: 100 }), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] })] }))
    const before = JSON.stringify(input)
    const r = scheduleDaily(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(r.complete).toBe(true)
  })

  it('插入顺序不影响稳定 key 排序：zb 先插入仍 za 先排', () => {
    const input = mkInput({ buffer: 0, budgets: [30, 30, 0, 0, 0, 0, 0], works: [mkWork('zb', { remaining_minutes: 20, splittable: false }), mkWork('za', { remaining_minutes: 20, splittable: false })] })
    expect(segTuples(run(input))).toEqual({ za: [[START, 20, 1]], zb: [[D(1), 20, 1]] })
  })

  it('同最迟日：有截止优先于无截止；高优先级优先于 normal', () => {
    const input = mkInput({
      buffer: 0, budgets: [30, 30, 0, 0, 0, 0, 0],
      facts: [mkFact('t-1', { deadline_value: D(1), deadline_precision: 'date' }), mkFact('t-2')],
      works: [mkWork('wo', { task_ref: { kind: 'existing', id: 't-2' }, remaining_minutes: 20, splittable: false }), mkWork('wd', { remaining_minutes: 20, splittable: false })],
    })
    expect(segTuples(run(input))).toEqual({ wd: [[START, 20, 1]], wo: [[D(1), 20, 1]] })
    const input2 = mkInput({ buffer: 0, budgets: [30, 30, 0, 0, 0, 0, 0], works: [mkWork('wn', { remaining_minutes: 20, splittable: false }), mkWork('wh', { remaining_minutes: 20, splittable: false, priority: 'high' })] })
    expect(segTuples(run(input2))).toEqual({ wh: [[START, 20, 1]], wn: [[D(1), 20, 1]] })
  })

  it('逾期已确认项（最迟=窗口末）排在无截止项之前', () => {
    const input = mkInput({
      buffer: 0, budgets: [30, 30, 0, 0, 0, 0, 0],
      facts: [mkFact('t-1', { deadline_value: beijingAddDays(START, -3), deadline_precision: 'date', overdue_consent: true }), mkFact('t-2')],
      works: [mkWork('wo', { task_ref: { kind: 'existing', id: 't-2' }, remaining_minutes: 20, splittable: false }), mkWork('wd', { remaining_minutes: 20, splittable: false })],
    })
    expect(segTuples(run(input))).toEqual({ wd: [[START, 20, 1]], wo: [[D(1), 20, 1]] })
  })
})

describe('冻结解释组合（新增歧义反例，交回留档）', () => {
  it('原因优先级：逾期未经确认 先于 outside_horizon', () => {
    const input = mkInput({
      facts: [mkFact('t-1', { deadline_value: beijingAddDays(START, -2), deadline_precision: 'date' })],
      works: [mkWork('k1', { earliest_date: beijingAddDays(START, 30) })],
    })
    expect(run(input).unscheduled[0].reason).toBe('overdue_requires_consent')
  })

  it('不可拆 + datetime 缺口：not_splittable 先于时段核对', () => {
    const input = mkInput({
      facts: [mkFact('t-1', { deadline_value: `${D(1)}T09:00:00+08:00`, deadline_precision: 'datetime' })],
      works: [mkWork('k1', { remaining_minutes: 80, splittable: false })],
    })
    expect(run(input).unscheduled[0].reason).toBe('not_splittable')
  })

  it('窗口外 earliest 与无截止组合：outside_horizon', () => {
    const input = mkInput({ works: [mkWork('k1', { earliest_date: beijingAddDays(START, 10) })] })
    expect(run(input).unscheduled[0]).toEqual({ work_item_key: 'k1', remaining_minutes: 60, reason: 'outside_horizon' })
  })
})

describe('5B-1A 整改 R2：真实逾期与保守最迟日分离', () => {
  it('当天精确截止不算逾期：走时段核对缺口，不引导逾期补做', () => {
    const input = mkInput({
      buffer: 0,
      facts: [mkFact('t-1', { deadline_value: `${START}T23:59:00+08:00`, deadline_precision: 'datetime' })],
      works: [mkWork('w1', { remaining_minutes: 30 })],
    })
    const r = run(input)
    expect(r.segments).toEqual([])
    expect(r.unscheduled).toEqual([{ work_item_key: 'w1', remaining_minutes: 30, reason: 'needs_deadline_day_window' }])
    expect(r.warnings.some((w) => w.code === 'overdue_scheduled')).toBe(false)
    expect(r.complete).toBe(false)
  })

  it('当天精确截止且当天无空闲：deadline_window（不构成时段核对）', () => {
    const input = mkInput({
      buffer: 0, budgets: [0, 60, 60, 60, 60, 60, 60],
      facts: [mkFact('t-1', { deadline_value: `${START}T23:59:00+08:00`, deadline_precision: 'datetime' })],
      works: [mkWork('w1', { remaining_minutes: 30 })],
    })
    expect(run(input).unscheduled[0].reason).toBe('deadline_window')
  })

  it('当天精确截止设 overdue_consent 也不得排到截止之后', () => {
    const input = mkInput({
      buffer: 0,
      facts: [mkFact('t-1', { deadline_value: `${START}T23:59:00+08:00`, deadline_precision: 'datetime', overdue_consent: true })],
      works: [mkWork('w1', { remaining_minutes: 120 })],
    })
    const r = run(input)
    expect(r.segments).toEqual([])
    expect(r.unscheduled[0].reason).toBe('needs_deadline_day_window')
    expect(r.warnings.some((w) => w.code === 'overdue_scheduled')).toBe(false)
  })

  it('昨天精确截止才是真实逾期：未确认阻断，确认后窗口内补做并警告', () => {
    const base = mkInput({
      buffer: 0,
      facts: [mkFact('t-1', { deadline_value: `${beijingAddDays(START, -1)}T23:59:00+08:00`, deadline_precision: 'datetime' })],
      works: [mkWork('w1', { remaining_minutes: 30 })],
    })
    expect(run(base).unscheduled[0].reason).toBe('overdue_requires_consent')
    base.task_facts[0].overdue_consent = true
    const r = run(base)
    expect(r.segments.length).toBeGreaterThan(0)
    expect(r.warnings.some((w) => w.code === 'overdue_scheduled')).toBe(true)
  })

  it('当天日期截止可排当天（日期精度不保守提前）', () => {
    const input = mkInput({
      buffer: 0,
      facts: [mkFact('t-1', { deadline_value: START, deadline_precision: 'date' })],
      works: [mkWork('w1', { remaining_minutes: 30 })],
    })
    const r = run(input)
    expect(r.segments[0].date).toBe(START)
    expect(r.complete).toBe(true)
  })

  it('未来窗口：today 与 start 之间的截止不算逾期（显式注入 today）', () => {
    const input = mkInput({
      start: D(2), today: START, buffer: 0,
      facts: [mkFact('t-1', { deadline_value: D(1), deadline_precision: 'date' })],
      works: [mkWork('w1', { remaining_minutes: 30 })],
    })
    const r = run(input)
    expect(r.unscheduled[0].reason).toBe('deadline_window')
    expect(r.warnings.some((w) => w.code === 'overdue_scheduled')).toBe(false)
  })

  it('未来窗口缺省 today=start：截止早于窗口按逾期解释（缺省口径）', () => {
    const input = mkInput({
      start: D(2), buffer: 0,
      facts: [mkFact('t-1', { deadline_value: D(1), deadline_precision: 'date' })],
      works: [mkWork('w1', { remaining_minutes: 30 })],
    })
    expect(run(input).unscheduled[0].reason).toBe('overdue_requires_consent')
  })

  it('today 晚于 start_date 拒绝', () => {
    const input = mkInput({ today: D(1) })
    expect(() => scheduleDaily(input)).toThrow(/today 不得晚于/)
  })

  it('独立验证器拒绝把当天精确截止排到截止当天（镜像同一口径）', () => {
    const input = mkInput({
      buffer: 0,
      facts: [mkFact('t-1', { deadline_value: `${START}T23:59:00+08:00`, deadline_precision: 'datetime' })],
      works: [mkWork('w1', { remaining_minutes: 30 })],
    })
    const good = scheduleDaily(input)
    const bad = structuredClone(good)
    bad.unscheduled = []
    bad.complete = true
    bad.segments = [{
      segment_key: 'w1#1', work_item_key: 'w1', task_ref: { kind: 'existing', id: 't-1' },
      suggested_action_ref: input.work_items[0].action_ref, date: START, minutes: 30, order: 1,
      action_text: 'x', deliverable: 'x',
    }]
    bad.days[0].allocated_minutes = 30
    bad.days[0].free_minutes -= 30
    expect(() => validatePlanningResult(input, bad)).toThrow(/最迟可排日/)
  })
})

describe('5B-1A 整改 R3：窗口裁剪不抹掉截止排序', () => {
  const twoOutside = (permute) => {
    const facts = [
      mkFact('soon', { deadline_precision: 'date', deadline_value: '2026-12-01' }),
      mkFact('later', { deadline_precision: 'date', deadline_value: '2026-12-20' }),
    ]
    const works = [
      mkWork('soon', { task_ref: { kind: 'existing', id: 'soon' }, priority: 'low' }),
      mkWork('later', { task_ref: { kind: 'existing', id: 'later' }, priority: 'high' }),
    ]
    return mkInput({
      buffer: 0, budgets: [60, 0, 0, 0, 0, 0, 0],
      facts: permute ? facts.slice().reverse() : facts,
      works: permute ? works.slice().reverse() : works,
    })
  }

  it('两个截止均在窗口外：较早截止先排，优先级不得反超', () => {
    const r = run(twoOutside(false))
    expect(r.segments.map((s) => s.work_item_key)).toEqual(['soon'])
    expect(r.unscheduled).toEqual([{ work_item_key: 'later', remaining_minutes: 60, reason: 'deadline_window' }])
  })

  it('输入乱序不改变截止排序结果', () => {
    expect(segTuples(run(twoOutside(true)))).toEqual(segTuples(run(twoOutside(false))))
  })

  it('一个截止在窗口内、一个在窗口外：窗口内较早截止先排', () => {
    const input = mkInput({
      buffer: 0, budgets: [60, 0, 0, 0, 0, 0, 0],
      facts: [
        mkFact('inside', { deadline_precision: 'date', deadline_value: D(1) }),
        mkFact('outside', { deadline_precision: 'date', deadline_value: '2026-12-20' }),
      ],
      works: [
        mkWork('inside', { task_ref: { kind: 'existing', id: 'inside' }, priority: 'low' }),
        mkWork('outside', { task_ref: { kind: 'existing', id: 'outside' }, priority: 'high' }),
      ],
    })
    expect(run(input).segments.map((s) => s.work_item_key)).toEqual(['inside'])
  })

  it('日期/精确时间混合：按保守截止日排序（datetime 提前一天）', () => {
    const input = mkInput({
      buffer: 0, budgets: [60, 0, 0, 0, 0, 0, 0],
      facts: [
        mkFact('dt', { deadline_precision: 'datetime', deadline_value: '2026-12-01T09:00:00+08:00' }),
        mkFact('da', { deadline_precision: 'date', deadline_value: '2026-12-01' }),
      ],
      works: [
        mkWork('dt', { task_ref: { kind: 'existing', id: 'dt' }, priority: 'low' }),
        mkWork('da', { task_ref: { kind: 'existing', id: 'da' }, priority: 'high' }),
      ],
    })
    expect(run(input).segments.map((s) => s.work_item_key)).toEqual(['dt'])
  })

  it('窗口外截止（裁剪到窗口末）仍排在无截止之前', () => {
    const input = mkInput({
      buffer: 0, budgets: [60, 0, 0, 0, 0, 0, 0],
      facts: [
        mkFact('dl', { deadline_precision: 'date', deadline_value: '2026-12-20' }),
        mkFact('nodl', {}),
      ],
      works: [
        mkWork('dl', { task_ref: { kind: 'existing', id: 'dl' }, priority: 'low' }),
        mkWork('nodl', { task_ref: { kind: 'existing', id: 'nodl' }, priority: 'high' }),
      ],
    })
    expect(run(input).segments.map((s) => s.work_item_key)).toEqual(['dl'])
  })

  it('截止等位时优先级才生效', () => {
    const input = mkInput({
      buffer: 0, budgets: [60, 0, 0, 0, 0, 0, 0],
      facts: [
        mkFact('a', { deadline_precision: 'date', deadline_value: '2026-12-01' }),
        mkFact('b', { deadline_precision: 'date', deadline_value: '2026-12-01' }),
      ],
      works: [
        mkWork('a', { task_ref: { kind: 'existing', id: 'a' }, priority: 'low' }),
        mkWork('b', { task_ref: { kind: 'existing', id: 'b' }, priority: 'high' }),
      ],
    })
    expect(run(input).segments.map((s) => s.work_item_key)).toEqual(['b'])
  })
})
