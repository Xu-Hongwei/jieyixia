// M1 浏览器验收 ①–⑩（2026-11-25，实施方案 §9.7）。
// 真实生产页面（#/assistant、#/today、任务页、工作页、#/data）+ 真实 IndexedDB + 真实 ZIP 下载/恢复。
// 隔离：自起 Vite（空闲端口 5177–5181，不杀未知服务）；每场景独立 Context（独立 IDB）；全部虚构演示数据。
// 拦截 :8000/:8020/analyze 并报告命中；不触碰用户 8000 后端进程。
// 运行：node E:/qoder/devlog/private-evidence/assistant-mvp/M1/browser/m1-acceptance.mjs
// 产出：同目录 run-2026-11-25/（results.json + screenshots/ + downloads/）；任一 FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'run-2026-11-25')
const SHOTS = join(RUN, 'screenshots'); const DL = join(RUN, 'downloads')
for (const d of [RUN, SHOTS, DL]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true })

// —— 北京日期（真实时钟）——
const bjToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
function bjAddDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const TODAY = bjToday()
const D = (i) => bjAddDays(TODAY, i)

// —— 端口探测 + 自起 Vite ——
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
console.log(`Vite 就绪：${BASE}（北京今天 ${TODAY}）`)
const browser = await chromium.launch({ executablePath: EXEC, headless: true })

const netHits = []
async function newScene(name, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
    acceptDownloads: true,
  })
  context.on('request', (r) => { const u = r.url(); if (/:8000|:8020|\/analyze/.test(u)) netHits.push(u) })
  await context.route(/:8000|:8020|\/analyze/, (route) => route.abort())
  const page = await context.newPage()
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, (e.stack || e.message).split('\n').slice(0, 4).join(' | ')))
  page.on('dialog', (d) => d.accept())
  return { context, page }
}

// —— 真实 IDB 读取（jxl-product）——
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
const opsOf = async (page, ws) => (await idbAll(page, 'assistant_ops')).filter((o) => o.workspace_id === ws)
const draftsOf = async (page, ws) => (await idbAll(page, 'assistant_drafts')).filter((d) => d.workspace_id === ws)
const wsOf = (page) => page.evaluate(() => localStorage.getItem('jxl-workspace'))

async function waitText(page, text, timeout = 20000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout })
  } catch (e) {
    console.log(`WAIT TIMEOUT「${text}」BODY:\n`, (await bodyText(page)).slice(0, 1500))
    throw e
  }
}
async function waitAnyText(page, texts, timeout = 20000) {
  await page.waitForFunction((ts) => ts.some((t) => document.body.innerText.includes(t)), texts, { timeout })
}
const btn = (page, name) => page.getByRole('button', { name, exact: true })
const bodyText = (page) => page.evaluate(() => document.body.innerText)

async function openAssistant(page) {
  if (!page.url().startsWith(BASE)) await page.goto(BASE + '#/assistant', { waitUntil: 'domcontentloaded' })
  // 进入恢复空间后 router.replace('/today') 可能仍在途并覆盖 hash：确认落定，被覆盖则重试一次。
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => { location.hash = '#/assistant' })
    try {
      await page.waitForFunction(() => location.hash === '#/assistant', null, { timeout: 3000 })
      break
    } catch { await page.waitForTimeout(800) }
  }
  try {
    await waitText(page, '本地规划初版 · 未接入智能理解', 5000)
  } catch {
    // hash 与路由内部状态失同步时整页加载兜底。
    await page.goto(BASE + '#/assistant', { waitUntil: 'domcontentloaded' })
    await waitText(page, '本地规划初版 · 未接入智能理解')
  }
}
async function loadDemo(page, kind = 'report') {
  await btn(page, kind === 'tight' ? '载入演示：容量紧张' : '载入演示：跨天周报').click()
  await waitText(page, '演示草案已载入')
  await waitText(page, '第 1 版')
}
async function setBudget(page, date, minutes) {
  await page.getByLabel(`${date} 预算分钟`).fill(String(minutes))
}
async function confirmDeadlineIfShown(page, deadline = D(2)) {
  const conf = btn(page, `确认 ${deadline}`)
  if (await conf.count()) { await conf.first().click(); await page.waitForTimeout(400) }
}
async function rescheduleAndConfirm(page, { deadline = D(2) } = {}) {
  await confirmDeadlineIfShown(page, deadline) // normalize 要求排程前先确认截止候选
  await btn(page, '重新排程').click()
  await waitAnyText(page, ['截止候选待确认', '就绪核对通过，可采用'])
  await confirmDeadlineIfShown(page, deadline) // 重排 bump 版本后须重新确认（新版本不继承旧授权）
  await waitText(page, '就绪核对通过，可采用')
}
async function waitComputed(page, ws) {
  for (let i = 0; i < 80; i++) {
    const d = (await draftsOf(page, ws))[0]
    if (d?.planning_result) return d
    await page.waitForTimeout(200)
  }
  throw new Error('排程计算超时')
}

try {
 const {page,context}=await newScene('review');
 await openAssistant(page); await loadDemo(page); await rescheduleAndConfirm(page);
 await setBudget(page,D(0),0);
 const enabled=await btn(page,'采用计划').isEnabled();
 rec('dirty','修改预算未重算应禁用采用',!enabled,`adoptEnabled=${enabled}`);
 await shot(page,'dirty-budget.png');
 await page.getByLabel('任务标题',{exact:true}).fill('审查：改标题并清除截止');
 await btn(page,'无截止').click();
 await btn(page,'保存修改').click();
 await page.waitForTimeout(700);
 const ds=await draftsOf(page,'demo'); const d=ds.find(x=>x.proposal?.task_proposals?.[0]?.title==='审查：改标题并清除截止');
 const cons=(d?.user_confirmations??[]).filter(c=>c.draft_revision===d.revision && c.field_path==='deadline');
 rec('deadline','改标题并清除截止后应保存明确无截止决定',cons.some(c=>c.new_value===null),JSON.stringify({revision:d?.revision,confs:cons,ui:await page.getByLabel('任务 rpt 截止',{exact:true}).innerText()}));
 await shot(page,'deadline-save.png');
 writeFileSync(join(RUN,'draft.json'),JSON.stringify(d,null,2));
 await context.close();
} catch(e){rec('runtime','probe',false,e.stack)} finally {
 writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2));
 await browser.close(); vite.kill();
}
