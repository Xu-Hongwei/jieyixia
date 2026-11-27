// B1-10：独立输出校验。对真实 scheduleDaily 输出做篡改注入，validatePlanningResult 必须拒绝。
// 校验器不信任算法返回值：从输入独立重算容量/守恒/依赖/截止/原因前提。
import { describe, it, expect } from 'vitest'
import { scheduleDaily, validatePlanningInput } from '../domains/planning/schedule.js'
import { validatePlanningResult } from '../domains/planning/validate.js'
import { beijingAddDays } from '../domains/time.js'
import { START, mkFact, mkWork, mkInput, mkOcc } from './planning.helpers.js'

const D = (n) => beijingAddDays(START, n)
const base = mkInput()
const baseResult = scheduleDaily(base)
const clone = (r) => structuredClone(r)
const seg = (over = {}) => ({
  segment_key: 'w1#9', work_item_key: 'w1',
  task_ref: { kind: 'existing', id: 't-1' }, suggested_action_ref: { kind: 'draft', key: 'a-w1' },
  date: START, minutes: 10, order: 9, action_text: '虚构', deliverable: '虚构', ...over,
})

// 过载场景：committed 70 > allocatable 51，w1 全缺口。
const overInput = mkInput({ budgets: [60, 0, 0, 0, 0, 0, 0], occupancy: [mkOcc('p-x', { planned_minutes: 70 })] })
const overResult = scheduleDaily(overInput)
// 同日依赖场景：wa 40 先、wb 30 后（order 1/2）。
const depInput = mkInput({ buffer: 0, budgets: [100, 100, 100, 100, 100, 100, 100], works: [mkWork('wa', { remaining_minutes: 40, splittable: false }), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] })] })
const depResult = scheduleDaily(depInput)

describe('B1-10 篡改段分钟/日期/顺序', () => {
  it('段分钟私增：allocated 与段和不一致', () => {
    const r = clone(baseResult)
    r.segments[0].minutes += 10
    expect(() => validatePlanningResult(base, r)).toThrow(/allocated 与段分钟和不一致/)
  })

  it('段分钟与日汇总同步私改：分钟不守恒', () => {
    const r = clone(baseResult)
    r.segments[0].minutes = 41
    r.days[0].allocated_minutes = 41
    r.days[0].free_minutes = 10
    expect(() => validatePlanningResult(base, r)).toThrow(/分钟不守恒/)
  })

  it('段日期移出 7 天窗口', () => {
    const r = clone(baseResult)
    r.segments[0].date = '2026-12-01'
    expect(() => validatePlanningResult(base, r)).toThrow(/超出 7 天窗口/)
  })

  it('同日 order 重复', () => {
    const r = clone(depResult)
    r.segments.find((s) => s.work_item_key === 'wb').order = 1
    expect(() => validatePlanningResult(depInput, r)).toThrow(/order 重复/)
  })

  it('依赖顺序颠倒：后继必须整体晚于前置', () => {
    const r = clone(depResult)
    r.segments.find((s) => s.work_item_key === 'wa').order = 2
    r.segments.find((s) => s.work_item_key === 'wb').order = 1
    expect(() => validatePlanningResult(depInput, r)).toThrow(/必须整体晚于前置/)
  })

  it('segment_key 重复', () => {
    const r = clone(baseResult)
    r.segments[1].segment_key = r.segments[0].segment_key
    expect(() => validatePlanningResult(base, r)).toThrow(/segment_key 重复/)
  })

  it('段引用未知工作项', () => {
    const r = clone(baseResult)
    r.segments[0].work_item_key = 'ghost'
    expect(() => validatePlanningResult(base, r)).toThrow(/引用未知工作项/)
  })

  it('段 task_ref 与工作项不一致', () => {
    const r = clone(baseResult)
    r.segments[0].task_ref = { kind: 'existing', id: 't-2' }
    expect(() => validatePlanningResult(base, r)).toThrow(/task_ref 与工作项不一致/)
  })

  it('非最终段小于最小段（总分钟仍守恒）', () => {
    const input = mkInput({ buffer: 0, works: [mkWork('k1', { remaining_minutes: 70 })] })
    const r = scheduleDaily(input)
    r.segments[0].minutes = 20
    r.segments[1].minutes = 50
    r.days[0].allocated_minutes = 20
    r.days[0].free_minutes = 40
    r.days[1].allocated_minutes = 50
    r.days[1].free_minutes = 10
    expect(() => validatePlanningResult(input, r)).toThrow(/非最终段/)
  })

  it('不可拆项被拆成多段（总分钟仍守恒）', () => {
    const input = mkInput({ buffer: 0, works: [mkWork('k1', { remaining_minutes: 60, splittable: false })] })
    const r = scheduleDaily(input)
    r.segments[0].minutes = 30
    r.segments.push(seg({ segment_key: 'k1#2', work_item_key: 'k1', suggested_action_ref: { kind: 'draft', key: 'a-k1' }, date: D(1), minutes: 30, order: 1 }))
    r.days[0].allocated_minutes = 30
    r.days[0].free_minutes = 30
    r.days[1].allocated_minutes = 30
    r.days[1].free_minutes = 30
    expect(() => validatePlanningResult(input, r)).toThrow(/不可拆项.*多段/)
  })
})

