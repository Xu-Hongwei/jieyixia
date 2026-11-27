// 5B-1B 草案纯规则测试：冻结状态机/修订与限额/确认 C1C2/ready 独立推导（全部虚构数据）。
import { describe, it, expect } from 'vitest'
import {
  canTransition, refreshDraftStatus, restoreDraftStatus, canonicalJson,
  isSubstantiveChange, applyContentEdit, addConfirmation, validateConfirmation,
  forkDraft, deriveReadiness, appendThreadMessage, checkDraftBounds, checkThreadBounds,
  draftJsonBytes, MAX_DRAFT_BYTES, MAX_DRAFT_REVISIONS,
  checkFactFreshness, contentFingerprint,
} from '@/domains/assistant/draft'
import { scheduleDaily } from '@/domains/planning/schedule'
import { beijingAddDays } from '../domains/time.js'
import { mkWork, mkFact, mkInput, mkOcc, mkProposal, EV_SRC, START } from './planning.helpers.js'

const TS = '2026-11-24T10:00:00+08:00'
const TS2 = '2026-11-24T11:00:00+08:00'

const live = {
  source: new Set(['s-1']), note: new Set(['n-1']), task: new Set(['t-1', 't-2']),
  action: new Set(['a-1']), plan_item: new Set(), focus_session: new Set(),
  draft: new Set(), thread: new Set(['th-1']),
}
const thread = { id: 'th-1', workspace_id: 'ws-fixture', messages: [], confirmed_requirements: [], created_at: TS, updated_at: TS }

function readyDraft(over = {}) {
  const proposal = mkProposal()
  const input = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })] })
  const result = scheduleDaily(input)
  return {
    id: 'd-1', record_version: 1, workspace_id: 'ws-fixture', thread_id: 'th-1',
    revision: 1, revision_history: [], status: 'ready',
    proposal, planning_input: input, planning_result: result,
    fact_baseline: { captured_at: TS, task_facts: [mkFact('t-1')], action_facts: [{ action_ref: { kind: 'existing', id: 'a-1' }, task_id: 't-1', text: '虚构步骤', minutes: 60, done: false }], source_fingerprints: [], note_field_baselines: [], occupancy: [] },
    assumptions: [], user_confirmations: [], excluded_items: [], source_refs: [], applied_summary: null,
    created_at: TS, updated_at: TS,
    ...over,
  }
}

const conf = (over = {}) => ({
  confirmation_id: 'c1', draft_revision: 1, object_type: 'gap', object_id_or_key: 'w1',
  field_path: '', old_value: null, new_value: null, confirmed_at: TS, ...over,
})

describe('冻结状态机', () => {
  it('边集与 selftest DRAFT_TRANSITIONS 一致（正例全过，负例拒绝）', () => {
    const pairs = [
      ['editing', 'generating'], ['editing', 'discarded'],
      ['generating', 'needs_clarification'], ['generating', 'ready'], ['generating', 'needs_review'], ['generating', 'discarded'],
      ['needs_clarification', 'generating'], ['needs_clarification', 'editing'], ['needs_clarification', 'discarded'],
      ['ready', 'applying'], ['ready', 'editing'], ['ready', 'generating'], ['ready', 'discarded'],
      ['applying', 'applied'], ['applying', 'needs_review'], ['applying', 'result_unknown'],
      ['result_unknown', 'applied'], ['result_unknown', 'applying'], ['result_unknown', 'needs_review'], ['result_unknown', 'discarded'],
      ['needs_review', 'editing'], ['needs_review', 'generating'], ['needs_review', 'discarded'],
    ]
    for (const [a, b] of pairs) expect(canTransition(a, b), `${a}>${b}`).toBe(true)
    expect(canTransition('editing', 'ready')).toBe(false)
    expect(canTransition('discarded', 'editing')).toBe(false)
    expect(canTransition('applied', 'editing')).toBe(false)
    expect(canTransition('needs_review', 'ready')).toBe(false)
    expect(canTransition('ready', 'applied')).toBe(false)
  })

  it('刷新映射：generating 中断待重试；applying/result_unknown 待核实', () => {
    expect(refreshDraftStatus('generating')).toEqual({ status: 'needs_review', needsExplicitRetry: true })
    expect(refreshDraftStatus('applying')).toEqual({ status: 'result_unknown', needsExplicitRetry: true })
    expect(refreshDraftStatus('result_unknown')).toEqual({ status: 'result_unknown', needsExplicitRetry: true })
    expect(refreshDraftStatus('ready')).toEqual({ status: 'ready', needsExplicitRetry: false })
  })

  it('恢复映射：未应用各态 needs_review 去授权；applied 只读；discarded 保持', () => {
    for (const s of ['editing', 'generating', 'needs_clarification', 'ready', 'needs_review', 'applying', 'result_unknown']) {
      expect(restoreDraftStatus(s)).toEqual({ restoredStatus: 'needs_review', envelopeCleared: true, baselineCleared: true, adoptionAuthCleared: true, contentKept: true })
    }
    expect(restoreDraftStatus('applied').restoredStatus).toBe('applied')
    expect(restoreDraftStatus('discarded').restoredStatus).toBe('discarded')
  })
})

