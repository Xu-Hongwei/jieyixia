<script>
// 结束选择按 workspace:session 隔离保留：同会话重开（含恢复核对关闭后）不丢已选结果与卡点；
// 成功结束后由 WorkPage 显式清理。切会话/空间互不串值。
const selections = new Map()
export function forgetEndSelection(key) { selections.delete(key) }
</script>

<script setup>
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle,
} from 'reka-ui'
import Button from '@/components/ui/Button.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Alert from '@/components/ui/Alert.vue'
import { formatDurationMs } from '@/domains/work'
import { recordPath } from '@/domains/workNavigation'
import { PLAN_PROBLEM_LABELS, label } from '@/domains/labels'

// 结束表单（5A-2B §6.1）：两组结果同时展示、分别选择、一次保存；打开不结束不暂停。
// 「行动结果」完成只完成该行动；「安排进度」只作用于所属安排；不折叠成一个开关、不自动代选。
// 显示的安排事实来自 WorkPage 冻结快照（与提交同版）；待核实期间锁定输入。
const open = defineModel({ type: Boolean, default: false })
const props = defineProps({
  busy: { type: Boolean, default: false },
  error: { type: Object, default: null },
  scopeKey: { type: String, default: '' },
  // null=独立会话（不显示第二组，提交完全省略计划参数）；{missing:true}=关联损坏；否则为冻结展示事实
  planCtx: { type: Object, default: null },
  planDiffs: { type: /** @type {import('vue').PropType<Array<{ field?: string, name: string, expectedText: string, currentText: string }>>} */ (Array), default: () => [] },
  locked: { type: Boolean, default: false },
})
const emit = defineEmits(['submit', 'verify', 'retry', 'reconfirm'])

const outcome = ref('partial')
const blocker = ref('')
const planProgress = ref('partial')
const tried = ref(false)

function loadSelections() {
  const s = props.scopeKey ? selections.get(props.scopeKey) : null
  outcome.value = s ? s.outcome : 'partial'
  blocker.value = s ? s.blocker : ''
  planProgress.value = s ? s.planProgress : 'partial'
}
function persistSelections() {
  if (!props.scopeKey) return
  selections.set(props.scopeKey, { outcome: outcome.value, blocker: blocker.value, planProgress: planProgress.value })
}
watch(() => props.scopeKey, () => { loadSelections(); tried.value = false })
watch(open, (v) => { if (v) { loadSelections(); tried.value = false } })
watch([outcome, blocker, planProgress], persistSelections)

