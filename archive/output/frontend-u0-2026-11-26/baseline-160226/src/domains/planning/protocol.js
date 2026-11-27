// daily-v1 规划协议共享形状工具（5B-1A）。
// 口径唯一来源：contract/proposals/assistant-v1/models.py + selftest.py（冻结协议）。
// 本模块只做形状/日历/引用判定，不含排程算法、输出校验或组装逻辑。
// 时间解释全部复用 domains/time.js（UTC 运算，不依赖宿主时区）。

import { isValidDate, interpretEventInstant, beijingDateStr, beijingAddDays } from '../time.js'

export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/
// 模型新候选的规范输出规则：datetime 必须带秒；既有事实快照不用这条（R1）。
export const DEADLINE_VALUE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)?)?$/
export const JS_SAFE_INT_MAX = Number.MAX_SAFE_INTEGER

export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done']
export const PLAN_ITEM_STATES = ['planned', 'done', 'partial', 'moved', 'cancelled']
export const COUNTED_STATES = ['planned', 'partial', 'done']
export const PRIORITIES = ['high', 'normal', 'low']
export const UNSCHEDULED_REASONS = [
  'no_capacity', 'not_splittable', 'dependency_blocked', 'outside_horizon',
  'deadline_window', 'needs_deadline_day_window', 'overdue_requires_consent',
]

export function fail(message) {
  throw new Error(message)
}

export function allowKeys(obj, keys, label) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) fail(`${label} 必须是对象`)
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) fail(`${label} 含未批准字段：${k}`)
  }
}

export function checkKey(value, label) {
  if (typeof value !== 'string' || !KEY_RE.test(value)) fail(`${label} key 形状非法：${value}`)
}

export function checkRealDate(value, label) {
  if (typeof value !== 'string' || !isValidDate(value)) fail(`${label} 必须是合法 YYYY-MM-DD：${value}`)
}

// 与正式契约 _check_real_datetime 同口径：形状正则 + 偏移范围 + 真实日历/时刻；naive 按北京时间。
export function checkRealDatetime(value, label) {
  if (typeof value !== 'string' || !DATETIME_RE.test(value)) fail(`${label} 必须是 ISO 日期时间：${value}`)
  const off = /([+-])(\d{2}):(\d{2})$/.exec(value)
  if (off && (+off[2] > 23 || +off[3] > 59)) fail(`${label} 含非法时区偏移：${value}`)
  if (interpretEventInstant(value) == null) fail(`${label} 含非法日历日期或时刻：${value}`)
}

// 既有事实快照（ExistingDeadline/PlanningTaskFact）：正式 Task.Deadline 宽松口径（R1）。
export function checkExistingDeadlineValue(value, precision, label) {
  if (precision === 'date') {
    checkRealDate(value, label)
    return
  }
  checkRealDatetime(value, label)
}

// 模型新候选（DeadlineCandidate）：严格规范输出，datetime 必须带秒。
export function checkDeadlineCandidateValue(value, precision, label) {
  if (precision === 'date') {
    checkRealDate(value, label)
    return
  }
  if (typeof value !== 'string' || !DEADLINE_VALUE_RE.test(value)) {
    fail(`${label} 必须是单一 date 或规范 datetime：${value}`)
  }
  checkRealDatetime(value, label)
}

export function checkInt(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} 必须是 ${min}–${max} 的安全整数：${value}`)
  }
}

export function checkEnum(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} 必须是 ${allowed.join('/')}：${value}`)
}

export function checkText(value, min, max, label) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(`${label} 必须是长度 ${min}–${max} 的字符串`)
  }
}

// 判别引用：draft key 只在草案版本内有效；existing 是正式 ID。
export function checkTypedRef(ref, label) {
  if (ref === null || typeof ref !== 'object') fail(`${label} 引用必须是对象`)
  if (ref.kind === 'draft') {
    allowKeys(ref, ['kind', 'key'], label)
    checkKey(ref.key, `${label} draft`)
  } else if (ref.kind === 'existing') {
    allowKeys(ref, ['kind', 'id'], label)
    checkText(ref.id, 1, 64, `${label} existing id`)
  } else {
    fail(`${label} 引用 kind 必须是 draft/existing：${ref.kind}`)
  }
}

export function refToken(ref) {
  return ref.kind === 'draft' ? `draft:${ref.key}` : `existing:${ref.id}`
}

// 精确时刻截止 → 北京时间日历日期（naive 按北京解释；保留原值不改写）。
export function beijingDateOf(value) {
  const ms = interpretEventInstant(value)
  if (ms == null) fail(`无法解释为北京时间日期：${value}`)
  return beijingDateStr(ms)
}

export function windowDates(startDate) {
  return Array.from({ length: 7 }, (_, i) => beijingAddDays(startDate, i))
}

export function checkConsecutiveDays(startDate, dates, label) {
  const want = windowDates(startDate)
  if (!Array.isArray(dates) || dates.length !== 7) fail(`${label} 必须是连续 7 天`)
  dates.forEach((d, i) => {
    if (d !== want[i]) fail(`${label} 必须是从 ${startDate} 起的连续自然日：第${i + 1}天 ${d} 不符`)
  })
}

// 依赖环检测（与提案 PlanningInput 校验器同语义）。
export function checkDependencyCycles(graph) {
  const state = new Map()
  const visit = (k) => {
    if (state.get(k) === 1) fail(`依赖环：${k}`)
    if (state.get(k) === 2) return
    state.set(k, 1)
    for (const dep of graph.get(k) || []) visit(dep)
    state.set(k, 2)
  }
  for (const k of graph.keys()) visit(k)
}