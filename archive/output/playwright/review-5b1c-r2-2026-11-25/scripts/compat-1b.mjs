// B1C-14 兼容矩阵复用：原样复制 5B-1B R10 真实浏览器矩阵（B1B-02/03/06/12/13/18/20/21 + DataPage UI 往返），
// 仅改输出目录到 1C 运行批次、端口改为先探测空闲再 strictPort，不改任何断言/场景/框架（开工单 §5 B1C-14）。
// 不在原审查目录原位重跑；本副本独立运行，产出写入 output/playwright/stage5b-1c/run-2026-11-25/compat-1b/（R2 收口重跑批次）。
// 运行：node E:/qoder/devlog/private-evidence/stage5b-1/5B-1C/scripts/compat-1b.mjs
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'

const OUT = join('E:', 'qoder', 'output', 'playwright', 'review-5b1c-r2-2026-11-25', 'runs', 'run-2026-11-25', 'compat-1b')
mkdirSync(OUT, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
function portFree(port) {
  return new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(port, '127.0.0.1') })
}
let PORT = null
for (const p of [5182, 5183, 5184, 5185, 5186]) { if (await portFree(p)) { PORT = p; break } }
if (PORT == null) { console.error('无空闲端口（5182–5186 均占用），显式退出，不杀未知服务'); process.exit(2) }
const BASE = `http://127.0.0.1:${PORT}/`
const TS = '2026-11-24T10:00:00+08:00'
const PAST_MS = 1_700_000_000_000 // verifyCommittedRestore 用真实 Date.now() 核对占位租约须已过期

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}

// —— 自起隔离 dev server（结束即杀，不留进程）——
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: 'E:/qoder/frontend', stdio: ['ignore', 'pipe', 'pipe'] })
let viteLog = ''
vite.stdout.on('data', (d) => { viteLog += d })
vite.stderr.on('data', (d) => { viteLog += d })
const deadline = Date.now() + 45000
for (;;) {
  try { const r = await fetch(BASE); if (r.ok) break } catch {}
  if (Date.now() > deadline) { console.error(viteLog); vite.kill(); throw new Error('vite 未就绪') }
  await new Promise((r) => setTimeout(r, 300))
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true })

async function newScene(name, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const netHits = []
  context.on('request', (r) => { const u = r.url(); if (/:8000|:8020|\/analyze/.test(u)) netHits.push(u) })
  if (opts.cache) {
    // 离线刷新用：在线阶段缓存全部响应，断网后由路由回放（真实 offline + 真实 reload）。
    const cache = new Map()
    await context.route('**/*', async (route) => {
      const req = route.request()
      const hit = cache.get(req.url())
      if (hit) return route.fulfill({ status: hit.status, headers: hit.headers, body: hit.body })
      try {
        const headers = { ...req.headers() }
        delete headers['if-none-match']
        delete headers['if-modified-since']
        const resp = await route.fetch({ headers })
        const body = await resp.body()
        if (resp.status() === 200) cache.set(req.url(), { status: 200, headers: resp.headers(), body })
        return route.fulfill({ status: resp.status(), headers: resp.headers(), body })
      } catch { return route.abort() }
    })
  }
  // 探针页：不加载应用外壳，避免应用启动即打开 v4 库（迁移/阻塞场景须先手工造 v3）。
  await context.route(BASE + '__probe', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><meta charset="utf-8"><title>5B-1B 隔离探针</title></head><body>5B-1B isolated probe</body></html>',
  }))
  const page = await context.newPage()
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, e.message))
  await page.goto(BASE + '__probe', { waitUntil: 'domcontentloaded' })
  return { context, page, netHits }
}