const blockerMissing = () => outcome.value === 'blocked' && !blocker.value.trim()
const disabled = () => props.busy || props.locked
function current() {
  return { outcome: outcome.value, blocker: blocker.value.trim(), planProgress: props.planCtx && !props.planCtx.missing ? planProgress.value : undefined }
}
function submit() {
  tried.value = true
  if (blockerMissing() || disabled() || (props.planCtx && props.planCtx.missing)) return
  emit('submit', current())
}
function reconfirm() {
  tried.value = true
  if (blockerMissing() || disabled()) return
  emit('reconfirm', current())
}
function guardClose(e) { if (props.busy) e.preventDefault() }
const minutesText = (m) => (m == null ? '未记录' : m === 0 ? '<1分钟' : `${m} 分钟`)
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto scroll-slim rounded-lg border bg-card p-4 shadow-lg"
        @escape-key-down="guardClose"
        @pointer-down-outside="guardClose"
      >
        <DialogTitle class="text-base font-semibold">结束本次工作</DialogTitle>
        <DialogDescription class="mt-1 text-sm text-muted-foreground">
          编辑区当前正文将作为本次成果一并保存。选择「行动完成」只完成该行动，不会自动完成任务。
        </DialogDescription>

        <!-- 所属安排事实（冻结快照，与提交同版）；独立会话不显示 -->
        <div v-if="planCtx && !planCtx.missing" class="mt-2 rounded-md border p-2.5 text-xs">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-muted-foreground">所属安排</span>
            <span class="font-date font-medium">{{ planCtx.date }}</span>
          </div>
          <p class="mt-1 break-words text-sm">{{ planCtx.actionText }}</p>
          <p class="mt-1 text-muted-foreground">
            安排预计 {{ planCtx.plannedMinutes }} 分钟 ·
            <template v-if="planCtx.unresolved">历史用时异常待核对（不显示为 0）</template>
            <template v-else-if="planCtx.historyView && planCtx.historyView.count > 0">
              已结束 {{ planCtx.historyView.count }} 段 · 累计 {{ formatDurationMs(planCtx.historyView.totalMs) }} · 实际 {{ minutesText(planCtx.historyView.actualMinutes) }}
            </template>
            <template v-else>暂无已结束历史</template>
          </p>
          <p class="mt-1 text-muted-foreground">本段有效用时将在保存时结算，不混入上方已结束累计。</p>
        </div>
        <Alert v-else-if="planCtx && planCtx.missing" variant="warning" class="mt-2">
          会话关联的安排已不存在（关联损坏）：正文仍可保存，但本次无法联动安排进度，不能结束。请先核对数据；不会自动解绑或降级为遗留结束。
        </Alert>

        <!-- 重开/重试期间事实变化提示（展示值与将提交的冻结版本一致） -->
        <div v-if="planDiffs.length" class="mt-2 rounded-md border border-dashed border-warning p-2.5 text-xs">
          <div class="font-medium text-warning-foreground">打开期间安排事实已变化，按下列最新冻结值提交</div>
          <ul class="mt-1 space-y-0.5">
            <li v-for="row in planDiffs" :key="row.name">「{{ row.name }}」：{{ row.expectedText }} → {{ row.currentText }}</li>
          </ul>
        </div>

        <fieldset class="mt-3 space-y-2" :disabled="disabled()">
          <legend class="text-sm font-medium">这次行动的结果</legend>
          <label class="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm" :class="outcome === 'done' && 'border-primary bg-primary/5'">
            <input v-model="outcome" type="radio" name="work-outcome" value="done" class="mt-0.5" />
            <span><strong>行动完成</strong><span class="block text-xs text-muted-foreground">确认完成当前行动；任务不自动完成，也不自动选下一条。</span></span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm" :class="outcome === 'partial' && 'border-primary bg-primary/5'">
            <input v-model="outcome" type="radio" name="work-outcome" value="partial" class="mt-0.5" />
            <span><strong>部分完成</strong><span class="block text-xs text-muted-foreground">记录进展，行动保持原状态，之后可再开始新一段。</span></span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm" :class="outcome === 'blocked' && 'border-primary bg-primary/5'">
            <input v-model="outcome" type="radio" name="work-outcome" value="blocked" class="mt-0.5" />
            <span><strong>被阻塞</strong><span class="block text-xs text-muted-foreground">写明具体卡点；行动/任务状态不会自动改为受阻。</span></span>
          </label>
        </fieldset>
        <div v-if="outcome === 'blocked'" class="mt-2">
          <Textarea v-model="blocker" :disabled="disabled()" class="min-h-16" placeholder="具体卡点（必填）：缺什么、等谁、卡在哪一步…" aria-label="阻塞说明" />
          <p v-if="tried && blockerMissing()" class="mt-1 text-xs text-destructive">受阻结束必须填写具体卡点。</p>
        </div>

        <!-- 第二组：这项安排的进度（仅关联会话；与行动结果独立，六组合全允许） -->
        <fieldset v-if="planCtx && !planCtx.missing" class="mt-3 space-y-2" :disabled="disabled()">
          <legend class="text-sm font-medium">这项安排的进度</legend>
          <label class="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm" :class="planProgress === 'partial' && 'border-primary bg-primary/5'">
            <input v-model="planProgress" type="radio" name="plan-progress" value="partial" class="mt-0.5" />
            <span><strong>还需要继续</strong><span class="block text-xs text-muted-foreground">安排保持部分完成，之后可另安排一天继续。</span></span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm" :class="planProgress === 'done' && 'border-primary bg-primary/5'">
            <input v-model="planProgress" type="radio" name="plan-progress" value="done" class="mt-0.5" />
            <span><strong>这项安排已完成</strong><span class="block text-xs text-muted-foreground">只完成这项安排，不代表完成任务；行动结果按上方选择单独记录。</span></span>
          </label>
        </fieldset>

        <!-- 错误/待核实/重确认区（按真实错误码分支，不只靠禁用证明安全） -->
        <template v-if="error">
          <Alert variant="destructive" class="mt-2">{{ error.message }}</Alert>
          <div v-if="error.kind === 'history'" class="mt-2 rounded-md border p-2.5 text-xs">
            <div class="font-medium">核对历史用时摘要（只含已结束会话，不含当前段）</div>
            <p v-if="error.history" class="mt-1">
              {{ error.history.endedSessionIds.length }} 段已结束 · 累计 {{ formatDurationMs(error.history.totalMs) }} · 实际 {{ minutesText(error.history.actualMinutes) }}
            </p>
            <Button size="sm" variant="outline" class="mt-2" :disabled="disabled()" @click="reconfirm">已核对，继续</Button>
          </div>
          <div v-else-if="error.kind === 'stale-plan'" class="mt-2 rounded-md border p-2.5 text-xs">
            <div class="font-medium">安排事实已变化，请核对全部差异</div>
            <ul class="mt-1 space-y-0.5">
              <li v-for="row in error.rows || []" :key="row.name">「{{ row.name }}」：{{ row.expectedText }} → {{ row.currentText }}</li>
            </ul>
            <Button size="sm" variant="outline" class="mt-2" :disabled="disabled()" @click="reconfirm">已核对，重新确认</Button>
          </div>
          <div v-else-if="error.kind === 'problems'" class="mt-2 rounded-md border p-2.5 text-xs">
            <div class="font-medium">历史用时存在异常，先核对处理（不自动修数据）</div>
            <ul class="mt-1 list-disc space-y-0.5 pl-4">
              <li v-for="p in error.problems || []" :key="p.code + p.sessionId">
                {{ label(PLAN_PROBLEM_LABELS, p.code) }} ·
                <RouterLink :to="recordPath(p.sessionId, '/today')" class="underline">查看该记录</RouterLink>
              </li>
            </ul>
          </div>
          <div v-else-if="error.kind === 'verify'" class="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" :disabled="busy" @click="emit('verify')">核实结果</Button>
            <Button v-if="error.canRetry" size="sm" variant="outline" :disabled="busy" @click="emit('retry')">原信封重试</Button>
          </div>
        </template>

        <div class="mt-4 flex justify-end gap-2">
          <Button variant="outline" :disabled="busy" @click="open = false">取消</Button>
          <Button :disabled="disabled() || (planCtx && planCtx.missing)" @click="submit">{{ busy ? '正在结束…' : '结束并保存' }}</Button>
        </div>
        <p class="mt-2 text-[11px] text-muted-foreground">取消只关闭表单，不结束、不暂停、不写进度；同会话重开保留已选结果与卡点。</p>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>