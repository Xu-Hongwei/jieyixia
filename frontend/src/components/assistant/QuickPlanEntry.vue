<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ClipboardPaste } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import { useAppStore } from '@/stores/app'
import { connectionOpen } from '@/services/api/qwenConnection'
import { MAX_SELECTED_SOURCES } from '@/domains/assistant/limits'

const QuickPlanDialog = defineAsyncComponent(() => import('./QuickPlanDialog.vue'))
const route = useRoute()
const app = useAppStore()
const session = ref(null)
let opener = null
const eligible = computed(() => app.ready && !app.isDemo && ['/today', '/tasks', '/collect'].includes(route.path))
function open() {
  if (!eligible.value || connectionOpen.value || document.querySelector('[role="dialog"],[role="alertdialog"],dialog[open]')) return
  opener = document.activeElement
  session.value = { items: [], busy: false, message: '', navigating: false }
}
function release(item) { if (item.url) URL.revokeObjectURL(item.url) }
function remove(id) {
  if (!session.value || session.value.busy) return
  const index = session.value.items.findIndex(item => item.id === id)
  if (index >= 0) release(session.value.items.splice(index, 1)[0])
}
function close(restore = true) {
  session.value?.items.forEach(release)
  session.value = null
  const previous = opener
  opener = null
  if (restore) nextTick(() => {
    if (!session.value && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
  })
}
function append(files, text = '') {
  const s = session.value
  if (!s || s.busy) return
  if (files.length && files.some(file => !file.type.startsWith('image/'))) { s.message = '请选择图片文件。'; return }
  if (files.length + Number(!!text.trim()) + s.items.length > MAX_SELECTED_SOURCES) {
    s.message = `一次最多选择 ${MAX_SELECTED_SOURCES} 份资料，请分批添加。`
    return
  }
  s.message = ''
  for (const file of files) s.items.push({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) })
  if (text.trim()) s.items.push({ id: crypto.randomUUID(), text: text.trim() })
}
function paste(event) {
  if (!eligible.value || event.defaultPrevented || connectionOpen.value || session.value?.busy) return
  const target = event.composedPath().find(node => node instanceof Element)
  const own = target?.closest('[data-quick-plan]')
  const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]:not([data-quick-plan]), dialog[open]')
  if (dialog || (!own && session.value && document.querySelector('[data-quick-plan]'))) return
  const data = event.clipboardData
  if (!data) return
  const files = Array.from(data.files)
  if (!files.length) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file) }
    }
  }
  const editing = target?.closest('input, textarea, select, [role="textbox"]') || target?.isContentEditable
  if (editing && !(own && files.length && target?.closest('textarea'))) return
  if (files.some(file => !file.type.startsWith('image/'))) return
  const text = files.length ? '' : data.getData('text/plain')
  if (!files.length && !text.trim()) return
  if (!session.value) open()
  if (!session.value) return
  event.preventDefault()
  append(files, text)
}
onMounted(() => window.addEventListener('paste', paste))
onBeforeUnmount(() => { window.removeEventListener('paste', paste); close(false) })
watch(() => app.workspaceId, () => close(false), { flush: 'sync' })
watch(() => route.fullPath, () => { if (!session.value?.navigating) close(false) })
</script>

<template>
  <Button v-if="eligible && route.path === '/today'" size="sm" variant="ghost" class="text-primary" @click="open">
    <ClipboardPaste /><span class="md:hidden">用资料规划</span><span class="hidden md:inline">粘贴规划</span>
    <kbd class="hidden text-xs font-normal text-muted-foreground md:inline">Ctrl+V</kbd>
  </Button>
  <QuickPlanDialog v-if="session" :session="session" @append="append" @remove="remove" @close="close" />
</template>
