<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose, DialogTrigger } from 'reka-ui'
import { KeyRound, X } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import { connectQwen, connectionOpen, disconnectQwen, qwenConnected } from '@/services/api/qwenConnection'

const input = ref('')
const error = ref('')
const busy = ref(false)
let verifying
function clearForm() {
  verifying?.abort()
  verifying = null
  input.value = ''
  error.value = ''
  busy.value = false
}
watch(connectionOpen, open => { if (!open) clearForm() }, { flush: 'sync' })
onBeforeUnmount(clearForm)
async function submit() {
  if (busy.value) return
  const controller = new AbortController()
  verifying = controller
  busy.value = true
  error.value = ''
  try {
    const result = await connectQwen(input.value, controller.signal)
    if (!result.ok && !controller.signal.aborted) error.value = result.message || '连接失败，请重试。'
  } finally {
    if (verifying === controller) busy.value = false
  }
}
</script>

<template>
  <DialogRoot v-model:open="connectionOpen">
    <DialogTrigger as-child><Button size="sm" :variant="qwenConnected ? 'ghost' : 'outline'"><KeyRound class="size-4" />{{ qwenConnected ? '千问已连接' : '连接千问' }}</Button></DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/35" />
      <DialogContent class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-5 shadow-lg">
        <DialogTitle class="pr-8 text-lg font-semibold">{{ qwenConnected ? '千问已连接' : '连接千问' }}</DialogTitle>
        <DialogClose aria-label="关闭" class="absolute right-3 top-3 rounded-md p-2 hover:bg-accent"><X class="size-4" /></DialogClose>
        <DialogDescription class="mt-2 text-sm text-muted-foreground">提取资料和生成计划使用你的百炼额度。密钥仅在当前页面保留。</DialogDescription>
        <Button v-if="qwenConnected" variant="outline" class="mt-5" @click="disconnectQwen">断开连接</Button>
        <form v-else class="mt-4 space-y-3" @submit.prevent="submit">
          <label class="block text-sm font-medium">百炼 API Key · 北京地域
            <input v-model="input" type="password" required maxlength="203" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="sk-…" class="mt-1 block w-full rounded-md border bg-background px-3 py-2" />
          </label>
          <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
          <div class="flex items-center justify-between gap-3">
            <a href="https://help.aliyun.com/zh/model-studio/get-api-key" target="_blank" rel="noopener noreferrer" class="text-sm underline">获取 API Key</a>
            <Button type="submit" :disabled="busy || !input.trim()">{{ busy ? '验证中…' : '验证并连接' }}</Button>
          </div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
