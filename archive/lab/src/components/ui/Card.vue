<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <div :class="cn('rounded-xl border bg-card text-card-foreground shadow-sm', props.class)">
    <div v-if="$slots.header" class="flex flex-col gap-1.5 p-6 pb-3">
      <slot name="header" />
    </div>
    <div class="p-6 pt-0" :class="{ 'pt-6': !$slots.header }">
      <slot />
    </div>
  </div>
</template>
