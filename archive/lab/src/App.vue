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
import { allDocs, allSources, deepRaw, deleteNoteAtomic, getSource, putDoc, putSource } from '@/lib/db'
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
// 模型已成功但本地保存失败时暂存分析结果：重试只重新落库，不重调模型
const pendingSave = ref(null)

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
const clone = (v) => structuredClone(deepRaw(v))

// 日历合法性：正则只查形状，2月30/25点这类必须真构造日期验证
function isValidTimeValue(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2})(:(\d{2}))?([+-]\d{2}:\d{2}|Z)?)?$/.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return false
  if (m[4] && (+m[5] > 23 || +m[6] > 59 || (m[8] && +m[8] > 59))) return false
  if (m[9] && m[9] !== 'Z' && (+m[9].slice(1, 3) > 23 || +m[9].slice(4, 6) > 59)) return false
  return true
}
const isValidDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && isValidTimeValue(v)

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
    try {
      await putSource(source)
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：原图未写入本地，请重试`)
      continue
    }
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
  try {
    await putSource(source)
  } catch (err) {
    return say('destructive', `保存失败（${err.message}）：文字未写入本地`)
  }
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
    const refDate = referenceAt.value.trim()
    if (refDate) {
      if (!isValidDate(refDate)) {
        busy.value = false
        return say('warning', '参照日期须为合法的 YYYY-MM-DD')
      }
      payload.reference_at = refDate
    }
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
      try {
        await putDoc(note)
      } catch (err) {
        pendingSave.value = note
        return say('destructive', `保存失败（${err.message}）：分析结果已暂存，可重试保存（不重调模型）`)
      }
      pendingSave.value = null
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
      try {
        await putDoc(note)
      } catch (err) {
        pendingSave.value = note
        return say('destructive', `保存失败（${err.message}）：失败记录已暂存，可重试保存（不重调模型）`)
      }
      pendingSave.value = null
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

async function retrySave() {
  const note = pendingSave.value
  if (!note) return
  try {
    await putDoc(note)
  } catch (err) {
    return say('destructive', `保存失败（${err.message}）：分析结果仍在暂存，可再次重试（不重调模型）`)
  }
  pendingSave.value = null
  docs.value.push(note)
  pendingId.value = null
  await selectNote(note.id)
  tab.value = 'notes'
  say('success', '分析结果已保存（重试仅落库，未重调模型）')
}

// 按文档 id 串行化变更：每次从 docs.value 的最新已提交状态克隆再改，
// 避免连续确认两个字段时后一份旧快照覆盖前一次确认（丢修改）。
const mutationChains = new Map()
function mutateNote(note, fn) {
  const id = note.id
  const prev = mutationChains.get(id) || Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    const current = docs.value.find((d) => d.id === id) || note
    const draft = clone(current)
    fn(draft)
    draft.updated_at = now()
    try {
      await putDoc(draft)
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：修改未持久化，界面保持原样`)
      return false
    }
    const idx = docs.value.findIndex((d) => d.id === id)
    if (idx >= 0) docs.value[idx] = draft
    return true
  })
  mutationChains.set(id, run)
  run.finally(() => {
    if (mutationChains.get(id) === run) mutationChains.delete(id)
  })
  return run
}

const confirmField = (note, key) =>
  mutateNote(note, (n) => {
    const f = n.fields.find((x) => x.key === key)
    if (f) f.status = 'confirmed' // D4：确认不改值来源 origin；推算值保留 derived 与原文，origin 仍为 model
  })

function startEdit(note, key) {
  const f = note.fields.find((x) => x.key === key)
  editing.value = { noteId: note.id, key, value: Array.isArray(f.value) ? f.value.join('\n') : f.value == null ? '' : String(f.value) }
}

async function saveEdit(note) {
  const { key, value } = editing.value
  const ok = await mutateNote(note, (n) => {
    const f = n.fields.find((x) => x.key === key)
    f.value = Array.isArray(f.value) ? value.split('\n').filter(Boolean) : value
    f.origin = 'user'
  })
  if (ok) editing.value = null // 保存失败时编辑框保持打开，内容不丢
}

const reviewNote = (note) => mutateNote(note, (n) => { n.status = 'reviewed'; n.reviewed_at = now() })

async function createTask(note) {
  const dl = note.fields.find((f) => f.key === 'deadline' && f.status === 'confirmed')
  if (!dl || !dl.value) return say('warning', '先独立确认 deadline 字段，才能把它带进任务（出处可追溯）')
  const task = {
    id: crypto.randomUUID(), kind: 'task', title: note.title, note_ids: [note.id],
    deadline: { value: dl.value, precision: dl.precision || (String(dl.value).includes('T') ? 'datetime' : 'date'), source: 'note', from_note_id: note.id, confirmed_at: now() },
    status: 'todo', created_at: now(), updated_at: now(),
  }
  try {
    await putDoc(task)
  } catch (err) {
    return say('destructive', `保存失败（${err.message}）：任务未持久化`)
  }
  docs.value.push(task)
  tab.value = 'tasks'
  say('success', `任务已创建，截止时间来自便签 ${note.id.slice(0, 8)}…`)
}

