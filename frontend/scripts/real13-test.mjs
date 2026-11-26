// 真实 13 图重测：清空浏览器本地库 → 逐张上传 samples/real 走真实模型 AI 整理 →
// 记录每张落库结果/耗时/截图 → 队列分组/搜索/刷新复核。结束后窗口留开供人工核对。
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const OUT = 'E:/qoder/devlog/private-evidence/real13'
const DIR = 'E:/qoder/samples/real'
fs.mkdirSync(OUT, { recursive: true })
const files = fs.readdirSync(DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
console.log('FILES', files.length, files.join(' | '))

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('5175')) || ctx.pages()[0]
const pageErrors = []
page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message) })
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

await page.setViewportSize({ width: 1280, height: 800 })
await page.goto('http://localhost:5175/#/collect', { waitUntil: 'domcontentloaded' })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('aside').first().waitFor({ timeout: 15000 })

// —— 清库（用户明确要求）：清空 sources/docs，保留工作区定义；清 UI 暂存键 ——
await page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('jxl-product', 2)
  req.onsuccess = () => {
    const db = req.result
    const t = db.transaction(['sources', 'docs'], 'readwrite')
    t.objectStore('sources').clear()
    t.objectStore('docs').clear()
    t.oncomplete = () => { db.close(); resolve() }
    t.onerror = () => reject(t.error)
  }
  req.onerror = () => reject(req.error)
}))
await page.evaluate(() => {
  localStorage.setItem('jxl-workspace', 'personal')
  for (const k of Object.keys(localStorage)) if (k.startsWith('jxl-ui-') || k.startsWith('jxl-pending-')) localStorage.removeItem(k)
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.locator('text=收集箱还是空的').waitFor({ timeout: 15000 })
const empty = await readAll()
console.log('CLEANED sources=', empty.sources.length, 'docs=', empty.docs.length)
await shot('real13_00_clean_empty')

// —— 逐张真实模型分析 ——
const results = []
for (let i = 0; i < files.length; i++) {
  const name = files[i]
  const path = `${DIR}/${name}`
  await page.goto('http://localhost:5175/#/collect', { waitUntil: 'domcontentloaded' })
  await page.locator('text=收集原始资料').waitFor({ timeout: 15000 })
  await page.setInputFiles('input[type="file"]', path)
  await page.locator(`text=待处理：${name}`).waitFor({ timeout: 15000 })
  const t0 = Date.now()
  await page.getByRole('button', { name: 'AI 整理', exact: true }).first().click()
  let outcome = 'ok'
  try {
    await page.waitForURL('**/#/notes/**', { timeout: 150000 })
  } catch {
    outcome = 'no-navigation'
  }
  const ms = Date.now() - t0
  await page.waitForTimeout(800)
  const all = await readAll()
  const source = all.sources.find((s) => s.name === name)
  const note = source ? all.docs.find((d) => d.kind === 'note' && d.source_id === source.id) : null
  const banner = await page.locator('body').innerText().then((t) => (t.match(/网络错误[^\n]*|模型不可用[^\n]*|422[^\n]*|保存失败[^\n]*|意外状态[^\n]*/) || [''])[0])
  const rec = {
    idx: i + 1, name, ms, outcome,
    sourceSaved: !!source,
    noteId: note ? note.id : null,
    noteStatus: note ? note.status : null,
    noteTitle: note ? note.title : null,
    fields: note ? note.fields.map((f) => ({ key: f.key, status: f.status, value: f.key === 'time_nodes' ? (Array.isArray(f.value) ? f.value.map((n) => ({ label: n.label, value: n.value, basis: n.basis, role: n.role })) : f.value) : f.value, precision: f.precision || undefined, derived: f.derived || undefined })) : [],
    warnings: note ? (note.warnings || []).map((w) => w.code) : [],
    banner: banner || '',
  }
  results.push(rec)
  console.log(`IMG ${i + 1}/13 ${name} ${ms}ms status=${rec.noteStatus} fields=${rec.fields.length} warnings=[${rec.warnings}] ${rec.banner}`)
  const safe = String(i + 1).padStart(2, '0')
  await shot(`real13_${safe}_note`)
}

// —— 汇总复核：队列分组 / 搜索 / 刷新持久化 ——
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

const okCount = results.filter((r) => r.noteStatus === 'draft' && r.fields.length > 0).length
const failedCount = results.filter((r) => r.noteStatus === 'failed').length
const summary = {
  total: files.length, draftWithFields: okCount, failed: failedCount,
  noNote: results.filter((r) => !r.noteId).map((r) => r.name),
  pageErrors, results,
}
fs.writeFileSync(`${OUT}/real13_results.json`, JSON.stringify(summary, null, 2))
const lines = results.map((r) => `${String(r.idx).padStart(2, '0')} ${r.name} | ${r.ms}ms | ${r.noteStatus || 'NO-NOTE'} | fields=${r.fields.length} | warnings=[${r.warnings}] ${r.banner}`)
fs.writeFileSync(`${OUT}/real13_summary.txt`, `total=${files.length} draft=${okCount} failed=${failedCount} pageErrors=${pageErrors.length}\nQUEUE ${counts}\nSEARCH 课程报告 → ${searchHeader}\nAFTER RELOAD sources=${after.sources.length} notes=${after.docs.filter((d) => d.kind === 'note').length}\n\n` + lines.join('\n') + '\n')
console.log(`\nRESULT total=${files.length} draft=${okCount} failed=${failedCount} pageErrors=${pageErrors.length}`)
await browser.close()
console.log('LEFT OPEN for human review')