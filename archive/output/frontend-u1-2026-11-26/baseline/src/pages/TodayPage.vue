<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { onBeforeRouteLeave, RouterLink, useRoute, useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, ClipboardList, Inbox, LifeBuoy, Plus } from 'lucide-vue-next'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Input from '@/components/ui/Input.vue'
import ContinueBar from '@/components/domain/ContinueBar.vue'
import NodeSelect from '@/components/domain/NodeSelect.vue'
import PlanDetail from '@/components/domain/PlanDetail.vue'
import PlanEditor from '@/components/domain/PlanEditor.vue'
import TaskListsPanel from '@/components/domain/TaskListsPanel.vue'
import WeekView from '@/components/domain/WeekView.vue'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { isLiveRef } from '@/domains/plan'
import { SESSION_OUTCOME_LABELS, label } from '@/domains/labels'
import { recordPath, schedulePath } from '@/domains/workNavigation'
import { beijingAddDays, beijingDateStr, interpretInstant, isValidDate } from '@/domains/time'
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

// 工具栏只常驻日期、视图切换与一个新建入口；其余按需展开。
const createOpen = ref(false)
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
function onGotoCreateTask() {
  editor.value = null
  createOpen.value = true
  nextTick(() => {
    const el = document.querySelector('[aria-label="新任务名称"]')
    if (el instanceof HTMLElement) el.focus()
  })
}
// 其它页（任务详情）编辑器里「先创建任务」跨页交接：create=1 打开新建面板并聚焦，参数随即移除。
watch(() => route.query.create, (v) => {
  if (v !== '1') return
  const q = { ...route.query }
  delete q.create
  router.replace({ query: q })
  onGotoCreateTask()
}, { immediate: true })
onBeforeRouteLeave(async () => (editorRef.value ? editorRef.value.guardLeave() : true))

const taskTitle = ref('')
const taskDeadline = ref('')
const taskMatter = ref('')

const matterItems = computed(() => [
  { value: '', label: '未归组' },
  ...store.matters.map((m) => ({ value: m.id, label: m.title })),
])
const pendingNoteCount = computed(() => store.noteBuckets.pending.length)
const recoverCount = computed(() =>
  (store.lastDeleted ? 1 : 0) + (store.pendingSave ? 1 : 0) + store.failedNotes.length,
)

async function createTask() {
  const r = await store.createStandaloneTask({ title: taskTitle.value, value: taskDeadline.value, matterId: taskMatter.value || null })
  if (r && r.ok) {
    taskTitle.value = ''
    taskDeadline.value = ''
    createOpen.value = false
    locateTask(r.id)
  }
}
// 新建成功后立即定位到结果：进入统一任务详情，返回上下文指向它所在的周/日期（无截止 → 无截止清单）。
function locateTask(id) {
  const t = store.tasks.find((x) => x.id === id)
  if (!t) return
  const q = { view: 'week' }
  const ms = t.deadline && t.deadline.value ? interpretInstant(t.deadline.value) : null
  if (ms != null) q.date = beijingDateStr(new Date(ms))
  else q.undated = '1'
  const returnPath = router.resolve({ path: '/today', query: q }).fullPath
  router.push({ path: '/tasks/' + id, query: { return: returnPath } })
}
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
function openRecover() {
  recoverOpen.value = true
  const el = document.getElementById('recover')
  if (el) el.scrollIntoView({ block: 'nearest' })
}
</script>

