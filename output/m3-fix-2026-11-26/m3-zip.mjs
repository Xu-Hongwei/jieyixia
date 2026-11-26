// M3 专属真实 ZIP 浏览器往返证据（2026-11-26 整改）——真实 IDB + 真实导出/恢复，不调模型。
// 覆盖：新草案(ready，含待处理 prepare) + 已采用改排历史，导出→恢复到新空间；引用重映射；
// 不恢复待处理授权（assistant_ops 导出排除）；旧 0.5.0 备份仍可读（默认 mode=create）。
// 自起 fixture 后端 + Vite（独立端口），拦截并报告 :8000/:8020 命中；全部虚构种子。
// 产出：m3-fix-2026-11-26/zip-roundtrip/（results.json + screenshots/ + downloads/ + 服务日志）。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'zip-roundtrip')
const SHOTS = join(RUN, 'screenshots')
const DL = join(RUN, 'downloads')
for (const d of [RUN, SHOTS, DL]) mkdirSync(d, { recursive: true })
const require = createRequire('file:///E:/qoder/frontend/package.json')
const { unzipSync } = require('fflate')
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const PYTHON = 'D:/APP/miniconda3/python.exe'
const TOKEN = `m3-zip-${randomUUID()}`

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

// 旧版 0.5.0 备份样本：从 M2 历史下载目录复制到本证据目录（只读复制，不移动原件）。
const LEGACY_SRC = 'E:/qoder/devlog/private-evidence/assistant-mvp/M2/browser/run-2026-11-25/downloads/截下来-个人空间-20261125-192247.jxl-backup.zip'
const LEGACY = join(DL, 'legacy-0.5.0.jxl-backup.zip')
if (!existsSync(LEGACY_SRC)) throw new Error(`缺少旧版样本：${LEGACY_SRC}`)
copyFileSync(LEGACY_SRC, LEGACY)

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
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
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
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR:', m.text().slice(0, 600)) })
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
const threadsOf = async (page, ws) => (await idbAll(page, 'assistant_threads')).filter((t) => t.workspace_id === ws)
const opsOf = async (page, ws) => (await idbAll(page, 'assistant_ops')).filter((o) => o.workspace_id === ws)
const wsOf = (page) => page.evaluate(() => localStorage.getItem('jxl-workspace'))
const activeDraft = async (page, ws) => {
  const ds = await draftsOf(page, ws)
  return ds.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] ?? null
}

function seedRecords() {
  const ws = 'personal'
  // Task/Action/PlanItem 契约不含 record_version（additionalProperties:false）；只有 focus_session 可带。
  const base = { workspace_id: ws, created_at: NOW_ISO, updated_at: NOW_ISO }
  const task = (id, title, deadline) => ({ ...base, id, kind: 'task', title, description: '', matter_id: null, note_ids: [], deadline, status: 'todo', completion_criteria: null, current_action_id: null, is_demo: false })
  const action = (id, task_id, text, minutes, done) => ({ id, kind: 'action', workspace_id: ws, task_id, text, minutes, basis: 'user', done, created_at: NOW_ISO })
  const plan = (id, task_id, date, minutes, text, over = {}) => ({ id, kind: 'plan_item', workspace_id: ws, task_id, date, planned_minutes: minutes, action_text: text, state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over })
  return [
    task('t-smoke', '虚构：课程报告', { value: D(6), precision: 'date', source: 'manual', from_note_id: null, confirmed_at: NOW_ISO }),
    task('t-other', '虚构：其它任务', { value: null, precision: 'none', source: 'note', from_note_id: null, confirmed_at: null }),
    action('a-read', 't-smoke', '阅读资料', 60, true),
    action('a-report', 't-smoke', '撰写报告正文', 90, false),
    plan('p-1', 't-smoke', D(0), 30, '整理资料（旧安排）'),
    plan('p-2', 't-smoke', D(1), 45, '写报告初稿（旧安排）'),
    plan('p-keep', 't-smoke', D(2), 20, '核对数据（保留）'),
    plan('p-prot', 't-smoke', D(3), 30, '已投入的安排', { actual_minutes: 10 }),
    plan('p-foc', 't-smoke', D(4), 30, '有专注记录的安排'),
    plan('p-other', 't-other', D(0), 60, '其它任务的安排'),
    {
      id: 'f-1', kind: 'focus_session', workspace_id: ws, record_version: 0,
      task_id: 't-smoke', action_id: 'a-report', plan_item_id: 'p-foc',
      started_at: `${D(0)}T09:00:00+08:00`, ended_at: `${D(0)}T09:30:00+08:00`,
      accumulated_ms: 1800000, running: false, outcome: 'done', draft_md: '', is_demo: false,
    },
  ]
}
async function seed(page) {
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
  }), seedRecords())
}

