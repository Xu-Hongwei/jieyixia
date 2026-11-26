// M2 浏览器验收（2026-11-25，开工单 §8）——fixture 厂家确定性闭环。
// 真实生产页面 + 真实 IndexedDB + 真实 ZIP 导出/恢复；自起 fixture 后端（独立端口）与 Vite，
// 代理服务端注入 JXL_API_TOKEN；拦截并报告任何 :8000/:8020 命中，绝不触碰用户 8000 进程。
// 全部虚构数据（fixture 图片 src-01 为合成课程通知）。真实模型闭环另见 m2-real-model.mjs。
// 运行：node E:/qoder/devlog/private-evidence/assistant-mvp/M2/browser/m2-acceptance.mjs
// 产出：同目录 run-2026-11-25/（results.json + screenshots/ + downloads/ + 服务日志）；任一 FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'edge-browser')
const SHOTS = join(RUN, 'screenshots'); const DL = join(RUN, 'downloads')
for (const d of [RUN, SHOTS, DL]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const PYTHON = 'D:/APP/miniconda3/python.exe'
const TOKEN = `m2-probe-${randomUUID()}`

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
const bjWeekday = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=周日
}
const WEDNESDAY = Array.from({ length: 7 }, (_, i) => D(i)).find((d) => bjWeekday(d) === 3)

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

// —— 自起 fixture 后端（独立实例；用户 8000 不参与）——
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
console.log(`Vite 就绪：${BASE}（北京今天 ${TODAY}，周三 ${WEDNESDAY}）`)
const browser = await chromium.launch({ executablePath: EXEC, headless: true })

const netHits = []
async function newScene(name, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
    acceptDownloads: true,
  })
  const counts = { analyze: 0, propose: 0 }
  const proposeBodies = []
  const apiLog = []
  context.on('request', (r) => {
    const u = r.url()
    if (u.includes('/api/')) apiLog.push(`${r.method()} ${u}`)
    if (/:8000|:8020/.test(u)) netHits.push(u)
    if (u.includes('/api/analyze')) counts.analyze += 1
    if (u.includes('/api/assistant/propose')) {
      counts.propose += 1
      try { proposeBodies.push(JSON.parse(r.postData() || 'null')) } catch { proposeBodies.push(null) }
    }
  })
  await context.route(/:8000|:8020/, (route) => route.abort())
  const page = await context.newPage()
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, (e.stack || e.message).split('\n').slice(0, 4).join(' | ')))
  page.on('dialog', (d) => d.accept())
  return { context, page, counts, proposeBodies, apiLog }
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
const sourcesOf = async (page, ws) => (await idbAll(page, 'sources')).filter((s) => s.workspace_id === ws)
const wsOf = (page) => page.evaluate(() => localStorage.getItem('jxl-workspace'))

async function waitText(page, text, timeout = 20000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout })
  } catch (e) {
    console.log(`WAIT TIMEOUT「${text}」BODY:\n`, (await bodyText(page)).slice(0, 1500))
    throw e
  }
}
const btn = (page, name) => page.getByRole('button', { name, exact: true })
const bodyText = (page) => page.evaluate(() => document.body.innerText)

