// 5A-2B 整改 R1/R2 反例回归（人工审查 2026-11-23）：
// R1 确认版本统一派生——planDate/显示/日期关系/风险勾选全部取同一份已冻结且已展示的确认版本；
//    「今天→明天→再次改期」每次重确认后 planDate 跟随 expected.date，勾选重置，绝不按旧日期提交。
// R2 开始后补充读取失败——稳定 session_id 先保留，进入待核实（只重读不重新 begin），finally 释放 busy；
//    再次读取恢复、读取期间切空间不导航不污染。
// 只 fake Date（toFake:['Date']），IndexedDB 定时器保持真实；vue-router 仅 mock useRouter。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const pushMock = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { usePlanStore } from '@/stores/plan'
import { usePlanWorkStart } from '@/composables/usePlanWorkStart'
import { clearWorkspace, configureWorkspace, putDoc } from '@/services/storage/db'
import { beijingAddDays, beijingToday } from '@/domains/time'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-23T10:00:00+08:00'))
  pushMock.mockClear()
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  useFocusStore().stop()
  await clearWorkspace('personal')
  await clearWorkspace('demo')
  configureWorkspace('personal')
})

async function setup() {
  const app = useAppStore()
  await app.init()
  const { id: taskId } = await app.createStandaloneTask({ title: 'R任务' })
  const task = app.tasks.find((t) => t.id === taskId)
  await app.addAction(task, '行动一', 30)
  const actionId = app.actionsOf(taskId)[0].id
  await app.setCurrentAction(task, actionId)
  const planStore = usePlanStore()
  const intent = planStore.issueRequest('create', { taskId, actionText: '写一节', plannedMinutes: 30 })
  const r = await planStore.create({ ...intent.input, requestId: intent.requestId, issuedAtMs: intent.issuedAtMs })
  expect(r.ok).toBe(true)
  const focus = useFocusStore()
  const onStarted = vi.fn()
  const ctrl = usePlanWorkStart({ onStarted, onGotoTask: vi.fn(), onReview: vi.fn(), workReturnFor: () => '/today' })
  return { app, focus, taskId, actionId, planId: r.plan_item_id, ctrl, onStarted }
}

// 模拟外部改动：直写 IDB 后重读（不经服务，绕过页面草稿）。
async function mutateDoc(app, id, patch) {
  const doc = JSON.parse(JSON.stringify(app.docs.find((d) => d.id === id)))
  Object.assign(doc, patch)
  await putDoc(doc)
  await app.reloadDocs()
}

