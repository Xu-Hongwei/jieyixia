// M1 浏览器验收 ①–⑩（2026-11-25，实施方案 §9.7）。
// 真实生产页面（#/assistant、#/today、任务页、工作页、#/data）+ 真实 IndexedDB + 真实 ZIP 下载/恢复。
// 隔离：自起 Vite（空闲端口 5177–5181，不杀未知服务）；每场景独立 Context（独立 IDB）；全部虚构演示数据。
// 拦截 :8000/:8020/analyze 并报告命中；不触碰用户 8000 后端进程。
// 运行：node E:/qoder/devlog/private-evidence/assistant-mvp/M1/browser/m1-acceptance.mjs
// 产出：同目录 run-2026-11-25/（results.json + screenshots/ + downloads/）；任一 FAIL → exit 1。
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, 'full-browser')
const SHOTS = join(RUN, 'screenshots'); const DL = join(RUN, 'downloads')
for (const d of [RUN, SHOTS, DL]) mkdirSync(d, { recursive: true })
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true })

// —— 北京日期（真实时钟）——
const bjToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
function bjAddDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const TODAY = bjToday()
const D = (i) => bjAddDays(TODAY, i)

// —— 端口探测 + 自起 Vite ——
function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer()
    s.once('error', () => res(false))
    s.once('listening', () => s.close(() => res(true)))
    s.listen(port, '127.0.0.1')
  })
}
let PORT = null
for (const p of [5177, 5178, 5179, 5180, 5181]) { if (await portFree(p)) { PORT = p; break } }
if (PORT == null) { console.error('无空闲端口（5177–5181 均占用），显式退出，不杀未知服务'); process.exit(2) }
const BASE = `http://127.0.0.1:${PORT}/`
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: 'E:/qoder/frontend', stdio: ['ignore', 'pipe', 'pipe'] })
let viteLog = ''
vite.stdout.on('data', (d) => { viteLog += d }); vite.stderr.on('data', (d) => { viteLog += d })
const deadline = Date.now() + 45000
for (;;) {
  try { const r = await fetch(BASE); if (r.ok) break } catch {}
  if (Date.now() > deadline) { console.error(viteLog); vite.kill(); throw new Error('vite 未就绪') }
  await new Promise((r) => setTimeout(r, 300))
}
console.log(`Vite 就绪：${BASE}（北京今天 ${TODAY}）`)
const browser = await chromium.launch({ executablePath: EXEC, headless: true })

const netHits = []
async function newScene(name, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
    acceptDownloads: true,
  })
  context.on('request', (r) => { const u = r.url(); if (/:8000|:8020|\/analyze/.test(u)) netHits.push(u) })
  await context.route(/:8000|:8020|\/analyze/, (route) => route.abort())
  const page = await context.newPage()
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, (e.stack || e.message).split('\n').slice(0, 4).join(' | ')))
  page.on('dialog', (d) => d.accept())
  return { context, page }
}

// —— 真实 IDB 读取（jxl-product）——
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
const opsOf = async (page, ws) => (await idbAll(page, 'assistant_ops')).filter((o) => o.workspace_id === ws)
const draftsOf = async (page, ws) => (await idbAll(page, 'assistant_drafts')).filter((d) => d.workspace_id === ws)
const wsOf = (page) => page.evaluate(() => localStorage.getItem('jxl-workspace'))

async function waitText(page, text, timeout = 20000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout })
  } catch (e) {
    console.log(`WAIT TIMEOUT「${text}」BODY:\n`, (await bodyText(page)).slice(0, 1500))
    throw e
  }
}
async function waitAnyText(page, texts, timeout = 20000) {
  await page.waitForFunction((ts) => ts.some((t) => document.body.innerText.includes(t)), texts, { timeout })
}
const btn = (page, name) => page.getByRole('button', { name, exact: true })
const bodyText = (page) => page.evaluate(() => document.body.innerText)

