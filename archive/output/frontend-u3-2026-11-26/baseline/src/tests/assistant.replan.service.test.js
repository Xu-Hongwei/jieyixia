// M3 改排采用服务单测（fake-indexeddb；全部虚构数据）。
// 覆盖：本地替换闭环（范围确认→重排→当前版再确认→prepare→apply 取消+新增同事务）、
// 受保护项拒绝、双击幂等、内容漂移/会话引用 needs_recheck、注入失败整体回滚+同意图重试、
// 零新增拒绝、create 夹带改排字段拒绝、fork 清除计算与基线、总截止与未选安排不变。
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkContext, START } from './planning.helpers.js'
import { buildReplanProposal } from '../domains/assistant/replan.js'
import { beijingAddDays } from '../domains/time.js'

const TS = '2026-11-24T10:00:00+08:00'
const FULL = [120, 120, 120, 120, 120, 120, 120]
const D = (n) => beijingAddDays(START, n)

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

const planDoc = (id, over = {}) => ({
  id, kind: 'plan_item', task_id: 't-1', date: START, planned_minutes: 30, action_text: '虚构安排',
  state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over,
})
async function seed() {
  await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' } })
  await db.putDoc({ id: 't-2', kind: 'task', title: '虚构目标二', status: 'todo', deadline: { value: null, precision: 'none' } })
  await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false })
  await db.putDoc(planDoc('p-1', { date: D(0), planned_minutes: 30 }))
  await db.putDoc(planDoc('p-2', { date: D(1), planned_minutes: 45 }))
  await db.putDoc(planDoc('p-keep', { date: D(2), planned_minutes: 20 }))
  await db.putDoc(planDoc('p-prot', { date: D(3), planned_minutes: 30, actual_minutes: 10 }))
  await db.putDoc(planDoc('p-foc', { date: D(4), planned_minutes: 30 }))
  await db.putDoc(planDoc('p-other', { date: D(0), task_id: 't-2', planned_minutes: 60 }))
  await db.putDoc({ id: 'f-1', kind: 'focus_session', plan_item_id: 'p-foc', state: 'ended' })
}
const SEED_IDS = ['t-1', 't-2', 'a-1', 'p-1', 'p-2', 'p-keep', 'p-prot', 'p-foc', 'p-other', 'f-1']
const newDocs = async () => (await db.allDocs()).records.filter((d) => !SEED_IDS.includes(d.id))
const docById = async (id) => (await db.allDocs()).records.find((d) => d.id === id)

const progress = {
  statement: '资料读完了，报告还需安排 90 分钟',
  work_items: [{ key: 'rw1', text: '写报告', reuse_action_id: null, minutes: 90, splittable: true, min_segment_minutes: 25 }],
}
const scope = { task_id: 't-1', start_date: START, replacement_ids: ['p-1', 'p-2'] }
const scopeConf = (rev, id) => ({
  confirmation_id: id, draft_revision: rev, object_type: 'replan_scope',
  object_id_or_key: 't-1', field_path: '', old_value: null, new_value: true, confirmed_at: TS,
})
const gapConf = (rev, id) => ({
  confirmation_id: id, draft_revision: rev, object_type: 'gap',
  object_id_or_key: 'rw1', field_path: '', old_value: null, new_value: true, confirmed_at: TS,
})
async function createReplan(over = {}, constraints = []) {
  const docs = (await db.allDocs()).records
  const proposal = buildReplanProposal(progress, docs.find((d) => d.id === 't-1'), docs.filter((d) => d.kind === 'action'), constraints)
  return dsvc.create({ mode: 'replan', replanScope: scope, progressInput: progress, proposal, ...over })
}

