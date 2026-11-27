<script setup>
import { computed, ref, useId, watch } from 'vue'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-vue-next'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { cn } from '@/lib/utils'
import { beijingAddDays, beijingDateStr, beijingToday, beijingWeekday, formatWhen, replaceClockKeepSeconds } from '@/domains/time'

// 北京时间日历输入。普通用户点选日期，不手写 ISO。
// 关键不变量：空值默认「显示」北京今天（仅表单初值/建议），但绝不静默写入事实——
// 只有用户主动点选某天 / 快捷按钮 / 清空才改 model；已有值原样回填，清空后保持空。
const props = defineProps({
  allowTime: { type: Boolean, default: false },
  placeholder: { type: String, default: '' },
  class: { type: String, default: '' },
})
// PopoverRoot 无根元素，透传属性（如 aria-label）显式绑到触发按钮，保证可访问名称。
defineOptions({ inheritAttrs: false })
const model = defineModel({ type: String, default: '' })

const uid = useId()
const WEEK_HEADERS = ['一', '二', '三', '四', '五', '六', '日']
const p2 = (n) => String(n).padStart(2, '0')

const open = ref(false)
const todayStr = ref(beijingToday())
const viewYear = ref(+todayStr.value.slice(0, 4))
const viewMonth = ref(+todayStr.value.slice(5, 7))

const currentDate = ref('')
const origTail = ref('') // 日期之后的原文尾巴（T17:00:00+08:00），未编辑时间时原样保留
const timeStr = ref('') // HH:MM，供原生 time 输入
const timeEdited = ref(false)

function decompose(v) {
  const m = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(v || '')
  return m ? { date: m[1], tail: m[2] || '' } : { date: '', tail: '' }
}

// 外部值变化（回填 / 工作区重置为空）时同步内部显示态；emit 后也会回到这里保持一致。
watch(model, (v) => {
  const { date, tail } = decompose(v)
  currentDate.value = date
  origTail.value = tail
  timeStr.value = (/^T(\d{2}:\d{2})/.exec(tail) || [])[1] || ''
  timeEdited.value = false
  if (date) {
    viewYear.value = +date.slice(0, 4)
    viewMonth.value = +date.slice(5, 7)
  }
}, { immediate: true })

const offsetSuffix = computed(() => (/(Z|[+-]\d{2}:\d{2})$/.exec(origTail.value) || [])[1] || '')

// 提交：date 为空 → 清空（保持空，不补今天）；否则拼接日期 + 时间尾巴。
// 仅当用户主动编辑了时间才重建尾巴，且明确偏移/Z 绝不替换；否则尾巴原样保留。
function commit(date) {
  if (!date) {
    model.value = ''
    return
  }
  let tail = origTail.value
  if (props.allowTime && timeEdited.value) {
    // 主动改时间只替换 HH:MM，原文秒与偏移/Z 保留（不再丢秒归一到分钟）。
    tail = replaceClockKeepSeconds(origTail.value, timeStr.value)
  }
  model.value = date + tail
}

function pickDay(date) {
  commit(date)
  if (!props.allowTime) open.value = false
}
function quick(days) {
  commit(beijingAddDays(todayStr.value, days))
  open.value = false
}
function clear() {
  commit('')
  open.value = false
}
function onTimeInput(e) {
  timeStr.value = e.target.value
  timeEdited.value = true
  if (currentDate.value) commit(currentDate.value)
}
function shiftMonth(delta) {
  let y = viewYear.value
  let m = viewMonth.value + delta
  if (m < 1) { m = 12; y -= 1 }
  if (m > 12) { m = 1; y += 1 }
  viewYear.value = y
  viewMonth.value = m
}
function jumpToday() {
  todayStr.value = beijingToday()
  viewYear.value = +todayStr.value.slice(0, 4)
  viewMonth.value = +todayStr.value.slice(5, 7)
}
function onOpenChange(v) {
  open.value = v
  if (v) {
    todayStr.value = beijingToday()
    if (currentDate.value) {
      viewYear.value = +currentDate.value.slice(0, 4)
      viewMonth.value = +currentDate.value.slice(5, 7)
    } else {
      jumpToday()
    }
  }
}