async function openAssistant(page) {
  if (!page.url().startsWith(BASE)) await page.goto(BASE + '#/assistant', { waitUntil: 'domcontentloaded' })
  // 进入恢复空间后 router.replace('/today') 可能仍在途并覆盖 hash：确认落定，被覆盖则重试一次。
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => { location.hash = '#/assistant' })
    try {
      await page.waitForFunction(() => location.hash === '#/assistant', null, { timeout: 3000 })
      break
    } catch { await page.waitForTimeout(800) }
  }
  try {
    await waitText(page, '本地规划初版 · 未接入智能理解', 5000)
  } catch {
    // hash 与路由内部状态失同步时整页加载兜底。
    await page.goto(BASE + '#/assistant', { waitUntil: 'domcontentloaded' })
    await waitText(page, '本地规划初版 · 未接入智能理解')
  }
}
async function loadDemo(page, kind = 'report') {
  await btn(page, kind === 'tight' ? '载入演示：容量紧张' : '载入演示：跨天周报').click()
  await waitText(page, '演示草案已载入')
  await waitText(page, '第 1 版')
}
async function setBudget(page, date, minutes) {
  await page.getByLabel(`${date} 预算分钟`).fill(String(minutes))
}
async function confirmDeadlineIfShown(page, deadline = D(2)) {
  const conf = btn(page, `确认 ${deadline}`)
  if (await conf.count()) { await conf.first().click(); await page.waitForTimeout(400) }
}
async function rescheduleAndConfirm(page, { deadline = D(2) } = {}) {
  await confirmDeadlineIfShown(page, deadline) // normalize 要求排程前先确认截止候选
  await btn(page, '重新排程').click()
  await waitAnyText(page, ['截止候选待确认', '就绪核对通过，可采用'])
  await confirmDeadlineIfShown(page, deadline) // 重排 bump 版本后须重新确认（新版本不继承旧授权）
  await waitText(page, '就绪核对通过，可采用')
}
async function waitComputed(page, ws) {
  for (let i = 0; i < 80; i++) {
    const d = (await draftsOf(page, ws))[0]
    if (d?.planning_result) return d
    await page.waitForTimeout(200)
  }
  throw new Error('排程计算超时')
}
async function openAdoptDialog(page) {
  await btn(page, '采用计划').click()
  await waitText(page, '确认采用计划')
}
function parseCounts(text) {
  const m = text.match(/将新增 (\d+) 个任务、(\d+) 个行动、(\d+) 条安排/)
  return m ? { tasks_created: +m[1], actions_created: +m[2], plan_items_created: +m[3] } : null
}
async function assertSingleCopy(page, item, ws, counts, title) {
  const tasks = (await docsOf(page, ws, 'task')).filter((t) => t.title === title)
  const ops = await opsOf(page, ws)
  const committed = ops.filter((o) => o.state === 'committed')
  const plans = await docsOf(page, ws, 'plan_item')
  const actions = await docsOf(page, ws, 'action')
  rec(item, '正式对象单份（任务/行动/安排/台账计数一致）',
    tasks.length === 1 && actions.length === counts.actions_created && plans.length === counts.plan_items_created && committed.length === 1,
    JSON.stringify({ tasks: tasks.length, actions: actions.length, plans: plans.length, committedOps: committed.length, expect: counts }))
  return { tasks, plans, actions, committed }
}

const TITLE = '演示：提交周报（M1验收）'
const ACTION_TEXT = '整理本周进展（已编辑）'

