// 5B-1A 整改后验证：与审查探针相同的四组输入，断言整改后的正确行为；
// 并逐条回放旧探针断言作负对照（旧断言应全部失败）。
// 复制自审查探针的输入构造，不回写审查原目录；结果写本目录 results-after.json。
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { scheduleDaily } from '../../frontend/src/domains/planning/schedule.js'
import { normalizePlanningContext } from '../../frontend/src/domains/planning/normalize.js'
import { validatePlanningResult } from '../../frontend/src/domains/planning/validate.js'
import { mkInput, mkFact, mkWork, mkSnapshot, mkProposal, mkContext, EV_SRC, EV_USER } from '../../frontend/src/tests/planning.helpers.js'

const results = []
const negative = []
const oldAssertion = (name, fn) => {
  try { fn(); negative.push({ old_assertion: name, still_holds: true }) }
  catch { negative.push({ old_assertion: name, still_holds: false }) }
}

// R1：已确认硬上限 30 与旧日预算 120 取更小值；只排 30，余 70 列未排。
const req = { requirement_id: 'r1', version: 1, type: 'daily_budget', value: 30, strength: 'hard', confirmed_at: '2026-11-24T08:00:00+08:00', evidence_refs: [EV_USER] }
const normalized = normalizePlanningContext(mkSnapshot(), mkProposal({ work_items: [mkWork('w1', { remaining_minutes: 100, action_ref: { kind: 'existing', id: 'a-1' } })] }), [req], mkContext([120, 0, 0, 0, 0, 0, 0]), { bufferPct: 0 })
assert.equal(normalized.ok, true)
assert.equal(normalized.input.days[0].budget_minutes, 30)
const budgetResult = scheduleDaily(normalized.input)
validatePlanningResult(normalized.input, budgetResult)
assert.equal(budgetResult.segments.reduce((a, s) => a + s.minutes, 0), 30)
assert.equal(budgetResult.unscheduled[0].remaining_minutes, 70)
results.push({ case: 'R1_hard_daily_budget', effective_budget: normalized.input.days[0].budget_minutes, allocated: 30, unscheduled: budgetResult.unscheduled })
oldAssertion('segments[0].minutes === 100', () => assert.equal(budgetResult.segments[0].minutes, 100))

// R2：当天 23:59 精确截止不是逾期；走时段核对缺口；补做确认不改变（未真逾期）。
const today = mkInput({ buffer: 0, facts: [mkFact('t-1', { deadline_value: '2026-11-24T23:59:00+08:00', deadline_precision: 'datetime' })], works: [mkWork('w1', { remaining_minutes: 30 })] })
const todayResult = scheduleDaily(today)
validatePlanningResult(today, todayResult)
assert.equal(todayResult.unscheduled[0].reason, 'needs_deadline_day_window')
assert.ok(todayResult.warnings.some((w) => w.code === 'datetime_deadline_conservative'))
const consented = structuredClone(today)
consented.task_facts[0].overdue_consent = true
consented.work_items[0].remaining_minutes = 120
const afterConsent = scheduleDaily(consented)
validatePlanningResult(consented, afterConsent)
assert.equal(afterConsent.segments.length, 0)
assert.equal(afterConsent.unscheduled[0].reason, 'needs_deadline_day_window')
results.push({ case: 'R2_same_day_datetime', reason: todayResult.unscheduled[0].reason, after_consent_segments: afterConsent.segments.length, after_consent_reason: afterConsent.unscheduled[0].reason })
oldAssertion('reason === overdue_requires_consent', () => assert.equal(todayResult.unscheduled[0].reason, 'overdue_requires_consent'))
oldAssertion('consent schedules next day', () => assert.ok(afterConsent.segments.some((s) => s.date > '2026-11-24')))

