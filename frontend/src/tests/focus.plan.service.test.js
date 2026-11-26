// 5A-2A 服务层集成：fake-indexeddb + 受控时钟 + 手动调度器。协议依据：
// devlog/coordination/2026-11-23-阶段5A-2A本地协议与写集.md。
// 覆盖：计划 begin/end 事务提交、input_fp 同 ID 换输入拒绝、PLAN_SESSION_EXISTS 事务互斥、
// 结果透传（planItem/history/diffs/field）、失败注入整体回滚（E10）、恢复优先、旧台账兼容。
// 5A-2A 人工复审整改（R1–R3）：SAVE_FAILED 探测共用完整回执验证、首次接纳冻结输入指纹、
// begin 前历史前置核对。反例来源：devlog/coordination/2026-11-23-阶段5A-2A人工复审.md。
import { IDBFactory, IDBObjectStore, IDBDatabase } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, reactive } from 'vue'
import { beginFactsOf } from '../domains/focus'
import { planSnapshot, summarizePlanTime, historySignature } from '../domains/plan'
import { makeOpsRecord, opsId } from '../services/focus/runtime'

const T0 = '2026-11-20T10:00:00+08:00'
const T0MS = Date.parse(T0)
const at = (ms) => new Date(T0MS + ms).toISOString()

let db
let createFocusService
let nowIso
let ws
let scheduler
let svc

const manualScheduler = () => {
  const list = []
  return {
    list,
    set(fn, ms) { list.push({ fn, ms }); return list.length - 1 },
    clear(h) { list[h] = null },
    fire() { for (const j of list) if (j) j.fn() },
    active() { return list.filter(Boolean) },
  }
}

// 已适配调用端模拟：每个 requestId 首次调用创建信封，之后重试一律复用原信封。
const OPS = ['begin', 'checkpoint', 'pause', 'resume', 'end', 'saveDraft', 'recover', 'takeover', 'legacyEnd']
function envelopeCaller(service, clockMs) {
  const envs = new Map()
  const wrap = (op) => (input = {}) => {
    if (input.requestId != null && input.issuedAtMs == null) {
      if (!envs.has(input.requestId)) envs.set(input.requestId, clockMs())
      return service[op]({ ...input, issuedAtMs: envs.get(input.requestId) })
    }
    return service[op](input)
  }
  const wrapped = {
    raw: service, ownerId: service.ownerId, params: service.params,
    loadState: () => service.loadState(), stop: () => service.stop(),
    issueRequest: (op, input) => service.issueRequest(op, input),
  }
  for (const op of OPS) wrapped[op] = wrap(op)
  return wrapped
}

async function mkService(over = {}) {
  const service = createFocusService({
    getWorkspaceId: () => ws,
    ownerId: 'tab-1',
    wallNow: () => nowIso,
    newId: (() => { let n = 0; return () => `rid-${++n}` })(),
    scheduler,
    // 租约放宽到 10 分钟：本文件聚焦计划联动；恢复优先反例单独用默认参数。
    params: { LEASE_MS: 600_000 },
    ...over,
  })
  return envelopeCaller(service, () => Date.parse(nowIso))
}

const taskDoc = { id: 't1', kind: 'task', title: '周五交报告', status: 'todo', current_action_id: null, matter_id: null, note_ids: [], deadline: { value: '2026-11-27', precision: 'date' }, created_at: T0, updated_at: T0 }
const actionDoc = { id: 'a1', kind: 'action', task_id: 't1', text: '整理资料', minutes: 25, basis: 'user', done: false, created_at: T0 }
const planDoc = { id: 'p1', kind: 'plan_item', task_id: 't1', date: '2026-11-20', state: 'planned', action_text: '周一整理资料', planned_minutes: 30, actual_minutes: null, focus_session_id: null, order: 1, task_ref_state: 'active', created_at: T0, updated_at: T0 }

const seed = async () => {
  await db.putDoc({ ...taskDoc })
  await db.putDoc({ ...actionDoc })
  await db.putDoc({ ...planDoc })
}
const docs = async () => (await db.allDocs()).records
const runtime = async () => (await db.allFocusRuntime()).records
const docOf = async (id) => (await docs()).find((d) => d.id === id)
const sessions = async () => (await docs()).filter((d) => d.kind === 'focus_session')
const opsEntries = async () => ((await runtime()).find((r) => r.id === opsId('w1')) || { entries: [] }).entries

// 确认输入从当前库内事实构造（单一来源构造口，键序与指纹规范化一致）。
const confirmOf = async (over = {}) => {
  const t = await docOf('t1')
  const a = await docOf('a1')
  return { expected: planSnapshot(await docOf('p1')), facts: beginFactsOf(t, a, '2026-11-20'), ...over }
}
const beginInput = async (over = {}) => ({ taskId: 't1', actionId: 'a1', planItemId: 'p1', ...(await confirmOf()), ...over })
const endInput = async (sessionId, over = {}) => ({
  sessionId, outcome: 'partial', draftMd: '成果一',
  planProgress: 'partial', expected: planSnapshot(await docOf('p1')), historyConfirm: null, ...over,
})

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('../services/storage/db')
  ;({ createFocusService } = await import('../services/focus/service'))
  nowIso = T0
  ws = 'w1'
  db.configureWorkspace('w1')
  scheduler = manualScheduler()
  svc = await mkService()
})

