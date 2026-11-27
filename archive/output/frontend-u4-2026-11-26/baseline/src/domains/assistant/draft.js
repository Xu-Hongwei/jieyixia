// 助手草案纯规则（5B-1B）：状态机、修订与历史、限额、确认绑定、ready 独立推导。零写入、零 IO。
// 口径唯一来源：contract/assistant_models.py（字段/限额/确认校验）+
// contract/proposals/assistant-v1/selftest.py DRAFT_TRANSITIONS/REFRESH_MAP/RESTORE_MAP（冻结边集）。
// 限额数值来自 contract/limits.json（D-1 单一来源生成物），不手写镜像。
// 服务层（services/assistant）负责事务与并发基线；本模块只做可单测的规则判定。
import limitsDoc from '@contract/limits.json'
import {
  checkRealDate, checkRealDatetime, checkExistingDeadlineValue, windowDates,
} from '../planning/protocol.js'
import { validatePlanningResult } from '../planning/validate.js'
import { confirmTaskDeadline } from '../planning/normalize.js'
import { checkReplacementBaseline } from './replan.js'
import { resolveAssistantRefs } from './refs.js'

const L = limitsDoc.limits
export const MAX_DRAFT_REVISIONS = L.max_draft_revisions.value
export const MAX_DRAFT_HISTORY = MAX_DRAFT_REVISIONS - 1
export const MAX_DRAFT_BYTES = L.max_draft_bytes.value
export const MAX_THREAD_MESSAGES = L.max_thread_messages.value
export const MAX_MESSAGE_CHARS = L.max_user_message_chars.value

export const DRAFT_STATUSES = [
  'editing', 'generating', 'needs_clarification', 'ready', 'needs_review',
  'applying', 'applied', 'result_unknown', 'discarded',
]

// 冻结边集（selftest.py DRAFT_TRANSITIONS 逐对镜像）。本批不写 applying/applied/result_unknown。
const TRANSITION_PAIRS = [
  ['editing', 'generating'], ['editing', 'discarded'],
  ['generating', 'needs_clarification'], ['generating', 'ready'], ['generating', 'needs_review'], ['generating', 'discarded'],
  ['needs_clarification', 'generating'], ['needs_clarification', 'editing'], ['needs_clarification', 'discarded'],
  ['ready', 'applying'], ['ready', 'editing'], ['ready', 'generating'], ['ready', 'discarded'],
  ['applying', 'applied'], ['applying', 'needs_review'], ['applying', 'result_unknown'],
  ['result_unknown', 'applied'], ['result_unknown', 'applying'], ['result_unknown', 'needs_review'], ['result_unknown', 'discarded'],
  ['needs_review', 'editing'], ['needs_review', 'generating'], ['needs_review', 'discarded'],
]
const TRANSITIONS = new Set(TRANSITION_PAIRS.map(([a, b]) => `${a}>${b}`))

export function canTransition(from, to) {
  return TRANSITIONS.has(`${from}>${to}`)
}

// 本库刷新：generating 中断待显式重试；applying/result_unknown 保留待核实表达，不称「没有写入」。
const REFRESH_MAP = { generating: 'needs_review', applying: 'result_unknown', result_unknown: 'result_unknown' }
export function refreshDraftStatus(status) {
  return { status: REFRESH_MAP[status] ?? status, needsExplicitRetry: status in REFRESH_MAP }
}

// 备份恢复到新空间：未应用各态→needs_review 并去授权；applied 历史只读；discarded 保持。
export function restoreDraftStatus(status) {
  if (!DRAFT_STATUSES.includes(status)) throw new Error(`未知草案状态：${status}`)
  const restored = status === 'applied' ? 'applied' : status === 'discarded' ? 'discarded' : 'needs_review'
  return { restoredStatus: restored, envelopeCleared: true, baselineCleared: true, adoptionAuthCleared: true, contentKept: true }
}

// 稳定序列化：键排序递归，供「完整持久形状」同步比较与实质修改判定（不是 updated_at 锁）。
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
}

// 实质内容字段：目标/需求/范围/估时/依赖/规划窗口/事实基线。状态与确认不算内容（同版本可改）。
// M3：改排范围/进展清单/替换基线也是实质内容——编辑即增版，旧确认与旧信封失效。
const CONTENT_FIELDS = ['proposal', 'planning_input', 'planning_result', 'fact_baseline', 'assumptions', 'excluded_items', 'source_refs', 'replan_scope', 'progress_input', 'replacement_baseline']

