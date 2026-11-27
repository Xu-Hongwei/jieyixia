// 执行页编辑控制（按 workspaceId + sessionId 隔离）：文本、输入版本、已确认保存版本、
// 在途操作、错误与可重试信封。唯一已保存事实来自 IndexedDB（focus service）；
// 跨组件卸载的未提交文本只留在本页面生命周期的会话级内存草稿里，不宣称已持久保存。
// 信封协议：每次新编辑操作 issueRequest 取一次并显式映射 requestId/issuedAtMs；
// 失败重试复用原信封与提交内容；绝不给未知旧 ID 补当前时间。
import { computed, onScopeDispose, ref, watch } from 'vue'

const memory = new Map()
const memKey = (ws, sid) => `${ws}:${sid}`
export function forgetWorkDraft(ws, sid) {
  memory.delete(memKey(ws, sid))
}
export function forgetWorkspaceDrafts(ws) {
  for (const key of memory.keys()) if (key.startsWith(ws + ':')) memory.delete(key)
}

const EXPIRED_CODES = ['STALE_REQUEST', 'REQUEST_ENVELOPE_REQUIRED']
const BLOCKED_CODES = ['OWNER_CONFLICT', 'RECOVERY_REQUIRED', 'LEGACY_RECOVERY_REQUIRED', 'ALREADY_ENDED', 'WORKSPACE_CHANGED']

