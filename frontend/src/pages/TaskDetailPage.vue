<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, CalendarClock, Check, Pencil, Play, Plus, Trash2, X } from 'lucide-vue-next'
import {
  DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle,
} from 'reka-ui'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Input from '@/components/ui/Input.vue'
import NodeSelect from '@/components/domain/NodeSelect.vue'
import ContinueBar from '@/components/domain/ContinueBar.vue'
import DeleteImpact from '@/components/domain/DeleteImpact.vue'
import PlanCard from '@/components/domain/PlanCard.vue'
import PlanWorkspace from '@/components/domain/PlanWorkspace.vue'
import { registerWorkLeave, requestWorkLeave, resetWorkLeaveApproval } from '@/composables/workLeave'
import StartPlanWorkDialog from '@/components/domain/StartPlanWorkDialog.vue'
import Textarea from '@/components/ui/Textarea.vue'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { usePlanWorkStart, planStartEntry } from '@/composables/usePlanWorkStart'
import { useScheduledAction } from '@/composables/useScheduledAction'
import { ACTION_DEFAULT_MINUTES } from '@/domains/action'
import { deleteImpactSnapshot } from '@/domains/matter'
import { endedSessionsSorted, formatDurationMs, sessionActionText, sessionTitle } from '@/domains/work'
import { beijingDateStr, beijingInstantLabel, formatWhen } from '@/domains/time'
import { resolveTaskReturn, resolveReplanReturn, taskReturnLabel, planContextForTask, planScheduleReturn, schedulePath, taskPath, workPath, recordPath } from '@/domains/workNavigation'
import { STATUS_LABELS, PLAN_STATE_LABELS, SESSION_OUTCOME_LABELS, label } from '@/domains/labels'

const store = useAppStore()
const focus = useFocusStore()
const route = useRoute()
const router = useRouter()

const taskId = computed(() => String(route.params.id || ''))
// 对象始终从 store 取最新：连续操作不回写旧快照。
const task = computed(() => store.tasks.find((t) => t.id === taskId.value) || null)
const taskActions = computed(() => (task.value ? store.actionsOf(task.value.id) : []))
const currentAction = computed(() => (task.value ? store.currentActionOf(task.value) : null))
const unfinishedCount = computed(() => taskActions.value.filter((a) => !a.done).length)

// 返回上下文：精确匹配站内路径 + 已知查询参数 + 当前空间归属；非法/丢失回退当前空间任务总览。
const todayStr = computed(() => beijingDateStr(new Date(store.nowTick)))
const navCtx = computed(() => ({ docs: store.docs, ws: store.workspaceId, todayStr: todayStr.value }))
const returnPath = computed(() => resolveTaskReturn(route.query.return, navCtx.value))
// 本页规范化地址（供工作页/记录页 return）：不带临时操作参数，不反复包 fullPath。
const taskReturn = computed(() => taskPath(taskId.value, { return: returnPath.value }))
const replanLink = computed(() => ({
  path: '/assistant',
  query: { replanTask: taskId.value, return: resolveReplanReturn(route.fullPath, taskId.value, navCtx.value) },
}))

// —— 显式执行安排上下文（§4 规则 1/2）：只认 plan 参数，不从 return 字符串推断；URL 不是授权 ——
const planCtx = computed(() => planContextForTask(route.query, taskId.value, navCtx.value))
const planCtxPlan = computed(() => (planCtx.value.status === 'ok' ? planCtx.value.plan : null))
const { action: scheduledAction, status: bindingStatus } = useScheduledAction(planCtxPlan, task)
const planCtxInvalidText = computed(() => {
  const r = planCtx.value
  if (r.status !== 'invalid') return ''
  if (r.reason === 'missing') return '链接中的安排不存在或不属于当前空间（不会自动切换空间）。'
  if (r.reason === 'cross-task') return '链接中的安排不属于本任务，不能在此为它选择行动。'
  return '链接中的安排任务引用已断开（历史只读），不能开始工作。'
})
const planCtxScheduleTarget = computed(() => {
  const p = planCtxPlan.value
  return p ? schedulePath({ date: p.date, plan: p.id }, todayStr.value) : returnPath.value
})

// —— 编辑草稿按任务 ID 隔离：切换任务/工作区重置，不串到另一任务或行动 ——
const renaming = ref(false)
const draftTitle = ref('')
const draftDescription = ref('')
const draftCriteria = ref('')
const deadlineEditing = ref(false)
const draftDeadline = ref('')
const newText = ref('')
const newMinutes = ref(String(ACTION_DEFAULT_MINUTES))
const editingActionId = ref(null)
const editActionText = ref('')
const editActionMinutes = ref('')
const saveState = ref('idle')
const addingAction = ref(false)
// 草稿版本：切换任务/工作区重置时递增，异步成功回调据此识别「仍是本次提交的草稿」。
let draftEpoch = 0
const focusNewText = () => {
  nextTick(() => {
    const el = /** @type {HTMLElement | null} */ (document.querySelector('[aria-label="新行动内容"]'))
    if (el) el.focus()
  })
}

function resetDrafts() {
  draftEpoch += 1
  renaming.value = false
  draftTitle.value = ''
  deadlineEditing.value = false
  draftDeadline.value = ''
  editingActionId.value = null
  newText.value = ''
  newMinutes.value = String(ACTION_DEFAULT_MINUTES)
  saveState.value = 'idle'
  draftDescription.value = task.value ? task.value.description || '' : ''
  draftCriteria.value = task.value ? task.value.completion_criteria || '' : ''
}
watch(taskId, resetDrafts, { immediate: true })
// 数据就绪后首次载入对象时填充说明/完成标准草稿；同 ID 的后续保存不重置输入。
watch(task, (t, old) => {
  if (t && (!old || old.id !== t.id)) {
    draftDescription.value = t.description || ''
    draftCriteria.value = t.completion_criteria || ''
  }
})
watch(() => store.workspaceId, resetDrafts)

