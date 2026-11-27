<script setup>
import DayWorkZone from '@/components/domain/DayWorkZone.vue'
import DayDeadlineZone from '@/components/domain/DayDeadlineZone.vue'

// 单日两区顺序展示（窄容器选中日 / 按天列表共用）：先工作后截止，绝不互斥切换。
const props = defineProps({
  day: { type: Object, required: true },
  locatePlanId: { type: String, default: '' },
})
const emit = defineEmits(['open-plan', 'open-task', 'add'])
</script>

<template>
  <div>
    <div class="bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">每日工作 · {{ day.plans.length }} 项</div>
    <div class="p-1.5">
      <DayWorkZone :day="day" :locate-plan-id="props.locatePlanId" @open-plan="emit('open-plan', $event)" @add="emit('add')" />
    </div>
    <div class="border-t border-border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">每日截止 · {{ day.deadlines.length }} 项</div>
    <div class="p-1.5">
      <DayDeadlineZone :day="day" @open-task="emit('open-task', $event)" />
    </div>
  </div>
</template>