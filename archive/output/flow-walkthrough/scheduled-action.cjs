const { chromium } = require('../../frontend/node_modules/playwright-core')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await chromium.launch({executablePath: process.env.LOCALAPPDATA + '/ms-playwright/chromium-1232/chrome-win64/chrome.exe'})
  try {
    for (const mode of ['draft', 'existing', 'orphan', 'manual', 'tomorrow', 'task']) {
      const ctx = await browser.newContext({viewport:{width:650,height:850}})
      const page = await ctx.newPage()
      page.setDefaultTimeout(8000)
      const errors=[]
      page.on('pageerror',e=>errors.push(e.message))
      const root='http://127.0.0.1:5174/'
      await page.goto(root+'#/today')
      await page.getByRole('button',{name:'本周',exact:true}).first().waitFor()
      await page.evaluate(async mode=>{
        const req=indexedDB.open('jxl-product')
        const db=await new Promise((ok,no)=>{req.onsuccess=()=>ok(req.result);req.onerror=no})
        const tx=db.transaction(['docs','assistant_drafts'],'readwrite')
        const docs=tx.objectStore('docs'), ws={workspace_id:'personal'}
        const now=new Date(), date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date(+now+(mode==='tomorrow'?864e5:0)))
        docs.put({...ws,kind:'task',id:'talk',title:'示例宣讲会',status:'todo',deadline:{precision:'none',value:null},note_ids:[],matter_id:null,current_action_id:mode==='manual'?null:'attend',created_at:now.toISOString()})
        for(const [id,text] of [['confirm','确认时间与地点'],['attend','现场参加宣讲会']]) docs.put({...ws,kind:'action',id,task_id:'talk',text,minutes:id==='attend'?60:10,done:mode==='orphan'&&id==='confirm',created_at:now.toISOString()})
        docs.put({...ws,kind:'plan_item',id:'p',task_id:'talk',date,state:'planned',planned_minutes:10,action_text:'确认后的时间地点信息',task_ref_state:'active',actual_minutes:null,focus_session_id:null,order:1})
        if(mode!=='manual') tx.objectStore('assistant_drafts').put({...ws,id:'d',status:'applied',applied_summary:{id_map:[{object_type:'plan_item',draft_key:'w#1',formal_id:'p'},{object_type:'action',draft_key:'a',formal_id:'confirm'}]},planning_result:{segments:[{segment_key:'w#1',suggested_action_ref:mode==='existing'?{kind:'existing',id:'confirm'}:{kind:'draft',key:'a'}}]}})
        await new Promise((ok,no)=>{tx.oncomplete=ok;tx.onerror=no})
        db.close()
      },mode)
      await page.goto(root+'#/'+(mode==='task'?'tasks/talk':'today')+'?plan=p');await page.reload()
      const start=page.getByRole('button',{name:'开始这项安排',exact:true})
      const select=page.locator('main select, [role=dialog] select').filter({visible:true})
      if(['orphan','manual'].includes(mode)) {
        const picker=page.getByRole('combobox',{name:mode==='orphan'?/原行动已失效/:/选择这次执行/})
        await picker.waitFor()
        assert(await start.isDisabled())
        await picker.selectOption('attend')
      } else {
        await page.getByText('执行行动 · 确认时间与地点',{exact:true}).waitFor()
        assert.equal(await page.locator('[role=dialog] select').count(),0)
      }
      await start.click()
      if(mode==='tomorrow'){
        const dialog=page.getByRole('dialog',{name:'开始这项安排',exact:true})
        const go=dialog.getByRole('button',{name:'确认并开始'})
        assert(await go.isDisabled())
        await dialog.getByRole('checkbox').check()
        await go.click()
      }
      await page.waitForURL(/#\/work\//)
      const row=await page.evaluate(async()=>{
        const req=indexedDB.open('jxl-product')
        const db=await new Promise((ok,no)=>{req.onsuccess=()=>ok(req.result);req.onerror=no})
        const query=db.transaction('docs').objectStore('docs').getAll()
        const rows=await new Promise((ok,no)=>{query.onsuccess=()=>ok(query.result);query.onerror=no})
        db.close()
        return rows.filter(d=>d.kind==='focus_session').map(s=>[s.plan_item_id,s.action_id])
      })
      assert.deepEqual(row,[['p',['orphan','manual'].includes(mode)?'attend':'confirm']])
      assert.deepEqual(errors,[])
      console.log(mode+' passed')
      await ctx.close()
    }
  } finally {await browser.close()}
})().catch(err=>{console.error(err.message);process.exitCode=1})
