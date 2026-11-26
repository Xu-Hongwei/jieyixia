<script setup>
import { RouterLink } from 'vue-router'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import { formatWhen, isOverdue } from '@/domains/time'
import { PLAN_STATE_LABELS, STATUS_LABELS, label } from '@/domains/labels'
import { taskPath } from '@/domains/workNavigation'

defineProps({
  tasks: { type: Array, required: true },
  returnTo: { type: String, required: true },
  now: { type: Number, required: true },
  pastPlans: { type: Object, default: () => ({}) },
})
defineEmits(['arrange', 'open-plan'])
</script>

<template>
  <div class="divide-y divide-border">
    <div v-for="task in tasks" :key="task.id" class="py-3" data-task-row>
      <div class="flex flex-wrap items-center gap-2">
        <RouterLink :to="taskPath(task.id, { return: returnTo })" class="min-w-0 flex-1 basis-40 break-words text-sm font-medium underline-offset-2 hover:underline" :aria-label="'任务详情：' + task.title">{{ task.title }}</RouterLink>
        <Badge v-if="isOverdue(task, new Date(now))" variant="destructive">已逾期</Badge>
        <Badge :variant="task.status === 'done' ? 'success' : 'secondary'">{{ label(STATUS_LABELS, task.status) }}</Badge>
        <span class="text-xs text-muted-foreground">{{ task.deadline?.value ? formatWhen(task.deadline.value, task.deadline.precision) : '无截止' }}</span>
        <Button v-if="task.status !== 'done'" size="sm" variant="outline" :aria-label="'安排工作：' + task.title" @click="$emit('arrange', task)">安排</Button>
      </div>
      <div v-if="pastPlans[task.id]?.length" class="mt-2 flex flex-wrap gap-2">
        <button v-for="plan in pastPlans[task.id]" :key="plan.id" type="button" class="rounded border px-2 py-1 text-xs hover:bg-accent" :aria-label="'安排详情：' + plan.action_text" @click="$emit('open-plan', { planId: plan.id, date: plan.date })">{{ plan.date }} · {{ label(PLAN_STATE_LABELS, plan.state) }}</button>
      </div>
    </div>
  </div>
</template>
