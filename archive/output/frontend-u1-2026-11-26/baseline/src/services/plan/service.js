// 每日安排事务服务（5A-0 §6）：向 store 提供薄入口。全部业务校验与写入在事务里，
// UI 禁用按钮不能代替校验。命令沿用 db.transformFocusAtomic 覆盖 docs+focus_runtime
// （这不代表「创建 Focus」）；本地回执存独立 plan_ops 命名空间，不混 Focus ops/session/run，
// 不新增数据库 store，不进业务备份。纯读取无写入（读取走 domains/plan.js + week.js 纯函数）。
//
// 请求信封协议（与 Focus 同口径，防旧请求重执行，正确性不依赖有限台账/墓碑）：
// - 无 requestId：新用户意图，服务创建一次性信封（request_id + issued_at_ms），新建 PlanItem ID 预先固定。
// - requestId + issuedAtMs：不可变信封重试，年龄按签发时刻校验，跨实例/刷新后仍有效。
// - 仅 requestId：本地签发记录或台账能验证才沿用原签发时刻；都无法验证 → REQUEST_ENVELOPE_REQUIRED。
// - 相同 requestId 换输入/目标/空间 → STALE_REQUEST。用户修改输入或明确再添加 = 新意图（新 requestId）。
// 回执与业务变更同事务提交；迟到超窗明确拒绝，不因台账清理后当新请求重新执行。
import { transformFocusAtomic, allFocusRuntime } from '../storage/db'
import { PLAN_COMMANDS } from '../../domains/plan'
import { planOpsId, makePlanOpsRecord, appendOps, opsEntryOf, opsTombstoneOf } from '../focus/runtime'

const DEFAULT_PARAMS = { OPS_WINDOW_MS: 600_000 }
const CREATE_OPS = ['create', 'arrangeAnotherDay']

// 稳定签名：递归按 key 排序，使「相同输入」与键序无关；用于检测同 requestId 换输入。
function stableSig(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
  if (Array.isArray(v)) return `[${v.map(stableSig).join(',')}]`
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableSig(v[k])}`).join(',')}}`
}
const inputSignature = (input) => {
  const { requestId, issuedAtMs, ...rest } = input
  void requestId; void issuedAtMs
  return stableSig(rest)
}

