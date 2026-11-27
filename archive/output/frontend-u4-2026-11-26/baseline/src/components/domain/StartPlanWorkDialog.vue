<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import {
  DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle,
} from 'reka-ui'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import { useAppStore } from '@/stores/app'
import { planRisk } from '@/domains/plan'
import { slotDeadlineLabel } from '@/domains/week'
import { recordPath } from '@/domains/workNavigation'
import {
  BEGIN_FACT_LABELS, PLAN_PROBLEM_LABELS, STATUS_LABELS, beginFactValueLabel, label, planFieldValueLabel,
} from '@/domains/labels'

// 共享开始确认面板（5A-2B §3.2/§3.3）：纵向紧凑 360px 可滚动。
// 显示/日期关系/风险确认全部取自状态机里已冻结且已展示的确认版本（expected/facts/taskTitle/taskDeadline），
// 不读 live 对象——重确认后显示与提交恒为同一版，避免旧日期混新说明。
// 状态机在 usePlanWorkStart；本组件只渲染与转发意图，不另写业务规则。
const props = defineProps({
  ctrl: { type: Object, required: true },
})
const c = props.ctrl
const { state, open, planDate, canConfirm, blockedRequired, dateMismatch } = c
const store = useAppStore()

const risk = computed(() => {
  const s = state.value
  return s && s.expected ? planRisk({ deadline: s.taskDeadline, status: s.taskStatus }, planDate.value, new Date(store.nowTick)) : null
})
const deadlineText = computed(() => (state.value ? slotDeadlineLabel(state.value.taskDeadline) || '无截止' : '—'))
const dateRelation = computed(() => {
  const s = state.value
  if (!s || !s.planId) return ''
  if (planDate.value === s.confirmDate) return '今天'
  return planDate.value < s.confirmDate ? '延后执行（安排日早于今天）' : '提前执行（安排日晚于今天）'
})
const actionTextOf = (id) => {
  const a = store.actions.find((x) => x.id === id)
  return a ? a.text : null
}
const taskTitleOf = (id) => {
  const t = store.docs.find((d) => d.kind === 'task' && d.id === id)
  return t ? t.title : null
}
const factRows = computed(() => (state.value && state.value.diffRows ? state.value.diffRows.filter((r) => r.group === 'fact') : []))
const planRows = computed(() => (state.value && state.value.diffRows ? state.value.diffRows.filter((r) => r.group === 'plan') : []))
function onOpenChange(v) {
  if (!v) c.cancel()
}
function guardClose(e) {
  if (state.value && state.value.busy) e.preventDefault()
}
</script>

