// M3 改排领域规则（纯函数，无 IO）：单一替换资格函数、范围校验、快照比对、预览差异、手工清单→建议。
// 依据：devlog/coordination/2026-11-25-M3进展反馈与最小改排开工单.md §4/§5/§6 + M3契约差异.md。
// 资格函数同用于列表展示、准备预览与提交复查；任何漂移整体拒绝，不跳过单条继续。
// replacement_ids 只由本地用户选择产生；模型响应不得产生取消授权。

import { windowDates } from '../planning/protocol'
import { isValidDate } from '../time'

const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

export const MAX_REPLACEMENTS = 100
// 清单行可承载的排程约束（与契约 WorkItemProposal 同字段）；progress_input 契约不含这三项，
// 故约束只随重建后的 proposal 持久化，界面从 proposal 读回，不静默丢弃。
export const REPLAN_PRIORITIES = ['low', 'normal', 'high']

// 受保护原因（UI 只读展示用）；eligible=true 时 reason=null。
export function replacementEligibility(item, { workspaceId, task, today, window, focusSessions = [] }) {
  const no = (reason) => ({ eligible: false, reason })
  if (!item || item.kind !== 'plan_item') return no('NOT_PLAN_ITEM')
  if (workspaceId != null && item.workspace_id !== workspaceId) return no('OTHER_WORKSPACE')
  if (!task) return no('TASK_MISSING')
  if (item.task_id !== task.id) return no('OTHER_TASK')
  if (task.status === 'done') return no('TASK_DONE')
  if (!window || !window.has(item.date)) return no('OUT_OF_WINDOW')
  if (today && item.date < today) return no('PAST_DATE')
  if (item.state !== 'planned') return no('NOT_PLANNED')
  if ((item.task_ref_state ?? 'active') !== 'active') return no('TASK_REF_DELETED')
  // actual_minutes 必须为 null；0 也不自动当成「从未执行」。
  if (item.actual_minutes != null) return no('HAS_ACTUAL')
  if (item.focus_session_id != null) return no('HAS_FOCUS_SHORTCUT')
  // 全部 FocusSession 反查：运行中/暂停/已结束都算引用，不能只查快捷字段。
  if (focusSessions.some((s) => s.plan_item_id === item.id)) return no('HAS_FOCUS_SESSION')
  return { eligible: true, reason: null }
}

export const PROTECTION_LABELS = {
  NOT_PLAN_ITEM: '不是安排记录',
  OTHER_WORKSPACE: '不在当前工作空间',
  OTHER_TASK: '属于其它任务',
  TASK_MISSING: '目标任务已不存在',
  TASK_DONE: '任务已完成',
  OUT_OF_WINDOW: '不在本轮七日窗口',
  PAST_DATE: '日期早于今天',
  NOT_PLANNED: '已有执行/完成/取消等状态',
  TASK_REF_DELETED: '任务引用已删除',
  HAS_ACTUAL: '已有投入记录',
  HAS_FOCUS_SHORTCUT: '有专注记录',
  HAS_FOCUS_SESSION: '有专注会话引用',
}

// 范围校验：去重拒绝、1..100、逐条资格；返回合格条目（保持选择顺序）。
export function validateReplanScope(scope, ctx) {
  if (!scope || typeof scope.task_id !== 'string' || !scope.task_id) fail('REPLAN_SCOPE_INVALID', '改排范围缺少目标任务')
  const ids = scope.replacement_ids ?? []
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_REPLACEMENTS) {
    fail('REPLAN_SCOPE_INVALID', `替换集必须为 1..${MAX_REPLACEMENTS} 条`)
  }
  if (new Set(ids).size !== ids.length) fail('REPLAN_SCOPE_DUPLICATE', '替换集含重复 ID；去重拒绝，不静默扩大范围')
  const byId = new Map((ctx.planItems ?? []).map((p) => [p.id, p]))
  const items = []
  for (const id of ids) {
    const item = byId.get(id)
    if (!item) fail('REPLAN_ITEM_MISSING', `所选安排 ${id} 不在当前快照，请重新核对`)
    const e = replacementEligibility(item, ctx)
    if (!e.eligible) {
      fail('REPLAN_ITEM_INELIGIBLE', `所选安排 ${id} 不可替换：${PROTECTION_LABELS[e.reason] ?? e.reason}`)
    }
    items.push(item)
  }
  return items
}

