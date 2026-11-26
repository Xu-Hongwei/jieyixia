const {chromium}=require('../../frontend/node_modules/playwright-core');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1232/chrome-win64/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 page.setDefaultTimeout(7000);
 const button=(name)=>page.getByRole('button',{name,exact:true});
 const read=async()=>console.log((await page.locator('main').innerText()).slice(-1400));
 const click=async(label,loc=button(label))=>{await loc.click();console.log(label);await page.waitForTimeout(250)};
 try {
 await page.goto('http://127.0.0.1:5174/#/today');await click('助手',page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'助手'}));
 await page.getByPlaceholder('粘贴通知、要求或原文…').fill('虚构通知：周五交课程报告，先整理实验数据，再写报告。');
 console.log('粘贴后生成按钮可用',await button('生成方案').isEnabled());await click('保存文字');
 await page.getByLabel('你想完成什么？有什么要求？').fill('帮我分两天安排');await click('生成方案');await page.getByRole('button',{name:'保存并预览'}).waitFor();
 await read();
 for(const name of ['确认替换范围','确认额外工作']) if(await button(name).isVisible()) await click(name);
 const dateControl=page.getByLabel('任务 t1 截止',{exact:true});await dateControl.click();
 const correct=await page.evaluate(()=>{const d=new Date();const start=new Date(d.toLocaleString('en-US',{timeZone:'Asia/Shanghai'}));start.setDate(start.getDate()+(5-start.getDay()+7)%7);return [start.getFullYear(),String(start.getMonth()+1).padStart(2,'0'),String(start.getDate()).padStart(2,'0')].join('-')});
 await click(correct);
 const deadline=page.getByRole('button',{name:/^确认 \d{4}-/}).first();/* edited deadline saved with form */
 await click('保存并预览');await page.locator('section[aria-label="预览安排"]').waitFor();await read();
 if(await deadline.isVisible())await click(await deadline.innerText(),deadline);
 for(const name of ['确认仍有未排','确认过载','确认额外工作']){const opt=button(name).first();while(await opt.isVisible())await click(name,opt)}
 await click('下一步：确认加入');await click('采用计划');await click('采用',page.getByRole('alertdialog').getByRole('button',{name:'采用',exact:true}));await click('查看日程');
 const card=page.getByRole('button',{name:/^安排详情：/}).first();if(!await page.getByRole('dialog',{name:'工作安排详情'}).isVisible()) await click('打开第一项安排',card);
 await click('开始这项安排');console.log((await page.locator('body').innerText()).slice(-1050));
 if(await button('确认并开始').isVisible() && await button('确认并开始').isEnabled())await click('确认并开始');
 else if(await button('去任务选择行动').isVisible()){await click('去任务选择行动');const choose=button('设为当前').first();if(await choose.isVisible())await click('设为当前',choose);await click('开始这项安排');await click('确认并开始');await page.waitForURL(/#\/work\//);}
 console.log('END',page.url());
 }catch(e){await read().catch(()=>{});console.log('STOP',String(e));process.exitCode=1}finally{await browser.close()}
})()


