// M3 第一步「本地替换」浏览器冒烟（2026-11-25）——纯本地闭环，不调模型。
// 真实生产页面 + 真实 IndexedDB；自起 fixture 后端（独立端口）与 Vite；
// 拦截并报告任何 :8000/:8020 命中，绝不触碰用户 8000 进程。全部虚构种子数据。
// 运行：node E:/qoder/devlog/private-evidence/assistant-mvp/M3/browser/m3-local-smoke.mjs
// 产出：同目录 run-2026-11-25/（results.json + screenshots/ + 服务日志）；任一 FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'u0-regression')
const SHOTS = join(RUN, 'screenshots')
for (const d of [RUN, SHOTS]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const PYTHON = 'D:/APP/miniconda3/python.exe'
const TOKEN = `m3-probe-${randomUUID()}`

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

// 虚构种子：目标任务（含已完成/未完成行动）+ 可替换/保留/受保护安排 + 其它任务占用 + 已结束专注会话。
function seedRecords() {
  const ws = 'personal'
  const base = { workspace_id: ws, record_version: 1, created_at: NOW_ISO, updated_at: NOW_ISO }
  const task = (id, title, deadline) => ({ ...base, id, kind: 'task', title, description: '', matter_id: null, note_ids: [], deadline, status: 'todo', completion_criteria: null, current_action_id: null, is_demo: false })
  const action = (id, task_id, text, minutes, done) => ({ id, kind: 'action', workspace_id: ws, record_version: 1, task_id, text, minutes, basis: 'user', done, created_at: NOW_ISO })
  const plan = (id, task_id, date, minutes, text, over = {}) => ({ ...base, id, kind: 'plan_item', task_id, date, planned_minutes: minutes, action_text: text, state: 'planned', actual_minutes: null, focus_session_id: null, order: 0, task_ref_state: 'active', ...over })
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
    console.log(`WAIT TIMEOUT「${text}」BODY:\n`, (await page.evaluate(() => document.body.innerText)).slice(0, 1500))
    throw e
  }
}
const btn = (page, name) => page.getByRole('button', { name, exact: true })
const bodyText = (page) => page.evaluate(() => document.body.innerText)

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
// 范围确认双轮：排程前确认 → 排程 bump → 新版再确认（与 extra_work 同机制）。
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

