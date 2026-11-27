// 契约 FocusSession（0.4.0）的纯规则：状态机迁移、计时结算、开始快照、关系校验、
// 删除保护谓词与逐引用断开/恢复补丁。不触库、不依赖 Vue。
// 时钟（wallNow）、ID、租约/检查点参数全部注入；每个 plan 接收事务内最新 docs 与全量
// focus_runtime，返回 { puts, deletes, runtimePuts, runtimeDeletes, info }；抛错即整体回滚。
// 异常时段不结算：置 recovery 并提交，info.code=RECOVERY_REQUIRED，绝不用 max(0,delta) 掩盖。
import { makeRunRecord, makeSessionRuntime, runId, sessId } from '../services/focus/runtime.js'
import { beijingDateStr } from './time'
import {
  assertPlanExecutable, existingUnfinishedSessionForPlan, summarizePlanTime, historySignature,
  assertPlanSnapshot, assertPlanHistoryConfirm, endedSessionsForPlan, isLiveRef, LIVE_PLAN_STATES,
} from './plan'

export const FOCUS_PARAMS = {
  CHECKPOINT_MS: 10_000,
  LEASE_MS: 30_000,
  OPS_WINDOW_MS: 600_000,
  JUMP_THRESHOLD_MS: 300_000,
  STALE_GAP_MS: 60_000,
}
export const FOCUS_OUTCOMES = ['done', 'partial', 'blocked']

const fail = (code, message, extra) => {
  throw Object.assign(new Error(message), { code }, extra || {})
}

function resolveEnv(env) {
  const wallMs = Date.parse(env.wallNow)
  if (!env.ws || Number.isNaN(wallMs)) throw new Error('focus env 缺少 ws 或合法 wallNow')
  return {
    ws: env.ws, wallNow: env.wallNow, wallMs,
    ownerId: env.ownerId,
    newId: env.newId || (() => crypto.randomUUID()),
    params: { ...FOCUS_PARAMS, ...(env.params || {}) },
    isDemo: !!env.isDemo,
  }
}

export const sessionsOf = (latest) => latest.filter((d) => d.kind === 'focus_session')
const findSession = (latest, id) => latest.find((d) => d.id === id && d.kind === 'focus_session')
const findTask = (latest, id) => latest.find((d) => d.id === id && d.kind === 'task')
const findAction = (latest, id) => latest.find((d) => d.id === id && d.kind === 'action')
export const isUnfinished = (s) => s.ended_at == null
const recordVersion = (s) => (s.record_version === 1 ? 1 : 0)

const runOf = (runtime, ws) => runtime.find((r) => r.id === runId(ws))
const sessRtOf = (runtime, sessionId) => runtime.find((r) => r.id === sessId(sessionId))
const anyRunning = (runtime, exceptSessionId) =>
  runtime.some((r) => r.kind === 'running' && r.session_id && r.session_id !== exceptSessionId)

const emptyPlan = (info) => ({ puts: [], deletes: [], runtimePuts: [], runtimeDeletes: [], info })

// —— 5A-2A 计划联动：确认事实与共用校验（纯规则，UI 与事务共用同一构造口）——

// 开始确认面板冻结的事实八字段。confirmDate=确认时刻北京日期；事务内按提交时刻重算，
// 跨午夜即差异。deadline 只是风险事实；taskCurrentActionId 变化要提示，但绝不静默改绑行动。
export const BEGIN_FACT_FIELDS = [
  'actionId', 'actionText', 'actionMinutes', 'taskStatus',
  'taskCurrentActionId', 'deadlineValue', 'deadlinePrecision', 'confirmDate',
]
export const beginFactsOf = (task, action, confirmDate) => ({
  actionId: action.id,
  actionText: action.text,
  actionMinutes: action.minutes,
  taskStatus: task.status,
  taskCurrentActionId: task.current_action_id ?? null,
  deadlineValue: task.deadline ? task.deadline.value ?? null : null,
  deadlinePrecision: task.deadline ? task.deadline.precision || 'none' : 'none',
  confirmDate,
})
export const beginFactsDiff = (expected, current) =>
  BEGIN_FACT_FIELDS.filter((f) => expected[f] !== current[f]).map((f) => ({ field: f, expected: expected[f], current: current[f] }))