describe('B1-10 篡改日汇总/过载/警告/complete', () => {
  it('committed 私改：占用守恒', () => {
    const r = clone(baseResult)
    r.days[0].committed_minutes = 5
    expect(() => validatePlanningResult(base, r)).toThrow(/占用守恒/)
  })

  it('buffer 与输入不一致', () => {
    const r = clone(baseResult)
    r.days[0].buffer_minutes = 8
    expect(() => validatePlanningResult(base, r)).toThrow(/budget\/buffer 与输入不一致/)
  })

  it('已过载日仍新增安排', () => {
    const r = clone(overResult)
    r.segments.push(seg())
    r.days[0].allocated_minutes = 10
    expect(() => validatePlanningResult(overInput, r)).toThrow(/已过载仍新增安排/)
  })

  it('过载日缺 existing_overbook 警告', () => {
    const r = clone(overResult)
    r.warnings = r.warnings.filter((w) => w.code !== 'existing_overbook')
    expect(() => validatePlanningResult(overInput, r)).toThrow(/缺 existing_overbook/)
  })

  it('datetime 截止缺保守说明', () => {
    const input = mkInput({ facts: [mkFact('t-1', { deadline_value: `${D(2)}T09:00:00+08:00`, deadline_precision: 'datetime' })] })
    const r = scheduleDaily(input)
    r.warnings = r.warnings.filter((w) => w.code !== 'datetime_deadline_conservative')
    expect(() => validatePlanningResult(input, r)).toThrow(/缺 datetime_deadline_conservative/)
  })

  it('complete 与事实不符', () => {
    const r = clone(baseResult)
    r.complete = false
    expect(() => validatePlanningResult(base, r)).toThrow(/complete=.*与事实不符/)
  })

  it('结果含未批准字段', () => {
    const r = clone(baseResult)
    r.extra = 'x'
    expect(() => validatePlanningResult(base, r)).toThrow(/未批准字段/)
  })
})

