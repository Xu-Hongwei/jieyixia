// 5B-1B 助手服务 + DB v4 单测（fake-indexeddb；真实浏览器证据另见 B1B 矩阵）。
// 覆盖：配对原子创建、完整基线并发、幂等重存、切空间、输入突变冻结、真实重排、
// 消息追加不丢、刷新结算、清空含 ops.application_id、v3→v4 迁移旧数据/Blob 不变。
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkProposal, mkContext, mkFact, mkWork, mkInput, mkOcc, EV_SRC, START } from './planning.helpers.js'
import { sha256Hex } from '../services/backup/format.js'

const TS = '2026-11-24T10:00:00+08:00'
const conf = (over = {}) => ({
  confirmation_id: 'c1', draft_revision: 1, object_type: 'gap', object_id_or_key: 'w1',
  field_path: '', old_value: null, new_value: null, confirmed_at: TS, ...over,
})

function openRaw(version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', version)
    req.onupgradeneeded = () => upgrade(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
function putRaw(db, store, value) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).put(value)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
function getAllRaw(db, store) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly')
    const req = t.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let db, svc, ws, counter
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('../services/storage/db')
  const { createAssistantDraftService } = await import('../services/assistant/drafts')
  ws = 'w1'
  db.configureWorkspace(ws)
  counter = 0
  svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `id-${++counter}` })
})

async function seedBusiness() {
  await db.putSource({ id: 's-1', kind: 'image', blob: new Blob([new Uint8Array([1, 2, 3])]), name: '虚构.png' })
  await db.putDoc({ id: 'n-1', kind: 'note', title: '虚构便签', source_id: 's-1', fields: [] })
  await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' } })
  await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false })
}

describe('配对原子创建与读取', () => {
  it('线程+草案同一事务保存；本地赋 ID/时间；get 返回基线/引用/ready', async () => {
    await seedBusiness()
    const r = await svc.create({ title: '虚构线程', proposal: mkProposal() })
    expect(r.ok).toBe(true)
    expect(r.thread.id).toBe(r.draft.thread_id)
    expect(r.draft.revision).toBe(1)
    expect(r.draft.status).toBe('editing')
    expect(r.draft.created_at).toBe(TS)
    const g = await svc.get(r.draft.id)
    expect(g.ok).toBe(true)
    expect(g.thread.id).toBe(r.thread.id)
    expect(g.baseline.draft).toEqual(r.draft)
    expect(g.refs.every((x) => x.state !== 'missing')).toBe(true)
    expect(g.readiness.ready).toBe(false) // 尚无计算
    expect(g.readiness.blockers.some((b) => b.code === 'NO_COMPUTATION')).toBe(true)
  })

  it('越界草案拒绝且线程也不落库（整体不写）', async () => {
    const big = { proposal: mkProposal(), planningInput: null, planningResult: null }
    const r = await svc.create({ ...big, title: 'x', factBaseline: null, sourceRefs: [], selectedRefs: [], threadId: undefined, ...{ proposal: { ...mkProposal(), assumptions: [{ id: 'a', text: '字'.repeat(600000), related_keys: [] }] } } })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('DRAFT_TOO_LARGE')
    const list = await svc.list()
    expect(list.threads).toEqual([])
    expect(list.drafts).toEqual([])
  })

  it('既有线程下建草案：未知线程拒绝；跨空间线程不可见', async () => {
    const r = await svc.create({ threadId: 'th-gone', proposal: mkProposal() })
    expect(r.code).toBe('NOT_FOUND')
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'assistant_threads', { id: 'th-other', record_version: 1, workspace_id: 'w2', messages: [], selected_refs: [], confirmed_requirements: [], created_at: TS, updated_at: TS })
    raw.close()
    const r2 = await svc.create({ threadId: 'th-other', proposal: mkProposal() })
    expect(r2.code).toBe('NOT_FOUND')
  })

  it('planning_result 无同版 input 拒绝（创建即配对校验）', async () => {
    const input = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })] })
    const { scheduleDaily } = await import('../domains/planning/schedule')
    const r = await svc.create({ proposal: mkProposal(), planningResult: scheduleDaily(input) })
    expect(r.code).toBe('COMPUTATION_MISMATCH')
  })
})

describe('完整基线并发（不是 revision 锁）', () => {
  it('同 revision 内另一页追加确认 → 旧基线编辑冲突，不覆盖确认', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const r1 = await svc.confirm(c.draft.id, { expected: g.baseline.draft, confirmation: conf() })
    expect(r1.ok).toBe(true)
    expect(r1.draft.revision).toBe(1) // 确认不 bump
    const r2 = await svc.edit(c.draft.id, { expected: g.baseline.draft, edits: { assumptions: [{ id: 'as1', text: '虚构', related_keys: [] }] } })
    expect(r2.ok).toBe(false)
    expect(r2.code).toBe('CONFLICT')
    expect(r2.current.user_confirmations).toHaveLength(1)
    const after = await svc.get(c.draft.id)
    expect(after.draft.user_confirmations).toHaveLength(1)
    expect(after.draft.assumptions).toEqual([])
  })

  it('discarded 不能被旧基线覆盖回 ready', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g0 = await svc.get(c.draft.id)
    await svc.setStatus(c.draft.id, { expected: g0.baseline.draft, status: 'generating' })
    const g = await svc.get(c.draft.id) // 冻结 generating 基线（generating→ready 是合法边）
    const d = await svc.discard(c.draft.id, { expected: g.baseline.draft })
    expect(d.ok).toBe(true)
    const r = await svc.setStatus(c.draft.id, { expected: g.baseline.draft, status: 'ready' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('CONFLICT')
    expect((await svc.get(c.draft.id)).draft.status).toBe('discarded')
  })

  it('重复保存同一冻结目标 → 已保存，不重复历史；同内容保存不 bump', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const edits = { assumptions: [{ id: 'as1', text: '虚构', related_keys: [] }] }
    const r1 = await svc.edit(c.draft.id, { expected: g.baseline.draft, edits })
    expect(r1.ok).toBe(true)
    expect(r1.bumped).toBe(true)
    expect(r1.draft.revision_history).toHaveLength(1)
    const r2 = await svc.edit(c.draft.id, { expected: g.baseline.draft, edits })
    expect(r2.ok).toBe(true)
    expect(r2.alreadySaved).toBe(true)
    expect(r2.draft.revision_history).toHaveLength(1)
    const same = await svc.edit(c.draft.id, { expected: r1.draft, edits: { assumptions: r1.draft.assumptions } })
    expect(same.ok).toBe(true)
    expect(same.bumped).toBe(false)
    expect(same.draft.revision).toBe(2)
  })

  it('确认幂等：同 id 同内容返回已保存；同 id 不同内容拒绝', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const r1 = await svc.confirm(c.draft.id, { expected: g.baseline.draft, confirmation: conf() })
    const r2 = await svc.confirm(c.draft.id, { expected: r1.draft, confirmation: conf() })
    expect(r2.ok).toBe(true)
    expect(r2.alreadySaved).toBe(true)
    const r3 = await svc.confirm(c.draft.id, { expected: r1.draft, confirmation: conf({ new_value: '改' }) })
    expect(r3.code).toBe('CONFIRMATION_DUP')
  })

  it('事务提交前切空间 → WORKSPACE_CHANGED，不写入新空间', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const orig = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args) {
      const req = orig.apply(this, args)
      ws = 'w2'
      db.configureWorkspace('w2')
      return req
    }
    try {
      const r = await svc.edit(c.draft.id, { expected: g.baseline.draft, edits: { assumptions: [{ id: 'x', text: 'y', related_keys: [] }] } })
      expect(r.ok).toBe(false)
      expect(r.code).toBe('WORKSPACE_CHANGED')
    } finally {
      IDBObjectStore.prototype.getAll = orig
    }
    ws = 'w1'
    db.configureWorkspace('w1')
    expect((await svc.get(c.draft.id)).draft.assumptions).toEqual([])
    ws = 'w2'
    db.configureWorkspace('w2')
    expect((await svc.list()).drafts).toEqual([])
  })

  it('已提交结果带捕获空间归属；等待期间输入突变不污染写入', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const edits = { assumptions: [] }
    const p = svc.edit(c.draft.id, { expected: g.baseline.draft, edits })
    edits.assumptions.push({ id: 'as-mut', text: '突变', related_keys: [] })
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.workspace_id).toBe('w1')
    expect(r.draft.assumptions).toEqual([])
  })
})

