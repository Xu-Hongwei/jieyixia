<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { DialogRoot, DialogPortal, DialogContent, DialogOverlay, DialogTitle, DialogDescription } from 'reka-ui'
import { ImagePlus, X } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import PlanningAvailability from './PlanningAvailability.vue'
import { useAppStore } from '@/stores/app'
import { useAssistantStore } from '@/stores/assistant'
import { connectionOpen, qwenConnected, requireQwen } from '@/services/api/qwenConnection'
import { MAX_AUTO_ANALYZE, MAX_EXCERPT_CHARS, MAX_USER_MESSAGE_CHARS } from '@/services/assistant/requests'
import { beijingAddDays, beijingToday } from '@/domains/time'

const props = defineProps({ session: { type: Object, required: true } })
const emit = defineEmits(['append', 'remove', 'close'])
const app = useAppStore()
const assistant = useAssistantStore()
const router = useRouter()
const workspace = app.workspaceId
const requirement = ref('')
const typed = ref('')
const textEntry = ref(null)
const addingText = ref(false)
const waitingForKey = ref(false)
const fileInput = ref(null)
const schedule = reactive({ startDate: null, budgets: {}, unavailable: [] })
let alive = true
onBeforeUnmount(() => { alive = false })
const current = () => alive && workspace === app.workspaceId
const workflowLocked = () => assistant.generating || assistant.gen?.phase === 'save_failed' || ['applying', 'result_unknown'].includes(assistant.activeDraft?.status)
onMounted(() => { if (workflowLocked()) emit('close') })
const hasMaterial = computed(() => props.session.items.length || typed.value.trim())
const issue = computed(() => {
  if (props.session.items.filter(item => item.file).length > MAX_AUTO_ANALYZE) return `每次最多分析 ${MAX_AUTO_ANALYZE} 张新图片。可以移除部分图片，或仅保存资料。`
  if (requirement.value.trim().length > MAX_USER_MESSAGE_CHARS) return `安排要求请控制在 ${MAX_USER_MESSAGE_CHARS} 字以内。`
  if (typed.value.trim().length > MAX_EXCERPT_CHARS || props.session.items.some(item =>
    item.text?.length > MAX_EXCERPT_CHARS && (!item.excerpt?.trim() || item.excerpt.trim().length > MAX_EXCERPT_CHARS || !item.text.includes(item.excerpt.trim())))) {
    return `长原文请选取最多 ${MAX_EXCERPT_CHARS} 字用于生成，或仅保存全文。`
  }
  for (let i = 0; i < 7; i++) {
    const day = beijingAddDays(schedule.startDate || beijingToday(new Date(app.nowTick)), i)
    const v = Number(schedule.budgets[day] ?? 0)
    if (!schedule.unavailable.includes(day) && (!Number.isInteger(v) || v < 0 || v > 1440)) return '每天的可用时间应为 0 至 1440 的整数分钟。'
  }
  return ''
})
function close() { if (!props.session.busy) emit('close') }
function addTyped() {
  if (!typed.value.trim()) return true
  const count = props.session.items.length
  emit('append', [], typed.value)
  if (props.session.items.length === count) return false
  typed.value = ''
  addingText.value = false
  return true
}
async function openTextEntry() {
  addingText.value = true
  await nextTick()
  textEntry.value?.focus()
}
function filesChosen(event) {
  emit('append', Array.from(event.target.files || []))
  event.target.value = ''
}
async function submit(generate) {
  const s = props.session
  if (s.busy || !current() || !hasMaterial.value || !addTyped()) return
  if (generate && (issue.value || workflowLocked())) return
  if (generate && !requireQwen()) { waitingForKey.value = true; return }
  s.busy = true
  s.message = ''
  try {
    for (const item of s.items) {
      if (!current()) return
      if (item.savedId) continue
      const r = item.file ? (await app.saveImageFiles([item.file]))[0] : await app.saveText(item.text)
      if (!current()) return
      if (!r?.ok) { s.message = r?.message || '资料保存失败，请重试。'; return }
      item.savedId = r.record.id
    }
    if (!generate) {
      app.say('success', `已将 ${s.items.length} 份资料存到资料库`)
      emit('close')
      return
    }
    const input = {
      userText: requirement.value.trim(), sourceIds: s.items.map(item => item.savedId),
      taskIds: [], actionIds: [], startDate: schedule.startDate || beijingToday(),
      budgets: { ...schedule.budgets }, unavailable: [...schedule.unavailable],
      excerpts: Object.fromEntries(s.items.filter(item => item.excerpt?.trim()).map(item => [item.savedId, item.excerpt.trim()])),
    }
    s.navigating = true
    const failure = await router.push('/assistant')
    if (!current()) return
    if (failure || router.currentRoute.value.path !== '/assistant') {
      s.message = '资料已保存。准备好离开当前页后，可以继续生成。'
      return
    }
    assistant.close()
    Object.assign(assistant.input, input)
    emit('close', false)
    await assistant.generate()
  } catch {
    if (current()) s.message = '未能完成操作，请重试。'
    else if (workspace === app.workspaceId) assistant.say('warning', '生成未完成，可在助手中重试。')
  } finally {
    s.navigating = false
    s.busy = false
  }
}
watch(connectionOpen, async open => {
  if (open || !waitingForKey.value) return
  waitingForKey.value = false
  if (qwenConnected.value && current()) await submit(true)
})
function initialFocus(event) {
  event.preventDefault()
  nextTick(() => {
    const content = document.querySelector('[data-quick-plan]')
    if (content instanceof HTMLElement) content.focus()
  })
}
</script>

