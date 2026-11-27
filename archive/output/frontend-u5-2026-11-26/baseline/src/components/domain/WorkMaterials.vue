<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { ImageOff } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import { getSource } from '@/services/storage/db'
import { useAppStore } from '@/stores/app'
import { taskMaterials } from '@/domains/work'
import { FIELD_LABELS, STATUS_LABELS, label } from '@/domains/labels'
import { formatWhen } from '@/domains/time'

// 执行页只读资料：Task.note_ids → 便签 → 原始 Source；同事项补充默认折叠。
// 全部只读：无字段确认/AI 重跑/编辑原文入口。异步加载捕获 ws/session/task 身份，
// 迟到的旧资料不进新会话；Blob URL 在身份变化与卸载时回收。
const props = defineProps({
  task: { type: Object, default: null },
  ws: { type: String, required: true },
  sessionId: { type: String, required: true },
})
const app = useAppStore()

const direct = ref([])
const extra = ref([])
const extraOpen = ref(false)
// sourceId → { kind, url?, text?, missing }
const originals = ref({})
let urls = []
let loadToken = 0

function revokeAll() {
  for (const u of urls) URL.revokeObjectURL(u)
  urls = []
}

const fieldValue = (f) => {
  if (f.key === 'time_nodes' && Array.isArray(f.value)) {
    return f.value.map((n) => `${n.label || '节点'}：${n.value ? formatWhen(n.value, n.precision) : '未定'}`).join('\n')
  }
  if (Array.isArray(f.value)) return f.value.join('\n')
  if (f.key === 'deadline' && f.value) return formatWhen(f.value, f.precision || (String(f.value).includes('T') ? 'datetime' : 'date'))
  return f.value == null ? '' : String(f.value)
}
const visibleFields = (note) => (note.fields || []).filter((f) => f.status !== 'missing' && fieldValue(f))

async function load() {
  const token = ++loadToken
  const { ws, sessionId } = props
  const task = props.task
  revokeAll()
  originals.value = {}
  const m = taskMaterials(task, app.notes, app.matters)
  direct.value = m.direct
  extra.value = m.extra
  const notes = [...m.direct, ...m.extra].map((x) => x.note).filter(Boolean)
  for (const n of notes) {
    if (!n.source_id) continue
    const res = await getSource(n.source_id)
    // 迟到守卫：空间/会话/任务已变 → 丢弃，不污染当前执行页。
    if (token !== loadToken || props.ws !== ws || props.sessionId !== sessionId) return
    if (res.workspace_id !== ws || !res.record) {
      originals.value = { ...originals.value, [n.source_id]: { missing: true } }
      continue
    }
    const s = res.record
    if (s.kind === 'image' && s.blob) {
      const url = URL.createObjectURL(s.blob)
      urls.push(url)
      originals.value = { ...originals.value, [n.source_id]: { kind: 'image', url } }
    } else if (s.kind === 'text') {
      originals.value = { ...originals.value, [n.source_id]: { kind: 'text', text: s.text } }
    } else {
      originals.value = { ...originals.value, [n.source_id]: { missing: true } }
    }
  }
}

watch(() => [props.task && props.task.id, props.ws, props.sessionId], load, { immediate: true })
onBeforeUnmount(() => {
  loadToken += 1
  revokeAll()
})
</script>

<template>
  <div class="space-y-3">
    <p v-if="!task" class="text-sm text-muted-foreground">原任务已删除，无法解析关联资料；历史成果仍可在正文查看。</p>
    <template v-else>
      <p v-if="!direct.length" class="text-sm text-muted-foreground">本任务没有关联便签（独立任务可直接执行）。</p>
      <div v-for="item in direct" :key="item.id" class="rounded-md border p-2.5">
        <template v-if="item.note">
          <div class="break-words text-sm font-medium">{{ item.note.title }}</div>
          <div v-if="visibleFields(item.note).length" class="mt-1.5 space-y-1.5">
            <div v-for="f in visibleFields(item.note)" :key="f.key" class="text-xs">
              <span class="text-muted-foreground">{{ label(FIELD_LABELS, f.key) }}</span>
              <Badge v-if="f.status === 'confirmed'" variant="success" class="ml-1">已确认</Badge>
              <Badge v-else variant="warning" class="ml-1" :title="label(STATUS_LABELS, f.status)">未确认</Badge>
              <div class="mt-0.5 whitespace-pre-wrap break-words">{{ fieldValue(f) }}</div>
            </div>
          </div>
          <p v-else class="mt-1 text-xs text-muted-foreground">便签暂无可展示字段。</p>
          <template v-if="item.note.source_id && originals[item.note.source_id]">
            <img
              v-if="originals[item.note.source_id].kind === 'image'"
              :src="originals[item.note.source_id].url"
              alt="原始截图"
              class="mt-2 max-h-72 w-full rounded-md border object-contain"
            />
            <pre v-else-if="originals[item.note.source_id].kind === 'text'" class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{{ originals[item.note.source_id].text }}</pre>
            <p v-else class="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><ImageOff class="size-3.5" />原始资料已缺失</p>
          </template>
          <p v-else-if="item.note.source_id" class="mt-2 text-xs text-muted-foreground">正在读取原始资料…</p>
        </template>
        <p v-else class="flex items-center gap-1 text-sm text-muted-foreground"><ImageOff class="size-3.5" />关联便签已删除或不可用</p>
      </div>

      <div v-if="extra.length" class="border-t border-dashed pt-2">
        <button type="button" class="text-sm font-medium underline" :aria-expanded="extraOpen" @click="extraOpen = !extraOpen">
          同事项补充资料 · {{ extra.length }}（{{ extraOpen ? '收起' : '展开' }}）
        </button>
        <div v-if="extraOpen" class="mt-2 space-y-3">
          <div v-for="item in extra" :key="item.id" class="rounded-md border p-2.5">
            <template v-if="item.note">
              <div class="break-words text-sm font-medium">{{ item.note.title }}</div>
              <div v-if="visibleFields(item.note).length" class="mt-1.5 space-y-1.5">
                <div v-for="f in visibleFields(item.note)" :key="f.key" class="text-xs">
                  <span class="text-muted-foreground">{{ label(FIELD_LABELS, f.key) }}</span>
                  <Badge v-if="f.status === 'confirmed'" variant="success" class="ml-1">已确认</Badge>
                  <Badge v-else variant="warning" class="ml-1">未确认</Badge>
                  <div class="mt-0.5 whitespace-pre-wrap break-words">{{ fieldValue(f) }}</div>
                </div>
              </div>
              <template v-if="item.note.source_id && originals[item.note.source_id]">
                <img
                  v-if="originals[item.note.source_id].kind === 'image'"
                  :src="originals[item.note.source_id].url"
                  alt="原始截图"
                  class="mt-2 max-h-72 w-full rounded-md border object-contain"
                />
                <pre v-else-if="originals[item.note.source_id].kind === 'text'" class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">{{ originals[item.note.source_id].text }}</pre>
                <p v-else class="mt-2 text-xs text-muted-foreground">原始资料已缺失</p>
              </template>
            </template>
            <p v-else class="text-sm text-muted-foreground">关联便签已删除或不可用</p>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>