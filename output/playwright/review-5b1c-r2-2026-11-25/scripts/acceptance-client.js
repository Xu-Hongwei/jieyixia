// 5B-1C 最小验收展示页客户端（自动化注入，非注册路由、不进生产构建）。
// 只呈现真实服务返回值并触发真实生产服务调用；所有分钟/状态/原因/版本/计数来自实际结果，不手填成功。
// 由 real-1c.mjs 通过 context.route 在隔离 origin 的专用地址注入；导入生产 db/drafts/backup 模块。
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v)
    else if (v != null) n.setAttribute(k, v)
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  return n
}
const fmt = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

const S = {
  ws: null, name: null, TS: null, fixture: null,
  db: null, svc: null, ids: null,
  view: null,        // 最近一次 svc.get 的真实返回
  result: null,      // 最近一次 reschedule 的真实 planning_result
  log: [],
  requirements: [],  // 线程已确认要求（真实读回）
}
const log = (step, payload) => { S.log.push({ step, at: S.TS, payload }); paint() }

function must(r, what) {
  if (!r || r.ok !== true) throw Object.assign(new Error(`${what} 失败: ${JSON.stringify(r && (r.code || r.errors || r))}`), { result: r })
  return r
}

// —— 真实种子：业务对象 + 线程/草案（仅 proposal，planning_input 由真实 reschedule 计算）——
async function init({ ws, name, fixture, TS }) {
  S.ws = ws; S.name = name; S.TS = TS; S.fixture = fixture
  const { PNG_BYTES } = await import('/src/tests/backupFixtures.js')
  const db = await import('/src/services/storage/db.js')
  const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
  S.db = db
  db.configureWorkspace(ws)
  await db.putWorkspace({ id: ws, name, is_demo: false })
  for (const s of fixture.seed.sources) {
    await db.putSource({ id: s.id, kind: s.kind, captured_at: s.captured_at, blob: new Blob([PNG_BYTES], { type: 'image/png' }), name: s.name })
  }
  // 夹具中 note/context_note 等为人工注解，非契约字段：落库前剥离，避免备份完整性校验拒绝（additionalProperties:false）。
  // 有精度的正式截止须记录 confirmed_at（契约 semDeadline）；补 TS 不改截止值/精度，手算预期不变。
  const cleanDoc = (d) => {
    const { note, context_note, ...rest } = d
    if (rest.deadline && rest.deadline.precision !== 'none' && rest.deadline.confirmed_at == null) {
      rest.deadline = { ...rest.deadline, confirmed_at: TS }
    }
    return rest
  }
  for (const n of fixture.seed.notes) await db.putDoc({ ...cleanDoc(n), created_at: TS, updated_at: TS, reviewed_at: TS })
  for (const t of fixture.seed.tasks) await db.putDoc({ ...cleanDoc(t), created_at: TS, updated_at: TS })
  for (const a of fixture.seed.actions) await db.putDoc({ ...cleanDoc(a), created_at: TS })
  for (const p of fixture.seed.plan_items) await db.putDoc({ ...cleanDoc(p), actual_minutes: null, focus_session_id: null, action_text: '虚构占用' })
  let n = 0
  S.svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => S.TS, newId: () => `${ws}-id-${++n}` })
  const created = must(await S.svc.create({
    title: fixture.case,
    proposal: fixture.proposal,
    sourceRefs: fixture.seed.sources.map((s) => ({ object_type: 'source', id: s.id })),
    selectedRefs: [
      ...fixture.seed.sources.map((s) => ({ object_type: 'source', id: s.id })),
      ...fixture.seed.tasks.map((t) => ({ object_type: 'task', id: t.id })),
    ],
  }), 'create')
  S.ids = { threadId: created.thread.id, draftId: created.draft.id }
  must(await S.svc.appendMessage(S.ids.threadId, { message: { role: 'user', content: '虚构原文：课程报告 11 月 27 日截止，剩余约 200 分钟。', refs: [{ object_type: 'task', id: 't-course' }] } }), 'appendMessage')
  await refreshView()
  log('init', { threadId: S.ids.threadId, draftId: S.ids.draftId, revision: S.view.draft.revision, status: S.view.draft.status })
  return S.ids
}

