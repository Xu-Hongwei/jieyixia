// 5A-2B §3.1 入口优先级纯函数：同安排未结束 > 本空间其它未结束 > 跨空间运行 > 资格 > 旧历史 > 可开始。
// 页面预检查只用于解释入口；最终资格由 focus.begin 事务决定（focus.plan.service.test.js 覆盖）。
import { describe, expect, it } from 'vitest'
import { planStartEntry } from '@/composables/usePlanWorkStart'

const T0 = '2026-11-20T10:00:00+08:00'
const task = (over = {}) => ({
  id: 't1', kind: 'task', workspace_id: 'w1', title: '周五交报告', status: 'todo',
  current_action_id: 'a1', matter_id: null, note_ids: [],
  deadline: { value: '2026-11-27', precision: 'date' },
  created_at: T0, updated_at: T0, is_demo: false, ...over,
})
const action = (over = {}) => ({
  id: 'a1', kind: 'action', workspace_id: 'w1', task_id: 't1', text: '整理资料',
  minutes: 25, basis: 'user', done: false, created_at: T0, ...over,
})
const item = (over = {}) => ({
  id: 'p1', kind: 'plan_item', workspace_id: 'w1', task_id: 't1', date: '2026-11-20',
  state: 'planned', action_text: '周一整理资料', planned_minutes: 30,
  actual_minutes: null, focus_session_id: null, order: 1, task_ref_state: 'active',
  created_at: T0, updated_at: T0, ...over,
})
const session = (over = {}) => ({
  id: 's1', kind: 'focus_session', workspace_id: 'w1', record_version: 1,
  task_id: 't1', action_id: 'a1', plan_item_id: 'p1',
  started_at: T0, accumulated_ms: 60000, running: true, draft_md: '',
  outcome: null, blocker: null, ended_at: null, is_demo: false, ...over,
})
const ended = (over = {}) => session({ ended_at: '2026-11-20T11:00:00+08:00', running: false, outcome: 'partial', ...over })
const entry = (docs, over = {}) => planStartEntry({
  plan: docs.find((d) => d.id === 'p1') || null,
  task: docs.find((d) => d.id === 't1') || null,
  docs, ...over,
})

describe('planStartEntry：同安排未结束会话最优先', () => {
  it('同安排未结束（运行中）→ existing，携带真实会话', () => {
    const s = session()
    const e = entry([task(), action(), item(), s], { localUnfinished: s })
    expect(e.kind).toBe('existing')
    expect(e.session.id).toBe('s1')
  })
  it('同安排暂停会话同样 → existing（回到工作不等于自动继续）', () => {
    const s = session({ running: false })
    expect(entry([task(), action(), item(), s], { localUnfinished: s }).kind).toBe('existing')
  })
  it('同 Task/Action 但 plan_item_id 是另一安排 → 不算同一安排工作', () => {
    const s = session({ plan_item_id: 'p2' })
    const e = entry([task(), action(), item(), item({ id: 'p2' }), s], { localUnfinished: s })
    expect(e.kind).toBe('local-conflict')
    expect(e.session.id).toBe('s1')
  })
  it('同 Task/Action 但独立会话（plan_item_id=null）→ local-conflict，不误认回到工作', () => {
    const s = session({ plan_item_id: null })
    expect(entry([task(), action(), item(), s], { localUnfinished: s }).kind).toBe('local-conflict')
  })
  it('existing 优先于跨空间运行说明', () => {
    const s = session()
    const e = entry([task(), action(), item(), s], {
      localUnfinished: s, crossWsRunning: { workspace_id: 'w2', session_id: 'x' },
    })
    expect(e.kind).toBe('existing')
  })
})

describe('planStartEntry：冲突与资格顺序', () => {
  it('本空间另有未结束 → local-conflict，优先于跨空间与资格解释', () => {
    const s = session({ id: 's9', task_id: 't2', plan_item_id: null })
    const e = entry([task({ status: 'done' }), action(), item(), s], {
      localUnfinished: s, crossWsRunning: { workspace_id: 'w2', session_id: 'x' },
    })
    expect(e.kind).toBe('local-conflict')
  })
  it('仅跨空间运行 → cross-ws（不自动切换/接管）', () => {
    const e = entry([task(), action(), item()], { crossWsRunning: { workspace_id: 'w2', session_id: 'x' } })
    expect(e.kind).toBe('cross-ws')
  })
  it('任务已完成 → ineligible task-done', () => {
    expect(entry([task({ status: 'done' }), action(), item()])).toMatchObject({ kind: 'ineligible', reason: 'task-done' })
  })
  it('终态安排（done/cancelled/moved）→ ineligible terminal', () => {
    for (const state of ['done', 'cancelled', 'moved']) {
      expect(entry([task(), action(), item({ state })])).toMatchObject({ kind: 'ineligible', reason: 'terminal' })
    }
  })
  it('断引用/安排缺失 → ineligible dead-ref', () => {
    expect(entry([task(), action(), item({ task_ref_state: 'deleted' })])).toMatchObject({ kind: 'ineligible', reason: 'dead-ref' })
    expect(entry([task(), action()])).toMatchObject({ kind: 'ineligible', reason: 'dead-ref' })
  })
})

describe('planStartEntry：旧历史与可开始', () => {
  it('planned + 合法已结束历史 → review，携带历史签名（只含已结束）', () => {
    const e = entry([task(), action(), item(), ended()])
    expect(e.kind).toBe('review')
    expect(e.history.endedSessionIds).toEqual(['s1'])
    expect(e.history.totalMs).toBe(60000)
    expect(e.history.actualMinutes).toBe(1)
  })
  it('异常历史（非法时长）→ history-unresolved，列出问题不新开', () => {
    const e = entry([task(), action(), item(), ended({ accumulated_ms: -5 })])
    expect(e.kind).toBe('history-unresolved')
    expect(e.problems.map((p) => p.code)).toEqual(['INVALID_DURATION'])
  })
  it('异常历史优先于 review：planned 也不能绕过核对', () => {
    const e = entry([task(), action(), item(), ended({ ended_at: '不是时间' })])
    expect(e.kind).toBe('history-unresolved')
  })
  it('partial + 合法历史 → start（无需再次人工核对进度）', () => {
    expect(entry([task(), action(), item({ state: 'partial' }), ended()]).kind).toBe('start')
  })
  it('planned 无历史 → start；未结束会话不算历史', () => {
    expect(entry([task(), action(), item()]).kind).toBe('start')
  })
})