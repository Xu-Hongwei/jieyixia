import { describe, expect, it } from 'vitest'
import { eventPreview, pendingGroups, resolveEventPlan } from '../domains/pendingDate'

const now = '2026-11-27T12:00:00+08:00'
const date = '2026-12-08'
function member(id, days, deadline = false, group = 'draft-1') {
  return [
    { kind: 'task', id, workspace_id: 'ws', matter_id: 'project', title: id, status: 'todo',
      pending_date: { event: '开题会', offset_days: days, sets_deadline: deadline }, pending_date_group: group },
    { kind: 'action', id: 'a-' + id, task_id: id, workspace_id: 'ws', done: false, text: id, minutes: 20 },
  ]
}

describe('补录活动日期', () => {
  it('同步相对日期和明确截止，隔离同名事件与仍需审批的工作', () => {
    const docs = [...member('系统申请', -3, true), ...member('会议', 0), ...member('终稿', 1),
      ...member('等审批后打印', null), ...member('另一份计划的会议', 0, false, 'draft-2')]
    const tasks = docs.filter(d => d.kind === 'task')
    const [group] = pendingGroups(tasks)
    const preview = eventPreview(docs, group.key, date)
    const { puts } = resolveEventPlan(docs, group.key, date, preview, now, () => crypto.randomUUID())
    expect(puts.filter(d => d.kind === 'plan_item').map(d => d.date)).toEqual(['2026-12-05', date, '2026-12-09'])
    expect(puts.find(d => d.id === '系统申请').deadline.value).toBe('2026-12-05')
    expect(puts.find(d => d.id === '会议').deadline).toBeUndefined()
    expect(puts.some(d => d.id === '另一份计划的会议')).toBe(false)
    const latest = [...docs.filter(d => !puts.some(p => p.id === d.id)), ...puts]
    expect(() => resolveEventPlan(latest, group.key, date, preview, now, () => 'x')).toThrow('已变化')
  })
  it('手动安排优先，预览后发生的修改须重新核对', () => {
    const docs = member('资料', -3, true)
    const [group] = pendingGroups([docs[0]])
    const before = eventPreview(docs, group.key, date)
    docs.push({ kind: 'plan_item', workspace_id: 'ws', id: 'manual', task_id: '资料', state: 'planned', date })
    expect(() => resolveEventPlan(docs, group.key, date, before, now, () => 'x')).toThrow('已变化')
    const latest = eventPreview(docs, group.key, date)
    expect(latest[0].note).toBe('保留已有安排')
    expect(resolveEventPlan(docs, group.key, date, latest, now, () => 'x').puts.map(d => d.kind)).toEqual(['task'])
  })
})
