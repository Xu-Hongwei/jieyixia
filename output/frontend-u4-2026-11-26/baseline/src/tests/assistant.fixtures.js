// 5B-1B 助手富引用夹具（全部虚构数据）：refs 注册表逐路径表 + 备份恢复集成测试共用。
import { mkWork, mkFact, mkInput, mkOcc, mkDays, EV_SRC, EV_USER, START } from './planning.helpers.js'

export const TS = '2026-11-24T10:00:00+08:00'
export const EV_NOTE = { kind: 'note_field', note_id: 'n-1', field_key: 'deadline' }
export const EV_FACT = { kind: 'existing_fact', object_type: 'task', object_id: 't-1', field_path: 'title' }
export const dc = (value, ev) => ({ value, precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [ev] })

export function richProposal() {
  return {
    task_proposals: [
      { op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [dc('2026-12-01', EV_SRC)], evidence_refs: [EV_USER] },
      { op: 'link', key: 't-link', target_id: 't-1', evidence_refs: [] },
      { op: 'update', key: 't-upd', target_id: 't-2', changes: { title: '新标题', deadline_candidates: [dc('2026-12-02', EV_NOTE)] }, evidence_refs: [] },
    ],
    action_proposals: [
      { op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 25, basis: 'suggestion', evidence_refs: [EV_FACT] },
      { op: 'reuse', key: 'a-reuse', target_id: 'a-1', task_ref: { kind: 'existing', id: 't-1' }, evidence_refs: [] },
    ],
    work_items: [
      mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } }),
      mkWork('w2', { depends_on: ['w1'] }),
    ],
    requirement_candidates: [
      { key: 'r1', type: 'task_priority', value: { task_ref: { kind: 'existing', id: 't-1' }, priority: 'high' }, strength: 'hard', provenance: 'user', evidence_refs: [EV_USER] },
      { key: 'r2', type: 'splittable', value: { work_item_key: 'w1', splittable: false }, strength: 'soft', provenance: 'user', evidence_refs: [] },
      { key: 'r3', type: 'ordering', value: { before_key: 'w1', after_key: 'w2' }, strength: 'soft', provenance: 'user', evidence_refs: [] },
    ],
    evidence_refs: [EV_SRC, EV_NOTE, EV_USER, EV_FACT],
    assumptions: [{ id: 'as1', text: '虚构假设', related_keys: ['w1'] }],
    warnings: [],
  }
}

export function richResult() {
  return {
    segments: [{ segment_key: 'sg1', work_item_key: 'w1', task_ref: { kind: 'existing', id: 't-1' }, suggested_action_ref: { kind: 'existing', id: 'a-1' }, date: START, minutes: 60, order: 1, action_text: '虚构', deliverable: '虚构' }],
    days: mkDays([120, 120, 120, 120, 120, 120, 120]).map((d) => ({ ...d, buffer_minutes: 18, committed_minutes: 0, allocated_minutes: 60, free_minutes: 42, overbooked_minutes: 0 })),
    unscheduled: [{ work_item_key: 'w2', remaining_minutes: 30, reason: 'no_capacity' }],
    unknown_items: [{ work_item_key: 'w3', reason: 'estimate_missing' }],
    excluded_items: [{ work_item_key: 'w4', excluded_by: 'user', reason: '虚构排除' }],
    conflicts: [{ code: 'hard_constraint_violation', message: '虚构冲突', related_keys: ['w1'] }],
    warnings: [{ code: 'existing_overbook', message: '虚构警告', related_key: 'w2' }],
    complete: false,
  }
}

