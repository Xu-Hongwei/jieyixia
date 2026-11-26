// 助手对象类型化引用访问器注册表（5B-1B）。校验、失效检查与备份重映射共用同一份路径表。
// 口径唯一来源：contract/assistant_models.py 字段形状 + 契约差异包 §5.2 全表（含 revision_history 递归）。
// 只按真实类型字段遍历，绝不 JSON 全文替换或按字符串命中映射表猜判别。
// namespace：formal=正式 ID（重映射/失效检查）；draft_key=草案 task key（版本内有效，保留）；
// local_key=工作项/要求/分段等局部 key（保留）；turn=线程内消息回合（保留）；date=日期（保留）。
// 缺失与否是读取时计算的状态，不是持久字段；不给引用容器私加 deleted 等未注册字段。

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// 收集器：entries 推入 { path, targetType, namespace, purpose, get, set, meta? }。
function collector() {
  const entries = []
  const push = (path, targetType, namespace, purpose, get, set, meta) => {
    entries.push({ path, targetType, namespace, purpose, get, set, ...(meta ? { meta } : {}) })
  }
  return { entries, push }
}

function objectRef(c, ref, path, purpose) {
  if (!isObj(ref)) return
  c.push(`${path}.id`, ref.object_type, 'formal', purpose, () => ref.id, (v) => { ref.id = v })
}

// TypedRef：kind=draft → 草案局部 key 保留；kind=existing → 正式 ID。按 kind 判别，不按字符串猜。
function typedRef(c, ref, path, targetType, purpose) {
  if (!isObj(ref)) return
  if (ref.kind === 'draft') {
    c.push(`${path}.key`, targetType, 'draft_key', purpose, () => ref.key, (v) => { ref.key = v })
  } else if (ref.kind === 'existing') {
    c.push(`${path}.id`, targetType, 'formal', purpose, () => ref.id, (v) => { ref.id = v })
  }
}

function evidence(c, ev, path) {
  if (!isObj(ev)) return
  switch (ev.kind) {
    case 'source_excerpt':
      c.push(`${path}.source_id`, 'source', 'formal', 'evidence', () => ev.source_id, (v) => { ev.source_id = v })
      break
    case 'note_field':
      c.push(`${path}.note_id`, 'note', 'formal', 'evidence', () => ev.note_id, (v) => { ev.note_id = v })
      break
    case 'user_message':
      c.push(`${path}.turn_id`, 'turn', 'turn', 'evidence', () => ev.turn_id, (v) => { ev.turn_id = v })
      break
    case 'existing_fact':
      c.push(`${path}.object_id`, ev.object_type, 'formal', 'evidence', () => ev.object_id, (v) => { ev.object_id = v })
      break
    default: break
  }
}

function evidenceList(c, list, path) {
  if (Array.isArray(list)) list.forEach((ev, i) => evidence(c, ev, `${path}[${i}]`))
}

function deadlineCandidates(c, list, path) {
  if (!Array.isArray(list)) return
  list.forEach((dc, i) => evidenceList(c, dc && dc.evidence_refs, `${path}[${i}].evidence_refs`))
}

// typed requirement.value：开放 JSON 里只有这三种 type 携带引用，不能整段当正文跳过。
function requirementValue(c, type, value, path) {
  if (!isObj(value)) return
  if (type === 'task_priority') {
    typedRef(c, value.task_ref, `${path}.task_ref`, 'task', 'requirement')
  } else if (type === 'splittable') {
    c.push(`${path}.work_item_key`, 'work_item', 'local_key', 'requirement', () => value.work_item_key, (v) => { value.work_item_key = v })
  } else if (type === 'ordering') {
    c.push(`${path}.before_key`, 'work_item', 'local_key', 'requirement', () => value.before_key, (v) => { value.before_key = v })
    c.push(`${path}.after_key`, 'work_item', 'local_key', 'requirement', () => value.after_key, (v) => { value.after_key = v })
  }
}