describe('状态与 ready 推导', () => {
  it('ready 必须服务推导通过；缺计算时 READY_BLOCKED', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g0 = await svc.get(c.draft.id)
    await svc.setStatus(c.draft.id, { expected: g0.baseline.draft, status: 'generating' })
    const g = await svc.get(c.draft.id)
    const r = await svc.setStatus(c.draft.id, { expected: g.baseline.draft, status: 'ready' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('READY_BLOCKED')
    expect(r.blockers.length).toBeGreaterThan(0)
  })

  it('本批不写入 applying/applied/result_unknown；非法转移拒绝', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    for (const s of ['applying', 'applied', 'result_unknown']) {
      expect((await svc.setStatus(c.draft.id, { expected: g.baseline.draft, status: s })).code).toBe('STATUS_NOT_SETTABLE')
    }
    expect((await svc.setStatus(c.draft.id, { expected: g.baseline.draft, status: 'needs_review' })).code).toBe('INVALID_TRANSITION')
  })

  it('刷新结算：generating→needs_review；applying→result_unknown；其它不动', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    await svc.setStatus(c.draft.id, { expected: g.baseline.draft, status: 'generating' })
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'assistant_drafts', {
      ...c.draft, id: 'd-applying', status: 'applying',
    })
    await putRaw(raw, 'assistant_drafts', { ...c.draft, id: 'd-ready', status: 'ready' })
    raw.close()
    const r = await svc.settleRefresh()
    expect(r.ok).toBe(true)
    const byId = Object.fromEntries(r.changed.map((d) => [d.id, d.status]))
    expect(byId[c.draft.id]).toBe('needs_review')
    expect(byId['d-applying']).toBe('result_unknown')
    expect(byId['d-ready']).toBeUndefined()
    const all = await svc.list()
    expect(all.drafts.find((d) => d.id === 'd-ready').status).toBe('ready')
  })
})

describe('重新排程（真实 normalize/schedule/validate）', () => {
  it('正例：写入同版 input/result + 事实基线指纹；ready 推导通过', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext([120, 120, 120, 120, 120, 120, 120]) })
    expect(r.ok).toBe(true)
    expect(r.bumped).toBe(true)
    expect(r.draft.planning_input).toBeTruthy()
    expect(r.draft.planning_result.complete).toBe(true)
    expect(r.draft.fact_baseline.source_fingerprints).toHaveLength(1)
    expect(r.draft.fact_baseline.source_fingerprints[0].sha256).toBe(await sha256Hex(new Uint8Array([1, 2, 3])))
    expect(r.draft.fact_baseline.task_facts).toEqual(r.draft.planning_input.task_facts)
    const after = await svc.get(c.draft.id)
    expect(after.readiness.blockers).toEqual([])
    await svc.setStatus(c.draft.id, { expected: after.baseline.draft, status: 'generating' })
    const g2 = await svc.get(c.draft.id)
    const ready = await svc.setStatus(c.draft.id, { expected: g2.baseline.draft, status: 'ready' })
    expect(ready.ok).toBe(true)
  })

  it('D12 未确认额外工作 → NEEDS_CLARIFICATION，不写入', async () => {
    await seedBusiness()
    await db.putDoc({ id: 'p-1', kind: 'plan_item', task_id: 't-1', date: START, planned_minutes: 30, state: 'planned' })
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext([120, 120, 120, 120, 120, 120, 120]) })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NEEDS_CLARIFICATION')
    expect(r.clarifications.some((q) => q.blocking_reason === 'extra_work_needs_confirmation')).toBe(true)
    expect((await svc.get(c.draft.id)).draft.revision).toBe(1)
  })

  it('计算后事实变化 → CONFLICT_FACTS，旧结果不覆盖新事实', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const orig = db.readAssistantSnapshot
    vi.spyOn(db, 'readAssistantSnapshot').mockImplementationOnce(async () => {
      const snap = await orig()
      await db.putDoc({ id: 't-new', kind: 'task', title: '计算后新增', status: 'todo', deadline: { value: null, precision: 'none' } })
      return snap
    })
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext([120, 120, 120, 120, 120, 120, 120]) })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('CONFLICT_FACTS')
    expect((await svc.get(c.draft.id)).draft.planning_input).toBeNull()
  })
})

