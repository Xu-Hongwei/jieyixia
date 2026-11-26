<script setup>
import { requireQwen } from '@/services/api/qwenConnection'
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, FolderPlus, Pencil, RefreshCw, Search, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-vue-next'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Input from '@/components/ui/Input.vue'
import NodeSelect from '@/components/domain/NodeSelect.vue'
import TaskRow from '@/components/domain/TaskRow.vue'
import Textarea from '@/components/ui/Textarea.vue'
import MaterialPanel from '@/components/domain/MaterialPanel.vue'
import { useUnsavedGuard } from '@/composables/useUnsavedGuard'
import { registerWorkLeave, requestWorkLeave, resetWorkLeaveApproval } from '@/composables/workLeave'
import { MAX_SELECTED_SOURCES } from '@/domains/assistant/limits'
import { useAppStore } from '@/stores/app'
import { beijingInstantLabel, isValidDate } from '@/domains/time'
import { BUCKET_LABELS, byCaptured, matterNotesOf, matterTasksOf, matterTitleOf, rowMatches, sourceRow } from '@/domains/organize'
import { MATTER_ROLE_LABELS, STATUS_LABELS, label } from '@/domains/labels'

const store = useAppStore()
const route = useRoute()
const router = useRouter()
const textDraft = ref('')
const referenceAt = ref('')
const fileInput = ref(null)
const pendingUrl = ref(null)

// 添加入口常驻一行；输入 / 粘贴 / 选图后才展开完整输入区。
const addOpen = ref(false)
function openAdd() {
  addOpen.value = true
  nextTick(() => {
    const el = /** @type {HTMLElement | null} */ (document.querySelector('textarea[aria-label="文字资料"]'))
    if (el) el.focus()
  })
}
watch(textDraft, (v) => { if (v.trim()) addOpen.value = true })
watch(() => store.pendingSource, (s) => { if (s) addOpen.value = true })

// 搜索 / 筛选（纯本地过滤，不改后端）：形态、内容类型、核对状态、收集日期范围（北京日界）。
// 筛选状态与 URL 双向同步：刷新 / 返回都恢复同一列表视图。
const KIND_ITEMS = [
  { value: 'all', label: '全部形态' },
  { value: 'image', label: '截图' },
  { value: 'text', label: '文字' },
]
const CONTENT_ITEMS = [
  { value: 'all', label: '全部内容' },
  { value: 'notice', label: '通知' },
  { value: 'tutorial', label: '教程' },
  { value: 'reference', label: '参考资料' },
]
const STATUS_ITEMS = [
  { value: 'all', label: '全部状态' },
  { value: 'none', label: '未分析' },
  { value: 'pending', label: '待核对' },
  { value: 'failed', label: '失败' },
  { value: 'confirmed', label: '已确认' },
]
const SORT_ITEMS = [
  { value: 'desc', label: '最新优先' },
  { value: 'asc', label: '最早优先' },
]
const FILTER_KEYS = ['q', 'kind', 'content', 'status', 'from', 'to', 'sort']
const pickItem = (items, v) => (items.some((i) => i.value === v) ? v : 'all')
const routeFilterQuery = () => {
  /** @type {Record<string, string>} */
  const q = {}
  for (const k of FILTER_KEYS) if (typeof route.query[k] === 'string' && route.query[k]) q[k] = route.query[k]
  return q
}
const initQ = routeFilterQuery()
const query = ref(initQ.q || '')
const kindFilter = ref(pickItem(KIND_ITEMS, initQ.kind))
const contentFilter = ref(pickItem(CONTENT_ITEMS, initQ.content))
const statusFilter = ref(pickItem(STATUS_ITEMS, initQ.status))
const fromDate = ref(isValidDate(initQ.from || '') ? initQ.from : '')
const toDate = ref(isValidDate(initQ.to || '') ? initQ.to : '')
const sortDir = ref(initQ.sort === 'asc' ? 'asc' : 'desc')
const filtersOpen = ref(false)

