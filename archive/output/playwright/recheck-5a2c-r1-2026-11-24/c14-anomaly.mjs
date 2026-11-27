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
const BASE = 'http://[::1]:5185/'
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const SEED = JSON.parse(readFileSync(join(OUT, 'c01-docs-snapshot.json'), 'utf8'))
const INV = JSON.parse(readFileSync(join(OUT, 'c01-inventory.json'), 'utf8'))
const K = INV.keyIds
const D = INV.baseDate; const D1 = INV.D1; const D2 = INV.D2
// R1（2026-11-24 人工复验）：按 C01 inventory 命名字段（started_at 排序）选择 P1 第一段，不猜数组位置——
// IDB getAll 按主键序返回，随机 UUID 不保证执行先后，sessions[1] 不一定是第一段。
if (!INV.p1Segments || !INV.p1Segments.first || !INV.p1Segments.second) throw new Error('c01-inventory.json 缺 p1Segments 命名字段，请先重跑 c01-baseline.mjs')
const E1 = INV.p1Segments.first.id // 已结束 v1（P1 第一段，命名字段）
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
  // R1 同类修正（2026-11-24）：原型固定取 C01 命名字段的第一段（Task/Action 有效、行动未完成）。
  // 不取主键序第一条 v1——新数据下可能命中行动已完成的会话，resume 会被产品正确拒绝（驱动假象）。
  const proto = docs.find((d) => d.id === INV.p1Segments.first.id)
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

