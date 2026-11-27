<script setup>
import { cn } from '@/lib/utils'
const props = defineProps({ class: { type: String, default: '' } })
</script>

<template>
  <div :class="cn('shrink-0 bg-border h-px w-full', props.class)" />
</template>