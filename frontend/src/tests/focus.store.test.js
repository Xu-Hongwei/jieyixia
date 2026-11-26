// S7 store 接入单测：loadWorkspace 读当前空间事实、包装操作归属匹配才更新、
// 切空间重载、全局运行位置跨空间语义、排队期间世代变化不污染本地 ref。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, reactive } from 'vue'
import { useAppStore } from '../stores/app'
import { useFocusStore } from '../stores/focus'
import { allDocs, clearWorkspace, configureWorkspace, putDoc } from '../services/storage/db'
import { beginFactsOf } from '../domains/focus'
import { planSnapshot } from '../domains/plan'
import { beijingDateStr } from '../domains/time'

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(async () => {
  useFocusStore().stop()
  await clearWorkspace('personal')
  await clearWorkspace('demo')
  configureWorkspace('personal')
})

async function taskWithAction(store, title) {
  const { id } = await store.createStandaloneTask({ title })
  const task = store.tasks.find((t) => t.id === id)
  await store.addAction(task, '行动一', 30)
  return { taskId: id, actionId: store.actionsOf(id)[0].id }
}

describe('focus store：读取与包装', () => {
  it('begin 后 refs 反映当前空间会话/协调/全局运行位置；end 后清空', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F读取')
    const focus = useFocusStore()
    expect(focus.sessions).toEqual([])
    const r = await focus.begin({ taskId, actionId })
    expect(r.ok).toBe(true)
    expect(focus.sessions.length).toBe(1)
    expect(focus.unfinished.length).toBe(1)
    expect(focus.running).toEqual({ workspace_id: 'personal', session_id: r.session_id })
    const rt = focus.coordination.find((c) => c.session_id === r.session_id)
    expect(rt.owner_id).toBe(focus.ownerId)
    expect(rt.epoch).toBe(1)

    const saved = await focus.saveDraft({ sessionId: r.session_id, draftMd: '草稿一' })
    expect(saved.ok).toBe(true)
    expect(focus.sessions[0].draft_md).toBe('草稿一')
    expect(saved.draft_seq).toBe(1)

    const ended = await focus.end({ sessionId: r.session_id, outcome: 'partial', draftMd: '最终稿' })
    expect(ended.ok).toBe(true)
    expect(focus.unfinished.length).toBe(0)
    expect(focus.running).toBeNull()
    expect(focus.sessions[0].draft_md).toBe('最终稿')
    expect(focus.sessions[0].ended_at).toBeTruthy()
  })
  it('loadWorkspace 只读当前空间会话；协调记录按空间过滤', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F空间')
    const focus = useFocusStore()
    await focus.begin({ taskId, actionId })
    await focus.pause({ sessionId: focus.sessions[0].id })
    await store.switchWorkspace('demo')
    expect(focus.sessions).toEqual([])
    expect(focus.coordination).toEqual([])
    expect(focus.running).toBeNull()
    const demo = await taskWithAction(store, 'F演示')
    const r2 = await focus.begin(demo)
    expect(r2.ok).toBe(true)
    expect(focus.sessions.length).toBe(1)
    expect(focus.sessions[0].workspace_id).toBe('demo')
    await store.switchWorkspace('personal')
    expect(focus.sessions.length).toBe(1)
    expect(focus.sessions[0].workspace_id).toBe('personal')
    expect(focus.sessions[0].running).toBe(false)
  })
  it('两空间可各有暂停会话；全局只允许一份运行', async () => {
    const store = useAppStore()
    await store.init()
    const focus = useFocusStore()
    const p = await taskWithAction(store, 'F个人')
    const rp = await focus.begin(p)
    await focus.pause({ sessionId: rp.session_id })
    await store.switchWorkspace('demo')
    const d = await taskWithAction(store, 'F演示')
    const rd = await focus.begin(d)
    expect(rd.ok).toBe(true)
    // personal 已暂停释放运行位，demo 可运行；此时 personal 不能再运行（全局唯一）。
    expect(focus.running).toEqual({ workspace_id: 'demo', session_id: rd.session_id })
    await store.switchWorkspace('personal')
    const again = await focus.resume({ sessionId: rp.session_id })
    expect(again.ok).toBe(false)
    expect(again.code).toBe('ALREADY_ACTIVE')
    await focus.pause({ sessionId: rp.session_id })
    const personal = (await allDocs()).records.filter((x) => x.kind === 'focus_session')
    expect(personal.length).toBe(1)
    expect(personal[0].ended_at).toBeNull()
    expect(personal[0].running).toBe(false)
    await store.switchWorkspace('demo')
    await focus.pause({ sessionId: rd.session_id })
    const demoSessions = (await allDocs()).records.filter((x) => x.kind === 'focus_session')
    expect(demoSessions.length).toBe(1)
    expect(demoSessions[0].ended_at).toBeNull()
    expect(demoSessions[0].running).toBe(false)
    expect(focus.running).toBeNull()
  })
  it('排队期间 DB 世代变化：操作拒绝，本地 ref 不出现半提交状态', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F世代')
    const focus = useFocusStore()
    const r = await focus.begin({ taskId, actionId })
    const original = IDBObjectStore.prototype.getAll
    let armed = true
    IDBObjectStore.prototype.getAll = function (...args) {
      if (armed && this.name === 'docs') {
        armed = false
        configureWorkspace('demo')
      }
      return original.apply(this, args)
    }
    let paused
    try {
      paused = await focus.pause({ sessionId: r.session_id })
    } finally {
      IDBObjectStore.prototype.getAll = original
      configureWorkspace('personal')
    }
    expect(paused.ok).toBe(false)
    expect(paused.code).toBe('WORKSPACE_CHANGED')
    expect(focus.sessions[0].running).toBe(true)
    expect(focus.sessions[0].timer_anchor_at).toBeTruthy()
    const dbSession = (await allDocs()).records.find((d) => d.id === r.session_id)
    expect(dbSession.running).toBe(true)
  })
  it('store 复用请求信封：issueRequest 签发一次，缺时刻重试复用原签发时刻 replay 原会话', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F信封')
    const focus = useFocusStore()
    const env = focus.issueRequest('begin')
    const first = await focus.begin({ taskId, actionId, requestId: env.request_id, issuedAtMs: env.issued_at_ms })
    expect(first.ok).toBe(true)
    expect(first.issued_at_ms).toBe(env.issued_at_ms)
    const retry = await focus.begin({ taskId, actionId, requestId: env.request_id })
    expect(retry.replayed).toBe(true)
    expect(retry.session_id).toBe(first.session_id)
    expect(retry.issued_at_ms).toBe(env.issued_at_ms)
    expect(focus.sessions.length).toBe(1)
  })
  it('切空间后原空间运行会话仍占全局运行位（running 是跨空间事实）', async () => {
    const store = useAppStore()
    await store.init()
    const focus = useFocusStore()
    const p = await taskWithAction(store, 'F占位')
    const rp = await focus.begin(p)
    await store.switchWorkspace('demo')
    expect(focus.sessions).toEqual([])
    expect(focus.running).toEqual({ workspace_id: 'personal', session_id: rp.session_id })
    const d = await taskWithAction(store, 'F演示被挡')
    const rd = await focus.begin(d)
    expect(rd.ok).toBe(false)
    expect(rd.code).toBe('ALREADY_ACTIVE')
  })
})

