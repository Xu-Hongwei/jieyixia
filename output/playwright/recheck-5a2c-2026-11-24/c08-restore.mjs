// 5A-2C C08–C13：真实 ZIP 往返 / 删除历史 / 运行暂停恢复 / 继续真实工作 / 失败注入幂等 / 预览取消与坏文件。
// 数据分支：每场景独立 Context。种子 = C01 真实页面生成的 c01-docs-snapshot.json（测试辅助写库复制，披露）。
// 导出/恢复全部走真实 DataPage UI（真实下载 + input[type=file] 上传）；baseline-normal.zip 为 C01 真实导出。
// 故障注入（C12）：一次性包装 IDBObjectStore.prototype.add / IDBTransaction 回调，精确到尾部写入/配额/提交后反馈，
// 触发后立即还原原型；注入样本（C13 非法引用/禁止键/哈希不符）用 fflate 重打包并披露。
// 运行：node E:/qoder/devlog/private-evidence/stage5a-2c/c08-restore.mjs（需自启 [::1]:5174 Vite）
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire('file:///E:/qoder/frontend/package.json')
const { unzipSync, zipSync } = require('fflate')
const OUT = dirname(fileURLToPath(import.meta.url))
const ZIPDIR = join(OUT, 'zip')
mkdirSync(ZIPDIR, { recursive: true })
const BASE = 'http://[::1]:5184/'
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const SEED = JSON.parse(readFileSync(join(OUT, 'c01-docs-snapshot.json'), 'utf8'))
const INV = JSON.parse(readFileSync(join(OUT, 'c01-inventory.json'), 'utf8'))
const K = INV.keyIds
const D = INV.baseDate; const D4 = INV.D4
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const TEXT = '虚构资料：报告素材清单——进展数据、风险列表、下一步计划。'
const PNG_SHA = createHash('sha256').update(Buffer.from(PNG_B64, 'base64')).digest('hex')
const BASELINE = readFileSync(join(ZIPDIR, 'baseline-normal.zip'))
const sha = (b) => createHash('sha256').update(b).digest('hex')
const now = () => new Date().toISOString()

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true })

async function fresh(seed = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  await context.route('**/api/healthz', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', model_ready: true, version: '0.4.0' }) }))
  await context.route('**/api/analyze', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'model_unavailable', message: '拦截' }) }))
  const page = await context.newPage()
  await page.addInitScript(() => { window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p })
  page.on('pageerror', (e) => rec('C08-13', '页面JS错误', false, e.message))
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  if (seed) {
    await page.evaluate(async ([docs, pngB64, textSourceId, imgSourceId, text]) => {
      const db = await import(window.__mod('/src/services/storage/db.js'))
      const ts = new Date().toISOString()
      await db.putSource({ id: textSourceId, kind: 'text', captured_at: ts, text })
      const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0))
      await db.putSource({ id: imgSourceId, kind: 'image', captured_at: ts, blob: new Blob([bytes], { type: 'image/png' }), name: 'fixture-test-image.png' })
      for (const d of docs) await db.putDoc(d)
    }, [SEED, PNG_B64, K.textSource, K.imgSource, TEXT])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
  }
  return { context, page }
}
const readDocs = (page) => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  return (await db.allDocs()).records
})
const docOf = async (page, id) => (await readDocs(page)).find((d) => d.id === id) || null
const putDoc = (page, doc) => page.evaluate(async (d) => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  await db.putDoc(d)
}, doc)
const dlg = (page) => page.locator('[role="dialog"]')
const adlg = (page) => page.locator('[role="alertdialog"]')
const goto = async (page, hash) => { await page.evaluate((h) => { location.hash = h }, hash); await page.waitForTimeout(600) }

