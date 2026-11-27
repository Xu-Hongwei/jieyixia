<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { Plus } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import TaskListRows from '@/components/domain/TaskListRows.vue'
import TaskCreateForm from '@/components/domain/TaskCreateForm.vue'
import ProjectForm from '@/components/domain/ProjectForm.vue'
import PlanWorkspace from '@/components/domain/PlanWorkspace.vue'
import { useAppStore } from '@/stores/app'
import { usePlanStore } from '@/stores/plan'
import { TASK_LIST_LABELS, cleanTaskListQuery, filterTaskList, projectTaskGroups, taskListPath } from '@/domains/taskList'
import { label, MATTER_ROLE_LABELS } from '@/domains/labels'
import { taskPath } from '@/domains/workNavigation'
import { beijingDateStr, formatWhen } from '@/domains/time'
import { registerWorkLeave, requestWorkLeave, resetWorkLeaveApproval } from '@/composables/workLeave'

const app = useAppStore()
const plans = usePlanStore()
const route = useRoute()
const router = useRouter()
const filters = computed(() => cleanTaskListQuery(route.query))
const returnTo = computed(() => taskListPath(filters.value))
const classification = computed(() => plans.classify(new Date(app.nowTick)))
const rows = computed(() => filterTaskList(app.tasks, classification.value, filters.value))
const groups = computed(() => projectTaskGroups(app.matters, app.tasks, rows.value, app.notes, filters.value))
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
const createMatterId = ref('')
const projectEditor = ref(null)
const projectRef = ref(null)
const editor = ref(null)
const editorRef = ref(null)
const detailId = ref('')
let editorKey = 0
async function guardLeave() {
  if (projectRef.value && !(await projectRef.value.guardLeave())) return false
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
  if (allowed && to.fullPath !== from.fullPath) { editor.value = null; detailId.value = ''; projectEditor.value = null }
  return allowed
})
watch(() => app.workspaceId, () => { createOpen.value = false; editor.value = null; detailId.value = ''; projectEditor.value = null; resetWorkLeaveApproval() })
async function openProject(project = null) {
  if (!(await guardLeave())) return
  editor.value = null; createOpen.value = false; detailId.value = ''
  projectEditor.value = { project, key: ++editorKey }
  await nextTick()
  const input = document.querySelector('[aria-label="项目名称"]')
  if (input instanceof HTMLElement) input.focus()
}
function projectDeleted(id) {
  projectEditor.value = null
  if (filters.value.matter === id) setFilter('matter', '')
}
async function openCreate(projectId = filters.value.matter) {
  if (!(await guardLeave())) return
  projectEditor.value = null
  createMatterId.value = app.matters.some(m => m.id === projectId) ? projectId : ''
  editor.value = null; detailId.value = ''; createOpen.value = true
  await nextTick()
  const input = document.querySelector('[aria-label="新任务名称"]')
  if (input instanceof HTMLElement) input.focus()
}
async function openEditor(config) {
  if (!(await guardLeave())) return
  projectEditor.value = null
  createOpen.value = false; detailId.value = ''
  editor.value = { ...config, key: ++editorKey }
}
async function openPlan({ planId }) {
  if (!(await guardLeave())) return
  projectEditor.value = null
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
    <header class="flex flex-wrap items-center justify-between gap-3"><h1 class="workspace-title">任务</h1><div class="flex gap-2"><Button variant="outline" @click="openProject()">新建项目</Button><Button :aria-expanded="createOpen" @click="openCreate()"><Plus />新建任务</Button></div></header>
    <ProjectForm v-if="projectEditor" :key="projectEditor.key" ref="projectRef" :project="projectEditor.project" @close="projectEditor = null" @saved="id => { projectEditor = null; router.replace(taskListPath({ matter: id })) }" @deleted="projectDeleted" />
    <TaskCreateForm v-if="createOpen" :key="app.workspaceId + createMatterId" ref="createRef" :initial-matter="createMatterId" @saved="onCreated" @close="createOpen = false" />
    <PlanWorkspace ref="editorRef" :editor="editor" :plan-id="detailId" @close="editor = null; detailId = ''" @saved="onPlanSaved"
      @edit="id => openEditor({ mode: 'edit', planId: id })" @move="id => openEditor({ mode: 'move', planId: id })"
      @another="id => openEditor({ mode: 'another', planId: id })" @op-done="onPlanSaved" />
    <section class="task-index" aria-label="任务列表">
      <div class="index-tabs flex flex-wrap" aria-label="任务清单分类">
        <button v-for="(label, key) in TASK_LIST_LABELS" :key="key" type="button" class="rounded-md px-3 py-2 text-sm" :class="(filters.list || 'all') === key ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-muted'" :aria-pressed="(filters.list || 'all') === key" @click="setFilter('list', key)">{{ label }} <span class="ml-1 tabular-nums">{{ counts[key] }}</span></button>
      </div>
      <div class="task-index-body"><div class="task-filters">
        <label class="min-w-40 flex-1 space-y-1 text-xs text-muted-foreground"><span>搜索</span><Input v-model="search" aria-label="搜索任务" placeholder="任务名称" /></label>
        <label class="space-y-1 text-xs text-muted-foreground"><span class="block">状态</span><select v-model="statusFilter" aria-label="状态筛选" class="h-9 rounded-md border bg-transparent px-2 text-sm text-foreground"><option value="all">全部状态</option><option value="open">未完成</option><option value="done">已完成</option></select></label>
        <label class="min-w-0 max-w-full space-y-1 text-xs text-muted-foreground">
          <span class="block">任务归属</span>
          <select v-model="matterFilter" aria-label="任务归属" class="h-9 max-w-full rounded-md border bg-transparent px-2 text-sm text-foreground">
            <option value="">全部任务</option>
            <option value="ungrouped">未归入项目</option>
            <optgroup v-if="app.matters.length" label="具体项目">
              <option v-for="item in app.matters" :key="item.id" :value="item.id">{{ item.title }}</option>
            </optgroup>
          </select>
        </label>
        <label class="flex h-9 items-center gap-2 text-sm"><input type="checkbox" v-model="undatedFilter" />仅无截止</label>
      </div>
      <div class="task-results"><p class="text-xs text-muted-foreground" aria-live="polite">{{ rows.length }} 项任务</p>
      <article v-for="group in groups" :key="group.id" class="mt-4 min-w-0 rounded-lg border bg-card px-4 py-3">
        <header class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 space-y-1">
            <h2 class="break-words text-lg font-semibold">{{ group.project?.title || '独立任务' }}</h2>
            <div class="flex flex-wrap items-center gap-3 text-xs">
              <strong v-if="group.project?.deadline?.value" class="rounded bg-accent px-2 py-1 text-foreground">项目总截止 · {{ formatWhen(group.project.deadline.value, group.project.deadline.precision) }}</strong>
              <span v-else-if="group.project" class="text-muted-foreground">未设总截止</span>
              <span v-if="group.total" class="text-muted-foreground">已完成 {{ group.done }}/{{ group.total }} 项任务</span>
            </div>
          </div>
          <div v-if="group.project" class="flex flex-wrap gap-1"><Button size="sm" variant="ghost" @click="openProject(group.project)">编辑项目</Button><Button size="sm" variant="outline" @click="openCreate(group.id)">添加任务</Button></div>
        </header>
        <TaskListRows :tasks="group.tasks" :now="app.nowTick" :return-to="returnTo" :past-plans="pastPlans" :in-project="!!group.project" @arrange="task => openEditor({ mode: 'create', taskId: task.id, date: beijingDateStr(new Date(app.nowTick)) })" @open-plan="openPlan" />
        <p v-if="!group.total" class="py-3 text-sm text-muted-foreground">项目内还没有任务</p>
        <details v-if="group.notes.length" class="border-t pt-2 text-sm"><summary class="cursor-pointer">关联资料 · {{ group.notes.length }}</summary><div v-for="note in group.notes" :key="note.id" class="flex flex-wrap items-center gap-2 py-1"><RouterLink :to="'/notes/' + note.id" class="break-words underline">{{ note.title }}</RouterLink><span v-if="note.matter_role" class="text-xs text-muted-foreground">{{ label(MATTER_ROLE_LABELS, note.matter_role) }}</span></div></details>
      </article>
      <p v-if="!groups.length" class="py-8 text-center text-sm text-muted-foreground">{{ Object.keys(filters).length ? '没有符合条件的任务' : '还没有任务，可新建项目或直接创建任务' }}</p>
      </div></div>
    </section>
  </div>
</template>

