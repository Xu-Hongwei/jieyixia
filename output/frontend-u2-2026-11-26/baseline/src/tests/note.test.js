import { describe, expect, it } from 'vitest'
import { canConfirm, failedNote, manualTask, mergeReanalysis, taskFromNote } from '../domains/note'

const body = {
  source_id: 'src-1',
  content_type: 'notice',
  fields: [
    { key: 'title', value: '课程报告提交通知', status: 'candidate', origin: 'model' },
    { key: 'deadline', value: '2038-11-20T17:00:00', status: 'unresolved', origin: 'model', derived: true },
    { key: 'requirement', value: 'PDF', status: 'candidate', origin: 'model' },
  ],
  warnings: [],
}

describe('canConfirm', () => {
  it('null 不可确认；missing/confirmed 终态不重复确认', () => {
    expect(canConfirm({ value: null, status: 'unresolved' })).toBe(false)
    expect(canConfirm({ value: 'x', status: 'missing' })).toBe(false)
    expect(canConfirm({ value: 'x', status: 'confirmed' })).toBe(false)
    expect(canConfirm({ value: 'x', status: 'candidate' })).toBe(true)
  })
})

describe('mergeReanalysis 幂等 + AI 不得覆盖人工事实', () => {
  const old = {
    id: 'note-1',
    title: '旧标题',
    created_at: '2026-11-17T00:00:00Z',
    fields: [
      { key: 'title', value: '用户改过的标题', status: 'confirmed', origin: 'user' },
      { key: 'requirement', value: '人工确认的要求', status: 'confirmed', origin: 'model' },
      { key: 'deadline', value: '2026-11-20', status: 'candidate', origin: 'model' },
    ],
  }
  it('同 id 更新，不新建第二份', () => {
    const merged = mergeReanalysis(old, body, '2026-11-18T00:00:00Z')
    expect(merged.id).toBe('note-1')
    expect(merged.created_at).toBe(old.created_at)
  })
  it('confirmed 与 origin=user 字段保留，candidate 被新结果替换', () => {
    const merged = mergeReanalysis(old, body, 'now')
    expect(merged.fields.find((f) => f.key === 'title').value).toBe('用户改过的标题')
    expect(merged.fields.find((f) => f.key === 'requirement').value).toBe('人工确认的要求')
    expect(merged.fields.find((f) => f.key === 'deadline').value).toBe('2038-11-20T17:00:00')
  })
  it('无旧便签时新建', () => {
    const merged = mergeReanalysis(null, body, 'now')
    expect(merged.id).not.toBe('note-1')
    expect(merged.status).toBe('draft')
  })
  it('新结果省略某键时，已确认/用户改过的旧字段仍保留（不被丢弃）', () => {
    const oldWithConfirmedDeadline = {
      id: 'note-2',
      title: 't',
      created_at: '2026-11-17T00:00:00Z',
      fields: [
        { key: 'deadline', value: '2026-11-20T17:00:00', status: 'confirmed', origin: 'model', derived: true },
        { key: 'requirement', value: '人工改值', status: 'candidate', origin: 'user' },
      ],
    }
    const bodyWithoutDeadline = { source_id: 'src-2', content_type: 'notice', fields: [{ key: 'title', value: '新标题', status: 'candidate', origin: 'model' }], warnings: [] }
    const merged = mergeReanalysis(oldWithConfirmedDeadline, bodyWithoutDeadline, 'now')
    expect(merged.fields.find((f) => f.key === 'deadline').value).toBe('2026-11-20T17:00:00')
    expect(merged.fields.find((f) => f.key === 'deadline').status).toBe('confirmed')
    expect(merged.fields.find((f) => f.key === 'requirement').value).toBe('人工改值')
  })
})

describe('建任务出处规则', () => {
  it('未确认截止不能建任务', () => {
    expect(taskFromNote({ id: 'n', title: 't', fields: [{ key: 'deadline', value: '2026-11-20', status: 'candidate' }] }, 'now')).toBeNull()
  })
  it('已确认截止带出处', () => {
    const task = taskFromNote({ id: 'n', title: 't', fields: [{ key: 'deadline', value: '2026-11-20', status: 'confirmed', precision: 'date' }] }, 'now')
    expect(task.deadline.source).toBe('note')
    expect(task.deadline.from_note_id).toBe('n')
    expect(task.deadline.confirmed_at).toBe('now')
  })
  it('手动截止日历非法拒绝', () => {
    expect(manualTask({ id: 'n', title: 't' }, '2026-02-30', 'now')).toBeNull()
    expect(manualTask({ id: 'n', title: 't' }, '2026-11-20', 'now').deadline.source).toBe('manual')
  })
})
describe('失败便签标题用资料身份而非错误串', () => {
  it('图片用文件名', () => {
    const n = failedNote({ id: 's1', kind: 'image', name: '课程作业截图.png' }, 'unknown_source', 'now')
    expect(n.title).toBe('课程作业截图.png')
    expect(n.status).toBe('failed')
    expect(n.source_id).toBe('s1')
  })
  it('图片无名字回退', () => {
    expect(failedNote({ id: 's1', kind: 'image' }, 'x', 'now').title).toBe('未命名截图')
  })
  it('文本用首行并截断超长', () => {
    expect(failedNote({ id: 's2', kind: 'text', text: '\n\n  第一行内容  \n第二行' }, 'x', 'now').title).toBe('第一行内容')
    const long = 'a'.repeat(40)
    expect(failedNote({ id: 's2', kind: 'text', text: long }, 'x', 'now').title).toBe(`${'a'.repeat(24)}…`)
  })
  it('空文本回退', () => {
    expect(failedNote({ id: 's2', kind: 'text', text: '  ' }, 'x', 'now').title).toBe('文本摘录')
  })
})
