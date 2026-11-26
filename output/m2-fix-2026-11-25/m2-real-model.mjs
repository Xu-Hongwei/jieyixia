// M2 真实模型图文闭环探针（2026-11-25，开工单 §7 步骤 4「至少一次真实模型图文调用有证据」）。
// 自起 model 模式后端（独立端口 8030–8033，JXL_MODELS 取自 .env.example，密钥继承当前环境）＋ Vite（5182–5185）。
// 绝不触碰用户 8000/8020 进程（拦截并报告任何命中）。全部虚构资料：fixtures/assets/01-course-assignment.png（合成课程通知）。
// 真实 analyze（视觉理解）＋真实 propose（任务拆解）→ 核对便签 → 排程 → 采用，记录截止出处（note/manual）。
// 运行：node E:/qoder/devlog/private-evidence/assistant-mvp/M2/browser/m2-real-model.mjs
// 产出：同目录 run-real-2026-11-25/（results.json + screenshots/ + 服务日志，日志不含密钥）；任一 FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'run-real-2026-11-25')
const SHOTS = join(RUN, 'screenshots')
for (const d of [RUN, SHOTS]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const PYTHON = 'D:/APP/miniconda3/python.exe'
const TOKEN = `m2-real-${randomUUID()}`
const PNG = 'E:/qoder/fixtures/assets/01-course-assignment.png'

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true })
const bjToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
function bjAddDays(s, n) { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const TODAY = bjToday(); const D = (i) => bjAddDays(TODAY, i)

function portFree(port) {
  return new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(port, '127.0.0.1') })
}
let VPORT = null
for (const p of [5182, 5183, 5184, 5185]) { if (await portFree(p)) { VPORT = p; break } }
if (VPORT == null) { console.error('无空闲 Vite 端口（5182–5185），显式退出，不杀未知服务'); process.exit(2) }
let BPORT = null
for (const p of [8030, 8031, 8032, 8033]) { if (await portFree(p)) { BPORT = p; break } }
if (BPORT == null) { console.error('无空闲后端端口（8030–8033），显式退出，不杀未知服务'); process.exit(2) }
const BASE = `http://127.0.0.1:${VPORT}/`
const BACKEND = `http://127.0.0.1:${BPORT}`

// JXL_MODELS 取自 .env.example（qwen 主 / deepseek 备；缺钥 profile 自动跳过）。密钥本身继承当前环境，不写入日志。
// 探针实例配置：各 profile retries=0。propose 总尝试硬上限=2（正式后端冻结），qwen-flash 视觉强但提案 JSON 常 invalid_output；
// retries=0 让 propose 的 2 次预算落在 qwen1→deepseek1（deepseek-chat 纯文本、JSON 更稳），analyze 仍由 qwen 视觉首尝完成。
// 这是探针自身后端实例的环境配置，不改正式后端代码/默认重试策略（用户 8000 不受影响）。
const envExample = readFileSync('E:/qoder/backend/.env.example', 'utf8')
const MODELS_RAW = (envExample.match(/^JXL_MODELS=(.*)$/m) || [])[1]?.trim()
if (!MODELS_RAW) { console.error('.env.example 未找到 JXL_MODELS'); process.exit(2) }
const MODELS = JSON.stringify(JSON.parse(MODELS_RAW).map((p) => ({ ...p, retries: 0 })))
if (!process.env.DASHSCOPE_API_KEY && !process.env.DEEPSEEK_API_KEY) {
  console.error('当前环境无可用模型密钥（DASHSCOPE_API_KEY/DEEPSEEK_API_KEY），真实模型闭环无法验证'); process.exit(3)
}

