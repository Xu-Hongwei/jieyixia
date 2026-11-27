// M1 采用协调服务单测（fake-indexeddb；全部虚构数据）。
// 覆盖：prepare 零写入、单事务整体提交、双击/双标签去重、失败整体回滚+同意图重试、
// 事实漂移 needs_recheck、切空间 result_unknown 收敛、settleRefresh 回执验证、resolve 只查原意图、
// applying/applied/result_unknown 状态锁、link/reuse 不改既有对象、缺口/过载独立确认。
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkProposal, mkContext, mkWork, EV_SRC, START } from './planning.helpers.js'

const TS = '2026-11-24T10:00:00+08:00'
const FULL = [120, 120, 120, 120, 120, 120, 120]
const DL = { value: '2026-12-01', precision: 'date' }
const candidate = { ...DL, origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] }
const createProposal = () => mkProposal({
  task_proposals: [{ op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [candidate], evidence_refs: [EV_SRC] }],
  action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60, basis: 'suggestion', evidence_refs: [] }],
  work_items: [{
    key: 'w1', task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' },
    deliverable: '虚构产出', remaining_minutes: 60, estimate_origin: 'model', splittable: true,
    min_segment_minutes: 25, earliest_date: null, depends_on: [], priority: 'normal',
  }],
})
const dlConf = (rev, id) => ({ confirmation_id: id, draft_revision: rev, object_type: 'task', id_scope: 'draft', object_id_or_key: 't-new', field_path: 'deadline', old_value: null, new_value: DL, confirmed_at: TS })
const conf = (type, key, rev, id) => ({ confirmation_id: id, draft_revision: rev, object_type: type, object_id_or_key: key, field_path: '', old_value: null, new_value: type === 'task' ? DL : true, confirmed_at: TS })

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
function deleteSourceRaw(id) {
  return openRaw(undefined, () => {}).then((raw) => new Promise((resolve, reject) => {
    const t = raw.transaction('sources', 'readwrite')
    t.objectStore('sources').delete(id)
    t.oncomplete = () => { raw.close(); resolve() }
    t.onerror = () => reject(t.error)
  }))
}

let db, dsvc, asvc, ws, counter, queues
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  vi.restoreAllMocks()
  db = await import('../services/storage/db')
  const { createAssistantDraftService } = await import('../services/assistant/drafts')
  const { createAssistantApplicationService } = await import('../services/assistant/applications')
  ws = 'w1'
  db.configureWorkspace(ws)
  counter = 0
  queues = new Map()
  const deps = { getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `id-${++counter}`, queues }
  dsvc = createAssistantDraftService(deps)
  asvc = createAssistantApplicationService(deps)
})

const DL_FIELD = { key: 'deadline', value: DL.value, precision: 'date', status: 'confirmed', origin: 'model', derived: false }
async function seedBusiness(noteFields = [DL_FIELD]) {
  await db.putSource({ id: 's-1', kind: 'image', blob: new Blob([new Uint8Array([1, 2, 3])]), name: '虚构.png' })
  // F1 合法出处：已确认且与采用截止值/精度匹配的 deadline 字段（便签存在≠字段核对）。
  await db.putDoc({ id: 'n-1', kind: 'note', title: '虚构便签', source_id: 's-1', fields: noteFields })
  await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' } })
  await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false })
}
const planDoc = (id, over = {}) => ({ id, kind: 'plan_item', task_id: 't-1', date: START, planned_minutes: 30, action_text: '虚构', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over })

// create 三步闭环到 ready（与 R10 同口径）：初版确认 → 重排 → 当前版确认 → generating → ready。
async function readyCreateDraft(noteFields) {
  await seedBusiness(noteFields)
  const c = await dsvc.create({ proposal: createProposal() })
  expect(c.ok, JSON.stringify(c)).toBe(true)
  const c1 = await dsvc.confirm(c.draft.id, { expected: c.draft, confirmation: dlConf(1, 'dl-init') })
  expect(c1.ok, JSON.stringify(c1)).toBe(true)
  const r = await dsvc.reschedule(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, context: mkContext(FULL) })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  const c2 = await dsvc.confirm(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, confirmation: dlConf(r.draft.revision, 'dl-cur') })
  expect(c2.ok, JSON.stringify(c2)).toBe(true)
  const gen = await dsvc.setStatus(c.draft.id, { expected: c2.draft, status: 'generating' })
  expect(gen.ok, JSON.stringify(gen)).toBe(true)
  const ready = await dsvc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' })
  expect(ready.ok, JSON.stringify(ready)).toBe(true)
  return ready.draft
}
async function readyLinkDraft() {
  await seedBusiness()
  const c = await dsvc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
  const r = await dsvc.reschedule(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, context: mkContext(FULL) })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  const gen = await dsvc.setStatus(c.draft.id, { expected: r.draft, status: 'generating' })
  const ready = await dsvc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' })
  expect(ready.ok, JSON.stringify(ready)).toBe(true)
  return ready.draft
}
const newDocs = async () => (await db.allDocs()).records.filter((d) => !['n-1', 't-1', 'a-1'].includes(d.id))

