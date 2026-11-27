<script setup>
import { computed } from 'vue'
import DateInput from '@/components/ui/DateInput.vue'
import Input from '@/components/ui/Input.vue'
import { beijingToday, beijingAddDays } from '@/domains/time'
import { useAppStore } from '@/stores/app'
const props = defineProps({ input: { type: Object, required: true }, defaultBudget: { type: Number, required: true }, disabled: Boolean })
const app = useAppStore()
const today = computed(() => beijingToday(new Date(app.nowTick)))
const dates = computed(() => Array.from({ length: 7 }, (_, i) => beijingAddDays(props.input.startDate || today.value, i)))
const timeSummary = computed(() => {
  const values = dates.value.map(date => {
    const value = props.input.budgets[date]
    return props.input.unavailable.includes(date) ? 0 : Number(value == null || value === '' ? props.defaultBudget : value)
  })
  return values.every(n => Number.isInteger(n) && n >= 0 && n <= 1440) ? `共 ${values.reduce((a,b) => a+b,0)} 分钟` : '请检查时间输入'
})
function toggleUnavailable(date) {
  const i = props.input.unavailable.indexOf(date)
  if (i >= 0) props.input.unavailable.splice(i, 1)
  else props.input.unavailable.push(date)
}
</script>

<template>
      <details class="border-y py-3">
        <summary class="cursor-pointer text-sm font-medium">可用时间 · {{ input.startDate || today }} 起七天 · {{ timeSummary }} <span class="font-normal text-muted-foreground">编辑</span></summary>
        <div class="mt-1 flex items-center gap-2">
          <DateInput v-model="input.startDate" :disabled="disabled" aria-label="生成排程起始日期" class="w-44" />
          <span class="text-xs text-muted-foreground">留空 = 今天（{{ today }}）</span>
        </div>
        <div class="mt-2 space-y-1">
          <div v-for="date in dates" :key="date" class="flex flex-wrap items-center gap-2 text-sm">
            <span class="w-28 shrink-0 text-xs text-muted-foreground">{{ date }}</span>
            <Input v-model="input.budgets[date]" :disabled="disabled || input.unavailable.includes(date)" class="h-8 w-24" inputmode="numeric" :placeholder="String(defaultBudget)" :aria-label="`${date} 预算分钟`" />
            <span class="text-xs text-muted-foreground">分钟</span>
            <label class="ml-auto flex items-center gap-1 text-xs">
              <input type="checkbox" :checked="input.unavailable.includes(date)" :disabled="disabled" @change="toggleUnavailable(date)" />不可用
            </label>
          </div>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">北京时间；留空默认每天 {{ defaultBudget }} 分钟。</p>
      </details>
</template>
