// 执行页编辑控制器：防抖自动保存、信封显式映射与失败重试复用、迟到回调不覆盖新输入、
// STALE_REVISION 内容未变自动重提一次/已变显式核对、失去所有权停写、会话级内存按 ws+sid 隔离。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref } from 'vue'
import { forgetWorkDraft, useWorkDraft } from '@/composables/useWorkDraft'

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

function setup({ dbText = '', revision = 1, ws = 'personal', sid = 's1' } = {}) {
  const app = reactive({ workspaceId: ws })
  const sessionId = ref(sid)
  const session = ref({ id: sid, kind: 'focus_session', draft_md: dbText, ended_at: null, running: true, accumulated_ms: 0 })
  const rt = ref({ session_id: sid, revision, draft_seq: 0, recovery: null })
  const editable = ref(true)
  let seq = 0
  const focus = {
    issueRequest: vi.fn((op, input) => ({ request_id: `req-${++seq}`, issued_at_ms: 1000 + seq, op, workspace_id: app.workspaceId, session_id: input.sessionId ?? null })),
    // 默认成功：模拟服务落库后 store 重读（正文与 revision 同步前进）。
    saveDraft: vi.fn(async (input) => {
      rt.value = { ...rt.value, revision: rt.value.revision + 1, draft_seq: rt.value.draft_seq + 1 }
      session.value = { ...session.value, draft_md: input.draftMd }
      return { ok: true, revision: rt.value.revision, request_id: input.requestId, issued_at_ms: input.issuedAtMs }
    }),
    loadWorkspace: vi.fn(async () => ({ stale: false })),
  }
  const scope = effectScope()
  const draft = scope.run(() => useWorkDraft({ app, focus, sessionId, session, rt, editable }))
  draft.loadFromDb()
  return { app, sessionId, session, rt, editable, focus, scope, draft }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useWorkDraft 自动保存与信封', () => {
  it('停止输入约 1 秒自动保存：issueRequest 一次并显式映射 requestId/issuedAtMs/expectedRevision', async () => {
    const h = setup({ sid: 'env' })
    h.draft.onInput('第一段成果')
    expect(h.focus.saveDraft).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.focus.issueRequest).toHaveBeenCalledTimes(1)
    expect(h.focus.saveDraft).toHaveBeenCalledTimes(1)
    const arg = h.focus.saveDraft.mock.calls[0][0]
    expect(arg).toMatchObject({ sessionId: 'env', draftMd: '第一段成果', requestId: 'req-1', issuedAtMs: 1001, expectedRevision: 1 })
    expect(h.draft.saveState.value).toBe('saved')
    expect(h.draft.dirty.value).toBe(false)
    h.scope.stop()
    forgetWorkDraft('personal', 'env')
  })

  it('保存期间继续输入：迟到成功回调只确认已提交版本，不覆盖新输入，随后再保存', async () => {
    const h = setup({ sid: 'late' })
    let resolveSave
    h.focus.saveDraft.mockImplementationOnce(() => new Promise((r) => { resolveSave = r }))
    h.draft.onInput('A')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.focus.saveDraft).toHaveBeenCalledTimes(1)
    h.draft.onInput('AB') // 在途期间的新输入
    resolveSave({ ok: true, revision: 2 })
    await flush()
    expect(h.draft.text.value).toBe('AB')
    expect(h.draft.savedText.value).toBe('A')
    expect(h.draft.dirty.value).toBe(true)
    expect(h.draft.saveState.value).toBe('dirty')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.focus.saveDraft).toHaveBeenCalledTimes(2)
    expect(h.focus.saveDraft.mock.calls[1][0].draftMd).toBe('AB')
    h.scope.stop()
    forgetWorkDraft('personal', 'late')
  })

  it('普通失败：输入保留，retry 复用原信封与原提交内容', async () => {
    const h = setup({ sid: 'retry' })
    h.focus.saveDraft.mockResolvedValueOnce({ ok: false, code: 'SAVE_FAILED', message: '写入失败' })
    h.draft.onInput('保住我')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.draft.saveState.value).toBe('error')
    expect(h.draft.error.value.kind).toBe('retry')
    expect(h.draft.text.value).toBe('保住我')
    expect(h.draft.retryEnv.value).toMatchObject({ requestId: 'req-1', issuedAtMs: 1001, text: '保住我' })
    await h.draft.retry()
    const arg = h.focus.saveDraft.mock.calls[1][0]
    expect(arg).toMatchObject({ requestId: 'req-1', issuedAtMs: 1001, draftMd: '保住我' })
    expect(h.draft.saveState.value).toBe('saved')
    h.scope.stop()
    forgetWorkDraft('personal', 'retry')
  })

  it('失败后用户再编辑 = 新意图：清掉旧信封，自动保存用新信封提交新正文', async () => {
    const h = setup({ sid: 'newop' })
    h.focus.saveDraft.mockResolvedValueOnce({ ok: false, code: 'SAVE_FAILED' })
    h.draft.onInput('旧')
    await vi.advanceTimersByTimeAsync(1000)
    h.draft.onInput('旧+新')
    expect(h.draft.retryEnv.value).toBeNull()
    expect(h.draft.error.value).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.focus.saveDraft.mock.calls[1][0]).toMatchObject({ requestId: 'req-2', draftMd: '旧+新' })
    h.scope.stop()
    forgetWorkDraft('personal', 'newop')
  })

  it('STALE_REQUEST：信封失效不自动重试，读实际状态；用户显式重新保存才发新信封', async () => {
    const h = setup({ sid: 'expired' })
    h.focus.saveDraft.mockResolvedValueOnce({ ok: false, code: 'STALE_REQUEST' })
    h.draft.onInput('x')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.draft.error.value.kind).toBe('expired')
    expect(h.draft.retryEnv.value).toBeNull()
    expect(h.focus.loadWorkspace).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.focus.saveDraft).toHaveBeenCalledTimes(1) // 无无限自动重试
    await h.draft.resaveNow()
    expect(h.focus.saveDraft.mock.calls[1][0].requestId).toBe('req-2')
    h.scope.stop()
    forgetWorkDraft('personal', 'expired')
  })
})

