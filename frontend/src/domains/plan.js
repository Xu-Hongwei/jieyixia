// 每日安排（契约 PlanItem 0.4.0）的纯领域规则：字段/资格校验、状态命令、日期排序、
// 截止风险派生、实际用时汇总、待安排分类、执行资格校验。不触库、不依赖 Vue。
// 每个命令 plan 接收事务内最新 docs（按捕获空间过滤）与 env={ws,wallNow,newId}，
// 返回 { puts, deletes, info }；抛错即整体回滚。info.code 表示「零写入的业务拒绝」。
// 三个对象分清：Task=最终完成什么/何时交；PlanItem=哪天准备做什么/预计多久；
// FocusSession=实际执行了什么/成果/用时。安排保存绝不回写 Task.current_action_id/status/deadline/便签。
// PlanItem 无 action_id：action_text 是工作说明，不是行动身份，绝不按文字绑定 Action。
import { beijingDateStr, beijingParts, interpretEventInstant, interpretInstant, isOverdue, isValidDate } from './time'

export const PLAN_STATES = ['planned', 'done', 'partial', 'moved', 'cancelled']
// 活安排：仍可执行/可确认进度的状态。done/cancelled/moved 是终态历史，不重开、不覆盖编辑。
export const LIVE_PLAN_STATES = ['planned', 'partial']
const TERMINAL_STATES = ['done', 'cancelled', 'moved']

const fail = (code, message, extra) => {
  throw Object.assign(new Error(message), { code }, extra || {})
}
const findDoc = (latest, id, kind) => latest.find((d) => d.id === id && d.kind === kind)
const findPlan = (latest, id) => findDoc(latest, id, 'plan_item')

// task_ref_state 缺省 active（契约旧记录兼容）；deleted 后 task_id 只是历史标识。
export const isLiveRef = (p) => (p.task_ref_state || 'active') !== 'deleted'
export const isActivePlan = (p) => isLiveRef(p) && LIVE_PLAN_STATES.includes(p.state)
const taskUnfinished = (t) => !!t && t.status !== 'done'

// —— 字段校验（第 4 节）——
export function cleanActionText(v) {
  if (typeof v !== 'string') fail('INVALID_FIELD', '工作说明必须是文本')
  const t = v.trim()
  if (!t) fail('INVALID_FIELD', '工作说明去首尾空白后不能为空')
  return t
}
export function cleanPlannedMinutes(v) {
  // 有限安全正整数：拒绝 0/负/小数/NaN/Infinity/非数值。UI 字符串转换留给 5A-1。
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isSafeInteger(v) || v <= 0) {
    fail('INVALID_MINUTES', '预计分钟必须是有限安全正整数')
  }
  return v
}
export function cleanDate(v) {
  // 严格真实 YYYY-MM-DD：拒绝 2026-02-30 等非法日，不自动滚动修正。
  if (typeof v !== 'string' || !isValidDate(v)) fail('INVALID_DATE', '安排日期必须是真实的 YYYY-MM-DD')
  return v
}

// —— 真实会话决定历史保护（5.1）——
// 判断依据：同空间、同任务、plan_item_id 命中的 FocusSession 集合；不看快捷 focus_session_id/actual_minutes。
export function sessionsForPlan(docs, p) {
  return docs.filter(
    (d) => d.kind === 'focus_session' && d.workspace_id === p.workspace_id && d.task_id === p.task_id && d.plan_item_id === p.id,
  )
}
export const unfinishedSessionsForPlan = (docs, p) => sessionsForPlan(docs, p).filter((s) => s.ended_at == null)
export const endedSessionsForPlan = (docs, p) => sessionsForPlan(docs, p).filter((s) => s.ended_at != null)

function assertNoUnfinishedPlan(docs, p) {
  const hits = unfinishedSessionsForPlan(docs, p)
  if (hits.length) {
    fail('UNFINISHED_FOCUS', '该安排有未结束的工作会话（含暂停/恢复待核对），请先处理后再变更', { sessionIds: hits.map((s) => s.id) })
  }
}
function assertNoPlanHistory(docs, p) {
  const hits = endedSessionsForPlan(docs, p)
  if (hits.length) {
    fail('PLAN_HAS_HISTORY', '该安排已有工作记录，请保留原日期；后续工作可另安排一天', { sessionIds: hits.map((s) => s.id) })
  }
}

