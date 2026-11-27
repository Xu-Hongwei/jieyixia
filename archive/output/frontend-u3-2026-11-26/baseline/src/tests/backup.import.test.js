// 4-2 R1b 统一检查/预览/准备链验收：同一份已校验数据供预览与提交；ID 重建/历史隔离/
// 未结束安全转换/Source→Blob/目标复检/默认名/冻结映射。全部零数据库写入（纯编排）。
import { describe, it, expect } from 'vitest'
import { inspectBackupFile, restorePreview, prepareRestore, beijingLabel } from '@/services/backup/import'
import { packArchive } from '@/services/backup/zip'
import { sha256Hex, LIMITS, defaultRestoreName } from '@/services/backup/format'
import { focusRecordVersion } from '@/services/backup/adapt'
import { RECOVERY_OWNER_PREFIX } from '@/services/backup/recovery'
import { runId, opsId, sessId } from '@/services/focus/runtime'
import { buildCompleteBackup, assembleArchive, fictionalRecords, WS, PNG_BYTES } from './backupFixtures'

const fileOf = (bytes, name = '虚构备份.zip') => new File([bytes], name, { type: 'application/zip' })
const counter = () => { let c = 0; return () => `new-${++c}` }
const codeOf = async (p) => { try { await p; return null } catch (e) { return e.code } }

async function inspectedComplete() {
  const { entries } = await buildCompleteBackup()
  const zip = packArchive(entries)
  return { ins: await inspectBackupFile(fileOf(zip)), zip }
}

describe('4-2 R1b 检查备份文件（零写入）', () => {
  it('真实导出 ZIP：ok=true，指纹=原始字节 SHA-256，解析数据与校验同一份', async () => {
    const { ins, zip } = await inspectedComplete()
    expect(ins.ok).toBe(true)
    expect(ins.errors).toEqual([])
    expect(ins.fingerprint).toBe(await sha256Hex(zip))
    expect(ins.fileSize).toBe(zip.length)
    expect(ins.sources).toHaveLength(2)
    expect(ins.docs).toHaveLength(10)
    expect(ins.assets.get('assets/src-img.png')).toEqual(PNG_BYTES)
    expect(ins.manifest.source_workspace.id).toBe(WS.id)
    expect(ins.summary.unfinishedCount).toBe(1)
  })

  it('File.size 超上限：读取前即拒（不分配大字节）', async () => {
    const stub = { name: 'big.zip', size: LIMITS.ZIP_MAX_BYTES + 1, arrayBuffer: async () => { throw new Error('不应被读取') } }
    expect(await codeOf(inspectBackupFile(stub))).toBe('ZIP_TOO_LARGE')
  })

  it('篡改哈希的备份：ok=false 列原因，零写入', async () => {
    const { entries, manifest } = await buildCompleteBackup()
    // 改 sources.json 一个字节但 manifest 哈希不变 → A 层 SHA-256 不符。
    const src = entries.find((e) => e.path === 'data/sources.json')
    const tampered = src.bytes.slice()
    tampered[tampered.length - 2] ^= 0xff
    const bad = entries.map((e) => (e.path === 'data/sources.json' ? { path: e.path, bytes: tampered } : e))
    const ins = await inspectBackupFile(fileOf(packArchive(bad)))
    expect(ins.ok).toBe(false)
    expect(ins.errors.some((e) => e.layer === 'A' && /SHA-256/.test(e.message))).toBe(true)
    expect(manifest).toBeTruthy()
  })

  it('开始前已取消 → ZIP_CANCELLED', async () => {
    const { entries } = await buildCompleteBackup()
    const ac = new AbortController(); ac.abort()
    expect(await codeOf(inspectBackupFile(fileOf(packArchive(entries)), { signal: ac.signal }))).toBe('ZIP_CANCELLED')
  })

  it('非文件输入 → BAD_FILE', async () => {
    expect(await codeOf(inspectBackupFile(null))).toBe('BAD_FILE')
  })
})

describe('4-2 R1b 预览摘要', () => {
  it('默认名/计数/图片体积/未结束数/北京导出时刻/转换提示', async () => {
    const { ins } = await inspectedComplete()
    const now = new Date('2026-11-22T16:00:00+08:00')
    const p = restorePreview(ins, { now })
    expect(p.defaultName).toBe(defaultRestoreName(WS.name, now))
    expect(p.sourceWorkspaceName).toBe(WS.name)
    expect(p.counts.focus_session).toBe(4)
    expect(p.imageCount).toBe(1)
    expect(p.imageBytes).toBe(PNG_BYTES.length)
    expect(p.unfinishedCount).toBe(1)
    expect(p.schemaVersion).toBe('0.4.0')
    expect(p.exportedAtBeijing).toBe('2026-11-22 15:30:00')
    expect(p.transforms.length).toBe(3)
  })
  it('beijingLabel 把 UTC Z 时刻正确换算为北京', () => {
    expect(beijingLabel('2026-11-22T07:30:00Z')).toBe('2026-11-22 15:30:00')
    expect(beijingLabel('非法')).toBeNull()
  })
})

