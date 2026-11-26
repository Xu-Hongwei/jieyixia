<script setup>
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import Input from '@/components/ui/Input.vue'
import { useAppStore } from '@/stores/app'
import { usePlanStore } from '@/stores/plan'
import { beijingDateStr, formatWhen, isOverdue, isValidDate } from '@/domains/time'
import { PLAN_STATE_LABELS, STATUS_LABELS, label } from '@/domains/labels'

// 三个紧凑入口共享一个按需展开区（5A-1 §9）：待安排 / 过去未完成 / 全部任务。
// 分类读 planStore.classify 全量事实（不只看当前周）；搜索与筛选在展开区内对当前清单生效。
// undated=1 旧深链接/新建定位 = 全部任务 + 仅无截止筛选，参数与筛选双向同步。
const emit = defineEmits(['arrange', 'open-plan'])
const store = useAppStore()
const planStore = usePlanStore()
const route = useRoute()
const router = useRouter()

const todayStr = computed(() => beijingDateStr(new Date(store.nowTick)))
const selectedDate = computed(() =>
  typeof route.query.date === 'string' && isValidDate(route.query.date) ? route.query.date : todayStr.value)
const classify = computed(() => planStore.classify(new Date(store.nowTick)))
const taskOf = (id) => store.tasks.find((t) => t.id === id) || null
const planOf = (id) => store.docs.find((d) => d.kind === 'plan_item' && d.id === id) || null

const undatedOnly = computed({
  get: () => route.query.undated === '1',
  set: (v) => {
    const q = { ...route.query }
    if (v) q.undated = '1'
    else delete q.undated
    router.replace({ query: q })
  },
})
const open = ref(false)
const list = ref('unscheduled') // unscheduled | past | all
watch(undatedOnly, (v) => {
  if (v) { open.value = true; list.value = 'all' }
}, { immediate: true })

const search = ref('')
const statusFilter = ref('all') // all | open | done
// 待安排默认北京今天；显式勾选后才用周表当前选日（§5）。
const useSelectedDay = ref(false)

const LIST_LABELS = { unscheduled: '待安排', past: '过去未完成', all: '全部任务' }
const counts = computed(() => ({
  unscheduled: classify.value.unscheduled.length,
  past: classify.value.pastUnfinished.length,
  all: store.tasks.length,
}))
function pick(l) {
  if (open.value && list.value === l) open.value = false
  else { list.value = l; open.value = true }
}

const baseIds = computed(() => {
  if (list.value === 'unscheduled') return classify.value.unscheduled
  if (list.value === 'past') return classify.value.pastUnfinished.map((e) => e.taskId)
  return store.tasks.map((t) => t.id)
})
const rows = computed(() => {
  const q = search.value.trim().toLowerCase()
  return baseIds.value.map(taskOf).filter(Boolean).filter((t) => {
    if (q && !t.title.toLowerCase().includes(q)) return false
    if (statusFilter.value === 'open' && t.status === 'done') return false
    if (statusFilter.value === 'done' && t.status !== 'done') return false
    if (undatedOnly.value && t.deadline && t.deadline.value) return false
    return true
  })
})
const pastPlansOf = (taskId) => {
  const e = classify.value.pastUnfinished.find((x) => x.taskId === taskId)
  return e ? e.planIds.map(planOf).filter(Boolean) : []
}
const deadlineLabel = (t) => (t.deadline && t.deadline.value ? formatWhen(t.deadline.value, t.deadline.precision) : '无截止')
const detailLink = (t) => ({ path: '/tasks/' + t.id, query: { return: route.fullPath } })
function arrange(t) {
  emit('arrange', {
    taskId: t.id,
    date: list.value === 'unscheduled' && useSelectedDay.value ? selectedDate.value : todayStr.value,
  })
}
</script>

<template>
  <Card>
    <div class="flex flex-wrap items-center gap-2">
      <button
        v-for="l in ['unscheduled', 'past', 'all']"
        :key="l"
        type="button"
        class="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium transition-colors"
        :class="open && list === l ? 'border-primary bg-accent' : 'border-border bg-card hover:bg-accent'"
        :aria-expanded="open && list === l"
        :aria-label="`${LIST_LABELS[l]}清单，${counts[l]} 项`"
        @click="pick(l)"
      >
        {{ LIST_LABELS[l] }}
        <Badge variant="secondary">{{ counts[l] }}</Badge>
      </button>
      <span class="ml-auto text-xs text-muted-foreground">同一展开区 · 搜索与筛选对当前清单生效</span>
    </div>

    <div v-if="open" class="mt-3 space-y-2 border-t border-border pt-3">
      <div class="flex flex-wrap items-center gap-2">
        <Input v-model="search" placeholder="搜索任务名称…" class="h-8 min-w-40 flex-1" aria-label="搜索任务" />
        <select v-model="statusFilter" aria-label="状态筛选" class="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <option value="all">全部状态</option>
          <option value="open">未完成</option>
          <option value="done">已完成</option>
        </select>
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input v-model="undatedOnly" type="checkbox" class="size-3.5 accent-[var(--primary)]" />仅无截止
        </label>
        <label v-if="list === 'unscheduled'" class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input v-model="useSelectedDay" type="checkbox" class="size-3.5 accent-[var(--primary)]" />安排到当前选日 {{ selectedDate }}
        </label>
      </div>
      <p class="text-xs text-muted-foreground">
        {{ LIST_LABELS[list] }} · {{ rows.length }} 项<template v-if="list === 'unscheduled'">（未勾选「安排到当前选日」时默认北京今天 {{ todayStr }}）</template>
      </p>

      <div v-for="t in rows" :key="t.id" class="rounded-md border p-2.5">
        <div class="flex flex-wrap items-center gap-2">
          <RouterLink
            :to="detailLink(t)"
            class="min-w-0 flex-1 basis-40 break-words text-sm font-medium underline-offset-2 hover:underline"
            :aria-label="'任务详情：' + t.title"
          >{{ t.title }}</RouterLink>
          <Badge v-if="isOverdue(t, new Date(store.nowTick))" variant="destructive">已逾期</Badge>
          <Badge :variant="t.status === 'done' ? 'success' : 'secondary'" :title="t.status">{{ label(STATUS_LABELS, t.status) }}</Badge>
          <span class="font-date text-xs text-muted-foreground">{{ deadlineLabel(t) }}</span>
          <Button v-if="t.status !== 'done'" size="sm" variant="outline" :aria-label="'安排工作：' + t.title" @click="arrange(t)">安排</Button>
        </div>
        <div v-if="list === 'past'" class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span class="text-xs text-muted-foreground">过去未完成安排：</span>
          <button
            v-for="p in pastPlansOf(t.id)"
            :key="p.id"
            type="button"
            class="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-xs hover:bg-accent"
            :aria-label="`安排详情：${p.action_text}`"
            @click="emit('open-plan', { planId: p.id, date: p.date })"
          >
            <span class="font-date">{{ p.date }}</span> · {{ label(PLAN_STATE_LABELS, p.state) }}
          </button>
        </div>
      </div>
      <p v-if="!rows.length" class="text-sm text-muted-foreground">
        {{ search.trim() || statusFilter !== 'all' || undatedOnly ? '没有符合搜索/筛选条件的任务。' : list === 'unscheduled' ? '没有待安排任务：未完成任务都有今天或之后的安排。' : list === 'past' ? '没有过去未完成的安排。' : '当前空间还没有任务。' }}
      </p>
    </div>
  </Card>
</template>