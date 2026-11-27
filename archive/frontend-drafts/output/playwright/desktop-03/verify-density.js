async(page)=>{
 const failures=[],errors=[],measurements=[],actions=[];page.on('pageerror',e=>errors.push(e.message));
 const check=(ok,label)=>{if(!ok)failures.push(label);};
 const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:5188/desk.html?view=inbox');await settle();
 check(await page.locator('.pn-all-tasks').isHidden(),'Task collection initially hidden');
 const widthClosed=await page.locator('.pn-weekday-column').first().evaluate(e=>e.clientWidth);
 await page.locator('.pn-library-toggle').click();await settle();check(await page.locator('.pn-all-tasks').isVisible(),'Library opens');
 check(await page.locator('.pn-all-tasks [data-pn-detail=clippings]').isVisible(),'Unscheduled task remains discoverable');await page.screenshot({path:'output/playwright/desktop-03/library-1440.png',fullPage:true});
 await page.locator('.pn-library-close').click();check(await page.locator('.pn-all-tasks').isHidden(),'Library close');check(await page.evaluate(()=>document.activeElement.classList.contains('pn-library-toggle')),'Library close focus');
 await page.locator('.pn-nav [data-view=today]').click();
 for(let i=0;i<9;i++){await page.locator('[data-pn-add]').click();await page.locator('#pn-title').fill('同日任务 '+(i+1)+'：整理资料与实验记录');await page.locator('#pn-new-start').fill(String(8+i).padStart(2,'0')+':00');await page.locator('#pn-add-form button[type=submit]').click();}
 check(await page.locator('.pn-note').count()===12,'Twelve notes');await page.locator('.pn-nav [data-view=inbox]').click();await settle();
 const col=page.locator('[data-pn-column="2026-11-18"]');check(await col.locator('.pn-week-task').count()===12,'Twelve tasks in one day');
 const geometry=await col.evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight,overflow:getComputedStyle(e).overflowY}));measurements.push({width:1440,columnWidth:widthClosed,...geometry});check(geometry.height<=480&&geometry.scroll>geometry.height&&geometry.overflow==='auto','Bounded dense day');
 await col.focus();await page.keyboard.press('End');await page.waitForFunction(()=>{const e=document.querySelector('[data-pn-column="2026-11-18"]');return e.scrollTop>e.scrollHeight-e.clientHeight-5;});
 const before=await col.evaluate(e=>e.scrollTop);await col.locator('.pn-week-task').last().click();await page.locator('.pn-dialog-complete').click();await page.keyboard.press('Escape');
 check(Math.abs(await col.evaluate(e=>e.scrollTop)-before)<2,'Completion loses column scroll');check(await col.locator('.pn-week-task').last().evaluate(e=>document.activeElement===e),'Detail close loses task focus');
 await page.screenshot({path:'output/playwright/desktop-03/many-tasks-1440.png',fullPage:true});
 const other=page.locator('[data-pn-column="2026-11-19"]');check(await other.evaluate(e=>e.scrollTop)===0,'Day scrolls are coupled');
 actions.push('Open collection → find unscheduled task → close returns focus; create nine additional Today tasks → keyboard End in day column → complete last task → Escape retains position and focus; other days stay put.');
 await page.setViewportSize({width:768,height:1000});await settle();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Dense tablet overflow');check(await col.evaluate(e=>e.clientHeight<=480&&e.scrollHeight>e.clientHeight),'Tablet day not bounded');
 await page.setViewportSize({width:360,height:1000});await settle();check(await col.evaluate(e=>getComputedStyle(e).overflowY==='visible'),'Mobile should scroll naturally');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Dense mobile overflow');await col.locator('.pn-week-task').last().scrollIntoViewIfNeeded();await page.screenshot({path:'output/playwright/desktop-03/many-tasks-360.png'});
 await page.locator('.pn-library-toggle').click();await settle();check(await page.locator('.pn-all-tasks').isVisible(),'Mobile collection open');await page.locator('.pn-library-close').click();check(await page.evaluate(()=>document.activeElement.classList.contains('pn-library-toggle')),'Mobile collection close focus');
 actions.push('Tablet keeps independent day scrolling; mobile uses natural scrolling and can reach twelfth task; mobile collection closes back to its entry.');
 for(const width of [1440,360]){await page.setViewportSize({width,height:1000});await page.goto('http://127.0.0.1:5188/desk.html?view=inbox');await settle();await page.evaluate(()=>document.documentElement.style.filter='grayscale(1)');await page.screenshot({path:`output/playwright/desktop-03/grayscale-${width}.png`,fullPage:true});await page.evaluate(()=>document.documentElement.style.filter='');}
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:5188/desk.html');await settle();await page.locator('[data-task=report] .pn-front').screenshot({path:'output/playwright/desktop-03/note-detail.png'});
 return {failures,errors,measurements,actions,scope:'DESK-03 density, collection, focus continuity and grayscale screenshots; no performance assertion'};
}