async function refreshView() {
  S.view = await S.svc.get(S.ids.draftId)
  const th = S.view.thread
  S.requirements = th ? th.confirmed_requirements ?? [] : []
  S.result = S.view.draft.planning_result
  paint()
  return S.view
}

const contextDays = () => ({
  timezone: 'Asia/Shanghai', today: S.fixture.today, start_date: S.fixture.start_date, horizon_days: 7,
  days: S.fixture.window.map((d) => ({ date: d, budget_minutes: null })),
})

// —— 真实操作（按钮与脚本共用；全部走生产服务）——
const actions = {
  async confirmRound1() {
    for (const r of S.fixture.confirmed_requirements.round1) {
      const g = await S.svc.get(S.ids.draftId)
      must(await S.svc.confirmRequirement(S.ids.threadId, {
        expected: g.baseline.thread,
        requirement: { ...r, confirmed_at: S.TS, evidence_refs: [] },
      }), `confirmRequirement ${r.requirement_id}`)
    }
    await refreshView(); log('confirmRound1', { requirements: S.requirements.map((r) => r.requirement_id) })
    return { requirements: S.requirements.map((r) => ({ id: r.requirement_id, version: r.version, value: r.value })) }
  },
  async reschedule() {
    const g = await S.svc.get(S.ids.draftId)
    const r = await S.svc.reschedule(S.ids.draftId, { expected: g.baseline.draft, context: contextDays(), options: { bufferPct: S.fixture.buffer_pct } })
    if (!r.ok) { log('reschedule FAILED', { code: r.code, message: r.message, clarifications: r.clarifications }); return r }
    await refreshView()
    const res = S.view.draft.planning_result
    const totalScheduled = res.segments.reduce((a, s) => a + s.minutes, 0)
    const unscheduled = res.unscheduled.reduce((a, u) => a + (u.remaining_minutes ?? 0), 0)
    log('reschedule', { revision: S.view.draft.revision, totalScheduled, unscheduled, complete: res.complete })
    return { ok: true, revision: S.view.draft.revision, totalScheduled, unscheduled, complete: res.complete, segments: res.segments.map((s) => [s.segment_key, s.date, s.minutes]), days: res.days, unscheduled_items: res.unscheduled }
  },
  async confirmGap() {
    const g = await S.svc.get(S.ids.draftId)
    const rev = g.baseline.draft.revision
    const r = await S.svc.confirm(S.ids.draftId, { expected: g.baseline.draft, confirmation: {
      confirmation_id: `gap-${rev}`, draft_revision: rev, object_type: 'gap', object_id_or_key: 'w-course',
      field_path: '', old_value: null, new_value: null, confirmed_at: S.TS,
    } })
    if (!r.ok) { log('confirmGap FAILED', { code: r.code }); return r }
    await refreshView(); log('confirmGap', { revision: rev })
    return { ok: true, revision: rev }
  },
  async markReady() {
    // 冻结边集：editing→generating→ready（editing 不能直接→ready）；ready 由服务独立推导。
    const g = await S.svc.get(S.ids.draftId)
    const gen = await S.svc.setStatus(S.ids.draftId, { expected: g.baseline.draft, status: 'generating' })
    if (!gen.ok) { log('markReady generating FAILED', { code: gen.code }); return { ok: false, code: gen.code, stage: 'generating' } }
    const r = await S.svc.setStatus(S.ids.draftId, { expected: gen.draft, status: 'ready' })
    await refreshView()
    log('markReady', { ok: r.ok, code: r.code, blockers: r.blockers, readiness: S.view.readiness })
    return { ok: r.ok, code: r.code, blockers: r.blockers, ready: S.view.readiness.ready, complete: S.view.draft.planning_result?.complete, status: S.view.draft.status }
  },
  async raiseBudget() {
    const g = await S.svc.get(S.ids.draftId)
    const src = S.fixture.confirmed_requirements.round2_add[0]
    const req = { requirement_id: src.requirement_id, version: src.version, type: src.type, value: src.value, strength: src.strength, confirmed_at: S.TS, evidence_refs: [] }
    const r = must(await S.svc.confirmRequirement(S.ids.threadId, {
      expected: g.baseline.thread,
      requirement: req,
    }), 'raiseBudget')
    await refreshView()
    log('raiseBudget', { invalidatedDrafts: r.invalidatedDrafts, fact_baseline: S.view.draft.fact_baseline, ready: S.view.readiness.ready, blockers: S.view.readiness.blockers.map((b) => b.code) })
    return { ok: true, invalidatedDrafts: r.invalidatedDrafts, factBaselineNull: S.view.draft.fact_baseline === null, ready: S.view.readiness.ready, blockers: S.view.readiness.blockers.map((b) => b.code), revision: S.view.draft.revision, status: S.view.draft.status }
  },
  async editContent(text) {
    const g = await S.svc.get(S.ids.draftId)
    const r = await S.svc.edit(S.ids.draftId, { expected: g.baseline.draft, edits: { assumptions: [...(g.baseline.draft.assumptions ?? []), { id: `as-${g.baseline.draft.revision}-${S.log.length}`, text, related_keys: ['w-course'] }] } })
    if (!r.ok) { log('editContent FAILED', { code: r.code }); return r }
    await refreshView(); log('editContent', { bumped: r.bumped, revision: S.view.draft.revision })
    return { ok: true, bumped: r.bumped, revision: S.view.draft.revision }
  },
  async setTS(ts) { S.TS = ts; log('setTS', { ts }); return { ts } },
  async snapshotBusiness(wsArg) {
    // 硬刷新后客户端模块状态重置（S.db/S.ws 为 null）：懒导入生产 db 并允许显式传入 ws。
    // C2 整改：完整业务快照——docs 全字段原样（含 text/minutes/fields/description 等用户内容，不做字段投影），
    // sources 除 blob 外全字段 + 真实字节 SHA-256；助手线程/草案与空间目录也全量返回，供原空间恢复前后完整比较。
    const db = S.db ?? await import('/src/services/storage/db.js')
    const ws = wsArg ?? S.ws
    const snap = await db.readWorkspaceSnapshot(ws)
    const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const sources = []
    for (const s of snap.sources) {
      const { blob, ...fields } = s
      sources.push({ ...fields, blobSha: await sha(await blob.arrayBuffer()), blobSize: blob.size, blobType: blob.type })
    }
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const ops = (await db.allAssistantOps()).records.filter((o) => o.workspace_id === ws)
    return {
      sources: sources.sort(byId),
      docs: snap.docs.map((d) => ({ ...d })).sort(byId),
      opsCount: ops.length,
      threads: snap.assistantThreads.map((t) => ({ ...t })).sort(byId),
      drafts: snap.assistantDrafts.map((d) => ({ ...d })).sort(byId),
      workspace: snap.workspace ? { ...snap.workspace } : null,
    }
  },
}

