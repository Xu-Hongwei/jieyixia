// focus_runtime 元数据构造/校验/幂等台账清理单测（纯函数）。
import { describe, expect, it } from 'vitest'
import {
  runId, sessId, opsId, makeRunRecord, makeSessionRuntime, makeOpsRecord,
  pruneOps, appendOps, opsEntryOf, opsTombstoneOf, validateRuntimeRecord, OPS_TOMBSTONE_CAP,
} from '../services/focus/runtime'

const entry = (id, atMs) => ({ request_id: id, op: 'checkpoint', session_id: 's1', at_ms: atMs, result: { ok: true, code: null, session_id: 's1', revision: 2 } })

describe('类型构造', () => {
  it('run/sess/ops 形状与 id 规则', () => {
    expect(makeRunRecord('w1', 's1', 100)).toEqual({ id: 'run:w1', kind: 'running', workspace_id: 'w1', session_id: 's1', updated_at: 100 })
    expect(makeRunRecord('w1', null, 100).session_id).toBeNull()
    const rt = makeSessionRuntime({ sessionId: 's1', workspaceId: 'w1', ownerId: 'tab-1', nowMs: 100, leaseMs: 30_000 })
    expect(rt).toMatchObject({ id: 'sess:s1', kind: 'session', owner_id: 'tab-1', epoch: 1, revision: 1, draft_seq: 0, lease_expires_at: 30_100, recovery: null, ended: false })
    expect(makeOpsRecord('w1')).toEqual({ id: 'ops:w1', kind: 'ops', workspace_id: 'w1', entries: [], stale: [] })
    expect(runId('w1')).toBe('run:w1')
    expect(sessId('s1')).toBe('sess:s1')
    expect(opsId('w1')).toBe('ops:w1')
  })
  it('validate：id/空间一致、epoch/revision/draft_seq 整数约束', () => {
    expect(() => validateRuntimeRecord(makeRunRecord('w1', null, 0))).not.toThrow()
    expect(() => validateRuntimeRecord({ ...makeRunRecord('w1', null, 0), id: 'run:w2' })).toThrow('id 与空间不一致')
    expect(() => validateRuntimeRecord({ ...makeSessionRuntime({ sessionId: 's1', workspaceId: 'w1', ownerId: 't', nowMs: 0, leaseMs: 1 }), epoch: 0 })).toThrow('epoch')
    expect(() => validateRuntimeRecord({ ...makeSessionRuntime({ sessionId: 's1', workspaceId: 'w1', ownerId: 't', nowMs: 0, leaseMs: 1 }), draft_seq: -1 })).toThrow('draft_seq')
    expect(() => validateRuntimeRecord({ id: 'x', kind: 'unknown' })).toThrow('未知 runtime')
    expect(() => validateRuntimeRecord(null)).toThrow('缺少 id')
  })
})

describe('幂等台账：窗口清理与追加', () => {
  it('只保留窗口内条目；边界（恰好到期）保留；过期条目降为墓碑不静默丢弃', () => {
    const ops = { ...makeOpsRecord('w1'), entries: [entry('old', 0), entry('edge', 1000), entry('new', 5000)] }
    const pruned = pruneOps(ops, 601_000, 600_000)
    expect(pruned.entries.map((e) => e.request_id)).toEqual(['edge', 'new'])
    expect(pruned.stale).toEqual([{ request_id: 'old', op: 'checkpoint', session_id: 's1', at_ms: 0, issued_at_ms: 0 }])
    expect(opsTombstoneOf(pruned, 'old').request_id).toBe('old')
    expect(opsTombstoneOf(pruned, 'edge')).toBeNull()
    expect(pruneOps(ops, 100, 600_000)).toBe(ops) // 无可清理时原对象返回
  })
  it('墓碑只存标识不存结果正文；上限 200 条保留最新；同 id 不重复', () => {
    let ops = makeOpsRecord('w1')
    for (let i = 0; i < OPS_TOMBSTONE_CAP + 50; i++) {
      ops = appendOps(ops, entry(`r${i}`, i * 1000), i * 1000, 600_000)
    }
    ops = pruneOps(ops, (OPS_TOMBSTONE_CAP + 50) * 1000 + 600_001, 600_000)
    expect(ops.stale.length).toBe(OPS_TOMBSTONE_CAP)
    expect(ops.stale[ops.stale.length - 1].request_id).toBe(`r${OPS_TOMBSTONE_CAP + 49}`)
    expect(JSON.stringify(ops.stale)).not.toContain('result')
    const again = pruneOps(ops, (OPS_TOMBSTONE_CAP + 50) * 1000 + 600_002, 600_000)
    expect(again.stale.length).toBe(OPS_TOMBSTONE_CAP)
    expect(() => validateRuntimeRecord(ops)).not.toThrow()
    expect(() => validateRuntimeRecord({ ...ops, stale: 'x' })).toThrow('stale')
  })
  it('追加去重同 requestId，顺带清理过期；只存结果摘要', () => {
    const ops = { ...makeOpsRecord('w1'), entries: [entry('old', 0), entry('dup', 5000)] }
    const next = appendOps(ops, entry('dup', 700_000), 700_000, 600_000)
    expect(next.entries.map((e) => e.request_id)).toEqual(['dup'])
    expect(next.entries[0].at_ms).toBe(700_000)
    expect(next.entries[0].result).toEqual({ ok: true, code: null, session_id: 's1', revision: 2 })
    expect(JSON.stringify(next)).not.toContain('draft_md')
  })
  it('opsEntryOf：命中/未命中/空台账', () => {
    const ops = appendOps(makeOpsRecord('w1'), entry('r1', 100), 100, 600_000)
    expect(opsEntryOf(ops, 'r1').request_id).toBe('r1')
    expect(opsEntryOf(ops, 'nope')).toBeNull()
    expect(opsEntryOf(null, 'r1')).toBeNull()
  })
})