// M2 请求层纯构件单测：复用绑定判定 / 快照构建 / 上下文口径 / 请求与接收核对 / 输入指纹 /
// 澄清合成 / 生成结果接收纯规则。零网络；哈希走真实 WebCrypto。
import { describe, expect, it } from 'vitest'
import {
  createAssistantRequestService, composeClarificationMessage, MAX_AUTO_ANALYZE, MAX_EXCERPT_CHARS,
} from '../services/assistant/requests'
import { applyGenerationResult, canTransition } from '../domains/assistant/draft'

const TODAY = '2026-11-25'
const svc = createAssistantRequestService({ getWorkspaceId: () => 'w1', storage: null })

const textSource = (id, text, over = {}) => ({ id, kind: 'text', text, content_version: `cv-${id}`, ...over })
const imageSource = (id, over = {}) => ({ id, kind: 'image', blob: new Blob([new Uint8Array([1, 2, 3])]), content_version: `cv-${id}`, ...over })
const note = (id, sourceId, fields = [], over = {}) => ({ id, kind: 'note', source_id: sourceId, status: 'draft', fields, ...over })
const field = (key, over = {}) => ({ key, value: '虚构值', raw: '虚构原文', origin: 'model', status: 'candidate', derived: false, quote: null, precision: null, ...over })

describe('分析复用判定：绑定内容指纹与实际分析结果', () => {
  const s = imageSource('s-1')
  const n = note('n-1', 's-1', [field('title')])
  it('无便签 / 失败便签 / 无绑定 / 绑定错便签 / 内容版本变化 → 均不复用', () => {
    expect(svc.analysisReuse({ source: s, note: null, binding: null })).toEqual({ reuse: false, reason: 'NO_NOTE' })
    expect(svc.analysisReuse({ source: s, note: { ...n, status: 'failed' }, binding: { note_id: 'n-1', content_version: 'cv-s-1' } }).reason).toBe('ANALYSIS_FAILED')
    expect(svc.analysisReuse({ source: s, note: n, binding: null }).reason).toBe('NO_BINDING')
    expect(svc.analysisReuse({ source: s, note: n, binding: { note_id: 'n-other', content_version: 'cv-s-1' } }).reason).toBe('NO_BINDING')
    expect(svc.analysisReuse({ source: s, note: n, binding: { note_id: 'n-1', content_version: 'cv-old' } }).reason).toBe('CONTENT_CHANGED')
    expect(svc.analysisReuse({ source: { ...s, content_version: undefined }, note: n, binding: { note_id: 'n-1', content_version: 'cv-s-1' } }).reason).toBe('CONTENT_CHANGED')
  })
  it('便签归属其它来源 → 不复用（不拿别人的分析当复用）', () => {
    expect(svc.analysisReuse({ source: s, note: note('n-1', 's-other'), binding: { note_id: 'n-1', content_version: 'cv-s-1' } }).reason).toBe('NO_NOTE')
  })
  it('指纹+来源+便签三者一致 → 复用', () => {
    expect(svc.analysisReuse({ source: s, note: n, binding: { note_id: 'n-1', content_version: 'cv-s-1' } })).toEqual({ reuse: true, reason: null })
  })
  it('自动分析上限来自 limits 单一来源（3）', () => {
    expect(MAX_AUTO_ANALYZE).toBe(3)
    expect(MAX_EXCERPT_CHARS).toBe(2000)
  })
})

