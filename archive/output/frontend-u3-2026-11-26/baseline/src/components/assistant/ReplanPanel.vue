<script setup>
// M3 改排面板：替换范围勾选 + 进展/工作量清单（开工单 §3A/§3B）。
// setup（taskId：任务详情/助手入口）与 edit（draft：改排草案编辑区）两用。
// 资格与准备/提交同一 replacementEligibility；受保护条目只读并展示原因，绝不静默纳入替换集。
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { CalendarClock, ListChecks, Plus, Trash2 } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Badge from '@/components/ui/Badge.vue'
import DateInput from '@/components/ui/DateInput.vue'
import { useAppStore } from '@/stores/app'
import { useAssistantStore } from '@/stores/assistant'
import { replacementEligibility, PROTECTION_LABELS, REPLAN_PRIORITIES, replanRowsSignature } from '@/domains/assistant/replan'
import { windowDates } from '@/domains/planning/protocol'
import { beijingToday, formatWhen, isValidDate } from '@/domains/time'
import { resolveReplanReturn } from '@/domains/workNavigation'

const props = defineProps({
  taskId: { type: String, default: null },
  draft: { type: Object, default: null },
})
const emit = defineEmits(['started'])
const app = useAppStore()
const store = useAssistantStore()
const router = useRouter()
const route = useRoute()

const EDITABLE = ['editing', 'needs_clarification', 'needs_review', 'ready']
const editable = computed(() => !props.draft || EDITABLE.includes(props.draft.status))
const taskId = computed(() => props.draft?.replan_scope?.task_id ?? props.taskId)
const task = computed(() => app.docs.find((d) => d.kind === 'task' && d.id === taskId.value) ?? null)
const taskReturn = computed(() => resolveReplanReturn(route.query.return, taskId.value, {
  docs: app.docs, ws: app.workspaceId, todayStr: beijingToday(),
}))
const scopeStart = computed(() => props.draft?.replan_scope?.start_date ?? beijingToday())
const ctx = computed(() => ({
  workspaceId: app.workspaceId,
  task: task.value,
  today: beijingToday(),
  window: new Set(windowDates(scopeStart.value)),
  focusSessions: app.docs.filter((d) => d.kind === 'focus_session'),
}))
const windowItems = computed(() => app.docs
  .filter((d) => d.kind === 'plan_item' && d.task_id === taskId.value && ctx.value.window.has(d.date))
  .map((item) => ({ item, elig: replacementEligibility(item, ctx.value) }))
  .sort((a, b) => (a.item.date === b.item.date ? (a.item.order ?? 0) - (b.item.order ?? 0) : a.item.date < b.item.date ? -1 : 1)))
const futureOutside = computed(() => {
  const days = windowDates(scopeStart.value)
  const last = days[days.length - 1]
  return app.docs.filter((d) => d.kind === 'plan_item' && d.task_id === taskId.value && d.date > last && d.state === 'planned')
})
const taskActions = computed(() => app.docs.filter((d) => d.kind === 'action' && d.task_id === taskId.value))
const reuseOptions = computed(() => taskActions.value.filter((a) => !a.done))

const PRIORITY_LABELS = { low: '低', normal: '普通', high: '高' }
const emptyRow = () => ({
  text: '', minutes: '', reuse: '', splittable: true, minSeg: '25', earliest: '', priority: 'normal', depsText: '',
})
const rowOf = (w, c = {}) => ({
  text: w.text,
  minutes: w.minutes == null ? '' : String(w.minutes),
  reuse: w.reuse_action_id ?? '',
  splittable: w.splittable ?? true,
  minSeg: w.min_segment_minutes == null ? '' : String(w.min_segment_minutes),
  earliest: c.earliest ?? '',
  priority: c.priority ?? 'normal',
  depsText: c.depsText ?? '',
})
// 已确认清单的约束只存在于 proposal（progress_input 契约不含三项）：按同序 key 读回，逐行展示可调整。
function draftConstraints() {
  const ws = props.draft?.proposal?.work_items ?? []
  const items = props.draft?.progress_input?.work_items ?? []
  if (!ws.length || ws.length !== items.length || !ws.every((w) => w.estimate_origin === 'user')) return null
  const keyToNo = new Map(items.map((w, i) => [w.key ?? `rw${i + 1}`, i + 1]))
  return ws.map((w) => ({
    earliest: w.earliest_date ?? '',
    priority: w.priority ?? 'normal',
    depsText: (w.depends_on ?? []).map((k) => keyToNo.get(k) ?? k).join(','),
  }))
}
const selected = ref([])
const statement = ref('')
const rows = reactive([])
function initFromDraft() {
  const p = props.draft?.progress_input
  selected.value = [...(props.draft?.replan_scope?.replacement_ids ?? [])]
  statement.value = p?.statement ?? ''
  rows.length = 0
  const cs = draftConstraints()
  ;(p?.work_items ?? []).forEach((w, i) => rows.push(rowOf(w, cs?.[i])))
  if (!rows.length) rows.push(emptyRow())
}
// 只随草案/任务身份重建；保存后的版本 bump 不清空用户正在编辑的表单。
watch(() => props.draft?.id ?? props.taskId, initFromDraft, { immediate: true })

