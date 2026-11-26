<script setup>
import { deadlineSource } from '@/domains/assistant/application'
import PlanAgenda from '@/components/assistant/PlanAgenda.vue'
import ManualGapRow from '@/components/assistant/ManualGapRow.vue'
import { manualSlots, scheduleWithManualSlots } from '@/domains/assistant/manualSchedule'
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import DateInput from '@/components/ui/DateInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import PlanInput from '@/components/assistant/PlanInput.vue'
import DemoWalkthrough from '@/components/assistant/DemoWalkthrough.vue'
import GenerationPanel from '@/components/assistant/GenerationPanel.vue'
import SourceReview from '@/components/assistant/SourceReview.vue'
import ReplanPanel from '@/components/assistant/ReplanPanel.vue'
import { resolveMaterialHandoff } from '@/domains/materialHandoff'
import { MAX_SELECTED_SOURCES } from '@/services/assistant/requests'
import { useAssistantStore } from '@/stores/assistant'
import { useAppStore } from '@/stores/app'
import { beijingToday, beijingAddDays, formatWhen, beijingInstantLabel } from '@/domains/time'
import { confirmTaskDeadline } from '@/domains/planning/normalize'
import { replanPreview } from '@/domains/assistant/replan'
import { schedulePath, taskPath, resolveReplanReturn } from '@/domains/workNavigation'
import { useUnsavedGuard } from '@/composables/useUnsavedGuard'
import { registerWorkLeave, requestWorkLeave } from '@/composables/workLeave'

const store = useAssistantStore()
const app = useAppStore()
const router = useRouter()
const route = useRoute()

const tab = ref('edit')
const workflowHeader = ref(null)
watch(tab, async () => {
  await nextTick()
  if (!draft.value) return
  workflowHeader.value?.querySelector('[aria-current="step"]')?.focus({ preventScroll: true })
  workflowHeader.value?.scrollIntoView({ block: 'start' })
})
const entryMode = ref('create')
const inputRef = ref(null)
const replanRef = ref(null)
const generationRef = ref(null)
const advancing = ref(false)
const preparing = ref(false)
const windowBaseline = ref('')
const form = reactive({ startDate: '', budgets: {}, unavailable: [] })
const edit = reactive({ tasks: {}, actions: {}, work: {} })
const extraText = ref('')
const showExtra = ref(false)
const adoptOpen = ref(false)
const discardOpen = ref(false)
const materialConfirm = ref(false)
const materialInputRevision = ref(0)
const materialHandoff = computed(() => app.ready ? resolveMaterialHandoff(route.query, app.workspaceId, app.sources, MAX_SELECTED_SOURCES) : null)
const handoffBusy = computed(() => store.generating || ['save_failed', 'clarification'].includes(store.gen?.phase) || Object.values(store.busy).some(Boolean) || ['applying', 'result_unknown'].includes(store.activeDraft?.status))
function dismissMaterials() {
  const query = { ...route.query }; delete query.sources; delete query.workspace
  router.replace({ query })
}
function acceptMaterials() {
  const handoff = resolveMaterialHandoff(route.query, app.workspaceId, app.sources, MAX_SELECTED_SOURCES)
  if (!handoff?.ok || handoffBusy.value) { app.say('warning', '资料或当前状态已变化，请重新检查'); return }
  store.close()
  materialInputRevision.value += 1
  Object.assign(store.input, { userText: '', sourceIds: [...handoff.ids], taskIds: [], actionIds: [], budgets: {}, unavailable: [], startDate: null, excerpts: {} })
  replanEntry.value = null; replanPick.value = ''; tab.value = 'edit'
  router.replace('/assistant')
  app.say('success', `已选定 ${handoff.ids.length} 份资料，填写要求后再生成`)
}
watch(() => app.workspaceId, () => { materialConfirm.value = false })

// M3 改排入口：任务详情带 replanTask 查询参数直达；助手页先选一个未完成任务。
const replanEntry = ref(null)
const replanPick = ref('')
const openTasks = computed(() => app.docs.filter((d) => d.kind === 'task' && d.status !== 'done'))
watch(() => route.query.replanTask, (v) => {
  if (typeof v === 'string' && v) { replanEntry.value = v; store.close(); tab.value = 'edit' }
}, { immediate: true })
function onReplanStarted() {
  const sourceTaskId = store.activeDraft?.replan_scope?.task_id
  if (!sourceTaskId || sourceTaskId !== route.query.replanTask) return
  replanEntry.value = null
  entryMode.value = 'create'
  replanPick.value = ''
  if (route.query.replanTask) router.replace({ path: '/assistant', query: {
    return: resolveReplanReturn(route.query.return, sourceTaskId, {
      docs: app.docs, ws: app.workspaceId, todayStr: beijingToday(),
    }),
  } })
}
// startReplan 会先打开草案，使入口面板卸载；不能只依赖面板之后的 started 事件。
watch(() => store.activeDraft?.id, () => onReplanStarted())
function cancelReplanEntry() {
  replanEntry.value = null
  if (route.query.replanTask) router.replace({ path: '/assistant' })
}

const today = computed(() => beijingToday())
const draft = computed(() => store.activeDraft)
const proposal = computed(() => draft.value?.proposal ?? null)
const gapRows = computed(() => draft.value?.planning_result?.unscheduled ?? [])
const slots = computed(() => manualSlots(draft.value))
const editingGap = ref(null)
watch([() => draft.value?.id, () => draft.value?.revision, tab], () => { editingGap.value = null })
const result = computed(() => {
  try { return scheduleWithManualSlots(draft.value) } catch { return draft.value?.planning_result }
})
const planningInput = computed(() => draft.value?.planning_input ?? null)
const isReplan = computed(() => draft.value?.mode === 'replan')
const readiness = computed(() => store.readiness)
const EDITABLE = ['editing', 'needs_clarification', 'needs_review', 'ready']
const editable = computed(() => !!draft.value && EDITABLE.includes(draft.value.status))
const applied = computed(() => draft.value?.status === 'applied')
const currentConfs = computed(() => (draft.value?.user_confirmations ?? []).filter((c) => c.draft_revision === draft.value?.revision))
const hasConf = (type, key) => currentConfs.value.some((c) => c.object_type === type && c.object_id_or_key === key)

const STATUS_LABELS = {
  editing: '编辑中', generating: '生成中', needs_clarification: '待澄清', ready: '就绪',
  needs_review: '待核对', applying: '采用中', applied: '已采用', result_unknown: '结果待核实', discarded: '已放弃',
}
const REASON_LABELS = {
  no_capacity: '容量不足', not_splittable: '不可拆分，整段放不下', dependency_blocked: '前置工作未排完',
  outside_horizon: '超出七天窗口', deadline_window: '截止前放不下', needs_deadline_day_window: '需截止当天时段核对',
  overdue_requires_consent: '逾期，须确认补做',
}
const statusVariant = (s) => (s === 'ready' ? 'success' : s === 'applied' ? 'success' : s === 'discarded' ? 'secondary' : s === 'result_unknown' || s === 'needs_review' ? 'warning' : 'secondary')

// 初版不支持的操作：显式说明并阻断采用，绝不自动裁剪。
// M3：替换既有安排在 replan 草案是正式支持路径；create 草案夹带替换集仍阻断。
const unsupported = computed(() => {
  const reasons = []
  if ((proposal.value?.task_proposals ?? []).some((t) => t.op === 'update')) reasons.push('修改既有任务（Task update）')
  if (currentConfs.value.some((c) => c.object_type === 'note_field')) reasons.push('把确认写入便签字段')
  if (!isReplan.value && (planningInput.value?.replacement_ids ?? []).length > 0) reasons.push('替换既有安排')
  return reasons
})

const deadlineDecision = (key) => {
  try {
    return confirmTaskDeadline(currentConfs.value.filter((c) => c.object_type === 'task' && c.field_path === 'deadline'), draft.value.revision, key, 'draft', null, `task ${key}`)
  } catch {
    return { state: 'conflict' }
  }
}
const createTasks = computed(() => (proposal.value?.task_proposals ?? []).filter((t) => t.op === 'create'))
const linkTasks = computed(() => (proposal.value?.task_proposals ?? []).filter((t) => t.op === 'link'))
const taskTitle = (ref) => {
  if (!ref) return ''
  if (ref.kind === 'existing') return app.docs.find((d) => d.id === ref.id && d.kind === 'task')?.title ?? ref.id
  return (proposal.value?.task_proposals ?? []).find((t) => t.key === ref.key)?.title ?? ref.key
}