describe('线程消息与要求', () => {
  it('两页先后追加都保留（基于事务内最新）；同 id 同内容幂等', async () => {
    const c = await svc.create({ title: 't', proposal: mkProposal() })
    const m1 = { role: 'user', content: '第一条' }
    const r1 = await svc.appendMessage(c.thread.id, { message: m1, messageId: 'm1' })
    expect(r1.ok).toBe(true)
    const r2 = await svc.appendMessage(c.thread.id, { message: { role: 'assistant', content: '第二条' }, messageId: 'm2' })
    expect(r2.thread.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    const r3 = await svc.appendMessage(c.thread.id, { message: m1, messageId: 'm1' })
    expect(r3.ok).toBe(true)
    expect(r3.alreadySaved).toBe(true)
    expect(r3.thread.messages).toHaveLength(2)
    const r4 = await svc.appendMessage(c.thread.id, { message: { role: 'user', content: '不同内容' }, messageId: 'm1' })
    expect(r4.code).toBe('MESSAGE_DUP')
  })

  it('已确认要求：合法追加；非法值拒绝；同 id 不同内容拒绝', async () => {
    const c = await svc.create({ title: 't', proposal: mkProposal() })
    const req = { requirement_id: 'r1', version: 1, type: 'daily_budget', value: 90, strength: 'hard', confirmed_at: TS, evidence_refs: [] }
    const r1 = await svc.confirmRequirement(c.thread.id, { expected: c.thread, requirement: req })
    expect(r1.ok).toBe(true)
    const bad = await svc.confirmRequirement(c.thread.id, { expected: r1.thread, requirement: { ...req, requirement_id: 'r2', value: 9999 } })
    expect(bad.code).toBe('REQUIREMENT_INVALID')
    const dup = await svc.confirmRequirement(c.thread.id, { expected: r1.thread, requirement: { ...req, value: 100 } })
    expect(dup.code).toBe('REQUIREMENT_DUP')
  })
})

describe('R1 事实新鲜度（服务 get / setStatus 事务内再核对）', () => {
  const fullBudget = [120, 120, 120, 120, 120, 120, 120]
  const planDoc = (id, over = {}) => ({ id, kind: 'plan_item', task_id: 't-1', date: START, planned_minutes: 120, action_text: '虚构', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over })

  async function readyGenerating() {
    await seedBusiness()
    const c = await svc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(fullBudget) })
    expect(r.ok).toBe(true)
    await svc.setStatus(c.draft.id, { expected: (await svc.get(c.draft.id)).baseline.draft, status: 'generating' })
    return c
  }

  it('新增窗口占用后 get 返回 factFreshness 漂移且 ready=false（旧内容保留）', async () => {
    const c = await readyGenerating()
    const before = await svc.get(c.draft.id)
    expect(before.factFreshness.fresh).toBe(true)
    expect(before.readiness.ready).toBe(true)
    await db.putDoc(planDoc('p-new', { planned_minutes: 120 }))
    const after = await svc.get(c.draft.id)
    expect(after.factFreshness.fresh).toBe(false)
    expect(after.factFreshness.diffs.some((d) => d.code === 'OCCUPANCY_ADDED')).toBe(true)
    expect(after.readiness.ready).toBe(false)
    expect(after.readiness.blockers.some((b) => b.code === 'OCCUPANCY_ADDED')).toBe(true)
    expect(after.draft.planning_input.occupancy).toEqual([])
  })

  it('跨午夜：时钟推进到次日，get 与 setStatus ready 均 WINDOW_STALE 阻断', async () => {
    const c = await readyGenerating()
    const { createAssistantDraftService } = await import('../services/assistant/drafts')
    const nextDay = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => '2026-11-25T10:00:00+08:00', newId: () => `nd-${++counter}` })
    const g2 = await nextDay.get(c.draft.id)
    expect(g2.factFreshness.diffs.some((d) => d.code === 'WINDOW_STALE')).toBe(true)
    expect(g2.readiness.ready).toBe(false)
    const r = await nextDay.setStatus(c.draft.id, { expected: g2.baseline.draft, status: 'ready' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('READY_BLOCKED')
    expect(r.blockers.some((b) => b.code === 'WINDOW_STALE')).toBe(true)
  })

  it('TOCTOU：get 判 ready 后、提交前事实被改 → 事务内再核对 READY_BLOCKED，不写 ready', async () => {
    const c = await readyGenerating()
    const g2 = await svc.get(c.draft.id)
    expect(g2.readiness.ready).toBe(true)
    // 另一标签新增占用：草案记录本身未变（基线守卫不拦），但事务内最新事实已漂移。
    await db.putDoc(planDoc('p-late', { planned_minutes: 90 }))
    const r = await svc.setStatus(c.draft.id, { expected: g2.baseline.draft, status: 'ready' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('READY_BLOCKED')
    expect(r.blockers.some((b) => b.code === 'OCCUPANCY_ADDED')).toBe(true)
    expect((await svc.get(c.draft.id)).draft.status).toBe('generating')
  })
})

describe('R2 重复排程不消耗版本（服务）', () => {
  const fullBudget = [120, 120, 120, 120, 120, 120, 120]

  it('不同时间重复排程同输入 → revision/history/当前确认不变', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const g = await svc.get(c.draft.id)
    const r1 = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(fullBudget) })
    expect(r1.ok).toBe(true)
    expect(r1.draft.revision).toBe(2)
    const cf = await svc.confirm(c.draft.id, { expected: r1.draft, confirmation: conf({ draft_revision: 2, confirmation_id: 'c-r2' }) })
    expect(cf.ok).toBe(true)
    const { createAssistantDraftService } = await import('../services/assistant/drafts')
    const later = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => '2026-11-24T10:01:00+08:00', newId: () => `lt-${++counter}` })
    const g2 = await later.get(c.draft.id)
    const r2 = await later.reschedule(c.draft.id, { expected: g2.baseline.draft, context: mkContext(fullBudget) })
    expect(r2.ok).toBe(true)
    expect(r2.bumped).toBe(false)
    expect(r2.draft.revision).toBe(2)
    expect(r2.draft.revision_history).toHaveLength(1)
    expect(r2.draft.user_confirmations.some((u) => u.confirmation_id === 'c-r2')).toBe(true)
  })

  it('真实内容变化（不同预算）仍增版', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const g = await svc.get(c.draft.id)
    const r1 = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(fullBudget) })
    expect(r1.draft.revision).toBe(2)
    const g2 = await svc.get(c.draft.id)
    const r2 = await svc.reschedule(c.draft.id, { expected: g2.baseline.draft, context: mkContext([60, 60, 60, 60, 60, 60, 60]) })
    expect(r2.ok).toBe(true)
    expect(r2.bumped).toBe(true)
    expect(r2.draft.revision).toBe(3)
  })
})

describe('R4 写入边界完整契约校验（非法形状整体不写）', () => {
  it('非法嵌套未知字段 create → SHAPE_INVALID，线程与草案都不落库', async () => {
    const r = await svc.create({ title: 't', proposal: { ...mkProposal(), unexpected_field: true } })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('SHAPE_INVALID')
    const list = await svc.list()
    expect(list.threads).toEqual([])
    expect(list.drafts).toEqual([])
  })

  it('非法枚举 / 引用形状 → SHAPE_INVALID 拒绝（不静默裁剪）', async () => {
    const badEnum = await svc.create({ proposal: { ...mkProposal(), work_items: [mkWork('w1', { priority: 'bogus' })] } })
    expect(badEnum.ok).toBe(false)
    expect(badEnum.code).toBe('SHAPE_INVALID')
    const badRef = await svc.create({ proposal: { ...mkProposal(), evidence_refs: [{ kind: 'source_excerpt', source_id: 's-1' }] } })
    expect(badRef.ok).toBe(false)
    expect(badRef.code).toBe('SHAPE_INVALID')
    expect((await svc.list()).drafts).toEqual([])
  })

  it('合法的不完整草案（null 载荷）照常通过写入边界', async () => {
    const r = await svc.create({ title: 't', proposal: mkProposal() })
    expect(r.ok).toBe(true)
    expect(r.draft.planning_input).toBeNull()
    expect(r.draft.fact_baseline).toBeNull()
  })
})

