// 5B-1B 备份 v2 助手集成验收（开工单 §9 / 矩阵 B1B-10/13–19/21；全部虚构数据）。
// 真实服务 + fake-indexeddb 全链路：svc 写入 → readWorkspaceSnapshot → buildBackup → File →
// inspectBackupFile → prepareRestore（确定性 newId）→ commitRestore → verifyCommittedRestore。
// 真实浏览器 IndexedDB 证据另见 B1B 矩阵（B1B-02/03/06/13/18/20）。
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkProposal, mkInput, mkOcc, mkFact, mkWork, START } from './planning.helpers.js'
import { TS, richDraft, richThread, EXPECTED_DRAFT_PATHS, replanDraftFields, EXPECTED_REPLAN_PATHS } from './assistant.fixtures.js'
import { PNG_BYTES, WS, fictionalRecords, assembleArchive, buildCompleteBackup } from './backupFixtures.js'
import { assistantRefEntries } from '@/domains/assistant/refs'
import { restoreAssistantDrafts } from '@/services/backup/recovery'
import { buildRemap } from '@/services/backup/remap'
import { validateBackup } from '@/services/backup/validate'
import { buildBackup } from '@/services/backup/export'
import { inspectBackupFile, prepareRestore, restorePreview } from '@/services/backup/import'
import { scheduleDaily } from '@/domains/planning/schedule'
import {
  MANIFEST_PATH, ASSISTANT_THREADS_PATH, ASSISTANT_DRAFTS_PATH, SCHEMA_VERSION,
  utf8Bytes, sha256Hex,
} from '@/services/backup/format'

const fileOf = (bytes, name = '虚构备份.zip') => new File([bytes], name, { type: 'application/zip' })
const codeOf = async (p) => { try { await p; return null } catch (e) { return e.code } }
const conf = (over = {}) => ({
  confirmation_id: 'c1', draft_revision: 1, object_type: 'gap', object_id_or_key: 'w1',
  field_path: '', old_value: null, new_value: null, confirmed_at: TS, ...over,
})
const zeroCounts = { tasks_created: 0, tasks_updated: 0, actions_created: 0, plan_items_created: 0, source_fields_confirmed: 0 }
const summaryOf = (idMap = []) => ({ application_id: 'app-1', counts: zeroCounts, id_map: idMap, unscheduled_kept: [], applied_at: TS })

// 最小合法助手记录（无规划对，隔离容器归属/版本组合等单层错误）。
const simpleThread = (over = {}) => ({
  id: 'th-1', record_version: 1, workspace_id: WS.id, title: '虚构线程',
  messages: [], selected_refs: [], confirmed_requirements: [], created_at: TS, updated_at: TS, ...over,
})
const simpleDraft = (over = {}) => ({
  id: 'd-1', record_version: 1, workspace_id: WS.id, thread_id: 'th-1',
  revision: 1, status: 'editing', revision_history: [],
  proposal: mkProposal(), planning_input: null, planning_result: null, fact_baseline: null,
  assumptions: [], user_confirmations: [], excluded_items: [], source_refs: [], applied_summary: null,
  created_at: TS, updated_at: TS, ...over,
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

function injectAddFailure(storeName, errName = 'Error') {
  const origAdd = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, ...rest) {
    if (this.name === storeName) {
      const e = new Error(`注入 ${storeName} 写入失败`)
      e.name = errName
      throw e
    }
    return origAdd.call(this, value, ...rest)
  }
  return () => { IDBObjectStore.prototype.add = origAdd }
}

// 改写归档内某 JSON 载荷并同步 manifest 声明（字节数/SHA-256），保持 A 层其余检查干净。
async function rewritePayload(entries, path, mutate) {
  const idx = entries.findIndex((e) => e.path === path)
  const value = JSON.parse(new TextDecoder().decode(entries[idx].bytes))
  mutate(value)
  const bytes = utf8Bytes(JSON.stringify(value))
  entries[idx] = { path, bytes }
  await mutateManifest(entries, (m) => {
    const p = m.payloads.find((x) => x.path === path)
    if (p) { p.bytes = bytes.length; p.sha256 = null }
  })
  const mIdx = entries.findIndex((e) => e.path === MANIFEST_PATH)
  const manifest = JSON.parse(new TextDecoder().decode(entries[mIdx].bytes))
  const p = manifest.payloads.find((x) => x.path === path)
  if (p) p.sha256 = await sha256Hex(bytes)
  entries[mIdx] = { path: MANIFEST_PATH, bytes: utf8Bytes(JSON.stringify(manifest)) }
  return entries
}
async function mutateManifest(entries, mutate) {
  const mIdx = entries.findIndex((e) => e.path === MANIFEST_PATH)
  const manifest = JSON.parse(new TextDecoder().decode(entries[mIdx].bytes))
  mutate(manifest)
  entries[mIdx] = { path: MANIFEST_PATH, bytes: utf8Bytes(JSON.stringify(manifest)) }
  return entries
}

let db, svc, restoreMod, ws, counter
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('@/services/storage/db')
  const { createAssistantDraftService } = await import('@/services/assistant/drafts')
  restoreMod = await import('@/services/backup/restore')
  ws = WS.id
  db.configureWorkspace(ws)
  counter = 0
  svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `id-${++counter}` })
})

