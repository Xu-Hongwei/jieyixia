import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:5175'))
await page.goto('http://localhost:5175/#/notes', { waitUntil: 'domcontentloaded' })
await page.getByText('资料队列', { exact: true }).waitFor({ timeout: 15000 })
await page.bringToFront(); await page.waitForTimeout(300)
await page.screenshot({ path: 'E:/qoder/devlog/private-evidence/stage1/polish_final_queue.png', animations: 'disabled', timeout: 20000 })
console.log('QUEUE text:', (await page.locator('main').innerText()).slice(0, 300).replace(/\n/g, ' | '))
await browser.close()
