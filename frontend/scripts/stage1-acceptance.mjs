// 阶段1 真实浏览器验收（playwright-core + 系统 Edge）。
// 覆盖：personal/demo 隔离、北京时区无关、日历交互、空值不补今天、刷新不漂移、已有值原样保留。
// 运行：node scripts/stage1-acceptance.mjs [baseUrl]
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.argv[2] || 'http://localhost:5175'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const OUT = 'E:/qoder/devlog/private-evidence/stage1'
fs.mkdirSync(OUT, { recursive: true })

const DAY = 86400000
const bjToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const bjAdd = (ds, n) => new Date(Date.parse(ds + 'T00:00:00Z') + n * DAY + 8 * 3600 * 1000).toISOString().slice(0, 10)
const fmtDate = (ds) => { const [y, m, d] = ds.split('-').map(Number); return `${y}年${m}月${d}日` }

const results = []
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

const SEED = {
  personal: [
    { id: 'p-note-1', kind: 'note', workspace_id: 'personal', title: '个人·报名通知', status: 'draft', content_type: 'notice',
      fields: [
        { key: 'title', value: '个人·报名通知', status: 'confirmed', origin: 'model' },
        { key: 'deadline', value: '2026-12-01T17:00:00+08:00', precision: 'datetime', tz_known: true, status: 'candidate', origin: 'model' },
      ], warnings: [], created_at: '2026-11-18T09:00:00+08:00', updated_at: '2026-11-18T09:00:00+08:00' },
    { id: 'p-task-overdue', kind: 'task', workspace_id: 'personal', title: '个人·逾期任务', status: 'todo', note_ids: [],
      deadline: { value: '2026-11-10', precision: 'date', source: 'manual', confirmed_at: '2026-11-09T09:00:00+08:00' } },
    { id: 'p-task-future', kind: 'task', workspace_id: 'personal', title: '个人·未来任务', status: 'todo', note_ids: [],
      deadline: { value: '2026-12-05', precision: 'date', source: 'manual', confirmed_at: '2026-11-18T09:00:00+08:00' } },
  ],
  demo: [
    { id: 'd-note-1', kind: 'note', workspace_id: 'demo', title: '演示·示例通知', status: 'draft', content_type: 'notice',
      fields: [{ key: 'title', value: '演示·示例通知', status: 'confirmed', origin: 'model' }], warnings: [] },
    { id: 'd-task-1', kind: 'task', workspace_id: 'demo', title: '演示·示例任务', status: 'todo', note_ids: [],
      deadline: { value: '2026-12-05', precision: 'date', source: 'manual', confirmed_at: '2026-11-18T09:00:00+08:00' } },
  ],
}
// 今天任务用运行时北京今天，保证与设备时区无关的断言成立
SEED.personal.push({ id: 'p-task-today', kind: 'task', workspace_id: 'personal', title: '个人·今天任务', status: 'todo', note_ids: [],
  deadline: { value: bjToday(), precision: 'date', source: 'manual', confirmed_at: '2026-11-18T09:00:00+08:00' } })

async function seed(page) {
  await page.evaluate((records) => new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', 2)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of ['sources', 'docs', 'workspaces']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const db = req.result
      const t = db.transaction(['docs', 'workspaces'], 'readwrite')
      for (const r of records) t.objectStore('docs').put(r)
      t.objectStore('workspaces').put({ id: 'personal', name: '个人空间', is_demo: false, created_at: '2026-11-18T09:00:00+08:00' })
      t.objectStore('workspaces').put({ id: 'demo', name: '演示空间', is_demo: true, created_at: '2026-11-18T09:00:00+08:00' })
      t.oncomplete = () => { db.close(); resolve() }
      t.onerror = () => reject(t.error)
    }
    req.onerror = () => reject(req.error)
  }), [...SEED.personal, ...SEED.demo])
}

