// 时间规则（与契约 0.3.0 / 后端 time_rules 同口径）。
// 产品默认时区固定北京时间 UTC+08:00 / Asia/Shanghai，不随设备或服务器时区。
// 解释层规则：naive 值按北京墙上时间解释；明确偏移/Z 转成同一绝对时刻（绝不替换偏移）；
// date 型逾期从北京次日 00:00 起判；今天/分组/逾期统一按北京日界。value 原文形状不改写。

export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const p2 = (n) => String(n).padStart(2, '0')

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2})(:(\d{2}))?([+-]\d{2}:\d{2}|Z)?)?$/

export function isValidTimeValue(v) {
  const m = TIME_RE.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return false
  if (m[4] && (+m[5] > 23 || +m[6] > 59 || (m[8] && +m[8] > 59))) return false
  if (m[9] && m[9] !== 'Z' && (+m[9].slice(1, 3) > 23 || +m[9].slice(4, 6) > 59)) return false
  return true
}

export const isValidDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && isValidTimeValue(v)

// 把任意瞬时（Date 或 UTC ms）转成北京墙上时钟 parts。
// 用「偏移后的 UTC getter」读取，结果与设备本地时区无关。
/** @param {Date|number} [instant] */
export function beijingParts(instant = new Date()) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant)
  const d = new Date(ms + BEIJING_OFFSET_MS)
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
  }
}

// 北京当天日期字符串 YYYY-MM-DD（今天/分组/逾期的统一日界）。
/** @param {Date|number} [instant] */
export function beijingDateStr(instant = new Date()) {
  const b = beijingParts(instant)
  return `${b.year}-${p2(b.month)}-${p2(b.day)}`
}
/** @param {Date|number} [instant] */
export const beijingToday = (instant = new Date()) => beijingDateStr(instant)

// 北京某日 00:00 对应的绝对 UTC ms。
export function beijingDayStartMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d) - BEIJING_OFFSET_MS
}

// 北京日期加减天数（快捷按钮用）：锚定北京子夜后按整日推移，跨年/闰日正确，北京无夏令时。
export function beijingAddDays(dateStr, days) {
  return beijingDateStr(beijingDayStartMs(dateStr) + days * DAY_MS)
}

// 解释 ISO 值为绝对 UTC ms：date-only→北京当日 00:00；naive datetime→北京墙上时间；
// 明确偏移/Z→按原义转绝对时刻。非法返回 null。
export function interpretInstant(value) {
  const m = TIME_RE.exec(value)
  if (!m || !isValidTimeValue(value)) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  if (!m[4]) return beijingDayStartMs(value)
  const h = +m[5], mi = +m[6], s = m[8] ? +m[8] : 0
  const off = m[9]
  if (!off) return Date.UTC(y, mo - 1, d, h, mi, s) - BEIJING_OFFSET_MS
  if (off === 'Z') return Date.UTC(y, mo - 1, d, h, mi, s)
  const sign = off[0] === '-' ? -1 : 1
  const oh = +off.slice(1, 3), om = +off.slice(4, 6)
  return Date.UTC(y, mo - 1, d, h, mi, s) - sign * (oh * 60 + om) * 60000
}

