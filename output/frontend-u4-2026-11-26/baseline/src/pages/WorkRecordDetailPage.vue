<script setup>
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from 'lucide-vue-next'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { formatDurationMs, sessionActionText, sessionTitle } from '@/domains/work'
import { PLAN_STATE_LABELS, label } from '@/domains/labels'
import { resolveWorkReturn, schedulePath, workPath } from '@/domains/workNavigation'
import { beijingDateStr, beijingInstantLabel, formatWhen } from '@/domains/time'

const app = useAppStore()
const focus = useFocusStore()
const route = useRoute()
const router = useRouter()

const sessionId = computed(() => String(route.params.sessionId || ''))
const session = computed(() => focus.sessions.find((s) => s.id === sessionId.value) || null)
const ready = computed(() => app.ready && focus.ready)
// 未结束会话不进只读详情：转执行页由其状态机处理；原 return 原样携带，由执行页统一校验。
const wrongKind = ref(false)
watch([ready, session], () => {
  if (!ready.value || !session.value) return
  if (session.value.ended_at == null && !wrongKind.value) {
    wrongKind.value = true
    router.replace(workPath(sessionId.value, typeof route.query.return === 'string' ? route.query.return : ''))
  }
}, { immediate: true })

const task = computed(() => (session.value ? app.tasks.find((t) => t.id === session.value.task_id) || null : null))
const action = computed(() => (session.value ? app.actions.find((a) => a.id === session.value.action_id) || null : null))
const hasSnapshot = computed(() => !!session.value && session.value.record_version === 1 && !!session.value.task_snapshot)
const title = computed(() => sessionTitle(session.value) || '旧记录（无开始快照）')
const actionText = computed(() => sessionActionText(session.value))

const OUTCOME_LABELS = { done: '完成', partial: '部分完成', blocked: '受阻' }
const OUTCOME_VARIANTS = { done: 'success', partial: 'secondary', blocked: 'warning' }
const outcomeLabel = computed(() => (session.value && OUTCOME_LABELS[session.value.outcome]) || '未记录结果')
const outcomeVariant = computed(() => (session.value && OUTCOME_VARIANTS[session.value.outcome]) || 'secondary')

// 当前信息只读对照：历史以快照为准，绝不覆盖；引用已断开时不再提供跳转。
const showCurrent = ref(false)
const taskDeleted = computed(() => !!session.value && (session.value.task_ref_state === 'deleted' || !task.value))
const actionDeleted = computed(() => !!session.value && (session.value.action_ref_state === 'deleted' || !action.value))
const infoChanged = computed(() => {
  const s = session.value
  if (!s || !s.task_snapshot || taskDeleted.value || actionDeleted.value) return false
  if (task.value.title !== s.task_snapshot.title) return true
  return !!action.value && !!s.action_snapshot &&
    (action.value.text !== s.action_snapshot.text || action.value.minutes !== s.action_snapshot.minutes)
})
// 返回目标（5A-2B §4）：精确匹配 + 归属校验；丢失/非法按会话真实关联构造安全目标，不用 startsWith 放行。
const todayStr = computed(() => beijingDateStr(new Date(app.nowTick)))
const returnPath = computed(() =>
  resolveWorkReturn(route.query.return, session.value, { docs: app.docs, ws: app.workspaceId, todayStr: todayStr.value }))
// 所属安排（§7）：按当前空间真实关联展示当前安排信息；关联断开只标注，不猜历史。
const recordPlan = computed(() => {
  const s = session.value
  if (!s || !s.plan_item_id) return null
  return app.docs.find((d) => d.kind === 'plan_item' && d.id === s.plan_item_id) || null
})
const planScheduleLink = computed(() =>
  (recordPlan.value ? schedulePath({ date: recordPlan.value.date, plan: recordPlan.value.id }, todayStr.value) : ''))
</script>

