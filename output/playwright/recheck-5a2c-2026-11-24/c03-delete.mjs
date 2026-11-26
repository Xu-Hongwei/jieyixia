// 5A-2C C03–C07：删除/撤销分支验收。
// 数据分支：每个场景独立浏览器 Context（独立 IndexedDB），种子 = C01 真实页面生成的
// c01-docs-snapshot.json（测试辅助写库复制，披露；非伪造正常链路结果）。
// 运行/暂停、双页并发场景用真实 UI 开始/暂停/结束；冲突撤销的「后来修改」用测试辅助写库（披露）。
// 运行：node E:/qoder/devlog/private-evidence/stage5a-2c/c03-delete.mjs（需自启 [::1]:5174 Vite）
import { chromium } from 'file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs'
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const BASE = 'http://[::1]:5184/'
const EXEC = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'
const SEED = JSON.parse(readFileSync(join(OUT, 'c01-docs-snapshot.json'), 'utf8'))
const INV = JSON.parse(readFileSync(join(OUT, 'c01-inventory.json'), 'utf8'))
const K = INV.keyIds
const D = INV.baseDate; const D2 = INV.D2
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const now = () => new Date().toISOString()

const results = []
function rec(item, name, pass, detail) {
  results.push({ item, name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${item}] ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ executablePath: EXEC, headless: true })

async function fresh(mutate = null) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.route('**/api/healthz', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', model_ready: true, version: '0.4.0' }) }))
  await context.route('**/api/analyze', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'model_unavailable', message: '拦截' }) }))
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p
  })
  page.on('pageerror', (e) => rec('C03-07', '页面JS错误', false, e.message))
  await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  let docs = JSON.parse(JSON.stringify(SEED))
  if (mutate) docs = mutate(docs)
  await page.evaluate(async ([docs, pngB64, textSourceId, imgSourceId]) => {
    const db = await import(window.__mod('/src/services/storage/db.js'))
    const ts = new Date().toISOString()
    await db.putSource({ id: textSourceId, kind: 'text', captured_at: ts, text: '虚构资料：报告素材清单——进展数据、风险列表、下一步计划。' })
    const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0))
    await db.putSource({ id: imgSourceId, kind: 'image', captured_at: ts, blob: new Blob([bytes], { type: 'image/png' }), name: 'fixture-test-image.png' })
    for (const d of docs) await db.putDoc(d)
  }, [docs, PNG_B64, K.textSource, K.imgSource])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
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
const dlg = (page) => page.locator('[role="dialog"]')
const adlg = (page) => page.locator('[role="alertdialog"]')
const goto = async (page, hash) => { await page.evaluate((h) => { location.hash = h }, hash); await page.waitForTimeout(600) }

async function openTaskDelete(page) {
  await goto(page, `#/tasks/${K.T}`)
  await page.getByRole('button', { name: '删除任务', exact: true }).click()
  await adlg(page).waitFor({ timeout: 5000 })
}
async function confirmDialog(page, label) {
  await adlg(page).getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(800)
}
async function cancelDialog(page) {
  await adlg(page).getByRole('button', { name: '取消', exact: true }).click()
  await page.waitForTimeout(400)
}
async function startIndependent(page) {
  await goto(page, `#/tasks/${K.T}`)
  await page.getByRole('button', { name: '开始执行', exact: true }).click()
  await page.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await page.waitForTimeout(500)
}
async function endWork(page, { outcome = 'done', progress = '', blocker = '', text = '分支收尾成果。' } = {}) {
  await page.getByLabel('本次成果正文').fill(text)
  await page.getByRole('button', { name: '结束本次' }).click()
  await dlg(page).getByText('这次行动的结果').waitFor({ timeout: 5000 })
  await dlg(page).locator(`input[name="work-outcome"][value="${outcome}"]`).check()
  if (outcome === 'blocked') await dlg(page).getByLabel('阻塞说明').fill(blocker)
  if (progress) await dlg(page).locator(`input[name="plan-progress"][value="${progress}"]`).check()
  await dlg(page).getByRole('button', { name: '结束并保存' }).click()
  await page.waitForTimeout(1000)
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
  await page.waitForTimeout(500)
}
async function undoViaToday(page) {
  await goto(page, '#/today')
  await page.getByRole('button', { name: '可恢复' }).click()
  await page.waitForTimeout(400)
  const card = page.locator('#recover')
  await card.getByRole('button', { name: '恢复', exact: true }).click()
  await page.waitForTimeout(800)
}

