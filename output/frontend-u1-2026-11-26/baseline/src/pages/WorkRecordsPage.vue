<script setup>
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ArrowLeft, ClipboardList, Search } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import DateInput from '@/components/ui/DateInput.vue'
import Input from '@/components/ui/Input.vue'
import { useAppStore } from '@/stores/app'
import { useFocusStore } from '@/stores/focus'
import { endedSessionsSorted, filterWorkRecords, formatDurationMs, sessionActionText, sessionTitle } from '@/domains/work'
import { beijingInstantLabel } from '@/domains/time'

const app = useAppStore()
const focus = useFocusStore()
const ready = computed(() => app.ready && focus.ready)

// 默认全部日期；范围/搜索只筛已结束历史，任务删除后记录仍可按快照标题检索。
const from = ref('')
const to = ref('')
const query = ref('')

const records = computed(() => {
  const ended = endedSessionsSorted(focus.sessions)
  return filterWorkRecords(ended, { from: from.value, to: to.value, query: query.value })
})
const totalEnded = computed(() => focus.sessions.filter((s) => s.ended_at != null).length)
const filtering = computed(() => !!(from.value || to.value || query.value.trim()))

const OUTCOME_LABELS = { done: '完成', partial: '部分完成', blocked: '受阻' }
const OUTCOME_VARIANTS = { done: 'success', partial: 'secondary', blocked: 'warning' }
const outcomeLabel = (s) => OUTCOME_LABELS[s.outcome] || '未记录结果'
const outcomeVariant = (s) => OUTCOME_VARIANTS[s.outcome] || 'secondary'
function resetFilter() {
  from.value = ''
  to.value = ''
  query.value = ''
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="flex items-center gap-2 text-lg font-semibold"><ClipboardList class="size-5" />工作记录</h1>
      <span class="text-xs text-muted-foreground">当前空间已结束的工作 · {{ totalEnded }} 条</span>
      <RouterLink to="/today" class="ml-auto"><Button size="sm" variant="outline"><ArrowLeft />返回日程</Button></RouterLink>
    </div>

    <Card>
      <div class="flex flex-wrap items-end gap-2">
        <div>
          <label class="mb-1 block text-xs text-muted-foreground" for="wr-from">结束日期从</label>
          <DateInput id="wr-from" v-model="from" class="w-40" placeholder="不限" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-muted-foreground" for="wr-to">到</label>
          <DateInput id="wr-to" v-model="to" class="w-40" placeholder="不限" />
        </div>
        <div class="min-w-44 flex-1">
          <label class="mb-1 block text-xs text-muted-foreground" for="wr-q">搜索任务 / 行动标题</label>
          <div class="relative">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input id="wr-q" v-model="query" class="pl-8" placeholder="按开始时的快照标题搜索…" />
          </div>
        </div>
        <Button v-if="filtering" size="sm" variant="outline" @click="resetFilter">清除筛选</Button>
      </div>
      <p class="mt-2 text-xs text-muted-foreground">日期按结束时刻的北京时间判定（含边界）；搜索匹配开始快照，不用现名称伪造历史。</p>
    </Card>

    <div v-if="!ready" class="text-sm text-muted-foreground">正在读取本地工作数据…</div>
    <template v-else>
      <Card v-if="!records.length">
        <p class="text-sm text-muted-foreground">
          <template v-if="filtering">没有符合筛选的工作记录。<button type="button" class="underline" @click="resetFilter">清除筛选</button>查看全部。</template>
          <template v-else>还没有已结束的工作记录。到日程选择任务的当前行动，点「开始执行」即可开始第一段工作。</template>
        </p>
      </Card>
      <ul v-else class="space-y-2">
        <li v-for="s in records" :key="s.id">
          <RouterLink
            :to="`/work-records/${s.id}`"
            class="block rounded-lg border bg-card p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="min-w-0 flex-1 basis-52 break-words text-sm font-medium">
                {{ sessionTitle(s) || '旧记录（无开始快照）' }}
              </span>
              <Badge :variant="outcomeVariant(s)">{{ outcomeLabel(s) }}</Badge>
              <span class="font-date text-sm tabular-nums">{{ formatDurationMs(s.accumulated_ms) }}</span>
            </div>
            <div class="mt-1 break-words text-xs text-muted-foreground">
              {{ sessionActionText(s) || '（无行动快照）' }}
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{{ beijingInstantLabel(s.started_at) }} → {{ beijingInstantLabel(s.ended_at) }}（北京时间）</span>
              <Badge v-if="s.task_ref_state === 'deleted'" variant="secondary">原任务已删除</Badge>
              <Badge v-if="s.action_ref_state === 'deleted'" variant="secondary">原行动已删除</Badge>
              <Badge v-if="s.record_version !== 1" variant="secondary">旧版记录</Badge>
            </div>
            <p v-if="s.outcome === 'blocked' && s.blocker" class="mt-1 break-words text-xs text-warning-foreground">卡点：{{ s.blocker }}</p>
          </RouterLink>
        </li>
      </ul>
    </template>
  </div>
</template>