// M2 真实生成生命周期单测（fake-indexeddb + mock API，零网络零费用）：
// 快乐路径 / 默认要求 / 取消 / 迟到拒收（换空间往返）/ 输入变化拒收 / 保存失败留结果重试不重调 /
// 澄清续轮 seq+1 / 自动分析上限与复用绑定 / 分析保存失败仅重试落库 / 重复点击不并行。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { beijingToday, beijingAddDays } from '../domains/time'

vi.hoisted(() => {
  const m = new Map()
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  }
})

vi.mock('../services/api/client', () => ({
  healthz: vi.fn(async () => ({ ok: true, kind: 'http', status: 200, body: { status: 'ok', model_ready: true, provider: 'fixture' } })),
  analyze: vi.fn(),
  propose: vi.fn(),
  blobToBase64: vi.fn(async () => 'c3R1Yg=='),
}))

vi.mock('../services/storage/db', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, transformAssistantAtomic: vi.fn(actual.transformAssistantAtomic), putDoc: vi.fn(actual.putDoc) }
})

import { useAppStore } from '../stores/app'
import { useAssistantStore, DEFAULT_USER_MESSAGE } from '../stores/assistant'

const TEXT = '虚构通知：周五交报告，包含资料整理、对比分析和结论。'
let app, store, api, db
beforeEach(async () => {
  localStorage.clear()
  setActivePinia(createPinia())
  api = await import('../services/api/client')
  db = await import('../services/storage/db')
  const actual = await vi.importActual('../services/storage/db')
  api.analyze.mockReset()
  api.propose.mockReset()
  db.transformAssistantAtomic.mockReset()
  db.transformAssistantAtomic.mockImplementation(actual.transformAssistantAtomic)
  db.putDoc.mockReset()
  db.putDoc.mockImplementation(actual.putDoc)
  app = useAppStore()
  await app.init()
  await db.clearWorkspace('personal')
  await db.clearWorkspace('demo')
  await app.reload()
  store = useAssistantStore()
})

const evOf = (req) => {
  const src = req.selected_sources[0]
  return src
    ? [{ kind: 'source_excerpt', source_id: src.source_id, excerpt: (src.excerpt || '虚构片段').slice(0, 2000), locator: null }]
    : [{ kind: 'user_message', turn_id: req.turn_id, excerpt: req.user_message.slice(0, 2000) }]
}
const proposalBody = (req) => {
  const ev = evOf(req)
  return {
    protocol_version: '1.0', request_id: req.request_id, thread_id: req.thread_id, turn_id: req.turn_id,
    client_seq: req.client_seq, workspace_id: req.workspace_id, summary: '',
    payload: {
      kind: 'proposal',
      proposal: {
        task_proposals: [{ op: 'create', key: 't1', title: '虚构：完成报告', description: '虚构描述', completion_criteria: null, deadline_candidates: [], evidence_refs: ev }],
        action_proposals: [
          { op: 'create', key: 'a1', task_ref: { kind: 'draft', key: 't1' }, text: '整理资料', minutes: 45, basis: 'suggestion', evidence_refs: [] },
          { op: 'create', key: 'a2', task_ref: { kind: 'draft', key: 't1' }, text: '撰写结论', minutes: 60, basis: 'suggestion', evidence_refs: [] },
        ],
        work_items: [
          { key: 'w1', task_ref: { kind: 'draft', key: 't1' }, action_ref: { kind: 'draft', key: 'a1' }, deliverable: '资料清单', remaining_minutes: 45, estimate_origin: 'model', splittable: true, min_segment_minutes: 25, earliest_date: null, depends_on: [], priority: 'normal' },
          { key: 'w2', task_ref: { kind: 'draft', key: 't1' }, action_ref: { kind: 'draft', key: 'a2' }, deliverable: '报告结论', remaining_minutes: 60, estimate_origin: 'model', splittable: true, min_segment_minutes: 25, earliest_date: null, depends_on: ['w1'], priority: 'normal' },
        ],
        requirement_candidates: [], evidence_refs: ev, assumptions: [], warnings: [],
      },
    },
  }
}
const okPropose = (req) => Promise.resolve({ ok: true, kind: 'http', status: 200, body: proposalBody(req) })
const clarificationBody = (req) => ({
  protocol_version: '1.0', request_id: req.request_id, thread_id: req.thread_id, turn_id: req.turn_id,
  client_seq: req.client_seq, workspace_id: req.workspace_id, summary: '',
  payload: { kind: 'clarification', ready: false, questions: [{ question_id: 'q1', question: '报告交给谁？', options: ['导师', '班长'], blocking_reason: '虚构：影响交付对象', related_requirement_key: null }] },
})
const analyzeBody = (sourceId, fields = [{ key: 'title', value: '虚构通知', raw: '虚构原文', origin: 'model', status: 'candidate', derived: false }]) => ({
  ok: true, kind: 'http', status: 200,
  body: { source_id: sourceId, content_type: 'notice', fields, warnings: [] },
})
const seedText = async (text = TEXT) => (await app.saveText(text)).record
const seedImages = async (n) => {
  const files = Array.from({ length: n }, (_, i) => new File([new Uint8Array([i, 1, 2])], `虚构${i}.png`, { type: 'image/png' }))
  return (await app.saveImageFiles(files)).filter((r) => r.ok).map((r) => r.record)
}
const requesting = () => vi.waitFor(() => expect(store.gen?.phase).toBe('requesting'))

