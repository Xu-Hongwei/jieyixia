<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { Plus } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import TaskListRows from '@/components/domain/TaskListRows.vue'
import TaskCreateForm from '@/components/domain/TaskCreateForm.vue'
import PlanWorkspace from '@/components/domain/PlanWorkspace.vue'
import { useAppStore } from '@/stores/app'
import { usePlanStore } from '@/stores/plan'
import { TASK_LIST_LABELS, cleanTaskListQuery, filterTaskList, taskListPath } from '@/domains/taskList'
import { taskPath } from '@/domains/workNavigation'
import { beijingDateStr } from '@/domains/time'
import { registerWorkLeave, requestWorkLeave, resetWorkLeaveApproval } from '@/composables/workLeave'

const app = useAppStore()
const plans = usePlanStore()
const route = useRoute()
const router = useRouter()
const filters = computed(() => cleanTaskListQuery(route.query))
const returnTo = computed(() => taskListPath(filters.value))
const classification = computed(() => plans.classify(new Date(app.nowTick)))
const rows = computed(() => filterTaskList(app.tasks, classification.value, filters.value))
const counts = computed(() => ({ all: app.tasks.length, unscheduled: classification.value.unscheduled.length, past: classification.value.pastUnfinished.length }))
const pastPlans = computed(() => filters.value.list === 'past' ? Object.fromEntries(classification.value.pastUnfinished.map((entry) => [entry.taskId, entry.planIds.map((id) => app.docs.find((d) => d.kind === 'plan_item' && d.id === id)).filter(Boolean)])) : {})
function setFilter(key, value) {
  router.replace({ path: '/tasks', query: cleanTaskListQuery({ ...route.query, [key]: value }) })
}
const search = computed({ get: () => typeof route.query.q === 'string' ? route.query.q : '', set: (value) => setFilter('q', value) })
const statusFilter = computed({ get: () => filters.value.status || 'all', set: (value) => setFilter('status', value) })
const matterFilter = computed({ get: () => filters.value.matter || '', set: (value) => setFilter('matter', value) })
const undatedFilter = computed({ get: () => filters.value.undated === '1', set: (value) => setFilter('undated', value ? '1' : '') })
const createOpen = ref(false)
const createRef = ref(null)
const editor = ref(null)
const editorRef = ref(null)
const detailId = ref('')
let editorKey = 0
async function guardLeave() {
  if (createRef.value && !(await createRef.value.guardLeave())) return false
  if (editorRef.value && !(await editorRef.value.guardLeave())) return false
  return true
}
// 当前任务页没有执行会话表单，复用离开协调器，保护空间切换及路由离开。
const unregister = registerWorkLeave(guardLeave)
onBeforeUnmount(unregister)
onBeforeRouteLeave(requestWorkLeave)
onBeforeRouteUpdate(async (to, from) => {
  const allowed = await guardLeave()
  if (allowed && to.fullPath !== from.fullPath) { editor.value = null; detailId.value = '' }
  return allowed
})
watch(() => app.workspaceId, () => { createOpen.value = false; editor.value = null; detailId.value = ''; resetWorkLeaveApproval() })
async function openCreate() {
  if (!(await guardLeave())) return
  editor.value = null; detailId.value = ''; createOpen.value = true
  await nextTick()
  const input = document.querySelector('[aria-label="新任务名称"]')
  if (input instanceof HTMLElement) input.focus()
}
async function openEditor(config) {
  if (!(await guardLeave())) return
  createOpen.value = false; detailId.value = ''
  editor.value = { ...config, key: ++editorKey }
}
async function openPlan({ planId }) {
  if (!(await guardLeave())) return
  editor.value = null; createOpen.value = false; detailId.value = planId
}
function onCreated(id) {
  createOpen.value = false
  router.push(taskPath(id, { return: returnTo.value }))
}
function onPlanSaved({ planId }) { editor.value = null; detailId.value = planId }
watch(() => route.query.create, async (value) => {
  if (value !== '1') return
  await openCreate()
  const query = { ...route.query }; delete query.create
  await router.replace({ query })
}, { immediate: true })
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-5">
    <header class="flex items-center justify-between gap-3"><h1 class="text-xl font-semibold">任务</h1><Button :aria-expanded="createOpen" @click="openCreate"><Plus />新建任务</Button></header>
    <TaskCreateForm v-if="createOpen" :key="app.workspaceId" ref="createRef" @saved="onCreated" @close="createOpen = false" />
    <PlanWorkspace ref="editorRef" :editor="editor" :plan-id="detailId" @close="editor = null; detailId = ''" @saved="onPlanSaved"
      @edit="id => openEditor({ mode: 'edit', planId: id })" @move="id => openEditor({ mode: 'move', planId: id })"
      @another="id => openEditor({ mode: 'another', planId: id })" @op-done="onPlanSaved" />
    <section class="rounded-lg border bg-card p-4 sm:p-5" aria-label="任务列表">
      <div class="flex flex-wrap gap-1 border-b pb-3" aria-label="任务清单分类">
        <button v-for="(label, key) in TASK_LIST_LABELS" :key="key" type="button" class="rounded-md px-3 py-2 text-sm" :class="(filters.list || 'all') === key ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-muted'" :aria-pressed="(filters.list || 'all') === key" @click="setFilter('list', key)">{{ label }} <span class="ml-1 tabular-nums">{{ counts[key] }}</span></button>
      </div>
      <div class="flex flex-wrap items-end gap-3 py-4">
        <label class="min-w-40 flex-1 space-y-1 text-xs text-muted-foreground"><span>搜索</span><Input v-model="search" aria-label="搜索任务" placeholder="任务名称" /></label>
        <label class="space-y-1 text-xs text-muted-foreground"><span class="block">状态</span><select v-model="statusFilter" aria-label="状态筛选" class="h-9 rounded-md border bg-transparent px-2 text-sm text-foreground"><option value="all">全部状态</option><option value="open">未完成</option><option value="done">已完成</option></select></label>
        <label class="min-w-0 max-w-full space-y-1 text-xs text-muted-foreground"><span class="block">事项</span><select v-model="matterFilter" aria-label="事项筛选" class="h-9 max-w-full rounded-md border bg-transparent px-2 text-sm text-foreground"><option value="">全部事项</option><option value="ungrouped">未归组</option><option v-for="item in app.matters" :key="item.id" :value="item.id">{{ item.title }}</option></select></label>
        <label class="flex h-9 items-center gap-2 text-sm"><input type="checkbox" v-model="undatedFilter" />仅无截止</label>
      </div>
      <p class="text-xs text-muted-foreground" aria-live="polite">{{ rows.length }} 项任务</p>
      <TaskListRows :tasks="rows" :now="app.nowTick" :return-to="returnTo" :past-plans="pastPlans" @arrange="task => openEditor({ mode: 'create', taskId: task.id, date: beijingDateStr(new Date(app.nowTick)) })" @open-plan="openPlan" />
      <p v-if="!rows.length" class="py-8 text-center text-sm text-muted-foreground">{{ app.tasks.length ? '没有符合条件的任务' : '还没有任务，点击「新建任务」开始' }}</p>
    </section>
  </div>
</template>

