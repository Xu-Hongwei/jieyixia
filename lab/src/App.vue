<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import { AlertTriangle, Check, Clock, Pencil, RefreshCw, Sparkles, Upload } from 'lucide-vue-next'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import Input from '@/components/ui/Input.vue'
import Separator from '@/components/ui/Separator.vue'
import Textarea from '@/components/ui/Textarea.vue'
import { allDocs, allSources, getSource, putDoc, putSource } from '@/lib/db'
import { analyze, blobToBase64, healthz } from '@/lib/api'

const tab = ref('collect')
const sources = ref([])
const docs = ref([])
const health = ref(null)
const aiDown = ref(false)
const busy = ref(false)
const banner = ref(null)
const textDraft = ref('')
const pendingId = ref(null)
const selectedId = ref(null)
const imageUrl = ref(null)
const pendingUrl = ref(null)
const editing = ref(null)
const fileInput = ref(null)

const notes = computed(() => docs.value.filter((d) => d.kind === 'note'))
const tasks = computed(() =>
  docs.value
    .filter((d) => d.kind === 'task')
    .slice()
    .sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a))),
)
const selectedNote = computed(() => notes.value.find((n) => n.id === selectedId.value) || null)
const pendingSource = computed(() => sources.value.find((s) => s.id === pendingId.value) || null)

const say = (tone, msg) => (banner.value = { tone, msg })
const now = () => new Date().toISOString()

async function reload() {
  sources.value = await allSources()
  docs.value = await allDocs()
  if (!selectedId.value && notes.value.length) await selectNote(notes.value[notes.value.length - 1].id)
}

async function selectNote(id) {
  selectedId.value = id
  const note = notes.value.find((n) => n.id === id)
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
  imageUrl.value = null
  if (!note) return
  const source = await getSource(note.source_id)
  if (source && source.kind === 'image' && source.blob) imageUrl.value = URL.createObjectURL(source.blob)
}

async function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      say('warning', `不支持的类型：${file.type || file.name}`)
      continue
    }
    const source = { id: crypto.randomUUID(), kind: 'image', captured_at: now(), blob: file, name: file.name }
    await putSource(source)
    sources.value.push(source)
    pendingId.value = source.id
    if (pendingUrl.value) URL.revokeObjectURL(pendingUrl.value)
    pendingUrl.value = URL.createObjectURL(file)
    say('success', `原图已保存到本地（${file.name}），可「仅保存」留存或「AI 整理」`)
  }
}

async function saveTextOnly() {
  const text = textDraft.value.trim()
  if (!text) return say('warning', '先粘贴或输入文字')
  const source = { id: crypto.randomUUID(), kind: 'text', captured_at: now(), text }
  await putSource(source)
  sources.value.push(source)
  pendingId.value = source.id
  textDraft.value = ''
  say('success', '文字已保存到本地（未调用 AI）')
}

async function runAI(fail = null) {
  const source = pendingSource.value || (selectedNote.value && sources.value.find((s) => s.id === selectedNote.value.source_id))
  if (!source) return say('warning', '先收集一份截图或文字')
  busy.value = true
  try {
    const payload = { source_id: source.id, kind: source.kind, captured_at: source.captured_at }
    if (source.kind === 'image') payload.image_base64 = await blobToBase64(source.blob)
    else payload.text = source.text
    const { status, body } = await analyze(payload, fail)
    if (status === 200) {
      const titleField = body.fields.find((f) => f.key === 'title')
      const note = {
        id: crypto.randomUUID(),
        kind: 'note',
        source_id: source.id,
        status: 'draft',
        content_type: body.content_type,
        title: (titleField && titleField.value) || '未命名便签',
        fields: body.fields,
        warnings: body.warnings || [],
        created_at: now(),
        updated_at: now(),
      }
      await putDoc(note)
      docs.value.push(note)
      pendingId.value = null
      await selectNote(note.id)
      tab.value = 'notes'
      say('success', `AI 草稿已生成：${body.fields.length} 个字段，待你核对确认`)
    } else if (status === 422) {
      const note = {
        id: crypto.randomUUID(), kind: 'note', source_id: source.id, status: 'failed',
        content_type: 'reference', title: '分析失败（原图保留）', fields: [], warnings: [],
        created_at: now(), updated_at: now(), error: body && body.code,
      }
      await putDoc(note)
      docs.value.push(note)
      await selectNote(note.id)
      tab.value = 'notes'
      say('destructive', `422 ${body && body.code}：原图仍在本地，可重试或手动整理`)
    } else if (status === 503) {
      aiDown.value = true
      say('warning', '503 模型不可用：AI 入口已隐藏，「仅保存」与本地浏览不受影响')
    } else if (status === 413) {
      say('warning', '413 图片超出体积上限：请压缩后重试，原图已在本地')
    } else {
      say('destructive', `意外状态 ${status}`)
    }
  } catch (err) {
    say('destructive', `网络错误：${err.message}（本地数据不受影响）`)
  } finally {
    busy.value = false
  }
}

