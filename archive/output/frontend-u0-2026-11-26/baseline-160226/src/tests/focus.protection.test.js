// S6：未结束会话（运行/暂停/v0）的删除与完成保护 + 已结束会话逐引用断开/恢复补丁。
// 域层显式传 sessions；store 层走真实 fake-IDB 事务：保护整体回滚、补丁落库、撤销回补与拒绝。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '../stores/app'
import { allDocs, clearWorkspace, putDoc, transformFocusAtomic } from '../services/storage/db'
import { beginPlan, endPlan, pausePlan } from '../domains/focus'
import { cascadeDeleteNotePlan, deleteTaskPlan, finishTaskPlan, undoDeletePlan } from '../domains/matter'
import { deleteActionPlan, setActionDonePlan } from '../domains/action'

const T0 = '2026-11-20T10:00:00+08:00'
const at = (ms) => new Date(Date.parse(T0) + ms).toISOString()
const env = (over = {}) => ({ ws: 'w1', wallNow: T0, ownerId: 'tab-1', newId: () => 's-new', ...over })
const task = (over = {}) => ({
  id: 't1', kind: 'task', workspace_id: 'w1', title: '写课程报告', status: 'todo',
  current_action_id: null, matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' },
  created_at: T0, updated_at: T0, is_demo: false, ...over,
})
const action = (over = {}) => ({
  id: 'a1', kind: 'action', workspace_id: 'w1', task_id: 't1', text: '写引言一节',
  minutes: 30, basis: 'user', done: false, created_at: T0, ...over,
})
const note = (over = {}) => ({
  id: 'n1', kind: 'note', workspace_id: 'w1', title: '截图便签', status: 'confirmed',
  fields: [], warnings: [], matter_id: null, matter_role: null, ...over,
})
const v0Session = (over = {}) => ({
  id: 'old-1', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1',
  started_at: T0, accumulated_ms: 60000, running: true, draft_md: '旧草稿',
  outcome: null, blocker: null, ended_at: null, is_demo: false, ...over,
})

function apply(docs, plan) {
  const del = new Set(plan.deletes)
  const next = docs.filter((r) => !del.has(r.id))
  for (const p of plan.puts) {
    const i = next.findIndex((r) => r.id === p.id)
    if (i >= 0) next[i] = p
    else next.push(p)
  }
  return next
}
function merge(docs, runtime, plan) {
  const m = (rows, puts = [], deletes = []) => {
    const del = new Set(deletes)
    const next = rows.filter((r) => !del.has(r.id))
    for (const p of puts) {
      const i = next.findIndex((r) => r.id === p.id)
      if (i >= 0) next[i] = p
      else next.push(p)
    }
    return next
  }
  return { docs: m(docs, plan.puts, plan.deletes), runtime: m(runtime, plan.runtimePuts, plan.runtimeDeletes) }
}
const codeOf = (fn) => {
  try { fn(); return null } catch (err) { return err.code || 'NO_CODE' }
}

// 标准开局：begin 后的 docs/runtime（含运行中会话）；ended 再走 endPlan（partial，不动行动完成态）。
function begun(extra = []) {
  const docs = [task(), action(), ...extra]
  return merge(docs, [], beginPlan(docs, [], env(), { taskId: 't1', actionId: 'a1' }))
}
function ended(extra = []) {
  const st = begun(extra)
  const s = st.docs.find((d) => d.kind === 'focus_session')
  return merge(st.docs, st.runtime, endPlan(st.docs, st.runtime, env({ wallNow: at(10_000) }), {
    sessionId: s.id, epoch: 1, outcome: 'partial', draftSeq: 1, draftMd: '最终草稿',
  }))
}
const sessionOf = (docs) => docs.find((d) => d.kind === 'focus_session')

