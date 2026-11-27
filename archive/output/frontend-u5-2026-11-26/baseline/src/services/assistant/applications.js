// M1 采用协调服务（§9.5）：prepare 冻结信封（零写入）→ apply 两阶段提交 → resolve 结果核实。
// 并发口径与草案服务一致：expected 完整记录基线 + 事务内 canonicalJson 比较；重摘要在事务外。
// 同一意图 = 同 draft_id + draft_revision + input_signature；pending 台账复用冻结信封与 ID 映射，
// 绝不重新生成 ID。去重靠数据库事务（台账状态 + 业务 add() 冲突整体拒绝），不只靠按钮禁用。
// 结果五态：committed 成功 / already_committed 已成功 / needs_recheck 需重新核对 /
// not_committed 确定未提交 / result_unknown 结果待核实（崩溃/切换后由 settleRefresh+resolve 收敛）。
import { transformAdoptionAtomic, readAssistantSnapshot, snapshot } from '../storage/db'
import {
  canonicalJson, deriveReadiness, checkFactFreshness, appendThreadMessage,
} from '../../domains/assistant/draft'
import { buildLiveRegistry, checkSourceContentFreshness, sourceBindingDigest } from './context'
import { validateAgainstDef } from '../backup/contractSchema'
import { sha256Hex, utf8Bytes } from '../backup/format'
import { beijingDateStr } from '../../domains/time'
import {
  checkAdoptionSupported, buildIntentContent, buildAdoptionPlan, previewCounts,
  verifyReceiptForEnvelope, appliedSummaryFromReceipt, verifyEnvelopeAgainstDraft,
} from '../../domains/assistant/application'

const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {})

const DOC_DEF = { task: 'Task', action: 'Action', plan_item: 'PlanItem' }

