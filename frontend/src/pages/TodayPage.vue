<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute, useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, ClipboardList, Inbox, LifeBuoy, Plus } from 'lucide-vue-next'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import ContinueBar from '@/components/domain/ContinueBar.vue'
import PlanWorkspace from '@/components/domain/PlanWorkspace.vue'
import { usePlanStore } from '@/stores/plan'
import { taskListPath } from '@/domains/taskList'
import { registerWorkLeave, requestWorkLeave, resetWorkLeaveApproval } from '@/composables/workLeave'
import WeekView from '@/components/domain/WeekView.vue'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { isLiveRef } from '@/domains/plan'
import { SESSION_OUTCOME_LABELS, label } from '@/domains/labels'
import { recordPath, schedulePath, taskPath } from '@/domains/workNavigation'
import { beijingAddDays, beijingDateStr, isValidDate } from '@/domains/time'
import { endedSessionsSorted, formatDurationMs, sessionActionText, sessionTitle } from '@/domains/work'
import { weekStartOf } from '@/domains/week'

const store = useAppStore()
const focus = useFocusStore()
const route = useRoute()
const router = useRouter()

// 任务主视图：周视图与列表呈现同一七日两区内容（列表按天竖排）。视图写入 URL，返回时恢复。
const view = computed({
  get: () => (route.query.view === 'list' ? 'list' : 'week'),
  set: (v) => {
    const q = { ...route.query }
    if (v === 'list') q.view = 'list'
    else delete q.view
    router.replace({ query: q })
  },
})

// 安排详情深链接（5A-1 §8）：/today?...&plan=<id>。数据就绪后按当前空间校验；
// 无效/跨空间 → 提示并移除参数，不自动创建。关闭 = 移除参数回到同周同日的列表（不用 router.back）。
const planParam = computed(() => (typeof route.query.plan === 'string' && route.query.plan ? route.query.plan : ''))
const activePlan = computed(() => (planParam.value ? store.docs.find((d) => d.kind === 'plan_item' && d.id === planParam.value) || null : null))
function closePlan() {
  const q = { ...route.query }
  delete q.plan
  router.replace({ query: q })
}
watch([() => store.ready, planParam, () => store.docs], () => {
  if (!store.ready || !planParam.value || activePlan.value) return
  store.say('warning', '安排已不存在或不属于当前空间，已从地址移除')
  closePlan()
}, { immediate: true })
// 显式换周/换日后，详情参数若不在展示的七日内则移除（不适用）；周内选日不影响详情。
const currentStart = computed(() =>
  weekStartOf(typeof route.query.date === 'string' && isValidDate(route.query.date) ? route.query.date : beijingDateStr(new Date(store.nowTick))))
watch(() => route.query.date, (nv, ov) => {
  if (nv === ov || !activePlan.value) return
  const end = beijingAddDays(currentStart.value, 6)
  if (activePlan.value.date < currentStart.value || activePlan.value.date > end) closePlan()
})

// 日程保留日期与视图；任务创建归任务页，安排内可就地补建。
const recoverOpen = ref(false)

// —— 共享安排编辑器宿主（5A-1 §5/§7）：主按钮/日列＋安排/详情操作共用一个实例与提交逻辑 ——
const editor = ref(null)
const editorRef = ref(null)
let editorSeq = 0
const todayStr = computed(() => beijingDateStr(new Date(store.nowTick)))

// —— 结束回跳横幅（5A-2B §7）：只有当前空间读到匹配已结束记录才展示；结果取自持久会话，不从当前安排状态伪造 ——
const recordedId = computed(() => (typeof route.query.recorded === 'string' ? route.query.recorded : ''))
const recordedSession = computed(() =>
  (recordedId.value && focus.ready ? focus.sessions.find((s) => s.id === recordedId.value && s.ended_at != null) || null : null))
const recordedPlan = computed(() => {
  const s = recordedSession.value
  if (!s || !s.plan_item_id) return null
  return store.docs.find((d) => d.kind === 'plan_item' && d.id === s.plan_item_id) || null
})
const canArrangeAnother = computed(() => !!recordedPlan.value && recordedPlan.value.state === 'partial' && isLiveRef(recordedPlan.value))
const recordedRecordLink = computed(() =>
  (recordedSession.value ? recordPath(recordedSession.value.id, schedulePath(route.query, todayStr.value)) : ''))
