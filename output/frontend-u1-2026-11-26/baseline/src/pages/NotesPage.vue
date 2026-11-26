<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, ChevronDown, ChevronRight, PanelRight, RefreshCw } from 'lucide-vue-next'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import DateInput from '@/components/ui/DateInput.vue'
import NodeSelect from '@/components/domain/NodeSelect.vue'
import Separator from '@/components/ui/Separator.vue'
import FieldCard from '@/components/domain/FieldCard.vue'
import DeleteImpact from '@/components/domain/DeleteImpact.vue'
import { useAppStore } from '@/stores/app'
import { getSource } from '@/services/storage/db'
import { CONTENT_TYPE_LABELS, FIELD_LABELS, MATTER_ROLE_LABELS, STATUS_LABELS, label } from '@/domains/labels'
import { BUCKET_LABELS, BUCKET_ORDER, isSharedTask, linkedTasksOf, noteBucket, pendingFields } from '@/domains/organize'
import { MATTER_ROLES, deleteImpactSnapshot } from '@/domains/matter'
import { beijingDateStr, beijingInstantLabel, interpretInstant } from '@/domains/time'

const store = useAppStore()
const route = useRoute()
const router = useRouter()
const manualDeadline = ref('')
const referenceAt = ref('')
const evidenceSource = ref(null)
// 已确认默认收起，待核对/失败默认展开；带 bucket 进入时只展开该队列。
const collapsed = ref(/** @type {Record<string, boolean>} */ ({ confirmed: true }))
const deleteOpen = ref(false)
const noteScopeNotice = ref(false)
// 手机以当前资料为主：队列与更多操作按需展开。
const queueOpen = ref(false)
const moreOpen = ref(false)
// 建任务成功后不强制离开：留在便签上提供「查看任务 / 核对下一条」。
const createdTask = ref(null)

const bucketQuery = computed(() =>
  typeof route.query.bucket === 'string' && BUCKET_ORDER.includes(route.query.bucket) ? route.query.bucket : null,
)
// 返回上下文：从任务详情来 → 回到统一任务详情（透传其原列表 return）；从资料库来 → 回到原筛选列表。
const backTaskLink = computed(() => {
  if (route.query.from !== 'task' || typeof route.query.task !== 'string') return null
  const q = typeof route.query.return === 'string' ? { return: route.query.return } : {}
  return { path: '/tasks/' + route.query.task, query: q }
})
const backCollectPath = computed(() => {
  if (route.query.from !== 'collect' || typeof route.query.return !== 'string') return null
  return route.query.return.startsWith('/collect') ? route.query.return : null
})

const statusVariant = { draft: 'warning', reviewed: 'success', failed: 'destructive' }
const reviewClear = computed(() => store.ready && !store.noteBuckets.pending.length && !store.noteBuckets.failed.length)
const hasConfirmedDeadline = computed(() =>
  !!store.selectedNote && store.selectedNote.fields.some((f) => f.key === 'deadline' && f.status === 'confirmed' && f.value != null),
)
// 联删影响面与确认框同源：note_ids ∪ deadline.from_note_id，按任务 ID 去重；行动随任务同批删除。
const affectedTasks = computed(() => (store.selectedNote ? linkedTasksOf(store.tasks, store.selectedNote.id) : []))
const affectedActions = computed(() => {
  const ids = new Set(affectedTasks.value.map((t) => t.id))
  return store.actions.filter((a) => ids.has(a.task_id))
})
const unconfirmed = computed(() => (store.selectedNote ? pendingFields(store.selectedNote) : []))
const matterItems = computed(() => [
  { value: '', label: '未归组' },
  ...store.matters.map((m) => ({ value: m.id, label: m.title })),
])
const noteMatter = computed({
  get: () => (store.selectedNote && store.selectedNote.matter_id) || '',
  set: (v) => { if (store.selectedNote) store.setMatter(store.selectedNote, v || null) },
})
const roleItems = computed(() => [
  { value: '', label: '未指定角色' },
  ...MATTER_ROLES.map((r) => ({ value: r, label: label(MATTER_ROLE_LABELS, r) })),
])
const noteRole = computed({
  get: () => (store.selectedNote && store.selectedNote.matter_role) || '',
  set: (v) => { if (store.selectedNote) store.setNoteRole(store.selectedNote, v || null) },
})

