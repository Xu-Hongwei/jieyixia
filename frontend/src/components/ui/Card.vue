<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({
  class: { type: String, default: '' },
  flush: { type: Boolean, default: false },
})
</script>

<template>
  <div :class="cn('rounded-xl border bg-card text-card-foreground', props.class)">
    <div v-if="$slots.header" :class="cn('flex flex-col gap-1.5', flush ? 'px-5 py-3.5' : 'p-5 pb-3')">
      <slot name="header" />
    </div>
    <div :class="cn(flush ? '' : 'p-5 pt-0', { 'pt-5': !$slots.header && !flush })">
      <slot />
    </div>
  </div>
</template>
