<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import TaskCreateFields from './TaskCreateFields.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useAppStore } from '@/stores/app'

const emit = defineEmits(['saved', 'close'])
const props = defineProps({ initialMatter: { type: String, default: '' } })
const app = useAppStore()
const workspace = app.workspaceId
const title = ref('')
const deadline = ref('')
const matter = ref(props.initialMatter)
const saving = ref(false)
const discardOpen = ref(false)
const dirty = computed(() => !!(title.value || deadline.value || matter.value !== props.initialMatter))
let leaveResolve = null
function settleLeave(allow) {
  const resolve = leaveResolve
  leaveResolve = null
  if (allow) { title.value = ''; deadline.value = ''; matter.value = props.initialMatter }
  resolve?.(allow)
}
watch(discardOpen, (open) => { if (!open) settleLeave(false) })
function guardLeave() {
  if (saving.value) { app.say('info', '正在保存，请稍候'); return Promise.resolve(false) }
  if (!dirty.value) return Promise.resolve(true)
  if (leaveResolve) return Promise.resolve(false)
  discardOpen.value = true
  return new Promise((resolve) => { leaveResolve = resolve })
}
async function close() { if (await guardLeave()) emit('close') }
async function save() {
  if (saving.value || app.workspaceId !== workspace) return
  saving.value = true
  try {
    const result = await app.createStandaloneTask({ title: title.value, value: deadline.value, matterId: matter.value || null })
    if (result.ok && app.workspaceId === workspace) {
      title.value = ''; deadline.value = ''; matter.value = props.initialMatter
      emit('saved', result.id)
    }
  } finally { saving.value = false }
}
function beforeUnload(event) {
  if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = '' }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); settleLeave(false) })
defineExpose({ guardLeave })
</script>

<template>
  <form class="space-y-4 rounded-lg border bg-card p-4" aria-label="新建任务" @submit.prevent="save">
    <h2 class="text-base font-semibold">新建任务</h2>
    <TaskCreateFields v-model:title="title" v-model:deadline="deadline" v-model:matter="matter" :disabled="saving" />
    <div class="flex gap-2"><Button type="submit" :disabled="saving || !title.trim()">{{ saving ? '保存中…' : '创建任务' }}</Button><Button type="button" variant="ghost" :disabled="saving" @click="close">取消</Button></div>
  </form>
  <ConfirmDialog v-model="discardOpen" title="放弃未保存的任务？" confirm-label="放弃修改" cancel-label="继续编辑" @confirm="settleLeave(true)">任务内容尚未保存。</ConfirmDialog>
</template>