// 下一步随状态变化：失败→重试；有待确认→继续核对；草稿→审阅；截止已确认→建任务；否则手动截止。
const nextStep = computed(() => {
  const n = store.selectedNote
  if (!n) return null
  if (n.status === 'failed') return { kind: 'retry', label: '重试分析', hint: '分析失败，原始资料保留；重试会重新调用模型。' }
  if (unconfirmed.value.length) return { kind: 'confirm', label: `继续核对 · ${unconfirmed.value.length} 项`, hint: '逐项对照原文引用确认；确认后才可带入任务。' }
  if (n.status === 'draft') return { kind: 'review', label: '标记已审阅', hint: '字段已全部确认；审阅不改变字段事实。' }
  if (hasConfirmedDeadline.value) return { kind: 'create', label: '创建任务', hint: '截止已确认，可带出处建任务。' }
  return { kind: 'manual', label: '手动截止建任务', hint: '没有已确认的截止；可手动输入截止建任务。' }
})
const nextDisabled = computed(() => nextStep.value && nextStep.value.kind === 'retry' && (store.busy || store.aiDown))
// 核对下一条：当前队列（URL bucket 优先，否则按便签实际分组）里的下一条，仅导航不改字段。
const nextNote = computed(() => {
  const n = store.selectedNote
  if (!n) return null
  const b = bucketQuery.value || noteBucket(n)
  const list = store.noteBuckets[b]
  const i = list.findIndex((x) => x.id === n.id)
  if (i === -1) return list[0] || null
  return list[i + 1] || null
})
function focusFirstUnconfirmed() {
  const el = document.querySelector('[data-unconfirmed="true"]')
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  const btn = el.querySelector('button')
  if (btn) btn.focus()
}
async function runNext() {
  const s = nextStep.value
  if (!s) return
  if (s.kind === 'retry') return reanalyze()
  if (s.kind === 'confirm') return focusFirstUnconfirmed()
  if (s.kind === 'review') return store.reviewNote(store.selectedNote)
  if (s.kind === 'create') return createTask()
  moreOpen.value = true
  nextTick(() => {
    const el = /** @type {HTMLElement | null} */ (document.querySelector('[aria-label="手动截止"]'))
    if (el) el.focus()
  })
}

function toggleBucket(b) {
  collapsed.value = { ...collapsed.value, [b]: !collapsed.value[b] }
}
// 工作台内移动（队列切换/核对下一条）只替换对象与队列条件，保留受控来源上下文，
// 「返回任务 / 返回资料库」不因切换资料而消失。
const CONTEXT_KEYS = ['from', 'return', 'task', 'date', 'view', 'undated']
function noteQuery(b) {
  const q = { bucket: b }
  for (const k of CONTEXT_KEYS) if (typeof route.query[k] === 'string') q[k] = route.query[k]
  return q
}
function openQueueNote(n, b) {
  router.push({ path: '/notes/' + n.id, query: noteQuery(b) })
}
// §10：打开时冻结联删影响（关联任务 ∪ 行动 ∪ 安排处置），提交原快照；
// 范围/处置变化 → 不删除，刷新后重新冻结、重新确认。
const deleteFacts = ref(null)
const deleteBlocked = computed(() => !!deleteFacts.value && deleteFacts.value.rows.some((r) => r.disposition.startsWith('blocked')))
function freezeDeleteFacts() {
  const taskIds = affectedTasks.value.map((t) => t.id)
  const snap = deleteImpactSnapshot(store.docs, taskIds, store.docs.filter((d) => d.kind === 'focus_session'))
  deleteFacts.value = { taskIds, actionIds: affectedActions.value.map((a) => a.id), ...snap }
}
function openDeleteNote() {
  noteScopeNotice.value = false
  freezeDeleteFacts()
  deleteOpen.value = true
}
async function confirmDelete() {
  const target = store.selectedNote
  const frozen = deleteFacts.value
  if (!target || !frozen) { deleteOpen.value = false; return }
  deleteOpen.value = false
  const r = await store.deleteNote(target, {
    taskIds: frozen.taskIds, actionIds: frozen.actionIds, planItemIds: frozen.planItemIds, planFacts: frozen.planFacts,
  })
  if (r && (r.scopeChanged || r.planProgressRequired || r.unfinishedFocus)) {
    await store.reloadDocs()
    noteScopeNotice.value = true
    freezeDeleteFacts()
    deleteOpen.value = true
  }
}
function deleteGotoPlan(r) {
  deleteOpen.value = false
  router.push({ path: '/today', query: { date: r.date, plan: r.id } })
}
function deleteGotoWork(r) {
  deleteOpen.value = false
  router.push('/work/' + r.unfinishedSessionId)
}

