<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import {
  ArrowLeft, CircleAlert, CircleCheck, CloudOff, LoaderCircle, Pause, Play, RefreshCw, Square,
} from 'lucide-vue-next'
import {
  DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle,
} from 'reka-ui'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import EndSessionForm, { forgetEndSelection } from '@/components/domain/EndSessionForm.vue'
import WorkMaterials from '@/components/domain/WorkMaterials.vue'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { useWorkDraft } from '@/composables/useWorkDraft'
import { registerWorkLeave, requestWorkLeave, resetWorkLeaveApproval } from '@/composables/workLeave'
import { formatDurationMs, sessionActionText, sessionTitle } from '@/domains/work'
import { beijingDateStr, beijingInstantLabel } from '@/domains/time'
import {
  planSnapshot, planSnapshotDiff, summarizePlanTime, historySignature, endedSessionsForPlan,
  planRisk, isLiveRef, LIVE_PLAN_STATES,
} from '@/domains/plan'
import { recordPath, resolveWorkReturn, schedulePath } from '@/domains/workNavigation'
import { SESSION_OUTCOME_LABELS, PLAN_STATE_LABELS, PLAN_FIELD_LABELS, planFieldValueLabel, planActualLabel, label } from '@/domains/labels'
import { slotDeadlineLabel } from '@/domains/week'

const app = useAppStore()
const focus = useFocusStore()
const route = useRoute()
const router = useRouter()

const sessionId = computed(() => String(route.params.sessionId || ''))
const session = computed(() => focus.sessions.find((s) => s.id === sessionId.value) || null)
const rt = computed(() => focus.coordination.find((r) => r.session_id === sessionId.value) || null)
const task = computed(() => (session.value ? app.tasks.find((t) => t.id === session.value.task_id) || null : null))
const liveAction = computed(() => (session.value ? app.actions.find((a) => a.id === session.value.action_id) || null : null))

const ready = computed(() => app.ready && focus.ready)
const invalid = ref(false)
let loadedId = null
let navigatedAway = false
// 外部结束（其它页面持有者结束）且本页仍有未保存输入时进入只读核对，不立即转历史。
const endedReview = ref(false)

