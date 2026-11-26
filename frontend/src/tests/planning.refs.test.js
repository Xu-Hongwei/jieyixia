// B1-09：非法引用/语义回归（R1–R4 跨入 JS）+ 组装层澄清/要求/别名/占用口径。
// f-sem/f-model/f-compat/f-plan 冻结 fixture 直接驱动 JS 实现（fixture 只作数据读取）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizePlanningContext } from '../domains/planning/normalize.js'
import { validatePlanningInput, scheduleDaily } from '../domains/planning/schedule.js'
import { beijingAddDays } from '../domains/time.js'
import { START, mkFact, mkWork, mkInput, mkSnapshot, mkProposal, mkContext, EV_SRC, EV_USER } from './planning.helpers.js'

const FIX = new URL('../../../contract/proposals/assistant-v1/fixtures/', import.meta.url)
const load = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIX), 'utf8'))
const D = (n) => beijingAddDays(START, n)
const mkReq = (type, value, over = {}) => ({
  requirement_id: `req-${type}`, version: 1, type, value, strength: 'hard',
  confirmed_at: `${START}T08:00:00+08:00`, evidence_refs: [EV_USER], ...over,
})
const norm = (proposal, over = {}, requirements = [], options = {}) =>
  normalizePlanningContext(mkSnapshot(over), proposal, requirements, mkContext(), options)

describe('B1-09 冻结 model_semantics fixture × normalize（R3/R4 跨入 JS）', () => {
  const index = load('index')
  const semCases = index.cases.filter((c) => c.file.startsWith('f-sem-'))
  it('语义样本数量冻结一致（16 份）', () => expect(semCases.length).toBe(16))
  for (const c of semCases) {
    const f = load(c.id)
    it(`${f.id}（${f.mode}）`, () => {
      const snapshot = { ...f.payload.context, plan_items: [] }
      if (f.mode === 'accept') {
        // R4 整改：有值截止候选被工作项引用且未确认 → 组装层澄清（提案层 accept 不变）。
        if (f.id === 'f-sem-multi-deadline-targets') {
          const pending = normalizePlanningContext(snapshot, f.payload.proposal, [], mkContext())
          expect(pending.ok).toBe(false)
          expect(pending.input).toBeNull()
          expect(pending.clarifications[0].question_id).toBe('q-deadline-confirm')
          const confirm = (key, value) => ({
            confirmation_id: `cf-${key}`, draft_revision: 1, object_type: 'task', object_id_or_key: key,
            id_scope: 'draft', field_path: 'deadline', old_value: null, new_value: { value, precision: 'date' },
            confirmed_at: `${START}T08:00:00+08:00`,
          })
          const out = normalizePlanningContext(snapshot, f.payload.proposal, [], mkContext(), {
            taskDeadlineConfirmations: [confirm('t-a', '2026-11-27'), confirm('t-b', '2026-11-29')],
          })
          expect(out.ok).toBe(true)
          expect(out.input.task_facts.map((x) => x.deadline_value).sort()).toEqual(['2026-11-27', '2026-11-29'])
          return
        }
        const out = normalizePlanningContext(snapshot, f.payload.proposal, [], mkContext())
        expect(out.ok).toBe(true)
        expect(out.input).not.toBeNull()
      } else {
        expect(() => normalizePlanningContext(snapshot, f.payload.proposal, [], mkContext())).toThrow(f.expected_error)
      }
    })
  }
})

describe('B1-09 冻结结构 fixture × normalize/validatePlanningInput', () => {
  const wrap = (f) => {
    const p = f.payload
    if (f.target === 'AssistantModelProposal') return p
    if (f.target === 'WorkItemProposal') return mkProposal({ work_items: [p] })
    if (f.target === 'TaskProposalCreate') return mkProposal({ task_proposals: [p] })
    if (f.target === 'ActionProposalReuse') return mkProposal({ action_proposals: [p] })
    if (f.target === 'RequirementCandidate') return mkProposal({ requirement_candidates: [p] })
    throw new Error(`未覆盖目标 ${f.target}`)
  }
  const cases = [
    ['f-model-remaining-zero', /不能用 0/],
    ['f-model-remaining-negative', /正安全整数/],
    ['f-model-reuse-draft-taskref', /必须是 existing/],
    ['f-model-create-target-id', /未批准字段/],
    ['f-model-dup-keys', /全局唯一/],
    ['f-model-bad-date', /earliest_date/],
    ['f-model-requirement-budget-bad', /0–1440/],
    ['f-model-requirement-budget-null', null],
  ]
  for (const [id, re] of cases) {
    const f = load(id)
    it(`${id}（${f.mode}）`, () => {
      if (re) expect(() => norm(wrap(f))).toThrow(re)
      else expect(norm(wrap(f)).ok).toBe(true)
    })
  }
})

