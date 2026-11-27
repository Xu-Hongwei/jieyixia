// 5A-0 安排事务服务验收（§12 A05/A06/A13/A16/A18 的服务层证据）。
// fake-indexeddb + 受控时钟 + 确定性 ID；每用例全新 IDBFactory + 全新 db 模块实例。
// 核心标准：同次保存只一条、信封重试幂等、换输入/超窗/裸 ID 明确拒绝、失败整体回滚（计划+回执零残留）、
// plan_ops 独立命名空间不混 Focus run/session/ops、创建安排绝不产生 Focus 会话或回写 Task。
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { planOpsId, runId, opsId } from '@/services/focus/runtime'

const T0 = '2026-11-22T10:00:00+08:00'
const T0MS = Date.parse(T0)
let db, createPlanService, nowIso, ws, svc, ridc
const at = (ms) => new Date(T0MS + ms).toISOString()

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('@/services/storage/db')
  const mod = await import('@/services/plan/service')
  createPlanService = mod.createPlanService
  nowIso = T0
  ws = 'ws-1'
  ridc = 0
  db.configureWorkspace(ws)
  await db.putWorkspace({ id: ws, name: '虚构空间', is_demo: false })
  await db.putDoc({ id: 't1', kind: 'task', title: '写课程报告', status: 'todo', current_action_id: null, matter_id: null, note_ids: [], deadline: { value: '2026-11-27', precision: 'date' }, created_at: T0, updated_at: T0 })
  await db.putDoc({ id: 'a1', kind: 'action', task_id: 't1', text: '写引言', minutes: 30, basis: 'user', done: false, created_at: T0 })
  svc = mkService()
})

function mkService(over = {}) {
  return createPlanService({ getWorkspaceId: () => ws, wallNow: () => nowIso, newId: () => `rid-${++ridc}`, ...over })
}
const docs = async () => (await db.allDocs()).records
const runtime = async () => (await db.allFocusRuntime()).records
const planDocs = async () => (await docs()).filter((d) => d.kind === 'plan_item')
const planOps = async () => (await runtime()).find((r) => r.id === planOpsId(ws))
const baseInput = (over = {}) => ({ taskId: 't1', planItemId: 'p1', date: '2026-11-23', plannedMinutes: 60, actionText: '写引言', ...over })
// 完整信封：固定 requestId/issuedAtMs/planItemId，重试复用。
const envelope = (input, rid = 'req-1', issued = T0MS) => ({ ...input, requestId: rid, issuedAtMs: issued })

