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



    // Repeat the previous high-risk completion/rename and modal checks.
    await go('/today?task=t0');await detail.waitFor();
    await detail.getByRole('button',{name:'完成',exact:true}).click();await page.waitForTimeout(200);
    record('previous_f1_finish',{status:(await readDoc('t0')).status,completeHidden:await detail.getByRole('button',{name:'完成',exact:true}).count()===0});
    await detail.getByRole('button',{name:'重命名任务',exact:true}).click();await detail.getByRole('textbox',{name:'重命名任务',exact:true}).fill('复验：完成后重命名');await detail.getByRole('button',{name:'保存',exact:true}).click();await page.waitForTimeout(200);
    record('previous_f1_rename',{status:(await readDoc('t0')).status,title:(await readDoc('t0')).title,titleVisible:await detail.getByText('复验：完成后重命名',{exact:true}).isVisible()});
    await detail.getByRole('button',{name:'关闭详情',exact:true}).focus();await page.keyboard.press('Shift+Tab');
    record('previous_f2_focus',{inside:await detail.evaluate(el=>el.contains(document.activeElement))});
    await detail.getByRole('button',{name:'删除任务',exact:true}).click();await page.getByRole('alertdialog').waitFor();await page.keyboard.press('Escape');await page.waitForTimeout(250);
    record('previous_f2_escape',{parentOpen:await detail.count(),confirmClosed:await page.getByRole('alertdialog').count()===0,taskExists:!!await readDoc('t0')});
    await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
    // Accurate failed entry still works even after viewing reviewed content.
    await go('/notes/n3');await page.locator('aside a[href="#/today"]').click();await page.locator('main a[href="#/notes?bucket=failed"]').click();await page.waitForTimeout(300);
    record('failed_entry',{hash:await hash(),selected:await queueSelected()});
    // Main navigation should lead to pending work, not the most recently viewed reviewed document.
    await go('/notes/n3');await page.locator('aside a[href="#/today"]').click();await page.locator('aside a[href="#/notes"]').click();await page.waitForTimeout(400);
    record('main_review_entry_after_reviewed',{hash:await hash(),selected:await queueSelected(),text:(await page.locator('main').innerText()).slice(0,700)});await shot('issue-main-review-entry');
    // Explicit library return context should survive selecting another note in the work queue.
    await go('/collect?q='+encodeURIComponent('课程'));await page.getByRole('button',{name:'查看便签',exact:true}).first().click();await page.waitForTimeout(300);
    record('library_return_initial',{hash:await hash(),backAvailable:await page.getByRole('button',{name:'返回资料库',exact:true}).isVisible()});
    await page.locator('.space-y-1 > button',{hasText:'开题答辩材料清单'}).first().click();await page.waitForTimeout(300);
    record('library_return_after_queue_change',{hash:await hash(),backCount:await page.getByRole('button',{name:'返回资料库',exact:true}).count()});await shot('issue-return-context');
    // Future-week note-to-task navigation, source return, and refresh.
    await go('/notes/n1?bucket=pending');await page.getByRole('button',{name:'更多操作',exact:true}).click();await pickDay('手动截止',futureDate);await page.getByRole('button',{name:'手动截止建任务',exact:true}).click();await page.waitForTimeout(200);record('future_task_stays_on_note',{hash:await hash(),futureDate,successBar:await page.getByText('已创建并保存到本地').isVisible()});await page.getByRole('button',{name:'查看任务',exact:true}).click();await detail.waitFor();record('future_task_location',{hash:await hash(),futureDate,correctDate:new URLSearchParams((await hash()).split('?')[1]).get('date')===futureDate});
    const taskHash=await hash();await detail.getByRole('link',{name:/便签「机器学习课程报告」/}).click();await page.getByRole('button',{name:'返回任务',exact:true}).click();await detail.waitFor();
    const normalizeHash=h=>{const [p,q]=h.split('?'),params=new URLSearchParams(q);params.sort();return p+'?'+params.toString()};record('task_source_return',{before:taskHash,after:await hash(),sameContext:normalizeHash(taskHash)===normalizeHash(await hash())});await page.reload();await detail.waitFor();record('task_deeplink_refresh',{open:true,hash:await hash()});await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
    // New undated task is created from the normal UI, without a script-built task URL.
    await go('/today');await page.getByRole('button',{name:'新建',exact:true}).click();await page.getByLabel('新任务名称',{exact:true}).fill('复验：新建无截止任务');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.waitForTimeout(250);
    record('standalone_undated_result',{hash:await hash(),visible:await page.getByText('复验：新建无截止任务',{exact:true}).isVisible().catch(()=>false),dialogCount:await detail.count(),undatedOpen:await page.getByRole('button',{name:/无截止任务/}).getAttribute('aria-expanded')});await shot('issue-undated-result');
    // Real long list. Every scratch source/note is confined to this browser context.
    await page.evaluate(async()=>{await new Promise((resolve,reject)=>{let r=indexedDB.open('jxl-product',2);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['docs','sources'],'readwrite'),now=new Date().toISOString();for(let i=0;i<50;i++){let w={workspace_id:'personal',created_at:now,updated_at:now},sid='long-source-'+i,nid='long-note-'+i,title='滚动列表资料 '+String(i).padStart(2,'0');tx.objectStore('sources').put({...w,id:sid,kind:'text',text:title,captured_at:new Date(Date.now()-i*60000).toISOString()});tx.objectStore('docs').put({...w,id:nid,kind:'note',source_id:sid,title,status:'reviewed',content_type:'reference',fields:[{key:'title',value:title,status:'confirmed',origin:'model',raw:title}],warnings:[]})}tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}})});
    await go('/collect?q='+encodeURIComponent('滚动列表资料'));await page.reload();await page.getByLabel('搜索资料库').waitFor();await page.waitForTimeout(250);
    const target=page.locator('div.flex.flex-wrap.items-center.gap-3').filter({hasText:'滚动列表资料 35'}).first();await target.getByRole('button',{name:'查看便签',exact:true}).scrollIntoViewIfNeeded();await page.waitForTimeout(200);const beforeScroll=await page.evaluate(()=>scrollY);
    await target.getByRole('button',{name:'查看便签',exact:true}).click();await page.getByRole('button',{name:'返回资料库',exact:true}).click();await page.waitForTimeout(500);
    record('explicit_return_scroll',{before:beforeScroll,after:await page.evaluate(()=>scrollY),scrollKeys:await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('jxl-scroll:'))),filter:await page.getByLabel('搜索资料库').inputValue()});await shot('issue-scroll-return');
    // Editable field state must belong to the note whose field is shown.
    await go('/notes/n1?bucket=pending');await page.locator('[data-field-key="title"]').getByRole('button',{name:'编辑',exact:true}).click();const fieldInput=page.locator('[data-field-key="title"] input');await fieldInput.fill('仅属于第一份便签的未保存草稿');
    await page.locator('.space-y-1 > button',{hasText:'开题答辩材料清单'}).first().click();await page.waitForTimeout(250);
    record('field_draft_after_note_switch',{hash:await hash(),draftInput:await fieldInput.count()?await fieldInput.inputValue():null,secondTitleBefore:(await readDoc('n4')).fields[0].value});
    if(await page.locator('[data-field-key="title"]').getByRole('button',{name:'保存修改',exact:true}).count()) {await page.locator('[data-field-key="title"]').getByRole('button',{name:'保存修改',exact:true}).click();await page.waitForTimeout(200);record('field_draft_save_on_second_note',{secondTitle:(await readDoc('n4')).fields[0].value});}
    await shot('issue-cross-note-draft');

    await page.setViewportSize({width:390,height:844});await go('/notes/n3');await page.locator('header nav a[href="#/today"]').click();await page.locator('header nav a[href="#/notes"]').click();await page.waitForTimeout(250);
    record('mobile_main_review_entry',{hash:await hash(),reviewedTitle:await page.locator('main').getByText('实验环境配置指南',{exact:true}).filter({visible:true}).first().isVisible()});
    await go(taskHash.slice(1));await detail.waitFor();await detail.getByRole('link',{name:/便签「机器学习课程报告」/}).click();const mobileBack=page.getByRole('button',{name:'返回任务',exact:true});const backVisible=await mobileBack.isVisible();await mobileBack.click();await detail.waitFor();
    record('mobile_task_return',{backVisible,dialogOpen:true,width:await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}))});await shot('mobile-return-task');
    fs.writeFileSync(path.join(__dirname, 'recheck-result.json'), JSON.stringify({ checks, errors, seed: '虚构种子（f1f2 种子 + n4/s4 开题答辩）', scope: 'isolated headless Edge; /api/analyze aborted; 方案 §4 导航验收' }, null, 2))
    console.log(JSON.stringify({ errors }, null, 1))
  } finally { await browser.close() }
})().catch((e) => { console.error(e); process.exitCode = 1 })