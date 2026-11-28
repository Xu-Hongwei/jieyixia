import { beijingAddDays } from './time'
import { cleanDate, createPlan, isActivePlan, planRisk } from './plan'

export function relativeDateLabel(rule) {
  const days = rule.offset_days
  if (days == null) return rule.event + '相关，办理日期待确认'
  const when = days === 0 ? '当天' : days < 0 ? `前 ${-days} 天` : `后 ${days} 天`
  if (rule.sets_deadline) return rule.event + when + '截止'
  return (days === 0 ? '' : '建议') + rule.event + when
}

export function pendingGroups(tasks) {
  const groups = new Map()
  for (const task of tasks) {
    if (!task.pending_date || !task.pending_date_group || task.status === 'done') continue
    const event = task.pending_date.event
    const key = JSON.stringify([task.matter_id ?? null, task.pending_date_group, event])
    if (!groups.has(key)) groups.set(key, { key, event, tasks: [] })
    groups.get(key).tasks.push(task)
  }
  return [...groups.values()]
}

export function eventPreview(docs, groupKey, eventDate) {
  cleanDate(eventDate)
  const group = pendingGroups(docs.filter(d => d.kind === 'task')).find(g => g.key === groupKey)
  return (group?.tasks ?? []).map(task => {
    const rule = task.pending_date
    const date = rule.offset_days == null ? null : cleanDate(beijingAddDays(eventDate, rule.offset_days))
    const actions = docs.filter(d => d.kind === 'action' && d.task_id === task.id && !d.done)
    const hasPlan = docs.some(d => d.kind === 'plan_item' && d.task_id === task.id && isActivePlan(d))
    const deadlineConflict = date && task.deadline?.value && planRisk(task, date).kind === 'after_deadline'
    const create = !!date && !hasPlan && !deadlineConflict && actions.length === 1
    return { id: task.id, title: task.title, date, create, minutes: create ? actions[0].minutes : null,
      text: create ? actions[0].text : null, deadline: !!rule.sets_deadline && !task.deadline?.value,
      suggested: create && !rule.sets_deadline && rule.offset_days !== 0,
      existingDeadline: task.deadline?.value ?? null,
      note: hasPlan ? '保留已有安排' : deadlineConflict ? '晚于已有截止，留待手动安排' : !create ? '稍后手动安排' : '' }
  }).sort((a, b) => (a.date ?? '待定').localeCompare(b.date ?? '待定') || a.id.localeCompare(b.id))
}

export function resolveEventPlan(docs, groupKey, date, expected, now, newId) {
  const rows = eventPreview(docs, groupKey, date)
  if (!rows.length || JSON.stringify(rows) !== JSON.stringify(expected)) throw new Error('关联任务已变化，请刷新并重新核对日期。')
  const puts = []
  for (const row of rows) {
    const task = docs.find(d => d.kind === 'task' && d.id === row.id)
    const updated = { ...task, updated_at: now }
    delete updated.pending_date
    delete updated.pending_date_group
    if (row.deadline) updated.deadline = { value: row.date, precision: 'date', source: 'manual', confirmed_at: now, from_note_id: null }
    if (row.create) {
      const result = createPlan([...docs.filter(d => d.id !== task.id), updated, ...puts], { ws: task.workspace_id, wallNow: now }, {
        taskId: task.id, date: row.date, plannedMinutes: row.minutes, actionText: row.text, planItemId: newId(),
      })
      if (!result.puts.length) throw new Error('已有相同安排，请刷新并核对。')
      puts.push(...result.puts)
    }
    puts.push(updated)
  }
  return { puts }
}
