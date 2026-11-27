// 5A-2B #226 验收矩阵（二）：冲突/失败/导航/手机/离线 B04/B06/B12/B13/B14/B15/B19/B20。
// 真实页面点击 + 真实 IndexedDB；独立 Context + 虚构种子。
// 故障注入沿用 2A 手法（IDBObjectStore.prototype.put/getAll 覆写，finally 恢复）：
//   B12a 明确事务中止（put 抛错→SAVE_FAILED→原信封重试）；
//   B12b 已提交但前端未收到结果（readonly getAll 一次性抛错→待核实→核实结果）。
// 并发变更来源标注：B04 双页=第二页面 UI 同时点击；B06/B13/B14 的事实变化=测试辅助 putDoc/事务原语。
// B19 Esc-忙碌用 put 同步阻塞+抛错制造真实 busy 窗口。B20 为已加载应用断网冒烟。
// 运行：node E:/qoder/devlog/private-evidence/stage5a-2b/ui-acceptance-b2.mjs
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
mkdirSync(OUT, { recursive: true })
const BASE = 'http://[::1]:5184/'
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true })
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)
const tomorrow = addDays(today, 1)
const now = () => new Date().toISOString()

const taskDoc = (suffix, extra = {}) => ({
  id: `t-${suffix}`, kind: 'task', workspace_id: 'personal', title: `虚构任务·${suffix}`, status: 'todo',
  current_action_id: `a-${suffix}`, matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' },
  created_at: now(), updated_at: now(), is_demo: false, ...extra,
})
const actionDoc = (suffix, extra = {}) => ({
  id: `a-${suffix}`, kind: 'action', workspace_id: 'personal', task_id: `t-${suffix}`, text: `虚构行动·${suffix}`,
  minutes: 25, basis: 'user', done: false, created_at: now(), ...extra,
})
const planDoc = (suffix, extra = {}) => ({
  id: `p-${suffix}`, kind: 'plan_item', workspace_id: 'personal', task_id: `t-${suffix}`, date: today, state: 'planned',
  action_text: `虚构安排·${suffix}`, planned_minutes: 30, actual_minutes: null, focus_session_id: null,
  order: 1, task_ref_state: 'active', created_at: now(), updated_at: now(), ...extra,
})
const endedSession = (suffix, id, extra = {}) => ({
  id, kind: 'focus_session', workspace_id: 'personal', task_id: `t-${suffix}`, action_id: `a-${suffix}`,
  plan_item_id: `p-${suffix}`, record_version: 1, started_at: now(), ended_at: now(), accumulated_ms: 60000,
  running: false, outcome: 'partial', blocker: null, draft_md: `历史正文·${id}`,
  task_snapshot: { title: `虚构任务·${suffix}`, deadline_value: null, deadline_precision: 'none', matter_name: null },
  action_snapshot: { text: `虚构行动·${suffix}`, minutes: 25 },
  task_ref_state: 'active', action_ref_state: 'active', created_at: now(), ...extra,
})

async function scene(name, docs, { viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p
  })
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, e.message))
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.evaluate(async (seedDocs) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    db.configureWorkspace('personal')
    for (const d of seedDocs) await db.putDoc(d)
    const { useAppStore } = await import(window.__mod('/src/stores/app.js'))
    await useAppStore().reload()
    const { useFocusStore } = await import(window.__mod('/src/stores/focus.js'))
    await useFocusStore().loadWorkspace()
  }, docs)
  return { context, page }
}
const docOf = (page, id) => page.evaluate(async (id) => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  return (await db.allDocs()).records.find((d) => d.id === id) || null
}, id)
const sessionsOf = (page) => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  return (await db.allDocs()).records.filter((d) => d.kind === 'focus_session')
})
const opsEntries = (page) => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  const r = (await db.allFocusRuntime()).records.find((x) => x.id === 'ops:personal')
  return r ? r.entries.map((e) => ({ op: e.op, request_id: e.request_id, session_id: e.session_id })) : []
})
const mutateDoc = (page, id, patch) => page.evaluate(async ({ id, patch }) => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  const d = (await db.allDocs()).records.find((x) => x.id === id)
  await db.putDoc({ ...d, ...patch })
  const { useAppStore } = await import(window.__mod('/src/stores/app.js'))
  await useAppStore().reload()
}, { id, patch })
const dlg = (page) => page.locator('[role="dialog"]')
const hashOf = (page) => page.evaluate(() => location.hash)
const bodyText = (page) => page.locator('body').innerText()