// —— 相关字段并发保护（4.3）：白名单快照对比，不符 STALE_PLAN。不宣称检测所有历史/ABA。——
// 快照必须完整：除 task_ref_state 可按契约缺省 active 规范化外，缺任何必需字段都拒绝——
// 空对象/缺字段无法证明用户核对的是哪一版事实，绝不允许绕过并发检查。
export const SNAPSHOT_FIELDS = ['task_id', 'date', 'state', 'action_text', 'planned_minutes', 'task_ref_state']
// UI 回传 expected 的唯一构造口：与事务内校验同字段同缺省，避免页面自造第二套快照规则。
export const planSnapshot = (p) =>
  Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, f === 'task_ref_state' ? p.task_ref_state || 'active' : p[f]]))
// 完整差异清单：回执只报首个不同字段，但确认框必须列出本次提交 expected 与开框冻结快照之间的全部变化，
// 否则未列出的字段会随整份快照一起获准（旧草稿覆盖未提示的新事实）。
export const planSnapshotDiff = (expected, frozen) =>
  SNAPSHOT_FIELDS.filter((f) => expected[f] !== frozen[f]).map((f) => ({ field: f, expected: expected[f], current: frozen[f] }))
function assertSnapshot(item, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    fail('STALE_PLAN', '变更必须携带用户当时看到的相关字段快照')
  }
  for (const f of SNAPSHOT_FIELDS) {
    const want = f === 'task_ref_state' ? (expected[f] ?? 'active') : expected[f]
    if (want === undefined) fail('STALE_PLAN', `快照缺少必需字段 ${f}，无法证明核对的是哪一版事实`, { field: f })
    const cur = f === 'task_ref_state' ? (item.task_ref_state || 'active') : item[f]
    if (cur !== want) fail('STALE_PLAN', '安排已被其它页面修改，请刷新后重新核对', { field: f, expected: want, current: cur })
  }
}

// —— 变更命令统一的 Task 资格断言（4.3）：同空间存在且未完成。——
// 不能仅凭 plan.task_ref_state=active 推断 Task 仍未完成；缺失 Task 的活引用残留同样拒绝。
function assertTaskMutable(latest, item, ws) {
  const task = findDoc(latest, item.task_id, 'task')
  if (!task || task.workspace_id !== ws) fail('RELATION_INVALID', '安排所属任务不存在或跨空间，历史只读')
  if (!taskUnfinished(task)) fail('TASK_DONE', '已完成任务的安排是历史，不能变更；继续工作请另建安排')
  return task
}

// —— 顺序（5.2）：同空间同 date 按 order 升序、再按 ID 稳定排序。——
export function sortPlanItems(items) {
  return [...items].sort((a, b) => {
    const ao = Number.isInteger(a.order) ? a.order : 0
    const bo = Number.isInteger(b.order) ? b.order : 0
    if (ao !== bo) return ao - bo
    return String(a.id).localeCompare(String(b.id))
  })
}
// 新建/跨日改期追加到目标日现有最大有效 order 之后；其它记录不批量改号。缺省 order 按 0。
function nextOrder(latest, ws, date) {
  let max = 0
  for (const d of latest) {
    if (d.kind !== 'plan_item' || d.workspace_id !== ws || d.date !== date || !isLiveRef(d)) continue
    const o = Number.isInteger(d.order) ? d.order : 0
    if (o > max) max = o
  }
  return max + 1
}

