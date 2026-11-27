<script setup>
import { cn } from '@/lib/utils'

const props = defineProps({
  variant: { type: String, default: 'default' },
  class: { type: String, default: '' },
})

const variants = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'text-foreground',
  success: 'border-transparent bg-success text-success-foreground',
  warning: 'border-transparent bg-warning text-warning-foreground',
  destructive: 'border-transparent bg-red-100 text-red-800',
  muted: 'border-transparent bg-muted text-muted-foreground',
}
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        variants[props.variant],
        props.class,
      )
    "
  >
    <slot />
  </span>
</template>