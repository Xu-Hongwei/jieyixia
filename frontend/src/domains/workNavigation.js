// 5A-2B 执行闭环的纯路由助手：return 上下文解析/规范化、安排执行上下文校验、
// 丢失 return 时的安全返回目标、日程定位查询。不依赖 Vue/router，只读传入的当前空间 docs。
// 规则（开工单 §4）：
// - return 只接受精确匹配的站内路径 + 已知查询参数；外站/协议相对/未匹配路径/跨空间对象一律拒绝（null）。
// - 返回链有限：work → task → 日程/资料库，或 work → 日程。task 的 return 只允许终端页，
//   终端页不再携带 return；绝不把当前 fullPath 反复包成新 return。
// - 规范化丢弃临时操作参数（create/task/recorded/return 嵌套），保留合法筛选/视图字段。
// - URL 不是授权：对象归属按当前空间 docs 校验；跨空间只提示，不自动切换。
import { isValidDate } from './time'
import { weekStartOf } from './week'
import { BUCKET_ORDER } from './organize'
import { isLiveRef } from './plan'

const COLLECT_KEYS = ['q', 'kind', 'content', 'status', 'from', 'to', 'sort']

const enc = encodeURIComponent
const buildQuery = (pairs) => {
  const usp = new URLSearchParams()
  for (const [k, v] of pairs) if (v != null && v !== '') usp.set(k, v)
  const s = usp.toString()
  return s ? `?${s}` : ''
}

// —— 生成：日程地址规范化（默认值省略：view=week 省略、date=今天省略）——
export function cleanScheduleQuery(query = {}, todayStr = '') {
  const out = {}
  const date = typeof query.date === 'string' && isValidDate(query.date) ? query.date : null
  if (date && date !== todayStr) out.date = date
  if (query.view === 'list') out.view = 'list'
  if (typeof query.plan === 'string' && query.plan) out.plan = query.plan
  if (query.undated === '1') out.undated = '1'
  // 一次性定位说明标记：来源周不包含目标安排时由 planScheduleReturn 写入，日程页消费后移除。
  if (query.located === '1') out.located = '1'
  return out
}
export const schedulePath = (query, todayStr) => `/today${buildQuery(Object.entries(cleanScheduleQuery(query, todayStr)))}`

export function taskPath(taskId, { plan = '', return: ret = '' } = {}) {
  return `/tasks/${enc(taskId)}${buildQuery([['plan', plan], ['return', ret]])}`
}
export const workPath = (sessionId, ret = '') => `/work/${enc(sessionId)}${buildQuery([['return', ret]])}`
export const recordPath = (sessionId, ret = '') => `/work-records/${enc(sessionId)}${buildQuery([['return', ret]])}`

// —— 解析：return 精确匹配 + 归属校验。ctx = { docs（当前空间）, ws, todayStr } ——
const findDoc = (docs, id, kind, ws) => docs.find((d) => d.id === id && d.kind === kind && d.workspace_id === ws) || null

function parseAt(raw, ctx, top) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  if (raw.includes('\\') || raw.includes('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  const qi = raw.indexOf('?')
  let path = qi >= 0 ? raw.slice(0, qi) : raw
  const usp = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '')
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  const { docs, ws, todayStr } = ctx

  if (path === '/today') {
    const q = cleanScheduleQuery(Object.fromEntries(usp), todayStr)
    if (q.plan && !findDoc(docs, q.plan, 'plan_item', ws)) return null
    return schedulePath(q, todayStr)
  }
  if (path === '/collect') {
    const pairs = COLLECT_KEYS.map((k) => [k, usp.get(k) || ''])
    return `/collect${buildQuery(pairs)}`
  }
  if (path === '/notes') {
    const bucket = usp.get('bucket')
    return `/notes${buildQuery([['bucket', BUCKET_ORDER.includes(bucket) ? bucket : '']])}`
  }
  let m = path.match(/^\/notes\/([^/]+)$/)
  if (m) {
    const id = decodeURIComponent(m[1])
    if (!id || id.includes('/') || !findDoc(docs, id, 'note', ws)) return null
    const bucket = usp.get('bucket')
    return `/notes/${enc(id)}${buildQuery([['bucket', BUCKET_ORDER.includes(bucket) ? bucket : '']])}`
  }
  m = path.match(/^\/tasks\/([^/]+)$/)
  if (m) {
    // task 作为 return 目标只在最外层允许（work → task）；task 的 return 必须是终端页。
    if (!top) return null
    const id = decodeURIComponent(m[1])
    if (!id || id.includes('/') || !findDoc(docs, id, 'task', ws)) return null
    const plan = usp.get('plan') || ''
    if (plan) {
      const p = findDoc(docs, plan, 'plan_item', ws)
      if (!p || p.task_id !== id) return null
    }
    const inner = usp.get('return')
    let innerPath = ''
    if (inner != null && inner !== '') {
      innerPath = parseAt(inner, ctx, false)
      if (innerPath == null) return null
    }
    return taskPath(id, { plan, return: innerPath })
  }
  if (path === '/work-records') return '/work-records'
  m = path.match(/^\/work-records\/([^/]+)$/)
  if (m) {
    const id = decodeURIComponent(m[1])
    if (!id || id.includes('/') || !findDoc(docs, id, 'focus_session', ws)) return null
    return `/work-records/${enc(id)}`
  }
  return null
}