const dirty = computed(() => {
  const t = task.value
  if (!t) return false
  if (renaming.value && draftTitle.value.trim() !== t.title) return true
  if (draftDescription.value !== (t.description || '')) return true
  if (draftCriteria.value !== (t.completion_criteria || '')) return true
  if (deadlineEditing.value && draftDeadline.value !== ((t.deadline && t.deadline.value) || '')) return true
  if (newText.value.trim()) return true
  if (editingActionId.value) {
    const a = taskActions.value.find((x) => x.id === editingActionId.value)
    if (a && (editActionText.value !== a.text || editActionMinutes.value !== String(a.minutes))) return true
  }
  return false
})
// 离开（含切换任务）有未保存输入时明确询问；对象失效的自动跳转不拦截。
// 同路由参数变化（/tasks/a → /tasks/b）复用组件，只触发 update 守卫，两个都要挂。
let bypassGuard = false
function confirmLeaveIfDirty() {
  if (bypassGuard) {
    bypassGuard = false
    return true
  }
  if (dirty.value && !window.confirm('有未保存的修改，离开将丢弃这些输入。仍要离开吗？')) return false
  return true
}

// 对象校验等数据就绪：打开后被删除 → 静默回列表；深链接无效/跨空间 → 明确提示。
// immediate：页内导航挂载时对象已在 store 中，watch(task) 不会再触发，必须立刻记 hadTask，
// 否则随后的正常删除会被误判为「对象已不存在」并覆盖成功横幅。
let hadTask = false
watch(taskId, () => { hadTask = false })
watch(task, (t) => { if (t) hadTask = true }, { immediate: true })
// immediate：页内导航挂载时 ready 已为 true，无后续变化也要立刻校验，否则无效深链接停在空页。
watch([() => store.ready, taskId, () => store.tasks], () => {
  if (!store.ready || !taskId.value || task.value) return
  if (!hadTask) store.say('warning', '任务已不存在或不属于当前空间，已回到原列表')
  hadTask = false
  bypassGuard = true
  router.replace(returnPath.value)
}, { immediate: true })

const saveStateText = computed(() =>
  saveState.value === 'saving' ? '正在保存…' : saveState.value === 'saved' ? '已保存' : saveState.value === 'error' ? '保存失败，输入保留，可重试' : '',
)
async function runSave(fn) {
  saveState.value = 'saving'
  const r = await fn()
  // 保护引导（blocked/进度/未结束）与范围变化（scopeChanged）由对话框/重新确认处理，不算保存失败。
  saveState.value = r && r.ok ? 'saved' : (r && (r.blocked || r.scopeChanged || r.planProgressRequired || r.unfinishedFocus) ? '' : 'error')
  return r
}

const deadlineText = computed(() => {
  const t = task.value
  return t && t.deadline && t.deadline.value ? formatWhen(t.deadline.value, t.deadline.precision) : '无截止'
})
const deadlineSource = computed(() => {
  const t = task.value
  if (!t || !t.deadline || !t.deadline.value) return ''
  if (t.deadline.source === 'manual') return '用户手动输入'
  const n = store.notes.find((x) => x.id === t.deadline.from_note_id)
  return n ? `来自便签「${n.title}」` : '来自便签'
})
const matterItems = computed(() => [
  { value: '', label: '未归组' },
  ...store.matters.map((m) => ({ value: m.id, label: m.title })),
])
const matterModel = computed({
  get: () => (task.value && task.value.matter_id) || '',
  set: (v) => { if (task.value) store.setMatter(task.value, v || null) },
})
const relatedNotes = computed(() => {
  const t = task.value
  if (!t) return []
  const ids = new Set(t.note_ids || [])
  if (t.deadline && t.deadline.from_note_id) ids.add(t.deadline.from_note_id)
  return [...ids].map((id) => store.notes.find((n) => n.id === id)).filter(Boolean)
})
// 出处链接携带返回上下文：核对页「返回任务」重建 /tasks/:id?return=<原列表>。
// 必须传已校验的 returnPath（原列表 fullPath）；传本页 fullPath 会被再包一层，返回时校验失败丢上下文。
function noteLink(n) {
  return { path: '/notes/' + n.id, query: { from: 'task', task: taskId.value, return: returnPath.value } }
}

function startRename() {
  draftTitle.value = task.value.title
  renaming.value = true
}
async function saveTitle() {
  const tid = taskId.value
  const r = await runSave(() => store.renameTask(task.value, draftTitle.value))
  if (r && r.ok && taskId.value === tid) renaming.value = false
}
async function saveDescription() {
  await runSave(() => store.editTask(task.value, { description: draftDescription.value }))
}
async function saveCriteria() {
  await runSave(() => store.editTask(task.value, { completion_criteria: draftCriteria.value }))
}
function startDeadlineEdit() {
  draftDeadline.value = (task.value.deadline && task.value.deadline.value) || ''
  deadlineEditing.value = true
}
async function saveDeadline() {
  const tid = taskId.value
  const r = await runSave(() => store.setTaskDeadline(task.value, draftDeadline.value))
  if (r && r.ok && taskId.value === tid) deadlineEditing.value = false
}
async function clearDeadline() {
  const tid = taskId.value
  const r = await runSave(() => store.setTaskDeadline(task.value, ''))
  if (r && r.ok && taskId.value === tid) {
    deadlineEditing.value = false
    draftDeadline.value = ''
  }
}
async function addAction() {
  // 重入保护：按钮与 Enter 共用本函数，同一次保存只提交一次（每次 addAction 生成新 UUID，事务安全不等于提交幂等）。
  if (addingAction.value) return
  const t = task.value
  if (!t) return
  const epoch = draftEpoch
  const tid = t.id
  const text = newText.value
  const minutes = newMinutes.value
  addingAction.value = true
  const r = await runSave(() => store.addAction(t, text, minutes))
  addingAction.value = false
  if (r && r.ok) {
    // 只清理仍对应本次提交的草稿：保存期间用户输入的下一条、或切换任务后的新表单不被旧回调清空。
    if (draftEpoch === epoch && taskId.value === tid && newText.value === text && newMinutes.value === minutes) {
      newText.value = ''
      focusNewText()
    }
  }
}
function focusAddAction() {
  focusNewText()
}
function startEditAction(a) {
  editingActionId.value = a.id
  editActionText.value = a.text
  editActionMinutes.value = String(a.minutes)
}
async function saveActionEdit(a) {
  const tid = taskId.value
  const r = await runSave(() => store.editAction(a, editActionText.value, editActionMinutes.value))
  // 旧回调不关新任务/另一行动的编辑态。
  if (r && r.ok && taskId.value === tid && editingActionId.value === a.id) editingActionId.value = null
}
async function toggleDone(a) {
  await runSave(() => store.setActionDone(a, !a.done))
}
async function selectCurrent(a) {
  await runSave(() => store.setCurrentAction(task.value, a.id))
}
async function clearCurrent() {
  await runSave(() => store.setCurrentAction(task.value, null))
}

