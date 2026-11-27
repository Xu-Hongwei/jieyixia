<script setup>
import { slotClock } from '@/domains/week'
import { computed } from 'vue'
import { useTaskColors } from '@/composables/useTaskProject'

// 下方「每日截止」卡片：任务标题 + 北京钟点；仅日期截止显示「当日截止」（不是「时间未定」）。
// 逾期红标、完成淡化；整卡点击进入任务详情。
const props = defineProps({
  entry: { type: Object, required: true },
})
const emit = defineEmits(['open'])
const colors = useTaskColors()
const project = computed(() => colors.projectFor(props.entry.task))
</script>

<template>
  <button
    type="button"
    class="calendar-project-card w-full rounded-md px-2.5 py-2.5 text-left transition-colors"
    :data-project-tone="colors.toneFor(entry.task)"
    @click="emit('open', props.entry.task.id)"
  >
    <div class="truncate text-xs font-medium" :title="project?.title">{{ project?.title || '独立任务' }}</div>
    <div class="my-0.5 line-clamp-2 break-words text-sm font-medium leading-snug" :class="props.entry.done && 'line-through text-muted-foreground'">{{ props.entry.task.title }}</div>
    <div class="flex items-baseline gap-1.5">
      <span class="font-date text-xs font-semibold" :class="props.entry.overdue && !props.entry.done ? 'text-destructive' : 'text-muted-foreground'">
        任务截止 {{ slotClock(props.entry.minutes) }}
      </span>
      <span v-if="props.entry.done" class="text-xs font-medium text-success-foreground">已完成</span>
      <span v-else-if="props.entry.overdue" class="text-xs font-medium text-destructive">已逾期</span>
    </div>
  </button>
</template>