try {
  // ============ C14 离线闭环（已加载应用断网；首次离线打开不在承诺内） ============
  {
    const { context, page } = await fresh(null, { reqLog: true })
    await context.unroute('**/api/healthz') // 断网后 healthz 不再被拦截兜底，真实失败可见
    offlineNow = true
    await context.setOffline(true)
    const t = await createTask(page, '离线闭环任务')
    rec('C14', '断网后手动新建任务落库', !!t, t && t.id)
    const a = await addAction(page, t.id, '离线行动', 20)
    rec('C14', '断网后手动添加行动', !!a, a && a.id)
    const P = await createPlan(page, '离线闭环任务', '离线日安排', D, 25)
    rec('C14', '断网后手动创建当日安排', !!P && P.date === D && P.state === 'planned', P && P.id)
    await startPlan(page, P.id, D)
    const s = (await readDocs(page)).find((d) => d.kind === 'focus_session' && d.ended_at == null)
    rec('C14', '断网后开始工作（真实计时）', !!s && s.running === true && s.plan_item_id === P.id, s && s.id)
    await page.getByLabel('本次成果正文').fill('离线成果：断网期间正文照常保存。')
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.waitForTimeout(900)
    const sp = await docOf(page, s.id)
    rec('C14', '断网暂停：running=false 正文保留', sp.running === false && sp.draft_md.includes('离线成果'), '')
    await page.getByRole('button', { name: '继续计时' }).click()
    await page.waitForTimeout(900)
    rec('C14', '断网继续计时', (await docOf(page, s.id)).running === true, '')
    await page.waitForTimeout(2000)
    await endWork(page, { outcome: 'partial', progress: 'partial', text: '离线成果：断网闭环完成。' })
    const se = await docOf(page, s.id)
    const Pe = await docOf(page, P.id)
    rec('C14', '断网结束并保存：成果/累计/安排联动落库', se.ended_at != null && se.outcome === 'partial' && se.accumulated_ms > 0 && Pe.state === 'partial', JSON.stringify({ ms: se.accumulated_ms, plan: Pe.state }))
    rec('C14', '结束后返回日程', (await hashOf(page)).startsWith('#/today'), await hashOf(page))
    const zipPath = join(ZIPDIR, 'offline-loop.zip')
    const ex = await exportViaUI(page, zipPath)
    rec('C14', '断网本地 ZIP 导出（真实下载）', ex.bytes > 0, `${ex.filename} ${ex.bytes}B sha256=${ex.sha256}`)
    const buf = readFileSync(zipPath)
    const pv = await previewFile(page, buf, 'offline-loop.zip')
    rec('C14', '断网恢复预览（零写入）', pv.phase === 'preview' && pv.preview.counts.focus_session >= 5, JSON.stringify(pv.preview.counts))
    const done = await confirmRestore(page, '离线恢复空间')
    rec('C14', '断网恢复到新空间成功', done.phase === 'done' && !!done.result && !done.result.alreadyCommitted, done.targetWorkspaceId)
    await enterRestore(page)
    const rdocs = await readDocs(page)
    const rP = rdocs.find((d) => d.kind === 'plan_item' && d.action_text === '离线日安排')
    const rS = rdocs.find((d) => d.kind === 'focus_session' && d.plan_item_id === (rP && rP.id))
    rec('C14', '离线恢复后引用/成果可用（新 ID 双向关联）', !!rP && !!rS && rS.id !== s.id && rP.focus_session_id === rS.id && rS.outcome === 'partial' && rS.draft_md.includes('断网闭环完成'), JSON.stringify({ plan: rP && rP.id, sess: rS && rS.id }))
    await page.screenshot({ path: join(OUT, 'c14-offline-restored.png') })
    // 重连：不自动重发旧 begin/end（本应用 begin/end 全本地；断言无自动 API 请求）
    const mark = reqLog.length
    offlineNow = false
    await context.setOffline(false)
    await context.route('**/api/healthz', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', model_ready: true, version: '0.4.0' }) }))
    await page.waitForTimeout(3500)
    const autoApi = reqLog.slice(mark).filter((r) => r.url.includes('/api/'))
    rec('C14', '重连后无自动重发 API 请求', autoApi.length === 0, JSON.stringify(autoApi.map((r) => r.url)))
    const analyzeCalls = reqLog.filter((r) => r.url.includes('/api/analyze'))
    rec('C14', '全程零模型调用（analyze 拦截计数=0）', analyzeCalls.length === 0, `analyze=${analyzeCalls.length}`)
    const offlineApi = reqLog.filter((r) => r.offline && r.url.includes('/api/'))
    const unexpected = reqLog.filter((r) => r.offline && !r.url.startsWith(BASE))
    rec('C14', '离线期间无意外非本地请求（API 尝试如实记录）', unexpected.length === 0, JSON.stringify({ offlineApi: offlineApi.map((r) => r.url), failed: failLog.filter((f) => f.offline).map((f) => `${f.url} ${f.err}`) }))
    writeFileSync(join(OUT, 'c14-request-log.json'), JSON.stringify({ requests: reqLog, failed: failLog }, null, 2))
    await context.close()
  }

  // ============ C15 北京时间跨日 + 外国时区（受控时钟，全部标注模拟） ============
  {
    const T0 = bjStart(D_REAL) + 30_000 // 北京 D 00:00:30 = 纽约 D-1 11:00:30
    const { context, page } = await fresh(null, { tz: 'America/New_York', clockMs: T0 })
    const localDate = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
    rec('C15', '模拟时钟+外国时区：浏览器本地日期≠北京今天', localDate !== D_REAL, `local=${localDate} beijing=${D_REAL}`)
    const headerD = await until(() => page.getByText(bjLabel(D_REAL)).count())
    rec('C15', '今天页按北京日界显示（不随设备时区）', headerD > 0, bjLabel(D_REAL))
    const t = await createTask(page, '跨日对照任务')
    await advance(page, 800)
    const a = await addAction(page, t.id, '跨日行动', 20)
    await advance(page, 800)
    const P = await createPlan(page, '跨日对照任务', '跨日安排', D_REAL, 25)
    await advance(page, 800)
    rec('C15', '操作时刻北京今天：新建安排日期=北京 D（非浏览器本地 D-1）', !!P && P.date === D_REAL, P && P.date)
    // 快进到当日 23:59:30（模拟）
    await page.clock.fastForward(bjStart(D_REAL) + 86_370_000 - T0)
    await advance(page, 1000)
    rec('C15', '模拟 23:59：今天仍为 D', (await page.getByText(bjLabel(D_REAL)).count()) > 0, '')
    const beforeMidnight = await docsKey(page)
    await goto(page, `#/today?date=${D_REAL}&plan=${P.id}`)
    await page.getByRole('button', { name: '开始这项安排' }).waitFor({ timeout: 8000 })
    await page.getByRole('button', { name: '开始这项安排' }).click()
    await dlg(page).getByRole('button', { name: '确认并开始' }).waitFor({ timeout: 5000 })
    // 确认框开着跨午夜（模拟）
    await page.clock.fastForward(61_000)
    await advance(page, 1200)
    const Dnext = bjStr(bjStart(D_REAL) + 86_400_000)
    rec('C15', '模拟跨午夜：今天动态刷新为 D+1', (await page.getByText(bjLabel(Dnext)).count()) > 0, Dnext)
    const sessBefore = (await readDocs(page)).filter((d) => d.kind === 'focus_session' && d.ended_at == null).length
    await dlg(page).getByRole('button', { name: '确认并开始' }).click()
    await advance(page, 1500)
    const diffShown = await dlg(page).getByText('确认期间事实已变化').count()
    const sessAfter = (await readDocs(page)).filter((d) => d.kind === 'focus_session' && d.ended_at == null).length
    rec('C15', '跨午夜提交：事实变化拒绝旧确认，零创建', diffShown > 0 && sessAfter === sessBefore, `diff=${diffShown}`)
    await page.screenshot({ path: join(OUT, 'c15-midnight-diffs.png') })
    await dlg(page).getByRole('button', { name: '已核对，重新确认' }).click()
    await advance(page, 800)
    const boxes = dlg(page).locator('input[type="checkbox"]')
    const nBoxes = await boxes.count()
    for (let i = 0; i < nBoxes; i++) await boxes.nth(i).check()
    rec('C15', '重新确认后安排日≠今天需明确勾选', nBoxes >= 1, `checkboxes=${nBoxes}`)
    await dlg(page).getByRole('button', { name: '确认并开始' }).click()
    await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
    const s = (await readDocs(page)).find((d) => d.kind === 'focus_session' && d.ended_at == null)
    const startedBj = bjStr(Date.parse(s.started_at))
    const Pm = await docOf(page, P.id)
    const tm = await docOf(page, t.id)
    rec('C15', '跨午夜后开始：started_at=北京 D+1，安排日不改写', startedBj === Dnext && Pm.date === D_REAL, JSON.stringify({ startedBj, planDate: Pm.date }))
    rec('C15', '午夜不自动完成/不自动改期', Pm.state === 'planned' && tm.status !== 'done' && beforeMidnight !== null, JSON.stringify({ plan: Pm.state, task: tm.status }))
    // 40s+40s（模拟时钟）→ floor 一次 = 1 分钟。受控时钟下真实点击仍有 ≤0.5s 动作开销（披露），
    // 段断言用 [40000,40500] 容差；权威断言是两段求和 floor 一次恰为 1 分钟。
    await advance(page, 40_000)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await advance(page, 1200)
    const s40 = await docOf(page, s.id)
    rec('C15', '模拟第一段约 40s（点击开销≤0.5s）', s40.accumulated_ms >= 40_000 && s40.accumulated_ms <= 40_500, `${s40.accumulated_ms}ms`)
    await page.getByRole('button', { name: '继续计时' }).click()
    await advance(page, 40_000)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await advance(page, 1200)
    const s80 = await docOf(page, s.id)
    rec('C15', '模拟第二段约 40s：累计约 80s', s80.accumulated_ms >= 80_000 && s80.accumulated_ms <= 81_000, `${s80.accumulated_ms}ms`)
    await endWork(page, { outcome: 'partial', progress: 'partial', text: '跨日两段成果（模拟计时）。', waitEndedId: s.id })
    await advance(page, 1000)
    const Pf = await docOf(page, P.id)
    rec('C15', '80s 两段求和 floor 一次 = 1 分钟（模拟）', Pf.actual_minutes === 1, `actual=${Pf.actual_minutes}`)
    // RECOVERY_REQUIRED：时间明显跳变（模拟）不被绕过。
    // 检查点每 10s 才落库：先暂停把基准用时持久化，再续计时+跳变，断言跳变间隔不计入。
    await startIndependent(page)
    const s2 = (await readDocs(page)).find((d) => d.kind === 'focus_session' && d.ended_at == null)
    await advance(page, 2000)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await advance(page, 1200)
    const s2p = await docOf(page, s2.id)
    const base = s2p.accumulated_ms
    rec('C15', '模拟跳变前暂停落库基准（约 2s，点击开销披露）', s2p.running === false && base >= 2000 && base <= 3500, `${base}ms`)
    await page.getByRole('button', { name: '继续计时' }).click()
    // 等续计时事务真正落库再跳变：否则 anchor 会在跳变后才重置，跳变间隔被洗白（驱动竞态，非产品行为）
    await until(async () => (await docOf(page, s2.id)).running === true)
    await page.clock.fastForward(400_000) // > JUMP_THRESHOLD_MS(300s)
    await advance(page, 1500)
    const recPanel = await page.getByText('待恢复确认：时间明显跳变').count()
    const anyPanel = await page.getByText('待恢复确认').count()
    const rt2 = (await rtAll(page)).find((r) => r.id === `sess:${s2.id}`)
    const s2a = await docOf(page, s2.id)
    rec('C15', '模拟时间跳变：进入待恢复确认，不自动计入', recPanel > 0 && s2a.accumulated_ms === base, JSON.stringify({ panel: recPanel, anyPanel, reason: rt2 && rt2.recovery && rt2.recovery.reason, ms: s2a.accumulated_ms, base }))
    await page.screenshot({ path: join(OUT, 'c15-recovery-panel.png') })
    await page.getByLabel(/保留已保存用时/).check()
    await page.getByRole('button', { name: '核对并恢复运行' }).click()
    await advance(page, 1200)
    const s2b = await docOf(page, s2.id)
    rec('C15', '核对保留：累计不变，跳变间隔不计入', s2b.accumulated_ms === base && s2b.running === true, `${s2b.accumulated_ms}ms`)
    await advance(page, 3000)
    await endWork(page, { outcome: 'done', text: '跳变核对后收尾（模拟）。', waitEndedId: s2.id })
    await advance(page, 1000)
    const s2c = await docOf(page, s2.id)
    rec('C15', '恢复后仅核对后投入计入（模拟，含点击/草稿落库开销）', s2c.accumulated_ms >= base + 4200 && s2c.accumulated_ms <= base + 8000 && s2c.ended_at != null, `${s2c.accumulated_ms}ms`)
    await context.close()
  }

  // ============ C16 多空间互斥 + 晚到结果 + 离开保护（双页同 Context 共享库） ============
  {
    const { context, page: A } = await fresh()
    const B = await newPageB(context)
    // 晚到结果作用域丢弃：开始确认框开着切空间 → 框关闭、不跨空间创建。
    // 必须在任何会话开始前做：本空间存在未结束工作时入口会改为「先处理已有工作」，无开始按钮。
    await goto(B, `#/today?date=${D2}&plan=${K.P3}`)
    await B.getByRole('button', { name: '开始这项安排' }).waitFor({ timeout: 8000 })
    await B.getByRole('button', { name: '开始这项安排' }).click()
    await dlg(B).getByRole('button', { name: '确认并开始' }).waitFor({ timeout: 5000 })
    await B.locator('select[aria-label="切换工作区"]').first().selectOption('demo')
    await B.waitForTimeout(1500)
    const dlgGone = (await dlg(B).count()) === 0
    const demoSess2 = (await snapOf(B, 'demo')).docs.filter((d) => d.kind === 'focus_session').length
    rec('C16', '确认框开着切空间：作用域丢弃，不跨空间创建', dlgGone && demoSess2 === 0, `dlg=${dlgGone}`)
    // A 页开始运行（个人空间）；B 页此时已在演示空间
    const S1 = await startIndependent(A)
    rec('C16', 'A 页个人空间运行会话', !!S1 && S1.running === true, S1 && S1.id)
    const dt = await createTask(B, '同名任务：多空间对照')
    const da = await addAction(B, dt.id, '演示行动', 15)
    rec('C16', '演示空间建同名任务/行动', !!dt && !!da, dt && dt.id)
    // B 页进入演示空间早于 S1 开始：真实刷新一次，让 B 页读到个人空间的运行事实
    await B.reload({ waitUntil: 'domcontentloaded' })
    await B.waitForTimeout(1300)
    await goto(B, `#/tasks/${dt.id}`)
    const crossAlert = await B.getByText('有一段正在运行的工作').count()
    const gotoEntry = await B.getByRole('button', { name: '前往个人空间查看' }).count()
    rec('C16', '跨空间运行：只解释+入口，不替它暂停', crossAlert > 0 && gotoEntry > 0, '')
    const demoBefore = await docsKey(B)
    await B.getByRole('button', { name: '开始执行', exact: true }).click()
    await B.waitForTimeout(1200)
    const demoSessions = (await readDocs(B)).filter((d) => d.kind === 'focus_session').length
    const errShown = await B.locator('[role="alert"], .text-destructive').count()
    rec('C16', '跨空间运行中开始：事务拒绝，演示空间零会话', demoSessions === 0 && errShown > 0 && demoBefore === await docsKey(B), `sessions=${demoSessions}`)
    await B.screenshot({ path: join(OUT, 'c16-cross-ws-block.png') })
    // 同名≠同对象：个人空间同名任务独立 ID，快照隔离
    await switchWs(B, 'personal')
    const pt = await createTask(B, '同名任务：多空间对照')
    rec('C16', '同名任务不同对象（ID 不同）', !!pt && pt.id !== dt.id, JSON.stringify({ personal: pt && pt.id, demo: dt.id }))
    const snapP = await snapOf(B, 'personal')
    const snapD = await snapOf(B, 'demo')
    rec('C16', '空间快照隔离：各自只含自己的同名任务', snapP.docs.some((d) => d.id === pt.id) && !snapP.docs.some((d) => d.id === dt.id) && snapD.docs.some((d) => d.id === dt.id) && !snapD.docs.some((d) => d.id === pt.id), '')
    // 晚到外部结束（测试辅助写库披露 + 真实 focus 事件）：不覆盖成果、不复活、本地输入留核对
    await switchWs(B, 'personal')
    await A.getByLabel('本次成果正文').fill('C16 本页未保存输入')
    const s1live = await docOf(A, S1.id)
    await putDoc(A, { ...s1live, running: false, outcome: 'done', ended_at: now(), accumulated_ms: s1live.accumulated_ms + 1000, draft_md: '外部最终成果' })
    // 披露：模拟「另一页真实结束」须同步释放协调记录（真实 end 事务同写 docs+runtime）：
    // run 槽清空 + sess 记录 ended=true，否则运行位仍被占，后续开始入口被旧协调数据挡住。
    await A.evaluate(async (sid) => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('jxl-product'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      await new Promise((res, rej) => {
        const tx = db.transaction('focus_runtime', 'readwrite')
        const st = tx.objectStore('focus_runtime')
        st.put({ id: 'run:personal', kind: 'running', workspace_id: 'personal', session_id: null, updated_at: Date.now() })
        const g = st.get(`sess:${sid}`)
        g.onsuccess = () => { const r = g.result; if (r) st.put({ ...r, ended: true, updated_at: Date.now() }) }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      })
      db.close()
    }, S1.id)
    await A.evaluate(() => window.dispatchEvent(new Event('focus')))
    await A.waitForTimeout(1500)
    const endedCard = await A.getByText('本次工作已在其它页面结束').count()
    const localKept = await A.getByText('C16 本页未保存输入').count()
    const s1ext = await docOf(A, S1.id)
    rec('C16', '晚到外部结束：只读核对，本地输入保留不覆盖', endedCard > 0 && localKept > 0 && s1ext.draft_md === '外部最终成果' && s1ext.outcome === 'done', '')
    await A.screenshot({ path: join(OUT, 'c16-ended-review.png') })
    await A.getByRole('button', { name: /舍弃本地输入/ }).first().click()
    await A.waitForTimeout(1000)
    // 离开保护①：切空间（运行中+脏输入）。
    // 种子 U 的唯一行动已 done 且无当前行动（C01 事实）：先经真实 UI 补一条当前行动，才有开始执行入口。
    await goto(A, `#/tasks/${K.U}`)
    await addAction(A, K.U, 'C16 独立第二段', 15)
    await A.getByRole('button', { name: '开始执行', exact: true }).click()
    await A.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
    const S2 = (await readDocs(A)).find((d) => d.kind === 'focus_session' && d.ended_at == null)
    await A.getByLabel('本次成果正文').fill('C16 离开前草稿')
    await A.locator('select[aria-label="切换工作区"]').first().selectOption('demo')
    await dlg(A).getByText('离开本次工作？').waitFor({ timeout: 5000 })
    await dlg(A).getByRole('button', { name: '留在这里' }).click()
    await A.waitForTimeout(900)
    const stayedWs = await wsOf(A)
    const s2run = await docOf(A, S2.id)
    rec('C16', '切空间离开确认取消：留在原空间原会话', stayedWs === 'personal' && (await hashOf(A)).includes(S2.id) && s2run.running === true, stayedWs)
    await A.locator('select[aria-label="切换工作区"]').first().selectOption('demo')
    await dlg(A).getByText('离开本次工作？').waitFor({ timeout: 5000 })
    await dlg(A).getByRole('button', { name: '保存并暂停后离开' }).click()
    await A.waitForTimeout(1800)
    const s2p = (await snapOf(A, 'personal')).docs.find((d) => d.id === S2.id) || null
    rec('C16', '切空间确认离开：保存并暂停，草稿落库', (await wsOf(A)) === 'demo' && !!s2p && s2p.running === false && s2p.draft_md.includes('C16 离开前草稿'), '')
    // 离开保护②：后退/前进不自动续计时
    await switchWs(A, 'personal')
    await goto(A, `#/work/${S2.id}`)
    await A.getByRole('button', { name: '继续计时' }).click()
    await A.waitForTimeout(900)
    await A.getByLabel('本次成果正文').fill('C16 返回草稿')
    await A.goBack()
    await dlg(A).getByText('离开本次工作？').waitFor({ timeout: 5000 })
    await dlg(A).getByRole('button', { name: '留在这里' }).click()
    await A.waitForTimeout(900)
    rec('C16', '后退触发离开保护：取消留在工作页', (await hashOf(A)).includes(S2.id), await hashOf(A))
    await A.goBack()
    await dlg(A).getByText('离开本次工作？').waitFor({ timeout: 5000 })
    await dlg(A).getByRole('button', { name: '保存并暂停后离开' }).click()
    await A.waitForTimeout(1800)
    await A.goForward()
    await A.waitForTimeout(1500)
    const s2f = await docOf(A, S2.id)
    const backHash = await hashOf(A)
    rec('C16', '前进回到工作页：不自动继续计时', backHash.includes(S2.id) && s2f.running === false && s2f.draft_md.includes('C16 返回草稿'), '')
    // 离开保护③：同组件换 sessionId（/work/A → /work/B）
    await A.getByLabel('本次成果正文').fill('C16 参数切换草稿')
    await goto(A, `#/work/${E1}`)
    const updDlg = await dlg(A).getByText('离开本次工作？').count()
    if (updDlg) {
      await dlg(A).getByRole('button', { name: '留在这里' }).click()
      await A.waitForTimeout(900)
    }
    const stayedUrl = (await hashOf(A)).includes(S2.id)
    const textKept = (await A.getByLabel('本次成果正文').inputValue()).includes('C16 参数切换草稿')
    rec('C16', '同组件换参数：取消留在原会话原输入', updDlg > 0 && stayedUrl && textKept, `dlg=${updDlg}`)
    // 取消后等待期间草稿自动保存已落库：暂停+无脏输入本就可直接离开（产品规则）。
    // 重新写入新草稿制造脏输入，再验证确认离开分支。
    await A.getByLabel('本次成果正文').fill('C16 参数切换草稿2')
    await goto(A, `#/work/${E1}`)
    await dlg(A).getByText('离开本次工作？').waitFor({ timeout: 5000 })
    await dlg(A).getByRole('button', { name: '保存后离开' }).click()
    await A.waitForTimeout(1800)
    const s2saved = await docOf(A, S2.id)
    // 已结束会话访问 /work/E1 → 产品规则转只读记录页（/work-records/E1），断言只读成果标记
    const e1ro = await A.getByText('工作成果（只读）').count()
    rec('C16', '同组件换参数确认：原会话草稿落库，目标只读', !!s2saved && s2saved.draft_md.includes('C16 参数切换草稿2') && (await hashOf(A)).includes(E1) && e1ro > 0, JSON.stringify({ draft: s2saved && s2saved.draft_md, hash: await hashOf(A), e1ro }))
    // 暂停不占全局运行位：演示空间可开始；随后个人空间继续被拒
    await switchWs(B, 'demo')
    await goto(B, `#/tasks/${dt.id}`)
    await B.getByRole('button', { name: '开始执行', exact: true }).click()
    await B.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
    const demoRun = (await readDocs(B)).find((d) => d.kind === 'focus_session' && d.ended_at == null)
    rec('C16', '个人空间暂停不阻塞演示空间开始（全局运行=1）', !!demoRun && demoRun.running === true, demoRun && demoRun.id)
    await goto(A, `#/work/${S2.id}`)
    await A.getByRole('button', { name: '继续计时' }).click()
    await A.waitForTimeout(1500)
    const s2still = await docOf(A, S2.id)
    const resumeErr = await A.getByText('已有其它运行中的会话，不能继续').count()
    const alertText = (await A.locator('[role="alert"]').allTextContents()).join('|').slice(0, 200)
    rec('C16', '演示运行中个人空间继续：拒绝，不双运行', s2still.running === false && resumeErr > 0, JSON.stringify({ running: s2still.running, err: resumeErr, alertText }))
    await A.screenshot({ path: join(OUT, 'c16-resume-blocked.png') })
    await context.close()
  }

  // ============ C17 草稿/路由参数/恢复冲突 ============
  {
    const { context, page } = await fresh()
    const S1 = await startIndependent(page)
    await page.getByLabel('本次成果正文').fill('C17 草稿甲')
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.waitForTimeout(900)
    // 只改无关 query：不弹离开确认，输入保留
    await page.getByLabel('本次成果正文').fill('C17 草稿甲·未保存追加')
    await goto(page, `#/work/${S1.id}?return=%2Ftasks`)
    const qDlg = await dlg(page).getByText('离开本次工作？').count()
    const qText = await page.getByLabel('本次成果正文').inputValue()
    rec('C17', '只改 query 不弹离开确认，草稿保留', qDlg === 0 && qText.includes('未保存追加'), `dlg=${qDlg}`)
    // 同组件换 sessionId：取消保留；确认后草稿落到原会话
    // 重填同文重置 1000ms 自动保存窗口，保证守卫看到脏输入（驱动确定性，非产品行为）
    await page.getByLabel('本次成果正文').fill('C17 草稿甲·未保存追加')
    await goto(page, `#/work/${E1}`)
    await dlg(page).getByText('离开本次工作？').waitFor({ timeout: 5000 })
    await dlg(page).getByRole('button', { name: '留在这里' }).click()
    await page.waitForTimeout(900)
    rec('C17', '换参数取消：URL/输入不变', (await hashOf(page)).includes(S1.id) && (await page.getByLabel('本次成果正文').inputValue()).includes('未保存追加'), '')
    // 取消后等待期间草稿可能已自动落库（暂停+干净可直接离开是产品规则）：重填新草稿再验确认分支
    await page.getByLabel('本次成果正文').fill('C17 草稿甲·未保存追加2')
    await goto(page, `#/work/${E1}`)
    await dlg(page).getByText('离开本次工作？').waitFor({ timeout: 5000 })
    await dlg(page).getByRole('button', { name: '保存后离开' }).click()
    await page.waitForTimeout(1800)
    const s1d = await docOf(page, S1.id)
    rec('C17', '换参数确认：草稿写入原会话（不串写目标）', s1d.draft_md.includes('未保存追加') && (await hashOf(page)).includes(E1), '')
    // 不存在/跨空间会话路由：不自动新建、不自动切空间
    const cntBefore = (await readDocs(page)).length
    await goto(page, '#/work/does-not-exist-id')
    const invAlert = await page.getByText('会话不存在或不属于当前空间').count()
    // app.js:50 workspaceId = readLocal(KEY) || 'personal'：从未手动切空间时键为 null，默认即个人空间
    const wsNow = (await wsOf(page)) || 'personal'
    rec('C17', '无效会话路由：明确提示，零创建零切空间', invAlert > 0 && (await readDocs(page)).length === cntBefore && wsNow === 'personal', JSON.stringify({ invAlert, cntBefore, ws: wsNow }))
    // 当前空间有暂停未结束时做恢复：恢复不触碰当前空间
    const personalBefore = await snapOf(page, 'personal')
    const pv = await previewFile(page, PAUSED_ZIP, 'paused-source.zip')
    rec('C17', '恢复预览含未结束会话（零写入）', pv.preview.unfinishedCount === 1, JSON.stringify(pv.preview.counts))
    const done = await confirmRestore(page, 'C17 恢复空间')
    await enterRestore(page)
    const rdocs = await readDocs(page)
    const rU = rdocs.find((d) => d.kind === 'focus_session' && d.ended_at == null)
    rec('C17', '恢复到新空间：未结束 v1 暂停+占位租约', !!rU && rU.running === false && rU.timer_anchor_at == null, rU && rU.id)
    const personalAfter = await snapOf(page, 'personal')
    rec('C17', '恢复期间原空间逐字段不变', JSON.stringify(personalBefore.docs) === JSON.stringify(personalAfter.docs), '')
    // 恢复空间继续工作：接管→核对→继续→离开保存
    await goto(page, `#/work/${rU.id}`)
    await page.getByRole('button', { name: '恢复编辑（接管）' }).click()
    await page.getByText('待恢复确认：页面接管').waitFor({ timeout: 8000 })
    await page.getByLabel(/保留已保存用时/).check()
    await page.getByRole('button', { name: '核对用时（保持暂停）' }).click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: '继续计时' }).click()
    await page.waitForTimeout(2500)
    await page.getByLabel('本次成果正文').fill('C17 恢复空间草稿')
    await goto(page, '#/today')
    await dlg(page).getByText('离开本次工作？').waitFor({ timeout: 5000 })
    await dlg(page).getByRole('button', { name: '保存并暂停后离开' }).click()
    await page.waitForTimeout(1800)
    const rU2 = await docOf(page, rU.id)
    rec('C17', '恢复空间离开保护：保存并暂停，草稿落库', rU2.running === false && rU2.draft_md.includes('C17 恢复空间草稿') && rU2.accumulated_ms > 0, `${rU2.accumulated_ms}ms`)
    // 刷新（真实 reload）：已保存草稿从库恢复；未保存内存输入不恢复（如实声明）
    await goto(page, `#/work/${rU.id}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    const reloadText = await page.getByLabel('本次成果正文').inputValue()
    rec('C17', '刷新后已保存草稿从库恢复', reloadText.includes('C17 恢复空间草稿'), '')
    // 回原空间：会话/草稿/累计不受恢复影响
    await switchWs(page, 'personal')
    const s1back = await docOf(page, S1.id)
    rec('C17', '回原空间：暂停会话与草稿原样', s1back.running === false && s1back.draft_md.includes('未保存追加') && s1back.ended_at == null, '')
    await page.screenshot({ path: join(OUT, 'c17-restored-work.png') })
    await context.close()
  }

  // ============ C18 遗留兼容（§7 夹具分支，披露） ============
  // a) 已结束 v0/v1 只读保留
  {
    const { context, page } = await fresh((docs) => [...docs, v0sess('legacy-v0-ended', { ended_at: `${D}T10:00:00+08:00`, outcome: 'done', draft_md: 'v0 历史正文' })])
    const before = await docsKey(page)
    await goto(page, '#/work-records/legacy-v0-ended')
    const bodyShown = await page.getByText('v0 历史正文').count()
    const noEdit = (await page.locator('textarea').count()) === 0
    // 记录页用时展示为 formatDurationMs（600000ms → "10:00"），不是「10 分」文案
    const mainText = await page.locator('main').innerText()
    rec('C18', '已结束 v0 只读：正文/累计可读，无编辑', bodyShown > 0 && noEdit && mainText.includes('实际有效用时') && /10:00/.test(mainText), JSON.stringify({ bodyShown, noEdit, dur: /实际有效用时[\s\S]{0,20}/.exec(mainText)?.[0] }))
    rec('C18', '已结束 v0 访问零改写', before === await docsKey(page), '')
    // R1：正文断言绑定命名字段选中的明确记录（属于 P1、v1、已结束），保留只读与零写入要求
    const e1doc = await docOf(page, E1)
    if (!e1doc || e1doc.plan_item_id !== K.P1 || e1doc.record_version !== 1 || e1doc.ended_at == null) {
      throw new Error(`E1 身份校验失败: ${JSON.stringify(e1doc && { id: e1doc.id, plan: e1doc.plan_item_id, v: e1doc.record_version, ended: e1doc.ended_at })}`)
    }
    const e1Key = await docsKey(page)
    await goto(page, `#/work-records/${E1}`)
    const e1main = await page.locator('main').innerText()
    rec('C18', '已结束 v1 只读保留（命名单段正文明确可读）', e1main.includes(INV.p1Segments.first.draft_md) && e1main.includes('工作成果（只读）'), JSON.stringify({ id: E1, draft: INV.p1Segments.first.draft_md }))
    rec('C18', '已结束 v1 访问零改写', e1Key === (await docsKey(page)), '')
    await context.close()
  }
  // b) 未结束 v0 无安排：显式遗留结束，不补 v1 字段；释放占用后可开始新工作
  {
    const { context, page } = await fresh((docs) => [...docs, v0sess('legacy-v0-open', { running: true, accumulated_ms: 300000, draft_md: '遗留进行中' })])
    await goto(page, '#/work/legacy-v0-open')
    await legacyEnd(page, { outcome: 'partial', minutes: '5' })
    const s = await docOf(page, 'legacy-v0-open')
    rec('C18', 'v0 无安排显式结束：结果/累计/ended_at 落库', s.ended_at != null && s.outcome === 'partial' && s.accumulated_ms === 300000 && s.running === false, '')
    rec('C18', 'v0 结束不补造 v1 字段', s.record_version == null && s.timer_anchor_at == null && s.task_snapshot == null && s.task_ref_state == null, '')
    rec('C18', '遗留结束后归档到记录页', (await hashOf(page)).includes('work-records/legacy-v0-open'), await hashOf(page))
    const ns = await startIndependent(page)
    rec('C18', '遗留结束释放占用：可开始新工作', !!ns && ns.running === true, ns && ns.id)
    await context.close()
  }
  // c) 未结束 v0 关联有效活安排：显式进度同事务联动
  {
    const { context, page } = await fresh((docs) => [
      ...docs,
      planFrom(docs, 'legacy-plan', { date: D, action_text: '遗留联动安排', state: 'planned' }),
      v0sess('legacy-v0-plan', { running: true, accumulated_ms: 120000, plan_item_id: 'legacy-plan', draft_md: '遗留联动正文' }),
    ])
    await goto(page, '#/work/legacy-v0-plan')
    const planBlock = await page.getByText('所属安排').count()
    rec('C18', 'v0 活安排：遗留面板显示安排与进度选择', planBlock > 0 && (await page.getByLabel('这项安排已完成（不代表完成任务）').count()) > 0, '')
    await legacyEnd(page, { outcome: 'done', minutes: '2', progress: 'done' })
    const s = await docOf(page, 'legacy-v0-plan')
    const p = await docOf(page, 'legacy-plan')
    rec('C18', 'v0 遗留结束同事务联动：安排 done+权威摘要+双向关联', s.ended_at != null && p.state === 'done' && p.actual_minutes === 2 && p.focus_session_id === s.id, JSON.stringify({ plan: p.state, actual: p.actual_minutes }))
    await context.close()
  }
  // d) v0 死引用：例外结束释放占用，不联动安排
  {
    const { context, page } = await fresh((docs) => [...docs, v0sess('legacy-v0-dead', { running: true, accumulated_ms: 60000, plan_item_id: 'gone-plan' })])
    await goto(page, '#/work/legacy-v0-dead')
    const brokenAlert = await page.getByText('遗留会话关联的安排缺失或已终态').count()
    rec('C18', 'v0 死引用：明确提示无法联动', brokenAlert > 0, '')
    await legacyEnd(page, { outcome: 'partial', minutes: '1' })
    const s = await docOf(page, 'legacy-v0-dead')
    rec('C18', 'v0 死引用例外结束：释放占用，无安排写入', s.ended_at != null && s.outcome === 'partial' && !(await readDocs(page)).some((d) => d.id === 'gone-plan'), '')
    await context.close()
  }
  // e) 正常 v1 关联损坏：正文/累计保留，编辑/暂停/保存可用，不降级 legacyEnd
  {
    const sid = 'v1-broken-plan'
    const { context, page } = await fresh(
      (docs) => [...docs, v1from(docs, sid, { plan_item_id: 'gone-plan', accumulated_ms: 120000, draft_md: 'v1 损坏正文', started_at: `${D}T08:00:00+08:00` })],
      { runtime: [sessRt(sid), { id: 'run:personal', kind: 'running', workspace_id: 'personal', session_id: null, updated_at: Date.now() }] },
    )
    await goto(page, `#/work/${sid}`)
    const brokenAlert = await page.getByText('会话关联的安排已不存在（关联损坏）').count()
    rec('C18', 'v1 关联损坏：明确提示，不自动解绑/降级', brokenAlert > 0 && (await page.getByText('旧版（v0）未结束会话').count()) === 0, '')
    await page.getByRole('button', { name: '恢复编辑（接管）' }).click()
    await page.getByText('待恢复确认：页面接管').waitFor({ timeout: 8000 })
    await page.getByLabel(/保留已保存用时/).check()
    await page.getByRole('button', { name: '核对用时（保持暂停）' }).click()
    await page.waitForTimeout(1200)
    await page.getByLabel('本次成果正文').fill('v1 损坏正文·继续编辑')
    await page.getByRole('button', { name: '继续计时' }).click()
    await page.waitForTimeout(2000)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.waitForTimeout(900)
    const sMid = await docOf(page, sid)
    rec('C18', 'v1 损坏关联：编辑/计时/暂停照常，累计保留', sMid.draft_md.includes('继续编辑') && sMid.accumulated_ms >= 120000 && sMid.running === false, `${sMid.accumulated_ms}ms`)
    // 产品规则（EndSessionForm）：v1 关联损坏时正文可保存，但明确拒绝结束、不自动解绑、不降级 legacyEnd。
    // 验收口径＝保留正文+明确错误+零写入拒绝，而非强行结束成功。
    await page.getByLabel('本次成果正文').fill('v1 损坏关联收尾正文')
    await page.getByRole('button', { name: '结束本次' }).click()
    await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
    const brokenEndAlert = await dlg(page).getByText('会话关联的安排已不存在（关联损坏）').count()
    const endBtn = dlg(page).getByRole('button', { name: '结束并保存' })
    const submitDisabled = await endBtn.isDisabled()
    const beforeKey = await docsKey(page)
    await endBtn.click({ force: true }).catch(() => {})
    await page.waitForTimeout(900)
    const sEnd = await docOf(page, sid)
    rec('C18', 'v1 损坏关联：结束被明确拒绝（不降级 legacyEnd、零写入）', brokenEndAlert > 0 && submitDisabled && sEnd.ended_at == null && sEnd.record_version === 1 && beforeKey === (await docsKey(page)), JSON.stringify({ alert: brokenEndAlert, disabled: submitDisabled }))
    await context.close()
  }
  // f) 旧 planned 已有结束历史：开始入口要求人工核对进度
  {
    const { context, page } = await fresh((docs) => [
      ...docs,
      planFrom(docs, 'review-plan', { date: D2, action_text: '待核对旧安排', state: 'planned' }),
      v1from(docs, 'review-sess', { plan_item_id: 'review-plan', ended_at: `${D}T12:00:00+08:00`, outcome: 'partial', accumulated_ms: 90000 }),
    ])
    await goto(page, `#/today?date=${D2}&plan=review-plan`)
    const reviewBlock = await page.getByText('该安排仍为待执行，但已有结束历史').count()
    const reviewBtn = await page.getByRole('button', { name: '核对已有进度' }).count()
    const noStart = (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0
    rec('C18', '旧 planned+历史：开始入口改为人工核对进度', reviewBlock > 0 && reviewBtn > 0 && noStart, '')
    await context.close()
  }
  // g/h) 异常累计/异常结束时间：待核对，不当零分钟、不自动修历史
  for (const [tag, badOver, label] of [
    ['非法时长', { accumulated_ms: -5 }, '时长非法'],
    ['非法结束时间', { ended_at: '不是时间' }, '结束时间非法'],
  ]) {
    const pid = `bad-${tag === '非法时长' ? 'dur' : 'end'}-plan`
    const sid = `bad-${tag === '非法时长' ? 'dur' : 'end'}-sess`
    const { context, page } = await fresh((docs) => [
      ...docs,
      planFrom(docs, pid, { date: D, action_text: `异常安排${tag}`, state: 'partial', actual_minutes: 7 }),
      v1from(docs, sid, { plan_item_id: pid, ended_at: `${D}T12:00:00+08:00`, outcome: 'partial', accumulated_ms: 60000, ...badOver }),
    ])
    await goto(page, `#/today?date=${D}&plan=${pid}`)
    const anomBlock = await page.getByText('历史用时存在异常，未生成权威摘要（待核对）').count()
    const probLabel = await page.getByText(label).count()
    const noConfirm = (await page.getByRole('button', { name: '确认进度' }).count()) === 0
    rec('C18', `异常历史（${tag}）：待核对块+明细，不给可确认数字`, anomBlock > 0 && probLabel > 0 && noConfirm, '')
    const p = await docOf(page, pid)
    rec('C18', `异常历史（${tag}）：原摘要保留不自动改写`, p.actual_minutes === 7, `actual=${p.actual_minutes}`)
    await goto(page, `#/tasks/${K.T}?plan=${pid}`)
    const entryWarn = await page.getByText('历史用时存在异常待核对').count()
    rec('C18', `异常历史（${tag}）：任务页开始入口拦截`, entryWarn > 0 && (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0, '')
    await page.screenshot({ path: join(OUT, `c18-anomaly-${tag === '非法时长' ? 'dur' : 'end'}.png`) })
    await context.close()
  }
  // i) moved 兼容终态样本（正常改期为同 ID 换日，moved 仅遗留数据）
  {
    const { context, page } = await fresh((docs) => [...docs, planFrom(docs, 'moved-plan', { date: D, action_text: '遗留 moved 安排', state: 'moved' })])
    await goto(page, `#/tasks/${K.T}?plan=moved-plan`)
    const terminalText = await page.getByText('该安排已是历史（完成/取消/改期），不能开始').count()
    rec('C18', 'moved 终态：只读历史，不能开始', terminalText > 0 && (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0, '')
    await goto(page, `#/today?date=${D}&plan=moved-plan`)
    rec('C18', 'moved 终态：日程详情无开始入口', (await page.getByRole('button', { name: '开始这项安排' }).count()) === 0, '')
    await context.close()
  }
  // j) 兼容旧数据真实 ZIP 往返：v0 已结束保留 + v0 未结束暂停后可显式结束
  {
    const { context, page } = await fresh((docs) => [
      ...docs,
      v0sess('legacy-zip-ended', { ended_at: `${D}T10:00:00+08:00`, outcome: 'done', draft_md: 'v0 导出历史' }),
      v0sess('legacy-zip-open', { running: true, accumulated_ms: 240000, draft_md: 'v0 导出进行中' }),
    ])
    const zipPath = join(ZIPDIR, 'legacy-compat.zip')
    const ex = await exportViaUI(page, zipPath)
    rec('C18', '遗留空间真实导出', ex.bytes > 0, `${ex.filename} ${ex.bytes}B sha256=${ex.sha256}`)
    const pv = await previewFile(page, readFileSync(zipPath), 'legacy-compat.zip')
    rec('C18', '遗留备份预览：未结束计数=1', pv.preview.unfinishedCount === 1, JSON.stringify(pv.preview.counts))
    await confirmRestore(page, '遗留兼容恢复')
    await enterRestore(page)
    const rdocs = await readDocs(page)
    const rOpen = rdocs.find((d) => d.kind === 'focus_session' && d.draft_md === 'v0 导出进行中')
    const rEnded = rdocs.find((d) => d.kind === 'focus_session' && d.draft_md === 'v0 导出历史')
    rec('C18', '恢复后 v0 未结束只暂停，不补 v1 字段', !!rOpen && rOpen.running === false && rOpen.record_version == null && rOpen.timer_anchor_at == null && rOpen.accumulated_ms === 240000, '')
    rec('C18', '恢复后 v0 已结束历史原样', !!rEnded && rEnded.ended_at != null && rEnded.outcome === 'done', '')
    await goto(page, `#/work/${rOpen.id}`)
    await legacyEnd(page, { outcome: 'partial', minutes: '4' })
    const rDone = await docOf(page, rOpen.id)
    rec('C18', '恢复空间 v0 仍可显式遗留结束', rDone.ended_at != null && rDone.outcome === 'partial' && rDone.accumulated_ms === 240000, '')
    await page.screenshot({ path: join(OUT, 'c18-legacy-restored.png') })
    await context.close()
  }
} catch (e) {
  rec('FATAL', '驱动异常', false, (e && e.stack) || String(e))
}

const passed = results.filter((r) => r.pass).length
writeFileSync(join(OUT, 'c14-results.json'), JSON.stringify({ at: now(), baseDate: D, executionBeijingDate: D_REAL, total: results.length, passed, failed: results.length - passed, results }, null, 2))
console.log(`== c14: ${passed}/${results.length} passed ==`)
await browser.close()
process.exit(results.some((r) => !r.pass) ? 1 : 0)