// 每秒只刷新视觉计时与租约倒计时；每 5 秒同步协调事实（检查点/其它页面接管/结束）。
// 检查点持久化由既有 service 调度，页面不另起第二套计时写入。
const nowMs = ref(Date.now())
let tick = null
let poll = null
// 聚焦/重新可见时主动读取最新协调状态（其它页面接管/结束/续租），不只靠 5 秒轮询。
function refreshCoordination() { if (app.ready && !navigatedAway) focus.loadWorkspace() }
function onVisibility() { if (document.visibilityState === 'visible') refreshCoordination() }
onMounted(() => {
  tick = setInterval(() => { nowMs.value = Date.now() }, 1000)
  poll = setInterval(refreshCoordination, 5000)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('focus', refreshCoordination)
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
  if (poll) clearInterval(poll)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('focus', refreshCoordination)
  document.removeEventListener('visibilitychange', onVisibility)
  unregisterLeave()
})
// 意外关页只能恢复到最近成功保存的内容：脏输入时给出浏览器原生提示，不作为保存渠道。
function onBeforeUnload(e) {
  if (session.value && session.value.ended_at == null && holderValid.value && draft.dirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

const isV1 = computed(() => !!session.value && session.value.record_version === 1)
const holderValid = computed(() =>
  !!rt.value && rt.value.owner_id === focus.ownerId && !rt.value.recovery && rt.value.lease_expires_at > nowMs.value)
const otherHolder = computed(() =>
  !!rt.value && rt.value.owner_id !== focus.ownerId && rt.value.lease_expires_at > nowMs.value)
const leaseExpired = computed(() => !!rt.value && rt.value.lease_expires_at <= nowMs.value)
const recoveryPending = computed(() => !!rt.value && !!rt.value.recovery && !otherHolder.value)
const needTakeover = computed(() => !!rt.value && !otherHolder.value && !rt.value.recovery && leaseExpired.value)
// 结束结果待核实期间锁定提交输入与正文编辑（§6.2 简单路径）：先核实/原信封重试，不悄悄换新意图。
const endVerifyPending = ref(false)
const editable = computed(() =>
  !!session.value && session.value.ended_at == null && isV1.value && holderValid.value && !opBusy.value && !leavingBusy.value && !endBusy.value && !endVerifyPending.value)

const draft = useWorkDraft({ app, focus, sessionId, session, rt, editable })

// 深链接/刷新：等 app.ready 与本次读取完成再判定；无效不白屏、不自动新建、不静默切空间。
// 已结束会话访问执行 URL → 转只读详情。
watch([ready, sessionId, () => focus.sessions], () => {
  if (!ready.value || !sessionId.value || navigatedAway) return
  if (!session.value) {
    invalid.value = true
    return
  }
  invalid.value = false
  if (session.value.ended_at != null) {
    // 外部结束且本页仍有未保存输入 → 只读核对：停止写入、保留本地文本与数据库最终成果，不立即转历史。
    // 本页自己成功结束已在 submitEnd 清理草稿并置 navigatedAway；无脏输入的已结束深链接仍正常转历史。
    if (loadedId === sessionId.value && (draft.dirty.value || draft.conflict.value)
        && (draft.text.value || '') !== (session.value.draft_md || '')) {
      endedReview.value = true
      draft.frozen.value = true
      return
    }
    navigatedAway = true
    router.replace(recordPath(sessionId.value, typeof route.query.return === 'string' ? route.query.return : ''))
    return
  }
  if (loadedId !== sessionId.value) {
    endedReview.value = false
    loadedId = sessionId.value
    draft.loadFromDb()
  }
}, { immediate: true })

// —— 所属安排与返回上下文（5A-2B §4/§5）：return 精确校验，丢失/非法按会话真实关联构造安全目标 ——
const todayStr = computed(() => beijingDateStr(new Date(app.nowTick)))
const navCtx = computed(() => ({ docs: app.docs, ws: app.workspaceId, todayStr: todayStr.value }))
const workReturn = computed(() => resolveWorkReturn(route.query.return, session.value, navCtx.value))
const returnOpensPlan = computed(() => {
  const target = router.resolve(workReturn.value)
  return target.path === '/today' && target.query.plan === session.value?.plan_item_id
})
const returnLabel = computed(() => {
  const r = workReturn.value
  if (returnOpensPlan.value) return '返回安排'
  if (r.startsWith('/today')) return '返回日程'
  if (r.startsWith('/tasks/')) return '返回任务'
  return '返回'
})
const planLinked = computed(() => !!session.value && session.value.plan_item_id != null)
const plan = computed(() => {
  if (!planLinked.value) return null
  return app.docs.find((d) => d.id === session.value.plan_item_id && d.kind === 'plan_item' && d.workspace_id === app.workspaceId) || null
})
const planSummary = computed(() => (plan.value ? summarizePlanTime(plan.value, app.docs) : null))
const deadlineText = computed(() => (task.value ? slotDeadlineLabel(task.value.deadline) : ''))
const planDeadlineRisk = computed(() => (plan.value && task.value ? planRisk(task.value, plan.value.date, new Date(nowMs.value)) : null))
// 「返回安排」经现有路由守卫 → 统一离开保护（运行中/脏暂停先保存）。
function gotoPlan() {
  if (plan.value) router.push(schedulePath({ date: plan.value.date, plan: plan.value.id }, todayStr.value))
}

const title = computed(() => sessionTitle(session.value) || (task.value ? task.value.title : '原任务已删除'))
const actionText = computed(() => sessionActionText(session.value) || (liveAction.value ? liveAction.value.text : ''))
const minutes = computed(() =>
  (session.value && session.value.action_snapshot && session.value.action_snapshot.minutes) || (liveAction.value ? liveAction.value.minutes : null))
const infoChanged = computed(() => {
  const s = session.value
  if (!s || !s.task_snapshot) return false
  if (!task.value || !liveAction.value) return true
  if (task.value.title !== s.task_snapshot.title) return true
  if (s.action_snapshot && (liveAction.value.text !== s.action_snapshot.text || liveAction.value.minutes !== s.action_snapshot.minutes)) return true
  return false
})
const showCurrentInfo = ref(false)

// 计时按 accumulated_ms + timer_anchor_at 派生；异常/非持有/租约到期只显示已保存累计，不显示负投入。
const displayMs = computed(() => {
  const s = session.value
  if (!s) return 0
  if (s.running && s.timer_anchor_at && holderValid.value) {
    return s.accumulated_ms + Math.max(0, nowMs.value - Date.parse(s.timer_anchor_at))
  }
  return s.accumulated_ms
})
const rollbackHint = computed(() => {
  const s = session.value
  return !!s && s.running && !!s.timer_anchor_at && holderValid.value && nowMs.value < Date.parse(s.timer_anchor_at)
})
const stateLabel = computed(() => {
  if (!session.value) return ''
  if (!isV1.value) return '旧版记录'
  if (recoveryPending.value) return '待恢复'
  if (otherHolder.value) return '其它页面'
  if (needTakeover.value) return '租约到期'
  return session.value.running ? '运行中' : '已暂停'
})

const saveStatusText = computed(() => {
  if (draft.conflict.value) return '待核对'
  if (draft.saveState.value === 'saving') return '正在保存…'
  if (draft.saveState.value === 'saved') return '已保存'
  if (draft.saveState.value === 'error') return '保存失败'
  return '未保存'
})

// —— 暂停 / 继续：最终正文随主操作同事务合并；每次点击是新意图新信封 ——
const opBusy = ref(false)
const opError = ref(null)
async function runStateOp(op) {
  if (opBusy.value || !editable.value) return
  opBusy.value = true
  opError.value = null
  draft.frozen.value = true
  try {
    await draft.settle()
    const text = draft.text.value
    const version = draft.inputVersion.value
    const env = focus.issueRequest(op, { sessionId: sessionId.value })
    const r = await focus[op]({
      sessionId: sessionId.value, draftMd: text,
      expectedRevision: draft.baseRevision.value != null ? draft.baseRevision.value : undefined,
      requestId: env.request_id, issuedAtMs: env.issued_at_ms,
    })
    if (r.ok) {
      draft.markOpSaved(text, version, r.revision)
    } else {
      opError.value = opErrorOf(r)
      if (r.code === 'STALE_REVISION' && session.value && (session.value.draft_md || '') !== draft.savedText.value) {
        draft.flagConflict('保存基线已过期：其它页面可能改写了正文，请核对后选择保留哪个版本')
      }
    }
  } finally {
    opBusy.value = false
    draft.frozen.value = false
  }
}
function opErrorOf(r) {
  if (['STALE_REQUEST', 'REQUEST_ENVELOPE_REQUIRED'].includes(r.code)) {
    return { code: r.code, message: '本次请求已失效，请核对当前记录后重新提交' }
  }
  return { code: r.code, message: r.message || '操作失败，输入保留，可重试' }
}

// —— 结束（5A-2B §6.1/§6.2）：两组结果一次提交；打开不结束不暂停；失败保留输入 ——
// 提交对象不可变：sessionId/结果/卡点/正文/expectedRevision/安排快照/历史确认在首次签发时冻结；
// 同输入重试原样复用（expectedRevision 已入服务指纹，绝不从 live 取新值沿用旧 ID）。
const endOpen = ref(false)
const endBusy = ref(false)
const endError = ref(null)
const endFrozen = ref(null)
const endDiffs = ref([])
let endAttempt = null
function setEndError(e) {
  endError.value = e
  endVerifyPending.value = !!e && e.kind === 'verify'
}

// 冻结安排事实：快照 + 历史确认（只含已结束会话；无历史=null；异常不生成可确认摘要）。
function freezePlanFacts(p) {
  if (!p) return { missing: true }
  const sum = summarizePlanTime(p, app.docs)
  const endedCount = endedSessionsForPlan(app.docs, p).length
  return {
    expected: planSnapshot(p),
    historyConfirm: endedCount > 0 && sum.authoritative ? historySignature(sum) : null,
    historyView: { count: sum.endedSessionCount, totalMs: sum.totalMs, actualMinutes: sum.actualMinutes },
    unresolved: !sum.authoritative,
    date: p.date,
    actionText: p.action_text,
    plannedMinutes: p.planned_minutes,
  }
}
function currentEndFacts() {
  if (!planLinked.value) return null
  return freezePlanFacts(plan.value)
}
const historyText = (f) => {
  if (!f || f.missing) return '关联损坏'
  if (f.unresolved) return '异常待核对'
  if (!f.historyConfirm) return '无已结束历史'
  return `${f.historyConfirm.endedSessionIds.length} 段 · ${formatDurationMs(f.historyConfirm.totalMs)}`
}
function endFactRows(a, b) {
  if (!a || !b || a.missing || b.missing) return []
  const titleOf = (id) => {
    const t = app.docs.find((d) => d.id === id && d.kind === 'task')
    return t ? t.title : ''
  }
  const rows = planSnapshotDiff(a.expected, b.expected).map((r) => ({
    field: r.field,
    name: label(PLAN_FIELD_LABELS, r.field),
    expectedText: planFieldValueLabel(r.field, r.expected, titleOf(r.expected)),
    currentText: planFieldValueLabel(r.field, r.current, titleOf(r.current)),
  }))
  if (JSON.stringify(a.historyConfirm ?? null) !== JSON.stringify(b.historyConfirm ?? null)) {
    rows.push({ field: 'history', name: '已结束历史摘要', expectedText: historyText(a), currentText: historyText(b) })
  }
  return rows
}
const planFormCtx = computed(() => {
  if (!planLinked.value) return null
  return endFrozen.value || currentEndFacts()
})

// 打开/重开：重新检查当前事实。有待核实/重试的原提交 → 冻结版保持与原提交一致，只列差异；
// 无原提交 → 采用最新冻结版并列出与上次冻结的差异。取消仅关表单，选择由表单按会话保留。
watch(endOpen, (v) => {
  if (!v) return
  // 待核实的原提交仍在：重开不清除核实提示与输入锁定。
  if (!(endAttempt && endError.value && endError.value.kind === 'verify')) setEndError(null)
  if (!planLinked.value) {
    endFrozen.value = null
    endDiffs.value = []
    return
  }
  const latest = currentEndFacts()
  if (endAttempt) {
    endDiffs.value = endFactRows(endFrozen.value, latest)
  } else {
    endDiffs.value = endFrozen.value ? endFactRows(endFrozen.value, latest) : []
    endFrozen.value = latest
  }
})
// 切会话/切空间：结束意图与冻结事实全部作废，不串值。
watch([sessionId, () => app.workspaceId], () => {
  endOpen.value = false
  endAttempt = null
  endFrozen.value = null
  endDiffs.value = []
  setEndError(null)
})

async function submitEnd(sel) {
  if (endBusy.value || !session.value) return
  const sid = sessionId.value
  const ws = app.workspaceId
  endBusy.value = true
  setEndError(null)
  draft.frozen.value = true
  try {
    await draft.settle()
    // 结算后重查身份与资格：切换/外部结束/正文冲突 → 停止，保留输入。
    if (sessionId.value !== sid || app.workspaceId !== ws) return
    if (!session.value || session.value.ended_at != null) {
      setEndError({ kind: 'fatal', code: 'ALREADY_ENDED', message: '会话已结束或不存在，请核对当前状态' })
      return
    }
    if (draft.conflict.value) {
      setEndError({ kind: 'fatal', code: 'STALE_REVISION', message: '正文需要核对：请先在编辑区处理冲突，再结束' })
      return
    }
    const text = draft.text.value
    const version = draft.inputVersion.value
    const pp = planLinked.value ? sel.planProgress : undefined
    // 结果/卡点/正文/安排进度任一变化 = 新意图新信封；完全相同的失败重试复用原信封与提交内容。
    const changed = !endAttempt || endAttempt.outcome !== sel.outcome || endAttempt.blocker !== sel.blocker
      || endAttempt.text !== text || endAttempt.planProgress !== pp
    if (changed) {
      if (planLinked.value && (!endFrozen.value || endFrozen.value.missing)) endFrozen.value = currentEndFacts()
      const frozenOk = planLinked.value && endFrozen.value && !endFrozen.value.missing
      const env = focus.issueRequest('end', { sessionId: sid })
      endAttempt = {
        sessionId: sid, requestId: env.request_id, issuedAtMs: env.issued_at_ms,
        outcome: sel.outcome, blocker: sel.blocker, text, version,
        expectedRevision: draft.baseRevision.value != null ? draft.baseRevision.value : undefined,
        planProgress: pp,
        expected: frozenOk ? endFrozen.value.expected : undefined,
        historyConfirm: frozenOk ? endFrozen.value.historyConfirm : undefined,
      }
    }
    await doEndAttempt(endAttempt)
  } finally {
    endBusy.value = false
    draft.frozen.value = false
  }
}

async function doEndAttempt(a) {
  const ws = app.workspaceId
  let r
  try {
    r = await focus.end({
      sessionId: a.sessionId, outcome: a.outcome, blocker: a.blocker || null, draftMd: a.text,
      expectedRevision: a.expectedRevision,
      requestId: a.requestId, issuedAtMs: a.issuedAtMs,
      ...(a.planProgress != null ? { planProgress: a.planProgress, expected: a.expected, historyConfirm: a.historyConfirm } : {}),
    })
  } catch {
    // 事务可能已提交也可能未提交（如提交后刷新读取失败）：结果未知，保留原提交进入待核实，不换新信封。
    if (sessionId.value !== a.sessionId || app.workspaceId !== ws) return
    setEndError({ kind: 'verify', canRetry: true, code: 'SAVE_FAILED', message: '保存结果未知：可能已提交也可能未提交。请核实结果或用原信封重试，不会重复累计。' })
    return
  }
  // 晚到结果按作用域丢弃：操作期间切了会话/空间，不应用到当前页面。
  if (sessionId.value !== a.sessionId || app.workspaceId !== ws) return
  if (r.ok) finishEndSuccess(r, a)
  else await handleEndFailure(r, a)
}

function finishEndSuccess(r, a) {
  const sid = a.sessionId
  // 成功以持久记录为准（replay 只回摘要，无 r.session）。
  const ended = focus.sessions.find((s) => s.id === sid && s.ended_at != null)
  if (!ended) {
    setEndError({ kind: 'verify', canRetry: true, code: r.code || 'SAVE_FAILED', message: '保存回执已收到，但本页尚未读到已结束记录，请核实结果' })
    return
  }
  const retTarget = workReturn.value
  draft.forget()
  forgetEndSelection(`${app.workspaceId}:${sid}`)
  endOpen.value = false
  endAttempt = null
  endFrozen.value = null
  endDiffs.value = []
  setEndError(null)
  navigatedAway = true
  const parts = ['本次工作已保存']
  if (a.outcome) parts.push(`行动${label(SESSION_OUTCOME_LABELS, a.outcome)}`)
  if (r.planItem) parts.push(`安排${r.planItem.state === 'done' ? '已完成' : '还需要继续'}`)
  const target = router.resolve(retTarget)
  if (target.name === 'schedule' || target.name === 'task-detail') {
    if (app.banner?.tone === 'success') app.banner = null
  } else {
    app.say('success', parts.join(' · '))
  }
  /** @type {import('vue-router').LocationQueryRaw} */
  const query = { ...target.query, recorded: sid }
  if (target.path === '/today' && r.planItem) {
    delete query.plan
    query.date = r.planItem.date
  }
  router.replace({ path: target.path, query })
}

async function handleEndFailure(r, a) {
  const code = r.code || 'SAVE_FAILED'
  // 安排事实/历史摘要变化：明确拒绝（零写入）。重读后更新冻结版，列完整差异，等用户显式重新确认。
  if (['STALE_PLAN', 'HISTORY_UNCONFIRMED', 'HISTORY_CHANGED'].includes(code)) {
    await app.reloadDocs()
    if (sessionId.value !== a.sessionId) return
    const latest = currentEndFacts()
    const rows = endFactRows({ expected: a.expected, historyConfirm: a.historyConfirm ?? null, unresolved: false }, latest)
    endFrozen.value = latest
    endDiffs.value = []
    endAttempt = null
    if (code === 'STALE_PLAN') {
      setEndError({ kind: 'stale-plan', code, rows, message: r.message || '安排事实已变化，请核对全部差异后重新确认' })
    } else {
      setEndError({ kind: 'history', code, history: r.current || r.history || null, message: r.message || '历史用时摘要需要重新核对' })
    }
    return
  }
  if (code === 'HISTORY_UNRESOLVED') {
    await app.reloadDocs()
    setEndError({ kind: 'problems', code, problems: r.problems || [], message: r.message || '历史用时存在异常，先核对处理（不自动修数据）' })
    return
  }
  if (['RECOVERY_REQUIRED', 'OWNER_CONFLICT'].includes(code)) {
    // 回到页面既有的恢复/接管流程；正文与选择保留（选择按会话隔离）。
    endOpen.value = false
    endAttempt = null
    endFrozen.value = null
    endDiffs.value = []
    setEndError(null)
    return
  }
  if (code === 'STALE_REVISION') {
    endAttempt = null
    if (session.value && (session.value.draft_md || '') !== draft.savedText.value) {
      draft.flagConflict('保存基线已过期：其它页面可能改写了正文，请核对后选择保留哪个版本')
      endOpen.value = false
      setEndError(null)
    } else {
      // 明确零写入拒绝且正文未变（检查点推进修订）：更新基线，等用户再次点击作为新意图。
      if (r.currentRevision != null) draft.baseRevision.value = r.currentRevision
      setEndError({ kind: 'fatal', code, message: '保存基线已过期，已更新为当前修订；请核对后再次点击「结束并保存」' })
    }
    return
  }
  if (['STALE_REQUEST', 'REQUEST_ENVELOPE_REQUIRED'].includes(code)) {
    // 信封失效：先核实是否已保存，再新意图；不自动换 ID 重提。
    endAttempt = null
    setEndError({ kind: 'verify', canRetry: false, code, message: '本次请求已失效：请先核实是否已保存，再重新提交' })
    return
  }
  if (['PLAN_CONFIRM_REQUIRED', 'PLAN_NOT_EXECUTABLE', 'PLAN_LINK_INVALID', 'RELATION_INVALID', 'ALREADY_ENDED', 'INVALID_FIELD', 'TASK_DONE', 'LEGACY_RECOVERY_REQUIRED'].includes(code)) {
    await app.reloadDocs()
    endAttempt = null
    if (code === 'ALREADY_ENDED') {
      endOpen.value = false
      setEndError(null)
      return
    }
    setEndError({ kind: 'fatal', code, message: r.message || '当前状态不允许结束，请核对' })
    return
  }
  // SAVE_FAILED / 结果未知：保留完整原提交，锁定输入，提供核实 / 原信封重试。
  setEndError({ kind: 'verify', canRetry: true, code, message: r.message || '保存结果未知：输入已保留，可核实结果或用原请求重试' })
}

async function verifyEnd() {
  if (endBusy.value) return
  endBusy.value = true
  try {
    await focus.loadWorkspace()
    await app.reloadDocs()
    const a = endAttempt
    const sid = a ? a.sessionId : sessionId.value
    const ended = focus.sessions.find((s) => s.id === sid && s.ended_at != null)
    if (ended) {
      finishEndSuccess({ ok: true }, a || { sessionId: sid, outcome: ended.outcome })
    } else if (a) {
      setEndError({ kind: 'verify', canRetry: true, code: endError.value ? endError.value.code : null, message: '核实完成：尚未读到已结束记录，可用原请求重试' })
    } else {
      setEndError({ kind: 'fatal', message: '核实完成：本次尚未保存，可核对后重新提交' })
    }
  } finally {
    endBusy.value = false
  }
}

async function retryEnd() {
  if (endBusy.value || !endAttempt) return
  const a = endAttempt
  // 待核实期间正文若已修改，不能沿用原请求（旧信封内容是旧版）：作废原提交，走新意图。
  if (draft.inputVersion.value !== a.version) {
    endAttempt = null
    setEndError({ kind: 'fatal', message: '待核实期间正文已修改：不能沿用原请求，请作为新意图重新提交' })
    return
  }
  endBusy.value = true
  setEndError(null)
  draft.frozen.value = true
  try {
    await draft.settle()
    if (sessionId.value !== a.sessionId) return
    await doEndAttempt(a)
  } finally {
    endBusy.value = false
    draft.frozen.value = false
  }
}

// 差异/历史重确认：一次显式点击，采用失败分支已更新的最新冻结版；不悄悄刷新确认事实。
function reconfirmEnd(sel) {
  if (endBusy.value) return
  setEndError(null)
  endAttempt = null
  endDiffs.value = []
  if (planLinked.value && (!endFrozen.value || endFrozen.value.missing)) endFrozen.value = currentEndFacts()
  submitEnd(sel)
}

// —— 接管 / 恢复：租约到期显式 takeover；恢复确认 keep/correct，运行会话恢复即恢复运行 ——
const recoverBusy = ref(false)
const recoverError = ref(null)
const recoverMode = ref('keep')
const correctMinutes = ref('')
const REASON_LABELS = { clock_rollback: '墙钟回拨', time_jump: '时间明显跳变', stale_gap: '距上次检查点过久', takeover: '页面接管' }
async function doTakeover() {
  if (recoverBusy.value) return
  recoverBusy.value = true
  recoverError.value = null
  try {
    const env = focus.issueRequest('takeover', { sessionId: sessionId.value })
    const r = await focus.takeover({ sessionId: sessionId.value, requestId: env.request_id, issuedAtMs: env.issued_at_ms })
    if (!r.ok) recoverError.value = r
  } finally {
    recoverBusy.value = false
  }
}
async function doRecover() {
  if (recoverBusy.value) return
  let correctedMs
  if (recoverMode.value === 'correct') {
    const raw = String(correctMinutes.value).trim()
    if (raw === '') {
      recoverError.value = { message: '修正总用时不能为空；如确为 0 请明确输入 0' }
      return
    }
    const m = Number(raw)
    if (!Number.isFinite(m) || m < 0) {
      recoverError.value = { message: '修正总用时须为非负分钟数（时长，不是日期时间）' }
      return
    }
    const ms = Math.round(m * 60000)
    if (!Number.isSafeInteger(ms)) {
      recoverError.value = { message: '修正总用时超出可安全表示的范围，请核对后重填' }
      return
    }
    correctedMs = ms
  }
  recoverBusy.value = true
  recoverError.value = null
  try {
    const env = focus.issueRequest('recover', { sessionId: sessionId.value })
    const r = await focus.recover({
      sessionId: sessionId.value, mode: recoverMode.value, correctedMs,
      requestId: env.request_id, issuedAtMs: env.issued_at_ms,
    })
    if (!r.ok) recoverError.value = r
    else {
      recoverMode.value = 'keep'
      correctMinutes.value = ''
      // 恢复后以数据库事实为准重新装载基线（保留本地未保存输入的核对除外）。
      if (!draft.dirty.value) draft.loadFromDb()
    }
  } finally {
    recoverBusy.value = false
  }
}
watch(recoveryPending, (v) => {
  if (v) {
    recoverError.value = null
    recoverMode.value = 'keep'
    correctMinutes.value = String(Math.round(((session.value && session.value.accumulated_ms) || 0) / 60000))
  }
})

// —— v0 遗留：说明 + 显式结束（legacyEnd），不补造过去快照 ——
// §6.3：关联有效活安排 → 表单增加安排结果与确认快照，同事务保存；
// 引用缺失/终态 → 提示后沿用「不带安排参数显式结束释放占用」的已验收路径；无关联 → 原流程。
const legacyOutcome = ref('partial')
const legacyBlocker = ref('')
const legacyMinutes = ref('0')
const legacyBusy = ref(false)
const legacyError = ref(null)
const legacyPlanProgress = ref('partial')
const legacyFrozen = ref(null)
const legacyPlan = computed(() => {
  const s = session.value
  if (!s || isV1.value || s.plan_item_id == null) return null
  const p = app.docs.find((d) => d.id === s.plan_item_id && d.kind === 'plan_item')
  if (!p || p.workspace_id !== app.workspaceId || p.task_id !== s.task_id || !isLiveRef(p) || !LIVE_PLAN_STATES.includes(p.state)) return null
  return p
})
const legacyPlanBroken = computed(() => {
  const s = session.value
  return !!s && !isV1.value && s.plan_item_id != null && !legacyPlan.value
})
watch(isV1, (v) => {
  if (!v && session.value) legacyMinutes.value = String(Math.round((session.value.accumulated_ms || 0) / 60000))
}, { immediate: true })
// 按安排身份冻结确认快照（轮询重读不重置选择）；事实变化由 legacyEnd 事务拒绝后显式重冻结。
watch(() => (legacyPlan.value ? legacyPlan.value.id : null), () => {
  legacyPlanProgress.value = 'partial'
  legacyFrozen.value = legacyPlan.value ? freezePlanFacts(legacyPlan.value) : null
}, { immediate: true })
async function doLegacyEnd() {
  if (legacyBusy.value) return
  if (legacyOutcome.value === 'blocked' && !legacyBlocker.value.trim()) {
    legacyError.value = { message: '受阻结束必须填写具体卡点' }
    return
  }
  const m = Number(legacyMinutes.value)
  if (!Number.isFinite(m) || m < 0) {
    legacyError.value = { message: '确认累计须为非负分钟数' }
    return
  }
  legacyBusy.value = true
  legacyError.value = null
  try {
    const env = focus.issueRequest('legacyEnd', { sessionId: sessionId.value })
    const planParams = legacyPlan.value && legacyFrozen.value && !legacyFrozen.value.missing
      ? { planProgress: legacyPlanProgress.value, expected: legacyFrozen.value.expected, historyConfirm: legacyFrozen.value.historyConfirm }
      : {}
    const r = await focus.legacyEnd({
      sessionId: sessionId.value, outcome: legacyOutcome.value, blocker: legacyBlocker.value.trim() || null,
      accumulatedMs: Math.round(m * 60000), requestId: env.request_id, issuedAtMs: env.issued_at_ms,
      ...planParams,
    })
    if (r.ok) {
      navigatedAway = true
      const parts = ['遗留记录已显式结束并归档']
      if (r.planItem) parts.push(`安排${r.planItem.state === 'done' ? '已完成' : '还需要继续'}`)
      app.say('success', parts.join(' · '))
      router.replace(recordPath(sessionId.value, workReturn.value))
    } else {
      if (['STALE_PLAN', 'HISTORY_UNCONFIRMED', 'HISTORY_CHANGED', 'HISTORY_UNRESOLVED'].includes(r.code)) {
        await app.reloadDocs()
        legacyFrozen.value = legacyPlan.value ? freezePlanFacts(legacyPlan.value) : null
        legacyError.value = { message: `${r.message || '安排事实已变化'}；确认快照已更新为当前事实，请核对后重新提交` }
      } else {
        legacyError.value = r
      }
    }
  } finally {
    legacyBusy.value = false
  }
}

// —— 外部结束后的只读核对：复制本地未保存输入 / 明确舍弃后离开（不覆盖已结束成果、不复活会话）——
function copyLocalDraft() {
  const t = draft.text.value || ''
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t)
      .then(() => app.say('success', '已复制本页未保存输入'))
      .catch(() => app.say('warning', '自动复制失败，请手动选择文本复制'))
  } else {
    app.say('warning', '当前环境不支持自动复制，请手动选择文本复制')
  }
}
function discardEndedReview(target) {
  draft.forget()
  endedReview.value = false
  navigatedAway = true
  router.replace(target)
}