// —— 截止风险（第 8 节）：只读派生，不落新业务字段，不自动移动安排/改 Task.deadline。——
// 先后关系与 overdue 是两个独立维度，允许同时存在。返回所依据的截止值/精度与安排日供确认回传。
export function planRisk(task, dateStr, nowD = new Date()) {
  const dl = task && task.deadline
  const overdue = task ? isOverdue(task, nowD) : false
  if (!dl || !dl.value || dl.precision === 'none') {
    return { kind: 'no_deadline', deadlineValue: null, deadlinePrecision: 'none', deadlineDay: null, deadlineMinutes: null, planDate: dateStr, overdue }
  }
  const ms = interpretInstant(dl.value)
  if (ms == null) {
    return { kind: 'no_deadline', deadlineValue: dl.value, deadlinePrecision: dl.precision, deadlineDay: null, deadlineMinutes: null, planDate: dateStr, overdue }
  }
  const b = beijingParts(ms)
  const day = beijingDateStr(ms)
  const hasClock = dl.precision === 'datetime' || /T\d{2}:\d{2}/.test(dl.value)
  const minutes = hasClock ? b.hour * 60 + b.minute : null
  let kind
  if (dateStr < day) kind = 'before_deadline'
  else if (dateStr > day) kind = 'after_deadline'
  else kind = hasClock ? 'due_same_day_timed' : 'due_same_day'
  return { kind, deadlineValue: dl.value, deadlinePrecision: dl.precision, deadlineDay: day, deadlineMinutes: minutes, planDate: dateStr, overdue }
}

// 确认依据校验：回传的截止事实与事务内最新不符 → DEADLINE_CHANGED 要求重新核对。
function assertDeadlineConfirm(task, dateStr, confirm) {
  const dl = task.deadline || { value: null, precision: 'none' }
  const value = dl.value == null ? null : dl.value
  const precision = dl.precision || 'none'
  if (confirm.value !== value || confirm.precision !== precision || confirm.planDate !== dateStr) {
    fail('DEADLINE_CHANGED', '任务截止或安排日已变化，请重新核对截止风险后再确认', {
      current: { value, precision, planDate: dateStr }, confirmed: confirm,
    })
  }
}
// 超截止安排创建/改期必须明确确认；确认输入是事实对象（截止值/精度/安排日），不是任意布尔。
// nowD 用注入时钟（env.wallNow），不依赖设备当前时间，受控测试可复现。
function requireAfterDeadlineConfirm(task, dateStr, input, nowD) {
  const risk = planRisk(task, dateStr, nowD)
  if (input.deadlineConfirm) {
    assertDeadlineConfirm(task, dateStr, input.deadlineConfirm)
  } else if (risk.kind === 'after_deadline') {
    fail('AFTER_DEADLINE_UNCONFIRMED', '安排日晚于任务截止，需明确确认截止风险后才能保存', { risk })
  }
  return risk
}

