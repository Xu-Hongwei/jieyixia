<script setup>
import { computed, ref } from 'vue'
import { DialogRoot, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from 'reka-ui'
import Button from '@/components/ui/Button.vue'
import { useAppStore } from '@/stores/app'

const props = defineProps({ project: { type: Object, required: true } })
const app = useAppStore()
const open = ref(false)
const selected = ref([])
const busy = ref(false)
const error = ref('')
const independent = computed(() => {
  const projects = new Set(app.matters.map(m => m.id))
  return app.tasks.filter(task => !projects.has(task.matter_id))
})
function toggle(value) {
  if (busy.value) return
  selected.value = []
  error.value = ''
  open.value = value
}
async function save() {
  if (busy.value || !selected.value.length) return
  busy.value = true
  try {
    const result = await app.addIndependentTasks(props.project.id, selected.value)
    if (result.ok) open.value = false
    else {
      error.value = result.message || '请重新选择任务。'
      selected.value = []
      await app.reloadDocs()
    }
  } finally { busy.value = false }
}
</script>

<template>
  <DialogRoot :open="open" @update:open="toggle">
    <DialogTrigger as-child><Button size="sm" variant="outline">加入已有任务</Button></DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/30" />
      <DialogContent class="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border bg-card p-5 shadow-lg">
        <DialogTitle class="break-words text-lg font-semibold">加入「{{ project.title }}」</DialogTitle>
        <DialogDescription class="text-sm text-muted-foreground">{{ independent.length ? '选择要归入项目的独立任务，可多选。' : '当前没有可加入的独立任务。' }}</DialogDescription>
        <div v-if="independent.length" class="min-h-0 overflow-y-auto divide-y">
          <label v-for="task in independent" :key="task.id" class="flex cursor-pointer items-start gap-3 py-2.5 text-sm">
            <input v-model="selected" type="checkbox" :value="task.id" :disabled="busy" class="mt-1 accent-primary" />
            <span class="min-w-0 break-words">{{ task.title }}</span>
          </label>
        </div>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" :disabled="busy" @click="toggle(false)">取消</Button>
          <Button :disabled="busy || !selected.length" @click="save">{{ selected.length ? '加入项目（' + selected.length + '）' : '加入项目' }}</Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
