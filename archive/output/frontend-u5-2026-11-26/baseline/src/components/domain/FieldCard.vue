<script setup>
import { computed, ref } from 'vue'
import { Check, Pencil } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Input from '@/components/ui/Input.vue'
import NodeSelect from '@/components/domain/NodeSelect.vue'
import { useAppStore } from '@/stores/app'
import { canConfirm } from '@/domains/note'
import { formatWhen, isValidDate, isValidTimeValue } from '@/domains/time'
import { BASIS_LABELS, FIELD_LABELS, REF_SOURCE_LABELS, ROLE_LABELS, STATUS_LABELS, label } from '@/domains/labels'

const props = defineProps({
  note: { type: Object, required: true },
  field: { type: Object, required: true },
})
const store = useAppStore()

const statusVariant = { candidate: 'warning', confirmed: 'success', unresolved: 'outline', missing: 'muted' }
const editing = ref(false)
const editValue = ref('')
const nodeEdit = ref(null)
const saving = ref(false)
const hasUnsaved = computed(() => editing.value || !!nodeEdit.value)
function discardEdits() { editing.value = false; nodeEdit.value = null }
defineExpose({ hasUnsaved, saving, discardEdits })
async function confirmField() {
  if (saving.value) return
  saving.value = true
  try { await store.confirmField(props.note, props.field.key) } finally { saving.value = false }
}

const roleItems = Object.entries(ROLE_LABELS).map(([value, labelText]) => ({ value, label: labelText }))
const basisItems = Object.entries(BASIS_LABELS).map(([value, labelText]) => ({ value, label: labelText }))
const refItems = [
  { value: 'none', label: '无参照' },
  { value: 'message_date', label: '消息日期' },
  { value: 'user', label: '用户指定' },
]

function startEdit() {
  editValue.value = Array.isArray(props.field.value)
    ? props.field.value.join('\n')
    : props.field.value == null ? '' : String(props.field.value)
  editing.value = true
}
async function saveEdit() {
  if (saving.value) return
  saving.value = true
  try {
    const ok = await store.saveEdit(props.note, props.field.key, editValue.value)
    if (ok) editing.value = false
  } finally { saving.value = false }
}

function displayValue(f) {
  if (f.value == null) return f.status === 'missing' ? '原文未提' : '（空 · 待确认）'
  if (f.key === 'deadline') return formatWhen(f.value, f.precision)
  if (Array.isArray(f.value)) return f.value.join('；')
  return String(f.value)
}

function startNodeEdit(i) {
  const n = props.field.value[i]
  nodeEdit.value = {
    index: i,
    label: n.label || '',
    value: n.value || '',
    role: n.role || 'unknown',
    basis: n.basis || 'explicit',
    reference_at: n.reference_at || '',
    reference_source: n.reference_source || 'none',
    message_date: n.message_date || '',
  }
}
async function saveNodeEdit() {
  const e = nodeEdit.value
  const v = e.value.trim()
  if (v && !isValidTimeValue(v)) return store.say('warning', '节点值须为合法的日期或 ISO datetime；留空表示待确认')
  for (const k of ['reference_at', 'message_date']) {
    if (e[k] && !isValidDate(e[k])) return store.say('warning', '参照 / 消息日期须为合法的 YYYY-MM-DD')
  }
  if (saving.value) return
  saving.value = true
  try {
  const ok = await store.saveNodeEdit(props.note, e.index, {
    ...e,
    value: v,
    reference_source: e.reference_source === 'none' ? '' : e.reference_source,
  })
  if (ok) nodeEdit.value = null
  } finally { saving.value = false }
}
</script>

