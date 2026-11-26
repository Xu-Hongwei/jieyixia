// 4-1 导出独立 oracle（开工单 §11）：不依赖导出器↔导入器互证，
// 而是 pack→unpack→validateBackup 后，对「解包原始字节/字段/哈希」与独立常量逐项断言。
// 全部临时 Context + 虚构数据，绝不触用户真实库。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { buildBackup, checkExportable } from '@/services/backup/export'
import { packArchive, unpackArchive } from '@/services/backup/zip'
import { validateBackup } from '@/services/backup/validate'
import { sourceToBackup } from '@/services/backup/adapt'
import { sha256Hex, backupFilename, MANIFEST_PATH, SOURCES_PATH, DOCS_PATH, ASSISTANT_THREADS_PATH, ASSISTANT_DRAFTS_PATH, SCHEMA_VERSION, LIMITS, utf8Bytes, detectImageType } from '@/services/backup/format'
import { fictionalRecords, PNG_BYTES, WS, findDoc } from './backupFixtures'

// 最小 JPEG（magic FF D8 FF … FF D9）：类型识别按真实字节，不要求完整解码。
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
const INSTANT = new Date('2026-11-22T15:30:00+08:00')
const OPTS = { backupId: 'bk-export-0001', exportedAt: '2026-11-22T15:30:00+08:00', instant: INSTANT }

// 本地形态快照：image 用真实 Blob（非 asset_path），text 用 text；docs 用本地 kind 形态。
function localSnapshot(over = {}) {
  const { docs } = fictionalRecords()
  const sources = [
    { id: 'src-img', workspace_id: WS.id, kind: 'image', captured_at: '2026-11-20T09:00:00+08:00', blob: new Blob([PNG_BYTES], { type: 'image/png' }), name: '通知截图.png' },
    { id: 'src-txt', workspace_id: WS.id, kind: 'text', captured_at: '2026-11-20T09:05:00+08:00', text: '请在本周五前提交实验报告，字数不超过2000字。' },
  ]
  return { workspaceId: WS.id, workspace: WS, sources, docs, ...over }
}

const entryOf = (entries, path) => entries.find((e) => e.path === path)
const jsonOf = (entries, path) => JSON.parse(new TextDecoder().decode(entryOf(entries, path).bytes))

// 独立 oracle：解包后逐载荷哈希必须等于「对解包原始字节重新计算的 SHA-256」，且与 manifest 声明一致。
async function oracle(result) {
  const { entries } = unpackArchive(result.zipBytes)
  const v = await validateBackup({ entries, zipBytes: result.zipBytes })
  expect(v.ok, JSON.stringify(v.errors)).toBe(true)
  for (const p of result.manifest.payloads) {
    const bytes = entryOf(entries, p.path).bytes
    expect(bytes.length).toBe(p.bytes)
    expect(await sha256Hex(bytes)).toBe(p.sha256)
  }
  return { entries, v }
}

