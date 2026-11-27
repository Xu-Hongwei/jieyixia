// 4-0 人工复审两项 P2 整改的兼容反例与往返补验（虚构夹具，独立 oracle）。
// F1：缺省 record_version 按 v0 解释（语义/关系/恢复同一口径），显式 v1 缺快照仍拒。
// F2：matter 本地 updated_at 适配（投影去除、往返保留、非法时间仍拒），不放开 additionalProperties。
// 记录级 validateRecords 与重新组装哈希后的完整归档 validateBackup 两条入口均验证。
import { describe, it, expect } from 'vitest'
import { validateBackup, validateRecords } from '@/services/backup/validate'
import { buildRemap } from '@/services/backup/remap'
import { buildRecoveryPlan } from '@/services/backup/recovery'
import {
  focusRecordVersion, businessCoreOfDoc, docToBackup, docFromBackup, LOCAL_ONLY_DOC_FIELDS,
} from '@/services/backup/adapt'
import { buildCompleteBackup, rebuild, findDoc, WS } from './backupFixtures'

const counter = () => { let n = 0; return () => `new-${++n}` }
const TARGET = 'ws-restore-1'
const NOW_MS = Date.parse('2026-11-22T16:00:00+08:00')
const msgs = (r) => r.errors.map((e) => e.message).join(' | ')
const byId = (docs, id) => docs.find((d) => d.id === id)

// 记录级入口：直接取夹具记录（不经 A 层字节），与完整归档入口互为独立 oracle。
async function bothEntries(mutate) {
  const archive = mutate ? await rebuild(mutate) : await buildCompleteBackup()
  const recordLevel = validateRecords(archive.manifest, archive.sources, archive.docs, archive.assets)
  const fullArchive = await validateBackup(archive)
  return { archive, recordLevel, fullArchive }
}
async function remapOf(mutate) {
  const archive = mutate ? await rebuild(mutate) : await buildCompleteBackup()
  const r = buildRemap({
    manifest: archive.manifest, sources: archive.sources, docs: archive.docs,
    targetWorkspaceId: TARGET, targetName: '恢复空间', createdAt: '2026-11-22T16:00:00+08:00', newId: counter(),
  })
  return { archive, r }
}

describe('F1 · 缺省 record_version 按 v0 解释', () => {
  it('focusRecordVersion 与领域 recordVersion 同口径：仅 ===1 为 v1', () => {
    expect(focusRecordVersion({})).toBe(0)
    expect(focusRecordVersion({ record_version: 0 })).toBe(0)
    expect(focusRecordVersion({ record_version: 1 })).toBe(1)
    expect(focusRecordVersion({ record_version: undefined })).toBe(0)
  })

  it('已结束旧会话删除 record_version → 记录级与完整归档均通过，不补造快照', async () => {
    const { archive, recordLevel, fullArchive } = await bothEntries(({ docs }) => {
      delete findDoc(docs, 'focus-v0').record_version
    })
    expect(recordLevel.ok).toBe(true)
    expect(fullArchive.ok).toBe(true)
    expect(fullArchive.errors).toEqual([])
    const v0 = findDoc(archive.docs, 'focus-v0')
    expect(v0.task_snapshot).toBeUndefined() // 未为过校验补造历史快照
    expect(v0.task_ref_state).toBeUndefined()
    expect(v0.record_version).toBeUndefined() // 原历史事实保留缺省表示
  })

  it('未结束旧会话删除 record_version → 通过，恢复准备按 v0（legacyEnd，不建 v1 协调记录）', async () => {
    const mutate = ({ docs }) => {
      const p = findDoc(docs, 'focus-paused'); p.ended_at = '2026-11-22T09:30:00+08:00'; p.outcome = 'done'; p.running = false; p.timer_anchor_at = null
      const v0 = findDoc(docs, 'focus-v0'); delete v0.record_version; v0.ended_at = null; v0.outcome = null; v0.running = false
    }
    const { recordLevel, fullArchive } = await bothEntries(mutate)
    expect(recordLevel.ok).toBe(true)
    expect(fullArchive.ok).toBe(true)
    expect(fullArchive.summary.unfinishedCount).toBe(1)
    const { r } = await remapOf(mutate)
    const plan = buildRecoveryPlan({ docs: r.docs, workspaceId: TARGET, nowMs: NOW_MS })
    const id = r.liveMap.get('focus-v0')
    expect(plan.legacyEnds).toEqual([id])
    expect(plan.unfinishedV1).toEqual([])
    expect(plan.runtimePuts.some((rt) => rt.id === `sess:${id}`)).toBe(false)
    const s = byId(plan.docs, id)
    expect(s.running).toBe(false)
    expect(s.task_snapshot).toBeUndefined()
    expect(s.timer_anchor_at).toBeUndefined()
    expect(s.task_ref_state).toBeUndefined()
  })

  it('缺省版本 + 缺失引用 → 走 v0 预览说明与隔离映射，两入口通过，映射后重校验通过', async () => {
    const mutate = ({ docs }) => {
      const s = findDoc(docs, 'focus-v0'); delete s.record_version; s.task_id = 'task-missing'; s.action_id = 'action-missing'
    }
    const { recordLevel, fullArchive } = await bothEntries(mutate)
    expect(recordLevel.ok).toBe(true)
    expect(fullArchive.ok).toBe(true)
    expect(fullArchive.notes.some((n) => /v0 旧会话/.test(n.message))).toBe(true)
    const { archive, r } = await remapOf(mutate)
    const v0 = byId(r.docs, r.liveMap.get('focus-v0'))
    expect(v0.task_id).toBe(r.historyMap.get('task-missing'))
    expect(v0.action_id).toBe(r.historyMap.get('action-missing'))
    const res = validateRecords(r.remappedManifest, r.sources, r.docs, archive.assets)
    expect(res.ok).toBe(true)
    expect(res.notes.some((n) => /v0 旧会话/.test(n.message))).toBe(true)
  })

  it('显式 v1 缺快照仍必须拒绝（未把 v1 放宽）', async () => {
    const { recordLevel, fullArchive } = await bothEntries(({ docs }) => {
      const s = findDoc(docs, 'focus-ended'); s.task_snapshot = null
    })
    expect(recordLevel.ok).toBe(false)
    expect(fullArchive.ok).toBe(false)
    expect(msgs(fullArchive)).toMatch(/v1 会话开始即必须有任务与行动快照/)
  })

  it('缺省版本但携带 v1 字段仍按 v0 混版拒绝（缺省不是无条件放行）', async () => {
    const { fullArchive } = await bothEntries(({ docs }) => {
      const s = findDoc(docs, 'focus-v0'); delete s.record_version; s.task_ref_state = 'active'
    })
    expect(fullArchive.ok).toBe(false)
    expect(msgs(fullArchive)).toMatch(/不得携带 v1 字段/)
  })
})

