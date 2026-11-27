<script setup>
import { computed, onMounted, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { Bot, CalendarDays, Database, Library, NotebookPen } from 'lucide-vue-next'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import WorkspaceSwitcher from '@/components/domain/WorkspaceSwitcher.vue'
import WorkProtectionDialog from '@/components/domain/WorkProtectionDialog.vue'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const route = useRoute()
const router = useRouter()
onMounted(() => store.init())

// 待核对角标按便签数（待核对 + 分析失败）；字段数只是单张便签内的进度，不混用。
const reviewNoteCount = computed(() => store.noteBuckets.pending.length + store.noteBuckets.failed.length)
const reviewBadgeTitle = computed(() =>
  `${store.noteBuckets.pending.length} 张便签待核对 · ${store.noteBuckets.failed.length} 张分析失败`)

// 切换空间：退出上一空间的对象详情深链接（任务/执行/记录详情），回到当前页的合法列表入口。
// 已在合法列表入口且无 query 时不重复导航，避免与「进入恢复空间」的显式 /today 跳转竞争。
watch(() => store.workspaceId, () => {
  let base = route.path
  if (route.path.startsWith('/notes')) base = '/notes'
  else if (route.path.startsWith('/tasks/') || route.path.startsWith('/work/')) base = '/today'
  else if (route.path.startsWith('/work-records/')) base = '/work-records'
  if (base === route.path && Object.keys(route.query).length === 0) return
  router.replace({ path: base, query: {} })
})
</script>

<template>
  <div class="flex min-h-screen">
    <aside class="hidden w-52 shrink-0 flex-col border-r bg-card md:flex">
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
      <nav class="flex-1 space-y-1 px-2">
        <RouterLink to="/today" class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" active-class="bg-accent font-medium">
          <CalendarDays class="size-4" />日程
        </RouterLink>
        <RouterLink to="/collect" class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" active-class="bg-accent font-medium">
          <Library class="size-4" />资料库
          <span v-if="store.sources.length" class="ml-auto text-xs text-muted-foreground">{{ store.sources.length }}</span>
        </RouterLink>
        <RouterLink to="/notes" class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" active-class="bg-accent font-medium">
          <NotebookPen class="size-4" />待核对
          <span v-if="reviewNoteCount" class="ml-auto rounded-full bg-warning px-1.5 text-xs text-warning-foreground" :title="reviewBadgeTitle">{{ reviewNoteCount }}</span>
        </RouterLink>
        <RouterLink to="/assistant" class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" active-class="bg-accent font-medium">
          <Bot class="size-4" />助手
        </RouterLink>
      </nav>
      <div class="border-t px-2 py-2">
        <RouterLink to="/data" class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground" active-class="bg-accent font-medium text-foreground">
          <Database class="size-4" />数据管理
        </RouterLink>
      </div>
      <div class="px-4 py-3 text-xs text-muted-foreground">数据仅存本浏览器<br />刷新 / 重开可恢复</div>
    </aside>

    <div class="min-w-0 flex-1">
      <header class="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <nav class="flex gap-1 md:hidden">
          <RouterLink to="/today" class="rounded-md px-2 py-1 text-sm" active-class="bg-accent font-medium">日程</RouterLink>
          <RouterLink to="/collect" class="rounded-md px-2 py-1 text-sm" active-class="bg-accent font-medium">资料</RouterLink>
          <RouterLink to="/notes" class="rounded-md px-2 py-1 text-sm" active-class="bg-accent font-medium">待核对</RouterLink>
          <RouterLink to="/assistant" class="rounded-md px-2 py-1 text-sm" active-class="bg-accent font-medium">助手</RouterLink>
        </nav>
        <WorkspaceSwitcher compact class="md:hidden" />
        <RouterLink to="/data" class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent md:hidden" active-class="bg-accent font-medium text-foreground" title="数据管理">
          <Database class="size-3.5" />数据
        </RouterLink>
        <span class="hidden text-sm font-medium md:inline">{{ route.meta.title }}</span>
        <span class="flex-1" />
        <Badge v-if="store.isDemo" variant="warning" title="当前为演示空间，数据与个人空间隔离">演示空间</Badge>
        <Badge v-if="!store.health" variant="destructive" title="后端不可达时本地收集、核对与任务仍可离线使用">后端不可达 · 离线可用</Badge>
        <Badge v-else-if="store.aiDown" variant="warning" :title="`契约 ${store.health.schema_version} · AI 入口已隐藏，本地功能不受影响`">AI 暂不可用</Badge>
        <Badge v-else variant="success" :title="`契约 ${store.health.schema_version}`">模型就绪</Badge>
      </header>

      <div v-if="store.banner" class="px-4 pt-3">
        <Alert :variant="store.banner.tone">{{ store.banner.msg }}</Alert>
      </div>

      <main class="p-4">
        <RouterView />
      </main>
    </div>

    <WorkProtectionDialog />
  </div>
</template>