// S2 纯规则单测：受控时钟（wallNow 注入，10s/30s/5min 都是参数不真实等待）。
// 覆盖状态机迁移、计时结算、快照、异常检测与恢复、接管、v0 遗留结束、保护谓词与关系补丁。
import { describe, expect, it } from 'vitest'
import {
  FOCUS_PARAMS, beginPlan, checkpointPlan, pausePlan, resumePlan, endPlan,
  saveDraftPlan, recoverPlan, takeoverPlan, legacyEndPlan, beginFactsOf,
  unfinishedSessionsFor, assertNoUnfinishedSession, refDeletePatches, refRestorePatches,
} from '../domains/focus'
import { planSnapshot } from '../domains/plan'
import { makeRunRecord, sessId, runId } from '../services/focus/runtime'

const T0 = '2026-11-20T10:00:00+08:00'
const T0MS = Date.parse(T0)
const at = (offsetMs) => new Date(T0MS + offsetMs).toISOString()
const env = (over = {}) => {
  let n = 0
  return { ws: 'w1', wallNow: T0, ownerId: 'tab-1', newId: () => `id-${++n}`, ...over }
}
const task = (over = {}) => ({
  id: 't1', kind: 'task', workspace_id: 'w1', title: '写课程报告', status: 'todo',
  current_action_id: null, matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' },
  created_at: T0, updated_at: T0, is_demo: false, ...over,
})
const action = (over = {}) => ({
  id: 'a1', kind: 'action', workspace_id: 'w1', task_id: 't1', text: '写引言一节',
  minutes: 30, basis: 'user', done: false, created_at: T0, ...over,
})
const v0Session = (over = {}) => ({
  id: 'old-1', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1',
  started_at: T0, accumulated_ms: 60000, running: true, draft_md: '旧草稿',
  outcome: null, blocker: null, ended_at: null, is_demo: false, ...over,
})

// 把 plan 结果合并回 docs/runtime，模拟事务提交后的最新状态。
function apply(docs, runtime, plan) {
  const merge = (rows, puts, deletes) => {
    const del = new Set(deletes)
    const next = rows.filter((r) => !del.has(r.id))
    for (const p of puts) {
      const i = next.findIndex((r) => r.id === p.id)
      if (i >= 0) next[i] = p
      else next.push(p)
    }
    return next
  }
  return { docs: merge(docs, plan.puts, plan.deletes), runtime: merge(runtime, plan.runtimePuts, plan.runtimeDeletes) }
}
const codeOf = (fn) => {
  try { fn(); return null } catch (err) { return err.code || 'NO_CODE' }
}
const errOf = (fn) => {
  try { fn(); return null } catch (err) { return err }
}

// 标准开局：begin → 返回最新 docs/runtime 与会话 id/epoch。
function begin(docs = [task(), action()], runtime = [], e = env(), input = {}) {
  const plan = beginPlan(docs, runtime, e, { taskId: 't1', actionId: 'a1', ...input })
  const state = apply(docs, runtime, plan)
  return { ...state, session: plan.info.session, epoch: plan.info.runtime.epoch, id: plan.info.session.id }
}