async function openStartDialog(page, planId) {
  await page.goto(BASE + `#/today?plan=${planId}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '开始这项安排' }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '开始这项安排' }).click()
  await dlg(page).getByRole('button', { name: '确认并开始' }).waitFor({ timeout: 5000 })
}
async function startViaUi(page, planId) {
  await openStartDialog(page, planId)
  const boxes = dlg(page).locator('input[type="checkbox"]')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
}
// 填正文并等待自动保存落库（区分「已保存正文」与「本次最终结束写集」）。
async function fillAndSettle(page, text) {
  await page.getByLabel('本次成果正文').fill(text)
  const sid = decodeURIComponent(await hashOf(page)).match(/#\/work\/([^?]+)/)[1]
  await page.waitForFunction(async ({ sid, text }) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    const s = (await db.allDocs()).records.find((d) => d.id === sid)
    return s && s.draft_md === text
  }, { sid, text }, { timeout: 10000, polling: 300 })
}
async function openEndForm(page) {
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
}
async function saveEnd(page) {
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
}
// 注入：结束事务写目标安排时抛错 → 整体中止（明确未提交）。
const armPutThrow = (page, planId) => page.evaluate((planId) => {
  const proto = IDBObjectStore.prototype
  window.__origPut = proto.put
  proto.put = function (value, ...rest) {
    if (value && value.kind === 'plan_item' && value.id === planId) throw new Error('注入：安排写入失败（事务中止）')
    return window.__origPut.call(this, value, ...rest)
  }
}, planId)
const disarmPut = (page) => page.evaluate(() => {
  if (window.__origPut) IDBObjectStore.prototype.put = window.__origPut
  window.__origPut = null
})
// 注入：提交后首次 readonly docs getAll 抛错（事务本身 readwrite 不受影响）→ 已提交但结果未知。
const armGetAllThrow = (page) => page.evaluate(() => {
  const proto = IDBObjectStore.prototype
  window.__origGetAll = proto.getAll
  window.__armed = true
  proto.getAll = function (...args) {
    if (window.__armed && this.name === 'docs' && this.transaction.mode === 'readonly') {
      window.__armed = false
      throw new Error('注入：提交后读取失败（结果未知）')
    }
    return window.__origGetAll.apply(this, args)
  }
})
const disarmGetAll = (page) => page.evaluate(() => {
  if (window.__origGetAll) IDBObjectStore.prototype.getAll = window.__origGetAll
  window.__origGetAll = null
  window.__armed = false
})

// —— B04 双页同时开始：零重复创建；PLAN_SESSION_EXISTS 回到同一真实会话 ——
{
  const { context, page } = await scene('B04', [taskDoc('b04a'), actionDoc('b04a'), planDoc('b04a')])
  const page2 = await context.newPage()
  await page2.addInitScript(() => {
    window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p
  })
  page2.on('pageerror', (e) => rec('B04', '第二页面JS错误', false, e.message))
  await page2.goto(BASE + '#/today?plan=p-b04a', { waitUntil: 'domcontentloaded' })
  await page2.waitForTimeout(1000)
  await openStartDialog(page, 'p-b04a')
  await page2.getByRole('button', { name: '开始这项安排' }).click()
  await dlg(page2).getByRole('button', { name: '确认并开始' }).waitFor({ timeout: 5000 })
  // 第二页面 UI 与第一页面同时点击（真实双页并发，非测试辅助调用）。
  await Promise.all([
    dlg(page).getByRole('button', { name: '确认并开始' }).click(),
    dlg(page2).getByRole('button', { name: '确认并开始' }).click(),
  ])
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await page2.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const ss = await sessionsOf(page)
  const h1 = decodeURIComponent(await hashOf(page))
  const h2 = decodeURIComponent(await hashOf(page2))
  const sid1 = h1.match(/#\/work\/([^?]+)/)[1]
  const sid2 = h2.match(/#\/work\/([^?]+)/)[1]
  rec('B04', '双页同时开始：只创建一个会话，两页导航同一 sid', ss.length === 1 && sid1 === sid2, JSON.stringify({ count: ss.length, sid1, sid2 }))
  await context.close()
}
// —— B04 跨空间运行：只解释+显式切换；取消不改变任何会话 ——
{
  const { context, page } = await scene('B04', [taskDoc('b04c'), actionDoc('b04c'), planDoc('b04c')])
  // 测试辅助种子：在 demo 空间构造一段运行中会话与其 run 位置（各自空间事务维护）。
  await page.evaluate(async () => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    db.configureWorkspace('demo')
    const ts = new Date().toISOString()
    await db.putDoc({ id: 't-demo-x', kind: 'task', workspace_id: 'demo', title: '虚构演示任务', status: 'doing', current_action_id: 'a-demo-x', matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' }, created_at: ts, updated_at: ts, is_demo: true })
    await db.putDoc({ id: 'a-demo-x', kind: 'action', workspace_id: 'demo', task_id: 't-demo-x', text: '虚构演示行动', minutes: 20, basis: 'user', done: false, created_at: ts })
    await db.putDoc({ id: 's-demo-x', kind: 'focus_session', workspace_id: 'demo', task_id: 't-demo-x', action_id: 'a-demo-x', plan_item_id: null, record_version: 1, started_at: ts, ended_at: null, accumulated_ms: 5000, running: true, timer_anchor_at: ts, outcome: null, blocker: null, draft_md: '', task_snapshot: { title: '虚构演示任务', deadline_value: null, deadline_precision: 'none', matter_name: null }, action_snapshot: { text: '虚构演示行动', minutes: 20 }, task_ref_state: 'active', action_ref_state: 'active', created_at: ts })
    await db.transformFocusAtomic(() => ({ runtimePuts: [{ id: 'run:demo', kind: 'running', workspace_id: 'demo', session_id: 's-demo-x', updated_at: Date.now() }] }))
    db.configureWorkspace('personal')
    const { useAppStore } = await import(window.__mod('/src/stores/app.js'))
    await useAppStore().reload()
    const { useFocusStore } = await import(window.__mod('/src/stores/focus.js'))
    await useFocusStore().loadWorkspace()
  })
  await page.goto(BASE + '#/today?plan=p-b04c', { waitUntil: 'domcontentloaded' })
  await page.getByText('有一段正在运行的工作').waitFor({ timeout: 8000 })
  const t = await bodyText(page)
  rec('B04', '跨空间运行：冲突说明+不替它暂停结束+取消不改变会话', t.includes('这里不会替它暂停或结束') && t.includes('取消不改变任何会话') && (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0, '')
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const demoS = await page.evaluate(async () => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    db.configureWorkspace('demo')
    const s = (await db.allDocs()).records.find((d) => d.id === 's-demo-x') || null
    db.configureWorkspace('personal')
    return s
  })
  rec('B04', '离开（取消）后 demo 会话原样未动', !!demoS && demoS.ended_at == null && demoS.running === true, '')
  await page.goto(BASE + '#/today?plan=p-b04c', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '前往演示空间查看' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/s-demo-x'), { timeout: 10000 })
  const ws = await page.evaluate(async () => {
    const { useAppStore } = await import(window.__mod('/src/stores/app.js'))
    return useAppStore().workspaceId
  })
  rec('B04', '显式切换空间后进入该工作页', ws === 'demo', ws)
  await context.close()
}

// —— B06 确认期间多字段变化+再次变化：完整差异，显示与提交同版，零隐式改绑 ——
{
  const { context, page } = await scene('B06', [taskDoc('b06'), actionDoc('b06'), planDoc('b06')])
  await openStartDialog(page, 'p-b06')
  // 测试辅助：确认期间同时改安排说明/预计分钟与行动估时。
  await mutateDoc(page, 'p-b06', { action_text: '改后的安排说明', planned_minutes: 45 })
  await mutateDoc(page, 'a-b06', { minutes: 40 })
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await dlg(page).getByText('确认期间事实已变化，请核对全部差异').waitFor({ timeout: 8000 })
  let dt = await dlg(page).innerText()
  rec('B06', '第一次变化：列全安排与事实差异（说明/预计/行动估时）', dt.includes('工作说明') && dt.includes('预计分钟') && dt.includes('改后的安排说明') && dt.includes('45') && dt.includes('40'), dt.slice(0, 300))
  rec('B06', '差异期间未创建会话', (await sessionsOf(page)).length === 0, '')
  await dlg(page).getByRole('button', { name: '已核对，重新确认' }).click()
  // 测试辅助：重新确认后再次变化 → 仍须再次核对，不追 live 静默提交。
  await mutateDoc(page, 'p-b06', { planned_minutes: 60 })
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await dlg(page).getByText('确认期间事实已变化，请核对全部差异').waitFor({ timeout: 8000 })
  dt = await dlg(page).innerText()
  rec('B06', '第二次变化：再次列差异（60 分钟）', dt.includes('60'), dt.slice(0, 200))
  await dlg(page).getByRole('button', { name: '已核对，重新确认' }).click()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const s = (await sessionsOf(page))[0]
  rec('B06', '确认后开始：行动 ID 不变（零隐式改绑）', s.action_id === 'a-b06', s.action_id)
  await context.close()
}

// —— B12a 明确事务中止：SAVE_FAILED 保留输入 → 原信封重试成功，无重复累计 ——
{
  const { context, page } = await scene('B12', [taskDoc('b12a'), actionDoc('b12a'), planDoc('b12a')])
  await startViaUi(page, 'p-b12a')
  await fillAndSettle(page, 'B12a 最终正文')
  const sid = (await sessionsOf(page))[0].id
  await armPutThrow(page, 'p-b12a')
  await openEndForm(page)
  await saveEnd(page)
  await dlg(page).getByRole('button', { name: '核实结果' }).waitFor({ timeout: 10000 })
  let s = await docOf(page, sid)
  const dt = await dlg(page).innerText()
  rec('B12', 'a 明确中止：SAVE_FAILED 待核实，会话未结束、安排未写', s.ended_at == null && (await docOf(page, 'p-b12a')).state === 'planned' && dt.includes('核实'), '')
  rec('B12', 'a 中止后正文保留（表单输入锁定不丢）', (await page.getByLabel('本次成果正文').inputValue()) === 'B12a 最终正文', '')
  await page.screenshot({ path: join(OUT, 'b12-save-failed.png') })
  await disarmPut(page)
  await dlg(page).getByRole('button', { name: '原信封重试' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  s = await docOf(page, sid)
  const p = await docOf(page, 'p-b12a')
  const ss = await sessionsOf(page)
  rec('B12', 'a 原信封重试：同一 sid 结束成功，仅一段、累计只算一次', s.ended_at != null && s.draft_md === 'B12a 最终正文' && ss.length === 1 && p.focus_session_id === sid && p.actual_minutes === 0, JSON.stringify({ count: ss.length, actual: p.actual_minutes }))
  await context.close()
}
// —— B12b 已提交但前端未收到完整结果：待核实 → 核实结果 → 成功，无重复累计 ——
{
  const { context, page } = await scene('B12', [taskDoc('b12b'), actionDoc('b12b'), planDoc('b12b')])
  await startViaUi(page, 'p-b12b')
  await fillAndSettle(page, 'B12b 最终正文')
  const sid = (await sessionsOf(page))[0].id
  await openEndForm(page)
  await armGetAllThrow(page)
  await saveEnd(page)
  await dlg(page).getByRole('button', { name: '核实结果' }).waitFor({ timeout: 10000 })
  // 注入只触发一次即自动解除；此时事务其实已提交。
  const sMid = await docOf(page, sid)
  const dt = await dlg(page).innerText()
  rec('B12', 'b 提交后读取失败：进入待核实而非谎称失败/成功', dt.includes('保存结果未知') && sMid.ended_at != null, JSON.stringify({ endedInDb: sMid.ended_at != null }))
  await page.screenshot({ path: join(OUT, 'b12-verify-pending.png') })
  await dlg(page).getByRole('button', { name: '核实结果' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  const s = await docOf(page, sid)
  const p = await docOf(page, 'p-b12b')
  const ss = await sessionsOf(page)
  rec('B12', 'b 核实读到已结束记录→正常返回；仅一段、累计只算一次', s.ended_at != null && ss.length === 1 && p.focus_session_id === sid && p.actual_minutes === 0 && (await bodyText(page)).includes('这次记录已保存'), JSON.stringify({ count: ss.length, actual: p.actual_minutes }))
  await disarmGetAll(page)
  await context.close()
}

// —— B13 结果未知后修订号改变：原信封重试被拒（不偷换输入）；处理冲突后新意图成功 ——
{
  const { context, page } = await scene('B13', [taskDoc('b13'), actionDoc('b13'), planDoc('b13')])
  await startViaUi(page, 'p-b13')
  await fillAndSettle(page, 'B13 原正文')
  const sid = (await sessionsOf(page))[0].id
  await armPutThrow(page, 'p-b13')
  await openEndForm(page)
  await saveEnd(page)
  await dlg(page).getByRole('button', { name: '原信封重试' }).waitFor({ timeout: 10000 })
  // 测试辅助：待核实期间其它入口改写了正文并推进修订（docs + runtime 同事务原语）。
  await page.evaluate(async (sid) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    const s = (await db.allDocs()).records.find((d) => d.id === sid)
    await db.putDoc({ ...s, draft_md: '外部修改正文' })
    await db.transformFocusAtomic((latest, runtime) => {
      const rt = runtime.find((r) => r.id === 'sess:' + sid)
      return { runtimePuts: [{ ...rt, revision: rt.revision + 1, updated_at: Date.now() }] }
    })
  }, sid)
  await disarmPut(page)
  await dlg(page).getByRole('button', { name: '原信封重试' }).click()
  await page.waitForTimeout(1200)
  const s1 = await docOf(page, sid)
  const bt = await bodyText(page)
  rec('B13', '修订已变：原信封重试被拒，转正文核对，不静默结束', s1.ended_at == null && bt.includes('正文需要核对'), '')
  await page.screenshot({ path: join(OUT, 'b13-revision-conflict.png') })
  await page.getByRole('button', { name: '采用已保存版本' }).click()
  await page.waitForTimeout(600)
  await openEndForm(page)
  await saveEnd(page)
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  const s2 = await docOf(page, sid)
  const entries = await opsEntries(page)
  const endEntries = entries.filter((e) => e.op === 'end')
  rec('B13', '核对后作为新意图提交成功；台账仅一次 end（首次中止未入账）', s2.ended_at != null && s2.draft_md === '外部修改正文' && endEntries.length === 1, JSON.stringify({ endCount: endEntries.length, md: s2.draft_md }))
  await context.close()
}

// —— B14 结束期间历史变化：完整重确认；不补调 confirmProgress ——
{
  const { context, page } = await scene('B14', [taskDoc('b14'), actionDoc('b14'), planDoc('b14', { state: 'partial', actual_minutes: 1 }), endedSession('b14', 's-b14-h')])
  await startViaUi(page, 'p-b14')
  await fillAndSettle(page, 'B14 正文')
  await openEndForm(page)
  const dt0 = await dlg(page).innerText()
  rec('B14', '开框冻结旧历史摘要（1 段 · 01:00）', dt0.includes('1 段') && dt0.includes('01:00'), dt0.slice(0, 200))
  // 测试辅助：表单打开期间历史会话累计被外部改写。
  await mutateDoc(page, 's-b14-h', { accumulated_ms: 120000 })
  await saveEnd(page)
  await dlg(page).getByRole('button', { name: '已核对，继续' }).waitFor({ timeout: 10000 })
  const dt = await dlg(page).innerText()
  rec('B14', '历史变化：零写入拒绝并展示新历史摘要（1 段 · 02:00）', dt.includes('核对历史用时摘要') && dt.includes('02:00') && (await docOf(page, 'p-b14')).state === 'partial', dt.slice(0, 260))
  const sid = (await sessionsOf(page)).find((x) => x.ended_at == null).id
  rec('B14', '拒绝时会话未结束', (await docOf(page, sid)).ended_at == null, '')
  await dlg(page).getByRole('button', { name: '已核对，继续' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  const p = await docOf(page, 'p-b14')
  const entries = await opsEntries(page)
  rec('B14', '重确认后一次 end 事务完成：实际=floor(120000+本段)=2 分钟', p.state === 'partial' && p.actual_minutes === 2, JSON.stringify({ actual: p.actual_minutes }))
  rec('B14', '全程无 confirmProgress 补写（台账只有 begin/saveDraft/end 类）', entries.every((e) => e.op !== 'confirmProgress'), JSON.stringify(entries.map((e) => e.op)))
  await context.close()
}

// —— B15 返回/前后退经离开保护；切空间丢弃开始面板状态 ——
{
  const { context, page } = await scene('B15', [taskDoc('b15'), actionDoc('b15'), planDoc('b15')])
  await startViaUi(page, 'p-b15')
  await page.getByRole('button', { name: '返回安排' }).click()
  await page.getByRole('button', { name: '留在这里' }).waitFor({ timeout: 5000 })
  rec('B15', '返回安排触发离开保护（运行中先保存暂停）', (await bodyText(page)).includes('离开前将保存当前正文'), '')
  await page.getByRole('button', { name: '留在这里' }).click()
  await page.waitForTimeout(400)
  rec('B15', '选择留下：仍在工作页，会话未动', (await hashOf(page)).startsWith('#/work/') && (await sessionsOf(page))[0].running === true, '')
  await page.goBack()
  await page.getByRole('button', { name: '留在这里' }).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: '留在这里' }).click()
  await page.waitForTimeout(400)
  rec('B15', '浏览器后退同样经离开保护，可留下', (await hashOf(page)).startsWith('#/work/'), '')
  await page.getByLabel('本次成果正文').fill('B15 离开前正文')
  await page.goBack()
  await page.getByRole('button', { name: '保存并暂停后离开' }).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: '保存并暂停后离开' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  const s = (await sessionsOf(page))[0]
  rec('B15', '确认离开：正文已保存且暂停，未丢输入', s.running === false && s.draft_md === 'B15 离开前正文' && s.ended_at == null, JSON.stringify({ running: s.running, md: s.draft_md }))
  await context.close()
}
{
  const { context, page } = await scene('B15', [taskDoc('b15w'), actionDoc('b15w'), planDoc('b15w')])
  await openStartDialog(page, 'p-b15w')
  await page.evaluate(async () => {
    const { useAppStore } = await import(window.__mod('/src/stores/app.js'))
    await useAppStore().switchWorkspace('demo')
  })
  await page.waitForTimeout(600)
  rec('B15', '切空间：开始确认面板按作用域关闭，不串状态', (await dlg(page).count()) === 0, '')
  await context.close()
}

// —— B19 360px 手机布局 + 长说明 + Esc-忙碌保护 ——
{
  const longText = '这是一段用于验收的超长安排说明，'.repeat(8)
  const { context, page } = await scene('B19', [taskDoc('b19'), actionDoc('b19', { text: longText }), planDoc('b19', { action_text: longText })], { viewport: { width: 360, height: 740 } })
  await openStartDialog(page, 'p-b19')
  const overflow1 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const btnVisible = await dlg(page).getByRole('button', { name: '确认并开始' }).isVisible()
  rec('B19', '360px 开始面板：无横向溢出，主按钮可见', overflow1 <= 1 && btnVisible, `overflow=${overflow1}`)
  await page.screenshot({ path: join(OUT, 'b19-mobile-start.png') })
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await openEndForm(page)
  const dt = await dlg(page).innerText()
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  rec('B19', '360px 结束表单：双结果组清楚且无横向挤压', dt.includes('这次行动的结果') && dt.includes('这项安排的进度') && overflow2 <= 1, `overflow=${overflow2}`)
  await page.screenshot({ path: join(OUT, 'b19-mobile-endform.png') })
  await context.close()
}
// 整改加强（人工审查 B19/R4）：360px 完成返回必须选中安排日（同周不同日），
// 日期条 aria-pressed 与选中日两区内容都按安排日断言，完成历史自动展开。
{
  const { context, page } = await scene('B19', [taskDoc('b19m'), actionDoc('b19m'), planDoc('b19m', { date: tomorrow })], { viewport: { width: 360, height: 740 } })
  await startViaUi(page, 'p-b19m')
  await page.getByLabel('本次成果正文').fill('B19 手机完成正文')
  await openEndForm(page)
  await dlg(page).locator('input[name="work-outcome"][value="done"]').check()
  await dlg(page).locator('input[name="plan-progress"][value="done"]').check()
  await saveEnd(page)
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  await page.waitForTimeout(800)
  const hash = decodeURIComponent(await hashOf(page))
  const strip = page.locator('[role="group"][aria-label="选择日期"]')
  const targetPressed = await strip.locator(`[data-date="${tomorrow}"]`).getAttribute('aria-pressed')
  const todayPressed = await strip.locator(`[data-date="${today}"]`).getAttribute('aria-pressed')
  rec('B19', '360px 完成返回：URL 定位安排日，日期条选中安排日而非今天', hash.includes(`date=${tomorrow}`) && hash.includes('plan=p-b19m') && targetPressed === 'true' && todayPressed === 'false', `${hash} target=${targetPressed} today=${todayPressed}`)
  const cell = page.locator(`[data-date="${tomorrow}"]`)
  const histBtn = cell.getByRole('button', { name: /安排历史/ }).first()
  const histExpanded = await histBtn.getAttribute('aria-expanded')
  const histCardVisible = await cell.getByRole('button', { name: '安排历史详情：虚构安排·b19m' }).first().isVisible()
  rec('B19', '360px 选中日展示安排日两区，完成历史自动展开且历史卡可见', histExpanded === 'true' && histCardVisible, `expanded=${histExpanded}, cardVisible=${histCardVisible}`)
  await page.screenshot({ path: join(OUT, 'b19-mobile-return-selected.png') })
  await context.close()
}
{
  const { context, page } = await scene('B19', [taskDoc('b19e'), actionDoc('b19e'), planDoc('b19e')])
  await startViaUi(page, 'p-b19e')
  await fillAndSettle(page, 'B19 Esc 正文')
  // 注入：结束事务写安排时同步阻塞 1.5s 再抛错 → 真实 busy 窗口内按 Esc 不得关闭。
  await page.evaluate((planId) => {
    const proto = IDBObjectStore.prototype
    window.__origPut = proto.put
    proto.put = function (value, ...rest) {
      if (value && value.kind === 'plan_item' && value.id === planId) {
        const until = Date.now() + 1500
        while (Date.now() < until) { /* 同步阻塞制造 busy 窗口 */ }
        throw new Error('注入：阻塞后失败')
      }
      return window.__origPut.call(this, value, ...rest)
    }
  }, 'p-b19e')
  await openEndForm(page)
  await saveEnd(page)
  await page.keyboard.press('Escape')
  await dlg(page).getByRole('button', { name: '核实结果' }).waitFor({ timeout: 10000 })
  rec('B19', '保存忙碌期间 Esc 不关闭表单（冻结可观察）', (await dlg(page).count()) > 0 && (await dlg(page).innerText()).includes('核实'), '')
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__origPut })
  await dlg(page).getByRole('button', { name: '原信封重试' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  rec('B19', 'Esc 验证后原信封重试仍成功', (await sessionsOf(page))[0].ended_at != null, '')
  await context.close()
}

// —— B20 已加载应用断网冒烟：开始→写成果→结束→返回全本地可用 ——
{
  const { context, page } = await scene('B20', [taskDoc('b20'), actionDoc('b20'), planDoc('b20')])
  await context.setOffline(true)
  await startViaUi(page, 'p-b20')
  await page.getByLabel('本次成果正文').fill('B20 离线正文')
  await page.waitForTimeout(1200) // 真实等待计时
  await openEndForm(page)
  await saveEnd(page)
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  const s = (await sessionsOf(page))[0]
  const bt = await bodyText(page)
  rec('B20', '断网后闭环可用：结束落库+返回定位+真实记录提示', s.ended_at != null && s.draft_md === 'B20 离线正文' && bt.includes('这次记录已保存') && (await hashOf(page)).includes('plan=p-b20'), '')
  await page.screenshot({ path: join(OUT, 'b20-offline-return.png') })
  await context.setOffline(false)
  await context.close()
}

await browser.close()
writeFileSync(join(OUT, 'ui-acceptance-b2-results.json'), JSON.stringify({ at: now(), today, results }, null, 2))
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)