function stateQuery() {
  /** @type {Record<string, string>} */
  const q = {}
  if (query.value) q.q = query.value
  if (kindFilter.value !== 'all') q.kind = kindFilter.value
  if (contentFilter.value !== 'all') q.content = contentFilter.value
  if (statusFilter.value !== 'all') q.status = statusFilter.value
  if (fromDate.value) q.from = fromDate.value
  if (toDate.value) q.to = toDate.value
  if (sortDir.value !== 'desc') q.sort = sortDir.value
  return q
}
const sameQuery = (a, b) => FILTER_KEYS.every((k) => (a[k] || '') === (b[k] || ''))
watch([query, kindFilter, contentFilter, statusFilter, fromDate, toDate, sortDir], () => {
  const next = stateQuery()
  if (!sameQuery(next, routeFilterQuery())) router.replace({ query: { ...next, ...(panelId.value ? { source: panelId.value } : {}) } })
})
watch(() => route.query, () => {
  const rq = routeFilterQuery()
  if (sameQuery(stateQuery(), rq)) return
  query.value = rq.q || ''
  kindFilter.value = pickItem(KIND_ITEMS, rq.kind)
  contentFilter.value = pickItem(CONTENT_ITEMS, rq.content)
  statusFilter.value = pickItem(STATUS_ITEMS, rq.status)
  fromDate.value = isValidDate(rq.from || '') ? rq.from : ''
  toDate.value = isValidDate(rq.to || '') ? rq.to : ''
  sortDir.value = rq.sort === 'asc' ? 'asc' : 'desc'
}, { immediate: true })

