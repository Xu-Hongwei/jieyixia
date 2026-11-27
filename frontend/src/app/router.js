import { createRouter, createWebHashHistory } from 'vue-router'
import { ref } from 'vue'
import { resetWorkLeaveApproval } from '@/composables/workLeave'
import { schedulePath } from '@/domains/workNavigation'
import { beijingToday } from '@/domains/time'
import TodayPage from '@/pages/TodayPage.vue'
import CollectPage from '@/pages/CollectPage.vue'
import NotesPage from '@/pages/NotesPage.vue'
import TaskDetailPage from '@/pages/TaskDetailPage.vue'
import TasksPage from '@/pages/TasksPage.vue'
import WorkPage from '@/pages/WorkPage.vue'
import WorkRecordsPage from '@/pages/WorkRecordsPage.vue'
import WorkRecordDetailPage from '@/pages/WorkRecordDetailPage.vue'

// 日常本地页面随入口加载；助手与备份按需加载，空闲时预热当前会话。
const loadAssistant = () => import('@/pages/AssistantPage.vue')
const loadData = () => import('@/pages/DataPage.vue')
export const routeLoadError = ref(null)
export const routePending = ref('')
let navigationId = 0
let targetPath = ''
const loadPage = async (title, loader) => {
  const id = navigationId
  const timer = setTimeout(() => { if (id === navigationId) routePending.value = title }, 200)
  try { return await loader() } finally {
    clearTimeout(timer)
    if (id === navigationId) routePending.value = ''
  }
}
export function warmOptionalPages() {
  // 网络失败只保留按需重试；不缓存业务数据，也不注册长期缓存或服务工作线程。
  return Promise.allSettled([loadAssistant(), loadData()])
}

// 滚动位置按工作区 + 路由保存：返回/后退恢复列表位置，不把临时状态塞进 URL。
const scrollKey = (route) => {
  let ws = 'personal'
  try { ws = localStorage.getItem('jxl-workspace') || 'personal' } catch { /* 隐私模式退化为会话内 */ }
  // The drawer and transient parameters sit over the same calendar. Use the
  // calendar's date/view in a stable order for links back from task details.
  const path = route.name === 'schedule'
    ? schedulePath({ date: route.query.date, view: route.query.view }, beijingToday())
    : route.fullPath
  return `jxl-scroll:${ws}:${path}`
}

// 托管未验证 history 回退前用 hash 模式，保证深链接刷新可恢复。
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/today' },
    { path: '/today', name: 'schedule', component: TodayPage, meta: { title: '日程', section: 'schedule' } },
    { path: '/tasks', name: 'tasks', component: TasksPage, meta: { title: '任务', section: 'tasks' } },
    { path: '/collect', name: 'library', component: CollectPage, meta: { title: '资料库', section: 'library' } },
    { path: '/notes', name: 'review', component: NotesPage, meta: { title: '资料核对', section: 'library' } },
    { path: '/notes/:id', name: 'review-note', component: NotesPage, meta: { title: '资料核对', section: 'library' } },
    { path: '/assistant', name: 'assistant', component: () => loadPage('助手', loadAssistant), meta: { title: '助手', section: 'assistant' } },
    { path: '/tasks/:id', name: 'task-detail', component: TaskDetailPage, meta: { title: '任务详情', section: 'tasks' } },
    { path: '/work/:sessionId', name: 'work', component: WorkPage, meta: { title: '执行工作', section: 'schedule' } },
    { path: '/work-records', name: 'work-records', component: WorkRecordsPage, meta: { title: '工作记录', section: 'schedule' } },
    { path: '/work-records/:sessionId', name: 'work-record-detail', component: WorkRecordDetailPage, meta: { title: '工作记录详情', section: 'schedule' } },
    { path: '/data', name: 'data', component: () => loadPage('数据管理', loadData), meta: { title: '数据管理', section: 'data' } },
  ],
  scrollBehavior(to, from, savedPosition) {
    if (to.name === 'schedule' && from.name === 'schedule' && !savedPosition) return false
    if (to.path === '/collect' && from.path === '/collect') {
      const withoutPanel = q => Object.entries(q).filter(([key]) => key !== 'source').sort(([a], [b]) => a.localeCompare(b))
      if (JSON.stringify(withoutPanel(to.query)) === JSON.stringify(withoutPanel(from.query))) return false
    }
    // 双 rAF 等列表渲染完成后再恢复，避免恢复到尚未撑开的高度被钳到 0。
    const restore = (top) => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ top })))
    })
    if (savedPosition) return restore(savedPosition.top || 0)
    try {
      const saved = sessionStorage.getItem(scrollKey(to))
      if (saved != null) return restore(Number(saved) || 0)
    } catch { /* 忽略不可用存储 */ }
    return { top: 0 }
  },
})

router.beforeEach((to, from) => {
  navigationId += 1
  targetPath = to.fullPath
  routePending.value = ''
  if (from.matched.length) {
    try { sessionStorage.setItem(scrollKey(from), String(window.scrollY)) } catch { /* 忽略 */ }
  }
})

router.afterEach((to, _from, failure) => {
  if (failure) resetWorkLeaveApproval()
  if (to.fullPath !== targetPath) return
  routePending.value = ''
  if (!failure) routeLoadError.value = null
})
router.onError((_error, to) => {
  // 跳转失败不会卸载旧页面；清除已经消费过的离开许可，保护后续新编辑。
  resetWorkLeaveApproval()
  if (to.fullPath !== targetPath) return
  routePending.value = ''
  routeLoadError.value = { path: to.fullPath, title: to.meta.title || '页面' }
})