// 改排闭环到 ready：首排澄清范围 → 确认 → 重排（增版）→ 当前版再确认 → generating → ready。
async function readyReplanDraft(budgets = FULL) {
  const c = await createReplan()
  expect(c.ok, JSON.stringify(c)).toBe(true)
  const r1 = await dsvc.reschedule(c.draft.id, { expected: c.draft, context: mkContext(budgets) })
  expect(r1.ok).toBe(false)
  expect(r1.code).toBe('NEEDS_CLARIFICATION')
  expect(r1.clarifications[0].question_id).toBe('q-replan-scope')
  const s1 = await dsvc.confirm(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, confirmation: scopeConf(1, 'sc-init') })
  expect(s1.ok, JSON.stringify(s1)).toBe(true)
  const r2 = await dsvc.reschedule(c.draft.id, { expected: s1.draft, context: mkContext(budgets) })
  expect(r2.ok, JSON.stringify(r2)).toBe(true)
  return { c, r2 }
}
async function confirmCurrentAndReady(draftId, revision, extraConfs = []) {
  let base = (await dsvc.get(draftId)).baseline.draft
  for (const conf of [scopeConf(revision, 'sc-cur'), ...extraConfs]) {
    const r = await dsvc.confirm(draftId, { expected: base, confirmation: conf })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    base = r.draft
  }
  const gen = await dsvc.setStatus(draftId, { expected: base, status: 'generating' })
  expect(gen.ok, JSON.stringify(gen)).toBe(true)
  const ready = await dsvc.setStatus(draftId, { expected: gen.draft, status: 'ready' })
  expect(ready.ok, JSON.stringify(ready)).toBe(true)
  return ready.draft
}

