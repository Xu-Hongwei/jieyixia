// 专注会话服务：每会话 Promise 队列串行、requestId 幂等台账、检查点调度、
// owner/epoch 协调、恢复与 v0 遗留结束。所有写入走 db.transformFocusAtomic，
// 无「直接 put focus」旁路；不依赖组件生命周期。
// owner/租约/草稿序号只在 focus_runtime 元数据，绝不进 FocusSession 领域对象。
//
// 请求信封协议（防旧请求重执行，正确性不依赖有限台账/墓碑）：
// - 无 requestId：新用户意图，服务创建一次性信封（request_id + issued_at_ms），结果带回供重试复用。
// - requestId + issuedAtMs：不可变信封重试，年龄按信封签发时刻校验，跨实例/刷新后仍有效。
// - 仅 requestId：本地签发记录或台账能验证才沿用原签发时刻；都无法验证 → REQUEST_ENVELOPE_REQUIRED，
//   绝不把无法验证的旧 ID 默认成「刚刚签发」的新请求。
// 调用端（store/UI）负责首次创建、失败重试保留原信封；issueRequest 可预先创建信封。
import { transformFocusAtomic, allFocusRuntime, snapshot } from '../storage/db'
import {
  FOCUS_PARAMS, beginPlan, checkpointPlan, pausePlan, resumePlan, endPlan,
  saveDraftPlan, recoverPlan, takeoverPlan, legacyEndPlan,
} from '../../domains/focus'
import { opsId, makeOpsRecord, appendOps, opsEntryOf, opsTombstoneOf, sessId } from './runtime'

const DEFAULT_SCHEDULER = { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h) }
const mergeById = (rows, puts) => {
  const next = [...rows]
  for (const p of puts || []) {
    const i = next.findIndex((r) => r.id === p.id)
    if (i >= 0) next[i] = p
    else next.push(p)
  }
  return next
}

