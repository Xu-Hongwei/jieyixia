// M3 第三步「浏览器与备份验收」矩阵（2026-11-26）——真实页面 + 真实 IndexedDB + fixture 后端真实 HTTP。
// 覆盖开工单 §10 剩余行：历史保护（含 actual=0/运行中会话）、模拟容量、未知不排 0、模型输出无效不采用、
// 预览零写入、事实漂移整体拒绝、原子写失败回滚、双击/双标签幂等、手机选范围核对保存、离线本地规则排程。
// 自起 fixture 后端与 Vite（独立端口），拦截并报告任何 :8000/:8020 命中；全部虚构种子。
// 运行：node E:/qoder/devlog/private-evidence/assistant-mvp/M3/browser/m3-matrix.mjs
// 产出：同目录 run-matrix-2026-11-26/（results.json + screenshots/ + 服务日志）；任一 FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'runs', 'matrix-2026-11-26-postfix')
const SHOTS = join(RUN, 'screenshots')
for (const d of [RUN, SHOTS]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const PYTHON = 'D:/APP/miniconda3/python.exe'
const TOKEN = `m3-matrix-probe-${randomUUID()}`

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true })

const bjToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
function bjAddDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const TODAY = bjToday()
const D = (i) => bjAddDays(TODAY, i)
const NOW_ISO = `${TODAY}T10:00:00+08:00`

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer()
    s.once('error', () => res(false))
    s.once('listening', () => s.close(() => res(true)))
    s.listen(port, '127.0.0.1')
  })
}
let VPORT = null
for (const p of [5177, 5178, 5179, 5180, 5181]) { if (await portFree(p)) { VPORT = p; break } }
if (VPORT == null) { console.error('无空闲 Vite 端口（5177–5181），显式退出，不杀未知服务'); process.exit(2) }
let BPORT = null
for (const p of [8010, 8011, 8012, 8013, 8014]) { if (await portFree(p)) { BPORT = p; break } }
if (BPORT == null) { console.error('无空闲后端端口（8010–8014），显式退出，不杀未知服务'); process.exit(2) }
const BASE = `http://127.0.0.1:${VPORT}/`
const BACKEND = `http://127.0.0.1:${BPORT}`

