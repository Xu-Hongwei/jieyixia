import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { scheduleDaily } from '../../frontend/src/domains/planning/schedule.js'
import { normalizePlanningContext } from '../../frontend/src/domains/planning/normalize.js'
import { validatePlanningResult } from '../../frontend/src/domains/planning/validate.js'
import { mkInput, mkFact, mkWork, mkSnapshot, mkProposal, mkContext, EV_SRC, EV_USER } from '../../frontend/src/tests/planning.helpers.js'

const results = []
const req = {requirement_id:'r1', version:1, type:'daily_budget', value:30, strength:'hard', confirmed_at:'2026-11-24T08:00:00+08:00', evidence_refs:[EV_USER]}
const normalized = normalizePlanningContext(mkSnapshot(), mkProposal({work_items:[mkWork('w1',{remaining_minutes:100,action_ref:{kind:'existing',id:'a-1'}})]}), [req], mkContext([120,0,0,0,0,0,0]), {bufferPct:0})
assert.equal(normalized.ok,true)
const budgetResult = scheduleDaily(normalized.input)
assert.equal(budgetResult.segments[0].minutes,100)
results.push({case:'hard_daily_budget_ignored', requested:30, effective:normalized.input.days[0].budget_minutes, allocated:budgetResult.segments[0].minutes})

const today = mkInput({buffer:0,facts:[mkFact('t-1',{deadline_value:'2026-11-24T23:59:00+08:00',deadline_precision:'datetime'})],works:[mkWork('w1',{remaining_minutes:30})]})
const todayResult = scheduleDaily(today)
validatePlanningResult(today,todayResult)
assert.equal(todayResult.unscheduled[0].reason,'overdue_requires_consent')
const consented = structuredClone(today)
consented.task_facts[0].overdue_consent = true
consented.work_items[0].remaining_minutes = 120
const afterConsent = scheduleDaily(consented)
assert(afterConsent.segments.some(s=>s.date>'2026-11-24'))
results.push({case:'today_deadline_reported_overdue',result:todayResult.unscheduled,after_overdue_consent:afterConsent.segments.map(s=>({date:s.date,minutes:s.minutes}))})

const far = mkInput({buffer:0,budgets:[60,0,0,0,0,0,0],facts:[mkFact('soon',{deadline_precision:'date',deadline_value:'2026-12-01'}),mkFact('later',{deadline_precision:'date',deadline_value:'2026-12-20'})],works:[mkWork('soon',{task_ref:{kind:'existing',id:'soon'},priority:'low'}),mkWork('later',{task_ref:{kind:'existing',id:'later'},priority:'high'})]})
const farResult = scheduleDaily(far)
validatePlanningResult(far,farResult)
assert.equal(farResult.segments[0].work_item_key,'later')
results.push({case:'outside_horizon_deadline_order_lost',scheduled:farResult.segments.map(s=>s.work_item_key),unscheduled:farResult.unscheduled})

const proposal = mkProposal({task_proposals:[{op:'create',key:'tn',title:'fictional report',deadline_candidates:[{value:'2026-11-24',precision:'date',evidence_refs:[EV_SRC]}]}],action_proposals:[{op:'create',key:'an',task_ref:{kind:'draft',key:'tn'},text:'prepare report',minutes:60,basis:'suggestion'}],work_items:[mkWork('wn',{task_ref:{kind:'draft',key:'tn'},action_ref:{kind:'draft',key:'an'}})]})
const newTask = normalizePlanningContext(mkSnapshot(),proposal,[],mkContext([0,60,0,0,0,0,0]),{bufferPct:0})
assert.equal(newTask.ok,true)
assert.equal(newTask.clarifications.length,0)
const newResult = scheduleDaily(newTask.input)
assert.equal(newResult.complete,true)
assert.equal(newResult.segments[0].date,'2026-11-25')
results.push({case:'unresolved_deadline_silently_absent',fact:newTask.input.task_facts[0],clarifications:newTask.clarifications,complete:newResult.complete,scheduled_date:newResult.segments[0].date})

writeFileSync(new URL('./results.json',import.meta.url),JSON.stringify(results,null,2)+'\n')
console.log(JSON.stringify(results,null,2))
console.log('Four discrepancies reproduced; no production edits/network/database access.')
