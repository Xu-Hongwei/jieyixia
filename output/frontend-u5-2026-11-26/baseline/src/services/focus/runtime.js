// focus_runtime 运行元数据（协调记录/全局运行位置/幂等台账）的类型构造与清理。
// 纯函数，不触库。这些记录不是契约域模型、不是用户成果：不进备份导出，
// owner/epoch/租约/草稿序号只在这里，绝不私塞 FocusSession 领域对象。

export const runId = (workspaceId) => `run:${workspaceId}`
export const sessId = (sessionId) => `sess:${sessionId}`
export const opsId = (workspaceId) => `ops:${workspaceId}`
// 每日安排本地回执命名空间（5A-0 §6.1）：独立 kind/id，绝不混用 Focus 的 ops/session/run 记录。
// 只是本地幂等台账，不是业务契约、不进备份导出、恢复不重放旧操作。复用同一 entries/stale 清理工具。
export const planOpsId = (workspaceId) => `plan_ops:${workspaceId}`

// 全局运行位置：每空间一条；全库 running 唯一 = 所有 run 记录中至多一条 session_id 非空。
export function makeRunRecord(workspaceId, sessionId, nowMs) {
  return { id: runId(workspaceId), kind: 'running', workspace_id: workspaceId, session_id: sessionId || null, updated_at: nowMs }
}

export function makeSessionRuntime({ sessionId, workspaceId, ownerId, nowMs, leaseMs }) {
  return {
    id: sessId(sessionId), kind: 'session', session_id: sessionId, workspace_id: workspaceId,
    owner_id: ownerId, epoch: 1, lease_expires_at: nowMs + leaseMs,
    revision: 1, draft_seq: 0, last_checkpoint_at: nowMs,
    recovery: null, ended: false, updated_at: nowMs,
  }
}

export function makeOpsRecord(workspaceId) {
  return { id: opsId(workspaceId), kind: 'ops', workspace_id: workspaceId, entries: [], stale: [] }
}

export function makePlanOpsRecord(workspaceId) {
  return { id: planOpsId(workspaceId), kind: 'plan_ops', workspace_id: workspaceId, entries: [], stale: [] }
}

// 台账只存活重试窗口；每次事务顺带清理过期条目。entry 只存结果摘要，不存草稿正文。
// 过期条目不静默丢弃：降为墓碑（request_id/op/session_id/at_ms/issued_at_ms，无结果正文），
// 使过窗重放仍可被明确拒绝（STALE_REQUEST），不因缺字段或台账清理绕过。墓碑上限 200 条。
export const OPS_TOMBSTONE_CAP = 200
export function pruneOps(record, nowMs, windowMs) {
  const entries = record.entries || []
  const keep = entries.filter((e) => e.at_ms >= nowMs - windowMs)
  if (keep.length === entries.length) return record
  const expired = entries.filter((e) => e.at_ms < nowMs - windowMs)
  const tombstones = expired.map((e) => ({
    request_id: e.request_id, op: e.op, session_id: e.session_id ?? null, at_ms: e.at_ms, issued_at_ms: e.issued_at_ms ?? e.at_ms,
  }))
  const stale = [...(record.stale || []).filter((t) => !tombstones.some((n) => n.request_id === t.request_id)), ...tombstones]
    .sort((a, b) => a.at_ms - b.at_ms)
    .slice(-OPS_TOMBSTONE_CAP)
  return { ...record, entries: keep, stale }
}

export function appendOps(record, entry, nowMs, windowMs) {
  const pruned = pruneOps(record, nowMs, windowMs)
  return { ...pruned, entries: [...pruned.entries.filter((e) => e.request_id !== entry.request_id), entry] }
}

export function opsEntryOf(record, requestId) {
  return record ? (record.entries || []).find((e) => e.request_id === requestId) || null : null
}

export function opsTombstoneOf(record, requestId) {
  return record ? (record.stale || []).find((t) => t.request_id === requestId) || null : null
}

export function validateRuntimeRecord(r) {
  if (!r || typeof r.id !== 'string') throw new Error('runtime 记录缺少 id')
  if (r.kind === 'running') {
    if (r.id !== runId(r.workspace_id)) throw new Error('running 记录 id 与空间不一致')
    if (!('session_id' in r)) throw new Error('running 记录缺少 session_id')
  } else if (r.kind === 'session') {
    if (r.id !== sessId(r.session_id)) throw new Error('session 协调记录 id 与会话不一致')
    if (!Number.isInteger(r.epoch) || r.epoch < 1) throw new Error('epoch 必须为正整数')
    if (!Number.isInteger(r.revision) || r.revision < 1) throw new Error('revision 必须为正整数')
    if (!Number.isInteger(r.draft_seq) || r.draft_seq < 0) throw new Error('draft_seq 必须为非负整数')
  } else if (r.kind === 'ops') {
    if (r.id !== opsId(r.workspace_id)) throw new Error('ops 记录 id 与空间不一致')
    if (!Array.isArray(r.entries)) throw new Error('ops 记录 entries 必须为数组')
    if (r.stale != null && !Array.isArray(r.stale)) throw new Error('ops 记录 stale 必须为数组')
  } else if (r.kind === 'plan_ops') {
    if (r.id !== planOpsId(r.workspace_id)) throw new Error('plan_ops 记录 id 与空间不一致')
    if (!Array.isArray(r.entries)) throw new Error('plan_ops 记录 entries 必须为数组')
    if (r.stale != null && !Array.isArray(r.stale)) throw new Error('plan_ops 记录 stale 必须为数组')
  } else {
    throw new Error('未知 runtime 记录类型')
  }
  return r
}