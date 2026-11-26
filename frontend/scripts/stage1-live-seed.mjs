// 连接到已打开的可见 Edge（CDP 9222），预置可信演示数据并验证主流程，最后保持窗口打开供人工操作。
import { chromium } from 'playwright-core'
import fs from 'node:fs'
const OUT = 'E:/qoder/devlog/private-evidence/stage1'
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const bjToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find((p) => p.url().includes('localhost:5175')) || ctx.pages()[0]
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
const shot = async (name) => {
  try {
    await page.bringToFront()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', caret: 'hide', timeout: 20000 })
    console.log('SHOT', name)
  } catch (e) {
    console.log('SHOT-SKIP', name, e.message.split('\n')[0])
  }
}

await page.goto('http://localhost:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('aside [role="tab"][title="个人空间"]').waitFor({ timeout: 15000 })

// 预置：personal 一条可重分析的便签(source=src-01 图片桩) + 逾期/未来任务；demo 独立数据。
await page.evaluate(async ({ png, today }) => {
  const bin = atob(png)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'image/png' })
  const recs = [
    { id: 'src-01', kind: 'image', workspace_id: 'personal', name: '课程作业截图.png', captured_at: '2026-11-18T09:00:00+08:00', blob },
    { id: 'p-note-1', kind: 'note', workspace_id: 'personal', source_id: 'src-01', title: '机器学习课程作业', status: 'draft', content_type: 'notice',
      fields: [{ key: 'title', value: '机器学习课程作业', status: 'candidate', origin: 'model' }], warnings: [] },
    { id: 'p-task-overdue', kind: 'task', workspace_id: 'personal', title: '个人·逾期任务', status: 'todo', note_ids: [],
      deadline: { value: '2026-11-10', precision: 'date', source: 'manual', confirmed_at: '2026-11-09T09:00:00+08:00' } },
    { id: 'p-task-future', kind: 'task', workspace_id: 'personal', title: '个人·未来任务', status: 'todo', note_ids: [],
      deadline: { value: '2026-12-05', precision: 'date', source: 'manual', confirmed_at: '2026-11-18T09:00:00+08:00' } },
    { id: 'd-note-1', kind: 'note', workspace_id: 'demo', title: '演示·示例通知', status: 'draft', content_type: 'notice',
      fields: [{ key: 'title', value: '演示·示例通知', status: 'confirmed', origin: 'model' }], warnings: [] },
    { id: 'd-task-1', kind: 'task', workspace_id: 'demo', title: '演示·示例任务', status: 'todo', note_ids: [],
      deadline: { value: '2026-12-05', precision: 'date', source: 'manual', confirmed_at: '2026-11-18T09:00:00+08:00' } },
  ]
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', 2)
    req.onupgradeneeded = () => { const db = req.result; for (const s of ['sources', 'docs', 'workspaces']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }) }
    req.onsuccess = () => {
      const db = req.result
      const t = db.transaction(['sources', 'docs', 'workspaces'], 'readwrite')
      for (const r of recs) t.objectStore(r.kind === 'image' ? 'sources' : 'docs').put(r)
      t.objectStore('workspaces').put({ id: 'personal', name: '个人空间', is_demo: false, created_at: '2026-11-18T09:00:00+08:00' })
      t.objectStore('workspaces').put({ id: 'demo', name: '演示空间', is_demo: true, created_at: '2026-11-18T09:00:00+08:00' })
      t.oncomplete = () => { db.close(); resolve() }
      t.onerror = () => reject(t.error)
    }
    req.onerror = () => reject(req.error)
  })
}, { png: PNG_1x1, today: bjToday() })

await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=个人·逾期任务').waitFor({ timeout: 15000 })
console.log('SEEDED today populated')
await shot('live_today_populated')

// 主流程：便签 → 重新分析(fixture) → 确认截止 → 创建任务 → 今天
await page.goto('http://localhost:5175/#/notes/p-note-1', { waitUntil: 'domcontentloaded' })
await page.locator('text=机器学习课程作业').first().waitFor({ timeout: 15000 })
await page.getByRole('button', { name: '重新分析' }).click()
await page.locator('div.rounded-lg.border').filter({ hasText: '截止时间' }).first().waitFor({ timeout: 15000 })
console.log('REANALYZE fixture fields rendered')
await shot('live_note_fields')
const dlCard = page.locator('div.rounded-lg.border').filter({ hasText: '截止时间' }).first()
await dlCard.getByRole('button', { name: '确认' }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '创建任务', exact: true }).click()
await page.waitForTimeout(600)
await page.locator('text=今天 · 任务').waitFor({ timeout: 15000 })
const todayText = await page.locator('main').innerText()
console.log('TASK created, today contains 机器学习课程作业:', todayText.includes('机器学习课程作业'))
await shot('live_today_after_task')

// 保持窗口打开供人工操作；仅断开 CDP 连接，不关闭浏览器。
await browser.close()
console.log('LEFT OPEN for human operation')