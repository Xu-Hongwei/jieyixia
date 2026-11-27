<script setup>
import { computed, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'

const props = defineProps(['gap', 'title', 'reason', 'days', 'slot', 'acknowledged', 'disabled', 'editing', 'earliest', 'today', 'suggestedDate', 'saveChoice'])
const emit = defineEmits(['edit', 'close'])
const date = ref('')
const time = ref('')
const extra = ref(false)
const error = ref('')
const minimum = computed(() => props.earliest > props.today ? props.earliest : props.today)
watch(() => props.editing, open => {
  if (!open) return
  const firstDay = props.days[0]?.date
  date.value = props.slot?.date ?? (firstDay > minimum.value ? firstDay : minimum.value)
  time.value = props.slot?.time ?? ''
  extra.value = !!props.slot?.allowExtra
  error.value = ''
}, { immediate: true })
function availableMinutes(day) {
  if (!day) return null
  const released = props.slot?.date === day.date ? props.gap.remaining_minutes : 0
  return Math.max(0, day.budget_minutes - day.buffer_minutes - day.committed_minutes - day.allocated_minutes + released)
}
const free = computed(() => availableMinutes(props.days.find(d => d.date === date.value)))
const overBudget = computed(() => free.value != null && props.gap.remaining_minutes > free.value)
async function save(leaveUnscheduled) {
  const key = props.gap.work_item_key
  const response = await props.saveChoice(key, leaveUnscheduled ? null : {
    date: date.value, time: time.value, allowExtra: extra.value && overBudget.value,
  })
  if (!response.ok) error.value = response.message || '保存失败，请重试。'
}
</script>

<template>
  <div class="border-b py-2 last:border-0">
    <p v-if="!slot" class="text-sm font-medium">{{ title }} · {{ gap.remaining_minutes }} 分钟</p>
    <p v-if="!slot" class="text-xs text-muted-foreground">{{ suggestedDate ? '最早可安排在 ' + suggestedDate : reason }}</p>
    <fieldset v-if="editing" :disabled="disabled" class="mt-2 space-y-2">
      <div class="flex flex-wrap items-end gap-2 text-sm">
        <label>日期<input v-model="date" type="date" :min="minimum" aria-label="安排日期" class="ml-1 max-w-full rounded-md border bg-background p-1" @change="extra = false" /></label>
        <label>开始时间（可选）<input v-model="time" type="time" class="ml-1 rounded-md border bg-background p-1" /></label>
      </div>
      <label v-if="overBudget" class="block text-xs"><input v-model="extra" type="checkbox" /> 当天剩余 {{ free }} 分钟，仍安排这项工作</label>
      <p v-else-if="date" class="text-xs text-muted-foreground">{{ free == null ? '这天尚未核算可用时间。' : '当天还可排 ' + free + ' 分钟' }}</p>
      <div class="flex gap-2">
        <Button size="sm" :disabled="!date || date < minimum || (overBudget && !extra)" @click="save(false)">保存到草案</Button>
        <Button size="sm" variant="ghost" @click="emit('close')">取消</Button>
      </div>
    </fieldset>
    <div v-else class="mt-1 flex flex-wrap gap-2">
      <Button v-if="suggestedDate && !slot && !acknowledged && suggestedDate >= minimum" size="sm" :disabled="disabled" @click="date = suggestedDate; time = ''; save(false)">按这天安排</Button>
      <Button size="sm" variant="outline" :disabled="disabled" @click="emit('edit')">{{ slot ? '修改时间' : '选一天' }}</Button>
      <Button v-if="slot || !acknowledged" size="sm" variant="ghost" :disabled="disabled" @click="save(true)">暂不安排</Button>
      <span v-else class="self-center text-xs text-muted-foreground">暂不安排</span>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-xs text-destructive">{{ error }}</p>
  </div>
</template>