// 对象深链接校验：等 store.ready 再判断，避免初始化期间误报「不存在」。
// 已打开过的便签被删除 → 静默回队列；直接深链接到无效对象 → 提示后回队列。
let hadNote = false
watch(() => route.params.id, (id, oldId) => {
  hadNote = false
  createdTask.value = null
  if (oldId && id !== oldId) {
    // 切换/离开资料：页面级草稿（手动截止/参照日期）重置；未保存的字段编辑明确告知已丢弃。
    // 此 watch 先于重渲染执行，DOM 里仍是上一份资料的编辑态标记。
    if (document.querySelector('[data-editing="true"]')) {
      store.say('warning', '已离开原资料：未保存的编辑已丢弃，不会写入其他资料')
    }
    manualDeadline.value = ''
    referenceAt.value = ''
  }
})
watch(() => store.selectedNote, (n) => { if (n) hadNote = true })
watch([() => store.ready, () => route.params.id, () => store.notes], () => {
  if (!store.ready) return
  const id = route.params.id
  if (!id) return
  if (store.notes.some((n) => n.id === id)) {
    if (store.selectedNoteId !== id) store.selectNote(id)
    return
  }
  if (!hadNote) store.say('warning', '便签已不存在或不属于当前空间，已回到队列')
  hadNote = false
  router.replace({ path: '/notes', query: bucketQuery.value ? { bucket: bucketQuery.value } : {} })
}, { immediate: true })

// 队列入口：带 bucket 进入只选中该队列第一条（空队列不选中），绝不带上次看的便签；
// 裸入口（主导航「待核对」）默认进待处理队列：优先 pending，无则 failed，否则显示已清空——
// 不恢复上次选中（可能是已确认资料）。已确认资料的深链接仍从资料库可达。
watch([() => store.ready, bucketQuery, () => route.params.id], () => {
  if (!store.ready) return
  const b = bucketQuery.value
  if (b) collapsed.value = { pending: b !== 'pending', failed: b !== 'failed', confirmed: b !== 'confirmed' }
  if (route.params.id) return
  if (b) {
    const first = store.noteBuckets[b][0] || null
    if (first ? store.selectedNoteId !== first.id : !!store.selectedNoteId) store.selectNote(first ? first.id : null)
  } else {
    const def = store.noteBuckets.pending.length ? 'pending' : store.noteBuckets.failed.length ? 'failed' : null
    if (def) router.replace({ path: '/notes', query: { bucket: def } })
    else if (store.selectedNoteId) store.selectNote(null)
  }
}, { immediate: true })

watch(() => store.selectedNote, async (n) => {
  const res = n && n.source_id ? await getSource(n.source_id) : null
  // 晚到的原空间读取不显示到新空间（S1 归属守卫）。
  evidenceSource.value = res && res.workspace_id === store.workspaceId ? res.record || null : null
  moreOpen.value = false
  queueOpen.value = false
}, { immediate: true })
// 切换工作区清空本页手动截止/参照草稿，避免把上一空间的输入带进新空间。
watch(() => store.workspaceId, () => {
  manualDeadline.value = ''
  referenceAt.value = ''
  createdTask.value = null
})

