// 清理本轮 polish 验证产生的scratch记录（仅 text 来源且 text 以 "polish " 开头者及其便签）。
// 不触碰用户真实截图（QQ群宣讲会.png）与预置演示数据。
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('localhost:5175')) || ctx.pages()[0]
const removed = await page.evaluate(async () => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('jxl-product', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const all = (db, store) => new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
  const db = await open()
  const sources = await all(db, 'sources')
  const docs = await all(db, 'docs')
  const scratchSrc = sources.filter((s) => s.kind === 'text' && String(s.text || '').startsWith('polish '))
  const ids = new Set(scratchSrc.map((s) => s.id))
  const scratchNotes = docs.filter((d) => d.kind === 'note' && ids.has(d.source_id))
  await new Promise((res, rej) => {
    const t = db.transaction(['sources', 'docs'], 'readwrite')
    for (const s of scratchSrc) t.objectStore('sources').delete(s.id)
    for (const n of scratchNotes) t.objectStore('docs').delete(n.id)
    t.oncomplete = res; t.onerror = () => rej(t.error)
  })
  db.close()
  return { sources: scratchSrc.length, notes: scratchNotes.length }
})
console.log('REMOVED scratch:', JSON.stringify(removed))
await page.reload({ waitUntil: 'domcontentloaded' })
await browser.close()
console.log('CLEANUP done, window left open')