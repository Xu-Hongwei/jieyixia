// 5A-2B 整改反例驱动（人工审查 R1–R4，2026-11-23）：真实页面点击 + 真实 IndexedDB。
// 独立 Context + 虚构种子；不触碰用户真实空间数据。审查原证据 output/playwright/review-5a2b.* 不改动。
// 注入标注：RF1/RF3 的外部事实变化=测试辅助 putDoc；RF2 的读取失败=focus store loadWorkspace 一次性覆写（finally 语义由源码保证）。
// 运行：node E:/qoder/devlog/private-evidence/stage5a-2b-rfix-2026-11-23/ui-rfix.mjs
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
const day2 = addDays(today, 2)
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
const mutateDoc = (page, id, patch) => page.evaluate(async ({ id, patch }) => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  const d = (await db.allDocs()).records.find((x) => x.id === id)
  await db.putDoc({ ...d, ...patch })
  const { useAppStore } = await import(window.__mod('/src/stores/app.js'))
  await useAppStore().reload()
}, { id, patch })
const dlg = (page) => page.locator('[role="dialog"]')
const hashOf = (page) => page.evaluate(() => location.hash)

async function openStartDialog(page, planId) {
  await page.goto(BASE + `#/today?plan=${planId}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '开始这项安排' }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '开始这项安排' }).click()
  await dlg(page).getByRole('button', { name: '确认并开始' }).waitFor({ timeout: 5000 })
}
async function checkAll(page) {
  const boxes = dlg(page).locator('input[type="checkbox"]')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
}
async function endDone(page, text) {
  await page.getByLabel('本次成果正文').fill(text)
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg(page).locator('input[name="work-outcome"][value="done"]').check()
  await dlg(page).locator('input[name="plan-progress"][value="done"]').check()
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  await page.waitForTimeout(800)
}

// —— RF1（R1）今天→明天→再次改期：显示/日期关系/勾选与提交同一冻结确认版 ——
{
  const { context, page } = await scene('RF1', [taskDoc('rf1'), actionDoc('rf1'), planDoc('rf1')])
  await openStartDialog(page, 'p-rf1')
  rec('RF1', '开框显示今天安排日与「今天」关系标记', (await dlg(page).innerText()).includes(today) && (await dlg(page).getByText('今天', { exact: true }).count()) === 1, '')
  // 测试辅助 putDoc：外部改期到明天 + 改说明。
  await mutateDoc(page, 'p-rf1', { date: tomorrow, action_text: '虚构安排·rf1改' })
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await dlg(page).getByText('确认期间事实已变化，请核对全部差异').waitFor({ timeout: 8000 })
  const dt1 = await dlg(page).innerText()
  rec('RF1', '差异框列出安排日期变化（旧→新）', dt1.includes('「安排日期」') && dt1.includes(today) && dt1.includes(tomorrow), '')
  rec('RF1', '未重新确认前显示仍是开框冻结版（今天标记不漂移）', (await dlg(page).getByText('今天', { exact: true }).count()) === 1, '')
  await page.screenshot({ path: join(OUT, 'rf1-diffs.png') })
  await dlg(page).getByRole('button', { name: '已核对，重新确认' }).click()
  await dlg(page).getByText('提前执行（安排日晚于今天）', { exact: true }).waitFor({ timeout: 5000 })
  const dt2 = await dlg(page).innerText()
  rec('RF1', '重确认后安排日/关系/说明全部换到新版（明天+改后说明+提前执行）', dt2.includes(tomorrow) && dt2.includes('虚构安排·rf1改') && dt2.includes(`安排日 ${tomorrow} 与今天 ${today} 不同`), '')
  rec('RF1', '重确认后日期勾选重置：未勾选不能开始', await dlg(page).getByRole('button', { name: '确认并开始' }).isDisabled(), '')
  await checkAll(page)
  // 再次改期到后天：旧确认版不得直接提交。
  await mutateDoc(page, 'p-rf1', { date: day2 })
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await dlg(page).getByText('确认期间事实已变化，请核对全部差异').waitFor({ timeout: 8000 })
  rec('RF1', '再次改期：差异框期间显示仍是上一次确认版（明天）', (await dlg(page).innerText()).includes(`安排日 ${tomorrow} 与今天 ${today} 不同`), '')
  await dlg(page).getByRole('button', { name: '已核对，重新确认' }).click()
  await dlg(page).getByText(`安排日 ${day2} 与今天 ${today} 不同`).waitFor({ timeout: 5000 })
  rec('RF1', '第二次重确认跟随到后天且勾选再次重置', await dlg(page).getByRole('button', { name: '确认并开始' }).isDisabled(), '')
  await page.screenshot({ path: join(OUT, 'rf1-reconfirmed.png') })
  await checkAll(page)
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const ss = await sessionsOf(page)
  rec('RF1', '最终按最新确认版创建唯一会话（关联原安排）', ss.length === 1 && ss[0].plan_item_id === 'p-rf1' && ss[0].ended_at == null, JSON.stringify({ count: ss.length }))
  await context.close()
}

// —— RF2（R2）开始后补充读取一次失败：待核实不卡 busy，只重读不重新创建 ——
{
  const { context, page } = await scene('RF2', [taskDoc('rf2'), actionDoc('rf2'), planDoc('rf2')])
  await openStartDialog(page, 'p-rf2')
  // 注入：focus store 的 loadWorkspace 一次性抛错（begin 内部闭包重读不受影响，模拟导航前补充读取失败）。
  await page.evaluate(async () => {
    const { useFocusStore } = await import(window.__mod('/src/stores/focus.js'))
    const f = useFocusStore()
    const orig = f.loadWorkspace
    f.loadWorkspace = async () => { f.loadWorkspace = orig; throw new Error('注入：开始后补充读取一次失败') }
  })
  await checkAll(page)
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await dlg(page).getByText('已收到开始结果，读取待核实：会话可能已创建。可重试读取，不会重新创建。').waitFor({ timeout: 10000 })
  const retryBtn = dlg(page).getByRole('button', { name: '重试读取' })
  const cancelBtn = dlg(page).getByRole('button', { name: '取消' })
  rec('RF2', '读取失败进入待核实：重试读取/取消可用，不卡「正在开始…」', (await retryBtn.isEnabled()) && (await cancelBtn.isEnabled()) && (await dlg(page).getByRole('button', { name: '正在开始…' }).count()) === 0, '')
  rec('RF2', '待核实只提供重读，不提供原信封重试（不重新创建）', (await dlg(page).getByRole('button', { name: '原信封重试' }).count()) === 0, '')
  const ss1 = await sessionsOf(page)
  rec('RF2', '会话其实已创建（IDB 真实存在，未结束）', ss1.length === 1 && ss1[0].ended_at == null, JSON.stringify({ count: ss1.length }))
  await page.screenshot({ path: join(OUT, 'rf2-verify.png') })
  await retryBtn.click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const ss2 = await sessionsOf(page)
  rec('RF2', '重试读取后进入工作页，会话仍只有一条（未重新 begin）', ss2.length === 1 && ss2[0].id === ss1[0].id, JSON.stringify({ count: ss2.length }))
  await context.close()
}

// —— RF3（R3）失效安排上下文：不静默降级独立工作 ——
{
  const { context, page } = await scene('RF3', [
    taskDoc('rf3'), actionDoc('rf3'), planDoc('rf3'),
    taskDoc('rf3x'), actionDoc('rf3x'), planDoc('rf3x'),
    planDoc('rf3dead', { task_id: 't-rf3', task_ref_state: 'deleted' }),
  ])
  // 跨空间安排：写入 demo 空间（当前空间 personal 读不到）。
  await page.evaluate(async (doc) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    db.configureWorkspace('demo')
    await db.putDoc(doc)
    db.configureWorkspace('personal')
  }, planDoc('rf3ws', { workspace_id: 'demo', task_id: 't-rf3' }))

  const cases = [
    ['missing', 'p-nope', '链接中的安排不存在或不属于当前空间'],
    ['cross-task', 'p-rf3x', '链接中的安排不属于本任务'],
    ['dead-ref', 'p-rf3dead', '链接中的安排任务引用已断开'],
    ['cross-ws', 'p-rf3ws', '链接中的安排不存在或不属于当前空间'],
  ]
  for (const [kind, planId, warn] of cases) {
    await page.goto(BASE + `#/tasks/t-rf3?plan=${planId}`, { waitUntil: 'domcontentloaded' })
    await page.getByText(warn).first().waitFor({ timeout: 8000 })
    const plain = await page.getByRole('button', { name: '开始执行' }).count()
    const planEntry = await page.getByRole('button', { name: '开始这项安排' }).count()
    const back = await page.getByRole('button', { name: '返回日程' }).first().isVisible()
    const indep = await page.getByRole('button', { name: '改为独立工作' }).isVisible()
    rec('RF3', `${kind}：警告+无普通开始执行/安排入口，只有返回日程或显式改为独立工作`, plain === 0 && planEntry === 0 && back && indep, `plain=${plain} planEntry=${planEntry}`)
  }
  const wsNow = await page.evaluate(async () => {
    const { useAppStore } = await import(window.__mod('/src/stores/app.js'))
    return useAppStore().workspaceId
  })
  rec('RF3', 'cross-ws 不自动切换空间', wsNow === 'personal', wsNow)
  await page.screenshot({ path: join(OUT, 'rf3-invalid.png') })
  // 显式改为独立工作：二次确认后才创建无关联会话，plan 参数清除。
  await page.goto(BASE + '#/tasks/t-rf3?plan=p-nope', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '改为独立工作' }).click()
  await page.locator('[role="alertdialog"]').getByRole('button', { name: '确认改为独立工作' }).waitFor({ timeout: 5000 })
  await page.locator('[role="alertdialog"]').getByRole('button', { name: '确认改为独立工作' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const ss = await sessionsOf(page)
  const hash = decodeURIComponent(await hashOf(page))
  rec('RF3', '确认后创建独立会话（plan_item_id=null），return 不含失效 plan', ss.length === 1 && ss[0].plan_item_id == null && !hash.includes('plan=p-nope'), JSON.stringify({ count: ss.length, plan: ss[0] && ss[0].plan_item_id }))
  await context.close()
}
{
  const { context, page } = await scene('RF3', [taskDoc('rf3b'), actionDoc('rf3b'), planDoc('rf3b')])
  await page.goto(BASE + '#/tasks/t-rf3b?plan=p-rf3b', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '开始这项安排' }).waitFor({ timeout: 8000 })
  // 页面打开后安排才失效（测试辅助 putDoc）：UI 必须反应式切到失效分支。
  await mutateDoc(page, 'p-rf3b', { task_ref_state: 'deleted' })
  await page.getByRole('button', { name: '改为独立工作' }).waitFor({ timeout: 8000 })
  rec('RF3', '打开后失效：入口反应式切换，普通开始执行/安排入口消失', (await page.getByRole('button', { name: '开始执行' }).count()) === 0 && (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0, '')
  await context.close()
}
{
  const { context, page } = await scene('RF3', [taskDoc('rf3c'), actionDoc('rf3c')])
  await page.goto(BASE + '#/tasks/t-rf3c', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '开始执行' }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '开始执行' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const ss = await sessionsOf(page)
  rec('RF3', '无 plan 上下文的普通开始执行保持兼容（独立会话）', ss.length === 1 && ss[0].plan_item_id == null, '')
  await context.close()
}

// —— RF4a（R4）列表来源经任务页往返：保留来源视图、同周不同日定位、历史展开、手动操作不被拉回 ——
{
  const { context, page } = await scene('RF4', [taskDoc('rf4a', { current_action_id: null }), actionDoc('rf4a'), planDoc('rf4a', { date: tomorrow })])
  await page.goto(BASE + '#/today?view=list', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '安排详情：虚构安排·rf4a' }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '安排详情：虚构安排·rf4a' }).click()
  await page.getByRole('button', { name: '开始这项安排' }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '开始这项安排' }).click()
  await dlg(page).getByRole('button', { name: '去任务选择行动' }).waitFor({ timeout: 5000 })
  await dlg(page).getByRole('button', { name: '去任务选择行动' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/tasks/t-rf4a'), { timeout: 8000 })
  const taskHash = decodeURIComponent(await hashOf(page))
  rec('RF4', '去任务选择行动携带已验证来源（view=list）与 plan 上下文', taskHash.includes('plan=p-rf4a') && taskHash.includes('view=list'), taskHash)
  await page.getByRole('button', { name: '设为当前' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '开始这项安排' }).click()
  await dlg(page).getByRole('button', { name: '确认并开始' }).waitFor({ timeout: 5000 })
  await checkAll(page)
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await endDone(page, 'RF4a 完成正文')
  const hash = decodeURIComponent(await hashOf(page))
  rec('RF4', '完成返回：同周不同日也定位安排日，来源列表视图保留', hash.includes(`date=${tomorrow}`) && hash.includes('view=list') && hash.includes('plan=p-rf4a'), hash)
  const cell = page.locator(`[data-date="${tomorrow}"]`)
  const histBtn = cell.getByRole('button', { name: /安排历史/ }).first()
  const expanded = await histBtn.getAttribute('aria-expanded')
  const cardVisible = await cell.getByRole('button', { name: '安排历史详情：虚构安排·rf4a' }).first().isVisible()
  rec('RF4', '目标日（明天）安排历史自动展开且历史卡可见', expanded === 'true' && cardVisible, `expanded=${expanded}`)
  await page.screenshot({ path: join(OUT, 'rf4a-list-return.png') })
  // 手动收起后不被强制拉回；手动换日后不被强制跳回目标日。
  await histBtn.click()
  await page.waitForTimeout(700)
  rec('RF4', '手动收起历史后保持收起（不强制再展开）', (await histBtn.getAttribute('aria-expanded')) === 'false', '')
  await page.getByRole('button', { name: new RegExp(`选择 ${today}`) }).first().click()
  await page.waitForTimeout(700)
  const hash2 = decodeURIComponent(await hashOf(page))
  rec('RF4', '手动选今天后停留在今天（不强制跳回安排日）', !hash2.includes(`date=${tomorrow}`), hash2)
  await context.close()
}

// —— RF4b（R4）360px 周视图返回：日期条选中安排日，手动换日正常 ——
{
  const { context, page } = await scene('RF4', [taskDoc('rf4b'), actionDoc('rf4b'), planDoc('rf4b', { date: tomorrow })], { viewport: { width: 360, height: 740 } })
  await openStartDialog(page, 'p-rf4b')
  await checkAll(page)
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await endDone(page, 'RF4b 手机完成正文')
  const hash = decodeURIComponent(await hashOf(page))
  const strip = page.locator('[role="group"][aria-label="选择日期"]')
  const targetPressed = await strip.locator(`[data-date="${tomorrow}"]`).getAttribute('aria-pressed')
  const todayPressed = await strip.locator(`[data-date="${today}"]`).getAttribute('aria-pressed')
  rec('RF4', '360px 返回：URL 定位安排日，日期条选中明天而非今天', hash.includes(`date=${tomorrow}`) && targetPressed === 'true' && todayPressed === 'false', `${hash} target=${targetPressed} today=${todayPressed}`)
  const cell = page.locator(`[data-date="${tomorrow}"]`)
  const histBtn = cell.getByRole('button', { name: /安排历史/ }).first()
  const expanded = await histBtn.getAttribute('aria-expanded')
  const cardVisible = await cell.getByRole('button', { name: '安排历史详情：虚构安排·rf4b' }).first().isVisible()
  rec('RF4', '360px 选中日两区展示安排日内容，完成历史自动展开', expanded === 'true' && cardVisible, `expanded=${expanded}`)
  await page.screenshot({ path: join(OUT, 'rf4b-mobile-return.png') })
  await strip.locator(`[data-date="${today}"]`).click()
  await page.waitForTimeout(700)
  const hash2 = decodeURIComponent(await hashOf(page))
  const todayPressed2 = await strip.locator(`[data-date="${today}"]`).getAttribute('aria-pressed')
  rec('RF4', '360px 手动选今天后停留今天（不强制跳回）', !hash2.includes(`date=${tomorrow}`) && todayPressed2 === 'true', hash2)
  await context.close()
}

// —— RF5（R4 复验剩余 P2）同日换定位目标：定位标识=目标ID+所属清单，新目标重新展开 ——
// 历史种子 state=done 为测试辅助写入（虚构数据）；换目标用站内 hash 导航（保留 date，仅换 plan）。
{
  const { context, page } = await scene('RF5', [
    taskDoc('rf5a'), taskDoc('rf5b'),
    planDoc('rf5a', { state: 'done', actual_minutes: 30 }), planDoc('rf5b', { state: 'done', actual_minutes: 30 }),
  ], { viewport: { width: 360, height: 740 } })
  await page.goto(BASE + `#/today?plan=p-rf5a`, { waitUntil: 'domcontentloaded' })
  const cell = page.locator(`[data-date="${today}"]`)
  const histBtn = () => cell.getByRole('button', { name: /安排历史/ }).first()
  await page.waitForTimeout(600)
  const cardA = cell.getByRole('button', { name: '安排历史详情：虚构安排·rf5a' }).first()
  rec('RF5', '360px 定位 A：历史自动展开且 A 卡片可见', (await histBtn().getAttribute('aria-expanded')) === 'true' && (await cardA.isVisible()), '')
  await histBtn().click()
  await page.waitForTimeout(300)
  rec('RF5', '手动收起历史 aria-expanded=false', (await histBtn().getAttribute('aria-expanded')) === 'false', '')
  await page.evaluate(() => { location.hash = '#/today?plan=p-rf5b' })
  await page.waitForTimeout(700)
  const cardB = cell.getByRole('button', { name: '安排历史详情：虚构安排·rf5b' }).first()
  const expB = await histBtn().getAttribute('aria-expanded')
  const visB = await cardB.isVisible()
  rec('RF5', '同日换目标 B（仅换 plan）：历史重新展开且 B 卡片可见', expB === 'true' && visB, `expanded=${expB} visible=${visB}`)
  await page.screenshot({ path: join(OUT, 'rf5a-same-day-new-target.png') })
  await histBtn().click()
  await page.waitForTimeout(300)
  await page.evaluate(async () => {
    const { useAppStore } = await import(window.__mod('/src/stores/app.js'))
    await useAppStore().reload()
  })
  await page.waitForTimeout(700)
  rec('RF5', '同目标普通 store 刷新：保持手动收起，不强制重开', (await histBtn().getAttribute('aria-expanded')) === 'false', '')
  await context.close()
}
{
  const plans = [1, 2, 3, 4, 5].map((i) => planDoc(`rf5p${i}`, { task_id: 't-rf5p', order: i }))
  const { context, page } = await scene('RF5', [taskDoc('rf5p'), ...plans])
  await page.goto(BASE + '#/today?plan=p-rf5p1', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  const cell = page.locator(`[data-date="${today}"]`)
  const expandBtn = cell.getByRole('button', { name: /还有 2 项|收起/ }).first()
  rec('RF5', '普通区定位第 1 项：不展开（前 3 项可见）', (await expandBtn.getAttribute('aria-expanded')) === 'false' && (await cell.getByRole('button', { name: '安排详情：虚构安排·rf5p1' }).isVisible()), '')
  await page.evaluate(() => { location.hash = '#/today?plan=p-rf5p5' })
  await page.waitForTimeout(700)
  const inContainer = await page.evaluate(() => {
    const el = document.querySelector('[data-plan-id="p-rf5p5"]')
    if (!el) return { found: false }
    const box = el.closest('div[class*="overflow-y-auto"]')
    if (!box) return { found: true, boxed: false }
    const r = el.getBoundingClientRect(); const c = box.getBoundingClientRect()
    return { found: true, boxed: true, inside: r.top >= c.top - 1 && r.bottom <= c.bottom + 1, rtop: Math.round(r.top), ctop: Math.round(c.top), rbot: Math.round(r.bottom), cbot: Math.round(c.bottom) }
  })
  rec('RF5', '普通区换目标第 5 项：自动展开且卡片在真实滚动容器内可见', (await expandBtn.getAttribute('aria-expanded')) === 'true' && inContainer.found && inContainer.boxed && inContainer.inside, JSON.stringify(inContainer))
  await page.screenshot({ path: join(OUT, 'rf5b-plans-fifth.png') })
  await context.close()
}
{
  const { context, page } = await scene('RF5', [taskDoc('rf5c'), planDoc('rf5c')])
  await page.goto(BASE + '#/today?plan=p-rf5c', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  const cell = page.locator(`[data-date="${today}"]`)
  rec('RF5', '目标先在普通区：planned 卡片可见', await cell.getByRole('button', { name: '安排详情：虚构安排·rf5c' }).isVisible(), '')
  await mutateDoc(page, 'p-rf5c', { state: 'done', actual_minutes: 30 })
  await page.waitForTimeout(700)
  const histBtn = cell.getByRole('button', { name: /安排历史/ }).first()
  const histCard = cell.getByRole('button', { name: '安排历史详情：虚构安排·rf5c' }).first()
  rec('RF5', '同 ID 从普通区转入历史区：历史自动展开且卡片可见', (await histBtn.getAttribute('aria-expanded')) === 'true' && (await histCard.isVisible()), '')
  await context.close()
}

await browser.close()
writeFileSync(join(OUT, 'ui-rfix-results.json'), JSON.stringify({ at: now(), today, results }, null, 2))
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
console.log(`rfix exit=${failed.length ? 1 : 0}`)
process.exit(failed.length ? 1 : 0)