function requirementLike(c, r, path) {
  if (!isObj(r)) return
  requirementValue(c, r.type, r.value, `${path}.value`)
  evidenceList(c, r.evidence_refs, `${path}.evidence_refs`)
}

function workItemLike(c, w, path) {
  if (!isObj(w)) return
  typedRef(c, w.task_ref, `${path}.task_ref`, 'task', 'work_item')
  typedRef(c, w.action_ref, `${path}.action_ref`, 'action', 'work_item')
  if (Array.isArray(w.depends_on)) {
    w.depends_on.forEach((_, i) => {
      c.push(`${path}.depends_on[${i}]`, 'work_item', 'local_key', 'dependency', () => w.depends_on[i], (v) => { w.depends_on[i] = v })
    })
  }
}

function proposal(c, p, path) {
  if (!isObj(p)) return
  if (Array.isArray(p.task_proposals)) {
    p.task_proposals.forEach((t, i) => {
      const tp = `${path}.task_proposals[${i}]`
      if (!isObj(t)) return
      if (t.op === 'link' || t.op === 'update') {
        c.push(`${tp}.target_id`, 'task', 'formal', 'target', () => t.target_id, (v) => { t.target_id = v })
      }
      if (t.op === 'create') deadlineCandidates(c, t.deadline_candidates, `${tp}.deadline_candidates`)
      // update 的 changes.deadline_candidates[].evidence_refs 是容易漏掉的路径，必须遍历。
      if (t.op === 'update' && isObj(t.changes)) deadlineCandidates(c, t.changes.deadline_candidates, `${tp}.changes.deadline_candidates`)
      evidenceList(c, t.evidence_refs, `${tp}.evidence_refs`)
    })
  }
  if (Array.isArray(p.action_proposals)) {
    p.action_proposals.forEach((a, i) => {
      const ap = `${path}.action_proposals[${i}]`
      if (!isObj(a)) return
      if (a.op === 'reuse') {
        c.push(`${ap}.target_id`, 'action', 'formal', 'target', () => a.target_id, (v) => { a.target_id = v })
        // reuse.task_ref 是 ExistingRef（非 TypedRef），恒为正式 Task。
        if (isObj(a.task_ref)) c.push(`${ap}.task_ref.id`, 'task', 'formal', 'work_item', () => a.task_ref.id, (v) => { a.task_ref.id = v })
      } else {
        typedRef(c, a.task_ref, `${ap}.task_ref`, 'task', 'work_item')
      }
      evidenceList(c, a.evidence_refs, `${ap}.evidence_refs`)
    })
  }
  if (Array.isArray(p.work_items)) p.work_items.forEach((w, i) => workItemLike(c, w, `${path}.work_items[${i}]`))
  if (Array.isArray(p.requirement_candidates)) p.requirement_candidates.forEach((r, i) => requirementLike(c, r, `${path}.requirement_candidates[${i}]`))
  evidenceList(c, p.evidence_refs, `${path}.evidence_refs`)
  if (Array.isArray(p.assumptions)) {
    p.assumptions.forEach((a, i) => {
      if (isObj(a) && Array.isArray(a.related_keys)) {
        a.related_keys.forEach((_, j) => {
          c.push(`${path}.assumptions[${i}].related_keys[${j}]`, 'work_item', 'local_key', 'assumption', () => a.related_keys[j], (v) => { a.related_keys[j] = v })
        })
      }
    })
  }
}

function occupancy(c, list, path) {
  if (!Array.isArray(list)) return
  list.forEach((o, i) => {
    if (!isObj(o)) return
    const op = `${path}[${i}]`
    // planned 断引用属于不可信占用（阻断核对）；partial/done 历史断引用继续计分钟。
    const meta = { occupancyState: o.state }
    c.push(`${op}.plan_item_id`, 'plan_item', 'formal', 'occupancy', () => o.plan_item_id, (v) => { o.plan_item_id = v }, meta)
    c.push(`${op}.task_id`, 'task', 'formal', 'occupancy', () => o.task_id, (v) => { o.task_id = v }, meta)
  })
}