describe('修订与限额', () => {
  it('canonicalJson 键序无关；实质修改判定只看内容字段', () => {
    expect(canonicalJson({ a: 1, b: { x: 1, y: 2 } })).toBe(canonicalJson({ b: { y: 2, x: 1 }, a: 1 }))
    const d = readyDraft()
    expect(isSubstantiveChange(d, { ...d, status: 'editing', user_confirmations: [conf()] })).toBe(false)
    expect(isSubstantiveChange(d, { ...d, proposal: { ...d.proposal, warnings: [{ code: 'capacity_unknown', message: 'x' }] } })).toBe(true)
  })

  it('实质编辑→revision+1 + 旧版快照；同内容保存不 bump 不改时间', () => {
    const d = readyDraft()
    const same = applyContentEdit(d, { proposal: structuredClone(d.proposal) }, TS2)
    expect(same.ok).toBe(true)
    expect(same.bumped).toBe(false)
    expect(same.draft).toBe(d)
    const edited = applyContentEdit(d, { proposal: { ...d.proposal, assumptions: [{ id: 'as1', text: '虚构', related_keys: [] }] } }, TS2)
    expect(edited.ok).toBe(true)
    expect(edited.bumped).toBe(true)
    expect(edited.draft.revision).toBe(2)
    expect(edited.draft.status).toBe('editing')
    expect(edited.draft.updated_at).toBe(TS2)
    expect(edited.draft.revision_history).toHaveLength(1)
    expect(edited.draft.revision_history[0]).toMatchObject({ revision: 1, created_at: TS })
    expect(edited.draft.revision_history[0].proposal).toEqual(d.proposal)
    expect(d.revision).toBe(1) // 原记录不变
  })

  it('非内容字段编辑拒绝；discarded/applied 不可编辑', () => {
    const d = readyDraft()
    expect(applyContentEdit(d, { status: 'ready' }, TS2).ok).toBe(false)
    expect(applyContentEdit({ ...d, status: 'discarded' }, { assumptions: [] }, TS2).errors[0].code).toBe('NOT_EDITABLE')
  })

  it('版本上限：第 21 版拒绝且原记录不变，不静默剪历史', () => {
    const hist = Array.from({ length: 19 }, (_, i) => ({ revision: i + 1, proposal: null, planning_input: null, planning_result: null, requirements: [], created_at: TS }))
    const d = readyDraft({ revision: 20, revision_history: hist })
    const r = applyContentEdit(d, { assumptions: [{ id: 'as1', text: '虚构', related_keys: [] }] }, TS2)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.code === 'REVISION_LIMIT')).toBe(true)
    expect(d.revision).toBe(20)
    expect(d.revision_history).toHaveLength(19)
  })

  it('体积上限：超 1MiB 拒绝且原记录不变', () => {
    const d = readyDraft()
    const big = '虚构'.repeat(300000)
    const r = applyContentEdit(d, { assumptions: [{ id: 'as1', text: big, related_keys: [] }] }, TS2)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.code === 'DRAFT_TOO_LARGE')).toBe(true)
    expect(draftJsonBytes(d)).toBeLessThan(MAX_DRAFT_BYTES)
  })

  it('planning_input/planning_result 必须同一次计算：错配拒绝', () => {
    const d = readyDraft()
    const otherInput = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { remaining_minutes: 90, action_ref: { kind: 'existing', id: 'a-1' } })] })
    const r = applyContentEdit(d, { planning_input: otherInput }, TS2)
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('COMPUTATION_MISMATCH')
    const r2 = applyContentEdit(d, { planning_input: otherInput, planning_result: scheduleDaily(otherInput) }, TS2)
    expect(r2.ok).toBe(true)
    const r3 = applyContentEdit(d, { planning_result: null, proposal: { ...d.proposal, warnings: [] , assumptions: [{ id: 'as2', text: 'x', related_keys: [] }] } }, TS2)
    expect(r3.ok).toBe(true)
  })

  it('checkDraftBounds：revision/history/applied 配对负对照', () => {
    expect(checkDraftBounds(readyDraft())).toEqual([])
    expect(checkDraftBounds(readyDraft({ revision: MAX_DRAFT_REVISIONS + 1 })).some((e) => e.code === 'REVISION_LIMIT')).toBe(true)
    expect(checkDraftBounds(readyDraft({ revision_history: [{ revision: 1, proposal: null, planning_input: null, planning_result: null, requirements: [], created_at: TS }] })).some((e) => e.code === 'HISTORY_ORDER')).toBe(true)
    expect(checkDraftBounds(readyDraft({ status: 'applied' })).some((e) => e.code === 'APPLIED_NO_SUMMARY')).toBe(true)
    expect(checkDraftBounds(readyDraft({ applied_summary: { application_id: 'app', counts: { tasks_created: 0, tasks_updated: 0, actions_created: 0, plan_items_created: 0, source_fields_confirmed: 0 }, id_map: [], unscheduled_kept: [], applied_at: TS } })).some((e) => e.code === 'SUMMARY_NOT_APPLIED')).toBe(true)
  })

  it('forkDraft：重建身份、清历史/确认/授权/事实基线，内容可读', () => {
    const d = readyDraft({ revision: 3, user_confirmations: [conf()] })
    const f = forkDraft(d, { id: 'd-new', now: TS2 })
    expect(f.id).toBe('d-new')
    expect(f.revision).toBe(1)
    expect(f.revision_history).toEqual([])
    expect(f.user_confirmations).toEqual([])
    expect(f.applied_summary).toBeNull()
    expect(f.fact_baseline).toBeNull()
    expect(f.status).toBe('editing')
    expect(f.proposal).toEqual(d.proposal)
  })
})

