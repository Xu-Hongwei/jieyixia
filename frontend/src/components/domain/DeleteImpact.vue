<script setup>
import { computed } from 'vue'
import { PLAN_STATE_LABELS, label } from '@/domains/labels'

// 删除确认的安排影响展示（5A-1 §10）：只渲染打开时冻结的快照 rows，
// 处置判定来自 planDeleteScope（单一来源），本组件不做任何判定/写入。
const props = defineProps({
  rows: {
    type: Array,
    default: () => [],
  },
  emptyText: { type: String, default: '没有受影响的安排。' },
})
/** @typedef {{id:string,date:string,text:string,state:string,disposition:string,unfinishedSessionId:string|null}} ImpactRow */
const rows = computed(() => /** @type {ImpactRow[]} */ (props.rows))
const emit = defineEmits(['goto-plan', 'goto-work'])

const removed = computed(() => rows.value.filter((r) => r.disposition === 'remove'))
const kept = computed(() => rows.value.filter((r) => r.disposition === 'detach' || r.disposition === 'keep'))
const blocked = computed(() => rows.value.filter((r) => r.disposition === 'blocked_unfinished' || r.disposition === 'blocked_progress'))
const DISPOSITION_LABELS = {
  remove: '随任务移除',
  detach: '保留历史（断开任务引用）',
  keep: '已是断开引用的历史，不再改动',
  blocked_progress: '已执行但未确认进度',
  blocked_unfinished: '有未结束的工作会话',
}
</script>

<template>
  <div v-if="rows.length" class="mt-2 space-y-2 text-sm">
    <p>安排影响：<strong>{{ removed.length }}</strong> 项将随任务移除，<strong>{{ kept.length }}</strong> 项历史保留（工作成果不受影响）。</p>
    <details class="rounded border p-2">
      <summary class="cursor-pointer text-xs">展开安排明细 · {{ rows.length }} 项</summary>
      <ul class="mt-1 space-y-1 text-xs">
        <li v-for="r in rows" :key="r.id" class="flex flex-wrap items-center gap-x-1.5">
          <span class="font-date">{{ r.date }}</span>
          <span class="min-w-0 break-words">{{ r.text }}</span>
          <span>· {{ label(PLAN_STATE_LABELS, r.state) }}</span>
          <span :class="r.disposition.startsWith('blocked') ? 'text-destructive' : 'text-muted-foreground'">· {{ DISPOSITION_LABELS[r.disposition] }}</span>
        </li>
      </ul>
    </details>
    <div v-if="blocked.length" class="rounded bg-warning px-2 py-1.5 text-xs text-warning-foreground">
      <p>暂不能删除：请先处理下列安排，再回来重新核对影响并确认。</p>
      <div v-for="r in blocked" :key="r.id" class="mt-1 flex flex-wrap items-center gap-2">
        <span class="font-date">{{ r.date }}</span>
        <span class="min-w-0 break-words">{{ r.text }}</span>
        <button v-if="r.disposition === 'blocked_progress'" type="button" class="underline" :aria-label="'核对进度：' + r.text" @click="emit('goto-plan', r)">核对进度</button>
        <button v-else-if="r.unfinishedSessionId" type="button" class="underline" :aria-label="'查看未结束工作：' + r.text" @click="emit('goto-work', r)">查看未结束工作</button>
      </div>
    </div>
  </div>
  <p v-else class="mt-1 text-xs text-muted-foreground">{{ props.emptyText }}</p>
</template>