// 全库 oracle（跨空间）：docs 全量 + sources 元数据/图片哈希 + 目录回执 + 协调数据。独立于被测 remap/summarize。
const wholeDB = (page) => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  const hex = (h) => [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const wss = await db.allWorkspaces()
  const out = []
  for (const w of wss) {
    const s = await db.readWorkspaceSnapshot(w.id)
    const sources = []
    for (const x of s.sources) {
      const meta = { id: x.id, kind: x.kind, text: x.text || null, name: x.name || null }
      if (x.kind === 'image' && x.blob) meta.sha = hex(await crypto.subtle.digest('SHA-256', await x.blob.arrayBuffer()))
      sources.push(meta)
    }
    out.push({ id: w.id, receipt: w.restore_receipt || null, docs: s.docs, sources })
  }
  const rt = (await db.allFocusRuntime()).records
  return JSON.stringify({ out, rt })
})
const snapOf = (page, ws) => page.evaluate(async (w) => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  const s = await db.readWorkspaceSnapshot(w)
  const hex = (h) => [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const sources = []
  const img = {}
  for (const x of s.sources) {
    sources.push({ id: x.id, kind: x.kind, text: x.text || null, name: x.name || null })
    if (x.kind === 'image' && x.blob) img[x.id] = hex(await crypto.subtle.digest('SHA-256', await x.blob.arrayBuffer()))
  }
  return { workspace: s.workspace, docs: s.docs, sources, img }
}, ws)
const dirList = (page) => page.evaluate(async () => {
  const db = await import(window.__mod('/src/services/storage/db.js'))
  return (await db.allWorkspaces()).map((w) => ({ id: w.id, name: w.name, is_demo: !!w.is_demo, receipt: w.restore_receipt || null }))
})
const setFile = (page, buf, name) => page.locator('input[type=file]').setInputFiles({ name: name || 'backup.zip', mimeType: 'application/zip', buffer: buf })
const jobInfo = (page) => page.evaluate(async () => {
  const m = await import(window.__mod('/src/services/backup/restore.js'))
  const j = m.restoreJob
  return { phase: j.phase, operationId: j.operationId, targetWorkspaceId: j.targetWorkspaceId, result: j.result, verifyProblems: j.verifyProblems, commitError: j.commitError, errors: j.errors, preview: j.preview }
})
// Node 侧确定性轮询（done 须 result 已落位，避免 committing→done 间隙误判）
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
async function startIndependent(page) {
  await goto(page, `#/tasks/${K.T}`)
  await page.getByRole('button', { name: '开始执行', exact: true }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await page.waitForTimeout(500)
}
async function endWork(page, { outcome = 'done', text = '分支收尾成果。' } = {}) {
  await page.getByLabel('本次成果正文').fill(text)
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg(page).locator(`input[name="work-outcome"][value="${outcome}"]`).check()
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  await page.waitForTimeout(1000)
}
async function openTaskDelete(page) {
  await goto(page, `#/tasks/${K.T}`)
  await page.getByRole('button', { name: '删除任务', exact: true }).click()
  await adlg(page).waitFor({ timeout: 5000 })
}
const newPageB = async (context, hash) => {
  const p = await context.newPage()
  await p.addInitScript(() => { window.__mod = (p2) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p2)) || p2 })
  p.on('pageerror', (e) => rec('C08-13', '页面JS错误(B)', false, e.message))
  await p.goto(BASE + hash, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1200)
  return p
}