describe('确认 C1/C2 口径', () => {
  it('task 必须显式 id_scope；draft key 必须注册；formal 必须解析到捕获空间', () => {
    const d = readyDraft()
    expect(validateConfirmation(conf({ object_type: 'task', object_id_or_key: 't-1', field_path: 'title' }), d, { live }).errors.some((e) => e.code === 'ID_SCOPE_REQUIRED')).toBe(true)
    expect(validateConfirmation(conf({ object_type: 'task', object_id_or_key: 't-1', id_scope: 'formal', field_path: 'title' }), d, { live }).ok).toBe(true)
    expect(validateConfirmation(conf({ object_type: 'task', object_id_or_key: 't-1', id_scope: 'draft', field_path: 'title' }), d, { live }).errors.some((e) => e.code === 'UNKNOWN_DRAFT_KEY')).toBe(true)
    expect(validateConfirmation(conf({ object_type: 'task', object_id_or_key: 't-gone', id_scope: 'formal', field_path: 'title' }), d, { live }).errors.some((e) => e.code === 'UNKNOWN_FORMAL_ID')).toBe(true)
    expect(validateConfirmation(conf({ object_type: 'gap', id_scope: 'draft' }), d, { live }).errors.some((e) => e.code === 'ID_SCOPE_FORBIDDEN')).toBe(true)
  })

  it('碰名不串绑：正式 ID 恰等于草案 key 时按 id_scope 各走各的', () => {
    const d = readyDraft({ proposal: { ...mkProposal(), task_proposals: [{ op: 'create', key: 't-1', title: '虚构', deadline_candidates: [], evidence_refs: [] }] } })
    expect(validateConfirmation(conf({ object_type: 'task', object_id_or_key: 't-1', id_scope: 'draft', field_path: 'title' }), d, { live }).ok).toBe(true)
    expect(validateConfirmation(conf({ object_type: 'task', object_id_or_key: 't-1', id_scope: 'formal', field_path: 'title' }), d, { live }).ok).toBe(true)
  })

  it('task/deadline 必须显式 old/new_value；投影形状与真实时间校验', () => {
    const d = readyDraft()
    const base = { object_type: 'task', object_id_or_key: 't-1', id_scope: 'formal', field_path: 'deadline' }
    const missing = conf(base)
    delete missing.old_value
    delete missing.new_value
    expect(validateConfirmation(missing, d, { live }).errors.filter((e) => e.code === 'VALUE_MISSING')).toHaveLength(2)
    expect(validateConfirmation(conf({ ...base, old_value: null, new_value: { value: '2026-12-01', precision: 'date' } }), d, { live }).ok).toBe(true)
    expect(validateConfirmation(conf({ ...base, old_value: null, new_value: null }), d, { live }).ok).toBe(true)
    expect(validateConfirmation(conf({ ...base, old_value: null, new_value: { value: '2026-12-01', precision: 'date', extra: 1 } }), d, { live }).errors.some((e) => e.code === 'VALUE_PROJECTION')).toBe(true)
    expect(validateConfirmation(conf({ ...base, old_value: null, new_value: { value: '2026-02-30', precision: 'date' } }), d, { live }).errors.some((e) => e.code === 'VALUE_PROJECTION')).toBe(true)
    // 旧事实宽松口径：无秒 datetime 允许。
    expect(validateConfirmation(conf({ ...base, old_value: { value: '2026-12-01T10:00+08:00', precision: 'datetime' }, new_value: null }), d, { live }).ok).toBe(true)
  })

  it('确认绑定当前 revision；重复 id 拒绝；追加不 bump', () => {
    const d = readyDraft({ revision: 2 })
    expect(validateConfirmation(conf({ draft_revision: 1 }), d, { live }).errors.some((e) => e.code === 'REVISION_STALE')).toBe(true)
    const r = addConfirmation(readyDraft(), conf(), TS2, { live, thread })
    expect(r.ok).toBe(true)
    expect(r.draft.revision).toBe(1)
    expect(r.draft.user_confirmations).toHaveLength(1)
    const dup = addConfirmation(r.draft, conf(), TS2, { live, thread })
    expect(dup.ok).toBe(false)
    expect(dup.errors[0].code).toBe('CONFIRMATION_DUP')
  })
})