describe('S6 域层：未结束会话保护（运行/暂停/v0）', () => {
  it('运行中会话：删任务/删行动/完成行动/完成任务/联删便签全部 RELATION_INVALID', () => {
    const docs = begun([note()]).docs.map((d) => (d.id === 't1' ? { ...d, note_ids: ['n1'] } : d))
    const sessions = [sessionOf(docs)]
    expect(codeOf(() => deleteTaskPlan(docs, 't1', sessions))).toBe('RELATION_INVALID')
    expect(codeOf(() => deleteActionPlan(docs, 'a1', T0, sessions))).toBe('RELATION_INVALID')
    expect(codeOf(() => setActionDonePlan(docs, 'a1', true, T0, sessions))).toBe('RELATION_INVALID')
    expect(codeOf(() => finishTaskPlan(docs, 't1', T0, sessions))).toBe('RELATION_INVALID')
    expect(codeOf(() => cascadeDeleteNotePlan(docs, 'n1', sessions))).toBe('RELATION_INVALID')
  })
  it('暂停会话同样算未结束：保护不放宽', () => {
    const st = begun()
    const s = sessionOf(st.docs)
    const paused = merge(st.docs, st.runtime, pausePlan(st.docs, st.runtime, env({ wallNow: at(5000) }), { sessionId: s.id, epoch: 1 })).docs
    const sessions = [sessionOf(paused)]
    expect(sessions[0].running).toBe(false)
    expect(sessions[0].ended_at).toBeNull()
    expect(codeOf(() => deleteTaskPlan(paused, 't1', sessions))).toBe('RELATION_INVALID')
    expect(codeOf(() => finishTaskPlan(paused, 't1', T0, sessions))).toBe('RELATION_INVALID')
    expect(codeOf(() => setActionDonePlan(paused, 'a1', true, T0, sessions))).toBe('RELATION_INVALID')
  })
  it('v0 旧版未结束会话也挡删除/完成', () => {
    const docs = [task(), action(), v0Session()]
    const sessions = [v0Session()]
    expect(codeOf(() => deleteTaskPlan(docs, 't1', sessions))).toBe('RELATION_INVALID')
    expect(codeOf(() => deleteActionPlan(docs, 'a1', T0, sessions))).toBe('RELATION_INVALID')
    expect(codeOf(() => finishTaskPlan(docs, 't1', T0, sessions))).toBe('RELATION_INVALID')
  })
  it('重新打开行动（done=false）不受保护限制；无关任务/行动的会话不误伤', () => {
    const docs = begun().docs
    const sessions = [sessionOf(docs)]
    expect(setActionDonePlan(docs, 'a1', false, T0, sessions).puts.length).toBeGreaterThan(0)
    const other = [task({ id: 't2' }), action({ id: 'a2', task_id: 't2' }), ...sessions]
    expect(deleteTaskPlan(other, 't2', sessions).deletes).toEqual(['t2', 'a2'])
    expect(finishTaskPlan(other, 't2', T0, sessions).info.task.status).toBe('done')
  })
  it('完成任务：无会话正常 done；已 done 幂等 unchanged', () => {
    const docs = [task(), action()]
    expect(finishTaskPlan(docs, 't1', T0).info.task.status).toBe('done')
    const done = [task({ status: 'done' }), action()]
    const r = finishTaskPlan(done, 't1', T0)
    expect(r.puts).toEqual([])
    expect(r.info.unchanged).toBe(true)
  })
})

