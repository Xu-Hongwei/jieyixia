<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import { useAppStore } from '@/stores/app'
import { usePlanStore } from '@/stores/plan'
import { beijingAddDays, beijingToday, isValidDate } from '@/domains/time'
import { dayPlansForTask, planEditBlock, planSnapshot } from '@/domains/plan'
import { PLAN_STATE_LABELS, STATUS_LABELS, label, planStaleRows } from '@/domains/labels'
import { slotDeadlineLabel } from '@/domains/week'

// 共享安排编辑器（5A-1 §5/§7）：create/edit/move/another 四模式同一提交逻辑。
// 信封只在用户意图产生时签发一次；同输入同失败重试复用原信封；改字段/新确认事实=新意图。
// 草稿只在本组件内；空间切换即关闭，晚到结果按归属忽略，绝不串空间/串任务。
const props = defineProps({
  mode: { type: String, required: true }, // create | edit | move | another
  planId: { type: String, default: '' },
  taskId: { type: String, default: '' },
  date: { type: String, default: '' },
  lockTask: { type: Boolean, default: false },
  showClose: { type: Boolean, default: true },
  inlineCreate: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'saved', 'goto-create-task', 'edit'])
const store = useAppStore()
const planStore = usePlanStore()
const wsAtOpen = store.workspaceId

const OP_OF = { create: 'create', edit: 'edit', move: 'move', another: 'arrangeAnotherDay' }
const TITLES = { create: '安排工作', edit: '编辑安排', move: '安排改期', another: '另安排一天' }
const SUBMIT_LABELS = { create: '创建安排', edit: '保存修改', move: '确认改期', another: '创建新安排' }

const plan = computed(() => (props.planId ? store.docs.find((d) => d.kind === 'plan_item' && d.id === props.planId) || null : null))
// 锁定任务（任务详情/清单固定入口）：构造命令只用锁定 ID，不依赖可变草稿；全局入口仍可搜索选择。
const taskLocked = props.mode === 'create' && props.lockTask && !!props.taskId
const fixedTask = computed(() => {
  const id = props.mode === 'create' ? (taskLocked ? props.taskId : dTask.value) : plan.value && plan.value.task_id
  return id ? store.tasks.find((t) => t.id === id) || null : null
})

// 初值在打开时固定一次：跨午夜不改已编辑日期；新表单重新读今天由父级重新挂载保证。
const dTask = ref(props.mode === 'create' ? props.taskId : '')
const dDate = ref(
  props.mode === 'create'
    ? props.date || beijingToday()
    : props.mode === 'another' && plan.value
      ? [beijingAddDays(plan.value.date, 1), beijingToday()].sort().pop()
      : plan.value
        ? plan.value.date
        : beijingToday(),
)
const dText = ref(props.mode === 'create' ? '' : plan.value ? plan.value.action_text : '')
const dMinutes = ref(props.mode === 'create' ? '30' : plan.value ? String(plan.value.planned_minutes) : '30')
const initialSnapshot = JSON.stringify([dTask.value, dDate.value, dText.value, dMinutes.value])
const dirty = computed(() => {
  if (props.mode === 'create' && !dText.value.trim() && dMinutes.value === '30') return false
  return JSON.stringify([dTask.value, dDate.value, dText.value, dMinutes.value]) !== initialSnapshot
})

