// 4-2 R1a 受限 ZIP 解码器验收：真实导出 round-trip + 容器级拒绝 + 实际输出限额 + 可取消。
// 正向用生产 packArchive 证明兼容本应用导出；负向用可控 ZIP 写入器构造加密/未知方法/ZIP64/
// 重复路径/非法路径/目录项/坏 CRC/尺寸谎报/zip bomb，逐项断言拒绝码与零全量分配。
import { describe, it, expect } from 'vitest'
import { deflateSync } from 'fflate'
import { packArchive, decodeArchiveBounded } from '@/services/backup/zip'
import { validateBackup } from '@/services/backup/validate'
import { LIMITS, MANIFEST_PATH, SOURCES_PATH, DOCS_PATH, utf8Bytes } from '@/services/backup/format'
import { buildCompleteBackup, PNG_BYTES } from './backupFixtures'

// ---- 测试用 CRC32 与可控 ZIP 写入器（独立于生产解码器，作 oracle）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

const le16 = (a, v) => a.push(v & 255, (v >>> 8) & 255)
const le32 = (a, v) => a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255)
const pushBytes = (a, bytes) => { for (let i = 0; i < bytes.length; i++) a.push(bytes[i]) }
const strBytes = (s) => new TextEncoder().encode(s)

// entries: [{ name, data, method=8, flags=0, crcOverride, compSizeOverride, uncompSizeOverride, versionNeeded, localOffsetOverride }]
function buildZip(entries) {
  const body = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = strBytes(e.name)
    const method = e.method ?? 8
    const flags = e.flags ?? 0
    const raw = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data)
    const comp = method === 8 ? deflateSync(raw) : raw
    const crc = e.crcOverride ?? crc32(raw)
    const compSize = e.compSizeOverride ?? comp.length
    const uncompSize = e.uncompSizeOverride ?? raw.length
    const localOffset = offset
    const lh = []
    le32(lh, 0x04034b50); le16(lh, 20); le16(lh, flags); le16(lh, method); le16(lh, 0); le16(lh, 0)
    le32(lh, crc); le32(lh, compSize); le32(lh, uncompSize); le16(lh, name.length); le16(lh, 0)
    pushBytes(lh, name)
    pushBytes(body, lh); pushBytes(body, comp)
    offset += lh.length + comp.length
    const ch = []
    le32(ch, 0x02014b50); le16(ch, 20); le16(ch, e.versionNeeded ?? 20); le16(ch, flags); le16(ch, method)
    le16(ch, 0); le16(ch, 0); le32(ch, crc); le32(ch, compSize); le32(ch, uncompSize)
    le16(ch, name.length); le16(ch, 0); le16(ch, 0); le16(ch, 0); le16(ch, 0); le32(ch, 0)
    le32(ch, e.localOffsetOverride ?? localOffset)
    pushBytes(ch, name)
    centrals.push(ch)
  }
  const cdOffset = offset
  let cdSize = 0
  for (const ch of centrals) { pushBytes(body, ch); cdSize += ch.length }
  const eocd = []
  le32(eocd, 0x06054b50); le16(eocd, 0); le16(eocd, 0); le16(eocd, entries.length); le16(eocd, entries.length)
  le32(eocd, cdSize); le32(eocd, cdOffset); le16(eocd, 0)
  pushBytes(body, eocd)
  return Uint8Array.from(body)
}

const codeOf = async (p) => { try { await p; return null } catch (e) { return e.code } }

