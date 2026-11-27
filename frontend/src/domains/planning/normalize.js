// 规划输入组装（5B-1A）：固定建议 + 已确认要求 + 当前空间一致快照 → PlanningInput。
// 语义口径镜像提案 selftest.check_model_semantics（含 R1–R4 整改）：
// - 既有截止事实走正式宽松口径（无秒/naive/小数秒可读）；模型新候选仍严格（R1）。
// - task link/update 的 draft key 解析到真实既有 Task，归属比较用解析后身份（合法别名不拆成两个任务）。
// - 已完成 Action 的 direct/reuse 引用统一拒绝（R3）；create/update 截止候选证据统一校验（R4）。
// 不完整（预算未确认/D12 未确认/窗口不一致）返回待澄清，不产出 PlanningInput、不调用排程器。
// 纯函数：不访问数据库/网络/系统时间；today 由调用层按北京时间传入 context。

import {
  fail, allowKeys, checkKey, checkRealDate, checkRealDatetime, checkInt, checkEnum,
  checkText, checkTypedRef, refToken, checkExistingDeadlineValue, checkDeadlineCandidateValue,
  checkConsecutiveDays, checkDependencyCycles, windowDates,
  TASK_STATUSES, PLAN_ITEM_STATES, PRIORITIES, JS_SAFE_INT_MAX,
} from './protocol.js'
import { validatePlanningInput } from './schedule.js'
import { validateReplanScope } from '../assistant/replan.js'

const PROPOSAL_KEYS = [
  'task_proposals', 'action_proposals', 'work_items', 'requirement_candidates',
  'evidence_refs', 'assumptions', 'warnings',
]
const REQUIREMENT_TYPES = [
  'daily_budget', 'unavailable_days', 'start_date', 'task_priority',
  'min_segment_minutes', 'splittable', 'ordering',
]
const EVIDENCE_KINDS = ['source_excerpt', 'note_field', 'user_message', 'existing_fact']

function checkEvidence(ev, ctx, label) {
  if (ev === null || typeof ev !== 'object') fail(`${label} 证据必须是对象`)
  if (ev.kind === 'source_excerpt') {
    if (!ctx.sourceIds.has(ev.source_id)) fail(`${label} 证据指向未选定 source：${ev.source_id}`)
  } else if (ev.kind === 'note_field') {
    if (!ctx.noteIds.has(ev.note_id)) fail(`${label} 证据指向未选定 note：${ev.note_id}`)
  } else if (ev.kind === 'user_message') {
    if (ctx.turnId != null && ev.turn_id !== ctx.turnId) fail(`${label} 用户消息证据 turn_id 不匹配`)
  } else if (ev.kind === 'existing_fact') {
    const registry = {
      task: ctx.taskIds, action: ctx.actionIds, note: ctx.noteIds,
      source: ctx.sourceIds, plan_item: ctx.planItemIds, focus_session: ctx.sessionIds,
    }[ev.object_type]
    if (!registry || !registry.has(ev.object_id)) fail(`${label} existing_fact 指向未知对象：${ev.object_type}/${ev.object_id}`)
  } else {
    fail(`${label} 证据 kind 必须是 ${EVIDENCE_KINDS.join('/')}：${ev.kind}`)
  }
}

function checkDeadlineCandidates(dls, ctx, label) {
  if (!Array.isArray(dls) || dls.length > 10) fail(`${label} 截止候选必须是 ≤10 的数组`)
  for (const dl of dls) {
    allowKeys(dl, ['value', 'precision', 'origin', 'derived', 'basis', 'evidence_refs'], `${label} 截止候选`)
    const precision = dl.precision ?? 'none'
    checkEnum(precision, ['none', 'date', 'datetime'], `${label} 截止候选 precision`)
    if (precision === 'none') {
      if (dl.value != null) fail('precision=none 时 value 必须为空')
    } else {
      if (dl.value == null) fail('有精度就必须有值')
      checkDeadlineCandidateValue(dl.value, precision, `${label} deadline_candidate.value`)
    }
    checkEnum(dl.origin ?? 'model', ['model', 'user'], `${label} 截止候选 origin`)
    checkEnum(dl.basis ?? 'explicit', ['explicit', 'relative', 'inferred'], `${label} 截止候选 basis`)
    if (precision !== 'none' && (dl.basis === 'relative' || dl.basis === 'inferred') && !dl.derived) {
      fail(`${label} 的建议截止日期缺少推算标记，请核对日期来源`)
    }
    const evs = dl.evidence_refs ?? []
    if (precision !== 'none' && evs.length === 0) fail('有值的截止候选必须给证据出处；无来源估计不能成为正式截止')
    for (const ev of evs) checkEvidence(ev, ctx, `${label} 截止候选`)
    if ((dl.origin ?? 'model') === 'user' && !evs.some((e) => e.kind === 'user_message')) {
      fail('origin=user 的截止候选必须有用户消息证据')
    }
  }
}

