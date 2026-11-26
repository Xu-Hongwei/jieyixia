import { isValidTimeValue } from './time'

/** @typedef {import('@contract/typedefs').Field} Field */
/** @typedef {import('@contract/typedefs').Note} Note */
/** @typedef {import('@contract/typedefs').AnalyzeResponse} AnalyzeResponse */
/** @typedef {import('@contract/typedefs').Task} Task */

// null 不可确认为事实；missing 是终态；已确认不重复确认。
export const canConfirm = (field) =>
  field.value != null && field.status !== 'confirmed' && field.status !== 'missing'

// 幂等重分析：同一 source 更新既有便签而非新建第二份；
// 已确认 / 用户改过的字段不被模型覆盖（AI 不得改写人工事实）。
export function mergeReanalysis(oldNote, body, now) {
  const fields = body.fields.map((nf) => {
    const old = oldNote && oldNote.fields.find((f) => f.key === nf.key)
    if (old && (old.status === 'confirmed' || old.origin === 'user')) return old
    return nf
  })
  // 新结果可能省略某键（如无可靠参照时后端移除 deadline）；已确认/用户改过的旧字段必须保留，不被丢弃
  if (oldNote) {
    for (const old of oldNote.fields) {
      if ((old.status === 'confirmed' || old.origin === 'user') && !fields.some((f) => f.key === old.key)) fields.push(old)
    }
  }
  const titleField = fields.find((f) => f.key === 'title')
  return {
    id: oldNote ? oldNote.id : crypto.randomUUID(),
    kind: 'note',
    source_id: body.source_id,
    status: 'draft',
    content_type: body.content_type,
    title: (titleField && titleField.value) || (oldNote && oldNote.title) || '未命名便签',
    fields,
    warnings: body.warnings || [],
    // 重分析不改归组事实：事项与资料角色沿用既有值（未归组便签不得有角色）。
    matter_id: (oldNote && oldNote.matter_id) || null,
    matter_role: (oldNote && oldNote.matter_id && oldNote.matter_role) || null,
    created_at: oldNote ? oldNote.created_at : now,
    updated_at: now,
  }
}

// 失败便签的标题用资料本身的可识别名字（文件名 / 文本首行），而非错误串；
// 失败状态由 status=failed 的徽标与正文提示传达，标题保持内容身份。
function failedTitle(source) {
  if (source.kind === 'text') {
    const line = String(source.text || '').split('\n').map((s) => s.trim()).find(Boolean)
    if (line) return line.length > 24 ? `${line.slice(0, 24)}…` : line
    return '文本摘录'
  }
  return source.name || '未命名截图'
}

export function failedNote(source, code, now) {
  return {
    id: crypto.randomUUID(),
    kind: 'note',
    source_id: source.id,
    status: 'failed',
    content_type: 'reference',
    title: failedTitle(source),
    fields: [],
    warnings: [],
    matter_id: null,
    matter_role: null,
    created_at: now,
    updated_at: now,
    error: code,
  }
}

// 截止必须来自已确认字段，出处可追溯；未确认返回 null，由界面提示先确认。
export function taskFromNote(note, now) {
  const dl = note.fields.find((f) => f.key === 'deadline' && f.status === 'confirmed' && f.value != null)
  if (!dl) return null
  return {
    id: crypto.randomUUID(),
    kind: 'task',
    title: note.title,
    description: '',
    matter_id: note.matter_id || null,
    note_ids: [note.id],
    deadline: {
      value: dl.value,
      precision: dl.precision || (String(dl.value).includes('T') ? 'datetime' : 'date'),
      source: 'note',
      from_note_id: note.id,
      confirmed_at: now,
    },
    status: 'todo',
    completion_criteria: null,
    current_action_id: null,
    created_at: now,
    updated_at: now,
  }
}

export function manualTask(note, value, now) {
  if (!isValidTimeValue(value)) return null
  return {
    id: crypto.randomUUID(),
    kind: 'task',
    title: note.title,
    description: '',
    matter_id: note.matter_id || null,
    note_ids: [note.id],
    deadline: {
      value,
      precision: value.includes('T') ? 'datetime' : 'date',
      source: 'manual',
      confirmed_at: now,
    },
    status: 'todo',
    completion_criteria: null,
    current_action_id: null,
    created_at: now,
    updated_at: now,
  }
}