const toggle = (id) => {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}
const retainedCount = computed(() => windowItems.value.filter((x) => !selected.value.includes(x.item.id)).length)

function parseDeps(text, rowNo, total) {
  const nums = []
  for (const t of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const n = Number(t)
    if (!Number.isInteger(n) || n < 1 || n > total) throw new Error(`第 ${rowNo} 行依赖「${t}」不是有效行号（1–${total}）`)
    if (n === rowNo) throw new Error(`第 ${rowNo} 行不能依赖自身`)
    if (nums.includes(n)) throw new Error(`第 ${rowNo} 行依赖行号重复`)
    nums.push(n)
  }
  return nums
}

// 一次构建清单 + 同行约束（最早日期/依赖/优先级）；约束随保存重建进 proposal，不写进 progress_input。
function buildForm() {
  const items = []
  const constraints = []
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]
    const text = r.text.trim()
    if (!text) throw new Error(`第 ${i + 1} 行工作内容不能为空`)
    let minutes = null
    if (String(r.minutes).trim() !== '') {
      const n = Number(r.minutes)
      if (!Number.isInteger(n) || n <= 0) throw new Error(`第 ${i + 1} 行分钟数必须是正整数或留空（未知），不能为 0`)
      minutes = n
    }
    let minSeg = null
    if (String(r.minSeg).trim() !== '') {
      const n = Number(r.minSeg)
      if (!Number.isInteger(n) || n < 1 || n > 240) throw new Error(`第 ${i + 1} 行最小段长必须是 1–240 的整数或留空（默认 25）`)
      minSeg = n
    }
    if (r.reuse && !reuseOptions.value.some((a) => a.id === r.reuse)) throw new Error(`第 ${i + 1} 行复用的行动不是本任务未完成行动，请重新选择`)
    const earliest = String(r.earliest ?? '').trim()
    if (earliest && !isValidDate(earliest)) throw new Error(`第 ${i + 1} 行最早日期「${earliest}」不是合法日期（YYYY-MM-DD）`)
    if (!REPLAN_PRIORITIES.includes(r.priority ?? 'normal')) throw new Error(`第 ${i + 1} 行优先级不合法`)
    const depNums = parseDeps(r.depsText, i + 1, rows.length)
    items.push({ key: `rw${i + 1}`, text, reuse_action_id: r.reuse || null, minutes, splittable: !!r.splittable, min_segment_minutes: minSeg })
    constraints.push({
      earliest_date: earliest || null,
      depends_on: depNums.map((n) => `rw${n}`),
      priority: r.priority ?? 'normal',
    })
  }
  if (!items.length) throw new Error('请至少填写一行待安排工作')
  return { progress: { statement: statement.value.trim(), work_items: items }, constraints }
}

// F1：面板全部编辑态统一为一个签名，页面/store 据此阻断旧方案采用。
const liveSignature = computed(() => replanRowsSignature({
  replacementIds: selected.value,
  statement: statement.value,
  rows: rows.map((r) => ({ ...r })),
}))
watch([() => props.draft?.id ?? null, liveSignature, editable], () => {
  if (!props.draft || !editable.value) { store.setReplanForm(null); return }
  store.setReplanForm({ draftId: props.draft.id, signature: liveSignature.value })
}, { immediate: true })
onBeforeUnmount(() => store.setReplanForm(null))

