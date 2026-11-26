import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { scheduleDaily } from '../../frontend/src/domains/planning/schedule.js'
import { normalizePlanningContext as norm } from '../../frontend/src/domains/planning/normalize.js'
import { mkInput, mkFact, mkWork, mkSnapshot, mkProposal, mkContext, EV_SRC, EV_USER } from '../../frontend/src/tests/planning.helpers.js'
const rows=[]
const req={requirement_id:'r',version:1,type:'daily_budget',value:30,strength:'hard',confirmed_at:'2026-11-24T08:00:00+08:00',evidence_refs:[EV_USER]}
const budget=norm(mkSnapshot(),mkProposal(),[req],mkContext([120,0,0,0,0,0,0]),{bufferPct:0})
assert.equal(budget.input.days[0].budget_minutes,30)
rows.push({case:'R1_hard_cap',passed:true})
const today=mkInput({buffer:0,facts:[mkFact('t-1',{deadline_value:'2026-11-24T23:59:00+08:00',deadline_precision:'datetime'})]})
assert.equal(scheduleDaily(today).unscheduled[0].reason,'needs_deadline_day_window')
today.task_facts[0].overdue_consent=true
assert.equal(scheduleDaily(today).segments.length,0)
rows.push({case:'R2_same_day',passed:true})
const far=mkInput({buffer:0,budgets:[60,0,0,0,0,0,0],facts:[mkFact('soon',{deadline_precision:'date',deadline_value:'2026-12-01'}),mkFact('later',{deadline_precision:'date',deadline_value:'2026-12-20'})],works:[mkWork('soon',{task_ref:{kind:'existing',id:'soon'},priority:'low'}),mkWork('later',{task_ref:{kind:'existing',id:'later'},priority:'high'})]})
assert.equal(scheduleDaily(far).segments[0].work_item_key,'soon')
rows.push({case:'R3_unclipped_order',passed:true})
const candidate=(value)=>({value,precision:'date',evidence_refs:[EV_SRC]})
const create=(key)=>({op:'create',key,title:'fictional new task',deadline_candidates:[candidate('2026-11-27')]})
const action=(key,task)=>({op:'create',key,task_ref:{kind:'draft',key:task},text:'fictional action',minutes:60,basis:'suggestion'})
const cf=(key)=>({confirmation_id:'c1',draft_revision:1,object_type:'task',object_id_or_key:key,field_path:'deadline',old_value:null,new_value:{value:'2026-11-27',precision:'date'},confirmed_at:'2026-11-24T08:00:00+08:00'})
const p=mkProposal({task_proposals:[create('new')],action_proposals:[action('an','new')],work_items:[mkWork('wn',{task_ref:{kind:'draft',key:'new'},action_ref:{kind:'draft',key:'an'}})]})
assert.equal(norm(mkSnapshot(),p,[],mkContext()).ok,false)
assert.equal(norm(mkSnapshot(),p,[],mkContext(),{taskDeadlineConfirmations:[cf('new')]}).input.task_facts[0].deadline_value,'2026-11-27')
rows.push({case:'R4_basic_clarify_confirm',passed:true})

const collision=mkProposal({task_proposals:[create('t-1'),{op:'update',key:'up',target_id:'t-1',changes:{deadline_candidates:[candidate('2026-11-30')]}}],action_proposals:[action('an','t-1')],work_items:[mkWork('wn',{task_ref:{kind:'draft',key:'t-1'},action_ref:{kind:'draft',key:'an'}}),mkWork('wo',{action_ref:{kind:'existing',id:'a-1'}})]})
const mixed=norm(mkSnapshot(),collision,[],mkContext(),{taskDeadlineConfirmations:[cf('t-1')]})
assert.equal(mixed.ok,true)
assert.equal(mixed.input.task_facts.length,2)
assert(mixed.input.task_facts.every(f=>f.deadline_value==='2026-11-27'))
rows.push({case:'confirmation_cross_namespace',expected:'existing task still requires its own confirmation',actual:mixed.input.task_facts,clarifications:mixed.clarifications})

const incomplete=cf('new')
delete incomplete.new_value
const missing=norm(mkSnapshot(),p,[],mkContext(),{taskDeadlineConfirmations:[incomplete]})
assert.equal(missing.ok,true)
assert.equal(missing.input.task_facts[0].deadline_precision,'none')
rows.push({case:'missing_new_value_clears_deadline',has_new_value:Object.hasOwn(incomplete,'new_value'),actual:missing.input.task_facts[0],clarifications:missing.clarifications})
writeFileSync(new URL('./results.json',import.meta.url),JSON.stringify(rows,null,2)+'\n')
console.log(JSON.stringify(rows,null,2))
