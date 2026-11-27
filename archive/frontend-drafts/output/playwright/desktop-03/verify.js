async(page)=>{
 const failures=[],errors=[],layouts=[],actions=[];page.on('pageerror',e=>errors.push(e.message));
 const check=(ok,message)=>{if(!ok)failures.push(message);};
 const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
 const openLibrary=async()=>{if(await page.locator('.pn-library-toggle').getAttribute('aria-expanded')!=='true')await page.locator('.pn-library-toggle').click();};
 const safe=async label=>check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Overflow: '+label);
 for(const width of [360,768,1440]){
  await page.setViewportSize({width,height:1000});await page.goto('http://127.0.0.1:5188/desk.html');await settle();
  await safe('board '+width);layouts.push({width,view:'board'});check(await page.locator('.pn-note').count()===3,'Today board task count');
  await page.screenshot({path:`output/playwright/desktop-03/today-${width}.png`,fullPage:true});
  await page.locator('.pn-nav [data-view=inbox]').click();await settle();await safe('week '+width);layouts.push({width,view:'week'});
  check(await page.locator('.pn-week-heads>button').count()===7,'Week needs seven days');
  await page.screenshot({path:`output/playwright/desktop-03/inbox-${width}.png`,fullPage:true});
  await page.locator('[data-pn-mode=month]').click();await settle();await safe('month '+width);layouts.push({width,view:'month'});check(await page.locator('.pn-day-number').count()===30,'November dates');
  await page.screenshot({path:`output/playwright/desktop-03/month-${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:5188/desk.html');await settle();
 const report=page.locator('.pn-note[data-task=report]');const before=await report.boundingBox();await report.locator('.pn-front .pn-flip').focus();await page.keyboard.press('Enter');await settle();
 check(await report.evaluate(e=>e.classList.contains('is-flipped')&&e.querySelector('.pn-front').inert&&!e.querySelector('.pn-back').inert),'Accessible flip state');
 check(await report.locator('.pn-back').innerText().then(t=>t.includes('说明实验设置')),'Requirements missing from reverse');
 const after=await report.boundingBox();check(Math.abs(before.y-after.y)<1&&Math.abs(before.height-after.height)<1,'Flip moves wall layout');
 await page.screenshot({path:'output/playwright/desktop-03/reverse-1440.png',fullPage:true});
 await report.locator('.pn-back .pn-flip').click();await settle();check(await report.evaluate(e=>!e.classList.contains('is-flipped')),'Flip back failed');
 await report.locator('[data-pn-complete]').click();check(await page.locator('.pn-board-bottom strong').textContent().then(t=>t.trim().startsWith('1')),'Completion progress');
 await page.locator('.pn-nav [data-view=inbox]').click();check(await page.locator('.pn-week-task[data-pn-detail=report]').evaluate(e=>e.classList.contains('is-complete')),'Completion not synced to calendar');
 await page.locator('[data-pn-week="1"]').click();check(await page.locator('.pn-month-toolbar h2').textContent().then(t=>t.includes('11.23')),'Next week');await page.locator('[data-pn-week=today]').click();
 await openLibrary();await page.locator('.pn-all-tasks [data-pn-detail=report]').click();await page.locator('#pn-plan-date').fill('2026-11-19');await page.locator('#pn-plan-time').fill('15:30');await page.locator('[data-pn-schedule=report]').click();check(await page.locator('#pn-plan-date').inputValue()==='2026-11-19','Reschedule value');await page.keyboard.press('Escape');
 await page.locator('.pn-nav [data-view=today]').click();check(await page.locator('.pn-note').count()===2,'Rescheduling did not remove from Today');
 await page.locator('.pn-nav [data-view=inbox]').click();await openLibrary();await page.locator('.pn-all-tasks [data-pn-detail=report]').click();check(await page.locator('.pn-dialog-due').textContent().then(t=>t.includes('11 月 22 日')),'Schedule changed deadline');await page.locator('[data-pn-today=report]').click();check(await page.locator('.pn-note').count()===3,'Move back to today failed');
 actions.push('Keyboard flip → read reverse → flip back without layout shift; completion syncs across views; next/current week; reschedule changes Today while preserving deadline.');
 await report.locator('.pn-front .pn-flip').click();await settle();await report.locator('[data-pn-remove=report]').click();check(await page.locator('.pn-note[data-task=report]').count()===0,'Remove from today failed');await page.locator('.pn-nav [data-view=inbox]').click();await openLibrary();check(await page.locator('.pn-all-tasks [data-pn-detail=report]').count()===1,'Taking off wall deleted task');
 await openLibrary();await page.locator('.pn-all-tasks [data-pn-detail=clippings]').click();check(await page.locator('.pn-dialog-due').textContent().then(t=>t.includes('未设截止日期')),'Missing deadline fabricated');await page.locator('[data-pn-today=clippings]').click();check(await page.locator('[data-task=clippings] .pn-deadline').textContent().then(t=>t.includes('未设截止日期')),'No-deadline note missing');
 await page.locator('[data-pn-add]').click();await page.locator('#pn-title').fill('长任务：'+('整理研究实验与课程报告的详细要求'.repeat(5)));await page.locator('#pn-due').fill('2026-11-22');await page.locator('#pn-time').fill('23:59');await page.locator('#pn-requirements').fill(Array.from({length:25},(_,i)=>`${i+1}. 核对原始实验数据与参数，记录可复现的分析过程。`).join('\n'));await page.locator('#pn-new-plan').fill('2026-11-18');await page.locator('#pn-new-start').fill('16:00');await page.locator('#pn-add-form button[type=submit]').click();
 const long=page.locator('.pn-note').last();check(await long.locator('h2').textContent().then(t=>t.includes('长任务')),'New note missing');await long.locator('.pn-front .pn-flip').click();await settle();check(await long.locator('.pn-requirements li').count()===25,'Long reverse lost content');await long.locator('.pn-requirements').evaluate(e=>e.scrollTop=e.scrollHeight);await safe('long note desktop');
 await page.setViewportSize({width:360,height:1000});await safe('long note mobile');await long.scrollIntoViewIfNeeded();await page.screenshot({path:'output/playwright/desktop-03/long-reverse-360.png'});
 await page.locator('[data-pn-add]').click();await page.locator('#pn-title').fill('稍后安排的新任务');await page.locator('#pn-new-plan').fill('');await page.locator('#pn-add-form button[type=submit]').click();check(await page.locator('.pn-all-tasks .pn-task-row').count()===9,'All tasks excludes unscheduled task');check(await page.locator('.pn-all-tasks').textContent().then(t=>t.includes('稍后安排的新任务')),'Unscheduled new task missing');
 actions.push('Taking a note off Today retains it in All tasks; no-deadline state remains explicit; add a long note with 25 requirements; new unscheduled task remains in calendar list.');
 await page.goto('http://127.0.0.1:5188/desk.html?view=inbox');await page.locator('[data-pn-day="2026-11-19"]').click();check(await page.locator('.pn-weekday-column.is-selected .pn-week-task').count()===1,'Mobile selected day does not switch');await page.locator('.pn-weekday-column.is-selected .pn-week-task').click();check(await page.locator('#pn-detail').evaluate(e=>e.open),'Mobile task detail');await page.keyboard.press('Escape');
 await page.locator('[data-pn-mode=month]').click();await settle();await page.locator('[data-pn-day="2026-11-18"]').click();check(await page.locator('.pn-selected-day .pn-task-row').count()===3,'Month detail does not show all daily tasks');await page.locator('[data-pn-month="1"]').click();check(await page.locator('.pn-day-number').count()===31,'December date count');await page.locator('[data-pn-month=today]').click();
 await page.emulateMedia({reducedMotion:'reduce'});await page.locator('.pn-nav [data-view=today]').click();await page.locator('[data-task=report] .pn-front .pn-flip').click();check(await page.locator('[data-task=report] .pn-rotor').evaluate(e=>getComputedStyle(e).transitionDuration==='0s'),'Reduced motion flip');await page.emulateMedia({reducedMotion:'no-preference'});
 await page.goto('http://127.0.0.1:5188/desk.html');for(const id of ['report','probability','experiment']){await page.locator(`[data-task=${id}] .pn-front .pn-flip`).click();await settle();await page.locator(`[data-task=${id}] [data-pn-remove]`).click();}check(await page.locator('.pn-empty').isVisible(),'Empty Today wall');await page.screenshot({path:'output/playwright/desktop-03/empty-360.png',fullPage:true});
 actions.push('Mobile day selection → task details; month switch shows three tasks on one day; adjacent month; reduced-motion flip; empty Today wall.');
 for(const key of ['signal','orbit','paper']){await page.goto('http://127.0.0.1:5188/app.html?concept='+key);check(await page.locator('.collage-planner').count()===0,'Planner affected '+key);}
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:5188/desk.html');await settle();check(await page.locator('.pn-note').count()===3,'Refresh reset');
 return {layoutChecks:layouts.length,layouts,failures,errors,actions,scope:'DESK-03; two pages, weekly default and monthly option; local demo data only'};
}


