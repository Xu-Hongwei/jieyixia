// M1.3 真实采用 → 备份 v2 往返（全部虚构数据；1C 全量快照 + 真实映射比对，不只比计数）。
// 覆盖：真实采用产物完整导出；恢复到新空间逐对象按 liveMap 比对；applied 只读、去授权；
// assistant_ops 绝不导出/导入；恢复不重放采用（0 新台账、0 新安排）；原空间逐字段不变。
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkProposal, mkContext, EV_SRC, START } from './planning.helpers.js'
import { PNG_BYTES, WS } from './backupFixtures.js'
import { sha256Hex } from '@/services/backup/format'

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

function openRaw() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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

let db, dsvc, asvc, ws, counter
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('@/services/storage/db')
  const { createAssistantDraftService } = await import('@/services/assistant/drafts')
  const { createAssistantApplicationService } = await import('@/services/assistant/applications')
  ws = WS.id
  db.configureWorkspace(ws)
  counter = 0
  const queues = new Map()
  const deps = { getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `id-${++counter}`, queues }
  dsvc = createAssistantDraftService(deps)
  asvc = createAssistantApplicationService(deps)
})

async function seedAndAdopt() {
  await db.putWorkspace({ id: ws, name: WS.name, is_demo: false })
  await db.putSource({ id: 's-1', kind: 'image', captured_at: TS, blob: new Blob([PNG_BYTES], { type: 'image/png' }), name: '虚构.png' })
  await db.putDoc({ id: 'n-1', kind: 'note', title: '虚构便签', source_id: 's-1', status: 'reviewed', content_type: 'notice', fields: [{ key: 'deadline', value: DL.value, precision: 'date', status: 'confirmed', origin: 'model', derived: false }], created_at: TS, updated_at: TS, reviewed_at: TS })
  await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' }, created_at: TS, updated_at: TS })
  await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false, created_at: TS })
  const c = await dsvc.create({ proposal: createProposal(), sourceRefs: [{ object_type: 'source', id: 's-1' }], selectedRefs: [{ object_type: 'source', id: 's-1' }] })
  expect(c.ok, JSON.stringify(c)).toBe(true)
  const c1 = await dsvc.confirm(c.draft.id, { expected: c.draft, confirmation: dlConf(1, 'dl-init') })
  const r = await dsvc.reschedule(c.draft.id, { expected: c1.draft, context: mkContext(FULL) })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  const c2 = await dsvc.confirm(c.draft.id, { expected: (await dsvc.get(c.draft.id)).baseline.draft, confirmation: dlConf(r.draft.revision, 'dl-cur') })
  const gen = await dsvc.setStatus(c.draft.id, { expected: c2.draft, status: 'generating' })
  const ready = await dsvc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' })
  expect(ready.ok, JSON.stringify(ready)).toBe(true)
  const prep = await asvc.prepare(ready.draft.id, { expected: ready.draft })
  expect(prep.ok, JSON.stringify(prep)).toBe(true)
  const applied = await asvc.apply(ready.draft.id, { expected: ready.draft, envelope: prep.envelope })
  expect(applied.outcome, JSON.stringify(applied)).toBe('committed')
  return { draftId: c.draft.id, threadId: c.thread.id, envelope: prep.envelope, receipt: applied.receipt }
}

// 业务对象按 liveMap 重写正式引用后逐字段比对（1C 真实映射口径）。
function remapDoc(doc, liveMap, target) {
  const m = (id) => (id == null ? null : liveMap.get(id) ?? id)
  const out = { ...doc, id: liveMap.get(doc.id), workspace_id: target }
  if (doc.kind === 'note') out.source_id = m(doc.source_id)
  if (doc.kind === 'task') {
    if ('note_ids' in doc) out.note_ids = doc.note_ids.map(m)
    if ('matter_id' in doc) out.matter_id = m(doc.matter_id)
    if ('current_action_id' in doc) out.current_action_id = m(doc.current_action_id)
    if (doc.deadline?.from_note_id) out.deadline = { ...doc.deadline, from_note_id: m(doc.deadline.from_note_id) }
  }
  if (doc.kind === 'action') out.task_id = m(doc.task_id)
  if (doc.kind === 'plan_item') {
    out.task_id = m(doc.task_id)
    if ('focus_session_id' in doc) out.focus_session_id = m(doc.focus_session_id)
  }
  return out
}

