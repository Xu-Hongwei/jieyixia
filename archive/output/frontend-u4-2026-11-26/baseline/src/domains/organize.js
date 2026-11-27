// 阶段 2 本地组织规则（纯前端，不改契约）：便签状态分组 / 收集箱搜索筛选 / 今天任务分区 / 事项关联。
import { beijingDateStr, interpretInstant, isOverdue, isToday } from './time'

// 便签三态只看字段终态：整体「已审阅」不替代字段确认，关键未确认仍归待核对。
export function noteBucket(note) {
  if (!note) return 'pending'
  if (note.status === 'failed') return 'failed'
  const fields = note.fields || []
  const settled = fields.length > 0 && fields.every((f) => f.status === 'confirmed' || f.status === 'missing')
  return settled ? 'confirmed' : 'pending'
}

// 仍待用户核对/确认的字段（已审阅便签也要据此提示，不被整体状态掩盖）。
export const pendingFields = (note) => ((note && note.fields) || []).filter((f) => f.status === 'candidate' || f.status === 'unresolved')

export const BUCKET_LABELS = { pending: '待核对', failed: '失败', confirmed: '已确认' }
export const BUCKET_ORDER = ['pending', 'failed', 'confirmed']

// 删除便签的影响面：note_ids 引用 ∪ deadline.from_note_id 引用，按任务 ID 去重（联删决定）。
export function linkedTasksOf(tasks, noteId) {
  const out = []
  const seen = new Set()
  for (const t of tasks) {
    const hit = (t.note_ids || []).includes(noteId) || (t.deadline && t.deadline.from_note_id === noteId)
    if (hit && !seen.has(t.id)) {
      seen.add(t.id)
      out.push(t)
    }
  }
  return out
}

// 多便签共享的任务：联删时整体删除，确认框必须说明。
export const isSharedTask = (task) => (task.note_ids || []).length > 1

// 收集箱一行 = 原始资料 + 其便签（可无）+ 所属事项名（可无）。
export function sourceRow(source, note, matterTitle = '') {
  return { source, note, bucket: note ? noteBucket(note) : 'none', matterTitle: matterTitle || '' }
}

// P06 搜索面：已保存的字段原文 raw、引用 quote.text、字符串值（含摘要/关键词/数组项）与节点标签原文。
function fieldTexts(note) {
  const out = []
  for (const f of (note && note.fields) || []) {
    if (f.raw) out.push(String(f.raw))
    if (f.quote && f.quote.text) out.push(String(f.quote.text))
    const v = f.value
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') out.push(item)
        else if (item && typeof item === 'object') {
          if (item.label) out.push(String(item.label))
          if (item.raw) out.push(String(item.raw))
          if (typeof item.value === 'string') out.push(item.value)
        }
      }
    }
  }
  return out
}

// 筛选：资料形态（image/text）、内容类型（notice/tutorial/reference）、核对状态、收集日期范围（北京日界）。
export function rowMatches(row, query, kindFilter, statusFilter, options = {}) {
  const { source, note, bucket } = row
  const { contentType = 'all', from = '', to = '' } = options
  if (kindFilter !== 'all' && source.kind !== kindFilter) return false
  if (contentType !== 'all' && (!note || note.content_type !== contentType)) return false
  if (statusFilter !== 'all') {
    if (statusFilter === 'none' && bucket !== 'none') return false
    if (statusFilter !== 'none' && bucket !== statusFilter) return false
  }
  if (from || to) {
    const ms = interpretInstant(source.captured_at)
    if (ms == null) return false
    const day = beijingDateStr(ms)
    if (from && day < from) return false
    if (to && day > to) return false
  }
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  const hay = [source.name || '', source.text || '', (note && note.title) || '', row.matterTitle || '', ...fieldTexts(note)]
    .join('\n')
    .toLowerCase()
  return hay.includes(q)
}

// 今天任务分区：逾期 / 今日 / 稍后 / 已完成。逾期与今日互斥（逾期优先），均不含 done。
export function partitionTasks(tasks, nowD = new Date()) {
  const out = { overdue: [], today: [], upcoming: [], done: [] }
  for (const t of tasks) {
    if (t.status === 'done') { out.done.push(t); continue }
    if (isOverdue(t, nowD)) out.overdue.push(t)
    else if (t.deadline && t.deadline.value && isToday(t.deadline.value, t.deadline.precision, nowD)) out.today.push(t)
    else out.upcoming.push(t)
  }
  return out
}

// 事项目录与成员（契约 Matter：便签/任务按 matter_id 关联，手动归组非 AI）。
export const mattersOf = (docs) => docs.filter((d) => d.kind === 'matter')
export const membersOf = (docs, matterId) => docs.filter((d) => (d.kind === 'task' || d.kind === 'note') && d.matter_id === matterId)
export const matterNotesOf = (docs, matterId) => docs.filter((d) => d.kind === 'note' && d.matter_id === matterId)
export const matterTasksOf = (docs, matterId) => docs.filter((d) => d.kind === 'task' && d.matter_id === matterId)
export const ungroupedOf = (docs) => docs.filter((d) => (d.kind === 'task' || d.kind === 'note') && !d.matter_id)
export const matterTitleOf = (docs, matterId) => {
  if (!matterId) return ''
  const m = docs.find((d) => d.kind === 'matter' && d.id === matterId)
  return m ? m.title : ''
}

// 排序辅助：收集箱按北京收集时刻倒序/正序（明确偏移可比）。
export function byCaptured(rows, dir = 'desc') {
  const ms = (r) => interpretInstant(r.source.captured_at) ?? 0
  return rows.slice().sort((a, b) => (dir === 'desc' ? ms(b) - ms(a) : ms(a) - ms(b)))
}

export { beijingDateStr }