// ============ C08 正常 ZIP 真实往返（静态源分支） ============
{
  const { context, page } = await fresh()
  const srcBefore = await wholeDB(page)
  const j0 = await previewFile(page, BASELINE, 'baseline-normal.zip')
  const c = j0.preview.counts
  rec('C08', '真实上传→预览计数与 C01 基准一致', c.plan_item === 5 && c.action === 5 && c.focus_session === 4 && c.task === 3 && c.note === 2 && j0.preview.sourceCount === 2 && j0.preview.imageCount === 1 && j0.preview.unfinishedCount === 0, JSON.stringify(c))
  rec('C08', '预览阶段零写入（不建空空间不切空间）', (await wholeDB(page)) === srcBefore, '')
  await page.screenshot({ path: join(OUT, 'c08-preview.png') })
  const j1 = await confirmRestore(page, '验收恢复空间C08')
  const targetId = j1.targetWorkspaceId
  rec('C08', '恢复完成且提交后核对无异常', j1.phase === 'done' && j1.verifyProblems.length === 0 && j1.result.alreadyCommitted === false, JSON.stringify(j1.verifyProblems))
  const dir = await dirList(page)
  const rw = dir.find((w) => w.id === targetId)
  rec('C08', '新空间独立目录：非 personal/demo，is_demo=false，带恢复回执', !!rw && targetId !== 'personal' && targetId !== 'demo' && rw.is_demo === false && !!rw.receipt, targetId)
  // 精确比较：源 personal 快照 + 资产哈希（排除新增目录/新空间协调）
  const srcAfter = await snapOf(page, 'personal')
  const srcSeedDocs = JSON.stringify(SEED.slice().sort((a, b) => a.id < b.id ? -1 : 1))
  const srcNowDocs = JSON.stringify(srcAfter.docs.slice().sort((a, b) => a.id < b.id ? -1 : 1))
  rec('C08', '静态源：personal docs 逐字段不变', srcNowDocs === srcSeedDocs, '')
  rec('C08', '静态源：图片资产哈希不变', srcAfter.img[K.imgSource] === PNG_SHA, '')

  // 独立 source→target 映射（按不变事实匹配，不调用被测 remap）
  const tgt = await snapOf(page, targetId)
  const m = {}
  m[K.textSource] = (tgt.sources.find((s) => s.kind === 'text' && s.text === TEXT) || {}).id
  m[K.imgSource] = (tgt.sources.find((s) => s.kind === 'image' && tgt.img[s.id] === PNG_SHA) || {}).id
  for (const t0 of SEED.filter((d) => d.kind === 'task')) {
    const hit = tgt.docs.find((d) => d.kind === 'task' && d.created_at === t0.created_at)
    if (hit) m[t0.id] = hit.id
  }
  for (const p0 of SEED.filter((d) => d.kind === 'plan_item')) {
    const hit = tgt.docs.find((d) => d.kind === 'plan_item' && d.date === p0.date && d.action_text === p0.action_text)
    if (hit) m[p0.id] = hit.id
  }
  for (const s0 of SEED.filter((d) => d.kind === 'focus_session')) {
    const hit = tgt.docs.find((d) => d.kind === 'focus_session' && d.started_at === s0.started_at)
    if (hit) m[s0.id] = hit.id
  }
  for (const n0 of SEED.filter((d) => d.kind === 'note')) {
    const hit = tgt.docs.find((d) => d.kind === 'note' && d.source_id === m[n0.source_id])
    if (hit) m[n0.id] = hit.id
  }
  // 行动：按 (映射任务, text, minutes) 分组配对（同名 twins 作集合）
  const srcActs = SEED.filter((d) => d.kind === 'action')
  const tgtActs = tgt.docs.filter((d) => d.kind === 'action')
  const usedT = new Set()
  for (const a0 of srcActs) {
    const hit = tgtActs.find((a) => !usedT.has(a.id) && a.task_id === m[a0.task_id] && a.text === a0.text && a.minutes === a0.minutes)
    if (hit) { m[a0.id] = hit.id; usedT.add(hit.id) }
  }
  const srcIds = new Set([...SEED.map((d) => d.id), K.textSource, K.imgSource])
  const mappedVals = Object.values(m)
  const allNew = mappedVals.every((id) => id && !srcIds.has(id))
  const bijective = new Set(mappedVals).size === mappedVals.length && mappedVals.length === 21
  rec('C08', '独立映射：21 个对象全部新 ID，双射无复用', allNew && bijective && Object.keys(m).length === 21, `mapped=${Object.keys(m).length}`)
  const byId = new Map(tgt.docs.map((d) => [d.id, d]))
  const sessOk = SEED.filter((d) => d.kind === 'focus_session').every((s0) => {
    const s1 = byId.get(m[s0.id])
    return s1 && s1.task_id === m[s0.task_id] && s1.action_id === m[s0.action_id] && s1.plan_item_id === (s0.plan_item_id ? m[s0.plan_item_id] : null)
  })
  const planOk = SEED.filter((d) => d.kind === 'plan_item').every((p0) => {
    const p1 = byId.get(m[p0.id])
    return p1 && p1.task_id === m[p0.task_id] && p1.focus_session_id === (p0.focus_session_id ? m[p0.focus_session_id] : null)
  })
  rec('C08', '会话→任务/行动/安排引用全部按映射重写', sessOk, '')
  rec('C08', '安排→任务/会话反向引用闭合（双向）', planOk, '')
  const T1 = byId.get(m[K.T])
  const noteRefOk = T1.current_action_id === m[K.A1] && (!T1.deadline || !T1.deadline.from_note_id || T1.deadline.from_note_id === m[K.textNote])
  rec('C08', '任务当前行动与截止来源引用按映射重写', noteRefOk, '')
  const DT0 = SEED.find((d) => d.id === K.DT); const DT1 = byId.get(m[K.DT])
  const U0 = SEED.find((d) => d.id === K.U); const U1 = byId.get(m[K.U])
  const T0 = SEED.find((d) => d.id === K.T)
  rec('C08', '截止值/精度原样保留：datetime naive 原文、date、无截止不补 23:59', JSON.stringify(DT1.deadline) === JSON.stringify(DT0.deadline) && DT1.deadline.value === `${D4}T17:30` && DT1.deadline.precision === 'datetime' && JSON.stringify(T1.deadline) === JSON.stringify(T0.deadline) && JSON.stringify(U1.deadline) === JSON.stringify(U0.deadline), JSON.stringify({ DT: DT1.deadline, U: U1.deadline }))
  const factsOk = SEED.filter((d) => d.kind === 'focus_session').every((s0) => {
    const s1 = byId.get(m[s0.id])
    return s1 && s1.draft_md === s0.draft_md && s1.accumulated_ms === s0.accumulated_ms && s1.outcome === s0.outcome && s1.blocker === s0.blocker && s1.started_at === s0.started_at && s1.ended_at === s0.ended_at && JSON.stringify(s1.task_snapshot) === JSON.stringify(s0.task_snapshot) && JSON.stringify(s1.action_snapshot) === JSON.stringify(s0.action_snapshot)
  })
  rec('C08', '成果/卡点/累计/起止/快照原事实保留', factsOk, '')
  const P10 = SEED.find((d) => d.id === K.P1); const P11 = byId.get(m[K.P1])
  const p1Sess = tgt.docs.filter((d) => d.kind === 'focus_session' && d.plan_item_id === m[K.P1])
  const sum = p1Sess.reduce((n, s) => n + s.accumulated_ms, 0)
  rec('C08', '多段累计只向下取整一次：P1 actual=1min，两段和≥79s', P11.actual_minutes === P10.actual_minutes && P11.actual_minutes === 1 && p1Sess.length === 2 && sum >= 79000, `sum=${sum}`)
  const statesOk = SEED.filter((d) => d.kind === 'plan_item').every((p0) => byId.get(m[p0.id]).state === p0.state)
  rec('C08', '安排状态原样（done/partial/cancelled/planned）', statesOk, '')
  const imgOk = await page.evaluate(async ([ws, sid]) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    const s = await db.readWorkspaceSnapshot(ws)
    const src = s.sources.find((x) => x.id === sid)
    if (!src || !src.blob) return false
    const bmp = await createImageBitmap(src.blob)
    return bmp.width === 1 && bmp.height === 1
  }, [targetId, m[K.imgSource]])
  rec('C08', '图片字节哈希相等且页面可解码打开', tgt.img[m[K.imgSource]] === PNG_SHA && imgOk, '')
  const FORBIDDEN = ['owner_id', 'lease_expires_at', 'epoch', 'revision', 'draft_seq']
  const noForbidden = tgt.docs.every((d) => FORBIDDEN.every((k) => !(k in d)))
  const kindsOk = tgt.docs.every((d) => ['note', 'matter', 'task', 'action', 'focus_session', 'plan_item'].includes(d.kind))
  const rtTgt = await page.evaluate(async (ws) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    return (await db.allFocusRuntime()).records.filter((r) => r.workspace_id === ws)
  }, targetId)
  const runRec = rtTgt.find((r) => r.kind === 'running')
  const opsRec = rtTgt.find((r) => r.kind === 'ops')
  const rtOk = rtTgt.length === 2 && runRec && runRec.session_id === null && opsRec && opsRec.entries.length === 0 && opsRec.stale.length === 0 && !rtTgt.some((r) => r.kind === 'session' || r.kind === 'plan_ops')
  rec('C08', '不导入旧 owner/租约/台账/草稿：禁止键 absent，kind 合法，运行位空+新建空台账', noForbidden && kindsOk && rtOk, `runtime=${rtTgt.map((r) => r.kind).join(',')}`)
  // 修改恢复空间 → 源不受影响（测试辅助写库，披露）
  await page.getByRole('button', { name: '进入恢复空间' }).click()
  await page.waitForTimeout(1200)
  await putDoc(page, { ...T1, title: '恢复空间内后来修改（C08）', updated_at: now() })
  const srcFinal = await snapOf(page, 'personal')
  const srcT = srcFinal.docs.find((d) => d.id === K.T)
  rec('C08', '修改恢复空间后源任务标题不受影响', srcT.title === T0.title && JSON.stringify(srcFinal.docs.slice().sort((a, b) => a.id < b.id ? -1 : 1)) === srcSeedDocs, '')
  await page.screenshot({ path: join(OUT, 'c08-restored-today.png') })
  await context.close()
}