describe('R1 确认版本统一派生：今天→明天→再次改期', () => {
  it('每次差异重确认后 planDate 跟随 expected.date；日期勾选重置；最终按最新确认版创建', async () => {
    const h = await setup()
    const today = beijingToday()
    expect(h.ctrl.openFor({ taskId: h.taskId, planId: h.planId })).toBe(true)
    expect(h.ctrl.planDate.value).toBe(today)
    expect(h.ctrl.dateMismatch.value).toBe(false)

    // 外部改期到明天 + 改说明：提交 → STALE_PLAN → 差异框。
    const tomorrow = beijingAddDays(today, 1)
    await mutateDoc(h.app, h.planId, { date: tomorrow, action_text: '改写后的说明' })
    await h.ctrl.submit()
    expect(h.ctrl.state.value.phase).toBe('diffs')
    expect(h.ctrl.state.value.diffRows.some((r) => r.field === 'date')).toBe(true)
    // 未确认前显示仍是开框时冻结的旧版本（不追 live）。
    expect(h.ctrl.planDate.value).toBe(today)

    h.ctrl.confirmDiffs()
    expect(h.ctrl.planDate.value).toBe(tomorrow)
    expect(h.ctrl.state.value.expected.date).toBe(tomorrow)
    expect(h.ctrl.state.value.expected.action_text).toBe('改写后的说明')
    expect(h.ctrl.dateMismatch.value).toBe(true)
    expect(h.ctrl.state.value.dateChecked).toBe(false)
    expect(h.ctrl.canConfirm.value).toBe(false)
    h.ctrl.state.value.dateChecked = true
    expect(h.ctrl.canConfirm.value).toBe(true)

    // 再次改期到后天：旧确认版不得直接提交，必须再次差异重确认。
    const day2 = beijingAddDays(today, 2)
    await mutateDoc(h.app, h.planId, { date: day2 })
    await h.ctrl.submit()
    expect(h.ctrl.state.value.phase).toBe('diffs')
    expect(h.ctrl.planDate.value).toBe(tomorrow) // 仍是上一次确认版
    h.ctrl.confirmDiffs()
    expect(h.ctrl.planDate.value).toBe(day2)
    expect(h.ctrl.state.value.dateChecked).toBe(false)
    expect(h.ctrl.canConfirm.value).toBe(false)
    h.ctrl.state.value.dateChecked = true
    await h.ctrl.submit()

    expect(h.onStarted).toHaveBeenCalledTimes(1)
    expect(h.ctrl.state.value).toBeNull()
    expect(h.focus.sessions.length).toBe(1)
    const sid = h.onStarted.mock.calls[0][0]
    expect(h.focus.sessions.find((s) => s.id === sid).plan_item_id).toBe(h.planId)
  })

  it('任务标题/状态/截止与安排同一次冻结；受阻重确认需重新勾选，不按旧状态提交', async () => {
    const h = await setup()
    h.ctrl.openFor({ taskId: h.taskId, planId: h.planId })
    expect(h.ctrl.state.value.taskTitle).toBe('R任务')
    expect(h.ctrl.state.value.taskStatus).toBe('todo')
    expect(h.ctrl.blockedRequired.value).toBe(false)

    const tomorrow = beijingAddDays(beijingToday(), 1)
    await mutateDoc(h.app, h.taskId, { title: '改名后的任务', status: 'blocked', deadline: { value: '2026-11-24T18:00:00+08:00', precision: 'minute', role: 'submission_deadline' } })
    await mutateDoc(h.app, h.planId, { date: tomorrow })
    // 受阻确认先于差异检查：第一次提交只要求显式受阻确认，不创建会话。
    await h.ctrl.submit()
    expect(h.ctrl.state.value.blockedPrompt).toBe(true)
    expect(h.ctrl.state.value.phase).toBe('confirm')
    expect(h.focus.sessions.length).toBe(0)
    h.ctrl.state.value.blockedChecked = true
    await h.ctrl.submit()
    expect(h.ctrl.state.value.phase).toBe('diffs')
    // 差异框期间显示仍是旧冻结版本。
    expect(h.ctrl.state.value.taskTitle).toBe('R任务')
    expect(h.ctrl.state.value.taskStatus).toBe('todo')

    h.ctrl.confirmDiffs()
    expect(h.ctrl.state.value.taskTitle).toBe('改名后的任务')
    expect(h.ctrl.state.value.taskStatus).toBe('blocked')
    expect(h.ctrl.state.value.taskDeadline).toEqual({ value: '2026-11-24T18:00:00+08:00', precision: 'minute' })
    expect(h.ctrl.blockedRequired.value).toBe(true)
    expect(h.ctrl.state.value.blockedChecked).toBe(false)
    expect(h.ctrl.canConfirm.value).toBe(false)
    h.ctrl.state.value.dateChecked = true
    expect(h.ctrl.canConfirm.value).toBe(false) // 受阻勾选仍未确认
    h.ctrl.state.value.blockedChecked = true
    expect(h.ctrl.canConfirm.value).toBe(true)
    await h.ctrl.submit()
    expect(h.onStarted).toHaveBeenCalledTimes(1)
    expect(h.focus.sessions.length).toBe(1)
  })
})

