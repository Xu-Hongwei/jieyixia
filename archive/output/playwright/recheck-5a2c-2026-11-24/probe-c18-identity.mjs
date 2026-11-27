// 5A-2C C14–C18：离线闭环 / 北京时间跨日+外国时区 / 多空间互斥+晚到结果+离开保护 / 草稿路由恢复冲突 / 遗留兼容。
// 数据分支：每场景独立 Context（独立 IndexedDB），种子 = C01 真实页面生成的 c01-docs-snapshot.json
//（测试辅助写库复制，披露）。C18 遗留 v0/v1/异常/moved 样本为披露的夹具写库（正常链路不产生这些形态）。
// C15 用 page.clock.install 受控时钟（全部标注「模拟」）；跨午夜大跳用 fastForward，计时用 advance 分段推进。
// C16 晚到外部结束用测试辅助写库 + 真实 window focus 事件触发页面协调刷新（披露）。
// 运行：node E:/qoder/devlog/private-evidence/stage5a-2c/c14-anomaly.mjs（需自启 [::1]:5174 Vite）
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const OUT = dirname(fileURLToPath(import.meta.url))
const ZIPDIR = join(OUT, 'zip')
mkdirSync(ZIPDIR, { recursive: true })
const BASE = 'http://[::1]:5184/'
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const SEED = JSON.parse(readFileSync(join(OUT, 'c01-docs-snapshot.json'), 'utf8'))
const INV = JSON.parse(readFileSync(join(OUT, 'c01-inventory.json'), 'utf8'))
const K = INV.keyIds
const D = INV.baseDate; const D1 = INV.D1; const D2 = INV.D2
const E1 = INV.sessions[1].id // 已结束 v1（P1 第一段）
const PAUSED_ZIP = readFileSync(join(ZIPDIR, 'paused-source.zip'))
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const TEXT = '虚构资料：报告素材清单——进展数据、风险列表、下一步计划。'
const sha = (b) => createHash('sha256').update(b).digest('hex')
const now = () => new Date().toISOString()

