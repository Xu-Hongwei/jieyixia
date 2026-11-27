import { describe, it, expect } from 'vitest'
import {
  sourceToBackup, sourceFromBackup, businessCoreOfSource, businessCoreOfDoc,
  docToBackup, docFromBackup, LOCAL_ONLY_DOC_FIELDS, SOURCE_LOCAL_ONLY, DOC_KINDS,
} from '@/services/backup/adapt'
import { PNG_BYTES } from './backupFixtures'

// 独立 oracle：断言对照 PNG_BYTES 常量与 Blob 真实字节，而非导出器↔导入器互验。
const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer())

describe('本地字段适配 · Source', () => {
  it('image：备份记录无 blob、asset_path 指向真实字节；恢复重建 Blob 字节一致', async () => {
    const src = { id: 's1', workspace_id: 'w', kind: 'image', captured_at: '2026-11-20T09:00:00+08:00', name: '原图.png', blob: new Blob([PNG_BYTES], { type: 'image/png' }) }
    const { record, asset } = await sourceToBackup(src)
    expect(record.blob).toBeUndefined()
    expect(record.asset_path).toBe('assets/s1.png')
    expect(asset.mime).toBe('image/png')
    expect([...asset.bytes]).toEqual([...PNG_BYTES]) // 独立常量比对
    const back = sourceFromBackup(record, asset.bytes)
    expect(back.blob).toBeInstanceOf(Blob)
    expect(back.blob.type).toBe('image/png')
    expect(back.blob.size).toBe(PNG_BYTES.length)
    expect([...await blobBytes(back.blob)]).toEqual([...PNG_BYTES])
    expect(back.name).toBe('原图.png')
    expect(back.asset_path).toBeUndefined()
    expect(back.id).toBe('s1')
  })

  it('text：完整保留原文，无 asset；恢复不产生 blob', async () => {
    const text = '请在本周五前提交实验报告，字数不超过2000字。含换行\n第二行。'
    const src = { id: 's2', workspace_id: 'w', kind: 'text', captured_at: '2026-11-20T09:05:00+08:00', text }
    const { record, asset } = await sourceToBackup(src)
    expect(asset).toBe(null)
    expect(record.asset_path).toBeUndefined()
    expect(record.text).toBe(text)
    const back = sourceFromBackup(record, null)
    expect(back.text).toBe(text)
    expect(back.blob).toBeUndefined()
  })

  it('image 缺本地字节 → ASSET_MISSING（不生成宣称完整的备份）', async () => {
    const src = { id: 's3', workspace_id: 'w', kind: 'image', captured_at: '2026-11-20T09:00:00+08:00' }
    await expect(sourceToBackup(src)).rejects.toMatchObject({ code: 'ASSET_MISSING' })
  })

  it('image 非栅格（SVG）→ ASSET_TYPE_UNSUPPORTED', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const src = { id: 's4', workspace_id: 'w', kind: 'image', captured_at: '2026-11-20T09:00:00+08:00', blob: new Blob([svg], { type: 'image/svg+xml' }) }
    await expect(sourceToBackup(src)).rejects.toMatchObject({ code: 'ASSET_TYPE_UNSUPPORTED' })
  })

  it('恢复 image 缺归档字节 → ASSET_MISSING', () => {
    const record = { id: 's5', workspace_id: 'w', kind: 'image', captured_at: '2026-11-20T09:00:00+08:00', asset_path: 'assets/s5.png' }
    expect(() => sourceFromBackup(record, null)).toThrowError(/缺少归档字节/)
  })

  it('businessCoreOfSource 投影掉 blob/name/asset_path，不改原记录', () => {
    const src = { id: 's6', kind: 'image', workspace_id: 'w', captured_at: 'x', blob: new Blob([PNG_BYTES]), name: 'n', asset_path: 'assets/s6.png' }
    const core = businessCoreOfSource(src)
    for (const f of SOURCE_LOCAL_ONLY) expect(core[f]).toBeUndefined()
    expect(src.name).toBe('n')
    expect(src.asset_path).toBe('assets/s6.png')
  })
})

describe('本地字段适配 · docs', () => {
  it('每种 kind 的本地额外字段投影正确，备份 round-trip 全保留', () => {
    for (const kind of DOC_KINDS) {
      const rec = { id: `${kind}-1`, kind, workspace_id: 'w' }
      for (const f of LOCAL_ONLY_DOC_FIELDS[kind]) rec[f] = f === 'warnings' ? [{ code: 'demo_data', message: 'x' }] : (f === 'error' ? 'MODEL_DOWN' : kind)
      const backup = docToBackup(rec)
      expect(backup.kind).toBe(kind) // 备份保留本地 kind
      const core = businessCoreOfDoc(rec)
      for (const f of LOCAL_ONLY_DOC_FIELDS[kind]) expect(core[f]).toBeUndefined()
      const back = docFromBackup(backup)
      expect(back).toEqual(rec) // 无损往返
      expect(rec.kind).toBe(kind) // 原记录不被修改
    }
  })

  it('note 的 warnings/error 是已保存事实，备份保留、业务核心投影掉', () => {
    const note = { id: 'n1', kind: 'note', workspace_id: 'w', source_id: 's1', status: 'failed', content_type: 'reference', title: 'x', fields: [], warnings: [{ code: 'demo_data', message: '演示' }], error: 'MODEL_DOWN', created_at: 'a', updated_at: 'b' }
    const backup = docToBackup(note)
    expect(backup.warnings).toEqual(note.warnings)
    expect(backup.error).toBe('MODEL_DOWN')
    const core = businessCoreOfDoc(note)
    expect(core.warnings).toBeUndefined()
    expect(core.error).toBeUndefined()
    expect(core.status).toBe('failed')
  })
})