describe('S6 域层：已结束会话逐引用断开与恢复', () => {
  it('删任务：task 与 action 引用都置 deleted，正文/累计/快照不动，补丁记录 from/to', () => {
    const docs = ended().docs
    const before = sessionOf(docs)
    const r = deleteTaskPlan(docs, 't1', [before])
    expect(r.deletes).toEqual(['t1', 'a1'])
    const after = apply(docs, r).find((d) => d.id === before.id)
    expect(after.task_ref_state).toBe('deleted')
    expect(after.action_ref_state).toBe('deleted')
    expect(after.draft_md).toBe('最终草稿')
    expect(after.accumulated_ms).toBe(before.accumulated_ms)
    expect(after.task_snapshot).toEqual(before.task_snapshot)
    expect(after.action_snapshot).toEqual(before.action_snapshot)
    expect(r.info.sessionPatches).toEqual([{
      session_id: before.id,
      ended_at: before.ended_at,
      changes: {
        task_ref_state: { from: 'active', to: 'deleted' },
        action_ref_state: { from: 'active', to: 'deleted' },
      },
    }])
  })
  it('单删行动：只断 action 引用，task 引用保持 active', () => {
    const docs = ended().docs
    const r = deleteActionPlan(docs, 'a1', T0, [sessionOf(docs)])
    const after = apply(docs, r).find((d) => d.kind === 'focus_session')
    expect(after.action_ref_state).toBe('deleted')
    expect(after.task_ref_state).toBe('active')
    expect(Object.keys(r.info.sessionPatches[0].changes)).toEqual(['action_ref_state'])
  })
  it('联删便签：命中任务的 task/action 引用一并断开', () => {
    const docs = ended([note()]).docs.map((d) => (d.id === 't1' ? { ...d, note_ids: ['n1'] } : d))
    const r = cascadeDeleteNotePlan(docs, 'n1', [sessionOf(docs)])
    expect(r.deletes).toEqual(['n1', 't1', 'a1'])
    const after = apply(docs, r).find((d) => d.kind === 'focus_session')
    expect(after.task_ref_state).toBe('deleted')
    expect(after.action_ref_state).toBe('deleted')
    expect(r.info.sessionPatches.length).toBe(1)
  })
  it('撤销删除：对象恢复且字段仍是 deleted、ended_at 未变 → 引用回补 active', () => {
    const docs = ended().docs
    const del = deleteTaskPlan(docs, 't1', [sessionOf(docs)])
    const after = apply(docs, del)
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions, sessionPatches: del.info.sessionPatches }
    const r = undoDeletePlan(after, last, T0)
    const next = apply(after, r)
    const s = next.find((d) => d.kind === 'focus_session')
    expect(s.task_ref_state).toBe('active')
    expect(s.action_ref_state).toBe('active')
    expect(r.info.sessionRefs.applied.length).toBe(2)
    expect(r.info.sessionRefs.refused).toEqual([])
  })
  it('撤销拒绝：会话 ended_at 已变 → 整体保持 deleted，不覆盖历史', () => {
    const docs = ended().docs
    const del = deleteTaskPlan(docs, 't1', [sessionOf(docs)])
    let after = apply(docs, del)
    after = after.map((d) => (d.kind === 'focus_session' ? { ...d, ended_at: at(99_000) } : d))
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions, sessionPatches: del.info.sessionPatches }
    const r = undoDeletePlan(after, last, T0)
    const next = apply(after, r)
    const s = next.find((d) => d.kind === 'focus_session')
    expect(s.task_ref_state).toBe('deleted')
    expect(s.action_ref_state).toBe('deleted')
    expect(r.info.sessionRefs.applied).toEqual([])
    expect(r.info.sessionRefs.refused.some((x) => x.reason === 'changed')).toBe(true)
    expect(next.some((d) => d.id === 't1')).toBe(true)
  })
  it('撤销拒绝：字段已不是 deleted（被其它流程改过）→ 该字段不回补', () => {
    const docs = ended().docs
    const del = deleteActionPlan(docs, 'a1', T0, [sessionOf(docs)])
    let after = apply(docs, del)
    after = after.map((d) => (d.kind === 'focus_session' ? { ...d, action_ref_state: 'active' } : d))
    const last = { kind: 'action', action: del.info.action, wasCurrent: false, sessionPatches: del.info.sessionPatches }
    const r = undoDeletePlan(after, last, T0)
    expect(r.info.sessionRefs.applied).toEqual([])
    expect(r.info.sessionRefs.refused.some((x) => x.reason === 'changed')).toBe(true)
  })
  it('撤销拒绝：补丁引用的对象不在本次恢复范围（仍缺失）→ 保持 deleted', () => {
    const docs = ended().docs
    const del = deleteTaskPlan(docs, 't1', [sessionOf(docs)])
    const after = apply(docs, del)
    const patch = del.info.sessionPatches[0]
    const onlyAction = {
      session_id: patch.session_id,
      ended_at: patch.ended_at,
      changes: { action_ref_state: patch.changes.action_ref_state },
    }
    const last = { kind: 'task', task: del.info.task, actions: [], sessionPatches: [onlyAction] }
    const r = undoDeletePlan(after, last, T0)
    const next = apply(after, r)
    const s = next.find((d) => d.kind === 'focus_session')
    expect(s.action_ref_state).toBe('deleted')
    expect(r.info.sessionRefs.refused.some((x) => x.reason === 'still_missing')).toBe(true)
  })
  it('无补丁的旧撤销记录照常恢复（向后兼容）', () => {
    const docs = [task(), action()]
    const del = deleteTaskPlan(docs, 't1')
    const after = apply(docs, del)
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions }
    const r = undoDeletePlan(after, last, T0)
    expect(r.info.sessionRefs).toBeNull()
    expect(apply(after, r).some((d) => d.id === 't1')).toBe(true)
  })
})