describe('begin：快照冻结与唯一性', () => {
  it('v1 形状完整：快照 captured_at=wallNow、引用 active、锚点=开始时刻、todo→doing', () => {
    const docs = [task({ deadline: { value: '2026-11-25', precision: 'date' } }), action(), { id: 'm1', kind: 'matter', workspace_id: 'w1', title: '课程 A', note_ids: [] }]
    const withMatter = [task({ matter_id: 'm1', deadline: { value: '2026-11-25', precision: 'date' } }), action(), docs[2]]
    const s = begin(withMatter)
    const f = s.session
    expect(f.record_version).toBe(1)
    expect(f.started_at).toBe(T0)
    expect(f.timer_anchor_at).toBe(T0)
    expect(f.accumulated_ms).toBe(0)
    expect(f.running).toBe(true)
    expect(f.plan_item_id).toBeNull()
    expect(f.task_ref_state).toBe('active')
    expect(f.action_ref_state).toBe('active')
    expect(f.task_snapshot).toEqual({ title: '写课程报告', matter_name: '课程 A', deadline_value: '2026-11-25', deadline_precision: 'date', captured_at: T0 })
    expect(f.action_snapshot).toEqual({ text: '写引言一节', minutes: 30, captured_at: T0 })
    const t = s.docs.find((d) => d.id === 't1')
    expect(t.status).toBe('doing')
    expect(t.current_action_id).toBe('a1')
    const rt = s.runtime.find((r) => r.id === sessId(f.id))
    expect(rt.epoch).toBe(1)
    expect(rt.owner_id).toBe('tab-1')
    expect(rt.lease_expires_at).toBe(T0MS + FOCUS_PARAMS.LEASE_MS)
    expect(rt.draft_seq).toBe(0)
    expect(s.runtime.find((r) => r.id === runId('w1')).session_id).toBe(f.id)
  })
  it('关系无效拒绝：任务/行动缺失、行动不属于任务、行动已完成、任务已完成', () => {
    expect(codeOf(() => beginPlan([], [], env(), { taskId: 't1', actionId: 'a1' }))).toBe('RELATION_INVALID')
    expect(codeOf(() => beginPlan([task()], [], env(), { taskId: 't1', actionId: 'a1' }))).toBe('RELATION_INVALID')
    expect(codeOf(() => beginPlan([task(), action({ task_id: 't2' })], [], env(), { taskId: 't1', actionId: 'a1' }))).toBe('RELATION_INVALID')
    expect(codeOf(() => beginPlan([task(), action({ done: true })], [], env(), { taskId: 't1', actionId: 'a1' }))).toBe('RELATION_INVALID')
    expect(codeOf(() => beginPlan([task({ status: 'done' }), action()], [], env(), { taskId: 't1', actionId: 'a1' }))).toBe('RELATION_INVALID')
  })
  it('blocked 任务需显式 confirmBlocked，确认后开始并转 doing', () => {
    const docs = [task({ status: 'blocked' }), action()]
    const err = errOf(() => beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1' }))
    expect(err.code).toBe('RELATION_INVALID')
    expect(err.needsConfirmBlocked).toBe(true)
    const s = begin(docs, [], env(), { confirmBlocked: true })
    expect(s.docs.find((d) => d.id === 't1').status).toBe('doing')
  })
  it('同空间已有未结束 v1（含暂停）→ ALREADY_ACTIVE 带已有会话，不自动结束', () => {
    const s = begin()
    const paused = apply(s.docs, s.runtime, pausePlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { sessionId: s.id, epoch: 1 }))
    for (const state of [s, paused]) {
      const err = errOf(() => beginPlan(state.docs, state.runtime, env({ wallNow: at(2000) }), { taskId: 't1', actionId: 'a1' }))
      expect(err.code).toBe('ALREADY_ACTIVE')
      expect(err.session.id).toBe(s.id)
    }
  })
  it('同空间 v0 未结束 → LEGACY_RECOVERY_REQUIRED', () => {
    const err = errOf(() => beginPlan([task(), action(), v0Session()], [], env(), { taskId: 't1', actionId: 'a1' }))
    expect(err.code).toBe('LEGACY_RECOVERY_REQUIRED')
    expect(err.session.id).toBe('old-1')
  })
  it('全库运行唯一：其它空间运行中拒绝；其它空间仅暂停则允许', () => {
    const otherRunning = [makeRunRecord('w2', 'other-sess', T0MS)]
    expect(codeOf(() => beginPlan([task(), action()], otherRunning, env(), { taskId: 't1', actionId: 'a1' }))).toBe('ALREADY_ACTIVE')
    const otherPaused = [makeRunRecord('w2', null, T0MS)]
    const s = begin([task(), action()], otherPaused)
    expect(s.session.running).toBe(true)
  })
  it('计划快捷引用：同任务条目可关联（5A-2A 起须携带快照与确认事实），跨任务/缺失拒绝', () => {
    const item = { id: 'p1', kind: 'plan_item', workspace_id: 'w1', task_id: 't1', date: '2026-11-20', planned_minutes: 30, action_text: '写引言一节', state: 'planned', order: 0 }
    const confirm = { expected: planSnapshot(item), facts: beginFactsOf(task(), action(), '2026-11-20') }
    const s = begin([task(), action(), item], [], env(), { planItemId: 'p1', ...confirm })
    expect(s.session.plan_item_id).toBe('p1')
    expect(codeOf(() => beginPlan([task(), action(), { ...item, task_id: 't2' }], [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'p1' }))).toBe('RELATION_INVALID')
    expect(codeOf(() => beginPlan([task(), action()], [], env(), { taskId: 't1', actionId: 'a1', planItemId: 'nope' }))).toBe('RELATION_INVALID')
  })
})

