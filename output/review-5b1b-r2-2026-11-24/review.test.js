import { beforeEach, afterEach, expect, it, vi } from '../../frontend/node_modules/vitest/dist/index.js'
import { IDBFactory } from '../../frontend/node_modules/fake-indexeddb/build/esm/index.js'
import { mkProposal, mkContext, EV_SRC } from '../../frontend/src/tests/planning.helpers.js'
let db,svc
const now='2026-11-24T10:00:00+08:00'
const ctx=()=>mkContext([120,120,120,120,120,120,120])
beforeEach(async()=>{
 globalThis.indexedDB=new IDBFactory(); vi.resetModules()
 db=await import('../../frontend/src/services/storage/db.js')
 const {createAssistantDraftService}=await import('../../frontend/src/services/assistant/drafts.js')
 db.configureWorkspace('review-ws'); let id=0
 svc=createAssistantDraftService({getWorkspaceId:()=> 'review-ws',wallNow:()=>now,newId:()=>`review-${++id}`})
 await db.putDoc({id:'t-1',kind:'task',title:'虚构目标',status:'todo',deadline:{value:null,precision:'none'}})
 await db.putDoc({id:'a-1',kind:'action',task_id:'t-1',text:'虚构行动',minutes:60,done:false})
})
afterEach(()=>vi.restoreAllMocks())
async function scheduled(proposal=mkProposal()) {
 const c=await svc.create({proposal}); expect(c.ok,JSON.stringify(c)).toBe(true)
 const r=await svc.reschedule(c.draft.id,{expected:c.draft,context:ctx()}); expect(r.ok,JSON.stringify(r)).toBe(true)
 return r.draft
}
async function ready(d) {
 const g=await svc.setStatus(d.id,{expected:d,status:'generating'}); expect(g.ok).toBe(true)
 return svc.setStatus(d.id,{expected:g.draft,status:'ready'})
}
it('R5 fixed: new requirements invalidate old computation and block ready',async()=>{
 const d=await scheduled(); const g=await svc.get(d.id)
 const req=await svc.confirmRequirement(d.thread_id,{expected:g.thread,requirement:{requirement_id:'budget-zero',version:1,type:'daily_budget',value:0,strength:'hard',confirmed_at:now,evidence_refs:[]}})
 expect(req.ok).toBe(true)
 const after=await svc.get(d.id)
 expect(after.readiness.ready).toBe(false); expect(after.draft.fact_baseline).toBeNull()
 expect((await ready(after.draft)).code).toBe('READY_BLOCKED')
})
async function deadlineDraft(selected) {
 await db.putSource({id:'s-1',kind:'text',text:'虚构要求：11月30日交付'})
 const candidate={value:'2026-11-30',precision:'date',origin:'model',derived:false,basis:'explicit',evidence_refs:[EV_SRC]}
 const c=await svc.create({proposal:mkProposal({task_proposals:[{op:'update',key:'update-t',target_id:'t-1',changes:{deadline_candidates:[candidate]},evidence_refs:[EV_SRC]}]})})
 expect(c.ok).toBe(true)
 const cf={confirmation_id:'dl-initial',draft_revision:c.draft.revision,object_type:'task',id_scope:'formal',object_id_or_key:'t-1',field_path:'deadline',old_value:null,new_value:selected,confirmed_at:now}
 const c1=await svc.confirm(c.draft.id,{expected:c.draft,confirmation:cf}); expect(c1.ok).toBe(true)
 const r=await svc.reschedule(c.draft.id,{expected:c1.draft,context:ctx()}); expect(r.ok,JSON.stringify(r)).toBe(true)
 const c2=await svc.confirm(c.draft.id,{expected:r.draft,confirmation:{...cf,confirmation_id:'dl-current',draft_revision:r.draft.revision}}); expect(c2.ok).toBe(true)
 return c2.draft
}
it('R6 fixed: proposed date is not mistaken for external drift',async()=>{
 const d=await deadlineDraft({value:'2026-11-30',precision:'date'})
 expect((await svc.get(d.id)).readiness.ready).toBe(true)
 expect((await ready(d)).ok).toBe(true)
 const task=await db.allDocs()
 expect(task.records.find(x=>x.id==='t-1').deadline.precision).toBe('none')
})
it('R7 fixed: text fingerprint uses UTF8 and changes invalidate ready',async()=>{
 await db.putSource({id:'s-1',kind:'text',text:'虚构原文一'})
 const d=await scheduled(mkProposal({evidence_refs:[EV_SRC]}))
 expect(d.fact_baseline.source_fingerprints[0].bytes).toBe(15)
 await db.putSource({id:'s-1',kind:'text',text:'虚构原文二'})
 const g=await svc.get(d.id)
 expect(g.readiness.ready).toBe(false)
 expect(g.factFreshness.diffs.map(x=>x.code)).toContain('SOURCE_CONTENT_CHANGED')
 expect((await ready(d)).code).toBe('READY_BLOCKED')
})
it('remaining deadline choice: explicit no-deadline accepted by schedule but rejected by ready',async()=>{
 const d=await deadlineDraft(null)
 expect(d.planning_input.task_facts[0].deadline_precision).toBe('none')
 const g=await svc.get(d.id)
 expect(g.readiness.blockers.map(x=>x.code)).toEqual(['CONFIRMATION_VALUE_STALE'])
 console.log('DEFECT explicit no-deadline:',g.readiness.blockers)
})
it('remaining R7 race: same-size image replacement after hash allows stale ready',async()=>{
 const original={id:'s-1',kind:'image',name:'虚构.png',captured_at:now,blob:new Blob([new Uint8Array([1,2,3])],{type:'image/png'})}
 await db.putSource(original)
 const d=await scheduled(mkProposal({evidence_refs:[EV_SRC]}))
 const generating=await svc.setStatus(d.id,{expected:d,status:'generating'}); expect(generating.ok).toBe(true)
 const realDigest=crypto.subtle.digest.bind(crypto.subtle)
 let changed=false
 vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{
  const result=await realDigest(...args)
  if(!changed){
   changed=true
   await db.putSource({...original,blob:new Blob([new Uint8Array([9,8,7])],{type:'image/png'})})
  }
  return result
 })
 const r=await svc.setStatus(d.id,{expected:generating.draft,status:'ready'})
 expect(changed).toBe(true); expect(r.ok,JSON.stringify(r)).toBe(true); expect(r.draft.status).toBe('ready')
 vi.restoreAllMocks()
 const g=await svc.get(d.id)
 expect(g.readiness.ready).toBe(false)
 expect(g.factFreshness.diffs.map(x=>x.code)).toContain('SOURCE_CONTENT_CHANGED')
 console.log('DEFECT hash/commit race: setStatus succeeded, immediate get blocks',g.factFreshness.diffs)
})
