// 5B-1B 类型化引用注册表逐路径机器测试（差异包 §5.2 全表；全部虚构数据）。
import { describe, it, expect } from 'vitest'
import { assistantRefEntries, resolveAssistantRefs, isHistoricalRefPath } from '@/domains/assistant/refs'
import { START } from './planning.helpers.js'
import { TS, richDraft, richThread, live, EXPECTED_DRAFT_PATHS } from './assistant.fixtures.js'

describe('assistant refs 类型化注册表', () => {
  it('草案全路径覆盖（差异包 §5.2，含 update.changes.deadline_candidates 与 revision_history 递归）', () => {
    const entries = assistantRefEntries(richDraft(), 'draft')
    const got = entries.map((e) => [e.path, e.targetType, e.namespace])
    for (const expected of EXPECTED_DRAFT_PATHS) {
      expect(got, `缺少路径 ${expected[0]}`).toContainEqual(expected)
    }
  })

  it('applied_summary：formal_id 历史关联可遍历；application_id 不是引用入口', () => {
    const d = richDraft({
      status: 'applied',
      applied_summary: {
        application_id: 'app-1',
        counts: { tasks_created: 1, tasks_updated: 0, actions_created: 0, plan_items_created: 0, source_fields_confirmed: 0 },
        id_map: [{ draft_key: 't-new', formal_id: 't-formal-1', object_type: 'task' }],
        unscheduled_kept: [{ work_item_key: 'w9', remaining_minutes: 10, reason: 'no_capacity' }],
        applied_at: TS,
      },
    })
    const entries = assistantRefEntries(d, 'draft')
    const formal = entries.find((e) => e.path === 'applied_summary.id_map[0].formal_id')
    expect(formal).toMatchObject({ targetType: 'task', namespace: 'formal', purpose: 'applied_history' })
    expect(entries.some((e) => e.path.includes('application_id'))).toBe(false)
    expect(entries.some((e) => e.path === 'applied_summary.unscheduled_kept[0].work_item_key' && e.namespace === 'local_key')).toBe(true)
  })

  it('线程路径：selected_refs / messages.refs / confirmed_requirements.value', () => {
    const entries = assistantRefEntries(richThread, 'thread')
    const got = entries.map((e) => [e.path, e.targetType, e.namespace])
    expect(got).toContainEqual(['selected_refs[0].id', 'source', 'formal'])
    expect(got).toContainEqual(['messages[0].refs[0].id', 'task', 'formal'])
    expect(got).toContainEqual(['confirmed_requirements[0].value.task_ref.id', 'task', 'formal'])
    expect(got).toContainEqual(['confirmed_requirements[0].evidence_refs[0].source_id', 'source', 'formal'])
    // 消息正文里的 ID 字符串不是引用。
    expect(entries.some((e) => e.path.includes('content'))).toBe(false)
  })

  it('读取时解析：活引用 resolved/missing；历史快照与 applied 缺失→historical_missing；turn 独立', () => {
    const out = resolveAssistantRefs({ draft: richDraft(), thread: richThread, live })
    const byPath = new Map(out.map((r) => [r.path, r]))
    expect(byPath.get('thread_id').state).toBe('resolved')
    expect(byPath.get('proposal.task_proposals[1].target_id').state).toBe('resolved')
    expect(byPath.get('proposal.task_proposals[0].evidence_refs[0].turn_id').state).toBe('resolved')
    expect(byPath.get('proposal.action_proposals[0].task_ref.key').state).toBe('resolved')
    // p-2 不在活集合：done 占用历史断引用，state=missing 但带 occupancyState 供宽容规则。
    expect(byPath.get('fact_baseline.occupancy[0].plan_item_id')).toMatchObject({ state: 'missing', meta: { occupancyState: 'done' } })
    // 历史快照引用缺失 → historical_missing，不是整包拒绝。
    expect(byPath.get('revision_history[0].proposal.evidence_refs[0].source_id').state).toBe('historical_missing')
    expect(byPath.get('revision_history[0].requirements[0].value.after_key').state).toBe('historical_missing')
    expect(byPath.get('revision_history[0].requirements[0].value.before_key').state).toBe('resolved')
    // 删除活 Task → 当前引用 missing。
    const live2 = { ...live, task: new Set(['t-2']) }
    const out2 = resolveAssistantRefs({ draft: richDraft(), thread: richThread, live: live2 })
    expect(out2.find((r) => r.path === 'proposal.task_proposals[1].target_id').state).toBe('missing')
  })

  it('历史路径判别：revision_history 与 applied_history 为历史，其余为活', () => {
    const entries = assistantRefEntries(richDraft(), 'draft')
    expect(isHistoricalRefPath(entries.find((e) => e.path.startsWith('revision_history')))).toBe(true)
    expect(isHistoricalRefPath(entries.find((e) => e.path === 'thread_id'))).toBe(false)
  })

  it('访问器重写只动正式 ID：draft key/局部 key/turn/正文原文一律不动', () => {
    const d = richDraft()
    d.proposal.evidence_refs[0] = { kind: 'source_excerpt', source_id: 's-1', excerpt: '原文提到 t-1 与 s-1' }
    for (const e of assistantRefEntries(d, 'draft')) {
      if (e.namespace === 'formal') e.set(`new-${e.get()}`)
    }
    expect(d.thread_id).toBe('new-th-1')
    expect(d.proposal.task_proposals[1].target_id).toBe('new-t-1')
    expect(d.proposal.task_proposals[0].deadline_candidates[0].evidence_refs[0].source_id).toBe('new-s-1')
    expect(d.proposal.action_proposals[0].task_ref.key).toBe('t-new')
    expect(d.proposal.work_items[1].depends_on[0]).toBe('w1')
    expect(d.proposal.evidence_refs[0].excerpt).toBe('原文提到 t-1 与 s-1')
    expect(d.user_confirmations[0].object_id_or_key).toBe('t-new')
    expect(d.user_confirmations[1].object_id_or_key).toBe('new-t-1')
    expect(d.user_confirmations[5].object_id_or_key).toBe(START)
    expect(d.revision_history[0].proposal.evidence_refs[0].source_id).toBe('new-s-gone')
  })
})