// —— 开始执行：独立任务主入口在当前行动区；带 plan 上下文时走共享开始确认（5A-2B §3）——
const localUnfinished = computed(() => focus.unfinished[0] || null)
const sameActionSession = computed(() => {
  const s = localUnfinished.value
  return s && task.value && currentAction.value && s.task_id === task.value.id && s.action_id === currentAction.value.id ? s : null
})
const otherLocalSession = computed(() => (localUnfinished.value && !sameActionSession.value ? localUnfinished.value : null))
// 跨空间运行：只解释与提供入口，绝不替它暂停/结束/接管。
const otherWsRunning = computed(() =>
  focus.running && focus.running.workspace_id !== store.workspaceId ? focus.running : null)
const otherWsName = computed(() => {
  const r = otherWsRunning.value
  if (!r) return ''
  const w = store.workspaces.find((x) => x.id === r.workspace_id)
  return w ? w.name : r.workspace_id
})

// 安排上下文入口优先级：同安排未结束→回到工作；同 Task/Action 但不同安排不算同一安排工作。
const planEntry = computed(() => planStartEntry({
  plan: planCtxPlan.value, task: task.value, docs: store.docs,
  localUnfinished: localUnfinished.value, crossWsRunning: otherWsRunning.value,
}))
const planEntryReasonText = computed(() => {
  const e = planEntry.value
  if (e.reason === 'task-done') return '任务已完成，不能开始新工作；重新打开任务后再安排。'
  if (e.reason === 'terminal') return '该安排已是历史（完成/取消/改期），不能开始；继续工作请另安排一天。'
  return '该安排的任务引用已断开（历史只读），不能开始工作。'
})
// 工作页 return：有真实安排关联→在已验证的来源上下文里定位安排（保留来源视图/日期偏好，
// 只对齐目标日）；来源不是日程或无关联→规范化任务详情地址。绝不丢弃已校验的 return 重造地址。
function workReturnFor(session) {
  if (session && session.plan_item_id) {
    const p = store.docs.find((d) => d.kind === 'plan_item' && d.id === session.plan_item_id)
    if (p) {
      const ret = returnPath.value
      const qi = ret.indexOf('?')
      const path = qi >= 0 ? ret.slice(0, qi) : ret
      const query = Object.fromEntries(new URLSearchParams(qi >= 0 ? ret.slice(qi + 1) : ''))
      return planScheduleReturn(path, query, p, todayStr.value)
    }
  }
  return taskReturn.value
}
const startCtrl = usePlanWorkStart({
  onStarted: (sid, meta) => {
    bypassGuard = true
    store.say('success', meta.existing ? '该安排已有未结束工作，已回到该会话（不会自动继续计时）' : '工作会话已创建，进入工作页开始计时')
    router.push(workPath(sid, workReturnFor(meta.session)))
  },
  onGotoTask: () => focusAddAction(),
  onReview: (planId) => {
    detailPlanId.value = planId
    store.say('warning', '该安排已有结束历史，请在下方安排详情核对进度后再开始')
  },
  workReturnFor,
})

const beginBusy = ref(false)
const beginError = ref(null)
const blockedConfirmOpen = ref(false)
const conflictOpen = ref(false)
const conflictSession = ref(null)

function continueSame() {
  const s = sameActionSession.value
  if (s) router.push(workPath(s.id, workReturnFor(s)))
}
function openConflict(s) {
  conflictSession.value = s
  conflictOpen.value = true
}
function gotoConflict() {
  const s = conflictSession.value
  conflictOpen.value = false
  if (s) router.push(workPath(s.id, workReturnFor(s)))
}
async function gotoOtherWs() {
  const r = otherWsRunning.value
  if (!r) return
  await store.switchWorkspace(r.workspace_id)
  await nextTick()
  router.push(workPath(r.session_id))
}

function startWork() {
  if (beginBusy.value || !task.value) return
  // 失效安排上下文绝不静默降级为独立工作：只能返回日程或显式「改为独立工作」确认后开始。
  if (planCtx.value.status === 'invalid') return
  beginError.value = null
  // 脏编辑先按既有规则处置：确认丢弃才开始，取消保留编辑不创建会话。
  if (dirty.value && !window.confirm('任务有未保存的修改，开始执行将丢弃这些输入。可先取消并保存。仍要开始吗？')) return
  if (dirty.value) resetDrafts()
  // 显式安排上下文：共享确认面板（blocked/非当日确认在面板内），不再走独立 doBegin。
  if (planCtxPlan.value) {
    if (bindingStatus.value === 'loading') return
    if (!scheduledAction.value) {
      detailPlanId.value = planCtxPlan.value.id
      return
    }
    if (startCtrl.openFor({ taskId: task.value.id, planId: planCtxPlan.value.id, actionId: scheduledAction.value.id }) && startCtrl.canConfirm.value) {
      void startCtrl.submit()
    }
    return
  }
  if (!currentAction.value) return
  if (task.value.status === 'blocked') {
    blockedConfirmOpen.value = true
    return
  }
  doBegin(false)
}
function startPlanEntryAction() {
  const e = planEntry.value
  if (e.kind === 'existing') return router.push(workPath(e.session.id, workReturnFor(e.session)))
  if (e.kind === 'local-conflict') return openConflict(e.session)
  if (e.kind === 'review') {
    detailPlanId.value = planCtxPlan.value.id
    store.say('warning', '该安排已有结束历史，请在下方安排详情核对进度后再开始')
    return
  }
  if (e.kind === 'start') return startWork()
}
function confirmBlockedBegin() {
  blockedConfirmOpen.value = false
  doBegin(true)
}
// 失效安排上下文 → 独立工作：必须显式确认；确认后清除 plan 参数再走独立开始，不静默降级。
const independentConfirmOpen = ref(false)
function requestIndependent() {
  if (beginBusy.value || !task.value || !currentAction.value) return
  if (planCtx.value.status !== 'invalid') return
  if (dirty.value && !window.confirm('任务有未保存的修改，开始执行将丢弃这些输入。可先取消并保存。仍要开始吗？')) return
  if (dirty.value) resetDrafts()
  independentConfirmOpen.value = true
}
async function confirmIndependent() {
  independentConfirmOpen.value = false
  const q = { ...route.query }
  delete q.plan
  await router.replace({ query: q })
  startWork()
}
async function doBegin(confirmBlocked) {
  if (beginBusy.value || !task.value || !currentAction.value) return
  const ws = store.workspaceId
  const tid = task.value.id
  const aid = currentAction.value.id
  beginBusy.value = true
  try {
    const env = focus.issueRequest('begin', { taskId: tid, actionId: aid })
    const r = await focus.begin({ taskId: tid, actionId: aid, confirmBlocked, requestId: env.request_id, issuedAtMs: env.issued_at_ms })
    if (r.ok) {
      if (store.workspaceId !== ws || taskId.value !== tid) return
      bypassGuard = true
      const sid = (r.session && r.session.id) || r.session_id
      router.push(workPath(sid, workReturnFor(r.session)))
      return
    }
    if (r.code === 'ALREADY_ACTIVE' || r.code === 'LEGACY_RECOVERY_REQUIRED') {
      const s = r.session || null
      beginError.value = {
        message: r.code === 'LEGACY_RECOVERY_REQUIRED'
          ? '存在旧版未结束会话，需先到该工作页显式结束后才能开始新工作。'
          : '本空间已有未结束的工作（含暂停），先处理它再开始新的一段。',
        session: s,
      }
      return
    }
    if (r.needsConfirmBlocked) {
      blockedConfirmOpen.value = true
      return
    }
    beginError.value = { message: r.message || '开始失败，未创建会话，可重试', session: null }
  } finally {
    beginBusy.value = false
  }
}