describe('4-2 R1a 受限解码：真实导出 round-trip', () => {
  it('packArchive → decodeArchiveBounded 字节与顺序完全一致', async () => {
    const entries = [
      { path: MANIFEST_PATH, bytes: utf8Bytes('{"a":1}') },
      { path: SOURCES_PATH, bytes: utf8Bytes('[]') },
      { path: DOCS_PATH, bytes: utf8Bytes('[]') },
      { path: 'assets/x.png', bytes: PNG_BYTES },
    ]
    const zip = packArchive(entries)
    const { entries: back } = await decodeArchiveBounded(zip)
    expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path))
    for (let i = 0; i < entries.length; i++) expect(Array.from(back[i].bytes)).toEqual(Array.from(entries[i].bytes))
  })

  it('完整虚构备份：解码后过 4-0 三层校验，图片字节不变', async () => {
    const { entries } = await buildCompleteBackup()
    const zip = packArchive(entries)
    const { entries: back } = await decodeArchiveBounded(zip)
    const check = await validateBackup({ entries: back, zipBytes: zip })
    expect(check.ok).toBe(true)
    const asset = back.find((e) => e.path === 'assets/src-img.png')
    expect(Array.from(asset.bytes)).toEqual(Array.from(PNG_BYTES))
  })

  it('stored（method 0）条目也能解码', async () => {
    const data = utf8Bytes(' stored content ')
    const zip = buildZip([{ name: 'data/docs.json', data, method: 0 }])
    const { entries } = await decodeArchiveBounded(zip)
    expect(entries[0].path).toBe('data/docs.json')
    expect(Array.from(entries[0].bytes)).toEqual(Array.from(data))
  })
})

describe('4-2 R1a 受限解码：容器级拒绝（解压前）', () => {
  const ok = utf8Bytes('[]')
  it('找不到 EOCD → ZIP_CORRUPT', async () => {
    expect(await codeOf(decodeArchiveBounded(Uint8Array.from([0x50, 0x4b, 0x00, 0x00])))).toBe('ZIP_CORRUPT')
  })
  it('加密条目（flag bit0）→ ZIP_UNSUPPORTED', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, flags: 0x0001 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_UNSUPPORTED')
  })
  it('数据描述符（flag bit3）→ ZIP_UNSUPPORTED', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, flags: 0x0008 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_UNSUPPORTED')
  })
  it('未知压缩方法（14 LZMA）→ ZIP_UNSUPPORTED', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, method: 14 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_UNSUPPORTED')
  })
  it('ZIP64 哨兵尺寸 → ZIP_UNSUPPORTED', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, uncompSizeOverride: 0xffffffff }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_UNSUPPORTED')
  })
  it('ZIP64 versionNeeded=45 → ZIP_UNSUPPORTED', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, versionNeeded: 45 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_UNSUPPORTED')
  })
  it('重复路径 → ZIP_DUP_PATH（不静默覆盖，保序拒绝）', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok }, { name: 'data/docs.json', data: utf8Bytes('[1]') }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_DUP_PATH')
  })
  it('非法路径（绝对/.. /反斜杠）→ ZIP_BAD_PATH', async () => {
    for (const name of ['/etc/passwd', 'data/../x.json', 'data\\docs.json']) {
      const zip = buildZip([{ name, data: ok }])
      expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_BAD_PATH')
    }
  })
  it('目录项（尾斜杠）→ ZIP_BAD_PATH', async () => {
    const zip = buildZip([{ name: 'assets/', data: new Uint8Array(0), method: 0 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_BAD_PATH')
  })
  it('条目数超上限 → ZIP_ENTRY_LIMIT', async () => {
    const many = []
    for (let i = 0; i < LIMITS.MAX_ENTRIES + 1; i++) many.push({ name: `data/f${i}.json`, data: ok })
    const zip = buildZip(many)
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_ENTRY_LIMIT')
  })
  it('压缩文件超上限 → ZIP_TOO_LARGE', async () => {
    const big = new Uint8Array(LIMITS.ZIP_MAX_BYTES + 1)
    expect(await codeOf(decodeArchiveBounded(big))).toBe('ZIP_TOO_LARGE')
  })
})

describe('4-2 R1a 受限解码：损坏与尺寸谎报', () => {
  const ok = utf8Bytes('[]')
  it('坏 CRC32 → ZIP_CORRUPT', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, crcOverride: 0xdeadbeef }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_CORRUPT')
  })
  it('声明尺寸与实际不符（实际小）→ ZIP_CORRUPT', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, uncompSizeOverride: 999 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_CORRUPT')
  })
  it('局部头偏移越界 → ZIP_CORRUPT', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, localOffsetOverride: 0x7fffffff }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_CORRUPT')
  })
  it('截断的压缩数据 → ZIP_CORRUPT', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: ok, compSizeOverride: 1 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_CORRUPT')
  })
})

