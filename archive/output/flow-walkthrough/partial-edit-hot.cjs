const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { chromium } = require('../../frontend/node_modules/playwright-core')
;(async () => {
  const root = path.resolve(__dirname, '../../frontend')
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href)
  const service = path.join(root, 'src/services/plan/service.js')
  let legacy = true
  const server = await createServer({
    root,
    cacheDir:path.join(__dirname,'vite-partial-edit-cache'),
    logLevel:'error',
    server:{host:'127.0.0.1',port:0,open:false,strictPort:true},
    plugins:[{name:'simulate-previous-edit-rule',enforce:'pre',transform(s,id){
      if(legacy && id.split('?')[0].replaceAll('\\','/')===service.replaceAll('\\','/')) return s.replace('const plan = domainPlan(latest,','if(op === "edit" && latest.find(d=>d.id===input.planItemId)?.state==="partial") throw Object.assign(new Error("只有未执行（planned）安排可编辑说明/估时；继续工作请另建安排"),{code:"PLAN_TERMINAL"});const plan = domainPlan(latest,')
    }}]
  })
  let browser
  try {
    await server.listen()
    browser=await chromium.launch({executablePath:process.env.LOCALAPPDATA+'/ms-playwright/chromium-1232/chrome-win64/chrome.exe'})
    const page=await browser.newPage()
    const url='http://127.0.0.1:'+server.httpServer.address().port+'/'
    await page.goto(url+'#/tasks'); await page.getByRole('button',{name:'新建任务',exact:true}).waitFor()
    await page.evaluate(async()=>{
      const req=indexedDB.open('jxl-product'),db=await new Promise(ok=>req.onsuccess=()=>ok(req.result))
      const t=db.transaction('docs','readwrite'),ds=t.objectStore('docs'),ws={workspace_id:'personal'},now=new Date()
      ds.put({...ws,kind:'task',id:'t',title:'测试宣讲会',status:'doing',note_ids:[],deadline:{precision:'none',value:null},current_action_id:null,created_at:now.toISOString()})
      ds.put({...ws,kind:'plan_item',id:'p',task_id:'t',state:'partial',date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(now),planned_minutes:10,action_text:'核对地点',actual_minutes:5,focus_session_id:'s',task_ref_state:'active',order:1})
      ds.put({...ws,kind:'focus_session',id:'s',task_id:'t',action_id:'a',plan_item_id:'p',record_version:1,started_at:new Date(+now-300000).toISOString(),ended_at:now.toISOString(),accumulated_ms:300000,running:false,outcome:'partial',draft_md:'原工作记录'})
      await new Promise(ok=>t.oncomplete=ok);db.close()
    })
    await page.goto(url+'#/today?plan=p');await page.reload()
    const btn=n=>page.getByRole('button',{name:n,exact:true})
    await btn('编辑').click()
    const mins=page.getByLabel('预计分钟',{exact:true})
    await mins.fill('20');await btn('保存修改').click()
    await page.getByText(/只有未执行（planned）安排可编辑/).waitFor()
    console.log('已复现旧保存规则拒绝')
    const updated=page.waitForEvent('console',{predicate:m=>m.text().includes('hot updated: /src/stores/plan.js'),timeout:15000})
    legacy=false;server.watcher.emit('change',service.replaceAll('\\','/'))
    await updated
    assert.equal(await mins.inputValue(),'20')
    await btn('重试保存（同一请求）').click()
    await page.getByRole('dialog',{name:'工作安排详情'}).waitFor()
    const facts=await page.evaluate(async()=>{
      const r=indexedDB.open('jxl-product');const db=await new Promise(ok=>r.onsuccess=()=>ok(r.result))
      const q=db.transaction('docs').objectStore('docs').getAll(), rows=await new Promise(ok=>q.onsuccess=()=>ok(q.result));db.close()
      const p=rows.find(x=>x.id==='p'),s=rows.find(x=>x.id==='s')
      return [p.planned_minutes,p.state,p.actual_minutes,p.focus_session_id,s.accumulated_ms,s.draft_md,rows.filter(x=>x.kind==='plan_item').length]
    })
    assert.deepEqual(facts,[20,'partial',5,'s',300000,'原工作记录',1])
    console.log('同一标签页，保留 20 分钟输入并重试成功；原卡、进度、历史用时与成果均正确。')
  } finally {await browser?.close();await server.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