<template>
  <DialogRoot :open="open" @update:open="onOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(92vw,22.5rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto scroll-slim rounded-lg border bg-card p-4 shadow-lg"
        @escape-key-down="guardClose"
        @pointer-down-outside="guardClose"
      >
        <DialogTitle class="text-base font-semibold">{{ state && state.planId ? '开始这项安排' : '开始执行' }}</DialogTitle>
        <DialogDescription class="sr-only">核对安排与行动事实后明确开始；取消不创建会话。</DialogDescription>

        <div v-if="state" class="mt-2 space-y-2.5 text-sm">
          <div class="rounded-md border p-2.5">
            <div class="text-xs text-muted-foreground">所属任务</div>
            <div class="mt-0.5 flex flex-wrap items-center gap-2">
              <span class="min-w-0 flex-1 break-words font-medium">{{ state.taskTitle }}</span>
              <Badge variant="secondary">{{ label(STATUS_LABELS, state.taskStatus) }}</Badge>
            </div>
            <div class="mt-1 text-xs text-muted-foreground">任务总截止：<span class="font-date">{{ deadlineText }}</span></div>
            <p v-if="risk && (risk.kind === 'after_deadline' || risk.overdue)" class="mt-1 text-xs text-destructive">
              {{ risk.kind === 'after_deadline' ? '安排日晚于任务截止（仅提示，不禁止，不自动改期）' : '任务已逾期（仅提示）' }}
            </p>
          </div>

          <div v-if="state.planId && state.expected" class="rounded-md border p-2.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-muted-foreground">安排日期</span>
              <span class="font-date font-medium">{{ planDate }}</span>
              <Badge v-if="dateRelation" :variant="dateRelation === '今天' ? 'success' : 'warning'">{{ dateRelation }}</Badge>
            </div>
            <div class="mt-1 break-words">{{ state.expected.action_text }}</div>
            <div class="mt-0.5 text-xs text-muted-foreground">安排预计 {{ state.expected.planned_minutes }} 分钟 · 安排说明不覆盖行动内容</div>
          </div>

          <div class="rounded-md border p-2.5">
            <div class="text-xs text-muted-foreground">将执行的行动（按 ID 明确选择，不按文字匹配）</div>
            <template v-if="state.facts">
              <div class="mt-0.5 break-words font-medium">{{ state.facts.actionText }}</div>
              <div class="mt-0.5 text-xs text-muted-foreground">行动预计 {{ state.facts.actionMinutes }} 分钟</div>
            </template>
            <p v-else class="mt-1 text-xs text-warning-foreground">尚未选择有效当前行动。请先去任务页选择或新增行动，再开始。</p>
          </div>

          <!-- blocked / 非当日：同一面板明确确认；未勾选不提交对应确认参数 -->
          <label v-if="blockedRequired" class="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-2.5 text-xs">
            <input v-model="state.blockedChecked" type="checkbox" class="mt-0.5 accent-primary" />
            <span>任务当前受阻：确认后开始，任务将转为进行中。不勾选不会开始。</span>
          </label>
          <label v-if="dateMismatch" class="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-2.5 text-xs">
            <input v-model="state.dateChecked" type="checkbox" class="mt-0.5 accent-primary" />
            <span>安排日 {{ planDate }} 与今天 {{ state.confirmDate }} 不同（{{ dateRelation }}）。实际开始按真实时钟记录，原安排日不改。跨北京午夜需重新核对。</span>
          </label>

          <!-- 差异重确认：列全变化字段，确认只换到展示过的冻结版本 -->
          <div v-if="state.phase === 'diffs'" class="rounded-md border border-warning bg-warning/10 p-2.5 text-xs">
            <div class="font-medium text-warning-foreground">确认期间事实已变化，请核对全部差异</div>
            <ul class="mt-1 space-y-1">
              <li v-for="row in planRows" :key="'p-' + row.field">
                「{{ row.name }}」：{{ planFieldValueLabel(row.field, row.expected, taskTitleOf) }} → {{ planFieldValueLabel(row.field, row.current, taskTitleOf) }}
              </li>
              <li v-for="row in factRows" :key="'f-' + row.field">
                「{{ label(BEGIN_FACT_LABELS, row.field) }}」：{{ beginFactValueLabel(row.field, row.expected, actionTextOf) }} → {{ beginFactValueLabel(row.field, row.current, actionTextOf) }}
              </li>
            </ul>
            <p v-if="!planRows.length && !factRows.length" class="mt-1">提交期间事实曾被其它修改更新，开框冻结的最新快照与提交基线逐字段一致（外部可能已改回）。</p>
            <div class="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" @click="c.confirmDiffs">已核对，重新确认</Button>
            </div>
          </div>

          <!-- 错误/待核实区 -->
          <div v-if="state.error" role="alert" class="rounded-md border border-destructive/60 bg-destructive/10 p-2.5 text-xs">
            <p>{{ state.error.message }}</p>
            <ul v-if="state.error.problems && state.error.problems.length" class="mt-1 list-disc space-y-0.5 pl-4">
              <li v-for="p in state.error.problems" :key="p.code + p.sessionId">
                {{ label(PLAN_PROBLEM_LABELS, p.code) }} ·
                <RouterLink :to="recordPath(p.sessionId, '/today')" class="underline">查看该记录</RouterLink>
              </li>
            </ul>
            <div class="mt-2 flex flex-wrap gap-2">
              <Button v-if="state.error.session" size="sm" variant="outline" @click="c.gotoSession(state.error.session)">前往该工作</Button>
              <Button v-if="state.error.reviewPlanId" size="sm" variant="outline" @click="c.gotoReview">核对已有进度</Button>
              <template v-if="state.phase === 'verify'">
                <Button size="sm" variant="outline" :disabled="state.busy" @click="c.verify">{{ state.pendingSid ? '重试读取' : '核实结果' }}</Button>
                <Button v-if="state.envelope && !state.pendingSid" size="sm" variant="outline" :disabled="state.busy" @click="c.submit">原信封重试</Button>
              </template>
              <template v-if="state.phase === 'stale'">
                <Button size="sm" variant="outline" :disabled="state.busy" @click="c.verify">核实是否已开始</Button>
                <Button size="sm" variant="outline" :disabled="state.busy" @click="c.refreeze">重新核对事实</Button>
              </template>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
            <Button v-if="state.planId" size="sm" variant="outline" :disabled="state.busy" @click="c.gotoTask">去任务选择行动</Button>
            <Button size="sm" variant="outline" :disabled="state.busy" @click="c.cancel">取消</Button>
            <Button
              v-if="state.phase === 'confirm'"
              size="sm"
              class="ml-auto"
              :disabled="!canConfirm"
              :aria-busy="state.busy"
              @click="c.submit"
            >{{ state.busy ? '正在开始…' : '确认并开始' }}</Button>
          </div>
          <p class="text-[11px] text-muted-foreground">开始后进入工作页计时；取消不创建会话。事实变化会要求重新核对，不会静默改绑行动。</p>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>