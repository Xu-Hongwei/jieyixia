// 契约 Matter 关系的本地维护（纯函数事务计划，不触库）：
// 旧 group/group_id 幂等迁移、便签联删、事项归组双向一致、冲突感知恢复。
// 每个 plan 接收事务内读到的最新 docs，返回 { puts, deletes, info }；抛错即整体回滚。
import { linkedTasksOf } from './organize'
import { assertNoUnfinishedSession, refDeletePatches, refRestorePatches } from './focus'

export const MATTER_ROLES = ['requirement', 'supplement', 'reference', 'outcome', 'other']

// 无截止任务映射契约允许的空 Deadline 形状（precision=none 时 value 必须为空），不用 null 偏离契约。
export function normalizeDeadline(dl) {
  if (!dl) return { value: null, precision: 'none' }
  if (dl.value == null) {
    if (dl.precision === 'none') return dl
    return { ...dl, value: null, precision: 'none' }
  }
  return dl
}

const isMember = (d) => d.kind === 'note' || d.kind === 'task'

// 计划条目活引用闭合（契约 0.4.0 models.py:800 / generate.py:246）+ 真实 Focus 引用保护（5A-0 §10.1）：
// 删任务时——planned 且无任何 Focus 引用 → 随任务移除（撤销快照保留）；planned 但已有结束会话 →
// 拒绝整个删除 PLAN_PROGRESS_REQUIRED（返回需确认进度的安排 ID，不生成悬空引用）；有未结束会话 → 拒绝
// （不把暂停视为已结束，上游 assertNoUnfinishedSession 已按 task/action 拦，这里再按 plan_item_id 兜底）；
// partial/done/cancelled/moved 历史 → 保留 PlanItem 并按契约断 Task 引用（task_ref_state=deleted），会话成果继续闭合。
// 不重算/不重排计划、不新增计划状态。历史保护在事务内对最新事实实施，旧调用未传 sessions 时退化为原行为（无会话即无保护命中）。
function planRefDelete(latest, taskIds, sessions = []) {
  const t = new Set(taskIds)
  const items = latest.filter((d) => d.kind === 'plan_item' && t.has(d.task_id))
  const sessByPlan = new Map()
  for (const s of sessions) {
    if (!s || s.kind !== 'focus_session' || !s.plan_item_id) continue
    const list = sessByPlan.get(s.plan_item_id) || []
    list.push(s)
    sessByPlan.set(s.plan_item_id, list)
  }
  const unfinished = []
  const progressRequired = []
  for (const d of items) {
    const ss = sessByPlan.get(d.id) || []
    if (ss.some((s) => s.ended_at == null)) unfinished.push(d.id)
    else if (d.state === 'planned' && ss.some((s) => s.ended_at != null)) progressRequired.push(d.id)
  }
  if (unfinished.length) {
    throw Object.assign(new Error('该任务的安排有未结束的工作会话（含暂停），请先处理后再删除'), { code: 'UNFINISHED_FOCUS', planItemIds: unfinished })
  }
  if (progressRequired.length) {
    throw Object.assign(new Error('该任务有已执行但尚未确认进度的安排，请先核对进度（partial/done/cancelled）后再删除'), { code: 'PLAN_PROGRESS_REQUIRED', planItemIds: progressRequired })
  }
  const puts = []
  const deletes = []
  const removed = []
  const detached = []
  for (const d of items) {
    if (d.state === 'planned') {
      deletes.push(d.id)
      removed.push(d)
    } else if (d.task_ref_state !== 'deleted') {
      puts.push({ ...d, task_ref_state: 'deleted' })
      detached.push({ id: d.id, from: d.task_ref_state || 'active' })
    }
  }
  return { puts, deletes, removed, detached }
}

