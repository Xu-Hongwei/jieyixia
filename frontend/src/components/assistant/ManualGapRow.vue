<script setup>
import { computed, ref, watch } from 'vue'
import Button from '@/components/ui/Button.vue'
import { useAssistantStore } from '@/stores/assistant'

const props = defineProps(['gap', 'title', 'reason', 'days', 'slot', 'acknowledged', 'disabled', 'editing'])
const emit = defineEmits(['edit', 'close'])
const store = useAssistantStore()
const date = ref('')
const time = ref('')
const extra = ref(false)
const error = ref('')
watch(() => props.editing, open => {
  if (!open) return
  date.value = props.slot?.date ?? props.days[0]?.date ?? ''
  time.value = props.slot?.time ?? ''
  extra.value = !!props.slot?.allowExtra
  error.value = ''
})
const free = computed(() => {
  const day = props.days.find(d => d.date === date.value)
  if (!day) return 0
  const released = props.slot?.date === date.value ? props.gap.remaining_minutes : 0
  return Math.max(0, day.budget_minutes - day.buffer_minutes - day.committed_minutes - day.allocated_minutes + released)
})
async function save(leaveUnscheduled) {
  const key = props.gap.work_item_key
  const response = leaveUnscheduled ? await store.confirmGap(key) : await store.scheduleGap(key, {
    date: date.value, time: time.value, allowExtra: extra.value && props.gap.remaining_minutes > free.value,
  })
  if (response.ok) emit('close')
  else error.value = response.message || '保存失败，请重试。'
}
</script>

<template>
  <div class="border-b py-2 last:border-0">
    <p class="text-sm font-medium">{{ title }} · {{ gap.remaining_minutes }} 分钟</p>
    <p class="text-xs text-muted-foreground">{{ slot ? `手动安排 · ${slot.date} ${slot.time}` : reason }}</p>
    <fieldset v-if="editing" :disabled="disabled" class="mt-2 space-y-2">
      <div class="flex flex-wrap items-end gap-2 text-sm">
        <label>日期<select v-model="date" class="ml-1 rounded-md border bg-background p-1" @change="extra = false">
          <option v-for="day in days" :key="day.date" :value="day.date">{{ day.date }}</option>
        </select></label>
        <label>开始时间<input v-model="time" type="time" class="ml-1 rounded-md border bg-background p-1" /></label>
      </div>
      <label v-if="gap.remaining_minutes > free" class="block text-xs"><input v-model="extra" type="checkbox" /> 当天剩余 {{ free }} 分钟，仍安排这项工作</label>
      <div class="flex gap-2">
        <Button size="sm" :disabled="!time || (gap.remaining_minutes > free && !extra)" @click="save(false)">保存到草案</Button>
        <Button size="sm" variant="ghost" @click="emit('close')">取消</Button>
      </div>
    </fieldset>
    <div v-else class="mt-1 flex flex-wrap gap-2">
      <Button size="sm" variant="outline" :disabled="disabled" @click="emit('edit')">{{ slot ? '修改时间' : '自行安排时间' }}</Button>
      <Button v-if="slot || !acknowledged" size="sm" variant="ghost" :disabled="disabled" @click="save(true)">暂不安排</Button>
      <span v-else class="self-center text-xs text-muted-foreground">暂不安排</span>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-xs text-destructive">{{ error }}</p>
  </div>
</template>
