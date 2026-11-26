import { describe, it, expect } from 'vitest'
import { buildRemap } from '@/services/backup/remap'
import { validateRecords } from '@/services/backup/validate'
import { buildCompleteBackup, rebuild, findDoc } from './backupFixtures'

const counter = () => { let n = 0; return () => `new-${++n}` }
const TARGET = 'ws-restore-1'

async function remapComplete(extraMutate) {
  const archive = extraMutate ? await rebuild(extraMutate) : await buildCompleteBackup()
  const r = buildRemap({
    manifest: archive.manifest, sources: archive.sources, docs: archive.docs,
    targetWorkspaceId: TARGET, targetName: '恢复 · 虚构来源空间', createdAt: '2026-11-22T16:00:00+08:00',
    newId: counter(),
  })
  return { archive, r }
}
const byId = (docs, id) => docs.find((d) => d.id === id)

describe('ID 重建与引用重写', () => {
  it('活对象全部换新 ID、workspace_id→目标、is_demo=false', async () => {
    const { archive, r } = await remapComplete()
    for (const s of r.sources) { expect(s.id).not.toBe(archive.sources.find((x) => x.asset_path === s.asset_path)?.id); expect(s.workspace_id).toBe(TARGET); expect(s.is_demo).toBe(false) }
    for (const d of r.docs) { expect(d.workspace_id).toBe(TARGET); expect(d.id).toMatch(/^new-/) }
    expect(r.targetWorkspace).toMatchObject({ id: TARGET, is_demo: false })
    // 旧 ID 不再作为任何活对象 id 出现
    const oldIds = new Set([...archive.sources, ...archive.docs].map((x) => x.id))
    for (const x of [...r.sources, ...r.docs]) expect(oldIds.has(x.id)).toBe(false)
  })

  it('顶层与嵌套引用按类型一致重写', async () => {
    const { r } = await remapComplete()
    const L = r.liveMap
    const note = byId(r.docs, L.get('note-1'))
    const task = byId(r.docs, L.get('task-1'))
    const ended = byId(r.docs, L.get('focus-ended'))
    const plan = byId(r.docs, L.get('plan-1'))
    expect(note.source_id).toBe(L.get('src-img'))
    expect(note.matter_id).toBe(L.get('matter-1'))
    expect(note.fields[0].quote.source_id).toBe(L.get('src-img')) // 嵌套 Quote
    expect(task.note_ids).toEqual([L.get('note-1')])
    expect(task.deadline.from_note_id).toBe(L.get('note-1'))
    expect(task.note_ids).toContain(task.deadline.from_note_id)
    expect(task.current_action_id).toBe(L.get('action-1'))
    expect(ended.action_id).toBe(L.get('action-1'))
    expect(ended.plan_item_id).toBe(L.get('plan-1'))
    expect(plan.focus_session_id).toBe(L.get('focus-ended'))
    expect(plan.task_id).toBe(L.get('task-1'))
  })

  it('deleted 历史 ID 隔离映射、跨记录一致、不与活 ID 冲突', async () => {
    const { r } = await remapComplete()
    const deleted = byId(r.docs, r.liveMap.get('focus-deleted'))
    expect(deleted.task_id).toBe(r.historyMap.get('task-gone'))
    expect(deleted.action_id).toBe(r.historyMap.get('action-gone'))
    const liveIds = new Set([...r.liveMap.values()])
    for (const h of r.historyMap.values()) expect(liveIds.has(h)).toBe(false)
    expect(deleted.task_ref_state).toBe('deleted')
  })

  it('绝不整段字符串替换：草稿/标题/quote 原文里的旧 ID 字样保留', async () => {
    const { r } = await remapComplete(({ docs }) => {
      findDoc(docs, 'focus-paused').draft_md = '见 note-1 / task-1 / src-img'
      findDoc(docs, 'note-1').fields[0].quote.text = '原文含 src-img 字样'
      findDoc(docs, 'task-1').title = '任务 note-1'
    })
    const paused = byId(r.docs, r.liveMap.get('focus-paused'))
    const note = byId(r.docs, r.liveMap.get('note-1'))
    const task = byId(r.docs, r.liveMap.get('task-1'))
    expect(paused.draft_md).toBe('见 note-1 / task-1 / src-img')
    expect(note.fields[0].quote.text).toBe('原文含 src-img 字样')
    expect(note.fields[0].quote.source_id).toBe(r.liveMap.get('src-img')) // 引用仍重写
    expect(task.title).toBe('任务 note-1')
  })

  it('asset_path 豁免重写；快照/时间/累计原值保留', async () => {
    const { archive, r } = await remapComplete()
    const img = r.sources.find((s) => s.kind === 'image')
    expect(img.asset_path).toBe('assets/src-img.png')
    const ended = byId(r.docs, r.liveMap.get('focus-ended'))
    const orig = findDoc(archive.docs, 'focus-ended')
    expect(ended.started_at).toBe(orig.started_at)
    expect(ended.accumulated_ms).toBe(orig.accumulated_ms)
    expect(ended.task_snapshot).toEqual(orig.task_snapshot)
    expect(ended.outcome).toBe(orig.outcome)
  })

  it('映射后重跑 B+C 结构/关系校验通过', async () => {
    const { archive, r } = await remapComplete()
    const res = validateRecords(r.remappedManifest, r.sources, r.docs, archive.assets)
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.summary.unfinishedCount).toBe(1)
  })

  it('v0 缺失引用也隔离映射，不伪造对象，重校验通过（带预览说明）', async () => {
    const { archive, r } = await remapComplete(({ docs }) => {
      const s = findDoc(docs, 'focus-v0'); s.task_id = 'task-missing'; s.action_id = 'action-missing'
    })
    const v0 = byId(r.docs, r.liveMap.get('focus-v0'))
    expect(v0.task_id).toBe(r.historyMap.get('task-missing'))
    expect(v0.action_id).toBe(r.historyMap.get('action-missing'))
    const res = validateRecords(r.remappedManifest, r.sources, r.docs, archive.assets)
    expect(res.ok).toBe(true)
    expect(res.notes.some((n) => /v0 旧会话/.test(n.message))).toBe(true)
  })
})