const backend = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(BPORT)], {
  cwd: 'E:/qoder/backend',
  env: { ...process.env, JXL_PROVIDER: 'fixture', JXL_API_TOKEN: TOKEN, JXL_CORS_ORIGINS: `http://127.0.0.1:${VPORT},http://localhost:${VPORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let backendLog = ''
backend.stdout.on('data', (d) => { backendLog += d }); backend.stderr.on('data', (d) => { backendLog += d })
{
  const deadline = Date.now() + 30000
  for (;;) {
    try { const r = await fetch(`${BACKEND}/api/healthz`); if (r.ok) break } catch {}
    if (Date.now() > deadline) { writeFileSync(join(RUN, 'backend.log'), backendLog); console.error(backendLog); backend.kill(); throw new Error('fixture 后端未就绪') }
    await new Promise((r) => setTimeout(r, 300))
  }
}
console.log(`fixture 后端就绪：${BACKEND}`)

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(VPORT), '--strictPort'], {
  cwd: 'E:/qoder/frontend',
  env: { ...process.env, JXL_DEV_BACKEND: BACKEND, JXL_API_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let viteLog = ''
vite.stdout.on('data', (d) => { viteLog += d }); vite.stderr.on('data', (d) => { viteLog += d })
{
  const deadline = Date.now() + 45000
  for (;;) {
    try { const r = await fetch(BASE); if (r.ok) break } catch {}
    if (Date.now() > deadline) { writeFileSync(join(RUN, 'vite.log'), viteLog); console.error(viteLog); vite.kill(); backend.kill(); throw new Error('vite 未就绪') }
    await new Promise((r) => setTimeout(r, 300))
  }
}
console.log(`Vite 就绪：${BASE}（北京今天 ${TODAY}）`)
const browser = await chromium.launch({ executablePath: EXEC, headless: true })

const netHits = []
async function newScene(name, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
  })
  const counts = { analyze: 0, propose: 0 }
  context.on('request', (r) => {
    const u = r.url()
    if (/:8000|:8020/.test(u)) netHits.push(u)
    if (u.includes('/api/analyze')) counts.analyze += 1
    if (u.includes('/api/assistant/propose')) counts.propose += 1
  })
  await context.route(/:8000|:8020/, (route) => route.abort())
  const page = await context.newPage()
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, (e.stack || e.message).split('\n').slice(0, 4).join(' | ')))
  page.on('dialog', (d) => d.accept())
  return { context, page, counts }
}

async function idbAll(page, store) {
  return page.evaluate((name) => new Promise((res, rej) => {
    const r = indexedDB.open('jxl-product')
    r.onsuccess = () => {
      const db = r.result
      if (!db.objectStoreNames.contains(name)) { db.close(); return res([]) }
      const q = db.transaction(name, 'readonly').objectStore(name).getAll()
      q.onsuccess = () => { db.close(); res(q.result) }
      q.onerror = () => { db.close(); rej(q.error) }
    }
    r.onerror = () => rej(r.error)
  }), store)
}
const docsOf = async (page, ws, kind) => (await idbAll(page, 'docs')).filter((d) => d.workspace_id === ws && (!kind || d.kind === kind))
const draftsOf = async (page, ws) => (await idbAll(page, 'assistant_drafts')).filter((d) => d.workspace_id === ws)
const opsOf = async (page, ws) => (await idbAll(page, 'assistant_ops')).filter((o) => o.workspace_id === ws)
const activeDraft = async (page, ws) => {
  const ds = await draftsOf(page, ws)
  return ds.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] ?? null
}
// 业务事实快照（计划/任务/行动，按 id 排序后逐字比较）：用于「预览零写入」与回滚断言。
async function factsSnapshot(page, ws) {
  const docs = (await docsOf(page, ws)).filter((d) => ['plan_item', 'task', 'action'].includes(d.kind))
  docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return JSON.stringify(docs)
}
async function mutatePlanMinutes(page, ws, id, minutes) {
  await page.evaluate(({ ws, id, minutes }) => new Promise((res, rej) => {
    const r = indexedDB.open('jxl-product')
    r.onsuccess = () => {
      const db = r.result
      const t = db.transaction('docs', 'readwrite')
      const s = t.objectStore('docs')
      const g = s.get(id)
      g.onsuccess = () => {
        const rec = g.result
        if (!rec || rec.workspace_id !== ws) { db.close(); return rej(new Error('找不到待修改安排')) }
        rec.planned_minutes = minutes
        s.put(rec)
      }
      t.oncomplete = () => { db.close(); res() }
      t.onerror = () => { db.close(); rej(t.error) }
    }
    r.onerror = () => rej(r.error)
  }), { ws, id, minutes })
}

// ---- 虚构种子构件 ----
const WS = 'personal'
function seedRecords(extra = []) {
  const base = { workspace_id: WS, record_version: 1, created_at: NOW_ISO, updated_at: NOW_ISO }
  const task = (id, title, deadline) => ({ ...base, id, kind: 'task', title, description: '', matter_id: null, note_ids: [], deadline, status: 'todo', completion_criteria: null, current_action_id: null, is_demo: false })
  const action = (id, task_id, text, minutes, done) => ({ id, kind: 'action', workspace_id: WS, record_version: 1, task_id, text, minutes, basis: 'user', done, created_at: NOW_ISO })
  const plan = (id, task_id, date, minutes, text, over = {}) => ({ ...base, id, kind: 'plan_item', task_id, date, planned_minutes: minutes, action_text: text, state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over })
  const focus = (id, plan_item_id, over = {}) => ({
    id, kind: 'focus_session', workspace_id: WS, record_version: 0,
    task_id: 't-smoke', action_id: 'a-report', plan_item_id,
    started_at: `${D(0)}T09:00:00+08:00`, ended_at: `${D(0)}T09:30:00+08:00`,
    accumulated_ms: 1800000, running: false, outcome: 'done', draft_md: '', is_demo: false, ...over,
  })
  const records = [
    task('t-smoke', '虚构：课程报告', { value: D(6), precision: 'date', source: 'manual', from_note_id: null, confirmed_at: NOW_ISO }),
    task('t-other', '虚构：其它任务', { value: null, precision: 'none', source: 'note', from_note_id: null, confirmed_at: null }),
    action('a-read', 't-smoke', '阅读资料', 60, true),
    action('a-report', 't-smoke', '撰写报告正文', 90, false),
  ]
  return { records: [...records, ...extra], plan, focus, base, task, action }
}
async function seed(page, records) {
  await page.evaluate((recs) => new Promise((res, rej) => {
    const r = indexedDB.open('jxl-product')
    r.onsuccess = () => {
      const db = r.result
      const t = db.transaction('docs', 'readwrite')
      for (const rec of recs) t.objectStore('docs').put(rec)
      t.oncomplete = () => { db.close(); res() }
      t.onerror = () => { db.close(); rej(t.error) }
    }
    r.onerror = () => rej(r.error)
  }), records)
}

async function waitText(page, text, timeout = 20000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout })
  } catch (e) {
    console.log(`WAIT TIMEOUT「${text}」BODY:\n`, (await page.evaluate(() => document.body.innerText)).slice(0, 1500))
    throw e
  }
}
const btn = (page, name) => page.getByRole('button', { name, exact: true })
const bodyText = (page) => page.evaluate(() => document.body.innerText)
const normText = async (page) => (await bodyText(page)).replace(/\s+/g, ' ')

async function boot(page, records) {
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await waitText(page, '日程', 20000)
  await seed(page, records)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitText(page, '日程', 20000)
}
async function setBudgets(page, minutes) {
  for (let i = 0; i < 7; i += 1) {
    await page.getByLabel(`${D(i)} 预算分钟`).fill(String(minutes))
  }
}
async function confirmScopeTwice(page) {
  await btn(page, '确认替换范围').click()
  await page.waitForTimeout(200)
  await btn(page, '重新排程').click()
  await waitText(page, '七天预览（按日竖排）')
  await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
  if (await btn(page, '确认替换范围').count()) {
    await btn(page, '确认替换范围').click()
    await page.waitForTimeout(200)
  }
}
// 助手页 → 选择 t-smoke → 进入改排范围；勾选指定旧安排；填进展与清单；创建草案（纯本地，不调模型）。
async function createReplanDraft(page, { plans, statement, rows, doneText = '核对与确认' }) {
  await page.evaluate(() => { location.hash = '#/assistant' })
  await waitText(page, '调整已有任务（改排）')
  await page.getByLabel('选择要调整的任务').selectOption('t-smoke')
  await btn(page, '选择任务并调整').click()
  await waitText(page, '调整后续安排 · 选择替换范围')
  for (const label of plans) await page.getByLabel(label).check()
  await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').fill(statement)
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]
    await page.getByLabel(`第 ${i + 1} 行工作内容`).fill(r.text)
    await page.getByLabel(`第 ${i + 1} 行分钟数`).fill(r.minutes)
    if (r.reuse) await page.getByLabel(`第 ${i + 1} 行复用行动`).selectOption(r.reuse)
  }
  await btn(page, '创建改排草案').click()
  await waitText(page, doneText, 20000)
}
async function waitDraftPlanning(page, pred, timeout = 20000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const d = await activeDraft(page, 'personal')
    if (pred(d)) return d
    if (Date.now() > deadline) throw new Error(`等待草案规划超时：${JSON.stringify(d?.planning_result ?? null).slice(0, 300)}`)
    await page.waitForTimeout(300)
  }
}
const L = (date, text) => `替换安排 ${date} ${text}`

let exitCode = 0
try {
  // ========== S1 历史保护：done/partial、有投入、actual=0、任意会话引用（含运行中）不可选，只读原因 ==========
  {
    const { context, page, counts } = await newScene('S1')
    const seedLike = seedRecords()
    const { plan, focus } = seedLike
    const recs = [
      ...seedLike.records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-2', 't-smoke', D(1), 45, '写报告初稿（旧安排）'),
      plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
      plan('p-prot', 't-smoke', D(3), 30, '已投入的安排', { actual_minutes: 10 }),
      plan('p-zero', 't-smoke', D(4), 25, '零投入已执行安排', { actual_minutes: 0 }),
      plan('p-foc', 't-smoke', D(4), 30, '有专注记录的安排'),
      plan('p-run', 't-smoke', D(5), 30, '正在专注的安排'),
      plan('p-part', 't-smoke', D(6), 20, '部分完成的安排', { state: 'partial', actual_minutes: 15 }),
      plan('p-done', 't-smoke', D(6), 20, '已完成的安排', { state: 'done', actual_minutes: 20 }),
      plan('p-other', 't-other', D(0), 60, '其它任务的安排'),
      focus('f-1', 'p-foc'),
      focus('f-run', 'p-run', { started_at: `${D(0)}T10:00:00+08:00`, ended_at: null, accumulated_ms: 600000, running: true, outcome: null }),
    ]
    await boot(page, recs)
    await page.evaluate(() => { location.hash = '#/assistant' })
    await waitText(page, '调整已有任务（改排）')
    await page.getByLabel('选择要调整的任务').selectOption('t-smoke')
    await btn(page, '选择任务并调整').click()
    await waitText(page, '调整后续安排 · 选择替换范围')
    const boxCount = await page.locator('input[type="checkbox"][aria-label^="替换安排 "]').count()
    const protectedLabels = [
      L(D(4), '零投入已执行安排'),
      L(D(5), '正在专注的安排'),
      L(D(6), '部分完成的安排'),
      L(D(6), '已完成的安排'),
      L(D(3), '已投入的安排'),
      L(D(4), '有专注记录的安排'),
    ]
    const goneBoxes = []
    for (const label of protectedLabels) goneBoxes.push(await page.getByLabel(label).count())
    const body = await bodyText(page)
    rec('S1', '合格条目才有勾选框（p-1/p-2/p-keep 三条，受保护六条无框）',
      boxCount === 3 && goneBoxes.every((n) => n === 0), JSON.stringify({ boxCount, goneBoxes }))
    const count = (t) => (body.match(new RegExp(t, 'g')) || []).length
    rec('S1', '只读原因：有投入(含 actual=0) ×2、会话引用(含运行中) ×2、已完成/部分 ×2',
      count('已有投入记录') === 2 && count('有专注会话引用') === 2 && count('已有执行/完成/取消等状态') === 2,
      JSON.stringify({ actual: count('已有投入记录'), session: count('有专注会话引用'), state: count('已有执行/完成/取消等状态') }))
    rec('S1', '替换/保留计数与受保护条目一致', body.includes('本次将替换 0 条、保留 9 条'), '')
    await shot(page, 's1-01-protected.png')
    await page.getByLabel(L(D(0), '整理资料（旧安排）')).check()
    rec('S1', '勾选后计数 1/8', (await bodyText(page)).includes('本次将替换 1 条、保留 8 条'), '')
    await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').fill('只替换那条整理资料')
    await page.getByLabel('第 1 行工作内容').fill('撰写报告正文')
    await page.getByLabel('第 1 行分钟数').fill('90')
    await page.getByLabel('第 1 行复用行动').selectOption('a-report')
    await btn(page, '创建改排草案').click()
    await waitText(page, '核对与确认', 20000)
    const d1 = await activeDraft(page, 'personal')
    rec('S1', '草案范围只含用户所选，受保护条目不静默纳入',
      JSON.stringify(d1?.replan_scope?.replacement_ids ?? []) === JSON.stringify(['p-1']) && counts.propose === 0, '')
    await context.close()
  }

  // ========== S2 模拟容量：预算120/缓冲15%/选中占用60/保留占用30→可用72，无重复扣减，全任务占用参与 ==========
  {
    const { context, page } = await newScene('S2')
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-cap-a', 't-smoke', D(0), 30, '容量旧安排A'),
      plan('p-cap-b', 't-smoke', D(0), 30, '容量旧安排B'),
      plan('p-cap-keep', 't-smoke', D(0), 30, '保留工作'),
      plan('p-other', 't-other', D(1), 60, '其它任务占用'),
    ])
    await createReplanDraft(page, {
      plans: [L(D(0), '容量旧安排A'), L(D(0), '容量旧安排B')],
      statement: '资料读完了，报告还需安排 72 分钟',
      rows: [{ text: '容量测试新工作', minutes: '72' }],
    })
    await setBudgets(page, 120)
    await confirmScopeTwice(page)
    const d1 = await activeDraft(page, 'personal')
    const days = d1?.planning_result?.days ?? []
    const d0 = days[0] ?? {}
    const d1day = days[1] ?? {}
    rec('S2', '容量手算：120−18缓冲−30保留=72 可用（选中60已排除，不重复扣减）',
      d0.budget_minutes === 120 && d0.buffer_minutes === 18 && d0.committed_minutes === 30
      && d0.allocated_minutes === 72 && d0.free_minutes === 0,
      JSON.stringify({ d0 }))
    rec('S2', '其它任务占用参与：D1 既有 60、余 42',
      d1day.committed_minutes === 60 && d1day.free_minutes === 42 && d1day.allocated_minutes === 0,
      JSON.stringify({ d1: d1day }))
    const segs = d1?.planning_result?.segments ?? []
    rec('S2', '新排总量 72 全部落 D0（单段 72）',
      segs.length === 1 && segs[0].date === D(0) && segs[0].minutes === 72, JSON.stringify(segs))
    const norm = await normText(page)
    rec('S2', '预览按日显示 预算120·缓冲18·既有30·新排72·余0',
      norm.includes('预算 120 · 缓冲 18 · 既有 30 · 新排 72 · 余 0'), '')
    const body = await bodyText(page)
    rec('S2', '改排三块预览：保留含保留工作与其它任务占用，将取消 2、将新增 1',
      body.includes('保留工作') && body.includes('其它任务占用') && body.includes('将取消（2）') && body.includes('将新增（1）'), '')
    await shot(page, 's2-01-capacity.png')
    await context.close()
  }

  // ========== S3 未知工作量：不排成 0；单列 unknown_items，采用被阻断 ==========
  {
    const { context, page } = await newScene('S3')
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
    ])
    await createReplanDraft(page, {
      plans: [L(D(0), '整理资料（旧安排）')],
      statement: '资料读完了，报告还需安排时间（分钟未知）',
      rows: [{ text: '撰写报告正文', minutes: '', reuse: 'a-report' }],
    })
    await setBudgets(page, 120)
    await confirmScopeTwice(page)
    const d1 = await activeDraft(page, 'personal')
    const pr = d1?.planning_result ?? {}
    rec('S3', '未知估时单列 unknown_items，不生成 0 分钟安排',
      (pr.segments ?? []).length === 0 && (pr.unknown_items ?? []).length === 1
      && pr.unknown_items[0].work_item_key === 'rw1' && (pr.segments ?? []).every((s) => s.minutes > 0),
      JSON.stringify({ segs: pr.segments, unknown: pr.unknown_items }))
    const body = await bodyText(page)
    rec('S3', '界面提示未知估时并要求补分钟；零新安排不提供采用',
      body.includes('估时未知（请在编辑区填写剩余分钟）：rw1') && body.includes('新安排为零')
      && await btn(page, '采用计划').isDisabled(), '')
    rec('S3', '草案仍为本地用户清单（复用行动、分钟未知保持 null）',
      d1?.progress_input?.work_items?.[0]?.minutes == null && d1?.progress_input?.work_items?.[0]?.reuse_action_id === 'a-report', '')
    await shot(page, 's3-01-unknown.png')
    await context.close()
  }

  // ========== S4 模型输出无效（服务端拒绝）：明确失败，不静默采用，正式安排零写入 ==========
  {
    const { context, page, counts } = await newScene('S4')
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
    ])
    const before = await factsSnapshot(page, 'personal')
    await createReplanDraft(page, {
      plans: [L(D(0), '整理资料（旧安排）')],
      statement: '资料读完了，报告还需安排 90 分钟',
      rows: [{ text: '撰写报告正文', minutes: '90', reuse: 'a-report' }],
    })
    await context.route('**/api/assistant/propose', (route) => route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'model_output_invalid', message: '模型输出未通过服务端语义校验（虚构反例）' }),
    }))
    await btn(page, '请助手整理剩余工作').click()
    await waitText(page, '模型输出未通过服务端语义校验（虚构反例）', 30000)
    await waitText(page, '重试生成', 15000)
    const d1 = await activeDraft(page, 'personal')
    const body = await bodyText(page)
    rec('S4', '越界/无效输出被拒并显示失败（含重试生成），模型内容未采用',
      counts.propose === 1 && !body.includes('助手建议清单（建议，未确认')
      && (d1?.proposal?.work_items ?? []).every((w) => w.estimate_origin !== 'model')
      && d1?.progress_input?.work_items?.[0]?.minutes === 90, JSON.stringify({ propose: counts.propose }))
    rec('S4', '采用保持禁用；正式安排零写入', await btn(page, '采用计划').isDisabled() && (await factsSnapshot(page, 'personal')) === before, '')
    await shot(page, 's4-01-invalid-output.png')
    await context.close()
  }

  // ========== S5 预览零写入：生成、改表单、放弃草案都不改变正式安排 ==========
  {
    const { context, page, counts } = await newScene('S5')
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
    ])
    const before = await factsSnapshot(page, 'personal')
    await createReplanDraft(page, {
      plans: [L(D(0), '整理资料（旧安排）')],
      statement: '资料读完了，报告还需安排 90 分钟',
      rows: [{ text: '撰写报告正文', minutes: '90', reuse: 'a-report' }],
    })
    await btn(page, '请助手整理剩余工作').click()
    await waitText(page, '助手建议清单（建议，未确认', 30000)
    rec('S5', '生成建议后正式安排零写入', (await factsSnapshot(page, 'personal')) === before, '')
    // 改表单（预算，不进库）后仍是零写入
    await page.getByLabel(`${D(0)} 预算分钟`).fill('90')
    rec('S5', '改表单预算后正式安排仍零写入', (await factsSnapshot(page, 'personal')) === before, '')
    // 放弃草案（关闭预览链路）也不改变正式安排
    await btn(page, '放弃草案').click()
    await waitText(page, '确认放弃草案', 10000).catch(() => {})
    await btn(page, '放弃').click()
    await page.waitForTimeout(500)
    const d1 = await activeDraft(page, 'personal')
    rec('S5', '放弃草案后正式安排零写入、草案只读丢弃',
      (await factsSnapshot(page, 'personal')) === before && d1?.status === 'discarded',
      JSON.stringify({ status: d1?.status, propose: counts.propose }))
    await shot(page, 's5-01-zero-write.png')
    await context.close()
  }

  // ========== S6 事实漂移：就绪后事实变化 → 采用整体要求重核，零写入 ==========
  {
    const { context, page } = await newScene('S6')
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-2', 't-smoke', D(1), 45, '写报告初稿（旧安排）'),
      plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
    ])
    await createReplanDraft(page, {
      plans: [L(D(0), '整理资料（旧安排）'), L(D(1), '写报告初稿（旧安排）')],
      statement: '资料读完了，报告还需安排 90 分钟',
      rows: [{ text: '撰写报告正文', minutes: '90', reuse: 'a-report' }],
    })
    await setBudgets(page, 120)
    await confirmScopeTwice(page)
    await waitText(page, '就绪核对通过，可采用', 15000)
    const d1 = await activeDraft(page, 'personal')
    const n = (d1?.planning_result?.segments ?? []).length
    await btn(page, '采用计划').click()
    await waitText(page, '确认采用计划', 15000)
    // 预览打开后修改保留安排（事实漂移）：采用必须整体拒绝。
    await mutatePlanMinutes(page, 'personal', 'p-keep', 21)
    await btn(page, `确认替换 2 条旧安排，新增 ${n} 条安排`).click()
    await waitText(page, '需重新核对', 30000)
    const body = await bodyText(page)
    const plans = await docsOf(page, 'personal', 'plan_item')
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]))
    const d2 = await activeDraft(page, 'personal')
    const newPlans = plans.filter((p) => !['p-1', 'p-2', 'p-keep'].includes(p.id))
    const ops = await opsOf(page, 'personal')
    rec('S6', '事实漂移→「需重新核对…本次确定未提交」并列差异码',
      body.includes('需重新核对：空间事实或证据在采用前发生变化，本次确定未提交。') && body.includes('OCCUPANCY_CHANGED'), '')
    rec('S6', '整体拒绝：旧安排未取消、无半份新对象、无成功回执',
      byId['p-1']?.state === 'planned' && byId['p-2']?.state === 'planned' && newPlans.length === 0
      && !ops.some((o) => o.state === 'committed') && !body.includes('采用成功'), '')
    rec('S6', '草案转入需复核（needs_review），采用禁用', d2?.status === 'needs_review' && await btn(page, '采用计划').isDisabled(), JSON.stringify({ status: d2?.status }))
    await shot(page, 's6-01-drift.png')
    await context.close()
  }

  // ========== S7 原子失败：采用中途注入 docs 写失败 → 整体回滚，无半份对象/取消/回执 ==========
  {
    const { context, page } = await newScene('S7')
    await page.addInitScript(() => {
      const origPut = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (window.__failDocPut && this.name === 'docs') {
          window.__failDocPut = false
          throw new Error('injected adopt failure')
        }
        return origPut.apply(this, args)
      }
    })
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-2', 't-smoke', D(1), 45, '写报告初稿（旧安排）'),
      plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
    ])
    const before = await factsSnapshot(page, 'personal')
    await createReplanDraft(page, {
      plans: [L(D(0), '整理资料（旧安排）'), L(D(1), '写报告初稿（旧安排）')],
      statement: '资料读完了，报告还需安排 90 分钟',
      rows: [{ text: '撰写报告正文', minutes: '90', reuse: 'a-report' }],
    })
    await setBudgets(page, 120)
    await confirmScopeTwice(page)
    await waitText(page, '就绪核对通过，可采用', 15000)
    const d1 = await activeDraft(page, 'personal')
    const n = (d1?.planning_result?.segments ?? []).length
    await btn(page, '采用计划').click()
    await waitText(page, '确认采用计划', 15000)
    await page.evaluate(() => { window.__failDocPut = true })
    await btn(page, `确认替换 2 条旧安排，新增 ${n} 条安排`).click()
    await waitText(page, '确定未提交', 30000)
    const body = await bodyText(page)
    const d2 = await activeDraft(page, 'personal')
    const ops = await opsOf(page, 'personal')
    const plans = await docsOf(page, 'personal', 'plan_item')
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]))
    rec('S7', '注入写失败→「确定未提交」，无成功回执',
      body.includes('确定未提交') && !body.includes('采用成功') && !ops.some((o) => o.state === 'committed'), '')
    rec('S7', '整体回滚：旧安排未取消、无半份新对象、正式事实逐字未变',
      byId['p-1']?.state === 'planned' && byId['p-2']?.state === 'planned'
      && plans.length === 3 && (await factsSnapshot(page, 'personal')) === before, JSON.stringify({ plans: plans.length }))
    rec('S7', '草案收敛为 needs_review 供重核', d2?.status === 'needs_review', JSON.stringify({ status: d2?.status }))
    await shot(page, 's7-01-atomic-fail.png')
    await context.close()
  }

  // ========== S8 幂等：双击确认只写一份；双标签后到者冲突不重复取消新增 ==========
  {
    const { context, page } = await newScene('S8')
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-2', 't-smoke', D(1), 45, '写报告初稿（旧安排）'),
      plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
    ])
    await createReplanDraft(page, {
      plans: [L(D(0), '整理资料（旧安排）'), L(D(1), '写报告初稿（旧安排）')],
      statement: '资料读完了，报告还需安排 90 分钟',
      rows: [{ text: '撰写报告正文', minutes: '90', reuse: 'a-report' }],
    })
    await setBudgets(page, 120)
    await confirmScopeTwice(page)
    await waitText(page, '就绪核对通过，可采用', 15000)
    const d1 = await activeDraft(page, 'personal')
    const n = (d1?.planning_result?.segments ?? []).length
    // 第二标签：先打开同一草案（保留就绪基线），稍后再点采用。
    const page2 = await context.newPage()
    page2.on('pageerror', (e) => rec('S8', '标签B JS错误', false, e.message))
    await page2.goto(BASE + '#/assistant', { waitUntil: 'domcontentloaded' })
    await waitText(page2, '继续已有草案')
    await page2.getByRole('button').filter({ hasText: ' 版' }).first().click()
    await waitText(page2, '核对与确认', 20000)
    await waitText(page2, '就绪核对通过，可采用', 15000)
    // 标签A：双击确认（同一帧两次点击）。
    await btn(page, '采用计划').click()
    await waitText(page, '确认采用计划', 15000)
    const label = `确认替换 2 条旧安排，新增 ${n} 条安排`
    await page.evaluate((text) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === text)
      b.click(); b.click()
    }, label)
    await waitText(page, '采用成功', 30000)
    const ops1 = (await opsOf(page, 'personal')).filter((o) => o.state === 'committed')
    const plans1 = await docsOf(page, 'personal', 'plan_item')
    const d2 = await activeDraft(page, 'personal')
    const cancelled = plans1.filter((p) => p.state === 'cancelled').map((p) => p.id).sort()
    const newPlans = plans1.filter((p) => !['p-1', 'p-2', 'p-keep'].includes(p.id))
    rec('S8', '双击只提交一次：台账恰好一份 committed，取消/新增各一份',
      ops1.length === 1 && JSON.stringify(cancelled) === JSON.stringify(['p-1', 'p-2'])
      && newPlans.length === n && d2?.status === 'applied',
      JSON.stringify({ ops: ops1.length, cancelled, new: newPlans.length }))
    // 标签B（旧基线）再点采用：冲突拒写，不产生第二份。
    await btn(page2, '采用计划').click()
    await waitText(page2, '草案已被其它页面修改', 15000)
    const ops2 = (await opsOf(page, 'personal')).filter((o) => o.state === 'committed')
    const plans2 = await docsOf(page, 'personal', 'plan_item')
    rec('S8', '双标签后到者冲突拒写，不重复取消/新增',
      ops2.length === 1 && plans2.filter((p) => p.state === 'cancelled').length === 2
      && plans2.filter((p) => !['p-1', 'p-2', 'p-keep'].includes(p.id)).length === n, '')
    await shot(page, 's8-01-adopted-twice-click.png')
    await page2.close()
    await context.close()
  }

  // ========== S9 手机（390px）：能选范围、核对、保存与排程 ==========
  {
    const { context, page } = await newScene('S9', { mobile: true })
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-2', 't-smoke', D(1), 45, '写报告初稿（旧安排）'),
      plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
    ])
    await createReplanDraft(page, {
      plans: [L(D(0), '整理资料（旧安排）'), L(D(1), '写报告初稿（旧安排）')],
      statement: '手机上也调整一下：报告还需 90 分钟',
      rows: [{ text: '撰写报告正文', minutes: '90', reuse: 'a-report' }],
      doneText: '保存改排内容',
    })
    const saved1 = await activeDraft(page, 'personal')
    await setBudgets(page, 120)
    await btn(page, '预览').click()
    await btn(page, '确认替换范围').click()
    await page.waitForTimeout(200)
    await btn(page, '编辑').click()
    await btn(page, '重新排程').click()
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent.includes('排程中')), null, { timeout: 20000 })
    const d1 = await waitDraftPlanning(page, (d) => (d?.planning_result?.segments ?? []).reduce((a, s) => a + s.minutes, 0) === 90)
    await btn(page, '预览').click()
    // 排程成功即 bump 版本，范围确认须在当前版本重绑（与桌面 confirmScopeTwice 同语义）。
    if (await btn(page, '确认替换范围').count()) {
      await btn(page, '确认替换范围').click()
      await page.waitForTimeout(300)
    }
    await waitText(page, '就绪核对通过，可采用', 15000)
    rec('S9', '手机创建草案：范围与清单保存到库',
      JSON.stringify(saved1?.replan_scope?.replacement_ids ?? []) === JSON.stringify(['p-1', 'p-2'])
      && saved1?.progress_input?.work_items?.[0]?.minutes === 90, '')
    rec('S9', '手机核对与预览：三块预览 + 就绪可采用',
      (await bodyText(page)).includes('改排预览：保留 / 将取消 / 将新增')
      && (d1?.planning_result?.segments ?? []).reduce((a, s) => a + s.minutes, 0) === 90
      && !(await btn(page, '采用计划').isDisabled()), '')
    await shot(page, 's9-01-mobile.png')
    await context.close()
  }

  // ========== S10 离线：模型不可达保留输入；本地清单继续规则排程 ==========
  {
    const { context, page, counts } = await newScene('S10')
    const { plan } = seedRecords()
    await boot(page, [
      ...seedRecords().records,
      plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
      plan('p-other', 't-other', D(0), 60, '其它任务占用'),
    ])
    const before = await factsSnapshot(page, 'personal')
    await createReplanDraft(page, {
      plans: [L(D(0), '整理资料（旧安排）')],
      statement: '网络不好，但先把本地清单排进去',
      rows: [{ text: '撰写报告正文', minutes: '90', reuse: 'a-report' }],
    })
    await context.route('**/api/assistant/propose', (route) => route.abort('failed'))
    await btn(page, '请助手整理剩余工作').click()
    await waitText(page, '重试生成', 30000)
    const d1 = await activeDraft(page, 'personal')
    rec('S10', '模型不可达→失败可重试；用户输入与清单原样保留',
      counts.propose === 1 && d1?.progress_input?.work_items?.[0]?.minutes === 90
      && d1?.progress_input?.statement === '网络不好，但先把本地清单排进去'
      && (await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').inputValue()) === '网络不好，但先把本地清单排进去', '')
    rec('S10', '失败期间正式安排零写入', (await factsSnapshot(page, 'personal')) === before, '')
    // 失败后草案存在异步 generating→needs_review 结算；结算落定前编辑/排程按钮禁用，须等状态收敛。
    await waitDraftPlanning(page, (d) => !!d && d.status !== 'generating')
    await context.unroute('**/api/assistant/propose')
    await setBudgets(page, 120)
    await confirmScopeTwice(page)
    const d2 = await waitDraftPlanning(page, (d) => (d?.planning_result?.segments ?? []).reduce((a, s) => a + s.minutes, 0) === 90)
    const segs = d2?.planning_result?.segments ?? []
    rec('S10', '离线时本地规则继续排程：总量 90、无模型调用',
      counts.propose === 1 && segs.reduce((a, s) => a + s.minutes, 0) === 90 && segs.length >= 1,
      JSON.stringify({ segs: segs.length, propose: counts.propose }))
    await shot(page, 's10-01-offline-local.png')
    await context.close()
  }

  rec('全局', '全程未触碰用户 :8000/:8020 服务', netHits.length === 0, netHits.join(','))
} catch (err) {
  console.error(' harness 异常：', err)
  exitCode = 1
} finally {
  writeFileSync(join(RUN, 'results.json'), JSON.stringify({ date: TODAY, base: BASE, backend: BACKEND, results, netHits }, null, 2))
  writeFileSync(join(RUN, 'backend.log'), backendLog)
  writeFileSync(join(RUN, 'vite.log'), viteLog)
  await browser.close()
  vite.kill()
  backend.kill()
}
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
if (failed.length || exitCode) process.exit(1)
process.exit(0)