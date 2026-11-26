from pathlib import Path
out=Path('output/playwright/frontend-u5-2026-11-26');out.mkdir(parents=True,exist_ok=True)
s=Path('output/playwright/frontend-u4-2026-11-26/accept.mjs').read_text(encoding='utf8').split('let exitCode = 0')[0]
s=s.replace("const RUN = join(HERE, 'browser-final')", "const RUN = join(HERE, process.env.U5_BASELINE ? 'before' : 'after')")
s=s.replace("['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(VPORT), '--strictPort']", "['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(VPORT), '--strictPort', '--outDir', process.env.U5_BASELINE ? 'E:/qoder/output/frontend-u5-2026-11-26/baseline/dist' : 'dist']")
s+=r'''
let exitCode=0;const metrics=[]
try{
 const {context,page}=await newScene('U5-visual')
 await page.goto(BASE+'#/today');await waitText(page,'周视图');await page.waitForTimeout(100)
 metrics.push(await page.evaluate(()=>({stage:'initial',resources:performance.getEntriesByType('resource').filter(r=>r.name.includes('/assets/')).map(r=>({url:r.name.split('/').pop(),bytes:r.decodedBodySize,start:r.startTime})),domContentLoaded:performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd})))
 await page.waitForTimeout(2500)
 metrics.push(await page.evaluate(()=>({stage:'settled',resources:performance.getEntriesByType('resource').filter(r=>r.name.includes('/assets/')).map(r=>({url:r.name.split('/').pop(),bytes:r.decodedBodySize,start:r.startTime}))})))
 await seed(page);await page.reload();await waitText(page,'周视图')
 for(const route of ['today','tasks','collect','assistant']){
  await page.goto(BASE+'#/'+route);await page.waitForTimeout(300)
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:width===390?844:1000});await page.waitForTimeout(150)
   await shot(page,route+'-'+width+'.png');rec('layout',route+' '+width,await page.evaluate(()=>document.documentElement.scrollWidth)<=width,'')
  }
 }
 await context.close()
}catch(e){console.error(e);rec('runner','异常',false,e.message);exitCode=1}finally{
 writeFileSync(join(RUN,'metrics.json'),JSON.stringify(metrics,null,2));writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2));writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog);await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass))exitCode=1
process.exit(exitCode)
'''
(out/'visual.mjs').write_text(s,encoding='utf8')
