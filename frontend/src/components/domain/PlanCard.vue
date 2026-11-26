<script setup>
import { computed } from 'vue'
import Badge from '@/components/ui/Badge.vue'
import { useAppStore } from '@/stores/app'
import { usePlanStore } from '@/stores/plan'
import { slotDeadlineLabel } from '@/domains/week'
import { planActualLabel } from '@/domains/labels'

// 上方「每日工作」卡片：工作说明为主、任务名为辅；预计/实际分开，异常→待核对。
// 整卡点击进入安排详情，不放常驻按钮行。
const props = defineProps({
  plan: { type: Object, required: true },
  task: { type: Object, default: null },
})
const emit = defineEmits(['open'])
const store = useAppStore()
const planStore = usePlanStore()

const summary = computed(() => planStore.summary(props.plan.id))
const risk = computed(() => (props.task ? planStore.riskFor(props.task.id, props.plan.date, new Date(store.nowTick)) : null))
const deadlineLabel = computed(() => (props.task ? slotDeadlineLabel(props.task.deadline) : ''))
const lateRisk = computed(() => !!risk.value && (risk.value.kind === 'after_deadline' || risk.value.overdue))
</script>

<template>
  <button
    type="button"
    class="w-full rounded-md border border-border/70 bg-background px-2 py-1.5 text-left transition-colors hover:border-primary/50"
    :aria-label="`安排详情：${props.plan.action_text}`"
    @click="emit('open', props.plan.id)"
  >
    <div class="line-clamp-2 break-words text-sm font-medium leading-snug">{{ props.plan.action_text }}</div>
    <div class="mt-0.5 truncate text-xs text-muted-foreground">{{ props.task ? props.task.title : '原任务已删除' }}</div>
    <div class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
      <span class="font-date">预计 {{ props.plan.planned_minutes }} 分</span>
      <span>· 实际 {{ planActualLabel(summary) }}</span>
      <Badge v-if="props.plan.state === 'partial'" variant="secondary" class="px-1 py-0 text-[10px]">部分完成</Badge>
      <Badge v-if="summary && !summary.authoritative" variant="warning" class="px-1 py-0 text-[10px]">待核对</Badge>
      <Badge v-if="summary && summary.cacheMismatch" variant="warning" class="px-1 py-0 text-[10px]" title="缓存与明细不一致：仅提示，不自动改写">缓存差异</Badge>
    </div>
    <div
      v-if="deadlineLabel || (risk && risk.kind !== 'no_deadline')"
      class="mt-0.5 break-words text-[11px] leading-snug"
      :class="lateRisk ? 'text-destructive' : 'text-muted-foreground'"
    >
      {{ deadlineLabel }}<template v-if="risk && risk.kind === 'after_deadline'"> · 晚于截止</template><template v-else-if="risk && risk.overdue"> · 已逾期</template><template v-else-if="risk && (risk.kind === 'due_same_day' || risk.kind === 'due_same_day_timed')"> · 当日截止</template>
    </div>
  </button>
</template>