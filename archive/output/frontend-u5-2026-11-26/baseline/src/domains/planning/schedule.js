// daily-v1 七天纯规则排程（5B-1A）。
// 算法依据：5B-0 协议决策 §6 伪代码 + §7 冻结解释；金标 g1–g17 是验收期望。
// 纯函数：不访问数据库/网络/Pinia/系统时间/随机 ID；start_date 由调用层按北京时间显式传入。
// 非法输入直接拒绝（throw），不归为「无容量」；同输入必得同输出（稳定排序，不依赖遍历顺序）。

import {
  fail, allowKeys, checkKey, checkRealDate, checkInt, checkEnum, checkText,
  checkTypedRef, refToken, beijingDateOf, checkConsecutiveDays, checkDependencyCycles,
  checkExistingDeadlineValue,
  TASK_STATUSES, PLAN_ITEM_STATES, COUNTED_STATES, PRIORITIES, JS_SAFE_INT_MAX,
} from './protocol.js'
import { beijingAddDays } from '../time.js'

const INPUT_KEYS = [
  'algorithm_version', 'timezone', 'today', 'start_date', 'horizon_days', 'buffer_pct',
  'days', 'task_facts', 'work_items', 'occupancy', 'replacement_ids', 'extra_work_acknowledged',
]
const DAY_KEYS = ['date', 'budget_minutes']
const FACT_KEYS = ['task_ref', 'title', 'deadline_value', 'deadline_precision', 'overdue_consent', 'status']
const WORK_KEYS = [
  'key', 'task_ref', 'action_ref', 'deliverable', 'remaining_minutes', 'estimate_origin',
  'splittable', 'min_segment_minutes', 'earliest_date', 'depends_on', 'priority',
]
const OCC_KEYS = ['plan_item_id', 'task_id', 'date', 'planned_minutes', 'state', 'task_ref_state']