describe('B1-10 篡改缺口原因/截止/排除/未知前提', () => {
  it('可拆项标 not_splittable', () => {
    const r = clone(overResult)
    r.unscheduled[0].reason = 'not_splittable'
    expect(() => validatePlanningResult(overInput, r)).toThrow(/reason=not_splittable 但工作项可拆/)
  })

  it('最早日在窗口内却标 outside_horizon', () => {
    const r = clone(overResult)
    r.unscheduled[0].reason = 'outside_horizon'
    expect(() => validatePlanningResult(overInput, r)).toThrow(/reason=outside_horizon/)
  })

  it('前置全部排完却标 dependency_blocked', () => {
    const input = mkInput({ buffer: 0, works: [mkWork('wa', { remaining_minutes: 30 }), mkWork('wb', { remaining_minutes: 30, depends_on: ['wa'] })] })
    const r = scheduleDaily(input)
    r.segments = r.segments.filter((s) => s.work_item_key !== 'wb')
    r.unscheduled.push({ work_item_key: 'wb', remaining_minutes: 30, reason: 'dependency_blocked' })
    r.days[0].allocated_minutes = 30
    r.days[0].free_minutes = 30
    r.complete = false
    expect(() => validatePlanningResult(input, r)).toThrow(/dependency_blocked 但前置全部排完/)
  })

  it('截止当天无空闲却标 needs_deadline_day_window', () => {
    const input = mkInput({
      facts: [mkFact('t-1', { deadline_value: `${D(2)}T09:00:00+08:00`, deadline_precision: 'datetime' })],
      occupancy: [mkOcc('p-f', { date: D(2), planned_minutes: 51 })],
      works: [mkWork('k1', { remaining_minutes: 120 })],
    })
    const r = scheduleDaily(input)
    r.unscheduled[0].reason = 'needs_deadline_day_window'
    expect(() => validatePlanningResult(input, r)).toThrow(/截止当天无空闲/)
  })

  it('逾期未经确认：缺口原因不得伪装成其他原因', () => {
    const input = mkInput({ facts: [mkFact('t-1', { deadline_value: beijingAddDays(START, -3), deadline_precision: 'date' })] })
    const r = scheduleDaily(input)
    r.unscheduled[0].reason = 'no_capacity'
    expect(() => validatePlanningResult(input, r)).toThrow(/未经补做确认不得安排/)
  })

  it('逾期未经确认被私排：拒绝（日期边界/逾期前提）', () => {
    const input = mkInput({ facts: [mkFact('t-1', { deadline_value: beijingAddDays(START, -3), deadline_precision: 'date' })] })
    const r = scheduleDaily(input)
    r.unscheduled = []
    r.segments.push(seg({ segment_key: 'w1#1', minutes: 60, order: 1 }))
    r.days[0].allocated_minutes = 60
    r.days[0].free_minutes = 0
    r.complete = true
    expect(() => validatePlanningResult(input, r)).toThrow(/最迟可排日|未经补做确认/)
  })

  it('逾期补做已排但缺 overdue_scheduled 警告', () => {
    const input = mkInput({ facts: [mkFact('t-1', { deadline_value: beijingAddDays(START, -3), deadline_precision: 'date', overdue_consent: true })] })
    const r = scheduleDaily(input)
    r.warnings = r.warnings.filter((w) => w.code !== 'overdue_scheduled')
    expect(() => validatePlanningResult(input, r)).toThrow(/缺 overdue_scheduled/)
  })

  it('排在 earliest_date 之前', () => {
    const input = mkInput({ works: [mkWork('k1', { remaining_minutes: 30, earliest_date: D(2) })] })
    const r = scheduleDaily(input)
    r.segments[0].date = START
    r.days[2].allocated_minutes = 0
    r.days[2].free_minutes = 51
    r.days[0].allocated_minutes = 30
    r.days[0].free_minutes = 21
    expect(() => validatePlanningResult(input, r)).toThrow(/earliest_date 之前/)
  })

  it('排在最迟可排日之后（date 截止当天之后）', () => {
    const input = mkInput({ facts: [mkFact('t-1', { deadline_value: D(1), deadline_precision: 'date' })] })
    const r = scheduleDaily(input)
    r.segments[1].date = D(2)
    r.days[1].allocated_minutes = 0
    r.days[1].free_minutes = 51
    r.days[2].allocated_minutes = 9
    r.days[2].free_minutes = 42
    expect(() => validatePlanningResult(input, r)).toThrow(/最迟可排日/)
  })

  it('已排除项仍有段', () => {
    const input = mkInput()
    const r = scheduleDaily(input, { excludedItems: [{ work_item_key: 'w1', reason: '用户不做' }] })
    r.segments.push(seg({ segment_key: 'w1#1', minutes: 60, order: 1 }))
    r.days[0].allocated_minutes = 60
    r.days[0].free_minutes = 0
    expect(() => validatePlanningResult(input, r)).toThrow(/已排除项/)
  })

  it('未知估时项被私排（不能当 0 也不能当已知）', () => {
    const input = mkInput({ works: [mkWork('wu', { remaining_minutes: null })] })
    const r = scheduleDaily(input)
    r.segments.push(seg({ segment_key: 'wu#1', work_item_key: 'wu', suggested_action_ref: { kind: 'draft', key: 'a-wu' } }))
    r.days[0].allocated_minutes = 10
    r.days[0].free_minutes = 41
    expect(() => validatePlanningResult(input, r)).toThrow(/不得排段或填缺口/)
  })
})

