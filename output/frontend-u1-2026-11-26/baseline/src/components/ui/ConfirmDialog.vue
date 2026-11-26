<script setup>
import {
  AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogOverlay, AlertDialogPortal, AlertDialogRoot, AlertDialogTitle,
} from 'reka-ui'

// 破坏性操作统一确认框：必须显式确认才执行；取消/关闭不触发任何变更。
const open = defineModel({ type: Boolean, default: false })
const props = defineProps({
  title: { type: String, default: '确认操作' },
  confirmLabel: { type: String, default: '删除' },
  cancelLabel: { type: String, default: '取消' },
  tone: { type: String, default: 'danger' }, // danger | primary：非破坏性确认（风险/重复/重核对）用主色
  confirmDisabled: { type: Boolean, default: false },
})
const emit = defineEmits(['confirm'])
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 z-50 bg-black/50" />
      <AlertDialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-4 shadow-lg"
      >
        <AlertDialogTitle class="text-base font-semibold">{{ props.title }}</AlertDialogTitle>
        <AlertDialogDescription class="mt-2 text-sm text-muted-foreground">
          <slot>此操作不可自动撤销，请确认。</slot>
        </AlertDialogDescription>
        <div class="mt-4 flex justify-end gap-2">
          <AlertDialogCancel class="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">{{ props.cancelLabel }}</AlertDialogCancel>
          <AlertDialogAction
            class="rounded-md px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
            :class="props.tone === 'primary' ? 'bg-primary hover:bg-primary/90' : 'bg-red-600 hover:bg-red-700'"
            :disabled="props.confirmDisabled"
            @click="emit('confirm')"
          >
            {{ props.confirmLabel }}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>