describe('F2 · matter 本地 updated_at 适配', () => {
  it('LOCAL_ONLY_DOC_FIELDS.matter 含 updated_at；投影去除、备份往返保留', () => {
    expect(LOCAL_ONLY_DOC_FIELDS.matter).toContain('updated_at')
    const matter = { id: 'm1', kind: 'matter', workspace_id: WS.id, title: '改名后事项', note_ids: ['note-1'], created_at: '2026-11-20T09:15:00+08:00', updated_at: '2026-11-22T10:00:00+08:00', is_demo: false }
    const core = businessCoreOfDoc(matter)
    expect(core.updated_at).toBeUndefined() // 业务核心投影掉本地更新时间
    expect(core.title).toBe('改名后事项')
    const back = docFromBackup(docToBackup(matter))
    expect(back).toEqual(matter) // 名称/归组/更新时间无损往返
    expect(back.updated_at).toBe('2026-11-22T10:00:00+08:00')
  })

  it('改名 + 合法 updated_at → 记录级与完整归档均通过（不再报未知字段）', async () => {
    const { recordLevel, fullArchive } = await bothEntries(({ docs }) => {
      const m = findDoc(docs, 'matter-1'); m.title = '实验报告（修订）'; m.updated_at = '2026-11-22T10:00:00+08:00'
    })
    expect(recordLevel.ok).toBe(true)
    expect(fullArchive.ok).toBe(true)
    expect(msgs(fullArchive)).not.toMatch(/未知字段 updated_at/)
  })

  it('createMatter 原样（无 updated_at）仍通过，不因缺字段报错', async () => {
    const { archive, fullArchive } = await bothEntries()
    expect(fullArchive.ok).toBe(true)
    expect(findDoc(archive.docs, 'matter-1').updated_at).toBeUndefined()
  })

  it('改名/归组样本走导出适配 + ID 映射后再校验 + 往返，名称/归组/更新时间不丢', async () => {
    const mutate = ({ docs }) => {
      const m = findDoc(docs, 'matter-1'); m.title = '实验报告（修订）'; m.updated_at = '2026-11-22T10:00:00+08:00'
    }
    const { archive, r } = await remapOf(mutate)
    const res = validateRecords(r.remappedManifest, r.sources, r.docs, archive.assets)
    expect(res.ok).toBe(true)
    const m = byId(r.docs, r.liveMap.get('matter-1'))
    expect(m.title).toBe('实验报告（修订）')
    expect(m.updated_at).toBe('2026-11-22T10:00:00+08:00') // 本地更新时间保留
    expect(m.note_ids).toEqual([r.liveMap.get('note-1')]) // 归组引用重写为新 note id
    expect(m.workspace_id).toBe(TARGET)
    const back = docFromBackup(docToBackup(m))
    expect(back.updated_at).toBe(m.updated_at)
    expect(back.title).toBe(m.title)
  })

  it('非法 updated_at（非时间字符串）仍拒', async () => {
    const { fullArchive } = await bothEntries(({ docs }) => {
      findDoc(docs, 'matter-1').updated_at = 'not-a-time'
    })
    expect(fullArchive.ok).toBe(false)
    expect(msgs(fullArchive)).toMatch(/事项本地 updated_at 必须是真实 ISO 日期时间/)
  })

  it('非法时区偏移 +08:75 的 updated_at 仍拒', async () => {
    const { fullArchive } = await bothEntries(({ docs }) => {
      findDoc(docs, 'matter-1').updated_at = '2026-11-22T10:00:00+08:75'
    })
    expect(fullArchive.ok).toBe(false)
    expect(msgs(fullArchive)).toMatch(/事项本地 updated_at 必须是真实/)
  })

  it('未放开 additionalProperties：matter 真正未知字段仍拒', async () => {
    const { fullArchive } = await bothEntries(({ docs }) => {
      findDoc(docs, 'matter-1').foo = 'bar'
    })
    expect(fullArchive.ok).toBe(false)
    expect(msgs(fullArchive)).toMatch(/未知字段 foo/)
  })
})