describe('快乐路径与输入留痕', () => {
  it('文字资料生成：请求形状正确，结果落草案 needs_review，线程归档用户消息+建议卡', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    store.input.userText = '每天 45 分钟，周三没空'
    api.propose.mockImplementation(okPropose)
    const r = await store.generate()
    expect(r.ok).toBe(true)
    expect(api.propose).toHaveBeenCalledTimes(1)
    const req = api.propose.mock.calls[0][0]
    expect(req).toMatchObject({ protocol_version: '1.0', intent: 'new_plan', workspace_id: 'personal', client_seq: 1, user_message: '每天 45 分钟，周三没空' })
    expect(req.selected_sources).toHaveLength(1)
    expect(req.selected_sources[0].excerpt).toBe(TEXT)
    expect(req.selected_sources[0].fingerprint.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(req.planning_context.days).toHaveLength(7)
    expect(store.gen.phase).toBe('done')
    expect(store.activeDraft.status).toBe('needs_review')
    expect(store.activeDraft.revision).toBe(2)
    expect(store.activeDraft.proposal.work_items).toHaveLength(2)
    expect(store.canAdopt).toBe(false) // 模型成功 ≠ 可直接采用
    const msgs = store.active.thread.messages
    expect(msgs.map((m) => m.type)).toEqual(['text', 'proposal_card'])
    expect(msgs[0].content).toBe('每天 45 分钟，周三没空')
    expect(msgs[0].id).toBe(req.turn_id)
  })
  it('未填要求用可编辑默认文案；无输入拒绝且不调模型', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    api.propose.mockImplementation(okPropose)
    await store.generate()
    expect(api.propose.mock.calls[0][0].user_message).toBe(DEFAULT_USER_MESSAGE)
    await store.dismissGeneration()
    store.input.sourceIds = []
    store.input.userText = ''
    const r = await store.generate()
    expect(r.ok).toBe(false)
    expect(api.propose).toHaveBeenCalledTimes(1)
  })
  it('重复点击不产生并行付费请求', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    let release
    api.propose.mockImplementation((req) => new Promise((resolve) => { release = () => resolve(okPropose(req)) }))
    const p = store.generate()
    await requesting()
    const second = await store.generate()
    expect(second).toMatchObject({ ok: false, code: 'BUSY' })
    release()
    await p
    expect(api.propose).toHaveBeenCalledTimes(1)
  })
})