const filtersActive = computed(() =>
  !!query.value.trim() || kindFilter.value !== 'all' || contentFilter.value !== 'all' || statusFilter.value !== 'all' || !!fromDate.value || !!toDate.value,
)
const advancedCount = computed(() =>
  (kindFilter.value !== 'all' ? 1 : 0) + (contentFilter.value !== 'all' ? 1 : 0) + (fromDate.value ? 1 : 0) + (toDate.value ? 1 : 0),
)
// 深链接带高级筛选时自动展开筛选区，保证可见可清除。
watch(advancedCount, (n) => { if (n) filtersOpen.value = true }, { immediate: true })
const filterChips = computed(() => {
  const chips = []
  if (query.value.trim()) chips.push({ key: 'query', text: `搜索：${query.value.trim()}` })
  if (kindFilter.value !== 'all') chips.push({ key: 'kind', text: label(Object.fromEntries(KIND_ITEMS.map((i) => [i.value, i.label])), kindFilter.value) })
  if (contentFilter.value !== 'all') chips.push({ key: 'content', text: label(Object.fromEntries(CONTENT_ITEMS.map((i) => [i.value, i.label])), contentFilter.value) })
  if (statusFilter.value !== 'all') chips.push({ key: 'status', text: label(Object.fromEntries(STATUS_ITEMS.map((i) => [i.value, i.label])), statusFilter.value) })
  if (fromDate.value) chips.push({ key: 'from', text: `起 ${fromDate.value}` })
  if (toDate.value) chips.push({ key: 'to', text: `止 ${toDate.value}` })
  return chips
})
function clearChip(key) {
  if (key === 'query') query.value = ''
  else if (key === 'kind') kindFilter.value = 'all'
  else if (key === 'content') contentFilter.value = 'all'
  else if (key === 'status') statusFilter.value = 'all'
  else if (key === 'from') fromDate.value = ''
  else if (key === 'to') toDate.value = ''
}
const inboxRows = computed(() => {
  const rows = store.sources.map((s) => {
    const note = store.notes.find((n) => n.source_id === s.id) || null
    return sourceRow(s, note, note ? matterTitleOf(store.docs, note.matter_id) : '')
  })
  const options = { contentType: contentFilter.value, from: fromDate.value, to: toDate.value }
  return byCaptured(rows.filter((r) => rowMatches(r, query.value, kindFilter.value, statusFilter.value, options)), sortDir.value)
})
function clearFilters() {
  query.value = ''
  kindFilter.value = 'all'
  contentFilter.value = 'all'
  statusFilter.value = 'all'
  fromDate.value = ''
  toDate.value = ''
}
const bucketVariant = { pending: 'warning', failed: 'destructive', confirmed: 'success', none: 'secondary' }
// 核对状态与整体审阅状态分开呈现：已审阅但仍有关键字段未确认 → 仍显示待核对 + 已审阅徽标。
function rowStatusText(row) {
  if (!row.note) return '未分析'
  return BUCKET_LABELS[row.bucket]
}
// 详情只改变 source 参数，列表筛选和滚动保留。
const panelRef = ref(null)
const panelId = computed(() => typeof route.query.source === 'string' ? route.query.source : '')
const queueIds = ref([])
const selectedIds = ref([])
const localBusy = ref(false)
const nextNoteId = computed(() => {
  const i = queueIds.value.indexOf(panelId.value)
  const live = new Set(inboxRows.value.map(r => r.source.id))
  for (const id of queueIds.value.slice(i + 1)) {
    const n = store.notes.find(n => n.source_id === id)
    if (n && live.has(id)) return n.id
  }
  return ''
})
function closePanel() { const q = { ...route.query }; delete q.source; router.replace({ query: q }) }
async function openRow(row) {
  if (panelRef.value && !(await panelRef.value.guardLeave())) return
  queueIds.value = inboxRows.value.map(r => r.source.id)
  await router.replace({ query: { ...route.query, source: row.source.id } })
}
function openNote(id) {
  const note = store.notes.find(n => n.id === id)
  if (note) router.replace({ query: { ...route.query, source: note.source_id } })
}
watch([() => store.ready, panelId, () => store.sources], () => {
  if (!store.ready || !panelId.value) return
  if (!store.sources.some(s => s.id === panelId.value)) {
    store.say('warning', '资料已不存在或不属于当前空间'); closePanel(); return
  }
  if (!queueIds.value.includes(panelId.value)) queueIds.value = inboxRows.value.map(r => r.source.id)
}, { immediate: true })
function toggleSelected(id) {
  if (selectedIds.value.includes(id)) selectedIds.value = selectedIds.value.filter(x => x !== id)
  else if (selectedIds.value.length < MAX_SELECTED_SOURCES) selectedIds.value.push(id)
  else store.say('warning', `一次最多选择 ${MAX_SELECTED_SOURCES} 份资料`)
}
const selectedSources = computed(() => selectedIds.value.map(id => store.sources.find(s => s.id === id)).filter(Boolean))
function sourceTitle(source) { return source.kind === 'image' ? source.name : (source.text || '').split('\n')[0] || '文字资料' }
function planSelected() {
  const ids = selectedSources.value.map(s => s.id)
  if (!ids.length || ids.length !== selectedIds.value.length) { store.say('warning', '所选资料已变化，请重新选择'); return }
  router.push({ path: '/assistant', query: { sources: ids, workspace: store.workspaceId } })
}
const statusCounts = computed(() => Object.fromEntries(STATUS_ITEMS.map(item => [item.value, item.value === 'all' ? store.sources.length : store.sources.filter(s => sourceRow(s, store.notes.find(n => n.source_id === s.id) || null, '').bucket === item.value).length])))
const { discardOpen, guardLeave: guardDraft, settle } = useUnsavedGuard(
  () => !!textDraft.value.trim() || !!referenceAt.value || !!matterName.value.trim() || !!renamingMatter.value,
  () => store.busy || localBusy.value,
  () => { textDraft.value = ''; referenceAt.value = ''; matterName.value = ''; renamingMatter.value = null },
)
async function guardLeave() {
  if (panelRef.value && !(await panelRef.value.guardLeave())) return false
  return guardDraft()
}
const unregister = registerWorkLeave(guardLeave)
onBeforeUnmount(unregister)
onBeforeRouteLeave(requestWorkLeave)
onBeforeRouteUpdate(async (to, from) => to.query.source !== from.query.source && panelRef.value ? panelRef.value.guardLeave() : true)

watch(() => store.pendingSource, (s) => {
  if (pendingUrl.value) URL.revokeObjectURL(pendingUrl.value)
  pendingUrl.value = s && s.kind === 'image' && s.blob ? URL.createObjectURL(s.blob) : null
}, { immediate: true })

// 切换工作区清空本页草稿与搜索/筛选，不残留上一空间的输入。
watch(() => store.workspaceId, () => {
  textDraft.value = ''
  referenceAt.value = ''
  addOpen.value = false
  filtersOpen.value = false
  selectedIds.value = []; queueIds.value = []; renamingMatter.value = null; matterName.value = ''
  resetWorkLeaveApproval()
  clearFilters()
  if (panelId.value) closePanel()
})