function dismissRecorded() {
  const q = { ...route.query }
  delete q.recorded
  router.replace({ query: q })
}
function arrangeAnotherFromRecorded() {
  if (recordedPlan.value) openEditor({ mode: 'another', planId: recordedPlan.value.id })
}
// 来源周不包含目标安排时的定位说明（一次性标记，消费即移除，不进后续 return）。
watch(() => route.query.located, (v) => {
  if (v !== '1') return
  const q = { ...route.query }
  delete q.located
  router.replace({ query: q })
  store.say('info', '来源周不包含该安排，已定位到安排所在日期')
}, { immediate: true })
// 所有替换/重开/切目标入口先统一结算当前编辑器：脏草稿/待核实弹放弃确认，保存中禁止替换；
// 继续编辑保留原组件与草稿，明确放弃才换新表单（同页按钮重开不经过路由守卫，必须在这里结算）。
async function openEditor(cfg) {
  if (editor.value && editorRef.value && !(await editorRef.value.guardLeave())) return
  editorSeq += 1
  editor.value = { ...cfg, key: editorSeq }
}
// 保存/操作成功后定位目标日+卡片：date 与 plan 参数写入 URL，刷新/返回可恢复。
function locatePlan({ planId, date }) {
  const q = { ...route.query }
  if (date && date !== todayStr.value) q.date = date
  else delete q.date
  if (planId) q.plan = planId
  router.replace({ query: q })
}
function onPlanSaved(payload) {
  editor.value = null
  locatePlan(payload)
}
function closeWorkspace() { editor.value = null; closePlan() }
async function guardLeave() { return editorRef.value ? editorRef.value.guardLeave() : true }
const unregister = registerWorkLeave(guardLeave)
onBeforeUnmount(unregister)
onBeforeRouteLeave(requestWorkLeave)
onBeforeRouteUpdate(async (to, from) => {
  const allowed = await guardLeave()
  if (allowed && to.fullPath !== from.fullPath) editor.value = null
  return allowed
})
watch(() => store.workspaceId, () => { editor.value = null; resetWorkLeaveApproval() })
// 保留旧入口，但任务创建与筛选统一归任务页。
watch(() => route.query.create, (v) => { if (v === '1') router.replace('/tasks?create=1') }, { immediate: true })
watch(() => route.query.undated, (v) => { if (v === '1' && !route.query.plan && !route.query.task) router.replace('/tasks?undated=1') }, { immediate: true })
const plans = usePlanStore()
const classification = computed(() => plans.classify(new Date(store.nowTick)))
const followupQueues = computed(() => {
  const tasks = new Map(store.tasks.map(task => [task.id, task]))
  return [
    { list: 'unscheduled', label: '待安排', ids: classification.value.unscheduled },
    { list: 'past', label: '过去未完成', ids: classification.value.pastUnfinished.map(entry => entry.taskId) },
  ].map(queue => ({
    ...queue, count: queue.ids.length, tasks: queue.ids.slice(0, 3).map(id => tasks.get(id)).filter(Boolean),
  }))
})
const recentWork = computed(() => focus.ready ? endedSessionsSorted(focus.sessions).slice(0, 3) : [])
const hasQueue = computed(() => followupQueues.value.some(queue => queue.count > 0))
const pendingNoteCount = computed(() => store.noteBuckets.pending.length)
const recoverCount = computed(() =>
  (store.lastDeleted ? 1 : 0) + (store.pendingSave ? 1 : 0) + store.failedNotes.length,
)