export function richDraft(over = {}) {
  return {
    id: 'd-1', record_version: 1, workspace_id: 'ws-fixture', thread_id: 'th-1',
    revision: 2, status: 'editing',
    revision_history: [{
      revision: 1,
      proposal: { ...richProposal(), task_proposals: [], action_proposals: [], work_items: [mkWork('w-old')], requirement_candidates: [], evidence_refs: [{ kind: 'source_excerpt', source_id: 's-gone', excerpt: '历史片段' }], assumptions: [] },
      planning_input: null, planning_result: null,
      requirements: [{ key: 'r-old', type: 'ordering', value: { before_key: 'w-old', after_key: 'w-gone' }, strength: 'soft', provenance: 'user', evidence_refs: [] }],
      created_at: TS,
    }],
    proposal: richProposal(),
    planning_input: mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], occupancy: [mkOcc('p-1', { task_id: 't-1' })], ack: ['w1'] }),
    planning_result: richResult(),
    fact_baseline: {
      captured_at: TS, task_facts: [mkFact('t-1')],
      source_fingerprints: [{ source_id: 's-1', sha256: '0'.repeat(64), bytes: 10 }],
      note_field_baselines: [{ note_id: 'n-1', field_key: 'deadline', value: null, status: 'candidate', origin: 'model', derived: false }],
      occupancy: [mkOcc('p-2', { task_id: 't-2', state: 'done', task_ref_state: 'deleted' })],
    },
    assumptions: [{ id: 'as2', text: '虚构假设二', related_keys: ['w2'] }],
    user_confirmations: [
      { confirmation_id: 'c1', draft_revision: 2, object_type: 'task', object_id_or_key: 't-new', id_scope: 'draft', field_path: 'deadline', old_value: null, new_value: { value: '2026-12-01', precision: 'date' }, confirmed_at: TS },
      { confirmation_id: 'c2', draft_revision: 2, object_type: 'task', object_id_or_key: 't-1', id_scope: 'formal', field_path: 'title', old_value: '旧', new_value: '新', confirmed_at: TS },
      { confirmation_id: 'c3', draft_revision: 2, object_type: 'note_field', object_id_or_key: 'n-1', field_path: 'deadline', old_value: null, new_value: null, confirmed_at: TS },
      { confirmation_id: 'c4', draft_revision: 2, object_type: 'requirement', object_id_or_key: 'r1', field_path: '', old_value: null, new_value: null, confirmed_at: TS },
      { confirmation_id: 'c5', draft_revision: 2, object_type: 'gap', object_id_or_key: 'w2', field_path: '', old_value: null, new_value: null, confirmed_at: TS },
      { confirmation_id: 'c6', draft_revision: 2, object_type: 'overbook', object_id_or_key: START, field_path: '', old_value: null, new_value: null, confirmed_at: TS },
      { confirmation_id: 'c7', draft_revision: 2, object_type: 'extra_work', object_id_or_key: 'w1', field_path: '', old_value: null, new_value: null, confirmed_at: TS },
    ],
    excluded_items: [{ work_item_key: 'w4', excluded_by: 'user', reason: '虚构排除' }],
    source_refs: [{ object_type: 'source', id: 's-1' }, { object_type: 'draft', id: 'd-other' }],
    applied_summary: null,
    created_at: TS, updated_at: TS,
    ...over,
  }
}

export const richThread = {
  id: 'th-1', record_version: 1, workspace_id: 'ws-fixture', title: '虚构线程',
  messages: [{ id: 'turn-1', role: 'user', content: '原文提到 t-1 与 s-1，不是引用', type: 'text', refs: [{ object_type: 'task', id: 't-1' }], created_at: TS }],
  selected_refs: [{ object_type: 'source', id: 's-1' }],
  confirmed_requirements: [{ requirement_id: 'rq1', version: 1, type: 'task_priority', value: { task_ref: { kind: 'existing', id: 't-2' }, priority: 'low' }, strength: 'soft', confirmed_at: TS, evidence_refs: [EV_SRC] }],
  created_at: TS, updated_at: TS,
}

export const live = {
  source: new Set(['s-1']), note: new Set(['n-1']), task: new Set(['t-1', 't-2']),
  action: new Set(['a-1']), plan_item: new Set(['p-1']), focus_session: new Set(),
  draft: new Set(['d-other']), thread: new Set(['th-1']),
}

