// 验证三处 polish 在真浏览器生效：收集于北京时间 / 参照日期不截断 / 失败便签标题用资料身份。
// 通过真实收集→422 降级新建一条失败便签（旧持久化便签标题不变，故必须新建）。
import { chromium } from 'playwright-core'
const OUT = 'E:/qoder/devlog/private-evidence/stage1'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('localhost:5175')) || ctx.pages()[0]
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

const FIRST = 'polish 二次验证首行'
await page.goto('http://localhost:5175/#/collect', { waitUntil: 'domcontentloaded' })
// 长开页面经 HMR 可能残留旧 plain-JS 模块；整页重载确保跑当前代码。
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('textarea').waitFor({ timeout: 15000 })
await page.locator('textarea').fill(`${FIRST}\n第二行内容`)
// 先「仅保存文字」让新文本成为待处理来源（避免被既有待处理图片抢占）。
await page.getByRole('button', { name: '仅保存文字' }).click()
await page.waitForTimeout(400)
const pendingLine = await page.locator('div', { hasText: /^待处理：/ }).last().innerText()
console.log('PENDING line:', pendingLine, '| beijing:', pendingLine.includes('（北京时间）'))
await page.getByRole('button', { name: 'AI 整理' }).click()
try {
  await page.locator('div.text-base.font-semibold', { hasText: FIRST }).first().waitFor({ timeout: 15000 })
} catch (e) {
  console.log('DEBUG url:', page.url())
  console.log('DEBUG main:', (await page.locator('main').innerText()).slice(0, 600))
  console.log('DEBUG errors:', errors.join(' | '))
  await page.screenshot({ path: `${OUT}/polish_debug.png`, animations: 'disabled', timeout: 20000 }).catch(() => {})
  throw e
}
const titleText = await page.locator('div.text-base.font-semibold', { hasText: FIRST }).first().innerText()
console.log('TITLE node:', titleText, '| uses source identity:', titleText === FIRST)

const collected = await page.locator('p', { hasText: '收集于' }).first().innerText()
console.log('COLLECTED line:', collected)
console.log('COLLECTED beijing not raw ISO:', collected.includes('（北京时间）') && !/T\d{2}:\d{2}:\d{2}\.\d+Z/.test(collected))

const refSpan = page.locator('button span', { hasText: /^参照日期（可选） · 今天/ }).first()
await refSpan.waitFor({ timeout: 15000 })
const trunc = await refSpan.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent }))
console.log('REF hint:', trunc.text, '| not truncated:', trunc.sw <= trunc.cw)

await page.bringToFront()
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/polish_failed_note.png`, animations: 'disabled', caret: 'hide', timeout: 20000 })
console.log('PAGEERRORS:', errors.length, errors.join(' | '))
await browser.close()
console.log('LEFT OPEN for human operation')