<script setup>
import { computed } from 'vue'
import Badge from '@/components/ui/Badge.vue'
import { useTaskColors } from '@/composables/useTaskProject'
import { useAppStore } from '@/stores/app'
import { usePlanStore } from '@/stores/plan'
import { deadlineSlot, slotDeadlineLabel, weekStartOf } from '@/domains/week'
import { planActualLabel } from '@/domains/labels'

// 上方「每日工作」卡片：工作说明为主、任务名为辅；预计/实际分开，异常→待核对。
// 整卡点击进入安排详情，不放常驻按钮行。
const props = defineProps({
  plan: { type: Object, required: true },
  calendar: Boolean,
  task: { type: Object, default: null },
})
const emit = defineEmits(['open'])
const store = useAppStore()
const planStore = usePlanStore()
const colors = useTaskColors()
const project = computed(() => colors.projectFor(props.task))
const ownerLabel = computed(() => project.value?.title || (props.task?.title && props.task.title !== props.plan.action_text ? '独立任务 · ' + props.task.title : '独立任务'))
const deadlineOutsideWeek = computed(() => {
  const slot = deadlineSlot(props.task?.deadline)
  return slot && weekStartOf(slot.day) !== weekStartOf(props.plan.date)
})

const summary = computed(() => planStore.summary(props.plan.id))
const risk = computed(() => (props.task ? planStore.riskFor(props.task.id, props.plan.date, new Date(store.nowTick)) : null))
const deadlineLabel = computed(() => (props.task ? slotDeadlineLabel(props.task.deadline) : ''))
const lateRisk = computed(() => !!risk.value && (risk.value.kind === 'after_deadline' || risk.value.overdue))
</script>

<template>
  <button
    type="button"
    class="w-full rounded-md border-l-2 border-primary/55 bg-secondary px-2.5 py-2.5 text-left transition-colors hover:border-primary/50"
    :aria-label="calendar ? undefined : `安排详情：${props.plan.action_text}`"
    :class="calendar && 'calendar-project-card'"
    :data-project-tone="calendar ? colors.toneFor(task) : undefined"
    @click="emit('open', props.plan.id)"
  >
    <div v-if="calendar" class="flex items-baseline justify-between gap-2">
      <span class="min-w-0 truncate text-xs font-medium" :title="ownerLabel">{{ ownerLabel }}</span>
      <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ plan.planned_minutes }} 分</span>
    </div>
    <div class="line-clamp-2 break-words text-sm font-medium leading-snug" :class="calendar && 'mt-1'">{{ props.plan.action_text }}</div>

    <div v-if="!calendar" class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <span v-if="!props.task || props.task.title !== props.plan.action_text" class="min-w-0 truncate">{{ props.task ? props.task.title : '原任务已删除' }}</span>
      <span class="whitespace-nowrap">预计 {{ props.plan.planned_minutes }} 分</span>
      <span v-if="!summary || (summary.authoritative && summary.actualMinutes != null)">实际 {{ planActualLabel(summary) }}</span>
      <Badge v-if="props.plan.state === 'partial'" variant="secondary" class="px-1 py-0 text-xs">部分完成</Badge>
      <Badge v-if="summary && !summary.authoritative" variant="warning" class="px-1 py-0 text-xs">待核对</Badge>
      <Badge v-if="summary && summary.cacheMismatch" variant="warning" class="px-1 py-0 text-xs" title="缓存与明细不一致：仅提示，不自动改写">缓存差异</Badge>
    </div>
    <div
      v-if="calendar ? lateRisk || deadlineOutsideWeek : deadlineLabel || (risk && risk.kind !== 'no_deadline')"
      class="mt-0.5 break-words text-xs leading-snug"
      :class="lateRisk ? 'text-destructive' : 'text-muted-foreground'"
    >
      {{ deadlineLabel }}<template v-if="risk && risk.kind === 'after_deadline'"> · 晚于截止</template><template v-else-if="risk && risk.overdue"> · 已逾期</template><template v-else-if="risk && (risk.kind === 'due_same_day' || risk.kind === 'due_same_day_timed')"> · 当日截止</template>
    </div>
    <span v-if="calendar && (plan.state === 'partial' || !summary?.authoritative || summary.cacheMismatch)" class="text-xs text-muted-foreground">{{ !summary?.authoritative || summary.cacheMismatch ? '待核对' : '部分完成' }}</span>
  </button>
</template>
