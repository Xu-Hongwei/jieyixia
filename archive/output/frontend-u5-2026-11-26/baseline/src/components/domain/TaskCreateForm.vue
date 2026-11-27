<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import DateInput from '@/components/ui/DateInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useAppStore } from '@/stores/app'

const emit = defineEmits(['saved', 'close'])
const app = useAppStore()
const workspace = app.workspaceId
const title = ref('')
const deadline = ref('')
const matter = ref('')
const saving = ref(false)
const discardOpen = ref(false)
const dirty = computed(() => !!(title.value || deadline.value || matter.value))
let leaveResolve = null
function settleLeave(allow) {
  const resolve = leaveResolve
  leaveResolve = null
  if (allow) { title.value = ''; deadline.value = ''; matter.value = '' }
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
      title.value = ''; deadline.value = ''; matter.value = ''
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
    <label class="block space-y-1 text-sm">任务名称<Input v-model="title" aria-label="新任务名称" :disabled="saving" placeholder="要完成什么？" /></label>
    <div class="flex flex-wrap gap-4">
      <div class="min-w-0 space-y-1 text-sm"><div>截止日期（可选）</div><DateInput v-model="deadline" allow-time aria-label="新任务截止" placeholder="无截止" :disabled="saving" /></div>
      <label class="min-w-0 space-y-1 text-sm"><span class="block">事项</span><select v-model="matter" aria-label="新任务事项" :disabled="saving" class="h-9 max-w-full rounded-md border bg-transparent px-2"><option value="">未归组</option><option v-for="item in app.matters" :key="item.id" :value="item.id">{{ item.title }}</option></select></label>
    </div>
    <div class="flex gap-2"><Button type="submit" :disabled="saving || !title.trim()">{{ saving ? '保存中…' : '创建任务' }}</Button><Button type="button" variant="ghost" :disabled="saving" @click="close">取消</Button></div>
  </form>
  <ConfirmDialog v-model="discardOpen" title="放弃未保存的任务？" confirm-label="放弃修改" cancel-label="继续编辑" @confirm="settleLeave(true)">任务内容尚未保存。</ConfirmDialog>
</template>