describe('R1 既有事实宽松口径 × 新候选严格口径', () => {
  const compat = ['f-compat-planfact-no-seconds', 'f-compat-planfact-fractional', 'f-compat-planfact-bad-offset']
  for (const id of compat) {
    const f = load(id)
    it(`${id}（${f.mode}）：旧格式可读且原值不改写`, () => {
      const input = mkInput({ facts: [f.payload] })
      if (f.mode === 'accept') {
        expect(() => scheduleDaily(input)).not.toThrow()
        expect(input.task_facts[0].deadline_value).toBe(f.payload.deadline_value)
        expect(input.task_facts[0].deadline_precision).toBe(f.payload.deadline_precision)
      } else {
        expect(() => validatePlanningInput(input)).toThrow(f.expected_error)
      }
    })
  }

  it('快照无秒截止进入组装事实，原值逐字保留', () => {
    const out = norm(mkProposal(), {
      tasks: [{ id: 't-1', workspace_id: 'ws-fixture', title: '虚构', status: 'todo', deadline: { value: '2026-11-26T09:00', precision: 'datetime' } }],
    })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0].deadline_value).toBe('2026-11-26T09:00')
  })

  it('模型新候选 datetime 无秒被拒（严格口径不放宽）', () => {
    const proposal = mkProposal({
      task_proposals: [{
        op: 'create', key: 't-new', title: '虚构新目标',
        deadline_candidates: [{ value: '2026-11-27T09:00', precision: 'datetime', evidence_refs: [EV_SRC] }],
      }],
    })
    expect(() => norm(proposal)).toThrow(/规范 datetime/)
  })
})

describe('B1-09 冻结 planning fixture × validatePlanningInput', () => {
  const cases = [
    ['f-plan-budget-null', /null 不得进入排程/],
    ['f-plan-budget-over', /1440/],
    ['f-plan-buffer-over', /50/],
    ['f-plan-horizon-6', /7/],
    ['f-plan-tz-wrong', /Asia\/Shanghai/],
    ['f-plan-unknown-dep', /未知工作项/],
    ['f-plan-cycle', /依赖环/],
    ['f-plan-dup-occupancy', /不双计/],
    ['f-plan-planned-deleted', /不可信/],
    // M3：该冻结样本的替换集已收窄为 101 条，命中契约上限 100；非空正例在同组内联构造。
    ['f-plan-replacement-nonempty', /replacement_ids 最多 100/],
    ['f-plan-extra-work-missing', /额外尚未安排工作/],
    ['f-plan-extra-work-ok', null],
  ]
  for (const [id, re] of cases) {
    const f = load(id)
    it(`${id}（${f.mode}）`, () => {
      if (re) expect(() => validatePlanningInput(f.payload)).toThrow(re)
      else expect(() => validatePlanningInput(f.payload)).not.toThrow()
    })
  }
  it('非空替换集（未超限、占用无重叠）合法', () => {
    const f = load('f-plan-replacement-nonempty')
    expect(() => validatePlanningInput({ ...f.payload, replacement_ids: ['p-0', 'p-1'] })).not.toThrow()
  })
})

describe('合法别名：link/update draft key 解析到真实既有 Task', () => {
  it('两个 draft key 指向同一 Task：事实去重为一个，不拆成两个任务', () => {
    const proposal = mkProposal({
      task_proposals: [
        { op: 'link', key: 'tk-a', target_id: 't-1', evidence_refs: [] },
        { op: 'link', key: 'tk-b', target_id: 't-1', evidence_refs: [] },
      ],
      action_proposals: [{ op: 'reuse', key: 'a-re', target_id: 'a-1', task_ref: { kind: 'draft', key: 'tk-a' }, evidence_refs: [] }],
      work_items: [
        mkWork('w1', { task_ref: { kind: 'draft', key: 'tk-a' }, action_ref: { kind: 'existing', id: 'a-1' }, remaining_minutes: 30 }),
        mkWork('w2', { task_ref: { kind: 'draft', key: 'tk-b' }, action_ref: { kind: 'existing', id: 'a-1' }, remaining_minutes: 30 }),
      ],
    })
    const out = norm(proposal)
    expect(out.ok).toBe(true)
    expect(out.input.task_facts.length).toBe(1)
    expect(out.input.task_facts[0].task_ref).toEqual({ kind: 'existing', id: 't-1' })
    for (const w of out.input.work_items) expect(w.task_ref).toEqual({ kind: 'existing', id: 't-1' })
    const r = scheduleDaily(out.input)
    expect(r.complete).toBe(true)
  })

  it('update 别名同样解析；按名字合并是不允许的（不同 ID 仍是两个任务）', () => {
    const proposal = mkProposal({
      task_proposals: [{ op: 'update', key: 'tk-u', target_id: 't-1', changes: { title: '虚构改名' }, evidence_refs: [] }],
      work_items: [
        mkWork('w1', { task_ref: { kind: 'draft', key: 'tk-u' }, action_ref: { kind: 'existing', id: 'a-1' }, remaining_minutes: 30 }),
        mkWork('w2', { task_ref: { kind: 'existing', id: 't-2' }, action_ref: { kind: 'existing', id: 'a-2' }, remaining_minutes: 30 }),
      ],
    })
    const out = norm(proposal)
    expect(out.ok).toBe(true)
    expect(out.input.task_facts.length).toBe(2)
  })
})

