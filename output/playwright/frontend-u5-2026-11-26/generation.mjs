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
const RUN = join(HERE, 'generation-quota-final')
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
const btn = (page, name) => page.getByRole('button', { name, exact: true }).filter({ visible: true })
const bodyText = (page) => page.evaluate(() => document.body.innerText)

async function boot(page) {
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await waitText(page, '日程', 20000)
  await seed(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitText(page, '日程', 20000)
}
async function setBudgets(page, minutes) {
  const details=page.locator('section[aria-label="核对建议"] details').filter({has:page.getByText(/可用时间 ·/)}); if(!(await details.evaluate(e=>e.open)))await details.locator('summary').click()
  for (let i = 0; i < 7; i += 1) {
    await page.getByLabel(`${D(i)} 预算分钟`).fill(String(minutes))
  }
}
// 范围确认双轮：排程前确认 → 排程 bump → 新版再确认（与 extra_work 同机制）。
async function confirmScopeTwice(page) {
  await btn(page, '确认替换范围').click()
  await page.waitForTimeout(200)
  await btn(page, '保存并预览').click()
  await waitText(page, '每日安排')
  await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
  if (await btn(page, '确认替换范围').count()) {
    await btn(page, '确认替换范围').click()
    await page.waitForTimeout(200)
  }
}
async function confirmAll(page) {
  if(await btn(page,'确认 '+D(2)).count())await btn(page,'确认 '+D(2)).click()
  for (const label of ['确认仍有未排', '确认过载', '确认额外工作']) {
    while (await btn(page, label).count()) { await btn(page, label).first().click(); await page.waitForTimeout(150) }
  }
}



let exitCode=0,debugPage
const pause=p=>p.waitForTimeout(250)
const step=(p,n)=>p.getByRole('navigation',{name:'规划步骤'}).getByRole('button',{name:new RegExp('^'+n+' ')})
const nav=(p,name)=>p.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name,exact:true})
async function start(p){await p.goto(BASE+'#/assistant');await waitText(p,'提供资料与需求');await pause(p)}
async function paste(p){await p.getByPlaceholder('粘贴通知、要求或原文…').fill('虚构通知：整理资料后写报告，要求分成两天完成。');await btn(p,'保存文字').click();await pause(p)}
async function generated(p){await p.waitForFunction(async()=>{const {useAssistantStore}=await import('/src/stores/assistant.js');return ['done','failed','save_failed','clarification'].includes(useAssistantStore().gen?.phase)});await pause(p)}
try{
 {
 const {context,page,counts}=await newScene('U4-generate');debugPage=page;const reqs=[];page.on('request',r=>{if(r.url().includes('/api/assistant/propose'))reqs.push(r.postDataJSON())})
 await start(page);await paste(page);await page.getByLabel('你想完成什么？有什么要求？').fill('虚构测试：每天60分钟，分两天完成')
 await page.locator('summary').filter({hasText:'可用时间'}).click();for(let i=0;i<7;i++)await page.getByLabel(D(i)+' 预算分钟').fill('60')
 await btn(page,'生成方案').click();await generated(page)
 let d=await activeDraft(page,'personal')
 rec('generate','选定文字、要求和七天预算进入一次模拟请求',counts.propose===1&&counts.analyze===0&&reqs[0]?.selected_sources?.[0]?.excerpt?.includes('虚构通知')&&reqs[0]?.planning_context?.days.every(d=>d.budget_minutes===60),'')
 rec('generate','生成后停在核对，未自动排程采用',d?.status==='needs_review'&&!d.planning_result&&(await docsOf(page,'personal','task')).length===0,'')
 await page.getByLabel('任务 t1 截止',{exact:true}).click();await page.getByRole('button',{name:D(3),exact:true}).click();await btn(page,'保存并预览').click();await waitText(page,'每日安排');if(await btn(page,'确认 '+D(3)).count())await btn(page,'确认 '+D(3)).click();await confirmAll(page)
 rec('preview','手动日期和预算保留，生成建议可预览',(await activeDraft(page,'personal')).planning_input.days.every(x=>x.budget_minutes===60)&&await btn(page,'下一步：确认加入').isEnabled(),'')
 await btn(page,'下一步：确认加入').click();await btn(page,'采用计划').click();await page.getByRole('alertdialog').getByRole('button',{name:'采用',exact:true}).click();await waitText(page,'已采用：')
 rec('adopt','文字到正式任务和跨天安排闭环',(await docsOf(page,'personal','task')).length===1&&(await docsOf(page,'personal','action')).length===2&&new Set((await docsOf(page,'personal','plan_item')).map(p=>p.date)).size>=2,'')
 await shot(page,'generated-adopted.png');await context.close()
 }
 {
 const {context,page,counts}=await newScene('U4-clarification');debugPage=page;await start(page);await paste(page);await page.getByLabel('你想完成什么？有什么要求？').fill('澄清演示：虚构通知该怎么拆？');await btn(page,'生成方案').click();await generated(page);await waitText(page,'模型需要澄清')
 rec('clarify','澄清未回答不能继续，不能进入最终采用',await btn(page,'继续生成').isDisabled()&&await step(page,4).isDisabled(),'')
 await btn(page,'按原文全部要求').click();await nav(page,'任务').click();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
 rec('clarify','取消离开保留未提交的澄清回答',await btn(page,'继续生成').isEnabled()&&counts.propose===1,'')
 await btn(page,'继续生成').click();await generated(page)
 rec('clarify','只有明确回答并继续才发起续轮',counts.propose===2&&(await idbAll(page,'assistant_threads'))[0]?.messages.some(m=>m.content?.includes('答：按原文全部要求')),'')
 // No pending answer after a round: saved clarification draft may be left and reopened.
 await nav(page,'任务').click();await pause(page)
 rec('clarify','已归档澄清允许离开，不锁死页面',new URL(page.url()).hash.startsWith('#/tasks'),'')
 await context.close()
 }
 {
 const {context,page,counts}=await newScene('U4-save-result');debugPage=page;await start(page);await paste(page);await page.getByLabel('你想完成什么？有什么要求？').fill('虚构：按资料规划本周')
 await page.evaluate(()=>{window.__put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,...args){if(this.name==='assistant_drafts'&&v.proposal&&v.status==='needs_review')throw new DOMException('U4 result save failure','QuotaExceededError');return window.__put.call(this,v,...args)}})
 await btn(page,'生成方案').click();await generated(page);await waitText(page,'重试保存（不重调模型）')
 rec('result','生成结果保存失败保留重试入口，不能采用',counts.propose===1&&await step(page,4).isDisabled()&&(await docsOf(page,'personal','task')).length===0,'')
 await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__put;delete window.__put});await btn(page,'重试保存（不重调模型）').click();await generated(page)
 rec('result','重试保存使用保留结果，不再次请求模型',counts.propose===1&&(await activeDraft(page,'personal')).status==='needs_review','')
 await context.close()
 }
 rec('isolation','所有模型请求仅到自起模拟服务',netHits.length===0,'')
}catch(e){if(debugPage&&!debugPage.isClosed()){await shot(debugPage,'failure.png');writeFileSync(join(RUN,'failure-body.txt'),await debugPage.locator('body').innerText())};console.error(e);rec('runner','验收异常',false,e.message);exitCode=1}finally{
 writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2));writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog)
 await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass))exitCode=1
console.log('TOTAL',results.filter(r=>r.pass).length+'/'+results.length);process.exit(exitCode)