describe('4-2 R1b 准备恢复（冻结、零写入）', () => {
  const target = 'ws-restore-1'
  const base = { targetWorkspaceId: target, targetName: '恢复空间', operationId: 'op-1', nowMs: 1_800_000_000_000, createdAt: '2026-11-22T16:00:00+08:00' }

  it('全量新 ID + 目标归属 + 引用闭合 + 历史隔离', async () => {
    const { ins } = await inspectedComplete()
    const prep = prepareRestore({ inspected: ins, ...base, newId: counter() })
    const liveIds = new Set([...prep.liveMap.values()])
    // 所有活对象换新 ID，且不出现在原 ID 集合
    const oldIds = new Set([...ins.sources, ...ins.docs].map((r) => r.id))
    for (const id of liveIds) expect(oldIds.has(id)).toBe(false)
    for (const s of prep.sources) { expect(s.workspace_id).toBe(target); expect(liveIds.has(s.id)).toBe(true) }
    for (const d of prep.docs) { expect(d.workspace_id).toBe(target); expect(liveIds.has(d.id)).toBe(true) }
    // note.source_id 指向新 source；task.current_action_id 指向新 action
    const note = prep.docs.find((d) => d.kind === 'note')
    expect(prep.liveMap.get('src-img')).toBe(note.source_id)
    const task = prep.docs.find((d) => d.id === prep.liveMap.get('task-1'))
    expect(task.current_action_id).toBe(prep.liveMap.get('action-1'))
    expect(task.deadline.from_note_id).toBe(prep.liveMap.get('note-1'))
    // 已删历史引用隔离为新标识，且不等于任何活 ID
    const deleted = prep.docs.find((d) => d.id === prep.liveMap.get('focus-deleted'))
    expect(deleted.task_id).toBe(prep.historyMap.get('task-gone'))
    expect(liveIds.has(deleted.task_id)).toBe(false)
    expect(deleted.task_ref_state).toBe('deleted')
  })

  it('正文/草稿/快照里的旧 ID 字符串不被改写（非引用路径）', async () => {
    const { ins } = await inspectedComplete()
    const prep = prepareRestore({ inspected: ins, ...base, newId: counter() })
    const ended = prep.docs.find((d) => d.id === prep.liveMap.get('focus-ended'))
    expect(ended.draft_md).toBe('已完成初稿')
    expect(ended.outcome).toBe('partial')
    expect(ended.accumulated_ms).toBe(1800000)
    expect(ended.task_snapshot.title).toBe('完成实验报告')
    const note = prep.docs.find((d) => d.kind === 'note')
    expect(note.fields[0].quote.text).toBe('本周五前提交')
  })

  it('未结束 v1 → 暂停待确认 + 过期占位 runtime；目标 run 不占全局运行位', async () => {
    const { ins } = await inspectedComplete()
    const prep = prepareRestore({ inspected: ins, ...base, newId: counter() })
    const paused = prep.docs.find((d) => d.id === prep.liveMap.get('focus-paused'))
    expect(paused.running).toBe(false)
    expect(paused.timer_anchor_at).toBeNull()
    expect(paused.outcome).toBeNull()
    expect(paused.ended_at).toBeNull()
    expect(paused.accumulated_ms).toBe(600000)
    expect(paused.draft_md).toBe('检查中')
    expect(prep.unfinishedV1).toContain(paused.id)
    const rt = prep.runtimePuts.find((r) => r.id === sessId(paused.id))
    expect(rt.owner_id.startsWith(RECOVERY_OWNER_PREFIX)).toBe(true)
    expect(rt.lease_expires_at).toBeLessThan(base.nowMs)
    expect(rt.recovery).toBeNull()
    const run = prep.runtimePuts.find((r) => r.id === runId(target))
    expect(run.session_id).toBeNull()
    expect(prep.runtimePuts.some((r) => r.id === opsId(target))).toBe(true)
  })

  it('已结束 v1/v0 会话：outcome/版本/累计原样保留，仅 remap 引用', async () => {
    const { ins } = await inspectedComplete()
    const prep = prepareRestore({ inspected: ins, ...base, newId: counter() })
    const ended = prep.docs.find((d) => d.id === prep.liveMap.get('focus-ended'))
    expect(focusRecordVersion(ended)).toBe(1)
    expect(ended.outcome).toBe('partial')
    expect(ended.ended_at).toBe('2026-11-21T10:30:00+08:00')
    const v0 = prep.docs.find((d) => d.id === prep.liveMap.get('focus-v0'))
    expect(focusRecordVersion(v0)).toBe(0)
    expect(v0.outcome).toBe('done')
    expect(v0.timer_anchor_at).toBeUndefined()
  })

  it('Source→本地 Blob：去 asset_path，字节/类型与已校验资产一致', async () => {
    const { ins } = await inspectedComplete()
    const prep = prepareRestore({ inspected: ins, ...base, newId: counter() })
    const img = prep.sources.find((s) => s.kind === 'image')
    expect(img.asset_path).toBeUndefined()
    expect(img.blob).toBeInstanceOf(Blob)
    expect(img.blob.size).toBe(PNG_BYTES.length)
    expect(img.blob.type).toBe('image/png')
    expect(new Uint8Array(await img.blob.arrayBuffer())).toEqual(PNG_BYTES)
    const txt = prep.sources.find((s) => s.kind === 'text')
    expect(txt.text).toContain('实验报告')
    expect(txt.asset_path).toBeUndefined()
  })

  it('目标恒为普通空间 is_demo=false（即使来源是演示空间）', async () => {
    const { sources, docs, assets } = fictionalRecords()
    // 仅翻转归属与「本就含 is_demo 字段」的记录标志（Action/PlanItem 契约无 is_demo，不得擅加）。
    const demoArchive = await assembleArchive({
      workspace: { id: 'demo', name: '演示空间', is_demo: true },
      sources: sources.map((s) => ({ ...s, workspace_id: 'demo', is_demo: true })),
      docs: docs.map((d) => ({ ...d, workspace_id: 'demo', ...('is_demo' in d ? { is_demo: true } : {}) })),
      assets,
    })
    const ins = await inspectBackupFile(fileOf(packArchive(demoArchive.entries)))
    expect(ins.ok).toBe(true)
    const prep = prepareRestore({ inspected: ins, ...base, newId: counter() })
    expect(prep.targetWorkspace.is_demo).toBe(false)
    for (const s of prep.sources) expect(s.is_demo).toBe(false)
    for (const d of prep.docs) if ('is_demo' in d) expect(d.is_demo).toBe(false)
  })

  it('冻结映射：确定性 newId 下两次准备产出完全相同的 ID 映射', async () => {
    const { ins } = await inspectedComplete()
    const a = prepareRestore({ inspected: ins, ...base, newId: counter() })
    const b = prepareRestore({ inspected: ins, ...base, newId: counter() })
    expect([...a.liveMap.entries()]).toEqual([...b.liveMap.entries()])
    expect([...a.historyMap.entries()]).toEqual([...b.historyMap.entries()])
    expect(a.docs.map((d) => d.id)).toEqual(b.docs.map((d) => d.id))
  })

  it('名称 trim/长度校验与目标拒绝', async () => {
    const { ins } = await inspectedComplete()
    expect(() => prepareRestore({ inspected: ins, ...base, targetName: '   ', newId: counter() })).toThrowError(/1–80/)
    expect(() => prepareRestore({ inspected: ins, ...base, targetName: 'x'.repeat(81), newId: counter() })).toThrowError(/1–80/)
    expect(() => prepareRestore({ inspected: ins, ...base, targetWorkspaceId: 'personal', newId: counter() })).toThrowError(/个人空间或演示空间/)
    expect(() => prepareRestore({ inspected: ins, ...base, targetWorkspaceId: 'demo', newId: counter() })).toThrowError(/个人空间或演示空间/)
    const ok = prepareRestore({ inspected: ins, ...base, targetName: '  我的恢复  ', newId: counter() })
    expect(ok.targetName).toBe('我的恢复')
  })

  it('未通过校验的 inspected 不能准备 → NOT_VALIDATED', async () => {
    expect(() => prepareRestore({ inspected: { ok: false }, ...base, newId: counter() })).toThrowError(/未通过校验/)
  })
})

