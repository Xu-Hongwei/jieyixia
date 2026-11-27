<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import DayWorkZone from '@/components/domain/DayWorkZone.vue'
import DayDeadlineZone from '@/components/domain/DayDeadlineZone.vue'
import DayTwoZones from '@/components/domain/DayTwoZones.vue'
import { useAppStore } from '@/stores/app'
import { usePlanStore } from '@/stores/plan'
import { beijingAddDays, beijingDateStr, isValidDate } from '@/domains/time'
import { weekRangeLabel, weekStartOf } from '@/domains/week'

// 统一日程表（5A-1 §3）：共用一条七日日期轴，上方每日工作、下方每日截止。
// 桌面周表用同一个 CSS grid 的三行带（表头/工作/截止），行边界跨列统一，截止带不随任务数漂移。
// 容器（而非屏幕）过窄时切换为「七日日期条 → 选中日两区顺序展示」；列表视图按天呈现同一两区内容。
const props = defineProps({
  recordedPlanId: { type: String, default: '' },
  mode: { type: String, default: 'week' }, // week | list
})
const emit = defineEmits(['add-plan'])
const store = useAppStore()
const planStore = usePlanStore()
const route = useRoute()
const router = useRouter()

const todayStr = computed(() => beijingDateStr(new Date(store.nowTick)))
// URL 的 date 是选日/定位周的唯一事实来源：刷新、后退、跨页返回都恢复到同一周同一日。
const targetDate = computed(() => (typeof route.query.date === 'string' && isValidDate(route.query.date) ? route.query.date : todayStr.value))
const start = computed(() => weekStartOf(targetDate.value))
function goDate(date) {
  const q = { ...route.query, date }
  if (date === todayStr.value) delete q.date
  router.replace({ query: q })
}
function jumpToDate(event) {
  const date = event.currentTarget.value
  if (isValidDate(date)) goDate(date)
}

const schedule = computed(() => planStore.schedule(start.value, new Date(store.nowTick)))
const days = computed(() => schedule.value.days)
const selectedDay = computed(() => days.value.find((d) => d.date === targetDate.value) || days.value[0])
// 待定位安排（URL plan 参数）：传给各日区，命中日自动展开历史/折叠清单（R4）。
const locatePlanId = computed(() => (typeof route.query.plan === 'string' ? route.query.plan : props.recordedPlanId))
const yearLabel = computed(() => {
  const endYear = beijingAddDays(start.value, 6).slice(0, 4)
  const startYear = start.value.slice(0, 4)
  return startYear === endYear ? startYear : `${startYear}/${endYear}`
})

// 容器宽度驱动窄布局：侧栏挤压同样触发，不只看屏幕宽度。
const root = ref(null)
const narrow = ref(false)
let ro = null
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    ro = new ResizeObserver((entries) => {
      narrow.value = entries[0].contentRect.width < 700
    })
    ro.observe(root.value)
  }
})
onBeforeUnmount(() => {
  if (ro) ro.disconnect()
})

// 工作卡 → 安排详情（URL plan 参数，TodayPage 校验并渲染）；截止卡 → 任务详情（携带返回上下文）。
function openPlan(id) {
  router.replace({ query: { ...route.query, plan: id } })
}
function openTask(id) {
  const q = { ...route.query }
  delete q.task
  const returnPath = router.resolve({ path: '/today', query: q }).fullPath
  router.push({ path: '/tasks/' + id, query: { return: returnPath } })
}

// 周表横向溢出时把定位日（默认今天）滚进首屏；窄布局/列表无滚动容器则无效果。
const scroller = ref(null)
function centerTarget() {
  const el = scroller.value
  if (!el || el.scrollWidth <= el.clientWidth) return
  const col = el.querySelector(`button[data-date="${targetDate.value}"]`)
  if (!col) return
  const bounds = el.getBoundingClientRect()
  const target = col.getBoundingClientRect()
  if (target.left < bounds.left) el.scrollLeft += target.left - bounds.left
  else if (target.right > bounds.right) el.scrollLeft += target.right - bounds.right
}
onMounted(centerTarget)
watch(targetDate, centerTarget, { flush: 'post' })