const saving = ref(false)
const saveState = ref('unsaved') // unsaved | saving | saved | error | verify
const errorMsg = ref('')
const intent = ref(null) // { op, sig, envelope:{requestId,issuedAtMs,planItemId}, input }
const dayPlans = computed(() => props.mode === 'create' ? dayPlansForTask(store.docs, wsAtOpen, dTask.value, dDate.value) : [])
const dayPlanIds = computed(() => dayPlans.value.map(p => p.id).sort())
const dayPlanRows = computed(() => dayPlans.value.map(item => ({ item, block: planEditBlock(store.docs, item) })))
const additionalConfirmed = ref(false)
watch([dTask, dDate, () => JSON.stringify(dayPlanIds.value)], () => { additionalConfirmed.value = false }, { flush: 'sync' })
const showFields = computed(() => props.mode !== 'create' || (!!fixedTask.value && (
  !dayPlans.value.length || additionalConfirmed.value || saveState.value === 'verify'
)))
const confirmed = ref(/** @type {Record<string, any>} */ ({})) // 用户明确确认过的事实：deadlineConfirm / confirmedDuplicateIds
// 编辑/改期基线在打开时冻结为用户所见的完整快照：草稿与该基线绑定，正常提交与原信封重试始终沿用；
// store 刷新不得自动换 expected（否则旧草稿会无提示覆盖新事实）。仅 STALE 差异展示并明确确认后才换最新基线。
const frozenExpected = ref(props.mode !== 'create' && plan.value ? planSnapshot(plan.value) : null)

const minutesNum = computed(() => (/^\d+$/.test(dMinutes.value.trim()) ? Number(dMinutes.value.trim()) : NaN))

function localValidate() {
  if (props.mode === 'create' && !dTask.value) return '先选择要安排的任务'
  if (props.mode !== 'create' && !plan.value) return '安排已不存在或不属于当前空间，无法提交'
  if (!isValidDate(dDate.value)) return '安排日期必须是真实日期（清空不等于今天）'
  if (!dText.value.trim()) return '工作说明不能为空'
  if (!Number.isSafeInteger(minutesNum.value) || minutesNum.value <= 0) return '预计分钟必须是正整数，不能为 0、小数或负数'
  if (props.mode === 'edit' && frozenExpected.value && dText.value.trim() === frozenExpected.value.action_text && minutesNum.value === frozenExpected.value.planned_minutes) {
    return '编辑需要修改工作说明或预计分钟'
  }
  return null
}

function baseInput() {
  if (props.mode === 'create') return { taskId: taskLocked ? props.taskId : dTask.value, date: dDate.value, actionText: dText.value.trim(), plannedMinutes: minutesNum.value, expectedDayPlanIds: dayPlanIds.value }
  if (props.mode === 'another') return { taskId: plan.value.task_id, date: dDate.value, actionText: dText.value.trim(), plannedMinutes: minutesNum.value }
  if (props.mode === 'edit') return { planItemId: props.planId, expected: frozenExpected.value, actionText: dText.value.trim(), plannedMinutes: minutesNum.value }
  return { planItemId: props.planId, expected: frozenExpected.value, date: dDate.value }
}

