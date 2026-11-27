// M1 采用领域规则（纯函数，无 IO）：支持范围判定、意图内容、冻结 ID 映射/写集/预览计数、回执核对。
// 依据：实施方案 §9.5 + devlog/coordination/2026-11-25-M1采用类型契约差异.md。
// M1 支持 Task create/link、Action create/reuse、新 PlanItem；Task update 与 Note 字段确认写入
// 显式拒绝（UNSUPPORTED_OP），不静默裁剪。M3 增加 replan 模式：受限取消写集只覆盖用户选择的
// 替换集（预期内容全等 + 仅 planned→cancelled）；create 模式永久拒绝非空替换集/取消写集。
// ID/时间由调用层注入；同输入必得同输出。非法输入直接 throw（带 code），不归为「无容量」。

import { refToken } from '../planning/protocol'
import { confirmTaskDeadline } from '../planning/normalize'
import { canonicalJson } from './draft'
import { userAuthoredSegments, userInputSegments } from './clarification'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

// IdMapEntry.draft_key 契约上限 40；segment_key = work_item_key + '#' + 序号 可能超限，显式拒绝。
const MAX_DRAFT_KEY = 40

export function checkAdoptionSupported(draft) {
  const proposal = draft.proposal
  if (!proposal) fail('NO_PROPOSAL', '缺少建议内容，无法采用')
  const updates = (proposal.task_proposals ?? []).filter((t) => t.op === 'update')
  if (updates.length > 0) {
    fail('UNSUPPORTED_OP', `初版采用不支持修改既有任务（${updates.map((t) => t.target_id).join('、')}）；请改为新建任务或放弃该修改`)
  }
  const noteConfs = (draft.user_confirmations ?? []).filter((c) => c.object_type === 'note_field')
  if (noteConfs.length > 0) {
    fail('UNSUPPORTED_OP', '初版采用不支持把确认写入便签字段；请在便签页手动核对')
  }
  if (draft.mode === 'replan') {
    // M3：替换只走受限取消写集；范围/进展/基线缺一不可，且取消集只覆盖用户选择。
    if (!draft.replan_scope || !draft.progress_input || !draft.replacement_baseline) {
      fail('REPLAN_INPUT_MISSING', '改排采用缺少范围/进展清单/替换基线；请重新准备')
    }
    const ids = draft.replan_scope.replacement_ids ?? []
    const baselineIds = new Set(draft.replacement_baseline.items.map((i) => i.plan_item_id))
    if (ids.length === 0 || ids.some((id) => !baselineIds.has(id)) || baselineIds.size !== ids.length) {
      fail('REPLAN_SCOPE_MISMATCH', '替换基线必须与用户选择的替换集完全相等')
    }
    return
  }
  if ((draft.planning_input?.replacement_ids ?? []).length > 0) {
    fail('UNSUPPORTED_OP', '新建采用不支持替换既有安排；请走任务详情的「调整后续安排」')
  }
  if (draft.replan_scope || draft.progress_input || draft.replacement_baseline) {
    fail('UNSUPPORTED_OP', '新建采用不得携带改排范围/进展/替换基线')
  }
}

// 意图内容：input_signature 的哈希原文。覆盖草案身份/版本与全部决定输入，
// 不含 updated_at 等非决定字段；同一意图（同草案同版同内容）必得同一签名。
export function buildIntentContent(draft) {
  return {
    draft_id: draft.id,
    draft_revision: draft.revision,
    mode: draft.mode ?? 'create',
    proposal: draft.proposal ?? null,
    planning_input: draft.planning_input ?? null,
    planning_result: draft.planning_result ?? null,
    user_confirmations: (draft.user_confirmations ?? []).filter((c) => c.draft_revision === draft.revision),
    excluded_items: draft.excluded_items ?? [],
    replan_scope: draft.replan_scope ?? null,
    progress_input: draft.progress_input ?? null,
    replacement_baseline: draft.replacement_baseline ?? null,
  }
}