// ============ C09 删除后历史 ZIP：真实导出→恢复不复活已删对象 ============
{
  const { context, page } = await fresh()
  await openTaskDelete(page)
  await adlg(page).getByRole('button', { name: '删除任务', exact: true }).click()
  await page.waitForTimeout(900)
  const exp = await exportViaUI(page, join(ZIPDIR, 'deleted-history.zip'))
  rec('C09', '删除后真实 DataPage 导出（字节+SHA-256 留档）', exp.bytes > 0 && exp.sha256.length === 64, `${exp.bytes}B ${exp.sha256.slice(0, 12)}…`)
  const deletedZip = readFileSync(join(ZIPDIR, 'deleted-history.zip'))
  await context.close()

  const { context: c2, page: p2 } = await fresh(false) // 全新空库
  const j0 = await previewFile(p2, deletedZip, 'deleted-history.zip')
  const c = j0.preview.counts
  rec('C09', '预览计数=删除后事实（12 条：3 安排/1 行动/4 会话/2 任务/2 便签）', c.plan_item === 3 && c.action === 1 && c.focus_session === 4 && c.task === 2 && c.note === 2, JSON.stringify(c))
  const j1 = await confirmRestore(p2, '删除历史恢复C09')
  const tgt = await snapOf(p2, j1.targetWorkspaceId)
  const T0 = SEED.find((d) => d.id === K.T)
  const noResurrect = !tgt.docs.some((d) => d.kind === 'task' && d.title === T0.title) && !tgt.docs.some((d) => d.kind === 'action' && ['整理材料', '写初稿', '同名对照行动'].includes(d.text)) && tgt.docs.filter((d) => d.kind === 'plan_item').length === 3
  rec('C09', '已删任务/行动/无引用安排不复活', noResurrect, '')
  const histDeleted = tgt.docs.filter((d) => d.kind === 'plan_item').every((p) => p.task_ref_state === 'deleted')
  const tSess = tgt.docs.filter((d) => d.kind === 'focus_session' && d.task_snapshot && d.task_snapshot.title === T0.title)
  const sessDeleted = tSess.length === 3 && tSess.every((s) => s.task_ref_state === 'deleted' && s.action_ref_state === 'deleted')
  rec('C09', '历史安排/会话引用保持 deleted，不悬空成活跃', histDeleted && sessDeleted, `tSess=${tSess.length}`)
  const s0 = SEED.find((d) => d.kind === 'focus_session' && d.task_id === K.T && d.plan_item_id === K.P1)
  const s1 = tgt.docs.find((d) => d.kind === 'focus_session' && d.started_at === s0.started_at)
  rec('C09', '历史成果原事实保留（正文/累计/卡点）', s1.draft_md === s0.draft_md && s1.accumulated_ms === s0.accumulated_ms && s1.outcome === s0.outcome, '')
  await p2.getByRole('button', { name: '进入恢复空间' }).click()
  await p2.waitForTimeout(1200)
  await goto(p2, `#/work-records/${s1.id}`)
  const bodyVisible = await p2.getByText(s1.draft_md.slice(0, 12)).count()
  const badge = await p2.getByText('已删除').count()
  rec('C09', '恢复空间内记录详情可读成果并标注引用已删除', bodyVisible > 0 && badge > 0, '')
  await p2.screenshot({ path: join(OUT, 'c09-deleted-history-record.png') })
  await c2.close()
}