// —— 离开协调：路由守卫与切空间共用；运行中/脏暂停先保存（运行则暂停）成功才离开 ——
const leaveOpen = ref(false)
const leaveMode = ref('pause')
const leavingBusy = ref(false)
let leaveResolve = null
let leavePromise = null
function askLeave(mode) {
  // 已有等待中的确认：复用同一 Promise，不覆盖未结算的 resolver（重复导航不悬挂、不双弹）。
  if (leaveResolve) return leavePromise
  leaveMode.value = mode
  leavePromise = new Promise((resolve) => {
    leaveResolve = resolve
    leaveOpen.value = true
  })
  return leavePromise
}
function settleLeave(v) {
  const r = leaveResolve
  leaveResolve = null
  leavePromise = null
  if (r) r(v)
}
function chooseLeave(v) {
  leaveOpen.value = false
  settleLeave(v)
}
// 任何非确认关闭（Escape/遮罩/v-model）统一结算为取消，恰好一次并清空等待引用；
// 确认按钮已先 settleLeave，watch 再触发时 resolver 已空，不会双重结算。
watch(leaveOpen, (v) => { if (!v) settleLeave(false) })
const unregisterLeave = registerWorkLeave(async () => {
  const s = session.value
  if (!s || invalid.value || navigatedAway) return true
  if (s.ended_at != null) {
    // 外部结束后的只读核对：仍有本地未保存输入 → 明确确认舍弃才离开；无脏输入正常放行转历史。
    if (endedReview.value && (draft.dirty.value || draft.conflict.value)) {
      const ok = await askLeave('ended')
      if (ok) { draft.forget(); endedReview.value = false }
      return ok
    }
    return true
  }
  if (!holderValid.value) {
    // 只读非持有者/待恢复：不冒充持有者暂停；脏文本留在会话级内存，回来时核对。
    if (draft.dirty.value) return askLeave('keep')
    return true
  }
  if (!s.running && !draft.dirty.value) return true
  if (!(await askLeave('pause'))) return false
  leavingBusy.value = true
  draft.frozen.value = true
  try {
    await draft.settle()
    const text = draft.text.value
    const version = draft.inputVersion.value
    const op = s.running ? 'pause' : 'saveDraft'
    const env = focus.issueRequest(op, { sessionId: sessionId.value })
    const r = await focus[op]({
      sessionId: sessionId.value, draftMd: text,
      expectedRevision: draft.baseRevision.value != null ? draft.baseRevision.value : undefined,
      requestId: env.request_id, issuedAtMs: env.issued_at_ms,
    })
    if (!r.ok) {
      app.say('destructive', `离开前保存失败（${r.code || '未知'}）：留在原页，输入保留`)
      return false
    }
    draft.markOpSaved(text, version, r.revision)
    if (draft.dirty.value) {
      app.say('warning', '保存期间出现新输入，留在原页')
      return false
    }
    return true
  } finally {
    leavingBusy.value = false
    draft.frozen.value = false
  }
})
onBeforeRouteLeave(() => requestWorkLeave())
// 同路由更换 sessionId（/work/A → /work/B）复用组件，只触发 update 守卫，不触发 leave。
// 此刻路由参数尚未更新，session.value 仍指向原会话：统一离开协调针对原会话保存/暂停，
// 取消或失败返回 false 留在原 URL/原输入，成功后才放行载入新会话。只改无关 query 不弹窗。
onBeforeRouteUpdate(async (to, from) => {
  if (String(to.params.sessionId || '') === String(from.params.sessionId || '')) return true
  const ok = await requestWorkLeave()
  resetWorkLeaveApproval()
  return ok
})