async function waitText(page, text, timeout = 20000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout })
  } catch (e) {
    console.log(`WAIT TIMEOUT「${text}」BODY:\n`, (await page.evaluate(() => document.body.innerText)).slice(0, 1800))
    throw e
  }
}
const btn = (page, name) => page.getByRole('button', { name, exact: true })
const bodyText = (page) => page.evaluate(() => document.body.innerText)
async function waitForFunction(page, fn, timeout = 15000) {
  return page.waitForFunction(fn, null, { timeout })
}
async function waitDraftStatus(page, ws, status, timeout = 20000) {
  const deadline = Date.now() + timeout
  let last = null
  for (;;) {
    last = await activeDraft(page, ws)
    if (last?.status === status) return last
    if (Date.now() > deadline) throw new Error(`waitDraftStatus 超时：${JSON.stringify({ rev: last?.revision, status: last?.status })}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function boot(page) {
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await waitText(page, '日程', 20000)
  await seed(page)
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
async function confirmAll(page) {
  for (const label of ['确认仍有未排', '确认过载', '确认额外工作']) {
    while (await btn(page, label).count()) { await btn(page, label).first().click(); await page.waitForTimeout(150) }
  }
}

// 改排草案 A：替换 p-1（30 分钟）→ 90 分钟复用 a-report，保存并采用（形成已采用历史）。
async function replanAdoptA(page) {
  await page.getByLabel('选择要调整的任务').selectOption('t-smoke')
  await btn(page, '选择任务并调整').click()
  await waitText(page, '调整后续安排 · 选择替换范围')
  await page.getByLabel(`替换安排 ${D(0)} 整理资料（旧安排）`).check()
  await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').fill('资料读完了，报告还需安排 90 分钟')
  await page.getByLabel('第 1 行工作内容').fill('撰写报告正文')
  await page.getByLabel('第 1 行分钟数').fill('90')
  await page.getByLabel('第 1 行复用行动').selectOption('a-report')
  await btn(page, '创建改排草案').click()
  await waitText(page, '核对与确认', 20000)
  await setBudgets(page, 120)
  await btn(page, '重新排程').click()
  await waitText(page, '排程前需先确认下方事项', 15000)
  await confirmScopeTwice(page)
  await waitText(page, '就绪核对通过，可采用', 15000)
  const d = await activeDraft(page, 'personal')
  await btn(page, '采用计划').click()
  await waitText(page, '确认采用计划')
  const label = `确认替换 1 条旧安排，新增 ${d.planning_result.segments.length} 条安排`
  await btn(page, label).click()
  await waitText(page, '采用成功', 30000)
  return d
}

// 改排草案 B：替换 p-2 → 30 分钟复用 a-report，排程就绪但不采用；随后打开采用框创建待处理 prepare 再取消。
async function replanReadyB(page) {
  // 离开并重新进入助手页（真实路由切换 → 组件重挂载），关闭已采用草案回到列表，再新建第二份改排草案。
  await page.evaluate(() => { location.hash = '#/today' })
  await page.waitForTimeout(400)
  await page.evaluate(() => { location.hash = '#/assistant' })
  await waitForFunction(page, () => document.body.innerText.includes('调整已有任务（改排）') || document.body.innerText.includes('返回列表'), 20000)
  if (!(await bodyText(page)).includes('调整已有任务（改排）')) {
    await page.getByRole('button', { name: /返回列表/ }).click()
    await waitText(page, '调整已有任务（改排）', 15000)
  }
  await waitText(page, '调整已有任务（改排）', 15000)
  await page.getByLabel('选择要调整的任务').selectOption('t-smoke')
  await btn(page, '选择任务并调整').click()
  await waitText(page, '调整后续安排 · 选择替换范围')
  await page.getByLabel(`替换安排 ${D(1)} 写报告初稿（旧安排）`).check()
  await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').fill('初稿还需补齐 30 分钟')
  await page.getByLabel('第 1 行工作内容').fill('撰写报告正文')
  await page.getByLabel('第 1 行分钟数').fill('30')
  await page.getByLabel('第 1 行复用行动').selectOption('a-report')
  await btn(page, '创建改排草案').click()
  await waitText(page, '核对与确认', 20000)
  await setBudgets(page, 120)
  await btn(page, '重新排程').click()
  if (await btn(page, '确认替换范围').count()) {
    await btn(page, '确认替换范围').click()
    await page.waitForTimeout(200)
    await btn(page, '重新排程').click()
  }
  await waitText(page, '七天预览（按日竖排）')
  await waitForFunction(page, () => !document.body.innerText.includes('尚未排程'))
  if (await btn(page, '确认替换范围').count()) { await btn(page, '确认替换范围').click(); await page.waitForTimeout(200) }
  await confirmAll(page)
  await waitText(page, '就绪核对通过，可采用', 20000)
  const d = await activeDraft(page, 'personal')
  // 打开采用框 = prepare 冻结并写入待处理台账；取消后草案保持 ready，授权仍待处理。
  await btn(page, '采用计划').click()
  await waitText(page, '确认采用计划')
  await page.getByRole('alertdialog').getByRole('button', { name: '取消' }).click()
  await page.waitForFunction(() => !document.body.innerText.includes('确认采用计划'), null, { timeout: 5000 })
  return d
}

let exitCode = 0
try {
  const { context, page, counts } = await newScene('ZIP')
  await boot(page)

  // ===== 准备：A 已采用（留 committed 采用台账）+ B 就绪未采用（打开又取消采用框）=====
  await page.evaluate(() => { location.hash = '#/assistant' })
  await waitText(page, '调整已有任务（改排）')
  const dA = await replanAdoptA(page)
  const preBPlans = await docsOf(page, 'personal', 'plan_item')
  rec('ZIP', 'A 已采用：p-1 取消且新安排 90 分钟',
    (await activeDraft(page, 'personal'))?.status === 'applied'
    && preBPlans.find((p) => p.id === 'p-1')?.state === 'cancelled'
    && preBPlans.filter((p) => !['p-1', 'p-2', 'p-keep', 'p-prot', 'p-foc', 'p-other'].includes(p.id)).reduce((s, p) => s + p.planned_minutes, 0) === 90, '')
  const dB = await replanReadyB(page)
  const opsAfterB = await opsOf(page, 'personal')
  rec('ZIP', '导出前：A 留 committed 台账；B 就绪且取消采用框不新增授权（prepare 零写入）',
    dB?.status === 'ready' && opsAfterB.length === 1 && opsAfterB[0].state === 'committed',
    JSON.stringify({ status: dB?.status, ops: opsAfterB.map((o) => o.state), ids: dB?.replan_scope?.replacement_ids }))

  const srcTasks = await docsOf(page, 'personal', 'task')
  const srcActions = await docsOf(page, 'personal', 'action')
  const srcPlans = await docsOf(page, 'personal', 'plan_item')
  const srcDrafts = await draftsOf(page, 'personal')
  const srcThreads = await threadsOf(page, 'personal')
  rec('ZIP', '导出前源空间：2 份改排草案（applied/ready）+ 2 线程 + 题面引用完整',
    srcDrafts.length === 2 && srcThreads.length === 2
    && srcDrafts.some((d) => d.status === 'applied') && srcDrafts.some((d) => d.status === 'ready')
    && srcDrafts.every((d) => srcThreads.some((t) => t.id === d.thread_id)), JSON.stringify({ drafts: srcDrafts.length, threads: srcThreads.length }))

  // ===== 真实导出 =====
  await page.evaluate(() => { location.hash = '#/data' })
  await waitText(page, '导出当前空间备份')
  await shot(page, 'z-01-export.png')
  const dlWait = page.waitForEvent('download', { timeout: 30000 }).catch(() => null)
  await btn(page, '导出当前空间备份').click()
  const download = await dlWait
  if (!download) {
    console.log('EXPORT-FAIL BODY:', (await bodyText(page)).slice(0, 2500))
    await shot(page, 'z-export-fail.png')
    throw new Error('导出未产生下载')
  }
  const zipPath = join(DL, download.suggestedFilename())
  await download.saveAs(zipPath)
  rec('ZIP', '真实导出 ZIP 已落盘', download.suggestedFilename().endsWith('.zip'), download.suggestedFilename())
  const zipEntries = unzipSync(new Uint8Array(readFileSync(zipPath)))
  const zipNames = Object.keys(zipEntries)
  rec('ZIP', '备份包条目不含 assistant_ops（授权台账不随备份导出）',
    zipNames.includes('data/assistant_drafts.json') && zipNames.includes('data/assistant_threads.json')
    && !zipNames.some((n) => n.includes('assistant_ops')), zipNames.join(','))
  const draftsPayload = JSON.parse(Buffer.from(zipEntries['data/assistant_drafts.json']).toString('utf8'))
  rec('ZIP', '备份内草案载荷为 applied+ready 两份改排草案（0.6.0 契约包装）',
    draftsPayload.schema_version === '0.6.0' && draftsPayload.drafts.length === 2
    && draftsPayload.drafts.every((d) => d.mode === 'replan'),
    JSON.stringify({ v: draftsPayload.schema_version, n: draftsPayload.drafts.length }))

  // ===== 恢复到新空间 =====
  await page.locator('input[type="file"]').setInputFiles(zipPath)
  await waitText(page, '恢复到新空间')
  await page.locator('#restore-name').fill('M3 改排往返验证')
  await btn(page, '恢复到新空间').click()
  await waitText(page, '恢复完成', 30000)
  await btn(page, '进入恢复空间').click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), null, { timeout: 10000 })
  const rws = await wsOf(page)
  const rTasks = await docsOf(page, rws, 'task')
  const rActions = await docsOf(page, rws, 'action')
  const rPlans = await docsOf(page, rws, 'plan_item')
  const rDrafts = await draftsOf(page, rws)
  const rThreads = await threadsOf(page, rws)
  const rOps = await opsOf(page, rws)
  rec('ZIP', '恢复空间对象数量一致（任务/行动/安排/草案/线程）',
    rws !== 'personal' && rTasks.length === srcTasks.length && rActions.length === srcActions.length
    && rPlans.length === srcPlans.length && rDrafts.length === 2 && rThreads.length === 2,
    JSON.stringify({ ws: rws, tasks: rTasks.length, actions: rActions.length, plans: rPlans.length, drafts: rDrafts.length, threads: rThreads.length }))
  rec('ZIP', '恢复空间无任何授权台账（applied 历史不重放、不恢复 pending/committed 采用授权）', rOps.length === 0, `ops=${rOps.length}`)

  const newTask = rTasks.find((t) => t.title === '虚构：课程报告')
  const newAction = rActions.find((a) => a.text === '撰写报告正文')
  const newP2 = rPlans.find((p) => p.action_text === '写报告初稿（旧安排）')
  const newP1 = rPlans.find((p) => p.action_text === '整理资料（旧安排）')
  const rApplied = rDrafts.find((d) => d.status === 'applied')
  const rReady = rDrafts.find((d) => d.status === 'needs_review' && d.mode === 'replan' && d.id !== rApplied?.id)
  rec('ZIP', '草案状态按恢复语义：applied 保留、未采用草案转 needs_review（需重新核对，不恢复待处理授权）',
    !!rApplied && !!rReady && rApplied.mode === 'replan' && rReady.mode === 'replan', JSON.stringify({ applied: rApplied?.mode, ready: rReady?.mode, status: rReady?.status }))
  rec('ZIP', '范围与提案引用重映射到恢复空间新 ID（任务/行动/替换安排）',
    !!newTask && !!newAction && !!newP2
    && rReady.replan_scope.task_id === newTask.id
    && JSON.stringify(rReady.replan_scope.replacement_ids) === JSON.stringify([newP2.id])
    && rReady.proposal.work_items[0].task_ref.id === newTask.id
    && rReady.proposal.work_items[0].action_ref.kind === 'existing'
    && rReady.proposal.work_items[0].action_ref.id === newAction.id
    && rReady.replacement_baseline.items[0].plan_item_id === newP2.id,
    JSON.stringify({ task: rReady.replan_scope.task_id === newTask?.id, ids: rReady.replan_scope.replacement_ids, want: [newP2?.id], action: rReady.proposal.work_items[0].action_ref }))
  rec('ZIP', '已采用历史回执引用重映射（replan_task_id + 取消集）',
    !!rApplied && !!newP1
    && rApplied.applied_summary.replan_task_id === newTask.id
    && rApplied.applied_summary.cancelled_plan_item_ids.length === 1
    && rApplied.applied_summary.cancelled_plan_item_ids[0] === newP1.id,
    JSON.stringify({ task: rApplied?.applied_summary?.replan_task_id, cancel: rApplied?.applied_summary?.cancelled_plan_item_ids, want: [newP1?.id] }))
  const msgShape = (ts) => ts.map((t) => (t.messages ?? []).map((m) => m.role).join('/')).sort().join(',')
  rec('ZIP', '线程引用随迁且消息逐条保留（线程 ID 重映射后草案仍归属同线程）',
    rDrafts.every((d) => rThreads.some((t) => t.id === d.thread_id))
    && msgShape(rThreads) === msgShape(srcThreads ?? []),
    JSON.stringify({ src: msgShape(srcThreads ?? []), restored: msgShape(rThreads), draftThread: rDrafts.map((d) => d.thread_id), threadIds: rThreads.map((t) => t.id) }))
  const oldRefLeak = rDrafts.filter((d) => JSON.stringify(d).includes('"t-smoke"') || JSON.stringify(d).includes('"a-report"') || JSON.stringify(d).includes('"p-2"') || JSON.stringify(d).includes('"p-1"'))
  rec('ZIP', '恢复后不存在旧工作区 ID 泄漏（t-smoke/a-report/p-1/p-2）', oldRefLeak.length === 0, oldRefLeak.map((d) => d.id).join(','))
  await shot(page, 'z-02-restored.png')

  // ===== 旧 0.5.0 备份仍可读：恢复到另一新空间 =====
  await page.evaluate(() => { location.hash = '#/data' })
  await waitText(page, '导出当前空间备份')
  await page.locator('input[type="file"]').setInputFiles(LEGACY)
  await waitText(page, '恢复到新空间')
  await page.locator('#restore-name').fill('M3 旧 0.5.0 兼容')
  await btn(page, '恢复到新空间').click()
  await waitText(page, '恢复完成', 30000)
  await btn(page, '进入恢复空间').click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), null, { timeout: 10000 })
  const lws = await wsOf(page)
  const lTasks = await docsOf(page, lws, 'task')
  const lActions = await docsOf(page, lws, 'action')
  const lPlans = await docsOf(page, lws, 'plan_item')
  const lDrafts = await draftsOf(page, lws)
  const lThreads = await threadsOf(page, lws)
  const lOps = await opsOf(page, lws)
  const ld = lDrafts[0]
  rec('ZIP', '旧 0.5.0 备份可读：数量一致',
    lws !== rws && lTasks.length === 1 && lActions.length === 2 && lPlans.length === 4 && lThreads.length === 1 && lDrafts.length === 1,
    JSON.stringify({ ws: lws, tasks: lTasks.length, actions: lActions.length, plans: lPlans.length, threads: lThreads.length }))
  rec('ZIP', '旧 0.5.0 缺省语义：mode 缺省按 create 解释、无改排范围、无待处理授权',
    (ld?.mode ?? 'create') === 'create' && ld?.replan_scope == null && ld?.status === 'applied' && lOps.length === 0,
    JSON.stringify({ rawMode: ld?.mode ?? null, mode: ld?.mode ?? 'create', scope: ld?.replan_scope ?? null, status: ld?.status, ops: lOps.length }))
  rec('ZIP', '旧 0.5.0 已采用回执与依赖约束随迁',
    ld?.proposal?.work_items?.[1]?.depends_on?.join(',') === 'w1'
    && (ld?.applied_summary?.id_map ?? []).every((m) => m.object_type === 'task' ? lTasks.some((t) => t.id === m.formal_id) : m.object_type === 'action' ? lActions.some((a) => a.id === m.formal_id) : lPlans.some((p) => p.id === m.formal_id)),
    JSON.stringify({ deps: ld?.proposal?.work_items?.[1]?.depends_on }))
  await shot(page, 'z-03-legacy.png')

  rec('ZIP', '全程未调模型、未触碰用户 :8000/:8020', counts.propose === 0 && counts.analyze === 0 && netHits.length === 0, JSON.stringify({ propose: counts.propose, analyze: counts.analyze, hits: netHits }))
  await context.close()
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