describe('组装层：澄清/已确认要求/占用/排除', () => {
  it('已完成目标拒绝作为新工作投入', () => {
    expect(() => norm(mkProposal(), {
      tasks: [{ id: 't-1', workspace_id: 'ws-fixture', title: '虚构', status: 'done', deadline: { value: null, precision: 'none' } }],
    })).toThrow(/已完成目标/)
  })

  it('D12：窗口已有安排未确认 → 澄清；确认后进入输入', () => {
    const over = { plan_items: [{ id: 'p-1', task_id: 't-1', date: START, planned_minutes: 30, state: 'planned' }] }
    const out = norm(mkProposal(), over)
    expect(out.ok).toBe(false)
    expect(out.input).toBeNull()
    expect(out.clarifications[0].question_id).toBe('q-extra-work')
    // M2 修复：额外工作阻断排程，澄清须带结构化键供界面排程前逐项确认（不靠解析问题文本）。
    expect(out.clarifications[0].blocking_reason).toBe('extra_work_needs_confirmation')
    expect(out.clarifications[0].work_item_keys).toEqual(['w1'])
    const acked = norm(mkProposal(), over, [], { extraWorkAcknowledged: ['w1'] })
    expect(acked.ok).toBe(true)
    expect(acked.input.extra_work_acknowledged).toEqual(['w1'])
    expect(acked.input.occupancy.length).toBe(1)
  })

  it('null 预算 → 澄清；daily_budget 只填 null 日，显式日优先', () => {
    const ctx = mkContext([60, null, 60, 60, 60, 60, 60])
    const out = normalizePlanningContext(mkSnapshot(), mkProposal(), [], ctx)
    expect(out.ok).toBe(false)
    expect(out.clarifications[0].question_id).toBe('q-daily-budget')
    const filled = normalizePlanningContext(mkSnapshot(), mkProposal(), [mkReq('daily_budget', 90)], ctx)
    expect(filled.ok).toBe(true)
    expect(filled.input.days[0].budget_minutes).toBe(60)
    expect(filled.input.days[1].budget_minutes).toBe(90)
  })

  it('unavailable_days 置 0；min_segment/splittable/task_priority 覆盖生效', () => {
    const reqs = [
      mkReq('unavailable_days', [D(2)]),
      mkReq('min_segment_minutes', 40),
      mkReq('splittable', { work_item_key: 'w1', splittable: false }),
      mkReq('task_priority', { task_ref: { kind: 'existing', id: 't-1' }, priority: 'high' }),
    ]
    const out = norm(mkProposal(), {}, reqs)
    expect(out.ok).toBe(true)
    expect(out.input.days[2].budget_minutes).toBe(0)
    expect(out.input.work_items[0]).toMatchObject({ min_segment_minutes: 40, splittable: false, priority: 'high' })
  })

  it('ordering 要求追加依赖；双向 ordering 成环被拒', () => {
    const proposal = mkProposal({
      work_items: [
        mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' }, remaining_minutes: 30 }),
        mkWork('w2', { action_ref: { kind: 'existing', id: 'a-1' }, remaining_minutes: 30 }),
      ],
    })
    const out = norm(proposal, {}, [mkReq('ordering', { before_key: 'w1', after_key: 'w2' })])
    expect(out.ok).toBe(true)
    expect(out.input.work_items.find((w) => w.key === 'w2').depends_on).toEqual(['w1'])
    expect(() => norm(proposal, {}, [
      mkReq('ordering', { before_key: 'w1', after_key: 'w2' }, { requirement_id: 'req-o1' }),
      mkReq('ordering', { before_key: 'w2', after_key: 'w1' }, { requirement_id: 'req-o2' }),
    ])).toThrow(/依赖环/)
  })

  it('确认起始日与窗口不一致 → 澄清，不擅自改窗口', () => {
    const out = norm(mkProposal(), {}, [mkReq('start_date', D(1))])
    expect(out.ok).toBe(false)
    expect(out.clarifications[0].question_id).toBe('q-start-date')
  })

  it('占用按 ID 去重；同 ID 内容矛盾报错；未选中任务占用保留', () => {
    const item = { id: 'p-1', task_id: 't-2', date: START, planned_minutes: 30, state: 'planned' }
    const dedup = norm(mkProposal(), { plan_items: [item, { ...item }] })
    expect(dedup.ok).toBe(true)
    expect(dedup.input.occupancy.length).toBe(1)
    expect(dedup.input.occupancy[0].task_id).toBe('t-2')
    expect(() => norm(mkProposal(), { plan_items: [item, { ...item, planned_minutes: 40 }] })).toThrow(/内容矛盾/)
    const r = scheduleDaily(dedup.input)
    expect(r.days[0].committed_minutes).toBe(30)
  })

  it('planned 占用断引用（deleted）阻断，不按 0 计算', () => {
    expect(() => norm(mkProposal(), {
      plan_items: [{ id: 'p-1', task_id: 't-gone', date: START, planned_minutes: 30, state: 'planned', task_ref_state: 'deleted' }],
    })).toThrow(/不可信/)
  })

  it('新建目标的截止候选未经确认 → 澄清，不静默按无截止排程（R4）', () => {
    const proposal = mkProposal({
      task_proposals: [{
        op: 'create', key: 't-new', title: '虚构新目标',
        deadline_candidates: [{ value: D(2), precision: 'date', evidence_refs: [EV_SRC] }],
        evidence_refs: [EV_SRC],
      }],
      action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60 }],
      work_items: [mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } })],
    })
    const out = norm(proposal)
    expect(out.ok).toBe(false)
    expect(out.input).toBeNull()
    expect(out.clarifications[0].question_id).toBe('q-deadline-confirm')
    expect(out.clarifications[0].blocking_reason).toBe('deadline_needs_confirmation')
  })

  it('start_date 早于今天拒绝；排除项引用未知 key 拒绝', () => {
    const ctx = mkContext()
    ctx.today = D(1)
    expect(() => normalizePlanningContext(mkSnapshot(), mkProposal(), [], ctx)).toThrow(/不得早于/)
    expect(() => norm(mkProposal(), {}, [], { excludedItems: [{ work_item_key: 'ghost', reason: 'x' }] })).toThrow(/排除项引用未知工作项/)
  })

  it('组装产物可直接排程且过独立校验（端到端纯函数链）', () => {
    const out = norm(mkProposal())
    expect(out.ok).toBe(true)
    const r = scheduleDaily(out.input, { excludedItems: out.excludedItems })
    expect(r.complete).toBe(true)
  })
})