// —— store 层：真实事务保护与补丁（fake-IDB，personal 空间）——
// 每个用例前清空 personal：上一用例留下的未结束会话不得挡住本用例的 begin。

beforeEach(async () => {
  setActivePinia(createPinia())
  await clearWorkspace('personal')
})

const WALL = '2026-11-20T10:00:00+08:00'
async function seedSession(taskId, actionId, opts = {}) {
  const e = { ws: 'personal', wallNow: WALL, ownerId: 'tab-test' }
  const res = await transformFocusAtomic((latest, runtime) => beginPlan(latest, runtime, e, { taskId, actionId }))
  const sid = res.info.session.id
  if (opts.pause) {
    await transformFocusAtomic((latest, runtime) =>
      pausePlan(latest, runtime, { ...e, wallNow: at(5000) }, { sessionId: sid, epoch: 1 }))
  }
  if (opts.end) {
    await transformFocusAtomic((latest, runtime) =>
      endPlan(latest, runtime, { ...e, wallNow: at(10_000) }, { sessionId: sid, epoch: 1, outcome: 'partial', draftSeq: 1, draftMd: '最终草稿' }))
  }
  return sid
}
async function makeTaskWithAction(store, title) {
  const { id } = await store.createStandaloneTask({ title })
  const task = store.tasks.find((t) => t.id === id)
  await store.addAction(task, '行动一', 30)
  return { task, act: store.actionsOf(id)[0] }
}
const docById = async (id) => (await allDocs()).records.find((d) => d.id === id)

describe('S6 store：未结束会话保护整体回滚', () => {
  it('运行中会话：删任务/完成任务/完成行动/删行动全部拒绝，记录与会话原样', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6运行保护')
    const sid = await seedSession(task.id, act.id)
    expect(await store.deleteTask(task)).toMatchObject({ ok: false, blocked: true })
    expect(await store.finishTask(task)).toMatchObject({ ok: false, blocked: true })
    expect(await store.setActionDone(act, true)).toMatchObject({ ok: false, blocked: true })
    expect(await store.deleteAction(act)).toMatchObject({ ok: false, blocked: true })
    // 统一保护对话框取代误导性「先暂停或结束」toast：workBlock 列出命中会话与运行状态。
    expect(store.workBlock).toBeTruthy()
    expect(store.workBlock.sessions.map((s) => s.id)).toContain(sid)
    expect(store.workBlock.sessions.every((s) => s.state === '运行中')).toBe(true)
    expect(await docById(task.id)).toBeTruthy()
    expect(await docById(act.id)).toBeTruthy()
    const s = await docById(sid)
    expect(s.ended_at).toBeNull()
    expect(s.task_ref_state).toBe('active')
    expect(s.action_ref_state).toBe('active')
    expect(store.lastDeleted).toBeNull()
  })
  it('暂停会话同样挡住删除与完成', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6暂停保护')
    await seedSession(task.id, act.id, { pause: true })
    expect((await store.deleteTask(task)).ok).toBe(false)
    expect((await store.finishTask(task)).ok).toBe(false)
    expect((await store.deleteAction(act)).ok).toBe(false)
    expect(store.workBlock.sessions.every((s) => s.state === '已暂停')).toBe(true)
    expect(await docById(task.id)).toBeTruthy()
  })
  it('v0 旧版未结束会话挡住删行动', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6旧版保护')
    await putDoc({
      id: `v0-${task.id}`, kind: 'focus_session', task_id: task.id, action_id: act.id,
      started_at: WALL, accumulated_ms: 60000, running: true, draft_md: '旧草稿',
      outcome: null, blocker: null, ended_at: null, is_demo: false,
    })
    expect((await store.deleteAction(act)).ok).toBe(false)
    expect((await store.deleteTask(task)).ok).toBe(false)
    expect(store.workBlock.sessions.every((s) => s.state === '旧版未结束')).toBe(true)
    expect(await docById(act.id)).toBeTruthy()
  })
  it('联删便签：关联任务有运行中会话 → 便签与任务都不动', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6联删保护')
    const noteId = `note-${task.id}`
    await putDoc({ id: noteId, kind: 'note', title: '截图便签', status: 'confirmed', fields: [], warnings: [] })
    await transformFocusAtomic((latest) => ({
      puts: latest.filter((d) => d.id === task.id).map((d) => ({ ...d, note_ids: [noteId] })),
      deletes: [],
    }))
    await store.reload()
    const sid = await seedSession(task.id, act.id)
    const n = store.notes.find((x) => x.id === noteId)
    expect(await store.deleteNote(n)).toMatchObject({ ok: false, blocked: true })
    expect(await docById(noteId)).toBeTruthy()
    expect(await docById(task.id)).toBeTruthy()
    expect(store.workBlock).toBeTruthy()
    expect(store.workBlock.sessions.map((s) => s.id)).toContain(sid)
  })
})

