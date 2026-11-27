// 周视图纯函数：任务按北京截止日落位到周一为首的 7 列，列内按墙上时间 0-24 点排序。
// 只读规划，不触库；偏移/Z 的截止先换算成北京同一时刻再取日期与钟点。
import { beijingAddDays, beijingDateStr, beijingParts, beijingWeekday, interpretInstant, isOverdue } from './time'
import { isActivePlan, isLiveRef } from './plan'

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const p2 = (n) => String(n).padStart(2, '0')

// 周一为周首：北京日期回退到本周一。
export function weekStartOf(dateStr) {
  return beijingAddDays(dateStr, -((beijingWeekday(dateStr) + 6) % 7))
}

export function weekDaysOf(startStr) {
  return Array.from({ length: 7 }, (_, i) => beijingAddDays(startStr, i))
}

// 周范围标题：11.16 — 11.22（跨年时两侧各带年份由调用方补）。
export function weekRangeLabel(startStr) {
  const end = beijingAddDays(startStr, 6)
  const f = (s) => `${+s.slice(5, 7)}.${+s.slice(8, 10)}`
  return `${f(startStr)} — ${f(end)}`
}

// 截止的北京落位：{ day, minutes }；minutes=null 表示仅日期（列内置后）。非法/无截止返回 null。
export function deadlineSlot(deadline) {
  if (!deadline || !deadline.value) return null
  const ms = interpretInstant(deadline.value)
  if (ms == null) return null
  const b = beijingParts(ms)
  const hasClock = /T\d{2}:\d{2}/.test(deadline.value)
  return { day: beijingDateStr(ms), minutes: hasClock ? b.hour * 60 + b.minute : null }
}

// 周网格：days[7] 各含 items（按钟点升序，仅日期置后、同刻按标题稳定排序）；undated 收无截止任务。
// done 任务保留在网格内（视图层淡化），一个事项多个任务/多个时间自然落多个日期。
export function weekGrid(tasks, startStr, nowD = new Date()) {
  const days = weekDaysOf(startStr).map((date, i) => ({
    date,
    weekday: WEEKDAY_LABELS[i],
    dayNum: +date.slice(8, 10),
    isToday: date === beijingDateStr(nowD),
    items: [],
  }))
  const byDate = new Map(days.map((d) => [d.date, d]))
  const undated = []
  for (const t of tasks) {
    const slot = deadlineSlot(t.deadline)
    if (!slot) {
      undated.push(t)
      continue
    }
    const day = byDate.get(slot.day)
    if (!day) continue
    day.items.push({ task: t, minutes: slot.minutes })
  }
  for (const d of days) {
    d.items.sort((a, b) => {
      const am = a.minutes == null ? 1440 : a.minutes
      const bm = b.minutes == null ? 1440 : b.minutes
      if (am !== bm) return am - bm
      return (a.task.title || '').localeCompare(b.task.title || '', 'zh')
    })
  }
  return { days, undated, count: days.reduce((n, d) => n + d.items.length, 0) }
}

// 卡片顶部钟点：HH:MM（北京墙上时间）；仅日期返回 ''。
export function slotClock(minutes) {
  if (minutes == null) return ''
  return `${p2(Math.floor(minutes / 60))}:${p2(minutes % 60)}`
}

// 卡片截止标注：截止 11月22日 · 23:59（仅日期不带钟点）。
export function slotDeadlineLabel(deadline) {
  if (!deadline || !deadline.value) return ''
  const ms = interpretInstant(deadline.value)
  if (ms == null) return ''
  const b = beijingParts(ms)
  const date = `${b.month}月${b.day}日`
  const clock = slotClock(deadlineSlot(deadline).minutes)
  return clock ? `截止 ${date} · ${clock}` : `截止 ${date}`
}

// 统一日程聚合（5A-0 §7，纯读取，不改页面）：上方每日工作安排 plans、下方每日任务截止 deadlines，
// 同一组日期列；planHistory 收终态/断引用/任务已完成的旧安排（保留原因，不当今天待做）。
// 复用北京规则与 deadlineSlot，不引入第二套设备本地时区。旧 weekGrid 接口与截止表现完全不变。
// 工作安排数与截止任务数分开计数，不合成「本周任务N项」。周外记录不丢失（outsideWeek），只是不在七日列。
export function weekSchedule({ docs, startStr, nowD = new Date() }) {
  const tasks = docs.filter((d) => d.kind === 'task')
  const plans = docs.filter((d) => d.kind === 'plan_item')
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const days = weekDaysOf(startStr).map((date, i) => ({
    date, weekday: WEEKDAY_LABELS[i], dayNum: +date.slice(8, 10),
    isToday: date === beijingDateStr(nowD), plans: [], planHistory: [], deadlines: [],
  }))
  const byDate = new Map(days.map((d) => [d.date, d]))
  const outsideWeek = []

  for (const p of plans) {
    const task = taskById.get(p.task_id) || null
    const taskLive = !!task && task.status !== 'done'
    const upper = isActivePlan(p) && taskLive
    const entry = { plan: p, task }
    if (!upper) {
      entry.reason = !isLiveRef(p) ? 'task_deleted' : task && task.status === 'done' ? 'task_done' : p.state
    }
    const day = byDate.get(p.date)
    if (!day) { outsideWeek.push(entry); continue }
    if (upper) day.plans.push(entry)
    else day.planHistory.push(entry)
  }
  const byPlanOrder = (a, b) => {
    const ao = Number.isInteger(a.plan.order) ? a.plan.order : 0
    const bo = Number.isInteger(b.plan.order) ? b.plan.order : 0
    if (ao !== bo) return ao - bo
    return String(a.plan.id).localeCompare(String(b.plan.id))
  }
  for (const d of days) {
    d.plans.sort(byPlanOrder)
    d.planHistory.sort(byPlanOrder)
  }

  // 截止只从 Task.deadline 计算，每 Task 最多一次；已完成 Task 保留标识（淡化由 UI 处理）。
  const undatedTasks = []
  for (const t of tasks) {
    const slot = deadlineSlot(t.deadline)
    if (!slot) { undatedTasks.push(t); continue }
    const day = byDate.get(slot.day)
    if (!day) continue
    day.deadlines.push({ task: t, minutes: slot.minutes, precision: t.deadline.precision, done: t.status === 'done', overdue: isOverdue(t, nowD) })
  }
  for (const d of days) {
    d.deadlines.sort((a, b) => {
      const am = a.minutes == null ? 1440 : a.minutes
      const bm = b.minutes == null ? 1440 : b.minutes
      if (am !== bm) return am - bm
      return (a.task.title || '').localeCompare(b.task.title || '', 'zh')
    })
  }
  return {
    days,
    planCount: days.reduce((n, d) => n + d.plans.length, 0),
    deadlineCount: days.reduce((n, d) => n + d.deadlines.length, 0),
    outsideWeek, undatedTasks,
  }
}