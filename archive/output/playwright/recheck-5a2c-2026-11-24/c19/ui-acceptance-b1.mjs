// 5A-2B #226 验收矩阵（一）：正向流程 B01/B02/B03/B05/B07/B08/B09/B10/B11/B16/B17/B18。
// 真实页面点击 + 真实 IndexedDB；独立 Context + 虚构种子；不触碰用户真实空间数据。
// B05 跨午夜用受控时钟（标注「模拟」）；B09 含真实等待计时；B18d 的安排终态变化来自测试辅助 putDoc（标注）。
// 运行：node E:/qoder/devlog/private-evidence/stage5a-2b/ui-acceptance-b1.mjs
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
const yesterday = addDays(today, -1)
const now = () => new Date().toISOString()

const taskDoc = (suffix, extra = {}) => ({
  id: `t-${suffix}`, kind: 'task', workspace_id: 'personal', title: `虚构任务·${suffix}`, status: 'todo',
  current_action_id: `a-${suffix}`, matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' },
  created_at: now(), updated_at: now(), is_demo: false, ...extra,
})
const actionDoc = (suffix, id = `a-${suffix}`, extra = {}) => ({
  id, kind: 'action', workspace_id: 'personal', task_id: `t-${suffix}`, text: `虚构行动·${suffix}`, minutes: 25,
  basis: 'user', done: false, created_at: now(), ...extra,
})
const planDoc = (suffix, id = `p-${suffix}`, extra = {}) => ({
  id, kind: 'plan_item', workspace_id: 'personal', task_id: `t-${suffix}`, date: today, state: 'planned',
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
const v0Session = (suffix, id, extra = {}) => ({
  id, kind: 'focus_session', workspace_id: 'personal', task_id: `t-${suffix}`, action_id: `a-${suffix}`,
  plan_item_id: null, started_at: now(), ended_at: null, accumulated_ms: 120000, running: true,
  outcome: null, blocker: null, draft_md: `遗留正文·${id}`, created_at: now(), ...extra,
})

async function scene(name, docs, { clock = null, viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p
  })
  page.on('pageerror', (e) => rec(name, '页面JS错误', false, e.message))
  if (clock) await page.clock.install({ time: clock })
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
const actionsOf = (page, taskId) => page.evaluate(async (taskId) => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  return (await db.allDocs()).records.filter((d) => d.kind === 'action' && d.task_id === taskId)
}, taskId)
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
async function startViaUi(page, planId, { expectDisabled = false, item = 'B??' } = {}) {
  await openStartDialog(page, planId)
  if (expectDisabled) rec(item, '未满足确认前「确认并开始」禁用', await dlg(page).getByRole('button', { name: '确认并开始' }).isDisabled(), '')
  const boxes = dlg(page).locator('input[type="checkbox"]')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
}
async function endViaUi(page, { outcome = 'partial', progress = 'partial', blocker = '', text = '验收正文', item = 'B??', waitFor = '#/today' } = {}) {
  await page.getByLabel('本次成果正文').fill(text)
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg(page).locator(`input[name="work-outcome"][value="${outcome}"]`).check()
  if (outcome === 'blocked') await dlg(page).getByLabel('阻塞说明').fill(blocker)
  if (progress) await dlg(page).locator(`input[name="plan-progress"][value="${progress}"]`).check()
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  await page.waitForFunction((w) => location.hash.startsWith(w), waitFor, { timeout: 10000 })
}

// —— B01 独立任务：开始/结束无安排参数；无第二组；返回任务链路 ——
{
  const { context, page } = await scene('B01', [taskDoc('b01'), actionDoc('b01')])
  await page.goto(BASE + '#/tasks/t-b01', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '开始执行' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const s = (await sessionsOf(page))[0]
  rec('B01', '独立会话 plan_item_id=null', !!s && s.plan_item_id == null, JSON.stringify({ sid: s && s.id }))
  await page.getByLabel('本次成果正文').fill('B01 独立成果')
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  rec('B01', '独立会话结束表单不显示安排进度组', (await dlg(page).getByText('这项安排的进度').count()) === 0, '')
  await dlg(page).locator('input[name="work-outcome"][value="done"]').check()
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/tasks/t-b01'), { timeout: 10000 })
  const s2 = (await sessionsOf(page))[0]
  const a = await docOf(page, 'a-b01')
  const t = await docOf(page, 't-b01')
  rec('B01', '结束落库 outcome=done；行动完成；任务不自动完成；返回任务页', s2.ended_at != null && s2.outcome === 'done' && a.done === true && t.status !== 'done', JSON.stringify({ outcome: s2.outcome, actionDone: a.done, taskStatus: t.status }))
  await context.close()
}

// —— B02 行动按 ID 明确选择：两条同名行动 + 无行动去任务新增 ——
{
  const { context, page } = await scene('B02', [
    taskDoc('b02a', { current_action_id: 'a1-b02a' }), actionDoc('b02a', 'a1-b02a', { text: '同名行动' }), actionDoc('b02a', 'a2-b02a', { text: '同名行动' }), planDoc('b02a'),
  ])
  await openStartDialog(page, 'p-b02a')
  const dt = await dlg(page).innerText()
  rec('B02', '确认面板展示当前行动（a1）但不自动提交', dt.includes('同名行动') && dt.includes('按 ID 明确选择'), dt.slice(0, 160))
  await dlg(page).getByRole('button', { name: '去任务选择行动' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/tasks/t-b02a'), { timeout: 8000 })
  const taskHash = decodeURIComponent(await hashOf(page))
  rec('B02', '去任务选择行动携带显式 plan 上下文与 return', taskHash.includes('plan=p-b02a') && taskHash.includes('return='), taskHash)
  await page.screenshot({ path: join(OUT, 'b02-task-context.png') })
  await page.getByRole('button', { name: '设为当前' }).click()
  await page.waitForTimeout(400)
  const t = await docOf(page, 't-b02a')
  rec('B02', '显式设为当前切换 a2（不文字匹配）', t.current_action_id === 'a2-b02a', t.current_action_id)
  await page.getByRole('button', { name: '开始这项安排' }).click()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const s = (await sessionsOf(page))[0]
  const acts = await actionsOf(page, 't-b02a')
  rec('B02', '会话绑定明确选择的 a2；零自动创建行动', s.action_id === 'a2-b02a' && acts.length === 2, JSON.stringify({ actionId: s.action_id, count: acts.length }))
  await context.close()
}
{
  const { context, page } = await scene('B02', [taskDoc('b02b', { current_action_id: null }), planDoc('b02b')])
  await openStartDialog(page, 'p-b02b')
  const dt = await dlg(page).innerText()
  rec('B02', '无有效行动：禁用开始并引导去任务选择', (await dlg(page).getByRole('button', { name: '确认并开始' }).isDisabled()) && dt.includes('尚未选择有效当前行动'), '')
  await dlg(page).getByRole('button', { name: '去任务选择行动' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/tasks/t-b02b'), { timeout: 8000 })
  await page.getByLabel('新行动内容').fill('新增的实际行动')
  await page.getByLabel('预计分钟').fill('15')
  await page.getByRole('button', { name: '添加行动' }).click()
  await page.waitForTimeout(500)
  // 新增不自动成为当前（不自动选第一条）：显式设为当前后再开始。
  await page.getByRole('button', { name: '设为当前' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '开始这项安排' }).click()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const s = (await sessionsOf(page))[0]
  const acts = await actionsOf(page, 't-b02b')
  rec('B02', '任务页新增行动后同一确认流程开始；绑定新行动 ID', acts.length === 1 && s.action_id === acts[0].id && acts[0].text === '新增的实际行动', JSON.stringify({ actionId: s.action_id }))
  await context.close()
}

// —— B03 同安排回到工作（暂停不自动继续）；同行动不同安排不误判 ——
{
  const { context, page } = await scene('B03', [taskDoc('b03'), actionDoc('b03'), planDoc('b03', 'p1-b03'), planDoc('b03', 'p2-b03', { order: 2 })])
  await startViaUi(page, 'p1-b03', { item: 'B03' })
  await page.getByRole('button', { name: '暂停' }).click()
  await page.waitForTimeout(600)
  let s = (await sessionsOf(page))[0]
  rec('B03', '暂停成功（running=false）', s.running === false, '')
  await page.goto(BASE + '#/today?plan=p1-b03', { waitUntil: 'domcontentloaded' })
  const entryBlock = page.locator('div.rounded-md:has-text("该安排有未结束的工作")').last()
  await entryBlock.getByRole('button', { name: '回到工作' }).waitFor({ timeout: 8000 })
  const entryText = await bodyText(page)
  rec('B03', '同安排未结束入口=回到工作（已暂停），不新建', entryText.includes('已暂停') && entryText.includes('进入工作页不会自动继续计时'), '')
  await entryBlock.getByRole('button', { name: '回到工作' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 8000 })
  await page.waitForTimeout(800)
  s = (await sessionsOf(page))[0]
  const wt = await bodyText(page)
  rec('B03', '回到工作不自动续计时（仍暂停，需主动继续）', s.running === false && wt.includes('继续计时') && (await sessionsOf(page)).length === 1, '')
  await page.goto(BASE + '#/today?plan=p2-b03', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '先处理已有工作' }).waitFor({ timeout: 8000 })
  const t2 = await bodyText(page)
  rec('B03', '同 Task/Action 不同安排 → 冲突入口而非回到工作', t2.includes('本空间已有其它未结束的工作') && (await page.locator('div.rounded-md:has-text("该安排有未结束的工作")').count()) === 0 && (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0, '')
  await context.close()
}

// —— B05 blocked 确认 / 延后执行 / 跨北京午夜（模拟受控时钟） ——
{
  const { context, page } = await scene('B05', [taskDoc('b05a', { status: 'blocked' }), actionDoc('b05a'), planDoc('b05a')])
  await openStartDialog(page, 'p-b05a')
  const dt = await dlg(page).innerText()
  rec('B05', 'blocked 任务：面板内明确确认文案且未勾选禁用', dt.includes('任务当前受阻') && (await dlg(page).getByRole('button', { name: '确认并开始' }).isDisabled()), '')
  await page.screenshot({ path: join(OUT, 'b05-blocked-dialog.png') })
  await dlg(page).locator('input[type="checkbox"]').check()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const t = await docOf(page, 't-b05a')
  const s = (await sessionsOf(page))[0]
  const drift = Math.abs(Date.now() - Date.parse(s.started_at))
  rec('B05', '确认后任务转进行中；started_at 为真实时钟', t.status === 'doing' && drift < 60000, JSON.stringify({ status: t.status, driftMs: drift }))
  await context.close()
}
{
  const deadline = { value: tomorrow, precision: 'date' }
  const { context, page } = await scene('B05', [taskDoc('b05b', { deadline }), actionDoc('b05b'), planDoc('b05b', 'p-b05b', { date: yesterday })])
  await openStartDialog(page, 'p-b05b')
  const dt = await dlg(page).innerText()
  rec('B05', '安排日早于今天：延后执行提示+未勾选禁用', dt.includes('延后执行（安排日早于今天）') && (await dlg(page).getByRole('button', { name: '确认并开始' }).isDisabled()), '')
  await dlg(page).locator('input[type="checkbox"]').check()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const p = await docOf(page, 'p-b05b')
  const t = await docOf(page, 't-b05b')
  rec('B05', '开始后原安排日与任务总截止不变', p.date === yesterday && JSON.stringify(t.deadline) === JSON.stringify(deadline), JSON.stringify({ date: p.date, deadline: t.deadline }))
  await context.close()
}
{
  // 模拟：受控时钟从北京时间 23:59:40 快进 30 秒跨午夜；确认事实 confirmDate 变化须重新核对。
  const clockTime = new Date(today + 'T15:59:40Z')
  const { context, page } = await scene('B05', [taskDoc('b05c'), actionDoc('b05c'), planDoc('b05c')], { clock: clockTime })
  await openStartDialog(page, 'p-b05c')
  await page.clock.fastForward('00:30')
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await dlg(page).getByText('确认期间事实已变化，请核对全部差异').waitFor({ timeout: 8000 })
  const dt = await dlg(page).innerText()
  rec('B05', '跨午夜（模拟）：confirmDate 差异列出，不静默开始', dt.includes('确认日期') || dt.includes(today), dt.slice(0, 200))
  rec('B05', '跨午夜（模拟）：差异期间未创建会话', (await sessionsOf(page)).length === 0, '')
  await dlg(page).getByRole('button', { name: '已核对，重新确认' }).click()
  const boxes = dlg(page).locator('input[type="checkbox"]')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  const s = (await sessionsOf(page))[0]
  const p = await docOf(page, 'p-b05c')
  const startedDate = new Date(Date.parse(s.started_at)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  rec('B05', '重新确认后开始（模拟）：started_at=次日真实（模拟）时钟；原安排日不改', startedDate === tomorrow && p.date === today, JSON.stringify({ startedDate, planDate: p.date }))
  await context.close()
}

// —— B07 旧 planned 有历史：先核对进度；异常历史：解释并不新开 ——
{
  const { context, page } = await scene('B07', [taskDoc('b07a'), actionDoc('b07a'), planDoc('b07a'), endedSession('b07a', 's-b07a')])
  await page.goto(BASE + '#/today?plan=p-b07a', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '核对已有进度' }).waitFor({ timeout: 8000 })
  rec('B07', '旧 planned 有合法历史 → 核对入口而非直接开始', (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0, '')
  await page.getByRole('button', { name: '核对已有进度' }).click()
  await page.getByText('确认这项安排的进度').waitFor({ timeout: 5000 })
  rec('B07', '核对进度框打开（人工确认，不自动写）', true, '')
  await page.locator('[role="alertdialog"]').getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(300)
  rec('B07', '取消核对不改变安排状态', (await docOf(page, 'p-b07a')).state === 'planned', '')
  await context.close()
}
{
  const { context, page } = await scene('B07', [taskDoc('b07b'), actionDoc('b07b'), planDoc('b07b'), endedSession('b07b', 's-b07b', { accumulated_ms: null })])
  await page.goto(BASE + '#/today?plan=p-b07b', { waitUntil: 'domcontentloaded' })
  await page.getByText('异常处理前不能确认进度或取消').waitFor({ timeout: 8000 })
  const t = await bodyText(page)
  rec('B07', '异常历史：解释问题+记录链接；不提供开始', t.includes('查看该记录') && (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0, '')
  await context.close()
}

// —— B08/B10 六种行动结果×安排进度组合：逐项落库 + 返回日程同步 ——
const COMBOS = [
  ['done', 'done'], ['done', 'partial'], ['partial', 'done'],
  ['partial', 'partial'], ['blocked', 'done'], ['blocked', 'partial'],
]
for (const [outcome, progress] of COMBOS) {
  const suffix = `b08-${outcome}-${progress}`
  const item = 'B08'
  const { context, page } = await scene(item, [taskDoc(suffix), actionDoc(suffix), planDoc(suffix)])
  await startViaUi(page, `p-${suffix}`, { item })
  await endViaUi(page, { outcome, progress, blocker: '虚构卡点：等队友接口', text: `组合正文 ${outcome}/${progress}`, item })
  const s = (await sessionsOf(page))[0]
  const p = await docOf(page, `p-${suffix}`)
  const a = await docOf(page, `a-${suffix}`)
  const t = await docOf(page, `t-${suffix}`)
  rec(item, `${outcome}/${progress}：会话与安排逐项落库`, s.outcome === outcome && s.ended_at != null && p.state === progress && (outcome !== 'blocked' || s.blocker === '虚构卡点：等队友接口'), JSON.stringify({ outcome: s.outcome, plan: p.state, blocker: s.blocker }))
  rec(item, `${outcome}/${progress}：行动完成仅随 done；任务不自动完成`, a.done === (outcome === 'done') && t.status !== 'done', JSON.stringify({ actionDone: a.done, taskStatus: t.status }))
  const hash = await hashOf(page)
  const bt = await bodyText(page)
  const stateLabel = progress === 'done' ? '已完成' : '部分完成'
  rec('B10', `${outcome}/${progress}：返回日程无需刷新即见安排新状态`, hash.includes(`plan=p-${suffix}`) && bt.includes(stateLabel), hash)
  if (outcome === 'blocked' && progress === 'partial') await page.screenshot({ path: join(OUT, 'b08-blocked-partial-return.png') })
  await context.close()
}
// blocked 卡点必填（表单层）
{
  const { context, page } = await scene('B08', [taskDoc('b08blk'), actionDoc('b08blk'), planDoc('b08blk')])
  await startViaUi(page, 'p-b08blk', { item: 'B08' })
  await page.getByLabel('本次成果正文').fill('卡点必填验证')
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg(page).locator('input[name="work-outcome"][value="blocked"]').check()
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  await page.waitForTimeout(600)
  const still = (await sessionsOf(page))[0]
  const dt = await dlg(page).innerText()
  rec('B08', 'blocked 未填卡点：拒绝提交并提示，会话未结束', still.ended_at == null && dt.includes('卡点'), dt.slice(0, 120))
  await context.close()
}

// —— B09 历史与本段分开；sum 后 floor；null/0 区分（含真实等待） ——
{
  const { context, page } = await scene('B09', [
    taskDoc('b09a'), actionDoc('b09a'), planDoc('b09a', 'p-b09a', { state: 'partial', actual_minutes: 2 }),
    endedSession('b09a', 's-b09a-1', { accumulated_ms: 90000 }),
    endedSession('b09a', 's-b09a-2', { accumulated_ms: 30000 }),
  ])
  await startViaUi(page, 'p-b09a', { item: 'B09' })
  const wt = await bodyText(page)
  rec('B09', '工作页安排块：已结束 2 段累计 02:00，与本段计时分开', wt.includes('已结束 2 段') && wt.includes('02:00') && wt.includes('本段计时单独显示'), '')
  await page.screenshot({ path: join(OUT, 'b09-plan-block.png') })
  await page.waitForTimeout(1200) // 真实等待计时
  await endViaUi(page, { item: 'B09', text: 'B09 多段正文' })
  const p = await docOf(page, 'p-b09a')
  const s = (await sessionsOf(page)).find((x) => x.ended_at != null && x.id !== 's-b09a-1' && x.id !== 's-b09a-2')
  rec('B09', 'sum(120000+本段) 后 floor=2 分钟；本段<1分钟单独保留毫秒', p.actual_minutes === 2 && s.accumulated_ms > 0 && s.accumulated_ms < 60000, JSON.stringify({ actual: p.actual_minutes, segmentMs: s.accumulated_ms }))
  rec('B09', '最近已结束引用指向本段', p.focus_session_id === s.id, p.focus_session_id)
  await context.close()
}
{
  const { context, page } = await scene('B09', [taskDoc('b09b'), actionDoc('b09b'), planDoc('b09b')])
  rec('B09', '无历史：actual_minutes=null（不是 0）', (await docOf(page, 'p-b09b')).actual_minutes === null, '')
  await startViaUi(page, 'p-b09b', { item: 'B09' })
  await endViaUi(page, { item: 'B09', text: '不足一分钟' })
  const p = await docOf(page, 'p-b09b')
  rec('B09', '少于一分钟结束：actual_minutes=0（与 null 区分）', p.actual_minutes === 0, String(p.actual_minutes))
  await context.close()
}

// —— B11 取消/重开保留选择与卡点；不隐式结束暂停；新目标不串值 ——
{
  const { context, page } = await scene('B11', [taskDoc('b11'), actionDoc('b11'), planDoc('b11', 'p1-b11'), planDoc('b11', 'p2-b11', { order: 2 })])
  await startViaUi(page, 'p1-b11', { item: 'B11' })
  await page.getByLabel('本次成果正文').fill('保留正文测试')
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg(page).locator('input[name="work-outcome"][value="blocked"]').check()
  await dlg(page).getByLabel('阻塞说明').fill('等队友接口')
  await dlg(page).getByRole('button', { name: '取消' }).click()
  await page.waitForTimeout(400)
  let s = (await sessionsOf(page))[0]
  rec('B11', '取消仅关表单：不结束不暂停', s.ended_at == null && s.running === true, '')
  rec('B11', '取消后正文保留在编辑器', (await page.getByLabel('本次成果正文').inputValue()) === '保留正文测试', '')
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  const blockedChecked = await dlg(page).locator('input[name="work-outcome"][value="blocked"]').isChecked()
  const blockerVal = await dlg(page).getByLabel('阻塞说明').inputValue()
  rec('B11', '同会话重开保留已选结果与卡点', blockedChecked && blockerVal === '等队友接口', JSON.stringify({ blockedChecked, blockerVal }))
  await dlg(page).locator('input[name="work-outcome"][value="partial"]').check()
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/today'), { timeout: 10000 })
  await startViaUi(page, 'p2-b11', { item: 'B11' })
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  const partialChecked = await dlg(page).locator('input[name="work-outcome"][value="partial"]').isChecked()
  const noBlocker = (await dlg(page).getByLabel('阻塞说明').count()) === 0
  rec('B11', '新会话表单回到初值 partial，不串上一会话卡点', partialChecked && noBlocker, '')
  await context.close()
}

// —— B16 完成后回原日程（done 折叠也可见）；刷新深链接不自动 begin/end；周视图可见 ——
{
  const { context, page } = await scene('B16', [taskDoc('b16'), actionDoc('b16'), planDoc('b16')])
  await startViaUi(page, 'p-b16', { item: 'B16' })
  await endViaUi(page, { outcome: 'done', progress: 'done', item: 'B16', text: 'B16 完成正文' })
  const hash1 = await hashOf(page)
  rec('B16', 'done 结束返回原日程定位原安排', hash1.includes('plan=p-b16') && hash1.includes('recorded='), hash1)
  const bt1 = await bodyText(page)
  rec('B16', 'done 安排在日程仍可见且提示来自真实记录', bt1.includes('虚构安排·b16') && bt1.includes('这次记录已保存'), '')
  // 整改加强（人工审查 B16）：必须验证日程卡片本身——目标日列的安排历史真实展开、历史卡可见，
  // 不能只靠详情面板文字通过。
  const b16HistoryCheck = async (label) => {
    const cell = page.locator(`[data-date="${today}"]`)
    const btn = cell.getByRole('button', { name: /安排历史/ }).first()
    const expanded = await btn.getAttribute('aria-expanded')
    const cardVisible = await cell.getByRole('button', { name: '安排历史详情：虚构安排·b16' }).first().isVisible()
    rec('B16', label, expanded === 'true' && cardVisible, `aria-expanded=${expanded}, cardVisible=${cardVisible}`)
  }
  await b16HistoryCheck('目标日列安排历史自动展开且历史卡可见（日程卡片，非详情文字）')
  await page.screenshot({ path: join(OUT, 'b16-done-return.png') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const ss = await sessionsOf(page)
  const bt2 = await bodyText(page)
  rec('B16', '刷新深链接：目标可见、无自动 begin/end（会话数不变、无未结束）', ss.length === 1 && ss.every((x) => x.ended_at != null) && bt2.includes('虚构安排·b16'), JSON.stringify({ count: ss.length }))
  await b16HistoryCheck('刷新深链接后安排历史仍自动展开且历史卡可见')
  await page.goto(BASE + '#/today?view=week&plan=p-b16', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  const bt3 = await bodyText(page)
  rec('B16', '周视图深链接：目标安排可见', bt3.includes('虚构安排·b16'), '')
  await b16HistoryCheck('周视图深链接：目标日列安排历史自动展开且历史卡可见')
  await page.screenshot({ path: join(OUT, 'b16-week.png') })
  await context.close()
}

// —— B17 行动已完成后另安排一天：新 ID/空摘要；不复活行动 ——
{
  const { context, page } = await scene('B17', [taskDoc('b17'), actionDoc('b17'), planDoc('b17')])
  await startViaUi(page, 'p-b17', { item: 'B17' })
  await endViaUi(page, { outcome: 'done', progress: 'partial', item: 'B17', text: 'B17 完成正文' })
  const a1 = await docOf(page, 'a-b17')
  rec('B17', '前置：行动已完成', a1.done === true, '')
  await page.locator('[role="status"]').getByRole('button', { name: '另安排一天' }).click()
  await page.getByText('另安排一天会新建一项安排').waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: '创建新安排' }).click()
  await page.waitForFunction(() => !location.hash.includes('plan=p-b17'), { timeout: 10000 })
  const newId = decodeURIComponent(await hashOf(page)).match(/plan=([^&]+)/)[1]
  const np = await docOf(page, newId)
  const op = await docOf(page, 'p-b17')
  const a2 = await docOf(page, 'a-b17')
  rec('B17', '新安排新 ID/planned/空累计；原 partial 安排不变', np.id !== 'p-b17' && np.state === 'planned' && np.actual_minutes == null && np.focus_session_id == null && op.state === 'partial', JSON.stringify({ newId, state: np.state }))
  rec('B17', '已完成行动不自动复活', a2.done === true, '')
  await context.close()
}

// —— B18 v0 遗留三分支 + 正常 v1 不越界降级 ——
{
  const { context, page } = await scene('B18', [taskDoc('b18a'), actionDoc('b18a'), v0Session('b18a', 's-v0a')])
  await page.goto(BASE + '#/work/s-v0a', { waitUntil: 'domcontentloaded' })
  await page.getByText('旧版（v0）未结束会话').waitFor({ timeout: 8000 })
  const t = await bodyText(page)
  rec('B18', 'v0 无安排：遗留表单，无安排进度组，不补造快照', !t.includes('这项安排的进度') && t.includes('不补造过去信息'), '')
  await page.screenshot({ path: join(OUT, 'b18-legacy-noplan.png') })
  await page.getByLabel('部分完成', { exact: true }).check()
  await page.getByLabel('确认累计（分钟）').fill('2')
  await page.getByRole('button', { name: '显式结束遗留记录' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work-records/'), { timeout: 10000 })
  const s = await docOf(page, 's-v0a')
  const a = await docOf(page, 'a-b18a')
  rec('B18', 'v0 无安排显式结束：归档不自动完成行动、不补 record_version', s.ended_at != null && s.outcome === 'partial' && s.accumulated_ms === 120000 && a.done === false && s.record_version == null, JSON.stringify({ outcome: s.outcome, rv: s.record_version }))
  await context.close()
}
{
  const { context, page } = await scene('B18', [taskDoc('b18b'), actionDoc('b18b'), planDoc('b18b'), v0Session('b18b', 's-v0b', { plan_item_id: 'p-b18b' })])
  await page.goto(BASE + '#/work/s-v0b', { waitUntil: 'domcontentloaded' })
  await page.getByText('旧版（v0）未结束会话').waitFor({ timeout: 8000 })
  const t = await bodyText(page)
  rec('B18', 'v0 有效活安排：表单增加安排结果与确认快照说明', t.includes('这项安排的进度') && t.includes('暂无已结束历史'), '')
  await page.screenshot({ path: join(OUT, 'b18-legacy-plan.png') })
  await page.getByLabel('这项安排已完成（不代表完成任务）').check()
  await page.getByLabel('确认累计（分钟）').fill('2')
  await page.getByRole('button', { name: '显式结束遗留记录' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work-records/'), { timeout: 10000 })
  const s = await docOf(page, 's-v0b')
  const p = await docOf(page, 'p-b18b')
  const a = await docOf(page, 'a-b18b')
  rec('B18', 'v0 有效安排同事务保存：安排 done/实际 2 分钟；不升版本不触碰行动', p.state === 'done' && p.actual_minutes === 2 && s.record_version == null && s.task_snapshot == null && a.done === false, JSON.stringify({ plan: p.state, actual: p.actual_minutes }))
  await context.close()
}
{
  const { context, page } = await scene('B18', [taskDoc('b18c'), actionDoc('b18c'), v0Session('b18c', 's-v0c', { plan_item_id: 'p-gone' })])
  await page.goto(BASE + '#/work/s-v0c', { waitUntil: 'domcontentloaded' })
  await page.getByText('遗留会话关联的安排缺失或已终态').waitFor({ timeout: 8000 })
  const t = await bodyText(page)
  rec('B18', 'v0 失效关联：提示可结束但无法更新安排', t.includes('可结束遗留记录释放占用，但本次无法更新安排'), '')
  await page.getByLabel('确认累计（分钟）').fill('2')
  await page.getByRole('button', { name: '显式结束遗留记录' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work-records/'), { timeout: 10000 })
  const s = await docOf(page, 's-v0c')
  rec('B18', 'v0 失效关联仍可显式结束释放占用', s.ended_at != null && s.outcome === 'partial', '')
  await context.close()
}
{
  const { context, page } = await scene('B18', [taskDoc('b18d'), actionDoc('b18d'), planDoc('b18d')])
  await startViaUi(page, 'p-b18d', { item: 'B18' })
  // 测试辅助：直接 putDoc 把安排改为终态（模拟其它入口取消），正常 v1 结束不得降级 legacyEnd。
  await mutateDoc(page, 'p-b18d', { state: 'cancelled' })
  await page.getByLabel('本次成果正文').fill('B18d 正文')
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  await page.waitForTimeout(1000)
  const s = (await sessionsOf(page))[0]
  const t = await bodyText(page)
  rec('B18', '正常 v1 安排终态：明确拒绝不降级遗留结束，会话未结束', s.ended_at == null && t.includes('安排已终态') && !t.includes('旧版（v0）未结束会话'), '')
  await context.close()
}

await browser.close()
writeFileSync(join(OUT, 'ui-acceptance-b1-results.json'), JSON.stringify({ at: now(), today, results }, null, 2))
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)