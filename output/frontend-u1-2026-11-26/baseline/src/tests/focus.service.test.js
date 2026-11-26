// S4 服务层单测：fake-indexeddb + 受控时钟 + 手动调度器（10s/30s/10min 都是注入参数）。
// 覆盖：原子提交、requestId 幂等 replay、草稿序号、STALE_REQUEST、台账清理、检查点调度、
// 队列串行、结束后旧保存拒绝、写入失败重试、提交后回调丢失按台账恢复、切空间拒绝。
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const T0 = '2026-11-20T10:00:00+08:00'
const T0MS = Date.parse(T0)
const at = (ms) => new Date(T0MS + ms).toISOString()

let db
let createFocusService
let nowIso
let ws
let timers
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

// 已适配调用端模拟（复验要求「调用端与 store 同步适配，失败重试保留原信封」）：
// 每个 requestId 首次调用创建信封（issuedAtMs=当时受控时钟），之后重试一律复用原信封。
// raw 暴露未包装的公开服务，供信封协议反例直接调用。
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
    ...over,
  })
  return envelopeCaller(service, () => Date.parse(nowIso))
}
const seed = async () => {
  await db.putDoc({ id: 't1', kind: 'task', title: '写课程报告', status: 'todo', current_action_id: null, matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' }, created_at: T0, updated_at: T0 })
  await db.putDoc({ id: 'a1', kind: 'action', task_id: 't1', text: '写引言一节', minutes: 30, basis: 'user', done: false, created_at: T0 })
}
const docs = async () => (await db.allDocs()).records
const runtime = async () => (await db.allFocusRuntime()).records
const sessionDoc = async (id) => (await docs()).find((d) => d.id === id)

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

describe('开始与幂等', () => {
  it('begin 原子提交：会话+任务+协调+运行位置+台账同事务落库', async () => {
    await seed()
    const res = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    expect(res.ok).toBe(true)
    expect(res.workspace_id).toBe('w1')
    expect(res.revision).toBe(1)
    expect(res.session.record_version).toBe(1)
    const d = await docs()
    expect(d.find((x) => x.id === 't1').status).toBe('doing')
    const rt = await runtime()
    expect(rt.find((r) => r.id === `sess:${res.session_id}`).owner_id).toBe('tab-1')
    expect(rt.find((r) => r.id === 'run:w1').session_id).toBe(res.session_id)
    expect(rt.find((r) => r.id === 'ops:w1').entries[0]).toMatchObject({ request_id: 'req-1', op: 'begin', result: { ok: true, revision: 1 } })
    expect(scheduler.active()).toHaveLength(1)
    expect(scheduler.active()[0].ms).toBe(10_000)
  })
  it('同 requestId 重试 → replay 原结果，不重复创建/累计', async () => {
    await seed()
    const first = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    const retry = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    expect(retry.replayed).toBe(true)
    expect(retry.session_id).toBe(first.session_id)
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(1)
    nowIso = at(10_000)
    const c1 = await svc.checkpoint({ sessionId: first.session_id, requestId: 'req-c' })
    const c2 = await svc.checkpoint({ sessionId: first.session_id, requestId: 'req-c' })
    expect(c1.ok).toBe(true)
    expect(c2.replayed).toBe(true)
    expect((await sessionDoc(first.session_id)).accumulated_ms).toBe(10_000)
  })
  it('结束后明确再次开始用新 requestId → 新会话；旧 requestId 仍 replay', async () => {
    await seed()
    const first = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    await svc.end({ sessionId: first.session_id, outcome: 'partial', draftMd: '稿', requestId: 'req-e' })
    const again = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-2' })
    expect(again.ok).toBe(true)
    expect(again.session_id).not.toBe(first.session_id)
    const old = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    expect(old.replayed).toBe(true)
    expect(old.session_id).toBe(first.session_id)
  })
  it('同 tick 两次不同 requestId 开始 → 队列串行，第二个 ALREADY_ACTIVE', async () => {
    await seed()
    const [r1, r2] = await Promise.all([
      svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'x1' }),
      svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'x2' }),
    ])
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1)
    expect([r1.code, r2.code]).toContain('ALREADY_ACTIVE')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(1)
  })
  it('超窗旧请求 STALE_REQUEST，不无条件重执行', async () => {
    await seed()
    const res = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'ancient', issuedAtMs: T0MS - 600_001 })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('STALE_REQUEST')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(0)
  })
  it('台账只存活重试窗口：超窗条目在下次事务顺带清理', async () => {
    await seed()
    const first = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    await svc.end({ sessionId: first.session_id, outcome: 'partial', draftMd: '稿', requestId: 'req-e' })
    nowIso = at(600_001 + 10_000)
    const again = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-new' })
    expect(again.ok).toBe(true)
    const ops = (await runtime()).find((r) => r.id === 'ops:w1')
    expect(ops.entries.map((e) => e.request_id)).toEqual(['req-new'])
  })
})

