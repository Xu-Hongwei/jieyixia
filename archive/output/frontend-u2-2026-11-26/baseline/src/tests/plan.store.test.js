// 5A-0 store 薄入口单测：A03 缺省日期按北京今天固定进意图（重试跨午夜不换日）、
// A13 切空间后旧信封拒绝且晚到结果不污染新空间 docs、纯读取 helper 读 app.docs live 事实。
// 只 fake Date（toFake:['Date']），IndexedDB 定时器保持真实，避免 fake-indexeddb 挂起。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '../stores/app'
import { usePlanStore } from '../stores/plan'
import { clearWorkspace, configureWorkspace, putDoc } from '../services/storage/db'
import { planDeleteScope } from '../domains/matter'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(async () => {
  vi.useRealTimers()
  await clearWorkspace('personal')
  await clearWorkspace('demo')
  configureWorkspace('personal')
})

async function taskIn(store, title) {
  const { id } = await store.createStandaloneTask({ title })
  return store.tasks.find((t) => t.id === id)
}

describe('A03 store 缺省日期：意图形成时按北京今天固定，重试不换日', () => {
  it('北京 23:58 形成意图 → 缺省日期是北京今天；窗口内跨午夜重试仍原日期且只一条', async () => {
    // 2026-11-22T15:58Z = 北京 2026-11-22 23:58（UTC 日期也是 11-22，但下面用北京日界验证）。
    vi.setSystemTime(new Date('2026-11-22T15:58:00Z'))
    const app = useAppStore()
    await app.init()
    const task = await taskIn(app, 'S跨午夜')
    const plan = usePlanStore()
    const intent = plan.issueRequest('create', { taskId: task.id, actionText: '写一节', plannedMinutes: 30 })
    expect(intent.input.date).toBe('2026-11-22')
    expect(intent.planItemId).toBeTruthy()

    // 5 分钟后（信封窗口内）北京已跨到 11-23：重试同一信封，日期仍是意图形成时的 11-22。
    vi.setSystemTime(new Date('2026-11-22T16:03:00Z'))
    const r = await plan.create({ ...intent.input, requestId: intent.requestId })
    expect(r.ok).toBe(true)
    expect(r.plan_item_id).toBe(intent.planItemId)
    const plans = app.docs.filter((d) => d.kind === 'plan_item')
    expect(plans.length).toBe(1)
    expect(plans[0].date).toBe('2026-11-22')
    expect(plans[0].id).toBe(intent.planItemId)
    // 再重试一次（缺 issuedAtMs，store 补原签发时刻）→ replay，不产生第二条。
    const again = await plan.create({ ...intent.input, requestId: intent.requestId })
    expect(again.ok).toBe(true)
    expect(again.replayed).toBe(true)
    expect(app.docs.filter((d) => d.kind === 'plan_item').length).toBe(1)
    // 缺省日按北京而非 UTC：16:30Z 的 UTC 日期仍是 11-22，北京已是 11-23。
    vi.setSystemTime(new Date('2026-11-22T16:30:00Z'))
    const next = plan.issueRequest('create', { taskId: task.id, actionText: '另一节', plannedMinutes: 10 })
    expect(next.input.date).toBe('2026-11-23')
  })
})

describe('A13 store 归属：切空间后旧信封拒绝，新空间 docs 不被污染', () => {
  it('personal 意图在 demo 空间重试被拒；demo 无计划残留；回 personal 原信封仍可 replay', async () => {
    vi.setSystemTime(new Date('2026-11-22T10:00:00+08:00'))
    const app = useAppStore()
    await app.init()
    const task = await taskIn(app, 'S归属')
    const plan = usePlanStore()
    const intent = plan.issueRequest('create', { taskId: task.id, actionText: '行动', plannedMinutes: 20 })
    const first = await plan.create({ ...intent.input, requestId: intent.requestId, issuedAtMs: intent.issuedAtMs })
    expect(first.ok).toBe(true)
    expect(first.workspace_id).toBe('personal')

    await app.switchWorkspace('demo')
    const late = await plan.create({ ...intent.input, requestId: intent.requestId, issuedAtMs: intent.issuedAtMs })
    expect(late.ok).toBe(false)
    expect(app.workspaceId).toBe('demo')
    expect(app.docs.filter((d) => d.kind === 'plan_item').length).toBe(0)

    await app.switchWorkspace('personal')
    const back = await plan.create({ ...intent.input, requestId: intent.requestId, issuedAtMs: intent.issuedAtMs })
    expect(back.ok).toBe(true)
    expect(back.replayed).toBe(true)
    expect(app.docs.filter((d) => d.kind === 'plan_item').length).toBe(1)
  })
})

