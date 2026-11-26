// 5B-1C 综合验收真实浏览器 + 真实 IndexedDB 运行器（2026-11-24 首版；2026-11-25 R2 整改：C1 补场景/C2 完整内容断言/C3 真实展示截图）。
// 隔离：先探测端口占用→选空闲端口自起 Vite（独立 origin→独立 IDB），每场景独立 Context，全部虚构数据。
// 不触碰用户个人/演示空间与用户 8000 后端；拦截并拒绝模型/生产后端请求并报告实际命中。
// 验收展示页由本脚本经 context.route 在专用地址注入（非注册路由、不进生产构建），只调真实生产服务。
// 运行：node E:/qoder/devlog/private-evidence/stage5b-1/5B-1C/scripts/real-1c.mjs
// 漏检回归模式：MUTATE=action_text|restored_note|source_note|history_ref（注入真实DB损坏，验收必须FAIL非零退出）；
//   ONLY_MAIN=1 只跑 MAIN 场景（四个注入点均在 MAIN），其余场景记 skipped，不计 passed。
// 产出：run-2026-11-25 批次 results.json + screenshots/ + downloads/ + snapshots/；gates 副本进 remediation-r2/gates/。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const MUTATE = process.env.MUTATE || null
const ONLY_MAIN = process.env.ONLY_MAIN === '1'
const RUN = join('E:', 'qoder', 'output', 'playwright', 'review-5b1c-r2-2026-11-25', 'runs', MUTATE ? `run-2026-11-25-mutate-${MUTATE}` : 'run-2026-11-25')
const SHOTS = join(RUN, 'screenshots'); const DL = join(RUN, 'downloads'); const SNAPS = join(RUN, 'snapshots')
for (const d of [RUN, SHOTS, DL, SNAPS]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const FIXTURE = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'main-case.json'), 'utf8'))
const CLIENT = readFileSync(join(HERE, 'acceptance-client.js'), 'utf8')
const TS = '2026-11-24T10:00:00+08:00'
const PAST_MS = 1_700_000_000_000

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}
function skip(item, name) {
  results.push({ item, name, pass: null, skipped: true, detail: 'ONLY_MAIN 模式未执行（不计 passed）' })
  console.log(`SKIP [${item}] ${name}`)
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true })
// C3：截图前断言必要可见文本真实渲染（展开折叠详情后取 innerText），再落盘；截图后由人工/Read 实际查看。
async function shotAssert(page, name, texts, item) {
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true }))
  const body = await page.evaluate(() => document.body.innerText)
  const missing = texts.filter((t) => !body.includes(t))
  rec(item, `截图 ${name} 前可见文本断言`, missing.length === 0, JSON.stringify({ missing, expected: texts }))
  await shot(page, name)
}

// —— 端口探测：选空闲端口，不杀未知服务 ——
function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer()
    s.once('error', () => res(false))
    s.once('listening', () => s.close(() => res(true)))
    s.listen(port, '127.0.0.1')
  })
}
let PORT = null
for (const p of [5177, 5178, 5179, 5180, 5181]) { if (await portFree(p)) { PORT = p; break } }
if (PORT == null) { console.error('无空闲端口（5177–5181 均占用），显式退出，不杀未知服务'); process.exit(2) }
const BASE = `http://127.0.0.1:${PORT}/`

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: 'E:/qoder/frontend', stdio: ['ignore', 'pipe', 'pipe'] })
let viteLog = ''
vite.stdout.on('data', (d) => { viteLog += d }); vite.stderr.on('data', (d) => { viteLog += d })
const deadline = Date.now() + 45000
for (;;) {
  try { const r = await fetch(BASE); if (r.ok) break } catch {}
  if (Date.now() > deadline) { console.error(viteLog); vite.kill(); throw new Error('vite 未就绪') }
  await new Promise((r) => setTimeout(r, 300))
}
const browser = await chromium.launch({ executablePath: EXEC, headless: true })