// 旧 /today?task= 深链接兼容：转入同一任务详情，原周/选日/视图/无截止上下文作为返回路径保留。
watch(() => route.query.task, (id) => {
  if (typeof id !== 'string' || !id) return
  const q = { ...route.query }
  delete q.task
  const returnPath = router.resolve({ path: '/today', query: q }).fullPath
  router.replace({ path: '/tasks/' + id, query: { return: returnPath } })
}, { immediate: true })
async function retryFailed(note) {
  await store.runAnalysis(note.source_id, '')
}
async function openRecover() {
  recoverOpen.value = true
  await nextTick()
  const el = document.getElementById('recover')
  if (el) el.scrollIntoView({ block: 'nearest' })
}
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-5">
    <!-- 继续条：当前空间有未结束工作时出现，单一「回到工作」入口 -->
    <ContinueBar />

    <!-- 结束回跳横幅：真实已结束记录才展示；partial 安排提供「另安排一天」（复用共享编辑器） -->
    <Alert v-if="recordedSession" variant="success" dismiss-label="关闭工作保存提示" @dismiss="dismissRecorded">
      这次记录已保存<template v-if="recordedSession.outcome"> · 行动{{ label(SESSION_OUTCOME_LABELS, recordedSession.outcome) }}</template>。
      <RouterLink :to="recordedRecordLink" class="ml-1 underline">查看工作记录</RouterLink>
      <Button v-if="canArrangeAnother" size="sm" variant="outline" class="ml-2" @click="arrangeAnotherFromRecorded">另安排一天</Button>
    </Alert>

    <PlanWorkspace ref="editorRef" :editor="editor" :plan-id="planParam" @close="closeWorkspace" @saved="onPlanSaved"
      @edit="id => openEditor({ mode: 'edit', planId: id })" @move="id => openEditor({ mode: 'move', planId: id })"
      @another="id => openEditor({ mode: 'another', planId: id })" @op-done="locatePlan" />

    <div class="min-w-0">
      <WeekView :mode="view" :recorded-plan-id="recordedPlan?.id || ''" @add-plan="(date) => openEditor({ mode: 'create', date })">
        <template #tools>
          <RouterLink to="/work-records" class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border bg-card px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent" title="回看已结束的工作记录">
            <ClipboardList class="size-3.5" />工作记录
          </RouterLink>
          <div class="flex shrink-0 gap-0.5 rounded-md border bg-card p-0.5" role="group" aria-label="任务视图切换">
            <button
              type="button"
              class="min-h-9 w-16 whitespace-nowrap rounded px-2 py-1 text-sm font-medium"
              :class="view === 'week' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
              :aria-pressed="view === 'week'"
              @click="view = 'week'"
            >周视图</button>
            <button
              type="button"
              class="min-h-9 w-16 whitespace-nowrap rounded px-2 py-1 text-sm font-medium"
              :class="view === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
              :aria-pressed="view === 'list'"
              @click="view = 'list'"
            >列表</button>
          </div>
          <Button v-if="view === 'list'" variant="outline" class="shrink-0" @click="openEditor({ mode: 'create' })"><Plus />安排工作</Button>
        </template>
      </WeekView>

      <section v-if="store.ready && (hasQueue || recentWork.length || !store.tasks.length)" class="schedule-followup" aria-label="任务概览">
        <header v-if="hasQueue || !store.tasks.length" class="flex items-baseline justify-between gap-3">
          <h2 class="section-heading">待跟进</h2>
          <RouterLink to="/tasks" class="quiet-link">全部任务 →</RouterLink>
        </header>
        <div v-if="hasQueue" class="followup-columns">
          <section v-for="queue in followupQueues" :key="queue.list" class="followup-queue">
            <RouterLink :to="taskListPath({ list: queue.list })" class="queue-label">{{ queue.label }} <span>{{ queue.count }}</span></RouterLink>
            <ul v-if="queue.tasks.length" class="divide-y">
              <li v-for="task in queue.tasks" :key="task.id" class="flex items-center gap-1">
                <RouterLink class="queue-row min-w-0 flex-1" :to="taskPath(task.id, { return: schedulePath(route.query, todayStr) })">{{ task.title }} <ChevronRight v-if="queue.list !== 'unscheduled'" class="size-4 shrink-0" /></RouterLink>
                <Button v-if="queue.list === 'unscheduled'" size="sm" variant="ghost" :aria-label="'安排' + task.title" @click="openEditor({ mode: 'create', taskId: task.id, date: typeof route.query.date === 'string' && isValidDate(route.query.date) ? route.query.date : todayStr })"><Plus />安排</Button>
              </li>
            </ul>
          </section>
        </div>
        <div v-else-if="!store.tasks.length" class="schedule-start">
          <div><h3 class="font-medium">还没有任务</h3><p class="mt-1 text-sm text-muted-foreground">选一天手动安排，或用通知和截图生成计划。</p></div>
          <RouterLink to="/assistant" class="quiet-link">用资料制定计划 →</RouterLink>
        </div>
        <section v-if="recentWork.length" :class="hasQueue && 'mt-6'" aria-label="最近工作">
          <header class="flex items-baseline justify-between gap-3">
            <h2 class="section-heading">最近工作</h2>
          </header>
          <ul class="divide-y">
            <li v-for="record in recentWork" :key="record.id">
              <RouterLink class="block py-2.5 hover:text-primary" :to="recordPath(record.id, schedulePath(route.query, todayStr))">
                <span class="block break-words text-sm font-medium">{{ sessionActionText(record) || sessionTitle(record) || '工作记录' }}</span>
                <span class="text-xs text-muted-foreground">{{ beijingDateStr(new Date(record.ended_at)) }} · {{ formatDurationMs(record.accumulated_ms) }}</span>
              </RouterLink>
            </li>
          </ul>
        </section>
      </section>

    </div>

    <!-- 异常短提醒：只在有内容时出现，点击直达对应队列（携带 bucket，不被上次选中项覆盖） -->
    <div v-if="pendingNoteCount || store.failedNotes.length || recoverCount" class="flex flex-wrap items-center gap-2 text-sm">
      <RouterLink
        v-if="pendingNoteCount"
        to="/collect?status=pending"
        class="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 hover:bg-accent"
        :title="`${store.unconfirmedCount} 个字段待你核对确认`"
      >
        <Inbox class="size-3.5" />待核对
        <Badge variant="warning">{{ pendingNoteCount }}</Badge>
      </RouterLink>
      <RouterLink
        v-if="store.failedNotes.length"
        to="/collect?status=failed"
        class="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 hover:bg-accent"
      >
        <Inbox class="size-3.5" />分析失败
        <Badge variant="destructive">{{ store.failedNotes.length }}</Badge>
      </RouterLink>
      <button
        v-if="recoverCount"
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 hover:bg-accent"
        @click="openRecover"
      >
        <LifeBuoy class="size-3.5" />可恢复
        <Badge variant="secondary">{{ recoverCount }}</Badge>
      </button>
    </div>

    <!-- 恢复入口：默认折叠，异常提醒可直达；删除撤销/失败重试/暂存重落库的统一入口 -->
    <Card v-if="recoverCount || recoverOpen" id="recover">
      <template #header>
        <button class="flex w-full items-center justify-between text-base font-semibold" :aria-expanded="recoverOpen" @click="recoverOpen = !recoverOpen">
          <span>恢复入口<span v-if="recoverCount" class="ml-2 text-sm font-normal text-muted-foreground">{{ recoverCount }} 项可处理</span></span>
          <ChevronDown v-if="recoverOpen" class="size-4" />
          <ChevronRight v-else class="size-4" />
        </button>
      </template>
      <div v-if="recoverOpen" class="space-y-2">
        <div v-if="store.lastDeleted" class="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
          <span class="min-w-0 flex-1">
            最近删除：{{ store.lastDeleted.kind === 'note' ? store.lastDeleted.note.title : store.lastDeleted.kind === 'action' ? `行动「${store.lastDeleted.action.text}」` : store.lastDeleted.task.title }}
            <template v-if="store.lastDeleted.kind === 'note' && store.lastDeleted.tasks.length">（含 {{ store.lastDeleted.tasks.length }} 个关联任务）</template>
            <template v-else-if="store.lastDeleted.kind === 'task' && store.lastDeleted.actions && store.lastDeleted.actions.length">（含 {{ store.lastDeleted.actions.length }} 个行动）</template>
          </span>
          <Button size="sm" variant="outline" @click="store.undoDelete()">恢复</Button>
        </div>
        <div v-if="store.pendingSave" class="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
          <span class="min-w-0 flex-1">AI 结果暂存未落库（刷新不丢）。</span>
          <Button size="sm" variant="outline" @click="store.retrySave()">重试保存（不重调模型）</Button>
        </div>
        <div v-for="n in store.failedNotes" :key="n.id" class="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
          <span class="min-w-0 flex-1 truncate">分析失败：{{ n.title }}</span>
          <Button v-if="!store.isDemo" size="sm" variant="outline" :disabled="store.busy || store.aiDown" @click="retryFailed(n)">重试分析</Button>
          <RouterLink :to="`/notes/${n.id}?bucket=failed`" class="text-sm underline">查看</RouterLink>
        </div>
        <p v-if="!store.lastDeleted && !store.pendingSave && !store.failedNotes.length" class="text-sm text-muted-foreground">当前没有可恢复项。</p>
      </div>
    </Card>
    <button v-if="!recoverCount && !recoverOpen" type="button" class="text-xs text-muted-foreground hover:underline" @click="openRecover">恢复与撤销</button>
  </div>
</template>
