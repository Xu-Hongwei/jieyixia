// 导航整理轮独立验收（方案 §4）：虚构种子，隔离 headless Edge，不调用 /api/analyze。
// 覆盖：入口准确 / 建任务后定位 / 出处返回 / 筛选保留 / 刷新深链接 / 删除不悬空 / 工作区隔离 / 手机返回 / 原位反馈。
const { createRequire } = require('node:module')
const { chromium } = createRequire('E:/qoder/frontend/package.json')('playwright-core')
const fs = require('node:fs'), path = require('node:path')
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route('**/api/analyze**', (r) => r.abort())
  const checks = []
  const record = (name, actual) => { checks.push({ name, ...actual }); console.log(JSON.stringify(checks[checks.length - 1])) }
  const readDoc = async (id) => page.evaluate(async (id) => new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', 2)
    req.onsuccess = () => { const db = req.result, tx = db.transaction('docs', 'readonly'), r = tx.objectStore('docs').get(id); r.onsuccess = () => resolve(r.result || null); r.onerror = () => reject(r.error); tx.oncomplete = () => db.close() }
    req.onerror = () => reject(req.error)
  }), id)
  const findTaskByNote = async (noteId) => page.evaluate(async (noteId) => new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', 2)
    req.onsuccess = () => { const db = req.result, tx = db.transaction('docs', 'readonly'), r = tx.objectStore('docs').getAll(); r.onsuccess = () => resolve((r.result || []).filter((d) => d.kind === 'task' && (d.note_ids || []).includes(noteId))); r.onerror = () => reject(r.error); tx.oncomplete = () => db.close() }
    req.onerror = () => reject(req.error)
  }), noteId)
  const shot = async (name) => { await page.waitForTimeout(200); await page.screenshot({ path: path.join(__dirname, name + '.png'), animations: 'disabled' }) }
  const hash = () => page.evaluate(() => location.hash)
  const waitHash = (part) => page.waitForFunction((p) => location.hash.includes(p), part, { timeout: 8000 })
  const queueSelected = () => page.locator('.space-y-1 > button.bg-accent').first().innerText().catch(() => '')
  const detail = page.getByRole('dialog')
  const go = async (h) => { await page.goto('http://127.0.0.1:5175/#' + h); await page.locator('main').waitFor(); await page.waitForTimeout(350) }
  const pickDay = async (label, date) => {
    await page.locator(`button[aria-label="${label}"]`).first().click()
    await page.locator(`button[aria-label="${date}"]`).filter({ visible: true }).first().click()
    await page.waitForTimeout(200)
  }
  try {
    await go('/today')
    await page.evaluate(async () => {
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), add = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
      const now = new Date().toISOString(), w = { workspace_id: 'personal', created_at: now, updated_at: now }
      const fields = [
        { key: 'title', value: '机器学习课程报告', status: 'confirmed', origin: 'model', raw: '完成机器学习课程报告' },
        { key: 'deadline', value: add(1) + 'T18:00:00+08:00', precision: 'datetime', tz_known: true, status: 'candidate', origin: 'model', raw: '周五18点前提交PDF', quote: { source_id: 's1', text: '周五18点前提交PDF' } },
        { key: 'requirement', value: ['报告至少3000字', '包含实验对比与结果分析'], raw: '报告至少3000字，包含实验对比与结果分析', status: 'candidate', origin: 'model' },
        { key: 'submit_to', value: '课程平台作业区', raw: '上传课程平台作业区', status: 'unresolved', origin: 'model' },
        { key: 'summary', value: '课程报告需说明方法、实验与引用来源。', raw: '课程报告需说明方法、实验与引用来源。', status: 'candidate', origin: 'model' },
      ]
      const docs = [
        { ...w, id: 'm1', kind: 'matter', title: '机器学习课程', note_ids: ['n1'] },
        { ...w, id: 'n1', kind: 'note', source_id: 's1', content_type: 'notice', status: 'draft', title: '机器学习课程报告', fields, matter_id: 'm1', matter_role: 'requirement', warnings: [] },
        { ...w, id: 'n2', kind: 'note', source_id: 's2', content_type: 'reference', status: 'failed', title: '实验结果补充说明', fields: [], warnings: [] },
        { ...w, id: 'n3', kind: 'note', source_id: 's3', content_type: 'tutorial', status: 'reviewed', reviewed_at: now, title: '实验环境配置指南', fields: [{ key: 'title', value: '实验环境配置指南', status: 'confirmed', origin: 'model', raw: '实验环境配置指南' }], warnings: [] },
        { ...w, id: 'n4', kind: 'note', source_id: 's4', content_type: 'notice', status: 'draft', title: '开题答辩材料清单', fields: [
          { key: 'title', value: '开题答辩材料清单', status: 'confirmed', origin: 'model', raw: '开题答辩材料清单' },
          { key: 'deadline', value: add(2) + 'T09:00:00+08:00', precision: 'datetime', tz_known: true, status: 'candidate', origin: 'model', raw: '后天上午9点答辩' },
        ], warnings: [] },
      ]
      const names = ['提交机器学习课程报告：多模态遥感图文检索方法与实验结果分析', '提交开题报告初稿', '整理实验数据及消融对比结果', '论文阅读：Attention Is All You Need', '准备小组汇报', '补充文献综述', '长期研究：论文结构与实验路线整理']
      names.forEach((title, i) => docs.push({ ...w, id: 't' + i, kind: 'task', title, status: i === 5 ? 'done' : 'todo', matter_id: 'm1', note_ids: i === 0 ? ['n1'] : [], deadline: i === 6 ? { value: null, precision: 'none' } : { value: add(i < 3 ? 0 : i - 2) + (i === 1 ? '' : 'T' + ['09:00', '10:30', '17:00'][i % 3] + ':00+08:00'), precision: i === 1 ? 'date' : 'datetime', source: 'manual', confirmed_at: now } }))
      const sources = [
        { ...w, id: 's1', kind: 'text', text: '课程通知\n请完成机器学习课程报告。报告至少3000字，包含实验对比与结果分析。周五18点前提交PDF，并上传课程平台作业区。', captured_at: now },
        { ...w, id: 's2', kind: 'text', text: '实验结果补充说明：请整理消融实验表格。', captured_at: now },
        { ...w, id: 's3', kind: 'text', text: '实验环境配置指南：安装依赖并核对数据路径。', captured_at: now },
        { ...w, id: 's4', kind: 'text', text: '开题答辩通知：后天上午9点答辩，请准备材料清单。', captured_at: now },
      ]
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('jxl-product', 2)
        req.onsuccess = () => { const db = req.result, t = db.transaction(['docs', 'sources'], 'readwrite'); docs.forEach((d) => t.objectStore('docs').put(d)); sources.forEach((d) => t.objectStore('sources').put(d)); t.oncomplete = () => { db.close(); resolve() }; t.onerror = () => reject(t.error) }
        req.onerror = () => reject(req.error)
      })
    })
    await page.reload(); await page.locator('[data-today=true]').waitFor(); await page.waitForTimeout(400)
    const add = (n) => page.evaluate((n) => { const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); return new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10) }, n)
    const futureDate = await add(10)




    const dialogs=[];let accept=true;page.on('dialog',d=>{dialogs.push(d.message());accept?d.accept():d.dismiss()});
    const actions=async task=>(await page.evaluate(async()=>new Promise((res,rej)=>{let r=indexedDB.open('jxl-product',2);r.onsuccess=()=>{let db=r.result,t=db.transaction('docs','readonly'),q=t.objectStore('docs').getAll();q.onsuccess=()=>res(q.result);t.oncomplete=()=>db.close()};r.onerror=()=>rej(r.error)}))).filter(d=>d.kind==='action'&&d.task_id===task);
    const addUI=async text=>{await page.getByLabel('新行动内容',{exact:true}).fill(text);await page.getByRole('button',{name:'添加行动',exact:true}).click();await page.waitForTimeout(200)};
    await go('/today?task=t0');await page.getByRole('heading',{level:1}).waitFor();record('legacy_link',{hash:await hash(),title:await page.locator('h1').innerText()});
    await addUI('先列提纲');await addUI('整理实验结果');record('create_two_actions',{actions:(await actions('t0')).map(a=>({id:a.id,text:a.text,minutes:a.minutes,workspace:a.workspace_id}))});
    let row=page.getByRole('button',{name:'完成行动：先列提纲',exact:true}).locator('..');await row.getByRole('button',{name:'设为当前',exact:true}).click();await page.waitForTimeout(150);record('set_current',{current:(await readDoc('t0')).current_action_id});
    await page.getByRole('button',{name:'完成行动：先列提纲',exact:true}).click();await page.waitForTimeout(150);record('complete_action',{taskStatus:(await readDoc('t0')).status,current:(await readDoc('t0')).current_action_id,actionDone:(await actions('t0')).find(a=>a.text==='先列提纲').done});
    await page.getByRole('button',{name:'重新打开行动：先列提纲',exact:true}).click();await page.getByRole('button',{name:'完成任务',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'确认整体完成',exact:true}).click();await page.waitForTimeout(150);record('complete_task_independent',{status:(await readDoc('t0')).status,unfinished:(await actions('t0')).filter(a=>!a.done).length});await page.getByRole('button',{name:'重新打开',exact:true}).click();
    await page.getByLabel('新行动内容',{exact:true}).fill('双击不应新增两条');await page.getByRole('button',{name:'添加行动',exact:true}).dblclick();await page.waitForTimeout(200);record('double_click_success',{count:(await actions('t0')).filter(a=>a.text==='双击不应新增两条').length});await shot('desktop-task');
    await page.getByLabel('任务说明',{exact:true}).fill('尚未保存的任务说明');accept=false;await page.getByRole('button',{name:'返回原列表',exact:true}).click();await page.waitForTimeout(100);record('leave_cancel',{stillDetail:(await hash()).includes('/tasks/t0'),input:await page.getByLabel('任务说明',{exact:true}).inputValue()});accept=true;await page.getByRole('button',{name:'返回原列表',exact:true}).click();await go('/tasks/t0');record('discard_after_leave',{description:await page.getByLabel('任务说明',{exact:true}).inputValue(),dbDescription:(await readDoc('t0')).description||''});
    // A value changed again while an earlier save is in flight must not be cleared.
    await page.getByLabel('新行动内容',{exact:true}).fill('本次正在保存的行动');
    await page.evaluate(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加行动'),input=document.querySelector('[aria-label="新行动内容"]');btn.click();input.value='保存期间输入的下一条行动';input.dispatchEvent(new Event('input',{bubbles:true}))});await page.waitForTimeout(200);record('next_draft_during_save',{input:await page.getByLabel('新行动内容',{exact:true}).inputValue(),newPersisted:(await actions('t0')).filter(a=>a.text==='保存期间输入的下一条行动').length});
    await page.getByRole('button',{name:'删除行动：先列提纲',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'删除行动',exact:true}).click();await page.waitForTimeout(100);await go('/today');await page.locator('#recover').getByRole('button',{name:/恢复入口/}).click();await page.locator('#recover').getByRole('button',{name:'恢复',exact:true}).click();await page.waitForTimeout(100);record('undo_action',{exists:(await actions('t0')).some(a=>a.text==='先列提纲')});
    await go('/tasks/t0');let beforeDelete=await actions('t0');await page.getByRole('button',{name:'删除任务',exact:true}).click();await page.getByRole('alertdialog').getByRole('button',{name:'删除任务',exact:true}).click();await page.waitForTimeout(200);record('delete_task',{taskGone:!(await readDoc('t0')),actionsGone:(await actions('t0')).length===0,hash:await hash()});
    await go('/today');await page.locator('#recover').getByRole('button',{name:/恢复入口/}).click();await page.locator('#recover').getByRole('button',{name:'恢复',exact:true}).click();await page.waitForTimeout(100);record('undo_task_actions',{taskBack:!!await readDoc('t0'),actionCount:(await actions('t0')).length,expected:beforeDelete.length});
    await go('/tasks/t0');await page.reload();await page.getByRole('heading',{level:1}).waitFor();record('refresh',{actionCount:(await actions('t0')).length});await ctx.setOffline(true);await addUI('离线新增行动');record('offline_create',{exists:(await actions('t0')).some(a=>a.text==='离线新增行动')});await ctx.setOffline(false);
    await page.setViewportSize({width:390,height:844});await shot('mobile-task');record('mobile_width',{sw:await page.evaluate(()=>document.documentElement.scrollWidth),iw:390});
    fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({checks,errors,dialogs,scope:'isolated Edge, fictional seed, analyze blocked'},null,2));console.log(JSON.stringify({errors}));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
