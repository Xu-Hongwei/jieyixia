<script setup>
import { computed, ref } from 'vue'
import Button from '@/components/ui/Button.vue'
import { eventPreview } from '@/domains/pendingDate'
import { isValidDate } from '@/domains/time'
import { useAppStore } from '@/stores/app'

const props = defineProps({ group: { type: Object, required: true } })
const app = useAppStore()
const date = ref('')
const busy = ref(false)
const error = ref('')
const rows = computed(() => isValidDate(date.value) ? eventPreview(app.docs, props.group.key, date.value) : [])
async function confirmDate() {
  if (busy.value || !rows.value.length) return
  error.value = ''
  busy.value = true
  try { await app.resolvePendingDate(props.group.key, date.value, rows.value) }
  catch (err) { error.value = err.message }
  finally { busy.value = false }
}
</script>

<template>
  <details class="border-t py-3 text-sm">
    <summary class="cursor-pointer font-medium">{{ group.event }} · 日期待公布（{{ group.tasks.length }} 项）</summary>
    <div class="mt-3 space-y-2">
      <label class="flex items-center gap-2">活动日期 <input v-model="date" type="date" class="rounded border px-2 py-1" @input="error = ''" /></label>
      <ul class="space-y-1"><li v-for="r in rows" :key="r.id">{{ r.date || '待安排' }} · {{ r.title }} <span class="text-muted-foreground">{{ r.deadline ? '截止' : r.suggested ? '建议办理' : '' }} {{ r.note || r.minutes + ' 分钟' }}</span></li></ul>
      <p v-if="error" role="alert">{{ error }}</p>
      <Button size="sm" :disabled="busy || !rows.length" @click="confirmDate">确认日期并更新日程</Button>
    </div>
  </details>
</template>