describe('草稿序号与队列串行', () => {
  it('连续保存序号递增；旧 requestId 重试 replay，不覆盖新正文', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    const s1 = await svc.saveDraft({ sessionId: b.session_id, draftMd: '第一版', requestId: 's1' })
    nowIso = at(5000)
    const s2 = await svc.saveDraft({ sessionId: b.session_id, draftMd: '第二版', requestId: 's2' })
    expect(s1.draft_seq).toBe(1)
    expect(s2.draft_seq).toBe(2)
    const late = await svc.saveDraft({ sessionId: b.session_id, draftMd: '第一版', requestId: 's1' })
    expect(late.replayed).toBe(true)
    const f = await sessionDoc(b.session_id)
    expect(f.draft_md).toBe('第二版')
    expect(f.accumulated_ms).toBe(5000) // s1 在 T0 结算 0，s2 结算 5s，replay 不再累计
  })
  it('同 tick 两个保存串行化：都落库且正文为后调用者', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    const [r1, r2] = await Promise.all([
      svc.saveDraft({ sessionId: b.session_id, draftMd: 'A', requestId: 'sa' }),
      svc.saveDraft({ sessionId: b.session_id, draftMd: 'B', requestId: 'sb' }),
    ])
    expect(r1.ok && r2.ok).toBe(true)
    const f = await sessionDoc(b.session_id)
    expect(f.draft_md).toBe('B')
    expect((await runtime()).find((r) => r.id === `sess:${b.session_id}`).draft_seq).toBe(2)
  })
  it('结束后排队的旧保存被 ALREADY_ENDED 拒绝，不复活历史', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    const [ended, saved] = await Promise.all([
      svc.end({ sessionId: b.session_id, outcome: 'done', draftMd: '最终稿', requestId: 'e' }),
      svc.saveDraft({ sessionId: b.session_id, draftMd: '迟到稿', requestId: 'late' }),
    ])
    expect(ended.ok).toBe(true)
    expect(saved.ok).toBe(false)
    expect(saved.code).toBe('ALREADY_ENDED')
    const f = await sessionDoc(b.session_id)
    expect(f.draft_md).toBe('最终稿')
    expect(f.outcome).toBe('done')
    expect((await docs()).find((d) => d.id === 'a1').done).toBe(true)
    expect((await docs()).find((d) => d.id === 't1').status).toBe('doing')
  })
  it('暂停合并最后草稿：同一事务保存+结算一次', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    nowIso = at(5000)
    const p = await svc.pause({ sessionId: b.session_id, draftMd: '暂停前最后输入', requestId: 'p' })
    expect(p.ok).toBe(true)
    const f = await sessionDoc(b.session_id)
    expect(f.draft_md).toBe('暂停前最后输入')
    expect(f.accumulated_ms).toBe(5000)
    expect(f.running).toBe(false)
    expect(p.draft_seq).toBe(1)
  })
})

describe('检查点调度（受控，不真实等待）', () => {
  it('运行中按 CHECKPOINT_MS 提交；暂停/结束停表；继续重新起表', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    expect(scheduler.active()).toHaveLength(1)
    nowIso = at(10_000)
    scheduler.fire()
    await vi.waitFor(async () => expect((await sessionDoc(b.session_id)).accumulated_ms).toBe(10_000))
    nowIso = at(20_000)
    scheduler.fire()
    await vi.waitFor(async () => expect((await sessionDoc(b.session_id)).accumulated_ms).toBe(20_000))
    await svc.pause({ sessionId: b.session_id, requestId: 'p' })
    expect(scheduler.active()).toHaveLength(0)
    nowIso = at(3_620_000)
    // 暂停超过租约：直接继续被拒，走受控重取（自我接管+恢复确认）后再继续
    expect((await svc.resume({ sessionId: b.session_id, requestId: 'r-expired' })).code).toBe('OWNER_CONFLICT')
    await svc.takeover({ sessionId: b.session_id, requestId: 'tk' })
    await svc.recover({ sessionId: b.session_id, mode: 'keep', requestId: 'rc' })
    await svc.resume({ sessionId: b.session_id, requestId: 'r' })
    expect(scheduler.active()).toHaveLength(1)
    nowIso = at(3_630_000)
    scheduler.fire()
    await vi.waitFor(async () => expect((await sessionDoc(b.session_id)).accumulated_ms).toBe(30_000))
    await svc.end({ sessionId: b.session_id, outcome: 'partial', draftMd: '稿', requestId: 'e' })
    expect(scheduler.active()).toHaveLength(0)
  })
  it('参数可注入：CHECKPOINT_MS/LEASE_MS 生效', async () => {
    const fast = await mkService({ params: { CHECKPOINT_MS: 500, LEASE_MS: 1000 } })
    await seed()
    const b = await fast.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    expect(scheduler.active()[0].ms).toBe(500)
    const rt = (await runtime()).find((r) => r.id === `sess:${b.session_id}`)
    expect(rt.lease_expires_at).toBe(T0MS + 1000)
    fast.stop()
  })
  it('检查点遇异常进入恢复 → 停表，恢复确认后继续计时', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    nowIso = at(400_000) // >5min 跳变
    scheduler.fire()
    await vi.waitFor(async () => expect((await runtime()).find((r) => r.id === `sess:${b.session_id}`).recovery).toBeTruthy())
    expect(scheduler.active()).toHaveLength(0)
    const rec = await svc.recover({ sessionId: b.session_id, mode: 'keep', requestId: 'rec' })
    expect(rec.ok).toBe(true)
    nowIso = at(410_000)
    const cp = await svc.checkpoint({ sessionId: b.session_id, requestId: 'cp' })
    expect(cp.ok).toBe(true)
    expect(cp.session.accumulated_ms).toBe(10_000)
  })
})

