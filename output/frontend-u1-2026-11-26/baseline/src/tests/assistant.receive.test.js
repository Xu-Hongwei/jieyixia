// M2 结果接收服务单测（fake-indexeddb）：版本/空间/线程约束、线程归档同事务、幂等、冲突不写。
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkProposal } from './planning.helpers.js'

const TS = '2026-11-25T10:00:00+08:00'
let db, svc, ws, counter
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('../services/storage/db')
  const { createAssistantDraftService } = await import('../services/assistant/drafts')
  ws = 'w1'
  db.configureWorkspace(ws)
  counter = 0
  svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `id-${++counter}` })
})

const resp = (draft, over = {}) => ({
  protocol_version: '1.0', request_id: 'req-1', thread_id: draft.thread_id, turn_id: 'turn-1',
  client_seq: 1, workspace_id: ws, summary: '',
  payload: { kind: 'proposal', proposal: mkProposal() }, ...over,
})
const clarification = (draft) => resp(draft, {
  payload: { kind: 'clarification', ready: false, questions: [{ question_id: 'q1', question: '报告给谁？', options: [], blocking_reason: '虚构原因', related_requirement_key: null }] },
})

async function generatingDraft(proposal = null) {
  const c = await svc.create({ title: '虚构线程', proposal })
  const g0 = await svc.get(c.draft.id)
  const st = await svc.setStatus(c.draft.id, { expected: g0.baseline.draft, status: 'generating' })
  expect(st.ok).toBe(true)
  const g = await svc.get(c.draft.id)
  return { created: c, frozen: g.baseline.draft, threadId: c.draft.thread_id }
}

describe('proposal 接收', () => {
  it('generating → needs_review + revision+1；线程归档 proposal_card 同事务', async () => {
    const { frozen } = await generatingDraft()
    const r = await svc.receiveResult(frozen.id, { expected: frozen, response: resp(frozen) })
    expect(r.ok).toBe(true)
    expect(r.bumped).toBe(true)
    expect(r.draft.status).toBe('needs_review')
    expect(r.draft.revision).toBe(2)
    expect(r.draft.proposal.work_items).toHaveLength(1)
    const g = await svc.get(frozen.id)
    expect(g.thread.messages).toHaveLength(1)
    expect(g.thread.messages[0]).toMatchObject({ role: 'assistant', type: 'proposal_card', id: 'prop-req-1' })
    expect(g.thread.messages[0].refs).toEqual([{ object_type: 'draft', id: frozen.id }])
  })
  it('旧计算/旧事实基线随新 proposal 作废（不拿旧排程配新建议）', async () => {
    const { scheduleDaily } = await import('../domains/planning/schedule')
    const { mkInput, mkWork } = await import('./planning.helpers.js')
    await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标', status: 'todo', deadline: { value: null, precision: 'none' } })
    await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false })
    const input = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })] })
    const c = await svc.create({ proposal: mkProposal(), planningInput: input, planningResult: scheduleDaily(input) })
    const g0 = await svc.get(c.draft.id)
    await svc.setStatus(c.draft.id, { expected: g0.baseline.draft, status: 'generating' })
    const g = await svc.get(c.draft.id)
    const r = await svc.receiveResult(c.draft.id, { expected: g.baseline.draft, response: resp(g.baseline.draft, { payload: { kind: 'proposal', proposal: mkProposal({ work_items: [] }) } }) })
    expect(r.ok).toBe(true)
    expect(r.draft.planning_input).toBeNull()
    expect(r.draft.planning_result).toBeNull()
    expect(r.draft.fact_baseline).toBeNull()
    expect(r.draft.revision_history[0].planning_result).not.toBeNull()
  })
  it('同轮重试幂等：alreadySaved，不重复历史/消息', async () => {
    const { frozen } = await generatingDraft()
    const response = resp(frozen)
    const r1 = await svc.receiveResult(frozen.id, { expected: frozen, response })
    expect(r1.ok).toBe(true)
    const r2 = await svc.receiveResult(frozen.id, { expected: frozen, response })
    expect(r2.ok).toBe(true)
    expect(r2.alreadySaved).toBe(true)
    const g = await svc.get(frozen.id)
    expect(g.draft.revision_history).toHaveLength(1)
    expect(g.thread.messages).toHaveLength(1)
  })
})