describe('ready 独立推导', () => {
  it('完整正例：估时/事实/引用/确认/硬约束/缺口/过载全过', () => {
    const r = deriveReadiness(readyDraft(), { thread, live })
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
  })

  it('负对照：缺事实基线 / 活引用缺失 / result 不完整 各自阻断', () => {
    expect(deriveReadiness(readyDraft({ fact_baseline: null }), { thread, live }).blockers.some((b) => b.code === 'FACT_BASELINE_MISSING')).toBe(true)
    const live2 = { ...live, task: new Set() }
    expect(deriveReadiness(readyDraft(), { thread, live: live2 }).blockers.some((b) => b.code === 'REF_MISSING')).toBe(true)
    // R3：complete=false 不再一刀切阻断；真实不完整（未排完缺口）由颗粒 GAP_UNCONFIRMED 阻断，ready 仍为 false。
    const gapInput = mkInput({ budgets: [10, 10, 10, 10, 10, 10, 10], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })] })
    const dg = readyDraft({ planning_input: gapInput, planning_result: scheduleDaily(gapInput) })
    expect(dg.planning_result.complete).toBe(false)
    const r = deriveReadiness(dg, { thread, live })
    expect(r.blockers.some((b) => b.code === 'GAP_UNCONFIRMED')).toBe(true)
    expect(r.ready).toBe(false)
  })

  it('planned 占用断引用阻断；done 历史断引用不阻断', () => {
    const occ = [mkOcc('p-gone', { task_id: 't-1', state: 'planned' })]
    const input = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })], occupancy: occ, ack: ['w1'] })
    const d = readyDraft({ planning_input: input, planning_result: scheduleDaily(input) })
    expect(deriveReadiness(d, { thread, live }).blockers.some((b) => b.code === 'OCCUPANCY_UNTRUSTED')).toBe(true)
    const occ2 = [mkOcc('p-gone', { task_id: 't-1', state: 'done', task_ref_state: 'deleted' })]
    const input2 = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })], occupancy: occ2, ack: ['w1'] })
    const d2 = readyDraft({ planning_input: input2, planning_result: scheduleDaily(input2) })
    expect(deriveReadiness(d2, { thread, live }).blockers.some((b) => b.code === 'OCCUPANCY_UNTRUSTED')).toBe(false)
  })

  it('估时未知 / 缺口未确认 / 过载未确认 各自阻断；当前版本确认后解除', () => {
    const unknownInput = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { remaining_minutes: null, action_ref: { kind: 'existing', id: 'a-1' } })] })
    const du = readyDraft({ planning_input: unknownInput, planning_result: scheduleDaily(unknownInput) })
    expect(deriveReadiness(du, { thread, live }).blockers.some((b) => b.code === 'ESTIMATE_UNKNOWN')).toBe(true)

    const gapInput = mkInput({ budgets: [10, 10, 10, 10, 10, 10, 10], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })] })
    const dg = readyDraft({ planning_input: gapInput, planning_result: scheduleDaily(gapInput) })
    expect(deriveReadiness(dg, { thread, live }).blockers.some((b) => b.code === 'GAP_UNCONFIRMED')).toBe(true)
    const dgOk = { ...dg, user_confirmations: [conf({ object_type: 'gap', object_id_or_key: 'w1' })] }
    expect(deriveReadiness(dgOk, { thread, live }).blockers.some((b) => b.code === 'GAP_UNCONFIRMED')).toBe(false)
    // 旧版本确认不算数（不继承授权）。
    const dgOld = { ...dg, revision: 2, user_confirmations: [conf({ object_type: 'gap', object_id_or_key: 'w1', draft_revision: 1 })] }
    expect(deriveReadiness(dgOld, { thread, live }).blockers.some((b) => b.code === 'GAP_UNCONFIRMED')).toBe(true)

    const occ = [mkOcc('p-1', { task_id: 't-1', planned_minutes: 200, state: 'done' })]
    const obInput = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })], occupancy: occ, ack: ['w1'] })
    const dob = readyDraft({ planning_input: obInput, planning_result: scheduleDaily(obInput) })
    expect(deriveReadiness(dob, { thread, live: { ...live, plan_item: new Set(['p-1']) } }).blockers.some((b) => b.code === 'OVERBOOK_UNCONFIRMED')).toBe(true)
  })

  it('update 逐字段确认；deadline 旧值漂移/旧版/矛盾确认失效，手动/无截止/候选日期均合法（R8）', () => {
    const upd = { op: 'update', key: 'tu', target_id: 't-1', changes: { title: '改标题' }, evidence_refs: [] }
    const d = readyDraft({ proposal: { ...mkProposal(), task_proposals: [upd] } })
    expect(deriveReadiness(d, { thread, live }).blockers.some((b) => b.code === 'UPDATE_UNCONFIRMED')).toBe(true)
    const ok = { ...d, user_confirmations: [conf({ object_type: 'task', object_id_or_key: 't-1', id_scope: 'formal', field_path: 'title', old_value: '旧', new_value: '改标题' })] }
    expect(deriveReadiness(ok, { thread, live }).blockers.some((b) => b.code === 'UPDATE_UNCONFIRMED')).toBe(false)

    const create = { op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [{ value: '2026-12-01', precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] }], evidence_refs: [] }
    const d2 = readyDraft({ proposal: { ...mkProposal(), task_proposals: [create] } })
    expect(deriveReadiness(d2, { thread, live }).blockers.some((b) => b.code === 'DEADLINE_UNCONFIRMED')).toBe(true)
    // 旧值漂移：create 基线恒 null，确认却携带非 null 旧值 → 失效（仍拒绝）。
    const drift = { ...d2, user_confirmations: [conf({ object_type: 'task', object_id_or_key: 't-new', id_scope: 'draft', field_path: 'deadline', old_value: { value: '2026-11-01', precision: 'date' }, new_value: { value: '2026-12-01', precision: 'date' } })] }
    expect(deriveReadiness(drift, { thread, live }).blockers.some((b) => b.code === 'CONFIRMATION_VALUE_STALE')).toBe(true)
    // 旧版授权不继承：确认绑第 2 版而草案第 1 版 → 未经当前版本确认。
    const oldRev = { ...d2, user_confirmations: [conf({ object_type: 'task', object_id_or_key: 't-new', id_scope: 'draft', field_path: 'deadline', draft_revision: 2, old_value: null, new_value: { value: '2026-12-01', precision: 'date' } })] }
    expect(deriveReadiness(oldRev, { thread, live }).blockers.some((b) => b.code === 'DEADLINE_UNCONFIRMED')).toBe(true)
    // 相互矛盾的两份确认 → 失效。
    const conflict = { ...d2, user_confirmations: [
      conf({ confirmation_id: 'c1', object_type: 'task', object_id_or_key: 't-new', id_scope: 'draft', field_path: 'deadline', old_value: null, new_value: { value: '2026-12-01', precision: 'date' } }),
      conf({ confirmation_id: 'c2', object_type: 'task', object_id_or_key: 't-new', id_scope: 'draft', field_path: 'deadline', old_value: null, new_value: { value: '2026-12-05', precision: 'date' } }),
    ] }
    expect(deriveReadiness(conflict, { thread, live }).blockers.some((b) => b.code === 'CONFIRMATION_VALUE_STALE')).toBe(true)
    // 合法决定：候选日期 / 手动非候选日期 / 明确无截止 均放行（R8 不以候选包含关系判定）。
    const dlConf = (new_value) => conf({ object_type: 'task', object_id_or_key: 't-new', id_scope: 'draft', field_path: 'deadline', old_value: null, new_value })
    for (const nv of [{ value: '2026-12-01', precision: 'date' }, { value: '2026-12-02', precision: 'date' }, null]) {
      const good = { ...d2, user_confirmations: [dlConf(nv)] }
      const r = deriveReadiness(good, { thread, live })
      expect(r.blockers.some((b) => b.code === 'DEADLINE_UNCONFIRMED' || b.code === 'CONFIRMATION_VALUE_STALE'), JSON.stringify(nv)).toBe(false)
    }
  })

  it('create 多候选选择一个合法决定即放行（R8 不要求逐候选确认）', () => {
    const cand = (v) => ({ value: v, precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] })
    const create = { op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [cand('2026-12-01'), cand('2026-12-03')], evidence_refs: [] }
    const d = readyDraft({ proposal: { ...mkProposal(), task_proposals: [create] } })
    expect(deriveReadiness(d, { thread, live }).blockers.some((b) => b.code === 'DEADLINE_UNCONFIRMED')).toBe(true)
    const pick = { ...d, user_confirmations: [conf({ object_type: 'task', object_id_or_key: 't-new', id_scope: 'draft', field_path: 'deadline', old_value: null, new_value: { value: '2026-12-03', precision: 'date' } })] }
    const r = deriveReadiness(pick, { thread, live })
    expect(r.blockers.some((b) => b.code === 'DEADLINE_UNCONFIRMED' || b.code === 'CONFIRMATION_VALUE_STALE')).toBe(false)
  })

  it('discarded/applied 不参与 ready；硬冲突阻断', () => {
    expect(deriveReadiness(readyDraft({ status: 'discarded' }), { thread, live }).ready).toBe(false)
    const d = readyDraft()
    d.planning_result = { ...d.planning_result, conflicts: [{ code: 'hard_constraint_violation', message: '虚构', related_keys: [] }] }
    expect(deriveReadiness(d, { thread, live }).blockers.some((b) => b.code === 'HARD_CONFLICT')).toBe(true)
  })
})

