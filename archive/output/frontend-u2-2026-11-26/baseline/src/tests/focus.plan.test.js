// 5A-2A 域层反例：计划联动 begin/end/legacyEnd 的资格、确认事实、原子写集与累计规则。
// 受控时钟（wallNow 注入；40s/90s 都是参数不真实等待）。协议依据：
// devlog/coordination/2026-11-23-阶段5A-2A本地协议与写集.md。
import { describe, expect, it } from 'vitest'
import {
  beginPlan, endPlan, pausePlan, legacyEndPlan, beginFactsOf, beginFactsDiff, BEGIN_FACT_FIELDS,
} from '../domains/focus'
import {
  planSnapshot, planSnapshotDiff, summarizePlanTime, historySignature,
} from '../domains/plan'
import { makeRunRecord, runId } from '../services/focus/runtime'

const T0 = '2026-11-20T10:00:00+08:00'
const T0MS = Date.parse(T0)
const at = (offsetMs) => new Date(T0MS + offsetMs).toISOString()
// 模块级 ID 计数器：同一测试内多段会话必须拿不同 ID（按 ID 去重累计的前提）。
let idCounter = 0
// 租约放宽到 10 分钟：本文件聚焦资格/累计，租约过期反例单独用默认参数。
const env = (over = {}) => ({
  ws: 'w1', wallNow: T0, ownerId: 'tab-1', newId: () => `id-${++idCounter}`, params: { LEASE_MS: 600_000 }, ...over,
})
const task = (over = {}) => ({
  id: 't1', kind: 'task', workspace_id: 'w1', title: '周五交报告', status: 'todo',
  current_action_id: null, matter_id: null, note_ids: [],
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
const v0Session = (over = {}) => ({
  id: 'old-1', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1',
  started_at: T0, accumulated_ms: 60000, running: true, draft_md: '旧草稿',
  outcome: null, blocker: null, ended_at: null, is_demo: false, ...over,
})

function apply(docs, runtime, plan) {
  const merge = (rows, puts, deletes) => {
    const del = new Set(deletes || [])
    const next = rows.filter((r) => !del.has(r.id))
    for (const p of puts || []) {
      const i = next.findIndex((r) => r.id === p.id)
      if (i >= 0) next[i] = p
      else next.push(p)
    }
    return next
  }
  return { docs: merge(docs, plan.puts, plan.deletes), runtime: merge(runtime, plan.runtimePuts, plan.runtimeDeletes) }
}
const codeOf = (fn) => { try { fn(); return null } catch (err) { return err.code || 'NO_CODE' } }
const errOf = (fn) => { try { fn(); return null } catch (err) { return err } }

const confirmOf = (docs, it = item(), over = {}) => ({
  expected: planSnapshot(it),
  facts: beginFactsOf(docs.find((d) => d.id === 't1'), docs.find((d) => d.id === 'a1'), '2026-11-20'),
  ...over,
})
// 标准开局：从安排开始（带完整确认输入）。
function startFromPlan(docs = [task(), action(), item()], runtime = [], e = env(), input = {}) {
  const plan = beginPlan(docs, runtime, e, { taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirmOf(docs), ...input })
  const state = apply(docs, runtime, plan)
  return { ...state, session: plan.info.session, id: plan.info.session.id, epoch: plan.info.runtime.epoch }
}
const endInput = (s, docs, over = {}) => ({
  sessionId: s.id, epoch: s.epoch, outcome: 'partial', draftMd: '成果', draftSeq: 1,
  planProgress: 'partial', expected: planSnapshot(docs.find((d) => d.id === 'p1')), historyConfirm: null, ...over,
})

describe('begin 计划联动：资格与确认事实', () => {
  it('完整确认 → 会话挂 plan_item_id；begin 不写 PlanItem（状态/摘要原样）', () => {
    const docs = [task(), action(), item()]
    const s = startFromPlan(docs)
    expect(s.session.plan_item_id).toBe('p1')
    expect(s.session.record_version).toBe(1)
    expect(s.docs.find((d) => d.id === 'p1')).toEqual(item())
    expect(s.docs.find((d) => d.id === 't1').status).toBe('doing')
  })
  it('缺 expected 或 facts → PLAN_CONFIRM_REQUIRED 零创建', () => {
    const docs = [task(), action(), item()]
    expect(codeOf(() => beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1', facts: confirmOf(docs).facts }))).toBe('PLAN_CONFIRM_REQUIRED')
    expect(codeOf(() => beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1', expected: planSnapshot(item()) }))).toBe('PLAN_CONFIRM_REQUIRED')
    expect(codeOf(() => beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1' }))).toBe('PLAN_CONFIRM_REQUIRED')
  })
  it('快照字段变化 → STALE_PLAN 带首差异；多字段差异可由 planSnapshotDiff 列全', () => {
    const docs = [task(), action(), item({ planned_minutes: 60, action_text: '另一页的说明' })]
    const err = errOf(() => beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirmOf([task(), action(), item()]) }))
    expect(err.code).toBe('STALE_PLAN')
    expect(err.field).toBe('action_text')
    const diffs = planSnapshotDiff(confirmOf([task(), action(), item()]).expected, planSnapshot(docs[2]))
    expect(diffs.map((d) => d.field)).toEqual(['action_text', 'planned_minutes'])
  })
  it('快照缺必需字段 → STALE_PLAN（空对象不能证明核对版本）', () => {
    const docs = [task(), action(), item()]
    expect(codeOf(() => beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1', expected: {}, facts: confirmOf(docs).facts }))).toBe('STALE_PLAN')
  })
  it('facts 多字段变化 → BEGIN_FACTS_CHANGED 列全部差异（行动文字/估时/任务状态/当前行动/截止）', () => {
    const base = [task(), action(), item()]
    const changed = [
      task({ status: 'blocked', current_action_id: 'a2', deadline: { value: '2026-11-28', precision: 'date' } }),
      action({ text: '换了行动文字', minutes: 45 }),
      item(),
    ]
    const err = errOf(() => beginPlan(changed, [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirmOf(base), confirmBlocked: true }))
    expect(err.code).toBe('BEGIN_FACTS_CHANGED')
    expect(err.diffs.map((d) => d.field).sort()).toEqual(['actionMinutes', 'actionText', 'deadlineValue', 'taskCurrentActionId', 'taskStatus'])
    expect(err.diffs.find((d) => d.field === 'actionText')).toMatchObject({ expected: '整理资料', current: '换了行动文字' })
  })
  it('facts.actionId 与输入行动不一致 → PLAN_CONFIRM_REQUIRED；不按文字绑定', () => {
    const docs = [task(), action(), action({ id: 'a2', text: '整理资料' }), item()]
    const facts = { ...confirmOf(docs).facts, actionId: 'a2' }
    expect(codeOf(() => beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1', expected: planSnapshot(item()), facts }))).toBe('PLAN_CONFIRM_REQUIRED')
    // 同名两条 Action：显式选 a2 且事实一致 → 会话挂 a2，绝不按 action_text 吸附
    const facts2 = beginFactsOf(docs[0], docs[2], '2026-11-20')
    const s = startFromPlan(docs, [], env(), { actionId: 'a2', facts: facts2 })
    expect(s.session.action_id).toBe('a2')
  })
  it('终态/断引用安排拒绝新开工作；已完成 Task/Action 拒绝', () => {
    for (const state of ['done', 'cancelled', 'moved']) {
      expect(codeOf(() => startFromPlan([task(), action(), item({ state })]))).toBe('PLAN_NOT_EXECUTABLE')
    }
    expect(codeOf(() => startFromPlan([task(), action(), item({ task_ref_state: 'deleted' })]))).toBe('PLAN_NOT_EXECUTABLE')
    expect(codeOf(() => startFromPlan([task({ status: 'done' }), action(), item()]))).toBe('RELATION_INVALID')
    expect(codeOf(() => startFromPlan([task(), action({ done: true }), item()]))).toBe('RELATION_INVALID')
  })
  it('blocked 任务未确认 → needsConfirmBlocked；显式确认后开始', () => {
    const docs = [task({ status: 'blocked' }), action(), item()]
    const facts = beginFactsOf(docs[0], docs[1], '2026-11-20')
    const err = errOf(() => beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1', expected: planSnapshot(item()), facts }))
    expect(err.code).toBe('RELATION_INVALID')
    expect(err.needsConfirmBlocked).toBe(true)
    const s = startFromPlan(docs, [], env(), { confirmBlocked: true, facts })
    expect(s.session.running).toBe(true)
  })
  it('非当日执行允许：安排日 11-25、今天 11-20 → 成功且安排日/截止不变，started_at=提交时钟', () => {
    const docs = [task(), action(), item({ date: '2026-11-25' })]
    const s = startFromPlan(docs, [], env(), { expected: planSnapshot(docs[2]) })
    expect(s.session.started_at).toBe(T0)
    expect(s.docs.find((d) => d.id === 'p1').date).toBe('2026-11-25')
    expect(s.docs.find((d) => d.id === 't1').deadline.value).toBe('2026-11-27')
  })
  it('跨北京午夜确认 → confirm_date 差异重新核对；不自动改期', () => {
    const docs = [task(), action(), item()]
    const e = env({ wallNow: '2026-11-21T00:00:01+08:00' })
    const err = errOf(() => beginPlan(docs, [], e, { taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirmOf(docs) }))
    expect(err.code).toBe('BEGIN_FACTS_CHANGED')
    expect(err.diffs).toEqual([{ field: 'confirmDate', expected: '2026-11-20', current: '2026-11-21' }])
    // 重新核对后成功：started_at 取提交时真实时钟
    const facts = beginFactsOf(docs[0], docs[1], '2026-11-21')
    const plan = beginPlan(docs, [], e, { taskId: 't1', actionId: 'a1', planItemId: 'p1', expected: planSnapshot(item()), facts })
    expect(plan.info.session.started_at).toBe('2026-11-21T00:00:01+08:00')
  })
  it('beginFactsOf/beginFactsDiff 单一来源：八字段、无变化空清单', () => {
    const f = beginFactsOf(task(), action(), '2026-11-20')
    expect(Object.keys(f)).toEqual(BEGIN_FACT_FIELDS)
    expect(beginFactsDiff(f, { ...f })).toEqual([])
    expect(beginFactsDiff(f, { ...f, actionMinutes: 40 })).toEqual([{ field: 'actionMinutes', expected: 25, current: 40 }])
  })
})

describe('begin 计划联动：同安排回到工作与互斥', () => {
  it('同安排已有运行会话 → PLAN_SESSION_EXISTS 稳定 ID、零创建、零 runtime 写入', () => {
    const s = startFromPlan()
    const before = s.docs.filter((d) => d.kind === 'focus_session').length
    const plan = beginPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirmOf(s.docs) })
    expect(plan.info.code).toBe('PLAN_SESSION_EXISTS')
    expect(plan.info.session.id).toBe(s.id)
    expect(plan.info.samePlan).toBe(true)
    expect(plan.puts).toEqual([])
    expect(plan.runtimePuts).toEqual([])
    expect(s.docs.filter((d) => d.kind === 'focus_session').length).toBe(before)
  })
  it('同安排暂停会话同样回到工作；即使安排事实已变也先返回真实会话', () => {
    const s = startFromPlan()
    const paused = apply(s.docs, s.runtime, pausePlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { sessionId: s.id, epoch: 1 }))
    const staleDocs = paused.docs.map((d) => (d.id === 'p1' ? { ...d, planned_minutes: 99 } : d))
    const plan = beginPlan(staleDocs, paused.runtime, env({ wallNow: at(2000) }), { taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirmOf(s.docs) })
    expect(plan.info.code).toBe('PLAN_SESSION_EXISTS')
    expect(plan.info.session.id).toBe(s.id)
    expect(plan.info.session.running).toBe(false)
  })
  it('同 Action 但另一安排的会话 → ALREADY_ACTIVE，不误挂本安排', () => {
    const docs = [task(), action(), item(), item({ id: 'p2', order: 2 })]
    const s = startFromPlan(docs, [], env(), { planItemId: 'p2', expected: planSnapshot(docs[3]) })
    const err = errOf(() => beginPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirmOf(s.docs) }))
    expect(err.code).toBe('ALREADY_ACTIVE')
    expect(err.session.id).toBe(s.id)
    expect(err.session.plan_item_id).toBe('p2')
  })
  it('跨空间运行互斥沿用：其它空间运行中 → ALREADY_ACTIVE', () => {
    const docs = [task(), action(), item()]
    const runtime = [makeRunRecord('w2', 'other-sess', T0MS)]
    expect(codeOf(() => beginPlan(docs, runtime, env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1', ...confirmOf(docs) }))).toBe('ALREADY_ACTIVE')
  })
})

describe('end 计划联动：双结果独立与原子写集', () => {
  it('六种 outcome×planProgress 组合独立落库；Task 不自动 done；blocked 卡点必填', () => {
    for (const outcome of ['done', 'partial', 'blocked']) {
      for (const planProgress of ['partial', 'done']) {
        const s = startFromPlan()
        const plan = endPlan(s.docs, s.runtime, env({ wallNow: at(40_000) }), endInput(s, s.docs, {
          outcome, planProgress, blocker: outcome === 'blocked' ? '等同学回资料' : null,
        }))
        expect(plan.info.session.outcome).toBe(outcome)
        expect(plan.info.planItem.state).toBe(planProgress)
        expect(plan.info.session.ended_at).toBe(at(40_000))
        const a = plan.puts.find((d) => d.id === 'a1')
        expect(a ? a.done : false).toBe(outcome === 'done')
        const t = plan.puts.find((d) => d.id === 't1')
        expect(t ? t.status : s.docs.find((d) => d.id === 't1').status).not.toBe('done')
        if (outcome === 'blocked') expect(plan.info.session.blocker).toBe('等同学回资料')
        // 一次写集包含会话+安排；Action/Task 只在 outcome=done 时出现
        expect(plan.puts.some((d) => d.id === s.id)).toBe(true)
        expect(plan.puts.some((d) => d.id === 'p1')).toBe(true)
        expect(plan.puts.some((d) => d.id === 'a1')).toBe(outcome === 'done')
        expect(plan.puts.some((d) => d.id === 't1')).toBe(outcome === 'done')
      }
    }
    const s = startFromPlan()
    expect(codeOf(() => endPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), endInput(s, s.docs, { outcome: 'blocked', blocker: '  ' })))).toBe('RELATION_INVALID')
  })
  it('缺 planProgress/expected → PLAN_CONFIRM_REQUIRED；非法值 → INVALID_FIELD；零写入', () => {
    const s = startFromPlan()
    const e = env({ wallNow: at(1000) })
    expect(codeOf(() => endPlan(s.docs, s.runtime, e, endInput(s, s.docs, { planProgress: null })))).toBe('PLAN_CONFIRM_REQUIRED')
    expect(codeOf(() => endPlan(s.docs, s.runtime, e, endInput(s, s.docs, { expected: null })))).toBe('PLAN_CONFIRM_REQUIRED')
    expect(codeOf(() => endPlan(s.docs, s.runtime, e, endInput(s, s.docs, { planProgress: 'done ' })))).toBe('INVALID_FIELD')
    expect(s.docs.find((d) => d.id === s.id).ended_at).toBeNull()
  })
  it('end 禁止改挂安排：输入带 planItemId 一律拒绝', () => {
    const s = startFromPlan()
    expect(codeOf(() => endPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), endInput(s, s.docs, { planItemId: 'p2' })))).toBe('RELATION_INVALID')
    const plain = beginPlan([task(), action()], [], env(), { taskId: 't1', actionId: 'a1' })
    const st = apply([task(), action()], [], plain)
    expect(codeOf(() => endPlan(st.docs, st.runtime, env({ wallNow: at(1000) }), { sessionId: plain.info.session.id, epoch: 1, outcome: 'partial', draftMd: 'x', draftSeq: 1, planItemId: 'p1' }))).toBe('RELATION_INVALID')
  })
  it('独立会话带计划参数 → PLAN_LINK_INVALID；不带则原路径不生成 PlanItem', () => {
    const plain = beginPlan([task(), action()], [], env(), { taskId: 't1', actionId: 'a1' })
    const st = apply([task(), action()], [], plain)
    const e = env({ wallNow: at(1000) })
    const base = { sessionId: plain.info.session.id, epoch: 1, outcome: 'partial', draftMd: 'x', draftSeq: 1 }
    expect(codeOf(() => endPlan(st.docs, st.runtime, e, { ...base, planProgress: 'done' }))).toBe('PLAN_LINK_INVALID')
    const ok = endPlan(st.docs, st.runtime, e, base)
    expect(ok.info.planItem).toBeNull()
    expect(ok.puts.some((d) => d.kind === 'plan_item')).toBe(false)
  })
  it('安排快照变化 → STALE_PLAN 零写入（会话仍运行）', () => {
    const s = startFromPlan()
    const changed = s.docs.map((d) => (d.id === 'p1' ? { ...d, planned_minutes: 90 } : d))
    const err = errOf(() => endPlan(changed, s.runtime, env({ wallNow: at(1000) }), endInput(s, s.docs)))
    expect(err.code).toBe('STALE_PLAN')
    expect(err.field).toBe('planned_minutes')
    expect(changed.find((d) => d.id === s.id).ended_at).toBeNull()
  })
  it('安排缺失/跨任务/终态/断引用 → 可读拒绝，不静默拆分保存', () => {
    const s = startFromPlan()
    const e = env({ wallNow: at(1000) })
    const without = s.docs.filter((d) => d.id !== 'p1')
    expect(codeOf(() => endPlan(without, s.runtime, e, endInput(s, s.docs)))).toBe('RELATION_INVALID')
    const cross = s.docs.map((d) => (d.id === 'p1' ? { ...d, task_id: 't2' } : d))
    expect(codeOf(() => endPlan(cross, s.runtime, e, endInput(s, s.docs)))).toBe('RELATION_INVALID')
    for (const state of ['done', 'cancelled', 'moved']) {
      const terminal = s.docs.map((d) => (d.id === 'p1' ? { ...d, state } : d))
      expect(codeOf(() => endPlan(terminal, s.runtime, e, endInput(s, s.docs)))).toBe('PLAN_NOT_EXECUTABLE')
    }
    const deleted = s.docs.map((d) => (d.id === 'p1' ? { ...d, task_ref_state: 'deleted' } : d))
    expect(codeOf(() => endPlan(deleted, s.runtime, e, endInput(s, s.docs)))).toBe('PLAN_NOT_EXECUTABLE')
  })
  it('恢复待核对优先：异常时段 → RECOVERY_REQUIRED 只写恢复元数据，不写结束/Action/安排', () => {
    const s = startFromPlan()
    const plan = endPlan(s.docs, s.runtime, env({ wallNow: at(90_000), params: {} }), endInput(s, s.docs))
    expect(plan.info.code).toBe('RECOVERY_REQUIRED')
    expect(plan.puts).toEqual([])
    expect(plan.runtimePuts).toHaveLength(1)
    expect(plan.runtimePuts[0].recovery.reason).toBe('stale_gap')
    expect(plan.runtimePuts[0].ended).toBe(false)
  })
  it('租约过期优先于计划写入：OWNER_CONFLICT leaseExpired，安排零写入', () => {
    const s = startFromPlan([task(), action(), item()], [], env({ params: {} }))
    const err = errOf(() => endPlan(s.docs, s.runtime, env({ wallNow: at(40_000), params: {} }), endInput(s, s.docs)))
    expect(err.code).toBe('OWNER_CONFLICT')
    expect(err.leaseExpired).toBe(true)
  })
})

describe('end 计划联动：历史核对与累计（5A-0 规则沿用）', () => {
  // 第一段 40s 结束（partial），返回最新 docs/runtime 与安排。
  function firstSegment() {
    const s = startFromPlan()
    const plan = endPlan(s.docs, s.runtime, env({ wallNow: at(40_000) }), endInput(s, s.docs))
    const st = apply(s.docs, s.runtime, plan)
    return { ...st, firstId: s.id }
  }
  it('两段各 40s → 80s → actual_minutes 1；快捷引用指向最近已结束会话', () => {
    const f = firstSegment()
    expect(f.docs.find((d) => d.id === 'p1').actual_minutes).toBe(0)
    expect(f.docs.find((d) => d.id === 'p1').focus_session_id).toBe(f.firstId)
    const s2 = startFromPlan(f.docs, f.runtime, env({ wallNow: at(100_000) }), { expected: planSnapshot(f.docs.find((d) => d.id === 'p1')) })
    const hist = historySignature(summarizePlanTime(f.docs.find((d) => d.id === 'p1'), f.docs))
    const plan = endPlan(s2.docs, s2.runtime, env({ wallNow: at(140_000) }), endInput(s2, s2.docs, { historyConfirm: hist }))
    expect(plan.info.planItem.actual_minutes).toBe(1)
    expect(plan.info.planItem.focus_session_id).toBe(s2.id)
    expect(plan.info.history.totalMs).toBe(80_000)
    expect(plan.info.history.endedSessionCount).toBe(2)
  })
  it('零时长结束 → 0（有记录不足一分钟），不是 null', () => {
    const s = startFromPlan()
    const plan = endPlan(s.docs, s.runtime, env({ wallNow: at(0) }), endInput(s, s.docs))
    expect(plan.info.planItem.actual_minutes).toBe(0)
    expect(plan.info.history.totalMs).toBe(0)
  })
  it('历史摘要变化 → HISTORY_CHANGED 零写入；修正后重试全量重算不重复累计', () => {
    const f = firstSegment()
    const s2 = startFromPlan(f.docs, f.runtime, env({ wallNow: at(100_000) }), { expected: planSnapshot(f.docs.find((d) => d.id === 'p1')) })
    const wrong = { ...historySignature(summarizePlanTime(f.docs.find((d) => d.id === 'p1'), f.docs)), totalMs: 40_001 }
    const e2 = env({ wallNow: at(140_000) })
    const err = errOf(() => endPlan(s2.docs, s2.runtime, e2, endInput(s2, s2.docs, { historyConfirm: wrong })))
    expect(err.code).toBe('HISTORY_CHANGED')
    expect(err.current.totalMs).toBe(40_000)
    expect(s2.docs.find((d) => d.id === s2.id).ended_at).toBeNull()
    const good = historySignature(summarizePlanTime(f.docs.find((d) => d.id === 'p1'), f.docs))
    const plan = endPlan(s2.docs, s2.runtime, e2, endInput(s2, s2.docs, { historyConfirm: good }))
    expect(plan.info.planItem.actual_minutes).toBe(1)
    expect(plan.info.history.totalMs).toBe(80_000)
  })
  it('有历史缺确认 → HISTORY_UNCONFIRMED；无历史却带确认 → HISTORY_CHANGED', () => {
    const f = firstSegment()
    const s2 = startFromPlan(f.docs, f.runtime, env({ wallNow: at(100_000) }), { expected: planSnapshot(f.docs.find((d) => d.id === 'p1')) })
    expect(codeOf(() => endPlan(s2.docs, s2.runtime, env({ wallNow: at(140_000) }), endInput(s2, s2.docs, { historyConfirm: null })))).toBe('HISTORY_UNCONFIRMED')
    const s = startFromPlan()
    const fake = { endedSessionIds: ['ghost'], totalMs: 60000, actualMinutes: 1, latestEndedSessionId: 'ghost' }
    expect(codeOf(() => endPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), endInput(s, s.docs, { historyConfirm: fake })))).toBe('HISTORY_CHANGED')
  })
  it('异常历史（非法时长）→ HISTORY_UNRESOLVED 零写入，不当零分钟不自动修历史', () => {
    const s = startFromPlan()
    const bad = {
      id: 'bad-1', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1', plan_item_id: 'p1',
      started_at: T0, accumulated_ms: -5, running: false, draft_md: '', outcome: 'partial', blocker: null,
      ended_at: at(1000), is_demo: false, record_version: 1,
    }
    const docs = [...s.docs, bad]
    const err = errOf(() => endPlan(docs, s.runtime, env({ wallNow: at(2000) }), endInput(s, docs)))
    expect(err.code).toBe('HISTORY_UNRESOLVED')
    expect(err.problems).toEqual([{ code: 'INVALID_DURATION', sessionId: 'bad-1', accumulatedMs: -5 }])
    expect(docs.find((d) => d.id === s.id).ended_at).toBeNull()
    expect(docs.find((d) => d.id === 'p1').actual_minutes).toBeNull()
  })
  it('同刻结束按 ID 稳定决胜；运行会话不进快捷引用', () => {
    const s = startFromPlan()
    const prev = {
      id: 'z-prev', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1', plan_item_id: 'p1',
      started_at: T0, accumulated_ms: 30000, running: false, draft_md: '', outcome: 'partial', blocker: null,
      ended_at: at(40_000), is_demo: false, record_version: 1,
    }
    const docs = [...s.docs, prev]
    const hist = historySignature(summarizePlanTime(docs.find((d) => d.id === 'p1'), docs))
    const plan = endPlan(docs, s.runtime, env({ wallNow: at(40_000) }), endInput(s, docs, { historyConfirm: hist }))
    expect(plan.info.planItem.focus_session_id).toBe('z-prev')
    expect(plan.info.history.totalMs).toBe(70_000)
  })
  it('done 安排也写真实摘要；取消不删除已投入（历史会话仍在）', () => {
    const s = startFromPlan()
    const plan = endPlan(s.docs, s.runtime, env({ wallNow: at(40_000) }), endInput(s, s.docs, { planProgress: 'done' }))
    expect(plan.info.planItem.state).toBe('done')
    expect(plan.info.planItem.actual_minutes).toBe(0)
    const st = apply(s.docs, s.runtime, plan)
    expect(st.docs.filter((d) => d.kind === 'focus_session' && d.plan_item_id === 'p1')).toHaveLength(1)
  })
})

// —— 5A-2A 人工复审 R3 整改：新建会话前的历史前置核对（开工单§3.1）——
// 反例来源：planned+合法结束历史直接新开、异常历史(-1)开工后到 end 才 HISTORY_UNRESOLVED。
describe('begin 计划联动：新建前历史前置核对（R3 整改）', () => {
  const endedSession = (over = {}) => ({
    id: 'prev-1', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1', plan_item_id: 'p1',
    started_at: T0, accumulated_ms: 60000, running: false, draft_md: '', outcome: 'partial', blocker: null,
    ended_at: at(60_000), is_demo: false, record_version: 1, ...over,
  })
  const beginInput = (docs, over = {}) => ({
    taskId: 't1', actionId: 'a1', planItemId: 'p1',
    ...confirmOf(docs, docs.find((d) => d.id === 'p1')), ...over,
  })
  it('planned + 合法结束历史 → PLAN_REVIEW_REQUIRED 零创建，带完整历史摘要供人工核对', () => {
    const docs = [task(), action(), item(), endedSession()]
    const err = errOf(() => beginPlan(docs, [], env(), beginInput(docs)))
    expect(err.code).toBe('PLAN_REVIEW_REQUIRED')
    expect(err.history).toEqual(historySignature(summarizePlanTime(docs[2], docs)))
    expect(err.history.endedSessionIds).toEqual(['prev-1'])
    expect(docs.filter((d) => d.kind === 'focus_session')).toHaveLength(1)
    // 不自动改旧状态、不清摘要、不重写历史
    expect(docs.find((d) => d.id === 'p1')).toEqual(item())
    expect(docs.find((d) => d.id === 'prev-1')).toEqual(endedSession())
  })
  it('planned/partial + 异常历史（accumulated_ms=-1）→ HISTORY_UNRESOLVED 零创建，异常详情前移', () => {
    for (const state of ['planned', 'partial']) {
      const docs = [task(), action(), item({ state }), endedSession({ accumulated_ms: -1 })]
      const err = errOf(() => beginPlan(docs, [], env(), beginInput(docs)))
      expect(err.code).toBe('HISTORY_UNRESOLVED')
      expect(err.problems).toEqual([{ code: 'INVALID_DURATION', sessionId: 'prev-1', accumulatedMs: -1 }])
      expect(docs.filter((d) => d.kind === 'focus_session')).toHaveLength(1)
    }
  })
  it('异常历史含非法结束时刻同样拦截；冲突同 ID 历史整组排除后仍非权威', () => {
    const badTime = [task(), action(), item(), endedSession({ ended_at: 'not-a-time' })]
    expect(codeOf(() => beginPlan(badTime, [], env(), beginInput(badTime)))).toBe('HISTORY_UNRESOLVED')
    const conflict = [task(), action(), item(), endedSession(), endedSession({ accumulated_ms: 61000 })]
    const err = errOf(() => beginPlan(conflict, [], env(), beginInput(conflict)))
    expect(err.code).toBe('HISTORY_UNRESOLVED')
    expect(err.problems).toEqual([{ code: 'CONFLICTING_SESSION', sessionId: 'prev-1' }])
  })
  it('partial + 合法权威历史 → 允许新段（多段执行不受前置核对影响）', () => {
    const docs = [task(), action(), item({ state: 'partial', actual_minutes: 1, focus_session_id: 'prev-1' }), endedSession()]
    const plan = beginPlan(docs, [], env(), beginInput(docs))
    expect(plan.info.session.plan_item_id).toBe('p1')
    expect(plan.info.session.running).toBe(true)
    expect(plan.info.code).toBeUndefined()
  })
  it('planned 无历史 → 正常开始；未结束会话优先回到工作，不被历史拦截遮蔽', () => {
    const clean = [task(), action(), item()]
    expect(beginPlan(clean, [], env(), beginInput(clean)).info.session.running).toBe(true)
    // 已有暂停会话 + 异常历史：仍返回稳定会话（回到工作是安全动作），零创建
    const s = startFromPlan()
    const paused = apply(s.docs, s.runtime, pausePlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { sessionId: s.id, epoch: 1 }))
    const withBad = [...paused.docs, endedSession({ accumulated_ms: -1 })]
    const plan = beginPlan(withBad, paused.runtime, env({ wallNow: at(2000) }), { taskId: 't1', actionId: 'a1', planItemId: 'p1' })
    expect(plan.info.code).toBe('PLAN_SESSION_EXISTS')
    expect(plan.info.session.id).toBe(s.id)
    expect(plan.puts).toEqual([])
    expect(plan.runtimePuts).toEqual([])
    // 已有运行会话 + planned 合法历史：同样优先回到工作
    const s2 = startFromPlan()
    const withGood = [...s2.docs, endedSession()]
    const plan2 = beginPlan(withGood, s2.runtime, env({ wallNow: at(2000) }), { taskId: 't1', actionId: 'a1', planItemId: 'p1' })
    expect(plan2.info.code).toBe('PLAN_SESSION_EXISTS')
    expect(plan2.info.session.id).toBe(s2.id)
  })
})

describe('legacyEnd v0 计划边界', () => {
  const legacyDocs = (over = {}) => [task(), action(), item(), v0Session({ plan_item_id: 'p1', ...over })]
  const legacyInput = (docs, over = {}) => ({
    sessionId: 'old-1', outcome: 'partial', planProgress: 'partial',
    expected: planSnapshot(docs.find((d) => d.id === 'p1')), historyConfirm: null, ...over,
  })
  it('有效活安排 + 显式结果 → 同一事务结束 v0 并更新安排；不升版本不补快照不触碰 Action', () => {
    const docs = legacyDocs()
    const plan = legacyEndPlan(docs, [makeRunRecord('w1', 'old-1', T0MS)], env({ wallNow: at(1000) }), legacyInput(docs))
    const ended = plan.info.session
    expect(ended.ended_at).toBe(at(1000))
    expect(ended.record_version).toBeUndefined()
    expect(ended.task_snapshot).toBeUndefined()
    expect(plan.info.planItem.state).toBe('partial')
    expect(plan.info.planItem.actual_minutes).toBe(1)
    expect(plan.info.planItem.focus_session_id).toBe('old-1')
    expect(plan.puts.some((d) => d.id === 'a1' || d.id === 't1')).toBe(false)
    expect(plan.runtimePuts.find((r) => r.id === runId('w1')).session_id).toBeNull()
  })
  it('有效活安排缺显式结果 → PLAN_CONFIRM_REQUIRED 零写入', () => {
    const docs = legacyDocs()
    expect(codeOf(() => legacyEndPlan(docs, [], env(), { sessionId: 'old-1', outcome: 'partial' }))).toBe('PLAN_CONFIRM_REQUIRED')
    expect(codeOf(() => legacyEndPlan(docs, [], env(), legacyInput(docs, { expected: null })))).toBe('PLAN_CONFIRM_REQUIRED')
    expect(docs.find((d) => d.id === 'old-1').ended_at).toBeNull()
  })
  it('有效活安排有已结束历史 → 必须核对摘要；异常历史拒绝', () => {
    const ended = {
      id: 'prev-1', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1', plan_item_id: 'p1',
      started_at: T0, accumulated_ms: 50000, running: false, draft_md: '', outcome: 'partial', blocker: null,
      ended_at: at(500), is_demo: false, record_version: 1,
    }
    const docs = [...legacyDocs(), ended]
    expect(codeOf(() => legacyEndPlan(docs, [], env(), legacyInput(docs)))).toBe('HISTORY_UNCONFIRMED')
    const hist = historySignature(summarizePlanTime(docs.find((d) => d.id === 'p1'), docs))
    const plan = legacyEndPlan(docs, [], env(), legacyInput(docs, { historyConfirm: hist }))
    expect(plan.info.planItem.actual_minutes).toBe(1)
    expect(plan.info.history.totalMs).toBe(110_000)
  })
  it('引用缺失/终态：不带计划参数保留原释放通路；带参数 → PLAN_LINK_INVALID', () => {
    for (const docs of [
      legacyDocs({ plan_item_id: 'gone' }),
      legacyDocs().map((d) => (d.id === 'p1' ? { ...d, state: 'done' } : d)),
      legacyDocs().map((d) => (d.id === 'p1' ? { ...d, task_ref_state: 'deleted' } : d)),
    ]) {
      const ok = legacyEndPlan(docs, [makeRunRecord('w1', 'old-1', T0MS)], env(), { sessionId: 'old-1', outcome: 'partial' })
      expect(ok.info.session.ended_at).toBe(T0)
      expect(ok.info.planItem).toBeNull()
      expect(codeOf(() => legacyEndPlan(docs, [], env(), legacyInput(docs)))).toBe('PLAN_LINK_INVALID')
    }
  })
  it('无安排 v0 带计划参数 → PLAN_LINK_INVALID；不带则原语义不变', () => {
    const docs = [task(), action(), v0Session()]
    expect(codeOf(() => legacyEndPlan(docs, [], env(), { sessionId: 'old-1', outcome: 'partial', planProgress: 'done' }))).toBe('PLAN_LINK_INVALID')
    const ok = legacyEndPlan(docs, [], env(), { sessionId: 'old-1', outcome: 'done' })
    expect(ok.info.session.outcome).toBe('done')
    expect(ok.puts.some((d) => d.kind === 'action')).toBe(false)
  })
})