describe('4-1 导出：真实 ZIP 与原图字节（D01）', () => {
  it('完整空间导出→解包→三层校验通过，原图字节与独立 PNG 常量逐字节一致', async () => {
    const result = await buildBackup(localSnapshot(), OPTS)
    expect(result.zipBytes).toBeInstanceOf(Uint8Array)
    expect(result.zipBytes.length).toBeGreaterThan(0)
    const { entries } = await oracle(result)
    const asset = entryOf(entries, 'assets/src-img.png')
    expect([...asset.bytes]).toEqual([...PNG_BYTES]) // 真实字节，非 Blob 空对象 {}
    const src = jsonOf(entries, SOURCES_PATH).find((s) => s.id === 'src-img')
    expect(src.blob).toBeUndefined()
    expect(src.asset_path).toBe('assets/src-img.png')
    expect(src.name).toBe('通知截图.png')
  })

  it('JPEG 原图按真实字节识别为 jpg 资产，扩展名与类型一致', async () => {
    const snap = localSnapshot()
    snap.sources[0] = { ...snap.sources[0], blob: new Blob([JPEG_BYTES], { type: 'image/jpeg' }), name: '照片.jpg' }
    const result = await buildBackup(snap, OPTS)
    const { entries } = await oracle(result)
    expect([...entryOf(entries, 'assets/src-img.jpg').bytes]).toEqual([...JPEG_BYTES])
    expect(result.summary.imageCount).toBe(1)
  })

  it('中文空间名/资料名进文件名与元数据，ZIP 路径仍由应用生成（不含中文路径）', async () => {
    const result = await buildBackup(localSnapshot(), OPTS)
    expect(result.filename).toBe(backupFilename(WS.name, INSTANT))
    expect(result.filename).toContain('虚构来源空间')
    const { entries } = await oracle(result)
    for (const e of entries) expect(e.path).toMatch(/^(manifest\.json|data\/[A-Za-z0-9_-]+\.json|assets\/[A-Za-z0-9_-]+\.(png|jpg|webp|gif))$/)
    expect(jsonOf(entries, SOURCES_PATH).find((s) => s.id === 'src-img').name).toBe('通知截图.png')
  })

  it('空空间生成合法空备份（manifest+两个空数组 JSON+两个空助手 wrapper），计数全 0', async () => {
    const result = await buildBackup({ workspaceId: WS.id, workspace: WS, sources: [], docs: [] }, OPTS)
    const { entries, v } = await oracle(result)
    expect(entries.map((e) => e.path).sort()).toEqual([DOCS_PATH, MANIFEST_PATH, SOURCES_PATH, ASSISTANT_THREADS_PATH, ASSISTANT_DRAFTS_PATH].sort())
    expect(jsonOf(entries, SOURCES_PATH)).toEqual([])
    expect(jsonOf(entries, DOCS_PATH)).toEqual([])
    expect(jsonOf(entries, ASSISTANT_THREADS_PATH)).toEqual({ schema_version: SCHEMA_VERSION, threads: [] })
    expect(jsonOf(entries, ASSISTANT_DRAFTS_PATH)).toEqual({ schema_version: SCHEMA_VERSION, drafts: [] })
    expect(result.manifest.source_count).toBe(0)
    expect(result.manifest.image_count).toBe(0)
    expect(Object.values(result.manifest.counts).every((n) => n === 0)).toBe(true)
    expect(v.summary.sourceCount).toBe(0)
  })
})

describe('4-1 导出：完整记录与字段不丢（D02）', () => {
  it('便签字段/分组/行动/结果/旧 PlanItem 全保留，计数与 manifest 一致', async () => {
    const result = await buildBackup(localSnapshot(), OPTS)
    const { entries } = await oracle(result)
    const docs = jsonOf(entries, DOCS_PATH)
    const note = findDoc(docs, 'note-1')
    expect(note.fields).toHaveLength(3)
    expect(note.warnings).toEqual([])
    expect(note.matter_id).toBe('matter-1')
    expect(note.matter_role).toBe('requirement')
    expect(findDoc(docs, 'matter-1').note_ids).toEqual(['note-1'])
    expect(findDoc(docs, 'task-1').deadline.value).toBe('2026-11-27')
    expect(findDoc(docs, 'action-1').minutes).toBe(60)
    expect(findDoc(docs, 'focus-ended').outcome).toBe('partial')
    expect(findDoc(docs, 'plan-1').actual_minutes).toBe(30)
    expect(findDoc(docs, 'focus-v0').record_version).toBe(0)
    const { docs: origDocs } = fictionalRecords()
    for (const k of Object.keys(result.manifest.counts)) {
      expect(result.manifest.counts[k]).toBe(origDocs.filter((d) => d.kind === k).length)
    }
  })

  it('未适配 kind 显式拒绝并列计数，不悄悄遗漏', async () => {
    const snap = localSnapshot()
    snap.docs = [...snap.docs, { id: 'draft-1', workspace_id: WS.id, kind: 'plan_draft', title: 'x' }, { id: 'draft-2', workspace_id: WS.id, kind: 'plan_draft', title: 'y' }]
    expect(() => checkExportable(snap)).toThrowError(/未适配/)
    let caught
    try { await buildBackup(snap, OPTS) } catch (e) { caught = e }
    expect(caught.code).toBe('UNSUPPORTED_KIND')
    expect(caught.unknownDocs.plan_draft).toBe(2)
  })

  it('缺本地原图字节→显式 ASSET_MISSING，不生成宣称完整的备份', async () => {
    const snap = localSnapshot()
    snap.sources[0] = { id: 'src-img', workspace_id: WS.id, kind: 'image', captured_at: '2026-11-20T09:00:00+08:00', name: '坏图.png' }
    let caught
    try { await buildBackup(snap, OPTS) } catch (e) { caught = e }
    expect(caught.code).toBe('ASSET_MISSING')
    expect(caught.sourceId).toBe('src-img')
  })

  it('无法识别的栅格类型→ASSET_TYPE_UNSUPPORTED，不静默丢失', async () => {
    const snap = localSnapshot()
    snap.sources[0] = { ...snap.sources[0], blob: new Blob([new TextEncoder().encode('<svg></svg>')], { type: 'image/svg+xml' }) }
    let caught
    try { await buildBackup(snap, OPTS) } catch (e) { caught = e }
    expect(caught.code).toBe('ASSET_TYPE_UNSUPPORTED')
  })
})