// —— 结束回跳横幅 + 本任务已结束历史（先求和再格式化；倒序稳定） ——
const recordedId = computed(() => (typeof route.query.recorded === 'string' ? route.query.recorded : ''))
// §7：只有在当前空间读到匹配的已结束记录才展示；旧 URL/刷新不伪造当时结果。
const recordedSession = computed(() =>
  (recordedId.value ? focus.sessions.find((s) => s.id === recordedId.value && s.ended_at != null) || null : null))
function dismissRecorded() {
  const q = { ...route.query }
  delete q.recorded
  router.replace({ query: q })
}
const taskSessions = computed(() => endedSessionsSorted(focus.sessions.filter((s) => s.task_id === taskId.value)))
const taskTotalMs = computed(() => taskSessions.value.reduce((acc, s) => acc + (s.accumulated_ms || 0), 0))
const OUTCOME_VARIANTS = { done: 'success', partial: 'secondary', blocked: 'warning' }
function recordLink(s) {
  return recordPath(s.id, taskReturn.value)
}

// —— 跨日安排清单 + 共享编辑器/详情宿主（5A-1 §2/§4）：与日程页同一组件同一提交逻辑 ——
const taskPlans = computed(() =>
  store.docs
    .filter((d) => d.kind === 'plan_item' && d.task_id === taskId.value)
    .sort((a, b) => (a.date === b.date ? (a.order ?? 0) - (b.order ?? 0) : a.date < b.date ? -1 : 1)))
const showAllPlans = ref(false)
const visibleTaskPlans = computed(() => showAllPlans.value ? taskPlans.value : taskPlans.value.filter(p => p.date >= todayStr.value && ['planned', 'partial'].includes(p.state)).slice(0, 3))
const detailPlanId = ref('')
const detailPlan = computed(() =>
  (detailPlanId.value ? store.docs.find((d) => d.kind === 'plan_item' && d.id === detailPlanId.value) || null : null))
watch([() => store.ready, detailPlanId, () => store.docs], () => {
  if (!store.ready || !detailPlanId.value || detailPlan.value) return
  store.say('warning', '安排已不存在或不属于当前空间')
  detailPlanId.value = ''
}, { immediate: true })
const editor = ref(null)
const editorRef = ref(null)
let editorSeq = 0
// 同页重开/切目标先统一结算当前编辑器（脏草稿/待核实弹放弃确认，保存中禁止替换），放弃才换新表单。
async function openEditor(cfg) {
  if (editor.value && editorRef.value && !(await editorRef.value.guardLeave())) return
  editorSeq += 1
  editor.value = { ...cfg, key: editorSeq }
}
function onPlanSaved(payload) {
  editor.value = null
  detailPlanId.value = payload.planId
}
async function openDetail(id) {
  if (editorRef.value && !(await editorRef.value.guardLeave())) return
  editor.value = null
  detailPlanId.value = id
}
// 草稿不串任务/工作区：切换即关闭编辑器与详情（离开守卫已先结算草稿）。
watch(taskId, () => { editor.value = null; detailPlanId.value = ''; showAllPlans.value = false })
watch(() => store.workspaceId, () => { editor.value = null; detailPlanId.value = ''; showAllPlans.value = false; resetWorkLeaveApproval() })
// 离开保护叠加：先结算编辑器草稿（放弃/继续），再任务脏输入；两者都放行才离开。
async function guardLeave() {
  if (editorRef.value && !(await editorRef.value.guardLeave())) return false
  return confirmLeaveIfDirty()
}
const unregister = registerWorkLeave(guardLeave)
onBeforeUnmount(unregister)
onBeforeRouteLeave(requestWorkLeave)
onBeforeRouteUpdate(async (to, from) => {
  const allowed = await guardLeave()
  if (allowed && to.fullPath !== from.fullPath) { editor.value = null; detailPlanId.value = '' }
  return allowed
})

const deleteActionTarget = ref(null)
const deleteActionOpen = ref(false)
async function confirmDeleteAction() {
  const a = deleteActionTarget.value
  deleteActionOpen.value = false
  deleteActionTarget.value = null
  if (a) await runSave(() => store.deleteAction(a))
}

