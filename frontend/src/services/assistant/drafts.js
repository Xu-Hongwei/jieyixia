// 助手草案事务服务（5B-1B §5/§6）：创建/读取/编辑/确认/状态/重排/放弃/消息追加/刷新结算。
// 并发口径：调用时冻结 expected 完整记录基线（内容/状态/确认/历史），事务内读最新同步比较
// canonicalJson 完整持久形状——不是 revision 锁，也不是 updated_at 锁；同毫秒更新也能检出。
// 重摘要/规划计算/事实基线哈希全部在事务外；事务内只做 IDB 读写与同步判定。
// 线程+草案同命令时同一事务比较并写入；仅保存草案不写回陈旧线程。消息追加基于事务内最新线程。
// M1：采用写入由 applications.js 承担；本服务负责状态锁（applying/result_unknown 禁编辑/确认/放弃）
// 与刷新结算回执验证（applying 遇已提交回执→applied，否则 result_unknown；绝不把 applying 当未保存）。
import { transformAssistantAtomic, readAssistantSnapshot, snapshot } from '../storage/db'
import {
  canonicalJson, applyContentEdit, applyGenerationResult, addConfirmation, deriveReadiness, canTransition,
  refreshDraftStatus, checkDraftBounds, checkThreadBounds, appendThreadMessage, forkDraft,
  checkFactFreshness,
} from '../../domains/assistant/draft'
import { deadlineSource, buildAdoptionPlan, verifyReceiptForEnvelope, appliedSummaryFromReceipt } from '../../domains/assistant/application'
import { captureReplacementBaseline } from '../../domains/assistant/replan'
import { resolveAssistantRefs } from '../../domains/assistant/refs'
import { validateAgainstDef } from '../backup/contractSchema'
import { validatePlanningResult } from '../../domains/planning/validate'
import { normalizePlanningContext } from '../../domains/planning/normalize'
import { scheduleDaily } from '../../domains/planning/schedule'
import { windowDates } from '../../domains/planning/protocol'
import { beijingDateStr, beijingAddDays } from '../../domains/time'
import { buildLiveRegistry, buildPlanningSnapshot, captureFactBaseline, checkSourceContentFreshness, sourceBindingDigest } from './context'

const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {})
const EMPTY_PROPOSAL = {
  task_proposals: [], action_proposals: [], work_items: [],
  requirement_candidates: [], evidence_refs: [], assumptions: [], warnings: [],
}
// 本服务允许写入的目标状态（applying/applied/result_unknown 由采用服务/刷新结算/备份恢复路径产生）。
const SETTABLE_STATUSES = ['editing', 'generating', 'needs_clarification', 'ready', 'needs_review', 'discarded']
// 采用在途/结果待核实/已采用：禁止追加确认与放弃（编辑/重排已由 EDITABLE_STATUSES 阻断）。
const CONFIRM_LOCKED = ['applying', 'applied', 'result_unknown']