function checkRequirementValue(type, value, label) {
  if (type === 'daily_budget') {
    if (value != null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1440)) {
      fail('daily_budget 必须是 0–1440 整数或 null（未知待澄清，不默认 0）')
    }
  } else if (type === 'unavailable_days') {
    if (!Array.isArray(value) || value.length > 31 || !value.every((x) => typeof x === 'string')) {
      fail('unavailable_days 必须是日期数组')
    }
    for (const x of value) checkRealDate(x, 'unavailable_days')
  } else if (type === 'start_date') {
    checkRealDate(value, 'start_date')
  } else if (type === 'task_priority') {
    allowKeys(value, ['task_ref', 'priority'], `${label} task_priority`)
    checkTypedRef(value.task_ref, `${label} task_priority`)
    checkEnum(value.priority, PRIORITIES, `${label} priority`)
  } else if (type === 'min_segment_minutes') {
    checkInt(value, 1, 240, 'min_segment_minutes')
  } else if (type === 'splittable') {
    allowKeys(value, ['work_item_key', 'splittable'], `${label} splittable`)
    checkKey(value.work_item_key, `${label} splittable`)
    if (typeof value.splittable !== 'boolean') fail('splittable 必须是布尔')
  } else if (type === 'ordering') {
    allowKeys(value, ['before_key', 'after_key'], `${label} ordering`)
    checkKey(value.before_key, `${label} ordering before`)
    checkKey(value.after_key, `${label} ordering after`)
  }
}

// 建议结构+语义校验（解析后身份）。镜像 check_model_semantics。
function checkProposalSemantics(p, ctx) {
  const taskKeys = new Set(p.task_proposals.map((t) => t.key))
  const workKeys = new Set(p.work_items.map((w) => w.key))
  const allKeys = [...p.task_proposals.map((t) => t.key), ...p.action_proposals.map((a) => a.key), ...p.work_items.map((w) => w.key)]
  if (new Set(allKeys).size !== allKeys.length) fail('task/action/work item 的 draft key 必须全局唯一（采用时 id_map 不重复）')

  const checkTaskRef = (ref, label) => {
    if (ref.kind === 'draft') {
      if (!taskKeys.has(ref.key)) fail(`${label} 引用未知 draft task key：${ref.key}`)
    } else {
      const t = ctx.tasks.get(ref.id)
      if (!t) fail(`${label} 引用未知既有 Task：${ref.id}`)
      if (t.workspace_id !== ctx.workspaceId) fail(`${label} 跨空间引用 Task：${ref.id}`)
    }
  }

  for (const t of p.task_proposals) {
    if (t.op === 'link' || t.op === 'update') {
      const obj = ctx.tasks.get(t.target_id)
      if (!obj) fail(`task ${t.op} 指向未知既有 Task：${t.target_id}`)
      if (obj.workspace_id !== ctx.workspaceId) fail(`task ${t.op} 跨空间引用：${t.target_id}`)
    }
    if (t.op === 'create') checkDeadlineCandidates(t.deadline_candidates ?? [], ctx, `task ${t.key}`)
    if (t.op === 'update' && t.changes.deadline_candidates != null) {
      checkDeadlineCandidates(t.changes.deadline_candidates, ctx, `task ${t.key}`)
    }
    for (const ev of t.evidence_refs ?? []) checkEvidence(ev, ctx, `task ${t.key}`)
  }

  const actionByKey = new Map(p.action_proposals.map((a) => [a.key, a]))
  for (const a of p.action_proposals) {
    if (a.op === 'reuse') {
      const obj = ctx.actions.get(a.target_id)
      if (!obj) fail(`action reuse 指向未知既有 Action：${a.target_id}`)
      if (obj.workspace_id !== ctx.workspaceId) fail(`action reuse 跨空间引用：${a.target_id}`)
      if (obj.task_id !== a.task_ref.id) fail(`action reuse 跨任务：${a.target_id} 不属于 ${a.task_ref.id}`)
      if (obj.done) fail('已完成 Action 只能作为已满足前置的事实引用，不能重新排为未完成步骤')
    }
    checkTaskRef(a.task_ref, `action ${a.key}`)
    for (const ev of a.evidence_refs ?? []) checkEvidence(ev, ctx, `action ${a.key}`)
  }

  const graph = new Map()
  for (const w of p.work_items) {
    checkTaskRef(w.task_ref, `work item ${w.key}`)
    const ar = w.action_ref
    if (ar.kind === 'draft') {
      const a = actionByKey.get(ar.key)
      if (!a) fail(`work item ${w.key} 引用未知 draft action key：${ar.key}`)
      if (refToken(a.task_ref) !== refToken(w.task_ref)) fail(`work item ${w.key} 与建议行动 ${ar.key} 不属于同一目标`)
    } else {
      const obj = ctx.actions.get(ar.id)
      if (!obj) fail(`work item ${w.key} 引用未知既有 Action：${ar.id}`)
      if (obj.workspace_id !== ctx.workspaceId) fail(`work item ${w.key} 跨空间引用 Action：${ar.id}`)
      if (w.task_ref.kind === 'draft') fail('新建目标不得引用既有 Action')
      if (obj.task_id !== w.task_ref.id) fail(`work item ${w.key} 跨任务引用 Action：${ar.id}`)
      if (obj.done) fail('已完成 Action 只能作为已满足前置的事实引用，不能重新排为未完成步骤')
    }
    for (const dep of w.depends_on ?? []) {
      if (!workKeys.has(dep)) fail(`work item ${w.key} 依赖未知工作项：${dep}`)
    }
    graph.set(w.key, w.depends_on ?? [])
  }
  checkDependencyCycles(graph)

  const covered = new Set(p.task_proposals.filter((t) => t.op === 'link' || t.op === 'update').map((t) => t.target_id))
  const extra = new Set(p.work_items.filter((w) => w.task_ref.kind === 'existing' && !covered.has(w.task_ref.id)).map((w) => w.task_ref.id))
  if (p.task_proposals.length + extra.size > 20) fail(`本次目标合计 ${p.task_proposals.length + extra.size} 超过 20`)

  for (const r of p.requirement_candidates ?? []) {
    if (r.type === 'task_priority') checkTaskRef(r.value.task_ref, `requirement ${r.key}`)
    if (r.type === 'splittable' && !workKeys.has(r.value.work_item_key)) fail(`requirement ${r.key} 引用未知工作项：${r.value.work_item_key}`)
    if (r.type === 'ordering') {
      for (const k of [r.value.before_key, r.value.after_key]) {
        if (!workKeys.has(k)) fail(`requirement ${r.key} 引用未知工作项：${k}`)
      }
    }
  }
  for (const ev of p.evidence_refs ?? []) checkEvidence(ev, ctx, '顶层证据')
}