describe('prepare：固定快照冻结，零写入', () => {
  it('ready 草案 prepare 成功且不写任何库；editing 拒绝 NOT_READY', async () => {
    const d = await readyCreateDraft()
    const before = await db.readAssistantSnapshot()
    const r = await asvc.prepare(d.id, { expected: d })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.envelope.draft_id).toBe(d.id)
    expect(r.envelope.draft_revision).toBe(d.revision)
    expect(r.counts).toEqual({ tasks_created: 1, tasks_updated: 0, actions_created: 1, plan_items_created: 1, plan_items_cancelled: 0, source_fields_confirmed: 0 })
    const after = await db.readAssistantSnapshot()
    expect(after.ops).toEqual([])
    expect(after.drafts.find((x) => x.id === d.id).status).toBe('ready')
    expect(after.docs.map((x) => x.id).sort()).toEqual(before.docs.map((x) => x.id).sort())
    const editing = await dsvc.create({ proposal: mkProposal() })
    const nr = await asvc.prepare(editing.draft.id, { expected: editing.draft })
    expect(nr.code).toBe('NOT_READY')
  })

  it('就绪后新增窗口占用 / 删除证据资料 → prepare READY_BLOCKED，不冻结', async () => {
    const d = await readyCreateDraft()
    await db.putDoc(planDoc('p-late', { planned_minutes: 90 }))
    const r1 = await asvc.prepare(d.id, { expected: d })
    expect(r1.ok).toBe(false)
    expect(r1.code).toBe('READY_BLOCKED')
    expect(r1.blockers.some((b) => b.code === 'OCCUPANCY_ADDED')).toBe(true)
    await db.deleteDoc('p-late')
    await deleteSourceRaw('s-1')
    const r2 = await asvc.prepare(d.id, { expected: d })
    expect(r2.ok).toBe(false)
    expect(r2.code).toBe('READY_BLOCKED')
    expect((await db.readAssistantSnapshot()).ops).toEqual([])
  })
})

describe('apply：单事务整体提交与去重', () => {
  it('正例：任务/行动/安排+回执+applied+线程消息同事务；order 在既有之后；截止=已确认事实', async () => {
    const d = await readyCreateDraft()
    await db.putDoc({ id: 't-2', kind: 'task', title: '虚构目标二', status: 'todo', deadline: { value: null, precision: 'none' } })
    await db.putDoc(planDoc('p-old', { task_id: 't-2', order: 5 }))
    // 既有占用变化后须重排才就绪（事实基线冻结）。
    const r0 = await dsvc.reschedule(d.id, { expected: (await dsvc.get(d.id)).baseline.draft, context: mkContext(FULL) })
    expect(r0.ok, JSON.stringify(r0)).toBe(true)
    const c2 = await dsvc.confirm(d.id, { expected: (await dsvc.get(d.id)).baseline.draft, confirmation: dlConf(r0.draft.revision, 'dl-cur2') })
    const gen = await dsvc.setStatus(d.id, { expected: c2.draft, status: 'generating' })
    const ready = await dsvc.setStatus(d.id, { expected: gen.draft, status: 'ready' })
    expect(ready.ok, JSON.stringify(ready)).toBe(true)
    const prep = await asvc.prepare(ready.draft.id, { expected: ready.draft })
    expect(prep.ok, JSON.stringify(prep)).toBe(true)
    const r = await asvc.apply(ready.draft.id, { expected: ready.draft, envelope: prep.envelope })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.outcome).toBe('committed')
    expect(r.counts).toEqual({ tasks_created: 1, tasks_updated: 0, actions_created: 1, plan_items_created: 1, plan_items_cancelled: 0, source_fields_confirmed: 0 })
    const docs = (await newDocs()).filter((x) => !['t-2', 'p-old'].includes(x.id))
    expect(docs.filter((x) => x.kind === 'task')).toHaveLength(1)
    const task = docs.find((x) => x.kind === 'task')
    expect(task.deadline).toEqual({ ...DL, source: 'note', from_note_id: 'n-1', confirmed_at: TS })
    expect(task.note_ids).toEqual(['n-1'])
    expect(task.workspace_id).toBe('w1')
    const action = docs.find((x) => x.kind === 'action')
    expect(action.task_id).toBe(task.id)
    const plan = docs.find((x) => x.kind === 'plan_item')
    expect(plan.task_id).toBe(task.id)
    const { adoptedActionForPlan } = await import('../composables/useScheduledAction')
    expect(adoptedActionForPlan((await db.workspaceAssistantDrafts()).records, plan.id)).toEqual({ actionId: action.id })
    expect(plan.order).toBe(6) // 既有 p-old order 5 之后
    expect(plan.state).toBe('planned')
    const snap = await db.readAssistantSnapshot()
    const after = snap.drafts.find((x) => x.id === d.id)
    expect(after.status).toBe('applied')
    expect(after.applied_summary.application_id).toBe(prep.envelope.application_id)
    expect(after.applied_summary.counts.plan_items_created).toBe(1)
    const op = snap.ops.find((o) => o.application_id === prep.envelope.application_id)
    expect(op.state).toBe('committed')
    expect(op.receipt.id_map).toEqual(prep.envelope.id_map)
    const thread = snap.threads.find((t) => t.id === after.thread_id)
    expect(thread.messages.some((m) => m.type === 'adoption_result' && m.content.includes('1 个任务'))).toBe(true)
  })

  it('双击/双标签：并发两次 apply 只产生一份写入；第二次已成功', async () => {
    const d = await readyCreateDraft()
    const prep = await asvc.prepare(d.id, { expected: d })
    const [r1, r2] = await Promise.all([
      asvc.apply(d.id, { expected: d, envelope: prep.envelope }),
      asvc.apply(d.id, { expected: d, envelope: prep.envelope }),
    ])
    expect(r1.ok && r2.ok, JSON.stringify([r1, r2])).toBe(true)
    expect([r1.outcome, r2.outcome].sort()).toEqual(['already_committed', 'committed'])
    expect((await newDocs()).filter((x) => x.kind === 'task')).toHaveLength(1)
    expect((await db.readAssistantSnapshot()).ops).toHaveLength(1)
    // 事后再点：prepare 与 apply 都返回已成功，绝不重复写入。
    const again = await asvc.apply(d.id, { expected: d, envelope: prep.envelope })
    expect(again.outcome).toBe('already_committed')
    const prep2 = await asvc.prepare(d.id, { expected: (await dsvc.get(d.id)).baseline.draft })
    expect(prep2.outcome).toBe('already_committed')
    expect(prep2.envelope.application_id).toBe(prep.envelope.application_id)
    expect((await newDocs()).filter((x) => x.kind === 'task')).toHaveLength(1)
  })

  it('link/reuse：只新增安排，不改既有任务/行动；截止沿用正式值', async () => {
    const d = await readyLinkDraft()
    const prep = await asvc.prepare(d.id, { expected: d })
    expect(prep.counts).toEqual({ tasks_created: 0, tasks_updated: 0, actions_created: 0, plan_items_created: 1, plan_items_cancelled: 0, source_fields_confirmed: 0 })
    const r = await asvc.apply(d.id, { expected: d, envelope: prep.envelope })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const docs = await newDocs()
    expect(docs).toHaveLength(1)
    expect(docs[0].kind).toBe('plan_item')
    expect(docs[0].task_id).toBe('t-1')
    const t1 = (await db.allDocs()).records.find((x) => x.id === 't-1')
    expect(t1.deadline).toEqual({ value: null, precision: 'none' })
    expect((await db.allDocs()).records.find((x) => x.id === 'a-1').minutes).toBe(60)
  })
})