const withDocs = (latest, puts) => {
  const next = [...latest]
  for (const p of puts) {
    const i = next.findIndex((d) => d.id === p.id)
    if (i >= 0) next[i] = p
    else next.push(p)
  }
  return next
}

// 计划联动结束共用校验（end/legacyEnd）：进度显式、安排归属/活状态、快照、旧历史核对。
// 历史摘要基于事务内最新 docs——本段尚未结束，天然不在「用户核对的旧历史」里。
function assertPlanEndLink(latest, session, ws, input) {
  if (input.planProgress == null) fail('PLAN_CONFIRM_REQUIRED', '关联安排的结束必须显式选择安排进度（还需要继续/这项安排已完成）')
  if (input.planProgress !== 'partial' && input.planProgress !== 'done') fail('INVALID_FIELD', '安排进度必须是 partial 或 done')
  if (input.expected == null) fail('PLAN_CONFIRM_REQUIRED', '关联安排的结束必须携带冻结的安排快照')
  const item = latest.find((d) => d.id === session.plan_item_id && d.kind === 'plan_item')
  if (!item || item.workspace_id !== ws || item.task_id !== session.task_id) {
    fail('RELATION_INVALID', '会话关联的安排不存在或归属不符，请先核对数据；输入保留，不拆分保存')
  }
  if (!isLiveRef(item) || !LIVE_PLAN_STATES.includes(item.state)) {
    fail('PLAN_NOT_EXECUTABLE', '安排已终态或任务引用断开，无法联动进度；请先人工核对，不静默降级')
  }
  assertPlanSnapshot(item, input.expected)
  const history = summarizePlanTime(item, latest)
  if (endedSessionsForPlan(latest, item).length > 0) assertPlanHistoryConfirm(history, input.historyConfirm)
  else if (input.historyConfirm != null) {
    fail('HISTORY_CHANGED', '该安排没有已结束历史，确认摘要必须为空', { current: historySignature(history), confirmed: input.historyConfirm })
  }
  return item
}

// 本事务新产生的结束事实：临时视图替换原会话后全量重算（禁止「旧累计 += 本段」）。
function planProgressDraft(item, endedDraft, latest, progress) {
  const next = summarizePlanTime(item, withDocs(latest, [endedDraft]))
  if (!next.authoritative) {
    fail('HISTORY_UNRESOLVED', '历史用时记录存在异常，无法生成权威摘要；请先核对处理，输入保留', { problems: next.problems })
  }
  return {
    planDraft: { ...item, state: progress, actual_minutes: next.actualMinutes, focus_session_id: next.latestEndedSessionId },
    history: next,
  }
}

function assertOwner(rt, e, epoch) {
  if (!rt) fail('OWNER_CONFLICT', '会话协调记录缺失，无法操作')
  if (rt.owner_id !== e.ownerId || rt.epoch !== epoch) {
    fail('OWNER_CONFLICT', '会话已由其它页面持有或已被接管', { holder: { owner_id: rt.owner_id, epoch: rt.epoch } })
  }
}
function assertHolder(rt, e, epoch) {
  assertOwner(rt, e, epoch)
  if (rt.recovery) fail('RECOVERY_REQUIRED', '会话待恢复确认，请先核对离线时段', { recovery: rt.recovery })
}
// 租约过期后原持有者不得直接写入/续租：须走 takeover（ epoch+1 ）+ recover 的受控重取流程。
// 在结算异常分支之后调用：异常时段仍先进恢复确认（不续租不累计），正常写入前才拦过期租约。
function assertLease(rt, e) {
  if (rt.lease_expires_at <= e.wallMs) {
    fail('OWNER_CONFLICT', '会话租约已过期，请先接管并恢复确认后再写入', {
      holder: { owner_id: rt.owner_id, epoch: rt.epoch }, leaseExpired: true, lease_expires_at: rt.lease_expires_at,
    })
  }
}