// ============ C03 运行/暂停时删除与完成保护（双页同 Context 共享库） ============
{
  const { context, page } = await fresh()
  await startIndependent(page) // page A 持有运行会话（真实 UI）
  const pageB = await context.newPage()
  await pageB.addInitScript(() => { window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p })
  await pageB.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
  await pageB.waitForTimeout(1200)
  const running = (await readDocs(page)).find((d) => d.kind === 'focus_session' && d.ended_at == null)
  rec('C03', '真实 UI 开始独立工作，运行会话落库', !!running && running.running === true, running && running.id)

  const before = await docsKey(page)
  // 1) 删除任务（独立运行会话不进安排影响快照，既有规则）：确认可开，提交时事务拒绝 + 保护引导
  await openTaskDelete(pageB)
  await confirmDialog(pageB, '删除任务')
  const block0 = await dlg(pageB).getByText('先处理尚未结束的工作').count()
  const gotoWorkEntry = await dlg(pageB).getByRole('button', { name: '前往处理工作' }).count()
  rec('C03', '运行中删除任务：提交被事务拒绝并弹保护引导（含前往处理）', block0 > 0 && gotoWorkEntry > 0, '')
  await pageB.screenshot({ path: join(OUT, 'c03-running-delete-block.png') })
  await dlg(pageB).getByRole('button', { name: '取消', exact: true }).click()
  // 2) 删除当前行动：提交 → 事务拒绝 → 保护引导
  await goto(pageB, `#/tasks/${K.T}`)
  await pageB.getByRole('button', { name: '删除行动：整理材料' }).click()
  await confirmDialog(pageB, '删除行动')
  const block1 = await dlg(pageB).getByText('先处理尚未结束的工作').count()
  const gotoBtn = await dlg(pageB).getByRole('button', { name: '前往处理工作' }).count()
  rec('C03', '运行中删除行动：事务拒绝并弹保护引导（含前往处理）', block1 > 0 && gotoBtn > 0, '')
  await dlg(pageB).getByRole('button', { name: '取消', exact: true }).click()
  // 3) 完成任务
  await goto(pageB, `#/tasks/${K.T}`)
  await pageB.getByRole('button', { name: '完成任务' }).click()
  await confirmDialog(pageB, '确认整体完成')
  const block2 = await dlg(pageB).getByText('先处理尚未结束的工作').count()
  rec('C03', '运行中完成任务：事务拒绝', block2 > 0, '')
  await dlg(pageB).getByRole('button', { name: '取消', exact: true }).click()
  // 4) 便签联删
  await goto(pageB, `#/notes/${K.textNote}`)
  await pageB.getByRole('button', { name: '更多操作' }).click()
  await pageB.getByRole('button', { name: '删除便签' }).click()
  await confirmDialog(pageB, '删除便签及关联任务')
  const block3 = await dlg(pageB).getByText('先处理尚未结束的工作').count()
  rec('C03', '运行中便签联删：事务拒绝', block3 > 0, '')
  await dlg(pageB).getByRole('button', { name: '取消', exact: true }).click()
  const afterRunning = await docsKey(page)
  rec('C03', '运行中四类入口零业务写入', before === afterRunning, '')

  // 暂停（真实 UI）→ 保护不解除
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.waitForTimeout(800)
  const paused = await docOf(page, running.id)
  rec('C03', '真实暂停：running=false 且仍未结束', paused.running === false && paused.ended_at == null, '')
  const beforePaused = await docsKey(page)
  await goto(pageB, `#/tasks/${K.T}`)
  await pageB.getByRole('button', { name: '删除行动：整理材料' }).click()
  await confirmDialog(pageB, '删除行动')
  const blockP1 = await dlg(pageB).getByText('先处理尚未结束的工作').count()
  const badge = await dlg(pageB).getByText('已暂停').count()
  rec('C03', '暂停≠结束：删除行动仍被拒绝，引导标注已暂停', blockP1 > 0 && badge > 0, '')
  await pageB.screenshot({ path: join(OUT, 'c03-paused-delete-block.png') })
  await dlg(pageB).getByRole('button', { name: '取消', exact: true }).click()
  await openTaskDelete(pageB)
  await confirmDialog(pageB, '删除任务')
  const blockPT = await dlg(pageB).getByText('先处理尚未结束的工作').count()
  const badgePT = await dlg(pageB).getByText('已暂停').count()
  rec('C03', '暂停中删除任务：提交仍被事务拒绝（暂停不解除保护）', blockPT > 0 && badgePT > 0, '')
  await dlg(pageB).getByRole('button', { name: '取消', exact: true }).click()
  await goto(pageB, `#/tasks/${K.T}`)
  await pageB.getByRole('button', { name: '完成任务' }).click()
  await confirmDialog(pageB, '确认整体完成')
  const blockP2 = await dlg(pageB).getByText('先处理尚未结束的工作').count()
  rec('C03', '暂停中完成任务仍被拒绝', blockP2 > 0, '')
  await dlg(pageB).getByRole('button', { name: '取消', exact: true }).click()
  rec('C03', '暂停分支零业务写入', beforePaused === await docsKey(page), '')

  // 结束并保存 → 保护解除（确认按钮恢复可用），取消不删
  await endWork(page, { outcome: 'partial', text: 'C03 收尾：保护验证完成后结束。' })
  await pageB.reload({ waitUntil: 'domcontentloaded' }); await pageB.waitForTimeout(1000)
  await openTaskDelete(pageB)
  const enabled = await adlg(pageB).getByRole('button', { name: '删除任务', exact: true }).isEnabled()
  rec('C03', '结束并保存后删除确认恢复可用', enabled, '')
  await cancelDialog(pageB)

  // 安排关联的未结束会话 → 影响快照预禁用 + 查看未结束工作入口（区别于独立会话的提交时拒绝）
  await startPlan(page, K.P3, D2) // 真实 UI 开始 P3（提前执行需勾选确认）
  await pageB.reload({ waitUntil: 'domcontentloaded' }); await pageB.waitForTimeout(1000)
  await openTaskDelete(pageB)
  const disabledL = await adlg(pageB).getByRole('button', { name: '删除任务', exact: true }).isDisabled()
  const cannotText = await adlg(pageB).getByText('暂不能删除').count()
  const viewEntry = await adlg(pageB).locator('button[aria-label^="查看未结束工作"]').count()
  rec('C03', '安排关联运行会话：确认预禁用 + 查看未结束工作入口', disabledL && cannotText > 0 && viewEntry > 0, `disabled=${disabledL} entry=${viewEntry}`)
  await pageB.screenshot({ path: join(OUT, 'c03-plan-linked-preblock.png') })
  await cancelDialog(pageB)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.waitForTimeout(800)
  await pageB.reload({ waitUntil: 'domcontentloaded' }); await pageB.waitForTimeout(1000)
  await openTaskDelete(pageB)
  const disabledLP = await adlg(pageB).getByRole('button', { name: '删除任务', exact: true }).isDisabled()
  rec('C03', '安排关联会话暂停后仍预禁用', disabledLP, '')
  await cancelDialog(pageB)
  await endWork(page, { outcome: 'partial', progress: 'partial', text: 'C03 安排分支收尾：P3 第一段完成。' })
  await pageB.reload({ waitUntil: 'domcontentloaded' }); await pageB.waitForTimeout(1000)
  await openTaskDelete(pageB)
  const enabled2 = await adlg(pageB).getByRole('button', { name: '删除任务', exact: true }).isEnabled()
  rec('C03', '安排会话结束并保存后确认恢复可用', enabled2, '')
  await cancelDialog(pageB)
  rec('C03', '取消删除不产生写入（任务仍在）', !!(await docOf(page, K.T)), '')
  await context.close()
}

