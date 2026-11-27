<script setup>
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink, onBeforeRouteLeave, useRouter } from 'vue-router'
import { ArrowLeft, ArrowRight, Database, Download, FileArchive, Loader2, RotateCcw, Upload, X } from 'lucide-vue-next'
import Alert from '@/components/ui/Alert.vue'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import WorkspaceSwitcher from '@/components/domain/WorkspaceSwitcher.vue'
import Input from '@/components/ui/Input.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useAppStore } from '@/stores/app'
import { useAssistantStore } from '@/stores/assistant'
import { clearWorkspace, readWorkspaceSnapshot } from '@/services/storage/db'
import { buildBackup } from '@/services/backup/export'
import { DOC_KINDS } from '@/services/backup/adapt'
import { requestWorkLeave } from '@/composables/workLeave'
import {
  restoreJob, selectBackupFile, cancelInspection, setRestoreName,
  confirmRestore, resetRestoreJob,
} from '@/services/backup/restore'

const store = useAppStore()
const assistant = useAssistantStore()
const router = useRouter()

const KIND_LABELS = {
  note: '便签', matter: '项目', task: '任务', action: '行动',
  focus_session: '专注会话', plan_item: '计划条目',
}

// 计数取当前空间已保存事实（store 实时 refs）。图片字节量用 Blob.size 同步求和，不读字节、不发网络。
const kindCounts = computed(() => {
  const c = {}
  for (const k of DOC_KINDS) c[k] = 0
  for (const d of store.docs) if (c[d.kind] != null) c[d.kind] += 1
  return c
})
const imageSources = computed(() => store.sources.filter((s) => s.kind === 'image'))
const textCount = computed(() => store.sources.filter((s) => s.kind === 'text').length)
const imageBytes = computed(() => imageSources.value.reduce((n, s) => n + (s.blob && s.blob.size ? s.blob.size : 0), 0))

function formatBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const exporting = ref(false)
const preparingClear = ref(false)
const clearing = ref(false)
const clearOpen = ref(false)
const clearTarget = shallowRef(null)
const clearBusy = computed(() => preparingClear.value || clearing.value)
const clearUnavailable = computed(() => !store.ready || exporting.value || importActive.value || store.busy ||
  assistant.generating || Object.values(assistant.busy).some(Boolean))

async function openClear() {
  if (clearBusy.value || clearUnavailable.value) return
  const ws = store.workspaceId
  preparingClear.value = true
  try {
    const data = await readWorkspaceSnapshot(ws)
    if (store.workspaceId !== ws || clearUnavailable.value) return
    const ids = records => new Set(records.map(record => record.id))
    clearTarget.value = {
      ws, name: store.currentWorkspace.name,
      records: { sources: ids(data.sources), docs: ids(data.docs), assistant_threads: ids(data.assistantThreads), assistant_drafts: ids(data.assistantDrafts) },
      unfinished: data.docs.filter(d => d.kind === 'focus_session' && !d.ended_at).length,
    }
    clearOpen.value = true
  } catch { store.say('destructive', '读取待清空的数据失败，请重试。') }
  finally { preparingClear.value = false }
}
async function confirmClear() {
  const target = clearTarget.value
  if (!target || clearBusy.value || clearUnavailable.value || target.ws !== store.workspaceId) return
  clearing.value = true
  let committed = false
  try {
    await clearWorkspace(target.ws, target.records)
    committed = true
    await store.finishWorkspaceClear(target.ws)
    store.say('success', '已清空「' + target.name + '」')
  } catch (err) {
    store.say('destructive', committed ? '数据已清空，请刷新以更新页面。' : (err.message || '清空失败，请重试。'))
  } finally { clearing.value = false; clearTarget.value = null }
}
watch(() => store.workspaceId, () => { clearOpen.value = false; clearTarget.value = null })
const exportError = ref(null)
// 最近一次成功导出：固定记录原空间归属。导出期间切换空间时，成功态仍标原空间，不更新到新空间。
const lastExport = ref(null)

const switchedAway = computed(() =>
  !!lastExport.value && lastExport.value.workspaceId !== store.workspaceId)