const workTitle = key => (proposal.value?.work_items ?? []).find(item => item.key === key)?.deliverable || '待核对工作'

// 待确认面板：缺口/过载/额外工作/截止逐项独立确认（确认≠改值）。
function verifiedCandidate(task, candidate) {
  if (!candidate?.value) return false
  try {
    deadlineSource(task, candidate.value, candidate.precision, app.notes,
      (store.active?.thread?.messages ?? []).filter(message => message.role === 'user'))
    return true
  } catch { return false }
}
async function chooseDeadline(task, candidate) {
  if (workflowBusy.value || contentDirty.value) return
  const response = candidate && !verifiedCandidate(task, candidate)
    ? await store.setManualDeadline(task.key, candidate.value)
    : await store.confirmDeadline(task.key, candidate ? { value: candidate.value, precision: candidate.precision } : null)
  if (response?.ok && !isReplan.value && !deadlineConfirms.value.length) await saveAndPreview()
}
const deadlineConfirms = computed(() => createTasks.value
  .filter((t) => (t.deadline_candidates ?? []).some((c) => (c.precision ?? 'none') !== 'none'))
  .map((t) => ({ task: t, decision: deadlineDecision(t.key) }))
  .filter(({task, decision}) => decision.state !== 'confirmed' || (decision.value &&
    !verifiedCandidate(task, task.deadline_candidates.find(c => c.value === decision.value && c.precision === decision.precision)))))
const confirmedDeadlines = computed(() => createTasks.value.flatMap(task => {
  const decision = deadlineDecision(task.key)
  if (decision.state !== 'confirmed' || !decision.value) return []
  return [{ key: task.key, title: task.title, label: formatWhen(decision.value, decision.precision) }]
}))
const overbookConfirms = computed(() => (result.value?.days ?? []).filter((d) => d.overbooked_minutes > 0 && !hasConf('overbook', d.date)))
const extraWorkConfirms = computed(() => (planningInput.value?.extra_work_acknowledged ?? []).filter((k) => !hasConf('extra_work', k)))
// D12 额外工作阻断排程：确认面板不能依赖排程结果，故从排程澄清的结构化键在排程前逐项确认。
const extraWorkPreConfirms = computed(() => [...new Set(
  (store.scheduleClarifications ?? [])
    .filter((c) => c.blocking_reason === 'extra_work_needs_confirmation')
    .flatMap((c) => c.work_item_keys ?? []),
)].filter((k) => !hasConf('extra_work', k)))
// M3 替换范围确认（含「清单不含保留安排覆盖的工作」）：不依赖排程结果，首次排程前与重排 bump 后都须可确认。
const replanScopeConf = computed(() => {
  if (!isReplan.value || !editable.value) return null
  const scope = draft.value.replan_scope
  if (!scope || hasConf('replan_scope', scope.task_id)) return null
  return scope
})
const HANDLED_CODES = ['DEADLINE_UNCONFIRMED', 'GAP_UNCONFIRMED', 'OVERBOOK_UNCONFIRMED', 'EXTRA_WORK_UNCONFIRMED', 'UPDATE_UNCONFIRMED', 'CONFIRMATION_VALUE_STALE', 'DEADLINE_RECOMPUTE_REQUIRED', 'ESTIMATE_UNKNOWN', 'NOT_ACTIVE', 'NO_PROPOSAL', 'REPLAN_SCOPE_UNCONFIRMED']
const otherBlockers = computed(() => (readiness.value?.blockers ?? []).filter((b) => !HANDLED_CODES.includes(b.code) && (result.value || !['NO_COMPUTATION', 'FACT_BASELINE_MISSING'].includes(b.code))))
// 新建任务的截止问题在上方已有具名确认按钮，预览只补充仍需解释的原因。
const previewBlockers = computed(() => (readiness.value?.blockers ?? []).filter(blocker =>
  blocker.code !== 'GAP_UNCONFIRMED' && (blocker.code !== 'DEADLINE_UNCONFIRMED' || !deadlineConfirms.value.length)))
const estimateUnknown = computed(() => result.value?.unknown_items ?? [])

const segmentsByDate = computed(() => {
  const map = {}
  for (const s of result.value?.segments ?? []) (map[s.date] ??= []).push(s)
  for (const list of Object.values(map)) list.sort((a, b) => a.order - b.order)
  return map
})

// M3 三块预览：保留（窗口内未选，含其它任务）/ 将取消（基线覆盖）/ 将新增（排程段）。
const replanView = computed(() => {
  if (!isReplan.value || !result.value) return null
  return replanPreview({
    baseline: draft.value.replacement_baseline,
    segments: result.value.segments ?? [],
    planItems: app.docs.filter((d) => d.kind === 'plan_item'),
    scope: draft.value.replan_scope,
  })
})
const replanTotals = computed(() => {
  const ws = proposal.value?.work_items ?? []
  return {
    total: ws.reduce((a, w) => a + (w.remaining_minutes ?? 0), 0),
    unknown: ws.some((w) => w.remaining_minutes == null),
    scheduled: (result.value?.segments ?? []).reduce((a, s) => a + s.minutes, 0),
    unscheduled: (result.value?.unscheduled ?? []).reduce((a, u) => a + u.remaining_minutes, 0),
  }
})
// 新安排为零不提供改排采用（避免整批清空）：领域层 NO_ADOPTABLE_CHANGES 同口径，界面提前阻断。
const replanZeroNew = computed(() => isReplan.value && !!result.value && (result.value.segments ?? []).length === 0)
// 助手建议清单未核对确认（estimate_origin=model）不得使用：须在改排面板核对并保存为本次清单。
const replanUnconfirmed = computed(() => isReplan.value && (proposal.value?.work_items ?? []).some((w) => w.estimate_origin === 'model'))
const replanTaskTitle = computed(() => {
  if (!isReplan.value) return ''
  const id = draft.value.replan_scope?.task_id
  return app.docs.find((d) => d.kind === 'task' && d.id === id)?.title ?? id ?? ''
})

// 采用后导航：优先冻结写集，其次 applied_summary + 当前空间 docs（刷新后重开）。
const adoptedLinks = computed(() => {
  const env = store.prepared?.envelope
  const firstPlan = env?.write_set?.plan_items_create?.[0]
  let planId = firstPlan?.formal_id
  let planDate = firstPlan?.date
  let taskId = env?.write_set?.tasks_create?.[0]?.formal_id ?? firstPlan?.task_id
  if (!planId) {
    const entry = (draft.value?.applied_summary?.id_map ?? []).find((e) => e.object_type === 'plan_item')
    if (entry) {
      const doc = app.docs.find((d) => d.id === entry.formal_id && d.kind === 'plan_item')
      planId = entry.formal_id
      planDate = doc?.date
      taskId = doc?.task_id
    }
  }
  if (!taskId) taskId = (draft.value?.applied_summary?.id_map ?? []).find((e) => e.object_type === 'task')?.formal_id
  return {
    schedule: planId && planDate ? schedulePath({ date: planDate, plan: planId }, today.value) : '/today',
    task: isReplan.value
      ? resolveReplanReturn(route.query.return, draft.value?.replan_scope?.task_id, {
        docs: app.docs, ws: app.workspaceId, todayStr: today.value,
      })
      : taskId ? taskPath(taskId) : '/today',
  }
})

const adoptCounts = computed(() => store.prepared?.counts ?? draft.value?.applied_summary?.counts ?? null)

