// 助手上下文组装（5B-1B §5）：从一致快照构建活引用注册表 / 规划快照 / 事实基线。
// 纯函数 + 显式输入；哈希等异步工作只能在事务外调用（captureFactBaseline 供准备阶段用）。
import { windowDates } from '../../domains/planning/protocol.js'
import { assistantRefEntries } from '../../domains/assistant/refs.js'
import { canonicalJson } from '../../domains/assistant/draft.js'
import { deadlineProvenanceFieldRefs } from '../../domains/assistant/application.js'
import { sha256Hex, utf8Bytes } from '../backup/format.js'

// 资料真实内容字节（R7）：文字资料按 UTF-8 编码 text；图片按实际 Blob 字节。
// 缺少必需载荷不伪造空证据——抛错由调用方转成可解释失败。异步（Blob 读取）只能在事务外调用。
export async function sourceContentBytes(s) {
  if (s.kind === 'text' || typeof s.text === 'string') {
    if (typeof s.text !== 'string') throw Object.assign(new Error(`文字资料 ${s.id} 缺少 text 载荷，无法冻结证据指纹`), { code: 'FACT_SOURCE_PAYLOAD_MISSING' })
    return utf8Bytes(s.text)
  }
  if (s.blob) return new Uint8Array(await s.blob.arrayBuffer())
  throw Object.assign(new Error(`资料 ${s.id} 缺少 blob/text 载荷，无法冻结证据指纹`), { code: 'FACT_SOURCE_PAYLOAD_MISSING' })
}

// live：各目标类型当前捕获空间活 ID 的 Set（resolveAssistantRefs / deriveReadiness 共用）。
export function buildLiveRegistry({ sources = [], docs = [], threads = [], drafts = [] }) {
  const live = {
    source: new Set(), note: new Set(), matter: new Set(), task: new Set(),
    action: new Set(), focus_session: new Set(), plan_item: new Set(),
    thread: new Set(), draft: new Set(),
  }
  for (const s of sources) live.source.add(s.id)
  for (const d of docs) if (live[d.kind] instanceof Set) live[d.kind].add(d.id)
  for (const t of threads) live.thread.add(t.id)
  for (const d of drafts) live.draft.add(d.id)
  return live
}

// normalizePlanningContext 的 snapshot 输入：tasks/actions/plan_items + ID 清单。
// plan_items 只取窗口内（含未选中任务）；startDate 缺省取全部（调用方自滤）。
export function buildPlanningSnapshot({ workspaceId, docs = [], sources = [], turnId = null, startDate = null }) {
  const window = startDate ? new Set(windowDates(startDate)) : null
  return {
    workspace_id: workspaceId,
    turn_id: turnId,
    tasks: docs.filter((d) => d.kind === 'task'),
    actions: docs.filter((d) => d.kind === 'action'),
    plan_items: docs.filter((d) => d.kind === 'plan_item' && (!window || window.has(d.date))),
    source_ids: sources.map((s) => s.id),
    note_ids: docs.filter((d) => d.kind === 'note').map((d) => d.id),
    focus_session_ids: docs.filter((d) => d.kind === 'focus_session').map((d) => d.id),
    // M3：替换资格须反查全部会话的 plan_item_id（含运行中/暂停），只给 ID 清单不够。
    focus_sessions: docs.filter((d) => d.kind === 'focus_session'),
  }
}

