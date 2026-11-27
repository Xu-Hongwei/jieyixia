import { describe, expect, it } from 'vitest'
import {
  BUCKET_ORDER, byCaptured, isSharedTask, linkedTasksOf, matterNotesOf, matterTasksOf, mattersOf,
  membersOf, noteBucket, partitionTasks, pendingFields, rowMatches, sourceRow, ungroupedOf,
} from '../domains/organize'

const note = (over = {}) => ({ id: 'n', kind: 'note', status: 'draft', fields: [], ...over })
const field = (status) => ({ key: 'deadline', value: '2026-11-20', status })

describe('noteBucket 三态分组', () => {
  it('failed 优先', () => {
    expect(noteBucket(note({ status: 'failed' }))).toBe('failed')
  })
  it('已审阅不替代字段确认：仍有 candidate 归待核对', () => {
    expect(noteBucket(note({ status: 'reviewed', fields: [field('candidate')] }))).toBe('pending')
  })
  it('已审阅但关键截止 unresolved/空值仍归待核对', () => {
    expect(noteBucket(note({ status: 'reviewed', fields: [{ key: 'deadline', value: null, status: 'unresolved' }] }))).toBe('pending')
    expect(pendingFields(note({ status: 'reviewed', fields: [field('unresolved')] })).length).toBe(1)
  })
  it('已审阅且全字段终态才归已确认', () => {
    expect(noteBucket(note({ status: 'reviewed', fields: [field('confirmed')] }))).toBe('confirmed')
  })
  it('全字段终态归已确认', () => {
    expect(noteBucket(note({ fields: [field('confirmed'), { key: 'x', status: 'missing' }] }))).toBe('confirmed')
  })
  it('仍有 candidate/unresolved 归待核对', () => {
    expect(noteBucket(note({ fields: [field('confirmed'), field('candidate')] }))).toBe('pending')
    expect(noteBucket(note({ fields: [field('unresolved')] }))).toBe('pending')
  })
  it('空字段非失败归待核对', () => {
    expect(noteBucket(note())).toBe('pending')
  })
  it('分组顺序固定', () => {
    expect(BUCKET_ORDER).toEqual(['pending', 'failed', 'confirmed'])
  })
})