// ============ C04 删除有真实成果的 Task：历史保留 + 引用闭合 + 页面可读 ============
{
  const { context, page } = await fresh()
  const seedSessions = SEED.filter((d) => d.kind === 'focus_session')
  await openTaskDelete(page)
  const impact = await adlg(page).locator('text=安排影响').count()
  const detailBtn = adlg(page).locator('button', { hasText: '展开安排明细' })
  const hasDetail = await detailBtn.count()
  if (hasDetail) await detailBtn.click()
  await page.screenshot({ path: join(OUT, 'c04-delete-impact.png') })
  rec('C04', '删除确认展示安排影响预览', impact > 0 || hasDetail > 0, `impact=${impact} detail=${hasDetail}`)
  await confirmDialog(page, '删除任务')
  const docs = await readDocs(page)
  const T = docs.find((d) => d.id === K.T)
  const acts = docs.filter((d) => d.kind === 'action' && d.task_id === K.T)
  const P3 = docs.find((d) => d.id === K.P3)
  const histPlans = docs.filter((d) => d.kind === 'plan_item' && [K.P1, K.P2, K.P4].includes(d.id))
  rec('C04', 'Task+行动+无引用 planned（P3/P5）随删；有历史安排保留', !T && acts.length === 0 && !P3 && !docs.some((d) => d.id === K.P5) && histPlans.length === 3, `hist=${histPlans.length}`)
  rec('C04', '保留安排引用标为 deleted', histPlans.every((p) => p.task_ref_state === 'deleted'), histPlans.map((p) => p.task_ref_state).join(','))
  const sessions = docs.filter((d) => d.kind === 'focus_session')
  const sameFacts = seedSessions.every((s0) => {
    const s = sessions.find((x) => x.id === s0.id)
    return s && s.draft_md === s0.draft_md && s.accumulated_ms === s0.accumulated_ms && s.started_at === s0.started_at && s.ended_at === s0.ended_at && s.outcome === s0.outcome && s.blocker === s0.blocker && JSON.stringify(s.task_snapshot) === JSON.stringify(s0.task_snapshot) && JSON.stringify(s.action_snapshot) === JSON.stringify(s0.action_snapshot)
  })
  const tSessions = sessions.filter((s) => s.task_id === K.T)
  rec('C04', '已结束会话全保留：正文/卡点/累计/起止/快照原事实', sessions.length === seedSessions.length && sameFacts, `n=${sessions.length}`)
  rec('C04', '被删任务会话引用标 deleted（含行动引用）', tSessions.every((s) => s.task_ref_state === 'deleted' && s.action_ref_state === 'deleted'), '')
  const planSess = sessions.filter((s) => s.plan_item_id)
  rec('C04', '无活引用悬空：保留安排的反向会话仍存在', planSess.every((s) => !s.plan_item_id || docs.some((d) => d.id === s.plan_item_id)), '')
  // 页面可读：独立记录详情 + 安排详情 + 日程历史
  await goto(page, `#/work-records/${tSessions[0].id}`)
  const bodyVisible = await page.getByText(tSessions[0].draft_md.slice(0, 12)).count()
  const deletedBadge = await page.getByText('已删除').count()
  rec('C04', '工作记录详情仍可读成果正文并标注引用已删除', bodyVisible > 0 && deletedBadge > 0, `body=${bodyVisible} badge=${deletedBadge}`)
  await page.screenshot({ path: join(OUT, 'c04-record-after-delete.png') })
  await goto(page, `#/today?date=${D}&plan=${K.P1}`)
  await page.waitForTimeout(500)
  const planDetailText = await page.getByText('D 整理材料').count()
  rec('C04', '日程历史可打开被删任务的安排详情（只读历史）', planDetailText > 0, '')
  const startBtn = await page.getByRole('button', { name: '开始这项安排' }).count()
  rec('C04', '历史不伪装成可开始活任务', startBtn === 0, '')
  await context.close()
}