describe('R10 当前截止决定与计算输入绑定（值/精度不一致须重新排程，决定合法≠旧计算适用）', () => {
  const FULL = [120, 120, 120, 120, 120, 120, 120]
  const cand = (v, p = 'date') => ({ value: v, precision: p, origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV_SRC] })
  const baselineNone = { captured_at: TS, task_facts: [mkFact('t-1')], source_fingerprints: [], note_field_baselines: [], occupancy: [] }
  // update 提案（候选存在）+ 指定「计算实际采用截止」的 planning_input；正式旧值恒无截止（old_value=null）。
  function computedUpdate(dv, dp) {
    const proposal = { ...mkProposal(), task_proposals: [{ op: 'update', key: 'tu', target_id: 't-1', changes: { deadline_candidates: [cand('2026-11-30')] }, evidence_refs: [EV_SRC] }] }
    const input = mkInput({ budgets: FULL, facts: [mkFact('t-1', { deadline_value: dv, deadline_precision: dp })], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })] })
    return readyDraft({ proposal, planning_input: input, planning_result: scheduleDaily(input), fact_baseline: baselineNone })
  }
  function computedCreate(dv, dp) {
    const proposal = mkProposal({
      task_proposals: [{ op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [cand('2026-12-01')], evidence_refs: [EV_SRC] }],
      action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60 }],
      work_items: [mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } })],
    })
    const input = mkInput({ budgets: FULL, facts: [{ task_ref: { kind: 'draft', key: 't-new' }, title: '虚构新目标', status: 'todo', deadline_value: dv, deadline_precision: dp, overdue_consent: false }], works: [mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } })] })
    return readyDraft({ proposal, planning_input: input, planning_result: scheduleDaily(input), fact_baseline: { captured_at: TS, task_facts: [], source_fingerprints: [], note_field_baselines: [], occupancy: [] } })
  }
  const formalConf = (new_value, over = {}) => conf({ object_type: 'task', object_id_or_key: 't-1', id_scope: 'formal', field_path: 'deadline', old_value: null, new_value, ...over })
  const draftConf = (new_value, over = {}) => conf({ object_type: 'task', object_id_or_key: 't-new', id_scope: 'draft', field_path: 'deadline', old_value: null, new_value, ...over })
  const recompute = (d) => deriveReadiness(d, { thread, live }).blockers.some((b) => b.code === 'DEADLINE_RECOMPUTE_REQUIRED')

  it('日期和值完全一致：不阻断，其它条件满足时可 ready', () => {
    const d = { ...computedUpdate('2026-11-30', 'date'), user_confirmations: [formalConf({ value: '2026-11-30', precision: 'date' })] }
    expect(recompute(d)).toBe(false)
    expect(deriveReadiness(d, { thread, live }).ready).toBe(true)
  })

  it('改为更早截止（含已过去日期）：旧计算阻断，须按新决定重排', () => {
    for (const earlier of ['2026-11-28', '2026-11-23']) {
      const d = { ...computedUpdate('2026-11-30', 'date'), user_confirmations: [formalConf({ value: earlier, precision: 'date' })] }
      expect(recompute(d), earlier).toBe(true)
      expect(deriveReadiness(d, { thread, live }).ready).toBe(false)
    }
  })

  it('日期改为明确无截止 / 无截止改为日期：两个方向都阻断旧计算', () => {
    const toDate = { ...computedUpdate(null, 'none'), user_confirmations: [formalConf({ value: '2026-11-30', precision: 'date' })] }
    expect(recompute(toDate)).toBe(true)
    const toNone = { ...computedUpdate('2026-11-30', 'date'), user_confirmations: [formalConf(null)] }
    expect(recompute(toNone)).toBe(true)
  })

  it('日期与精确时刻互换：精度差异也阻断旧计算', () => {
    const d = { ...computedUpdate('2026-11-30', 'date'), user_confirmations: [formalConf({ value: '2026-11-30T18:00:00+08:00', precision: 'datetime' })] }
    expect(recompute(d)).toBe(true)
  })

  it('create 命名空间按 draft key 匹配：一致不阻断，改值阻断（不与 formal 串绑）', () => {
    const ok = { ...computedCreate('2026-12-01', 'date'), user_confirmations: [draftConf({ value: '2026-12-01', precision: 'date' })] }
    expect(recompute(ok)).toBe(false)
    const changed = { ...computedCreate('2026-12-01', 'date'), user_confirmations: [draftConf({ value: '2026-12-03', precision: 'date' })] }
    expect(recompute(changed)).toBe(true)
  })

  it('保留 R8 负向：旧版授权/旧值漂移/矛盾确认仍各自失效，不被绑定检查掩盖', () => {
    const base = computedUpdate('2026-11-30', 'date')
    const stale = { ...base, revision: 2, user_confirmations: [formalConf({ value: '2026-11-30', precision: 'date' }, { draft_revision: 1 })] }
    expect(deriveReadiness(stale, { thread, live }).blockers.some((b) => b.code === 'UPDATE_UNCONFIRMED')).toBe(true)
    const drift = { ...base, user_confirmations: [formalConf({ value: '2026-11-30', precision: 'date' }, { old_value: { value: '2026-11-01', precision: 'date' } })] }
    expect(deriveReadiness(drift, { thread, live }).blockers.some((b) => b.code === 'CONFIRMATION_VALUE_STALE')).toBe(true)
    const conflict = { ...base, user_confirmations: [
      formalConf({ value: '2026-11-30', precision: 'date' }, { confirmation_id: 'c1' }),
      formalConf({ value: '2026-12-05', precision: 'date' }, { confirmation_id: 'c2' }),
    ] }
    expect(deriveReadiness(conflict, { thread, live }).blockers.some((b) => b.code === 'CONFIRMATION_VALUE_STALE')).toBe(true)
  })
})

