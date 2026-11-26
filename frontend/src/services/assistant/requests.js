// M2 真实请求层（开工单 §3/§4/§6）：选定快照构建、分析复用绑定、请求/接收核对。
// 纯判定 + 显式输入；analyze/propose 的 IO 与取消由 store 编排，本模块只提供可单测的构件。
// 限额数值来自 contract/limits.json（单一来源）；形状校验复用正式 schema（validateAgainstDef）。
// 复用判定绑定「内容指纹 + 来源 → 实际分析结果」，不是「存在便签即复用」；绑定缺失/失配 → 重分析一次建立。
import limitsDoc from '@contract/limits.json'
import { MAX_SELECTED_SOURCES } from '../../domains/assistant/limits'
export { MAX_SELECTED_SOURCES } from '../../domains/assistant/limits'
import { canonicalJson } from '../../domains/assistant/draft'
import {
  parseClarificationHistory, renderUserInputText,
} from '../../domains/assistant/clarification'
import { COUNTED_STATES, windowDates } from '../../domains/planning/protocol'
import { sourceContentBytes } from './context'
import { sha256Hex } from '../backup/format'
import { validateAgainstDef } from '../backup/contractSchema'

const L = limitsDoc.limits
export const MAX_AUTO_ANALYZE = L.max_new_images_per_batch.value
export const MAX_EXCERPT_CHARS = L.max_source_excerpt_chars.value
export const MAX_USER_MESSAGE_CHARS = L.max_user_message_chars.value

const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {})

const BINDING_PREFIX = 'jxl.assistant.analysis-binding'

