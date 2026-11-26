// 备份格式规范（纯规则，不触库、不打包）。格式版本与业务契约版本分开：
// v2（当前导出）：backup_format_version=2 + schema_version=0.6.0，含助手线程/草案载荷；
// v2/0.5.0 旧备份继续可读（草案缺省 mode=create、取消集为空，不产生新授权）；
// v1（只读兼容）：backup_format_version=1 + schema_version=0.4.0，按冻结契约恢复，助手为空。
// 版本组合白名单唯一来源：契约 selftest BACKUP_COMPAT；错误组合显式拒绝，不能忽略助手部分继续。
import { beijingParts } from '@/domains/time'

export const BACKUP_FORMAT = 'jxl-backup'
export const BACKUP_FORMAT_VERSION = 2
export const SCHEMA_VERSION = '0.6.0'
export const V1_FORMAT_VERSION = 1
export const V1_SCHEMA_VERSION = '0.4.0'
export const BACKUP_COMPAT = [
  { formatVersion: V1_FORMAT_VERSION, schemaVersion: V1_SCHEMA_VERSION, mode: 'restore_old_semantics_empty_assistant' },
  { formatVersion: BACKUP_FORMAT_VERSION, schemaVersion: '0.5.0', mode: 'restore_full_with_assistant' },
  { formatVersion: BACKUP_FORMAT_VERSION, schemaVersion: SCHEMA_VERSION, mode: 'restore_full_with_assistant' },
]
export const compatFor = (formatVersion, schemaVersion) =>
  BACKUP_COMPAT.find((c) => c.formatVersion === formatVersion && c.schemaVersion === schemaVersion) || null

// v1 初始限额（解压流中按实际字节 enforcement 在 4-2 解码器；这里提供常量与纯校验）。
export const LIMITS = {
  ZIP_MAX_BYTES: 100 * 1024 * 1024, // 100MiB 压缩文件
  UNCOMPRESSED_MAX_BYTES: 300 * 1024 * 1024, // 300MiB 总解压
  JSON_MAX_BYTES: 25 * 1024 * 1024, // 单个 JSON
  IMAGE_MAX_BYTES: 25 * 1024 * 1024, // 单张图片
  MAX_ENTRIES: 5000, // 总条目
}

export const MANIFEST_PATH = 'manifest.json'
export const SOURCES_PATH = 'data/sources.json'
export const DOCS_PATH = 'data/docs.json'
export const ASSISTANT_THREADS_PATH = 'data/assistant_threads.json'
export const ASSISTANT_DRAFTS_PATH = 'data/assistant_drafts.json'
export const ASSISTANT_PATHS = [ASSISTANT_THREADS_PATH, ASSISTANT_DRAFTS_PATH]
export const REQUIRED_PATHS = [MANIFEST_PATH, SOURCES_PATH, DOCS_PATH]
export const requiredPathsFor = (formatVersion) =>
  formatVersion === BACKUP_FORMAT_VERSION ? [...REQUIRED_PATHS, ...ASSISTANT_PATHS] : [...REQUIRED_PATHS]

