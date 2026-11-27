// 5A-0 §10.2 / §12 A17：真实 ZIP 备份往返（多天安排 + 全状态 + 多段已结束会话 + 历史断引用）。
// 走现有真实路径：db 种子 → readWorkspaceSnapshot → buildBackup（真实编码+压缩前校验）→
//   inspectBackupFile（真实受限解码+三层校验）→ prepareRestore（全量 ID 重建+引用重写+恢复准备）→
//   commitRestore（四 store 原子提交到新空间）。不仅 JSON 拷贝。
// 断言：PlanItem↔FocusSession 双向关联重建、原任务截止不变、历史状态/成果不丢、多段用时汇总一致、
//   原空间逐字段不变、回执不作业务恢复对象、plan_ops 不进备份、未结束会话恢复后暂停不自动计时。
// 全部虚构数据（无真实校名/姓名/群号）；合法完整样本（脏样本诊断另测，不放宽备份校验）。
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBackup } from '@/services/backup/export'
import { inspectBackupFile, prepareRestore } from '@/services/backup/import'
import { sha256Hex } from '@/services/backup/format'
import { runId, opsId, sessId, planOpsId } from '@/services/focus/runtime'
import { summarizePlanTime } from '@/domains/plan'
import { PNG_BYTES } from './backupFixtures'

const SRC = 'ws-plan-src'
const TARGET = 'ws-plan-restore'
const T = (s) => s
let db

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('@/services/storage/db')
})

const snapTask = (over = {}) => ({ title: '完成实验报告', matter_name: '实验报告', deadline_value: '2026-11-27', deadline_precision: 'date', captured_at: T('2026-11-21T10:00:00+08:00'), ...over })
const snapAction = (text, minutes) => ({ text, minutes, captured_at: T('2026-11-21T10:00:00+08:00') })
// v1 已结束会话工厂（含快照/引用状态）。
const ended = (id, { task = 'task-1', action = 'action-1', plan = null, ms, at, outcome = 'partial', text = '撰写报告正文', minutes = 60, taskSnap, refDeleted = false }) => ({
  id, kind: 'focus_session', workspace_id: SRC, task_id: task, action_id: action, plan_item_id: plan,
  started_at: T('2026-11-21T10:00:00+08:00'), accumulated_ms: ms, running: false, draft_md: '工作成果正文',
  outcome, blocker: null, ended_at: T(at), is_demo: false, record_version: 1, timer_anchor_at: null,
  task_snapshot: taskSnap || snapTask(), action_snapshot: snapAction(text, minutes),
  task_ref_state: refDeleted ? 'deleted' : 'active', action_ref_state: refDeleted ? 'deleted' : 'active',
})
const planItem = (id, over = {}) => ({
  id, kind: 'plan_item', workspace_id: SRC, task_id: 'task-1', date: '2026-11-23', planned_minutes: 60,
  action_text: '撰写报告正文', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over,
})