describe('DB v4：迁移、索引、清空', () => {
  it('v3→v4：旧记录与 Blob 逐字节不变；新 store/索引/ops 主键正确', async () => {
    const v3 = await openRaw(3, (d) => {
      d.createObjectStore('sources', { keyPath: 'id' })
      d.createObjectStore('docs', { keyPath: 'id' })
      d.createObjectStore('workspaces', { keyPath: 'id' })
      d.createObjectStore('focus_runtime', { keyPath: 'id' })
    })
    const blob = new Blob([new Uint8Array([9, 8, 7, 6])])
    await putRaw(v3, 'sources', { id: 's-old', kind: 'image', workspace_id: 'w1', blob })
    await putRaw(v3, 'docs', { id: 'n-old', kind: 'note', title: '旧便签', workspace_id: 'w1' })
    await putRaw(v3, 'focus_runtime', { id: 'run:w1', kind: 'running', workspace_id: 'w1', session_id: 'f1', updated_at: 1 })
    v3.close()
    const before = await sha256Hex(new Uint8Array([9, 8, 7, 6]))

    const docs = await db.allDocs() // 触发 v4 升级
    expect(docs.records.map((d) => d.id)).toEqual(['n-old'])
    const src = await db.getSource('s-old')
    expect(await sha256Hex(new Uint8Array(await src.record.blob.arrayBuffer()))).toBe(before)
    expect((await db.allFocusRuntime()).records).toHaveLength(1)

    const check = await openRaw(undefined, () => {})
    for (const name of ['assistant_threads', 'assistant_drafts', 'assistant_ops']) {
      expect(check.objectStoreNames.contains(name)).toBe(true)
    }
    const t = check.transaction(['assistant_threads', 'assistant_drafts', 'assistant_ops'], 'readonly')
    expect([...t.objectStore('assistant_threads').indexNames]).toEqual(['by_workspace'])
    expect([...t.objectStore('assistant_drafts').indexNames].sort()).toEqual(['by_thread', 'by_workspace'])
    expect(t.objectStore('assistant_ops').keyPath).toBe('application_id')
    expect([...t.objectStore('assistant_ops').indexNames]).toEqual(['by_workspace'])
    expect(await getAllRaw(check, 'assistant_threads')).toEqual([])
    check.close()
  })

  it('clearWorkspace 同事务清六个 store；ops 按 application_id 删；其它空间保留', async () => {
    const c = await svc.create({ title: 't', proposal: mkProposal() })
    await seedBusiness()
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'assistant_ops', { application_id: 'app-1', workspace_id: 'w1', state: 'pending' })
    await putRaw(raw, 'assistant_ops', { application_id: 'app-2', workspace_id: 'w2', state: 'pending' })
    await putRaw(raw, 'assistant_threads', { id: 'th-w2', record_version: 1, workspace_id: 'w2', messages: [], selected_refs: [], confirmed_requirements: [], created_at: TS, updated_at: TS })
    await putRaw(raw, 'docs', { id: 'n-w2', kind: 'note', title: '他空间', workspace_id: 'w2' })
    raw.close()
    await db.clearWorkspace('w1')
    const after = await openRaw(undefined, () => {})
    expect(await getAllRaw(after, 'assistant_threads')).toEqual([{ id: 'th-w2', record_version: 1, workspace_id: 'w2', messages: [], selected_refs: [], confirmed_requirements: [], created_at: TS, updated_at: TS }])
    expect(await getAllRaw(after, 'assistant_drafts')).toEqual([])
    expect((await getAllRaw(after, 'assistant_ops')).map((r) => r.application_id)).toEqual(['app-2'])
    expect((await getAllRaw(after, 'docs')).map((r) => r.id)).toEqual(['n-w2'])
    expect(await getAllRaw(after, 'sources')).toEqual([])
    after.close()
    expect(c.ok).toBe(true)
  })

  it('transformAssistantAtomic：thread_id 归属不变量；失败整体回滚', async () => {
    await expect(db.transformAssistantAtomic(() => ({
      draftPuts: [{ id: 'd-x', record_version: 1, thread_id: 'th-gone', revision: 1, revision_history: [], status: 'editing', created_at: TS, updated_at: TS }],
    }))).rejects.toMatchObject({ code: 'THREAD_REF_INVALID' })
    const snap = await db.readAssistantSnapshot()
    expect(snap.drafts).toEqual([])
    const c = await svc.create({ title: 't', proposal: mkProposal() })
    const orig = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (value && value.id === 'd-boom') throw new Error('注入写入失败')
      return orig.call(this, value, ...rest)
    }
    try {
      await expect(db.transformAssistantAtomic(() => ({
        threadPuts: [{ id: 'th-new', record_version: 1, workspace_id: 'w1', messages: [], selected_refs: [], confirmed_requirements: [], created_at: TS, updated_at: TS }],
        draftPuts: [{ ...c.draft, id: 'd-boom', thread_id: 'th-new' }],
      }))).rejects.toThrow('注入写入失败')
    } finally {
      IDBObjectStore.prototype.put = orig
    }
    const after = await db.readAssistantSnapshot()
    expect(after.threads.map((t) => t.id)).not.toContain('th-new')
    expect(after.drafts.map((d) => d.id)).not.toContain('d-boom')
  })

  it('readWorkspaceSnapshot 一致快照含助手两 store，按显式 wsId 过滤', async () => {
    await svc.create({ title: 't', proposal: mkProposal() })
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'assistant_threads', { id: 'th-w2', record_version: 1, workspace_id: 'w2', messages: [], selected_refs: [], confirmed_requirements: [], created_at: TS, updated_at: TS })
    raw.close()
    const snap = await db.readWorkspaceSnapshot('w1')
    expect(snap.assistantThreads).toHaveLength(1)
    expect(snap.assistantDrafts).toHaveLength(1)
    expect(snap.assistantThreads[0].workspace_id).toBe('w1')
    const empty = await db.readWorkspaceSnapshot('w-empty')
    expect(empty.assistantThreads).toEqual([])
    expect(empty.assistantDrafts).toEqual([])
  })
})

// ===== 5B-1B 第六轮整改 R5–R7 正确行为回归（保留 R1–R4 负向用例，不删除）=====
const FULL = [120, 120, 120, 120, 120, 120, 120]

describe('R5 已确认要求有效变化使旧排程失效（get 与事务内 ready 双覆盖）', () => {
  async function readyDraft(proposal = mkProposal()) {
    await seedBusiness()
    const c = await svc.create({ proposal })
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const gs = await svc.setStatus(c.draft.id, { expected: (await svc.get(c.draft.id)).baseline.draft, status: 'generating' })
    expect(gs.ok, JSON.stringify(gs)).toBe(true)
    return gs.draft
  }
  const req = (over = {}) => ({ requirement_id: 'r-budget', version: 1, type: 'daily_budget', value: 0, strength: 'hard', confirmed_at: TS, evidence_refs: [], ...over })

  it('每日预算 120→0：旧草案 get ready=false（FACT_BASELINE_MISSING），旧排程内容保留但事务内 ready 被阻', async () => {
    const d = await readyDraft()
    expect((await svc.get(d.id)).readiness.ready).toBe(true)
    const g = await svc.get(d.id)
    const cr = await svc.confirmRequirement(d.thread_id, { expected: g.thread, requirement: req() })
    expect(cr.ok, JSON.stringify(cr)).toBe(true)
    expect(cr.invalidatedDrafts).toContain(d.id)
    const after = await svc.get(d.id)
    expect(after.readiness.ready).toBe(false)
    expect(after.readiness.blockers.some((b) => b.code === 'FACT_BASELINE_MISSING')).toBe(true)
    expect(after.draft.fact_baseline).toBeNull()
    expect(after.draft.planning_input.days.map((x) => x.budget_minutes)).toEqual(FULL)
    const rr = await svc.setStatus(d.id, { expected: after.baseline.draft, status: 'ready' })
    expect(rr.ok).toBe(false)
    expect(rr.code).toBe('READY_BLOCKED')
    expect(rr.blockers.some((b) => b.code === 'FACT_BASELINE_MISSING')).toBe(true)
  })

  it('新增禁用日：旧草案事实基线失效，须重排后才能 ready', async () => {
    const d = await readyDraft()
    const g = await svc.get(d.id)
    const cr = await svc.confirmRequirement(d.thread_id, { expected: g.thread, requirement: req({ requirement_id: 'r-off', type: 'unavailable_days', value: [START] }) })
    expect(cr.ok, JSON.stringify(cr)).toBe(true)
    const after = await svc.get(d.id)
    expect(after.draft.fact_baseline).toBeNull()
    expect(after.readiness.ready).toBe(false)
  })

  it('同线程多草案：要求有效变化使全部已计算草案失效', async () => {
    const d1 = await readyDraft()
    const c2 = await svc.create({ threadId: d1.thread_id, proposal: mkProposal() })
    expect(c2.ok, JSON.stringify(c2)).toBe(true)
    const g2 = await svc.get(c2.draft.id)
    const r2 = await svc.reschedule(c2.draft.id, { expected: g2.baseline.draft, context: mkContext(FULL) })
    expect(r2.ok, JSON.stringify(r2)).toBe(true)
    const g = await svc.get(d1.id)
    const cr = await svc.confirmRequirement(d1.thread_id, { expected: g.thread, requirement: req() })
    expect(cr.ok).toBe(true)
    expect([...cr.invalidatedDrafts].sort()).toEqual([d1.id, c2.draft.id].sort())
    expect((await svc.get(d1.id)).draft.fact_baseline).toBeNull()
    expect((await svc.get(c2.draft.id)).draft.fact_baseline).toBeNull()
  })

  it('同 id 同内容幂等重试：不失效随后重排的草案（alreadySaved 不触发失效）', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: mkProposal() })
    const g0 = await svc.get(c.draft.id)
    const r0 = await svc.reschedule(c.draft.id, { expected: g0.baseline.draft, context: mkContext(FULL) })
    expect(r0.ok, JSON.stringify(r0)).toBe(true)
    const harmless = req({ requirement_id: 'r-off', type: 'unavailable_days', value: ['2027-01-01'] })
    const g1 = await svc.get(c.draft.id)
    const cr1 = await svc.confirmRequirement(c.thread.id, { expected: g1.thread, requirement: harmless })
    expect(cr1.ok).toBe(true)
    expect(cr1.invalidatedDrafts).toContain(c.draft.id)
    const g2 = await svc.get(c.draft.id)
    const r2 = await svc.reschedule(c.draft.id, { expected: g2.baseline.draft, context: mkContext(FULL) })
    expect(r2.ok, JSON.stringify(r2)).toBe(true)
    expect((await svc.get(c.draft.id)).readiness.ready).toBe(true)
    const g3 = await svc.get(c.draft.id)
    const cr2 = await svc.confirmRequirement(c.thread.id, { expected: g3.thread, requirement: harmless })
    expect(cr2.ok).toBe(true)
    expect(cr2.alreadySaved).toBe(true)
    const after = await svc.get(c.draft.id)
    expect(after.draft.fact_baseline).not.toBeNull()
    expect(after.readiness.ready).toBe(true)
  })

  it('读取判 ready 后、提交前确认新要求：事务内拦截，绝不写 ready', async () => {
    const d = await readyDraft()
    const g = await svc.get(d.id)
    expect(g.readiness.ready).toBe(true)
    const cr = await svc.confirmRequirement(d.thread_id, { expected: g.thread, requirement: req() })
    expect(cr.ok).toBe(true)
    const rr = await svc.setStatus(d.id, { expected: g.baseline.draft, status: 'ready' })
    expect(rr.ok).toBe(false)
    expect(['CONFLICT', 'READY_BLOCKED']).toContain(rr.code)
    expect((await svc.get(d.id)).draft.status).not.toBe('ready')
  })
})