async function seedBusiness() {
  await db.putWorkspace({ id: ws, name: WS.name, is_demo: false })
  await db.putSource({ id: 's-1', kind: 'image', captured_at: TS, blob: new Blob([PNG_BYTES], { type: 'image/png' }), name: '虚构.png' })
  await db.putDoc({ id: 'n-1', kind: 'note', title: '虚构便签', source_id: 's-1', status: 'reviewed', content_type: 'notice', fields: [], created_at: TS, updated_at: TS, reviewed_at: TS })
  await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' }, created_at: TS, updated_at: TS })
  await db.putDoc({ id: 't-2', kind: 'task', title: '虚构目标二', status: 'todo', deadline: { value: null, precision: 'none' }, created_at: TS, updated_at: TS })
  await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false, created_at: TS })
  await db.putDoc({ id: 'p-1', kind: 'plan_item', task_id: 't-1', date: START, planned_minutes: 30, action_text: '虚构', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active' })
}

// 一线程四草案：editing（rev2+历史+确认+基线）、discarded、applied（raw，含台账）、generating。
async function seedDrafts() {
  const input = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })], occupancy: [mkOcc('p-1', { task_id: 't-1' })], ack: ['w1'] })
  const a = await svc.create({
    title: '虚构线程', proposal: mkProposal(), planningInput: input, planningResult: scheduleDaily(input),
    sourceRefs: [{ object_type: 'source', id: 's-1' }], selectedRefs: [{ object_type: 'source', id: 's-1' }],
  })
  expect(a.ok).toBe(true)
  const threadId = a.thread.id
  await svc.appendMessage(threadId, { message: { role: 'user', content: '原文提到 t-1 与 s-1，不是引用', refs: [{ object_type: 'task', id: 't-1' }] } })
  const g0 = await svc.get(a.draft.id)
  const e1 = await svc.edit(a.draft.id, { expected: g0.baseline.draft, edits: { assumptions: [{ id: 'as1', text: '虚构假设', related_keys: ['w1'] }] } })
  expect(e1.ok).toBe(true)
  const c1 = await svc.confirm(a.draft.id, { expected: e1.draft, confirmation: conf({ draft_revision: 2 }) })
  expect(c1.ok).toBe(true)

  const b = await svc.create({ threadId, proposal: mkProposal() })
  const gb = await svc.get(b.draft.id)
  const db1 = await svc.discard(b.draft.id, { expected: gb.baseline.draft })
  expect(db1.ok).toBe(true)

  const d = await svc.create({ threadId, proposal: mkProposal() })
  const gd = await svc.get(d.draft.id)
  const sd = await svc.setStatus(d.draft.id, { expected: gd.baseline.draft, status: 'generating' })
  expect(sd.ok).toBe(true)

  // applied 状态只由采用/恢复路径产生（服务拒设）：raw 落库模拟历史采用结果 + 源空间台账。
  const raw = await openRaw(undefined, () => {})
  await putRaw(raw, 'assistant_drafts', {
    id: 'd-applied', record_version: 1, workspace_id: ws, thread_id: threadId,
    revision: 1, status: 'applied', revision_history: [],
    proposal: mkProposal(), planning_input: null, planning_result: null, fact_baseline: null,
    assumptions: [], user_confirmations: [conf({ confirmation_id: 'c-ap' })],
    excluded_items: [], source_refs: [],
    applied_summary: summaryOf([{ draft_key: 't-new', formal_id: 't-1', object_type: 'task' }]),
    created_at: TS, updated_at: TS,
  })
  await putRaw(raw, 'assistant_ops', { application_id: 'app-1', workspace_id: ws, status: 'committed', counts: zeroCounts })
  raw.close()
  return { threadId, aId: a.draft.id, bId: b.draft.id, dId: d.draft.id, cId: 'd-applied' }
}

async function exportCurrent() {
  const snap = await db.readWorkspaceSnapshot(ws)
  return buildBackup(snap, { backupId: 'bk-assistant-0001', exportedAt: '2026-11-24T12:00:00+08:00', instant: new Date('2026-11-24T12:00:00+08:00') })
}

async function preparedFrom(zipBytes, target = 'ws-restore-1', op = 'op-1', idPrefix = 'new') {
  const ins = await inspectBackupFile(fileOf(zipBytes))
  expect(ins.ok).toBe(true)
  let c = 0
  const prep = prepareRestore({
    inspected: ins, targetWorkspaceId: target, targetName: '恢复空间', operationId: op,
    // 过去时刻：verifyCommittedRestore 用真实 Date.now() 核对占位租约须已过期
    nowMs: 1_700_000_000_000, createdAt: '2026-11-24T12:30:00+08:00', newId: () => `${idPrefix}-${++c}`,
  })
  return { ins, prep }
}

