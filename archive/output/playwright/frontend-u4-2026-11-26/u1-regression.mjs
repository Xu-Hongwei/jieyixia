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
const RUN = join(HERE, 'u1-regression-r2')
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
async function pause(page) { await page.waitForTimeout(150) }
async function goto(page, target) { await page.goto(BASE+'#'+target); await pause(page) }
async function widthCheck(page, width, label) {
  await page.setViewportSize({width,height:844});await pause(page)
  const actual=await page.evaluate(()=>document.documentElement.scrollWidth)
  rec('layout',label+' '+width,actual<=width,actual)
}
try {
  const {context,page,counts}=await newScene('U1')
  await boot(page)
  await page.evaluate((today)=>new Promise((resolve,reject)=>{
    const open=indexedDB.open('jxl-product')
    open.onsuccess=()=>{
      const db=open.result,tx=db.transaction('docs','readwrite'),store=tx.objectStore('docs')
      const read=store.get('t-other')
      read.onsuccess=()=>{
        const base=read.result
        for(let i=0;i<45;i++) store.put({...base,id:'t-extra-'+String(i).padStart(2,'0'),title:'虚构测试任务 '+String(i).padStart(2,'0'),matter_id:i%2?'group-u1':null,status:i===0?'done':'todo'})
        store.put({...base,id:'t-past',title:'虚构：逾期安排任务'})
        store.put({id:'p-past',kind:'plan_item',workspace_id:'personal',record_version:1,task_id:'t-past',date:today,planned_minutes:30,action_text:'过去未完成工作',state:'planned',actual_minutes:null,focus_session_id:null,order:0,task_ref_state:'active',created_at:base.created_at,updated_at:base.updated_at})
        store.put({id:'group-u1',kind:'matter',workspace_id:'personal',record_version:1,title:'课程学习',note_ids:[],created_at:base.created_at,updated_at:base.updated_at})
      }
      tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)
    };open.onerror=()=>reject(open.error)
  }),D(-1))
  await page.reload();await waitText(page,'日程')
  await goto(page,'/tasks')
  await waitText(page,'48 项任务')
  const nav=page.getByRole('navigation',{name:'主导航',exact:true})
  rec('nav','独立任务入口选中',await nav.getByRole('link',{name:'任务',exact:true}).getAttribute('aria-current')==='page','')
  await page.getByLabel('搜索任务',{exact:true}).fill('虚构测试任务 ');await pause(page)
  await page.getByLabel('状态筛选',{exact:true}).selectOption('open');await pause(page)
  await page.getByLabel('事项筛选',{exact:true}).selectOption('group-u1');await pause(page)
  await page.getByLabel('仅无截止',{exact:true}).check();await pause(page)
  rec('filters','搜索状态事项无截止组合筛选',await page.locator('[data-task-row]').count()===22,path(page))
  const origin=path(page)
  await page.getByRole('link',{name:'任务详情：虚构测试任务 31',exact:true}).scrollIntoViewIfNeeded()
  const y=await page.evaluate(()=>scrollY)
  await page.getByRole('link',{name:'任务详情：虚构测试任务 31',exact:true}).click()
  rec('nav','任务详情仍高亮任务',await nav.getByRole('link',{name:'任务',exact:true}).getAttribute('aria-current')==='page','')
  await btn(page,'返回任务列表').click();await pause(page)
  rec('filters','返回保留完整查询',path(page)===origin,path(page))
  rec('filters','返回保留滚动位置',Math.abs(await page.evaluate(()=>scrollY)-y)<10,`before=${y},after=${await page.evaluate(()=>scrollY)}`)
  await page.reload();await waitText(page,'22 项任务')
  rec('filters','刷新恢复查询和结果',await page.getByLabel('事项筛选').inputValue()==='group-u1'&&await page.getByLabel('仅无截止').isChecked(),'')
  await shot(page,'desktop-tasks-filtered.png')
  await goto(page,'/tasks?list=unscheduled')
  rec('filters','待安排使用现有分类',await page.getByRole('link',{name:'任务详情：虚构测试任务 01',exact:true}).count()===1&&await page.getByRole('link',{name:'任务详情：虚构：课程报告',exact:true}).count()===0,'')
  await goto(page,'/tasks?list=past')
  rec('filters','过去未完成可见对应安排',await page.getByRole('button',{name:'安排详情：过去未完成工作',exact:true}).count()===1,'')
  await goto(page,'/tasks')
  await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('虚构：U1创建任务')
  await page.getByLabel('新任务事项').selectOption('group-u1')
  await btn(page,'创建任务').click();await waitText(page,'返回任务列表')
  const tasks=await docsOf(page,'personal','task')
  rec('create','新建就地提交一次并落库',tasks.filter(t=>t.title==='虚构：U1创建任务').length===1&&tasks.find(t=>t.title==='虚构：U1创建任务')?.matter_id==='group-u1','')
  await btn(page,'返回任务列表').click()
  await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('虚构：保存失败测试')
  await page.evaluate(()=>{window.__u1Put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...rest){if(value?.kind==='task'&&value.title==='虚构：保存失败测试')throw new DOMException('U1 injected failure','QuotaExceededError');return window.__u1Put.call(this,value,...rest)}})
  await btn(page,'创建任务').click();await pause(page)
  rec('create','保存失败保留输入且未落库',await page.getByLabel('新任务名称').inputValue()==='虚构：保存失败测试'&&!(await docsOf(page,'personal','task')).some(t=>t.title==='虚构：保存失败测试'),'')
  await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__u1Put;delete window.__u1Put})
  await btn(page,'取消').click();await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click()
  await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('未保存任务')
  await nav.getByRole('link',{name:'日程',exact:true}).click()
  await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
  rec('guard','取消离开保留表单和任务页',path(page)==='/tasks'&&await page.getByLabel('新任务名称').inputValue()==='未保存任务','')
  await page.getByLabel('切换工作区').first().selectOption('demo')
  await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
  rec('guard','取消切空间仍在个人空间',await page.getByLabel('切换工作区').first().inputValue()==='personal','')
  await page.getByLabel('切换工作区').first().selectOption('demo')
  await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click()
  await waitText(page,'还没有任务')
  rec('isolation','切空间清除列表对象和新建表单',await page.locator('[data-task-row]').count()===0&&await page.getByLabel('新任务名称').count()===0,'')
  await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('演示未保存')
  await nav.getByRole('link',{name:'日程',exact:true}).click()
  rec('guard','切空间后没有残留免确认令牌',await page.getByRole('alertdialog').count()===1,'')
  await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click()
  await page.getByLabel('切换工作区').first().selectOption('personal');await pause(page)
  await goto(page,'/tasks?q=课程报告')
  await page.getByRole('button',{name:'安排工作：虚构：课程报告',exact:true}).click()
  await page.getByLabel('关闭工作面板').waitFor({state:'visible'})
  rec('arrange','安排编辑留在任务列表',decodeURI(path(page))==='/tasks?q=课程报告'&&await page.getByLabel('关闭工作面板').count()===1,path(page))
  await page.getByLabel('工作说明').fill('虚构：U1安排工作')
  await page.getByLabel('预计分钟').fill('15')
  await btn(page,'创建安排').click();await pause(page)
  rec('arrange','从任务列表创建安排实际落库', (await docsOf(page,'personal','plan_item')).some(p=>p.action_text==='虚构：U1安排工作'&&p.task_id==='t-smoke'),'')
  await page.getByRole('link',{name:'虚构：课程报告',exact:true}).click()
  await btn(page,'返回任务列表').click();await pause(page)
  rec('arrange','安排详情查看任务后返回原筛选',decodeURI(path(page))==='/tasks?q=课程报告',path(page))
  await page.getByRole('link',{name:'任务详情：虚构：课程报告',exact:true}).click()
  await btn(page,'调整后续安排').click();await waitText(page,'调整后续安排 · 选择替换范围')
  await btn(page,'原任务页').click();await btn(page,'返回任务列表').click();await pause(page)
  rec('nav','任务列表改排往返保留筛选',decodeURI(path(page))==='/tasks?q=课程报告',path(page))
  await goto(page,'/today?undated=1')
  rec('compat','旧无截止链接仍显示任务清单',await page.getByRole('link',{name:'任务详情：虚构：其它任务',exact:true}).count()===1,'')
  await goto(page,'/today?create=1')
  rec('compat','旧新建链接仍可用',await page.getByLabel('新任务名称').count()===1,'')
  await goto(page,'/notes')
  rec('nav','核对页归资料分区',await nav.getByRole('link',{name:'资料',exact:true}).getAttribute('aria-current')==='page','')
  await goto(page,'/work-records')
  rec('nav','工作记录归日程分区',await nav.getByRole('link',{name:'日程',exact:true}).getAttribute('aria-current')==='page','')
  await goto(page,'/tasks')
  for(const w of [360,390,430,768,1440]) await widthCheck(page,w,'任务总览')
  await page.setViewportSize({width:390,height:844});await pause(page)
  await shot(page,'mobile-tasks.png')
  const mobileNav=page.getByRole('navigation',{name:'移动主导航',exact:true})
  rec('layout','手机只有四个主入口',await mobileNav.getByRole('link').count()===4,'')
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await pause(page)
  const bottom=await page.evaluate(()=>({last:document.querySelector('[data-task-row]:last-child').getBoundingClientRect().bottom,nav:document.querySelector('[aria-label="移动主导航"]').getBoundingClientRect().top}))
  rec('layout','最后一行可滚动到底栏上方',bottom.last<=bottom.nav,JSON.stringify(bottom))
  await btn(page,'新建任务').click()
  for(const w of [360,390,430]) await widthCheck(page,w,'任务创建')
  await shot(page,'mobile-create.png')
  await btn(page,'取消').click()
  await mobileNav.getByRole('link',{name:'资料',exact:true}).click()
  rec('nav','手机核对入口集中为资料状态筛选',await page.getByLabel('资料状态筛选').getByRole('button',{name:/^待核对/}).count()===1,'')
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