// 北京日界（node 侧独立计算，不复用被测 time.js）
const BJ = 8 * 3600 * 1000
const bjStr = (ms) => { const d = new Date(ms + BJ); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` }
const bjStart = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) - BJ }
const bjLabel = (s) => { const [y, m, d] = s.split('-').map(Number); return `${y}年${m}月${d}日` }
const D_REAL = bjStr(Date.now()) // 执行日北京日期（不硬编码）

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true })
let offlineNow = false
const reqLog = []
const failLog = []

async function fresh(mutate = null, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, timezoneId: opts.tz })
  await context.route('**/api/healthz', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', model_ready: true, version: '0.4.0' }) }))
  await context.route('**/api/analyze', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'model_unavailable', message: '拦截' }) }))
  if (opts.reqLog) {
    context.on('request', (q) => reqLog.push({ url: q.url(), method: q.method(), offline: offlineNow, t: Date.now() }))
    context.on('requestfailed', (q) => failLog.push({ url: q.url(), err: q.failure() && q.failure().errorText, offline: offlineNow }))
  }
  const page = await context.newPage()
  await page.addInitScript(() => { window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p })
  if (opts.clockMs != null) await page.clock.install({ time: new Date(opts.clockMs) })
  page.on('pageerror', (e) => rec('C14-18', '页面JS错误', false, e.message))
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  let docs = JSON.parse(JSON.stringify(SEED))
  if (mutate) docs = mutate(docs)
  await page.evaluate(async ([docs, pngB64, textSourceId, imgSourceId, text]) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    const ts = new Date().toISOString()
    await db.putSource({ id: textSourceId, kind: 'text', captured_at: ts, text })
    const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0))
    await db.putSource({ id: imgSourceId, kind: 'image', captured_at: ts, blob: new Blob([bytes], { type: 'image/png' }), name: 'fixture-test-image.png' })
    for (const d of docs) await db.putDoc(d)
  }, [docs, PNG_B64, K.textSource, K.imgSource, TEXT])
  if (opts.runtime) {
    await page.evaluate(async (recs) => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('jxl-product'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      await new Promise((res, rej) => {
        const tx = db.transaction('focus_runtime', 'readwrite')
        for (const x of recs) tx.objectStore('focus_runtime').put(x)
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error)
      })
      db.close()
    }, opts.runtime)
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  return { context, page }
}
const readDocs = (page) => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  return (await db.allDocs()).records
})
const docsKey = async (page) => JSON.stringify((await readDocs(page)).slice().sort((a, b) => a.id < b.id ? -1 : 1))
const docOf = async (page, id) => (await readDocs(page)).find((d) => d.id === id) || null
const putDoc = (page, doc) => page.evaluate(async (d) => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  await db.putDoc(d)
}, doc)
const rtAll = (page) => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  return (await db.allFocusRuntime()).records
})
const snapOf = (page, ws) => page.evaluate(async (w) => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  const s = await db.readWorkspaceSnapshot(w)
  return { docs: s.docs, sources: s.sources.map((x) => ({ id: x.id, kind: x.kind })) }
}, ws)
const dlg = (page) => page.locator('[role="dialog"]')
const adlg = (page) => page.locator('[role="alertdialog"]')
// 测试辅助导航：走应用真实 router.push（非 location.hash 直写）。
// 原因：裸 hash 写入的历史条目无 vue-router state，popstate 被当作 replace（delta=0），
// 离开守卫取消后无法恢复 URL——那是驱动假象，不是产品行为。真实用户点击均带 state。
const goto = async (page, hash) => {
  await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, { timeout: 10000 })
  await page.evaluate((h) => {
    const router = document.querySelector('#app').__vue_app__.config.globalProperties.$router
    void router.push(h.replace(/^#/, ''))
  }, hash)
  await page.waitForTimeout(700)
}
const hashOf = (page) => page.evaluate(() => location.hash)
const switchWs = async (page, id) => {
  await page.locator('select[aria-label="切换工作区"]').first().selectOption(id)
  await page.waitForTimeout(1200)
}
const wsOf = (page) => page.evaluate(() => localStorage.getItem('jxl-workspace'))
async function until(fn, timeout = 12000, step = 150) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('until timeout')
    await new Promise((r) => setTimeout(r, step))
  }
}
// 受控时钟分段推进（每段间留真实间隙，让真实 IDB 事务完成）——模拟时钟，披露。
async function advance(page, ms) {
  const steps = Math.ceil(ms / 1000)
  for (let i = 0; i < steps; i++) {
    await page.clock.runFor(Math.min(1000, ms - i * 1000))
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function createTask(page, title) {
  await goto(page, '#/today')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByLabel('新任务名称').fill(title)
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  await page.waitForTimeout(900)
  return (await readDocs(page)).find((d) => d.kind === 'task' && d.title === title) || null
}
async function addAction(page, taskId, text, minutes) {
  await goto(page, `#/tasks/${taskId}`)
  await page.getByLabel('新行动内容').fill(text)
  await page.getByLabel('预计分钟').fill(String(minutes))
  await page.getByRole('button', { name: '添加行动' }).click()
  await page.waitForTimeout(700)
  const t = await docOf(page, taskId)
  if (!t.current_action_id) {
    await page.getByRole('button', { name: '设为当前' }).first().click()
    await page.waitForTimeout(500)
  }
  return (await readDocs(page)).find((d) => d.kind === 'action' && d.task_id === taskId && d.text === text) || null
}
async function pickDate(page, label, date) {
  await page.locator(`button[aria-label="${label}"]`).click()
  await page.waitForTimeout(300)
  await page.locator(`button[aria-label="${date}"]`).click()
  await page.waitForTimeout(300)
}
async function createPlan(page, title, text, date, minutes) {
  await goto(page, '#/today')
  await page.getByRole('button', { name: '安排工作', exact: true }).click()
  await page.waitForTimeout(400)
  await page.locator('[aria-label="搜索任务"]').fill(title)
  await page.getByRole('button', { name: `选择任务：${title}` }).click()
  await pickDate(page, '安排日期', date)
  await page.locator('[aria-label="预计分钟"]').fill(String(minutes))
  await page.locator('[aria-label="工作说明"]').fill(text)
  await page.locator('button[type="submit"]', { hasText: '创建安排' }).click()
  await page.waitForSelector('button[type="submit"]', { state: 'detached', timeout: 8000 })
  const plans = (await readDocs(page)).filter((d) => d.kind === 'plan_item' && d.action_text === text)
  return plans[plans.length - 1] || null
}
async function startIndependent(page) {
  await goto(page, `#/tasks/${K.T}`)
  await page.getByRole('button', { name: '开始执行', exact: true }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await page.waitForTimeout(600)
  return (await readDocs(page)).find((d) => d.kind === 'focus_session' && d.ended_at == null) || null
}
async function startPlan(page, planId, date) {
  await goto(page, `#/today?date=${date}&plan=${planId}`)
  await page.getByRole('button', { name: '开始这项安排' }).waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '开始这项安排' }).click()
  await dlg(page).getByRole('button', { name: '确认并开始' }).waitFor({ timeout: 5000 })
  const boxes = dlg(page).locator('input[type="checkbox"]')
  for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
  await dlg(page).getByRole('button', { name: '确认并开始' }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await page.waitForTimeout(600)
}
async function endWork(page, { outcome = 'done', progress = '', blocker = '', text = '分支收尾成果。', waitEndedId = '' } = {}) {
  await page.getByLabel('本次成果正文').fill(text)
  if (waitEndedId) {
    // 草稿自动保存会推进修订：先等草稿真实落库再开结束框，避免「保存基线已过期」竞态
    const t0 = Date.now()
    for (;;) {
      const d = await docOf(page, waitEndedId)
      if (d && (d.draft_md || '').includes(text)) break
      if (Date.now() - t0 > 10000) break
      await advance(page, 400)
    }
  }
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg(page).locator(`input[name="work-outcome"][value="${outcome}"]`).check()
  if (outcome === 'blocked') await dlg(page).getByLabel('阻塞说明').fill(blocker)
  if (progress) await dlg(page).locator(`input[name="plan-progress"][value="${progress}"]`).check()
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  if (waitEndedId) {
    // 受控时钟下 waitForTimeout 不推进模拟时间：显式推进并轮询真实落库，避免结束事务竞态
    const t0 = Date.now()
    let retries = 0
    for (;;) {
      const d = await docOf(page, waitEndedId)
      if (d && d.ended_at != null) break
      if (Date.now() - t0 > 20000) {
        const dlgText = (await dlg(page).textContent().catch(() => '')) || ''
        throw new Error(`endWork: session ${waitEndedId} 未落库结束; dlg=${dlgText.slice(0, 300)}`)
      }
      // 产品规则：修订被推进时首次提交零写入拒绝，需用户再次显式点击（受控时钟下点击开销易触发）
      if (retries < 3 && (await dlg(page).getByText('保存基线已过期').count()) > 0) {
        retries++
        await dlg(page).getByRole('button', { name: '结束并保存' }).click()
      }
      await advance(page, 500)
    }
  } else {
    await page.waitForTimeout(1200)
  }
}
const setFile = (page, buf, name) => page.locator('input[type=file]').setInputFiles({ name: name || 'backup.zip', mimeType: 'application/zip', buffer: buf })
const jobInfo = (page) => page.evaluate(async () => {
  const m = await import(window.__mod('/src/services/backup/restore.js'))
  const j = m.restoreJob
  return { phase: j.phase, operationId: j.operationId, targetWorkspaceId: j.targetWorkspaceId, result: j.result, verifyProblems: j.verifyProblems, commitError: j.commitError, errors: j.errors, preview: j.preview }
})
async function waitPhase(page, ph, timeout = 25000) {
  const t0 = Date.now()
  for (;;) {
    const j = await jobInfo(page)
    if (j.phase === ph && (ph !== 'done' || j.result)) return j
    if (Date.now() - t0 > timeout) throw new Error(`waitPhase timeout: want=${ph} actual=${j.phase}`)
    await page.waitForTimeout(120)
  }
}
async function previewFile(page, buf, name) {
  await goto(page, '#/data')
  await setFile(page, buf, name)
  await waitPhase(page, 'preview')
  return jobInfo(page)
}
async function confirmRestore(page, name) {
  if (name != null) await page.locator('#restore-name').fill(name)
  await page.getByRole('button', { name: '恢复到新空间', exact: true }).click()
  await waitPhase(page, 'done')
  return jobInfo(page)
}
async function enterRestore(page) {
  await page.getByRole('button', { name: '进入恢复空间' }).click()
  await page.waitForTimeout(1500)
}
async function exportViaUI(page, savePath) {
  await goto(page, '#/data')
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 25000 }),
    page.getByRole('button', { name: '导出当前空间备份' }).click(),
  ])
  await dl.saveAs(savePath)
  const bytes = readFileSync(savePath)
  return { filename: dl.suggestedFilename(), bytes: bytes.length, sha256: sha(bytes) }
}
async function newPageB(context) {
  const p = await context.newPage()
  await p.addInitScript(() => { window.__mod = (p2) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p2)) || p2 })
  p.on('pageerror', (e) => rec('C14-18', '页面JS错误(B)', false, e.message))
  await p.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1300)
  return p
}
// 遗留结束（真实 UI 遗留面板）
async function legacyEnd(page, { outcome = 'partial', minutes = '5', progress = '', blocker = '' } = {}) {
  await page.getByText('旧版（v0）未结束会话').waitFor({ timeout: 8000 })
  await page.getByLabel(outcome === 'done' ? '完成' : outcome === 'partial' ? '部分完成' : '被阻塞', { exact: true }).check()
  if (outcome === 'blocked') await page.getByLabel('阻塞说明').fill(blocker)
  await page.getByLabel('确认累计（分钟）').fill(minutes)
  if (progress) await page.getByLabel(progress === 'done' ? '这项安排已完成（不代表完成任务）' : '还需要继续（安排保持部分完成）').check()
  await page.getByRole('button', { name: '显式结束遗留记录' }).click()
  await page.waitForTimeout(1200)
}
// v0/v1 夹具构造（披露：正常链路不产生这些形态）
const v0sess = (id, over = {}) => ({
  id, kind: 'focus_session', workspace_id: 'personal', task_id: K.T, action_id: K.A1, plan_item_id: null,
  started_at: `${D}T09:00:00+08:00`, accumulated_ms: 600000, running: false, draft_md: '遗留正文', outcome: null, blocker: null, ended_at: null, is_demo: false, ...over,
})
const v1from = (docs, id, over = {}) => {
  const proto = docs.find((d) => d.kind === 'focus_session' && d.record_version === 1)
  return { ...proto, id, ended_at: null, outcome: null, blocker: null, running: false, timer_anchor_at: null, ...over }
}
const planFrom = (docs, id, over = {}) => {
  const proto = docs.find((d) => d.id === K.P3)
  return { ...proto, id, actual_minutes: null, focus_session_id: null, ...over }
}
const sessRt = (sid, over = {}) => ({
  id: `sess:${sid}`, kind: 'session', session_id: sid, workspace_id: 'personal',
  owner_id: 'legacy-fixture-owner', epoch: 1, lease_expires_at: Date.now() - 1000,
  revision: 1, draft_seq: 0, last_checkpoint_at: Date.now() - 1000,
  recovery: null, ended: false, updated_at: Date.now() - 1000, ...over,
})