// 建议对象结构校验（形状/字段/数值；语义在 checkProposalSemantics）。
function checkProposalStructure(p) {
  allowKeys(p, PROPOSAL_KEYS, 'AssistantModelProposal')
  for (const group of ['task_proposals', 'action_proposals', 'work_items', 'requirement_candidates']) {
    if (!Array.isArray(p[group] ?? [])) fail(`${group} 必须是数组`)
  }
  if ((p.task_proposals ?? []).length > 20) fail('task_proposals 最多 20')
  if ((p.action_proposals ?? []).length > 100) fail('action_proposals 最多 100')
  if ((p.work_items ?? []).length > 100) fail('work_items 最多 100')
  for (const t of p.task_proposals ?? []) {
    checkKey(t.key, 'task')
    checkEnum(t.op, ['create', 'link', 'update'], 'task op')
    if (t.op === 'create') {
      allowKeys(t, ['op', 'key', 'title', 'description', 'completion_criteria', 'deadline_candidates', 'evidence_refs'], 'TaskProposalCreate')
      checkText(t.title, 1, 200, 'task.title')
    } else if (t.op === 'link') {
      allowKeys(t, ['op', 'key', 'target_id', 'evidence_refs'], 'TaskProposalLink')
      checkText(t.target_id, 1, 64, 'task.target_id')
    } else {
      allowKeys(t, ['op', 'key', 'target_id', 'changes', 'evidence_refs'], 'TaskProposalUpdate')
      checkText(t.target_id, 1, 64, 'task.target_id')
      allowKeys(t.changes, ['title', 'description', 'completion_criteria', 'deadline_candidates'], 'TaskUpdateFields')
      const c = t.changes
      if (c.title == null && c.description == null && c.completion_criteria == null && c.deadline_candidates == null) {
        fail('update 必须至少提出一个字段变更')
      }
      if (c.title != null) checkText(c.title, 1, 200, 'update.title')
    }
  }
  for (const a of p.action_proposals ?? []) {
    checkKey(a.key, 'action')
    checkEnum(a.op, ['create', 'reuse'], 'action op')
    checkTypedRef(a.task_ref, `action ${a.key} task_ref`)
    if (a.op === 'create') {
      allowKeys(a, ['op', 'key', 'task_ref', 'text', 'minutes', 'basis', 'evidence_refs'], 'ActionProposalCreate')
      checkText(a.text, 1, 500, 'action.text')
      checkInt(a.minutes, 1, JS_SAFE_INT_MAX, 'action.minutes')
      checkEnum(a.basis ?? 'suggestion', ['requirement', 'suggestion'], 'action.basis')
      if (a.basis === 'requirement' && (a.evidence_refs ?? []).length === 0) fail('声称是原文要求就必须给证据')
    } else {
      allowKeys(a, ['op', 'key', 'target_id', 'task_ref', 'evidence_refs'], 'ActionProposalReuse')
      checkText(a.target_id, 1, 64, 'action.target_id')
      if (a.task_ref.kind !== 'existing') fail('action reuse 的 task_ref 必须是 existing')
    }
  }
  for (const w of p.work_items ?? []) {
    allowKeys(w, ['key', 'task_ref', 'action_ref', 'deliverable', 'remaining_minutes', 'estimate_origin', 'splittable', 'min_segment_minutes', 'earliest_date', 'depends_on', 'priority'], 'WorkItemProposal')
    checkKey(w.key, 'work item')
    checkTypedRef(w.task_ref, `work item ${w.key} task_ref`)
    checkTypedRef(w.action_ref, `work item ${w.key} action_ref`)
    checkText(w.deliverable, 1, 500, `work item ${w.key} deliverable`)
    if (w.remaining_minutes != null && (typeof w.remaining_minutes !== 'number' || !Number.isSafeInteger(w.remaining_minutes) || w.remaining_minutes <= 0)) {
      fail('remaining_minutes 必须为正安全整数或 null（未知），不能用 0')
    }
    if (w.earliest_date != null) checkRealDate(w.earliest_date, 'earliest_date')
    if ((w.depends_on ?? []).includes(w.key)) fail('工作项不得依赖自身')
    if (new Set(w.depends_on ?? []).size !== (w.depends_on ?? []).length) fail('depends_on 不得重复')
    checkEnum(w.priority ?? 'normal', PRIORITIES, 'priority')
    checkInt(w.min_segment_minutes ?? 25, 1, 240, 'min_segment_minutes')
  }
  for (const r of p.requirement_candidates ?? []) {
    allowKeys(r, ['key', 'type', 'value', 'strength', 'provenance', 'evidence_refs'], 'RequirementCandidate')
    checkKey(r.key, 'requirement')
    checkEnum(r.type, REQUIREMENT_TYPES, 'requirement type')
    checkRequirementValue(r.type, r.value, `requirement ${r.key}`)
  }
}

