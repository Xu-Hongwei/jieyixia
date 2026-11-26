<script setup>
import { computed } from 'vue'
import { formatWhen } from '@/domains/time'

const props = defineProps({
  result: { type: Object, required: true },
  segmentsByDate: { type: Object, required: true },
  taskTitle: { type: Function, required: true },
  preview: { type: Boolean, default: false },
})
const visibleDays = computed(() => props.result.days.filter(day =>
  props.segmentsByDate[day.date]?.length || (props.preview && day.overbooked_minutes > 0)))
const capacityLabel = day => `可用 ${day.budget_minutes} · 缓冲 ${day.buffer_minutes} · 已有 ${day.committed_minutes} · 新排 ${day.allocated_minutes} · 剩余 ${day.free_minutes} 分钟`
</script>

<template>
  <div class="border-t-2 border-foreground/75">
    <section v-for="day in visibleDays" :key="day.date" class="grid gap-x-4 gap-y-1 border-b py-3 sm:grid-cols-[8rem_1fr]">
      <h4 class="font-date text-base font-semibold"><time :datetime="day.date">{{ formatWhen(day.date, 'date') }}</time></h4>
      <div class="min-w-0">
        <p v-if="preview && day.overbooked_minutes > 0" class="text-sm font-medium text-destructive">超出预算 {{ day.overbooked_minutes }} 分钟</p>
        <ul class="divide-y divide-border/50">
          <li v-for="segment in segmentsByDate[day.date]" :key="segment.segment_key" class="flex items-baseline gap-3 py-2 first:pt-0">
            <div class="min-w-0 flex-1">
              <div class="break-words font-medium">{{ segment.action_text }}</div>
              <div class="break-words text-xs text-muted-foreground">{{ taskTitle(segment.task_ref) }}</div>
            </div>
            <span class="shrink-0 text-sm tabular-nums text-muted-foreground">{{ segment.minutes }} 分钟</span>
          </li>
        </ul>
      </div>
    </section>
    <details v-if="preview" class="py-2 text-sm text-muted-foreground">
      <summary class="cursor-pointer">查看各日可用时间（{{ result.days.length }} 天）</summary>
      <dl class="mt-2 space-y-2">
        <div v-for="day in result.days" :key="day.date">
          <dt class="font-medium">{{ formatWhen(day.date, 'date') }}</dt>
          <dd>{{ capacityLabel(day) }}</dd>
        </div>
      </dl>
    </details>
  </div>
</template>
