// 本地持久化记录 ↔ 备份格式 的字段适配（纯规则）。
// 关键边界（开工单 §3）：docs 的 kind 是本地持久化元数据，不属于契约域模型
// （schema additionalProperties:false）；workspace_id 由存储层 stamp，属契约字段。
// 校验业务核心前先投影掉本地额外字段，但备份 round-trip 必须保留它们（不粗暴删非 schema 字段）。
// Source 本地用 blob(File/Blob)+name，契约用 image_ref；备份以 asset_path 指向 assets 真实字节，
// 绝不把 Blob 变成 {}，绝不把 blob: 临时 URL 写入包冒充原图。
import { IMAGE_TYPES, detectImageType } from './format'

export const DOC_KINDS = ['note', 'matter', 'task', 'action', 'focus_session', 'plan_item']
export const KIND_TO_DEF = {
  note: 'Note', matter: 'Matter', task: 'Task', action: 'Action',
  focus_session: 'FocusSession', plan_item: 'PlanItem',
}

// 每种 docs 的本地额外字段（不在契约 schema 内，校验前投影掉，备份中保留）。
// 真实写入路径审计：Note/Task 的 updated_at 是契约业务字段（schema required），不在此列；
// Action 域刻意不盖 updated_at（domains/action.js）；Matter 经通用 doc 机制（mutateDoc 通用盖戳、
// migratePlan/setMatterPlan 的 ...m 保留）可携带本地 updated_at，而契约 Matter 无此字段 → 本地额外。
export const LOCAL_ONLY_DOC_FIELDS = {
  note: ['kind', 'warnings', 'error'], // warnings：分析警告；error：失败便签错误码（均为已保存事实）
  matter: ['kind', 'updated_at'], // updated_at：改名/归组/迁移等通用写入盖的本地更新时间（契约 Matter 无）
  task: ['kind'],
  action: ['kind'],
  focus_session: ['kind'],
  plan_item: ['kind'],
}

// 会话版本解释（单一来源，镜像 domains/focus.js 的 recordVersion）：仅 record_version===1 为 v1，
// 缺省/0/其它一律按 v0 旧记录。语义校验、关系校验、恢复准备共用此解释，绝不各写一处 if。
export const focusRecordVersion = (s) => (s.record_version === 1 ? 1 : 0)

// Source 本地额外字段：blob（真实字节，导出时提取到 assets）、name（显示名）、asset_path（备份内文件指针）、
// content_version（R9 写入时按真实字节冻结的内容版本，本地绑定核对用；不进备份，恢复时由 commitRestore 重算）。
export const SOURCE_LOCAL_ONLY = ['blob', 'name', 'asset_path', 'content_version']

const clone = (v) => structuredClone(v)

// 投影掉本地额外字段 → 契约业务核心（供 schema 校验）。不修改原记录。
export function businessCoreOfDoc(record) {
  const localOnly = LOCAL_ONLY_DOC_FIELDS[record.kind] || ['kind']
  const core = clone(record)
  for (const f of localOnly) delete core[f]
  return core
}

// docs 备份记录 = 本地记录原样（kind + 业务字段 + warnings/error 全保留；docs 无 Blob，JSON 安全）。
export function docToBackup(record) {
  return clone(record)
}
export function docFromBackup(backupRecord) {
  return clone(backupRecord)
}

// 助手线程/草案：纯 JSON 契约对象（无 Blob、无本地额外字段），备份即原样克隆。
// 契约 schema additionalProperties:false 即白名单，不做投影；ops/信封/写集/租约不在备份范围。
export function assistantToBackup(record) {
  return clone(record)
}
export function assistantFromBackup(backupRecord) {
  return clone(backupRecord)
}

// 投影掉 Source 本地额外字段 → 契约业务核心。image 的 image_ref 在本地缺席（用 blob），
// schema 中 image_ref 可选，结构校验通过；「图片必须有真实字节」由 asset_path→assets 语义校验保证。
export function businessCoreOfSource(record) {
  const core = clone(record)
  for (const f of SOURCE_LOCAL_ONLY) delete core[f]
  return core
}

// 导出适配：从本地 Source 提取真实图片字节到 asset，sources.json 记录用 asset_path 替代 blob。
// 返回 { record, asset|null }。asset={ path, bytes:Uint8Array, mime }。文本资料无 asset。
// 图片缺 blob/字节 → 抛错（不生成宣称完整的备份）；无法识别的栅格类型 → 抛错（不悄悄丢失）。
export async function sourceToBackup(source) {
  const record = clone(source)
  delete record.blob
  delete record.content_version
  if (source.kind === 'image') {
    if (!source.blob || typeof source.blob.arrayBuffer !== 'function') {
      throw Object.assign(new Error(`图片资料 ${source.id} 缺少本地原图字节，无法生成完整备份`), { code: 'ASSET_MISSING', sourceId: source.id })
    }
    const bytes = new Uint8Array(await source.blob.arrayBuffer())
    const type = detectImageType(bytes)
    if (!type) {
      throw Object.assign(new Error(`图片资料 ${source.id} 不是支持的栅格类型（PNG/JPEG/WebP/GIF），无法备份`), { code: 'ASSET_TYPE_UNSUPPORTED', sourceId: source.id })
    }
    const path = `assets/${source.id}.${type.ext}`
    record.asset_path = path
    return { record, asset: { path, bytes, mime: type.mime } }
  }
  // 文本资料：完整保留 text；无 asset。
  delete record.asset_path
  return { record, asset: null }
}

// 恢复适配：用归档真实字节重建本地 Source（image→Blob；text→保留 text）。asset_path 是备份内指针，
// 不落库（落库后又是 blob 形态）。name 保留。mime 由实际字节识别，不信声明。
export function sourceFromBackup(backupRecord, assetBytes) {
  const record = clone(backupRecord)
  delete record.asset_path
  if (record.kind === 'image') {
    if (!assetBytes) {
      throw Object.assign(new Error(`图片资料 ${record.id} 缺少归档字节，无法恢复`), { code: 'ASSET_MISSING', sourceId: record.id })
    }
    const bytes = assetBytes instanceof Uint8Array ? assetBytes : new Uint8Array(assetBytes)
    const type = detectImageType(bytes)
    if (!type) {
      throw Object.assign(new Error(`图片资料 ${record.id} 归档字节不是支持的栅格类型`), { code: 'ASSET_TYPE_UNSUPPORTED', sourceId: record.id })
    }
    record.blob = new Blob([bytes], { type: type.mime })
  }
  return record
}

export const IMAGE_MIME_BY_EXT = Object.fromEntries(IMAGE_TYPES.map((t) => [t.ext, t.mime]))