// ============ C10 运行中/暂停中导出恢复（第二页导出，不绕过离开保护） ============
async function unfinishedBranch(label, pauseBeforeExport, zipName) {
  const { context, page } = await fresh()
  await startIndependent(page)
  const running0 = (await readDocs(page)).find((d) => d.kind === 'focus_session' && d.ended_at == null)
  await page.getByLabel('本次成果正文').fill(`${label}导出前的真实草稿。`)
  await page.getByRole('button', { name: '暂停', exact: true }).click() // 暂停触发检查点：草稿+累计落库
  await page.waitForTimeout(900)
  if (!pauseBeforeExport) {
    await page.getByRole('button', { name: '继续计时', exact: true }).click()
    await page.waitForTimeout(600)
  }
  const srcAtExport = await docOf(page, running0.id)
  rec('C10', `${label}：导出前源会话状态正确（${pauseBeforeExport ? '暂停' : '运行'}，草稿已落库）`, srcAtExport.running === !pauseBeforeExport && srcAtExport.ended_at == null && srcAtExport.draft_md.includes('导出前的真实草稿'), `running=${srcAtExport.running}`)
  const pageB = await newPageB(context, '#/data')
  const exp = await exportViaUI(pageB, join(ZIPDIR, zipName))
  rec('C10', `${label}：第二页真实导出成功`, exp.bytes > 0, `${exp.bytes}B`)
  const zip = readFileSync(join(ZIPDIR, zipName))
  const j0 = await previewFile(pageB, zip, zipName)
  rec('C10', `${label}：预览未结束工作=1`, j0.preview.unfinishedCount === 1, '')
  const j1 = await confirmRestore(pageB, `${label}恢复C10`)
  const targetId = j1.targetWorkspaceId
  const tgt = await snapOf(pageB, targetId)
  const t1 = tgt.docs.find((d) => d.kind === 'focus_session' && d.started_at === srcAtExport.started_at)
  rec('C10', `${label}：恢复目标 running=false/timer_anchor=null，草稿/累计/started_at 保留`, t1.running === false && t1.ended_at == null && t1.timer_anchor_at == null && t1.draft_md === srcAtExport.draft_md && t1.accumulated_ms === srcAtExport.accumulated_ms && t1.started_at === srcAtExport.started_at, `acc=${t1.accumulated_ms}`)
  const rt = await pageB.evaluate(async ([ws, sid]) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    const all = (await db.allFocusRuntime()).records.filter((r) => r.workspace_id === ws)
    return { all, sess: all.find((r) => r.id.includes(sid)) }
  }, [targetId, t1.id])
  const placeholderOk = rt.sess && String(rt.sess.owner_id).startsWith('restore-placeholder:') && rt.sess.lease_expires_at < Date.now()
  const runSlot = rt.all.find((r) => r.kind === 'running')
  rec('C10', `${label}：占位持有者租约已过期，运行位为空，不自动计时`, placeholderOk && runSlot && runSlot.session_id === null, JSON.stringify({ kinds: rt.all.map((r) => r.kind), owner: rt.sess && rt.sess.owner_id, lease: rt.sess && rt.sess.lease_expires_at }))
  await pageB.waitForTimeout(3000)
  const t2 = (await snapOf(pageB, targetId)).docs.find((d) => d.id === t1.id)
  rec('C10', `${label}：静置 3s 累计不增长（无自动计时）`, t2.accumulated_ms === t1.accumulated_ms, '')
  const srcNow = await docOf(page, running0.id)
  const srcIntact = srcNow.running === !pauseBeforeExport && srcNow.ended_at == null && srcNow.started_at === srcAtExport.started_at && srcNow.draft_md === srcAtExport.draft_md && srcNow.accumulated_ms >= srcAtExport.accumulated_ms
  rec('C10', `${label}：源会话不被恢复修改（运行中自然检查点增长合法）`, srcIntact, `srcAcc=${srcNow.accumulated_ms}≥${srcAtExport.accumulated_ms}`)
  await pageB.screenshot({ path: join(OUT, `c10-${pauseBeforeExport ? 'paused' : 'running'}-restored.png`) })
  return { context, page, pageB, targetId, targetSessionId: t1.id, srcSessionId: running0.id }
}
const runningBranch = await unfinishedBranch('运行中', false, 'running-source.zip')
await runningBranch.context.close()
const pausedBranch = await unfinishedBranch('暂停中', true, 'paused-source.zip')