describe('R1 事实新鲜度核对（全窗口占用 + 任务/行动/资料/日期）', () => {
  const freshDocs = () => [
    { kind: 'task', id: 't-1', title: '虚构目标 t-1', status: 'todo', deadline: { value: null, precision: 'none' } },
    { kind: 'action', id: 'a-1', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false },
  ]
  const occDoc = (id, over = {}) => ({ kind: 'plan_item', id, task_id: 't-1', date: START, planned_minutes: 30, state: 'planned', task_ref_state: 'active', ...over })
  const baselineWith = (over) => readyDraft({ fact_baseline: { captured_at: TS, task_facts: [mkFact('t-1')], action_facts: [{ action_ref: { kind: 'existing', id: 'a-1' }, task_id: 't-1', text: '虚构步骤', minutes: 60, done: false }], source_fingerprints: [], note_field_baselines: [], occupancy: [], ...over } })

  it('无漂移：最新快照与冻结事实一致 → fresh', () => {
    const r = checkFactFreshness(readyDraft(), { docs: freshDocs(), sources: [], today: START })
    expect(r.fresh).toBe(true)
    expect(r.diffs).toEqual([])
  })

  it('F2：既有行动缺基线覆盖（旧草案无字段/空列表）→ ACTION_BASELINE_MISSING，不得跳过核对', () => {
    const base = readyDraft().fact_baseline
    const noField = readyDraft({ fact_baseline: { ...base } })
    delete noField.fact_baseline.action_facts
    expect(checkFactFreshness(noField, { docs: freshDocs(), sources: [], today: START }).diffs.some((x) => x.code === 'ACTION_BASELINE_MISSING')).toBe(true)
    const empty = readyDraft({ fact_baseline: { ...base, action_facts: [] } })
    expect(checkFactFreshness(empty, { docs: freshDocs(), sources: [], today: START }).diffs.some((x) => x.code === 'ACTION_BASELINE_MISSING')).toBe(true)
  })

  it('F2：基线在场时正文/估时/归属漂移 → ACTION_CONTENT_CHANGED', () => {
    const docs = [
      { kind: 'task', id: 't-1', title: '虚构目标 t-1', status: 'todo', deadline: { value: null, precision: 'none' } },
      { kind: 'action', id: 'a-1', task_id: 't-1', text: '预览后被改动', minutes: 999, done: false },
    ]
    expect(checkFactFreshness(readyDraft(), { docs, sources: [], today: START }).diffs.some((x) => x.code === 'ACTION_CONTENT_CHANGED')).toBe(true)
  })

  it('新增占用：窗口内新 PlanItem（含旧输入未提到的后续日）→ OCCUPANCY_ADDED', () => {
    const later = beijingAddDays(START, 3)
    const docs = [...freshDocs(), occDoc('p-new', { task_id: 't-2', date: later, planned_minutes: 120 })]
    const r = checkFactFreshness(readyDraft(), { docs, sources: [], today: START })
    expect(r.fresh).toBe(false)
    expect(r.diffs.some((d) => d.code === 'OCCUPANCY_ADDED')).toBe(true)
  })

  it('修改占用：分钟变化 → OCCUPANCY_CHANGED', () => {
    const d = baselineWith({ occupancy: [mkOcc('p-1', { task_id: 't-1' })] })
    const docs = [...freshDocs(), occDoc('p-1', { planned_minutes: 90 })]
    expect(checkFactFreshness(d, { docs, sources: [], today: START }).diffs.some((x) => x.code === 'OCCUPANCY_CHANGED')).toBe(true)
  })

  it('删除占用：冻结占用已不在窗口 → OCCUPANCY_REMOVED', () => {
    const d = baselineWith({ occupancy: [mkOcc('p-1', { task_id: 't-1' })] })
    expect(checkFactFreshness(d, { docs: freshDocs(), sources: [], today: START }).diffs.some((x) => x.code === 'OCCUPANCY_REMOVED')).toBe(true)
  })

  it('完成行动 / 修改截止 / 修改状态 / 目标删除 各自列出差异', () => {
    const task = (over) => ({ kind: 'task', id: 't-1', title: '虚构目标 t-1', status: 'todo', deadline: { value: null, precision: 'none' }, ...over })
    const action = (done) => ({ kind: 'action', id: 'a-1', task_id: 't-1', text: '虚构步骤', minutes: 60, done })
    expect(checkFactFreshness(readyDraft(), { docs: [task(), action(true)], sources: [], today: START }).diffs.some((x) => x.code === 'ACTION_DONE')).toBe(true)
    expect(checkFactFreshness(readyDraft(), { docs: [task({ deadline: { value: '2026-12-01', precision: 'date' } }), action(false)], sources: [], today: START }).diffs.some((x) => x.code === 'TASK_DEADLINE_CHANGED')).toBe(true)
    expect(checkFactFreshness(readyDraft(), { docs: [task({ status: 'done' }), action(false)], sources: [], today: START }).diffs.some((x) => x.code === 'TASK_STATUS_CHANGED')).toBe(true)
    expect(checkFactFreshness(readyDraft(), { docs: [action(false)], sources: [], today: START }).diffs.some((x) => x.code === 'TASK_MISSING')).toBe(true)
  })

  it('跨午夜：北京时间今天晚于规划起始日 → WINDOW_STALE', () => {
    const r = checkFactFreshness(readyDraft(), { docs: freshDocs(), sources: [], today: beijingAddDays(START, 1) })
    expect(r.diffs.some((x) => x.code === 'WINDOW_STALE')).toBe(true)
  })

  it('资料字段变化 / 证据资料删除 各自列出差异', () => {
    const dn = baselineWith({ note_field_baselines: [{ note_id: 'n-1', field_key: 'k', value: '旧', status: 'candidate', origin: 'model', derived: false }] })
    const docs = [...freshDocs(), { kind: 'note', id: 'n-1', fields: [{ key: 'k', value: '新', status: 'candidate', origin: 'model', derived: false }] }]
    expect(checkFactFreshness(dn, { docs, sources: [], today: START }).diffs.some((x) => x.code === 'NOTE_FIELD_CHANGED')).toBe(true)
    const ds = baselineWith({ source_fingerprints: [{ source_id: 's-1', sha256: 'x', bytes: 1 }] })
    expect(checkFactFreshness(ds, { docs: freshDocs(), sources: [], today: START }).diffs.some((x) => x.code === 'SOURCE_MISSING')).toBe(true)
  })

  it('漂移阻断 ready 并逐项列出差异；保留旧内容不静默重排', () => {
    const d = readyDraft()
    const docs = [...freshDocs(), occDoc('p-new', { task_id: 't-2', planned_minutes: 120 })]
    const freshness = checkFactFreshness(d, { docs, sources: [], today: START })
    const r = deriveReadiness(d, { thread, live, freshness })
    expect(r.ready).toBe(false)
    expect(r.blockers.some((b) => b.code === 'OCCUPANCY_ADDED')).toBe(true)
    expect(d.planning_input.occupancy).toEqual([])
  })
})