const isOverdue = (task) => {
  const dl = task.deadline
  if (!dl || !dl.value || task.status === 'done') return false
  const nowD = new Date()
  if (dl.precision === 'date') {
    const today = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate())
    return new Date(dl.value + 'T00:00:00') < today // 日期型当天不判逾期，本地次日起算
  }
  return new Date(dl.value) < nowD // naive 按本地时区；带时区按时间点
}
const finishTask = async (task) => {
  const draft = clone(task)
  draft.status = 'done'
  draft.updated_at = now()
  try {
    await putDoc(draft)
  } catch (err) {
    return say('destructive', `保存失败（${err.message}）：状态未持久化，界面保持原样`)
  }
  const idx = docs.value.findIndex((d) => d.id === task.id)
  if (idx >= 0) docs.value[idx] = draft
}

async function deleteNote(note) {
  const affected = tasks.value.filter((t) => t.deadline && t.deadline.from_note_id === note.id)
  if (affected.length) {
    return say('destructive', `不能删除：${affected.length} 个任务的截止引用此便签（${affected.map((t) => t.title).join('、')}）。请先更换/清空截止来源或改为用户输入`)
  }
  // 先构造解除关联后的任务草稿，再与删便签放进同一事务：整体成功才提交，失败不留悬空引用
  const linked = tasks.value.filter((t) => (t.note_ids || []).includes(note.id))
  const drafts = linked.map((t) => {
    const draft = clone(t)
    draft.note_ids = draft.note_ids.filter((id) => id !== note.id)
    draft.updated_at = now()
    return draft
  })
  try {
    await deleteNoteAtomic(note.id, drafts)
  } catch (err) {
    return say('destructive', `删除失败（${err.message}）：便签与任务关联均未改动`)
  }
  for (const draft of drafts) {
    const idx = docs.value.findIndex((d) => d.id === draft.id)
    if (idx >= 0) docs.value[idx] = draft
  }
  docs.value = docs.value.filter((d) => d.id !== note.id)
  selectedId.value = null
  say('success', '便签已删除；任务关联已解除，原始资料保留')
}

const manualDeadline = ref('')
async function createTaskManual(note) {
  const v = manualDeadline.value.trim()
  if (!isValidTimeValue(v)) {
    return say('warning', '手动截止须为合法的 YYYY-MM-DD 或 ISO datetime（日历与时钟都要合法）')
  }
  const task = {
    id: crypto.randomUUID(), kind: 'task', title: note.title, note_ids: [note.id],
    deadline: { value: v, precision: v.includes('T') ? 'datetime' : 'date', source: 'manual', confirmed_at: now() },
    status: 'todo', created_at: now(), updated_at: now(),
  }
  try {
    await putDoc(task)
  } catch (err) {
    return say('destructive', `保存失败（${err.message}）：任务未持久化`)
  }
  docs.value.push(task)
  manualDeadline.value = ''
  tab.value = 'tasks'
  say('success', '任务已创建（截止为用户手动输入，已记录确认时间）')
}

const referenceAt = ref('')
const editingNode = ref(null)

function startNodeEdit(note, index) {
  const f = note.fields.find((x) => x.key === 'time_nodes')
  const n = f.value[index]
  editingNode.value = {
    noteId: note.id, index,
    label: n.label || '', value: n.value || '', role: n.role || 'unknown', basis: n.basis || 'explicit',
    reference_at: n.reference_at || '', reference_source: n.reference_source || '', message_date: n.message_date || '',
  }
}