describe('S5 多标签协调：owner/epoch/租约/接管/恢复/v0 遗留', () => {
  it('有效租约下另一页面只读：计时/保存/暂停/结束/接管全部 OWNER_CONFLICT', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    const other = await mkService({ ownerId: 'tab-2' })
    const sid = b.session_id
    expect((await other.checkpoint({ sessionId: sid, requestId: 'o1' })).code).toBe('OWNER_CONFLICT')
    expect((await other.saveDraft({ sessionId: sid, draftMd: '抢写', requestId: 'o2' })).code).toBe('OWNER_CONFLICT')
    expect((await other.pause({ sessionId: sid, requestId: 'o3' })).code).toBe('OWNER_CONFLICT')
    expect((await other.end({ sessionId: sid, outcome: 'done', draftMd: '抢结束', requestId: 'o4' })).code).toBe('OWNER_CONFLICT')
    const tk = await other.takeover({ sessionId: sid, requestId: 'o5' })
    expect(tk.code).toBe('OWNER_CONFLICT')
    expect(tk.holder.owner_id).toBe('tab-1')
    const f = await sessionDoc(sid)
    expect(f.draft_md).toBe('')
    expect(f.running).toBe(true)
    other.stop()
  })
  it('租约过期接管：epoch+1 进入恢复；旧 owner 全拒；新 owner 恢复后继续计时', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    nowIso = at(10_000)
    await svc.checkpoint({ sessionId: b.session_id, requestId: 'c' })
    svc.stop() // 模拟原页面失联/关闭
    const other = await mkService({ ownerId: 'tab-2' })
    nowIso = at(40_001) // 检查点续租后租约至 40s，此刻已过期
    const tk = await other.takeover({ sessionId: b.session_id, requestId: 'tk' })
    expect(tk.ok).toBe(true)
    expect(tk.recovery.reason).toBe('takeover')
    expect(tk.recovery.pending_ms).toBe(30_001)
    const rt = (await runtime()).find((r) => r.id === `sess:${b.session_id}`)
    expect(rt.epoch).toBe(2)
    expect(rt.owner_id).toBe('tab-2')
    // 旧 owner（epoch 1）一切操作拒绝
    expect((await svc.checkpoint({ sessionId: b.session_id, epoch: 1, requestId: 'old1' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.saveDraft({ sessionId: b.session_id, draftMd: '旧页抢写', epoch: 1, requestId: 'old2' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.end({ sessionId: b.session_id, outcome: 'done', draftMd: 'x', epoch: 1, requestId: 'old3' })).code).toBe('OWNER_CONFLICT')
    // 恢复前新 owner 计时操作也拒绝
    expect((await other.checkpoint({ sessionId: b.session_id, requestId: 'pre' })).code).toBe('RECOVERY_REQUIRED')
    nowIso = at(41_000)
    const rec = await other.recover({ sessionId: b.session_id, mode: 'keep', requestId: 'rec' })
    expect(rec.ok).toBe(true)
    expect(rec.session.accumulated_ms).toBe(10_000) // 失联 30s 不自动计入
    expect(scheduler.active().length).toBeGreaterThanOrEqual(1) // 恢复后重新起表
    nowIso = at(51_000)
    const cp = await other.checkpoint({ sessionId: b.session_id, requestId: 'cp' })
    expect(cp.ok).toBe(true)
    expect(cp.session.accumulated_ms).toBe(20_000)
    other.stop()
  })
  it('刷新场景：新 owner 实例租约内只读，过期走接管+恢复', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    await svc.saveDraft({ sessionId: b.session_id, draftMd: '刷新前草稿', requestId: 's' })
    svc.stop()
    const refreshed = await mkService({ ownerId: 'tab-refresh' })
    const state = await refreshed.loadState()
    expect(state.sessions.find((r) => r.session_id === b.session_id).owner_id).toBe('tab-1')
    expect((await refreshed.saveDraft({ sessionId: b.session_id, draftMd: 'x', requestId: 'r1' })).code).toBe('OWNER_CONFLICT')
    nowIso = at(30_001)
    expect((await refreshed.takeover({ sessionId: b.session_id, requestId: 'r2' })).ok).toBe(true)
    const rec = await refreshed.recover({ sessionId: b.session_id, mode: 'keep', requestId: 'r3' })
    expect(rec.ok).toBe(true)
    expect((await sessionDoc(b.session_id)).draft_md).toBe('刷新前草稿')
    refreshed.stop()
  })
  it('stale_gap 异常：恢复前操作拒绝，correct 修正带 origin=user', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    nowIso = at(10_000)
    await svc.checkpoint({ sessionId: b.session_id, requestId: 'c' })
    nowIso = at(80_000) // 本段 70s：未超跳变阈值但距上次检查点 >60s
    const cp = await svc.checkpoint({ sessionId: b.session_id, requestId: 'c2' })
    expect(cp.ok).toBe(false)
    expect(cp.code).toBe('RECOVERY_REQUIRED')
    expect(cp.recovery.reason).toBe('stale_gap')
    expect((await svc.pause({ sessionId: b.session_id, requestId: 'p' })).code).toBe('RECOVERY_REQUIRED')
    const rec = await svc.recover({ sessionId: b.session_id, mode: 'correct', correctedMs: 15_000, requestId: 'rec' })
    expect(rec.ok).toBe(true)
    expect(rec.session.accumulated_ms).toBe(15_000)
    const rt = (await runtime()).find((r) => r.id === `sess:${b.session_id}`)
    expect(rt.last_recovery).toMatchObject({ mode: 'correct', origin: 'user', accumulated_ms: 15_000 })
  })
  it('全库运行唯一跨空间：w1 运行中 w2 不能开始；w1 暂停后 w2 可以', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    ws = 'w2'
    db.configureWorkspace('w2')
    await db.putDoc({ id: 't2', kind: 'task', title: '他空间任务', status: 'todo', current_action_id: null, matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' }, created_at: T0, updated_at: T0 })
    await db.putDoc({ id: 'a2', kind: 'action', task_id: 't2', text: '他空间行动', minutes: 20, basis: 'user', done: false, created_at: T0 })
    const denied = await svc.begin({ taskId: 't2', actionId: 'a2', requestId: 'b2' })
    expect(denied.code).toBe('ALREADY_ACTIVE')
    ws = 'w1'
    db.configureWorkspace('w1')
    await svc.pause({ sessionId: b.session_id, requestId: 'p' })
    ws = 'w2'
    db.configureWorkspace('w2')
    const ok = await svc.begin({ taskId: 't2', actionId: 'a2', requestId: 'b3' })
    expect(ok.ok).toBe(true)
    expect(ok.workspace_id).toBe('w2')
    expect((await runtime()).find((r) => r.id === 'run:w2').session_id).toBe(ok.session_id)
    expect((await runtime()).find((r) => r.id === 'run:w1').session_id).toBeNull()
  })
  it('v0 遗留：阻塞新开始，显式结束只改旧字段，随后可开 v1', async () => {
    await seed()
    await db.putDoc({ id: 'old-1', kind: 'focus_session', task_id: 't1', action_id: 'a1', started_at: T0, accumulated_ms: 60_000, running: true, draft_md: '旧草稿', outcome: null, blocker: null, ended_at: null, is_demo: false })
    const denied = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    expect(denied.code).toBe('LEGACY_RECOVERY_REQUIRED')
    expect(denied.session.id).toBe('old-1')
    const ended = await svc.legacyEnd({ sessionId: 'old-1', outcome: 'partial', requestId: 'le' })
    expect(ended.ok).toBe(true)
    const f = await sessionDoc('old-1')
    expect(f.ended_at).toBe(T0)
    expect(f.outcome).toBe('partial')
    expect(f.draft_md).toBe('旧草稿')
    expect('record_version' in f).toBe(false)
    expect('timer_anchor_at' in f).toBe(false)
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b2' })
    expect(b.ok).toBe(true)
    expect(b.session.record_version).toBe(1)
  })
})

describe('3B-1 复审 F1–F4 反例（公开服务入口，真实 fake-IDB 事务）', () => {
  it('F1：迟到旧草稿（不同 requestId、旧序号/旧修订）→ STALE_REVISION 且零正文写入', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    const newer = await svc.saveDraft({ sessionId: b.session_id, draftMd: '第二版：应保留的新成果', draftSeq: 2, expectedRevision: 1, requestId: 'newer' })
    expect(newer.ok).toBe(true)
    expect(newer.draft_seq).toBe(2)
    const older = await svc.saveDraft({ sessionId: b.session_id, draftMd: '第一版：迟到的旧成果', draftSeq: 1, expectedRevision: 1, requestId: 'older-late' })
    expect(older.ok).toBe(false)
    expect(older.code).toBe('STALE_REVISION')
    expect(older.currentSeq).toBe(2)
    expect((await sessionDoc(b.session_id)).draft_md).toBe('第二版：应保留的新成果')
    expect((await runtime()).find((r) => r.id === `sess:${b.session_id}`).draft_seq).toBe(2)
    // 同一提交重试仍幂等 replay；合法后续编辑（更大序号）正常保存
    const retry = await svc.saveDraft({ sessionId: b.session_id, draftMd: '第二版：应保留的新成果', draftSeq: 2, expectedRevision: 1, requestId: 'newer' })
    expect(retry.replayed).toBe(true)
    nowIso = at(5000)
    const third = await svc.saveDraft({ sessionId: b.session_id, draftMd: '第三版', draftSeq: 3, requestId: 'third' })
    expect(third.ok).toBe(true)
    expect((await sessionDoc(b.session_id)).draft_md).toBe('第三版')
  })
  it('F1：结束/暂停合并草稿同一版本前提——旧序号拒绝且不结束/不暂停，正文不动', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    await svc.saveDraft({ sessionId: b.session_id, draftMd: '新稿', draftSeq: 5, requestId: 's5' })
    const lateEnd = await svc.end({ sessionId: b.session_id, outcome: 'done', draftMd: '旧终稿', draftSeq: 2, requestId: 'e-old' })
    expect(lateEnd.code).toBe('STALE_REVISION')
    const latePause = await svc.pause({ sessionId: b.session_id, draftMd: '旧暂停稿', draftSeq: 1, requestId: 'p-old' })
    expect(latePause.code).toBe('STALE_REVISION')
    const f = await sessionDoc(b.session_id)
    expect(f.ended_at).toBeNull()
    expect(f.running).toBe(true)
    expect(f.draft_md).toBe('新稿')
    const okEnd = await svc.end({ sessionId: b.session_id, outcome: 'partial', draftMd: '合法终稿', draftSeq: 6, requestId: 'e-ok' })
    expect(okEnd.ok).toBe(true)
    expect((await sessionDoc(b.session_id)).draft_md).toBe('合法终稿')
  })
  it('F2：其它空间 v0 运行会话（无 runtime 元数据）挡住本空间开始；遗留原样，显式结束后可开', async () => {
    await seed()
    ws = 'demo'
    db.configureWorkspace('demo')
    await db.putDoc({ id: 'legacy-running', kind: 'focus_session', task_id: 'legacy-t', action_id: 'legacy-a', started_at: T0, accumulated_ms: 60_000, running: true, draft_md: '旧草稿', outcome: null, blocker: null, ended_at: null, is_demo: true })
    ws = 'w1'
    db.configureWorkspace('w1')
    const denied = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('LEGACY_RECOVERY_REQUIRED')
    expect(denied.session.id).toBe('legacy-running')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(0)
    ws = 'demo'
    db.configureWorkspace('demo')
    const legacy = (await docs()).find((d) => d.id === 'legacy-running')
    expect(legacy.running).toBe(true)
    expect(legacy.ended_at).toBeNull()
    expect(legacy.draft_md).toBe('旧草稿')
    expect((await svc.legacyEnd({ sessionId: 'legacy-running', outcome: 'partial', requestId: 'le' })).ok).toBe(true)
    ws = 'w1'
    db.configureWorkspace('w1')
    expect((await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b2' })).ok).toBe(true)
  })
  it('F2：其它空间 v1 运行会话缺 runtime 元数据同样挡住；改暂停后两空间共存', async () => {
    await seed()
    ws = 'w2'
    db.configureWorkspace('w2')
    await db.putDoc({ id: 'orphan-running', kind: 'focus_session', task_id: 't2', action_id: 'a2', started_at: T0, accumulated_ms: 0, running: true, draft_md: '', outcome: null, blocker: null, ended_at: null, is_demo: false, record_version: 1, timer_anchor_at: T0, task_ref_state: 'active', action_ref_state: 'active' })
    ws = 'w1'
    db.configureWorkspace('w1')
    const denied = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('ALREADY_ACTIVE')
    expect(denied.session.id).toBe('orphan-running')
    ws = 'w2'
    db.configureWorkspace('w2')
    const orphan = (await docs()).find((d) => d.id === 'orphan-running')
    await db.putDoc({ ...orphan, running: false, timer_anchor_at: null })
    ws = 'w1'
    db.configureWorkspace('w1')
    expect((await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b2' })).ok).toBe(true)
  })
  it('F3：租约过期原页——保存/检查点/暂停/继续/结束全拒，不累计不续租；受控重取后恢复写入', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    const sid = b.session_id
    nowIso = at(10_000)
    await svc.checkpoint({ sessionId: sid, requestId: 'c' }) // 租约续至 40s
    nowIso = at(45_000) // 已过期，但未到 60s stale_gap / 5min 跳变门槛
    const cp = await svc.checkpoint({ sessionId: sid, requestId: 'cp-late' })
    expect(cp.ok).toBe(false)
    expect(cp.code).toBe('OWNER_CONFLICT')
    expect(cp.leaseExpired).toBe(true)
    expect((await svc.saveDraft({ sessionId: sid, draftMd: '抢写', requestId: 's-late' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.pause({ sessionId: sid, requestId: 'p-late' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.resume({ sessionId: sid, requestId: 'r-late' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.end({ sessionId: sid, outcome: 'done', draftMd: '抢结束', requestId: 'e-late' })).code).toBe('OWNER_CONFLICT')
    const f = await sessionDoc(sid)
    expect(f.accumulated_ms).toBe(10_000)
    expect(f.draft_md).toBe('')
    expect(f.ended_at).toBeNull()
    const rt = (await runtime()).find((r) => r.id === `sess:${sid}`)
    expect(rt.lease_expires_at).toBe(T0MS + 40_000) // 未自行续租
    expect(rt.revision).toBe(2)
    // 受控重取：自我接管 epoch+1 → 恢复确认前仍拒 → keep 不自动计入失联段 → 写入恢复
    const tk = await svc.takeover({ sessionId: sid, requestId: 'tk' })
    expect(tk.ok).toBe(true)
    expect(tk.recovery.reason).toBe('takeover')
    expect((await svc.checkpoint({ sessionId: sid, requestId: 'pre' })).code).toBe('RECOVERY_REQUIRED')
    nowIso = at(46_000)
    const rec = await svc.recover({ sessionId: sid, mode: 'keep', requestId: 'rec' })
    expect(rec.ok).toBe(true)
    expect(rec.session.accumulated_ms).toBe(10_000)
    nowIso = at(56_000)
    const cp2 = await svc.checkpoint({ sessionId: sid, requestId: 'cp2' })
    expect(cp2.ok).toBe(true)
    expect(cp2.session.accumulated_ms).toBe(20_000)
  })
  it('F3：已被接管的旧页——五类写入全拒（显式旧 epoch 与服务缓存 epoch 都拒）', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    const sid = b.session_id
    svc.stop()
    const other = await mkService({ ownerId: 'tab-2' })
    nowIso = at(30_001)
    expect((await other.takeover({ sessionId: sid, requestId: 'tk' })).ok).toBe(true)
    expect((await svc.checkpoint({ sessionId: sid, epoch: 1, requestId: 'o1' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.saveDraft({ sessionId: sid, draftMd: 'x', epoch: 1, requestId: 'o2' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.pause({ sessionId: sid, epoch: 1, requestId: 'o3' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.resume({ sessionId: sid, epoch: 1, requestId: 'o4' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.end({ sessionId: sid, outcome: 'done', draftMd: 'x', epoch: 1, requestId: 'o5' })).code).toBe('OWNER_CONFLICT')
    expect((await svc.checkpoint({ sessionId: sid, requestId: 'o6' })).code).toBe('OWNER_CONFLICT')
    const f = await sessionDoc(sid)
    expect(f.accumulated_ms).toBe(0)
    expect(f.draft_md).toBe('')
    other.stop()
  })
  it('F4：首调不传 issuedAtMs，超窗+台账清理后重放 → STALE_REQUEST，不重建会话', async () => {
    await seed()
    const first = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'original-begin' })
    expect(first.ok).toBe(true)
    expect(first.issued_at_ms).toBe(T0MS)
    await svc.end({ sessionId: first.session_id, outcome: 'partial', draftMd: '稿', requestId: 'original-end' })
    nowIso = at(30_000)
    const mid = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'mid-begin' })
    await svc.end({ sessionId: mid.session_id, outcome: 'partial', draftMd: '稿', requestId: 'mid-end' })
    nowIso = at(610_001)
    const fresh = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'fresh-begin' })
    expect(fresh.ok).toBe(true)
    await svc.end({ sessionId: fresh.session_id, outcome: 'partial', draftMd: '稿', requestId: 'fresh-end' })
    const again = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'original-begin' })
    expect(again.ok).toBe(false)
    expect(again.code).toBe('STALE_REQUEST')
    const again2 = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'original-begin' })
    expect(again2.code).toBe('STALE_REQUEST')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(3)
    expect((await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'new-explicit' })).ok).toBe(true)
  })
  it('F4：墓碑跨实例持久——另一页面实例重放过期请求同样拒绝', async () => {
    await seed()
    const first = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'x-begin' })
    await svc.end({ sessionId: first.session_id, outcome: 'partial', draftMd: '稿', requestId: 'x-end' })
    nowIso = at(610_001)
    const other = await mkService({ ownerId: 'tab-2', newId: (() => { let n = 0; return () => `other-${++n}` })() })
    const flush = await other.begin({ taskId: 't1', actionId: 'a1', requestId: 'flush' })
    expect(flush.ok).toBe(true)
    await other.end({ sessionId: flush.session_id, outcome: 'partial', draftMd: '稿', requestId: 'flush-end' })
    const replay = await other.begin({ taskId: 't1', actionId: 'a1', requestId: 'x-begin' })
    expect(replay.ok).toBe(false)
    expect(replay.code).toBe('STALE_REQUEST')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(2)
    other.stop()
  })
  it('F4：requestId 绑定 op/空间/会话——跨操作/跨会话/跨空间复用拒绝', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'bound' })
    const misuse = await svc.saveDraft({ sessionId: b.session_id, draftMd: 'x', requestId: 'bound' })
    expect(misuse.code).toBe('STALE_REQUEST')
    expect((await sessionDoc(b.session_id)).draft_md).toBe('')
    expect((await svc.checkpoint({ sessionId: b.session_id, requestId: 'cp-bound' })).ok).toBe(true)
    expect((await svc.checkpoint({ sessionId: 'no-such', requestId: 'cp-bound' })).code).toBe('STALE_REQUEST')
    ws = 'w2'
    db.configureWorkspace('w2')
    expect((await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'bound' })).code).toBe('STALE_REQUEST')
    ws = 'w1'
    db.configureWorkspace('w1')
  })
})