// —— 实际用时纯汇总（9.1）：只纳入同空间同 Task、plan_item_id 正确且 ended_at 非空的会话，按 ID 去重。——
export function historySignature(summary) {
  return {
    endedSessionIds: [...summary.endedSessionIds].sort(),
    totalMs: summary.totalMs,
    actualMinutes: summary.actualMinutes,
    latestEndedSessionId: summary.latestEndedSessionId,
  }
}
export function summarizePlanTime(planItem, docs) {
  const ended = endedSessionsForPlan(docs, planItem)
  const problems = []
  // 相同 ID 冲突数据：整组排除（不任取首条参与权威累计），结果与输入顺序无关。
  const byId = new Map()
  const conflicted = new Set()
  for (const s of ended) {
    const prev = byId.get(s.id)
    if (prev) {
      if (prev.accumulated_ms !== s.accumulated_ms || prev.ended_at !== s.ended_at) conflicted.add(s.id)
      continue
    }
    byId.set(s.id, s)
  }
  for (const id of [...conflicted].sort()) problems.push({ code: 'CONFLICTING_SESSION', sessionId: id })
  const valid = []
  for (const s of byId.values()) {
    if (conflicted.has(s.id)) continue
    if (!Number.isInteger(s.accumulated_ms) || s.accumulated_ms < 0) {
      problems.push({ code: 'INVALID_DURATION', sessionId: s.id, accumulatedMs: s.accumulated_ms })
      continue
    }
    // 事件时间用契约同口径解析（支持 toISOString 的小数秒）；截止输入规则不放宽。
    if (interpretEventInstant(s.ended_at) == null) {
      problems.push({ code: 'INVALID_ENDED_AT', sessionId: s.id })
      continue
    }
    valid.push(s)
  }
  const totalMs = valid.reduce((n, s) => n + s.accumulated_ms, 0)
  const endedSessionCount = valid.length
  // 存在影响权威结果的异常（冲突/非法时长/非法结束时间）时 authoritative=false：
  // 不生成可持久化结论（actualMinutes/latest 置 null），确认命令必须拒绝写入、保留原值。
  // 「全部解析失败」不等于「没有历史」——ended 非空而 valid 为空同样 authoritative=false。
  const authoritative = problems.length === 0
  // 先 sum 再 floor(totalMs/60000)，只取整一次。无已结束=null；有但不足一分钟=0。
  const actualMinutes = authoritative && endedSessionCount > 0 ? Math.floor(totalMs / 60000) : null
  // 最近已结束按 ended_at 真实瞬时排序，同刻按 ID 稳定决胜；不采用数组末项。
  let latest = null
  if (authoritative) {
    for (const s of valid) {
      const ms = interpretEventInstant(s.ended_at)
      if (latest == null || ms > latest.ms || (ms === latest.ms && String(s.id) > String(latest.id))) {
        latest = { id: s.id, ms }
      }
    }
  }
  const latestEndedSessionId = latest ? latest.id : null
  // 缓存与明细不一致诊断（只读提示，不自动修库）：仅在权威结果可用时比较。
  const cachedMinutes = planItem.actual_minutes ?? null
  const cachedSession = planItem.focus_session_id ?? null
  const cacheMismatch = authoritative && (cachedMinutes !== actualMinutes || cachedSession !== latestEndedSessionId)
    ? { cachedActualMinutes: cachedMinutes, computedActualMinutes: actualMinutes, cachedFocusSessionId: cachedSession, computedFocusSessionId: latestEndedSessionId }
    : null
  return {
    endedSessionCount, totalMs, actualMinutes, latestEndedSessionId,
    endedSessionIds: valid.map((s) => s.id),
    problems, authoritative, cacheMismatch,
  }
}
function assertHistoryConfirm(summary, confirm) {
  if (!summary.authoritative) {
    fail('HISTORY_UNRESOLVED', '历史用时记录存在异常（冲突/非法时长/非法结束时间），无法生成权威摘要；请先核对处理后再确认，原摘要保留', { problems: summary.problems })
  }
  if (!confirm || typeof confirm !== 'object') {
    fail('HISTORY_UNCONFIRMED', '该安排已有结束记录，确认前必须展示并回传完整历史摘要', { history: historySignature(summary) })
  }
  const want = historySignature(summary)
  const got = historySignature({
    endedSessionIds: confirm.endedSessionIds || [],
    totalMs: confirm.totalMs, actualMinutes: confirm.actualMinutes, latestEndedSessionId: confirm.latestEndedSessionId,
  })
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    fail('HISTORY_CHANGED', '安排的历史用时摘要已变化，请重新核对后再确认', { current: want, confirmed: got })
  }
}

// —— 待安排分类（第 7 节）：针对所有未完成 Task，读取该 Task 全量计划，不只看当前周。——
// 「尚未安排」不是「从未安排过」的历史断言；Task 已完成/删除不进入。未来已有安排也可能存在过去未处理项，
// 故另外输出过去未完成集合，不被单一分类隐藏。不自动把过期安排移到今天。
export function classifyUnscheduled(tasks, plans, nowD = new Date()) {
  const today = beijingDateStr(nowD)
  const entries = []
  const pastUnfinished = []
  for (const t of tasks) {
    if (t.kind !== 'task' || !taskUnfinished(t)) continue
    const live = plans.filter((p) => p.kind === 'plan_item' && p.task_id === t.id && p.workspace_id === t.workspace_id && isActivePlan(p))
    const future = live.filter((p) => p.date >= today)
    const past = live.filter((p) => p.date < today)
    const category = future.length ? 'scheduled' : past.length ? 'needs_continue' : 'unscheduled'
    entries.push({ taskId: t.id, category, futurePlanIds: sortPlanItems(future).map((p) => p.id), pastPlanIds: sortPlanItems(past).map((p) => p.id) })
    if (past.length) pastUnfinished.push({ taskId: t.id, planIds: sortPlanItems(past).map((p) => p.id) })
  }
  return {
    entries,
    scheduled: entries.filter((e) => e.category === 'scheduled').map((e) => e.taskId),
    needsContinue: entries.filter((e) => e.category === 'needs_continue').map((e) => e.taskId),
    unscheduled: entries.filter((e) => e.category === 'unscheduled').map((e) => e.taskId),
    pastUnfinished,
  }
}