// ============ C11 恢复空间继续真实工作：接管→核对→显式继续→间隔不计 ============
{
  const { context, page, pageB, targetId, targetSessionId, srcSessionId } = pausedBranch
  await pageB.getByRole('button', { name: '进入恢复空间' }).click()
  await pageB.waitForTimeout(1200)
  await goto(pageB, `#/work/${targetSessionId}`)
  await pageB.getByRole('button', { name: '恢复编辑（接管）' }).waitFor({ timeout: 8000 })
  await pageB.screenshot({ path: join(OUT, 'c11-takeover-panel.png') })
  await pageB.getByRole('button', { name: '恢复编辑（接管）' }).click()
  await pageB.getByText('待恢复确认').waitFor({ timeout: 8000 })
  const before = (await snapOf(pageB, targetId)).docs.find((d) => d.id === targetSessionId).accumulated_ms
  await pageB.locator('input[type="radio"][value="keep"]').check()
  await pageB.getByRole('button', { name: '核对用时（保持暂停）' }).click()
  await pageB.waitForTimeout(1000)
  const afterKeep = (await snapOf(pageB, targetId)).docs.find((d) => d.id === targetSessionId)
  rec('C11', '接管→保留已保存用时：核对后仍暂停，间隔不计入', afterKeep.running === false && afterKeep.accumulated_ms === before, `acc=${afterKeep.accumulated_ms}`)
  await pageB.getByRole('button', { name: '继续计时', exact: true }).click()
  await pageB.waitForTimeout(6000) // 真实计时 6s
  await pageB.getByRole('button', { name: '暂停', exact: true }).click()
  await pageB.waitForTimeout(900)
  const afterRun = (await snapOf(pageB, targetId)).docs.find((d) => d.id === targetSessionId)
  const delta = afterRun.accumulated_ms - before
  rec('C11', '显式继续后真实计时增长（≥5s，不含接管前间隔）', delta >= 5000 && delta < 60000, `delta=${delta}ms`)
  await endWork(pageB, { outcome: 'partial', text: 'C11 恢复空间内继续工作的真实成果。' })
  const ended = (await snapOf(pageB, targetId)).docs.find((d) => d.id === targetSessionId)
  rec('C11', '恢复空间内结束并保存：ended_at 落库，成果保留', ended.ended_at != null && ended.draft_md.includes('C11 恢复空间内继续工作的真实成果'), '')
  const srcSess = (await snapOf(page, 'personal')).docs.find((d) => d.id === srcSessionId)
  rec('C11', '源空间会话不受恢复空间操作影响（仍暂停未结束）', srcSess.running === false && srcSess.ended_at == null, '')
  await pageB.screenshot({ path: join(OUT, 'c11-ended.png') })
  await context.close()
}