// —— 5A-2A 请求输入指纹：同 requestId 换业务输入必须拒绝，不能回放旧成功谎称新输入已保存 ——
// FNV-1a 32 位非加密哈希，仅作相等性指纹（检测输入变化，不抗攻击）。正文只存「长度:哈希」，
// 台账不存明文副本。draftSeq 不入指纹：服务排队前分配、重试会再分配但 replay 零写入不消费，
// 入指纹会造成自身失配；expectedRevision 是用户冻结的修订前提，入指纹。
// 规范化依赖单一来源构造口（planSnapshot/beginFactsOf/historySignature 固定键序）。
const fnv1a = (str) => {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
const blockerFp = (input) => (input.outcome === 'blocked' ? String(input.blocker ?? '').trim() : null)
const inputFingerprint = (op, input) => {
  if (op === 'begin') {
    return fnv1a(JSON.stringify({
      taskId: input.taskId ?? null, actionId: input.actionId ?? null, planItemId: input.planItemId ?? null,
      confirmBlocked: input.confirmBlocked === true, expected: input.expected ?? null, facts: input.facts ?? null,
    }))
  }
  if (op === 'end') {
    return fnv1a(JSON.stringify({
      outcome: input.outcome ?? null, blocker: blockerFp(input), draftMd: `${String(input.draftMd ?? '').length}:${fnv1a(String(input.draftMd ?? ''))}`,
      planProgress: input.planProgress ?? null, expected: input.expected ?? null,
      historyConfirm: input.historyConfirm ?? null, expectedRevision: input.expectedRevision ?? null,
    }))
  }
  if (op === 'legacyEnd') {
    return fnv1a(JSON.stringify({
      outcome: input.outcome ?? null, blocker: blockerFp(input), accumulatedMs: input.accumulatedMs ?? null,
      planProgress: input.planProgress ?? null, expected: input.expected ?? null, historyConfirm: input.historyConfirm ?? null,
    }))
  }
  return null
}
// 旧台账无指纹时：携带计划确认参数的请求无法验证即拒绝；纯无计划输入按原规则 replay（不伪造指纹）。
const hasPlanConfirmInput = (op, input) =>
  op === 'begin' ? input.planItemId != null
    : (input.planProgress != null || input.expected != null || input.historyConfirm != null)

const staleRequest = (message) => Object.assign(new Error(message), { code: 'STALE_REQUEST' })
// 正常事务回放与 SAVE_FAILED 回执探测共用同一套验证（R1）：操作/空间/目标绑定、签发时刻、
// 输入指纹、旧台账兼容、重试窗口。任何无法验证或输入不符都不得返回成功回执。
function assertReplayEntry(entry, { op, targetSid, ws, stamp, nowMs, fp, planInput, windowMs }) {
  if (entry.op == null || !('session_id' in entry)) throw staleRequest('台账缺少操作绑定，无法验证该请求，请重新发起')
  if (entry.op !== op || entry.session_id !== targetSid || (entry.workspace_id != null && entry.workspace_id !== ws)) {
    throw staleRequest('requestId 台账绑定与当前操作/空间/会话不符，请重新发起')
  }
  const vouch = entry.issued_at_ms ?? entry.at_ms
  if (stamp != null && vouch !== stamp) throw staleRequest('信封签发时刻与台账记录不一致，请复用原信封')
  if (entry.input_fp == null) {
    if (fp != null && planInput) throw staleRequest('旧台账无法验证计划确认输入，请重新发起')
  } else if (fp !== entry.input_fp) {
    throw staleRequest('请求输入已变化（结果/正文/安排/行动），请重新核对后签发新意图')
  }
  if (vouch == null || vouch < nowMs - windowMs) throw staleRequest('请求超出重试窗口，请重新发起')
}

// deps 全部可注入：getWorkspaceId（当前空间读取器）、ownerId（页面实例 id，刷新换新走接管）、
// wallNow/newId（时钟与 ID）、params（检查点/租约/窗口阈值）、scheduler（定时器，单测用受控调度）。
export function createFocusService(deps = {}) {
  const {
    getWorkspaceId,
    ownerId = crypto.randomUUID(),
    wallNow = () => new Date().toISOString(),
    newId = () => crypto.randomUUID(),
    params = {},
    scheduler = DEFAULT_SCHEDULER,
  } = deps
  if (typeof getWorkspaceId !== 'function') throw new Error('createFocusService 需要 getWorkspaceId')
  const P = { ...FOCUS_PARAMS, ...params }
  const queues = new Map()
  const timers = new Map()
  const epochs = new Map()
  const draftSeqs = new Map()
  // 排队前捕获的编辑序号（含已排队未提交），保证同 tick 多次保存各拿独立递增序号。
  const pendingSeqs = new Map()
  // requestId → 首次调用时捕获的签发时刻与 op/空间/会话绑定；重试沿用原值，超窗顺带清理。
  const issued = new Map()

  const enqueue = (key, job) => {
    const tail = (queues.get(key) || Promise.resolve()).catch(() => {})
    const run = tail.then(job)
    const settled = run.catch(() => {})
    queues.set(key, settled)
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key) })
    return run
  }

  const stopTimer = (sessionId) => {
    const h = timers.get(sessionId)
    if (h != null) scheduler.clear(h)
    timers.delete(sessionId)
  }
  const startTimer = (sessionId) => {
    stopTimer(sessionId)
    const h = scheduler.set(() => {
      runOp('checkpoint', { sessionId, epoch: epochs.get(sessionId) }, checkpointPlan)
        .then((res) => { if (!res.ok) stopTimer(sessionId) })
    }, P.CHECKPOINT_MS)
    timers.set(sessionId, h)
  }

  const replayResult = (r, workspaceId, requestId) => ({
    ok: r.ok, code: r.code, workspace_id: workspaceId, session_id: r.session_id,
    request_id: requestId, revision: r.revision, issued_at_ms: r.issued_at_ms ?? null, replayed: true,
  })

  // replay/台账探测拿到的只有结果摘要：回种本 owner 的 epoch/草稿序号，运行中则恢复检查点调度。
  async function seedSession(sessionId, op) {
    try {
      const res = await allFocusRuntime()
      const rt = res.records.find((r) => r.id === sessId(sessionId))
      if (!rt || rt.owner_id !== ownerId || rt.ended) return
      epochs.set(sessionId, rt.epoch)
      draftSeqs.set(sessionId, rt.draft_seq)
      if ((op === 'begin' || op === 'resume') && !rt.recovery) startTimer(sessionId)
    } catch { /* 回种失败不影响结果返回 */ }
  }

  async function runOp(op, rawInput, domainPlan) {
    // R4/R5：接纳入口即深拷贝为服务独占快照。复用 db.snapshot（deepRaw 逐层脱 Vue 代理后 structuredClone）：
    // 顶层即使是普通对象，expected/facts/historyConfirm 仍可能嵌 ref.value/reactive 数组
    // （PlanEditor/PlanDetail 的确认基线就存在 ref 里），直接 structuredClone 会抛 DataCloneError。
    // 指纹、绑定校验、队列 key、事务执行、台账、SAVE_FAILED 探测全部读同一份已捕获命令；
    // 不冻结调用方原对象（避免副作用）；服务自分配的 draftSeq/epoch 按现有规则组合到内部命令。
    let input
    try {
      input = snapshot(rawInput)
    } catch {
      // 协议外确实无法复制的值：明确输入错误，零写入零登记；不得描述成「数据库保存结果未知」。
      return {
        ok: false, code: 'INVALID_FIELD', message: '命令输入无法快照：含不可深拷贝的值，请传纯数据后重试',
        workspace_id: getWorkspaceId(), session_id: null, request_id: null, issued_at_ms: null,
      }
    }
    const wsAtCall = getWorkspaceId()
    const callMs = Date.parse(wallNow())
    for (const [rid, rec] of issued) {
      if (rec.issuedAtMs < callMs - P.OPS_WINDOW_MS) issued.delete(rid)
    }
    const hasRequestId = input.requestId != null
    const requestId = hasRequestId ? input.requestId : newId()
    const fp = inputFingerprint(op, input)
    const known = issued.get(requestId)
    if (known && (known.op !== op || known.ws !== wsAtCall || known.sessionId !== (input.sessionId ?? null))) {
      return {
        ok: false, code: 'STALE_REQUEST', message: 'requestId 已绑定其它操作/空间/会话，请重新发起',
        workspace_id: wsAtCall, session_id: input.sessionId ?? null, request_id: requestId, issued_at_ms: known.issuedAtMs,
      }
    }
    if (known && input.issuedAtMs != null && input.issuedAtMs !== known.issuedAtMs) {
      return {
        ok: false, code: 'STALE_REQUEST', message: '信封签发时刻与首次记录不一致，请复用原信封',
        workspace_id: wsAtCall, session_id: input.sessionId ?? null, request_id: requestId, issued_at_ms: known.issuedAtMs,
      }
    }
    // R2：首次接纳完整输入即冻结指纹（含首次事务失败、无台账回执的空档）；同 ID 换输入排队前拒绝。
    // issueRequest 只带部分参数不冻结；绑定在首次 runOp 接纳时建立，失败后保留。
    if (known && known.fp != null && fp != null && fp !== known.fp) {
      return {
        ok: false, code: 'STALE_REQUEST', message: '请求输入已变化（结果/正文/安排/行动），请重新核对后签发新意图',
        workspace_id: wsAtCall, session_id: input.sessionId ?? null, request_id: requestId, issued_at_ms: known.issuedAtMs,
      }
    }
    let issuedAtMs
    if (!hasRequestId) {
      issuedAtMs = callMs
      issued.set(requestId, { issuedAtMs, op, ws: wsAtCall, sessionId: input.sessionId ?? null, fp })
    } else if (input.issuedAtMs != null) {
      if (!Number.isInteger(input.issuedAtMs) || input.issuedAtMs <= 0) {
        return {
          ok: false, code: 'RELATION_INVALID', message: 'issuedAtMs 必须为正整数毫秒时刻',
          workspace_id: wsAtCall, session_id: input.sessionId ?? null, request_id: requestId,
        }
      }
      issuedAtMs = input.issuedAtMs
      if (!known) issued.set(requestId, { issuedAtMs, op, ws: wsAtCall, sessionId: input.sessionId ?? null, fp })
    } else if (known) {
      issuedAtMs = known.issuedAtMs
    } else {
      // 裸 requestId 且本地无签发记录：只能凭台账验证（事务内）；无凭据即明确拒绝。
      issuedAtMs = null
    }
    const bound = issued.get(requestId)
    if (bound && bound.fp == null && fp != null) bound.fp = fp
    // 编辑序号在排队前分配或捕获；显式 draftSeq 原样尊重，事务内绝不按到达顺序重新赋号。
    let effectiveInput = input
    const needsSeq = op === 'saveDraft' || op === 'end' || ((op === 'pause' || op === 'resume') && typeof input.draftMd === 'string')
    if (needsSeq && input.sessionId) {
      const sid = input.sessionId
      if (input.draftSeq != null) {
        pendingSeqs.set(sid, Math.max(pendingSeqs.get(sid) || 0, input.draftSeq))
      } else {
        const seq = Math.max(draftSeqs.get(sid) || 0, pendingSeqs.get(sid) || 0) + 1
        pendingSeqs.set(sid, seq)
        effectiveInput = { ...input, draftSeq: seq }
      }
    }
    const key = op === 'begin' ? `begin:${wsAtCall}` : input.sessionId
    return enqueue(key, async () => {
      const env = { ws: wsAtCall, wallNow: wallNow(), ownerId, newId, params: P }
      try {
        const applied = await transformFocusAtomic((latest, runtime, ctx) => {
          const nowMs = Date.parse(env.wallNow)
          const ops = runtime.find((r) => r.id === opsId(ctx.ws)) || makeOpsRecord(ctx.ws)
          const prior = opsEntryOf(ops, requestId)
          // replay 前校验持久绑定（跨实例内存 issued 丢失后的唯一凭据）：与异常探测共用 assertReplayEntry。
          // 目标会话是「请求输入」的 sessionId（begin 为 null），不是结果新建的会话 id。
          const targetSid = input.sessionId ?? null
          const replayCtx = { op, targetSid, ws: ctx.ws, nowMs, fp, planInput: hasPlanConfirmInput(op, input), windowMs: P.OPS_WINDOW_MS }
          if (issuedAtMs == null) {
            // 裸 requestId：台账条目是唯一签发凭据；墓碑证明它曾过期；两者皆无 → 不可验证，拒绝。
            const vouch = prior ? (prior.issued_at_ms ?? prior.at_ms) : null
            if (vouch == null) {
              if (opsTombstoneOf(ops, requestId)) {
                throw Object.assign(new Error('请求已超出重试窗口（台账已清理），请重新发起'), { code: 'STALE_REQUEST' })
              }
              throw Object.assign(new Error('无法验证该 requestId 的签发信息，请复用原信封重试或重新发起'), { code: 'REQUEST_ENVELOPE_REQUIRED' })
            }
            assertReplayEntry(prior, { ...replayCtx, stamp: null })
            return { info: { replay: prior.result } }
          }
          if (issuedAtMs < nowMs - P.OPS_WINDOW_MS) {
            throw Object.assign(new Error('请求超出重试窗口，请重新发起'), { code: 'STALE_REQUEST' })
          }
          if (prior) {
            assertReplayEntry(prior, { ...replayCtx, stamp: issuedAtMs })
            return { info: { replay: prior.result } }
          }
          if (opsTombstoneOf(ops, requestId)) {
            throw Object.assign(new Error('请求已超出重试窗口（台账已清理），请重新发起'), { code: 'STALE_REQUEST' })
          }
          let effective = effectiveInput
          let pre = null
          // 暂停/继续前合并最后草稿：同一事务先 saveDraft 再执行本操作，delta 只结算一次；
          // 合并草稿与主操作共用排队前捕获的同一编辑序号/修订前提。
          if ((op === 'pause' || op === 'resume') && typeof input.draftMd === 'string') {
            pre = saveDraftPlan(latest, runtime, { ...env, ws: ctx.ws }, { sessionId: input.sessionId, epoch: input.epoch ?? epochs.get(input.sessionId), draftSeq: effectiveInput.draftSeq, expectedRevision: input.expectedRevision, draftMd: input.draftMd })
            if (pre.info && pre.info.code) return pre
            latest = mergeById(latest, pre.puts)
            runtime = mergeById(runtime, pre.runtimePuts)
          }
          if (effective.epoch == null && op !== 'begin' && op !== 'takeover' && op !== 'legacyEnd') {
            effective = { ...effective, epoch: epochs.get(input.sessionId) }
          }
          const plan = domainPlan(latest, runtime, { ...env, ws: ctx.ws, allDocs: ctx.allDocs }, effective)
          const info = plan.info || {}
          const sessionId = (info.session && info.session.id) || input.sessionId || null
          const revision = (info.runtime && info.runtime.revision) != null ? info.runtime.revision : null
          const result = { ok: !info.code, code: info.code || null, session_id: sessionId, revision, issued_at_ms: issuedAtMs }
          // 台账绑定存「输入目标会话」（begin 为 null）与空间；结果会话 id 只在 result 里。
          // input_fp 只存哈希指纹（begin/end/legacyEnd），不存明文正文；其它 op 不带该字段。
          const entry = { request_id: requestId, op, workspace_id: ctx.ws, session_id: input.sessionId ?? null, at_ms: nowMs, issued_at_ms: issuedAtMs, result, ...(fp != null ? { input_fp: fp } : {}) }
          const opsDraft = appendOps(ops, entry, nowMs, P.OPS_WINDOW_MS)
          const puts = pre ? mergeById(pre.puts, plan.puts) : plan.puts
          const runtimePuts = mergeById(pre ? pre.runtimePuts : [], [...(plan.runtimePuts || []), opsDraft])
          return { puts, deletes: plan.deletes || [], runtimePuts, runtimeDeletes: plan.runtimeDeletes || [], info: { ...info, opResult: result } }
        })
        if (applied.info && applied.info.replay) {
          const r = applied.info.replay
          if (r.ok && r.session_id) await seedSession(r.session_id, op)
          return replayResult(r, applied.workspace_id, requestId)
        }
        const info = applied.info || {}
        const session = info.session || null
        const rt = info.runtime || null
        if (session && rt) {
          if (rt.epoch != null) epochs.set(session.id, rt.epoch)
          if (rt.draft_seq != null) draftSeqs.set(session.id, rt.draft_seq)
        }
        if (session) {
          if ((op === 'begin' || op === 'resume' || (op === 'recover' && session.running)) && !info.code) startTimer(session.id)
          if (op === 'pause' || op === 'end' || op === 'legacyEnd' || info.code) stopTimer(session.id)
        }
        const result = {
          ok: !info.code, code: info.code || null, workspace_id: applied.workspace_id,
          session_id: (session && session.id) || input.sessionId || null,
          request_id: requestId, revision: rt ? rt.revision : null, issued_at_ms: issuedAtMs,
        }
        if (session) result.session = session
        if (rt && rt.draft_seq != null) result.draft_seq = rt.draft_seq
        if (info.recovery) result.recovery = info.recovery
        if (info.action) result.action = info.action
        if (info.task) result.task = info.task
        if (info.planItem) result.planItem = info.planItem
        if (info.history) result.history = info.history
        if (info.samePlan) result.samePlan = true
        if (info.alreadyPaused) result.alreadyPaused = true
        if (info.alreadyRunning) result.alreadyRunning = true
        return result
      } catch (err) {
        const code = (err && err.code) || 'SAVE_FAILED'
        // 事务可能已提交但回调丢失：按 requestId 探台账。探测与正常回放共用完整验证（R1）：
        // 换输入/换签发时刻/旧台账无法验证 → 明确拒绝，绝不把旧成功当新输入的回执；
        // 无条目 → 保留 SAVE_FAILED 与原信封重试语义。验证拒绝不被外层 catch 吞回成功通路。
        if (code === 'SAVE_FAILED') {
          let probeEntry = null
          try {
            const probe = await allFocusRuntime()
            if (probe.workspace_id === wsAtCall) {
              probeEntry = opsEntryOf(probe.records.find((r) => r.id === opsId(wsAtCall)), requestId)
            }
          } catch { /* 探测读取失败：保留 SAVE_FAILED */ }
          if (probeEntry) {
            try {
              assertReplayEntry(probeEntry, {
                op, targetSid: input.sessionId ?? null, ws: wsAtCall, stamp: issuedAtMs,
                nowMs: Date.parse(wallNow()), fp, planInput: hasPlanConfirmInput(op, input), windowMs: P.OPS_WINDOW_MS,
              })
            } catch (verr) {
              return {
                ok: false, code: verr.code, message: verr.message,
                workspace_id: wsAtCall, session_id: input.sessionId ?? null, request_id: requestId, issued_at_ms: issuedAtMs,
              }
            }
            if (probeEntry.result.ok && probeEntry.result.session_id) await seedSession(probeEntry.result.session_id, op)
            return replayResult(probeEntry.result, wsAtCall, requestId)
          }
        }
        const result = {
          ok: false, code, message: (err && err.message) || '保存失败',
          workspace_id: wsAtCall, session_id: input.sessionId || null, request_id: requestId, issued_at_ms: issuedAtMs,
        }
        if (err && err.session) result.session = err.session
        if (err && err.recovery) result.recovery = err.recovery
        if (err && err.holder) result.holder = err.holder
        if (err && err.needsConfirmBlocked) result.needsConfirmBlocked = true
        if (err && err.currentSeq != null) result.currentSeq = err.currentSeq
        if (err && err.currentRevision != null) result.currentRevision = err.currentRevision
        if (err && err.leaseExpired) {
          result.leaseExpired = true
          result.lease_expires_at = err.lease_expires_at
        }
        // 计划联动拒绝的可定位事实：完整差异/异常明细/快照首差异/历史摘要对照，供 UI 列全重新核对。
        if (err && err.diffs) result.diffs = err.diffs
        if (err && err.problems) result.problems = err.problems
        if (err && err.history) result.history = err.history
        if (err && err.field != null) result.field = err.field
        if (err && err.expected !== undefined) result.expected = err.expected
        if (err && err.current !== undefined) result.current = err.current
        if (err && err.confirmed !== undefined) result.confirmed = err.confirmed
        if (['OWNER_CONFLICT', 'ALREADY_ENDED', 'RECOVERY_REQUIRED', 'LEGACY_RECOVERY_REQUIRED'].includes(code) && input.sessionId) {
          stopTimer(input.sessionId)
        }
        return result
      }
    })
  }

  return {
    ownerId,
    params: P,
    // 预先创建一次性请求信封（不执行）：调用端在用户意图产生时取一次，失败重试复用同一信封。
    // 只带部分参数（如 begin 的 taskId/actionId），不在此冻结输入指纹——完整输入绑定在首次 runOp 接纳时建立（R2）。
    issueRequest(op, input = {}) {
      const ws = getWorkspaceId()
      const callMs = Date.parse(wallNow())
      for (const [rid, rec] of issued) {
        if (rec.issuedAtMs < callMs - P.OPS_WINDOW_MS) issued.delete(rid)
      }
      const requestId = newId()
      issued.set(requestId, { issuedAtMs: callMs, op, ws, sessionId: input.sessionId ?? null })
      return { request_id: requestId, issued_at_ms: callMs, op, workspace_id: ws, session_id: input.sessionId ?? null }
    },
    begin: (input) => runOp('begin', input, beginPlan),
    checkpoint: (input) => runOp('checkpoint', input, checkpointPlan),
    pause: (input) => runOp('pause', input, pausePlan),
    resume: (input) => runOp('resume', input, resumePlan),
    end: (input) => runOp('end', input, endPlan),
    saveDraft: (input) => runOp('saveDraft', input, saveDraftPlan),
    recover: (input) => runOp('recover', input, recoverPlan),
    takeover: (input) => runOp('takeover', input, takeoverPlan),
    legacyEnd: (input) => runOp('legacyEnd', input, legacyEndPlan),
    // 刷新/重进空间后同步本 owner 的 epoch/草稿序号，并返回协调状态供页面判断恢复/只读。
    async loadState() {
      const ws = getWorkspaceId()
      const res = await allFocusRuntime()
      if (res.workspace_id !== ws) return { workspace_id: res.workspace_id, stale: true, sessions: [] }
      const sessions = res.records.filter((r) => r.kind === 'session' && r.workspace_id === ws)
      for (const r of sessions) {
        if (r.owner_id === ownerId && !r.ended) {
          epochs.set(r.session_id, r.epoch)
          draftSeqs.set(r.session_id, r.draft_seq)
        }
      }
      return { workspace_id: ws, sessions, running: res.records.filter((r) => r.kind === 'running' && r.session_id) }
    },
    stop() {
      for (const id of [...timers.keys()]) stopTimer(id)
    },
  }
}