describe('5B-1A 整改 R1：已确认每日硬上限不得被旧日预算覆盖', () => {
  const work100 = mkProposal({ work_items: [mkWork('w1', { remaining_minutes: 100, action_ref: { kind: 'existing', id: 'a-1' } })] })

  it('硬上限小于既有日预算：取更小值，超出不排', () => {
    const ctx = mkContext([120, 0, 0, 0, 0, 0, 0])
    const out = normalizePlanningContext(mkSnapshot(), work100, [mkReq('daily_budget', 30)], ctx, { bufferPct: 0 })
    expect(out.ok).toBe(true)
    expect(out.input.days[0].budget_minutes).toBe(30)
    const r = scheduleDaily(out.input)
    expect(r.segments[0].minutes).toBe(30)
    expect(r.unscheduled).toEqual([{ work_item_key: 'w1', remaining_minutes: 70, reason: 'no_capacity' }])
  })

  it('硬上限大于既有日预算：仍取更小值（既有可用量不被放大）', () => {
    const ctx = mkContext([60, 60, 60, 60, 60, 60, 60])
    const out = normalizePlanningContext(mkSnapshot(), mkProposal(), [mkReq('daily_budget', 90)], ctx)
    expect(out.ok).toBe(true)
    expect(out.input.days.every((d) => d.budget_minutes === 60)).toBe(true)
  })

  it('未知预算日由硬上限填充，不再澄清', () => {
    const ctx = mkContext([null, null, null, null, null, null, null])
    const out = normalizePlanningContext(mkSnapshot(), mkProposal(), [mkReq('daily_budget', 30)], ctx)
    expect(out.ok).toBe(true)
    expect(out.input.days.every((d) => d.budget_minutes === 30)).toBe(true)
  })

  it('软偏好只填未知日，不覆盖既有日预算', () => {
    const ctx = mkContext([120, null, 60, 60, 60, 60, 60])
    const out = normalizePlanningContext(mkSnapshot(), mkProposal(), [mkReq('daily_budget', 30, { strength: 'soft' })], ctx)
    expect(out.ok).toBe(true)
    expect(out.input.days[0].budget_minutes).toBe(120)
    expect(out.input.days[1].budget_minutes).toBe(30)
  })

  it('硬上限与软偏好并存：硬先钳制，软不再改动', () => {
    const ctx = mkContext([120, null, 60, 60, 60, 60, 60])
    const out = normalizePlanningContext(mkSnapshot(), mkProposal(), [
      mkReq('daily_budget', 30, { strength: 'soft', requirement_id: 'req-soft' }),
      mkReq('daily_budget', 40),
    ], ctx)
    expect(out.ok).toBe(true)
    expect(out.input.days[0].budget_minutes).toBe(40)
    expect(out.input.days[1].budget_minutes).toBe(40)
  })

  it('同版本多个不同硬上限 → 澄清，不按数组先后决定', () => {
    const a = mkReq('daily_budget', 30, { requirement_id: 'req-a' })
    const b = mkReq('daily_budget', 50, { requirement_id: 'req-b' })
    for (const reqs of [[a, b], [b, a]]) {
      const out = norm(mkProposal(), {}, reqs)
      expect(out.ok).toBe(false)
      expect(out.clarifications.some((c) => c.blocking_reason === 'budget_conflict')).toBe(true)
    }
  })

  it('不同版本取最大版本，与数组先后无关', () => {
    const v1 = mkReq('daily_budget', 30, { requirement_id: 'req-v1', version: 1 })
    const v2 = mkReq('daily_budget', 50, { requirement_id: 'req-v2', version: 2 })
    for (const reqs of [[v1, v2], [v2, v1]]) {
      const out = norm(mkProposal(), {}, reqs)
      expect(out.ok).toBe(true)
      expect(out.input.days[0].budget_minutes).toBe(50)
    }
  })

  it('unavailable_days 在硬上限之后置 0，与数组先后无关', () => {
    const hard = mkReq('daily_budget', 30)
    const un = mkReq('unavailable_days', [D(1)])
    for (const reqs of [[hard, un], [un, hard]]) {
      const out = norm(mkProposal(), {}, reqs)
      expect(out.ok).toBe(true)
      expect(out.input.days[0].budget_minutes).toBe(30)
      expect(out.input.days[1].budget_minutes).toBe(0)
    }
  })

  it('非法 strength 拒绝', () => {
    expect(() => norm(mkProposal(), {}, [mkReq('daily_budget', 30, { strength: 'maybe' })])).toThrow(/strength/)
  })
})