// —— 执行资格校验（9.2）：纯校验，本批不接生产 focus.begin/end（5A-2 接入）。——
// 明确传入有效同 Task 未完成 Action；不通过 action_text 查 Action。done/cancelled/moved/deleted 不允许新开工作。
export function assertPlanExecutable(docs, planItemId, actionId) {
  const item = findPlan(docs, planItemId)
  if (!item) fail('RELATION_INVALID', '安排不存在')
  if (!isLiveRef(item)) fail('PLAN_NOT_EXECUTABLE', '安排的任务引用已断开（历史），不能开始工作')
  if (!LIVE_PLAN_STATES.includes(item.state)) fail('PLAN_NOT_EXECUTABLE', '已结束/取消/改期的安排不能开始工作；继续工作请另建安排')
  const task = findDoc(docs, item.task_id, 'task')
  if (!task || task.workspace_id !== item.workspace_id) fail('RELATION_INVALID', '安排所属任务不存在或跨空间')
  if (!taskUnfinished(task)) fail('TASK_DONE', '已完成任务不能开始工作')
  const action = findDoc(docs, actionId, 'action')
  if (!action || action.task_id !== task.id || action.workspace_id !== task.workspace_id) {
    fail('RELATION_INVALID', '行动不存在或不属于该任务（不按工作说明文字绑定行动）')
  }
  if (action.done) fail('ACTION_DONE', '已完成行动不能开始工作')
  return { planItem: item, task, action }
}
// 服务返回「已有同安排未结束会话」可供回到工作；回到暂停不等于自动继续。
export const existingUnfinishedSessionForPlan = (docs, planItemId) => {
  const item = findPlan(docs, planItemId)
  if (!item) return null
  return unfinishedSessionsForPlan(docs, item)[0] || null
}

// —— 状态命令（第 5 节）。每个命令只接受白名单字段，携带快照，事务内对比最新事实。——

// create：创建 planned，无任何 Focus 引用。ID 在同一次保存意图中预先固定（input.planItemId）。
// 日期由服务在意图形成时固定进输入（缺省读实时北京今天），重试不因跨午夜换日。
export function dayPlansForTask(docs, ws, taskId, date) {
  return docs.filter(p => p.kind === 'plan_item' && p.workspace_id === ws && p.task_id === taskId && p.date === date
    && isLiveRef(p) && !['cancelled', 'moved'].includes(p.state)).sort((a, b) => a.order - b.order)
}

export function createPlan(latest, env, input) {
  const task = findDoc(latest, input.taskId, 'task')
  if (!task || task.workspace_id !== env.ws) fail('RELATION_INVALID', '任务不存在或不属于当前空间')
  if (!taskUnfinished(task)) fail('TASK_DONE', '已完成任务不能新建安排')
  if (typeof input.planItemId !== 'string' || !input.planItemId) fail('INVALID_FIELD', '新建安排必须预先固定 ID')
  if (findPlan(latest, input.planItemId)) fail('RELATION_INVALID', '安排 ID 已存在')
  const date = cleanDate(input.date)
  const minutes = cleanPlannedMinutes(input.plannedMinutes)
  const text = cleanActionText(input.actionText)
  if (input.expectedDayPlanIds) {
    const ids = dayPlansForTask(latest, env.ws, task.id, date).map(p => p.id).sort()
    if (JSON.stringify(ids) !== JSON.stringify(input.expectedDayPlanIds)) {
      fail('DAY_PLANS_CHANGED', '当天安排已变化，请查看最新安排后再保存。')
    }
  }

  // 相同内容是提醒不是永久去重（6.2）：同任务+日期+规范化说明已有非 cancelled 活条目 → DUPLICATE_PLAN 零写入。
  const matches = latest.filter(
    (d) => d.kind === 'plan_item' && d.workspace_id === env.ws && d.task_id === task.id && d.date === date
      && d.state !== 'cancelled' && isLiveRef(d) && String(d.action_text).trim() === text,
  )
  const matchingIds = matches.map((d) => d.id).sort()
  if (matchingIds.length) {
    const confirmed = Array.isArray(input.confirmedDuplicateIds) ? [...input.confirmedDuplicateIds].sort() : null
    if (!confirmed) return { puts: [], deletes: [], info: { code: 'DUPLICATE_PLAN', matchingIds, date, taskId: task.id } }
    if (JSON.stringify(confirmed) !== JSON.stringify(matchingIds)) {
      return { puts: [], deletes: [], info: { code: 'DUPLICATE_SCOPE_CHANGED', matchingIds, confirmed } }
    }
  }
  const risk = requireAfterDeadlineConfirm(task, date, input, new Date(env.wallNow))
  const item = {
    kind: 'plan_item', id: input.planItemId, workspace_id: env.ws, task_id: task.id,
    date, planned_minutes: minutes, action_text: text, state: 'planned',
    actual_minutes: null, focus_session_id: null, order: nextOrder(latest, env.ws, date), task_ref_state: 'active',
  }
  return { puts: [item], deletes: [], info: { planItem: item, risk, blockedTask: task.status === 'blocked' } }
}

