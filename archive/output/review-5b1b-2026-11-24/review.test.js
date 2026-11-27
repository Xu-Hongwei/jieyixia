// Independent review probes. Passing means the reported defect was reproduced.
import { beforeEach, expect, it, vi } from '../../frontend/node_modules/vitest/dist/index.js'
import { IDBFactory } from '../../frontend/node_modules/fake-indexeddb/build/esm/index.js'
import { mkProposal, mkContext, START } from '../../frontend/src/tests/planning.helpers.js'
let db, svc, now
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('../../frontend/src/services/storage/db.js')
  const { createAssistantDraftService } = await import('../../frontend/src/services/assistant/drafts.js')
  db.configureWorkspace('review-ws')
  now = '2026-11-24T10:00:00+08:00'
  let id = 0
  svc = createAssistantDraftService({ getWorkspaceId: () => 'review-ws', wallNow: () => now, newId: () => `review-${++id}` })
})
async function scheduled(budgets = [120,120,120,120,120,120,120]) {
  await db.putDoc({ id:'t-1', kind:'task', title:'虚构目标', status:'todo', deadline:{value:null,precision:'none'} })
  await db.putDoc({ id:'a-1', kind:'action', task_id:'t-1', text:'虚构行动', minutes:60, done:false })
  const c = await svc.create({ proposal:mkProposal() })
  expect(c.ok).toBe(true)
  const r = await svc.reschedule(c.draft.id, {expected:c.draft, context:mkContext(budgets)})
  expect(r.ok).toBe(true)
  return r.draft
}
it('R1: changed live occupancy and date still allow ready', async () => {
  const d = await scheduled()
  await db.putDoc({ id:'t-other', kind:'task', title:'另一个目标', status:'todo', deadline:{value:null,precision:'none'} })
  await db.putDoc({ id:'p-new', kind:'plan_item', task_id:'t-other', date:START, planned_minutes:120, state:'planned' })
  now = '2026-11-25T10:00:00+08:00'
  const g = await svc.get(d.id)
  expect(g.readiness).toEqual({ready:true,blockers:[]})
  const generating = await svc.setStatus(d.id,{expected:g.baseline.draft,status:'generating'})
  expect(generating.ok).toBe(true)
  const ready = await svc.setStatus(d.id,{expected:generating.draft,status:'ready'})
  expect(ready.ok).toBe(true)
  console.log('R1 stale ready:',ready.draft.status,'old occupancy:',ready.draft.planning_input.occupancy.length)
})
it('R2: unchanged scheduling at a later instant burns revision', async () => {
  const d = await scheduled()
  now = '2026-11-24T10:01:00+08:00'
  const r = await svc.reschedule(d.id,{expected:d,context:mkContext([120,120,120,120,120,120,120])})
  expect(r.ok).toBe(true)
  expect(r.draft.planning_input).toEqual(d.planning_input)
  expect(r.draft.planning_result).toEqual(d.planning_result)
  expect(r.draft.revision).toBe(d.revision+1)
  console.log('R2 revisions:',d.revision,r.draft.revision)
})
it('R3: explicitly acknowledged capacity gap remains permanently blocked', async () => {
  const d = await scheduled([30,0,0,0,0,0,0])
  expect(d.planning_result.complete).toBe(false)
  expect(d.planning_result.unscheduled.length).toBeGreaterThan(0)
  let current = d
  for (const [i,gap] of d.planning_result.unscheduled.entries()) {
    const r = await svc.confirm(d.id,{expected:current,confirmation:{confirmation_id:`gap-${i}`,draft_revision:d.revision,object_type:'gap',object_id_or_key:gap.work_item_key,field_path:'',old_value:null,new_value:null,confirmed_at:now}})
    expect(r.ok).toBe(true)
    current = r.draft
  }
  const g = await svc.get(d.id)
  expect(g.readiness.blockers.map(x=>x.code)).toEqual(['RESULT_INCOMPLETE'])
  console.log('R3 blockers:',g.readiness.blockers)
})
it('R4: service accepts unknown proposal fields but full backup fails', async () => {
  const r = await svc.create({proposal:mkProposal({work_items:[],unexpected_field:true})})
  expect(r.ok).toBe(true)
  const snapshot = await db.readWorkspaceSnapshot('review-ws')
  const {buildBackup} = await import('../../frontend/src/services/backup/export.js')
  let error
  try { await buildBackup(snapshot) } catch(e) { error = e }
  expect(error).toBeTruthy()
  console.log('R4 export error:',error.message,JSON.stringify(error.errors ?? error.details ?? null))
  expect(error.code).toBe('BACKUP_VALIDATION_FAILED')
  expect(error.errors.some(e=>e.path==='AssistantDraft.proposal')).toBe(true)
  delete snapshot.assistantDrafts[0].proposal.unexpected_field
  const control = await buildBackup(snapshot)
  expect(control.zipBytes.length).toBeGreaterThan(0)
  console.log('R4 control: removing only unknown field restores successful backup')
})