export function createAssistantDraftService(deps = {}) {
  const {
    getWorkspaceId,
    wallNow = () => new Date().toISOString(),
    newId = () => crypto.randomUUID(),
    queues = new Map(),
  } = deps
  if (typeof getWorkspaceId !== 'function') throw new Error('createAssistantDraftService 需要 getWorkspaceId')

  // 与采用服务共享同一 per-ws 队列（deps.queues 传入同一 Map）：草案写入与采用提交串行。
  const enqueue = (key, job) => {
    const tail = (queues.get(key) || Promise.resolve()).catch(() => {})
    const run = tail.then(job)
    const settled = run.catch(() => {})
    queues.set(key, settled)
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key) })
    return run
  }

  // 写入边界统一契约校验（R4）：任何即将落库的线程/草案先对照正式 schema（与备份 layer B 同一校验器）。
  // 未知字段/非法嵌套/枚举/引用形状明确拒绝，不静默裁剪；在事务内抛错 → 整体 abort，线程与草案都不写。
  // 由此保证「任意合法服务保存结果都能完整导出备份」。合法的不完整草案（null 载荷）照常通过。
  const assertPutsShape = (plan) => {
    for (const d of plan.draftPuts ?? []) {
      const r = validateAgainstDef('AssistantDraft', d)
      if (!r.ok) throw fail('SHAPE_INVALID', `草案不符合正式契约：${r.errors[0].path} ${r.errors[0].message}`, { errors: r.errors })
    }
    for (const t of plan.threadPuts ?? []) {
      const r = validateAgainstDef('AssistantThread', t)
      if (!r.ok) throw fail('SHAPE_INVALID', `线程不符合正式契约：${r.errors[0].path} ${r.errors[0].message}`, { errors: r.errors })
    }
    return plan
  }

  const runWrite = (wsAtCall, job) =>
    enqueue(`assistant:${wsAtCall}`, async () => {
      try {
        const applied = await transformAssistantAtomic((latest, ctx) => assertPutsShape(job(latest, ctx)))
        return { ...(applied.info || {}), workspace_id: applied.workspace_id }
      } catch (err) {
        // DOMException.code 是浏览器数字编号（如额度不足为 22），不是领域错误码。
        // 写入异常统一保留为可重试保存失败，避免生成结果被当作冲突而丢弃。
        const code = typeof err?.code === 'string' && err.code ? err.code : 'SAVE_FAILED'
        const out = { ok: false, code, message: (err && err.message) || '保存失败', workspace_id: wsAtCall }
        for (const k of ['current', 'blockers', 'errors', 'clarifications']) if (err && err[k] !== undefined) out[k] = err[k]
        return out
      }
    })

  // 完整基线守卫：最新记录必须与冻结 expected 逐字段一致；若已是冻结目标本身 → 幂等返回已保存。
  const baselineGuard = (records, id, expectedDigest, targetDigest) => {
    const rec = records.find((r) => r.id === id)
    if (!rec) throw fail('NOT_FOUND', `记录 ${id} 不存在或不属于当前空间`)
    const latestDigest = canonicalJson(rec)
    if (latestDigest === expectedDigest) return { rec, alreadySaved: false }
    if (targetDigest != null && latestDigest === targetDigest) return { rec, alreadySaved: true }
    throw fail('CONFLICT', '记录已被其它页面修改，本次保存未写入；请基于最新内容重新核对', { current: rec })
  }

  const liveOf = (latest) => buildLiveRegistry(latest)
  const threadOf = (latest, draft) => latest.threads.find((t) => t.id === draft.thread_id) ?? null

  // ---- 创建：线程+草案同一事务；本地赋 ID/时间，不信模型提供的持久化身份。 ----
  async function create(input = {}) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const isNewThread = input.threadId == null
    const threadId = isNewThread ? newId() : input.threadId
    const draftId = newId()
    const thread = isNewThread ? {
      id: threadId, record_version: 1, workspace_id: wsAtCall, title: input.title ?? '',
      messages: [], selected_refs: input.selectedRefs ?? [], confirmed_requirements: [],
      created_at: now, updated_at: now,
    } : null
    const draft = {
      id: draftId, record_version: 1, workspace_id: wsAtCall, thread_id: threadId,
      revision: 1, revision_history: [], status: 'editing',
      mode: input.mode ?? 'create',
      replan_scope: input.replanScope ?? null,
      progress_input: input.progressInput ?? null,
      replacement_baseline: input.replacementBaseline ?? null,
      proposal: input.proposal ?? null, planning_input: input.planningInput ?? null,
      planning_result: input.planningResult ?? null, fact_baseline: input.factBaseline ?? null,
      assumptions: [], user_confirmations: [], excluded_items: [], source_refs: input.sourceRefs ?? [],
      applied_summary: null, created_at: now, updated_at: now,
    }
    const frozen = snapshot({ thread, draft })
    // M3 模式守卫（契约 AssistantDraft 校验器同口径）：create 不得夹带改排字段/替换集；
    // replan 必须有范围+进展清单，带计算结果还必须有替换基线。
    if (frozen.draft.mode === 'replan') {
      if (!frozen.draft.replan_scope || !frozen.draft.progress_input) {
        return { ok: false, code: 'REPLAN_INPUT_MISSING', message: '改排草案必须携带范围与进展清单', workspace_id: wsAtCall }
      }
      if (frozen.draft.planning_result != null && !frozen.draft.replacement_baseline) {
        return { ok: false, code: 'REPLACEMENT_BASELINE_MISSING', message: '改排草案带计算结果必须携带替换基线', workspace_id: wsAtCall }
      }
    } else {
      if (frozen.draft.replan_scope || frozen.draft.progress_input || frozen.draft.replacement_baseline) {
        return { ok: false, code: 'REPLAN_FIELDS_ON_CREATE', message: '新建草案不得携带改排字段；请走任务详情的「调整后续安排」', workspace_id: wsAtCall }
      }
      if ((frozen.draft.planning_input?.replacement_ids ?? []).length > 0) {
        return { ok: false, code: 'REPLAN_FIELDS_ON_CREATE', message: '新建草案的排程输入不得携带替换集', workspace_id: wsAtCall }
      }
    }
    const bounds = checkDraftBounds(frozen.draft)
    if (bounds.length) return { ok: false, code: bounds[0].code, errors: bounds, workspace_id: wsAtCall }
    if (frozen.thread) {
      const tb = checkThreadBounds(frozen.thread)
      if (tb.length) return { ok: false, code: tb[0].code, errors: tb, workspace_id: wsAtCall }
    }
    if (frozen.draft.planning_result != null) {
      if (frozen.draft.planning_input == null) return { ok: false, code: 'COMPUTATION_MISMATCH', message: '有 planning_result 必须有同版 planning_input', workspace_id: wsAtCall }
      try { validatePlanningResult(frozen.draft.planning_input, frozen.draft.planning_result) } catch (e) {
        return { ok: false, code: 'COMPUTATION_MISMATCH', message: e.message, workspace_id: wsAtCall }
      }
    }
    return runWrite(wsAtCall, (latest) => {
      if (latest.drafts.some((d) => d.id === draftId)) throw fail('ID_CONFLICT', `草案标识 ${draftId} 已存在`)
      if (isNewThread) {
        if (latest.threads.some((t) => t.id === threadId)) throw fail('ID_CONFLICT', `线程标识 ${threadId} 已存在`)
      } else if (!latest.threads.some((t) => t.id === threadId)) {
        throw fail('NOT_FOUND', `线程 ${threadId} 不存在或不属于当前空间`)
      }
      return {
        threadPuts: frozen.thread ? [frozen.thread] : [],
        draftPuts: [frozen.draft],
        info: { ok: true, draft: frozen.draft, thread: frozen.thread },
      }
    })
  }

  // 同一草案及本地事实能否构造实际采用写集。预检不签发信封，也不持久化 ID。
  function adoptionReadiness(draft, thread, base, docs) {
    if (!base.ready) return base
    try {
      let serial = 0
      const plan = buildAdoptionPlan(draft, {
        workspaceId: draft.workspace_id, now: draft.updated_at, newId: () => 'preview-' + (++serial), projectId: 'preview-project',
        existingProjectNames: docs.filter(d => d.kind === 'matter').map(d => d.title),
        notes: docs.filter(item => item.kind === 'note'),
        userMessages: (thread?.messages ?? []).filter(item => item.role === 'user'),
      })
      return { ...base, counts: plan.counts, projectTitle: plan.writeSet.project_title }
    } catch (error) {
      return { ready: false, blockers: [{ code: error.code || 'PREVIEW_INVALID', message: error.message }] }
    }
  }

  // ---- 读取：一致快照 + 引用解析状态 + 事实新鲜度 + ready 推导 + 完整读取基线。 ----
  async function get(draftId) {
    const snap = await readAssistantSnapshot()
    const draft = snap.drafts.find((d) => d.id === draftId)
    if (!draft) return { ok: false, code: 'NOT_FOUND', workspace_id: snap.workspace_id }
    const thread = snap.threads.find((t) => t.id === draft.thread_id) ?? null
    const live = buildLiveRegistry(snap)
    const today = beijingDateStr(new Date(wallNow()))
    const freshness = checkFactFreshness(draft, { docs: snap.docs, sources: snap.sources, today })
    // 证据内容核对（R7）：重摘要在事务外完成，覆盖原文变化（不只 ID 存在）。
    const sourceDiffs = await checkSourceContentFreshness(draft.fact_baseline, snap.sources)
    const fullFreshness = { fresh: freshness.fresh && sourceDiffs.length === 0, diffs: [...freshness.diffs, ...sourceDiffs] }
    const readiness = deriveReadiness(draft, { thread, live, freshness: fullFreshness })
    return {
      ok: true, workspace_id: snap.workspace_id, draft, thread,
      refs: resolveAssistantRefs({ draft, thread, live }),
      readiness, adoptionReadiness: adoptionReadiness(draft, thread, readiness, snap.docs),
      factFreshness: fullFreshness,
      refresh: refreshDraftStatus(draft.status),
      baseline: { draft: snapshot(draft), thread: thread ? snapshot(thread) : null },
    }
  }

  async function list() {
    const snap = await readAssistantSnapshot()
    return { ok: true, workspace_id: snap.workspace_id, threads: snap.threads, drafts: snap.drafts }
  }

  // ---- 内容编辑：实质修改→新 revision+旧版快照；同内容不 bump；越界原记录不变。 ----
  async function edit(draftId, { expected, edits }) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const expectedF = snapshot(expected)
    const editsF = snapshot(edits)
    const pre = applyContentEdit(expectedF, editsF, now)
    if (!pre.ok) return { ok: false, code: pre.errors[0].code, errors: pre.errors, workspace_id: wsAtCall }
    const expectedDigest = canonicalJson(expectedF)
    const targetDigest = pre.bumped ? canonicalJson(pre.draft) : expectedDigest
    return runWrite(wsAtCall, (latest) => {
      const { rec, alreadySaved } = baselineGuard(latest.drafts, draftId, expectedDigest, targetDigest)
      if (alreadySaved) return { info: { ok: true, alreadySaved: true, draft: rec, bumped: false } }
      const r = applyContentEdit(rec, editsF, now)
      if (!r.ok) throw fail(r.errors[0].code, r.errors[0].message, { errors: r.errors })
      if (!r.bumped) return { info: { ok: true, draft: rec, bumped: false } }
      return { draftPuts: [r.draft], info: { ok: true, draft: r.draft, bumped: true } }
    })
  }

  // ---- 同版本确认追加：不 bump，但同样过完整并发基线。 ----
  async function confirm(draftId, { expected, confirmation }) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const expectedF = snapshot(expected)
    const confF = snapshot(confirmation)
    const expectedDigest = canonicalJson(expectedF)
    return runWrite(wsAtCall, (latest) => {
      const { rec, alreadySaved } = baselineGuard(latest.drafts, draftId, expectedDigest, null)
      if (alreadySaved) return { info: { ok: true, alreadySaved: true, draft: rec } }
      if (CONFIRM_LOCKED.includes(rec.status)) {
        throw fail('STATUS_LOCKED', `状态 ${rec.status} 不接受新确认；采用在途/已采用/待核实的草案须先完成或核实`)
      }
      if ((rec.user_confirmations ?? []).some((u) => u.confirmation_id === confF.confirmation_id)) {
        const prior = rec.user_confirmations.find((u) => u.confirmation_id === confF.confirmation_id)
        if (canonicalJson(prior) === canonicalJson(confF)) return { info: { ok: true, alreadySaved: true, draft: rec } }
        throw fail('CONFIRMATION_DUP', 'confirmation_id 已存在且内容不同')
      }
      const live = liveOf(latest)
      const thread = threadOf(latest, rec)
      const r = addConfirmation(rec, confF, now, { live, thread })
      if (!r.ok) throw fail(r.errors[0].code, r.errors[0].message, { errors: r.errors })
      return { draftPuts: [r.draft], info: { ok: true, draft: r.draft } }
    })
  }

  // ---- 状态变更：冻结边集校验；ready 必须由服务独立推导，不接受页面传值。 ----
  async function setStatus(draftId, { expected, status }) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const expectedF = snapshot(expected)
    if (!SETTABLE_STATUSES.includes(status)) {
      return { ok: false, code: 'STATUS_NOT_SETTABLE', message: `本批服务不写入状态 ${status}（采用相关状态只由刷新/恢复路径产生）`, workspace_id: wsAtCall }
    }
    if (!canTransition(expectedF.status, status)) {
      return { ok: false, code: 'INVALID_TRANSITION', message: `不允许 ${expectedF.status} → ${status}`, workspace_id: wsAtCall }
    }
    const expectedDigest = canonicalJson(expectedF)
    const targetDigest = canonicalJson({ ...expectedF, status, updated_at: now })
    // 证据内容核对（R7）：重摘要在事务外完成；事务内用同步记录绑定防止「核对后—提交前」资料被改。
    let sourcePre = null
    if (status === 'ready') {
      const snap0 = await readAssistantSnapshot()
      const rec0 = snap0.drafts.find((d) => d.id === draftId)
      if (rec0) {
        const ids = new Set((rec0.fact_baseline?.source_fingerprints ?? []).map((f) => f.source_id))
        sourcePre = { ids, diffs: await checkSourceContentFreshness(rec0.fact_baseline, snap0.sources), binding: sourceBindingDigest(snap0.sources, ids) }
      }
    }
    return runWrite(wsAtCall, (latest) => {
      const { rec, alreadySaved } = baselineGuard(latest.drafts, draftId, expectedDigest, targetDigest)
      if (alreadySaved) return { info: { ok: true, alreadySaved: true, draft: rec } }
      if (!canTransition(rec.status, status)) throw fail('INVALID_TRANSITION', `不允许 ${rec.status} → ${status}`)
      if (status === 'ready') {
        // 事务内基于最新事实再核对（R1）：避免 get 检查后、提交前事实被另一标签修改（TOCTOU）。
        const thread = threadOf(latest, rec)
        const today = beijingDateStr(new Date(wallNow()))
        const freshness = checkFactFreshness(rec, { docs: latest.docs, sources: latest.sources, today })
        let fullFreshness = freshness
        if (sourcePre) {
          // 绑定核对：资料记录须与事务外重摘要时一致；变了 → 冲突，要求重新核对（不在活事务内等待哈希）。
          if (sourceBindingDigest(latest.sources, sourcePre.ids) !== sourcePre.binding) {
            throw fail('CONFLICT_FACTS', '证据资料在核对后发生变化，旧草案证据不再适用；请重新核对', { diffs: sourcePre.diffs })
          }
          fullFreshness = { fresh: freshness.fresh && sourcePre.diffs.length === 0, diffs: [...freshness.diffs, ...sourcePre.diffs] }
        }
        const readiness = deriveReadiness(rec, { thread, live: liveOf(latest), freshness: fullFreshness })
        if (!readiness.ready) throw fail('READY_BLOCKED', 'ready 推导未通过，不能标记为就绪', { blockers: readiness.blockers })
      }
      const next = { ...rec, status, updated_at: now }
      return { draftPuts: [next], info: { ok: true, draft: next } }
    })
  }

  // 放弃：采用在途/结果待核实禁止放弃（冻结边 result_unknown→discarded 存在，服务策略更严：
  // 必须先 resolve 核实结果，避免把可能已提交的采用当成未保存丢弃）。
  async function discard(draftId, { expected }) {
    const status = snapshot(expected).status
    if (status === 'applying' || status === 'result_unknown') {
      return { ok: false, code: 'STATUS_LOCKED', message: `状态 ${status} 不能放弃；请先核实采用结果`, workspace_id: getWorkspaceId() }
    }
    return setStatus(draftId, { expected, status: 'discarded' })
  }

  // ---- 重新排程：真实 normalize/schedule/validate；计算在事务外，事务内复核事实未变。 ----
  async function reschedule(draftId, { expected, context, options = {} }) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const expectedF = snapshot(expected)
    const contextF = snapshot(context)
    const optionsF = snapshot(options)
    const expectedDigest = canonicalJson(expectedF)

    // 阶段 1（事务外）：一致快照上计算 + 冻结事实基线（含异步哈希）。
    const snap = await readAssistantSnapshot()
    const rec0 = snap.drafts.find((d) => d.id === draftId)
    if (!rec0) return { ok: false, code: 'NOT_FOUND', workspace_id: wsAtCall }
    if (canonicalJson(rec0) !== expectedDigest) {
      return { ok: false, code: 'CONFLICT', message: '记录已被其它页面修改，请基于最新内容重新核对', current: rec0, workspace_id: wsAtCall }
    }
    if (!rec0.proposal) return { ok: false, code: 'NO_PROPOSAL', message: '缺少建议内容，无法排程', workspace_id: wsAtCall }
    const thread0 = snap.threads.find((t) => t.id === rec0.thread_id) ?? null
    const requirements = thread0 ? thread0.confirmed_requirements ?? [] : []
    const planningSnapshot = buildPlanningSnapshot({
      workspaceId: snap.workspace_id, docs: snap.docs, sources: snap.sources,
      turnId: optionsF.turnId ?? null, startDate: contextF.start_date,
    })
    const currentConfs = (rec0.user_confirmations ?? []).filter((u) => u.draft_revision === rec0.revision)
    const replanScope = rec0.mode === 'replan' ? rec0.replan_scope : null
    const normOptions = {
      ...optionsF,
      draftRevision: rec0.revision,
      excludedItems: rec0.excluded_items ?? [],
      extraWorkAcknowledged: [
        ...(optionsF.extraWorkAcknowledged ?? []),
        ...currentConfs.filter((u) => u.object_type === 'extra_work').map((u) => u.object_id_or_key),
      ],
      taskDeadlineConfirmations: currentConfs.filter((u) => u.object_type === 'task' && u.field_path === 'deadline'),
      replan: replanScope ? {
        scope: replanScope,
        scopeAcknowledged: currentConfs.some((u) => u.object_type === 'replan_scope' && u.object_id_or_key === replanScope.task_id),
      } : null,
    }
    let norm
    try {
      norm = normalizePlanningContext(planningSnapshot, rec0.proposal, requirements, contextF, normOptions)
    } catch (e) {
      return { ok: false, code: 'NORMALIZE_FAILED', message: e.message, workspace_id: wsAtCall }
    }
    if (!norm.ok) return { ok: false, code: 'NEEDS_CLARIFICATION', clarifications: norm.clarifications, workspace_id: wsAtCall }
    let result
    try {
      result = scheduleDaily(norm.input, { excludedItems: norm.excludedItems })
      validatePlanningResult(norm.input, result)
    } catch (e) {
      return { ok: false, code: 'COMPUTATION_MISMATCH', message: e.message, workspace_id: wsAtCall }
    }
    // M3：每次重排都按当前快照重新冻结替换基线（资格+内容快照+会话全集）；不合格整体拒绝。
    let replacementBaseline = null
    if (replanScope) {
      try {
        replacementBaseline = captureReplacementBaseline({
          scope: replanScope, now,
          workspaceId: snap.workspace_id,
          task: snap.docs.find((d) => d.kind === 'task' && d.id === replanScope.task_id),
          today: beijingDateStr(new Date(now)),
          window: new Set(windowDates(replanScope.start_date)),
          planItems: snap.docs.filter((d) => d.kind === 'plan_item'),
          focusSessions: snap.docs.filter((d) => d.kind === 'focus_session'),
        })
      } catch (e) {
        return { ok: false, code: e.code || 'REPLACEMENT_BASELINE_FAILED', message: e.message, workspace_id: wsAtCall }
      }
    }
    let baseline
    try {
      baseline = await captureFactBaseline({
        input: norm.input, proposal: rec0.proposal, sources: snap.sources, docs: snap.docs, now,
        fullOccupancy: norm.occupancyFull,
      })
    } catch (e) {
      return { ok: false, code: e.code || 'FACT_BASELINE_FAILED', message: e.message, workspace_id: wsAtCall }
    }
    const factsDigest = canonicalJson({ planningSnapshot, requirements })
    const edits = {
      planning_input: norm.input, planning_result: result, fact_baseline: baseline,
      ...(replanScope ? { replacement_baseline: replacementBaseline } : {}),
    }
    // 仅计算本身产生的新版本可继承本次 normalize 已核对的 create 截止。
    // 草案内容与业务事实由下方事务再次比较；其它种类的确认继续按版本失效。
    const previousFactsStillCurrent = !rec0.fact_baseline || (
      checkFactFreshness(rec0, { docs: snap.docs, sources: snap.sources, today: contextF.today }).fresh &&
      !(await checkSourceContentFreshness(rec0.fact_baseline, snap.sources)).length)
    const inherited = currentConfs.filter(c => {
      if (!previousFactsStillCurrent || c.object_type !== 'task' || c.field_path !== 'deadline' || c.id_scope !== 'draft') return false
      const task = rec0.proposal.task_proposals.find(t => t.op === 'create' && t.key === c.object_id_or_key)
      const fact = norm.input.task_facts.find(f => f.task_ref.kind === 'draft' && f.task_ref.key === c.object_id_or_key)
      if (!task || !fact || (c.new_value?.value ?? null) !== (fact.deadline_value ?? null) ||
          (c.new_value?.precision ?? 'none') !== (fact.deadline_precision ?? 'none')) return false
      if (!fact.deadline_value) return true
      try {
        deadlineSource(task, fact.deadline_value, fact.deadline_precision, snap.docs.filter(d => d.kind === 'note'),
          (thread0?.messages ?? []).filter(m => m.role === 'user'))
        return true
      } catch { return false }
    })
    const inheritedIds = new Map(inherited.map(c => [c.confirmation_id, newId()]))
    function applySchedule(base) {
      const change = applyContentEdit(base, edits, now)
      if (!change.ok || !change.bumped || !inherited.length) return change
      change.draft.user_confirmations = [...change.draft.user_confirmations, ...inherited.map(c => ({
        ...c, confirmation_id: inheritedIds.get(c.confirmation_id), draft_revision: change.draft.revision,
      }))]
      const errors = checkDraftBounds(change.draft)
      return errors.length ? { ok: false, errors } : change
    }
    const pre = applySchedule(expectedF)
    if (!pre.ok) return { ok: false, code: pre.errors[0].code, errors: pre.errors, workspace_id: wsAtCall }
    const targetDigest = pre.bumped ? canonicalJson(pre.draft) : expectedDigest

    // 阶段 2（事务内）：草案基线 + 业务事实/要求未变才写入；变了 → 冲突，旧结果不覆盖新事实。
    return runWrite(wsAtCall, (latest) => {
      const { rec, alreadySaved } = baselineGuard(latest.drafts, draftId, expectedDigest, targetDigest)
      if (alreadySaved) return { info: { ok: true, alreadySaved: true, draft: rec, bumped: false } }
      const thread = threadOf(latest, rec)
      const latestSnapshot = buildPlanningSnapshot({
        workspaceId: wsAtCall, docs: latest.docs, sources: latest.sources,
        turnId: optionsF.turnId ?? null, startDate: contextF.start_date,
      })
      const latestFacts = canonicalJson({ planningSnapshot: latestSnapshot, requirements: thread ? thread.confirmed_requirements ?? [] : [] })
      if (latestFacts !== factsDigest) throw fail('CONFLICT_FACTS', '计算后空间事实或已确认要求已变化，旧结果不再适用；请重新排程')
      const r = applySchedule(rec)
      if (!r.ok) throw fail(r.errors[0].code, r.errors[0].message, { errors: r.errors })
      if (!r.bumped) return { info: { ok: true, draft: rec, bumped: false } }
      return { draftPuts: [r.draft], info: { ok: true, draft: r.draft, bumped: true } }
    })
  }

  // ---- 显式新建草案：复制可读内容，重建身份并清除原采用授权/确认/事实基线。 ----
  async function fork(draftId, { expected }) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const expectedF = snapshot(expected)
    const expectedDigest = canonicalJson(expectedF)
    const newDraftId = newId()
    const forked = forkDraft(expectedF, { id: newDraftId, now })
    const bounds = checkDraftBounds(forked)
    if (bounds.length) return { ok: false, code: bounds[0].code, errors: bounds, workspace_id: wsAtCall }
    return runWrite(wsAtCall, (latest) => {
      const { rec } = baselineGuard(latest.drafts, draftId, expectedDigest, null)
      if (latest.drafts.some((d) => d.id === newDraftId)) throw fail('ID_CONFLICT', `草案标识 ${newDraftId} 已存在`)
      const next = forkDraft(rec, { id: newDraftId, now })
      return { draftPuts: [next], info: { ok: true, draft: next, forkedFrom: rec.id } }
    })
  }

  // ---- 消息追加：基于事务内最新线程，不丢其它草案刚追加的消息；同 id 同内容幂等。 ----
  async function appendMessage(threadId, { message, messageId }) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const msgF = snapshot({
      id: messageId ?? newId(), role: message.role, content: message.content,
      type: message.type ?? 'text', refs: message.refs ?? [], created_at: now,
      ...(message.user_input != null ? { user_input: message.user_input } : {}),
    })
    const msgDigest = canonicalJson(msgF)
    return runWrite(wsAtCall, (latest) => {
      const thread = latest.threads.find((t) => t.id === threadId)
      if (!thread) throw fail('NOT_FOUND', `线程 ${threadId} 不存在或不属于当前空间`)
      const prior = (thread.messages ?? []).find((m) => m.id === msgF.id)
      if (prior) {
        if (canonicalJson(prior) === msgDigest) return { info: { ok: true, alreadySaved: true, thread } }
        throw fail('MESSAGE_DUP', '消息 id 已存在且内容不同')
      }
      const r = appendThreadMessage(thread, msgF)
      if (!r.ok) throw fail(r.errors[0].code, r.errors[0].message, { errors: r.errors })
      const next = { ...r.thread, updated_at: now }
      return { threadPuts: [next], info: { ok: true, thread: next, message: msgF } }
    })
  }

  // ---- 生成结果接收（M2）：只接受 generating 态草案；线程归档消息 + 草案同一事务。 ----
  // 关联字段（request/turn/seq）由请求层对照冻结上下文核对；这里再核空间/线程归属与完整草案基线。
  // proposal → 新 revision + needs_review（旧计算/基线作废）；clarification → needs_clarification + 问题落线程。
  async function receiveResult(draftId, { expected, response }) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const expectedF = snapshot(expected)
    const respF = snapshot(response)
    if (respF.workspace_id !== wsAtCall) {
      return { ok: false, code: 'WORKSPACE_MISMATCH', message: '结果不属于当前空间，拒收', workspace_id: wsAtCall }
    }
    if (respF.thread_id !== expectedF.thread_id) {
      return { ok: false, code: 'CORRELATION_MISMATCH', message: '结果线程与草案线程不一致，拒收', workspace_id: wsAtCall }
    }
    const payload = respF.payload
    const defName = payload?.kind === 'clarification' ? 'ClarificationPayload' : payload?.kind === 'proposal' ? 'ProposalPayload' : null
    if (!defName) {
      return { ok: false, code: 'UNSUPPORTED_PAYLOAD', message: `本版本不接收 ${payload?.kind} 结果`, workspace_id: wsAtCall }
    }
    const shape = validateAgainstDef(defName, payload)
    if (!shape.ok) {
      return { ok: false, code: 'PAYLOAD_INVALID', message: `结果不符合正式契约：${shape.errors[0].path} ${shape.errors[0].message}`, errors: shape.errors, workspace_id: wsAtCall }
    }
    const pre = applyGenerationResult(expectedF, payload, now)
    if (!pre.ok) return { ok: false, code: pre.errors[0].code, errors: pre.errors, workspace_id: wsAtCall }
    // 归档消息 id 由 request_id 确定性派生：同轮重试幂等。澄清问题存机器固定 JSON（type 消歧）。
    const msgId = `${payload.kind === 'clarification' ? 'clr' : 'prop'}-${respF.request_id}`
    if (msgId.length > 64) {
      return { ok: false, code: 'ID_TOO_LONG', message: 'request_id 过长，无法派生归档消息 id', workspace_id: wsAtCall }
    }
    const p = payload.proposal
    const msg = snapshot({
      id: msgId, role: 'assistant',
      content: payload.kind === 'clarification'
        ? canonicalJson({ questions: payload.questions })
        : `模型建议：${p.task_proposals.length} 个任务 / ${p.action_proposals.length} 个行动 / ${p.work_items.length} 个工作项（待核对，见草案）`,
      type: payload.kind === 'clarification' ? 'clarification' : 'proposal_card',
      refs: [{ object_type: 'draft', id: draftId }], created_at: now,
    })
    const expectedDigest = canonicalJson(expectedF)
    const targetDigest = canonicalJson(pre.draft)
    return runWrite(wsAtCall, (latest) => {
      const { rec, alreadySaved } = baselineGuard(latest.drafts, draftId, expectedDigest, targetDigest)
      if (alreadySaved) return { info: { ok: true, alreadySaved: true, draft: rec, bumped: false } }
      const thread = threadOf(latest, rec)
      if (!thread) throw fail('NOT_FOUND', `线程 ${rec.thread_id} 不存在或不属于当前空间`)
      const r = applyGenerationResult(rec, payload, now)
      if (!r.ok) throw fail(r.errors[0].code, r.errors[0].message, { errors: r.errors })
      const prior = (thread.messages ?? []).find((m) => m.id === msg.id)
      let nextThread = null
      if (prior) {
        if (canonicalJson(prior) !== canonicalJson(msg)) throw fail('MESSAGE_DUP', '归档消息 id 已存在且内容不同')
      } else {
        const a = appendThreadMessage(thread, msg)
        if (!a.ok) throw fail(a.errors[0].code, a.errors[0].message, { errors: a.errors })
        nextThread = { ...a.thread, updated_at: now }
      }
      return {
        draftPuts: [r.draft], threadPuts: nextThread ? [nextThread] : [],
        info: { ok: true, draft: r.draft, thread: nextThread ?? thread, message: msg, bumped: r.bumped },
      }
    })
  }

  // ---- 线程已确认要求：结构/值校验复用 normalize 单一来源；同 id 同版本幂等。 ----
  async function confirmRequirement(threadId, { expected, requirement }) {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    const expectedF = snapshot(expected)
    const reqF = snapshot(requirement)
    const expectedDigest = canonicalJson(expectedF)
    const today = beijingDateStr(new Date(now))
    const probeContext = {
      timezone: 'Asia/Shanghai', today, start_date: today, horizon_days: 7,
      days: Array.from({ length: 7 }, (_, i) => ({ date: beijingAddDays(today, i), budget_minutes: 60 })),
    }
    try {
      normalizePlanningContext({ workspace_id: wsAtCall, tasks: [], actions: [], plan_items: [], source_ids: [], note_ids: [] }, EMPTY_PROPOSAL, [reqF], probeContext)
    } catch (e) {
      return { ok: false, code: 'REQUIREMENT_INVALID', message: e.message, workspace_id: wsAtCall }
    }
    return runWrite(wsAtCall, (latest) => {
      const { rec, alreadySaved } = baselineGuard(latest.threads, threadId, expectedDigest, null)
      if (alreadySaved) return { info: { ok: true, alreadySaved: true, thread: rec } }
      const prior = (rec.confirmed_requirements ?? []).find((r) => r.requirement_id === reqF.requirement_id)
      if (prior) {
        if (canonicalJson(prior) === canonicalJson(reqF)) return { info: { ok: true, alreadySaved: true, thread: rec } }
        throw fail('REQUIREMENT_DUP', 'requirement_id 已存在且内容不同；改值请显式新版本')
      }
      if ((rec.confirmed_requirements ?? []).length >= 50) throw fail('REQUIREMENT_LIMIT', '已确认要求最多 50 条')
      const next = { ...rec, confirmed_requirements: [...(rec.confirmed_requirements ?? []), reqF], updated_at: now }
      const tb = checkThreadBounds(next)
      if (tb.length) throw fail(tb[0].code, tb[0].message, { errors: tb })
      // 要求失效绑定（R5，等价失效机制）：已确认要求有效变化后，本线程内一切「已计算」草案的旧事实基线立即失效。
      // 清 fact_baseline（保留 proposal/planning_input/planning_result 供查看，不静默重排、不增 revision），
      // 使 get 与事务内 ready 均因 FACT_BASELINE_MISSING 阻断，必须重新排程（按当前要求重捕获）后才能 ready。
      // applying/result_unknown 除外：采用在途草案的冻结基线不得被抽走（提交事务按原意图复核）。
      // 幂等重试（alreadySaved）与同 id 不同内容（REQUIREMENT_DUP）已在上面返回/抛错，不触发失效。
      const invalidated = []
      for (const d of latest.drafts) {
        if (d.thread_id !== threadId) continue
        if (['discarded', 'applied', 'applying', 'result_unknown'].includes(d.status)) continue
        if (d.planning_input == null || d.fact_baseline == null) continue
        invalidated.push({ ...d, fact_baseline: null, updated_at: now })
      }
      return { threadPuts: [next], draftPuts: invalidated, info: { ok: true, thread: next, invalidatedDrafts: invalidated.map((d) => d.id) } }
    })
  }

  // ---- 刷新结算（本库中断规则 + M1 回执验证）：generating→needs_review； ----
  // applying：存在对应原意图的已提交回执 → applied（补 applied_summary），否则 result_unknown；
  // result_unknown：遇已提交回执 → applied，否则保持。绝不把 applying 当未保存，绝不让 applied 回可编辑。
  async function settleRefresh() {
    const wsAtCall = getWorkspaceId()
    const now = wallNow()
    return runWrite(wsAtCall, (latest) => {
      const committedFor = (d) => latest.ops.find((o) => o.state === 'committed' && o.envelope
        && o.envelope.draft_id === d.id && o.envelope.draft_revision === d.revision
        && verifyReceiptForEnvelope(o.receipt, o.envelope))
      const changed = []
      for (const d of latest.drafts) {
        if (d.status === 'applying' || d.status === 'result_unknown') {
          const op = committedFor(d)
          if (op) {
            changed.push({ ...d, status: 'applied', applied_summary: appliedSummaryFromReceipt(op.receipt), updated_at: now })
          } else if (d.status === 'applying') {
            changed.push({ ...d, status: 'result_unknown', updated_at: now })
          }
          continue
        }
        const r = refreshDraftStatus(d.status)
        if (r.status !== d.status) changed.push({ ...d, status: r.status, updated_at: now })
      }
      return { draftPuts: changed, info: { ok: true, changed } }
    })
  }

  return { create, get, list, edit, confirm, setStatus, discard, reschedule, fork, appendMessage, receiveResult, confirmRequirement, settleRefresh }
}
