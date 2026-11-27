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
const RUN = join(HERE, 'fixture-browser')
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
// 稳定异步保存/排程完成条件（复验审查建议）：等 store.busy 落定再继续点击，避免保存未落定即重排/采用的竞态；
// 仅稳定探针时序，不放宽任何产品守卫（stale/dirty/确认阻断保持原样）。
const settle = (page) => page.waitForFunction(() => {
  const a = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assistant')
  return !!a && !a.busy.saving && !a.busy.rescheduling && !a.busy.adopting
}, null, { timeout: 20000 })
// 手动截止（origin=user，带用户消息证据）：纯文字资料无分析便签，模型候选截止须有已确认便签字段出处
// （M1 R6/F1），故文字闭环走手动截止。date 须区别于模型候选 D(2) 才会触发 setManualDeadline。
async function manualDeadlineAndReschedule(page, date = D(3)) {
  await pickDeadline(page, 't1', date)
  await btn(page, '保存修改').click()
  await settle(page)
  await btn(page, '重新排程').click()
  await settle(page)
  await waitText(page, '七天预览（按日竖排）')
  await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
  if (await btn(page, `确认 ${date}`).count()) await btn(page, `确认 ${date}`).click()
}
async function noDeadlineAndReschedule(page) {
  await btn(page, '明确无截止').click()
  await btn(page, '重新排程').click()
  await settle(page)
  await waitText(page, '七天预览（按日竖排）')
  await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
  if (await btn(page, '明确无截止').count()) await btn(page, '明确无截止').click()
}
async function adopt(page) {
  // 缺口/过载/额外工作须逐项明确确认后才可采用（不静默裁剪）。
  for (const label of ['确认仍有未排', '确认过载', '确认额外工作']) {
    while (await btn(page, label).count()) { await btn(page, label).first().click(); await page.waitForTimeout(150) }
  }
  await settle(page)
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
  // ========== S1 ②⑩ 纯文字闭环：请求形状 → 核对 → 排程 → 采用 → 日程入口 ==========
  {
    const { context, page, counts, proposeBodies, apiLog } = await newScene('S1')
    await openAssistant(page)
    await pasteSource(page)
    await fillRequirement(page, '每天 45 分钟，周三没空')
    await setBudgets(page, 45, WEDNESDAY)
    await shot(page, 's1-01-input.png')
    await generateAndWaitDraft(page)
    const req = proposeBodies.at(-1)
    rec('②', '文字进入请求：excerpt=选定原文，7 日预算 45，周三预算 0',
      req?.selected_sources?.[0]?.excerpt === TEXT
      && req?.planning_context?.days?.length === 7
      && req.planning_context.days.every((d) => d.budget_minutes === (d.date === WEDNESDAY ? 0 : 45))
      && req?.user_message === '每天 45 分钟，周三没空' && req?.intent === 'new_plan' && req?.client_seq === 1,
      JSON.stringify({ excerpt: req?.selected_sources?.[0]?.excerpt?.slice(0, 20), days: req?.planning_context?.days?.map((d) => d.budget_minutes) }))
    rec('②', 'propose 恰好一次（无并行付费请求）', counts.propose === 1, `propose=${counts.propose}`)
    const d1 = await activeDraft(page, 'personal')
    rec('⑩', '模型成功仅到待核对：needs_review 第 2 版，未自动 ready/采用',
      d1?.status === 'needs_review' && d1?.revision === 2 && !!d1?.proposal && !d1?.planning_result,
      JSON.stringify({ status: d1?.status, revision: d1?.revision }))
    await shot(page, 's1-02-review.png')
    // 纯文字资料无分析便签：模型候选截止须有已确认便签字段出处（M1 R6/F1），故走手动截止（origin=user，
    // 带用户消息证据）。设为 D(3)=周六（区别于模型候选 D(2)），容量充足可完整排下 105 分钟。
    await pickDeadline(page, 't1', D(3))
    await btn(page, '保存修改').click()
    await settle(page)
  await settle(page) // setManualDeadline：留用户消息 → origin=user 候选 → 当前版确认
    await btn(page, '重新排程').click()
    await settle(page)
  await settle(page)
    await waitText(page, '七天预览（按日竖排）')
    await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
    if (await btn(page, `确认 ${D(3)}`).count()) await btn(page, `确认 ${D(3)}`).click() // 排程 bump 后新版重新确认
    const d2 = await activeDraft(page, 'personal')
    const segs = d2?.planning_result?.segments ?? []
    const dates = [...new Set(segs.map((s) => s.date))]
    const total = segs.reduce((a, s) => a + s.minutes, 0)
    const unsched = d2?.planning_result?.unscheduled ?? []
    const unschedTotal = unsched.reduce((a, u) => a + u.remaining_minutes, 0)
    rec('⑤', '手动截止约束内跨天排程：已排+未排=105 不静默裁剪，周三零新排，不超截止',
      dates.length >= 2 && total + unschedTotal === 105 && !dates.includes(WEDNESDAY) && dates.every((dt) => dt <= D(3)),
      JSON.stringify({ dates, total, unschedTotal, deadline: D(3) }))
    await shot(page, 's1-03-preview.png')
    await adopt(page)
    const tasks = await docsOf(page, 'personal', 'task')
    const actions = await docsOf(page, 'personal', 'action')
    const plans = await docsOf(page, 'personal', 'plan_item')
    const d3 = await activeDraft(page, 'personal')
    rec('⑩', '采用写入正式对象：1 任务 / 2 行动 / 安排=段数，草案 applied 只读',
      tasks.length === 1 && actions.length === 2 && plans.length === segs.length && d3?.status === 'applied',
      JSON.stringify({ tasks: tasks.length, actions: actions.length, plans: plans.length, segments: segs.length, draft: d3?.status }))
    rec('③', '手动截止来自用户输入（manual 出处＋用户消息证据），非自动今天',
      tasks[0]?.deadline?.value === D(3) && tasks[0]?.deadline?.source === 'manual' && !!tasks[0]?.deadline?.confirmed_at,
      JSON.stringify(tasks[0]?.deadline))
    await shot(page, 's1-04-adopted.png')
    await btn(page, '查看日程').first().click()
    await page.waitForFunction(() => location.hash.startsWith('#/today'), null, { timeout: 10000 })
    // 新安排落在截止约束内的未来日（周三无空），定位到首个排程日才见新安排卡片（action_text=工作项交付物）。
    await page.evaluate((d) => { location.hash = `#/today?date=${d}` }, dates[0])
    await waitText(page, '资料清单')
    rec('⑩', '采用后「查看日程」进入日程并见新安排', true, page.url())
    await shot(page, 's1-05-schedule.png')

    // ===== S9 ⑩ 真实 ZIP 导出 → 恢复：数量一致、applied 不重放 =====
    await page.evaluate(() => { location.hash = '#/data' })
    await waitText(page, '导出当前空间备份')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      btn(page, '导出当前空间备份').click(),
    ])
    const zipPath = join(DL, download.suggestedFilename())
    await download.saveAs(zipPath)
    rec('⑩', '真实导出备份 ZIP 已落盘', download.suggestedFilename().endsWith('.zip'), download.suggestedFilename())
    await page.locator('input[type="file"]').setInputFiles(zipPath)
    await waitText(page, '恢复到新空间')
    await page.locator('#restore-name').fill('M2恢复验证')
    await btn(page, '恢复到新空间').click()
    await waitText(page, '恢复完成', 30000)
    await btn(page, '进入恢复空间').click()
    await page.waitForFunction(() => location.hash.startsWith('#/today'), null, { timeout: 10000 })
    const rws = await wsOf(page)
    const rTasks = await docsOf(page, rws, 'task')
    const rActions = await docsOf(page, rws, 'action')
    const rPlans = await docsOf(page, rws, 'plan_item')
    const rDrafts = await draftsOf(page, rws)
    const rSources = await sourcesOf(page, rws)
    const rOps = (await idbAll(page, 'assistant_ops')).filter((o) => o.workspace_id === rws)
    rec('⑩', '恢复空间：对象数量一致、来源随迁、草案 applied 只读、ops 不导出（无重放）',
      rTasks.length === 1 && rActions.length === 2 && rPlans.length === plans.length
      && rDrafts[0]?.status === 'applied' && rSources.length === 1 && rOps.length === 0,
      JSON.stringify({ ws: rws, tasks: rTasks.length, actions: rActions.length, plans: rPlans.length, sources: rSources.length, draft: rDrafts[0]?.status, ops: rOps.length }))
    await shot(page, 's9-01-restored.png')
    await context.close()
  }

  // ========== S2 ①③ 图片（fixture src-01）：分析 → 字段核对 → 采用；复用绑定不重复分析 ==========
  {
    const { context, page, counts } = await newScene('S2')
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const png = readFileSync('E:/qoder/fixtures/assets/01-course-assignment.png')
    const sha = createHash('sha256').update(png).digest('hex')
    await page.evaluate(async ({ b64, sha, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'image/png' })
      await new Promise((res, rej) => {
        const r = indexedDB.open('jxl-product')
        r.onsuccess = () => {
          const db = r.result
          const t = db.transaction('sources', 'readwrite')
          t.objectStore('sources').put({
            id: 'src-01', workspace_id: 'personal', kind: 'image', blob, name,
            captured_at: new Date().toISOString(), content_version: sha,
          })
          t.oncomplete = () => { db.close(); res() }
          t.onerror = () => { db.close(); rej(t.error) }
        }
        r.onerror = () => rej(r.error)
      })
    }, { b64: png.toString('base64'), sha, name: '虚构课程通知.png' })
    // 种子写入 IDB 后须重载，应用才会从本地读出该资料（fixture analyze 只认 source_id=src-01）。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openAssistant(page)
    await page.getByLabel('选定资料 虚构课程通知.png').check()
    await fillRequirement(page, '按通知要求拆解学习任务')
    await setBudgets(page, 60)
    await generateAndWaitDraft(page)
    rec('①', '图片先 analyze 再 propose（各一次），便签字段进入请求',
      counts.analyze === 1 && counts.propose === 1,
      JSON.stringify(counts))
    const notes = await docsOf(page, 'personal', 'note')
    rec('①', '分析便签落本地：含 deadline 候选字段与原文 raw',
      notes.length === 1 && notes[0].fields.some((f) => f.key === 'deadline' && f.value === '2026-11-19'),
      JSON.stringify(notes[0]?.fields?.map((f) => f.key)))
    await shot(page, 's2-01-source-review.png')
    // 资料核对：独立确认 deadline 字段（确认≠改值）
    await page.locator('xpath=//span[text()="deadline"]/ancestor::li[1]//button[text()="确认为事实"]').click()
    await waitText(page, '已确认')
    const notes2 = await docsOf(page, 'personal', 'note')
    const dlField = notes2[0]?.fields.find((f) => f.key === 'deadline')
    rec('③', '资料字段确认为事实：status=confirmed，值不变（确认≠改值）',
      dlField?.status === 'confirmed' && dlField?.value === '2026-11-19',
      JSON.stringify({ status: dlField?.status, value: dlField?.value }))
    // fixture 桩 propose 截止（start+2）与 analyze 截止（2026-11-19，已过期）不一致，模型候选无法取得
    // 匹配的已确认便签出处；图片闭环采用走「明确无截止」。模型截止→便签出处→采用由真实模型探针验证。
    await noDeadlineAndReschedule(page)
    await adopt(page)
    const tasks = await docsOf(page, 'personal', 'task')
    rec('①', '图片＋文字要求采用成功：任务/行动/安排齐备',
      tasks.length === 1 && (await docsOf(page, 'personal', 'action')).length === 2 && (await docsOf(page, 'personal', 'plan_item')).length >= 2,
      JSON.stringify({ tasks: tasks.length }))
    await shot(page, 's2-02-adopted.png')
    // 复用绑定：同资料未变 → 第二次生成零新增 analyze
    await btn(page, '← 返回列表').click()
    await waitText(page, '真实生成：资料 → 理解 → 任务建议')
    await btn(page, '生成方案').click()
    await waitText(page, '核对与确认', 30000)
    rec('②', '有效旧分析复用：第二次生成 analyze 仍为 1（绑定内容指纹）',
      counts.analyze === 1 && counts.propose === 2, JSON.stringify(counts))
    await context.close()
  }

  // ========== S3 ④ 澄清：集中作答 → 同线程续轮 seq+1 → 原要求与问答真实归档 ==========
  // 注：fixture 桩只要 user_message 含「澄清演示」就返回澄清；续轮归档的原要求仍含该词，
  // 故桩会再次澄清（确定性循环）。本场景验证澄清面板/集中作答/续轮请求合成与归档；
  // 澄清→proposal 的状态机转换由单测（mock API）覆盖，真实模型续轮行为另见真实模型探针。
  {
    const { context, page, proposeBodies } = await newScene('S3')
    await openAssistant(page)
    await pasteSource(page)
    await fillRequirement(page, '澄清演示：这份通知该怎么拆？')
    await setBudgets(page, 60)
    await btn(page, '生成方案').click()
    await waitText(page, '模型需要澄清（集中回答后继续）')
    rec('④', '澄清面板：问题+阻塞原因+选项；未答完整不能继续',
      (await bodyText(page)).includes('为什么必须先回答') && await btn(page, '继续生成').isDisabled(), '')
    await shot(page, 's3-01-clarification.png')
    await btn(page, '按原文全部要求').click()
    await btn(page, '继续生成').click()
    // 等待续轮请求发出（桩再次澄清，面板回到澄清态）。
    const deadline = Date.now() + 20000
    while (proposeBodies.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    const second = proposeBodies.at(-1)
    rec('④', '续轮 seq=2、新 turn/request、同线程；合成消息含原要求+问+答',
      proposeBodies.length === 2 && second?.client_seq === 2
      && second?.thread_id === proposeBodies[0]?.thread_id
      && second?.request_id !== proposeBodies[0]?.request_id
      && second?.user_message?.includes('原始要求：澄清演示')
      && second?.user_message?.includes('问：') && second?.user_message?.includes('答：按原文全部要求'),
      JSON.stringify({ seq: second?.client_seq, msg: second?.user_message?.slice(0, 60) }))
    await waitText(page, '模型需要澄清（集中回答后继续）')
    const threads = await threadsOf(page, 'personal')
    const types = threads[0]?.messages?.map((m) => m.type)
    rec('④', '线程真实归档：text → clarification → text → clarification（原要求与问答留痕）',
      JSON.stringify(types) === JSON.stringify(['text', 'clarification', 'text', 'clarification']),
      JSON.stringify(types))
    await shot(page, 's3-02-continued.png')
    await context.close()
  }

  // ========== S4 ⑥ 既有对象：显式选定才 link/reuse；采用不重复创建正式任务 ==========
  {
    const { context, page, proposeBodies } = await newScene('S4')
    await openAssistant(page)
    await pasteSource(page)
    await fillRequirement(page, '继续推进既有任务')
    await setBudgets(page, 45)
    // 先造一个既有任务+行动（走真实采用流程；文字资料无分析便签 → 手动截止取得出处）
    await generateAndWaitDraft(page)
    await manualDeadlineAndReschedule(page)
    await adopt(page)
    const tasksBefore = await docsOf(page, 'personal', 'task')
    const actionsBefore = await docsOf(page, 'personal', 'action')
    // 第二轮：显式勾选既有任务与未完成行动
    await btn(page, '← 返回列表').click()
    await waitText(page, '真实生成：资料 → 理解 → 任务建议')
    await page.getByText('关联已有任务/行动（可选；只有勾选的对象可被关联/复用，默认新建）').click()
    await page.locator('xpath=//span[contains(text(),"完成资料要求（桩建议）")]/ancestor::label[1]//input[@type="checkbox"]').check()
    await page.getByLabel('选定行动 整理资料').check()
    await shot(page, 's4-01-related.png')
    await btn(page, '生成方案').click()
    await waitText(page, '关联既有任务（不改对象）', 30000)
    const req = proposeBodies.at(-1)
    const checkedAction = actionsBefore.find((a) => a.text === '整理资料')
    rec('⑥', '只有显式选定的 Task/Action 进入请求快照',
      req?.selected_tasks?.length === 1 && req?.selected_actions?.length === 1
      && req.selected_tasks[0].id === tasksBefore[0].id
      && !!checkedAction && req.selected_actions[0].id === checkedAction.id,
      JSON.stringify({ tasks: req?.selected_tasks?.length, actions: req?.selected_actions?.length, selAct: req?.selected_actions?.[0]?.id, wantAct: checkedAction?.id }))
    rec('⑥', '桩返回 link + reuse 建议（不改既有对象）',
      (await bodyText(page)).includes('复用既有行动（不改对象）'), '')
    // 第二轮含 link 既有任务（窗口已有安排）→ D12 额外工作阻断首次排程；须排程前确认（M2 修复点）。
    await pickDeadline(page, 't1', D(3))
    await btn(page, '保存修改').click()
    await settle(page)
  await settle(page)
    await btn(page, '重新排程').click()
    await settle(page)
  await settle(page)
    await waitText(page, '须先确认本次为额外尚未安排工作', 15000) // 排程前额外工作面板（不依赖排程结果）
    rec('⑥', '额外工作阻断排程时可在排程前逐项确认（确认面板不依赖排程结果）',
      await btn(page, '确认额外工作').count() > 0 && !(await activeDraft(page, 'personal'))?.planning_result, '')
    await btn(page, '确认额外工作').first().click() // w3 当前版确认后再排程
    await btn(page, '重新排程').click()
    await settle(page)
  await settle(page)
    await waitText(page, '七天预览（按日竖排）')
    await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
    if (await btn(page, `确认 ${D(3)}`).count()) await btn(page, `确认 ${D(3)}`).click() // 排程 bump 后新版重新确认截止
    // 既有任务窗口已有安排 → 额外工作（新版）/缺口/过载逐项确认
    for (const label of ['确认额外工作', '确认仍有未排', '确认过载']) {
      while (await btn(page, label).count()) { await btn(page, label).first().click(); await page.waitForTimeout(200) }
    }
    await adopt(page)
    const tasksAfter = await docsOf(page, 'personal', 'task')
    const actionsAfter = await docsOf(page, 'personal', 'action')
    // ⑥ 核心：link 的既有任务映射回原 ID、不重复创建；新建 t1 是独立新任务（桩第二轮仍含 create）。
    const d2 = await activeDraft(page, 'personal')
    const linkEntry = (d2?.applied_summary?.id_map ?? []).find((e) => e.draft_key === 't2' && e.object_type === 'task')
    rec('⑥', '采用后既有任务不重复创建（link 映射回原 ID），新行动只增 create 部分',
      tasksAfter.length === 2 && linkEntry?.formal_id === tasksBefore[0].id
      && tasksAfter.filter((t) => t.id === tasksBefore[0].id).length === 1
      && actionsAfter.length === actionsBefore.length + 2,
      JSON.stringify({ tasks: tasksAfter.length, actions: actionsAfter.length, link: linkEntry?.formal_id }))
    await shot(page, 's4-02-adopted.png')
    await context.close()
  }

  // ========== S5 ⑦ 取消 / 晚到 / 输入变化 / 切空间往返 / 刷新不重发 ==========
  {
    const { context, page, counts } = await newScene('S5')
    await context.route('**/api/assistant/propose', async (route) => {
      await new Promise((r) => setTimeout(r, 2500))
      await route.continue()
    })
    await openAssistant(page)
    await pasteSource(page)
    await fillRequirement(page, '取消测试')
    await setBudgets(page, 60)
    // 取消：请求在途 → 取消 → 草案收敛 needs_review，输入保留
    await btn(page, '生成方案').click()
    await waitText(page, '等待模型响应…')
    await btn(page, '取消').click()
    await waitText(page, '已取消生成')
    await page.waitForTimeout(3000) // 晚到响应窗口
    let d = await activeDraft(page, 'personal')
    rec('⑦', '取消后晚到结果不接收：草案 needs_review 第 1 版、无 proposal',
      d?.status === 'needs_review' && d?.revision === 1 && !d?.proposal,
      JSON.stringify({ status: d?.status, revision: d?.revision }))
    rec('⑦', '取消保留输入（要求与资料仍在）',
      (await page.locator('#assistant-requirement').inputValue()) === '取消测试', '')
    // 生成期间输入控件全部禁用（UI 层防止输入漂移；INPUT_CHANGED 拒收逻辑由单测覆盖）。
    await btn(page, '生成方案').click()
    await waitText(page, '等待模型响应…')
    const reqDisabled = await page.locator('#assistant-requirement').isDisabled()
    const budgetDisabled = await page.getByLabel(`${D(0)} 预算分钟`).isDisabled()
    rec('⑦', '生成期间要求/预算输入禁用，防止在途输入漂移', reqDisabled && budgetDisabled,
      JSON.stringify({ reqDisabled, budgetDisabled }))
    await btn(page, '取消').click()
    await waitText(page, '已取消生成')
    await page.waitForTimeout(3000)
    d = await activeDraft(page, 'personal')
    rec('⑦', '再次取消后草案仍第 1 版、无 proposal（晚到结果不接收）',
      d?.revision === 1 && !d?.proposal, JSON.stringify({ revision: d?.revision }))
    // 切空间往返：在途切走再切回 → 旧结果不接纳
    await fillRequirement(page, '往返测试')
    await btn(page, '生成方案').click()
    await waitText(page, '等待模型响应…')
    await page.selectOption('[aria-label="切换工作区"]', 'demo')
    await page.waitForTimeout(500)
    await page.selectOption('[aria-label="切换工作区"]', 'personal')
    await page.waitForTimeout(3000)
    await openAssistant(page)
    d = await activeDraft(page, 'personal')
    const demoDrafts = await draftsOf(page, 'demo')
    rec('⑦', '切走再切回：旧响应不改当前草案（仍第 1 版），演示空间无草案',
      d?.revision === 1 && !d?.proposal && demoDrafts.length === 0,
      JSON.stringify({ revision: d?.revision, demo: demoDrafts.length }))
    // 刷新不自动重发付费请求
    const before = counts.propose
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openAssistant(page)
    await page.waitForTimeout(1500)
    rec('⑦', '刷新不自动重发 propose', counts.propose === before, JSON.stringify({ before, after: counts.propose }))
    await shot(page, 's5-01-cancel.png')
    await context.close()
  }

  // ========== S6 ⑧ 失败恢复：额度不足 / 断网 → 保留输入 → 重试成功 ==========
  {
    const { context, page, counts } = await newScene('S6')
    await openAssistant(page)
    await pasteSource(page)
    await fillRequirement(page, '失败恢复测试')
    await setBudgets(page, 60)
    await context.route('**/api/assistant/propose', (route) => route.fulfill({
      status: 429, contentType: 'application/json',
      body: JSON.stringify({ code: 'quota_exhausted', message: '今日模型调用额度已用尽，输入已保留；本地手动功能照常', retryable: false }),
    }))
    await btn(page, '生成方案').click()
    await waitText(page, '今日模型调用额度已用尽')
    rec('⑧', '额度不足：明确错误、输入保留、不伪装演示成功',
      (await page.locator('#assistant-requirement').inputValue()) === '失败恢复测试'
      && !(await bodyText(page)).includes('演示草案已载入'), '')
    await shot(page, 's6-01-quota.png')
    await context.unroute('**/api/assistant/propose')
    await btn(page, '重试生成').click()
    await waitText(page, '核对与确认', 30000)
    rec('⑧', '额度恢复后重试成功（新轮 seq+1）', counts.propose === 2, `propose=${counts.propose}`)
    // 断网：abort → 失败保留 → 重试
    await btn(page, '← 返回列表').click()
    await waitText(page, '真实生成：资料 → 理解 → 任务建议')
    await context.route('**/api/assistant/propose', (route) => route.abort())
    await btn(page, '生成方案').click()
    await waitText(page, '重试生成', 15000)
    const d = await activeDraft(page, 'personal')
    rec('⑧', '断网失败：草案收敛 needs_review，输入与资料保留',
      d?.status === 'needs_review' && (await sourcesOf(page, 'personal')).length === 1,
      JSON.stringify({ status: d?.status }))
    await context.unroute('**/api/assistant/propose')
    await btn(page, '重试生成').click()
    await waitText(page, '核对与确认', 30000)
    await shot(page, 's6-02-recovered.png')
    await context.close()
  }

  // ========== S7 ⑤ 未知估时不当零；容量不足缺口明确确认后才可采用 ==========
  {
    const { context, page } = await newScene('S7')
    await openAssistant(page)
    await pasteSource(page)
    await fillRequirement(page, '容量与估时测试')
    await setBudgets(page, 20) // 20×85%=17 < 最小段 25 → 缺口
    await generateAndWaitDraft(page)
    // 未知估时：清空 w1 剩余分钟 → 保存 → 排程 → ESTIMATE_UNKNOWN 阻断
    await page.locator('xpath=//div[contains(text(),"工作项 w1")]/ancestor::div[1]//input').fill('')
    await btn(page, '保存修改').click()
    await settle(page)
  await settle(page)
    await btn(page, `确认 ${D(2)}`).click()
    await btn(page, '重新排程').click()
    await settle(page)
  await settle(page)
    await waitText(page, '估时未知')
    rec('⑤', '未知估时清楚展示、不当零、采用禁用',
      await btn(page, '采用计划').isDisabled(), '')
    await shot(page, 's7-01-unknown.png')
    await page.locator('xpath=//div[contains(text(),"工作项 w1")]/ancestor::div[1]//input').fill('45')
    await btn(page, '保存修改').click()
    await settle(page)
  await settle(page)
    await manualDeadlineAndReschedule(page)
    await waitText(page, '未排工作')
    // 缺口原因须逐项渲染（与排程结果机器核对，不硬编码单一原因）：有截止→截止前放不下，无截止→容量不足等。
    const dGap = await activeDraft(page, 'personal')
    const unsched = dGap?.planning_result?.unscheduled ?? []
    const REASON_TEXT = {
      no_capacity: '容量不足', not_splittable: '不可拆分，整段放不下', deadline_window: '截止前放不下',
      outside_horizon: '超出七天窗口', dependency_blocked: '前置工作未排完',
      needs_deadline_day_window: '需截止当天时段核对', overdue_requires_consent: '逾期，须确认补做',
    }
    const gapBody = await bodyText(page)
    rec('⑤', '容量不足：缺口列出原因，不静默裁剪',
      unsched.length > 0 && unsched.every((u) => REASON_TEXT[u.reason] && gapBody.includes(REASON_TEXT[u.reason])),
      JSON.stringify(unsched.map((u) => ({ key: u.work_item_key, reason: u.reason }))))
    for (const label of ['确认仍有未排']) {
      while (await btn(page, label).count()) { await btn(page, label).first().click(); await page.waitForTimeout(200) }
    }
    await shot(page, 's7-02-gaps.png')
    await adopt(page)
    const d = await activeDraft(page, 'personal')
    rec('⑤', '缺口确认后采用：planned_gaps 留痕，未排工作不写成 0 分钟安排',
      d?.status === 'applied' && (d?.applied_summary?.counts?.plan_items_created ?? 0) === 0
      && (await docsOf(page, 'personal', 'plan_item')).length === 0,
      JSON.stringify(d?.applied_summary?.counts))
    await context.close()
  }

  // ========== S8 ③ 明确无截止：不擅自设今天 ==========
  {
    const { context, page } = await newScene('S8')
    await openAssistant(page)
    await pasteSource(page)
    await fillRequirement(page, '无截止测试')
    await setBudgets(page, 60)
    await generateAndWaitDraft(page)
    await btn(page, '明确无截止').click()
    await btn(page, '重新排程').click()
    await settle(page)
  await settle(page)
    await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
    if (await btn(page, '明确无截止').count()) await btn(page, '明确无截止').click() // 排程 bump 后新版重新确认
    await adopt(page)
    const tasks = await docsOf(page, 'personal', 'task')
    rec('③', '明确无截止 → precision=none，不自动设为今天',
      tasks[0]?.deadline?.precision === 'none' && tasks[0]?.deadline?.value == null,
      JSON.stringify(tasks[0]?.deadline))
    await shot(page, 's8-01-no-deadline.png')
    await context.close()
  }

  // ========== S10 ⑨ 后端边界（真实 HTTP，fixture 实例）：鉴权/版本/体积/非法结构 ==========
  {
    const minimalContext = {
      timezone: 'Asia/Shanghai', today: TODAY, start_date: TODAY, horizon_days: 7,
      days: Array.from({ length: 7 }, (_, i) => ({ date: D(i), budget_minutes: 60, committed_minutes: 0 })),
      protected_plans: [],
    }
    const baseReq = {
      protocol_version: '1.0', request_id: randomUUID(), thread_id: randomUUID(), turn_id: randomUUID(),
      client_seq: 1, workspace_id: 'probe', intent: 'new_plan', user_message: '边界探针',
      selected_sources: [], selected_tasks: [], selected_actions: [],
      planning_context: minimalContext, confirmed_requirements: [], pending_requirements: [], previous_draft: null,
    }
    const post = (body, token = TOKEN) => fetch(`${BACKEND}/api/assistant/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    const r401 = await post(baseReq, null)
    rec('⑨', 'propose 无令牌 → 401（与 analyze 同一 guard）', r401.status === 401, `status=${r401.status}`)
    const a401 = await fetch(`${BACKEND}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    rec('⑨', 'analyze 无令牌 → 401（共享鉴权入口）', a401.status === 401, `status=${a401.status}`)
    const r400 = await post({ ...baseReq, protocol_version: '9.9' })
    rec('⑨', '协议版本不支持 → 400', r400.status === 400, `status=${r400.status}`)
    const r422 = await post({ ...baseReq, forged_field: true })
    rec('⑨', '未知字段 → 422（严格校验，不猜字段）', r422.status === 422, `status=${r422.status}`)
    const big = JSON.stringify({ ...baseReq, pad: 'x'.repeat(600 * 1024) })
    const r413 = await fetch(`${BACKEND}/api/assistant/propose`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: big,
    })
    rec('⑨', '请求体超 512KiB → 413（按实际字节）', r413.status === 413, `status=${r413.status}`)
    const rOk = await post(baseReq)
    const okBody = await rOk.json()
    rec('⑨', '合法最小请求 → 200 且关联字段由服务端复制',
      rOk.status === 200 && okBody.request_id === baseReq.request_id && okBody.thread_id === baseReq.thread_id
      && okBody.turn_id === baseReq.turn_id && okBody.workspace_id === 'probe' && okBody.payload?.kind === 'proposal',
      `status=${rOk.status} kind=${okBody.payload?.kind}`)
  }

  rec('隔离', '全程未触碰用户 8000/8020 后端', netHits.length === 0, JSON.stringify(netHits.slice(0, 5)))
} catch (err) {
  exitCode = 1
  console.error('SCRIPT ERROR:', err)
  results.push({ item: '脚本', name: '异常中断', pass: false, detail: String(err && err.stack || err).split('\n').slice(0, 6).join(' | ') })
} finally {
  writeFileSync(join(RUN, 'results.json'), JSON.stringify(results, null, 2))
  writeFileSync(join(RUN, 'backend.log'), backendLog)
  writeFileSync(join(RUN, 'vite.log'), viteLog)
  await browser.close()
  vite.kill()
  backend.kill()
}
const failed = results.filter((r) => !r.pass)
console.log(`\n合计 ${results.length} 项断言，失败 ${failed.length} 项。`)
process.exit(exitCode || (failed.length ? 1 : 0))