// 结算共用异常检测：时钟回拨 / 明显跳变 / 距上次检查点过久（休眠、失联、后台节流）。
// 命中则不结算，返回待用户核对的原始间隔（回拨时 pending_ms 为负，如实保留）。
function settleRunning(session, rt, e) {
  if (!session.running) return { accumulatedMs: session.accumulated_ms, recovery: null }
  const anchorMs = Date.parse(session.timer_anchor_at)
  const delta = e.wallMs - anchorMs
  const gap = rt && rt.last_checkpoint_at != null ? e.wallMs - rt.last_checkpoint_at : null
  let reason = null
  if (Number.isNaN(anchorMs) || delta < 0) reason = 'clock_rollback'
  else if (delta > e.params.JUMP_THRESHOLD_MS) reason = 'time_jump'
  else if (gap != null && gap > e.params.STALE_GAP_MS) reason = 'stale_gap'
  if (reason) {
    return { accumulatedMs: session.accumulated_ms, recovery: { reason, since: session.timer_anchor_at, pending_ms: delta } }
  }
  return { accumulatedMs: session.accumulated_ms + delta, recovery: null }
}

function recoveryPlan(rt, e, recovery) {
  const rtDraft = { ...rt, recovery, revision: rt.revision + 1, updated_at: e.wallMs }
  return { puts: [], deletes: [], runtimePuts: [rtDraft], runtimeDeletes: [], info: { code: 'RECOVERY_REQUIRED', recovery, runtime: rtDraft } }
}

// 操作入口共用：会话存在、未结束、v1、持有者有效。
function activeSession(latest, runtime, e, input, { needHolder = true } = {}) {
  const session = findSession(latest, input.sessionId)
  if (!session) fail('RELATION_INVALID', '会话不存在')
  if (!isUnfinished(session)) fail('ALREADY_ENDED', '会话已结束，正文与结果只读')
  if (recordVersion(session) === 0) fail('LEGACY_RECOVERY_REQUIRED', '旧版未结束会话请先显式结束', { session })
  const rt = sessRtOf(runtime, session.id)
  if (needHolder) assertHolder(rt, e, input.epoch)
  else assertOwner(rt, e, input.epoch)
  return { session, rt }
}

function renewedRt(rt, e, extra) {
  return { ...rt, lease_expires_at: e.wallMs + e.params.LEASE_MS, last_checkpoint_at: e.wallMs, revision: rt.revision + 1, updated_at: e.wallMs, ...extra }
}

// 草稿写入协议：编辑序号在生成/排队前分配或捕获，事务内验证；较旧修订 STALE_REVISION 且零正文写入。
// 绝不在事务里按到达顺序给旧文本重新赋新版本。expectedRevision 可选，附带则须等于当前协调修订。
// 暂停/继续合并最后草稿与结束最终草稿共用同一前提。
function assertDraftProtocol(rt, input) {
  if (!Number.isInteger(input.draftSeq) || input.draftSeq < 1) {
    fail('RELATION_INVALID', '草稿写入必须携带正整数编辑序号', { currentSeq: rt.draft_seq, currentRevision: rt.revision })
  }
  if (input.expectedRevision != null && input.expectedRevision !== rt.revision) {
    fail('STALE_REVISION', '编辑基于的修订已过期，不覆盖新正文', { currentSeq: rt.draft_seq, currentRevision: rt.revision })
  }
  if (input.draftSeq <= rt.draft_seq) {
    fail('STALE_REVISION', '草稿序号已过期，不覆盖新正文', { currentSeq: rt.draft_seq, currentRevision: rt.revision })
  }
}

