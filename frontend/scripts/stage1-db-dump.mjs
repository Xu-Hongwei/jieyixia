import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:5175'))
const dump = await page.evaluate(async () => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('jxl-product', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const all = (db, s) => new Promise((res, rej) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
  const db = await open()
  const sources = (await all(db, 'sources')).map((s) => ({ id: s.id, kind: s.kind, name: s.name, ws: s.workspace_id, text: (s.text || '').slice(0, 20) }))
  const docs = (await all(db, 'docs')).map((d) => ({ id: d.id, kind: d.kind, title: d.title, src: d.source_id, ws: d.workspace_id, status: d.status }))
  db.close()
  return { sources, docs }
})
console.log(JSON.stringify(dump, null, 1))
await browser.close()