describe('useWorkDraft 修订冲突', () => {
  it('STALE_REVISION 且正文未变（检查点推进）：自动带新信封重提一次；再失败进入核对', async () => {
    const h = setup({ sid: 'stale1' })
    h.focus.saveDraft.mockResolvedValueOnce({ ok: false, code: 'STALE_REVISION', currentRevision: 5 })
    h.draft.onInput('内容')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.draft.conflict.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.focus.saveDraft).toHaveBeenCalledTimes(2)
    expect(h.focus.saveDraft.mock.calls[1][0]).toMatchObject({ expectedRevision: 5, requestId: 'req-2', draftMd: '内容' })
    h.scope.stop()
    forgetWorkDraft('personal', 'stale1')
  })

  it('STALE_REVISION 且正文已被外部改写：不盲目重提旧正文，显式核对；adoptLocal 基于当前修订提交', async () => {
    const h = setup({ sid: 'stale2' })
    h.focus.saveDraft.mockImplementationOnce(async () => {
      h.session.value = { ...h.session.value, draft_md: '别的页面写的' }
      h.rt.value = { ...h.rt.value, revision: 9 }
      return { ok: false, code: 'STALE_REVISION', currentRevision: 9 }
    })
    h.draft.onInput('我的输入')
    await vi.advanceTimersByTimeAsync(1000)
    await nextTick()
    expect(h.draft.conflict.value).toBe(true)
    expect(h.draft.text.value).toBe('我的输入')
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.focus.saveDraft).toHaveBeenCalledTimes(1) // 冲突期间不自动写
    await h.draft.adoptLocal()
    expect(h.focus.saveDraft.mock.calls[1][0]).toMatchObject({ expectedRevision: 9, draftMd: '我的输入' })
    expect(h.draft.conflict.value).toBe(false)
    h.scope.stop()
    forgetWorkDraft('personal', 'stale2')
  })

  it('adoptSaved：显式采用数据库版本，放弃本地未保存输入', async () => {
    const h = setup({ sid: 'adopt', dbText: '库里已有' })
    h.draft.onInput('本地改的')
    h.session.value = { ...h.session.value, draft_md: '外部新版' }
    h.rt.value = { ...h.rt.value, revision: 4 }
    await nextTick()
    expect(h.draft.conflict.value).toBe(true)
    h.draft.adoptSaved()
    expect(h.draft.text.value).toBe('外部新版')
    expect(h.draft.dirty.value).toBe(false)
    expect(h.draft.conflict.value).toBe(false)
    h.scope.stop()
    forgetWorkDraft('personal', 'adopt')
  })

  it('OWNER_CONFLICT：停止自动保存并读实际状态；不可编辑时输入不再触发写入', async () => {
    const h = setup({ sid: 'owner' })
    h.focus.saveDraft.mockResolvedValueOnce({ ok: false, code: 'OWNER_CONFLICT', message: '已被接管' })
    h.draft.onInput('x')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.draft.error.value.kind).toBe('blocked')
    expect(h.focus.loadWorkspace).toHaveBeenCalled()
    h.editable.value = false // 页面据协调事实转为只读
    h.draft.onInput('xy')
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.focus.saveDraft).toHaveBeenCalledTimes(1)
    expect(h.draft.text.value).toBe('xy')
    h.scope.stop()
    forgetWorkDraft('personal', 'owner')
  })

  it('markOpSaved：主操作同事务落库后同步基线，协调重读不误判为外部改写', async () => {
    const h = setup({ sid: 'opmerge' })
    h.draft.onInput('随暂停提交')
    await h.draft.settle()
    h.draft.markOpSaved('随暂停提交', h.draft.inputVersion.value, 7)
    h.session.value = { ...h.session.value, draft_md: '随暂停提交', running: false }
    h.rt.value = { ...h.rt.value, revision: 7 }
    await nextTick()
    expect(h.draft.conflict.value).toBe(false)
    expect(h.draft.saveState.value).toBe('saved')
    h.scope.stop()
    forgetWorkDraft('personal', 'opmerge')
  })

  it('settle：取消待发自动保存并等待在途写入完成', async () => {
    const h = setup({ sid: 'settle' })
    h.draft.onInput('待结算')
    await h.draft.settle()
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.focus.saveDraft).not.toHaveBeenCalled()
    h.scope.stop()
    forgetWorkDraft('personal', 'settle')
  })
})