describe('S6 store：已结束会话引用断开与撤销回补', () => {
  it('删任务：会话双引用置 deleted；撤销后对象与引用都恢复', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6结束删任务')
    const sid = await seedSession(task.id, act.id, { end: true })
    expect((await store.deleteTask(task)).ok).toBe(true)
    let s = await docById(sid)
    expect(s.task_ref_state).toBe('deleted')
    expect(s.action_ref_state).toBe('deleted')
    expect(s.draft_md).toBe('最终草稿')
    expect(store.lastDeleted.sessionPatches.length).toBe(1)
    expect((await store.undoDelete()).ok).toBe(true)
    s = await docById(sid)
    expect(s.task_ref_state).toBe('active')
    expect(s.action_ref_state).toBe('active')
    expect(await docById(task.id)).toBeTruthy()
    expect(await docById(act.id)).toBeTruthy()
  })
  it('单删行动：只断 action 引用；撤销只回补该引用', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6结束删行动')
    const sid = await seedSession(task.id, act.id, { end: true })
    expect((await store.deleteAction(act)).ok).toBe(true)
    let s = await docById(sid)
    expect(s.action_ref_state).toBe('deleted')
    expect(s.task_ref_state).toBe('active')
    expect((await store.undoDelete()).ok).toBe(true)
    s = await docById(sid)
    expect(s.action_ref_state).toBe('active')
    expect(s.task_ref_state).toBe('active')
  })
  it('联删便签（会话已结束）：便签/任务/行动删除且引用断开；撤销全量恢复', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6结束联删')
    const noteId = `note-${task.id}`
    await putDoc({ id: noteId, kind: 'note', title: '截图便签', status: 'confirmed', fields: [], warnings: [] })
    await transformFocusAtomic((latest) => ({
      puts: latest.filter((d) => d.id === task.id).map((d) => ({ ...d, note_ids: [noteId] })),
      deletes: [],
    }))
    await store.reload()
    const sid = await seedSession(task.id, act.id, { end: true })
    const n = store.notes.find((x) => x.id === noteId)
    expect((await store.deleteNote(n)).ok).toBe(true)
    let s = await docById(sid)
    expect(s.task_ref_state).toBe('deleted')
    expect(s.action_ref_state).toBe('deleted')
    expect((await store.undoDelete()).ok).toBe(true)
    s = await docById(sid)
    expect(s.task_ref_state).toBe('active')
    expect(s.action_ref_state).toBe('active')
    expect(await docById(noteId)).toBeTruthy()
    expect(await docById(task.id)).toBeTruthy()
  })
  it('撤销时会话已有新版本（ended_at 变化）：对象恢复但引用保持断开并提示', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6撤销拒绝')
    const sid = await seedSession(task.id, act.id, { end: true })
    expect((await store.deleteTask(task)).ok).toBe(true)
    const s = await docById(sid)
    await putDoc({ ...s, ended_at: at(99_000) })
    expect((await store.undoDelete()).ok).toBe(true)
    const after = await docById(sid)
    expect(after.task_ref_state).toBe('deleted')
    expect(after.action_ref_state).toBe('deleted')
    expect(await docById(task.id)).toBeTruthy()
    expect(store.banner.msg).toContain('引用未回补')
  })
  it('完成任务（无会话）照常；有运行会话时拒绝且状态不变', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'S6完成保护')
    await seedSession(task.id, act.id)
    expect((await store.finishTask(task)).ok).toBe(false)
    expect((await docById(task.id)).status).not.toBe('done')
    await transformFocusAtomic((latest, runtime) =>
      endPlan(latest, runtime, { ws: 'personal', wallNow: at(10_000), ownerId: 'tab-test' },
        { sessionId: (latest.find((d) => d.kind === 'focus_session' && d.task_id === task.id)).id, epoch: 1, outcome: 'partial', draftSeq: 1, draftMd: '稿' }))
    expect((await store.finishTask(task)).ok).toBe(true)
    expect((await docById(task.id)).status).toBe('done')
  })
})