// 便签字段有效精度（与 note.js taskFromNote 同口径）：显式 precision 优先，缺省按值形状推断。
const fieldPrecision = (f) => f.precision || (String(f.value).includes('T') ? 'datetime' : 'date')
const confirmedMatchingField = (note, fieldKey, value, precision) => {
  const f = note && (note.fields ?? []).find((x) => x.key === fieldKey)
  return f && f.status === 'confirmed' && f.value === value && fieldPrecision(f) === precision ? f : null
}

function deadlineForCreate(tp, draft, fact, notes = [], userMessages = []) {
  const precision = fact?.deadline_precision ?? 'none'
  if (precision === 'none') return { value: null, precision: 'none' }
  const confs = (draft.user_confirmations ?? []).filter(
    (c) => c.object_type === 'task' && c.field_path === 'deadline' && c.draft_revision === draft.revision,
  )
  const decision = confirmTaskDeadline(confs, draft.revision, tp.key, 'draft', null, `task ${tp.key}`)
  if (decision.state !== 'confirmed' || decision.value !== fact.deadline_value || decision.precision !== precision) {
    fail('DEADLINE_RECOMPUTE_REQUIRED', `任务「${tp.title}」的截止决定与排程事实不一致，须重新确认并重排`)
  }
  const matching = confs.filter((c) => c.object_id_or_key === tp.key && c.id_scope === 'draft')
  const confirmedAt = matching.reduce((m, c) => (c.confirmed_at > m ? c.confirmed_at : m), matching[0].confirmed_at)
  const value = fact.deadline_value
  // 出处语义（M1 审查 R6 / 复验 F1）：确认≠改值。manual 必须有用户输入证据（origin=user 候选 +
  // 用户消息引用）；模型候选必须定位到「已确认且值/精度匹配」的具体便签字段，便签存在不等于字段核对。
  // 无匹配候选不自动视为用户输入；无合法字段不自动转 manual——一律显式阻断走核对路径。
  const candidate = (tp.deadline_candidates ?? []).find((c) => c.value === value && (c.precision ?? 'none') === precision)
  if (!candidate) {
    fail('DEADLINE_PROVENANCE_REQUIRED', `任务「${tp.title}」的截止决定没有匹配的建议候选出处；请重新核对截止或重排`)
  }
  if ((candidate.origin ?? 'model') === 'user') {
    // F1/R1/P2：manual 出处必须能定位到「真实用户输入原话」——turn_id 指向已归档用户消息，
    // 且摘录落在该消息的真实用户输入内。带 user_input 只读结构化字段；旧合成澄清记录零可信段
    // （模型示例不取得用户身份，须重新提交回答）；旧普通消息（首轮原话/手动改值）整条可信。空摘录一律不接地。
    const grounded = (candidate.evidence_refs ?? []).some((ev) => {
      if (ev.kind !== 'user_message') return false
      if (typeof ev.excerpt !== 'string' || !ev.excerpt.trim()) return false
      const m = userMessages.find((x) => x.id === ev.turn_id)
      if (!m || typeof m.content !== 'string') return false
      const segments = m.user_input ? userInputSegments(m.user_input) : userAuthoredSegments(m.content)
      return segments.some((seg) => seg.includes(ev.excerpt))
    })
    if (!grounded) {
      fail('DEADLINE_PROVENANCE_REQUIRED', `任务「${tp.title}」的用户设定截止缺少可核对的用户消息原话；请在对话中重新提交明确截止（旧澄清记录仅供展示）后重排`)
    }
    return { value, precision, source: 'manual', from_note_id: null, confirmed_at: confirmedAt }
  }
  let noteId = null
  for (const ev of candidate.evidence_refs ?? []) {
    if (ev.kind === 'note_field') {
      const n = notes.find((x) => x.id === ev.note_id)
      if (confirmedMatchingField(n, ev.field_key, value, precision)) { noteId = n.id; break }
    }
    if (ev.kind === 'source_excerpt') {
      // 同 Source 可能有多张便签：逐张核对 deadline 字段，不能取第一张便签就放行。
      for (const n of notes.filter((x) => x.source_id === ev.source_id)) {
        if (confirmedMatchingField(n, 'deadline', value, precision)) { noteId = n.id; break }
      }
      if (noteId) break
    }
  }
  if (!noteId) {
    fail('DEADLINE_PROVENANCE_REQUIRED', `任务「${tp.title}」的模型建议截止没有已确认且匹配的便签字段出处；请在便签页核对并确认截止字段后重排`)
  }
  return { value, precision, source: 'note', from_note_id: noteId, confirmed_at: confirmedAt }
}