// 允许的栅格图片类型（不以 SVG/HTML 承载任意内容）。magic 用于按实际字节识别，不信扩展名/声明。
export const IMAGE_TYPES = [
  { mime: 'image/png', ext: 'png', magic: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { mime: 'image/jpeg', ext: 'jpg', magic: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', magic: (b) => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { mime: 'image/gif', ext: 'gif', magic: (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
]
export const IMAGE_EXTS = IMAGE_TYPES.map((t) => t.ext)

// 按实际字节识别图片类型；无法识别返回 null（拒绝 SVG/HTML/未知）。
export function detectImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return IMAGE_TYPES.find((t) => t.magic(b)) || null
}

// 归档内路径由应用生成：只允许 manifest.json / data/*.json / assets/<内部ID>.<允许扩展名>。
// 拒绝绝对路径、..、反斜杠、控制字符、重复路径、非规范段。原始显示名放元数据，不进路径。
const PATH_RE = /^(manifest\.json|data\/[A-Za-z0-9_-]+\.json|assets\/[A-Za-z0-9_-]+\.(png|jpg|webp|gif))$/
export function isAllowedArchivePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false
  if (path.includes('\\') || path.includes('..') || path.startsWith('/')) return false
  if (/[<>:"|?*\x00-\x1f]/.test(path)) return false
  return PATH_RE.test(path)
}

// 去除不适合文件名的字符（保留中文/字母/数字/._-），压缩空白，限长。
export function sanitizeFilenamePart(name) {
  const cleaned = String(name == null ? '' : name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return cleaned.slice(0, 60) || '空间'
}

// 北京日期时间戳 YYYYMMDD-HHMMSS（文件名用，无歧义字符）。
export function beijingStamp(instant = new Date()) {
  const b = beijingParts(instant)
  const p2 = (n) => String(n).padStart(2, '0')
  return `${b.year}${p2(b.month)}${p2(b.day)}-${p2(b.hour)}${p2(b.minute)}${p2(b.second)}`
}

export function backupFilename(workspaceName, instant = new Date()) {
  return `截下来-${sanitizeFilenamePart(workspaceName)}-${beijingStamp(instant)}.jxl-backup.zip`
}

// 默认恢复空间名：恢复 · 原空间名 · 北京日期时间（名字不是唯一身份，重名可加后缀）。
export function defaultRestoreName(sourceName, instant = new Date()) {
  const b = beijingParts(instant)
  const p2 = (n) => String(n).padStart(2, '0')
  const stamp = `${b.year}-${p2(b.month)}-${p2(b.day)} ${p2(b.hour)}:${p2(b.minute)}`
  return `恢复 · ${sanitizeFilenamePart(sourceName)} · ${stamp}`
}

// SHA-256（按归档原始字节，不 parse 后重序列化）。浏览器与 Node 均有 webcrypto。
export async function sha256Hex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', b)
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function utf8Bytes(str) {
  return new TextEncoder().encode(str)
}
export function bytesToUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

// 资料内容版本（R9）：真实字节的 SHA-256，写入时事务外计算并随记录落库，供事务内同步绑定核对
// （不在活事务内等待 Blob 哈希）。文字按 UTF-8、图片按 Blob 字节——同尺寸/同名/同类型而字节不同
// 也会得到不同版本。缺必需载荷返回 null（不伪造内容身份；能否作为证据由 captureFactBaseline 另行拒绝）。
export async function sourceContentVersion(s) {
  let bytes
  if (s.kind === 'text' || typeof s.text === 'string') {
    if (typeof s.text !== 'string') return null
    bytes = utf8Bytes(s.text)
  } else if (s.blob) {
    bytes = new Uint8Array(await s.blob.arrayBuffer())
  } else {
    return null
  }
  return sha256Hex(bytes)
}

// manifest 形状（至少包含项）。payloads 列 JSON 与图片实际字节，manifest 不列自身哈希避免循环。
// counts：各 docs kind 数量；v2 另含 assistant_thread_count/assistant_draft_count（协议 §5.1，
// 放 counts 对象内，不是顶层字段）；source_count；image_count。source_workspace：原空间 id/name/is_demo。
export function buildManifest({ backupId, exportedAt, sourceWorkspace, counts, sourceCount, imageCount, payloads, formatVersion = BACKUP_FORMAT_VERSION, assistantThreadCount = 0, assistantDraftCount = 0 }) {
  const v2 = formatVersion === BACKUP_FORMAT_VERSION
  const countsOut = v2
    ? { ...counts, assistant_thread_count: assistantThreadCount, assistant_draft_count: assistantDraftCount }
    : { ...counts }
  return {
    format: BACKUP_FORMAT,
    backup_format_version: formatVersion,
    schema_version: v2 ? SCHEMA_VERSION : V1_SCHEMA_VERSION,
    backup_id: backupId,
    exported_at: exportedAt,
    source_workspace: { id: sourceWorkspace.id, name: sourceWorkspace.name, is_demo: !!sourceWorkspace.is_demo },
    counts: countsOut,
    source_count: sourceCount,
    image_count: imageCount,
    payloads,
  }
}

const HEX64 = /^[0-9a-f]{64}$/
// manifest 自身结构校验（形状/版本/必需字段/payload 条目形状）。内容一致性在 validate.js A 层。
export function validateManifestShape(m) {
  const errors = []
  const add = (message) => errors.push({ layer: 'A', message })
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    add('manifest 必须是对象')
    return errors
  }
  if (m.format !== BACKUP_FORMAT) add(`manifest.format 必须是 ${BACKUP_FORMAT}`)
  const compat = compatFor(m.backup_format_version, m.schema_version)
  if (!compat) {
    add(`不支持的版本组合 backup_format_version=${m.backup_format_version} / schema_version=${m.schema_version}（只支持 1/0.4.0 与 2/0.5.0、2/0.6.0）`)
  }
  const isV2 = m.backup_format_version === BACKUP_FORMAT_VERSION
  if (typeof m.backup_id !== 'string' || !m.backup_id) add('manifest.backup_id 必须是非空字符串')
  if (typeof m.exported_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(m.exported_at)) {
    add('manifest.exported_at 必须是带明确偏移的 ISO 日期时间')
  }
  const sw = m.source_workspace
  if (!sw || typeof sw !== 'object' || typeof sw.id !== 'string' || !sw.id || typeof sw.name !== 'string' || typeof sw.is_demo !== 'boolean') {
    add('manifest.source_workspace 必须含 id/name/is_demo')
  }
  if (!m.counts || typeof m.counts !== 'object' || Array.isArray(m.counts)) add('manifest.counts 必须是对象')
  else {
    for (const [k, v] of Object.entries(m.counts)) if (!Number.isInteger(v) || v < 0) add(`manifest.counts.${k} 必须是非负整数`)
    if (isV2) {
      for (const k of ['assistant_thread_count', 'assistant_draft_count']) {
        if (!Number.isInteger(m.counts[k]) || m.counts[k] < 0) add(`v2 manifest.counts.${k} 必须是非负整数`)
      }
    } else if (compat) {
      for (const k of ['assistant_thread_count', 'assistant_draft_count']) {
        if (Object.prototype.hasOwnProperty.call(m.counts, k)) add(`v1 manifest.counts 不得含 ${k}`)
      }
    }
  }
  if (!Number.isInteger(m.source_count) || m.source_count < 0) add('manifest.source_count 必须是非负整数')
  if (!Number.isInteger(m.image_count) || m.image_count < 0) add('manifest.image_count 必须是非负整数')
  if (!Array.isArray(m.payloads)) add('manifest.payloads 必须是数组')
  else {
    const seen = new Set()
    for (const p of m.payloads) {
      if (!p || typeof p !== 'object') { add('payload 条目必须是对象'); continue }
      if (typeof p.path !== 'string' || !isAllowedArchivePath(p.path) || p.path === MANIFEST_PATH) add(`payload.path 非法或为 manifest 自身：${p.path}`)
      if (seen.has(p.path)) add(`payload.path 重复：${p.path}`)
      seen.add(p.path)
      if (!Number.isInteger(p.bytes) || p.bytes < 0) add(`payload.bytes 必须是非负整数：${p.path}`)
      if (typeof p.sha256 !== 'string' || !HEX64.test(p.sha256)) add(`payload.sha256 必须是 64 位十六进制：${p.path}`)
    }
  }
  return errors
}