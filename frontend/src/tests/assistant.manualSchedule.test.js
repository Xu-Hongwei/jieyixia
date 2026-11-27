import { describe, expect, it } from 'vitest'
import { scheduleWithManualSlots } from '../domains/assistant/manualSchedule'
import { adoptedActionEstimates, unallocatedActions } from '../domains/assistant/scheduledActions'
import { scheduleDaily } from '../domains/planning/schedule'
import { mkInput, mkWork, mkFact, START } from './planning.helpers'

const choice = (key, time, date = START) => ({ draft_revision: 1, object_type: 'gap', field_path: 'manual_slot',
  object_id_or_key: key, new_value: { date, time, allowExtra: true } })
function makeDraft() {
  const input = mkInput({ budgets: [100, 0, 0, 0, 0, 0, 0],
    facts: [mkFact('t-1', { deadline_precision: 'datetime', deadline_value: START + 'T12:00:00+08:00' })],
    works: [mkWork('prepare', { remaining_minutes: 20 }), mkWork('submit', { remaining_minutes: 10, depends_on: ['prepare'] })] })
  return { revision: 1, planning_input: input, planning_result: scheduleDaily(input), user_confirmations: [] }
}

describe('手动补排', () => {
  it('检查前置工作、重叠、截止时刻；接受恰好按时完成', () => {
    const draft = makeDraft()
    const project = (...choices) => scheduleWithManualSlots({ ...draft, user_confirmations: choices })
    const first = choice('prepare', '11:30')
    expect(() => project(choice('submit', '11:00'))).toThrow(/前置/)
    expect(() => project(first, choice('submit', '11:20'))).toThrow(/前置/)
    expect(() => project(first, choice('submit', '11:45'))).toThrow(/时段/)
    expect(() => project(first, choice('submit', '11:51'))).toThrow(/截止/)
    expect(project(first, choice('submit', '11:50')).complete).toBe(true)
    expect(draft.planning_result.unscheduled).toHaveLength(2)
  })
  it('修改、撤回安排和版本变更均不会残留重复段', () => {
    const draft = makeDraft()
    draft.user_confirmations.push(choice('prepare', '09:00'), choice('prepare', '10:00'))
    expect(scheduleWithManualSlots(draft).segments.map(s => s.action_text)).toEqual(['10:00 · prepare 的虚构产出'])
    expect(scheduleWithManualSlots({ ...draft, revision: 2 })).toBe(draft.planning_result)
    draft.user_confirmations.push({ ...choice('prepare', ''), field_path: '', new_value: true })
    expect(scheduleWithManualSlots(draft)).toBe(draft.planning_result)
  })
  it('仅指定日期不能绕过当天精确截止', () => {
    const draft = makeDraft()
    draft.user_confirmations.push(choice('prepare', ''))
    expect(() => scheduleWithManualSlots(draft)).toThrow(/具体截止时刻/)
  })
  it('窗口外按日确认保留前置顺序，不虚构工时预算或开始时刻', () => {
    const date = '2026-12-13'
    const works = [mkWork('arrival', { earliest_date: date }), mkWork('award', { earliest_date: date, depends_on: ['arrival'] })]
    const input = mkInput({ works })
    const draft = { revision: 1, planning_input: input, planning_result: scheduleDaily(input), user_confirmations: [] }
    const project = (...choices) => scheduleWithManualSlots({ ...draft, user_confirmations: choices })
    expect(() => project(choice('arrival', '', '2026-12-12'))).toThrow(/最早可安排/)
    expect(() => project(choice('award', '', date))).toThrow(/前置/)
    const r = project(choice('arrival', '', date), choice('award', '', date))
    expect(r.complete).toBe(true)
    expect(r.segments.map(s => [s.date, s.order, s.action_text])).toEqual([
      [date, 1, works[0].deliverable], [date, 2, works[1].deliverable],
    ])
    expect(r.days).toEqual(draft.planning_result.days)
  })
  it('已采用行动按实际拆解工作量筛选，同名行动独立', () => {
    const work = mkWork('step', { remaining_minutes: 40 })
    const draft = { status: 'applied', proposal: { action_proposals: [{ op: 'create', key: 'a-step' }] },
      applied_summary: { id_map: [{ object_type: 'action', draft_key: 'a-step', formal_id: 'a' }] },
      planning_input: { work_items: [work] } }
    const estimates = adoptedActionEstimates([draft])
    const actions = [{ id: 'a', text: '材料', minutes: 60 }, { id: 'b', text: '材料', minutes: 20 }]
    const plans = [{ id: 'p', state: 'planned', planned_minutes: 40 }]
    expect(unallocatedActions(actions, plans, new Map([['p', 'a']]), new Set(), estimates).map(a => a.id)).toEqual(['b'])
  })
})