describe('F5 信封协议反例（原始公开服务入口：淘汰/实例重建/缺签发信息）', () => {
  it('窗口内裸 requestId 重试凭台账 replay；未知裸 requestId 明确拒绝，不默认成新请求', async () => {
    await seed()
    const raw = svc.raw
    const first = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'w1', issuedAtMs: T0MS })
    expect(first.ok).toBe(true)
    const bareRetry = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'w1' })
    expect(bareRetry.replayed).toBe(true)
    expect(bareRetry.session_id).toBe(first.session_id)
    const unknown = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'never-seen' })
    expect(unknown.ok).toBe(false)
    expect(unknown.code).toBe('REQUEST_ENVELOPE_REQUIRED')
    expect(unknown.issued_at_ms).toBeNull()
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(1)
    for (const bad of [0, -5, 1.5, 'x']) {
      expect((await raw.begin({ taskId: 't1', actionId: 'a1', requestId: `bad-${bad}`, issuedAtMs: bad })).code).toBe('RELATION_INVALID')
    }
  })
  it('issueRequest 信封：首用成功、重试 replay、篡改签发时刻拒绝、超窗拒绝', async () => {
    await seed()
    const raw = svc.raw
    const env = raw.issueRequest('begin')
    expect(env.request_id).toBeTruthy()
    expect(env.issued_at_ms).toBe(T0MS)
    expect((await raw.saveDraft({ sessionId: 'x', draftMd: 'x', requestId: env.request_id, issuedAtMs: env.issued_at_ms })).code).toBe('STALE_REQUEST')
    const first = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: env.request_id, issuedAtMs: env.issued_at_ms })
    expect(first.ok).toBe(true)
    expect((await raw.begin({ taskId: 't1', actionId: 'a1', requestId: env.request_id, issuedAtMs: env.issued_at_ms + 5 })).code).toBe('STALE_REQUEST')
    const retry = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: env.request_id, issuedAtMs: env.issued_at_ms })
    expect(retry.replayed).toBe(true)
    nowIso = at(600_001)
    expect((await raw.begin({ taskId: 't1', actionId: 'a1', requestId: env.request_id, issuedAtMs: env.issued_at_ms })).code).toBe('STALE_REQUEST')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(1)
  })
  it('≥201 条墓碑淘汰后：裸旧 ID 与原信封都不新建会话；实例重建后仍拒；新信封正常下一段', async () => {
    await seed()
    const raw = svc.raw
    const original = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'original-begin', issuedAtMs: T0MS })
    expect(original.ok).toBe(true)
    await raw.end({ sessionId: original.session_id, outcome: 'partial', draftMd: '第一段成果', requestId: 'original-end', issuedAtMs: T0MS })
    // 102 轮正常开始/结束（每轮新信封、时钟推进 610001ms 触发清理），只用公开服务产生淘汰
    for (let i = 0; i < 102; i++) {
      nowIso = at(610_001 * (i + 1))
      const ms = Date.parse(nowIso)
      const begun = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: `cycle-${i}-begin`, issuedAtMs: ms })
      expect(begun.ok).toBe(true)
      const ended = await raw.end({ sessionId: begun.session_id, outcome: 'partial', draftMd: `成果 ${i}`, requestId: `cycle-${i}-end`, issuedAtMs: ms })
      expect(ended.ok).toBe(true)
    }
    const ops = (await runtime()).find((r) => r.id === 'ops:w1')
    expect(ops.stale).toHaveLength(200)
    expect(ops.stale.some((t) => t.request_id === 'original-begin')).toBe(false)
    const sessionsBefore = (await docs()).filter((d) => d.kind === 'focus_session').length
    expect(sessionsBefore).toBe(103)
    // 淘汰后：裸旧 ID 不可验证 → 明确拒绝；原信封超窗 → STALE_REQUEST；都不新建
    const bare = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'original-begin' })
    expect(bare.ok).toBe(false)
    expect(bare.code).toBe('REQUEST_ENVELOPE_REQUIRED')
    const stamped = await raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'original-begin', issuedAtMs: T0MS })
    expect(stamped.ok).toBe(false)
    expect(stamped.code).toBe('STALE_REQUEST')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(103)
    // 实例重建（内存签发记录全丢）：原信封仍拒、裸旧 ID 仍拒、缺签发信息不默认成刚刚签发
    const rebuilt = await mkService({ ownerId: 'tab-rebuild', newId: (() => { let n = 0; return () => `rb-${++n}` })() })
    expect((await rebuilt.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'original-begin', issuedAtMs: T0MS })).code).toBe('STALE_REQUEST')
    expect((await rebuilt.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'original-begin' })).code).toBe('REQUEST_ENVELOPE_REQUIRED')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(103)
    // 用户明确再次开始：新信封正常生成下一段
    const freshEnv = rebuilt.raw.issueRequest('begin')
    const fresh = await rebuilt.raw.begin({ taskId: 't1', actionId: 'a1', requestId: freshEnv.request_id, issuedAtMs: freshEnv.issued_at_ms })
    expect(fresh.ok).toBe(true)
    expect(fresh.session_id).not.toBe(original.session_id)
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(104)
    rebuilt.stop()
  }, 20_000)
})