// 输入结构+语义校验（镜像提案 PlanningInput 校验器 + check_planning_semantics）。
export function validatePlanningInput(input) {
  allowKeys(input, INPUT_KEYS, 'PlanningInput')
  if ((input.algorithm_version ?? 'daily-v1') !== 'daily-v1') fail('algorithm_version 必须是 daily-v1')
  if ((input.timezone ?? 'Asia/Shanghai') !== 'Asia/Shanghai') fail('timezone 必须是 Asia/Shanghai')
  if ((input.horizon_days ?? 7) !== 7) fail('horizon_days 首版固定 7')
  checkRealDate(input.start_date, 'start_date')
  // R2：today 由调用层显式注入（北京时间日期），用于判断真实逾期；缺省按窗口起始日解释。
  if (input.today != null) {
    checkRealDate(input.today, 'today')
    if (input.today > input.start_date) fail('today 不得晚于 start_date')
  }
  const bufferPct = input.buffer_pct ?? 15
  checkInt(bufferPct, 0, 50, 'buffer_pct')
  const days = input.days
  if (!Array.isArray(days) || days.length !== 7) fail('days 必须是 7 天')
  checkConsecutiveDays(input.start_date, days.map((d) => d.date), 'days')
  for (const d of days) {
    allowKeys(d, DAY_KEYS, 'DayBudget')
    checkRealDate(d.date, 'days.date')
    if (d.budget_minutes == null) fail('排程日预算必须已确认（null 不得进入排程，也不得默认 0）')
    checkInt(d.budget_minutes, 0, 1440, `days[${d.date}].budget_minutes`)
  }
  const facts = input.task_facts ?? []
  const items = input.work_items ?? []
  const occupancy = input.occupancy ?? []
  if (facts.length > 20) fail('task_facts 最多 20')
  if (items.length > 100) fail('work_items 最多 100')
  if (occupancy.length > 2000) fail('occupancy 最多 2000')
  // M3：replacement_ids 记录已验证可替换集 R；occupancy 必须是排除 R 后的有效占用，
  // 排程器只消费该结果，不得按 replacement_ids 二次扣减容量。
  const replacementIds = input.replacement_ids ?? []
  if (replacementIds.length > 100) fail('replacement_ids 最多 100')
  if (new Set(replacementIds).size !== replacementIds.length) fail('replacement_ids 重复；去重拒绝，不静默扩大范围')
  for (const id of replacementIds) checkText(id, 1, 64, 'replacement_ids')

  const factTokens = new Set()
  for (const f of facts) {
    allowKeys(f, FACT_KEYS, 'PlanningTaskFact')
    checkTypedRef(f.task_ref, 'task_fact')
    checkText(f.title, 1, 200, 'task_fact.title')
    const precision = f.deadline_precision ?? 'none'
    checkEnum(precision, ['none', 'date', 'datetime'], 'deadline_precision')
    if (precision === 'none') {
      if (f.deadline_value != null) fail('precision=none 时 deadline_value 必须为空')
    } else {
      if (f.deadline_value == null) fail('有精度就必须有值')
      checkExistingDeadlineValue(f.deadline_value, precision, 'deadline_value')
    }
    checkEnum(f.status ?? 'todo', TASK_STATUSES, 'task_fact.status')
    const token = refToken(f.task_ref)
    if (factTokens.has(token)) fail('task_facts 引用重复')
    factTokens.add(token)
  }

  const keys = items.map((w) => w.key)
  if (new Set(keys).size !== keys.length) fail('work item key 重复')
  const keySet = new Set(keys)
  const graph = new Map()
  for (const w of items) {
    allowKeys(w, WORK_KEYS, 'PlanningWorkItem')
    checkKey(w.key, 'work item')
    checkTypedRef(w.task_ref, `work item ${w.key} task_ref`)
    checkTypedRef(w.action_ref, `work item ${w.key} action_ref`)
    checkText(w.deliverable, 1, 500, `work item ${w.key} deliverable`)
    if (w.remaining_minutes != null) {
      if (typeof w.remaining_minutes !== 'number' || !Number.isSafeInteger(w.remaining_minutes) || w.remaining_minutes <= 0) {
        fail('remaining_minutes 必须为正安全整数或 null（未知），不能用 0')
      }
    }
    checkEnum(w.estimate_origin ?? 'model', ['model', 'user'], 'estimate_origin')
    if (typeof (w.splittable ?? true) !== 'boolean') fail('splittable 必须是布尔')
    checkInt(w.min_segment_minutes ?? 25, 1, 240, 'min_segment_minutes')
    if (w.earliest_date != null) checkRealDate(w.earliest_date, 'earliest_date')
    const deps = w.depends_on ?? []
    if (deps.length > 20) fail('depends_on 最多 20')
    if (deps.includes(w.key)) fail('工作项不得依赖自身')
    if (new Set(deps).size !== deps.length) fail('depends_on 不得重复')
    for (const dep of deps) {
      if (!keySet.has(dep)) fail(`depends_on 引用未知工作项：${dep}`)
    }
    checkEnum(w.priority ?? 'normal', PRIORITIES, 'priority')
    if (!factTokens.has(refToken(w.task_ref))) fail(`工作项 ${w.key} 的 task_ref 缺少对应 task_facts`)
    graph.set(w.key, deps)
  }
  checkDependencyCycles(graph)

  const occIds = new Set()
  for (const o of occupancy) {
    allowKeys(o, OCC_KEYS, 'OccupancyEntry')
    checkText(o.plan_item_id, 1, 64, 'occupancy.plan_item_id')
    checkText(o.task_id, 1, 64, 'occupancy.task_id')
    checkRealDate(o.date, 'occupancy.date')
    checkInt(o.planned_minutes, 1, JS_SAFE_INT_MAX, 'occupancy.planned_minutes')
    checkEnum(o.state, PLAN_ITEM_STATES, 'occupancy.state')
    checkEnum(o.task_ref_state ?? 'active', ['active', 'deleted'], 'occupancy.task_ref_state')
    if (o.state === 'planned' && (o.task_ref_state ?? 'active') === 'deleted') {
      fail('planned 占用断引用属于不可信数据：阻断并引导核对，不得按 0 计算')
    }
    if (occIds.has(o.plan_item_id)) fail('occupancy 按唯一 PlanItem ID 计占用；重复引用拒绝，不双计')
    occIds.add(o.plan_item_id)
  }
  for (const id of replacementIds) {
    if (occIds.has(id)) fail('occupancy 不得含 replacement_ids：有效占用须先排除已验证替换集')
  }

  const ack = new Set(input.extra_work_acknowledged ?? [])
  for (const k of ack) {
    if (!keySet.has(k)) fail('extra_work_acknowledged 引用未知工作项')
  }
  // D12：既有任务在窗口已有安排时，须确认本次估时为额外尚未安排工作。
  const windowSet = new Set(days.map((d) => d.date))
  const occupiedExisting = new Set(
    occupancy.filter((o) => windowSet.has(o.date) && COUNTED_STATES.includes(o.state)).map((o) => o.task_id),
  )
  for (const w of items) {
    if (w.task_ref.kind === 'existing' && occupiedExisting.has(w.task_ref.id) && !ack.has(w.key)) {
      fail(`工作项 ${w.key} 的既有任务在窗口已有安排，须先确认「额外尚未安排工作」口径（D12）`)
    }
  }
  return input
}

