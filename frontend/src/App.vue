<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { Bot, CalendarDays, Database, Library, ListChecks } from 'lucide-vue-next'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import { routeLoadError, routePending, warmOptionalPages } from '@/app/router'
import { requestWorkLeave } from '@/composables/workLeave'
import WorkspaceSwitcher from '@/components/domain/WorkspaceSwitcher.vue'
import QwenConnection from '@/components/domain/QwenConnection.vue'
import { disconnectQwen, qwenConnected } from '@/services/api/qwenConnection'
import WorkProtectionDialog from '@/components/domain/WorkProtectionDialog.vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const route = useRoute()
const router = useRouter()
const navigation = [
  { to: '/today', section: 'schedule', label: '日程', icon: CalendarDays },
  { to: '/tasks', section: 'tasks', label: '任务', icon: ListChecks },
  { to: '/collect', section: 'library', label: '资料', icon: Library },
  { to: '/assistant', section: 'assistant', label: '助手', icon: Bot },
]
onMounted(() => store.init())
watch(qwenConnected, connected => { if (connected && store.aiDown) void store.refreshHealth() })
let warmTimer
const online = ref(navigator.onLine)
const updateOnline = () => { online.value = navigator.onLine }
onMounted(() => {
  window.addEventListener('online', updateOnline)
  window.addEventListener('offline', updateOnline)
  warmTimer = setTimeout(() => { if (navigator.onLine) void warmOptionalPages() }, 1800)
})
onBeforeUnmount(() => {
  clearTimeout(warmTimer)
  window.removeEventListener('online', updateOnline)
  window.removeEventListener('offline', updateOnline)
})
async function retryPage() {
  const target = routeLoadError.value?.path
  if (!target || !navigator.onLine || !(await requestWorkLeave())) return
  // 浏览器可能记住失败的模块导入；重新打开目标页清掉失败记录。
  // 先走当前表单的离开保护，不静默丢弃失败后继续编辑的内容。
  window.location.replace(router.resolve(target).href)
  window.location.reload()
}

// 待核对角标按便签数（待核对 + 分析失败）；字段数只是单张便签内的进度，不混用。
const reviewNoteCount = computed(() => store.noteBuckets.pending.length + store.noteBuckets.failed.length)
const reviewBadgeTitle = computed(() =>
  `${store.noteBuckets.pending.length} 张便签待核对 · ${store.noteBuckets.failed.length} 张分析失败`)

// 切换空间：退出上一空间的对象详情深链接（任务/执行/记录详情），回到当前页的合法列表入口。
// 已在合法列表入口且无 query 时不重复导航，避免与「进入恢复空间」的显式 /today 跳转竞争。
watch(() => store.workspaceId, () => {
  disconnectQwen()
  let base = route.path
  if (route.path.startsWith('/notes')) base = '/notes'
  else if (route.path.startsWith('/tasks/')) base = '/tasks'
  else if (route.path.startsWith('/work/')) base = '/today'
  else if (route.path.startsWith('/work-records/')) base = '/work-records'
  if (base === route.path && Object.keys(route.query).length === 0) return
  router.replace({ path: base, query: {} })
})
</script>

<template>
  <div class="flex min-h-screen">
    <aside class="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col overflow-y-auto border-r bg-card md:flex">
      <div class="flex items-center gap-2 px-4 py-4">
        <span class="flex size-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">截</span>
        <strong class="text-sm">截下来</strong>
      </div>
      <div class="space-y-2 px-4 pb-3">
        <WorkspaceSwitcher />
        <div class="text-xs text-muted-foreground">
          {{ store.currentWorkspace.name }} · 本地存储
          <span v-if="store.isDemo" class="ml-1 rounded bg-warning px-1 text-warning-foreground">演示数据</span>
        </div>
      </div>
      <nav class="flex-1 space-y-1 px-2" aria-label="主导航">
        <template v-for="item in navigation" :key="item.to">
          <RouterLink :to="item.to" custom v-slot="{ href, navigate }">
            <a :href="href" @click="navigate" class="flex items-center gap-2 rounded-md px-3 py-2.5 text-sm hover:bg-accent" :class="route.meta.section === item.section ? 'bg-accent font-medium' : ''" :aria-current="route.meta.section === item.section ? 'page' : undefined"><component :is="item.icon" class="size-4" />{{ item.label }}<span v-if="item.section === 'library' && reviewNoteCount" class="ml-auto rounded-full bg-warning px-1.5 text-xs" :title="reviewBadgeTitle">{{ reviewNoteCount }}</span></a>
          </RouterLink>
        </template>
      </nav>
      <div class="border-t px-2 py-2">
        <RouterLink to="/data" class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground" active-class="bg-accent font-medium text-foreground">
          <Database class="size-4" />数据管理
        </RouterLink>
      </div>
      <div class="px-4 py-3 text-xs text-muted-foreground">数据保存在本浏览器</div>
    </aside>

    <div class="min-w-0 flex-1">
      <header class="flex min-h-14 flex-wrap items-center gap-2 border-b bg-card/70 px-4 py-3 sm:px-6 lg:px-8">
        <span class="text-sm font-medium">{{ route.meta.title }}</span>
        <WorkspaceSwitcher compact class="md:hidden" />
        <RouterLink to="/data" class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent md:hidden" active-class="bg-accent font-medium text-foreground" title="数据管理">
          <Database class="size-3.5" />数据
        </RouterLink>
        <span class="flex-1" />
        <Badge v-if="store.isDemo" variant="warning" title="当前为演示空间，数据与个人空间隔离">演示空间</Badge>
        <Badge v-if="!store.health" variant="destructive" title="后端不可达时本地收集、核对与任务仍可离线使用">后端不可达 · 离线可用</Badge>
        <QwenConnection v-if="!store.isDemo" />
      </header>

      <div v-if="store.banner" class="px-4 pt-3">
        <Alert :variant="store.banner.tone">{{ store.banner.msg }}</Alert>
      </div>

      <div v-if="routePending || routeLoadError" class="px-4 pt-3 sm:px-6 lg:px-8">
        <Alert v-if="routeLoadError" variant="warning" class="flex flex-wrap items-center gap-3">
          <span class="min-w-0 flex-1">{{ routeLoadError.title }}暂时无法打开。联网后重试将重新打开页面，已保存数据保留。</span>
          <Button size="sm" variant="outline" :disabled="!online" @click="retryPage">重试打开</Button>
        </Alert>
        <p v-else role="status" class="text-sm text-muted-foreground">正在打开{{ routePending }}…</p>
      </div>

      <main class="p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 lg:px-8 md:pb-8">
        <RouterView />
      </main>
    </div>

    <nav class="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="移动主导航">
      <RouterLink v-for="item in navigation" :key="item.to" :to="item.to" custom v-slot="{ href, navigate }"><a :href="href" @click="navigate" class="relative flex min-h-14 flex-col items-center justify-center gap-1 text-xs" :class="route.meta.section === item.section ? 'bg-accent text-primary font-medium' : 'text-muted-foreground'" :aria-current="route.meta.section === item.section ? 'page' : undefined"><component :is="item.icon" class="size-5" />{{ item.label }}<span v-if="item.section === 'library' && reviewNoteCount" class="absolute right-4 top-1 rounded-full bg-warning px-1 text-[10px]" :title="reviewBadgeTitle">{{ reviewNoteCount }}</span></a></RouterLink>
    </nav>
    <WorkProtectionDialog />
  </div>
</template>