// R2 / 复验 F3：内容未保存 / 预算窗口未重排 分别追踪；任一为真都阻断打开与提交采用。
// 清空/纯空白同样是用户改动（不得当成「没有编辑」沿用旧值）；必填非法另列 requiredMissing。
const contentDirty = computed(() => {
  const p = proposal.value
  if (!p) return false
  for (const t of p.task_proposals ?? []) {
    if (t.op !== 'create') continue
    const e = edit.tasks[t.key]
    if (!e) continue
    const title = (e.title ?? '').trim()
    if (title !== (t.title ?? '')) return true
    if ((e.deadline || '') !== (e.initial || '')) return true
  }
  for (const a of p.action_proposals ?? []) {
    if (a.op !== 'create') continue
    const e = edit.actions[a.key]
    if (!e) continue
    const text = (e.text ?? '').trim()
    if (text !== (a.text ?? '')) return true
    if (Number(e.minutes) !== a.minutes) return true
  }
  for (const w of p.work_items ?? []) {
    const e = edit.work[w.key]
    if (!e) continue
    const cur = w.remaining_minutes == null ? '' : String(w.remaining_minutes)
    if ((e.remaining ?? '') !== cur) return true
  }
  return false
})
const requiredMissing = computed(() => {
  const p = proposal.value
  if (!p) return []
  const missing = []
  for (const t of p.task_proposals ?? []) {
    if (t.op !== 'create') continue
    const e = edit.tasks[t.key]
    if (e && !(e.title ?? '').trim()) missing.push(`任务「${t.title || t.key}」标题`)
  }
  for (const a of p.action_proposals ?? []) {
    if (a.op !== 'create') continue
    const e = edit.actions[a.key]
    if (e && !(e.text ?? '').trim()) missing.push(`行动「${a.text || a.key}」正文`)
  }
  return missing
})
const windowDirty = computed(() => {
  const input = planningInput.value
  if (!input) return false
  const start = form.startDate || today.value
  if (start !== (input.start_date || today.value)) return true
  for (let i = 0; i < 7; i += 1) {
    const date = beijingAddDays(start, i)
    const day = (input.days ?? []).find((x) => x.date === date)
    const formBudget = form.unavailable.includes(date) ? 0 : Number(form.budgets[date])
    const committed = day ? day.budget_minutes : store.formDefaults.budget
    if (formBudget !== committed) return true
  }
  return false
})
const canAdopt = computed(() => !editingGap.value && store.canAdopt && unsupported.value.length === 0 && !contentDirty.value && !windowDirty.value && requiredMissing.value.length === 0 && !replanZeroNew.value && !replanUnconfirmed.value && !store.replanPanelDirty)
// 采用框已打开时继续改改排面板：立即关闭并失效旧 prepared，提交入口再做一次 canAdopt 校验。
watch(() => store.replanPanelDirty, (dirty) => {
  if (!dirty || !adoptOpen.value) return
  adoptOpen.value = false
  store.clearPrepared()
  store.say('warning', '改排面板有未保存修改，旧方案不能采用；请先保存改排内容，再预览安排。')
})

function initWindow() {
  const d = draft.value
  if (!d) return
  // 尚未排程的草案：沿用输入区已填的起始日/预算/不可用日，避免用户重复填写同一份可用时间。
  // 改排草案起始日锁定范围 start_date（可经保存改为未来日期），不随「今天」漂移。
  const start = d.mode === 'replan'
    ? (d.planning_input?.start_date || d.replan_scope.start_date)
    : (d.planning_input?.start_date || store.input.startDate || today.value)
  form.startDate = start
  form.budgets = {}
  form.unavailable = []
  for (let i = 0; i < 7; i += 1) {
    const date = beijingAddDays(start, i)
    const day = d.planning_input?.days?.find((x) => x.date === date)
    const inputBudget = store.input.budgets[date]
    const fallback = inputBudget != null && inputBudget !== '' ? inputBudget : store.formDefaults.budget
    form.budgets[date] = String(day ? day.budget_minutes : fallback)
    if (day ? day.budget_minutes === 0 : store.input.unavailable.includes(date)) form.unavailable.push(date)
  }
  windowBaseline.value = JSON.stringify(form)
}
// reset=true 全量重建（打开草案/重排后）；reset=false 合并刷新：保留用户输入，只更新 initial 基线。
function initContent(reset = true) {
  const d = draft.value
  if (!d) return
  if (reset) {
    edit.tasks = {}
    edit.actions = {}
    edit.work = {}
  }
  for (const t of d.proposal?.task_proposals ?? []) {
    const fact = (d.planning_input?.task_facts ?? []).find((f) => f.task_ref?.kind === 'draft' && f.task_ref.key === t.key)
    const decision = t.op === 'create' ? deadlineDecision(t.key) : null
    const initial = decision?.state === 'confirmed'
      ? (decision.value ?? '')
      : (fact?.deadline_value ?? (t.deadline_candidates ?? []).find((c) => (c.precision ?? 'none') !== 'none')?.value ?? '')
    const prev = edit.tasks[t.key]
    edit.tasks[t.key] = !reset && prev
      ? { ...prev, initial: initial ?? '' }
      : { title: t.title ?? '', deadline: initial ?? '', initial: initial ?? '' }
  }
  for (const a of d.proposal?.action_proposals ?? []) {
    if (a.op !== 'create') continue
    const prev = edit.actions[a.key]
    if (!reset && prev) continue
    edit.actions[a.key] = { text: a.text, minutes: String(a.minutes) }
  }
  for (const w of d.proposal?.work_items ?? []) {
    const prev = edit.work[w.key]
    if (!reset && prev) continue
    edit.work[w.key] = { remaining: w.remaining_minutes == null ? '' : String(w.remaining_minutes) }
  }
}
// 排程窗口表单只在「打开另一草案」或「planning_input 实际变化（重排）」时重置；
// 内容保存/截止确认 bump 版本不得清掉用户尚未排程的预算输入。
// R3：保存序列进行中（saving）watch 不得覆盖待提交输入；保存成功后由合并刷新同步。
let lastInputSig = null
let saving = false
const inputSig = (d) => `${d?.planning_input?.start_date ?? ''}|${JSON.stringify(d?.planning_input?.days ?? null)}`
watch([() => draft.value?.id, () => draft.value?.revision], ([id], old) => {
  if (saving) return
  const sig = inputSig(draft.value)
  if (!old || id !== old[0] || sig !== lastInputSig) { initWindow(); lastInputSig = sig }
  initContent()
}, { flush: 'sync' })
// 带着已打开草案返回本页（store 常驻）时 watch 不触发：挂载即初始化，渲染前编辑区必须有条目。
if (draft.value) { initWindow(); lastInputSig = inputSig(draft.value); initContent() }
watch(() => form.startDate, (start) => {
  if (!start) return
  const budgets = {}
  const unavailable = []
  for (let i = 0; i < 7; i += 1) {
    const date = beijingAddDays(start, i)
    budgets[date] = String(form.budgets[date] ?? store.formDefaults.budget)
    if (form.unavailable.includes(date)) unavailable.push(date)
  }
  form.budgets = budgets
  form.unavailable = unavailable
})
watch(() => app.workspaceId, () => {
  store.reset()
  replanEntry.value = null
  replanPick.value = ''
  entryMode.value = 'create'
  extraText.value = ''
  if (app.ready && !app.isDemo) store.init()
})
// 等 app.init 配置好当前空间再读草案：刷新直达演示/恢复空间时不与 db 默认空间竞态。
watch(() => app.ready, (v) => { if (v && !app.isDemo) store.init() }, { immediate: true })

const formDates = computed(() => Array.from({ length: 7 }, (_, i) => beijingAddDays(form.startDate || today.value, i)))
const toggleUnavailable = (date) => {
  const i = form.unavailable.indexOf(date)
  if (i >= 0) form.unavailable.splice(i, 1)
  else form.unavailable.push(date)
}