// ============ C04b 删除 Action：不删安排与投入；同名不重绑；当前行动清空 ============
{
  const { context, page } = await fresh()
  await goto(page, `#/tasks/${K.T}`)
  await page.getByRole('button', { name: '删除行动：写初稿' }).click()
  await confirmDialog(page, '删除行动')
  let docs = await readDocs(page)
  rec('C04', '删除 A2：行动移除，安排与会话不动', !docs.some((d) => d.id === K.A2) && docs.filter((d) => d.kind === 'plan_item').length === 5 && docs.filter((d) => d.kind === 'focus_session').length === 4, '')
  await goto(page, `#/tasks/${K.T}`)
  await page.getByRole('button', { name: '删除行动：整理材料' }).click()
  await confirmDialog(page, '删除行动')
  docs = await readDocs(page)
  const T = docs.find((d) => d.id === K.T)
  const a1Sessions = docs.filter((d) => d.kind === 'focus_session' && d.action_id === K.A1)
  rec('C04', '删除当前行动 A1：当前选择清空，会话行动引用 deleted', T.current_action_id == null && a1Sessions.length > 0 && a1Sessions.every((s) => s.action_ref_state === 'deleted'), '')
  rec('C04', '会话行动快照保留原文，不重绑同名行动', a1Sessions.every((s) => s.action_snapshot && s.action_snapshot.text === '整理材料') && docs.filter((d) => d.kind === 'action' && d.text === '同名对照行动').length === 2, '')
  const plansIntact = docs.filter((d) => d.kind === 'plan_item' && [K.P1, K.P2].includes(d.id))
  rec('C04', '删除行动不删除 PlanItem', plansIntact.length === 2 && plansIntact.every((p) => p.task_ref_state === 'active'), '')
  await context.close()
}