// 人工审查定向探针：不改变原驱动；按明确记录 ID 比较页面与存储，证实数组位置选错。
const chosen = SEED.find(d => d.id === E1)
const first = SEED.filter(d => d.kind === 'focus_session' && d.plan_item_id === K.P1 && d.ended_at != null).sort((a,b) => Date.parse(a.started_at)-Date.parse(b.started_at))[0]
if (!chosen || !first) throw new Error('Missing explicit record')
const { context, page } = await fresh()
for (const [label, record] of [['positional-selection', chosen], ['first-p1-segment', first]]) {
  const before = await docsKey(page)
  await goto(page, `#/work-records/${record.id}`)
  const body = await page.locator('main').innerText()
  rec('PROBE', `${label}: page displays exact stored body`, body.includes(record.draft_md), JSON.stringify({id:record.id, draft:record.draft_md}))
  rec('PROBE', `${label}: readonly marker`, body.includes('工作成果（只读）'), '')
  rec('PROBE', `${label}: no business write`, await docsKey(page) === before, '')
  await page.screenshot({path:join(OUT, `probe-c18-${label}.png`)})
}
rec('PROBE', 'positional record is second segment; first segment explicitly identified', chosen.id !== first.id && chosen.draft_md.includes('第二段成果') && first.draft_md.includes('第一段成果'), JSON.stringify({wrong:E1, first:first.id}))
await context.close()
await browser.close()
writeFileSync(join(OUT,'probe-c18-results.json'),JSON.stringify({at:now(),results},null,2))
console.log(`${results.filter(r=>r.pass).length}/${results.length} passed`)
process.exit(results.some(r=>!r.pass)?1:0)