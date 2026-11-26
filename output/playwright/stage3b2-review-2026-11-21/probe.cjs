const L = require('./accept-lib.cjs');
const fs = require('node:fs');
(async () => {
 const b = await L.launch(); const results = [];
 try {
  const start = async () => {
   const {c,p,errors} = await L.newPage(b);
   await L.openApp(p); await L.seed(p); await p.reload(); await L.openApp(p);
   await p.goto(L.BASE+'/#/tasks/t1'); await p.getByRole('button',{name:'开始执行',exact:true}).click();
   await p.waitForURL(/#\/work\//); await p.getByRole('textbox',{name:'本次成果正文'}).waitFor();
   return {c,p,errors,sid: (await L.docs(p)).find(d=>d.kind==='focus_session').id};
  };
  {
   const {c,p,errors,sid} = await start();
   await p.getByRole('textbox',{name:'本次成果正文'}).fill('切换前尚未保存的重要成果');
   await p.evaluate(()=>{location.hash='/work/invalid-review-session'});
   await p.waitForTimeout(300);
   const dialog = await p.getByRole('dialog').count();
   const invalidShown = await p.getByText('会话不存在或不属于当前空间。',{exact:false}).count();
   await p.getByRole('button',{name:'返回日程',exact:true}).click();
   await p.waitForTimeout(1300);
   const persisted = (await L.docs(p)).find(d=>d.id===sid);
   const leftUrl = p.url();
   await p.reload(); await L.openApp(p, '/work/'+sid);
   await p.getByRole('textbox',{name:'本次成果正文'}).waitFor();
   const textAfterReload = await p.getByRole('textbox',{name:'本次成果正文'}).inputValue();
   results.push({case:'same_component_parameter_navigation',url:leftUrl,dialog,invalidShown,persisted,textAfterReload,errors});
   await c.close();
  }
  {
   const {c,p,errors,sid} = await start();
   await p.getByRole('textbox',{name:'本次成果正文'}).fill('正常结束成果');
   await p.getByRole('button',{name:'结束本次',exact:true}).click();
   results.push({case:'end_form_labels',buttons:await p.getByRole('dialog').locator('button').allTextContents()});
   const radio = p.getByRole('radio',{name:'部分完成',exact:false});
   if(await radio.count()) await radio.check();
   else await p.getByRole('dialog').getByText('部分完成',{exact:false}).click();
   const buttons = await p.getByRole('dialog').locator('button').allTextContents();
   const submit = p.getByRole('dialog').getByRole('button').last();
   await submit.click(); await p.waitForTimeout(600);
   results.push({case:'normal_end_navigation',url:p.url(),persisted:(await L.docs(p)).find(d=>d.id===sid),errors});
   await c.close();
  }
 } finally {await b.close();fs.writeFileSync('E:/qoder/output/playwright/stage3b2-review-2026-11-21/result.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));}
})().catch(e=>{console.error(e);process.exitCode=1});