describe('store 纯读取 helper：读 app.docs live 事实，无写入', () => {
  it('schedule/classify/summary/riskFor/checkExecutable 均可用且不改库', async () => {
    vi.setSystemTime(new Date('2026-11-22T10:00:00+08:00'))
    const app = useAppStore()
    await app.init()
    const task = await taskIn(app, 'S读取')
    await app.addAction(task, '行动一', 30)
    const action = app.actionsOf(task.id)[0]
    const plan = usePlanStore()
    const intent = plan.issueRequest('create', { taskId: task.id, actionText: '写引言', plannedMinutes: 30, date: '2026-11-23' })
    const r = await plan.create({ ...intent.input, requestId: intent.requestId, issuedAtMs: intent.issuedAtMs })
    expect(r.ok).toBe(true)

    const sched = plan.schedule('2026-11-23', new Date('2026-11-22T10:00:00+08:00'))
    expect(sched.planCount).toBe(1)
    expect(sched.days[0].plans.length).toBe(1)
    const cls = plan.classify(new Date('2026-11-22T10:00:00+08:00'))
    expect(cls.scheduled).toContain(task.id)
    const sum = plan.summary(r.plan_item_id)
    expect(sum.endedSessionCount).toBe(0)
    expect(sum.actualMinutes).toBeNull()
    const risk = plan.riskFor(task.id, '2026-11-23', new Date('2026-11-22T10:00:00+08:00'))
    expect(risk.kind).toBe('no_deadline')
    expect(plan.checkExecutable(r.plan_item_id, action.id).planItem.id).toBe(r.plan_item_id)
    expect(plan.unfinishedSessionFor(r.plan_item_id)).toBeNull()
  })
})

// R2 整改：删除确认范围纳入计划影响。旧式 scope（无计划字段）由 store 在确认时补齐快照；
// 新调用方显式提交的计划快照被尊重，事务内与最新事实比对，变化 → scopeChanged 且零删除。
describe('R2 store 删除范围：计划影响快照补齐与 SCOPE_CHANGED 透传', () => {
  async function seedPlan(app, taskId, text) {
    const plan = usePlanStore()
    const intent = plan.issueRequest('create', { taskId, actionText: text, plannedMinutes: 20, date: '2026-11-23' })
    const r = await plan.create({ ...intent.input, requestId: intent.requestId, issuedAtMs: intent.issuedAtMs })
    expect(r.ok).toBe(true)
    return r.plan_item_id
  }
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-11-22T10:00:00+08:00'))
  })
  it('旧式 scope 自动补齐计划快照：范围一致时任务与 planned 安排同事务删除', async () => {
    const app = useAppStore()
    await app.init()
    const task = await taskIn(app, 'S删除范围')
    const pid = await seedPlan(app, task.id, '写一节')
    const r = await app.deleteTask(task, { taskIds: [task.id], actionIds: [] })
    expect(r.ok).toBe(true)
    expect(app.docs.find((d) => d.id === task.id)).toBeUndefined()
    expect(app.docs.find((d) => d.id === pid)).toBeUndefined()
  })
  it('显式计划快照缺少确认后新增的安排 → scopeChanged，任务与全部安排零删除', async () => {
    const app = useAppStore()
    await app.init()
    const task = await taskIn(app, 'S范围变化')
    const p1 = await seedPlan(app, task.id, '第一节')
    await seedPlan(app, task.id, '第二节') // 确认后新增（快照只含 p1）
    const r = await app.deleteTask(task, { taskIds: [task.id], actionIds: [], planItemIds: [p1] })
    expect(r.ok).toBe(false)
    expect(r.scopeChanged).toBe(true)
    expect(app.docs.find((d) => d.id === task.id)).toBeTruthy()
    expect(app.docs.filter((d) => d.kind === 'plan_item').length).toBe(2)
  })
  it('显式完整计划快照（ID+处置事实）一致 → 正常删除', async () => {
    const app = useAppStore()
    await app.init()
    const task = await taskIn(app, 'S完整快照')
    await seedPlan(app, task.id, '写一节')
    const facts = planDeleteScope(app.docs, [task.id], [])
    const r = await app.deleteTask(task, { taskIds: [task.id], actionIds: [], planItemIds: facts.map((f) => f.id), planFacts: facts })
    expect(r.ok).toBe(true)
    expect(app.docs.filter((d) => d.kind === 'plan_item').length).toBe(0)
  })
  it('便签联删同口径：显式计划快照与最新不符 → scopeChanged，便签/任务/安排零删除', async () => {
    const app = useAppStore()
    await app.init()
    const task = await taskIn(app, 'S联删范围')
    await seedPlan(app, task.id, '写一节')
    const plain = JSON.parse(JSON.stringify(app.docs.find((d) => d.id === task.id)))
    await putDoc({ ...plain, note_ids: ['n-review'] })
    await putDoc({ id: 'n-review', kind: 'note', source_id: null, fields: [], created_at: '2026-11-22T10:00:00+08:00' })
    await app.reloadDocs()
    const noteDoc = app.docs.find((d) => d.id === 'n-review')
    const r = await app.deleteNote(noteDoc, { taskIds: [task.id], actionIds: [], planItemIds: [] })
    expect(r.ok).toBe(false)
    expect(r.scopeChanged).toBe(true)
    expect(app.docs.find((d) => d.id === 'n-review')).toBeTruthy()
    expect(app.docs.find((d) => d.id === task.id)).toBeTruthy()
    expect(app.docs.filter((d) => d.kind === 'plan_item').length).toBe(1)
  })
})