describe('M1.3 真实采用 → v2 备份 → 恢复新空间', () => {
  it('全量往返：逐对象真实映射比对；applied 只读去授权；0 ops；不重放；原空间不变', async () => {
    const { draftId, threadId, envelope, receipt } = await seedAndAdopt()
    const oracle = await db.readWorkspaceSnapshot(ws)
    const rawBefore = await openRaw()
    const opsBefore = await getAllRaw(rawBefore, 'assistant_ops')
    rawBefore.close()
    expect(opsBefore.filter((o) => o.workspace_id === ws && o.state === 'committed')).toHaveLength(1)

    const { buildBackup } = await import('@/services/backup/export')
    const exp = await buildBackup(oracle, { backupId: 'bk-m1-adopt-0001', exportedAt: '2026-11-24T12:00:00+08:00', instant: new Date('2026-11-24T12:00:00+08:00') })
    // 台账/信封/写集绝不导出。
    expect(exp.entries.some((e) => e.path.includes('assistant_ops'))).toBe(false)
    expect(exp.summary.assistantDraftCount).toBe(1)

    const { inspectBackupFile, prepareRestore, restorePreview } = await import('@/services/backup/import')
    const file = new File([exp.zipBytes], '虚构采用备份.zip', { type: 'application/zip' })
    const ins = await inspectBackupFile(file)
    expect(ins.ok).toBe(true)
    let c = 0
    const prep = prepareRestore({
      inspected: ins, targetWorkspaceId: 'ws-restore-m1', targetName: '恢复空间', operationId: 'op-m1',
      nowMs: 1_700_000_000_000, createdAt: '2026-11-24T12:30:00+08:00', newId: () => `new-${++c}`,
    })
    const preview = restorePreview(ins)
    expect(preview.assistantDraftStatusCounts).toEqual({ applied: 1 })
    const result = await db.commitRestore(prep)
    expect(result.receipt.assistant_draft_count).toBe(1)
    const restoreMod = await import('@/services/backup/restore')
    const v = await restoreMod.verifyCommittedRestore(prep)
    expect(v.problems).toEqual([])
    expect(v.ok).toBe(true)

    const target = prep.targetWorkspaceId
    const t = await db.readWorkspaceSnapshot(target)
    // 业务对象全量逐一按真实映射比对（不只计数）。
    expect(t.docs).toHaveLength(oracle.docs.length)
    for (const doc of oracle.docs) {
      const restored = t.docs.find((x) => x.id === prep.liveMap.get(doc.id))
      expect(restored, `缺少恢复对象 ${doc.id}`).toBeTruthy()
      expect(restored).toEqual(remapDoc(doc, prep.liveMap, target))
    }
    // 资料字节逐一对应（内容版本不变）。
    expect(t.sources).toHaveLength(oracle.sources.length)
    for (const s of oracle.sources) {
      const rs = t.sources.find((x) => x.id === prep.liveMap.get(s.id))
      expect(rs).toBeTruthy()
      expect(rs.content_version).toBe(s.content_version)
      expect(await sha256Hex(new Uint8Array(await rs.blob.arrayBuffer()))).toBe(await sha256Hex(new Uint8Array(await s.blob.arrayBuffer())))
    }
    // 线程：adoption_result 消息保留，draft 引用重映射。
    expect(t.assistantThreads).toHaveLength(1)
    const th = t.assistantThreads[0]
    expect(th.id).toBe(prep.liveMap.get(threadId))
    const msg = th.messages.find((m) => m.type === 'adoption_result')
    expect(msg.content).toBe(`已采用：新增 ${receipt.counts.tasks_created} 个任务、${receipt.counts.actions_created} 个行动、${receipt.counts.plan_items_created} 条安排。`)
    expect(msg.refs[0].id).toBe(prep.liveMap.get(draftId))
    // 草案：applied 只读保留；摘要 formal_id 全部按 liveMap 重映射；基线/确认清空（去授权）。
    expect(t.assistantDrafts).toHaveLength(1)
    const d = t.assistantDrafts[0]
    expect(d.id).toBe(prep.liveMap.get(draftId))
    expect(d.status).toBe('applied')
    expect(d.fact_baseline).toBeNull()
    expect(d.user_confirmations).toEqual([])
    expect(d.applied_summary.application_id).toBe(envelope.application_id)
    expect(d.applied_summary.counts).toEqual(receipt.counts)
    expect(d.applied_summary.id_map).toHaveLength(envelope.id_map.length)
    for (const e of envelope.id_map) {
      const re = d.applied_summary.id_map.find((x) => x.draft_key === e.draft_key && x.object_type === e.object_type)
      expect(re, `摘要缺少映射 ${e.draft_key}`).toBeTruthy()
      expect(re.formal_id).toBe(prep.liveMap.get(e.formal_id))
    }
    // 恢复不重放采用：目标空间 0 台账；plan_item 数量与源一致（无自动生成）。
    const rawT = await openRaw()
    const opsAll = await getAllRaw(rawT, 'assistant_ops')
    rawT.close()
    expect(opsAll.filter((o) => o.workspace_id === target)).toEqual([])
    expect(t.docs.filter((x) => x.kind === 'plan_item')).toHaveLength(oracle.docs.filter((x) => x.kind === 'plan_item').length)

    // 恢复空间内 applied 草案只读：确认被锁；采用 prepare 无台账可复用 → NOT_READY（不重放）。
    db.configureWorkspace(target)
    const { createAssistantDraftService } = await import('@/services/assistant/drafts')
    const { createAssistantApplicationService } = await import('@/services/assistant/applications')
    const tDsvc = createAssistantDraftService({ getWorkspaceId: () => target, wallNow: () => TS, newId: () => `t-${++c}` })
    const tAsvc = createAssistantApplicationService({ getWorkspaceId: () => target, wallNow: () => TS, newId: () => `t-${++c}` })
    const g = await tDsvc.get(d.id)
    const cf = await tDsvc.confirm(d.id, { expected: g.baseline.draft, confirmation: { confirmation_id: 'x', draft_revision: d.revision, object_type: 'gap', object_id_or_key: 'w1', field_path: '', old_value: null, new_value: true, confirmed_at: TS } })
    expect(cf.code).toBe('STATUS_LOCKED')
    const pr = await tAsvc.prepare(d.id, { expected: g.baseline.draft })
    expect(pr.ok).toBe(false)
    expect(pr.code).toBe('NOT_READY')
    db.configureWorkspace(ws)

    // 原空间逐字段不变（含已提交台账）。
    expect(await db.readWorkspaceSnapshot(ws)).toEqual(oracle)
    const rawA = await openRaw()
    expect(await getAllRaw(rawA, 'assistant_ops')).toEqual(opsBefore)
    rawA.close()
  })
})