describe('取消与迟到结果', () => {
  it('请求中取消：草案结算 needs_review，输入保留，无结果写入', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    api.propose.mockImplementation((req, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, kind: 'cancelled', status: 0, code: 'cancelled', message: '请求已取消' }))
    }))
    const p = store.generate()
    await requesting()
    store.cancelGeneration()
    await p
    expect(store.gen).toBeNull()
    await store.init()
    expect(store.drafts).toHaveLength(1)
    expect(store.drafts[0].status).toBe('needs_review')
    expect(store.drafts[0].proposal).toBeNull()
    expect(store.input.sourceIds).toEqual([s.id])
    expect(store.notice.tone).toBe('info')
  })
  it('换空间后迟到结果拒收；切回刷新结算为 needs_review，不应用旧结果', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    let release
    api.propose.mockImplementation((req) => new Promise((resolve) => { release = () => resolve(okPropose(req)) }))
    const p = store.generate()
    await requesting()
    const draftId = store.gen.draftId
    await app.switchWorkspace('demo')
    expect(store.gen).toBeNull()
    release()
    await p
    await store.init()
    expect(store.drafts).toHaveLength(0) // 演示空间没有写入
    await app.switchWorkspace('personal')
    await store.init()
    const d = store.drafts.find((x) => x.id === draftId)
    expect(d.status).toBe('needs_review')
    expect(d.revision).toBe(1) // 旧结果未接收
    expect(d.proposal).toBeNull()
  })
  it('生成期间改输入 → 本轮结果拒收（INPUT_CHANGED），草案不接收', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    let release
    api.propose.mockImplementation((req) => new Promise((resolve) => { release = () => resolve(okPropose(req)) }))
    const p = store.generate()
    await requesting()
    store.input.userText = '改过的要求'
    release()
    await p
    expect(store.gen.phase).toBe('failed')
    expect(store.gen.error.code).toBe('INPUT_CHANGED')
    expect(store.activeDraft).toBeNull()
    await store.init()
    expect(store.drafts[0].status).toBe('needs_review')
    expect(store.drafts[0].revision).toBe(1)
  })
  it('关联字段不符的响应拒收（CORRELATION_MISMATCH）', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    api.propose.mockImplementation(async (req) => {
      const r = await okPropose(req)
      r.body.request_id = 'req-forged'
      return r
    })
    await store.generate()
    expect(store.gen.phase).toBe('failed')
    expect(store.gen.error.code).toBe('CORRELATION_MISMATCH')
    await store.init()
    expect(store.drafts[0].revision).toBe(1)
  })
})

describe('保存失败：留结果重试，不重调模型', () => {
  it('接收落库失败 → save_failed 留存；重试仅落库成功，propose 仍只调一次', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    // 在 propose 返回时才武装拒绝：确保命中的是接收落库，而非此前 create/归档/状态写入。
    api.propose.mockImplementation(async (req) => {
      db.transformAssistantAtomic.mockRejectedValueOnce(new Error('磁盘暂时不可用'))
      return okPropose(req)
    })
    await store.generate()
    expect(api.propose).toHaveBeenCalledTimes(1)
    expect(store.gen.phase).toBe('save_failed')
    expect(store.gen.retained).not.toBeNull()
    const r = await store.retrySaveResult()
    expect(r.ok).toBe(true)
    expect(api.propose).toHaveBeenCalledTimes(1)
    expect(store.gen.phase).toBe('done')
    expect(store.activeDraft.status).toBe('needs_review')
    expect(store.activeDraft.revision).toBe(2)
  })
  it('留存期间草案被放弃 → 重试拒收并明确需重新生成', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    api.propose.mockImplementation(async (req) => {
      db.transformAssistantAtomic.mockRejectedValueOnce(new Error('磁盘暂时不可用'))
      return okPropose(req)
    })
    await store.generate()
    expect(store.gen.phase).toBe('save_failed')
    await store.open(store.gen.draftId)
    await store.discardDraft()
    const r = await store.retrySaveResult()
    expect(r.ok).toBe(false)
    expect(store.gen.phase).toBe('failed')
    expect(store.gen.error.code).toBe('DRAFT_CHANGED')
    expect(store.gen.retained).toBeNull()
    expect(api.propose).toHaveBeenCalledTimes(1)
  })
})