// R2：真实逾期 = 截止日整体早于注入的 today（缺省窗口起始日），与保守最迟日/窗口裁剪分离。
// 当天精确截止不算逾期：保守最迟日=前一天，放不下时走时段核对缺口，不引导逾期补做。
// R3：sortKey 保留未裁剪的保守截止日，供排序；latest 只用于本窗口放置边界。
function latestFor(fact, startDate, endDate, today) {
  const precision = fact.deadline_precision ?? 'none'
  if (precision === 'none') return { latest: endDate, sortKey: endDate, dlDate: null, overdue: false }
  const dlDate = precision === 'datetime' ? beijingDateOf(fact.deadline_value) : fact.deadline_value
  const conservative = precision === 'datetime' ? beijingAddDays(dlDate, -1) : dlDate
  const overdue = dlDate < today
  let latest = conservative
  if (overdue && fact.overdue_consent) latest = endDate
  if (latest > endDate) latest = endDate
  return { latest, sortKey: conservative, dlDate, overdue }
}

// 未排原因优先级（冻结解释，交回文档留档）：
// not_splittable（不可拆整段放不下）先于时段核对；datetime 截止当天在窗口内且初始 free>0
// 时给 needs_deadline_day_window，否则有截止 deadline_window、无截止 no_capacity。
function gapReason(state, initialFree, windowIndex) {
  if (state.precision === 'datetime' && state.dlDate != null) {
    const idx = windowIndex.get(state.dlDate)
    if (idx !== undefined && initialFree[idx] > 0) return 'needs_deadline_day_window'
  }
  return state.hasDeadline ? 'deadline_window' : 'no_capacity'
}

/**
 * daily-v1 排程。options 由组装层配套传递（不进入 PlanningInput 字段）：
 * - excludedItems: [{ work_item_key, reason }] 用户明确排除项（草案层保存）。
 * 返回 PlanningResult；complete 只是排程完整性，不等于可采用/已保存。
 */
