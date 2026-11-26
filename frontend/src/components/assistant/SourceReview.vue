<script setup>
// M2 资料核对区：原图/摘录 + 分析便签字段逐项核对。
// 字段确认是独立资料核对（确认≠改值），不写入 M1 采用写集；采用前的任务截止另在核对区确认。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { FileImage, FileText } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import { useAppStore } from '@/stores/app'
import { canConfirm } from '@/domains/note'

const props = defineProps({
  draft: { type: Object, required: true },
})
const app = useAppStore()

const STATUS_LABELS = { candidate: '候选', confirmed: '已确认', missing: '缺失' }
const entries = computed(() => (props.draft.source_refs ?? [])
  .filter((r) => r.object_type === 'source')
  .map((r) => {
    const source = app.sources.find((s) => s.id === r.id) ?? null
    const note = source ? app.notes.find((n) => n.source_id === source.id) ?? null : null
    return { id: r.id, source, note }
  }))

// 原图缩略图：object URL 随条目变化重建并回收，避免泄漏。
const urls = ref({})
watch(entries, (list) => {
  const next = {}
  for (const e of list) {
    if (e.source?.kind === 'image' && e.source.blob) next[e.id] = URL.createObjectURL(e.source.blob)
  }
  for (const u of Object.values(urls.value)) URL.revokeObjectURL(u)
  urls.value = next
}, { immediate: true })
onBeforeUnmount(() => { for (const u of Object.values(urls.value)) URL.revokeObjectURL(u) })

const formatValue = (v) => {
  if (v == null) return '（空）'
  if (Array.isArray(v)) return v.map(formatValue).join('；')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
const sourceLabel = (s) => {
  if (!s) return '资料已不存在'
  if (s.kind === 'text') {
    const line = String(s.text || '').split('\n').map((x) => x.trim()).find(Boolean)
    return line ? (line.length > 30 ? `${line.slice(0, 30)}…` : line) : '文本摘录'
  }
  return s.name || '未命名截图'
}
</script>

<template>
  <div v-if="entries.length" class="rounded-lg border bg-card p-4">
    <h3 class="flex items-center gap-2 text-sm font-semibold"><FileImage class="size-4" />核对资料</h3>
    <p class="mt-1 text-xs text-muted-foreground">对照原文确认事实，任务截止在下方单独核对。</p>
    <div v-for="e in entries" :key="e.id" class="mt-3 rounded-md border p-3">
      <div class="flex items-center gap-2 text-sm font-medium">
        <FileImage v-if="e.source?.kind === 'image'" class="size-4 text-muted-foreground" />
        <FileText v-else class="size-4 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ sourceLabel(e.source) }}</span>
        <Badge v-if="e.note?.status === 'failed'" variant="warning">分析失败</Badge>
      </div>
      <img v-if="urls[e.id]" :src="urls[e.id]" :alt="`原图：${sourceLabel(e.source)}`" class="mt-2 max-h-64 rounded border object-contain" />
      <details v-if="e.source?.kind === 'text'" class="mt-2 text-xs">
        <summary class="cursor-pointer text-muted-foreground">展开本地原文</summary>
        <pre class="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-muted p-2">{{ e.source.text }}</pre>
      </details>
      <p v-if="!e.note" class="mt-2 text-xs text-muted-foreground">尚无分析便签（文字资料以选定摘录为准）。</p>
      <ul v-else class="mt-2 space-y-2">
        <li v-for="f in e.note.fields" :key="f.key" class="rounded border p-2 text-sm">
          <div class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground">{{ f.key }}</span>
            <Badge :variant="f.status === 'confirmed' ? 'success' : f.status === 'missing' ? 'secondary' : 'outline'">{{ STATUS_LABELS[f.status] ?? f.status }}</Badge>
            <Badge v-if="f.origin === 'user'" variant="secondary">用户改过</Badge>
            <Badge v-if="f.derived" variant="outline">推算</Badge>
            <span class="flex-1" />
            <Button v-if="canConfirm(f)" size="sm" variant="secondary" @click="app.confirmField(e.note, f.key)">确认为事实</Button>
          </div>
          <div class="mt-1 break-words">{{ formatValue(f.value) }}</div>
          <div v-if="f.raw" class="mt-1 text-xs text-muted-foreground">识别原文：{{ f.raw }}</div>
          <div v-if="f.quote?.text" class="mt-1 text-xs text-muted-foreground">引用：{{ f.quote.text }}</div>
        </li>
      </ul>
    </div>
  </div>
</template>