describe('begin 计划联动与输入指纹', () => {
  it('完整确认 → 会话挂安排；台账带 input_fp；begin 不写 PlanItem', async () => {
    await seed()
    const r = await svc.begin(await beginInput({ requestId: 'b1' }))
    expect(r.ok).toBe(true)
    expect(r.session.plan_item_id).toBe('p1')
    expect(await docOf('p1')).toMatchObject({ state: 'planned', actual_minutes: null, focus_session_id: null })
    const entry = (await opsEntries()).find((e) => e.request_id === 'b1')
    expect(typeof entry.input_fp).toBe('string')
    expect(entry.result.ok).toBe(true)
    expect(scheduler.active()).toHaveLength(1)
  })
  it('同 requestId 同输入重试 → replay 原会话，不重复创建', async () => {
    await seed()
    const input = await beginInput({ requestId: 'b1' })
    const first = await svc.begin(input)
    const retry = await svc.begin(input)
    expect(retry.replayed).toBe(true)
    expect(retry.session_id).toBe(first.session_id)
    expect((await sessions()).length).toBe(1)
  })
  it('同 requestId 换确认事实/行动 → STALE_REQUEST，不新建也不按新输入执行', async () => {
    await seed()
    await db.putDoc({ id: 'a2', kind: 'action', task_id: 't1', text: '另一行动', minutes: 15, basis: 'user', done: false, created_at: T0 })
    const input = await beginInput({ requestId: 'b1' })
    const first = await svc.begin(input)
    expect(first.ok).toBe(true)
    const changedFacts = await svc.begin({ ...input, facts: { ...input.facts, actionMinutes: 45 } })
    expect(changedFacts.code).toBe('STALE_REQUEST')
    const changedAction = await svc.begin({ ...input, actionId: 'a2', facts: { ...input.facts, actionId: 'a2' } })
    expect(changedAction.code).toBe('STALE_REQUEST')
    expect((await sessions()).length).toBe(1)
    expect((await docOf('t1')).current_action_id).toBe('a1')
  })
  it('缺确认参数 → PLAN_CONFIRM_REQUIRED 零创建；新意图旧事实 → BEGIN_FACTS_CHANGED 带全部差异', async () => {
    await seed()
    const missing = await svc.begin({ taskId: 't1', actionId: 'a1', planItemId: 'p1', requestId: 'b-miss' })
    expect(missing.code).toBe('PLAN_CONFIRM_REQUIRED')
    expect((await sessions()).length).toBe(0)
    const stale = await confirmOf()
    await db.putDoc({ ...(await docOf('a1')), text: '换了行动文字', minutes: 45 })
    const changed = await svc.begin({ taskId: 't1', actionId: 'a1', planItemId: 'p1', ...stale, requestId: 'b-stale' })
    expect(changed.code).toBe('BEGIN_FACTS_CHANGED')
    expect(changed.diffs.map((d) => d.field).sort()).toEqual(['actionMinutes', 'actionText'])
    expect((await sessions()).length).toBe(0)
  })
  it('安排快照变化 → STALE_PLAN 透传首差异字段', async () => {
    await seed()
    const stale = await confirmOf()
    await db.putDoc({ ...(await docOf('p1')), planned_minutes: 60 })
    const r = await svc.begin({ taskId: 't1', actionId: 'a1', planItemId: 'p1', ...stale, requestId: 'b-plan' })
    expect(r.code).toBe('STALE_PLAN')
    expect(r.field).toBe('planned_minutes')
    expect((await sessions()).length).toBe(0)
  })
})

describe('同安排回到工作（事务内互斥）', () => {
  it('第二个 begin 不同 requestId → PLAN_SESSION_EXISTS 稳定会话 ID 零创建；其重试 replay', async () => {
    await seed()
    const first = await svc.begin(await beginInput({ requestId: 'b1' }))
    expect(first.ok).toBe(true)
    // 故意带旧确认事实：同安排未结束检查在事务内最先执行，先回会话再谈核对。
    const second = await svc.begin(await beginInput({ requestId: 'b2' }))
    expect(second.ok).toBe(false)
    expect(second.code).toBe('PLAN_SESSION_EXISTS')
    expect(second.samePlan).toBe(true)
    expect(second.session_id).toBe(first.session_id)
    expect(second.session.id).toBe(first.session_id)
    expect((await sessions()).length).toBe(1)
    const retry = await svc.begin(await beginInput({ requestId: 'b2' }))
    expect(retry.replayed).toBe(true)
    expect(retry.code).toBe('PLAN_SESSION_EXISTS')
    expect(retry.session_id).toBe(first.session_id)
    expect((await sessions()).length).toBe(1)
  })
})