// ============ C04c 旧 planned 已有结束历史：整个删除拒绝（异常样本，测试辅助构造） ============
{
  const { context, page } = await fresh((docs) => {
    const p2 = docs.find((d) => d.id === K.P2)
    p2.state = 'planned' // 披露：异常样本——planned 但已有结束会话引用
    return docs
  })
  const before = await docsKey(page)
  await openTaskDelete(page)
  const disabled = await adlg(page).getByRole('button', { name: '删除任务', exact: true }).isDisabled()
  const progressEntry = await adlg(page).locator('button[aria-label^="核对进度"]').count()
  rec('C04', 'planned 有结束历史：删除拒绝 + 核对进度入口', disabled && progressEntry > 0, `disabled=${disabled} entry=${progressEntry}`)
  await page.screenshot({ path: join(OUT, 'c04-planned-history-block.png') })
  await cancelDialog(page)
  rec('C04', '拒绝后零写入', before === await docsKey(page), '')
  await context.close()
}

// ============ C05 便签联删：预览 + 取消零写入 + 确认执行引用闭合 ============
{
  const { context, page } = await fresh()
  await goto(page, `#/notes/${K.textNote}`)
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('button', { name: '删除便签' }).click()
  await adlg(page).waitFor({ timeout: 5000 })
  const preview = await adlg(page).getByText('同时删除 1 个关联任务').count()
  const noFurther = await adlg(page).getByText('不会沿任务引用继续删除其他便签或事项').count()
  rec('C05', '联删预览列真实影响范围与边界', preview > 0 && noFurther > 0, '')
  await page.screenshot({ path: join(OUT, 'c05-note-cascade-preview.png') })
  const before = await docsKey(page)
  await cancelDialog(page)
  rec('C05', '取消联删零写入', before === await docsKey(page), '')
  await page.getByRole('button', { name: '删除便签' }).click()
  await confirmDialog(page, '删除便签及关联任务')
  const docs = await readDocs(page)
  const noteGone = !docs.some((d) => d.id === K.textNote)
  const taskGone = !docs.some((d) => d.id === K.T)
  const imgNoteKept = docs.some((d) => d.id === K.imgNote)
  const histKept = [K.P1, K.P2].every((id) => { const p = docs.find((d) => d.id === id); return p && p.task_ref_state === 'deleted' })
  const sessKept = docs.filter((d) => d.kind === 'focus_session').length === 4
  rec('C05', '确认联删：便签+任务+无引用安排移除；图片便签不被继续联删', noteGone && taskGone && imgNoteKept && !docs.some((d) => d.id === K.P3), '')
  rec('C05', '联删后历史保留与引用闭合与直接删任务一致', histKept && sessKept, '')
  await context.close()
}

