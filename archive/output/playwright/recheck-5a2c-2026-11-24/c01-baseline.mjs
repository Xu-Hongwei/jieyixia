// 5A-2C C01/C02：真实页面生成多天多段基准数据 + 正常基准 ZIP 导出。
// 全部主数据由真实 UI 创建（任务/行动/安排/开始/结束/取消/改期/另安排一天/资料上传）；
// 仅测试图片文件本身由脚本生成（1×1 虚构 PNG）；便签创建走真实「AI 整理」按钮，模型请求拦截为既有 fixture 01（披露）。两段真实等待各 40s，分段报告进度。
// 独立 Context + 真实 IndexedDB（personal 空间初始为空，不触碰用户真实数据）。
// 运行：node E:/qoder/devlog/private-evidence/stage5a-2c/c01-baseline.mjs（需自启 [::1]:5174 Vite）
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const ZIPDIR = join(OUT, 'zip')
mkdirSync(ZIPDIR, { recursive: true })
const BASE = 'http://[::1]:5184/'
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true })
const D = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)
const D1 = addDays(D, 1); const D2 = addDays(D, 2); const D4 = addDays(D, 4)
const now = () => new Date().toISOString()

// 1×1 透明 PNG（虚构测试图片，非任何真实截图）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const pngPath = join(OUT, 'fixture-test-image.png')
writeFileSync(pngPath, PNG)

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
// AI 路径拦截（开工单 §3.1）：healthz 报 model_ready，analyze 返回既有契约 fixture 01 的
// expected_analysis（仅重写 source_id 关联到真实落库资料）。不调用真实模型/用户后端。
const fixture01 = JSON.parse(readFileSync('E:/qoder/fixtures/01-course-assignment.json', 'utf8'))
let aiCalls = 0; let healthCalls = 0
await context.route('**/api/healthz', (route) => {
  healthCalls++
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', model_ready: true, version: '0.4.0' }) })
})
await context.route('**/api/analyze', (route) => {
  aiCalls++
  const payload = JSON.parse(route.request().postData() || '{}')
  const body = JSON.parse(JSON.stringify(fixture01.expected_analysis))
  body.source_id = payload.source_id
  for (const f of body.fields || []) if (f.quote) f.quote.source_id = payload.source_id
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
})
const page = await context.newPage()
await page.addInitScript(() => {
  window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p
})
page.on('pageerror', (e) => rec('C01', '页面JS错误', false, e.message))
await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)

const readDocs = () => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  return (await db.allDocs()).records
})
const readSources = () => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  const snap = await db.readWorkspaceSnapshot('personal')
  return snap.sources.map((s) => ({ id: s.id, kind: s.kind, name: s.name || null, bytes: s.blob ? s.blob.size : (s.text ? s.text.length : 0) }))
})
const docOf = async (id) => (await readDocs()).find((d) => d.id === id) || null
const dlg = page.locator('[role="dialog"]')
const adlg = page.locator('[role="alertdialog"]')
const hashOf = () => page.evaluate(() => location.hash)