let exitCode = 0
const measurements = []
const taskURL = () => '/tasks/t-smoke?plan=p-1&return=' + encodeURIComponent('/today?date=' + D(1) + '&view=list')
const path = page => new URL(page.url()).hash.slice(1)
async function checkWidth(page, label, width) {
  await page.setViewportSize({width,height:844})
  await page.waitForTimeout(100)
  const size = await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))
  measurements.push({label,...size})
  rec('layout',label + ' ' + width,size.scroll <= size.width,JSON.stringify(size))
}
try {
  const {context,page,counts} = await newScene('u0-after')
  await boot(page)
  await page.goto(BASE+'#'+taskURL())
  await btn(page,'调整后续安排').click()
  await waitText(page,'调整后续安排 · 选择替换范围')
  await page.reload({waitUntil:'domcontentloaded'})
  await waitText(page,'调整后续安排 · 选择替换范围')
  await btn(page,'原任务页').click()
  rec('nav','入口刷新后返回保留任务、安排和来源',path(page) === taskURL(),path(page))
  await btn(page,'返回日程').click()
  rec('nav','回到原日期及列表',path(page) === '/today?date='+D(1)+'&view=list',path(page))
  await page.goto(BASE+'#'+taskURL())
  await btn(page,'调整后续安排').click()
  await waitText(page,'调整后续安排 · 选择替换范围')
  for (const w of [360,390,430]) await checkWidth(page,'改排入口',w)
  await page.setViewportSize({width:1440,height:1000})
  await page.getByLabel(`替换安排 ${D(0)} 整理资料（旧安排）`).check()
  await page.getByLabel(`替换安排 ${D(1)} 写报告初稿（旧安排）`).check()
  await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').fill('资料读完了，报告还需安排90分钟')
  await page.getByLabel('第 1 行工作内容').fill('撰写报告正文')
  await page.getByLabel('第 1 行分钟数').fill('90')
  await page.getByLabel('第 1 行复用行动').selectOption('a-report')
  await btn(page,'创建改排草案').click()
  await waitText(page,'核对与确认')
  await page.waitForFunction(()=>!location.hash.includes('replanTask='))
  rec('nav','创建草案后仍保留原任务返回地址',new URLSearchParams(path(page).slice(path(page).indexOf('?')+1)).get('return') === taskURL(),path(page))
  await page.reload({waitUntil:'domcontentloaded'})
  await waitText(page,'继续已有草案（1）')
  await page.locator('main li button').first().click()
  await waitText(page,'核对与确认')
  for (const w of [360,390,430]) {
    await checkWidth(page,'改排编辑',w)
    await btn(page,'预览').click()
    await checkWidth(page,'改排预览',w)
    await btn(page,'编辑').click()
  }
  await shot(page,'replan-mobile.png')
  await page.setViewportSize({width:1440,height:1000})
  await setBudgets(page,120)
  await confirmScopeTwice(page)
  await waitText(page,'就绪核对通过，可采用')
  await btn(page,'采用计划').click()
  await page.getByRole('alertdialog').getByRole('button',{name:/^确认替换 2 条旧安排，新增 \d+ 条安排$/}).click()
  await waitText(page,'已采用：')
  const plans=await docsOf(page,'personal','plan_item')
  rec('data','采用仅取消所选两条，保留未选安排',plans.find(p=>p.id==='p-1')?.state==='cancelled' && plans.find(p=>p.id==='p-2')?.state==='cancelled' && plans.find(p=>p.id==='p-keep')?.state==='planned','')
  await btn(page,'查看任务').first().click()
  rec('nav','采用后查看任务保留完整上下文',path(page)===taskURL(),path(page))
  await btn(page,'返回日程').click()
  rec('nav','采用后的返回日程仍为原日期列表',path(page)==='/today?date='+D(1)+'&view=list',path(page))
  await page.goto(BASE+'#/assistant?replanTask=t-smoke&return='+encodeURIComponent('/tasks/t-other'))
  await waitText(page,'调整后续安排 · 选择替换范围')
  await btn(page,'原任务页').click()
  rec('nav','其它任务返回参数被拒绝',path(page)==='/tasks/t-smoke',path(page))
  await page.goto(BASE+'#/assistant?replanTask=t-smoke')
  await waitText(page,'调整后续安排 · 选择替换范围')
  await btn(page,'原任务页').click()
  rec('nav','无来源旧入口正常回当前任务',path(page)==='/tasks/t-smoke',path(page))
  await page.goto(BASE+'#/assistant')
  await btn(page,'载入演示：跨天周报').click()
  await waitText(page,'资料核对（独立于采用）')
  for (const w of [360,390,430,768,1440]) {
    await checkWidth(page,'普通草案编辑',w)
    if(w<768){await btn(page,'预览').click();await checkWidth(page,'普通草案预览',w);await btn(page,'编辑').click()}
  }
  await page.setViewportSize({width:390,height:844})
  await page.getByLabel('任务标题',{exact:true}).fill('这是一个用来检查移动端布局的较长任务名称，核对日期和行动后再加入日程')
  await checkWidth(page,'长任务标题',390)
  await shot(page,'ordinary-mobile.png')
  const dateButton=page.getByLabel('任务 rpt 截止',{exact:true})
  await dateButton.click()
  await checkWidth(page,'日期选择弹层',390)
  await btn(page,'明天').click()
  rec('layout','窄屏日期控件可以操作',true,'选择明天')
  rec('isolation','未调用分析或模型',counts.propose===0&&counts.analyze===0,JSON.stringify(counts))
  rec('isolation','未访问用户服务',netHits.length===0,netHits.length)
  await context.close()
} catch(e) {console.error(e);rec('runner','验收异常',false,e.message);exitCode=1} finally {
  writeFileSync(join(RUN,'results.json'),JSON.stringify({results,measurements,netHits},null,2))
  writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog)
  await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass)) exitCode=1
console.log('TOTAL',results.filter(r=>r.pass).length+'/'+results.length)
process.exit(exitCode)


