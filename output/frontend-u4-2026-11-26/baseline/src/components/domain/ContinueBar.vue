<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { CirclePlay } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { sessionActionText, sessionTitle } from '@/domains/work'

// 继续条：只显示当前空间的未结束会话（运行/暂停/待恢复），一个「回到工作」入口。
// 跨空间运行不混进来（冲突/切换场景另行提示）；执行页自身不重复显示。
const app = useAppStore()
const focus = useFocusStore()
const router = useRouter()

const session = computed(() => focus.unfinished[0] || null)
const rt = computed(() =>
  session.value ? focus.coordination.find((r) => r.session_id === session.value.id) || null : null)
const stateLabel = computed(() => {
  if (!session.value) return ''
  if (session.value.record_version !== 1) return '旧版记录'
  if (rt.value && rt.value.recovery) return '待恢复'
  return session.value.running ? '运行中' : '已暂停'
})
const title = computed(() => {
  if (!session.value) return ''
  const live = app.tasks.find((t) => t.id === session.value.task_id)
  return sessionTitle(session.value) || (live ? live.title : '原任务已删除')
})
const actionText = computed(() => {
  if (!session.value) return ''
  const live = app.actions.find((a) => a.id === session.value.action_id)
  return sessionActionText(session.value) || (live ? live.text : '')
})
</script>

<template>
  <div v-if="session" class="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
    <CirclePlay class="size-4 shrink-0 text-primary" />
    <div class="min-w-0 flex-1 basis-48">
      <div class="break-words text-sm font-medium">{{ title }}</div>
      <div v-if="actionText" class="break-words text-xs text-muted-foreground">{{ actionText }}</div>
    </div>
    <Badge :variant="session.running ? 'success' : 'warning'">{{ stateLabel }}</Badge>
    <Button size="sm" @click="router.push('/work/' + session.id)">回到工作</Button>
  </div>
</template>