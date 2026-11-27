const {chromium}=require('../../frontend/node_modules/playwright-core');
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'});
 try{for(const mode of ['candidate','manual']){
 const page=await browser.newPage({viewport:{width:mode==='manual'?390:1440,height:900}});page.setDefaultTimeout(9000);const errors=[];page.on('pageerror',e=>errors.push(e.message));const btn=(name)=>page.getByRole('button',{name,exact:true});
 try{
 await page.goto('http://127.0.0.1:5174/#/today');await page.locator('nav:visible').getByRole('link',{name:'助手',exact:true}).first().click();
 await page.getByPlaceholder('粘贴通知、要求或原文…').fill('虚构通知：周五交课程报告，先整理实验数据，再写报告。');await page.getByLabel('你想完成什么？有什么要求？').fill('帮我分两天安排');
 await btn('生成方案').click();const specify=page.getByRole('button',{name:/^我指定为 /}).first();await specify.waitFor();
 if(mode==='candidate'){await specify.click();}else{
 await page.getByLabel(/^任务 .+ 截止$/).first().click();
 const friday=await page.evaluate(()=>{const date=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'}));date.setDate(date.getDate()+(5-date.getDay()+7)%7);return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-')});await btn(friday).click();await btn('保存并预览').click();}
 const adopt=page.getByRole('button',{name:/^将计划加入日程/});await adopt.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.innerText.startsWith('将计划加入日程')&&!b.disabled));
 assert.equal(await specify.isVisible(),false);assert.equal(await page.getByRole('alertdialog').count(),0);
 await page.screenshot({path:path.join(__dirname,mode+'-ready.png'),fullPage:true});
 await adopt.click();await btn('查看日程').click();await page.getByRole('dialog',{name:'工作安排详情'}).waitFor();
 const select=page.getByRole('combobox',{name:'这次做什么？'});await select.selectOption({index:1});await btn('开始这项安排').click();
 if(!page.url().includes('#/work/')){const yes=btn('确认并开始');if(await yes.isVisible()&&await yes.isEnabled())await yes.click();}
 await page.waitForURL(/#\/work\//);assert.deepEqual(errors,[]);console.log(mode+' PASS saved text, confirmed date once, adopted, selected action inline, entered timer');
 }catch(e){console.log((await page.locator('body').innerText()).slice(-1900));throw e}finally{await page.close()}
 }}finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