async function saveNodeEdit(note) {
  const e = editingNode.value
  const v = e.value.trim()
  if (v && !isValidTimeValue(v)) return say('warning', '节点值须为合法的 YYYY-MM-DD 或 ISO datetime；留空表示待确认')
  for (const k of ['reference_at', 'message_date']) {
    if (e[k] && !isValidDate(e[k])) return say('warning', `${k} 须为合法的 YYYY-MM-DD`)
  }
  if (e.reference_source && !['message_date', 'user'].includes(e.reference_source)) {
    return say('warning', 'reference_source 只能是 message_date 或 user（保存日不是可靠参照）')
  }
  const ok = await mutateNote(note, (n) => {
    const f = n.fields.find((x) => x.key === 'time_nodes')
    const old = f.value[e.index]
    f.value[e.index] = {
      ...old,
      label: e.label.trim(),
      value: v || null,
      basis: e.basis,
      role: e.role,
      reference_at: e.reference_at || null,
      reference_source: e.reference_source || null,
      message_date: e.message_date || null,
      precision: v ? (v.includes('T') ? 'datetime' : 'date') : null,
      tz_known: v && v.includes('T') ? /([+-]\d{2}:\d{2}|Z)$/.test(v) : null,
      derived: e.basis === 'relative' || e.basis === 'inferred',
    }
  })
  if (ok) editingNode.value = null
}

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
              <Button v-if="pendingSave" variant="outline" :disabled="busy" @click="retrySave"><RefreshCw />重试保存分析结果（不重调模型）</Button>
            </div>
            <p v-if="pendingSave" class="text-xs text-muted-foreground">上次 AI 分析成功但本地保存失败，结果已暂存；重试只重新落库，不会再次请求模型。</p>
            <Textarea v-model="textDraft" placeholder="或粘贴 / 输入纯文字…" class="min-h-24" />
            <div class="flex items-center gap-2">
              <Input v-model="referenceAt" placeholder="参照日期（可选 YYYY-MM-DD）" class="max-w-xs" />
              <span class="text-xs text-muted-foreground">相对时间（明天/下周三）的换算参照；不填则无可靠参照时留空。保存日不作参照。</span>
            </div>
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
                <Button v-if="f.status !== 'confirmed' && f.status !== 'missing' && f.value != null" size="sm" variant="outline" @click="confirmField(selectedNote, f.key)"><Check />确认</Button>
                <Button v-if="f.key !== 'time_nodes'" size="sm" variant="ghost" @click="startEdit(selectedNote, f.key)"><Pencil />编辑</Button>
              </div>
              <Input v-if="editing && editing.noteId === selectedNote.id && editing.key === f.key" v-model="editing.value" @keyup.enter="saveEdit(selectedNote)" />
              <div v-else-if="f.key === 'time_nodes' && Array.isArray(f.value)" class="space-y-1">
                <div v-for="(n, i) in f.value" :key="i" class="rounded-md border p-2 space-y-1">
                  <div class="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="secondary">{{ n.label || '节点' + (i + 1) }}</Badge>
                    <span>{{ n.value || '（待确认）' }}</span>
                    <Badge v-if="n.basis === 'superseded'" variant="muted">已取代</Badge>
                    <Badge v-else-if="n.basis !== 'explicit'" variant="outline">{{ n.basis }}</Badge>
                    <Badge variant="outline">{{ n.role || 'unknown' }}</Badge>
                    <span class="text-xs text-muted-foreground">{{ n.raw }}</span>
                    <span class="flex-1" />
                    <Button size="sm" variant="ghost" @click="startNodeEdit(selectedNote, i)"><Pencil />编辑节点</Button>
                  </div>
                  <div v-if="n.reference_at" class="text-xs text-muted-foreground">参照 {{ n.reference_at }}（{{ n.reference_source }}）<template v-if="n.message_date"> · 消息日期 {{ n.message_date }}</template></div>
                  <div v-if="editingNode && editingNode.noteId === selectedNote.id && editingNode.index === i" class="grid gap-2 sm:grid-cols-2">
                    <Input v-model="editingNode.label" placeholder="标签" />
                    <Input v-model="editingNode.value" placeholder="值 YYYY-MM-DD 或 ISO datetime（可空）" />
                    <select v-model="editingNode.role" class="rounded-md border bg-background px-2 py-1 text-sm">
                      <option value="submission_deadline">submission_deadline</option>
                      <option value="event_start">event_start</option>
                      <option value="event_end">event_end</option>
                      <option value="other">other</option>
                      <option value="unknown">unknown</option>
                    </select>
                    <select v-model="editingNode.basis" class="rounded-md border bg-background px-2 py-1 text-sm">
                      <option value="explicit">explicit</option>
                      <option value="relative">relative</option>
                      <option value="inferred">inferred</option>
                      <option value="superseded">superseded</option>
                    </select>
                    <Input v-model="editingNode.reference_at" placeholder="参照日期 YYYY-MM-DD（可空）" />
                    <select v-model="editingNode.reference_source" class="rounded-md border bg-background px-2 py-1 text-sm">
                      <option value="">无参照</option>
                      <option value="message_date">message_date</option>
                      <option value="user">user</option>
                    </select>
                    <Input v-model="editingNode.message_date" placeholder="消息日期 YYYY-MM-DD（可空）" />
                    <div class="flex gap-2">
                      <Button size="sm" @click="saveNodeEdit(selectedNote)">保存节点</Button>
                      <Button size="sm" variant="ghost" @click="editingNode = null">取消</Button>
                    </div>
                  </div>
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
              <Button variant="destructive" @click="deleteNote(selectedNote)">删除便签</Button>
            </div>
            <div class="flex gap-2 items-center">
              <Input v-model="manualDeadline" placeholder="手动截止 YYYY-MM-DD（用户输入来源）" class="max-w-xs" />
              <Button variant="outline" @click="createTaskManual(selectedNote)">手动截止建任务</Button>
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
                  截止 {{ t.deadline ? t.deadline.value : '无' }} · {{ t.deadline && t.deadline.from_note_id ? '来自便签 ' + t.deadline.from_note_id.slice(0, 8) + '…' : t.deadline && t.deadline.source === 'manual' ? '用户手动输入' : '—' }}
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