describe('4-2 R1a 受限解码：实际输出限额（zip bomb 防护）', () => {
  it('高压缩比 JSON 超单文件上限：按实际输出停止，不全量分配', async () => {
    // 30MiB 全零 → deflate 后极小；声明尺寸诚实，但实际展开超 JSON_MAX(25MiB)。
    const bomb = new Uint8Array(30 * 1024 * 1024)
    const zip = buildZip([{ name: 'data/docs.json', data: bomb }])
    expect(zip.length).toBeLessThan(1024 * 1024) // 压缩后远小于展开
    let maxSeen = 0
    const code = await codeOf(decodeArchiveBounded(zip, { onProgress: (p) => { if (p.totalBytes) maxSeen = Math.max(maxSeen, p.totalBytes) } }))
    expect(code).toBe('ZIP_OUTPUT_LIMIT')
    // 停止时实际解压量 bounded：不超过单文件上限 + 单块最大膨胀（8KiB × ~1032）
    expect(maxSeen).toBeLessThanOrEqual(LIMITS.JSON_MAX_BYTES + 16 * 1024 * 1024)
    expect(maxSeen).toBeGreaterThan(LIMITS.JSON_MAX_BYTES - 16 * 1024 * 1024)
  }, 30000)

  it('尺寸谎报（声明极小）但实际展开超限：仍按实际输出停止', async () => {
    const bomb = new Uint8Array(30 * 1024 * 1024)
    const zip = buildZip([{ name: 'data/docs.json', data: bomb, uncompSizeOverride: 10 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_OUTPUT_LIMIT')
  }, 30000)

  it('图片超单文件上限 → ZIP_OUTPUT_LIMIT', async () => {
    const big = new Uint8Array(LIMITS.IMAGE_MAX_BYTES + 1024)
    big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47 // PNG magic（解码器只看字节限额）
    const zip = buildZip([{ name: 'assets/big.png', data: big, method: 0 }])
    expect(await codeOf(decodeArchiveBounded(zip))).toBe('ZIP_OUTPUT_LIMIT')
  }, 30000)

  it('单文件恰为上限不误拒（边界）', async () => {
    const exact = new Uint8Array(LIMITS.JSON_MAX_BYTES)
    const zip = buildZip([{ name: 'data/docs.json', data: exact, method: 0 }])
    const { entries } = await decodeArchiveBounded(zip)
    expect(entries[0].bytes.length).toBe(LIMITS.JSON_MAX_BYTES)
  }, 30000)
})

describe('4-2 R1a 受限解码：可取消与资源释放', () => {
  it('解压途中 abort → ZIP_CANCELLED，不再产出后续条目', async () => {
    // 随机字节几乎不可压缩 → 压缩流跨多块，取消发生在首条目解压途中（非条目边界）。
    const payload = new Uint8Array(2 * 1024 * 1024)
    for (let i = 0; i < payload.length; i += 65536) crypto.getRandomValues(payload.subarray(i, i + 65536))
    const zip = buildZip([
      { name: 'data/sources.json', data: payload },
      { name: 'data/docs.json', data: payload },
    ])
    const ac = new AbortController()
    let aborted = false
    const p = decodeArchiveBounded(zip, {
      signal: ac.signal,
      onProgress: () => { if (!aborted) { aborted = true; ac.abort() } },
    })
    expect(await codeOf(p)).toBe('ZIP_CANCELLED')
  }, 30000)

  it('开始前已 abort → ZIP_CANCELLED', async () => {
    const zip = buildZip([{ name: 'data/docs.json', data: utf8Bytes('[]') }])
    const ac = new AbortController()
    ac.abort()
    expect(await codeOf(decodeArchiveBounded(zip, { signal: ac.signal }))).toBe('ZIP_CANCELLED')
  })
})