async function targetAssistants(target) {
  const snap = await db.readWorkspaceSnapshot(target)
  return { threads: snap.assistantThreads, drafts: snap.assistantDrafts, docs: snap.docs, sources: snap.sources }
}

describe('B1B-13 v2 完整往返（真实服务 → ZIP → 恢复 → 重读核对）', () => {
  it('空空间：两个空助手 wrapper 也导出，全链路恢复成功且计数全 0', async () => {
    await db.putWorkspace({ id: ws, name: WS.name, is_demo: false })
    const exp = await exportCurrent()
    expect(exp.summary.assistantThreadCount).toBe(0)
    expect(exp.summary.assistantDraftCount).toBe(0)
    const paths = exp.entries.map((e) => e.path)
    expect(paths).toContain(ASSISTANT_THREADS_PATH)
    expect(paths).toContain(ASSISTANT_DRAFTS_PATH)
    const { prep } = await preparedFrom(exp.zipBytes)
    const result = await db.commitRestore(prep)
    expect(result.receipt.assistant_thread_count).toBe(0)
    expect(result.receipt.assistant_draft_count).toBe(0)
    const v = await restoreMod.verifyCommittedRestore(prep)
    expect(v.problems).toEqual([])
    expect(v.ok).toBe(true)
    const t = await targetAssistants(prep.targetWorkspaceId)
    expect(t.threads).toEqual([])
    expect(t.drafts).toEqual([])
  })

  it('多线程状态全量往返：新 ID/去授权/历史保留/0 ops/0 新 PlanItem/原空间不变', async () => {
    await seedBusiness()
    const ids = await seedDrafts()
    const oracle = await db.readWorkspaceSnapshot(ws)
    const rawBefore = await openRaw(undefined, () => {})
    const opsBefore = await getAllRaw(rawBefore, 'assistant_ops')
    rawBefore.close()

    const exp = await exportCurrent()
    expect(exp.summary.assistantThreadCount).toBe(1)
    expect(exp.summary.assistantDraftCount).toBe(4)
    // 不导出 assistant_ops/信封/写集/租约。
    expect(exp.entries.some((e) => e.path.includes('assistant_ops'))).toBe(false)

    const { ins, prep } = await preparedFrom(exp.zipBytes)
    const preview = restorePreview(ins)
    expect(preview.assistantThreadCount).toBe(1)
    expect(preview.assistantDraftCount).toBe(4)
    expect(preview.assistantDraftStatusCounts).toEqual({ editing: 1, discarded: 1, generating: 1, applied: 1 })
    expect(preview.transforms.some((t) => t.includes('旧保存结果不能由本次备份恢复推定'))).toBe(true)

    const result = await db.commitRestore(prep)
    expect(result.alreadyCommitted).toBe(false)
    expect(result.receipt.assistant_thread_count).toBe(1)
    expect(result.receipt.assistant_draft_count).toBe(4)
    const v = await restoreMod.verifyCommittedRestore(prep)
    expect(v.problems).toEqual([])
    expect(v.ok).toBe(true)

    const t = await targetAssistants(prep.targetWorkspaceId)
    expect(t.threads).toHaveLength(1)
    expect(t.drafts).toHaveLength(4)
    const th = t.threads[0]
    expect(th.id).toBe(prep.liveMap.get(ids.threadId))
    expect(th.id).not.toBe(ids.threadId)
    expect(th.workspace_id).toBe(prep.targetWorkspaceId)
    // 线程引用重映射；正文里的旧 ID 字符串不动；turn id 保留。
    expect(th.selected_refs[0].id).toBe(prep.liveMap.get('s-1'))
    expect(th.messages[0].refs[0].id).toBe(prep.liveMap.get('t-1'))
    expect(th.messages[0].content).toBe('原文提到 t-1 与 s-1，不是引用')

    const byOld = new Map()
    for (const d of t.drafts) byOld.set([...prep.liveMap.entries()].find(([, nv]) => nv === d.id)?.[0], d)
    const a = byOld.get(ids.aId)
    const b = byOld.get(ids.bId)
    const c = byOld.get(ids.cId)
    const d = byOld.get(ids.dId)
    expect(a.status).toBe('needs_review')
    expect(d.status).toBe('needs_review')
    expect(b.status).toBe('discarded')
    expect(c.status).toBe('applied')
    for (const x of t.drafts) {
      expect(x.workspace_id).toBe(prep.targetWorkspaceId)
      expect(x.thread_id).toBe(th.id)
      expect(x.fact_baseline).toBeNull()
      expect(x.user_confirmations).toEqual([])
    }
    // 内容保留：建议/规划/历史供阅读；applied_summary 只读保留且 formal_id 重映射。
    expect(a.revision).toBe(2)
    expect(a.revision_history).toHaveLength(1)
    expect(a.proposal.work_items).toHaveLength(1)
    expect(a.planning_result.segments.length).toBeGreaterThan(0)
    expect(c.applied_summary.application_id).toBe('app-1')
    expect(c.applied_summary.id_map[0].formal_id).toBe(prep.liveMap.get('t-1'))
    expect(c.applied_summary.id_map[0].draft_key).toBe('t-new')

    // 0 个新采用操作、0 个自动生成 PlanItem：目标 ops 为空，plan_item 计数与备份一致。
    const rawT = await openRaw(undefined, () => {})
    const opsAll = await getAllRaw(rawT, 'assistant_ops')
    rawT.close()
    expect(opsAll.filter((r) => r.workspace_id === prep.targetWorkspaceId)).toEqual([])
    expect(t.docs.filter((x) => x.kind === 'plan_item')).toHaveLength(oracle.docs.filter((x) => x.kind === 'plan_item').length)

    // 原空间逐字段不变（含助手记录与台账）。
    const after = await db.readWorkspaceSnapshot(ws)
    expect(after).toEqual(oracle)
    const rawA = await openRaw(undefined, () => {})
    expect(await getAllRaw(rawA, 'assistant_ops')).toEqual(opsBefore)
    rawA.close()
  })

  it('v1 旧备份继续可恢复：助手为空，回执新字段按 0 计', async () => {
    const { entries } = await buildCompleteBackup()
    const { packArchive } = await import('@/services/backup/zip')
    const { prep } = await preparedFrom(packArchive(entries))
    const result = await db.commitRestore(prep)
    expect(result.receipt.assistant_thread_count).toBe(0)
    expect(result.receipt.assistant_draft_count).toBe(0)
    const v = await restoreMod.verifyCommittedRestore(prep)
    expect(v.ok).toBe(true)
    const t = await targetAssistants(prep.targetWorkspaceId)
    expect(t.threads).toEqual([])
    expect(t.drafts).toEqual([])
  })
})