// ============ C12 失败注入：尾部写入/配额零残留 + 同意图重试 + 提交后反馈失败幂等 ============
const armAddFail = (page, storeName, errName) => page.evaluate(([store, ename]) => {
  window.__origAdd = IDBObjectStore.prototype.add
  window.__addFired = false
  IDBObjectStore.prototype.add = function (...a) {
    if (this.name === store && !window.__addFired) {
      window.__addFired = true
      const e = new Error(ename === 'QuotaExceededError' ? '注入：配额不足' : '注入：尾部协调写入失败')
      if (ename) e.name = ename
      throw e
    }
    return window.__origAdd.apply(this, a)
  }
}, [storeName, errName])
const disarmAdd = (page) => page.evaluate(() => { IDBObjectStore.prototype.add = window.__origAdd })
const armFeedbackFail = (page) => page.evaluate(() => {
  window.__origTx = IDBDatabase.prototype.transaction
  window.__origCD = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')
  window.__origAD = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'onabort')
  window.__fbFired = false
  const cd = window.__origCD; const ad = window.__origAD
  IDBDatabase.prototype.transaction = function (names, mode) {
    const t = window.__origTx.call(this, names, mode)
    if (mode === 'readwrite' && Array.isArray(names) && ['workspaces', 'sources', 'docs', 'focus_runtime'].every((n) => names.includes(n))) t.__failFeedback = true
    return t
  }
  Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
    configurable: true,
    set(fn) {
      if (this.__failFeedback && !window.__fbFired) {
        cd.set.call(this, () => { window.__fbFired = true; const ab = this.__af; if (ab) ab.call(this, new Event('abort')) })
      } else cd.set.call(this, fn)
    },
    get() { return cd.get.call(this) },
  })
  Object.defineProperty(IDBTransaction.prototype, 'onabort', {
    configurable: true,
    set(fn) { if (this.__failFeedback) { this.__af = fn; ad.set.call(this, () => {}) } else ad.set.call(this, fn) },
    get() { return ad.get.call(this) },
  })
})
const disarmFeedback = (page) => page.evaluate(() => {
  IDBDatabase.prototype.transaction = window.__origTx
  Object.defineProperty(IDBTransaction.prototype, 'oncomplete', window.__origCD)
  Object.defineProperty(IDBTransaction.prototype, 'onabort', window.__origAD)
})
{
  const { context, page } = await fresh(false)
  // a) 尾部写入失败 → 整体回滚零残留 → 同意图重试成功（同一 operationId/目标）
  const db0 = await wholeDB(page)
  await previewFile(page, BASELINE, 'baseline-normal.zip')
  await armAddFail(page, 'focus_runtime', '')
  await page.locator('#restore-name').fill('失败注入C12')
  await page.getByRole('button', { name: '恢复到新空间', exact: true }).click()
  await waitPhase(page, 'error')
  await disarmAdd(page)
  const jErr = await jobInfo(page)
  const retryVisible = await page.getByRole('button', { name: '重试恢复' }).count()
  const banner = await page.getByText('恢复失败，未写入任何数据（原空间不变）').count()
  rec('C12', '尾部写入失败：明确失败横幅 + 可重试（意图已冻结）', jErr.phase === 'error' && banner > 0 && retryVisible > 0 && /尾部协调写入失败/.test(jErr.commitError.message), jErr.commitError && jErr.commitError.code)
  rec('C12', '尾部写入失败零残留：全库逐字段不变，无半截空间', (await wholeDB(page)) === db0, '')
  await page.screenshot({ path: join(OUT, 'c12-tail-write-failed.png') })
  const opId = jErr.operationId; const tgtId = jErr.targetWorkspaceId
  await page.getByRole('button', { name: '重试恢复' }).click()
  await waitPhase(page, 'done')
  const jRetry = await jobInfo(page)
  console.log('  [diag] jRetry=' + JSON.stringify(jRetry))
  const dir1 = await dirList(page)
  const restores1 = dir1.filter((w) => w.receipt)
  rec('C12', '同意图重试：同一 operationId/目标，恰好一个恢复空间', jRetry.operationId === opId && jRetry.targetWorkspaceId === tgtId && restores1.length === 1 && restores1[0].receipt.operation_id === opId && !!jRetry.result && jRetry.result.alreadyCommitted === false, '')
  // b) 再恢复一份 = 新意图新空间（同一文件）
  await page.getByRole('button', { name: '留在当前空间' }).click()
  await page.waitForTimeout(400)
  await previewFile(page, BASELINE, 'baseline-normal.zip')
  const j2 = await confirmRestore(page, '再恢复一份C12')
  const dir2 = await dirList(page)
  const restores2 = dir2.filter((w) => w.receipt)
  rec('C12', '再恢复一份：新意图新空间，同文件哈希两份独立', j2.targetWorkspaceId !== tgtId && restores2.length === 2 && restores2[0].receipt.source_file_hash === restores2[1].receipt.source_file_hash && restores2[0].receipt.operation_id !== restores2[1].receipt.operation_id, '')
  // c) 配额失败 → 零残留 → 重新选择后可恢复
  const db2 = await wholeDB(page)
  await page.getByRole('button', { name: '留在当前空间' }).click()
  await page.waitForTimeout(400)
  await previewFile(page, BASELINE, 'baseline-normal.zip')
  await armAddFail(page, 'docs', 'QuotaExceededError')
  await page.locator('#restore-name').fill('配额注入C12')
  await page.getByRole('button', { name: '恢复到新空间', exact: true }).click()
  await waitPhase(page, 'error')
  await disarmAdd(page)
  const jQ = await jobInfo(page)
  rec('C12', '配额失败：RESTORE_QUOTA 明确报告', jQ.commitError && jQ.commitError.code === 'RESTORE_QUOTA', jQ.commitError && jQ.commitError.message)
  rec('C12', '配额失败零残留', (await wholeDB(page)) === db2, '')
  await page.getByRole('button', { name: '重新选择', exact: true }).click()
  await page.waitForTimeout(300)
  await previewFile(page, BASELINE, 'baseline-normal.zip')
  const j3 = await confirmRestore(page, '配额后重恢复C12')
  rec('C12', '失败后重新选择恢复成功（状态未中毒）', j3.phase === 'done' && (await dirList(page)).filter((w) => w.receipt).length === 3, '')
  // d) 事务已提交但反馈失败 → 查回执返回原空间，不重复写入
  await page.getByRole('button', { name: '留在当前空间' }).click()
  await page.waitForTimeout(400)
  await previewFile(page, BASELINE, 'baseline-normal.zip')
  await armFeedbackFail(page)
  await page.locator('#restore-name').fill('反馈失败C12')
  await page.getByRole('button', { name: '恢复到新空间', exact: true }).click()
  await waitPhase(page, 'done')
  await disarmFeedback(page)
  const jF = await jobInfo(page)
  const idemBanner = await page.getByText('该备份此前已恢复，返回原恢复空间，未重复写入').count()
  const dirF = await dirList(page)
  const restoresF = dirF.filter((w) => w.receipt)
  const hit = restoresF.find((w) => w.receipt.operation_id === jF.operationId)
  rec('C12', '提交后反馈失败：查回执认定已提交，不重复写入', !!jF.result && jF.result.alreadyCommitted === true && idemBanner > 0 && restoresF.length === 4 && !!hit, `spaces=${restoresF.length}`)
  await page.screenshot({ path: join(OUT, 'c12-feedback-failed-idempotent.png') })
  await context.close()
}