describe('R6 草案已确认新截止不误判正式漂移（正式基线与候选分离）', () => {
  const deadline = { value: '2026-11-30', precision: 'date' }
  const candidate = { ...deadline, origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] }
  const updateProposal = () => mkProposal({ task_proposals: [{ op: 'update', key: 'update-t', target_id: 't-1', changes: { deadline_candidates: [candidate] }, evidence_refs: [EV_SRC] }] })
  const dlConf = (rev, over = {}) => ({ confirmation_id: 'dl', draft_revision: rev, object_type: 'task', id_scope: 'formal', object_id_or_key: 't-1', field_path: 'deadline', old_value: null, new_value: deadline, confirmed_at: TS, ...over })
  const putTask = (dl) => db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: dl })

  it('正式无截止→草案新截止已确认：get 无 TASK_DEADLINE_CHANGED 且可 ready', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: updateProposal() })
    expect(c.ok, JSON.stringify(c)).toBe(true)
    const cf = await svc.confirm(c.draft.id, { expected: c.draft, confirmation: dlConf(c.draft.revision) })
    expect(cf.ok, JSON.stringify(cf)).toBe(true)
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const g2 = await svc.get(c.draft.id)
    const cf2 = await svc.confirm(c.draft.id, { expected: g2.baseline.draft, confirmation: dlConf(r.draft.revision, { confirmation_id: 'dl-cur' }) })
    expect(cf2.ok, JSON.stringify(cf2)).toBe(true)
    const after = await svc.get(c.draft.id)
    expect(after.factFreshness.diffs.some((d) => d.code === 'TASK_DEADLINE_CHANGED')).toBe(false)
    expect(after.readiness.blockers.some((b) => b.code === 'TASK_DEADLINE_CHANGED')).toBe(false)
    expect(after.readiness.ready).toBe(true)
  })

  it('正式已有截止→草案另一截止已确认：不误判漂移', async () => {
    await seedBusiness()
    await putTask({ value: '2026-11-28', precision: 'date' })
    const c = await svc.create({ proposal: updateProposal() })
    const cf = await svc.confirm(c.draft.id, { expected: c.draft, confirmation: dlConf(c.draft.revision, { old_value: { value: '2026-11-28', precision: 'date' } }) })
    expect(cf.ok, JSON.stringify(cf)).toBe(true)
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const g2 = await svc.get(c.draft.id)
    const cf2 = await svc.confirm(c.draft.id, { expected: g2.baseline.draft, confirmation: dlConf(r.draft.revision, { confirmation_id: 'dl-cur', old_value: { value: '2026-11-28', precision: 'date' } }) })
    expect(cf2.ok).toBe(true)
    const after = await svc.get(c.draft.id)
    expect(after.factFreshness.diffs.some((d) => d.code === 'TASK_DEADLINE_CHANGED')).toBe(false)
    expect(after.readiness.ready).toBe(true)
  })

  it('用户保留原截止（确认不改值）：无漂移、可 ready', async () => {
    await seedBusiness()
    await putTask({ value: '2026-11-28', precision: 'date' })
    const keep = { value: '2026-11-28', precision: 'date' }
    const c = await svc.create({ proposal: mkProposal() })
    const cf = await svc.confirm(c.draft.id, { expected: c.draft, confirmation: dlConf(c.draft.revision, { confirmation_id: 'keep', old_value: keep, new_value: keep }) })
    expect(cf.ok, JSON.stringify(cf)).toBe(true)
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const after = await svc.get(c.draft.id)
    expect(after.factFreshness.fresh).toBe(true)
    expect(after.readiness.ready).toBe(true)
  })

  it('另一标签真实修改正式截止：仍检出 TASK_DEADLINE_CHANGED 并阻断 ready', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok).toBe(true)
    expect((await svc.get(c.draft.id)).factFreshness.fresh).toBe(true)
    await putTask({ value: '2026-12-01', precision: 'date' })
    const after = await svc.get(c.draft.id)
    expect(after.factFreshness.diffs.some((d) => d.code === 'TASK_DEADLINE_CHANGED')).toBe(true)
    expect(after.readiness.ready).toBe(false)
  })

  it('重排增版后旧确认不复活：须当前版确认才清除 UPDATE_UNCONFIRMED', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: updateProposal() })
    const cf = await svc.confirm(c.draft.id, { expected: c.draft, confirmation: dlConf(c.draft.revision) })
    expect(cf.ok).toBe(true)
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok).toBe(true)
    expect(r.draft.revision).toBeGreaterThan(c.draft.revision)
    const stale = await svc.get(c.draft.id)
    expect(stale.readiness.blockers.some((b) => b.code === 'UPDATE_UNCONFIRMED')).toBe(true)
    const g2 = await svc.get(c.draft.id)
    const cf2 = await svc.confirm(c.draft.id, { expected: g2.baseline.draft, confirmation: dlConf(r.draft.revision, { confirmation_id: 'dl-cur' }) })
    expect(cf2.ok).toBe(true)
    expect((await svc.get(c.draft.id)).readiness.blockers.some((b) => b.code === 'UPDATE_UNCONFIRMED')).toBe(false)
  })
})