// F1 要求 4：候选截止可能引用的便签字段（note_field 直指 + source_excerpt 同源便签的 deadline 字段），
// 供 captureFactBaseline 冻结出处基线；采用时 deadlineForCreate 再做已确认+值/精度匹配核对。
// 与 deadlineForCreate 的出处查找同一来源，保证「选定的出处字段」必在基线覆盖内。
export function deadlineProvenanceFieldRefs(proposal, notes = []) {
  const refs = new Map()
  const add = (noteId, fieldKey) => refs.set(`${noteId}\u0000${fieldKey}`, { note_id: noteId, field_key: fieldKey })
  for (const tp of proposal?.task_proposals ?? []) {
    for (const c of tp.deadline_candidates ?? []) {
      if ((c.origin ?? 'model') === 'user') continue
      for (const ev of c.evidence_refs ?? []) {
        if (ev.kind === 'note_field') add(ev.note_id, ev.field_key)
        if (ev.kind === 'source_excerpt') {
          for (const n of notes.filter((x) => x.source_id === ev.source_id)) add(n.id, 'deadline')
        }
      }
    }
  }
  return [...refs.values()]
}

/**
 * 冻结采用计划：ID 映射 + 完整写集 + 预览计数 + 缺口/过载事实。
 * draft 须已通过就绪推导（调用层负责）；这里再做引用闭合与范围核对，任何缺口显式报错。
 * newId() 每次调用产生新正式 ID；同一意图的重试必须复用已冻结信封，不得重新调用本函数。
 * orderBase：{ date: 该日既有安排最大 order }，新安排 order 在其后顺延，不与既有冲突。
 * fixedIds（核验用）：以已冻结 id_map 提供 create 的正式 ID，代替 newId()，保证同输入重建同写集。
 * 排除项（M1 审查 R4）：写集只覆盖被纳入工作项的引用闭包；仅被排除项引用的 create 不落库。
 */
