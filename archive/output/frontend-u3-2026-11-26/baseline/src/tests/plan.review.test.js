// 5A-0 人工复审整改回归（R1–R5）：把审查探针的反例改写为正确行为断言，并入正式套件。
// 旧探针（devlog/private-evidence/stage5a-0-review-2026-11-22/reproduce.mjs）断言的是缺陷现象，
// 整改后其旧断言应失败；本文件才是整改通过的判据。全部使用虚构数据 + 注入时钟。
// R1 事件时间小数秒；R2 删除范围含计划影响；R3 快照必需字段；R4 变更统一重查 Task；R5 冲突/缓存诊断。
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  editPlan, movePlan, cancelPlan, confirmProgressPlan,
  summarizePlanTime, historySignature, planSnapshot,
} from '@/domains/plan'
import { beginFactsOf } from '@/domains/focus'
import { interpretEventInstant, interpretInstant, isValidTimeValue } from '@/domains/time'
import { cascadeDeleteNotePlan, deleteTaskPlan, deleteImpactSnapshot, planDeleteScope } from '@/domains/matter'
import { assembleArchive } from './backupFixtures'
import { validateBackup, realDatetimeOk } from '@/services/backup/validate'
import fixture07 from '../../../fixtures/07-focus-v1-ended-done.json'

const WS = 'ws-1'
const NOW = '2026-11-22T12:00:00+08:00'
let idc = 0
const env = () => ({ ws: WS, wallNow: NOW, newId: () => `gen-${++idc}` })
const codeOf = (fn) => { try { fn(); return null } catch (e) { return e.code } }

const task = (over = {}) => ({
  id: 'task-1', kind: 'task', workspace_id: WS, title: '完成实验报告', status: 'todo',
  matter_id: null, note_ids: [], current_action_id: null,
  deadline: { value: '2026-11-27', precision: 'date' }, ...over,
})
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
const note = (over = {}) => ({ id: 'note-1', kind: 'note', workspace_id: WS, matter_id: null, matter_role: null, fields: [], ...over })

// 四个变更命令的最小合法输入（完整快照 + 各自确认字段）。
const CMDS = {
  edit: (p, over = {}) => ({ fn: editPlan, input: { planItemId: p.id, expected: snap(p), actionText: '新说明', ...over } }),
  move: (p, over = {}) => ({ fn: movePlan, input: { planItemId: p.id, expected: snap(p), date: '2026-11-24', ...over } }),
  cancel: (p, over = {}) => ({ fn: cancelPlan, input: { planItemId: p.id, expected: snap(p), confirm: true, ...over } }),
  confirmProgress: (p, over = {}) => ({ fn: confirmProgressPlan, input: { planItemId: p.id, expected: snap(p), progress: 'done', ...over } }),
}

