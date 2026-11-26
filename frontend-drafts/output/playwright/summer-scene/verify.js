const { chromium } = require('../../.pw-runtime/node_modules/playwright');
const fs=require('fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',args:['--disable-gpu']});
 const context=await browser.newContext({viewport:{width:1440,height:980},deviceScaleFactor:1});
 const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(String(e))); page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.goto('http://127.0.0.1:5188/desk.html?scene=summer&v=summer-v1'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200);
 const state=await page.evaluate(()=>({scene:document.body.dataset.scene,lightScene:document.body.dataset.lightScene,loop:document.body.dataset.loopDuration,paper:document.body.dataset.paperAsset,canvas:getComputedStyle(document.querySelector('.pn-light-canvas')).display,bodyClass:document.body.className}));
 const frameA=await page.screenshot({clip:{x:0,y:120,width:1440,height:500}});
 await page.screenshot({path:'output/playwright/summer-scene/summer-window-1440.png',fullPage:true});
 await page.waitForTimeout(900); const frameB=await page.screenshot({clip:{x:0,y:120,width:1440,height:500}});
 await page.setViewportSize({width:360,height:860}); await page.goto('http://127.0.0.1:5188/desk.html?scene=summer&v=summer-v1'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(900); await page.screenshot({path:'output/playwright/summer-scene/summer-window-360.png',fullPage:true});
 const mobile=await page.evaluate(()=>({scene:document.body.dataset.scene,lightScene:document.body.dataset.lightScene,canvas:getComputedStyle(document.querySelector('.pn-light-canvas')).display}));
 const result={state,frameBytesA:frameA.length,frameBytesB:frameB.length,frameChanged:!frameA.equals(frameB),mobile,errors}; fs.writeFileSync('output/playwright/summer-scene/verification.json',JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2)); await browser.close();
})();