// fact_baseline.captured_at 只是核对时刻（非语义信息）。内容版本判定剥离它，
// 使「同输入重复排程、仅时钟变化」不消耗 revision（R2）；task_facts/occupancy/指纹/字段快照等
// 真实事实仍参与比较，任何实质变化照常增版。不能整段忽略 fact_baseline。
// replacement_baseline 同理剥离 captured_at；items/focus_session_ids 实质内容照常比较。
const semanticFactBaseline = (fb) => {
  if (fb == null || typeof fb !== 'object') return fb ?? null
  const out = {}
  for (const k of Object.keys(fb)) if (k !== 'captured_at') out[k] = fb[k]
  return out
}

export function contentFingerprint(draft) {
  return canonicalJson(Object.fromEntries(CONTENT_FIELDS.map((k) => [
    k, (k === 'fact_baseline' || k === 'replacement_baseline') ? semanticFactBaseline(draft[k]) : (draft[k] ?? null),
  ])))
}

export function isSubstantiveChange(before, after) {
  return contentFingerprint(before) !== contentFingerprint(after)
}

const encoder = new TextEncoder()
export function draftJsonBytes(draft) {
  return encoder.encode(JSON.stringify(draft)).length
}

const realDt = (v) => { try { checkRealDatetime(v, 't'); return true } catch { return false } }

// 数值界限与配对不变量（紧凑 schema 校验器不管 minimum/maximum，这里补上）。
export function checkDraftBounds(draft) {
  const errors = []
  if (!Number.isInteger(draft.revision) || draft.revision < 1 || draft.revision > MAX_DRAFT_REVISIONS) {
    errors.push({ code: 'REVISION_LIMIT', message: `revision 必须是 1–${MAX_DRAFT_REVISIONS} 整数` })
  }
  const hist = draft.revision_history ?? []
  if (hist.length > MAX_DRAFT_HISTORY) errors.push({ code: 'HISTORY_LIMIT', message: `历史最多 ${MAX_DRAFT_HISTORY} 版` })
  const revs = hist.map((h) => h.revision)
  if (new Set(revs).size !== revs.length) errors.push({ code: 'HISTORY_DUP', message: '历史版本重复' })
  if (revs.some((r) => r >= draft.revision)) errors.push({ code: 'HISTORY_ORDER', message: '历史版本必须小于当前 revision' })
  if (hist.length + 1 > MAX_DRAFT_REVISIONS) errors.push({ code: 'REVISION_LIMIT', message: `每草案最多 ${MAX_DRAFT_REVISIONS} 个版本（含当前）` })
  const bytes = draftJsonBytes(draft)
  if (bytes > MAX_DRAFT_BYTES) errors.push({ code: 'DRAFT_TOO_LARGE', message: `草案 JSON ${bytes} 字节超过 ${MAX_DRAFT_BYTES}` })
  if (!DRAFT_STATUSES.includes(draft.status)) errors.push({ code: 'BAD_STATUS', message: `未知状态 ${draft.status}` })
  if (draft.status === 'applied' && !draft.applied_summary) errors.push({ code: 'APPLIED_NO_SUMMARY', message: 'applied 必须带 applied_summary' })
  if (draft.status !== 'applied' && draft.applied_summary) errors.push({ code: 'SUMMARY_NOT_APPLIED', message: '只有 applied 才有 applied_summary' })
  return errors
}

export function checkThreadBounds(thread) {
  const errors = []
  const msgs = thread.messages ?? []
  if (msgs.length > MAX_THREAD_MESSAGES) errors.push({ code: 'THREAD_FULL', message: `线程最多 ${MAX_THREAD_MESSAGES} 条消息` })
  msgs.forEach((m, i) => {
    if (typeof m.content !== 'string' || m.content.length > MAX_MESSAGE_CHARS) {
      errors.push({ code: 'MESSAGE_TOO_LONG', message: `消息[${i}]超过 ${MAX_MESSAGE_CHARS} 字符` })
    }
  })
  const ids = msgs.map((m) => m.id)
  if (new Set(ids).size !== ids.length) errors.push({ code: 'MESSAGE_DUP', message: '消息 id 重复' })
  return errors
}

// 消息追加（纯规则）：基于传入的最新线程对象；服务必须在事务内读最新后调用。
export function appendThreadMessage(thread, message) {
  const next = { ...thread, messages: [...(thread.messages ?? []), message] }
  const errors = checkThreadBounds(next)
  if (errors.length) return { ok: false, errors }
  return { ok: true, thread: next }
}

function snapshotOf(draft) {
  return {
    revision: draft.revision,
    proposal: draft.proposal ?? null,
    planning_input: draft.planning_input ?? null,
    planning_result: draft.planning_result ?? null,
    requirements: [],
    replan_scope: draft.replan_scope ?? null,
    progress_input: draft.progress_input ?? null,
    replacement_baseline: draft.replacement_baseline ?? null,
    created_at: draft.updated_at,
  }
}