// —— 待核实暂存（工作区隔离 sessionStorage；仅核实/重试凭据，不是业务记录、不进备份）——
const stashKey = `jieplan.pending.${wsAtOpen}`
function stash() {
  if (!intent.value) return
  try {
    sessionStorage.setItem(stashKey, JSON.stringify({ mode: props.mode, planId: props.planId, ...intent.value, at: Date.now() }))
  } catch {
    errorMsg.value = '浏览器存储不可用：待核实凭据仅保留在本页，刷新后需重新发起。'
  }
}
function clearStash() {
  // 单槽暂存按空间共享：只清属于本意图的凭据，别的安排的成功保存/清除不得抹掉它的待核实入口。
  try {
    const raw = sessionStorage.getItem(stashKey)
    if (raw == null) return
    let s = null
    try { s = JSON.parse(raw) } catch { /* 损坏暂存直接清除 */ }
    if (s && s.envelope && (!intent.value || s.envelope.requestId !== intent.value.envelope.requestId)) return
    sessionStorage.removeItem(stashKey)
  } catch { /* 存储不可用时忽略 */ }
}
onMounted(() => {
  try {
    const raw = sessionStorage.getItem(stashKey)
    if (raw) {
      const s = JSON.parse(raw)
      // 锁定任务入口不得借暂存恢复悄悄换目标：taskId 不一致的旧凭据不恢复。
      if (s && s.mode === props.mode && (s.planId || '') === props.planId && s.envelope && s.input && (!taskLocked || s.input.taskId === props.taskId)) {
        intent.value = { op: s.op, sig: s.sig, envelope: s.envelope, input: s.input }
        // 恢复草稿与已确认事实：重试必须重建出与原输入完全一致的 sig，才能复用原信封不重新生成 ID。
        if (props.mode === 'create' || props.mode === 'another') {
          if (s.input.taskId) dTask.value = s.input.taskId
          if (s.input.date) dDate.value = s.input.date
          if (s.input.actionText != null) dText.value = s.input.actionText
          if (s.input.plannedMinutes != null) dMinutes.value = String(s.input.plannedMinutes)
        } else if (props.mode === 'edit') {
          if (s.input.actionText != null) dText.value = s.input.actionText
          if (s.input.plannedMinutes != null) dMinutes.value = String(s.input.plannedMinutes)
        } else if (props.mode === 'move' && s.input.date) {
          dDate.value = s.input.date
        }
        // 基线随原输入恢复：重试沿用原 expected，不趁恢复换成实时值。
        if (props.mode !== 'create' && s.input.expected) frozenExpected.value = s.input.expected
        const baseKeys = props.mode === 'create' || props.mode === 'another'
          ? ['taskId', 'date', 'actionText', 'plannedMinutes', 'expectedDayPlanIds']
          : props.mode === 'edit' ? ['planItemId', 'expected', 'actionText', 'plannedMinutes'] : ['planItemId', 'expected', 'date']
        const conf = {}
        for (const k of Object.keys(s.input)) if (!baseKeys.includes(k)) conf[k] = s.input[k]
        confirmed.value = conf
        saveState.value = 'verify'
        errorMsg.value = '上次保存结果待核实：可能已提交也可能未提交。核实或原信封重试，不会重新生成 ID。'
      }
    }
  } catch { /* 损坏暂存忽略 */ }
  window.addEventListener('beforeunload', onBeforeUnload)
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
function onBeforeUnload(e) {
  if (dirty.value || saving.value || saveState.value === 'verify') {
    e.preventDefault()
    e.returnValue = ''
  }
}
watch(() => store.workspaceId, (ws) => {
  if (ws !== wsAtOpen) emit('close')
})

async function submit(retryOriginal = false) {
  if (saving.value || !showFields.value) return
  const replay = retryOriginal === true && !!intent.value
  if (saveState.value === 'verify' && !replay) return
  const err = replay ? null : localValidate()
  if (err) {
    saveState.value = 'error'
    errorMsg.value = err
    return
  }
  const op = OP_OF[props.mode]
  const input = replay ? intent.value.input : { ...baseInput(), ...confirmed.value }
  const sig = JSON.stringify(input)
  let envelope
  if (intent.value && intent.value.op === op && intent.value.sig === sig) {
    envelope = intent.value.envelope
  } else {
    const e = planStore.issueRequest(op, input)
    envelope = { requestId: e.requestId, issuedAtMs: e.issuedAtMs, planItemId: e.planItemId }
    intent.value = { op, sig, envelope, input }
  }
  saving.value = true
  saveState.value = 'saving'
  errorMsg.value = ''
  let result
  try {
    result = await planStore[op]({ ...input, ...envelope })
  } catch (e) {
    result = { ok: false, code: 'SAVE_FAILED', message: (e && e.message) || '保存失败', workspace_id: wsAtOpen }
  }
  saving.value = false
  if (result.workspace_id && result.workspace_id !== wsAtOpen) {
    saveState.value = 'error'
    errorMsg.value = '保存结果属于其它空间，已忽略；草稿保留，未写入当前空间。'
    return
  }
  if (result.ok) {
    clearStash()
    saveState.value = 'saved'
    emit('saved', { op, planId: result.plan_item_id, date: input.date || (plan.value && plan.value.date) || dDate.value })
    return
  }
  handleFailure(result)
}

// —— 失败分流：确认类开框冻结事实；信封类清意图；提交未知进待核实 ——
const dlgDeadline = ref(false)
const dlPayload = ref(null) // {value, precision, planDate}
const dlgDuplicate = ref(false)
const dupPayload = ref(null) // {matchingIds, date, taskId}
const dlgStale = ref(false)
const stalePayload = ref(null) // {field, expected, current}
const staleFrozen = ref(null) // 差异框展示时冻结的完整快照：显示与确认同版，确认不追 live

function handleFailure(r) {
  saveState.value = 'error'
  // 提醒类回执（info.code）不带 message，横幅不能露原始码。
  const codeText = {
    DUPLICATE_PLAN: '同任务同日已有相同安排，请确认是否仍要添加。',
    DUPLICATE_SCOPE_CHANGED: '相同安排的范围已变化，请重新核对后再确认。',
  }
  errorMsg.value = r.message || codeText[r.code] || r.code || '保存失败'
  switch (r.code) {
    case 'DAY_PLANS_CHANGED':
      additionalConfirmed.value = false
      confirmed.value = {}
      intent.value = null
      break
    case 'DUPLICATE_PLAN':
    case 'DUPLICATE_SCOPE_CHANGED':
      dupPayload.value = { matchingIds: r.matchingIds || [], date: r.date || dDate.value, taskId: r.taskId || dTask.value }
      if (r.code === 'DUPLICATE_SCOPE_CHANGED') {
        const { confirmedDuplicateIds, ...rest } = confirmed.value
        void confirmedDuplicateIds
        confirmed.value = rest
      }
      dlgDuplicate.value = true
      break
    case 'AFTER_DEADLINE_UNCONFIRMED':
      dlPayload.value = { value: r.risk.deadlineValue, precision: r.risk.deadlinePrecision, planDate: r.risk.planDate }
      dlgDeadline.value = true
      break
    case 'DEADLINE_CHANGED':
      dlPayload.value = { ...r.current }
      dlgDeadline.value = true
      break
    case 'STALE_PLAN':
      // 开框即冻结完整快照（回执后 store 已重读）；展示值取自同一快照，保证显示与将确认的版本一致。
      if (!plan.value) {
        errorMsg.value = '安排已不存在或不属于当前空间，无法按最新事实重新提交。'
        break
      }
      staleFrozen.value = planSnapshot(plan.value)
      // 回执只报首个差异字段；展示必须列全：本次提交基线 vs 开框冻结快照逐字段比较，并标出草稿将写入的值。
      const writes = props.mode === 'edit'
        ? { action_text: dText.value.trim(), planned_minutes: minutesNum.value }
        : props.mode === 'move' ? { date: dDate.value } : {}
      stalePayload.value = { rows: planStaleRows(frozenExpected.value, staleFrozen.value, writes, taskTitleOf) }
      dlgStale.value = true
      break
    case 'STALE_REQUEST':
    case 'REQUEST_ENVELOPE_REQUIRED':
      intent.value = null
      errorMsg.value = `${r.message || '请求信封失效'}；请重新提交（新意图）。`
      break
    case 'SAVE_FAILED':
      saveState.value = 'verify'
      stash()
      errorMsg.value = '保存结果待核实：事务可能已提交也可能未提交。请核实结果或用原信封重试，不会重新生成 ID。'
      break
    default:
      break
  }
}

function onDeadlineConfirm() {
  const p = dlPayload.value
  dlgDeadline.value = false
  confirmed.value = { ...confirmed.value, deadlineConfirm: { value: p.value, precision: p.precision, planDate: p.planDate } }
  submit()
}
function onDuplicateConfirm() {
  const ids = [...dupPayload.value.matchingIds]
  dlgDuplicate.value = false
  confirmed.value = { ...confirmed.value, confirmedDuplicateIds: ids }
  submit()
}
function onStaleConfirm() {
  dlgStale.value = false
  if (!staleFrozen.value) {
    errorMsg.value = '安排已不存在或不属于当前空间，无法按最新事实重新提交。'
    return
  }
  // 只提交差异框展示过的那份快照；若事实又变，服务会再回 STALE 并展示新差异，不自动追随 live。
  // 快照变化=新意图（新信封），草稿保留。
  frozenExpected.value = staleFrozen.value
  staleFrozen.value = null
  intent.value = null
  submit()
}

async function verify() {
  if (!intent.value) return
  saving.value = true
  await store.reloadDocs()
  saving.value = false
  const id = intent.value.envelope.planItemId
  const p = store.docs.find((d) => d.kind === 'plan_item' && d.id === id)
  const inp = intent.value.input
  let committed = false
  if (props.mode === 'create' || props.mode === 'another') committed = !!p && (!taskLocked || p.task_id === props.taskId)
  else if (p) committed = props.mode === 'edit' ? p.action_text === inp.actionText && p.planned_minutes === inp.plannedMinutes : p.date === inp.date
  if (committed) {
    clearStash()
    saveState.value = 'saved'
    emit('saved', { op: OP_OF[props.mode], planId: id, date: inp.date || (p && p.date) || dDate.value })
  } else {
    saveState.value = 'error'
    errorMsg.value = '核实结果：尚未提交。可原信封重试，或修改后作为新意图提交。'
  }
}
function dropStash() {
  clearStash()
  intent.value = null
  saveState.value = 'unsaved'
  errorMsg.value = ''
}

// —— 关闭/离开保护：未保存草稿、保存中、待核实都必须显式选择 ——
const dlgDiscard = ref(false)
const discardAction = ref('close')
let leaveResolver = null
function requestClose() {
  if (saving.value) {
    errorMsg.value = '正在保存：请等待本次结果后再关闭或切换表单。'
    return
  }
  if (dirty.value || saveState.value === 'verify') {
    discardAction.value = 'close'
    dlgDiscard.value = true
  } else emit('close')
}
function requestGotoCreate() {
  if (saving.value) {
    errorMsg.value = '正在保存：请等待本次结果后再切换表单。'
    return
  }
  if (props.inlineCreate && saveState.value !== 'verify') { emit('goto-create-task'); return }
  if (dirty.value || saveState.value === 'verify') {
    discardAction.value = 'goto-create'
    dlgDiscard.value = true
  } else emit('goto-create-task')
}
function onDiscardConfirm() {
  dlgDiscard.value = false
  const action = discardAction.value
  if (leaveResolver) {
    leaveResolver(true)
    leaveResolver = null
    return
  }
  if (action === 'goto-create') emit('goto-create-task')
  else emit('close')
}
// 取消/Esc/遮罩关闭只改 open：统一在这里结算离开守卫，避免 Promise 悬置卡住导航。
watch(dlgDiscard, (open) => {
  if (!open && leaveResolver) {
    leaveResolver(false)
    leaveResolver = null
  }
})
function guardLeave() {
  // 保存中不允许被替换/离开：避免旧请求回调晚到时关闭或清理新表单；本地事务很快，等待即可。
  if (saving.value) {
    errorMsg.value = '正在保存：请等待本次结果后再关闭或切换表单。'
    return Promise.resolve(false)
  }
  if (!dirty.value && saveState.value !== 'verify') return Promise.resolve(true)
  return new Promise((resolve) => {
    leaveResolver = resolve
    discardAction.value = 'leave'
    dlgDiscard.value = true
  })
}
function selectCreatedTask(id) {
  if (props.mode !== 'create' || taskLocked || saving.value || saveState.value === 'verify') return
  if (store.tasks.some((task) => task.id === id)) dTask.value = id
}
defineExpose({ guardLeave, selectCreatedTask })

// —— 任务选择（仅 create）：搜索、未完成优先、受阻可选带标记、已完成不可新建 ——
const taskQuery = ref('')
const pickerTasks = computed(() => {
  const q = taskQuery.value.trim()
  return store.tasks
    .filter((t) => !q || t.title.includes(q))
    .slice()
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.title.localeCompare(b.title, 'zh'))
    .slice(0, 8)
})
const taskActions = computed(() => (dTask.value ? store.actions.filter((a) => a.task_id === dTask.value) : []))
function copyAction(a) {
  dText.value = a.text
  dMinutes.value = String(a.minutes == null ? 30 : a.minutes)
}
const dupExisting = computed(() =>
  (dupPayload.value ? dupPayload.value.matchingIds : [])
    .map((id) => store.docs.find((d) => d.kind === 'plan_item' && d.id === id))
    .filter(Boolean),
)
const taskTitleOf = (id) => {
  const t = store.docs.find((d) => d.kind === 'task' && d.id === id)
  return t ? t.title : null
}
</script>

<template>
  <Card>
    <template #header>
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1 text-base font-semibold">{{ TITLES[props.mode] }}</div>
        <Badge v-if="saveState === 'verify'" variant="warning">待核实</Badge>
        <Badge v-else-if="saveState === 'saving'" variant="secondary">保存中</Badge>
        <Badge v-else-if="dirty" variant="outline">未保存</Badge>
        <Button v-if="showClose" size="sm" variant="ghost" aria-label="关闭安排编辑" title="关闭" @click="requestClose"><X /></Button>
      </div>
    </template>

    <form class="space-y-3" @submit.prevent="submit()">
      <!-- 任务：create 可选可搜；其余模式固定只读 -->
      <div v-if="props.mode === 'create'" class="space-y-2">
        <div v-if="fixedTask" class="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span class="min-w-0 flex-1 break-words font-medium">{{ fixedTask.title }}</span>
          <Badge v-if="fixedTask.status === 'blocked'" variant="warning">受阻</Badge>
          <Badge v-else variant="secondary">{{ label(STATUS_LABELS, fixedTask.status) }}</Badge>
          <Badge v-if="taskLocked" variant="outline">固定任务</Badge>
          <Button v-else size="sm" variant="outline" type="button" @click="dTask = ''">更换</Button>
        </div>
        <template v-else>
          <Input v-model="taskQuery" placeholder="搜索任务名称…" aria-label="搜索任务" />
          <div v-if="store.tasks.length" class="max-h-44 space-y-1 overflow-y-auto scroll-slim rounded-md border p-1.5">
            <button
              v-for="t in pickerTasks"
              :key="t.id"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="t.status === 'done'"
              :aria-label="`选择任务：${t.title}`"
              @click="dTask = t.id"
            >
              <span class="min-w-0 flex-1 break-words">{{ t.title }}</span>
              <Badge v-if="t.status === 'done'" variant="muted">已完成·不可新建</Badge>
              <Badge v-else-if="t.status === 'blocked'" variant="warning">受阻</Badge>
              <Badge v-else variant="secondary">{{ label(STATUS_LABELS, t.status) }}</Badge>
            </button>
            <p v-if="!pickerTasks.length" class="px-2 py-1 text-xs text-muted-foreground">没有匹配的任务。</p>
          </div>
          <div v-else class="rounded-md border border-dashed p-3 text-sm">
            <p class="text-muted-foreground">还没有任务。安排必须挂在已有任务下，不会隐式创建任务。</p>
            <Button v-if="!inlineCreate" size="sm" variant="outline" type="button" class="mt-2" @click="requestGotoCreate">先创建任务</Button>
          </div>
          <Button v-if="inlineCreate" size="sm" variant="outline" type="button" class="mt-2" :disabled="saving || saveState === 'verify'" @click="requestGotoCreate">新建任务并继续</Button>
        </template>

      </div>
      <div v-else class="text-sm">
        <span class="text-muted-foreground">所属任务：</span>
        <span class="font-medium">{{ fixedTask ? fixedTask.title : '原任务已删除' }}</span>
      </div>

      <div class="flex flex-wrap items-end gap-3">
        <div class="w-56 max-w-full">
          <div class="text-xs font-medium text-muted-foreground">安排日期</div>
          <DateInput v-if="props.mode !== 'edit'" v-model="dDate" aria-label="安排日期" />
          <div v-else class="font-date rounded-md border bg-muted/40 px-3 py-2 text-sm">{{ dDate }}</div>
        </div>
        <div v-if="showFields" class="w-28">
          <div class="text-xs font-medium text-muted-foreground">预计分钟</div>
          <Input v-if="props.mode !== 'move'" v-model="dMinutes" inputmode="numeric" aria-label="预计分钟" />
          <div v-else class="font-date rounded-md border bg-muted/40 px-3 py-2 text-sm">{{ dMinutes }}</div>
        </div>
        <p v-if="fixedTask && fixedTask.deadline && fixedTask.deadline.value" class="pb-2 text-xs text-muted-foreground">
          任务总截止（只读）：{{ slotDeadlineLabel(fixedTask.deadline) }}
        </p>
      </div>

      <section v-if="dayPlans.length" aria-label="这项任务当天已有的安排" class="space-y-2 border-y py-3">
        <h3 class="text-sm font-medium">这项任务当天已有 {{ dayPlans.length }} 项安排</h3>
        <ul class="divide-y">
          <li v-for="{ item, block } in dayPlanRows" :key="item.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span class="min-w-0 flex-1 break-words">{{ item.action_text }}</span>
            <span class="shrink-0 text-muted-foreground">{{ item.planned_minutes }} 分钟</span>
            <span v-if="item.state !== 'planned'" class="text-xs text-muted-foreground">{{ label(PLAN_STATE_LABELS, item.state) }}</span>
            <Button v-if="!block" type="button" size="sm" variant="outline" :disabled="saving || saveState === 'verify'" @click="emit('edit', item.id)">修改安排</Button>
            <span v-else-if="item.state === 'planned' || item.state === 'partial'" class="text-xs text-muted-foreground">{{ block.message }}</span>
          </li>
        </ul>
        <Button v-if="!showFields" type="button" size="sm" variant="outline" @click="additionalConfirmed = true">另加一项工作</Button>
      </section>

      <div v-if="props.mode === 'create' && showFields && taskActions.length" class="rounded-md border border-dashed p-2">
        <div class="text-xs font-medium text-muted-foreground">用已有行动填写新安排</div>
        <div class="mt-1 space-y-1">
          <button
            v-for="a in taskActions"
            :key="a.id"
            type="button"
            class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
            @click="copyAction(a)"
          >
            <span class="min-w-0 flex-1 truncate">{{ a.text }}</span>
            <span class="font-date text-muted-foreground">{{ a.minutes }} 分</span>
            <span v-if="a.done" class="text-muted-foreground">已完成</span>
            <span class="text-primary">填入</span>
          </button>
        </div>
      </div>
      <div v-if="showFields">
        <div class="text-xs font-medium text-muted-foreground">工作说明（这天准备做什么）</div>
        <Textarea v-if="props.mode !== 'move'" v-model="dText" rows="2" aria-label="工作说明" placeholder="例如：梳理本周进展并列出周报提纲" />
        <div v-else class="break-words rounded-md border bg-muted/40 px-3 py-2 text-sm">{{ dText }}</div>
      </div>

      <p v-if="props.mode === 'another'" class="text-xs text-muted-foreground">
        另安排一天会新建一项安排；原安排与其工作记录保持原样。说明与估时请再确认一次。
      </p>

      <div v-if="errorMsg" role="alert" class="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-sm">
        {{ errorMsg }}
        <div v-if="saveState === 'verify'" class="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" type="button" :disabled="saving" @click="verify">核实结果</Button>
          <Button size="sm" variant="outline" type="button" :disabled="saving" @click="submit(true)">原信封重试</Button>
          <Button size="sm" variant="ghost" type="button" @click="dropStash">清除待核实记录</Button>
        </div>
        <div v-else-if="intent && saveState === 'error'" class="mt-2">
          <Button size="sm" variant="outline" type="button" :disabled="saving" @click="submit()">重试保存（同一请求）</Button>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button v-if="showFields && saveState !== 'verify'" type="submit" :disabled="saving" :aria-busy="saving">{{ saving ? '保存中…' : SUBMIT_LABELS[props.mode] }}</Button>
        <Button variant="outline" type="button" @click="requestClose">关闭</Button>
      </div>
    </form>

    <!-- 超截止二次确认：冻结事实对象 {value, precision, planDate}，不是布尔 -->
    <ConfirmDialog v-model="dlgDeadline" tone="primary" title="安排日晚于任务截止" confirm-label="确认晚于截止仍安排" @confirm="onDeadlineConfirm">
      <p>任务总截止：{{ dlPayload && dlPayload.value ? slotDeadlineLabel({ value: dlPayload.value, precision: dlPayload.precision }) : '无' }}</p>
      <p class="mt-1">安排日期：{{ dlPayload && dlPayload.planDate }}。确认后才会保存；截止事实变化会要求重新确认。</p>
    </ConfirmDialog>

    <!-- 重复安排：展示已有日期/说明/数量；仍要添加=新意图 -->
    <ConfirmDialog v-model="dlgDuplicate" tone="primary" title="已有相同安排" confirm-label="仍要添加" @confirm="onDuplicateConfirm">
      <p>同任务同日已有 {{ dupExisting.length }} 项安排：</p>
      <ul class="mt-1 list-disc space-y-0.5 pl-5">
        <li v-for="p in dupExisting" :key="p.id">{{ p.date }} · {{ p.action_text }} · {{ label(PLAN_STATE_LABELS, p.state) }}</li>
      </ul>
      <p class="mt-1">「仍要添加」会新建一项安排，不会合并或覆盖已有安排。</p>
    </ConfirmDialog>

    <!-- 快照过期：展示差异，用户按最新事实重新确认后才提交 -->
    <ConfirmDialog v-model="dlgStale" tone="primary" title="安排已被其它修改更新" confirm-label="按最新事实重新提交" @confirm="onStaleConfirm">
      <p>以下字段已变化（当前值为开框时冻结的最新快照，与确认提交的版本一致）：</p>
      <ul v-if="stalePayload && stalePayload.rows.length" class="mt-1 space-y-2">
        <li v-for="row in stalePayload.rows" :key="row.field">
          <p>字段「{{ row.name }}」：你提交时的值 {{ row.expectedText }} → 当前最新值 {{ row.currentText }}</p>
          <p v-if="row.writeText != null" class="text-xs text-muted-foreground">本次草稿将写入：{{ row.writeText }}{{ row.writeText !== row.currentText ? '（将覆盖当前最新值）' : '' }}</p>
        </li>
      </ul>
      <p v-else class="mt-1">提交期间安排曾被其它修改更新，但开框时的最新快照与本次提交基线逐字段一致（外部可能已改回）。</p>
      <p class="mt-1">草稿保留；确认后按最新快照重新提交。</p>
    </ConfirmDialog>

    <!-- 未保存关闭/离开：显式放弃或继续编辑 -->
    <ConfirmDialog v-model="dlgDiscard" title="放弃未保存的安排草稿？" confirm-label="放弃草稿" cancel-label="继续编辑" @confirm="onDiscardConfirm">
      <p>{{ saveState === 'verify' ? '保存结果仍待核实；离开后凭据保留在本空间，重新打开同一安排可继续核实或原信封重试。' : '当前草稿尚未保存，放弃后不可恢复。' }}</p>
    </ConfirmDialog>
  </Card>
</template>
