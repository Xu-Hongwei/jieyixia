// M3 改排领域规则单测（全部虚构数据）：替换资格/保护原因、范围校验、基线捕获与复核、
// 手工清单→建议、预览三块。负向用例不删除、不放宽；任何漂移整体拒绝。
import { describe, expect, it } from 'vitest'
import {
  replacementEligibility, PROTECTION_LABELS, validateReplanScope, planItemSnapshot,
  captureReplacementBaseline, checkReplacementBaseline, buildReplanProposal, replanPreview,
  replanRowsSignature, replanDraftSignature,
} from '../domains/assistant/replan.js'
import { windowDates } from '../domains/planning/protocol.js'
import { beijingAddDays } from '../domains/time.js'

const START = '2026-11-24'
const TS = '2026-11-24T10:00:00+08:00'
const D = (n) => beijingAddDays(START, n)
const P = (id, over = {}) => ({
  id, kind: 'plan_item', workspace_id: 'w1', task_id: 't-1', date: START,
  planned_minutes: 30, action_text: '虚构安排', state: 'planned', order: 0,
  actual_minutes: null, focus_session_id: null, task_ref_state: 'active', ...over,
})
const ctx = (over = {}) => ({
  workspaceId: 'w1', task: { id: 't-1', status: 'todo' }, today: START,
  window: new Set(windowDates(START)), planItems: [P('p-1')], focusSessions: [], ...over,
})
const scope = (ids = ['p-1']) => ({ task_id: 't-1', start_date: START, replacement_ids: ids })

describe('replacementEligibility：受保护原因逐项', () => {
  it('合格基线', () => {
    expect(replacementEligibility(P('p-1'), ctx())).toEqual({ eligible: true, reason: null })
  })
  const cases = [
    ['不是安排记录', { kind: 'note' }, {}, 'NOT_PLAN_ITEM'],
    ['其它空间', { workspace_id: 'w2' }, {}, 'OTHER_WORKSPACE'],
    ['其它任务', { task_id: 't-2' }, {}, 'OTHER_TASK'],
    ['任务不存在', {}, { task: undefined }, 'TASK_MISSING'],
    ['任务已完成', {}, { task: { id: 't-1', status: 'done' } }, 'TASK_DONE'],
    ['窗口外', { date: D(7) }, {}, 'OUT_OF_WINDOW'],
    ['早于今天（窗口内）', { date: D(1) }, { today: D(2) }, 'PAST_DATE'],
    ['非 planned 状态', { state: 'done' }, {}, 'NOT_PLANNED'],
    ['任务引用已删除', { task_ref_state: 'deleted' }, {}, 'TASK_REF_DELETED'],
    ['有投入（正数）', { actual_minutes: 10 }, {}, 'HAS_ACTUAL'],
    ['投入 0 也不自动当成从未执行', { actual_minutes: 0 }, {}, 'HAS_ACTUAL'],
    ['快捷专注字段', { focus_session_id: 'f-1' }, {}, 'HAS_FOCUS_SHORTCUT'],
  ]
  for (const [name, over, ctxOver, reason] of cases) {
    it(name, () => {
      const r = replacementEligibility(P('p-1', over), ctx(ctxOver))
      expect(r.eligible).toBe(false)
      expect(r.reason).toBe(reason)
      expect(PROTECTION_LABELS[reason]).toBeTruthy()
    })
  }
  for (const state of ['running', 'paused', 'ended']) {
    it(`FocusSession 反查（${state}）都算引用`, () => {
      const r = replacementEligibility(P('p-1'), ctx({ focusSessions: [{ id: 'f-1', plan_item_id: 'p-1', state }] }))
      expect(r).toEqual({ eligible: false, reason: 'HAS_FOCUS_SESSION' })
    })
  }
  it('其它安排的会话不影响本条', () => {
    const r = replacementEligibility(P('p-1'), ctx({ focusSessions: [{ id: 'f-1', plan_item_id: 'p-2', state: 'running' }] }))
    expect(r.eligible).toBe(true)
  })
})

describe('validateReplanScope：去重拒绝、1..100、逐条资格', () => {
  it('合法选择返回合格条目（保持顺序）', () => {
    const items = validateReplanScope(scope(['p-1']), ctx())
    expect(items.map((i) => i.id)).toEqual(['p-1'])
  })
  it('空集拒绝', () => expect(() => validateReplanScope(scope([]), ctx())).toThrow(/1\.\.100/))
  it('超 100 拒绝', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `p-${i}`)
    expect(() => validateReplanScope(scope(ids), ctx())).toThrow(/1\.\.100/)
  })
  it('重复 ID 拒绝（不静默去重）', () => {
    expect(() => validateReplanScope(scope(['p-1', 'p-1']), ctx())).toThrow(/重复/)
  })
  it('快照缺失拒绝', () => {
    expect(() => validateReplanScope(scope(['p-ghost']), ctx())).toThrow(/不在当前快照/)
  })
  it('受保护项拒绝并给出原因', () => {
    const c = ctx({ planItems: [P('p-1', { actual_minutes: 5 })] })
    expect(() => validateReplanScope(scope(['p-1']), c)).toThrow(/已有投入记录/)
  })
  it('缺少目标任务拒绝', () => {
    expect(() => validateReplanScope({ start_date: START, replacement_ids: ['p-1'] }, ctx())).toThrow(/缺少目标任务/)
  })
})

