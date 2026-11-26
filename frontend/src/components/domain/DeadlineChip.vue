<script setup>
import { slotClock } from '@/domains/week'

// 下方「每日截止」卡片：任务标题 + 北京钟点；仅日期截止显示「当日截止」（不是「时间未定」）。
// 逾期红标、完成淡化；整卡点击进入任务详情。
const props = defineProps({
  entry: { type: Object, required: true },
})
const emit = defineEmits(['open'])
</script>

<template>
  <button
    type="button"
    class="w-full rounded-md border px-2.5 py-2.5 text-left transition-colors"
    :class="
      props.entry.done
        ? 'border-border/60 bg-muted/40 opacity-70'
        : props.entry.overdue
          ? 'border-destructive/25 border-l-2 border-l-destructive bg-red-50 hover:border-destructive/60'
          : 'border-border/70 bg-background hover:border-primary/50'
    "
    :aria-label="`任务详情：${props.entry.task.title}`"
    @click="emit('open', props.entry.task.id)"
  >
    <div class="flex items-baseline gap-1.5">
      <span class="font-date text-xs font-semibold" :class="props.entry.overdue && !props.entry.done ? 'text-destructive' : 'text-muted-foreground'">
        {{ slotClock(props.entry.minutes) || '当日截止' }}
      </span>
      <span v-if="props.entry.done" class="text-xs font-medium text-success-foreground">已完成</span>
      <span v-else-if="props.entry.overdue" class="text-xs font-medium text-destructive">已逾期</span>
    </div>
    <div class="mt-0.5 line-clamp-2 break-words text-sm font-medium leading-snug" :class="props.entry.done && 'line-through'">
      {{ props.entry.task.title }}
    </div>
  </button>
</template>