describe('5B-1A 整改 R4：截止候选确认闭环', () => {
  const mkConfirm = (over = {}) => ({
    confirmation_id: 'cf-1', draft_revision: 1, object_type: 'task', object_id_or_key: 't-new',
    id_scope: 'draft', field_path: 'deadline', old_value: null, new_value: { value: D(2), precision: 'date' },
    confirmed_at: `${START}T08:00:00+08:00`, ...over,
  })
  const createProposal = (candidates) => mkProposal({
    task_proposals: [{
      op: 'create', key: 't-new', title: '虚构新目标',
      deadline_candidates: candidates, evidence_refs: [EV_SRC],
    }],
    action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60 }],
    work_items: [mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } })],
  })
  const cand = (value, precision = 'date') => ({ value, precision, evidence_refs: [EV_SRC] })

  it('确认合法候选值 → 成为排程事实并参与截止排序', () => {
    const out = norm(createProposal([cand(D(2))]), {}, [], { taskDeadlineConfirmations: [mkConfirm()] })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0]).toMatchObject({ deadline_value: D(2), deadline_precision: 'date' })
    expect(scheduleDaily(out.input).complete).toBe(true)
  })

  it('明确无截止（new_value=null）→ none 事实，可排程', () => {
    const out = norm(createProposal([cand(D(2))]), {}, [], { taskDeadlineConfirmations: [mkConfirm({ new_value: null })] })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0]).toMatchObject({ deadline_value: null, deadline_precision: 'none' })
  })

  it('用户修改为候选之外的合法值 → 按新值生成事实', () => {
    const out = norm(createProposal([cand(D(2))]), {}, [], {
      taskDeadlineConfirmations: [mkConfirm({ new_value: { value: D(4), precision: 'date' } })],
    })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0].deadline_value).toBe(D(4))
  })

  it('多候选未确认 → 澄清列出全部候选', () => {
    const out = norm(createProposal([cand(D(2)), cand(D(3))]))
    expect(out.ok).toBe(false)
    expect(out.clarifications[0].question).toContain(D(2))
    expect(out.clarifications[0].question).toContain(D(3))
  })

  it('多份矛盾确认 → 冲突澄清', () => {
    const out = norm(createProposal([cand(D(2))]), {}, [], {
      taskDeadlineConfirmations: [mkConfirm(), mkConfirm({ confirmation_id: 'cf-2', new_value: { value: D(3), precision: 'date' } })],
    })
    expect(out.ok).toBe(false)
    expect(out.clarifications[0].blocking_reason).toBe('deadline_confirmation_conflict')
  })

  it('草案版本不符 → 失效澄清，不采用旧确认', () => {
    const out = norm(createProposal([cand(D(2))]), {}, [], {
      draftRevision: 2, taskDeadlineConfirmations: [mkConfirm({ draft_revision: 1 })],
    })
    expect(out.ok).toBe(false)
    expect(out.clarifications[0].blocking_reason).toBe('deadline_confirmation_stale')
  })

  it('old_value 与基线不符 → 失效澄清', () => {
    const out = norm(createProposal([cand(D(2))]), {}, [], {
      taskDeadlineConfirmations: [mkConfirm({ old_value: { value: D(1), precision: 'date' } })],
    })
    expect(out.ok).toBe(false)
    expect(out.clarifications[0].blocking_reason).toBe('deadline_confirmation_stale')
  })

  it('确认新值走严格口径：datetime 无秒拒绝', () => {
    expect(() => norm(createProposal([cand(D(2))]), {}, [], {
      taskDeadlineConfirmations: [mkConfirm({ new_value: { value: `${D(2)}T09:00`, precision: 'datetime' } })],
    })).toThrow(/规范 datetime/)
  })

  it('确认记录形状约束：非 task/deadline 拒绝', () => {
    expect(() => norm(createProposal([cand(D(2))]), {}, [], {
      taskDeadlineConfirmations: [mkConfirm({ object_type: 'note_field' })],
    })).toThrow(/object_type=task/)
    expect(() => norm(createProposal([cand(D(2))]), {}, [], {
      taskDeadlineConfirmations: [mkConfirm({ field_path: 'title' })],
    })).toThrow(/field_path=deadline/)
  })

  it('无候选的新建任务不受确认门槛影响', () => {
    const out = norm(createProposal([]))
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0].deadline_precision).toBe('none')
  })

  it('同一新建任务被多个工作项引用：只产生一份澄清', () => {
    const proposal = createProposal([cand(D(2))])
    proposal.work_items.push(mkWork('w2', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } }))
    const out = norm(proposal)
    expect(out.ok).toBe(false)
    expect(out.clarifications.filter((c) => c.question_id === 'q-deadline-confirm').length).toBe(1)
  })

  const updateSnapshot = () => mkSnapshot({
    tasks: [
      { id: 't-1', workspace_id: 'ws-fixture', title: '虚构目标一', status: 'todo', deadline: { value: D(3), precision: 'date', source: 'manual', confirmed_at: `${START}T08:00:00+08:00` } },
      { id: 't-2', workspace_id: 'ws-fixture', title: '虚构目标二', status: 'todo', deadline: { value: null, precision: 'none' } },
    ],
  })
  const updateProposal = mkProposal({
    task_proposals: [{
      op: 'update', key: 't-up', target_id: 't-1',
      changes: { deadline_candidates: [cand(D(5))] }, evidence_refs: [EV_SRC],
    }],
    work_items: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })],
  })
  const updateConfirm = (newValue) => mkConfirm({
    object_id_or_key: 't-1', id_scope: 'formal', old_value: { value: D(3), precision: 'date' }, new_value: newValue,
  })

  it('update 未确认 → 澄清保留旧事实等待确认，不静默采用候选', () => {
    const out = normalizePlanningContext(updateSnapshot(), updateProposal, [], mkContext())
    expect(out.ok).toBe(false)
    expect(out.clarifications[0].question_id).toBe('q-deadline-confirm')
    expect(out.clarifications[0].question).toContain(D(3))
    expect(out.clarifications[0].question).toContain(D(5))
  })

  it('update 确认保留旧事实 → 原值逐字保留，正式快照不被改写', () => {
    const snapshot = updateSnapshot()
    const out = normalizePlanningContext(snapshot, updateProposal, [], mkContext(), {
      taskDeadlineConfirmations: [updateConfirm({ value: D(3), precision: 'date' })],
    })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0].deadline_value).toBe(D(3))
    expect(snapshot.tasks[0].deadline.value).toBe(D(3))
  })

  it('update 确认新值 → 用新事实预览，正式快照不被改写', () => {
    const snapshot = updateSnapshot()
    const out = normalizePlanningContext(snapshot, updateProposal, [], mkContext(), {
      taskDeadlineConfirmations: [updateConfirm({ value: D(5), precision: 'date' })],
    })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0].deadline_value).toBe(D(5))
    expect(snapshot.tasks[0].deadline.value).toBe(D(3))
  })

  it('update 保留旧宽松格式事实（无秒 datetime）原值不改写', () => {
    const snapshot = mkSnapshot({
      tasks: [
        { id: 't-1', workspace_id: 'ws-fixture', title: '虚构目标一', status: 'todo', deadline: { value: `${D(3)}T09:00`, precision: 'datetime', source: 'manual', confirmed_at: `${START}T08:00:00+08:00` } },
        { id: 't-2', workspace_id: 'ws-fixture', title: '虚构目标二', status: 'todo', deadline: { value: null, precision: 'none' } },
      ],
    })
    const out = normalizePlanningContext(snapshot, updateProposal, [], mkContext(), {
      taskDeadlineConfirmations: [mkConfirm({
        object_id_or_key: 't-1', id_scope: 'formal',
        old_value: { value: `${D(3)}T09:00`, precision: 'datetime' },
        new_value: { value: `${D(3)}T09:00`, precision: 'datetime' },
      })],
    })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0].deadline_value).toBe(`${D(3)}T09:00`)
  })

  it('update 无截止候选时仍用快照事实（不触发确认门槛）', () => {
    const proposal = mkProposal({
      task_proposals: [{ op: 'update', key: 't-up', target_id: 't-1', changes: { title: '虚构改名' }, evidence_refs: [] }],
      work_items: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })],
    })
    const out = normalizePlanningContext(updateSnapshot(), proposal, [], mkContext())
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0].deadline_value).toBe(D(3))
  })
})