// 真实服务种子：业务对象 + 一线程四草案（editing rev2+确认 / discarded / generating / applied+台账）。
async function seedWorkspace(page, ws, name) {
  return page.evaluate(async ({ ws, name, TS }) => {
    const { PNG_BYTES } = await import('/src/tests/backupFixtures.js')
    const { mkProposal, mkInput, mkWork, mkOcc, START } = await import('/src/tests/planning.helpers.js')
    const { scheduleDaily } = await import('/src/domains/planning/schedule.js')
    const db = await import('/src/services/storage/db.js')
    const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
    const must = (r, what) => { if (!r || r.ok !== true) throw new Error(`${what} 失败: ${JSON.stringify(r && (r.code || r.errors || r))}`) }
    db.configureWorkspace(ws)
    await db.putWorkspace({ id: ws, name, is_demo: false })
    await db.putSource({ id: 's-1', kind: 'image', captured_at: TS, blob: new Blob([PNG_BYTES], { type: 'image/png' }), name: '虚构.png' })
    await db.putDoc({ id: 'n-1', kind: 'note', title: '虚构便签', source_id: 's-1', status: 'reviewed', content_type: 'notice', fields: [], created_at: TS, updated_at: TS, reviewed_at: TS })
    await db.putDoc({ id: 't-1', kind: 'task', title: '虚构目标一', status: 'todo', deadline: { value: null, precision: 'none' }, created_at: TS, updated_at: TS })
    await db.putDoc({ id: 't-2', kind: 'task', title: '虚构目标二', status: 'todo', deadline: { value: null, precision: 'none' }, created_at: TS, updated_at: TS })
    await db.putDoc({ id: 'a-1', kind: 'action', task_id: 't-1', text: '虚构步骤', minutes: 60, done: false, created_at: TS })
    await db.putDoc({ id: 'p-1', kind: 'plan_item', task_id: 't-1', date: START, planned_minutes: 30, action_text: '虚构', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active' })
    let n = 0
    const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `${ws}-id-${++n}` })
    const conf = (over = {}) => ({ confirmation_id: 'c1', draft_revision: 1, object_type: 'gap', object_id_or_key: 'w1', field_path: '', old_value: null, new_value: null, confirmed_at: TS, ...over })
    const zeroCounts = { tasks_created: 0, tasks_updated: 0, actions_created: 0, plan_items_created: 0, source_fields_confirmed: 0 }
    const input = mkInput({ budgets: [120, 120, 120, 120, 120, 120, 120], works: [mkWork('w1', { action_ref: { kind: 'existing', id: 'a-1' } })], occupancy: [mkOcc('p-1', { task_id: 't-1' })], ack: ['w1'] })
    const a = await svc.create({ title: '虚构线程', proposal: mkProposal(), planningInput: input, planningResult: scheduleDaily(input), sourceRefs: [{ object_type: 'source', id: 's-1' }], selectedRefs: [{ object_type: 'source', id: 's-1' }] })
    must(a, 'create A')
    const threadId = a.thread.id
    must(await svc.appendMessage(threadId, { message: { role: 'user', content: '原文提到 t-1 与 s-1，不是引用', refs: [{ object_type: 'task', id: 't-1' }] } }), 'appendMessage')
    const g0 = await svc.get(a.draft.id)
    const e1 = await svc.edit(a.draft.id, { expected: g0.baseline.draft, edits: { assumptions: [{ id: 'as1', text: '虚构假设', related_keys: ['w1'] }] } })
    must(e1, 'edit A')
    must(await svc.confirm(a.draft.id, { expected: e1.draft, confirmation: conf({ draft_revision: 2 }) }), 'confirm A')
    const b = await svc.create({ threadId, proposal: mkProposal() }); must(b, 'create B')
    const gb = await svc.get(b.draft.id)
    must(await svc.discard(b.draft.id, { expected: gb.baseline.draft }), 'discard B')
    const d = await svc.create({ threadId, proposal: mkProposal() }); must(d, 'create D')
    const gd = await svc.get(d.draft.id)
    must(await svc.setStatus(d.draft.id, { expected: gd.baseline.draft, status: 'generating' }), 'setStatus D')
    const raw = await new Promise((res, rej) => { const r = indexedDB.open('jxl-product'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const putRaw = (store, v) => new Promise((res, rej) => { const t = raw.transaction(store, 'readwrite'); t.objectStore(store).put(v); t.oncomplete = () => res(); t.onerror = () => rej(t.error) })
    await putRaw('assistant_drafts', {
      id: 'd-applied', record_version: 1, workspace_id: ws, thread_id: threadId,
      revision: 1, status: 'applied', revision_history: [],
      proposal: mkProposal(), planning_input: null, planning_result: null, fact_baseline: null,
      assumptions: [], user_confirmations: [conf({ confirmation_id: 'c-ap' })],
      excluded_items: [], source_refs: [],
      applied_summary: { application_id: 'app-1', counts: zeroCounts, id_map: [{ draft_key: 't-new', formal_id: 't-1', object_type: 'task' }], unscheduled_kept: [], applied_at: TS },
      created_at: TS, updated_at: TS,
    })
    await putRaw('assistant_ops', { application_id: 'app-1', workspace_id: ws, status: 'committed', counts: zeroCounts })
    raw.close()
    window.__ws = ws; window.__svc = svc; window.__db = db; window.__TS = TS
    window.__ids = { threadId, aId: a.draft.id, bId: b.draft.id, dId: d.draft.id, cId: 'd-applied' }
    return window.__ids
  }, { ws, name, TS })
}

try {
  // —— M：B1B-02 v3→v4 真实迁移（旧记录字段 + Blob SHA-256 不变，仅增 store/index）——
  {
    const { context, page } = await newScene('M')
    const m = await page.evaluate(async (TS) => {
      const { PNG_BYTES } = await import('/src/tests/backupFixtures.js')
      const ws = 'ws-migrate'
      const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('')
      const docs = [
        { id: 'n-m1', kind: 'note', workspace_id: ws, title: '迁移便签', source_id: 's-m1', status: 'reviewed', content_type: 'notice', fields: [], created_at: TS, updated_at: TS, reviewed_at: TS, is_demo: false },
        { id: 't-m1', kind: 'task', workspace_id: ws, title: '迁移任务', status: 'todo', deadline: { value: null, precision: 'none' }, created_at: TS, updated_at: TS, is_demo: false },
        { id: 'a-m1', kind: 'action', workspace_id: ws, task_id: 't-m1', text: '迁移行动', minutes: 30, done: false, created_at: TS },
        { id: 'p-m1', kind: 'plan_item', workspace_id: ws, task_id: 't-m1', date: '2026-11-24', planned_minutes: 30, action_text: '迁移', state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active' },
        { id: 'f-m1', kind: 'focus_session', workspace_id: ws, task_id: 't-m1', action_id: 'a-m1', plan_item_id: null, started_at: TS, accumulated_ms: 60000, running: false, draft_md: '旧草稿', outcome: 'partial', blocker: null, ended_at: '2026-11-24T10:30:00+08:00', is_demo: false, record_version: 1, timer_anchor_at: null, task_snapshot: { title: '迁移任务', matter_name: null, deadline_value: null, deadline_precision: 'none', captured_at: TS }, action_snapshot: { text: '迁移行动', minutes: 30, captured_at: TS }, task_ref_state: 'active', action_ref_state: 'active' },
      ]
      const runtime = [{ id: `run:${ws}`, workspace_id: ws, kind: 'run', session_id: null }, { id: `ops:${ws}`, workspace_id: ws, kind: 'ops' }]
      const db3 = await new Promise((res, rej) => {
        const r = indexedDB.open('jxl-product', 3)
        r.onupgradeneeded = () => { const d = r.result; for (const s of ['sources', 'docs', 'workspaces', 'focus_runtime']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }) }
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
      })
      const put = (s, v) => new Promise((res, rej) => { const t = db3.transaction(s, 'readwrite'); t.objectStore(s).put(v); t.oncomplete = () => res(); t.onerror = () => rej(t.error) })
      await put('workspaces', { id: ws, name: '虚构迁移空间', is_demo: false })
      await put('sources', { id: 's-m1', workspace_id: ws, kind: 'image', captured_at: TS, blob: new Blob([PNG_BYTES], { type: 'image/png' }), name: '迁移.png', is_demo: false })
      for (const d of docs) await put('docs', d)
      for (const r of runtime) await put('focus_runtime', r)
      const hashBefore = await sha(PNG_BYTES)
      db3.close()
      // 生产 db.js（v4）首次操作触发真实升级事务
      const db = await import('/src/services/storage/db.js')
      db.configureWorkspace(ws)
      const afterDocs = (await db.allDocs()).records
      const afterSources = (await db.allSources()).records
      const hashAfter = await sha(await afterSources[0].blob.arrayBuffer())
      const raw = await new Promise((res, rej) => { const r = indexedDB.open('jxl-product'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const version = raw.version
      const stores = [...raw.objectStoreNames]
      const getAll = (s) => new Promise((res, rej) => { const q = raw.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
      const idx = {}
      for (const s of ['assistant_threads', 'assistant_drafts', 'assistant_ops']) idx[s] = [...raw.transaction(s, 'readonly').objectStore(s).indexNames]
      const th = await getAll('assistant_threads'); const dr = await getAll('assistant_drafts'); const op = await getAll('assistant_ops')
      const rtAfter = await getAll('focus_runtime')
      raw.close()
      const sortById = (arr) => JSON.stringify([...arr].sort((a, b) => (a.id < b.id ? -1 : 1)))
      return {
        version, stores, idx,
        docsUnchanged: sortById(afterDocs) === sortById(docs),
        blobHashBefore: hashBefore, blobHashAfter: hashAfter,
        sourceFieldsSame: afterSources[0].id === 's-m1' && afterSources[0].name === '迁移.png' && afterSources[0].captured_at === TS && afterSources[0].blob.type === 'image/png',
        runtimeUnchanged: sortById(rtAfter) === sortById(runtime),
        assistantEmpty: th.length === 0 && dr.length === 0 && op.length === 0,
      }
    }, TS)
    rec('B1B-02', 'v3→v4 后版本=4，旧 docs 逐字段不变', m.version === 4 && m.docsUnchanged, JSON.stringify({ version: m.version, docsUnchanged: m.docsUnchanged }))
    rec('B1B-02', '图片 Blob SHA-256 迁移前后一致', m.blobHashBefore === m.blobHashAfter && m.sourceFieldsSame, `${m.blobHashBefore} → ${m.blobHashAfter}`)
    rec('B1B-02', 'focus_runtime 旧记录不变；仅增 3 个助手 store 及索引且为空', m.runtimeUnchanged && m.assistantEmpty
      && m.stores.includes('assistant_threads') && m.stores.includes('assistant_drafts') && m.stores.includes('assistant_ops')
      && m.idx.assistant_threads.includes('by_workspace') && m.idx.assistant_drafts.includes('by_workspace') && m.idx.assistant_drafts.includes('by_thread') && m.idx.assistant_ops.includes('by_workspace'), JSON.stringify(m.idx))
    await context.close()
  }

  // —— U：B1B-03 升级阻塞/让位/重试 ——
  {
    const { context, page } = await newScene('U')
    const u = await page.evaluate(async () => {
      const ws = 'ws-blocked'
      const hold = await new Promise((res, rej) => {
        const r = indexedDB.open('jxl-product', 3)
        r.onupgradeneeded = () => { const d = r.result; for (const s of ['sources', 'docs', 'workspaces', 'focus_runtime']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }) }
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
      })
      await new Promise((res, rej) => { const t = hold.transaction('workspaces', 'readwrite'); t.objectStore('workspaces').put({ id: ws, name: '虚构阻塞空间', is_demo: false }); t.oncomplete = () => res(); t.onerror = () => rej(t.error) })
      const db = await import('/src/services/storage/db.js')
      db.configureWorkspace(ws)
      const t0 = performance.now()
      let blockedCode = null; let blockedMsg = null
      try { await db.allDocs() } catch (e) { blockedCode = e.code; blockedMsg = e.message }
      const elapsed = Math.round(performance.now() - t0)
      const verStill3 = (await indexedDB.databases()).find((d) => d.name === 'jxl-product').version
      hold.close() // 关闭占用标签后重试
      const retry = await db.allDocs()
      const ver4 = (await indexedDB.databases()).find((d) => d.name === 'jxl-product').version
      // 让位：db.js 的 v4 连接收到 versionchange 须主动 close；之后旧版本号打开须可解释失败，不误报成功
      let closes = 0
      const origClose = IDBDatabase.prototype.close
      IDBDatabase.prototype.close = function () { closes += 1; return origClose.call(this) }
      const v5 = await new Promise((res, rej) => { const r = indexedDB.open('jxl-product', 5); r.onupgradeneeded = () => {}; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      v5.close()
      IDBDatabase.prototype.close = origClose
      let yieldErr = null
      try { await db.allDocs() } catch (e) { yieldErr = e.name }
      return { blockedCode, blockedMsg, elapsed, verStill3, retryOk: Array.isArray(retry.records), ver4, closes, yieldErr }
    })
    rec('B1B-03', '旧标签占用 → DB_UPGRADE_BLOCKED 可解释错误，不无限等待，版本仍 3', u.blockedCode === 'DB_UPGRADE_BLOCKED' && u.elapsed < 5000 && u.verStill3 === 3, JSON.stringify({ code: u.blockedCode, msg: u.blockedMsg, elapsed: u.elapsed, ver: u.verStill3 }))
    rec('B1B-03', '关闭占用后重试成功升级到 v4', u.retryOk && u.ver4 === 4, JSON.stringify({ retryOk: u.retryOk, ver: u.ver4 }))
    rec('B1B-03', 'versionchange 让位：旧连接主动 close；此后按旧版本打开报 VersionError 不误报成功', u.closes >= 1 && u.yieldErr === 'VersionError', JSON.stringify({ closes: u.closes, yieldErr: u.yieldErr }))
    await context.close()
  }

  // —— C：B1B-06 两个标签同 revision 并发确认/放弃/修改 ——
  {
    const { context, page: pageA } = await newScene('C')
    const ids = await seedWorkspace(pageA, 'ws-conc', '虚构并发空间')
    const pageB = await context.newPage()
    pageB.on('pageerror', (e) => rec('C', '页面JS错误', false, e.message))
    await pageB.goto(BASE + '__probe', { waitUntil: 'domcontentloaded' })
    await pageA.evaluate(async () => { const g = await window.__svc.get(window.__ids.aId); window.__baseA = g.baseline.draft })
    const b0 = await pageB.evaluate(async ({ ws, aId, TS }) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      db.configureWorkspace(ws)
      let n = 0
      window.__svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `conc-b-${++n}` })
      const g = await window.__svc.get(aId)
      window.__baseB = g.baseline.draft
      return { ok: g.ok, revision: g.baseline.draft.revision }
    }, { ws: 'ws-conc', aId: ids.aId, TS })
    const a1 = await pageA.evaluate(async (TS) => {
      const svc = window.__svc
      const e1 = await svc.edit(window.__ids.aId, { expected: window.__baseA, edits: { assumptions: [{ id: 'as9', text: 'A 页修改', related_keys: ['w1'] }] } })
      const c = await svc.confirm(window.__ids.aId, { expected: e1.draft, confirmation: { confirmation_id: 'cA', draft_revision: e1.draft.revision, object_type: 'gap', object_id_or_key: 'w1', field_path: '', old_value: null, new_value: null, confirmed_at: TS } })
      window.__baseA2 = c.draft
      return { editOk: e1.ok, rev: e1.draft.revision, confirmOk: c.ok }
    }, TS)
    const b1 = await pageB.evaluate(async ({ aId, TS }) => {
      const svc = window.__svc
      const conf = { confirmation_id: 'cB', draft_revision: window.__baseB.revision, object_type: 'gap', object_id_or_key: 'w1', field_path: '', old_value: null, new_value: null, confirmed_at: TS }
      const r1 = await svc.confirm(aId, { expected: window.__baseB, confirmation: conf })
      const r2 = await svc.discard(aId, { expected: window.__baseB })
      const r3 = await svc.edit(aId, { expected: window.__baseB, edits: { assumptions: [] } })
      return { confirmCode: r1.code, discardCode: r2.code, editCode: r3.code }
    }, { aId: ids.aId, TS })
    const b2 = await pageB.evaluate(async (aId) => {
      const g = await window.__svc.get(aId)
      const d = await window.__svc.discard(aId, { expected: g.baseline.draft })
      return { freshRevision: g.baseline.draft.revision, ok: d.ok, status: d.draft && d.draft.status }
    }, ids.aId)
    const a2 = await pageA.evaluate(async () => {
      const svc = window.__svc
      const r = await svc.edit(window.__ids.aId, { expected: window.__baseA2, edits: { assumptions: [{ id: 'asX', text: '复活尝试', related_keys: [] }] } })
      const g = await svc.get(window.__ids.aId)
      return { code: r.code, status: g.baseline.draft.status, confirmations: g.baseline.draft.user_confirmations.map((c) => c.confirmation_id), history: g.baseline.draft.revision_history.length }
    })
    rec('B1B-06', '两标签同读种子 rev2；A 页修改+确认成功 bump rev3', b0.ok && b0.revision === 2 && a1.editOk && a1.rev === 3 && a1.confirmOk, JSON.stringify({ b0, a1 }))
    rec('B1B-06', 'B 页陈旧基线的确认/放弃/修改全部 CONFLICT', b1.confirmCode === 'CONFLICT' && b1.discardCode === 'CONFLICT' && b1.editCode === 'CONFLICT', JSON.stringify(b1))
    rec('B1B-06', 'B 页重读最新后放弃成功；A 页陈旧写被拒不复活 discarded，确认不丢', b2.ok && b2.status === 'discarded' && a2.code === 'CONFLICT' && a2.status === 'discarded' && a2.confirmations.includes('c1') && a2.confirmations.includes('cA') && a2.history === 2, JSON.stringify({ b2, a2 }))
    await context.close()
  }

  // —— R：B1B-13/12/18/21 真实 ZIP 往返 + 失败注入零残留 + 幂等 ——
  {
    const { context, page } = await newScene('R')
    await seedWorkspace(page, 'ws-br', '虚构浏览器来源空间')
    const r1 = await page.evaluate(async () => {
      const db = window.__db
      const { buildBackup } = await import('/src/services/backup/export.js')
      const { inspectBackupFile, restorePreview } = await import('/src/services/backup/import.js')
      window.__snapBefore = JSON.stringify(await db.readWorkspaceSnapshot(window.__ws))
      const exp = await buildBackup(await db.readWorkspaceSnapshot(window.__ws), { backupId: 'bk-browser-0001', exportedAt: '2026-11-24T12:00:00+08:00', instant: new Date('2026-11-24T12:00:00+08:00') })
      window.__zipV2 = exp.zipBytes
      const ins = await inspectBackupFile(new File([exp.zipBytes], '虚构浏览器备份.zip', { type: 'application/zip' }))
      window.__insV2 = ins
      const pv = restorePreview(ins)
      return {
        format: exp.manifest.backup_format_version, schema: exp.manifest.schema_version,
        threads: exp.summary.assistantThreadCount, drafts: exp.summary.assistantDraftCount,
        paths: exp.entries.map((e) => e.path),
        insOk: ins.ok, insErrors: ins.errors,
        pvThreads: pv.assistantThreadCount, pvDrafts: pv.assistantDraftCount, pvStatus: pv.assistantDraftStatusCounts,
        pvTransform: pv.transforms.some((t) => t.includes('旧保存结果不能由本次备份恢复推定')),
      }
    })
    rec('B1B-13', '真实浏览器导出 v2/0.5.0：助手载荷齐全、无 ops 文件、检查通过', r1.format === 2 && r1.schema === '0.5.0' && r1.threads === 1 && r1.drafts === 4
      && r1.paths.includes('data/assistant_threads.json') && r1.paths.includes('data/assistant_drafts.json') && !r1.paths.some((p) => p.includes('assistant_ops'))
      && r1.insOk, JSON.stringify({ format: r1.format, schema: r1.schema, threads: r1.threads, drafts: r1.drafts, insOk: r1.insOk, errors: r1.insErrors }))
    rec('B1B-13', '预览：线程/草案计数 + 原状态分布 + 重新核对提示', r1.pvThreads === 1 && r1.pvDrafts === 4 && r1.pvStatus.editing === 1 && r1.pvStatus.discarded === 1 && r1.pvStatus.generating === 1 && r1.pvStatus.applied === 1 && r1.pvTransform, JSON.stringify(r1.pvStatus))

    const r2 = await page.evaluate(async ({ PAST_MS }) => {
      const db = window.__db
      const { prepareRestore } = await import('/src/services/backup/import.js')
      const { verifyCommittedRestore } = await import('/src/services/backup/restore.js')
      let c = 0
      const prep = prepareRestore({ inspected: window.__insV2, targetWorkspaceId: 'ws-restore-br', targetName: '浏览器恢复空间', operationId: 'op-br-1', nowMs: PAST_MS, createdAt: '2026-11-24T12:30:00+08:00', newId: () => `br-${++c}` })
      const result = await db.commitRestore(prep)
      const verify = await verifyCommittedRestore(prep)
      const t = await db.readWorkspaceSnapshot('ws-restore-br')
      const byOld = (oldId) => t.assistantDrafts.find((d) => d.id === prep.liveMap.get(oldId))
      const a = byOld(window.__ids.aId); const b = byOld(window.__ids.bId); const d = byOld(window.__ids.dId); const cp = byOld('d-applied')
      const th = t.assistantThreads[0]
      const ops = (await db.allAssistantOps()).records.filter((r) => r.workspace_id === 'ws-restore-br')
      const src = await db.readWorkspaceSnapshot(window.__ws)
      return {
        receiptThreads: result.receipt.assistant_thread_count, receiptDrafts: result.receipt.assistant_draft_count,
        verifyOk: verify.ok, problems: verify.problems,
        aStatus: a.status, aBaseline: a.fact_baseline, aConf: a.user_confirmations.length, aRev: a.revision, aHist: a.revision_history.length,
        bStatus: b.status, dStatus: d.status, cStatus: cp.status,
        cFormalRemapped: cp.applied_summary.id_map[0].formal_id === prep.liveMap.get('t-1'),
        threadMsg: th.messages[0].content, threadWs: th.workspace_id,
        targetOps: ops.length,
        planItemsSame: t.docs.filter((x) => x.kind === 'plan_item').length === src.docs.filter((x) => x.kind === 'plan_item').length,
        allNewIds: t.assistantDrafts.every((x) => x.workspace_id === 'ws-restore-br' && !x.id.startsWith('ws-br-id-') && x.id !== 'd-applied'),
      }
    }, { PAST_MS })
    rec('B1B-13', 'v2 恢复提交 + verifyCommittedRestore 实读核对通过', r2.receiptThreads === 1 && r2.receiptDrafts === 4 && r2.verifyOk, JSON.stringify({ receipt: [r2.receiptThreads, r2.receiptDrafts], problems: r2.problems }))
    rec('B1B-17', '恢复状态：未应用→needs_review 去授权；applied 只读保留且 formal_id 已映射；discarded 保持', r2.aStatus === 'needs_review' && r2.aBaseline === null && r2.aConf === 0 && r2.aRev === 2 && r2.aHist === 1
      && r2.bStatus === 'discarded' && r2.dStatus === 'needs_review' && r2.cStatus === 'applied' && r2.cFormalRemapped, JSON.stringify({ a: r2.aStatus, b: r2.bStatus, d: r2.dStatus, c: r2.cStatus, cFormalRemapped: r2.cFormalRemapped }))
    rec('B1B-21', '目标 0 ops、0 新 PlanItem；正文/归属正确；原空间不变', r2.targetOps === 0 && r2.planItemsSame && r2.threadMsg === '原文提到 t-1 与 s-1，不是引用' && r2.threadWs === 'ws-restore-br' && r2.allNewIds, JSON.stringify({ ops: r2.targetOps, planItemsSame: r2.planItemsSame }))

    const r3 = await page.evaluate(async ({ PAST_MS }) => {
      const db = window.__db
      const { buildBackup } = await import('/src/services/backup/export.js')
      const { inspectBackupFile, prepareRestore } = await import('/src/services/backup/import.js')
      const { verifyCommittedRestore } = await import('/src/services/backup/restore.js')
      const { buildCompleteBackup } = await import('/src/tests/backupFixtures.js')
      const { packArchive } = await import('/src/services/backup/zip.js')
      const mkPrep = (ins, target, op, prefix) => { let c = 0; return prepareRestore({ inspected: ins, targetWorkspaceId: target, targetName: '恢复空间', operationId: op, nowMs: PAST_MS, createdAt: '2026-11-24T12:30:00+08:00', newId: () => `${prefix}-${++c}` }) }
      // 空 v2
      await db.putWorkspace({ id: 'ws-empty-br', name: '虚构空空间', is_demo: false })
      const expE = await buildBackup(await db.readWorkspaceSnapshot('ws-empty-br'), { backupId: 'bk-empty-br', exportedAt: '2026-11-24T12:00:00+08:00', instant: new Date('2026-11-24T12:00:00+08:00') })
      const insE = await inspectBackupFile(new File([expE.zipBytes], '空.zip', { type: 'application/zip' }))
      const prepE = mkPrep(insE, 'ws-restore-empty', 'op-empty', 'be')
      const resE = await db.commitRestore(prepE)
      const verE = await verifyCommittedRestore(prepE)
      // v1 旧包（含旧 Focus 形态）
      const v1 = await buildCompleteBackup()
      const insV1 = await inspectBackupFile(new File([packArchive(v1.entries)], 'v1.zip', { type: 'application/zip' }))
      const prepV1 = mkPrep(insV1, 'ws-restore-v1', 'op-v1', 'v1')
      const resV1 = await db.commitRestore(prepV1)
      const verV1 = await verifyCommittedRestore(prepV1)
      const tV1 = await db.readWorkspaceSnapshot('ws-restore-v1')
      return {
        emptyInsOk: insE.ok, emptyThreads: resE.receipt.assistant_thread_count, emptyDrafts: resE.receipt.assistant_draft_count, emptyVerify: verE.ok, emptyProblems: verE.problems,
        v1InsOk: insV1.ok, v1Threads: resV1.receipt.assistant_thread_count, v1Drafts: resV1.receipt.assistant_draft_count, v1Verify: verV1.ok, v1Problems: verV1.problems,
        v1AssistantsEmpty: tV1.assistantThreads.length === 0 && tV1.assistantDrafts.length === 0,
        v1FocusPaused: tV1.docs.filter((x) => x.kind === 'focus_session' && x.ended_at == null).every((x) => x.running === false),
      }
    }, { PAST_MS })
    rec('B1B-13', '空 v2 往返：检查/提交/实读核对通过，助手计数 0', r3.emptyInsOk && r3.emptyThreads === 0 && r3.emptyDrafts === 0 && r3.emptyVerify, JSON.stringify(r3.emptyProblems))
    rec('B1B-12', 'v1 旧包继续可恢复：助手为空、旧 Focus 暂停语义保留、实读核对通过', r3.v1InsOk && r3.v1Threads === 0 && r3.v1Drafts === 0 && r3.v1Verify && r3.v1AssistantsEmpty && r3.v1FocusPaused, JSON.stringify(r3.v1Problems))

    const r4 = await page.evaluate(async ({ PAST_MS }) => {
      const db = window.__db
      const { prepareRestore } = await import('/src/services/backup/import.js')
      const { verifyCommittedRestore } = await import('/src/services/backup/restore.js')
      let c = 0
      const prep = prepareRestore({ inspected: window.__insV2, targetWorkspaceId: 'ws-restore-fail', targetName: '失败注入空间', operationId: 'op-br-fail', nowMs: PAST_MS, createdAt: '2026-11-24T12:30:00+08:00', newId: () => `bf-${++c}` })
      const origAdd = IDBObjectStore.prototype.add
      IDBObjectStore.prototype.add = function (v, ...rest) {
        if (this.name === 'assistant_drafts') { const e = new Error('注入 assistant_drafts 写入失败'); e.name = 'ConstraintError'; throw e }
        return origAdd.call(this, v, ...rest)
      }
      let failCode = null
      try { await db.commitRestore(prep) } catch (e) { failCode = e.code || e.name }
      IDBObjectStore.prototype.add = origAdd
      const raw = await new Promise((res, rej) => { const r = indexedDB.open('jxl-product'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const getAll = (s) => new Promise((res, rej) => { const q = raw.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
      const residue = {}
      for (const s of ['sources', 'docs', 'focus_runtime', 'assistant_threads', 'assistant_drafts', 'assistant_ops']) residue[s] = (await getAll(s)).filter((r) => r.workspace_id === 'ws-restore-fail').length
      residue.workspaces = (await getAll('workspaces')).filter((w) => w.id === 'ws-restore-fail').length
      raw.close()
      const retry = await db.commitRestore(prep)
      const verify = await verifyCommittedRestore(prep)
      const again = await db.commitRestore(prep)
      const after = JSON.stringify(await db.readWorkspaceSnapshot(window.__ws))
      const opsSrc = (await db.allAssistantOps()).records.filter((r) => r.workspace_id === window.__ws)
      return {
        failCode, residue, retryOk: verify.ok, problems: verify.problems,
        sameCommittedAt: again.receipt.committed_at === retry.receipt.committed_at,
        sourceUnchanged: after === window.__snapBefore,
        sourceOpsIntact: opsSrc.length === 1 && opsSrc[0].application_id === 'app-1',
      }
    }, { PAST_MS })
    const zeroResidue = Object.values(r4.residue).every((n) => n === 0)
    rec('B1B-18', 'assistant_drafts 写入失败 → 六 store + 目录零半份残留', r4.failCode !== null && zeroResidue, JSON.stringify({ failCode: r4.failCode, residue: r4.residue }))
    rec('B1B-18', '修复后同意图重试成功且实读核对通过；原空间逐字段不变', r4.retryOk && r4.sourceUnchanged && r4.sourceOpsIntact, JSON.stringify(r4.problems))
    rec('B1B-19', '同意图再次重试返回原结果（committed_at 一致，不重复写入）', r4.sameCommittedAt, '')
    await context.close()
  }

  // —— O：B1B-20 断网刷新读取与编辑保存（真实 offline + 真实 reload，路由回放缓存）——
  {
    const { context, page, netHits } = await newScene('O', { cache: true })
    await seedWorkspace(page, 'ws-offline', '虚构断网空间')
    const o1 = await page.evaluate(async () => {
      const svc = window.__svc
      const g = await svc.get(window.__ids.aId)
      const e = await svc.edit(window.__ids.aId, { expected: g.baseline.draft, edits: { assumptions: [...g.baseline.draft.assumptions, { id: 'as-off', text: '断网前假设', related_keys: ['w1'] }] } })
      return { ok: e.ok, rev: e.draft.revision }
    })
    await context.setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const o2 = await page.evaluate(async (ws) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      db.configureWorkspace(ws)
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => '2026-11-24T11:00:00+08:00', newId: () => `off-${++n}` })
      const list = await svc.list()
      const draft = list.drafts.find((d) => d.status === 'editing')
      const g = await svc.get(draft.id)
      const readRev = g.baseline.draft.revision
      const hadAssumption = g.baseline.draft.assumptions.some((a) => a.id === 'as-off')
      const e = await svc.edit(draft.id, { expected: g.baseline.draft, edits: { assumptions: [...g.baseline.draft.assumptions, { id: 'as-off2', text: '断网中假设', related_keys: ['w1'] }] } })
      const g2 = await svc.get(draft.id)
      const msg = await svc.appendMessage(g.baseline.draft.thread_id, { message: { role: 'user', content: '断网消息' } })
      return { readRev, hadAssumption, editOk: e.ok, newRev: g2.baseline.draft.revision, offlineAssumption: g2.baseline.draft.assumptions.some((a) => a.id === 'as-off2'), msgOk: msg.ok }
    }, 'ws-offline')
    await context.setOffline(false)
    rec('B1B-20', '断网刷新后读取：草案 revision 与断网前编辑一致', o1.ok && o2.readRev === o1.rev && o2.hadAssumption, JSON.stringify({ before: o1, after: o2 }))
    rec('B1B-20', '断网中编辑保存/追加消息成功（本地草案功能正常）', o2.editOk && o2.newRev === o1.rev + 1 && o2.offlineAssumption && o2.msgOk, JSON.stringify(o2))
    rec('B1B-20', '全程零模型/后端请求', netHits.length === 0, JSON.stringify(netHits))
    await context.close()
  }

  // —— UI：DataPage 真实界面导出→下载→上传→预览→恢复（B1B-13 界面链路 + §10 小适配）——
  {
    const { context, page } = await newScene('UI')
    await seedWorkspace(page, 'ws-ui', '虚构界面空间')
    await page.evaluate(() => localStorage.setItem('jxl-workspace', 'ws-ui'))
    await page.goto(BASE + '#/data', { waitUntil: 'domcontentloaded' })
    await page.locator('text=从备份恢复').waitFor({ timeout: 30000 })
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('button:has-text("导出当前空间备份")').click(),
    ])
    await download.saveAs(join(OUT, 'ui-downloaded.zip'))
    await page.locator('text=备份已生成').waitFor({ timeout: 15000 })
    const exportSummary = await page.locator('text=助手线程 1 · 草案 4').count()
    await page.screenshot({ path: join(OUT, 'ui-export-summary.png') })
    rec('B1B-13', 'UI 导出：真实下载落盘 + 成功态显示助手线程 1 · 草案 4', exportSummary >= 1, `summaryHits=${exportSummary}`)
    await page.setInputFiles('input[type=file]', join(OUT, 'ui-downloaded.zip'))
    await page.locator('text=备份预览').waitFor({ timeout: 30000 })
    const pvCounts = await page.locator('text=1 · 4').count()
    const recheck = await page.locator('text=旧保存结果不能由本次备份恢复推定').count()
    const statusLine = await page.locator('text=草案原状态').count()
    await page.screenshot({ path: join(OUT, 'ui-restore-preview.png'), fullPage: true })
    rec('B1B-13', 'UI 预览：线程·草案计数 + 原状态分布 + 重新核对提示', pvCounts >= 1 && recheck >= 1 && statusLine >= 1, JSON.stringify({ pvCounts, recheck, statusLine }))
    await page.fill('#restore-name', '浏览器恢复验收')
    await page.locator('button:has-text("恢复到新空间")').click()
    await page.locator('text=恢复完成').waitFor({ timeout: 30000 })
    await page.screenshot({ path: join(OUT, 'ui-restore-done.png'), fullPage: true })
    const uiCheck = await page.evaluate(async () => {
      const db = await import('/src/services/storage/db.js')
      const ws = (await db.allWorkspaces()).find((w) => w.name === '浏览器恢复验收')
      if (!ws) return { found: false }
      const snap = await db.readWorkspaceSnapshot(ws.id)
      return { found: true, threads: snap.assistantThreads.length, drafts: snap.assistantDrafts.length, statuses: snap.assistantDrafts.map((d) => d.status).sort() }
    })
    rec('B1B-13', 'UI 恢复完成：新空间 1 线程 4 草案，状态 needs_review×2/applied/discarded', uiCheck.found && uiCheck.threads === 1 && uiCheck.drafts === 4
      && JSON.stringify(uiCheck.statuses) === JSON.stringify(['applied', 'discarded', 'needs_review', 'needs_review']), JSON.stringify(uiCheck))
    await context.close()
  }
} finally {
  const failed = results.filter((r) => !r.pass)
  writeFileSync(join(OUT, 'real-idb-1b-results.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, total: results.length, failed: failed.length, results }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} PASS`)
  await browser.close()
  vite.kill()
  process.exit(failed.length ? 1 : 0)
}
