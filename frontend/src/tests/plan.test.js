// 5A-0 每日安排纯领域验收（开工单 §12 A01–A04/A07–A14 的域层证据）。
// 独立 oracle：手工构造事务内 latest docs + 注入时钟/ID，断言 puts/deletes/info.code 与字段事实。
// 不触库、不依赖 Vue；所有「今天」用注入 nowD（北京），与设备时区无关。
import { describe, expect, it } from 'vitest'
import {
  cleanDate, cleanPlannedMinutes, cleanActionText,
  createPlan, editPlan, movePlan, cancelPlan, confirmProgressPlan, arrangeAnotherDayPlan,
  planRisk, summarizePlanTime, classifyUnscheduled, assertPlanExecutable,
  sessionsForPlan, unfinishedSessionsForPlan, endedSessionsForPlan, sortPlanItems,
  existingUnfinishedSessionForPlan, isActivePlan, isLiveRef,
  planSnapshot, planSnapshotDiff,
} from '@/domains/plan'
import { planStaleRows } from '@/domains/labels'

const WS = 'ws-1'
const NOW = '2026-11-22T12:00:00+08:00' // 北京今天 = 2026-11-22
const nowD = new Date(NOW)
let idc = 0
const env = () => ({ ws: WS, wallNow: NOW, newId: () => `gen-${++idc}` })
const codeOf = (fn) => { try { fn(); return null } catch (e) { return e.code } }

const task = (over = {}) => ({
  id: 'task-1', kind: 'task', workspace_id: WS, title: '完成实验报告', status: 'todo',
  matter_id: null, note_ids: [], current_action_id: null,
  deadline: { value: '2026-11-27', precision: 'date', source: 'note', from_note_id: null, confirmed_at: NOW },
  ...over,
})
const action = (over = {}) => ({ id: 'action-1', kind: 'action', workspace_id: WS, task_id: 'task-1', text: '撰写正文', minutes: 60, done: false, ...over })
const plan = (over = {}) => ({
  id: 'plan-1', kind: 'plan_item', workspace_id: WS, task_id: 'task-1', date: '2026-11-23',
  planned_minutes: 60, action_text: '撰写正文', state: 'planned', actual_minutes: null,
  focus_session_id: null, order: 0, task_ref_state: 'active', ...over,
})
const snap = (p) => ({ task_id: p.task_id, date: p.date, state: p.state, action_text: p.action_text, planned_minutes: p.planned_minutes, task_ref_state: p.task_ref_state || 'active' })
const session = (over = {}) => ({
  id: 'sess-1', kind: 'focus_session', workspace_id: WS, task_id: 'task-1', action_id: 'action-1',
  plan_item_id: 'plan-1', started_at: NOW, accumulated_ms: 600000, running: false, draft_md: '',
  outcome: 'partial', blocker: null, ended_at: '2026-11-23T10:30:00+08:00', record_version: 1,
  timer_anchor_at: null, task_ref_state: 'active', action_ref_state: 'active', ...over,
})
const createInput = (over = {}) => ({ taskId: 'task-1', planItemId: 'new-plan', date: '2026-11-23', plannedMinutes: 60, actionText: '撰写正文', ...over })

describe('A03/A04 字段校验：严格真实日期 + 有限安全正整数分钟 + 非空说明', () => {
  it('A03 拒绝非法/滚动日期，接受真实闰日与跨年', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '20260101', '', null, 20261122]) {
      expect(codeOf(() => cleanDate(bad))).toBe('INVALID_DATE')
    }
    expect(cleanDate('2024-02-29')).toBe('2024-02-29') // 真实闰日
    expect(codeOf(() => cleanDate('2026-02-29'))).toBe('INVALID_DATE') // 非闰年
    expect(cleanDate('2026-12-31')).toBe('2026-12-31')
    expect(cleanDate('2027-01-01')).toBe('2027-01-01')
  })
  it('A04 拒绝 0/负/小数/NaN/Infinity/非数值，接受正整数', () => {
    for (const bad of [0, -5, 1.5, NaN, Infinity, -Infinity, '30', null, undefined, 1e21]) {
      expect(codeOf(() => cleanPlannedMinutes(bad))).toBe('INVALID_MINUTES')
    }
    expect(cleanPlannedMinutes(1)).toBe(1)
    expect(cleanPlannedMinutes(90)).toBe(90)
  })
  it('A04 说明去首尾空白后非空', () => {
    expect(cleanActionText('  撰写正文  ')).toBe('撰写正文')
    for (const bad of ['', '   ', '\n\t', null, 5]) expect(codeOf(() => cleanActionText(bad))).toBe('INVALID_FIELD')
  })
  it('A03/A04 非法字段在 create 中零写入（抛错即回滚，不产生半条计划）', () => {
    const latest = [task()]
    expect(codeOf(() => createPlan(latest, env(), createInput({ date: '2026-02-30' })))).toBe('INVALID_DATE')
    expect(codeOf(() => createPlan(latest, env(), createInput({ plannedMinutes: 0 })))).toBe('INVALID_MINUTES')
    expect(codeOf(() => createPlan(latest, env(), createInput({ actionText: '  ' })))).toBe('INVALID_FIELD')
  })
})