async function openAssistant(page) {
  if (!page.url().startsWith(BASE)) await page.goto(BASE + '#/assistant', { waitUntil: 'domcontentloaded' })
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => { location.hash = '#/assistant' })
    try {
      await page.waitForFunction(() => location.hash === '#/assistant', null, { timeout: 3000 })
      break
    } catch { await page.waitForTimeout(800) }
  }
  try {
    await waitText(page, '真实生成：资料 → 理解 → 任务建议', 8000)
  } catch {
    await page.goto(BASE + '#/assistant', { waitUntil: 'domcontentloaded' })
    await waitText(page, '真实生成：资料 → 理解 → 任务建议')
  }
}
const TEXT = '虚构通知：周五交报告，包含资料整理、对比分析和结论。'
async function pasteSource(page, text = TEXT) {
  await page.getByPlaceholder('粘贴原文（虚构通知、要求等）…').fill(text)
  await btn(page, '保存文字').click()
  await waitText(page, '已选 1 /')
}
async function fillRequirement(page, text) {
  await page.locator('#assistant-requirement').fill(text)
}
async function setBudgets(page, minutes, unavailableDate = null) {
  for (let i = 0; i < 7; i += 1) {
    const date = D(i)
    await page.getByLabel(`${date} 预算分钟`).fill(String(minutes))
  }
  if (unavailableDate) {
    await page.locator(`xpath=//span[text()="${unavailableDate}"]/ancestor::div[1]//input[@type="checkbox"]`).check()
  }
}
async function generateAndWaitDraft(page) {
  await btn(page, '生成方案').click()
  await waitText(page, '核对与确认', 30000) // 草案视图专属标题（导航栏有静态「待核对」，不能用作信号）
}
// 截止是弹出式日期选择器（aria-label 在触发按钮上，非 input）：点开 → 点日历格（aria-label=ISO 日期）。
async function pickDeadline(page, key, date) {
  await page.getByLabel(`任务 ${key} 截止`).click()
  await page.getByRole('button', { name: date, exact: true }).click()
}
// 手动截止（origin=user，带用户消息证据）：纯文字资料无分析便签，模型候选截止须有已确认便签字段出处
// （M1 R6/F1），故文字闭环走手动截止。date 须区别于模型候选 D(2) 才会触发 setManualDeadline。
async function manualDeadlineAndReschedule(page, date = D(3)) {
  await pickDeadline(page, 't1', date)
  await btn(page, '保存修改').click()
  await btn(page, '重新排程').click()
  await waitText(page, '七天预览（按日竖排）')
  await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
  if (await btn(page, `确认 ${date}`).count()) await btn(page, `确认 ${date}`).click()
}
async function noDeadlineAndReschedule(page) {
  await btn(page, '明确无截止').click()
  await btn(page, '重新排程').click()
  await waitText(page, '七天预览（按日竖排）')
  await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
  if (await btn(page, '明确无截止').count()) await btn(page, '明确无截止').click()
}
async function adopt(page) {
  // 缺口/过载/额外工作须逐项明确确认后才可采用（不静默裁剪）。
  for (const label of ['确认仍有未排', '确认过载', '确认额外工作']) {
    while (await btn(page, label).count()) { await btn(page, label).first().click(); await page.waitForTimeout(150) }
  }
  await btn(page, '采用计划').click()
  await btn(page, '采用').click()
  await waitText(page, '采用成功', 30000)
}
const activeDraft = async (page, ws) => {
  const ds = await draftsOf(page, ws)
  return ds.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] ?? null
}