describe('B1-10 输入侧负向（validatePlanningInput）', () => {
  const bad = (mutate, re) => {
    const input = mkInput()
    mutate(input)
    expect(() => validatePlanningInput(input)).toThrow(re)
  }
  it('占用重复 ID', () => bad((i) => { i.occupancy = [mkOcc('p-1'), mkOcc('p-1')] }, /不双计/))
  it('null 预算', () => bad((i) => { i.days[1].budget_minutes = null }, /null 不得进入排程/))
  // M3 起 replacement_ids 允许非空（本地用户选择的替换集）；负向覆盖迁移到重复/与占用重叠/超限。
  it('replacement_ids 重复', () => bad((i) => { i.replacement_ids = ['p-x', 'p-x'] }, /重复/))
  it('replacement_ids 与占用重叠', () => bad((i) => { i.occupancy = [mkOcc('p-1')]; i.replacement_ids = ['p-1'] }, /不得含 replacement_ids/))
  it('replacement_ids 超 100', () => bad((i) => { i.replacement_ids = Array.from({ length: 101 }, (_, n) => `p-${n}`) }, /最多 100/))
  it('未知依赖', () => bad((i) => { i.work_items[0].depends_on = ['ghost'] }, /未知工作项/))
  it('依赖环', () => bad((i) => {
    i.work_items = [mkWork('wa', { depends_on: ['wb'] }), mkWork('wb', { depends_on: ['wa'] })]
  }, /依赖环/))
  it('remaining 0', () => bad((i) => { i.work_items[0].remaining_minutes = 0 }, /不能用 0/))
  it('remaining 负数', () => bad((i) => { i.work_items[0].remaining_minutes = -5 }, /正安全整数/))
  it('非法 earliest 日历日', () => bad((i) => { i.work_items[0].earliest_date = '2026-02-30' }, /earliest_date/))
  it('预算超 1440', () => bad((i) => { i.days[0].budget_minutes = 1441 }, /1440/))
  it('缓冲超 50', () => bad((i) => { i.buffer_pct = 51 }, /50/))
  it('horizon 非 7', () => bad((i) => { i.horizon_days = 6 }, /7/))
  it('时区非 Asia/Shanghai', () => bad((i) => { i.timezone = 'UTC' }, /Asia\/Shanghai/))
  it('planned 占用断引用', () => bad((i) => { i.occupancy = [mkOcc('p-1', { task_ref_state: 'deleted' })] }, /不可信/))
  it('ack 引用未知 key', () => bad((i) => { i.extra_work_acknowledged = ['ghost'] }, /extra_work_acknowledged 引用未知工作项/))
  it('work key 重复', () => bad((i) => { i.work_items = [mkWork('w1'), mkWork('w1')] }, /key 重复/))
  it('task_facts 重复', () => bad((i) => { i.task_facts = [mkFact('t-1'), mkFact('t-1')] }, /task_facts 引用重复/))
  it('工作项缺少对应事实', () => bad((i) => { i.task_facts = [] }, /缺少对应 task_facts/))
  it('未批准字段', () => bad((i) => { i.sneaky = 1 }, /未批准字段/))
  it('D12 未确认', () => bad((i) => { i.occupancy = [mkOcc('p-1', { task_id: 't-1' })] }, /额外尚未安排工作/))
  it('日期不连续', () => bad((i) => { i.days[3].date = '2026-11-28' }, /连续自然日/))
})