describe('captureReplacementBaseline / checkReplacementBaseline', () => {
  const capture = (c = ctx()) => captureReplacementBaseline({ scope: scope(), now: TS, ...c })
  it('捕获完整语义快照 + 会话全集', () => {
    const b = capture(ctx({ focusSessions: [{ id: 'f-9', plan_item_id: 'p-other', state: 'ended' }] }))
    expect(b.captured_at).toBe(TS)
    expect(b.items).toEqual([planItemSnapshot(P('p-1'))])
    expect(b.focus_session_ids).toEqual(['f-9'])
  })
  it('无漂移 fresh', () => {
    const b = capture()
    expect(checkReplacementBaseline(b, { ...ctx(), scope: scope() })).toEqual({ fresh: true, diffs: [] })
  })
  it('基线缺失', () => {
    const r = checkReplacementBaseline(null, ctx())
    expect(r.fresh).toBe(false)
    expect(r.diffs[0].code).toBe('REPLACEMENT_BASELINE_MISSING')
  })
  it('内容变化（分钟数）整体拒绝', () => {
    const b = capture()
    const c = ctx({ planItems: [P('p-1', { planned_minutes: 99 })] })
    const r = checkReplacementBaseline(b, { ...c, scope: scope() })
    expect(r.fresh).toBe(false)
    expect(r.diffs.some((d) => d.code === 'REPLACEMENT_CONTENT_CHANGED')).toBe(true)
  })
  it('captured_at 不参与内容比较（仅时钟变化不报漂移）', () => {
    const b = capture()
    const r = checkReplacementBaseline({ ...b, captured_at: '2026-11-24T11:00:00+08:00' }, { ...ctx(), scope: scope() })
    expect(r.fresh).toBe(true)
  })
  it('新增会话引用所选安排 → 整体拒绝', () => {
    const b = capture()
    const c = ctx({ focusSessions: [{ id: 'f-new', plan_item_id: 'p-1', state: 'running' }] })
    const r = checkReplacementBaseline(b, { ...c, scope: scope() })
    expect(r.diffs.some((d) => d.code === 'REPLACEMENT_SESSION_REFERENCED')).toBe(true)
  })
  it('所选安排被删除', () => {
    const b = capture()
    const r = checkReplacementBaseline(b, { ...ctx({ planItems: [] }), scope: scope() })
    expect(r.diffs.some((d) => d.code === 'REPLACEMENT_ITEM_MISSING')).toBe(true)
  })
  it('所选安排不再合格（出现投入）', () => {
    const b = capture()
    const c = ctx({ planItems: [P('p-1', { actual_minutes: 1 })] })
    const r = checkReplacementBaseline(b, { ...c, scope: scope() })
    expect(r.diffs.some((d) => d.code === 'REPLACEMENT_INELIGIBLE')).toBe(true)
  })
  it('窗口过期（today 晚于起始日）', () => {
    const b = capture()
    const r = checkReplacementBaseline(b, { ...ctx(), today: D(1), scope: scope() })
    expect(r.diffs.some((d) => d.code === 'WINDOW_STALE')).toBe(true)
  })
  it('目标任务完成/消失', () => {
    const b = capture()
    expect(checkReplacementBaseline(b, { ...ctx(), task: { id: 't-1', status: 'done' }, scope: scope() }).diffs.some((d) => d.code === 'TASK_DONE')).toBe(true)
    expect(checkReplacementBaseline(b, { ...ctx(), task: undefined, scope: scope() }).diffs.some((d) => d.code === 'TASK_MISSING')).toBe(true)
  })
})

