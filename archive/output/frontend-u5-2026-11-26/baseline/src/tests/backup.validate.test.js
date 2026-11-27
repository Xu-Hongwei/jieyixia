import { describe, it, expect } from 'vitest'
import { validateBackup } from '@/services/backup/validate'
import { buildCompleteBackup, rebuild, findDoc, WS } from './backupFixtures'
import { MANIFEST_PATH } from '@/services/backup/format'

const decode = (b) => new TextDecoder().decode(b)
const encode = (s) => new TextEncoder().encode(s)

// 替换 manifest 条目（manifest 不自哈希，改它不触发 A 层哈希错误）。
function withManifest(archive, mutate) {
  const entry = archive.entries.find((e) => e.path === MANIFEST_PATH)
  const m = JSON.parse(decode(entry.bytes))
  mutate(m)
  const bytes = encode(JSON.stringify(m))
  return { ...archive, entries: archive.entries.map((e) => (e.path === MANIFEST_PATH ? { path: e.path, bytes } : e)) }
}
const msgs = (r) => r.errors.map((e) => e.message).join(' | ')

describe('备份三层校验 · 正向', () => {
  it('完整虚构空间通过 A/B/C，计数与未结束会话正确', async () => {
    const r = await validateBackup(await buildCompleteBackup())
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.summary.counts).toMatchObject({ note: 1, matter: 1, task: 1, action: 2, focus_session: 4, plan_item: 1 })
    expect(r.summary.sourceCount).toBe(2)
    expect(r.summary.imageCount).toBe(1)
    expect(r.summary.unfinishedCount).toBe(1)
    expect(r.summary.unfinishedIds).toEqual(['focus-paused'])
  })

  it('v0 旧会话缺失引用走预览说明而非硬拒（不伪造对象）', async () => {
    const archive = await rebuild(({ docs }) => {
      const s = findDoc(docs, 'focus-v0'); s.task_id = 'task-missing'; s.action_id = 'action-missing'
    })
    const r = await validateBackup(archive)
    expect(r.ok).toBe(true)
    expect(r.notes.some((n) => /v0 旧会话/.test(n.message))).toBe(true)
  })
})

describe('备份三层校验 · A 归档完整性', () => {
  it('资产字节被改 → SHA-256 与声明不符', async () => {
    const a = await buildCompleteBackup()
    const entries = a.entries.map((e) => e.path === 'assets/src-img.png' ? { path: e.path, bytes: Uint8Array.from([...e.bytes, 0]) } : e)
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(msgs(r)).toMatch(/SHA-256 与声明不符/)
  })
  it('缺少必需文件 docs.json', async () => {
    const a = await buildCompleteBackup()
    const r = await validateBackup({ entries: a.entries.filter((e) => e.path !== 'data/docs.json') })
    expect(msgs(r)).toMatch(/缺少必需文件：data\/docs.json/)
  })
  it('未声明载荷被拒', async () => {
    const a = await buildCompleteBackup()
    const r = await validateBackup({ entries: [...a.entries, { path: 'data/extra.json', bytes: encode('[]') }] })
    expect(msgs(r)).toMatch(/未声明载荷/)
  })
  it('非法路径（..）被拒', async () => {
    const a = await buildCompleteBackup()
    const r = await validateBackup({ entries: [...a.entries, { path: 'assets/../evil.png', bytes: encode('x') }] })
    expect(msgs(r)).toMatch(/非法归档路径/)
  })
  it('不支持的 backup_format_version 被拒', async () => {
    const a = withManifest(await buildCompleteBackup(), (m) => { m.backup_format_version = 2 })
    const r = await validateBackup(a)
    expect(r.ok).toBe(false)
    expect(msgs(r)).toMatch(/不支持的版本组合 backup_format_version=2 \/ schema_version=0\.4\.0/)
  })
  it('不支持的 schema_version 被拒', async () => {
    const a = withManifest(await buildCompleteBackup(), (m) => { m.schema_version = '0.5.0' })
    const r = await validateBackup(a)
    expect(r.ok).toBe(false)
    expect(msgs(r)).toMatch(/不支持的版本组合 backup_format_version=1 \/ schema_version=0\.5\.0/)
  })
  it('SVG 冒充图片被拒（非栅格）', async () => {
    const a = await buildCompleteBackup()
    const svg = encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const entries = a.entries.map((e) => e.path === 'assets/src-img.png' ? { path: e.path, bytes: svg } : e)
    const r = await validateBackup({ entries })
    expect(r.ok).toBe(false)
    expect(msgs(r)).toMatch(/SHA-256|不是支持的栅格/)
  })
})

