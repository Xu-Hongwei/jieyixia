// 完整 ID 重建与引用重写（纯规则，零写入）。开工单 §6。
// sources/docs 共用 store 按 id 键：只改 workspace_id 会覆盖原空间，故预生成目标空间 ID + 全量 ID 映射后再提交。
// 活对象全部换新 ID；所有 workspace_id→目标；定义好的引用路径按类型重写；deleted/缺失历史 ID→独立隔离新标识
// （跨记录一致，绝不与活 ID 冲突）。绝不整段 JSON 字符串替换（草稿/quote 原文/标题/URL 里出现旧 ID 不是引用）。
// asset_path 是归档文件指针，豁免 ID 重写（恢复时按它取字节，新 source.id 与文件名无关）。
// 起始快照/已结束 outcome/时间/accumulated 原值保留；恢复空间与活记录 is_demo=false。
import { DOC_KINDS } from './adapt'
import { assistantRefEntries } from '@/domains/assistant/refs'

const clone = (v) => structuredClone(v)
const defaultNewId = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}-${Date.now()}`)

// 每种 docs 的「定义好的引用路径」（只这些字段是引用，其余文本一律不动）。
// 返回 [{ get, set }] 访问器对，便于结构化读写而不碰原文。
function refAccessors(record) {
  /** @type {{ get: () => any, set: (v: any) => void, each?: (fn: (x: any) => any) => void }[]} */
  const acc = []
  const scalar = (key) => acc.push({ get: () => record[key], set: (v) => { record[key] = v } })
  const list = (key) => acc.push({
    get: () => record[key],
    set: (v) => { record[key] = v },
    each: (fn) => { if (Array.isArray(record[key])) record[key] = record[key].map(fn) },
  })
  switch (record.kind) {
    case 'note':
      scalar('source_id'); scalar('matter_id')
      // 嵌套 Quote.source_id（fields[].quote）。
      if (Array.isArray(record.fields)) {
        record.fields.forEach((f, i) => {
          if (f && f.quote && typeof f.quote === 'object') {
            acc.push({ get: () => f.quote.source_id, set: (v) => { record.fields[i].quote.source_id = v } })
          }
        })
      }
      break
    case 'matter': list('note_ids'); break
    case 'task':
      scalar('matter_id'); list('note_ids'); scalar('current_action_id')
      if (record.deadline && typeof record.deadline === 'object') {
        acc.push({ get: () => record.deadline.from_note_id, set: (v) => { record.deadline.from_note_id = v } })
      }
      break
    case 'action': scalar('task_id'); break
    case 'focus_session': scalar('task_id'); scalar('action_id'); scalar('plan_item_id'); break
    case 'plan_item': scalar('task_id'); scalar('focus_session_id'); break
    default: break
  }
  return acc
}

// 收集一条记录引用到的所有旧 ID（含数组元素与嵌套 quote），用于历史隔离映射。
function referencedIds(record) {
  const ids = []
  for (const a of refAccessors(record)) {
    const v = a.get()
    if (Array.isArray(v)) v.forEach((x) => { if (typeof x === 'string' && x) ids.push(x) })
    else if (typeof v === 'string' && v) ids.push(v)
  }
  return ids
}

// 构建全量映射并重写。newId 可注入（测试用确定性计数器）；默认 crypto.randomUUID。
// assistantThreads/assistantDrafts：v2 助手记录（v1 缺省空）。助手引用只按 refs.js 类型化路径表的
// formal 命名空间重写；draft_key/local_key/turn/date 与正文一律不动；application_id 不是引用路径，不查 ops。
// 返回 { targetWorkspace, sources, docs, assistantThreads, assistantDrafts, liveMap, historyMap, remappedManifest }。
export function buildRemap({ manifest, sources, docs, assistantThreads = [], assistantDrafts = [], targetWorkspaceId, targetName, createdAt, newId = defaultNewId }) {
  const liveMap = new Map()
  for (const s of sources) liveMap.set(s.id, newId())
  for (const d of docs) if (DOC_KINDS.includes(d.kind)) liveMap.set(d.id, newId())
  for (const t of assistantThreads) liveMap.set(t.id, newId())
  for (const d of assistantDrafts) liveMap.set(d.id, newId())

  // 历史/缺失引用：被引用但不是包内活对象的 ID → 独立隔离新标识（跨记录一致）。
  const historyMap = new Map()
  for (const d of docs) {
    if (!DOC_KINDS.includes(d.kind)) continue
    for (const id of referencedIds(d)) {
      if (!liveMap.has(id) && !historyMap.has(id)) historyMap.set(id, newId())
    }
  }
  const assistantFormalValues = (record, type) =>
    assistantRefEntries(record, type).filter((e) => e.namespace === 'formal').map((e) => e.get()).filter((v) => typeof v === 'string' && v)
  for (const t of assistantThreads) {
    for (const id of assistantFormalValues(t, 'thread')) {
      if (!liveMap.has(id) && !historyMap.has(id)) historyMap.set(id, newId())
    }
  }
  for (const d of assistantDrafts) {
    for (const id of assistantFormalValues(d, 'draft')) {
      if (!liveMap.has(id) && !historyMap.has(id)) historyMap.set(id, newId())
    }
  }
  const mapId = (id) => (id == null ? id : (liveMap.get(id) ?? historyMap.get(id) ?? id))

  const remapSource = (s) => {
    const r = clone(s)
    r.id = liveMap.get(s.id)
    r.workspace_id = targetWorkspaceId
    r.is_demo = false
    // asset_path 豁免：保持指向归档原文件。
    return r
  }
  const remapDoc = (d) => {
    const r = clone(d)
    r.id = liveMap.get(d.id)
    r.workspace_id = targetWorkspaceId
    if ('is_demo' in r) r.is_demo = false
    for (const a of refAccessors(r)) {
      if (a.each) a.each((x) => mapId(x))
      else { const v = a.get(); if (v != null) a.set(mapId(v)) }
    }
    return r
  }

  // 助手记录：只重写 formal 命名空间路径（含 revision_history 递归与 applied_summary.id_map.formal_id）。
  // draft_key/local_key/turn/date 命名空间与 application_id/正文一律保留原值。
  const remapAssistant = (record, type) => {
    const r = clone(record)
    r.id = liveMap.get(record.id)
    r.workspace_id = targetWorkspaceId
    for (const e of assistantRefEntries(r, type)) {
      if (e.namespace !== 'formal') continue
      const v = e.get()
      if (v != null) e.set(mapId(v))
    }
    return r
  }

  const outSources = sources.map(remapSource)
  const outDocs = docs.map((d) => (DOC_KINDS.includes(d.kind) ? remapDoc(d) : clone(d)))
  const outThreads = assistantThreads.map((t) => remapAssistant(t, 'thread'))
  const outDrafts = assistantDrafts.map((d) => remapAssistant(d, 'draft'))
  const targetWorkspace = { id: targetWorkspaceId, name: targetName, is_demo: false, created_at: createdAt }
  // 重校验用 manifest：来源空间指向目标（counts/payloads 不变；字节哈希在 4-2 真正落库前按重序列化重算）。
  const remappedManifest = { ...clone(manifest), source_workspace: { id: targetWorkspaceId, name: targetName, is_demo: false } }
  return { targetWorkspace, sources: outSources, docs: outDocs, assistantThreads: outThreads, assistantDrafts: outDrafts, liveMap, historyMap, remappedManifest }
}

export { referencedIds, refAccessors }