//  plan-rich 虚构空间：同任务三天安排 + 无截止任务 + 全状态 + 已删任务历史 + 多段已结束 + 快捷引用 + 一个暂停。
function seedDocs() {
  const noteFields = [
    { key: 'deadline', value: '2026-11-27', raw: '本周五前', origin: 'model', status: 'confirmed', derived: false, quote: { text: '本周五前提交', source_id: 'src-img' }, precision: 'date', tz_known: false },
    { key: 'time_nodes', value: [{ label: '提交截止', raw: '本周五前', value: '2026-11-27', precision: 'date', tz_known: false, basis: 'explicit', role: 'submission_deadline', reference_at: null, reference_source: null, message_date: '2026-11-20', derived: false }], raw: '', origin: 'model', status: 'confirmed', derived: false, quote: null },
  ]
  return [
    { id: 'note-1', kind: 'note', workspace_id: SRC, source_id: 'src-img', status: 'reviewed', content_type: 'notice', title: '实验报告提交通知', fields: noteFields, matter_id: 'matter-1', matter_role: 'requirement', created_at: T('2026-11-20T09:10:00+08:00'), updated_at: T('2026-11-20T09:20:00+08:00'), reviewed_at: T('2026-11-20T09:20:00+08:00'), is_demo: false, warnings: [] },
    { id: 'matter-1', kind: 'matter', workspace_id: SRC, title: '实验报告', note_ids: ['note-1'], created_at: T('2026-11-20T09:15:00+08:00'), is_demo: false },
    { id: 'task-1', kind: 'task', workspace_id: SRC, title: '完成实验报告', description: '', matter_id: 'matter-1', note_ids: ['note-1'], deadline: { value: '2026-11-27', precision: 'date', source: 'note', from_note_id: 'note-1', confirmed_at: T('2026-11-20T09:25:00+08:00') }, status: 'todo', completion_criteria: null, current_action_id: 'action-1', created_at: T('2026-11-20T09:30:00+08:00'), updated_at: T('2026-11-20T09:30:00+08:00'), is_demo: false },
    { id: 'task-2', kind: 'task', workspace_id: SRC, title: '无截止的整理任务', description: '', matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' }, status: 'todo', completion_criteria: null, current_action_id: null, created_at: T('2026-11-20T09:30:00+08:00'), updated_at: T('2026-11-20T09:30:00+08:00'), is_demo: false },
    { id: 'action-1', kind: 'action', workspace_id: SRC, task_id: 'task-1', text: '撰写报告正文', minutes: 60, basis: 'user', done: false, created_at: T('2026-11-20T09:31:00+08:00') },
    { id: 'action-2', kind: 'action', workspace_id: SRC, task_id: 'task-1', text: '检查字数与格式', minutes: 20, basis: 'suggestion', done: false, created_at: T('2026-11-20T09:32:00+08:00') },
    { id: 'action-3', kind: 'action', workspace_id: SRC, task_id: 'task-2', text: '整理资料', minutes: 40, basis: 'user', done: false, created_at: T('2026-11-20T09:33:00+08:00') },
    // 同任务三天安排（partial/planned/done），一个总截止。
    planItem('plan-d1', { date: '2026-11-23', planned_minutes: 60, state: 'partial', actual_minutes: 40, focus_session_id: 'focus-e1b', order: 0 }),
    planItem('plan-d2', { date: '2026-11-24', planned_minutes: 45, state: 'planned', order: 0 }),
    planItem('plan-d3', { date: '2026-11-25', planned_minutes: 30, state: 'done', actual_minutes: 25, focus_session_id: 'focus-e2', order: 0 }),
    planItem('plan-cancel', { date: '2026-11-23', planned_minutes: 20, state: 'cancelled', order: 1 }),
    planItem('plan-moved', { date: '2026-11-22', planned_minutes: 15, state: 'moved', order: 0 }),
    // 无截止任务的安排。
    planItem('plan-nd', { task_id: 'task-2', date: '2026-11-24', planned_minutes: 40, action_text: '整理资料', order: 0 }),
    // 已删任务的历史安排（断引用，成果闭合）。
    planItem('plan-del', { task_id: 'task-gone', date: '2026-11-20', planned_minutes: 50, state: 'done', actual_minutes: 10, focus_session_id: 'focus-deleted', order: 0, task_ref_state: 'deleted' }),
    // 旧/导入 planned 已有结束会话（只读标记需核对）。
    planItem('plan-progress', { date: '2026-11-26', planned_minutes: 30, state: 'planned', order: 0 }),
    // 多段已结束会话（plan-d1 两段：30min + 10min = 40min）。
    ended('focus-e1', { plan: 'plan-d1', ms: 1800000, at: '2026-11-23T10:30:00+08:00' }),
    ended('focus-e1b', { plan: 'plan-d1', ms: 600000, at: '2026-11-23T11:00:00+08:00' }),
    ended('focus-e2', { plan: 'plan-d3', action: 'action-2', ms: 1500000, at: '2026-11-25T10:00:00+08:00', outcome: 'done', text: '检查字数与格式', minutes: 20 }),
    ended('focus-e3', { plan: 'plan-progress', ms: 600000, at: '2026-11-26T09:00:00+08:00' }),
    ended('focus-deleted', { task: 'task-gone', action: 'action-gone', plan: 'plan-del', ms: 600000, at: '2026-11-20T10:00:00+08:00', outcome: 'done', refDeleted: true, taskSnap: snapTask({ title: '旧任务', matter_name: null, deadline_value: null, deadline_precision: 'none' }) }),
    // 唯一未结束（暂停）会话：恢复后应暂停待核对，不自动计时。
    { id: 'focus-paused', kind: 'focus_session', workspace_id: SRC, task_id: 'task-2', action_id: 'action-3', plan_item_id: 'plan-nd', started_at: T('2026-11-22T09:00:00+08:00'), accumulated_ms: 300000, running: false, draft_md: '整理中', outcome: null, blocker: null, ended_at: null, is_demo: false, record_version: 1, timer_anchor_at: null, task_snapshot: snapTask({ title: '无截止的整理任务', matter_name: null, deadline_value: null, deadline_precision: 'none', captured_at: T('2026-11-22T09:00:00+08:00') }), action_snapshot: snapAction('整理资料', 40), task_ref_state: 'active', action_ref_state: 'active' },
  ]
}

async function seed() {
  db.configureWorkspace(SRC)
  await db.putWorkspace({ id: SRC, name: '虚构计划来源空间', is_demo: false })
  await db.putSource({ id: 'src-img', kind: 'image', captured_at: T('2026-11-20T09:00:00+08:00'), name: '通知截图.png', blob: new Blob([PNG_BYTES], { type: 'image/png' }), is_demo: false })
  await db.putSource({ id: 'src-txt', kind: 'text', captured_at: T('2026-11-20T09:05:00+08:00'), text: '请在本周五前提交实验报告。', is_demo: false })
  for (const d of seedDocs()) await db.putDoc(d)
}
const fileOf = (bytes) => new File([bytes], '虚构计划备份.zip', { type: 'application/zip' })

// 真实导出 → 真实解码校验 → 冻结准备（确定性 newId）。
async function exportAndPrepare(target = TARGET, op = 'op-plan-1') {
  const snapshot = await db.readWorkspaceSnapshot(SRC)
  const built = await buildBackup(snapshot, { backupId: 'bk-plan-0001', exportedAt: T('2026-11-22T15:30:00+08:00'), instant: new Date(T('2026-11-22T15:30:00+08:00')) })
  const ins = await inspectBackupFile(fileOf(built.zipBytes))
  expect(ins.ok).toBe(true) // 真实导出+解码+三层校验通过（plan 数据被现有备份路径完整接受）
  let c = 0
  const prep = prepareRestore({ inspected: ins, targetWorkspaceId: target, targetName: '计划恢复空间', operationId: op, nowMs: 1_800_000_000_000, createdAt: T('2026-11-22T16:00:00+08:00'), newId: () => `np-${++c}` })
  return { built, ins, prep }
}
const newDocs = async (prep) => { db.configureWorkspace(prep.targetWorkspaceId); return (await db.allDocs()).records }
const byNew = (docs, prep, oldId) => docs.find((d) => d.id === (prep.liveMap.get(oldId) || prep.historyMap.get(oldId)))

describe('A17 真实 ZIP 往返：多天安排完整保留', () => {
  it('真实导出接受 plan-rich 数据，恢复后计划条数/状态/日期/估时/顺序全保留', async () => {
    await seed()
    const { prep } = await exportAndPrepare()
    const result = await db.commitRestore(prep)
    expect(result.alreadyCommitted).toBe(false)
    const docs = await newDocs(prep)
    const origPlans = seedDocs().filter((d) => d.kind === 'plan_item')
    const restoredPlans = docs.filter((d) => d.kind === 'plan_item')
    expect(restoredPlans).toHaveLength(origPlans.length)
    for (const op of origPlans) {
      const np = byNew(docs, prep, op.id)
      expect(np).toBeTruthy()
      expect(np.state).toBe(op.state)
      expect(np.date).toBe(op.date)
      expect(np.planned_minutes).toBe(op.planned_minutes)
      expect(np.action_text).toBe(op.action_text)
      expect(np.actual_minutes).toBe(op.actual_minutes)
      expect(np.order).toBe(op.order)
      expect(np.task_ref_state).toBe(op.task_ref_state)
      expect(np.workspace_id).toBe(TARGET)
      expect(np.is_demo).toBeUndefined() // PlanItem 契约无 is_demo
    }
  })
  it('PlanItem↔FocusSession 双向关联按新 ID 重建（含快捷引用与多段会话）', async () => {
    await seed()
    const { prep } = await exportAndPrepare()
    await db.commitRestore(prep)
    const docs = await newDocs(prep)
    // 每个 plan.focus_session_id 指向的会话，其 plan_item_id 必须回指该 plan（双向闭合）。
    for (const op of seedDocs().filter((d) => d.kind === 'plan_item' && d.focus_session_id)) {
      const np = byNew(docs, prep, op.id)
      const ns = docs.find((d) => d.id === np.focus_session_id)
      expect(ns).toBeTruthy()
      expect(ns.kind).toBe('focus_session')
      expect(ns.plan_item_id).toBe(np.id)
      expect(ns.task_id).toBe(np.task_id)
      expect(ns.ended_at).not.toBeNull()
      expect(np.focus_session_id).toBe(prep.liveMap.get(op.focus_session_id))
    }
    // 会话侧 plan_item_id 也正确重写（focus-e1/e1b → plan-d1）。
    const nd1 = byNew(docs, prep, 'plan-d1')
    const e1 = docs.find((d) => d.id === prep.liveMap.get('focus-e1'))
    const e1b = docs.find((d) => d.id === prep.liveMap.get('focus-e1b'))
    expect(e1.plan_item_id).toBe(nd1.id)
    expect(e1b.plan_item_id).toBe(nd1.id)
    // 已删任务历史：plan-del.task_id 与 focus-deleted.task_id 映射到同一隔离历史标识（非活对象）。
    const ndel = byNew(docs, prep, 'plan-del')
    const ndelS = docs.find((d) => d.id === prep.liveMap.get('focus-deleted'))
    expect(ndel.task_ref_state).toBe('deleted')
    expect(ndel.task_id).toBe(prep.historyMap.get('task-gone'))
    expect(ndelS.task_id).toBe(ndel.task_id)
    expect(docs.some((d) => d.id === ndel.task_id && d.kind === 'task')).toBe(false) // 不伪造活任务
  })
  it('原任务总截止不变；多段已结束用时汇总一致（40min，最近 focus-e1b）', async () => {
    await seed()
    const { prep } = await exportAndPrepare()
    await db.commitRestore(prep)
    const docs = await newDocs(prep)
    const nt1 = byNew(docs, prep, 'task-1')
    expect(nt1.deadline.value).toBe('2026-11-27') // 三天安排不改总截止
    expect(nt1.deadline.precision).toBe('date')
    const nd1 = byNew(docs, prep, 'plan-d1')
    const summary = summarizePlanTime(nd1, docs)
    expect(summary.endedSessionCount).toBe(2)
    expect(summary.totalMs).toBe(2400000)
    expect(summary.actualMinutes).toBe(40)
    expect(summary.latestEndedSessionId).toBe(prep.liveMap.get('focus-e1b'))
    expect(summary.problems).toEqual([])
    // 成果正文保留。
    expect(docs.find((d) => d.id === prep.liveMap.get('focus-e1')).draft_md).toBe('工作成果正文')
  })
  it('原空间逐字段 + 原图字节完全不变（独立 oracle）', async () => {
    await seed()
    const before = await db.readWorkspaceSnapshot(SRC)
    const beforeDocs = JSON.stringify(before.docs)
    const beforeImg = await sha256Hex(new Uint8Array(await before.sources.find((s) => s.id === 'src-img').blob.arrayBuffer()))
    const { prep } = await exportAndPrepare()
    await db.commitRestore(prep)
    const after = await db.readWorkspaceSnapshot(SRC)
    expect(JSON.stringify(after.docs)).toBe(beforeDocs)
    expect(after.sources.map((s) => s.id).sort()).toEqual(before.sources.map((s) => s.id).sort())
    const afterImg = await sha256Hex(new Uint8Array(await after.sources.find((s) => s.id === 'src-img').blob.arrayBuffer()))
    expect(afterImg).toBe(beforeImg)
    // 目录只新增一个恢复空间，原空间记录不变。
    const all = await db.allWorkspaces()
    expect(all.find((w) => w.id === SRC).name).toBe('虚构计划来源空间')
    expect(all.filter((w) => w.restore_receipt)).toHaveLength(1)
  })
  it('回执不作业务恢复对象；plan_ops 不进备份；恢复空间无 plan_ops 台账', async () => {
    await seed()
    // 先在原空间制造一条 plan_ops 本地回执（模拟安排服务曾运行），证明它不被导出。
    db.configureWorkspace(SRC)
    const { makePlanOpsRecord, appendOps } = await import('@/services/focus/runtime')
    const opsRec = appendOps(makePlanOpsRecord(SRC), { request_id: 'r1', op: 'create', workspace_id: SRC, plan_item_id: 'plan-d2', input_sig: 'sig', at_ms: 1_800_000_000_000, issued_at_ms: 1_800_000_000_000, result: { ok: true } }, 1_800_000_000_000, 600000)
    // 直接写一条 runtime（仅测试脚手架；生产由服务事务写）。
    await db.transformFocusAtomic(() => ({ puts: [], deletes: [], runtimePuts: [opsRec], runtimeDeletes: [], info: {} }))
    const { built, prep } = await exportAndPrepare()
    // 导出 ZIP 的 docs 不含任何 runtime/回执；manifest counts 只业务 kind。
    expect(built.manifest.counts.plan_ops).toBeUndefined()
    expect(built.summary.counts.focus_session).toBeGreaterThan(0)
    await db.commitRestore(prep)
    db.configureWorkspace(TARGET)
    const rt = (await db.allFocusRuntime()).records.filter((r) => r.workspace_id === TARGET)
    expect(rt.some((r) => r.id === planOpsId(TARGET))).toBe(false) // 恢复不重建 plan_ops
    expect(rt.some((r) => r.id === runId(TARGET))).toBe(true)
    expect(rt.some((r) => r.id === opsId(TARGET))).toBe(true)
    // 目录回执是元数据，不是 docs 业务对象。
    const docs = (await db.allDocs()).records
    expect(docs.some((d) => d.kind === 'restore_receipt' || d.restore_receipt)).toBe(false)
    const ws = await db.getWorkspace(TARGET)
    expect(ws.restore_receipt.operation_id).toBe('op-plan-1')
  })
  it('未结束（暂停）会话恢复后暂停待核对，不自动启动计时', async () => {
    await seed()
    const { prep } = await exportAndPrepare()
    await db.commitRestore(prep)
    const docs = await newDocs(prep)
    const paused = docs.find((d) => d.id === prep.liveMap.get('focus-paused'))
    expect(paused.running).toBe(false)
    expect(paused.ended_at).toBeNull()
    expect(paused.timer_anchor_at).toBeNull()
    expect(paused.accumulated_ms).toBe(300000) // 已存累计保留
    expect(prep.unfinishedV1).toContain(prep.liveMap.get('focus-paused'))
    db.configureWorkspace(TARGET)
    const rt = (await db.allFocusRuntime()).records
    const sessRt = rt.find((r) => r.id === sessId(paused.id))
    expect(sessRt).toBeTruthy()
    expect(sessRt.lease_expires_at).toBeLessThan(1_800_000_000_000) // 过期：须 takeover+recover
    expect(sessRt.recovery).toBeNull()
    const run = rt.find((r) => r.id === runId(TARGET))
    expect(run.session_id).toBeNull() // 不占全局运行位
  })
  it('同意图重试幂等：返回原恢复空间不重写（计划仍一份）', async () => {
    await seed()
    const { prep } = await exportAndPrepare()
    const first = await db.commitRestore(prep)
    const second = await db.commitRestore(prep)
    expect(first.alreadyCommitted).toBe(false)
    expect(second.alreadyCommitted).toBe(true)
    const docs = await newDocs(prep)
    expect(docs.filter((d) => d.kind === 'plan_item')).toHaveLength(seedDocs().filter((d) => d.kind === 'plan_item').length)
  })
})