describe('本地替换闭环', () => {
  it('范围确认→重排→采用：取消+新增同事务；未选安排/总截止/既有行动不变', async () => {
    await seed()
    const { c, r2 } = await readyReplanDraft()
    // 增版后旧范围确认失效：当前版未确认时 ready 推导阻断。
    const g = await dsvc.get(c.draft.id)
    expect(g.readiness.blockers.some((b) => b.code === 'REPLAN_SCOPE_UNCONFIRMED')).toBe(true)
    // 排程输入：有效占用排除 R；事实基线保留完整 O。
    expect(r2.draft.planning_input.replacement_ids).toEqual(['p-1', 'p-2'])
    const occIds = r2.draft.planning_input.occupancy.map((o) => o.plan_item_id)
    expect(occIds).not.toContain('p-1')
    expect(occIds).not.toContain('p-2')
    expect(occIds).toContain('p-keep')
    const baseOcc = r2.draft.fact_baseline.occupancy.map((o) => o.plan_item_id)
    expect(baseOcc).toContain('p-1')
    expect(baseOcc).toContain('p-2')
    expect(r2.draft.replacement_baseline.items.map((i) => i.plan_item_id)).toEqual(['p-1', 'p-2'])

    const ready = await confirmCurrentAndReady(c.draft.id, r2.draft.revision)
    const prep = await asvc.prepare(c.draft.id, { expected: ready })
    expect(prep.ok, JSON.stringify(prep)).toBe(true)
    expect(prep.envelope.mode).toBe('replan')
    expect(prep.envelope.replan_scope).toEqual(scope)
    expect(prep.envelope.replacement_baseline.items).toHaveLength(2)
    expect(prep.envelope.write_set.plan_items_cancel.map((x) => x.plan_item_id)).toEqual(['p-1', 'p-2'])
    expect(prep.counts.plan_items_cancelled).toBe(2)
    expect(prep.counts.plan_items_created).toBeGreaterThan(0)
    expect(prep.counts.tasks_created).toBe(0)

    const r = await asvc.apply(c.draft.id, { expected: ready, envelope: prep.envelope })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.outcome).toBe('committed')
    expect(r.receipt.cancelled_plan_item_ids).toEqual(['p-1', 'p-2'])
    expect(r.receipt.replan_task_id).toBe('t-1')
    expect(r.counts.plan_items_cancelled).toBe(2)
    // 取消只改 state，其余语义字段逐字保留。
    const p1 = await docById('p-1')
    expect(p1.state).toBe('cancelled')
    expect(p1.planned_minutes).toBe(30)
    expect(p1.date).toBe(D(0))
    expect(p1.action_text).toBe('虚构安排')
    expect((await docById('p-2')).state).toBe('cancelled')
    // 未选安排（含受保护与其它任务）原样保留。
    for (const id of ['p-keep', 'p-prot', 'p-foc', 'p-other']) {
      expect((await docById(id)).state).toBe('planned')
    }
    // 总截止不变；既有行动不改；新增安排归属目标任务。
    expect((await docById('t-1')).deadline).toEqual({ value: null, precision: 'none' })
    expect((await docById('a-1')).minutes).toBe(60)
    const added = await newDocs()
    expect(added.filter((d) => d.kind === 'plan_item').every((d) => d.task_id === 't-1')).toBe(true)
    expect(added.filter((d) => d.kind === 'plan_item').reduce((s, d) => s + d.planned_minutes, 0)).toBe(90)
    expect(added.filter((d) => d.kind === 'task')).toHaveLength(0)
    // 摘要与线程消息。
    expect(r.draft.status).toBe('applied')
    expect(r.draft.applied_summary.cancelled_plan_item_ids).toEqual(['p-1', 'p-2'])
    expect(r.draft.applied_summary.replan_task_id).toBe('t-1')
    const thread = (await db.readAssistantSnapshot()).threads.find((t) => t.id === c.draft.thread_id)
    expect(thread.messages.some((m) => m.type === 'adoption_result' && /取消 2 条旧安排/.test(m.content))).toBe(true)
  })

  it('双击/重复 apply：already_committed，不产生第二份写入', async () => {
    await seed()
    const { c, r2 } = await readyReplanDraft()
    const ready = await confirmCurrentAndReady(c.draft.id, r2.draft.revision)
    const prep = await asvc.prepare(c.draft.id, { expected: ready })
    const r1 = await asvc.apply(c.draft.id, { expected: ready, envelope: prep.envelope })
    expect(r1.outcome).toBe('committed')
    const docsAfter = (await db.allDocs()).records
    const r2nd = await asvc.apply(c.draft.id, { expected: ready, envelope: prep.envelope })
    expect(r2nd.ok).toBe(true)
    expect(r2nd.outcome).toBe('already_committed')
    expect((await db.allDocs()).records).toEqual(docsAfter)
    expect((await db.readAssistantSnapshot()).ops).toHaveLength(1)
  })

  it('约束往返：最早日期/依赖/优先级随保存进入排程输入并约束最终安排（F2）', async () => {
    await seed()
    const constraints = [{ earliest_date: D(2), depends_on: [], priority: 'high' }]
    const c = await createReplan({}, constraints)
    expect(c.ok, JSON.stringify(c)).toBe(true)
    expect(c.draft.proposal.work_items[0]).toMatchObject({ earliest_date: D(2), depends_on: [], priority: 'high', estimate_origin: 'user' })
    // 保存 round-trip：草案读回仍保留约束（progress_input 不含约束，约束只在 proposal）。
    expect((await dsvc.get(c.draft.id)).baseline.draft.proposal.work_items[0].earliest_date).toBe(D(2))
    const r1 = await dsvc.reschedule(c.draft.id, { expected: c.draft, context: mkContext(FULL) })
    expect(r1.code).toBe('NEEDS_CLARIFICATION')
    const s1 = await dsvc.confirm(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, confirmation: scopeConf(1, 'sc-init') })
    expect(s1.ok, JSON.stringify(s1)).toBe(true)
    const r2 = await dsvc.reschedule(c.draft.id, { expected: s1.draft, context: mkContext(FULL) })
    expect(r2.ok, JSON.stringify(r2)).toBe(true)
    const segs = r2.draft.planning_result.segments
    expect(segs.length).toBeGreaterThan(0)
    expect(segs.every((s) => s.date >= D(2))).toBe(true)
    expect(segs.reduce((s, x) => s + x.minutes, 0)).toBe(90)
  })

  it('无保留安排覆盖时不要求范围确认（needAck=0）', async () => {
    // 目标任务窗口内安排全部被选且无受保护项 → 无保留占用，首排直接成功。
    await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' } })
    await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false })
    await db.putDoc(planDoc('p-1', { date: D(0), planned_minutes: 30 }))
    await db.putDoc(planDoc('p-2', { date: D(1), planned_minutes: 45 }))
    const c = await createReplan()
    const r = await dsvc.reschedule(c.draft.id, { expected: c.draft, context: mkContext(FULL) })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.draft.planning_input.extra_work_acknowledged).toEqual([])
  })
})