describe('失败保护：整体回滚、漂移、切空间', () => {
  it('中途写入失败 → 确定未提交，业务对象零残留；同意图重试复用冻结信封成功', async () => {
    const d = await readyCreateDraft()
    const prep = await asvc.prepare(d.id, { expected: d })
    const origAdd = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (value, ...rest) {
      if (value && value.kind === 'action') throw new Error('注入写入失败')
      return origAdd.call(this, value, ...rest)
    }
    let r
    try {
      r = await asvc.apply(d.id, { expected: d, envelope: prep.envelope })
    } finally {
      IDBObjectStore.prototype.add = origAdd
    }
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('not_committed')
    expect(await newDocs()).toEqual([]) // 任务 add 也随事务回滚
    const snap = await db.readAssistantSnapshot()
    expect(snap.drafts.find((x) => x.id === d.id).status).toBe('needs_review')
    expect(snap.ops.find((o) => o.application_id === prep.envelope.application_id).state).toBe('pending')
    // 重试：内容未变 → 直接 generating→ready；prepare 复用同一 pending 信封（ID 不重新生成）。
    const gen = await dsvc.setStatus(d.id, { expected: (await dsvc.get(d.id)).baseline.draft, status: 'generating' })
    const ready = await dsvc.setStatus(d.id, { expected: gen.draft, status: 'ready' })
    expect(ready.ok, JSON.stringify(ready)).toBe(true)
    const prep2 = await asvc.prepare(d.id, { expected: ready.draft })
    expect(prep2.reused).toBe(true)
    expect(prep2.envelope.application_id).toBe(prep.envelope.application_id)
    expect(prep2.envelope.id_map).toEqual(prep.envelope.id_map)
    const retry = await asvc.apply(d.id, { expected: ready.draft, envelope: prep2.envelope })
    expect(retry.ok, JSON.stringify(retry)).toBe(true)
    expect(retry.outcome).toBe('committed')
    expect((await newDocs()).filter((x) => x.kind === 'task')).toHaveLength(1)
    expect((await db.readAssistantSnapshot()).ops).toHaveLength(1)
  })

  it('核对后—提交前新增占用（重摘要窗口注入）→ needs_recheck，零业务写入，applying→needs_review', async () => {
    const d = await readyCreateDraft()
    const prep = await asvc.prepare(d.id, { expected: d })
    const origRead = db.readAssistantSnapshot
    vi.spyOn(db, 'readAssistantSnapshot').mockImplementationOnce(async () => {
      const snap = await origRead()
      await db.putDoc(planDoc('p-drift', { planned_minutes: 90 }))
      return snap
    })
    const r = await asvc.apply(d.id, { expected: d, envelope: prep.envelope })
    vi.restoreAllMocks()
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('needs_recheck')
    expect(r.diffs.some((x) => x.code === 'OCCUPANCY_ADDED')).toBe(true)
    expect((await newDocs()).filter((x) => x.id !== 'p-drift')).toEqual([])
    const snap = await db.readAssistantSnapshot()
    expect(snap.drafts.find((x) => x.id === d.id).status).toBe('needs_review')
    expect(snap.ops.find((o) => o.application_id === prep.envelope.application_id).state).toBe('pending')
  })

  it('提交中途切空间 → result_unknown；回原空间 settleRefresh→result_unknown→resolve 确定未提交', async () => {
    const d = await readyCreateDraft()
    const prep = await asvc.prepare(d.id, { expected: d })
    let armed = false
    const origRead = db.readAssistantSnapshot
    vi.spyOn(db, 'readAssistantSnapshot').mockImplementationOnce(async () => {
      const snap = await origRead()
      armed = true
      return snap
    })
    const origGetAll = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args) {
      if (armed && this.name === 'docs') {
        ws = 'w2'
        db.configureWorkspace('w2')
      }
      return origGetAll.apply(this, args)
    }
    let r
    try {
      r = await asvc.apply(d.id, { expected: d, envelope: prep.envelope })
    } finally {
      IDBObjectStore.prototype.getAll = origGetAll
      vi.restoreAllMocks()
      ws = 'w1'
      db.configureWorkspace('w1')
    }
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('result_unknown')
    expect(await newDocs()).toEqual([])
    // 原空间草案停在 applying；刷新结算不得当成未保存，也不得凭空 applied。
    const settled = await dsvc.settleRefresh()
    expect(settled.changed.find((x) => x.id === d.id).status).toBe('result_unknown')
    const resolved = await asvc.resolve(d.id)
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true)
    expect(resolved.outcome).toBe('not_committed')
    expect((await dsvc.get(d.id)).draft.status).toBe('needs_review')
    expect(await newDocs()).toEqual([])
  })
})

