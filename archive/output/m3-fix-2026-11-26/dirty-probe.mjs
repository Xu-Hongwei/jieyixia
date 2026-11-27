// M3 F1 整改复验（2026-11-26 副本）：改排面板未保存修改必须阻断旧方案，且零写入。
// 真实生产页面 + 真实 IndexedDB；自起 fixture 后端（独立端口）与 Vite；
// 拦截并报告任何 :8000/:8020 命中，绝不触碰用户 8000 进程。全部虚构种子数据。
// 运行：node E:/qoder/output/m3-fix-2026-11-26/dirty-probe.mjs
// 产出：同目录 dirty-probe/（results.json + screenshots/ + 服务日志）；任一 FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'dirty-probe')
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
async function waitForFunction(page, fn, timeout = 15000) {
  return page.waitForFunction(fn, null, { timeout })
}
async function waitDraft(page, ws, pred, timeout = 20000) {
  const deadline = Date.now() + timeout
  let last = null
  for (;;) {
    last = await activeDraft(page, ws)
    if (last && pred(last)) return last
    if (Date.now() > deadline) throw new Error(`waitDraft 超时：${JSON.stringify({ rev: last?.revision, ids: last?.planning_input?.replacement_ids, status: last?.status })}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

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
try {
  // ========== S1 助手页入口：选任务 → 勾选 → 清单 → 双轮确认 → 三块预览 → 一次采用 ==========
  {
    const { context, page, counts } = await newScene('S1')
    await boot(page)
    await page.evaluate(() => { location.hash = '#/assistant' })
    await waitText(page, '调整已有任务（改排）')
    await page.getByLabel('选择要调整的任务').selectOption('t-smoke')
    await btn(page, '选择任务并调整').click()
    await waitText(page, '调整后续安排 · 选择替换范围')
    const body = await bodyText(page)
    rec('S1', '面板展示任务名/总截止/本轮不修改截止', body.includes('虚构：课程报告') && body.includes('总截止') && body.includes('本轮不修改截止'), '')
    rec('S1', '受保护条目只读并展示原因（已有投入/专注会话）', body.includes('已有投入记录') && body.includes('有专注会话引用'), '')
    rec('S1', '可替换条目有复选框，受保护条目无复选框',
      await page.getByLabel(`替换安排 ${D(0)} 整理资料（旧安排）`).count() === 1
      && await page.getByLabel(`替换安排 ${D(3)} 已投入的安排`).count() === 0
      && await page.getByLabel(`替换安排 ${D(4)} 有专注记录的安排`).count() === 0, '')
    await shot(page, 's1-01-setup.png')
    await page.getByLabel(`替换安排 ${D(0)} 整理资料（旧安排）`).check()
    await page.getByLabel(`替换安排 ${D(1)} 写报告初稿（旧安排）`).check()
    await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').fill('资料读完了，报告还需安排 90 分钟')
    await page.getByLabel('第 1 行工作内容').fill('撰写报告正文')
    await page.getByLabel('第 1 行分钟数').fill('90')
    await page.getByLabel('第 1 行复用行动').selectOption('a-report')
    await btn(page, '创建改排草案').click()
    await waitText(page, '核对与确认', 20000)
    const d1 = await activeDraft(page, 'personal')
    rec('S1', 'replan 草案创建：mode/scope/progress/建议齐全，未调模型',
      d1?.mode === 'replan' && d1?.replan_scope?.task_id === 't-smoke'
      && JSON.stringify(d1?.replan_scope?.replacement_ids) === JSON.stringify(['p-1', 'p-2'])
      && d1?.progress_input?.work_items?.[0]?.minutes === 90
      && d1?.proposal?.task_proposals?.[0]?.op === 'link'
      && counts.propose === 0 && counts.analyze === 0,
      JSON.stringify({ mode: d1?.mode, ids: d1?.replan_scope?.replacement_ids, propose: counts.propose }))
    rec('S1', '替换范围确认面板在排程前可见', await btn(page, '确认替换范围').count() === 1, '')
    await setBudgets(page, 120)
    await btn(page, '重新排程').click()
    await waitText(page, '排程前需先确认下方事项', 15000)
    rec('S1', '保留安排触发排程前范围澄清（不静默排程）', true, '')
    await confirmScopeTwice(page)
    await waitText(page, '就绪核对通过，可采用', 15000)
    const d2 = await activeDraft(page, 'personal')
    const segs = d2?.planning_result?.segments ?? []
    const segTotal = segs.reduce((a, s) => a + s.minutes, 0)
    rec('S1', '排程冻结替换基线：2 条快照 + 新排总量 90',
      d2?.replacement_baseline?.items?.length === 2 && segTotal === 90 && segs.length > 0,
      JSON.stringify({ baseline: d2?.replacement_baseline?.items?.map((i) => i.plan_item_id), segTotal, segs: segs.length }))
    const body2 = await bodyText(page)
    rec('S1', '三块预览：保留/将取消/将新增 + 总量口径',
      body2.includes('改排预览：保留 / 将取消 / 将新增') && body2.includes('将取消（2）') && body2.includes(`将新增（${segs.length}）`)
      && body2.includes('待安排总量 90 分钟') && body2.includes('已排入 90') && body2.includes('未排入 0'), '')
    rec('S1', '保留块含未选/受保护/其它任务安排', body2.includes('核对数据（保留）') && body2.includes('已投入的安排') && body2.includes('有专注记录的安排') && body2.includes('其它任务的安排'), '')
    await shot(page, 's1-02-preview.png')
    // ---- F1 复验：取消勾选 + 改分钟数后，旧方案必须被阻断且零写入 ----
    const revReady = d2.revision
    const opsBefore = (await opsOf(page, 'personal')).length
    await page.getByLabel(`替换安排 ${D(1)} 写报告初稿（旧安排）`).uncheck()
    await page.getByLabel('第 1 行分钟数').fill('180')
    await page.waitForTimeout(300)
    const dirtyBody = await bodyText(page)
    const dDirty = await activeDraft(page, 'personal')
    const plansDuring = await docsOf(page, 'personal', 'plan_item')
    rec('F1', '未保存修改后旧采用禁用', await btn(page, '采用计划').isDisabled(), JSON.stringify({ unchecked: !(await page.getByLabel(`替换安排 ${D(1)} 写报告初稿（旧安排）`).isChecked()), minutes: await page.getByLabel('第 1 行分钟数').inputValue() }))
    rec('F1', '未保存修改给出「先保存并重排」提示', dirtyBody.includes('改排面板有未保存修改') && dirtyBody.includes('保存改排内容'), '')
    rec('F1', '未保存修改阶段零写入（草案版本/旧安排/台账不变）',
      dDirty.revision === revReady
      && plansDuring.find((p) => p.id === 'p-1')?.state === 'planned'
      && plansDuring.find((p) => p.id === 'p-2')?.state === 'planned'
      && (await opsOf(page, 'personal')).length === opsBefore,
      JSON.stringify({ revision: dDirty.revision, revReady, ops: opsBefore }))
    rec('F1', '旧采用弹窗不会打开', await btn(page, '采用计划').count() === 1 && !(await bodyText(page)).includes('确认采用计划'), '')
    await shot(page, 'f1-01-dirty-blocked.png')

    // ---- F1 正路：保存 → 重新确认范围 → 重排 → 就绪 → 采用新方案 ----
    await btn(page, '保存改排内容').click()
    await waitText(page, '改排内容已保存')
    await page.waitForTimeout(300)
    rec('F1', '保存后未保存提示消失', !(await bodyText(page)).includes('改排面板有未保存修改'), '')
    await waitForFunction(page, () => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '确认替换范围'), 15000)
    await btn(page, '确认替换范围').click()
    await page.waitForTimeout(200)
    await btn(page, '重新排程').click()
    const dNew = await waitDraft(page, 'personal', (d) => d.revision > revReady && JSON.stringify(d.planning_input?.replacement_ids) === JSON.stringify(['p-1']) && !!d.planning_result)
    await waitText(page, '七天预览（按日竖排）')
    await waitForFunction(page, () => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '确认替换范围'), 15000)
    await btn(page, '确认替换范围').click()
    await confirmAll(page)
    await waitText(page, '就绪核对通过，可采用', 20000)
    const newSegs = dNew?.planning_result?.segments ?? []
    rec('F1', '保存重排后按新选择：仅替换 p-1，p-2 保留',
      JSON.stringify(dNew?.planning_input?.replacement_ids) === JSON.stringify(['p-1'])
      && dNew?.replacement_baseline?.items?.map((i) => i.plan_item_id).join(',') === 'p-1',
      JSON.stringify({ ids: dNew?.planning_input?.replacement_ids, baseline: dNew?.replacement_baseline?.items?.map((i) => i.plan_item_id) }))
    rec('F1', '保存重排后新总量 180 分钟', newSegs.reduce((a, s) => a + s.minutes, 0) === 180, JSON.stringify({ segs: newSegs.length, total: newSegs.reduce((a, s) => a + s.minutes, 0) }))

    // ---- F1 弹窗已开时改动面板：旧弹窗必须关闭、prepared 失效 ----
    await btn(page, '采用计划').click()
    await waitText(page, '确认采用计划')
    await page.evaluate((label) => document.querySelector(`[aria-label="${label}"]`)?.click(), `替换安排 ${D(1)} 写报告初稿（旧安排）`)
    await page.waitForFunction(() => !document.body.innerText.includes('确认采用计划'), null, { timeout: 5000 })
    rec('F1', '弹窗打开后改动面板 → 旧弹窗立即关闭并提示', (await bodyText(page)).includes('改排面板有未保存修改'), '')
    await page.evaluate((label) => document.querySelector(`[aria-label="${label}"]`)?.click(), `替换安排 ${D(1)} 写报告初稿（旧安排）`)
    await page.waitForTimeout(300)
    rec('F1', '恢复为已保存状态后采用重新可用', !(await btn(page, '采用计划').isDisabled()), '')

    await btn(page, '采用计划').click()
    await waitText(page, '确认采用计划')
    const adoptLabel = `确认替换 1 条旧安排，新增 ${newSegs.length} 条安排`
    rec('S1', '采用弹窗按钮文案含替换/新增数量', await btn(page, adoptLabel).count() === 1, adoptLabel)
    await shot(page, 's1-03-dialog.png')
    await btn(page, adoptLabel).click()
    await waitText(page, '采用成功', 30000)
    const plans = await docsOf(page, 'personal', 'plan_item')
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]))
    const d3 = await activeDraft(page, 'personal')
    const tasks = await docsOf(page, 'personal', 'task')
    const actions = await docsOf(page, 'personal', 'action')
    const newPlans = plans.filter((p) => !['p-1', 'p-2', 'p-keep', 'p-prot', 'p-foc', 'p-other'].includes(p.id))
    rec('F1', '不能取消用户刚取消勾选的旧安排或忽略新分钟数', byId['p-2']?.state === 'planned' && newPlans.reduce((s, p) => s + p.planned_minutes, 0) === 180, JSON.stringify({ p2: byId['p-2']?.state, newMinutes: newPlans.reduce((s, p) => s + p.planned_minutes, 0) }))
    rec('S1', '原子采用：仅 p-1 取消且内容字段保留',
      byId['p-1']?.state === 'cancelled'
      && byId['p-1']?.planned_minutes === 30 && byId['p-1']?.action_text === '整理资料（旧安排）'
      && byId['p-2']?.state === 'planned',
      JSON.stringify({ p1: byId['p-1']?.state, p2: byId['p-2']?.state }))
    rec('S1', '未选/受保护/其它任务安排原样保留',
      ['p-keep', 'p-prot', 'p-foc', 'p-other'].every((id) => byId[id]?.state === 'planned')
      && byId['p-prot']?.actual_minutes === 10, '')
    rec('S1', '新安排=重排段数、全属目标任务、总量 180；复用行动不新增行动',
      newPlans.length === newSegs.length && newPlans.every((p) => p.task_id === 't-smoke')
      && newPlans.reduce((a, p) => a + p.planned_minutes, 0) === 180
      && actions.length === 2,
      JSON.stringify({ newPlans: newPlans.length, segs: newSegs.length, actions: actions.length }))
    rec('S1', '总截止不变；草案 applied 只读；回执取消集绑定',
      tasks.find((t) => t.id === 't-smoke')?.deadline?.value === D(6)
      && d3?.status === 'applied'
      && JSON.stringify(d3?.applied_summary?.cancelled_plan_item_ids ?? []) === JSON.stringify(['p-1'])
      && d3?.applied_summary?.replan_task_id === 't-smoke',
      JSON.stringify({ deadline: tasks.find((t) => t.id === 't-smoke')?.deadline?.value, status: d3?.status, cancel: d3?.applied_summary?.cancelled_plan_item_ids }))
    const ops = await opsOf(page, 'personal')
    rec('S1', '采用台账恰好一条（无重复写入）', ops.length === 1, `ops=${ops.length}`)
    await shot(page, 's1-04-adopted.png')
    await btn(page, '查看任务').first().click()
    await page.waitForFunction(() => location.hash.startsWith('#/tasks/t-smoke'), null, { timeout: 10000 })
    rec('S1', '采用后「查看任务」进入原任务详情', true, page.url())
    await context.close()
  }

  // ========== S2 任务详情入口 + 零预算：零新安排阻断采用（不整批清空） ==========
  {
    const { context, page } = await newScene('S2')
    await boot(page)
    await page.evaluate(() => { location.hash = '#/tasks/t-smoke' })
    await waitText(page, '跨日安排', 20000)
    await btn(page, '调整后续安排').click()
    await page.waitForFunction(() => location.hash.includes('replanTask=t-smoke'), null, { timeout: 10000 })
    await waitText(page, '调整后续安排 · 选择替换范围')
    rec('S2', '任务详情入口带 replanTask 直达改排面板', true, page.url())
    await page.getByLabel(`替换安排 ${D(0)} 整理资料（旧安排）`).check()
    await page.getByPlaceholder('例如：资料读完了，报告还需安排 90 分钟，周四没空').fill('报告还需 90 分钟，但本轮每天都没有空')
    await page.getByLabel('第 1 行工作内容').fill('撰写报告正文')
    await page.getByLabel('第 1 行分钟数').fill('90')
    await page.getByLabel('第 1 行复用行动').selectOption('a-report')
    await btn(page, '创建改排草案').click()
    await waitText(page, '核对与确认', 20000)
    await setBudgets(page, 0)
    await btn(page, '确认替换范围').click()
    await page.waitForTimeout(200)
    await btn(page, '重新排程').click()
    await waitText(page, '七天预览（按日竖排）')
    await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 10000 })
    if (await btn(page, '确认替换范围').count()) { await btn(page, '确认替换范围').click(); await page.waitForTimeout(200) }
    await confirmAll(page)
    await page.waitForTimeout(300)
    const d = await activeDraft(page, 'personal')
    const segs = d?.planning_result?.segments ?? []
    const body = await bodyText(page)
    rec('S2', '零预算：新安排为零，缺口 90 保留可见',
      segs.length === 0 && body.includes('未排入 90') && body.includes('新安排为零'),
      JSON.stringify({ segs: segs.length, status: d?.status }))
    rec('S2', '零新安排时采用按钮禁用（不整批清空）', await btn(page, '采用计划').isDisabled(), '')
    const plans = await docsOf(page, 'personal', 'plan_item')
    rec('S2', '未采用：所有旧安排原样（p-1 仍 planned）', plans.find((p) => p.id === 'p-1')?.state === 'planned', '')
    await shot(page, 's2-01-zero-new.png')
    await context.close()
  }

  // ========== S3 移动端：改排面板与三块预览可渲染 ==========
  {
    const { context, page } = await newScene('S3', { mobile: true })
    await boot(page)
    await page.evaluate(() => { location.hash = '#/assistant' })
    await waitText(page, '调整已有任务（改排）')
    await page.getByLabel('选择要调整的任务').selectOption('t-smoke')
    await btn(page, '选择任务并调整').click()
    await waitText(page, '调整后续安排 · 选择替换范围')
    await shot(page, 's3-01-mobile-setup.png')
    rec('S3', '移动端改排面板渲染（含保护原因）', (await bodyText(page)).includes('已有投入记录'), '')
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