describe('end 原子提交与结果透传', () => {
  it('partial/partial 结束 → 会话/正文/安排/运行位同事务；结果带 planItem/history', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const r = await svc.end(await endInput(b.session_id, { requestId: 'e1' }))
    expect(r.ok).toBe(true)
    expect(r.planItem).toMatchObject({ id: 'p1', state: 'partial', actual_minutes: 0, focus_session_id: b.session_id })
    expect(r.history.authoritative).toBe(true)
    const f = await docOf(b.session_id)
    expect(f.ended_at).toBe(at(40_000))
    expect(f.accumulated_ms).toBe(40_000)
    expect(f.draft_md).toBe('成果一')
    expect(f.running).toBe(false)
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 0, focus_session_id: b.session_id })
    expect((await runtime()).find((x) => x.id === 'run:w1').session_id).toBeNull()
    expect((await docOf('a1')).done).toBe(false)
    expect((await docOf('t1')).status).not.toBe('done')
    expect((await opsEntries()).find((e) => e.request_id === 'e1').input_fp).toBeTruthy()
    expect(scheduler.active()).toHaveLength(0)
  })
  it('同 end ID 换安排进度/正文 → STALE_REQUEST，数据库保持原提交', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    expect((await svc.end(input)).ok).toBe(true)
    const changedProgress = await svc.end({ ...input, planProgress: 'done' })
    expect(changedProgress.code).toBe('STALE_REQUEST')
    const changedBody = await svc.end({ ...input, draftMd: '改稿' })
    expect(changedBody.code).toBe('STALE_REQUEST')
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 0 })
    expect((await docOf(b.session_id)).draft_md).toBe('成果一')
    expect((await docOf('a1')).done).toBe(false)
  })
  it('同输入 end 重试 → replay 摘要，不重复累计/不重复写安排', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    const first = await svc.end(input)
    const retry = await svc.end(input)
    expect(retry.replayed).toBe(true)
    expect(retry.session_id).toBe(first.session_id)
    expect((await docOf(b.session_id)).accumulated_ms).toBe(40_000)
    expect(await docOf('p1')).toMatchObject({ actual_minutes: 0, focus_session_id: b.session_id })
    expect((await sessions()).length).toBe(1)
  })
  it('两段各 40s → 安排 actual_minutes=1，快捷指向最新段；历史确认按最新摘要', async () => {
    await seed()
    const b1 = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    expect((await svc.end(await endInput(b1.session_id, { requestId: 'e1' }))).ok).toBe(true)
    // 第二段：安排已 partial，确认快照/事实必须按最新库内事实重新冻结。
    const b2 = await svc.begin(await beginInput({ requestId: 'b2' }))
    expect(b2.ok).toBe(true)
    expect(b2.session_id).not.toBe(b1.session_id)
    nowIso = at(80_000)
    const history = summarizePlanTime(await docOf('p1'), await docs())
    const r2 = await svc.end(await endInput(b2.session_id, { requestId: 'e2', historyConfirm: historySignature(history) }))
    expect(r2.ok).toBe(true)
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 1, focus_session_id: b2.session_id })
    expect((await sessions()).length).toBe(2)
  })
  it('行动 done + 安排 partial → Action 完成、Task 不自动完成、安排仍 partial', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const r = await svc.end(await endInput(b.session_id, { requestId: 'e1', outcome: 'done' }))
    expect(r.ok).toBe(true)
    expect((await docOf('a1')).done).toBe(true)
    const t = await docOf('t1')
    expect(t.status).not.toBe('done')
    expect(t.current_action_id).toBeNull()
    expect(await docOf('p1')).toMatchObject({ state: 'partial' })
  })
  it('历史摘要变化 → HISTORY_CHANGED 透传对照；修正后新信封重试成功', async () => {
    await seed()
    const b1 = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    await svc.end(await endInput(b1.session_id, { requestId: 'e1' }))
    const b2 = await svc.begin(await beginInput({ requestId: 'b2' }))
    nowIso = at(80_000)
    const wrong = await svc.end(await endInput(b2.session_id, { requestId: 'e2', historyConfirm: { endedSessionIds: ['伪造'], totalMs: 1, actualMinutes: 0, latestEndedSessionId: '伪造' } }))
    expect(wrong.code).toBe('HISTORY_CHANGED')
    expect(wrong.current).toBeTruthy()
    expect(wrong.confirmed).toBeTruthy()
    expect((await docOf(b2.session_id)).ended_at).toBeNull()
    const history = summarizePlanTime(await docOf('p1'), await docs())
    const fixed = await svc.end(await endInput(b2.session_id, { requestId: 'e3', historyConfirm: historySignature(history) }))
    expect(fixed.ok).toBe(true)
    expect(await docOf('p1')).toMatchObject({ actual_minutes: 1 })
  })
})

describe('失败注入：整体回滚零半提交（E10）', () => {
  it('PlanItem 写入抛错 → SAVE_FAILED，会话/正文/安排/运行位/台账全部未动；同信封重试成功', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (this.name === 'docs' && value && value.id === 'p1' && value.kind === 'plan_item') throw new Error('注入：安排写入失败')
      return original.call(this, value, ...rest)
    }
    let failed
    try {
      failed = await svc.end(input)
    } finally {
      IDBObjectStore.prototype.put = original
    }
    expect(failed.ok).toBe(false)
    expect(failed.code).toBe('SAVE_FAILED')
    const f = await docOf(b.session_id)
    expect(f.running).toBe(true)
    expect(f.ended_at).toBeNull()
    expect(f.draft_md).toBe('')
    expect(f.accumulated_ms).toBe(0)
    expect(await docOf('p1')).toMatchObject({ state: 'planned', actual_minutes: null, focus_session_id: null })
    expect((await docOf('a1')).done).toBe(false)
    expect((await runtime()).find((x) => x.id === 'run:w1').session_id).toBe(b.session_id)
    expect((await opsEntries()).find((e) => e.request_id === 'e1')).toBeUndefined()
    const retry = await svc.end(input)
    expect(retry.ok).toBe(true)
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 0 })
    expect((await docOf(b.session_id)).ended_at).toBe(at(40_000))
  })
  it('台账写入抛错 → SAVE_FAILED，docs 同事务回滚；同信封重试成功', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (this.name === 'focus_runtime' && value && value.id === opsId('w1')) throw new Error('注入：台账写入失败')
      return original.call(this, value, ...rest)
    }
    let failed
    try {
      failed = await svc.end(input)
    } finally {
      IDBObjectStore.prototype.put = original
    }
    expect(failed.code).toBe('SAVE_FAILED')
    expect((await docOf(b.session_id)).ended_at).toBeNull()
    expect(await docOf('p1')).toMatchObject({ state: 'planned', actual_minutes: null })
    expect((await runtime()).find((x) => x.id === 'run:w1').session_id).toBe(b.session_id)
    const retry = await svc.end(input)
    expect(retry.ok).toBe(true)
    expect((await opsEntries()).find((e) => e.request_id === 'e1').result.ok).toBe(true)
  })
})