// 编辑只写安排说明和总预计分钟。界面和写事务共用资格判断，避免开框后计时已恢复仍然提交。
export function planEditBlock(docs, item) {
  if (!isLiveRef(item)) return { code: 'PLAN_NOT_EXECUTABLE', message: '原任务已删除' }
  if (!LIVE_PLAN_STATES.includes(item.state)) return { code: 'PLAN_TERMINAL', message: '已结束的安排只读' }
  const open = unfinishedSessionsForPlan(docs, item)
  if (open.length > 1 || open.some(s => s.record_version !== 1 || s.running !== false || s.timer_anchor_at != null)) {
    return { code: 'UNFINISHED_FOCUS', message: '请先回到工作页暂停计时或处理未结束的记录', sessionIds: open.map(s => s.id) }
  }
  const history = summarizePlanTime(item, docs)
  if (!history.authoritative) return { code: 'HISTORY_UNRESOLVED', message: '请先核对异常的工作记录', problems: history.problems }
  if (item.state === 'planned' && history.endedSessionCount > 0) {
    return { code: 'PLAN_HAS_HISTORY', message: '请先核对已有进度，再修改安排', sessionIds: history.endedSessionIds }
  }
  return null
}

export function editPlan(latest, env, input) {
  const item = findPlan(latest, input.planItemId)
  if (!item || item.workspace_id !== env.ws) fail('RELATION_INVALID', '安排不存在或不属于当前空间')
  const block = planEditBlock(latest, item)
  if (block) fail(block.code, block.message, block)
  assertTaskMutable(latest, item, env.ws)
  assertSnapshot(item, input.expected)
  const draft = { ...item }
  let changed = false
  if (input.actionText !== undefined) { draft.action_text = cleanActionText(input.actionText); changed = true }
  if (input.plannedMinutes !== undefined) { draft.planned_minutes = cleanPlannedMinutes(input.plannedMinutes); changed = true }
  if (!changed) fail('INVALID_FIELD', '编辑必须提交说明或预计分钟')
  return { puts: [draft], deletes: [], info: { planItem: draft } }
}

// 改期仅限无会话的待执行安排，保留 ID，改日期及目标日 order；总截止不变。
export function movePlan(latest, env, input) {
  const item = findPlan(latest, input.planItemId)
  if (!item || item.workspace_id !== env.ws) fail('RELATION_INVALID', '安排不存在或不属于当前空间')
  if (!isLiveRef(item)) fail('PLAN_NOT_EXECUTABLE', '历史安排只读，不能改期')
  if (item.state !== 'planned') fail('PLAN_TERMINAL', '只有未执行（planned）安排可改期；继续工作请另建安排')
  // 同日改期无操作也先校验目标合法（Task 完成/删除/跨空间一律拒绝）。
  const task = assertTaskMutable(latest, item, env.ws)
  assertNoUnfinishedPlan(latest, item)
  assertNoPlanHistory(latest, item)
  assertSnapshot(item, input.expected)
  const date = cleanDate(input.date)
  if (date === item.date) return { puts: [], deletes: [], info: { planItem: item, unchanged: true } }
  const risk = requireAfterDeadlineConfirm(task, date, input, new Date(env.wallNow))
  const draft = { ...item, date, order: nextOrder(latest, env.ws, date) }
  return { puts: [draft], deletes: [], info: { planItem: draft, risk, fromDate: item.date } }
}