describe('澄清续轮', () => {
  it('澄清 → 集中回答 → 同线程同草案 seq+1 续轮，合成消息真实归档', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    store.input.userText = '周五交报告'
    api.propose
      .mockImplementationOnce(async (req) => ({ ok: true, kind: 'http', status: 200, body: clarificationBody(req) }))
      .mockImplementation(okPropose)
    await store.generate()
    expect(store.gen.phase).toBe('clarification')
    expect(store.gen.questions[0].question).toBe('报告交给谁？')
    expect(store.activeDraft.status).toBe('needs_clarification')
    const firstReq = api.propose.mock.calls[0][0]
    const r = await store.continueClarification([{ question_id: 'q1', answer: '给导师' }])
    expect(r.ok).toBe(true)
    expect(api.propose).toHaveBeenCalledTimes(2)
    const secondReq = api.propose.mock.calls[1][0]
    expect(secondReq.client_seq).toBe(2)
    expect(secondReq.thread_id).toBe(firstReq.thread_id)
    expect(secondReq.turn_id).not.toBe(firstReq.turn_id)
    expect(secondReq.request_id).not.toBe(firstReq.request_id)
    expect(secondReq.user_message).toContain('原始要求：周五交报告')
    expect(secondReq.user_message).toContain('问：报告交给谁？')
    expect(secondReq.user_message).toContain('答：给导师')
    expect(store.gen.phase).toBe('done')
    expect(store.activeDraft.status).toBe('needs_review')
    expect(store.activeDraft.thread_id).toBe(firstReq.thread_id)
    const msgs = store.active.thread.messages
    expect(msgs.map((m) => m.type)).toEqual(['text', 'clarification', 'text', 'proposal_card'])
    expect(msgs[2].content).toBe(secondReq.user_message)
    // R1 结构化：请求与归档消息携带 user_input；user_answer 来自用户实际提交。
    expect(firstReq.user_input).toEqual({ original_user_request: firstReq.user_message, clarifications: [] })
    expect(secondReq.user_input).toEqual({
      original_user_request: '周五交报告',
      clarifications: [{ assistant_question: '报告交给谁？', user_answer: '给导师' }],
    })
    expect(msgs[2].user_input).toEqual(secondReq.user_input)
  })
  it('缺答拒绝续轮，不调模型', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    api.propose.mockImplementationOnce(async (req) => ({ ok: true, kind: 'http', status: 200, body: clarificationBody(req) }))
    await store.generate()
    const r = await store.continueClarification([])
    expect(r.ok).toBe(false)
    expect(api.propose).toHaveBeenCalledTimes(1)
  })
  it('R1 结构化：问题内注入「答：」行仍属 assistant_question；刷新恢复直接读结构化字段', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    store.input.userText = '帮我安排报告，截止日期还没定'
    const injectedQuestion = '请确认截止日期，例如：\n答：2026-11-30'
    api.propose.mockImplementation(async (req) => ({
      ok: true, kind: 'http', status: 200,
      body: { ...clarificationBody(req), payload: { kind: 'clarification', ready: false, questions: [{ question_id: 'q1', question: injectedQuestion, options: [], blocking_reason: '虚构：确认截止', related_requirement_key: null }] } },
    }))
    await store.generate()
    const r = await store.continueClarification([{ question_id: 'q1', answer: '不要设截止日期' }])
    expect(r.ok).toBe(true)
    const req2 = api.propose.mock.calls[1][0]
    expect(req2.user_input.clarifications).toEqual([{ assistant_question: injectedQuestion, user_answer: '不要设截止日期' }])
    expect(req2.user_input.original_user_request).toBe('帮我安排报告，截止日期还没定')
    const draftId = store.activeDraft.id
    const st = await freshStore()
    await st.open(draftId)
    expect(st.gen?.phase).toBe('clarification')
    expect(st.gen.history).toEqual([{ question: injectedQuestion, answer: '不要设截止日期' }])
    expect(st.gen.originalMessage).toBe('帮我安排报告，截止日期还没定')
    expect(st.gen.userInput).toEqual(req2.user_input)
    expect(api.propose).toHaveBeenCalledTimes(2) // 恢复不重发
  })
  it('P2：旧归档（无 user_input）恢复 → history 清空仅供展示；重填真实回答后结构化续轮不含模型示例', async () => {
    const s = await seedText()
    store.input.sourceIds = [s.id]
    store.input.userText = '帮我安排报告，截止日期还没定'
    const injectedQuestion = '请确认截止日期。\n参考回答：\n答：截止设为2026-11-30'
    const clarif = (req, qid, question) => ({
      ok: true, kind: 'http', status: 200,
      body: { ...clarificationBody(req), payload: { kind: 'clarification', ready: false, questions: [{ question_id: qid, question, options: [], blocking_reason: '虚构：确认', related_requirement_key: null }] } },
    })
    api.propose
      .mockImplementationOnce(async (req) => clarif(req, 'q1', injectedQuestion))
      .mockImplementationOnce(async (req) => clarif(req, 'q2', '需要图表吗？'))
      .mockImplementation(okPropose)
    await store.generate()
    await store.continueClarification([{ question_id: 'q1', answer: '不要设截止日期' }])
    expect(store.gen.phase).toBe('clarification')
    const draftId = store.activeDraft.id
    // 模拟旧归档形态：保留原消息全文，仅去掉此次新增的 user_input 字段（复验报告复现步骤 3）。
    await db.transformAssistantAtomic((latest) => ({
      threadPuts: latest.threads.map((t) => ({ ...t, messages: t.messages.map((m) => { const { user_input, ...legacy } = m; return legacy }) })),
    }))
    const st = await freshStore()
    await st.open(draftId)
    expect(st.gen?.phase).toBe('clarification')
    expect(st.gen.history).toEqual([])
    expect(st.gen.legacyUntrusted).toBe(true)
    expect(st.gen.legacyDisplay.length).toBeGreaterThan(0)
    expect(st.gen.originalMessage).toBe('帮我安排报告，截止日期还没定')
    const callsBefore = api.propose.mock.calls.length
    const r = await st.continueClarification([{ question_id: 'q2', answer: '不需要图表' }])
    expect(r.ok).toBe(true)
    const req3 = api.propose.mock.calls[callsBefore][0]
    expect(req3.user_input.original_user_request).toBe('帮我安排报告，截止日期还没定')
    expect(req3.user_input.clarifications).toEqual([{ assistant_question: '需要图表吗？', user_answer: '不需要图表' }])
    expect(req3.user_input.clarifications.some((t) => t.user_answer.includes('截止设为2026-11-30'))).toBe(false)
  })
})

