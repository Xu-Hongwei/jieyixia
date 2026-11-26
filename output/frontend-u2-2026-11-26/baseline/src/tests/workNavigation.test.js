// 5A-2B 纯路由助手：return 精确匹配/归属校验/有限嵌套、默认值省略、临时参数丢弃、
// 丢失 return 的安全回退、显式 plan 上下文校验、日程定位周判断。
import { describe, expect, it } from 'vitest'
import {
  cleanScheduleQuery, schedulePath, taskPath, workPath, recordPath,
  parseReturnPath, resolveWorkReturn, resolveTaskReturn, resolveReplanReturn, planContextForTask, scheduleLocateQuery, planScheduleReturn,
} from '@/domains/workNavigation'

const WS = 'personal'
const TODAY = '2026-11-23' // 周一
const docs = [
  { id: 't1', kind: 'task', workspace_id: WS },
  { id: 't2', kind: 'task', workspace_id: WS },
  { id: 'p1', kind: 'plan_item', workspace_id: WS, task_id: 't1', date: '2026-11-25', task_ref_state: 'active' },
  { id: 'p2', kind: 'plan_item', workspace_id: WS, task_id: 't2', date: '2026-11-25', task_ref_state: 'active' },
  { id: 'pDead', kind: 'plan_item', workspace_id: WS, task_id: 't1', date: '2026-11-25', task_ref_state: 'deleted' },
  { id: 'pOther', kind: 'plan_item', workspace_id: 'demo', task_id: 't1', date: '2026-11-25', task_ref_state: 'active' },
  { id: 'n1', kind: 'note', workspace_id: WS },
  { id: 's1', kind: 'focus_session', workspace_id: WS, task_id: 't1', plan_item_id: 'p1', ended_at: null },
  { id: 's2', kind: 'focus_session', workspace_id: WS, task_id: 't2', plan_item_id: null, ended_at: '2026-11-22T10:00:00.000Z' },
]
const ctx = { docs, ws: WS, todayStr: TODAY }
const session = (id) => docs.find((d) => d.id === id)

describe('改排返回上下文', () => {
  it('保留当前任务的安排、日程日期与列表视图', () => {
    const raw = taskPath('t1', { plan: 'p1', return: '/today?date=2026-11-25&view=list' })
    expect(resolveReplanReturn(raw, 't1', ctx)).toBe(raw)
  })
  it('保留资料筛选来源并剔除临时参数', () => {
    const raw = taskPath('t1', { return: '/collect?q=report&status=failed&create=1' })
    expect(resolveReplanReturn(raw, 't1', ctx)).toBe(taskPath('t1', { return: '/collect?q=report&status=failed' }))
  })
  it.each([undefined, '//evil.example', '/tasks/t2', '/today', '/tasks/t1?plan=p2',
    '/tasks/t1?plan=pOther', '/tasks/t1?return=%2Ftasks%2Ft2', '/tasks/t1?return=https%3A%2F%2Fevil.example'])('非法或非当前任务来源安全回退：%s', (raw) => {
    expect(resolveReplanReturn(raw, 't1', ctx)).toBe('/tasks/t1')
  })
  it('任务不存在或不属于当前空间时回日程', () => {
    expect(resolveReplanReturn('/tasks/missing', 'missing', ctx)).toBe('/today')
    expect(resolveReplanReturn('/tasks/t1', 't1', { ...ctx, ws: 'demo' })).toBe('/today')
  })
})

describe('cleanScheduleQuery / schedulePath', () => {
  it('默认值省略：view=week 与今天日期不写入；list 与非今天保留', () => {
    expect(schedulePath({ view: 'week', date: TODAY }, TODAY)).toBe('/today')
    expect(schedulePath({ view: 'list', date: '2026-11-25' }, TODAY)).toBe('/today?date=2026-11-25&view=list')
  })
  it('非法日期丢弃；临时操作参数 create/task/recorded/return 不保留', () => {
    expect(cleanScheduleQuery({ date: '2026-02-30', create: '1', task: 't1', recorded: 's2', return: '/today' }, TODAY)).toEqual({})
    expect(cleanScheduleQuery({ undated: '1', plan: 'p1' }, TODAY)).toEqual({ plan: 'p1', undated: '1' })
  })
})

describe('生成助手', () => {
  it('task/work/record 地址按需携带 plan 与 return，ID 编码', () => {
    expect(taskPath('t1', { plan: 'p1', return: '/today?view=list' })).toBe('/tasks/t1?plan=p1&return=%2Ftoday%3Fview%3Dlist')
    expect(workPath('s1', '/tasks/t1')).toBe('/work/s1?return=%2Ftasks%2Ft1')
    expect(workPath('s1')).toBe('/work/s1')
    expect(recordPath('s2', '/today')).toBe('/work-records/s2?return=%2Ftoday')
    expect(workPath('a/b')).toBe('/work/a%2Fb')
  })
})

