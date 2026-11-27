async (page) => {
 const failures=[],checks=[]; await page.route('**/*.css', route=>route.continue());
 const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished));});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of [360,768,1440]){
  await page.setViewportSize({width,height:1000});
  for(const concept of ['signal','orbit','paper','desktop']){
   await page.goto('http://127.0.0.1:5188/app.html?concept='+concept);
   for(const view of ['today','inbox','focus']){
    await page.locator('.art-nav[data-view='+view+']').click();await settle();
    const measured=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,h1:document.querySelector('#art-view h1')?.textContent}));
    checks.push({width,concept,view,...measured});
    if(measured.scroll>width+1)failures.push({width,concept,view,scroll:measured.scroll});
   }
   if(width===360){await page.locator('.art-nav[data-view='+(concept==='orbit'?'focus':concept==='paper'?'inbox':'today')+']').click();await settle();await page.screenshot({path:'output/playwright/'+concept+'-mobile.png',fullPage:true});}
  }
 }
 await page.goto('http://127.0.0.1:5188/app.html?concept=paper');
 await page.locator('.create-task').waitFor();
 if(!await page.locator('.create-task').isDisabled())failures.push('Task creation allowed before confirmation');
 for(const key of ['requirements','deadline','submit'])await page.locator('[data-confirm='+key+']').click();
 if(await page.locator('.create-task').isDisabled())failures.push('Task creation blocked after confirmation');
 await page.locator('.create-task').click();await page.locator('.art-nav[data-view=today]').click();
 if(await page.locator('.art-new-task').count()!==1)failures.push('New unplanned task missing');
 await page.locator('[data-done="0"]').click();if(await page.locator('[data-done="0"]').getAttribute('aria-pressed')!=='true')failures.push('Plan toggle failed');
 await page.locator('[data-start="0"]').first().click();await page.locator('[data-action=timer]').click();
 await page.waitForFunction(()=>document.getElementById('time')?.textContent!=='25:00');await page.locator('[data-action=timer]').click();
 const paused=await page.locator('#time').textContent();
 await page.locator('#focus-notes').fill('演示核对：保留工作思路');await page.locator('.art-nav[data-view=today]').click();await page.locator('.art-nav[data-view=focus]').click();
 if(await page.locator('#focus-notes').inputValue()!=='演示核对：保留工作思路')failures.push('Focus draft lost on navigation');
 if(await page.locator('#time').textContent()!==paused)failures.push('Paused timer changed');
 await page.locator('[data-action=add]').first().click();await page.locator('#capture-text').fill('新灵感：从一张截图开始');await page.locator('#capture-form button[type=submit]').click();
 if(!await page.locator('.art-manuscript').textContent().then(s=>s.includes('新灵感')))failures.push('Temporary capture failed');
 await page.locator('#note-search').fill('不存在的资料');if(await page.locator('.art-note').count())failures.push('Search filter failed');
 await page.goto('http://127.0.0.1:5188/app.html?concept=paper');await settle();
 if(!await page.locator('.create-task').isDisabled())failures.push('Demo did not reset on reload');
 await page.goto('http://127.0.0.1:5188/index.html');await settle();
 if(await page.locator('.direction').count()!==4)failures.push('Gallery links missing');
 await page.screenshot({path:'output/playwright/gallery.png',fullPage:true});
 return {layoutChecks:checks.length,failures,errors,flows:['field confirmation gate','create unplanned task','plan toggle','timer start/pause','focus draft navigation','temporary text capture','search','reload resets demo','gallery']};
}
