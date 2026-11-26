// 阶段2整改后真实浏览器验收（2026-11-19 新证据）：连接可见 Edge（CDP 9222），清空后预置确定性数据，
// 逐项验证 P06搜索+内容类型/日期筛选 / 已审阅≠已确认 / 联删+共享任务+取消零变更 / 冲突感知撤销 /
// 旧Group幂等迁移 / 事项Matter CRUD+资料角色+成员详情 / 今天首页 / 秒保留 / 刷新恢复 / 重复点击 /
// 移动端 / 受控时钟跨北京午夜（不真实挂机）。结束后保持窗口打开供人工复核；仅断开 CDP。
// 2026-11-19 视觉重构适配：高级筛选/新建/恢复入口/事项/更多操作均按需展开，断言前先展开对应面板；
// 周表卡片只留钟点+标题，完整截止标注改在详情浮层验证。业务断言与阈值不变。
// 2026-11-19 导航整理适配：收集箱→资料库（搜索 aria-label 同步）；事项管理移入资料库；
// 异常入口 href 带 bucket；任务详情浮层可访问名为任务标题（不再叫「任务详情」）。业务断言与阈值不变。
// 2026-11-20 阶段3A适配：任务详情浮层→统一详情页 /tasks/:id（返回原列表按钮回到来源视图）；
// 完整截止标注改在详情页验证（formatWhen 全量日期格式）。业务断言与阈值不变。
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const OUT = 'E:/qoder/devlog/private-evidence/stage3a-2026-11-20/regression'
fs.mkdirSync(OUT, { recursive: true })
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const bjToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const bjAddDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const cnLabel = (d) => `${+d.slice(0, 4)}年${+d.slice(5, 7)}月${+d.slice(8, 10)}日`

let pass = 0
const failures = []
const check = (name, cond) => {
  if (cond) { pass++; console.log('PASS', name) }
  else { failures.push(name); console.log('FAIL', name) }
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find((p) => p.url().includes('5175')) || ctx.pages()[0]
// 清理上次崩溃运行遗留的受控时钟页（同为 5175，避免累积）。
for (const p of ctx.pages()) if (p !== page && p.url().includes('5175')) await p.close()
const pageErrors = []
page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message) })
const shot = async (name, p = page) => {
  try {
    await p.bringToFront()
    await p.waitForTimeout(300)
    await p.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', caret: 'hide', timeout: 20000 })
    console.log('SHOT', name)
  } catch (e) {
    console.log('SHOT-SKIP', name, e.message.split('\n')[0])
  }
}
const readDocs = (p = page) => p.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('jxl-product', 2)
  req.onsuccess = () => {
    const db = req.result
    const out = {}
    const t = db.transaction(['docs', 'sources'], 'readonly')
    t.objectStore('docs').getAll().onsuccess = (e) => { out.docs = e.target.result }
    t.objectStore('sources').getAll().onsuccess = (e) => { out.sources = e.target.result.map(({ blob, ...rest }) => rest) }
    t.oncomplete = () => { db.close(); resolve(out) }
    t.onerror = () => reject(t.error)
  }
  req.onerror = () => reject(req.error)
}))
const docById = async (id) => (await readDocs()).docs.find((d) => d.id === id) || null
const dialog = () => page.getByRole('alertdialog')
// 3A：详情是独立页面，返回按钮回到来源列表（return 上下文保留日期/视图）。
const backFromDetail = async (p = page) => {
  await p.getByRole('button', { name: '返回原列表' }).waitFor({ timeout: 15000 })
  await p.getByRole('button', { name: '返回原列表' }).click()
}
const bodyText = () => page.locator('body').innerText()
// 视觉重构后恢复入口/事项面板默认折叠：断言前先按需展开（已展开则跳过）。
const openRecover = async (p = page) => {
  const btn = p.locator('#recover').getByRole('button', { name: /恢复入口/ })
  if ((await btn.getAttribute('aria-expanded')) === 'false') await btn.click()
}
const openMatters = async (p = page) => {
  const btn = p.getByRole('button', { name: /事项管理 ·/ })
  if ((await btn.getAttribute('aria-expanded')) === 'false') await btn.click()
}

await page.setViewportSize({ width: 1280, height: 800 })
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('aside').first().waitFor({ timeout: 15000 })

