// Review-only browser probes. Private browser contexts, synthetic data, own localhost Vite.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
const require = createRequire('E:/qoder/frontend/package.json')
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const { chromium } = await import('file:///E:/qoder/frontend/node_modules/playwright-core/index.mjs')
const OUT = 'E:/qoder/output/playwright/stage5a-1-multifield-review-2026-11-23'
await mkdir(OUT, { recursive: true })
const server = await createServer({ root: 'E:/qoder/frontend', configFile: 'E:/qoder/frontend/vite.config.js',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: { port: 0 } } })
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  const base = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ executablePath: 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe', headless: true })
  const seed = [
    { kind: 'task', id: 'review-task-a', workspace_id: 'personal', title: '虚构任务甲', status: 'todo', matter_id: null, note_ids: [], current_action_id: null, deadline: { value: '2026-11-27', precision: 'date', source: 'manual', from_note_id: null, confirmed_at: '2026-11-23T09:00:00+08:00' }, created_at: '2026-11-23T09:00:00+08:00', updated_at: '2026-11-23T09:00:00+08:00' },
    { kind: 'task', id: 'review-task-b', workspace_id: 'personal', title: '虚构任务乙', status: 'todo', matter_id: null, note_ids: [], current_action_id: null, deadline: { value: null, precision: 'none' }, created_at: '2026-11-23T09:00:00+08:00', updated_at: '2026-11-23T09:00:00+08:00' },
    { kind: 'plan_item', id: 'review-plan-a', workspace_id: 'personal', task_id: 'review-task-a', date: '2026-11-23', action_text: '虚构安排原说明', planned_minutes: 30, state: 'planned', task_ref_state: 'active', actual_minutes: null, focus_session_id: null, order: 1 },
  ]
  const results = []
  const errors = []
  async function scene(hash = '#/today?date=2026-11-23&plan=review-plan-a') {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
    const page = await context.newPage()
    page.setDefaultTimeout(12000)
    page.on('pageerror', err => { errors.push(err.message); console.log('PAGE_ERROR', err.message) })
    await page.goto(base + '/#/today')
    await page.getByRole('button', { name: '安排工作', exact: true }).waitFor()
    await page.evaluate(async (seed) => {
      const db = await import('/src/services/storage/db.js')
      db.configureWorkspace('personal')
      for (const d of seed) await db.putDoc(d)
    }, seed)
    await page.goto(base + '/' + hash)
    await page.reload()
    await page.getByRole('button', { name: '安排工作', exact: true }).first().waitFor()
    await page.waitForTimeout(150)
    return { context, page }
  }
  const read = page => page.evaluate(async () => (await (await import('/src/services/storage/db.js')).allDocs()).records)
  {
    console.log('PROBE stale snapshot')
    const { context, page } = await scene()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByLabel('工作说明', { exact: true }).fill('本页草稿说明')
    await page.evaluate(async () => {
      const db = await import('/src/services/storage/db.js')
      const p = (await db.allDocs()).records.find(d => d.id === 'review-plan-a')
      await db.putDoc({ ...p, planned_minutes: 60 })
      await (await import('/src/stores/app.js')).useAppStore().reloadDocs()
    })
    const before = (await read(page)).find(d => d.id === 'review-plan-a')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.waitForTimeout(350)
    const after = (await read(page)).find(d => d.id === 'review-plan-a')
    results.push({ probe: 'live-snapshot-overwrites-newer-minutes', before: before.planned_minutes, after: after.planned_minutes, afterText: after.action_text, conflictDialogShown: await page.getByRole('alertdialog').count() })
    // A second concurrent change occurs while the user is reading the first difference.
    const shownDifference = await page.getByRole('alertdialog').innerText()
    await page.evaluate(async () => {
      const db = await import('/src/services/storage/db.js')
      const p = (await db.allDocs()).records.find(d => d.id === 'review-plan-a')
      await db.putDoc({ ...p, planned_minutes: 90 })
      await (await import('/src/stores/app.js')).useAppStore().reloadDocs()
    })
    await page.getByRole('button', { name: '按最新事实重新提交', exact: true }).click()
    await page.waitForTimeout(250)
    const afterSecond = (await read(page)).find(d => d.id === 'review-plan-a')
    results.push({ probe: 'second-change-while-confirmation-open', differenceUserSaw: shownDifference, newestBeforeConfirm: 90, afterConfirm: afterSecond.planned_minutes, conflictDialogRemaining: await page.getByRole('alertdialog').count() })
    await page.screenshot({ path: OUT + '/stale-overwrite.png', fullPage: true })
    await context.close()
  }
  {
    console.log('PROBE unsaved replacement')
    const { context, page } = await scene()
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    await page.getByLabel('工作说明', { exact: true }).fill('尚未保存不能丢弃的草稿')
    await page.getByRole('button', { name: '安排工作', exact: true }).click()
    await page.waitForTimeout(150)
    results.push({ probe: 'replace-dirty-editor', remainingText: await page.getByLabel('工作说明', { exact: true }).inputValue(), discardDialogShown: await page.getByRole('alertdialog').count(), existingRecord: (await read(page)).find(d => d.id === 'review-plan-a').action_text })
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    results.push({ probe: 'continue-editing-retains-draft', text: await page.getByLabel('工作说明', { exact: true }).inputValue() })
    await page.screenshot({ path: OUT + '/lost-draft.png', fullPage: true })
    await context.close()
  }
  {
    console.log('PROBE stale cancellation second change')
    const { context, page } = await scene()
    await page.getByRole('button', { name: '取消安排', exact: true }).click()
    await page.evaluate(async () => {
      const db = await import('/src/services/storage/db.js')
      const p = (await db.allDocs()).records.find(d => d.id === 'review-plan-a')
      await db.putDoc({ ...p, planned_minutes: 60 })
      await (await import('/src/stores/app.js')).useAppStore().reloadDocs()
    })
    await page.getByRole('alertdialog').getByRole('button', { name: '取消安排', exact: true }).click()
    await page.getByRole('button', { name: '按最新事实重新确认', exact: true }).waitFor()
    const firstDifference = await page.getByRole('alertdialog').innerText()
    await page.evaluate(async () => {
      const db = await import('/src/services/storage/db.js')
      const p = (await db.allDocs()).records.find(d => d.id === 'review-plan-a')
      await db.putDoc({ ...p, planned_minutes: 90 })
      await (await import('/src/stores/app.js')).useAppStore().reloadDocs()
    })
    await page.getByRole('button', { name: '按最新事实重新确认', exact: true }).click()
    await page.waitForTimeout(200)
    const after = (await read(page)).find(d => d.id === 'review-plan-a')
    results.push({ probe: 'detail-cancel-confirmation-uses-unshown-baseline', differenceUserSaw: firstDifference, newestBeforeConfirm: 90, stateAfterConfirm: after.state, minutesAfterConfirm: after.planned_minutes, secondConflictDialogShown: await page.getByRole('alertdialog').count() })
    await page.screenshot({ path: OUT + '/cancel-second-change.png', fullPage: true })
    await context.close()
  }
  {
    console.log('PROBE fixed task')
    const { context, page } = await scene('#/tasks/review-task-a')
    await page.getByRole('button', { name: '安排工作', exact: true }).click()
    const change = page.getByRole('button', { name: '更换', exact: true })
    const offeredChange = await change.count()
    if (offeredChange) {
      await change.click()
      await page.getByRole('button', { name: '选择任务：虚构任务乙', exact: true }).click()
      await page.getByLabel('工作说明', { exact: true }).fill('在任务甲页面创建给乙的安排')
      await page.getByRole('button', { name: '创建安排', exact: true }).click()
      await page.waitForTimeout(250)
    } else {
      await page.getByLabel('工作说明', { exact: true }).fill('固定甲任务的安排')
      await page.getByRole('button', { name: '创建安排', exact: true }).click()
      await page.waitForTimeout(250)
    }
    const added = (await read(page)).filter(d => d.kind === 'plan_item' && d.id !== 'review-plan-a')
    results.push({ probe: 'fixed-task-can-be-replaced', offeredChange: !!offeredChange, pageUrl: page.url(), savedTaskIds: added.map(d => d.task_id) })
    await page.screenshot({ path: OUT + '/wrong-task.png', fullPage: true })
    await context.close()
  }
  {
    const { context, page } = await scene('#/today?date=2026-11-23')
    const desktop = await page.locator('main').ariaSnapshot()
    await writeFile(OUT + '/desktop-structure.txt', desktop)
    await page.screenshot({ path: OUT + '/desktop.png', fullPage: true })
    await page.setViewportSize({ width: 360, height: 800 })
    await page.waitForTimeout(150)
    const mobile = await page.locator('main').ariaSnapshot()
    await writeFile(OUT + '/mobile-structure.txt', mobile)
    await page.screenshot({ path: OUT + '/mobile.png', fullPage: true })
    results.push({ probe: 'mobile-overflow', ...(await page.evaluate(() => ({ viewport: innerWidth, bodyWidth: document.documentElement.scrollWidth }))) })
    const controls = [page.getByRole('link', { name: '工作记录', exact: true }), ...['周视图','列表','安排工作','新建'].map(name => page.getByRole('button', { name, exact: true }))]
    results.push({ probe: 'mobile-toolbar', controls: await Promise.all(controls.map(async loc => ({ text: await loc.innerText(), box: await loc.boundingBox() }))) })
    await context.close()
  }
  await writeFile(OUT + '/results.json', JSON.stringify({ results, errors }, null, 2))
  console.log(JSON.stringify({ results, errors }, null, 2))
} finally { if (browser) await browser.close(); await server.close() }