function removeRow(i) {
  const blockedBy = []
  rows.forEach((r, j) => {
    if (j === i) return
    const nums = String(r.depsText ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)
    if (nums.includes(i + 1)) blockedBy.push(j + 1)
  })
  if (blockedBy.length) {
    store.say('warning', `第 ${blockedBy.join('、')} 行依赖第 ${i + 1} 行；请先调整这些依赖再删除该行`)
    return
  }
  rows.splice(i, 1)
  rows.forEach((r) => {
    const tokens = String(r.depsText ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    r.depsText = tokens.map((t) => {
      const n = Number(t)
      return Number.isInteger(n) && n > i + 1 ? String(n - 1) : t
    }).join(',')
  })
}

const busy = ref(false)
// 助手建议清单（M3）：模型接收后 estimate_origin=model 的工作项只是建议；
// 用户核对并「保存改排内容」后才重建为 estimate_origin=user 的本次清单，方可采用。
const modelSuggestion = computed(() => {
  const ws = props.draft?.proposal?.work_items ?? []
  return ws.some((w) => w.estimate_origin === 'model') ? ws : null
})
const suggestionTotal = computed(() => (modelSuggestion.value ?? []).reduce((s, w) => s + (w.remaining_minutes ?? 0), 0))
const suggestionUnknown = computed(() => (modelSuggestion.value ?? []).some((w) => w.remaining_minutes == null))
const listTotal = computed(() => rows.reduce((s, r) => s + (String(r.minutes).trim() === '' ? 0 : Number(r.minutes) || 0), 0))
const suggestionDeliverable = (key) => (modelSuggestion.value ?? []).find((w) => w.key === key)?.deliverable ?? key
const suggestionDepLabel = (w) => (w.depends_on ?? []).map(suggestionDeliverable).join('、')
function suggestionCycle(ws) {
  const deps = new Map(ws.map((w) => [w.key, w.depends_on ?? []]))
  const state = new Map()
  const visit = (k, path) => {
    if (state.get(k) === 'done') return null
    if (state.get(k) === 'visiting') return [...path, k].join(' → ')
    state.set(k, 'visiting')
    for (const d of deps.get(k) ?? []) {
      const c = visit(d, [...path, k])
      if (c) return c
    }
    state.set(k, 'done')
    return null
  }
  for (const w of ws) {
    const c = visit(w.key, [])
    if (c) return c
  }
  return null
}
// 建议→本次清单必须保留有业务意义的约束；无法承载的约束提示并阻断转换，绝不静默删除后允许采用。
function loadSuggestion() {
  const ws = modelSuggestion.value ?? []
  const idx = new Map(ws.map((w, i) => [w.key, i + 1]))
  const problems = []
  if (ws.length > 50) problems.push(`建议含 ${ws.length} 项，超过本次清单上限 50 项；请拆分后再载入`)
  for (const w of ws) {
    const earliest = String(w.earliest_date ?? '').trim()
    if (earliest && !isValidDate(earliest)) problems.push(`「${w.deliverable}」最早日期「${w.earliest_date}」不合法`)
    if (!REPLAN_PRIORITIES.includes(w.priority ?? 'normal')) problems.push(`「${w.deliverable}」优先级「${w.priority}」不合法`)
    for (const d of w.depends_on ?? []) {
      if (!idx.has(d)) problems.push(`「${w.deliverable}」依赖 ${d} 不在本次建议清单内，初版无法保留该依赖；请先调整建议`)
    }
  }
  const cycle = suggestionCycle(ws)
  if (cycle) problems.push(`建议依赖成环（${cycle}），无法保存为本次清单`)
  if (problems.length) {
    store.say('warning', `建议含无法转换的约束：${problems.join('；')}。未载入，原有清单保持不变。`)
    return
  }
  rows.length = 0
  for (const w of ws) {
    rows.push({
      text: w.deliverable,
      minutes: w.remaining_minutes == null ? '' : String(w.remaining_minutes),
      reuse: w.action_ref?.kind === 'existing' ? w.action_ref.id : '',
      splittable: w.splittable ?? true,
      minSeg: w.min_segment_minutes == null ? '' : String(w.min_segment_minutes),
      earliest: w.earliest_date ?? '',
      priority: w.priority ?? 'normal',
      depsText: (w.depends_on ?? []).map((k) => idx.get(k)).join(','),
    })
  }
  if (!rows.length) rows.push(emptyRow())
  store.say('info', '已载入助手建议到清单：最早日期/依赖/优先级已保留，请逐项核对分钟数与约束，再点「保存改排内容」确认为本次清单。')
}
async function submit() {
  if (busy.value) return
  if (!selected.value.length) { store.say('warning', '请至少勾选一条允许替换的旧安排'); return }
  let form
  try { form = buildForm() } catch (e) { store.say('warning', e.message); return }
  busy.value = true
  try {
    if (props.draft) {
      const r = await store.saveReplanContent({ replacementIds: selected.value, progress: form.progress, constraints: form.constraints })
      if (r.ok) store.say('info', '改排内容已保存；请再次「重新排程」更新预览。')
    } else {
      const r = await store.startReplan({ taskId: taskId.value, replacementIds: selected.value, progress: form.progress, constraints: form.constraints })
      if (r.ok) emit('started')
    }
  } finally { busy.value = false }
}
const deadlineLabel = computed(() => {
  const dl = task.value?.deadline
  if (!dl || (dl.precision ?? 'none') === 'none' || !dl.value) return '无截止'
  return formatWhen(dl.value, dl.precision === 'datetime' ? 'datetime' : 'date')
})
</script>

<template>
  <div class="rounded-lg border bg-card p-4">
    <h3 class="flex items-center gap-2 text-sm font-semibold"><CalendarClock class="size-4" />调整后续安排{{ draft ? '' : ' · 选择替换范围' }}</h3>
    <div v-if="!task" class="mt-2 text-sm text-destructive">任务不存在或已删除，不能改排。</div>
    <template v-else>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span class="font-medium">{{ task.title }}</span>
        <Badge variant="secondary">总截止：{{ deadlineLabel }}</Badge>
        <Badge variant="outline">本轮不修改截止</Badge>
        <Button variant="ghost" size="sm" @click="router.push(taskReturn)">原任务页</Button>
      </div>
      <p v-if="task.status === 'done'" class="mt-2 text-sm text-destructive">任务已完成，不能改排。</p>
      <template v-else>
        <div class="mt-3 rounded-md border p-2">
          <div class="text-xs font-medium text-muted-foreground">行动完成情况（只读参考；完成状态请到原任务页操作）</div>
          <ul class="mt-1 space-y-0.5 text-xs">
            <li v-for="a in taskActions" :key="a.id" class="flex items-center gap-2">
              <Badge :variant="a.done ? 'success' : 'secondary'">{{ a.done ? '已完成' : '未完成' }}</Badge>
              <span class="min-w-0 flex-1 truncate">{{ a.text }}</span>
              <span class="text-muted-foreground">{{ a.minutes }} 分钟</span>
            </li>
            <li v-if="!taskActions.length" class="text-muted-foreground">该任务还没有行动。</li>
          </ul>
        </div>

        <div class="mt-3">
          <div class="text-xs font-medium text-muted-foreground">本轮七日窗口（{{ scopeStart }} 起）：勾选允许替换的旧安排</div>
          <ul class="mt-1 divide-y rounded-md border">
            <li v-for="x in windowItems" :key="x.item.id" class="flex items-center gap-2 p-2 text-sm">
              <input v-if="x.elig.eligible" type="checkbox" :checked="selected.includes(x.item.id)" :disabled="!editable" :aria-label="`替换安排 ${x.item.date} ${x.item.action_text}`" @change="toggle(x.item.id)" />
              <span class="w-24 shrink-0 text-xs text-muted-foreground">{{ x.item.date }}</span>
              <span class="min-w-0 flex-1 truncate">{{ x.item.action_text }}</span>
              <span class="text-xs">{{ x.item.planned_minutes }} 分钟</span>
              <Badge v-if="!x.elig.eligible" variant="warning">{{ PROTECTION_LABELS[x.elig.reason] ?? x.elig.reason }}</Badge>
            </li>
            <li v-if="!windowItems.length" class="p-2 text-xs text-muted-foreground">窗口内该任务没有安排。</li>
          </ul>
          <p v-if="futureOutside.length" class="mt-1 text-xs text-muted-foreground">另有 {{ futureOutside.length }} 条窗口外未来安排，不纳入本轮替换，继续保留。</p>
          <p class="mt-1 text-xs">本次将替换 {{ selected.length }} 条、保留 {{ retainedCount }} 条（未选与受保护安排继续占用容量）。</p>
        </div>

        <div class="mt-3 space-y-2">
          <label class="block text-xs font-medium text-muted-foreground">进展说明（一句话）</label>
          <Textarea v-model="statement" :disabled="!editable" placeholder="例如：资料读完了，报告还需安排 90 分钟，周四没空" />
          <div class="text-xs font-medium text-muted-foreground">本次待安排清单（已含所选旧安排对应的未完工作；不含保留安排继续覆盖的工作）</div>
          <div v-for="(r, i) in rows" :key="i" class="space-y-1 rounded-md border p-2">
            <div class="flex items-center gap-2">
              <Input v-model="r.text" :disabled="!editable" class="flex-1" :aria-label="`第 ${i + 1} 行工作内容`" placeholder="工作内容" />
              <Button variant="ghost" size="sm" :disabled="!editable || rows.length <= 1" :aria-label="`删除第 ${i + 1} 行`" @click="removeRow(i)"><Trash2 /></Button>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <select v-model="r.reuse" :disabled="!editable" class="h-8 rounded-md border bg-background px-2 text-xs" :aria-label="`第 ${i + 1} 行复用行动`">
                <option value="">新增行动（将新增）</option>
                <option v-for="a in reuseOptions" :key="a.id" :value="a.id">复用：{{ a.text }}</option>
              </select>
              <label class="flex items-center gap-1">分钟<Input v-model="r.minutes" :disabled="!editable" class="h-8 w-20" inputmode="numeric" :aria-label="`第 ${i + 1} 行分钟数`" /></label>
              <label class="flex items-center gap-1"><input v-model="r.splittable" type="checkbox" :disabled="!editable" />可拆分</label>
              <label class="flex items-center gap-1">最小段<Input v-model="r.minSeg" :disabled="!editable" class="h-8 w-16" inputmode="numeric" :aria-label="`第 ${i + 1} 行最小段长`" /></label>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <label class="flex items-center gap-1">最早开始<DateInput v-model="r.earliest" :disabled="!editable" class="h-8 w-36" :aria-label="`第 ${i + 1} 行最早日期`" /></label>
              <label class="flex items-center gap-1">优先级<select v-model="r.priority" :disabled="!editable" class="h-8 rounded-md border bg-background px-2 text-xs" :aria-label="`第 ${i + 1} 行优先级`">
                <option v-for="p in REPLAN_PRIORITIES" :key="p" :value="p">{{ PRIORITY_LABELS[p] }}</option>
              </select></label>
              <label class="flex items-center gap-1">依赖行<Input v-model="r.depsText" :disabled="!editable" class="h-8 w-24" :aria-label="`第 ${i + 1} 行依赖行号`" placeholder="如 1,2" /></label>
            </div>
            <p v-if="!r.reuse && String(r.minutes).trim() === ''" class="text-xs text-amber-700">新增行动分钟数未知：请补充分钟数，或改为复用既有行动。</p>
          </div>
          <Button variant="outline" size="sm" :disabled="!editable || rows.length >= 50" @click="rows.push(emptyRow())"><Plus />添加一行</Button>
        </div>

        <div v-if="draft && modelSuggestion" class="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2">
          <div class="text-xs font-medium text-amber-800">助手建议清单（建议，未确认；采用前须核对并保存为本次清单）</div>
          <ul class="mt-1 space-y-0.5 text-xs">
            <li v-for="w in modelSuggestion" :key="w.key" class="space-y-0.5">
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate">{{ w.deliverable }}</span>
                <span>{{ w.remaining_minutes == null ? '未知' : `${w.remaining_minutes} 分钟` }}</span>
                <Badge variant="outline">{{ w.action_ref?.kind === 'existing' ? '复用既有行动' : '建议新增行动' }}</Badge>
              </div>
              <div v-if="w.earliest_date || (w.depends_on ?? []).length || (w.priority ?? 'normal') !== 'normal'" class="flex flex-wrap gap-2 text-muted-foreground">
                <span v-if="w.earliest_date">最早 {{ w.earliest_date }}</span>
                <span v-if="(w.depends_on ?? []).length">依赖 {{ suggestionDepLabel(w) }}</span>
                <span v-if="(w.priority ?? 'normal') !== 'normal'">优先级 {{ PRIORITY_LABELS[w.priority] ?? w.priority }}</span>
              </div>
            </li>
          </ul>
          <p class="mt-1 text-xs">建议总量 {{ suggestionTotal }} 分钟{{ suggestionUnknown ? '（含未知项，须补充）' : '' }}；当前清单总量 {{ listTotal }} 分钟。</p>
          <p v-if="store.replanPanelDirty" class="mt-1 text-xs text-amber-800">清单有未保存修改；载入建议会覆盖当前清单，请先保存或确认放弃。</p>
          <Button variant="outline" size="sm" class="mt-1" :disabled="!editable || store.replanPanelDirty" @click="loadSuggestion">载入建议到清单（核对后保存）</Button>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <Button :disabled="!editable || busy || store.busy.saving" @click="submit">
            <ListChecks class="size-4" />{{ draft ? '保存改排内容' : '创建改排草案' }}
          </Button>
          <Button v-if="draft" variant="secondary" :disabled="!editable || busy || store.generating || store.replanPanelDirty" @click="store.generateReplan()">请助手整理剩余工作</Button>
          <span v-if="draft" class="text-xs text-muted-foreground">保存后请再次「重新排程」；旧预览与采用确认随之失效。</span>
        </div>
        <p v-if="draft && store.replanPanelDirty" class="mt-2 text-xs text-amber-700">改排面板有未保存修改：旧方案不能采用，请先「保存改排内容」并重新排程。</p>
      </template>
    </template>
  </div>
</template>