export function buildAdoptionPlan(draft, { workspaceId, now, newId, orderBase = {}, notes = [], userMessages = [], fixedIds = null }) {
  checkAdoptionSupported(draft)
  const proposal = draft.proposal
  const input = draft.planning_input
  const result = draft.planning_result
  if (!input || !result) fail('NO_COMPUTATION', '缺少同版排程输入/结果，无法采用')

  const excludedKeys = new Set([
    ...(draft.excluded_items ?? []).map((e) => e.work_item_key),
    ...(result.excluded_items ?? []).map((e) => e.work_item_key),
  ])
  const includedWork = (proposal.work_items ?? []).filter((w) => !excludedKeys.has(w.key))
  const includedSegments = (result.segments ?? []).filter((s) => !excludedKeys.has(s.work_item_key))
  const refTaskKeys = new Set()
  const refActionKeys = new Set()
  for (const w of includedWork) {
    if (w.task_ref?.kind === 'draft') refTaskKeys.add(w.task_ref.key)
    if (w.action_ref?.kind === 'draft') refActionKeys.add(w.action_ref.key)
  }
  for (const ap of proposal.action_proposals ?? []) {
    if (ap.op === 'create' && refActionKeys.has(ap.key) && ap.task_ref?.kind === 'draft') refTaskKeys.add(ap.task_ref.key)
  }

  const idMap = []
  // 跨类型 key 唯一性先于裁剪校验：被排除的 create 也不得与其它 key 冲突。
  const seenKeys = new Set()
  for (const key of [
    ...(proposal.task_proposals ?? []).map((t) => t.key),
    ...(proposal.action_proposals ?? []).map((a) => a.key),
    ...includedSegments.map((s) => s.segment_key),
  ]) {
    if (seenKeys.has(key)) {
      fail('ID_MAP_CONFLICT', `草案 key「${key}」在任务/行动/安排间重复，无法建立唯一采用映射；请修改 key 后重排`)
    }
    seenKeys.add(key)
  }
  const pushEntry = (draftKey, formalId, objectType) => {
    if (draftKey.length > MAX_DRAFT_KEY) {
      fail('KEY_TOO_LONG', `采用映射键「${draftKey}」超过 ${MAX_DRAFT_KEY} 字符上限；请缩短工作项 key 后重排`)
    }
    if (idMap.some((e) => e.draft_key === draftKey)) {
      fail('ID_MAP_CONFLICT', `草案 key「${draftKey}」在任务/行动/安排间重复，无法建立唯一采用映射；请修改 key 后重排`)
    }
    idMap.push({ draft_key: draftKey, formal_id: formalId, object_type: objectType })
  }
  const createId = (key, objectType) => {
    if (!fixedIds) return newId()
    const e = fixedIds.find((x) => x.draft_key === key && x.object_type === objectType)
    if (!e) fail('ID_MAP_MISSING', `冻结映射缺少 ${objectType}「${key}」，无法核验写集`)
    return e.formal_id
  }
  // link/reuse 不产生写入，但保留映射供引用解析与回显；create 仅对被纳入引用闭包者建映射。
  for (const tp of proposal.task_proposals ?? []) {
    if (tp.op === 'create' && !refTaskKeys.has(tp.key)) continue
    pushEntry(tp.key, tp.op === 'create' ? createId(tp.key, 'task') : tp.target_id, 'task')
  }
  for (const ap of proposal.action_proposals ?? []) {
    if (ap.op === 'create' && !refActionKeys.has(ap.key)) continue
    pushEntry(ap.key, ap.op === 'create' ? createId(ap.key, 'action') : ap.target_id, 'action')
  }
  for (const seg of includedSegments) {
    pushEntry(seg.segment_key, createId(seg.segment_key, 'plan_item'), 'plan_item')
  }
  const formalOf = (key, objectType) => {
    const e = idMap.find((x) => x.draft_key === key && x.object_type === objectType)
    if (!e) fail('REF_MISSING', `采用映射缺少 ${objectType}「${key}」；草案引用不闭合`)
    return e.formal_id
  }
  const resolveTaskId = (ref) => (ref.kind === 'existing' ? ref.id : formalOf(ref.key, 'task'))
  for (const w of includedWork) {
    resolveTaskId(w.task_ref)
    if (w.action_ref.kind === 'draft') formalOf(w.action_ref.key, 'action')
  }

  const factByToken = new Map((input.task_facts ?? []).map((f) => [refToken(f.task_ref), f]))
  const tasksCreate = (proposal.task_proposals ?? [])
    .filter((t) => t.op === 'create' && refTaskKeys.has(t.key))
    .map((tp) => {
      const fact = factByToken.get(refToken({ kind: 'draft', key: tp.key }))
      const deadline = deadlineForCreate(tp, draft, fact, notes, userMessages)
      return {
        formal_id: formalOf(tp.key, 'task'),
        workspace_id: workspaceId,
        title: tp.title,
        description: tp.description ?? '',
        completion_criteria: tp.completion_criteria ?? null,
        deadline,
        note_ids: deadline.source === 'note' && deadline.from_note_id ? [deadline.from_note_id] : [],
        matter_id: null,
        status: 'todo',
        created_at: now,
        updated_at: now,
      }
    })
  const actionsCreate = (proposal.action_proposals ?? [])
    .filter((a) => a.op === 'create' && refActionKeys.has(a.key))
    .map((ap) => ({
      formal_id: formalOf(ap.key, 'action'),
      workspace_id: workspaceId,
      task_id: resolveTaskId(ap.task_ref),
      text: ap.text,
      minutes: ap.minutes,
      basis: ap.basis ?? 'suggestion',
      done: false,
      created_at: now,
    }))
  const planItemsCreate = includedSegments.map((seg) => ({
    formal_id: formalOf(seg.segment_key, 'plan_item'),
    workspace_id: workspaceId,
    task_id: resolveTaskId(seg.task_ref),
    date: seg.date,
    planned_minutes: seg.minutes,
    action_text: seg.action_text,
    state: 'planned',
    actual_minutes: null,
    focus_session_id: null,
    order: (orderBase[seg.date] ?? 0) + seg.order,
    task_ref_state: 'active',
  }))
  const plannedGaps = result.unscheduled ?? []
  const existingOverbookDates = (result.days ?? []).filter((d) => d.overbooked_minutes > 0).map((d) => d.date)
  // M3：新安排为零不提供改排采用（避免把本功能变成整批清空）；提示修改输入或走既有单项取消。
  if (draft.mode === 'replan' && planItemsCreate.length === 0) {
    fail('NO_ADOPTABLE_CHANGES', '改排没有新增安排：请修改工作清单/预算，或使用既有单项取消操作')
  }
  // 无任何新对象且无缺口/过载事实可记录 → 没有需要采用的变更（排除项不产生写入，也不静默成功）。
  if (tasksCreate.length === 0 && actionsCreate.length === 0 && planItemsCreate.length === 0
    && plannedGaps.length === 0 && existingOverbookDates.length === 0) {
    fail('NO_ADOPTABLE_CHANGES', '没有需要采用的变更：工作均被排除或无新任务/行动/安排')
  }

  // 受限取消写集：只由冻结替换基线重建（预期内容全等 + 仅 planned→cancelled），绝不任意覆盖。
  const planItemsCancel = draft.mode === 'replan'
    ? draft.replacement_baseline.items.map((it) => ({ plan_item_id: it.plan_item_id, expected: it, new_state: 'cancelled' }))
    : []
  const writeSet = {
    source_field_confirmations: [],
    tasks_create: tasksCreate,
    tasks_update: [],
    actions_create: actionsCreate,
    plan_items_create: planItemsCreate,
    plan_items_cancel: planItemsCancel,
    thread_result_update: null,
  }
  return {
    idMap,
    writeSet,
    counts: previewCounts(writeSet),
    plannedGaps,
    existingOverbookDates,
    capacityBaseline: result.days ?? [],
  }
}