describe('A05 同次保存只一条 + 信封幂等/拒绝', () => {
  it('新任务和首条安排一起保存：截止风险确认前无残留，重复提交只创建一对', async () => {
    const deadline = '2026-11-24T15:35+08:00'
    const input = baseInput({ taskId: 't2', date: '2026-11-25', newTask: { title: '提交报告', deadline, matterId: null } })
    const rejected = await svc.create(envelope(input))
    expect(rejected.code).toBe('AFTER_DEADLINE_UNCONFIRMED')
    expect((await docs()).filter(d => d.id === 't2' || d.id === 'p1')).toHaveLength(0)

    const confirmed = envelope({ ...input, deadlineConfirm: { value: deadline, precision: 'datetime', planDate: input.date } }, 'confirmed')
    const [first, retry] = await Promise.all([svc.create(confirmed), svc.create(confirmed)])
    expect(first.ok && retry.ok).toBe(true)
    expect([first, retry].filter(r => r.replayed)).toHaveLength(1)
    const saved = await docs()
    expect(saved.find(d => d.id === 't2')).toMatchObject({ kind: 'task', title: '提交报告', deadline: { value: deadline } })
    expect(await planDocs()).toMatchObject([{ id: 'p1', task_id: 't2', date: input.date, action_text: input.actionText }])
  })
  it('双击并发同信封 → 恰好一条计划，第二次 replay', async () => {
    const input = envelope(baseInput())
    const [a, b] = await Promise.all([svc.create(input), svc.create(input)])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(b.replayed).toBe(true)
    expect(await planDocs()).toHaveLength(1)
    expect((await planDocs())[0].id).toBe('p1')
  })
  it('跨实例重试（新服务、同信封）→ replay 原结果，不重复创建', async () => {
    const input = envelope(baseInput())
    const first = await svc.create(input)
    expect(first.ok).toBe(true)
    const other = mkService() // 模拟另一标签/刷新后的新实例（issued 内存丢失）
    const retry = await other.create(input)
    expect(retry.ok).toBe(true)
    expect(retry.replayed).toBe(true)
    expect(retry.plan_item_id).toBe('p1')
    expect(await planDocs()).toHaveLength(1)
  })
  it('刷新后裸 requestId（无 issuedAtMs）凭台账 replay；台账无凭据 → REQUEST_ENVELOPE_REQUIRED', async () => {
    const input = envelope(baseInput())
    await svc.create(input)
    const fresh = mkService()
    const bare = await fresh.create({ ...baseInput(), requestId: 'req-1' }) // 无 issuedAtMs
    expect(bare.ok).toBe(true)
    expect(bare.replayed).toBe(true)
    const unknown = await fresh.create({ ...baseInput({ planItemId: 'pX' }), requestId: 'req-unknown' })
    expect(unknown.ok).toBe(false)
    expect(unknown.code).toBe('REQUEST_ENVELOPE_REQUIRED')
    expect(await planDocs()).toHaveLength(1)
  })
  it('同 requestId 换输入 → STALE_REQUEST，零写入', async () => {
    const input = envelope(baseInput())
    await svc.create(input)
    const changed = await svc.create(envelope(baseInput({ actionText: '改写说明' })))
    expect(changed.ok).toBe(false)
    expect(changed.code).toBe('STALE_REQUEST')
    expect(await planDocs()).toHaveLength(1)
    expect((await planDocs())[0].action_text).toBe('写引言')
  })
  it('同 requestId 换目标 ID / 换空间 → STALE_REQUEST', async () => {
    await svc.create(envelope(baseInput()))
    const otherTarget = await svc.create(envelope(baseInput({ planItemId: 'p2' })))
    expect(otherTarget.code).toBe('STALE_REQUEST')
    ws = 'ws-2'
    db.configureWorkspace(ws)
    const otherWs = await svc.create(envelope(baseInput()))
    expect(otherWs.code).toBe('STALE_REQUEST')
    expect(await planDocs()).toHaveLength(0) // ws-2 无写入
  })
  it('迟到超窗重试 → STALE_REQUEST，不因台账清理当新请求重执行', async () => {
    const input = envelope(baseInput())
    await svc.create(input)
    nowIso = at(700_000) // 超过 600s 窗口
    const late = await svc.create(input)
    expect(late.ok).toBe(false)
    expect(late.code).toBe('STALE_REQUEST')
    expect(await planDocs()).toHaveLength(1)
  })
  it('用户修改输入 = 新意图（新 requestId）→ 正常创建第二条', async () => {
    await svc.create(envelope(baseInput(), 'req-1'))
    const second = await svc.create(envelope(baseInput({ planItemId: 'p2', actionText: '写第二节' }), 'req-2'))
    expect(second.ok).toBe(true)
    expect(await planDocs()).toHaveLength(2)
  })
  it('issueRequest 预先固定新建 ID；日期固定进输入，不随后续时钟漂移', async () => {
    // 镜像 store：意图形成时先把缺省北京今天固定进输入，再签发信封（签名含 date）。
    const intent = { taskId: 't1', plannedMinutes: 30, actionText: '今天做', date: '2026-11-22' }
    const env = svc.issueRequest('create', intent)
    expect(env.plan_item_id).toBeTruthy()
    const input = { ...intent, planItemId: env.plan_item_id, requestId: env.request_id, issuedAtMs: env.issued_at_ms }
    const first = await svc.create(input)
    expect(first.ok).toBe(true)
    expect(first.plan_item_id).toBe(env.plan_item_id)
    expect((await planDocs())[0].date).toBe('2026-11-22') // 日期来自意图固定输入
  })
})

