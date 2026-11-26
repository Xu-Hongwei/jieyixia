<script setup>
import { cn } from '@/lib/utils'

const props = defineProps({
  variant: { type: String, default: 'info' },
  class: { type: String, default: '' },
})

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
    :class="cn('break-words rounded-md border px-3 py-2.5 text-sm leading-relaxed', variants[props.variant], props.class)"
  >
    <slot />
  </div>
</template>