describe('R4 写入边界与导出闭环（任意合法服务保存结果可完整导出）', () => {
  it('合法服务保存（规划对/基线/确认/多状态）→ 完整导出成功；非法嵌套字段写入即拒不污染快照', async () => {
    await seedBusiness()
    const ids = await seedDrafts()
    const exp = await exportCurrent()
    expect(exp.summary.assistantThreadCount).toBe(1)
    expect(exp.summary.assistantDraftCount).toBe(4)
    expect(exp.zipBytes.length).toBeGreaterThan(0)
    const bad = await svc.create({ threadId: ids.threadId, proposal: { ...mkProposal(), unexpected_field: true } })
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('SHAPE_INVALID')
    const exp2 = await exportCurrent()
    expect(exp2.summary.assistantDraftCount).toBe(4)
  })
})

describe('B1B-14 导出期间并发编辑：快照冻结，导出的是捕获时刻内容', () => {
  it('捕获快照后另一页编辑 bump → 已捕获快照导出旧 revision，新快照导出新 revision', async () => {
    await seedBusiness()
    const c = await svc.create({ title: '虚构线程', proposal: mkProposal() })
    const snap = await db.readWorkspaceSnapshot(ws)
    const g = await svc.get(c.draft.id)
    const e = await svc.edit(c.draft.id, { expected: g.baseline.draft, edits: { assumptions: [{ id: 'as1', text: '虚构', related_keys: [] }] } })
    expect(e.draft.revision).toBe(2)
    const oldExp = await buildBackup(snap, { backupId: 'bk-old', exportedAt: TS, instant: new Date(TS) })
    const { ins: oldIns } = await preparedFrom(oldExp.zipBytes, 'ws-restore-old', 'op-old')
    expect(oldIns.assistantDrafts[0].revision).toBe(1)
    expect(oldIns.assistantDrafts[0].assumptions).toEqual([])
    const newExp = await exportCurrent()
    const { ins: newIns } = await preparedFrom(newExp.zipBytes, 'ws-restore-new', 'op-new')
    expect(newIns.assistantDrafts[0].revision).toBe(2)
    expect((await svc.get(c.draft.id)).draft.revision).toBe(2)
  })
})

