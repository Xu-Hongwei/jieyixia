<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle } from 'reka-ui'
import { X } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import PlanEditor from './PlanEditor.vue'
import PlanDetail from './PlanDetail.vue'
import TaskCreateForm from './TaskCreateForm.vue'

const props = defineProps({ editor: { type: Object, default: null }, planId: { type: String, default: '' } })
const emit = defineEmits(['close', 'saved', 'edit', 'move', 'another', 'op-done'])
const open = computed(() => !!(props.editor || props.planId))
const editorRef = ref(null)
const taskRef = ref(null)
const creatingTask = ref(false)
const taskSaved = ref(false)
let opener = null
let pendingLeave = null
let closing = false
watch(open, (value) => { if (value && document.activeElement instanceof HTMLElement) opener = document.activeElement })
watch(() => props.editor?.key, () => { creatingTask.value = false; taskSaved.value = false })
async function guardLeave() {
  if (pendingLeave) return pendingLeave
  pendingLeave = (async () => {
    if (creatingTask.value && taskRef.value && !(await taskRef.value.guardLeave())) return false
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
async function returnToEditor() {
  creatingTask.value = false
  await nextTick()
  const input = document.querySelector('[aria-label="工作说明"]')
  if (input instanceof HTMLElement) input.focus()
}
async function onTaskSaved(id) {
  editorRef.value?.selectCreatedTask(id)
  taskSaved.value = true
  await returnToEditor()
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
      <DialogContent class="fixed inset-y-0 right-0 z-[45] panel-scroll h-dvh w-full overflow-y-auto overscroll-contain border-l bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-xl outline-none sm:max-w-xl" :aria-describedby="undefined" @close-auto-focus="restoreFocus">
        <DialogTitle class="sr-only">{{ creatingTask ? '新建任务并继续安排' : editor ? '编辑工作安排' : '工作安排详情' }}</DialogTitle>
        <div class="mb-3 flex justify-end"><Button size="icon" variant="ghost" aria-label="关闭工作面板" @click="close"><X /></Button></div>
        <p v-if="taskSaved && !creatingTask" class="mb-3 text-sm text-muted-foreground" role="status">任务已保存。取消安排不会删除任务。</p>
        <PlanEditor v-if="editor" v-show="!creatingTask" :key="editor.key" ref="editorRef" :mode="editor.mode" :plan-id="editor.planId || ''" :task-id="editor.taskId || ''" :date="editor.date || ''" :lock-task="!!(editor.locked || editor.taskId)" :show-close="false" inline-create @edit="id => emit('edit', id)" @goto-create-task="creatingTask = true" @saved="payload => emit('saved', payload)" @close="emit('close')" />
        <TaskCreateForm v-if="creatingTask" ref="taskRef" @saved="onTaskSaved" @close="returnToEditor" />
        <PlanDetail v-if="!editor && planId" :plan-id="planId" :show-close="false" @close="close" @edit="id => emit('edit', id)" @move="id => emit('move', id)" @another="id => emit('another', id)" @op-done="payload => emit('op-done', payload)" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