// R1：提交前用当前有效草案 + 冻结映射重建计划，逐项核对信封内容。
// 任何不一致（篡改分钟数/日期/归属、换 ID、改确认/基线）显式拒绝，绝不落库调用方原样写集。
export function verifyEnvelopeAgainstDraft(draft, envelope, { docs = [], notes = [], userMessages = [] } = {}) {
  if (!envelope || envelope.draft_id !== draft.id || envelope.draft_revision !== draft.revision) {
    fail('ENVELOPE_INTENT_MISMATCH', '采用信封与当前草案身份/版本不一致，拒绝提交')
  }
  const orderBase = {}
  for (const d of docs) {
    if (d.kind === 'plan_item') orderBase[d.date] = Math.max(orderBase[d.date] ?? 0, d.order ?? 0)
  }
  const plan = buildAdoptionPlan(draft, {
    workspaceId: envelope.workspace_id,
    now: envelope.issued_at,
    newId: () => fail('ID_MAP_MISSING', '核验路径不得生成新 ID'),
    orderBase,
    notes,
    userMessages,
    fixedIds: envelope.id_map ?? [],
  })
  if (canonicalJson(plan.idMap) !== canonicalJson(envelope.id_map ?? [])) {
    fail('ID_MAP_MISMATCH', '采用 ID 映射与草案内容重建结果不一致，拒绝提交')
  }
  if (canonicalJson(plan.writeSet) !== canonicalJson(envelope.write_set)) {
    fail('WRITE_SET_MISMATCH', '采用写集与草案排程结果不一致（内容/分钟/日期/归属被改动）；请重新准备并核对')
  }
  if (canonicalJson(plan.plannedGaps) !== canonicalJson(envelope.planned_gaps ?? [])) {
    fail('GAP_BASELINE_MISMATCH', '未排入清单与草案结果不一致，拒绝提交')
  }
  if (canonicalJson(plan.capacityBaseline) !== canonicalJson(envelope.capacity_baseline ?? [])) {
    fail('CAPACITY_BASELINE_MISMATCH', '容量基线与草案结果不一致，拒绝提交')
  }
  if (canonicalJson(plan.existingOverbookDates) !== canonicalJson(envelope.existing_overbook_dates ?? [])) {
    fail('OVERBOOK_MISMATCH', '过载日期与草案结果不一致，拒绝提交')
  }
  const confs = (draft.user_confirmations ?? []).filter((c) => c.draft_revision === draft.revision)
  if (canonicalJson(confs) !== canonicalJson(envelope.user_confirmations ?? [])) {
    fail('CONFIRMATION_MISMATCH', '采用确认与当前版草案不一致，拒绝提交')
  }
  if (canonicalJson(draft.fact_baseline ?? null) !== canonicalJson(envelope.fact_baseline ?? null)) {
    fail('FACT_BASELINE_MISMATCH', '事实基线与草案不一致，拒绝提交')
  }
  // M3：模式/改排范围/替换基线逐项核对；取消写集已随 writeSet 重建比对。
  if ((envelope.mode ?? 'create') !== (draft.mode ?? 'create')) {
    fail('ENVELOPE_INTENT_MISMATCH', '采用信封模式与草案不一致，拒绝提交')
  }
  if (canonicalJson(draft.replan_scope ?? null) !== canonicalJson(envelope.replan_scope ?? null)) {
    fail('REPLAN_SCOPE_MISMATCH', '采用信封改排范围与草案不一致，拒绝提交')
  }
  if (canonicalJson(draft.replacement_baseline ?? null) !== canonicalJson(envelope.replacement_baseline ?? null)) {
    fail('REPLACEMENT_BASELINE_MISMATCH', '采用信封替换基线与草案不一致，拒绝提交')
  }
  const gapKeys = new Set(confs.filter((c) => c.object_type === 'gap').map((c) => c.object_id_or_key))
  const overDates = new Set(confs.filter((c) => c.object_type === 'overbook').map((c) => c.object_id_or_key))
  if (envelope.gap_acknowledged !== plan.plannedGaps.every((g) => gapKeys.has(g.work_item_key))
    || envelope.overbook_acknowledged !== plan.existingOverbookDates.every((d) => overDates.has(d))) {
    fail('ACK_MISMATCH', '缺口/过载确认状态与草案不一致，拒绝提交')
  }
  return true
}