describe('R1 事件时间解析：契约同口径小数秒，截止规则不放宽', () => {
  it('toISOString 形状（.000Z/非零小数秒/带偏移小数秒）与 naive 均可解析为真实瞬时', () => {
    expect(interpretEventInstant('2026-11-22T08:00:10.123Z')).toBe(Date.parse('2026-11-22T08:00:10.123Z'))
    expect(interpretEventInstant('2026-11-22T08:00:10.000Z')).toBe(Date.parse('2026-11-22T08:00:10Z'))
    expect(interpretEventInstant('2026-11-22T16:00:10.123+08:00')).toBe(Date.parse('2026-11-22T08:00:10.123Z'))
    expect(interpretEventInstant('2026-11-22T16:00:10.123')).toBe(Date.parse('2026-11-22T08:00:10.123Z')) // naive 按北京
    expect(interpretEventInstant('2026-11-22T08:00:10.1Z')).toBe(Date.parse('2026-11-22T08:00:10.100Z'))
    expect(interpretEventInstant('2026-11-22T08:00:10.123456Z')).toBe(Date.parse('2026-11-22T08:00:10.123Z')) // 截断到 ms
    expect(interpretEventInstant('2026-11-22T16:00+08:00')).toBe(Date.parse('2026-11-22T08:00:00Z')) // 无秒合法
  })
  it('契约/备份接受不带秒小数（HH:MM.fff）：Z/正负偏移/naive 均解析，小数依附秒', () => {
    // 复验 P2：契约 DATETIME_RE 秒与小数分别可选；Python 3.12 fromisoformat 实测
    // 16:00.123+08:00 → 16:00:00.123000+08:00（小数依附秒，不是小数分钟）。
    expect(interpretEventInstant('2026-11-22T16:00.123+08:00')).toBe(Date.parse('2026-11-22T08:00:00.123Z'))
    expect(interpretEventInstant('2026-11-22T08:00.123Z')).toBe(Date.parse('2026-11-22T08:00:00.123Z'))
    expect(interpretEventInstant('2026-11-22T02:30.123-05:30')).toBe(Date.parse('2026-11-22T08:00:00.123Z'))
    expect(interpretEventInstant('2026-11-22T16:00.123')).toBe(Date.parse('2026-11-22T08:00:00.123Z')) // naive 按北京
    expect(interpretEventInstant('2026-11-22T16:00.5+08:00')).toBe(Date.parse('2026-11-22T08:00:00.500Z'))
    expect(interpretEventInstant('2026-11-22T16:00.123456789+08:00')).toBe(Date.parse('2026-11-22T08:00:00.123Z')) // 截断到 ms
    expect(interpretEventInstant('2026-11-22T16:00.123+08:00')).toBe(interpretEventInstant('2026-11-22T16:00:00.123+08:00'))
    // 非法形状仍拒：悬空小数点/小数小时（契约要求 HH:MM）/非法偏移/非法日历。
    for (const bad of ['2026-11-22T16:00.+08:00', '2026-11-22T16.5+08:00', '2026-11-22T16:00.123+08:75', '2026-02-30T16:00.123Z'])
      expect(interpretEventInstant(bad)).toBeNull()
  })
  it('非法日历/钟点/偏移/形状一律拒绝，不靠宽松 Date.parse', () => {
    for (const bad of [
      '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-11-22T25:00:00Z',
      '2026-11-22T10:61:00Z', '2026-11-22T10:00:61Z', '2026-11-22T10:00:00+08:75',
      '2026-11-22T10:00:00+24:00',
      '2026-11-22', 'not-a-time', '', null, 123,
    ]) expect(interpretEventInstant(bad)).toBeNull()
  })
  it('截止输入规则保持原样：isValidTimeValue/interpretInstant 仍拒绝小数秒', () => {
    expect(isValidTimeValue('2026-11-22T08:00:10.123Z')).toBe(false)
    expect(interpretInstant('2026-11-22T08:00:10.123Z')).toBeNull()
    expect(isValidTimeValue('2026-11-22T08:00:10+08:00')).toBe(true)
  })
  it('真实毫秒结束时间计入汇总：80123ms → 1 分钟，最近引用正确', () => {
    const p = plan()
    const s = session({ accumulated_ms: 80123, ended_at: '2026-11-22T08:01:20.123Z' })
    const r = summarizePlanTime(p, [p, s])
    expect(r.problems).toEqual([])
    expect(r.authoritative).toBe(true)
    expect(r.endedSessionCount).toBe(1)
    expect(r.totalMs).toBe(80123)
    expect(r.actualMinutes).toBe(1)
    expect(r.latestEndedSessionId).toBe('sess-1')
  })
  it('两段各 40 秒（小数秒结束）仍先 sum 再 floor 一次 → 1 分钟', () => {
    const p = plan()
    const docs = [p,
      session({ id: 's1', accumulated_ms: 40000, ended_at: '2026-11-23T10:00:00.500Z' }),
      session({ id: 's2', accumulated_ms: 40000, ended_at: '2026-11-23T10:01:00.500Z' })]
    const r = summarizePlanTime(p, docs)
    expect(r.totalMs).toBe(80000)
    expect(r.actualMinutes).toBe(1)
  })
  it('最近已结束按含毫秒的真实瞬时排序，同刻仍按 ID 稳定决胜', () => {
    const p = plan()
    const docs = [p,
      session({ id: 'zz', ended_at: '2026-11-23T10:00:00.900Z' }),
      session({ id: 'aa', ended_at: '2026-11-23T10:00:00.100Z' })]
    expect(summarizePlanTime(p, docs).latestEndedSessionId).toBe('zz')
    const reversed = [p,
      session({ id: 'aa', ended_at: '2026-11-23T10:00:00.900Z' }),
      session({ id: 'zz', ended_at: '2026-11-23T10:00:00.100Z' })]
    expect(summarizePlanTime(p, reversed).latestEndedSessionId).toBe('aa')
    const same = [p,
      session({ id: 'aa', ended_at: '2026-11-23T10:00:00.123Z' }),
      session({ id: 'zz', ended_at: '2026-11-23T10:00:00.123Z' })]
    expect(summarizePlanTime(p, same).latestEndedSessionId).toBe('zz')
  })
  it('「全部解析失败」不是「没有历史」：确认/取消拒绝权威写入，原摘要保留', () => {
    const p = plan({ actual_minutes: 40, focus_session_id: 'sess-1' })
    const bad = session({ ended_at: 'not-a-time' })
    const latest = [task(), p, bad]
    const r = summarizePlanTime(p, latest)
    expect(r.endedSessionCount).toBe(0)
    expect(r.authoritative).toBe(false)
    expect(codeOf(() => confirmProgressPlan(latest, env(), { planItemId: p.id, expected: snap(p), progress: 'done' }))).toBe('HISTORY_UNRESOLVED')
    expect(codeOf(() => cancelPlan(latest, env(), { planItemId: p.id, expected: snap(p), confirm: true }))).toBe('HISTORY_UNRESOLVED')
    expect(p.actual_minutes).toBe(40) // 原值不动
    expect(p.focus_session_id).toBe('sess-1')
  })
  it('部分异常也拒绝：即使回传了有效子集的摘要，不得把异常当不存在', () => {
    const p = plan()
    const latest = [task(), p, session({ id: 'ok', accumulated_ms: 60000 }), session({ id: 'neg', accumulated_ms: -5 })]
    const summary = summarizePlanTime(p, latest)
    expect(summary.authoritative).toBe(false)
    expect(codeOf(() => confirmProgressPlan(latest, env(), { planItemId: p.id, expected: snap(p), progress: 'done', historyConfirm: summary }))).toBe('HISTORY_UNRESOLVED')
  })
  it('备份可接受样本（fixture 07 换不带秒小数 ended_at）：30 分钟计入汇总，进度确认通过，原文不改写', async () => {
    // 复验 P2 正向回归：契约 model_validate 与生产 validateBackup 都接受的形状，
    // 安排汇总/进度确认不得单方面收紧（复现探针 compatibility-probe.mjs 的正确行为版）。
    const stamp = '2026-11-22T16:00.123+08:00'
    const t = { kind: 'task', ...fixture07.task }
    const a = { kind: 'action', ...fixture07.action }
    const s = { kind: 'focus_session', ...fixture07.focus_session, ended_at: stamp }
    const p = { kind: 'plan_item', ...fixture07.plan_items[0], state: 'planned' }
    const docs = [t, a, s, p]
    const archive = await assembleArchive({ workspace: { id: t.workspace_id, name: 'Synthetic contract fixture', is_demo: true }, sources: [], docs, assets: new Map() })
    const accepted = await validateBackup(archive)
    expect(accepted.ok, JSON.stringify(accepted.errors)).toBe(true)
    expect(realDatetimeOk(stamp)).toBe(true)
    const r = summarizePlanTime(p, docs)
    expect(r.problems).toEqual([])
    expect(r.authoritative).toBe(true)
    expect(r.endedSessionCount).toBe(1)
    expect(r.totalMs).toBe(1800000)
    expect(r.actualMinutes).toBe(30)
    expect(r.latestEndedSessionId).toBe(s.id)
    const e = { ws: t.workspace_id, wallNow: '2026-11-22T09:00:00.000Z' }
    const expected = { task_id: p.task_id, date: p.date, state: p.state, action_text: p.action_text, planned_minutes: p.planned_minutes, task_ref_state: p.task_ref_state || 'active' }
    const done = confirmProgressPlan(docs, e, { planItemId: p.id, expected, progress: 'done', historyConfirm: historySignature(r) })
    expect(done.puts[0].actual_minutes).toBe(30)
    expect(done.puts[0].state).toBe('done')
    expect(s.ended_at).toBe(stamp) // 只解释不重写历史原文
  })
})