// R1：daily_budget 按强度解析。同强度取最大版本；同版本不同值 → 澄清，不按数组先后决定。
// 硬上限：已有日预算取更小值，未知日填硬值；软偏好：只填仍未知的日。
function resolveDailyBudgets(requirements, dates, budgets, clarifications) {
  const byStrength = { hard: [], soft: [] }
  for (const r of requirements) {
    if (r.type === 'daily_budget' && r.value != null) byStrength[r.strength ?? 'hard'].push(r)
  }
  const resolved = { hard: null, soft: null }
  for (const strength of ['hard', 'soft']) {
    const group = byStrength[strength]
    if (group.length === 0) continue
    const maxVersion = Math.max(...group.map((r) => r.version))
    const top = group.filter((r) => r.version === maxVersion)
    const values = [...new Set(top.map((r) => r.value))]
    if (values.length > 1) {
      clarifications.push({
        question_id: `q-budget-conflict-${strength}`,
        question: `已确认的${strength === 'hard' ? '硬' : '软'}每日预算在第 ${maxVersion} 版存在多个不同值（${values.join('、')} 分钟），以哪个为准？`,
        options: [], blocking_reason: 'budget_conflict', related_requirement_key: null,
      })
      continue
    }
    resolved[strength] = top[0].value
  }
  for (const d of dates) {
    let current = budgets.get(d)
    if (resolved.hard != null) current = current == null ? resolved.hard : Math.min(current, resolved.hard)
    if (resolved.soft != null && current == null) current = resolved.soft
    budgets.set(d, current)
  }
}

// 截止决定唯一规则（R4/R8）：排程（normalizePlanningContext）与就绪（deriveReadiness）共用。
// 核对当前版确认 + 正式旧值基线 + 有效新值。baseline 是 {value,precision} 投影（create 恒 null；
// update 取快照既有截止）。new_value=null 明确无截止；等于 baseline 保留旧事实（宽松口径）；
// 其它值按新候选严格口径校验。明确无截止/保留原值/手动非候选日期均合法，不以「确认值是否在模型
// 候选中」判定有效性。确认≠改值：旧版授权/旧值漂移/相互矛盾确认仍失效待重新确认。
export function confirmTaskDeadline(confirmations, draftRevision, objectKey, scope, baseline, label) {
  const matching = confirmations.filter((c) => c.object_id_or_key === objectKey && c.id_scope === scope)
  if (matching.length === 0) return { state: 'unconfirmed' }
  for (const c of matching) {
    if (c.draft_revision !== draftRevision) {
      return { state: 'stale', detail: `确认绑定草案第 ${c.draft_revision} 版，当前为第 ${draftRevision} 版` }
    }
    if (JSON.stringify(c.old_value ?? null) !== JSON.stringify(baseline)) {
      return { state: 'stale', detail: '确认的旧值与当前基线不一致' }
    }
  }
  const distinct = [...new Set(matching.map((c) => JSON.stringify(c.new_value ?? null)))]
  if (distinct.length > 1) return { state: 'conflict' }
  const newValue = matching[0].new_value ?? null
  if (newValue === null) return { state: 'confirmed', value: null, precision: 'none' }
  if (baseline != null && JSON.stringify(newValue) === JSON.stringify(baseline)) {
    return { state: 'confirmed', value: baseline.value, precision: baseline.precision }
  }
  allowKeys(newValue, ['value', 'precision'], `${label} 确认新截止`)
  checkEnum(newValue.precision, ['date', 'datetime'], `${label} 确认新截止 precision`)
  if (newValue.value == null) fail('确认新截止必须有值；明确无截止请用 null')
  checkDeadlineCandidateValue(newValue.value, newValue.precision, `${label} 确认新截止 value`)
  return { state: 'confirmed', value: newValue.value, precision: newValue.precision }
}