export function beginPlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  // 同安排已有未结束会话（含暂停）：事务内返回稳定会话 ID 供回到工作，零创建。
  // 先于资格/事实校验——即使安排事实已变，回到真实会话仍是安全动作；不自动继续计时。
  if (input.planItemId) {
    const existing = existingUnfinishedSessionForPlan(latest, input.planItemId)
    if (existing) return emptyPlan({ code: 'PLAN_SESSION_EXISTS', session: existing, samePlan: true })
  }
  const task = findTask(latest, input.taskId)
  if (!task) fail('RELATION_INVALID', '任务不存在，无法开始专注')
  if (task.status === 'done') fail('RELATION_INVALID', '已完成任务不能开始专注')
  if (task.status === 'blocked' && input.confirmBlocked !== true) {
    fail('RELATION_INVALID', '任务处于受阻状态，需显式确认后才能开始', { needsConfirmBlocked: true })
  }
  const action = findAction(latest, input.actionId)
  if (!action || action.task_id !== task.id) fail('RELATION_INVALID', '行动不存在或不属于该任务')
  if (action.done) fail('RELATION_INVALID', '已完成的行动不能开始专注')
  // 全局互斥看全库真实会话（env.allDocs 为事务内未过滤 docs），不只本空间、不只 runtime 索引：
  // 旧版会话可能没有 runtime 元数据，漏扫会导致全库同时出现两份运行会话。
  for (const s of sessionsOf(env.allDocs || latest)) {
    if (!isUnfinished(s)) continue
    if (s.workspace_id === e.ws) {
      if (recordVersion(s) === 0) fail('LEGACY_RECOVERY_REQUIRED', '存在旧版未结束会话，请先显式结束', { session: s })
      fail('ALREADY_ACTIVE', '本工作区已有未结束会话（含暂停）', { session: s })
    }
    if (!s.running) continue
    if (recordVersion(s) === 0) fail('LEGACY_RECOVERY_REQUIRED', '其它工作区存在旧版运行会话，请先显式结束', { session: s })
    fail('ALREADY_ACTIVE', '其它工作区已有运行中的会话', { session: s })
  }
  if (anyRunning(runtime)) {
    fail('ALREADY_ACTIVE', '其它工作区已有运行中的会话', { running: runtime.filter((r) => r.kind === 'running' && r.session_id) })
  }
  let planItemId = null
  if (input.planItemId) {
    // 执行资格按 ID 校验（不按 action_text 绑定）；快照与确认事实事务内重核，变化零创建。
    const { planItem } = assertPlanExecutable(latest, input.planItemId, action.id)
    if (input.expected == null || input.facts == null) {
      fail('PLAN_CONFIRM_REQUIRED', '从安排开始必须携带冻结的安排快照与确认事实')
    }
    assertPlanSnapshot(planItem, input.expected)
    if (input.facts.actionId !== action.id) fail('PLAN_CONFIRM_REQUIRED', '确认事实与所选行动不一致，请重新选择行动')
    const diffs = beginFactsDiff(input.facts, beginFactsOf(task, action, beijingDateStr(new Date(e.wallMs))))
    if (diffs.length) fail('BEGIN_FACTS_CHANGED', '确认期间行动/任务/日期事实已变化，请重新核对后再开始', { diffs })
    // 新建前历史前置核对（开工单§3.1，R3）：异常历史零创建，避免投入后结束才发现无法联动保存；
    // 旧 planned 已有结束历史先走人工进度核对，不当全新安排。不自动改旧状态/清摘要/重写历史。
    // 同安排未结束会话已在函数最前优先返回（回到工作不受此拦截影响）。
    const planHistory = summarizePlanTime(planItem, latest)
    if (!planHistory.authoritative) fail('HISTORY_UNRESOLVED', '该安排的历史用时记录存在异常，请先核对处理后再开始', { problems: planHistory.problems })
    if (planItem.state === 'planned' && planHistory.endedSessionCount > 0) {
      fail('PLAN_REVIEW_REQUIRED', '该安排仍为待执行但已有结束历史，请先人工核对进度后再开始', { history: historySignature(planHistory) })
    }
    planItemId = planItem.id
  }
  const matter = task.matter_id ? latest.find((d) => d.id === task.matter_id && d.kind === 'matter') : null
  const id = e.newId()
  const session = {
    id, kind: 'focus_session', workspace_id: e.ws,
    task_id: task.id, action_id: action.id, plan_item_id: planItemId,
    started_at: e.wallNow, accumulated_ms: 0, running: true, draft_md: '',
    outcome: null, blocker: null, ended_at: null, is_demo: e.isDemo,
    record_version: 1, timer_anchor_at: e.wallNow,
    task_snapshot: {
      title: task.title, matter_name: matter ? matter.title : null,
      deadline_value: task.deadline ? task.deadline.value : null,
      deadline_precision: task.deadline ? task.deadline.precision : 'none',
      captured_at: e.wallNow,
    },
    action_snapshot: { text: action.text, minutes: action.minutes, captured_at: e.wallNow },
    task_ref_state: 'active', action_ref_state: 'active',
  }
  const taskDraft = { ...task, status: 'doing', current_action_id: action.id, updated_at: e.wallNow }
  const rt = makeSessionRuntime({ sessionId: id, workspaceId: e.ws, ownerId: e.ownerId, nowMs: e.wallMs, leaseMs: e.params.LEASE_MS })
  const run = makeRunRecord(e.ws, id, e.wallMs)
  return { puts: [session, taskDraft], deletes: [], runtimePuts: [rt, run], runtimeDeletes: [], info: { session, task: taskDraft, runtime: rt } }
}