describe('恢复优先与旧台账兼容', () => {
  it('租约/间隙异常 → RECOVERY_REQUIRED 只写恢复元数据，安排不动；恢复后新信封结束成功', async () => {
    await seed()
    const strict = await mkService({ params: {} })
    try {
      const b = await strict.begin(await beginInput({ requestId: 'b1' }))
      expect(b.ok).toBe(true)
      nowIso = at(90_000) // 默认租约 30s、间隙阈值 60s：结算先发现异常
      const blocked = await strict.end(await endInput(b.session_id, { requestId: 'e1' }))
      expect(blocked.ok).toBe(false)
      expect(blocked.code).toBe('RECOVERY_REQUIRED')
      expect(blocked.recovery.reason).toBe('stale_gap')
      expect(await docOf('p1')).toMatchObject({ state: 'planned', actual_minutes: null })
      const f = await docOf(b.session_id)
      expect(f.running).toBe(true)
      expect(f.ended_at).toBeNull()
      expect((await runtime()).find((x) => x.id === `sess:${b.session_id}`).recovery).toBeTruthy()
      expect((await opsEntries()).find((e) => e.request_id === 'e1').result.ok).toBe(false)
      expect((await strict.recover({ sessionId: b.session_id, mode: 'keep', requestId: 'rc' })).ok).toBe(true)
      const ended = await strict.end(await endInput(b.session_id, { requestId: 'e2' }))
      expect(ended.ok).toBe(true)
      expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 0 })
    } finally {
      strict.stop()
    }
  })
  it('旧台账无指纹：计划确认输入无法验证即拒绝；纯无计划输入按原规则 replay（不伪造指纹）', async () => {
    await seed()
    const entry = {
      request_id: 'legacy-req', op: 'begin', workspace_id: 'w1', session_id: null,
      at_ms: T0MS, issued_at_ms: T0MS,
      result: { ok: true, code: null, session_id: 'ghost-sess', revision: 1, issued_at_ms: T0MS },
    }
    await db.transformFocusAtomic(() => ({ runtimePuts: [{ ...makeOpsRecord('w1'), entries: [entry] }] }))
    const planRetry = await svc.begin(await beginInput({ requestId: 'legacy-req', issuedAtMs: T0MS }))
    expect(planRetry.code).toBe('STALE_REQUEST')
    expect((await sessions()).length).toBe(0)
    // 纯无计划输入是另一份输入：同实例同 ID 会被 R2 指纹绑定拒绝（换输入必须新信封）；
    // 旧台账兼容的真实场景是刷新/跨实例后内存 issued 丢失，只凭台账验证——用新实例模拟。
    const sameInstPlain = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'legacy-req', issuedAtMs: T0MS })
    expect(sameInstPlain.code).toBe('STALE_REQUEST')
    const svc2 = await mkService()
    const plainRetry = await svc2.begin({ taskId: 't1', actionId: 'a1', requestId: 'legacy-req', issuedAtMs: T0MS })
    expect(plainRetry.replayed).toBe(true)
    expect(plainRetry.session_id).toBe('ghost-sess')
    expect((await sessions()).length).toBe(0)
    const kept = (await opsEntries()).find((e) => e.request_id === 'legacy-req')
    expect(kept.input_fp).toBeUndefined()
  })
  it('v0 有效计划关联 legacyEnd：缺确认零写入；带确认同事务写安排摘要，不升级版本不动 Action', async () => {
    await seed()
    await db.putDoc({ id: 'old-1', kind: 'focus_session', task_id: 't1', action_id: 'a1', plan_item_id: 'p1', started_at: T0, accumulated_ms: 60_000, running: true, draft_md: '旧草稿', outcome: null, blocker: null, ended_at: null, is_demo: false })
    const missing = await svc.legacyEnd({ sessionId: 'old-1', outcome: 'partial', requestId: 'le-miss' })
    expect(missing.code).toBe('PLAN_CONFIRM_REQUIRED')
    expect((await docOf('old-1')).ended_at).toBeNull()
    expect(await docOf('p1')).toMatchObject({ state: 'planned', actual_minutes: null })
    const r = await svc.legacyEnd({
      sessionId: 'old-1', outcome: 'partial', requestId: 'le1',
      planProgress: 'partial', expected: planSnapshot(await docOf('p1')), historyConfirm: null,
    })
    expect(r.ok).toBe(true)
    expect(r.planItem).toMatchObject({ state: 'partial', actual_minutes: 1, focus_session_id: 'old-1' })
    const f = await docOf('old-1')
    expect(f.ended_at).toBe(T0)
    expect(f.record_version).toBeUndefined()
    expect(f.task_snapshot).toBeUndefined()
    expect((await docOf('a1')).done).toBe(false)
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 1 })
  })
})

