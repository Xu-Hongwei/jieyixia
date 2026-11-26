import { describe, it, expect } from 'vitest'
import { validateAgainstDef } from '@/services/backup/contractSchema'
import { isAllowedArchivePath, detectImageType, sha256Hex, backupFilename } from '@/services/backup/format'
import { businessCoreOfDoc, sourceToBackup, sourceFromBackup } from '@/services/backup/adapt'

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

describe('backup smoke', () => {
  it('契约 schema 运行时可导入并校验业务核心', () => {
    const action = { id: 'a1', workspace_id: 'personal', task_id: 't1', text: '写教育背景', minutes: 25, basis: 'user', done: false, created_at: '2026-11-21T10:00:00+08:00' }
    expect(validateAgainstDef('Action', action).ok).toBe(true)
    expect(validateAgainstDef('Action', { ...action, kind: 'action' }).ok).toBe(false) // kind 是本地元数据
    expect(validateAgainstDef('Action', { ...action, minutes: -5 }).ok).toBe(true) // schema 无 minimum，数值语义在 validate.js
  })

  it('路径规则', () => {
    expect(isAllowedArchivePath('manifest.json')).toBe(true)
    expect(isAllowedArchivePath('data/docs.json')).toBe(true)
    expect(isAllowedArchivePath('assets/a1.png')).toBe(true)
    expect(isAllowedArchivePath('../evil.json')).toBe(false)
    expect(isAllowedArchivePath('/abs.json')).toBe(false)
    expect(isAllowedArchivePath('assets\\a1.png')).toBe(false)
    expect(isAllowedArchivePath('assets/a1.svg')).toBe(false)
  })

  it('图片按真实字节识别 + SHA-256', async () => {
    expect(detectImageType(PNG).mime).toBe('image/png')
    expect(detectImageType(new TextEncoder().encode('<svg></svg>'))).toBe(null)
    const h = await sha256Hex(PNG)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('Source blob↔asset round-trip 保留真实字节与 name', async () => {
    const src = { id: 'src1', workspace_id: 'personal', kind: 'image', captured_at: '2026-11-21T10:00:00+08:00', blob: new Blob([PNG], { type: 'image/png' }), name: '项目截图.png' }
    const { record, asset } = await sourceToBackup(src)
    expect(record.blob).toBeUndefined()
    expect(record.asset_path).toBe('assets/src1.png')
    expect(record.name).toBe('项目截图.png')
    expect([...asset.bytes]).toEqual([...PNG])
    const back = sourceFromBackup(record, asset.bytes)
    expect(back.name).toBe('项目截图.png')
    expect(back.asset_path).toBeUndefined()
    const roundBytes = new Uint8Array(await back.blob.arrayBuffer())
    expect([...roundBytes]).toEqual([...PNG])
  })

  it('docs 业务核心投影保留 warnings/error 于备份记录', () => {
    const note = { id: 'n1', kind: 'note', workspace_id: 'personal', source_id: 'src1', status: 'failed', content_type: 'reference', title: 'x', fields: [], warnings: [], error: 'MODEL_DOWN', matter_id: null, matter_role: null, created_at: '2026-11-21T10:00:00+08:00', updated_at: '2026-11-21T10:00:00+08:00' }
    const core = businessCoreOfDoc(note)
    expect(core.kind).toBeUndefined()
    expect(core.warnings).toBeUndefined()
    expect(core.error).toBeUndefined()
    expect(note.error).toBe('MODEL_DOWN') // 原记录不被修改
  })

  it('文件名规范', () => {
    const fn = backupFilename('个人空间', new Date('2026-11-22T15:30:00+08:00'))
    expect(fn).toBe('截下来-个人空间-20261122-153000.jxl-backup.zip')
  })
})