describe('R7 文字证据真实内容指纹（UTF-8 字节 + 内容新鲜度 + 提交绑定）', () => {
  async function textDraft(text = '虚构原文一') {
    await seedBusiness()
    await db.putSource({ id: 's-1', kind: 'text', text })
    const c = await svc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    return r.draft
  }

  it('两段不同文字 → 不同摘要；中文 UTF-8 字节长度正确（非空内容）', async () => {
    const { sourceContentBytes } = await import('../services/assistant/context')
    const a = await sourceContentBytes({ id: 's-a', kind: 'text', text: '虚构原文一' })
    const b = await sourceContentBytes({ id: 's-b', kind: 'text', text: '完全不同的虚构原文二' })
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b))
    expect(a.length).toBe(new TextEncoder().encode('虚构原文一').length)
    expect(a.length).toBe(15)
  })

  it('缺少必需载荷不伪造空证据：text 无 text / image 无 blob 抛 FACT_SOURCE_PAYLOAD_MISSING', async () => {
    const { sourceContentBytes } = await import('../services/assistant/context')
    await expect(sourceContentBytes({ id: 's-x', kind: 'text' })).rejects.toMatchObject({ code: 'FACT_SOURCE_PAYLOAD_MISSING' })
    await expect(sourceContentBytes({ id: 's-y', kind: 'image' })).rejects.toMatchObject({ code: 'FACT_SOURCE_PAYLOAD_MISSING' })
  })

  it('文字证据排程冻结真实字节指纹（bytes>0 且等于原文 UTF-8 摘要）', async () => {
    const d = await textDraft()
    const fp = d.fact_baseline.source_fingerprints[0]
    expect(fp.bytes).toBe(15)
    expect(fp.sha256).toBe(await sha256Hex(new TextEncoder().encode('虚构原文一')))
  })

  it('同内容重复排程不增版', async () => {
    const d = await textDraft()
    expect(d.revision).toBe(2)
    const g2 = await svc.get(d.id)
    const r2 = await svc.reschedule(d.id, { expected: g2.baseline.draft, context: mkContext(FULL) })
    expect(r2.ok).toBe(true)
    expect(r2.bumped).toBe(false)
    expect(r2.draft.revision).toBe(2)
  })

  it('真实原文变化使旧草案证据过期：get fresh=false 且事务内 ready 被阻', async () => {
    const d = await textDraft()
    await svc.setStatus(d.id, { expected: (await svc.get(d.id)).baseline.draft, status: 'generating' })
    expect((await svc.get(d.id)).readiness.ready).toBe(true)
    await db.putSource({ id: 's-1', kind: 'text', text: '完全不同的虚构原文二' })
    const after = await svc.get(d.id)
    expect(after.factFreshness.fresh).toBe(false)
    expect(after.factFreshness.diffs.some((x) => x.code === 'SOURCE_CONTENT_CHANGED')).toBe(true)
    expect(after.readiness.ready).toBe(false)
    const rr = await svc.setStatus(d.id, { expected: after.baseline.draft, status: 'ready' })
    expect(rr.ok).toBe(false)
    expect(rr.code).toBe('READY_BLOCKED')
  })

  it('图片内容变化同样保护：换 Blob 字节 → 证据过期、ready 阻断', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok).toBe(true)
    expect(r.draft.fact_baseline.source_fingerprints[0].bytes).toBe(3)
    await db.putSource({ id: 's-1', kind: 'image', blob: new Blob([new Uint8Array([9, 9, 9, 9])]), name: '虚构.png' })
    const after = await svc.get(c.draft.id)
    expect(after.factFreshness.diffs.some((x) => x.code === 'SOURCE_CONTENT_CHANGED')).toBe(true)
    expect(after.readiness.ready).toBe(false)
  })

  it('资料绑定摘要随内容替换变化（核对后—提交前改资料可检出）', async () => {
    const { sourceBindingDigest } = await import('../services/assistant/context')
    const ids = new Set(['s-1'])
    const d1 = sourceBindingDigest([{ id: 's-1', kind: 'text', text: '甲', captured_at: TS }], ids)
    const d2 = sourceBindingDigest([{ id: 's-1', kind: 'text', text: '乙', captured_at: TS }], ids)
    expect(d1).not.toBe(d2)
  })
})

describe('R8 明确无截止/保留原值/手动日期与排程一致（update 候选存在时三步闭环）', () => {
  const candidate = { value: '2026-11-30', precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] }
  const updateProposal = () => mkProposal({ task_proposals: [{ op: 'update', key: 'update-t', target_id: 't-1', changes: { deadline_candidates: [candidate] }, evidence_refs: [EV_SRC] }] })
  // 三步：create→初版确认→重算（排程接受选择）→当前版再确认→get ready→事务内 ready 提交。
  async function choiceDraft(selected, { formalDl = null, old_value = null } = {}) {
    await seedBusiness()
    if (formalDl) await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: formalDl })
    const c = await svc.create({ proposal: updateProposal() })
    expect(c.ok, JSON.stringify(c)).toBe(true)
    const conf = (rev, id) => ({ confirmation_id: id, draft_revision: rev, object_type: 'task', id_scope: 'formal', object_id_or_key: 't-1', field_path: 'deadline', old_value, new_value: selected, confirmed_at: TS })
    const c1 = await svc.confirm(c.draft.id, { expected: c.draft, confirmation: conf(c.draft.revision, 'dl-init') })
    expect(c1.ok, JSON.stringify(c1)).toBe(true)
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const g2 = await svc.get(c.draft.id)
    const c2 = await svc.confirm(c.draft.id, { expected: g2.baseline.draft, confirmation: conf(r.draft.revision, 'dl-cur') })
    expect(c2.ok, JSON.stringify(c2)).toBe(true)
    return { draft: c2.draft, planningInput: r.draft.planning_input }
  }
  async function commitReady(d) {
    const g = await svc.setStatus(d.id, { expected: d, status: 'generating' })
    expect(g.ok, JSON.stringify(g)).toBe(true)
    return svc.setStatus(d.id, { expected: g.draft, status: 'ready' })
  }

  it('明确无截止（new_value=null）：排程 precision=none，get 无 CONFIRMATION_VALUE_STALE，ready 提交成功', async () => {
    const { draft, planningInput } = await choiceDraft(null)
    expect(planningInput.task_facts[0].deadline_precision).toBe('none')
    const after = await svc.get(draft.id)
    expect(after.readiness.blockers.some((b) => b.code === 'CONFIRMATION_VALUE_STALE')).toBe(false)
    expect(after.readiness.ready).toBe(true)
    const rr = await commitReady(draft)
    expect(rr.ok, JSON.stringify(rr)).toBe(true)
    expect(rr.draft.status).toBe('ready')
    // 确认≠改值：正式 Task 仍无截止，未提前改业务对象。
    expect((await db.allDocs()).records.find((x) => x.id === 't-1').deadline.precision).toBe('none')
  })

  it('保留旧日期（候选存在但用户不改）：三步一致可 ready，正式截止不变', async () => {
    const keep = { value: '2026-11-28', precision: 'date' }
    const { draft, planningInput } = await choiceDraft(keep, { formalDl: keep, old_value: keep })
    expect(planningInput.task_facts[0].deadline_value).toBe('2026-11-28')
    const after = await svc.get(draft.id)
    expect(after.factFreshness.diffs.some((d) => d.code === 'TASK_DEADLINE_CHANGED')).toBe(false)
    expect(after.readiness.ready).toBe(true)
    expect((await commitReady(draft)).ok).toBe(true)
    expect((await db.allDocs()).records.find((x) => x.id === 't-1').deadline.value).toBe('2026-11-28')
  })

  it('手动非候选日期（2026-12-05 不在候选中）：合法决定，三步一致可 ready', async () => {
    const manual = { value: '2026-12-05', precision: 'date' }
    const { draft, planningInput } = await choiceDraft(manual)
    expect(planningInput.task_facts[0].deadline_value).toBe('2026-12-05')
    const after = await svc.get(draft.id)
    expect(after.readiness.blockers.some((b) => b.code === 'CONFIRMATION_VALUE_STALE')).toBe(false)
    expect(after.readiness.ready).toBe(true)
    expect((await commitReady(draft)).ok).toBe(true)
  })

  it('旧版授权不继承：仅初版确认无截止，重算增版后仍 UPDATE_UNCONFIRMED 阻断 ready', async () => {
    await seedBusiness()
    const c = await svc.create({ proposal: updateProposal() })
    const conf = (rev, id) => ({ confirmation_id: id, draft_revision: rev, object_type: 'task', id_scope: 'formal', object_id_or_key: 't-1', field_path: 'deadline', old_value: null, new_value: null, confirmed_at: TS })
    const c1 = await svc.confirm(c.draft.id, { expected: c.draft, confirmation: conf(c.draft.revision, 'dl-init') })
    expect(c1.ok).toBe(true)
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok).toBe(true)
    expect(r.draft.revision).toBeGreaterThan(c.draft.revision)
    const after = await svc.get(c.draft.id)
    expect(after.readiness.blockers.some((b) => b.code === 'UPDATE_UNCONFIRMED')).toBe(true)
    expect(after.readiness.ready).toBe(false)
  })
})

