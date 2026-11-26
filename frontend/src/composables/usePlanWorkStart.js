// 5A-2B 共享开始控制（开工单 §3）：PlanDetail 与 TaskDetail 共用同一确认面板状态机。
// 打开即冻结 workspace/taskId/actionId/planItemId/安排快照/确认事实；显示值与提交值同一快照。
// 信封在首次提交意图时签发一次，同输入重试复用；事实变化/改确认=新意图新信封。
// 页面预检查（planStartEntry）只用于解释入口，最终资格由 focus.begin 事务决定。
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import {
  LIVE_PLAN_STATES, historySignature, isLiveRef, planSnapshot, planSnapshotDiff, summarizePlanTime, unfinishedSessionsForPlan,
} from '@/domains/plan'
import { beginFactsDiff, beginFactsOf } from '@/domains/focus'
import { beijingToday } from '@/domains/time'
import { workPath } from '@/domains/workNavigation'

// —— 入口优先级（§3.1，纯函数）：同安排未结束 > 本空间其它未结束 > 跨空间运行 > 资格 > 旧历史 > 可开始 ——
// localUnfinished 传本空间首个未结束会话；crossWsRunning 传 focus.running 中非本空间项。
export function planStartEntry({ plan, task, docs, localUnfinished = null, crossWsRunning = null }) {
  if (plan) {
    const existing = unfinishedSessionsForPlan(docs, plan)[0]
    if (existing) return { kind: 'existing', session: existing }
  }
  if (localUnfinished) return { kind: 'local-conflict', session: localUnfinished }
  if (crossWsRunning) return { kind: 'cross-ws', running: crossWsRunning }
  if (!plan || !isLiveRef(plan) || !task) return { kind: 'ineligible', reason: 'dead-ref' }
  if (task.status === 'done') return { kind: 'ineligible', reason: 'task-done' }
  if (!LIVE_PLAN_STATES.includes(plan.state)) return { kind: 'ineligible', reason: 'terminal' }
  const summary = summarizePlanTime(plan, docs)
  if (!summary.authoritative) return { kind: 'history-unresolved', problems: summary.problems }
  if (plan.state === 'planned' && summary.endedSessionCount > 0) return { kind: 'review', history: historySignature(summary) }
  return { kind: 'start' }
}

// 任务截止的冻结副本（显示/风险确认用）：与 expected/facts 同一次读取冻结，不追 live。
const deadlineOf = (t) => (t.deadline ? { value: t.deadline.value ?? null, precision: t.deadline.precision || 'none' } : null)