async function readDocs(page, ws) {
  return page.evaluate((workspace) => new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', 2)
    req.onsuccess = () => {
      const db = req.result
      const t = db.transaction('docs', 'readonly')
      const g = t.objectStore('docs').getAll()
      g.onsuccess = () => { db.close(); resolve(g.result.filter((d) => d.workspace_id === workspace)) }
      g.onerror = () => reject(g.error)
    }
    req.onerror = () => reject(req.error)
  }), ws)
}

const dateInputs = (page) => page.locator('button').filter({ has: page.locator('svg.lucide-calendar-days') })
const tab = (page, name) => page.locator(`aside [role="tab"][title="${name}"]`)
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: true })

async function ready(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('aside [role="tab"][title="个人空间"]').waitFor({ state: 'visible', timeout: 15000 })
}

async function main() {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--no-default-browser-check'] })
  const pageErrors = []

  // ---------- 场景 A：Asia/Shanghai 设备时区 ----------
  const ctxSH = await browser.newContext({ timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
  const page = await ctxSH.newPage()
  page.on('pageerror', (e) => pageErrors.push('SH: ' + e.message))
  await ready(page, BASE + '/#/today')
  await seed(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('text=个人·逾期任务').waitFor({ timeout: 15000 })

  // A1 今天标题与逾期分组（北京口径）
  const todayLabelSH = (await page.locator('p:has-text("（北京时间）")').first().innerText()).trim()
  const overdueSH = await page.locator('div.rounded-md.border:has(span:text("已逾期")) .text-sm.font-medium').allInnerTexts()
  check('A1 今天标题含北京日期', todayLabelSH.includes(fmtDate(bjToday())), todayLabelSH)
  check('A1 逾期仅昨天以前（今天/未来不逾期）', JSON.stringify(overdueSH.sort()) === JSON.stringify(['个人·逾期任务']), JSON.stringify(overdueSH))
  await shot(page, 'A1_today_shanghai.png')

  // A2 personal 数据可见、demo 不可见
  let bodyText = await page.locator('main').innerText()
  check('A2 personal 任务可见', bodyText.includes('个人·今天任务') && bodyText.includes('个人·未来任务'))
  check('A2 demo 数据不串入 personal', !bodyText.includes('演示·示例任务'))

  // A3 切到 demo：隔离 + 不残留选中
  await tab(page, '演示空间').click()
  await page.locator('text=演示·示例任务').waitFor({ timeout: 10000 })
  bodyText = await page.locator('main').innerText()
  check('A3 demo 任务可见', bodyText.includes('演示·示例任务'))
  check('A3 personal 数据在 demo 不可见', !bodyText.includes('个人·今天任务') && !bodyText.includes('个人·逾期任务'))
  check('A3 演示空间徽标出现', await page.locator('header span:has-text("演示空间")').first().isVisible())
  await shot(page, 'A3_demo_isolated.png')

  // A4 切回 personal：恢复
  await tab(page, '个人空间').click()
  await page.locator('text=个人·今天任务').waitFor({ timeout: 10000 })
  bodyText = await page.locator('main').innerText()
  check('A4 切回 personal 恢复本空间', bodyText.includes('个人·今天任务') && !bodyText.includes('演示·示例任务'))
  const wsAfter = await page.evaluate(() => localStorage.getItem('jxl-workspace'))
  check('A4 当前空间持久化为 personal', wsAfter === 'personal', String(wsAfter))

  // A5 刷新后日期不漂移（持久化事实），空草稿不被补成今天
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('text=个人·逾期任务').waitFor({ timeout: 15000 })
  const overdueAfterReload = await page.locator('div.rounded-md.border:has(span:text("已逾期")) .text-sm.font-medium').allInnerTexts()
  check('A5 刷新后逾期分组不变', JSON.stringify(overdueAfterReload.sort()) === JSON.stringify(['个人·逾期任务']), JSON.stringify(overdueAfterReload))
  const futureDisplayed = await page.locator('div.rounded-md.border:has-text("个人·未来任务")').first().innerText()
  check('A5 刷新后未来任务截止原文不漂移', futureDisplayed.includes('2026年12月5日'), futureDisplayed.replace(/\n/g, ' '))

  // ---------- 场景 B：收集页日历交互 ----------
  await ready(page, BASE + '/#/collect')
  const collectDI = dateInputs(page).first()
  check('B1 空参照日期显示今天建议（仅占位，未提交）', (await collectDI.innerText()).includes(bjToday()), await collectDI.innerText())
  await collectDI.click()
  const todayCell = page.locator('[aria-current="date"]')
  await todayCell.waitFor({ timeout: 5000 })
  check('B2 日历高亮北京今天', (await todayCell.getAttribute('aria-label')) === bjToday(), await todayCell.getAttribute('aria-label'))
  await shot(page, 'B2_calendar_open.png')

  // B3 明天快捷按钮（用户主动点击）
  await page.getByRole('button', { name: '明天', exact: true }).click()
  await page.waitForTimeout(200)
  check('B3 明天快捷=北京明日', (await collectDI.innerText()).includes(fmtDate(bjAdd(bjToday(), 1))), await collectDI.innerText())

  // B4 清空保持为空（不补今天）
  await page.locator('button[aria-label="清空日期"]').click()
  await page.waitForTimeout(200)
  check('B4 清空后回到空占位（不静默补今天）', (await collectDI.innerText()).includes('选择日期') || (await collectDI.innerText()).includes('参照日期'), await collectDI.innerText())
  await shot(page, 'B4_cleared_empty.png')

  // B5 7天后快捷
  await collectDI.click()
  await page.getByRole('button', { name: '7 天后', exact: true }).click()
  await page.waitForTimeout(200)
  check('B5 7天后快捷=北京+7日', (await collectDI.innerText()).includes(fmtDate(bjAdd(bjToday(), 7))), await collectDI.innerText())
  await page.locator('button[aria-label="清空日期"]').click()

  // ---------- 场景 C：便签页手动截止（精确字符串落库） ----------
  await ready(page, BASE + '/#/notes/p-note-1')
  await page.locator('text=个人·报名通知').first().waitFor({ timeout: 10000 })
  const manualDI = page.locator('button').filter({ has: page.locator('svg.lucide-calendar-days') }).filter({ hasText: '手动截止' }).first()
  await manualDI.click()
  await page.getByRole('button', { name: '明天', exact: true }).click()
  await page.waitForTimeout(200)
  const tasksBefore = (await readDocs(page, 'personal')).filter((d) => d.kind === 'task').length
  await page.getByRole('button', { name: '手动截止建任务' }).click()
  await page.waitForTimeout(400)
  let tasks = (await readDocs(page, 'personal')).filter((d) => d.kind === 'task')
  const manualTask = tasks.find((t) => t.deadline && t.deadline.source === 'manual' && t.deadline.value === bjAdd(bjToday(), 1))
  check('C1 手动截止建任务：精确北京明日字符串落库', !!manualTask && manualTask.deadline.precision === 'date', manualTask ? manualTask.deadline.value : '未找到')
  check('C1 任务数+1', tasks.length === tasksBefore + 1, `${tasksBefore} -> ${tasks.length}`)

  // C2 allowTime：选日 + 设时间 → datetime 落库（C1 成功后页面跳到 /today，需回到便签页）
  await ready(page, BASE + '/#/notes/p-note-1')
  await page.locator('text=个人·报名通知').first().waitFor({ timeout: 10000 })
  const manualDI2 = page.locator('button').filter({ has: page.locator('svg.lucide-calendar-days') }).filter({ hasText: '手动截止' }).first()
  await manualDI2.click()
  await page.locator('[aria-current="date"]').waitFor({ timeout: 5000 })
  // 十一月网格的尾部灰格含 12-05，点选它（跨月选择同样按北京日期提交）
  await page.locator('[aria-label="2026-12-05"]').click()
  const timeInput = page.locator('input[type="time"]')
  await timeInput.fill('17:00')
  await page.waitForTimeout(150)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: '手动截止建任务' }).click()
  await page.waitForTimeout(400)
  tasks = (await readDocs(page, 'personal')).filter((d) => d.kind === 'task')
  const dtTask = tasks.find((t) => t.deadline && t.deadline.value === '2026-12-05T17:00')
  check('C2 日历+时间组合为 datetime 落库', !!dtTask && dtTask.deadline.precision === 'datetime', dtTask ? dtTask.deadline.value : '未找到')

  // C3 空截止不补今天：选今天→清空→建任务应被拒绝、任务数不变
  await ready(page, BASE + '/#/notes/p-note-1')
  await page.locator('text=个人·报名通知').first().waitFor({ timeout: 10000 })
  const manualDI3 = page.locator('button').filter({ has: page.locator('svg.lucide-calendar-days') }).filter({ hasText: '手动截止' }).first()
  await manualDI3.click()
  await page.getByRole('button', { name: '今天', exact: true }).click()
  await page.waitForTimeout(200)
  await page.locator('button[aria-label="清空日期"]').first().click()
  await page.waitForTimeout(200)
  check('C3 清空后手动截止回到空占位', (await manualDI3.innerText()).includes('手动截止'), await manualDI3.innerText())
  const tasksBeforeEmpty = (await readDocs(page, 'personal')).filter((d) => d.kind === 'task').length
  await page.getByRole('button', { name: '手动截止建任务' }).click()
  await page.waitForTimeout(400)
  const tasksAfterEmpty = (await readDocs(page, 'personal')).filter((d) => d.kind === 'task').length
  const warnBanner = await page.locator('text=手动截止须为合法').first().isVisible().catch(() => false)
  check('C3 空截止建任务被拒绝（不静默补今天）', tasksAfterEmpty === tasksBeforeEmpty && warnBanner, `${tasksBeforeEmpty} -> ${tasksAfterEmpty}, warn=${warnBanner}`)
  await shot(page, 'C3_empty_rejected.png')

  // ---------- 场景 D：已有日期原样保留（明确偏移不被替换） ----------
  await ready(page, BASE + '/#/notes/p-note-1')
  await page.locator('text=个人·报名通知').first().waitFor({ timeout: 10000 })
  const deadlineCard = page.locator('div.rounded-lg.border').filter({ hasText: '截止时间' }).first()
  await deadlineCard.getByRole('button', { name: '编辑' }).click()
  await page.waitForTimeout(200)
  const editDI = dateInputs(page).first()
  check('D1 已有 datetime 原样回填显示', (await editDI.innerText()).includes('2026年12月1日 17:00'), await editDI.innerText())
  await editDI.click()
  await page.locator('[aria-label="2026-12-01"]').waitFor({ timeout: 5000 })
  check('D1 原文时区偏移保留提示', await page.locator('span[title="原文时区，保留不变"]').first().innerText() === '+08:00', await page.locator('span[title="原文时区，保留不变"]').first().innerText().catch(() => '无'))
  await shot(page, 'D1_existing_offset.png')
  // 只改日期（不动时间）→ 尾巴 T17:00:00+08:00 原样保留
  await page.locator('[aria-label="2026-12-05"]').click()
  await page.waitForTimeout(150)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await deadlineCard.getByRole('button', { name: '保存修改' }).click()
  await page.waitForTimeout(400)
  const noteAfter = (await readDocs(page, 'personal')).find((d) => d.id === 'p-note-1')
  const dlField = noteAfter.fields.find((f) => f.key === 'deadline')
  check('D2 改日期后时间+秒+偏移原样保留', dlField.value === '2026-12-05T17:00:00+08:00', dlField.value)
  check('D2 用户编辑标记 origin=user', dlField.origin === 'user', dlField.origin)

  // D3 刷新后该事实不漂移
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('text=个人·报名通知').first().waitFor({ timeout: 15000 })
  const dlDisplay = await page.locator('div.rounded-lg.border').filter({ hasText: '截止时间' }).first().innerText()
  check('D3 刷新后截止原文不漂移', dlDisplay.includes('2026年12月5日 17:00'), dlDisplay.replace(/\n/g, ' ').slice(0, 80))

  await ctxSH.close()

  // ---------- 场景 E：America/New_York 设备时区，北京口径不变 ----------
  const ctxNY = await browser.newContext({ timezoneId: 'America/New_York', viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
  const pageNY = await ctxNY.newPage()
  pageNY.on('pageerror', (e) => pageErrors.push('NY: ' + e.message))
  await ready(pageNY, BASE + '/#/today')
  await seed(pageNY)
  await pageNY.reload({ waitUntil: 'domcontentloaded' })
  await pageNY.locator('text=个人·逾期任务').waitFor({ timeout: 15000 })
  const todayLabelNY = (await pageNY.locator('p:has-text("（北京时间）")').first().innerText()).trim()
  const overdueNY = await pageNY.locator('div.rounded-md.border:has(span:text("已逾期")) .text-sm.font-medium').allInnerTexts()
  check('E1 改设备时区今天标题不变', todayLabelNY === todayLabelSH, `${todayLabelNY} vs ${todayLabelSH}`)
  check('E1 改设备时区逾期分组不变', JSON.stringify(overdueNY.sort()) === JSON.stringify(overdueSH.sort()), JSON.stringify(overdueNY))
  await shot(pageNY, 'E1_today_newyork.png')
  // 日历今天高亮与明天快捷在北京口径下与 SH 一致
  await ready(pageNY, BASE + '/#/collect')
  await dateInputs(pageNY).first().click()
  const nyTodayCell = pageNY.locator('[aria-current="date"]')
  await nyTodayCell.waitFor({ timeout: 5000 })
  check('E2 纽约设备时区日历仍高亮北京今天', (await nyTodayCell.getAttribute('aria-label')) === bjToday(), await nyTodayCell.getAttribute('aria-label'))
  await pageNY.getByRole('button', { name: '明天', exact: true }).click()
  await pageNY.waitForTimeout(200)
  check('E2 纽约设备时区明天快捷=北京明日', (await dateInputs(pageNY).first().innerText()).includes(fmtDate(bjAdd(bjToday(), 1))), await dateInputs(pageNY).first().innerText())
  await ctxNY.close()

  // ---------- 场景 F：移动端布局冒烟（无运行错误/控件可达） ----------
  const ctxM = await browser.newContext({ timezoneId: 'Asia/Shanghai', viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })
  const pageM = await ctxM.newPage()
  pageM.on('pageerror', (e) => pageErrors.push('M: ' + e.message))
  await pageM.goto(BASE + '/#/today', { waitUntil: 'domcontentloaded' })
  await pageM.locator('header [role="tab"][title="个人空间"]').waitFor({ state: 'visible', timeout: 15000 })
  await seed(pageM)
  await pageM.reload({ waitUntil: 'domcontentloaded' })
  await pageM.locator('text=个人·逾期任务').waitFor({ timeout: 15000 })
  const mobileSwitcher = pageM.locator('header [role="tab"][title="演示空间"]')
  check('F1 移动端工作区切换器可达', await mobileSwitcher.isVisible())
  await mobileSwitcher.click()
  await pageM.locator('text=演示·示例任务').waitFor({ timeout: 10000 })
  check('F1 移动端切换 demo 生效', await pageM.locator('text=演示·示例任务').first().isVisible())
  await shot(pageM, 'F1_mobile_demo.png')
  await ctxM.close()

  await browser.close()

  check('Z 全程无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | ') || '0 errors')

  const passed = results.filter((r) => r.pass).length
  const summary = { base: BASE, beijingToday: bjToday(), total: results.length, passed, failed: results.length - passed, pageErrors, results }
  fs.writeFileSync(path.join(OUT, 'acceptance_results.json'), JSON.stringify(summary, null, 2))
  console.log(`\n==== ${passed}/${results.length} PASS ====`)
  if (passed !== results.length) { console.log('FAILED:', results.filter((r) => !r.pass).map((r) => r.name)); process.exit(1) }
}

main().catch((e) => { console.error('SCRIPT ERROR', e); fs.writeFileSync(path.join(OUT, 'acceptance_error.txt'), String(e && e.stack || e)); process.exit(2) })