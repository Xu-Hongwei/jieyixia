<script setup>
import { cn } from '@/lib/utils'
import { X } from 'lucide-vue-next'

const props = defineProps({
  variant: { type: String, default: 'info' },
  class: { type: String, default: '' },
  dismissLabel: { type: String, default: '' },
})
defineEmits(['dismiss'])

const variants = {
  info: 'border-border bg-muted text-foreground',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  destructive: 'border-red-300 bg-red-50 text-red-900',
}
</script>

<template>
  <div
    :role="props.variant === 'destructive' ? 'alert' : 'status'"
    :class="cn('break-words rounded-md border px-3 py-2.5 text-sm leading-relaxed', variants[props.variant], props.dismissLabel && 'flex items-start gap-2', props.class)"
  >
    <template v-if="dismissLabel">
      <div class="min-w-0 flex-1 self-center"><slot /></div>
      <button type="button" :aria-label="dismissLabel" :title="dismissLabel" class="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-black/5 focus-visible:outline" @click="$emit('dismiss')"><X aria-hidden="true" class="size-4" /></button>
    </template>
    <slot v-else />
  </div>
</template>
