// 5A-0 删除/撤销保护（§12 A15）+ 周聚合兼容回归（A18）的域层证据。
// 独立 oracle：手工 latest docs + sessions，断言删除/撤销的 puts/deletes/info 与引用闭合。
import { describe, expect, it } from 'vitest'
import { deleteTaskPlan, cascadeDeleteNotePlan, undoDeletePlan } from '@/domains/matter'
import { weekGrid, weekSchedule, weekStartOf } from '@/domains/week'

const WS = 'ws-1'
const NOW = '2026-11-22T12:00:00+08:00'
const nowD = new Date(NOW)
const codeOf = (fn) => { try { fn(); return null } catch (e) { return e.code } }

const task = (over = {}) => ({ id: 't1', kind: 'task', workspace_id: WS, title: '报告', status: 'todo', matter_id: null, note_ids: ['n1'], current_action_id: null, deadline: { value: '2026-11-27', precision: 'date' }, created_at: NOW, updated_at: NOW, ...over })
const action = (over = {}) => ({ id: 'a1', kind: 'action', workspace_id: WS, task_id: 't1', text: '写', minutes: 30, done: false, ...over })
const note = (over = {}) => ({ id: 'n1', kind: 'note', workspace_id: WS, title: '通知', status: 'reviewed', fields: [], matter_id: null, matter_role: null, source_id: null, ...over })
const plan = (over = {}) => ({ id: 'p1', kind: 'plan_item', workspace_id: WS, task_id: 't1', date: '2026-11-23', planned_minutes: 60, action_text: '写', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over })
const sess = (over = {}) => ({ id: 's1', kind: 'focus_session', workspace_id: WS, task_id: 't1', action_id: 'a1', plan_item_id: 'p1', started_at: NOW, accumulated_ms: 600000, running: false, draft_md: '成果', outcome: 'partial', blocker: null, ended_at: '2026-11-23T10:30:00+08:00', record_version: 1, timer_anchor_at: null, task_ref_state: 'active', action_ref_state: 'active', ...over })

describe('A15 删任务：planned 无会话随删；有结束会话拒删；历史断引用保留', () => {
  it('planned 无任何 Focus 引用 → 随任务移除，撤销快照保留', () => {
    const latest = [task(), action(), plan()]
    const r = deleteTaskPlan(latest, 't1', [])
    expect(r.deletes).toContain('t1')
    expect(r.deletes).toContain('p1')
    expect(r.info.planRemoved.map((p) => p.id)).toEqual(['p1'])
    expect(r.info.planDetached).toEqual([])
  })
  it('planned 但已有结束会话 → PLAN_PROGRESS_REQUIRED 拒整个删除，返回需确认安排 ID', () => {
    const latest = [task(), action(), plan(), sess()]
    expect(codeOf(() => deleteTaskPlan(latest, 't1', [sess()]))).toBe('PLAN_PROGRESS_REQUIRED')
    try { deleteTaskPlan(latest, 't1', [sess()]) } catch (e) { expect(e.planItemIds).toEqual(['p1']) }
    // 拒绝即整体回滚：不产生悬空引用（函数抛错，调用方事务 abort）。
  })
  it('有未结束会话（含暂停）→ 既有保护拒绝，不把暂停当已结束', () => {
    const paused = sess({ ended_at: null, running: false, outcome: null })
    const latest = [task(), action(), plan(), paused]
    // 上游按 task/action 的未结束保护先拦（RELATION_INVALID），planRefDelete 兜底 UNFINISHED_FOCUS。
    const code = codeOf(() => deleteTaskPlan(latest, 't1', [paused]))
    expect(['RELATION_INVALID', 'UNFINISHED_FOCUS']).toContain(code)
  })
  it('partial/done/cancelled/moved 历史 → 保留 PlanItem 并断 Task 引用，会话成果闭合', () => {
    for (const state of ['partial', 'done', 'cancelled', 'moved']) {
      const p = plan({ state, actual_minutes: state === 'cancelled' || state === 'moved' ? null : 10, focus_session_id: state === 'cancelled' || state === 'moved' ? null : 's1' })
      const s = sess({ ended_at: '2026-11-23T10:30:00+08:00' })
      const latest = [task(), action(), p, s]
      const r = deleteTaskPlan(latest, 't1', [s])
      expect(r.deletes).not.toContain('p1') // 历史计划不删
      const detached = r.puts.find((d) => d.id === 'p1')
      expect(detached.task_ref_state).toBe('deleted')
      expect(detached.state).toBe(state) // 状态/成果保留
      expect(r.info.planDetached).toEqual([{ id: 'p1', from: 'active' }])
      // 会话引用也断开（成果正文保留）。
      const sd = r.puts.find((d) => d.id === 's1')
      expect(sd.task_ref_state).toBe('deleted')
      expect(sd.draft_md).toBe('成果')
    }
  })
  it('确认后新增「planned+结束会话」安排 → 事务内重查仍拒删（要求重新核对进度）', () => {
    const base = [task(), action(), plan({ id: 'p1' })]
    const scope = { taskIds: ['t1'], actionIds: ['a1'] }
    // 确认时只有 p1（planned 无会话）；执行前其它页面新增了 p2（planned 但有结束会话）。
    const latest = [...base, plan({ id: 'p2', order: 1 }), sess({ id: 's2', plan_item_id: 'p2' })]
    expect(codeOf(() => deleteTaskPlan(latest, 't1', [sess({ id: 's2', plan_item_id: 'p2' })], scope))).toBe('PLAN_PROGRESS_REQUIRED')
  })
  it('删除范围变化（新增关联任务/行动）→ SCOPE_CHANGED 拒旧确认', () => {
    const latest = [task(), action(), action({ id: 'a2' }), plan()]
    const oldScope = { taskIds: ['t1'], actionIds: ['a1'] } // 确认时只见 a1
    expect(codeOf(() => deleteTaskPlan(latest, 't1', [], oldScope))).toBe('SCOPE_CHANGED')
  })
})

