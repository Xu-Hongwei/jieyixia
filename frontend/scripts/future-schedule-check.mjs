// Uses a fresh browser context and synthetic tasks on the local Vite app.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({ channel: 'msedge' })
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5174/#/assistant')
  await page.getByRole('heading', { name: '规划助手' }).waitFor()
  const eventDate = await page.evaluate(async () => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    const workspace = stores.get('app').workspaceId
    const db = await import('/src/services/storage/db.js')
    db.configureWorkspace(workspace)
    const { mkWork, mkProposal } = await import('/src/tests/planning.helpers.js')
    const { createAssistantDraftService } = await import('/src/services/assistant/drafts.js')
    const { beijingToday, beijingAddDays } = await import('/src/domains/time.js')
    const date = beijingAddDays(beijingToday(), 60)
    await db.putDoc({ id: 'race', kind: 'task', title: '测试赛事', status: 'todo', deadline: { value: null, precision: 'none' } })
    const works = []
    for (const [key, title] of [['arrival', '检录'], ['award', '领奖']]) {
      await db.putDoc({ id: key, kind: 'action', task_id: 'race', text: title, minutes: 10, done: false })
      works.push(mkWork('w-' + key, { task_ref: { kind: 'existing', id: 'race' }, action_ref: { kind: 'existing', id: key },
        deliverable: title, remaining_minutes: 10, depends_on: key === 'award' ? ['w-arrival'] : [] }))
    }
    const draft = await createAssistantDraftService({ getWorkspaceId: () => workspace }).create({ proposal: mkProposal({ work_items: works }) })
    if (!draft.ok) throw Error(draft.message)
    await stores.get('assistant').open(draft.draft.id)
    return date
  })
  const dates = page.getByLabel('最早安排日（可选）')
  assert.equal(await dates.count(), 2)
  for (const input of await dates.all()) await input.fill(eventDate)
  await page.getByRole('button', { name: '保存并预览', exact: true }).click()
  const preview = page.getByRole('region', { name: '预览安排' })
  for (const title of ['检录', '领奖']) {
    const pending = preview.locator('[data-pending-gap]').filter({ hasText: title })
    await pending.getByRole('button', { name: '选一天' }).click()
    assert.equal(await pending.getByLabel('安排日期').inputValue(), eventDate)
    await pending.getByRole('button', { name: '保存到草案' }).click()
    await pending.waitFor({ state: 'detached' })
  }
  await preview.getByRole('button', { name: /将计划加入日程/ }).click()
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assistant').activeDraft?.status === 'applied')
  await page.goto('http://127.0.0.1:5174/#/today')
  await page.getByLabel('跳至日期').fill(eventDate)
  await page.waitForURL(url => url.hash.includes(eventDate))
  for (const title of ['检录', '领奖']) await page.getByText(title, { exact: true }).first().waitFor()
  console.log('两项工作连续保存、采用并在 60 天后的目标日查到。', eventDate)
} finally {
  await browser.close()
}