async function pickDate(label, date) {
  await page.locator(`button[aria-label="${label}"]`).click()
  await page.waitForTimeout(250)
  await page.locator(`button[aria-label="${date}"]`).click()
  await page.waitForTimeout(250)
}
async function createPlan(title, text, date, minutes) {
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '安排工作', exact: true }).click()
  await page.waitForTimeout(300)
  await page.locator('[aria-label="搜索任务"]').fill(title)
  await page.getByRole('button', { name: `选择任务：${title}` }).click()
  await pickDate('安排日期', date)
  await page.locator('[aria-label="预计分钟"]').fill(String(minutes))
  await page.locator('[aria-label="工作说明"]').fill(text)
  await page.locator('button[type="submit"]', { hasText: '创建安排' }).click()
  await page.waitForSelector('button[type="submit"]', { state: 'detached', timeout: 8000 })
  const plans = (await readDocs()).filter((d) => d.kind === 'plan_item' && d.action_text === text)
  return plans[plans.length - 1]
}
async function startPlan(planId, date, { expectDateConfirm = false } = {}) {
  await page.goto(BASE + `#/today?date=${date}&plan=${planId}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '开始这项安排' }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '开始这项安排' }).click()
  await dlg.getByRole('button', { name: '确认并开始' }).waitFor({ timeout: 5000 })
  if (expectDateConfirm) {
    const boxes = await dlg.locator('input[type="checkbox"]').count()
    rec('C01', '提前执行需明确日期确认勾选', boxes >= 1, `checkboxes=${boxes}`)
  }
  const boxes = dlg.locator('input[type="checkbox"]')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  await dlg.getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
}
async function endWork({ outcome, progress, blocker = '', text, waitFor = '#/today' }) {
  await page.getByLabel('本次成果正文').fill(text)
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg.getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg.locator(`input[name="work-outcome"][value="${outcome}"]`).check()
  if (outcome === 'blocked') await dlg.getByLabel('阻塞说明').fill(blocker)
  if (progress) await dlg.locator(`input[name="plan-progress"][value="${progress}"]`).check()
  await dlg.getByRole('button', { name: '结束并保存' }).click()
  await page.waitForFunction((w) => location.hash.startsWith(w), waitFor, { timeout: 10000 })
  await page.waitForTimeout(600)
}
const realWait = async (ms, label) => {
  const half = Math.floor(ms / 2)
  await page.waitForTimeout(half)
  console.log(`  …${label} 已等待 ${half / 1000}s（分段进度）`)
  await page.waitForTimeout(ms - half)
  console.log(`  …${label} 等待完成 ${ms / 1000}s`)
}

// —— 1. 资料：文字仅保存 + 图片上传（真实 UI）；便签经真实「AI 整理」按钮创建（模型请求被拦截为 fixture 01） ——
await page.goto(BASE + '#/collect', { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: '添加文字资料' }).click()
await page.locator('[aria-label="文字资料"]').fill('虚构资料：报告素材清单——进展数据、风险列表、下一步计划。')
await page.getByRole('button', { name: '仅保存文字' }).click()
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'AI 整理' }).first().click()
await page.waitForFunction(() => location.hash.startsWith('#/notes/'), { timeout: 10000 })
await page.waitForTimeout(500)
await page.goto(BASE + '#/collect', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(500)
await page.locator('input[type="file"]').setInputFiles(pngPath)
await page.waitForTimeout(1000)
await page.getByRole('button', { name: 'AI 整理' }).first().click()
await page.waitForFunction(() => location.hash.startsWith('#/notes/'), { timeout: 10000 })
await page.waitForTimeout(500)
const sources = await readSources()
const docs0 = await readDocs()
const textSource = sources.find((s) => s.kind === 'text')
const textNote = docs0.find((d) => d.kind === 'note' && textSource && d.source_id === textSource.id)
const imgSource = sources.find((s) => s.kind === 'image')
const imgNote = imgSource ? docs0.find((d) => d.kind === 'note' && d.source_id === imgSource.id) : null
rec('C01', '文字资料与测试图片经真实 UI 落库（AI 拦截 fixture）', !!textNote && !!imgSource && imgSource.bytes === PNG.length && !!imgNote, JSON.stringify({ textNote: textNote && textNote.id, img: imgSource && imgSource.id, imgNote: imgNote && imgNote.id, aiCalls, healthCalls }))

// —— 2. 从便签手动截止建任务 T（D+4 日期精度，真实 note 关联） ——
await page.goto(BASE + `#/notes/${textNote.id}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(600)
await page.getByRole('button', { name: '更多操作' }).click()
await pickDate('手动截止', D4)
await page.getByRole('button', { name: '手动截止建任务' }).click()
await page.waitForTimeout(800)
const docs1 = await readDocs()
const T = docs1.find((d) => d.kind === 'task' && (d.note_ids || []).includes(textNote.id))
rec('C01', '便签建任务：真实关联 + D+4 日期精度截止', !!T && T.deadline && T.deadline.value === D4 && T.deadline.precision === 'date', JSON.stringify({ id: T && T.id, title: T && T.title, deadline: T && T.deadline }))

// —— 3. 行动 A1/A2 + 同名对照（按 ID 区分） ——
await page.goto(BASE + `#/tasks/${T.id}`, { waitUntil: 'domcontentloaded' })
for (const [text, min] of [['整理材料', 25], ['写初稿', 30], ['同名对照行动', 15], ['同名对照行动', 15]]) {
  await page.getByLabel('新行动内容').fill(text)
  await page.getByLabel('预计分钟').fill(String(min))
  await page.getByRole('button', { name: '添加行动' }).click()
  await page.waitForTimeout(400)
}
const acts = (await readDocs()).filter((d) => d.kind === 'action' && d.task_id === T.id)
const A1 = acts.find((a) => a.text === '整理材料')
const A2 = acts.find((a) => a.text === '写初稿')
const twins = acts.filter((a) => a.text === '同名对照行动')
await page.getByRole('button', { name: '设为当前' }).first().click()
await page.waitForTimeout(400)
const T2 = await docOf(T.id)
rec('C01', 'A1/A2+两条同名行动不同 ID；显式设为当前 A1', !!A1 && !!A2 && twins.length === 2 && twins[0].id !== twins[1].id && T2.current_action_id === A1.id, JSON.stringify({ A1: A1.id, A2: A2.id, current: T2.current_action_id }))

// —— 4. P1（D 整理材料）第一段：真实等待 40s → partial/partial ——
const P1 = await createPlan(T.title, 'D 整理材料', D, 30)
rec('C01', 'P1 页面创建 planned', !!P1 && P1.state === 'planned' && P1.date === D, P1 && P1.id)
await startPlan(P1.id, D)
await page.getByLabel('本次成果正文').fill('第一段成果：材料清单已梳理出三节提纲。')
await realWait(40000, 'P1 第一段真实计时')
await page.screenshot({ path: join(OUT, 'c01-work-segment1.png') })
await endWork({ outcome: 'partial', progress: 'partial', text: '第一段成果：材料清单已梳理出三节提纲。' })
const sess1 = (await readDocs()).filter((d) => d.kind === 'focus_session' && d.plan_item_id === P1.id)
const P1a = await docOf(P1.id)
rec('C01', '第一段真实计时落库 ≥39s，安排 partial', sess1.length === 1 && sess1[0].accumulated_ms >= 39000 && P1a.state === 'partial', JSON.stringify({ ms: sess1[0] && sess1[0].accumulated_ms, state: P1a.state }))

// —— 5. 另安排一天 → P2（D+1 写初稿，新 ID 空摘要） ——
await page.getByRole('button', { name: '另安排一天' }).first().click()
await page.waitForTimeout(400)
await pickDate('安排日期', D1)
await page.locator('[aria-label="工作说明"]').fill('D+1 写初稿')
await page.locator('[aria-label="预计分钟"]').fill('30')
await page.locator('button[type="submit"]', { hasText: '创建新安排' }).click()
await page.waitForSelector('button[type="submit"]', { state: 'detached', timeout: 8000 })
const P2 = (await readDocs()).filter((d) => d.kind === 'plan_item' && d.action_text === 'D+1 写初稿').pop()
const P1b = await docOf(P1.id)
rec('C01', '另安排一天：P2 新 ID/空摘要/D+1，原 P1 保持 partial', !!P2 && P2.id !== P1.id && P2.date === D1 && P2.state === 'planned' && P2.actual_minutes == null && P2.focus_session_id == null && P1b.state === 'partial', JSON.stringify({ P2: P2 && P2.id }))

// —— 6. P2 提前执行（明确确认）→ blocked+partial 卡点 ——
await startPlan(P2.id, D1, { expectDateConfirm: true })
await endWork({ outcome: 'blocked', progress: 'partial', blocker: '等待虚构数据源回复，暂无法继续初稿。', text: '初稿受阻：已列出缺口，等待数据源。' })
const sessP2 = (await readDocs()).filter((d) => d.kind === 'focus_session' && d.plan_item_id === P2.id)
const P2a = await docOf(P2.id)
rec('C01', 'P2 blocked+partial：卡点正文落库，安排 partial', sessP2.length === 1 && sessP2[0].outcome === 'blocked' && sessP2[0].blocker && sessP2[0].blocker.includes('虚构数据源') && P2a.state === 'partial', JSON.stringify({ outcome: sessP2[0] && sessP2[0].outcome, state: P2a.state }))

// —— 7. P1 第二段：真实等待 40s → 行动 partial × 安排 done（结果独立） ——
await startPlan(P1.id, D)
await page.getByLabel('本次成果正文').fill('第二段成果：材料整理完成，可进入初稿。')
await realWait(40000, 'P1 第二段真实计时')
await endWork({ outcome: 'partial', progress: 'done', text: '第二段成果：材料整理完成，可进入初稿。' })
const sessP1 = (await readDocs()).filter((d) => d.kind === 'focus_session' && d.plan_item_id === P1.id).sort((a, b) => (a.started_at < b.started_at ? -1 : 1))
const P1c = await docOf(P1.id)
const A1c = await docOf(A1.id)
const Tc = await docOf(T.id)
const sumMs = sessP1.reduce((s, x) => s + x.accumulated_ms, 0)
const expectMin = Math.floor(sumMs / 60000)
rec('C01', '第二段 ≥39s；两段独立求和 floor 一次 = 安排实际分钟', sessP1.length === 2 && sessP1[1].accumulated_ms >= 39000 && P1c.actual_minutes === expectMin && sumMs >= 78000, JSON.stringify({ ms1: sessP1[0].accumulated_ms, ms2: sessP1[1].accumulated_ms, sum: sumMs, actual: P1c.actual_minutes }))
rec('C02', '行动 partial × 安排 done 独立：安排 done、行动未完成、任务不自动 done', P1c.state === 'done' && A1c.done === false && Tc.status !== 'done', JSON.stringify({ plan: P1c.state, actionDone: A1c.done, task: Tc.status }))
rec('C01', '安排↔最近已结束会话双向关联', P1c.focus_session_id === sessP1[1].id && sessP1[1].plan_item_id === P1.id && sessP1[1].ended_at != null, JSON.stringify({ planSid: P1c.focus_session_id }))
await page.screenshot({ path: join(OUT, 'c01-today-multi.png') })

// —— 8. P3 未执行后续（D+2 planned 无引用） ——
const P3 = await createPlan(T.title, '后续工作未执行', D2, 20)
const sessP3 = (await readDocs()).filter((d) => d.kind === 'focus_session' && d.plan_item_id === P3.id)
rec('C01', 'P3 planned 且无任何会话引用', P3.state === 'planned' && sessP3.length === 0 && P3.focus_session_id == null, P3.id)

// —— 9. 正常取消/改期形成 cancelled/moved 历史 ——
const P4 = await createPlan(T.title, '将取消的安排', D, 15)
await page.evaluate(([id, d]) => { location.hash = `#/today?date=${d}&plan=${id}` }, [P4.id, D])
await page.waitForTimeout(500)
await page.getByRole('button', { name: '取消安排', exact: true }).click()
await adlg.getByRole('button', { name: '取消安排' }).click()
await page.waitForTimeout(600)
const P4a = await docOf(P4.id)
rec('C01', '正常取消 → cancelled 历史', P4a.state === 'cancelled', P4a.state)
const P5 = await createPlan(T.title, '将改期的安排', D, 15)
await page.evaluate(([id, d]) => { location.hash = `#/today?date=${d}&plan=${id}` }, [P5.id, D])
await page.waitForTimeout(500)
await page.getByRole('button', { name: '改期', exact: true }).click()
await page.waitForTimeout(400)
await pickDate('安排日期', D2)
await page.locator('button[type="submit"]', { hasText: '确认改期' }).click()
await page.waitForSelector('button[type="submit"]', { state: 'detached', timeout: 8000 })
const P5a = await docOf(P5.id)
// 实际语义（5A-1 已验收）：planned 改期为同 ID 原地换日；moved 是兼容终态，仅遗留数据出现（C18 覆盖）。
const P5dup = (await readDocs()).filter((d) => d.kind === 'plan_item' && d.action_text === '将改期的安排' && d.id !== P5.id)
rec('C01', '正常改期 → 同 ID 原地换日 D+2，仍 planned，无重复新安排', P5a.state === 'planned' && P5a.date === D2 && P5a.focus_session_id == null && P5dup.length === 0, JSON.stringify({ id: P5a.id, date: P5a.date, state: P5a.state }))

// —— 10. 无截止任务 U + 独立工作（无 plan 关联，旧流程不受计划联动污染） ——
await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: '新建', exact: true }).click()
await page.locator('[aria-label="新任务名称"]').fill('虚构任务·无截止独立')
await page.getByRole('button', { name: '新建任务' }).click()
await page.waitForTimeout(600)
const U = (await readDocs()).filter((d) => d.kind === 'task' && d.title === '虚构任务·无截止独立').pop()
await page.goto(BASE + `#/tasks/${U.id}`, { waitUntil: 'domcontentloaded' })
await page.getByLabel('新行动内容').fill('独立行动')
await page.getByLabel('预计分钟').fill('10')
await page.getByRole('button', { name: '添加行动' }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '设为当前' }).first().click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: '开始执行' }).click()
await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
await endWork({ outcome: 'done', progress: null, text: '独立工作成果：完成。', waitFor: `#/tasks/${U.id}` })
const sessU = (await readDocs()).filter((d) => d.kind === 'focus_session' && d.task_id === U.id)
const Ua = await docOf(U.id)
const actU = (await readDocs()).find((d) => d.kind === 'action' && d.task_id === U.id)
rec('C01', '无截止独立会话：plan_item_id=null，行动完成，任务不自动 done', sessU.length === 1 && sessU[0].plan_item_id == null && actU.done === true && Ua.status !== 'done' && (Ua.deadline == null || Ua.deadline.value == null), JSON.stringify({ sid: sessU[0] && sessU[0].id }))

