// 助手页面 store（M1 §9.2）：草案/采用服务的单例编排 + 页面共享态。
// 不复制业务文档/计算：任务/行动/安排事实一律来自 app store 与草案服务快照。
// 演示案例只在显式点击时载入演示空间；刷新只读已有线程/草案，绝不自动重播种。
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { createAssistantDraftService } from '../services/assistant/drafts'
import { createAssistantApplicationService } from '../services/assistant/applications'
import { createAssistantRequestService, composeClarificationMessage, parseClarificationHistory, MAX_AUTO_ANALYZE } from '../services/assistant/requests'
import { isComposedClarificationText } from '../domains/assistant/clarification'
import { propose } from '../services/api/client'
import { putSource } from '../services/storage/db'
import { canonicalJson } from '../domains/assistant/draft'
import { validateReplanScope, buildReplanProposal, replanDraftSignature } from '../domains/assistant/replan'
import { windowDates, COUNTED_STATES } from '../domains/planning/protocol'
import { beijingToday, beijingAddDays } from '../domains/time'
import { previewCounts } from '../domains/assistant/application'
import { useAppStore } from './app'

// 两服务共享同一 per-ws 队列：草案编辑/确认/重排与采用提交串行，不交叠。
const queues = new Map()
const draftService = createAssistantDraftService({ getWorkspaceId: () => useAppStore().workspaceId, queues })
const applicationService = createAssistantApplicationService({ getWorkspaceId: () => useAppStore().workspaceId, queues })
const requestService = createAssistantRequestService({ getWorkspaceId: () => useAppStore().workspaceId })

export const DEFAULT_USER_MESSAGE = '请根据所选资料拆解任务，并按我的可用时间安排。'
export const REPLAN_DEFAULT_USER_MESSAGE = '请助手整理剩余工作，给出建议工作清单。'

// 改排轮的用户要求：进展说明原话（用户实际填写）；未填写时用显式按钮意图的默认文本。
const replanUserMessage = (d) => (d?.progress_input?.statement ?? '').trim() || REPLAN_DEFAULT_USER_MESSAGE

const DEMO_TEXTS = {
  report: '演示原文（虚构）：请在本周完成周报。先整理本周进展，再撰写报告正文并核对。后天提交周报。',
  tight: '演示原文（虚构）：时间紧张版。请完成周报：整理进展 60 分钟、撰写正文 90 分钟。后天提交。每天只有半小时可用。',
}

function demoProposal(sourceId, today, userTurnId, userText) {
  const excerpt = '后天提交周报。'
  const ev = [{ kind: 'source_excerpt', source_id: sourceId, excerpt, locator: null }]
  return {
    task_proposals: [{
      op: 'create', key: 'rpt', title: '演示：提交周报', description: '虚构演示任务，可自由编辑。',
      completion_criteria: null,
      // 演示走真实「用户设置截止」路径（origin=user + 已记录用户消息），不伪造模型出处。
      deadline_candidates: [{
        value: beijingAddDays(today, 2), precision: 'date', origin: 'user', derived: false, basis: 'explicit',
        evidence_refs: [{ kind: 'user_message', turn_id: userTurnId, excerpt: userText }],
      }],
      evidence_refs: ev,
    }],
    action_proposals: [
      { op: 'create', key: 'a1', task_ref: { kind: 'draft', key: 'rpt' }, text: '整理本周进展', minutes: 60, basis: 'suggestion', evidence_refs: [] },
      { op: 'create', key: 'a2', task_ref: { kind: 'draft', key: 'rpt' }, text: '撰写报告正文并核对', minutes: 90, basis: 'suggestion', evidence_refs: [] },
    ],
    work_items: [
      { key: 'w1', task_ref: { kind: 'draft', key: 'rpt' }, action_ref: { kind: 'draft', key: 'a1' }, deliverable: '进展清单', remaining_minutes: 60, estimate_origin: 'model', splittable: true, min_segment_minutes: 25, earliest_date: null, depends_on: [], priority: 'normal' },
      { key: 'w2', task_ref: { kind: 'draft', key: 'rpt' }, action_ref: { kind: 'draft', key: 'a2' }, deliverable: '报告正文', remaining_minutes: 90, estimate_origin: 'model', splittable: true, min_segment_minutes: 25, earliest_date: null, depends_on: ['w1'], priority: 'normal' },
    ],
    requirement_candidates: [], evidence_refs: ev, assumptions: [], warnings: [],
  }
}

