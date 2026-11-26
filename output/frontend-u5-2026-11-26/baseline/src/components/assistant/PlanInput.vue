<script setup>
// M2 真实输入区：资料（上传/粘贴/选择已有）、补充要求、关联已有任务/行动、七日可用时间。
// 首次真实输入在当前空间进行，不切换演示空间；原始资料先本地保存，再发起生成。
import { computed, ref } from 'vue'
import { ChevronDown, ChevronRight, FileImage, FileText, Sparkles, Upload } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Badge from '@/components/ui/Badge.vue'
import GenerationPanel from '@/components/assistant/GenerationPanel.vue'
import { useAssistantStore, DEFAULT_USER_MESSAGE } from '@/stores/assistant'
import { useAppStore } from '@/stores/app'
import { beijingToday, beijingAddDays, formatWhen } from '@/domains/time'
import { MAX_SELECTED_SOURCES } from '@/services/assistant/requests'

const store = useAssistantStore()
const app = useAppStore()

const pasteText = ref('')
const showRelated = ref(false)
const fileInput = ref(null)
const savingSource = ref(false)
const today = computed(() => beijingToday())
const input = store.input
const dates = computed(() => Array.from({ length: 7 }, (_, i) => beijingAddDays(input.startDate || today.value, i)))
const selectedCount = computed(() => input.sourceIds.length)
const canGenerate = computed(() => !store.generating && !savingSource.value && !pasteText.value.trim() && (input.sourceIds.length > 0 || input.userText.trim().length > 0))
const timeSummary = computed(() => {
  const budgets = dates.value.map(date => input.unavailable.includes(date) ? 0 : Number(input.budgets[date] == null || input.budgets[date] === '' ? store.formDefaults.budget : input.budgets[date]))
  return budgets.every(n => Number.isInteger(n) && n >= 0 && n <= 1440) ? `${budgets.reduce((sum, n) => sum + n, 0)} 分钟` : '请检查时间输入'
})
const hasUnsaved = computed(() => !!pasteText.value.trim() || !!input.userText.trim() || input.sourceIds.length > 0 || input.taskIds.length > 0 || !!input.startDate || Object.keys(input.budgets).length > 0 || input.unavailable.length > 0)
function discard() {
  pasteText.value = ''
  Object.assign(input, { userText: '', sourceIds: [], taskIds: [], actionIds: [], budgets: {}, unavailable: [], startDate: null, excerpts: {} })
}
defineExpose({ hasUnsaved, discard, busy: savingSource })

const sourceLabel = (s) => {
  if (s.kind === 'text') {
    const line = String(s.text || '').split('\n').map((x) => x.trim()).find(Boolean)
    return line ? (line.length > 30 ? `${line.slice(0, 30)}…` : line) : '文本摘录'
  }
  return s.name || '未命名截图'
}
const noteOf = (sourceId) => app.notes.find((n) => n.source_id === sourceId) ?? null

async function onFiles(e) {
  const files = Array.from(e.target.files || [])
  e.target.value = ''
  if (!files.length || savingSource.value || store.generating) return
  savingSource.value = true
  try {
    const results = await app.saveImageFiles(files)
    const okIds = results.filter((r) => r.ok).map((r) => r.record.id)
    input.sourceIds = [...new Set([...input.sourceIds, ...okIds])]
    const failed = results.filter((r) => !r.ok)
    if (failed.length) store.say('warning', `${failed.length} 份图片未保存：${failed.map((f) => `${f.name}（${f.message}）`).join('；')}`)
  } finally { savingSource.value = false }
}
async function savePaste() {
  const text = pasteText.value.trim()
  if (!text) return
  if (savingSource.value) return
  savingSource.value = true
  try {
    const r = await app.saveText(text)
    if (!r.ok) { store.say('warning', r.message || '文字保存失败'); return }
    input.sourceIds = [...new Set([...input.sourceIds, r.record.id])]
    pasteText.value = ''
  } finally { savingSource.value = false }
}
function toggleSource(id) {
  const i = input.sourceIds.indexOf(id)
  if (i >= 0) input.sourceIds.splice(i, 1)
  else input.sourceIds.push(id)
}
function toggleTask(id) {
  const i = input.taskIds.indexOf(id)
  if (i >= 0) {
    input.taskIds.splice(i, 1)
    // 取消选定任务时一并移除其行动：选定行动必须属于已选定任务。
    const owned = new Set(app.actionsOf(id).map((a) => a.id))
    input.actionIds = input.actionIds.filter((aid) => !owned.has(aid))
  } else input.taskIds.push(id)
}
function toggleAction(id) {
  const i = input.actionIds.indexOf(id)
  if (i >= 0) input.actionIds.splice(i, 1)
  else input.actionIds.push(id)
}
function toggleUnavailable(date) {
  const i = input.unavailable.indexOf(date)
  if (i >= 0) input.unavailable.splice(i, 1)
  else input.unavailable.push(date)
}
</script>