// —— 11. 精确时分秒截止对照任务 DT ——
await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: '新建', exact: true }).click()
await page.locator('[aria-label="新任务名称"]').fill('虚构任务·精确截止')
await page.locator('button[aria-label="截止（可选）"], button:has-text("截止（可选）")').first().click()
await page.waitForTimeout(250)
await page.locator(`button[aria-label="${D4}"]`).click()
await page.locator('input[type="time"]').fill('17:30')
await page.waitForTimeout(250)
await page.keyboard.press('Escape')
await page.getByRole('button', { name: '新建任务' }).click()
await page.waitForTimeout(600)
const DT = (await readDocs()).filter((d) => d.kind === 'task' && d.title === '虚构任务·精确截止').pop()
// 契约口径：naive datetime 合法且 value 原文不改写，按北京墙上时间解释（time.js 头注）。
const dtInterp = await page.evaluate(async (v) => {
  const t = await import(window.__mod('/src/domains/time.js'))
  return t.interpretInstant(v)
}, DT && DT.deadline ? DT.deadline.value : '')
const dtExpect = Date.parse(`${D4}T17:30:00+08:00`)
rec('C01', '精确截止任务：datetime 精度，17:30 按北京解释为正确绝对时刻', !!DT && DT.deadline && DT.deadline.precision === 'datetime' && DT.deadline.value === `${D4}T17:30` && dtInterp === dtExpect, JSON.stringify({ deadline: DT && DT.deadline, interp: dtInterp, expect: dtExpect }))

