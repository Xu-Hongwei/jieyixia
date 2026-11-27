// M3 第二步「接入智能理解」浏览器验收（2026-11-25）——fixture 后端真实 HTTP 闭环。
// 真实生产页面 + 真实 IndexedDB；自起 fixture 后端（独立端口）与 Vite；
// 拦截并报告任何 :8000/:8020 命中，绝不触碰用户 8000 进程。全部虚构种子数据。
// 运行：node E:/qoder/devlog/private-evidence/assistant-mvp/M3/browser/m3-model-replan.mjs
// 产出：同目录 run-model-2026-11-25/（results.json + screenshots/ + 服务日志）；任一 FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'constraint-probe')
const SHOTS = join(RUN, 'screenshots')
for (const d of [RUN, SHOTS]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const PYTHON = 'D:/APP/miniconda3/python.exe'
const TOKEN = `m3-model-probe-${randomUUID()}`

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
  const proposeRequests = []
  context.on('request', (r) => {
    const u = r.url()
    if (/:8000|:8020/.test(u)) netHits.push(u)
    if (u.includes('/api/analyze')) counts.analyze += 1
    if (u.includes('/api/assistant/propose')) {
      counts.propose += 1
      try { proposeRequests.push(JSON.parse(r.postData())) } catch { proposeRequests.push(null) }
    }
  })
  await context.route(/:8000|:8020/, (route) => route.abort())
  const page = await context.newPage()
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, (e.stack || e.message).split('\n').slice(0, 4).join(' | ')))
  page.on('dialog', (d) => d.accept())
  return { context, page, counts, proposeRequests }
}
const delayPropose = (context, ms) => context.route('**/api/assistant/propose', async (route) => {
  await new Promise((r) => setTimeout(r, ms))
  await route.continue()
})

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

// 虚构种子（与本地冒烟同形）：目标任务 + 可替换/保留/受保护安排 + 其它任务占用 + 已结束专注会话。
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
// 助手页入口 → 勾选 p-1/p-2 → 填进展与清单 → 创建改排草案（纯本地，不调模型）。
async function createReplanDraft(page, { statement, minutes, reuse = 'a-report' }) {
  await page.evaluate(() => { location.hash = '#/assistant' })
  await waitText(page, '调整已有任务（改排）')
  await page.getByLabel('选择要调整的任务').selectOption('t-smoke')
  await btn(page, '选择任务并调整').click()
  await waitText(page, '调整后续安排 · 选择替换范围')
  await page.getByLabel(`替换安排 ${D(0)} 整理资料（旧安排）`).check()
  await page.getByLabel(`替换安排 ${D(1)} 写报告初稿（旧安排）`).check()
  await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').fill(statement)
  await page.getByLabel('第 1 行工作内容').fill('撰写报告正文')
  await page.getByLabel('第 1 行分钟数').fill(minutes)
  if (reuse) await page.getByLabel('第 1 行复用行动').selectOption(reuse)
  await btn(page, '创建改排草案').click()
  await waitText(page, '核对与确认', 20000)
}