<template>
  <div class="py-2">
    <h2 class="text-base font-semibold">提供资料与需求</h2>
    <p class="mt-1 text-sm text-muted-foreground">只发送你选定的内容，生成后可修改。</p>

    <div class="mt-3 space-y-3">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" :disabled="store.generating || savingSource" @click="fileInput?.click()"><Upload class="size-4" />上传截图</Button>
          <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" aria-label="上传截图" @change="onFiles" />
          <span class="text-xs text-muted-foreground">已选 {{ selectedCount }} / {{ MAX_SELECTED_SOURCES }} 份 · 新图片每批最多 3 份</span>
        </div>
        <div class="mt-2 flex gap-2">
          <Textarea v-model="pasteText" :disabled="store.generating || savingSource" placeholder="粘贴通知、要求或原文…" class="min-h-16 flex-1" />
          <Button size="sm" variant="secondary" class="self-end" :disabled="store.generating || savingSource || !pasteText.trim()" @click="savePaste">保存文字</Button>
        </div>
      </div>

      <div v-if="app.sources.length" class="rounded-md border p-2">
        <div class="text-xs font-medium text-muted-foreground">选择已有资料（勾选即选定）</div>
        <ul class="mt-1 max-h-48 divide-y overflow-y-auto">
          <li v-for="s in app.sources" :key="s.id" class="flex items-center gap-2 py-1 text-sm">
            <input type="checkbox" :checked="input.sourceIds.includes(s.id)" :disabled="store.generating" :aria-label="`选定资料 ${sourceLabel(s)}`" @change="toggleSource(s.id)" />
            <FileImage v-if="s.kind === 'image'" class="size-4 shrink-0 text-muted-foreground" />
            <FileText v-else class="size-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ sourceLabel(s) }}</span>
            <Badge v-if="noteOf(s.id) && noteOf(s.id).status !== 'failed'" variant="secondary">已分析</Badge>
            <Badge v-else-if="s.kind === 'image'" variant="outline">待分析</Badge>
            <span class="text-xs text-muted-foreground">{{ formatWhen(s.captured_at, 'date') }}</span>
          </li>
        </ul>
      </div>

      <div>
        <label class="text-xs font-medium text-muted-foreground" for="assistant-requirement">你想完成什么？有什么要求？</label>
        <Textarea id="assistant-requirement" v-model="input.userText" :disabled="store.generating" :placeholder="DEFAULT_USER_MESSAGE" class="mt-1 min-h-16" />
      </div>

      <div class="rounded-md border p-2">
        <button type="button" class="flex w-full items-center gap-2 text-xs font-medium text-muted-foreground" @click="showRelated = !showRelated">
          <ChevronDown v-if="showRelated" class="size-4" /><ChevronRight v-else class="size-4" />
          关联已有任务（可选）
        </button>
        <div v-if="showRelated" class="mt-2 space-y-2">
          <p v-if="!app.tasks.length" class="text-xs text-muted-foreground">当前空间还没有任务。</p>
          <div v-for="t in app.tasks" :key="t.id" class="rounded border p-2">
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" :checked="input.taskIds.includes(t.id)" :disabled="store.generating" @change="toggleTask(t.id)" />
              <span class="min-w-0 flex-1 truncate">{{ t.title }}</span>
              <Badge variant="outline">{{ t.status }}</Badge>
            </label>
            <ul v-if="input.taskIds.includes(t.id)" class="mt-1 space-y-1 pl-6">
              <li v-for="a in app.actionsOf(t.id)" :key="a.id" class="flex items-center gap-2 text-xs">
                <input type="checkbox" :checked="input.actionIds.includes(a.id)" :disabled="store.generating" :aria-label="`选定行动 ${a.text}`" @change="toggleAction(a.id)" />
                <span class="min-w-0 flex-1 truncate">{{ a.text }}（{{ a.minutes }} 分钟）</span>
                <Badge v-if="a.done" variant="secondary">已完成</Badge>
              </li>
              <li v-if="!app.actionsOf(t.id).length" class="text-xs text-muted-foreground">该任务暂无行动。</li>
            </ul>
          </div>
        </div>
      </div>

      <details class="border-y py-3">
        <summary class="cursor-pointer text-sm font-medium">可用时间 · {{ input.startDate || today }} 起七天 · 共 {{ timeSummary }} <span class="font-normal text-muted-foreground">编辑</span></summary>
        <div class="mt-1 flex items-center gap-2">
          <DateInput v-model="input.startDate" :disabled="store.generating" aria-label="生成排程起始日期" class="w-44" />
          <span class="text-xs text-muted-foreground">留空 = 今天（{{ today }}）</span>
        </div>
        <div class="mt-2 space-y-1">
          <div v-for="date in dates" :key="date" class="flex flex-wrap items-center gap-2 text-sm">
            <span class="w-28 shrink-0 text-xs text-muted-foreground">{{ date }}</span>
            <Input v-model="input.budgets[date]" :disabled="store.generating || input.unavailable.includes(date)" class="h-8 w-24" inputmode="numeric" :placeholder="String(store.formDefaults.budget)" :aria-label="`${date} 预算分钟`" />
            <span class="text-xs text-muted-foreground">分钟</span>
            <label class="ml-auto flex items-center gap-1 text-xs">
              <input type="checkbox" :checked="input.unavailable.includes(date)" :disabled="store.generating" @change="toggleUnavailable(date)" />不可用
            </label>
          </div>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">北京时间；留空默认每天 {{ store.formDefaults.budget }} 分钟。</p>
      </details>

      <div class="flex items-center gap-2">
        <Button :disabled="!canGenerate" @click="store.generate()"><Sparkles class="size-4" />生成方案</Button>
        <span v-if="store.generating" class="text-xs text-muted-foreground">生成进行中，重复点击不会产生并行请求。</span>
      </div>
      <p v-if="pasteText.trim()" class="text-xs text-muted-foreground">请先保存上方文字，再生成方案。</p>

      <GenerationPanel />
    </div>
  </div>
</template>