describe('A06 重复提醒经服务零写入；明确确认后新意图创建', () => {
  it('DUPLICATE_PLAN 零写入并带匹配 ID；确认后新信封创建第二条', async () => {
    await svc.create(envelope(baseInput(), 'req-1'))
    const dup = await svc.create(envelope(baseInput({ planItemId: 'p2' }), 'req-2'))
    expect(dup.ok).toBe(false)
    expect(dup.code).toBe('DUPLICATE_PLAN')
    expect(dup.matchingIds).toEqual(['p1'])
    expect(await planDocs()).toHaveLength(1)
    const confirmed = await svc.create(envelope(baseInput({ planItemId: 'p3', confirmedDuplicateIds: ['p1'] }), 'req-3'))
    expect(confirmed.ok).toBe(true)
    expect(await planDocs()).toHaveLength(2)
  })
  it('重复提醒重试同信封 → replay 同一提醒，不悄悄创建', async () => {
    await svc.create(envelope(baseInput(), 'req-1'))
    const dupInput = envelope(baseInput({ planItemId: 'p2' }), 'req-2')
    const a = await svc.create(dupInput)
    const b = await svc.create(dupInput)
    expect(a.code).toBe('DUPLICATE_PLAN')
    expect(b.code).toBe('DUPLICATE_PLAN')
    expect(b.replayed).toBe(true)
    expect(await planDocs()).toHaveLength(1)
  })
})

describe('A13 快照冲突 + 切空间世代保护 + 晚到结果归属', () => {
  it('旧快照编辑 → STALE_PLAN，零正文写入', async () => {
    await svc.create(envelope(baseInput(), 'req-1'))
    const p = (await planDocs())[0]
    // 另一页面先改了估时。
    await svc.edit(envelope({ planItemId: 'p1', expected: { task_id: 't1', date: p.date, state: 'planned', action_text: p.action_text, planned_minutes: 60, task_ref_state: 'active' }, plannedMinutes: 45 }, 'req-2'))
    // 本页仍拿旧快照（60）编辑 → 冲突。
    const stale = await svc.edit(envelope({ planItemId: 'p1', expected: { task_id: 't1', date: p.date, state: 'planned', action_text: p.action_text, planned_minutes: 60, task_ref_state: 'active' }, actionText: '本页改写' }, 'req-3'))
    expect(stale.ok).toBe(false)
    expect(stale.code).toBe('STALE_PLAN')
    expect((await planDocs())[0].action_text).toBe('写引言') // 未被旧页面覆盖
    expect((await planDocs())[0].planned_minutes).toBe(45)
  })
  it('排队期间切空间 → 拒绝且整体回滚，两个空间都无写入', async () => {
    const input = envelope(baseInput())
    const pending = svc.create(input)
    // 在事务执行前切换空间（世代递增）：捕获空间与落库空间不一致 → 必须拒绝，绝不跨空间写。
    ws = 'ws-2'
    db.configureWorkspace(ws)
    const res = await pending
    expect(res.ok).toBe(false)
    expect(['WORKSPACE_CHANGED', 'SAVE_FAILED', 'RELATION_INVALID']).toContain(res.code)
    expect(await planDocs()).toHaveLength(0) // ws-2 无写入
    db.configureWorkspace('ws-1')
    expect(await planDocs()).toHaveLength(0) // ws-1 也无残留
  })
  it('成功结果带原 workspace_id；晚到结果不污染新空间', async () => {
    const res = await svc.create(envelope(baseInput()))
    expect(res.workspace_id).toBe('ws-1')
    ws = 'ws-2'
    db.configureWorkspace(ws)
    expect(await planDocs()).toHaveLength(0) // 新空间看不到原空间计划
  })
})