describe('F5-B 台账 replay 绑定反例（跨实例错绑/缺绑定，两条重放分支一致）', () => {
  const rebuild = () => mkService({ ownerId: 'tab-rebuild', newId: (() => { let n = 0; return () => `rb2-${++n}` })() })
  it('跨实例正确同信封重试仍 replay 原结果（begin 与 saveDraft），不重复创建', async () => {
    await seed()
    const b = await svc.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'b-env', issuedAtMs: T0MS })
    expect(b.ok).toBe(true)
    const s = await svc.raw.saveDraft({ sessionId: b.session_id, draftMd: '第一版', requestId: 's-env', issuedAtMs: T0MS })
    expect(s.ok).toBe(true)
    svc.stop()
    const rebuilt = await rebuild()
    const rb = await rebuilt.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'b-env', issuedAtMs: T0MS })
    expect(rb.replayed).toBe(true)
    expect(rb.session_id).toBe(b.session_id)
    const rs = await rebuilt.raw.saveDraft({ sessionId: b.session_id, draftMd: '第一版', requestId: 's-env', issuedAtMs: T0MS })
    expect(rs.replayed).toBe(true)
    expect((await sessionDoc(b.session_id)).draft_md).toBe('第一版')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(1)
    // 裸 ID 跨实例重试：台账担保 + 绑定匹配 → 同样 replay
    const bare = await rebuilt.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'b-env' })
    expect(bare.replayed).toBe(true)
    expect(bare.session_id).toBe(b.session_id)
    rebuilt.stop()
  })
  it('实例重建后 begin 信封用于 end → STALE_REQUEST，会话仍运行未结束（带时刻与裸 ID 两分支一致）', async () => {
    await seed()
    const b = await svc.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'b1', issuedAtMs: T0MS })
    svc.stop()
    const rebuilt = await rebuild()
    const misEnd = await rebuilt.raw.end({ sessionId: b.session_id, outcome: 'done', draftMd: '冒用结束', requestId: 'b1', issuedAtMs: T0MS })
    expect(misEnd.ok).toBe(false)
    expect(misEnd.code).toBe('STALE_REQUEST')
    const bareEnd = await rebuilt.raw.end({ sessionId: b.session_id, outcome: 'done', draftMd: '冒用结束', requestId: 'b1' })
    expect(bareEnd.ok).toBe(false)
    expect(bareEnd.code).toBe('STALE_REQUEST')
    const f = await sessionDoc(b.session_id)
    expect(f.running).toBe(true)
    expect(f.ended_at).toBeNull()
    expect(f.draft_md).toBe('')
    expect((await docs()).find((d) => d.id === 'a1').done).toBe(false)
    rebuilt.stop()
  })
  it('实例重建后会话 A 的 saveDraft ID 用于会话 B → 拒绝，两会话正文都不动', async () => {
    await seed()
    const a = await svc.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'ba', issuedAtMs: T0MS })
    await svc.raw.saveDraft({ sessionId: a.session_id, draftMd: 'A 的成果', requestId: 'sa', issuedAtMs: T0MS })
    await svc.raw.end({ sessionId: a.session_id, outcome: 'partial', draftMd: 'A 的成果', requestId: 'ea', issuedAtMs: T0MS })
    const b = await svc.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'bb', issuedAtMs: T0MS })
    svc.stop()
    const rebuilt = await rebuild()
    const cross = await rebuilt.raw.saveDraft({ sessionId: b.session_id, draftMd: '抢写 B', requestId: 'sa', issuedAtMs: T0MS })
    expect(cross.ok).toBe(false)
    expect(cross.code).toBe('STALE_REQUEST')
    const bareCross = await rebuilt.raw.saveDraft({ sessionId: b.session_id, draftMd: '抢写 B', requestId: 'sa' })
    expect(bareCross.code).toBe('STALE_REQUEST')
    expect((await sessionDoc(b.session_id)).draft_md).toBe('')
    expect((await sessionDoc(a.session_id)).draft_md).toBe('A 的成果')
    rebuilt.stop()
  })
  it('跨实例信封签发时刻与台账不一致 → STALE_REQUEST，不 replay', async () => {
    await seed()
    const b = await svc.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'b-t', issuedAtMs: T0MS })
    svc.stop()
    const rebuilt = await rebuild()
    const tampered = await rebuilt.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'b-t', issuedAtMs: T0MS + 5 })
    expect(tampered.ok).toBe(false)
    expect(tampered.code).toBe('STALE_REQUEST')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(1)
    rebuilt.stop()
  })
  it('老台账缺操作/会话绑定 → 无法验证即拒绝（两分支），不推定匹配', async () => {
    await seed()
    const b = await svc.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'legacy-req', issuedAtMs: T0MS })
    // 伪造老形状台账条目：只剩 request_id/at_ms/result（缺 op/session_id/issued_at_ms）
    await db.transformFocusAtomic((latest, runtime) => {
      const ops = runtime.find((r) => r.id === 'ops:w1')
      const entries = ops.entries.map((e) => e.request_id === 'legacy-req'
        ? { request_id: e.request_id, at_ms: e.at_ms, result: e.result }
        : e)
      return { runtimePuts: [{ ...ops, entries }] }
    })
    svc.stop()
    const rebuilt = await rebuild()
    const stamped = await rebuilt.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'legacy-req', issuedAtMs: T0MS })
    expect(stamped.ok).toBe(false)
    expect(stamped.code).toBe('STALE_REQUEST')
    const bare = await rebuilt.raw.begin({ taskId: 't1', actionId: 'a1', requestId: 'legacy-req' })
    expect(bare.ok).toBe(false)
    expect(bare.code).toBe('STALE_REQUEST')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(1)
    rebuilt.stop()
  })
})

