import { beforeEach, expect, it, vi } from '../../frontend/node_modules/vitest/dist/index.js'
import { IDBFactory } from '../../frontend/node_modules/fake-indexeddb/build/esm/index.js'
import { mkProposal, mkContext, START, EV_SRC } from '../../frontend/src/tests/planning.helpers.js'
let db, svc, now
beforeEach(async()=>{
 globalThis.indexedDB=new IDBFactory(); vi.resetModules()
 db=await import('../../frontend/src/services/storage/db.js')
 const {createAssistantDraftService}=await import('../../frontend/src/services/assistant/drafts.js')
 db.configureWorkspace('review-ws'); now='2026-11-24T10:00:00+08:00'; let id=0
 svc=createAssistantDraftService({getWorkspaceId:()=> 'review-ws', wallNow:()=>now,newId:()=>`review-${++id}`})
 await db.putDoc({id:'t-1',kind:'task',title:'虚构目标',status:'todo',deadline:{value:null,precision:'none'}})
 await db.putDoc({id:'a-1',kind:'action',task_id:'t-1',text:'虚构行动',minutes:60,done:false})
})
const ctx=()=>mkContext([120,120,120,120,120,120,120])
async function scheduled(proposal=mkProposal(), context=ctx()) {
 const c=await svc.create({proposal}); expect(c.ok,JSON.stringify(c)).toBe(true)
 const r=await svc.reschedule(c.draft.id,{expected:c.draft,context}); expect(r.ok,JSON.stringify(r)).toBe(true)
 return r.draft
}
async function readyAttempt(d) {
 const g=await svc.setStatus(d.id,{expected:d,status:'generating'}); expect(g.ok).toBe(true)
 return svc.setStatus(d.id,{expected:g.draft,status:'ready'})
}
it('fixed R1: new occupancy and midnight block ready',async()=>{
 const d=await scheduled()
 await db.putDoc({id:'p-new',kind:'plan_item',task_id:'t-1',date:START,planned_minutes:120,state:'planned'})
 now='2026-11-25T10:00:00+08:00'
 const g=await svc.get(d.id)
 expect(g.readiness.ready).toBe(false)
 expect(g.readiness.blockers.map(x=>x.code)).toEqual(expect.arrayContaining(['OCCUPANCY_ADDED','WINDOW_STALE']))
 expect((await readyAttempt(d)).code).toBe('READY_BLOCKED')
})
it('fixed R2: unchanged reschedule retains revision',async()=>{
 const d=await scheduled(); now='2026-11-24T10:01:00+08:00'
 const r=await svc.reschedule(d.id,{expected:d,context:ctx()})
 expect(r.ok).toBe(true); expect(r.bumped).toBe(false); expect(r.draft.revision).toBe(d.revision)
})
it('fixed R3: acknowledged known gap permits ready',async()=>{
 let d=await scheduled(mkProposal(),mkContext([30,0,0,0,0,0,0]))
 for(const [i,g] of d.planning_result.unscheduled.entries()) {
  const r=await svc.confirm(d.id,{expected:d,confirmation:{confirmation_id:`g-${i}`,draft_revision:d.revision,object_type:'gap',object_id_or_key:g.work_item_key,field_path:'',old_value:null,new_value:null,confirmed_at:now}})
  expect(r.ok).toBe(true); d=r.draft
 }
 expect((await svc.get(d.id)).readiness.ready).toBe(true)
 expect((await readyAttempt(d)).ok).toBe(true)
})
it('fixed R4: unknown nested field rejected atomically',async()=>{
 const r=await svc.create({proposal:mkProposal({unexpected_field:true})})
 expect(r.code).toBe('SHAPE_INVALID'); const all=await svc.list()
 expect(all.drafts).toHaveLength(0); expect(all.threads).toHaveLength(0)
})
it('remaining R1: newly confirmed zero daily budget does not invalidate old ready',async()=>{
 const d=await scheduled(); const g=await svc.get(d.id)
 const req=await svc.confirmRequirement(d.thread_id,{expected:g.thread,requirement:{requirement_id:'budget-zero',version:1,type:'daily_budget',value:0,strength:'hard',confirmed_at:now,evidence_refs:[]}})
 expect(req.ok,JSON.stringify(req)).toBe(true)
 const after=await svc.get(d.id)
 expect(after.readiness.ready).toBe(true)
 expect((await readyAttempt(d)).ok).toBe(true)
 console.log('DEFECT requirements drift: confirmed budget=0, stored budgets=',after.draft.planning_input.days.map(d=>d.budget_minutes),'ready=',after.readiness.ready)
})
it('new regression: approved proposed deadline mistaken for live fact drift',async()=>{
 await db.putSource({id:'s-1',kind:'text',text:'虚构要求：11月30日交付'})
 const deadline={value:'2026-11-30',precision:'date'}
 const candidate={...deadline,origin:'model',derived:false,basis:'explicit',evidence_refs:[EV_SRC]}
 const c=await svc.create({proposal:mkProposal({task_proposals:[{op:'update',key:'update-t',target_id:'t-1',changes:{deadline_candidates:[candidate]},evidence_refs:[EV_SRC]}]})})
 expect(c.ok,JSON.stringify(c)).toBe(true)
 const confirmation={confirmation_id:'deadline-confirm',draft_revision:c.draft.revision,object_type:'task',id_scope:'formal',object_id_or_key:'t-1',field_path:'deadline',old_value:null,new_value:deadline,confirmed_at:now}
 const cf=await svc.confirm(c.draft.id,{expected:c.draft,confirmation}); expect(cf.ok).toBe(true)
 const r=await svc.reschedule(c.draft.id,{expected:cf.draft,context:ctx()}); expect(r.ok,JSON.stringify(r)).toBe(true)
 const cf2=await svc.confirm(c.draft.id,{expected:r.draft,confirmation:{...confirmation,confirmation_id:'deadline-confirm-current',draft_revision:r.draft.revision}}); expect(cf2.ok).toBe(true)
 const g=await svc.get(c.draft.id)
 expect(g.readiness.blockers.map(x=>x.code)).toEqual(['TASK_DEADLINE_CHANGED'])
 console.log('DEFECT legitimate deadline preview:',g.readiness.blockers)
})
it('remaining R1: text evidence hashes empty bytes and content changes stay fresh',async()=>{
 await db.putSource({id:'s-1',kind:'text',text:'虚构原文一'})
 const d=await scheduled(mkProposal({evidence_refs:[EV_SRC]}))
 expect(d.fact_baseline.source_fingerprints[0].bytes).toBe(0)
 await db.putSource({id:'s-1',kind:'text',text:'完全不同的虚构原文二'})
 const g=await svc.get(d.id)
 expect(g.factFreshness.fresh).toBe(true); expect(g.readiness.ready).toBe(true)
 const r=await svc.reschedule(d.id,{expected:d,context:ctx()})
 expect(r.ok).toBe(true); expect(r.bumped).toBe(false)
 console.log('DEFECT text fingerprint:',d.fact_baseline.source_fingerprints[0], 'changed text fresh:',g.factFreshness.fresh)
})
