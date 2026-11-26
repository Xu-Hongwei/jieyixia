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
const RUN = join(HERE, 'execution-extra')
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

let exitCode=0
const pause=page=>page.waitForTimeout(250)
const goto=async(page,target)=>{await page.goto(BASE+'#'+target);await pause(page)}
try{
 const {context,page,counts}=await newScene('U2-extra');await boot(page)
 await goto(page,'/today?plan=p-1');await btn(page,'开始这项安排').click()
 const start=page.getByRole('dialog',{name:'开始这项安排',exact:true})
 await start.waitFor();rec('start','无当前行动时确认开始禁用',await start.getByRole('button',{name:'确认并开始',exact:true}).isDisabled(),'')
 const before=(await docsOf(page,'personal','focus_session')).length
 await start.getByRole('button',{name:'取消',exact:true}).click()
 rec('start','取消开始不创建会话且回到详情',(await docsOf(page,'personal','focus_session')).length===before&&await page.getByRole('dialog',{name:'工作安排详情',exact:true}).count()===1,'')
 await btn(page,'编辑').click();await page.getByLabel('工作说明').fill('虚构：离线重试保留输入')
 await context.setOffline(true)
 await page.evaluate(()=>{window.__originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,...rest){if(v?.kind==='plan_item'&&v.id==='p-1')throw new DOMException('U2 fixture failure','QuotaExceededError');return window.__originalPut.call(this,v,...rest)}})
 await btn(page,'保存修改').click();await waitText(page,'重试保存（同一请求）')
 rec('save','安排保存失败保留输入和重试入口',await page.getByLabel('工作说明').inputValue()==='虚构：离线重试保留输入'&&(await docsOf(page,'personal','plan_item')).find(p=>p.id==='p-1').action_text==='整理资料（旧安排）','')
 await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__originalPut;delete window.__originalPut})
 await btn(page,'重试保存（同一请求）').click();await waitText(page,'安排详情')
 rec('save','离线原请求重试正确保存一次',(await docsOf(page,'personal','plan_item')).filter(p=>p.id==='p-1'&&p.action_text==='虚构：离线重试保留输入').length===1,'')
 await context.setOffline(false);await page.getByLabel('关闭工作面板').click()
 await goto(page,'/today?plan=p-other');await btn(page,'取消安排').click();await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click()
 rec('cancel','取消确认框不改变安排',(await docsOf(page,'personal','plan_item')).find(p=>p.id==='p-other').state==='planned','')
 await btn(page,'取消安排').click();await page.getByRole('alertdialog').getByRole('button',{name:'取消安排',exact:true}).click();await pause(page)
 rec('cancel','确认取消保留任务和安排历史',(await docsOf(page,'personal','plan_item')).find(p=>p.id==='p-other').state==='cancelled'&&(await docsOf(page,'personal','task')).some(t=>t.id==='t-other'),'')
 rec('history','已取消安排无编辑与改期入口',await btn(page,'编辑').count()===0&&await btn(page,'改期').count()===0,'')
 await page.getByLabel('关闭工作面板').click();await goto(page,'/today?plan=p-2');await btn(page,'确认进度').click();await page.getByRole('alertdialog').getByLabel('部分完成（之后还可继续确认）').check();await page.getByRole('alertdialog').getByRole('button',{name:'确认进度',exact:true}).click();await pause(page)
 rec('progress','部分完成后保留另安排一天入口',(await docsOf(page,'personal','plan_item')).find(p=>p.id==='p-2').state==='partial'&&await btn(page,'另安排一天').count()===1&&await btn(page,'编辑').count()===0,'')
 await page.getByLabel('关闭工作面板').click();await goto(page,'/tasks/t-smoke');await page.getByRole('button',{name:'安排详情：虚构：离线重试保留输入',exact:true}).click()
 await page.getByRole('dialog',{name:'工作安排详情',exact:true}).getByRole('link',{name:'虚构：课程报告',exact:true}).click();await pause(page)
 rec('nav','同一任务更新返回来源后关闭旧面板',await page.getByRole('dialog',{name:'工作安排详情',exact:true}).count()===0&&page.url().includes('return='),new URL(page.url()).hash)
 await btn(page,'安排工作').click();await page.getByLabel('工作说明').fill('虚构：任务同页返回保护');await page.goBack();await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:'放弃草稿',exact:true}).click();await pause(page)
 rec('guard','任务同页返回放弃后关闭草稿',await page.getByLabel('关闭工作面板').count()===0&&!page.url().includes('plan=p-1'),'')
 await btn(page,'设为当前').click();await pause(page)
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'日程',exact:true}).click();await goto(page,'/today?plan=p-1');await btn(page,'开始这项安排').click();await start.waitFor()
 rec('start','选择行动后开始确认可用',await start.getByRole('button',{name:'确认并开始',exact:true}).isEnabled(),'')
 await start.getByRole('button',{name:'确认并开始',exact:true}).click();await page.waitForURL(/#\/work\//)
 rec('start','确认开始进入工作并绑定原安排',(await docsOf(page,'personal','focus_session')).some(s=>s.plan_item_id==='p-1'&&s.action_id==='a-report'&&s.ended_at==null),'')
 rec('isolation','无模型请求与用户服务访问',counts.analyze===0&&counts.propose===0&&netHits.length===0,'')
 await context.close()
}catch(e){console.error(e);rec('runner','验收异常',false,e.message);exitCode=1}finally{
 writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2));writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog)
 await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass))exitCode=1
console.log('TOTAL',results.filter(r=>r.pass).length+'/'+results.length);process.exit(exitCode)
