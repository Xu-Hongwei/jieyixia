<script setup>
import { computed } from 'vue'
import {
  SelectContent, SelectItem, SelectItemText, SelectPortal, SelectRoot,
  SelectTrigger, SelectValue, SelectViewport,
} from 'reka-ui'

const model = defineModel({ type: String, default: '' })
const props = defineProps({
  items: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
})
// reka-ui 禁止 SelectItem value 为空串；对外仍用 '' 表示「未分组/清空」，内部映射为哨兵值。
const NONE = '__jxl_none__'
const inner = computed({
  get: () => (model.value === '' ? NONE : model.value),
  set: (v) => { model.value = v === NONE ? '' : v },
})
const options = computed(() =>
  /** @type {{ value: string, label: string }[]} */ (props.items).map((it) => ({ ...it, value: it.value === '' ? NONE : it.value })),
)
</script>

<template>
  <SelectRoot v-model="inner">
    <SelectTrigger
      class="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <SelectValue :placeholder="placeholder" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent position="popper" class="z-50 min-w-32 rounded-md border bg-popover text-popover-foreground shadow-md">
        <SelectViewport class="p-1">
          <SelectItem
            v-for="it in options"
            :key="it.value"
            :value="it.value"
            class="cursor-default rounded-sm px-2 py-1 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
          >
            <SelectItemText>{{ it.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>