export function scheduleDaily(input, options = {}) {
  validatePlanningInput(input)
  const items = input.work_items ?? []
  const facts = input.task_facts ?? []
  const occupancy = input.occupancy ?? []
  const bufferPct = input.buffer_pct ?? 15
  const dates = input.days.map((d) => d.date)
  const windowIndex = new Map(dates.map((d, i) => [d, i]))
  const startDate = dates[0]
  const endDate = dates[6]

  const excludedKeys = new Set()
  const excludedItems = []
  for (const e of options.excludedItems ?? []) {
    if (!items.some((w) => w.key === e.work_item_key)) fail(`排除项引用未知工作项：${e.work_item_key}`)
    if (excludedKeys.has(e.work_item_key)) fail(`排除项重复：${e.work_item_key}`)
    excludedKeys.add(e.work_item_key)
    excludedItems.push({ work_item_key: e.work_item_key, excluded_by: 'user', reason: e.reason })
  }

  const allocatable = input.days.map((d) => Math.floor((d.budget_minutes * (100 - bufferPct)) / 100))
  const committed = dates.map(() => 0)
  for (const o of occupancy) {
    const idx = windowIndex.get(o.date)
    if (idx !== undefined && COUNTED_STATES.includes(o.state)) committed[idx] += o.planned_minutes
  }
  const initialFree = allocatable.map((a, i) => Math.max(0, a - committed[i]))
  const overbooked = allocatable.map((a, i) => Math.max(0, committed[i] - a))
  const allocated = dates.map(() => 0)
  const dayOrderCount = dates.map(() => 0)
  const freeNow = initialFree.slice()

  const factByToken = new Map(facts.map((f) => [refToken(f.task_ref), f]))
  const today = input.today ?? startDate
  const states = new Map()
  for (const w of items) {
    const fact = factByToken.get(refToken(w.task_ref))
    const { latest, sortKey, dlDate, overdue } = latestFor(fact, startDate, endDate, today)
    states.set(w.key, {
      w, fact, latest, sortKey, dlDate, overdue,
      precision: fact.deadline_precision ?? 'none',
      hasDeadline: (fact.deadline_precision ?? 'none') !== 'none',
      earliest: w.earliest_date && w.earliest_date > startDate ? w.earliest_date : startDate,
      left: w.remaining_minutes,
      status: 'pending',
      segCount: 0,
      lastDate: null,
    })
  }

  const segments = []
  const unscheduled = []
  const unknownItems = []
  const warnings = []
  const pushUnscheduled = (st, reason) => {
    st.status = 'unscheduled'
    unscheduled.push({ work_item_key: st.w.key, remaining_minutes: st.left, reason })
  }

  for (const st of states.values()) {
    if (excludedKeys.has(st.w.key)) {
      st.status = 'excluded'
    } else if (st.w.remaining_minutes == null) {
      st.status = 'unknown'
      unknownItems.push({ work_item_key: st.w.key, reason: 'estimate_missing' })
    } else if (st.overdue && !st.fact.overdue_consent) {
      pushUnscheduled(st, 'overdue_requires_consent')
    } else if (st.w.earliest_date && st.w.earliest_date > endDate) {
      pushUnscheduled(st, 'outside_horizon')
    }
  }

  const priorityRank = { high: 0, normal: 1, low: 2 }
  // R3：先按未裁剪的保守截止日排序（窗口外截止保留真实先后），无截止恒在有截止之后；
  // 优先级只用于截止等位的工作项。
  const sortReady = (a, b) => {
    const ad = a.hasDeadline ? 0 : 1
    const bd = b.hasDeadline ? 0 : 1
    if (ad !== bd) return ad - bd
    if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1
    const ap = priorityRank[a.w.priority ?? 'normal']
    const bp = priorityRank[b.w.priority ?? 'normal']
    if (ap !== bp) return ap - bp
    return a.w.key < b.w.key ? -1 : a.w.key > b.w.key ? 1 : 0
  }

  const placeSegment = (st, idx, minutes) => {
    st.segCount += 1
    dayOrderCount[idx] += 1
    allocated[idx] += minutes
    freeNow[idx] -= minutes
    st.left -= minutes
    st.lastDate = dates[idx]
    segments.push({
      segment_key: `${st.w.key}#${st.segCount}`,
      work_item_key: st.w.key,
      task_ref: st.w.task_ref,
      suggested_action_ref: st.w.action_ref,
      date: dates[idx],
      minutes,
      order: dayOrderCount[idx],
      action_text: st.w.deliverable,
      deliverable: st.w.deliverable,
    })
  }

  const place = (st) => {
    const deps = st.w.depends_on ?? []
    let earliest = st.earliest
    for (const dep of deps) {
      const ds = states.get(dep)
      if (ds.lastDate && ds.lastDate > earliest) earliest = ds.lastDate
    }
    const minSeg = st.w.min_segment_minutes ?? 25
    const splittable = st.w.splittable ?? true
    // 保守最迟日早于窗口起始（如当天精确截止）时无可放置日，直接走缺口原因。
    const firstIdx = windowIndex.get(earliest)
    const lastIdx = windowIndex.get(st.latest)
    if (!splittable) {
      if (lastIdx !== undefined) {
        for (let i = firstIdx; i <= lastIdx; i += 1) {
          if (freeNow[i] >= st.left) {
            placeSegment(st, i, st.left)
            st.status = 'scheduled'
            return
          }
        }
      }
      pushUnscheduled(st, 'not_splittable')
      return
    }
    if (lastIdx !== undefined) {
      for (let i = firstIdx; i <= lastIdx; i += 1) {
        const take = Math.min(freeNow[i], st.left)
        if (take <= 0) continue
        if (take < st.left && take < minSeg) continue
        placeSegment(st, i, take)
        if (st.left === 0) break
      }
    }
    if (st.left === 0) {
      st.status = 'scheduled'
    } else {
      pushUnscheduled(st, gapReason(st, initialFree, windowIndex))
    }
  }

  // 就绪循环：前置全部排完才可排；每步按 (最迟日, 有截止优先, 优先级, 稳定key) 取首项。
  for (;;) {
    const ready = []
    for (const st of states.values()) {
      if (st.status !== 'pending') continue
      const deps = st.w.depends_on ?? []
      if (deps.every((dep) => states.get(dep).status === 'scheduled')) ready.push(st)
    }
    if (ready.length === 0) break
    ready.sort(sortReady)
    place(ready[0])
  }
  for (const st of states.values()) {
    if (st.status === 'pending') pushUnscheduled(st, 'dependency_blocked')
  }

  overbooked.forEach((over, i) => {
    if (over > 0) {
      warnings.push({
        code: 'existing_overbook',
        message: `${dates[i]} 已超出预算${over}分钟，不新增安排`,
        related_key: null,
      })
    }
  })
  if (facts.some((f) => f.deadline_precision === 'datetime')) {
    warnings.push({
      code: 'datetime_deadline_conservative',
      message: '精确时刻截止默认最晚排前一天；当前按天安排，不保证具体时段',
      related_key: null,
    })
  }
  for (const st of states.values()) {
    if (st.overdue && st.fact.overdue_consent && st.status === 'scheduled') {
      warnings.push({ code: 'overdue_scheduled', message: '逾期补做，原截止不变', related_key: null })
    }
  }
  warnings.push({
    code: 'unrecorded_calendar_notice',
    message: '容量按你提供的预算核对，未录入的会议/课程不会被自动知道',
    related_key: null,
  })

  const days = input.days.map((d, i) => ({
    date: d.date,
    budget_minutes: d.budget_minutes,
    buffer_minutes: d.budget_minutes - allocatable[i],
    committed_minutes: committed[i],
    allocated_minutes: allocated[i],
    free_minutes: Math.max(0, allocatable[i] - committed[i] - allocated[i]),
    overbooked_minutes: overbooked[i],
  }))

  const complete = unscheduled.length === 0 && unknownItems.length === 0
    && [...states.values()].every((st) => st.status === 'excluded' || st.status === 'unknown' || st.status === 'scheduled')

  return {
    segments,
    days,
    unscheduled,
    unknown_items: unknownItems,
    excluded_items: excludedItems,
    conflicts: [],
    warnings,
    complete,
  }
}