export function checkpointPlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  const { session, rt } = activeSession(latest, runtime, e, input)
  const { accumulatedMs, recovery } = settleRunning(session, rt, e)
  if (recovery) return recoveryPlan(rt, e, recovery)
  assertLease(rt, e)
  const puts = session.running ? [{ ...session, accumulated_ms: accumulatedMs, timer_anchor_at: e.wallNow }] : []
  const rtDraft = renewedRt(rt, e)
  return { puts, deletes: [], runtimePuts: [rtDraft], runtimeDeletes: [], info: { session: puts[0] || session, runtime: rtDraft } }
}

export function pausePlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  const { session, rt } = activeSession(latest, runtime, e, input)
  if (!session.running) {
    assertLease(rt, e)
    const rtDraft = renewedRt(rt, e)
    return { puts: [], deletes: [], runtimePuts: [rtDraft], runtimeDeletes: [], info: { session, runtime: rtDraft, alreadyPaused: true } }
  }
  const { accumulatedMs, recovery } = settleRunning(session, rt, e)
  if (recovery) return recoveryPlan(rt, e, recovery)
  assertLease(rt, e)
  const draft = { ...session, accumulated_ms: accumulatedMs, running: false, timer_anchor_at: null }
  const runtimePuts = [renewedRt(rt, e)]
  const run = runOf(runtime, e.ws)
  if (run && run.session_id === session.id) runtimePuts.push(makeRunRecord(e.ws, null, e.wallMs))
  return { puts: [draft], deletes: [], runtimePuts, runtimeDeletes: [], info: { session: draft, runtime: runtimePuts[0] } }
}

export function resumePlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  const { session, rt } = activeSession(latest, runtime, e, input)
  if (session.running) {
    assertLease(rt, e)
    const rtDraft = renewedRt(rt, e)
    return { puts: [], deletes: [], runtimePuts: [rtDraft], runtimeDeletes: [], info: { session, runtime: rtDraft, alreadyRunning: true } }
  }
  const task = findTask(latest, session.task_id)
  const action = findAction(latest, session.action_id)
  if (!task || !action || action.task_id !== task.id || action.done || task.status === 'done') {
    fail('RELATION_INVALID', '任务或行动已失效，不能继续该会话')
  }
  if (session.task_ref_state !== 'active' || session.action_ref_state !== 'active') {
    fail('RELATION_INVALID', '会话引用已断开，不能继续')
  }
  for (const s of sessionsOf(env.allDocs || latest)) {
    if (s.id === session.id || !isUnfinished(s) || !s.running) continue
    if (recordVersion(s) === 0) fail('LEGACY_RECOVERY_REQUIRED', '存在旧版运行会话，请先显式结束', { session: s })
    fail('ALREADY_ACTIVE', '已有其它运行中的会话，不能继续', { session: s })
  }
  if (anyRunning(runtime, session.id)) fail('ALREADY_ACTIVE', '已有其它运行中的会话，不能继续')
  assertLease(rt, e)
  const draft = { ...session, running: true, timer_anchor_at: e.wallNow }
  const runtimePuts = [renewedRt(rt, e), makeRunRecord(e.ws, session.id, e.wallMs)]
  return { puts: [draft], deletes: [], runtimePuts, runtimeDeletes: [], info: { session: draft, runtime: runtimePuts[0] } }
}