describe('buildReplanProposal：手工清单→建议（本地闭环）', () => {
  const task = { id: 't-1', status: 'todo' }
  const actions = [
    { id: 'a-1', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false },
    { id: 'a-done', task_id: 't-1', text: '已完成', minutes: 30, done: true },
    { id: 'a-2', task_id: 't-2', text: '其它任务步骤', minutes: 40, done: false },
  ]
  const row = (over = {}) => ({ key: 'rw1', text: '写报告', reuse_action_id: null, minutes: 90, splittable: true, min_segment_minutes: 25, ...over })
  const progress = (rows) => ({ statement: '资料读完了', work_items: rows })

  it('新行动：用户分钟数权威（estimate_origin=user），只 link 目标任务', () => {
    const p = buildReplanProposal(progress([row()]), task, actions)
    expect(p.task_proposals).toEqual([{ op: 'link', key: 'rtask', target_id: 't-1', evidence_refs: [] }])
    expect(p.action_proposals[0]).toMatchObject({ op: 'create', task_ref: { kind: 'existing', id: 't-1' }, text: '写报告', minutes: 90 })
    expect(p.work_items[0]).toMatchObject({
      key: 'rw1', task_ref: { kind: 'existing', id: 't-1' }, remaining_minutes: 90, estimate_origin: 'user',
    })
    expect(p.work_items[0].action_ref).toEqual({ kind: 'draft', key: p.action_proposals[0].key })
  })
  it('复用未完成行动：分钟数可未知（null → 缺口，不默认 0）', () => {
    const p = buildReplanProposal(progress([row({ reuse_action_id: 'a-1', minutes: null })]), task, actions)
    expect(p.action_proposals[0]).toMatchObject({ op: 'reuse', target_id: 'a-1' })
    expect(p.work_items[0].action_ref).toEqual({ kind: 'existing', id: 'a-1' })
    expect(p.work_items[0].remaining_minutes).toBeNull()
  })
  it('新行动分钟数未知 → 拒绝（不伪造估时）', () => {
    expect(() => buildReplanProposal(progress([row({ minutes: null })]), task, actions)).toThrow(/分钟数未知/)
  })
  it('复用已完成行动 → 拒绝', () => {
    expect(() => buildReplanProposal(progress([row({ reuse_action_id: 'a-done' })]), task, actions)).toThrow(/已完成行动/)
  })
  it('复用其它任务行动 → 拒绝', () => {
    expect(() => buildReplanProposal(progress([row({ reuse_action_id: 'a-2' })]), task, actions)).toThrow(/不属于目标任务/)
  })
  it('空清单 → 拒绝', () => {
    expect(() => buildReplanProposal(progress([]), task, actions)).toThrow(/工作清单/)
  })
  it('已完成任务 → 拒绝', () => {
    expect(() => buildReplanProposal(progress([row()]), { id: 't-1', status: 'done' }, actions)).toThrow(/已完成/)
  })
  it('用户 key 与生成 key 冲突时自动避让', () => {
    const p = buildReplanProposal(progress([row({ key: 'nact1' }), row({ key: 'rw2', text: '第二步' })]), task, actions)
    const keys = p.action_proposals.map((a) => a.key)
    expect(keys).not.toContain('nact1')
    expect(new Set(keys).size).toBe(keys.length)
    expect(p.work_items.map((w) => w.key)).toEqual(['nact1', 'rw2'])
  })

  it('约束随清单保留：最早日期/依赖/优先级写入工作项', () => {
    const rows2 = [row({ key: 'rw1' }), row({ key: 'rw2', text: '第二步', minutes: 60 })]
    const cs = [
      { earliest_date: '2026-11-28', depends_on: [], priority: 'high' },
      { earliest_date: null, depends_on: ['rw1'], priority: 'normal' },
    ]
    const p = buildReplanProposal(progress(rows2), task, actions, cs)
    expect(p.work_items[0]).toMatchObject({ earliest_date: '2026-11-28', depends_on: [], priority: 'high' })
    expect(p.work_items[1]).toMatchObject({ earliest_date: null, depends_on: ['rw1'], priority: 'normal' })
  })
  it('缺省约束保持旧行为（无最早日期/依赖/普通优先级）', () => {
    const p = buildReplanProposal(progress([row({ earliest_date: '2026-11-28', depends_on: ['rw1'], priority: 'high' })]), task, actions)
    expect(p.work_items[0]).toMatchObject({ earliest_date: null, depends_on: [], priority: 'normal' })
  })
  const badCases = [
    ['最早日期非法', [{ earliest_date: '2026-02-30' }], /最早日期/],
    ['优先级非法', [{ priority: 'urgent' }], /优先级/],
    ['依赖指向清单外', [{ depends_on: ['rw9'] }], /不在本次清单/],
    ['依赖自身', [{ depends_on: ['rw1'] }], /不得依赖自身/],
    ['依赖重复', [{ depends_on: ['rw1', 'rw1'] }], /重复/],
  ]
  for (const [name, cs, re] of badCases) {
    it(`${name} → 拒绝（不静默清空）`, () => {
      expect(() => buildReplanProposal(progress([row()]), task, actions, cs)).toThrow(re)
    })
  }
  it('依赖成环 → 拒绝', () => {
    const rows2 = [row({ key: 'rw1' }), row({ key: 'rw2', text: '第二步' })]
    const cs = [{ depends_on: ['rw2'] }, { depends_on: ['rw1'] }]
    expect(() => buildReplanProposal(progress(rows2), task, actions, cs)).toThrow(/成环/)
  })
})