function planningInput(c, pi, path) {
  if (!isObj(pi)) return
  if (Array.isArray(pi.task_facts)) pi.task_facts.forEach((f, i) => typedRef(c, f && f.task_ref, `${path}.task_facts[${i}].task_ref`, 'task', 'fact'))
  if (Array.isArray(pi.work_items)) pi.work_items.forEach((w, i) => workItemLike(c, w, `${path}.work_items[${i}]`))
  occupancy(c, pi.occupancy, `${path}.occupancy`)
  if (Array.isArray(pi.replacement_ids)) {
    pi.replacement_ids.forEach((_, i) => {
      c.push(`${path}.replacement_ids[${i}]`, 'plan_item', 'formal', 'replacement', () => pi.replacement_ids[i], (v) => { pi.replacement_ids[i] = v })
    })
  }
  if (Array.isArray(pi.extra_work_acknowledged)) {
    pi.extra_work_acknowledged.forEach((_, i) => {
      c.push(`${path}.extra_work_acknowledged[${i}]`, 'work_item', 'local_key', 'extra_work', () => pi.extra_work_acknowledged[i], (v) => { pi.extra_work_acknowledged[i] = v })
    })
  }
}

function planningResult(c, pr, path) {
  if (!isObj(pr)) return
  if (Array.isArray(pr.segments)) {
    pr.segments.forEach((s, i) => {
      if (!isObj(s)) return
      typedRef(c, s.task_ref, `${path}.segments[${i}].task_ref`, 'task', 'segment')
      typedRef(c, s.suggested_action_ref, `${path}.segments[${i}].suggested_action_ref`, 'action', 'segment')
      c.push(`${path}.segments[${i}].work_item_key`, 'work_item', 'local_key', 'segment', () => s.work_item_key, (v) => { s.work_item_key = v })
      c.push(`${path}.segments[${i}].segment_key`, 'segment', 'local_key', 'segment', () => s.segment_key, (v) => { s.segment_key = v })
    })
  }
  for (const group of ['unscheduled', 'unknown_items', 'excluded_items']) {
    if (Array.isArray(pr[group])) {
      pr[group].forEach((x, i) => {
        if (isObj(x)) c.push(`${path}.${group}[${i}].work_item_key`, 'work_item', 'local_key', group, () => x.work_item_key, (v) => { x.work_item_key = v })
      })
    }
  }
  if (Array.isArray(pr.conflicts)) {
    pr.conflicts.forEach((x, i) => {
      if (isObj(x) && Array.isArray(x.related_keys)) {
        x.related_keys.forEach((_, j) => {
          c.push(`${path}.conflicts[${i}].related_keys[${j}]`, 'work_item', 'local_key', 'conflict', () => x.related_keys[j], (v) => { x.related_keys[j] = v })
        })
      }
    })
  }
  if (Array.isArray(pr.warnings)) {
    pr.warnings.forEach((x, i) => {
      if (isObj(x) && x.related_key != null) {
        c.push(`${path}.warnings[${i}].related_key`, 'work_item', 'local_key', 'warning', () => x.related_key, (v) => { x.related_key = v })
      }
    })
  }
}

function factBaseline(c, fb, path) {
  if (!isObj(fb)) return
  if (Array.isArray(fb.task_facts)) fb.task_facts.forEach((f, i) => typedRef(c, f && f.task_ref, `${path}.task_facts[${i}].task_ref`, 'task', 'fact'))
  if (Array.isArray(fb.source_fingerprints)) {
    fb.source_fingerprints.forEach((f, i) => {
      if (isObj(f)) c.push(`${path}.source_fingerprints[${i}].source_id`, 'source', 'formal', 'fingerprint', () => f.source_id, (v) => { f.source_id = v })
    })
  }
  if (Array.isArray(fb.note_field_baselines)) {
    fb.note_field_baselines.forEach((f, i) => {
      if (isObj(f)) c.push(`${path}.note_field_baselines[${i}].note_id`, 'note', 'formal', 'baseline', () => f.note_id, (v) => { f.note_id = v })
    })
  }
  occupancy(c, fb.occupancy, `${path}.occupancy`)
}