// 月视图 6×7 网格（周一为首），全部用北京日期数学推算，与设备时区无关。
const grid = computed(() => {
  const first = `${viewYear.value}-${p2(viewMonth.value)}-01`
  const lead = (beijingWeekday(first) + 6) % 7
  const start = beijingAddDays(first, -lead)
  const monthKey = first.slice(0, 7)
  const cells = []
  for (let i = 0; i < 42; i++) {
    const date = beijingAddDays(start, i)
    cells.push({
      date,
      day: +date.slice(8),
      inMonth: date.slice(0, 7) === monthKey,
      isToday: date === todayStr.value,
      isSelected: date === currentDate.value,
    })
  }
  return cells
})

const display = computed(() =>
  currentDate.value ? formatWhen(model.value, model.value.includes('T') ? 'datetime' : 'date') : '',
)
const emptyHint = computed(() => `${props.placeholder || '选择日期'} · 今天 ${todayStr.value}`)
</script>

<template>
  <PopoverRoot :open="open" @update:open="onOpenChange">
    <div
      :class="
        cn(
          'flex h-9 w-full min-w-0 items-center rounded-md border border-input bg-transparent shadow-xs transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          props.class,
        )
      "
    >
      <PopoverTrigger as-child>
        <button v-bind="$attrs" type="button" class="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-1 text-left text-sm outline-none">
          <CalendarDays class="size-4 shrink-0 text-muted-foreground" />
          <span v-if="display" class="min-w-0 flex-1 truncate">{{ display }}</span>
          <span v-else class="min-w-0 flex-1 truncate text-muted-foreground">{{ emptyHint }}</span>
        </button>
      </PopoverTrigger>
      <button
        v-if="currentDate"
        type="button"
        class="mr-1.5 shrink-0 rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label="清空日期"
        @click="clear"
      ><X class="size-3.5" /></button>
    </div>
    <PopoverPortal>
      <PopoverContent
        side="bottom"
        align="start"
        :side-offset="6"
        class="z-50 w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none"
      >
        <div class="mb-2 flex items-center gap-1">
          <button type="button" class="rounded p-1 hover:bg-accent" aria-label="上一月" @click="shiftMonth(-1)">
            <ChevronLeft class="size-4" />
          </button>
          <div class="flex-1 text-center text-sm font-medium">{{ viewYear }} 年 {{ viewMonth }} 月</div>
          <button type="button" class="rounded p-1 hover:bg-accent" aria-label="下一月" @click="shiftMonth(1)">
            <ChevronRight class="size-4" />
          </button>
        </div>

        <div class="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground">
          <div v-for="w in WEEK_HEADERS" :key="w" class="py-1">{{ w }}</div>
        </div>
        <div class="grid grid-cols-7 gap-0.5">
          <button
            v-for="c in grid"
            :key="c.date"
            type="button"
            :aria-label="c.date"
            :aria-current="c.isToday ? 'date' : undefined"
            :aria-pressed="c.isSelected"
            :class="
              cn(
                'flex h-8 items-center justify-center rounded-md text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                !c.inMonth && 'text-muted-foreground/50',
                c.isToday && !c.isSelected && 'ring-1 ring-ring font-semibold',
                c.isSelected && 'bg-primary text-primary-foreground hover:bg-primary/90',
              )
            "
            @click="pickDay(c.date)"
          >{{ c.day }}</button>
        </div>

        <div v-if="allowTime" class="mt-2 flex items-center gap-2 border-t pt-2">
          <label class="text-xs text-muted-foreground" :for="`time-${uid}`">时间</label>
          <input
            :id="`time-${uid}`"
            type="time"
            step="60"
            :value="timeStr"
            class="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            @input="onTimeInput"
          />
          <span v-if="offsetSuffix" class="text-xs text-muted-foreground" title="原文时区，保留不变">{{ offsetSuffix }}</span>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-1 border-t pt-2">
          <button type="button" class="rounded-md bg-secondary px-2 py-1 text-xs font-medium hover:bg-secondary/80" @click="quick(0)">今天</button>
          <button type="button" class="rounded-md bg-secondary px-2 py-1 text-xs font-medium hover:bg-secondary/80" @click="quick(1)">明天</button>
          <button type="button" class="rounded-md bg-secondary px-2 py-1 text-xs font-medium hover:bg-secondary/80" @click="quick(7)">7 天后</button>
          <span class="flex-1" />
          <button type="button" class="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent" @click="jumpToday">回到今天</button>
          <button type="button" class="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10" @click="clear">清空</button>
        </div>
        <p class="mt-2 text-[11px] leading-snug text-muted-foreground">按北京时间。空值默认显示今天，点选后才写入；清空保持为空。</p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>