// 确认范围兜底（3B-3 X14 + 5A-0 R2）：确认时捕获的影响集合与事务内最新集合不一致 → 拒绝旧确认，
// 由调用端刷新影响后重新确认，绝不删除用户未看到的新关联对象。只比对 ID 集合与计划处置事实，不增契约字段。
const sameIds = (a, b) => {
  const sa = new Set(a || [])
  const sb = new Set(b || [])
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}
const scopeChanged = (detail) => Object.assign(
  new Error('删除范围已变化（其它页面新增或移除了关联对象/安排），请重新核对影响后再确认'),
  { code: 'SCOPE_CHANGED', ...(detail || {}) },
)
function assertScope(expected, actual) {
  if (!expected) return
  if (!sameIds(expected.taskIds, actual.taskIds) || !sameIds(expected.actionIds, actual.actionIds)) throw scopeChanged()
  // 计划影响快照（新调用主动提交时必须比较；旧调用未传则跳过比较，但事务内实际历史保护照常实施）。
  const actualPlanIds = actual.planItems.map((p) => p.id)
  if (Array.isArray(expected.planItemIds) && !sameIds(expected.planItemIds, actualPlanIds)) {
    throw scopeChanged({ planItemIds: actualPlanIds, confirmedPlanItemIds: expected.planItemIds })
  }
  if (Array.isArray(expected.planFacts)) {
    const got = expected.planFacts
      .map((p) => ({ id: p.id, state: p.state, taskRefState: p.taskRefState ?? 'active', disposition: p.disposition }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    if (JSON.stringify(got) !== JSON.stringify(actual.planItems)) {
      throw scopeChanged({ planItems: actual.planItems, confirmedPlanItems: got })
    }
  }
}

// 计划影响快照（供确认 UI 展示与回传）：受影响安排的 ID + 会改变删除/保留方式的状态/引用事实。
// disposition 与 planRefDelete 的实际处置一一对应：blocked_unfinished/blocked_progress 拒整个删除，
// remove 随任务移除，detach 断引用保留，keep 已是断引用历史不再改动。按 ID 稳定排序。
export function planDeleteScope(latest, taskIds, sessions = []) {
  const t = new Set(taskIds)
  const sessByPlan = new Map()
  for (const s of sessions) {
    if (!s || s.kind !== 'focus_session' || !s.plan_item_id) continue
    const list = sessByPlan.get(s.plan_item_id) || []
    list.push(s)
    sessByPlan.set(s.plan_item_id, list)
  }
  return latest
    .filter((d) => d.kind === 'plan_item' && t.has(d.task_id))
    .map((d) => {
      const ss = sessByPlan.get(d.id) || []
      const disposition = ss.some((s) => s.ended_at == null) ? 'blocked_unfinished'
        : d.state === 'planned' && ss.some((s) => s.ended_at != null) ? 'blocked_progress'
          : d.state === 'planned' ? 'remove'
            : d.task_ref_state === 'deleted' ? 'keep' : 'detach'
      return { id: d.id, state: d.state, taskRefState: d.task_ref_state || 'active', disposition }
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

// 删除确认展示快照（5A-1 §10）：打开确认框时冻结一次；处置判定单一来源 planDeleteScope，
// rows 只补展示字段（日期/说明/未结束会话 ID），不引入第二套规则。提交时回传原 planItemIds/planFacts。
export function deleteImpactSnapshot(latest, taskIds, sessions = []) {
  const facts = planDeleteScope(latest, taskIds, sessions)
  const byId = new Map(latest.filter((d) => d.kind === 'plan_item').map((d) => [d.id, d]))
  const rows = facts.map((f) => {
    const p = byId.get(f.id)
    const unfinished = sessions.find((s) => s && s.kind === 'focus_session' && s.plan_item_id === f.id && s.ended_at == null)
    return { ...f, date: p ? p.date : '', text: p ? p.action_text : '', unfinishedSessionId: unfinished ? unfinished.id : null }
  })
  return { planItemIds: facts.map((f) => f.id), planFacts: facts, rows }
}

// 幂等迁移：kind=group → kind=matter（沿用原 id，title 取 name），成员 group_id → matter_id，
// matter.note_ids 由便签归属回填，未归组便签清空资料角色，旧 deadline:null 归一为契约形状。
// 已是新结构时 puts/deletes 均为空，不产生写入，可重复执行。
export function migratePlan(latest) {
  const puts = []
  const deletes = []
  const matters = new Map()
  // action/focus_session/plan_item 等记录不在迁移范围内：原样保留，绝不删除历史。
  const actionsById = new Map()
  for (const d of latest) if (d.kind === 'action') actionsById.set(d.id, d)
  for (const d of latest) {
    if (d.kind === 'matter') {
      matters.set(d.id, { ...d, title: d.title || d.name || '未命名事项', note_ids: [...(d.note_ids || [])] })
    } else if (d.kind === 'group') {
      matters.set(d.id, {
        id: d.id,
        kind: 'matter',
        title: d.title || d.name || '未命名事项',
        note_ids: [],
        created_at: d.created_at,
        is_demo: !!d.is_demo,
      })
      deletes.push(d.id)
    }
  }
  const noteIdsByMatter = new Map()
  for (const d of latest) {
    if (!isMember(d)) continue
    const draft = { ...d }
    let changed = false
    if ('group_id' in draft) {
      const gid = draft.group_id
      delete draft.group_id
      changed = true
      if (gid && !draft.matter_id) draft.matter_id = gid
    }
    if (!('matter_id' in draft)) {
      draft.matter_id = null
      changed = true
    }
    if (draft.matter_id && !matters.has(draft.matter_id)) {
      draft.matter_id = null
      changed = true
    }
    if (draft.kind === 'note') {
      const role = draft.matter_role == null ? null : draft.matter_role
      const want = draft.matter_id && MATTER_ROLES.includes(role) ? role : null
      if (role !== want || !('matter_role' in draft)) {
        draft.matter_role = want
        changed = true
      }
      if (draft.matter_id) {
        const list = noteIdsByMatter.get(draft.matter_id) || []
        if (!list.includes(draft.id)) list.push(draft.id)
        noteIdsByMatter.set(draft.matter_id, list)
      }
    } else {
      const nd = normalizeDeadline(draft.deadline)
      if (nd !== draft.deadline) {
        draft.deadline = nd
        changed = true
      }
      // 当前行动引用必须指向本任务未完成的行动；悬空/已完成/跨任务引用幂等清空。
      if (draft.current_action_id) {
        const a = actionsById.get(draft.current_action_id)
        if (!a || a.task_id !== d.id || a.done) {
          draft.current_action_id = null
          changed = true
        }
      }
    }
    if (changed) puts.push(draft)
  }
  for (const [id, m] of matters) {
    const want = noteIdsByMatter.get(id) || []
    const cur = m.note_ids || []
    const kept = cur.filter((x) => want.includes(x))
    const next = [...kept, ...want.filter((x) => !kept.includes(x))]
    const changed = next.length !== cur.length || next.some((x, i) => x !== cur[i])
    if (changed || deletes.includes(id)) {
      m.note_ids = next
      puts.push(m)
    }
  }
  return { puts, deletes, info: { migrated: deletes.length } }
}

// 联删（DECISIONS 2026-11-18 用户追加决定）：便签 + note_ids/deadline.from_note_id 命中的任务（去重）
// + 这些任务的行动，同一事务删除；事项 note_ids 同步摘除。
// 不扩散删除其它便签/事项，原始资料与专注/计划历史不动。
export function cascadeDeleteNotePlan(latest, noteId, sessions = [], expectedScope = null) {
  const note = latest.find((d) => d.id === noteId && d.kind === 'note')
  if (!note) return { puts: [], deletes: [], info: { note: null, tasks: [], actions: [] } }
  const affected = linkedTasksOf(latest.filter((d) => d.kind === 'task'), noteId)
  const taskIds = new Set(affected.map((t) => t.id))
  const actions = latest.filter((d) => d.kind === 'action' && taskIds.has(d.task_id))
  const refs = { taskIds: [...taskIds], actionIds: actions.map((a) => a.id), planItems: planDeleteScope(latest, [...taskIds], sessions) }
  assertScope(expectedScope, refs)
  assertNoUnfinishedSession(sessions, refs)
  const matterPuts = latest
    .filter((d) => d.kind === 'matter' && (d.note_ids || []).includes(noteId))
    .map((m) => ({ ...m, note_ids: m.note_ids.filter((id) => id !== noteId) }))
  const refPatches = refDeletePatches(sessions, refs)
  const planDel = planRefDelete(latest, [...taskIds], sessions)
  return {
    puts: [...matterPuts, ...refPatches.puts, ...planDel.puts],
    deletes: [noteId, ...affected.map((t) => t.id), ...actions.map((a) => a.id), ...planDel.deletes],
    info: { note, tasks: affected, actions, sessionPatches: refPatches.patches, planRemoved: planDel.removed, planDetached: planDel.detached, planScope: refs.planItems },
  }
}

// 删任务同批删除其行动（3A）；未结束专注会话（含暂停/v0）命中 → 先处理会话再删。
// 已结束会话逐引用断开（task 与相应 action），正文/累计/快照保留。
export function deleteTaskPlan(latest, taskId, sessions = [], expectedScope = null) {
  const task = latest.find((d) => d.id === taskId && d.kind === 'task')
  if (!task) return { puts: [], deletes: [], info: { task: null, actions: [] } }
  const actions = latest.filter((d) => d.kind === 'action' && d.task_id === taskId)
  const refs = { taskIds: [taskId], actionIds: actions.map((a) => a.id), planItems: planDeleteScope(latest, [taskId], sessions) }
  assertScope(expectedScope, refs)
  assertNoUnfinishedSession(sessions, refs)
  const refPatches = refDeletePatches(sessions, refs)
  const planDel = planRefDelete(latest, [taskId], sessions)
  return {
    puts: [...refPatches.puts, ...planDel.puts],
    deletes: [taskId, ...actions.map((a) => a.id), ...planDel.deletes],
    info: { task, actions, sessionPatches: refPatches.patches, planRemoved: planDel.removed, planDetached: planDel.detached, planScope: refs.planItems },
  }
}

// 完成任务：事务内读最新状态 + 未结束会话保护（3B-1 S6 从 mutateDoc 移入事务）。
export function finishTaskPlan(latest, taskId, now, sessions = []) {
  const task = latest.find((d) => d.id === taskId && d.kind === 'task')
  if (!task) return { puts: [], deletes: [], info: { task: null } }
  assertNoUnfinishedSession(sessions, { taskIds: [taskId] })
  if (task.status === 'done') return { puts: [], deletes: [], info: { task, unchanged: true } }
  const draft = { ...task, status: 'done', updated_at: now }
  return { puts: [draft], deletes: [], info: { task: draft } }
}

// 删事项（P04）：只解除归组，便签/原图/任务/专注记录保留；便签资料角色随关联清除。
export function deleteMatterPlan(latest, matterId, now) {
  const matter = latest.find((d) => d.id === matterId && d.kind === 'matter')
  if (!matter) return { puts: [], deletes: [], info: { matter: null, members: [] } }
  const members = latest.filter((d) => isMember(d) && d.matter_id === matterId)
  const puts = members.map((m) => {
    const draft = { ...m, matter_id: null, updated_at: now }
    if (draft.kind === 'note') draft.matter_role = null
    return draft
  })
  return { puts, deletes: [matterId], info: { matter, members } }
}

// 手动归组/换组/移出 + 资料角色：便签同时维护 Matter.note_ids 两侧一致（任务只持 matter_id）。
export function setMatterPlan(latest, docId, matterId, role, now) {
  const doc = latest.find((d) => d.id === docId && isMember(d))
  if (!doc) return { puts: [], deletes: [], info: { doc: null } }
  const target = matterId || null
  if (target && !latest.some((d) => d.kind === 'matter' && d.id === target)) throw new Error('目标事项不存在')
  const draft = { ...doc, matter_id: target, updated_at: now }
  if (doc.kind === 'note') {
    // role 省略 = 沿用同事项既有角色；显式 null = 用户清空角色；换组不继承旧角色。
    const keepRole = doc.matter_id === target ? doc.matter_role : null
    const want = !target ? null : role === undefined ? keepRole : MATTER_ROLES.includes(role) ? role : null
    draft.matter_role = want && MATTER_ROLES.includes(want) ? want : null
  }
  const puts = [draft]
  if (doc.kind === 'note') {
    for (const m of latest.filter((d) => d.kind === 'matter')) {
      const has = (m.note_ids || []).includes(docId)
      const want = m.id === target
      if (has === want) continue
      puts.push({ ...m, note_ids: want ? [...(m.note_ids || []), docId] : m.note_ids.filter((id) => id !== docId) })
    }
  }
  return { puts, deletes: [], info: { doc: draft } }
}

// 冲突感知恢复：只逆转本次删除（含同批删除的行动）。任一待恢复记录已存在新版本 → 明确拒绝，
// 绝不覆盖用户新事实；事项已删除则清除悬空 matter_id/matter_role（不恢复进已删事项）；
// 便签/任务引用缺失则拒绝恢复；当前行动引用只在恢复后仍有效（属于本任务且未完成）时保留。
export function undoDeletePlan(latest, last, now) {
  if (!last) throw new Error('没有可恢复的删除记录')
  const planRemoved = last.planRemoved || []
  const candidates = last.kind === 'note'
    ? [last.note, ...(last.tasks || []), ...(last.actions || []), ...planRemoved]
    : last.kind === 'action'
      ? [last.action]
      : [last.task, ...(last.actions || []), ...planRemoved]
  const present = new Map(latest.map((d) => [d.id, d]))
  const conflict = candidates.filter((c) => present.has(c.id))
  if (conflict.length) {
    throw new Error(`「${conflict.map((c) => c.title || c.text || c.action_text || c.id).join('、')}」已有新版本；为避免覆盖你的修改，本次不恢复`)
  }
  const idsAfter = new Set([...present.keys(), ...candidates.map((c) => c.id)])
  const puts = candidates.map((c) => {
    const d = { ...c }
    // planned 计划条目随任务恢复，活引用回到 active（任务已在本次恢复集合，归属/顺序不变，不重排）。
    if (d.kind === 'plan_item') {
      if (!idsAfter.has(d.task_id)) throw new Error('计划条目所属任务已不存在，无法安全恢复')
      d.task_ref_state = 'active'
      return d
    }
    if (d.kind === 'action') {
      if (!idsAfter.has(d.task_id)) throw new Error('行动所属任务已不存在，无法安全恢复；请重新创建行动')
      return d
    }
    if (d.matter_id && !idsAfter.has(d.matter_id)) d.matter_id = null
    if (d.kind === 'note') {
      if (!d.matter_id) d.matter_role = null
    } else {
      d.deadline = normalizeDeadline(d.deadline)
      if ((d.note_ids || []).some((id) => !idsAfter.has(id))) throw new Error('任务引用的便签已不存在，无法安全恢复；请重新创建任务')
      if (d.deadline.from_note_id && !idsAfter.has(d.deadline.from_note_id)) throw new Error('任务截止出处便签已不存在，无法安全恢复')
      if (d.current_action_id) {
        const a = candidates.find((x) => x.id === d.current_action_id) || present.get(d.current_action_id)
        if (!a || a.kind !== 'action' || a.task_id !== d.id || a.done) d.current_action_id = null
      }
    }
    return d
  })
  // 单独撤销行动删除：任务仍在且没有另选当前行动时，恢复本次被清空的当前选择；
  // 用户期间已另选 → 不覆盖新选择，只恢复行动本体。
  if (last.kind === 'action') {
    const a = last.action
    const task = present.get(a.task_id)
    if (!task || task.kind !== 'task') throw new Error('行动所属任务已不存在，无法安全恢复；请重新创建行动')
    if (last.wasCurrent && !a.done && task.current_action_id == null) {
      const draft = { ...task, current_action_id: a.id }
      if (now) draft.updated_at = now
      puts.push(draft)
    }
  }
  for (const d of puts) {
    if (d.kind !== 'note' || !d.matter_id) continue
    const m = present.get(d.matter_id)
    if (!m || m.kind !== 'matter' || (m.note_ids || []).includes(d.id)) continue
    const existing = puts.find((p) => p.id === m.id)
    const base = existing || { ...m }
    base.note_ids = [...(base.note_ids || []), d.id]
    if (!existing) puts.push(base)
  }
  // 会话引用补丁恢复（3B-1 S6）：对象恢复后逐条核对——字段仍是删除时置的 deleted、
  // ended_at 未变、引用对象确实回来了才回补；否则保持 deleted，不产生新悬空活引用。
  const sessionPatches = last.sessionPatches || []
  let sessionRefs = null
  if (sessionPatches.length) {
    const latestAfter = [...latest]
    for (const p of puts) {
      const i = latestAfter.findIndex((d) => d.id === p.id)
      if (i >= 0) latestAfter[i] = p
      else latestAfter.push(p)
    }
    const restored = refRestorePatches(latestAfter, sessionPatches)
    puts.push(...restored.puts)
    sessionRefs = { applied: restored.applied, refused: restored.refused }
  }
  // 计划已执行条目引用回补（契约 0.4.0）：仅当条目仍在、ref 仍是本次置的 deleted、所属任务已恢复时
  // 回补原状态；否则保持现状（与专注会话引用同口径），不产生新悬空活引用，不整份覆盖计划历史。
  const planDetached = last.planDetached || []
  let planRefs = null
  if (planDetached.length) {
    const applied = []
    const refused = []
    for (const pd of planDetached) {
      const i = puts.findIndex((x) => x.id === pd.id)
      const cur = i >= 0 ? puts[i] : present.get(pd.id)
      if (!cur || cur.kind !== 'plan_item') { refused.push({ id: pd.id, reason: 'missing' }); continue }
      if (cur.task_ref_state !== 'deleted') { refused.push({ id: pd.id, reason: 'changed' }); continue }
      if (!idsAfter.has(cur.task_id)) { refused.push({ id: pd.id, reason: 'still_missing' }); continue }
      const draft = { ...cur, task_ref_state: pd.from }
      if (i >= 0) puts[i] = draft
      else puts.push(draft)
      applied.push({ id: pd.id, from: 'deleted', to: pd.from })
    }
    planRefs = { applied, refused }
  }
  return { puts, deletes: [], info: { restored: candidates.length, sessionRefs, planRefs } }
}