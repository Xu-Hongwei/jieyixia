// real13 收尾：不重调模型，直接读已落库的 13 图结果做队列/搜索/刷新复核并写汇总。
import { chromium } from 'playwright-core'
import fs from 'node:fs'
const OUT = 'E:/qoder/devlog/private-evidence/real13'
const MS = { 'QQ群宣讲会.png': 12923, '专业实践.png': 17357, '党课培训.png': 20782, '奖学金申报.png': 19390, '实验室.jpg': 9839, '宿舍.jpg': 14343, '差旅报销.jpg': 11129, '开题报告.png': 16692, '放假安排.png': 19229, '竞赛通知.png': 18448, '课程报告1.jpg': 11982, '课程报告2.jpg': 8121, '课程报告3.jpg': 10611 }

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
const readAll = () => page.evaluate(() => new Promise((resolve, reject) => {
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

await page.goto('http://localhost:5175/#/notes', { waitUntil: 'domcontentloaded' })
await page.getByText('资料队列', { exact: true }).waitFor({ timeout: 15000 })
const queueText = await page.locator('main').innerText()
const counts = (queueText.match(/(待核对|失败|已确认) · \d+/g) || []).join(' / ')
console.log('QUEUE', counts)
await shot('real13_90_queue')
await page.goto('http://localhost:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.getByLabel('搜索收集箱').fill('课程报告')
await page.waitForTimeout(400)
const searchHeader = await page.locator('text=/收集箱 · \\d+ \\/ \\d+ 份/').innerText()
console.log('SEARCH 课程报告 →', searchHeader)
await shot('real13_91_search')
await page.getByLabel('搜索收集箱').fill('')
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=收集箱 · 13 / 13 份').waitFor({ timeout: 15000 })
const after = await readAll()
console.log('AFTER RELOAD sources=', after.sources.length, 'notes=', after.docs.filter((d) => d.kind === 'note').length)
await shot('real13_92_after_reload')
await page.goto('http://localhost:5175/#/today', { waitUntil: 'domcontentloaded' })
await page.locator('text=（北京时间）').waitFor({ timeout: 15000 })
await shot('real13_93_today')

const results = after.sources.filter((s) => s.kind === 'image').sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((s, i) => {
  const note = after.docs.find((d) => d.kind === 'note' && d.source_id === s.id)
  return {
    idx: i + 1, name: s.name, ms: MS[s.name] || null,
    noteId: note ? note.id : null, noteStatus: note ? note.status : null, noteTitle: note ? note.title : null,
    fields: note ? note.fields.map((f) => ({ key: f.key, status: f.status, value: f.key === 'time_nodes' && Array.isArray(f.value) ? f.value.map((n) => ({ label: n.label, value: n.value, basis: n.basis, role: n.role })) : f.value, precision: f.precision || undefined, derived: f.derived || undefined })) : [],
    warnings: note ? (note.warnings || []).map((w) => w.code) : [],
  }
})
const okCount = results.filter((r) => r.noteStatus === 'draft' && r.fields.length > 0).length
const failedCount = results.filter((r) => r.noteStatus === 'failed').length
fs.writeFileSync(`${OUT}/real13_results.json`, JSON.stringify({ total: results.length, draftWithFields: okCount, failed: failedCount, pageErrors, results }, null, 2))
const lines = results.map((r) => `${String(r.idx).padStart(2, '0')} ${r.name} | ${r.ms}ms | ${r.noteStatus || 'NO-NOTE'} | fields=${r.fields.length} | warnings=[${r.warnings}]`)
fs.writeFileSync(`${OUT}/real13_summary.txt`, `total=${results.length} draft=${okCount} failed=${failedCount} pageErrors=${pageErrors.length}\nQUEUE ${counts}\nSEARCH 课程报告 → ${searchHeader}\nAFTER RELOAD sources=${after.sources.length} notes=${after.docs.filter((d) => d.kind === 'note').length}\n\n` + lines.join('\n') + '\n')
console.log(`\nRESULT total=${results.length} draft=${okCount} failed=${failedCount} pageErrors=${pageErrors.length}`)
await browser.close()
console.log('LEFT OPEN for human review')