export function previewCounts(writeSet) {
  return {
    tasks_created: (writeSet.tasks_create ?? []).length,
    tasks_updated: 0,
    actions_created: (writeSet.actions_create ?? []).length,
    plan_items_created: (writeSet.plan_items_create ?? []).length,
    plan_items_cancelled: (writeSet.plan_items_cancel ?? []).length,
    source_fields_confirmed: 0,
  }
}

// 回执必须对应同一冻结意图：身份/版本/签名/ID 映射逐项一致，防止把别的采用结果记到本草案。
export function verifyReceiptForEnvelope(receipt, envelope) {
  if (!receipt || !envelope) return false
  return receipt.application_id === envelope.application_id
    && receipt.draft_id === envelope.draft_id
    && receipt.draft_revision === envelope.draft_revision
    && receipt.input_signature === envelope.input_signature
    && canonicalJson(receipt.id_map) === canonicalJson(envelope.id_map)
    && canonicalJson(receipt.cancelled_plan_item_ids ?? [])
      === canonicalJson((envelope.write_set?.plan_items_cancel ?? []).map((c) => c.plan_item_id))
    && (receipt.replan_task_id ?? null) === (envelope.replan_scope?.task_id ?? null)
}

export function appliedSummaryFromReceipt(receipt) {
  return {
    application_id: receipt.application_id,
    counts: receipt.counts,
    id_map: receipt.id_map,
    unscheduled_kept: receipt.unscheduled_kept ?? [],
    cancelled_plan_item_ids: receipt.cancelled_plan_item_ids ?? [],
    replan_task_id: receipt.replan_task_id ?? null,
    applied_at: receipt.committed_at,
  }
}