describe('R2 内容指纹剥离核对时刻（同输入重排不增版）', () => {
  it('仅 fact_baseline.captured_at 不同 → 指纹相同，非实质修改', () => {
    const d = readyDraft()
    const later = { ...d, fact_baseline: { ...d.fact_baseline, captured_at: TS2 } }
    expect(contentFingerprint(d)).toBe(contentFingerprint(later))
    expect(isSubstantiveChange(d, later)).toBe(false)
  })

  it('真实事实变化（task_facts/occupancy）仍被检测 → 指纹不同', () => {
    const d = readyDraft()
    expect(isSubstantiveChange(d, { ...d, fact_baseline: { ...d.fact_baseline, task_facts: [mkFact('t-1', { status: 'done' })] } })).toBe(true)
    expect(isSubstantiveChange(d, { ...d, fact_baseline: { ...d.fact_baseline, occupancy: [mkOcc('p-1', { task_id: 't-1' })] } })).toBe(true)
  })

  it('仅 captured_at 变化的保存不 bump；版本上限下无变化重试仍成功', () => {
    const d = readyDraft()
    const r = applyContentEdit(d, { fact_baseline: { ...d.fact_baseline, captured_at: TS2 } }, TS2)
    expect(r.ok).toBe(true)
    expect(r.bumped).toBe(false)
    const hist = Array.from({ length: 19 }, (_, i) => ({ revision: i + 1, proposal: null, planning_input: null, planning_result: null, requirements: [], created_at: TS }))
    const cap = readyDraft({ revision: 20, revision_history: hist })
    const rc = applyContentEdit(cap, { fact_baseline: { ...cap.fact_baseline, captured_at: TS2 } }, TS2)
    expect(rc.ok).toBe(true)
    expect(rc.bumped).toBe(false)
    expect(cap.revision).toBe(20)
  })
})