try {
  // ========== 场景 A：① 编辑跨天 → ② 预览/取消零写入 → ③ 采用回执+刷新不重复 → ⑧ 完成一条工作 → ⑨ ZIP 恢复 ==========
  {
    const { context, page } = await newScene('A')
    await openAssistant(page)
    rec('①', '入口无自动播种（无草案时显示开始面板）', (await bodyText(page)).includes('当前空间还没有草案'))
    await loadDemo(page)
    rec('①', '演示载入切到演示空间并明确标识', (await wsOf(page)) === 'demo' && (await bodyText(page)).includes('演示空间'))

    // 编辑：任务标题 + 行动文本 + day0 预算 30（跨天拆分），day1 预算 200
    await page.getByLabel('任务标题').fill(TITLE)
    await page.getByLabel('行动内容').first().fill(ACTION_TEXT)
    await setBudget(page, D(0), 30)
    await setBudget(page, D(1), 200)
    await btn(page, '保存修改').click()
    await waitText(page, '更改尚未重新排程')
    rec('①', '内容修改后标记未重排且采用禁用', await btn(page, '采用计划').isDisabled())
    await shot(page, '01-stale-after-edit.png')
    await rescheduleAndConfirm(page)
    const draftRec = (await draftsOf(page, 'demo'))[0]
    const segs = draftRec.planning_result.segments
    const dates = [...new Set(segs.map((s) => s.date))]
    rec('①', '重排后真实跨天（≥2 个日期）、预算 30 生效、编辑标题进入预览',
      dates.length >= 2 && segs.reduce((a, s) => a + s.minutes, 0) === 150
      && segs.filter((s) => s.date === D(0)).reduce((a, s) => a + s.minutes, 0) <= 30
      && (await bodyText(page)).includes(TITLE),
      JSON.stringify({ dates, day0: segs.filter((s) => s.date === D(0)).map((s) => s.minutes), total: segs.reduce((a, s) => a + s.minutes, 0) }))
    rec('①', '重排后就绪（截止已逐项确认）', draftRec.status === 'ready' || (await bodyText(page)).includes('就绪核对通过'))
    await shot(page, '02-ready-crossday.png')

    // ② 预览/取消零写入
    const docsBefore = (await idbAll(page, 'docs')).map((d) => d.id).sort()
    await openAdoptDialog(page)
    const dialogText = await bodyText(page)
    const counts = parseCounts(dialogText)
    rec('②', '采用确认面板展示真实写集计数', !!counts && counts.tasks_created === 1 && counts.actions_created === 2 && counts.plan_items_created === segs.length, JSON.stringify(counts))
    await shot(page, '03-adopt-dialog.png')
    await btn(page, '取消').click()
    await page.waitForFunction(() => !document.body.innerText.includes('确认采用计划'))
    const docsAfterCancel = (await idbAll(page, 'docs')).map((d) => d.id).sort()
    rec('②', '取消后零写入（docs 不变、无台账、草案仍就绪）',
      JSON.stringify(docsBefore) === JSON.stringify(docsAfterCancel) && (await opsOf(page, 'demo')).length === 0 && (await draftsOf(page, 'demo'))[0].status === 'ready')

    // ③ 采用：回执计数与内容一致
    await openAdoptDialog(page)
    await btn(page, '采用').click()
    await waitText(page, '采用成功，已写入正式任务/行动/安排')
    const { tasks, plans, committed } = await assertSingleCopy(page, '③', 'demo', counts, TITLE)
    const receipt = committed[0]?.receipt
    rec('③', '回执计数=面板计数=实际写入', !!receipt && receipt.counts.tasks_created === counts.tasks_created && receipt.counts.actions_created === counts.actions_created && receipt.counts.plan_items_created === counts.plan_items_created, JSON.stringify(receipt?.counts))
    rec('③', '任务标题/行动文本为编辑后内容；安排日期与预览一致',
      tasks[0]?.title === TITLE
      && (await docsOf(page, 'demo', 'action')).some((a) => a.text === ACTION_TEXT)
      && JSON.stringify(plans.map((p) => [p.date, p.planned_minutes]).sort()) === JSON.stringify(segs.map((s) => [s.date, s.minutes]).sort()),
      JSON.stringify({ title: tasks[0]?.title }))
    const thread = (await idbAll(page, 'assistant_threads')).find((t) => t.workspace_id === 'demo')
    rec('③', '线程留有采用结果消息', thread.messages.some((m) => m.type === 'adoption_result' && m.content.includes(`${counts.plan_items_created} 条安排`)))
    await shot(page, '04-adopted.png')
    const docsAfterAdopt = (await idbAll(page, 'docs')).map((d) => d.id).sort()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitText(page, '继续已有草案')
    await page.locator('li button', { hasText: '第' }).first().click()
    await waitText(page, '草案只读')
    rec('③', '刷新后重开=已采用只读，采用禁用，不重复写入',
      await btn(page, '采用计划').isDisabled()
      && JSON.stringify(docsAfterAdopt) === JSON.stringify((await idbAll(page, 'docs')).map((d) => d.id).sort())
      && (await opsOf(page, 'demo')).filter((o) => o.state === 'committed').length === 1)
    await shot(page, '05-applied-readonly.png')

    // ⑧ 从新安排开始并完成一条真实工作记录
    await btn(page, '查看日程').click()
    await waitText(page, '开始这项安排')
    await btn(page, '开始这项安排').click()
    await waitText(page, '将执行的行动')
    if ((await bodyText(page)).includes('尚未选择有效当前行动')) {
      await btn(page, '去任务选择行动').click()
      await waitText(page, '设为当前')
      await btn(page, '设为当前').first().click()
      await page.waitForFunction(() => !document.body.innerText.includes('尚未选择当前行动'))
      await btn(page, '开始这项安排').click()
      await waitText(page, '将执行的行动')
    }
    await shot(page, '06-start-plan-dialog.png')
    await btn(page, '确认并开始').click()
    await waitText(page, '结束本次')
    await shot(page, '07-work-running.png')
    await btn(page, '结束本次').click()
    await waitText(page, '行动完成')
    await page.locator('input[name="work-outcome"][value="done"]').check()
    await page.locator('input[name="plan-progress"][value="done"]').check()
    await shot(page, '08-end-form.png')
    await btn(page, '结束并保存').click()
    let ended = []
    for (let i = 0; i < 80; i++) {
      ended = (await docsOf(page, 'demo', 'focus_session')).filter((s) => s.ended_at != null)
      if (ended.length) break
      await page.waitForTimeout(200)
    }
    const planDone = (await docsOf(page, 'demo', 'plan_item')).filter((p) => p.state === 'done')
    rec('⑧', '从采用的新安排开始工作并结束一条真实记录（安排转 done）',
      ended.length === 1 && ended[0].outcome === 'done' && planDone.length >= 1,
      JSON.stringify({ ended: ended.length, outcome: ended[0]?.outcome, planDone: planDone.length }))
    await shot(page, '09-work-ended.png')

    // ⑨ 真实 ZIP 导出 → 恢复到新空间（v2 流程，DataPage 真实界面）
    const demoDocsBefore = (await docsOf(page, 'demo')).map((d) => d.id).sort()
    await page.evaluate(() => { location.hash = '#/data' })
    await waitText(page, '导出当前空间备份')
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      btn(page, '导出当前空间备份').click(),
    ])
    const zipPath = join(DL, 'm1-demo-backup.zip')
    await download.saveAs(zipPath)
    rec('⑨', '真实导出备份 ZIP 已落盘', download.suggestedFilename().endsWith('.zip'), download.suggestedFilename())
    await page.setInputFiles('input[type="file"]', zipPath)
    await waitText(page, '备份预览')
    await shot(page, '10-restore-preview.png')
    await page.locator('#restore-name').fill('M1恢复验证')
    await btn(page, '恢复到新空间').click()
    await waitText(page, '恢复完成', 30000)
    await shot(page, '11-restore-done.png')
    await btn(page, '进入恢复空间').click()
    await page.waitForFunction(() => localStorage.getItem('jxl-workspace') !== 'demo')
    await page.waitForFunction(() => location.hash === '#/today', null, { timeout: 10000 })
    await page.waitForTimeout(500)
    const restoreWs = await wsOf(page)
    await openAssistant(page)
    await waitText(page, '继续已有草案')
    await page.locator('li button', { hasText: '第' }).first().click()
    await waitText(page, '草案只读')
    const rPlans = await docsOf(page, restoreWs, 'plan_item')
    const rTasks = await docsOf(page, restoreWs, 'task')
    const rActions = await docsOf(page, restoreWs, 'action')
    const rOps = await opsOf(page, restoreWs)
    const rDrafts = await draftsOf(page, restoreWs)
    rec('⑨', '恢复空间：业务对象数量一致、草案已采用只读、ops 不导出（无重放）',
      rPlans.length === counts.plan_items_created && rTasks.filter((t) => t.title === TITLE).length === 1
      && rActions.length === counts.actions_created && rOps.length === 0
      && rDrafts[0]?.status === 'applied' && await btn(page, '采用计划').isDisabled(),
      JSON.stringify({ ws: restoreWs, plans: rPlans.length, tasks: rTasks.length, actions: rActions.length, ops: rOps.length, draft: rDrafts[0]?.status }))
    rec('⑨', '恢复后原演示空间完全不变', JSON.stringify(demoDocsBefore) === JSON.stringify((await docsOf(page, 'demo')).map((d) => d.id).sort()))
    await shot(page, '12-restored-applied.png')
    await context.close()
  }

  // ========== 场景 B：④ 双标签同时采用 → 单份 ==========
  {
    const { context, page } = await newScene('B')
    await openAssistant(page)
    await loadDemo(page)
    await setBudget(page, D(0), 30); await setBudget(page, D(1), 200)
    await page.getByLabel('行动内容').first().fill('整理本周进展（验收）')
    await btn(page, '保存修改').click(); await waitText(page, '更改尚未重新排程')
    await rescheduleAndConfirm(page)
    const page2 = await context.newPage()
    page2.on('pageerror', (e) => rec('④', '页面JS错误(tab2)', false, e.message))
    page2.on('dialog', (d) => d.accept())
    await openAssistant(page2)
    await page2.locator('li button', { hasText: '第' }).first().click()
    await waitText(page2, '就绪核对通过')
    await openAdoptDialog(page)
    await openAdoptDialog(page2)
    const counts = parseCounts(await bodyText(page))
    await Promise.all([btn(page, '采用').click(), btn(page2, '采用').click()])
    // 终态含竞态收敛路径：败方可能拿到基线 CONFLICT（记录已被其它页面修改）后刷新为已采用只读。
    const endTexts = ['采用成功，已写入', '该计划已成功采用', '确定未提交', '草案只读', '记录已被其它页面修改', '采用正在进行', '结果待核实']
    await waitAnyText(page, endTexts); await waitAnyText(page2, endTexts)
    await page.waitForTimeout(600)
    await assertSingleCopy(page, '④', 'demo', counts, '演示：提交周报')
    await shot(page, '13-doubletab-tab1.png'); await shot(page2, '14-doubletab-tab2.png')
    // 未提交/冲突的一方刷新后收敛为已采用只读
    for (const p of [page, page2]) {
      const t = await bodyText(p)
      if (t.includes('采用成功，已写入') || t.includes('该计划已成功采用')) continue
      if (t.includes('确定未提交') || t.includes('记录已被其它页面修改') || t.includes('采用正在进行') || t.includes('结果待核实')) {
        await p.reload({ waitUntil: 'domcontentloaded' })
        await waitText(p, '继续已有草案')
        await p.locator('li button', { hasText: '第' }).first().click()
        await waitText(p, '草案只读')
      }
      rec('④', '未提交方刷新后收敛为已采用只读', (await bodyText(p)).includes('草案只读') && await btn(p, '采用计划').isDisabled())
    }
    await context.close()
  }

  // ========== 场景 C：⑤ 中途故障整体回滚 + 同意图重试 ==========
  {
    const { context, page } = await newScene('C')
    await openAssistant(page)
    await loadDemo(page)
    await setBudget(page, D(0), 30); await setBudget(page, D(1), 200)
    await page.getByLabel('行动内容').first().fill('整理本周进展（验收）')
    await btn(page, '保存修改').click(); await waitText(page, '更改尚未重新排程')
    await rescheduleAndConfirm(page)
    const docsBefore = (await idbAll(page, 'docs')).map((d) => d.id).sort()
    await page.evaluate(() => {
      const orig = IDBObjectStore.prototype.add
      window.__restoreAdd = () => { IDBObjectStore.prototype.add = orig }
      IDBObjectStore.prototype.add = function (v, ...rest) {
        if (this.name === 'docs' && v && v.kind === 'action') throw new DOMException('注入故障：行动写入失败', 'ConstraintError')
        return orig.call(this, v, ...rest)
      }
    })
    await openAdoptDialog(page)
    const counts = parseCounts(await bodyText(page))
    await btn(page, '采用').click()
    await waitText(page, '确定未提交')
    const docsAfterFail = (await idbAll(page, 'docs')).map((d) => d.id).sort()
    const dFail = (await draftsOf(page, 'demo'))[0]
    const opsFail = await opsOf(page, 'demo')
    rec('⑤', '中途故障：零业务写入、草案待核对、pending 台账保留',
      JSON.stringify(docsBefore) === JSON.stringify(docsAfterFail) && dFail.status === 'needs_review'
      && opsFail.length === 1 && opsFail[0].state === 'pending',
      JSON.stringify({ draft: dFail.status, ops: opsFail.map((o) => o.state) }))
    await shot(page, '15-failure-rollback.png')
    await page.evaluate(() => window.__restoreAdd())
    // 内容与事实未变时重排是幂等的（不 bump、确认仍绑定当前版本）：直接回到就绪；
    // 若版本变化则需在新版本重新确认截止。两条路径都覆盖。
    await btn(page, '重新排程').click()
    await waitAnyText(page, ['就绪核对通过，可采用', '截止候选待确认'])
    if ((await bodyText(page)).includes('截止候选待确认')) {
      await btn(page, `确认 ${D(2)}`).first().click()
      await waitText(page, '就绪核对通过，可采用')
    }
    await openAdoptDialog(page)
    await btn(page, '采用').click()
    await waitText(page, '采用成功，已写入正式任务/行动/安排')
    await assertSingleCopy(page, '⑤', 'demo', counts, '演示：提交周报')
    rec('⑤', '重试后单份提交（无重复对象）', (await docsOf(page, 'demo', 'task')).length === 1)
    await shot(page, '16-retry-committed.png')
    await context.close()
  }

  // ========== 场景 D：⑥a 采用前新增占用 → 拒绝 ==========
  {
    const { context, page } = await newScene('D')
    await openAssistant(page)
    await loadDemo(page)
    await setBudget(page, D(0), 30); await setBudget(page, D(1), 200)
    await page.getByLabel('行动内容').first().fill('整理本周进展（验收）')
    await btn(page, '保存修改').click(); await waitText(page, '更改尚未重新排程')
    await rescheduleAndConfirm(page)
    const docsBefore = (await idbAll(page, 'docs')).map((d) => d.id).sort()
    await openAdoptDialog(page) // prepare 冻结信封
    await page.evaluate((today) => new Promise((res, rej) => {
      const r = indexedDB.open('jxl-product')
      r.onsuccess = () => {
        const db = r.result
        const tx = db.transaction('docs', 'readwrite')
        tx.objectStore('docs').put({
          kind: 'plan_item', id: 'p-drift-m1', workspace_id: 'demo', task_id: 't-drift-m1', date: today,
          planned_minutes: 30, action_text: '漂移占用（虚构）', state: 'planned', actual_minutes: null,
          focus_session_id: null, order: 99, task_ref_state: 'active',
        })
        tx.oncomplete = () => { db.close(); res() }
        tx.onerror = () => { db.close(); rej(tx.error) }
      }
      r.onerror = () => rej(r.error)
    }), TODAY)
    await btn(page, '采用').click()
    // 漂移在 prepare 阶段即被就绪推导阻断（READY_BLOCKED）：给出原因、零写入、采用禁用。
    await waitAnyText(page, ['需重新核对', '事实已变化', '就绪推导未通过'])
    const body = await bodyText(page)
    const dDrift = (await draftsOf(page, 'demo'))[0]
    const docsAfter = (await idbAll(page, 'docs')).map((d) => d.id).sort()
    rec('⑥', '采用前新增占用：拒绝并给出原因、零业务写入、采用禁用',
      dDrift.status !== 'applied' && JSON.stringify(docsBefore) === JSON.stringify(docsAfter.filter((id) => id !== 'p-drift-m1'))
      && (await docsOf(page, 'demo', 'task')).length === 0 && body.includes('p-drift-m1') && await btn(page, '采用计划').isDisabled(),
      JSON.stringify({ draft: dDrift.status, reasonShown: body.includes('p-drift-m1') }))
    await shot(page, '17-occupancy-drift.png')
    await context.close()
  }

  // ========== 场景 E：⑥b 采用前证据资料被删 → 拒绝 ==========
  {
    const { context, page } = await newScene('E')
    await openAssistant(page)
    await loadDemo(page)
    await setBudget(page, D(0), 30); await setBudget(page, D(1), 200)
    await page.getByLabel('行动内容').first().fill('整理本周进展（验收）')
    await btn(page, '保存修改').click(); await waitText(page, '更改尚未重新排程')
    await rescheduleAndConfirm(page)
    const docsBefore = (await idbAll(page, 'docs')).map((d) => d.id).sort()
    const srcId = (await draftsOf(page, 'demo'))[0].fact_baseline.source_fingerprints[0].source_id
    await openAdoptDialog(page)
    await page.evaluate((id) => new Promise((res, rej) => {
      const r = indexedDB.open('jxl-product')
      r.onsuccess = () => {
        const db = r.result
        const tx = db.transaction('sources', 'readwrite')
        tx.objectStore('sources').delete(id)
        tx.oncomplete = () => { db.close(); res() }
        tx.onerror = () => { db.close(); rej(tx.error) }
      }
      r.onerror = () => rej(r.error)
    }), srcId)
    await btn(page, '采用').click()
    await waitAnyText(page, ['需重新核对', '事实已变化', '就绪推导未通过'])
    const dDel = (await draftsOf(page, 'demo'))[0]
    rec('⑥', '采用前证据被删：拒绝并给出原因、零业务写入、采用禁用',
      dDel.status !== 'applied' && JSON.stringify(docsBefore) === JSON.stringify((await idbAll(page, 'docs')).map((d) => d.id).sort())
      && (await docsOf(page, 'demo', 'task')).length === 0 && await btn(page, '采用计划').isDisabled(),
      JSON.stringify({ draft: dDel.status, reasonShown: (await bodyText(page)).includes('事实已变化') }))
    await shot(page, '18-evidence-deleted.png')
    await context.close()
  }

  // ========== 场景 F：⑦ 采用中切换空间 → 不串写、回原空间收敛 ==========
  {
    const { context, page } = await newScene('F')
    await openAssistant(page)
    await loadDemo(page)
    await setBudget(page, D(0), 30); await setBudget(page, D(1), 200)
    await page.getByLabel('行动内容').first().fill('整理本周进展（验收）')
    await btn(page, '保存修改').click(); await waitText(page, '更改尚未重新排程')
    await rescheduleAndConfirm(page)
    await openAdoptDialog(page)
    const counts = parseCounts(await bodyText(page))
    await btn(page, '采用').click()
    await page.selectOption('select[aria-label="切换工作区"]', 'personal')
    await page.waitForFunction(() => localStorage.getItem('jxl-workspace') === 'personal')
    await page.waitForTimeout(1500)
    const personalDocs = await docsOf(page, 'personal')
    rec('⑦', '切换后个人空间零写入（不串写）', personalDocs.length === 0, JSON.stringify({ personalDocs: personalDocs.length }))
    await shot(page, '19-switched-personal-empty.png')
    await page.selectOption('select[aria-label="切换工作区"]', 'demo')
    await page.waitForFunction(() => localStorage.getItem('jxl-workspace') === 'demo')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitText(page, '继续已有草案')
    await page.locator('li button', { hasText: '第' }).first().click()
    await page.waitForTimeout(600)
    let body = await bodyText(page)
    if (body.includes('结果待核实')) {
      await btn(page, '核实结果').click()
      await page.waitForTimeout(800)
      body = await bodyText(page)
    }
    const dF = (await draftsOf(page, 'demo'))[0]
    if (dF.status === 'applied') {
      await assertSingleCopy(page, '⑦', 'demo', counts, '演示：提交周报')
      rec('⑦', '回原空间收敛为已采用（单份）', body.includes('草案只读'))
    } else {
      // 切换也可能落在任何写入之前：草案仍 ready、零写入，同样是合法收敛（不串写、不重复）。
      rec('⑦', '回原空间收敛：未提交且零写入',
        ['needs_review', 'ready'].includes(dF.status) && (await docsOf(page, 'demo', 'task')).length === 0, JSON.stringify({ draft: dF.status }))
    }
    await shot(page, '20-switch-converged.png')
    await context.close()
  }

  // ========== 场景 G：⑩ 移动端全流程 ==========
  {
    const { context, page } = await newScene('G', { mobile: true })
    await openAssistant(page)
    await loadDemo(page)
    const editVisible = await page.locator('h3', { hasText: '任务与行动' }).isVisible()
    const previewHidden = !(await page.locator('h3', { hasText: '七天预览' }).isVisible())
    rec('⑩', '移动端默认编辑区，预览区隐藏', editVisible && previewHidden)
    await setBudget(page, D(0), 40); await setBudget(page, D(1), 200)
    await page.getByLabel('行动内容').first().fill('整理本周进展（移动端）')
    await btn(page, '保存修改').click(); await waitText(page, '更改尚未重新排程')
    await btn(page, '预览').click()
    await btn(page, `确认 ${D(2)}`).first().click()
    await btn(page, '编辑').click()
    await btn(page, '重新排程').click()
    await waitComputed(page, 'demo')
    await btn(page, '预览').click()
    const previewVisible = await page.locator('h3', { hasText: '七天预览' }).isVisible()
    const editHidden = !(await page.locator('h3', { hasText: '任务与行动' }).isVisible())
    rec('⑩', '移动端切到预览：预览可见、编辑隐藏', previewVisible && editHidden)
    await btn(page, `确认 ${D(2)}`).first().click()
    await waitText(page, '就绪核对通过，可采用')
    await shot(page, '21-mobile-preview.png')
    await openAdoptDialog(page)
    const counts = parseCounts(await bodyText(page))
    await btn(page, '采用').click()
    await waitText(page, '采用成功，已写入正式任务/行动/安排')
    await assertSingleCopy(page, '⑩', 'demo', counts, '演示：提交周报')
    await shot(page, '22-mobile-adopted.png')
    await btn(page, '查看日程').first().click()
    await waitText(page, '开始这项安排')
    rec('⑩', '移动端采用后可直达日程安排', (await bodyText(page)).includes('开始这项安排'))
    await shot(page, '23-mobile-schedule.png')
    await context.close()
  }

  // ========== 场景 H：容量紧张演示 → 缺口逐项确认 → 采用保留未排 ==========
  {
    const { context, page } = await newScene('H')
    await openAssistant(page)
    await loadDemo(page, 'tight')
    await confirmDeadlineIfShown(page)
    await btn(page, '重新排程').click()
    const dH = await waitComputed(page, 'demo')
    await confirmDeadlineIfShown(page)
    for (let i = 0; i < 10; i++) {
      const gap = btn(page, '确认仍有未排')
      if (!(await gap.count())) break
      await gap.first().click(); await page.waitForTimeout(300)
    }
    await waitText(page, '就绪核对通过，可采用')
    const unscheduled = (await draftsOf(page, 'demo'))[0].planning_result.unscheduled ?? []
    rec('③', '容量紧张演示：确有未排工作且逐项确认后可就绪', unscheduled.length > 0, JSON.stringify(unscheduled.map((u) => [u.work_item_key, u.remaining_minutes, u.reason])))
    await shot(page, '24-tight-gap-confirmed.png')
    await openAdoptDialog(page)
    const body = await bodyText(page)
    rec('③', '采用面板明示未排工作已单独确认', body.includes('项未排工作（已单独确认）'))
    const counts = parseCounts(body)
    await btn(page, '采用').click()
    await waitText(page, '采用成功，已写入正式任务/行动/安排')
    const ops = (await opsOf(page, 'demo')).filter((o) => o.state === 'committed')
    rec('③', '回执保留未排清单（不自动裁剪）', ops.length === 1 && ops[0].receipt.unscheduled_kept.length === unscheduled.length, JSON.stringify({ kept: ops[0]?.receipt.unscheduled_kept.length, expect: unscheduled.length }))
    await shot(page, '25-tight-adopted.png')
    await context.close()
  }

  const analyzeHits = netHits.filter((u) => /\/analyze/.test(u))
  rec('网络', '全程未调用模型分析（analyze 命中=0；健康探测均被拦截 abort）', analyzeHits.length === 0, JSON.stringify({ totalBlocked: netHits.length, analyzeHits }))
} catch (err) {
  rec('运行', '脚本异常', false, err && err.stack || String(err))
} finally {
  await browser.close()
  vite.kill()
}

writeFileSync(join(RUN, 'results.json'), JSON.stringify({ date: TODAY, base: BASE, results, netHits }, null, 2))
const failed = results.filter((r) => r.pass === false)
console.log(`\n合计 ${results.length} 项断言：PASS ${results.filter((r) => r.pass).length} / FAIL ${failed.length}`)
process.exit(failed.length ? 1 : 0)