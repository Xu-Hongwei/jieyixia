async (page) => {
 await page.route('**/*.css',r=>r.continue());
 await page.setViewportSize({width:1440,height:1000});
 const out=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const concept of ['signal','orbit','paper','desktop']){
  await page.goto('http://127.0.0.1:5188/app.html?concept='+concept);
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished));});
  await page.screenshot({path:'output/playwright/round3/'+concept+'.png'});
  out.push(await page.evaluate(()=>({title:document.title,width:innerWidth,scroll:document.documentElement.scrollWidth,composition:document.querySelector('[data-composition]')?.dataset.composition,source:document.querySelector('h1')?.textContent})));
 }
 return {out,errors};
}