// 完整语义快照（契约 PlanItemSnapshot 同口径）；历史字段无 updated_at，复核比内容不比时间戳。
export function planItemSnapshot(item) {
  return {
    plan_item_id: item.id,
    task_id: item.task_id,
    date: item.date,
    planned_minutes: item.planned_minutes,
    action_text: item.action_text,
    state: 'planned',
    order: item.order ?? 0,
    actual_minutes: null,
    focus_session_id: null,
    task_ref_state: 'active',
  }
}

export function captureReplacementBaseline({ scope, now, ...ctx }) {
  const items = validateReplanScope(scope, ctx)
  return {
    captured_at: now,
    items: items.map(planItemSnapshot),
    focus_session_ids: (ctx.focusSessions ?? []).map((s) => s.id),
  }
}

// 活快照复核：资格 + 逐字段内容全等 + 无任何会话引用。任何差异整体拒绝。
export function checkReplacementBaseline(baseline, ctx) {
  const diffs = []
  const push = (code, message) => diffs.push({ code, message })
  if (!baseline || !Array.isArray(baseline.items) || baseline.items.length === 0) {
    push('REPLACEMENT_BASELINE_MISSING', '缺少替换基线，请重新准备')
    return { fresh: false, diffs }
  }
  if (!ctx.task) push('TASK_MISSING', '目标任务已不存在')
  else if (ctx.task.status === 'done') push('TASK_DONE', '目标任务已完成，不能继续改排')
  if (ctx.today && ctx.scope && ctx.today > ctx.scope.start_date) {
    push('WINDOW_STALE', `改排起始日 ${ctx.scope.start_date} 早于北京时间今天 ${ctx.today}，窗口已过期`)
  }
  const byId = new Map((ctx.planItems ?? []).map((p) => [p.id, p]))
  const selected = new Set(baseline.items.map((i) => i.plan_item_id))
  for (const s of ctx.focusSessions ?? []) {
    if (selected.has(s.plan_item_id)) {
      push('REPLACEMENT_SESSION_REFERENCED', `所选安排 ${s.plan_item_id} 出现专注会话引用（含运行中/暂停/已结束），整体拒绝`)
    }
  }
  for (const frozen of baseline.items) {
    const item = byId.get(frozen.plan_item_id)
    if (!item) { push('REPLACEMENT_ITEM_MISSING', `所选安排 ${frozen.plan_item_id} 已不存在`); continue }
    const e = replacementEligibility(item, ctx)
    if (!e.eligible) {
      push('REPLACEMENT_INELIGIBLE', `所选安排 ${frozen.plan_item_id} 不再合格：${PROTECTION_LABELS[e.reason] ?? e.reason}`)
      continue
    }
    const cur = planItemSnapshot(item)
    for (const k of Object.keys(frozen)) {
      if (cur[k] !== frozen[k]) {
        push('REPLACEMENT_CONTENT_CHANGED', `所选安排 ${frozen.plan_item_id} 的 ${k} 已变化，旧授权不再适用`)
        break
      }
    }
  }
  return { fresh: diffs.length === 0, diffs }
}