export function endPlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  const { session, rt } = activeSession(latest, runtime, e, input)
  if (!FOCUS_OUTCOMES.includes(input.outcome)) fail('RELATION_INVALID', '结束结果必须是 done/partial/blocked')
  if (input.outcome === 'blocked' && !String(input.blocker || '').trim()) fail('RELATION_INVALID', '受阻结束必须填写阻塞说明')
  if (typeof input.draftMd !== 'string') fail('RELATION_INVALID', '结束必须提交最终草稿')
  if (input.planItemId != null) fail('RELATION_INVALID', '结束不接受改挂安排；安排身份来自会话本身的 plan_item_id')
  assertDraftProtocol(rt, input)
  const { accumulatedMs, recovery } = settleRunning(session, rt, e)
  if (recovery) return recoveryPlan(rt, e, recovery)
  assertLease(rt, e)
  // 计划联动校验先于写集构造：安排归属/活状态/快照/旧历史（不含本段）任一不符即零写入。
  let planItem = null
  if (session.plan_item_id != null) {
    planItem = assertPlanEndLink(latest, session, e.ws, input)
  } else if (input.planProgress != null || input.expected != null || input.historyConfirm != null) {
    fail('PLAN_LINK_INVALID', '独立工作会话未关联安排，不能提交安排进度')
  }
  const ended = {
    ...session, draft_md: input.draftMd, accumulated_ms: accumulatedMs,
    running: false, timer_anchor_at: null, outcome: input.outcome,
    blocker: input.outcome === 'blocked' ? String(input.blocker).trim() : null,
    ended_at: e.wallNow,
  }
  const puts = [ended]
  let planDraft = null
  let history = null
  if (planItem) {
    const r = planProgressDraft(planItem, ended, latest, input.planProgress)
    planDraft = r.planDraft
    history = r.history
    puts.push(planDraft)
  }
  let actionDraft = null
  let taskDraft = null
  if (input.outcome === 'done') {
    // 行动完成是结束表单的显式选择：专用原子路径，不受通用完成保护反阻；任务不自动完成。
    const action = findAction(latest, session.action_id)
    if (action) {
      actionDraft = { ...action, done: true }
      puts.push(actionDraft)
    }
    const task = findTask(latest, session.task_id)
    if (task && task.current_action_id === session.action_id) {
      taskDraft = { ...task, current_action_id: null, updated_at: e.wallNow }
      puts.push(taskDraft)
    }
  }
  const runtimePuts = [renewedRt(rt, e, { ended: true, recovery: null, draft_seq: input.draftSeq })]
  const run = runOf(runtime, e.ws)
  if (run && run.session_id === session.id) runtimePuts.push(makeRunRecord(e.ws, null, e.wallMs))
  return { puts, deletes: [], runtimePuts, runtimeDeletes: [], info: { session: ended, action: actionDraft, task: taskDraft, planItem: planDraft, history, runtime: runtimePuts[0] } }
}

export function saveDraftPlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  const { session, rt } = activeSession(latest, runtime, e, input)
  assertDraftProtocol(rt, input)
  if (typeof input.draftMd !== 'string') fail('RELATION_INVALID', '草稿必须是文本')
  const { accumulatedMs, recovery } = settleRunning(session, rt, e)
  if (recovery) return recoveryPlan(rt, e, recovery)
  assertLease(rt, e)
  const draft = { ...session, draft_md: input.draftMd, accumulated_ms: accumulatedMs, timer_anchor_at: session.running ? e.wallNow : null }
  const rtDraft = renewedRt(rt, e, { draft_seq: input.draftSeq })
  return { puts: [draft], deletes: [], runtimePuts: [rtDraft], runtimeDeletes: [], info: { session: draft, runtime: rtDraft } }
}