describe('A16 并发原子失败：计划+回执整体回滚，原信封重试只一条', () => {
  function injectPutFailure(storeName) {
    const orig = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (this.name === storeName) throw new Error(`注入 ${storeName} 写入失败`)
      return orig.call(this, value, ...rest)
    }
    return () => { IDBObjectStore.prototype.put = orig }
  }
  it('docs 写入失败 → 无计划、无 plan_ops 回执；修复后原信封重试成功且只一条', async () => {
    const input = envelope(baseInput())
    const restore = injectPutFailure('docs')
    let res
    try { res = await svc.create(input) } finally { restore() }
    expect(res.ok).toBe(false)
    expect(await planDocs()).toHaveLength(0)
    const ops = await planOps()
    expect(ops ? ops.entries.length : 0).toBe(0)
    const retry = await svc.create(input)
    expect(retry.ok).toBe(true)
    expect(await planDocs()).toHaveLength(1)
    expect((await planOps()).entries).toHaveLength(1)
  })
  it('focus_runtime（回执）写入失败 → 已写计划一并撤销，零残留', async () => {
    const input = envelope(baseInput())
    const restore = injectPutFailure('focus_runtime')
    let res
    try { res = await svc.create(input) } finally { restore() }
    expect(res.ok).toBe(false)
    expect(await planDocs()).toHaveLength(0)
    expect(await planOps()).toBeUndefined()
    const retry = await svc.create(input)
    expect(retry.ok).toBe(true)
    expect(await planDocs()).toHaveLength(1)
  })
  it('业务拒绝（非法分钟）不清草稿、不改 Task、不留半条计划/半份回执', async () => {
    const before = (await docs()).find((d) => d.id === 't1')
    const res = await svc.create(envelope(baseInput({ plannedMinutes: 0 })))
    expect(res.ok).toBe(false)
    expect(res.code).toBe('INVALID_MINUTES')
    expect(await planDocs()).toHaveLength(0)
    expect((await docs()).find((d) => d.id === 't1')).toEqual(before)
  })
})

describe('A18 plan_ops 独立命名空间：不混 Focus、不产生会话、不回写 Task', () => {
  it('创建安排只写 plan_ops，绝不创建 focus_session / run / ops', async () => {
    const taskBefore = (await docs()).find((d) => d.id === 't1')
    const res = await svc.create(envelope(baseInput()))
    expect(res.ok).toBe(true)
    const rt = await runtime()
    expect(rt.some((r) => r.id === planOpsId(ws) && r.kind === 'plan_ops')).toBe(true)
    expect(rt.some((r) => r.kind === 'running')).toBe(false)
    expect(rt.some((r) => r.id === runId(ws))).toBe(false)
    expect(rt.some((r) => r.id === opsId(ws))).toBe(false)
    expect((await docs()).some((d) => d.kind === 'focus_session')).toBe(false)
    expect((await docs()).find((d) => d.id === 't1')).toEqual(taskBefore) // Task 原样
  })
  it('plan_ops 回执只存校验重放摘要，不含成果正文/原图', async () => {
    await svc.create(envelope(baseInput()))
    const ops = await planOps()
    const entry = ops.entries[0]
    expect(entry.op).toBe('create')
    expect(entry.plan_item_id).toBe('p1')
    expect(entry.input_sig).toBeTruthy()
    expect(entry.result.ok).toBe(true)
    // 回执不含计划正文对象本身（只摘要 + 必要 UI 事实）。
    expect(JSON.stringify(entry)).not.toContain('draft_md')
  })
  it('Focus 全局运行互斥扫描不受 plan_ops 干扰（kind 过滤）', async () => {
    await svc.create(envelope(baseInput()))
    const rt = await runtime()
    const running = rt.filter((r) => r.kind === 'running' && r.session_id)
    expect(running).toHaveLength(0)
    const sessions = rt.filter((r) => r.kind === 'session')
    expect(sessions).toHaveLength(0)
  })
})
