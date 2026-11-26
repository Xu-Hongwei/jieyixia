// PlanningResult 独立校验（5B-1A）。
// 镜像提案 selftest.check_planning_pair + PlanningResult/DaySummary 结构校验器：
// 从输入独立重算占用/容量/守恒/依赖/截止/原因前提，不信任算法返回值。
// 通过返回聚合值（与金标 expected 同形状）；任何违反 throw。

import {
  fail, allowKeys, checkRealDate, checkInt, checkEnum, checkText, checkTypedRef,
  refToken, beijingDateOf, COUNTED_STATES, UNSCHEDULED_REASONS, JS_SAFE_INT_MAX,
} from './protocol.js'
import { beijingAddDays } from '../time.js'

const SEGMENT_KEYS = [
  'segment_key', 'work_item_key', 'task_ref', 'suggested_action_ref',
  'date', 'minutes', 'order', 'action_text', 'deliverable',
]
const DAY_KEYS = [
  'date', 'budget_minutes', 'buffer_minutes', 'committed_minutes',
  'allocated_minutes', 'free_minutes', 'overbooked_minutes',
]
const RESULT_KEYS = [
  'segments', 'days', 'unscheduled', 'unknown_items', 'excluded_items',
  'conflicts', 'warnings', 'complete',
]
const WARNING_CODES = [
  'existing_overbook', 'datetime_deadline_conservative', 'overdue_scheduled',
  'heuristic_incomplete', 'unrecorded_calendar_notice', 'window_end_not_deadline',
]
const CONFLICT_CODES = [
  'hard_constraint_violation', 'invalid_occupancy', 'dependency_cycle',
  'unknown_predecessor', 'cross_workspace_ref', 'overdue_without_consent',
]