describe('计时结算：只算实际运行段', () => {
  it('检查点累加一次并移锚点，started_at 与草稿不动，revision+1 租约续期', () => {
    const s = begin()
    const plan = checkpointPlan(s.docs, s.runtime, env({ wallNow: at(10_000) }), { sessionId: s.id, epoch: 1 })
    const f = plan.info.session
    expect(f.accumulated_ms).toBe(10_000)
    expect(f.timer_anchor_at).toBe(at(10_000))
    expect(f.started_at).toBe(T0)
    expect(f.draft_md).toBe('')
    expect(plan.info.runtime.revision).toBe(2)
    expect(plan.info.runtime.lease_expires_at).toBe(T0MS + 10_000 + FOCUS_PARAMS.LEASE_MS)
    expect(plan.info.runtime.last_checkpoint_at).toBe(T0MS + 10_000)
  })
  it('暂停结算本段→释放运行位置但保留 owner/租约；暂停间隔不累计；继续后锚点重开', () => {
    const s = begin()
    const p1 = apply(s.docs, s.runtime, checkpointPlan(s.docs, s.runtime, env({ wallNow: at(10_000) }), { sessionId: s.id, epoch: 1 }))
    const p2 = apply(p1.docs, p1.runtime, pausePlan(p1.docs, p1.runtime, env({ wallNow: at(30_000) }), { sessionId: s.id, epoch: 1 }))
    const paused = p2.docs.find((d) => d.id === s.id)
    expect(paused.accumulated_ms).toBe(30_000)
    expect(paused.running).toBe(false)
    expect(paused.timer_anchor_at).toBeNull()
    expect(p2.runtime.find((r) => r.id === runId('w1')).session_id).toBeNull()
    const rt = p2.runtime.find((r) => r.id === sessId(s.id))
    expect(rt.owner_id).toBe('tab-1')
    expect(rt.lease_expires_at).toBeGreaterThan(T0MS + 30_000)
    // 暂停 1 小时后继续：租约已过期，须走受控重取（自我接管 epoch+1 → 恢复确认）再继续；
    // 累计不变、started_at 不变，暂停间隔不累计
    const tk = apply(p2.docs, p2.runtime, takeoverPlan(p2.docs, p2.runtime, env({ wallNow: at(3_630_000) }), { sessionId: s.id }))
    expect(tk.runtime.find((r) => r.id === sessId(s.id)).epoch).toBe(2)
    const rc = apply(tk.docs, tk.runtime, recoverPlan(tk.docs, tk.runtime, env({ wallNow: at(3_630_000) }), { sessionId: s.id, epoch: 2, mode: 'keep' }))
    const p3 = apply(rc.docs, rc.runtime, resumePlan(rc.docs, rc.runtime, env({ wallNow: at(3_630_000) }), { sessionId: s.id, epoch: 2 }))
    const resumed = p3.docs.find((d) => d.id === s.id)
    expect(resumed.accumulated_ms).toBe(30_000)
    expect(resumed.started_at).toBe(T0)
    expect(resumed.running).toBe(true)
    expect(resumed.timer_anchor_at).toBe(at(3_630_000))
    expect(p3.runtime.find((r) => r.id === runId('w1')).session_id).toBe(s.id)
    // 继续后再走 10s：只加这段
    const p4 = apply(p3.docs, p3.runtime, checkpointPlan(p3.docs, p3.runtime, env({ wallNow: at(3_640_000) }), { sessionId: s.id, epoch: 2 }))
    expect(p4.docs.find((d) => d.id === s.id).accumulated_ms).toBe(40_000)
  })
  it('重复暂停/继续是幂等空操作，不重复累计', () => {
    const s = begin()
    const p1 = apply(s.docs, s.runtime, pausePlan(s.docs, s.runtime, env({ wallNow: at(5000) }), { sessionId: s.id, epoch: 1 }))
    const p2 = apply(p1.docs, p1.runtime, pausePlan(p1.docs, p1.runtime, env({ wallNow: at(8000) }), { sessionId: s.id, epoch: 1 }))
    expect(p2.docs.find((d) => d.id === s.id).accumulated_ms).toBe(5000)
    const p3 = apply(p2.docs, p2.runtime, resumePlan(p2.docs, p2.runtime, env({ wallNow: at(9000) }), { sessionId: s.id, epoch: 1 }))
    const p4 = apply(p3.docs, p3.runtime, resumePlan(p3.docs, p3.runtime, env({ wallNow: at(9500) }), { sessionId: s.id, epoch: 1 }))
    expect(p4.docs.find((d) => d.id === s.id).timer_anchor_at).toBe(at(9000))
  })
  it('继续时关系失效拒绝 RELATION_INVALID；另有运行会话拒绝 ALREADY_ACTIVE', () => {
    const s = begin()
    const p = apply(s.docs, s.runtime, pausePlan(s.docs, s.runtime, env({ wallNow: at(5000) }), { sessionId: s.id, epoch: 1 }))
    const noAction = { docs: p.docs.filter((d) => d.id !== 'a1'), runtime: p.runtime }
    expect(codeOf(() => resumePlan(noAction.docs, noAction.runtime, env({ wallNow: at(6000) }), { sessionId: s.id, epoch: 1 }))).toBe('RELATION_INVALID')
    const doneAction = { docs: p.docs.map((d) => (d.id === 'a1' ? { ...d, done: true } : d)), runtime: p.runtime }
    expect(codeOf(() => resumePlan(doneAction.docs, doneAction.runtime, env({ wallNow: at(6000) }), { sessionId: s.id, epoch: 1 }))).toBe('RELATION_INVALID')
    const otherRunning = [...p.runtime.filter((r) => r.id !== runId('w1')), makeRunRecord('w2', 'other', T0MS)]
    expect(codeOf(() => resumePlan(p.docs, otherRunning, env({ wallNow: at(6000) }), { sessionId: s.id, epoch: 1 }))).toBe('ALREADY_ACTIVE')
  })
})