describe('4-1 导出：运行态只导已保存事实（D04）', () => {
  it('运行中会话只导已保存 accumulated_ms/draft_md，不按锚点另算时间，不导运行锁/凭据', async () => {
    const snap = localSnapshot()
    // 移除夹具中已存在的未结束（暂停）会话，保证全空间至多 1 份未结束。
    snap.docs = snap.docs.filter((d) => d.id !== 'focus-paused')
    const running = {
      id: 'focus-running', workspace_id: WS.id, kind: 'focus_session', task_id: 'task-1', action_id: 'action-1', plan_item_id: null,
      started_at: '2026-11-22T14:00:00+08:00', accumulated_ms: 123456, running: true, draft_md: '写到一半',
      outcome: null, blocker: null, ended_at: null, is_demo: false, record_version: 1,
      timer_anchor_at: '2026-11-22T15:00:00+08:00',
      task_snapshot: { title: '完成实验报告', matter_name: '实验报告', deadline_value: '2026-11-27', deadline_precision: 'date', captured_at: '2026-11-22T14:00:00+08:00' },
      action_snapshot: { text: '撰写报告正文', minutes: 60, captured_at: '2026-11-22T14:00:00+08:00' },
      task_ref_state: 'active', action_ref_state: 'active',
    }
    snap.docs = [...snap.docs, running]
    const result = await buildBackup(snap, OPTS)
    const { entries } = await oracle(result)
    const s = findDoc(jsonOf(entries, DOCS_PATH), 'focus-running')
    expect(s.accumulated_ms).toBe(123456) // 已保存值原样，未被「now-锚点」膨胀
    expect(s.draft_md).toBe('写到一半')
    expect(s.running).toBe(true)
    for (const forbidden of ['owner_id', 'lease_expires_at', 'epoch', 'draft_seq', 'focus_runtime', 'run_id']) {
      expect(s[forbidden]).toBeUndefined()
    }
  })
})

describe('4-1 导出：空间归属与切换不混入（D03）', () => {
  it('manifest 归属以快照 wsId 为准，与全局当前空间无关', async () => {
    const result = await buildBackup(localSnapshot(), OPTS)
    expect(result.manifest.source_workspace.id).toBe(WS.id)
    expect(result.manifest.source_workspace.name).toBe(WS.name)
    const { entries } = await oracle(result)
    for (const d of jsonOf(entries, DOCS_PATH)) expect(d.workspace_id).toBe(WS.id)
    for (const s of jsonOf(entries, SOURCES_PATH)) expect(s.workspace_id).toBe(WS.id)
  })

  it('目录元数据缺失时按 id 退化命名，不冒充别处空间', async () => {
    const result = await buildBackup({ workspaceId: 'demo', workspace: null, sources: [], docs: [] }, OPTS)
    expect(result.manifest.source_workspace).toEqual({ id: 'demo', name: '演示空间', is_demo: true })
  })
})

