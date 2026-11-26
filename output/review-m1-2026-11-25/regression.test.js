// M1 采用协调服务单测（fake-indexeddb；全部虚构数据）。
// 覆盖：prepare 零写入、单事务整体提交、双击/双标签去重、失败整体回滚+同意图重试、
// 事实漂移 needs_recheck、切空间 result_unknown 收敛、settleRefresh 回执验证、resolve 只查原意图、
// applying/applied/result_unknown 状态锁、link/reuse 不改既有对象、缺口/过载独立确认。
import { IDBFactory, IDBObjectStore } from '../../frontend/node_modules/fake-indexeddb/build/esm/index.js'
import { beforeEach, describe, expect, it, vi } from '../../frontend/node_modules/vitest/dist/index.js'
import { mkProposal, mkContext, EV_SRC, START } from '../../frontend/src/tests/planning.helpers.js'

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
  db = await import('../../frontend/src/services/storage/db')
  const { createAssistantDraftService } = await import('../../frontend/src/services/assistant/drafts')
  const { createAssistantApplicationService } = await import('../../frontend/src/services/assistant/applications')
  ws = 'w1'
  db.configureWorkspace(ws)
  counter = 0
  queues = new Map()
  const deps = { getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `id-${++counter}`, queues }
  dsvc = createAssistantDraftService(deps)
  asvc = createAssistantApplicationService(deps)
})

async function seedBusiness() {
  await db.putSource({ id: 's-1', kind: 'image', blob: new Blob([new Uint8Array([1, 2, 3])]), name: '虚构.png' })
  await db.putDoc({ id: 'n-1', kind: 'note', title: '虚构便签', source_id: 's-1', fields: [] })
  await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' } })
  await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false })
}
const planDoc = (id, over = {}) => ({ id, kind: 'plan_item', task_id: 't-1', date: START, planned_minutes: 30, action_text: '虚构', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over })

// create 三步闭环到 ready（与 R10 同口径）：初版确认 → 重排 → 当前版确认 → generating → ready。
async function readyCreateDraft() {
  await seedBusiness()
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


it('REVIEW: changed envelope minutes must be rejected', async()=>{
 const d=await readyCreateDraft(); const p=await asvc.prepare(d.id,{expected:d});
 p.envelope.write_set.plan_items_create[0].planned_minutes=999;
 const r=await asvc.apply(d.id,{expected:d,envelope:p.envelope});
 console.log('REVIEW_TAMPER',JSON.stringify({result:r,docs:await newDocs()}));
 expect(r.ok).toBe(false);
});
it('REVIEW: changed reused action content must invalidate preview',async()=>{
 const d=await readyLinkDraft(); const p=await asvc.prepare(d.id,{expected:d});
 const a=(await db.allDocs()).records.find(x=>x.id==='a-1');
 await db.putDoc({...a,text:'Changed after preview',minutes:999});
 const r=await asvc.apply(d.id,{expected:d,envelope:p.envelope});
 console.log('REVIEW_ACTION_DRIFT',JSON.stringify(r)); expect(r.ok).toBe(false);
});
it('REVIEW: excluded-only new objects must not be created',async()=>{
 const d=await readyCreateDraft();
 const {buildAdoptionPlan}=await import('../../frontend/src/domains/assistant/application.js');
 const x=structuredClone(d); x.planning_result.segments=[]; x.planning_result.unscheduled=[];
 x.excluded_items=[{work_item_key:'w1',excluded_by:'user',reason:'not wanted'}];
 x.planning_result.excluded_items=x.excluded_items; x.planning_input.work_items=[];
 const p=buildAdoptionPlan(x,{workspaceId:ws,now:TS,newId:()=>`x-${++counter}`});
 console.log('REVIEW_EXCLUDED',JSON.stringify(p.counts));
 expect(p.counts.tasks_created+p.counts.actions_created).toBe(0);
});

it('REVIEW: real saved excluded draft must not create excluded task/action',async()=>{
 const d=await readyCreateDraft();
 let e=await dsvc.edit(d.id,{expected:d,edits:{excluded_items:[{work_item_key:'w1',excluded_by:'user',reason:'not wanted'}]}});
 expect(e.ok,JSON.stringify(e)).toBe(true);
 let c=await dsvc.confirm(d.id,{expected:e.draft,confirmation:dlConf(e.draft.revision,'exclude-dl')});expect(c.ok,JSON.stringify(c)).toBe(true);
 let r=await dsvc.reschedule(d.id,{expected:c.draft,context:mkContext(FULL)});expect(r.ok,JSON.stringify(r)).toBe(true);
 c=await dsvc.confirm(d.id,{expected:r.draft,confirmation:dlConf(r.draft.revision,'exclude-dl2')});expect(c.ok,JSON.stringify(c)).toBe(true);
 let g=await dsvc.setStatus(d.id,{expected:c.draft,status:'generating'});expect(g.ok,JSON.stringify(g)).toBe(true);
 let ready=await dsvc.setStatus(d.id,{expected:g.draft,status:'ready'});expect(ready.ok,JSON.stringify(ready)).toBe(true);
 let prep=await asvc.prepare(d.id,{expected:ready.draft});
 if(!prep.ok) return;
 let out=await asvc.apply(d.id,{expected:ready.draft,envelope:prep.envelope});
 console.log('REVIEW_REAL_EXCLUDED',JSON.stringify({ok:out.ok,counts:out.counts,excluded:ready.draft.planning_result.excluded_items,segments:ready.draft.planning_result.segments}));
 expect(await newDocs()).toHaveLength(0);
});