describe('刷新结算与结果核实（回执是权威）', () => {
  it('applying/result_unknown + 已提交回执 → applied 并补摘要；pending → 不得 applied', async () => {
    const d = await readyCreateDraft()
    const prep = await asvc.prepare(d.id, { expected: d })
    const r = await asvc.apply(d.id, { expected: d, envelope: prep.envelope })
    expect(r.outcome).toBe('committed')
    const applied = (await dsvc.get(d.id)).draft
    const raw = await openRaw(undefined, () => {})
    // 模拟崩溃回退：状态停在 applying / result_unknown，但回执台账已提交。
    await putRaw(raw, 'assistant_drafts', { ...applied, status: 'applying', applied_summary: null })
    raw.close()
    const s1 = await dsvc.settleRefresh()
    const back = s1.changed.find((x) => x.id === d.id)
    expect(back.status).toBe('applied')
    expect(back.applied_summary.application_id).toBe(prep.envelope.application_id)
    const raw2 = await openRaw(undefined, () => {})
    await putRaw(raw2, 'assistant_drafts', { ...applied, status: 'result_unknown', applied_summary: null })
    raw2.close()
    const s2 = await dsvc.settleRefresh()
    expect(s2.changed.find((x) => x.id === d.id).status).toBe('applied')
    // 只有 pending 台账（业务写入确定未发生）：applying→result_unknown，绝不 applied。
    const d2 = await readyLinkDraft()
    const prep2 = await asvc.prepare(d2.id, { expected: d2 })
    expect(prep2.ok, JSON.stringify(prep2)).toBe(true)
    const raw3 = await openRaw(undefined, () => {})
    await putRaw(raw3, 'assistant_drafts', { ...d2, status: 'applying' })
    await putRaw(raw3, 'assistant_ops', {
      application_id: 'app-pending', workspace_id: 'w1', state: 'pending',
      envelope: { ...prep2.envelope, application_id: 'app-pending' },
      receipt: null, created_at: TS, updated_at: TS,
    })
    raw3.close()
    const s3 = await dsvc.settleRefresh()
    expect(s3.changed.find((x) => x.id === d2.id).status).toBe('result_unknown')
    const resolved = await asvc.resolve(d2.id)
    expect(resolved.outcome).toBe('not_committed')
    expect((await dsvc.get(d2.id)).draft.status).toBe('needs_review')
  })

  it('resolve 只处理 result_unknown；其它状态 STATUS_LOCKED', async () => {
    const d = await readyCreateDraft()
    const r = await asvc.resolve(d.id)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('STATUS_LOCKED')
  })

  it('applying/applied/result_unknown 禁止追加确认；applying/result_unknown 禁止放弃', async () => {
    const c = await dsvc.create({ proposal: mkProposal() })
    const raw = await openRaw(undefined, () => {})
    for (const status of ['applying', 'applied', 'result_unknown']) {
      await putRaw(raw, 'assistant_drafts', { ...c.draft, id: `d-${status}`, status })
    }
    raw.close()
    for (const status of ['applying', 'applied', 'result_unknown']) {
      const g = await dsvc.get(`d-${status}`)
      const cf = await dsvc.confirm(`d-${status}`, { expected: g.baseline.draft, confirmation: conf('gap', 'w1', 1, `c-${status}`) })
      expect(cf.code, status).toBe('STATUS_LOCKED')
    }
    for (const status of ['applying', 'result_unknown']) {
      const g = await dsvc.get(`d-${status}`)
      const dd = await dsvc.discard(`d-${status}`, { expected: g.baseline.draft })
      expect(dd.code, status).toBe('STATUS_LOCKED')
    }
  })
})

