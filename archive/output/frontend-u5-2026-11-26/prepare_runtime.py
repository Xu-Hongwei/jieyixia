from pathlib import Path
out=Path('output/playwright/frontend-u5-2026-11-26')
s=(out/'visual.mjs').read_text(encoding='utf8').split('let exitCode=0;const metrics=[]')[0].replace("process.env.U5_BASELINE ? 'before' : 'after'","'runtime-r1'")
s+=r'''
let exitCode=0,debugPage
const pause=p=>p.waitForTimeout(200)
const nav=(p,name)=>p.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name,exact:true})
try{
 {
 const {context,page}=await newScene('cold-offline');debugPage=page
 await page.goto(BASE+'#/tasks');await page.getByRole('heading',{name:'任务',exact:true}).waitFor();await context.setOffline(true)
 await nav(page,'助手').click();await waitText(page,'助手暂时无法打开')
 rec('offline','未缓存助手断网有提示，原任务页面仍在',await page.getByRole('heading',{name:'任务',exact:true}).isVisible()&&await btn(page,'重试打开').isVisible(),'')
 await shot(page,'cold-offline.png');await context.setOffline(false);await btn(page,'重试打开').click();await waitText(page,'提供资料与需求')
 rec('recovery','恢复网络后重试原目标成功，错误提示消失',!await btn(page,'重试打开').count()&&new URL(page.url()).hash==='#/assistant','')
 await nav(page,'任务').click();await page.waitForTimeout(2600);await context.setOffline(true)
 await page.getByRole('link',{name:'数据管理',exact:true}).click();await waitText(page,'导出当前空间备份')
 const [download]=await Promise.all([page.waitForEvent('download'),btn(page,'导出当前空间备份').click()]);await download.saveAs(join(RUN,'offline-backup.zip'))
 rec('offline','空闲预加载后断网仍能打开数据页并导出备份',download.suggestedFilename().endsWith('.zip'),'')
 await nav(page,'任务').click();await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('虚构：U5 离线任务');await btn(page,'保存任务').click();await waitText(page,'虚构：U5 离线任务')
 rec('offline','断网创建任务实际落库',(await docsOf(page,'personal','task')).some(t=>t.title==='虚构：U5 离线任务'),'')
 await nav(page,'助手').click();await waitText(page,'提供资料与需求')
 rec('offline','已加载助手可离线重新打开',await page.getByRole('heading',{name:'规划助手',exact:true}).isVisible(),'')
 await context.close()
 }
 {
 const {context,page}=await newScene('loading');debugPage=page
 await context.route('**/assets/AssistantPage-*.js',async route=>{await new Promise(r=>setTimeout(r,900));await route.continue()})
 await page.goto(BASE+'#/tasks');await page.getByRole('heading',{name:'任务',exact:true}).waitFor();await nav(page,'助手').click();await waitText(page,'正在打开助手');await waitText(page,'提供资料与需求')
 rec('loading','慢加载有短提示，完成后收起',!await page.getByText('正在打开助手…',{exact:true}).count(),'')
 await context.close()
 }
 {
 const {context,page}=await newScene('U5-layout');debugPage=page;await boot(page)
 for(const route of ['today','tasks','collect','assistant']){
  await page.goto(BASE+'#/'+route);await pause(page)
  for(const width of [360,390,430,768,1440]){await page.setViewportSize({width,height:844});await pause(page);rec('layout',route+' '+width,await page.evaluate(()=>document.documentElement.scrollWidth)<=width,'')}
 }
 await page.setViewportSize({width:390,height:450});await page.goto(BASE+'#/tasks');await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('虚构短窗口输入');await page.getByLabel('新任务名称').focus()
 rec('input','手机输入字号不小于16px',await page.getByLabel('新任务名称').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))>=16,'')
 await btn(page,'保存任务').scrollIntoViewIfNeeded();const b=await btn(page,'保存任务').boundingBox(),bar=await page.getByRole('navigation',{name:'移动主导航'}).boundingBox()
 rec('input','短视口可以滚动让保存按钮露出底栏上方',b.y+b.height<=bar.y,'')
 await nav(page,'日程').click();await page.getByRole('alertdialog').waitFor();const d=await page.getByRole('alertdialog').boundingBox()
 rec('dialog','短视口确认框在屏幕内且有取消操作',d.y>=0&&d.y+d.height<=450&&await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).isVisible(),'')
 await shot(page,'short-viewport-confirm.png');await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click();await page.getByLabel('新任务名称').fill('');await btn(page,'取消').click()
 await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Tab')
 rec('accessibility','减少动态效果时保留可见焦点',await page.evaluate(()=>{const e=document.activeElement;return e!==document.body&&parseFloat(getComputedStyle(e).outlineWidth)>0}),'')
 rec('isolation','未访问用户服务',netHits.length===0,'');await context.close()
 }
}catch(e){if(debugPage&&!debugPage.isClosed()){await shot(debugPage,'failure.png');writeFileSync(join(RUN,'failure-body.txt'),await debugPage.locator('body').innerText())};console.error(e);rec('runner','异常',false,e.message);exitCode=1}finally{
 writeFileSync(join(RUN,'results.json'),JSON.stringify({results,netHits},null,2));writeFileSync(join(RUN,'backend.log'),backendLog);writeFileSync(join(RUN,'vite.log'),viteLog);await browser.close();vite.kill();backend.kill()
}
if(results.some(r=>!r.pass))exitCode=1
console.log('TOTAL',results.filter(r=>r.pass).length+'/'+results.length);process.exit(exitCode)
'''
(out/'runtime.mjs').write_text(s,encoding='utf8')