async function createTask() {
  const result = await store.createTask(store.selectedNote)
  if (result && result.ok) createdTask.value = { id: result.id }
}
async function createManual() {
  const result = await store.createTaskManual(store.selectedNote, manualDeadline.value)
  if (result && result.ok) {
    manualDeadline.value = ''
    createdTask.value = { id: result.id }
  }
}
const createdTaskObj = computed(() => (createdTask.value ? store.tasks.find((t) => t.id === createdTask.value.id) || null : null))
// 查看任务：进入统一任务详情，返回上下文定位到它所在的周/日期；无截止 → 周视图的无截止清单。
function goCreatedTask() {
  const t = createdTaskObj.value
  if (!t) {
    store.say('warning', '任务已不存在，可能已被删除')
    createdTask.value = null
    return
  }
  const q = { view: 'week' }
  const ms = t.deadline && t.deadline.value ? interpretInstant(t.deadline.value) : null
  if (ms != null) q.date = beijingDateStr(new Date(ms))
  else q.undated = '1'
  const returnPath = router.resolve({ path: '/today', query: q }).fullPath
  router.push({ path: '/tasks/' + t.id, query: { return: returnPath } })
}
function goNextNote() {
  const n = nextNote.value
  if (!n) return
  createdTask.value = null
  router.push({ path: '/notes/' + n.id, query: noteQuery(bucketQuery.value || noteBucket(n)) })
}
async function reanalyze() {
  const result = await store.runAnalysis(store.selectedNote.source_id, referenceAt.value)
  if (result && result.ok) {
    const n = store.notes.find((x) => x.id === result.noteId)
    const q = { ...route.query }
    if (n) q.bucket = noteBucket(n)
    router.replace({ path: '/notes/' + result.noteId, query: q })
  }
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <Button v-if="backTaskLink" size="sm" variant="outline" @click="router.push(backTaskLink)"><ArrowLeft />返回任务</Button>
      <Button v-else-if="backCollectPath" size="sm" variant="outline" @click="router.push(backCollectPath)"><ArrowLeft />返回资料库</Button>
      <span class="min-w-0 flex-1 truncate text-sm text-muted-foreground">逐字段确认 · 带出处建任务</span>
      <span class="hidden items-center gap-1 text-xs text-muted-foreground sm:flex"><span class="size-1.5 rounded-full bg-emerald-500" />已保存到本地</span>
      <Button size="sm" variant="outline" class="lg:hidden" :aria-expanded="queueOpen" @click="queueOpen = !queueOpen">
        资料队列 · {{ store.notes.length }}
      </Button>
      <Button size="sm" variant="outline" :aria-label="store.evidenceOpen ? '收起原文' : '展开原文'" @click="store.evidenceOpen = !store.evidenceOpen">
        <PanelRight />{{ store.evidenceOpen ? '收起原文' : '展开原文' }}
      </Button>
    </div>

    <div class="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]" :class="{ 'xl:grid-cols-[220px_minmax(0,1fr)_320px]': store.evidenceOpen }">
      <Card class="min-w-0" :class="queueOpen ? '' : 'hidden lg:block'">
        <template #header><div class="text-base font-semibold">资料队列</div></template>
        <div class="space-y-2">
          <div v-for="b in BUCKET_ORDER" :key="b">
            <button
              class="flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
              :aria-expanded="!collapsed[b]"
              @click="toggleBucket(b)"
            >
              <span>{{ BUCKET_LABELS[b] }} · {{ store.noteBuckets[b].length }}</span>
              <ChevronDown v-if="!collapsed[b]" class="size-3.5" />
              <ChevronRight v-else class="size-3.5" />
            </button>
            <div v-show="!collapsed[b]" class="space-y-1">
              <button
                v-for="n in store.noteBuckets[b]"
                :key="n.id"
                class="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                :class="{ 'bg-accent': n.id === store.selectedNoteId }"
                @click="openQueueNote(n, b)"
              >
                <div class="truncate font-medium">{{ n.title }}</div>
                <div class="flex flex-wrap items-center gap-1">
                  <Badge :variant="statusVariant[n.status]" :title="n.status">{{ label(STATUS_LABELS, n.status) }}</Badge>
                  <span v-if="pendingFields(n).length" class="text-xs text-muted-foreground">{{ pendingFields(n).length }} 项字段待确认</span>
                </div>
              </button>
              <p v-if="!store.noteBuckets[b].length" class="px-2 text-xs text-muted-foreground">无</p>
            </div>
          </div>
          <p v-if="!store.notes.length" class="text-sm text-muted-foreground">还没有便签。<RouterLink to="/collect" class="underline">去资料库</RouterLink>保存一份资料。</p>
        </div>
      </Card>

      <Card v-if="store.selectedNote" class="min-w-0">
        <template #header>
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-0 flex-1 basis-40 break-words text-base font-semibold">{{ store.selectedNote.title }}</div>
            <Badge :variant="statusVariant[store.selectedNote.status]" :title="store.selectedNote.status">{{ label(STATUS_LABELS, store.selectedNote.status) }}</Badge>
            <Badge variant="secondary" :title="store.selectedNote.content_type">{{ label(CONTENT_TYPE_LABELS, store.selectedNote.content_type) }}</Badge>
            <div class="flex items-center gap-2">
              <div class="w-32"><NodeSelect v-model="noteMatter" :items="matterItems" placeholder="未归组" /></div>
              <div v-if="store.selectedNote.matter_id" class="w-28"><NodeSelect v-model="noteRole" :items="roleItems" placeholder="未指定角色" /></div>
            </div>
          </div>
        </template>
        <div class="space-y-3">
          <Alert v-if="store.selectedNote.status === 'reviewed' && unconfirmed.length" variant="warning">
            已审阅不等于已确认：仍有 {{ unconfirmed.length }} 个字段待核对/确认（{{ unconfirmed.map((f) => label(FIELD_LABELS, f.key)).join('、') }}），本便签留在待核对队列。
          </Alert>
          <!-- key 含便签 ID：切换资料时编辑组件重建，草稿（含节点编辑）绝不带入另一份便签 -->
          <FieldCard v-for="f in store.selectedNote.fields" :key="store.selectedNote.id + ':' + f.key" :note="store.selectedNote" :field="f" />
          <p v-if="!store.selectedNote.fields.length" class="text-sm text-muted-foreground">分析失败或尚未分析，原图仍保留，可重试。</p>
          <Alert v-if="store.selectedNote.warnings && store.selectedNote.warnings.length" variant="warning">
            <div v-for="w in store.selectedNote.warnings" :key="w.code + (w.field_key || '')" class="text-xs" :title="w.code">
              {{ w.message }}
            </div>
            <details class="mt-1 text-xs">
              <summary class="cursor-pointer text-muted-foreground">诊断代码</summary>
              <div v-for="w in store.selectedNote.warnings" :key="'code-' + w.code + (w.field_key || '')" class="font-mono">
                {{ w.code }}<template v-if="w.field_key"> · {{ w.field_key }}</template>
              </div>
            </details>
          </Alert>

          <Separator />

          <!-- 建任务成功：留在本页，提供定位查看与继续核对 -->
          <div v-if="createdTask" class="rounded-md border border-emerald-300 bg-emerald-50/60 p-3">
            <div class="text-sm font-medium">任务「{{ createdTaskObj ? createdTaskObj.title : '新任务' }}」已创建并保存到本地</div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" @click="goCreatedTask">查看任务</Button>
              <Button v-if="nextNote" size="sm" variant="outline" @click="goNextNote">核对下一条</Button>
              <span v-else class="text-xs text-muted-foreground">当前队列没有下一条了</span>
              <Button size="sm" variant="ghost" @click="createdTask = null">留在本页</Button>
            </div>
            <p class="mt-1.5 text-xs text-muted-foreground">查看任务会打开它所在的日期与详情；核对下一条只切换资料，不改动任何字段。</p>
          </div>

          <!-- 下一步：随状态变化的唯一主操作 -->
          <div v-if="nextStep" class="rounded-md border border-primary/30 bg-accent/40 p-3">
            <div class="flex flex-wrap items-center gap-2">
              <Button :disabled="nextDisabled" @click="runNext">{{ nextStep.label }}</Button>
              <span class="min-w-0 flex-1 basis-40 text-xs text-muted-foreground">{{ nextStep.hint }}</span>
            </div>
            <div v-if="nextStep.kind !== 'create' || store.selectedNote.status === 'draft'" class="mt-2 flex flex-wrap items-center gap-2">
              <Button
                v-if="nextStep.kind !== 'create'"
                variant="outline"
                :disabled="!hasConfirmedDeadline"
                :title="hasConfirmedDeadline ? '' : '先独立确认截止时间'"
                @click="createTask"
              >创建任务</Button>
              <span v-if="nextStep.kind !== 'create' && !hasConfirmedDeadline" class="text-xs text-muted-foreground">确认截止后，可带入任务</span>
              <Button v-if="store.selectedNote.status === 'draft' && nextStep.kind !== 'review'" variant="outline" @click="store.reviewNote(store.selectedNote)">标记已审阅</Button>
            </div>
          </div>

          <!-- 更多操作：重新分析 / 删除 / 手动替代路径 / 参照日期 -->
          <div>
            <Button variant="ghost" size="sm" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">
              <ChevronDown v-if="moreOpen" class="size-4" />
              <ChevronRight v-else class="size-4" />
              更多操作
            </Button>
            <div v-if="moreOpen" class="mt-2 space-y-3 rounded-md border border-dashed border-border p-3">
              <div class="flex flex-wrap items-center gap-2">
                <Button variant="outline" :disabled="store.busy || store.aiDown" @click="reanalyze"><RefreshCw />{{ store.selectedNote.status === 'failed' ? '重试分析' : '重新分析' }}</Button>
                <Button variant="destructive" @click="openDeleteNote">删除便签</Button>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <DateInput v-model="manualDeadline" allow-time placeholder="手动截止（可选时间）" class="max-w-xs" aria-label="手动截止" />
                <Button variant="outline" @click="createManual">手动截止建任务</Button>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <DateInput v-model="referenceAt" placeholder="参照日期（可选）" class="max-w-xs" />
                <span class="text-xs text-muted-foreground">重新分析时相对时间的换算参照。</span>
              </div>
            </div>
          </div>
        </div>
      </Card>
      <Card v-else class="min-w-0">
        <p v-if="bucketQuery" class="text-sm text-muted-foreground">
          「{{ BUCKET_LABELS[bucketQuery] }}」队列当前没有资料。<span class="lg:hidden">点上方「资料队列」查看其他分组。</span><span class="hidden lg:inline">可在左侧队列查看其他分组。</span>
        </p>
        <p v-else-if="reviewClear && store.notes.length" class="text-sm text-muted-foreground">
          待处理资料已清空：没有待核对或分析失败的资料。已确认资料可从<RouterLink to="/collect" class="underline">资料库</RouterLink>回看。
        </p>
        <p v-else class="text-sm text-muted-foreground">从队列选择一份资料开始核对。<span class="lg:hidden">点上方「资料队列」展开。</span></p>
      </Card>

      <Card v-if="store.evidenceOpen" class="min-w-0 max-lg:order-first">
        <template #header><div class="text-base font-semibold">原始资料</div></template>
        <div class="space-y-2">
          <img v-if="store.imageUrl" :src="store.imageUrl" alt="原始截图" class="max-h-96 w-full rounded-md border object-contain" />
          <pre v-else-if="evidenceSource && evidenceSource.kind === 'text'" class="overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{{ evidenceSource.text }}</pre>
          <p v-else class="text-sm text-muted-foreground">原始资料不可被编辑覆盖。</p>
          <p v-if="evidenceSource" class="text-xs text-muted-foreground">收集于 {{ beijingInstantLabel(evidenceSource.captured_at) }} · 字段引用与原文同时查看</p>
        </div>
      </Card>
    </div>

    <ConfirmDialog
      v-model="deleteOpen"
      title="删除便签"
      :confirm-label="affectedTasks.length ? '删除便签及关联任务' : '删除便签'"
      :confirm-disabled="deleteBlocked"
      @confirm="confirmDelete"
    >
      <template v-if="store.selectedNote">
        <p v-if="noteScopeNotice" class="mb-2 rounded bg-warning px-2 py-1 text-xs text-warning-foreground">删除范围或安排事实已变化（其它页面新增/移除了对象，或安排已执行）。请核对下方最新影响后重新确认。</p>
        <p>将删除便签「{{ store.selectedNote.title }}」。原始截图/文字默认保留，专注历史不在本次删除范围内。</p>
        <template v-if="affectedTasks.length">
          <p class="mt-1 font-medium">同时删除 {{ affectedTasks.length }} 个关联任务（引用此便签或其截止出处）：</p>
          <ul class="mt-1 list-disc space-y-0.5 pl-5">
            <li v-for="t in affectedTasks" :key="t.id">
              {{ t.title }}
              <span v-if="isSharedTask(t)" class="text-red-600">（还关联其他便签，将整体删除）</span>
            </li>
          </ul>
          <p v-if="affectedActions.length" class="mt-1 text-xs text-muted-foreground">这些任务的 {{ affectedActions.length }} 个行动一并删除。</p>
          <p class="mt-1 text-xs text-muted-foreground">不会沿任务引用继续删除其他便签或事项。取消则不做任何修改。</p>
        </template>
        <p v-else class="mt-1 text-xs text-muted-foreground">当前没有关联任务。取消则不做任何修改。</p>
        <DeleteImpact
          :rows="deleteFacts ? deleteFacts.rows : []"
          empty-text="关联任务没有安排，删除不影响任何安排。"
          @goto-plan="deleteGotoPlan"
          @goto-work="deleteGotoWork"
        />
        <p class="mt-1 text-xs text-muted-foreground">删除后可在「日程 · 恢复」撤销本次删除；若记录已有新版本，撤销会被明确拒绝而不覆盖你的修改。</p>
      </template>
    </ConfirmDialog>
  </div>
</template>