// 今天=品牌色标记；选中=底色+描边。两者可同时命中但视觉可区分。
const colBg = (d) => (d.date === targetDate.value ? 'bg-accent/50' : d.isToday ? 'bg-primary/5' : '')
const headerClass = (d) =>
  d.date === targetDate.value ? 'bg-accent ring-1 ring-inset ring-primary/60' : d.isToday ? 'bg-primary/5' : 'hover:bg-accent/40'
</script>

<template>
  <div ref="root">
    <Card flush class="week-sheet">
      <template #header>
        <div class="week-heading">
          <div class="week-caption">
            <p class="week-year">{{ yearLabel }} 年 · 北京时间</p>
            <h1 class="week-range font-date">{{ weekRangeLabel(start) }}</h1>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <slot name="tools" />
          </div>
          <div class="flex flex-wrap items-center gap-1">
            <label class="inline-flex items-center gap-1 text-xs text-muted-foreground">跳至日期
              <input type="date" aria-label="跳至日期" :value="targetDate" class="rounded-md border bg-background px-2 py-1.5" @change="jumpToDate" />
            </label>
            <Button size="sm" variant="outline" aria-label="上一周" title="上一周" @click="goDate(beijingAddDays(start, -7))"><ChevronLeft /></Button>
            <Button size="sm" variant="outline" @click="goDate(todayStr)">本周</Button>
            <Button size="sm" variant="outline" aria-label="下一周" title="下一周" @click="goDate(beijingAddDays(start, 7))"><ChevronRight /></Button>
          </div>
        </div>
      </template>

      <!-- 宽容器周表：一条日期轴 + 统一行边界的工作带/截止带 -->
      <div v-if="props.mode === 'week' && !narrow" ref="scroller" class="overflow-x-auto scroll-slim">
        <div class="week-grid grid min-w-[700px] grid-cols-7 border-t border-border">
          <button
            v-for="d in days"
            :key="'h-' + d.date"
            type="button"
            class="border-l border-border px-2 py-2 text-center transition-colors first:border-l-0"
            :class="headerClass(d)"
            :aria-pressed="d.date === targetDate"
            :aria-label="`选择 ${d.date} ${d.weekday}，工作 ${d.plans.length} 项，截止 ${d.deadlines.length} 项`"
            :data-date="d.date"
            :data-today="d.isToday || undefined"
            @click="goDate(d.date)"
          >
            <div class="text-xs text-muted-foreground">{{ d.weekday }}</div>
            <div class="font-date text-2xl font-semibold leading-tight" :class="d.isToday && 'text-primary'">{{ d.dayNum }}</div>
            <div class="text-[11px] leading-tight">
              <span v-if="d.isToday" class="font-medium text-primary">今天</span>
              <span v-if="d.plans.length || d.deadlines.length" class="text-muted-foreground"> 工作 {{ d.plans.length }} · 截止 {{ d.deadlines.length }}</span>
            </div>
          </button>

          <div class="week-band col-span-7">
            每日工作 <span>{{ schedule.planCount }} 项</span>
          </div>
          <div
            v-for="d in days"
            :key="'w-' + d.date"
            class="week-work-cell border-l border-border p-1.5"
            :class="colBg(d)"
            :data-date="d.date"
          >
            <DayWorkZone :day="d" :locate-plan-id="locatePlanId" @open-plan="openPlan" @add="emit('add-plan', d.date)" />
          </div>

          <div class="week-band deadline-band col-span-7">
            每日截止 <span>{{ schedule.deadlineCount }} 项</span>
          </div>
          <p v-if="!schedule.deadlineCount" class="col-span-7 px-3 py-3 text-sm text-muted-foreground">本周无截止</p>
          <template v-else>
          <div
            v-for="d in days"
            :key="'d-' + d.date"
            class="border-l border-border p-1.5 first:border-l-0"
            :class="colBg(d)"
            :data-date="d.date"
          >
            <DayDeadlineZone :day="d" @open-task="openTask" />
          </div>
          </template>
        </div>
      </div>

      <!-- 窄容器：七日日期条 → 选中日「工作 → 截止」顺序两区（无互斥页签） -->
      <div v-else-if="props.mode === 'week'" class="border-t border-border p-3">
        <div class="grid grid-cols-7 gap-1" role="group" aria-label="选择日期">
          <button
            v-for="d in days"
            :key="'s-' + d.date"
            type="button"
            class="rounded-md border px-0.5 py-1.5 text-center transition-colors"
            :class="d.date === targetDate ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/60'"
            :aria-pressed="d.date === targetDate"
            :aria-label="`${d.date} ${d.weekday}，工作 ${d.plans.length} 项，截止 ${d.deadlines.length} 项`"
            :data-date="d.date"
            @click="goDate(d.date)"
          >
            <div class="text-[10px] text-muted-foreground">{{ d.weekday }}</div>
            <div class="font-date text-lg font-semibold leading-tight" :class="d.isToday && 'text-primary'">{{ d.dayNum }}</div>
          </button>
        </div>
        <div class="mt-3 overflow-hidden rounded-md border border-border" :data-date="selectedDay.date">
          <div class="flex flex-wrap items-baseline gap-2 border-b border-border bg-muted/30 px-3 py-2">
            <span class="text-sm font-semibold">{{ selectedDay.date.slice(5).replace('-', '/') }}</span>
            <span class="text-xs text-muted-foreground">{{ selectedDay.weekday }}</span>
            <span v-if="selectedDay.isToday" class="text-xs font-medium text-primary">今天</span>
          </div>
          <DayTwoZones :day="selectedDay" :locate-plan-id="locatePlanId" @open-plan="openPlan" @open-task="openTask" @add="emit('add-plan', selectedDay.date)" />
        </div>
      </div>

      <!-- 列表视图：同一七日两区内容按天竖排（不再是旧「今日任务」三分区） -->
      <div v-else class="border-t border-border">
        <div
          v-for="d in days"
          :key="'l-' + d.date"
          class="border-b border-border last:border-b-0"
          :class="d.date === targetDate ? 'bg-accent/40' : d.isToday ? 'bg-primary/5' : ''"
          :data-date="d.date"
        >
          <button
            type="button"
            class="flex w-full flex-wrap items-baseline gap-2 px-3 py-2 text-left hover:bg-accent/40"
            :aria-pressed="d.date === targetDate"
            :aria-label="`选择 ${d.date} ${d.weekday}，工作 ${d.plans.length} 项，截止 ${d.deadlines.length} 项`"
            @click="goDate(d.date)"
          >
            <span class="font-date text-sm font-semibold" :class="d.isToday && 'text-primary'">{{ d.date }}</span>
            <span class="text-xs text-muted-foreground">{{ d.weekday }}</span>
            <span v-if="d.isToday" class="text-xs font-medium text-primary">今天</span>
            <span v-if="d.date === targetDate" class="rounded border border-primary/60 px-1 text-[10px] text-primary">选中</span>
            <span class="ml-auto text-xs text-muted-foreground">工作 {{ d.plans.length }} · 截止 {{ d.deadlines.length }}</span>
          </button>
          <DayTwoZones :day="d" :locate-plan-id="locatePlanId" @open-plan="openPlan" @open-task="openTask" @add="emit('add-plan', d.date)" />
        </div>
      </div>

      <div v-if="narrow || props.mode === 'list' || schedule.outsideWeek.length" class="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-2.5 text-xs text-muted-foreground">
        <span>本周工作 {{ schedule.planCount }} 项</span>
        <span>·</span>
        <span>截止 {{ schedule.deadlineCount }} 项</span>
        <template v-if="schedule.outsideWeek.length">
          <span>·</span>
          <span>周外另有 {{ schedule.outsideWeek.length }} 项安排</span>
        </template>
      </div>
    </Card>
  </div>
</template>