export function createAssistantRequestService(deps = {}) {
  const { getWorkspaceId, storage = globalThis.localStorage } = deps
  if (typeof getWorkspaceId !== 'function') throw new Error('createAssistantRequestService 需要 getWorkspaceId')

  // ---- 分析复用绑定：本地元数据（不进备份/不发给模型），按空间+来源隔离。 ----
  const bindingKey = (ws, sourceId) => `${BINDING_PREFIX}:${ws}:${sourceId}`
  function loadBinding(sourceId, ws = getWorkspaceId()) {
    try {
      const b = JSON.parse(storage?.getItem(bindingKey(ws, sourceId)) || 'null')
      return b && typeof b.note_id === 'string' && typeof b.content_version === 'string' ? b : null
    } catch { return null }
  }
  function saveBinding(sourceId, { content_version, note_id }, ws = getWorkspaceId()) {
    storage?.setItem(bindingKey(ws, sourceId), JSON.stringify({ content_version, note_id }))
  }

  // ---- 输入表单本地持久化（M2 审查 F3）：仅本机元数据，不进备份/不发给模型，按空间+草案隔离。 ----
  // 待澄清草案刷新后据此恢复起始日/预算/不可用日等用户已填排程输入，避免回到默认值。
  const inputFormKey = (ws, draftId) => `${BINDING_PREFIX}.input-form:${ws}:${draftId}`
  function saveInputForm(draftId, form, ws = getWorkspaceId()) {
    storage?.setItem(inputFormKey(ws, draftId), JSON.stringify(form))
  }
  function loadInputForm(draftId, ws = getWorkspaceId()) {
    try {
      const f = JSON.parse(storage?.getItem(inputFormKey(ws, draftId)) || 'null')
      return f && typeof f === 'object' ? f : null
    } catch { return null }
  }

  // 复用判定（纯）：便签存在且归属本来源、非失败、绑定把同一内容版本系到同一便签。
  function analysisReuse({ source, note, binding }) {
    if (!note || note.source_id !== source.id) return { reuse: false, reason: 'NO_NOTE' }
    if (note.status === 'failed') return { reuse: false, reason: 'ANALYSIS_FAILED' }
    if (!binding || binding.note_id !== note.id) return { reuse: false, reason: 'NO_BINDING' }
    if (!source.content_version || binding.content_version !== source.content_version) return { reuse: false, reason: 'CONTENT_CHANGED' }
    return { reuse: true, reason: null }
  }

  // ---- 选定资料快照：文字摘录来自用户选定原文（超长须用户缩小，绝不静默截断）； ----
  // 图片只带已绑定分析结果的字段候选（value+raw+quote），不二次 OCR。指纹按真实内容字节。
  async function buildSelectedSources({ sources, notesBySource = new Map(), excerpts = {} }) {
    if (sources.length > MAX_SELECTED_SOURCES) {
      throw fail('TOO_MANY_SOURCES', `一次最多选定 ${MAX_SELECTED_SOURCES} 份资料，请分批生成`)
    }
    const out = []
    for (const s of sources) {
      const bytes = await sourceContentBytes(s)
      const fingerprint = { sha256: await sha256Hex(bytes), bytes: bytes.length }
      let excerpt = null
      if (s.kind === 'text') {
        const override = excerpts[s.id]
        if (override != null) {
          if (typeof override !== 'string' || !override.trim() || !s.text.includes(override)) {
            throw fail('EXCERPT_NOT_IN_SOURCE', `资料 ${s.id} 的选定片段不在原文中，请重新选择`, { source_id: s.id })
          }
          if (override.length > MAX_EXCERPT_CHARS) {
            throw fail('EXCERPT_TOO_LONG', `资料 ${s.id} 选定片段超过 ${MAX_EXCERPT_CHARS} 字，请再缩小范围`, { source_id: s.id })
          }
          excerpt = override
        } else {
          if (s.text.length > MAX_EXCERPT_CHARS) {
            throw fail('EXCERPT_TOO_LONG', `资料 ${s.id} 全文超过 ${MAX_EXCERPT_CHARS} 字，请选定要发送的片段（全文仍留在本地）`, { source_id: s.id })
          }
          excerpt = s.text
        }
      }
      const note = notesBySource.get(s.id) ?? null
      const note_candidates = []
      if (note) {
        for (const f of note.fields ?? []) {
          if (f.status === 'missing') continue
          if ((f.raw ?? '').length > MAX_EXCERPT_CHARS || (f.quote?.text ?? '').length > MAX_EXCERPT_CHARS) {
            throw fail('FIELD_TEXT_TOO_LONG', `便签 ${note.id} 字段 ${f.key} 原文过长，请先在资料核对区精简`, { source_id: s.id })
          }
          note_candidates.push({
            note_id: note.id, field_key: f.key, value: f.value ?? null, raw: f.raw ?? '',
            origin: f.origin ?? 'model', status: f.status ?? 'candidate', derived: Boolean(f.derived),
            quote_text: f.quote?.text ?? null, precision: f.precision ?? null,
          })
        }
        if (note_candidates.length > 30) {
          throw fail('TOO_MANY_FIELDS', `便签 ${note.id} 字段超过 30 个，请精简后再生成`, { source_id: s.id })
        }
      }
      out.push({ source_id: s.id, kind: s.kind, fingerprint, excerpt, note_candidates })
    }
    return out
  }

  // ---- 排程上下文：与本地排程同口径（COUNTED_STATES 计占用）；起始日默认设备北京今天。 ----
  // replan 请求传 replacementIds：选定替换的安排不再占用容量（有效占用），protected_plans 只留保留部分。
  function buildPlanningContext({ today, startDate = null, budgets = {}, unavailable = [], planItems = [], replacementIds = [] }) {
    const start = startDate || today
    const un = new Set(unavailable)
    const replaced = new Set(replacementIds)
    const dates = windowDates(start)
    const windowSet = new Set(dates)
    // 预算来自输入框字符串：干净整数字符串转 number；空/缺省 → null；非法值保留原样交由契约校验拒绝。
    const coerceBudget = (v) => {
      if (v == null || v === '') return null
      if (typeof v === 'string') { const n = Number(v); return Number.isInteger(n) ? n : v }
      return v
    }
    const days = dates.map((date) => ({
      date,
      budget_minutes: un.has(date) ? 0 : coerceBudget(budgets[date]),
      committed_minutes: planItems
        .filter((p) => p.date === date && COUNTED_STATES.includes(p.state) && !replaced.has(p.id))
        .reduce((sum, p) => sum + p.planned_minutes, 0),
    }))
    const protected_plans = planItems
      .filter((p) => windowSet.has(p.date) && !replaced.has(p.id))
      .map((p) => ({ plan_item_id: p.id, task_id: p.task_id, date: p.date, planned_minutes: p.planned_minutes, state: p.state }))
    return { timezone: 'Asia/Shanghai', today, start_date: start, horizon_days: 7, days, protected_plans }
  }

  // ---- 请求组装：形状对照正式 schema；关联字段本地生成，绝不来自模型。 ----
  function buildRequest(input) {
    const req = { protocol_version: '1.0', intent: 'new_plan', previous_draft: null, ...input }
    const r = validateAgainstDef('AssistantProposeRequest', req)
    if (!r.ok) throw fail('REQUEST_INVALID', `请求不符合正式契约：${r.errors[0].path} ${r.errors[0].message}`, { errors: r.errors })
    return req
  }

  // ---- 接收核对：先形状，再逐关联字段对照冻结上下文；任一不符即拒收。 ----
  function checkReception(body, frozen) {
    const shape = validateAgainstDef('AssistantProposeResponse', body)
    if (!shape.ok) return { ok: false, code: 'RESPONSE_INVALID', message: `响应不符合正式契约：${shape.errors[0].path} ${shape.errors[0].message}` }
    if (body.protocol_version !== (frozen.protocol_version ?? '1.0')) return { ok: false, code: 'PROTOCOL_UNSUPPORTED', message: '响应协议版本与本轮请求不一致' }
    for (const k of ['request_id', 'thread_id', 'turn_id', 'client_seq', 'workspace_id']) {
      if (body[k] !== frozen[k]) return { ok: false, code: 'CORRELATION_MISMATCH', message: `响应 ${k} 与本轮请求不一致，拒收`, field: k }
    }
    if (!['clarification', 'proposal'].includes(body.payload?.kind)) {
      return { ok: false, code: 'UNSUPPORTED_PAYLOAD', message: `本版本不接收 ${body.payload?.kind} 结果` }
    }
    // 模型只建议：响应里的工作项一律 model 来源。标 user 等于冒用用户已确认值，
    // 会绕过「核对并保存为本次清单」的门槛；与后端语义守卫同口径，接收端再拒一次。
    if (body.payload.kind === 'proposal') {
      const forged = (body.payload.proposal?.work_items ?? []).find((w) => w.estimate_origin === 'user')
      if (forged) {
        return { ok: false, code: 'PROVENANCE_FORGED', message: `模型建议工作项 ${forged.key} 冒用用户来源（estimate_origin=user），已拒收` }
      }
    }
    return { ok: true }
  }

  // ---- 输入指纹：冻结本轮用户实际输入（要求文本/资料内容版本/选定对象/排程表单/选定片段）。 ----
  // 不含 committed_minutes 等世界事实——占用漂移由事实新鲜度与重排保护，不误判为「输入已改」。
  // replan 轮额外冻结替换范围与进展清单：改选择/工作量即作废迟到响应。
  function inputFingerprint({ userMessage, sources, taskIds = [], actionIds = [], schedule, excerpts = {}, replan = null }) {
    return canonicalJson({
      user_message: userMessage,
      sources: sources
        .map((s) => ({ id: s.id, content_version: s.content_version ?? null }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      task_ids: [...taskIds].sort(),
      action_ids: [...actionIds].sort(),
      schedule, excerpts, replan,
    })
  }

  return { loadBinding, saveBinding, saveInputForm, loadInputForm, analysisReuse, buildSelectedSources, buildPlanningContext, buildRequest, checkReception, inputFingerprint }
}

// 澄清续轮：先建结构化用户输入记录（user_answer 只来自用户实际提交），再渲染模型读到的合成文本。
// history 累积先前各轮「问/答」，绝不丢弃已回答内容；多轮澄清后仍保留全部回答（M2 审查 F2）。
// 返回 { text, userInput }：text 归档为 user_message 并发送，userInput 随归档消息与请求携带供出处核验。
export function composeClarificationMessage({ originalMessage, questions, answers, history = [] }) {
  // P2 收口：原始要求必须来自可信用户原文（首轮原话或结构化字段）；旧合成记录解析值不得充当。
  if (typeof originalMessage !== 'string' || !originalMessage.trim()) {
    throw fail('ORIGINAL_MISSING', '缺少可信的原始要求（旧澄清记录仅供展示），请重新发起生成')
  }
  const byId = new Map(questions.map((q) => [q.question_id, q]))
  const current = []
  for (const { question_id, answer } of answers) {
    const q = byId.get(question_id)
    if (!q) throw fail('UNKNOWN_QUESTION', `回答指向未知问题 ${question_id}`)
    if (typeof answer !== 'string' || !answer.trim()) throw fail('ANSWER_EMPTY', `问题「${q.question}」尚未回答`)
    current.push({ question: q.question, answer: answer.trim() })
  }
  if (answers.length !== questions.length) throw fail('ANSWERS_INCOMPLETE', '请回答全部澄清问题后再继续')
  const userInput = {
    original_user_request: originalMessage,
    clarifications: [...history, ...current].map((h) => ({ assistant_question: h.question, user_answer: h.answer })),
  }
  const text = renderUserInputText(userInput)
  if (text.length > MAX_USER_MESSAGE_CHARS) throw fail('MESSAGE_TOO_LONG', `合成消息超过 ${MAX_USER_MESSAGE_CHARS} 字，请精简回答`)
  return { text, userInput }
}

// 历轮问答解码与用户段解码统一在 domain/assistant/clarification（格式单一来源）；此处再导出供 store 沿用。
export { parseClarificationHistory }
