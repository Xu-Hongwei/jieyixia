import {createServer} from '../../frontend/node_modules/vite/dist/node/index.js'
import {chromium} from '../../frontend/node_modules/playwright-core/index.mjs'
import {writeFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
const server=await createServer({root:'E:/qoder/frontend',configFile:'E:/qoder/frontend/vite.config.js',server:{host:'127.0.0.1',port:0,hmr:{port:0}}})
let browser;const results=[],errors=[]
try{
 await server.listen()
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'})
 const ctx=await browser.newContext()
 await ctx.route(u=>u.pathname.startsWith('/api/'),r=>r.fulfill({status:503,body:'{}',contentType:'application/json'}))
 const page=await ctx.newPage(); page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000)
 const base=`http://127.0.0.1:${server.httpServer.address().port}`
 await page.goto(base+'/#/today');await page.getByRole('button',{name:'安排工作',exact:true}).waitFor()
 await page.evaluate(async()=>{
  const {useAppStore}=await import('/src/stores/app.js');const {useFocusStore}=await import('/src/stores/focus.js');const db=await import('/src/services/storage/db.js');const time=await import('/src/domains/time.js')
  window.review={app:useAppStore(),focus:useFocusStore(),db,time};const {app}=window.review,ws=app.workspaceId,T=new Date().toISOString();const date=time.beijingToday();
  const t={id:'review-t',kind:'task',workspace_id:ws,title:'审查虚构报告',status:'todo',current_action_id:'review-a',matter_id:null,note_ids:[],deadline:{value:null,precision:'none'},created_at:T,updated_at:T,is_demo:false}
  const a={id:'review-a',kind:'action',workspace_id:ws,task_id:t.id,text:'审查行动',minutes:25,basis:'user',done:false,created_at:T}
  const p={id:'review-p',kind:'plan_item',workspace_id:ws,task_id:t.id,date,state:'planned',action_text:'审查安排',planned_minutes:30,actual_minutes:null,focus_session_id:null,task_ref_state:'active',order:1,created_at:T,updated_at:T}
  for(const x of [t,a,p]) await db.putDoc(x);await app.reloadDocs()
  window.location.hash='/today?view=list&plan='+p.id
 })
 await page.getByRole('button',{name:'开始这项安排',exact:true}).click()
 results.push({case:'initial-dialog',text:await page.getByRole('dialog').innerText()})
 // Concurrent valid external plan edit via persistence; refresh app documents like another-page reload.
 await page.evaluate(async()=>{const {app,db,time}=window.review;const p=app.docs.find(x=>x.id==='review-p');await db.putDoc({...p,date:time.beijingAddDays(p.date,1),action_text:'改到明天的安排',planned_minutes:60});await app.reloadDocs()})
 results.push({case:'after-external-change-before-submit',text:await page.getByRole('dialog').innerText()})
 assert.ok((await page.getByRole('dialog').innerText()).includes('安排预计 30 分钟'))
 await page.getByRole('button',{name:'确认并开始',exact:true}).click()
 await page.getByRole('button',{name:'已核对，重新确认',exact:true}).waitFor()
 await page.getByRole('button',{name:'已核对，重新确认',exact:true}).click()
 results.push({case:'after-reconfirm-date-change',text:await page.getByRole('dialog').innerText(),checkboxes:await page.getByRole('dialog').getByRole('checkbox').count()})
 assert.equal(await page.getByRole('dialog').getByRole('checkbox').count(),1)
 assert.equal(await page.getByRole('button',{name:'确认并开始',exact:true}).isDisabled(),true)
 await page.getByRole('dialog').getByRole('checkbox').check()
 await page.getByRole('button',{name:'确认并开始',exact:true}).click()
 await page.waitForURL('**/#/work/**')
 results.push({case:'begun',url:page.url(),body:await page.locator('main').innerText()})
 await page.getByRole('button',{name:'结束本次',exact:true}).click()
 await page.getByRole('radio',{name:'这项安排已完成',exact:false}).check()
 results.push({case:'end-form',text:await page.getByRole('dialog').innerText()})
 await page.getByRole('button',{name:'结束并保存',exact:true}).click()
 await page.waitForTimeout(1200)
 results.push({case:'after-end',url:page.url(),body:await page.locator('main').innerText(),data:await page.evaluate(async()=>({docs:(await window.review.db.allDocs()).records.filter(d=>d.id==='review-p'||d.kind==='focus_session')}))})
 await page.screenshot({path:'E:/qoder/output/playwright/recheck-5a2b-r1-after-end.png',fullPage:true})
 await page.setViewportSize({width:360,height:800})
 await page.evaluate(()=>{const u=new URLSearchParams(window.location.hash.split('?')[1]);u.delete('view');window.location.hash='/today?'+u})
 await page.waitForTimeout(300)
 results.push({case:'mobile-plan-return',body:await page.locator('main').innerText()})
 assert.equal(await page.getByRole('button',{name:'安排历史详情：改到明天的安排',exact:true}).isVisible(),true)
 await page.screenshot({path:'E:/qoder/output/playwright/recheck-5a2b-r1-mobile-return.png',fullPage:true})
 // A new target in the same day's already-collapsed history must reveal again.
 await page.evaluate(async()=>{const {app,db}=window.review;const p=app.docs.find(d=>d.id==='review-p');await db.putDoc({...p,id:'review-history-other',action_text:'同日另一项已完成安排',actual_minutes:null,focus_session_id:null});await app.reloadDocs()})
 await page.getByRole('button',{name:/安排历史 2 项/}).click()
 assert.equal(await page.getByRole('button',{name:/安排历史 2 项/}).getAttribute('aria-expanded'),'false')
 await page.evaluate(()=>{const q=new URLSearchParams(window.location.hash.split('?')[1]);q.set('plan','review-history-other');window.location.hash='/today?'+q})
 await page.waitForTimeout(200)
 results.push({case:'same-day-new-history-target',url:page.url(),historyExpanded:await page.getByRole('button',{name:/安排历史 2 项/}).getAttribute('aria-expanded'),targetVisible:await page.getByRole('button',{name:'安排历史详情：同日另一项已完成安排',exact:true}).isVisible()})
 await page.screenshot({path:'E:/qoder/output/playwright/recheck-5a2b-r1-new-target.png',fullPage:true})
 await page.setViewportSize({width:1280,height:900})
 await page.evaluate(()=>{window.location.hash='/tasks/review-t?plan=missing-plan&return=%2Ftoday%3Fview%3Dlist'})
 await page.getByRole('button',{name:'改为独立工作',exact:true}).first().waitFor()
 assert.equal(await page.getByRole('button',{name:'开始执行',exact:true}).count(),0)
 results.push({case:'invalid-plan-context-before-start',body:await page.locator('main').innerText()})
 await page.getByRole('button',{name:'改为独立工作',exact:true}).first().click()
 await page.getByRole('button',{name:'确认改为独立工作',exact:true}).click()
 await page.waitForURL('**/#/work/**')
 results.push({case:'invalid-plan-context-created-independent-session',url:page.url(),sessions:await page.evaluate(async()=>(await window.review.db.allDocs()).records.filter(d=>d.kind==='focus_session'&&d.ended_at==null))})
 await page.getByRole('button',{name:'结束本次',exact:true}).click()
 await page.getByRole('button',{name:'结束并保存',exact:true}).click()
 await page.waitForURL('**/#/tasks/**')
 await page.evaluate(async()=>{const {app,db,time,focus}=window.review;const p=app.docs.find(x=>x.id==='review-p');await db.putDoc({...p,id:'review-p2',state:'planned',date:time.beijingToday(),actual_minutes:null,focus_session_id:null});await app.reloadDocs();window.location.hash='/today?plan=review-p2';const original=focus.loadWorkspace;let once=true;focus.loadWorkspace=async(...a)=>{if(once){once=false;throw new Error('REVIEW injected read failure after committed begin')}return original(...a)}})
 await page.getByRole('button',{name:'开始这项安排',exact:true}).click()
 await page.getByRole('button',{name:'确认并开始',exact:true}).click()
 await page.waitForTimeout(400)
 results.push({case:'begin-followup-read-failure',url:page.url(),dialog:await page.getByRole('dialog').innerText(),cancelDisabled:await page.getByRole('button',{name:'取消',exact:true}).isDisabled(),running:await page.evaluate(async()=>(await window.review.db.allDocs()).records.filter(d=>d.kind==='focus_session'&&d.ended_at==null))})
 await page.screenshot({path:'E:/qoder/output/playwright/recheck-5a2b-r1-read-failure.png',fullPage:true})
 assert.equal(await page.getByRole('button',{name:'取消',exact:true}).isDisabled(),false)
 await page.getByRole('button',{name:'重试读取',exact:true}).click()
 await page.waitForURL('**/#/work/**')
 results.push({case:'read-retry-recovered',url:page.url(),count:await page.evaluate(async()=>(await window.review.db.allDocs()).records.filter(d=>d.kind==='focus_session'&&d.plan_item_id==='review-p2').length)})
}catch(e){results.push({failure:e.message,stack:e.stack})}finally{
 await writeFile('E:/qoder/output/playwright/recheck-5a2b-r1-results.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors},null,2));await browser?.close();await server.close()
}