export function recoverPlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  const { session, rt } = activeSession(latest, runtime, e, input, { needHolder: false })
  if (!rt.recovery) fail('RELATION_INVALID', '会话没有待恢复确认的时段')
  let accumulatedMs = session.accumulated_ms
  if (input.mode === 'correct') {
    if (!Number.isInteger(input.correctedMs) || input.correctedMs < 0) fail('RELATION_INVALID', '修正累计必须为非负整数毫秒')
    accumulatedMs = input.correctedMs
  } else if (input.mode !== 'keep') {
    fail('RELATION_INVALID', '恢复选择必须是 keep 或 correct')
  }
  const draft = session.running
    ? { ...session, accumulated_ms: accumulatedMs, timer_anchor_at: e.wallNow }
    : { ...session, accumulated_ms: accumulatedMs }
  const lastRecovery = input.mode === 'correct'
    ? { mode: input.mode, accumulated_ms: accumulatedMs, at_ms: e.wallMs, origin: 'user' }
    : { mode: input.mode, accumulated_ms: accumulatedMs, at_ms: e.wallMs }
  const rtDraft = renewedRt(rt, e, { recovery: null, last_recovery: lastRecovery })
  return { puts: [draft], deletes: [], runtimePuts: [rtDraft], runtimeDeletes: [], info: { session: draft, runtime: rtDraft } }
}

export function takeoverPlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  const session = findSession(latest, input.sessionId)
  if (!session) fail('RELATION_INVALID', '会话不存在')
  if (!isUnfinished(session)) fail('ALREADY_ENDED', '会话已结束，无需接管')
  if (recordVersion(session) === 0) fail('LEGACY_RECOVERY_REQUIRED', '旧版未结束会话请先显式结束', { session })
  const rt = sessRtOf(runtime, session.id)
  if (!rt) fail('OWNER_CONFLICT', '会话协调记录缺失，无法接管')
  if (rt.lease_expires_at > e.wallMs) {
    fail('OWNER_CONFLICT', '会话租约仍有效，其它页面只读', { holder: { owner_id: rt.owner_id, epoch: rt.epoch }, lease_expires_at: rt.lease_expires_at })
  }
  const recovery = {
    reason: 'takeover',
    since: session.timer_anchor_at || session.started_at,
    pending_ms: session.running ? e.wallMs - Date.parse(session.timer_anchor_at) : 0,
  }
  const rtDraft = renewedRt(rt, e, { owner_id: e.ownerId, epoch: rt.epoch + 1, recovery })
  return { puts: [], deletes: [], runtimePuts: [rtDraft], runtimeDeletes: [], info: { session, runtime: rtDraft, recovery } }
}

// v0 遗留未结束会话的显式结束：只更新 v0 已有字段，不补快照/锚点/引用状态等新字段。
// 旧引用缺失不阻碍结束遗留草稿；释放其占用的运行位置。
// 5A-2A：关联有效活安排时须显式安排结果，同一事务更新安排摘要/进度（不升版本、不触碰 Action）；
// 关联异常保留原「显式结束释放占用」通路——这是遗留修复分支，不是正常 v1 结束失败的降级通道。
export function legacyEndPlan(latest, runtime, env, input) {
  const e = resolveEnv(env)
  const session = findSession(latest, input.sessionId)
  if (!session) fail('RELATION_INVALID', '会话不存在')
  if (!isUnfinished(session)) fail('ALREADY_ENDED', '会话已结束')
  if (recordVersion(session) === 1) fail('RELATION_INVALID', '新版会话请走正常结束流程')
  if (!FOCUS_OUTCOMES.includes(input.outcome)) fail('RELATION_INVALID', '结束结果必须是 done/partial/blocked')
  if (input.outcome === 'blocked' && !String(input.blocker || '').trim()) fail('RELATION_INVALID', '受阻结束必须填写阻塞说明')
  const accumulatedMs = input.accumulatedMs == null ? session.accumulated_ms : input.accumulatedMs
  if (!Number.isInteger(accumulatedMs) || accumulatedMs < 0) fail('RELATION_INVALID', '确认累计必须为非负整数毫秒')
  const hasPlanInput = input.planProgress != null || input.expected != null || input.historyConfirm != null
  let planItem = null
  if (session.plan_item_id != null) {
    const item = latest.find((d) => d.id === session.plan_item_id && d.kind === 'plan_item')
    const linkLive = !!item && item.workspace_id === e.ws && item.task_id === session.task_id
      && isLiveRef(item) && LIVE_PLAN_STATES.includes(item.state)
    if (linkLive) {
      planItem = assertPlanEndLink(latest, session, e.ws, input)
    } else if (hasPlanInput) {
      fail('PLAN_LINK_INVALID', '遗留会话的安排关联缺失或已终态，无法联动安排；可不带安排参数显式结束释放占用，之后人工核对')
    }
  } else if (hasPlanInput) {
    fail('PLAN_LINK_INVALID', '会话未关联安排，不能提交安排进度')
  }
  const draft = {
    ...session, accumulated_ms: accumulatedMs, running: false, outcome: input.outcome,
    blocker: input.outcome === 'blocked' ? String(input.blocker).trim() : null, ended_at: e.wallNow,
  }
  const puts = [draft]
  let planDraft = null
  let history = null
  if (planItem) {
    const r = planProgressDraft(planItem, draft, latest, input.planProgress)
    planDraft = r.planDraft
    history = r.history
    puts.push(planDraft)
  }
  const runtimePuts = []
  for (const r of runtime) {
    if (r.kind === 'running' && r.session_id === session.id) runtimePuts.push(makeRunRecord(r.workspace_id, null, e.wallMs))
  }
  return { puts, deletes: [], runtimePuts, runtimeDeletes: [], info: { session: draft, planItem: planDraft, history } }
}