const EDITABLE_STATUSES = ['editing', 'needs_clarification', 'needs_review', 'ready']

// 内容编辑：实质修改→revision+1 + 旧版只读快照；同内容保存不 bump。
// 越界（版本/体积）返回错误且原记录不变，不静默剪历史。新 revision 不继承旧授权
// （确认保留可读，但 draft_revision 绑定旧版，ready 推导只认当前版本确认）。
export function applyContentEdit(draft, edits, now) {
  if (!EDITABLE_STATUSES.includes(draft.status)) {
    return { ok: false, errors: [{ code: 'NOT_EDITABLE', message: `状态 ${draft.status} 不接受内容编辑` }] }
  }
  const unknown = Object.keys(edits).filter((k) => !CONTENT_FIELDS.includes(k))
  if (unknown.length) return { ok: false, errors: [{ code: 'BAD_EDIT_FIELD', message: `非内容字段：${unknown.join(',')}` }] }
  const next = { ...draft }
  for (const k of Object.keys(edits)) next[k] = edits[k]
  if (!isSubstantiveChange(draft, next)) return { ok: true, draft, bumped: false }

  // planning_input 与 planning_result 必须同一次计算：成对校验，旧结果不得覆盖新输入。
  if (next.planning_result != null) {
    if (next.planning_input == null) {
      return { ok: false, errors: [{ code: 'COMPUTATION_MISMATCH', message: '有 planning_result 必须有同版 planning_input' }] }
    }
    try { validatePlanningResult(next.planning_input, next.planning_result) } catch (e) {
      return { ok: false, errors: [{ code: 'COMPUTATION_MISMATCH', message: `planning_input/planning_result 不属于同一次计算：${e.message}` }] }
    }
  }

  next.revision = draft.revision + 1
  next.revision_history = [...(draft.revision_history ?? []), snapshotOf(draft)]
  next.updated_at = now
  next.status = 'editing'
  const errors = checkDraftBounds(next)
  if (errors.length) return { ok: false, errors }
  return { ok: true, draft: next, bumped: true }
}

// 生成结果接收（M2）：只接受 generating 态草案。proposal → 新 revision + needs_review（待核对），
// 旧计算/旧事实基线随旧 proposal 一并作废（planning_input/result/fact_baseline 清空，确认因版本绑定自然失效）；
// clarification → 仅状态 needs_clarification，不 bump（问题正文由服务落线程消息）。
// 模型成功 ≠ 草案就绪：接收后仍须用户核对、重排、确认才能 ready。
export function applyGenerationResult(draft, payload, now) {
  if (draft.status !== 'generating') {
    return { ok: false, errors: [{ code: 'NOT_GENERATING', message: `状态 ${draft.status} 不接收生成结果；只有 generating 态草案可接收` }] }
  }
  if (payload?.kind === 'clarification') {
    const next = { ...draft, status: 'needs_clarification', updated_at: now }
    const errors = checkDraftBounds(next)
    if (errors.length) return { ok: false, errors }
    return { ok: true, draft: next, bumped: false }
  }
  if (payload?.kind === 'proposal') {
    const next = {
      ...draft,
      proposal: payload.proposal,
      planning_input: null, planning_result: null, fact_baseline: null,
      revision: draft.revision + 1,
      revision_history: [...(draft.revision_history ?? []), snapshotOf(draft)],
      status: 'needs_review',
      updated_at: now,
    }
    const errors = checkDraftBounds(next)
    if (errors.length) return { ok: false, errors }
    return { ok: true, draft: next, bumped: true }
  }
  return { ok: false, errors: [{ code: 'BAD_PAYLOAD', message: `不支持的生成结果类型：${payload?.kind}` }] }
}

// 同版本确认追加：不 bump revision；完整并发基线校验由服务在事务内执行。
/** @param {{ live?: any, thread?: any }} [ctx] */
export function addConfirmation(draft, confirmation, now, ctx = {}) {
  const { live, thread } = ctx
  const v = validateConfirmation(confirmation, draft, { live, thread })
  if (!v.ok) return v
  if ((draft.user_confirmations ?? []).some((u) => u.confirmation_id === confirmation.confirmation_id)) {
    return { ok: false, errors: [{ code: 'CONFIRMATION_DUP', message: 'confirmation_id 重复' }] }
  }
  const next = { ...draft, user_confirmations: [...(draft.user_confirmations ?? []), confirmation], updated_at: now }
  if ((next.user_confirmations ?? []).length > 200) {
    return { ok: false, errors: [{ code: 'CONFIRMATION_LIMIT', message: '确认最多 200 条' }] }
  }
  const errors = checkDraftBounds(next)
  if (errors.length) return { ok: false, errors }
  return { ok: true, draft: next }
}