describe('R9 图片内容版本绑定（同尺寸/同名/同类型/同捕获时间而字节不同的提交前替换必须拒绝）', () => {
  // 事务外重摘要（crypto.subtle.digest）完成后、事务内状态写入前，用真实 putSource 替换资料。
  // 钩子只触发一次；替换写入自身的内容版本计算不再二次触发。镜像审查探针时序，断言修复后的正确行为。
  async function imageDraft() {
    await seedBusiness()
    const original = { id: 's-1', kind: 'image', name: '虚构.png', captured_at: TS, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) }
    await db.putSource(original)
    const c = await svc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    expect(c.ok, JSON.stringify(c)).toBe(true)
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.draft.fact_baseline.source_fingerprints[0].bytes).toBe(3)
    const gen = await svc.setStatus(r.draft.id, { expected: r.draft, status: 'generating' })
    expect(gen.ok, JSON.stringify(gen)).toBe(true)
    return { original, draft: r.draft, generating: gen.draft }
  }
  function hookDigestOnce(onFirst) {
    const realDigest = crypto.subtle.digest.bind(crypto.subtle)
    let fired = false
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      const result = await realDigest(...args)
      if (!fired) { fired = true; await onFirst() }
      return result
    })
    return () => fired
  }
  async function deleteSourceRaw(id) {
    const raw = await openRaw(undefined, () => {})
    await new Promise((resolve, reject) => {
      const t = raw.transaction('sources', 'readwrite')
      t.objectStore('sources').delete(id)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })
    raw.close()
  }

  it('核对后—提交前换成同尺寸/同名/同类型/同捕获时间的另一张图片：事务内绑定检出 → CONFLICT_FACTS 拒绝', async () => {
    const { original, draft, generating } = await imageDraft()
    const fired = hookDigestOnce(() => db.putSource({ ...original, blob: new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' }) }))
    const rr = await svc.setStatus(draft.id, { expected: generating, status: 'ready' })
    vi.restoreAllMocks()
    expect(fired()).toBe(true)
    expect(rr.ok, JSON.stringify(rr)).toBe(false)
    expect(rr.code).toBe('CONFLICT_FACTS')
    // 立即 get 与提交判定一致：内容已变、不再就绪（双重保护同口径）。
    const after = await svc.get(draft.id)
    expect(after.readiness.ready).toBe(false)
    expect(after.factFreshness.diffs.some((x) => x.code === 'SOURCE_CONTENT_CHANGED')).toBe(true)
  })

  it('同内容未变化（无替换）：核对后—提交前资料不变 → ready 成功', async () => {
    const { draft, generating } = await imageDraft()
    const rr = await svc.setStatus(draft.id, { expected: generating, status: 'ready' })
    expect(rr.ok, JSON.stringify(rr)).toBe(true)
    expect(rr.draft.status).toBe('ready')
  })

  it('content_version 按真实字节而非元数据：同元数据不同字节 → 不同版本；同字节 → 同版本；绑定随之不同', async () => {
    const { sourceContentVersion } = await import('../services/backup/format')
    const { sourceBindingDigest } = await import('../services/assistant/context')
    const meta = { id: 's-1', kind: 'image', name: '虚构.png', captured_at: TS }
    const a = { ...meta, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) }
    const b = { ...meta, blob: new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' }) }
    const va = await sourceContentVersion(a)
    const vb = await sourceContentVersion(b)
    expect(va).toBe(await sha256Hex(new Uint8Array([1, 2, 3])))
    expect(va).not.toBe(vb)
    expect(va).toBe(await sourceContentVersion({ ...meta, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) }))
    const ids = new Set(['s-1'])
    expect(sourceBindingDigest([{ ...a, content_version: va }], ids)).not.toBe(sourceBindingDigest([{ ...b, content_version: vb }], ids))
  })

  it('putSource 落库即冻结 content_version（真实字节摘要，供事务内同步绑定）', async () => {
    await db.putSource({ id: 's-1', kind: 'image', name: '虚构.png', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) })
    const { record } = await db.getSource('s-1')
    expect(record.content_version).toBe(await sha256Hex(new Uint8Array([1, 2, 3])))
  })

  it('文字保护仍有效：同字节长度不同文字在核对后—提交前替换 → CONFLICT_FACTS（非按长度判定）', async () => {
    await seedBusiness()
    const original = { id: 's-1', kind: 'text', text: '虚构原文一', captured_at: TS }
    await db.putSource(original)
    const c = await svc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok).toBe(true)
    expect(r.draft.fact_baseline.source_fingerprints[0].bytes).toBe(15)
    const gen = await svc.setStatus(r.draft.id, { expected: r.draft, status: 'generating' })
    const fired = hookDigestOnce(() => db.putSource({ ...original, text: '虚构原文二' }))
    const rr = await svc.setStatus(r.draft.id, { expected: gen.draft, status: 'ready' })
    vi.restoreAllMocks()
    expect(fired()).toBe(true)
    expect(rr.ok).toBe(false)
    expect(rr.code).toBe('CONFLICT_FACTS')
  })

  it('删除保护仍有效：资料在核对后—提交前被删除 → 事务内绑定/缺失检出拒绝', async () => {
    const { draft, generating } = await imageDraft()
    const fired = hookDigestOnce(() => deleteSourceRaw('s-1'))
    const rr = await svc.setStatus(draft.id, { expected: generating, status: 'ready' })
    vi.restoreAllMocks()
    expect(fired()).toBe(true)
    expect(rr.ok).toBe(false)
    expect(rr.code).toBe('CONFLICT_FACTS')
    const after = await svc.get(draft.id)
    expect(after.factFreshness.diffs.some((x) => x.code === 'SOURCE_MISSING')).toBe(true)
  })
})

