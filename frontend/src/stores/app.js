import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { allDocs, allSources, allWorkspaces, configureWorkspace, getSource, getWorkspace, putDoc, putSource, putWorkspace, snapshot, transformDocsAtomic, transformFocusAtomic } from '@/services/storage/db'
import { analyze, blobToBase64, healthz } from '@/services/api/client'
import { canConfirm, failedNote, manualTask, mergeReanalysis, taskFromNote } from '@/domains/note'
import { beijingTodayLabel, interpretInstant, isOverdue, isValidDate, isValidTimeValue, nextBeijingMidnightMs } from '@/domains/time'
import { mattersOf, noteBucket, partitionTasks } from '@/domains/organize'
import { addActionPlan, deleteActionPlan, editActionPlan, makeAction, reopenTaskPlan, setActionDonePlan, setCurrentActionPlan } from '@/domains/action'
import { cascadeDeleteNotePlan, deleteMatterPlan, deleteTaskPlan, finishTaskPlan, migratePlan, normalizeDeadline, planDeleteScope, setMatterPlan, undoDeletePlan } from '@/domains/matter'
import { sessionsOf } from '@/domains/focus'
import { useFocusStore } from './focus'

const WORKSPACE_KEY = 'jxl-workspace'
const UI_NOTE_KEY = 'jxl-ui-note'
const UI_EVIDENCE_KEY = 'jxl-ui-evidence'
const PENDING_SAVE_KEY = 'jxl-pending-save'

const readLocal = (key) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeLocal = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 隐私模式等场景 localStorage 不可用：UI 状态退化为仅本次会话
  }
}