describe('失败与恢复路径', () => {
  it('写入失败 SAVE_FAILED：数据原样，同 requestId 重试成功且不重复', async () => {
    await seed()
    const origPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (value && value.kind === 'focus_session') throw new Error('注入写入失败')
      return origPut.call(this, value, ...rest)
    }
    let failed
    try {
      failed = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    } finally {
      IDBObjectStore.prototype.put = origPut
    }
    expect(failed.ok).toBe(false)
    expect(failed.code).toBe('SAVE_FAILED')
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(0)
    const retry = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    expect(retry.ok).toBe(true)
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(1)
  })
  it('事务已提交但回调丢失：按 requestId 从台账读回原结果，不重新创建', async () => {
    await seed()
    const origTx = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
      const t = origTx.call(this, stores, mode, ...rest)
      const isFocusWrite = mode === 'readwrite' && Array.isArray(stores) && stores.includes('focus_runtime')
      if (!isFocusWrite) return t
      let complete = null
      let error = null
      Object.defineProperty(t, 'oncomplete', {
        configurable: true,
        get: () => complete && ((...a) => { if (error) error(...a); complete(...a) }),
        set: (fn) => { complete = fn },
      })
      Object.defineProperty(t, 'onerror', { configurable: true, get: () => error, set: (fn) => { error = fn } })
      return t
    }
    let res
    try {
      res = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    } finally {
      IDBDatabase.prototype.transaction = origTx
    }
    expect(res.ok).toBe(true)
    expect(res.replayed).toBe(true)
    expect(res.session_id).toBeTruthy()
    const all = await docs()
    expect(all.filter((d) => d.kind === 'focus_session')).toHaveLength(1)
    // 回种后检查点可用（epoch 已知）
    nowIso = at(10_000)
    const cp = await svc.checkpoint({ sessionId: res.session_id, requestId: 'cp' })
    expect(cp.ok).toBe(true)
    expect(cp.session.accumulated_ms).toBe(10_000)
  })
  it('排队期间切空间 → WORKSPACE_CHANGED，不写进新空间', async () => {
    await seed()
    const orig = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args) {
      const req = orig.apply(this, args)
      ws = 'w2'
      db.configureWorkspace('w2')
      return req
    }
    let res
    try {
      res = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'req-1' })
    } finally {
      IDBObjectStore.prototype.getAll = orig
    }
    expect(res.ok).toBe(false)
    expect(res.code).toBe('WORKSPACE_CHANGED')
    expect(await docs()).toEqual([])
    db.configureWorkspace('w1')
    ws = 'w1'
    expect((await docs()).filter((d) => d.kind === 'focus_session')).toHaveLength(0)
  })
  it('loadState 回种 epoch/草稿序号：同 owner 新实例可继续，异 owner 只读', async () => {
    await seed()
    const b = await svc.begin({ taskId: 't1', actionId: 'a1', requestId: 'b' })
    await svc.saveDraft({ sessionId: b.session_id, draftMd: '稿', requestId: 's' })
    svc.stop()
    const same = await mkService()
    const state = await same.loadState()
    expect(state.sessions.find((r) => r.session_id === b.session_id).owner_id).toBe('tab-1')
    nowIso = at(10_000)
    const cp = await same.checkpoint({ sessionId: b.session_id, requestId: 'cp' })
    expect(cp.ok).toBe(true)
    const other = await mkService({ ownerId: 'tab-2' })
    await other.loadState()
    const denied = await other.checkpoint({ sessionId: b.session_id, requestId: 'cp2' })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('OWNER_CONFLICT')
    same.stop()
    other.stop()
  })
})