describe('R10 当前截止确认与计算输入绑定（confirm→reschedule→confirm→setStatus 三步一致才可 ready）', () => {
  const candidate = { value: '2026-11-30', precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] }
  const updateProposal = () => mkProposal({ task_proposals: [{ op: 'update', key: 'update-t', target_id: 't-1', changes: { deadline_candidates: [candidate] }, evidence_refs: [EV_SRC] }] })
  const createCandidate = { value: '2026-12-01', precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] }
  const createProposal = () => mkProposal({
    task_proposals: [{ op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [createCandidate], evidence_refs: [EV_SRC] }],
    action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60 }],
    work_items: [mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } })],
  })
  const dlConf = (scope, key, rev, id, nv, old_value = null) => ({ confirmation_id: id, draft_revision: rev, object_type: 'task', id_scope: scope, object_id_or_key: key, field_path: 'deadline', old_value, new_value: nv, confirmed_at: TS })
  // 初版确认 initial → 重算（计算采用 initial）→ 当前版再确认 reconfirmed（可与 initial 不同）。
  async function flow(proposal, scope, key, initial, reconfirmed, { formalDl = null, old_value = null } = {}) {
    await seedBusiness()
    if (formalDl) await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: formalDl })
    const c = await svc.create({ proposal })
    expect(c.ok, JSON.stringify(c)).toBe(true)
    const c1 = await svc.confirm(c.draft.id, { expected: c.draft, confirmation: dlConf(scope, key, c.draft.revision, 'dl-init', initial, old_value) })
    expect(c1.ok, JSON.stringify(c1)).toBe(true)
    const g = await svc.get(c.draft.id)
    const r = await svc.reschedule(c.draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const g2 = await svc.get(c.draft.id)
    const c2 = await svc.confirm(c.draft.id, { expected: g2.baseline.draft, confirmation: dlConf(scope, key, r.draft.revision, 'dl-cur', reconfirmed, old_value) })
    expect(c2.ok, JSON.stringify(c2)).toBe(true)
    return { draft: c2.draft, planningInput: r.draft.planning_input, scope, key }
  }
  const updateFlow = (initial, reconfirmed, opts) => flow(updateProposal(), 'formal', 't-1', initial, reconfirmed, opts)
  const createFlow = (initial, reconfirmed) => flow(createProposal(), 'draft', 't-new', initial, reconfirmed)
  async function commitReady(d) {
    const g = await svc.setStatus(d.id, { expected: d, status: 'generating' })
    expect(g.ok, JSON.stringify(g)).toBe(true)
    return svc.setStatus(d.id, { expected: g.draft, status: 'ready' })
  }
  const recomputeBlocked = (g) => g.readiness.blockers.some((b) => b.code === 'DEADLINE_RECOMPUTE_REQUIRED')

  it('日期和值完全一致：三步一致，get 无阻断且 ready 提交成功', async () => {
    const { draft, planningInput } = await updateFlow({ value: '2026-11-30', precision: 'date' }, { value: '2026-11-30', precision: 'date' })
    expect(planningInput.task_facts[0].deadline_value).toBe('2026-11-30')
    const g = await svc.get(draft.id)
    expect(recomputeBlocked(g)).toBe(false)
    expect(g.readiness.ready).toBe(true)
    expect((await commitReady(draft)).ok).toBe(true)
  })

  it('改为更早截止（含已过去 11-23）：旧计算阻断，重排采纳新决定并按逾期规则处理', async () => {
    const { draft, planningInput } = await updateFlow({ value: '2026-11-30', precision: 'date' }, { value: '2026-11-23', precision: 'date' })
    // 旧计算保留 11-30，不被确认静默改写。
    expect(planningInput.task_facts[0].deadline_value).toBe('2026-11-30')
    const g = await svc.get(draft.id)
    expect(g.readiness.ready).toBe(false)
    expect(recomputeBlocked(g)).toBe(true)
    // 重新排程（仍 editing）：真实 normalize/schedule/validate 采纳当前确认 11-23，过去截止走逾期补做规则。
    const r2 = await svc.reschedule(draft.id, { expected: g.baseline.draft, context: mkContext(FULL) })
    expect(r2.ok, JSON.stringify(r2)).toBe(true)
    expect(r2.draft.planning_input.task_facts[0].deadline_value).toBe('2026-11-23')
    expect(r2.draft.planning_result.unscheduled.some((u) => u.reason === 'overdue_requires_consent')).toBe(true)
  })

  it('改为更早截止：事务内 ready 提交被 READY_BLOCKED 拒绝，不写就绪', async () => {
    const { draft } = await updateFlow({ value: '2026-11-30', precision: 'date' }, { value: '2026-11-23', precision: 'date' })
    const rr = await commitReady(draft)
    expect(rr.ok).toBe(false)
    expect(rr.code).toBe('READY_BLOCKED')
    expect((await svc.get(draft.id)).baseline.draft.status).not.toBe('ready')
  })

  it('同一新决定重排并确认新版本：新输入/新结果/新确认一致后成功提交', async () => {
    const { draft } = await updateFlow({ value: '2026-11-30', precision: 'date' }, { value: '2026-12-05', precision: 'date' })
    expect(recomputeBlocked(await svc.get(draft.id))).toBe(true)
    const latest = await svc.get(draft.id)
    const r2 = await svc.reschedule(draft.id, { expected: latest.baseline.draft, context: mkContext(FULL) })
    expect(r2.ok, JSON.stringify(r2)).toBe(true)
    expect(r2.draft.planning_input.task_facts[0].deadline_value).toBe('2026-12-05')
    const g3 = await svc.get(draft.id)
    const c3 = await svc.confirm(draft.id, { expected: g3.baseline.draft, confirmation: dlConf('formal', 't-1', r2.draft.revision, 'dl-new', { value: '2026-12-05', precision: 'date' }) })
    expect(c3.ok, JSON.stringify(c3)).toBe(true)
    const after = await svc.get(draft.id)
    expect(recomputeBlocked(after)).toBe(false)
    expect(after.readiness.ready).toBe(true)
    expect((await commitReady(c3.draft)).ok).toBe(true)
  })

  it('日期改为明确无截止 / 无截止改为日期：两个方向都阻断旧计算', async () => {
    const toNone = await updateFlow({ value: '2026-11-30', precision: 'date' }, null)
    expect(toNone.planningInput.task_facts[0].deadline_value).toBe('2026-11-30')
    expect(recomputeBlocked(await svc.get(toNone.draft.id))).toBe(true)
    const toDate = await updateFlow(null, { value: '2026-11-30', precision: 'date' })
    expect(toDate.planningInput.task_facts[0].deadline_precision).toBe('none')
    expect(recomputeBlocked(await svc.get(toDate.draft.id))).toBe(true)
  })

  it('日期与精确时刻互换：精度差异也阻断旧计算', async () => {
    const { draft, planningInput } = await updateFlow({ value: '2026-11-30', precision: 'date' }, { value: '2026-11-30T18:00:00+08:00', precision: 'datetime' })
    expect(planningInput.task_facts[0].deadline_precision).toBe('date')
    const g = await svc.get(draft.id)
    expect(recomputeBlocked(g)).toBe(true)
    expect((await commitReady(draft)).code).toBe('READY_BLOCKED')
  })

  it('create 命名空间：一致可 ready，改值阻断；与 formal 各走各的不串绑', async () => {
    const ok = await createFlow({ value: '2026-12-01', precision: 'date' }, { value: '2026-12-01', precision: 'date' })
    expect(ok.planningInput.task_facts[0].task_ref).toEqual({ kind: 'draft', key: 't-new' })
    expect(recomputeBlocked(await svc.get(ok.draft.id))).toBe(false)
    expect((await commitReady(ok.draft)).ok).toBe(true)
    const changed = await createFlow({ value: '2026-12-01', precision: 'date' }, { value: '2026-12-03', precision: 'date' })
    expect(changed.planningInput.task_facts[0].deadline_value).toBe('2026-12-01')
    const g = await svc.get(changed.draft.id)
    expect(recomputeBlocked(g)).toBe(true)
    expect((await commitReady(changed.draft)).code).toBe('READY_BLOCKED')
  })

  it('保留 R8/R6 选择能力：明确无截止、保留正式旧值、手动非候选日期仍合法可 ready', async () => {
    const none = await updateFlow(null, null)
    expect(none.planningInput.task_facts[0].deadline_precision).toBe('none')
    expect((await svc.get(none.draft.id)).readiness.ready).toBe(true)
    const keep = { value: '2026-11-28', precision: 'date' }
    const kept = await updateFlow(keep, keep, { formalDl: keep, old_value: keep })
    expect(kept.planningInput.task_facts[0].deadline_value).toBe('2026-11-28')
    expect((await svc.get(kept.draft.id)).readiness.ready).toBe(true)
    const manual = await updateFlow({ value: '2026-12-05', precision: 'date' }, { value: '2026-12-05', precision: 'date' })
    expect((await svc.get(manual.draft.id)).readiness.ready).toBe(true)
    // 确认≠改值：正式 Task 未提前修改。
    expect((await db.allDocs()).records.find((x) => x.id === 't-1').deadline.precision).toBe('none')
  })
})