describe('选定资料快照', () => {
  it('文字全文 ≤2000 直接作摘录；指纹按真实字节', async () => {
    const s = textSource('s-1', '虚构通知：周五交报告。')
    const out = await svc.buildSelectedSources({ sources: [s] })
    expect(out).toHaveLength(1)
    expect(out[0].excerpt).toBe(s.text)
    expect(out[0].fingerprint.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(out[0].fingerprint.bytes).toBe(new TextEncoder().encode(s.text).length)
    expect(out[0].note_candidates).toEqual([])
  })
  it('超长全文 → 要求用户缩小范围，绝不静默截断', async () => {
    const s = textSource('s-1', '字'.repeat(2001))
    await expect(svc.buildSelectedSources({ sources: [s] })).rejects.toMatchObject({ code: 'EXCERPT_TOO_LONG', source_id: 's-1' })
  })
  it('用户选定片段必须是原文子串；非子串拒绝', async () => {
    const s = textSource('s-1', '前文。虚构通知：周五交报告。后文。')
    const ok = await svc.buildSelectedSources({ sources: [s], excerpts: { 's-1': '虚构通知：周五交报告。' } })
    expect(ok[0].excerpt).toBe('虚构通知：周五交报告。')
    await expect(svc.buildSelectedSources({ sources: [s], excerpts: { 's-1': '不在原文里的句子' } }))
      .rejects.toMatchObject({ code: 'EXCERPT_NOT_IN_SOURCE' })
    const long = textSource('s-2', '字'.repeat(2001) + '尾')
    await expect(svc.buildSelectedSources({ sources: [long], excerpts: { 's-2': '字'.repeat(2001) } }))
      .rejects.toMatchObject({ code: 'EXCERPT_TOO_LONG' })
  })
  it('图片带已绑定便签字段候选（value+raw+quote→quote_text）；missing 字段跳过', async () => {
    const s = imageSource('s-1')
    const n = note('n-1', 's-1', [
      field('title', { quote: { text: '原文引用', source_id: 's-1' } }),
      field('deadline', { status: 'missing', value: null }),
    ])
    const out = await svc.buildSelectedSources({ sources: [s], notesBySource: new Map([['s-1', n]]) })
    expect(out[0].excerpt).toBeNull()
    expect(out[0].note_candidates).toHaveLength(1)
    expect(out[0].note_candidates[0]).toMatchObject({ note_id: 'n-1', field_key: 'title', raw: '虚构原文', quote_text: '原文引用', status: 'candidate' })
  })
  it('超过 20 份资料拒绝分批提示', async () => {
    const sources = Array.from({ length: 21 }, (_, i) => textSource(`s-${i}`, 'x'))
    await expect(svc.buildSelectedSources({ sources })).rejects.toMatchObject({ code: 'TOO_MANY_SOURCES' })
  })
})

describe('排程上下文：与本地排程同口径', () => {
  const planItems = [
    { id: 'p-1', task_id: 't-1', date: TODAY, planned_minutes: 30, state: 'planned' },
    { id: 'p-2', task_id: 't-1', date: TODAY, planned_minutes: 20, state: 'done' },
    { id: 'p-3', task_id: 't-1', date: TODAY, planned_minutes: 90, state: 'cancelled' },
    { id: 'p-4', task_id: 't-1', date: '2026-12-01', planned_minutes: 60, state: 'planned' },
    { id: 'p-5', task_id: 't-1', date: '2026-12-03', planned_minutes: 60, state: 'planned' },
  ]
  it('7 天连续；不可用日预算 0；占用只计 planned/partial/done；窗口外不入 protected', () => {
    const ctx = svc.buildPlanningContext({ today: TODAY, unavailable: ['2026-11-26'], budgets: { [TODAY]: 45 }, planItems })
    expect(ctx.days).toHaveLength(7)
    expect(ctx.days[0]).toEqual({ date: TODAY, budget_minutes: 45, committed_minutes: 50 })
    expect(ctx.days[1]).toEqual({ date: '2026-11-26', budget_minutes: 0, committed_minutes: 0 })
    expect(ctx.days[2].budget_minutes).toBeNull()
    expect(ctx.protected_plans.map((p) => p.plan_item_id)).toEqual(['p-1', 'p-2', 'p-3', 'p-4'])
    expect(ctx.start_date).toBe(TODAY)
  })
  it('显式起始日生效（不得早于今天由契约校验）', () => {
    const ctx = svc.buildPlanningContext({ today: TODAY, startDate: '2026-11-27', planItems: [] })
    expect(ctx.days[0].date).toBe('2026-11-27')
  })
  it('输入框字符串预算转整数；空串→null；非法值保留原样供契约拒绝（M2 回归）', () => {
    const ctx = svc.buildPlanningContext({ today: TODAY, budgets: { [TODAY]: '45', '2026-11-26': '', '2026-11-27': '4.5', '2026-11-28': 'abc' }, planItems: [] })
    expect(ctx.days[0].budget_minutes).toBe(45)
    expect(ctx.days[1].budget_minutes).toBeNull()
    expect(ctx.days[2].budget_minutes).toBe('4.5')
    expect(ctx.days[3].budget_minutes).toBe('abc')
  })
})

describe('请求组装与接收核对', () => {
  const baseReq = () => ({
    request_id: 'req-1', thread_id: 'th-1', turn_id: 'turn-1', client_seq: 1, workspace_id: 'w1',
    user_message: '虚构要求', selected_sources: [], selected_tasks: [], selected_actions: [],
    planning_context: svc.buildPlanningContext({ today: TODAY, planItems: [] }),
    confirmed_requirements: [], pending_requirements: [],
  })
  const baseResp = () => ({
    protocol_version: '1.0', request_id: 'req-1', thread_id: 'th-1', turn_id: 'turn-1', client_seq: 1,
    workspace_id: 'w1', summary: '', payload: { kind: 'clarification', questions: [{ question_id: 'q1', question: '虚构问题？', options: [], blocking_reason: '虚构原因', related_requirement_key: null }], ready: false },
  })
  it('合法请求通过；未知字段拒绝', () => {
    expect(svc.buildRequest(baseReq()).intent).toBe('new_plan')
    expect(() => svc.buildRequest({ ...baseReq(), bogus: 1 })).toThrow(/REQUEST_INVALID|契约/)
  })
  it('接收：关联字段逐一核对，任一不符拒收', () => {
    const frozen = { request_id: 'req-1', thread_id: 'th-1', turn_id: 'turn-1', client_seq: 1, workspace_id: 'w1' }
    expect(svc.checkReception(baseResp(), frozen)).toEqual({ ok: true })
    for (const k of ['request_id', 'thread_id', 'turn_id', 'client_seq', 'workspace_id']) {
      const bad = { ...baseResp(), [k]: k === 'client_seq' ? 2 : 'other' }
      expect(svc.checkReception(bad, frozen)).toMatchObject({ ok: false, code: 'CORRELATION_MISMATCH', field: k })
    }
  })
  it('explanation 本版本不接收；非法形状拒收', () => {
    const frozen = { request_id: 'req-1', thread_id: 'th-1', turn_id: 'turn-1', client_seq: 1, workspace_id: 'w1' }
    const expl = { ...baseResp(), payload: { kind: 'explanation', explanation: '虚构说明', fact_refs: [] } }
    expect(svc.checkReception(expl, frozen)).toMatchObject({ ok: false, code: 'UNSUPPORTED_PAYLOAD' })
    expect(svc.checkReception({ ...baseResp(), payload: { kind: 'proposal' } }, frozen).ok).toBe(false)
  })
  it('接收：模型建议冒用用户来源（estimate_origin=user）拒收，不得冒充已核对清单', () => {
    const frozen = { request_id: 'req-1', thread_id: 'th-1', turn_id: 'turn-1', client_seq: 1, workspace_id: 'w1' }
    const proposalResp = (origin) => ({
      ...baseResp(),
      payload: {
        kind: 'proposal',
        proposal: {
          task_proposals: [{ op: 'create', key: 't1', title: '虚构任务', deadline_candidates: [], evidence_refs: [] }],
          action_proposals: [{ op: 'create', key: 'a1', task_ref: { kind: 'draft', key: 't1' }, text: '虚构步骤', minutes: 30, basis: 'suggestion', evidence_refs: [] }],
          work_items: [{ key: 'w1', task_ref: { kind: 'draft', key: 't1' }, action_ref: { kind: 'draft', key: 'a1' }, deliverable: '虚构产出', remaining_minutes: 90, estimate_origin: origin }],
        },
      },
    })
    expect(svc.checkReception(proposalResp('model'), frozen)).toEqual({ ok: true })
    expect(svc.checkReception(proposalResp('user'), frozen)).toMatchObject({ ok: false, code: 'PROVENANCE_FORGED' })
  })
  it('输入指纹：键序无关，内容版本/选定对象/表单变化即变', () => {
    const a = svc.inputFingerprint({ userMessage: 'u', sources: [textSource('s-1', 'x'), textSource('s-2', 'y')], taskIds: ['t-2', 't-1'], actionIds: [], schedule: { start_date: null, budgets: { a: 1, b: 2 }, unavailable: [] } })
    const b = svc.inputFingerprint({ userMessage: 'u', sources: [textSource('s-2', 'y'), textSource('s-1', 'x')], taskIds: ['t-1', 't-2'], actionIds: [], schedule: { start_date: null, budgets: { b: 2, a: 1 }, unavailable: [] } })
    expect(a).toBe(b)
    const c = svc.inputFingerprint({ userMessage: 'u', sources: [textSource('s-1', 'x', { content_version: 'cv-new' }), textSource('s-2', 'y')], taskIds: ['t-1', 't-2'], actionIds: [], schedule: { start_date: null, budgets: { a: 1, b: 2 }, unavailable: [] } })
    expect(c).not.toBe(a)
  })
})

describe('澄清续轮消息合成', () => {
  const questions = [
    { question_id: 'q1', question: '报告给谁？', options: [], blocking_reason: 'r', related_requirement_key: null },
    { question_id: 'q2', question: '周五几点前？', options: [], blocking_reason: 'r', related_requirement_key: null },
  ]
  it('原要求+问题+回答全部归档', () => {
    const text = composeClarificationMessage({ originalMessage: '周五交报告', questions, answers: [{ question_id: 'q1', answer: '给导师' }, { question_id: 'q2', answer: '17:00 前' }] }).text
    expect(text).toContain('原始要求：周五交报告')
    expect(text).toContain('问：报告给谁？')
    expect(text).toContain('答：给导师')
    expect(text).toContain('答：17:00 前')
  })
  it('缺答/空答/未知问题拒绝', () => {
    expect(() => composeClarificationMessage({ originalMessage: 'x', questions, answers: [{ question_id: 'q1', answer: 'a' }] })).toThrow(/全部/)
    expect(() => composeClarificationMessage({ originalMessage: 'x', questions, answers: [{ question_id: 'q1', answer: ' ' }, { question_id: 'q2', answer: 'b' }] })).toThrow(/尚未回答/)
    expect(() => composeClarificationMessage({ originalMessage: 'x', questions, answers: [{ question_id: 'q9', answer: 'a' }, { question_id: 'q2', answer: 'b' }] })).toThrow(/未知问题/)
  })
  it('P2：原始要求缺失/空白拒绝续轮（旧合成记录不得充当原始要求）', () => {
    const answers = [{ question_id: 'q1', answer: 'a' }, { question_id: 'q2', answer: 'b' }]
    expect(() => composeClarificationMessage({ originalMessage: '', questions, answers })).toThrow(/重新发起生成/)
    expect(() => composeClarificationMessage({ originalMessage: '  ', questions, answers })).toThrow(/重新发起生成/)
  })
})

describe('生成结果接收纯规则（冻结边一致）', () => {
  const draft = (status, over = {}) => ({
    id: 'd-1', record_version: 1, workspace_id: 'w1', thread_id: 'th-1',
    revision: 1, revision_history: [], status,
    proposal: null, planning_input: { x: 1 }, planning_result: { y: 2 }, fact_baseline: { z: 3 },
    assumptions: [], user_confirmations: [], excluded_items: [], source_refs: [],
    applied_summary: null, created_at: '2026-11-25T10:00:00+08:00', updated_at: '2026-11-25T10:00:00+08:00',
    ...over,
  })
  const proposal = { task_proposals: [], action_proposals: [], work_items: [], requirement_candidates: [], evidence_refs: [], assumptions: [], warnings: [] }
  const NOW = '2026-11-25T11:00:00+08:00'
  it('proposal → revision+1 + needs_review，旧计算/基线作废，历史留快照', () => {
    const r = applyGenerationResult(draft('generating'), { kind: 'proposal', proposal }, NOW)
    expect(r.ok).toBe(true)
    expect(r.bumped).toBe(true)
    expect(r.draft.revision).toBe(2)
    expect(r.draft.status).toBe('needs_review')
    expect(r.draft.planning_input).toBeNull()
    expect(r.draft.planning_result).toBeNull()
    expect(r.draft.fact_baseline).toBeNull()
    expect(r.draft.revision_history).toHaveLength(1)
    expect(r.draft.revision_history[0].planning_input).toEqual({ x: 1 })
    expect(canTransition('generating', 'needs_review')).toBe(true)
    expect(canTransition('needs_review', 'editing')).toBe(true)
  })
  it('clarification → needs_clarification，不 bump，内容保留', () => {
    const r = applyGenerationResult(draft('generating'), { kind: 'clarification', questions: [] }, NOW)
    expect(r.ok).toBe(true)
    expect(r.bumped).toBe(false)
    expect(r.draft.status).toBe('needs_clarification')
    expect(r.draft.revision).toBe(1)
    expect(r.draft.planning_input).toEqual({ x: 1 })
    expect(canTransition('generating', 'needs_clarification')).toBe(true)
    expect(canTransition('needs_clarification', 'generating')).toBe(true)
  })
  it('非 generating 态一律拒收；未知 payload 拒绝', () => {
    for (const status of ['editing', 'needs_clarification', 'ready', 'needs_review', 'applying', 'applied', 'result_unknown', 'discarded']) {
      expect(applyGenerationResult(draft(status), { kind: 'proposal', proposal }, NOW).ok).toBe(false)
    }
    expect(applyGenerationResult(draft('generating'), { kind: 'explanation' }, NOW)).toMatchObject({ ok: false, errors: [{ code: 'BAD_PAYLOAD' }] })
  })
})
describe('M3 改排请求层：有效占用 / 协议 1.1 / 输入指纹含范围与清单', () => {
  const planItems = [
    { id: 'p-1', task_id: 't-1', date: TODAY, planned_minutes: 30, state: 'planned' },
    { id: 'p-2', task_id: 't-1', date: TODAY, planned_minutes: 20, state: 'planned' },
    { id: 'p-keep', task_id: 't-1', date: '2026-11-26', planned_minutes: 20, state: 'planned' },
  ]
  it('replacementIds：选定替换不再占用容量，protected_plans 只留保留部分', () => {
    const ctx = svc.buildPlanningContext({ today: TODAY, planItems, replacementIds: ['p-1'] })
    expect(ctx.days[0].committed_minutes).toBe(20)
    expect(ctx.protected_plans.map((p) => p.plan_item_id)).toEqual(['p-2', 'p-keep'])
    const full = svc.buildPlanningContext({ today: TODAY, planItems })
    expect(full.days[0].committed_minutes).toBe(50)
  })
  const replanReq = () => ({
    protocol_version: '1.1', intent: 'replan_task',
    request_id: 'req-1', thread_id: 'th-1', turn_id: 'turn-1', client_seq: 1, workspace_id: 'w1',
    user_message: '虚构进展',
    selected_sources: [],
    selected_tasks: [{ id: 't-1', title: '虚构任务', status: 'todo', deadline: { value: null, precision: 'none' }, current_action_id: null, updated_at: '2026-11-25T09:00:00+08:00' }],
    selected_actions: [{ id: 'a-1', task_id: 't-1', text: '虚构行动', minutes: 45, basis: 'user', done: false }],
    planning_context: svc.buildPlanningContext({ today: TODAY, planItems: [], replacementIds: ['p-1'] }),
    confirmed_requirements: [], pending_requirements: [],
    replan_context: {
      task_id: 't-1',
      progress: { statement: '虚构进展', work_items: [{ key: 'rw1', text: '虚构工作', reuse_action_id: 'a-1', minutes: 30, splittable: true, min_segment_minutes: null }] },
      replacements: [{ plan_item_id: 'p-1', date: TODAY, planned_minutes: 30, action_text: '虚构旧安排', state: 'planned' }],
      kept: [],
    },
  })
  it('合法 replan 请求通过正式契约（1.1 + replan_context）', () => {
    const req = svc.buildRequest(replanReq())
    expect(req.protocol_version).toBe('1.1')
    expect(req.intent).toBe('replan_task')
    expect(req.previous_draft).toBeNull()
  })
  it('形状非法的 replan_context 拒绝（空替换集/空清单/未知字段）；跨字段规则由后端守卫', () => {
    const noRep = replanReq(); noRep.replan_context.replacements = []
    expect(() => svc.buildRequest(noRep)).toThrow(/REQUEST_INVALID|契约/)
    const noWork = replanReq(); noWork.replan_context.progress.work_items = []
    expect(() => svc.buildRequest(noWork)).toThrow(/REQUEST_INVALID|契约/)
    const bogus = replanReq(); bogus.replan_context.bogus = 1
    expect(() => svc.buildRequest(bogus)).toThrow(/REQUEST_INVALID|契约/)
  })
  it('接收核对：协议版本随本轮请求（1.1 接受，失配拒收）', () => {
    const frozen = { protocol_version: '1.1', request_id: 'req-1', thread_id: 'th-1', turn_id: 'turn-1', client_seq: 1, workspace_id: 'w1' }
    const resp = {
      protocol_version: '1.1', request_id: 'req-1', thread_id: 'th-1', turn_id: 'turn-1', client_seq: 1,
      workspace_id: 'w1', summary: '', payload: { kind: 'clarification', questions: [{ question_id: 'q1', question: '虚构问题？', options: [], blocking_reason: '虚构原因', related_requirement_key: null }], ready: false },
    }
    expect(svc.checkReception(resp, frozen)).toEqual({ ok: true })
    expect(svc.checkReception({ ...resp, protocol_version: '1.0' }, frozen)).toMatchObject({ ok: false, code: 'PROTOCOL_UNSUPPORTED' })
    expect(svc.checkReception(resp, { ...frozen, protocol_version: '1.0' })).toMatchObject({ ok: false, code: 'PROTOCOL_UNSUPPORTED' })
  })
  it('输入指纹：替换范围/清单分钟数变化即变（迟到响应作废依据）', () => {
    const base = { userMessage: 'u', sources: [], taskIds: [], actionIds: [], schedule: { start_date: TODAY, budgets: {}, unavailable: [] } }
    const scope = { task_id: 't-1', start_date: TODAY, replacement_ids: ['p-1'] }
    const progress = { statement: 's', work_items: [{ key: 'rw1', text: 'x', minutes: 30 }] }
    const a = svc.inputFingerprint({ ...base, replan: { scope, progress } })
    const b = svc.inputFingerprint({ ...base, replan: { scope: { ...scope, replacement_ids: ['p-1', 'p-2'] }, progress } })
    const c = svc.inputFingerprint({ ...base, replan: { scope, progress: { ...progress, work_items: [{ key: 'rw1', text: 'x', minutes: 60 }] } } })
    const d = svc.inputFingerprint({ ...base, replan: { scope, progress } })
    expect(a).toBe(d)
    expect(b).not.toBe(a)
    expect(c).not.toBe(a)
    expect(svc.inputFingerprint(base)).not.toBe(a)
  })
})