const finishConfirmOpen = ref(false)
function requestFinish() {
  if (unfinishedCount.value > 0) finishConfirmOpen.value = true
  else runSave(() => store.finishTask(task.value))
}
async function confirmFinish() {
  finishConfirmOpen.value = false
  await runSave(() => store.finishTask(task.value))
}
async function reopen() {
  await runSave(() => store.reopenTask(task.value))
}

const deleteTaskOpen = ref(false)
const taskScopeNotice = ref(false)
// §10：打开确认框时冻结影响事实（任务/行动/安排处置），提交原快照；
// 范围或处置变化 → 不删除，刷新后重新冻结、重新确认。
const deleteFacts = ref(null)
const deleteBlocked = computed(() => !!deleteFacts.value && deleteFacts.value.rows.some((r) => r.disposition.startsWith('blocked')))
function freezeDeleteFacts() {
  const t = task.value
  if (!t) return
  const snap = deleteImpactSnapshot(store.docs, [t.id], store.docs.filter((d) => d.kind === 'focus_session'))
  deleteFacts.value = { taskIds: [t.id], actionIds: taskActions.value.map((a) => a.id), ...snap }
}
function openDeleteTask() {
  taskScopeNotice.value = false
  freezeDeleteFacts()
  deleteTaskOpen.value = true
}
async function confirmDeleteTask() {
  const t = task.value
  const frozen = deleteFacts.value
  if (!t || !frozen) { deleteTaskOpen.value = false; return }
  deleteTaskOpen.value = false
  const r = await runSave(() => store.deleteTask(t, {
    taskIds: frozen.taskIds, actionIds: frozen.actionIds, planItemIds: frozen.planItemIds, planFacts: frozen.planFacts,
  }))
  if (r && r.ok) {
    bypassGuard = true
    router.replace(returnPath.value)
  } else if (r && (r.scopeChanged || r.planProgressRequired || r.unfinishedFocus)) {
    await store.reloadDocs()
    taskScopeNotice.value = true
    freezeDeleteFacts()
    deleteTaskOpen.value = true
  }
}
function deleteGotoPlan(r) {
  deleteTaskOpen.value = false
  detailPlanId.value = r.id
}
function deleteGotoWork(r) {
  deleteTaskOpen.value = false
  const s = focus.sessions.find((x) => x.id === r.unfinishedSessionId) || null
  router.push(workPath(r.unfinishedSessionId, workReturnFor(s)))
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" @click="router.push(returnPath)"><ArrowLeft />{{ taskReturnLabel(returnPath) }}</Button>
      <span class="ml-auto text-xs" :class="saveState === 'error' ? 'text-destructive' : 'text-muted-foreground'" aria-live="polite">{{ saveStateText }}</span>
    </div>

    <ContinueBar />

    <!-- 显式执行安排上下文（§2/§4）：为这项安排选择行动；无效只提示，不自动跳转/切空间 -->
    <Card v-if="planCtxPlan" class="border-primary/40">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="font-medium">为这项安排选择行动</span>
        <span class="font-date text-xs text-muted-foreground">{{ planCtxPlan.date }}</span>
        <Badge :variant="planCtxPlan.state === 'partial' ? 'warning' : 'secondary'">{{ label(PLAN_STATE_LABELS, planCtxPlan.state) }}</Badge>
        <Button size="sm" variant="ghost" class="ml-auto" @click="router.push(planCtxScheduleTarget)">在日程中查看</Button>
      </div>
      <p class="mt-1 break-words text-sm">{{ planCtxPlan.action_text }}</p>
      <p class="mt-1 text-xs text-muted-foreground">预计 {{ planCtxPlan.planned_minutes }} 分钟 · 安排说明不覆盖行动内容；请在下方明确选择或新增实际行动后开始。</p>
    </Card>
    <Alert v-else-if="planCtxInvalidText" variant="warning">
      {{ planCtxInvalidText }}
    </Alert>

    <Alert v-if="recordedSession" variant="success">
      这次记录已保存<template v-if="recordedSession.outcome"> · 行动{{ label(SESSION_OUTCOME_LABELS, recordedSession.outcome) }}</template>。
      <RouterLink :to="recordLink(recordedSession)" class="ml-1 underline">查看该记录</RouterLink>
      <button type="button" class="ml-2 text-xs underline" @click="dismissRecorded">知道了</button>
    </Alert>

    <template v-if="task">
      <!-- 任务摘要：标题 / 状态 / 截止及出处 / 事项，只出现一次 -->
      <Card>
        <div class="flex flex-wrap items-start gap-2">
          <template v-if="renaming">
            <Input v-model="draftTitle" class="h-9 min-w-40 flex-1" aria-label="重命名任务" @keyup.enter="saveTitle" />
            <Button size="sm" @click="saveTitle"><Check />保存</Button>
            <Button size="sm" variant="outline" @click="renaming = false">取消</Button>
          </template>
          <template v-else>
            <h1 class="min-w-0 flex-1 basis-40 break-words text-lg font-semibold leading-snug">{{ task.title }}</h1>
            <Button size="sm" variant="ghost" aria-label="重命名任务" title="重命名" @click="startRename"><Pencil /></Button>
          </template>
          <Badge :variant="task.status === 'done' ? 'success' : 'secondary'" :title="task.status">{{ label(STATUS_LABELS, task.status) }}</Badge>
          <Button v-if="task.status !== 'done'" size="sm" variant="outline" @click="requestFinish"><Check />完成任务</Button>
          <Button v-else size="sm" variant="outline" @click="reopen">重新打开</Button>
          <Button size="sm" variant="destructive" aria-label="删除任务" title="删除任务" @click="openDeleteTask"><Trash2 /></Button>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <template v-if="deadlineEditing">
            <DateInput v-model="draftDeadline" allow-time placeholder="任务截止" aria-label="任务截止" class="max-w-52" />
            <Button size="sm" @click="saveDeadline">保存截止</Button>
            <Button size="sm" variant="outline" @click="clearDeadline">清空截止</Button>
            <Button size="sm" variant="ghost" @click="deadlineEditing = false">取消</Button>
          </template>
          <template v-else>
            <span class="font-date font-medium">{{ deadlineText }}</span>
            <span v-if="deadlineSource" class="text-xs text-muted-foreground">{{ deadlineSource }}</span>
            <Button size="sm" variant="ghost" aria-label="编辑截止" title="编辑截止" @click="startDeadlineEdit"><Pencil /></Button>
          </template>
          <span class="text-xs text-muted-foreground">所属事项</span>
          <div class="w-32"><NodeSelect v-model="matterModel" :items="matterItems" placeholder="未归组" /></div>
        </div>
        <p v-if="task.status !== 'done' && unfinishedCount > 0" class="mt-2 text-xs text-muted-foreground">
          完成任务是独立操作：不会自动把 {{ unfinishedCount }} 个未完成行动标为完成。
        </p>
      </Card>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div class="space-y-4">
          <!-- 当前行动：手机单列时优先展示 -->
          <Card>
            <template #header>
              <div class="text-base font-semibold">当前行动</div>
            </template>
            <div v-if="task.status === 'done'" class="text-sm text-muted-foreground">
              任务已完成，重新打开后才能开始新工作。
            </div>
            <template v-else>
              <div v-if="currentAction" class="flex flex-wrap items-center gap-2">
                <div class="min-w-0 flex-1 basis-40">
                  <div class="break-words text-sm font-medium">{{ currentAction.text }}</div>
                  <div class="mt-0.5 text-xs text-muted-foreground">预计 {{ currentAction.minutes }} 分钟</div>
                </div>
                <Button size="sm" variant="outline" @click="toggleDone(currentAction)"><Check />完成行动</Button>
                <Button size="sm" variant="outline" @click="clearCurrent">取消当前</Button>
              </div>
              <div v-else-if="taskActions.length" class="text-sm text-muted-foreground">
                从下方行动列表选择下一步。
              </div>
              <div v-else class="space-y-2">
                <p class="text-sm text-muted-foreground">还没有行动。添加下一步，把任务拆成可以开始的小步骤。</p>
                <Button size="sm" variant="outline" @click="focusAddAction"><Plus />添加下一步</Button>
              </div>

              <!-- 安排上下文：入口按优先级（§3.1），无当前行动也可打开确认面板（禁用开始，引导选择） -->
              <div v-if="planCtxPlan" class="mt-2 flex flex-wrap items-center gap-2 border-t border-dashed pt-2">
                <template v-if="planEntry.kind === 'existing'">
                  <Button size="sm" @click="startPlanEntryAction"><Play />回到工作</Button>
                  <span class="text-xs text-muted-foreground">该安排已有未结束工作（含暂停），进入不会自动继续计时。</span>
                </template>
                <template v-else-if="planEntry.kind === 'local-conflict'">
                  <Button size="sm" variant="outline" @click="startPlanEntryAction"><Play />先处理已有工作</Button>
                  <span class="text-xs text-muted-foreground">本空间已有未结束的工作，先处理它再开始这项安排。</span>
                </template>
                <template v-else-if="planEntry.kind === 'cross-ws'">
                  <span class="text-xs text-muted-foreground">另一空间有正在运行的工作，先处理它再开始这项安排。</span>
                </template>
                <template v-else-if="planEntry.kind === 'review'">
                  <Button size="sm" variant="outline" @click="startPlanEntryAction">核对已有进度</Button>
                  <span class="text-xs text-muted-foreground">该安排已有结束历史，先核对进度后再开始。</span>
                </template>
                <template v-else-if="planEntry.kind === 'history-unresolved'">
                  <Button size="sm" variant="outline" @click="detailPlanId = planCtxPlan.id">查看安排详情</Button>
                  <span class="text-xs text-warning-foreground">历史用时存在异常待核对，先处理相关记录后才能开始。</span>
                </template>
                <template v-else-if="planEntry.kind === 'start'">
                  <Button size="sm" :disabled="bindingStatus === 'loading' || !!startCtrl.state.value?.busy" @click="startPlanEntryAction"><Play />开始这项安排</Button>
                  <span v-if="scheduledAction" class="text-xs text-muted-foreground">执行行动 · {{ scheduledAction.text }}</span>
                </template>
                <span v-else class="text-xs text-muted-foreground">{{ planEntryReasonText }}</span>
              </div>
              <!-- 失效安排上下文：不静默降级独立工作；返回日程，或显式「改为独立工作」确认后才开始 -->
              <div v-else-if="planCtx.status === 'invalid'" class="mt-2 flex flex-wrap items-center gap-2 border-t border-dashed pt-2">
                <Button v-if="currentAction" size="sm" variant="outline" @click="requestIndependent">改为独立工作</Button>
                <span class="text-xs text-warning-foreground">安排上下文失效，直接开始不会关联任何安排；改为独立工作需明确确认。</span>
              </div>
              <!-- 独立任务：沿用既有开始/继续/冲突入口 -->
              <div v-else-if="currentAction" class="mt-2 flex flex-wrap items-center gap-2 border-t border-dashed pt-2">
                <template v-if="sameActionSession">
                  <Button size="sm" @click="continueSame"><Play />继续上次工作</Button>
                  <span class="text-xs text-muted-foreground">{{ sameActionSession.running ? '该行动正在计时' : '上次工作已暂停，进入后点「继续计时」' }}</span>
                </template>
                <template v-else-if="otherLocalSession">
                  <Button size="sm" @click="openConflict(otherLocalSession)"><Play />处理上次工作</Button>
                  <span class="text-xs text-muted-foreground">本空间已有未结束的工作，先处理它再开始新的一段。</span>
                </template>
                <template v-else>
                  <Button size="sm" :disabled="beginBusy" @click="startWork"><Play />{{ beginBusy ? '正在开始…' : '开始执行' }}</Button>
                  <span class="text-xs text-muted-foreground">进入执行页记录成果并计时。</span>
                </template>
              </div>
            </template>
            <Alert v-if="otherWsRunning" variant="warning" class="mt-2">
              「{{ otherWsName }}」有一段正在运行的工作。同一时间只能运行一段；这里不会替它暂停或结束。
              <Button size="sm" variant="outline" class="ml-2" @click="gotoOtherWs">前往{{ otherWsName }}查看</Button>
            </Alert>
            <Alert v-if="beginError" variant="destructive" class="mt-2">
              {{ beginError.message }}
              <Button v-if="beginError.session" size="sm" variant="outline" class="ml-2" @click="openConflict(beginError.session); beginError = null">前往该工作</Button>
              <Button v-else size="sm" variant="outline" class="ml-2" @click="beginError = null">知道了</Button>
            </Alert>
          </Card>

          <!-- 行动列表 + 手动添加（3A 无执行会话：不提供计时按钮） -->
          <Card>
            <template #header>
              <div class="text-base font-semibold">行动列表 · {{ taskActions.length }}</div>
              <p class="text-xs text-muted-foreground">手动填写内容与预计分钟；完成行动不等于完成任务。</p>
            </template>
            <div class="space-y-2">
              <div v-for="a in taskActions" :key="a.id" class="rounded-md border p-2.5">
                <div v-if="editingActionId === a.id" class="flex flex-wrap items-center gap-2">
                  <Input v-model="editActionText" class="h-8 min-w-40 flex-1" aria-label="编辑行动内容" @keyup.enter="saveActionEdit(a)" />
                  <Input v-model="editActionMinutes" type="number" min="1" step="1" class="h-8 w-20" aria-label="编辑预计分钟" />
                  <Button size="sm" @click="saveActionEdit(a)"><Check />保存</Button>
                  <Button size="sm" variant="outline" @click="editingActionId = null">取消</Button>
                </div>
                <div v-else class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    class="flex size-5 shrink-0 items-center justify-center rounded border"
                    :class="a.done ? 'border-success bg-success text-success-foreground' : 'border-input hover:border-ring'"
                    :aria-label="(a.done ? '重新打开行动：' : '完成行动：') + a.text"
                    :aria-pressed="a.done"
                    @click="toggleDone(a)"
                  ><Check v-if="a.done" class="size-3.5" /></button>
                  <div class="min-w-0 flex-1 basis-40">
                    <span class="break-words text-sm" :class="a.done && 'line-through opacity-70'">{{ a.text }}</span>
                    <span class="ml-2 text-xs text-muted-foreground">{{ a.minutes }} 分钟</span>
                    <Badge v-if="currentAction && currentAction.id === a.id" variant="warning" class="ml-2">当前</Badge>
                  </div>
                  <Button v-if="!a.done && (!currentAction || currentAction.id !== a.id)" size="sm" variant="outline" @click="selectCurrent(a)">设为当前</Button>
                  <Button size="sm" variant="ghost" :aria-label="'编辑行动：' + a.text" title="编辑" @click="startEditAction(a)"><Pencil /></Button>
                  <Button size="sm" variant="ghost" :aria-label="'删除行动：' + a.text" title="删除" @click="deleteActionTarget = a; deleteActionOpen = true"><Trash2 /></Button>
                </div>
              </div>
              <p v-if="!taskActions.length" class="text-sm text-muted-foreground">暂无行动。</p>
              <div class="flex flex-wrap items-center gap-2 border-t border-dashed pt-2.5">
                <Input v-model="newText" class="h-9 min-w-40 flex-1" placeholder="新行动内容…" aria-label="新行动内容" @keyup.enter="addAction" />
                <Input v-model="newMinutes" type="number" min="1" step="1" class="h-9 w-20" aria-label="预计分钟" />
                <span class="text-xs text-muted-foreground">分钟</span>
                <Button size="sm" :disabled="addingAction" @click="addAction"><Plus />{{ addingAction ? '正在保存…' : '添加行动' }}</Button>
              </div>
            </div>
          </Card>

          <!-- 跨日安排：按日期序含历史；整卡进详情，操作按资格（§5.2）；不改任务截止/行动 -->
          <Card>
            <template #header>
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-base font-semibold">近期安排</span>
                <Button v-if="task.status !== 'done'" size="sm" variant="outline" class="ml-auto" @click="router.push(replanLink)"><CalendarClock />调整后续安排</Button>
                <Button v-if="task.status !== 'done'" size="sm" variant="outline" @click="openEditor({ mode: 'create', taskId: task.id, locked: true })"><Plus />安排工作</Button>
              </div>
            </template>
            <div class="space-y-2">
              <div v-for="p in visibleTaskPlans" :key="p.id" class="space-y-1">
                <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span class="font-date font-medium">{{ p.date }}</span>
                  <Badge :variant="p.state === 'done' ? 'success' : p.state === 'partial' ? 'warning' : 'secondary'">{{ label(PLAN_STATE_LABELS, p.state) }}</Badge>
                  <span v-if="p.task_ref_state === 'deleted'">原任务已删除</span>
                </div>
                <PlanCard :plan="p" :task="task" @open="openDetail" />
              </div>
              <p v-if="!visibleTaskPlans.length" class="text-sm text-muted-foreground">暂无{{ showAllPlans ? '' : '后续' }}安排。</p>
              <button v-if="showAllPlans || taskPlans.length > visibleTaskPlans.length" type="button" class="text-sm text-muted-foreground underline" :aria-expanded="showAllPlans" @click="showAllPlans = !showAllPlans">{{ showAllPlans ? '收起历史安排' : `查看全部 ${taskPlans.length} 项安排` }}</button>
            </div>
          </Card>

          <!-- 本任务已结束工作：快照标题/行动、北京起止、实际用时、结果；删除任务后仍可在独立记录页回看 -->
          <details v-if="taskSessions.length" class="rounded-lg border bg-card p-4">
            <summary class="mb-3 cursor-pointer text-base font-semibold">工作记录 · {{ taskSessions.length }} 段</summary>
            <div class="mb-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>合计 {{ formatDurationMs(taskTotalMs) }}</span><RouterLink to="/work-records" class="underline">全部工作记录</RouterLink></div>
            <ul class="space-y-2">
              <li v-for="s in taskSessions" :key="s.id" class="rounded-md border p-2.5 text-sm">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span class="min-w-0 flex-1 basis-40 break-words">
                    {{ sessionActionText(s) || (s.record_version === 1 ? '（无行动快照）' : '旧版记录（无快照）') }}
                  </span>
                  <Badge :variant="OUTCOME_VARIANTS[s.outcome] || 'secondary'">{{ s.outcome ? label(SESSION_OUTCOME_LABELS, s.outcome) : '未记录结果' }}</Badge>
                  <span class="font-date tabular-nums">{{ formatDurationMs(s.accumulated_ms) }}</span>
                  <RouterLink :to="recordLink(s)" class="text-xs underline">查看成果</RouterLink>
                </div>
                <div class="mt-1 text-xs text-muted-foreground">
                  {{ beijingInstantLabel(s.started_at) }} → {{ beijingInstantLabel(s.ended_at) }}（北京时间）
                  <template v-if="s.action_ref_state === 'deleted'"> · 原行动已删除</template>
                </div>
                <p v-if="s.outcome === 'blocked' && s.blocker" class="mt-1 break-words text-xs text-warning-foreground">卡点：{{ s.blocker }}</p>
              </li>
            </ul>
          </details>
        </div>

        <div class="space-y-4">
          <!-- 说明与完成标准 -->
          <details class="rounded-lg border bg-card p-4">
            <summary class="mb-3 cursor-pointer text-base font-semibold">说明与完成标准</summary>
            <div class="space-y-3">
              <div>
                <Textarea v-model="draftDescription" class="min-h-20" placeholder="任务说明（交付什么、交给谁…）" aria-label="任务说明" />
                <Button size="sm" variant="outline" class="mt-1.5" @click="saveDescription">保存说明</Button>
              </div>
              <div>
                <Textarea v-model="draftCriteria" class="min-h-20" placeholder="完成标准（怎样算做完，可稍后补）" aria-label="完成标准" />
                <Button size="sm" variant="outline" class="mt-1.5" @click="saveCriteria">保存完成标准</Button>
              </div>
            </div>
          </details>

          <!-- 关联资料：只读出处，不改便签事实 -->
          <details class="rounded-lg border bg-card p-4">
            <summary class="mb-3 cursor-pointer text-base font-semibold">关联资料</summary>
            <div class="space-y-1.5">
              <div v-for="n in relatedNotes" :key="n.id">
                <RouterLink :to="noteLink(n)" class="text-sm underline">便签「{{ n.title }}」</RouterLink>
              </div>
              <p v-if="!relatedNotes.length" class="text-sm text-muted-foreground">暂无关联资料。</p>
            </div>
          </details>
        </div>
      </div>
    </template>

    <!-- 共享安排编辑器/详情：与日程页同一组件；保存后定位本任务清单内的目标卡片 -->
    <PlanWorkspace ref="editorRef" :editor="editor" :plan-id="detailPlanId" @close="editor = null; detailPlanId = ''" @saved="onPlanSaved"
      @edit="id => openEditor({ mode: 'edit', planId: id })" @move="id => openEditor({ mode: 'move', planId: id })"
      @another="id => openEditor({ mode: 'another', planId: id })" @op-done="onPlanSaved" />

    <ConfirmDialog v-model="finishConfirmOpen" title="完成任务" confirm-label="确认整体完成" @confirm="confirmFinish">
      还有 {{ unfinishedCount }} 个行动未完成。完成任务不会自动把它们标为完成；之后仍可重新打开任务。
    </ConfirmDialog>
    <ConfirmDialog v-model="deleteActionOpen" title="删除行动" confirm-label="删除行动" @confirm="confirmDeleteAction">
      将删除行动「{{ deleteActionTarget ? deleteActionTarget.text : '' }}」。<template v-if="deleteActionTarget && currentAction && currentAction.id === deleteActionTarget.id">它是当前行动，删除后当前选择一并清空。</template>删除后可在「日程 · 恢复」撤销。
    </ConfirmDialog>
    <ConfirmDialog v-model="deleteTaskOpen" title="删除任务" confirm-label="删除任务" :confirm-disabled="deleteBlocked" @confirm="confirmDeleteTask">
      <p v-if="taskScopeNotice" class="mb-2 rounded bg-warning px-2 py-1 text-xs text-warning-foreground">删除范围或安排事实已变化（其它页面新增/移除了对象，或安排已执行）。请核对下方最新影响后重新确认。</p>
      将删除任务「{{ task.title }}」<template v-if="taskActions.length">及其 {{ taskActions.length }} 个行动</template>。删除后可在「日程 · 恢复」撤销；不影响便签事实与原始资料。
      <DeleteImpact
        :rows="deleteFacts ? deleteFacts.rows : []"
        empty-text="该任务没有安排，删除不影响任何安排。"
        @goto-plan="deleteGotoPlan"
        @goto-work="deleteGotoWork"
      />
    </ConfirmDialog>

    <ConfirmDialog v-model="blockedConfirmOpen" title="任务处于受阻状态" confirm-label="确认并开始执行" @confirm="confirmBlockedBegin">
      该任务当前标记为受阻。确认要继续推进「{{ currentAction ? currentAction.text : '' }}」吗？开始不会自动改变任务的受阻标记。
    </ConfirmDialog>
    <ConfirmDialog v-model="independentConfirmOpen" tone="primary" title="改为独立工作" confirm-label="确认改为独立工作" @confirm="confirmIndependent">
      链接中的安排已失效（不存在、不属于本任务或引用断开）。改为独立工作将清除安排上下文，创建的会话不关联任何安排；原安排与其历史保持原样。
    </ConfirmDialog>

    <!-- 共享开始确认面板（§3.2/§3.3）：安排上下文专用；独立任务仍走上方 blocked 确认 -->
    <StartPlanWorkDialog :ctrl="startCtrl" />

    <!-- 本空间已有未结束工作（其它行动/任务）：前往处理或取消，不自动暂停/结束它 -->
    <DialogRoot v-model:open="conflictOpen">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-black/50" />
        <DialogContent class="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-4 shadow-lg">
          <DialogTitle class="text-base font-semibold">处理上次工作</DialogTitle>
          <DialogDescription class="mt-2 text-sm text-muted-foreground">
            本空间已有未结束的工作（含暂停），同一空间同时只能有一段：
            <span class="mt-1 block break-words font-medium text-foreground">
              {{ conflictSession ? (sessionTitle(conflictSession) || '旧版记录（无快照）') : '' }}
              <template v-if="conflictSession && sessionActionText(conflictSession)"> · {{ sessionActionText(conflictSession) }}</template>
            </span>
            前往该工作页暂停或结束后，再回来开始新的一段。
          </DialogDescription>
          <div class="mt-4 flex justify-end gap-2">
            <Button variant="outline" @click="conflictOpen = false">取消</Button>
            <Button @click="gotoConflict">前往该工作</Button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