describe('A01 同任务跨三天安排：各条独立、总截止不变、不回写 Task/Action/便签', () => {
  it('三天三条 planned，order 按目标日各自分配，Task 原样不动', () => {
    const t = task()
    const latest = [t, action()]
    const out = []
    for (const [i, date] of ['2026-11-23', '2026-11-24', '2026-11-25'].entries()) {
      const r = createPlan(latest, env(), createInput({ planItemId: `p-${i}`, date }))
      expect(r.info.code).toBeUndefined()
      out.push(r.puts[0])
      latest.push(r.puts[0])
    }
    expect(out.map((p) => p.date)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25'])
    expect(out.every((p) => p.task_id === 'task-1' && p.state === 'planned')).toBe(true)
    expect(out.every((p) => p.actual_minutes === null && p.focus_session_id === null)).toBe(true)
    // 每天首条 order=1（该日此前无活安排）；不批量改号。
    expect(out.map((p) => p.order)).toEqual([1, 1, 1])
    // create 只 put 计划本身，绝不改 Task/Action/便签。
    for (const r of [createPlan([t], env(), createInput({ planItemId: 'solo' }))]) {
      expect(r.puts).toHaveLength(1)
      expect(r.puts[0].kind).toBe('plan_item')
      expect(r.deletes).toEqual([])
    }
    expect(t.deadline.value).toBe('2026-11-27')
    expect(t.status).toBe('todo')
    expect(t.current_action_id).toBeNull()
  })
  it('同日多条按 order 升序追加，再按 ID 稳定排序', () => {
    const latest = [task(), plan({ id: 'a', date: '2026-11-23', order: 1 }), plan({ id: 'b', date: '2026-11-23', order: 2 })]
    const r = createPlan(latest, env(), createInput({ planItemId: 'c', date: '2026-11-23', actionText: '另一段工作' }))
    expect(r.puts[0].order).toBe(3)
    const sorted = sortPlanItems([...latest.filter((d) => d.kind === 'plan_item'), r.puts[0]])
    expect(sorted.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('A02 无截止任务 + 待安排分类读全量计划（不只看当前周）', () => {
  it('无截止任务可安排，风险 no_deadline', () => {
    const t = task({ id: 'task-2', deadline: { value: null, precision: 'none' } })
    const r = createPlan([t], env(), createInput({ taskId: 'task-2', planItemId: 'p2' }))
    expect(r.info.code).toBeUndefined()
    expect(r.info.risk.kind).toBe('no_deadline')
  })
  it('分类：未来有安排=scheduled；仅过去=needs_continue；均无=unscheduled；另外输出过去未完成', () => {
    const tasks = [task({ id: 'tA' }), task({ id: 'tB' }), task({ id: 'tC' }), task({ id: 'tD', status: 'done' })]
    const plans = [
      plan({ id: 'a1', task_id: 'tA', date: '2026-11-25' }), // 未来
      plan({ id: 'b1', task_id: 'tB', date: '2026-11-20' }), // 过去
      plan({ id: 'c1', task_id: 'tC', date: '2026-11-20', state: 'done' }), // 只剩历史
      plan({ id: 'a0', task_id: 'tA', date: '2026-11-19' }), // tA 也有过去未处理
    ]
    const r = classifyUnscheduled(tasks, plans, nowD)
    expect(r.scheduled).toEqual(['tA'])
    expect(r.needsContinue).toEqual(['tB'])
    expect(r.unscheduled).toEqual(['tC']) // 「尚未安排」≠「从未安排过」
    expect(r.entries.find((e) => e.taskId === 'tD')).toBeUndefined() // 已完成任务不进入
    // 未来已有安排的 tA 仍另有过去未完成集合，不被单一分类隐藏。
    expect(r.pastUnfinished).toEqual([{ taskId: 'tA', planIds: ['a0'] }, { taskId: 'tB', planIds: ['b1'] }])
  })
  it('空周不等于尚未安排：分类不依赖周窗口', () => {
    const tasks = [task({ id: 'tA' })]
    const plans = [plan({ id: 'far', task_id: 'tA', date: '2027-03-01' })] // 远离当前周
    expect(classifyUnscheduled(tasks, plans, nowD).scheduled).toEqual(['tA'])
  })
})

describe('A06 相同内容是提醒不是永久去重', () => {
  it('同任务+日期+规范化说明已有活条目 → DUPLICATE_PLAN 零写入并带匹配 ID', () => {
    const latest = [task(), plan({ id: 'exist', date: '2026-11-23', action_text: '撰写正文' })]
    const r = createPlan(latest, env(), createInput({ planItemId: 'dup', date: '2026-11-23', actionText: '  撰写正文  ' }))
    expect(r.puts).toEqual([])
    expect(r.info.code).toBe('DUPLICATE_PLAN')
    expect(r.info.matchingIds).toEqual(['exist'])
  })
  it('明确确认匹配 ID 后新意图可创建完全相同第二条', () => {
    const latest = [task(), plan({ id: 'exist', date: '2026-11-23', action_text: '撰写正文' })]
    const r = createPlan(latest, env(), createInput({ planItemId: 'second', confirmedDuplicateIds: ['exist'] }))
    expect(r.info.code).toBeUndefined()
    expect(r.puts[0].id).toBe('second')
  })
  it('确认范围与事务内最新不符 → DUPLICATE_SCOPE_CHANGED 零写入', () => {
    const latest = [task(), plan({ id: 'exist', date: '2026-11-23', action_text: '撰写正文' }), plan({ id: 'exist2', date: '2026-11-23', action_text: '撰写正文', order: 1 })]
    const r = createPlan(latest, env(), createInput({ planItemId: 'x', confirmedDuplicateIds: ['exist'] }))
    expect(r.puts).toEqual([])
    expect(r.info.code).toBe('DUPLICATE_SCOPE_CHANGED')
    expect(r.info.matchingIds).toEqual(['exist', 'exist2'])
  })
  it('跨日相同说明 / 同日不同说明 / cancelled 条目不触发提醒', () => {
    const base = [task(), plan({ id: 'e', date: '2026-11-23', action_text: '撰写正文' })]
    expect(createPlan(base, env(), createInput({ planItemId: 'd1', date: '2026-11-24' })).info.code).toBeUndefined()
    expect(createPlan(base, env(), createInput({ planItemId: 'd2', actionText: '检查格式' })).info.code).toBeUndefined()
    const cancelled = [task(), plan({ id: 'c', date: '2026-11-23', action_text: '撰写正文', state: 'cancelled' })]
    expect(createPlan(cancelled, env(), createInput({ planItemId: 'd3' })).info.code).toBeUndefined()
  })
})

describe('A07 未执行安排的编辑/改期/取消：ID 与顺序稳定、总截止不变', () => {
  it('edit 只改说明/预计分钟，保留 ID/date/order/state', () => {
    const p = plan()
    const r = editPlan([task(), p], env(), { planItemId: 'plan-1', expected: snap(p), actionText: '新说明', plannedMinutes: 45 })
    expect(r.puts[0]).toMatchObject({ id: 'plan-1', date: '2026-11-23', order: 0, state: 'planned', action_text: '新说明', planned_minutes: 45 })
  })
  it('move 跨日保留 ID、追加目标日 order、不改 Task 截止；同日改期无操作', () => {
    const p = plan({ date: '2026-11-23', order: 2 })
    const latest = [task(), p, plan({ id: 'other', date: '2026-11-25', order: 5 })]
    const r = movePlan(latest, env(), { planItemId: 'plan-1', expected: snap(p), date: '2026-11-25' })
    expect(r.puts[0]).toMatchObject({ id: 'plan-1', date: '2026-11-25', order: 6 })
    expect(r.info.fromDate).toBe('2026-11-23')
    expect(latest[0].deadline.value).toBe('2026-11-27')
    const same = movePlan([task(), p], env(), { planItemId: 'plan-1', expected: snap(p), date: '2026-11-23' })
    expect(same.puts).toEqual([])
    expect(same.info.unchanged).toBe(true)
  })
  it('cancel 显式确认后设 cancelled，保留记录（非硬删除）', () => {
    const p = plan()
    expect(codeOf(() => cancelPlan([task(), p], env(), { planItemId: 'plan-1', expected: snap(p) }))).toBe('CONFIRM_REQUIRED')
    const r = cancelPlan([task(), p], env(), { planItemId: 'plan-1', expected: snap(p), confirm: true })
    expect(r.deletes).toEqual([])
    expect(r.puts[0].state).toBe('cancelled')
    expect(r.puts[0].id).toBe('plan-1')
  })
  it('终态安排不可编辑/改期/取消（不隐式重开）', () => {
    for (const state of ['done', 'cancelled', 'moved']) {
      const p = plan({ state })
      expect(codeOf(() => editPlan([task(), p], env(), { planItemId: 'plan-1', expected: snap(p), actionText: 'x' }))).toBe('PLAN_TERMINAL')
      expect(codeOf(() => movePlan([task(), p], env(), { planItemId: 'plan-1', expected: snap(p), date: '2026-11-24' }))).toBe('PLAN_TERMINAL')
      expect(codeOf(() => cancelPlan([task(), p], env(), { planItemId: 'plan-1', expected: snap(p), confirm: true }))).toBe('PLAN_TERMINAL')
    }
  })
})

describe('A08 真实会话历史保护：未结束拦变更、已结束拦原地改写', () => {
  it('任何未结束会话（含暂停）→ UNFINISHED_FOCUS 附会话 ID，拦编辑/改期/取消/进度', () => {
    const p = plan()
    const paused = session({ ended_at: null, running: false, outcome: null })
    const latest = [task(), p, paused]
    const args = { planItemId: 'plan-1', expected: snap(p) }
    expect(codeOf(() => editPlan(latest, env(), { ...args, actionText: 'x' }))).toBe('UNFINISHED_FOCUS')
    expect(codeOf(() => movePlan(latest, env(), { ...args, date: '2026-11-24' }))).toBe('UNFINISHED_FOCUS')
    expect(codeOf(() => cancelPlan(latest, env(), { ...args, confirm: true }))).toBe('UNFINISHED_FOCUS')
    expect(codeOf(() => confirmProgressPlan(latest, env(), { ...args, progress: 'done' }))).toBe('UNFINISHED_FOCUS')
    try { editPlan(latest, env(), { ...args, actionText: 'x' }) } catch (e) { expect(e.sessionIds).toEqual(['sess-1']) }
  })
  it('已结束会话 → PLAN_HAS_HISTORY，拦原地改日期/说明/估时', () => {
    const p = plan()
    const latest = [task(), p, session()]
    expect(codeOf(() => editPlan(latest, env(), { planItemId: 'plan-1', expected: snap(p), actionText: 'x' }))).toBe('PLAN_HAS_HISTORY')
    expect(codeOf(() => movePlan(latest, env(), { planItemId: 'plan-1', expected: snap(p), date: '2026-11-24' }))).toBe('PLAN_HAS_HISTORY')
  })
  it('会话归属按 plan_item_id+task+workspace 命中，不看快捷 focus_session_id/actual_minutes', () => {
    const p = plan({ focus_session_id: null, actual_minutes: null })
    const other = session({ id: 's-other', plan_item_id: 'plan-OTHER' })
    expect(sessionsForPlan([p, other], p)).toEqual([])
    const wrongTask = session({ id: 's-wt', task_id: 'task-2' })
    expect(sessionsForPlan([p, wrongTask], p)).toEqual([])
    const wrongWs = session({ id: 's-ww', workspace_id: 'ws-2' })
    expect(sessionsForPlan([p, wrongWs], p)).toEqual([])
    const hit = session({ id: 's-hit' })
    expect(sessionsForPlan([p, hit], p).map((s) => s.id)).toEqual(['s-hit'])
    expect(unfinishedSessionsForPlan([p, session({ ended_at: null })], p)).toHaveLength(1)
    expect(endedSessionsForPlan([p, session()], p)).toHaveLength(1)
  })
})

describe('A09/A10 进度确认与旧 planned 已有结束记录', () => {
  it('无会话也允许确认 partial/done，actual_minutes 仍 null（未记录）', () => {
    const p = plan()
    const r = confirmProgressPlan([task(), p], env(), { planItemId: 'plan-1', expected: snap(p), progress: 'done' })
    expect(r.puts[0].state).toBe('done')
    expect(r.puts[0].actual_minutes).toBeNull()
    expect(r.puts[0].focus_session_id).toBeNull()
    // 不完成 Action/Task。
    expect(r.puts).toHaveLength(1)
  })
  it('有结束记录：确认须回传完整历史摘要，按本单口径重算 actual_minutes/focus_session_id', () => {
    const p = plan()
    const s1 = session({ id: 's1', accumulated_ms: 1800000, ended_at: '2026-11-23T10:30:00+08:00' })
    const s2 = session({ id: 's2', accumulated_ms: 600000, ended_at: '2026-11-23T11:00:00+08:00' })
    const latest = [task(), p, s1, s2]
    const summary = summarizePlanTime(p, latest)
    expect(codeOf(() => confirmProgressPlan(latest, env(), { planItemId: 'plan-1', expected: snap(p), progress: 'partial' }))).toBe('HISTORY_UNCONFIRMED')
    const r = confirmProgressPlan(latest, env(), { planItemId: 'plan-1', expected: snap(p), progress: 'partial', historyConfirm: summary })
    expect(r.puts[0].actual_minutes).toBe(40) // (1800000+600000)/60000
    expect(r.puts[0].focus_session_id).toBe('s2') // 最近已结束
    expect(r.puts[0].state).toBe('partial')
  })
  it('历史摘要变化 → HISTORY_CHANGED 拒绝（不静默覆盖）', () => {
    const p = plan()
    const latest = [task(), p, session()]
    const stale = { endedSessionIds: ['sess-1'], totalMs: 999, actualMinutes: 0, latestEndedSessionId: 'sess-1' }
    expect(codeOf(() => confirmProgressPlan(latest, env(), { planItemId: 'plan-1', expected: snap(p), progress: 'done', historyConfirm: stale }))).toBe('HISTORY_CHANGED')
  })
  it('A10 旧/导入 planned 已有结束会话：读取不写，确认才改状态；终态不可再确认', () => {
    const p = plan({ state: 'planned' })
    const latest = [task(), p, session()]
    // 纯读取汇总不改库。
    const before = JSON.stringify(latest)
    summarizePlanTime(p, latest)
    expect(JSON.stringify(latest)).toBe(before)
    const summary = summarizePlanTime(p, latest)
    const r = confirmProgressPlan(latest, env(), { planItemId: 'plan-1', expected: snap(p), progress: 'done', historyConfirm: summary })
    expect(r.puts[0].state).toBe('done')
    expect(codeOf(() => confirmProgressPlan([task(), r.puts[0], session()], env(), { planItemId: 'plan-1', expected: snap(r.puts[0]), progress: 'partial', historyConfirm: summary }))).toBe('PLAN_TERMINAL')
  })
  it('arrangeAnotherDay 新建另一条（新 ID），不迁移原会话、不相减历史用时', () => {
    const p = plan({ state: 'partial', actual_minutes: 30, focus_session_id: 'sess-1' })
    const latest = [task(), p, session()]
    const r = arrangeAnotherDayPlan(latest, env(), createInput({ planItemId: 'another', date: '2026-11-24', actionText: '继续撰写' }))
    expect(r.puts).toHaveLength(1)
    expect(r.puts[0].id).toBe('another')
    expect(r.puts[0].actual_minutes).toBeNull()
    expect(r.puts[0].state).toBe('planned')
    expect(p.actual_minutes).toBe(30) // 原安排历史用时不变
  })
})

describe('A11 截止风险：先后关系与 overdue 两维度独立、北京落日、确认依据变化拒绝', () => {
  it('日期型截止：before/same_day/after 与 overdue 独立', () => {
    const t = task({ deadline: { value: '2026-11-27', precision: 'date' } })
    expect(planRisk(t, '2026-11-26', nowD).kind).toBe('before_deadline')
    expect(planRisk(t, '2026-11-27', nowD).kind).toBe('due_same_day')
    expect(planRisk(t, '2026-11-27', nowD).deadlineMinutes).toBeNull() // 不制造 23:59
    expect(planRisk(t, '2026-11-28', nowD).kind).toBe('after_deadline')
    expect(planRisk(t, '2026-11-28', nowD).overdue).toBe(false) // 今天 11-22 未逾期
    const past = task({ deadline: { value: '2026-11-20', precision: 'date' } })
    const r = planRisk(past, '2026-11-23', nowD)
    expect(r.kind).toBe('after_deadline')
    expect(r.overdue).toBe(true) // 两维度同时存在
  })
  it('含钟点截止同日 → due_same_day_timed 带真实北京钟点；偏移/Z 先转北京落日', () => {
    const t = task({ deadline: { value: '2026-11-27T14:30:00+08:00', precision: 'datetime' } })
    const r = planRisk(t, '2026-11-27', nowD)
    expect(r.kind).toBe('due_same_day_timed')
    expect(r.deadlineMinutes).toBe(14 * 60 + 30)
    // Z 时刻 2026-11-27T18:00Z = 北京 11-28 02:00 → 落日 11-28。
    const z = task({ deadline: { value: '2026-11-27T18:00:00Z', precision: 'datetime' } })
    expect(planRisk(z, '2026-11-27', nowD).kind).toBe('before_deadline')
    expect(planRisk(z, '2026-11-28', nowD).kind).toBe('due_same_day_timed')
    expect(planRisk(z, '2026-11-28', nowD).deadlineDay).toBe('2026-11-28')
  })
  it('已完成任务不标 overdue', () => {
    const t = task({ status: 'done', deadline: { value: '2026-11-20', precision: 'date' } })
    expect(planRisk(t, '2026-11-23', nowD).overdue).toBe(false)
  })
  it('超截止创建/改期必须明确确认；确认依据（截止值/精度/安排日）变化 → DEADLINE_CHANGED', () => {
    const t = task({ deadline: { value: '2026-11-20', precision: 'date' } })
    expect(codeOf(() => createPlan([t], env(), createInput({ date: '2026-11-23' })))).toBe('AFTER_DEADLINE_UNCONFIRMED')
    const ok = createPlan([t], env(), createInput({ date: '2026-11-23', deadlineConfirm: { value: '2026-11-20', precision: 'date', planDate: '2026-11-23' } }))
    expect(ok.info.code).toBeUndefined()
    // 事务内截止已变（确认基于旧值）→ 拒绝。
    const changed = task({ deadline: { value: '2026-11-21', precision: 'date' } })
    expect(codeOf(() => createPlan([changed], env(), createInput({ date: '2026-11-23', deadlineConfirm: { value: '2026-11-20', precision: 'date', planDate: '2026-11-23' } })))).toBe('DEADLINE_CHANGED')
  })
})

describe('A12 实际用时纯汇总：先 sum 再 floor 一次、null vs 0、最近 ID 稳定决胜', () => {
  it('两段各 40 秒 → 总 80 秒 → 整数 1 分钟（不逐段取整）', () => {
    const p = plan()
    const docs = [p, session({ id: 's1', accumulated_ms: 40000, ended_at: '2026-11-23T10:00:00+08:00' }), session({ id: 's2', accumulated_ms: 40000, ended_at: '2026-11-23T10:01:00+08:00' })]
    const r = summarizePlanTime(p, docs)
    expect(r.totalMs).toBe(80000)
    expect(r.actualMinutes).toBe(1)
    expect(r.endedSessionCount).toBe(2)
  })
  it('无已结束=null；有但不足一分钟=0', () => {
    const p = plan()
    expect(summarizePlanTime(p, [p]).actualMinutes).toBeNull()
    expect(summarizePlanTime(p, [p, session({ accumulated_ms: 30000 })]).actualMinutes).toBe(0)
  })
  it('未结束不混入累计；非法负时长/非法 ended_at 报告问题不算有效，权威结果不可用', () => {
    const p = plan()
    const docs = [p, session({ id: 'ok', accumulated_ms: 60000 }), session({ id: 'run', ended_at: null, accumulated_ms: 999999 }), session({ id: 'neg', accumulated_ms: -5 }), session({ id: 'badend', ended_at: 'not-a-time' })]
    const r = summarizePlanTime(p, docs)
    expect(r.endedSessionCount).toBe(1)
    expect(r.totalMs).toBe(60000)
    expect(r.problems.map((x) => x.code).sort()).toEqual(['INVALID_DURATION', 'INVALID_ENDED_AT'])
    expect(r.authoritative).toBe(false)
    expect(r.actualMinutes).toBeNull()
    expect(r.latestEndedSessionId).toBeNull()
  })
  it('相同 ID 冲突数据整组排除，结果与输入顺序无关，不生成权威结论', () => {
    const p = plan()
    const a = session({ id: 'dup', accumulated_ms: 60000 })
    const b = session({ id: 'dup', accumulated_ms: 120000 })
    const fwd = summarizePlanTime(p, [p, a, b])
    const rev = summarizePlanTime(p, [p, b, a])
    expect(fwd.problems.some((x) => x.code === 'CONFLICTING_SESSION')).toBe(true)
    expect(fwd.endedSessionCount).toBe(0)
    expect(fwd.totalMs).toBe(0)
    expect(fwd.authoritative).toBe(false)
    expect(fwd.actualMinutes).toBeNull()
    expect(JSON.stringify(fwd)).toBe(JSON.stringify(rev))
  })
  it('最近已结束按真实瞬时排序，同刻按 ID 稳定决胜（不取数组末项）', () => {
    const p = plan()
    const docs = [p, session({ id: 'zz', ended_at: '2026-11-23T10:00:00+08:00' }), session({ id: 'aa', ended_at: '2026-11-23T10:00:00+08:00' })]
    expect(summarizePlanTime(p, docs).latestEndedSessionId).toBe('zz') // 同刻 ID 大者胜
    const later = [p, session({ id: 'aa', ended_at: '2026-11-23T11:00:00+08:00' }), session({ id: 'zz', ended_at: '2026-11-23T10:00:00+08:00' })]
    expect(summarizePlanTime(p, later).latestEndedSessionId).toBe('aa') // 真实更晚
  })
})

describe('A13/A14 快照并发保护 + 执行资格校验', () => {
  it('A13 快照与事务内最新不符 → STALE_PLAN（相关字段并发保护）', () => {
    const p = plan()
    const stale = { ...snap(p), planned_minutes: 30 } // 用户看到的是旧估时
    expect(codeOf(() => editPlan([task(), p], env(), { planItemId: 'plan-1', expected: stale, actionText: 'x' }))).toBe('STALE_PLAN')
    expect(codeOf(() => editPlan([task(), p], env(), { planItemId: 'plan-1', actionText: 'x' }))).toBe('STALE_PLAN') // 缺快照
  })
  it('A13 Task 已完成/删除/跨空间 → 拒绝变更', () => {
    const p = plan()
    expect(codeOf(() => editPlan([task({ status: 'done' }), p], env(), { planItemId: 'plan-1', expected: snap(p), actionText: 'x' }))).toBe('TASK_DONE')
    // R4 整改后：变更命令统一先重查 Task（已完成 → TASK_DONE，先于日期/快照检查）。
    expect(codeOf(() => movePlan([task({ status: 'done' }), p], env(), { planItemId: 'plan-1', expected: snap(p), date: '2026-11-24' }))).toBe('TASK_DONE')
    // 任务删除（引用断开）→ 历史只读。
    const detached = plan({ task_ref_state: 'deleted' })
    expect(codeOf(() => editPlan([task(), detached], env(), { planItemId: 'plan-1', expected: snap(detached), actionText: 'x' }))).toBe('PLAN_NOT_EXECUTABLE')
    // 跨空间安排不可编辑。
    expect(codeOf(() => editPlan([task(), plan({ workspace_id: 'ws-2' })], env(), { planItemId: 'plan-1', expected: snap(p), actionText: 'x' }))).toBe('RELATION_INVALID')
  })
  it('A14 执行资格：active+planned/partial、同空间未完成 Task、明确同 Task 未完成 Action', () => {
    const docs = [task(), action(), plan()]
    const r = assertPlanExecutable(docs, 'plan-1', 'action-1')
    expect(r.planItem.id).toBe('plan-1')
    expect(r.action.id).toBe('action-1')
    // 不按 action_text 查 Action：传入不属于该任务的 Action 拒绝。
    expect(codeOf(() => assertPlanExecutable(docs, 'plan-1', 'action-X'))).toBe('RELATION_INVALID')
    const otherTaskAction = action({ id: 'a2', task_id: 'task-2' })
    expect(codeOf(() => assertPlanExecutable([...docs, otherTaskAction], 'plan-1', 'a2'))).toBe('RELATION_INVALID')
  })
  it('A14 终态/断引用/已完成 Task/已完成 Action 不可执行', () => {
    for (const state of ['done', 'cancelled', 'moved']) {
      expect(codeOf(() => assertPlanExecutable([task(), action(), plan({ state })], 'plan-1', 'action-1'))).toBe('PLAN_NOT_EXECUTABLE')
    }
    expect(codeOf(() => assertPlanExecutable([task(), action(), plan({ task_ref_state: 'deleted' })], 'plan-1', 'action-1'))).toBe('PLAN_NOT_EXECUTABLE')
    expect(codeOf(() => assertPlanExecutable([task({ status: 'done' }), action(), plan()], 'plan-1', 'action-1'))).toBe('TASK_DONE')
    expect(codeOf(() => assertPlanExecutable([task(), action({ done: true }), plan()], 'plan-1', 'action-1'))).toBe('ACTION_DONE')
  })
  it('A14 已有同安排未结束会话可供回到工作（不自动继续）', () => {
    const p = plan()
    const paused = session({ ended_at: null, running: false })
    expect(existingUnfinishedSessionForPlan([p, paused], 'plan-1').id).toBe('sess-1')
    expect(existingUnfinishedSessionForPlan([p, session()], 'plan-1')).toBeNull()
    expect(existingUnfinishedSessionForPlan([p], 'missing')).toBeNull()
  })
  it('活引用/活安排谓词', () => {
    expect(isLiveRef(plan())).toBe(true)
    expect(isLiveRef(plan({ task_ref_state: 'deleted' }))).toBe(false)
    expect(isActivePlan(plan({ state: 'partial' }))).toBe(true)
    expect(isActivePlan(plan({ state: 'done' }))).toBe(false)
    expect(isActivePlan(plan({ task_ref_state: 'deleted' }))).toBe(false)
  })
})

describe('P2 多字段差异清单（5A-1 复验：确认框不得只列首个差异）', () => {
  const base = { task_id: 't1', date: '2026-11-23', state: 'planned', action_text: '原说明', planned_minutes: 30, task_ref_state: 'active' }
  it('说明+分钟同时变更列全部，按 SNAPSHOT_FIELDS 顺序而非回执首项', () => {
    const frozen = { ...base, action_text: '另一页的说明', planned_minutes: 90 }
    const rows = planSnapshotDiff(base, frozen)
    expect(rows.map((r) => r.field)).toEqual(['action_text', 'planned_minutes'])
    expect(rows[1]).toEqual({ field: 'planned_minutes', expected: 30, current: 90 })
  })
  it('日期+分钟同时变更（改期场景）同样列全部', () => {
    const rows = planSnapshotDiff(base, { ...base, date: '2026-11-26', planned_minutes: 90 })
    expect(rows.map((r) => r.field)).toEqual(['date', 'planned_minutes'])
  })
  it('无变化空清单；单字段变化仅一行', () => {
    expect(planSnapshotDiff(base, { ...base })).toEqual([])
    expect(planSnapshotDiff(base, { ...base, planned_minutes: 60 }).map((r) => r.field)).toEqual(['planned_minutes'])
  })
  it('差异行模型：中文名/原值/当前值/草稿将写入值，当前值只取自冻结快照', () => {
    const frozen = { ...base, action_text: '另一页的说明', planned_minutes: 90 }
    const rows = planStaleRows(base, frozen, { action_text: '新草稿说明', planned_minutes: 30 }, () => null)
    expect(rows.map((r) => r.name)).toEqual(['工作说明', '预计分钟'])
    expect(rows[0].expectedText).toBe('原说明')
    expect(rows[0].currentText).toBe('另一页的说明')
    expect(rows[0].writeText).toBe('新草稿说明')
    expect(rows[1].currentText).toBe('90 分钟')
    expect(rows[1].writeText).toBe('30 分钟')
  })
  it('操作不写的字段无写入值；state 用中文状态文案', () => {
    const frozen = { ...base, state: 'partial', planned_minutes: 90 }
    const rows = planStaleRows(base, frozen, { state: 'cancelled' }, () => null)
    expect(rows.map((r) => r.field)).toEqual(['state', 'planned_minutes'])
    expect(rows[0].currentText).toBe('部分完成')
    expect(rows[0].writeText).toBe('已取消')
    expect(rows[1].writeText).toBeNull()
  })
  it('任务引用变化展示任务标题与引用状态文案', () => {
    const frozen = { ...base, task_id: 't2', task_ref_state: 'deleted' }
    const rows = planStaleRows(base, frozen, {}, (id) => (id === 't2' ? '任务乙' : '任务甲'))
    expect(rows[0].name).toBe('所属任务')
    expect(rows[0].expectedText).toBe('任务甲')
    expect(rows[0].currentText).toBe('任务乙')
    expect(rows[1].currentText).toBe('任务已删除')
  })
  it('快照缺省规范化与事务校验一致（task_ref_state 缺省 active）', () => {
    const p = { ...base }
    delete p.task_ref_state
    expect(planSnapshot(p).task_ref_state).toBe('active')
    expect(planSnapshotDiff(planSnapshot(p), planSnapshot({ ...base, task_ref_state: 'deleted' })).map((r) => r.field)).toEqual(['task_ref_state'])
  })
})