describe('useWorkDraft 会话级内存隔离', () => {
  it('卸载保留未保存文本；同 ws+sid 回来续用，不同会话不串文本', async () => {
    const h1 = setup({ sid: 'memA' })
    h1.editable.value = false
    h1.draft.onInput('没来得及保存')
    h1.scope.stop() // 卸载：仅内存保留，不宣称已持久化
    const h2 = setup({ sid: 'memA' })
    expect(h2.draft.text.value).toBe('没来得及保存')
    expect(h2.draft.dirty.value).toBe(true)
    h2.scope.stop()
    const h3 = setup({ sid: 'memB' })
    expect(h3.draft.text.value).toBe('')
    h3.scope.stop()
    forgetWorkDraft('personal', 'memA')
    forgetWorkDraft('personal', 'memB')
  })

  it('外部已改写且本地有脏输入：回来保留本地文本进入核对，不静默覆盖', async () => {
    const h1 = setup({ sid: 'memC' })
    h1.editable.value = false
    h1.draft.onInput('本地脏文本')
    h1.scope.stop()
    const h2 = setup({ sid: 'memC', dbText: '数据库新正文', revision: 3 })
    expect(h2.draft.conflict.value).toBe(true)
    expect(h2.draft.text.value).toBe('本地脏文本')
    expect(h2.draft.savedText.value).toBe('数据库新正文')
    h2.scope.stop()
    forgetWorkDraft('personal', 'memC')
  })

  it('在途保存时切空间：迟到结果不应用到当前编辑器', async () => {
    const h = setup({ sid: 'wsguard' })
    let resolveSave
    h.focus.saveDraft.mockImplementationOnce(() => new Promise((r) => { resolveSave = r }))
    h.draft.onInput('旧空间的输入')
    await vi.advanceTimersByTimeAsync(1000)
    h.app.workspaceId = 'demo' // 切换：key watch 重置并按新空间装载
    await nextTick()
    resolveSave({ ok: true, revision: 2 })
    await flush()
    expect(h.draft.savedText.value).toBe('')
    expect(h.draft.text.value).toBe('')
    h.scope.stop()
    forgetWorkDraft('personal', 'wsguard')
    forgetWorkDraft('demo', 'wsguard')
  })
})