// 确认校验（C1/C2 口径不放宽）：绑定当前 revision；task 显式 id_scope；deadline 显式 old/new_value。
// 确认≠改值：本函数只判定，不修改任何 proposal 值。
/** @param {{ live?: any, thread?: any }} [ctx] */
export function validateConfirmation(u, draft, ctx = {}) {
  const { live, thread } = ctx
  const errors = []
  const push = (code, message) => errors.push({ code, message })
  if (!realDt(u.confirmed_at)) push('BAD_TIME', 'confirmed_at 非法')
  if (u.draft_revision !== draft.revision) push('REVISION_STALE', `确认绑定 revision ${u.draft_revision}，当前 ${draft.revision}；旧确认不能作用于新版本`)
  const taskKeys = new Set(((draft.proposal && draft.proposal.task_proposals) || []).map((t) => t.key))
  const workKeys = new Set([
    ...((draft.proposal && draft.proposal.work_items) || []).map((w) => w.key),
    ...((draft.planning_input && draft.planning_input.work_items) || []).map((w) => w.key),
  ])
  const reqKeys = new Set([
    ...((draft.proposal && draft.proposal.requirement_candidates) || []).map((r) => r.key),
    ...((thread && thread.confirmed_requirements) || []).map((r) => r.requirement_id),
  ])
  if (u.object_type === 'task') {
    if (u.id_scope !== 'draft' && u.id_scope !== 'formal') push('ID_SCOPE_REQUIRED', 'task 型确认必须显式 id_scope=draft/formal')
    else if (u.id_scope === 'draft' && !taskKeys.has(u.object_id_or_key)) push('UNKNOWN_DRAFT_KEY', `草案未注册 task key：${u.object_id_or_key}`)
    else if (u.id_scope === 'formal' && !(live && live.task instanceof Set && live.task.has(u.object_id_or_key))) push('UNKNOWN_FORMAL_ID', `捕获空间无此 Task：${u.object_id_or_key}`)
  } else {
    if (u.id_scope != null) push('ID_SCOPE_FORBIDDEN', '非 task 型确认不得携带 id_scope')
    if (u.object_type === 'note_field' && !(live && live.note instanceof Set && live.note.has(u.object_id_or_key))) push('UNKNOWN_NOTE', `捕获空间无此 Note：${u.object_id_or_key}`)
    if (u.object_type === 'requirement' && !reqKeys.has(u.object_id_or_key)) push('UNKNOWN_REQUIREMENT', `未注册要求：${u.object_id_or_key}`)
    if ((u.object_type === 'gap' || u.object_type === 'extra_work') && !workKeys.has(u.object_id_or_key)) push('UNKNOWN_WORK_ITEM', `未注册工作项：${u.object_id_or_key}`)
    if (u.object_type === 'overbook') {
      try { checkRealDate(u.object_id_or_key, 'overbook 日期') } catch { push('BAD_DATE', 'overbook 对象必须是真实日期 YYYY-MM-DD') }
    }
    if (u.object_type === 'replan_scope') {
      if (draft.mode !== 'replan' || !draft.replan_scope) push('NOT_REPLAN', 'replan_scope 确认只用于改排草案')
      else if (u.object_id_or_key !== draft.replan_scope.task_id) push('REPLAN_SCOPE_TARGET', 'replan_scope 确认必须指向本轮目标任务')
    }
  }
  if (u.object_type === 'task' && u.field_path === 'deadline') {
    for (const name of ['old_value', 'new_value']) {
      if (!Object.prototype.hasOwnProperty.call(u, name)) push('VALUE_MISSING', `task/deadline 确认必须显式携带 ${name}（缺失≠明确无截止）`)
    }
    for (const name of ['old_value', 'new_value']) {
      const v = u[name]
      if (v == null) continue
      if (typeof v !== 'object' || Array.isArray(v) || canonicalJson(Object.keys(v).sort()) !== '["precision","value"]') {
        push('VALUE_PROJECTION', `${name} 必须是 null 或 {value, precision} 投影`)
        continue
      }
      if (v.precision !== 'date' && v.precision !== 'datetime') { push('VALUE_PROJECTION', `${name}.precision 必须是 date/datetime`); continue }
      if (typeof v.value !== 'string') { push('VALUE_PROJECTION', `${name}.value 必须是字符串`); continue }
      try { checkExistingDeadlineValue(v.value, v.precision, name) } catch (e) { push('VALUE_PROJECTION', e.message) }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}

// 显式新建草案复制可读内容：重建身份、revision 归 1、清历史/确认/采用授权/旧事实基线。
export function forkDraft(draft, { id, now }) {
  if (typeof id !== 'string' || !id) throw new Error('forkDraft 需要新 ID')
  const next = {
    ...draft,
    id,
    revision: 1,
    revision_history: [],
    status: 'editing',
    user_confirmations: [],
    applied_summary: null,
    fact_baseline: null,
    created_at: now,
    updated_at: now,
  }
  if (next.planning_result != null && next.planning_input == null) next.planning_result = null
  // M3：改排草案 fork 后必须基于当前事实重新选择/冻结/排程；旧替换基线与旧计算不随 fork 授权。
  if (next.mode === 'replan') {
    next.replacement_baseline = null
    next.planning_input = null
    next.planning_result = null
  }
  return next
}

// 事实新鲜度核对（R1，纯函数）：拿草案冻结的 planning_input/fact_baseline 对照「最新空间快照 + 北京时间今天」，
// 覆盖整个规划窗口的占用（不只旧输入提到的 ID），并核对任务状态/截止/标题、既有行动完成、资料字段与日期。
// 返回 { fresh, diffs:[{kind,code,message}] }；不修改任何记录、不重排。服务在 get 与 ready 提交事务内各调用一次。
// 说明：要求（requirements）有效变化由 confirmRequirement 事务内失效旧事实基线（R5 等价失效机制），
// 失效后 fact_baseline 为空 → deriveReadiness 报 FACT_BASELINE_MISSING 阻断；reschedule 事务内 CONFLICT_FACTS 另保护本次计算前后要求一致。
export function checkFactFreshness(draft, { docs = [], sources = [], today = null } = {}) {
  const diffs = []
  const push = (kind, code, message) => diffs.push({ kind, code, message })
  const input = draft.planning_input
  const baseline = draft.fact_baseline
  if (!input || !baseline) return { fresh: true, diffs }

  const tasksById = new Map(docs.filter((d) => d.kind === 'task').map((t) => [t.id, t]))
  const actionsById = new Map(docs.filter((d) => d.kind === 'action').map((a) => [a.id, a]))
  const notesById = new Map(docs.filter((d) => d.kind === 'note').map((n) => [n.id, n]))
  const sourcesById = new Map(sources.map((s) => [s.id, s]))

  // 日期：规划起始日已早于北京时间今天（跨午夜/时钟推进）→ 窗口过期。
  if (today && input.start_date && today > input.start_date) {
    push('date', 'WINDOW_STALE', `规划起始日 ${input.start_date} 早于北京时间今天 ${today}，窗口已过期，须重新核对`)
  }

  // 占用：覆盖整个规划窗口，按唯一 PlanItem ID 比对新增/修改/删除。
  const window = new Set(windowDates(input.start_date))
  const currentOcc = new Map()
  for (const o of docs) {
    if (o.kind !== 'plan_item' || !window.has(o.date)) continue
    currentOcc.set(o.id, {
      plan_item_id: o.id, task_id: o.task_id, date: o.date,
      planned_minutes: o.planned_minutes, state: o.state,
      task_ref_state: o.task_ref_state ?? (tasksById.has(o.task_id) ? 'active' : 'deleted'),
    })
  }
  const frozenOcc = new Map((baseline.occupancy ?? []).map((o) => [o.plan_item_id, o]))
  for (const [id, cur] of currentOcc) {
    const old = frozenOcc.get(id)
    if (!old) push('occupancy', 'OCCUPANCY_ADDED', `窗口新增占用 ${id}（${cur.date} ${cur.planned_minutes} 分钟），旧草案未计入`)
    else if (canonicalJson(old) !== canonicalJson(cur)) push('occupancy', 'OCCUPANCY_CHANGED', `占用 ${id} 已变化，旧草案事实过期`)
  }
  for (const [id] of frozenOcc) {
    if (!currentOcc.has(id)) push('occupancy', 'OCCUPANCY_REMOVED', `占用 ${id} 已删除或移出窗口，旧草案事实过期`)
  }

  // 任务事实（R6）：对比「捕获时的正式事实基线」与当前正式 Task，而非本次规划采用的候选截止。
  // 草案已确认的新截止属于预期差异，由 deriveReadiness 的 update/create 确认核对负责，不在此误判为外部漂移。
  for (const f of baseline.task_facts ?? []) {
    if (!f.task_ref || f.task_ref.kind !== 'existing') continue
    const t = tasksById.get(f.task_ref.id)
    if (!t) { push('task', 'TASK_MISSING', `目标 ${f.task_ref.id} 已不存在`); continue }
    if ((t.status ?? 'todo') !== f.status) push('task', 'TASK_STATUS_CHANGED', `目标 ${f.task_ref.id} 状态 ${f.status} → ${t.status ?? 'todo'}`)
    const dl = t.deadline ?? { value: null, precision: 'none' }
    const curValue = (dl.precision ?? 'none') === 'none' ? null : dl.value ?? null
    const curPrecision = dl.precision ?? 'none'
    if (curValue !== (f.deadline_value ?? null) || curPrecision !== (f.deadline_precision ?? 'none')) {
      push('task', 'TASK_DEADLINE_CHANGED', `目标 ${f.task_ref.id} 正式截止已变化`)
    }
    if (t.title !== f.title) push('task', 'TASK_TITLE_CHANGED', `目标 ${f.task_ref.id} 标题已变化`)
  }

  // 既有行动：完成状态 + 内容基线（M1 审查 R5 / 复验 F2）。Action 无 updated_at，正文/估时/归属漂移
  // 必须对照重排时冻结的 action_facts 逐项核对；旧草案缺基线覆盖不得沿用不完整的采用授权——
  // 允许查看但阻断采用，须重排生成完整基线后重新确认（不静默拿当前行动补基线）。
  const actionFacts = new Map((baseline.action_facts ?? []).map((f) => [f.action_ref.id, f]))
  for (const w of input.work_items ?? []) {
    if (!w.action_ref || w.action_ref.kind !== 'existing') continue
    const a = actionsById.get(w.action_ref.id)
    if (!a) { push('action', 'ACTION_MISSING', `行动 ${w.action_ref.id} 已不存在`); continue }
    if (a.done) push('action', 'ACTION_DONE', `行动 ${w.action_ref.id} 已完成，不能作为未完成步骤重排`)
    const f = actionFacts.get(w.action_ref.id)
    if (!f) {
      push('action', 'ACTION_BASELINE_MISSING', `行动 ${w.action_ref.id} 缺少内容基线（旧草案），请重新排程后再采用`)
      continue
    }
    if (a.task_id !== f.task_id || a.text !== f.text || a.minutes !== f.minutes) {
      push('action', 'ACTION_CONTENT_CHANGED', `行动 ${w.action_ref.id} 的归属/正文/估时在预览后已变化，旧授权不再适用`)
    }
  }

  // 资料字段：冻结的便签字段快照对照当前值/状态/来源/派生。
  for (const b of baseline.note_field_baselines ?? []) {
    const note = notesById.get(b.note_id)
    const field = note && (note.fields ?? []).find((f) => f.key === b.field_key)
    const cur = {
      value: field ? field.value ?? null : null,
      status: field ? field.status ?? 'candidate' : 'candidate',
      origin: field ? field.origin ?? 'model' : 'model',
      derived: field ? Boolean(field.derived) : false,
    }
    const frozen = { value: b.value ?? null, status: b.status ?? 'candidate', origin: b.origin ?? 'model', derived: Boolean(b.derived) }
    if (canonicalJson(cur) !== canonicalJson(frozen)) push('note_field', 'NOTE_FIELD_CHANGED', `便签 ${b.note_id}.${b.field_key} 字段已变化`)
  }

  // 证据资料删除：冻结指纹指向的资料已不在空间（字节级哈希复核在 reschedule 重捕获时执行）。
  for (const fp of baseline.source_fingerprints ?? []) {
    if (!sourcesById.has(fp.source_id)) push('source', 'SOURCE_MISSING', `证据资料 ${fp.source_id} 已不存在`)
  }

  // M3 替换基线：所选旧安排逐字段内容全等 + 资格仍合格 + 无任何会话引用（含运行中/暂停）。
  // 历史字段无 updated_at，比内容不比时间戳；任何漂移整体阻断，不跳过单条。
  if (draft.mode === 'replan') {
    if (!draft.replacement_baseline) {
      push('replacement', 'REPLACEMENT_BASELINE_MISSING', '缺少替换基线，请重新准备改排')
    } else {
      const r = checkReplacementBaseline(draft.replacement_baseline, {
        workspaceId: draft.workspace_id,
        task: tasksById.get(draft.replan_scope?.task_id),
        today,
        window: new Set(windowDates(draft.replan_scope?.start_date ?? input.start_date)),
        planItems: docs.filter((d) => d.kind === 'plan_item'),
        focusSessions: docs.filter((d) => d.kind === 'focus_session'),
        scope: draft.replan_scope,
      })
      for (const d of r.diffs) push('replacement', d.code, d.message)
    }
  }

  return { fresh: diffs.length === 0, diffs }
}

// ready 独立推导：估时/事实/引用/确认/硬约束/缺口/过载逐项核对。
// 不能仅凭 result.complete 或页面传值；只认绑定当前 revision 的确认（新版本不继承旧授权）。
// freshness（R1）：服务基于最新空间快照与北京时间核对的事实新鲜度报告；漂移即阻断 ready。
/** @param {{ live?: any, thread?: any, freshness?: any }} [ctx] */
export function deriveReadiness(draft, ctx = {}) {
  const { thread, live, freshness } = ctx
  const blockers = []
  const add = (code, message) => blockers.push({ code, message })
  if (draft.status === 'discarded' || draft.status === 'applied') {
    add('NOT_ACTIVE', `状态 ${draft.status} 不参与 ready 推导`)
    return { ready: false, blockers }
  }
  if (!draft.proposal) add('NO_PROPOSAL', '缺少建议内容')
  if (!draft.fact_baseline) add('FACT_BASELINE_MISSING', '缺少事实基线，须先核对当前空间事实')
  if (!draft.planning_input || !draft.planning_result) {
    add('NO_COMPUTATION', '缺少同版 planning_input/planning_result')
  } else {
    try { validatePlanningResult(draft.planning_input, draft.planning_result) } catch (e) {
      add('COMPUTATION_MISMATCH', `规划输入输出不一致：${e.message}`)
    }
  }

  // 事实新鲜度（R1）：旧输入与旧结果彼此一致不能证明仍适用于当前空间。
  // 占用/任务/行动/资料字段/日期相对最新快照漂移 → 逐项列出差异并阻断，保留旧内容供查看，不静默重排。
  if (freshness && !freshness.fresh) {
    for (const d of freshness.diffs) add(d.code, `事实已变化：${d.message}`)
  }

  // 引用：活引用缺失→needs_review 级阻断；planned 占用断引用不可信；历史快照缺失只保留内容不阻断当前。
  const resolved = resolveAssistantRefs({ draft, thread, live })
  for (const r of resolved) {
    if (r.state === 'missing') {
      if (r.purpose === 'occupancy' && r.meta && r.meta.occupancyState === 'planned') {
        add('OCCUPANCY_UNTRUSTED', `planned 占用断引用（${r.path}=${r.value}）：阻断核对，不按 0 计`)
      } else if (r.purpose !== 'occupancy') {
        add('REF_MISSING', `活引用缺失：${r.path}=${r.value}`)
      }
    } else if (r.state === 'turn_missing') {
      add('EVIDENCE_TURN_MISSING', `证据回合不在线程中：${r.path}=${r.value}`)
    }
  }

  const result = draft.planning_result
  const current = (draft.user_confirmations ?? []).filter((u) => u.draft_revision === draft.revision)
  const has = (type, key, fieldPath) => current.some((u) => u.object_type === type && u.object_id_or_key === key && (fieldPath === undefined || u.field_path === fieldPath))

  if (result) {
    // complete 保持算法完整性原值（R3）。complete=false 完全分解为下列缺口/未知估时/硬冲突逐项核对：
    // 已知缺口有合法当前版本确认、且无其它阻断时可 ready；未知估时/硬冲突/过载未确认仍各自阻断。
    // 不在此按 complete 无条件阻断，也不删除任何逐项完整性检查。
    for (const c of result.conflicts ?? []) add('HARD_CONFLICT', `${c.code}: ${c.message}`)
    for (const u of result.unknown_items ?? []) add('ESTIMATE_UNKNOWN', `工作项 ${u.work_item_key} 估时未知`)
    for (const u of result.unscheduled ?? []) {
      if (!has('gap', u.work_item_key)) add('GAP_UNCONFIRMED', `未排量 ${u.work_item_key}（${u.reason}）未经当前版本确认`)
    }
    for (const d of result.days ?? []) {
      if (d.overbooked_minutes > 0 && !has('overbook', d.date)) add('OVERBOOK_UNCONFIRMED', `${d.date} 过载 ${d.overbooked_minutes} 分钟未经当前版本确认`)
    }
  }
  // M3：改排范围确认（保留安排覆盖的工作不在本次清单里）替代目标任务的 extra_work 口径；
  // 勾选取消≠范围确认。其它任务的 extra_work 规则不变。确认绑定当前 revision，编辑即失效。
  const replanTargetKeys = new Set(
    draft.mode === 'replan'
      ? ((draft.planning_input?.work_items ?? [])
          .filter((w) => w.task_ref?.kind === 'existing' && w.task_ref.id === draft.replan_scope?.task_id)
          .map((w) => w.key))
      : [],
  )
  const replanScopeConfirmed = draft.mode === 'replan' && draft.replan_scope
    && has('replan_scope', draft.replan_scope.task_id)
  for (const key of (draft.planning_input && draft.planning_input.extra_work_acknowledged) || []) {
    if (replanTargetKeys.has(key)) {
      if (!replanScopeConfirmed) add('REPLAN_SCOPE_UNCONFIRMED', `工作项 ${key} 的目标有保留安排；请确认「保留安排覆盖的工作不包含在这次清单里」`)
    } else if (!has('extra_work', key)) {
      add('EXTRA_WORK_UNCONFIRMED', `额外工作 ${key} 未经当前版本确认`)
    }
  }
  if (draft.mode === 'replan') {
    if (!draft.replan_scope || !draft.progress_input) add('REPLAN_INPUT_MISSING', '改排草案缺少范围或进展清单')
    if (draft.planning_result && !draft.replacement_baseline) add('REPLACEMENT_BASELINE_MISSING', '缺少替换基线，请重新排程冻结所选旧安排')
  }

  // 重要字段更新逐字段确认。deadline 与排程共用 confirmTaskDeadline（R8）：核对当前版确认 +
  // 正式旧值基线 + 有效新值；明确无截止/保留原值/手动非候选日期均合法，不以候选包含关系判定有效性。
  const deadlineConfs = current.filter((u) => u.object_type === 'task' && u.field_path === 'deadline')
  const formalBaseline = (targetId) => {
    const f = (draft.fact_baseline?.task_facts ?? []).find((x) => x.task_ref?.kind === 'existing' && x.task_ref.id === targetId)
    if (!f || (f.deadline_precision ?? 'none') === 'none') return null
    return { value: f.deadline_value ?? null, precision: f.deadline_precision }
  }
  const valuedCandidates = (dls) => (dls ?? []).filter((d) => (d.precision ?? 'none') !== 'none')
  // R10：当前截止决定须与计算实际采用的 PlanningTaskFact 绑定（按 draft/formal 命名空间匹配同一目标）。
  const planningFact = (objectKey, scope) => (draft.planning_input?.task_facts ?? []).find((f) => (
    scope === 'formal'
      ? f.task_ref?.kind === 'existing' && f.task_ref.id === objectKey
      : f.task_ref?.kind === 'draft' && f.task_ref.key === objectKey
  ))
  const checkDeadline = (objectKey, scope, baseline, unconfirmedCode, label) => {
    let decision
    try {
      decision = confirmTaskDeadline(deadlineConfs, draft.revision, objectKey, scope, baseline, label)
    } catch {
      add('CONFIRMATION_VALUE_STALE', `${label} 截止确认值非法`)
      return
    }
    if (decision.state === 'confirmed') {
      // 决定合法 ≠ 旧计算仍适用：值或精度与计算输入不一致须重新排程，不得仅凭确认放行旧结果。
      const fact = planningFact(objectKey, scope)
      if (fact) {
        const factPrecision = fact.deadline_precision ?? 'none'
        const factValue = factPrecision === 'none' ? null : fact.deadline_value ?? null
        const decPrecision = decision.precision ?? 'none'
        const decValue = decPrecision === 'none' ? null : decision.value ?? null
        if (factValue !== decValue || factPrecision !== decPrecision) {
          add('DEADLINE_RECOMPUTE_REQUIRED', `${label} 当前截止决定（${decValue ?? '无截止'}／${decPrecision}）与计算采用（${factValue ?? '无截止'}／${factPrecision}）不一致，须按新决定重新排程`)
        }
      }
      return
    }
    if (decision.state === 'unconfirmed') add(unconfirmedCode, `${label} 截止未经当前版本确认`)
    else add('CONFIRMATION_VALUE_STALE', `${label} 截止确认已失效（${decision.state === 'conflict' ? '多份矛盾确认' : decision.detail}）`)
  }
  for (const t of (draft.proposal && draft.proposal.task_proposals) || []) {
    if (t.op === 'update') {
      for (const f of ['title', 'description', 'completion_criteria']) {
        if (t.changes[f] == null) continue
        const matches = current.filter((u) => u.object_type === 'task' && u.id_scope === 'formal' && u.object_id_or_key === t.target_id && u.field_path === f)
        if (!matches.length) add('UPDATE_UNCONFIRMED', `update ${t.target_id}.${f} 未经当前版本确认`)
      }
      // 与 normalize 一致：仅当存在有值候选时才要求截止确认（无值候选直接沿用正式事实）。
      if (valuedCandidates(t.changes.deadline_candidates).length > 0) {
        checkDeadline(t.target_id, 'formal', formalBaseline(t.target_id), 'UPDATE_UNCONFIRMED', `update ${t.target_id}.deadline`)
      }
    }
    if (t.op === 'create' && valuedCandidates(t.deadline_candidates).length > 0) {
      checkDeadline(t.key, 'draft', null, 'DEADLINE_UNCONFIRMED', `新任务 ${t.key}`)
    }
  }
  return { ready: blockers.length === 0, blockers }
}