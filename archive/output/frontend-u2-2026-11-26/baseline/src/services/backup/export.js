// 备份导出编排（开工单 §3/§4）。输入是 readWorkspaceSnapshot 的固定一致快照，
// 全部序列化/哈希/压缩在事务提交后于内存进行；本模块不触库、不发网络请求、不读运行态。
// 失败显式抛错（带 code），绝不生成宣称完整的半成品「成功文件」。
import {
  MANIFEST_PATH, SOURCES_PATH, DOCS_PATH, ASSISTANT_THREADS_PATH, ASSISTANT_DRAFTS_PATH,
  SCHEMA_VERSION, buildManifest, backupFilename, sha256Hex, utf8Bytes,
} from './format'
import { DOC_KINDS, docToBackup, sourceToBackup, assistantToBackup } from './adapt'
import { packArchive } from './zip'
import { validateBackup } from './validate'

const SOURCE_KINDS = ['image', 'text']

// 可导出性检查：未适配的 docs kind / 未知 source kind 显式列计数并阻断（不悄悄遗漏）。
// 「页面不创建」≠「库里没有」：扫描真实快照，发现 plan_draft/change_proposal/旧 group 等即拒绝。
export function checkExportable(snapshot) {
  const unknownDocs = new Map()
  for (const d of snapshot.docs || []) {
    const kind = d && d.kind
    if (!DOC_KINDS.includes(kind)) unknownDocs.set(kind, (unknownDocs.get(kind) || 0) + 1)
  }
  const unknownSources = new Map()
  for (const s of snapshot.sources || []) {
    const kind = s && s.kind
    if (!SOURCE_KINDS.includes(kind)) unknownSources.set(kind, (unknownSources.get(kind) || 0) + 1)
  }
  if (unknownDocs.size || unknownSources.size) {
    const parts = []
    for (const [k, n] of unknownDocs) parts.push(`记录类型 ${k}（${n} 条）`)
    for (const [k, n] of unknownSources) parts.push(`资料类型 ${k}（${n} 条）`)
    throw Object.assign(
      new Error(`当前空间含未适配的${parts.join('、')}，无法生成完整备份；请先处理这些记录后再导出`),
      { code: 'UNSUPPORTED_KIND', unknownDocs: Object.fromEntries(unknownDocs), unknownSources: Object.fromEntries(unknownSources) },
    )
  }
}

// 空间归属：以快照捕获的 wsId 为准。目录元数据缺失时按 id 退化命名（不冒充别处空间）。
function workspaceMeta(snapshot) {
  const id = snapshot.workspaceId
  const w = snapshot.workspace
  return {
    id,
    name: (w && w.name) || (id === 'demo' ? '演示空间' : '个人空间'),
    is_demo: w ? !!w.is_demo : id === 'demo',
  }
}

// 构建完整备份。snapshot={workspaceId,workspace,sources(本地 blob 形态),docs(本地 kind 形态)}。
// opts：backupId/exportedAt/instant 可注入（测试用固定值）；缺省用随机 ID 与当前时刻。
// 返回 {zipBytes,filename,manifest,entries,summary}。summary 含各 kind 计数/资料数/图片数/图片字节量。
export async function buildBackup(snapshot, opts = {}) {
  checkExportable(snapshot)
  const ws = workspaceMeta(snapshot)
  const backupId = opts.backupId || crypto.randomUUID()
  const instant = opts.instant || new Date()
  const exportedAt = opts.exportedAt || instant.toISOString()

  const backupSources = []
  const assetEntries = []
  let assetBytes = 0
  let imageCount = 0
  for (const source of snapshot.sources || []) {
    const { record, asset } = await sourceToBackup(source)
    backupSources.push(record)
    if (asset) {
      assetEntries.push({ path: asset.path, bytes: asset.bytes })
      assetBytes += asset.bytes.length
      imageCount += 1
    }
  }

  const backupDocs = (snapshot.docs || []).map(docToBackup)
  const counts = {}
  for (const k of DOC_KINDS) counts[k] = 0
  for (const d of backupDocs) counts[d.kind] += 1
  // v2 助手载荷：契约包装对象（空数组也写入）；不导出 assistant_ops/信封/写集/租约。
  const backupThreads = (snapshot.assistantThreads || []).map(assistantToBackup)
  const backupDrafts = (snapshot.assistantDrafts || []).map(assistantToBackup)

  const entries = []
  const payloads = []
  const pushJson = (path, value) => {
    const bytes = utf8Bytes(JSON.stringify(value))
    entries.push({ path, bytes })
    payloads.push({ path, bytes: bytes.length, sha256: null })
  }
  pushJson(SOURCES_PATH, backupSources)
  pushJson(DOCS_PATH, backupDocs)
  pushJson(ASSISTANT_THREADS_PATH, { schema_version: SCHEMA_VERSION, threads: backupThreads })
  pushJson(ASSISTANT_DRAFTS_PATH, { schema_version: SCHEMA_VERSION, drafts: backupDrafts })
  for (const a of assetEntries) {
    entries.push(a)
    payloads.push({ path: a.path, bytes: a.bytes.length, sha256: null })
  }
  // 逐载荷按归档原始字节填真实 SHA-256（manifest 不列自身哈希，避免循环）。
  const byPath = new Map(entries.map((e) => [e.path, e.bytes]))
  for (const p of payloads) p.sha256 = await sha256Hex(byPath.get(p.path))

  const manifest = buildManifest({
    backupId, exportedAt, sourceWorkspace: ws, counts,
    sourceCount: backupSources.length, imageCount, payloads,
    assistantThreadCount: backupThreads.length, assistantDraftCount: backupDrafts.length,
  })
  entries.unshift({ path: MANIFEST_PATH, bytes: utf8Bytes(JSON.stringify(manifest)) })

  // 压缩前按最终实际字节过 4-0 完整校验（结构/语义/关系 + 条目数/JSON/图片/总展开限额）。
  // 压缩后体积小不代表展开可恢复：超限或非法记录在此显式抛错，绝不打包下载、不宣称成功。
  // 不截断/不丢字段/不篡改原库/不放宽恢复器；压缩后 ZIP 体积仍由 packArchive 兜底检查。
  const check = await validateBackup({ entries })
  if (!check.ok) {
    const detail = check.errors.slice(0, 3).map((e) => `[${e.layer}] ${e.message}`).join('；')
    const more = check.errors.length > 3 ? `（共 ${check.errors.length} 项问题）` : ''
    throw Object.assign(
      new Error(`备份未通过完整性校验，已禁止下载：${detail}${more}`),
      { code: 'BACKUP_VALIDATION_FAILED', errors: check.errors },
    )
  }

  const zipBytes = packArchive(entries)
  const filename = backupFilename(ws.name, instant)
  return {
    zipBytes, filename, manifest, entries,
    summary: { counts, sourceCount: backupSources.length, imageCount, assetBytes, assistantThreadCount: backupThreads.length, assistantDraftCount: backupDrafts.length },
  }
}