let exitCode = 0
try {
 const s=await newScene('refresh-clarification'); const {page}=s;
 await openAssistant(page);await fillRequirement(page,'澄清演示：保留这条要求');await setBudgets(page,45);
 await btn(page,'生成方案').click();await waitText(page,'模型需要澄清（集中回答后继续）');
 await shot(page,'before-reload.png');await page.reload({waitUntil:'domcontentloaded'});await waitText(page,'继续已有草案');
 await page.getByRole('button',{name:/澄清演示：保留这条要求.*第/}).click();await waitText(page,'待澄清');
 const text=await bodyText(page);rec('refresh','待澄清刷新后仍可回答并继续',await btn(page,'继续生成').count()>0,JSON.stringify({continueButtons:await btn(page,'继续生成').count(),questionVisible:text.includes('模型需要澄清')}));
 await shot(page,'after-reload.png');await s.context.close();
 const s2=await newScene('switch-draft');const p=s2.page;
 await openAssistant(p);await fillRequirement(p,'旧草案核对');await generateAndWaitDraft(p);
 await btn(p,'← 返回列表').click();await waitText(p,'真实生成：资料');await fillRequirement(p,'新的生成任务');
 let release;let intercepted;
 const captured=new Promise(r=>intercepted=r);
 await p.route('**/api/assistant/propose',async route=>{const response=await route.fetch();intercepted();await new Promise(r=>release=r);await route.fulfill({response});});
 await btn(p,'生成方案').click();await captured;
 await p.getByRole('button',{name:/旧草案核对.*第/}).click();await waitText(p,'旧草案核对 · 第');release();
 await p.waitForTimeout(2500); // 迟到响应到达并被拒收（F4：切换草案已作废会话，不接收、不抢页面）
 const text2=await bodyText(p);
 const newDraft=(await draftsOf(p,'personal')).find(d=>(d.title||'').includes('新的生成任务'));
 const oldStill=text2.includes('旧草案核对 · 第');const notStolen=!text2.includes('新的生成任务 · 第');const noProposal=!newDraft||newDraft.proposal==null;
 rec('switch','选择旧草案后迟到结果不得抢回页面',oldStill&&notStolen&&noProposal,JSON.stringify({oldVisible:oldStill,newVisible:text2.includes('新的生成任务 · 第'),newProposal:newDraft?.proposal??null}));
 await shot(p,'late-result-switched-view.png');await s2.context.close();
 const s3=await newScene('generated-reload');const p3=s3.page;
 await openAssistant(p3);await fillRequirement(p3,'生成后保留预算');await setBudgets(p3,45);await generateAndWaitDraft(p3);
 const beforeBudget=await p3.getByLabel(`${D(0)} 预算分钟`,{exact:true}).inputValue();
 await shot(p3,'generated-before-reload.png');await p3.reload({waitUntil:'domcontentloaded'});await waitText(p3,'继续已有草案');
 await p3.getByRole('button',{name:/生成后保留预算.*第/}).click();await waitText(p3,'核对与确认');
 const afterBudget=await p3.getByLabel(`${D(0)} 预算分钟`,{exact:true}).inputValue();
 rec('generated-refresh','已生成但未排程草案刷新应保留预算45',beforeBudget==='45'&&afterBudget==='45',JSON.stringify({beforeBudget,afterBudget}));
 await shot(p3,'generated-after-reload.png');await s3.context.close();
 // P2 旧归档收口：剥离 user_input 模拟旧构建归档 → 恢复须警示+只读展示，重填后结构化续轮不含模型示例。
 const s4=await newScene('legacy-restore');const p4=s4.page;
 let proposeSeen=0;
 const clarifPayload=(qid,question)=>({kind:'clarification',ready:false,questions:[{question_id:qid,question,options:[],blocking_reason:'虚构：确认',related_requirement_key:null}]});
 await p4.route('**/api/assistant/propose',async route=>{
   const response=await route.fetch();const body=await response.json();proposeSeen+=1;
   if(proposeSeen===1)body.payload=clarifPayload('q1','请确认截止日期。\n参考回答：\n答：截止设为2026-12-01');
   else if(proposeSeen===2)body.payload=clarifPayload('q2','需要图表吗？');
   await route.fulfill({response,body:JSON.stringify(body)});
 });
 await openAssistant(p4);await pasteSource(p4);await fillRequirement(p4,'旧归档澄清演示');await setBudgets(p4,45);
 await btn(p4,'生成方案').click();await waitText(p4,'模型需要澄清（集中回答后继续）');
 await p4.locator('input[aria-label^="回答：请确认截止日期"]').fill('不要设截止日期');
 await btn(p4,'继续生成').click();await waitText(p4,'需要图表吗？');
 // 模拟旧归档：保留原消息全文，仅剥离此次新增的 user_input 字段（复验报告复现步骤 3）。
 await p4.evaluate(()=>new Promise((res,rej)=>{
   const r=indexedDB.open('jxl-product');
   r.onsuccess=()=>{const db=r.result;const t=db.transaction('assistant_threads','readwrite');const st=t.objectStore('assistant_threads');
     const q=st.getAll();q.onsuccess=()=>{for(const rec of q.result){rec.messages=rec.messages.map(({user_input,...m})=>m);st.put(rec)}};
     t.oncomplete=()=>{db.close();res()};t.onerror=()=>rej(t.error)};
   r.onerror=()=>rej(r.error);
 }));
 await p4.reload({waitUntil:'domcontentloaded'});await waitText(p4,'继续已有草案');
 await p4.getByRole('button',{name:/旧归档澄清演示.*第/}).click();await waitText(p4,'检测到旧版澄清记录');
 const t4=await bodyText(p4);
 const noticeShown=t4.includes('仅供下方展示，不会作为你的回答提交');
 const displayShown=t4.includes('旧记录展示（不作为回答）')&&t4.includes('截止设为2026-12-01');
 await shot(p4,'legacy-notice.png');
 await p4.getByLabel('回答：需要图表吗？').fill('不需要图表');
 const req3Promise=p4.waitForRequest(r=>r.url().includes('/api/assistant/propose')&&(r.postData()||'').includes('不需要图表'),{timeout:30000});
 await btn(p4,'继续生成').click();
 const req3=JSON.parse((await req3Promise).postData()||'null');
 await p4.waitForTimeout(1500);
 const noExample=req3?.user_input?.clarifications?.every(t=>!t.user_answer.includes('截止设为2026-12-01'))===true;
 const onlyRefill=JSON.stringify(req3?.user_input?.clarifications)===JSON.stringify([{assistant_question:'需要图表吗？',user_answer:'不需要图表'}]);
 rec('legacy-restore','旧归档恢复警示+只读展示；重填续轮不含模型示例',noticeShown&&displayShown&&noExample&&onlyRefill,JSON.stringify({noticeShown,displayShown,user_input:req3?.user_input??null}));
 await shot(p4,'legacy-refilled.png');await s4.context.close();
} catch(e){exitCode=1;rec('script','unexpected exception',false,String(e.stack))} finally {
 writeFileSync(join(RUN,'results.json'),JSON.stringify(results,null,2));await browser.close();vite.kill();backend.kill();
}
process.exit(exitCode || (results.some(r=>!r.pass)?1:0));