describe('B3-3 域层：确认范围兜底（SCOPE_CHANGED）', () => {
  it('联删便签：确认后最新集合新增关联任务 → 拒绝旧确认；范围一致正常删除', () => {
    const base = [note(), task({ note_ids: ['n1'] }), action()]
    const expected = { taskIds: ['t1'], actionIds: ['a1'] }
    const latest = [...base, task({ id: 't2', note_ids: ['n1'] }), action({ id: 'a2', task_id: 't2' })]
    expect(codeOf(() => cascadeDeleteNotePlan(latest, 'n1', [], expected))).toBe('SCOPE_CHANGED')
    const plan = cascadeDeleteNotePlan(base, 'n1', [], expected)
    expect(plan.deletes).toContain('n1')
    expect(plan.deletes).toContain('t1')
    expect(plan.deletes).not.toContain('t2')
  })
  it('删任务：确认后最新集合新增行动 → SCOPE_CHANGED；范围一致正常', () => {
    const base = [task(), action()]
    const expected = { taskIds: ['t1'], actionIds: ['a1'] }
    const latest = [...base, action({ id: 'a2' })]
    expect(codeOf(() => deleteTaskPlan(latest, 't1', [], expected))).toBe('SCOPE_CHANGED')
    expect(deleteTaskPlan(base, 't1', [], expected).deletes).toEqual(['t1', 'a1'])
  })
  it('不传 expectedScope → 不做范围比对（向后兼容）', () => {
    const latest = [task(), action(), action({ id: 'a2' })]
    expect(deleteTaskPlan(latest, 't1').deletes).toEqual(['t1', 'a1', 'a2'])
  })
})

describe('B3-3 store：确认范围变化拒绝旧确认（X14）', () => {
  it('删任务：捕获确认后新增行动 → scopeChanged 不删；用最新范围重新确认成功', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'B3范围任务')
    const staleScope = { taskIds: [task.id], actionIds: [act.id] }
    // 另一页面在确认之后给该任务新增行动（直接落库）
    await store.addAction(task, '行动二', 20)
    const r = await store.deleteTask(task, staleScope)
    expect(r).toMatchObject({ ok: false, scopeChanged: true })
    expect(await docById(task.id)).toBeTruthy()
    expect(await docById(act.id)).toBeTruthy()
    expect(store.lastDeleted).toBeNull()
    const freshScope = { taskIds: [task.id], actionIds: store.actionsOf(task.id).map((a) => a.id) }
    expect((await store.deleteTask(task, freshScope)).ok).toBe(true)
    expect(await docById(task.id)).toBeFalsy()
  })
  it('联删便签：捕获确认后新增关联任务 → scopeChanged，便签与新旧任务都不动', async () => {
    const store = useAppStore()
    await store.init()
    const { task, act } = await makeTaskWithAction(store, 'B3联删范围')
    const noteId = `note-${task.id}`
    await putDoc({ id: noteId, kind: 'note', title: '截图便签', status: 'confirmed', fields: [], warnings: [] })
    await transformFocusAtomic((latest) => ({
      puts: latest.filter((d) => d.id === task.id).map((d) => ({ ...d, note_ids: [noteId] })),
      deletes: [],
    }))
    await store.reload()
    const n = store.notes.find((x) => x.id === noteId)
    const staleScope = { taskIds: [task.id], actionIds: [act.id] }
    const { id: t2id } = await store.createStandaloneTask({ title: 'B3新关联任务' })
    await transformFocusAtomic((latest) => ({
      puts: latest.filter((d) => d.id === t2id).map((d) => ({ ...d, note_ids: [noteId] })),
      deletes: [],
    }))
    const r = await store.deleteNote(n, staleScope)
    expect(r).toMatchObject({ ok: false, scopeChanged: true })
    expect(await docById(noteId)).toBeTruthy()
    expect(await docById(task.id)).toBeTruthy()
    expect(await docById(t2id)).toBeTruthy()
    expect(store.lastDeleted).toBeNull()
  })
})