async function saveChanges() {
  const p = proposal.value
  if (!p || saving) return false
  // R3：任何 await 之前冻结完整表单快照；后续步骤只读快照，watch/服务刷新不得改写待提交值。
  const frozen = {
    tasks: Object.fromEntries(Object.entries(edit.tasks).map(([k, v]) => [k, { ...v }])),
    actions: Object.fromEntries(Object.entries(edit.actions).map(([k, v]) => [k, { ...v }])),
    work: Object.fromEntries(Object.entries(edit.work).map(([k, v]) => [k, { ...v }])),
  }
  // F3：空标题/空正文是非法编辑，禁止保存（不得用旧值回退掩盖用户尚未完成的编辑）。
  for (const t of p.task_proposals ?? []) {
    if (t.op !== 'create') continue
    if (!frozen.tasks[t.key].title.trim()) { store.say('warning', `任务「${t.title || t.key}」的标题不能为空；请填写后再保存`); return false }
  }
  for (const a of p.action_proposals ?? []) {
    if (a.op !== 'create') continue
    if (!frozen.actions[a.key].text.trim()) { store.say('warning', `行动「${a.text || a.key}」的正文不能为空；请填写后再保存`); return false }
    const m = Number(frozen.actions[a.key].minutes)
    if (!Number.isInteger(m) || m <= 0) { store.say('warning', `行动「${a.text}」的估时必须是正整数分钟`); return false }
  }
  for (const w of p.work_items ?? []) {
    const v = frozen.work[w.key].remaining
    if (v !== '' && (!Number.isInteger(Number(v)) || Number(v) <= 0)) { store.say('warning', `工作项 ${w.key} 的剩余分钟必须是正整数或留空（未知）`); return false }
  }
  const next = {
    ...p,
    task_proposals: (p.task_proposals ?? []).map((t) => (t.op === 'create' ? { ...t, title: frozen.tasks[t.key].title.trim() } : t)),
    action_proposals: (p.action_proposals ?? []).map((a) => (a.op === 'create' ? { ...a, text: frozen.actions[a.key].text.trim(), minutes: Number(frozen.actions[a.key].minutes) } : a)),
    work_items: (p.work_items ?? []).map((w) => ({ ...w, remaining_minutes: frozen.work[w.key].remaining === '' ? null : Number(frozen.work[w.key].remaining) })),
  }
  saving = true
  try {
    const r = await store.editContent({ proposal: next })
    if (!r.ok) return false
    const failed = []
    for (const t of p.task_proposals ?? []) {
      if (t.op !== 'create') continue
      const e = frozen.tasks[t.key]
      const desired = e.deadline || null
      if (desired === (e.initial || null)) continue
      const dr = await store.setManualDeadline(t.key, desired)
      if (!dr?.ok) failed.push(t.title || t.key)
    }
    if (failed.length > 0) {
      // 部分失败：保留全部表单输入供重试，明确报告；不无条件重置表单假装成功。
      store.say('warning', `以下任务的截止修改未保存：${failed.join('、')}。其余内容已保存，请基于当前表单重试`)
      return false
    }
    initContent(false)
    return true
  } finally {
    saving = false
  }
}

async function reschedule() {
  const budgets = {}
  for (const date of formDates.value) {
    if (form.unavailable.includes(date)) { budgets[date] = 0; continue }
    const raw = form.budgets[date]
    const n = Number(raw)
    if (raw === '' || raw == null || !Number.isInteger(n) || n < 0 || n > 1440) {
      store.say('warning', `${date} 的每日预算必须是 0–1440 的整数分钟（不可用日请勾选「不可用」）`)
      return false
    }
    budgets[date] = n
  }
  // 改排起始日变更须先保存范围（窗口重校验）再排程；normalize 要求 scope.start_date 与窗口一致。
  if (isReplan.value) {
    const start = form.startDate || draft.value.replan_scope.start_date
    if (start !== draft.value.replan_scope.start_date) {
      const r = await store.setReplanStart(start)
      if (!r.ok) return false
    }
    return (await store.reschedule({ startDate: start, budgets, unavailable: [...form.unavailable] })).ok
  }
  return (await store.reschedule({ startDate: form.startDate || today.value, budgets, unavailable: [...form.unavailable] })).ok
}

async function openAdopt() {
  if (workflowBusy.value) return
  if (store.replanPanelDirty) { store.say('warning', '改排面板有未保存修改，旧方案不能采用；请先「保存改排内容」，再保存并预览'); return }
  if (!canAdopt.value) return
  preparing.value = true
  try {
    const r = await store.prepare()
    if (r.ok && store.prepared && canAdopt.value && r.envelope.draft_id === draft.value?.id && r.envelope.draft_revision === draft.value?.revision) {
      if (isReplan.value) adoptOpen.value = true
      else await doAdopt()
    }
  } finally { preparing.value = false }
}
async function doAdopt() {
  adoptOpen.value = false
  if (!canAdopt.value) {
    store.say('warning', store.replanPanelDirty
      ? '改排面板有未保存修改，旧方案不能采用；请先「保存改排内容」，再保存并预览'
      : requiredMissing.value.length ? '必填项为空，采用已禁用；请填写或改回原值' : '有未保存修改或预算窗口未重排，采用已禁用')
    return
  }
  await store.adopt()
}
async function saveExtra() {
  const text = extraText.value.trim()
  if (!text) return
  const r = await store.appendUserText(`补充要求（仅文本留存，不参与解析）：${text}`)
  if (r.ok) { extraText.value = ''; store.say('info', '补充要求已作为文本保存到线程；初版不解析该文本。') }
}

// 步骤只控制可见区域；事实确认、排程与采用仍由原服务判断。
const previewCurrent = computed(() => !!result.value && !store.stale && !contentDirty.value && !windowDirty.value && !store.replanPanelDirty)
const emptyPlan = computed(() => editable.value && !isReplan.value && previewCurrent.value
  && !result.value.segments.length && !gapRows.value.length && !estimateUnknown.value.length
  && readiness.value?.blockers?.some(blocker => blocker.code === 'NO_ADOPTABLE_CHANGES'))

async function reviseEmptyPlan() {
  if (!emptyPlan.value || !(await guardLeave())) return
  entryMode.value = 'create'
  replanEntry.value = null
  store.revisePlanRequest()
  await nextTick()
  document.getElementById('assistant-requirement')?.focus()
}
const workflowBusy = computed(() => advancing.value || preparing.value || store.generating || Object.values(store.busy).some(Boolean) || !!replanRef.value?.busy || !!inputRef.value?.busy)
const replanSteps = [{ key: 'input', label: '提供资料' }, { key: 'edit', label: '核对建议' }, { key: 'preview', label: '预览安排' }, { key: 'adopt', label: '确认加入' }]
const steps = computed(() => isReplan.value ? replanSteps : [
  { key: 'input', label: '提供资料' },
  { key: tab.value === 'edit' ? 'edit' : tab.value, label: applied.value ? '已加入日程' : '核对与安排' },
])
const adoptionCounts = computed(() => store.active?.adoptionReadiness?.counts)
const stepEnabled = (key) => key === 'input' ? !draft.value : !!draft.value && (key === 'edit' || (key === 'preview' ? !!result.value : canAdopt.value || applied.value))
watch(() => draft.value?.id, () => { tab.value = applied.value ? 'adopt' : slots.value.size ? 'preview' : 'edit' })
watch(canAdopt, (ok) => {
  if (ok || applied.value) return
  adoptOpen.value = false
  if (!applied.value && tab.value === 'adopt') tab.value = result.value ? 'preview' : 'edit'
})
async function saveAndPreview() {
  if (!editable.value || workflowBusy.value) return
  if (store.replanPanelDirty) { store.say('warning', '请先保存改排内容，再预览安排。'); return }
  advancing.value = true
  try {
    if (!isReplan.value && contentDirty.value && !(await saveChanges())) return
    if (!(await reschedule())) return
    store.notice = null
    tab.value = 'preview'
  } catch (err) {
    store.say('warning', `未能完成预览：${err.message || '请稍后重试'}。输入已保留。`)
  } finally { advancing.value = false }
}
const { discardOpen: leaveOpen, guardLeave, settle: settleLeave } = useUnsavedGuard(
  () => !!editingGap.value || contentDirty.value || windowDirty.value || (!!draft.value && !planningInput.value && JSON.stringify(form) !== windowBaseline.value) || !!extraText.value.trim() || !!inputRef.value?.hasUnsaved || !!replanRef.value?.hasUnsaved || !!generationRef.value?.hasUnsaved,
  () => workflowBusy.value || store.gen?.phase === 'save_failed' || draft.value?.status === 'applying',
  () => { editingGap.value = null; initContent(); initWindow(); extraText.value = ''; inputRef.value?.discard(); replanRef.value?.discard(); generationRef.value?.discard() },
)
const unregister = registerWorkLeave(guardLeave)
onBeforeUnmount(unregister)
onBeforeRouteLeave(requestWorkLeave)
onBeforeRouteUpdate(async (to, from) => {
  // 创建改排草案后的内部 URL 整理不丢输入；切换另一任务/资料才检查。
  if ((to.query.replanTask && to.query.replanTask !== from.query.replanTask) || (to.query.sources && JSON.stringify(to.query.sources) !== JSON.stringify(from.query.sources))) return guardLeave()
  return true
})
async function closeDraft() { if (await guardLeave()) store.close() }
async function chooseMode(mode) { if (entryMode.value !== mode && await guardLeave()) entryMode.value = mode }
async function openSaved(id) { if (await guardLeave()) await store.open(id) }
async function openWalkthrough() { if (await guardLeave()) await app.switchWorkspace('demo') }