// —— 12. 导出正常基准 ZIP（真实下载）+ 对象清单 ——
await page.goto(BASE + '#/data', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(600)
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.getByRole('button', { name: '导出当前空间备份' }).click(),
])
const zipPath = join(ZIPDIR, 'baseline-normal.zip')
await download.saveAs(zipPath)
const zipBytes = readFileSync(zipPath)
const sha = createHash('sha256').update(zipBytes).digest('hex')
rec('C01', '基准 ZIP 真实下载成功（字节+SHA-256 留档）', zipBytes.length > 0, JSON.stringify({ file: 'zip/baseline-normal.zip', bytes: zipBytes.length, sha256: sha }))
await page.screenshot({ path: join(OUT, 'c01-data-export.png') })

const finalDocs = await readDocs()
const finalSources = await readSources()
const inventory = {
  at: now(), baseDate: D, D1, D2, D4,
  zip: { file: 'zip/baseline-normal.zip', bytes: zipBytes.length, sha256: sha },
  keyIds: { T: T.id, A1: A1.id, A2: A2.id, twins: twins.map((a) => a.id), P1: P1.id, P2: P2.id, P3: P3.id, P4: P4.id, P5: P5.id, U: U.id, DT: DT && DT.id, textNote: textNote.id, textSource: textNote.source_id, imgSource: imgSource && imgSource.id, imgNote: imgNote && imgNote.id },
  moveSemantics: 'planned 改期为同 ID 原地换日（5A-1 已验收）；moved 终态仅遗留数据出现，由 C18 兼容样本覆盖',
  sessions: finalDocs.filter((d) => d.kind === 'focus_session').map((s) => ({ id: s.id, task_id: s.task_id, action_id: s.action_id, plan_item_id: s.plan_item_id, accumulated_ms: s.accumulated_ms, outcome: s.outcome, ended: s.ended_at != null })),
  counts: finalDocs.reduce((m, d) => { m[d.kind] = (m[d.kind] || 0) + 1; return m }, {}),
  sources: finalSources,
  aiInterception: { fixture: 'fixtures/01-course-assignment.json expected_analysis', analyzeCalls: aiCalls, healthzCalls: healthCalls, note: '模型请求全部拦截，未调用真实模型或用户后端' },
}
writeFileSync(join(OUT, 'c01-inventory.json'), JSON.stringify(inventory, null, 2))
writeFileSync(join(OUT, 'c01-docs-snapshot.json'), JSON.stringify(finalDocs, null, 2))
rec('C01', '对象 ID 清单与完整快照留档（虚构数据）', true, `docs=${finalDocs.length} sources=${finalSources.length}`)

await context.close()
await browser.close()
writeFileSync(join(OUT, 'c01-results.json'), JSON.stringify({ at: now(), baseDate: D, results }, null, 2))
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
console.log(`c01 exit=${failed.length ? 1 : 0}`)
process.exit(failed.length ? 1 : 0)