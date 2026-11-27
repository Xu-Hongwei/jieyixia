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
const RUN = join(HERE, 'u2-regression')
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
const path = page => new URL(page.url()).hash.slice(1)
async function pause(page) { await page.waitForTimeout(200) }
async function goto(page, target) { await page.goto(BASE+'#'+target); await pause(page) }
const dialog = page => page.getByRole('dialog',{name:/工作安排详情|编辑工作安排|新建任务并继续安排/})
const closePanel = async page => {await page.getByLabel('关闭工作面板').click();await pause(page)}
const discard = async page => {await page.getByRole('alertdialog').getByRole('button',{name:'放弃草稿',exact:true}).click();await pause(page)}
const plan = async(page,id) => (await docsOf(page,'personal','plan_item')).find(p=>p.id===id)
async function widthCheck(page,width,label){
 await page.setViewportSize({width,height:844});await pause(page)
 const sizes=await page.evaluate(()=>({page:document.documentElement.scrollWidth,panel:document.querySelector('[role="dialog"]')?.getBoundingClientRect().width,inner:document.querySelector('[role="dialog"]')?.scrollWidth}))
 rec('layout',label+' '+width,sizes.page<=width&&(!sizes.panel||sizes.panel<=width&&sizes.inner<=Math.ceil(sizes.panel)),JSON.stringify(sizes))
}
try {
 const {context,page,counts}=await newScene('U2')
 await boot(page);await goto(page,'/today?date='+TODAY)
 rec('scope','日程移除普通新建和完整任务筛选',await btn(page,'新建').count()===0&&await page.getByLabel('搜索任务',{exact:true}).count()===0&&await page.getByRole('navigation',{name:'任务概览'}).count()===1,'')
 const opener=page.getByRole('button',{name:'安排详情：整理资料（旧安排）',exact:true}).first()
 await opener.click();await dialog(page).waitFor();await pause(page)
 rec('panel','日程安排打开侧边面板并保留周日期',path(page).includes('plan=p-1')&&path(page).includes('date='+TODAY),'')
 await shot(page,'desktop-detail.png')
 await page.keyboard.press('Escape');await pause(page)
 rec('panel','Escape关闭详情并恢复原卡片焦点',await dialog(page).count()===0&&!path(page).includes('plan=')&&await opener.evaluate(el=>document.activeElement===el),'')
 await opener.click();await btn(page,'编辑').click();await page.getByLabel('工作说明').fill('虚构：U2修改说明');await page.getByLabel('预计分钟',{exact:true}).fill('35')
 await closePanel(page)
 rec('guard','关闭编辑先确认未保存草稿',await page.getByRole('alertdialog').count()===1,'')
 await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
 rec('guard','取消关闭保留说明和时长',await page.getByLabel('工作说明').inputValue()==='虚构：U2修改说明'&&await page.getByLabel('预计分钟',{exact:true}).inputValue()==='35','')
 await btn(page,'保存修改').click();await waitText(page,'安排详情')
 rec('edit','修改真实落库且不改截止',(await plan(page,'p-1')).action_text==='虚构：U2修改说明'&&(await plan(page,'p-1')).planned_minutes===35&&(await docsOf(page,'personal','task')).find(t=>t.id==='t-smoke').deadline.value===D(6),'')
 await btn(page,'改期').click();await page.getByLabel('安排日期',{exact:true}).click();await page.getByRole('button',{name:D(1),exact:true}).click()
 await btn(page,'确认改期').click();await waitText(page,'安排详情')
 rec('move','面板日期选择可用，改期只改安排',(await plan(page,'p-1')).date===D(1)&&(await docsOf(page,'personal','task')).find(t=>t.id==='t-smoke').deadline.value===D(6),'')
 await closePanel(page)
 await btn(page,'列表').click();await btn(page,'安排工作').click();await page.getByLabel('工作说明').fill('虚构：保留原说明');await page.getByLabel('预计分钟',{exact:true}).fill('25')
 await page.getByLabel('安排日期',{exact:true}).click();await page.getByRole('button',{name:D(2),exact:true}).click()
 await btn(page,'新建任务并继续').click();await page.getByLabel('新任务名称').fill('虚构：面板内新任务')
 await btn(page,'取消').click();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
 rec('guard','嵌套新建任务取消保护输入',await page.getByLabel('新任务名称').inputValue()==='虚构：面板内新任务','')
 await btn(page,'创建任务').click();await page.getByLabel('工作说明').waitFor({state:'visible'})
 rec('create','新建任务返回安排保留日期时长说明',await page.getByLabel('工作说明').inputValue()==='虚构：保留原说明'&&await page.getByLabel('预计分钟',{exact:true}).inputValue()==='25'&&(await page.getByLabel('安排日期',{exact:true}).innerText()).includes(String(Number(D(2).slice(-2)))),'')
 await btn(page,'创建安排').click();await waitText(page,'安排详情')
 const madeTask=(await docsOf(page,'personal','task')).find(t=>t.title==='虚构：面板内新任务')
 rec('create','新任务和安排正确关联落库',!!madeTask&&(await docsOf(page,'personal','plan_item')).some(p=>p.task_id===madeTask.id&&p.action_text==='虚构：保留原说明'&&p.date===D(2)&&p.planned_minutes===25),'')
 await closePanel(page)
 await btn(page,'安排工作').click();await page.getByLabel('工作说明').fill('取消安排不删除任务');await btn(page,'新建任务并继续').click();await page.getByLabel('新任务名称').fill('虚构：仅保存任务');await btn(page,'创建任务').click();await page.getByLabel('工作说明').waitFor({state:'visible'})
 const planCount=(await docsOf(page,'personal','plan_item')).length
 await page.keyboard.press('Escape');await discard(page)
 rec('create','放弃安排保留已创建任务且不新增安排',(await docsOf(page,'personal','task')).some(t=>t.title==='虚构：仅保存任务')&&(await docsOf(page,'personal','plan_item')).length===planCount,'')
 // Back and outside clicks must run the same discard guard.
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'任务',exact:true}).click();await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'日程',exact:true}).click();await btn(page,'列表').click();await btn(page,'安排工作').click();await page.getByLabel('工作说明').fill('虚构：返回保护')
 const beforeBack=path(page)
 await page.goBack();await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click();await pause(page)
 rec('guard','浏览器返回取消后留在日程并保留输入',path(page)===beforeBack&&await page.getByLabel('工作说明').inputValue()==='虚构：返回保护',JSON.stringify({beforeBack,after:path(page),draft:await page.getByLabel('工作说明').inputValue()}))
 await page.mouse.click(250,100);await page.getByRole('alertdialog').waitFor();await discard(page)
 rec('guard','点击遮罩确认后关闭',await dialog(page).count()===0,'')
 await goto(page,'/today?date='+TODAY+'&view=list');await goto(page,'/today?date='+D(1)+'&view=list')
 await btn(page,'安排工作').click();await page.getByLabel('工作说明').fill('虚构：同页返回保护')
 await page.goBack();await page.getByRole('alertdialog').waitFor();await discard(page)
 rec('guard','同页返回确认放弃后关闭编辑器',await dialog(page).count()===0&&path(page).includes('date='+TODAY),path(page))
 await goto(page,'/tasks/t-smoke?return=%2Ftasks')
 const info=page.locator('details').filter({has:page.locator('summary',{hasText:'说明与完成标准'})})
 rec('detail','说明和来源默认折叠',!await info.evaluate(el=>el.open)&&!await page.locator('details').filter({has:page.locator('summary',{hasText:'关联资料'})}).evaluate(el=>el.open),'')
 rec('detail','近期安排仅默认展示三项',await page.getByRole('button',{name:/^安排详情：/}).count()===3,'')
 await btn(page,'查看全部 5 项安排').click()
 rec('detail','全部安排仍可展开',await page.getByRole('button',{name:/^安排详情：/}).count()===5,'')
 await page.getByRole('button',{name:'安排详情：虚构：U2修改说明',exact:true}).click();await dialog(page).waitFor();await btn(page,'编辑').click()
 await page.getByLabel('工作说明').fill('虚构：任务详情编辑');await btn(page,'保存修改').click();await waitText(page,'安排详情');await closePanel(page)
 rec('detail','任务详情复用面板原地保存',(await plan(page,'p-1')).action_text==='虚构：任务详情编辑'&&path(page).startsWith('/tasks/t-smoke'),'')
 await info.locator('summary').click();await page.getByLabel('任务说明',{exact:true}).fill('虚构：未保存说明')
 // Native dirty guard already uses window.confirm; override auto-accept for this assertion.
 page.removeAllListeners('dialog');page.on('dialog',d=>d.dismiss())
 await page.getByLabel('切换工作区').first().selectOption('demo');await pause(page)
 rec('guard','任务说明未保存时取消切空间',await page.getByLabel('切换工作区').first().inputValue()==='personal'&&await page.getByLabel('任务说明',{exact:true}).inputValue()==='虚构：未保存说明','')
 await btn(page,'保存说明').click();page.removeAllListeners('dialog');page.on('dialog',d=>d.accept())
 await info.locator('summary').click();await btn(page,'收起历史安排').click();await shot(page,'desktop-task.png')
 await goto(page,'/today?view=list');await btn(page,'安排工作').click()
 for(const w of [360,390,430,768,1440])await widthCheck(page,w,'安排面板')
 await page.setViewportSize({width:390,height:844});await page.getByLabel('工作说明').fill('虚构：手机安排');await shot(page,'mobile-editor.png')
 await page.getByLabel('安排日期',{exact:true}).click();await page.getByRole('button',{name:TODAY,exact:true}).click()
 rec('mobile','手机日期选择不关闭面板',await dialog(page).count()===1&&await page.getByLabel('工作说明').inputValue()==='虚构：手机安排','')
 await closePanel(page);await page.getByRole('alertdialog').waitFor();await shot(page,'mobile-discard.png');await discard(page)
 await shot(page,'mobile-schedule.png')
 await page.setViewportSize({width:1440,height:1000});await goto(page,'/today?date='+D(1)+'&plan=p-1');await page.reload();await dialog(page).waitFor()
 rec('compat','刷新深链接恢复安排详情',await dialog(page).count()===1&&path(page).includes('plan=p-1'),'')
 await closePanel(page);await goto(page,'/today?create=1');await page.getByLabel('新任务名称').waitFor()
 rec('compat','旧新建链接转至任务创建',path(page)==='/tasks'&&await page.getByLabel('新任务名称').count()===1,path(page))
 await goto(page,'/today?undated=1');rec('compat','旧无截止入口转至任务筛选',path(page)==='/tasks?undated=1',path(page))
 rec('isolation','无模型调用及用户服务访问',counts.analyze===0&&counts.propose===0&&netHits.length===0,JSON.stringify(counts))
 await context.close()
} catch(e){console.error(e);rec('runner','验收异常',false,e.message);exitCode=1}finally{
 writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2))
 writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog)
 await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass))exitCode=1
console.log('TOTAL',results.filter(r=>r.pass).length+'/'+results.length)
process.exit(exitCode)