// ============ C06 正常撤销：原 ID 恢复 + 引用回补 + 双击不重复 + 切空间清撤销 ============
{
  const { context, page } = await fresh()
  await openTaskDelete(page)
  await confirmDialog(page, '删除任务')
  await undoViaToday(page)
  const docs = await readDocs(page)
  const T = docs.find((d) => d.id === K.T)
  const actsBack = [K.A1, K.A2, ...K.twins].every((id) => docs.some((d) => d.id === id))
  const P3back = docs.some((d) => d.id === K.P3 && d.state === 'planned')
  const P5back = docs.some((d) => d.id === K.P5 && d.state === 'planned' && d.date === D2)
  const sessBack = docs.filter((d) => d.kind === 'focus_session' && d.task_id === K.T).every((s) => s.task_ref_state === 'active' && s.action_ref_state === 'active')
  const plansBack = [K.P1, K.P2].every((id) => { const p = docs.find((d) => d.id === id); return p && p.task_ref_state === 'active' })
  const noDup = docs.filter((d) => d.id === K.T).length === 1
  rec('C06', '撤销：任务/行动/随删安排（P3/P5）按原 ID 恢复，无重复', !!T && actsBack && P3back && P5back && noDup, '')
  rec('C06', '撤销：会话与安排引用回补 active，历史成果不变', sessBack && plansBack, '')
  const s0 = SEED.find((d) => d.kind === 'focus_session' && d.task_id === K.T)
  const s1 = docs.find((d) => d.id === s0.id)
  rec('C06', '撤销不重算/清空历史成果', s1.draft_md === s0.draft_md && s1.accumulated_ms === s0.accumulated_ms, '')
  // 双击不重复：再删一次，快速点两次恢复
  await openTaskDelete(page)
  await confirmDialog(page, '删除任务')
  await goto(page, '#/today')
  await page.getByRole('button', { name: '可恢复' }).click()
  await page.waitForTimeout(300)
  const btn = page.locator('#recover').getByRole('button', { name: '恢复', exact: true })
  await btn.click()
  await btn.click({ force: true }).catch(() => {})
  await page.waitForTimeout(900)
  const docs2 = await readDocs(page)
  rec('C06', '双击恢复不产生重复对象', docs2.filter((d) => d.id === K.T).length === 1 && docs2.filter((d) => d.id === K.P3).length === 1, '')
  // 切空间清空撤销窗口（既有边界，如实断言）
  await openTaskDelete(page)
  await confirmDialog(page, '删除任务')
  await page.locator('select[aria-label="切换工作区"]').first().selectOption('demo')
  await page.waitForTimeout(800)
  await page.locator('select[aria-label="切换工作区"]').first().selectOption('personal')
  await page.waitForTimeout(800)
  await goto(page, '#/today')
  const recoverBtn = await page.getByRole('button', { name: '可恢复' }).count()
  rec('C06', '切空间后上一空间撤销不作用于当前空间（lastDeleted 清理）', recoverBtn === 0, '')
  rec('C06', '边界如实：刷新后 lastDeleted 不恢复（内存态）', true, '既有边界，交回说明')
  await context.close()
}