export function createPlanService(deps = {}) {
  const {
    getWorkspaceId,
    wallNow = () => new Date().toISOString(),
    newId = () => crypto.randomUUID(),
    params = {},
  } = deps
  if (typeof getWorkspaceId !== 'function') throw new Error('createPlanService 需要 getWorkspaceId')
  const P = { ...DEFAULT_PARAMS, ...params }
  const queues = new Map()
  // requestId → 首次调用捕获的签发时刻与 op/空间/目标/输入签名/新建ID 绑定；重试沿用原值，超窗顺带清理。
  const issued = new Map()

  const enqueue = (key, job) => {
    const tail = (queues.get(key) || Promise.resolve()).catch(() => {})
    const run = tail.then(job)
    const settled = run.catch(() => {})
    queues.set(key, settled)
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key) })
    return run
  }

  const pruneIssued = (callMs) => {
    for (const [rid, rec] of issued) if (rec.issuedAtMs < callMs - P.OPS_WINDOW_MS) issued.delete(rid)
  }

  // 预先创建一次性信封（不执行）：调用端在用户意图产生时取一次，失败重试复用同一信封。
  // 新建类命令在此固定 PlanItem ID 与缺省日期（实时北京今天），重试不因跨午夜换日。
  function issueRequest(op, input = {}) {
    const ws = getWorkspaceId()
    const callMs = Date.parse(wallNow())
    pruneIssued(callMs)
    const requestId = newId()
    const planItemId = CREATE_OPS.includes(op) ? (input.planItemId || newId()) : (input.planItemId ?? null)
    const sig = inputSignature({ ...input, planItemId })
    issued.set(requestId, { issuedAtMs: callMs, op, ws, targetId: planItemId, sig, planItemId })
    return { request_id: requestId, issued_at_ms: callMs, op, workspace_id: ws, plan_item_id: planItemId }
  }

  const replayResult = (r, workspaceId, requestId) => ({
    ok: r.ok, code: r.code, workspace_id: workspaceId, plan_item_id: r.plan_item_id ?? null,
    request_id: requestId, issued_at_ms: r.issued_at_ms ?? null, replayed: true,
    ...(r.extra || {}),
  })

  async function runOp(op, input) {
    const domainPlan = PLAN_COMMANDS[op]
    if (!domainPlan) throw new Error(`未知安排命令 ${op}`)
    const wsAtCall = getWorkspaceId()
    const callMs = Date.parse(wallNow())
    pruneIssued(callMs)
    const hasRequestId = input.requestId != null
    const requestId = hasRequestId ? input.requestId : newId()
    // 新建类命令的目标 ID 在意图中固定：显式 input.planItemId 优先，否则信封绑定/新签发。
    const known = issued.get(requestId)
    let planItemId = CREATE_OPS.includes(op)
      ? (input.planItemId ?? (known ? known.planItemId : newId()))
      : (input.planItemId ?? null)
    const targetId = planItemId
    const sig = inputSignature({ ...input, planItemId })

    if (known && (known.op !== op || known.ws !== wsAtCall || known.targetId !== targetId || known.sig !== sig)) {
      return {
        ok: false, code: 'STALE_REQUEST', message: 'requestId 已绑定其它操作/输入/目标/空间，请重新发起',
        workspace_id: wsAtCall, plan_item_id: targetId, request_id: requestId, issued_at_ms: known.issuedAtMs,
      }
    }
    if (known && input.issuedAtMs != null && input.issuedAtMs !== known.issuedAtMs) {
      return {
        ok: false, code: 'STALE_REQUEST', message: '信封签发时刻与首次记录不一致，请复用原信封',
        workspace_id: wsAtCall, plan_item_id: targetId, request_id: requestId, issued_at_ms: known.issuedAtMs,
      }
    }
    let issuedAtMs
    if (!hasRequestId) {
      issuedAtMs = callMs
      issued.set(requestId, { issuedAtMs, op, ws: wsAtCall, targetId, sig, planItemId })
    } else if (input.issuedAtMs != null) {
      if (!Number.isInteger(input.issuedAtMs) || input.issuedAtMs <= 0) {
        return { ok: false, code: 'RELATION_INVALID', message: 'issuedAtMs 必须为正整数毫秒时刻', workspace_id: wsAtCall, plan_item_id: targetId, request_id: requestId }
      }
      issuedAtMs = input.issuedAtMs
      if (!known) issued.set(requestId, { issuedAtMs, op, ws: wsAtCall, targetId, sig, planItemId })
    } else if (known) {
      issuedAtMs = known.issuedAtMs
      planItemId = known.planItemId
    } else {
      issuedAtMs = null // 裸 requestId：只能凭台账验证（事务内）；无凭据即拒绝。
    }

    const effectiveInput = CREATE_OPS.includes(op) ? { ...input, planItemId } : input

    return enqueue(`plan:${wsAtCall}`, async () => {
      const env = { ws: wsAtCall, wallNow: wallNow(), newId }
      try {
        const applied = await transformFocusAtomic((latest, runtime, ctx) => {
          const nowMs = Date.parse(env.wallNow)
          const ops = runtime.find((r) => r.id === planOpsId(ctx.ws)) || makePlanOpsRecord(ctx.ws)
          const prior = opsEntryOf(ops, requestId)
          const assertReplayBinding = (entry, stamp) => {
            if (entry.op == null || !('plan_item_id' in entry) || entry.input_sig == null) {
              throw Object.assign(new Error('台账缺少操作绑定，无法验证该请求，请重新发起'), { code: 'STALE_REQUEST' })
            }
            if (entry.op !== op || entry.plan_item_id !== targetId || entry.input_sig !== sig
              || (entry.workspace_id != null && entry.workspace_id !== ctx.ws)) {
              throw Object.assign(new Error('requestId 台账绑定与当前操作/输入/目标/空间不符，请重新发起'), { code: 'STALE_REQUEST' })
            }
            if (stamp != null && (entry.issued_at_ms ?? entry.at_ms) !== stamp) {
              throw Object.assign(new Error('信封签发时刻与台账记录不一致，请复用原信封'), { code: 'STALE_REQUEST' })
            }
          }
          if (issuedAtMs == null) {
            const vouch = prior ? (prior.issued_at_ms ?? prior.at_ms) : null
            if (vouch == null) {
              if (opsTombstoneOf(ops, requestId)) throw Object.assign(new Error('请求已超出重试窗口（台账已清理），请重新发起'), { code: 'STALE_REQUEST' })
              throw Object.assign(new Error('无法验证该 requestId 的签发信息，请复用原信封重试或重新发起'), { code: 'REQUEST_ENVELOPE_REQUIRED' })
            }
            assertReplayBinding(prior, null)
            if (vouch < nowMs - P.OPS_WINDOW_MS) throw Object.assign(new Error('请求超出重试窗口，请重新发起'), { code: 'STALE_REQUEST' })
            return { info: { replay: prior.result } }
          }
          if (issuedAtMs < nowMs - P.OPS_WINDOW_MS) throw Object.assign(new Error('请求超出重试窗口，请重新发起'), { code: 'STALE_REQUEST' })
          if (prior) {
            assertReplayBinding(prior, issuedAtMs)
            return { info: { replay: prior.result } }
          }
          if (opsTombstoneOf(ops, requestId)) throw Object.assign(new Error('请求已超出重试窗口（台账已清理），请重新发起'), { code: 'STALE_REQUEST' })

          const plan = domainPlan(latest, { ...env, ws: ctx.ws }, effectiveInput)
          const info = plan.info || {}
          const resultPlanId = (info.planItem && info.planItem.id) || targetId || null
          // 回执只存校验重放所需摘要，不存原图/成果正文；额外 UI 事实（重复ID/风险/历史摘要）随结果带回。
          const extra = {}
          for (const k of ['matchingIds', 'confirmed', 'risk', 'history', 'blockedTask', 'sessionIds', 'fromDate', 'unchanged', 'current', 'field']) {
            if (info[k] !== undefined) extra[k] = info[k]
          }
          const result = { ok: !info.code, code: info.code || null, plan_item_id: resultPlanId, issued_at_ms: issuedAtMs, extra }
          const entry = {
            request_id: requestId, op, workspace_id: ctx.ws, plan_item_id: targetId,
            input_sig: sig, at_ms: nowMs, issued_at_ms: issuedAtMs, result,
          }
          const opsDraft = appendOps(ops, entry, nowMs, P.OPS_WINDOW_MS)
          return { puts: plan.puts || [], deletes: plan.deletes || [], runtimePuts: [opsDraft], runtimeDeletes: [], info: { ...info, opResult: result } }
        })
        if (applied.info && applied.info.replay) return replayResult(applied.info.replay, applied.workspace_id, requestId)
        const info = applied.info || {}
        const r = info.opResult
        const result = {
          ok: r.ok, code: r.code, workspace_id: applied.workspace_id, plan_item_id: r.plan_item_id,
          request_id: requestId, issued_at_ms: issuedAtMs, ...(r.extra || {}),
        }
        if (info.planItem) result.planItem = info.planItem
        return result
      } catch (err) {
        const code = (err && err.code) || 'SAVE_FAILED'
        // 事务可能已提交但回调丢失：按 requestId 探 plan_ops 台账，有结果即返回原事实，不重新创建。
        if (code === 'SAVE_FAILED') {
          try {
            const probe = await allFocusRuntime()
            if (probe.workspace_id === wsAtCall) {
              const entry = opsEntryOf(probe.records.find((r) => r.id === planOpsId(wsAtCall)), requestId)
              const bound = entry && entry.op === op && entry.plan_item_id === targetId && entry.input_sig === sig
                && (entry.workspace_id == null || entry.workspace_id === wsAtCall)
              if (bound) return replayResult(entry.result, wsAtCall, requestId)
            }
          } catch { /* 探测失败不影响原错误返回 */ }
        }
        const result = {
          ok: false, code, message: (err && err.message) || '保存失败',
          workspace_id: wsAtCall, plan_item_id: targetId, request_id: requestId, issued_at_ms: issuedAtMs,
        }
        for (const k of ['sessionIds', 'matchingIds', 'risk', 'history', 'current', 'confirmed', 'field', 'expected', 'planItemIds']) {
          if (err && err[k] !== undefined) result[k] = err[k]
        }
        return result
      }
    })
  }

  return {
    params: P,
    issueRequest,
    create: (input) => runOp('create', input),
    edit: (input) => runOp('edit', input),
    move: (input) => runOp('move', input),
    cancel: (input) => runOp('cancel', input),
    confirmProgress: (input) => runOp('confirmProgress', input),
    arrangeAnotherDay: (input) => runOp('arrangeAnotherDay', input),
  }
}