describe('4-1 一致只读快照：readWorkspaceSnapshot 不混入别处空间', () => {
  let db
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory()
    vi.resetModules()
    db = await import('../services/storage/db')
  })

  it('切换到 demo 后读 personal 快照，仍只含 personal 记录（同一时间点固定快照）', async () => {
    db.configureWorkspace('personal')
    await db.putWorkspace({ id: 'personal', name: '个人空间', is_demo: false })
    await db.putSource({ id: 'p-src', kind: 'text', captured_at: '2026-11-20T09:00:00+08:00', text: '个人文字' })
    await db.putDoc({ id: 'p-note', kind: 'note', title: '个人便签' })
    db.configureWorkspace('demo')
    await db.putWorkspace({ id: 'demo', name: '演示空间', is_demo: true })
    await db.putSource({ id: 'd-src', kind: 'text', captured_at: '2026-11-20T09:00:00+08:00', text: '演示文字' })
    await db.putDoc({ id: 'd-note', kind: 'note', title: '演示便签' })

    const snap = await db.readWorkspaceSnapshot('personal')
    expect(snap.workspaceId).toBe('personal')
    expect(snap.workspace.name).toBe('个人空间')
    expect(snap.sources.map((s) => s.id)).toEqual(['p-src'])
    expect(snap.docs.map((d) => d.id)).toEqual(['p-note'])
    for (const r of [...snap.sources, ...snap.docs]) expect(r.workspace_id).toBe('personal')
  })

  it('空空间快照返回空数组与 null 目录（合法空备份输入）', async () => {
    db.configureWorkspace('personal')
    const snap = await db.readWorkspaceSnapshot('personal')
    expect(snap.sources).toEqual([])
    expect(snap.docs).toEqual([])
    expect(snap.workspace).toBeNull()
  })
})

describe('4-1 ZIP 打包/解包边界', () => {
  it('非法路径与重复路径拒绝打包', () => {
    expect(() => packArchive([{ path: '../evil.json', bytes: new Uint8Array([1]) }])).toThrowError(/非法归档路径/)
    expect(() => packArchive([{ path: 'data/docs.json', bytes: new Uint8Array([1]) }, { path: 'data/docs.json', bytes: new Uint8Array([2]) }])).toThrowError(/重复/)
  })

  it('损坏 ZIP 解包显式报错，不返回半成品', () => {
    expect(() => unpackArchive(Uint8Array.from([0x50, 0x4b, 0x00, 0x00]))).toThrowError(/合法 ZIP|损坏/)
  })

  it('pack→unpack 往返字节一致', () => {
    const entries = [{ path: 'data/docs.json', bytes: new TextEncoder().encode('[]') }, { path: 'assets/a.png', bytes: PNG_BYTES }]
    const { entries: back } = unpackArchive(packArchive(entries))
    expect([...entryOf(back, 'assets/a.png').bytes]).toEqual([...PNG_BYTES])
    expect(new TextDecoder().decode(entryOf(back, 'data/docs.json').bytes)).toBe('[]')
  })
})