// —— 5A-2A 人工复审 R1 整改：SAVE_FAILED 回执探测与正常回放共用完整验证 ——
// 注入事务开启失败（readwrite 含 focus_runtime），迫使走 catch 探测分支；
// 探测用只读事务，单独控制是否一并失败。返回解除函数。
function injectTxOpenFailure(times = 1, modes = ['readwrite']) {
  const original = IDBDatabase.prototype.transaction
  let left = times
  IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
    const list = Array.isArray(names) ? names : [names]
    if (left > 0 && modes.includes(mode) && list.includes('focus_runtime')) {
      left -= 1
      throw new Error('注入：事务开启失败')
    }
    return original.call(this, names, mode, ...rest)
  }
  return () => { IDBDatabase.prototype.transaction = original }
}

describe('R1 整改：SAVE_FAILED 探测不得绕过输入绑定', () => {
  it('台账无条目：事务开启失败 → 保留 SAVE_FAILED；同信封原输入重试成功', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    const disarm = injectTxOpenFailure(1)
    let failed
    try { failed = await svc.end(input) } finally { disarm() }
    expect(failed.ok).toBe(false)
    expect(failed.code).toBe('SAVE_FAILED')
    expect((await docOf(b.session_id)).ended_at).toBeNull()
    expect((await opsEntries()).find((e) => e.request_id === 'e1')).toBeUndefined()
    const retry = await svc.end(input)
    expect(retry.ok).toBe(true)
    expect((await docOf(b.session_id)).ended_at).toBe(at(40_000))
  })
  it('台账有条目 + 同输入：事务开启失败 → 探测完整验证后正确回放，不重复累计', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    expect((await svc.end(input)).ok).toBe(true)
    const disarm = injectTxOpenFailure(1)
    let replay
    try { replay = await svc.end(input) } finally { disarm() }
    expect(replay.ok).toBe(true)
    expect(replay.replayed).toBe(true)
    expect(replay.session_id).toBe(b.session_id)
    expect((await docOf(b.session_id)).accumulated_ms).toBe(40_000)
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 0 })
    expect((await sessions()).length).toBe(1)
  })
  it('台账有条目 + 换正文/安排结果：探测拒绝 STALE_REQUEST，绝不返回旧成功（反例 review-end）', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    expect((await svc.end(input)).ok).toBe(true)
    // 同实例：排队前指纹绑定即拒绝（R2），不进事务。
    const sameInst = await svc.end({ ...input, draftMd: 'unsaved new text', planProgress: 'done' })
    expect(sameInst.ok).toBe(false)
    expect(sameInst.code).toBe('STALE_REQUEST')
    // 新实例（内存 issued 丢失）+ 事务开启失败：只能走探测分支，仍必须拒绝。
    const svc2 = await mkService()
    const disarm = injectTxOpenFailure(1)
    let probe
    try {
      probe = await svc2.end({ ...input, issuedAtMs: T0MS + 40_000, draftMd: 'unsaved new text', planProgress: 'done' })
    } finally { disarm() }
    expect(probe.ok).toBe(false)
    expect(probe.code).toBe('STALE_REQUEST')
    expect(probe.replayed).toBeUndefined()
    expect((await docOf(b.session_id)).draft_md).toBe('成果一')
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 0 })
  })
  it('换目标会话/换签发时刻：探测同样拒绝，不回放旧成功', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    expect((await svc.end(input)).ok).toBe(true)
    const svc2 = await mkService()
    const svc3 = await mkService()
    const disarm = injectTxOpenFailure(2)
    let wrongTarget, wrongStamp
    try {
      wrongTarget = await svc2.end({ ...input, issuedAtMs: T0MS + 40_000, sessionId: 'other-sess' })
      wrongStamp = await svc3.end({ ...input, issuedAtMs: T0MS + 40_001 })
    } finally { disarm() }
    expect(wrongTarget.code).toBe('STALE_REQUEST')
    expect(wrongStamp.code).toBe('STALE_REQUEST')
    expect((await docOf(b.session_id)).draft_md).toBe('成果一')
  })
  it('旧台账无指纹 + 计划确认输入：探测无法验证即拒绝（不伪造指纹）', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    const entry = {
      request_id: 'e-legacy', op: 'end', workspace_id: 'w1', session_id: b.session_id,
      at_ms: T0MS + 40_000, issued_at_ms: T0MS + 40_000,
      result: { ok: true, code: null, session_id: b.session_id, revision: 2, issued_at_ms: T0MS + 40_000 },
    }
    await db.transformFocusAtomic(() => ({ runtimePuts: [{ ...makeOpsRecord('w1'), entries: [entry] }] }))
    nowIso = at(40_000)
    const svc2 = await mkService()
    const disarm = injectTxOpenFailure(1)
    let r
    try {
      r = await svc2.end(await endInput(b.session_id, { requestId: 'e-legacy', issuedAtMs: T0MS + 40_000 }))
    } finally { disarm() }
    expect(r.ok).toBe(false)
    expect(r.code).toBe('STALE_REQUEST')
    expect((await docOf(b.session_id)).ended_at).toBeNull()
  })
  it('探测读取也失败 → 保留 SAVE_FAILED 与原信封重试语义', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    const disarm = injectTxOpenFailure(2, ['readwrite', 'readonly'])
    let failed
    try { failed = await svc.end(input) } finally { disarm() }
    expect(failed.ok).toBe(false)
    expect(failed.code).toBe('SAVE_FAILED')
    const retry = await svc.end(input)
    expect(retry.ok).toBe(true)
  })
  it('超出重试窗口：探测按签发时刻拒绝，不回放旧成功', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    expect((await svc.end(input)).ok).toBe(true)
    nowIso = at(700_000) // 窗口 600s：原签发时刻已超窗
    const svc2 = await mkService()
    const disarm = injectTxOpenFailure(1)
    let r
    try { r = await svc2.end({ ...input, issuedAtMs: T0MS + 40_000 }) } finally { disarm() }
    expect(r.ok).toBe(false)
    expect(r.code).toBe('STALE_REQUEST')
  })
})