// 规范化 return：合法 → 规范化字符串；非法/外站/跨空间/嵌套超限 → null（调用方走安全回退）。
export function parseReturnPath(raw, ctx) {
  try {
    return parseAt(raw, ctx, true)
  } catch {
    return null
  }
}

// —— 安全回退（§4 规则 5）：return 丢失/非法时按真实对象构造目标，不猜测来源 ——
// 会话有真实安排关联 → 当前空间日程定位该安排；独立会话 → 所属任务；对象不存在 → 当前空间日程。
export function resolveWorkReturn(raw, session, ctx) {
  const parsed = parseReturnPath(raw, ctx)
  if (parsed != null) return parsed
  if (session && session.plan_item_id) {
    const plan = findDoc(ctx.docs, session.plan_item_id, 'plan_item', ctx.ws)
    if (plan) return schedulePath({ date: plan.date, plan: plan.id }, ctx.todayStr)
  }
  if (session && session.task_id && findDoc(ctx.docs, session.task_id, 'task', ctx.ws)) {
    return `/tasks/${enc(session.task_id)}`
  }
  return '/today'
}
export const resolveTaskReturn = (raw, ctx) => parseReturnPath(raw, ctx) ?? '/today'

// —— 任务页显式执行安排上下文（§4 规则 1/2）：只认 plan 参数，不从 return 字符串推断 ——
// 返回 { status: 'none' } | { status: 'ok', plan } | { status: 'invalid', reason }。
// reason: missing（不存在/跨空间）| cross-task（不属于本任务）| dead-ref（任务引用已断开）。
export function planContextForTask(query, taskId, ctx) {
  const raw = query && query.plan
  if (typeof raw !== 'string' || !raw) return { status: 'none' }
  const plan = findDoc(ctx.docs, raw, 'plan_item', ctx.ws)
  if (!plan) return { status: 'invalid', reason: 'missing' }
  if (plan.task_id !== taskId) return { status: 'invalid', reason: 'cross-task' }
  if (!isLiveRef(plan)) return { status: 'invalid', reason: 'dead-ref' }
  return { status: 'ok', plan }
}

// —— 返回日程定位（§4 规则 6）：区分来源导航偏好与目标定位 ——
// 视图（view）是来源偏好，保留；日期是目标定位，一律对齐安排日（同周不同日也要选中目标日，
// 手机日期条/周表滚动都靠 date 参数）。relocated 仅表示跨周（来源周不包含目标），供页面一次性说明。
export function scheduleLocateQuery(plan, sourceQuery, todayStr) {
  const q = cleanScheduleQuery(sourceQuery || {}, todayStr)
  const sourceDate = q.date || todayStr
  const relocated = weekStartOf(sourceDate) !== weekStartOf(plan.date)
  if (plan.date === todayStr) delete q.date
  else q.date = plan.date
  q.plan = plan.id
  return { query: q, relocated }
}

// 安排详情/工作/记录链接的日程 return：在日程页沿用来源日期视图并定位目标安排；
// 其它宿主（任务详情内嵌详情）直接用安排日定位。不携带临时操作参数。
export function planScheduleReturn(path, query, plan, todayStr) {
  if (path === '/today') {
    const { query: q, relocated } = scheduleLocateQuery(plan, query, todayStr)
    if (relocated) q.located = '1'
    return schedulePath(q, todayStr)
  }
  return schedulePath({ date: plan.date, plan: plan.id }, todayStr)
}