describe('R3 合法缺口确认后可 ready（complete 保持算法原值）', () => {
  const gapDraft = () => {
    const input = mkInput({ budgets: [30, 0, 0, 0, 0, 0, 0], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })] })
    return readyDraft({ planning_input: input, planning_result: scheduleDaily(input) })
  }

  it('无确认 / 旧版确认 仍阻断；合法当前确认 → ready 且 complete 仍 false', () => {
    const dg = gapDraft()
    expect(dg.planning_result.complete).toBe(false)
    expect(deriveReadiness(dg, { thread, live }).ready).toBe(false)
    const old = { ...dg, revision: 2, user_confirmations: [conf({ object_type: 'gap', object_id_or_key: 'w1', draft_revision: 1 })] }
    expect(deriveReadiness(old, { thread, live }).blockers.some((b) => b.code === 'GAP_UNCONFIRMED')).toBe(true)
    const ok = { ...dg, user_confirmations: [conf({ object_type: 'gap', object_id_or_key: 'w1' })] }
    const r = deriveReadiness(ok, { thread, live })
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
    expect(ok.planning_result.complete).toBe(false)
  })

  it('混有硬冲突 / 未知估时：缺口已确认仍各自阻断（不删完整性检查）', () => {
    const dg = gapDraft()
    const ok = { ...dg, user_confirmations: [conf({ object_type: 'gap', object_id_or_key: 'w1' })] }
    const mixed = { ...ok, planning_result: { ...ok.planning_result, conflicts: [{ code: 'hard_constraint_violation', message: '虚构', related_keys: [] }] } }
    expect(deriveReadiness(mixed, { thread, live }).blockers.some((b) => b.code === 'HARD_CONFLICT')).toBe(true)
    expect(deriveReadiness(mixed, { thread, live }).ready).toBe(false)
    const unknownInput = mkInput({ budgets: [30, 0, 0, 0, 0, 0, 0], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } }), mkWork('w2', { remaining_minutes: null, action_ref: { kind: 'existing', id: 'a-1' } })] })
    const du = readyDraft({ planning_input: unknownInput, planning_result: scheduleDaily(unknownInput), user_confirmations: [conf({ object_type: 'gap', object_id_or_key: 'w1' })] })
    expect(deriveReadiness(du, { thread, live }).blockers.some((b) => b.code === 'ESTIMATE_UNKNOWN')).toBe(true)
    expect(deriveReadiness(du, { thread, live }).ready).toBe(false)
  })
})

describe('线程消息限额', () => {
  const msg = (id, content = '虚构消息') => ({ id, role: 'user', content, type: 'text', refs: [], created_at: TS })

  it('追加基于传入最新对象；200 条/16000 字符/重复 id 拒绝且原线程不变', () => {
    const t0 = { ...thread }
    const r = appendThreadMessage(t0, msg('m1'))
    expect(r.ok).toBe(true)
    expect(r.thread.messages).toHaveLength(1)
    expect(t0.messages).toHaveLength(0)
    expect(appendThreadMessage(r.thread, msg('m1')).errors.some((e) => e.code === 'MESSAGE_DUP')).toBe(true)
    expect(appendThreadMessage(t0, msg('m2', '字'.repeat(16001))).errors.some((e) => e.code === 'MESSAGE_TOO_LONG')).toBe(true)
    const full = { ...thread, messages: Array.from({ length: 200 }, (_, i) => msg(`m${i}`)) }
    expect(appendThreadMessage(full, msg('m-extra')).errors.some((e) => e.code === 'THREAD_FULL')).toBe(true)
    expect(checkThreadBounds(full)).toEqual([])
  })
})