describe('缺口/过载独立确认后才可采用', () => {
  it('七天后的活动确认日期后可重新打开并采用到实际日程', async () => {
    await seedBusiness()
    const date = '2026-12-13'
    const proposal = mkProposal({ evidence_refs: [EV_SRC] })
    proposal.work_items[0].earliest_date = date
    const c = await dsvc.create({ proposal })
    const r = await dsvc.reschedule(c.draft.id, { expected: c.draft, context: mkContext(FULL) })
    expect(r.draft.planning_result.unscheduled[0].reason).toBe('outside_horizon')
    const confirmed = await dsvc.confirm(c.draft.id, { expected: r.draft, confirmation: {
      ...conf('gap', 'w1', r.draft.revision, 'future'), field_path: 'manual_slot', new_value: { date, time: '', allowExtra: false },
    } })
    expect(confirmed.ok).toBe(true)
    const reloaded = await dsvc.get(c.draft.id)
    const gen = await dsvc.setStatus(c.draft.id, { expected: reloaded.baseline.draft, status: 'generating' })
    const ready = await dsvc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' })
    const prepared = await asvc.prepare(c.draft.id, { expected: ready.draft })
    expect(prepared.envelope.planned_gaps).toEqual([])
    expect((await asvc.apply(c.draft.id, { expected: ready.draft, envelope: prepared.envelope })).ok).toBe(true)
    expect(await newDocs()).toEqual([expect.objectContaining({ kind: 'plan_item', date, action_text: proposal.work_items[0].deliverable })])
  })
  it('手选缺口时间后只补剩余量，刷新、采用、查回行动和改排选项一致', async () => {
    await seedBusiness()
    const c = await dsvc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const r = await dsvc.reschedule(c.draft.id, { expected: c.draft, context: mkContext([40, 0, 0, 0, 0, 0, 0]) })
    const gap = r.draft.planning_result.unscheduled[0]
    expect(gap.remaining_minutes).toBe(26)
    const choice = { ...conf('gap', 'w1', r.draft.revision, 'manual'), field_path: 'manual_slot',
      new_value: { date: '2026-11-25', time: '14:00', allowExtra: false } }
    const send = () => dsvc.confirm(c.draft.id, { expected: r.draft, confirmation: choice })
    expect((await send()).code).toBe('MANUAL_SLOT_INVALID')
    choice.new_value.allowExtra = true
    expect((await send()).ok).toBe(true)
    const reloaded = (await dsvc.get(c.draft.id)).baseline.draft
    const gen = await dsvc.setStatus(c.draft.id, { expected: reloaded, status: 'generating' })
    const ready = await dsvc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' })
    const prepared = await asvc.prepare(c.draft.id, { expected: ready.draft })
    expect(prepared.envelope.planned_gaps).toEqual([])
    expect(prepared.envelope.write_set.plan_items_create.map(p => p.planned_minutes)).toEqual([34, 26])
    expect(await newDocs()).toHaveLength(0)
    const applied = await asvc.apply(c.draft.id, { expected: ready.draft, envelope: prepared.envelope })
    expect(applied.ok, JSON.stringify(applied)).toBe(true)
    const plans = await newDocs()
    const manual = plans.find(p => p.date === '2026-11-25')
    expect(manual.action_text).toContain('14:00')
    const { adoptedPlanActions, unallocatedActions } = await import('../domains/assistant/scheduledActions')
    const drafts = (await db.workspaceAssistantDrafts()).records
    const bindings = adoptedPlanActions(drafts)
    expect(bindings.get(manual.id)).toBe('a-1')
    const actions = [{ id: 'a-1', minutes: 60 }, { id: 'a-2', minutes: 10 }, { id: 'done', done: true, minutes: 20 }]
    expect(unallocatedActions(actions, plans, bindings, new Set()).map(a => a.id)).toEqual(['a-2'])
    expect(unallocatedActions(actions, plans, bindings, new Set([manual.id]))[0].remaining).toBe(26)
    manual.state = 'cancelled'
    expect(unallocatedActions(actions, plans, bindings, new Set())[0].remaining).toBe(26)
  })
  it('既有过载日 + 未排工作：逐项确认后 envelope 双确认标记为真；采用保留未排事实', async () => {
    await seedBusiness()
    await db.putDoc(planDoc('p-big', { planned_minutes: 200, order: 1 }))
    const c = await dsvc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const ack = await dsvc.confirm(c.draft.id, { expected: c.draft, confirmation: conf('extra_work', 'w1', 1, 'ew-1') })
    expect(ack.ok, JSON.stringify(ack)).toBe(true)
    const r = await dsvc.reschedule(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, context: mkContext([120, 0, 0, 0, 0, 0, 0]) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.draft.planning_result.days[0].overbooked_minutes).toBe(98)
    expect(r.draft.planning_result.unscheduled.some((u) => u.work_item_key === 'w1')).toBe(true)
    const rev = r.draft.revision
    let base = (await dsvc.get(c.draft.id)).baseline.draft
    for (const [type, key, id] of [['extra_work', 'w1', 'ew-2'], ['gap', 'w1', 'gap-1'], ['overbook', START, 'ob-1']]) {
      const cf = await dsvc.confirm(c.draft.id, { expected: base, confirmation: conf(type, key, rev, id) })
      expect(cf.ok, JSON.stringify(cf)).toBe(true)
      base = cf.draft
    }
    const gen = await dsvc.setStatus(c.draft.id, { expected: base, status: 'generating' })
    const ready = await dsvc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' })
    expect(ready.ok, JSON.stringify(ready)).toBe(true)
    const prep = await asvc.prepare(ready.draft.id, { expected: ready.draft })
    expect(prep.ok, JSON.stringify(prep)).toBe(true)
    expect(prep.envelope.gap_acknowledged).toBe(true)
    expect(prep.envelope.overbook_acknowledged).toBe(true)
    expect(prep.envelope.existing_overbook_dates).toEqual([START])
    expect(prep.envelope.planned_gaps).toHaveLength(1)
    const applied = await asvc.apply(ready.draft.id, { expected: ready.draft, envelope: prep.envelope })
    expect(applied.ok, JSON.stringify(applied)).toBe(true)
    expect(applied.counts.plan_items_created).toBe(0)
    expect(applied.receipt.unscheduled_kept).toHaveLength(1)
    expect((await newDocs()).filter((x) => x.kind === 'plan_item' && x.id !== 'p-big')).toEqual([])
    // 未确认缺口时 prepare 必须被就绪推导阻断（负向：不放宽）。
    const c2 = await dsvc.create({ proposal: mkProposal({ evidence_refs: [EV_SRC] }) })
    const ack2 = await dsvc.confirm(c2.draft.id, { expected: c2.draft, confirmation: conf('extra_work', 'w1', 1, 'ew-3') })
    const r2 = await dsvc.reschedule(c2.draft.id, { expected: ack2.draft, context: mkContext([120, 0, 0, 0, 0, 0, 0]) })
    expect(r2.ok).toBe(true)
    const gen2 = await dsvc.setStatus(c2.draft.id, { expected: (await dsvc.get(c2.draft.id)).baseline.draft, status: 'generating' })
    const blocked = await dsvc.setStatus(c2.draft.id, { expected: gen2.draft, status: 'ready' })
    expect(blocked.ok).toBe(false)
    expect(blocked.blockers.some((b) => b.code === 'GAP_UNCONFIRMED')).toBe(true)
    expect(blocked.blockers.some((b) => b.code === 'OVERBOOK_UNCONFIRMED')).toBe(true)
  })
})

