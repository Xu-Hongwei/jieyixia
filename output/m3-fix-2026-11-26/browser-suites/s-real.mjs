// M3 真实模型改排验收（2026-11-26）——真实厂家模型 + 真实生产页面 + 真实 IndexedDB。
// 自起 model 模式后端（8030–8034）+ Vite（5182–5186）；JXL_MODELS 取自 .env.example，
// 密钥继承当前环境且不写入日志；显式拦截并报告 :8000/:8020 命中，绝不触碰用户进程。
// 全流程虚构数据：任务/行动/旧安排/专注会话均为假名，不含任何真实校名/姓名。
// 运行：node E:/qoder/devlog/private-evidence/assistant-mvp/M3/browser/m3-real-replan.mjs
// 产出：run-real-2026-11-26/（results.json + screenshots/ + backend.log + vite.log）；FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'runs', 'real-2026-11-26-postfix')
const SHOTS = join(RUN, 'screenshots')
for (const d of [RUN, SHOTS]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const PYTHON = 'D:/APP/miniconda3/python.exe'
const TOKEN = `m3-real-probe-${randomUUID()}`

if (!process.env.DASHSCOPE_API_KEY && !process.env.DEEPSEEK_API_KEY) {
  console.error('当前环境无可用模型密钥（DASHSCOPE_API_KEY/DEEPSEEK_API_KEY），真实模型闭环无法验证')
  process.exit(3)
}
const envExample = readFileSync('E:/qoder/backend/.env.example', 'utf8')
const MODELS_RAW = (envExample.match(/^JXL_MODELS=(.*)$/m) || [])[1]?.trim()
if (!MODELS_RAW) { console.error('.env.example 未找到 JXL_MODELS'); process.exit(2) }

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
for (const p of [5182, 5183, 5184, 5185, 5186]) { if (await portFree(p)) { VPORT = p; break } }
if (VPORT == null) { console.error('无空闲 Vite 端口（5182–5186），显式退出，不杀未知服务'); process.exit(2) }
let BPORT = null
for (const p of [8030, 8031, 8032, 8033, 8034]) { if (await portFree(p)) { BPORT = p; break } }
if (BPORT == null) { console.error('无空闲后端端口（8030–8034），显式退出，不杀未知服务'); process.exit(2) }
const BASE = `http://127.0.0.1:${VPORT}/`
const BACKEND = `http://127.0.0.1:${BPORT}`

const backend = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(BPORT)], {
  cwd: 'E:/qoder/backend',
  env: {
    ...process.env, JXL_PROVIDER: 'model', JXL_MODELS: MODELS_RAW, JXL_MODEL_ORDER: 'qwen,deepseek',
    JXL_API_TOKEN: TOKEN, JXL_CORS_ORIGINS: `http://127.0.0.1:${VPORT},http://localhost:${VPORT}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let backendLog = ''
backend.stdout.on('data', (d) => { backendLog += d }); backend.stderr.on('data', (d) => { backendLog += d })
let healthz = null
{
  const deadline = Date.now() + 30000
  for (;;) {
    try { const r = await fetch(`${BACKEND}/api/healthz`); if (r.ok) { healthz = await r.json(); break } } catch {}
    if (Date.now() > deadline) { writeFileSync(join(RUN, 'backend.log'), backendLog); console.error(backendLog); backend.kill(); throw new Error('model 后端未就绪') }
    await new Promise((r) => setTimeout(r, 300))
  }
}
console.log(`model 后端就绪：${BACKEND} model_ready=${healthz?.model_ready}`)

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
async function newScene(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
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
    console.log(`WAIT TIMEOUT「${text}」BODY:\n`, (await page.evaluate(() => document.body.innerText)).slice(0, 1800))
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
  await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 15000 })
  if (await btn(page, '确认替换范围').count()) {
    await btn(page, '确认替换范围').click()
    await page.waitForTimeout(200)
  }
}
async function createReplanDraft(page, { statement, minutes }) {
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
  await page.getByLabel('第 1 行复用行动').selectOption('a-report')
  await btn(page, '创建改排草案').click()
  await waitText(page, '核对与确认', 20000)
}

let exitCode = 0
try {
  const { context, page, counts, proposeRequests } = await newScene('真实')
  rec('真实', 'model 后端 model_ready=true（密钥可装载，健康检查不触发付费）', healthz?.model_ready === true, `model_ready=${healthz?.model_ready}`)
  await boot(page)
  await createReplanDraft(page, { statement: '资料读完了，报告还需安排 90 分钟，周四没空', minutes: '90' })
  rec('真实', '创建改排草案零模型调用', counts.propose === 0 && counts.analyze === 0, `propose=${counts.propose}`)

  await btn(page, '请助手整理剩余工作').click()
  // 真实模型偶发 invalid_output（服务端已按预算内部重试）；页面此时给「可重新生成/重试生成」，
  // 用户侧动作就是重试，harness 按同一交互最多重试 2 次，并把次数计入证据。
  let modelRetries = 0
  const deadline = Date.now() + 180000
  let lastProbe = 0
  for (;;) {
    const b = await bodyText(page)
    if (b.includes('助手建议清单（建议，未确认')) break
    if (b.includes('模型需要澄清（集中回答后继续）')) {
      const n = await page.getByLabel(/回答：/).count()
      for (let i = 0; i < n; i += 1) await page.getByLabel(/回答：/).nth(i).fill('90')
      await btn(page, '继续生成').click()
      continue
    }
    // 失败提示 toast 会残留「可重新生成」文案；只认按钮本身是否可见，避免重复点击已消失的重试。
    if (await btn(page, '重试生成').isVisible().catch(() => false)) {
      if (modelRetries >= 2) throw new Error('真实模型连续三次输出不符合契约，重试耗尽')
      modelRetries += 1
      await btn(page, '重试生成').click()
      continue
    }
    if (Date.now() - lastProbe > 10000) {
      lastProbe = Date.now()
      const d = await activeDraft(page, 'personal')
      console.log('PROBE waiting', JSON.stringify({
        status: d?.status, rev: d?.revision,
        items: (d?.proposal?.work_items ?? []).map((w) => [w.key, w.remaining_minutes, w.estimate_origin]),
        flags: ['可重新生成', '需先确认', '助手建议', '失败', '澄清'].filter((t) => b.includes(t)),
      }))
    }
    if (Date.now() > deadline) {
      console.log('BODY TAIL:\n', (await bodyText(page)).slice(0, 4000))
      await waitText(page, '助手建议清单（建议，未确认', 1000); break
    }
    await page.waitForTimeout(500)
  }
  rec('真实', `真实模型成功给出建议、零 analyze（propose 共 ${counts.propose} 次，其中失败重试 ${modelRetries} 次）`,
    counts.analyze === 0 && counts.propose === 1 + modelRetries,
    `propose=${counts.propose} retries=${modelRetries}`)
  const req = proposeRequests[0]
  rec('真实', '请求协议 1.1 + intent replan_task + 单任务 + 原话进展',
    req?.protocol_version === '1.1' && req?.intent === 'replan_task'
    && JSON.stringify((req?.selected_tasks ?? []).map((t) => t.id)) === JSON.stringify(['t-smoke'])
    && req?.user_input?.original_user_request === '资料读完了，报告还需安排 90 分钟，周四没空',
    JSON.stringify({ pv: req?.protocol_version, intent: req?.intent }))
  const rc = req?.replan_context
  rec('真实', 'replan_context：替换 p-1/p-2，保留含未选与受保护（不含被替换）',
    JSON.stringify((rc?.replacements ?? []).map((r) => r.plan_item_id)) === JSON.stringify(['p-1', 'p-2'])
    && ['p-keep', 'p-prot', 'p-foc'].every((id) => (rc?.kept ?? []).some((k) => k.plan_item_id === id)),
    JSON.stringify({ kept: (rc?.kept ?? []).map((k) => k.plan_item_id) }))

  const d1 = await activeDraft(page, 'personal')
  const wifi = d1?.proposal?.work_items ?? []
  const realLogLines = backendLog.split('\n').filter((l) => l.includes('model_propose')).slice(-3)
  // backend.log 为结构化 JSON 行："profile": "qwen"
  rec('真实', '真实厂家调用可审计（后端日志 model_propose + profile）',
    realLogLines.length >= 1 && /"profile":\s*"(qwen|deepseek)"/.test(realLogLines.join('\n')),
    realLogLines.join(' | ').slice(0, 300))
  rec('真实', '真实建议通过服务端语义校验：工作项非空且全部 model 来源（须用户核对）',
    wifi.length >= 1 && wifi.every((w) => w.estimate_origin === 'model'),
    JSON.stringify(wifi.map((w) => [w.key, w.remaining_minutes])))
  rec('真实', '建议未确认时采用被阻断', (await bodyText(page)).includes('助手建议清单尚未核对确认') && await btn(page, '采用计划').isDisabled(), '')
  await shot(page, 'r1-01-real-suggestion.png')

  await btn(page, '载入建议到清单（核对后保存）').click()
  await page.waitForTimeout(400)
  const rowCount = await page.getByLabel(/^第 \d+ 行工作内容$/).count()
  for (let i = rowCount; i >= 2; i -= 1) {
    await page.getByRole('button', { name: `删除第 ${i} 行` }).click()
    await page.waitForTimeout(100)
  }
  await page.getByLabel('第 1 行工作内容').fill('撰写报告正文')
  await page.getByLabel('第 1 行分钟数').fill('90')
  await page.getByLabel('第 1 行复用行动').selectOption('a-report')
  await btn(page, '保存改排内容').click()
  await waitText(page, '改排内容已保存', 20000)
  const d2 = await activeDraft(page, 'personal')
  rec('真实', '用户核对保存后清单=user 来源、总量 90、建议块消失',
    (d2?.proposal?.work_items ?? []).length === 1
    && d2.proposal.work_items[0].estimate_origin === 'user'
    && d2.proposal.work_items[0].remaining_minutes === 90
    && !(await bodyText(page)).includes('助手建议清单（建议，未确认'),
    JSON.stringify(d2?.proposal?.work_items ?? []))

  await setBudgets(page, 120)
  await confirmScopeTwice(page)
  await waitText(page, '就绪核对通过，可采用', 15000)
  rec('真实', '核对确认后采用解锁', !(await btn(page, '采用计划').isDisabled()), '')
  const dSeg = (await activeDraft(page, 'personal'))?.planning_result?.segments ?? []
  await btn(page, '采用计划').click()
  await waitText(page, '确认采用计划')
  await btn(page, `确认替换 2 条旧安排，新增 ${dSeg.length} 条安排`).click()
  await waitText(page, '采用成功', 30000)

  const plans = await docsOf(page, 'personal', 'plan_item')
  const byId = Object.fromEntries(plans.map((p) => [p.id, p]))
  const known = ['p-1', 'p-2', 'p-keep', 'p-prot', 'p-foc', 'p-other']
  const newPlans = plans.filter((p) => !known.includes(p.id))
  const tasks = await docsOf(page, 'personal', 'task')
  const actions = await docsOf(page, 'personal', 'action')
  const d3 = await activeDraft(page, 'personal')
  const ops = await opsOf(page, 'personal')
  rec('真实', '原子采用：旧 p-1/p-2 取消且内容保留；未选/受保护/其它任务原样',
    byId['p-1']?.state === 'cancelled' && byId['p-2']?.state === 'cancelled'
    && byId['p-1']?.planned_minutes === 30 && byId['p-2']?.date === D(1)
    && ['p-keep', 'p-prot', 'p-foc', 'p-other'].every((id) => byId[id]?.state === 'planned')
    && byId['p-prot']?.actual_minutes === 10, '')
  rec('真实', '新安排全属目标任务、总量 90；任务不重复、截止不变、复用不新增行动',
    newPlans.length === dSeg.length && newPlans.every((p) => p.task_id === 't-smoke')
    && newPlans.reduce((a, p) => a + p.planned_minutes, 0) === 90
    && tasks.length === 2 && tasks.find((t) => t.id === 't-smoke')?.deadline?.value === D(6)
    && actions.length === 2,
    JSON.stringify({ newPlans: newPlans.length, segs: dSeg.length, tasks: tasks.length, actions: actions.length }))
  rec('真实', '回执绑定取消集与目标任务；台账恰好一条',
    JSON.stringify(d3?.applied_summary?.cancelled_plan_item_ids ?? []) === JSON.stringify(['p-1', 'p-2'])
    && d3?.applied_summary?.replan_task_id === 't-smoke'
    && ops.filter((o) => o.state === 'committed').length === 1, '')
  await shot(page, 'r1-02-real-adopted.png')
  rec('全局', '全程未触碰用户 :8000/:8020 服务', netHits.length === 0, netHits.join(','))
  await context.close()
} catch (err) {
  console.error(' harness 异常：', err)
  exitCode = 1
} finally {
  writeFileSync(join(RUN, 'results.json'), JSON.stringify({ date: TODAY, base: BASE, backend: BACKEND, modelReady: healthz?.model_ready ?? null, results, netHits }, null, 2))
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