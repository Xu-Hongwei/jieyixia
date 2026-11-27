<script setup>
import { cn } from '@/lib/utils'
const model = defineModel({ type: String, default: '' })
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <input
    v-model="model"
    :class="
      cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  />
</template>