export function createAssistantApplicationService(deps = {}) {
  const {
    getWorkspaceId,
    wallNow = () => new Date().toISOString(),
    newId = () => crypto.randomUUID(),
    queues = new Map(),
  } = deps
  if (typeof getWorkspaceId !== 'function') throw new Error('createAssistantApplicationService 需要 getWorkspaceId')

  // 与草案服务共享同一 per-ws 队列：采用与编辑/确认/重排串行，跨服务不交叠。
  const enqueue = (key, job) => {
    const tail = (queues.get(key) || Promise.resolve()).catch(() => {})
    const run = tail.then(job)
    const settled = run.catch(() => {})
    queues.set(key, settled)
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key) })
    return run
  }

  const assertShape = (defName, rec) => {
    const r = validateAgainstDef(defName, rec)
    if (!r.ok) throw fail('SHAPE_INVALID', `${defName} 不符合正式契约：${r.errors[0].path} ${r.errors[0].message}`, { errors: r.errors })
  }
  const errOut = (wsAtCall, err, extra) => ({
    ok: false, code: (err && err.code) || 'ADOPTION_FAILED',
    message: (err && err.message) || '采用失败', workspace_id: wsAtCall, ...(extra || {}),
    ...(err && err.current !== undefined ? { current: err.current } : {}),
    ...(err && err.blockers !== undefined ? { blockers: err.blockers } : {}),
    ...(err && err.errors !== undefined ? { errors: err.errors } : {}),
  })
  const currentConfs = (draft) => (draft.user_confirmations ?? []).filter((c) => c.draft_revision === draft.revision)
  const signatureOf = (draft) => sha256Hex(utf8Bytes(canonicalJson(buildIntentContent(draft))))
  const sourceIdsOf = (baseline) => new Set((baseline?.source_fingerprints ?? []).map((f) => f.source_id))

  const assertEnvelopeScope = (envelope, draftId, wsAtCall) => {
    if (!envelope || envelope.draft_id !== draftId || envelope.workspace_id !== wsAtCall) {
      throw fail('INVALID_ENVELOPE', '采用信封与当前草案/空间不一致')
    }
    assertShape('ApplicationEnvelope', envelope)
    const ws = envelope.write_set
    if ((ws.tasks_update ?? []).length > 0 || (ws.source_field_confirmations ?? []).length > 0) {
      throw fail('UNSUPPORTED_OP', '初版采用不支持修改既有任务或写入便签字段确认')
    }
  }

  // ---- prepare：固定快照上核对就绪 → 冻结 ID 映射/写集/信封。零写入，不置 applying。 ----
  /** @param {string} draftId @param {{ expected?: any }} [options] */
  async function prepare(draftId, { expected } = {}) {
    const wsAtCall = getWorkspaceId()
    try {
      const snap = await readAssistantSnapshot()
      const rec = snap.drafts.find((d) => d.id === draftId)
      if (!rec) return { ok: false, code: 'NOT_FOUND', message: '草案不存在或不属于当前空间', workspace_id: wsAtCall }
      if (expected != null && canonicalJson(rec) !== canonicalJson(snapshot(expected))) {
        return { ok: false, code: 'CONFLICT', message: '草案已被其它页面修改，请基于最新内容重新核对', current: rec, workspace_id: wsAtCall }
      }
      const signature = await signatureOf(rec)
      // 同一意图已有台账：committed 直接返回回执（含已采用草案的幂等复查）；pending 复用冻结信封。
      const prior = snap.ops.find((o) => o.envelope
        && o.envelope.draft_id === draftId && o.envelope.draft_revision === rec.revision
        && o.envelope.input_signature === signature)
      if (prior && prior.state === 'committed' && verifyReceiptForEnvelope(prior.receipt, prior.envelope)) {
        return { ok: true, workspace_id: wsAtCall, envelope: prior.envelope, receipt: prior.receipt, outcome: 'already_committed', reused: true }
      }
      if (rec.status !== 'ready') {
        return { ok: false, code: 'NOT_READY', message: `草案状态 ${rec.status} 不可采用；须先就绪`, current: rec, workspace_id: wsAtCall }
      }
      checkAdoptionSupported(rec)
      const thread = snap.threads.find((t) => t.id === rec.thread_id) ?? null
      const today = beijingDateStr(new Date(wallNow()))
      const freshness = checkFactFreshness(rec, { docs: snap.docs, sources: snap.sources, today })
      const sourceDiffs = await checkSourceContentFreshness(rec.fact_baseline, snap.sources)
      const fullFreshness = { fresh: freshness.fresh && sourceDiffs.length === 0, diffs: [...freshness.diffs, ...sourceDiffs] }
      const readiness = deriveReadiness(rec, { thread, live: buildLiveRegistry(snap), freshness: fullFreshness })
      if (!readiness.ready) {
        return { ok: false, code: 'READY_BLOCKED', message: '就绪推导未通过，不能采用', blockers: readiness.blockers, workspace_id: wsAtCall }
      }
      if (prior && prior.state === 'pending') {
        return { ok: true, workspace_id: wsAtCall, envelope: prior.envelope, counts: previewCounts(prior.envelope.write_set), reused: true }
      }
      const orderBase = {}
      for (const d of snap.docs) {
        if (d.kind === 'plan_item') orderBase[d.date] = Math.max(orderBase[d.date] ?? 0, d.order ?? 0)
      }
      const now = wallNow()
      const plan = buildAdoptionPlan(rec, {
        workspaceId: wsAtCall, now, newId, orderBase,
        notes: snap.docs.filter((d) => d.kind === 'note'),
        userMessages: (thread?.messages ?? []).filter((m) => m.role === 'user'),
      })
      const confs = currentConfs(rec)
      const gapKeys = new Set(confs.filter((c) => c.object_type === 'gap').map((c) => c.object_id_or_key))
      const overDates = new Set(confs.filter((c) => c.object_type === 'overbook').map((c) => c.object_id_or_key))
      const envelope = {
        application_id: newId(),
        workspace_id: wsAtCall,
        draft_id: draftId,
        draft_revision: rec.revision,
        input_signature: signature,
        mode: rec.mode ?? 'create',
        replan_scope: rec.replan_scope ?? null,
        replacement_baseline: rec.replacement_baseline ?? null,
        id_map: plan.idMap,
        write_set: plan.writeSet,
        fact_baseline: rec.fact_baseline,
        capacity_baseline: plan.capacityBaseline,
        user_confirmations: confs,
        planned_gaps: plan.plannedGaps,
        gap_acknowledged: plan.plannedGaps.every((g) => gapKeys.has(g.work_item_key)),
        overbook_acknowledged: plan.existingOverbookDates.every((d) => overDates.has(d)),
        existing_overbook_dates: plan.existingOverbookDates,
        issued_at: now,
      }
      assertShape('ApplicationEnvelope', envelope)
      return { ok: true, workspace_id: wsAtCall, envelope, counts: plan.counts, reused: false }
    } catch (err) {
      return errOut(wsAtCall, err)
    }
  }

  // ---- apply：阶段 A 落 pending 台账 + ready→applying；阶段 B 单事务复核并整体提交。 ----
  async function apply(draftId, { expected, envelope }) {
    const wsAtCall = getWorkspaceId()
    const nowA = wallNow()
    let phaseAInfo
    try {
      // R1：深拷贝冻结传入信封，后续核对/持久化/提交只用这份，调用方事后改动不影响本次采用。
      envelope = envelope ? snapshot(envelope) : envelope
      assertEnvelopeScope(envelope, draftId, wsAtCall)
      const expectedF = snapshot(expected)
      if (expectedF.id !== draftId) throw fail('INVALID_ENVELOPE', 'expected 基线与采用草案不一致')
      const expectedDigest = canonicalJson(expectedF)
      const intentDigest = canonicalJson(buildIntentContent(expectedF))
      const expectedSignature = await signatureOf(expectedF)
      if (envelope.input_signature !== expectedSignature) {
        throw fail('SIGNATURE_MISMATCH', '采用信封签名与草案意图不一致，拒绝提交；请重新准备并核对')
      }
      const targetDraft = { ...expectedF, status: 'applying', updated_at: nowA }
      const opPending = {
        application_id: envelope.application_id, workspace_id: wsAtCall, state: 'pending',
        envelope, receipt: null, created_at: nowA, updated_at: nowA,
      }
      assertShape('AssistantOpRecord', opPending)
      const envelopeDigest = canonicalJson(envelope)

      // 阶段 A：双击/双标签去重在这里——同内容 applying + 同信封 pending → 放行到阶段 B；
      // 已 committed 且回执对应同一意图 → 已成功；其余一律冲突，绝不产生第二份写入。
      phaseAInfo = await enqueue(`assistant:${wsAtCall}`, async () => {
        const applied = await transformAdoptionAtomic((latest) => {
          const rec = latest.drafts.find((d) => d.id === draftId)
          if (!rec) throw fail('NOT_FOUND', '草案不存在或不属于当前空间')
          const digest = canonicalJson(rec)
          if (digest === expectedDigest) {
            if (rec.status !== 'ready') throw fail('NOT_READY', `草案状态 ${rec.status} 不可采用`, { current: rec })
            // R1：首次持久化 pending 前，用最新草案+冻结映射重建并逐项核验完整写集/确认/基线。
            verifyEnvelopeAgainstDraft(rec, envelope, {
              docs: latest.docs, notes: latest.docs.filter((d) => d.kind === 'note'),
              userMessages: (latest.threads.find((t) => t.id === rec.thread_id)?.messages ?? []).filter((m) => m.role === 'user'),
            })
            const existing = latest.ops.find((o) => o.application_id === envelope.application_id)
            if (existing) {
              // 失败回滚后同意图重试：pending 信封逐字一致 → 复用台账重新置 applying，不生成第二份。
              if (existing.state === 'pending' && canonicalJson(existing.envelope) === envelopeDigest) {
                return { draftPuts: [targetDraft], info: { outcome: 'pending_started' } }
              }
              throw fail('ID_CONFLICT', `采用标识 ${envelope.application_id} 已存在且内容不同，整体拒绝`)
            }
            return { opPuts: [opPending], draftPuts: [targetDraft], info: { outcome: 'pending_started' } }
          }
          const op = latest.ops.find((o) => o.application_id === envelope.application_id)
          if (rec.status === 'applying' && op && op.state === 'pending' && canonicalJson(op.envelope) === envelopeDigest) {
            return { info: { outcome: 'in_flight' } }
          }
          if (rec.status === 'applied' && op && op.state === 'committed' && verifyReceiptForEnvelope(op.receipt, envelope)) {
            return { info: { outcome: 'already_committed', receipt: op.receipt } }
          }
          throw fail('CONFLICT', '草案已被其它页面修改或另一采用正在进行，本次未写入；请重新核对', { current: rec })
        })
        return applied.info
      })
      if (phaseAInfo.outcome === 'already_committed') {
        return { ok: true, outcome: 'already_committed', receipt: phaseAInfo.receipt, workspace_id: wsAtCall }
      }

      // 事务外：证据内容重摘要 + 记录绑定（R7）。活事务内绝不 await 哈希。
      const snap2 = await readAssistantSnapshot()
      const ids = sourceIdsOf(envelope.fact_baseline)
      const sourceDiffs = await checkSourceContentFreshness(envelope.fact_baseline, snap2.sources)
      const binding = sourceBindingDigest(snap2.sources, ids)

      // 阶段 B：复核台账/草案/意图/全窗口事实/资料绑定 → 业务对象 + applied + 回执 + 线程消息同事务。
      const phaseB = await enqueue(`assistant:${wsAtCall}`, async () => {
        const applied = await transformAdoptionAtomic((latest, ctx) => {
          const rec = latest.drafts.find((d) => d.id === draftId)
          if (!rec) throw fail('NOT_FOUND', '草案不存在或不属于当前空间')
          const op = latest.ops.find((o) => o.application_id === envelope.application_id)
          if (op && op.state === 'committed') {
            if (verifyReceiptForEnvelope(op.receipt, envelope)) return { info: { outcome: 'already_committed', receipt: op.receipt } }
            throw fail('CONFLICT', '采用台账回执与本次意图不一致')
          }
          if (!op || op.state !== 'pending' || canonicalJson(op.envelope) !== envelopeDigest) {
            throw fail('CONFLICT', '采用台账与冻结信封不一致，本次未写入')
          }
          if (rec.status !== 'applying') throw fail('STATUS_LOCKED', `草案状态 ${rec.status} 不在采用中`, { current: rec })
          if (canonicalJson(buildIntentContent(rec)) !== intentDigest) {
            throw fail('CONFLICT', '采用中草案内容被改动，本次未写入', { current: rec })
          }
          const today = beijingDateStr(new Date(wallNow()))
          const freshness = checkFactFreshness(rec, { docs: latest.docs, sources: latest.sources, today })
          const bindingNow = sourceBindingDigest(latest.sources, ids)
          if (!freshness.fresh || sourceDiffs.length > 0 || bindingNow !== binding) {
            // 事实漂移：确定未提交，applying→needs_review；pending 台账保留供核对，不写任何业务对象。
            const next = { ...rec, status: 'needs_review', updated_at: wallNow() }
            return { draftPuts: [next], info: { outcome: 'needs_recheck', diffs: [...freshness.diffs, ...sourceDiffs], draft: next } }
          }
          const ws = ctx.ws
          // R1：提交只使用台账里已核验的持久信封，不使用调用方传入对象。
          const frozen = op.envelope
          // M3：取消写集在事务内按最新草案替换基线重建，须与冻结信封、用户选择集三方一致；
          // 基线新鲜度（含专注会话引用扫描）已由上方 checkFactFreshness 对 latest.docs 复核。
          const docCancels = []
          if (frozen.mode === 'replan') {
            const rebuilt = (rec.replacement_baseline?.items ?? []).map((it) => ({
              plan_item_id: it.plan_item_id, expected: it, new_state: 'cancelled',
            }))
            const scopeIds = [...(frozen.replan_scope?.replacement_ids ?? [])].sort()
            const cancelIds = rebuilt.map((c) => c.plan_item_id).sort()
            if (canonicalJson(rebuilt) !== canonicalJson(frozen.write_set.plan_items_cancel ?? [])
              || canonicalJson(scopeIds) !== canonicalJson(cancelIds)) {
              throw fail('REPLAN_CANCEL_MISMATCH', '取消写集与最新替换基线或用户选择集不一致，整体拒绝')
            }
            docCancels.push(...rebuilt)
          }
          const docAdds = []
          for (const t of frozen.write_set.tasks_create ?? []) {
            docAdds.push({
              kind: 'task', id: t.formal_id, workspace_id: ws, title: t.title, description: t.description,
              matter_id: t.matter_id, note_ids: t.note_ids, deadline: t.deadline, status: t.status,
              completion_criteria: t.completion_criteria, current_action_id: null,
              created_at: t.created_at, updated_at: t.updated_at,
            })
          }
          for (const a of frozen.write_set.actions_create ?? []) {
            docAdds.push({
              kind: 'action', id: a.formal_id, workspace_id: ws, task_id: a.task_id, text: a.text,
              minutes: a.minutes, basis: a.basis, done: a.done, created_at: a.created_at,
            })
          }
          for (const p of frozen.write_set.plan_items_create ?? []) {
            docAdds.push({
              kind: 'plan_item', id: p.formal_id, workspace_id: ws, task_id: p.task_id, date: p.date,
              planned_minutes: p.planned_minutes, action_text: p.action_text, state: p.state,
              actual_minutes: p.actual_minutes, focus_session_id: p.focus_session_id,
              order: p.order, task_ref_state: p.task_ref_state,
            })
          }
          // 写入边界契约校验（kind 是持久化元数据，不进契约域模型）。
          for (const d of docAdds) {
            const { kind, ...rest } = d
            assertShape(DOC_DEF[kind], rest)
          }
          const committedAt = wallNow()
          const receipt = {
            application_id: frozen.application_id,
            draft_id: draftId,
            draft_revision: frozen.draft_revision,
            input_signature: frozen.input_signature,
            id_map: frozen.id_map,
            counts: previewCounts(frozen.write_set),
            unscheduled_kept: frozen.planned_gaps,
            ...(frozen.mode === 'replan' ? {
              cancelled_plan_item_ids: docCancels.map((c) => c.plan_item_id),
              replan_task_id: frozen.replan_scope.task_id,
            } : {}),
            committed_at: committedAt,
          }
          assertShape('ApplicationReceipt', receipt)
          const opCommitted = { ...op, state: 'committed', receipt, updated_at: committedAt }
          assertShape('AssistantOpRecord', opCommitted)
          const nextDraft = { ...rec, status: 'applied', applied_summary: appliedSummaryFromReceipt(receipt), updated_at: committedAt }
          assertShape('AssistantDraft', nextDraft)
          const threadPuts = []
          const thread = latest.threads.find((t) => t.id === rec.thread_id)
          if (thread) {
            const c = receipt.counts
            const msg = {
              id: newId(), role: 'system', type: 'adoption_result',
              content: `已采用：新增 ${c.tasks_created} 个任务、${c.actions_created} 个行动、${c.plan_items_created} 条安排。`
                + (frozen.mode === 'replan' ? `取消 ${c.plan_items_cancelled} 条旧安排（已经你确认替换）。` : ''),
              refs: [{ object_type: 'draft', id: draftId }], created_at: committedAt,
            }
            const r = appendThreadMessage(thread, msg)
            // 线程已满时回执仍是权威记录，采用照常提交；不因装饰性消息失败回滚业务写入。
            if (r.ok) threadPuts.push({ ...r.thread, updated_at: committedAt })
          }
          return {
            threadPuts, draftPuts: [nextDraft], opPuts: [opCommitted], docAdds, docCancels,
            info: { outcome: 'committed', receipt, draft: nextDraft },
          }
        })
        return applied.info
      })
      if (phaseB.outcome === 'committed') {
        return { ok: true, outcome: 'committed', receipt: phaseB.receipt, counts: phaseB.receipt.counts, draft: phaseB.draft, workspace_id: wsAtCall }
      }
      if (phaseB.outcome === 'already_committed') {
        return { ok: true, outcome: 'already_committed', receipt: phaseB.receipt, workspace_id: wsAtCall }
      }
      return { ok: false, outcome: 'needs_recheck', code: 'CONFLICT_FACTS', message: '空间事实或证据已变化，本次确定未提交；请重新核对', diffs: phaseB.diffs, draft: phaseB.draft, workspace_id: wsAtCall }
    } catch (err) {
      // 阶段 A 之前/之中失败：无 pending 写入或整体回滚，草案原样。
      if (!phaseAInfo) return errOut(wsAtCall, err, { outcome: 'not_committed' })
      if (err && err.code === 'WORKSPACE_CHANGED') {
        // 原空间草案可能停在 applying；回到原空间后 settleRefresh→result_unknown→resolve 收敛。
        return errOut(wsAtCall, err, { outcome: 'result_unknown', message: '工作区已切换，本次采用未提交；回到原空间后请核实结果' })
      }
      // 阶段 B 确定失败（整体回滚）：把 applying 收敛到 needs_review，pending 台账保留。
      try {
        await enqueue(`assistant:${wsAtCall}`, () => transformAdoptionAtomic((latest) => {
          const rec = latest.drafts.find((d) => d.id === draftId)
          const op = latest.ops.find((o) => o.application_id === envelope.application_id)
          if (rec && rec.status === 'applying' && op && op.state === 'pending') {
            return { draftPuts: [{ ...rec, status: 'needs_review', updated_at: wallNow() }], info: {} }
          }
          return { info: {} }
        }))
      } catch { /* 收敛失败留待刷新结算，不掩盖原始错误 */ }
      return errOut(wsAtCall, err, { outcome: 'not_committed' })
    }
  }

  // ---- resolve：result_unknown 只查原意图台账，绝不生成新 ID/新写入意图。 ----
  async function resolve(draftId) {
    const wsAtCall = getWorkspaceId()
    try {
      const snap = await readAssistantSnapshot()
      const rec = snap.drafts.find((d) => d.id === draftId)
      if (!rec) return { ok: false, code: 'NOT_FOUND', message: '草案不存在或不属于当前空间', workspace_id: wsAtCall }
      if (rec.status !== 'result_unknown') {
        return { ok: false, code: 'STATUS_LOCKED', message: `草案状态 ${rec.status} 无需结果核实`, current: rec, workspace_id: wsAtCall }
      }
      const expectedDigest = canonicalJson(rec)
      const candidates = snap.ops
        .filter((o) => o.envelope && o.envelope.draft_id === draftId && o.envelope.draft_revision === rec.revision)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      const op = candidates[0] ?? null
      const committed = op && op.state === 'committed' && verifyReceiptForEnvelope(op.receipt, op.envelope)
      const applied = await enqueue(`assistant:${wsAtCall}`, () => transformAdoptionAtomic((latest) => {
        const cur = latest.drafts.find((d) => d.id === draftId)
        if (!cur) throw fail('NOT_FOUND', '草案不存在或不属于当前空间')
        if (canonicalJson(cur) !== expectedDigest) throw fail('CONFLICT', '草案已被其它页面修改，请重新核实', { current: cur })
        if (cur.status !== 'result_unknown') throw fail('STATUS_LOCKED', `草案状态 ${cur.status} 无需结果核实`, { current: cur })
        const now = wallNow()
        if (committed) {
          const next = { ...cur, status: 'applied', applied_summary: appliedSummaryFromReceipt(op.receipt), updated_at: now }
          assertShape('AssistantDraft', next)
          return { draftPuts: [next], info: { outcome: 'applied', receipt: op.receipt, draft: next } }
        }
        // pending 台账 ⇒ 业务写入确定未发生（同一事务原子性）；无台账同样确定未提交。
        const next = { ...cur, status: 'needs_review', updated_at: now }
        return { draftPuts: [next], info: { outcome: 'not_committed', draft: next } }
      }))
      return { ok: true, workspace_id: wsAtCall, ...applied.info }
    } catch (err) {
      return errOut(wsAtCall, err)
    }
  }

  return { prepare, apply, resolve }
}