describe('clarification 接收', () => {
  it('generating → needs_clarification，不 bump；问题以机器固定 JSON 落线程（type 消歧）', async () => {
    const { frozen } = await generatingDraft(mkProposal())
    const r = await svc.receiveResult(frozen.id, { expected: frozen, response: clarification(frozen) })
    expect(r.ok).toBe(true)
    expect(r.bumped).toBe(false)
    expect(r.draft.status).toBe('needs_clarification')
    expect(r.draft.revision).toBe(1)
    expect(r.draft.proposal).not.toBeNull()
    const g = await svc.get(frozen.id)
    const msg = g.thread.messages[0]
    expect(msg.type).toBe('clarification')
    expect(msg.id).toBe('clr-req-1')
    expect(JSON.parse(msg.content).questions[0].question).toBe('报告给谁？')
  })
})

describe('约束与拒收', () => {
  it('非 generating 态拒收（NOT_GENERATING），原记录不变', async () => {
    const c = await svc.create({ proposal: mkProposal() })
    const g = await svc.get(c.draft.id)
    const r = await svc.receiveResult(c.draft.id, { expected: g.baseline.draft, response: resp(g.baseline.draft) })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NOT_GENERATING')
    expect((await svc.get(c.draft.id)).draft.revision).toBe(1)
  })
  it('跨空间结果拒收；线程不符拒收', async () => {
    const { frozen } = await generatingDraft()
    const wrongWs = await svc.receiveResult(frozen.id, { expected: frozen, response: resp(frozen, { workspace_id: 'w2' }) })
    expect(wrongWs.code).toBe('WORKSPACE_MISMATCH')
    const wrongThread = await svc.receiveResult(frozen.id, { expected: frozen, response: resp(frozen, { thread_id: 'th-other' }) })
    expect(wrongThread.code).toBe('CORRELATION_MISMATCH')
    expect((await svc.get(frozen.id)).draft.status).toBe('generating')
  })
  it('explanation 本版本不接收；非法 payload 形状拒收', async () => {
    const { frozen } = await generatingDraft()
    const expl = await svc.receiveResult(frozen.id, { expected: frozen, response: resp(frozen, { payload: { kind: 'explanation', explanation: 'x', fact_refs: [] } }) })
    expect(expl.code).toBe('UNSUPPORTED_PAYLOAD')
    const bad = await svc.receiveResult(frozen.id, { expected: frozen, response: resp(frozen, { payload: { kind: 'proposal', proposal: { bogus: 1 } } }) })
    expect(bad.code).toBe('PAYLOAD_INVALID')
  })
  it('冻结基线后被其它页面改动 → CONFLICT，线程与草案都不写', async () => {
    const { frozen } = await generatingDraft()
    // generating 不接受确认/编辑；用另一路径改记录：直接放弃（合法边 generating→discarded）
    const d = await svc.discard(frozen.id, { expected: frozen })
    expect(d.ok).toBe(true)
    const r = await svc.receiveResult(frozen.id, { expected: frozen, response: resp(frozen) })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('CONFLICT')
    const g = await svc.get(frozen.id)
    expect(g.draft.status).toBe('discarded')
    expect(g.thread.messages).toHaveLength(0)
  })
  it('线程消息越界（线程已满）→ 整体不写，草案保持 generating', async () => {
    const { frozen, threadId } = await generatingDraft()
    // 直接灌满线程消息（200 条上限），接收须因 THREAD_FULL 整体 abort
    const snap = await db.readAssistantSnapshot()
    const thread = snap.threads.find((t) => t.id === threadId)
    const msgs = Array.from({ length: 200 }, (_, i) => ({ id: `m-${i}`, role: 'user', content: 'x', type: 'text', refs: [], created_at: TS }))
    const { transformAssistantAtomic } = db
    await transformAssistantAtomic(() => ({ threadPuts: [{ ...thread, messages: msgs }] }))
    const r = await svc.receiveResult(frozen.id, { expected: frozen, response: resp(frozen) })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('THREAD_FULL')
    expect((await svc.get(frozen.id)).draft.status).toBe('generating')
  })
})