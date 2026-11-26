import { manualSegmentKey } from './manualSchedule.js'
import { COUNTED_STATES } from '../planning/protocol.js'

export function adoptedPlanActions(drafts) {
  const bindings = new Map()
  for (const draft of drafts) {
    if (draft.status !== 'applied') continue
    const ids = draft.applied_summary?.id_map ?? []
    const actionIds = new Map(ids.filter(row => row.object_type === 'action').map(row => [row.draft_key, row.formal_id]))
    const result = draft.planning_result
    const refs = new Map((result?.segments ?? []).map(s => [s.segment_key, s.suggested_action_ref]))
    const works = new Map((draft.planning_input?.work_items ?? []).map(w => [w.key, w]))
    for (const [index, gap] of (result?.unscheduled ?? []).entries()) {
      refs.set(manualSegmentKey(index), works.get(gap.work_item_key)?.action_ref)
    }
    for (const row of ids) {
      if (row.object_type !== 'plan_item') continue
      const ref = refs.get(row.draft_key)
      bindings.set(row.formal_id, ref?.kind === 'existing' ? ref.id : actionIds.get(ref?.key))
    }
  }
  return bindings
}

// A model may estimate an action and its individual deliverables differently.
// For actions created by an adopted draft, use the actual approved workload.
export function adoptedActionEstimates(drafts) {
  const estimates = new Map()
  for (const draft of drafts) {
    if (draft.status !== 'applied') continue
    const created = new Set((draft.proposal?.action_proposals ?? []).filter(a => a.op === 'create').map(a => a.key))
    const ids = new Map((draft.applied_summary?.id_map ?? []).filter(r => r.object_type === 'action').map(r => [r.draft_key, r.formal_id]))
    const excluded = new Set((draft.planning_result?.excluded_items ?? []).map(w => w.work_item_key))
    for (const work of draft.planning_input?.work_items ?? []) {
      const ref = work.action_ref
      if (excluded.has(work.key) || ref?.kind !== 'draft' || !created.has(ref.key) || !ids.has(ref.key) || !(work.remaining_minutes > 0)) continue
      const id = ids.get(ref.key)
      estimates.set(id, (estimates.get(id) ?? 0) + work.remaining_minutes)
    }
  }
  return estimates
}

export function unallocatedActions(actions, plans, bindings, replacementIds, estimates = new Map()) {
  const covered = new Map()
  for (const plan of plans) {
    if (!COUNTED_STATES.includes(plan.state) || replacementIds.has(plan.id)) continue
    const id = bindings.get(plan.id)
    if (id) covered.set(id, (covered.get(id) ?? 0) + plan.planned_minutes)
  }
  return actions.filter(action => !action.done).map(action => ({
    ...action, remaining: Math.max(0, (estimates.get(action.id) ?? action.minutes) - (covered.get(action.id) ?? 0)),
  })).filter(action => action.remaining > 0)
}
