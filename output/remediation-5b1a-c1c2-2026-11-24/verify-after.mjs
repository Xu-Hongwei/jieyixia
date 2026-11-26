// 5B-1A 复验 C1/C2 整改后独立验证（正确预期；与审查探针的旧错误断言相反）。
// 运行：node output/remediation-5b1a-c1c2-2026-11-24/verify-after.mjs
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { normalizePlanningContext as norm } from '../../frontend/src/domains/planning/normalize.js'
import { mkWork, mkSnapshot, mkProposal, mkContext, EV_SRC } from '../../frontend/src/tests/planning.helpers.js'

const rows = []
const cand = (value) => ({ value, precision: 'date', evidence_refs: [EV_SRC] })
const collision = mkProposal({
  task_proposals: [
    { op: 'create', key: 't-1', title: '虚构新目标', deadline_candidates: [cand('2026-11-27')], evidence_refs: [EV_SRC] },
    { op: 'update', key: 't-up', target_id: 't-1', changes: { deadline_candidates: [cand('2026-11-30')] }, evidence_refs: [EV_SRC] },
  ],
  action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-1' }, text: '虚构步骤', minutes: 60 }],
  work_items: [
    mkWork('wn', { task_ref: { kind: 'draft', key: 't-1' }, action_ref: { kind: 'draft', key: 'a-new' } }),
    mkWork('wo', { action_ref: { kind: 'existing', id: 'a-1' } }),
  ],
})
const cf = (scope, value, over = {}) => ({
  confirmation_id: `cf-${scope}`, draft_revision: 1, object_type: 'task', object_id_or_key: 't-1',
  id_scope: scope, field_path: 'deadline', old_value: null,
  new_value: value === null ? null : { value, precision: 'date' },
  confirmed_at: '2026-11-24T08:00:00+08:00', ...over,
})
const run = (confirmations) => norm(mkSnapshot(), collision, [], mkContext(), { taskDeadlineConfirmations: confirmations })

// C1-1 碰名 + 仅一条 draft 确认：formal 不得被串用（复验案例的修复后正确预期）。
const draftOnly = run([cf('draft', '2026-11-27')])
assert.equal(draftOnly.ok, false)
assert.equal(draftOnly.clarifications.length, 1)
assert.ok(draftOnly.clarifications[0].question.includes('虚构目标一'))
rows.push({ case: 'C1_collision_draft_only_formal_pending', passed: true })

// C1-2 反向：仅 formal 确认，draft 仍待确认。
const formalOnly = run([cf('formal', '2026-11-30')])
assert.equal(formalOnly.ok, false)
assert.equal(formalOnly.clarifications.length, 1)
assert.ok(formalOnly.clarifications[0].question.includes('虚构新目标'))
rows.push({ case: 'C1_collision_formal_only_draft_pending', passed: true })

// C1-3 各自确认：各得自己的值。
const both = run([cf('draft', '2026-11-27'), cf('formal', '2026-11-30')])
assert.equal(both.ok, true)
assert.equal(both.input.task_facts.find((f) => f.task_ref.kind === 'draft').deadline_value, '2026-11-27')
assert.equal(both.input.task_facts.find((f) => f.task_ref.kind === 'existing').deadline_value, '2026-11-30')
rows.push({ case: 'C1_collision_both_confirmed_own_values', passed: true })

// C1-4 缺判别 / 错误判别 → 拒绝（不得回退按名匹配）。
const noScope = cf('draft', '2026-11-27')
delete noScope.id_scope
assert.throws(() => run([noScope]), /id_scope/)
assert.throws(() => run([cf('draft', '2026-11-27', { id_scope: 'workspace' })]), /id_scope/)
rows.push({ case: 'C1_missing_or_bad_scope_rejected', passed: true })

// C2-1 缺 new_value → 拒绝，不得取消截止约束（复验案例的修复后正确预期）。
const missingNew = cf('draft', '2026-11-27')
delete missingNew.new_value
assert.throws(() => run([missingNew]), /显式携带 new_value/)
const missingOld = cf('draft', '2026-11-27')
delete missingOld.old_value
assert.throws(() => run([missingOld]), /显式携带 old_value/)
rows.push({ case: 'C2_missing_fields_rejected', passed: true })

// C2-2 undefined 与序列化洗白路径 → 仍拒绝。
assert.throws(() => run([cf('draft', '2026-11-27', { new_value: undefined })]), /显式携带 new_value/)
assert.throws(() => run([JSON.parse(JSON.stringify(cf('draft', '2026-11-27', { new_value: undefined })))]), /显式携带 new_value/)
rows.push({ case: 'C2_undefined_and_roundtrip_rejected', passed: true })

// C2-3 显式 null → 明确无截止（唯一合法清除路径）。
const explicitNone = run([cf('draft', null)])
assert.equal(explicitNone.ok, false) // formal 仍未确认，但 draft 已按明确无截止处理
assert.equal(explicitNone.clarifications.length, 1)
assert.ok(explicitNone.clarifications[0].question.includes('虚构目标一'))
const draftFactNone = norm(mkSnapshot(), {
  ...collision, task_proposals: [collision.task_proposals[0]],
}, [], mkContext(), { taskDeadlineConfirmations: [cf('draft', null)] })
assert.equal(draftFactNone.ok, true)
assert.equal(draftFactNone.input.task_facts.find((f) => f.task_ref.kind === 'draft').deadline_precision, 'none')
rows.push({ case: 'C2_explicit_null_means_none', passed: true })

writeFileSync(new URL('./results-after.json', import.meta.url), JSON.stringify(rows, null, 2) + '\n')
console.log(JSON.stringify(rows, null, 2))
console.log('ALL C1/C2 CORRECT-EXPECTATION CHECKS PASSED')