<template>
  <div v-if="!ready" class="text-sm text-muted-foreground">正在读取本地工作数据…</div>

  <div v-else-if="!session" class="space-y-3">
    <Alert variant="warning">记录不存在或不属于当前空间。不会自动新建，也不会替你切换空间。</Alert>
    <div class="flex gap-2">
      <Button variant="outline" @click="router.replace('/work-records')"><ArrowLeft />工作记录列表</Button>
      <Button variant="outline" @click="router.replace('/today')">返回日程</Button>
    </div>
  </div>

  <template v-else-if="session.ended_at != null">
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" @click="router.push(returnPath)"><ArrowLeft />返回</Button>
        <Badge :variant="outcomeVariant">{{ outcomeLabel }}</Badge>
        <Badge v-if="session.record_version !== 1" variant="secondary">旧版记录</Badge>
        <Badge variant="secondary">只读</Badge>
      </div>

      <div>
        <h1 class="break-words text-lg font-semibold leading-snug">{{ title }}</h1>
        <div class="mt-0.5 break-words text-sm text-muted-foreground">
          <template v-if="actionText">{{ actionText }}</template>
          <template v-else-if="hasSnapshot">（无行动快照）</template>
          <template v-else>旧版记录未保存行动快照，不以现名称补造。</template>
          <template v-if="hasSnapshot && session.action_snapshot && session.action_snapshot.minutes"> · 预计 {{ session.action_snapshot.minutes }} 分钟</template>
        </div>
      </div>

      <div v-if="taskDeleted || actionDeleted" class="flex flex-wrap gap-2">
        <Badge v-if="taskDeleted" variant="secondary">原任务已删除</Badge>
        <Badge v-if="actionDeleted" variant="secondary">原行动已删除</Badge>
        <span class="text-xs text-muted-foreground">工作记录本身保留，正文与用时不受删除影响。</span>
      </div>
      <div v-else class="flex flex-wrap items-center gap-2 text-sm">
        <RouterLink :to="{ path: '/tasks/' + session.task_id, query: { return: '/work-records/' + sessionId } }" class="underline">查看当前任务</RouterLink>
        <template v-if="infoChanged">
          <Badge variant="warning">当前信息已修改</Badge>
          <button type="button" class="text-xs underline" :aria-expanded="showCurrent" @click="showCurrent = !showCurrent">
            {{ showCurrent ? '收起当前信息' : '查看当前信息' }}
          </button>
        </template>
      </div>
      <div v-if="showCurrent && infoChanged" class="rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground">
        <div>当前任务：{{ task ? task.title : '已删除' }}</div>
        <div>当前行动：{{ action ? `${action.text}（预计 ${action.minutes} 分钟）` : '已删除' }}</div>
        <div class="text-xs">历史记录以上方开始快照为准，不被覆盖。</div>
      </div>

      <div v-if="session.plan_item_id" class="flex flex-wrap items-center gap-2 text-sm">
        <span class="text-xs text-muted-foreground">所属安排</span>
        <template v-if="recordPlan">
          <RouterLink :to="planScheduleLink" class="underline">{{ recordPlan.date }} · {{ label(PLAN_STATE_LABELS, recordPlan.state) }}</RouterLink>
          <span class="text-xs text-muted-foreground">（当前安排信息，历史正文不受其变化影响）</span>
        </template>
        <Badge v-else variant="secondary">原安排已不存在或不属于当前空间</Badge>
      </div>

      <Card>
        <template #header>
          <div class="text-base font-semibold">用时与结果</div>
        </template>
        <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt class="text-xs text-muted-foreground">开始（北京时间）</dt><dd class="font-date">{{ beijingInstantLabel(session.started_at) }}</dd></div>
          <div><dt class="text-xs text-muted-foreground">结束（北京时间）</dt><dd class="font-date">{{ beijingInstantLabel(session.ended_at) }}</dd></div>
          <div><dt class="text-xs text-muted-foreground">实际有效用时</dt><dd class="font-date tabular-nums">{{ formatDurationMs(session.accumulated_ms) }}</dd></div>
          <div><dt class="text-xs text-muted-foreground">结果</dt><dd>{{ outcomeLabel }}</dd></div>
          <div v-if="session.outcome === 'blocked'" class="sm:col-span-2">
            <dt class="text-xs text-muted-foreground">卡点</dt>
            <dd class="break-words text-warning-foreground">{{ session.blocker || '（未填写）' }}</dd>
          </div>
          <div v-if="hasSnapshot && session.task_snapshot.deadline_value" class="sm:col-span-2">
            <dt class="text-xs text-muted-foreground">开始时任务截止</dt>
            <dd>{{ formatWhen(session.task_snapshot.deadline_value, session.task_snapshot.deadline_precision) }}</dd>
          </div>
          <div v-if="hasSnapshot && session.task_snapshot.matter_name" class="sm:col-span-2">
            <dt class="text-xs text-muted-foreground">开始时所属事项</dt>
            <dd class="break-words">{{ session.task_snapshot.matter_name }}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <template #header>
          <div class="text-base font-semibold">工作成果（只读）</div>
        </template>
        <div v-if="session.draft_md" class="whitespace-pre-wrap break-words text-sm leading-relaxed">{{ session.draft_md }}</div>
        <p v-else class="text-sm text-muted-foreground">本次工作没有记录正文。</p>
      </Card>

      <div class="text-xs text-muted-foreground">
        历史正文与快照不可编辑；如需继续工作，请到任务详情开始新的一段。
      </div>
    </div>
  </template>
</template>