describe('F5-A store 信封反例：不给未知旧 ID 重新盖章', () => {
  it('未知裸 requestId 原样交服务验证 → REQUEST_ENVELOPE_REQUIRED，零新建', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F未知ID')
    const focus = useFocusStore()
    const r = await focus.begin({ taskId, actionId, requestId: 'unknown-old-id' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('REQUEST_ENVELOPE_REQUIRED')
    expect(r.issued_at_ms).toBeNull()
    expect(focus.sessions.length).toBe(0)
    expect((await allDocs()).records.filter((d) => d.kind === 'focus_session')).toHaveLength(0)
  })
  it('完整信封记录后超窗：缺时刻重试复用原签发时刻被拒，不静默续签成新请求', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const store = useAppStore()
      await store.init()
      const { taskId, actionId } = await taskWithAction(store, 'F超窗')
      const focus = useFocusStore()
      const env = focus.issueRequest('begin')
      const first = await focus.begin({ taskId, actionId, requestId: env.request_id, issuedAtMs: env.issued_at_ms })
      expect(first.ok).toBe(true)
      vi.setSystemTime(Date.now() + 600_001 + 1000)
      const retry = await focus.begin({ taskId, actionId, requestId: env.request_id })
      expect(retry.ok).toBe(false)
      expect(retry.code).toBe('STALE_REQUEST')
      expect(retry.issued_at_ms).toBe(env.issued_at_ms)
      expect(focus.sessions.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('刷新模拟（新 pinia/新服务实例，同一 IDB）：窗内裸旧 ID 凭台账 replay 不新建；过期原信封拒绝；新意图正常', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F刷新')
    const focus = useFocusStore()
    const env = focus.issueRequest('begin')
    const first = await focus.begin({ taskId, actionId, requestId: env.request_id, issuedAtMs: env.issued_at_ms })
    expect(first.ok).toBe(true)
    await focus.end({ sessionId: first.session_id, outcome: 'partial', draftMd: '稿' })
    focus.stop()
    setActivePinia(createPinia())
    const store2 = useAppStore()
    await store2.init()
    const focus2 = useFocusStore()
    // 窗内裸旧 ID：新实例内存无记录，服务凭台账验证 + 绑定匹配 → replay 原结果，不新建
    const bare = await focus2.begin({ taskId, actionId, requestId: env.request_id })
    expect(bare.replayed).toBe(true)
    expect(bare.session_id).toBe(first.session_id)
    expect(focus2.sessions.length).toBe(1)
    // 篡改签发时刻 → 拒绝
    const tampered = await focus2.begin({ taskId, actionId, requestId: env.request_id, issuedAtMs: env.issued_at_ms + 5 })
    expect(tampered.code).toBe('STALE_REQUEST')
    // 新用户意图（不带旧 ID）正常开始下一段
    const fresh = await focus2.begin({ taskId, actionId })
    expect(fresh.ok).toBe(true)
    expect(fresh.session_id).not.toBe(first.session_id)
    expect(focus2.sessions.length).toBe(2)
  })
})

describe('专注写入后 app.docs 同步（任务详情不读旧快照）', () => {
  it('begin 受阻任务后 store 状态立即 doing；end-done 后 store 行动完成且当前行动清空', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F同步')
    const t = store.tasks.find((x) => x.id === taskId)
    await putDoc({ ...t, status: 'blocked', current_action_id: actionId })
    await store.reload()
    expect(store.tasks.find((x) => x.id === taskId).status).toBe('blocked')

    const focus = useFocusStore()
    const r = await focus.begin({ taskId, actionId, confirmBlocked: true })
    expect(r.ok).toBe(true)
    // 回归：focus 独立事务改写任务后，app.docs 必须同步，否则任务详情仍按 blocked 二次确认。
    const afterBegin = store.tasks.find((x) => x.id === taskId)
    expect(afterBegin.status).toBe('doing')
    expect(store.currentActionOf(afterBegin).id).toBe(actionId)

    const ended = await focus.end({ sessionId: r.session_id, outcome: 'done', draftMd: '完成稿' })
    expect(ended.ok).toBe(true)
    expect(store.actionsOf(taskId)[0].done).toBe(true)
    expect(store.tasks.find((x) => x.id === taskId).current_action_id).toBeNull()
  })
})

describe('5A-2A 计划联动刷新（真实时钟；confirmDate=当前北京日期）', () => {
  it('partial/partial 计划结束 → app.docs 安排立即刷新（无 task/action 回执也刷新）', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F计划联动')
    const now = new Date()
    const date = beijingDateStr(now)
    const iso = now.toISOString()
    const plan = { id: 'p1', kind: 'plan_item', task_id: taskId, date, state: 'planned', action_text: '计划行动', planned_minutes: 30, actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', created_at: iso, updated_at: iso }
    await putDoc(plan)
    await store.reload()
    const task = store.tasks.find((t) => t.id === taskId)
    const action = store.actionsOf(taskId)[0]
    const focus = useFocusStore()
    const r = await focus.begin({ taskId, actionId, planItemId: 'p1', expected: planSnapshot(plan), facts: beginFactsOf(task, action, date) })
    expect(r.ok).toBe(true)
    expect(store.tasks.find((t) => t.id === taskId).status).toBe('doing')
    const ended = await focus.end({ sessionId: r.session_id, outcome: 'partial', draftMd: '计划稿', planProgress: 'partial', expected: planSnapshot(plan), historyConfirm: null })
    expect(ended.ok).toBe(true)
    expect(ended.planItem).toBeTruthy()
    // 回归：partial 结束不改 Task/Action，只改 PlanItem；app.docs 必须按 planItem 回执刷新。
    const p = store.docs.find((d) => d.id === 'p1')
    expect(p.state).toBe('partial')
    expect(p.actual_minutes).toBe(0)
    expect(p.focus_session_id).toBe(r.session_id)
  })
  it('成功 replay 只回摘要 → 也按归属重读 app.docs（外部修改可见）', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F回放刷新')
    const focus = useFocusStore()
    const env = focus.issueRequest('begin')
    const first = await focus.begin({ taskId, actionId, requestId: env.request_id, issuedAtMs: env.issued_at_ms })
    expect(first.ok).toBe(true)
    const t = store.tasks.find((x) => x.id === taskId)
    await putDoc({ ...t, title: '外部改题' })
    const retry = await focus.begin({ taskId, actionId, requestId: env.request_id })
    expect(retry.replayed).toBe(true)
    expect(store.tasks.find((x) => x.id === taskId).title).toBe('外部改题')
  })
})

