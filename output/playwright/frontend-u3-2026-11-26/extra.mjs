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
const RUN = join(HERE, 'browser-extra-r2')
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
const pause=page=>page.waitForTimeout(200)
const path=page=>new URL(page.url()).hash.slice(1)
const goto=async(page,target)=>{await page.goto(BASE+'#'+target);await pause(page)}
const panel=page=>page.getByRole('dialog',{name:'资料详情',exact:true})
const closePanel=async page=>{await page.getByLabel('关闭资料详情').click();await pause(page)}
const sources=page=>idbAll(page,'sources')
const note=async(page,id)=>(await docsOf(page,'personal','note')).find(n=>n.id===id)
async function seedMaterials(page){
 const base={workspace_id:'personal',record_version:1,created_at:NOW_ISO,updated_at:NOW_ISO}
 const source=(id,text)=>({...base,id,kind:'text',text,captured_at:NOW_ISO,content_version:'fixture-'+id})
 const field=(key,value,status)=>({key,value,status,raw:String(value),quote:{text:String(value)},precision:key==='deadline'?'date':null,derived:false,origin:'model',tz_known:true})
 const note=(id,source_id,title,status,fields)=>({...base,id,kind:'note',source_id,title,status,content_type:'notice',fields,warnings:[],matter_id:null,matter_role:null})
 const ss=[source('s-review-1','虚构核对资料一'),source('s-review-2','虚构核对资料二'),source('src-04','虚构失败资料'),...Array.from({length:45},(_,i)=>source('s-raw-'+i,'虚构资料 '+String(i).padStart(2,'0')))]
 const ns=[note('n-review-1','s-review-1','虚构核对一','draft',[field('summary','摘要一','confirmed'),field('deadline',D(3),'candidate')]),note('n-review-2','s-review-2','虚构核对二','draft',[field('deadline',D(4),'candidate')]),note('n-failed','src-04','虚构失败资料','failed',[])]
 await page.evaluate(({ss,ns})=>new Promise((resolve,reject)=>{const r=indexedDB.open('jxl-product');r.onsuccess=()=>{const db=r.result,t=db.transaction(['docs','sources'],'readwrite');ss.forEach(x=>t.objectStore('sources').put(x));ns.forEach(x=>t.objectStore('docs').put(x));t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)};r.onerror=()=>reject(r.error)}),{ss,ns})
}
let debugPage
try{
 const {context,page,counts}=await newScene('U3-extra');debugPage=page;await boot(page);await seedMaterials(page);await page.reload();await waitText(page,'日程')
 await goto(page,'/collect?status=pending&source=s-review-1');await panel(page).waitFor();await btn(page,'核对下一条').click();await pause(page)
 const text=await panel(page).getByLabel('原始文字资料').innerText()
 rec('evidence','切换资料后原文严格匹配当前对象',text==='虚构核对资料二',text)
 await closePanel(page);await btn(page,'添加资料').click();await page.getByLabel('文字资料').fill('虚构保存失败资料')
 await page.evaluate(()=>{window.__put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,...args){if(v.text==='虚构保存失败资料')throw new DOMException('U3 fixture failure','QuotaExceededError');return window.__put.call(this,v,...args)}})
 await btn(page,'仅保存文字').click();await pause(page)
 rec('save','资料保存失败保留输入且未落库',await page.getByLabel('文字资料').inputValue()==='虚构保存失败资料'&&!(await sources(page)).some(s=>s.text==='虚构保存失败资料'),'')
 await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__put;delete window.__put});await page.getByLabel('文字资料').fill('');await page.getByLabel('收起添加资料').click()
 await page.getByRole('button',{name:'查看资料：虚构核对资料一',exact:true}).click();const f=page.locator('[data-field-key="summary"]');await f.getByRole('button',{name:'编辑',exact:true}).click();await f.locator('input').fill('虚构字段写入失败')
 await page.evaluate(()=>{window.__put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,...args){if(v.kind==='note'&&v.id==='n-review-1')throw new DOMException('U3 fixture failure','QuotaExceededError');return window.__put.call(this,v,...args)}})
 await f.getByRole('button',{name:'保存修改',exact:true}).click();await pause(page)
 rec('save','核对字段写入失败保留草稿和原事实',await f.locator('input').inputValue()==='虚构字段写入失败'&&(await note(page,'n-review-1')).fields.find(f=>f.key==='summary').value==='摘要一','')
 await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__put;delete window.__put});await f.getByRole('button',{name:'取消',exact:true}).click();await closePanel(page)
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'任务',exact:true}).click();await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:/^资料/}).click();await goto(page,'/collect?source=s-review-1');await panel(page).waitFor();await f.getByRole('button',{name:'编辑',exact:true}).click();await f.locator('input').fill('返回保护测试')
 // Use UI navigation to build router history before testing back.
 await page.goBack();await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click();await pause(page)
 rec('guard','后退取消保留资料字段',await f.locator('input').inputValue()==='返回保护测试','')
 await page.keyboard.press('Escape');await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click();await pause(page)
 rec('guard','Escape确认放弃后关闭资料面板',await panel(page).count()===0,'')
 await goto(page,'/notes/n-review-1?bucket=pending');await f.getByRole('button',{name:'编辑',exact:true}).click();await f.locator('input').fill('旧入口未保存');await page.getByLabel('切换工作区').first().selectOption('demo');await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
 rec('compat','旧核对页切空间也保护未保存输入',await page.getByLabel('切换工作区').first().inputValue()==='personal'&&await f.locator('input').inputValue()==='旧入口未保存','')
 await f.getByRole('button',{name:'取消',exact:true}).click();await goto(page,'/collect?source=missing');await pause(page)
 rec('compat','无效资料深链接回到列表',await panel(page).count()===0&&!path(page).includes('source='),'')
 await goto(page,'/collect');for(const width of [360,390,430,768,1440]){await page.setViewportSize({width,height:844});await pause(page);rec('layout','资料列表 '+width,await page.evaluate(()=>document.documentElement.scrollWidth)<=width,'')}
 rec('isolation','额外检查零模型请求和用户服务访问',counts.analyze===0&&counts.propose===0&&netHits.length===0,'')
 await context.close()
}catch(e){if(debugPage){await shot(debugPage,'failure.png');writeFileSync(join(RUN,'failure-body.txt'),await bodyText(debugPage))};console.error(e);rec('runner','验收异常',false,e.message);exitCode=1}finally{
 writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2));writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog)
 await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass))exitCode=1
console.log('TOTAL',results.filter(r=>r.pass).length+'/'+results.length);process.exit(exitCode)