// —— 预置（清空三仓，写入确定性数据；含旧 group/group_id 遗留结构供迁移验证）——
await page.evaluate(async ({ png, today }) => {
  const bin = atob(png)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'image/png' })
  const W = 'personal'
  const recs = [
    { id: 's-img', kind: 'image', workspace_id: W, name: '截图A.png', captured_at: '2026-11-18T09:00:00+08:00', blob },
    { id: 's-txt', kind: 'text', workspace_id: W, text: '报名通道已开启，道具集合地点另行通知', captured_at: '2026-11-18T10:00:00+08:00' },
    { id: 's-plain', kind: 'text', workspace_id: W, text: '普通文字资料，尚未分析', captured_at: '2026-11-18T11:00:00+08:00' },
    // UTC 23:30 → 北京次日 07:30，用于日期范围的北京日界验证
    { id: 's-notice', kind: 'image', workspace_id: W, name: '通知.png', captured_at: '2026-11-15T23:30:00Z', blob },
    { id: 's-tut', kind: 'text', workspace_id: W, text: '教程文字：如何配置环境', captured_at: '2026-11-18T12:00:00+08:00' },
    { id: 's-legacy', kind: 'text', workspace_id: W, text: '旧分组的原始文字', captured_at: '2026-11-18T13:00:00+08:00' },
    { id: 'm-course', kind: 'matter', workspace_id: W, title: '课程事务', note_ids: ['n-pending'], created_at: '2026-11-18T09:00:00+08:00' },
    // 旧结构：kind=group + name + group_id（整改2 幂等迁移对象）
    { id: 'g-legacy', kind: 'group', workspace_id: W, name: '比赛旧分组', created_at: '2026-11-18T09:00:00+08:00' },
    { id: 'n-pending', kind: 'note', workspace_id: W, source_id: 's-img', title: '宣讲会报名通知', status: 'draft', content_type: 'notice',
      matter_id: 'm-course', matter_role: 'requirement',
      fields: [
        { key: 'title', value: '宣讲会报名通知', status: 'candidate', origin: 'model' },
        { key: 'deadline', value: '2026-11-21T17:00+08:00', precision: 'datetime', tz_known: true, status: 'candidate', origin: 'model' },
        { key: 'requirement', value: '提交纸质签字材料', raw: '必须提交纸质签字材料', quote: { text: '纸质签字材料须本人签署', source_id: 's-img' }, status: 'candidate', origin: 'model' },
        { key: 'summary', value: '报名与材料要求汇总', status: 'candidate', origin: 'model' },
        { key: 'keywords', value: ['报名', '纸质签字'], status: 'candidate', origin: 'model' },
      ], warnings: [] },
    { id: 'n-failed', kind: 'note', workspace_id: W, source_id: 's-txt', title: '报名文字（分析失败）', status: 'failed', content_type: 'unknown', fields: [], warnings: [] },
    { id: 'n-confirmed', kind: 'note', workspace_id: W, title: '已确认的通知', status: 'reviewed', reviewed_at: '2026-11-18T12:00:00+08:00', content_type: 'notice',
      fields: [{ key: 'title', value: '已确认的通知', status: 'confirmed', origin: 'model' }], warnings: [] },
    // 整改4：整体已审阅但截止未确认 → 仍属待核对
    { id: 'n-review-unconf', kind: 'note', workspace_id: W, source_id: 's-tut', title: '已审阅但截止未确认', status: 'reviewed', reviewed_at: '2026-11-18T12:00:00+08:00', content_type: 'tutorial',
      fields: [
        { key: 'title', value: '已审阅但截止未确认', status: 'confirmed', origin: 'model' },
        { key: 'deadline', value: null, status: 'unresolved', origin: 'model' },
      ], warnings: [] },
    { id: 'n-sec', kind: 'note', workspace_id: W, title: '带秒截止草稿', status: 'draft', content_type: 'notice',
      fields: [{ key: 'deadline', value: '2026-11-19T17:00:30+08:00', precision: 'datetime', tz_known: true, status: 'candidate', origin: 'model' }], warnings: [] },
    { id: 'n-legacy', kind: 'note', workspace_id: W, source_id: 's-legacy', title: '旧分组便签', status: 'draft', fields: [], warnings: [], group_id: 'g-legacy' },
    { id: 't-overdue', kind: 'task', workspace_id: W, title: '逾期·交实验报告', status: 'todo', note_ids: [],
      deadline: { value: '2026-11-10', precision: 'date', source: 'manual', confirmed_at: '2026-11-09T09:00:00+08:00' } },
    { id: 't-today', kind: 'task', workspace_id: W, title: '今日·提交报名表', status: 'todo', note_ids: [],
      deadline: { value: today, precision: 'date', source: 'manual', confirmed_at: '2026-11-18T09:00:00+08:00' } },
    { id: 't-future', kind: 'task', workspace_id: W, title: '稍后·准备答辩', status: 'todo', note_ids: [],
      deadline: { value: '2026-12-05', precision: 'date', source: 'manual', confirmed_at: '2026-11-18T09:00:00+08:00' } },
    { id: 't-done', kind: 'task', workspace_id: W, title: '已完成·旧任务', status: 'done', note_ids: [], deadline: null },
    { id: 't-link', kind: 'task', workspace_id: W, title: '关联任务·无截止', status: 'todo', note_ids: ['n-pending'], matter_id: 'm-course', deadline: null },
    { id: 't-ref', kind: 'task', workspace_id: W, title: '引用截止任务', status: 'todo', note_ids: ['n-confirmed'],
      deadline: { value: '2026-11-25', precision: 'date', source: 'note', from_note_id: 'n-confirmed', confirmed_at: '2026-11-18T09:00:00+08:00' } },
    { id: 't-shared', kind: 'task', workspace_id: W, title: '共享任务·两便签', status: 'todo', note_ids: ['n-pending', 'n-confirmed'],
      deadline: { value: '2026-11-22', precision: 'date', source: 'note', from_note_id: 'n-pending', confirmed_at: '2026-11-18T09:00:00+08:00' } },
    { id: 't-legacy', kind: 'task', workspace_id: W, title: '旧分组任务', status: 'todo', note_ids: [], group_id: 'g-legacy', deadline: null },
    { id: 't-conflict', kind: 'task', workspace_id: W, title: '冲突演练任务', status: 'todo', note_ids: [], deadline: null },
  ]
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', 2)
    req.onupgradeneeded = () => { const db = req.result; for (const s of ['sources', 'docs', 'workspaces']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }) }
    req.onsuccess = () => {
      const db = req.result
      const t = db.transaction(['sources', 'docs', 'workspaces'], 'readwrite')
      t.objectStore('sources').clear()
      t.objectStore('docs').clear()
      for (const r of recs) t.objectStore(r.kind === 'image' || (r.kind === 'text' && r.text !== undefined) ? 'sources' : 'docs').put(r)
      t.objectStore('workspaces').put({ id: 'personal', name: '个人空间', is_demo: false, created_at: '2026-11-18T09:00:00+08:00' })
      t.objectStore('workspaces').put({ id: 'demo', name: '演示空间', is_demo: true, created_at: '2026-11-18T09:00:00+08:00' })
      t.oncomplete = () => { db.close(); resolve() }
      t.onerror = () => reject(t.error)
    }
    req.onerror = () => reject(req.error)
  })
  localStorage.setItem('jxl-workspace', 'personal')
  for (const k of Object.keys(localStorage)) if (k.startsWith('jxl-ui-') || k.startsWith('jxl-pending-')) localStorage.removeItem(k)
}, { png: PNG_1x1, today: bjToday() })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
console.log('SEEDED')