// M1 人工审查（2026-11-25）反例转正：R1 写集绑定 / R4 排除范围 / R5 复用行动内容漂移。
describe('M1 审查回归：提交内容必须与冻结草案一致', () => {
  it('R1：篡改准备结果分钟 60→999 → apply 拒绝，零写入，草案仍 ready、无台账', async () => {
    const d = await readyCreateDraft()
    const p = await asvc.prepare(d.id, { expected: d })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    p.envelope.write_set.plan_items_create[0].planned_minutes = 999
    const r = await asvc.apply(d.id, { expected: d, envelope: p.envelope })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('WRITE_SET_MISMATCH')
    expect(r.outcome).toBe('not_committed')
    expect(await newDocs()).toEqual([])
    const snap = await db.readAssistantSnapshot()
    expect(snap.drafts.find((x) => x.id === d.id).status).toBe('ready')
    expect(snap.ops).toEqual([])
  })

  it('R1：篡改信封签名 → SIGNATURE_MISMATCH，零写入', async () => {
    const d = await readyCreateDraft()
    const p = await asvc.prepare(d.id, { expected: d })
    const r = await asvc.apply(d.id, { expected: d, envelope: { ...p.envelope, input_signature: 'b'.repeat(64) } })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('SIGNATURE_MISMATCH')
    expect(await newDocs()).toEqual([])
  })

  it('R1：深拷贝冻结——提交后调用方再改对象不影响本次落库内容', async () => {
    const d = await readyCreateDraft()
    const p = await asvc.prepare(d.id, { expected: d })
    const env = p.envelope
    const pending = asvc.apply(d.id, { expected: d, envelope: env })
    env.write_set.plan_items_create[0].planned_minutes = 999
    const r = await pending
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const plan = (await newDocs()).find((x) => x.kind === 'plan_item')
    expect(plan.planned_minutes).toBe(60)
  })

  it('R5：复用行动在预览后被改正文/估时 → needs_recheck，零业务写入，applying→needs_review', async () => {
    const d = await readyLinkDraft()
    const p = await asvc.prepare(d.id, { expected: d })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    const a = (await db.allDocs()).records.find((x) => x.id === 'a-1')
    await db.putDoc({ ...a, text: '预览后被改动', minutes: 999 })
    const r = await asvc.apply(d.id, { expected: d, envelope: p.envelope })
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('needs_recheck')
    expect(r.diffs.some((x) => x.code === 'ACTION_CONTENT_CHANGED')).toBe(true)
    expect(await newDocs()).toEqual([])
    const snap = await db.readAssistantSnapshot()
    expect(snap.drafts.find((x) => x.id === d.id).status).toBe('needs_review')
    expect((await db.allDocs()).records.find((x) => x.id === 'a-1').minutes).toBe(999)
  })

  it('R4：真实保存的排除草案 → prepare 显式 NO_ADOPTABLE_CHANGES，零写入', async () => {
    const d = await readyCreateDraft()
    const e = await dsvc.edit(d.id, { expected: d, edits: { excluded_items: [{ work_item_key: 'w1', excluded_by: 'user', reason: 'not wanted' }] } })
    expect(e.ok, JSON.stringify(e)).toBe(true)
    const c1 = await dsvc.confirm(d.id, { expected: e.draft, confirmation: dlConf(e.draft.revision, 'exclude-dl') })
    expect(c1.ok, JSON.stringify(c1)).toBe(true)
    const r = await dsvc.reschedule(d.id, { expected: c1.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const c2 = await dsvc.confirm(d.id, { expected: r.draft, confirmation: dlConf(r.draft.revision, 'exclude-dl2') })
    expect(c2.ok, JSON.stringify(c2)).toBe(true)
    const g = await dsvc.setStatus(d.id, { expected: c2.draft, status: 'generating' })
    expect(g.ok, JSON.stringify(g)).toBe(true)
    const ready = await dsvc.setStatus(d.id, { expected: g.draft, status: 'ready' })
    expect(ready.ok, JSON.stringify(ready)).toBe(true)
    expect(ready.draft.planning_result.segments).toEqual([])
    const prep = await asvc.prepare(d.id, { expected: ready.draft })
    expect(prep.ok).toBe(false)
    expect(prep.code).toBe('NO_ADOPTABLE_CHANGES')
    expect(await newDocs()).toEqual([])
    expect((await db.readAssistantSnapshot()).ops).toEqual([])
  })
})

// M1 复验（2026-11-25）F1/F2 反例转正：截止出处字段级核对 + 旧草案行动基线覆盖。
describe('M1 复验 F1：截止出处必须是已确认且匹配的具体便签字段', () => {
  it('F1：便签 fields=[] → prepare DEADLINE_PROVENANCE_REQUIRED，零写入（复验原反例）', async () => {
    const d = await readyCreateDraft([])
    const before = await dsvc.get(d.id)
    expect(before.adoptionReadiness.ready).toBe(false)
    expect(before.adoptionReadiness.blockers[0].code).toBe('DEADLINE_PROVENANCE_REQUIRED')
    const p = await asvc.prepare(d.id, { expected: d })
    expect(p.ok).toBe(false)
    expect(p.code).toBe('DEADLINE_PROVENANCE_REQUIRED')
    expect(await newDocs()).toEqual([])
    expect((await db.readAssistantSnapshot()).ops).toEqual([])
  })

  it('F1：合法出处 → 事实基线冻结该 deadline 字段（要求 4）', async () => {
    const d = await readyCreateDraft()
    const b = d.fact_baseline.note_field_baselines.find((x) => x.note_id === 'n-1' && x.field_key === 'deadline')
    expect(b).toMatchObject({ value: DL.value, status: 'confirmed', origin: 'model', derived: false })
  })

  it('F1：预览后出处字段变值 → prepare READY_BLOCKED（NOTE_FIELD_CHANGED）', async () => {
    const d = await readyCreateDraft()
    const p = await asvc.prepare(d.id, { expected: d })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    const n = (await db.allDocs()).records.find((x) => x.id === 'n-1')
    await db.putDoc({ ...n, fields: [{ ...DL_FIELD, value: '2026-12-02' }] })
    const p2 = await asvc.prepare(d.id, { expected: d })
    expect(p2.ok).toBe(false)
    expect(p2.code).toBe('READY_BLOCKED')
    expect(p2.blockers.some((x) => x.code === 'NOTE_FIELD_CHANGED')).toBe(true)
  })

  it('F1：预览后出处字段变值 → apply 阻断，零业务写入，草案仍 ready', async () => {
    const d = await readyCreateDraft()
    const p = await asvc.prepare(d.id, { expected: d })
    const n = (await db.allDocs()).records.find((x) => x.id === 'n-1')
    await db.putDoc({ ...n, fields: [{ ...DL_FIELD, value: '2026-12-02' }] })
    const r = await asvc.apply(d.id, { expected: d, envelope: p.envelope })
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('not_committed')
    expect(await newDocs()).toEqual([])
    expect((await db.readAssistantSnapshot()).drafts.find((x) => x.id === d.id).status).toBe('ready')
  })

  it('F1：预览后取消确认（status=candidate）→ apply 阻断，零写入', async () => {
    const d = await readyCreateDraft()
    const p = await asvc.prepare(d.id, { expected: d })
    const n = (await db.allDocs()).records.find((x) => x.id === 'n-1')
    await db.putDoc({ ...n, fields: [{ ...DL_FIELD, status: 'candidate' }] })
    const r = await asvc.apply(d.id, { expected: d, envelope: p.envelope })
    expect(r.ok).toBe(false)
    expect(await newDocs()).toEqual([])
  })

  it('F1：预览后删除出处字段 → apply 阻断，零写入', async () => {
    const d = await readyCreateDraft()
    const p = await asvc.prepare(d.id, { expected: d })
    const n = (await db.allDocs()).records.find((x) => x.id === 'n-1')
    await db.putDoc({ ...n, fields: [] })
    const r = await asvc.apply(d.id, { expected: d, envelope: p.envelope })
    expect(r.ok).toBe(false)
    expect(await newDocs()).toEqual([])
  })
})

describe('M1 复验 F2：旧草案缺行动基线不得绕过并发校验', () => {
  const legacyLink = async (mutate) => {
    const d = await readyLinkDraft()
    mutate(d)
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'assistant_drafts', d)
    raw.close()
    return d
  }

  it('F2：无 action_facts 字段 → prepare READY_BLOCKED（ACTION_BASELINE_MISSING），仍可查看', async () => {
    const d = await legacyLink((x) => { delete x.fact_baseline.action_facts })
    const p = await asvc.prepare(d.id, { expected: d })
    expect(p.ok).toBe(false)
    expect(p.code).toBe('READY_BLOCKED')
    expect(p.blockers.some((x) => x.code === 'ACTION_BASELINE_MISSING')).toBe(true)
    expect((await dsvc.get(d.id)).ok).toBe(true)
    expect(await newDocs()).toEqual([])
  })

  it('F2：action_facts 空列表 → 阻断', async () => {
    const d = await legacyLink((x) => { x.fact_baseline.action_facts = [] })
    const p = await asvc.prepare(d.id, { expected: d })
    expect(p.ok).toBe(false)
    expect(p.blockers.some((x) => x.code === 'ACTION_BASELINE_MISSING')).toBe(true)
  })

  it('F2：部分漏项（两条复用行动只冻结一条）→ 阻断', async () => {
    await seedBusiness()
    await db.putDoc({ id: 'a-2', kind: 'action', task_id: 't-1', text: '虚构步骤二', minutes: 40, done: false })
    const proposal = mkProposal({
      evidence_refs: [EV_SRC],
      work_items: [
        mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } }),
        mkWork('w2', { action_ref: { kind: 'existing', id: 'a-2' } }),
      ],
    })
    const c = await dsvc.create({ proposal })
    expect(c.ok, JSON.stringify(c)).toBe(true)
    const r = await dsvc.reschedule(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const g = await dsvc.setStatus(c.draft.id, { expected: r.draft, status: 'generating' })
    const ready = await dsvc.setStatus(c.draft.id, { expected: g.draft, status: 'ready' })
    expect(ready.ok, JSON.stringify(ready)).toBe(true)
    expect(ready.draft.fact_baseline.action_facts).toHaveLength(2)
    const d = ready.draft
    d.fact_baseline.action_facts = d.fact_baseline.action_facts.filter((f) => f.action_ref.id === 'a-1')
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'assistant_drafts', d)
    raw.close()
    const p = await asvc.prepare(d.id, { expected: d })
    expect(p.ok).toBe(false)
    expect(p.blockers.some((x) => x.code === 'ACTION_BASELINE_MISSING' && x.message.includes('a-2'))).toBe(true)
  })

  it('F2：仅新建行动的草案无需已有行动基线 → prepare 正常', async () => {
    const d = await readyCreateDraft()
    d.fact_baseline.action_facts = []
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'assistant_drafts', d)
    raw.close()
    const p = await asvc.prepare(d.id, { expected: d })
    expect(p.ok, JSON.stringify(p)).toBe(true)
  })

  it('F2：重新排程补全基线后通过；之后改行动仍被检出', async () => {
    const d = await legacyLink((x) => { delete x.fact_baseline.action_facts })
    const r = await dsvc.reschedule(d.id, { expected: d, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.draft.fact_baseline.action_facts).toHaveLength(1)
    const g = await dsvc.setStatus(d.id, { expected: r.draft, status: 'generating' })
    const ready = await dsvc.setStatus(d.id, { expected: g.draft, status: 'ready' })
    expect(ready.ok, JSON.stringify(ready)).toBe(true)
    const p = await asvc.prepare(d.id, { expected: ready.draft })
    expect(p.ok, JSON.stringify(p)).toBe(true)
    const a = (await db.allDocs()).records.find((x) => x.id === 'a-1')
    await db.putDoc({ ...a, text: '重排后又被改动', minutes: 999 })
    const out = await asvc.apply(d.id, { expected: ready.draft, envelope: p.envelope })
    expect(out.ok).toBe(false)
    expect(out.outcome).toBe('needs_recheck')
    expect(out.diffs.some((x) => x.code === 'ACTION_CONTENT_CHANGED')).toBe(true)
    expect(await newDocs()).toEqual([])
  })
})