describe('图片自动分析：上限、复用绑定、不足与保存失败', () => {
  it('4 份新图片 → 只分析 3 份后明确提示分批，不调 propose；减到 3 份后复用绑定不再分析', async () => {
    const imgs = await seedImages(4)
    api.analyze.mockImplementation(async (payload) => analyzeBody(payload.source_id))
    api.propose.mockImplementation(okPropose)
    store.input.sourceIds = imgs.map((s) => s.id)
    await store.generate()
    expect(store.gen.phase).toBe('failed')
    expect(store.gen.error.code).toBe('TOO_MANY_UNANALYZED')
    expect(api.analyze).toHaveBeenCalledTimes(3)
    expect(api.propose).not.toHaveBeenCalled()
    store.input.sourceIds = imgs.slice(0, 3).map((s) => s.id)
    await store.retryGeneration()
    expect(store.gen.phase).toBe('done')
    expect(api.analyze).toHaveBeenCalledTimes(3) // 绑定复用，零新增分析
    expect(api.propose).toHaveBeenCalledTimes(1)
    const req = api.propose.mock.calls[0][0]
    expect(req.selected_sources.every((s) => s.note_candidates.length === 1)).toBe(true)
    expect(req.selected_sources.every((s) => s.excerpt === null)).toBe(true)
  })
  it('分析结果为空 → 提示补充，不二次 OCR 不调 propose', async () => {
    const imgs = await seedImages(1)
    api.analyze.mockImplementation(async (payload) => analyzeBody(payload.source_id, []))
    store.input.sourceIds = [imgs[0].id]
    await store.generate()
    expect(store.gen.phase).toBe('failed')
    expect(store.gen.error.code).toBe('ANALYSIS_INSUFFICIENT')
    expect(api.analyze).toHaveBeenCalledTimes(1)
    expect(api.propose).not.toHaveBeenCalled()
  })
  it('分析成功但落库失败 → 重试仅保存分析结果，analyze/propose 各只调一次', async () => {
    const imgs = await seedImages(1)
    api.analyze.mockImplementation(async (payload) => analyzeBody(payload.source_id))
    api.propose.mockImplementation(okPropose)
    db.putDoc.mockRejectedValueOnce(new Error('磁盘暂时不可用'))
    store.input.sourceIds = [imgs[0].id]
    await store.generate()
    expect(store.gen.phase).toBe('failed')
    expect(store.gen.error.code).toBe('ANALYSIS_SAVE_FAILED')
    expect(store.gen.pendingAnalysis).not.toBeNull()
    await store.retryGeneration()
    expect(store.gen.phase).toBe('done')
    expect(api.analyze).toHaveBeenCalledTimes(1)
    expect(api.propose).toHaveBeenCalledTimes(1)
  })
  it('内容版本变化（同 id 替换字节）→ 绑定失配重新分析一次', async () => {
    const imgs = await seedImages(1)
    api.analyze.mockImplementation(async (payload) => analyzeBody(payload.source_id))
    api.propose.mockImplementation(okPropose)
    store.input.sourceIds = [imgs[0].id]
    await store.generate()
    expect(api.analyze).toHaveBeenCalledTimes(1)
    await db.putSource({ id: imgs[0].id, kind: 'image', blob: new Blob([new Uint8Array([9, 9, 9])]), name: '虚构0.png', captured_at: imgs[0].captured_at })
    await app.reload()
    await store.dismissGeneration()
    await store.generate()
    expect(api.analyze).toHaveBeenCalledTimes(2)
    expect(store.gen.phase).toBe('done')
  })
})