const backend = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(BPORT)], {
  cwd: 'E:/qoder/backend',
  env: { ...process.env, JXL_PROVIDER: 'model', JXL_MODELS: MODELS, JXL_MODEL_ORDER: 'qwen,deepseek', JXL_API_TOKEN: TOKEN, JXL_CORS_ORIGINS: `http://127.0.0.1:${VPORT},http://localhost:${VPORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let backendLog = ''
backend.stdout.on('data', (d) => { backendLog += d }); backend.stderr.on('data', (d) => { backendLog += d })
let modelReady = false
{
  const deadline = Date.now() + 30000
  for (;;) {
    try { const r = await fetch(`${BACKEND}/api/healthz`); if (r.ok) { modelReady = (await r.json()).model_ready === true; break } } catch {}
    if (Date.now() > deadline) { writeFileSync(join(RUN, 'backend.log'), backendLog); console.error(backendLog); backend.kill(); throw new Error('model 后端未就绪') }
    await new Promise((r) => setTimeout(r, 300))
  }
}
console.log(`model 后端就绪：${BACKEND} model_ready=${modelReady}`)

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
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const counts = { analyze: 0, propose: 0 }
const proposeBodies = []
context.on('request', (r) => {
  const u = r.url()
  if (/:8000|:8020/.test(u)) netHits.push(u)
  if (u.includes('/api/analyze')) counts.analyze += 1
  if (u.includes('/api/assistant/propose')) { counts.propose += 1; try { proposeBodies.push(JSON.parse(r.postData() || 'null')) } catch { proposeBodies.push(null) } }
})
await context.route(/:8000|:8020/, (route) => route.abort())
const page = await context.newPage()
page.on('pageerror', (e) => rec('真实', '页面JS错误', false, (e.stack || e.message).split('\n').slice(0, 4).join(' | ')))
page.on('dialog', (d) => d.accept())

async function idbAll(store) {
  return page.evaluate((name) => new Promise((res, rej) => {
    const r = indexedDB.open('jxl-product')
    r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains(name)) { db.close(); return res([]) }
      const q = db.transaction(name, 'readonly').objectStore(name).getAll(); q.onsuccess = () => { db.close(); res(q.result) }; q.onerror = () => { db.close(); rej(q.error) } }
    r.onerror = () => rej(r.error)
  }), store)
}
const docsOf = async (ws, kind) => (await idbAll('docs')).filter((d) => d.workspace_id === ws && (!kind || d.kind === kind))
const draftsOf = async (ws) => (await idbAll('assistant_drafts')).filter((d) => d.workspace_id === ws)
const activeDraft = async (ws) => (await draftsOf(ws)).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] ?? null
async function waitText(text, timeout = 20000) {
  try { await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout }) }
  catch (e) { console.log(`WAIT TIMEOUT「${text}」BODY:\n`, (await bodyText()).slice(0, 1800)); throw e }
}
const btn = (name) => page.getByRole('button', { name, exact: true })
const bodyText = () => page.evaluate(() => document.body.innerText)
async function openAssistant() {
  await page.goto(BASE + '#/assistant', { waitUntil: 'domcontentloaded' })
  await waitText('真实生成：资料 → 理解 → 任务建议', 15000)
}
async function pickDeadline(key, date) {
  await page.getByLabel(`任务 ${key} 截止`).click()
  await page.getByRole('button', { name: date, exact: true }).click()
}
// 采用前的合法用户确认：未排缺口/过载/额外工作。确认后 canAdopt 才转真（GAP_UNCONFIRMED 等属可确认阻断）。
async function confirmPreAdopt() {
  for (const label of ['确认仍有未排', '确认过载', '确认额外工作']) {
    while (await btn(label).count()) { await btn(label).first().click(); await page.waitForTimeout(150) }
  }
}
async function adopt() {
  await confirmPreAdopt()
  await btn('采用计划').click()
  await btn('采用').click()
  await waitText('采用成功', 30000)
}
// 生成终态以草案状态＋阶段机判定（「核对与确认」面板在 analyze 落便签后即渲染，不能当作建议就绪信号）。
const storeState = () => {
  const a = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assistant')
  return { phase: a?.gen?.phase, status: a?.active?.draft?.status, hasProposal: (a?.active?.draft?.proposal?.task_proposals ?? []).length > 0 }
}
async function waitGenOutcome(timeout = 180000) {
  const h = await page.waitForFunction(() => {
    const a = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assistant')
    const phase = a?.gen?.phase
    const status = a?.active?.draft?.status
    const hasProposal = (a?.active?.draft?.proposal?.task_proposals ?? []).length > 0
    if (phase === 'failed' || phase === 'save_failed') return 'failed'
    if (phase === 'clarification') return 'clarification'
    if (status === 'needs_review' && hasProposal) return 'proposal'
    return null
  }, null, { timeout, polling: 500 })
  return h.jsonValue()
}
const leaveClarification = () => page.waitForFunction(() => {
  const a = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assistant')
  return a?.gen?.phase !== 'clarification' && a?.active?.draft?.status !== 'needs_clarification'
}, null, { timeout: 20000 }).catch(() => {})

let exitCode = 0
try {
  rec('真实', 'model 后端 model_ready=true（密钥可装载，健康检查不触发付费）', modelReady, `model_ready=${modelReady}`)
  await openAssistant()
  // 真实上传虚构 PNG（走生产上传路径，真实 analyze 解码图片字节并调用视觉模型）。
  await page.getByLabel('上传截图').setInputFiles(PNG)
  await waitText('已选 1 /', 15000)
  await page.locator('input[aria-label^="选定资料"]').first().check()
  await page.locator('#assistant-requirement').fill(`请把这份课程通知拆解为 1 个核心学习任务与不超过 3 个关键行动，并给出每个行动的估时；保持精简，不要展开过多子任务。通知原文截止已逾期，我作为用户明确把截止日期设为 ${D(5)}。`)
  for (let i = 0; i < 7; i += 1) await page.getByLabel(`${D(i)} 预算分钟`).fill('60')
  await shot(page, 'real-01-input.png')

  // 真实生成：analyze（视觉）＋ propose（拆解）。真实模型可能多轮澄清，集中作答后继续（最多 6 轮）。
  await btn('生成方案').click()
  let reached = false
  for (let round = 0; round < 6 && !reached; round += 1) {
    const outcome = await waitGenOutcome(180000).catch(() => 'timeout')
    if (outcome === 'proposal') { reached = true; break }
    if (outcome === 'clarification') {
      await btn('继续生成').waitFor({ timeout: 15000 })
      await shot(page, `real-02-clarification-${round}.png`)
      // 文本作答：明确要求始终拆解任务（即使逾期按补救口径），避免选到「无需处理」类选项导致空建议。
      const inputs = page.locator('input[aria-label^="回答："]')
      await inputs.first().waitFor({ timeout: 15000 }).catch(() => {})
      const n = await inputs.count()
      const answer = `请拆解为 1 个核心学习任务与不超过 3 个关键行动并估时，保持精简。通知原文截止 2026-11-19 已逾期，我作为用户明确把截止日期重新设为 ${D(5)}，请按 ${D(5)} 安排，不要省略任务也不要展开过多子任务。`
      for (let i = 0; i < n; i += 1) await inputs.nth(i).fill(answer)
      await btn('继续生成').click()
      await leaveClarification()
    } else if (outcome === 'failed') {
      await shot(page, `real-02-failed-${round}.png`)
      await btn('重试生成').click()
      await leaveClarification()
    } else {
      throw new Error(`真实生成未在时限内到达建议/澄清/失败态：${outcome} ${JSON.stringify(await page.evaluate(storeState))}`)
    }
  }
  if (!reached) throw new Error('真实模型多轮后仍未生成可用建议')
  await shot(page, 'real-03-review.png')
  rec('真实', '真实模型图文调用：analyze≥1 且 propose≥1（非桩）',
    counts.analyze >= 1 && counts.propose >= 1, JSON.stringify(counts))

  const draft = await activeDraft('personal')
  const notes = await docsOf('personal', 'note')
  const noteFields = notes[0]?.fields ?? []
  const dlField = noteFields.find((f) => f.key === 'deadline')
  rec('真实', '真实视觉理解落便签：含字段与原文（非桩固定值）',
    notes.length >= 1 && noteFields.length > 0, JSON.stringify(noteFields.map((f) => ({ key: f.key, value: f.value, status: f.status }))))
  const candidates = (draft?.proposal?.task_proposals ?? []).flatMap((t) => (t.deadline_candidates ?? []).map((c) => ({ key: t.key, value: c.value, precision: c.precision, origin: c.origin })))
  console.log('真实模型截止候选:', JSON.stringify(candidates), '便签 deadline:', JSON.stringify(dlField))

  // 资料核对：确认便签 deadline 字段为事实（确认≠改值）。
  if (dlField && dlField.value != null) {
    const confirmBtn = page.locator('xpath=//span[text()="deadline"]/ancestor::li[1]//button[text()="确认为事实"]')
    if (await confirmBtn.count()) { await confirmBtn.first().click(); await waitText('已确认', 10000) }
  }
  await shot(page, 'real-04-note-confirmed.png')

  // 真实模型已产出被接收的建议（needs_review/editing 且含任务）——图文闭环到「生成」已验证。
  rec('真实', '真实模型建议被接收：草案含任务/工作项（非桩）',
    ['needs_review', 'editing', 'ready'].includes(draft?.status) && (draft?.proposal?.task_proposals ?? []).length >= 1,
    JSON.stringify({ status: draft?.status, tasks: (draft?.proposal?.task_proposals ?? []).map((t) => t.key), work: (draft?.proposal?.work_items ?? []).map((w) => w.key) }))

  // 采用：fixture 便签截止 2026-11-19 已逾期，note 出处路径会引入逾期缺口；此处用手动未来截止验证 manual 出处。
  // 真实模型自拟 key（非桩 t1），须从草案动态取 create 任务 key。
  // 探针修正（仅本副本）：真实模型可能输出 datetime 精度候选（如 2026-11-28T23:59:59），日期选择器会保留 23:59:59，
  // 若手动选同一日期则 desired===initial，setManualDeadline 被跳过、不产生 origin=user 候选 → 无法走 manual。
  // 故选 D(6)（与模型候选日期必然不同）强制触发真实手动改值；确认按钮名随候选精度（date 或 datetime），用 /^确认 20/ 匹配。
  const createTask = (draft?.proposal?.task_proposals ?? []).find((t) => t.op === 'create')
  const taskKey = createTask?.key
  let usedPath = 'none'
  if (taskKey) {
    await pickDeadline(taskKey, D(6))
    if (await btn('保存修改').count()) { await btn('保存修改').click(); await page.waitForTimeout(1000) }
    await btn('重新排程').click()
    await waitText('七天预览（按日竖排）', 30000)
    await page.waitForFunction(() => !document.body.innerText.includes('尚未排程'), null, { timeout: 15000 }).catch(() => {})
    const conf = page.getByRole('button', { name: /^确认 20\d\d-/ })
    while (await conf.count()) { await conf.first().click(); await page.waitForTimeout(200) }
    usedPath = 'manual'
  }
  await confirmPreAdopt()
  await shot(page, 'real-05-preview.png')
  const dbg = await page.evaluate(() => {
    const a = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assistant')
    return { status: a?.active?.draft?.status, readiness: a?.readiness, stale: a?.stale, canAdopt: a?.canAdopt }
  })
  if (dbg?.canAdopt) {
    await adopt()
    const tasks = await docsOf('personal', 'task')
    const actions = await docsOf('personal', 'action')
    const plans = await docsOf('personal', 'plan_item')
    const dAfter = await activeDraft('personal')
    rec('真实', '真实模型建议经核对采用：任务/行动/安排落库，草案 applied',
      tasks.length >= 1 && actions.length >= 1 && dAfter?.status === 'applied',
      JSON.stringify({ tasks: tasks.length, actions: actions.length, plans: plans.length, draft: dAfter?.status }))
    rec('真实', '截止出处如实记录（note=模型候选匹配已确认便签；manual=用户手动）',
      ['note', 'manual', 'none'].includes(tasks[0]?.deadline?.source),
      JSON.stringify({ path: usedPath, deadline: tasks[0]?.deadline }))
    await shot(page, 'real-06-adopted.png')
  } else {
    // 已跑过合法确认（未排/过载/额外工作）后仍不可采用：如实记录剩余阻断项，不强行点击禁用的「采用计划」。
    const blockers = dbg?.readiness?.blockers ?? []
    rec('真实', '真实模型建议采用（本轮受阻，如实记录阻断项）', false,
      JSON.stringify({ usedPath, status: dbg?.status, blockers: blockers.map((b) => `${b.code}:${b.message}`) }))
    await shot(page, 'real-06-blocked.png')
  }
  rec('隔离', '全程未触碰用户 8000/8020 后端', netHits.length === 0, JSON.stringify(netHits))
} catch (e) {
  exitCode = 1
  console.error('SCRIPT ERROR:', e.message)
  await shot(page, 'real-error.png').catch(() => {})
} finally {
  writeFileSync(join(RUN, 'results.json'), JSON.stringify(results, null, 2))
  writeFileSync(join(RUN, 'backend.log'), backendLog)
  writeFileSync(join(RUN, 'vite.log'), viteLog)
  writeFileSync(join(RUN, 'counts.json'), JSON.stringify({ counts, proposeRequests: proposeBodies.map((b) => b?.request_id), modelReady }, null, 2))
  writeFileSync(join(RUN, 'propose-bodies.json'), JSON.stringify(proposeBodies, null, 2))
  await browser.close()
  vite.kill(); backend.kill()
  const failed = results.filter((r) => !r.pass).length
  console.log(`合计 ${results.length} 项断言，失败 ${failed} 项。`)
  if (failed > 0) exitCode = 1
  process.exit(exitCode)
}