<script setup>
import { computed } from 'vue'
import { beijingWeekday, formatWhen } from '@/domains/time'

const props = defineProps({
  result: { type: Object, required: true },
  segmentsByDate: { type: Object, required: true },
  taskTitle: { type: Function, required: true },
  headingTitle: { type: String, default: '' },
  preview: { type: Boolean, default: false },
})
const visibleDays = computed(() => props.result.days.filter(day =>
  props.segmentsByDate[day.date]?.length || (props.preview && day.overbooked_minutes > 0)))
const otherDates = computed(() => Object.keys(props.segmentsByDate)
  .filter(date => !props.result.days.some(day => day.date === date)).sort())
const displayDays = computed(() => [...visibleDays.value, ...otherDates.value.map(date => ({ date, overbooked_minutes: 0 }))])
const capacityLabel = day => `可用 ${day.budget_minutes} · 缓冲 ${day.buffer_minutes} · 已有 ${day.committed_minutes} · 新排 ${day.allocated_minutes} · 剩余 ${day.free_minutes} 分钟`
</script>

<template>
  <div class="border-t border-primary">
    <template v-for="day in displayDays" :key="day.date">
    <h3 v-if="day.date === otherDates[0]" class="pt-4 text-base font-semibold">{{ day.date < result.days[0].date ? '窗口外已定日期' : '后续已定日期' }}</h3>
    <section class="grid grid-cols-[3.2rem_minmax(0,1fr)] gap-2 border-b py-4 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4">
      <h4><time :datetime="day.date" :aria-label="formatWhen(day.date, 'date')"><span class="block font-date text-lg font-semibold">周{{ '日一二三四五六'[beijingWeekday(day.date)] }}</span><span class="block text-xs tabular-nums text-muted-foreground">{{ day.date.slice(5).replace('-', '/') }}</span></time></h4>
      <div class="min-w-0">
        <details v-if="preview && day.overbooked_minutes > 0" class="mb-2 border-l-2 border-warning pl-3 text-sm">
          <summary class="cursor-pointer font-medium text-warning-foreground">已有安排超出 {{ day.overbooked_minutes }} 分钟</summary>
          <p class="my-2 text-muted-foreground">当天可用 {{ day.budget_minutes }} 分钟，预留 {{ day.buffer_minutes }} 分钟，可排 {{ day.budget_minutes - day.buffer_minutes }} 分钟。已有安排 {{ day.committed_minutes }} 分钟，本次新增 {{ day.allocated_minutes }} 分钟。</p>
          <slot name="overbook" :day="day" />
        </details>
        <ul class="divide-y divide-border/50">
          <li v-for="segment in segmentsByDate[day.date]" :key="segment.segment_key" class="flex items-baseline gap-3 py-2 first:pt-0">
            <div class="min-w-0 flex-1">
              <div class="break-words font-medium">{{ segment.action_text }}</div>
              <div v-if="taskTitle(segment.task_ref) !== headingTitle && taskTitle(segment.task_ref) !== segment.action_text" class="break-words text-xs text-muted-foreground">{{ taskTitle(segment.task_ref) }}</div>
              <slot name="segment-controls" :segment="segment" />
            </div>
            <span class="shrink-0 text-sm tabular-nums text-muted-foreground">{{ segment.minutes }} 分钟</span>
          </li>
        </ul>
      </div>
    </section>
    </template>
    <details v-if="preview" class="py-3 text-xs text-muted-foreground">
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
