const { chromium } = require('../../.pw-runtime/node_modules/playwright');
const fs = require('fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',args:['--disable-gpu']});
 const context=await browser.newContext({viewport:{width:1440,height:980},deviceScaleFactor:1});
 const page=await context.newPage();
 const errors=[]; page.on('pageerror',e=>errors.push(String(e))); page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
 const base='http://127.0.0.1:5188/desk.html?v=desk04';
 const snap=async name=>{await page.screenshot({path:`output/playwright/desktop-05/${name}.png`,fullPage:true});};
 const state=async()=>page.evaluate(()=>({bodyClass:document.body.className,paperAsset:document.body.dataset.paperAsset||'',lightScene:document.body.dataset.lightScene||'',canvasDisplay:getComputedStyle(document.querySelector('.pn-light-canvas')).display,notes:document.querySelectorAll('.pn-note').length}));
 await page.goto(base); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1400); const initial=await state(); await snap('today-1440');
 const card=page.locator('.pn-note[data-task="report"]');
 const center=await card.boundingBox(); await card.click({position:{x:(center?.width||250)/2,y:(center?.height||420)/2}}); await page.waitForTimeout(760); const flipped=await card.evaluate(el=>({className:el.className,frontHidden:el.querySelector('.pn-front')?.getAttribute('aria-hidden'),backHidden:el.querySelector('.pn-back')?.getAttribute('aria-hidden')})); await snap('flip-1440');
 await card.click({position:{x:(center?.width||250)/2,y:120}}); await page.waitForTimeout(760); const flippedBack=await card.evaluate(el=>({className:el.className,frontHidden:el.querySelector('.pn-front')?.getAttribute('aria-hidden'),backHidden:el.querySelector('.pn-back')?.getAttribute('aria-hidden')})); await snap('flip-back-1440');
 await card.locator('[data-pn-complete]').click(); await page.waitForTimeout(420); const completed=await card.evaluate(el=>({complete:el.classList.contains('is-complete'),flipped:el.classList.contains('is-flipped')}));
 await card.locator('.pn-front [data-pn-flip]').click(); await page.waitForTimeout(760); const buttonFlip=await card.evaluate(el=>el.classList.contains('is-flipped')); await card.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(760); const keyFlip=await card.evaluate(el=>el.classList.contains('is-flipped')); await page.keyboard.press(' '); await page.waitForTimeout(760); const keyFlipBack=await card.evaluate(el=>el.classList.contains('is-flipped'));
 await page.goto(base+'&view=inbox'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(900); const week=await state(); await snap('week-1440');
 await page.setViewportSize({width:360,height:860}); await page.goto(base); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1000); const mobile=await state(); await snap('today-360');
 await page.emulateMedia({reducedMotion:'reduce'}); await page.goto(base); await page.waitForLoadState('networkidle'); await page.waitForTimeout(700); const reduced=await state(); const reducedFlipCard=page.locator('.pn-note[data-task="report"]'); await reducedFlipCard.click({position:{x:120,y:120}}); await page.waitForTimeout(30); const reducedFlip=await reducedFlipCard.evaluate(el=>el.classList.contains('is-flipped'));
 await page.setViewportSize({width:1440,height:980}); await page.emulateMedia({reducedMotion:'no-preference'}); await page.goto(base+'&fx=off'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(900); const disabled=await state();
 const result={initial,flipped,flippedBack,completed,buttonFlip,keyFlip,keyFlipBack,week,mobile,reduced,reducedFlip,disabled,errors}; fs.writeFileSync('output/playwright/desktop-05/verification.json',JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2)); await browser.close();
})();