describe('R2 整改：首次接纳即冻结输入，失败后同 ID 不得换内容', () => {
  const interceptSessionPut = () => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (this.name === 'docs' && value && value.kind === 'focus_session') throw new Error('注入：会话写入失败')
      return original.call(this, value, ...rest)
    }
    return () => { IDBObjectStore.prototype.put = original }
  }
  it('begin 首次会话写入失败 → 同 ID 换 Action/换安排被拒；原输入重试成功不重复创建', async () => {
    await seed()
    await db.putDoc({ id: 'a2', kind: 'action', task_id: 't1', text: '另一行动', minutes: 15, basis: 'user', done: false, created_at: T0 })
    await db.putDoc({ ...planDoc, id: 'p2', order: 2 })
    const input = await beginInput({ requestId: 'b1' })
    const disarm = interceptSessionPut()
    let failed
    try { failed = await svc.begin(input) } finally { disarm() }
    expect(failed.ok).toBe(false)
    expect(failed.code).toBe('SAVE_FAILED')
    expect((await sessions()).length).toBe(0)
    expect((await opsEntries()).find((e) => e.request_id === 'b1')).toBeUndefined()
    const changedAction = await svc.begin({ ...input, actionId: 'a2', facts: beginFactsOf(await docOf('t1'), await docOf('a2'), '2026-11-20') })
    expect(changedAction.ok).toBe(false)
    expect(changedAction.code).toBe('STALE_REQUEST')
    const changedPlan = await svc.begin({ ...input, planItemId: 'p2', expected: planSnapshot(await docOf('p2')) })
    expect(changedPlan.code).toBe('STALE_REQUEST')
    expect((await sessions()).length).toBe(0)
    const retry = await svc.begin(input)
    expect(retry.ok).toBe(true)
    expect(retry.session.action_id).toBe('a1')
    expect(retry.session.plan_item_id).toBe('p1')
    expect((await sessions()).length).toBe(1)
  })
  it('业务断言拒绝后同样绑定：同 ID 换输入被拒，新信封完整输入成功', async () => {
    await seed()
    const missing = await svc.begin({ taskId: 't1', actionId: 'a1', planItemId: 'p1', requestId: 'b1' })
    expect(missing.code).toBe('PLAN_CONFIRM_REQUIRED')
    const changed = await svc.begin(await beginInput({ requestId: 'b1' }))
    expect(changed.ok).toBe(false)
    expect(changed.code).toBe('STALE_REQUEST')
    expect((await sessions()).length).toBe(0)
    const fresh = await svc.begin(await beginInput({ requestId: 'b2' }))
    expect(fresh.ok).toBe(true)
  })
  it('end 首次失败 → 同 ID 换正文/planProgress 被拒；原输入重试成功', async () => {
    await seed()
    const b = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    const input = await endInput(b.session_id, { requestId: 'e1' })
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (this.name === 'docs' && value && value.id === 'p1' && value.kind === 'plan_item') throw new Error('注入：安排写入失败')
      return original.call(this, value, ...rest)
    }
    let failed
    try { failed = await svc.end(input) } finally { IDBObjectStore.prototype.put = original }
    expect(failed.code).toBe('SAVE_FAILED')
    const changedBody = await svc.end({ ...input, draftMd: '改稿' })
    expect(changedBody.ok).toBe(false)
    expect(changedBody.code).toBe('STALE_REQUEST')
    const changedProgress = await svc.end({ ...input, planProgress: 'done' })
    expect(changedProgress.code).toBe('STALE_REQUEST')
    expect((await docOf(b.session_id)).ended_at).toBeNull()
    const retry = await svc.end(input)
    expect(retry.ok).toBe(true)
    expect((await docOf(b.session_id)).draft_md).toBe('成果一')
    expect(await docOf('p1')).toMatchObject({ state: 'partial' })
  })
  it('issueRequest 部分参数不冻结指纹：首次完整输入接纳成功，此后同 ID 换输入被拒（WorkPage 兼容）', async () => {
    await seed()
    await db.putDoc({ id: 'a2', kind: 'action', task_id: 't1', text: '另一行动', minutes: 15, basis: 'user', done: false, created_at: T0 })
    const envelope = svc.issueRequest('begin', { taskId: 't1', actionId: 'a1' })
    const r = await svc.begin(await beginInput({ requestId: envelope.request_id, issuedAtMs: envelope.issued_at_ms }))
    expect(r.ok).toBe(true)
    const changed = await svc.begin({
      ...(await beginInput({ requestId: envelope.request_id, issuedAtMs: envelope.issued_at_ms })),
      actionId: 'a2', facts: beginFactsOf(await docOf('t1'), await docOf('a2'), '2026-11-20'),
    })
    expect(changed.ok).toBe(false)
    expect(changed.code).toBe('STALE_REQUEST')
    expect((await sessions()).length).toBe(1)
  })
})