describe('5B-1A 复验 C1：id_scope 判别 draft/formal，碰名不串绑', () => {
  const cand = (value) => ({ value, precision: 'date', evidence_refs: [EV_SRC] })
  // 快照既有 Task.id='t-1'（无截止）与本草案新建临时 key='t-1' 碰名。
  const collisionProposal = () => mkProposal({
    task_proposals: [
      { op: 'create', key: 't-1', title: '虚构新目标', deadline_candidates: [cand(D(3))], evidence_refs: [EV_SRC] },
      { op: 'update', key: 't-up', target_id: 't-1', changes: { deadline_candidates: [cand(D(6))] }, evidence_refs: [EV_SRC] },
    ],
    action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-1' }, text: '虚构步骤', minutes: 60 }],
    work_items: [
      mkWork('wn', { task_ref: { kind: 'draft', key: 't-1' }, action_ref: { kind: 'draft', key: 'a-new' } }),
      mkWork('wo', { action_ref: { kind: 'existing', id: 'a-1' } }),
    ],
  })
  // 仅 create 碰名（既有 t-1 无 update 候选，不触发其确认门槛）→ 可验证正向不串绑。
  const createOnlyProposal = () => {
    const p = collisionProposal()
    p.task_proposals = [p.task_proposals[0]]
    return p
  }
  const cf = (scope, value, over = {}) => ({
    confirmation_id: `cf-${scope}`, draft_revision: 1, object_type: 'task', object_id_or_key: 't-1',
    id_scope: scope, field_path: 'deadline', old_value: null,
    new_value: value === null ? null : { value, precision: 'date' },
    confirmed_at: `${START}T08:00:00+08:00`, ...over,
  })
  const factOf = (out, kind) => out.input.task_facts.find((f) => f.task_ref.kind === kind)

  it('碰名且都未确认 → 两个对象各一份澄清', () => {
    const out = norm(collisionProposal())
    expect(out.ok).toBe(false)
    const qs = out.clarifications.filter((c) => c.question_id === 'q-deadline-confirm')
    expect(qs.length).toBe(2)
    expect(qs.map((c) => c.question).join('|')).toContain('虚构新目标')
    expect(qs.map((c) => c.question).join('|')).toContain('虚构目标一')
  })

  it('碰名仅确认 draft → formal 仍待确认，不被串用', () => {
    const out = norm(collisionProposal(), {}, [], { taskDeadlineConfirmations: [cf('draft', D(3))] })
    expect(out.ok).toBe(false)
    expect(out.clarifications.length).toBe(1)
    expect(out.clarifications[0].question).toContain('虚构目标一')
    expect(out.clarifications[0].question).not.toContain('虚构新目标')
  })

  it('碰名仅确认 formal → draft 仍待确认，不被串用', () => {
    const out = norm(collisionProposal(), {}, [], { taskDeadlineConfirmations: [cf('formal', D(6))] })
    expect(out.ok).toBe(false)
    expect(out.clarifications.length).toBe(1)
    expect(out.clarifications[0].question).toContain('虚构新目标')
    expect(out.clarifications[0].question).not.toContain('虚构目标一')
  })

  it('碰名各自确认 → 各得自己的值，互不污染', () => {
    const out = norm(collisionProposal(), {}, [], {
      taskDeadlineConfirmations: [cf('draft', D(3)), cf('formal', D(6))],
    })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts.length).toBe(2)
    expect(factOf(out, 'draft').deadline_value).toBe(D(3))
    expect(factOf(out, 'existing').deadline_value).toBe(D(6))
  })

  it('draft 确认不作用于同名 formal（formal 无门槛路径保持快照事实）', () => {
    const out = norm(createOnlyProposal(), {}, [], { taskDeadlineConfirmations: [cf('draft', D(3))] })
    expect(out.ok).toBe(true)
    expect(factOf(out, 'draft').deadline_value).toBe(D(3))
    expect(factOf(out, 'existing').deadline_precision).toBe('none')
    expect(factOf(out, 'existing').deadline_value).toBeNull()
  })

  it('formal 确认不满足 draft 门槛（反向亦然）', () => {
    const out = norm(createOnlyProposal(), {}, [], { taskDeadlineConfirmations: [cf('formal', D(6))] })
    expect(out.ok).toBe(false)
    expect(out.clarifications[0].question).toContain('虚构新目标')
  })

  it('缺 id_scope → 拒绝，不得回退为按名匹配', () => {
    const c = cf('draft', D(3))
    delete c.id_scope
    expect(() => norm(collisionProposal(), {}, [], { taskDeadlineConfirmations: [c] })).toThrow(/id_scope/)
  })

  it('错误 id_scope 值 → 拒绝', () => {
    expect(() => norm(collisionProposal(), {}, [], {
      taskDeadlineConfirmations: [cf('draft', D(3), { id_scope: 'workspace' })],
    })).toThrow(/id_scope/)
  })

  it('id_scope=draft 指向非本草案 create key → 拒绝', () => {
    expect(() => norm(collisionProposal(), {}, [], {
      taskDeadlineConfirmations: [cf('draft', D(3), { object_id_or_key: 't-2' })],
    })).toThrow(/不是本草案新建目标/)
  })

  it('id_scope=formal 指向快照外 ID → 拒绝', () => {
    expect(() => norm(collisionProposal(), {}, [], {
      taskDeadlineConfirmations: [cf('formal', D(6), { object_id_or_key: 't-ghost' })],
    })).toThrow(/既有目标/)
  })
})