describe('结束：最终草稿+用时+结果一次提交', () => {
  it('done：结算+行动完成+清 current_action_id 同事务；任务不自动完成；释放运行位置', () => {
    const s = begin()
    const plan = endPlan(s.docs, s.runtime, env({ wallNow: at(20_000) }), { sessionId: s.id, epoch: 1, outcome: 'done', draftSeq: 1, draftMd: '## 成果\n引言完成' })
    const f = plan.info.session
    expect(f.accumulated_ms).toBe(20_000)
    expect(f.draft_md).toBe('## 成果\n引言完成')
    expect(f.outcome).toBe('done')
    expect(f.ended_at).toBe(at(20_000))
    expect(f.running).toBe(false)
    expect(f.timer_anchor_at).toBeNull()
    expect(plan.info.action.done).toBe(true)
    expect(plan.info.task.current_action_id).toBeNull()
    expect(plan.info.task.status).toBe('doing')
    const state = apply(s.docs, s.runtime, plan)
    expect(state.runtime.find((r) => r.id === runId('w1')).session_id).toBeNull()
    expect(state.runtime.find((r) => r.id === sessId(s.id)).ended).toBe(true)
    // 结束后再 begin 允许（已结束不占位）；原行动已完成，需另选新行动
    const again = beginPlan([...state.docs, action({ id: 'a2' })], state.runtime, env({ wallNow: at(30_000), newId: () => 'id-new' }), { taskId: 't1', actionId: 'a2' })
    expect(again.info.session.id).toBe('id-new')
    expect(again.info.session.action_id).toBe('a2')
    expect(again.info.session.started_at).toBe(at(30_000))
  })
  it('partial/blocked 不改 Action/Task；blocked 必须 blocker；非法 outcome/缺草稿拒绝', () => {
    const s = begin()
    const partial = endPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { sessionId: s.id, epoch: 1, outcome: 'partial', draftSeq: 1, draftMd: 'x' })
    expect(partial.info.action).toBeNull()
    expect(partial.info.task).toBeNull()
    expect(codeOf(() => endPlan(s.docs, s.runtime, env(), { sessionId: s.id, epoch: 1, outcome: 'blocked', draftMd: 'x', blocker: '  ' }))).toBe('RELATION_INVALID')
    const blocked = endPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { sessionId: s.id, epoch: 1, outcome: 'blocked', draftSeq: 1, draftMd: 'x', blocker: '等数据' })
    expect(blocked.info.session.blocker).toBe('等数据')
    expect(codeOf(() => endPlan(s.docs, s.runtime, env(), { sessionId: s.id, epoch: 1, outcome: 'finished', draftMd: 'x' }))).toBe('RELATION_INVALID')
    expect(codeOf(() => endPlan(s.docs, s.runtime, env(), { sessionId: s.id, epoch: 1, outcome: 'done' }))).toBe('RELATION_INVALID')
  })
  it('结束后旧保存/再结束一律 ALREADY_ENDED，不复活历史', () => {
    const s = begin()
    const p = apply(s.docs, s.runtime, endPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { sessionId: s.id, epoch: 1, outcome: 'partial', draftSeq: 1, draftMd: '最终' }))
    expect(codeOf(() => saveDraftPlan(p.docs, p.runtime, env({ wallNow: at(2000) }), { sessionId: s.id, epoch: 1, draftSeq: 1, draftMd: '迟到' }))).toBe('ALREADY_ENDED')
    expect(codeOf(() => endPlan(p.docs, p.runtime, env({ wallNow: at(2000) }), { sessionId: s.id, epoch: 1, outcome: 'done', draftMd: '改' }))).toBe('ALREADY_ENDED')
    expect(codeOf(() => checkpointPlan(p.docs, p.runtime, env({ wallNow: at(2000) }), { sessionId: s.id, epoch: 1 }))).toBe('ALREADY_ENDED')
    expect(p.docs.find((d) => d.id === s.id).draft_md).toBe('最终')
  })
})

describe('草稿序号：晚到旧序号不覆盖新正文', () => {
  it('递增序号保存并合并计时结算（同一 delta 只累加一次）', () => {
    const s = begin()
    const p1 = apply(s.docs, s.runtime, saveDraftPlan(s.docs, s.runtime, env({ wallNow: at(10_000) }), { sessionId: s.id, epoch: 1, draftSeq: 1, draftMd: '第一版' }))
    expect(p1.docs.find((d) => d.id === s.id).draft_md).toBe('第一版')
    expect(p1.docs.find((d) => d.id === s.id).accumulated_ms).toBe(10_000)
    expect(p1.runtime.find((r) => r.id === sessId(s.id)).draft_seq).toBe(1)
    const p2 = apply(p1.docs, p1.runtime, saveDraftPlan(p1.docs, p1.runtime, env({ wallNow: at(20_000) }), { sessionId: s.id, epoch: 1, draftSeq: 2, draftMd: '第二版' }))
    expect(p2.docs.find((d) => d.id === s.id).accumulated_ms).toBe(20_000)
    // 晚到的旧序号（含相等）拒绝
    const err = errOf(() => saveDraftPlan(p2.docs, p2.runtime, env({ wallNow: at(25_000) }), { sessionId: s.id, epoch: 1, draftSeq: 1, draftMd: '旧稿' }))
    expect(err.code).toBe('STALE_REVISION')
    expect(err.currentSeq).toBe(2)
    expect(codeOf(() => saveDraftPlan(p2.docs, p2.runtime, env({ wallNow: at(25_000) }), { sessionId: s.id, epoch: 1, draftSeq: 2, draftMd: '旧稿' }))).toBe('STALE_REVISION')
    expect(p2.docs.find((d) => d.id === s.id).draft_md).toBe('第二版')
  })
})

