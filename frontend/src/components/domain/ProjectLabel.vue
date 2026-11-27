<script setup>
import { computed } from 'vue'
import { useTaskColors } from '@/composables/useTaskProject'
const props = defineProps({ task: Object, withTask: Boolean })
const colors = useTaskColors()
const project = computed(() => colors.projectFor(props.task))
const name = computed(() => {
  if (!props.withTask) return project.value?.title || '独立任务'
  const task = props.task?.title || '原任务已删除'
  return project.value && project.value.title !== task ? `${project.value.title} › ${task}` : task
})
</script>
<template>
  <span class="inline-flex min-w-0 items-baseline gap-1.5" :class="withTask ? 'text-sm font-semibold' : 'text-xs text-muted-foreground'" :title="name">
    <i v-if="task" aria-hidden="true" class="project-dot size-1.5 shrink-0 rounded-full" :data-project-tone="colors.toneFor(task)" />
    <span :class="withTask ? 'break-words' : 'truncate'">{{ name }}</span>
  </span>
</template>
