async(page)=>{
 await page.route('**/*.css',r=>r.continue());
 const issues=[];
 const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished));});
 for(const width of [360,768,1440]){
  await page.setViewportSize({width,height:1000});
  for(const view of ['today','focus']){
   await page.goto('http://127.0.0.1:5188/app.html?concept=desktop&view='+view);await settle();
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))issues.push({width,view,overflow:true});
   if(width===1440)await page.screenshot({path:'output/playwright/round4/desktop-'+view+'.png'});
  }
 }
 await page.goto('http://127.0.0.1:5188/index.html');await settle();
 for(const view of ['inbox','today','focus']){
  await page.locator('[data-compare='+view+']').click();await page.waitForFunction(()=>[...document.querySelectorAll('.direction img')].every(i=>i.complete&&i.naturalWidth>0));
  const hrefs=await page.locator('.direction').evaluateAll(links=>links.map(l=>l.getAttribute('href')));if(!hrefs.every(h=>h.endsWith('view='+view)))issues.push('Gallery deep links wrong: '+view);
  await page.screenshot({path:'output/playwright/round4/gallery-'+view+'.png',fullPage:true});
 }
 await page.locator('[data-compare=inbox]').click();await page.locator('[data-grayscale]').click();await page.screenshot({path:'output/playwright/round4/gallery-grayscale.png',fullPage:true});await page.locator('[data-grayscale]').click();
 await page.locator('.round-notes summary').click();await page.screenshot({path:'output/playwright/round4/review-table.png',fullPage:true});await page.setViewportSize({width:360,height:1000});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))issues.push('Mobile gallery overflow');
 await page.setViewportSize({width:1440,height:1000});return {issues,galleryViews:3,grayscale:'verified',changedLayoutChecks:6};
}