describe('异常检测与恢复：不自动计入离线间隔', () => {
  it('时钟回拨：delta<0 → RECOVERY_REQUIRED，pending_ms 如实为负，不结算', () => {
    const s = begin()
    const plan = checkpointPlan(s.docs, s.runtime, env({ wallNow: at(-5000) }), { sessionId: s.id, epoch: 1 })
    expect(plan.info.code).toBe('RECOVERY_REQUIRED')
    expect(plan.info.recovery.reason).toBe('clock_rollback')
    expect(plan.info.recovery.pending_ms).toBe(-5000)
    expect(plan.puts).toEqual([])
    const state = apply(s.docs, s.runtime, plan)
    expect(state.docs.find((d) => d.id === s.id).accumulated_ms).toBe(0)
    expect(state.runtime.find((r) => r.id === sessId(s.id)).recovery.reason).toBe('clock_rollback')
  })
  it('明显跳变：delta>5min → time_jump；阈值可注入', () => {
    const s = begin()
    const plan = checkpointPlan(s.docs, s.runtime, env({ wallNow: at(300_001) }), { sessionId: s.id, epoch: 1 })
    expect(plan.info.recovery.reason).toBe('time_jump')
    expect(plan.info.recovery.pending_ms).toBe(300_001)
    const small = begin([task(), action()], [], env({ params: { JUMP_THRESHOLD_MS: 5000 } }))
    const p2 = checkpointPlan(small.docs, small.runtime, env({ wallNow: at(6000), params: { JUMP_THRESHOLD_MS: 5000 } }), { sessionId: small.id, epoch: 1 })
    expect(p2.info.recovery.reason).toBe('time_jump')
  })
  it('失联间隔：距上次检查点>60s（即使本段 delta 很小）→ stale_gap', () => {
    const s = begin()
    // 锚点与检查点都在 65s 前被人为推进：模拟后台节流后唤醒，本段只走了 5s
    const f = { ...s.session, timer_anchor_at: at(65_000) }
    const docs = s.docs.map((d) => (d.id === s.id ? f : d))
    const rt = s.runtime.map((r) => (r.id === sessId(s.id) ? { ...r, last_checkpoint_at: T0MS } : r))
    const plan = checkpointPlan(docs, rt, env({ wallNow: at(70_000) }), { sessionId: s.id, epoch: 1 })
    expect(plan.info.recovery.reason).toBe('stale_gap')
    expect(plan.info.recovery.pending_ms).toBe(5000)
  })
  it('恢复前计时/保存/暂停/结束全部拒绝 RECOVERY_REQUIRED', () => {
    const s = begin()
    const p = apply(s.docs, s.runtime, checkpointPlan(s.docs, s.runtime, env({ wallNow: at(400_000) }), { sessionId: s.id, epoch: 1 }))
    const input = { sessionId: s.id, epoch: 1 }
    expect(codeOf(() => checkpointPlan(p.docs, p.runtime, env({ wallNow: at(401_000) }), input))).toBe('RECOVERY_REQUIRED')
    expect(codeOf(() => pausePlan(p.docs, p.runtime, env({ wallNow: at(401_000) }), input))).toBe('RECOVERY_REQUIRED')
    expect(codeOf(() => endPlan(p.docs, p.runtime, env({ wallNow: at(401_000) }), { ...input, outcome: 'done', draftMd: 'x' }))).toBe('RECOVERY_REQUIRED')
    expect(codeOf(() => saveDraftPlan(p.docs, p.runtime, env({ wallNow: at(401_000) }), { ...input, draftSeq: 1, draftMd: 'x' }))).toBe('RECOVERY_REQUIRED')
  })
  it('keep：保持已保存累计、新锚点，旧时段不二次计入', () => {
    const s = begin()
    const p1 = apply(s.docs, s.runtime, checkpointPlan(s.docs, s.runtime, env({ wallNow: at(10_000) }), { sessionId: s.id, epoch: 1 }))
    const p2 = apply(p1.docs, p1.runtime, checkpointPlan(p1.docs, p1.runtime, env({ wallNow: at(500_000) }), { sessionId: s.id, epoch: 1 }))
    const p3 = apply(p2.docs, p2.runtime, recoverPlan(p2.docs, p2.runtime, env({ wallNow: at(500_000) }), { sessionId: s.id, epoch: 1, mode: 'keep' }))
    const f = p3.docs.find((d) => d.id === s.id)
    expect(f.accumulated_ms).toBe(10_000)
    expect(f.timer_anchor_at).toBe(at(500_000))
    expect(p3.runtime.find((r) => r.id === sessId(s.id)).recovery).toBeNull()
    const p4 = apply(p3.docs, p3.runtime, checkpointPlan(p3.docs, p3.runtime, env({ wallNow: at(510_000) }), { sessionId: s.id, epoch: 1 }))
    expect(p4.docs.find((d) => d.id === s.id).accumulated_ms).toBe(20_000)
  })
  it('correct：用户修正总累计，origin=user 显式记录；非法值拒绝', () => {
    const s = begin()
    const p1 = apply(s.docs, s.runtime, checkpointPlan(s.docs, s.runtime, env({ wallNow: at(500_000) }), { sessionId: s.id, epoch: 1 }))
    expect(codeOf(() => recoverPlan(p1.docs, p1.runtime, env({ wallNow: at(500_000) }), { sessionId: s.id, epoch: 1, mode: 'correct', correctedMs: -1 }))).toBe('RELATION_INVALID')
    expect(codeOf(() => recoverPlan(p1.docs, p1.runtime, env({ wallNow: at(500_000) }), { sessionId: s.id, epoch: 1, mode: 'correct', correctedMs: 1.5 }))).toBe('RELATION_INVALID')
    const p2 = apply(p1.docs, p1.runtime, recoverPlan(p1.docs, p1.runtime, env({ wallNow: at(500_000) }), { sessionId: s.id, epoch: 1, mode: 'correct', correctedMs: 120_000 }))
    expect(p2.docs.find((d) => d.id === s.id).accumulated_ms).toBe(120_000)
    const rt = p2.runtime.find((r) => r.id === sessId(s.id))
    expect(rt.last_recovery).toMatchObject({ mode: 'correct', accumulated_ms: 120_000, origin: 'user' })
    expect(codeOf(() => recoverPlan(p2.docs, p2.runtime, env({ wallNow: at(501_000) }), { sessionId: s.id, epoch: 1, mode: 'keep' }))).toBe('RELATION_INVALID')
  })
})

