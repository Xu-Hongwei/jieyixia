// 真实 ZIP 打包/解包（fflate 0.8.3，锁定版本、Vite 本地打包，无在线 CDN）。开工单 §3/§10。
// 同步、纯内存：必须在一致只读快照事务提交之后调用，绝不在 IndexedDB 事务内 await 压缩。
// 路径由应用生成（format.isAllowedArchivePath 约束），原始显示名放元数据，不进 ZIP 路径。
import { zipSync, unzipSync, Inflate } from 'fflate'
import { LIMITS, isAllowedArchivePath } from './format'

const zipTooBig = (bytes) =>
  Object.assign(new Error(`备份压缩文件超过上限 ${LIMITS.ZIP_MAX_BYTES} 字节（实际 ${bytes.length}），请减少资料后重试`), { code: 'ZIP_TOO_LARGE' })

// entries: [{ path, bytes:Uint8Array }] → 压缩 ZIP 字节。重复/非法路径拒绝（不静默覆盖）。
export function packArchive(entries) {
  /** @type {import('fflate').Zippable} */
  const files = {}
  const seen = new Set()
  for (const e of entries) {
    if (!isAllowedArchivePath(e.path)) {
      throw Object.assign(new Error(`非法归档路径，拒绝打包：${e.path}`), { code: 'BAD_ARCHIVE_PATH' })
    }
    if (seen.has(e.path)) {
      throw Object.assign(new Error(`归档路径重复，拒绝打包：${e.path}`), { code: 'DUP_ARCHIVE_PATH' })
    }
    seen.add(e.path)
    files[e.path] = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes)
  }
  const zipBytes = zipSync(files, { level: 6 })
  if (zipBytes.length > LIMITS.ZIP_MAX_BYTES) throw zipTooBig(zipBytes)
  return zipBytes
}

// 压缩 ZIP 字节 → { entries:[{ path, bytes:Uint8Array }] }。先按压缩体积预检上限。
// 仅供导出 round-trip 测试/独立 oracle 使用：unzipSync 先全量分配再检查，且不保序、不拒加密。
// 用户文件进口一律走下方 decodeArchiveBounded（边解压边按实际输出限额、保序、拒加密/未知方法）。
export function unpackArchive(zipBytes) {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes)
  if (bytes.length > LIMITS.ZIP_MAX_BYTES) throw zipTooBig(bytes)
  let files
  try {
    files = unzipSync(bytes)
  } catch (e) {
    throw Object.assign(new Error(`备份不是合法 ZIP 或已损坏：${e.message}`), { code: 'ZIP_CORRUPT' })
  }
  const entries = Object.keys(files).map((path) => ({ path, bytes: files[path] }))
  return { entries }
}

// ---------------------------------------------------------------- 受限解码（4-2 用户文件进口）
// 自解析 ZIP 容器（EOCD + 中央目录 + 局部头），fflate Inflate 只负责 raw-deflate 流式解压。
// 之所以不直接用 fflate Unzip/unzipSync：其流式路径不检查加密位、不校验 CRC32，unzipSync 先全量
// 分配再检查且按对象合并丢失重复路径与条目顺序。这里在解压前按中央目录拒加密/未知方法/ZIP64/
// 非法路径/重复路径，解压时按实际输出 chunk 累计限额（不信声明尺寸），超限即停并释放，可取消。

const zerr = (code, message) => Object.assign(new Error(message), { code })

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const nameDecoder = new TextDecoder('utf-8')
const outputLimitErr = (name, limit, actual, scope) =>
  zerr('ZIP_OUTPUT_LIMIT', `${scope}字节超过上限 ${limit}（${name} 实际已解压 ${actual}），已停止检查`)