describe('B1B-15 逐路径重映射（§5.2 全表）+ 正式 ID 与局部 key 碰名', () => {
  it('formal 全表按 liveMap/historyMap 重写；draft_key/local_key/turn/date/正文一律不动', () => {
    const sources = [{ id: 's-1', workspace_id: ws, kind: 'text', text: '虚构资料', captured_at: TS }]
    const docs = [
      { id: 'n-1', kind: 'note', workspace_id: ws, title: '虚构便签', source_id: 's-1', fields: [] },
      { id: 't-1', kind: 'task', workspace_id: ws, title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' } },
      { id: 't-2', kind: 'task', workspace_id: ws, title: '虚构目标二', status: 'todo', deadline: { value: null, precision: 'none' } },
      // 碰名：正式 Task ID 与草案 task key 同为 't-new'，两个命名空间必须分开处理。
      { id: 't-new', kind: 'task', workspace_id: ws, title: '碰名正式目标', status: 'todo', deadline: { value: null, precision: 'none' } },
      { id: 'a-1', kind: 'action', workspace_id: ws, task_id: 't-1', text: '虚构步骤', minutes: 60, done: false },
      { id: 'p-1', kind: 'plan_item', workspace_id: ws, task_id: 't-1', date: START, planned_minutes: 30, action_text: '虚构', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active' },
    ]
    const d = richDraft({
      applied_summary: summaryOf([
        { draft_key: 't-new', formal_id: 't-1', object_type: 'task' },
        { draft_key: 't-old', formal_id: 't-gone', object_type: 'task' },
      ]),
    })
    d.proposal.task_proposals[1].target_id = 't-new'
    d.proposal.evidence_refs[0] = { kind: 'source_excerpt', source_id: 's-1', excerpt: '原文提到 t-1 与 s-1，不是引用' }
    const before = structuredClone(d)
    let c = 0
    const remap = buildRemap({
      manifest: { backup_id: 'bk-x', source_workspace: { id: ws, name: WS.name, is_demo: false } },
      sources, docs, assistantThreads: [richThread], assistantDrafts: [d],
      targetWorkspaceId: 'ws-t', targetName: '恢复空间', createdAt: TS, newId: () => `r-${++c}`,
    })
    const beforeByPath = new Map(assistantRefEntries(before, 'draft').map((e) => [e.path, e]))
    const afterEntries = assistantRefEntries(remap.assistantDrafts[0], 'draft')
    const afterByPath = new Map(afterEntries.map((e) => [e.path, e]))
    for (const [path, targetType, namespace] of EXPECTED_DRAFT_PATHS) {
      const b = beforeByPath.get(path)
      const a = afterByPath.get(path)
      expect(a, `缺少路径 ${path}`).toBeTruthy()
      expect([a.targetType, a.namespace]).toEqual([targetType, namespace])
      if (namespace === 'formal') {
        const expected = remap.liveMap.get(b.get()) ?? remap.historyMap.get(b.get()) ?? b.get()
        expect(a.get(), `路径 ${path} 未按映射重写`).toBe(expected)
      } else {
        expect(a.get(), `路径 ${path} 局部命名空间被改动`).toBe(b.get())
      }
    }
    const out = remap.assistantDrafts[0]
    // 碰名不串绑：草案 key 't-new' 保留；正式 target_id 't-new' 走 liveMap。
    expect(out.proposal.task_proposals[0].key).toBe('t-new')
    expect(out.proposal.task_proposals[1].target_id).toBe(remap.liveMap.get('t-new'))
    expect(out.proposal.task_proposals[1].target_id).not.toBe('t-new')
    expect(out.user_confirmations[0].object_id_or_key).toBe('t-new') // id_scope=draft
    expect(out.user_confirmations[1].object_id_or_key).toBe(remap.liveMap.get('t-1')) // id_scope=formal
    // 历史缺失 formal_id → 稳定隔离映射，不与活 ID 冲突。
    expect(remap.historyMap.has('t-gone')).toBe(true)
    expect(out.applied_summary.id_map[1].formal_id).toBe(remap.historyMap.get('t-gone'))
    expect([...remap.liveMap.values()]).not.toContain(remap.historyMap.get('t-gone'))
    // 正文原文不动。
    expect(out.proposal.evidence_refs[0].excerpt).toBe('原文提到 t-1 与 s-1，不是引用')
    // 线程路径同样只动 formal。
    const th = remap.assistantThreads[0]
    expect(th.selected_refs[0].id).toBe(remap.liveMap.get('s-1'))
    expect(th.messages[0].refs[0].id).toBe(remap.liveMap.get('t-1'))
    expect(th.messages[0].content).toBe('原文提到 t-1 与 s-1，不是引用')
    expect(th.confirmed_requirements[0].value.task_ref.id).toBe(remap.liveMap.get('t-2'))
    expect(th.confirmed_requirements[0].evidence_refs[0].source_id).toBe(remap.liveMap.get('s-1'))
  })
})

describe('B1B-15b M3 改排草案逐路径重映射（范围/进展/基线/采用汇总/历史快照）', () => {
  it('formal 全重写；局部 key/日期/正文不动；缺失会话 ID 隔离映射', () => {
    const sources = [{ id: 's-1', workspace_id: ws, kind: 'text', text: '虚构资料', captured_at: TS }]
    const docs = [
      { id: 't-1', kind: 'task', workspace_id: ws, title: '虚构目标', status: 'todo', deadline: { value: null, precision: 'none' } },
      { id: 'a-1', kind: 'action', workspace_id: ws, task_id: 't-1', text: '虚构步骤', minutes: 60, done: false },
      { id: 'p-1', kind: 'plan_item', workspace_id: ws, task_id: 't-1', date: START, planned_minutes: 30, action_text: '虚构', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active' },
    ]
    const d = richDraft(replanDraftFields())
    d.revision_history = [{
      ...d.revision_history[0],
      replan_scope: { task_id: 't-1', start_date: START, replacement_ids: ['p-1'] },
      progress_input: d.progress_input,
      replacement_baseline: d.replacement_baseline,
    }]
    const before = structuredClone(d)
    let c = 0
    const remap = buildRemap({
      manifest: { backup_id: 'bk-r', source_workspace: { id: ws, name: WS.name, is_demo: false } },
      sources, docs, assistantThreads: [richThread], assistantDrafts: [d],
      targetWorkspaceId: 'ws-t', targetName: '恢复空间', createdAt: TS, newId: () => `r-${++c}`,
    })
    const beforeByPath = new Map(assistantRefEntries(before, 'draft').map((e) => [e.path, e]))
    const afterByPath = new Map(assistantRefEntries(remap.assistantDrafts[0], 'draft').map((e) => [e.path, e]))
    for (const [path, targetType, namespace] of EXPECTED_REPLAN_PATHS) {
      const b = beforeByPath.get(path)
      const a = afterByPath.get(path)
      expect(a, `缺少路径 ${path}`).toBeTruthy()
      expect([a.targetType, a.namespace]).toEqual([targetType, namespace])
      const expected = remap.liveMap.get(b.get()) ?? remap.historyMap.get(b.get()) ?? b.get()
      expect(a.get(), `路径 ${path} 未按映射重写`).toBe(expected)
    }
    const out = remap.assistantDrafts[0]
    expect(out.replan_scope.task_id).toBe(remap.liveMap.get('t-1'))
    expect(out.replan_scope.replacement_ids).toEqual([remap.liveMap.get('p-1')])
    expect(out.replan_scope.start_date).toBe(START)
    expect(out.progress_input.work_items[0].key).toBe('rw1')
    expect(out.progress_input.work_items[0].reuse_action_id).toBe(remap.liveMap.get('a-1'))
    expect(out.progress_input.statement).toBe('虚构进展：原文提到 t-1 与 a-1 不是引用')
    expect(out.replacement_baseline.items[0].action_text).toBe('虚构旧安排')
    expect(out.applied_summary.cancelled_plan_item_ids).toEqual([remap.liveMap.get('p-1')])
    expect(out.applied_summary.replan_task_id).toBe(remap.liveMap.get('t-1'))
    expect(remap.historyMap.has('f-gone')).toBe(true)
    expect(out.replacement_baseline.focus_session_ids).toEqual([remap.historyMap.get('f-gone')])
    expect([...remap.liveMap.values()]).not.toContain(remap.historyMap.get('f-gone'))
  })
})

describe('B1B-16 损坏包拒绝（容器归属/版本组合/载荷形状/计数）', () => {
  const base = () => { const { sources, docs, assets } = fictionalRecords(); return { sources, docs, assets } }
  const v2 = (over = {}) => assembleArchive({ ...base(), formatVersion: 2, assistantThreads: [simpleThread()], assistantDrafts: [simpleDraft()], ...over })

  it('合法 v2 助手包通过（负向用例的干净基线）', async () => {
    const { entries } = await v2()
    const r = await validateBackup({ entries })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.assistantThreads).toHaveLength(1)
    expect(r.assistantDrafts).toHaveLength(1)
  })

  it('草案归属线程缺失 → 容器归属损坏拒绝整包，不静默丢草案', async () => {
    const { entries } = await v2({ assistantDrafts: [simpleDraft({ thread_id: 'th-gone' })] })
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /容器归属损坏，拒绝整包/.test(e.message))).toBe(true)
  })

  it('线程不在同一空间 → 拒绝（B 层归属 + C 层容器）', async () => {
    const { entries } = await v2({ assistantThreads: [simpleThread({ workspace_id: 'ws-other' })] })
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /记录不属于 manifest 声明的单一来源空间/.test(e.message))).toBe(true)
    expect(r.errors.some((e) => /草案归属线程不在同一空间/.test(e.message))).toBe(true)
  })

  it('v1 归档携带助手载荷 → 显式拒绝', async () => {
    const { entries } = await buildCompleteBackup()
    const bytes = utf8Bytes(JSON.stringify({ schema_version: SCHEMA_VERSION, threads: [] }))
    entries.push({ path: ASSISTANT_THREADS_PATH, bytes })
    await mutateManifest(entries, (m) => { m.payloads.push({ path: ASSISTANT_THREADS_PATH, bytes: bytes.length, sha256: null }) })
    const mIdx = entries.findIndex((e) => e.path === MANIFEST_PATH)
    const manifest = JSON.parse(new TextDecoder().decode(entries[mIdx].bytes))
    manifest.payloads.find((p) => p.path === ASSISTANT_THREADS_PATH).sha256 = await sha256Hex(bytes)
    entries[mIdx] = { path: MANIFEST_PATH, bytes: utf8Bytes(JSON.stringify(manifest)) }
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /v1\/旧格式归档不得携带助手载荷/.test(e.message))).toBe(true)
  })

  it('v2 缺助手草案文件 → 缺少必需文件拒绝', async () => {
    const { entries } = await v2()
    const kept = entries.filter((e) => e.path !== ASSISTANT_DRAFTS_PATH)
    await mutateManifest(kept, (m) => { m.payloads = m.payloads.filter((p) => p.path !== ASSISTANT_DRAFTS_PATH) })
    const r = await validateBackup({ entries: kept })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /缺少必需文件：data\/assistant_drafts\.json/.test(e.message))).toBe(true)
  })

  it('助手 wrapper schema_version 不符 → 拒绝', async () => {
    const { entries } = await v2()
    await rewritePayload(entries, ASSISTANT_DRAFTS_PATH, (w) => { w.schema_version = '0.4.0' })
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /schema_version 必须与 manifest 声明 0\.6\.0 一致/.test(e.message))).toBe(true)
  })

  it('manifest 助手计数与实际不符 → 拒绝', async () => {
    const { entries } = await v2()
    await mutateManifest(entries, (m) => { m.counts.assistant_draft_count = 99 })
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /counts\.assistant_draft_count 与 manifest 不符/.test(e.message))).toBe(true)
  })
})