describe('保护与拒绝', () => {
  it('选择受保护安排（有投入）→ 重排拒绝，不落任何计算', async () => {
    await seed()
    const c = await createReplan({ replanScope: { ...scope, replacement_ids: ['p-prot'] } })
    const r = await dsvc.reschedule(c.draft.id, { expected: c.draft, context: mkContext(FULL) })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NORMALIZE_FAILED')
    expect(r.message).toMatch(/已有投入记录/)
    expect((await dsvc.get(c.draft.id)).draft.planning_input).toBeNull()
  })
  it('选择有专注会话引用的安排 → 拒绝', async () => {
    await seed()
    const c = await createReplan({ replanScope: { ...scope, replacement_ids: ['p-foc'] } })
    const r = await dsvc.reschedule(c.draft.id, { expected: c.draft, context: mkContext(FULL) })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/专注会话引用/)
  })
  it('零新增（全窗口零预算）→ prepare 拒绝 NO_ADOPTABLE_CHANGES，不整批清空', async () => {
    await seed()
    const { c, r2 } = await readyReplanDraft([0, 0, 0, 0, 0, 0, 0])
    expect(r2.draft.planning_result.segments).toHaveLength(0)
    // 保留占用在零预算下过载：逐日确认后才可 ready（不放宽过载核对）。
    const overConfs = [D(0), D(2), D(3), D(4)].map((date, i) => ({
      confirmation_id: `ob-${i}`, draft_revision: r2.draft.revision, object_type: 'overbook',
      object_id_or_key: date, field_path: '', old_value: null, new_value: true, confirmed_at: TS,
    }))
    const ready = await confirmCurrentAndReady(c.draft.id, r2.draft.revision, [gapConf(r2.draft.revision, 'gap-cur'), ...overConfs])
    const prep = await asvc.prepare(c.draft.id, { expected: ready })
    expect(prep.ok).toBe(false)
    expect(prep.code).toBe('NO_ADOPTABLE_CHANGES')
    expect((await docById('p-1')).state).toBe('planned')
  })
  it('create 夹带改排字段 → 拒绝；replan 缺进展清单 → 拒绝', async () => {
    await seed()
    const bad = await dsvc.create({ replanScope: scope })
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('REPLAN_FIELDS_ON_CREATE')
    const noProgress = await dsvc.create({ mode: 'replan', replanScope: scope })
    expect(noProgress.ok).toBe(false)
    expect(noProgress.code).toBe('REPLAN_INPUT_MISSING')
  })
})