async function mutateNote(note, fn) {
  fn(note)
  note.updated_at = now()
  await putDoc(note)
}

const confirmField = (note, key) =>
  mutateNote(note, (n) => {
    const f = n.fields.find((x) => x.key === key)
    if (f) f.status = 'confirmed'
  })

function startEdit(note, key) {
  const f = note.fields.find((x) => x.key === key)
  editing.value = { noteId: note.id, key, value: Array.isArray(f.value) ? f.value.join('\n') : f.value == null ? '' : String(f.value) }
}

async function saveEdit(note) {
  const { key, value } = editing.value
  await mutateNote(note, (n) => {
    const f = n.fields.find((x) => x.key === key)
    f.value = Array.isArray(f.value) ? value.split('\n').filter(Boolean) : value
    f.origin = 'user'
  })
  editing.value = null
}

const reviewNote = (note) => mutateNote(note, (n) => { n.status = 'reviewed'; n.reviewed_at = now() })

async function createTask(note) {
  const dl = note.fields.find((f) => f.key === 'deadline' && f.status === 'confirmed')
  if (!dl || !dl.value) return say('warning', '先独立确认 deadline 字段，才能把它带进任务（出处可追溯）')
  const task = {
    id: crypto.randomUUID(), kind: 'task', title: note.title, note_ids: [note.id],
    deadline: { value: dl.value, precision: dl.precision || (String(dl.value).includes('T') ? 'datetime' : 'date'), from_note_id: note.id, confirmed_at: now() },
    status: 'todo', created_at: now(), updated_at: now(),
  }
  await putDoc(task)
  docs.value.push(task)
  tab.value = 'tasks'
  say('success', `任务已创建，截止时间来自便签 ${note.id.slice(0, 8)}…`)
}

const isOverdue = (task) => Boolean(task.deadline && task.deadline.value && task.status !== 'done' && new Date(task.deadline.value) < new Date())
const finishTask = async (task) => { task.status = 'done'; task.updated_at = now(); await putDoc(task) }

function onPaste(e) {
  if (e.target.closest('textarea, input')) return
  const files = e.clipboardData && e.clipboardData.files
  if (files && files.length) { e.preventDefault(); addFiles(files) }
  else {
    const text = e.clipboardData && e.clipboardData.getData('text')
    if (text) { textDraft.value = text; say('info', '剪贴板文字已填入输入框') }
  }
}
const onDrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }

onMounted(async () => {
  window.addEventListener('paste', onPaste)
  await reload()
  try {
    health.value = await healthz()
    aiDown.value = !health.value.model_ready
  } catch {
    health.value = null
    aiDown.value = true
  }
})
onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})

const statusVariant = { candidate: 'warning', confirmed: 'success', unresolved: 'outline', missing: 'muted', draft: 'warning', reviewed: 'success', failed: 'destructive', pending: 'muted', todo: 'secondary', done: 'success' }
const bannerClass = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-900',
  destructive: 'border-red-300 bg-red-50 text-red-900',
  info: 'border-border bg-muted text-foreground',
}
</script>