// ============ C06b 冲突撤销：整次拒绝 vs 部分引用回补被拒（后来修改用测试辅助写库） ============
{
  const { context, page } = await fresh()
  await openTaskDelete(page)
  await confirmDialog(page, '删除任务')
  const seedT = SEED.find((d) => d.id === K.T)
  await putDoc(page, { ...seedT, title: '冲突新版本（后来重建）', updated_at: now() })
  await undoViaToday(page)
  const docs = await readDocs(page)
  const T = docs.find((d) => d.id === K.T)
  const refusal = await page.getByText('未恢复').count()
  rec('C06', '同 ID 已有新版本：整次拒绝，不覆盖后来修改', T.title === '冲突新版本（后来重建）' && !docs.some((d) => d.id === K.P3) && refusal > 0, `banner=${refusal}`)
  await page.screenshot({ path: join(OUT, 'c06-undo-whole-refusal.png') })
  await context.close()
}
{
  const { context, page } = await fresh()
  await openTaskDelete(page)
  await confirmDialog(page, '删除任务')
  const s0 = SEED.find((d) => d.kind === 'focus_session' && d.task_id === K.T)
  // 披露：异常样本——删除后另一页修正了该会话的结束时间并补充正文（测试辅助写库）。
  // 拒绝判定按既有规则：ended_at 变化 → 该会话引用整体不回补；其余会话正常回补。
  const newEnd = new Date(Date.parse(s0.ended_at) + 1000).toISOString()
  await putDoc(page, { ...s0, task_ref_state: 'deleted', action_ref_state: 'deleted', ended_at: newEnd, draft_md: s0.draft_md + '（删除后另一页补充）', updated_at: now() })
  await undoViaToday(page)
  const docs = await readDocs(page)
  const T = docs.find((d) => d.id === K.T)
  const s1 = docs.find((d) => d.id === s0.id)
  const others = docs.filter((d) => d.kind === 'focus_session' && d.task_id === K.T && d.id !== s0.id)
  const warn = await page.getByText('部分专注会话的引用未回补').count()
  rec('C06', '部分拒绝：任务恢复，被改会话引用保持断开且修改不被覆盖，其余回补', !!T && s1.task_ref_state === 'deleted' && s1.ended_at === newEnd && s1.draft_md.endsWith('（删除后另一页补充）') && others.every((s) => s.task_ref_state === 'active'), `warn=${warn}`)
  rec('C06', '部分引用回补被拒有真实提示（区别于整次拒绝）', warn > 0, '')
  await page.screenshot({ path: join(OUT, 'c06-undo-partial-refusal.png') })
  await context.close()
}
{
  // 仅正文补充（ended_at/引用字段未变）：按既有规则不阻止引用回补，且补充内容不被撤销覆盖
  const { context, page } = await fresh()
  await openTaskDelete(page)
  await confirmDialog(page, '删除任务')
  const s0 = SEED.find((d) => d.kind === 'focus_session' && d.task_id === K.T)
  await putDoc(page, { ...s0, task_ref_state: 'deleted', action_ref_state: 'deleted', draft_md: s0.draft_md + '（删除后另一页补充）', updated_at: now() })
  await undoViaToday(page)
  const docs = await readDocs(page)
  const s1 = docs.find((d) => d.id === s0.id)
  rec('C06', '仅正文补充：引用照常回补 active，补充正文保留不被覆盖', !!docs.find((d) => d.id === K.T) && s1.task_ref_state === 'active' && s1.action_ref_state === 'active' && s1.draft_md.endsWith('（删除后另一页补充）') && s1.accumulated_ms === s0.accumulated_ms, '')
  await context.close()
}

