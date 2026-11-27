<script setup>
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { X } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import StartPlanWorkDialog from '@/components/domain/StartPlanWorkDialog.vue'
import TaskDeleteDialog from './TaskDeleteDialog.vue'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { usePlanStore } from '@/stores/plan'
import { usePlanWorkStart, planStartEntry } from '@/composables/usePlanWorkStart'
import { useScheduledAction } from '@/composables/useScheduledAction'
import { LIVE_PLAN_STATES, endedSessionsForPlan, historySignature, isLiveRef, planEditBlock, planRisk, planSnapshot, unfinishedSessionsForPlan } from '@/domains/plan'
import { beijingDateStr, beijingInstantLabel } from '@/domains/time'
import { endedSessionsSorted, formatDurationMs } from '@/domains/work'
import { slotDeadlineLabel } from '@/domains/week'
import { planScheduleReturn, recordPath, taskPath, workPath } from '@/domains/workNavigation'
import { taskListPath } from '@/domains/taskList'
import { PLAN_PROBLEM_LABELS, PLAN_STATE_LABELS, SESSION_OUTCOME_LABELS, label, planActualLabel, planStaleRows } from '@/domains/labels'

// 安排详情：事实全部读 app.docs live，不缓存副本。
// 实际用时只认权威摘要：异常→待核对块；缓存差异→明确提示不自动写。
// 开始/回到工作主入口（5A-2B §3.1）：同安排未结束→回到真实会话；冲突→先处理；资格满足→共享确认面板。
// 说明与估时的编辑资格与任务列表、写事务共用 planEditBlock；改期、取消和进度各自检查历史。
const props = defineProps({
  planId: { type: String, required: true },
  showClose: { type: Boolean, default: true },
})
const emit = defineEmits(['close', 'edit', 'move', 'another', 'op-done'])
const store = useAppStore()
const focus = useFocusStore()
const planStore = usePlanStore()
const route = useRoute()
const router = useRouter()

const plan = computed(() => store.docs.find((d) => d.kind === 'plan_item' && d.id === props.planId) || null)
const task = computed(() => (plan.value ? store.tasks.find((t) => t.id === plan.value.task_id) || null : null))
const deleteDialog = ref(null)
const canRequestTaskDelete = computed(() => task.value && plan.value && isLiveRef(plan.value) && LIVE_PLAN_STATES.includes(plan.value.state) && task.value.status !== 'done')
const summary = computed(() => (plan.value ? planStore.summary(plan.value.id) : null))
const endedSessions = computed(() => (plan.value ? endedSessionsSorted(endedSessionsForPlan(store.docs, plan.value)) : []))
const unfinishedSessions = computed(() => (plan.value ? unfinishedSessionsForPlan(store.docs, plan.value) : []))
const risk = computed(() => (plan.value && task.value ? planRisk(task.value, plan.value.date, new Date(store.nowTick)) : null))

const stateVariant = { planned: 'secondary', partial: 'warning', done: 'success', cancelled: 'muted', moved: 'muted' }
// 只读原因：断引用/任务缺失/任务已完成/终态，如实解释，不伪造可操作入口。
const readonlyReason = computed(() => {
  const p = plan.value
  if (!p) return ''
  if (!isLiveRef(p) || !task.value) return '原任务已删除，历史只读'
  if (task.value.status === 'done') return '任务已完成，历史只读'
  if (!LIVE_PLAN_STATES.includes(p.state)) return `${label(PLAN_STATE_LABELS, p.state)}的安排是历史，只读；继续工作请另建安排`
  return ''
})
const deadlineText = computed(() => {
  if (!task.value) return '—'
  return slotDeadlineLabel(task.value.deadline) || '无截止'
})

// 出处/记录/工作链接携带规范化日程 return（定位本安排，保留来源日期视图），不再反复包 fullPath。
const todayStr = computed(() => beijingDateStr(new Date(store.nowTick)))
const scheduleReturn = computed(() => (plan.value ? planScheduleReturn(route.path, route.query, plan.value, todayStr.value) : '/today'))
const taskLink = computed(() => (task.value ? taskPath(task.value.id, {
  return: route.path === '/tasks' ? taskListPath(route.query) : scheduleReturn.value,
}) : null))
const recordLink = (s) => recordPath(s.id, scheduleReturn.value)
const workLink = (s) => workPath(s.id, scheduleReturn.value)
const latestSession = computed(() =>
  summary.value && summary.value.latestEndedSessionId
    ? endedSessions.value.find((s) => s.id === summary.value.latestEndedSessionId) || null
    : null)