<template>
  <div class="mx-auto max-w-5xl p-6 space-y-4">
    <header class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">截下来 · 接口联调台</h1>
        <p class="text-sm text-muted-foreground">验证后端接口与状态机 · 数据仅存本浏览器 IndexedDB</p>
      </div>
      <div class="flex gap-2">
        <Badge v-if="health" variant="success">model_ready {{ health.model_ready }} · schema {{ health.schema_version }}</Badge>
        <Badge v-else variant="destructive">后端不可达</Badge>
        <Badge v-if="aiDown" variant="warning">AI 暂不可用</Badge>
      </div>
    </header>

    <div v-if="banner" :class="['rounded-md border px-3 py-2 text-sm', bannerClass[banner.tone]]">{{ banner.msg }}</div>

    <TabsRoot v-model="tab">
      <TabsList class="inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground">
        <TabsTrigger value="collect" class="rounded-md px-3 py-1 text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">收集</TabsTrigger>
        <TabsTrigger value="notes" class="rounded-md px-3 py-1 text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">便签核对</TabsTrigger>
        <TabsTrigger value="tasks" class="rounded-md px-3 py-1 text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">任务与今天</TabsTrigger>
        <TabsTrigger value="api" class="rounded-md px-3 py-1 text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">接口与降级</TabsTrigger>
      </TabsList>

      <TabsContent value="collect" class="mt-4">
        <Card @drop="onDrop" @dragover.prevent>
          <template #header>
            <div class="text-base font-semibold">收集原始资料</div>
            <p class="text-sm text-muted-foreground">Ctrl+V 粘贴截图 / 拖入 / 选择文件 / 粘贴文字。原图先落本地，再决定是否 AI 整理。</p>
          </template>
          <div class="space-y-3">
            <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" @change="addFiles($event.target.files); $event.target.value = ''" />
            <div class="flex gap-2">
              <Button variant="outline" @click="fileInput.click()"><Upload />选择图片</Button>
              <Button variant="outline" @click="saveTextOnly">仅保存文字</Button>
              <Button :disabled="aiDown || busy" @click="runAI()"><Sparkles />{{ busy ? '分析中…' : 'AI 整理' }}</Button>
            </div>
            <Textarea v-model="textDraft" placeholder="或粘贴 / 输入纯文字…" class="min-h-24" />
            <div v-if="pendingSource" class="rounded-md border p-3 space-y-2">
              <div class="text-sm text-muted-foreground">待处理：{{ pendingSource.kind === 'image' ? pendingSource.name : '文字资料' }} · {{ pendingSource.captured_at }}</div>
              <img v-if="pendingSource.kind === 'image'" :src="pendingUrl" alt="" class="max-h-64 rounded-md border" />
            </div>
          </div>
        </Card>
      </TabsContent>

      <TabsContent value="notes" class="mt-4 grid gap-4 md:grid-cols-[240px_1fr]">
        <Card>
          <template #header><div class="text-base font-semibold">便签列表</div></template>
          <div class="space-y-1">
            <button v-for="n in notes" :key="n.id" class="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" :class="{ 'bg-accent': n.id === selectedId }" @click="selectNote(n.id)">
              <div class="truncate font-medium">{{ n.title }}</div>
              <Badge :variant="statusVariant[n.status]">{{ n.status }}</Badge>
            </button>
            <p v-if="!notes.length" class="text-sm text-muted-foreground">还没有便签，去收集区保存一份。</p>
          </div>
        </Card>

        <Card v-if="selectedNote">
          <template #header>
            <div class="flex items-center justify-between">
              <div class="text-base font-semibold">{{ selectedNote.title }}</div>
              <div class="flex gap-2">
                <Badge :variant="statusVariant[selectedNote.status]">{{ selectedNote.status }}</Badge>
                <Badge variant="secondary">{{ selectedNote.content_type }}</Badge>
              </div>
            </div>
          </template>
          <div class="space-y-3">
            <div v-for="f in selectedNote.fields" :key="f.key" class="rounded-md border p-3 space-y-1.5">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium">{{ f.key }}</span>
                <Badge :variant="statusVariant[f.status]">{{ f.status }}</Badge>
                <Badge v-if="f.derived" variant="outline">derived 推算</Badge>
                <Badge v-if="f.precision" variant="secondary">{{ f.precision }}</Badge>
                <Badge v-if="f.precision === 'datetime' && f.tz_known === false" variant="warning">时区未知</Badge>
                <Badge v-if="f.origin === 'user'" variant="secondary">user 修改</Badge>
                <span class="flex-1" />
                <Button v-if="f.status !== 'confirmed' && f.status !== 'missing'" size="sm" variant="outline" @click="confirmField(selectedNote, f.key)"><Check />确认</Button>
                <Button size="sm" variant="ghost" @click="startEdit(selectedNote, f.key)"><Pencil />编辑</Button>
              </div>
              <Input v-if="editing && editing.noteId === selectedNote.id && editing.key === f.key" v-model="editing.value" @keyup.enter="saveEdit(selectedNote)" />
              <div v-else-if="f.key === 'time_nodes' && Array.isArray(f.value)" class="space-y-1">
                <div v-for="(n, i) in f.value" :key="i" class="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="secondary">{{ n.label || '节点' + (i + 1) }}</Badge>
                  <span>{{ n.value || '（待确认）' }}</span>
                  <Badge v-if="n.basis === 'superseded'" variant="muted">已取代</Badge>
                  <Badge v-else-if="n.basis !== 'explicit'" variant="outline">{{ n.basis }}</Badge>
                  <span class="text-xs text-muted-foreground">{{ n.raw }}</span>
                </div>
              </div>
              <div v-else class="text-sm">{{ f.value == null ? '（空）' : Array.isArray(f.value) ? f.value.join('；') : f.value }}</div>
              <div v-if="f.quote" class="text-xs text-muted-foreground">原文引用：{{ f.quote.text }}</div>
              <div v-if="editing && editing.noteId === selectedNote.id && editing.key === f.key" class="flex gap-2">
                <Button size="sm" @click="saveEdit(selectedNote)">保存修改</Button>
                <Button size="sm" variant="ghost" @click="editing = null">取消</Button>
              </div>
            </div>
            <p v-if="!selectedNote.fields.length" class="text-sm text-muted-foreground">分析失败或尚未分析，原图仍保留。</p>
            <div v-if="selectedNote.warnings && selectedNote.warnings.length" class="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-1">
              <div v-for="w in selectedNote.warnings" :key="w.code + (w.field_key || '')" class="text-xs text-amber-900">
                <span class="font-medium">{{ w.code }}</span> · {{ w.message }}
              </div>
            </div>
            <Separator />
            <div class="flex flex-wrap gap-2">
              <Button v-if="selectedNote.status === 'draft'" variant="outline" @click="reviewNote(selectedNote)">标记已审阅</Button>
              <Button variant="outline" @click="pendingId = selectedNote.source_id; runAI()"><RefreshCw />{{ selectedNote.status === 'failed' ? '重试分析' : '重新分析' }}</Button>
              <Button @click="createTask(selectedNote)">从便签建任务</Button>
            </div>
            <div v-if="imageUrl" class="space-y-1">
              <div class="text-sm text-muted-foreground">原始截图（不可被编辑覆盖）</div>
              <img :src="imageUrl" alt="原始截图" class="max-h-96 rounded-md border" />
            </div>
          </div>
        </Card>
      </TabsContent>

      <TabsContent value="tasks" class="mt-4">
        <Card>
          <template #header>
            <div class="text-base font-semibold">今天</div>
            <p class="text-sm text-muted-foreground">逾期优先。截止时间带出处便签，可追溯。</p>
          </template>
          <div class="space-y-2">
            <div v-for="t in tasks" :key="t.id" class="flex items-center gap-3 rounded-md border p-3">
              <Clock v-if="isOverdue(t)" class="size-4 text-red-600" />
              <div class="flex-1">
                <div class="text-sm font-medium">{{ t.title }}</div>
                <div class="text-xs text-muted-foreground">
                  截止 {{ t.deadline ? t.deadline.value : '无' }} · 来自便签 {{ t.deadline && t.deadline.from_note_id ? t.deadline.from_note_id.slice(0, 8) + '…' : '—' }}
                </div>
              </div>
              <Badge v-if="isOverdue(t)" variant="destructive">已逾期</Badge>
              <Badge :variant="statusVariant[t.status]">{{ t.status }}</Badge>
              <Button v-if="t.status !== 'done'" size="sm" variant="outline" @click="finishTask(t)">完成</Button>
            </div>
            <p v-if="!tasks.length" class="text-sm text-muted-foreground">还没有任务。去便签核对区确认 deadline 后建任务。</p>
          </div>
        </Card>
      </TabsContent>

      <TabsContent value="api" class="mt-4">
        <Card>
          <template #header>
            <div class="text-base font-semibold">接口健康与降级注入</div>
            <p class="text-sm text-muted-foreground">注入仅桩/路由层生效，用于验证 UI 降级路径；真模型时同样返回对应错误码。</p>
          </template>
          <div class="space-y-3">
            <pre class="rounded-md bg-muted p-3 text-xs overflow-auto">{{ health ? JSON.stringify(health, null, 2) : '后端不可达' }}</pre>
            <div class="flex gap-2">
              <Button variant="outline" :disabled="busy" @click="runAI('413')">注入 413</Button>
              <Button variant="outline" :disabled="busy" @click="runAI('422')">注入 422</Button>
              <Button variant="outline" :disabled="busy" @click="runAI('503')">注入 503</Button>
            </div>
            <div class="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertTriangle class="size-4 mt-0.5" />
              <span>422 → 便签 failed 且原图保留可重试；503 → 隐藏 AI 入口保留仅保存；413 → 提示压缩。刷新页面后所有本地数据应恢复。</span>
            </div>
          </div>
        </Card>
      </TabsContent>
    </TabsRoot>
  </div>
</template>