describe('漂移与失败保护', () => {
  it('prepare 后所选安排内容被改 → needs_recheck，零业务写入，旧安排未被取消', async () => {
    await seed()
    const { c, r2 } = await readyReplanDraft()
    const ready = await confirmCurrentAndReady(c.draft.id, r2.draft.revision)
    const prep = await asvc.prepare(c.draft.id, { expected: ready })
    await db.putDoc(planDoc('p-1', { date: D(0), planned_minutes: 99 }))
    const r = await asvc.apply(c.draft.id, { expected: ready, envelope: prep.envelope })
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('needs_recheck')
    expect(r.diffs.some((d) => d.code === 'REPLACEMENT_CONTENT_CHANGED')).toBe(true)
    expect((await docById('p-1')).state).toBe('planned')
    expect(await newDocs()).toEqual([])
    expect((await db.readAssistantSnapshot()).drafts.find((d) => d.id === c.draft.id).status).toBe('needs_review')
  })
  it('prepare 后出现专注会话引用所选安排（运行中）→ needs_recheck', async () => {
    await seed()
    const { c, r2 } = await readyReplanDraft()
    const ready = await confirmCurrentAndReady(c.draft.id, r2.draft.revision)
    const prep = await asvc.prepare(c.draft.id, { expected: ready })
    await db.putDoc({ id: 'f-new', kind: 'focus_session', plan_item_id: 'p-1', state: 'running' })
    const r = await asvc.apply(c.draft.id, { expected: ready, envelope: prep.envelope })
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('needs_recheck')
    expect(r.diffs.some((d) => d.code === 'REPLACEMENT_SESSION_REFERENCED')).toBe(true)
    expect((await docById('p-1')).state).toBe('planned')
    expect((await newDocs()).filter((d) => d.id !== 'f-new')).toEqual([])
  })
  it('新增写入中途失败 → 取消也整体回滚；同意图重试复用冻结信封成功', async () => {
    await seed()
    const { c, r2 } = await readyReplanDraft()
    const ready = await confirmCurrentAndReady(c.draft.id, r2.draft.revision)
    const prep = await asvc.prepare(c.draft.id, { expected: ready })
    const origAdd = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (value, ...rest) {
      if (value && value.kind === 'plan_item') throw new Error('注入写入失败')
      return origAdd.call(this, value, ...rest)
    }
    let r
    try {
      r = await asvc.apply(c.draft.id, { expected: ready, envelope: prep.envelope })
    } finally {
      IDBObjectStore.prototype.add = origAdd
    }
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('not_committed')
    expect((await docById('p-1')).state).toBe('planned')
    expect((await docById('p-2')).state).toBe('planned')
    expect(await newDocs()).toEqual([])
    const snap = await db.readAssistantSnapshot()
    expect(snap.drafts.find((d) => d.id === c.draft.id).status).toBe('needs_review')
    expect(snap.ops.find((o) => o.application_id === prep.envelope.application_id).state).toBe('pending')
    // 重试：内容未变 → generating→ready；prepare 复用同一 pending 信封（ID 不重新生成）。
    const gen = await dsvc.setStatus(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, status: 'generating' })
    const ready2 = await dsvc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' })
    expect(ready2.ok, JSON.stringify(ready2)).toBe(true)
    const prep2 = await asvc.prepare(c.draft.id, { expected: ready2.draft })
    expect(prep2.reused).toBe(true)
    expect(prep2.envelope.application_id).toBe(prep.envelope.application_id)
    const retry = await asvc.apply(c.draft.id, { expected: ready2.draft, envelope: prep2.envelope })
    expect(retry.ok, JSON.stringify(retry)).toBe(true)
    expect(retry.outcome).toBe('committed')
    expect((await docById('p-1')).state).toBe('cancelled')
    expect((await db.readAssistantSnapshot()).ops).toHaveLength(1)
  })
  it('取消写入中途失败 → 新增也整体回滚', async () => {
    await seed()
    const { c, r2 } = await readyReplanDraft()
    const ready = await confirmCurrentAndReady(c.draft.id, r2.draft.revision)
    const prep = await asvc.prepare(c.draft.id, { expected: ready })
    const origPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (value && value.id === 'p-2' && value.state === 'cancelled') throw new Error('注入取消失败')
      return origPut.call(this, value, ...rest)
    }
    let r
    try {
      r = await asvc.apply(c.draft.id, { expected: ready, envelope: prep.envelope })
    } finally {
      IDBObjectStore.prototype.put = origPut
    }
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('not_committed')
    expect((await docById('p-1')).state).toBe('planned')
    expect((await docById('p-2')).state).toBe('planned')
    expect(await newDocs()).toEqual([])
  })
})

describe('fork：改排草案复制', () => {
  it('保留模式/范围/进展，清除计算与替换基线及旧授权', async () => {
    await seed()
    const { c, r2 } = await readyReplanDraft()
    const ready = await confirmCurrentAndReady(c.draft.id, r2.draft.revision)
    const f = await dsvc.fork(c.draft.id, { expected: ready })
    expect(f.ok, JSON.stringify(f)).toBe(true)
    expect(f.draft.mode).toBe('replan')
    expect(f.draft.replan_scope).toEqual(scope)
    expect(f.draft.progress_input).toEqual(progress)
    expect(f.draft.planning_input).toBeNull()
    expect(f.draft.planning_result).toBeNull()
    expect(f.draft.replacement_baseline).toBeNull()
    expect(f.draft.fact_baseline).toBeNull()
    expect(f.draft.user_confirmations).toEqual([])
    expect(f.draft.status).toBe('editing')
  })
})