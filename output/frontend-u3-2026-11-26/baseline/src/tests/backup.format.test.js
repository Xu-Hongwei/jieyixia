import { describe, it, expect } from 'vitest'
import {
  LIMITS, buildManifest, validateManifestShape, isAllowedArchivePath,
  sanitizeFilenamePart, beijingStamp, backupFilename, defaultRestoreName,
  BACKUP_FORMAT, BACKUP_FORMAT_VERSION, SCHEMA_VERSION, V1_FORMAT_VERSION, V1_SCHEMA_VERSION,
} from '@/services/backup/format'
import { validateBackup } from '@/services/backup/validate'
import { assembleArchive, PNG_BYTES } from './backupFixtures'

const msgs = (r) => r.errors.map((e) => e.message).join(' | ')
const WSRC = { id: 'w', name: '虚构空间', is_demo: false }
const baseManifest = () => buildManifest({
  backupId: 'bk-1', exportedAt: '2026-11-22T15:30:00+08:00', sourceWorkspace: WSRC,
  counts: { note: 0 }, sourceCount: 0, imageCount: 0,
  payloads: [{ path: 'data/sources.json', bytes: 2, sha256: 'a'.repeat(64) }],
  formatVersion: 1,
})

describe('备份格式 v1 · 常量与文件名', () => {
  it('格式版本与契约版本分离，限额符合开工单', () => {
    expect(BACKUP_FORMAT).toBe('jxl-backup')
    expect(BACKUP_FORMAT_VERSION).toBe(2)
    expect(SCHEMA_VERSION).toBe('0.6.0')
    expect(V1_FORMAT_VERSION).toBe(1)
    expect(V1_SCHEMA_VERSION).toBe('0.4.0')
    expect(LIMITS).toMatchObject({
      ZIP_MAX_BYTES: 100 * 1024 * 1024, UNCOMPRESSED_MAX_BYTES: 300 * 1024 * 1024,
      JSON_MAX_BYTES: 25 * 1024 * 1024, IMAGE_MAX_BYTES: 25 * 1024 * 1024, MAX_ENTRIES: 5000,
    })
  })
  it('北京戳与文件名/恢复名规范', () => {
    const d = new Date('2026-11-22T15:30:00+08:00')
    expect(beijingStamp(d)).toBe('20261122-153000')
    expect(backupFilename('个人空间', d)).toBe('截下来-个人空间-20261122-153000.jxl-backup.zip')
    expect(defaultRestoreName('个人空间', d)).toBe('恢复 · 个人空间 · 2026-11-22 15:30')
  })
  it('文件名清洗去除危险字符', () => {
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij')
    expect(sanitizeFilenamePart('   ')).toBe('空间')
  })
})

describe('备份格式 v1 · 路径规则', () => {
  it('只允许 manifest/data JSON/assets 允许扩展名', () => {
    expect(isAllowedArchivePath('assets/a1.png')).toBe(true)
    expect(isAllowedArchivePath('assets/a1.webp')).toBe(true)
    expect(isAllowedArchivePath('assets/a1.jpeg')).toBe(false) // 只 jpg
    expect(isAllowedArchivePath('assets/a1.PNG')).toBe(false) // 大小写敏感
    expect(isAllowedArchivePath('assets/a1.svg')).toBe(false)
    expect(isAllowedArchivePath('data/../x.json')).toBe(false)
    expect(isAllowedArchivePath('assets/a1.png\u0000')).toBe(false)
    expect(isAllowedArchivePath('x'.repeat(201) + '.json')).toBe(false)
  })
})

describe('备份格式 v1 · manifest 形状', () => {
  it('合法 manifest 无错误', () => { expect(validateManifestShape(baseManifest())).toEqual([]) })
  it('format/版本/schema 不符被拒', () => {
    expect(validateManifestShape({ ...baseManifest(), format: 'other' }).length).toBeGreaterThan(0)
    expect(validateManifestShape({ ...baseManifest(), backup_format_version: 2 }).length).toBeGreaterThan(0)
    expect(validateManifestShape({ ...baseManifest(), schema_version: '0.5.0' }).length).toBeGreaterThan(0)
  })
  it('exported_at 必须带明确偏移', () => {
    expect(validateManifestShape({ ...baseManifest(), exported_at: '2026-11-22T15:30:00' }).length).toBeGreaterThan(0)
  })
  it('payload 路径为 manifest 自身/重复/哈希非 64hex 被拒', () => {
    const m = baseManifest()
    m.payloads = [{ path: 'manifest.json', bytes: 1, sha256: 'a'.repeat(64) }]
    expect(validateManifestShape(m).length).toBeGreaterThan(0)
    const m2 = baseManifest()
    m2.payloads = [{ path: 'data/sources.json', bytes: 2, sha256: 'zz' }]
    expect(validateManifestShape(m2).length).toBeGreaterThan(0)
  })
  it('计数负数被拒', () => {
    expect(validateManifestShape({ ...baseManifest(), source_count: -1 }).length).toBeGreaterThan(0)
  })
})

describe('备份格式 v1 · 限额按实际字节', () => {
  it('条目数超过 MAX_ENTRIES 被拒', async () => {
    const entries = Array.from({ length: LIMITS.MAX_ENTRIES + 1 }, (_, i) => ({ path: `data/f${i}.json`, bytes: new TextEncoder().encode('[]') }))
    expect(msgs(await validateBackup({ entries }))).toMatch(/归档条目超过上限 5000/)
  })
  it('单张图片超过 IMAGE_MAX_BYTES 被拒', async () => {
    const big = new Uint8Array(LIMITS.IMAGE_MAX_BYTES + 1)
    big.set(PNG_BYTES.subarray(0, 8), 0)
    const archive = await assembleArchive({
      workspace: WSRC,
      sources: [{ id: 's', workspace_id: 'w', kind: 'image', captured_at: '2026-11-20T09:00:00+08:00', asset_path: 'assets/s.png' }],
      docs: [], assets: new Map([['assets/s.png', big]]),
    })
    expect(msgs(await validateBackup(archive))).toMatch(/图片超过单文件上限/)
  })
})