export function useWorkDraft({ app, focus, sessionId, session, rt, editable }) {
  const initialClearRevision = app.clearRevision
  const text = ref('')
  const inputVersion = ref(0)
  const savedVersion = ref(0)
  const savedText = ref('')
  const baseRevision = ref(null)
  // dirty / saving / saved / error 四态；error.kind: retry(可原信封重试) / expired(信封失效) / conflict(需核对) / blocked(失去所有权等)
  const saveState = ref('saved')
  const error = ref(null)
  const retryEnv = ref(null)
  const conflict = ref(false)
  const frozen = ref(false)
  const dirty = computed(() => inputVersion.value > savedVersion.value)

  let debounce = null
  let chain = Promise.resolve()
  let submitting = false
  let autoRetryUsed = false
  let loadedKey = null

  const key = () => memKey(app.workspaceId, sessionId.value)
  function persistMemory() {
    memory.set(key(), {
      text: text.value, inputVersion: inputVersion.value, savedVersion: savedVersion.value,
      savedText: savedText.value, baseRevision: baseRevision.value,
    })
  }

  // 以数据库事实为基线装载；页面内存草稿只在「保存基线仍一致」时续用。
  // 数据库正文已被外部改写而本地还有未保存输入 → 保留本地文本进入核对，不静默覆盖。
  function loadFromDb() {
    const s = session.value
    if (!s) return
    const k = key()
    const mem = memory.get(k)
    const dbText = s.draft_md || ''
    savedText.value = dbText
    baseRevision.value = rt.value ? rt.value.revision : null
    error.value = null
    retryEnv.value = null
    autoRetryUsed = false
    if (mem && mem.savedText === dbText) {
      text.value = mem.text
      inputVersion.value = mem.inputVersion
      savedVersion.value = mem.savedVersion
      conflict.value = false
    } else if (mem && mem.inputVersion > mem.savedVersion && mem.text !== dbText) {
      text.value = mem.text
      inputVersion.value = mem.inputVersion
      savedVersion.value = mem.savedVersion
      conflict.value = true
    } else {
      text.value = dbText
      inputVersion.value = 0
      savedVersion.value = 0
      conflict.value = false
    }
    saveState.value = dirty.value ? 'dirty' : 'saved'
    loadedKey = k
    persistMemory()
    if (dirty.value && editable.value && !conflict.value) schedule()
  }

  function schedule() {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      if (editable.value && !conflict.value && !frozen.value && dirty.value) submit()
    }, 1000)
  }

  // 用户输入：版本递增；新编辑取代旧的可重试提交（旧信封内容已是旧版）。
  function onInput(value) {
    text.value = value
    inputVersion.value += 1
    saveState.value = 'dirty'
    retryEnv.value = null
    if (error.value && error.value.kind === 'retry') error.value = null
    persistMemory()
    if (!frozen.value) schedule()
  }

  function handleFailure(result, ctx) {
    const code = result.code || 'SAVE_FAILED'
    if (EXPIRED_CODES.includes(code)) {
      error.value = { kind: 'expired', code, message: '本次请求已失效，请核对当前记录后重新提交' }
      retryEnv.value = null
      focus.loadWorkspace()
    } else if (code === 'STALE_REVISION') {
      // 检查点也会推进 revision：数据库正文仍等于本地保存基线 → 内容无冲突，
      // 允许一次带新信封的自动重提；正文已被外部改写 → 显式核对，不盲目提交旧正文。
      const s = session.value
      const contentUnchanged = s && (s.draft_md || '') === savedText.value
      if (contentUnchanged && !autoRetryUsed && editable.value) {
        autoRetryUsed = true
        baseRevision.value = result.currentRevision != null ? result.currentRevision : (rt.value ? rt.value.revision : baseRevision.value)
        saveState.value = 'dirty'
        schedule()
        return
      }
      conflict.value = true
      error.value = { kind: 'conflict', code, message: '保存基线已过期：其它页面可能改写了正文，请核对后选择保留哪个版本' }
      retryEnv.value = null
    } else if (BLOCKED_CODES.includes(code)) {
      error.value = { kind: 'blocked', code, message: result.message || '会话状态已变化，停止自动保存，请核对当前状态' }
      retryEnv.value = null
      focus.loadWorkspace()
    } else {
      error.value = { kind: 'retry', code, message: result.message || '保存失败，输入保留，可重试' }
      retryEnv.value = { requestId: ctx.requestId, issuedAtMs: ctx.issuedAtMs, text: ctx.submittedText, version: ctx.version }
    }
    saveState.value = 'error'
    persistMemory()
  }

  async function doSubmit(override) {
    const sid = sessionId.value
    const ws = app.workspaceId
    if (!session.value || !sid || (!override && (!editable.value || conflict.value || frozen.value))) {
      return { ok: false, skipped: true }
    }
    if (!override && inputVersion.value <= savedVersion.value) return { ok: true, nothing: true }
    const submittedText = override ? override.text : text.value
    const version = override ? override.version : inputVersion.value
    const requestId = override ? override.requestId : null
    const issuedAtMs = override ? override.issuedAtMs : null
    let env = null
    if (!override) {
      const issued = focus.issueRequest('saveDraft', { sessionId: sid })
      env = { requestId: issued.request_id, issuedAtMs: issued.issued_at_ms }
    }
    const rid = override ? requestId : env.requestId
    const stamp = override ? issuedAtMs : env.issuedAtMs
    saveState.value = 'saving'
    submitting = true
    let result
    try {
      result = await focus.saveDraft({
        sessionId: sid, draftMd: submittedText,
        expectedRevision: baseRevision.value != null ? baseRevision.value : undefined,
        requestId: rid, issuedAtMs: stamp,
      })
    } finally {
      submitting = false
    }
    // 身份守卫：操作期间切了空间/会话 → 结果不应用到当前编辑器。
    if (sessionId.value !== sid || app.workspaceId !== ws) return result
    if (result.ok) {
      savedText.value = submittedText
      savedVersion.value = version
      if (result.revision != null) baseRevision.value = result.revision
      error.value = null
      retryEnv.value = null
      autoRetryUsed = false
      conflict.value = false
      saveState.value = inputVersion.value === version ? 'saved' : 'dirty'
      persistMemory()
      if (inputVersion.value > version && !frozen.value) schedule()
    } else {
      handleFailure(result, { submittedText, version, requestId: rid, issuedAtMs: stamp })
    }
    return result
  }

  function submit(override) {
    const run = chain.catch(() => {}).then(() => doSubmit(override))
    chain = run.catch(() => {})
    return run
  }

  // 失败重试：原信封 + 原提交内容（正文若已更新，onInput 已清掉 retryEnv，走新编辑）。
  function retry() {
    const r = retryEnv.value
    if (!r || !editable.value || frozen.value) return Promise.resolve({ ok: false, skipped: true })
    return submit({ text: r.text, version: r.version, requestId: r.requestId, issuedAtMs: r.issuedAtMs })
  }

  // 信封失效后：用户核对当前记录，明确重新保存（新意图新信封）。
  function resaveNow() {
    if (!editable.value || frozen.value) return Promise.resolve({ ok: false, skipped: true })
    error.value = null
    saveState.value = 'dirty'
    return submit()
  }

  // 核对冲突：显式采用本地版本（基于当前 revision 的新编辑操作）。
  function adoptLocal() {
    if (!rt.value) return Promise.resolve({ ok: false })
    baseRevision.value = rt.value.revision
    conflict.value = false
    error.value = null
    saveState.value = 'dirty'
    return submit()
  }
  // 核对冲突：采用数据库已保存版本，放弃本地未保存输入（用户显式选择）。
  function adoptSaved() {
    const s = session.value
    if (!s) return
    text.value = s.draft_md || ''
    savedText.value = text.value
    inputVersion.value = 0
    savedVersion.value = 0
    baseRevision.value = rt.value ? rt.value.revision : null
    conflict.value = false
    error.value = null
    retryEnv.value = null
    saveState.value = 'saved'
    persistMemory()
  }

  // 暂停/继续/结束/离开主操作同事务合并了最终正文：成功后同步保存基线，
  // 避免协调 watch 把自家落库误判为外部改写。
  function markOpSaved(submittedText, version, revision) {
    savedText.value = submittedText
    savedVersion.value = version
    if (revision != null) baseRevision.value = revision
    error.value = null
    retryEnv.value = null
    conflict.value = false
    autoRetryUsed = false
    saveState.value = inputVersion.value === version ? 'saved' : 'dirty'
    persistMemory()
    if (dirty.value && !frozen.value) schedule()
  }

  // 主操作收到 STALE_REVISION 且正文确被外部改写：进入显式核对。
  function flagConflict(message) {
    conflict.value = true
    saveState.value = 'error'
    error.value = { kind: 'conflict', code: 'STALE_REVISION', message }
    retryEnv.value = null
    persistMemory()
  }

  // 暂停/继续/结束/离开前：停自动保存并等既有写入串行完成；最终正文由调用方随主操作同事务提交。
  async function settle() {
    if (debounce) {
      clearTimeout(debounce)
      debounce = null
    }
    await chain.catch(() => {})
  }

  // 协调事实变化：正文仍等于本地保存基线 → 跟进 revision（检查点/续租）；
  // 正文被外部改写 → 进入核对并停自动保存。自身提交在途时不做冲突判定（避免把自家落库误判为外部改写）。
  watch([rt, session], ([r, s]) => {
    if (!r || !s || loadedKey !== key()) return
    if ((s.draft_md || '') === savedText.value) {
      if (baseRevision.value == null || r.revision > baseRevision.value) baseRevision.value = r.revision
    } else if (!submitting) {
      conflict.value = true
      if (debounce) {
        clearTimeout(debounce)
        debounce = null
      }
      if (saveState.value !== 'error') {
        saveState.value = 'error'
        error.value = { kind: 'conflict', code: 'EXTERNAL_CHANGE', message: '其它页面改写了正文，请核对后选择保留哪个版本' }
      }
    }
  })

  watch(key, () => {
    loadedKey = null
    if (debounce) {
      clearTimeout(debounce)
      debounce = null
    }
    if (session.value) loadFromDb()
  })

  onScopeDispose(() => {
    if (debounce) clearTimeout(debounce)
    if (loadedKey === key() && initialClearRevision === app.clearRevision) persistMemory()
  })

  return {
    text, inputVersion, savedVersion, savedText, baseRevision,
    saveState, error, retryEnv, conflict, frozen, dirty,
    loadFromDb, onInput, submit, retry, resaveNow, adoptLocal, adoptSaved, settle, markOpSaved, flagConflict,
    forget: () => forgetWorkDraft(app.workspaceId, sessionId.value),
  }
}