describe('持有者与接管：owner/epoch/租约', () => {
  it('错误 owner 或 epoch → OWNER_CONFLICT', () => {
    const s = begin()
    expect(codeOf(() => checkpointPlan(s.docs, s.runtime, env({ wallNow: at(1000), ownerId: 'tab-2' }), { sessionId: s.id, epoch: 1 }))).toBe('OWNER_CONFLICT')
    expect(codeOf(() => checkpointPlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { sessionId: s.id, epoch: 2 }))).toBe('OWNER_CONFLICT')
  })
  it('租约有效期内其它页面接管被拒；过期接管 epoch+1 并进入恢复', () => {
    const s = begin()
    const within = env({ wallNow: at(FOCUS_PARAMS.LEASE_MS - 1), ownerId: 'tab-2' })
    const err = errOf(() => takeoverPlan(s.docs, s.runtime, within, { sessionId: s.id }))
    expect(err.code).toBe('OWNER_CONFLICT')
    const expired = env({ wallNow: at(FOCUS_PARAMS.LEASE_MS + 1), ownerId: 'tab-2' })
    const plan = takeoverPlan(s.docs, s.runtime, expired, { sessionId: s.id })
    const rt = plan.info.runtime
    expect(rt.owner_id).toBe('tab-2')
    expect(rt.epoch).toBe(2)
    expect(rt.recovery.reason).toBe('takeover')
    expect(plan.puts).toEqual([])
    const state = apply(s.docs, s.runtime, plan)
    // 旧 owner 之后一切操作因 epoch 失效拒绝
    expect(codeOf(() => checkpointPlan(state.docs, state.runtime, env({ wallNow: at(FOCUS_PARAMS.LEASE_MS + 2) }), { sessionId: s.id, epoch: 1 }))).toBe('OWNER_CONFLICT')
    expect(codeOf(() => saveDraftPlan(state.docs, state.runtime, env({ wallNow: at(FOCUS_PARAMS.LEASE_MS + 2) }), { sessionId: s.id, epoch: 1, draftSeq: 1, draftMd: 'x' }))).toBe('OWNER_CONFLICT')
    expect(codeOf(() => endPlan(state.docs, state.runtime, env({ wallNow: at(FOCUS_PARAMS.LEASE_MS + 2) }), { sessionId: s.id, epoch: 1, outcome: 'done', draftMd: 'x' }))).toBe('OWNER_CONFLICT')
    // 新 owner 先恢复再继续
    const rec = apply(state.docs, state.runtime, recoverPlan(state.docs, state.runtime, env({ wallNow: at(FOCUS_PARAMS.LEASE_MS + 2), ownerId: 'tab-2' }), { sessionId: s.id, epoch: 2, mode: 'keep' }))
    const cp = checkpointPlan(rec.docs, rec.runtime, env({ wallNow: at(FOCUS_PARAMS.LEASE_MS + 10_002), ownerId: 'tab-2' }), { sessionId: s.id, epoch: 2 })
    expect(cp.info.session.accumulated_ms).toBe(10_000)
  })
  it('租约时长可注入', () => {
    const s = begin([task(), action()], [], env({ params: { LEASE_MS: 1000 } }))
    const rt = s.runtime.find((r) => r.id === sessId(s.id))
    expect(rt.lease_expires_at).toBe(T0MS + 1000)
    const plan = takeoverPlan(s.docs, s.runtime, env({ wallNow: at(1001), ownerId: 'tab-2', params: { LEASE_MS: 1000 } }), { sessionId: s.id })
    expect(plan.info.runtime.epoch).toBe(2)
  })
})

describe('v0 遗留显式结束', () => {
  it('只更新 v0 已有字段，不补新字段；释放运行位置；随后可新开 v1', () => {
    const docs = [task(), action(), v0Session()]
    const runtime = [makeRunRecord('w1', 'old-1', T0MS)]
    const plan = legacyEndPlan(docs, runtime, env({ wallNow: at(1000) }), { sessionId: 'old-1', outcome: 'partial' })
    const f = plan.info.session
    expect(f.running).toBe(false)
    expect(f.outcome).toBe('partial')
    expect(f.ended_at).toBe(at(1000))
    expect(f.accumulated_ms).toBe(60000)
    expect(f.draft_md).toBe('旧草稿')
    expect('record_version' in f).toBe(false)
    expect('timer_anchor_at' in f).toBe(false)
    expect('task_snapshot' in f).toBe(false)
    expect('task_ref_state' in f).toBe(false)
    const state = apply(docs, runtime, plan)
    expect(state.runtime.find((r) => r.id === runId('w1')).session_id).toBeNull()
    const next = beginPlan(state.docs, state.runtime, env({ wallNow: at(2000) }), { taskId: 't1', actionId: 'a1' })
    expect(next.info.session.record_version).toBe(1)
  })
  it('确认累计可修正（非负整数）；blocked 需 blocker；v1 会话走此路径拒绝', () => {
    const docs = [task(), action(), v0Session()]
    const plan = legacyEndPlan(docs, [], env(), { sessionId: 'old-1', outcome: 'done', accumulatedMs: 90000 })
    expect(plan.info.session.accumulated_ms).toBe(90000)
    expect(codeOf(() => legacyEndPlan(docs, [], env(), { sessionId: 'old-1', outcome: 'done', accumulatedMs: -5 }))).toBe('RELATION_INVALID')
    expect(codeOf(() => legacyEndPlan(docs, [], env(), { sessionId: 'old-1', outcome: 'blocked' }))).toBe('RELATION_INVALID')
    const s = begin()
    expect(codeOf(() => legacyEndPlan(s.docs, s.runtime, env(), { sessionId: s.id, outcome: 'done' }))).toBe('RELATION_INVALID')
  })
  it('v0 未结束会话的常规操作一律 LEGACY_RECOVERY_REQUIRED', () => {
    const docs = [task(), action(), v0Session()]
    expect(codeOf(() => checkpointPlan(docs, [], env(), { sessionId: 'old-1', epoch: 1 }))).toBe('LEGACY_RECOVERY_REQUIRED')
    expect(codeOf(() => pausePlan(docs, [], env(), { sessionId: 'old-1', epoch: 1 }))).toBe('LEGACY_RECOVERY_REQUIRED')
    expect(codeOf(() => endPlan(docs, [], env(), { sessionId: 'old-1', epoch: 1, outcome: 'done', draftMd: 'x' }))).toBe('LEGACY_RECOVERY_REQUIRED')
  })
})