const ACCEPT_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>5B-1C 验收展示</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#faf7f2;color:#222}
#app{max-width:960px;margin:0 auto;padding:16px}
.banner{background:#2d6a4f;color:#fff;padding:10px 14px;border-radius:8px;font-weight:600;margin-bottom:12px}
.card{background:#fff;border:1px solid #e5ded2;border-radius:8px;padding:12px 14px;margin-bottom:12px}
h2{font-size:15px;margin:0 0 8px}
.tag,.kv,.seg,.totals,.gap,.deadline,.blockers{font-size:13px;margin:3px 0}
.deadline{color:#9d0208;font-weight:600}
.gap{color:#bc4749}.totals{font-weight:600}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border:1px solid #e5ded2;padding:3px 6px;text-align:center}
button{margin:3px;padding:6px 10px;border-radius:6px;border:1px solid #2d6a4f;background:#fff;cursor:pointer;font-size:13px}
a{display:inline-block;margin:3px;font-size:13px}
pre{white-space:pre-wrap;font-size:11px;background:#f6f2ea;padding:6px;border-radius:6px}
</style></head><body><div id="app"></div><script type="module" src="/__accept-client.js"></script></body></html>`

async function newScene(name, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}) })
  const netHits = []
  const blocked = []
  context.on('request', (r) => { const u = r.url(); if (/:8000|:8020|\/analyze/.test(u)) netHits.push(u) })
  // 拦截并拒绝模型/生产后端请求（仅匹配后端 URL，不拦截 blob: 下载与同源资源）。
  await context.route(/:8000|:8020|\/analyze/, (route) => { blocked.push(route.request().url()); return route.abort() })
  if (opts.cache) {
    await context.route('**/*', async (route) => {
      const u = route.request().url()
      if (/:8000|:8020|\/analyze/.test(u)) { blocked.push(u); return route.abort() }
      const hit = opts.cache.get(u)
      if (hit) return route.fulfill({ status: hit.status, headers: hit.headers, body: hit.body })
      try {
        const headers = { ...route.request().headers() }; delete headers['if-none-match']; delete headers['if-modified-since']
        const resp = await route.fetch({ headers }); const body = await resp.body()
        if (resp.status() === 200) opts.cache.set(u, { status: 200, headers: resp.headers(), body })
        return route.fulfill({ status: resp.status(), headers: resp.headers(), body })
      } catch { return route.abort() }
    })
  }
  await context.route(BASE + '__accept', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: ACCEPT_HTML }))
  await context.route(BASE + '__accept-client.js', (route) => route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: CLIENT }))
  await context.route(BASE + '__probe', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>1C probe</title>1C isolated probe' }))
  const page = await context.newPage()
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, e.message))
  return { context, page, netHits, blocked }
}

async function openAccept(page, ws, name, fixture = FIXTURE, ts = TS) {
  await page.goto(BASE + '__accept', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__A && window.__A.init)
  return page.evaluate(async (arg) => window.__A.init(arg), { ws, name, fixture, TS: ts })
}
const A = (page, fn, ...args) => page.evaluate(async ({ fn, args }) => window.__A.actions[fn](...args), { fn, args })

// 与 acceptance-client snapshotBusiness 同口径的完整业务快照，但可在任意页面（如 #/data，无 window.__A）使用。
const snapDb = (page, ws) => page.evaluate(async (wsId) => {
  const db = await import('/src/services/storage/db.js')
  const snap = await db.readWorkspaceSnapshot(wsId)
  const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const sources = []
  for (const s of snap.sources) {
    const { blob, ...fields } = s
    sources.push({ ...fields, blobSha: await sha(await blob.arrayBuffer()), blobSize: blob.size, blobType: blob.type })
  }
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const ops = (await db.allAssistantOps()).records.filter((o) => o.workspace_id === wsId)
  return {
    sources: sources.sort(byId),
    docs: snap.docs.map((d) => ({ ...d })).sort(byId),
    opsCount: ops.length,
    threads: snap.assistantThreads.map((t) => ({ ...t })).sort(byId),
    drafts: snap.assistantDrafts.map((d) => ({ ...d })).sort(byId),
    workspace: snap.workspace ? { ...snap.workspace } : null,
  }
}, ws)

try {
  // ===== MAIN：B1C-01/02/03/04/05/06/16（副作用）=====
  {
    const { context, page, netHits } = await newScene('MAIN')
    const ids = await openAccept(page, 'ws-1c-main', '虚构主案例空间')
    const before = await A(page, 'snapshotBusiness')
    writeFileSync(join(SNAPS, 'main-business-before.json'), JSON.stringify(before, null, 2))
    await shot(page, '01-fixed-input.png')

    await A(page, 'confirmRound1')
    const r1 = await A(page, 'reschedule')
    const hc1 = FIXTURE.hand_calc.round1
    const daysMatch1 = hc1.days && r1.days.every((d) => {
      const e = hc1.days[d.date]
      return e && d.budget_minutes === e.budget && d.committed_minutes === e.committed && d.allocated_minutes === e.scheduled && d.free_minutes === Math.max(0, e.free - e.scheduled)
    })
    rec('B1C-01', 'round1 真实排程 总排133/未排67，complete=false', r1.ok && r1.totalScheduled === 133 && r1.unscheduled === 67 && r1.complete === false, JSON.stringify({ total: r1.totalScheduled, unsched: r1.unscheduled, complete: r1.complete }))
    rec('B1C-01', 'buffer15%+未选中20占用计入；逐日预算/占用/新增/剩余与手算一致', daysMatch1 && JSON.stringify(r1.segments) === JSON.stringify(hc1.segments), JSON.stringify({ daysMatch1, segments: r1.segments }))
    await shot(page, '02-gap-133-67.png')

    const g1 = await page.evaluate(async () => { const v = await window.__A.refreshView(); return { ready: v.readiness.ready, blockers: v.readiness.blockers.map((b) => b.code), status: v.draft.status, complete: v.draft.planning_result.complete } })
    rec('B1C-02', '未确认缺口阻断 ready（GAP_UNCONFIRMED），持久状态仍 editing', g1.ready === false && g1.blockers.includes('GAP_UNCONFIRMED') && g1.status === 'editing', JSON.stringify(g1))
    await A(page, 'confirmGap')
    const ready1 = await A(page, 'markReady')
    const g2 = await page.evaluate(async () => { const v = await window.__A.refreshView(); return { unsched: v.draft.planning_result.unscheduled.reduce((a, u) => a + u.remaining_minutes, 0), complete: v.draft.planning_result.complete } })
    rec('B1C-02', '当前版确认缺口后 ready=true 但 complete=false、未排仍67（R3）', ready1.ok && ready1.ready === true && ready1.complete === false && g2.unsched === 67 && g2.complete === false, JSON.stringify({ ready1, g2 }))

    const raise = await A(page, 'raiseBudget')
    rec('B1C-03', '确认预算90使旧计算失效：fact_baseline清空、ready阻断、revision不增、旧结果仍可读', raise.factBaselineNull && raise.ready === false && raise.blockers.includes('FACT_BASELINE_MISSING'), JSON.stringify(raise))
    const revBeforeR2 = raise.revision
    const r2 = await A(page, 'reschedule')
    const hc2 = FIXTURE.hand_calc.round2
    const daysMatch2 = r2.days.every((d) => { const e = hc2.days[d.date]; return e && d.budget_minutes === e.budget && d.committed_minutes === e.committed && d.allocated_minutes === e.scheduled })
    rec('B1C-03', '重排 round2 总排200/未排0，complete=true，逐日与手算一致', r2.ok && r2.totalScheduled === 200 && r2.unscheduled === 0 && r2.complete === true && daysMatch2 && JSON.stringify(r2.segments) === JSON.stringify(hc2.segments), JSON.stringify({ total: r2.totalScheduled, unsched: r2.unscheduled, segments: r2.segments }))
    const ready2 = await A(page, 'markReady')
    const hist = await page.evaluate(async () => { const v = await window.__A.refreshView(); const d = v.draft; return { rev: d.revision, histLen: d.revision_history.length, histReadable: d.revision_history.every((h) => h.proposal != null), oldGapConfStale: d.user_confirmations.some((c) => c.object_type === 'gap' && c.draft_revision < d.revision), currentGapConf: d.user_confirmations.some((c) => c.object_type === 'gap' && c.draft_revision === d.revision) } })
    rec('B1C-03', 'round2 ready=true；历史可读、旧版缺口确认不自动继承到当前版', ready2.ok && ready2.ready === true && hist.histReadable && hist.oldGapConfStale && !hist.currentGapConf, JSON.stringify({ ready2: ready2.ready, hist }))
    await shot(page, '03-budget-200-0.png')

    // B1C-04：不同核对时刻同输入重排不 bump
    const revBeforeNoChange = hist.rev
    await A(page, 'setTS', '2026-11-24T11:00:00+08:00')
    const rNo = await A(page, 'reschedule')
    rec('B1C-04', '仅时钟变化同输入重排不消耗 revision（R2）', rNo.ok && rNo.revision === revBeforeNoChange, JSON.stringify({ before: revBeforeNoChange, after: rNo.revision }))
    const preRefresh = await page.evaluate(async () => { const v = await window.__A.refreshView(); const d = v.draft; return { rev: d.revision, status: d.status, histLen: d.revision_history.length, ready: v.readiness.ready, segments: d.planning_result.segments.map((s) => [s.segment_key, s.date, s.minutes]), total: d.planning_result.segments.reduce((a, s) => a + s.minutes, 0) } })
    // 硬刷新（真实 reload，非哈希路由）：从 IDB 重建服务读同一草案
    await page.reload({ waitUntil: 'domcontentloaded' })
    const postRefresh = await page.evaluate(async ({ ws, draftId }) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      db.configureWorkspace(ws)
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => '2026-11-24T12:00:00+08:00', newId: () => `refresh-${++n}` })
      const g = await svc.get(draftId)
      const d = g.draft
      return { ok: g.ok, rev: d.revision, status: d.status, histLen: d.revision_history.length, ready: g.readiness.ready, segments: d.planning_result.segments.map((s) => [s.segment_key, s.date, s.minutes]), total: d.planning_result.segments.reduce((a, s) => a + s.minutes, 0) }
    }, { ws: 'ws-1c-main', draftId: ids.draftId })
    rec('B1C-04', '硬刷新后从IDB重建读取：revision/状态/历史/可用性/分段逐项一致', postRefresh.ok && postRefresh.rev === preRefresh.rev && postRefresh.status === preRefresh.status && postRefresh.histLen === preRefresh.histLen && postRefresh.ready === preRefresh.ready && JSON.stringify(postRefresh.segments) === JSON.stringify(preRefresh.segments), JSON.stringify({ preRefresh, postRefresh }))
    // C3：硬刷新后把展示页真实绑定到既有草案（bindExisting 只读 IDB，不播种重建），再断言可见文本并截图。
    await page.waitForFunction(() => window.__A && window.__A.bindExisting)
    const bound = await page.evaluate(async (arg) => window.__A.bindExisting(arg), { ws: 'ws-1c-main', draftId: ids.draftId, name: '虚构主案例空间', TS: '2026-11-24T12:00:00+08:00', fixture: FIXTURE })
    rec('B1C-04', '刷新后展示页真实绑定既有草案（非 init 重建）：revision/状态与IDB读回一致', bound.revision === postRefresh.rev && bound.status === postRefresh.status && bound.ready === postRefresh.ready, JSON.stringify(bound))
    await shotAssert(page, '04-refresh-read.png', ['草案信息', `revision（内容版本）：${postRefresh.rev}`, '草案分段', '已排合计 200 分'], 'B1C-04')

    // C2 漏检回归注入点①：主链路结束、业务不变比较之前，真实 putDoc 改坏行动正文（独立虚构库）。
    if (MUTATE === 'action_text') {
      await page.evaluate(async () => {
        const db = window.__A.state.db
        const snap = await db.readWorkspaceSnapshot(window.__A.state.ws)
        const a = snap.docs.find((d) => d.id === 'a-course')
        await db.putDoc({ ...a, text: 'MUTATED_ACTION_TEXT' })
        const check = await db.readWorkspaceSnapshot(window.__A.state.ws)
        if (!check.docs.some((d) => d.text === 'MUTATED_ACTION_TEXT')) throw new Error('注入未生效')
      })
      console.log('MUTATE action_text: Action.text 已改坏并实读确认')
    }
    // B1C-16 副作用：主链路后业务对象不变（仅助手线程/草案变化）——C2：docs 全字段原样比较，不做字段投影。
    const after = await A(page, 'snapshotBusiness', 'ws-1c-main')
    writeFileSync(join(SNAPS, 'main-business-after.json'), JSON.stringify(after, null, 2))
    const canon = (v) => JSON.stringify(v)
    rec('B1C-16', '主链路前后业务 docs 全字段（含正文/分钟/便签字段/描述）+sources 全字段+图片SHA一致、ops不增', canon(before.docs) === canon(after.docs) && canon(before.sources) === canon(after.sources) && before.opsCount === after.opsCount && after.opsCount === 0, JSON.stringify({ opsBefore: before.opsCount, opsAfter: after.opsCount, docsBefore: before.docs.length, docsAfter: after.docs.length, draftsBefore: before.drafts.length, draftsAfter: after.drafts.length }))
    rec('B1C-16', '主链路全程零模型/后端请求', netHits.length === 0, JSON.stringify(netHits))
    // C2：导出前冻结原空间完整快照——在 #/data 应用初始化完成后采集（见下）。
    // 进入 #/data 会触发生产幂等结构迁移 migratePlan（stores/app.js init→migrate）：
    // 缺席的 matter_id/matter_role 按迁移规则补 null。这是导出前的真实库状态，基线必须以它为准，
    // 否则把「迁移补字段」误判成「恢复改内容」。恢复本身对 docs 是逐字段恒等（remap 只重写类型化引用）。

    // ===== B1C-05：真实 DataPage 导出→下载→上传→预览→恢复新空间 =====
    const consoleMsgs = []
    page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`))
    await page.evaluate(() => localStorage.setItem('jxl-workspace', 'ws-1c-main'))
    await page.goto(BASE + '#/data', { waitUntil: 'domcontentloaded' })
    await page.locator('text=从备份恢复').waitFor({ timeout: 30000 })
    // 导出按钮 disabled=!store.ready：可点击即 init 的 await migrate()+reload() 已完成，库状态已稳定。
    const exportBtn = page.locator('button:has-text("导出当前空间备份")')
    await exportBtn.waitFor({ timeout: 30000 })
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('导出当前空间备份'))
      return b && !b.disabled
    }, { timeout: 30000 })
    const preExport = await snapDb(page, 'ws-1c-main')
    writeFileSync(join(SNAPS, 'main-business-pre-export.json'), JSON.stringify(preExport, null, 2))
    const wsActive = await page.evaluate(() => ({ ls: localStorage.getItem('jxl-workspace'), bodyHasWs: document.body.innerText.includes('虚构主案例空间') }))
    let download = null
    try {
      ;[download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.locator('button:has-text("导出当前空间备份")').click(),
      ])
    } catch (e) {
      const diag = await page.evaluate(() => document.body.innerText.slice(0, 1500))
      await shot(page, '05-export-FAILED.png')
      throw new Error(`导出下载未触发 wsActive=${JSON.stringify(wsActive)} console=${JSON.stringify(consoleMsgs.slice(-8))} body=${diag}`)
    }
    const zipPath = join(DL, 'main-case-downloaded.zip')
    await download.saveAs(zipPath)
    await page.locator('text=备份已生成').waitFor({ timeout: 15000 })
    await shot(page, '05-export-summary.png')
    const zipBytes = readFileSync(zipPath)
    rec('B1C-05', '真实 DataPage 下载落盘 ZIP（可检视字节>0）', zipBytes.length > 0, `bytes=${zipBytes.length}`)
    await page.setInputFiles('input[type=file]', zipPath)
    await page.locator('text=备份预览').waitFor({ timeout: 30000 })
    const recheck = await page.locator('text=旧保存结果不能由本次备份恢复推定').count()
    await shot(page, '06-restore-preview.png')
    rec('B1C-05', '上传后真实预览：重新核对提示可见', recheck >= 1, `recheckHits=${recheck}`)
    await page.fill('#restore-name', '虚构恢复验收空间')
    // C2：记录恢复期间真实生成的 UUID 序列（只观察，不改行为），用于重建准备阶段冻结的 ID 映射；
    // 重建结果必须与目录回执 id_map_signature（准备阶段冻结映射的规范化 JSON 签名）逐字符一致才采用。
    await page.evaluate(() => {
      window.__uuidSeq = []
      const orig = crypto.randomUUID.bind(crypto)
      crypto.randomUUID = () => { const u = orig(); window.__uuidSeq.push(u); return u }
    })
    await page.locator('button:has-text("恢复到新空间")').click()
    await page.locator('text=恢复完成').waitFor({ timeout: 30000 })
    await page.evaluate(() => { delete crypto.randomUUID })
    await shot(page, '07-restore-done.png')
    const restored = await page.evaluate(async () => {
      const db = await import('/src/services/storage/db.js')
      const { restoreJob } = await import('/src/services/backup/restore.js')
      const ws = (await db.allWorkspaces()).find((w) => w.name === '虚构恢复验收空间')
      if (!ws) return { found: false }
      const snap = await db.readWorkspaceSnapshot(ws.id)
      const src = await db.readWorkspaceSnapshot('ws-1c-main')
      const d = snap.assistantDrafts[0]
      return {
        found: true, wsId: ws.id, threads: snap.assistantThreads.length, drafts: snap.assistantDrafts.length,
        status: d.status, baselineNull: d.fact_baseline === null, confCleared: d.user_confirmations.length === 0,
        rev: d.revision, histLen: d.revision_history.length, proposalReadable: d.proposal != null, resultReadable: d.planning_result != null,
        newIds: snap.assistantDrafts.every((x) => x.workspace_id === ws.id && x.id !== 'ws-1c-main-id-2'),
        bizDocs: snap.docs.filter((x) => x.kind !== 'focus_session').length, srcDocs: src.docs.filter((x) => x.kind !== 'focus_session').length,
        planItems: snap.docs.filter((x) => x.kind === 'plan_item').length, srcPlanItems: src.docs.filter((x) => x.kind === 'plan_item').length,
        ops: (await db.allAssistantOps()).records.filter((o) => o.workspace_id === ws.id).length,
        verifyProblems: restoreJob.verifyProblems, verifyPhase: restoreJob.phase,
        receipt: ws.restore_receipt, uuidSeq: window.__uuidSeq,
      }
    })
    writeFileSync(join(SNAPS, 'restore-observation.json'), JSON.stringify(restored, null, 2))
    rec('B1C-05', '恢复到新空间：1线程1草案、业务对象复制、无新PlanItem/ops', restored.found && restored.threads === 1 && restored.drafts === 1 && restored.bizDocs === restored.srcDocs && restored.planItems === restored.srcPlanItems && restored.ops === 0, JSON.stringify({ wsId: restored.wsId, threads: restored.threads, drafts: restored.drafts, bizDocs: restored.bizDocs, planItems: restored.planItems, ops: restored.ops }))
    rec('B1C-05', '生产提交后核对 verifyCommittedRestore 真实运行且零问题（逐记录 canonical 内容/引用/状态/基线/确认/ops）', restored.verifyPhase === 'done' && Array.isArray(restored.verifyProblems) && restored.verifyProblems.length === 0, JSON.stringify(restored.verifyProblems))
    rec('B1C-06', '恢复后未应用草案 needs_review、fact_baseline清空、旧确认无执行效力、正文/历史/旧计算可读、新ID', restored.status === 'needs_review' && restored.baselineNull && restored.confCleared && restored.proposalReadable && restored.resultReadable && restored.newIds && restored.histLen >= 1, JSON.stringify({ status: restored.status, baselineNull: restored.baselineNull, confCleared: restored.confCleared, rev: restored.rev }))

    // C2：用真实回执签名验证重建的 ID 映射 == 准备阶段冻结映射（不匹配即断言失败，绝不猜测映射）。
    const mapInfo = await page.evaluate(async ({ orig }) => {
      const db = await import('/src/services/storage/db.js')
      const { DOC_KINDS } = await import('/src/services/backup/adapt.js')
      const { referencedIds } = await import('/src/services/backup/remap.js')
      const { assistantRefEntries } = await import('/src/domains/assistant/refs.js')
      const ws = (await db.allWorkspaces()).find((w) => w.name === '虚构恢复验收空间')
      const receipt = ws.restore_receipt
      const wsUuid = ws.id.startsWith('ws-restore-') ? ws.id.slice('ws-restore-'.length) : null
      const excluded = new Set([wsUuid, receipt.operation_id].filter(Boolean))
      const ids = (window.__uuidSeq || []).filter((u) => !excluded.has(u))
      // buildRemap 冻结顺序：live=sources→docs(DOC_KINDS)→threads→drafts（备份数组序=导出快照序）；
      // history=docs 引用→线程 formal 引用→草案 formal 引用（去重，跳过 live）。
      const liveKeys = [
        ...orig.sources.map((s) => s.id),
        ...orig.docs.filter((d) => DOC_KINDS.includes(d.kind)).map((d) => d.id),
        ...orig.threads.map((t) => t.id),
        ...orig.drafts.map((d) => d.id),
      ]
      const liveMap = new Map(); const historyMap = new Map()
      let i = 0
      for (const k of liveKeys) liveMap.set(k, ids[i++])
      const addHist = (id) => { if (typeof id === 'string' && id && !liveMap.has(id) && !historyMap.has(id)) historyMap.set(id, ids[i++]) }
      for (const d of orig.docs) if (DOC_KINDS.includes(d.kind)) referencedIds(d).forEach(addHist)
      const formalVals = (rec, type) => assistantRefEntries(rec, type).filter((e) => e.namespace === 'formal').map((e) => e.get()).filter((v) => typeof v === 'string' && v)
      for (const t of orig.threads) formalVals(t, 'thread').forEach(addHist)
      for (const d of orig.drafts) formalVals(d, 'draft').forEach(addHist)
      const sortEntries = (m) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      const sig = JSON.stringify({ live: sortEntries(liveMap), history: sortEntries(historyMap) })
      return { wsId: ws.id, signatureMatch: sig === receipt.id_map_signature, seqLen: (window.__uuidSeq || []).length, used: i, liveCount: liveKeys.length, live: [...liveMap.entries()], history: [...historyMap.entries()], sig, expectedSig: receipt.id_map_signature }
    }, { orig: preExport })
    writeFileSync(join(SNAPS, 'restore-id-map.json'), JSON.stringify(mapInfo, null, 2))
    rec('B1C-05', '恢复 ID 映射与准备阶段冻结签名逐字符一致（实际映射，非猜测）', mapInfo.signatureMatch && mapInfo.used === mapInfo.liveCount + mapInfo.history.length, JSON.stringify({ signatureMatch: mapInfo.signatureMatch, seqLen: mapInfo.seqLen, used: mapInfo.used, liveCount: mapInfo.liveCount, historyCount: mapInfo.history.length }))

    // C2 漏检回归注入点②③④：恢复完成、内容比较之前，真实改坏恢复空间便签/原空间便签/恢复草案历史引用。
    if (MUTATE === 'restored_note' || MUTATE === 'source_note') {
      const targetWs = MUTATE === 'restored_note' ? restored.wsId : 'ws-1c-main'
      await page.evaluate(async ({ wsId, live, useOriginalId }) => {
        const db = await import('/src/services/storage/db.js')
        db.configureWorkspace(wsId)
        // 恢复空间用映射后的新 ID；原空间对象仍是旧 ID。
        const noteId = useOriginalId ? 'n-course' : new Map(live).get('n-course')
        const snap = await db.readWorkspaceSnapshot(wsId)
        const n = snap.docs.find((d) => d.id === noteId)
        await db.putDoc({ ...n, title: 'MUTATED_NOTE_TITLE' })
        const check = await db.readWorkspaceSnapshot(wsId)
        if (!check.docs.some((d) => d.id === noteId && d.title === 'MUTATED_NOTE_TITLE')) throw new Error('注入未生效')
      }, { wsId: targetWs, live: mapInfo.live, useOriginalId: MUTATE === 'source_note' })
      console.log(`MUTATE ${MUTATE}: ${targetWs} Note.title 已改坏并实读确认`)
    }
    if (MUTATE === 'history_ref') {
      await page.evaluate(async ({ wsId, live }) => {
        const newDraftId = new Map(live).get('ws-1c-main-id-2')
        const raw = await new Promise((res, rej) => { const r = indexedDB.open('jxl-product'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
        const got = await new Promise((res, rej) => { const q = raw.transaction('assistant_drafts', 'readonly').objectStore('assistant_drafts').get(newDraftId); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
        got.revision_history[0].proposal.evidence_refs[0].source_id = 'MUTATED_HISTORY_REF'
        await new Promise((res, rej) => { const t = raw.transaction('assistant_drafts', 'readwrite'); t.objectStore('assistant_drafts').put(got); t.oncomplete = () => res(); t.onerror = () => rej(t.error) })
        const check = await new Promise((res, rej) => { const q = raw.transaction('assistant_drafts', 'readonly').objectStore('assistant_drafts').get(newDraftId); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
        raw.close()
        if (check.revision_history[0].proposal.evidence_refs[0].source_id !== 'MUTATED_HISTORY_REF') throw new Error('注入未生效')
      }, { wsId: restored.wsId, live: mapInfo.live })
      console.log('MUTATE history_ref: 恢复草案 revision_history 证据引用已改坏并实读确认')
    }

    // C2：恢复语义逐项核对——用已验证的实际映射，按类型比较业务内容/线程消息正文/proposal/planning input/result/
    // revision_history/引用；允许 ID/空间与协议规定的状态/授权变化；正文中的 ID 字符串保持原文（只重写类型化引用路径）。
    const semantic = await page.evaluate(async ({ wsId, live, history, orig }) => {
      const db = await import('/src/services/storage/db.js')
      const { canonicalJson, restoreDraftStatus } = await import('/src/domains/assistant/draft.js')
      const { refAccessors } = await import('/src/services/backup/remap.js')
      const { assistantRefEntries } = await import('/src/domains/assistant/refs.js')
      const { sourceContentVersion } = await import('/src/services/backup/format.js')
      const liveMap = new Map(live); const historyMap = new Map(history)
      const mapId = (id) => (id == null ? id : (liveMap.get(id) ?? historyMap.get(id) ?? id))
      const snap = await db.readWorkspaceSnapshot(wsId)
      const problems = []
      const docDiffs = []
      const checked = { sources: 0, docs: 0, threads: 0, drafts: 0 }
      const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('')
      // sources：除 blob/asset_path/content_version 外全字段相等；blob 实际字节 SHA/大小/类型一致；
      // content_version 按已批准本地规则=真实字节 SHA-256 重算（字节相同故与原值一致，仍按规则实算核对）。
      const srcById = new Map(snap.sources.map((s) => [s.id, s]))
      for (const os of orig.sources) {
        const r = srcById.get(liveMap.get(os.id))
        if (!r) { problems.push(`source ${os.id} 恢复后缺失`); continue }
        checked.sources++
        const { blobSha, blobSize, blobType, content_version: ocv, ...of } = os
        const expected = { ...of, id: liveMap.get(os.id), workspace_id: wsId, is_demo: false }
        const { blob, content_version, asset_path, ...rf } = r
        if (canonicalJson(expected) !== canonicalJson(rf)) problems.push(`source ${os.id} 业务字段不一致`)
        if (r.workspace_id !== wsId) problems.push(`source ${os.id} 归属不符`)
        const actualSha = await sha(await blob.arrayBuffer())
        if (actualSha !== blobSha || blob.size !== blobSize || blob.type !== blobType) problems.push(`source ${os.id} 图片字节SHA/大小/类型不一致`)
        const cv = await sourceContentVersion(r)
        if (cv !== content_version || cv !== blobSha) problems.push(`source ${os.id} content_version 未按真实字节重算`)
      }
      // docs：全字段原样（含 text/minutes/fields/description 等用户内容），仅 ID/空间/类型化引用路径按映射重写。
      const docById = new Map(snap.docs.map((d) => [d.id, d]))
      for (const od of orig.docs) {
        const r = docById.get(liveMap.get(od.id))
        if (!r) { problems.push(`doc ${od.id}(${od.kind}) 恢复后缺失`); continue }
        checked.docs++
        const expected = JSON.parse(JSON.stringify(od))
        expected.id = liveMap.get(od.id); expected.workspace_id = wsId
        if ('is_demo' in expected) expected.is_demo = false
        for (const a of refAccessors(expected)) {
          if (a.each) a.each((x) => mapId(x))
          else { const v = a.get(); if (v != null) a.set(mapId(v)) }
        }
        if (canonicalJson(expected) !== canonicalJson(r)) {
          const keys = [...new Set([...Object.keys(expected), ...Object.keys(r)])]
          const diff = keys.filter((k) => JSON.stringify(expected[k]) !== JSON.stringify(r[k]))
          problems.push(`doc ${od.id}(${od.kind}) 内容/引用不一致（全字段比较）字段:${diff.join(',')}`)
          docDiffs.push({ id: od.id, kind: od.kind, diff, expected: Object.fromEntries(diff.map((k) => [k, expected[k]])), actual: Object.fromEntries(diff.map((k) => [k, r[k]])) })
        }
      }
      // threads：消息正文/confirmed_requirements 全保留，formal 引用按映射重写。
      const thById = new Map(snap.assistantThreads.map((t) => [t.id, t]))
      for (const ot of orig.threads) {
        const r = thById.get(liveMap.get(ot.id))
        if (!r) { problems.push(`thread ${ot.id} 恢复后缺失`); continue }
        checked.threads++
        const expected = JSON.parse(JSON.stringify(ot))
        expected.id = liveMap.get(ot.id); expected.workspace_id = wsId
        for (const e of assistantRefEntries(expected, 'thread')) {
          if (e.namespace !== 'formal') continue
          const v = e.get(); if (v != null) e.set(mapId(v))
        }
        if (canonicalJson(expected) !== canonicalJson(r)) problems.push(`thread ${ot.id} 消息/要求/引用不一致（全字段比较）`)
      }
      // drafts：proposal/planning_input/planning_result/revision_history/assumptions 全保留并按映射重写 formal 引用；
      // 协议允许变化：status→恢复映射、fact_baseline→null、user_confirmations→[]（旧授权失效）。
      const drById = new Map(snap.assistantDrafts.map((d) => [d.id, d]))
      for (const od of orig.drafts) {
        const r = drById.get(liveMap.get(od.id))
        if (!r) { problems.push(`draft ${od.id} 恢复后缺失`); continue }
        checked.drafts++
        const expected = JSON.parse(JSON.stringify(od))
        expected.id = liveMap.get(od.id); expected.workspace_id = wsId
        for (const e of assistantRefEntries(expected, 'draft')) {
          if (e.namespace !== 'formal') continue
          const v = e.get(); if (v != null) e.set(mapId(v))
        }
        expected.status = restoreDraftStatus(od.status).restoredStatus
        expected.fact_baseline = null
        expected.user_confirmations = []
        if (canonicalJson(expected) !== canonicalJson(r)) problems.push(`draft ${od.id} proposal/计算/历史/引用不一致（全字段比较）`)
        if (r.revision !== od.revision) problems.push(`draft ${od.id} revision 被改动`)
        if (r.revision_history.length !== od.revision_history.length) problems.push(`draft ${od.id} 历史版本数被改动`)
      }
      return { problems, checked, docDiffs }
    }, { wsId: restored.wsId, live: mapInfo.live, history: mapInfo.history, orig: preExport })
    writeFileSync(join(SNAPS, 'restore-semantic-compare.json'), JSON.stringify(semantic, null, 2))
    rec('B1C-05', '恢复语义逐项核对：sources字节SHA+全字段、docs全字段、线程消息正文、草案proposal/计算/历史/引用（实际映射，声明对象全部遍历）', semantic.problems.length === 0 && semantic.checked.sources === preExport.sources.length && semantic.checked.docs === preExport.docs.length && semantic.checked.threads === preExport.threads.length && semantic.checked.drafts === preExport.drafts.length, JSON.stringify(semantic))

    // C2：原空间恢复前后完整快照比较（docs/sources/助手记录/目录全字段；恢复不得触碰原空间）。
    // 恢复完成后页面停在 DataPage（无验收客户端）：回到隔离展示页再取原空间完整快照。
    await page.goto(BASE + '__accept', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__A && window.__A.actions)
    const postRestoreSrc = await A(page, 'snapshotBusiness', 'ws-1c-main')
    writeFileSync(join(SNAPS, 'main-business-post-restore.json'), JSON.stringify(postRestoreSrc, null, 2))
    rec('B1C-05', '原空间恢复前后完整快照一致（docs全字段+sources字节SHA+线程/草案全字段+目录，非仅数量）', canon(preExport.docs) === canon(postRestoreSrc.docs) && canon(preExport.sources) === canon(postRestoreSrc.sources) && canon(preExport.threads) === canon(postRestoreSrc.threads) && canon(preExport.drafts) === canon(postRestoreSrc.drafts) && canon(preExport.workspace) === canon(postRestoreSrc.workspace) && preExport.opsCount === postRestoreSrc.opsCount, JSON.stringify({ docs: preExport.docs.length, threads: preExport.threads.length, drafts: preExport.drafts.length, ops: postRestoreSrc.opsCount }))

    // ===== B1C-06：恢复空间内用映射后业务对象真实重排+当前版确认+继续编辑+刷新 =====
    const continueEdit = await page.evaluate(async ({ wsId, TS }) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      db.configureWorkspace(wsId)
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => wsId, wallNow: () => TS, newId: () => `rest-${++n}` })
      const list = await svc.list()
      const draftId = list.drafts[0].id
      const threadId = list.drafts[0].thread_id
      const snap = await db.readWorkspaceSnapshot(wsId)
      const task = snap.docs.find((d) => d.kind === 'task' && d.title === '虚构课程报告')
      const g0 = await svc.get(draftId)
      const ctx = { timezone: 'Asia/Shanghai', today: '2026-11-24', start_date: '2026-11-24', horizon_days: 7, days: ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'].map((d) => ({ date: d, budget_minutes: null })) }
      const r = await svc.reschedule(draftId, { expected: g0.baseline.draft, context: ctx, options: { bufferPct: 15 } })
      if (!r.ok) return { stage: 'reschedule', ok: false, code: r.code, message: r.message }
      const g1 = await svc.get(draftId)
      const total = g1.draft.planning_result.segments.reduce((a, s) => a + s.minutes, 0)
      // 冻结边集：重排后为 editing，须 editing→generating→ready（不能 editing 直接→ready）。
      const gen = await svc.setStatus(draftId, { expected: g1.baseline.draft, status: 'generating' })
      const ready = gen.ok ? await svc.setStatus(draftId, { expected: gen.draft, status: 'ready' }) : gen
      const g2 = await svc.get(draftId)
      const edit = await svc.edit(draftId, { expected: g2.baseline.draft, edits: { assumptions: [{ id: 'rest-as', text: '恢复后继续编辑', related_keys: [] }] } })
      const g3 = await svc.get(draftId)
      // 映射核对：proposal 工作项 task_ref 指向恢复后真实 Task
      const refMapped = g3.draft.proposal.work_items[0].task_ref.id === task.id
      return { stage: 'done', ok: true, draftId, total, unsched: g1.draft.planning_result.unscheduled.length, readyOk: ready.ok, ready: g2.readiness.ready, editBumped: edit.bumped, editRev: g3.draft.revision, assumptionSaved: g3.draft.assumptions.some((a) => a.id === 'rest-as'), refMapped, mappedTaskId: task.id }
    }, { wsId: restored.wsId, TS: '2026-11-24T13:00:00+08:00' })
    rec('B1C-06', '恢复空间真实重排200/0+当前版就绪+继续编辑保存（映射后业务对象，引用已重映射）', continueEdit.ok && continueEdit.total === 200 && continueEdit.unsched === 0 && continueEdit.readyOk && continueEdit.editBumped && continueEdit.assumptionSaved && continueEdit.refMapped, JSON.stringify(continueEdit))
    // 刷新验证继续编辑不丢
    await page.evaluate((wsId) => localStorage.setItem('jxl-workspace', wsId), restored.wsId)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const persist = await page.evaluate(async (wsId) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      db.configureWorkspace(wsId)
      const svc = createAssistantDraftService({ getWorkspaceId: () => wsId, wallNow: () => '2026-11-24T14:00:00+08:00', newId: () => `p-${Math.random()}` })
      const list = await svc.list()
      const g = await svc.get(list.drafts[0].id)
      return { assumptionSaved: g.draft.assumptions.some((a) => a.id === 'rest-as'), rev: g.draft.revision }
    }, restored.wsId)
    rec('B1C-06', '恢复后继续编辑硬刷新不丢（真实IDB读回）', persist.assumptionSaved, JSON.stringify(persist))
    // C3：恢复空间重排/确认后继续编辑的真实展示画面（映射后空间 + 真实 revision + 假设正文）。
    await page.goto(BASE + '__accept', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__A && window.__A.bindExisting)
    const boundRestored = await page.evaluate(async (arg) => window.__A.bindExisting(arg), { ws: restored.wsId, draftId: continueEdit.draftId, name: '虚构恢复验收空间', TS: '2026-11-24T14:00:00+08:00' })
    rec('B1C-06', '恢复空间展示页真实绑定：revision 与继续编辑后一致', boundRestored.revision === continueEdit.editRev && boundRestored.ws === restored.wsId, JSON.stringify(boundRestored))
    await shotAssert(page, '10-restored-continue-edit.png', [restored.wsId, `revision（内容版本）：${continueEdit.editRev}`, '恢复后继续编辑', '已排合计 200 分'], 'B1C-06')
    await context.close()
  }

  // ===== B1C-07：截止决定↔计算绑定 R8/R10（三步闭环；C3：阻断当时绑定展示页真实截图）=====
  if (ONLY_MAIN) { skip('B1C-07', 'ONLY_MAIN 模式仅跑主链路') } else {
    const { context, page } = await newScene('DEADLINE')
    await page.goto(BASE + '__accept', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__A && window.__A.bindExisting)
    const dl = await page.evaluate(async (TS) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      const ws = 'ws-1c-deadline'
      db.configureWorkspace(ws)
      await db.putWorkspace({ id: ws, name: '虚构截止空间', is_demo: false })
      const { PNG_BYTES } = await import('/src/tests/backupFixtures.js')
      await db.putSource({ id: 's-dl', kind: 'image', captured_at: TS, blob: new Blob([PNG_BYTES], { type: 'image/png' }), name: '虚构截止.png' })
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `dl-${++n}` })
      const EV = { kind: 'source_excerpt', source_id: 's-dl', excerpt: '虚构片段' }
      const ctx = { timezone: 'Asia/Shanghai', today: '2026-11-24', start_date: '2026-11-24', horizon_days: 7, days: ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'].map((d) => ({ date: d, budget_minutes: null })) }
      const mkProposal = () => ({
        task_proposals: [{ op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [{ value: '2026-11-30', precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV] }], evidence_refs: [EV] }],
        action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60, basis: 'suggestion', evidence_refs: [] }],
        work_items: [{ key: 'w-new', task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' }, deliverable: '虚构交付', remaining_minutes: 60, estimate_origin: 'user', splittable: true, min_segment_minutes: 25, depends_on: [], priority: 'normal' }],
        requirement_candidates: [], evidence_refs: [], assumptions: [], warnings: [],
      })
      const conf = (rev, id, nv) => ({ confirmation_id: id, draft_revision: rev, object_type: 'task', id_scope: 'draft', object_id_or_key: 't-new', field_path: 'deadline', old_value: null, new_value: nv, confirmed_at: TS })
      const D = (v) => ({ value: v, precision: 'date' })
      // 建立：create→确认要求→确认初始截止@rev1→重排(rev2 采用初始值)
      async function setup(initial) {
        const c = await svc.create({ title: '截止绑定', proposal: mkProposal() })
        if (!c.ok) throw new Error(`DEADLINE create 失败: ${JSON.stringify(c)}`)
        const g = await svc.get(c.draft.id)
        await svc.confirmRequirement(c.thread.id, { expected: g.baseline.thread, requirement: { requirement_id: `req-${c.draft.id}`, version: 1, type: 'daily_budget', value: 120, strength: 'hard', confirmed_at: TS, evidence_refs: [] } })
        const g1 = await svc.get(c.draft.id)
        await svc.confirm(c.draft.id, { expected: g1.baseline.draft, confirmation: conf(g1.draft.revision, `init-${c.draft.id}`, D(initial)) })
        const g2 = await svc.get(c.draft.id)
        const r = await svc.reschedule(c.draft.id, { expected: g2.baseline.draft, context: ctx, options: { bufferPct: 15 } })
        if (!r.ok) throw new Error(`DEADLINE reschedule 失败: ${JSON.stringify(r)}`)
        return { id: c.draft.id, threadId: c.thread.id, reschedOk: r.ok, rev: r.draft.revision, computed: r.draft.planning_input.task_facts[0].deadline_value }
      }
      const commitReady = async (id) => {
        const g = await svc.get(id)
        const gen = await svc.setStatus(id, { expected: g.baseline.draft, status: 'generating' })
        if (!gen.ok) return { ok: false, code: gen.code }
        return svc.setStatus(id, { expected: gen.draft, status: 'ready' })
      }
      // A 一致：初始 11-30，当前版再确认 11-30 → 三步一致可就绪
      const a = await setup('2026-11-30')
      const ga = await svc.get(a.id)
      await svc.confirm(a.id, { expected: ga.baseline.draft, confirmation: conf(a.rev, `cur-${a.id}`, D('2026-11-30')) })
      const ga2 = await svc.get(a.id)
      const aReady = await commitReady(a.id)
      // B 改早截止 11-23：当前版确认与旧计算(11-30)不一致 → 阻断 + ready 提交被拒
      const b = await setup('2026-11-30')
      const gb = await svc.get(b.id)
      await svc.confirm(b.id, { expected: gb.baseline.draft, confirmation: conf(b.rev, `cur-${b.id}`, D('2026-11-23')) })
      const gb2 = await svc.get(b.id)
      const bReady = await commitReady(b.id)
      const bStatus = (await svc.get(b.id)).draft.status
      return {
        a: { computed: a.computed, ready: ga2.readiness.ready, commitOk: aReady.ok },
        b: { id: b.id, computed: b.computed, blockers: gb2.readiness.blockers.map((x) => x.code), commitCode: bReady.code, commitBlockers: (bReady.blockers || []).map((x) => x.code), statusAfter: bStatus },
      }
    }, TS)
    rec('B1C-07', '一致闭环：按11-30确认→计算采用11-30→当前版再确认→就绪成功', dl.a.computed === '2026-11-30' && dl.a.ready === true && dl.a.commitOk === true, JSON.stringify(dl.a))
    rec('B1C-07', '改确认11-23后旧计算(11-30)绑定不一致：DEADLINE_RECOMPUTE_REQUIRED + ready提交READY_BLOCKED，状态不被强改', dl.b.computed === '2026-11-30' && dl.b.blockers.includes('DEADLINE_RECOMPUTE_REQUIRED') && dl.b.commitCode === 'READY_BLOCKED' && dl.b.statusAfter !== 'ready', JSON.stringify(dl.b))
    // C3：阻断发生的当时，从真实 IDB 绑定该草案到展示页（非探针空白页），渲染真实决定/旧计算值/阻断码后再截图。
    const boundDl = await page.evaluate(async (arg) => window.__A.bindExisting(arg), { ws: 'ws-1c-deadline', draftId: dl.b.id, name: '虚构截止空间', TS })
    await page.evaluate((payload) => window.__A.log('readyCommitResult', payload), { ok: false, code: dl.b.commitCode, blockers: dl.b.commitBlockers })
    rec('B1C-07', '阻断当时展示页真实绑定：同一草案、持久状态与真实服务一致', boundDl.draftId === dl.b.id && boundDl.status === dl.b.statusAfter && boundDl.ready === false, JSON.stringify(boundDl))
    await shotAssert(page, '08-deadline-blocked.png', ['截止决定 vs 计算采用', 'DEADLINE_RECOMPUTE_REQUIRED', 'READY_BLOCKED', '2026-11-23', '2026-11-30'], 'B1C-07')
    // C 恢复闭环（新服务实例读同一真实 IDB）：初始 11-30→当前版确认 11-26（阻断）→重排采纳→当前版再确认→就绪
    const dc = await page.evaluate(async (TS) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      const ws = 'ws-1c-deadline'
      db.configureWorkspace(ws)
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `dl2-${++n}` })
      const EV = { kind: 'source_excerpt', source_id: 's-dl', excerpt: '虚构片段' }
      const ctx = { timezone: 'Asia/Shanghai', today: '2026-11-24', start_date: '2026-11-24', horizon_days: 7, days: ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'].map((d) => ({ date: d, budget_minutes: null })) }
      const proposal = {
        task_proposals: [{ op: 'create', key: 't-new', title: '虚构新目标', deadline_candidates: [{ value: '2026-11-30', precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV] }], evidence_refs: [EV] }],
        action_proposals: [{ op: 'create', key: 'a-new', task_ref: { kind: 'draft', key: 't-new' }, text: '虚构步骤', minutes: 60, basis: 'suggestion', evidence_refs: [] }],
        work_items: [{ key: 'w-new', task_ref: { kind: 'draft', key: 't-new' }, action_ref: { kind: 'draft', key: 'a-new' }, deliverable: '虚构交付', remaining_minutes: 60, estimate_origin: 'user', splittable: true, min_segment_minutes: 25, depends_on: [], priority: 'normal' }],
        requirement_candidates: [], evidence_refs: [], assumptions: [], warnings: [],
      }
      const conf = (rev, id, nv) => ({ confirmation_id: id, draft_revision: rev, object_type: 'task', id_scope: 'draft', object_id_or_key: 't-new', field_path: 'deadline', old_value: null, new_value: nv, confirmed_at: TS })
      const D = (v) => ({ value: v, precision: 'date' })
      const c = await svc.create({ title: '截止绑定C', proposal })
      if (!c.ok) throw new Error(`DEADLINE C create 失败: ${JSON.stringify(c)}`)
      const g = await svc.get(c.draft.id)
      await svc.confirmRequirement(c.thread.id, { expected: g.baseline.thread, requirement: { requirement_id: `req-${c.draft.id}`, version: 1, type: 'daily_budget', value: 120, strength: 'hard', confirmed_at: TS, evidence_refs: [] } })
      const g1 = await svc.get(c.draft.id)
      await svc.confirm(c.draft.id, { expected: g1.baseline.draft, confirmation: conf(g1.draft.revision, `init-${c.draft.id}`, D('2026-11-30')) })
      const g2 = await svc.get(c.draft.id)
      const r0 = await svc.reschedule(c.draft.id, { expected: g2.baseline.draft, context: ctx, options: { bufferPct: 15 } })
      if (!r0.ok) throw new Error(`DEADLINE C reschedule 失败: ${JSON.stringify(r0)}`)
      const gc = await svc.get(c.draft.id)
      await svc.confirm(c.draft.id, { expected: gc.baseline.draft, confirmation: conf(r0.draft.revision, `cur-${c.draft.id}`, D('2026-11-26')) })
      const gc2 = await svc.get(c.draft.id)
      const cBlocked = gc2.readiness.blockers.map((x) => x.code)
      const rc = await svc.reschedule(c.draft.id, { expected: gc2.baseline.draft, context: ctx, options: { bufferPct: 15 } })
      const gc3 = await svc.get(c.draft.id)
      await svc.confirm(c.draft.id, { expected: gc3.baseline.draft, confirmation: conf(rc.draft.revision, `new-${c.draft.id}`, D('2026-11-26')) })
      const gc4 = await svc.get(c.draft.id)
      const gen = await svc.setStatus(c.draft.id, { expected: gc4.baseline.draft, status: 'generating' })
      const cReady = gen.ok ? await svc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' }) : gen
      const formalTasks = (await db.readWorkspaceSnapshot(ws)).docs.filter((d) => d.kind === 'task')
      return { c: { blockedBefore: cBlocked, reschedOk: rc.ok, computed: rc.draft.planning_input.task_facts[0].deadline_value, readyAfter: gc4.readiness.ready, commitOk: cReady.ok }, formalTaskCount: formalTasks.length }
    }, TS)
    rec('B1C-07', '恢复闭环：改用可排日期11-26重排+当前版再确认→就绪成功；全程未预创建正式Task', dc.c.blockedBefore.includes('DEADLINE_RECOMPUTE_REQUIRED') && dc.c.reschedOk && dc.c.computed === '2026-11-26' && dc.c.readyAfter === true && dc.c.commitOk === true && dc.formalTaskCount === 0, JSON.stringify(dc))
    await context.close()
  }

  // ===== B1C-09：事实漂移+证据绑定（C1：草案计算后就绪后新增未选中占用 + 完成关联行动，get 与 ready 提交均检出具体码）=====
  if (ONLY_MAIN) { skip('B1C-09', 'ONLY_MAIN 模式仅跑主链路') } else {
    const { context, page } = await newScene('DRIFT')
    const ids = await openAccept(page, 'ws-1c-drift', '虚构漂移空间')
    await A(page, 'confirmRound1')
    await A(page, 'reschedule')
    await A(page, 'confirmGap')
    const readyOk = await A(page, 'markReady')
    // C1 补齐：草案已计算并就绪后，给未选中任务 t-other 新增窗口内占用（真实 putDoc + 实读确认生效）
    const occ = await page.evaluate(async () => {
      const db = window.__A.state.db
      const snap = await db.readWorkspaceSnapshot(window.__A.state.ws)
      const p = snap.docs.find((d) => d.id === 'p-other')
      await db.putDoc({ ...p, id: 'p-drift-new', planned_minutes: 30, order: 1, action_text: '虚构新增占用' })
      const check = await db.readWorkspaceSnapshot(window.__A.state.ws)
      if (!check.docs.some((d) => d.id === 'p-drift-new' && d.planned_minutes === 30)) throw new Error('新增占用写入未生效')
      const v = await window.__A.refreshView()
      return { ready: v.readiness.ready, blockers: v.readiness.blockers.map((b) => b.code), diffs: v.factFreshness.diffs.map((d) => d.code), status: v.draft.status }
    })
    const occCommit = await A(page, 'markReady')
    rec('B1C-09', '计算后就绪后新增未选中占用：get 检出 OCCUPANCY_ADDED、ready 提交 READY_BLOCKED，持久状态不被强改', readyOk.ok && readyOk.ready === true && occ.ready === false && occ.blockers.includes('OCCUPANCY_ADDED') && occ.diffs.includes('OCCUPANCY_ADDED') && occ.status === 'ready' && occCommit.ok === false && occCommit.code === 'READY_BLOCKED', JSON.stringify({ occ, occCommit: { ok: occCommit.ok, code: occCommit.code, blockers: occCommit.blockers } }))
    // 完成关联行动 a-course（done=true）→ get 检出具体 ACTION_DONE；从 generating 直接再提交 ready 仍被拒
    const drift = await page.evaluate(async () => {
      const S = window.__A.state
      const snap = await S.db.readWorkspaceSnapshot(S.ws)
      const a = snap.docs.find((d) => d.id === 'a-course')
      await S.db.putDoc({ ...a, done: true })
      const check = await S.db.readWorkspaceSnapshot(S.ws)
      if (!check.docs.some((d) => d.id === 'a-course' && d.done === true)) throw new Error('行动完成写入未生效')
      const v = await window.__A.refreshView()
      const g = await S.svc.get(S.ids.draftId)
      const commit = await S.svc.setStatus(S.ids.draftId, { expected: g.baseline.draft, status: 'ready' })
      const after = await window.__A.refreshView()
      return { ready: v.readiness.ready, blockers: v.readiness.blockers.map((b) => b.code), fresh: v.factFreshness.fresh, diffs: v.factFreshness.diffs.map((d) => d.code), commitCode: commit.code, statusAfter: after.draft.status }
    })
    rec('B1C-09', '完成关联行动后 get 检出 ACTION_DONE（具体码非仅计数）、ready 提交 READY_BLOCKED，状态不被强改', drift.ready === false && drift.blockers.includes('ACTION_DONE') && drift.diffs.includes('ACTION_DONE') && drift.commitCode === 'READY_BLOCKED' && drift.statusAfter !== 'ready', JSON.stringify(drift))
    await shotAssert(page, '09-fact-drift.png', ['OCCUPANCY_ADDED', 'ACTION_DONE'], 'B1C-09')
    await context.close()
  }

  // ===== B1C-10：北京跨午夜 + 宿主时区 =====
  if (ONLY_MAIN) { skip('B1C-10', 'ONLY_MAIN 模式仅跑主链路（跨午夜）') } else {
    const { context, page } = await newScene('MIDNIGHT')
    const ids = await openAccept(page, 'ws-1c-midnight', '虚构跨午夜空间', FIXTURE, '2026-11-24T23:59:00+08:00')
    await A(page, 'confirmRound1')
    const r = await A(page, 'reschedule')
    // 推进时钟到次日 00:01（不改事实/输入），旧窗口 start_date=11-24 早于新 today=11-25 → WINDOW_STALE 阻断
    const cross = await page.evaluate(async () => {
      window.__A.state.TS = '2026-11-25T00:01:00+08:00'
      const v = await window.__A.refreshView()
      return { ready: v.readiness.ready, blockers: v.readiness.blockers.map((b) => b.code), status: v.draft.status }
    })
    rec('B1C-10', '受控时钟23:59→00:01：旧窗口草案 WINDOW_STALE 阻断，不能直接就绪（须按新today重排）', r.ok && cross.ready === false && cross.blockers.includes('WINDOW_STALE'), JSON.stringify(cross))
    // 宿主时区无关：同一输入时刻在 America/Los_Angeles 宿主下规划语义不变（today 由北京日期显式注入）
    const tz = await page.evaluate(async () => {
      const { beijingDateStr } = await import('/src/domains/time.js')
      const instant = '2026-11-24T16:00:00Z' // 北京 11-25 00:00
      return { beijing: beijingDateStr(new Date(instant)), hostTZ: Intl.DateTimeFormat().resolvedOptions().timeZone }
    })
    rec('B1C-10', '北京日期由注入时刻显式计算，不随宿主时区漂移（16:00Z→北京11-25）', tz.beijing === '2026-11-25', JSON.stringify(tz))
    await context.close()
  }

  // ===== B1C-10（C1 补齐）：两个独立浏览器上下文真实 timezoneId 对照（不改宿主/系统时区）=====
  if (ONLY_MAIN) { skip('B1C-10', 'ONLY_MAIN 模式仅跑主链路（双时区对照）') } else {
    const zones = [
      { id: 'Asia/Shanghai', ws: 'ws-1c-tz-sh', label: '上海' },
      { id: 'America/Los_Angeles', ws: 'ws-1c-tz-la', label: '洛杉矶' },
    ]
    const runs = []
    for (const z of zones) {
      const { context, page } = await newScene('TZ-' + z.label, { timezoneId: z.id })
      await openAccept(page, z.ws, `虚构时区空间${z.label}`)
      await A(page, 'confirmRound1')
      const r = await A(page, 'reschedule')
      const info = await page.evaluate(async () => {
        const { beijingDateStr } = await import('/src/domains/time.js')
        const instant = new Date('2026-11-24T16:00:00Z')
        return { resolvedTZ: Intl.DateTimeFormat().resolvedOptions().timeZone, beijing: beijingDateStr(instant), localDate: instant.toLocaleDateString('sv-SE') }
      })
      runs.push({ zone: z.id, ...info, ok: r.ok, total: r.totalScheduled, unsched: r.unscheduled, complete: r.complete, segments: r.segments, days: r.days })
      // C3：时区对照结论必须可见于截图本体（解析时区/北京日期/当地日期/排程语义），不只留在 JSON。
      await page.evaluate((v) => {
        const c = document.createElement('section')
        c.className = 'card'
        c.innerHTML = `<h2>时区对照（本上下文真实解析）</h2><div class="kv">宿主解析时区: ${v.resolvedTZ}</div><div class="kv">同一时刻 2026-11-24T16:00:00Z → 北京日期 ${v.beijing} ｜ 当地日期 ${v.localDate}</div><div class="kv totals">排程语义: 已排合计 ${v.total} 分 · 未排 ${v.unsched} 分 · complete=${v.complete}</div>`
        document.getElementById('app').appendChild(c)
      }, { ...info, total: r.totalScheduled, unsched: r.unscheduled, complete: r.complete })
      await shotAssert(page, z.id === 'Asia/Shanghai' ? '11-tz-shanghai.png' : '12-tz-los-angeles.png', [info.resolvedTZ, `北京日期 ${info.beijing}`, `当地日期 ${info.localDate}`, `已排合计 ${r.totalScheduled} 分`], 'B1C-10')
      await context.close()
    }
    const [sh, la] = runs
    writeFileSync(join(SNAPS, 'tz-compare.json'), JSON.stringify(runs, null, 2))
    rec('B1C-10', '双独立上下文真实时区注入：实际解析时区分别为 Asia/Shanghai 与 America/Los_Angeles', sh.resolvedTZ === 'Asia/Shanghai' && la.resolvedTZ === 'America/Los_Angeles', JSON.stringify({ sh: sh.resolvedTZ, la: la.resolvedTZ }))
    rec('B1C-10', '同一输入时刻(16:00Z)双时区对照：北京日期均11-25、当地日期不同（11-25 vs 11-24），同夹具排程语义逐段/逐日一致', sh.beijing === '2026-11-25' && la.beijing === '2026-11-25' && sh.localDate === '2026-11-25' && la.localDate === '2026-11-24' && sh.ok && la.ok && sh.total === la.total && sh.unsched === la.unsched && sh.complete === la.complete && JSON.stringify(sh.segments) === JSON.stringify(la.segments) && JSON.stringify(sh.days) === JSON.stringify(la.days), JSON.stringify({ sh: { total: sh.total, segments: sh.segments }, la: { total: la.total, segments: la.segments } }))
  }

  // ===== B1C-11：双标签并发（真实共享 IDB）=====
  if (ONLY_MAIN) { skip('B1C-11', 'ONLY_MAIN 模式仅跑主链路（双标签并发）') } else {
    const { context, page: pageA } = await newScene('CONC')
    const ids = await openAccept(pageA, 'ws-1c-conc', '虚构并发空间')
    await A(pageA, 'confirmRound1')
    await A(pageA, 'reschedule')
    const pageB = await context.newPage()
    pageB.on('pageerror', (e) => rec('CONC', '页面JS错误', false, e.message))
    await pageB.goto(BASE + '__accept', { waitUntil: 'domcontentloaded' })
    await pageB.waitForFunction(() => window.__A)
    const b0 = await pageB.evaluate(async ({ ws, draftId, TS }) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      db.configureWorkspace(ws)
      let n = 0
      window.__svcB = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `conc-b-${++n}` })
      const g = await window.__svcB.get(draftId)
      window.__baseB = g.baseline.draft
      return { ok: g.ok, rev: g.draft.revision }
    }, { ws: 'ws-1c-conc', draftId: ids.draftId, TS })
    const a1 = await pageA.evaluate(async () => {
      const svc = window.__A.state.svc, ids = window.__A.state.ids
      const g = await svc.get(ids.draftId)
      const e = await svc.edit(ids.draftId, { expected: g.baseline.draft, edits: { assumptions: [{ id: 'asA', text: 'A页修改', related_keys: ['w-course'] }] } })
      window.__baseA = e.draft
      return { ok: e.ok, rev: e.draft.revision }
    })
    const b1 = await pageB.evaluate(async ({ draftId, TS }) => {
      const svc = window.__svcB
      const conf = { confirmation_id: 'cB', draft_revision: window.__baseB.revision, object_type: 'gap', object_id_or_key: 'w-course', field_path: '', old_value: null, new_value: null, confirmed_at: TS }
      const r1 = await svc.confirm(draftId, { expected: window.__baseB, confirmation: conf })
      const r2 = await svc.discard(draftId, { expected: window.__baseB })
      const r3 = await svc.edit(draftId, { expected: window.__baseB, edits: { assumptions: [] } })
      return { confirmCode: r1.code, discardCode: r2.code, editCode: r3.code }
    }, { draftId: ids.draftId, TS })
    const b2 = await pageB.evaluate(async (draftId) => {
      const g = await window.__svcB.get(draftId)
      const d = await window.__svcB.discard(draftId, { expected: g.baseline.draft })
      return { freshRev: g.draft.revision, ok: d.ok, status: d.draft && d.draft.status }
    }, ids.draftId)
    rec('B1C-11', '两标签同读；A页修改bump；B页陈旧基线确认/放弃/修改全CONFLICT', b0.ok && a1.ok && a1.rev > b0.rev && b1.confirmCode === 'CONFLICT' && b1.discardCode === 'CONFLICT' && b1.editCode === 'CONFLICT', JSON.stringify({ b0, a1, b1 }))
    rec('B1C-11', 'B页重读最新后放弃成功（真实共享IDB）', b2.ok && b2.status === 'discarded' && b2.freshRev === a1.rev, JSON.stringify(b2))
    await context.close()
  }

  // ===== B1C-11（C1 补齐）：真实浏览器在途提交前切空间（ready 提交的事务外重摘要真实异步点暂停）=====
  if (ONLY_MAIN) { skip('B1C-11', 'ONLY_MAIN 模式仅跑主链路（提交前切空间）') } else {
    const { context, page } = await newScene('SWITCH')
    const ids = await openAccept(page, 'ws-1c-sw-a', '虚构切换空间A')
    await A(page, 'confirmRound1')
    await A(page, 'reschedule')
    // 空间B：真实独立目录+业务对象（与A无共享记录）
    await page.evaluate(async (TS) => {
      const db = window.__A.state.db
      await db.putWorkspace({ id: 'ws-1c-sw-b', name: '虚构切换空间B', is_demo: false })
      db.configureWorkspace('ws-1c-sw-b')
      await db.putDoc({ id: 't-sw-b', kind: 'task', title: '空间B任务', status: 'todo', deadline: { value: null, precision: 'none' }, created_at: TS, updated_at: TS })
      db.configureWorkspace('ws-1c-sw-a')
    }, TS)
    // 先合法迁移 editing→generating（这是预期写入），再冻结两空间基线；
    // 之后在途的只有 ready 提交——它被拒绝后两空间必须与基线逐字段一致。
    const genStep = await page.evaluate(async ({ draftId, TS }) => {
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      window.__curWs = 'ws-1c-sw-a'
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => window.__curWs, wallNow: () => TS, newId: () => `sw-${++n}` })
      const g = await svc.get(draftId)
      const gen = await svc.setStatus(draftId, { expected: g.baseline.draft, status: 'generating' })
      if (!gen.ok) return { ok: false, code: gen.code }
      window.__swSvc = svc
      return { ok: true, revBefore: gen.draft.revision, statusBefore: gen.draft.status, expected: gen.draft }
    }, { draftId: ids.draftId, TS })
    if (!genStep.ok) throw new Error(`SWITCH generating 失败: ${JSON.stringify(genStep)}`)
    const snapA0 = await A(page, 'snapshotBusiness', 'ws-1c-sw-a')
    const snapB0 = await A(page, 'snapshotBusiness', 'ws-1c-sw-b')
    // 暂停点选在生产真实异步边界：setStatus(ready) 事务外证据重摘要（crypto.subtle.digest）。
    // 不在 IDB put/事务内暂停（活事务会因事件循环让出而自动提交，属注入伪影而非产品语义）。
    const armed = await page.evaluate(async ({ draftId, expected }) => {
      const svc = window.__swSvc
      const origDigest = SubtleCrypto.prototype.digest
      let release
      const gate = new Promise((res) => { release = res })
      window.__gateHit = false
      window.__digestCalls = 0
      SubtleCrypto.prototype.digest = async function (...args) {
        window.__digestCalls += 1
        if (!window.__gateHit) { window.__gateHit = true; await gate }
        return origDigest.apply(this, args)
      }
      window.__restoreDigest = () => { SubtleCrypto.prototype.digest = origDigest }
      window.__releaseGate = () => release()
      window.__pendingCommit = svc.setStatus(draftId, { expected, status: 'ready' })
      return { ok: true }
    }, { draftId: ids.draftId, expected: genStep.expected })
    if (!armed.ok) throw new Error(`SWITCH 准备失败: ${JSON.stringify(armed)}`)
    await page.waitForFunction(() => window.__gateHit === true, null, { timeout: 15000 })
    // 提交在途（重摘要暂停中）→ 真实切空间：服务读取的当前空间 + DB 世代同时切换
    const sw = await page.evaluate(async () => {
      const db = await import('/src/services/storage/db.js')
      window.__curWs = 'ws-1c-sw-b'
      db.configureWorkspace('ws-1c-sw-b')
      window.__releaseGate()
      const result = await window.__pendingCommit
      window.__restoreDigest()
      const gA = await (async () => {
        db.configureWorkspace('ws-1c-sw-a')
        const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
        const svcA = createAssistantDraftService({ getWorkspaceId: () => 'ws-1c-sw-a', wallNow: () => '2026-11-24T12:00:00+08:00', newId: () => 'sw-check' })
        const list = await svcA.list()
        const d = list.drafts[0]
        return { rev: d.revision, status: d.status }
      })()
      return { commit: { ok: result.ok, code: result.code, workspace_id: result.workspace_id }, digestCalls: window.__digestCalls, afterA: gA }
    })
    const snapA1 = await A(page, 'snapshotBusiness', 'ws-1c-sw-a')
    const snapB1 = await A(page, 'snapshotBusiness', 'ws-1c-sw-b')
    writeFileSync(join(SNAPS, 'switch-observation.json'), JSON.stringify({ armed, sw }, null, 2))
    rec('B1C-11', '在途 ready 提交于真实重摘要异步点暂停后切空间：提交被拒绝（NOT_FOUND/WORKSPACE_CHANGED），不静默写入任一空间', armed.ok && sw.digestCalls >= 1 && sw.commit.ok === false && ['NOT_FOUND', 'WORKSPACE_CHANGED'].includes(sw.commit.code), JSON.stringify(sw))
    rec('B1C-11', '切空间后两空间完整快照逐字段不变（A草案仍 generating 同 revision，B无助手记录，无串写）', sw.afterA.status === 'generating' && sw.afterA.rev === genStep.revBefore && JSON.stringify(snapA0.docs) === JSON.stringify(snapA1.docs) && JSON.stringify(snapA0.sources) === JSON.stringify(snapA1.sources) && JSON.stringify(snapA0.drafts) === JSON.stringify(snapA1.drafts) && JSON.stringify(snapB0.docs) === JSON.stringify(snapB1.docs) && JSON.stringify(snapB0.drafts) === JSON.stringify(snapB1.drafts) && snapB1.drafts.length === 0 && snapA1.opsCount === 0 && snapB1.opsCount === 0, JSON.stringify({ afterA: sw.afterA, draftsA: snapA1.drafts.length, draftsB: snapB1.drafts.length }))
    await context.close()
  }

  // ===== B1C-12：离线硬刷新本地续编辑 =====
  if (ONLY_MAIN) { skip('B1C-12', 'ONLY_MAIN 模式仅跑主链路') } else {
    const cache = new Map()
    const { context, page, netHits } = await newScene('OFFLINE', { cache })
    const ids = await openAccept(page, 'ws-1c-offline', '虚构离线空间')
    await A(page, 'confirmRound1')
    await A(page, 'reschedule')
    const before = await A(page, 'editContent', '离线前假设')
    await context.setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const off = await page.evaluate(async ({ ws, draftId }) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      db.configureWorkspace(ws)
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => '2026-11-24T11:00:00+08:00', newId: () => `off-${++n}` })
      const g = await svc.get(draftId)
      const had = g.draft.assumptions.some((a) => a.text === '离线前假设')
      const e = await svc.edit(draftId, { expected: g.baseline.draft, edits: { assumptions: [...g.draft.assumptions, { id: 'as-off2', text: '离线中假设', related_keys: ['w-course'] }] } })
      const g2 = await svc.get(draftId)
      return { readRev: g.draft.revision, had, editOk: e.ok, saved: g2.draft.assumptions.some((a) => a.id === 'as-off2') }
    }, { ws: 'ws-1c-offline', draftId: ids.draftId })
    await context.setOffline(false)
    rec('B1C-12', '离线硬刷新后读取一致+本地编辑保存成功（缓存回放，非首次离线打开）', before.ok && off.had && off.editOk && off.saved, JSON.stringify({ before, off }))
    rec('B1C-12', '离线全程零模型/后端请求', netHits.length === 0, JSON.stringify(netHits))
    await context.close()
  }

  // ===== B1C-13：恢复中途失败→同意图重试 =====
  if (ONLY_MAIN) { skip('B1C-13', 'ONLY_MAIN 模式仅跑主链路') } else {
    const { context, page } = await newScene('RESTOREFAIL')
    const ids = await openAccept(page, 'ws-1c-rf', '虚构恢复失败空间')
    await A(page, 'confirmRound1')
    await A(page, 'reschedule')
    const rf = await page.evaluate(async ({ PAST_MS }) => {
      const db = window.__A.state.db, ws = window.__A.state.ws
      const { buildBackup } = await import('/src/services/backup/export.js')
      const { inspectBackupFile, prepareRestore } = await import('/src/services/backup/import.js')
      const { verifyCommittedRestore } = await import('/src/services/backup/restore.js')
      const snapBefore = JSON.stringify(await db.readWorkspaceSnapshot(ws))
      const exp = await buildBackup(await db.readWorkspaceSnapshot(ws), { backupId: 'bk-rf', exportedAt: '2026-11-24T12:00:00+08:00', instant: new Date('2026-11-24T12:00:00+08:00') })
      const ins = await inspectBackupFile(new File([exp.zipBytes], 'rf.zip', { type: 'application/zip' }))
      let c = 0
      const prep = prepareRestore({ inspected: ins, targetWorkspaceId: 'ws-1c-rf-target', targetName: '失败注入恢复空间', operationId: 'op-rf', nowMs: PAST_MS, createdAt: '2026-11-24T12:30:00+08:00', newId: () => `rf-${++c}` })
      const origAdd = IDBObjectStore.prototype.add
      IDBObjectStore.prototype.add = function (v, ...rest) { if (this.name === 'assistant_drafts') { const e = new Error('注入写入失败'); e.name = 'ConstraintError'; throw e } return origAdd.call(this, v, ...rest) }
      let failCode = null
      try { await db.commitRestore(prep) } catch (e) { failCode = e.code || e.name }
      IDBObjectStore.prototype.add = origAdd
      const raw = await new Promise((res, rej) => { const r = indexedDB.open('jxl-product'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const getAll = (s) => new Promise((res, rej) => { const q = raw.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
      const residue = {}
      for (const s of ['sources', 'docs', 'focus_runtime', 'assistant_threads', 'assistant_drafts', 'assistant_ops']) residue[s] = (await getAll(s)).filter((r) => r.workspace_id === 'ws-1c-rf-target').length
      residue.workspaces = (await getAll('workspaces')).filter((w) => w.id === 'ws-1c-rf-target').length
      raw.close()
      const retry = await db.commitRestore(prep)
      const verify = await verifyCommittedRestore(prep)
      const again = await db.commitRestore(prep)
      const after = JSON.stringify(await db.readWorkspaceSnapshot(ws))
      return { failCode, residue, retryVerify: verify.ok, problems: verify.problems, idempotent: again.receipt.committed_at === retry.receipt.committed_at, sourceUnchanged: after === snapBefore }
    }, { PAST_MS })
    const zero = Object.values(rf.residue).every((n) => n === 0)
    rec('B1C-13', '注入 assistant_drafts 写失败→新空间六store+目录零半残留、原空间不变', rf.failCode !== null && zero && rf.sourceUnchanged, JSON.stringify({ failCode: rf.failCode, residue: rf.residue }))
    rec('B1C-13', '移除故障同意图重试成功+实读核对通过；再次重试幂等不重复创建', rf.retryVerify && rf.idempotent, JSON.stringify(rf.problems))
    await context.close()
  }

  // ===== B1C-15：依赖阻断/不可拆/未知估时（C1：真实服务生成→保存→硬刷新读回三类案例）=====
  if (ONLY_MAIN) { skip('B1C-15', 'ONLY_MAIN 模式仅跑主链路') } else {
    const { context, page } = await newScene('ALGO')
    await page.goto(BASE + '__probe', { waitUntil: 'domcontentloaded' })
    const algo = await page.evaluate(async (TS) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      const ws = 'ws-1c-algo'
      db.configureWorkspace(ws)
      await db.putWorkspace({ id: ws, name: '虚构算法空间', is_demo: false })
      await db.putDoc({ id: 't-a', kind: 'task', title: '虚构目标A', status: 'todo', deadline: { value: null, precision: 'none' }, created_at: TS, updated_at: TS })
      await db.putDoc({ id: 'a-a', kind: 'action', task_id: 't-a', text: '步骤A', minutes: 60, done: false, created_at: TS })
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `al-${++n}` })
      const W = (key, extra) => ({ key, task_ref: { kind: 'existing', id: 't-a' }, action_ref: { kind: 'existing', id: 'a-a' }, deliverable: `交付${key}`, estimate_origin: 'user', splittable: true, min_segment_minutes: 25, depends_on: [], priority: 'normal', ...extra })
      const proposal = {
        task_proposals: [], action_proposals: [],
        work_items: [
          W('w-unk', { remaining_minutes: null, estimate_origin: 'model' }),
          W('w-dep', { remaining_minutes: 60, depends_on: ['w-unk'] }),
          W('w-big', { remaining_minutes: 200, splittable: false }),
        ],
        requirement_candidates: [], evidence_refs: [], assumptions: [], warnings: [],
      }
      const c = await svc.create({ title: '算法边界', proposal })
      const g = await svc.get(c.draft.id)
      await svc.confirmRequirement(c.thread.id, { expected: g.baseline.thread, requirement: { requirement_id: 'req-b', version: 1, type: 'daily_budget', value: 120, strength: 'hard', confirmed_at: TS, evidence_refs: [] } })
      const ctx = { timezone: 'Asia/Shanghai', today: '2026-11-24', start_date: '2026-11-24', horizon_days: 7, days: ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'].map((d) => ({ date: d, budget_minutes: null })) }
      const g2 = await svc.get(c.draft.id)
      const r = await svc.reschedule(c.draft.id, { expected: g2.baseline.draft, context: ctx, options: { bufferPct: 15 } })
      const g3 = await svc.get(c.draft.id)
      const res = g3.draft.planning_result
      const unschedOf = (key) => res.unscheduled.find((u) => u.work_item_key === key)
      // 继续编辑保存（真实 edit），随后硬刷新用新服务实例读回
      const edit = await svc.edit(c.draft.id, { expected: g3.baseline.draft, edits: { assumptions: [{ id: 'al-as', text: '算法边界补充假设', related_keys: ['w-dep'] }] } })
      return {
        ok: r.ok, draftId: c.draft.id, editOk: edit.ok, editRev: edit.draft.revision,
        unknown: res.unknown_items.map((u) => u.work_item_key), complete: res.complete,
        ready: g3.readiness.ready, blockers: g3.readiness.blockers.map((b) => b.code),
        segmentsTotal: res.segments.length,
        dep: unschedOf('w-dep') ?? null, big: unschedOf('w-big') ?? null,
      }
    }, TS)
    rec('B1C-15', '未知估时不当0：unknown_items保留、全案无分段、complete=false、ESTIMATE_UNKNOWN+GAP_UNCONFIRMED阻断ready', algo.ok && algo.unknown.includes('w-unk') && algo.segmentsTotal === 0 && algo.complete === false && algo.ready === false && algo.blockers.includes('ESTIMATE_UNKNOWN') && algo.blockers.includes('GAP_UNCONFIRMED'), JSON.stringify(algo))
    rec('B1C-15', '依赖缺口：w-dep 依赖未排 w-unk → dependency_blocked 保留剩余60；不可拆：w-big 200分>单日可用102 → not_splittable 保留剩余200', algo.dep && algo.dep.reason === 'dependency_blocked' && algo.dep.remaining_minutes === 60 && algo.big && algo.big.reason === 'not_splittable' && algo.big.remaining_minutes === 200, JSON.stringify({ dep: algo.dep, big: algo.big }))
    // 硬刷新（真实 reload）后新服务实例从 IDB 读回：三类边界结果与继续编辑均不丢
    await page.reload({ waitUntil: 'domcontentloaded' })
    const readback = await page.evaluate(async ({ ws, draftId }) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      db.configureWorkspace(ws)
      const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => '2026-11-24T12:00:00+08:00', newId: () => 'al-read' })
      const g = await svc.get(draftId)
      const res = g.draft.planning_result
      const unschedOf = (key) => res.unscheduled.find((u) => u.work_item_key === key)
      return { ok: g.ok, rev: g.draft.revision, unknown: res.unknown_items.map((u) => u.work_item_key), dep: unschedOf('w-dep') ?? null, big: unschedOf('w-big') ?? null, assumptionSaved: g.draft.assumptions.some((a) => a.id === 'al-as'), blockers: g.readiness.blockers.map((b) => b.code) }
    }, { ws: 'ws-1c-algo', draftId: algo.draftId })
    rec('B1C-15', '硬刷新后读回：依赖阻断/不可拆/未知估时与继续编辑逐项一致（真实保存非内存态）', readback.ok && readback.rev === algo.editRev && readback.unknown.includes('w-unk') && readback.dep && readback.dep.reason === 'dependency_blocked' && readback.big && readback.big.reason === 'not_splittable' && readback.assumptionSaved && readback.blockers.includes('ESTIMATE_UNKNOWN'), JSON.stringify(readback))
    await context.close()
  }

  // ===== B1C-08：命名空间三步闭环（既有+草案目标，浏览器）=====
  if (ONLY_MAIN) { skip('B1C-08', 'ONLY_MAIN 模式仅跑主链路') } else {
    const { context, page } = await newScene('NAMESPACE')
    await page.goto(BASE + '__probe', { waitUntil: 'domcontentloaded' })
    const ns = await page.evaluate(async (TS) => {
      const db = await import('/src/services/storage/db.js')
      const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
      const ws = 'ws-1c-ns'
      db.configureWorkspace(ws)
      await db.putWorkspace({ id: ws, name: '虚构命名空间', is_demo: false })
      const { PNG_BYTES } = await import('/src/tests/backupFixtures.js')
      await db.putSource({ id: 's-ns', kind: 'image', captured_at: TS, blob: new Blob([PNG_BYTES], { type: 'image/png' }), name: '虚构命名空间.png' })
      await db.putDoc({ id: 't-ex', kind: 'task', title: '既有目标', status: 'todo', deadline: { value: '2026-11-27', precision: 'date', confirmed_at: TS }, created_at: TS, updated_at: TS })
      await db.putDoc({ id: 'a-ex', kind: 'action', task_id: 't-ex', text: '既有步骤', minutes: 60, done: false, created_at: TS })
      let n = 0
      const svc = createAssistantDraftService({ getWorkspaceId: () => ws, wallNow: () => TS, newId: () => `ns-${++n}` })
      const EV = { kind: 'source_excerpt', source_id: 's-ns', excerpt: '虚构片段' }
      // 草案新建目标 key 与既有 id 不同名，验证 id_scope 不串绑
      const proposal = {
        task_proposals: [{ op: 'create', key: 't-ex', title: '草案同名key目标', deadline_candidates: [{ value: '2026-11-28', precision: 'date', origin: 'model', derived: false, basis: 'explicit', evidence_refs: [EV] }], evidence_refs: [EV] }],
        action_proposals: [{ op: 'create', key: 'a-dr', task_ref: { kind: 'draft', key: 't-ex' }, text: '草案步骤', minutes: 60, basis: 'suggestion', evidence_refs: [] }],
        work_items: [
          { key: 'w-ex', task_ref: { kind: 'existing', id: 't-ex' }, action_ref: { kind: 'existing', id: 'a-ex' }, deliverable: '既有交付', remaining_minutes: 60, estimate_origin: 'user', splittable: true, min_segment_minutes: 25, depends_on: [], priority: 'normal' },
          { key: 'w-dr', task_ref: { kind: 'draft', key: 't-ex' }, action_ref: { kind: 'draft', key: 'a-dr' }, deliverable: '草案交付', remaining_minutes: 60, estimate_origin: 'user', splittable: true, min_segment_minutes: 25, depends_on: [], priority: 'normal' },
        ],
        requirement_candidates: [], evidence_refs: [], assumptions: [], warnings: [],
      }
      const c = await svc.create({ title: '命名空间', proposal })
      const g = await svc.get(c.draft.id)
      await svc.confirmRequirement(c.thread.id, { expected: g.baseline.thread, requirement: { requirement_id: 'req-b', version: 1, type: 'daily_budget', value: 200, strength: 'hard', confirmed_at: TS, evidence_refs: [] } })
      const g1 = await svc.get(c.draft.id)
      // 草案目标截止确认（id_scope=draft，key=t-ex）
      const confDr = { confirmation_id: 'ns-dr', draft_revision: g1.draft.revision, object_type: 'task', id_scope: 'draft', object_id_or_key: 't-ex', field_path: 'deadline', old_value: null, new_value: { value: '2026-11-28', precision: 'date' }, confirmed_at: TS }
      const cd = await svc.confirm(c.draft.id, { expected: g1.baseline.draft, confirmation: confDr })
      const ctx = { timezone: 'Asia/Shanghai', today: '2026-11-24', start_date: '2026-11-24', horizon_days: 7, days: ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'].map((d) => ({ date: d, budget_minutes: null })) }
      const g2 = await svc.get(c.draft.id)
      const r = await svc.reschedule(c.draft.id, { expected: g2.baseline.draft, context: ctx, options: { bufferPct: 15 } })
      const g3 = await svc.get(c.draft.id)
      // 重排增版后须当前版再确认草案截止（旧版确认不继承）
      const confDr2 = { confirmation_id: 'ns-dr2', draft_revision: r.draft.revision, object_type: 'task', id_scope: 'draft', object_id_or_key: 't-ex', field_path: 'deadline', old_value: null, new_value: { value: '2026-11-28', precision: 'date' }, confirmed_at: TS }
      await svc.confirm(c.draft.id, { expected: g3.baseline.draft, confirmation: confDr2 })
      const g4 = await svc.get(c.draft.id)
      const facts = g4.draft.planning_input.task_facts
      const draftFact = facts.find((f) => f.task_ref.kind === 'draft')
      const existingFact = facts.find((f) => f.task_ref.kind === 'existing')
      const gen = await svc.setStatus(c.draft.id, { expected: g4.baseline.draft, status: 'generating' })
      const ready = gen.ok ? await svc.setStatus(c.draft.id, { expected: gen.draft, status: 'ready' }) : gen
      return { confOk: cd.ok, reschedOk: r.ok, draftDeadline: draftFact && draftFact.deadline_value, existingDeadline: existingFact && existingFact.deadline_value, readyOk: ready.ok, readyBlockers: (ready.blockers || []).map((b) => b.code) }
    }, TS)
    rec('B1C-08', '既有+草案同名key不串绑：草案截止11-28/既有截止11-27分别采用，三步闭环后就绪', ns.confOk && ns.reschedOk && ns.draftDeadline === '2026-11-28' && ns.existingDeadline === '2026-11-27' && ns.readyOk, JSON.stringify(ns))
    await context.close()
  }
} catch (err) {
  rec('RUNNER', '运行异常', false, err && err.stack || String(err))
} finally {
  const passed = results.filter((r) => r.pass === true).length
  const failed = results.filter((r) => r.pass === false)
  const skipped = results.filter((r) => r.pass == null).length
  const summary = { at: new Date().toISOString(), base: BASE, port: PORT, mutate: MUTATE, onlyMain: ONLY_MAIN, total: results.length, passed, failed: failed.length, skipped, results }
  writeFileSync(join(RUN, 'results.json'), JSON.stringify(summary, null, 2))
  if (!MUTATE && !ONLY_MAIN) writeFileSync(join(HERE, '..', 'remediation-r2', 'gates', 'browser-1c-results.json'), JSON.stringify(summary, null, 2))
  console.log(`\n${passed}/${results.length} PASS（failed=${failed.length} skipped=${skipped}）`)
  await browser.close()
  vite.kill()
  process.exit(failed.length ? 1 : 0)
}