let exitCode = 0
try {
  // ========== S1 模型建议主线：生成→建议未确认阻断采用→载入核对→保存→排程→原子采用 ==========
  {
    const { context, page, counts, proposeRequests } = await newScene('S1')
    await boot(page)
    await createReplanDraft(page, { statement: '资料读完了，报告还需安排 90 分钟', minutes: '90' })
    rec('S1', '创建草案未调模型', counts.propose === 0 && counts.analyze === 0, `propose=${counts.propose}`)
    await page.route('**/api/assistant/propose', async route => {
      const response = await route.fetch()
      const body = await response.json()
      if (body.payload?.kind === 'proposal') body.payload.proposal.work_items[0].earliest_date = D(2)
      await route.fulfill({ response, json: body })
    })
    await btn(page, '请助手整理剩余工作').click()
    await waitText(page, '助手建议清单（建议，未确认', 30000)
    rec('S1', '恰好一次 propose、零 analyze', counts.propose === 1 && counts.analyze === 0, `propose=${counts.propose}`)
    const req = proposeRequests[0]
    const rc = req?.replan_context
    const committedTotal = (req?.planning_context?.days ?? []).reduce((a, x) => a + x.committed_minutes, 0)
    const protectedIds = (req?.planning_context?.protected_plans ?? []).map((p) => p.plan_item_id).sort()
    rec('S1', '请求协议 1.1 + intent replan_task + 单任务上下文',
      req?.protocol_version === '1.1' && req?.intent === 'replan_task' && rc?.task_id === 't-smoke'
      && JSON.stringify((req?.selected_tasks ?? []).map((t) => t.id)) === JSON.stringify(['t-smoke']),
      JSON.stringify({ pv: req?.protocol_version, intent: req?.intent }))
    rec('S1', 'replan_context：替换 p-1/p-2，保留含未选与受保护（不含被替换）',
      JSON.stringify((rc?.replacements ?? []).map((r) => r.plan_item_id)) === JSON.stringify(['p-1', 'p-2'])
      && ['p-keep', 'p-prot', 'p-foc'].every((id) => (rc?.kept ?? []).some((k) => k.plan_item_id === id))
      && !(rc?.kept ?? []).some((k) => ['p-1', 'p-2'].includes(k.plan_item_id)),
      JSON.stringify({ kept: (rc?.kept ?? []).map((k) => k.plan_item_id) }))
    rec('S1', '有效占用：committed=全占用215−替换75=140；protected 不含被替换',
      committedTotal === 140 && JSON.stringify(protectedIds) === JSON.stringify(['p-foc', 'p-keep', 'p-other', 'p-prot']),
      JSON.stringify({ committedTotal, protectedIds }))
    rec('S1', '进展清单原样进请求（权威输入）；user_input 原话=进展说明',
      rc?.progress?.work_items?.[0]?.minutes === 90 && rc?.progress?.work_items?.[0]?.reuse_action_id === 'a-report'
      && req?.user_input?.original_user_request === '资料读完了，报告还需安排 90 分钟', '')
    const d1 = await activeDraft(page, 'personal')
    rec('S1', '桩建议落库：单 link 目标任务 + estimate_origin=model',
      d1?.proposal?.task_proposals?.length === 1 && d1?.proposal?.task_proposals?.[0]?.op === 'link'
      && d1?.proposal?.task_proposals?.[0]?.target_id === 't-smoke'
      && (d1?.proposal?.work_items ?? []).every((w) => w.estimate_origin === 'model')
      && d1?.proposal?.work_items?.[0]?.remaining_minutes === 90,
      JSON.stringify({ origin: d1?.proposal?.work_items?.[0]?.estimate_origin }))
    const body1 = await bodyText(page)
    rec('S1', '建议块可见（建议，未确认）+ 采用被阻断并提示核对',
      body1.includes('助手建议清单（建议，未确认') && body1.includes('助手建议清单尚未核对确认')
      && await btn(page, '采用计划').isDisabled(), '')
    await shot(page, 's1-01-suggestion-blocked.png')
    await btn(page, '载入建议到清单（核对后保存）').click()
    await page.waitForTimeout(200)
    rec('S1', '载入建议回填清单行（文本/分钟/复用）',
      await page.getByLabel('第 1 行工作内容').inputValue() === '撰写报告正文'
      && await page.getByLabel('第 1 行分钟数').inputValue() === '90'
      && await page.getByLabel('第 1 行复用行动').inputValue() === 'a-report', '')
    await btn(page, '保存改排内容').click()
    await waitText(page, '改排内容已保存', 15000)
    const d2 = await activeDraft(page, 'personal')
    rec('REVIEW', '载入并保存建议不得丢失最早开始日期', d2.proposal.work_items[0].earliest_date === D(2), JSON.stringify({before:d1.proposal.work_items[0].earliest_date,after:d2.proposal.work_items[0].earliest_date}))
    const body2 = await bodyText(page)
    rec('S1', '保存后清单 estimate_origin=user，建议块消失',
      (d2?.proposal?.work_items ?? []).length > 0 && d2.proposal.work_items.every((w) => w.estimate_origin === 'user')
      && !body2.includes('助手建议清单（建议，未确认'), '')
    await setBudgets(page, 120)
    await confirmScopeTwice(page)
    await waitText(page, '就绪核对通过，可采用', 15000)
    rec('S1', '核对确认后采用解锁', !(await btn(page, '采用计划').isDisabled()), '')
    const dSeg = (await activeDraft(page, 'personal'))?.planning_result?.segments ?? []
    rec('REVIEW', '核对后的安排不得早于模型建议最早日期', dSeg.every(s=>s.date>=D(2)), JSON.stringify({earliest:D(2),scheduledDates:dSeg.map(s=>s.date)}))
    await btn(page, '采用计划').click()
    await waitText(page, '确认采用计划')
    const adoptLabel = `确认替换 2 条旧安排，新增 ${dSeg.length} 条安排`
    await btn(page, adoptLabel).click()
    await waitText(page, '采用成功', 30000)
    const plans = await docsOf(page, 'personal', 'plan_item')
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]))
    const newPlans = plans.filter((p) => !['p-1', 'p-2', 'p-keep', 'p-prot', 'p-foc', 'p-other'].includes(p.id))
    const d3 = await activeDraft(page, 'personal')
    const tasks = await docsOf(page, 'personal', 'task')
    const actions = await docsOf(page, 'personal', 'action')
    rec('S1', '原子采用：p-1/p-2 取消且内容保留；未选/受保护/其它任务原样',
      byId['p-1']?.state === 'cancelled' && byId['p-2']?.state === 'cancelled'
      && byId['p-1']?.planned_minutes === 30 && byId['p-2']?.date === D(1)
      && ['p-keep', 'p-prot', 'p-foc', 'p-other'].every((id) => byId[id]?.state === 'planned')
      && byId['p-prot']?.actual_minutes === 10, '')
    rec('S1', '新安排全属目标任务、总量 90；复用不新增行动；总截止不变',
      newPlans.length === dSeg.length && newPlans.every((p) => p.task_id === 't-smoke')
      && newPlans.reduce((a, p) => a + p.planned_minutes, 0) === 90 && actions.length === 2
      && tasks.find((t) => t.id === 't-smoke')?.deadline?.value === D(6),
      JSON.stringify({ newPlans: newPlans.length, segs: dSeg.length, actions: actions.length }))
    rec('S1', '回执绑定取消集与目标任务；台账恰好一条',
      JSON.stringify(d3?.applied_summary?.cancelled_plan_item_ids ?? []) === JSON.stringify(['p-1', 'p-2'])
      && d3?.applied_summary?.replan_task_id === 't-smoke' && (await opsOf(page, 'personal')).length === 1, '')
    await shot(page, 's1-02-adopted.png')
    await context.close()
  }

  // ========== S2 未知分钟数：澄清→结构化回答续轮→建议→核对保存 ==========
  {
    const { context, page, counts, proposeRequests } = await newScene('S2')
    await boot(page)
    await createReplanDraft(page, { statement: '报告还需安排时间，分钟数未知', minutes: '' })
    await btn(page, '请助手整理剩余工作').click()
    await waitText(page, '模型需要澄清（集中回答后继续）', 30000)
    const body1 = await bodyText(page)
    rec('S2', '未知分钟数触发澄清（问题指向该行工作）', body1.includes('「撰写报告正文」还需要多少分钟'), '')
    rec('S2', '澄清轮也是 replan_task 1.1', proposeRequests[0]?.intent === 'replan_task' && proposeRequests[0]?.protocol_version === '1.1', '')
    await shot(page, 's2-01-clarification.png')
    await page.getByLabel(/回答：.*撰写报告正文/).fill('90')
    await btn(page, '继续生成').click()
    await waitText(page, '助手建议清单（建议，未确认', 30000)
    const req2 = proposeRequests[1]
    rec('S2', '续轮：同草案 replan_task；结构化问答归档（答=90），合成文本渲染',
      counts.propose === 2 && req2?.intent === 'replan_task' && req2?.replan_context?.task_id === 't-smoke'
      && req2?.user_input?.clarifications?.length === 1 && req2.user_input.clarifications[0].user_answer === '90'
      && (req2?.user_message ?? '').startsWith('原始要求：'),
      JSON.stringify({ n: counts.propose, clar: req2?.user_input?.clarifications }))
    const d1 = await activeDraft(page, 'personal')
    rec('S2', '回答值成为建议分钟数（仍 model，须核对）',
      d1?.proposal?.work_items?.[0]?.remaining_minutes === 90 && d1?.proposal?.work_items?.[0]?.estimate_origin === 'model', '')
    rec('S2', '建议未确认仍阻断采用', await btn(page, '采用计划').isDisabled(), '')
    await btn(page, '载入建议到清单（核对后保存）').click()
    await page.waitForTimeout(200)
    rec('S2', '载入回填分钟数 90', await page.getByLabel('第 1 行分钟数').inputValue() === '90', '')
    await btn(page, '保存改排内容').click()
    await waitText(page, '改排内容已保存', 15000)
    const d2 = await activeDraft(page, 'personal')
    rec('S2', '核对保存后 estimate_origin=user',
      (d2?.proposal?.work_items ?? []).every((w) => w.estimate_origin === 'user') && d2?.proposal?.work_items?.[0]?.remaining_minutes === 90, '')
    await shot(page, 's2-02-confirmed.png')
    await context.close()
  }

  // ========== S3 保存失败留结果：注入一次 IDB 写失败 → 重试保存成功且不重调模型 ==========
  {
    const { context, page, counts } = await newScene('S3')
    // 一次性注入：assistant_drafts 的下一次 put 抛错（事务整体回滚），模拟本地保存失败。
    await page.addInitScript(() => {
      const orig = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (...args) {
        if (window.__failDraftPut && this.name === 'assistant_drafts') {
          window.__failDraftPut = false
          throw new Error('injected save failure')
        }
        return orig.apply(this, args)
      }
    })
    await boot(page)
    await createReplanDraft(page, { statement: '资料读完了，报告还需安排 90 分钟', minutes: '90' })
    const before = await activeDraft(page, 'personal')
    await delayPropose(context, 5000)
    await btn(page, '请助手整理剩余工作').click()
    await waitText(page, '等待模型响应', 15000)
    // 负对照：生成中内容编辑被并发基线拒绝（generating 已落库，旧基线保存冲突不写入）。
    await btn(page, '保存改排内容').click()
    await waitText(page, '本次保存未写入', 10000)
    rec('S3', '生成中保存清单冲突拒写（generating 基线保护）', true, '')
    await page.evaluate(() => { window.__failDraftPut = true })
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('重试保存（不重调模型）')), null, { timeout: 20000 })
    const mid = await activeDraft(page, 'personal')
    rec('S3', '保存失败：结果留存待重试，草案未被改写（仍 90/user，版本未变）',
      counts.propose === 1 && mid?.proposal?.work_items?.[0]?.remaining_minutes === 90
      && mid?.proposal?.work_items?.[0]?.estimate_origin === 'user' && mid?.revision === before?.revision,
      JSON.stringify({ propose: counts.propose, rev: mid?.revision }))
    await shot(page, 's3-01-save-failed.png')
    await btn(page, '重试保存（不重调模型）').click()
    await waitText(page, '助手建议清单（建议，未确认', 20000)
    const after = await activeDraft(page, 'personal')
    rec('S3', '重试保存成功：建议落库 model、版本恰 +1；仍只调过一次模型',
      counts.propose === 1
      && (after?.proposal?.work_items ?? []).every((w) => w.estimate_origin === 'model')
      && after?.proposal?.work_items?.[0]?.remaining_minutes === 90
      && after?.revision === before.revision + 1,
      JSON.stringify({ rev: after?.revision, before: before?.revision, propose: counts.propose }))
    rec('S3', '建议未确认仍阻断采用', await btn(page, '采用计划').isDisabled(), '')
    await shot(page, 's3-02-retry-saved.png')
    await context.close()
  }

  // ========== S4 取消：在途取消保留输入，可再次生成 ==========
  {
    const { context, page, counts } = await newScene('S4')
    await boot(page)
    await createReplanDraft(page, { statement: '资料读完了，报告还需安排 90 分钟', minutes: '90' })
    await delayPropose(context, 6000)
    await btn(page, '请助手整理剩余工作').click()
    await waitText(page, '等待模型响应', 15000)
    await btn(page, '取消').click()
    await waitText(page, '已取消生成', 15000)
    const d1 = await activeDraft(page, 'personal')
    rec('S4', '取消后草案内容保留（本地用户清单不变）',
      d1?.proposal?.work_items?.[0]?.remaining_minutes === 90 && d1?.proposal?.work_items?.[0]?.estimate_origin === 'user'
      && ['editing', 'needs_review'].includes(d1?.status),
      JSON.stringify({ status: d1?.status }))
    await context.unroute('**/api/assistant/propose')
    await btn(page, '请助手整理剩余工作').click()
    await waitText(page, '助手建议清单（建议，未确认', 30000)
    const d2 = await activeDraft(page, 'personal')
    rec('S4', '取消后可再次生成（共 2 次 propose，建议落库）',
      counts.propose === 2 && d2?.proposal?.work_items?.[0]?.estimate_origin === 'model', '')
    await shot(page, 's4-01-regenerated.png')
    await context.close()
  }

  rec('全局', '全程未触碰用户 :8000/:8020 服务', netHits.length === 0, netHits.join(','))
} catch (err) {
  console.error(' harness 异常：', err)
  exitCode = 1
} finally {
  writeFileSync(join(RUN, 'results.json'), JSON.stringify({ date: TODAY, base: BASE, backend: BACKEND, results, netHits }, null, 2))
  writeFileSync(join(RUN, 'backend.log'), backendLog)
  writeFileSync(join(RUN, 'vite.log'), viteLog)
  await browser.close()
  vite.kill()
  backend.kill()
}
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
if (failed.length || exitCode) process.exit(1)
process.exit(0)