describe('parseReturnPath 精确匹配与归属', () => {
  it('合法日程 return 规范化：默认值省略、临时参数丢弃', () => {
    expect(parseReturnPath('/today?date=2026-11-25&view=list&plan=p1', ctx)).toBe('/today?date=2026-11-25&view=list&plan=p1')
    expect(parseReturnPath(`/today?date=${TODAY}&view=week&recorded=s2&create=1`, ctx)).toBe('/today')
    expect(parseReturnPath('/today?return=%2Ftasks%2Ft1', ctx)).toBe('/today')
  })
  it('外站/协议相对/反斜杠/fragment/未匹配路径一律拒绝', () => {
    for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil', '/today#x', '/data', '/work/s1', '/tasks/t1/extra', '', null, 42, '/todayx']) {
      expect(parseReturnPath(bad, ctx)).toBeNull()
    }
  })
  it('对象归属：task/note/session/plan 不在当前空间即拒绝', () => {
    expect(parseReturnPath('/tasks/t1', ctx)).toBe('/tasks/t1')
    expect(parseReturnPath('/tasks/missing', ctx)).toBeNull()
    expect(parseReturnPath('/notes/n1', ctx)).toBe('/notes/n1')
    expect(parseReturnPath('/notes/missing', ctx)).toBeNull()
    expect(parseReturnPath('/work-records/s2', ctx)).toBe('/work-records/s2')
    expect(parseReturnPath('/work-records/missing', ctx)).toBeNull()
    expect(parseReturnPath('/today?plan=pOther', ctx)).toBeNull()
    expect(parseReturnPath('/today?plan=missing', ctx)).toBeNull()
  })
  it('资料库筛选保留已知键，未知键丢弃；待核对 bucket 校验', () => {
    expect(parseReturnPath('/collect?q=abc&kind=image&sort=new&evil=1', ctx)).toBe('/collect?q=abc&kind=image&sort=new')
    expect(parseReturnPath('/notes?bucket=failed', ctx)).toBe('/notes?bucket=failed')
    expect(parseReturnPath('/notes?bucket=evil', ctx)).toBe('/notes')
  })
  it('有限嵌套：task 可带终端 return；终端不可再带 task；三层拒绝', () => {
    expect(parseReturnPath('/tasks/t1?return=%2Ftoday%3Fview%3Dlist', ctx)).toBe('/tasks/t1?return=%2Ftoday%3Fview%3Dlist')
    expect(parseReturnPath('/tasks/t1?return=%2Fcollect', ctx)).toBe('/tasks/t1?return=%2Fcollect')
    expect(parseReturnPath('/tasks/t1?return=%2Ftasks%2Ft2', ctx)).toBeNull()
    expect(parseReturnPath('/tasks/t1?return=%2Ftoday%3Freturn%3D%252Fcollect', ctx)).toBe('/tasks/t1?return=%2Ftoday')
    expect(parseReturnPath('/tasks/t1?return=https%3A%2F%2Fevil.example', ctx)).toBeNull()
    expect(parseReturnPath('/tasks/t1?return=%2Fwork%2Fs1', ctx)).toBeNull()
  })
  it('task 的 plan 参数校验归属与所属任务', () => {
    expect(parseReturnPath('/tasks/t1?plan=p1', ctx)).toBe('/tasks/t1?plan=p1')
    expect(parseReturnPath('/tasks/t1?plan=p2', ctx)).toBeNull()
    expect(parseReturnPath('/tasks/t1?plan=pOther', ctx)).toBeNull()
  })
})

describe('resolveWorkReturn / resolveTaskReturn 安全回退', () => {
  it('合法 return 原样规范化使用', () => {
    expect(resolveWorkReturn('/today?view=list', session('s1'), ctx)).toBe('/today?view=list')
    expect(resolveTaskReturn('/collect?q=x', ctx)).toBe('/collect?q=x')
  })
  it('return 丢失/非法：关联安排 → 日程定位安排日；独立会话 → 所属任务', () => {
    expect(resolveWorkReturn(null, session('s1'), ctx)).toBe('/today?date=2026-11-25&plan=p1')
    expect(resolveWorkReturn('https://evil.example', session('s1'), ctx)).toBe('/today?date=2026-11-25&plan=p1')
    expect(resolveWorkReturn(null, session('s2'), ctx)).toBe('/tasks/t2')
  })
  it('对象不存在或无会话 → 当前空间日程；task 页回退任务列表', () => {
    expect(resolveWorkReturn(null, { task_id: 'gone', plan_item_id: 'gone' }, ctx)).toBe('/today')
    expect(resolveWorkReturn(null, null, ctx)).toBe('/today')
    expect(resolveTaskReturn('/tasks/gone', ctx)).toBe('/tasks')
  })
})

