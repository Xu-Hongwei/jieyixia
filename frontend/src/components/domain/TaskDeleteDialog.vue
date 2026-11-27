<script setup>
import { computed, ref, watch } from 'vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import DeleteImpact from './DeleteImpact.vue'
import { deleteImpactSnapshot } from '@/domains/matter'
import { useAppStore } from '@/stores/app'

const props = defineProps({
  task: { type: Object, default: null },
  save: { type: Function, default: (operation) => operation() },
})
const emit = defineEmits(['deleted', 'goto-plan', 'goto-work'])
const store = useAppStore()
const open = ref(false)
const facts = ref(null)
const busy = ref(false)
const changed = ref(false)
const blocked = computed(() => facts.value?.rows.some(row => row.disposition.startsWith('blocked')))

function show(scopeChanged = false) {
  const task = props.task
  if (!task || busy.value) return
  const sessions = store.docs.filter(d => d.kind === 'focus_session')
  facts.value = {
    ...deleteImpactSnapshot(store.docs, [task.id], sessions),
    taskIds: [task.id], actionIds: store.actionsOf(task.id).map(a => a.id),
  }
  changed.value = scopeChanged
  open.value = true
}
watch([() => props.task?.id, () => store.workspaceId], () => { open.value = false })

async function confirm() {
  const task = props.task
  const scope = facts.value
  if (busy.value || blocked.value || !task || scope?.taskIds[0] !== task.id) return
  const workspace = store.workspaceId
  busy.value = true
  open.value = false
  let refresh = false
  try {
    const result = await props.save(() => store.deleteTask(task, scope))
    if (workspace !== store.workspaceId) return
    if (result?.ok) emit('deleted')
    else if (result?.scopeChanged || result?.planProgressRequired || result?.unfinishedFocus) {
      await store.reloadDocs()
      refresh = workspace === store.workspaceId && task.id === props.task?.id
    }
  } finally {
    busy.value = false
  }
  if (refresh) show(true)
}
defineExpose({ show })
</script>

<template>
  <ConfirmDialog v-model="open" title="删除任务" confirm-label="删除任务" :confirm-disabled="blocked || busy" @confirm="confirm">
    <p v-if="changed" class="mb-2 text-warning-foreground">任务的关联内容已变化，请重新核对。</p>
    <p>将删除整个任务「{{ task?.title }}」<template v-if="facts?.actionIds.length">及其 {{ facts.actionIds.length }} 个行动</template>。可在日程的「恢复入口」撤销。</p>
    <DeleteImpact :rows="facts?.rows || []" @goto-plan="row => { open = false; emit('goto-plan', row) }" @goto-work="row => { open = false; emit('goto-work', row) }" />
  </ConfirmDialog>
</template>
