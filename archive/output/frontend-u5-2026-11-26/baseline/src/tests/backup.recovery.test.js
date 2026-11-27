import { describe, it, expect } from 'vitest'
import { buildRecoveryPlan, recoveryOwner, RECOVERY_OWNER_PREFIX } from '@/services/backup/recovery'
import { buildRemap } from '@/services/backup/remap'
import { takeoverPlan, recoverPlan, resumePlan, legacyEndPlan } from '@/domains/focus'
import { buildCompleteBackup, rebuild, findDoc } from './backupFixtures'

const counter = () => { let n = 0; return () => `new-${++n}` }
const TARGET = 'ws-restore-1'
const NOW_MS = Date.parse('2026-11-22T16:00:00+08:00')
const applyRt = (runtime, puts) => { const m = new Map(runtime.map((r) => [r.id, r])); for (const p of puts) m.set(p.id, p); return [...m.values()] }
const applyDocs = (docs, puts) => { const m = new Map(docs.map((d) => [d.id, d])); for (const p of puts) m.set(p.id, p); return [...m.values()] }

async function setup(mutate) {
  const archive = mutate ? await rebuild(mutate) : await buildCompleteBackup()
  const remap = buildRemap({ manifest: archive.manifest, sources: archive.sources, docs: archive.docs, targetWorkspaceId: TARGET, targetName: '恢复空间', createdAt: '2026-11-22T16:00:00+08:00', newId: counter() })
  const plan = buildRecoveryPlan({ docs: remap.docs, workspaceId: TARGET, nowMs: NOW_MS })
  const env = { ws: TARGET, wallNow: new Date(NOW_MS).toISOString(), ownerId: 'page-test', newId: counter(), allDocs: plan.docs }
  return { remap, plan, env }
}