describe('删除便签影响面（联删决定）', () => {
  const tasks = [
    { id: 't1', kind: 'task', title: 'note_ids 命中', note_ids: ['n1'], deadline: { value: null, precision: 'none' } },
    { id: 't2', kind: 'task', title: '截止出处命中', note_ids: [], deadline: { value: '2026-11-20', precision: 'date', source: 'note', from_note_id: 'n1' } },
    { id: 't3', kind: 'task', title: '两处都命中（去重）', note_ids: ['n1', 'n2'], deadline: { value: '2026-11-20', precision: 'date', source: 'note', from_note_id: 'n1' } },
    { id: 't4', kind: 'task', title: '无关', note_ids: ['n2'], deadline: { value: null, precision: 'none' } },
  ]
  it('note_ids ∪ from_note_id，按任务 ID 去重', () => {
    expect(linkedTasksOf(tasks, 'n1').map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(linkedTasksOf(tasks, 'n2').map((t) => t.id)).toEqual(['t3', 't4'])
    expect(linkedTasksOf(tasks, 'nx')).toEqual([])
  })
  it('多便签共享任务可识别（确认框需说明整体删除）', () => {
    expect(isSharedTask(tasks[2])).toBe(true)
    expect(isSharedTask(tasks[0])).toBe(false)
  })
})

describe('收集箱搜索 / 筛选', () => {
  const img = { id: 's1', kind: 'image', name: '课程作业截图.png', captured_at: '2026-11-18T09:00:00+08:00' }
  const txt = { id: 's2', kind: 'text', text: '明天交报告', captured_at: '2026-11-19T09:00:00+08:00' }
  it('关键词命中文件名 / 正文 / 便签标题', () => {
    expect(rowMatches(sourceRow(img, null), '课程', 'all', 'all')).toBe(true)
    expect(rowMatches(sourceRow(txt, null), '报告', 'all', 'all')).toBe(true)
    expect(rowMatches(sourceRow(img, note({ title: '机器学习' })), '机器学习', 'all', 'all')).toBe(true)
    expect(rowMatches(sourceRow(img, null), '不存在', 'all', 'all')).toBe(false)
  })
  it('P06：命中字段原文 raw / 引用 quote / 摘要 / 关键词 / 数组项 / 节点原文', () => {
    const n = note({
      title: '课程通知',
      fields: [
        { key: 'requirement', raw: '必须提交纸质签字材料', value: '材料', status: 'candidate' },
        { key: 'summary', value: '期末报告与答辩安排', status: 'candidate' },
        { key: 'keywords', value: ['答辩', '纸质'], status: 'candidate' },
        { key: 'constraints', value: '不得迟交', status: 'candidate', quote: { text: '逾期不予受理', source_id: 's1' } },
        { key: 'time_nodes', value: [{ label: '答辩开始', raw: '答辩于11月20日上午', value: '2026-11-20' }], status: 'candidate' },
      ],
    })
    for (const q of ['纸质签字', '期末报告', '答辩', '逾期不予受理', '不得迟交', '11月20日上午']) {
      expect(rowMatches(sourceRow(img, n), q, 'all', 'all')).toBe(true)
    }
    expect(rowMatches(sourceRow(img, n), '无关词', 'all', 'all')).toBe(false)
  })
  it('P06：命中所属事项名称', () => {
    expect(rowMatches(sourceRow(img, note({ title: '通知', matter_id: 'm1' }), '毕业设计'), '毕业设计', 'all', 'all')).toBe(true)
    expect(rowMatches(sourceRow(img, note({ title: '通知' })), '毕业设计', 'all', 'all')).toBe(false)
  })
  it('形态筛选（image/text）', () => {
    expect(rowMatches(sourceRow(img, null), '', 'image', 'all')).toBe(true)
    expect(rowMatches(sourceRow(img, null), '', 'text', 'all')).toBe(false)
  })
  it('内容类型筛选（notice/tutorial/reference）独立于形态', () => {
    const notice = note({ content_type: 'notice' })
    const ref = note({ content_type: 'reference' })
    expect(rowMatches(sourceRow(img, notice), '', 'all', 'all', { contentType: 'notice' })).toBe(true)
    expect(rowMatches(sourceRow(img, notice), '', 'image', 'all', { contentType: 'notice' })).toBe(true)
    expect(rowMatches(sourceRow(img, ref), '', 'all', 'all', { contentType: 'notice' })).toBe(false)
    expect(rowMatches(sourceRow(img, null), '', 'all', 'all', { contentType: 'notice' })).toBe(false)
  })
  it('收集日期范围按北京日界（含端点，可只填一端）', () => {
    const row = sourceRow(img, null) // 2026-11-18 北京
    expect(rowMatches(row, '', 'all', 'all', { from: '2026-11-18', to: '2026-11-18' })).toBe(true)
    expect(rowMatches(row, '', 'all', 'all', { from: '2026-11-19' })).toBe(false)
    expect(rowMatches(row, '', 'all', 'all', { to: '2026-11-17' })).toBe(false)
    expect(rowMatches(row, '', 'all', 'all', { to: '2026-11-18' })).toBe(true)
    // 明确偏移的 UTC 前一日晚间仍属北京 11-18
    const late = sourceRow({ id: 's3', kind: 'text', text: 'x', captured_at: '2026-11-17T23:30:00Z' }, null)
    expect(rowMatches(late, '', 'all', 'all', { from: '2026-11-18', to: '2026-11-18' })).toBe(true)
  })
  it('状态筛选：未分析 / 三态（已审阅不算已确认）', () => {
    expect(rowMatches(sourceRow(img, null), '', 'all', 'none')).toBe(true)
    expect(rowMatches(sourceRow(img, note({ status: 'failed' })), '', 'all', 'none')).toBe(false)
    expect(rowMatches(sourceRow(img, note({ status: 'failed' })), '', 'all', 'failed')).toBe(true)
    expect(rowMatches(sourceRow(img, note({ fields: [field('candidate')] })), '', 'all', 'pending')).toBe(true)
    expect(rowMatches(sourceRow(img, note({ status: 'reviewed', fields: [field('candidate')] })), '', 'all', 'pending')).toBe(true)
    expect(rowMatches(sourceRow(img, note({ status: 'reviewed', fields: [field('candidate')] })), '', 'all', 'confirmed')).toBe(false)
    expect(rowMatches(sourceRow(img, note({ status: 'reviewed', fields: [field('confirmed')] })), '', 'all', 'confirmed')).toBe(true)
  })
  it('按收集时刻排序（明确偏移可比）', () => {
    const rows = [sourceRow(img, null), sourceRow(txt, null)]
    expect(byCaptured(rows, 'desc')[0].source.id).toBe('s2')
    expect(byCaptured(rows, 'asc')[0].source.id).toBe('s1')
  })
})

describe('今天任务分区', () => {
  const nowD = new Date('2026-11-19T12:00:00+08:00')
  const task = (value, status = 'todo', precision = 'date') => ({ id: value, kind: 'task', status, deadline: value ? { value, precision } : null })
  it('逾期 / 今日 / 稍后 / 已完成 互斥', () => {
    const p = partitionTasks([task('2026-11-10'), task('2026-11-19'), task('2026-12-05'), task('2026-11-10', 'done'), task(null)], nowD)
    expect(p.overdue.map((t) => t.id)).toEqual(['2026-11-10'])
    expect(p.today.map((t) => t.id)).toEqual(['2026-11-19'])
    expect(p.upcoming.map((t) => t.id)).toEqual(['2026-12-05', null])
    expect(p.done.map((t) => t.id)).toEqual(['2026-11-10'])
  })
  it('datetime 今日按北京日界', () => {
    const p = partitionTasks([task('2026-11-19T23:30:00+08:00', 'todo', 'datetime')], nowD)
    expect(p.today.length).toBe(1)
  })
})

describe('事项目录 / 成员（契约 Matter）', () => {
  const docs = [
    { id: 'm1', kind: 'matter', title: '课程', note_ids: ['n1'] },
    { id: 't1', kind: 'task', matter_id: 'm1' },
    { id: 'n1', kind: 'note', matter_id: 'm1', matter_role: 'requirement' },
    { id: 't2', kind: 'task', matter_id: null },
  ]
  it('mattersOf / membersOf / ungroupedOf', () => {
    expect(mattersOf(docs).map((m) => m.id)).toEqual(['m1'])
    expect(membersOf(docs, 'm1').map((d) => d.id)).toEqual(['t1', 'n1'])
    expect(ungroupedOf(docs).map((d) => d.id)).toEqual(['t2'])
  })
  it('成员详情可分别取便签（含资料角色）与任务', () => {
    expect(matterNotesOf(docs, 'm1').map((n) => n.matter_role)).toEqual(['requirement'])
    expect(matterTasksOf(docs, 'm1').map((t) => t.id)).toEqual(['t1'])
    expect(matterNotesOf(docs, 'm1').length + matterTasksOf(docs, 'm1').length).toBe(membersOf(docs, 'm1').length)
  })
})