describe('R2 删除确认范围：计划影响快照参与事务内比对，两条路径一致', () => {
  const scopeOf = (latest, taskIds, sessions = []) => ({
    taskIds, actionIds: [], planItemIds: planDeleteScope(latest, taskIds, sessions).map((x) => x.id),
    planFacts: planDeleteScope(latest, taskIds, sessions),
  })
  it('planDeleteScope 输出 ID+状态+引用+处置事实，按 ID 稳定排序', () => {
    const latest = [
      plan({ id: 'p-b' }),
      plan({ id: 'p-a', state: 'partial' }),
      plan({ id: 'p-c', state: 'done', task_ref_state: 'deleted' }),
      plan({ id: 'p-d' }),
      plan({ id: 'p-e' }),
    ]
    const sessions = [
      session({ id: 's-end', plan_item_id: 'p-d' }),
      session({ id: 's-run', plan_item_id: 'p-e', ended_at: null, running: true }),
    ]
    expect(planDeleteScope(latest, ['task-1'], sessions)).toEqual([
      { id: 'p-a', state: 'partial', taskRefState: 'active', disposition: 'detach' },
      { id: 'p-b', state: 'planned', taskRefState: 'active', disposition: 'remove' },
      { id: 'p-c', state: 'done', taskRefState: 'deleted', disposition: 'keep' },
      { id: 'p-d', state: 'planned', taskRefState: 'active', disposition: 'blocked_progress' },
      { id: 'p-e', state: 'planned', taskRefState: 'active', disposition: 'blocked_unfinished' },
    ])
  })
  it('确认后新增无 Focus 的 planned 安排 → SCOPE_CHANGED，未确认对象零删除（删任务）', () => {
    const base = [task(), plan()]
    const scope = scopeOf(base, ['task-1'])
    const extra = plan({ id: 'plan-2' })
    expect(codeOf(() => deleteTaskPlan([...base, extra], 'task-1', [], scope))).toBe('SCOPE_CHANGED')
  })
  it('确认后移除安排 / planned 变历史 / planned 变取消 → 均 SCOPE_CHANGED（删任务）', () => {
    const p2 = plan({ id: 'plan-2' })
    const base = [task(), plan(), p2]
    const scope = scopeOf(base, ['task-1'])
    expect(codeOf(() => deleteTaskPlan([task(), plan()], 'task-1', [], scope))).toBe('SCOPE_CHANGED')
    expect(codeOf(() => deleteTaskPlan([task(), plan({ state: 'partial' }), p2], 'task-1', [], scope))).toBe('SCOPE_CHANGED')
    expect(codeOf(() => deleteTaskPlan([task(), plan({ state: 'cancelled' }), p2], 'task-1', [], scope))).toBe('SCOPE_CHANGED')
  })
  it('便签联删同样比对计划影响：新增/状态变化 → SCOPE_CHANGED，零删除', () => {
    const t = task({ note_ids: ['note-1'] })
    const base = [note(), t, plan()]
    const scope = scopeOf(base, ['task-1'])
    const extra = plan({ id: 'plan-2' })
    expect(codeOf(() => cascadeDeleteNotePlan([...base, extra], 'note-1', [], scope))).toBe('SCOPE_CHANGED')
    expect(codeOf(() => cascadeDeleteNotePlan([note(), t, plan({ state: 'partial' })], 'note-1', [], scope))).toBe('SCOPE_CHANGED')
  })
  it('范围一致 → 正常删除，info.planScope 提供处置事实供 UI 展示', () => {
    const base = [task(), plan()]
    const scope = scopeOf(base, ['task-1'])
    const r = deleteTaskPlan(base, 'task-1', [], scope)
    expect(r.deletes).toEqual(['task-1', 'plan-1'])
    expect(r.info.planScope).toEqual([{ id: 'plan-1', state: 'planned', taskRefState: 'active', disposition: 'remove' }])
    const n = cascadeDeleteNotePlan([note(), task({ note_ids: ['note-1'] }), plan()], 'note-1', [], scope)
    expect(n.deletes).toContain('note-1')
    expect(n.deletes).toContain('plan-1')
    expect(n.info.planScope).toHaveLength(1)
  })
  it('旧调用（无计划字段）兼容保留，但事务内历史保护不放松', () => {
    const legacy = { taskIds: ['task-1'], actionIds: [] }
    const withEnded = [task(), plan(), session()]
    expect(codeOf(() => deleteTaskPlan(withEnded, 'task-1', [session()], legacy))).toBe('PLAN_PROGRESS_REQUIRED')
    const run = session({ ended_at: null, running: true })
    expect(codeOf(() => deleteTaskPlan([task(), plan(), run], 'task-1', [run], legacy))).toBe('RELATION_INVALID')
    // 无 scope 的更早调用同样保留保护。
    expect(codeOf(() => deleteTaskPlan(withEnded, 'task-1', [session()]))).toBe('PLAN_PROGRESS_REQUIRED')
  })
})

