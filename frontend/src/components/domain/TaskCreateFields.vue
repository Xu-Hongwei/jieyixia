<script setup>
import { computed } from 'vue'
import Input from '@/components/ui/Input.vue'
import DateInput from '@/components/ui/DateInput.vue'
import { beijingToday } from '@/domains/time'
import { useAppStore } from '@/stores/app'

defineProps({ disabled: Boolean })
const title = defineModel('title', { type: String, required: true })
const deadline = defineModel('deadline', { type: String, required: true })
const matter = defineModel('matter', { type: String, required: true })
const app = useAppStore()
const date = computed(() => deadline.value.slice(0, 10))
const hour = computed({
  get: () => deadline.value.slice(11, 13),
  set: h => { deadline.value = h ? `${date.value || beijingToday()}T${h}:${minute.value}+08:00` : date.value },
})
const minute = computed({
  get: () => deadline.value.slice(14, 16) || '00',
  set: m => { if (hour.value) deadline.value = `${date.value}T${hour.value}:${m}+08:00` },
})
const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const minutes = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'))
function setDate(value) {
  deadline.value = value ? value + deadline.value.slice(10) : ''
}
</script>

<template>
  <label class="block space-y-1 text-sm">任务名称<Input v-model="title" aria-label="新任务名称" :disabled="disabled" placeholder="要完成什么？" /></label>
  <div class="flex flex-wrap gap-4">
    <div class="min-w-0 space-y-1 text-sm"><div>截止日期（可选）</div><DateInput :model-value="date" aria-label="新任务截止" placeholder="无截止" :disabled="disabled" @update:model-value="setDate" /></div>
    <fieldset class="min-w-0 space-y-1 text-sm" :disabled="disabled">
      <legend>截止时间（北京时间）</legend>
      <div class="flex items-center gap-1">
        <select v-model="hour" aria-label="截止小时" class="h-9 rounded-md border bg-transparent px-2">
          <option value="">不指定</option>
          <option v-for="h in hours" :key="h" :value="h">{{ h }} 时</option>
        </select>
        <select v-model="minute" aria-label="截止分钟" :disabled="!hour" class="h-9 rounded-md border bg-transparent px-2 disabled:opacity-50">
          <option v-for="m in minutes" :key="m" :value="m">{{ m }} 分</option>
        </select>
      </div>
    </fieldset>
    <label class="min-w-0 space-y-1 text-sm"><span class="block">事项</span><select v-model="matter" aria-label="新任务事项" :disabled="disabled" class="h-9 max-w-full rounded-md border bg-transparent px-2"><option value="">未归组</option><option v-for="item in app.matters" :key="item.id" :value="item.id">{{ item.title }}</option></select></label>
  </div>
</template>
