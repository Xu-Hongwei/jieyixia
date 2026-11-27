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
const RUN = join(HERE, 'runtime-final-r2')
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

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(VPORT), '--strictPort', '--outDir', process.env.U5_BASELINE ? 'E:/qoder/output/frontend-u5-2026-11-26/baseline/dist' : 'dist'], {
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
  for (const label of ['确认仍有未排', '确认过载', '确认额外工作']) {
    while (await btn(page, label).count()) { await btn(page, label).first().click(); await page.waitForTimeout(150) }
  }
}



let exitCode=0,debugPage
const pause=p=>p.waitForTimeout(200)
const nav=(p,name)=>p.getByRole('navigation',{name:/^(主导航|移动主导航)$/}).filter({visible:true}).getByRole('link',{name,exact:true})
try{
 {
 const {context,page}=await newScene('cold-offline');debugPage=page
 await page.goto(BASE+'#/tasks');await page.getByRole('heading',{name:'任务',exact:true}).waitFor();await context.setOffline(true)
 await nav(page,'助手').click();await waitText(page,'助手暂时无法打开')
 rec('offline','未缓存助手断网有提示，原任务页面仍在',await page.getByRole('heading',{name:'任务',exact:true}).isVisible()&&await btn(page,'重试打开').isVisible(),'')
 rec('offline','断网时禁止重新加载，保留已打开的本地页面',await btn(page,'重试打开').isDisabled(),''); await shot(page,'cold-offline.png');await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('虚构未保存任务');await context.setOffline(false);await btn(page,'重试打开').click();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
 rec('guard','页面重试取消时保留未保存任务',await page.getByLabel('新任务名称').inputValue()==='虚构未保存任务','')
 await btn(page,'重试打开').click();await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click();await waitText(page,'提供资料与需求')
 rec('recovery','恢复网络后重试原目标成功，错误提示消失',!await btn(page,'重试打开').count()&&new URL(page.url()).hash==='#/assistant','')
 await nav(page,'任务').click();await page.waitForTimeout(2600);await context.setOffline(true)
 await page.getByRole('link',{name:'数据管理',exact:true}).click();await waitText(page,'导出当前空间备份')
 const [download]=await Promise.all([page.waitForEvent('download'),btn(page,'导出当前空间备份').click()]);await download.saveAs(join(RUN,'offline-backup.zip'))
 rec('offline','空闲预加载后断网仍能打开数据页并导出备份',download.suggestedFilename().endsWith('.zip'),'')
 await nav(page,'任务').click();await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('虚构：U5 离线任务');await btn(page,'创建任务').click();await waitText(page,'虚构：U5 离线任务')
 rec('offline','断网创建任务实际落库',(await docsOf(page,'personal','task')).some(t=>t.title==='虚构：U5 离线任务'),'')
 await nav(page,'助手').click();await waitText(page,'提供资料与需求')
 rec('offline','已加载助手可离线重新打开',await page.getByRole('heading',{name:'规划助手',exact:true}).isVisible(),'')
 await context.close()
 }
 {
 const {context,page}=await newScene('loading');debugPage=page
 await context.route('**/assets/AssistantPage-*.js',async route=>{await new Promise(r=>setTimeout(r,900));await route.continue()})
 await page.goto(BASE+'#/tasks');await page.getByRole('heading',{name:'任务',exact:true}).waitFor();await nav(page,'助手').click();await waitText(page,'正在打开助手');await waitText(page,'提供资料与需求')
 rec('loading','慢加载有短提示，完成后收起',!await page.getByText('正在打开助手…',{exact:true}).count(),'')
 await context.close()
 }
 {
 const {context,page}=await newScene('U5-layout');debugPage=page;await boot(page)
 const late={...seedRecords()[0],id:'u5-late',title:'虚构：已逾期的提交',deadline:{value:D(-1),precision:'date',source:'manual',from_note_id:null,confirmed_at:NOW_ISO}}
 await page.evaluate(record=>new Promise(resolve=>{const r=indexedDB.open('jxl-product');r.onsuccess=()=>{const db=r.result,t=db.transaction('docs','readwrite');t.objectStore('docs').put(record);t.oncomplete=()=>{db.close();resolve()}}}),late);await page.reload();await waitText(page,'周视图')
 const chip=page.getByRole('button',{name:'任务详情：虚构：已逾期的提交',exact:true});rec('deadline','逾期截止同时显示文字和醒目左边框',(await chip.innerText()).includes('已逾期')&&await chip.evaluate(e=>getComputedStyle(e).borderLeftWidth==='2px'),'')
 for(const route of ['today','tasks','collect','assistant']){
  await page.goto(BASE+'#/'+route);await pause(page)
  for(const width of [360,390,430,768,1440]){await page.setViewportSize({width,height:844});await pause(page);rec('layout',route+' '+width,await page.evaluate(()=>document.documentElement.scrollWidth)<=width,'')}
 }
 await page.setViewportSize({width:390,height:450});await page.goto(BASE+'#/tasks');await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('虚构短窗口输入');await page.getByLabel('新任务名称').focus()
 rec('input','手机输入字号不小于16px',await page.getByLabel('新任务名称').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))>=16,'')
 await btn(page,'创建任务').scrollIntoViewIfNeeded();const b=await btn(page,'创建任务').boundingBox(),bar=await page.getByRole('navigation',{name:'移动主导航'}).boundingBox()
 rec('input','短视口可以滚动让保存按钮露出底栏上方',b.y+b.height<=bar.y,'')
 await nav(page,'日程').click();await page.getByRole('alertdialog').waitFor();const d=await page.getByRole('alertdialog').boundingBox()
 rec('dialog','短视口确认框在屏幕内且有取消操作',d.y>=0&&d.y+d.height<=450&&await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).isVisible(),'')
 await shot(page,'short-viewport-confirm.png');await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click();await page.getByLabel('新任务名称').fill('');await btn(page,'取消').click()
 await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Tab')
 rec('accessibility','减少动态效果时保留可见焦点',await page.evaluate(()=>{const e=document.activeElement;return e!==document.body&&parseFloat(getComputedStyle(e).outlineWidth)>0}),'')
 rec('isolation','未访问用户服务',netHits.length===0,'');await context.close()
 }
}catch(e){if(debugPage&&!debugPage.isClosed()){await shot(debugPage,'failure.png');writeFileSync(join(RUN,'failure-body.txt'),await debugPage.locator('body').innerText())};console.error(e);rec('runner','异常',false,e.message);exitCode=1}finally{
 writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2));writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog);await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass))exitCode=1
console.log('TOTAL',results.filter(r=>r.pass).length+'/'+results.length);process.exit(exitCode)