describe('R3 快照必需字段：空对象/数组/缺字段一律拒绝，四入口一致', () => {
  for (const [name, mk] of Object.entries(CMDS)) {
    it(`${name}：完整六字段快照正常；空/数组/字符串快照拒绝`, () => {
      const p = plan()
      const latest = [task(), p]
      const ok = mk(p)
      expect(ok.fn(latest, env(), ok.input).puts.length).toBeGreaterThan(0)
      for (const bad of [{}, [], null, 'x']) {
        expect(codeOf(() => ok.fn(latest, env(), { ...ok.input, expected: bad }))).toBe('STALE_PLAN')
      }
    })
    it(`${name}：逐字段缺失拒绝；task_ref_state 缺省按 active 规范化`, () => {
      const p = plan()
      const latest = [task(), p]
      const mk0 = CMDS[name]
      for (const f of ['task_id', 'date', 'state', 'action_text', 'planned_minutes']) {
        const missing = snap(p)
        delete missing[f]
        expect(codeOf(() => mk0(p).fn(latest, env(), { ...mk0(p).input, expected: missing }))).toBe('STALE_PLAN')
      }
      const noRef = snap(p)
      delete noRef.task_ref_state
      const r = mk0(p).fn(latest, env(), { ...mk0(p).input, expected: noRef })
      expect(r.puts.length + (r.info.unchanged ? 1 : 0)).toBeGreaterThan(0)
    })
    it(`${name}：陈旧字段值 → STALE_PLAN，不覆盖其它页面新事实`, () => {
      const p = plan({ action_text: '其它页面最新说明' })
      const stale = { ...snap(p), action_text: '旧说明' }
      const mk0 = CMDS[name]
      expect(codeOf(() => mk0(p).fn([task(), p], env(), { ...mk0(p).input, expected: stale }))).toBe('STALE_PLAN')
    })
  }
})

