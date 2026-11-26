// 3B-2 视图助手：时长先求和再格式化、历史倒序稳定、北京日期边界筛选、快照搜索不伪造现名、资料去重归属。
import { describe, expect, it } from 'vitest'
import { endedSessionsSorted, filterWorkRecords, formatDurationMs, sessionActionText, sessionTitle, taskMaterials } from '@/domains/work'

describe('formatDurationMs', () => {
  it('mm:ss 与 h:mm:ss；先求和再格式化不按段取整', () => {
    expect(formatDurationMs(0)).toBe('00:00')
    expect(formatDurationMs(65_000)).toBe('01:05')
    expect(formatDurationMs(3_600_000 + 61_000)).toBe('1:01:01')
    // 两段各 59.6s：逐段取整会得 02:00，先求和应为 01:59
    expect(formatDurationMs(59_600 + 59_600)).toBe('01:59')
  })
  it('负数/非法输入钳为 0，不显示负投入', () => {
    expect(formatDurationMs(-5000)).toBe('00:00')
    expect(formatDurationMs(null)).toBe('00:00')
    expect(formatDurationMs('abc')).toBe('00:00')
  })
})

const ended = (id, endedAt, extra = {}) => ({
  id, kind: 'focus_session', ended_at: endedAt, started_at: endedAt, accumulated_ms: 60_000,
  outcome: 'partial', record_version: 1,
  task_snapshot: { title: `任务${id}` }, action_snapshot: { text: `行动${id}`, minutes: 25 },
  ...extra,
})

describe('endedSessionsSorted', () => {
  it('只取已结束，按 ended_at 倒序；同时间按 id 稳定', () => {
    const list = [
      ended('b', '2026-11-20T10:00:00+08:00'),
      { id: 'open', kind: 'focus_session', ended_at: null },
      ended('a', '2026-11-21T09:00:00+08:00'),
      ended('c', '2026-11-20T10:00:00+08:00'),
    ]
    expect(endedSessionsSorted(list).map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(endedSessionsSorted(list).map((s) => s.id)).toEqual(endedSessionsSorted(list.slice().reverse()).map((s) => s.id))
  })
})

describe('filterWorkRecords', () => {
  const list = [
    // UTC 16:30 = 北京 11-21 00:30：按北京日期归入 21 日而非 20 日
    ended('x', '2026-11-20T16:30:00Z'),
    ended('y', '2026-11-21T15:59:00+08:00'),
    ended('z', '2026-11-22T00:00:00+08:00'),
  ]
  it('日期范围按结束时刻的北京日期判定，含边界', () => {
    expect(filterWorkRecords(list, { from: '2026-11-21', to: '2026-11-21' }).map((s) => s.id)).toEqual(['x', 'y'])
    expect(filterWorkRecords(list, { from: '2026-11-22' }).map((s) => s.id)).toEqual(['z'])
    expect(filterWorkRecords(list, { to: '2026-11-20' })).toEqual([])
    expect(filterWorkRecords(list, {})).toHaveLength(3)
  })
  it('搜索匹配任务/行动快照标题，大小写不敏感；无快照不匹配现名称', () => {
    const withV0 = [...list, { id: 'v0', kind: 'focus_session', ended_at: '2026-11-21T10:00:00+08:00', record_version: 0 }]
    expect(filterWorkRecords(withV0, { query: '任务X' }).map((s) => s.id)).toEqual(['x'])
    expect(filterWorkRecords(withV0, { query: '行动y' }).map((s) => s.id)).toEqual(['y'])
    expect(filterWorkRecords(withV0, { query: 'v0' })).toEqual([])
  })
})

describe('taskMaterials', () => {
  const notes = [
    { id: 'n1', workspace_id: 'personal' },
    { id: 'n2', workspace_id: 'personal' },
    { id: 'n3', workspace_id: 'personal' },
  ]
  const matters = [{ id: 'm1', note_ids: ['n2', 'n3', 'n4'] }]
  it('直接关联 = note_ids ∪ 截止出处，按 ID 去重；事项补充排除直接项', () => {
    const task = { id: 't1', note_ids: ['n1', 'n2', 'n1'], deadline: { value: '2026-11-25', from_note_id: 'n2' }, matter_id: 'm1' }
    const { direct, extra } = taskMaterials(task, notes, matters)
    expect(direct.map((d) => d.id)).toEqual(['n1', 'n2'])
    expect(extra.map((d) => d.id)).toEqual(['n3', 'n4'])
  })
  it('缺失引用保留 id 且 note 为 null；无任务返回空', () => {
    const { direct, extra } = taskMaterials({ id: 't', note_ids: ['gone'], matter_id: 'm1' }, notes, matters)
    expect(direct).toEqual([{ id: 'gone', note: null }])
    expect(extra.find((d) => d.id === 'n4').note).toBeNull()
    expect(taskMaterials(null, notes, matters)).toEqual({ direct: [], extra: [] })
  })
})

describe('快照展示', () => {
  it('v0 无快照返回 null，由界面标注旧记录', () => {
    expect(sessionTitle({ record_version: 0 })).toBeNull()
    expect(sessionActionText({ record_version: 0 })).toBeNull()
    expect(sessionTitle(ended('a', '2026-11-21T10:00:00+08:00'))).toBe('任务a')
  })
})