<template>
  <div class="space-y-4">
    <!-- 工具栏：日期 + 视图切换 + 一个新建入口。窄屏控制组整组换行、组内再按控件换行；
         每个控件不收缩、文字不断行，避免 360px 下被挤成单字竖排。 -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="font-date whitespace-nowrap text-lg font-semibold">
        {{ store.todayLabel }}<span class="ml-1.5 font-sans text-xs font-normal text-muted-foreground">北京时间</span>
      </div>
      <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
        <RouterLink to="/work-records" class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent" title="回看已结束的工作记录">
          <ClipboardList class="size-3.5" />工作记录
        </RouterLink>
        <div class="flex shrink-0 gap-0.5 rounded-md border bg-card p-0.5" role="group" aria-label="任务视图切换">
          <button
            type="button"
            class="w-14 whitespace-nowrap rounded px-2 py-1 text-xs font-medium"
            :class="view === 'week' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
            :aria-pressed="view === 'week'"
            @click="view = 'week'"
          >周视图</button>
          <button
            type="button"
            class="w-14 whitespace-nowrap rounded px-2 py-1 text-xs font-medium"
            :class="view === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'"
            :aria-pressed="view === 'list'"
            @click="view = 'list'"
          >列表</button>
        </div>
        <Button variant="outline" class="shrink-0" @click="openEditor({ mode: 'create' })"><Plus />安排工作</Button>
        <Button class="shrink-0" :aria-expanded="createOpen" @click="createOpen = !createOpen"><Plus />新建</Button>
      </div>
    </div>

    <!-- 继续条：当前空间有未结束工作时出现，单一「回到工作」入口 -->
    <ContinueBar />

    <!-- 异常短提醒：只在有内容时出现，点击直达对应队列（携带 bucket，不被上次选中项覆盖） -->
    <div v-if="pendingNoteCount || store.failedNotes.length || recoverCount" class="flex flex-wrap items-center gap-2 text-sm">
      <RouterLink
        v-if="pendingNoteCount"
        to="/notes?bucket=pending"
        class="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 hover:bg-accent"
        :title="`${store.unconfirmedCount} 个字段待你核对确认`"
      >
        <Inbox class="size-3.5" />待核对
        <Badge variant="warning">{{ pendingNoteCount }}</Badge>
      </RouterLink>
      <RouterLink
        v-if="store.failedNotes.length"
        to="/notes?bucket=failed"
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

    <!-- 结束回跳横幅：真实已结束记录才展示；partial 安排提供「另安排一天」（复用共享编辑器） -->
    <Alert v-if="recordedSession" variant="success">
      这次记录已保存<template v-if="recordedSession.outcome"> · 行动{{ label(SESSION_OUTCOME_LABELS, recordedSession.outcome) }}</template>。
      <RouterLink :to="recordedRecordLink" class="ml-1 underline">查看工作记录</RouterLink>
      <Button v-if="canArrangeAnother" size="sm" variant="outline" class="ml-2" @click="arrangeAnotherFromRecorded">另安排一天</Button>
      <button type="button" class="ml-2 text-xs underline" @click="dismissRecorded">知道了</button>
    </Alert>

    <!-- 新建任务面板：按需展开 -->
    <Card v-if="createOpen">
      <div class="flex flex-wrap items-center gap-2">
        <Input v-model="taskTitle" placeholder="新任务名称…" class="min-w-40 flex-1" aria-label="新任务名称" />
        <DateInput v-model="taskDeadline" allow-time placeholder="截止（可选）" class="max-w-48" />
        <div class="w-28"><NodeSelect v-model="taskMatter" :items="matterItems" placeholder="未归组" /></div>
        <Button @click="createTask"><Plus />新建任务</Button>
      </div>
      <p class="mt-2 text-xs text-muted-foreground">独立新建任务，可不填截止。事项在<RouterLink to="/collect" class="underline">资料库</RouterLink>管理；从便签带出处建任务请到待核对。</p>
    </Card>

    <!-- 共享安排编辑器：四模式同一实例；key 保证每次打开重读初值（含北京今天） -->
    <PlanEditor
      v-if="editor"
      :key="editor.key"
      ref="editorRef"
      :mode="editor.mode"
      :plan-id="editor.planId || ''"
      :task-id="editor.taskId || ''"
      :date="editor.date || ''"
      :lock-task="!!editor.locked"
      @close="editor = null"
      @saved="onPlanSaved"
      @goto-create-task="onGotoCreateTask"
    />

    <!-- 安排详情面板：URL plan 参数驱动；关闭回到同周同日的列表 -->
    <PlanDetail
      v-if="planParam"
      :plan-id="planParam"
      @close="closePlan"
      @edit="(id) => openEditor({ mode: 'edit', planId: id })"
      @move="(id) => openEditor({ mode: 'move', planId: id })"
      @another="(id) => openEditor({ mode: 'another', planId: id })"
      @op-done="locatePlan"
    />

    <WeekView :mode="view" @add-plan="(date) => openEditor({ mode: 'create', date })" />

    <!-- 待安排/过去未完成/全部任务：三入口共享一个展开区（§9），安排入口复用同一编辑器 -->
    <TaskListsPanel
      @arrange="(cfg) => openEditor({ mode: 'create', taskId: cfg.taskId, date: cfg.date, locked: true })"
      @open-plan="locatePlan"
    />

    <!-- 恢复入口：默认折叠，异常提醒可直达；删除撤销/失败重试/暂存重落库的统一入口 -->
    <Card id="recover">
      <template #header>
        <button class="flex w-full items-center justify-between text-base font-semibold" :aria-expanded="recoverOpen" @click="recoverOpen = !recoverOpen">
          <span>恢复入口<span v-if="recoverCount" class="ml-2 text-sm font-normal text-muted-foreground">{{ recoverCount }} 项可处理</span></span>
          <ChevronDown v-if="recoverOpen" class="size-4" />
          <ChevronRight v-else class="size-4" />
        </button>
        <p v-if="recoverOpen" class="text-sm text-muted-foreground">失败重试、暂存重落库、撤销最近删除。原始资料始终保留在本地。</p>
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
          <Button size="sm" variant="outline" :disabled="store.busy || store.aiDown" @click="retryFailed(n)">重试分析</Button>
          <RouterLink :to="`/notes/${n.id}?bucket=failed`" class="text-sm underline">查看</RouterLink>
        </div>
        <p v-if="!store.lastDeleted && !store.pendingSave && !store.failedNotes.length" class="text-sm text-muted-foreground">当前没有可恢复项。</p>
      </div>
    </Card>
  </div>
</template>