// ============ C13 预览取消/换文件/坏文件精确拒绝（零写入） ============
function craftZip(mutateDocs, updateHash) {
  const files = unzipSync(new Uint8Array(BASELINE))
  const dec = new TextDecoder(); const enc = new TextEncoder()
  const manifest = JSON.parse(dec.decode(files['manifest.json']))
  const docs = JSON.parse(dec.decode(files['data/docs.json']))
  mutateDocs(docs)
  const bytes = enc.encode(JSON.stringify(docs))
  files['data/docs.json'] = bytes
  if (updateHash) {
    const p = manifest.payloads.find((x) => x.path === 'data/docs.json')
    p.bytes = bytes.length; p.sha256 = sha(bytes)
    files['manifest.json'] = enc.encode(JSON.stringify(manifest))
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}
{
  const { context, page } = await fresh(false)
  const db0 = await wholeDB(page)
  const j0 = await previewFile(page, BASELINE, 'baseline-normal.zip')
  // 取消重选：打开文件选择器后清空 → 仍停留预览，零写入
  const fcPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '重新选择', exact: true }).click()
  const fc = await fcPromise
  await fc.setFiles([])
  await page.waitForTimeout(500)
  const jAfterCancel = await jobInfo(page)
  rec('C13', '取消重选：仍停留预览且全库零写入', jAfterCancel.phase === 'preview' && (await wholeDB(page)) === db0, '')
  // 换文件：坏 ZIP（中部字节翻转）→ 精确拒绝
  const corruptMid = Buffer.from(BASELINE); corruptMid[Math.floor(corruptMid.length / 2)] ^= 0xff
  await setFile(page, corruptMid, 'corrupt-mid.zip')
  await waitPhase(page, 'error')
  let j = await jobInfo(page)
  const rejectBanner = await page.getByText('无法恢复此备份，未写入任何数据').count()
  rec('C13', '换文件：中部损坏 ZIP 精确拒绝，零写入', j.phase === 'error' && rejectBanner > 0 && (await wholeDB(page)) === db0, j.commitError && j.commitError.code)
  // 尾部损坏（中央目录）
  const corruptTail = Buffer.from(BASELINE); corruptTail[corruptTail.length - 30] ^= 0x5a
  await setFile(page, corruptTail, 'corrupt-tail.zip')
  await waitPhase(page, 'error')
  j = await jobInfo(page)
  rec('C13', '尾部损坏 ZIP 精确拒绝，零写入', j.phase === 'error' && (await wholeDB(page)) === db0, j.commitError && j.commitError.code)
  // 截断
  await setFile(page, BASELINE.subarray(0, Math.floor(BASELINE.length / 2)), 'truncated.zip')
  await waitPhase(page, 'error')
  j = await jobInfo(page)
  rec('C13', '截断 ZIP 精确拒绝，零写入', j.phase === 'error' && (await wholeDB(page)) === db0, j.commitError && j.commitError.code)
  // 哈希不符（改 docs 不更新 manifest）
  const hashMismatch = craftZip((docs) => { docs.find((d) => d.kind === 'task').title = '哈希不符样本' }, false)
  await setFile(page, hashMismatch, 'hash-mismatch.zip')
  await waitPhase(page, 'error')
  j = await jobInfo(page)
  rec('C13', '载荷哈希不符精确拒绝（A 层），零写入', j.phase === 'error' && (j.errors.length > 0 || /哈希|sha/i.test((j.commitError && j.commitError.message) || '')) && (await wholeDB(page)) === db0, JSON.stringify(j.errors.slice(0, 1)))
  // 非法引用（重算哈希过 A 层，C 层关系拒绝）
  const illegalRefs = craftZip((docs) => { docs.find((d) => d.kind === 'plan_item').task_id = 'task-does-not-exist' }, true)
  await setFile(page, illegalRefs, 'illegal-refs.zip')
  await waitPhase(page, 'error')
  j = await jobInfo(page)
  rec('C13', '非法引用精确拒绝（关系层），不静默丢弃不建空空间', j.phase === 'error' && j.errors.length > 0 && (await wholeDB(page)) === db0, JSON.stringify(j.errors.slice(0, 1)))
  // 禁止键（旧 owner 私塞）
  const forbidden = craftZip((docs) => { docs.find((d) => d.kind === 'focus_session').owner_id = 'old-owner' }, true)
  await setFile(page, forbidden, 'forbidden-key.zip')
  await waitPhase(page, 'error')
  j = await jobInfo(page)
  rec('C13', '禁止键（owner_id）精确拒绝，零写入', j.phase === 'error' && j.errors.length > 0 && (await wholeDB(page)) === db0, JSON.stringify(j.errors.slice(0, 1)))
  await page.screenshot({ path: join(OUT, 'c13-rejection.png') })
  // 拒绝后正常文件仍可恢复
  await previewFile(page, BASELINE, 'baseline-normal.zip')
  const jOk = await confirmRestore(page, '拒绝后正常恢复C13')
  rec('C13', '连续拒绝后正常恢复成功（导入器未放宽也未中毒）', jOk.phase === 'done' && jOk.verifyProblems.length === 0 && (await dirList(page)).filter((w) => w.receipt).length === 1, '')
  await context.close()
}

await browser.close()
writeFileSync(join(OUT, 'c08-results.json'), JSON.stringify({
  at: now(),
  seed: 'c01-docs-snapshot.json（C01 真实页面生成；测试辅助复制进独立 Context）',
  baseline: INV.zip,
  injections: 'C12 一次性 IDB 原型包装（尾部写入/配额/提交后反馈），触发即还原；C13 fflate 重打包非法样本（披露）',
  results,
}, null, 2))
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
console.log(`c08 exit=${failed.length ? 1 : 0}`)
process.exit(failed.length ? 1 : 0)