describe('R4 变更统一重查 Task：已完成/缺失/跨空间一律拒绝，同日无操作也不例外', () => {
  const variants = [
    ['已完成', [task({ status: 'done' }), plan()], 'TASK_DONE'],
    ['已删除', [plan()], 'RELATION_INVALID'],
    ['跨空间', [task({ workspace_id: 'ws-2' }), plan()], 'RELATION_INVALID'],
  ]
  for (const [label, docs, code] of variants) {
    for (const name of Object.keys(CMDS)) {
      it(`${name} × Task ${label} → ${code}，零写入`, () => {
        const mk = CMDS[name](plan())
        expect(codeOf(() => mk.fn(docs, env(), mk.input))).toBe(code)
      })
    }
  }
  it('同日改期无操作也先校验：Task 已完成 → TASK_DONE，而非 unchanged 成功', () => {
    const p = plan()
    expect(codeOf(() => movePlan([task({ status: 'done' }), p], env(), { planItemId: p.id, expected: snap(p), date: p.date }))).toBe('TASK_DONE')
  })
  it('Task 未完成时同日改期仍是无操作；活引用残留但 Task 缺失同样拒绝', () => {
    const p = plan()
    const r = movePlan([task(), p], env(), { planItemId: p.id, expected: snap(p), date: p.date })
    expect(r.puts).toEqual([])
    expect(r.info.unchanged).toBe(true)
    expect(codeOf(() => cancelPlan([p], env(), { planItemId: p.id, expected: snap(p), confirm: true }))).toBe('RELATION_INVALID')
  })
})

describe('R5 冲突顺序无关 + 缓存差异诊断：异常拒绝写入，合法差异确认后才修正', () => {
  it('同 ID 冲突整组排除：正反序结果一致，确认拒绝（HISTORY_UNRESOLVED）零写入', () => {
    const p = plan()
    const a = session({ id: 'dup', accumulated_ms: 60000 })
    const b = session({ id: 'dup', accumulated_ms: 120000 })
    const fwd = summarizePlanTime(p, [p, a, b])
    const rev = summarizePlanTime(p, [p, b, a])
    expect(JSON.stringify(fwd)).toBe(JSON.stringify(rev))
    expect(fwd.authoritative).toBe(false)
    expect(fwd.actualMinutes).toBeNull()
    expect(fwd.latestEndedSessionId).toBeNull()
    expect(codeOf(() => confirmProgressPlan([task(), p, a, b], env(), { planItemId: p.id, expected: snap(p), progress: 'done', historyConfirm: historySignature(fwd) }))).toBe('HISTORY_UNRESOLVED')
    expect(codeOf(() => cancelPlan([task(), p, a, b], env(), { planItemId: p.id, expected: snap(p), confirm: true, historyConfirm: historySignature(fwd) }))).toBe('HISTORY_UNRESOLVED')
  })
  it('缓存与明细不一致有明确诊断（分钟+快捷引用），只读不修库', () => {
    const p = plan({ actual_minutes: 999, focus_session_id: 'sess-1' })
    const s = session({ accumulated_ms: 60000 })
    const docs = [p, s]
    const before = JSON.stringify(docs)
    const r = summarizePlanTime(p, docs)
    expect(r.problems).toEqual([])
    expect(r.authoritative).toBe(true)
    expect(r.cacheMismatch).toEqual({ cachedActualMinutes: 999, computedActualMinutes: 1, cachedFocusSessionId: 'sess-1', computedFocusSessionId: 'sess-1' })
    expect(JSON.stringify(docs)).toBe(before)
    const wrongRef = summarizePlanTime(plan({ actual_minutes: 1, focus_session_id: 'ghost' }), [plan(), s])
    expect(wrongRef.cacheMismatch.cachedFocusSessionId).toBe('ghost')
    expect(wrongRef.cacheMismatch.computedFocusSessionId).toBe('sess-1')
  })
  it('缓存一致 → cacheMismatch=null；异常时不产出缓存诊断（权威不可用）', () => {
    const p = plan({ actual_minutes: 10, focus_session_id: 'sess-1' })
    expect(summarizePlanTime(p, [p, session()]).cacheMismatch).toBeNull()
    const bad = summarizePlanTime(p, [p, session({ accumulated_ms: -1 })])
    expect(bad.authoritative).toBe(false)
    expect(bad.cacheMismatch).toBeNull()
  })
  it('合法缓存差异：确认（回传权威摘要）后才修正；取消同口径', () => {
    const p = plan({ actual_minutes: 999, focus_session_id: 'ghost' })
    const s = session({ accumulated_ms: 60000 })
    const latest = [task(), p, s]
    const summary = summarizePlanTime(p, latest)
    expect(codeOf(() => confirmProgressPlan(latest, env(), { planItemId: p.id, expected: snap(p), progress: 'done' }))).toBe('HISTORY_UNCONFIRMED')
    const r = confirmProgressPlan(latest, env(), { planItemId: p.id, expected: snap(p), progress: 'done', historyConfirm: summary })
    expect(r.puts[0].actual_minutes).toBe(1)
    expect(r.puts[0].focus_session_id).toBe('sess-1')
    const c = cancelPlan(latest, env(), { planItemId: p.id, expected: snap(p), confirm: true, historyConfirm: summary })
    expect(c.puts[0].state).toBe('cancelled')
    expect(c.puts[0].actual_minutes).toBe(1)
    expect(c.puts[0].focus_session_id).toBe('sess-1')
  })
  it('正常多段汇总不受影响：权威可用、无诊断', () => {
    const p = plan()
    const docs = [p, session({ id: 's1', accumulated_ms: 1800000 }), session({ id: 's2', accumulated_ms: 600000, ended_at: '2026-11-23T11:00:00+08:00' })]
    const r = summarizePlanTime(p, docs)
    expect(r.authoritative).toBe(true)
    expect(r.actualMinutes).toBe(40)
    expect(r.latestEndedSessionId).toBe('s2')
    expect(r.problems).toEqual([])
  })
})