// 单行约束校验：日期必须真实、依赖必须指向本清单其它行、优先级枚举内；不能静默清空。
function constraintOf(raw, key, rowKeys) {
  const c = raw ?? {}
  const earliest = c.earliest_date == null || String(c.earliest_date).trim() === '' ? null : String(c.earliest_date).trim()
  if (earliest != null && !isValidDate(earliest)) {
    fail('PROGRESS_EARLIEST_INVALID', `工作项 ${key} 的最早日期「${earliest}」不是合法日期（YYYY-MM-DD）`)
  }
  const priority = c.priority ?? 'normal'
  if (!REPLAN_PRIORITIES.includes(priority)) {
    fail('PROGRESS_PRIORITY_INVALID', `工作项 ${key} 的优先级「${priority}」不合法（low/normal/high）`)
  }
  const deps = [...(c.depends_on ?? [])]
  if (new Set(deps).size !== deps.length) fail('PROGRESS_DEPENDENCY_DUPLICATE', `工作项 ${key} 的依赖含重复项`)
  for (const d of deps) {
    if (d === key) fail('PROGRESS_DEPENDENCY_SELF', `工作项 ${key} 不得依赖自身`)
    if (!rowKeys.includes(d)) {
      fail('PROGRESS_DEPENDENCY_MISSING', `工作项 ${key} 依赖 ${d}，但该工作项不在本次清单；请先调整依赖或清单`)
    }
  }
  return { earliest_date: earliest, depends_on: deps, priority }
}

// 依赖环在保存清单时就明确拒绝，不把问题拖到排程阶段才暴露。
function checkDependencyCycles(keys, checked) {
  const deps = new Map(keys.map((k, i) => [k, checked[i].depends_on]))
  const state = new Map()
  const visit = (k, path) => {
    if (state.get(k) === 'done') return
    if (state.get(k) === 'visiting') {
      fail('PROGRESS_DEPENDENCY_CYCLE', `清单依赖成环：${[...path, k].join(' → ')}；请调整依赖`)
    }
    state.set(k, 'visiting')
    for (const d of deps.get(k) ?? []) visit(d, [...path, k])
    state.set(k, 'done')
  }
  for (const k of keys) visit(k, [])
}

// 输入签名（F1/F2 共用）：范围选择、说明、清单内容与三项排程约束统一比较。
// 保存后 progress_input 不含约束，已确认清单的约束从 proposal（全部 estimate_origin=user）按行读回。
const sigMinutes = (v) => (v == null || String(v).trim() === '' ? '' : String(Number(v)))
const sigMinSeg = (v) => (v == null || String(v).trim() === '' ? '25' : String(Number(v)))
const sigEarliest = (v) => (v == null || String(v).trim() === '' ? '' : String(v).trim())
const sigDeps = (v) => String(v ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => String(Number(s)))
  .join(',')

export function replanRowsSignature({ replacementIds = [], statement = '', rows = [] } = {}) {
  return JSON.stringify({
    ids: [...replacementIds].sort(),
    statement: String(statement ?? '').trim(),
    rows: rows.map((r) => [
      String(r.text ?? '').trim(),
      sigMinutes(r.minutes),
      r.reuse ?? r.reuse_action_id ?? '',
      r.splittable === false ? false : true,
      sigMinSeg(r.minSeg ?? r.min_segment_minutes),
      sigEarliest(r.earliest ?? r.earliest_date),
      r.priority ?? 'normal',
      sigDeps(r.depsText ?? r.deps),
    ]),
  })
}

export function replanDraftRows(draft) {
  const progressItems = draft?.progress_input?.work_items ?? []
  const rows = progressItems.map((w) => ({
    text: w.text,
    minutes: w.minutes,
    reuse: w.reuse_action_id ?? '',
    splittable: w.splittable ?? true,
    minSeg: w.min_segment_minutes,
    earliest: '',
    priority: 'normal',
    depsText: '',
  }))
  const ws = draft?.proposal?.work_items ?? []
  const confirmed = ws.length === rows.length && ws.every((w) => w.estimate_origin === 'user')
  if (confirmed) {
    const keyToNo = new Map(progressItems.map((w, i) => [w.key ?? `rw${i + 1}`, i + 1]))
    rows.forEach((r, i) => {
      const w = ws[i]
      r.earliest = w.earliest_date ?? ''
      r.priority = w.priority ?? 'normal'
      r.depsText = (w.depends_on ?? []).map((k) => keyToNo.get(k) ?? k).join(',')
    })
  }
  return rows
}

export function replanDraftSignature(draft) {
  return replanRowsSignature({
    replacementIds: draft?.replan_scope?.replacement_ids ?? [],
    statement: draft?.progress_input?.statement ?? '',
    rows: replanDraftRows(draft),
  })
}