// —— A. 收集箱：P06 搜索范围 + 形态/内容类型/状态/日期范围筛选 + 排序 ——
await page.goto('http://127.0.0.1:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.locator('text=资料库 · 6 / 6 份').waitFor({ timeout: 15000 })
check('A1 资料库初始 6/6', true)
const search = page.getByLabel('搜索资料库')
const expectCount = async (n) => page.locator(`text=资料库 · ${n} / 6 份`).waitFor({ timeout: 10000 })
await search.fill('道具集合')
await expectCount(1)
check('A2 关键词命中正文 → 1/6', (await page.locator('main').innerText()).includes('报名通道已开启'))
await search.fill('宣讲会')
await expectCount(1)
check('A3 关键词命中便签标题 → 1/6', (await page.locator('main').innerText()).includes('截图A.png'))
await search.fill('纸质签字')
await expectCount(1)
check('A4 P06：字段原文/引用/关键词命中（纸质签字）→ 1/6', (await page.locator('main').innerText()).includes('截图A.png'))
await search.fill('报名与材料要求汇总')
await expectCount(1)
check('A5 P06：摘要命中 → 1/6', true)
await search.fill('课程事务')
await expectCount(1)
check('A6 P06：事项名称命中 → 1/6', (await page.locator('main').innerText()).includes('事项「课程事务」'))
await search.fill('比赛旧分组')
await expectCount(1)
check('A7 P06：迁移后事项名称命中 → 1/6', (await page.locator('main').innerText()).includes('旧分组便签'))
await search.fill('不存在的关键词zzz')
await page.locator('text=没有匹配的资料').waitFor()
check('A8 无匹配空状态提示', true)
await search.fill('')
await expectCount(6)
// 高级筛选（形态/内容类型/日期）收在「筛选」面板内；常驻行只有 状态(0)/排序(1)，面板内 形态(2)/内容(3)。
await page.getByRole('button', { name: /^筛选/ }).click()
const selects = page.locator('div.w-28')
await selects.nth(2).getByRole('combobox').click()
await page.getByRole('option', { name: '文字', exact: true }).click()
await expectCount(4)
check('A9 形态筛选=文字 → 4/6', true)
await selects.nth(2).getByRole('combobox').click()
await page.getByRole('option', { name: '全部形态', exact: true }).click()
await expectCount(6)
await selects.nth(3).getByRole('combobox').click()
await page.getByRole('option', { name: '通知', exact: true }).click()
await expectCount(1)
check('A10 内容类型=通知 → 1/6（failed 的 unknown 不计入）', (await page.locator('main').innerText()).includes('截图A.png'))
await selects.nth(3).getByRole('combobox').click()
await page.getByRole('option', { name: '教程', exact: true }).click()
await expectCount(1)
check('A11 内容类型=教程 → 1/6', (await page.locator('main').innerText()).includes('教程文字'))
await selects.nth(3).getByRole('combobox').click()
await page.getByRole('option', { name: '参考资料', exact: true }).click()
await page.locator('text=没有匹配的资料').waitFor()
check('A12 内容类型=参考资料 → 0/6 空状态', true)
await selects.nth(3).getByRole('combobox').click()
await page.getByRole('option', { name: '全部内容', exact: true }).click()
await expectCount(6)
await selects.nth(0).getByRole('combobox').click()
await page.getByRole('option', { name: '失败', exact: true }).click()
await expectCount(1)
check('A13 状态=失败 → 1/6', (await page.locator('main').innerText()).includes('报名通道已开启'))
await selects.nth(0).getByRole('combobox').click()
await page.getByRole('option', { name: '待核对', exact: true }).click()
await expectCount(3)
check('A14 状态=待核对 → 3/6（含已审阅但未确认）', (await page.locator('main').innerText()).includes('已审阅但截止未确认'))
await shot('fix_collect_status_pending')
await selects.nth(0).getByRole('combobox').click()
await page.getByRole('option', { name: '全部状态', exact: true }).click()
await expectCount(6)
// 日期范围（北京日界）：起=止=2026-11-18 → 5/6；s-notice 的 UTC 23:30 属北京 11-16
const pickDate = async (which, date) => {
  await page.locator('button', { hasText: which }).first().click()
  await page.locator(`button[aria-label="${date}"]`).click()
}
await pickDate('起（可选）', '2026-11-18')
await pickDate('止（可选）', '2026-11-18')
await expectCount(5)
check('A15 日期范围 11-18~11-18 → 5/6（UTC 23:30 归北京 11-16 被排除）', !(await page.locator('main').innerText()).includes('通知.png'))
await page.getByRole('button', { name: '清除筛选', exact: true }).click()
await expectCount(6)
await pickDate('起（可选）', '2026-11-16')
await pickDate('止（可选）', '2026-11-16')
await expectCount(1)
check('A16 日期范围 11-16~11-16 → 1/6（Z 偏移按北京日界命中）', (await page.locator('main').innerText()).includes('通知.png'))
await shot('fix_collect_daterange')
await page.getByRole('button', { name: '清除筛选', exact: true }).click()
await expectCount(6)
await selects.nth(1).getByRole('combobox').click()
await page.getByRole('option', { name: '最早优先', exact: true }).click()
await page.waitForTimeout(300)
let rowsText = await page.locator('div.rounded-md.border.p-3.bg-background').allInnerTexts()
check('A17 最早优先：通知.png（北京 11-16）排第一', rowsText[0].includes('通知.png'))
await selects.nth(1).getByRole('combobox').click()
await page.getByRole('option', { name: '最新优先', exact: true }).click()
await page.waitForTimeout(300)
rowsText = await page.locator('div.rounded-md.border.p-3.bg-background').allInnerTexts()
check('A18 最新优先：旧分组的原始文字（13:00）排第一', rowsText[0].includes('旧分组的原始文字'))
check('A19 已审阅但未确认行：待核对徽标 + 已审阅徽标分开呈现', rowsText.some((t) => t.includes('已审阅但截止未确认') && t.includes('待核对') && t.includes('已审阅')))
await shot('fix_collect_full')

// —— B. 便签队列：已审阅≠已确认（整改4）——
await page.goto('http://127.0.0.1:5175/#/notes', { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: /待核对 · 4/ }).waitFor({ timeout: 15000 })
check('B1 待核对分组=4（含已审阅但截止未确认）', true)
check('B2 失败分组=1', await page.getByRole('button', { name: /失败 · 1/ }).count() === 1)
check('B3 已确认分组=1（仅字段全部终态的便签）', await page.getByRole('button', { name: /已确认 · 1/ }).count() === 1)
const queueBtn = page.getByRole('button', { name: /已审阅但截止未确认/ }).first()
check('B4 已审阅但未确认便签在待核对队列且显示待确认字段数', (await queueBtn.innerText()).includes('1 项字段待确认'))
await queueBtn.click()
await page.locator('text=已审阅不等于已确认').waitFor({ timeout: 15000 })
check('B5 核对页警示：已审阅不等于已确认，列出待确认字段', (await page.locator('main').innerText()).includes('截止时间'))
await shot('fix_notes_reviewed_unconfirmed')
await page.goto('http://127.0.0.1:5175/#/notes/n-pending', { waitUntil: 'domcontentloaded' })
await page.locator('div.text-base.font-semibold', { hasText: '宣讲会报名通知' }).first().waitFor({ timeout: 15000 })
await page.getByRole('button', { name: /待核对 · 4/ }).click()
await page.waitForTimeout(200)
check('B6 折叠后待核对条目隐藏', !(await page.getByRole('button', { name: /宣讲会报名通知/ }).first().isVisible()))
await page.getByRole('button', { name: /待核对 · 4/ }).click()
await page.getByRole('button', { name: /宣讲会报名通知/ }).first().waitFor()
check('B7 展开恢复', true)

// —— C. 联删（整改1）+ 冲突感知撤销（整改3）——
// 删除便签降为次级操作，收在「更多操作」内。
await page.getByRole('button', { name: '更多操作' }).click()
await page.getByRole('button', { name: '删除便签', exact: true }).click()
await dialog().waitFor()
let dlgTxt = await dialog().innerText()
check('C1 确认框列出 2 个关联任务（note_ids ∪ 截止出处，去重）', dlgTxt.includes('同时删除 2 个关联任务') && dlgTxt.includes('关联任务·无截止') && dlgTxt.includes('共享任务·两便签'))
check('C2 共享任务红字警示整体删除', dlgTxt.includes('（还关联其他便签，将整体删除）'))
check('C3 确认按钮为「删除便签及关联任务」', await dialog().getByRole('button', { name: '删除便签及关联任务' }).count() === 1)
check('C4 说明不扩散删除+取消零变更+撤销冲突边界', dlgTxt.includes('不会沿任务引用继续删除其他便签或事项') && dlgTxt.includes('取消则不做任何修改') && dlgTxt.includes('撤销会被明确拒绝'))
await shot('fix_delete_dialog_cascade')
await dialog().getByRole('button', { name: '取消' }).click()
await page.waitForTimeout(300)
check('C5 取消零变更：便签/任务/事项引用全部原样', !!(await docById('n-pending')) && !!(await docById('t-link')) && !!(await docById('t-shared')) && (await docById('m-course')).note_ids.includes('n-pending'))
await page.getByRole('button', { name: '删除便签', exact: true }).click()
await dialog().getByRole('button', { name: '删除便签及关联任务' }).click()
await page.locator('text=便签与 2 个关联任务已删除').waitFor({ timeout: 15000 })
check('C6 确认后便签与两个关联任务同事务删除', (await docById('n-pending')) === null && (await docById('t-link')) === null && (await docById('t-shared')) === null)
check('C7 其他便签/任务保留，事项 note_ids 摘除', !!(await docById('n-confirmed')) && !!(await docById('t-ref')) && !(await docById('m-course')).note_ids.includes('n-pending'))
check('C8 原始资料保留', (await readDocs()).sources.some((s) => s.id === 's-img'))
// 删除后修改幸存任务（审查3 的联删后等价场景）：撤销不得覆盖用户新标题
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.locator('text=逾期·交实验报告').waitFor({ timeout: 15000 })
const overdueRow = page.locator('div.rounded-md.border.p-3').filter({ hasText: '逾期·交实验报告' })
await overdueRow.locator('button[aria-label="重命名任务"]').click()
const overdueRenameInput = page.locator('input[aria-label="重命名任务"]')
await overdueRenameInput.fill('逾期·交实验报告（用户改）')
await page.locator('div.rounded-md.border.p-3').filter({ has: overdueRenameInput }).getByRole('button', { name: '保存' }).click()
await page.locator('text=逾期·交实验报告（用户改）').waitFor({ timeout: 15000 })
await openRecover()
await page.locator('text=最近删除：宣讲会报名通知').waitFor()
check('C9 恢复入口显示含 2 个关联任务', (await page.locator('#recover').innerText()).includes('（含 2 个关联任务）'))
await shot('fix_today_recover_cascade')
await page.locator('#recover').getByRole('button', { name: '恢复', exact: true }).click()
await page.locator('text=便签与本次一并删除的任务、行动已恢复').waitFor({ timeout: 15000 })
check('C10 撤销恢复便签与本次联删任务', !!(await docById('n-pending')) && !!(await docById('t-link')) && !!(await docById('t-shared')))
check('C11 撤销不覆盖用户新修改（幸存任务保留新标题）', (await docById('t-overdue')).title === '逾期·交实验报告（用户改）')
check('C12 事项引用补回且便签资料角色保留', (await docById('m-course')).note_ids.includes('n-pending') && (await docById('n-pending')).matter_role === 'requirement')
// 冲突拒绝：待恢复记录已有新版本 → 明确拒绝，不覆盖
await page.getByRole('button', { name: /稍后 \/ 已完成/ }).click()
const conflictRow = page.locator('div.rounded-md.border.p-3').filter({ hasText: '冲突演练任务' })
await conflictRow.locator('button[aria-label="删除任务"]').click()
await dialog().getByRole('button', { name: '删除任务', exact: true }).click()
await page.locator('text=任务已删除').waitFor({ timeout: 15000 })
await page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('jxl-product', 2)
  req.onsuccess = () => {
    const db = req.result
    const t = db.transaction('docs', 'readwrite')
    t.objectStore('docs').put({ id: 't-conflict', kind: 'task', workspace_id: 'personal', title: '冲突演练·用户新版本', status: 'todo', note_ids: [], deadline: { value: null, precision: 'none' } })
    t.oncomplete = () => { db.close(); resolve() }
    t.onerror = () => reject(t.error)
  }
}))
// 不刷新：撤销在事务内读最新落库状态，直接写入的新版本即构成冲突（lastDeleted 仅存内存，刷新会丢）
await page.locator('#recover').getByRole('button', { name: '恢复', exact: true }).click()
await page.locator('text=未恢复').waitFor({ timeout: 15000 })
check('C13 记录已有新版本 → 撤销被明确拒绝', (await bodyText()).includes('不恢复'))
check('C14 用户新版本原样保留，未被旧快照覆盖', (await docById('t-conflict')).title === '冲突演练·用户新版本')
await shot('fix_undo_conflict_refused')
// 刷新让界面与落库新版本同步（冲突已拒绝，无需再保留撤销记录）
// 导航整理后视图随 URL 持久：此时 ?view=list，刷新后仍是列表。
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=逾期任务 ·').waitFor({ timeout: 15000 })
// 截止出处命中（t-ref 同时被 note_ids 与 from_note_id 命中，只计一次）
await page.goto('http://127.0.0.1:5175/#/notes/n-confirmed', { waitUntil: 'domcontentloaded' })
await page.locator('div.text-base.font-semibold', { hasText: '已确认的通知' }).first().waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '更多操作' }).click()
await page.getByRole('button', { name: '删除便签', exact: true }).click()
await dialog().waitFor()
dlgTxt = await dialog().innerText()
check('C15 截止出处命中去重：t-ref 只列一次，共 2 个任务', dlgTxt.includes('同时删除 2 个关联任务') && dlgTxt.includes('引用截止任务') && dlgTxt.includes('共享任务·两便签'))
await dialog().getByRole('button', { name: '删除便签及关联任务' }).click()
await page.locator('text=便签与 2 个关联任务已删除').waitFor({ timeout: 15000 })
check('C16 引用截止的便签按新规则联删成功（旧阻止规则已废止）', (await docById('n-confirmed')) === null && (await docById('t-ref')) === null)
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await openRecover()
await page.locator('#recover').getByRole('button', { name: '恢复', exact: true }).click()
await page.locator('text=便签与本次一并删除的任务、行动已恢复').waitFor({ timeout: 15000 })
check('C17 再次撤销恢复成功（无冲突时正常恢复）', !!(await docById('n-confirmed')) && !!(await docById('t-ref')) && !!(await docById('t-shared')))

