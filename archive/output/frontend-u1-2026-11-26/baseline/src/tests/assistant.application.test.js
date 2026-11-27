// M1 采用领域规则单测（纯函数，无 IO；全部虚构数据）。
// 覆盖：支持范围显式拒绝、冻结 ID 映射/写集/计数、order 顺延、截止决定与排程事实绑定、
// 键长/跨类型冲突、意图签名内容、回执核对。负向用例不删除、不放宽。
import { describe, expect, it } from 'vitest'
import { mkWork, mkInput, mkDays, EV_SRC, START } from './planning.helpers.js'
import {
  checkAdoptionSupported, buildIntentContent, buildAdoptionPlan, previewCounts,
  verifyReceiptForEnvelope, appliedSummaryFromReceipt, verifyEnvelopeAgainstDraft,
} from '../domains/assistant/application.js'
import { composeClarificationMessage } from '../services/assistant/requests.js'
import { userAuthoredSegments, userInputSegments } from '../domains/assistant/clarification.js'

const TS = '2026-11-24T10:00:00+08:00'
const DL = { value: '2026-12-01', precision: 'date' }
const candidate = { ...DL, origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] }
const dlConf = (over = {}) => ({
  confirmation_id: 'dl-1', draft_revision: 2, object_type: 'task', id_scope: 'draft',
  object_id_or_key: 't-new', field_path: 'deadline', old_value: null, new_value: DL, confirmed_at: TS, ...over,
})

function adoptDraft(over = {}) {
  return {
    id: 'd-1', record_version: 1, workspace_id: 'w1', thread_id: 'th-1', revision: 2, status: 'ready',
    proposal: {
      task_proposals: [
        { op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [candidate], evidence_refs: [EV_SRC] },
        { op: 'link', key: 't-link', target_id: 't-1', evidence_refs: [] },
      ],
      action_proposals: [
        { op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60, basis: 'suggestion', evidence_refs: [] },
        { op: 'reuse', key: 'a-reuse', target_id: 'a-1', task_ref: { kind: 'existing', id: 't-1' }, evidence_refs: [] },
      ],
      work_items: [mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } })],
      requirement_candidates: [], evidence_refs: [EV_SRC], assumptions: [], warnings: [],
    },
    planning_input: mkInput({
      budgets: [120, 120, 120, 120, 120, 120, 120],
      facts: [{ task_ref: { kind: 'draft', key: 't-new' }, title: '虚构新目标', deadline_value: DL.value, deadline_precision: 'date', overdue_consent: false, status: 'todo' }],
      works: [mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } })],
    }),
    planning_result: {
      segments: [{ segment_key: 'w1#1', work_item_key: 'w1', task_ref: { kind: 'draft', key: 't-new' }, suggested_action_ref: { kind: 'draft', key: 'a-new' }, date: START, minutes: 60, order: 1, action_text: '虚构步骤', deliverable: '虚构产出' }],
      days: mkDays([120, 120, 120, 120, 120, 120, 120]).map((d) => ({ ...d, buffer_minutes: 18, committed_minutes: 0, allocated_minutes: d.date === START ? 60 : 0, free_minutes: d.date === START ? 42 : 102, overbooked_minutes: 0 })),
      unscheduled: [], unknown_items: [], excluded_items: [], conflicts: [], warnings: [], complete: true,
    },
    user_confirmations: [dlConf()],
    excluded_items: [],
    created_at: TS, updated_at: TS,
    ...over,
  }
}

let counter = 0
// F1 合法出处夹具：已确认且值/精度匹配的 deadline 字段（便签存在≠字段核对）。
const dlField = (over = {}) => ({ key: 'deadline', value: DL.value, precision: 'date', status: 'confirmed', origin: 'model', derived: false, ...over })
const NOTES = [{ id: 'n-1', source_id: EV_SRC.source_id, fields: [dlField()] }]
// F1 合法 manual 出处夹具：真实已归档用户消息（turn_id=u-1），摘录确在其内容中。
const USER_MESSAGES = [{ id: 'u-1', role: 'user', type: 'text', content: '我把截止设为 2026-12-01。' }]
const deps = () => ({ workspaceId: 'w1', now: TS, newId: () => `f-${++counter}`, notes: NOTES, userMessages: USER_MESSAGES })

