// 未结束会话恢复准备（纯规则，零写入，不自动计时）。开工单 §7。
// 已结束 v1/v0：保留历史事实，只在 remap 阶段映射引用，不重写快照（本模块不动它们）。
// 未结束 v1：暂停（running=false/锚点=null/outcome=null/ended_at=null），保留已存 accumulated_ms/draft_md/首次 started_at；
//   不导入原 focus_runtime；重建最小协调记录：新 sessionId/目标 ws、独立恢复占位持有者（绝不冒充页面）、
//   过期租约、初始 epoch/revision/draft_seq、无运行占位（run.session_id=null）、初始 recovery=null。
//   打开恢复空间时由既有 takeover→recover 确认流程受控重取，离线间隔不计入。
// 未结束 v0：只 running=false，保留旧字段/文本/累计，不补 v1 锚点/快照/引用状态；仍走显式 legacyEnd 归档。
// 多次恢复各自暂停，不占全局运行位；原空间/其它标签的运行会话与锁不受影响。
import { makeSessionRuntime, makeRunRecord, makeOpsRecord, validateRuntimeRecord } from '@/services/focus/runtime'
import { FOCUS_PARAMS } from '@/domains/focus'
import { focusRecordVersion } from './adapt'
import { restoreDraftStatus } from '@/domains/assistant/draft'

// 恢复占位持有者：固定前缀 + 新会话 ID，页面持有者（UUID/标签 ID）绝不会等于它。
export const RECOVERY_OWNER_PREFIX = 'restore-placeholder:'
export const recoveryOwner = (sessionId) => `${RECOVERY_OWNER_PREFIX}${sessionId}`

export function prepareUnfinishedV1(session, { nowMs, leaseMs = FOCUS_PARAMS.LEASE_MS }) {
  const paused = { ...session, running: false, timer_anchor_at: null, outcome: null, ended_at: null }
  const rt = makeSessionRuntime({
    sessionId: session.id, workspaceId: session.workspace_id,
    ownerId: recoveryOwner(session.id), nowMs, leaseMs,
  })
  rt.lease_expires_at = nowMs - 1 // 过期：打开时须 takeover（epoch+1）+ recover 确认，不自动续租/计时
  rt.recovery = null
  validateRuntimeRecord(rt)
  return { session: paused, sessionRuntime: rt }
}

export function prepareUnfinishedV0(session) {
  return { ...session, running: false }
}

// 处理整份已 remap 的 docs，产出恢复后会话与最小协调基座。
// 返回 { docs, runtimePuts, unfinishedV1:[id], legacyEnds:[id] }。runtimePuts 含每未结束 v1 的 session 协调记录，
// 以及目标空间一条 run（session_id=null，不占全局运行位）+ 一条 ops 台账。4-2 在恢复事务内与业务数据原子落库。
export function buildRecoveryPlan({ docs, workspaceId, nowMs, leaseMs = FOCUS_PARAMS.LEASE_MS }) {
  const outDocs = []
  const runtimePuts = []
  const unfinishedV1 = []
  const legacyEnds = []
  for (const d of docs) {
    if (d.kind !== 'focus_session' || d.ended_at != null) { outDocs.push(d); continue }
    if (focusRecordVersion(d) === 1) {
      const { session, sessionRuntime } = prepareUnfinishedV1(d, { nowMs, leaseMs })
      outDocs.push(session); runtimePuts.push(sessionRuntime); unfinishedV1.push(session.id)
    } else {
      outDocs.push(prepareUnfinishedV0(d)); legacyEnds.push(d.id)
    }
  }
  const run = makeRunRecord(workspaceId, null, nowMs)
  const ops = makeOpsRecord(workspaceId)
  validateRuntimeRecord(run); validateRuntimeRecord(ops)
  runtimePuts.push(run, ops)
  return { docs: outDocs, runtimePuts, unfinishedV1, legacyEnds }
}

// 助手草案恢复去授权（开工单 §9.3，冻结 RESTORE_MAP 口径）：内容保留，旧保存结果不能由本次恢复推定。
// 全部草案清除当前事实基线与可执行确认（旧确认不得授权新空间动作）；未应用各态→needs_review，
// applied 只读保留 applied_summary，discarded 保持。建议/规划/revision_history 原样保留供阅读；
// 线程 confirmed_requirements 保留可读（恢复草案无确认且 needs_review，不能据此放行）。
// 不添加未登记字段；不导入/重建 assistant_ops；0 个新采用操作、0 个自动生成 PlanItem。
export function restoreAssistantDrafts(drafts) {
  return drafts.map((d) => {
    const { restoredStatus } = restoreDraftStatus(d.status)
    return { ...d, status: restoredStatus, fact_baseline: null, user_confirmations: [] }
  })
}