async(page)=>{
 await page.route('**/*.css',r=>r.continue());
 const failures=[],errors=[],layouts=[],flows=[];page.on('pageerror',e=>errors.push(e.message));
 const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished));});
 for(const width of [360,768,1440]){
  await page.setViewportSize({width,height:1000});
  for(const concept of ['signal','orbit','paper','desktop']){
   await page.goto('http://127.0.0.1:5188/app.html?concept='+concept);
   for(const view of ['inbox','today','focus']){
    await page.locator('.r3-nav[data-view='+view+']').click();await settle();
    const measured=await page.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth}));layouts.push({width,concept,view,...measured});
    if(measured.scroll>width+1)failures.push({width,concept,view,...measured});
    if(width===1440)await page.screenshot({path:'output/playwright/round4/'+concept+(view==='inbox'?'':'-'+view)+'.png'});
    if(width===360&&view==='inbox')await page.screenshot({path:'output/playwright/round4/'+concept+'-mobile.png',fullPage:true});
   }
  }
 }
 await page.setViewportSize({width:1440,height:1000});
 for(const concept of ['signal','orbit','paper','desktop']){
  await page.goto('http://127.0.0.1:5188/app.html?concept='+concept);await settle();
  const build=page.locator('[data-action=create-task]');if(!await build.isDisabled())failures.push(concept+': task gate missing');
  for(const field of ['requirements','deadline','submit']){await page.locator('[data-confirm='+field+']').click();if(await page.evaluate(()=>document.activeElement?.dataset.confirm)!==field)failures.push(concept+': confirmation focus lost');}
  if(await build.isDisabled())failures.push(concept+': confirmed task still blocked');
  await build.click();await page.locator('.r3-nav[data-view=today]').click();
  if(await page.locator('.r3-unplanned').count()!==1)failures.push(concept+': new task missing');
  await page.locator('[data-done="0"]').click();if(await page.locator('[data-done="0"]').getAttribute('aria-pressed')!=='true')failures.push(concept+': plan toggle failed');
  await page.locator('[data-start="0"]').click();await page.locator('#focus-notes').fill('核对后的提纲草稿');await page.locator('[data-action=timer]').click();
  await page.waitForFunction(()=>document.getElementById('time').textContent!=='25:00');await page.locator('[data-action=timer]').click();
  const clock=await page.locator('#time').textContent();await page.locator('.r3-nav[data-view=today]').click();await page.locator('.r3-nav[data-view=focus]').click();
  if(await page.locator('#focus-notes').inputValue()!=='核对后的提纲草稿')failures.push(concept+': focus draft lost');
  if(await page.locator('#time').textContent()!==clock)failures.push(concept+': paused timer changed');
  await page.locator('[data-action=add]').first().click();await page.locator('#capture-text').fill('一份很长的课程报告补充说明：'+('保留原始资料，逐项核对，并写下下一步行动。'.repeat(18)));await page.locator('#capture-form button[type=submit]').click();await settle();
  if(!await page.locator('#r3-view').textContent().then(t=>t.includes('一份很长')))failures.push(concept+': temporary content missing');
  await page.setViewportSize({width:360,height:1000});await settle();const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);if(overflow)failures.push(concept+': long content overflow');await page.setViewportSize({width:1440,height:1000});
  if(concept==='paper'||concept==='desktop')await page.locator('[data-r3-library]').click();
  await page.locator('#note-search').fill('没有这份资料');if(await page.locator('.r3-source-option').count())failures.push(concept+': empty search failed');await page.locator('#note-search').fill('');await page.locator('[data-note="0"]').click();
  await page.reload();if(!await page.locator('[data-action=create-task]').isDisabled())failures.push(concept+': refresh reset failed');
  flows.push(concept+': confirmation gate, task, plan, timer, draft, capture, long text, empty search, refresh');
 }
 await page.goto('http://127.0.0.1:5188/app.html?concept=orbit');await page.locator('[data-r3-error]').click();if(!await page.locator('.r3-error').isVisible())failures.push('failure state not visible');await page.locator('.r3-error button').click();if(await page.locator('.r3-error').count())failures.push('failure state not dismissed');
 await page.goto('http://127.0.0.1:5188/app.html?concept=desktop');await settle();const grip=page.locator('[data-paper=source] .paper-grip');await grip.focus();await page.keyboard.press('ArrowRight');const shifted=await page.locator('[data-paper=source]').evaluate(e=>e.style.translate);if(!shifted.startsWith('8px'))failures.push('Keyboard move failed');await page.keyboard.press('Home');if(await page.locator('[data-paper=source]').evaluate(e=>e.style.translate.split(' ').some(v=>parseFloat(v)!==0)))failures.push('Keyboard reset failed');
 await page.setViewportSize({width:360,height:900});await page.reload();await settle();await page.locator('[data-confirm=requirements]').scrollIntoViewIfNeeded();const accessible=await page.locator('[data-confirm=requirements]').evaluate(el=>{const r=el.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el===top||el.contains(top);});if(!accessible)failures.push('Mobile confirm occluded');
 await page.goto('http://127.0.0.1:5188/app.html?concept=signal');await page.locator('.mobile-review-jump').click();if(!page.url().endsWith('#review-fields'))failures.push('Mobile jump failed');
 await page.goto('http://127.0.0.1:5188/app.html?concept=orbit');if(await page.locator('.matrix-raw').count())failures.push('Mobile full source should start collapsed');await page.locator('[data-action=toggle-raw]').click();if(!await page.locator('.matrix-raw').isVisible())failures.push('Mobile source expand failed');
 await page.setViewportSize({width:1440,height:1000});return {layoutChecks:layouts.length,failures,errors,flows,extra:['confirmation keyboard focus','keyboard paper movement and reset','mobile dock hit target','mobile jump','mobile source collapse and expand']};
}