// UserConfirmation.object_id_or_key：task 按显式 id_scope 判别（C1）；其它类型命名空间固定。
function confirmation(c, u, path) {
  if (!isObj(u)) return
  const p = `${path}.object_id_or_key`
  const get = () => u.object_id_or_key
  const set = (v) => { u.object_id_or_key = v }
  switch (u.object_type) {
    case 'task':
      if (u.id_scope === 'draft') c.push(p, 'task', 'draft_key', 'confirmation', get, set)
      else if (u.id_scope === 'formal') c.push(p, 'task', 'formal', 'confirmation', get, set)
      break
    case 'note_field': c.push(p, 'note', 'formal', 'confirmation', get, set); break
    case 'requirement': c.push(p, 'requirement', 'local_key', 'confirmation', get, set); break
    case 'gap':
    case 'extra_work': c.push(p, 'work_item', 'local_key', 'confirmation', get, set); break
    case 'overbook': c.push(p, 'date', 'date', 'confirmation', get, set); break
    case 'replan_scope': c.push(p, 'task', 'formal', 'confirmation', get, set); break
    default: break
  }
}

// M3 改排：范围/进展/替换基线的类型化引用（正式 ID 重映射；局部 key 保留）。
function replanScope(c, s, path) {
  if (!isObj(s)) return
  c.push(`${path}.task_id`, 'task', 'formal', 'replan_scope', () => s.task_id, (v) => { s.task_id = v })
  if (Array.isArray(s.replacement_ids)) {
    s.replacement_ids.forEach((_, i) => {
      c.push(`${path}.replacement_ids[${i}]`, 'plan_item', 'formal', 'replan_scope', () => s.replacement_ids[i], (v) => { s.replacement_ids[i] = v })
    })
  }
}

function progressInput(c, pi, path) {
  if (!isObj(pi)) return
  if (Array.isArray(pi.work_items)) {
    pi.work_items.forEach((w, i) => {
      if (isObj(w) && w.reuse_action_id != null) {
        c.push(`${path}.work_items[${i}].reuse_action_id`, 'action', 'formal', 'progress', () => w.reuse_action_id, (v) => { w.reuse_action_id = v })
      }
    })
  }
}

function replacementBaseline(c, rb, path) {
  if (!isObj(rb)) return
  if (Array.isArray(rb.items)) {
    rb.items.forEach((it, i) => {
      if (!isObj(it)) return
      c.push(`${path}.items[${i}].plan_item_id`, 'plan_item', 'formal', 'replacement_baseline', () => it.plan_item_id, (v) => { it.plan_item_id = v })
      c.push(`${path}.items[${i}].task_id`, 'task', 'formal', 'replacement_baseline', () => it.task_id, (v) => { it.task_id = v })
    })
  }
  if (Array.isArray(rb.focus_session_ids)) {
    rb.focus_session_ids.forEach((_, i) => {
      c.push(`${path}.focus_session_ids[${i}]`, 'focus_session', 'formal', 'replacement_baseline', () => rb.focus_session_ids[i], (v) => { rb.focus_session_ids[i] = v })
    })
  }
}

function snapshot(c, h, path) {
  if (!isObj(h)) return
  proposal(c, h.proposal, `${path}.proposal`)
  planningInput(c, h.planning_input, `${path}.planning_input`)
  planningResult(c, h.planning_result, `${path}.planning_result`)
  if (Array.isArray(h.requirements)) h.requirements.forEach((r, i) => requirementLike(c, r, `${path}.requirements[${i}]`))
  replanScope(c, h.replan_scope, `${path}.replan_scope`)
  progressInput(c, h.progress_input, `${path}.progress_input`)
  replacementBaseline(c, h.replacement_baseline, `${path}.replacement_baseline`)
}