// 差异包 §5.2 全表逐路径断言：[path, targetType, namespace]。
export const EXPECTED_DRAFT_PATHS = [
  ['thread_id', 'thread', 'formal'],
  ['source_refs[0].id', 'source', 'formal'],
  ['source_refs[1].id', 'draft', 'formal'],
  ['proposal.task_proposals[0].deadline_candidates[0].evidence_refs[0].source_id', 'source', 'formal'],
  ['proposal.task_proposals[0].evidence_refs[0].turn_id', 'turn', 'turn'],
  ['proposal.task_proposals[1].target_id', 'task', 'formal'],
  ['proposal.task_proposals[2].target_id', 'task', 'formal'],
  ['proposal.task_proposals[2].changes.deadline_candidates[0].evidence_refs[0].note_id', 'note', 'formal'],
  ['proposal.action_proposals[0].task_ref.key', 'task', 'draft_key'],
  ['proposal.action_proposals[0].evidence_refs[0].object_id', 'task', 'formal'],
  ['proposal.action_proposals[1].target_id', 'action', 'formal'],
  ['proposal.action_proposals[1].task_ref.id', 'task', 'formal'],
  ['proposal.work_items[0].task_ref.key', 'task', 'draft_key'],
  ['proposal.work_items[0].action_ref.key', 'action', 'draft_key'],
  ['proposal.work_items[1].depends_on[0]', 'work_item', 'local_key'],
  ['proposal.requirement_candidates[0].value.task_ref.id', 'task', 'formal'],
  ['proposal.requirement_candidates[1].value.work_item_key', 'work_item', 'local_key'],
  ['proposal.requirement_candidates[2].value.before_key', 'work_item', 'local_key'],
  ['proposal.requirement_candidates[2].value.after_key', 'work_item', 'local_key'],
  ['proposal.requirement_candidates[0].evidence_refs[0].turn_id', 'turn', 'turn'],
  ['proposal.evidence_refs[0].source_id', 'source', 'formal'],
  ['proposal.evidence_refs[1].note_id', 'note', 'formal'],
  ['proposal.evidence_refs[2].turn_id', 'turn', 'turn'],
  ['proposal.evidence_refs[3].object_id', 'task', 'formal'],
  ['proposal.assumptions[0].related_keys[0]', 'work_item', 'local_key'],
  ['planning_input.task_facts[0].task_ref.id', 'task', 'formal'],
  ['planning_input.work_items[0].task_ref.id', 'task', 'formal'],
  ['planning_input.occupancy[0].plan_item_id', 'plan_item', 'formal'],
  ['planning_input.occupancy[0].task_id', 'task', 'formal'],
  ['planning_input.extra_work_acknowledged[0]', 'work_item', 'local_key'],
  ['planning_result.segments[0].task_ref.id', 'task', 'formal'],
  ['planning_result.segments[0].suggested_action_ref.id', 'action', 'formal'],
  ['planning_result.segments[0].work_item_key', 'work_item', 'local_key'],
  ['planning_result.segments[0].segment_key', 'segment', 'local_key'],
  ['planning_result.unscheduled[0].work_item_key', 'work_item', 'local_key'],
  ['planning_result.unknown_items[0].work_item_key', 'work_item', 'local_key'],
  ['planning_result.excluded_items[0].work_item_key', 'work_item', 'local_key'],
  ['planning_result.conflicts[0].related_keys[0]', 'work_item', 'local_key'],
  ['planning_result.warnings[0].related_key', 'work_item', 'local_key'],
  ['fact_baseline.task_facts[0].task_ref.id', 'task', 'formal'],
  ['fact_baseline.source_fingerprints[0].source_id', 'source', 'formal'],
  ['fact_baseline.note_field_baselines[0].note_id', 'note', 'formal'],
  ['fact_baseline.occupancy[0].plan_item_id', 'plan_item', 'formal'],
  ['fact_baseline.occupancy[0].task_id', 'task', 'formal'],
  ['user_confirmations[0].object_id_or_key', 'task', 'draft_key'],
  ['user_confirmations[1].object_id_or_key', 'task', 'formal'],
  ['user_confirmations[2].object_id_or_key', 'note', 'formal'],
  ['user_confirmations[3].object_id_or_key', 'requirement', 'local_key'],
  ['user_confirmations[4].object_id_or_key', 'work_item', 'local_key'],
  ['user_confirmations[5].object_id_or_key', 'date', 'date'],
  ['user_confirmations[6].object_id_or_key', 'work_item', 'local_key'],
  ['excluded_items[0].work_item_key', 'work_item', 'local_key'],
  ['assumptions[0].related_keys[0]', 'work_item', 'local_key'],
  ['revision_history[0].proposal.evidence_refs[0].source_id', 'source', 'formal'],
  ['revision_history[0].requirements[0].value.before_key', 'work_item', 'local_key'],
  ['revision_history[0].requirements[0].value.after_key', 'work_item', 'local_key'],
]
// M3 改排富引用夹具（全部虚构）：范围/进展/基线/采用汇总/历史快照的 formal 路径。
export function replanDraftFields() {
  return {
    mode: 'replan',
    replan_scope: { task_id: 't-1', start_date: START, replacement_ids: ['p-1'] },
    progress_input: {
      statement: '虚构进展：原文提到 t-1 与 a-1 不是引用',
      work_items: [{ key: 'rw1', text: '虚构工作', reuse_action_id: 'a-1', minutes: 30, splittable: true, min_segment_minutes: null }],
    },
    replacement_baseline: {
      captured_at: TS,
      items: [{ plan_item_id: 'p-1', task_id: 't-1', date: START, planned_minutes: 30, action_text: '虚构旧安排', state: 'planned', order: 0, actual_minutes: null, focus_session_id: null, task_ref_state: 'active' }],
      focus_session_ids: ['f-gone'],
    },
    applied_summary: {
      id_map: [], unscheduled_kept: [],
      cancelled_plan_item_ids: ['p-1'], replan_task_id: 't-1',
    },
  }
}

export const EXPECTED_REPLAN_PATHS = [
  ['replan_scope.task_id', 'task', 'formal'],
  ['replan_scope.replacement_ids[0]', 'plan_item', 'formal'],
  ['progress_input.work_items[0].reuse_action_id', 'action', 'formal'],
  ['replacement_baseline.items[0].plan_item_id', 'plan_item', 'formal'],
  ['replacement_baseline.items[0].task_id', 'task', 'formal'],
  ['replacement_baseline.focus_session_ids[0]', 'focus_session', 'formal'],
  ['applied_summary.cancelled_plan_item_ids[0]', 'plan_item', 'formal'],
  ['applied_summary.replan_task_id', 'task', 'formal'],
  ['revision_history[0].replan_scope.task_id', 'task', 'formal'],
  ['revision_history[0].replan_scope.replacement_ids[0]', 'plan_item', 'formal'],
  ['revision_history[0].progress_input.work_items[0].reuse_action_id', 'action', 'formal'],
  ['revision_history[0].replacement_baseline.items[0].plan_item_id', 'plan_item', 'formal'],
]