describe('S6 保护谓词与关系补丁', () => {
  const endedSession = (over = {}) => ({
    id: 'f-end', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1', plan_item_id: null,
    started_at: T0, accumulated_ms: 1000, running: false, draft_md: '成果', outcome: 'partial', blocker: null,
    ended_at: at(1000), is_demo: false, record_version: 1, timer_anchor_at: null,
    task_snapshot: { title: '写课程报告', matter_name: null, deadline_value: null, deadline_precision: 'none', captured_at: T0 },
    action_snapshot: { text: '写引言一节', minutes: 30, captured_at: T0 },
    task_ref_state: 'active', action_ref_state: 'active', ...over,
  })
  it('保护谓词：运行/暂停/v0 未结束命中（按任务或行动），已结束不命中', () => {
    const s = begin()
    expect(unfinishedSessionsFor(s.docs, { taskIds: ['t1'] })).toHaveLength(1)
    expect(unfinishedSessionsFor(s.docs, { actionIds: ['a1'] })).toHaveLength(1)
    expect(unfinishedSessionsFor(s.docs, { taskIds: ['t2'] })).toHaveLength(0)
    const p = apply(s.docs, s.runtime, pausePlan(s.docs, s.runtime, env({ wallNow: at(1000) }), { sessionId: s.id, epoch: 1 }))
    expect(unfinishedSessionsFor(p.docs, { taskIds: ['t1'] })).toHaveLength(1)
    expect(unfinishedSessionsFor([v0Session()], { actionIds: ['a1'] })).toHaveLength(1)
    expect(unfinishedSessionsFor([endedSession()], { taskIds: ['t1'], actionIds: ['a1'] })).toHaveLength(0)
    const err = errOf(() => assertNoUnfinishedSession(s.docs, { taskIds: ['t1'] }))
    expect(err.code).toBe('RELATION_INVALID')
    expect(err.sessions).toHaveLength(1)
    expect(() => assertNoUnfinishedSession([endedSession()], { taskIds: ['t1'] })).not.toThrow()
  })
  it('已结束会话逐引用断开：删任务→双引用 deleted；仅删行动→只动 action 引用；正文/累计/快照保留', () => {
    const docs = [endedSession()]
    const both = refDeletePatches(docs, { taskIds: ['t1'], actionIds: ['a1'] })
    expect(both.puts[0].task_ref_state).toBe('deleted')
    expect(both.puts[0].action_ref_state).toBe('deleted')
    expect(both.puts[0].draft_md).toBe('成果')
    expect(both.puts[0].accumulated_ms).toBe(1000)
    expect(both.puts[0].task_snapshot.title).toBe('写课程报告')
    expect(both.patches[0].changes.task_ref_state).toEqual({ from: 'active', to: 'deleted' })
    const onlyAction = refDeletePatches(docs, { actionIds: ['a1'] })
    expect(onlyAction.puts[0].task_ref_state).toBe('active')
    expect(onlyAction.puts[0].action_ref_state).toBe('deleted')
    // v0 已结束无引用字段，不动
    const v0Ended = { ...v0Session(), running: false, outcome: 'done', ended_at: at(1000) }
    expect(refDeletePatches([v0Ended], { taskIds: ['t1'], actionIds: ['a1'] }).puts).toEqual([])
  })
  it('撤销恢复：对象已恢复→回补 active；仍缺失→保持 deleted；会话被改过→拒绝该补丁', () => {
    const docs = [endedSession()]
    const { puts, patches } = refDeletePatches(docs, { taskIds: ['t1'], actionIds: ['a1'] })
    const deleted = puts
    // 对象都恢复
    const restored = refRestorePatches([...deleted, task(), action()], patches)
    expect(restored.puts[0].task_ref_state).toBe('active')
    expect(restored.puts[0].action_ref_state).toBe('active')
    expect(restored.refused).toEqual([])
    // 只恢复任务：action 引用保持 deleted
    const partial = refRestorePatches([...deleted, task()], patches)
    expect(partial.puts[0].task_ref_state).toBe('active')
    expect(partial.puts[0].action_ref_state).toBe('deleted')
    expect(partial.refused.some((r) => r.field === 'action_ref_state' && r.reason === 'still_missing')).toBe(true)
    // 会话在删除后被改过（引用字段已不是 deleted）→ 拒绝覆盖
    const changed = deleted.map((d) => ({ ...d, task_ref_state: 'active' }))
    const refused = refRestorePatches([...changed, task(), action()], patches)
    expect(refused.puts[0].task_ref_state).toBe('active')
    expect(refused.refused.some((r) => r.field === 'task_ref_state' && r.reason === 'changed')).toBe(true)
    // ended_at 变化 → 整条拒绝
    const endedChanged = deleted.map((d) => ({ ...d, ended_at: at(9999) }))
    expect(refRestorePatches([...endedChanged, task(), action()], patches).puts).toEqual([])
  })
})

