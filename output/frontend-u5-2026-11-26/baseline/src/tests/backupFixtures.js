// 虚构夹具（纯测试脚手架，独立于生产 fixtures，不含任何真实校名/姓名/群号）。
// 提供：完整虚构空间 → 备份归档模型（含真实 SHA-256 的 manifest），以及各类负向变体。
// 归档模型 { entries:[{path,bytes:Uint8Array}] } 与 4-0 校验器口径一致；不打包真实 ZIP。
import {
  buildManifest, MANIFEST_PATH, SOURCES_PATH, DOCS_PATH,
  ASSISTANT_THREADS_PATH, ASSISTANT_DRAFTS_PATH,
  utf8Bytes, sha256Hex, BACKUP_FORMAT_VERSION, SCHEMA_VERSION,
} from '@/services/backup/format'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
export const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))

export const WS = { id: 'ws-src', name: '虚构来源空间', is_demo: false }
const T = (s) => s // 全部时间带明确 +08:00 偏移（北京），夹具不依赖设备时区

// 完整虚构空间的备份记录（sources 用 asset_path 形态；docs 含本地 kind/warnings）。
export function fictionalRecords() {
  const sources = [
    { id: 'src-img', workspace_id: WS.id, kind: 'image', captured_at: T('2026-11-20T09:00:00+08:00'), asset_path: 'assets/src-img.png', name: '通知截图.png', is_demo: false },
    { id: 'src-txt', workspace_id: WS.id, kind: 'text', captured_at: T('2026-11-20T09:05:00+08:00'), text: '请在本周五前提交实验报告，字数不超过2000字。', is_demo: false },
  ]
  const noteFields = [
    { key: 'deadline', value: '2026-11-27', raw: '本周五前', origin: 'model', status: 'confirmed', derived: false, quote: { text: '本周五前提交', source_id: 'src-img' }, precision: 'date', tz_known: false },
    { key: 'requirement', value: '提交实验报告', raw: '提交实验报告', origin: 'model', status: 'confirmed', derived: false, quote: { text: '提交实验报告', source_id: 'src-img' } },
    { key: 'time_nodes', value: [{ label: '提交截止', raw: '本周五前', value: '2026-11-27', precision: 'date', tz_known: false, basis: 'explicit', role: 'submission_deadline', reference_at: null, reference_source: null, message_date: '2026-11-20', derived: false }], raw: '', origin: 'model', status: 'confirmed', derived: false, quote: null },
  ]
  const snapTask = { title: '完成实验报告', matter_name: '实验报告', deadline_value: '2026-11-27', deadline_precision: 'date', captured_at: T('2026-11-21T10:00:00+08:00') }
  const docs = [
    { id: 'note-1', workspace_id: WS.id, kind: 'note', source_id: 'src-img', status: 'reviewed', content_type: 'notice', title: '实验报告提交通知', fields: noteFields, matter_id: 'matter-1', matter_role: 'requirement', created_at: T('2026-11-20T09:10:00+08:00'), updated_at: T('2026-11-20T09:20:00+08:00'), reviewed_at: T('2026-11-20T09:20:00+08:00'), is_demo: false, warnings: [] },
    { id: 'matter-1', workspace_id: WS.id, kind: 'matter', title: '实验报告', note_ids: ['note-1'], created_at: T('2026-11-20T09:15:00+08:00'), is_demo: false },
    { id: 'task-1', workspace_id: WS.id, kind: 'task', title: '完成实验报告', description: '', matter_id: 'matter-1', note_ids: ['note-1'], deadline: { value: '2026-11-27', precision: 'date', source: 'note', from_note_id: 'note-1', confirmed_at: T('2026-11-20T09:25:00+08:00') }, status: 'todo', completion_criteria: null, current_action_id: 'action-1', created_at: T('2026-11-20T09:30:00+08:00'), updated_at: T('2026-11-20T09:30:00+08:00'), is_demo: false },
    { id: 'action-1', workspace_id: WS.id, kind: 'action', task_id: 'task-1', text: '撰写报告正文', minutes: 60, basis: 'user', done: false, created_at: T('2026-11-20T09:31:00+08:00') },
    { id: 'action-2', workspace_id: WS.id, kind: 'action', task_id: 'task-1', text: '检查字数与格式', minutes: 20, basis: 'suggestion', done: false, created_at: T('2026-11-20T09:32:00+08:00') },
    // 已结束 v1 会话（含计划反向关联）
    { id: 'focus-ended', workspace_id: WS.id, kind: 'focus_session', task_id: 'task-1', action_id: 'action-1', plan_item_id: 'plan-1', started_at: T('2026-11-21T10:00:00+08:00'), accumulated_ms: 1800000, running: false, draft_md: '已完成初稿', outcome: 'partial', blocker: null, ended_at: T('2026-11-21T10:30:00+08:00'), is_demo: false, record_version: 1, timer_anchor_at: null, task_snapshot: snapTask, action_snapshot: { text: '撰写报告正文', minutes: 60, captured_at: T('2026-11-21T10:00:00+08:00') }, task_ref_state: 'active', action_ref_state: 'active' },
    { id: 'plan-1', workspace_id: WS.id, kind: 'plan_item', task_id: 'task-1', date: '2026-11-21', planned_minutes: 60, action_text: '撰写报告正文', state: 'partial', actual_minutes: 30, focus_session_id: 'focus-ended', order: 0, task_ref_state: 'active' },
    // 未结束（暂停）v1 会话：恢复后应暂停待核对，不自动计时
    { id: 'focus-paused', workspace_id: WS.id, kind: 'focus_session', task_id: 'task-1', action_id: 'action-2', plan_item_id: null, started_at: T('2026-11-22T09:00:00+08:00'), accumulated_ms: 600000, running: false, draft_md: '检查中', outcome: null, blocker: null, ended_at: null, is_demo: false, record_version: 1, timer_anchor_at: null, task_snapshot: { ...snapTask, captured_at: T('2026-11-22T09:00:00+08:00') }, action_snapshot: { text: '检查字数与格式', minutes: 20, captured_at: T('2026-11-22T09:00:00+08:00') }, task_ref_state: 'active', action_ref_state: 'active' },
    // 已结束 v1 会话，任务/行动均已删（历史标识，不得解析到活对象）
    { id: 'focus-deleted', workspace_id: WS.id, kind: 'focus_session', task_id: 'task-gone', action_id: 'action-gone', plan_item_id: null, started_at: T('2026-11-18T14:00:00+08:00'), accumulated_ms: 300000, running: false, draft_md: '', outcome: 'done', blocker: null, ended_at: T('2026-11-18T14:05:00+08:00'), is_demo: false, record_version: 1, timer_anchor_at: null, task_snapshot: { title: '旧任务', matter_name: null, deadline_value: null, deadline_precision: 'none', captured_at: T('2026-11-18T14:00:00+08:00') }, action_snapshot: { text: '旧行动', minutes: 5, captured_at: T('2026-11-18T14:00:00+08:00') }, task_ref_state: 'deleted', action_ref_state: 'deleted' },
    // v0 旧会话（无 v1 字段），引用仍解析到活对象
    { id: 'focus-v0', workspace_id: WS.id, kind: 'focus_session', task_id: 'task-1', action_id: 'action-1', plan_item_id: null, started_at: T('2026-11-19T08:00:00+08:00'), accumulated_ms: 900000, running: false, draft_md: '', outcome: 'done', blocker: null, ended_at: T('2026-11-19T08:15:00+08:00'), is_demo: false, record_version: 0 },
  ]
  const assets = new Map([['assets/src-img.png', PNG_BYTES]])
  return { sources, docs, assets }
}