function triggerDownload(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

async function doExport() {
  if (exporting.value || clearBusy.value) return
  // 点击瞬间捕获空间归属：此后即使切换空间，快照与结果仍属原空间。
  const wsId = store.workspaceId
  const wsName = store.currentWorkspace.name
  exporting.value = true
  exportError.value = null
  try {
    const snapshot = await readWorkspaceSnapshot(wsId)
    const result = await buildBackup(snapshot)
    triggerDownload(result.zipBytes, result.filename)
    lastExport.value = {
      workspaceId: wsId, workspaceName: wsName,
      filename: result.filename, summary: result.summary, at: new Date(),
    }
  } catch (e) {
    // 失败不更新成功态、不声称已写盘；给出具体原因，允许重新导出。
    exportError.value = (e && e.message) || String(e)
    lastExport.value = null
  } finally {
    exporting.value = false
  }
}

// ---- 从备份恢复（开工单 §2/§7）：DataPage 仅做状态绑定与交互，作业控制器为模块级单例 ----
const fileInput = ref(null)
// 一页同时只允许一个导出/导入作业：导入非 idle 时禁导出；导出中或写入中禁选文件。
const importActive = computed(() => restoreJob.phase !== 'idle')
const fileSelectDisabled = computed(() => clearBusy.value || exporting.value || restoreJob.phase === 'committing')
const nameValid = computed(() => {
  const n = String(restoreJob.targetName || '').trim()
  return n.length >= 1 && n.length <= 80
})
// 仅提交失败（已冻结意图、operationId 存在）可同意图重试；检查/校验失败只能重新选择。
const canRetry = computed(() => restoreJob.phase === 'error' && !!restoreJob.operationId)

function pickFile() {
  if (fileSelectDisabled.value) return
  fileInput.value && fileInput.value.click()
}
function onFile(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = '' // 允许再次选择同一文件
  if (f) void selectBackupFile(f)
}
function resetJob() { resetRestoreJob() }

// 恢复成功后刷新目录（即便选择留在当前空间，选择器也能立即看到新空间）。
watch(() => restoreJob.phase, (p) => { if (p === 'done') void store.refreshWorkspaces() })

// 进入恢复空间：统一离开协调（取消则 URL/空间/输入不变）→ 刷新目录 → 按 ID 切换 → 回 /today。
// 不携带旧任务/会话详情 ID；App 的空间监听在 /data 无 query 时不再重复导航，避免与本次跳转竞争。
async function enterRestore() {
  const target = restoreJob.result && restoreJob.result.workspaceId
  if (!target) return
  if (!(await requestWorkLeave())) return
  await store.refreshWorkspaces()
  const r = await store.switchWorkspace(target)
  if (r && r.notFound) return
  await router.replace('/today')
  resetRestoreJob()
}
function stay() { resetRestoreJob() }

// 写入阶段离开本页：提示等待（作业不绑定组件，离开不会中断写入，完成后回到本页可见结果）。
onBeforeRouteLeave(() => {
  if (restoreJob.phase === 'committing') {
    return window.confirm('正在写入恢复数据。离开本页不会中断写入，完成后回到「数据管理」可查看结果，建议等待完成。确定离开？')
  }
  return true
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="flex items-center gap-2 text-lg font-semibold"><Database class="size-5" />数据管理</h1>
      <span class="text-xs text-muted-foreground">备份当前空间已保存的资料与成果</span>
      <RouterLink to="/today" class="ml-auto"><Button size="sm" variant="outline"><ArrowLeft />返回日程</Button></RouterLink>
    </div>

    <Card>
      <div class="flex flex-wrap items-center gap-2">
        <WorkspaceSwitcher v-if="store.workspaces.some(w => w.restore_receipt)" compact />
        <Badge v-if="store.isRestore" variant="success">恢复空间</Badge>
        <span class="text-xs text-muted-foreground">数据仅存本浏览器 · 本地存储</span>
      </div>
      <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <div v-for="k in DOC_KINDS" :key="k" class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
          <dt class="text-xs text-muted-foreground">{{ KIND_LABELS[k] }}</dt>
          <dd class="font-date tabular-nums">{{ kindCounts[k] }}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
          <dt class="text-xs text-muted-foreground">图片资料</dt>
          <dd class="font-date tabular-nums">{{ imageSources.length }} · {{ formatBytes(imageBytes) }}</dd>
        </div>
        <div class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
          <dt class="text-xs text-muted-foreground">文字资料</dt>
          <dd class="font-date tabular-nums">{{ textCount }}</dd>
        </div>
      </dl>
    </Card>

    <Card>
      <div class="flex flex-wrap items-center gap-3">
        <Button :disabled="exporting || clearBusy || !store.ready || importActive" @click="doExport">
          <Loader2 v-if="exporting" class="animate-spin" />
          <Download v-else />
          {{ exporting ? '正在打包…' : '导出当前空间备份' }}
        </Button>
        <span class="text-xs text-muted-foreground">包含原图和成果，请妥善保存。备份默认不加密。</span>
      </div>
      <p class="mt-3 text-xs leading-relaxed text-muted-foreground">
        备份包含当前空间已保存的资料和成果。尚未保存的输入不在其中；恢复时运行中的工作会暂停并等待确认。
        导出在本地完成，不联网、不调用模型；生成备份不会自动上传、分享或加入比赛提交包。
      </p>

      <Alert v-if="exportError" variant="destructive" class="mt-3">
        导出失败：{{ exportError }}。未生成备份文件，可处理后重新导出。
      </Alert>

      <Alert v-else-if="lastExport" variant="success" class="mt-3">
        <div class="space-y-1">
          <p>备份已生成，请在下载中确认：<span class="font-medium break-all">{{ lastExport.filename }}</span></p>
          <p class="text-xs">
            归属空间：{{ lastExport.workspaceName }} ·
            资料 {{ lastExport.summary.sourceCount }}（图片 {{ lastExport.summary.imageCount }} · {{ formatBytes(lastExport.summary.assetBytes) }}）·
            记录 {{ Object.values(lastExport.summary.counts).reduce((a, b) => a + b, 0) }} 条
            <template v-if="lastExport.summary.assistantThreadCount || lastExport.summary.assistantDraftCount">
              · 助手线程 {{ lastExport.summary.assistantThreadCount }} · 草案 {{ lastExport.summary.assistantDraftCount }}
            </template>
          </p>
          <p v-if="switchedAway" class="text-xs font-medium">
            注意：导出期间已切换到「{{ store.currentWorkspace.name }}」，此备份仍属于原空间「{{ lastExport.workspaceName }}」，未混入当前空间数据。
          </p>
        </div>
      </Alert>
    </Card>

    <Card>
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="flex items-center gap-2 text-sm font-semibold"><Upload class="size-4" />从备份恢复</h2>
        <span class="text-xs text-muted-foreground">选择本应用导出的 ZIP，恢复到一个新空间，原空间完全不变</span>
      </div>

      <input
        ref="fileInput"
        type="file"
        accept=".zip,application/zip"
        class="hidden"
        :disabled="fileSelectDisabled"
        @change="onFile"
      />

      <!-- idle：选择备份 -->
      <div v-if="restoreJob.phase === 'idle'" class="mt-3 space-y-2">
        <Button variant="outline" :disabled="fileSelectDisabled" @click="pickFile"><Upload />选择备份 ZIP</Button>
        <p class="text-xs leading-relaxed text-muted-foreground">
          仅支持本应用导出的备份；按实际字节校验，不只看扩展名或 MIME。选择、检查与预览不会写入任何数据、不创建空空间、不切换当前空间。
        </p>
      </div>

      <!-- inspecting：正在检查（可取消） -->
      <div v-else-if="restoreJob.phase === 'inspecting'" class="mt-3 space-y-2">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <Loader2 class="size-4 animate-spin" />正在检查…
          <span class="break-all text-muted-foreground">{{ restoreJob.filename }}</span>
        </div>
        <Button size="sm" variant="ghost" @click="cancelInspection"><X />取消检查</Button>
      </div>

      <!-- preview：预览与命名 -->
      <div v-else-if="restoreJob.phase === 'preview' && restoreJob.preview" class="mt-3 space-y-3">
        <div class="flex items-center gap-2 text-sm font-medium"><FileArchive class="size-4" />备份预览</div>
        <dl class="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
          <div class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
            <dt class="text-xs text-muted-foreground">文件名</dt>
            <dd class="break-all text-right">{{ restoreJob.preview.filename }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
            <dt class="text-xs text-muted-foreground">原空间</dt>
            <dd class="text-right">
              {{ restoreJob.preview.sourceWorkspaceName || '（未记录）' }}
              <Badge v-if="restoreJob.preview.sourceWorkspaceIsDemo" variant="warning" class="ml-1">演示</Badge>
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
            <dt class="text-xs text-muted-foreground">导出时间（北京）</dt>
            <dd class="font-date tabular-nums">{{ restoreJob.preview.exportedAtBeijing || '（未记录）' }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
            <dt class="text-xs text-muted-foreground">格式 / 契约</dt>
            <dd class="font-date tabular-nums">v{{ restoreJob.preview.backupFormatVersion }} · {{ restoreJob.preview.schemaVersion }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
            <dt class="text-xs text-muted-foreground">资料 / 图片</dt>
            <dd class="font-date tabular-nums">{{ restoreJob.preview.sourceCount }} · {{ restoreJob.preview.imageCount }}（{{ formatBytes(restoreJob.preview.imageBytes) }}）</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
            <dt class="text-xs text-muted-foreground">未结束工作</dt>
            <dd class="font-date tabular-nums">{{ restoreJob.preview.unfinishedCount }}</dd>
          </div>
          <div v-if="restoreJob.preview.backupFormatVersion >= 2" class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
            <dt class="text-xs text-muted-foreground">助手线程 / 草案</dt>
            <dd class="font-date tabular-nums">{{ restoreJob.preview.assistantThreadCount }} · {{ restoreJob.preview.assistantDraftCount }}</dd>
          </div>
        </dl>
        <dl v-if="restoreJob.preview.counts" class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
          <div v-for="k in DOC_KINDS" :key="k" class="flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5">
            <dt class="text-xs text-muted-foreground">{{ KIND_LABELS[k] }}</dt>
            <dd class="font-date tabular-nums">{{ restoreJob.preview.counts[k] || 0 }}</dd>
          </div>
        </dl>

        <p v-if="restoreJob.preview.assistantDraftCount" class="text-xs text-muted-foreground">
          草案原状态：
          <span v-for="(n, s) in restoreJob.preview.assistantDraftStatusCounts" :key="s" class="mr-2 font-date tabular-nums">{{ s }} ×{{ n }}</span>
        </p>

        <Alert v-if="restoreJob.preview.notes && restoreJob.preview.notes.length" variant="info">
          <div class="space-y-1">
            <p class="text-xs font-medium">兼容提示（已放行，非阻断错误）：</p>
            <ul class="list-disc space-y-0.5 pl-4 text-xs">
              <li v-for="(n, i) in restoreJob.preview.notes" :key="i">{{ n.message || n }}</li>
            </ul>
          </div>
        </Alert>

        <ul class="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          <li v-for="(t, i) in restoreJob.preview.transforms" :key="i">{{ t }}</li>
        </ul>

        <div class="space-y-1">
          <label class="text-xs font-medium" for="restore-name">恢复空间名称（1–80 字符，可重名，按恢复时间区分）</label>
          <Input id="restore-name" maxlength="80" :model-value="restoreJob.targetName" placeholder="恢复空间名称" @update:model-value="setRestoreName" />
        </div>

        <Alert v-if="restoreJob.errors.length" variant="destructive">
          <div class="space-y-1">
            <p class="text-xs font-medium">无法准备恢复，请修正后重试：</p>
            <ul class="list-disc space-y-0.5 pl-4 text-xs">
              <li v-for="(e, i) in restoreJob.errors" :key="i">{{ e.message || e }}</li>
            </ul>
            <p v-if="restoreJob.commitError" class="text-xs">{{ restoreJob.commitError.message }}</p>
          </div>
        </Alert>

        <div class="flex flex-wrap gap-2">
          <Button :disabled="!nameValid" @click="confirmRestore"><Upload />恢复到新空间</Button>
          <Button variant="outline" @click="pickFile"><RotateCcw />重新选择</Button>
        </div>
        <p class="text-xs text-muted-foreground">「恢复到新空间」是唯一写入按钮；确认前不会创建空间或写入任何记录。</p>
      </div>

      <!-- committing：正在写入（不可取消/换文件） -->
      <div v-else-if="restoreJob.phase === 'committing'" class="mt-3 space-y-2">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <Loader2 class="size-4 animate-spin" />正在写入…
          <span class="text-muted-foreground">资料、记录、工作区与协调数据一次性提交</span>
        </div>
        <p class="text-xs leading-relaxed text-muted-foreground">
          请勿关闭页面或更换文件。写入为单个原子事务：失败会整体回滚，原空间不变；即使意外关闭，已提交的空间也可在目录中找到，未提交则零残留。
        </p>
      </div>

      <!-- done：恢复完成 -->
      <div v-else-if="restoreJob.phase === 'done' && restoreJob.result" class="mt-3 space-y-2">
        <Alert variant="success">
          <div class="space-y-1">
            <p>
              恢复完成：<span class="font-medium break-all">{{ restoreJob.result.name }}</span>
              <span v-if="restoreJob.result.alreadyCommitted" class="ml-1 text-xs">（该备份此前已恢复，返回原恢复空间，未重复写入）</span>
            </p>
            <p class="text-xs">
              资料 {{ restoreJob.result.sourceCount }}（图片 {{ restoreJob.result.imageCount }}）·
              记录 {{ Object.values(restoreJob.result.counts).reduce((a, b) => a + b, 0) }} 条 ·
              未结束工作已暂停 {{ restoreJob.result.unfinishedV1 + restoreJob.result.legacyEnds }} 项
              <template v-if="restoreJob.result.assistantThreadCount || restoreJob.result.assistantDraftCount">
                · 助手线程 {{ restoreJob.result.assistantThreadCount }} · 草案 {{ restoreJob.result.assistantDraftCount }}
              </template>
            </p>
            <p class="text-xs text-muted-foreground">原空间保持不变。进入后如需继续计时，请先核对用时再显式继续。</p>
            <p v-if="restoreJob.result.assistantDraftCount" class="text-xs text-muted-foreground">
              旧保存结果不能由本次备份恢复推定，须重新核对；未应用草案已转为待核对，不自动执行旧确认或创建日程。
            </p>
          </div>
        </Alert>
        <Alert v-if="restoreJob.verifyProblems.length" variant="warning">
          <div class="space-y-1">
            <p class="text-xs font-medium">已创建空间，但核对异常（未自动回滚，请进入空间检查）：</p>
            <ul class="list-disc space-y-0.5 pl-4 text-xs">
              <li v-for="(p, i) in restoreJob.verifyProblems" :key="i">{{ p }}</li>
            </ul>
          </div>
        </Alert>
        <div class="flex flex-wrap gap-2">
          <Button @click="enterRestore"><ArrowRight />进入恢复空间</Button>
          <Button variant="outline" @click="stay">留在当前空间</Button>
        </div>
      </div>

      <!-- error：列原因，零写入 -->
      <div v-else-if="restoreJob.phase === 'error'" class="mt-3 space-y-2">
        <Alert variant="destructive">
          <div class="space-y-1">
            <p class="text-xs font-medium">{{ canRetry ? '恢复失败，未写入任何数据（原空间不变）：' : '无法恢复此备份，未写入任何数据：' }}</p>
            <p v-if="restoreJob.commitError" class="text-xs">{{ restoreJob.commitError.message }}</p>
            <ul v-if="restoreJob.errors.length" class="list-disc space-y-0.5 pl-4 text-xs">
              <li v-for="(e, i) in restoreJob.errors" :key="i">{{ e.message || e }}</li>
            </ul>
          </div>
        </Alert>
        <div class="flex flex-wrap gap-2">
          <Button v-if="canRetry" @click="confirmRestore"><RotateCcw />重试恢复</Button>
          <Button variant="outline" @click="resetJob"><RotateCcw />重新选择</Button>
        </div>
      </div>
    </Card>
    <section class="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4" aria-label="清空空间数据">
      <div><h2 class="font-medium">清空空间数据</h2><p class="mt-1 text-sm text-muted-foreground">仅影响本浏览器中的「{{ store.currentWorkspace.name }}」。需要保留副本时，请先导出备份。</p></div>
      <Button variant="destructive" :disabled="clearBusy || clearUnavailable" @click="openClear">{{ clearing ? '正在清空…' : preparingClear ? '正在统计…' : '清空当前空间' }}</Button>
    </section>
    <ConfirmDialog v-model="clearOpen" :title="'清空「' + (clearTarget?.name || '') + '」？'" confirm-label="确认清空" :confirm-disabled="clearBusy || clearUnavailable" @confirm="confirmClear">
      <template v-if="clearTarget">
        将删除 {{ clearTarget.records.sources.size }} 份资料、{{ clearTarget.records.docs.size }} 条项目与工作记录（含任务、便签和日程）、{{ clearTarget.records.assistant_threads.size }} 个助手对话和 {{ clearTarget.records.assistant_drafts.size }} 份草案。
        <span v-if="clearTarget.unfinished">其中有 {{ clearTarget.unfinished }} 项未结束的工作。</span>
        此操作无法撤销。其他空间和已下载的备份会保留。
      </template>
    </ConfirmDialog>
  </div>
</template>