// —— W. 周视图：按截止日落位 / 列内时间序 / 跨周导航 / 无截止条 ——
const weekStartOf = (d) => bjAddDays(d, -((new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay() + 6) % 7))
const ws0 = weekStartOf(bjToday())
const wIndexOf = (d) => Math.round((Date.parse(weekStartOf(d) + 'T00:00:00Z') - Date.parse(ws0 + 'T00:00:00Z')) / 604800000)
const rangeOf = (ws) => `${+ws.slice(5, 7)}.${+ws.slice(8, 10)} — ${+bjAddDays(ws, 6).slice(5, 7)}.${+bjAddDays(ws, 6).slice(8, 10)}`
const weekCard = page.locator('div.rounded-xl.border').filter({ hasText: '按截止日查看' })
const dayCol = (date) => weekCard.locator('div.grid > div').nth((new Date(Date.parse(date + 'T00:00:00Z')).getUTCDay() + 6) % 7)
let wOffset = 0
const navTo = async (date) => {
  const delta = wIndexOf(date) - wOffset
  for (let i = 0; i < Math.abs(delta); i++) await page.getByRole('button', { name: delta > 0 ? '下一周' : '上一周' }).click()
  wOffset = wIndexOf(date)
}
await weekCard.waitFor({ timeout: 15000 })
check('W1 周范围标题（周一为首）', (await weekCard.innerText()).includes(rangeOf(ws0)))
const todayColTxt = await dayCol(bjToday()).innerText()
check('W2 今天列高亮 + 仅日期任务显示时间未定', todayColTxt.includes('今天') && todayColTxt.includes('今日·提交报名表') && todayColTxt.includes('时间未定'))
await navTo('2026-11-22')
const sharedTxt = await dayCol('2026-11-22').innerText()
check('W3 共享任务落 11-22 列', sharedTxt.includes('共享任务·两便签'))
// 收紧后的卡片只留钟点+标题；完整截止标注在统一详情页验证（3A：浮层→页面）。
await dayCol('2026-11-22').locator('button[aria-label="任务详情：共享任务·两便签"]').click()
await page.getByRole('button', { name: '返回原列表' }).waitFor({ timeout: 15000 })
check('W3b 详情页显示完整截止标注', (await page.locator('main').innerText()).includes('2026年11月22日'))
await backFromDetail()
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await navTo('2026-11-10')
const ovTxt = await dayCol('2026-11-10').innerText()
check('W4 逾期任务落原截止周 + 逾期红标', ovTxt.includes('逾期·交实验报告（用户改）') && ovTxt.includes('已逾期'))
await navTo('2026-12-05')
check('W5 未来任务落 12 月周', (await dayCol('2026-12-05').innerText()).includes('稍后·准备答辩'))
await page.getByRole('button', { name: '本周', exact: true }).click()
wOffset = 0
check('W6 本周按钮回到当前周', (await weekCard.innerText()).includes(rangeOf(ws0)))
const weekTxt = await weekCard.innerText()
check('W7 无截止条收纳无截止任务（含已完成）', weekTxt.includes('无截止任务 · 4'))
await page.getByRole('button', { name: /无截止任务 · 4/ }).click()
const undatedTxt = await weekCard.innerText()
check('W7b 展开后列出无截止任务本体', undatedTxt.includes('已完成·旧任务') && undatedTxt.includes('关联任务·无截止'))
// 建两个带钟点的今日任务，验证列内 0-24 点升序、仅日期置后（新建面板按需展开）
// 3A：新建成功跳统一详情页：每轮先返回原列表（return 保留今日周），再断言周表列。
const createRowW = page.locator('div.flex.flex-wrap.items-center.gap-2').filter({ has: page.getByLabel('新任务名称') })
for (const [title, hhmm] of [['周序·早', '09:00'], ['周序·晚', '18:00']]) {
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByLabel('新任务名称').fill(title)
  await createRowW.locator('button:has(svg.lucide-calendar-days)').click()
  await page.locator(`div.z-50 button[aria-label="${bjToday()}"]`).click()
  await page.locator('input[type="time"]').fill(hhmm)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '新建任务' }).click()
  await backFromDetail()
  await dayCol(bjToday()).locator(`text=${title}`).waitFor({ timeout: 15000 })
}
const colTxt = await dayCol(bjToday()).innerText()
check('W8 列内按钟点升序、仅日期置后', colTxt.indexOf('09:00') < colTxt.indexOf('18:00') && colTxt.indexOf('18:00') < colTxt.indexOf('时间未定') && colTxt.includes('周序·早') && colTxt.includes('周序·晚'))
await page.evaluate(() => window.scrollTo(0, 0))
await shot('fix_week_view')
// 清理周序任务（恢复今日分区计数，供后续 D 断言）
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.locator('text=逾期任务 ·').waitFor({ timeout: 15000 })
for (const title of ['周序·早', '周序·晚']) {
  const r = page.locator('div.rounded-md.border.p-3').filter({ hasText: title }).filter({ has: page.locator('button[aria-label="删除任务"]') })
  await r.locator('button[aria-label="删除任务"]').click()
  await dialog().getByRole('button', { name: '删除任务', exact: true }).click()
  await r.waitFor({ state: 'detached', timeout: 15000 })
}
const afterW = await page.locator('main').innerText()
check('W9 清理后逾期/今日分区恢复各 1', afterW.includes('逾期任务 · 1') && afterW.includes('今日任务 · 1'))