<template>
  <fieldset :disabled="saving" :aria-busy="saving"
    class="min-w-0 space-y-1.5 rounded-md border border-border/70 bg-background p-3"
    :class="field.key === 'deadline' && 'border-primary/40'"
    :data-field-key="field.key"
    :data-editing="editing || nodeEdit ? 'true' : undefined"
    :data-unconfirmed="field.status === 'candidate' || field.status === 'unresolved' ? 'true' : undefined"
  >
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-sm" :class="field.key === 'deadline' ? 'font-semibold' : 'font-medium'">{{ label(FIELD_LABELS, field.key) }}</span>
      <Badge :variant="statusVariant[field.status]" :title="field.status">{{ label(STATUS_LABELS, field.status) }}</Badge>
      <Badge v-if="field.derived" variant="outline" title="derived">推算</Badge>
      <Badge v-if="field.precision === 'datetime' && field.tz_known === false" variant="warning">时区未知</Badge>
      <Badge v-if="field.origin === 'user'" variant="secondary" title="origin=user">用户修改</Badge>
      <span class="flex-1" />
      <Button :disabled="saving" v-if="canConfirm(field)" size="sm" variant="outline" @click="confirmField"><Check />确认</Button>
      <Button :disabled="saving" v-if="field.key !== 'time_nodes'" size="sm" variant="ghost" @click="startEdit"><Pencil />编辑</Button>
    </div>

    <template v-if="editing">
      <DateInput v-if="field.key === 'deadline'" v-model="editValue" allow-time placeholder="截止日期（可空）" />
      <Input v-else v-model="editValue" @keyup.enter="saveEdit" />
    </template>
    <div v-else-if="field.key === 'time_nodes' && Array.isArray(field.value)" class="space-y-1.5">
      <div v-for="(n, i) in field.value" :key="i" class="rounded-md border p-2 space-y-1">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{{ n.label || '节点' + (i + 1) }}</Badge>
          <span class="break-words">{{ n.value ? formatWhen(n.value, n.precision) : '（待确认）' }}</span>
          <Badge v-if="n.basis === 'superseded'" variant="muted" :title="n.basis">已取代</Badge>
          <Badge v-else-if="n.basis && n.basis !== 'explicit'" variant="outline" :title="n.basis">{{ label(BASIS_LABELS, n.basis) }}</Badge>
          <Badge variant="outline" :title="n.role">{{ label(ROLE_LABELS, n.role || 'unknown') }}</Badge>
          <span class="flex-1" />
          <Button :disabled="saving" size="sm" variant="ghost" @click="startNodeEdit(i)"><Pencil />编辑节点</Button>
        </div>
        <div class="break-words text-xs text-muted-foreground">原文：{{ n.raw }}</div>
        <div v-if="n.reference_at" class="text-xs text-muted-foreground">
          参照 {{ n.reference_at }}（{{ label(REF_SOURCE_LABELS, n.reference_source) }}）<template v-if="n.message_date"> · 消息日期 {{ n.message_date }}</template>
        </div>
        <div v-if="nodeEdit && nodeEdit.index === i" class="grid gap-2 sm:grid-cols-2">
          <Input v-model="nodeEdit.label" placeholder="标签" />
          <DateInput v-model="nodeEdit.value" allow-time placeholder="节点日期（可空）" />
          <NodeSelect v-model="nodeEdit.role" :items="roleItems" placeholder="节点角色" />
          <NodeSelect v-model="nodeEdit.basis" :items="basisItems" placeholder="时间依据" />
          <DateInput v-model="nodeEdit.reference_at" placeholder="参照日期（可空）" />
          <NodeSelect v-model="nodeEdit.reference_source" :items="refItems" placeholder="参照来源" />
          <DateInput v-model="nodeEdit.message_date" placeholder="消息日期（可空）" />
          <div class="flex gap-2">
            <Button :disabled="saving" size="sm" @click="saveNodeEdit">保存节点</Button>
            <Button :disabled="saving" size="sm" variant="ghost" @click="nodeEdit = null">取消</Button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="break-words text-sm">{{ displayValue(field) }}</div>

    <div v-if="field.quote" class="break-words border-l-2 border-border pl-2 text-xs text-muted-foreground">原文引用：「{{ field.quote.text }}」</div>
    <div v-if="editing" class="flex gap-2">
      <Button :disabled="saving" size="sm" @click="saveEdit">保存修改</Button>
      <Button :disabled="saving" size="sm" variant="ghost" @click="editing = false">取消</Button>
    </div>
    <details class="text-xs">
      <summary class="cursor-pointer text-muted-foreground">查看原始数据</summary>
      <pre class="mt-1 overflow-auto rounded-md bg-muted p-2">{{ JSON.stringify(field, null, 2) }}</pre>
    </details>
  </fieldset>
</template>