describe('B1B-17 恢复状态语义：未应用去授权待核对，applied 只读，discarded 保持', () => {
  it('九态全表：状态映射 + 清基线/确认 + 内容与历史保留', () => {
    const cases = [
      ['editing', 'needs_review'], ['generating', 'needs_review'], ['needs_clarification', 'needs_review'],
      ['ready', 'needs_review'], ['needs_review', 'needs_review'], ['applying', 'needs_review'],
      ['result_unknown', 'needs_review'], ['applied', 'applied'], ['discarded', 'discarded'],
    ]
    for (const [from, to] of cases) {
      const draft = simpleDraft({
        status: from,
        fact_baseline: { captured_at: TS, task_facts: [], source_fingerprints: [], note_field_baselines: [], occupancy: [] },
        user_confirmations: [conf()],
        revision_history: [{ revision: 1, proposal: mkProposal(), planning_input: null, planning_result: null, requirements: [], created_at: TS }],
        revision: 2,
        applied_summary: from === 'applied' ? summaryOf([{ draft_key: 't-new', formal_id: 't-1', object_type: 'task' }]) : null,
      })
      const out = restoreAssistantDrafts([draft])[0]
      expect(out.status, `${from} → ${to}`).toBe(to)
      expect(out.fact_baseline).toBeNull()
      expect(out.user_confirmations).toEqual([])
      expect(out.proposal).toEqual(draft.proposal)
      expect(out.revision_history).toEqual(draft.revision_history)
      expect(out.revision).toBe(2)
      if (from === 'applied') expect(out.applied_summary).toEqual(draft.applied_summary)
    }
  })
})

