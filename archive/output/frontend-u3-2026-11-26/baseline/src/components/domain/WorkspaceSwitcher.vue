<script setup>
import { computed } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import { useAppStore } from '@/stores/app'
import { requestWorkLeave } from '@/composables/workLeave'
import { beijingParts } from '@/domains/time'
import { cn } from '@/lib/utils'

const store = useAppStore()
defineProps({ compact: { type: Boolean, default: false } })

const p2 = (n) => String(n).padStart(2, '0')
function shortTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const b = beijingParts(d)
  return `${b.year}-${p2(b.month)}-${p2(b.day)} ${p2(b.hour)}:${p2(b.minute)}`
}

// 目录排序：个人/演示固定在前，恢复空间按恢复时间倒序；当前空间若尚未入目录也兜底列出。
const ordered = computed(() => {
  const list = [...store.workspaces]
  if (!list.some((w) => w.id === store.workspaceId)) list.push(store.currentWorkspace)
  const rank = (w) => (w.id === 'personal' ? 0 : w.id === 'demo' ? 1 : 2)
  return list.sort((a, b) => {
    const ra = rank(a); const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 2) {
      const ta = (a.restore_receipt && a.restore_receipt.committed_at) || ''
      const tb = (b.restore_receipt && b.restore_receipt.committed_at) || ''
      return tb < ta ? -1 : tb > ta ? 1 : 0
    }
    return 0
  })
})

// 重名消歧：同名恢复空间附恢复时间（北京），按 ID 切换，名称不是唯一键。
function labelOf(w) {
  if (w.id === 'personal') return '个人空间'
  if (w.id === 'demo') return '演示空间'
  const base = w.name || '恢复空间'
  const sameName = store.workspaces.filter((x) => x.restore_receipt && (x.name || '恢复空间') === base)
  if (sameName.length > 1 && w.restore_receipt && w.restore_receipt.committed_at) {
    return `${base}（${shortTime(w.restore_receipt.committed_at)}）`
  }
  return base
}

// 切空间与执行页路由守卫共用同一离开协调：先保存/暂停成功才切换；取消则 URL/空间/运行状态不变。
async function onChange(e) {
  const id = e.target.value
  if (id === store.workspaceId) return
  if (!(await requestWorkLeave())) { e.target.value = store.workspaceId; return }
  const r = await store.switchWorkspace(id)
  if (r && r.notFound) e.target.value = store.workspaceId
}
</script>

<template>
  <div :class="cn('relative', compact ? 'inline-flex max-w-[9rem]' : 'w-full')">
    <select
      :value="store.workspaceId"
      aria-label="切换工作区"
      :title="store.currentWorkspace.name"
      :class="
        cn(
          'w-full appearance-none truncate rounded-lg border bg-muted/40 py-1.5 pl-2.5 pr-7 text-xs font-medium text-foreground transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        )
      "
      @change="onChange"
    >
      <option v-for="w in ordered" :key="w.id" :value="w.id">{{ labelOf(w) }}</option>
    </select>
    <ChevronDown class="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
  </div>
</template>