// cancel：active、planned/partial、没有未结束 Focus；显式确认后设 cancelled，保留记录与历史。
// 有已结束会话时按本单口径在同一事务重算摘要（确认命令），不删成果。
export function cancelPlan(latest, env, input) {
  const item = findPlan(latest, input.planItemId)
  if (!item || item.workspace_id !== env.ws) fail('RELATION_INVALID', '安排不存在或不属于当前空间')
  if (!isLiveRef(item)) fail('PLAN_NOT_EXECUTABLE', '历史安排只读，不能取消')
  if (!LIVE_PLAN_STATES.includes(item.state)) fail('PLAN_TERMINAL', '已终态安排不能取消')
  assertTaskMutable(latest, item, env.ws)
  assertNoUnfinishedPlan(latest, item)
  assertSnapshot(item, input.expected)
  if (input.confirm !== true) fail('CONFIRM_REQUIRED', '取消安排需要明确确认')
  const hasHistory = endedSessionsForPlan(latest, item).length > 0
  const summary = summarizePlanTime(item, latest)
  // 有结束记录（含全部解析失败的异常记录）就必须走权威摘要确认；异常时拒绝写入保留原值。
  if (hasHistory) assertHistoryConfirm(summary, input.historyConfirm)
  const draft = {
    ...item, state: 'cancelled',
    actual_minutes: hasHistory ? summary.actualMinutes : item.actual_minutes ?? null,
    focus_session_id: hasHistory ? summary.latestEndedSessionId : item.focus_session_id ?? null,
  }
  return { puts: [draft], deletes: [], info: { planItem: draft, history: summary } }
}

// confirmProgress：active、无未结束 Focus、planned/partial；显式选择 partial 或 done；不完成 Action/Task。
// 没有会话也允许确认 partial/done；actual_minutes 仍 null 代表未记录用时。
export function confirmProgressPlan(latest, env, input) {
  const item = findPlan(latest, input.planItemId)
  if (!item || item.workspace_id !== env.ws) fail('RELATION_INVALID', '安排不存在或不属于当前空间')
  if (!isLiveRef(item)) fail('PLAN_NOT_EXECUTABLE', '历史安排只读，不能确认进度')
  if (!LIVE_PLAN_STATES.includes(item.state)) fail('PLAN_TERMINAL', '已终态安排不能再次确认进度')
  if (input.progress !== 'partial' && input.progress !== 'done') fail('INVALID_FIELD', '进度确认必须是 partial 或 done')
  assertTaskMutable(latest, item, env.ws)
  assertNoUnfinishedPlan(latest, item)
  assertSnapshot(item, input.expected)
  const hasHistory = endedSessionsForPlan(latest, item).length > 0
  const summary = summarizePlanTime(item, latest)
  // 「全部解析失败」不是「没有历史」：异常记录存在时拒绝权威写入，保留原摘要。
  if (hasHistory) assertHistoryConfirm(summary, input.historyConfirm)
  const draft = {
    ...item, state: input.progress,
    actual_minutes: hasHistory ? summary.actualMinutes : null,
    focus_session_id: hasHistory ? summary.latestEndedSessionId : null,
  }
  return { puts: [draft], deletes: [], info: { planItem: draft, history: summary } }
}

// arrangeAnotherDay：新建另一条安排（新意图、新 ID）；说明与分钟重新确认，
// 不迁移原会话、不自动相减历史用时。复用 create 规则（不同日自然不触发同日重复提醒）。
export function arrangeAnotherDayPlan(latest, env, input) {
  return createPlan(latest, env, input)
}

export const PLAN_COMMANDS = {
  create: createPlan,
  edit: editPlan,
  move: movePlan,
  cancel: cancelPlan,
  confirmProgress: confirmProgressPlan,
  arrangeAnotherDay: arrangeAnotherDayPlan,
}
export { TERMINAL_STATES }
// 5A-2A：focus 计划联动 begin/end 复用同一套快照/历史断言，不复制第二套规则。
export { assertSnapshot as assertPlanSnapshot, assertHistoryConfirm as assertPlanHistoryConfirm }