function thread(c, t) {
  if (!isObj(t)) return
  if (Array.isArray(t.selected_refs)) t.selected_refs.forEach((r, i) => objectRef(c, r, `selected_refs[${i}]`, 'selection'))
  if (Array.isArray(t.messages)) {
    t.messages.forEach((m, i) => {
      if (isObj(m) && Array.isArray(m.refs)) m.refs.forEach((r, j) => objectRef(c, r, `messages[${i}].refs[${j}]`, 'message'))
    })
  }
  if (Array.isArray(t.confirmed_requirements)) t.confirmed_requirements.forEach((r, i) => requirementLike(c, r, `confirmed_requirements[${i}]`))
}

function draft(c, d) {
  if (!isObj(d)) return
  // 容器归属：thread_id 必须指向同包同空间线程；损坏拒绝整包（由调用方执行）。
  c.push('thread_id', 'thread', 'formal', 'ownership', () => d.thread_id, (v) => { d.thread_id = v })
  if (Array.isArray(d.source_refs)) d.source_refs.forEach((r, i) => objectRef(c, r, `source_refs[${i}]`, 'selection'))
  proposal(c, d.proposal, 'proposal')
  planningInput(c, d.planning_input, 'planning_input')
  planningResult(c, d.planning_result, 'planning_result')
  factBaseline(c, d.fact_baseline, 'fact_baseline')
  replanScope(c, d.replan_scope, 'replan_scope')
  progressInput(c, d.progress_input, 'progress_input')
  replacementBaseline(c, d.replacement_baseline, 'replacement_baseline')
  if (Array.isArray(d.user_confirmations)) d.user_confirmations.forEach((u, i) => confirmation(c, u, `user_confirmations[${i}]`))
  if (Array.isArray(d.excluded_items)) {
    d.excluded_items.forEach((x, i) => {
      if (isObj(x)) c.push(`excluded_items[${i}].work_item_key`, 'work_item', 'local_key', 'excluded', () => x.work_item_key, (v) => { x.work_item_key = v })
    })
  }
  if (Array.isArray(d.assumptions)) {
    d.assumptions.forEach((a, i) => {
      if (isObj(a) && Array.isArray(a.related_keys)) {
        a.related_keys.forEach((_, j) => {
          c.push(`assumptions[${i}].related_keys[${j}]`, 'work_item', 'local_key', 'assumption', () => a.related_keys[j], (v) => { a.related_keys[j] = v })
        })
      }
    })
  }
  if (isObj(d.applied_summary)) {
    const s = d.applied_summary
    if (Array.isArray(s.id_map)) {
      s.id_map.forEach((e, i) => {
        // formal_id 是历史对象关联：包内存在则重映射，缺失走隔离映射仅展示；application_id 只是追溯标识，不查 ops。
        if (isObj(e)) c.push(`applied_summary.id_map[${i}].formal_id`, e.object_type, 'formal', 'applied_history', () => e.formal_id, (v) => { e.formal_id = v })
      })
    }
    if (Array.isArray(s.unscheduled_kept)) {
      s.unscheduled_kept.forEach((x, i) => {
        if (isObj(x)) c.push(`applied_summary.unscheduled_kept[${i}].work_item_key`, 'work_item', 'local_key', 'applied_history', () => x.work_item_key, (v) => { x.work_item_key = v })
      })
    }
    if (Array.isArray(s.cancelled_plan_item_ids)) {
      s.cancelled_plan_item_ids.forEach((_, i) => {
        c.push(`applied_summary.cancelled_plan_item_ids[${i}]`, 'plan_item', 'formal', 'applied_history', () => s.cancelled_plan_item_ids[i], (v) => { s.cancelled_plan_item_ids[i] = v })
      })
    }
    if (s.replan_task_id != null) {
      c.push('applied_summary.replan_task_id', 'task', 'formal', 'applied_history', () => s.replan_task_id, (v) => { s.replan_task_id = v })
    }
  }
  if (Array.isArray(d.revision_history)) d.revision_history.forEach((h, i) => snapshot(c, h, `revision_history[${i}]`))
}