describe('备份三层校验 · B 结构/语义', () => {
  it('Action.minutes 非正被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'action-1').minutes = -5 }))
    expect(msgs(r)).toMatch(/minutes 必须为正/)
  })
  it('reviewed 便签缺 reviewed_at 被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'note-1').reviewed_at = null }))
    expect(msgs(r)).toMatch(/reviewed 便签必须有 reviewed_at/)
  })
  it('非法日历 captured_at 被拒', async () => {
    const r = await validateBackup(await rebuild(({ sources }) => { sources[0].captured_at = '2026-02-30T09:00:00+08:00' }))
    expect(msgs(r)).toMatch(/captured_at 必须是真实/)
  })
  it('非法时区偏移 +08:75 被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'focus-ended').started_at = '2026-11-21T10:00:00+08:75' }))
    expect(msgs(r)).toMatch(/started_at 必须是真实/)
  })
  it('v1 运行中缺计时锚点被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { const s = findDoc(docs, 'focus-paused'); s.running = true; s.timer_anchor_at = null }))
    expect(msgs(r)).toMatch(/运行中会话必须有计时锚点/)
  })
  it('v0 旧记录携带 v1 字段被拒（混版）', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'focus-v0').task_ref_state = 'active' }))
    expect(msgs(r)).toMatch(/不得携带 v1 字段/)
  })
  it('未适配 kind（group）显式阻断', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { docs.push({ id: 'group-1', workspace_id: WS.id, kind: 'group', title: '旧组', note_ids: [], created_at: '2026-11-20T09:00:00+08:00' }) }))
    expect(msgs(r)).toMatch(/未适配的记录类型 group/)
  })
  it('同 ID 不同对象被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'action-2').id = 'note-1' }))
    expect(msgs(r)).toMatch(/ID 重复/)
  })
  it('记录不属于单一来源空间被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'note-1').workspace_id = 'ws-other' }))
    expect(msgs(r)).toMatch(/不属于 manifest 声明的单一来源空间/)
  })
  it('走私运行时持有者字段被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'task-1').owner_id = 'page-1' }))
    expect(msgs(r)).toMatch(/运行时\/凭据字段 owner_id|未知字段 owner_id/)
  })
  it('计数与 manifest 不符被拒', async () => {
    const a = withManifest(await buildCompleteBackup(), (m) => { m.counts.note = 5 })
    expect(msgs(await validateBackup(a))).toMatch(/counts.note 与 manifest 不符/)
  })
})

describe('备份三层校验 · C 关系闭包', () => {
  it('便签资料引用缺失被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'note-1').source_id = 'src-nope' }))
    expect(msgs(r)).toMatch(/便签资料 引用不存在的对象/)
  })
  it('嵌套 Quote.source_id 缺失被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'note-1').fields[0].quote.source_id = 'src-nope' }))
    expect(msgs(r)).toMatch(/字段原文资料 引用不存在的对象/)
  })
  it('deleted 历史指向活对象被拒（假删除）', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'focus-deleted').task_id = 'task-1' }))
    expect(msgs(r)).toMatch(/假删除历史/)
  })
  it('当前行动归属不符被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'task-1').current_action_id = 'action-2'; findDoc(docs, 'action-2').task_id = 'task-other' }))
    expect(r.ok).toBe(false)
  })
  it('计划快捷引用指向未结束会话被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { findDoc(docs, 'plan-1').focus_session_id = 'focus-paused' }))
    expect(r.ok).toBe(false)
    expect(msgs(r)).toMatch(/只能指向已结束会话|归属不符/)
  })
  it('同空间多份未结束会话被拒', async () => {
    const r = await validateBackup(await rebuild(({ docs }) => { const s = findDoc(docs, 'focus-v0'); s.ended_at = null; s.outcome = null }))
    expect(msgs(r)).toMatch(/2 份未结束会话/)
  })
})