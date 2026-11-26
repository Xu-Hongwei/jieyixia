<script setup>
import { cn } from '@/lib/utils'
const model = defineModel({ type: String, default: '' })
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <textarea
    v-model="model"
    :class="
      cn(
        'flex min-h-16 w-full rounded-md border border-input bg-card px-3 py-2 text-sm leading-relaxed transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  />
</template>