describe('R3 整改：begin 前历史前置核对（服务透传）', () => {
  const endedPrev = (over = {}) => ({
    id: 'prev-1', kind: 'focus_session', task_id: 't1', action_id: 'a1', plan_item_id: 'p1',
    started_at: at(-60_000), accumulated_ms: 60_000, running: false, draft_md: '', outcome: 'partial',
    blocker: null, ended_at: at(0), is_demo: false, record_version: 1, ...over,
  })
  it('planned + 合法结束历史 → PLAN_REVIEW_REQUIRED 带摘要，零创建', async () => {
    await seed()
    await db.putDoc(endedPrev())
    const r = await svc.begin(await beginInput({ requestId: 'b1' }))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('PLAN_REVIEW_REQUIRED')
    expect(r.history).toMatchObject({ endedSessionIds: ['prev-1'], totalMs: 60_000, actualMinutes: 1, latestEndedSessionId: 'prev-1' })
    expect((await sessions()).length).toBe(1)
    expect(await docOf('p1')).toMatchObject({ state: 'planned', actual_minutes: null })
  })
  it('异常历史（-1）→ HISTORY_UNRESOLVED 带异常明细，零创建（不再拖到 end 才拒绝）', async () => {
    await seed()
    await db.putDoc(endedPrev({ accumulated_ms: -1 }))
    const r = await svc.begin(await beginInput({ requestId: 'b1' }))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('HISTORY_UNRESOLVED')
    expect(r.problems).toEqual([{ code: 'INVALID_DURATION', sessionId: 'prev-1', accumulatedMs: -1 }])
    expect((await sessions()).length).toBe(1)
  })
  it('partial + 合法权威历史 → 允许新段开始', async () => {
    await seed()
    await db.putDoc({ ...planDoc, state: 'partial', actual_minutes: 1, focus_session_id: 'prev-1' })
    await db.putDoc(endedPrev())
    const r = await svc.begin(await beginInput({ requestId: 'b1' }))
    expect(r.ok).toBe(true)
    expect(r.session.plan_item_id).toBe('p1')
    expect((await sessions()).length).toBe(2)
  })
})

// —— 5A-2A 整改复验 R4：只冻结指纹不够，排队命令实际读取的输入也必须是接纳时的深快照 ——
// 反例来源：devlog/coordination/2026-11-23-阶段5A-2A整改复验.md §3（调用后 await 前修改原对象）。
describe('R4 整改：接纳即深快照，指纹与执行同版', () => {
  it('begin 调用后立即改顶层 actionId 与嵌套 facts → 只执行调用时捕获版本', async () => {
    await seed()
    await db.putDoc({ id: 'a2', kind: 'action', task_id: 't1', text: '另一行动', minutes: 15, basis: 'user', done: false, created_at: T0 })
    const input = await beginInput({ requestId: 'b1' })
    const original = structuredClone(input)
    const pending = svc.begin(input) // 不 await：接纳同步完成，事务在微任务执行
    input.actionId = 'a2'
    input.facts.actionId = 'a2'
    input.facts.actionText = '另一行动'
    input.expected.planned_minutes = 999
    const r = await pending
    expect(r.ok).toBe(true)
    expect(r.session.action_id).toBe('a1')
    expect(r.session.plan_item_id).toBe('p1')
    expect((await docOf('t1')).current_action_id).toBe('a1')
    expect((await sessions()).length).toBe(1)
    // 原始输入副本同 ID 回放：与实际持久记录一致（不再指向被偷换的会话）
    const replay = await svc.begin(original)
    expect(replay.replayed).toBe(true)
    expect(replay.session_id).toBe(r.session_id)
    expect((await docOf(replay.session_id)).action_id).toBe('a1')
    // 修改后的输入沿用同 ID → 指纹不符拒绝
    const mutatedRetry = await svc.begin(input)
    expect(mutatedRetry.ok).toBe(false)
    expect(mutatedRetry.code).toBe('STALE_REQUEST')
    expect((await sessions()).length).toBe(1)
  })
  it('end 排队期间改 expected/historyConfirm 数组与正文/进度 → 事务核验与保存仍是捕获版本', async () => {
    await seed()
    const b1 = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    expect((await svc.end(await endInput(b1.session_id, { requestId: 'e1' }))).ok).toBe(true)
    const b2 = await svc.begin(await beginInput({ requestId: 'b2' }))
    nowIso = at(80_000)
    const history = historySignature(summarizePlanTime(await docOf('p1'), await docs()))
    const input = await endInput(b2.session_id, { requestId: 'e2', historyConfirm: history })
    const original = structuredClone(input)
    const pending = svc.end(input)
    input.draftMd = '被偷换的正文'
    input.planProgress = 'done'
    input.expected.planned_minutes = 999
    input.historyConfirm.endedSessionIds.push('ghost')
    input.historyConfirm.totalMs = 1
    const r = await pending
    expect(r.ok).toBe(true) // 若执行突变版本：STALE_PLAN/HISTORY_CHANGED 必拒
    expect((await docOf(b2.session_id)).draft_md).toBe('成果一')
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 1, focus_session_id: b2.session_id })
    const replay = await svc.end(original)
    expect(replay.replayed).toBe(true)
    expect(replay.session_id).toBe(b2.session_id)
    const mutatedRetry = await svc.end(input)
    expect(mutatedRetry.code).toBe('STALE_REQUEST')
    expect((await docOf(b2.session_id)).draft_md).toBe('成果一')
  })
  it('无计划 begin/end 同样深快照；服务分配 draftSeq 不入指纹不自身失配', async () => {
    await seed()
    const input = { taskId: 't1', actionId: 'a1', requestId: 'b-plain' }
    const pending = svc.begin(input)
    input.actionId = 'a-mutated'
    const r = await pending
    expect(r.ok).toBe(true)
    expect(r.session.action_id).toBe('a1')
    expect(r.session.plan_item_id).toBeNull()
    nowIso = at(5_000)
    const endIn = { sessionId: r.session_id, outcome: 'partial', draftMd: '原文', requestId: 'e-plain' }
    const endPending = svc.end(endIn)
    endIn.draftMd = '改稿'
    endIn.outcome = 'done'
    const ended = await endPending
    expect(ended.ok).toBe(true)
    expect((await docOf(r.session_id)).draft_md).toBe('原文')
    expect((await docOf(r.session_id)).outcome).toBe('partial')
    expect((await docOf('a1')).done).toBe(false)
    const retry = await svc.end({ sessionId: r.session_id, outcome: 'partial', draftMd: '原文', requestId: 'e-plain' })
    expect(retry.replayed).toBe(true)
  })
})