// 返回记录的全部类型化引用访问器。recordType: 'draft' | 'thread'。
export function assistantRefEntries(record, recordType) {
  const c = collector()
  if (recordType === 'draft') draft(c, record)
  else if (recordType === 'thread') thread(c, record)
  else throw new Error(`未知助手记录类型：${recordType}`)
  return c.entries
}

// 历史快照路径：revision_history 内与 applied_summary 的引用按历史宽容规则（保留+隔离映射+needs_review），
// 不与当前活引用同口径拒绝。
export function isHistoricalRefPath(entry) {
  return entry.path.startsWith('revision_history') || entry.purpose === 'applied_history'
}

// 一个版本作用域内的局部 key 集合（task key / work item key / requirement key / segment key）。
function scopeKeys(proposal, planningInput, planningResult, requirements) {
  const keys = { task: new Set(), action: new Set(), work_item: new Set(), requirement: new Set(), segment: new Set() }
  if (isObj(proposal)) {
    for (const t of proposal.task_proposals ?? []) if (isObj(t) && t.key != null) keys.task.add(t.key)
    for (const a of proposal.action_proposals ?? []) if (isObj(a) && a.key != null) keys.action.add(a.key)
    for (const w of proposal.work_items ?? []) if (isObj(w) && w.key != null) keys.work_item.add(w.key)
    for (const r of proposal.requirement_candidates ?? []) if (isObj(r) && r.key != null) keys.requirement.add(r.key)
  }
  for (const w of (isObj(planningInput) && planningInput.work_items) || []) if (isObj(w) && w.key != null) keys.work_item.add(w.key)
  for (const r of requirements || []) if (isObj(r) && r.key != null) keys.requirement.add(r.key)
  for (const s of (isObj(planningResult) && planningResult.segments) || []) if (isObj(s) && s.segment_key != null) keys.segment.add(s.segment_key)
  return keys
}

// 读取时计算引用解析状态。live: { source, note, task, action, plan_item, focus_session, draft, thread }
// 各为当前捕获空间活 ID 的 Set。返回逐条 { path, targetType, namespace, purpose, value, state }：
// state ∈ resolved | missing | local | historical_missing | turn_missing。
// missing（活引用）→ 调用方标 needs_review；historical_missing → 保留内容、隔离映射，不拒绝整包。
export function resolveAssistantRefs({ draft: d, thread: t, live }) {
  const entries = assistantRefEntries(d, 'draft')
  const currentKeys = scopeKeys(d.proposal, d.planning_input, d.planning_result, [])
  // requirement 型确认指向 requirement_id：候选 key 与线程已确认要求都算注册。
  for (const r of (t && t.confirmed_requirements) || []) if (isObj(r) && r.requirement_id != null) currentKeys.requirement.add(r.requirement_id)
  const historyKeys = new Map()
  if (Array.isArray(d.revision_history)) {
    d.revision_history.forEach((h, i) => {
      if (isObj(h)) historyKeys.set(i, scopeKeys(h.proposal, h.planning_input, h.planning_result, h.requirements))
    })
  }
  const turnIds = new Set(((t && t.messages) || []).map((m) => m && m.id).filter(Boolean))
  const out = []
  for (const e of entries) {
    const value = e.get()
    const historical = isHistoricalRefPath(e)
    let state
    if (e.namespace === 'formal') {
      const set = live && live[e.targetType]
      const ok = set instanceof Set && set.has(value)
      state = ok ? 'resolved' : (historical ? 'historical_missing' : 'missing')
    } else if (e.namespace === 'turn') {
      state = turnIds.has(value) ? 'resolved' : 'turn_missing'
    } else if (e.namespace === 'date') {
      state = 'local'
    } else {
      const m = /^revision_history\[(\d+)\]/.exec(e.path)
      const keys = m ? historyKeys.get(Number(m[1])) : currentKeys
      const set = keys && keys[e.targetType]
      state = set && set.has(value) ? 'resolved' : (historical ? 'historical_missing' : 'missing')
    }
    out.push({ path: e.path, targetType: e.targetType, namespace: e.namespace, purpose: e.purpose, value, state, ...(e.meta ? { meta: e.meta } : {}) })
  }
  return out
}