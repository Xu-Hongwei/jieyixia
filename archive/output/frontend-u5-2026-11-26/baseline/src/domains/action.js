// 契约 Action 的本地维护（纯函数事务计划，不触库）。
// 持久化边界：Action 与 note/task/matter 一样存于 docs store，kind:'action' 只是持久化元数据，
// 不属于契约域模型（schema additionalProperties:false）；workspace_id 由存储层 stamp 注入。
// Action 契约没有 updated_at：编辑直接替换记录，不私塞未定义字段。
// 每个 plan 接收事务内最新 docs，返回 { puts, deletes, info }；抛错即整体回滚。
import { assertNoUnfinishedSession, refDeletePatches } from './focus'

export const ACTION_DEFAULT_MINUTES = 30

// 输入校验：内容非空、分钟为正整数。30 分钟只是可修改的输入默认值，保存后才成为用户选择。
export function makeAction(taskId, text, minutes, now) {
  const trimmed = String(text || '').trim()
  const m = typeof minutes === 'string' ? Number(minutes) : minutes
  if (!trimmed || !Number.isInteger(m) || m <= 0) return null
  return {
    id: crypto.randomUUID(),
    kind: 'action',
    task_id: taskId,
    text: trimmed,
    minutes: m,
    basis: 'user',
    done: false,
    created_at: now,
  }
}

const findAction = (latest, actionId) => latest.find((d) => d.id === actionId && d.kind === 'action')
const findTask = (latest, taskId) => latest.find((d) => d.id === taskId && d.kind === 'task')

// 当前行动有效性：必须属于本任务且未完成；无效引用不得展示成有效当前行动。
export function validCurrentAction(latest, task) {
  if (!task || !task.current_action_id) return null
  const a = findAction(latest, task.current_action_id)
  return a && a.task_id === task.id && !a.done ? a : null
}

export function addActionPlan(latest, action) {
  if (!findTask(latest, action.task_id)) throw new Error('任务已不存在，无法添加行动')
  return { puts: [action], deletes: [], info: { action } }
}

export function editActionPlan(latest, actionId, text, minutes) {
  const action = findAction(latest, actionId)
  if (!action) return { puts: [], deletes: [], info: { action: null } }
  const trimmed = String(text || '').trim()
  const m = typeof minutes === 'string' ? Number(minutes) : minutes
  if (!trimmed) throw new Error('行动内容不能为空')
  if (!Number.isInteger(m) || m <= 0) throw new Error('预计分钟须为正整数')
  const draft = { ...action, text: trimmed, minutes: m }
  return { puts: [draft], deletes: [], info: { action: draft } }
}

// 完成当前行动 → 同事务清空 task.current_action_id，提示用户另选下一步，不自动指定。
// sessions 缺省 [] 向后兼容；传入时完成行动受未结束专注会话保护（3B-1 S6）。
export function setActionDonePlan(latest, actionId, done, now, sessions = []) {
  const action = findAction(latest, actionId)
  if (!action) return { puts: [], deletes: [], info: { action: null, clearedCurrent: false } }
  if (done) assertNoUnfinishedSession(sessions, { actionIds: [actionId] })
  const draft = { ...action, done: !!done }
  const puts = [draft]
  let clearedCurrent = false
  const task = findTask(latest, action.task_id)
  if (done && task && task.current_action_id === actionId) {
    puts.push({ ...task, current_action_id: null, updated_at: now })
    clearedCurrent = true
  }
  return { puts, deletes: [], info: { action: draft, clearedCurrent } }
}

export function deleteActionPlan(latest, actionId, now, sessions = []) {
  const action = findAction(latest, actionId)
  if (!action) return { puts: [], deletes: [], info: { action: null, wasCurrent: false } }
  assertNoUnfinishedSession(sessions, { actionIds: [actionId] })
  const puts = []
  const task = findTask(latest, action.task_id)
  const wasCurrent = !!task && task.current_action_id === actionId
  if (wasCurrent) puts.push({ ...task, current_action_id: null, updated_at: now })
  // 已结束会话逐引用断开：只改 action_ref_state，正文/累计/快照保留；补丁供撤销核对。
  const refs = refDeletePatches(sessions, { actionIds: [actionId] })
  puts.push(...refs.puts)
  return { puts, deletes: [actionId], info: { action, wasCurrent, sessionPatches: refs.patches } }
}

// 显式选择当前行动：必须属于本任务且未完成；null = 用户主动取消选择。
export function setCurrentActionPlan(latest, taskId, actionId, now) {
  const task = findTask(latest, taskId)
  if (!task) return { puts: [], deletes: [], info: { task: null } }
  if (actionId) {
    const a = findAction(latest, actionId)
    if (!a || a.task_id !== taskId) throw new Error('行动不属于该任务，不能设为当前行动')
    if (a.done) throw new Error('已完成的行动不能设为当前行动')
  }
  const draft = { ...task, current_action_id: actionId || null, updated_at: now }
  return { puts: [draft], deletes: [], info: { task: draft } }
}

// 重新打开任务回 todo；当前行动引用仍有效则保留，无效则清空；不重开已完成的行动。
export function reopenTaskPlan(latest, taskId, now) {
  const task = findTask(latest, taskId)
  if (!task) return { puts: [], deletes: [], info: { task: null } }
  const current = validCurrentAction(latest, task)
  const draft = { ...task, status: 'todo', current_action_id: current ? current.id : null, updated_at: now }
  return { puts: [draft], deletes: [], info: { task: draft } }
}