// —— 5A-2A 输入快照整改复验 R5：structuredClone 不能复制 Vue 响应式 Proxy ——
// 反例来源：devlog/coordination/2026-11-23-阶段5A-2A输入快照整改复验.md §2
// （PlanEditor/PlanDetail 确认基线存 ref，expected=ref(planSnapshot(...)).value 提交即 DataCloneError）。
// 修复：runOp 入口复用 db.snapshot（deepRaw 逐层脱代理后深克隆），R4 同版保护保留。
describe('R5 整改：响应式确认输入可快照，深快照保护不回归', () => {
  it('begin 嵌套 ref.value expected + reactive facts → 正常业务落库；提交后改原 ref 不影响写入', async () => {
    await seed()
    const confirm = await confirmOf()
    const expectedRef = ref(confirm.expected)
    const facts = reactive(confirm.facts)
    const input = { taskId: 't1', actionId: 'a1', planItemId: 'p1', expected: expectedRef.value, facts, requestId: 'b1' }
    const original = { taskId: 't1', actionId: 'a1', planItemId: 'p1', expected: structuredClone(confirm.expected), facts: structuredClone(confirm.facts), requestId: 'b1' }
    const pending = svc.begin(input) // 不 await：接纳同步快照，事务在微任务执行
    expectedRef.value.planned_minutes = 999
    facts.actionText = '偷换的行动说明'
    const r = await pending
    expect(r.ok).toBe(true)
    expect(r.session.action_id).toBe('a1')
    expect(r.session.plan_item_id).toBe('p1')
    expect((await sessions()).length).toBe(1)
    // 原始内容同 ID 回放一致；突变后的响应式内容沿用同 ID 仍被拒
    const replay = await svc.begin(original)
    expect(replay.replayed).toBe(true)
    expect(replay.session_id).toBe(r.session_id)
    const mutatedRetry = await svc.begin({ ...input, expected: expectedRef.value, facts })
    expect(mutatedRetry.code).toBe('STALE_REQUEST')
    expect((await sessions()).length).toBe(1)
  })
  it('end 响应式 historyConfirm 数组 + ref expected → 核验与保存是捕获版本', async () => {
    await seed()
    const b1 = await svc.begin(await beginInput({ requestId: 'b1' }))
    nowIso = at(40_000)
    expect((await svc.end(await endInput(b1.session_id, { requestId: 'e1' }))).ok).toBe(true)
    const b2 = await svc.begin(await beginInput({ requestId: 'b2' }))
    nowIso = at(80_000)
    const history = historySignature(summarizePlanTime(await docOf('p1'), await docs()))
    const historyConfirm = reactive(history)
    const expectedRaw = planSnapshot(await docOf('p1'))
    const expectedRef = ref(expectedRaw)
    const input = { sessionId: b2.session_id, outcome: 'partial', draftMd: '成果一', planProgress: 'partial', expected: expectedRef.value, historyConfirm, requestId: 'e2' }
    const original = { sessionId: b2.session_id, outcome: 'partial', draftMd: '成果一', planProgress: 'partial', expected: structuredClone(expectedRaw), historyConfirm: structuredClone(history), requestId: 'e2' }
    const pending = svc.end(input)
    historyConfirm.endedSessionIds.push('ghost')
    historyConfirm.totalMs = 1
    expectedRef.value.planned_minutes = 999
    input.draftMd = '被偷换的正文'
    const r = await pending
    expect(r.ok).toBe(true) // 若执行突变版本：STALE_PLAN/HISTORY_CHANGED 必拒
    expect((await docOf(b2.session_id)).draft_md).toBe('成果一')
    expect(await docOf('p1')).toMatchObject({ state: 'partial', actual_minutes: 1, focus_session_id: b2.session_id })
    const replay = await svc.end(original)
    expect(replay.replayed).toBe(true)
    const mutatedRetry = await svc.end(input)
    expect(mutatedRetry.code).toBe('STALE_REQUEST')
  })
  it('顶层 reactive 命令对象同样可快照（裸服务入口）', async () => {
    await seed()
    const r = await svc.raw.begin(reactive({ taskId: 't1', actionId: 'a1' }))
    expect(r.ok).toBe(true)
    expect(r.session.action_id).toBe('a1')
    expect(r.session.plan_item_id).toBeNull()
    expect((await sessions()).length).toBe(1)
  })
  it('确实无法复制的值 → 明确 INVALID_FIELD 输入错误，零写入零登记，不是 SAVE_FAILED', async () => {
    await seed()
    const bad = await beginInput({ requestId: 'b-bad' })
    bad.extra = () => {} // 函数无法结构化克隆
    const r = await svc.begin(bad)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVALID_FIELD')
    expect((await sessions()).length).toBe(0)
    expect((await opsEntries()).length).toBe(0)
    // 零登记：同 requestId 换纯数据重试不被幽灵绑定拦截
    const clean = { ...bad }
    delete clean.extra
    const retry = await svc.begin(clean)
    expect(retry.ok).toBe(true)
  })
})