<script setup>
import { ref } from 'vue'
import { useAppStore } from '@/stores/app'
import { useUnsavedGuard } from '@/composables/useUnsavedGuard'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import DateInput from '@/components/ui/DateInput.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'

const props = defineProps({ project: { type: Object, default: null } })
const emit = defineEmits(['close', 'saved', 'deleted'])
const app = useAppStore()
const originalTitle = props.project?.title || ''
const originalDeadline = props.project?.deadline?.value || ''
const title = ref(originalTitle)
const deadline = ref(originalDeadline)
const busy = ref(false)
const deleteOpen = ref(false)
const { guardLeave, discardOpen, settle } = useUnsavedGuard(
  () => title.value !== originalTitle || deadline.value !== originalDeadline,
  () => busy.value,
  () => { title.value = originalTitle; deadline.value = originalDeadline },
)
async function save() {
  if (busy.value) return
  busy.value = true
  try {
    const result = await app.saveProject(props.project, title.value, deadline.value)
    if (result.ok) emit('saved', result.id)
  } finally { busy.value = false }
}
async function remove() {
  if (!props.project || busy.value) return
  busy.value = true
  try {
    if ((await app.deleteMatter(props.project)).ok) emit('deleted', props.project.id)
  } finally { busy.value = false }
}
async function cancel() { if (await guardLeave()) emit('close') }
defineExpose({ guardLeave })
</script>
<template>
  <form class="space-y-4 rounded-lg border bg-card p-4" aria-label="项目信息" @submit.prevent="save">
    <h2 class="font-semibold">{{ project ? '编辑项目' : '新建项目' }}</h2>
    <div class="flex flex-wrap gap-4">
      <label class="min-w-40 flex-1 space-y-1 text-sm">项目名称<Input v-model="title" aria-label="项目名称" :disabled="busy" /></label>
      <div class="space-y-1 text-sm"><div>项目总截止（可选）</div><DateInput v-model="deadline" aria-label="项目总截止" placeholder="无总截止" allow-time :disabled="busy" /></div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button type="submit" :disabled="!title.trim() || busy">{{ project ? '保存项目' : '创建项目' }}</Button>
      <Button type="button" variant="ghost" :disabled="busy" @click="cancel">取消</Button>
      <Button v-if="project" type="button" class="ml-auto" variant="ghost" :disabled="busy" @click="deleteOpen = true">删除项目</Button>
    </div>
  </form>
  <ConfirmDialog v-model="discardOpen" title="放弃未保存的项目修改？" confirm-label="放弃修改" cancel-label="继续编辑" @confirm="settle(true)">项目名称或总截止的修改尚未保存。</ConfirmDialog>
  <ConfirmDialog v-model="deleteOpen" :title="'删除项目「' + originalTitle + '」？'" confirm-label="删除项目" @confirm="remove">项目内的任务将移至「独立任务」。资料、日程安排和工作记录继续保留。</ConfirmDialog>
</template>