export function validatePlanningResult(input, result) {
  allowKeys(result, RESULT_KEYS, 'PlanningResult')
  const window = input.days.map((d) => d.date)
  const windowSet = new Set(window)
  const windowIndex = new Map(window.map((d, i) => [d, i]))
  const items = new Map((input.work_items ?? []).map((w) => [w.key, w]))
  const facts = new Map((input.task_facts ?? []).map((f) => [refToken(f.task_ref), f]))
  const bufferPct = input.buffer_pct ?? 15

  const segments = result.segments ?? []
  const days = result.days ?? []
  const unscheduledList = result.unscheduled ?? []
  const unknownList = result.unknown_items ?? []
  const excludedList = result.excluded_items ?? []
  const conflicts = result.conflicts ?? []
  const warnings = result.warnings ?? []
  if (segments.length > 700) fail('segments 最多 700')
  if (days.length !== 7) fail('result.days 必须是 7 天')
  if (typeof result.complete !== 'boolean') fail('complete 必须是布尔')

  const segKeys = new Set()
  for (const s of segments) {
    allowKeys(s, SEGMENT_KEYS, 'Segment')
    checkText(s.segment_key, 1, 64, 'segment_key')
    checkText(s.work_item_key, 1, 40, 'segment.work_item_key')
    checkTypedRef(s.task_ref, 'segment.task_ref')
    checkTypedRef(s.suggested_action_ref, 'segment.suggested_action_ref')
    checkRealDate(s.date, 'segment.date')
    checkInt(s.minutes, 1, JS_SAFE_INT_MAX, 'segment.minutes')
    checkInt(s.order, 1, JS_SAFE_INT_MAX, 'segment.order')
    checkText(s.action_text, 1, 500, 'segment.action_text')
    checkText(s.deliverable, 1, 500, 'segment.deliverable')
    if (segKeys.has(s.segment_key)) fail('segment_key 重复')
    segKeys.add(s.segment_key)
  }
  for (const group of [unscheduledList, unknownList, excludedList]) {
    const seen = new Set()
    for (const x of group) {
      checkText(x.work_item_key, 1, 40, '条目 work_item_key')
      if (seen.has(x.work_item_key)) fail('同一工作项在同类清单中重复')
      seen.add(x.work_item_key)
    }
  }
  for (const u of unscheduledList) {
    allowKeys(u, ['work_item_key', 'remaining_minutes', 'reason'], 'UnscheduledEntry')
    checkInt(u.remaining_minutes, 1, JS_SAFE_INT_MAX, 'unscheduled.remaining_minutes')
    checkEnum(u.reason, UNSCHEDULED_REASONS, 'unscheduled.reason')
  }
  for (const u of unknownList) {
    allowKeys(u, ['work_item_key', 'reason'], 'UnknownItem')
    if (u.reason !== 'estimate_missing') fail('unknown 原因必须是 estimate_missing')
  }
  for (const e of excludedList) {
    allowKeys(e, ['work_item_key', 'excluded_by', 'reason'], 'ExcludedItem')
    if (e.excluded_by !== 'user') fail('排除只能由用户作出')
    checkText(e.reason, 1, 500, 'excluded.reason')
  }
  for (const c of conflicts) {
    allowKeys(c, ['code', 'message', 'related_keys'], 'PlanningConflict')
    checkEnum(c.code, CONFLICT_CODES, 'conflict.code')
    checkText(c.message, 1, 500, 'conflict.message')
  }
  for (const w of warnings) {
    allowKeys(w, ['code', 'message', 'related_key'], 'PlanningWarning')
    checkEnum(w.code, WARNING_CODES, 'warning.code')
    checkText(w.message, 1, 500, 'warning.message')
  }

  const excluded = new Set(excludedList.map((e) => e.work_item_key))
  const unknown = new Set(unknownList.map((u) => u.work_item_key))
  const unsched = new Map(unscheduledList.map((u) => [u.work_item_key, u]))

  const committedByDay = new Map(window.map((d) => [d, 0]))
  for (const o of input.occupancy ?? []) {
    if (windowSet.has(o.date) && COUNTED_STATES.includes(o.state)) {
      committedByDay.set(o.date, committedByDay.get(o.date) + o.planned_minutes)
    }
  }

  const segsByItem = new Map([...items.keys()].map((k) => [k, []]))
  const allocByDay = new Map(window.map((d) => [d, 0]))
  const ordersByDay = new Map(window.map((d) => [d, []]))
  for (const s of segments) {
    if (!windowSet.has(s.date)) fail(`段 ${s.segment_key} 日期 ${s.date} 超出 7 天窗口`)
    if (!items.has(s.work_item_key)) fail(`段 ${s.segment_key} 引用未知工作项 ${s.work_item_key}`)
    const w = items.get(s.work_item_key)
    if (refToken(s.task_ref) !== refToken(w.task_ref)) fail(`段 ${s.segment_key} task_ref 与工作项不一致`)
    if (refToken(s.suggested_action_ref) !== refToken(w.action_ref)) fail(`段 ${s.segment_key} suggested_action_ref 与工作项不一致`)
    segsByItem.get(s.work_item_key).push(s)
    allocByDay.set(s.date, allocByDay.get(s.date) + s.minutes)
    ordersByDay.get(s.date).push(s.order)
  }
  for (const [d, orders] of ordersByDay) {
    if (new Set(orders).size !== orders.length) fail(`${d} 当日 segment order 重复`)
  }

  const initialFree = []
  const finalFree = []
  const overbookedArr = []
  const dayDates = new Set()
  days.forEach((summary, i) => {
    allowKeys(summary, DAY_KEYS, 'DaySummary')
    const day = input.days[i]
    if (summary.date !== day.date) fail('result.days 与 input.days 日期顺序不一致')
    if (dayDates.has(summary.date)) fail('days 日期重复')
    dayDates.add(summary.date)
    checkRealDate(summary.date, 'result.days.date')
    checkInt(summary.budget_minutes, 0, 1440, 'summary.budget_minutes')
    const allocatable = Math.floor((day.budget_minutes * (100 - bufferPct)) / 100)
    const bufferMinutes = day.budget_minutes - allocatable
    const committed = committedByDay.get(day.date)
    const alloc = allocByDay.get(day.date)
    const over = Math.max(0, committed - allocatable)
    const free1 = Math.max(0, allocatable - committed - alloc)
    if (summary.budget_minutes !== day.budget_minutes || summary.buffer_minutes !== bufferMinutes) {
      fail(`${day.date} budget/buffer 与输入不一致`)
    }
    if (summary.buffer_minutes > summary.budget_minutes) fail('buffer_minutes 不得超过 budget_minutes')
    if (summary.committed_minutes !== committed) fail(`${day.date} committed=${summary.committed_minutes} 应为 ${committed}（占用守恒）`)
    if (summary.allocated_minutes !== alloc) fail(`${day.date} allocated 与段分钟和不一致`)
    if (summary.overbooked_minutes !== over || summary.free_minutes !== free1) fail(`${day.date} overbooked/free 公式不符`)
    if (over > 0 && (alloc > 0 || summary.free_minutes !== 0)) fail(`${day.date} 已过载仍新增安排`)
    initialFree.push(Math.max(0, allocatable - committed))
    finalFree.push(free1)
    overbookedArr.push(over)
  })

  const startDate = window[0]
  const endDate = window[6]
  const today = input.today ?? startDate
  for (const [k, w] of items) {
    const fact = facts.get(refToken(w.task_ref))
    const precision = fact.deadline_precision ?? 'none'
    let latest = endDate
    let dlDate = null
    if (precision !== 'none') {
      dlDate = precision === 'datetime' ? beijingDateOf(fact.deadline_value) : fact.deadline_value
      latest = precision === 'datetime' ? beijingAddDays(dlDate, -1) : dlDate
    }
    // R2：真实逾期按截止日与注入 today 比较，不用保守最迟日（当天精确截止不算逾期）。
    const overdue = precision !== 'none' && dlDate < today
    if (overdue && fact.overdue_consent) latest = endDate
    const segs = segsByItem.get(k).slice().sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1))
    const segSum = segs.reduce((acc, s) => acc + s.minutes, 0)

    if (excluded.has(k)) {
      if (segs.length || unsched.has(k) || unknown.has(k)) fail(`已排除项 ${k} 不得有段/未排/未知记录`)
      continue
    }
    if (w.remaining_minutes == null) {
      if (!unknown.has(k)) fail(`未知估时项 ${k} 必须单列 unknown_items`)
      if (segs.length || unsched.has(k)) fail(`未知估时项 ${k} 不得排段或填缺口（不能当 0）`)
      continue
    }
    if (unknown.has(k)) fail(`已知估时项 ${k} 不得列入 unknown_items`)

    const gap = unsched.has(k) ? unsched.get(k).remaining_minutes : 0
    if (segSum + gap !== w.remaining_minutes) fail(`${k} 分钟不守恒：${segSum}+${gap} != ${w.remaining_minutes}`)
    if (segSum === w.remaining_minutes && unsched.has(k)) fail(`${k} 已排完仍有未排记录`)

    const splittable = w.splittable ?? true
    if (!splittable && segs.length > 1) fail(`不可拆项 ${k} 出现多段`)
    if (splittable && segs.length) {
      for (const s of segs.slice(0, -1)) {
        if (s.minutes < (w.min_segment_minutes ?? 25)) fail(`${k} 非最终段 ${s.minutes} 小于最小段 ${w.min_segment_minutes ?? 25}`)
      }
    }
    if (w.earliest_date && segs.some((s) => s.date < w.earliest_date)) fail(`${k} 排在 earliest_date 之前`)
    if (segs.some((s) => s.date > latest)) fail(`${k} 排在最迟可排日 ${latest} 之后（截止不等于安排日）`)
    if (overdue) {
      if (!fact.overdue_consent) {
        if (segs.length || (unsched.has(k) && unsched.get(k).reason !== 'overdue_requires_consent')) {
          fail(`逾期项 ${k} 未经补做确认不得安排`)
        }
      } else if (segs.length && !warnings.some((x) => x.code === 'overdue_scheduled')) {
        fail(`逾期补做项 ${k} 已排但缺 overdue_scheduled 警告`)
      }
    }
    if (unsched.has(k)) {
      const reason = unsched.get(k).reason
      if (reason === 'not_splittable' && splittable) fail(`${k} reason=not_splittable 但工作项可拆`)
      if (reason === 'outside_horizon' && (!w.earliest_date || w.earliest_date <= endDate)) {
        fail(`${k} reason=outside_horizon 但最早日在窗口内`)
      }
      if (reason === 'overdue_requires_consent' && (!overdue || fact.overdue_consent)) {
        fail(`${k} reason=overdue_requires_consent 与事实不符`)
      }
      if (reason === 'dependency_blocked') {
        const blocked = (w.depends_on ?? []).some((d) => {
          const dw = items.get(d)
          const dsum = segsByItem.get(d).reduce((acc, s) => acc + s.minutes, 0)
          return dw.remaining_minutes == null || dsum < dw.remaining_minutes
        })
        if (!blocked) fail(`${k} dependency_blocked 但前置全部排完`)
      }
      if (reason === 'needs_deadline_day_window') {
        if (precision !== 'datetime') fail(`${k} needs_deadline_day_window 只用于精确时刻截止`)
        if (!windowSet.has(dlDate)) fail(`${k} 截止当天不在窗口内，不应要求当天时段核对`)
        if (initialFree[windowIndex.get(dlDate)] <= 0) fail(`${k} 截止当天无空闲，不构成时段核对缺口`)
      }
    }
  }

  for (const [k, w] of items) {
    if (excluded.has(k) || w.remaining_minutes == null) continue
    const segs = segsByItem.get(k)
    for (const dep of w.depends_on ?? []) {
      const dw = items.get(dep)
      const depSegs = segsByItem.get(dep)
      const depSum = depSegs.reduce((acc, s) => acc + s.minutes, 0)
      if (dw.remaining_minutes == null) {
        if (segs.length) fail(`${k} 的前置 ${dep} 估时未知，不得排后继`)
        continue
      }
      if (depSum < dw.remaining_minutes) {
        if (segs.length) fail(`前置 ${dep} 仍有未排量，后继 ${k} 不得排段`)
        if (unsched.has(k) && unsched.get(k).reason !== 'dependency_blocked') fail(`${k} 应标 dependency_blocked`)
      } else if (segs.length && depSegs.length) {
        const depLast = depSegs.reduce((a, s) => (s.date > a.date || (s.date === a.date && s.order > a.order) ? s : a))
        const ownFirst = segs.reduce((a, s) => (s.date < a.date || (s.date === a.date && s.order < a.order) ? s : a))
        if (ownFirst.date < depLast.date || (ownFirst.date === depLast.date && ownFirst.order <= depLast.order)) {
          fail(`${k} 必须整体晚于前置 ${dep}（同日须明确 order）`)
        }
      }
    }
  }

  if (overbookedArr.some((o) => o > 0) && !warnings.some((w) => w.code === 'existing_overbook')) {
    fail('存在既有过载日但缺 existing_overbook 警告')
  }
  if ((input.task_facts ?? []).some((f) => f.deadline_precision === 'datetime')
    && !warnings.some((w) => w.code === 'datetime_deadline_conservative')) {
    fail('存在精确时刻截止但缺 datetime_deadline_conservative 说明')
  }

  const expectedComplete = unscheduledList.length === 0 && unknownList.length === 0 && conflicts.length === 0
    && [...items].every(([k, w]) => excluded.has(k)
      || (w.remaining_minutes != null && segsByItem.get(k).reduce((acc, s) => acc + s.minutes, 0) === w.remaining_minutes))
  if (result.complete !== expectedComplete) fail(`complete=${result.complete} 与事实不符（应为 ${expectedComplete}）`)

  return {
    initial_free_by_day: initialFree,
    allocated_by_day: window.map((d) => allocByDay.get(d)),
    final_free_by_day: finalFree,
    overbooked_by_day: overbookedArr,
    scheduled_total: window.reduce((acc, d) => acc + allocByDay.get(d), 0),
    unscheduled: unscheduledList
      .map((u) => ({ work_item_key: u.work_item_key, remaining_minutes: u.remaining_minutes, reason: u.reason }))
      .sort((a, b) => (a.work_item_key < b.work_item_key ? -1 : a.work_item_key > b.work_item_key ? 1 : 0)),
    unknown_count: unknownList.length,
    complete: result.complete,
  }
}