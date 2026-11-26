// 2026-11-19 前端阶段 2 人工审查的 4 个业务复现，整改后并入正式回归。
// 原始复现证据：devlog/coordination/evidence/stage2-review/review-stage2.test.js
// 期望值按 contract/DECISIONS-2026-11-18.md（联删决定、P01/P06）与审查整改要求书写。
import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '../stores/app'
import { allDocs, putDoc } from '../services/storage/db'
import { noteBucket, rowMatches, sourceRow } from '../domains/organize'

it('审查1：reviewed 不应掩盖 unresolved 的关键截止', () => {
  expect(noteBucket({ status: 'reviewed', fields: [{ key: 'deadline', status: 'unresolved', value: null }] })).toBe('pending')
})

it('审查2：确认删除应同步删除截止引用任务（联删决定替代旧的阻止删除规则）', async () => {
  setActivePinia(createPinia())
  const s = useAppStore()
  await s.init()
  await putDoc({ id: 'review-n1', kind: 'note', title: 'N', status: 'draft', fields: [] })
  await putDoc({ id: 'review-t1', kind: 'task', title: 'T', status: 'todo', note_ids: ['review-n1'], deadline: { value: '2026-11-20', precision: 'date', source: 'note', from_note_id: 'review-n1', confirmed_at: '2026-11-19T09:00:00+08:00' } })
  await s.reload()
  expect((await s.deleteNote(s.notes.find((n) => n.id === 'review-n1'))).ok).toBe(true)
  expect((await allDocs()).records.some((d) => d.id === 'review-t1')).toBe(false)
})

it('审查3：撤销删除不应覆盖删除之后用户已保存的任务修改', async () => {
  setActivePinia(createPinia())
  const s = useAppStore()
  await s.init()
  await putDoc({ id: 'review-n2', kind: 'note', title: 'N', status: 'draft', fields: [] })
  await putDoc({ id: 'review-n2b', kind: 'note', title: 'N2', status: 'draft', fields: [] })
  await putDoc({ id: 'review-t2', kind: 'task', title: '旧标题', status: 'todo', note_ids: ['review-n2b'], deadline: { value: null, precision: 'none' } })
  await s.reload()
  await s.deleteNote(s.notes.find((n) => n.id === 'review-n2'))
  await s.renameTask(s.tasks.find((t) => t.id === 'review-t2'), '用户新标题')
  expect((await s.undoDelete()).ok).toBe(true)
  expect((await allDocs()).records.find((d) => d.id === 'review-t2').title).toBe('用户新标题')
})

it('审查3b：待恢复记录已有新版本时撤销被明确拒绝，新版本原样保留', async () => {
  setActivePinia(createPinia())
  const s = useAppStore()
  await s.init()
  await putDoc({ id: 'review-t3', kind: 'task', title: '删除前', status: 'todo', note_ids: [], deadline: { value: null, precision: 'none' } })
  await s.reload()
  await s.deleteTask(s.tasks.find((t) => t.id === 'review-t3'))
  await putDoc({ id: 'review-t3', kind: 'task', title: '用户新版本', status: 'todo', note_ids: [], deadline: { value: null, precision: 'none' } })
  await s.reload()
  const r = await s.undoDelete()
  expect(r.ok).toBe(false)
  expect((await allDocs()).records.find((d) => d.id === 'review-t3').title).toBe('用户新版本')
})

it('审查4：本地搜索应该命中已提取字段原文', () => {
  expect(rowMatches(sourceRow({ id: 's', kind: 'image', name: '通知.png' }, { title: '课程通知', status: 'draft', fields: [{ key: 'requirement', raw: '必须提交纸质签字材料', value: '材料', status: 'candidate' }] }), '纸质签字', 'all', 'all')).toBe(true)
})