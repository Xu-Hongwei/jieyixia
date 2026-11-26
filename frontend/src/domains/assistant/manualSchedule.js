import { interpretEventInstant } from '../time.js'
import { beijingDateOf, refToken } from '../planning/protocol.js'

// The index belongs to the frozen result of this revision. '#' cannot start a proposal key.
export const manualSegmentKey = index => `#manual-${index + 1}`

export function manualSlots(draft) {
  const slots = new Map()
  for (const c of draft?.user_confirmations ?? []) {
    if (c.draft_revision !== draft.revision || c.object_type !== 'gap') continue
    if (c.field_path === 'manual_slot') slots.set(c.object_id_or_key, c.new_value)
    else slots.delete(c.object_id_or_key)
  }
  return slots
}

// Automatic output stays reproducible. Only an explicit choice on this revision
// contributes a manual segment to preview and to the same atomic adoption.
export function scheduleWithManualSlots(draft) {
  const base = draft?.planning_result
  const slots = manualSlots(draft)
  if (!slots.size) return base
  const segments = [...base.segments]
  const days = base.days.map(day => ({ ...day }))
  const items = new Map(draft.planning_input.work_items.map(w => [w.key, w]))
  const intervals = []
  for (const [key, slot] of slots) {
    const index = base.unscheduled.findIndex(g => g.work_item_key === key)
    const gap = base.unscheduled[index]
    const work = items.get(key)
    if (!gap || !work) throw new Error('这项工作已不在未排清单中，请重新核对。')
    const day = days.find(d => d.date === slot?.date)
    if (!day) throw new Error('请选择本轮七天内的日期。')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) throw new Error('请选择开始时间。')
    if (work.earliest_date && day.date < work.earliest_date) throw new Error(`最早可安排在 ${work.earliest_date}。`)
    const start = interpretEventInstant(`${day.date}T${slot.time}:00+08:00`)
    const end = start + gap.remaining_minutes * 60000
    if (end > interpretEventInstant(`${day.date}T00:00:00+08:00`) + 86400000) throw new Error('这段工作跨过午夜，请调整开始时间或拆分工作。')
    const fact = draft.planning_input.task_facts.find(f => refToken(f.task_ref) === refToken(work.task_ref))
    if (fact?.deadline_value) {
      const timed = fact.deadline_precision === 'datetime'
      const deadlineDay = timed ? beijingDateOf(fact.deadline_value) : fact.deadline_value
      const overdue = deadlineDay < (draft.planning_input.today ?? draft.planning_input.start_date)
      if (!(overdue && fact.overdue_consent) && (timed ? end > interpretEventInstant(fact.deadline_value) : day.date > deadlineDay)) {
        throw new Error('这段工作会超过任务截止时间，请提前安排。')
      }
    }
    if (intervals.some(s => start < s.end && s.start < end)) throw new Error('这个时段已有手动安排，请换个时间。')
    if (day.free_minutes < gap.remaining_minutes && slot.allowExtra !== true) throw new Error('当天剩余时间不足，请换一天或确认额外安排。')
    intervals.push({ key, start, end, date: day.date })
    const order = segments.reduce((max, s) => s.date === day.date ? Math.max(max, s.order) : max, 0) + 1
    segments.push({
      segment_key: manualSegmentKey(index), work_item_key: key, task_ref: work.task_ref,
      suggested_action_ref: work.action_ref, date: day.date, minutes: gap.remaining_minutes,
      order, action_text: `${slot.time} · ${work.deliverable}`.slice(0, 500), deliverable: work.deliverable,
    })
    day.allocated_minutes += gap.remaining_minutes
    day.free_minutes = Math.max(0, day.free_minutes - gap.remaining_minutes)
  }
  for (const slot of intervals) {
    for (const dep of items.get(slot.key).depends_on ?? []) {
      const parts = segments.filter(s => s.work_item_key === dep)
      if (!parts.length || parts.reduce((sum, s) => sum + s.minutes, 0) !== items.get(dep)?.remaining_minutes ||
        parts.some(s => s.date > slot.date) || intervals.some(s => s.key === dep && s.end > slot.start)) {
        throw new Error('请先把前置工作排完，再选择它之后的时间。')
      }
    }
  }
  const unscheduled = base.unscheduled.filter(g => !slots.has(g.work_item_key))
  if (segments.length > 700) throw new Error('本轮安排已达上限，请分批安排。')
  return { ...base, days, segments, unscheduled, complete: !unscheduled.length && !base.unknown_items.length && !base.conflicts.length }
}