export const useAssistantStore = defineStore('assistant', () => {
  const app = useAppStore()

  const threads = ref([])
  const drafts = ref([])
  const active = ref(null) // draftService.get 结果：draft/thread/refs/readiness/factFreshness/baseline
  const prepared = ref(null) // { envelope, counts }
  const adoptResult = ref(null) // { outcome, receipt?, counts?, message? }
  const busy = ref({ loading: false, saving: false, rescheduling: false, adopting: false })
  const notice = ref(null) // { tone, text }
  const formDefaults = ref({ budget: 120 })
  // 内容改动后未重新排程：禁用采用，提示「更改尚未重新排程」。
  const stale = ref(false)
  // 排程被澄清阻断（如 D12 额外工作）时的结构化问题：供界面在排程前逐项确认，确认后再排程。
  const scheduleClarifications = ref([])

  const here = (result) => !!result && result.workspace_id === app.workspaceId
  const say = (tone, text) => { notice.value = { tone, text } }
  const clearPrepared = () => { prepared.value = null; adoptResult.value = null }

  // 改排面板实时输入（F1）：面板注册签名，页面/store 据此判定未保存修改。
  // 任何面板字段变化都算用户改动；签名与已保存草案（范围+清单+已确认约束）不一致即为 dirty。
  const replanForm = ref(null)
  const setReplanForm = (form) => { replanForm.value = form }
  const activeDraft = computed(() => active.value?.draft ?? null)
  const replanPanelDirty = computed(() => {
    const d = activeDraft.value
    const f = replanForm.value
    if (!d || d.mode !== 'replan' || !f || f.draftId !== d.id) return false
    return f.signature !== replanDraftSignature(d)
  })
  // 未保存输入一经出现，旧采用准备/结果立即失效；恢复一致后须重新核对采用。
  watch(replanPanelDirty, (v) => { if (v) clearPrepared() })
  const readiness = computed(() => active.value?.adoptionReadiness ?? active.value?.readiness ?? null)
  const canAdopt = computed(() => {
    const d = activeDraft.value
    return !!d && d.status === 'ready' && !stale.value && readiness.value?.ready && !busy.value.adopting
  })

  async function refreshActive() {
    if (!active.value) return
    const r = await draftService.get(active.value.draft.id)
    if (!here(r) || !r.ok) return
    active.value = r
  }

  // ready 由服务独立推导（事务内重核事实/确认）：内容+计算+确认齐备后沿冻结边
  // editing/needs_review/needs_clarification → generating → ready 推进；页面不直接传就绪值。
  async function promoteReady() {
    const a = active.value
    if (!a || stale.value) return
    if (!['editing', 'needs_clarification', 'needs_review'].includes(a.draft.status)) return
    if (!readiness.value?.ready) return
    const gen = await draftService.setStatus(a.draft.id, { expected: a.baseline.draft, status: 'generating' })
    if (!here(gen) || !gen.ok) return
    await refreshActive()
    const cur = active.value
    if (!cur || cur.draft.status !== 'generating') return
    const r = await draftService.setStatus(a.draft.id, { expected: cur.baseline.draft, status: 'ready' })
    if (here(r) && r.ok) await refreshActive()
  }

  // 进入页面/切换空间/刷新：先结算中断状态，再读列表。绝不自动创建演示数据。
  async function init() {
    busy.value.loading = true
    try {
      const settled = await draftService.settleRefresh()
      if (!here(settled)) return
      const r = await draftService.list()
      if (!here(r) || !r.ok) return
      threads.value = r.threads
      drafts.value = r.drafts
      if (active.value) {
        if (r.drafts.some((d) => d.id === active.value.draft.id)) await refreshActive()
        else active.value = null
      }
    } finally {
      busy.value.loading = false
    }
  }

  function reset() {
    if (gen.value) {
      activeController?.abort()
      activeController = null
      gen.value = null
    }
    input.value = { userText: '', sourceIds: [], taskIds: [], actionIds: [], budgets: {}, unavailable: [], startDate: null, excerpts: {} }
    inputRestore.value = null
    threads.value = []
    drafts.value = []
    active.value = null
    replanForm.value = null
    clearPrepared()
    notice.value = null
    stale.value = false
  }

  // F4：显式切换草案/线程或离开生成上下文 → 作废在途会话并取消等待，迟到结果不再抢页面。
  function invalidateGen() {
    if (gen.value) {
      activeController?.abort()
      activeController = null
      gen.value = null
    }
  }

  // F3：待澄清草案刷新后恢复继续入口。问题取线程最后一条澄清消息；历轮问答与原始要求取已归档用户消息；
  // 只重建澄清态，不重发付费请求、不恢复旧在途授权（requestId=null，续轮由用户显式发起新身份）。
  function restoreClarification(r) {
    const msgs = r.thread?.messages ?? []
    let ci = -1
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'assistant' && msgs[i].type === 'clarification') { ci = i; break }
    }
    if (ci < 0) return
    let questions = null
    try { questions = JSON.parse(msgs[ci].content).questions } catch { return }
    if (!Array.isArray(questions) || questions.length === 0) return
    const userMsgs = msgs.filter((m) => m.role === 'user' && m.type === 'text')
    const lastUser = userMsgs[userMsgs.length - 1]
    // R1 结构化优先：原始要求/历轮问答直接读 user_input 字段。
    // P2 收口（差异文档 §8）：旧合成澄清记录零可信段——解析结果仅供只读展示（legacyDisplay），
    // history 置空，提示用户重新填写真实回答；原始要求取首条非合成用户消息原文（首轮原话，可信）。
    const ui = lastUser?.user_input ?? null
    const legacyUntrusted = ui == null && isComposedClarificationText(lastUser?.content ?? '')
    const originalMessage = ui?.original_user_request
      ?? userMsgs.find((m) => !isComposedClarificationText(m.content))?.content ?? ''
    const history = ui
      ? (ui.clarifications ?? []).map((t) => ({ question: t.assistant_question, answer: t.user_answer }))
      : []
    const legacyDisplay = legacyUntrusted ? parseClarificationHistory(lastUser?.content ?? '') : []
    gen.value = {
      phase: 'clarification', requestId: null, turnId: null,
      clientSeq: msgs.filter((m) => m.type === 'clarification').length,
      threadId: r.draft.thread_id, draftId: r.draft.id,
      userMessage: lastUser?.content ?? originalMessage, userInput: ui,
      originalMessage, history, isContinuation: true, legacyUntrusted, legacyDisplay,
      questions, error: null, retained: null, pendingAnalysis: null, frozen: null, progress: '',
    }
  }

  async function open(draftId) {
    busy.value.loading = true
    try {
      const r = await draftService.get(draftId)
      if (!here(r)) return
      if (!r.ok) { say('warning', r.message || '草案不存在或不属于当前空间'); return }
      // 切换到另一草案：先作废在途生成（内部成功路径 receiveInto 打开同草案，gen.draftId 相同，不作废）。
      if (gen.value && gen.value.draftId !== draftId) invalidateGen()
      // F3/R2：先恢复输入表单再设置 active——页面 watch(flush:sync) 会立即按 input 重建排程窗口预算。
      // 恢复不限待澄清：凡非终态（仍可编辑/需继续生成或排程）的草案都恢复其本空间已保存输入；
      // 已排程草案由 planning_input 优先（initWindow 以 planning_input.days/start_date 为准），旧输入不覆盖更新的有效计算输入。
      // 只恢复输入元数据，不恢复旧请求授权、不自动重发模型请求。
      const terminal = r.draft.status === 'applied' || r.draft.status === 'discarded'
      const saved = terminal ? null : requestService.loadInputForm(draftId)
      if (saved) {
        input.value = { ...input.value, ...saved }
        inputRestore.value = 'restored'
      } else if (r.draft.planning_input) {
        inputRestore.value = 'planning'
      } else if (!terminal) {
        inputRestore.value = 'missing'
      } else {
        inputRestore.value = null
      }
      active.value = r
      clearPrepared()
      stale.value = false
      notice.value = null
      if (!gen.value && r.draft.status === 'needs_clarification') restoreClarification(r)
    } finally {
      busy.value.loading = false
    }
  }

  function close() {
    invalidateGen()
    active.value = null
    replanForm.value = null
    clearPrepared()
    stale.value = false
  }

  function revisePlanRequest() {
    const draft = activeDraft.value
    if (!draft || draft.mode === 'replan') return
    const saved = requestService.loadInputForm(draft.id)
    const firstRequest = active.value.thread?.messages?.find(m => m.role === 'user' && m.type === 'text')
    const next = {
      userText: firstRequest?.user_input?.original_user_request ?? firstRequest?.content ?? '',
      sourceIds: (draft.source_refs ?? []).filter(ref => ref.object_type === 'source').map(ref => ref.id),
      taskIds: [], actionIds: [], excerpts: {}, startDate: null, budgets: {}, unavailable: [],
      ...saved,
    }
    next.sourceIds = next.sourceIds.filter(id => app.sources.some(source => source.id === id))
    const schedule = draft.planning_input
    if (schedule?.days?.length) {
      next.startDate = schedule.start_date
      next.budgets = Object.fromEntries(schedule.days.map(day => [day.date, day.budget_minutes]))
      next.unavailable = schedule.days.filter(day => day.budget_minutes === 0).map(day => day.date)
    }
    close()
    input.value = next
  }

  // ---- 演示载入（显式点击）：个人空间先切演示空间并明确提示；日期按点击时北京今天生成。 ----
  async function loadDemo(kind = 'report') {
    busy.value.loading = true
    try {
      if (app.workspaceId !== 'demo') {
        await app.switchWorkspace('demo')
        say('info', '已切换到演示空间：演示数据与个人空间隔离，可随时切回。')
      }
      const today = beijingToday()
      const text = DEMO_TEXTS[kind] ?? DEMO_TEXTS.report
      const source = { id: crypto.randomUUID(), kind: 'text', captured_at: new Date().toISOString(), text }
      await putSource(source)
      await app.reload()
      const demoMsgId = crypto.randomUUID()
      const demoUserText = `我把任务「演示：提交周报」的截止设为 ${beijingAddDays(today, 2)}。`
      const proposal = demoProposal(source.id, today, demoMsgId, demoUserText)
      const r = await draftService.create({
        title: kind === 'tight' ? '演示：容量紧张（缺口确认）' : '演示：跨天周报',
        selectedRefs: [{ object_type: 'source', id: source.id }],
        proposal,
        sourceRefs: [{ object_type: 'source', id: source.id }],
      })
      if (!here(r)) return
      if (!r.ok) { say('warning', r.message || '演示草案创建失败'); return }
      // 用户消息证据须真实落线程（与 setManualDeadline 同路径），供 origin=user 候选追溯。
      const msg = await draftService.appendMessage(r.draft.thread_id, {
        message: { role: 'user', content: demoUserText, type: 'text' }, messageId: demoMsgId,
      })
      if (!here(msg)) return
      if (!msg.ok) { say('warning', msg.message || '演示用户消息保存失败'); return }
      formDefaults.value = { budget: kind === 'tight' ? 30 : 120 }
      await init()
      await open(r.draft.id)
      say('info', '演示草案已载入（虚构数据）。编辑后点「重新排程」，再按提示确认即可采用。')
    } catch (err) {
      say('warning', `演示载入失败：${err.message}`)
    } finally {
      busy.value.loading = false
    }
  }

  // ---- 内容编辑：走草案服务完整基线；实质修改后标记未重排并清空已冻结采用。 ----
  async function editContent(edits) {
    if (!active.value) return { ok: false }
    busy.value.saving = true
    try {
      const r = await draftService.edit(active.value.draft.id, { expected: active.value.baseline.draft, edits })
      if (!here(r)) return r
      if (!r.ok) { say('warning', r.message || '保存失败'); return r }
      await refreshActive()
      if (r.bumped) { stale.value = true; clearPrepared(); scheduleClarifications.value = [] }
      return r
    } finally {
      busy.value.saving = false
    }
  }

  async function confirm(confirmation) {
    if (!active.value) return { ok: false }
    busy.value.saving = true
    try {
      const r = await draftService.confirm(active.value.draft.id, { expected: active.value.baseline.draft, confirmation })
      if (!here(r)) return r
      if (!r.ok) { say('warning', r.message || '确认失败'); return r }
      await refreshActive()
      clearPrepared()
      await promoteReady()
      return r
    } finally {
      busy.value.saving = false
    }
  }

  const confBase = (objectType, objectIdOrKey, extra = {}) => ({
    confirmation_id: crypto.randomUUID(),
    draft_revision: active.value.draft.revision,
    object_type: objectType,
    object_id_or_key: objectIdOrKey,
    field_path: '',
    old_value: null,
    new_value: null,
    confirmed_at: new Date().toISOString(),
    ...extra,
  })

  // 模型候选截止确认 / 明确无截止（create 基线恒 null）。确认≠改值：不改 proposal。
  const confirmDeadline = (taskKey, newValue) => confirm(confBase('task', taskKey, {
    field_path: 'deadline', id_scope: 'draft', old_value: null, new_value: newValue,
  }))
  const confirmGap = (workItemKey) => confirm(confBase('gap', workItemKey, { new_value: true }))
  const scheduleGap = (key, slot) => confirm(confBase('gap', key, { field_path: 'manual_slot', new_value: slot }))
  const confirmOverbook = (date) => confirm(confBase('overbook', date, { new_value: true }))
  const confirmExtraWork = (workItemKey) => confirm(confBase('extra_work', workItemKey, { new_value: true }))

  // ---- M3 改排：范围/进展由本地用户输入产生；资格校验与领域函数同口径，任何不合格整体拒绝。 ----
  const replanCtx = (taskId, startDate) => ({
    workspaceId: app.workspaceId,
    task: app.docs.find((d) => d.kind === 'task' && d.id === taskId) ?? null,
    today: beijingToday(),
    window: new Set(windowDates(startDate)),
    planItems: app.docs.filter((d) => d.kind === 'plan_item'),
    focusSessions: app.docs.filter((d) => d.kind === 'focus_session'),
  })
  const replanActions = () => app.docs.filter((d) => d.kind === 'action')

  // 任务详情/助手页入口：校验范围与清单 → 本地构建建议 → 创建 replan 草案（基线在首次排程时冻结）。
  async function startReplan({ taskId, replacementIds, progress, constraints = [] }) {
    const startDate = beijingToday()
    const scope = { task_id: taskId, start_date: startDate, replacement_ids: [...replacementIds] }
    let proposal
    let task
    try {
      validateReplanScope(scope, replanCtx(taskId, startDate))
      task = app.docs.find((d) => d.kind === 'task' && d.id === taskId)
      proposal = buildReplanProposal(progress, task, replanActions(), constraints)
    } catch (e) {
      say('warning', e.message)
      return { ok: false, code: e.code || 'REPLAN_INVALID', message: e.message }
    }
    const r = await draftService.create({
      title: `调整后续安排：${task.title}`.slice(0, 30),
      mode: 'replan', replanScope: scope, progressInput: progress, proposal,
    })
    if (!here(r)) return r
    if (!r.ok) { say('warning', r.message || '改排草案创建失败'); return r }
    input.value.startDate = startDate
    scheduleClarifications.value = []
    await init()
    await open(r.draft.id)
    say('info', '改排草案已创建：确认替换范围后点「重新排程」，预览保留/取消/新增再采用。')
    return r
  }

  // 替换范围确认（含「清单不含保留安排覆盖的工作」）：绑定当前版本；内容/排程 bump 后须重新确认。
  const confirmReplanScope = () => confirm(confBase('replan_scope', activeDraft.value.replan_scope.task_id, { new_value: true }))

  // 选择集/进展清单一次保存：范围重校验 + 建议重建同事务提交，避免两次 bump 的中间态。
  async function saveReplanContent({ replacementIds, progress, constraints = [] }) {
    const d = activeDraft.value
    if (!d || d.mode !== 'replan') return { ok: false, code: 'NOT_REPLAN', message: '当前草案不是改排草案' }
    const scope = { ...d.replan_scope, replacement_ids: [...replacementIds] }
    let proposal
    try {
      validateReplanScope(scope, replanCtx(scope.task_id, scope.start_date))
      const task = app.docs.find((t) => t.kind === 'task' && t.id === scope.task_id)
      proposal = buildReplanProposal(progress, task, replanActions(), constraints)
    } catch (e) {
      say('warning', e.message)
      return { ok: false, code: e.code || 'REPLAN_INVALID', message: e.message }
    }
    return editContent({ replan_scope: scope, progress_input: progress, proposal })
  }

  // 起始日改为未来日期：范围随窗口重校验（所选条目落出窗口 → 拒绝，须重新勾选）。
  async function setReplanStart(startDate) {
    const d = activeDraft.value
    if (!d || d.mode !== 'replan') return { ok: false, code: 'NOT_REPLAN', message: '当前草案不是改排草案' }
    if (startDate === d.replan_scope.start_date) return { ok: true, unchanged: true }
    const scope = { ...d.replan_scope, start_date: startDate }
    try {
      validateReplanScope(scope, replanCtx(scope.task_id, startDate))
    } catch (e) {
      say('warning', `起始日修改未保存：${e.message}`)
      return { ok: false, code: e.code || 'REPLAN_INVALID', message: e.message }
    }
    return editContent({ replan_scope: scope })
  }

  // 手动设置新建任务截止：先留用户消息（证据），再写 origin=user 候选，最后确认。
  // 仅 create 任务；link 任务沿用正式截止，不提供绕过修改（M1 不支持 Task update）。
  async function setManualDeadline(taskKey, value) {
    if (!active.value) return { ok: false }
    const draft = active.value.draft
    const tp = (draft.proposal?.task_proposals ?? []).find((t) => t.key === taskKey && t.op === 'create')
    if (!tp) return { ok: false, message: '只能为新建任务设置截止' }
    const precision = value == null ? 'none' : (value.includes('T') ? 'datetime' : 'date')
    let candidates = tp.deadline_candidates ?? []
    if (value != null) {
      const content = `我把任务「${tp.title}」的截止设为 ${value}。`
      const msg = await draftService.appendMessage(draft.thread_id, { message: { role: 'user', content, type: 'text' }, messageId: undefined })
      if (!here(msg) || !msg.ok) { say('warning', msg.message || '用户消息保存失败'); return msg }
      candidates = [{
        value, precision, origin: 'user', derived: false, basis: 'explicit',
        evidence_refs: [{ kind: 'user_message', turn_id: msg.message.id, excerpt: content }],
      }]
    }
    const proposal = {
      ...draft.proposal,
      task_proposals: draft.proposal.task_proposals.map((t) => (t.key === taskKey ? { ...t, deadline_candidates: candidates } : t)),
    }
    const edited = await editContent({ proposal })
    if (!edited.ok) return edited
    // 编辑后 revision 已 bump；确认绑定新版本。
    return confirmDeadline(taskKey, value == null ? null : { value, precision })
  }

  // ---- 重新排程：页面表单 → PlanningContext；真实 normalize/schedule 由服务完成。 ----
  async function reschedule({ startDate, budgets, unavailable = [] }) {
    if (!active.value) return { ok: false }
    busy.value.rescheduling = true
    try {
      const today = beijingToday()
      const start = startDate || today
      const unavailableSet = new Set(unavailable)
      const days = Array.from({ length: 7 }, (_, i) => {
        const date = beijingAddDays(start, i)
        return { date, budget_minutes: unavailableSet.has(date) ? 0 : (budgets[date] ?? null) }
      })
      const r = await draftService.reschedule(active.value.draft.id, {
        expected: active.value.baseline.draft,
        context: { timezone: 'Asia/Shanghai', today, start_date: start, horizon_days: 7, days },
      })
      if (!here(r)) return r
      if (!r.ok) {
        if (r.code === 'NEEDS_CLARIFICATION') {
          scheduleClarifications.value = r.clarifications ?? []
          say('info', '排程前需先确认下方事项（如额外工作），确认后请再次「重新排程」。')
        } else {
          scheduleClarifications.value = []
          say('warning', r.message || '排程失败')
        }
        await refreshActive()
        return r
      }
      scheduleClarifications.value = []
      await refreshActive()
      stale.value = false
      clearPrepared()
      await promoteReady()
      return r
    } finally {
      busy.value.rescheduling = false
    }
  }

  // ---- 采用：prepare 冻结 → 用户确认面板（页面）→ apply。成功后刷新业务列表。 ----
  async function prepare() {
    if (!active.value) return { ok: false }
    const r = await applicationService.prepare(active.value.draft.id, { expected: active.value.baseline.draft })
    if (!here(r)) return r
    if (!r.ok) { say('warning', r.message || '采用准备失败'); await refreshActive(); return r }
    prepared.value = { envelope: r.envelope, counts: r.counts ?? previewCounts(r.envelope.write_set) }
    if (r.outcome === 'already_committed') adoptResult.value = { outcome: 'already_committed', receipt: r.receipt }
    return r
  }

  async function adopt() {
    if (!active.value || busy.value.adopting) return { ok: false }
    // 提交入口复核（F1）：弹窗打开后改排面板出现未保存输入时，不得提交旧意图。
    if (replanPanelDirty.value) {
      say('warning', '改排面板有未保存修改，旧方案不能采用；请先「保存改排内容」并重新排程')
      return { ok: false, code: 'REPLAN_UNSAVED', message: '改排面板有未保存修改' }
    }
    busy.value.adopting = true
    try {
      const expected = active.value.baseline.draft
      // R1：提交弹窗所绑定的准备身份；不悄悄重新准备替换。需重新准备时由用户再点「采用计划」。
      const bound = prepared.value
      if (!bound?.envelope) {
        say('warning', '请先点「采用计划」完成准备与核对，再采用')
        return { ok: false, code: 'NO_PREPARED', message: '没有已绑定的采用准备' }
      }
      const r = await applicationService.apply(active.value.draft.id, { expected, envelope: bound.envelope })
      if (!here(r)) {
        // 迟到结果不应用到新空间；原空间事实已落库与否由刷新结算收敛。
        return r
      }
      adoptResult.value = r
      if (r.ok) {
        try {
          await app.reloadDocs()
        } catch {
          say('warning', '已保存，列表刷新失败；请手动刷新页面查看新任务与安排。')
        }
        await refreshActive()
        await init()
      } else {
        say('warning', r.message || '采用未提交')
        await refreshActive()
      }
      return r
    } finally {
      busy.value.adopting = false
    }
  }

  async function resolveResult() {
    if (!active.value) return { ok: false }
    const r = await applicationService.resolve(active.value.draft.id)
    if (!here(r)) return r
    if (r.ok) {
      adoptResult.value = r
      await refreshActive()
      if (r.outcome === 'applied') {
        try { await app.reloadDocs() } catch { say('warning', '已保存，列表刷新失败') }
      }
    } else {
      say('warning', r.message || '核实失败')
    }
    return r
  }

  // 补充要求只存为用户文本消息，明确不参与解析/排程。
  async function appendUserText(content) {
    if (!active.value) return { ok: false }
    const r = await draftService.appendMessage(active.value.draft.thread_id, { message: { role: 'user', content, type: 'text' }, messageId: undefined })
    if (here(r) && r.ok) await refreshActive()
    else if (here(r) && !r.ok) say('warning', r.message || '文本保存失败')
    return r
  }

  async function forkDraft() {
    if (!active.value) return { ok: false }
    const r = await draftService.fork(active.value.draft.id, { expected: active.value.baseline.draft })
    if (!here(r)) return r
    if (!r.ok) { say('warning', r.message || '新建草案失败'); return r }
    await init()
    await open(r.draft.id)
    say('info', '已基于当前内容新建草案；原采用授权不继承，须重新确认与排程。')
    return r
  }

  async function discardDraft() {
    if (!active.value) return { ok: false }
    const r = await draftService.discard(active.value.draft.id, { expected: active.value.baseline.draft })
    if (!here(r)) return r
    if (!r.ok) { say('warning', r.message || '放弃失败'); return r }
    await refreshActive()
    await init()
    return r
  }

  // ---- M2 真实生成生命周期（开工单 §3/§6）----
  // 输入表单归 store 所有：接收时按当前表单重算输入指纹，生成期间改输入 → 拒收本轮结果。
  const input = ref({
    userText: '', sourceIds: [], taskIds: [], actionIds: [],
    budgets: {}, unavailable: [], startDate: null, excerpts: {},
  })
  // R2：打开草案时输入来源标记。restored=读回已保存输入；planning=沿用已排程计算输入；
  // missing=无已保存输入且未排程（页面提示补填，默认值不冒充已恢复的用户设置）；null=终态只读。
  const inputRestore = ref(null)
  // gen：本轮请求的冻结上下文与阶段机。phase: preparing/requesting/save_failed/failed/clarification/done
  // 注意：ref 会把轮对象包成响应式代理，身份比较一律用 requestId，不能用对象引用；
  // AbortController 是原生对象，不能进响应式状态（代理上调用原生方法会 Illegal invocation），单独存放。
  const gen = ref(null)
  let activeController = null
  const generating = computed(() => !!gen.value && ['preparing', 'requesting'].includes(gen.value.phase))
  // 生成在途保护（F1）：面板当前签名；与发起轮时不同则拒收本轮结果，旧响应不覆盖新编辑。
  const liveReplanSig = (draftId) => {
    const d = activeDraft.value
    const f = replanForm.value
    return d && d.id === draftId && d.mode === 'replan' && f && f.draftId === d.id ? f.signature : null
  }
  const replanUnsavedFor = (draftId) => {
    const d = activeDraft.value
    return !!d && d.id === draftId && d.mode === 'replan' && replanPanelDirty.value
  }
  const blockUnsavedReplan = () => {
    say('warning', '改排面板有未保存修改；请先「保存改排内容」再继续生成')
    return { ok: false, code: 'REPLAN_UNSAVED', message: '改排面板有未保存修改' }
  }

  const effectiveUserText = () => input.value.userText.trim() || DEFAULT_USER_MESSAGE
  const liveSources = () => input.value.sourceIds.map((id) => app.sources.find((s) => s.id === id)).filter(Boolean)
  const scheduleForm = () => ({
    start_date: input.value.startDate || null,
    budgets: input.value.budgets,
    unavailable: [...input.value.unavailable].sort(),
  })
  function currentInputDigest(userMessage, draftId = null) {
    const d = draftId ? drafts.value.find((x) => x.id === draftId) : activeDraft.value
    const replan = d?.mode === 'replan' ? { scope: d.replan_scope, progress: d.progress_input } : null
    return requestService.inputFingerprint({
      userMessage, sources: liveSources(), taskIds: input.value.taskIds, actionIds: input.value.actionIds,
      schedule: scheduleForm(), excerpts: input.value.excerpts, replan,
    })
  }

  // 切换空间：立即作废在途请求（迟到结果由 runRound 的 stopped 检查拒收）；原空间草案由刷新结算收敛。
  watch(() => app.workspaceId, () => {
    if (gen.value) {
      activeController?.abort()
      activeController = null
      gen.value = null
    }
  })

  async function settleGenerating(draftId) {
    if (!draftId) return
    const cur = await draftService.get(draftId)
    if (!here(cur) || !cur.ok || cur.draft.status !== 'generating') return
    const r = await draftService.setStatus(draftId, { expected: cur.baseline.draft, status: 'needs_review' })
    // 结算直接写库会改变草案记录；同步 active 基线，避免后续确认/排程按旧基线报「已被其它页面修改」。
    if (here(r) && r.ok && active.value?.draft?.id === draftId) await refreshActive()
  }

  // 失败/取消后的 generating→needs_review 结算是异步的；新一轮必须先等它落定，
  // 否则旧结算会在新轮冻结基线之后改写草案，造成接收 CONFLICT。
  let pendingSettle = Promise.resolve()

  async function failRound(g, code, message) {
    if (gen.value?.requestId !== g.requestId) return
    activeController = null
    // 先等异步结算把草案从 generating 收敛并刷新基线，再显示失败面板：
    // 否则用户立刻点确认/排程会按旧基线与库里新记录冲突。
    pendingSettle = settleGenerating(g.draftId)
    await pendingSettle
    if (gen.value?.requestId !== g.requestId) return
    gen.value.phase = 'failed'
    gen.value.error = { code, message }
    say('warning', message)
  }

  async function cancelSettle(g) {
    if (gen.value?.requestId !== g.requestId) return
    activeController = null
    gen.value = null
    pendingSettle = settleGenerating(g.draftId)
    await pendingSettle
    say('info', '已取消生成；输入与已有内容保留，可重新生成。')
  }

  // 改排快照（M3）：单任务 + 该任务全部行动 + 有效占用上下文 + replan_context。
  // 待替换/保留摘要来自实时本地事实；进展清单来自草案已保存的用户输入，不从模型文字解析。
  function buildReplanSnapshot(draft, thread) {
    const scope = draft.replan_scope
    const ctx = replanCtx(scope.task_id, scope.start_date)
    validateReplanScope(scope, ctx)
    const task = ctx.task
    const dl = task.deadline ?? {}
    const deadline = (dl.precision ?? 'none') === 'none'
      ? { value: null, precision: 'none' }
      : { value: dl.value, precision: dl.precision, source: dl.source ?? 'note', from_note_id: dl.from_note_id ?? null, confirmed_at: dl.confirmed_at ?? null }
    const selectedTasks = [{ id: task.id, title: task.title, status: task.status ?? 'todo', deadline, current_action_id: task.current_action_id ?? null, updated_at: task.updated_at }]
    const selectedActions = app.docs
      .filter((d) => d.kind === 'action' && d.task_id === scope.task_id)
      .map((a) => ({ id: a.id, task_id: a.task_id, text: a.text, minutes: a.minutes, basis: a.basis ?? 'user', done: Boolean(a.done) }))
    const planItems = app.docs.filter((d) => d.kind === 'plan_item')
    const replaced = new Set(scope.replacement_ids)
    const windowSet = new Set(windowDates(scope.start_date))
    const summary = (p) => ({ plan_item_id: p.id, date: p.date, planned_minutes: p.planned_minutes, action_text: p.action_text, state: p.state })
    const replacements = planItems.filter((p) => replaced.has(p.id)).map(summary)
    const kept = planItems
      .filter((p) => p.task_id === scope.task_id && windowSet.has(p.date) && !replaced.has(p.id) && COUNTED_STATES.includes(p.state))
      .map(summary)
    const context = requestService.buildPlanningContext({
      today: beijingToday(), startDate: scope.start_date, budgets: input.value.budgets, unavailable: input.value.unavailable,
      planItems, replacementIds: scope.replacement_ids,
    })
    const replanContext = { task_id: scope.task_id, progress: draft.progress_input, replacements, kept }
    return { selectedSources: [], selectedTasks, selectedActions, context, confirmedRequirements: thread?.confirmed_requirements ?? [], replanContext }
  }

  // 快照构建：图片先复用绑定分析，缺失才自动分析（≤3 份逐份）；文字摘录来自用户选定原文。
  // g 传 gen.value（响应式代理），进度/待存分析写入才能触发界面更新；controller 不进响应式状态。
  async function buildSnapshot(g, thread, controller, draft = null) {
    if (draft?.mode === 'replan') return buildReplanSnapshot(draft, thread)
    const inp = input.value
    const sources = liveSources()
    if (sources.length !== inp.sourceIds.length) throw Object.assign(new Error('部分选定资料已不存在，请重新选择'), { code: 'SOURCE_MISSING' })
    const notesBySource = new Map()
    let analyzed = 0
    for (const s of sources) {
      if (controller.signal.aborted) throw Object.assign(new Error('已取消'), { code: 'cancelled' })
      const note = app.docs.find((d) => d.kind === 'note' && d.source_id === s.id) ?? null
      const decision = requestService.analysisReuse({ source: s, note, binding: requestService.loadBinding(s.id) })
      if (s.kind === 'image') {
        if (decision.reuse) {
          if (!(note.fields ?? []).length) throw Object.assign(new Error(`资料「${s.name || s.id}」的分析结果为空，请补充说明或重新选择`), { code: 'ANALYSIS_INSUFFICIENT' })
          notesBySource.set(s.id, note)
          continue
        }
        if (analyzed >= MAX_AUTO_ANALYZE) throw Object.assign(new Error(`本轮最多自动分析 ${MAX_AUTO_ANALYZE} 份新图片，其余请分批生成（不会静默跳过）`), { code: 'TOO_MANY_UNANALYZED' })
        analyzed += 1
        g.progress = `正在分析资料 ${analyzed}/${MAX_AUTO_ANALYZE}…`
        let r
        if (g.pendingAnalysis && g.pendingAnalysis.sourceId === s.id && g.pendingAnalysis.contentVersion === s.content_version) {
          r = await app.saveAnalysisNote(g.pendingAnalysis.note)
          if (r.ok) g.pendingAnalysis = null
        } else {
          r = await app.analyzeForAssistant(s.id, { signal: controller.signal })
        }
        if (controller.signal.aborted) throw Object.assign(new Error('已取消'), { code: 'cancelled' })
        if (!r.ok) {
          if (r.code === 'SAVE_FAILED' && r.note) {
            g.pendingAnalysis = { sourceId: s.id, note: r.note, contentVersion: s.content_version }
            throw Object.assign(new Error(`${r.message}；重试将仅保存分析结果，不重调模型`), { code: 'ANALYSIS_SAVE_FAILED' })
          }
          if (r.code === 'cancelled') throw Object.assign(new Error('已取消'), { code: 'cancelled' })
          throw Object.assign(new Error(`资料「${s.name || s.id}」分析失败：${r.message}（原文已在本地保留）`), { code: r.code || 'ANALYZE_FAILED' })
        }
        requestService.saveBinding(s.id, { content_version: s.content_version, note_id: r.note.id })
        if (!(r.note.fields ?? []).length) throw Object.assign(new Error(`资料「${s.name || s.id}」的分析结果为空，请补充说明或重新选择`), { code: 'ANALYSIS_INSUFFICIENT' })
        notesBySource.set(s.id, r.note)
      } else if (decision.reuse) {
        notesBySource.set(s.id, note)
      }
    }
    g.progress = '正在组装请求…'
    const selectedSources = await requestService.buildSelectedSources({ sources, notesBySource, excerpts: inp.excerpts })
    const selectedTasks = []
    for (const id of inp.taskIds) {
      const t = app.docs.find((d) => d.kind === 'task' && d.id === id)
      if (!t) throw Object.assign(new Error(`选定任务 ${id} 已不存在，请重新选择`), { code: 'TASK_MISSING' })
      const dl = t.deadline ?? {}
      const deadline = (dl.precision ?? 'none') === 'none'
        ? { value: null, precision: 'none' }
        : { value: dl.value, precision: dl.precision, source: dl.source ?? 'note', from_note_id: dl.from_note_id ?? null, confirmed_at: dl.confirmed_at ?? null }
      selectedTasks.push({ id: t.id, title: t.title, status: t.status ?? 'todo', deadline, current_action_id: t.current_action_id ?? null, updated_at: t.updated_at })
    }
    const taskIdSet = new Set(inp.taskIds)
    const selectedActions = []
    for (const id of inp.actionIds) {
      const a = app.docs.find((d) => d.kind === 'action' && d.id === id)
      if (!a) throw Object.assign(new Error(`选定行动 ${id} 已不存在，请重新选择`), { code: 'ACTION_MISSING' })
      if (!taskIdSet.has(a.task_id)) throw Object.assign(new Error('选定的行动必须属于已选定的任务'), { code: 'ACTION_TASK_UNSELECTED' })
      selectedActions.push({ id: a.id, task_id: a.task_id, text: a.text, minutes: a.minutes, basis: a.basis ?? 'user', done: Boolean(a.done) })
    }
    const context = requestService.buildPlanningContext({
      today: beijingToday(), startDate: inp.startDate, budgets: inp.budgets, unavailable: inp.unavailable,
      planItems: app.docs.filter((d) => d.kind === 'plan_item'),
    })
    return { selectedSources, selectedTasks, selectedActions, context, confirmedRequirements: thread?.confirmed_requirements ?? [] }
  }

  // 结果落库：版本/空间约束接收；保存失败留结果重试（不重调模型），冲突类失败明确需重新生成。
  async function receiveInto(g, body, expected) {
    const r = await draftService.receiveResult(g.draftId, { expected, response: body })
    if (gen.value?.requestId !== g.requestId) return
    const cur = gen.value
    if (r.ok) {
      activeController = null
      cur.retained = null
      if (body.payload.kind === 'clarification') {
        cur.phase = 'clarification'
        cur.questions = body.payload.questions
        say('info', '模型需要澄清以下问题，请集中回答后继续生成。')
      } else {
        cur.phase = 'done'
        say('success', '方案已生成：请核对事实与建议，重新排程后预览采用。')
      }
      await init()
      await open(g.draftId)
      return
    }
    if (r.code === 'SAVE_FAILED') {
      activeController = null
      cur.phase = 'save_failed'
      cur.retained = { response: body, expected }
      cur.error = { code: r.code, message: r.message }
      say('warning', `结果已收到但本地保存失败（${r.message}）。可重试保存，不会重调模型。`)
      return
    }
    activeController = null
    cur.phase = 'failed'
    cur.error = { code: r.code, message: `${r.message || '结果无法应用'}；如需采用请重新生成` }
    pendingSettle = settleGenerating(g.draftId)
    say('warning', cur.error.message)
  }

  // 一轮真实请求：归档用户消息 → generating → 快照 → 冻结 → propose → 核对接收。
  async function runRound({ threadId, draftId, userMessage, turnId, clientSeq, originalMessage, isContinuation, history = [], pendingAnalysis = null, userInput = null }) {
    const ws = app.workspaceId
    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    activeController = controller
    const g = {
      phase: 'preparing', requestId, turnId, clientSeq, threadId, draftId,
      userMessage, userInput, originalMessage, isContinuation, history,
      questions: null, error: null, retained: null, pendingAnalysis,
      frozen: null, progress: '正在保存输入…',
    }
    gen.value = g
    // F3：持久化本轮输入表单（本机元数据），供待澄清草案刷新后恢复预算/起始日等已填输入。
    requestService.saveInputForm(draftId, {
      userText: input.value.userText, sourceIds: [...input.value.sourceIds],
      taskIds: [...input.value.taskIds], actionIds: [...input.value.actionIds],
      budgets: { ...input.value.budgets }, unavailable: [...input.value.unavailable],
      startDate: input.value.startDate, excerpts: { ...input.value.excerpts },
    })
    const stopped = () => gen.value?.requestId !== requestId || app.workspaceId !== ws
    const cancelled = () => controller.signal.aborted
    try {
      await pendingSettle
      if (stopped()) return
      const msg = await draftService.appendMessage(threadId, {
        message: { role: 'user', content: userMessage, type: 'text', ...(userInput != null ? { user_input: userInput } : {}) },
        messageId: turnId,
      })
      if (stopped()) return
      if (cancelled()) return cancelSettle(g)
      if (!msg.ok) return failRound(g, msg.code || 'SAVE_FAILED', `${msg.message || '用户消息保存失败'}，未发起模型调用`)
      let cur = await draftService.get(draftId)
      if (stopped()) return
      if (cancelled()) return cancelSettle(g)
      if (!cur.ok) return failRound(g, cur.code || 'NOT_FOUND', '草案读取失败，未发起模型调用')
      if (cur.draft.status !== 'generating') {
        const st = await draftService.setStatus(draftId, { expected: cur.baseline.draft, status: 'generating' })
        if (stopped()) return
        if (cancelled()) return cancelSettle(g)
        if (!st.ok) return failRound(g, st.code || 'INVALID_TRANSITION', st.message || '草案无法进入生成状态')
        cur = await draftService.get(draftId)
        if (stopped()) return
        if (cancelled()) return cancelSettle(g)
      }
      const expected = cur.baseline.draft
      const snap = await buildSnapshot(gen.value, cur.thread, controller, cur.draft)
      if (stopped()) return
      if (cancelled()) return cancelSettle(g)
      const req = requestService.buildRequest({
        ...(snap.replanContext ? { protocol_version: '1.1', intent: 'replan_task', replan_context: snap.replanContext } : {}),
        request_id: requestId, thread_id: threadId, turn_id: turnId, client_seq: clientSeq,
        workspace_id: ws, user_message: userMessage, ...(userInput != null ? { user_input: userInput } : {}),
        selected_sources: snap.selectedSources, selected_tasks: snap.selectedTasks, selected_actions: snap.selectedActions,
        planning_context: snap.context, confirmed_requirements: snap.confirmedRequirements, pending_requirements: [],
      })
      const frozen = {
        protocol_version: snap.replanContext ? '1.1' : '1.0',
        request_id: requestId, thread_id: threadId, turn_id: turnId, client_seq: clientSeq, workspace_id: ws,
        inputDigest: currentInputDigest(userMessage, draftId),
      }
      const replanSig = liveReplanSig(draftId)
      gen.value.frozen = frozen
      gen.value.phase = 'requesting'
      gen.value.progress = '等待模型响应…'
      const res = await propose(req, { signal: controller.signal })
      if (stopped()) return
      if (res.kind === 'cancelled' || cancelled()) return cancelSettle(g)
      if (!res.ok) return failRound(g, res.code || 'http_error', res.message || `生成失败（${res.status}）；输入已保留`)
      const check = requestService.checkReception(res.body, frozen)
      if (!check.ok) return failRound(g, check.code, check.message)
      const liveMessage = isContinuation || snap.replanContext ? userMessage : effectiveUserText()
      if (currentInputDigest(liveMessage, draftId) !== frozen.inputDigest) {
        return failRound(g, 'INPUT_CHANGED', '生成期间输入已变化，本次结果未采用；请按当前输入重新生成')
      }
      if (replanSig != null && liveReplanSig(draftId) !== replanSig) {
        return failRound(g, 'INPUT_CHANGED', '生成期间改排输入已变化，本次结果未采用；请先「保存改排内容」再重新生成')
      }
      await receiveInto(g, res.body, expected)
    } catch (err) {
      if (stopped()) return
      if (cancelled() || err?.code === 'cancelled') return cancelSettle(g)
      return failRound(g, err.code || 'GENERATE_FAILED', err.message || '生成失败；输入已保留')
    }
  }

  // 发起生成：先本地保存线程+草案（原始输入留痕），再进入请求轮。重复点击不产生并行付费请求。
  async function generate() {
    if (generating.value) return { ok: false, code: 'BUSY', message: '正在生成中，请先等待或取消' }
    if (gen.value?.phase === 'save_failed') return { ok: false, code: 'SAVE_PENDING', message: '有已收到但未保存的结果，请先重试保存或放弃该结果' }
    const inp = input.value
    if (!inp.sourceIds.length && !inp.userText.trim()) {
      say('warning', '请先上传截图、粘贴文字或选择已有资料，或填写任务要求')
      return { ok: false, code: 'NO_INPUT' }
    }
    const userMessage = effectiveUserText()
    const refs = inp.sourceIds.map((id) => ({ object_type: 'source', id }))
    const created = await draftService.create({ title: userMessage.slice(0, 30), selectedRefs: refs, sourceRefs: refs })
    if (!here(created)) return created
    if (!created.ok) { say('warning', `${created.message || '输入保存失败'}，未发起模型调用`); return created }
    scheduleClarifications.value = []
    await runRound({
      threadId: created.draft.thread_id, draftId: created.draft.id, userMessage,
      turnId: crypto.randomUUID(), clientSeq: 1, originalMessage: userMessage, isContinuation: false,
      userInput: { original_user_request: userMessage, clarifications: [] },
    })
    return { ok: gen.value?.phase === 'done' || gen.value?.phase === 'clarification', draftId: created.draft.id }
  }

  function cancelGeneration() {
    const g = gen.value
    if (!g || !['preparing', 'requesting'].includes(g.phase)) return
    activeController?.abort()
  }

  // 改排生成（M3）：同线程同草案发起 replan_task 轮；用户要求=进展说明原话（或显式默认文本）。
  // 模型建议只是建议：接收后仍须用户核对清单并保存为本次清单，才可排程采用。
  async function generateReplan() {
    if (generating.value) return { ok: false, code: 'BUSY', message: '正在生成中，请先等待或取消' }
    if (gen.value?.phase === 'save_failed') return { ok: false, code: 'SAVE_PENDING', message: '有已收到但未保存的结果，请先重试保存或放弃该结果' }
    const d = activeDraft.value
    if (!d || d.mode !== 'replan') return { ok: false, code: 'NOT_REPLAN', message: '当前草案不是改排草案' }
    // F1：生成只使用已保存的最新输入；面板有未保存修改时明确阻断，不拿旧清单请助手整理。
    if (replanPanelDirty.value) {
      say('warning', '改排面板有未保存修改；请先「保存改排内容」，确保助手整理的是你确认的最新清单')
      return { ok: false, code: 'REPLAN_UNSAVED', message: '改排面板有未保存修改' }
    }
    if (!['editing', 'needs_clarification', 'needs_review', 'ready'].includes(d.status)) {
      return { ok: false, code: 'NOT_EDITABLE', message: `草案状态 ${d.status} 不可发起生成` }
    }
    const cur = await draftService.get(d.id)
    if (!here(cur)) return cur
    if (!cur.ok) return cur
    const userMessage = replanUserMessage(cur.draft)
    const clientSeq = cur.thread.messages.filter((m) => m.role === 'user').length + 1
    scheduleClarifications.value = []
    await runRound({
      threadId: d.thread_id, draftId: d.id, userMessage,
      turnId: crypto.randomUUID(), clientSeq, originalMessage: userMessage, isContinuation: false,
      userInput: { original_user_request: userMessage, clarifications: [] },
    })
    return { ok: gen.value?.phase === 'done' || gen.value?.phase === 'clarification', draftId: d.id }
  }

  // 澄清续轮：原要求+历轮已回答问答+本轮问题与明确回答合成本轮 user_message，真实归档；同线程同草案，seq+1。
  async function continueClarification(answers) {
    const g = gen.value
    if (!g || g.phase !== 'clarification') return { ok: false, code: 'NOT_CLARIFYING', message: '当前没有待回答的澄清' }
    if (replanUnsavedFor(g.draftId)) return blockUnsavedReplan()
    let userMessage
    let userInput
    try {
      const composed = composeClarificationMessage({ originalMessage: g.originalMessage, questions: g.questions, answers, history: g.history ?? [] })
      userMessage = composed.text
      userInput = composed.userInput
    } catch (e) {
      say('warning', e.message)
      return { ok: false, code: e.code, message: e.message }
    }
    // F2：把本轮问答并入历轮历史，下一轮继续累积，绝不丢弃先前已回答内容。
    const byId = new Map((g.questions ?? []).map((q) => [q.question_id, q]))
    const history = [...(g.history ?? []), ...answers.map(({ question_id, answer }) => ({
      question: byId.get(question_id)?.question ?? question_id, answer: String(answer).trim(),
    }))]
    await runRound({
      threadId: g.threadId, draftId: g.draftId, userMessage, userInput,
      turnId: crypto.randomUUID(), clientSeq: g.clientSeq + 1, originalMessage: g.originalMessage, isContinuation: true, history,
    })
    return { ok: gen.value?.phase === 'done' || gen.value?.phase === 'clarification' }
  }

  // 失败重试：同线程同草案新一轮（新 turn/request，seq+1）；分析保存失败时先仅落库不重调模型。
  async function retryGeneration() {
    const g = gen.value
    if (!g || g.phase !== 'failed') return { ok: false, code: 'NOT_FAILED', message: '当前没有可重试的失败' }
    if (replanUnsavedFor(g.draftId)) return blockUnsavedReplan()
    await runRound({
      threadId: g.threadId, draftId: g.draftId, userMessage: g.userMessage, userInput: g.userInput ?? null,
      turnId: crypto.randomUUID(), clientSeq: g.clientSeq + 1, originalMessage: g.originalMessage, isContinuation: g.isContinuation,
      history: g.history ?? [], pendingAnalysis: g.pendingAnalysis,
    })
    return { ok: gen.value?.phase === 'done' || gen.value?.phase === 'clarification' }
  }

  // 保存失败重试：只落库已收到结果，不重调模型；重核关联/输入/草案版本，任一不符 → 需重新生成。
  async function retrySaveResult() {
    const g = gen.value
    if (!g || g.phase !== 'save_failed' || !g.retained) return { ok: false, code: 'NO_RETAINED', message: '没有可重试保存的结果' }
    if (app.workspaceId !== g.frozen.workspace_id) {
      g.phase = 'failed'; g.retained = null; g.error = { code: 'WORKSPACE_CHANGED', message: '空间已切换，结果不再适用；请重新生成' }
      say('warning', g.error.message)
      return { ok: false }
    }
    const cur = await draftService.get(g.draftId)
    if (!here(cur) || !cur.ok || canonicalJson(cur.baseline.draft) !== canonicalJson(g.retained.expected)) {
      g.phase = 'failed'; g.retained = null; g.error = { code: 'DRAFT_CHANGED', message: '草案已变化，留存结果不再适用；请重新生成' }
      pendingSettle = settleGenerating(g.draftId)
      say('warning', g.error.message)
      return { ok: false }
    }
    const liveMessage = g.isContinuation || g.frozen.protocol_version === '1.1' ? g.userMessage : effectiveUserText()
    if (currentInputDigest(liveMessage, g.draftId) !== g.frozen.inputDigest) {
      g.phase = 'failed'; g.retained = null; g.error = { code: 'INPUT_CHANGED', message: '输入已变化，留存结果不再适用；请重新生成' }
      pendingSettle = settleGenerating(g.draftId)
      say('warning', g.error.message)
      return { ok: false }
    }
    await receiveInto(g, g.retained.response, g.retained.expected)
    return { ok: gen.value?.phase === 'done' || gen.value?.phase === 'clarification' }
  }

  // 结束本轮提示（失败/澄清/完成/留存结果）：放弃留存结果时明确告知需重新生成；草案内容保留。
  async function dismissGeneration() {
    const g = gen.value
    if (!g) return
    if (g.phase === 'save_failed' && g.retained) {
      say('info', '已放弃未保存的结果；如需方案请重新生成。')
      pendingSettle = settleGenerating(g.draftId)
      await pendingSettle
    }
    gen.value = null
  }

  return {
    threads, drafts, active, prepared, adoptResult, busy, notice, formDefaults, stale, scheduleClarifications,
    activeDraft, readiness, canAdopt, replanPanelDirty, setReplanForm, clearPrepared,
    input, inputRestore, gen, generating,
    init, reset, open, close, revisePlanRequest, loadDemo,
    editContent, confirm, confirmDeadline, confirmGap, scheduleGap, confirmOverbook, confirmExtraWork, setManualDeadline,
    startReplan, confirmReplanScope, saveReplanContent, setReplanStart,
    appendUserText, reschedule, prepare, adopt, resolveResult, forkDraft, discardDraft,
    generate, generateReplan, cancelGeneration, continueClarification, retryGeneration, retrySaveResult, dismissGeneration,
    say,
  }
})
