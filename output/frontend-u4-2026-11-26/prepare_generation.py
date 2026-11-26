from pathlib import Path
p=Path('output/playwright/frontend-u4-2026-11-26')
s=(p/'workflow.mjs').read_text(encoding='utf8').split('let exitCode=0,debugPage')[0].replace("'workflow-r3'","'generation-r1'")
s+=r'''
let exitCode=0,debugPage
const pause=p=>p.waitForTimeout(250)
const step=(p,n)=>p.getByRole('navigation',{name:'规划步骤'}).getByRole('button',{name:new RegExp('^'+n+' ')})
const nav=(p,name)=>p.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name,exact:true})
async function start(p){await p.goto(BASE+'#/assistant');await waitText(p,'提供资料与需求');await pause(p)}
async function paste(p){await p.getByPlaceholder('粘贴通知、要求或原文…').fill('虚构通知：整理资料后写报告，要求分成两天完成。');await btn(p,'保存文字').click();await pause(p)}
async function generated(p){await p.waitForFunction(async()=>{const {useAssistantStore}=await import('/src/stores/assistant.js');return ['done','failed','save_failed','clarification'].includes(useAssistantStore().gen?.phase)});await pause(p)}
try{
 {
 const {context,page,counts}=await newScene('U4-generate');debugPage=page;const reqs=[];page.on('request',r=>{if(r.url().includes('/api/assistant/propose'))reqs.push(r.postDataJSON())})
 await start(page);await paste(page);await page.getByLabel('你想完成什么？有什么要求？').fill('虚构测试：每天60分钟，分两天完成')
 await page.locator('summary').filter({hasText:'可用时间'}).click();for(let i=0;i<7;i++)await page.getByLabel(D(i)+' 预算分钟').fill('60')
 await btn(page,'生成方案').click();await generated(page)
 let d=await activeDraft(page,'personal')
 rec('generate','选定文字、要求和七天预算进入一次模拟请求',counts.propose===1&&counts.analyze===0&&reqs[0]?.selected_sources?.[0]?.excerpt?.includes('虚构通知')&&reqs[0]?.planning_context?.days.every(d=>d.budget_minutes===60),'')
 rec('generate','生成后停在核对，未自动排程采用',d?.status==='needs_review'&&!d.planning_result&&(await docsOf(page,'personal','task')).length===0,'')
 await page.getByLabel('任务 t1 截止',{exact:true}).click();await page.getByRole('button',{name:D(3),exact:true}).click();await btn(page,'保存并预览').click();await waitText(page,'每日安排');if(await btn(page,'确认 '+D(3)).count())await btn(page,'确认 '+D(3)).click();await confirmAll(page)
 rec('preview','手动日期和预算保留，生成建议可预览',(await activeDraft(page,'personal')).planning_input.days.every(x=>x.budget_minutes===60)&&await btn(page,'下一步：确认加入').isEnabled(),'')
 await btn(page,'下一步：确认加入').click();await btn(page,'采用计划').click();await page.getByRole('alertdialog').getByRole('button',{name:'采用',exact:true}).click();await waitText(page,'已采用：')
 rec('adopt','文字到正式任务和跨天安排闭环',(await docsOf(page,'personal','task')).length===1&&(await docsOf(page,'personal','action')).length===2&&new Set((await docsOf(page,'personal','plan_item')).map(p=>p.date)).size>=2,'')
 await shot(page,'generated-adopted.png');await context.close()
 }
 {
 const {context,page,counts}=await newScene('U4-clarification');debugPage=page;await start(page);await paste(page);await page.getByLabel('你想完成什么？有什么要求？').fill('澄清演示：虚构通知该怎么拆？');await btn(page,'生成方案').click();await generated(page);await waitText(page,'模型需要澄清')
 rec('clarify','澄清未回答不能继续，不能进入最终采用',await btn(page,'继续生成').isDisabled()&&await step(page,4).isDisabled(),'')
 await btn(page,'按原文全部要求').click();await nav(page,'任务').click();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
 rec('clarify','取消离开保留未提交的澄清回答',await btn(page,'继续生成').isEnabled()&&counts.propose===1,'')
 await btn(page,'继续生成').click();await generated(page)
 rec('clarify','只有明确回答并继续才发起续轮',counts.propose===2&&(await idbAll(page,'assistant_threads'))[0]?.messages.some(m=>m.content?.includes('答：按原文全部要求')),'')
 // No pending answer after a round: saved clarification draft may be left and reopened.
 await nav(page,'任务').click();await pause(page)
 rec('clarify','已归档澄清允许离开，不锁死页面',new URL(page.url()).hash.startsWith('#/tasks'),'')
 await context.close()
 }
 {
 const {context,page,counts}=await newScene('U4-save-result');debugPage=page;await start(page);await paste(page);await page.getByLabel('你想完成什么？有什么要求？').fill('虚构：按资料规划本周')
 await page.evaluate(()=>{window.__put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v,...args){if(this.name==='assistant_drafts'&&v.proposal&&v.status==='needs_review')throw new DOMException('U4 result save failure','QuotaExceededError');return window.__put.call(this,v,...args)}})
 await btn(page,'生成方案').click();await generated(page);await waitText(page,'重试保存（不重调模型）')
 rec('result','生成结果保存失败保留重试入口，不能采用',counts.propose===1&&await step(page,4).isDisabled()&&(await docsOf(page,'personal','task')).length===0,'')
 await page.evaluate(()=>{IDBObjectStore.prototype.put=window.__put;delete window.__put});await btn(page,'重试保存（不重调模型）').click();await generated(page)
 rec('result','重试保存使用保留结果，不再次请求模型',counts.propose===1&&(await activeDraft(page,'personal')).status==='needs_review','')
 await context.close()
 }
 rec('isolation','所有模型请求仅到自起模拟服务',netHits.length===0,'')
}catch(e){if(debugPage&&!debugPage.isClosed()){await shot(debugPage,'failure.png');writeFileSync(join(RUN,'failure-body.txt'),await debugPage.locator('body').innerText())};console.error(e);rec('runner','验收异常',false,e.message);exitCode=1}finally{
 writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2));writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog)
 await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass))exitCode=1
console.log('TOTAL',results.filter(r=>r.pass).length+'/'+results.length);process.exit(exitCode)
'''
(p/'generation.mjs').write_text(s,encoding='utf8')
