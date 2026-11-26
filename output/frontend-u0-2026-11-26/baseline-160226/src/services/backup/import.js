// 4-2 备份恢复作业协调（开工单 §4/§5/§8）。纯编排，零数据库写入、零网络、零模型调用。
// 管线：File 字节+SHA-256 指纹 → 受限解码 → 4-0 三层校验 → 冻结准备数据 → 全量 ID 重建 →
//   未结束会话安全转换 → 目标记录级复检 → Source→本地 Blob → 交 commitRestore 原子提交。
// 预览与提交共用同一份已校验数据（validateBackup 返回的 sources/docs/assets），绝不二次解析未校验对象。
// 大字节/临时资源由调用方按作业生命周期释放；本模块不持有全局引用，取消经 AbortSignal 传导。
import { decodeArchiveBounded } from './zip'
import { validateBackup, validateRecords } from './validate'
import { buildRemap } from './remap'
import { buildRecoveryPlan, restoreAssistantDrafts } from './recovery'
import { sourceFromBackup, DOC_KINDS } from './adapt'
import { LIMITS, sha256Hex, defaultRestoreName, detectImageType } from './format'
import { beijingParts } from '@/domains/time'

const zerr = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {})
const cancelled = () => zerr('ZIP_CANCELLED', '已取消检查')
const zipTooLarge = (size) => zerr('ZIP_TOO_LARGE', `备份压缩文件超过上限 ${LIMITS.ZIP_MAX_BYTES} 字节（实际 ${size}），请减少资料后重试`)

// 检查备份文件（选择→正在检查阶段，零写入、不建空空间、不切全局空间）。
// 先按 File.size 预检，再读实际压缩字节复检；SHA-256 按原始字节（文件身份，非文件名/大小）。
// 受限解码可取消；解码后过 4-0 A/B/C 校验。返回统一结果（含与校验同一份的已解析业务数据）。
export async function inspectBackupFile(file, opts = {}) {
  const { signal, onProgress } = opts
  if (!file || typeof file.arrayBuffer !== 'function') throw zerr('BAD_FILE', '请选择一个备份 ZIP 文件')
  if (file.size > LIMITS.ZIP_MAX_BYTES) throw zipTooLarge(file.size)
  const zipBytes = new Uint8Array(await file.arrayBuffer())
  if (signal?.aborted) throw cancelled()
  if (zipBytes.length > LIMITS.ZIP_MAX_BYTES) throw zipTooLarge(zipBytes.length)
  const fingerprint = await sha256Hex(zipBytes)
  if (signal?.aborted) throw cancelled()
  const { entries } = await decodeArchiveBounded(zipBytes, { signal, onProgress })
  if (signal?.aborted) throw cancelled()
  const v = await validateBackup({ entries, zipBytes })
  if (signal?.aborted) throw cancelled()
  // entries 与 zipBytes 在此之后不再被引用（sources/docs/assets 已承载必要数据），可被回收。
  return {
    filename: file.name || '备份.zip',
    fileSize: zipBytes.length,
    fingerprint,
    ok: v.ok,
    errors: v.errors,
    notes: v.notes,
    manifest: v.manifest,
    summary: v.summary,
    sources: v.sources,
    docs: v.docs,
    assets: v.assets,
    assistantThreads: v.assistantThreads ?? [],
    assistantDrafts: v.assistantDrafts ?? [],
  }
}

const p2 = (n) => String(n).padStart(2, '0')
// 导出时刻的北京日期时间标签（manifest.exported_at 可能为 Z 或 +08:00，统一按北京解释）。
export function beijingLabel(iso) {
  if (typeof iso !== 'string') return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const b = beijingParts(d)
  return `${b.year}-${p2(b.month)}-${p2(b.day)} ${p2(b.hour)}:${p2(b.minute)}:${p2(b.second)}`
}

// 预览摘要（仅摘要，不渲染全图/巨草稿）。默认名用既有 defaultRestoreName；转换提示固定。
export function restorePreview(inspected, { now = new Date() } = {}) {
  const m = inspected.manifest || {}
  const sw = m.source_workspace || {}
  let imageBytes = 0
  if (inspected.assets instanceof Map) for (const bytes of inspected.assets.values()) imageBytes += bytes.length
  const threads = inspected.assistantThreads ?? []
  const drafts = inspected.assistantDrafts ?? []
  const draftStatusCounts = {}
  for (const d of drafts) draftStatusCounts[d.status] = (draftStatusCounts[d.status] || 0) + 1
  const transforms = [
    '恢复到一个新空间，不覆盖、不合并原空间',
    '所有对象重建为新 ID，引用按契约路径重写',
    '未结束的工作转为暂停，进入后须核对用时再显式继续',
  ]
  if (drafts.length) {
    transforms.push('旧保存结果不能由本次备份恢复推定，须重新核对；未应用草案转为待核对，不自动执行旧确认或创建日程')
  }
  return {
    filename: inspected.filename,
    fileSize: inspected.fileSize,
    sourceWorkspaceName: sw.name ?? null,
    sourceWorkspaceIsDemo: !!sw.is_demo,
    exportedAt: m.exported_at ?? null,
    exportedAtBeijing: beijingLabel(m.exported_at),
    backupFormatVersion: m.backup_format_version ?? null,
    schemaVersion: m.schema_version ?? null,
    counts: m.counts ?? null,
    sourceCount: m.source_count ?? null,
    imageCount: m.image_count ?? null,
    imageBytes,
    unfinishedCount: inspected.summary?.unfinishedCount ?? 0,
    assistantThreadCount: threads.length,
    assistantDraftCount: drafts.length,
    assistantDraftStatusCounts: draftStatusCounts,
    defaultName: defaultRestoreName(sw.name || '空间', now),
    notes: inspected.notes || [],
    transforms,
  }
}