// P2 整改（复审 F1）：生产 buildBackup 必须在下载前过 4-0 完整校验。
// 反例 A（超限文本）/反例 B（非法记录）/错误活引用都显式抛错、零产物；限额边界值与刚超限各一组。
describe('4-1 导出：生产链下载前完整校验（P2 整改）', () => {
  const CAP = '2026-11-20T09:05:00+08:00'
  // 单条文字资料 sources.json 的实际字节数：ASCII 'a' 每字符 1 字节，JSON 开销恒定，可精确命中边界。
  async function textJsonBytes(textLen) {
    const src = { id: 'src-txt', workspace_id: WS.id, kind: 'text', captured_at: CAP, text: 'a'.repeat(textLen) }
    const { record } = await sourceToBackup(src)
    return utf8Bytes(JSON.stringify([record])).length
  }
  const textSnapshot = (textLen) => ({
    workspaceId: WS.id, workspace: WS, docs: [],
    sources: [{ id: 'src-txt', workspace_id: WS.id, kind: 'text', captured_at: CAP, text: 'a'.repeat(textLen) }],
  })
  // 仅 magic 合法的 JPEG 字节（校验器按 magic+大小判定，不要求完整解码）；用于精确命中图片限额。
  function imageSnapshot(len) {
    const b = new Uint8Array(len)
    b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff
    return {
      workspaceId: WS.id, workspace: WS, docs: [],
      sources: [{ id: 'src-img', workspace_id: WS.id, kind: 'image', captured_at: '2026-11-20T09:00:00+08:00', blob: new Blob([b], { type: 'image/jpeg' }), name: '大图.jpg' }],
    }
  }
  const expectBlocked = async (snap) => {
    let caught
    try { await buildBackup(snap, OPTS) } catch (e) { caught = e }
    expect(caught, '应抛错而非返回成功产物').toBeDefined()
    expect(caught.code).toBe('BACKUP_VALIDATION_FAILED')
    expect(Array.isArray(caught.errors) && caught.errors.length).toBeGreaterThan(0)
    return caught
  }

  it('JSON 限额边界值：sources.json 恰为 25MiB 仍合法导出（不误拒）', async () => {
    const overhead = await textJsonBytes(0)
    const atLimit = LIMITS.JSON_MAX_BYTES - overhead
    expect(await textJsonBytes(atLimit)).toBe(LIMITS.JSON_MAX_BYTES) // 自证边界精确
    const result = await buildBackup(textSnapshot(atLimit), OPTS)
    const { entries } = await oracle(result)
    expect(entryOf(entries, SOURCES_PATH).bytes.length).toBe(LIMITS.JSON_MAX_BYTES)
  }, 30000)

  it('反例 A：JSON 刚超限 1 字节→压缩前拒绝，零产物（压缩后体积小不代表可恢复）', async () => {
    const overhead = await textJsonBytes(0)
    const over = LIMITS.JSON_MAX_BYTES - overhead + 1
    expect(await textJsonBytes(over)).toBe(LIMITS.JSON_MAX_BYTES + 1)
    const caught = await expectBlocked(textSnapshot(over))
    expect(caught.errors.some((e) => e.layer === 'A' && /JSON 超过单文件上限/.test(e.message))).toBe(true)
  }, 30000)

  it('图片限额边界值：单图恰为 25MiB 仍合法导出，原图字节与类型保留', async () => {
    const result = await buildBackup(imageSnapshot(LIMITS.IMAGE_MAX_BYTES), OPTS)
    const { entries } = await oracle(result)
    const asset = entryOf(entries, 'assets/src-img.jpg')
    expect(asset.bytes.length).toBe(LIMITS.IMAGE_MAX_BYTES)
    expect(detectImageType(asset.bytes).ext).toBe('jpg')
  }, 30000)

  it('超限图片：单图刚超限 1 字节→压缩前拒绝，零产物', async () => {
    const caught = await expectBlocked(imageSnapshot(LIMITS.IMAGE_MAX_BYTES + 1))
    expect(caught.errors.some((e) => e.layer === 'A' && /图片超过单文件上限/.test(e.message))).toBe(true)
  }, 30000)

  it('反例 B：非法记录（任务带未批准字段 priority）→B 层拒绝，零产物', async () => {
    const snap = localSnapshot()
    findDoc(snap.docs, 'task-1').priority = 'high' // 契约 Task additionalProperties:false
    const caught = await expectBlocked(snap)
    expect(caught.errors.some((e) => e.layer === 'B' && /未知字段 priority/.test(e.message))).toBe(true)
  })

  it('错误活引用：便签 source_id 指向包内不存在的资料→C 层拒绝，零产物', async () => {
    const snap = localSnapshot()
    findDoc(snap.docs, 'note-1').source_id = 'src-missing'
    const caught = await expectBlocked(snap)
    expect(caught.errors.some((e) => e.layer === 'C' && /引用不存在的对象/.test(e.message) && /src-missing/.test(e.message))).toBe(true)
  })

  it('合法完整空间与空空间仍照常产出可下载 ZIP（整改不误伤正常路径）', async () => {
    const full = await buildBackup(localSnapshot(), OPTS)
    expect(full.zipBytes).toBeInstanceOf(Uint8Array)
    await oracle(full)
    const empty = await buildBackup({ workspaceId: WS.id, workspace: WS, sources: [], docs: [] }, OPTS)
    expect(empty.zipBytes).toBeInstanceOf(Uint8Array)
    await oracle(empty)
  })
})