const minutesText = (m) => (m == null ? '未记录' : m === 0 ? '<1分钟' : `${m} 分钟`)

// —— 操作资格与变更命令（取消/人工进度在本组件确认；编辑/改期/另安排一天交共享编辑器）——
const hasEnded = computed(() => !!summary.value && summary.value.endedSessionCount > 0)
const ops = computed(() => {
  const p = plan.value
  if (!p || !isLiveRef(p) || !task.value || task.value.status === 'done') return []
  const edits = planEditBlock(store.docs, p) ? [] : ['edit']
  if (unfinishedSessions.value.length) return edits
  if (summary.value && !summary.value.authoritative) return []
  if (p.state === 'planned' && !hasEnded.value) return [...edits, 'move', 'confirm', 'cancel']
  if (p.state === 'planned' || p.state === 'partial') return [...edits, 'confirm', 'cancel', 'another']
  return ['another']
})
const OP_LABELS = { edit: '编辑', move: '改期', confirm: '确认进度', cancel: '取消安排', another: '另安排一天' }
function requestOp(op) {
  if (op === 'cancel') return requestCancel()
  if (op === 'confirm') return requestProgress()
  emit(op, props.planId)
}

// —— 开始/回到工作主入口（5A-2B §3.1）：页面预检查只解释入口，最终资格由 focus.begin 事务决定 ——
const crossWsRunning = computed(() => (focus.running && focus.running.workspace_id !== store.workspaceId ? focus.running : null))
const entry = computed(() => planStartEntry({
  plan: plan.value, task: task.value, docs: store.docs,
  localUnfinished: focus.unfinished[0] || null, crossWsRunning: crossWsRunning.value,
}))
const crossWsName = computed(() => {
  const r = crossWsRunning.value
  if (!r) return ''
  const w = store.workspaces.find((x) => x.id === r.workspace_id)
  return w ? w.name : r.workspace_id
})
// review 入口复用原进度核对框，操作区不再重复渲染「确认进度」。
const opsDisplay = computed(() => (entry.value.kind === 'review' ? ops.value.filter((o) => o !== 'confirm') : ops.value))

const startCtrl = usePlanWorkStart({
  onStarted: (sid) => {
    if (store.banner?.tone === 'success') store.banner = null
    router.push(workPath(sid, scheduleReturn.value))
  },
  onGotoTask: (planId) => {
    if (task.value) router.push(taskPath(task.value.id, { plan: planId, return: scheduleReturn.value }))
  },
  onReview: () => requestProgress(),
  workReturnFor: () => scheduleReturn.value,
})
const pickedActionId = ref('')
const { action: scheduledAction, available: availableActions, binding, status: bindingStatus } = useScheduledAction(plan, task)
const startAction = computed(() => pickedActionId.value
  ? availableActions.value.find(action => action.id === pickedActionId.value)
  : scheduledAction.value)
watch([() => props.planId, () => store.workspaceId], () => { pickedActionId.value = '' })
const actionText = ref('')
const addingAction = ref(false)
watch([() => plan.value?.id, () => store.workspaceId], () => {
  actionText.value = plan.value?.action_text || ''
}, { immediate: true })

async function addPlanAction() {
  const owner = task.value
  const item = plan.value
  if (addingAction.value || !owner || !item || !actionText.value.trim() || availableActions.value.length) return
  const ws = store.workspaceId
  addingAction.value = true
  try {
    const result = await store.addAction(owner, actionText.value.trim(), item.planned_minutes)
    if (result.ok && plan.value?.id === item.id && ws === store.workspaceId) pickedActionId.value = result.id
  } finally {
    addingAction.value = false
  }
}
function pickAction(event) {
  if (event.target instanceof HTMLSelectElement) pickedActionId.value = event.target.value
}
async function startThisPlan() {
  if (!plan.value || !task.value || bindingStatus.value === 'loading' || startCtrl.state.value?.busy) return
  const chosen = startAction.value
  if (availableActions.value.length && !chosen) return
  if (!startCtrl.openFor({ taskId: task.value.id, planId: plan.value.id, actionId: chosen?.id })) return
  if (chosen && startCtrl.canConfirm.value) await startCtrl.submit()
}
async function gotoOtherWs() {
  const r = crossWsRunning.value
  if (!r) return
  await store.switchWorkspace(r.workspace_id)
  router.push('/work/' + r.session_id)
}