describe('planContextForTask 显式上下文', () => {
  it('只认显式 plan 参数，不从 return 字符串推断', () => {
    expect(planContextForTask({ return: '/today?plan=p1' }, 't1', ctx)).toEqual({ status: 'none' })
    expect(planContextForTask({}, 't1', ctx)).toEqual({ status: 'none' })
  })
  it('ok / missing / cross-task / dead-ref 四类结果', () => {
    expect(planContextForTask({ plan: 'p1' }, 't1', ctx)).toEqual({ status: 'ok', plan: docs.find((d) => d.id === 'p1') })
    expect(planContextForTask({ plan: 'pOther' }, 't1', ctx)).toEqual({ status: 'invalid', reason: 'missing' })
    expect(planContextForTask({ plan: 'p2' }, 't1', ctx)).toEqual({ status: 'invalid', reason: 'cross-task' })
    expect(planContextForTask({ plan: 'pDead' }, 't1', ctx)).toEqual({ status: 'invalid', reason: 'dead-ref' })
  })
})

describe('scheduleLocateQuery 返回定位', () => {
  const plan = docs.find((d) => d.id === 'p1') // 2026-11-25，与今天同周
  it('同周不同日：日期一律对齐安排日（选中目标日），视图保留，不 relocated', () => {
    const r = scheduleLocateQuery(plan, { date: '2026-11-24', view: 'list' }, TODAY)
    expect(r).toEqual({ query: { date: '2026-11-25', view: 'list', plan: 'p1' }, relocated: false })
  })
  it('来源周包含不了目标：同样对齐安排日并标记 relocated；目标=今天则省略日期', () => {
    const r = scheduleLocateQuery(plan, { date: '2026-11-16', view: 'list' }, TODAY)
    expect(r).toEqual({ query: { date: '2026-11-25', view: 'list', plan: 'p1' }, relocated: true })
    const todayPlan = { ...plan, date: TODAY }
    expect(scheduleLocateQuery(todayPlan, { date: '2026-11-16' }, TODAY)).toEqual({ query: { plan: 'p1' }, relocated: true })
  })
  it('无来源查询：按今天所在周判断，日期仍对齐安排日', () => {
    expect(scheduleLocateQuery(plan, {}, TODAY)).toEqual({ query: { date: '2026-11-25', plan: 'p1' }, relocated: false })
  })
  it('目标=今天且来源同周：省略日期但保留视图（手机选中今天）', () => {
    const todayPlan = { ...plan, date: TODAY }
    expect(scheduleLocateQuery(todayPlan, { date: '2026-11-24', view: 'list' }, TODAY))
      .toEqual({ query: { view: 'list', plan: 'p1' }, relocated: false })
  })
})

describe('planScheduleReturn 定位说明标记 located', () => {
  const plan = docs.find((d) => d.id === 'p1')
  it('来源周不包含目标：return 携带 located=1，且经 return 规范化仍保留（工作页解析不丢）', () => {
    const ret = planScheduleReturn('/today', { date: '2026-11-16', view: 'list' }, plan, TODAY)
    expect(ret).toBe('/today?date=2026-11-25&view=list&plan=p1&located=1')
    expect(parseReturnPath(ret, ctx)).toBe(ret)
    expect(resolveWorkReturn(ret, session('s1'), ctx)).toBe(ret)
  })
  it('同周不同日：对齐安排日、保留视图，不带 located', () => {
    expect(planScheduleReturn('/today', { date: '2026-11-24' }, plan, TODAY)).toBe('/today?date=2026-11-25&plan=p1')
    expect(planScheduleReturn('/today', { view: 'list' }, plan, TODAY)).toBe('/today?date=2026-11-25&view=list&plan=p1')
  })
  it('非日程宿主：直接用安排日定位', () => {
    expect(planScheduleReturn('/tasks/t1', {}, plan, TODAY)).toBe('/today?date=2026-11-25&plan=p1')
  })
  it('located 只认值 1，其它值丢弃', () => {
    expect(cleanScheduleQuery({ located: '1' }, TODAY)).toEqual({ located: '1' })
    expect(cleanScheduleQuery({ located: 'yes' }, TODAY)).toEqual({})
  })
})