// 仅对本次成功生成的新建议自动预览；恢复旧草案沿用它原有的核对状态。
let attemptedGeneration = null
watch(() => [store.gen?.phase, draft.value?.id, draft.value?.status, workflowBusy.value], async () => {
  const d = draft.value
  const g = store.gen
  if (!d || !g || g.phase !== 'done' || g.draftId !== d.id || attemptedGeneration === g ||
      workflowBusy.value || d.status !== 'needs_review' || isReplan.value || result.value) return
  attemptedGeneration = g
  if (!deadlineConfirms.value.length && !requiredMissing.value.length && !contentDirty.value) await saveAndPreview()
}, { flush: 'post' })

const threadTitle = (d) => store.threads.find((t) => t.id === d.thread_id)?.title || '未命名线程'
const outcome = computed(() => store.adoptResult?.outcome ?? null)
</script>

<template>
  <DemoWalkthrough v-if="app.isDemo" />
  <template v-else>
  <section v-if="materialHandoff" class="mb-4 space-y-3 rounded-lg border bg-card p-4" aria-label="接收所选资料">
    <template v-if="materialHandoff.ok">
      <h2 class="font-semibold">从资料库选择的 {{ materialHandoff.ids.length }} 份资料</h2>
      <ul class="space-y-1 text-sm"><li v-for="source in materialHandoff.sources" :key="source.id" class="break-words">{{ source.kind === 'image' ? source.name : (source.text || '').split('\n')[0] }}</li></ul>
      <p class="text-xs text-muted-foreground">确认后打开新计划输入，仅选定以上资料；点击生成前不会发送。</p>
      <div class="flex gap-2"><Button :disabled="handoffBusy" @click="materialConfirm = true">使用所选资料</Button><Button variant="ghost" @click="dismissMaterials">取消交接</Button></div>
      <p v-if="handoffBusy" class="text-xs text-muted-foreground">请先处理当前生成、保存或采用结果。</p>
    </template>
    <template v-else><p role="alert" class="text-sm">{{ materialHandoff.message }}</p><Button size="sm" variant="outline" @click="dismissMaterials">关闭提示</Button></template>
  </section>
  <ConfirmDialog v-model="materialConfirm" title="用所选资料开始新计划？" confirm-label="替换输入并继续" cancel-label="保留当前输入" :confirm-disabled="handoffBusy || !materialHandoff?.ok" @confirm="acceptMaterials">当前未提交的输入将被替换；已保存草案保留。所选资料尚不会发送给模型。</ConfirmDialog>
  <div class="mx-auto space-y-4" :class="draft && tab === 'preview' ? 'max-w-4xl' : 'max-w-3xl'">
    <header ref="workflowHeader" class="scroll-mt-20 space-y-4">
      <h1 class="text-2xl font-semibold">规划助手</h1>
      <nav aria-label="规划步骤" class="grid grid-cols-4 border-b">
        <button v-for="(step, i) in steps" :key="step.key" type="button" :disabled="!stepEnabled(step.key) || workflowBusy" :aria-current="(!draft ? step.key === 'input' : tab === step.key) ? 'step' : undefined" class="min-w-0 border-b-2 px-1 py-3 text-sm transition-colors disabled:cursor-default" :class="(!draft ? step.key === 'input' : tab === step.key) ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground enabled:hover:text-foreground disabled:opacity-45'" @click="tab = step.key"><span class="block text-xs sm:inline">{{ i + 1 }}</span> {{ step.label }}</button>
      </nav>
    </header>
    <Alert v-if="app.aiDown" variant="warning">模型服务当前不可用：生成会失败并保留输入；本地手动编辑与排程照常。</Alert>
    <Alert v-if="store.notice" :variant="store.notice.tone === 'info' ? 'info' : 'warning'">{{ store.notice.text.replaceAll('「重新排程」', '「保存并预览」') }}</Alert>

    <!-- 入口：真实输入（当前空间）/ 显式载入演示 / 继续已有草案；绝不自动播种 -->
    <section v-if="!draft" class="space-y-4">
      <template v-if="replanEntry">
        <ReplanPanel ref="replanRef" :task-id="replanEntry" @started="onReplanStarted" />
        <Button variant="ghost" size="sm" @click="async () => { if (await guardLeave()) cancelReplanEntry() }">← 返回新建计划</Button>
      </template>
      <template v-else>
        <div class="flex gap-2" aria-label="规划类型">
          <Button :variant="entryMode === 'create' ? 'default' : 'outline'" :disabled="workflowBusy" @click="chooseMode('create')">制定新计划</Button>
          <Button :variant="entryMode === 'replan' ? 'default' : 'outline'" :disabled="workflowBusy" @click="chooseMode('replan')">调整已有计划</Button>
        </div>
        <PlanInput v-show="entryMode === 'create'" ref="inputRef" :key="app.workspaceId + materialInputRevision" />
        <div v-if="entryMode === 'replan'" class="py-4">
          <h2 class="text-base font-semibold">选择要调整的任务</h2>
          <p class="mt-1 text-sm text-muted-foreground">调整后续安排，保留任务总截止。</p>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <select v-model="replanPick" class="h-9 rounded-md border bg-background px-2 text-sm" aria-label="选择要调整的任务">
              <option value="" disabled>选择任务…</option>
              <option v-for="t in openTasks" :key="t.id" :value="t.id">{{ t.title }}</option>
            </select>
            <Button variant="secondary" :disabled="!replanPick || store.busy.loading" @click="replanEntry = replanPick">选择任务并调整</Button>
          </div>
          <p v-if="!openTasks.length" class="mt-2 text-xs text-muted-foreground">当前空间没有未完成的任务。</p>
        </div>
        <Button variant="ghost" size="sm" @click="openWalkthrough">去演示空间看操作示例</Button>
        <details class="border-t pt-4">
          <summary class="cursor-pointer text-sm font-medium">继续已有草案（{{ store.drafts.length }}）</summary>
          <p v-if="!store.drafts.length" class="mt-2 text-sm text-muted-foreground">当前空间还没有草案。</p>
          <ul v-else class="mt-2 divide-y">
            <li v-for="d in store.drafts" :key="d.id">
              <button type="button" class="flex w-full items-center gap-2 py-2 text-left text-sm hover:bg-accent" @click="openSaved(d.id)">
                <span class="min-w-0 flex-1 truncate">{{ threadTitle(d) }} · 第 {{ d.revision }} 版</span>
                <Badge v-if="d.mode === 'replan'" variant="outline">改排</Badge>
                <Badge :variant="statusVariant(d.status)">{{ STATUS_LABELS[d.status] ?? d.status }}</Badge>
                <span class="text-xs text-muted-foreground">{{ beijingInstantLabel(d.updated_at) }}</span>
              </button>
            </li>
          </ul>
        </details>
      </template>
    </section>

    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" @click="closeDraft">← 返回列表</Button>
        <h2 class="text-base font-semibold">{{ threadTitle(draft) }} · 第 {{ draft.revision }} 版</h2>
        <Badge v-if="isReplan" variant="outline">改排</Badge>
        <Badge :variant="statusVariant(draft.status)">{{ draft.status === 'ready' && !canAdopt ? '待核对' : STATUS_LABELS[draft.status] ?? draft.status }}</Badge>
        <span class="flex-1" />
        <Button v-if="editable && draft.status !== 'discarded'" variant="outline" size="sm" @click="discardOpen = true">放弃草案</Button>
        <Button v-if="applied || draft.status === 'discarded'" variant="secondary" size="sm" @click="store.forkDraft()">新建草案（复制内容）</Button>
      </div>

      <Alert v-if="applied" variant="success">
        <template v-if="isReplan">
          已采用：取消 {{ draft.applied_summary?.counts?.plan_items_cancelled ?? 0 }} 条旧安排，新增 {{ draft.applied_summary?.counts?.actions_created ?? 0 }} 个行动、{{ draft.applied_summary?.counts?.plan_items_created ?? 0 }} 条安排。草案只读；再调整请「新建草案」。
        </template>
        <template v-else>
          已采用：新增 {{ draft.applied_summary?.counts?.tasks_created ?? 0 }} 个任务、{{ draft.applied_summary?.counts?.actions_created ?? 0 }} 个行动、{{ draft.applied_summary?.counts?.plan_items_created ?? 0 }} 条安排。草案只读；新意图请「新建草案」。
        </template>
        <div class="mt-2 flex gap-2">
          <Button size="sm" @click="router.push(adoptedLinks.schedule)">查看日程</Button>
          <Button size="sm" variant="secondary" @click="router.push(adoptedLinks.task)">查看任务</Button>
        </div>
      </Alert>
      <Alert v-if="draft.status === 'result_unknown'" variant="warning">
        上次采用结果待核实（可能刷新/中断导致）。只查原意图台账，不会重复写入。
        <Button size="sm" class="ml-2" @click="store.resolveResult()">核实结果</Button>
      </Alert>
      <Alert v-if="draft.status === 'applying'" variant="warning">采用正在进行；编辑/确认/放弃已锁定。刷新页面将自动结算结果。</Alert>
      <Alert v-if="unsupported.length" variant="destructive">
        含初版不支持的操作：{{ unsupported.join('、') }}。采用已阻断；请改为新建任务/行动，或放弃该修改。
      </Alert>
      <Alert v-if="store.stale" variant="warning">更改尚未重新排程：预览仍是旧计算，采用已禁用。请返回核对建议，保存并预览。</Alert>
      <Alert v-if="store.replanPanelDirty" variant="warning">改排面板有未保存修改：旧方案不能采用。请先「保存改排内容」，再保存并预览。</Alert>
      <Alert v-else-if="!store.stale && (contentDirty || windowDirty)" variant="warning">有未保存修改或预算窗口未重排，采用已禁用。请返回核对建议，保存并预览。</Alert>
      <Alert v-if="editable && requiredMissing.length" variant="destructive">必填项为空：{{ requiredMissing.join('、') }}。标题/行动正文不能为空，保存与采用已禁用；请填写或改回原值。</Alert>

      <!-- 本轮真实生成状态（澄清/失败/留存结果）：完成后进入下方核对与预览 -->
      <GenerationPanel v-if="store.gen && store.gen.draftId === draft.id && store.gen.phase !== 'done'" ref="generationRef" />

      <!-- 采用结果 -->
      <Alert v-if="outcome === 'needs_recheck'" variant="warning">
        需重新核对：空间事实或证据在采用前发生变化，本次确定未提交。
        <ul class="mt-1 list-disc pl-5 text-xs">
          <li v-for="(d, i) in store.adoptResult.diffs ?? []" :key="i">{{ d.code }}：{{ d.message }}</li>
        </ul>
      </Alert>
      <Alert v-else-if="outcome === 'not_committed'" variant="warning">确定未提交：{{ store.adoptResult.message }}</Alert>

      <div class="space-y-4">
        <section v-show="tab === 'edit'" class="space-y-5" aria-label="核对建议">
          <fieldset :disabled="workflowBusy" class="min-w-0 space-y-5">
          <details><summary class="cursor-pointer text-sm">查看资料原文</summary><SourceReview :draft="draft" /></details>
          <!-- 改排草案：范围/清单由改排面板编辑（建议随清单重建），不走通用任务/行动编辑。 -->
          <ReplanPanel v-if="isReplan" ref="replanRef" :draft="draft" />
          <div v-if="!isReplan" class="rounded-lg border bg-card p-4">
            <h3 class="flex items-center gap-2 text-sm font-semibold"><ListChecks class="size-4" />任务与行动</h3>
            <p v-if="!proposal" class="mt-2 text-sm text-muted-foreground">无建议内容。</p>
            <div v-for="t in createTasks" :key="t.key" class="mt-3 space-y-2 rounded-md border p-3">
              <div class="text-xs text-muted-foreground">任务</div>
              <Input v-model="edit.tasks[t.key].title" :disabled="!editable" aria-label="任务标题" />
              <div class="flex items-center gap-2">
                <DateInput v-model="edit.tasks[t.key].deadline" :disabled="!editable" placeholder="无截止" class="flex-1" :aria-label="`任务 ${t.title} 截止`" />
                <Button variant="ghost" size="sm" :disabled="!editable" @click="edit.tasks[t.key].deadline = ''">无截止</Button>
              </div>
              <div v-if="(t.deadline_candidates ?? []).length" class="text-xs text-muted-foreground">
                模型候选：{{ t.deadline_candidates.map((c) => c.value ?? '无').join('、') }}（可修改）
              </div>
            </div>
            <div v-for="t in linkTasks" :key="t.key" class="mt-3 rounded-md border p-3 text-sm">
              <div class="text-xs text-muted-foreground">关联既有任务（不改对象）</div>
              <div>{{ taskTitle({ kind: 'existing', id: t.target_id }) }}</div>
              <div class="text-xs text-muted-foreground">沿用原任务截止。</div>
            </div>
            <div v-for="a in proposal?.action_proposals ?? []" :key="a.key" class="mt-3 space-y-1 rounded-md border p-3">
              <template v-if="a.op === 'create'">
                <div class="text-xs text-muted-foreground">行动 · {{ taskTitle(a.task_ref) }}</div>
                <Input v-model="edit.actions[a.key].text" :disabled="!editable" aria-label="行动内容" />
                <label class="flex items-center gap-2 text-xs text-muted-foreground">估时（分钟）
                  <Input v-model="edit.actions[a.key].minutes" :disabled="!editable" class="h-8 w-24" inputmode="numeric" />
                </label>
              </template>
              <template v-else>
                <div class="text-xs text-muted-foreground">复用既有行动（不改对象）</div>
                <div class="text-sm">{{ a.target_id }}</div>
              </template>
            </div>
            <div v-for="w in proposal?.work_items ?? []" :key="w.key" class="mt-3 space-y-1 rounded-md border p-3">
              <div class="text-xs text-muted-foreground">待安排工作 · {{ w.deliverable }}</div>
              <label class="flex items-center gap-2 text-xs text-muted-foreground">剩余分钟（留空=未知）
                <Input v-model="edit.work[w.key].remaining" :disabled="!editable" class="h-8 w-24" inputmode="numeric" />
              </label>
            </div>

          </div>

          <details class="border-y py-4" :open="store.inputRestore === 'missing' && !draft.planning_input">
            <summary class="cursor-pointer text-sm font-semibold">可用时间 · {{ form.startDate }} 起七天 <span class="font-normal text-muted-foreground">编辑</span></summary>
            <p v-if="store.inputRestore === 'missing' && !draft.planning_input" class="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">未找到该草案已保存的可用时间输入；当前为默认预算（非已恢复的用户设置），请补填后再排程。</p>
            <label class="mt-2 block text-xs text-muted-foreground">起始日期（北京时间）</label>
            <DateInput v-model="form.startDate" :disabled="!editable" aria-label="排程起始日期" />
            <div class="mt-2 space-y-1">
              <div v-for="date in formDates" :key="date" class="flex flex-wrap items-center gap-2 text-sm">
                <span class="w-28 shrink-0 text-xs text-muted-foreground">{{ date }}</span>
                <Input v-model="form.budgets[date]" :disabled="!editable || form.unavailable.includes(date)" class="h-8 w-24" inputmode="numeric" :aria-label="`${date} 预算分钟`" />
                <span class="text-xs text-muted-foreground">分钟</span>
                <label class="ml-auto flex items-center gap-1 text-xs">
                  <input type="checkbox" :checked="form.unavailable.includes(date)" :disabled="!editable" @change="toggleUnavailable(date)" />不可用
                </label>
              </div>
            </div>
          </details>

          <div class="rounded-lg border bg-card p-4">
            <button type="button" class="flex w-full items-center gap-2 text-sm font-semibold" @click="showExtra = !showExtra">
              <ChevronDown v-if="showExtra" class="size-4" /><ChevronRight v-else class="size-4" />备注（不参与安排）
            </button>
            <div v-if="showExtra" class="mt-2 space-y-2">
              <p class="text-xs text-muted-foreground">备注仅留存，不改变安排；可用时间请在上方修改。</p>
              <Textarea v-model="extraText" :disabled="!editable" placeholder="例如：周五下午有组会（仅记录，不会自动扣减容量）" />
              <Button size="sm" variant="secondary" :disabled="!editable || !extraText.trim()" @click="saveExtra">保存为文本</Button>
            </div>
          </div>
          </fieldset>
        </section>

          <div v-show="(tab === 'edit' || tab === 'preview') && (replanScopeConf || deadlineConfirms.length || extraWorkPreConfirms.length || (tab === 'edit' && otherBlockers.length))" class="space-y-2" aria-label="排程前核对">
            <h3 class="text-sm font-semibold">核对与确认</h3>
            <!-- M3 替换范围确认：取消所选旧安排 + 清单不含保留安排覆盖的工作；版本 bump 后须重新确认 -->
            <div v-if="replanScopeConf" class="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm">
              <div>确认替换范围：将取消所选 {{ replanScopeConf.replacement_ids.length }} 条旧安排（{{ replanTaskTitle }}）；本次清单不包含保留安排继续覆盖的工作。总截止不变。</div>
              <Button size="sm" variant="secondary" class="mt-1" :disabled="!editable || store.replanPanelDirty || workflowBusy" @click="store.confirmReplanScope()">确认替换范围</Button>
            </div>
            <!-- 额外工作（D12）阻断排程：须在排程前确认，不依赖排程结果。确认后请再次「重新排程」。 -->
            <div v-for="k in extraWorkPreConfirms" :key="'pre-' + k" class="mt-2 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm">
              <span class="flex-1">{{ workTitle(k) }}：既有任务在窗口已有安排，须先确认本次为额外尚未安排工作，再保存并预览</span>
              <Button size="sm" variant="secondary" :disabled="!editable || contentDirty || store.replanPanelDirty || workflowBusy" @click="store.confirmExtraWork(k)">确认额外工作</Button>
            </div>
            <!-- 截止确认不依赖排程结果：normalize 要求先确认截止候选，首次排程前也必须可确认 -->
            <div v-for="x in deadlineConfirms" :key="x.task.key" class="mt-2 rounded-md border p-2 text-sm">
              <div>任务「{{ x.task.title }}」什么时候截止？</div>
              <p v-if="x.task.deadline_candidates.some(c => c.value && !verifiedCandidate(x.task, c))" class="text-xs text-muted-foreground">建议日期缺少已核对的出处。可亲自指定日期，或修改上方日期后保存。</p>
              <div class="mt-1 flex flex-wrap gap-1">
                <Button v-for="c in x.task.deadline_candidates.filter((c) => (c.precision ?? 'none') !== 'none')" :key="c.value" size="sm" variant="secondary" :disabled="!editable || contentDirty || workflowBusy" @click="chooseDeadline(x.task, c)">
                  {{ verifiedCandidate(x.task, c) ? "确认" : "我指定为" }} {{ c.value }}
                </Button>
                <Button size="sm" variant="outline" :disabled="!editable || contentDirty || workflowBusy" @click="chooseDeadline(x.task, null)">明确无截止</Button>
              </div>
            </div>
            <ul v-if="otherBlockers.length && tab === 'edit'" class="list-disc pl-5 text-sm"><li v-for="(b, i) in otherBlockers" :key="i">{{ b.message }}</li></ul>
          </div>
          <div v-show="tab === 'edit'" class="flex justify-end border-t pt-4"><Button :disabled="!editable || workflowBusy || requiredMissing.length > 0 || store.replanPanelDirty" @click="saveAndPreview">{{ advancing ? '正在准备预览…' : '保存并预览' }}</Button></div>

        <!-- 预览区 -->
        <section v-show="tab === 'preview'" class="space-y-4" aria-label="预览安排">
          <div v-if="emptyPlan" class="space-y-3 border-y py-5">
            <h3 class="text-xl font-semibold">本次没有新增安排</h3>
            <p class="text-sm text-muted-foreground">草案已保留。可以补充要做的事和期望日期，再生成方案。</p>
            <ul v-if="result.excluded_items?.length" class="list-disc pl-5 text-sm">
              <li v-for="item in result.excluded_items" :key="item.work_item_key">{{ workTitle(item.work_item_key) }} · {{ item.reason }}</li>
            </ul>
            <div class="flex flex-wrap gap-2">
              <Button :disabled="workflowBusy" @click="reviseEmptyPlan">调整要求</Button>
              <Button variant="outline" :disabled="workflowBusy" @click="router.push('/today')">查看日程</Button>
            </div>
          </div>
          <template v-else>
          <Alert v-if="replanZeroNew" variant="warning">本次还没有新安排。可以为下方未排工作选择时间，也可以返回调整工作量。</Alert>
          <Alert v-if="!previewCurrent" variant="warning">这是上一次预览，请返回核对建议更新后再采用。</Alert>
          <div v-if="estimateUnknown.length || overbookConfirms.length || extraWorkConfirms.length || previewBlockers.length || !result" class="space-y-2 border-b pb-4">
            <h3 class="text-sm font-semibold">安排核对</h3>
            <p v-if="!result" class="mt-2 text-sm text-muted-foreground">尚未排程：返回核对建议，点击「保存并预览」。</p>
            <template v-else>
              <div v-if="estimateUnknown.length" class="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                估时未知（请在编辑区填写剩余分钟）：{{ estimateUnknown.map((u) => workTitle(u.work_item_key)).join('、') }}
              </div>
              <div v-for="d in overbookConfirms" :key="d.date" class="mt-2 flex items-center gap-2 rounded-md border p-2 text-sm">
                <span class="flex-1">{{ d.date }} 既有安排已超预算 {{ d.overbooked_minutes }} 分钟（不新增安排）</span>
                <Button size="sm" variant="secondary" :disabled="!editable" @click="store.confirmOverbook(d.date)">确认过载</Button>
              </div>
              <div v-for="k in extraWorkConfirms" :key="k" class="mt-2 flex items-center gap-2 rounded-md border p-2 text-sm">
                <span class="flex-1">{{ workTitle(k) }}：既有任务在窗口已有安排，须确认本次为额外尚未安排工作</span>
                <Button size="sm" variant="secondary" :disabled="!editable || contentDirty || store.replanPanelDirty || workflowBusy" @click="store.confirmExtraWork(k)">确认额外工作</Button>
              </div>
              <ul v-if="previewBlockers.length" class="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                <li v-for="(b, i) in previewBlockers" :key="i">{{ b.message }}</li>
              </ul>
            </template>
          </div>

          <div class="py-2">
            <h3 class="text-xl font-semibold">每日安排</h3>
            <p v-if="result" class="mt-1 text-sm text-muted-foreground">{{ Object.keys(segmentsByDate).length }} 天 · {{ result.segments.length }} 项工作 · 预计 {{ result.segments.reduce((sum, segment) => sum + segment.minutes, 0) }} 分钟</p>
            <p v-if="!result" class="mt-2 text-sm text-muted-foreground">排程后这里显示每日安排与容量。</p>
            <div v-else class="mt-2 space-y-3">
              <p v-for="entry in confirmedDeadlines" :key="entry.key" class="break-words text-sm text-primary">{{ entry.title }} · 截止 {{ entry.label }}</p>
              <PlanAgenda :result="result" :segments-by-date="segmentsByDate" :task-title="taskTitle" preview />
              <div v-if="gapRows.length && editable" class="rounded-md border p-3">
                <h4 class="text-sm font-semibold">自行安排 <span class="text-muted-foreground">· {{ result.unscheduled.length }} 项未排</span></h4>
                <ManualGapRow v-for="u in gapRows" :key="u.work_item_key" :gap="u" :title="workTitle(u.work_item_key)"
                  :reason="REASON_LABELS[u.reason] ?? u.reason" :days="result.days" :slot="slots.get(u.work_item_key)"
                  :acknowledged="hasConf('gap', u.work_item_key)" :disabled="workflowBusy || !previewCurrent || (!!editingGap && editingGap !== u.work_item_key)"
                  :editing="editingGap === u.work_item_key" @edit="editingGap = u.work_item_key" @close="editingGap = null" />
              </div>
              <ul v-if="result.warnings?.length" class="list-disc pl-5 text-xs text-muted-foreground">
                <li v-for="(w, i) in result.warnings" :key="i">{{ w.message }}</li>
              </ul>
            </div>
          </div>

          <!-- M3 改排三块预览：保留 / 将取消 / 将新增；打开与关闭预览都不修改正式日程 -->
          <div v-if="replanView" class="rounded-lg border bg-card p-4">
            <h3 class="text-sm font-semibold">改排预览：保留 / 将取消 / 将新增</h3>
            <p class="mt-1 text-xs text-muted-foreground">
              待安排总量 {{ replanTotals.total }} 分钟<span v-if="replanTotals.unknown">（含未知估时项）</span> · 已排入 {{ replanTotals.scheduled }} · 未排入 {{ replanTotals.unscheduled }}。总截止不变；未排入须单独确认缺口。
            </p>
            <div class="mt-2 grid gap-2 md:grid-cols-3">
              <div class="rounded-md border p-2">
                <div class="text-xs font-medium">保留（{{ replanView.keptCount }}）</div>
                <ul class="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  <li v-for="p in replanView.kept" :key="p.id">{{ p.date }} · {{ p.action_text }} · {{ p.planned_minutes }} 分钟</li>
                  <li v-if="!replanView.kept.length">无</li>
                </ul>
              </div>
              <div class="rounded-md border border-amber-300 bg-amber-50 p-2">
                <div class="text-xs font-medium">将取消（{{ replanView.replacedCount }}）</div>
                <ul class="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  <li v-for="p in replanView.cancel" :key="p.plan_item_id">{{ p.date }} · {{ p.action_text }} · {{ p.planned_minutes }} 分钟</li>
                  <li v-if="!replanView.cancel.length">无</li>
                </ul>
              </div>
              <div class="rounded-md border border-emerald-300 bg-emerald-50 p-2">
                <div class="text-xs font-medium">将新增（{{ replanView.create.length }}）</div>
                <ul class="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  <li v-for="s in replanView.create" :key="s.segment_key">{{ s.date }} · {{ s.action_text }} · {{ s.minutes }} 分钟</li>
                  <li v-if="!replanView.create.length">无</li>
                </ul>
              </div>
            </div>
          </div>

          <p v-if="!isReplan && canAdopt && adoptionCounts" class="text-sm text-muted-foreground">将新增 {{ adoptionCounts.tasks_created }} 个任务、{{ adoptionCounts.actions_created }} 个行动。</p>
          <div class="flex flex-wrap justify-between gap-2 border-t pt-4"><Button variant="outline" @click="tab = 'edit'">修改任务与时间</Button><Button v-if="isReplan" :disabled="!canAdopt" @click="tab = 'adopt'">下一步：确认加入</Button><Button v-else-if="!applied" :disabled="!canAdopt || workflowBusy" @click="openAdopt">将计划加入日程（{{ adoptionCounts?.plan_items_created ?? result?.segments?.length ?? 0 }} 项安排）</Button></div>
          <p v-if="!canAdopt" class="text-sm text-muted-foreground">请处理上方待确认项；修改任务或时间请返回核对建议。</p>
          </template>
        </section>
        <section v-show="tab === 'adopt' && !applied" class="space-y-4" aria-label="确认加入">
          <div class="rounded-lg border bg-card p-4">
            <h3 class="text-base font-semibold">将建议加入日程</h3>
            <p class="mt-1 text-xs text-muted-foreground">确认后保存任务、行动和每日安排。</p>
            <p class="mt-3 text-sm">{{ result?.segments?.length ?? 0 }} 条新安排<span v-if="isReplan">，替换 {{ replanView?.replacedCount ?? 0 }} 条旧安排</span><span v-if="result?.unscheduled?.length">，{{ result.unscheduled.length }} 项工作仍未排入</span>。</p>
            <PlanAgenda v-if="result" class="mt-3" :result="result" :segments-by-date="segmentsByDate" :task-title="taskTitle" />
            <div v-if="confirmedDeadlines.length" class="border-b py-3">
              <h4 class="text-sm font-semibold">任务截止</h4>
              <p v-for="entry in confirmedDeadlines" :key="entry.key" class="mt-1 break-words text-sm">{{ entry.title }} · {{ entry.label }}</p>
            </div>
            <div v-if="replanView?.cancel.length" class="border-b py-3">
              <h4 class="text-sm font-semibold text-destructive">将替换的旧安排</h4>
              <p v-for="item in replanView.cancel" :key="item.plan_item_id" class="mt-1 break-words text-sm">{{ item.date }} · {{ item.action_text }} · {{ item.planned_minutes }} 分钟</p>
            </div>
            <div v-if="result?.unscheduled?.length" class="border-b py-3">
              <h4 class="text-sm font-semibold">仍未排入</h4>
              <p v-for="item in result.unscheduled" :key="item.work_item_key" class="mt-1 text-sm">{{ workTitle(item.work_item_key) }} · {{ item.remaining_minutes }} 分钟</p>
            </div>
            <Button variant="outline" class="mr-2 mt-3" @click="tab = 'preview'">返回预览安排</Button>
            <Button class="mt-2" :disabled="!canAdopt || workflowBusy" @click="openAdopt">采用计划</Button>
            <p v-if="replanZeroNew" class="mt-1 text-xs text-amber-700">新安排为零：不提供改排采用（避免整批清空）。请修改清单/预算后重新排程，或使用既有单项取消操作。</p>
            <p v-if="store.replanPanelDirty" class="mt-1 text-xs text-amber-700">改排面板有未保存修改：请先「保存改排内容」，再保存并预览，旧方案不能采用。</p>
            <p v-else-if="replanUnconfirmed" class="mt-1 text-xs text-amber-700">助手建议清单尚未核对确认：请在改排面板核对各项分钟数与总量，载入并「保存改排内容」后再排程采用。</p>
            <p v-else-if="!canAdopt && draft.status === 'ready' && (store.stale || contentDirty || windowDirty || requiredMissing.length)" class="mt-1 text-xs text-amber-700">{{ store.stale ? '更改尚未重新排程。' : requiredMissing.length ? '必填项为空，请填写或改回原值。' : '有未保存修改或预算窗口未重排。' }}</p>
          </div>
        </section>
      </div>
    </template>

    <ConfirmDialog v-model="adoptOpen" tone="primary" title="确认采用计划" :confirm-label="isReplan ? `确认替换 ${adoptCounts?.plan_items_cancelled ?? 0} 条旧安排，新增 ${adoptCounts?.plan_items_created ?? 0} 条安排` : '采用'" @confirm="doAdopt">
      <template v-if="adoptCounts">
        <template v-if="isReplan">
          将取消 {{ adoptCounts.plan_items_cancelled }} 条旧安排（已经你确认替换），新增 {{ adoptCounts.actions_created }} 个行动、{{ adoptCounts.plan_items_created }} 条安排。总截止不变；未选安排继续保留、占用容量。
        </template>
        <template v-else>
          将新增 {{ adoptCounts.tasks_created }} 个任务、{{ adoptCounts.actions_created }} 个行动、{{ adoptCounts.plan_items_created }} 条安排。
        </template>
        <span v-if="store.prepared?.envelope?.planned_gaps?.length">仍有 {{ store.prepared.envelope.planned_gaps.length }} 项未排工作（已单独确认）。</span>
        <span v-if="store.prepared?.envelope?.existing_overbook_dates?.length">已确认超预算日期 {{ store.prepared.envelope.existing_overbook_dates.join('、') }}。</span>
        采用后草案只读。保存失败整体回滚，不会出现旧安排取消了、新安排没保存的情况。
      </template>
    </ConfirmDialog>
    <ConfirmDialog v-model="leaveOpen" title="放弃未保存的修改？" confirm-label="放弃修改并继续" cancel-label="继续编辑" @confirm="settleLeave(true)">已保存草案保留；当前未保存的输入将丢失。</ConfirmDialog>
    <ConfirmDialog v-model="discardOpen" title="放弃草案" confirm-label="放弃" @confirm="store.discardDraft(); discardOpen = false">
      放弃后草案只读，可「新建草案」复制内容重来。不会删除任何已采用的正式对象。
    </ConfirmDialog>
  </div>
  </template>
</template>