const opBusy = ref(false)
const dlgCancel = ref(false)
const dlgProgress = ref(false)
const dlgHistory = ref(false)
const dlgStale = ref(false)
const progressChoice = ref('partial')
// 开框即冻结目标与快照；确认回调只用冻结值，防 AlertDialog 自动关闭清目标的竞态。
const frozen = ref(null) // {planId, expected, historyConfirm, op}
const historyPayload = ref(null)
const stalePayload = ref(null)
const staleFrozen = ref(null) // 差异框展示时冻结的完整快照：显示与确认同版，确认不追 live
const taskTitleOf = (id) => {
  const t = store.docs.find((d) => d.kind === 'task' && d.id === id)
  return t ? t.title : null
}

function requestCancel() {
  frozen.value = {
    planId: plan.value.id,
    expected: planSnapshot(plan.value),
    historyConfirm: hasEnded.value && summary.value.authoritative ? historySignature(summary.value) : null,
    op: 'cancel',
  }
  dlgCancel.value = true
}
function requestProgress() {
  frozen.value = {
    planId: plan.value.id,
    expected: planSnapshot(plan.value),
    historyConfirm: hasEnded.value && summary.value.authoritative ? historySignature(summary.value) : null,
    op: 'confirmProgress',
  }
  progressChoice.value = 'partial'
  dlgProgress.value = true
}
async function runFrozen() {
  const f = frozen.value
  if (!f || opBusy.value) return
  opBusy.value = true
  // 信封必须按即将提交的完整不可变输入签发（服务按输入签名绑定），只传 planItemId 会被判 STALE_REQUEST。
  const input = { planItemId: f.planId, expected: f.expected }
  if (f.op === 'cancel') input.confirm = true
  else input.progress = progressChoice.value
  if (f.historyConfirm) input.historyConfirm = f.historyConfirm
  const env = planStore.issueRequest(f.op, input)
  const r = await planStore[f.op]({ ...input, requestId: env.requestId, issuedAtMs: env.issuedAtMs })
  opBusy.value = false
  if (r.ok) {
    emit('op-done', { planId: f.planId, date: plan.value ? plan.value.date : f.expected.date })
    return
  }
  if (r.code === 'HISTORY_UNCONFIRMED' || r.code === 'HISTORY_CHANGED') {
    historyPayload.value = r.code === 'HISTORY_CHANGED' ? r.current : r.history
    dlgHistory.value = true
    return
  }
  if (r.code === 'STALE_PLAN') {
    // 开框即冻结完整快照（回执后 store 已重读）；展示值取自同一快照，保证显示与将确认的版本一致。
    const live = store.docs.find((d) => d.kind === 'plan_item' && d.id === f.planId)
    if (!live) {
      store.say('warning', '安排已不存在，操作取消')
      return
    }
    staleFrozen.value = planSnapshot(live)
    // 回执只报首个差异字段；展示必须列全：本次提交基线 vs 开框冻结快照逐字段比较，并标出操作将写入的值。
    const writes = { state: f.op === 'cancel' ? 'cancelled' : progressChoice.value }
    stalePayload.value = { rows: planStaleRows(f.expected, staleFrozen.value, writes, taskTitleOf) }
    dlgStale.value = true
    return
  }
  store.say('error', r.message || r.code || '操作失败')
}
function onHistoryConfirm() {
  dlgHistory.value = false
  frozen.value = { ...frozen.value, historyConfirm: historyPayload.value }
  runFrozen()
}
function onStaleConfirm() {
  dlgStale.value = false
  if (!staleFrozen.value) {
    store.say('warning', '安排已不存在，操作取消')
    return
  }
  // 只提交差异框展示过的那份快照；若事实又变，服务会再回 STALE 并展示新差异，不自动追随 live。
  frozen.value = { ...frozen.value, expected: staleFrozen.value }
  staleFrozen.value = null
  runFrozen()
}
const historyView = computed(() => {
  const h = historyPayload.value
  if (!h) return null
  return {
    count: h.endedSessionIds.length,
    total: formatDurationMs(h.totalMs),
    actual: h.actualMinutes == null ? '未记录' : h.actualMinutes === 0 ? '<1分钟' : `${h.actualMinutes} 分钟`,
  }
})
</script>