/**
 * 组装 PlanningInput。
 * snapshot：当前空间一致快照 { workspace_id, turn_id?, tasks, actions, plan_items,
 *   source_ids, note_ids, plan_item_ids?, focus_session_ids? }（tasks/actions 含 workspace_id；
 *   plan_items 为窗口相关全部安排，含未选中任务）。
 * proposal：AssistantModelProposal 形状；requirements：已确认 ConfirmedRequirement 数组；
 * context：PlanningContext 形状（today/start_date/days，预算允许 null）。
 * options（组装层配套，不进 PlanningInput 字段）：
 *   extraWorkAcknowledged: D12 已确认工作项 key；excludedItems: [{work_item_key, reason}]；bufferPct；
 *   draftRevision: 当前草案版本（默认 1）；taskDeadlineConfirmations: UserConfirmation 形状的
 *   截止确认记录（object_type=task、field_path=deadline；create 绑 draft key、update 绑正式 Task id）。
 * 返回 { ok:true, input, excludedItems, clarifications:[] } 或 { ok:false, input:null, clarifications }。
 */
export function normalizePlanningContext(snapshot, proposal, requirements = [], context, options = {}) {
  const tasks = new Map((snapshot.tasks ?? []).map((t) => [t.id, t]))
  const actions = new Map((snapshot.actions ?? []).map((a) => [a.id, a]))
  const ctx = {
    workspaceId: snapshot.workspace_id,
    turnId: snapshot.turn_id ?? null,
    tasks, actions,
    taskIds: new Set(tasks.keys()),
    actionIds: new Set(actions.keys()),
    sourceIds: new Set(snapshot.source_ids ?? []),
    noteIds: new Set(snapshot.note_ids ?? []),
    planItemIds: new Set(snapshot.plan_item_ids ?? (snapshot.plan_items ?? []).map((p) => p.id)),
    sessionIds: new Set(snapshot.focus_session_ids ?? []),
  }
  checkText(ctx.workspaceId, 1, 64, 'workspace_id')

  // link/update 的 draft key 解析到真实既有 Task；归属比较用解析后身份，保留原 key 供草案层展示。
  const taskByKey = new Map((proposal.task_proposals ?? []).map((t) => [t.key, t]))
  const resolveRef = (ref) => {
    if (ref.kind !== 'draft') return ref
    const tp = taskByKey.get(ref.key)
    if (tp && (tp.op === 'link' || tp.op === 'update')) return { kind: 'existing', id: tp.target_id }
    return ref
  }
  const p = {
    ...proposal,
    task_proposals: proposal.task_proposals ?? [],
    action_proposals: (proposal.action_proposals ?? []).map((a) => ({ ...a, task_ref: resolveRef(a.task_ref) })),
    work_items: (proposal.work_items ?? []).map((w) => ({ ...w, task_ref: resolveRef(w.task_ref) })),
    requirement_candidates: (proposal.requirement_candidates ?? []).map((r) => (
      r.type === 'task_priority' ? { ...r, value: { ...r.value, task_ref: resolveRef(r.value.task_ref) } } : r
    )),
  }
  checkProposalStructure(p)
  checkProposalSemantics(p, ctx)

  checkRealDate(context.today, 'context.today')
  checkRealDate(context.start_date, 'context.start_date')
  if (context.start_date < context.today) fail('start_date 不得早于北京时间今天；不创建过去的新安排')
  checkConsecutiveDays(context.start_date, (context.days ?? []).map((d) => d.date), 'planning_context.days')
  for (const d of context.days) {
    if (d.budget_minutes != null) checkInt(d.budget_minutes, 0, 1440, `context.days[${d.date}].budget_minutes`)
  }
  const dates = windowDates(context.start_date)
  const windowSet = new Set(dates)

  // M3 改排分支：单任务守卫 + 范围校验。有效占用在占用段计算；schedule 只消费结果。
  const replan = options.replan ?? null
  if (replan) {
    const scope = replan.scope
    if (!scope || typeof scope.task_id !== 'string' || !scope.task_id) fail('改排范围缺少目标任务')
    if (scope.start_date !== context.start_date) fail('改排起始日与规划窗口不一致，请重新组装窗口')
    if (!tasks.has(scope.task_id)) fail(`改排目标任务 ${scope.task_id} 不在捕获快照`)
    if (tasks.get(scope.task_id).status === 'done') fail('已完成任务不得进入改排')
    for (const t of p.task_proposals) {
      if (t.op !== 'link' || t.target_id !== scope.task_id) fail('改排只允许 link 目标任务；不得新建或修改任务')
    }
    for (const w of p.work_items) {
      if (w.task_ref.kind !== 'existing' || w.task_ref.id !== scope.task_id) fail(`改排工作项 ${w.key} 必须指向目标任务`)
    }
    for (const a of p.action_proposals) {
      if (a.task_ref.kind !== 'existing' || a.task_ref.id !== scope.task_id) fail(`改排行动 ${a.key} 必须属于目标任务`)
      if (a.op === 'reuse') {
        const target = actions.get(a.target_id)
        if (!target || target.task_id !== scope.task_id) fail(`改排复用行动 ${a.target_id} 不属于目标任务`)
        if (target.done) fail(`改排不得复用已完成行动 ${a.target_id}`)
      }
    }
  }

  for (const r of requirements) {
    allowKeys(r, ['requirement_id', 'version', 'type', 'value', 'strength', 'confirmed_at', 'evidence_refs'], 'ConfirmedRequirement')
    checkKey(r.requirement_id, 'confirmed requirement')
    checkInt(r.version, 1, JS_SAFE_INT_MAX, 'requirement.version')
    checkEnum(r.type, REQUIREMENT_TYPES, 'confirmed requirement type')
    checkEnum(r.strength ?? 'hard', ['hard', 'soft'], 'confirmed requirement strength')
    checkRealDatetime(r.confirmed_at, 'requirement.confirmed_at')
    checkRequirementValue(r.type, r.value, `confirmed requirement ${r.requirement_id}`)
  }

  // 任务事实：既有任务用快照截止（宽松口径 R1）；新建/update 的有值截止候选须经本地确认（R4）。
  const clarifications = []
  const draftRevision = options.draftRevision ?? 1
  checkInt(draftRevision, 1, JS_SAFE_INT_MAX, 'options.draftRevision')
  const deadlineConfirmations = options.taskDeadlineConfirmations ?? []
  if (!Array.isArray(deadlineConfirmations)) fail('taskDeadlineConfirmations 必须是数组')
  const createKeys = new Set(p.task_proposals.filter((t) => t.op === 'create').map((t) => t.key))
  for (const c of deadlineConfirmations) {
    allowKeys(c, ['confirmation_id', 'draft_revision', 'object_type', 'object_id_or_key', 'id_scope', 'field_path', 'old_value', 'new_value', 'confirmed_at'], 'UserConfirmation')
    checkText(c.confirmation_id, 1, 64, 'confirmation.confirmation_id')
    checkInt(c.draft_revision, 1, JS_SAFE_INT_MAX, 'confirmation.draft_revision')
    if (c.object_type !== 'task') fail('taskDeadlineConfirmations 只接受 object_type=task')
    if (c.field_path !== 'deadline') fail('taskDeadlineConfirmations 只接受 field_path=deadline')
    checkText(c.object_id_or_key, 1, 64, 'confirmation.object_id_or_key')
    // C1：task 型必须显式判别命名空间；draft 绑本草案 create key，formal 绑快照既有 Task。
    checkEnum(c.id_scope, ['draft', 'formal'], 'confirmation.id_scope（task 型必填）')
    if (c.id_scope === 'draft' && !createKeys.has(c.object_id_or_key)) {
      fail(`确认对象 ${c.object_id_or_key} 不是本草案新建目标 key（id_scope=draft）`)
    }
    if (c.id_scope === 'formal' && !tasks.has(c.object_id_or_key)) {
      fail(`确认对象 ${c.object_id_or_key} 不是捕获快照中的既有目标（id_scope=formal）`)
    }
    // C2：缺失/undefined 不是明确选择；old_value 与 new_value 必须显式携带（含显式 null）。
    for (const name of ['old_value', 'new_value']) {
      if (!Object.hasOwn(c, name) || c[name] === undefined) {
        fail(`task/deadline 确认必须显式携带 ${name}（缺失不得解释为明确无截止）`)
      }
    }
    checkRealDatetime(c.confirmed_at, 'confirmation.confirmed_at')
  }
  const valuedCandidates = (dls) => (dls ?? []).filter((d) => (d.precision ?? 'none') !== 'none')
  const updateCandidatesByTarget = new Map()
  for (const t of p.task_proposals) {
    if (t.op !== 'update') continue
    const valued = valuedCandidates(t.changes.deadline_candidates)
    if (valued.length === 0) continue
    updateCandidatesByTarget.set(t.target_id, [...(updateCandidatesByTarget.get(t.target_id) ?? []), ...valued])
  }
  const factByToken = new Map()
  const addFact = (ref, title, status, deadlineValue, deadlinePrecision) => {
    const token = refToken(ref)
    if (factByToken.has(token)) return
    checkEnum(status, TASK_STATUSES, 'task_fact.status')
    if (deadlinePrecision !== 'none' && deadlineValue != null) {
      checkExistingDeadlineValue(deadlineValue, deadlinePrecision, 'snapshot deadline.value')
    }
    factByToken.set(token, {
      task_ref: ref, title, status,
      deadline_value: deadlinePrecision === 'none' ? null : deadlineValue,
      deadline_precision: deadlinePrecision,
      overdue_consent: false,
    })
  }
  const deadlineHandled = new Set()
  const pushDeadlineClarification = (objectKey, title, candidates, baseline, decision) => {
    const candText = candidates.map((d) => `${d.value}（${d.precision}）`).join('、')
    if (decision.state === 'unconfirmed') {
      const oldText = baseline ? `旧事实 ${baseline.value}（${baseline.precision}）保留等待确认；` : ''
      clarifications.push({
        question_id: 'q-deadline-confirm',
        question: `目标「${title}」存在截止候选 ${candText}，尚未本地确认。${oldText}请确认采用哪个值、修改为其它值，或明确无截止。`,
        options: [], blocking_reason: 'deadline_needs_confirmation', related_requirement_key: null,
      })
    } else if (decision.state === 'stale') {
      clarifications.push({
        question_id: 'q-deadline-stale',
        question: `目标「${title}」的截止确认已失效（${decision.detail}），请基于当前草案重新确认。`,
        options: [], blocking_reason: 'deadline_confirmation_stale', related_requirement_key: null,
      })
    } else {
      clarifications.push({
        question_id: 'q-deadline-conflict',
        question: `目标「${title}」存在多份互相矛盾的截止确认，请以一份为准重新确认。`,
        options: [], blocking_reason: 'deadline_confirmation_conflict', related_requirement_key: null,
      })
    }
  }
  for (const w of p.work_items) {
    if (w.task_ref.kind === 'existing') {
      const t = tasks.get(w.task_ref.id)
      if (t.status === 'done') fail(`工作项 ${w.key} 指向已完成目标：已完成目标不作为新工作投入`)
      const dl = t.deadline ?? { value: null, precision: 'none' }
      const candidates = updateCandidatesByTarget.get(w.task_ref.id)
      if (!candidates) {
        addFact(w.task_ref, t.title, t.status ?? 'todo', dl.value ?? null, dl.precision ?? 'none')
        continue
      }
      const token = refToken(w.task_ref)
      if (deadlineHandled.has(token)) continue
      deadlineHandled.add(token)
      const baseline = (dl.precision ?? 'none') === 'none' ? null : { value: dl.value, precision: dl.precision }
      const decision = confirmTaskDeadline(deadlineConfirmations, draftRevision, w.task_ref.id, 'formal', baseline, `task ${w.task_ref.id}`)
      if (decision.state === 'confirmed') {
        addFact(w.task_ref, t.title, t.status ?? 'todo', decision.value, decision.precision)
      } else {
        pushDeadlineClarification(w.task_ref.id, t.title, candidates, baseline, decision)
      }
    } else {
      const tp = taskByKey.get(w.task_ref.key)
      const candidates = valuedCandidates(tp.deadline_candidates)
      if (candidates.length === 0) {
        addFact(w.task_ref, tp.title, 'todo', null, 'none')
        continue
      }
      const token = refToken(w.task_ref)
      if (deadlineHandled.has(token)) continue
      deadlineHandled.add(token)
      const decision = confirmTaskDeadline(deadlineConfirmations, draftRevision, w.task_ref.key, 'draft', null, `task ${w.task_ref.key}`)
      if (decision.state === 'confirmed') {
        addFact(w.task_ref, tp.title, 'todo', decision.value, decision.precision)
      } else {
        pushDeadlineClarification(w.task_ref.key, tp.title, candidates, null, decision)
      }
    }
  }

  // 占用：读当前空间窗口内全部相关 PlanItem（含未选中任务），按 ID 去重；同 ID 内容矛盾报错。
  const occById = new Map()
  for (const o of snapshot.plan_items ?? []) {
    if (!windowSet.has(o.date)) continue
    checkRealDate(o.date, 'plan_item.date')
    checkEnum(o.state, PLAN_ITEM_STATES, 'plan_item.state')
    checkInt(o.planned_minutes, 1, JS_SAFE_INT_MAX, 'plan_item.planned_minutes')
    const entry = {
      plan_item_id: o.id, task_id: o.task_id, date: o.date,
      planned_minutes: o.planned_minutes, state: o.state,
      task_ref_state: o.task_ref_state ?? (tasks.has(o.task_id) ? 'active' : 'deleted'),
    }
    const prev = occById.get(o.id)
    if (prev) {
      if (JSON.stringify(prev) !== JSON.stringify(entry)) fail(`占用记录 ${o.id} 内容矛盾：同一 ID 不得有两份不同事实`)
      continue
    }
    occById.set(o.id, entry)
  }
  const occupancy = [...occById.values()]

  // M3：模拟占用 = O 排除已验证 R（一条只减一次）。原始完整 O 随结果返回供事实基线冻结；
  // 排程输入只带有效占用，replacement_ids 仅作记录，schedule 不得二次扣减。
  let effectiveOccupancy = occupancy
  let replacementIds = []
  if (replan) {
    const scope = replan.scope
    validateReplanScope(scope, {
      workspaceId: snapshot.workspace_id,
      task: tasks.get(scope.task_id),
      today: context.today,
      window: windowSet,
      planItems: snapshot.plan_items ?? [],
      focusSessions: snapshot.focus_sessions ?? [],
    })
    const R = new Set(scope.replacement_ids)
    effectiveOccupancy = occupancy.filter((o) => !R.has(o.plan_item_id))
    replacementIds = [...scope.replacement_ids]
  }

  // 已确认要求落到输入：硬每日上限与日可用量取更小值（R1）；软偏好只填未知日；
  // unavailable_days 在预算解析后置 0，与数组先后无关。
  const budgets = new Map(context.days.map((d) => [d.date, d.budget_minutes ?? null]))
  const overrides = { minSegment: null, priorityByToken: new Map(), splittableByKey: new Map(), ordering: [] }
  const unavailableDays = []
  for (const r of requirements) {
    if (r.type === 'unavailable_days') {
      unavailableDays.push(...r.value)
    } else if (r.type === 'start_date' && r.value !== context.start_date) {
      clarifications.push({
        question_id: 'q-start-date',
        question: `确认的起始日 ${r.value} 与当前窗口 ${context.start_date} 不一致，按哪个重新组装窗口？`,
        options: [], blocking_reason: 'start_date_mismatch', related_requirement_key: r.requirement_id,
      })
    } else if (r.type === 'min_segment_minutes') {
      overrides.minSegment = r.value
    } else if (r.type === 'task_priority') {
      overrides.priorityByToken.set(refToken(r.value.task_ref), r.value.priority)
    } else if (r.type === 'splittable') {
      overrides.splittableByKey.set(r.value.work_item_key, r.value.splittable)
    } else if (r.type === 'ordering') {
      overrides.ordering.push(r.value)
    }
  }
  resolveDailyBudgets(requirements, dates, budgets, clarifications)
  for (const d of unavailableDays) {
    if (windowSet.has(d)) budgets.set(d, 0)
  }
  const nullDays = dates.filter((d) => budgets.get(d) == null)
  if (nullDays.length > 0) {
    clarifications.push({
      question_id: 'q-daily-budget',
      question: `以下日期还没有确认每日可投入分钟数：${nullDays.join('、')}。每天大约能投入多少分钟？`,
      options: [], blocking_reason: 'budget_unknown', related_requirement_key: null,
    })
  }

  const workItems = p.work_items.map((w) => {
    const deps = [...(w.depends_on ?? [])]
    for (const o of overrides.ordering) {
      if (o.after_key === w.key && !deps.includes(o.before_key)) deps.push(o.before_key)
    }
    return {
      key: w.key,
      task_ref: w.task_ref,
      action_ref: w.action_ref,
      deliverable: w.deliverable,
      remaining_minutes: w.remaining_minutes ?? null,
      estimate_origin: w.estimate_origin ?? 'model',
      splittable: overrides.splittableByKey.has(w.key) ? overrides.splittableByKey.get(w.key) : (w.splittable ?? true),
      min_segment_minutes: overrides.minSegment ?? w.min_segment_minutes ?? 25,
      earliest_date: w.earliest_date ?? null,
      depends_on: deps,
      priority: overrides.priorityByToken.get(refToken(w.task_ref)) ?? w.priority ?? 'normal',
    }
  })

  // D12：既有任务窗口已有安排 → 本次剩余工作须确认「额外尚未安排」口径。
  // M3 改排：目标任务改用 replan_scope 范围确认（保留安排覆盖的工作不在本次清单里）；
  // 勾选取消≠范围确认。其它任务仍走 extra_work 口径。
  const occupiedExisting = new Set(
    effectiveOccupancy.filter((o) => ['planned', 'partial', 'done'].includes(o.state)).map((o) => o.task_id),
  )
  const ack = new Set(options.extraWorkAcknowledged ?? [])
  if (replan && replan.scopeAcknowledged) {
    for (const w of workItems) {
      if (w.task_ref.kind === 'existing' && w.task_ref.id === replan.scope.task_id) ack.add(w.key)
    }
  }
  const needAck = workItems
    .filter((w) => w.task_ref.kind === 'existing' && occupiedExisting.has(w.task_ref.id) && !ack.has(w.key))
    .map((w) => w.key)
  if (needAck.length > 0) {
    if (replan) {
      clarifications.push({
        question_id: 'q-replan-scope',
        question: '目标任务在窗口内仍有保留安排（未选及受保护安排继续占用容量）。请确认：上述保留安排覆盖的工作，不包含在这次待安排清单里。',
        options: [], blocking_reason: 'replan_scope_needs_confirmation', related_requirement_key: null,
        work_item_keys: needAck,
      })
    } else {
      clarifications.push({
        question_id: 'q-extra-work',
        question: `工作项 ${needAck.join('、')} 的目标在窗口内已有安排；本次估时是额外尚未安排的工作吗？`,
        options: [], blocking_reason: 'extra_work_needs_confirmation', related_requirement_key: null,
        // 结构化键供界面在排程前逐项确认（D12 阻断排程，确认面板不能依赖排程结果）。
        work_item_keys: needAck,
      })
    }
  }

  const excludedItems = options.excludedItems ?? []
  for (const e of excludedItems) {
    if (!workItems.some((w) => w.key === e.work_item_key)) fail(`排除项引用未知工作项：${e.work_item_key}`)
  }

  if (clarifications.length > 0) {
    return { ok: false, input: null, excludedItems, clarifications: clarifications.slice(0, 3) }
  }

  const input = {
    algorithm_version: 'daily-v1',
    timezone: 'Asia/Shanghai',
    today: context.today,
    start_date: context.start_date,
    horizon_days: 7,
    buffer_pct: options.bufferPct ?? 15,
    days: dates.map((d) => ({ date: d, budget_minutes: budgets.get(d) })),
    task_facts: [...factByToken.values()],
    work_items: workItems,
    occupancy: effectiveOccupancy,
    replacement_ids: replacementIds,
    extra_work_acknowledged: [...ack].filter((k) => workItems.some((w) => w.key === k)),
  }
  validatePlanningInput(input)
  return { ok: true, input, excludedItems, clarifications: [], occupancyFull: occupancy }
}