<template>
  <DialogRoot :open="!connectionOpen" @update:open="value => { if (!value && !connectionOpen) close() }">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[45] bg-black/25" />
      <DialogContent data-quick-plan tabindex="-1" class="quick-plan panel-scroll fixed z-[46] overflow-y-auto overscroll-contain border bg-card p-5 shadow-xl outline-none"
        @open-auto-focus="initialFocus" @close-auto-focus.prevent>
        <div class="flex items-center justify-between gap-3">
          <DialogTitle class="text-xl font-semibold">用资料规划</DialogTitle>
          <Button variant="ghost" size="icon" aria-label="关闭快捷规划" :disabled="session.busy" @click="close"><X /></Button>
        </div>
        <DialogDescription class="mb-4 text-xs text-muted-foreground">点击生成后，所选资料才会发送给千问。</DialogDescription>
        <fieldset :disabled="session.busy" class="min-w-0 space-y-4">
          <ul v-if="session.items.length" class="max-h-56 divide-y overflow-auto rounded-md border px-3">
            <li v-for="item in session.items" :key="item.id" class="flex items-start gap-3 py-2">
              <template v-if="item.file"><img :src="item.url" alt="截图预览" class="h-14 w-20 rounded border object-contain" /><span class="min-w-0 flex-1 break-words text-sm">{{ item.file.name || '截图' }}</span></template>
              <div v-else class="min-w-0 flex-1 text-sm">
                <details v-if="item.text.length > 70 || item.text.includes('\n')"><summary class="cursor-pointer break-words">{{ item.text.split('\n')[0].slice(0,70) }}…</summary><p class="mt-1 whitespace-pre-wrap break-words">{{ item.text }}</p></details>
                <p v-else class="break-words">{{ item.text }}</p>
                <label v-if="item.text.length > MAX_EXCERPT_CHARS" class="mt-2 block text-xs">用于生成的原文片段<textarea v-model="item.excerpt" rows="2" class="block w-full rounded border p-2" /></label>
              </div>
              <button type="button" class="shrink-0 text-xs text-muted-foreground underline" :aria-label="'移除' + (item.file ? '图片' : '文字')" @click="emit('remove', item.id)">移除</button>
            </li>
          </ul>
          <textarea v-if="!session.items.length || addingText || typed" ref="textEntry" v-model="typed" rows="2" aria-label="通知原文" placeholder="在这里粘贴通知原文…" class="w-full rounded-md border bg-background p-3 text-sm" />
          <div class="flex items-center gap-3">
            <Button variant="outline" size="sm" @click="fileInput?.click()"><ImagePlus />选择图片</Button>
            <input ref="fileInput" class="hidden" type="file" multiple accept="image/*" aria-label="选择规划图片" @change="filesChosen" />
            <button v-if="typed.trim()" type="button" class="text-sm text-primary underline" @click="addTyped">添加原文</button>
            <button v-else-if="session.items.length && !addingText" type="button" class="text-sm text-primary underline" @click="openTextEntry">补充原文</button>
          </div>
          <label class="block text-sm font-medium">安排要求 <span class="font-normal text-muted-foreground">（可选）</span>
            <textarea v-model="requirement" rows="2" placeholder="比如：周三没空，周五前做完。" class="mt-1 block w-full rounded-md border bg-background p-3 font-normal" />
          </label>
          <PlanningAvailability :input="schedule" :default-budget="assistant.formDefaults.budget" :disabled="session.busy" />
          <p v-if="session.message || issue" role="status" class="text-sm text-warning-foreground">{{ session.message || issue }}</p>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" :disabled="session.busy || !hasMaterial" @click="submit(false)">仅存到资料库</Button>
            <Button :disabled="session.busy || !hasMaterial || !!issue" @click="submit(true)">{{ session.busy ? '正在处理…' : '生成安排' }}</Button>
          </div>
        </fieldset>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.quick-plan { inset: auto 0 0; width: 100%; max-height: 89dvh; border-radius: 1rem 1rem 0 0; padding-bottom: max(1.25rem, env(safe-area-inset-bottom)); }
@media (min-width: 640px) {
  .quick-plan { inset: 50% auto auto 50%; transform: translate(-50%, -50%); width: min(32rem, 92vw); max-height: 84dvh; border-radius: .85rem; }
}
</style>