<template>
  <Card flush class="rounded-none border-0">
    <template v-if="showClose" #header>
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1 text-base font-semibold">安排详情</div>
        <Button v-if="showClose" size="sm" variant="ghost" aria-label="关闭安排详情" title="关闭" @click="emit('close')"><X /></Button>
      </div>
    </template>

    <p v-if="!plan" class="text-sm text-muted-foreground">安排已不存在或不属于当前空间。</p>
    <div v-else class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <Badge :variant="stateVariant[plan.state] || 'secondary'" :title="plan.state">{{ label(PLAN_STATE_LABELS, plan.state) }}</Badge>
        <span v-if="readonlyReason" class="text-xs text-muted-foreground">{{ readonlyReason }}</span>
      </div>
      <h2 class="break-words text-xl font-semibold leading-snug">{{ plan.action_text }}</h2>
      <div class="text-sm">
        <span class="text-muted-foreground">所属任务：</span>
        <RouterLink v-if="taskLink" :to="taskLink" class="underline underline-offset-2">{{ task.title }}</RouterLink>
        <span v-else>原任务已删除</span>
      </div>

      <dl class="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div class="flex gap-2"><dt class="text-muted-foreground">安排日期</dt><dd class="font-date font-medium">{{ plan.date }}</dd></div>
        <div class="flex gap-2"><dt class="text-muted-foreground">预计</dt><dd class="font-date font-medium">{{ plan.planned_minutes }} 分钟</dd></div>
        <div v-if="task && slotDeadlineLabel(task.deadline)" class="flex gap-2">
          <dt class="text-muted-foreground">总截止</dt>
          <dd class="font-medium" :class="risk && (risk.kind === 'after_deadline' || risk.overdue) ? 'text-destructive' : ''">
            {{ deadlineText }}<template v-if="risk && risk.kind === 'after_deadline'"> · 安排晚于截止</template><template v-else-if="risk && risk.overdue"> · 已逾期</template>
          </dd>
        </div>
      </dl>

      <!-- 异常历史：待核对块权威优先，不给可确认的数字 -->
      <div v-if="summary && !summary.authoritative" class="rounded-md border border-warning bg-warning/10 p-3 text-sm">
        <div class="font-medium text-warning-foreground">历史用时存在异常，未生成权威摘要（待核对）</div>
        <p class="mt-1 text-xs text-muted-foreground">异常处理前不能确认进度或取消；原摘要保留，不自动改写。请先核对下列记录：</p>
        <ul class="mt-1 list-disc space-y-0.5 pl-5 text-xs">
          <li v-for="p in summary.problems" :key="p.code + p.sessionId">
            {{ label(PLAN_PROBLEM_LABELS, p.code) }} ·
            <RouterLink :to="recordLink({ id: p.sessionId })" class="underline">查看该记录</RouterLink>
          </li>
        </ul>
      </div>
      <div v-else-if="summary && summary.endedSessionCount > 0" class="rounded-md border p-3 text-sm">
        <span class="font-medium">实际 {{ planActualLabel(summary) }}</span>
        <span class="text-muted-foreground"> · 累计 {{ formatDurationMs(summary.totalMs) }} · {{ summary.endedSessionCount }} 段已结束</span>
        <RouterLink v-if="latestSession" :to="recordLink(latestSession)" class="ml-2 text-xs underline">最近一段记录</RouterLink>
      </div>

      <!-- 缓存差异：只读提示，确认进度时按明细重算，不自动写库 -->
      <div v-if="summary && summary.cacheMismatch" class="rounded-md border border-dashed border-warning p-3 text-xs">
        <div class="font-medium text-warning-foreground">缓存与明细不一致（仅提示，不自动改写）</div>
        <p class="mt-1 text-muted-foreground">
          缓存：{{ minutesText(summary.cacheMismatch.cachedActualMinutes) }} / 明细：{{ minutesText(summary.cacheMismatch.computedActualMinutes) }}。
          确认进度或取消时按明细重算权威摘要。
        </p>
      </div>

      <!-- 开始/回到工作主入口（§3.1 优先级）：同安排未结束→回到真实会话；冲突→先处理；资格满足→共享确认面板 -->
      <div v-if="entry.kind === 'existing'" class="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
        <div class="font-medium">该安排有未结束的工作（{{ entry.session.running ? '正在计时' : '已暂停' }}）</div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" @click="router.push(workLink(entry.session))">回到工作</Button>
          <span v-if="entry.session.running" class="text-xs text-muted-foreground">暂停计时后可以编辑安排。</span>
        </div>
      </div>
      <div v-else-if="entry.kind === 'local-conflict'" class="rounded-md border border-warning bg-warning/10 p-3 text-sm">
        <div class="font-medium text-warning-foreground">本空间已有其它未结束的工作（含暂停），先处理它再开始本安排</div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" @click="router.push(workPath(entry.session.id, scheduleReturn))">先处理已有工作</Button>
          <span class="text-xs text-muted-foreground">同一空间同时只能有一段未结束工作。</span>
        </div>
      </div>
      <div v-else-if="entry.kind === 'cross-ws'" class="rounded-md border border-warning bg-warning/10 p-3 text-sm">
        <div class="font-medium text-warning-foreground">「{{ crossWsName }}」有一段正在运行的工作，这里不会替它暂停或结束</div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" @click="gotoOtherWs">前往{{ crossWsName }}查看</Button>
          <span class="text-xs text-muted-foreground">明确切换空间后处理；取消不改变任何会话。</span>
        </div>
      </div>
      <div v-else-if="entry.kind === 'review'" class="rounded-md border border-warning bg-warning/10 p-3 text-sm">
        <div class="font-medium text-warning-foreground">该安排仍为待执行，但已有结束历史，请先人工核对进度</div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" @click="requestProgress">核对已有进度</Button>
          <span class="text-xs text-muted-foreground">不会自动改为部分完成，也不新开无法正常结束的段。</span>
        </div>
      </div>
      <div v-else-if="entry.kind === 'start'" class="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-3">
        <p v-if="bindingStatus === 'loading'" role="status" class="text-sm text-muted-foreground">正在读取安排行动…</p>
        <p v-else-if="scheduledAction" class="text-sm">执行行动 · {{ scheduledAction.text }}</p>
        <label v-else-if="availableActions.length" class="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          {{ bindingStatus === 'error' ? '未能读取行动关联，请选择' : binding ? '原行动已失效，请选择替代行动' : '选择这次执行的行动' }}
          <select class="min-w-0 max-w-full rounded border bg-card px-2 py-2" :value="startAction?.id || ''" @change="pickAction">
            <option value="" disabled>选择行动</option>
            <option v-for="action in availableActions" :key="action.id" :value="action.id">{{ action.text }}</option>
          </select>
        </label>
        <form v-else class="w-full space-y-2" @submit.prevent="addPlanAction">
          <label class="block text-sm">这次要做的行动
            <input v-model="actionText" class="mt-1 w-full rounded-md border bg-card px-3 py-2" required />
          </label>
          <Button type="submit" size="sm" :disabled="addingAction || !actionText.trim()">添加行动</Button>
        </form>
        <Button v-if="availableActions.length" size="sm" :disabled="!startAction || bindingStatus === 'loading' || startCtrl.state.value?.busy" @click="startThisPlan">开始工作</Button>
      </div>

      <div v-if="endedSessions.length">
        <div class="text-sm font-medium">已结束的工作记录 · {{ endedSessions.length }}</div>
        <div class="mt-1 max-h-48 space-y-1 overflow-y-auto scroll-slim">
          <div v-for="s in endedSessions" :key="s.id" class="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border px-2 py-1 text-xs">
            <span class="font-date">{{ beijingInstantLabel(s.ended_at) }}</span>
            <span v-if="s.outcome" class="text-muted-foreground">{{ label(SESSION_OUTCOME_LABELS, s.outcome) }}</span>
            <span class="font-date text-muted-foreground">{{ formatDurationMs(s.accumulated_ms) }}</span>
            <RouterLink :to="recordLink(s)" class="ml-auto underline">查看记录</RouterLink>
          </div>
        </div>
      </div>

      <!-- 操作区：资格由 live 事实派生；无资格时不渲染按钮，只读原因/引导块在上方解释 -->
      <details v-if="opsDisplay.length || canRequestTaskDelete" class="border-t pt-3">
        <summary class="cursor-pointer text-sm text-muted-foreground">更多操作</summary>
        <div class="mt-2 flex flex-wrap items-center gap-2">
        <Button
          v-for="op in opsDisplay"
          :key="op"
          size="sm"
          variant="outline"
          :disabled="opBusy"
          @click="requestOp(op)"
        >{{ OP_LABELS[op] }}</Button>
        <Button v-if="canRequestTaskDelete" size="sm" variant="outline" class="text-destructive" :disabled="opBusy" @click="deleteDialog.show()">删除任务</Button>
        </div>
      </details>
    </div>

    <ConfirmDialog v-model="dlgCancel" title="取消这项安排" confirm-label="取消安排" @confirm="runFrozen">
      <p>只取消这项安排，任务和成果保留；后续继续请另建安排。</p>
      <p v-if="hasEnded" class="mt-1">已有 {{ summary.endedSessionCount }} 段已结束工作记录（实际 {{ planActualLabel(summary) }}），记录保留不删除。</p>
      <p class="mt-1 text-xs">取消后本安排进入当日「安排历史」，仍可定位查看。</p>
    </ConfirmDialog>

    <ConfirmDialog v-model="dlgProgress" tone="primary" title="确认这项安排的进度" confirm-label="确认进度" @confirm="runFrozen">
      <div class="space-y-1">
        <label class="flex items-center gap-2 text-sm">
          <input v-model="progressChoice" type="radio" value="partial" class="accent-primary" />部分完成（之后还可继续确认）
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="progressChoice" type="radio" value="done" class="accent-primary" />这项安排已完成
        </label>
      </div>
      <p class="mt-2 text-xs">只确认「这项安排」的进度，不代表完成任务；任务完成请在任务详情操作。</p>
      <p v-if="frozen && frozen.historyConfirm" class="mt-1 text-xs">
        将按已展示的历史摘要回传：{{ frozen.historyConfirm.endedSessionIds.length }} 段已结束 · 实际
        {{ frozen.historyConfirm.actualMinutes == null ? '未记录' : frozen.historyConfirm.actualMinutes === 0 ? '<1分钟' : frozen.historyConfirm.actualMinutes + ' 分钟' }}。
      </p>
    </ConfirmDialog>

    <ConfirmDialog v-model="dlgHistory" tone="primary" title="核对历史用时后确认" confirm-label="已核对，继续" @confirm="onHistoryConfirm">
      <p>该安排已有结束记录，确认前必须展示完整历史摘要：</p>
      <p v-if="historyView" class="mt-1">{{ historyView.count }} 段已结束 · 累计 {{ historyView.total }} · 实际 {{ historyView.actual }}</p>
      <p class="mt-1 text-xs">摘要变化会要求重新核对；异常记录需先处理，不能绕过。</p>
    </ConfirmDialog>

    <ConfirmDialog v-model="dlgStale" tone="primary" title="安排已被其它修改更新" confirm-label="按最新事实重新确认" @confirm="onStaleConfirm">
      <p>以下字段已变化（当前值为开框时冻结的最新快照，与确认提交的版本一致）：</p>
      <ul v-if="stalePayload && stalePayload.rows.length" class="mt-1 space-y-2">
        <li v-for="row in stalePayload.rows" :key="row.field">
          <p>字段「{{ row.name }}」：提交时 {{ row.expectedText }} → 当前 {{ row.currentText }}</p>
          <p v-if="row.writeText != null" class="text-xs text-muted-foreground">本次操作将写入：{{ row.writeText }}{{ row.writeText !== row.currentText ? '（将覆盖当前最新值）' : '' }}</p>
        </li>
      </ul>
      <p v-else class="mt-1">提交期间安排曾被其它修改更新，但开框时的最新快照与本次提交基线逐字段一致（外部可能已改回）。</p>
      <p class="mt-1">确认后按最新快照重新执行本次操作。</p>
    </ConfirmDialog>
  </Card>

  <StartPlanWorkDialog :ctrl="startCtrl" />
  <TaskDeleteDialog ref="deleteDialog" :task="task" @deleted="emit('close')"
    @goto-plan="row => router.push({ path: '/today', query: { date: row.date, plan: row.id } })"
    @goto-work="row => router.push(workPath(row.unfinishedSessionId, scheduleReturn))" />
</template>