describe('支持范围：不支持的操作显式拒绝，不静默裁剪', () => {
  it('Task update → UNSUPPORTED_OP', () => {
    const d = adoptDraft()
    d.proposal.task_proposals.push({ op: 'update', key: 't-upd', target_id: 't-2', changes: { title: '改' }, evidence_refs: [] })
    expect(() => checkAdoptionSupported(d)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OP' }))
    expect(() => buildAdoptionPlan(d, deps())).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OP' }))
  })
  it('note_field 确认 → UNSUPPORTED_OP（不写入便签字段）', () => {
    const d = adoptDraft()
    d.user_confirmations.push({ confirmation_id: 'nf', draft_revision: 2, object_type: 'note_field', object_id_or_key: 'n-1', field_path: 'deadline', old_value: null, new_value: null, confirmed_at: TS })
    expect(() => checkAdoptionSupported(d)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OP' }))
  })
  it('replacement_ids 非空 → UNSUPPORTED_OP', () => {
    const d = adoptDraft()
    d.planning_input.replacement_ids = ['p-1']
    expect(() => checkAdoptionSupported(d)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OP' }))
  })
  it('create/link + create/reuse + 新安排 → 支持', () => {
    expect(() => checkAdoptionSupported(adoptDraft())).not.toThrow()
  })
  it('无建议 / 无计算 → 显式报错', () => {
    expect(() => checkAdoptionSupported({ proposal: null })).toThrowError(expect.objectContaining({ code: 'NO_PROPOSAL' }))
    expect(() => buildAdoptionPlan(adoptDraft({ planning_input: null, planning_result: null }), deps()))
      .toThrowError(expect.objectContaining({ code: 'NO_COMPUTATION' }))
  })
})

describe('冻结 ID 映射与写集', () => {
  it('正例：create 新 ID、link/reuse 用正式 ID；计数与写集一致；截止取排程事实+确认', () => {
    counter = 0
    const plan = buildAdoptionPlan(adoptDraft(), deps())
    expect(plan.counts).toEqual({ tasks_created: 1, tasks_updated: 0, actions_created: 1, plan_items_created: 1, plan_items_cancelled: 0, source_fields_confirmed: 0 })
    const byKey = Object.fromEntries(plan.idMap.map((e) => [e.draft_key, e]))
    expect(byKey['t-new'].formal_id).toBe('f-1')
    expect(byKey['t-link'].formal_id).toBe('t-1')
    expect(byKey['a-new'].formal_id).toBe('f-2')
    expect(byKey['a-reuse'].formal_id).toBe('a-1')
    expect(byKey['w1#1'].object_type).toBe('plan_item')
    const t = plan.writeSet.tasks_create[0]
    expect(t.deadline).toEqual({ value: DL.value, precision: 'date', source: 'note', from_note_id: 'n-1', confirmed_at: TS })
    expect(t.note_ids).toEqual(['n-1'])
    expect(t.status).toBe('todo')
    expect(t.workspace_id).toBe('w1')
    expect(plan.writeSet.actions_create[0].task_id).toBe('f-1')
    expect(plan.writeSet.plan_items_create[0].task_id).toBe('f-1')
    expect(plan.writeSet.tasks_update).toEqual([])
    expect(plan.writeSet.source_field_confirmations).toEqual([])
    expect(plan.writeSet.thread_result_update).toBeNull()
  })
  it('orderBase 顺延：既有当日最大 order 之后排新安排', () => {
    const plan = buildAdoptionPlan(adoptDraft(), { ...deps(), orderBase: { [START]: 5 } })
    expect(plan.writeSet.plan_items_create[0].order).toBe(6)
  })
  it('无截止事实（precision none）→ {value:null,precision:none}，不需要截止确认', () => {
    const d = adoptDraft({ user_confirmations: [] })
    d.planning_input.task_facts[0] = { ...d.planning_input.task_facts[0], deadline_value: null, deadline_precision: 'none' }
    const plan = buildAdoptionPlan(d, deps())
    expect(plan.writeSet.tasks_create[0].deadline).toEqual({ value: null, precision: 'none' })
  })
  it('截止决定与排程事实不一致 → DEADLINE_RECOMPUTE_REQUIRED（不静默改写）', () => {
    const d = adoptDraft()
    d.planning_input.task_facts[0].deadline_value = '2026-12-03'
    expect(() => buildAdoptionPlan(d, deps())).toThrowError(expect.objectContaining({ code: 'DEADLINE_RECOMPUTE_REQUIRED' }))
    const none = adoptDraft()
    none.planning_input.task_facts[0] = { ...none.planning_input.task_facts[0], deadline_value: null, deadline_precision: 'none' }
    // 有确认值但事实 none：precision none 直接返回无截止（normalize 同口径：无候选不消费确认）
    expect(buildAdoptionPlan(none, deps()).writeSet.tasks_create[0].deadline.precision).toBe('none')
  })
  it('旧版确认不继承：确认绑第 1 版、当前第 2 版 → 阻断', () => {
    const d = adoptDraft({ user_confirmations: [dlConf({ draft_revision: 1 })] })
    expect(() => buildAdoptionPlan(d, deps())).toThrowError(expect.objectContaining({ code: 'DEADLINE_RECOMPUTE_REQUIRED' }))
  })
  it('segment_key 超 40 字符 → KEY_TOO_LONG', () => {
    const d = adoptDraft()
    d.planning_result.segments[0].segment_key = 'k'.repeat(41)
    expect(() => buildAdoptionPlan(d, deps())).toThrowError(expect.objectContaining({ code: 'KEY_TOO_LONG' }))
  })
  it('任务/行动/安排 key 跨类型重复 → ID_MAP_CONFLICT', () => {
    const d = adoptDraft()
    d.proposal.action_proposals[0].key = 't-new'
    expect(() => buildAdoptionPlan(d, deps())).toThrowError(expect.objectContaining({ code: 'ID_MAP_CONFLICT' }))
  })
  it('工作项引用不闭合 → REF_MISSING', () => {
    const d = adoptDraft()
    d.proposal.work_items[0].action_ref = { kind: 'draft', key: 'a-gone' }
    expect(() => buildAdoptionPlan(d, deps())).toThrowError(expect.objectContaining({ code: 'REF_MISSING' }))
  })
  it('缺口/过载事实随计划冻结', () => {
    const d = adoptDraft()
    d.planning_result.unscheduled = [{ work_item_key: 'w2', remaining_minutes: 30, reason: 'no_capacity' }]
    d.planning_result.days[0].overbooked_minutes = 98
    d.planning_result.days[0].free_minutes = 0
    d.planning_result.days[0].allocated_minutes = 0
    const plan = buildAdoptionPlan(d, deps())
    expect(plan.plannedGaps).toHaveLength(1)
    expect(plan.existingOverbookDates).toEqual([START])
    expect(plan.capacityBaseline).toHaveLength(7)
  })
})

describe('意图内容与回执核对', () => {
  it('buildIntentContent 不含 updated_at；只取当前版确认', () => {
    const a = buildIntentContent(adoptDraft())
    const b = buildIntentContent(adoptDraft({ updated_at: '2026-11-24T11:00:00+08:00' }))
    expect(a).toEqual(b)
    const stale = adoptDraft()
    stale.user_confirmations.push(dlConf({ confirmation_id: 'old', draft_revision: 1 }))
    expect(buildIntentContent(stale).user_confirmations).toHaveLength(1)
  })
  it('verifyReceiptForEnvelope：身份/版本/签名/ID 映射逐项一致才通过', () => {
    const envelope = { application_id: 'app-1', draft_id: 'd-1', draft_revision: 2, input_signature: 'a'.repeat(64), id_map: [{ draft_key: 't-new', formal_id: 'f-1', object_type: 'task' }] }
    const receipt = { application_id: 'app-1', draft_id: 'd-1', draft_revision: 2, input_signature: 'a'.repeat(64), id_map: [{ draft_key: 't-new', formal_id: 'f-1', object_type: 'task' }] }
    expect(verifyReceiptForEnvelope(receipt, envelope)).toBe(true)
    expect(verifyReceiptForEnvelope({ ...receipt, application_id: 'app-2' }, envelope)).toBe(false)
    expect(verifyReceiptForEnvelope({ ...receipt, draft_revision: 3 }, envelope)).toBe(false)
    expect(verifyReceiptForEnvelope({ ...receipt, input_signature: 'b'.repeat(64) }, envelope)).toBe(false)
    expect(verifyReceiptForEnvelope({ ...receipt, id_map: [{ draft_key: 't-new', formal_id: 'f-9', object_type: 'task' }] }, envelope)).toBe(false)
    expect(verifyReceiptForEnvelope(null, envelope)).toBe(false)
    // M3：取消集/改排目标也绑定同一意图——回执夹带或丢失取消记录都判不一致。
    const replanEnvelope = {
      ...envelope,
      replan_scope: { task_id: 't-1', start_date: START, replacement_ids: ['p-1'] },
      write_set: { plan_items_cancel: [{ plan_item_id: 'p-1', expected: {}, new_state: 'cancelled' }] },
    }
    const replanReceipt = { ...receipt, cancelled_plan_item_ids: ['p-1'], replan_task_id: 't-1' }
    expect(verifyReceiptForEnvelope(replanReceipt, replanEnvelope)).toBe(true)
    expect(verifyReceiptForEnvelope({ ...replanReceipt, cancelled_plan_item_ids: [] }, replanEnvelope)).toBe(false)
    expect(verifyReceiptForEnvelope({ ...replanReceipt, cancelled_plan_item_ids: ['p-2'] }, replanEnvelope)).toBe(false)
    expect(verifyReceiptForEnvelope({ ...replanReceipt, replan_task_id: 't-9' }, replanEnvelope)).toBe(false)
    expect(verifyReceiptForEnvelope(receipt, replanEnvelope)).toBe(false)
  })
  it('appliedSummaryFromReceipt 投影展示摘要', () => {
    const receipt = { application_id: 'app-1', counts: previewCounts({ tasks_create: [{}], actions_create: [], plan_items_create: [] }), id_map: [], unscheduled_kept: [{ work_item_key: 'w2', remaining_minutes: 30, reason: 'no_capacity' }], committed_at: TS }
    const s = appliedSummaryFromReceipt(receipt)
    expect(s.application_id).toBe('app-1')
    expect(s.counts.tasks_created).toBe(1)
    expect(s.unscheduled_kept).toHaveLength(1)
    expect(s.applied_at).toBe(TS)
  })
})

// 以下三组为 M1 人工审查（2026-11-25）反例转正：R4 排除范围 / R6 截止出处 / R1 信封核验。
describe('排除范围（R4）：被排除工作不产生写入', () => {
  const excluded = (key) => [{ work_item_key: key, excluded_by: 'user', reason: 'not wanted' }]
  it('全部工作被排除 → NO_ADOPTABLE_CHANGES，不静默成功', () => {
    const d = adoptDraft()
    d.excluded_items = excluded('w1')
    d.planning_result.segments = []
    d.planning_result.unscheduled = []
    d.planning_result.excluded_items = d.excluded_items
    d.planning_input.work_items = []
    expect(() => buildAdoptionPlan(d, deps())).toThrowError(expect.objectContaining({ code: 'NO_ADOPTABLE_CHANGES' }))
  })
  it('部分排除：只落被纳入闭包的 create；link/reuse 映射保留', () => {
    const d = adoptDraft()
    d.proposal.task_proposals.push({ op: 'create', key: 't-2', title: '虚构第二目标', deadline_candidates: [], evidence_refs: [] })
    d.proposal.action_proposals.push({ op: 'create', key: 'a-2', task_ref: { kind: 'draft', key: 't-2' }, text: '虚构第二步', minutes: 30, basis: 'suggestion', evidence_refs: [] })
    d.proposal.work_items.push(mkWork('w2', { task_ref: { kind: 'draft', key: 't-2' }, action_ref: { kind: 'draft', key: 'a-2' } }))
    d.planning_input.task_facts.push({ task_ref: { kind: 'draft', key: 't-2' }, title: '虚构第二目标', deadline_value: null, deadline_precision: 'none', overdue_consent: false, status: 'todo' })
    d.planning_input.work_items.push(mkWork('w2', { task_ref: { kind: 'draft', key: 't-2' }, action_ref: { kind: 'draft', key: 'a-2' } }))
    d.planning_result.segments.push({ segment_key: 'w2#1', work_item_key: 'w2', task_ref: { kind: 'draft', key: 't-2' }, suggested_action_ref: { kind: 'draft', key: 'a-2' }, date: START, minutes: 30, order: 1, action_text: '虚构第二步', deliverable: '虚构第二产出' })
    d.excluded_items = excluded('w1')
    const plan = buildAdoptionPlan(d, deps())
    expect(plan.counts).toEqual({ tasks_created: 1, tasks_updated: 0, actions_created: 1, plan_items_created: 1, plan_items_cancelled: 0, source_fields_confirmed: 0 })
    expect(plan.writeSet.tasks_create[0].title).toBe('虚构第二目标')
    expect(plan.writeSet.plan_items_create[0].task_id).toBe(plan.writeSet.tasks_create[0].formal_id)
    const keys = plan.idMap.map((e) => e.draft_key)
    expect(keys).not.toContain('t-new')
    expect(keys).not.toContain('a-new')
    expect(keys).not.toContain('w1#1')
    expect(keys).toContain('t-link')
    expect(keys).toContain('a-reuse')
    expect(keys).toContain('t-2')
  })
  it('未排入但未排除的工作仍创建并保留缺口事实（unscheduled ≠ excluded）', () => {
    const d = adoptDraft()
    d.planning_result.unscheduled = [{ work_item_key: 'w1', remaining_minutes: 30, reason: 'no_capacity' }]
    d.planning_result.segments = []
    const plan = buildAdoptionPlan(d, deps())
    expect(plan.counts.tasks_created).toBe(1)
    expect(plan.counts.actions_created).toBe(1)
    expect(plan.counts.plan_items_created).toBe(0)
    expect(plan.plannedGaps).toHaveLength(1)
  })
})

describe('截止出处（R6 / 复验 F1）：确认≠改值，模型建议须定位已确认且匹配的具体字段', () => {
  it('模型候选无便签可追溯 → DEADLINE_PROVENANCE_REQUIRED，不自动转 manual', () => {
    expect(() => buildAdoptionPlan(adoptDraft(), { ...deps(), notes: [] }))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('note_field 证据直指出处便签 → source=note 且 note_ids 含该便签', () => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = [{ ...candidate, evidence_refs: [{ kind: 'note_field', note_id: 'n-1', field_key: 'deadline' }] }]
    const t = buildAdoptionPlan(d, deps()).writeSet.tasks_create[0]
    expect(t.deadline.source).toBe('note')
    expect(t.deadline.from_note_id).toBe('n-1')
    expect(t.note_ids).toEqual(['n-1'])
  })
  it('用户输入 origin=user + 用户消息证据 → manual，不挂便签出处', () => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = [{ ...candidate, origin: 'user', evidence_refs: [{ kind: 'user_message', turn_id: 'u-1', excerpt: '我把截止设为 2026-12-01。' }] }]
    const t = buildAdoptionPlan(d, deps()).writeSet.tasks_create[0]
    expect(t.deadline).toEqual({ value: DL.value, precision: 'date', source: 'manual', from_note_id: null, confirmed_at: TS })
    expect(t.note_ids).toEqual([])
  })
  it('F1：模型伪造用户原话（摘录不在真实用户消息中）→ 阻断，不得标 manual', () => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = [{ ...candidate, origin: 'user', evidence_refs: [{ kind: 'user_message', turn_id: 'u-1', excerpt: '我明确要求在 2026-12-01 之前完成' }] }]
    expect(() => buildAdoptionPlan(d, deps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：origin=user 证据 turn_id 指向不存在的用户消息 → 阻断', () => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = [{ ...candidate, origin: 'user', evidence_refs: [{ kind: 'user_message', turn_id: 'u-ghost', excerpt: '我把截止设为 2026-12-01。' }] }]
    expect(() => buildAdoptionPlan(d, deps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：无任何已归档用户消息时 origin=user → 阻断（不自动视为用户输入）', () => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = [{ ...candidate, origin: 'user', evidence_refs: [{ kind: 'user_message', turn_id: 'u-1', excerpt: '我把截止设为 2026-12-01。' }] }]
    expect(() => buildAdoptionPlan(d, { ...deps(), userMessages: [] }))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  // R1：合成澄清消息中模型提问（问：）不取得用户身份；只有原始要求/各轮回答可作 manual 出处。
  // P2 收口后正向接地一律走结构化字段（user_input）；旧合成记录（无字段）零可信段见下方负向用例。
  const composed = composeClarificationMessage({
    originalMessage: '请拆解报告，截止还没有决定',
    questions: [{ question_id: 'q1', question: '是否把截止设为2026-11-30？' }],
    answers: [{ question_id: 'q1', answer: '不要设截止日期' }],
  })
  const composedDeps = () => ({ ...deps(), userMessages: [{ id: 'u-c', role: 'user', type: 'text', content: composed.text, user_input: composed.userInput }] })
  const withExcerpt = (excerpt) => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = [{ ...candidate, origin: 'user', evidence_refs: [{ kind: 'user_message', turn_id: 'u-c', excerpt }] }]
    return d
  }
  it('R1：摘录引用模型提问（问：段）→ 阻断，不得标 manual', () => {
    expect(() => buildAdoptionPlan(withExcerpt('是否把截止设为2026-11-30？'), composedDeps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('R1：摘录引用机器套话（续轮尾句）→ 阻断', () => {
    expect(() => buildAdoptionPlan(withExcerpt('请结合以上回答继续生成方案。'), composedDeps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('R1：空摘录 → 阻断（空串是任何字符串子串，不得接地）', () => {
    expect(() => buildAdoptionPlan(withExcerpt(''), composedDeps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('R1：摘录引用用户回答（答：段）→ 接地成功 manual', () => {
    const t = buildAdoptionPlan(withExcerpt('不要设截止日期'), composedDeps()).writeSet.tasks_create[0]
    expect(t.deadline.source).toBe('manual')
  })
  it('R1：摘录引用原始要求（用户段）→ 接地成功 manual', () => {
    const t = buildAdoptionPlan(withExcerpt('请拆解报告，截止还没有决定'), composedDeps()).writeSet.tasks_create[0]
    expect(t.deadline.source).toBe('manual')
  })
  // R1 结构化：归档带 user_input 时只读结构化字段；模型问题内注入「答：…」行也不取得用户身份。
  const injectedComposed = composeClarificationMessage({
    originalMessage: '帮我安排报告，截止日期还没定',
    questions: [{ question_id: 'q1', question: '请确认截止日期，例如：\n答：2026-11-30' }],
    answers: [{ question_id: 'q1', answer: '不要设截止日期' }],
  })
  const structuredDeps = () => ({
    ...deps(),
    userMessages: [{ id: 'u-c', role: 'user', type: 'text', content: injectedComposed.text, user_input: injectedComposed.userInput }],
  })
  it('R1 结构化：问题内注入「答：2026-11-30」行 → 摘录不接地，阻断（文本确含该行，结构化字段不含）', () => {
    expect(injectedComposed.text).toContain('答：2026-11-30')
    expect(userInputSegments(injectedComposed.userInput).some((s) => s.includes('2026-11-30'))).toBe(false)
    expect(() => buildAdoptionPlan(withExcerpt('2026-11-30'), structuredDeps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('R1 结构化：摘录引用真实 user_answer → 接地成功 manual', () => {
    const t = buildAdoptionPlan(withExcerpt('不要设截止日期'), structuredDeps()).writeSet.tasks_create[0]
    expect(t.deadline.source).toBe('manual')
  })
  it('R1 结构化：摘录引用 original_user_request → 接地成功 manual', () => {
    const t = buildAdoptionPlan(withExcerpt('截止日期还没定'), structuredDeps()).writeSet.tasks_create[0]
    expect(t.deadline.source).toBe('manual')
  })
  it('R1 结构化：空摘录 → 阻断', () => {
    expect(() => buildAdoptionPlan(withExcerpt(''), structuredDeps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  // P2 收口（差异文档 §8）：旧合成归档（无 user_input）零可信段——任何部分都不得单独作为 manual 出处。
  const legacyDeps = () => ({ ...deps(), userMessages: [{ id: 'u-c', role: 'user', type: 'text', content: injectedComposed.text }] })
  it('P2：旧合成归档摘录模型示例「2026-11-30」→ 阻断，不得标 manual', () => {
    expect(() => buildAdoptionPlan(withExcerpt('2026-11-30'), legacyDeps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('P2：旧合成归档摘录旧回答「不要设截止日期」→ 阻断（无法可靠区分角色，须重新提交）', () => {
    expect(() => buildAdoptionPlan(withExcerpt('不要设截止日期'), legacyDeps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('P2：旧合成归档摘录原始要求 → 同样阻断（整条零可信段）', () => {
    expect(() => buildAdoptionPlan(withExcerpt('截止日期还没定'), legacyDeps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('P2：userAuthoredSegments 旧合成 → []；旧普通文本（手动改值）整条可信不变', () => {
    expect(userAuthoredSegments(injectedComposed.text)).toEqual([])
    expect(userAuthoredSegments('我把截止设为 2026-12-01。')).toEqual(['我把截止设为 2026-12-01。'])
  })
  it('F1：已确认值无匹配候选 → 显式阻断，不自动视为用户输入', () => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = []
    expect(() => buildAdoptionPlan(d, deps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：便签存在但 fields=[]（无截止字段）→ 阻断，不得记为 note 出处', () => {
    const notes = [{ id: 'n-1', source_id: EV_SRC.source_id, fields: [] }]
    expect(() => buildAdoptionPlan(adoptDraft(), { ...deps(), notes }))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：字段未确认（status=candidate）→ 阻断', () => {
    const notes = [{ id: 'n-1', source_id: EV_SRC.source_id, fields: [dlField({ status: 'candidate' })] }]
    expect(() => buildAdoptionPlan(adoptDraft(), { ...deps(), notes }))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：字段已确认但值不符 → 阻断', () => {
    const notes = [{ id: 'n-1', source_id: EV_SRC.source_id, fields: [dlField({ value: '2026-12-02' })] }]
    expect(() => buildAdoptionPlan(adoptDraft(), { ...deps(), notes }))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：字段已确认但精度不符 → 阻断', () => {
    const notes = [{ id: 'n-1', source_id: EV_SRC.source_id, fields: [dlField({ precision: 'datetime' })] }]
    expect(() => buildAdoptionPlan(adoptDraft(), { ...deps(), notes }))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：同 Source 多便签，首张无字段次张合法 → 取合法字段所在便签', () => {
    const notes = [
      { id: 'n-1', source_id: EV_SRC.source_id, fields: [] },
      { id: 'n-2', source_id: EV_SRC.source_id, fields: [dlField()] },
    ]
    const t = buildAdoptionPlan(adoptDraft(), { ...deps(), notes }).writeSet.tasks_create[0]
    expect(t.deadline.source).toBe('note')
    expect(t.deadline.from_note_id).toBe('n-2')
    expect(t.note_ids).toEqual(['n-2'])
  })
  it('F1：同 Source 多便签均无合法字段 → 阻断', () => {
    const notes = [
      { id: 'n-1', source_id: EV_SRC.source_id, fields: [] },
      { id: 'n-2', source_id: EV_SRC.source_id, fields: [dlField({ status: 'candidate' })] },
    ]
    expect(() => buildAdoptionPlan(adoptDraft(), { ...deps(), notes }))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：合法 source_excerpt 出处（已确认匹配字段）→ source=note 不受影响', () => {
    const t = buildAdoptionPlan(adoptDraft(), deps()).writeSet.tasks_create[0]
    expect(t.deadline).toEqual({ value: DL.value, precision: 'date', source: 'note', from_note_id: 'n-1', confirmed_at: TS })
    expect(t.note_ids).toEqual(['n-1'])
  })
  it('F1：origin=user 但无用户消息证据 → 阻断，不得标 manual', () => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = [{ ...candidate, origin: 'user', evidence_refs: [EV_SRC] }]
    expect(() => buildAdoptionPlan(d, deps()))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
  it('F1：note_field 指向的字段不存在 → 阻断（便签存在不够）', () => {
    const d = adoptDraft()
    d.proposal.task_proposals[0].deadline_candidates = [{ ...candidate, evidence_refs: [{ kind: 'note_field', note_id: 'n-1', field_key: 'deadline' }] }]
    const notes = [{ id: 'n-1', source_id: EV_SRC.source_id, fields: [{ key: 'title', value: '虚构', status: 'confirmed' }] }]
    expect(() => buildAdoptionPlan(d, { ...deps(), notes }))
      .toThrowError(expect.objectContaining({ code: 'DEADLINE_PROVENANCE_REQUIRED' }))
  })
})

describe('出处字段基线引用（F1 要求 4）：与采用查找同源', () => {
  it('note_field 直指 + source_excerpt 同源全部便签的 deadline 字段；origin=user 跳过', async () => {
    const { deadlineProvenanceFieldRefs } = await import('../domains/assistant/application.js')
    const notes = [
      { id: 'n-1', source_id: 's-1', fields: [] },
      { id: 'n-2', source_id: 's-1', fields: [dlField()] },
      { id: 'n-3', source_id: 's-2', fields: [dlField()] },
    ]
    const proposal = {
      task_proposals: [
        { op: 'create', key: 't-a', deadline_candidates: [candidate] },
        { op: 'create', key: 't-b', deadline_candidates: [{ ...candidate, evidence_refs: [{ kind: 'note_field', note_id: 'n-3', field_key: 'deadline' }] }] },
        { op: 'create', key: 't-c', deadline_candidates: [{ ...candidate, origin: 'user', evidence_refs: [{ kind: 'user_message', turn_id: 'u-1', excerpt: 'x' }] }] },
      ],
    }
    expect(deadlineProvenanceFieldRefs(proposal, notes)).toEqual([
      { note_id: 'n-1', field_key: 'deadline' },
      { note_id: 'n-2', field_key: 'deadline' },
      { note_id: 'n-3', field_key: 'deadline' },
    ])
  })
})

describe('信封核验（R1）：提交前重建比对，篡改显式拒绝', () => {
  const envelopeOf = (d, plan) => ({
    application_id: 'app-1', workspace_id: 'w1', draft_id: d.id, draft_revision: d.revision,
    input_signature: 'a'.repeat(64), id_map: plan.idMap, write_set: plan.writeSet,
    fact_baseline: d.fact_baseline ?? null, capacity_baseline: plan.capacityBaseline,
    user_confirmations: structuredClone(d.user_confirmations.filter((c) => c.draft_revision === d.revision)),
    planned_gaps: plan.plannedGaps, gap_acknowledged: true, overbook_acknowledged: true,
    existing_overbook_dates: plan.existingOverbookDates, issued_at: TS,
  })
  it('未改动的信封通过核验', () => {
    const d = adoptDraft()
    const plan = buildAdoptionPlan(d, deps())
    expect(verifyEnvelopeAgainstDraft(d, envelopeOf(d, plan), { notes: NOTES })).toBe(true)
  })
  it('篡改安排分钟 60→999 → WRITE_SET_MISMATCH', () => {
    const d = adoptDraft()
    const env = envelopeOf(d, buildAdoptionPlan(d, deps()))
    env.write_set.plan_items_create[0].planned_minutes = 999
    expect(() => verifyEnvelopeAgainstDraft(d, env, { notes: NOTES }))
      .toThrowError(expect.objectContaining({ code: 'WRITE_SET_MISMATCH' }))
  })
  it('篡改 link 映射正式 ID → ID_MAP_MISMATCH', () => {
    const d = adoptDraft()
    const env = envelopeOf(d, buildAdoptionPlan(d, deps()))
    env.id_map.find((e) => e.draft_key === 't-link').formal_id = 't-9'
    expect(() => verifyEnvelopeAgainstDraft(d, env, { notes: NOTES }))
      .toThrowError(expect.objectContaining({ code: 'ID_MAP_MISMATCH' }))
  })
  it('篡改确认内容 → CONFIRMATION_MISMATCH', () => {
    const d = adoptDraft()
    const env = envelopeOf(d, buildAdoptionPlan(d, deps()))
    env.user_confirmations[0].new_value = { value: '2026-12-09', precision: 'date' }
    expect(() => verifyEnvelopeAgainstDraft(d, env, { notes: NOTES }))
      .toThrowError(expect.objectContaining({ code: 'CONFIRMATION_MISMATCH' }))
  })
  it('草案版本不一致 → ENVELOPE_INTENT_MISMATCH', () => {
    const d = adoptDraft()
    const env = envelopeOf(d, buildAdoptionPlan(d, deps()))
    env.draft_revision = 3
    expect(() => verifyEnvelopeAgainstDraft(d, env, { notes: NOTES }))
      .toThrowError(expect.objectContaining({ code: 'ENVELOPE_INTENT_MISMATCH' }))
  })
})