describe('replanRowsSignature / replanDraftSignature：统一输入版本', () => {
  const base = () => ({
    replacementIds: ['p-2', 'p-1'], statement: ' 资料读完 ',
    rows: [{ text: '写报告', minutes: '90', reuse: '', splittable: true, minSeg: '', earliest: '', priority: 'normal', depsText: '' }],
  })
  it('范围顺序不敏感；空最小段与 25 等价；说明去首尾空白', () => {
    const a = replanRowsSignature(base())
    const b = replanRowsSignature({ ...base(), replacementIds: ['p-1', 'p-2'], statement: '资料读完', rows: [{ ...base().rows[0], minSeg: '25' }] })
    expect(a).toBe(b)
  })
  it('分钟/复用/拆分/最早/优先级/依赖任一变化都会改变签名', () => {
    const a = replanRowsSignature(base())
    const variants = [
      { minutes: '180' }, { reuse: 'a-1' }, { splittable: false }, { earliest: '2026-11-28' },
      { priority: 'high' }, { depsText: '1' },
    ]
    for (const v of variants) {
      const s = replanRowsSignature({ ...base(), rows: [{ ...base().rows[0], ...v }] })
      expect(s, JSON.stringify(v)).not.toBe(a)
    }
  })
  it('草案签名按用户来源建议读回约束；模型建议不并入', () => {
    const draftWith = (origin) => ({
      replan_scope: { replacement_ids: ['p-1'] },
      progress_input: { statement: '资料读完', work_items: [
        { key: 'rw1', text: '写报告', reuse_action_id: null, minutes: 90, splittable: true, min_segment_minutes: 25 },
        { key: 'rw2', text: '第二步', reuse_action_id: null, minutes: 60, splittable: true, min_segment_minutes: 25 },
      ] },
      proposal: { work_items: [
        { key: 'rw1', deliverable: '写报告', remaining_minutes: 90, estimate_origin: origin, earliest_date: '2026-11-28', depends_on: [], priority: 'high', splittable: true, min_segment_minutes: 25 },
        { key: 'rw2', deliverable: '第二步', remaining_minutes: 60, estimate_origin: origin, earliest_date: null, depends_on: ['rw1'], priority: 'normal', splittable: true, min_segment_minutes: 25 },
      ] },
    })
    const rows = (earliest, priority, deps2) => [
      { text: '写报告', minutes: '90', reuse: '', splittable: true, minSeg: '25', earliest, priority, depsText: '' },
      { text: '第二步', minutes: '60', reuse: '', splittable: true, minSeg: '25', earliest: '', priority: 'normal', depsText: deps2 },
    ]
    // 用户来源建议：签名应等于带约束的当前面板，而未保存前修改（清空最早日期）即 dirty。
    const saved = replanDraftSignature(draftWith('user'))
    expect(saved).toBe(replanRowsSignature({ replacementIds: ['p-1'], statement: '资料读完', rows: rows('2026-11-28', 'high', '1') }))
    expect(replanRowsSignature({ replacementIds: ['p-1'], statement: '资料读完', rows: rows('', 'high', '1') })).not.toBe(saved)
    // 模型建议：签名不并入约束（提示未核对，不得冒充已确认清单）。
    const modelSig = replanDraftSignature(draftWith('model'))
    expect(modelSig).toBe(replanRowsSignature({ replacementIds: ['p-1'], statement: '资料读完', rows: rows('', 'normal', '') }))
  })
})

describe('replanPreview：保留/取消/新增三块', () => {
  it('窗口内未选安排保留（含其它任务）；基线覆盖取消；排程段新增', () => {
    const baseline = { items: [planItemSnapshot(P('p-1'))] }
    const planItems = [P('p-1'), P('p-keep', { date: D(1) }), P('p-other', { task_id: 't-2' }), P('p-out', { date: D(9) })]
    const segments = [{ segment_key: 'rw1#1', work_item_key: 'rw1', date: START, minutes: 90 }]
    const r = replanPreview({ baseline, segments, planItems, scope: scope() })
    expect(r.cancel).toEqual(baseline.items)
    expect(r.create).toEqual(segments)
    expect(r.kept.map((p) => p.id)).toEqual(['p-keep', 'p-other'])
    expect(r.replacedCount).toBe(1)
    expect(r.keptCount).toBe(2)
  })
})