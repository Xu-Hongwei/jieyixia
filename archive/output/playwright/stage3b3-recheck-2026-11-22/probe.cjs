const L=require('./accept-lib.cjs'), fs=require('node:fs');
(async()=>{const b=await L.launch();const checks=[];const errors=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});if(!pass)throw Error(name+': '+JSON.stringify(detail));};
try{
 const {c,p,errors:errs}=await L.newPage(b,{clock:true});errors.push(errs);
 await L.openApp(p);await L.seed(p);await p.reload();await L.openApp(p);await p.clock.pauseAt(new Date('2026-11-21T02:00:02Z'));
 await p.goto(L.BASE+'/#/tasks/t1');await p.getByRole('button',{name:'开始执行',exact:true}).click();await p.waitForURL(/#\/work\//);
 await p.getByRole('textbox',{name:'本次成果正文'}).fill('旧页必须保留的独有文本');const sid=(await L.docs(p)).find(d=>d.kind==='focus_session').id;
 const q=await c.newPage();await q.goto(L.BASE+'/#/today');await q.waitForFunction(async()=>{const {useAppStore}=await import('/src/stores/app.js');return useAppStore().ready});
 const finish=await q.evaluate(async sid=>{const {createFocusService}=await import('/src/services/focus/service.js');const db=await import('/src/services/storage/db.js');db.configureWorkspace('personal');const svc=createFocusService({getWorkspaceId:()=> 'personal',ownerId:'review-new-owner',wallNow:()=> '2026-11-21T02:00:42Z',scheduler:{set:()=>0,clear:()=>{}}});const t=await svc.takeover({sessionId:sid});const r=await svc.recover({sessionId:sid,mode:'keep'});const e=await svc.end({sessionId:sid,outcome:'partial',draftMd:'新页最终成果'});svc.stop();return {t:t.ok,r:r.ok,e:e.ok,details:{t,r,e}}},sid);
 check('新持有者接管恢复结束成功',finish.t&&finish.r&&finish.e,finish);
 await p.clock.setSystemTime(new Date('2026-11-21T02:00:42Z'));await p.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await p.getByRole('button',{name:'复制我的输入',exact:true}).waitFor();
 const text=await p.locator('body').innerText();check('旧页停留并可见本地文本与最终成果',p.url().includes('/work/'+sid)&&text.includes('旧页必须保留的独有文本')&&text.includes('新页最终成果'));
 await p.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.__copiedReview=t}}})});
 await p.getByRole('button',{name:'复制我的输入',exact:true}).click();check('复制入口传入完整本地文本',await p.evaluate(()=>window.__copiedReview)==='旧页必须保留的独有文本');
 await p.evaluate(async()=>{const {router}=await import('/src/app/router.js');window.__nav='pending';router.push('/today').then(r=>window.__nav=r?'cancelled':'succeeded')});
 await p.getByRole('dialog').waitFor();await p.keyboard.press('Escape');await p.waitForTimeout(100);
 check('核对页Escape确定取消导航且保留文本',(await p.evaluate(()=>window.__nav))==='cancelled'&&(await p.locator('body').innerText()).includes('旧页必须保留的独有文本'));
 await p.getByRole('button',{name:'舍弃本地输入，查看历史',exact:true}).click();await p.waitForURL(/#\/work-records\//);
 const saved=(await L.docs(p)).find(d=>d.id===sid);check('明确舍弃才进入历史且最终成果不变',saved.draft_md==='新页最终成果'&&!saved.running&&saved.ended_at!=null,saved);
 await c.close();
 const next=await L.newPage(b);const a=next.p;errors.push(next.errors);await L.openApp(a);await L.seed(a);await a.reload();await L.openApp(a);await a.goto(L.BASE+'/#/tasks/t1');await a.getByRole('button',{name:'开始执行',exact:true}).click();await a.waitForURL(/#\/work\//);
 const request=()=>a.evaluate(async()=>{const {router}=await import('/src/app/router.js');window.__nav='pending';router.push('/today').then(r=>window.__nav=r?'cancelled':'succeeded')});
 for(const mode of ['Escape','button','overlay']){await request();await a.getByRole('dialog').waitFor();if(mode==='Escape')await a.keyboard.press('Escape');else if(mode==='button')await a.getByRole('dialog').getByRole('button',{name:'留在这里',exact:true}).click();else await a.mouse.click(2,2);await a.waitForTimeout(100);check(mode+'关闭后导航已取消',await a.evaluate(()=>window.__nav)==='cancelled',{state:await a.evaluate(()=>window.__nav),url:a.url()});}
 await request();await a.getByRole('dialog').waitFor();await a.getByRole('dialog').getByRole('button',{name:'保存并暂停后离开',exact:true}).click();await a.waitForURL(/#\/today/);check('多次取消后仍能正常保存暂停并离开',!(await L.docs(a)).find(d=>d.kind==='focus_session').running);
 await next.c.close();check('浏览器无运行时错误',errors.every(e=>e.length===0),errors);
}finally{await b.close();fs.writeFileSync('E:/qoder/output/playwright/stage3b3-recheck-2026-11-22/result.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));}})().catch(e=>{console.error(e);process.exitCode=1});