// R3：两个截止均在窗口外，12-01（low）仍先于 12-20（high）。
const far = mkInput({ buffer: 0, budgets: [60, 0, 0, 0, 0, 0, 0], facts: [mkFact('soon', { deadline_precision: 'date', deadline_value: '2026-12-01' }), mkFact('later', { deadline_precision: 'date', deadline_value: '2026-12-20' })], works: [mkWork('soon', { task_ref: { kind: 'existing', id: 'soon' }, priority: 'low' }), mkWork('later', { task_ref: { kind: 'existing', id: 'later' }, priority: 'high' })] })
const farResult = scheduleDaily(far)
validatePlanningResult(far, farResult)
assert.equal(farResult.segments[0].work_item_key, 'soon')
assert.equal(farResult.unscheduled[0].work_item_key, 'later')
assert.equal(farResult.unscheduled[0].reason, 'deadline_window')
results.push({ case: 'R3_outside_window_order', scheduled: farResult.segments.map((s) => s.work_item_key), unscheduled: farResult.unscheduled })
oldAssertion('segments[0] === later', () => assert.equal(farResult.segments[0].work_item_key, 'later'))

// R4：有截止候选未确认 → 澄清而非按无截止排程；确认后截止成为事实并约束排程。
const proposal = mkProposal({ task_proposals: [{ op: 'create', key: 'tn', title: 'fictional report', deadline_candidates: [{ value: '2026-11-24', precision: 'date', evidence_refs: [EV_SRC] }] }], action_proposals: [{ op: 'create', key: 'an', task_ref: { kind: 'draft', key: 'tn' }, text: 'prepare report', minutes: 60, basis: 'suggestion' }], work_items: [mkWork('wn', { task_ref: { kind: 'draft', key: 'tn' }, action_ref: { kind: 'draft', key: 'an' } })] })
const ctx = mkContext([0, 60, 0, 0, 0, 0, 0])
const unconfirmed = normalizePlanningContext(mkSnapshot(), proposal, [], ctx, { bufferPct: 0 })
assert.equal(unconfirmed.ok, false)
assert.equal(unconfirmed.input, null)
assert.equal(unconfirmed.clarifications[0].question_id, 'q-deadline-confirm')
const confirm = { confirmation_id: 'cf-1', draft_revision: 1, object_type: 'task', object_id_or_key: 'tn', id_scope: 'draft', field_path: 'deadline', old_value: null, new_value: { value: '2026-11-24', precision: 'date' }, confirmed_at: '2026-11-24T08:00:00+08:00' }
const confirmed = normalizePlanningContext(mkSnapshot(), proposal, [], ctx, { bufferPct: 0, taskDeadlineConfirmations: [confirm] })
assert.equal(confirmed.ok, true)
assert.equal(confirmed.input.task_facts[0].deadline_value, '2026-11-24')
assert.equal(confirmed.input.task_facts[0].deadline_precision, 'date')
const confirmedResult = scheduleDaily(confirmed.input)
validatePlanningResult(confirmed.input, confirmedResult)
assert.equal(confirmedResult.segments.length, 0)
assert.equal(confirmedResult.unscheduled[0].reason, 'deadline_window')
results.push({ case: 'R4_deadline_confirmation', unconfirmed_question: unconfirmed.clarifications[0].question_id, confirmed_fact: confirmed.input.task_facts[0], confirmed_reason: confirmedResult.unscheduled[0].reason })
oldAssertion('unconfirmed ok:true + no clarification', () => { assert.equal(unconfirmed.ok, true); assert.equal(unconfirmed.clarifications.length, 0) })
oldAssertion('unconfirmed schedules 2026-11-25 complete', () => assert.equal(confirmedResult.segments[0]?.date, '2026-11-25'))

assert.ok(negative.every((n) => n.still_holds === false), '负对照：旧错误断言必须全部失败')
writeFileSync(new URL('./results-after.json', import.meta.url), JSON.stringify({ correct_behavior: results, negative_control: negative }, null, 2) + '\n')
console.log(JSON.stringify({ correct_behavior: results, negative_control: negative }, null, 2))
console.log('R1–R4 正确行为全部成立；旧探针 6 条错误断言全部失败（负对照通过）。')