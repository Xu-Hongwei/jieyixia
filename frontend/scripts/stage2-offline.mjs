// 阶段2整改后断网验收（2026-11-19 新证据）：CDP 置 offline 后验证本地创建/删除/撤销/搜索仍可用，恢复网络后健康徽标回归。
// 视觉重构适配：新建/恢复入口按需展开；无截止任务在列表视图「稍后/已完成」分区操作。
// 导航整理适配：收集箱→资料库（搜索 aria-label 同步）。
// 2026-11-20 阶段3A适配：新建成功跳统一详情页（非浮层），返回原列表后再切列表视图。业务断言不变。
import { chromium } from 'playwright-core'
const OUT = 'E:/qoder/devlog/private-evidence/stage3a-2026-11-20/regression'
let pass = 0
const failures = []
const check = (name, cond) => { if (cond) { pass++; console.log('PASS', name) } else { failures.push(name); console.log('FAIL', name) } }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('5175')) || ctx.pages()[0]
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
const shot = async (name) => {
  try {
    await page.bringToFront(); await page.waitForTimeout(300)
    await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', caret: 'hide', timeout: 20000 })
    console.log('SHOT', name)
  } catch (e) { console.log('SHOT-SKIP', name, e.message.split('\n')[0]) }
}
const docByTitle = (title) => page.evaluate((t) => new Promise((res) => {
  const r = indexedDB.open('jxl-product', 2)
  r.onsuccess = () => {
    const db = r.result
    const q = db.transaction('docs', 'readonly').objectStore('docs').getAll()
    q.onsuccess = () => { db.close(); res(q.result.find((d) => d.title === t) || null) }
  }
}), title)

await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
// 清掉本脚本历史运行残留的同名验证任务（仅自建 scratch 数据）。
await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('jxl-product', 2)
  r.onsuccess = () => {
    const db = r.result
    const t = db.transaction('docs', 'readwrite')
    const q = t.objectStore('docs').getAll()
    q.onsuccess = () => { for (const d of q.result) if (d.title === '断网任务·本地验证') t.objectStore('docs').delete(d.id) }
    t.oncomplete = () => { db.close(); res() }
  }
}))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })

await ctx.setOffline(true)
// 断网后不刷新（dev 资源不可达属预期），验证已加载应用的本地能力与 AI 降级。
await page.getByRole('button', { name: '新建', exact: true }).click()
await page.getByLabel('新任务名称').fill('断网任务·本地验证')
await page.getByRole('button', { name: '新建任务' }).click()
await page.locator('text=任务已创建').waitFor({ timeout: 15000 })
check('O1 断网创建任务成功（纯本地）', !!(await docByTitle('断网任务·本地验证')))
// 3A：新建成功跳统一详情页：先返回原列表，再切列表视图操作。
await page.getByRole('button', { name: '返回原列表' }).waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '返回原列表' }).click()
await page.locator('text=按截止日查看').waitFor({ timeout: 15000 })
// 无截止任务在列表视图「稍后/已完成」分区；展开后再操作行。
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.getByRole('button', { name: /稍后 \/ 已完成/ }).click()
const row = page.locator('div.rounded-md.border.p-3').filter({ hasText: '断网任务·本地验证' })
await row.locator('button[aria-label="删除任务"]').click()
await page.getByRole('alertdialog').getByRole('button', { name: '删除任务', exact: true }).click()
await page.locator('text=任务已删除').waitFor({ timeout: 15000 })
check('O2 断网删除任务成功', (await docByTitle('断网任务·本地验证')) === null)
const recoverBtn = page.locator('#recover').getByRole('button', { name: /恢复入口/ })
if ((await recoverBtn.getAttribute('aria-expanded')) === 'false') await recoverBtn.click()
await page.locator('#recover').getByRole('button', { name: '恢复', exact: true }).click()
await page.locator('text=任务与其行动已恢复').waitFor({ timeout: 15000 })
check('O3 断网撤销恢复成功', !!(await docByTitle('断网任务·本地验证')))
await page.goto('http://127.0.0.1:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.getByLabel('搜索资料库').fill('道具集合')
await page.locator('text=资料库 · 1 / 6 份').waitFor({ timeout: 15000 })
check('O4 断网本地搜索可用', true)
await page.getByLabel('搜索资料库').fill('')
// 断网 AI 降级：两条合法路径——入口仍在则点击得网络错误横幅；健康检查已失败则入口隐藏+离线徽标。
const aiBtn = page.locator('div.rounded-md.border.p-3').filter({ hasText: '普通文字资料' }).getByRole('button', { name: 'AI 整理' })
if (await aiBtn.count()) {
  await aiBtn.click()
  await page.locator('text=网络错误').waitFor({ timeout: 20000 })
  check('O5 断网 AI 整理降级为网络错误横幅', (await page.locator('body').innerText()).includes('本地数据不受影响'))
} else {
  // 降级提示在展开的添加区内；先展开再断言。
  await page.getByLabel('添加文字资料').click()
  const header = await page.locator('header').innerText()
  const mainTxt = await page.locator('main').innerText()
  check('O5 断网 AI 入口隐藏+离线徽标（设计降级）', header.includes('后端不可达') && mainTxt.includes('AI 入口已隐藏'))
}
await shot('fix_offline_banner')
// 恢复网络：刷新后健康徽标回归，断网期间数据完整。
await ctx.setOffline(false)
await page.goto('http://127.0.0.1:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=模型就绪').waitFor({ timeout: 15000 })
check('O6 恢复网络后模型就绪徽标回归', true)
check('O7 断网期间创建的数据刷新后仍在', !!(await docByTitle('断网任务·本地验证')))
check('O8 全程 0 页面运行时错误', pageErrors.length === 0)
// 清理本脚本自建的验证任务，保持交回数据干净（列表视图「稍后/已完成」分区）。
await page.getByRole('button', { name: '列表', exact: true }).click()
await page.getByRole('button', { name: /稍后 \/ 已完成/ }).click()
const row2 = page.locator('div.rounded-md.border.p-3').filter({ hasText: '断网任务·本地验证' })
await row2.locator('button[aria-label="删除任务"]').click()
await page.getByRole('alertdialog').getByRole('button', { name: '删除任务', exact: true }).click()
await page.locator('text=任务已删除').waitFor({ timeout: 15000 })
await shot('fix_offline_recovered')
console.log(`\nOFFLINE RESULT: ${pass} passed, ${failures.length} failed`)
if (failures.length) console.log('FAILED:\n- ' + failures.join('\n- '))
await browser.close()
process.exit(failures.length ? 1 : 0)