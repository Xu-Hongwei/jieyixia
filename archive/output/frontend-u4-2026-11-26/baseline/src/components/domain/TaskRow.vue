<script setup>
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Check, Clock, Pencil, Trash2 } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import DeleteImpact from '@/components/domain/DeleteImpact.vue'
import Input from '@/components/ui/Input.vue'
import NodeSelect from '@/components/domain/NodeSelect.vue'
import { useAppStore } from '@/stores/app'
import { deleteImpactSnapshot } from '@/domains/matter'
import { formatWhen, isOverdue } from '@/domains/time'
import { STATUS_LABELS, label } from '@/domains/labels'

const props = defineProps({
  task: { type: Object, required: true },
})
const store = useAppStore()
const route = useRoute()
const router = useRouter()
const renaming = ref(false)
const draftTitle = ref('')
const deleteOpen = ref(false)
const rowScopeNotice = ref(false)
const finishConfirmOpen = ref(false)

// 统一入口：标题进入任务详情，携带当前列表上下文（视图/筛选/日期）供返回恢复。
const detailLink = computed(() => ({ path: '/tasks/' + props.task.id, query: { return: route.fullPath } }))
const actionCount = computed(() => store.actionsOf(props.task.id).length)
const unfinishedCount = computed(() => store.unfinishedCountOf(props.task.id))

const matterItems = computed(() => [
  { value: '', label: '未归组' },
  ...store.matters.map((m) => ({ value: m.id, label: m.title })),
])
const matterModel = computed({
  get: () => props.task.matter_id || '',
  set: (v) => store.setMatter(props.task, v || null),
})
function deadlineSource(t) {
  if (!t.deadline || !t.deadline.value) return '无截止'
  if (t.deadline.source === 'manual') return '用户手动输入'
  const note = store.notes.find((n) => n.id === t.deadline.from_note_id)
  return note ? `来自便签「${note.title}」` : '来自便签'
}
function startRename() {
  draftTitle.value = props.task.title
  renaming.value = true
}
async function saveRename() {
  const r = await store.renameTask(props.task, draftTitle.value)
  if (r && r.ok) renaming.value = false
}
// 完成任务是独立显式操作：有未完成行动时提示数量并确认，不批量伪造行动完成。
function requestFinish() {
  if (unfinishedCount.value > 0) finishConfirmOpen.value = true
  else store.finishTask(props.task)
}
async function confirmFinish() {
  finishConfirmOpen.value = false
  await store.finishTask(props.task)
}
// §10：打开时冻结影响事实，提交原快照；范围/处置变化 → 不删除，刷新后重新冻结、重新确认。
const deleteFacts = ref(null)
const deleteBlocked = computed(() => !!deleteFacts.value && deleteFacts.value.rows.some((r) => r.disposition.startsWith('blocked')))
function freezeDeleteFacts() {
  const t = props.task
  const snap = deleteImpactSnapshot(store.docs, [t.id], store.docs.filter((d) => d.kind === 'focus_session'))
  deleteFacts.value = { taskIds: [t.id], actionIds: store.actionsOf(t.id).map((a) => a.id), ...snap }
}
function openDelete() {
  rowScopeNotice.value = false
  freezeDeleteFacts()
  deleteOpen.value = true
}
async function confirmDelete() {
  const t = props.task
  const frozen = deleteFacts.value
  if (!frozen) { deleteOpen.value = false; return }
  deleteOpen.value = false
  const r = await store.deleteTask(t, {
    taskIds: frozen.taskIds, actionIds: frozen.actionIds, planItemIds: frozen.planItemIds, planFacts: frozen.planFacts,
  })
  if (r && (r.scopeChanged || r.planProgressRequired || r.unfinishedFocus)) {
    await store.reloadDocs()
    rowScopeNotice.value = true
    freezeDeleteFacts()
    deleteOpen.value = true
  }
}
function deleteGotoPlan(r) {
  deleteOpen.value = false
  router.push({ path: '/today', query: { date: r.date, plan: r.id } })
}
function deleteGotoWork(r) {
  deleteOpen.value = false
  router.push('/work/' + r.unfinishedSessionId)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3 rounded-md border p-3">
    <Clock v-if="isOverdue(props.task, new Date(store.nowTick))" class="size-4 text-red-600" />
    <div v-if="renaming" class="flex min-w-0 flex-1 basis-40 items-center gap-2">
      <Input v-model="draftTitle" class="h-8 max-w-60" aria-label="重命名任务" @keyup.enter="saveRename" />
      <Button size="sm" @click="saveRename"><Check />保存</Button>
      <Button size="sm" variant="outline" @click="renaming = false">取消</Button>
    </div>
    <div v-else class="min-w-0 flex-1 basis-40">
      <RouterLink :to="detailLink" class="block break-words text-sm font-medium underline-offset-2 hover:underline" :aria-label="'任务详情：' + props.task.title">{{ props.task.title }}</RouterLink>
      <div class="text-xs text-muted-foreground">
        截止 {{ props.task.deadline && props.task.deadline.value ? formatWhen(props.task.deadline.value, props.task.deadline.precision) : '无' }} · {{ deadlineSource(props.task) }}
      </div>
    </div>
    <Badge v-if="isOverdue(props.task, new Date(store.nowTick))" variant="destructive">已逾期</Badge>
    <Badge :variant="props.task.status === 'done' ? 'success' : 'secondary'" :title="props.task.status">{{ label(STATUS_LABELS, props.task.status) }}</Badge>
    <div class="w-28"><NodeSelect v-model="matterModel" :items="matterItems" placeholder="未归组" /></div>
    <Button v-if="props.task.status !== 'done'" size="sm" variant="outline" @click="requestFinish">完成</Button>
    <Button size="sm" variant="outline" aria-label="重命名任务" title="重命名" @click="startRename"><Pencil /></Button>
    <Button size="sm" variant="destructive" aria-label="删除任务" title="删除" @click="openDelete"><Trash2 /></Button>

    <ConfirmDialog v-model="finishConfirmOpen" title="完成任务" confirm-label="确认整体完成" @confirm="confirmFinish">
      还有 {{ unfinishedCount }} 个行动未完成。完成任务不会自动把它们标为完成；之后仍可重新打开任务。
    </ConfirmDialog>
    <ConfirmDialog v-model="deleteOpen" title="删除任务" confirm-label="删除任务" :confirm-disabled="deleteBlocked" @confirm="confirmDelete">
      <p v-if="rowScopeNotice" class="mb-2 rounded bg-warning px-2 py-1 text-xs text-warning-foreground">删除范围或安排事实已变化（其它页面新增/移除了对象，或安排已执行）。请核对下方最新影响后重新确认。</p>
      将删除任务「{{ props.task.title }}」<template v-if="actionCount">及其 {{ actionCount }} 个行动</template>。删除后可在「日程 · 恢复」撤销；不影响便签事实与原始资料。
      <DeleteImpact
        :rows="deleteFacts ? deleteFacts.rows : []"
        empty-text="该任务没有安排，删除不影响任何安排。"
        @goto-plan="deleteGotoPlan"
        @goto-work="deleteGotoWork"
      />
    </ConfirmDialog>
  </div>
</template>