// 手工清单→建议结构（本地闭环，不依赖模型）：只 link 目标任务；复用其未完成行动或新建行动。
// 用户已确认分钟数是权威输入（estimate_origin=user）；未知分钟数保持 null，不默认 0。
// 新建行动必须有已知分钟数（行动契约要求正整数）；未知时提示补充，不伪造估时。
// constraints 与清单行同序：{ earliest_date, depends_on(本次清单 key), priority }；缺省保持旧行为。
export function buildReplanProposal(progress, task, actions = [], constraints = []) {
  if (!task || task.status === 'done') fail('REPLAN_TASK_INVALID', '目标任务不存在或已完成，不能改排')
  const rows = progress?.work_items ?? []
  if (rows.length === 0) fail('PROGRESS_EMPTY', '请先填写本次待安排工作清单')
  const rowKeys = rows.map((r) => r.key)
  const checked = rows.map((row, i) => constraintOf(constraints[i], row.key, rowKeys))
  checkDependencyCycles(rowKeys, checked)
  const actionById = new Map(actions.filter((a) => a.task_id === task.id).map((a) => [a.id, a]))
  const taskKey = 'rtask'
  const usedKeys = new Set([taskKey, ...rows.map((r) => r.key)])
  const actionProposals = []
  const workItems = []
  let reuseSeq = 0
  let newSeq = 0
  const nextKey = (prefix) => {
    let k
    do { k = `${prefix}${prefix === 'ract' ? ++reuseSeq : ++newSeq}` } while (usedKeys.has(k))
    usedKeys.add(k)
    return k
  }
  for (const [i, row] of rows.entries()) {
    let actionRef
    if (row.reuse_action_id != null) {
      const a = actionById.get(row.reuse_action_id)
      if (!a) fail('PROGRESS_ACTION_INVALID', `工作项 ${row.key} 复用的行动不属于目标任务或不存在`)
      if (a.done) fail('PROGRESS_ACTION_DONE', `工作项 ${row.key} 不得复用已完成行动`)
      const key = nextKey('ract')
      actionProposals.push({ op: 'reuse', key, target_id: a.id, task_ref: { kind: 'existing', id: task.id }, evidence_refs: [] })
      actionRef = { kind: 'existing', id: a.id }
    } else {
      if (row.minutes == null) {
        fail('PROGRESS_MINUTES_REQUIRED', `工作项 ${row.key} 是新行动且分钟数未知；请补充分钟数或改为复用既有行动`)
      }
      const key = nextKey('nact')
      actionProposals.push({
        op: 'create', key, task_ref: { kind: 'existing', id: task.id },
        text: row.text, minutes: row.minutes, basis: 'suggestion', evidence_refs: [],
      })
      actionRef = { kind: 'draft', key }
    }
    workItems.push({
      key: row.key,
      task_ref: { kind: 'existing', id: task.id },
      action_ref: actionRef,
      deliverable: row.text,
      remaining_minutes: row.minutes ?? null,
      estimate_origin: 'user',
      splittable: row.splittable ?? true,
      min_segment_minutes: row.min_segment_minutes ?? 25,
      earliest_date: checked[i].earliest_date,
      depends_on: [...checked[i].depends_on],
      priority: checked[i].priority,
    })
  }
  return {
    task_proposals: [{ op: 'link', key: taskKey, target_id: task.id, evidence_refs: [] }],
    action_proposals: actionProposals,
    work_items: workItems,
    requirement_candidates: [],
    evidence_refs: [],
    assumptions: [],
    warnings: [],
  }
}

// 预览三块：保留（窗口内未选安排，含其它任务）/ 将取消（基线覆盖）/ 将新增（排程段）。
export function replanPreview({ baseline, segments = [], planItems = [], scope }) {
  const selected = new Set((baseline?.items ?? []).map((i) => i.plan_item_id))
  const window = scope ? new Set(windowDates(scope.start_date)) : null
  const kept = planItems.filter((p) => (!window || window.has(p.date)) && !selected.has(p.id))
  return {
    kept,
    cancel: baseline?.items ?? [],
    create: segments,
    replacedCount: selected.size,
    keptCount: kept.length,
  }
}