// 事件时间（FocusSession started_at/ended_at 等）解释：与契约 DATETIME_RE 同形状
// （必须有 T 与 HH:MM，秒与小数分别可选——HH:MM.fff 合法，小数按 Python fromisoformat
// 实测依附秒：16:00.123 → 16:00:00.123），并做与后端 _check_real_datetime 同口径的
// 真实日历/时刻/偏移校验（fromisoformat 会静默接受 +08:75，这里显式拒绝）。
// naive 按北京墙上时间。小数截断到毫秒（与微秒截断同向）。只解释不重写原文。
// 截止输入规则（TIME_RE/isValidTimeValue/interpretInstant）不受此函数影响，不放宽。
const EVENT_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2}))?(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/
export function interpretEventInstant(value) {
  if (typeof value !== 'string') return null
  const m = EVENT_TIME_RE.exec(value)
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  const cal = new Date(Date.UTC(y, mo - 1, d))
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return null
  const h = +m[4], mi = +m[5], s = m[7] ? +m[7] : 0
  if (h > 23 || mi > 59 || s > 59) return null
  const off = m[9]
  if (off && off !== 'Z' && (+off.slice(1, 3) > 23 || +off.slice(4, 6) > 59)) return null
  const fracMs = m[8] ? +m[8].slice(1, 4).padEnd(3, '0') : 0
  const base = Date.UTC(y, mo - 1, d, h, mi, s)
  if (!off) return base - BEIJING_OFFSET_MS + fracMs
  if (off === 'Z') return base + fracMs
  const sign = off[0] === '-' ? -1 : 1
  const oh = +off.slice(1, 3), om = +off.slice(4, 6)
  return base - sign * (oh * 60 + om) * 60000 + fracMs
}

// 逾期：date 型按北京日界（北京今天 > 截止日 即逾期，等价于北京次日 00:00 起判）；
// datetime 型按绝对时刻（naive 按北京解释）。done 不判逾期。
export function isOverdue(task, nowD = new Date()) {
  const dl = task.deadline
  if (!dl || !dl.value || task.status === 'done') return false
  if (dl.precision === 'date') return dl.value < beijingDateStr(nowD)
  const ms = interpretInstant(dl.value)
  return ms != null && ms < nowD.getTime()
}

// 是否落在北京今天（今天分组用）。
export function isToday(value, precision, nowD = new Date()) {
  if (!value) return false
  const today = beijingDateStr(nowD)
  if (precision === 'date') return value === today
  const ms = interpretInstant(value)
  return ms != null && beijingDateStr(ms) === today
}

// 北京日期对应的星期（0=周日…6=周六）。用 UTC 子夜的 getUTCDay 读取，与设备时区无关。
export function beijingWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

// 下一个北京子夜的绝对 UTC ms（用于跨午夜动态刷新「今天」）。
/** @param {Date|number} [instant] */
export function nextBeijingMidnightMs(instant = new Date()) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant)
  return beijingDayStartMs(beijingAddDays(beijingDateStr(ms), 1))
}

// 用户主动改时间时重建尾巴：保留原文的秒与偏移/Z，只替换 HH:MM。
// origTail 形如 T17:00:30+08:00 / T17:00Z / T17:00（naive）/ ''。hhmm 为空则返回 ''（仅日期）。
export function replaceClockKeepSeconds(origTail, hhmm) {
  if (!hhmm) return ''
  const sec = (/^T\d{2}:\d{2}(:\d{2})/.exec(origTail || '') || [])[1] || ''
  const off = (/(Z|[+-]\d{2}:\d{2})$/.exec(origTail || '') || [])[1] || ''
  return `T${hhmm}${sec}${off}`
}

// 今天标题：北京日期 + 星期。
export function beijingTodayLabel(nowD = new Date()) {
  const b = beijingParts(nowD)
  return `${b.year}年${b.month}月${b.day}日 · 周${WEEKDAYS[beijingWeekday(beijingDateStr(nowD))]}`
}

// 显示原文墙上时间（不随时区平移，忠实保留 value 形状）。
export function formatWhen(value, precision) {
  if (!value) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2}))?/.exec(value)
  if (!m) return value
  const date = `${+m[1]}年${+m[2]}月${+m[3]}日`
  if (precision === 'date' || !m[4]) return date
  return `${date} ${m[5]}:${m[6]}`
}

// 把带偏移/Z 的收集时刻等绝对瞬时显示为北京墙上时间（用于「收集于」等元信息）。
// 与 formatWhen 不同：这里必须按原偏移换算到同一绝对时刻再转北京，而非照抄原文。
// 元信息可能带毫秒（契约 TIME_RE 不收），故显式偏移/Z 走 Date.parse；naive/date-only 仍走契约解释器。
export function beijingInstantLabel(value) {
  if (!value) return ''
  // Date.parse 会对非法日（如 02-30）滚动进位；先用日历校验挡住，避免显示错误的换算日期。
  if (!isValidDate(String(value).slice(0, 10))) return value
  const ms = /(Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : interpretInstant(value)
  if (ms == null || Number.isNaN(ms)) return value
  const b = beijingParts(ms)
  return `${b.year}年${b.month}月${b.day}日 ${p2(b.hour)}:${p2(b.minute)}（北京时间）`
}