// 冻结 ID 映射的确定性签名（幂等绑定的一部分）：活+历史映射按键排序后规范化 JSON。
// 同步、无加密依赖；同意图重试逐字符比对，映射不同即拒绝（绝不靠弱哈希碰运气）。
const sortEntries = (m) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
const mapSignature = (liveMap, historyMap) =>
  JSON.stringify({ live: sortEntries(liveMap), history: sortEntries(historyMap) })

// 准备恢复数据（确认意图时冻结；纯函数，零写入）。同一意图重试复用同一 prepared，绝不重新随机 ID。
// newId 可注入（测试用确定性计数器）；缺省 crypto.randomUUID。nowMs/createdAt 可注入固定时刻。
export function prepareRestore(opts = {}) {
  const { inspected, targetWorkspaceId, targetName, operationId, createdAt, nowMs, newId } = opts
  if (!inspected || !inspected.ok) throw zerr('NOT_VALIDATED', '备份未通过校验，不能准备恢复')
  if (!operationId) throw zerr('BAD_OPERATION', '缺少恢复作业标识')
  if (targetWorkspaceId === 'personal' || targetWorkspaceId === 'demo') throw zerr('BAD_TARGET', '恢复目标不能是个人空间或演示空间')
  const name = String(targetName == null ? '' : targetName).trim()
  if (!name || name.length > 80) throw zerr('BAD_NAME', '恢复空间名须为 1–80 个字符（去除首尾空白后）')
  const now = nowMs ?? Date.now()
  const created = createdAt || new Date(now).toISOString()
  const manifest = inspected.manifest

  // 1. 全量 ID 重建 + 契约引用路径重写 + 历史隔离（冻结 liveMap/historyMap，含助手线程/草案）。
  const remap = buildRemap({
    manifest, sources: inspected.sources, docs: inspected.docs,
    assistantThreads: inspected.assistantThreads ?? [], assistantDrafts: inspected.assistantDrafts ?? [],
    targetWorkspaceId, targetName: name, createdAt: created, newId,
  })
  // 2. 未结束会话安全转换（v1 暂停+过期占位 runtime；v0 仅暂停）+ 目标 runtime 由应用重建。
  const recovery = buildRecoveryPlan({ docs: remap.docs, workspaceId: targetWorkspaceId, nowMs: now })
  // 2b. 助手草案去授权：状态按冻结 RESTORE_MAP，清事实基线与可执行确认，内容保留。
  const restoredDrafts = restoreAssistantDrafts(remap.assistantDrafts)
  // 3. 目标记录级复检：保留 asset_path 形态过 B+C（不重检原载荷哈希——remap 后 JSON 已变）。
  const recheck = validateRecords(remap.remappedManifest, remap.sources, recovery.docs, inspected.assets, {
    threads: remap.assistantThreads, drafts: restoredDrafts,
  })
  if (!recheck.ok) {
    const detail = recheck.errors.slice(0, 3).map((e) => `[${e.layer}] ${e.message}`).join('；')
    throw zerr('PREPARE_VALIDATION_FAILED', `恢复准备复检失败，已禁止提交：${detail}`, { errors: recheck.errors })
  }
  // 4. Source→本地 Blob（去 asset_path）；写前核对本地字节/类型与已校验资产一致。
  const sources = remap.sources.map((s) => {
    if (s.kind !== 'image') return sourceFromBackup(s, null)
    const bytes = inspected.assets.get(s.asset_path)
    const local = sourceFromBackup(s, bytes)
    const type = detectImageType(bytes)
    if (!local.blob || local.blob.size !== bytes.length || !type || local.blob.type !== type.mime) {
      throw zerr('ASSET_MISMATCH', `图片资料 ${s.id} 本地字节与已校验资产不符，已禁止提交`)
    }
    return local
  })

  const counts = {}
  for (const k of DOC_KINDS) counts[k] = 0
  for (const d of recovery.docs) counts[d.kind] += 1
  return {
    operationId,
    targetWorkspaceId,
    targetName: name,
    fingerprint: inspected.fingerprint,
    backupId: manifest.backup_id,
    targetWorkspace: remap.targetWorkspace,
    sources,
    docs: recovery.docs,
    runtimePuts: recovery.runtimePuts,
    assistantThreads: remap.assistantThreads,
    assistantDrafts: restoredDrafts,
    liveMap: remap.liveMap,
    historyMap: remap.historyMap,
    idMapSignature: mapSignature(remap.liveMap, remap.historyMap),
    counts,
    sourceCount: sources.length,
    imageCount: sources.filter((s) => s.kind === 'image').length,
    assistantThreadCount: remap.assistantThreads.length,
    assistantDraftCount: restoredDrafts.length,
    unfinishedV1: recovery.unfinishedV1,
    legacyEnds: recovery.legacyEnds,
    createdAt: created,
  }
}