// 解析 EOCD 与中央目录，保序返回每条目的元数据；解压前完成全部容器级拒绝。
function readCentralDirectory(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = bytes.length
  // EOCD 至少 22 字节，注释最长 65535：从尾部向前扫描签名 0x06054b50。
  let eocd = -1
  const minPos = Math.max(0, n - 22 - 65535)
  for (let i = n - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw zerr('ZIP_CORRUPT', '备份不是合法 ZIP（找不到中央目录结束记录）或已损坏')
  const entriesTotal = dv.getUint16(eocd + 10, true)
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  // ZIP64：哨兵尺寸或 EOCD64 定位记录（0x07064b50）→ 显式不支持，不猜测。
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw zerr('ZIP_UNSUPPORTED', '备份使用 ZIP64 扩展，当前恢复器不支持（本应用导出不使用 ZIP64）')
  }
  if (eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) {
    throw zerr('ZIP_UNSUPPORTED', '备份使用 ZIP64 扩展，当前恢复器不支持（本应用导出不使用 ZIP64）')
  }
  if (entriesTotal > LIMITS.MAX_ENTRIES) {
    throw zerr('ZIP_ENTRY_LIMIT', `归档条目超过上限 ${LIMITS.MAX_ENTRIES}（实际 ${entriesTotal}）`)
  }
  if (cdOffset + cdSize > eocd) throw zerr('ZIP_CORRUPT', '备份中央目录范围非法或已损坏')

  const out = []
  const seen = new Set()
  let p = cdOffset
  for (let idx = 0; idx < entriesTotal; idx++) {
    if (p + 46 > n || dv.getUint32(p, true) !== 0x02014b50) {
      throw zerr('ZIP_CORRUPT', '备份中央目录条目损坏或截断')
    }
    const versionNeeded = dv.getUint16(p + 6, true)
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const crc = dv.getUint32(p + 16, true)
    const compSize = dv.getUint32(p + 20, true)
    const uncompSize = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    if (p + 46 + nameLen + extraLen + commentLen > n) throw zerr('ZIP_CORRUPT', '备份中央目录条目越界')
    const name = nameDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen

    if (flags & 0x0001) throw zerr('ZIP_UNSUPPORTED', `备份条目已加密，不支持恢复：${name}`)
    // 数据描述符（bit3）：本应用导出从不使用；尺寸/ CRC 位置不确定 → 显式拒绝，不猜测。
    if (flags & 0x0008) throw zerr('ZIP_UNSUPPORTED', `备份条目使用数据描述符（流式写入），当前恢复器不支持：${name}`)
    if (method !== 0 && method !== 8) throw zerr('ZIP_UNSUPPORTED', `备份条目压缩方法 ${method} 不支持（仅 stored/deflate）：${name}`)
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff || versionNeeded >= 45) {
      throw zerr('ZIP_UNSUPPORTED', `备份条目使用 ZIP64 扩展，不支持恢复：${name}`)
    }
    if (!isAllowedArchivePath(name)) throw zerr('ZIP_BAD_PATH', `非法归档路径，拒绝恢复：${JSON.stringify(name)}`)
    if (seen.has(name)) throw zerr('ZIP_DUP_PATH', `归档路径重复，拒绝恢复（不静默覆盖）：${name}`)
    seen.add(name)
    out.push({ name, method, flags, crc32: crc, compSize, uncompSize, localOffset })
  }
  return out
}

// 按中央目录偏移读局部头，定位压缩数据；校验局部头签名/名称/方法/加密位与范围一致。
function readLocalData(bytes, m) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const o = m.localOffset
  if (o + 30 > bytes.length || dv.getUint32(o, true) !== 0x04034b50) {
    throw zerr('ZIP_CORRUPT', `备份局部文件头损坏：${m.name}`)
  }
  const localFlags = dv.getUint16(o + 6, true)
  const localMethod = dv.getUint16(o + 8, true)
  const nameLen = dv.getUint16(o + 26, true)
  const extraLen = dv.getUint16(o + 28, true)
  const dataStart = o + 30 + nameLen + extraLen
  if (localFlags & 0x0001) throw zerr('ZIP_UNSUPPORTED', `备份条目已加密，不支持恢复：${m.name}`)
  if (localMethod !== m.method) throw zerr('ZIP_CORRUPT', `备份局部头与中央目录压缩方法不一致：${m.name}`)
  const localName = nameDecoder.decode(bytes.subarray(o + 30, o + 30 + nameLen))
  if (localName !== m.name) throw zerr('ZIP_CORRUPT', `备份局部头与中央目录文件名不一致：${m.name}`)
  if (dataStart + m.compSize > bytes.length) throw zerr('ZIP_CORRUPT', `备份压缩数据越界或截断：${m.name}`)
  return bytes.subarray(dataStart, dataStart + m.compSize)
}

const yieldToLoop = () => new Promise((r) => setTimeout(r, 0))