describe('3B-1 复审 F1–F3 纯规则反例', () => {
  it('F1：expectedRevision 不匹配拒绝；结束缺序号/旧序号拒绝且不写正文', () => {
    const s = begin()
    const p1 = apply(s.docs, s.runtime, saveDraftPlan(s.docs, s.runtime, env({ wallNow: at(5000) }), { sessionId: s.id, epoch: 1, draftSeq: 2, draftMd: '新稿' }))
    const err = errOf(() => saveDraftPlan(p1.docs, p1.runtime, env({ wallNow: at(6000) }), { sessionId: s.id, epoch: 1, draftSeq: 3, expectedRevision: 1, draftMd: '基于旧修订' }))
    expect(err.code).toBe('STALE_REVISION')
    expect(err.currentRevision).toBe(2)
    expect(codeOf(() => endPlan(p1.docs, p1.runtime, env({ wallNow: at(6000) }), { sessionId: s.id, epoch: 1, outcome: 'done', draftMd: 'x' }))).toBe('RELATION_INVALID')
    expect(codeOf(() => endPlan(p1.docs, p1.runtime, env({ wallNow: at(6000) }), { sessionId: s.id, epoch: 1, outcome: 'done', draftSeq: 1, draftMd: '旧终稿' }))).toBe('STALE_REVISION')
    expect(p1.docs.find((d) => d.id === s.id).draft_md).toBe('新稿')
    const ok = endPlan(p1.docs, p1.runtime, env({ wallNow: at(6000) }), { sessionId: s.id, epoch: 1, outcome: 'partial', draftSeq: 3, draftMd: '合法终稿' })
    expect(ok.info.runtime.draft_seq).toBe(3)
    expect(ok.info.session.draft_md).toBe('合法终稿')
  })
  it('F2：env.allDocs 全库扫描——它空间 v0 运行/v1 运行（无 runtime）都挡；仅暂停放行', () => {
    const legacyOther = v0Session({ id: 'legacy-other', workspace_id: 'w2' })
    const err = errOf(() => beginPlan([task(), action()], [], env({ allDocs: [task(), action(), legacyOther] }), { taskId: 't1', actionId: 'a1' }))
    expect(err.code).toBe('LEGACY_RECOVERY_REQUIRED')
    expect(err.session.id).toBe('legacy-other')
    const v1Other = { ...legacyOther, id: 'v1-other', record_version: 1, timer_anchor_at: T0 }
    const err2 = errOf(() => beginPlan([task(), action()], [], env({ allDocs: [task(), action(), v1Other] }), { taskId: 't1', actionId: 'a1' }))
    expect(err2.code).toBe('ALREADY_ACTIVE')
    expect(err2.session.id).toBe('v1-other')
    const pausedOther = { ...v1Other, running: false, timer_anchor_at: null }
    const ok = beginPlan([task(), action()], [], env({ allDocs: [task(), action(), pausedOther] }), { taskId: 't1', actionId: 'a1' })
    expect(ok.info.session.running).toBe(true)
    // 继续同样受全库运行互斥约束
    const s = begin()
    const p = apply(s.docs, s.runtime, pausePlan(s.docs, s.runtime, env({ wallNow: at(5000) }), { sessionId: s.id, epoch: 1 }))
    expect(codeOf(() => resumePlan(p.docs, p.runtime, env({ wallNow: at(6000), allDocs: [...p.docs, v1Other] }), { sessionId: s.id, epoch: 1 }))).toBe('ALREADY_ACTIVE')
  })
  it('F3：租约过期正常写入拒绝 leaseExpired；异常时段仍先进恢复（不续租）；自我接管+恢复后可写', () => {
    const s = begin()
    const p1 = apply(s.docs, s.runtime, checkpointPlan(s.docs, s.runtime, env({ wallNow: at(10_000) }), { sessionId: s.id, epoch: 1 }))
    const late = env({ wallNow: at(45_000) })
    const err = errOf(() => checkpointPlan(p1.docs, p1.runtime, late, { sessionId: s.id, epoch: 1 }))
    expect(err.code).toBe('OWNER_CONFLICT')
    expect(err.leaseExpired).toBe(true)
    expect(codeOf(() => saveDraftPlan(p1.docs, p1.runtime, late, { sessionId: s.id, epoch: 1, draftSeq: 1, draftMd: 'x' }))).toBe('OWNER_CONFLICT')
    expect(codeOf(() => pausePlan(p1.docs, p1.runtime, late, { sessionId: s.id, epoch: 1 }))).toBe('OWNER_CONFLICT')
    expect(codeOf(() => endPlan(p1.docs, p1.runtime, late, { sessionId: s.id, epoch: 1, outcome: 'done', draftSeq: 1, draftMd: 'x' }))).toBe('OWNER_CONFLICT')
    // 异常时段（>5min 跳变）优先走恢复确认：不结算也不续租
    const jump = checkpointPlan(p1.docs, p1.runtime, env({ wallNow: at(400_000) }), { sessionId: s.id, epoch: 1 })
    expect(jump.info.code).toBe('RECOVERY_REQUIRED')
    expect(jump.info.runtime.lease_expires_at).toBe(T0MS + 40_000)
    // 受控重取：自我接管 epoch+1 → keep → 写入恢复
    const tk = apply(p1.docs, p1.runtime, takeoverPlan(p1.docs, p1.runtime, late, { sessionId: s.id }))
    expect(tk.runtime.find((r) => r.id === sessId(s.id)).epoch).toBe(2)
    const rc = apply(tk.docs, tk.runtime, recoverPlan(tk.docs, tk.runtime, env({ wallNow: at(46_000) }), { sessionId: s.id, epoch: 2, mode: 'keep' }))
    const cp = checkpointPlan(rc.docs, rc.runtime, env({ wallNow: at(56_000) }), { sessionId: s.id, epoch: 2 })
    expect(cp.info.session.accumulated_ms).toBe(20_000)
  })
})