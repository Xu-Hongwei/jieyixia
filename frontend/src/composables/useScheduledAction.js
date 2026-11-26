import { computed, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { workspaceAssistantDrafts } from '@/services/storage/db'
import { adoptedPlanActions } from '@/domains/assistant/scheduledActions'

// 已采用草案保留排程段和正式 ID 映射，旧安排与恢复空间同样可以查回行动。
export function adoptedActionForPlan(drafts, planId) {
  const bindings = adoptedPlanActions(drafts)
  return bindings.has(planId) ? { actionId: bindings.get(planId) } : null
}

export function useScheduledAction(plan, task) {
  const store = useAppStore()
  const binding = ref(null)
  const status = ref('loading')
  watch([() => plan.value?.id, () => store.workspaceId, () => store.ready], async ([id, ws, ready], _, onCleanup) => {
    let active = true
    onCleanup(() => { active = false })
    binding.value = null
    status.value = 'loading'
    if (!id || !ready) return
    try {
      const result = await workspaceAssistantDrafts()
      if (!active || result.workspace_id !== ws) return
      binding.value = adoptedActionForPlan(result.records, id)
      status.value = 'ready'
    } catch {
      if (active) status.value = 'error'
    }
  }, { immediate: true })

  const available = computed(() => task.value ? store.actionsOf(task.value.id).filter(action => !action.done) : [])
  const action = computed(() => {
    if (status.value !== 'ready') return null
    if (binding.value) return available.value.find(item => item.id === binding.value.actionId) ?? null
    return store.currentActionOf(task.value) ?? (available.value.length === 1 ? available.value[0] : null)
  })
  return { action, available, binding, status }
}