// R2：输入恢复不限待澄清——正常成功未排程 / 缺元数据 / 已排程优先 planning_input。
// 排程输入校验要求 start_date 不早于北京时间今天，夹具随当天滚动，避免时间过期造成假失败。
const R2_DATES = Array.from({ length: 7 }, (_, i) => beijingAddDays(beijingToday(), i))
async function freshStore() {
  setActivePinia(createPinia())
  app = useAppStore()
  await app.init()
  await app.reload()
  store = useAssistantStore()
  return store
}
async function seedGenerated45() {
  const s = await seedText()
  store.input.sourceIds = [s.id]
  store.input.userText = '生成后保留预算'
  store.input.startDate = R2_DATES[0]
  for (const d of R2_DATES) store.input.budgets[d] = '45'
  store.input.unavailable = [R2_DATES[1]]
  api.propose.mockImplementation(okPropose)
  await store.generate()
  return { s, draftId: store.activeDraft.id }
}
describe('R2 刷新/重开输入恢复', () => {
  it('正常成功未排程草案刷新后恢复预算/不可用/起始日/来源/要求，不自动重发', async () => {
    const { s, draftId } = await seedGenerated45()
    expect(store.activeDraft.status).toBe('needs_review')
    expect(store.activeDraft.planning_input ?? null).toBeNull()
    const st = await freshStore()
    await st.open(draftId)
    expect(st.inputRestore).toBe('restored')
    expect(st.input.budgets[R2_DATES[0]]).toBe('45')
    expect(st.input.budgets[R2_DATES[6]]).toBe('45')
    expect(st.input.unavailable).toEqual([R2_DATES[1]])
    expect(st.input.startDate).toBe(R2_DATES[0])
    expect(st.input.sourceIds).toEqual([s.id])
    expect(st.input.userText).toBe('生成后保留预算')
    expect(st.gen).toBeNull()
    expect(api.propose).toHaveBeenCalledTimes(1)
  })
  it('缺已保存输入且未排程 → missing（默认值不冒充已恢复），预算留空待补填', async () => {
    const { draftId } = await seedGenerated45()
    localStorage.clear()
    const st = await freshStore()
    await st.open(draftId)
    expect(st.inputRestore).toBe('missing')
    expect(st.input.budgets).toEqual({})
    expect(st.input.sourceIds).toEqual([])
  })
  it('已排程草案缺已保存输入 → planning（沿用有效计算输入，非 missing/默认）', async () => {
    const { draftId } = await seedGenerated45()
    localStorage.clear()
    await store.reschedule({ startDate: R2_DATES[0], budgets: Object.fromEntries(R2_DATES.map((d) => [d, 45])), unavailable: [R2_DATES[1]] })
    const st = await freshStore()
    await st.open(draftId)
    expect(st.inputRestore).toBe('planning')
    expect(st.activeDraft.planning_input.days.find((x) => x.date === R2_DATES[0]).budget_minutes).toBe(45)
  })
  it('旧已保存输入不覆盖更新的已排程计算输入（planning_input 优先）', async () => {
    const { draftId } = await seedGenerated45()
    await store.reschedule({ startDate: R2_DATES[0], budgets: Object.fromEntries(R2_DATES.map((d) => [d, 60])), unavailable: [] })
    const st = await freshStore()
    await st.open(draftId)
    expect(st.activeDraft.planning_input.days.find((x) => x.date === R2_DATES[0]).budget_minutes).toBe(60)
    expect(st.input.budgets[R2_DATES[0]]).toBe('45') // 读回旧输入但不影响已排程事实
  })
})