describe('A15 便签联删 + 撤销：冲突感知，不覆盖新安排/成果', () => {
  it('便签联删带走关联任务的 planned 无会话安排', () => {
    const latest = [note(), task(), action(), plan()]
    const r = cascadeDeleteNotePlan(latest, 'n1', [])
    expect(r.deletes).toContain('n1')
    expect(r.deletes).toContain('t1')
    expect(r.deletes).toContain('p1')
    expect(r.info.planRemoved.map((p) => p.id)).toEqual(['p1'])
  })
  it('撤销恢复 planned 安排（task_ref_state 回 active），任务同批恢复', () => {
    const latest = [note(), task(), action(), plan()]
    const del = cascadeDeleteNotePlan(latest, 'n1', [])
    const last = { kind: 'note', note: del.info.note, tasks: del.info.tasks, actions: del.info.actions, planRemoved: del.info.planRemoved, planDetached: del.info.planDetached, sessionPatches: del.info.sessionPatches }
    const undo = undoDeletePlan([], last, NOW)
    const restoredPlan = undo.puts.find((d) => d.id === 'p1')
    expect(restoredPlan.task_ref_state).toBe('active')
    expect(restoredPlan.state).toBe('planned')
    expect(undo.puts.some((d) => d.id === 't1')).toBe(true)
  })
  it('撤销时安排已有新版本 → 拒绝恢复，不覆盖用户新修改', () => {
    const latest = [note(), task(), action(), plan()]
    const del = cascadeDeleteNotePlan(latest, 'n1', [])
    const last = { kind: 'note', note: del.info.note, tasks: del.info.tasks, actions: del.info.actions, planRemoved: del.info.planRemoved, planDetached: del.info.planDetached, sessionPatches: del.info.sessionPatches }
    // 用户期间已重建同 ID 安排（新版本）。
    const present = [plan({ action_text: '用户新说明' })]
    expect(() => undoDeletePlan(present, last, NOW)).toThrow(/不恢复/)
  })
  it('历史断引用安排撤销回补：仅当仍是本次置的 deleted 且任务已恢复', () => {
    const p = plan({ state: 'done', actual_minutes: 10, focus_session_id: 's1' })
    const s = sess()
    const latest = [task({ note_ids: [] }), action(), p, s]
    const del = deleteTaskPlan(latest, 't1', [s])
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions, planRemoved: del.info.planRemoved, planDetached: del.info.planDetached, sessionPatches: del.info.sessionPatches }
    // 断引用的历史安排/会话未被删除，仍在库中（del.puts 即删除后幸存的修改记录）。
    const undo = undoDeletePlan(del.puts, last, NOW)
    const rp = undo.puts.find((d) => d.id === 'p1')
    expect(rp.task_ref_state).toBe('active')
    expect(rp.state).toBe('done') // 历史状态不被撤销改写
    expect(undo.info.planRefs.applied).toEqual([{ id: 'p1', from: 'deleted', to: 'active' }])
  })
  it('历史安排撤销时已被改成 active（其它页面）→ 保持现状不覆盖', () => {
    const p = plan({ state: 'done', actual_minutes: 10, focus_session_id: 's1' })
    const s = sess()
    const del = deleteTaskPlan([task({ note_ids: [] }), action(), p, s], 't1', [s])
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions, planRemoved: [], planDetached: del.info.planDetached, sessionPatches: del.info.sessionPatches }
    // 安排已被其它页面恢复为 active（任务本体尚未恢复，仍在本次撤销集合）。
    const present = [plan({ state: 'done', actual_minutes: 10, focus_session_id: 's1', task_ref_state: 'active' })]
    const undo = undoDeletePlan(present, last, NOW)
    expect(undo.info.planRefs.refused.some((r) => r.id === 'p1' && r.reason === 'changed')).toBe(true)
  })
})