// 事务外冻结事实基线：task_facts/occupancy 取自同一次计算的 PlanningInput；
// source_fingerprints 对提案证据引用的资料真实字节哈希；note_field_baselines 冻结证据字段当前值。
// 缺失资料/字段不伪造：证据指向的对象不在快照 → 抛错（调用方先做引用核对）。
export async function captureFactBaseline({ input, proposal, sources = [], docs = [], now, fullOccupancy = null }) {
  const entries = assistantRefEntries({ proposal }, 'draft')
  const sourceIds = new Set()
  const noteFields = new Map()
  for (const e of entries) {
    if (!e.path.startsWith('proposal')) continue
    const v = e.get()
    if (e.targetType === 'source' && e.namespace === 'formal' && typeof v === 'string') sourceIds.add(v)
    if (e.targetType === 'note' && e.namespace === 'formal' && /\.note_id$/.test(e.path)) {
      const m = /^(.*)\.note_id$/.exec(e.path)
      const holder = m[1].replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => (o == null ? o : o[k]), { proposal })
      if (holder && typeof holder.field_key === 'string') noteFields.set(`${v}\u0000${holder.field_key}`, { note_id: v, field_key: holder.field_key })
    }
  }
  // 截止出处字段（复验 F1 要求 4）：候选截止经 note_field/source_excerpt 可能引用的便签字段
  // 一并冻结（含同源多便签），预览后变值/取消确认/删除由 NOTE_FIELD_CHANGED 新鲜度阻断。
  for (const ref of deadlineProvenanceFieldRefs(proposal, docs.filter((d) => d.kind === 'note'))) {
    const k = `${ref.note_id}\u0000${ref.field_key}`
    if (!noteFields.has(k)) noteFields.set(k, ref)
  }
  const byId = new Map(sources.map((s) => [s.id, s]))
  const fingerprints = []
  for (const id of sourceIds) {
    const s = byId.get(id)
    if (!s) throw Object.assign(new Error(`证据资料 ${id} 不在捕获快照中，无法冻结事实基线`), { code: 'FACT_SOURCE_MISSING' })
    const bytes = await sourceContentBytes(s)
    fingerprints.push({ source_id: id, sha256: await sha256Hex(bytes), bytes: bytes.length })
  }
  if (fingerprints.length > 20) throw Object.assign(new Error('事实基线资料指纹最多 20 条'), { code: 'FACT_BASELINE_LIMIT' })
  const noteById = new Map(docs.filter((d) => d.kind === 'note').map((d) => [d.id, d]))
  const baselines = []
  for (const { note_id, field_key } of noteFields.values()) {
    const note = noteById.get(note_id)
    if (!note) throw Object.assign(new Error(`证据便签 ${note_id} 不在捕获快照中，无法冻结事实基线`), { code: 'FACT_NOTE_MISSING' })
    const field = (note.fields ?? []).find((f) => f.key === field_key)
    baselines.push({
      note_id, field_key,
      value: field ? field.value ?? null : null,
      status: field ? field.status ?? 'candidate' : 'candidate',
      origin: field ? field.origin ?? 'model' : 'model',
      derived: field ? Boolean(field.derived) : false,
    })
  }
  if (baselines.length > 200) throw Object.assign(new Error('事实基线字段快照最多 200 条'), { code: 'FACT_BASELINE_LIMIT' })
  // 正式事实基线（R6）：捕获计算前正式 Task 的标题/状态/截止，而非本次规划采用的候选截止。
  // 草案候选截止与用户确认另行由 deriveReadiness 核对；新鲜度只比较正式值，避免把预期草案差异误判为外部漂移。
  const tasksById = new Map(docs.filter((d) => d.kind === 'task').map((t) => [t.id, t]))
  const formalFacts = []
  for (const f of input.task_facts ?? []) {
    if (!f.task_ref || f.task_ref.kind !== 'existing') continue
    const t = tasksById.get(f.task_ref.id)
    if (!t) throw Object.assign(new Error(`正式目标 ${f.task_ref.id} 不在捕获快照中，无法冻结事实基线`), { code: 'FACT_TASK_MISSING' })
    const dl = t.deadline ?? { value: null, precision: 'none' }
    const precision = dl.precision ?? 'none'
    formalFacts.push({
      task_ref: { kind: 'existing', id: f.task_ref.id },
      title: t.title,
      status: t.status ?? 'todo',
      deadline_value: precision === 'none' ? null : dl.value ?? null,
      deadline_precision: precision,
      overdue_consent: false,
    })
  }
  // 复用行动内容基线（M1 审查 R5）：Action 无 updated_at，冻结预览依赖的归属/正文/估时/完成，
  // 提交重读核对；只查存在与 done 不足以发现预览后正文/估时被改。
  const actionsById = new Map(docs.filter((d) => d.kind === 'action').map((a) => [a.id, a]))
  const actionFactById = new Map()
  for (const w of input.work_items ?? []) {
    if (!w.action_ref || w.action_ref.kind !== 'existing') continue
    const a = actionsById.get(w.action_ref.id)
    if (!a) throw Object.assign(new Error(`正式行动 ${w.action_ref.id} 不在捕获快照中，无法冻结事实基线`), { code: 'FACT_ACTION_MISSING' })
    actionFactById.set(a.id, {
      action_ref: { kind: 'existing', id: a.id },
      task_id: a.task_id, text: a.text, minutes: a.minutes, done: Boolean(a.done),
    })
  }
  return {
    captured_at: now,
    task_facts: formalFacts,
    action_facts: [...actionFactById.values()],
    source_fingerprints: fingerprints,
    note_field_baselines: baselines,
    // M3：原始事实基线保留完整 O；改排的有效占用只在 planning_input，不覆盖原基线。
    occupancy: fullOccupancy ?? input.occupancy ?? [],
  }
}

// 证据内容新鲜度（R7，事务外异步）：对冻结指纹指向的资料重算真实内容字节哈希，对照基线。
// 只报内容漂移（SOURCE_CONTENT_CHANGED）；资料缺失由 checkFactFreshness 同步报 SOURCE_MISSING，不重复。
export async function checkSourceContentFreshness(baseline, sources = []) {
  const diffs = []
  const byId = new Map(sources.map((s) => [s.id, s]))
  for (const fp of baseline?.source_fingerprints ?? []) {
    const s = byId.get(fp.source_id)
    if (!s) continue
    const bytes = await sourceContentBytes(s)
    const sha = await sha256Hex(bytes)
    if (sha !== fp.sha256 || bytes.length !== fp.bytes) {
      diffs.push({ kind: 'source', code: 'SOURCE_CONTENT_CHANGED', message: `证据资料 ${fp.source_id} 原文已变化，旧草案证据过期` })
    }
  }
  return diffs
}

// 证据资料同步绑定（R7/R9）：供事务内核对「重摘要后资料记录未变」，不在活事务内等待哈希。
// 文字含全文；图片含写入时按真实字节冻结的 content_version（R9）——同尺寸/同名/同类型而字节不同
// 也会使绑定变化。记录被替换即绑定变化，提交转冲突要求重新核对。
export function sourceBindingDigest(sources = [], ids = new Set()) {
  const recs = sources
    .filter((s) => ids.has(s.id))
    .map((s) => ({
      id: s.id, kind: s.kind, captured_at: s.captured_at ?? null,
      text: typeof s.text === 'string' ? s.text : null,
      content_version: s.content_version ?? null,
      blob_size: s.blob ? s.blob.size : null, blob_type: s.blob ? s.blob.type : null,
      name: s.name ?? null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return canonicalJson(recs)
}