describe('R2 开始后补充读取失败：待核实不卡 busy，只重读不重新创建', () => {
  it('首次读取失败 → 待核实（保留 session_id、busy 释放）；再次读取恢复，begin 只调用一次', async () => {
    const h = await setup()
    h.ctrl.openFor({ taskId: h.taskId, planId: h.planId })
    const beginSpy = vi.spyOn(h.focus, 'begin')
    vi.spyOn(h.focus, 'loadWorkspace').mockRejectedValueOnce(new Error('注入一次读取失败'))
    await h.ctrl.submit()

    const s = h.ctrl.state.value
    expect(s).not.toBeNull()
    expect(s.phase).toBe('verify')
    expect(s.busy).toBe(false)
    expect(s.pendingSid).toBeTruthy()
    expect(s.error.message).toContain('读取待核实')
    expect(h.onStarted).not.toHaveBeenCalled()
    expect(beginSpy).toHaveBeenCalledTimes(1)
    // 会话其实已创建（begin 内部重读成功），失败的是导航前的补充读取。
    expect(h.focus.sessions.some((x) => x.id === s.pendingSid && x.ended_at == null)).toBe(true)
    const sid = s.pendingSid

    await h.ctrl.verify()
    expect(h.onStarted).toHaveBeenCalledTimes(1)
    expect(h.onStarted.mock.calls[0][0]).toBe(sid)
    expect(beginSpy).toHaveBeenCalledTimes(1) // 绝不重新 begin
    expect(h.ctrl.state.value).toBeNull()
    expect(h.focus.sessions.length).toBe(1)
  })

  it('核实读取再次失败：busy 释放、可继续重试；成功后才导航', async () => {
    const h = await setup()
    h.ctrl.openFor({ taskId: h.taskId, planId: h.planId })
    const loadSpy = vi.spyOn(h.focus, 'loadWorkspace')
    loadSpy.mockRejectedValueOnce(new Error('注入一次读取失败'))
    await h.ctrl.submit()
    expect(h.ctrl.state.value.phase).toBe('verify')

    loadSpy.mockRejectedValueOnce(new Error('注入第二次读取失败'))
    await h.ctrl.verify()
    const s = h.ctrl.state.value
    expect(s.phase).toBe('verify')
    expect(s.busy).toBe(false)
    expect(s.pendingSid).toBeTruthy()
    expect(s.error.message).toContain('读取失败，核实未完成')
    expect(h.onStarted).not.toHaveBeenCalled()

    await h.ctrl.verify()
    expect(h.onStarted).toHaveBeenCalledTimes(1)
    expect(h.ctrl.state.value).toBeNull()
  })

  it('补充读取期间切空间：晚到结果不导航、不清新空间状态', async () => {
    const h = await setup()
    h.ctrl.openFor({ taskId: h.taskId, planId: h.planId })
    vi.spyOn(h.focus, 'loadWorkspace').mockImplementationOnce(async () => {
      await h.app.switchWorkspace('demo')
    })
    await h.ctrl.submit()
    expect(h.onStarted).not.toHaveBeenCalled()
    expect(h.ctrl.state.value).toBeNull() // 切空间 watch 关闭面板
    expect(h.focus.sessions.length).toBe(0) // demo 空间无会话，不被 personal 结果污染
  })

  it('差异重确认的读取失败：busy 释放、不按旧事实创建；重试后正常列差异', async () => {
    const h = await setup()
    h.ctrl.openFor({ taskId: h.taskId, planId: h.planId })
    await mutateDoc(h.app, h.planId, { date: beijingAddDays(beijingToday(), 1) })
    const reloadSpy = vi.spyOn(h.app, 'reloadDocs')
    reloadSpy.mockRejectedValueOnce(new Error('注入读取失败'))
    await h.ctrl.submit()
    const s = h.ctrl.state.value
    expect(s.busy).toBe(false)
    expect(s.phase).toBe('confirm')
    expect(s.error.message).toContain('读取最新事实失败')
    expect(h.onStarted).not.toHaveBeenCalled()
    expect(h.focus.sessions.length).toBe(0)

    await h.ctrl.submit()
    expect(h.ctrl.state.value.phase).toBe('diffs')
    expect(h.ctrl.state.value.diffRows.some((r) => r.field === 'date')).toBe(true)
  })

  it('信封失效后重新核对的读取失败：busy 释放；重试后按 live 事实重冻结（含任务显示字段）', async () => {
    const h = await setup()
    h.ctrl.openFor({ taskId: h.taskId, planId: h.planId })
    // 先在 10:00 提交一次形成信封（STALE_PLAN → 差异框，信封保留）；
    // 推进 11 分钟（窗口 10 分钟）后复用旧信封再提交 → STALE_REQUEST → stale 相位。
    await mutateDoc(h.app, h.planId, { date: beijingAddDays(beijingToday(), 1) })
    await h.ctrl.submit()
    expect(h.ctrl.state.value.phase).toBe('diffs')
    vi.setSystemTime(new Date('2026-11-23T10:11:00+08:00'))
    await h.ctrl.submit()
    expect(h.ctrl.state.value.phase).toBe('stale')

    await mutateDoc(h.app, h.taskId, { title: '过期后改名' })
    const reloadSpy = vi.spyOn(h.app, 'reloadDocs')
    reloadSpy.mockRejectedValueOnce(new Error('注入读取失败'))
    await h.ctrl.refreeze()
    expect(h.ctrl.state.value.busy).toBe(false)
    expect(h.ctrl.state.value.phase).toBe('stale')
    expect(h.ctrl.state.value.error.message).toContain('读取最新事实失败')

    await h.ctrl.refreeze()
    const s = h.ctrl.state.value
    expect(s.phase).toBe('confirm')
    expect(s.taskTitle).toBe('过期后改名')
    expect(s.envelope).toBeNull()
    expect(s.input).toBeNull()
    expect(h.focus.sessions.length).toBe(0)
  })
})