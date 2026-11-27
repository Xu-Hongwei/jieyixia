import { describe, expect, it } from 'vitest'
import { cleanTaskListQuery, filterTaskList, taskListPath } from '@/domains/taskList'
import { parseReturnPath, resolveReplanReturn, taskPath, taskReturnLabel } from '@/domains/workNavigation'

const tasks = [
  { id: 'a', kind: 'task', workspace_id: 'personal', title: 'Research report', status: 'todo', matter_id: 'group', deadline: { value: '2026-12-01' } },
  { id: 'b', kind: 'task', workspace_id: 'personal', title: '报告插图', status: 'blocked', matter_id: null, deadline: { value: null } },
  { id: 'c', kind: 'task', workspace_id: 'personal', title: '报告归档', status: 'done', matter_id: 'group', deadline: null },
]
const classification = { unscheduled: ['b'], pastUnfinished: [{ taskId: 'a', planIds: ['p'] }] }
const ctx = { docs: tasks, ws: 'personal', todayStr: '2026-11-26' }

describe('任务列表筛选与来源', () => {
  it('只保留可恢复的筛选参数，剔除临时操作和非法枚举', () => {
    expect(cleanTaskListQuery({ list: 'all', q: ['x'], status: 'invalid', undated: 'true', create: '1', return: '/today' })).toEqual({})
    expect(cleanTaskListQuery({ list: 'past', q: 'Research ', status: 'open', undated: '1', matter: 'group' })).toEqual({ list: 'past', q: 'Research ', status: 'open', undated: '1', matter: 'group' })
  })
  it('搜索可包含空格、不区分大小写，结合事项和状态筛选', () => {
    expect(filterTaskList(tasks, classification, { q: 'research report ', status: 'open', matter: 'group' }).map(t => t.id)).toEqual(['a'])
    expect(filterTaskList(tasks, classification, { q: '报告', undated: '1', status: 'open', matter: 'ungrouped' }).map(t => t.id)).toEqual(['b'])
    expect(filterTaskList(tasks, classification, { status: 'done', matter: 'group' }).map(t => t.id)).toEqual(['c'])
  })
  it('复用已有待安排/过去未完成分类，已完成不被错误算成未完成', () => {
    expect(filterTaskList(tasks, classification, { list: 'unscheduled' }).map(t => t.id)).toEqual(['b'])
    expect(filterTaskList(tasks, classification, { list: 'past' }).map(t => t.id)).toEqual(['a'])
    expect(filterTaskList(tasks, classification, { list: 'past', status: 'done' })).toEqual([])
  })
  it('任务详情及改排返回可以保留任务列表全部筛选', () => {
    const path = taskListPath({ list: 'unscheduled', q: '报告', status: 'open', undated: '1', matter: 'ungrouped' })
    expect(parseReturnPath(path + '&create=1', ctx)).toBe(path)
    const detail = taskPath('b', { return: path })
    expect(resolveReplanReturn(detail, 'b', ctx)).toBe(detail)
    expect(taskReturnLabel(path)).toBe('返回任务列表')
    expect(taskReturnLabel('/today?view=list')).toBe('返回日程')
    expect(taskReturnLabel('/collect?q=x')).toBe('返回资料库')
  })
})