async function runAI() {
  if (store.busy || localBusy.value || !requireQwen()) return
  localBusy.value = true
  try {
    const draft = textDraft.value.trim()
    let source = store.pendingSource
    // 有文字输入时明确处理文字；已保存的图片仍在资料库中。
    if (draft && (!source || source.kind !== 'text' || source.text !== draft)) {
      const saved = await store.collectText(draft)
      if (!saved) return
      textDraft.value = ''; source = store.pendingSource
    }
    if (!source) return store.say('warning', '先添加截图或文字')
    const result = await store.runAnalysis(source.id, referenceAt.value)
    if (result?.noteId) { referenceAt.value = ''; addOpen.value = false; openNote(result.noteId) }
  } finally { localBusy.value = false }
}
async function retrySave() {
  const result = await store.retrySave()
  if (result && result.ok) openNote(result.noteId)
}
async function saveText() {
  if (localBusy.value) return
  localBusy.value = true
  try {
    const ok = await store.collectText(textDraft.value)
    if (ok) { textDraft.value = ''; addOpen.value = false; if (store.pendingSource) openRow({ source: store.pendingSource }) }
  } finally { localBusy.value = false }
}
async function saveImages(files) {
  if (localBusy.value) return
  localBusy.value = true
  try { await store.collectFiles(files) } finally { localBusy.value = false }
}

function onPaste(e) {
  if (store.isDemo || panelId.value || e.target.closest?.('textarea, input')) return
  const files = e.clipboardData && e.clipboardData.files
  if (files && files.length) {
    e.preventDefault()
    saveImages(files)
  } else {
    const text = e.clipboardData && e.clipboardData.getData('text')
    if (text) {
      textDraft.value = text
      store.say('info', '剪贴板文字已填入输入框')
    }
  }
}
const onDrop = (e) => {
  e.preventDefault()
  if (store.isDemo || panelId.value) return
  saveImages(e.dataTransfer.files)
}
function onFileChange(e) {
  const input = /** @type {HTMLInputElement} */ (e.target)
  saveImages(input.files)
  input.value = ''
}
onMounted(() => window.addEventListener('paste', onPaste))
onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  if (pendingUrl.value) URL.revokeObjectURL(pendingUrl.value)
})

// 事项管理（从日程页移入资料库）：手动归组，非 AI；删除只解除归组。
const mattersOpen = ref(false)
const matterName = ref('')
const renamingMatter = ref(null)
const matterDraft = ref('')
const expandedMatter = ref(null)
const deleteMatterTarget = ref(null)
const deleteMatterOpen = ref(false)
const deleteMatterNotes = computed(() => (deleteMatterTarget.value ? matterNotesOf(store.docs, deleteMatterTarget.value.id) : []))
const deleteMatterTasks = computed(() => (deleteMatterTarget.value ? matterTasksOf(store.docs, deleteMatterTarget.value.id) : []))
async function createMatter() {
  const r = await store.createMatter(matterName.value)
  if (r && r.ok) matterName.value = ''
}
function startRenameMatter(m) {
  renamingMatter.value = m.id
  matterDraft.value = m.title
}
async function saveRenameMatter(m) {
  const r = await store.renameMatter(m, matterDraft.value)
  if (r && r.ok) renamingMatter.value = null
}
function toggleMatter(id) {
  expandedMatter.value = expandedMatter.value === id ? null : id
}
async function confirmDeleteMatter() {
  const m = deleteMatterTarget.value
  deleteMatterOpen.value = false
  deleteMatterTarget.value = null
  if (m) await store.deleteMatter(m)
}
</script>