describe('未结束会话恢复准备', () => {
  it('v1 未结束→暂停 + 过期租约占位持有者协调记录，不占全局运行位', async () => {
    const { remap, plan } = await setup()
    const id = remap.liveMap.get('focus-paused')
    const s = plan.docs.find((d) => d.id === id)
    expect(s.running).toBe(false)
    expect(s.timer_anchor_at).toBe(null)
    expect(s.outcome).toBe(null)
    expect(s.ended_at).toBe(null)
    expect(s.accumulated_ms).toBe(600000) // 保留已存累计
    expect(s.draft_md).toBe('检查中')
    expect(s.started_at).toBe('2026-11-22T09:00:00+08:00') // 首次开始不变
    expect(s.task_ref_state).toBe('active')
    const rt = plan.runtimePuts.find((r) => r.id === `sess:${id}`)
    expect(rt.owner_id).toBe(recoveryOwner(id))
    expect(rt.owner_id.startsWith(RECOVERY_OWNER_PREFIX)).toBe(true)
    expect(rt.owner_id).not.toBe('page-test')
    expect(rt.lease_expires_at).toBeLessThan(NOW_MS)
    expect(rt).toMatchObject({ epoch: 1, revision: 1, draft_seq: 0, recovery: null, ended: false })
    expect(plan.runtimePuts.find((r) => r.kind === 'running').session_id).toBe(null)
    expect(plan.unfinishedV1).toEqual([id])
  })

  it('打开恢复空间走 takeover→recover→resume，无死路、离线间隔不计入', async () => {
    const { remap, plan, env } = await setup()
    const id = remap.liveMap.get('focus-paused')
    let runtime = plan.runtimePuts
    let docs = plan.docs
    // 占位持有者 + 过期租约 → 页面可接管（epoch+1），pending_ms=0（暂停态无离线间隔）
    const tk = takeoverPlan(docs, runtime, env, { sessionId: id })
    expect(tk.info.recovery.pending_ms).toBe(0)
    runtime = applyRt(runtime, tk.runtimePuts)
    const rt2 = runtime.find((r) => r.id === `sess:${id}`)
    expect(rt2.owner_id).toBe('page-test')
    expect(rt2.epoch).toBe(2)
    expect(rt2.recovery).toBeTruthy()
    // 恢复确认（keep）→ 清 recovery，累计不变
    const rc = recoverPlan(docs, runtime, env, { sessionId: id, epoch: 2, mode: 'keep' })
    runtime = applyRt(runtime, rc.runtimePuts)
    docs = applyDocs(docs, rc.puts)
    expect(rc.info.session.accumulated_ms).toBe(600000)
    expect(runtime.find((r) => r.id === `sess:${id}`).recovery).toBe(null)
    // 继续 → 运行，锚点=当前墙上时间，累计仍 600000（未把离线时段计入）
    const rs = resumePlan(docs, runtime, env, { sessionId: id, epoch: 2 })
    expect(rs.info.session.running).toBe(true)
    expect(rs.info.session.accumulated_ms).toBe(600000)
    expect(rs.info.session.timer_anchor_at).toBe(env.wallNow)
  })

  it('已结束会话（v1/v0/历史删除）恢复准备不改写事实', async () => {
    const { remap, plan } = await setup()
    for (const oldId of ['focus-ended', 'focus-deleted', 'focus-v0']) {
      const id = remap.liveMap.get(oldId)
      expect(plan.docs.find((d) => d.id === id)).toEqual(remap.docs.find((d) => d.id === id))
    }
  })

  it('v0 未结束→只 running=false，不补 v1 字段，显式 legacyEnd 可归档', async () => {
    const { remap, plan, env } = await setup(({ docs }) => {
      const p = findDoc(docs, 'focus-paused'); p.ended_at = '2026-11-22T09:30:00+08:00'; p.outcome = 'done'; p.running = false; p.timer_anchor_at = null
      const v0 = findDoc(docs, 'focus-v0'); v0.ended_at = null; v0.outcome = null
    })
    const id = remap.liveMap.get('focus-v0')
    const s = plan.docs.find((d) => d.id === id)
    expect(s.running).toBe(false)
    expect(s.ended_at).toBe(null)
    expect(s.task_snapshot).toBeUndefined()
    expect(s.timer_anchor_at).toBeUndefined()
    expect(s.task_ref_state).toBeUndefined()
    expect(plan.legacyEnds).toEqual([id])
    expect(plan.runtimePuts.some((r) => r.id === `sess:${id}`)).toBe(false) // v0 不建 v1 协调记录
    const le = legacyEndPlan(plan.docs, plan.runtimePuts, env, { sessionId: id, outcome: 'partial', accumulatedMs: 900000 })
    expect(le.info.session.ended_at).toBe(env.wallNow)
    expect(le.info.session.outcome).toBe('partial')
    expect(le.info.session.running).toBe(false)
    expect(le.info.session.task_snapshot).toBeUndefined()
  })

  it('多次恢复各自暂停，run 占位均为空，不互相占用全局运行位', async () => {
    const a = await setup()
    const b = await setup()
    const runs = [...a.plan.runtimePuts, ...b.plan.runtimePuts].filter((r) => r.kind === 'running')
    expect(runs.length).toBe(2)
    for (const r of runs) expect(r.session_id).toBe(null)
  })

  it('备份中的运行中 v1 会话恢复后暂停，只保留已存累计（不计离线间隔）', async () => {
    const { remap, plan } = await setup(({ docs }) => {
      const s = findDoc(docs, 'focus-paused'); s.running = true; s.timer_anchor_at = '2026-11-22T09:10:00+08:00'
    })
    const id = remap.liveMap.get('focus-paused')
    const s = plan.docs.find((d) => d.id === id)
    expect(s.running).toBe(false)
    expect(s.timer_anchor_at).toBe(null)
    expect(s.ended_at).toBe(null)
    expect(s.accumulated_ms).toBe(600000) // 已存累计，而非 600000+离线间隔
    expect(plan.runtimePuts.find((r) => r.id === `sess:${id}`).lease_expires_at).toBeLessThan(NOW_MS)
  })
})