// 5B-1A 规划测试共享夹具（全部虚构；基准日 2026-11-24 北京时间）。
import { beijingAddDays } from '../domains/time.js'

export const START = '2026-11-24'

export function mkDays(budgets, start = START) {
  return budgets.map((b, i) => ({ date: beijingAddDays(start, i), budget_minutes: b }))
}

export function mkFact(id, over = {}) {
  return {
    task_ref: { kind: 'existing', id },
    title: `虚构目标 ${id}`,
    deadline_value: null,
    deadline_precision: 'none',
    overdue_consent: false,
    status: 'todo',
    ...over,
  }
}

export function mkWork(key, over = {}) {
  return {
    key,
    task_ref: { kind: 'existing', id: 't-1' },
    action_ref: { kind: 'draft', key: `a-${key}` },
    deliverable: `${key} 的虚构产出`,
    remaining_minutes: 60,
    estimate_origin: 'model',
    splittable: true,
    min_segment_minutes: 25,
    earliest_date: null,
    depends_on: [],
    priority: 'normal',
    ...over,
  }
}

export function mkInput({ start = START, today = null, budgets = [60, 60, 60, 60, 60, 60, 60], buffer = 15, facts, works, occupancy = [], ack = [] } = {}) {
  return {
    algorithm_version: 'daily-v1',
    timezone: 'Asia/Shanghai',
    ...(today != null ? { today } : {}),
    start_date: start,
    horizon_days: 7,
    buffer_pct: buffer,
    days: mkDays(budgets, start),
    task_facts: facts ?? [mkFact('t-1')],
    work_items: works ?? [mkWork('w1')],
    occupancy,
    replacement_ids: [],
    extra_work_acknowledged: ack,
  }
}

export function mkOcc(id, over = {}) {
  return {
    plan_item_id: id,
    task_id: 't-old',
    date: START,
    planned_minutes: 30,
    state: 'planned',
    task_ref_state: 'active',
    ...over,
  }
}

export function mkSnapshot(over = {}) {
  return {
    workspace_id: 'ws-fixture',
    turn_id: 'turn-1',
    tasks: [
      { id: 't-1', workspace_id: 'ws-fixture', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' } },
      { id: 't-2', workspace_id: 'ws-fixture', title: '虚构目标二', status: 'todo', deadline: { value: null, precision: 'none' } },
    ],
    actions: [
      { id: 'a-1', workspace_id: 'ws-fixture', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false },
      { id: 'a-done', workspace_id: 'ws-fixture', task_id: 't-1', text: '已完成步骤', minutes: 30, done: true },
      { id: 'a-2', workspace_id: 'ws-fixture', task_id: 't-2', text: '另一目标步骤', minutes: 40, done: false },
    ],
    plan_items: [],
    source_ids: ['s-1'],
    note_ids: ['n-1'],
    focus_session_ids: [],
    ...over,
  }
}

export function mkProposal(over = {}) {
  return {
    task_proposals: [],
    action_proposals: [],
    work_items: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })],
    requirement_candidates: [],
    evidence_refs: [],
    assumptions: [],
    warnings: [],
    ...over,
  }
}

export function mkContext(budgets = [60, 60, 60, 60, 60, 60, 60], over = {}) {
  return {
    timezone: 'Asia/Shanghai',
    today: START,
    start_date: START,
    horizon_days: 7,
    days: mkDays(budgets).map((d) => ({ ...d, committed_minutes: 0 })),
    protected_plans: [],
    ...over,
  }
}

export const EV_SRC = { kind: 'source_excerpt', source_id: 's-1', excerpt: '虚构片段' }
export const EV_USER = { kind: 'user_message', turn_id: 'turn-1', excerpt: '虚构用户要求' }

export function segTuples(result) {
  const byItem = new Map()
  for (const s of result.segments) {
    if (!byItem.has(s.work_item_key)) byItem.set(s.work_item_key, [])
    byItem.get(s.work_item_key).push([s.date, s.minutes, s.order])
  }
  for (const list of byItem.values()) {
    list.sort((a, b) => (a[0] === b[0] ? a[2] - b[2] : a[0] < b[0] ? -1 : 1))
  }
  return Object.fromEntries([...byItem.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

export function warningCodes(result) {
  return result.warnings.map((w) => w.code).filter((c) => c !== 'unrecorded_calendar_notice').sort()
}