<template>
  <div class="mx-auto max-w-6xl" @drop="onDrop" @dragover.prevent>
  <header class="mb-4 flex items-center justify-between gap-3"><h1 class="text-2xl font-semibold">资料</h1><RouterLink v-if="store.isDemo" to="/assistant" class="text-sm text-primary underline">查看操作演示</RouterLink><Button v-else :aria-expanded="addOpen" @click="openAdd"><Upload />添加资料</Button></header>
  <Card v-if="!store.isDemo && addOpen" class="mb-4">
    <template #header>
      <div class="flex items-center justify-between"><span class="text-base font-semibold">添加资料</span><Button size="sm" variant="ghost" aria-label="收起添加资料" @click="async () => { if (await guardDraft()) addOpen = false }"><X /></Button></div>
    </template>
    <div class="space-y-3">
      <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" @change="onFileChange" />

      <!-- 展开态：完整输入区 -->
      <div>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" @click="fileInput.click()"><Upload />选择图片</Button>
          <Button variant="outline" :disabled="localBusy || !textDraft.trim()" @click="saveText">仅保存文字</Button>
          <Button v-if="!store.aiDown" :disabled="store.busy || localBusy || (!textDraft.trim() && !store.pendingSource)" @click="runAI"><Sparkles />{{ store.busy ? '分析中…' : textDraft.trim() ? '保存文字并提取' : '提取图片信息' }}</Button>
          <Button v-if="store.pendingSave" variant="outline" :disabled="store.busy" @click="retrySave"><RefreshCw />重试保存分析结果（不重调模型）</Button>
        </div>
        <Alert v-if="store.aiDown" variant="warning">当前离线，仍可保存和查看资料。</Alert>
        <p v-if="store.pendingSave" class="text-xs text-muted-foreground">上次 AI 分析成功但本地保存失败，结果已暂存（刷新不丢）；重试只重新落库，不会再次请求模型。</p>
        <p v-if="!store.aiDown" class="text-xs text-muted-foreground">提取信息会将当前资料发送给模型；仅保存不会发送。</p>
        <Textarea :disabled="localBusy || store.busy" v-model="textDraft" placeholder="或粘贴 / 输入纯文字…" class="min-h-24" aria-label="文字资料" />
        <div class="flex flex-wrap items-center gap-2">
          <DateInput v-model="referenceAt" placeholder="参照日期（可选）" class="max-w-xs" />
          <span class="text-xs text-muted-foreground">用于理解“明天”等相对日期。</span>
        </div>
        <div v-if="store.pendingSource" class="rounded-md border p-3 space-y-2">
          <div class="text-sm text-muted-foreground">待处理：{{ store.pendingSource.kind === 'image' ? store.pendingSource.name : '文字资料' }} · {{ beijingInstantLabel(store.pendingSource.captured_at) }}</div>
          <img v-if="pendingUrl" :src="pendingUrl" alt="待处理截图" class="max-h-64 rounded-md border" />
          <pre v-else class="overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{{ store.pendingSource.text }}</pre>
        </div>
      </div>
    </div>
  </Card>

  <Card>
    <template #header>
      <div class="text-base font-semibold">资料库 · {{ inboxRows.length }} 份</div>
    </template>
    <div class="space-y-3">
      <div class="flex flex-wrap gap-1 border-b pb-3" aria-label="资料状态筛选"><button v-for="item in STATUS_ITEMS" :key="item.value" type="button" class="rounded-md px-3 py-2 text-sm" :class="statusFilter === item.value ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-muted'" :aria-pressed="statusFilter === item.value" @click="statusFilter = item.value">{{ item.label }} <span class="ml-1 tabular-nums">{{ statusCounts[item.value] }}</span></button></div>
      <div v-if="selectedIds.length" class="space-y-2 rounded-md bg-accent/50 p-3" aria-label="已选资料">
        <div class="flex flex-wrap items-center gap-2"><span class="flex-1 text-sm">已选 {{ selectedIds.length }} 份</span><Button size="sm" @click="planSelected">用所选资料制定计划</Button><Button size="sm" variant="ghost" @click="selectedIds = []">清空选择</Button></div>
        <div class="flex flex-wrap gap-2"><button v-for="source in selectedSources" :key="source.id" type="button" class="max-w-full truncate text-xs underline" :aria-label="`取消选择：${sourceTitle(source)}`" @click="toggleSelected(source.id)">{{ sourceTitle(source) }} ×</button></div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative min-w-40 flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            v-model="query"
            placeholder="搜索资料名称或内容"
            class="pl-8"
            aria-label="搜索资料库"
            title="命中文件名 / 正文 / 便签标题 / 摘要 / 字段原文与引用 / 关键词 / 事项名称"
          />
        </div>
        <div class="w-28"><NodeSelect v-model="sortDir" :items="SORT_ITEMS" placeholder="最新优先" /></div>
        <Button variant="outline" :aria-expanded="filtersOpen" @click="filtersOpen = !filtersOpen">
          <SlidersHorizontal />筛选<span v-if="advancedCount" class="ml-0.5 rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{{ advancedCount }}</span>
        </Button>
      </div>

      <!-- 高级筛选：按需展开 -->
      <div v-if="filtersOpen" class="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-3">
        <div class="w-28"><NodeSelect v-model="kindFilter" :items="KIND_ITEMS" placeholder="全部形态" /></div>
        <div class="w-28"><NodeSelect v-model="contentFilter" :items="CONTENT_ITEMS" placeholder="全部内容" /></div>
        <span class="text-xs text-muted-foreground">收集日期（北京时间）</span>
        <DateInput v-model="fromDate" placeholder="起（可选）" class="max-w-40" />
        <span class="text-xs text-muted-foreground">至</span>
        <DateInput v-model="toDate" placeholder="止（可选）" class="max-w-40" />
      </div>

      <!-- 启用的筛选可见、可逐项清除 -->
      <div v-if="filtersActive" class="flex flex-wrap items-center gap-1.5">
        <span
          v-for="c in filterChips"
          :key="c.key"
          class="flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs"
        >
          {{ c.text }}
          <button type="button" class="rounded-full p-0.5 hover:bg-accent" :aria-label="`清除筛选：${c.text}`" @click="clearChip(c.key)">
            <X class="size-3" />
          </button>
        </span>
        <Button size="sm" variant="ghost" @click="clearFilters">清除筛选</Button>
      </div>

      <div class="divide-y" aria-label="资料列表">
        <div v-for="row in inboxRows" :key="row.source.id" :data-source-row="row.source.id" class="flex items-center gap-3 py-3">
          <input v-if="!store.isDemo" type="checkbox" :checked="selectedIds.includes(row.source.id)" :aria-label="`选择资料：${sourceTitle(row.source)}`" @change="toggleSelected(row.source.id)" />
          <button type="button" class="min-w-0 flex-1 rounded-md px-1 py-1 text-left hover:bg-accent" :aria-label="`查看资料：${sourceTitle(row.source)}`" @click="openRow(row)">
            <div class="truncate text-sm font-medium">{{ row.note ? row.note.title : sourceTitle(row.source) }}</div>
            <div class="mt-1 truncate text-xs text-muted-foreground">{{ row.source.kind === 'image' ? '截图' : '文字' }} · {{ beijingInstantLabel(row.source.captured_at) }}<template v-if="row.matterTitle"> · {{ row.matterTitle }}</template></div>
          </button>
          <Badge :variant="bucketVariant[row.bucket]">{{ rowStatusText(row) }}</Badge>
        </div>
        <p v-if="!inboxRows.length" class="text-sm text-muted-foreground">
          {{ store.sources.length ? '没有匹配的资料，试试其他关键词或筛选条件。' : store.isDemo ? '课程通知收在助手的操作演示里。' : '还没有资料。点「添加资料」保存第一张截图或一段文字。' }}
        </p>
      </div>
    </div>
  </Card>

  <!-- 事项管理：资料库的二级工作面，默认折叠 -->
  <Card class="mt-4">
    <template #header>
      <button class="flex w-full items-center justify-between text-base font-semibold" :aria-expanded="mattersOpen" @click="mattersOpen = !mattersOpen">
        <span>事项管理 · {{ store.matters.length }}</span>
        <ChevronDown v-if="mattersOpen" class="size-4" />
        <ChevronRight v-else class="size-4" />
      </button>
      <p v-if="mattersOpen" class="text-sm text-muted-foreground">删除事项只解除归组，保留资料与任务。</p>
    </template>
    <div v-if="mattersOpen" class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <Input v-model="matterName" placeholder="新事项名…" class="max-w-40" aria-label="新事项名" />
        <Button variant="outline" @click="createMatter"><FolderPlus />建事项</Button>
      </div>
      <div class="space-y-2">
        <div v-for="m in store.matters" :key="m.id" class="rounded-md border p-2 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <template v-if="renamingMatter === m.id">
              <Input v-model="matterDraft" class="h-8 max-w-40" aria-label="重命名事项" @keyup.enter="saveRenameMatter(m)" />
              <Button size="sm" @click="saveRenameMatter(m)">保存</Button>
              <Button size="sm" variant="outline" @click="renamingMatter = null">取消</Button>
            </template>
            <template v-else>
              <button class="flex min-w-0 flex-1 basis-40 items-center gap-1 text-left font-medium" :aria-expanded="expandedMatter === m.id" @click="toggleMatter(m.id)">
                <ChevronDown v-if="expandedMatter === m.id" class="size-3.5 shrink-0" />
                <ChevronRight v-else class="size-3.5 shrink-0" />
                <span class="truncate">{{ m.title }}</span>
              </button>
              <Badge variant="secondary">{{ matterNotesOf(store.docs, m.id).length }} 便签 · {{ matterTasksOf(store.docs, m.id).length }} 任务</Badge>
              <Button size="sm" variant="outline" aria-label="重命名事项" title="重命名" @click="startRenameMatter(m)"><Pencil /></Button>
              <Button size="sm" variant="destructive" aria-label="删除事项" title="删除" @click="deleteMatterTarget = m; deleteMatterOpen = true"><Trash2 /></Button>
            </template>
          </div>
          <div v-if="expandedMatter === m.id" class="mt-2 space-y-3 border-t pt-2">
            <div class="space-y-1">
              <div class="text-xs font-medium text-muted-foreground">资料与角色</div>
              <div v-for="n in matterNotesOf(store.docs, m.id)" :key="n.id" class="flex flex-wrap items-center gap-2">
                <button type="button" class="min-w-0 flex-1 basis-40 truncate text-left underline" @click="openNote(n.id)">{{ n.title }}</button>
                <Badge variant="secondary">{{ n.matter_role ? label(MATTER_ROLE_LABELS, n.matter_role) : '未指定角色' }}</Badge>
              </div>
              <p v-if="!matterNotesOf(store.docs, m.id).length" class="text-xs text-muted-foreground">暂无关联资料。</p>
            </div>
            <div class="space-y-1">
              <div class="text-xs font-medium text-muted-foreground">相关任务</div>
              <TaskRow v-for="t in matterTasksOf(store.docs, m.id)" :key="t.id" :task="t" />
              <p v-if="!matterTasksOf(store.docs, m.id).length" class="text-xs text-muted-foreground">还没有任务归入此事项。</p>
            </div>
          </div>
        </div>
        <p v-if="!store.matters.length" class="text-sm text-muted-foreground">还没有事项；建一个即可把便签与任务手动归进去。</p>
      </div>
    </div>
  </Card>

  <div v-if="store.lastDeleted" class="mt-4 flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"><span class="flex-1">{{ store.lastDeleted.kind === 'note' ? '便签已删除，原始资料保留' : '最近删除可恢复' }}</span><Button size="sm" variant="outline" @click="store.undoDelete()">撤销删除</Button></div>
  <MaterialPanel ref="panelRef" :source-id="panelId" :next-id="nextNoteId" :return-to="route.fullPath" @close="closePanel" @open-note="openNote" />
  <ConfirmDialog v-model="discardOpen" title="放弃未保存的资料输入？" confirm-label="放弃修改" cancel-label="继续编辑" @confirm="settle(true)">输入尚未保存，离开后将清空。</ConfirmDialog>
  <ConfirmDialog
    v-model="deleteMatterOpen"
    title="删除事项"
    confirm-label="删除事项（保留成员）"
    @confirm="confirmDeleteMatter"
  >
    <p>将删除事项「{{ deleteMatterTarget ? deleteMatterTarget.title : '' }}」，只解除归组关系：</p>
    <ul class="mt-1 list-disc space-y-0.5 pl-5">
      <li>{{ deleteMatterNotes.length }} 张便签回到未归组，资料角色清除；便签与原始截图/文字保留。</li>
      <li>{{ deleteMatterTasks.length }} 个任务解除事项关联，任务本体与截止保留。</li>
      <li>专注与计划记录保留。取消则不做任何修改。</li>
    </ul>
  </ConfirmDialog>
  </div>
</template>