describe('4-2 R1b v0 未结束会话兼容', () => {
  it('v0 未结束（缺引用状态）→ 仅暂停，不补 v1 字段，走 legacyEnd', async () => {
    const { sources, docs, assets } = fictionalRecords()
    // 去掉 v1 暂停会话，替换为唯一一份 v0 未结束会话（引用活对象，无 v1 字段）。
    const withoutPaused = docs.filter((d) => d.id !== 'focus-paused')
    const v0Unfinished = {
      id: 'focus-v0-open', workspace_id: WS.id, kind: 'focus_session', task_id: 'task-1', action_id: 'action-1',
      plan_item_id: null, started_at: '2026-11-19T08:00:00+08:00', accumulated_ms: 120000, running: true,
      draft_md: '旧草稿', outcome: null, blocker: null, ended_at: null, is_demo: false, record_version: 0,
    }
    const archive = await assembleArchive({ sources, docs: [...withoutPaused, v0Unfinished], assets })
    const ins = await inspectBackupFile(fileOf(packArchive(archive.entries)))
    expect(ins.ok).toBe(true)
    const prep = prepareRestore({ inspected: ins, targetWorkspaceId: 'ws-r', targetName: '恢复', operationId: 'op-v0', nowMs: 1_800_000_000_000, newId: counter() })
    const open = prep.docs.find((d) => d.id === prep.liveMap.get('focus-v0-open'))
    expect(open.running).toBe(false)
    expect(open.ended_at).toBeNull()
    expect(open.timer_anchor_at).toBeUndefined()
    expect(open.task_snapshot).toBeUndefined()
    expect(prep.legacyEnds).toContain(open.id)
    expect(prep.unfinishedV1).not.toContain(open.id)
    // v0 未结束不建 session 协调记录（仍走显式 legacyEnd）
    expect(prep.runtimePuts.some((r) => r.id === sessId(open.id))).toBe(false)
  })
})