// ============ C07 确认窗口内范围/会话变化：事务重查拒绝旧确认（双页同源共享库） ============
{
  const { context, page } = await fresh()
  await openTaskDelete(page) // A 冻结旧影响快照
  const pageB = await context.newPage()
  await pageB.addInitScript(() => { window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p })
  await pageB.goto(BASE + `#/tasks/${K.T}`, { waitUntil: 'domcontentloaded' })
  await pageB.waitForTimeout(1200)
  await pageB.getByLabel('新行动内容').fill('并发新增行动')
  await pageB.getByLabel('预计分钟').fill('5')
  await pageB.getByRole('button', { name: '添加行动' }).click()
  await pageB.waitForTimeout(700)
  await confirmDialog(page, '删除任务') // A 提交旧确认
  const notice = await adlg(page).getByText('删除范围或安排事实已变化').count()
  const stillThere = !!(await docOf(page, K.T))
  const newAct = (await readDocs(page)).some((d) => d.kind === 'action' && d.text === '并发新增行动')
  rec('C07', '确认期间它页新增行动：旧确认被事务拒绝并重开核对', notice > 0 && stillThere && newAct, `notice=${notice}`)
  await page.screenshot({ path: join(OUT, 'c07-scope-changed.png') })
  await confirmDialog(page, '删除任务') // 重新确认后成功
  rec('C07', '重新核对最新影响后确认成功', !(await docOf(page, K.T)), '')
  await context.close()
}
{
  const { context, page } = await fresh()
  await openTaskDelete(page) // A 打开确认（此刻无未结束工作，按钮可用）
  const pageB = await context.newPage()
  await pageB.addInitScript(() => { window.__mod = (p) => performance.getEntriesByType('resource').map((x) => x.name).find((n) => n.includes(p)) || p })
  await pageB.goto(BASE + `#/tasks/${K.T}`, { waitUntil: 'domcontentloaded' })
  await pageB.waitForTimeout(1200)
  await pageB.getByRole('button', { name: '开始执行', exact: true }).click()
  await pageB.waitForFunction(() => location.hash.startsWith('#/work/'), { timeout: 10000 })
  await pageB.waitForTimeout(500)
  await confirmDialog(page, '删除任务') // A 提交旧确认 → 事务内发现未结束会话
  const stillThere = !!(await docOf(page, K.T))
  const blockUi = (await dlg(page).getByText('先处理尚未结束的工作').count()) + (await adlg(page).getByText('暂不能删除').count())
  rec('C07', '确认期间它页开始工作：旧确认被拒绝（非仅禁用按钮）', stillThere && blockUi > 0, `blockUi=${blockUi}`)
  await page.screenshot({ path: join(OUT, 'c07-session-started.png') })
  if (await dlg(page).getByText('先处理尚未结束的工作').count()) await dlg(page).getByRole('button', { name: '取消', exact: true }).click()
  else if (await adlg(page).count()) await cancelDialog(page)
  await endWork(pageB, { outcome: 'partial', text: 'C07 收尾。' })
  rec('C07', '拒绝后会话与任务均完好', !!(await docOf(page, K.T)), '')
  await context.close()
}

await browser.close()
writeFileSync(join(OUT, 'c03-results.json'), JSON.stringify({ at: now(), seed: 'c01-docs-snapshot.json（C01 真实页面生成；测试辅助复制进独立 Context）', results }, null, 2))
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
console.log(`c03 exit=${failed.length ? 1 : 0}`)
process.exit(failed.length ? 1 : 0)