// C3 整改：读取既有 workspace/thread/draft 并绑定展示（硬刷新/恢复空间/截止场景用）。
// 只从真实 IDB 读回，绝不播种 init 重建数据；所有展示值来自真实 svc.get 返回。
async function bindExisting({ ws, draftId, name, TS, fixture = null }) {
  const db = await import('/src/services/storage/db.js')
  const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
  S.db = db
  S.ws = ws; S.name = name; S.TS = TS; S.fixture = fixture
  db.configureWorkspace(ws)
  let n = 0
  S.svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => S.TS, newId: () => `bind-${++n}` })
  const g = await S.svc.get(draftId)
  if (!g.ok) throw new Error(`bindExisting 读取失败: ${JSON.stringify(g)}`)
  S.ids = { threadId: g.draft.thread_id, draftId }
  await refreshView()
  log('bindExisting', { ws, draftId, revision: S.view.draft.revision, status: S.view.draft.status, ready: S.view.readiness.ready })
  return { ws, draftId, threadId: S.ids.threadId, revision: S.view.draft.revision, status: S.view.draft.status, ready: S.view.readiness.ready }
}

// —— 渲染：全部来自真实返回值 ——
function paint() {
  const root = document.getElementById('app')
  if (!root) return
  root.replaceChildren()
  root.append(el('div', { class: 'banner', text: '本地规则排程验收 · 固定建议输入 · 未接真实模型' }))
  if (!S.view) { root.append(el('p', { text: '尚未初始化' })); return }
  const d = S.view.draft
  const res = d.planning_result

  // 输入区（fixture 可缺省：绑定既有草案时按真实 draft/thread 数据展示）
  const input = el('section', { class: 'card' }, el('h2', { text: S.fixture ? '输入（虚构夹具）' : '输入（既有草案真实读回）' }))
  const srcIds = S.fixture ? S.fixture.seed.sources.map((s) => `${s.id}(${s.kind})`) : (d.source_refs ?? []).map((r) => `${r.id}(${r.object_type})`)
  input.append(el('div', { class: 'tag', text: '原文资料：' + (srcIds.join('、') || '无') }))
  input.append(el('div', { class: 'tag', text: '固定建议工作项：' + (d.proposal?.work_items ?? []).map((w) => `${w.key}→${w.task_ref.id ?? w.task_ref.key}/${w.action_ref.id ?? w.action_ref.key} 剩余${w.remaining_minutes}分`).join('、') }))
  input.append(el('div', { class: 'tag', text: '用户已确认要求：' + (S.requirements.map((r) => `${r.requirement_id} v${r.version} ${r.type}=${fmt(r.value)}(${r.strength})`).join('；') || '无') }))
  root.append(input)

  // 七天预览
  const prev = el('section', { class: 'card' }, el('h2', { text: '七天草案预览（非正式安排）' }))
  const formalFact = (d.fact_baseline?.task_facts ?? []).find((f) => f.task_ref?.kind === 'existing')
  const formalDeadline = S.fixture ? S.fixture.seed.tasks.find((t) => t.id === 't-course').deadline.value : (formalFact ? formalFact.deadline_value : null)
  if (formalDeadline != null) prev.append(el('div', { class: 'deadline', text: `正式总截止：${formalDeadline}（date，单独列示，不与每日安排混排）` }))
  if (res) {
    const table = el('table', {}, el('tr', {}, ...['日期', '预算', '缓冲', '已有占用', '草案新增', '剩余可用', '超订'].map((h) => el('th', { text: h }))))
    for (const day of res.days) {
      table.append(el('tr', {}, ...[day.date, day.budget_minutes, day.buffer_minutes, day.committed_minutes, day.allocated_minutes, day.free_minutes, day.overbooked_minutes].map((v) => el('td', { text: fmt(v) }))))
    }
    prev.append(table)
    prev.append(el('div', { class: 'seg', text: '草案分段：' + res.segments.map((s) => `${s.segment_key} ${s.date} ${s.minutes}分`).join('；') }))
    const totalScheduled = res.segments.reduce((a, s) => a + s.minutes, 0)
    const unscheduled = res.unscheduled.reduce((a, u) => a + (u.remaining_minutes ?? 0), 0)
    prev.append(el('div', { class: 'totals', text: `已排合计 ${totalScheduled} 分 · 未排 ${unscheduled} 分 · complete=${res.complete}` }))
    if (res.unscheduled.length) prev.append(el('div', { class: 'gap', text: '未排原因：' + res.unscheduled.map((u) => `${u.work_item_key} ${u.remaining_minutes}分 ${u.reason}`).join('；') }))
  } else {
    prev.append(el('p', { text: '尚未计算（planning_result=null）' }))
  }
  root.append(prev)

  // 草案信息：revision / 持久状态 / 当前可用性 / 阻断原因 三者分列
  const info = el('section', { class: 'card' }, el('h2', { text: '草案信息' }))
  info.append(el('div', { class: 'kv', text: `revision（内容版本）：${d.revision}` }))
  info.append(el('div', { class: 'kv', text: `持久状态 status：${d.status}` }))
  info.append(el('div', { class: 'kv', text: `当前可用性 readiness.ready：${S.view.readiness.ready}` }))
  info.append(el('div', { class: 'kv', text: `计算完整性 complete：${res ? res.complete : '—'}` }))
  info.append(el('div', { class: 'kv', text: `事实新鲜度 fresh：${S.view.factFreshness.fresh}` }))
  info.append(el('div', { class: 'blockers', text: '阻断原因：' + (S.view.readiness.blockers.map((b) => b.code).join('、') || '无') }))
  root.append(info)

  // 截止决定 vs 计算采用（C3：阻断当时展示真实决定/旧计算值/阻断码；全部来自真实 draft 数据）
  const facts = d.planning_input?.task_facts ?? []
  const dlConfs = (d.user_confirmations ?? []).filter((u) => u.object_type === 'task' && u.field_path === 'deadline' && u.draft_revision === d.revision)
  if (facts.length || dlConfs.length) {
    const dl = el('section', { class: 'card' }, el('h2', { text: '截止决定 vs 计算采用（当前版）' }))
    for (const f of facts) {
      const scope = f.task_ref?.kind === 'existing' ? 'formal' : 'draft'
      const key = scope === 'formal' ? f.task_ref.id : f.task_ref.key
      const conf = dlConfs.find((u) => (u.id_scope ?? 'formal') === scope && u.object_id_or_key === key)
      const dec = conf ? conf.new_value : null
      const decV = dec && (dec.precision ?? 'none') !== 'none' ? dec.value : '无截止'
      const decP = dec ? (dec.precision ?? 'none') : '未确认'
      const factV = (f.deadline_precision ?? 'none') === 'none' ? '无截止' : f.deadline_value
      const match = dec ? (String(decV) === String(factV) && decP === (f.deadline_precision ?? 'none')) : null
      dl.append(el('div', { class: 'kv', text: `${scope}:${key} — 当前决定：${decV}（${decP}）｜计算采用：${factV}（${f.deadline_precision ?? 'none'}）｜${match == null ? '无当前版决定' : match ? '一致' : '不一致→须重排'}` }))
    }
    if (S.view.readiness.blockers.some((b) => b.code === 'DEADLINE_RECOMPUTE_REQUIRED')) {
      dl.append(el('div', { class: 'deadline', text: 'DEADLINE_RECOMPUTE_REQUIRED：当前截止决定与计算采用不一致，旧排程不得直接就绪' }))
    }
    const lastLog = S.log.filter((l) => l.step === 'readyCommitResult').slice(-1)[0]
    if (lastLog) dl.append(el('div', { class: 'deadline', text: `ready 提交真实结果：${JSON.stringify(lastLog.payload)}` }))
    root.append(dl)
  }

  // 操作区
  const ops = el('section', { class: 'card' }, el('h2', { text: '操作（触发真实服务）' }))
  const btn = (label, fn) => el('button', { text: label, onclick: async () => { try { await fn() } catch (e) { log('ERROR', { message: e.message }) } } })
  ops.append(
    btn('确认初始要求(60/不可用日)', actions.confirmRound1),
    btn('重新排程', actions.reschedule),
    btn('确认已知缺口', actions.confirmGap),
    btn('标记就绪(真实推导)', actions.markReady),
    btn('调高预算到90', actions.raiseBudget),
    btn('修改一处合法内容', () => actions.editContent('验收补充假设')),
    btn('刷新读取', refreshView),
    el('a', { href: '#/data', text: '进入数据页（真实导出/恢复）' }),
  )
  root.append(ops)

  // 可折叠工程详情
  const detail = el('details', { class: 'card' }, el('summary', { text: '工程详情（只读历史/身份/验收日志）' }))
  detail.append(el('pre', { text: '身份：' + JSON.stringify(S.ids) }))
  detail.append(el('pre', { text: '历史版本数：' + (d.revision_history?.length ?? 0) + '；确认数：' + (d.user_confirmations?.length ?? 0) }))
  detail.append(el('pre', { text: '假设（真实读回）：' + ((d.assumptions ?? []).map((a) => `${a.id}: ${a.text}`).join('；') || '无') }))
  detail.append(el('pre', { text: 'fact_baseline：' + (d.fact_baseline ? JSON.stringify({ captured_at: d.fact_baseline.captured_at, task_facts: d.fact_baseline.task_facts, fingerprints: d.fact_baseline.source_fingerprints.length }) : 'null') }))
  detail.append(el('pre', { text: '验收日志：\n' + S.log.map((l) => `[${l.step}] ${JSON.stringify(l.payload)}`).join('\n') }))
  root.append(detail)
}

window.__A = { init, bindExisting, refreshView, actions, paint, state: S, must, log }
document.addEventListener('DOMContentLoaded', paint)
paint()