// —— 5A-2A 输入快照整改复验 R5：真实 Pinia store 入口 + Vue 响应式确认输入 ——
// PlanEditor/PlanDetail 模式：确认基线存 ref(planSnapshot(...))，提交 expected=frozenExpected.value。
describe('R5 整改：响应式确认输入经真实 store 入口（真实时钟）', () => {
  it('ref expected + reactive facts 正常 begin/end；提交后改原 ref 不影响写入；换输入同 ID 拒绝', async () => {
    const store = useAppStore()
    await store.init()
    const { taskId, actionId } = await taskWithAction(store, 'F响应式入口')
    const now = new Date()
    const date = beijingDateStr(now)
    const iso = now.toISOString()
    const plan = { id: 'p-r5', kind: 'plan_item', task_id: taskId, date, state: 'planned', action_text: '计划行动', planned_minutes: 30, actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', created_at: iso, updated_at: iso }
    await putDoc(plan)
    await store.reload()
    const task = store.tasks.find((t) => t.id === taskId)
    const action = store.actionsOf(taskId)[0]
    const focus = useFocusStore()
    const expectedRef = ref(planSnapshot(plan))
    const facts = reactive(beginFactsOf(task, action, date))
    const env = focus.issueRequest('begin', { taskId, actionId })
    const input = { taskId, actionId, planItemId: 'p-r5', expected: expectedRef.value, facts, requestId: env.request_id, issuedAtMs: env.issued_at_ms }
    const pending = focus.begin(input) // 不 await：store.run 到服务调用前无 await，接纳同步快照
    expectedRef.value.planned_minutes = 999
    facts.actionText = '偷换的行动说明'
    const r = await pending
    expect(r.ok).toBe(true)
    expect(r.session.plan_item_id).toBe('p-r5')
    expect(r.session.action_id).toBe(actionId)
    // 突变后的响应式内容沿用同 ID → 拒绝（深快照指纹保护不回归）
    const mutated = await focus.begin({ ...input, expected: expectedRef.value, facts })
    expect(mutated.code).toBe('STALE_REQUEST')
    // end 同样走 ref 冻结快照（begin 不写 PlanItem，安排仍 planned）
    const ended = await focus.end({ sessionId: r.session_id, outcome: 'partial', draftMd: '响应式成果', planProgress: 'partial', expected: ref(planSnapshot(plan)).value, historyConfirm: null })
    expect(ended.ok).toBe(true)
    const p = store.docs.find((d) => d.id === 'p-r5')
    expect(p.state).toBe('partial')
    expect(p.actual_minutes).toBe(0)
  })
})