// —— S6 删除/完成保护与关系补丁（纯谓词，接线在 action.js/matter.js）——

// 受影响 task/action × 全量会话：任一未结束（含暂停、含 v0）命中即须先处理会话。
export function unfinishedSessionsFor(latest, { taskIds = [], actionIds = [] } = {}) {
  const t = new Set(taskIds)
  const a = new Set(actionIds)
  return sessionsOf(latest).filter((s) => isUnfinished(s) && (t.has(s.task_id) || a.has(s.action_id)))
}

export function assertNoUnfinishedSession(latest, refs) {
  const hits = unfinishedSessionsFor(latest, refs)
  if (hits.length) fail('RELATION_INVALID', '先处理进行中的专注会话（含暂停），再删除或完成关联对象', { sessions: hits })
}

// 已结束会话的逐引用断开：只改 ref_state，正文/累计/快照保留；v0 无引用字段不动。
export function refDeletePatches(latest, { taskIds = [], actionIds = [] } = {}) {
  const t = new Set(taskIds)
  const a = new Set(actionIds)
  const puts = []
  const patches = []
  for (const s of sessionsOf(latest)) {
    if (isUnfinished(s) || recordVersion(s) !== 1) continue
    const changes = {}
    if (t.has(s.task_id) && s.task_ref_state !== 'deleted') changes.task_ref_state = { from: s.task_ref_state, to: 'deleted' }
    if (a.has(s.action_id) && s.action_ref_state !== 'deleted') changes.action_ref_state = { from: s.action_ref_state, to: 'deleted' }
    if (!Object.keys(changes).length) continue
    const draft = { ...s }
    for (const field of Object.keys(changes)) draft[field] = 'deleted'
    puts.push(draft)
    patches.push({ session_id: s.id, ended_at: s.ended_at, changes })
  }
  return { puts, patches }
}

// 撤销恢复：逐条核对——字段仍是删除时置的 deleted、ended_at 未变、引用对象已恢复，才回补原状态；
// 否则保持 deleted，不产生新悬空活引用，不整体覆盖历史。
export function refRestorePatches(latest, patches) {
  const puts = []
  const applied = []
  const refused = []
  for (const p of patches || []) {
    const s = findSession(latest, p.session_id)
    if (!s) { refused.push({ session_id: p.session_id, reason: 'missing' }); continue }
    if (s.ended_at !== p.ended_at) { refused.push({ session_id: p.session_id, reason: 'changed' }); continue }
    const draft = { ...s }
    let changed = false
    for (const [field, ch] of Object.entries(p.changes)) {
      if (s[field] !== ch.to) { refused.push({ session_id: s.id, field, reason: 'changed' }); continue }
      const refId = field === 'task_ref_state' ? s.task_id : s.action_id
      const kind = field === 'task_ref_state' ? 'task' : 'action'
      if (!latest.some((d) => d.id === refId && d.kind === kind)) { refused.push({ session_id: s.id, field, reason: 'still_missing' }); continue }
      draft[field] = ch.from
      changed = true
      applied.push({ session_id: s.id, field, from: ch.to, to: ch.from })
    }
    if (changed) puts.push(draft)
  }
  return { puts, applied, refused }
}