const mobileTab = ref('write')
const leaseCountdown = computed(() => {
  if (!rt.value) return ''
  const left = Math.max(0, rt.value.lease_expires_at - nowMs.value)
  return formatDurationMs(left)
})
</script>

<template>
  <div v-if="!ready" class="text-sm text-muted-foreground">正在读取本地工作数据…</div>

  <div v-else-if="invalid" class="space-y-3">
    <Alert variant="warning">会话不存在或不属于当前空间。不会自动新建会话，也不会替你切换空间。</Alert>
    <div class="flex gap-2">
      <Button variant="outline" @click="router.replace('/today')"><ArrowLeft />返回日程</Button>
      <Button variant="outline" @click="router.replace('/work-records')">工作记录</Button>
    </div>
  </div>

  <template v-else-if="session">
    <div v-if="!endedReview" class="space-y-3">
      <!-- 顶栏：返回 / 当前行动与状态 / 保存状态 -->
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" @click="router.push(workReturn)"><ArrowLeft />{{ returnLabel }}</Button>
        <Badge :variant="session.running && holderValid ? 'success' : 'secondary'">{{ stateLabel }}</Badge>
        <span class="ml-auto flex items-center gap-1 text-xs" :class="draft.saveState.value === 'error' || draft.conflict.value ? 'text-destructive' : 'text-muted-foreground'" aria-live="polite">
          <CircleCheck v-if="draft.saveState.value === 'saved' && !draft.conflict.value" class="size-3.5" />
          <LoaderCircle v-else-if="draft.saveState.value === 'saving'" class="size-3.5 animate-spin" />
          <CircleAlert v-else-if="draft.saveState.value === 'error' || draft.conflict.value" class="size-3.5" />
          <CloudOff v-else class="size-3.5" />
          {{ saveStatusText }}
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="min-w-0 flex-1 basis-52">
          <h1 class="break-words text-2xl font-semibold leading-snug">{{ actionText || title }}</h1>
          <div class="mt-0.5 break-words text-sm text-muted-foreground">
            {{ title }}
            <template v-if="minutes"> · 预计 {{ minutes }} 分钟</template>
          </div>
        </div>
        <div class="flex flex-col text-primary">
          <span class="text-xs text-muted-foreground">已投入</span>
          <span class="text-3xl font-semibold leading-tight tabular-nums">{{ formatDurationMs(displayMs) }}</span>
        </div>
        <div v-if="editable" class="flex flex-wrap gap-2">
          <Button v-if="session.running" size="sm" variant="outline" :disabled="opBusy" @click="runStateOp('pause')"><Pause />暂停</Button>
          <Button v-else size="sm" variant="outline" :disabled="opBusy" @click="runStateOp('resume')"><Play />继续计时</Button>
          <Button size="sm" :disabled="opBusy" @click="endOpen = true"><Square />结束本次</Button>
        </div>
      </div>
      <div v-if="infoChanged" class="text-xs">
        <Badge variant="warning">当前信息已修改</Badge>
        <button type="button" class="ml-2 underline" :aria-expanded="showCurrentInfo" @click="showCurrentInfo = !showCurrentInfo">
          {{ showCurrentInfo ? '收起当前信息' : '查看当前信息' }}
        </button>
        <div v-if="showCurrentInfo" class="mt-1 rounded-md border bg-muted/40 p-2 text-muted-foreground">
          <div>当前任务：{{ task ? task.title : '已删除' }}</div>
          <div>当前行动：{{ liveAction ? `${liveAction.text}（预计 ${liveAction.minutes} 分钟）` : '已删除' }}</div>
          <div>历史目标以开始快照为准，不被覆盖。</div>
        </div>
      </div>
      <p v-if="rollbackHint" class="text-xs text-warning-foreground"><CircleAlert class="mr-1 inline size-3.5" />检测到墙钟回拨：显示已保存累计，下次操作需核对时段。</p>

      <!-- 所属安排（5A-2B §5）：紧凑事实块；本段计时单独显示，不混入已结束累计 -->
      <section v-if="planLinked && isV1 && plan" class="border-y py-3">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="text-xs text-muted-foreground">所属安排</span>
          <span class="font-date font-medium">{{ plan.date }}</span>
          <Badge v-if="plan.date === todayStr" variant="secondary">今天</Badge>
          <Badge variant="secondary">{{ label(PLAN_STATE_LABELS, plan.state) }}</Badge>
          <Button v-if="!returnOpensPlan" size="sm" variant="outline" class="ml-auto" @click="gotoPlan"><ArrowLeft />返回安排</Button>
        </div>
        <p v-if="plan.action_text !== actionText" class="mt-1 break-words text-sm">{{ plan.action_text }}</p>
        <p class="mt-1 text-xs text-muted-foreground">
          安排预计 {{ plan.planned_minutes }} 分钟
          <template v-if="planSummary.authoritative && planSummary.endedSessionCount"> · 已结束 {{ planSummary.endedSessionCount }} 段 · 累计 {{ formatDurationMs(planSummary.totalMs) }} · 实际 {{ planActualLabel(planSummary) }}</template>
          <template v-else-if="!planSummary.authoritative">历史用时异常待核对</template>
        </p>
        <p v-if="deadlineText" class="mt-1 text-xs text-muted-foreground">
          任务总截止：{{ deadlineText || '未设置' }}
          <span v-if="planDeadlineRisk && (planDeadlineRisk.kind === 'after_deadline' || planDeadlineRisk.overdue)" class="text-warning-foreground">（{{ planDeadlineRisk.overdue ? '任务已逾期' : '安排日晚于截止' }}，仅提示，不阻止工作）</span>
        </p>
      </section>
      <Alert v-else-if="planLinked && isV1" variant="warning">
        会话关联的安排已不存在（关联损坏）：正文与累计保留，编辑/暂停/保存仍可用；本次无法联动安排进度，不会自动解绑或降级为遗留结束。
      </Alert>

      <!-- 状态面板：其它页面持有 / 租约到期 / 待恢复 / 旧版 -->
      <Alert v-if="otherHolder" variant="warning">
        此工作正在另一页面进行（租约剩余 {{ leaseCountdown }}）。本页只读，不会自动接管。
        <Button size="sm" variant="outline" class="ml-2" @click="focus.loadWorkspace()"><RefreshCw />刷新状态</Button>
      </Alert>
      <Card v-else-if="needTakeover">
        <div class="text-sm font-medium">会话租约已到期（含长时间暂停后回来）。</div>
        <p class="mt-1 text-sm text-muted-foreground">原页面也不能直接续写。接管后需核对用时，再恢复编辑。</p>
        <Button size="sm" class="mt-2" :disabled="recoverBusy" @click="doTakeover"><RefreshCw />恢复编辑（接管）</Button>
        <Alert v-if="recoverError" variant="destructive" class="mt-2">{{ recoverError.message }}</Alert>
      </Card>
      <Card v-else-if="recoveryPending">
        <div class="text-sm font-medium">待恢复确认：{{ REASON_LABELS[rt.recovery.reason] || rt.recovery.reason }}</div>
        <div class="mt-1 space-y-0.5 text-sm text-muted-foreground">
          <div>最后保存累计：{{ formatDurationMs(session.accumulated_ms) }}</div>
          <div>未确认间隔起点：{{ beijingInstantLabel(rt.recovery.since) }}</div>
          <div v-if="rt.recovery.pending_ms >= 0">未确认间隔：{{ formatDurationMs(rt.recovery.pending_ms) }}（不会自动计入有效用时）</div>
          <div v-else class="text-destructive">墙钟回拨产生负间隔（{{ rt.recovery.pending_ms }} ms）：需人工核对，不显示为负投入。</div>
        </div>
        <fieldset class="mt-2 space-y-1.5 text-sm" :disabled="recoverBusy">
          <label class="flex items-center gap-2"><input v-model="recoverMode" type="radio" value="keep" />保留已保存用时（{{ formatDurationMs(session.accumulated_ms) }}）</label>
          <label class="flex flex-wrap items-center gap-2">
            <input v-model="recoverMode" type="radio" value="correct" />手动修正总用时
            <Input v-model="correctMinutes" type="number" min="0" step="1" class="h-8 w-24" aria-label="修正总用时（分钟）" :disabled="recoverMode !== 'correct'" />
            <span class="text-xs text-muted-foreground">分钟（非负时长）</span>
          </label>
        </fieldset>
        <Button size="sm" class="mt-2" :disabled="recoverBusy" @click="doRecover">
          <RefreshCw />{{ session.running ? '核对并恢复运行' : '核对用时（保持暂停）' }}
        </Button>
        <p v-if="!session.running" class="mt-1 text-xs text-muted-foreground">核对后仍暂停，需另点「继续计时」。</p>
        <Alert v-if="recoverError" variant="destructive" class="mt-2">{{ recoverError.message }}</Alert>
      </Card>
      <Card v-else-if="!isV1">
        <div class="text-sm font-medium">旧版（v0）未结束会话</div>
        <p class="mt-1 text-sm text-muted-foreground">该记录没有开始快照与计时锚点，不补造过去信息。请确认累计与结果后显式结束，归档为只读历史。</p>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <label class="flex items-center gap-1"><input v-model="legacyOutcome" type="radio" value="done" :disabled="legacyBusy" />完成</label>
          <label class="flex items-center gap-1"><input v-model="legacyOutcome" type="radio" value="partial" :disabled="legacyBusy" />部分完成</label>
          <label class="flex items-center gap-1"><input v-model="legacyOutcome" type="radio" value="blocked" :disabled="legacyBusy" />被阻塞</label>
          <Input v-model="legacyMinutes" type="number" min="0" class="h-8 w-24" aria-label="确认累计（分钟）" :disabled="legacyBusy" />
          <span class="text-xs text-muted-foreground">分钟</span>
        </div>
        <Textarea v-if="legacyOutcome === 'blocked'" v-model="legacyBlocker" class="mt-2 min-h-14" placeholder="具体卡点（必填）" aria-label="阻塞说明" :disabled="legacyBusy" />
        <!-- §6.3：v0 关联有效活安排 → 明确选择安排进度，确认快照随 legacyEnd 同事务保存 -->
        <template v-if="legacyPlan">
          <div class="mt-2 rounded-md border p-2 text-xs text-muted-foreground">
            所属安排 <span class="font-date">{{ legacyPlan.date }}</span> · {{ legacyPlan.action_text }} · 预计 {{ legacyPlan.planned_minutes }} 分钟
            <template v-if="legacyFrozen && !legacyFrozen.missing">
              ·
              <template v-if="legacyFrozen.unresolved">历史用时异常待核对</template>
              <template v-else-if="legacyFrozen.historyConfirm">已结束 {{ legacyFrozen.historyConfirm.endedSessionIds.length }} 段 · 累计 {{ formatDurationMs(legacyFrozen.historyConfirm.totalMs) }}</template>
              <template v-else>暂无已结束历史</template>
            </template>
          </div>
          <fieldset class="mt-2 space-y-1 text-sm" :disabled="legacyBusy">
            <legend class="text-xs font-medium">这项安排的进度</legend>
            <label class="flex items-center gap-2"><input v-model="legacyPlanProgress" type="radio" value="partial" />还需要继续（安排保持部分完成）</label>
            <label class="flex items-center gap-2"><input v-model="legacyPlanProgress" type="radio" value="done" />这项安排已完成（不代表完成任务）</label>
          </fieldset>
        </template>
        <Alert v-else-if="legacyPlanBroken" variant="warning" class="mt-2">
          遗留会话关联的安排缺失或已终态：可结束遗留记录释放占用，但本次无法更新安排；结束后请人工核对。
        </Alert>
        <div v-if="session.draft_md" class="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{{ session.draft_md }}</div>
        <Button size="sm" class="mt-2" :disabled="legacyBusy" @click="doLegacyEnd"><Square />{{ legacyBusy ? '正在结束…' : '显式结束遗留记录' }}</Button>
        <Alert v-if="legacyError" variant="destructive" class="mt-2">{{ legacyError.message }}</Alert>
      </Card>

      <!-- 冲突核对 / 保存错误 -->
      <Card v-if="draft.conflict.value" class="border-warning">
        <div class="text-sm font-medium"><CircleAlert class="mr-1 inline size-4 text-warning-foreground" />正文需要核对</div>
        <p class="mt-1 text-sm text-muted-foreground">{{ draft.error.value ? draft.error.value.message : '其它页面改写了正文。' }}你的输入已保留，未写入数据库。</p>
        <div class="mt-2 grid gap-2 md:grid-cols-2">
          <div class="rounded-md border p-2">
            <div class="text-xs font-medium">我的未保存输入</div>
            <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs">{{ draft.text.value }}</pre>
          </div>
          <div class="rounded-md border p-2">
            <div class="text-xs font-medium">数据库已保存版本</div>
            <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs">{{ session.draft_md || '（空）' }}</pre>
          </div>
        </div>
        <div class="mt-2 flex flex-wrap gap-2">
          <Button size="sm" :disabled="!editable" @click="draft.adoptLocal()">保留我的输入并提交</Button>
          <Button size="sm" variant="outline" @click="draft.adoptSaved()">采用已保存版本</Button>
        </div>
      </Card>
      <Alert v-else-if="draft.error.value" variant="destructive">
        {{ draft.error.value.message }}
        <Button v-if="draft.error.value.kind === 'retry'" size="sm" variant="outline" class="ml-2" :disabled="!editable" @click="draft.retry()">重试（原请求）</Button>
        <Button v-else-if="draft.error.value.kind === 'expired'" size="sm" variant="outline" class="ml-2" :disabled="!editable" @click="draft.resaveNow()">核对后重新保存</Button>
        <Button v-else-if="draft.error.value.kind === 'blocked'" size="sm" variant="outline" class="ml-2" @click="focus.loadWorkspace()"><RefreshCw />刷新状态</Button>
      </Alert>
      <Alert v-if="opError" variant="destructive">{{ opError.message }}<Button size="sm" variant="outline" class="ml-2" @click="opError = null">知道了</Button></Alert>

      <!-- 手机标签：成果 / 资料（切换不卸载编辑草稿） -->
      <div class="flex gap-1 lg:hidden" role="tablist" aria-label="执行页视图">
        <button type="button" role="tab" :aria-selected="mobileTab === 'write'" class="rounded-md px-3 py-1.5 text-sm" :class="mobileTab === 'write' ? 'bg-primary text-primary-foreground' : 'border bg-card'" @click="mobileTab = 'write'">本次成果</button>
        <button type="button" role="tab" :aria-selected="mobileTab === 'materials'" class="rounded-md px-3 py-1.5 text-sm" :class="mobileTab === 'materials' ? 'bg-primary text-primary-foreground' : 'border bg-card'" @click="mobileTab = 'materials'">关联资料</button>
      </div>

      <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card :class="mobileTab !== 'write' && 'max-lg:hidden'">
          <template #header>
            <div class="text-base font-semibold">本次成果</div>
            <p class="text-xs text-muted-foreground">自动保存到本机</p>
          </template>
          <Textarea
            :model-value="draft.text.value"
            class="min-h-64 text-sm leading-relaxed lg:min-h-96"
            placeholder="记录过程、成果或下次继续的位置"
            aria-label="本次成果正文"
            :disabled="!editable || draft.conflict.value"
            @update:model-value="draft.onInput($event)"
          />
          <p v-if="!editable && isV1 && session.ended_at == null" class="mt-2 text-xs text-muted-foreground">
            当前不可编辑（其它页面持有 / 租约到期 / 待恢复）。输入不会丢失，恢复后可编辑。
          </p>
        </Card>
        <Card :class="mobileTab !== 'materials' && 'max-lg:hidden'">
          <template #header>
            <div class="text-base font-semibold">关联资料（只读）</div>
          </template>
          <WorkMaterials :task="task" :ws="app.workspaceId" :session-id="sessionId" />
        </Card>
      </div>
    </div>

    <!-- 外部结束后的只读核对：本地未保存输入 vs 数据库最终成果；复制 / 明确舍弃后离开 -->
    <div v-else class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">已结束</Badge>
        <span class="text-xs text-muted-foreground">本次工作已在其它页面结束，本页已停止写入。</span>
      </div>
      <Card class="border-warning">
        <div class="text-sm font-medium"><CircleAlert class="mr-1 inline size-4 text-warning-foreground" />核对：本页未保存输入与已结束的最终成果</div>
        <p class="mt-1 text-sm text-muted-foreground">会话已结束，最终成果以数据库为准。你本页还有未保存输入，已保留供核对；不会覆盖已结束成果，也不会复活会话或写入新会话。可先复制，再明确舍弃后离开。</p>
        <div class="mt-2 grid gap-2 md:grid-cols-2">
          <div class="rounded-md border p-2">
            <div class="text-xs font-medium">我的未保存输入（只读）</div>
            <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{{ draft.text.value || '（空）' }}</pre>
          </div>
          <div class="rounded-md border p-2">
            <div class="text-xs font-medium">已结束的最终成果（数据库）</div>
            <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{{ session.draft_md || '（空）' }}</pre>
          </div>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button size="sm" @click="copyLocalDraft">复制我的输入</Button>
          <Button size="sm" variant="outline" @click="discardEndedReview(recordPath(sessionId, workReturn))">舍弃本地输入，查看历史</Button>
          <Button size="sm" variant="outline" @click="discardEndedReview(workReturn)">舍弃本地输入，{{ returnLabel }}</Button>
        </div>
      </Card>
    </div>

    <EndSessionForm
      v-model="endOpen"
      :busy="endBusy"
      :error="endError"
      :scope-key="`${app.workspaceId}:${sessionId}`"
      :plan-ctx="planFormCtx"
      :plan-diffs="endDiffs"
      :locked="endVerifyPending"
      @submit="submitEnd"
      @verify="verifyEnd"
      @retry="retryEnd"
      @reconfirm="reconfirmEnd"
    />

    <!-- 离开确认：保存并暂停后离开 / 留在这里（切空间与路由守卫共用同一流程） -->
    <DialogRoot v-model:open="leaveOpen">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-black/50" />
        <DialogContent class="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-4 shadow-lg">
          <DialogTitle class="text-base font-semibold">离开本次工作？</DialogTitle>
          <DialogDescription class="mt-2 text-sm text-muted-foreground">
            <template v-if="leaveMode === 'pause'">离开前将保存当前正文{{ session && session.running ? '并暂停计时' : '' }}。保存失败会留在本页，输入保留。</template>
            <template v-else-if="leaveMode === 'ended'">本次工作已在其它页面结束。离开将舍弃本页未保存输入（不写入数据库、不覆盖已结束成果）；如需保留请先复制。</template>
            <template v-else>本页不是持有者，不能替它暂停。未保存文本只保留在本页面内存（未写入数据库），回来时核对。</template>
          </DialogDescription>
          <div class="mt-4 flex justify-end gap-2">
            <Button variant="outline" :disabled="leavingBusy" @click="chooseLeave(false)">留在这里</Button>
            <Button :disabled="leavingBusy" @click="chooseLeave(true)">
              {{ leavingBusy ? '正在保存…' : leaveMode === 'ended' ? '舍弃本地输入并离开' : leaveMode === 'pause' ? (session && session.running ? '保存并暂停后离开' : '保存后离开') : '保留草稿并离开' }}
            </Button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </template>
</template>
