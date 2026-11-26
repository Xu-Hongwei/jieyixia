import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { normalizePlanningContext as norm } from '../../frontend/src/domains/planning/normalize.js'
import { mkSnapshot, mkProposal, mkContext, mkWork, EV_SRC } from '../../frontend/src/tests/planning.helpers.js'
const candidate=value=>({value,precision:'date',evidence_refs:[EV_SRC]})
const proposal=mkProposal({task_proposals:[{op:'create',key:'t-1',title:'new',deadline_candidates:[candidate('2026-11-27')]},{op:'update',key:'up',target_id:'t-1',changes:{deadline_candidates:[candidate('2026-11-30')]}}],action_proposals:[{op:'create',key:'an',task_ref:{kind:'draft',key:'t-1'},text:'new step',minutes:60,basis:'suggestion'}],work_items:[mkWork('wn',{task_ref:{kind:'draft',key:'t-1'},action_ref:{kind:'draft',key:'an'}}),mkWork('wo',{action_ref:{kind:'existing',id:'a-1'}})]})
const confirmation=(scope,date)=>({confirmation_id:`c-${scope}`,draft_revision:1,object_type:'task',object_id_or_key:'t-1',id_scope:scope,field_path:'deadline',old_value:null,new_value:date===null?null:{value:date,precision:'date'},confirmed_at:'2026-11-24T08:00:00+08:00'})
const run=cs=>norm(mkSnapshot(),proposal,[],mkContext(),{taskDeadlineConfirmations:cs})
const a=confirmation('draft','2026-11-27'), b=confirmation('formal','2026-11-30')
const results=[]
for(const [label,cs] of [['none',[]],['draft_only',[a]],['formal_only',[b]]]){
  const r=run(cs);assert.equal(r.ok,false);results.push({case:label,blocked:true})
}
const both=run([a,b]);assert.equal(both.ok,true)
assert.equal(both.input.task_facts.find(f=>f.task_ref.kind==='draft').deadline_value,'2026-11-27')
assert.equal(both.input.task_facts.find(f=>f.task_ref.kind==='existing').deadline_value,'2026-11-30')
results.push({case:'both_separate',facts:both.input.task_facts})
for(const field of ['old_value','new_value','id_scope']){
  const missing={...a};delete missing[field]
  assert.throws(()=>run([missing,b]));results.push({case:`missing_${field}`,rejected:true})
}
for(const field of ['old_value','new_value']){
  const unset={...a,[field]:undefined};assert.throws(()=>run([unset,b]));assert.throws(()=>run([JSON.parse(JSON.stringify(unset)),b]))
  results.push({case:`undefined_${field}_and_json`,rejected:true})
}
const cleared=run([confirmation('draft',null),b]);assert.equal(cleared.ok,true)
assert.equal(cleared.input.task_facts.find(f=>f.task_ref.kind==='draft').deadline_precision,'none')
assert.equal(cleared.input.task_facts.find(f=>f.task_ref.kind==='existing').deadline_value,'2026-11-30')
results.push({case:'explicit_null_only_clears_intended_target',passed:true})
writeFileSync(new URL('./confirmations.json',import.meta.url),JSON.stringify(results,null,2)+'\n')
console.log('PASS: 10 groups; scopes, missing/undefined/JSON, explicit null checked.')