// 回调由宿主提供：onStarted(sid, meta) 导航；onGotoTask(planId) 带执行上下文去任务页；
// onReview(planId) 打开既有进度核对；workReturnFor(session) 给出工作页 return 地址。
export function usePlanWorkStart({ onStarted, onGotoTask, onReview, workReturnFor }) {
  const store = useAppStore()
  const focus = useFocusStore()
  const router = useRouter()

  // state: { ws, taskId, planId, actionId, taskTitle, taskStatus, taskDeadline, expected, facts, confirmDate,
  //          blockedChecked, dateChecked, blockedPrompt, busy, phase, error, envelope, input,
  //          diffRows, diffFrozen, pendingSid }
  // 显示/日期关系/风险确认/提交统一派生自同一份已冻结且已展示的确认版本（expected/facts/taskTitle/taskDeadline）；
  // 安排日不另设独立字段，一律取 expected.date，避免 confirmDiffs 后 expected.date 与显示日期漂移。
  const state = ref(null)
  const open = computed(() => !!state.value)

  watch(() => store.workspaceId, (ws) => {
    if (state.value && state.value.ws !== ws) state.value = null
  })

  const planDate = computed(() => (state.value && state.value.expected ? state.value.expected.date : null))
  const blockedRequired = computed(() => !!state.value && (state.value.taskStatus === 'blocked' || state.value.blockedPrompt))
  const dateMismatch = computed(() => !!state.value && !!state.value.planId && planDate.value !== state.value.confirmDate)
  const canConfirm = computed(() => {
    const s = state.value
    if (!s || s.busy || s.phase !== 'confirm' || !s.actionId) return false
    if (blockedRequired.value && !s.blockedChecked) return false
    if (dateMismatch.value && !s.dateChecked) return false
    return true
  })

  // 打开面板：冻结目标与事实。无有效当前行动也允许打开（禁用开始，提供去任务选择）。
  function openFor({ taskId, planId = null, actionId = null }) {
    const t = store.tasks.find((x) => x.id === taskId)
    if (!t) return false
    const p = planId ? store.docs.find((d) => d.kind === 'plan_item' && d.id === planId) || null : null
    if (planId && (!p || !isLiveRef(p) || p.task_id !== taskId)) return false
    const a = actionId ? store.actions.find(item => item.id === actionId && item.task_id === t.id &&
      item.workspace_id === store.workspaceId && !item.done) : store.currentActionOf(t)
    if (actionId && !a) return false
    const confirmDate = beijingToday()
    state.value = {
      ws: store.workspaceId, taskId, planId: p ? p.id : null,
      actionId: a ? a.id : null, taskTitle: t.title, taskStatus: t.status, taskDeadline: deadlineOf(t),
      expected: p ? planSnapshot(p) : null,
      facts: a ? beginFactsOf(t, a, confirmDate) : null,
      confirmDate,
      blockedChecked: false, dateChecked: false, blockedPrompt: false,
      busy: false, phase: 'confirm', error: null, envelope: null, input: null,
      diffRows: null, diffFrozen: null, pendingSid: null,
    }
    return true
  }

  function cancel() {
    if (state.value && state.value.busy) return
    state.value = null
  }

  function buildInput(s) {
    const input = { taskId: s.taskId, actionId: s.actionId }
    if (s.planId) {
      input.planItemId = s.planId
      input.expected = s.expected
      input.facts = s.facts
    }
    if ((s.taskStatus === 'blocked' || s.blockedPrompt) && s.blockedChecked) input.confirmBlocked = true
    return input
  }

  async function submit() {
    const s = state.value
    if (!s || s.busy || !s.actionId) return
    if (!s.input) {
      s.input = buildInput(s)
      const env = focus.issueRequest('begin', s.input)
      s.envelope = { requestId: env.request_id, issuedAtMs: env.issued_at_ms }
    }
    s.busy = true
    s.error = null
    let r
    try {
      r = await focus.begin({ ...s.input, requestId: s.envelope.requestId, issuedAtMs: s.envelope.issuedAtMs })
    } catch (err) {
      r = { ok: false, code: 'SAVE_FAILED', message: (err && err.message) || '开始失败', workspace_id: s.ws }
    }
    // 晚到结果按作用域丢弃：空间已切换不导航、不清新页面状态。
    if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
    s.busy = false
    if (r.workspace_id && r.workspace_id !== s.ws) {
      s.error = { message: '结果属于其它空间，已忽略；未在当前空间创建会话。' }
      return
    }
    if (r.ok || r.code === 'PLAN_SESSION_EXISTS') {
      const sid = (r.session && r.session.id) || r.session_id || null
      if (!sid) {
        s.error = { message: '开始结果缺少会话标识，请核实后重试。' }
        s.phase = 'verify'
        return
      }
      await navigateVerified(sid, { existing: r.code === 'PLAN_SESSION_EXISTS', samePlan: !!r.samePlan })
      return
    }
    await handleFailure(r, s)
  }

  // 成功/回到已有工作：重读验证真实会话后才导航（replay 回执只有 session_id，不假定 r.session 存在）。
  // 稳定 session_id 先保留再读取；补充读取失败进入待核实（只重读，不重新 begin），finally 释放忙碌。
  async function navigateVerified(sid, meta) {
    const s = state.value
    if (!s) return
    s.busy = true
    s.pendingSid = sid
    try {
      await focus.loadWorkspace()
    } catch {
      if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
      s.phase = 'verify'
      s.error = { message: '已收到开始结果，读取待核实：会话可能已创建。可重试读取，不会重新创建。' }
      return
    } finally {
      s.busy = false
    }
    if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
    const found = focus.sessions.find((x) => x.id === sid && x.ended_at == null)
    if (!found) {
      s.phase = 'verify'
      s.error = { message: '开始结果待核实：尚未读到该会话。可重试读取，不会重新创建。' }
      return
    }
    const cb = onStarted
    state.value = null
    if (cb) cb(sid, { ...meta, session: found })
  }

  async function handleFailure(r, s) {
    switch (r.code) {
      case 'ALREADY_ACTIVE':
      case 'LEGACY_RECOVERY_REQUIRED':
        s.error = {
          code: r.code, session: r.session || null,
          message: r.code === 'LEGACY_RECOVERY_REQUIRED'
            ? '存在旧版未结束会话，需先到该工作页显式结束后才能开始新工作。'
            : (r.session && r.session.workspace_id !== s.ws ? '其它空间已有运行中的会话，请先处理或明确切换空间。' : '本空间已有未结束的工作（含暂停），先处理它再开始新的一段。'),
        }
        return
      case 'STALE_PLAN':
      case 'BEGIN_FACTS_CHANGED':
        await showDiffs(s)
        return
      case 'PLAN_REVIEW_REQUIRED':
        s.error = { code: r.code, reviewPlanId: s.planId, history: r.history || null, message: r.message || '该安排已有结束历史，请先人工核对进度后再开始。' }
        return
      case 'HISTORY_UNRESOLVED':
        s.error = { code: r.code, problems: r.problems || [], message: r.message || '该安排的历史用时记录存在异常，请先核对处理后再开始。' }
        return
      case 'SAVE_FAILED':
        s.phase = 'verify'
        s.error = { code: r.code, message: '开始结果待核实：事务可能已提交也可能未提交。请核实结果或用原信封重试，不会重新创建。' }
        return
      case 'STALE_REQUEST':
      case 'REQUEST_ENVELOPE_REQUIRED':
        s.envelope = null
        s.phase = 'stale'
        s.error = { code: r.code, message: `${r.message || '请求信封失效'}。请先核实是否已开始，再重新核对事实发起新意图。` }
        return
      default:
        if (r.needsConfirmBlocked) {
          s.blockedPrompt = true
          s.blockedChecked = false
          s.input = null
          s.envelope = null
          s.error = { code: 'CONFIRM_BLOCKED', message: '任务处于受阻状态：勾选确认「开始后任务将转为进行中」后才能开始。' }
          return
        }
        s.error = { code: r.code, message: r.message || '开始失败，未创建会话。' }
    }
  }

  // 差异重确认（§3.3）：开框即冻结最新快照/事实，列全差异；确认只换到展示过的那一版，不追 live。
  async function showDiffs(s) {
    s.busy = true
    try {
      await store.reloadDocs()
    } catch {
      if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
      s.error = { message: '读取最新事实失败，未能列出差异。可再次点击开始重试读取；不会按旧事实创建。' }
      return
    } finally {
      s.busy = false
    }
    if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
    const livePlan = s.planId ? store.docs.find((d) => d.kind === 'plan_item' && d.id === s.planId) || null : null
    const liveTask = store.tasks.find((t) => t.id === s.taskId) || null
    const liveAction = s.actionId ? store.actions.find((a) => a.id === s.actionId) || null : null
    if ((s.planId && !livePlan) || !liveTask || !liveAction) {
      s.error = { message: '安排/任务/行动已不存在或失效，无法按最新事实重新确认。请返回处理。' }
      return
    }
    const today = beijingToday()
    const frozen = {
      expected: livePlan ? planSnapshot(livePlan) : null,
      facts: livePlan ? beginFactsOf(liveTask, liveAction, today) : null,
      confirmDate: today,
      taskTitle: liveTask.title,
      taskStatus: liveTask.status,
      taskDeadline: deadlineOf(liveTask),
    }
    const rows = []
    if (s.expected && frozen.expected) {
      for (const d of planSnapshotDiffRows(s.expected, frozen.expected)) rows.push(d)
    }
    if (s.facts && frozen.facts) {
      for (const d of beginFactsDiff(s.facts, frozen.facts)) rows.push({ group: 'fact', ...d })
    }
    s.diffFrozen = frozen
    s.diffRows = rows
    s.phase = 'diffs'
    s.error = { code: 'FACTS_CHANGED', message: '确认期间事实已变化。请核对下列全部差异后重新确认；未重新确认不会提交。' }
  }

  function confirmDiffs() {
    const s = state.value
    if (!s || !s.diffFrozen) return
    s.expected = s.diffFrozen.expected
    s.facts = s.diffFrozen.facts
    s.confirmDate = s.diffFrozen.confirmDate
    s.taskTitle = s.diffFrozen.taskTitle
    s.taskStatus = s.diffFrozen.taskStatus
    s.taskDeadline = s.diffFrozen.taskDeadline
    s.diffFrozen = null
    s.diffRows = null
    s.blockedChecked = false
    s.dateChecked = false
    s.input = null
    s.envelope = null
    s.phase = 'confirm'
    s.error = null
  }

  // 核实（SAVE_FAILED/信封失效/成功但读取失败）：只读重查，绝不重新创建。
  async function verify() {
    const s = state.value
    if (!s || s.busy) return
    s.busy = true
    try {
      await focus.loadWorkspace()
      await store.reloadDocs()
    } catch {
      if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
      s.error = { message: '读取失败，核实未完成。可重试读取；不会重新创建。' }
      return
    } finally {
      s.busy = false
    }
    if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
    if (s.pendingSid) {
      const found = focus.sessions.find((x) => x.id === s.pendingSid && x.ended_at == null)
      if (found) {
        const cb = onStarted
        state.value = null
        if (cb) cb(found.id, { verified: true, session: found })
      } else {
        s.error = { message: '核实结果：尚未读到该会话。可重试读取或原信封重试。' }
      }
      return
    }
    const inp = s.input
    const issuedMs = s.envelope ? s.envelope.issuedAtMs : 0
    const match = inp ? focus.sessions.find((x) =>
      x.ended_at == null && x.task_id === inp.taskId && x.action_id === inp.actionId
      && (inp.planItemId ? x.plan_item_id === inp.planItemId : true)
      && Date.parse(x.started_at) >= issuedMs - 1000) : null
    if (match) {
      const cb = onStarted
      state.value = null
      if (cb) cb(match.id, { verified: true, session: match })
      return
    }
    s.phase = 'verify'
    s.error = { message: '核实结果：尚未提交。可原信封重试，或取消后重新发起。' }
  }

  // 信封失效后重新核对：按 live 事实重冻结（新意图），保留用户已选行动，不自动换绑。
  async function refreeze() {
    const s = state.value
    if (!s || s.busy) return
    s.busy = true
    try {
      await store.reloadDocs()
    } catch {
      if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
      s.error = { message: '读取最新事实失败，未能重新核对。可重试；不会按旧事实创建。' }
      return
    } finally {
      s.busy = false
    }
    if (!state.value || state.value !== s || store.workspaceId !== s.ws) return
    const liveTask = store.tasks.find((t) => t.id === s.taskId) || null
    const liveAction = s.actionId ? store.actions.find((a) => a.id === s.actionId) || null : null
    const livePlan = s.planId ? store.docs.find((d) => d.kind === 'plan_item' && d.id === s.planId) || null : null
    if (!liveTask || !liveAction || (s.planId && !livePlan)) {
      s.error = { message: '任务/行动/安排已失效，请返回处理后再开始。' }
      return
    }
    const today = beijingToday()
    s.taskTitle = liveTask.title
    s.taskStatus = liveTask.status
    s.taskDeadline = deadlineOf(liveTask)
    s.expected = livePlan ? planSnapshot(livePlan) : null
    s.facts = beginFactsOf(liveTask, liveAction, today)
    s.confirmDate = today
    s.blockedChecked = false
    s.dateChecked = false
    s.blockedPrompt = false
    s.input = null
    s.envelope = null
    s.pendingSid = null
    s.phase = 'confirm'
    s.error = null
  }

  function gotoSession(session) {
    if (!session) return
    const ret = workReturnFor ? workReturnFor(session) : '/today'
    state.value = null
    router.push(workPath(session.id, ret))
  }
  function gotoTask() {
    const s = state.value
    if (!s || !s.planId) return
    state.value = null
    if (onGotoTask) onGotoTask(s.planId)
  }
  function gotoReview() {
    const s = state.value
    if (!s || !s.planId) return
    state.value = null
    if (onReview) onReview(s.planId)
  }

  return {
    state, open, planDate, blockedRequired, dateMismatch, canConfirm,
    openFor, cancel, submit, confirmDiffs, verify, refreeze, gotoSession, gotoTask, gotoReview,
  }
}

// 快照差异行（复用单一来源 planSnapshotDiff，避免第二套字段规则）。
const PLAN_FIELD_NAMES = { task_id: '所属任务', date: '安排日期', state: '状态', action_text: '工作说明', planned_minutes: '预计分钟', task_ref_state: '任务引用' }
function planSnapshotDiffRows(expected, frozen) {
  return planSnapshotDiff(expected, frozen).map((d) => ({ group: 'plan', name: PLAN_FIELD_NAMES[d.field] || d.field, ...d }))
}