// raw-deflate 流式解压：按小块喂入压缩字节，每次 ondata 按实际输出累计限额，超限/取消即停。
// 单块最大膨胀 ≈ deflate 极限比 × chunkSize，绝不像 unzipSync 先全量分配；周期让出事件循环保证可取消。
async function inflateBounded(comp, { name, entryLimit, total, signal, chunkSize, onProgress }) {
  const inf = new Inflate()
  const chunks = []
  let outLen = 0
  let failure = null
  // 同步 Inflate 的 ondata 签名为 (data, final)，错误由 push 同步抛出（非 err 回调）。
  inf.ondata = (data) => {
    if (failure) return
    if (data && data.length) {
      chunks.push(data.slice())
      outLen += data.length
      if (outLen > entryLimit) failure = outputLimitErr(name, entryLimit, outLen, '单文件')
      else if (total + outLen > LIMITS.UNCOMPRESSED_MAX_BYTES) failure = outputLimitErr(name, LIMITS.UNCOMPRESSED_MAX_BYTES, total + outLen, '总展开')
      else onProgress?.({ name, entryBytes: outLen, totalBytes: total + outLen })
    }
  }
  const stop = () => { inf.ondata = null }
  let sinceYield = 0
  let lastYield = Date.now()
  const pushPiece = (piece, final) => {
    if (signal?.aborted) { stop(); throw zerr('ZIP_CANCELLED', '已取消检查') }
    if (failure) { stop(); throw failure }
    try {
      inf.push(piece, final)
    } catch (e) {
      stop()
      throw zerr('ZIP_CORRUPT', `解压失败（内容损坏）：${name}：${(e && e.message) || e}`)
    }
    if (failure) { stop(); throw failure }
  }
  if (comp.length === 0) {
    pushPiece(new Uint8Array(0), true)
  } else {
    for (let i = 0; i < comp.length; i += chunkSize) {
      pushPiece(comp.subarray(i, Math.min(i + chunkSize, comp.length)), i + chunkSize >= comp.length)
      sinceYield += chunkSize
      if (sinceYield >= 262144 || Date.now() - lastYield >= 12) {
        sinceYield = 0
        lastYield = Date.now()
        await yieldToLoop()
        if (signal?.aborted) { stop(); throw zerr('ZIP_CANCELLED', '已取消检查') }
      }
    }
  }
  stop()
  if (failure) throw failure
  const out = new Uint8Array(outLen)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

// 受限解码主入口：zipBytes → { entries:[{path,bytes}] }（保中央目录顺序）。
// opts.signal(AbortSignal) 可取消；opts.onProgress 报告实际解压进度；opts.chunkSize 默认 8KiB。
// 容器级拒绝（加密/方法/ZIP64/路径/重复/条目数）在解压前；字节级限额按实际输出；CRC32+长度校验损坏。
export async function decodeArchiveBounded(zipBytes, opts = {}) {
  const { signal, onProgress, chunkSize = 8192 } = opts
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes)
  if (bytes.length > LIMITS.ZIP_MAX_BYTES) throw zipTooBig(bytes)
  if (signal?.aborted) throw zerr('ZIP_CANCELLED', '已取消检查')
  const meta = readCentralDirectory(bytes)
  const entries = []
  let total = 0
  for (const m of meta) {
    if (signal?.aborted) throw zerr('ZIP_CANCELLED', '已取消检查')
    const comp = readLocalData(bytes, m)
    const entryLimit = m.name.startsWith('assets/') ? LIMITS.IMAGE_MAX_BYTES : LIMITS.JSON_MAX_BYTES
    let out
    if (m.method === 0) {
      if (comp.length > entryLimit) throw outputLimitErr(m.name, entryLimit, comp.length, '单文件')
      if (total + comp.length > LIMITS.UNCOMPRESSED_MAX_BYTES) throw outputLimitErr(m.name, LIMITS.UNCOMPRESSED_MAX_BYTES, total + comp.length, '总展开')
      out = comp.slice()
    } else {
      out = await inflateBounded(comp, { name: m.name, entryLimit, total, signal, chunkSize, onProgress })
    }
    if (out.length !== m.uncompSize) {
      throw zerr('ZIP_CORRUPT', `解压字节数与目录声明不符（内容损坏或被改）：${m.name}（声明 ${m.uncompSize}，实际 ${out.length}）`)
    }
    if (crc32(out) !== m.crc32) throw zerr('ZIP_CORRUPT', `CRC32 校验失败（内容损坏或被改）：${m.name}`)
    total += out.length
    entries.push({ path: m.name, bytes: out })
    onProgress?.({ decodedEntries: entries.length, totalEntries: meta.length, totalBytes: total })
  }
  return { entries }
}