describe('A18 周聚合兼容：旧 weekGrid 不变；weekSchedule 上区安排/下区截止分开', () => {
  const tasks = [
    task({ id: 't1', deadline: { value: '2026-11-27', precision: 'date' } }),
    task({ id: 't2', title: '无截止任务', deadline: { value: null, precision: 'none' } }),
  ]
  it('旧 weekGrid 接口与截止表现完全不变（计划存在不影响任务网格）', () => {
    const start = weekStartOf('2026-11-23') // 本周含 11-27
    const grid = weekGrid(tasks, start, nowD)
    expect(grid.days).toHaveLength(7)
    expect(grid.count).toBe(1) // 只有 t1 有截止落位（11-27 在本周内）
    expect(grid.undated.map((t) => t.id)).toEqual(['t2'])
    const day = grid.days.find((d) => d.date === '2026-11-27')
    expect(day.items.map((i) => i.task.id)).toEqual(['t1'])
    expect(day.items[0].minutes).toBeNull() // 日期型不带钟点
  })
  it('同任务三天安排 → 上区三条；一个总截止 → 下区一条；两计数分开', () => {
    const plans = [
      plan({ id: 'd1', task_id: 't1', date: '2026-11-23', order: 0 }),
      plan({ id: 'd2', task_id: 't1', date: '2026-11-24', order: 0 }),
      plan({ id: 'd3', task_id: 't1', date: '2026-11-25', order: 0 }),
    ]
    const start = weekStartOf('2026-11-23')
    const sch = weekSchedule({ docs: [...tasks, ...plans], startStr: start, nowD })
    expect(sch.planCount).toBe(3)
    expect(sch.deadlineCount).toBe(1) // 一个任务一个截止，不因三天安排变三个
    expect(sch.days.find((d) => d.date === '2026-11-23').plans.map((e) => e.plan.id)).toEqual(['d1'])
    expect(sch.days.find((d) => d.date === '2026-11-27').deadlines.map((e) => e.task.id)).toEqual(['t1'])
    // 无截止任务的安排仍在上区。
    const nd = plan({ id: 'nd', task_id: 't2', date: '2026-11-24' })
    const sch2 = weekSchedule({ docs: [...tasks, ...plans, nd], startStr: start, nowD })
    expect(sch2.days.find((d) => d.date === '2026-11-24').plans.map((e) => e.plan.id).sort()).toEqual(['d2', 'nd'])
    expect(sch2.undatedTasks.map((t) => t.id)).toEqual(['t2'])
  })
  it('终态/断引用/任务已完成的旧安排进 planHistory（保留原因），不当今天待做', () => {
    const plans = [
      plan({ id: 'done', date: '2026-11-23', state: 'done' }),
      plan({ id: 'canc', date: '2026-11-23', state: 'cancelled', order: 1 }),
      plan({ id: 'mov', date: '2026-11-23', state: 'moved', order: 2 }),
      plan({ id: 'det', date: '2026-11-23', state: 'partial', task_ref_state: 'deleted', order: 3 }),
    ]
    const doneTask = task({ id: 't3', status: 'done', deadline: { value: null, precision: 'none' } })
    const oldPlan = plan({ id: 'old', task_id: 't3', date: '2026-11-23', order: 4 })
    const start = weekStartOf('2026-11-23')
    const sch = weekSchedule({ docs: [...tasks, doneTask, ...plans, oldPlan], startStr: start, nowD })
    const hist = sch.days.find((d) => d.date === '2026-11-23').planHistory
    expect(hist.map((e) => e.plan.id)).toEqual(['done', 'canc', 'mov', 'det', 'old'])
    expect(hist.find((e) => e.plan.id === 'det').reason).toBe('task_deleted')
    expect(hist.find((e) => e.plan.id === 'old').reason).toBe('task_done')
    expect(hist.find((e) => e.plan.id === 'done').reason).toBe('done')
    expect(sch.planCount).toBe(0) // 上区无活安排
  })
  it('周外记录不丢失（outsideWeek），只是不在七日列', () => {
    const far = plan({ id: 'far', date: '2027-03-01' })
    const start = weekStartOf('2026-11-23')
    const sch = weekSchedule({ docs: [...tasks, far], startStr: start, nowD })
    expect(sch.outsideWeek.map((e) => e.plan.id)).toEqual(['far'])
    expect(sch.planCount).toBe(0)
  })
  it('上区按 order 升序再按 ID 稳定排序', () => {
    const plans = [plan({ id: 'b', date: '2026-11-23', order: 2 }), plan({ id: 'a', date: '2026-11-23', order: 1 })]
    const sch = weekSchedule({ docs: [...tasks, ...plans], startStr: weekStartOf('2026-11-23'), nowD })
    expect(sch.days.find((d) => d.date === '2026-11-23').plans.map((e) => e.plan.id)).toEqual(['a', 'b'])
  })
})