// 组装归档模型：按实际字节算 SHA-256 与字节数，生成 manifest 与全部 entries。
// formatVersion 缺省 1（旧格式回归夹具）；2 时写入助手 wrapper 载荷（空数组也写入）。
export async function assembleArchive({
  workspace = WS, sources, docs, assets, backupId = 'bk-fictional-0001', exportedAt = '2026-11-22T15:30:00+08:00',
  formatVersion = 1, assistantThreads = [], assistantDrafts = [],
}) {
  const counts = {}
  for (const d of docs) counts[d.kind] = (counts[d.kind] || 0) + 1
  const imageCount = sources.filter((s) => s.kind === 'image').length
  const payloads = []
  const entries = []
  const pushJson = (path, value) => {
    const bytes = utf8Bytes(JSON.stringify(value))
    entries.push({ path, bytes })
    payloads.push({ path, bytes: bytes.length, sha256: null })
    return bytes
  }
  const srcBytes = pushJson(SOURCES_PATH, sources)
  const docBytes = pushJson(DOCS_PATH, docs)
  if (formatVersion === 2) {
    pushJson(ASSISTANT_THREADS_PATH, { schema_version: SCHEMA_VERSION, threads: assistantThreads })
    pushJson(ASSISTANT_DRAFTS_PATH, { schema_version: SCHEMA_VERSION, drafts: assistantDrafts })
  }
  for (const [path, bytes] of assets) {
    entries.push({ path, bytes })
    payloads.push({ path, bytes: bytes.length, sha256: null })
  }
  // 逐载荷按实际字节填哈希（manifest 不列自身）。
  const byPath = new Map(entries.map((e) => [e.path, e.bytes]))
  for (const p of payloads) p.sha256 = await sha256Hex(byPath.get(p.path))
  const manifest = buildManifest({
    backupId, exportedAt, sourceWorkspace: workspace, counts,
    sourceCount: sources.length, imageCount, payloads, formatVersion,
    assistantThreadCount: assistantThreads.length, assistantDraftCount: assistantDrafts.length,
  })
  const manifestBytes = utf8Bytes(JSON.stringify(manifest))
  entries.unshift({ path: MANIFEST_PATH, bytes: manifestBytes })
  return { entries, manifest, sources, docs, assets, srcBytes, docBytes, assistantThreads, assistantDrafts }
}

export async function buildCompleteBackup() {
  const { sources, docs, assets } = fictionalRecords()
  return assembleArchive({ sources, docs, assets })
}

// 用改动后的记录重新组装（A 层干净，便于单独触发 B/C 层错误）。
export async function rebuild(mutate) {
  const { sources, docs, assets } = fictionalRecords()
  const m = mutate({ sources, docs, assets, workspace: WS }) || {}
  return assembleArchive({
    workspace: m.workspace || WS,
    sources: m.sources || sources,
    docs: m.docs || docs,
    assets: m.assets || assets,
    formatVersion: m.formatVersion ?? 1,
    assistantThreads: m.assistantThreads || [],
    assistantDrafts: m.assistantDrafts || [],
  })
}

export const findDoc = (docs, id) => docs.find((d) => d.id === id)
export { BACKUP_FORMAT_VERSION, SCHEMA_VERSION }