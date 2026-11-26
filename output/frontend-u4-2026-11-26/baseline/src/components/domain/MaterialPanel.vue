<script setup>
import { computed, ref, watch } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle } from 'reka-ui'
import { X } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import NoteReview from './NoteReview.vue'
import { useAppStore } from '@/stores/app'
import { getSource } from '@/services/storage/db'

const props = defineProps({ sourceId: { type: String, default: '' }, nextId: { type: String, default: '' }, returnTo: { type: String, default: '' } })
const emit = defineEmits(['close', 'open-note'])
const app = useAppStore()
const review = ref(null)
const source = ref(null)
const imageUrl = ref(null)
const loading = ref(false)
const note = computed(() => app.notes.find(n => n.source_id === props.sourceId))
let opener = null
watch(() => !!props.sourceId, (open) => { if (open && document.activeElement instanceof HTMLElement) opener = document.activeElement })
watch([() => props.sourceId, () => app.workspaceId], async ([id, ws], _, onCleanup) => {
  let cancelled = false
  let url = null
  onCleanup(() => { cancelled = true; if (url) URL.revokeObjectURL(url) })
  source.value = null; imageUrl.value = null; loading.value = !!id
  if (!id) return
  const result = await getSource(id)
  if (cancelled || ws !== app.workspaceId) return
  loading.value = false
  if (result.workspace_id !== ws || !result.record) return
  source.value = result.record
  if (source.value.kind === 'image' && source.value.blob) {
    url = URL.createObjectURL(source.value.blob); imageUrl.value = url
  }
}, { immediate: true })
async function guardLeave() { return !app.busy && (review.value ? await review.value.guardLeave() : true) }
async function close() { if (await guardLeave()) emit('close') }
async function analyze() {
  if (!source.value || app.busy) return
  await app.runAnalysis(source.value.id, '')
}
function restoreFocus(event) {
  event.preventDefault()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
}
defineExpose({ guardLeave })
</script>

<template>
  <DialogRoot :open="!!sourceId" @update:open="value => { if (!value) close() }">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[45] bg-black/25" />
      <DialogContent class="fixed inset-y-0 right-0 z-[45] h-dvh w-full overflow-y-auto overscroll-contain border-l bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl outline-none sm:max-w-2xl" :aria-describedby="undefined" @close-auto-focus="restoreFocus">
        <DialogTitle class="sr-only">资料详情</DialogTitle>
        <div class="mb-3 flex justify-end"><Button variant="ghost" size="icon" aria-label="关闭资料详情" @click="close"><X /></Button></div>
        <NoteReview v-if="note" ref="review" embedded :note-id="note.id" :next-id="nextId" :return-to="returnTo" @open-note="id => emit('open-note', id)" />
        <div v-else-if="source" class="space-y-4">
          <h2 class="break-words text-lg font-semibold">{{ source.kind === 'image' ? source.name : '文字资料' }}</h2>
          <img v-if="imageUrl" :src="imageUrl" alt="原始截图" class="max-h-[60vh] w-full rounded-md object-contain" />
          <pre aria-label="原始文字资料" v-else class="whitespace-pre-wrap break-words text-sm">{{ source.text }}</pre>
          <div class="border-t pt-3"><Button v-if="!app.aiDown" :disabled="app.busy" @click="analyze">{{ app.busy ? '正在提取…' : '提取资料信息' }}</Button><p class="mt-2 text-xs text-muted-foreground">{{ app.aiDown ? '当前离线，可查看已保存资料。' : '提取时将这份资料发送给模型，结果需要你核对。' }}</p></div>
        </div>
        <p v-else class="text-sm text-muted-foreground">{{ loading ? '正在读取资料…' : '资料已不存在或不属于当前空间。' }}</p>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
