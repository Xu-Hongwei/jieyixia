<script setup>
import { computed, ref } from 'vue'
import DeadlineChip from '@/components/domain/DeadlineChip.vue'
import { taskListPath } from '@/domains/taskList'
import { slotClock } from '@/domains/week'

// 单日「每日截止」区：默认 ≤2 项紧凑展示，独立展开（与上方工作区的展开互不影响）。
const props = defineProps({
  day: { type: Object, required: true },
})
const emit = defineEmits(['open-task'])

const expanded = ref(false)
const visible = computed(() => (expanded.value ? props.day.deadlines : props.day.deadlines.slice(0, 2)))
</script>

<template>
  <div>
    <div class="space-y-1.5" :class="expanded && 'max-h-[22rem] overflow-y-auto scroll-slim'">
      <template v-for="e in visible" :key="e.project ? 'project-' + e.project.id : e.task.id">
        <RouterLink v-if="e.project" :to="taskListPath({ matter: e.project.id })" class="block break-words rounded-md border-l-2 border-primary bg-accent p-2 text-sm">
          <span class="block text-xs">项目总截止 {{ slotClock(e.minutes) }}</span><strong>{{ e.project.title }}</strong>
        </RouterLink>
        <DeadlineChip v-else :entry="e" @open="emit('open-task', $event)" />
      </template>
      <p v-if="!day.deadlines.length" class="px-1 pt-2 text-center text-xs text-muted-foreground">暂无截止</p>
    </div>
    <button
      v-if="day.deadlines.length > 2"
      type="button"
      class="mt-1 w-full rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-accent"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : `还有 ${day.deadlines.length - 2} 项 · 展开` }}
    </button>
  </div>
</template>
