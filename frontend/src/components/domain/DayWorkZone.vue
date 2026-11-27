<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PlanCard from '@/components/domain/PlanCard.vue'
import { PLAN_STATE_LABELS, label, planHistoryReasonLabel } from '@/domains/labels'

// 单日「每日工作」区：默认 ≤3 项，展开后限高滚动（周表不被无限拉长）；
// 终态/断引用/任务已完成的旧安排收进「安排历史」，带状态与只读原因，可点开只读详情。
// 定位（5A-2B R4）：待定位安排落在本区时自动展开所在清单并滚入视野。
// 定位标识 = 目标 ID + 所属清单：同区换新目标（true→true 的布尔 watch 会漏）也触发一次；
// 同一目标的后台刷新不重开用户手动收起的清单，手动换日不强制跳回。
const props = defineProps({
  day: { type: Object, required: true },
  locatePlanId: { type: String, default: '' },
})
const emit = defineEmits(['open-plan', 'add'])

const route = useRoute()
const root = ref(null)
const expanded = ref(false)
const historyOpen = ref(false)
const visible = computed(() => (expanded.value ? props.day.plans : props.day.plans.slice(0, 3)))

const locateKey = computed(() => {
  const id = props.locatePlanId
  if (!id) return ''
  if (props.day.plans.some((e) => e.plan.id === id)) return `plans:${id}`
  if (props.day.planHistory.some((e) => e.plan.id === id)) return `history:${id}`
  return ''
})
function reveal() {
  nextTick(() => {
    if (!root.value || !props.locatePlanId) return
    const el = root.value.querySelector(`[data-plan-id="${CSS.escape(props.locatePlanId)}"]`)
    if (route.query.plan) {
      // The open inspector owns the viewport. A deep link can still reveal a
      // card inside its day's expanded list without moving the calendar.
      const list = el?.parentElement
      if (list && list.scrollHeight > list.clientHeight) {
        const cardBounds = el.getBoundingClientRect()
        const listBounds = list.getBoundingClientRect()
        if (cardBounds.top < listBounds.top) list.scrollTop += cardBounds.top - listBounds.top
        else if (cardBounds.bottom > listBounds.bottom) list.scrollTop += cardBounds.bottom - listBounds.bottom
      }
      return
    }
    if (el instanceof HTMLElement && route.query.recorded && !document.querySelector('[role="dialog"]')) el.focus({ preventScroll: true })
    ;(el || root.value).scrollIntoView({ block: 'nearest' })
  })
}
watch(locateKey, (key) => {
  if (!key) return
  if (key.startsWith('plans:')) {
    const idx = props.day.plans.findIndex((e) => e.plan.id === props.locatePlanId)
    if (idx >= 3) expanded.value = true
  } else {
    historyOpen.value = true
  }
  reveal()
}, { immediate: true })
</script>

<template>
  <div ref="root">
    <div class="space-y-1.5" :class="expanded && 'max-h-[22rem] overflow-y-auto scroll-slim'">
      <PlanCard v-for="e in visible" :key="e.plan.id" :plan="e.plan" :task="e.task" :data-plan-id="e.plan.id" @open="emit('open-plan', $event)" />
      <p v-if="!day.plans.length" class="work-empty px-1 pt-2 text-center text-xs text-muted-foreground">未安排工作</p>
    </div>
    <button
      v-if="day.plans.length > 3"
      type="button"
      class="mt-1 w-full rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-accent"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : `还有 ${day.plans.length - 3} 项 · 展开` }}
    </button>

    <div v-if="day.planHistory.length" class="border-t border-dashed border-border pt-1">
      <button
        type="button"
        class="w-full rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-accent"
        :aria-expanded="historyOpen"
        @click="historyOpen = !historyOpen"
      >
        安排历史 {{ day.planHistory.length }} 项 · {{ historyOpen ? '收起' : '展开' }}
      </button>
      <div v-if="historyOpen" class="mt-1 space-y-1">
        <button
          v-for="e in day.planHistory"
          :key="e.plan.id"
          type="button"
          class="w-full rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-left opacity-80 transition-opacity hover:opacity-100"
          :data-plan-id="e.plan.id"
          :aria-label="`安排历史详情：${e.plan.action_text}`"
          @click="emit('open-plan', e.plan.id)"
        >
          <div class="line-clamp-1 break-words text-xs">{{ e.plan.action_text }}</div>
          <div class="text-[10px] text-muted-foreground">{{ label(PLAN_STATE_LABELS, e.plan.state) }} · {{ planHistoryReasonLabel(e.reason) }}</div>
        </button>
      </div>
    </div>
    <button
      type="button"
      class="add-day-work mt-1 w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
      aria-label="在这一天安排工作"
      @click="emit('add')"
    >＋ 安排</button>
  </div>
</template>
