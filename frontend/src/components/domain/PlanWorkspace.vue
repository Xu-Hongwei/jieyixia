<script setup>
import { computed, ref, watch } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle } from 'reka-ui'
import { X } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import PlanEditor from './PlanEditor.vue'
import PlanDetail from './PlanDetail.vue'

const props = defineProps({ editor: { type: Object, default: null }, planId: { type: String, default: '' } })
const emit = defineEmits(['close', 'saved', 'edit', 'move', 'another', 'op-done'])
const open = computed(() => !!(props.editor || props.planId))
const editorRef = ref(null)
let opener = null
let pendingLeave = null
let closing = false
watch(open, (value) => { if (value && document.activeElement instanceof HTMLElement) opener = document.activeElement })
async function guardLeave() {
  if (pendingLeave) return pendingLeave
  pendingLeave = (async () => {
    if (props.editor && editorRef.value && !(await editorRef.value.guardLeave())) return false
    return true
  })()
  try { return await pendingLeave } finally { pendingLeave = null }
}
async function close() {
  if (closing) return
  closing = true
  try { if (await guardLeave()) emit('close') } finally { closing = false }
}
function restoreFocus(event) {
  event.preventDefault()
  if (opener?.isConnected) opener.focus({ preventScroll: true })
}
defineExpose({ guardLeave })
</script>

<template>
  <DialogRoot :open="open" @update:open="value => { if (!value) close() }">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[45] bg-black/25" />
      <DialogContent class="fixed z-[45] panel-scroll w-full overflow-y-auto overscroll-contain bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl outline-none" :class="editor ? 'inset-y-0 right-0 h-dvh border-l sm:max-w-xl' : 'plan-inspector'" :aria-describedby="undefined" @close-auto-focus="restoreFocus">
        <div class="mb-3 flex items-center justify-end gap-3">
          <DialogTitle :class="editor ? 'sr-only' : 'mr-auto text-sm font-medium text-muted-foreground'">{{ editor ? '编辑工作安排' : '工作安排详情' }}</DialogTitle>
          <Button size="icon" variant="ghost" aria-label="关闭工作面板" @click="close"><X /></Button></div>
        <PlanEditor v-if="editor" :key="editor.key" ref="editorRef" :mode="editor.mode" :plan-id="editor.planId || ''" :task-id="editor.taskId || ''" :date="editor.date || ''" :lock-task="!!(editor.locked || editor.taskId)" :show-close="false" @edit="id => emit('edit', id)" @saved="payload => emit('saved', payload)" @close="emit('close')" />
        <PlanDetail v-if="!editor && planId" :key="planId" :plan-id="planId" :show-close="false" @close="close" @edit="id => emit('edit', id)" @move="id => emit('move', id)" @another="id => emit('another', id)" @op-done="payload => emit('op-done', payload)" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.plan-inspector { inset: auto 0 0; max-height: 88dvh; border-radius: 1rem 1rem 0 0; }
@media (min-width: 640px) {
  .plan-inspector { inset: 4.5rem 1.25rem auto auto; width: 25rem; max-height: calc(100dvh - 6rem); border: 1px solid var(--border); border-radius: .85rem; padding: 1.25rem; }
}
</style>
