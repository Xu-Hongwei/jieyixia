// 3B-2 执行页/工作记录的纯视图助手：时长格式化、历史排序/筛选、任务资料解析。
// 不触库、不依赖 Vue；会话事实仍由 focus service/store 提供。
import { beijingDateStr } from './time.js'

const p2 = (n) => String(n).padStart(2, '0')

// 累计毫秒 → 时钟样式（mm:ss，超过 1 小时 h:mm:ss）。先求和再格式化，不按段取整相加。
export function formatDurationMs(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0))
  const s = Math.floor(total / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`
}

// 已结束历史：按结束时间倒序；同时间按 id 稳定排序（不依赖输入顺序）。
export function endedSessionsSorted(sessions) {
  return (sessions || [])
    .filter((s) => s && s.ended_at != null)
    .slice()
    .sort((a, b) => {
      const av = Date.parse(a.ended_at)
      const bv = Date.parse(b.ended_at)
      if (av !== bv) return bv - av
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

// 日期范围按结束时刻的北京日期判定（含边界）；搜索匹配任务/行动快照标题（无快照不伪造现名称）。
export function filterWorkRecords(list, { from = '', to = '', query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase()
  return (list || []).filter((s) => {
    if (from || to) {
      const day = beijingDateStr(new Date(s.ended_at))
      if (from && day < from) return false
      if (to && day > to) return false
    }
    if (!q) return true
    const title = (s.task_snapshot && s.task_snapshot.title) || ''
    const action = (s.action_snapshot && s.action_snapshot.text) || ''
    return title.toLowerCase().includes(q) || action.toLowerCase().includes(q)
  })
}

// 任务资料解析：直接关联 = note_ids ∪ 截止出处便签；同事项补充 = matter.note_ids 去除直接项。
// 按 ID 去重、校验对象归属（便签须属于当前空间列表）；缺失引用保留 id 供「资料已缺失」说明。
export function taskMaterials(task, notes, matters) {
  if (!task) return { direct: [], extra: [] }
  const ids = new Set(task.note_ids || [])
  if (task.deadline && task.deadline.from_note_id) ids.add(task.deadline.from_note_id)
  const resolve = (id) => notes.find((n) => n.id === id) || null
  const direct = [...ids].map((id) => ({ id, note: resolve(id) }))
  const matter = task.matter_id ? (matters || []).find((m) => m.id === task.matter_id) : null
  const extra = matter
    ? (matter.note_ids || []).filter((id) => !ids.has(id)).map((id) => ({ id, note: resolve(id) }))
    : []
  return { direct, extra }
}

// 会话标题/行动展示：优先开始快照；v0 无快照返回 null，由界面标注「旧记录无快照」。
export const sessionTitle = (s) => (s && s.task_snapshot && s.task_snapshot.title) || null
export const sessionActionText = (s) => (s && s.action_snapshot && s.action_snapshot.text) || null