// —— D. 今天首页：入口计数 / 逾期 / 今日 / 稍后已完成 / 失败恢复入口 ——
await page.locator('text=逾期任务 · 1').waitFor({ timeout: 15000 })
const main = page.locator('main')
let txt = await main.innerText()
check('D1 今日标签（北京时间）', txt.includes('北京时间'))
check('D2 逾期区含逾期任务+已逾期徽标', txt.includes('逾期·交实验报告（用户改）') && txt.includes('已逾期'))
check('D3 今日区含今日任务', txt.includes('今日任务 · 1') && txt.includes('今日·提交报名表'))
check('D4 待核对入口=4（精确到 bucket=pending）', (await page.locator('a[href="#/notes?bucket=pending"]').filter({ hasText: '待核对' }).first().innerText()).includes('4'))
check('D5 失败入口=1（精确到 bucket=failed）', (await page.locator('a[href="#/notes?bucket=failed"]').filter({ hasText: '失败' }).first().innerText()).includes('1'))
await openRecover()
txt = await main.innerText()
check('D6 恢复入口列出失败便签+重试按钮', txt.includes('分析失败：报名文字（分析失败）') && (await page.locator('#recover').getByRole('button', { name: '重试分析' }).count()) === 1)
await page.getByRole('button', { name: /稍后 \/ 已完成 · 7/ }).click()
await page.locator('text=稍后·准备答辩').waitFor()
txt = await main.innerText()
check('D7 稍后/已完成展开显示未来+已完成+无截止任务', txt.includes('稍后·准备答辩') && txt.includes('已完成·旧任务') && txt.includes('关联任务·无截止') && txt.includes('冲突演练·用户新版本'))
await shot('fix_today_overview')