// —— 服务层回归：真实 Focus begin/end + 安排事务服务，fake-indexeddb + 注入时钟。——
const T0 = '2026-11-22T08:00:00.000Z'
const T0MS = Date.parse(T0)
let db, planSvc, focusMod, nowIso, ws, ridc, clock

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('@/services/storage/db')
  const mod = await import('@/services/plan/service')
  focusMod = await import('@/services/focus/service')
  nowIso = T0
  clock = T0
  ws = 'ws-review'
  ridc = 0
  db.configureWorkspace(ws)
  await db.putWorkspace({ id: ws, name: '复审虚构空间', is_demo: false })
  await db.putDoc({ id: 't1', kind: 'task', title: '写课程报告', status: 'todo', current_action_id: null, matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' }, created_at: T0, updated_at: T0 })
  await db.putDoc({ id: 'a1', kind: 'action', task_id: 't1', text: '写引言', minutes: 30, basis: 'user', done: false, created_at: T0 })
  await db.putDoc({ id: 'p1', kind: 'plan_item', task_id: 't1', date: '2026-11-23', planned_minutes: 30, action_text: '写引言', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active' })
  planSvc = mod.createPlanService({ getWorkspaceId: () => ws, wallNow: () => nowIso, newId: () => `rid-${++ridc}` })
})

const allDocs = async () => (await db.allDocs()).records
const planDoc = async (id = 'p1') => (await allDocs()).find((d) => d.id === id)
const snapDb = (p) => ({ task_id: p.task_id, date: p.date, state: p.state, action_text: p.action_text, planned_minutes: p.planned_minutes, task_ref_state: p.task_ref_state || 'active' })
const mkFocus = () => focusMod.createFocusService({
  getWorkspaceId: () => ws, ownerId: 'review-tab', wallNow: () => clock,
  newId: () => `fid-${++ridc}`, scheduler: { set: () => 1, clear: () => {} },
})

describe('R1 服务层：真实 Focus 结束时间（toISOString 小数秒）计入安排历史', () => {
  const cases = [
    ['非零小数秒 Z', '2026-11-22T08:00:10.123Z', 10123, 0, null],
    ['.000Z', '2026-11-22T08:00:10.000Z', 10000, 0, null],
    ['带偏移小数秒', '2026-11-22T16:00:10.123+08:00', 10123, 0, null],
    // 超过 60s 失联门槛的长会话按真实使用方式周期检查点（租约 30s/失联 60s 保护不在本单放宽）。
    ['超过一分钟', '2026-11-22T08:01:20.123Z', 80123, 1, ['2026-11-22T08:00:25.000Z', '2026-11-22T08:00:50.000Z', '2026-11-22T08:01:15.000Z']],
  ]
  for (const [label, endClock, ms, minutes, midClocks] of cases) {
    it(`${label}：end 落库 ${ms}ms → 汇总计入，确认进度须回传历史摘要后写入 ${minutes} 分钟`, async () => {
      const focus = mkFocus()
      // 5A-2A 适配：计划联动 begin/end 必须携带冻结快照与确认事实（T0=北京 2026-11-22）。
      const docs0 = await allDocs()
      const confirm = {
        expected: planSnapshot(docs0.find((d) => d.id === 'p1')),
        facts: beginFactsOf(docs0.find((d) => d.id === 't1'), docs0.find((d) => d.id === 'a1'), '2026-11-22'),
      }
      // 真实调用端协议：首次意图签发信封（issuedAtMs=当时时钟），重试复用。
      const begun = await focus.begin({ taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirm, requestId: 'f-b', issuedAtMs: T0MS })
      expect(begun.ok, JSON.stringify(begun)).toBe(true)
      let cpc = 0
      for (const mid of midClocks || []) {
        clock = mid
        const cp = await focus.checkpoint({ sessionId: begun.session_id, requestId: `f-c${++cpc}`, issuedAtMs: Date.parse(clock) })
        expect(cp.ok, JSON.stringify(cp)).toBe(true)
      }
      clock = endClock
      // 5A-2A：计划联动结束同事务写安排摘要（partial）；随后 confirmProgress 仍需历史确认。
      const ended = await focus.end({
        sessionId: begun.session_id, outcome: 'partial', draftMd: '虚构成果',
        planProgress: 'partial', expected: planSnapshot(await planDoc()), historyConfirm: null,
        requestId: 'f-e', issuedAtMs: Date.parse(clock),
      })
      expect(ended.ok, JSON.stringify(ended)).toBe(true)
      expect(ended.session.accumulated_ms).toBe(ms)
      expect(ended.session.ended_at).toBe(endClock) // 原文形状不改写
      focus.stop()
      const docs = await allDocs()
      const p = docs.find((d) => d.id === 'p1')
      const { summarizePlanTime: summarize } = await import('@/domains/plan')
      const summary = summarize(p, docs)
      expect(summary.problems).toEqual([])
      expect(summary.endedSessionCount).toBe(1)
      expect(summary.totalMs).toBe(ms)
      expect(summary.actualMinutes).toBe(minutes)
      expect(summary.latestEndedSessionId).toBe(begun.session_id)
      // 有历史必须确认：裸确认拒绝；回传权威摘要后写入正确缓存。
      const bare = await planSvc.confirmProgress({ planItemId: 'p1', expected: snapDb(p), progress: 'done' })
      expect(bare.ok).toBe(false)
      expect(bare.code).toBe('HISTORY_UNCONFIRMED')
      const ok = await planSvc.confirmProgress({ planItemId: 'p1', expected: snapDb(p), progress: 'done', historyConfirm: summary })
      expect(ok.ok).toBe(true)
      expect(ok.planItem.actual_minutes).toBe(minutes)
      expect(ok.planItem.focus_session_id).toBe(begun.session_id)
    })
  }
  it('导入历史 ended_at 为不带秒小数（HH:MM.fff+偏移）：30 分钟计入，确认进度事务写入', async () => {
    const stamp = '2026-11-22T16:00.123+08:00'
    await db.putDoc({
      id: 's-compat', kind: 'focus_session', task_id: 't1', action_id: 'a1', plan_item_id: 'p1',
      started_at: '2026-11-22T15:30:00+08:00', accumulated_ms: 1800000, running: false, draft_md: '虚构成果',
      outcome: 'partial', blocker: null, ended_at: stamp, record_version: 1, timer_anchor_at: null,
      task_ref_state: 'active', action_ref_state: 'active',
    })
    nowIso = '2026-11-22T09:00:00.000Z'
    const docs = await allDocs()
    const p = docs.find((d) => d.id === 'p1')
    const { summarizePlanTime: summarize } = await import('@/domains/plan')
    const summary = summarize(p, docs)
    expect(summary.authoritative).toBe(true)
    expect(summary.totalMs).toBe(1800000)
    expect(summary.actualMinutes).toBe(30)
    const bare = await planSvc.confirmProgress({ planItemId: 'p1', expected: snapDb(p), progress: 'done' })
    expect(bare.code).toBe('HISTORY_UNCONFIRMED')
    const ok = await planSvc.confirmProgress({ planItemId: 'p1', expected: snapDb(p), progress: 'done', historyConfirm: summary })
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(ok.planItem.actual_minutes).toBe(30)
    expect(ok.planItem.focus_session_id).toBe('s-compat')
    expect((await allDocs()).find((d) => d.id === 's-compat').ended_at).toBe(stamp)
  })
})

describe('R3/R4 服务层：空快照拒绝；Task 完成后旧成功可 replay、新意图拒绝', () => {
  it('edit expected={} → STALE_PLAN，其它页面文本不被覆盖', async () => {
    await db.putDoc({ ...(await planDoc()), action_text: '其它页面最新文本' })
    const r = await planSvc.edit({ planItemId: 'p1', expected: {}, actionText: '旧页面替换' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('STALE_PLAN')
    expect((await planDoc()).action_text).toBe('其它页面最新文本')
  })
  it('edit 成功后 Task 完成：同信封 replay 原事实；新编辑/取消/确认进度明确拒绝', async () => {
    const p = await planDoc()
    const input = { planItemId: 'p1', expected: snapDb(p), actionText: '第一次修改', requestId: 'req-e1', issuedAtMs: T0MS }
    const first = await planSvc.edit(input)
    expect(first.ok).toBe(true)
    await db.putDoc({ ...(await allDocs()).find((d) => d.id === 't1'), status: 'done' })
    const replay = await planSvc.edit(input)
    expect(replay.ok).toBe(true)
    expect(replay.replayed).toBe(true)
    const fresh = await planDoc()
    const next = await planSvc.edit({ planItemId: 'p1', expected: snapDb(fresh), actionText: '第二次修改', requestId: 'req-e2', issuedAtMs: T0MS })
    expect(next.ok).toBe(false)
    expect(next.code).toBe('TASK_DONE')
    const cancel = await planSvc.cancel({ planItemId: 'p1', expected: snapDb(fresh), confirm: true, requestId: 'req-c', issuedAtMs: T0MS })
    expect(cancel.code).toBe('TASK_DONE')
    const progress = await planSvc.confirmProgress({ planItemId: 'p1', expected: snapDb(fresh), progress: 'done', requestId: 'req-p', issuedAtMs: T0MS })
    expect(progress.code).toBe('TASK_DONE')
    expect((await planDoc()).action_text).toBe('第一次修改') // 新意图零写入
  })
})

describe('R5 服务层：异常历史拒绝权威写入；合法缓存差异确认后修正', () => {
  const sess = (over = {}) => ({
    id: 's1', kind: 'focus_session', task_id: 't1', action_id: 'a1', plan_item_id: 'p1',
    started_at: T0, accumulated_ms: 60000, running: false, draft_md: '', outcome: 'partial',
    blocker: null, ended_at: '2026-11-22T08:01:00.000Z', record_version: 1, timer_anchor_at: null,
    task_ref_state: 'active', action_ref_state: 'active', ...over,
  })
  it('库内异常记录（非法时长）：任何确认都拒绝（HISTORY_UNRESOLVED），安排原值保留', async () => {
    // 同 ID 冲突在单一 IDB 主键下不可共存，顺序无关性由域层用例覆盖；
    // 服务层用可落库的异常（负时长）验证「异常存在时拒绝权威写入」。
    await db.putDoc(sess({ accumulated_ms: -5 }))
    const p = await planDoc()
    const { summarizePlanTime: summarize } = await import('@/domains/plan')
    const docs = await allDocs()
    const summary = summarize(p, docs)
    expect(summary.authoritative).toBe(false)
    const r = await planSvc.confirmProgress({ planItemId: 'p1', expected: snapDb(p), progress: 'done', historyConfirm: summary })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('HISTORY_UNRESOLVED')
    const bare = await planSvc.confirmProgress({ planItemId: 'p1', expected: snapDb(p), progress: 'done' })
    expect(bare.code).toBe('HISTORY_UNRESOLVED')
    expect((await planDoc()).actual_minutes).toBeNull()
    expect((await planDoc()).state).toBe('planned')
  })
  it('缓存 999 分钟与明细 1 分钟不一致：摘要带诊断，确认后修正为权威值', async () => {
    await db.putDoc(sess())
    await db.putDoc({ ...(await planDoc()), actual_minutes: 999, focus_session_id: 's1' })
    const docs = await allDocs()
    const p = docs.find((d) => d.id === 'p1')
    const { summarizePlanTime: summarize } = await import('@/domains/plan')
    const summary = summarize(p, docs)
    expect(summary.cacheMismatch).toMatchObject({ cachedActualMinutes: 999, computedActualMinutes: 1 })
    const r = await planSvc.confirmProgress({ planItemId: 'p1', expected: snapDb(p), progress: 'partial', historyConfirm: summary })
    expect(r.ok).toBe(true)
    expect(r.planItem.actual_minutes).toBe(1)
    expect(r.planItem.focus_session_id).toBe('s1')
  })
})

describe('5A-1 §10 删除影响展示快照：处置单一来源 planDeleteScope，rows 只补展示字段', () => {
  const latest = [
    task(),
    plan({ id: 'p-r' }),
    plan({ id: 'p-h', state: 'done', actual_minutes: 25 }),
    plan({ id: 'p-b', date: '2026-11-21' }),
    plan({ id: 'p-u', date: '2026-11-22' }),
  ]
  const sessions = [
    session({ id: 's-end', plan_item_id: 'p-b' }),
    session({ id: 's-run', plan_item_id: 'p-u', ended_at: null, running: false }),
  ]
  it('planFacts/planItemIds 与 planDeleteScope 完全一致（不引入第二套规则）', () => {
    const facts = planDeleteScope(latest, ['task-1'], sessions)
    const snap = deleteImpactSnapshot(latest, ['task-1'], sessions)
    expect(snap.planFacts).toEqual(facts)
    expect(snap.planItemIds).toEqual(facts.map((f) => f.id))
  })
  it('rows 补日期/说明/未结束会话 ID，处置与事实逐条对应', () => {
    const { rows } = deleteImpactSnapshot(latest, ['task-1'], sessions)
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId['p-r']).toMatchObject({ date: '2026-11-23', text: '撰写正文', disposition: 'remove', unfinishedSessionId: null })
    expect(byId['p-h']).toMatchObject({ disposition: 'detach', unfinishedSessionId: null })
    expect(byId['p-b']).toMatchObject({ date: '2026-11-21', disposition: 'blocked_progress', unfinishedSessionId: null })
    expect(byId['p-u']).toMatchObject({ disposition: 'blocked_unfinished', unfinishedSessionId: 's-run' })
  })
  it('无安排 → 空 rows，确认框展示空态而非误报影响', () => {
    const snap = deleteImpactSnapshot([task()], ['task-1'], [])
    expect(snap).toEqual({ planItemIds: [], planFacts: [], rows: [] })
  })
})