describe('B1B-10 历史宽容与活引用守卫分开校验', () => {
  const base = () => { const { sources, docs, assets } = fictionalRecords(); return { sources, docs, assets } }

  it('历史快照缺失来源/done 占用断引用/applied 缺失 formal_id → 保留内容通过校验', async () => {
    const draft = simpleDraft({
      status: 'applied',
      revision: 2,
      revision_history: [{
        revision: 1,
        proposal: { ...mkProposal(), evidence_refs: [{ kind: 'source_excerpt', source_id: 's-gone', excerpt: '历史片段' }] },
        planning_input: null, planning_result: null, requirements: [], created_at: TS,
      }],
      fact_baseline: {
        captured_at: TS, task_facts: [mkFact('t-gone')], source_fingerprints: [], note_field_baselines: [],
        occupancy: [mkOcc('p-gone', { task_id: 't-gone', state: 'done', task_ref_state: 'deleted' })],
      },
      applied_summary: summaryOf([{ draft_key: 't-x', formal_id: 't-gone', object_type: 'task' }]),
    })
    const { entries } = await assembleArchive({ ...base(), formatVersion: 2, assistantThreads: [simpleThread()], assistantDrafts: [draft] })
    const r = await validateBackup({ entries })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('planned 占用断引用（不可信数据）→ 拒绝，不按 0 计算', async () => {
    const draft = simpleDraft({ planning_input: mkInput({ occupancy: [mkOcc('p-x', { task_id: 't-1', state: 'planned', task_ref_state: 'deleted' })] }) })
    const { entries } = await assembleArchive({ ...base(), formatVersion: 2, assistantThreads: [simpleThread()], assistantDrafts: [draft] })
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /planned 占用断引用属于不可信数据/.test(e.message))).toBe(true)
  })

  it('活 planned PlanItem 断 Task 引用 → 仍按业务规则拒绝（不因助手宽容放宽）', async () => {
    const { sources, docs, assets } = base()
    docs.push({ id: 'plan-bad', kind: 'plan_item', workspace_id: WS.id, task_id: 't-gone', date: '2026-11-21', planned_minutes: 30, action_text: '虚构', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active' })
    const { entries } = await assembleArchive({ sources, docs, assets, formatVersion: 2, assistantThreads: [simpleThread()], assistantDrafts: [simpleDraft()] })
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => /计划任务 引用不存在的对象：t-gone/.test(e.message))).toBe(true)
  })
})