// —— E. 旧 Group 幂等迁移（整改2）+ 事项 Matter CRUD + 资料角色 + 成员详情 ——
let all = await readDocs()
const legacyMatter = all.docs.find((d) => d.id === 'g-legacy')
const legacyNote = all.docs.find((d) => d.id === 'n-legacy')
const legacyTask = all.docs.find((d) => d.id === 't-legacy')
check('E1 旧 group 迁移为契约 Matter（沿用原 id，name→title）', !!legacyMatter && legacyMatter.kind === 'matter' && legacyMatter.title === '比赛旧分组')
check('E2 成员 group_id→matter_id，旧键移除，note_ids 回填', legacyNote.matter_id === 'g-legacy' && !('group_id' in legacyNote) && legacyTask.matter_id === 'g-legacy' && !('group_id' in legacyTask) && legacyMatter.note_ids.includes('n-legacy'))
check('E3 无截止任务映射契约空 Deadline 形状', legacyTask.deadline.value === null && legacyTask.deadline.precision === 'none' && all.docs.find((d) => d.id === 't-done').deadline.precision === 'none')
check('E4 迁移不清数据：便签/任务/原始资料本体保留', all.docs.some((d) => d.id === 'n-legacy') && all.docs.some((d) => d.id === 't-legacy') && all.sources.some((s) => s.id === 's-legacy'))
const docCount = all.docs.length
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=逾期任务 ·').waitFor({ timeout: 15000 })
all = await readDocs()
check('E5 迁移幂等：再次进入不产生重复写入/残留 group', all.docs.length === docCount && !all.docs.some((d) => d.kind === 'group'))
// 事项管理已移入资料库；新建任务仍在日程页。
await page.goto('http://127.0.0.1:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.locator('text=资料库 · 6 / 6 份').waitFor({ timeout: 15000 })
await openMatters()
await page.getByLabel('新事项名').fill('比赛事务')
await page.getByRole('button', { name: '建事项' }).click()
const matterRow = () => page.locator('div.rounded-md.border.p-2').filter({ hasText: '比赛事务' })
await matterRow().waitFor({ timeout: 15000 })
check('E6 建事项成功（0 便签 · 0 任务）', (await matterRow().innerText()).includes('0 便签 · 0 任务'))
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '新建', exact: true }).click()
await page.getByLabel('新任务名称').fill('新任务·买道具')
const createRow = page.locator('div.flex.flex-wrap.items-center.gap-2').filter({ has: page.getByLabel('新任务名称') })
await createRow.getByRole('combobox').click()
await page.getByRole('option', { name: '比赛事务', exact: true }).click()
await page.getByRole('button', { name: '新建任务' }).click()
await page.locator('text=任务已创建').waitFor({ timeout: 15000 })
// 3A：无截止新建跳统一详情页：返回原列表后再离开页面。
await backFromDetail()
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
const newTask = (await readDocs()).docs.find((d) => d.title === '新任务·买道具')
const newMatter = (await readDocs()).docs.find((d) => d.kind === 'matter' && d.title === '比赛事务')
check('E7 新建任务归入事项（matter_id 落库）', !!newTask && newTask.matter_id === newMatter.id && newTask.deadline.precision === 'none')
await page.goto('http://127.0.0.1:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.locator('text=资料库 · 6 / 6 份').waitFor({ timeout: 15000 })
await openMatters()
await matterRow().waitFor({ timeout: 15000 })
check('E8 事项成员计数实时更新（0 便签 · 1 任务）', (await matterRow().innerText()).includes('0 便签 · 1 任务'))
await matterRow().locator('button[aria-expanded]').first().click()
await matterRow().locator('text=相关任务').waitFor()
let detailTxt = await matterRow().innerText()
check('E9 事项成员详情：资料与角色 + 相关任务（非仅计数）', detailTxt.includes('资料与角色') && detailTxt.includes('还没有便签归入') && detailTxt.includes('新任务·买道具'))
await shot('fix_matter_detail')
// 事项面板保持展开：资料库无独立任务列表，归组任务只在展开的事项详情内渲染 TaskRow。
const taskRow = () => page.locator('div.rounded-md.border.p-3').filter({ hasText: '新任务·买道具' })
await taskRow().locator('button[aria-label="重命名任务"]').click()
const taskRenameInput = page.locator('input[aria-label="重命名任务"]')
await taskRenameInput.fill('新任务·买道具（改）')
await page.locator('div.rounded-md.border.p-3').filter({ has: taskRenameInput }).getByRole('button', { name: '保存' }).click()
await page.locator('text=新任务·买道具（改）').waitFor({ timeout: 15000 })
check('E10 任务重命名生效并落库', (await docById(newTask.id)).title === '新任务·买道具（改）')
await matterRow().locator('button[aria-label="重命名事项"]').click()
const matterRenameInput = page.locator('input[aria-label="重命名事项"]')
await matterRenameInput.fill('比赛事务（改）')
await page.locator('div.rounded-md.border.p-2').filter({ has: matterRenameInput }).getByRole('button', { name: '保存' }).click()
await page.locator('div.rounded-md.border.p-2', { hasText: '比赛事务（改）' }).waitFor({ timeout: 15000 })
check('E11 事项重命名生效', (await docById(newMatter.id)).title === '比赛事务（改）')
const taskRow2 = () => page.locator('div.rounded-md.border.p-3').filter({ hasText: '新任务·买道具（改）' })
await taskRow2().getByRole('combobox').click()
await page.getByRole('option', { name: '未归组', exact: true }).click()
await page.waitForTimeout(400)
check('E12 任务移出事项 → 0 任务，matter_id=null', (await matterRow().innerText()).includes('0 便签 · 0 任务') && (await docById(newTask.id)).matter_id === null)
// 移出后任务在资料库不再渲染（无独立任务列表）；归回操作改在日程列表「稍后/已完成」分区进行。
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.getByRole('button', { name: /稍后 \/ 已完成/ }).click()
const taskRow3 = () => page.locator('div.rounded-md.border.p-3').filter({ hasText: '新任务·买道具（改）' })
await taskRow3().getByRole('combobox').click()
await page.getByRole('option', { name: '比赛事务（改）', exact: true }).click()
await page.waitForTimeout(400)
await page.goto('http://127.0.0.1:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.locator('text=资料库 · 6 / 6 份').waitFor({ timeout: 15000 })
await openMatters()
await matterRow().waitFor({ timeout: 15000 })
check('E13 任务归回事项 → 1 任务', (await matterRow().innerText()).includes('0 便签 · 1 任务'))
// 便签归组 + 资料角色 + 双向一致性（NotesPage）
await page.goto('http://127.0.0.1:5175/#/notes/n-pending', { waitUntil: 'domcontentloaded' })
await page.locator('div.text-base.font-semibold', { hasText: '宣讲会报名通知' }).first().waitFor({ timeout: 15000 })
check('E14 核对页显示所属事项与资料角色选择', (await page.locator('div.w-32').getByRole('combobox').innerText()).includes('课程事务') && (await page.locator('div.w-28').getByRole('combobox').innerText()).includes('要求'))
await page.locator('div.w-28').getByRole('combobox').click()
await page.getByRole('option', { name: '参考', exact: true }).click()
await page.waitForTimeout(400)
check('E15 资料角色改为参考并落库', (await docById('n-pending')).matter_role === 'reference')
await page.locator('div.w-32').getByRole('combobox').click()
await page.getByRole('option', { name: '比赛事务（改）', exact: true }).click()
await page.waitForTimeout(400)
let np = await docById('n-pending')
check('E16 便签换组：新事项 note_ids 加入、旧事项摘除（双向一致）', np.matter_id === newMatter.id && (await docById(newMatter.id)).note_ids.includes('n-pending') && !(await docById('m-course')).note_ids.includes('n-pending'))
check('E17 换组不继承旧角色（契约：角色须重新指定）', np.matter_role === null)
await shot('fix_note_matter_role')
await page.locator('div.w-32').getByRole('combobox').click()
await page.getByRole('option', { name: '课程事务', exact: true }).click()
await page.waitForTimeout(400)
await page.locator('div.w-28').getByRole('combobox').click()
await page.getByRole('option', { name: '要求', exact: true }).click()
await page.waitForTimeout(400)
np = await docById('n-pending')
check('E18 归回课程事务并重设角色，双向引用一致', np.matter_id === 'm-course' && np.matter_role === 'requirement' && (await docById('m-course')).note_ids.includes('n-pending') && !(await docById(newMatter.id)).note_ids.includes('n-pending'))
// 删事项（P04）：只解除归组，成员本体保留（事项管理在资料库）
await page.goto('http://127.0.0.1:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.locator('text=资料库 · 6 / 6 份').waitFor({ timeout: 15000 })
await openMatters()
const matterRow2 = () => page.locator('div.rounded-md.border.p-2').filter({ hasText: '比赛事务（改）' })
await matterRow2().locator('button[aria-label="删除事项"]').click()
await dialog().waitFor()
dlgTxt = await dialog().innerText()
check('E19 删事项确认框说明只解除归组（0 便签 / 1 任务）', dlgTxt.includes('0 张便签回到未归组') && dlgTxt.includes('1 个任务解除事项关联') && dlgTxt.includes('任务本体与截止保留'))
await shot('fix_delete_matter_dialog')
await dialog().getByRole('button', { name: '删除事项（保留成员）' }).click()
await page.locator('text=事项已删除；1 个成员回到未归组').waitFor({ timeout: 15000 })
check('E20 删事项后成员回未归组且本体保留', (await docById(newMatter.id)) === null && (await docById(newTask.id)).matter_id === null)
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.locator('text=逾期任务 · 1').waitFor({ timeout: 15000 })
await page.getByRole('button', { name: /稍后 \/ 已完成/ }).click()
await taskRow2().locator('button[aria-label="删除任务"]').click()
await dialog().getByRole('button', { name: '删除任务', exact: true }).click()
await page.locator('text=任务已删除').waitFor({ timeout: 15000 })
check('E21 删除任务（确认后）', (await docById(newTask.id)) === null)
await openRecover()
await page.locator('#recover').getByRole('button', { name: '恢复', exact: true }).click()
await page.locator('text=任务与其行动已恢复').waitFor({ timeout: 15000 })
check('E22 撤销恢复任务', !!(await docById(newTask.id)))
await shot('fix_today_matters_final')

// —— F. allow-time 主动改时间保留秒与偏移 ——
await page.goto('http://127.0.0.1:5175/#/notes/n-sec', { waitUntil: 'domcontentloaded' })
const dlCard = page.locator('div.rounded-md.border').filter({ hasText: '截止时间' }).first()
await dlCard.waitFor({ timeout: 15000 })
await dlCard.getByRole('button', { name: '编辑' }).click()
await dlCard.locator('button:has(svg.lucide-calendar-days)').click()
const timeInput = page.locator('input[type="time"]')
await timeInput.waitFor()
await timeInput.fill('09:05')
await page.waitForTimeout(200)
await page.keyboard.press('Escape')
await dlCard.getByRole('button', { name: '保存修改' }).click()
await page.waitForTimeout(500)
const secNote = await docById('n-sec')
const secVal = secNote.fields.find((f) => f.key === 'deadline').value
check('F1 改时间后秒与偏移保留（期望 2026-11-19T09:05:30+08:00）', secVal === '2026-11-19T09:05:30+08:00')
console.log('F1 actual value:', secVal)

// —— G. 刷新恢复（真实 IndexedDB）——
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.locator('text=逾期·交实验报告（用户改）').waitFor({ timeout: 15000 })
await page.getByRole('button', { name: /稍后 \/ 已完成/ }).click()
await page.locator('text=新任务·买道具（改）').waitFor({ timeout: 15000 })
txt = await page.locator('main').innerText()
const g1Tasks = txt.includes('新任务·买道具（改）') && txt.includes('今日·提交报名表')
await page.goto('http://127.0.0.1:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.locator('text=资料库 · 6 / 6 份').waitFor({ timeout: 15000 })
await openMatters()
txt = await page.locator('main').innerText()
check('G1 刷新后任务/事项状态恢复', g1Tasks && txt.includes('课程事务') && txt.includes('比赛旧分组'))
check('G2 刷新后便签仍在（含恢复过的）', !!(await docById('n-pending')) && !!(await docById('n-sec')) && !!(await docById('n-confirmed')))

// —— J. 重复点击稳定性 ——
// 冲突演练任务无截止且未归组，只在日程列表「稍后/已完成」分区渲染（资料库无任务列表）。
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.getByRole('button', { name: /稍后 \/ 已完成/ }).click()
const repeatRow = page.locator('div.rounded-md.border.p-3').filter({ hasText: '冲突演练·用户新版本' })
await repeatRow.getByRole('button', { name: '完成' }).dblclick()
await page.waitForTimeout(500)
check('J1 重复点击完成：状态幂等落库，无运行时错误', (await docById('t-conflict')).status === 'done')
await page.goto('http://127.0.0.1:5175/#/notes', { waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: /待核对 · 4/ }).waitFor({ timeout: 15000 })
await page.getByRole('button', { name: /待核对 · 4/ }).dblclick()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /待核对 · 4/ }).dblclick()
await page.waitForTimeout(300)
check('J2 重复折叠/展开分组稳定', await page.getByRole('button', { name: /宣讲会报名通知/ }).first().isVisible())

// —— H. 移动端 390x844 无横向溢出 ——
await page.setViewportSize({ width: 390, height: 844 })
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await page.waitForTimeout(400)
let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
check('H1 今天页周视图移动端无横向溢出', overflow <= 1)
await shot('fix_mobile_today')
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.locator('text=逾期任务 · 1').waitFor({ timeout: 15000 })
overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
check('H1b 今天页列表视图移动端无横向溢出', overflow <= 1)
await page.goto('http://127.0.0.1:5175/#/notes/n-pending', { waitUntil: 'domcontentloaded' })
await page.locator('div.text-base.font-semibold', { hasText: '宣讲会报名通知' }).first().waitFor({ timeout: 15000 })
overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
check('H2 核对页移动端无横向溢出', overflow <= 1)
await shot('fix_mobile_notes')
await page.goto('http://127.0.0.1:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.locator('text=资料库 · 6 / 6 份').waitFor({ timeout: 15000 })
overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
check('H3 资料库页移动端无横向溢出', overflow <= 1)
await shot('fix_mobile_collect')
await page.setViewportSize({ width: 1280, height: 800 })

// —— I. 受控时钟跨北京午夜（不真实挂机）——
const D0 = bjToday()
const D1 = bjAddDays(D0, 1)
const D3 = bjAddDays(D0, 3)
const clockPage = await ctx.newPage()
clockPage.on('pageerror', (e) => { pageErrors.push('clock:' + e.message); console.log('PAGEERROR(clock)', e.message) })
await clockPage.addInitScript(() => {
  const RealDate = Date
  const realNow = RealDate.now()
  const bj = new RealDate(realNow + 8 * 3600000)
  const dayStart = RealDate.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate())
  // 把页面时钟拨到当天北京 23:59:57，3 秒后自然跨过 00:00（受控，不挂机）
  let offset = dayStart + (23 * 3600 + 59 * 60 + 57) * 1000 - 8 * 3600000 - realNow
  window.__addClockOffset = (ms) => { offset += ms }
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset) }
    static now() { return RealDate.now() + offset }
  }
  window.Date = FakeDate
})
await clockPage.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
// 桌面列与手机日期条的卡片都在 DOM 中（手机侧 md:hidden），取首个可见匹配。
await clockPage.locator('text=今日·提交报名表').first().waitFor({ timeout: 15000 })
await clockPage.getByRole('button', { name: '列表', exact: true }).click()
let clockTxt = await clockPage.locator('main').innerText()
check('I1 跨午夜前：今天标签为当天，今日任务在当日区', clockTxt.includes(cnLabel(D0)) && clockTxt.includes('今日任务 · 1'))
await shot('fix_midnight_before', clockPage)
await clockPage.waitForTimeout(5000)
clockTxt = await clockPage.locator('main').innerText()
check('I2 受控时钟跨过 00:00：今天标签自动滚到次日', clockTxt.includes(cnLabel(D1)))
check('I3 跨午夜后：昨日到期任务转入逾期区', clockTxt.includes('逾期任务 · 2') && clockTxt.includes('今日任务 · 0'))
await shot('fix_midnight_after', clockPage)
// 日期快捷键按新的北京今天（新建面板按需展开）
await clockPage.getByRole('button', { name: '新建', exact: true }).click()
await clockPage.locator('button', { hasText: '截止（可选）' }).first().click()
const quickToday = clockPage.locator('div.z-50').getByRole('button', { name: '今天', exact: true })
await quickToday.waitFor()
const dlTrigger0 = clockPage.locator('div.flex.flex-wrap.items-center.gap-2').filter({ has: clockPage.getByLabel('新任务名称') }).locator('button:has(svg.lucide-calendar-days)')
const hintTxt = (await dlTrigger0.innerText()) + (await clockPage.locator('div.z-50').innerText())
const todayCell = await clockPage.locator(`div.z-50 button[aria-current="date"][aria-label="${D1}"]`).count()
check('I4 日历空值提示与快捷按钮按次日北京今天', hintTxt.includes(D1) && todayCell === 1)
await quickToday.click()
await clockPage.waitForTimeout(300)
const dlTrigger = clockPage.locator('div.flex.flex-wrap.items-center.gap-2').filter({ has: clockPage.getByLabel('新任务名称') }).locator('button:has(svg.lucide-calendar-days)')
check('I5 「今天」快捷写入次日日期', (await dlTrigger.innerText()).includes(cnLabel(D1)))
await clockPage.keyboard.press('Escape')
// 恢复前台校准：再拨快 2 天后触发 visibilitychange，无需等定时器
await clockPage.bringToFront()
await clockPage.evaluate(() => {
  window.__addClockOffset(2 * 86400000)
  document.dispatchEvent(new Event('visibilitychange'))
})
await clockPage.waitForTimeout(500)
clockTxt = await clockPage.locator('main').innerText()
check('I6 恢复前台校准：标签立即对齐拨快后的北京日期', clockTxt.includes(cnLabel(D3)))
await shot('fix_midnight_calibration', clockPage)
await clockPage.close()

await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
await page.evaluate(() => window.scrollTo(0, 0))
await shot('fix_final_today')
check('Z1 全程 0 页面运行时错误', pageErrors.length === 0)
console.log(`\nRESULT: ${pass} passed, ${failures.length} failed`)
if (failures.length) console.log('FAILED ITEMS:\n- ' + failures.join('\n- '))
fs.writeFileSync(`${OUT}/acceptance_result.txt`, `pass=${pass} fail=${failures.length}\n` + (failures.length ? 'FAILED:\n- ' + failures.join('\n- ') + '\n' : 'ALL PASS\n') + `pageErrors=${pageErrors.length}\n`)
await browser.close()
console.log('LEFT OPEN for human review')
process.exit(failures.length ? 1 : 0)