describe('5B-1A 复验 C2：缺 old/new_value 不是明确无截止', () => {
  const proposal = () => mkProposal({
    task_proposals: [{
      op: 'create', key: 't-new', title: '虚构新目标',
      deadline_candidates: [{ value: D(2), precision: 'date', evidence_refs: [EV_SRC] }], evidence_refs: [EV_SRC],
    }],
    action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60 }],
    work_items: [mkWork('w1', { task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' } })],
  })
  const base = () => ({
    confirmation_id: 'cf-1', draft_revision: 1, object_type: 'task', object_id_or_key: 't-new',
    id_scope: 'draft', field_path: 'deadline', old_value: null, new_value: { value: D(2), precision: 'date' },
    confirmed_at: `${START}T08:00:00+08:00`,
  })
  const run = (c) => norm(proposal(), {}, [], { taskDeadlineConfirmations: [c] })

  it('缺 new_value 字段 → 拒绝，不得取消截止约束', () => {
    const c = base()
    delete c.new_value
    expect(() => run(c)).toThrow(/显式携带 new_value/)
  })

  it('缺 old_value 字段 → 拒绝', () => {
    const c = base()
    delete c.old_value
    expect(() => run(c)).toThrow(/显式携带 old_value/)
  })

  it('new_value=undefined → 拒绝', () => {
    expect(() => run({ ...base(), new_value: undefined })).toThrow(/显式携带 new_value/)
  })

  it('old_value=undefined → 拒绝', () => {
    expect(() => run({ ...base(), old_value: undefined })).toThrow(/显式携带 old_value/)
  })

  it('undefined 经 JSON 序列化变缺失键 → 仍拒绝（不被洗成有效 null）', () => {
    const c = { ...base(), new_value: undefined }
    expect(() => run(JSON.parse(JSON.stringify(c)))).toThrow(/显式携带 new_value/)
  })

  it('显式 new_value=null（old_value 在场）→ 明确无截止', () => {
    const out = run({ ...base(), new_value: null })
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0]).toMatchObject({ deadline_value: null, deadline_precision: 'none' })
  })

  it('合法有值投影 → 按确认值生成事实', () => {
    const out = run(base())
    expect(out.ok).toBe(true)
    expect(out.input.task_facts[0].deadline_value).toBe(D(2))
  })
})