describe('B1B-18 助手 store 写入失败：六 store 整体回滚零残留', () => {
  async function residue(target) {
    const snap = await db.readWorkspaceSnapshot(target)
    const runtime = (await db.allFocusRuntime()).records.filter((r) => r.workspace_id === target)
    const raw = await openRaw(undefined, () => {})
    const ops = (await getAllRaw(raw, 'assistant_ops')).filter((r) => r.workspace_id === target)
    raw.close()
    return { ws: await db.getWorkspace(target), ...snap, runtime, ops }
  }

  it('assistant_drafts 写入失败 → 线程/草案/业务数据全部撤销，原空间不变，修复后可重试', async () => {
    await seedBusiness()
    await seedDrafts()
    const oracle = await db.readWorkspaceSnapshot(ws)
    const exp = await exportCurrent()
    const { prep } = await preparedFrom(exp.zipBytes)
    const restore = injectAddFailure('assistant_drafts')
    let code
    try { code = await codeOf(db.commitRestore(prep)) } finally { restore() }
    expect(code).toBe('RESTORE_WRITE_FAILED')
    const r = await residue(prep.targetWorkspaceId)
    expect(r.ws).toBeUndefined()
    expect(r.sources).toEqual([])
    expect(r.docs).toEqual([])
    expect(r.runtime).toEqual([])
    expect(r.assistantThreads).toEqual([])
    expect(r.assistantDrafts).toEqual([])
    expect(r.ops).toEqual([])
    expect(await db.readWorkspaceSnapshot(ws)).toEqual(oracle)
    const ok = await db.commitRestore(prep)
    expect(ok.alreadyCommitted).toBe(false)
    expect((await restoreMod.verifyCommittedRestore(prep)).ok).toBe(true)
  })

  it('assistant_threads 写入失败 → 同样零残留（草案不得先落库）', async () => {
    await seedBusiness()
    await seedDrafts()
    const exp = await exportCurrent()
    const { prep } = await preparedFrom(exp.zipBytes)
    const restore = injectAddFailure('assistant_threads')
    let code
    try { code = await codeOf(db.commitRestore(prep)) } finally { restore() }
    expect(code).toBe('RESTORE_WRITE_FAILED')
    const r = await residue(prep.targetWorkspaceId)
    expect(r.ws).toBeUndefined()
    expect(r.assistantThreads).toEqual([])
    expect(r.assistantDrafts).toEqual([])
    expect(r.docs).toEqual([])
  })
})

describe('B1B-19 幂等绑定扩展：助手计数/映射纳入同意图判定', () => {
  it('同意图重试返回原结果；篡改助手计数 → RESTORE_INTENT_MISMATCH', async () => {
    await seedBusiness()
    await seedDrafts()
    const exp = await exportCurrent()
    const { prep } = await preparedFrom(exp.zipBytes)
    const first = await db.commitRestore(prep)
    const second = await db.commitRestore(prep)
    expect(second.alreadyCommitted).toBe(true)
    expect(second.receipt.committed_at).toBe(first.receipt.committed_at)
    expect(await codeOf(db.commitRestore({ ...prep, assistantDraftCount: prep.assistantDraftCount + 1 }))).toBe('RESTORE_INTENT_MISMATCH')
    expect(await codeOf(db.commitRestore({ ...prep, assistantThreadCount: prep.assistantThreadCount + 1 }))).toBe('RESTORE_INTENT_MISMATCH')
    const found = await db.findRestoreByOperation(prep.operationId)
    expect(found.receipt.assistant_draft_count).toBe(prep.assistantDraftCount)
  })

  it('旧 v1 回执无助手计数字段 → 按 0 解释，同意图仍幂等（不改写旧回执）', async () => {
    const { entries } = await buildCompleteBackup()
    const { packArchive } = await import('@/services/backup/zip')
    const { prep } = await preparedFrom(packArchive(entries))
    await db.commitRestore(prep)
    const w = await db.getWorkspace(prep.targetWorkspaceId)
    const legacyReceipt = { ...w.restore_receipt }
    delete legacyReceipt.assistant_thread_count
    delete legacyReceipt.assistant_draft_count
    await db.putWorkspace({ ...w, restore_receipt: legacyReceipt })
    const retry = await db.commitRestore(prep)
    expect(retry.alreadyCommitted).toBe(true)
    const after = await db.getWorkspace(prep.targetWorkspaceId)
    expect(after.restore_receipt.assistant_thread_count).toBeUndefined()
    expect(after.restore_receipt.assistant_draft_count).toBeUndefined()
  })
})