export const useAppStore = defineStore('app', () => {
  const sources = ref([])
  const docs = ref([])
  const health = ref(null)
  const aiDown = ref(false)
  const busy = ref(false)
  const banner = ref(null)
  const pendingId = ref(null)
  const imageUrl = ref(null)
  const lastDeleted = ref(null)
  // 删除/完成保护：命中未结束会话时由统一对话框引导「先处理工作」，不再用误导性的「先暂停或结束」toast。
  const workBlock = ref(null)
  // 数据就绪标记：深链接对象校验须等加载完成，避免把合法 ID 误判为不存在。
  const ready = ref(false)

  // 当前工作区（personal/demo）。UI 持久化键按空间隔离，切换不残留上一空间状态。
  const workspaceId = ref(readLocal(WORKSPACE_KEY) || 'personal')
  const workspaces = ref([])
  const wsKey = (base) => `${base}:${workspaceId.value}`
  const selectedNoteId = ref(readLocal(wsKey(UI_NOTE_KEY)))
  const evidenceOpen = ref(readLocal(wsKey(UI_EVIDENCE_KEY)) !== '0')
  const pendingSave = ref(JSON.parse(readLocal(wsKey(PENDING_SAVE_KEY)) || 'null'))

  const currentWorkspace = computed(() =>
    workspaces.value.find((w) => w.id === workspaceId.value) || {
      id: workspaceId.value,
      name: workspaceId.value === 'demo' ? '演示空间' : '个人空间',
      is_demo: workspaceId.value === 'demo',
    })
  const isDemo = computed(() => !!currentWorkspace.value.is_demo)
  // 恢复空间：目录记录带本地恢复回执（commitRestore 写入）。既非个人也非演示，不可被演示重置。
  const isRestore = computed(() => !!currentWorkspace.value.restore_receipt)
  const workspaceKind = computed(() => (isDemo.value ? 'demo' : isRestore.value ? 'restore' : 'personal'))

  const notes = computed(() => docs.value.filter((d) => d.kind === 'note'))
  const matters = computed(() => mattersOf(docs.value))
  // 行动（契约 Action，kind 仅为持久化元数据）：按任务读取，创建时间正序。
  const actions = computed(() => docs.value.filter((d) => d.kind === 'action'))
  const actionsOf = (taskId) =>
    actions.value.filter((a) => a.task_id === taskId).slice().sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  // 当前行动必须属于本任务且未完成；无效引用不展示成有效当前行动。
  const currentActionOf = (task) => {
    if (!task || !task.current_action_id) return null
    const a = actions.value.find((x) => x.id === task.current_action_id)
    return a && a.task_id === task.id && !a.done ? a : null
  }
  const unfinishedCountOf = (taskId) => actionsOf(taskId).filter((a) => !a.done).length
  // 跨北京午夜动态刷新：nowTick 驱动今天标签/逾期/今日分区重算（不改动持久化事实）。
  const nowTick = ref(Date.now())
  let clockTimer = null
  const armClock = () => {
    if (clockTimer) clearTimeout(clockTimer)
    const delay = Math.max(1000, nextBeijingMidnightMs(nowTick.value) - Date.now() + 50)
    clockTimer = setTimeout(() => {
      nowTick.value = Date.now()
      armClock()
    }, delay)
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') {
      nowTick.value = Date.now()
      armClock()
      // 页面重新聚焦时刷新目录：其它标签/本页恢复出的新空间无需重启即可见（§7）。
      void refreshWorkspaces()
    }
  }
  function startClock() {
    // 测试/SSR 等无 DOM 环境不启动时钟（避免悬挂定时器与监听）。
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    armClock()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
  }
  function stopClock() {
    if (clockTimer) clearTimeout(clockTimer)
    clockTimer = null
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onVisible)
  }
  const todayLabel = computed(() => beijingTodayLabel(new Date(nowTick.value)))
  const tasks = computed(() =>
    docs.value
      .filter((d) => d.kind === 'task')
      .slice()
      .sort((a, b) => {
        const nowD = new Date(nowTick.value)
        const ov = Number(isOverdue(b, nowD)) - Number(isOverdue(a, nowD))
        if (ov) return ov
        // 同一逾期态内按北京解释的绝对时刻排序（naive 与明确偏移可比），无截止排最后。
        const av = a.deadline && a.deadline.value ? interpretInstant(a.deadline.value) : null
        const bv = b.deadline && b.deadline.value ? interpretInstant(b.deadline.value) : null
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        return av - bv
      }),
  )
  const taskBuckets = computed(() => partitionTasks(tasks.value, new Date(nowTick.value)))
  const noteBuckets = computed(() => {
    const out = { pending: [], failed: [], confirmed: [] }
    for (const n of notes.value) out[noteBucket(n)].push(n)
    return out
  })
  const failedNotes = computed(() => noteBuckets.value.failed)
  const selectedNote = computed(() => notes.value.find((n) => n.id === selectedNoteId.value) || null)
  const pendingSource = computed(() => sources.value.find((s) => s.id === pendingId.value) || null)
  const unconfirmedCount = computed(() =>
    notes.value.reduce((acc, n) => acc + n.fields.filter((f) => f.status === 'candidate' || f.status === 'unresolved').length, 0),
  )

  const say = (tone, msg) => {
    banner.value = { tone, msg }
  }
  const now = () => new Date().toISOString()
  const fail = () => ({ ok: false, noteId: null })
  // S1 归属守卫：异步结果只在归属==当前空间时应用；晚到的原空间事实留在原空间 DB，不污染新空间。
  const belongsHere = (result) => !!result && result.workspace_id === workspaceId.value

  watch(selectedNoteId, (v) => writeLocal(wsKey(UI_NOTE_KEY), v))
  watch(evidenceOpen, (v) => writeLocal(wsKey(UI_EVIDENCE_KEY), v ? '1' : '0'))
  watch(pendingSave, (v) => writeLocal(wsKey(PENDING_SAVE_KEY), v ? JSON.stringify(v) : null), { deep: true })

  async function reload() {
    const srcRes = await allSources()
    const docRes = await allDocs()
    // 晚到的旧空间读取不覆盖新空间列表（S1）。
    if (!belongsHere(srcRes) || !belongsHere(docRes)) return
    sources.value = srcRes.records
    docs.value = docRes.records
    if (selectedNoteId.value && !notes.value.some((n) => n.id === selectedNoteId.value)) selectedNoteId.value = null
    if (!selectedNoteId.value && notes.value.length) await selectNote(notes.value[notes.value.length - 1].id)
    else if (selectedNoteId.value) await loadEvidence(selectedNote.value)
  }

  // 专注服务独立事务改写任务/行动后，按数据库重读 docs（不含 sources/blob），
  // 否则任务详情仍读旧快照（如受阻任务 begin 后 status 已 doing，界面却仍按 blocked 二次确认）。
  async function reloadDocs() {
    const docRes = await allDocs()
    if (!belongsHere(docRes)) return
    docs.value = docRes.records
  }

  async function loadEvidence(note) {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
    imageUrl.value = null
    if (!note || !note.source_id) return
    const res = await getSource(note.source_id)
    if (!belongsHere(res)) return
    const source = res.record
    if (source && source.kind === 'image' && source.blob) imageUrl.value = URL.createObjectURL(source.blob)
  }

  async function selectNote(id) {
    selectedNoteId.value = id
    await loadEvidence(notes.value.find((n) => n.id === id) || null)
  }

  // 仅负责默认个人/演示空间的初始化建壳（§7）。恢复空间由 commitRestore 建立目录记录，
  // 绝不在此为任意缺失 ID 自动建「个人空间」壳——否则会掩盖「空间不存在」并造成静默覆盖。
  async function ensureWorkspace(id) {
    if (id !== 'personal' && id !== 'demo') return
    const existing = await getWorkspace(id)
    if (!existing) {
      await putWorkspace({
        id,
        name: id === 'demo' ? '演示空间' : '个人空间',
        is_demo: id === 'demo',
        created_at: now(),
      })
    }
  }

  // 显式目录刷新（§7）：恢复成功、页面重新聚焦时重读目录，新恢复空间无需重启浏览器即可见。
  async function refreshWorkspaces() {
    workspaces.value = await allWorkspaces()
    return workspaces.value
  }

  async function init() {
    await ensureWorkspace('personal')
    await ensureWorkspace('demo')
    // 持久化的当前空间若已不在目录（如恢复空间被移除）→ 解释并回到个人空间，不静默建壳/覆盖。
    if (workspaceId.value !== 'personal' && workspaceId.value !== 'demo') {
      const dir = await allWorkspaces()
      if (!dir.some((w) => w.id === workspaceId.value)) {
        say('warning', '上次所在的空间已不存在，已回到个人空间')
        workspaceId.value = 'personal'
        writeLocal(WORKSPACE_KEY, 'personal')
      }
    }
    configureWorkspace(workspaceId.value)
    workspaces.value = await allWorkspaces()
    await migrate()
    await reload()
    await useFocusStore().loadWorkspace()
    ready.value = true
    startClock()
    await refreshHealth()
  }

  async function refreshHealth() {
    const h = await healthz()
    if (h.ok) {
      health.value = h.body
      // Personal credentials use a request-scoped provider even without a server model profile.
      aiDown.value = false
    } else {
      health.value = null
      aiDown.value = true
    }
  }

  // 切换工作区：清掉上一空间的选中项/图片 URL/待处理/横幅，重载目标空间数据与 UI 状态。
  // 各空间的 UI 持久化键互相隔离，切回时恢复该空间自己的状态，不串味。
  async function switchWorkspace(id) {
    if (id === workspaceId.value) return
    // 非默认空间必须已存在于目录（恢复空间由 commitRestore 建立）；缺失则报告不存在，绝不自动建壳。
    if (id !== 'personal' && id !== 'demo') {
      const dir = await allWorkspaces()
      if (!dir.some((w) => w.id === id)) {
        say('warning', '该空间不存在或已被移除，未切换')
        return { ok: false, notFound: true }
      }
    }
    ready.value = false
    if (imageUrl.value) {
      URL.revokeObjectURL(imageUrl.value)
      imageUrl.value = null
    }
    pendingId.value = null
    banner.value = null
    lastDeleted.value = null
    await ensureWorkspace(id)
    configureWorkspace(id)
    workspaceId.value = id
    writeLocal(WORKSPACE_KEY, id)
    workspaces.value = await allWorkspaces()
    selectedNoteId.value = readLocal(wsKey(UI_NOTE_KEY))
    evidenceOpen.value = readLocal(wsKey(UI_EVIDENCE_KEY)) !== '0'
    pendingSave.value = JSON.parse(readLocal(wsKey(PENDING_SAVE_KEY)) || 'null')
    await migrate()
    await reload()
    await useFocusStore().loadWorkspace()
    ready.value = true
  }

  // ---- M2 最小抽取：返回已保存资料记录/明确分析结果，供助手真实生成编排； ----
  // 不依赖 pendingId/selectNote，无 UI 副作用。collectFiles/collectText 委托同一实现，行为不变。
  async function saveImageFiles(files) {
    const out = []
    const ws = workspaceId.value
    for (const file of files) {
      if (workspaceId.value !== ws || isDemo.value) {
        out.push({ ok: false, code: 'workspace_unavailable', name: file.name, message: '请在原个人工作区添加资料' })
        continue
      }
      if (!file.type.startsWith('image/')) {
        out.push({ ok: false, code: 'unsupported', name: file.name, message: `不支持的类型：${file.type || file.name}` })
        continue
      }
      const source = { id: crypto.randomUUID(), kind: 'image', captured_at: now(), blob: file, name: file.name }
      let saved
      try {
        saved = await putSource(source)
      } catch (err) {
        out.push({ ok: false, code: 'save_failed', name: file.name, message: err.message })
        continue
      }
      if (!belongsHere(saved)) {
        out.push({ ok: false, code: 'workspace_changed', name: file.name, message: '工作区已切换，原图未写入当前空间' })
        continue
      }
      sources.value.push(saved.record)
      out.push({ ok: true, record: saved.record })
    }
    return out
  }

  async function saveText(text) {
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, code: 'empty', message: '先粘贴或输入文字' }
    const source = { id: crypto.randomUUID(), kind: 'text', captured_at: now(), text: trimmed }
    let saved
    try {
      saved = await putSource(source)
    } catch (err) {
      return { ok: false, code: 'save_failed', message: err.message }
    }
    if (!belongsHere(saved)) return { ok: false, code: 'workspace_changed', message: '工作区已切换，文字未写入当前空间' }
    sources.value.push(saved.record)
    return { ok: true, record: saved.record }
  }

  async function collectFiles(files) {
    for (const r of await saveImageFiles(files)) {
      if (r.ok) {
        pendingId.value = r.record.id
        say('success', `原图已保存到本地（${r.record.name}），可「仅保存」留存或「AI 整理」`)
      } else if (r.code === 'unsupported') {
        say('warning', r.message)
      } else if (r.code === 'save_failed') {
        say('destructive', `保存失败（${r.message}）：原图未写入本地，请重试`)
      }
    }
  }

  async function collectText(text) {
    const r = await saveText(text)
    if (r.ok) {
      pendingId.value = r.record.id
      say('success', '文字已保存到本地（未调用 AI）')
      return true
    }
    if (r.code === 'empty') say('warning', r.message)
    else if (r.code === 'save_failed') say('destructive', `保存失败（${r.message}）：文字未写入本地`)
    return r.code === 'workspace_changed'
  }

  const upsertDoc = (doc) => {
    const idx = docs.value.findIndex((d) => d.id === doc.id)
    if (idx >= 0) docs.value[idx] = doc
    else docs.value.push(doc)
  }

  // 事务提交成功后才更新界面：写入用事务返回的已落库记录，删除按 id 移除。
  // 归属不匹配（提交后回调迟到期间切了空间）→ 不应用到当前列表，返回 false 由调用方中止后续副作用。
  const applyChanges = (result) => {
    if (!belongsHere(result)) {
      say('warning', '工作区已切换：本次变更已保存在原空间，不应用到当前列表')
      return false
    }
    const { puts = [], deletes = [] } = result
    for (const doc of puts) upsertDoc(doc)
    if (deletes.length) {
      const gone = new Set(deletes)
      docs.value = docs.value.filter((d) => !gone.has(d.id))
    }
    // 删除/撤销会补丁已结束会话的引用状态（action_ref_state 等）：同步刷新 focus 事实，
    // 否则任务详情历史卡片仍显示旧的引用状态。
    if (puts.some((d) => d.kind === 'focus_session')) void useFocusStore().loadWorkspace()
    return true
  }

  // 幂等结构迁移（旧 group/group_id → 契约 Matter/matter_id）：每个空间进入时执行，不清空数据。
  async function migrate() {
    try {
      applyChanges(await transformDocsAtomic(migratePlan))
    } catch (err) {
      say('destructive', `本地结构迁移失败（${err.message}）：数据未改动，可重试或先导出备份`)
    }
  }

  // 幂等：同一 source 重分析更新既有便签；落库失败暂存，重试仅落库不重调模型。
  // 分析期间切空间：结果暂存回原空间的待保存键，绝不写进新空间（S1）。
  async function runAnalysis(sourceId, referenceAt) {
    if (isDemo.value) return fail()
    const ws = workspaceId.value
    const source = sources.value.find((s) => s.id === sourceId)
    if (!source) {
      say('warning', '先收集一份截图或文字')
      return fail()
    }
    const refDate = (referenceAt || '').trim()
    if (refDate && !isValidDate(refDate)) {
      say('warning', '参照日期须为合法的 YYYY-MM-DD')
      return fail()
    }
    busy.value = true
    try {
      const payload = { source_id: source.id, kind: source.kind, captured_at: source.captured_at }
      if (refDate) payload.reference_at = refDate
      if (source.kind === 'image') payload.image_base64 = await blobToBase64(source.blob)
      else payload.text = source.text
      const result = await analyze(payload)
      if (result.ok) {
        const existing = notes.value.find((n) => n.source_id === source.id) || null
        const note = mergeReanalysis(existing, result.body, now())
        if (workspaceId.value !== ws) {
          writeLocal(`${PENDING_SAVE_KEY}:${ws}`, JSON.stringify(note))
          say('warning', '工作区已切换：分析结果已暂存到原空间，切回后可重试保存（不重调模型）')
          return { ok: false, saved: false, noteId: null }
        }
        let saved
        try {
          saved = await putDoc(note)
        } catch (err) {
          pendingSave.value = note
          say('destructive', `保存失败（${err.message}）：分析结果已暂存，可重试保存（不重调模型）`)
          return { ok: false, saved: false, noteId: null }
        }
        if (!belongsHere(saved)) return { ok: true, noteId: note.id, workspaceChanged: true }
        pendingSave.value = null
        upsertDoc(note)
        pendingId.value = null
        await selectNote(note.id)
        say('success', `AI 草稿已生成：${note.fields.length} 个字段，待你核对确认`)
        return { ok: true, noteId: note.id }
      }
      if (result.code === 'unknown_source') {
        say('warning', '资料已在本地保存。当前服务仅支持内置案例，分析个人资料需要连接真实模型。')
        return fail()
      }
      if (result.status === 422) {
        const existing = notes.value.find((n) => n.source_id === source.id)
        if (existing) {
          say('destructive', `422 ${result.code}：本次分析未生效，既有便签与已确认字段保持不变，原图仍在本地`)
          return fail()
        }
        const note = failedNote(source, result.code, now())
        if (workspaceId.value !== ws) {
          writeLocal(`${PENDING_SAVE_KEY}:${ws}`, JSON.stringify(note))
          say('warning', '工作区已切换：失败记录已暂存到原空间，切回后可重试保存（不重调模型）')
          return { ok: false, saved: false, noteId: null }
        }
        let saved
        try {
          saved = await putDoc(note)
        } catch (err) {
          pendingSave.value = note
          say('destructive', `保存失败（${err.message}）：失败记录已暂存，可重试保存（不重调模型）`)
          return { ok: false, saved: false, noteId: null }
        }
        if (!belongsHere(saved)) return { ok: false, noteId: note.id, workspaceChanged: true }
        upsertDoc(note)
        await selectNote(note.id)
        say('destructive', `422 ${result.code}：原图仍在本地，可重试或手动整理`)
        return { ok: false, noteId: note.id }
      }
      if (result.status === 503) {
        say('warning', result.message || '模型暂时不可用，请稍后重试。')
        return fail()
      }
      if (result.status === 413) {
        say('warning', '图片超出体积上限：请压缩后重试，原图已在本地')
        return fail()
      }
      if (result.kind === 'network') {
        say('destructive', `网络错误：${result.message}（本地数据不受影响）`)
        return fail()
      }
      say('warning', result.message || `请求未完成（${result.status}）`)
      return fail()
    } finally {
      busy.value = false
    }
  }

  async function retrySave() {
    const note = pendingSave.value
    if (!note) return fail()
    let saved
    try {
      saved = await putDoc(note)
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：分析结果仍在暂存，可再次重试（不重调模型）`)
      return fail()
    }
    if (!belongsHere(saved)) return { ok: true, noteId: note.id, workspaceChanged: true }
    pendingSave.value = null
    upsertDoc(note)
    pendingId.value = null
    await selectNote(note.id)
    say('success', '分析结果已保存（重试仅落库，未重调模型）')
    return { ok: true, noteId: note.id }
  }

  // M2 助手专用分析：明确返回结果（含可取消），不做 selectNote/pendingId/say 等 UI 副作用。
  // 保存失败时把已得便签一并返回，调用方可仅重试落库（saveAnalysisNote），不重调模型。
  async function analyzeForAssistant(sourceId, /** @type {{ signal?: AbortSignal }} */ { signal } = {}) {
    if (isDemo.value) return { ok: false, code: 'DEMO_SPACE', message: '演示空间使用内置案例' }
    const ws = workspaceId.value
    const source = sources.value.find((s) => s.id === sourceId)
    if (!source) return { ok: false, code: 'SOURCE_MISSING', message: '资料不存在或不属于当前空间' }
    const payload = { source_id: source.id, kind: source.kind, captured_at: source.captured_at }
    if (source.kind === 'image') payload.image_base64 = await blobToBase64(source.blob)
    else payload.text = source.text
    const result = await analyze(payload, { signal })
    if (result.kind === 'cancelled') return { ok: false, code: 'cancelled', message: '分析已取消' }
    if (!result.ok) {
      if (result.code === 'unknown_source') return { ok: false, code: result.code, message: '当前服务仅支持内置案例，分析个人资料需要连接真实模型' }
      return { ok: false, code: result.code || 'analyze_failed', status: result.status, kind: result.kind, message: result.message || `分析失败（${result.status}）` }
    }
    const existing = notes.value.find((n) => n.source_id === source.id) || null
    const note = mergeReanalysis(existing, result.body, now())
    if (workspaceId.value !== ws) return { ok: false, code: 'WORKSPACE_CHANGED', message: '工作区已切换，分析结果未写入', note }
    const saved = await saveAnalysisNote(note)
    return saved.ok ? { ok: true, note } : { ...saved, note }
  }

  // 仅落库已得分析便签（重试保存路径）：不重调模型；归属不匹配不应用到当前列表。
  async function saveAnalysisNote(note) {
    let saved
    try {
      saved = await putDoc(note)
    } catch (err) {
      return { ok: false, code: 'SAVE_FAILED', message: `分析结果保存失败（${err.message}），可重试保存` }
    }
    if (!belongsHere(saved)) return { ok: false, code: 'WORKSPACE_CHANGED', message: '工作区已切换，结果未写入当前空间' }
    upsertDoc(note)
    return { ok: true, note }
  }

  // 按文档 id 串行化变更：每次从最新已提交状态克隆再改，连续操作不丢修改、不用旧对象整份覆盖。
  // 排队期间切空间 → 放弃本次修改（返回 undefined，输入留在原空间 UI），绝不把旧空间草稿写进新空间。
  // mutateDoc 与事务型完成（finishTask）共用同一条链：同 tick 完成+重命名不互相覆盖。
  const mutationChains = new Map()
  function chainById(id, job) {
    const ws = workspaceId.value
    const prev = mutationChains.get(id) || Promise.resolve()
    const run = prev.catch(() => {}).then(() => {
      if (ws !== workspaceId.value) {
        say('warning', '工作区已切换，修改未执行')
        return undefined
      }
      return job()
    })
    mutationChains.set(id, run)
    run.finally(() => {
      if (mutationChains.get(id) === run) mutationChains.delete(id)
    })
    return run
  }
  function mutateDoc(doc, fn) {
    const id = doc.id
    return chainById(id, async () => {
      const current = docs.value.find((d) => d.id === id)
      if (!current) {
        say('warning', '记录已不存在，修改未执行')
        return false
      }
      const draft = snapshot(current)
      fn(draft)
      draft.updated_at = now()
      let saved
      try {
        saved = await putDoc(draft)
      } catch (err) {
        say('destructive', `保存失败（${err.message}）：修改未持久化，界面保持原样`)
        return false
      }
      if (belongsHere(saved)) upsertDoc(draft)
      return true
    }).then((r) => (r === undefined ? false : r))
  }

  function confirmField(note, key) {
    const f = note.fields.find((x) => x.key === key)
    if (!f || !canConfirm(f)) {
      say('warning', '空值或终态字段不可确认为事实')
      return Promise.resolve(false)
    }
    return mutateDoc(note, (n) => {
      const target = n.fields.find((x) => x.key === key)
      target.status = 'confirmed' // D4：确认不改 origin；推算值保留 derived 与原文
    })
  }

  const saveEdit = (note, key, value) =>
    mutateDoc(note, (n) => {
      const f = n.fields.find((x) => x.key === key)
      f.value = Array.isArray(f.value) ? value.split('\n').filter(Boolean) : value
      f.origin = 'user'
    })

  const saveNodeEdit = (note, index, e) =>
    mutateDoc(note, (n) => {
      const f = n.fields.find((x) => x.key === 'time_nodes')
      const old = f.value[index]
      const v = (e.value || '').trim()
      f.value[index] = {
        ...old,
        label: (e.label || '').trim(),
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

  const reviewNote = (note) => mutateDoc(note, (n) => { n.status = 'reviewed'; n.reviewed_at = now() })

  async function createTask(note) {
    const task = taskFromNote(note, now())
    if (!task) {
      say('warning', '先独立确认截止时间，才能把它带进任务（出处可追溯）')
      return { ok: false }
    }
    let saved
    try {
      saved = await putDoc(task)
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：任务未持久化`)
      return { ok: false }
    }
    if (!belongsHere(saved)) {
      say('warning', '工作区已切换：任务已保存在原空间')
      return { ok: false, workspaceChanged: true }
    }
    upsertDoc(saved.record)
    say('success', '任务已创建，截止时间来自已确认的便签字段')
    return { ok: true, id: task.id }
  }

  async function createTaskManual(note, value) {
    const task = manualTask(note, value.trim(), now())
    if (!task) {
      say('warning', '手动截止须为合法的 YYYY-MM-DD 或 ISO datetime（日历与时钟都要合法）')
      return { ok: false }
    }
    let saved
    try {
      saved = await putDoc(task)
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：任务未持久化`)
      return { ok: false }
    }
    if (!belongsHere(saved)) {
      say('warning', '工作区已切换：任务已保存在原空间')
      return { ok: false, workspaceChanged: true }
    }
    upsertDoc(saved.record)
    say('success', '任务已创建（截止为用户手动输入，已记录确认时间）')
    return { ok: true, id: task.id }
  }

  // 未结束会话保护：把命中的会话解析成可展示信息（运行/暂停/旧版），交统一对话框引导「前往处理工作」。
  // 同工作区至多一份未结束会话，列表通常只有一项；原任务/行动已缺失的旧版会话如实标注，不伪造标题。
  function blockWork(err) {
    const sessions = (err.sessions || []).map((s) => {
      const task = docs.value.find((d) => d.id === s.task_id && d.kind === 'task')
      const action = docs.value.find((d) => d.id === s.action_id && d.kind === 'action')
      const v1 = s.record_version === 1
      return {
        id: s.id,
        title: (task && task.title) || (s.task_snapshot && s.task_snapshot.title) || null,
        actionText: (action && action.text) || (s.action_snapshot && s.action_snapshot.text) || null,
        state: v1 ? (s.running ? '运行中' : '已暂停') : '旧版未结束',
        missingRefs: !task || (!!s.action_id && !action),
      }
    })
    workBlock.value = { sessions }
    return { ok: false, blocked: true }
  }
  function clearWorkBlock() { workBlock.value = null }

  // 完成/重命名按 ID 读最新记录只改本次字段：详情持有的旧对象不会把已保存状态写回去。
  // 完成任务走事务内 plan（S6）：读最新会话做保护，未结束会话（含暂停）关联任务不可直接完成；
  // 与 mutateDoc 共用按 ID 串行链，同 tick 完成+重命名两项变更都保留。
  async function finishTask(task) {
    return chainById(task.id, async () => {
      let result
      try {
        result = await transformFocusAtomic((latest) => finishTaskPlan(latest, task.id, now(), sessionsOf(latest)))
      } catch (err) {
        if (err && err.code === 'RELATION_INVALID') {
          if (err.sessions && err.sessions.length) return blockWork(err)
          say('warning', err.message)
          return { ok: false }
        }
        say('destructive', `完成失败（${err && err.message}）：任务未改动`)
        return { ok: false }
      }
      if (!result.info || !result.info.task) {
        say('warning', '任务已不存在，修改未执行')
        return { ok: false }
      }
      if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
      return { ok: true }
    }).then((r) => (r === undefined ? { ok: false, workspaceChanged: true } : r))
  }

  // —— 阶段3A：手动行动与当前行动（basis=user，无 AI 生成；3A 无执行会话）——

  async function addAction(task, text, minutes) {
    const action = makeAction(task.id, text, minutes, now())
    if (!action) {
      say('warning', '行动内容不能为空，预计分钟须为正整数')
      return { ok: false }
    }
    try {
      const result = await transformDocsAtomic((latest) => addActionPlan(latest, action))
      if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
      say('success', '行动已添加（用户手动填写，保存后才成为你的选择）')
      return { ok: true, id: action.id }
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：行动未持久化，输入保留`)
      return { ok: false }
    }
  }

  async function editAction(action, text, minutes) {
    const trimmed = String(text || '').trim()
    const m = typeof minutes === 'string' ? Number(minutes) : minutes
    if (!trimmed) {
      say('warning', '行动内容不能为空')
      return { ok: false }
    }
    if (!Number.isInteger(m) || m <= 0) {
      say('warning', '预计分钟须为正整数')
      return { ok: false }
    }
    try {
      const result = await transformDocsAtomic((latest) => editActionPlan(latest, action.id, trimmed, m))
      if (!result.info || !result.info.action) {
        say('warning', '行动已不存在，修改未执行')
        return { ok: false }
      }
      if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
      return { ok: true }
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：修改未持久化，输入保留`)
      return { ok: false }
    }
  }

  // 完成行动不自动完成任务；完成的是当前行动时同事务清空引用，由用户另选下一步。
  async function setActionDone(action, done) {
    try {
      const result = await transformFocusAtomic((latest) => setActionDonePlan(latest, action.id, done, now(), sessionsOf(latest)))
      if (!result.info || !result.info.action) {
        say('warning', '行动已不存在')
        return { ok: false }
      }
      if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
      if (done) {
        say('success', result.info.clearedCurrent
          ? '行动已完成；当前行动已清空，请在行动列表选择下一步'
          : '行动已完成（任务不会自动完成）')
      } else {
        say('success', '行动已重新打开')
      }
      return { ok: true, clearedCurrent: !!result.info.clearedCurrent }
    } catch (err) {
      if (err && err.code === 'RELATION_INVALID') {
        if (err.sessions && err.sessions.length) return blockWork(err)
        say('warning', err.message)
        return { ok: false }
      }
      say('destructive', `保存失败（${err && err.message}）：行动状态未改动`)
      return { ok: false }
    }
  }

  async function deleteAction(action) {
    let result
    try {
      result = await transformFocusAtomic((latest) => deleteActionPlan(latest, action.id, now(), sessionsOf(latest)))
    } catch (err) {
      if (err && err.code === 'RELATION_INVALID') {
        if (err.sessions && err.sessions.length) return blockWork(err)
        say('warning', err.message)
        return { ok: false }
      }
      say('destructive', `删除失败（${err && err.message}）：行动未改动`)
      return { ok: false }
    }
    if (!result.info || !result.info.action) {
      say('warning', '行动已不存在，无需删除')
      return { ok: false }
    }
    if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
    lastDeleted.value = {
      kind: 'action',
      action: snapshot(result.info.action),
      wasCurrent: !!result.info.wasCurrent,
      sessionPatches: result.info.sessionPatches || [],
    }
    say('success', '行动已删除。可在「日程 · 恢复」撤销本次删除')
    return { ok: true }
  }

  async function setCurrentAction(task, actionId) {
    try {
      const result = await transformDocsAtomic((latest) => setCurrentActionPlan(latest, task.id, actionId || null, now()))
      if (!result.info || !result.info.task) {
        say('warning', '任务已不存在')
        return { ok: false }
      }
      if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
      say('success', actionId ? '已设为当前行动' : '已取消当前行动选择')
      return { ok: true }
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：当前行动未改动`)
      return { ok: false }
    }
  }

  // 重新打开任务回 todo；不重开已完成行动；无效当前引用清空。
  async function reopenTask(task) {
    try {
      const result = await transformDocsAtomic((latest) => reopenTaskPlan(latest, task.id, now()))
      if (!result.info || !result.info.task) {
        say('warning', '任务已不存在')
        return { ok: false }
      }
      if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
      say('success', '任务已重新打开（回到待办）；已完成行动不会自动重开')
      return { ok: true }
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：任务状态未改动`)
      return { ok: false }
    }
  }

  // 详情编辑：只写传入的字段；完成标准空串归一为 null（契约形状）。
  async function editTask(task, fields) {
    if ('title' in fields && !String(fields.title || '').trim()) {
      say('warning', '任务名称不能为空')
      return { ok: false }
    }
    return {
      ok: await mutateDoc(task, (t) => {
        if ('title' in fields) t.title = String(fields.title).trim()
        if ('description' in fields) t.description = String(fields.description || '')
        if ('completion_criteria' in fields) {
          const c = String(fields.completion_criteria || '').trim()
          t.completion_criteria = c || null
        }
      }),
    }
  }

  // 手动调整/清空截止：改值 → source=manual + 确认时间，保留 note_ids 关联，不改便签字段；
  // 未改值不写入、不伪造来源变化；清空 → 契约空 Deadline 形状。
  async function setTaskDeadline(task, value) {
    const v = (value || '').trim()
    if (v && !isValidTimeValue(v)) {
      say('warning', '截止须为合法的 YYYY-MM-DD 或 ISO datetime')
      return { ok: false }
    }
    const latest = docs.value.find((d) => d.id === task.id)
    const cur = latest && latest.deadline && latest.deadline.value ? latest.deadline.value : ''
    if (v === cur) return { ok: true, unchanged: true }
    return {
      ok: await mutateDoc(task, (t) => {
        t.deadline = v
          ? { value: v, precision: v.includes('T') ? 'datetime' : 'date', source: 'manual', from_note_id: null, confirmed_at: now() }
          : normalizeDeadline(null)
      }),
    }
  }

  // R2：确认时补齐计划影响快照（当前确认框尚未展示安排清单）。
  // 新调用方显式提交 planItemIds/planFacts 时尊重其快照，不代填；事务内仍与最新事实比对。
  function withPlanScope(expectedScope) {
    if (!expectedScope || Array.isArray(expectedScope.planItemIds) || Array.isArray(expectedScope.planFacts)) return expectedScope
    const facts = planDeleteScope(docs.value, expectedScope.taskIds || [], sessionsOf(docs.value))
    return { ...expectedScope, planItemIds: facts.map((p) => p.id), planFacts: facts }
  }

  // 联删（DECISIONS 2026-11-18 用户追加决定）：确认框列出关联任务后，同一事务删除便签与这些任务。
  // 关联 = note_ids 引用 ∪ deadline.from_note_id 引用，按任务 ID 去重；共享任务整体删除。
  // 不扩散删除其它便签/事项；原始截图/文字与专注历史保留；失败整体回滚，界面不动。
  async function deleteNote(note, expectedScope = null) {
    let result
    try {
      result = await transformFocusAtomic((latest) => cascadeDeleteNotePlan(latest, note.id, sessionsOf(latest), withPlanScope(expectedScope)))
    } catch (err) {
      if (err && err.code === 'SCOPE_CHANGED') return { ok: false, scopeChanged: true }
      if (err && err.code === 'PLAN_PROGRESS_REQUIRED') {
        say('warning', err.message)
        return { ok: false, planProgressRequired: true, planItemIds: err.planItemIds || [] }
      }
      if (err && err.code === 'UNFINISHED_FOCUS') {
        say('warning', err.message)
        return { ok: false, unfinishedFocus: true, planItemIds: err.planItemIds || [] }
      }
      if (err && err.code === 'RELATION_INVALID') {
        if (err.sessions && err.sessions.length) return blockWork(err)
        say('warning', err.message)
        return { ok: false }
      }
      say('destructive', `删除失败（${err && err.message}）：便签与关联任务均未改动`)
      return { ok: false }
    }
    const info = result.info
    if (!info || !info.note) {
      say('warning', '便签已不存在，无需删除')
      return { ok: false }
    }
    if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
    if (selectedNoteId.value === note.id) selectedNoteId.value = null
    lastDeleted.value = {
      kind: 'note',
      note: snapshot(info.note),
      tasks: info.tasks.map((t) => snapshot(t)),
      actions: (info.actions || []).map((a) => snapshot(a)),
      sessionPatches: info.sessionPatches || [],
      planRemoved: (info.planRemoved || []).map((p) => snapshot(p)),
      planDetached: info.planDetached || [],
    }
    const n = info.tasks.length
    const na = (info.actions || []).length
    say('success', n
      ? `便签与 ${n} 个关联任务${na ? `、${na} 个行动` : ''}已删除；原始资料保留。可在「日程 · 恢复」撤销本次删除`
      : '便签已删除；原始资料保留。可在「日程 · 恢复」撤销本次删除')
    return { ok: true, deletedTaskIds: info.tasks.map((t) => t.id) }
  }

  // 撤销最近一次删除：事务内读最新状态，只逆转本次操作。记录已有新版本 / 引用悬空时明确拒绝，
  // 绝不写回整份旧快照覆盖用户新事实；事项已删则清除悬空归组，不恢复进已删事项。
  async function undoDelete() {
    const last = lastDeleted.value
    if (!last) return { ok: false }
    let refs
    let planRefs
    try {
      const result = await transformFocusAtomic((latest) => undoDeletePlan(latest, last, now()))
      if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
      refs = result.info && result.info.sessionRefs
      planRefs = result.info && result.info.planRefs
    } catch (err) {
      say('destructive', `未恢复：${err.message}`)
      return { ok: false, refused: true }
    }
    lastDeleted.value = null
    say('success', last.kind === 'note'
      ? '便签与本次一并删除的任务、行动已恢复'
      : last.kind === 'action'
        ? '行动已恢复'
        : '任务与其行动已恢复')
    if (refs && refs.refused.length) {
      say('warning', '部分专注会话的引用未回补（记录已变化或对象仍缺失），历史保持断开状态')
    }
    if (planRefs && planRefs.refused.length) {
      say('warning', '部分计划条目的任务引用未回补（条目已变化或任务仍缺失），保持断开状态')
    }
    return { ok: true }
  }

  async function deleteTask(task, expectedScope = null) {
    let result
    try {
      result = await transformFocusAtomic((latest) => deleteTaskPlan(latest, task.id, sessionsOf(latest), withPlanScope(expectedScope)))
    } catch (err) {
      if (err && err.code === 'SCOPE_CHANGED') return { ok: false, scopeChanged: true }
      if (err && err.code === 'PLAN_PROGRESS_REQUIRED') {
        say('warning', err.message)
        return { ok: false, planProgressRequired: true, planItemIds: err.planItemIds || [] }
      }
      if (err && err.code === 'UNFINISHED_FOCUS') {
        say('warning', err.message)
        return { ok: false, unfinishedFocus: true, planItemIds: err.planItemIds || [] }
      }
      if (err && err.code === 'RELATION_INVALID') {
        if (err.sessions && err.sessions.length) return blockWork(err)
        say('warning', err.message)
        return { ok: false }
      }
      say('destructive', `删除失败（${err && err.message}）：任务未改动`)
      return { ok: false }
    }
    if (!result.info || !result.info.task) {
      say('warning', '任务已不存在，无需删除')
      return { ok: false }
    }
    if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
    const na = (result.info.actions || []).length
    lastDeleted.value = {
      kind: 'task',
      task: snapshot(result.info.task),
      actions: (result.info.actions || []).map((a) => snapshot(a)),
      sessionPatches: result.info.sessionPatches || [],
      planRemoved: (result.info.planRemoved || []).map((p) => snapshot(p)),
      planDetached: result.info.planDetached || [],
    }
    say('success', `任务${na ? `与 ${na} 个行动` : ''}已删除。可在「日程 · 恢复」撤销本次删除`)
    return { ok: true }
  }

  async function renameTask(task, title) {
    const trimmed = (title || '').trim()
    if (!trimmed) {
      say('warning', '名称不能为空')
      return { ok: false }
    }
    return { ok: await mutateDoc(task, (t) => { t.title = trimmed }) }
  }

  // 独立创建任务（不依赖便签）：截止可空（契约空 Deadline 形状）或手动合法值；可归入事项。
  async function createStandaloneTask({ title, value = '', matterId = null }) {
    const trimmed = (title || '').trim()
    if (!trimmed) {
      say('warning', '先给任务起个名字')
      return { ok: false }
    }
    const v = (value || '').trim()
    if (v && !isValidTimeValue(v)) {
      say('warning', '截止须为合法的 YYYY-MM-DD 或 ISO datetime')
      return { ok: false }
    }
    if (matterId && !matters.value.some((m) => m.id === matterId)) {
      say('warning', '所选事项不存在')
      return { ok: false }
    }
    const task = {
      id: crypto.randomUUID(),
      kind: 'task',
      title: trimmed,
      description: '',
      matter_id: matterId || null,
      note_ids: [],
      deadline: v
        ? { value: v, precision: v.includes('T') ? 'datetime' : 'date', source: 'manual', from_note_id: null, confirmed_at: now() }
        : normalizeDeadline(null),
      status: 'todo',
      completion_criteria: null,
      current_action_id: null,
      created_at: now(),
      updated_at: now(),
    }
    let saved
    try {
      saved = await putDoc(task)
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：任务未持久化`)
      return { ok: false }
    }
    if (!belongsHere(saved)) {
      say('warning', '工作区已切换：任务已保存在原空间')
      return { ok: false, workspaceChanged: true }
    }
    upsertDoc(saved.record)
    say('success', '任务已创建')
    return { ok: true, id: task.id }
  }

  // 事项（契约 Matter）：title + note_ids，便签/任务按 matter_id 关联。
  async function createMatter(title) {
    const trimmed = (title || '').trim()
    if (!trimmed) {
      say('warning', '事项名不能为空')
      return { ok: false }
    }
    if (matters.value.some((m) => m.title === trimmed)) {
      say('warning', '已有同名事项')
      return { ok: false }
    }
    const matter = { id: crypto.randomUUID(), kind: 'matter', title: trimmed, note_ids: [], created_at: now(), is_demo: isDemo.value }
    let saved
    try {
      saved = await putDoc(matter)
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：事项未持久化`)
      return { ok: false }
    }
    if (!belongsHere(saved)) {
      say('warning', '工作区已切换：事项已保存在原空间')
      return { ok: false, workspaceChanged: true }
    }
    upsertDoc(saved.record)
    return { ok: true, id: matter.id }
  }

  async function renameMatter(matter, title) {
    const trimmed = (title || '').trim()
    if (!trimmed) {
      say('warning', '事项名不能为空')
      return { ok: false }
    }
    const draft = snapshot(matter)
    draft.title = trimmed
    let saved
    try {
      saved = await putDoc(draft)
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：重命名未持久化`)
      return { ok: false }
    }
    if (!belongsHere(saved)) {
      say('warning', '工作区已切换：重命名已保存在原空间')
      return { ok: false, workspaceChanged: true }
    }
    upsertDoc(saved.record)
    return { ok: true }
  }

  // 删事项（P04）：单事务解除成员归组 + 删事项记录；便签/原图/任务/专注记录保留，便签资料角色清除。
  async function deleteMatter(matter) {
    let result
    try {
      result = await transformDocsAtomic((latest) => deleteMatterPlan(latest, matter.id, now()))
    } catch (err) {
      say('destructive', `删除失败（${err.message}）：事项与成员归属均未改动`)
      return { ok: false }
    }
    if (!result.info || !result.info.matter) {
      say('warning', '事项已不存在，无需删除')
      return { ok: false }
    }
    if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
    say('success', `事项已删除；${result.info.members.length} 个成员回到未归组（便签、原图与任务保留）`)
    return { ok: true }
  }

  // 手动归组/换组/移出（非 AI）：便签同时维护 Matter.note_ids 与资料角色，任务只持 matter_id。
  async function setMatter(doc, matterId, role) {
    try {
      const result = await transformDocsAtomic((latest) => setMatterPlan(latest, doc.id, matterId || null, role, now()))
      if (!result.info || !result.info.doc) {
        say('warning', '记录已不存在')
        return { ok: false }
      }
      if (!applyChanges(result)) return { ok: false, workspaceChanged: true }
      return { ok: true }
    } catch (err) {
      say('destructive', `保存失败（${err.message}）：归组未持久化，界面保持原样`)
      return { ok: false }
    }
  }

  // 资料角色只在已归组便签上有效（契约：未归组便签不得有资料角色）。
  const setNoteRole = (note, role) => {
    if (!note.matter_id) {
      say('warning', '先把便签归入事项，再选择资料角色')
      return Promise.resolve({ ok: false })
    }
    return setMatter(note, note.matter_id, role)
  }

  return {
    sources, docs, health, aiDown, busy, banner, pendingId, selectedNoteId, evidenceOpen, imageUrl, pendingSave, lastDeleted, workBlock, ready,
    workspaceId, workspaces, currentWorkspace, isDemo, isRestore, workspaceKind,
    notes, tasks, matters, actions, selectedNote, pendingSource, unconfirmedCount,
    nowTick, todayLabel, taskBuckets, noteBuckets, failedNotes,
    say, clearWorkBlock, init, refreshHealth, reload, reloadDocs, selectNote, switchWorkspace, refreshWorkspaces, collectFiles, collectText, runAnalysis, retrySave,
    saveImageFiles, saveText, analyzeForAssistant, saveAnalysisNote,
    confirmField, saveEdit, saveNodeEdit, reviewNote, createTask, createTaskManual, finishTask, deleteNote,
    undoDelete, deleteTask, renameTask, createStandaloneTask, createMatter, renameMatter, deleteMatter, setMatter, setNoteRole,
    actionsOf, currentActionOf, unfinishedCountOf, addAction, editAction, setActionDone, deleteAction, setCurrentAction,
    reopenTask, editTask, setTaskDeadline,
    startClock, stopClock,
  }
})
