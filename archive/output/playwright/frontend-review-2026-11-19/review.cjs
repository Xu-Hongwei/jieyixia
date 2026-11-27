const {createRequire}=require('node:module');
const {chromium}=createRequire('E:/qoder/frontend/package.json')('playwright-core');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/analyze**',r=>r.abort());
 const overflow=[];
 const measure=async(label)=>{const m=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,iw:window.innerWidth}));overflow.push({label,...m,ok:m.sw<=m.iw});};
 try{
 await page.goto('http://127.0.0.1:5175/#/today');await page.locator('main').waitFor();
 await page.evaluate(async()=>{
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10),add=n=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const now=new Date().toISOString(),w={workspace_id:'personal',created_at:now,updated_at:now};
  const fields=[{key:'title',value:'机器学习课程报告',status:'confirmed',origin:'model',raw:'完成机器学习课程报告'},
   {key:'deadline',value:add(1)+'T18:00:00+08:00',precision:'datetime',tz_known:true,status:'candidate',origin:'model',raw:'周五18点前提交PDF',quote:{source_id:'s1',text:'周五18点前提交PDF'}},
   {key:'requirement',value:['报告至少3000字','包含实验对比与结果分析'],raw:'报告至少3000字，包含实验对比与结果分析',status:'candidate',origin:'model'},
   {key:'submit_to',value:'课程平台作业区',raw:'上传课程平台作业区',status:'unresolved',origin:'model'},
   {key:'summary',value:'课程报告需说明方法、实验与引用来源。',raw:'课程报告需说明方法、实验与引用来源。',status:'candidate',origin:'model'}];
  const docs=[{...w,id:'m1',kind:'matter',title:'机器学习课程',note_ids:['n1']},
   {...w,id:'n1',kind:'note',source_id:'s1',content_type:'notice',status:'draft',title:'机器学习课程报告',fields,matter_id:'m1',matter_role:'requirement',warnings:[{code:'relative_date_derived',message:'由相对时间换算得到，具体日期请核对确认',field_key:'deadline'}]},
   {...w,id:'n2',kind:'note',source_id:'s2',content_type:'reference',status:'failed',title:'实验结果补充说明',fields:[],warnings:[]},
   {...w,id:'n3',kind:'note',source_id:'s3',content_type:'tutorial',status:'reviewed',reviewed_at:now,title:'实验环境配置指南',fields:[{key:'title',value:'实验环境配置指南',status:'confirmed',origin:'model',raw:'实验环境配置指南'}],warnings:[]}];
  const names=['提交机器学习课程报告：多模态遥感图文检索方法与实验结果分析','提交开题报告初稿','整理实验数据及消融对比结果','论文阅读：Attention Is All You Need','准备小组汇报','补充文献综述','长期研究：论文结构与实验路线整理'];
  names.forEach((title,i)=>docs.push({...w,id:'t'+i,kind:'task',title,status:i===5?'done':'todo',matter_id:'m1',note_ids:i===0?['n1']:[],deadline:i===6?{value:null,precision:'none'}:{value:add(i<3?0:i-2)+(i===1?'':'T'+['09:00','10:30','17:00'][i%3]+':00+08:00'),precision:i===1?'date':'datetime',source:'manual',confirmed_at:now}}));
  for(let i=0;i<4;i++)docs.push({...w,id:'dense'+i,kind:'task',title:'课程项目阶段 '+(i+1)+'：准备材料并核对引用',status:'todo',note_ids:[],deadline:{value:today+'T'+String(11+i).padStart(2,'0')+':00:00+08:00',precision:'datetime',source:'manual',confirmed_at:now}});
  const sources=[{...w,id:'s1',kind:'text',text:'课程通知\n请完成机器学习课程报告。报告至少3000字，包含实验对比与结果分析。周五18点前提交PDF，并上传课程平台作业区。',captured_at:now},
   {...w,id:'s2',kind:'text',text:'实验结果补充说明：请整理消融实验表格。',captured_at:now},
   {...w,id:'s3',kind:'text',text:'实验环境配置指南：安装依赖并核对数据路径。',captured_at:now}];
  await new Promise((resolve,reject)=>{const req=indexedDB.open('jxl-product',2);req.onsuccess=()=>{const db=req.result,t=db.transaction(['docs','sources'],'readwrite');docs.forEach(d=>t.objectStore('docs').put(d));sources.forEach(d=>t.objectStore('sources').put(d));t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error)};req.onerror=()=>reject(req.error)});
 });
 await page.reload();await page.locator('[data-today=true]').waitFor();
 const shot=async(name,full=true)=>{await page.waitForTimeout(200);await page.screenshot({path:path.join(__dirname,name+'.png'),fullPage:full,animations:'disabled'});};

 // 今天页（桌面）：默认周表 → 灰度 → 详情浮层 → 密集日展开 → 列表 → 新建面板
 await shot('desktop-today');await measure('desktop-today');
 const grayStyle=await page.addStyleTag({content:'html {filter: grayscale(1)}'});await shot('desktop-today-gray');await grayStyle.evaluate(el=>el.remove());
 await page.locator('button[aria-label^="任务详情"]').first().click();
 await page.locator('[role="dialog"][aria-label="任务详情"]').waitFor();await shot('desktop-today-detail',false);
 await page.locator('button[aria-label="关闭详情"]').click();
 await page.getByRole('button',{name:/还有 \d+ 项 · 展开/}).first().click();await shot('desktop-today-dense');
 await page.getByRole('button',{name:'列表',exact:true}).click();await page.getByText('逾期任务 ·').waitFor();await shot('desktop-today-list');
 await page.getByRole('button',{name:'周视图',exact:true}).click();
 await page.getByRole('button',{name:'新建',exact:true}).click();await page.locator('input[aria-label="新任务名称"]').waitFor();await shot('desktop-today-create');
 await page.getByRole('button',{name:'新建',exact:true}).click();
 // 25% 缩略图（CDP clip.scale 真实缩小到 360×250）
 const cdp=await ctx.newCDPSession(page);
 const thumb=await cdp.send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:1440,height:1000,scale:0.25}});
 fs.writeFileSync(path.join(__dirname,'desktop-today-thumb.png'),Buffer.from(thumb.data,'base64'));

 // 收集箱（桌面）：收起态 → 展开输入 → 高级筛选+ chips
 await page.goto('http://127.0.0.1:5175/#/collect');await page.locator('button[aria-label="添加文字资料"]').waitFor();await shot('desktop-collect');await measure('desktop-collect');
 await page.locator('button[aria-label="添加文字资料"]').click();await page.locator('textarea[aria-label="文字资料"]').waitFor();await shot('desktop-collect-open');
 await page.getByRole('button',{name:/筛选/}).click();await page.waitForTimeout(150);
 await page.locator('input[aria-label="搜索收集箱"]').fill('实验');await page.waitForTimeout(150);await shot('desktop-collect-filters');
 await page.getByRole('button',{name:'清除筛选',exact:true}).click();

 // 核对页（桌面）：下一步主操作 → 更多操作
 await page.goto('http://127.0.0.1:5175/#/notes/n1');await page.getByText('机器学习课程报告',{exact:true}).first().waitFor();await shot('desktop-notes');await measure('desktop-notes');
 await page.getByRole('button',{name:/更多操作/}).click();await page.getByRole('button',{name:'删除便签'}).waitFor();await shot('desktop-notes-more');

 // 手机 390×844：今天日期条 → 选另一日 → 详情；收集箱；核对页宽度
 await page.setViewportSize({width:390,height:844});
 await page.goto('http://127.0.0.1:5175/#/today');await page.locator('[role="group"][aria-label="选择日期"]').waitFor();await shot('mobile-today');await measure('mobile-today');
 const fri=new Date(Date.parse(new Date(Date.now()+8*3600000).toISOString().slice(0,10)+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 await page.locator(`button[aria-label^="${fri}"]`).click();await page.waitForTimeout(150);await shot('mobile-today-day');
 await page.locator('button[aria-label^="任务详情"]:visible').first().click();await page.locator('[role="dialog"][aria-label="任务详情"]').waitFor();await shot('mobile-today-detail',false);
 await page.locator('button[aria-label="关闭详情"]').click();
 await page.goto('http://127.0.0.1:5175/#/collect');await page.locator('button[aria-label="添加文字资料"]').waitFor();await shot('mobile-collect');await measure('mobile-collect');
 await page.goto('http://127.0.0.1:5175/#/notes/n1');await page.getByRole('button',{name:/继续核对/}).waitFor();await shot('mobile-notes');await measure('mobile-notes');
 const expandBtn=page.getByRole('button',{name:'展开原文'});if(await expandBtn.count())await expandBtn.click();
 await page.waitForTimeout(200);await shot('mobile-notes-evidence');await measure('mobile-notes-evidence');


 // Additional independent behavior checks, all against this isolated context.
 const checks=[];
 const record=(name,actual)=>{checks.push({name,...actual});console.log(JSON.stringify(checks[checks.length-1]));};
 const readTask=async(id)=>page.evaluate(async id=>new Promise((resolve,reject)=>{let req=indexedDB.open('jxl-product',2);req.onsuccess=()=>{let db=req.result,tx=db.transaction('docs','readonly'),r=tx.objectStore('docs').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);tx.oncomplete=()=>db.close()};req.onerror=()=>reject(req.error)}),id);
 await page.setViewportSize({width:1440,height:1000});
 await page.goto('http://127.0.0.1:5175/#/today');
 await page.getByRole('button',{name:'任务详情：提交机器学习课程报告：多模态遥感图文检索方法与实验结果分析',exact:true}).filter({visible:true}).click();
 const detail=page.getByRole('dialog',{name:'任务详情',exact:true});
 await detail.getByRole('button',{name:'完成',exact:true}).click();await page.waitForTimeout(250);
 record('finish_in_detail',{db:(await readTask('t0')).status,completeButtonStillVisible:await detail.getByRole('button',{name:'完成',exact:true}).isVisible()});
 await shot('issue-finish-detail',false);
 await detail.getByRole('button',{name:'重命名任务',exact:true}).click();
 await detail.getByRole('textbox',{name:'重命名任务',exact:true}).fill('审查专用：已完成后修改标题');
 await detail.getByRole('button',{name:'保存',exact:true}).click();await page.waitForTimeout(250);
 const renamed=await readTask('t0');
 record('rename_after_finish',{dbStatus:renamed.status,dbTitle:renamed.title,uiTitle:await detail.innerText()});
 await shot('issue-rename-detail',false);
 await detail.getByRole('button',{name:'关闭详情',exact:true}).focus();
 await page.keyboard.press('Shift+Tab');
 record('dialog_focus',{focusInside:await detail.evaluate(el=>el.contains(document.activeElement)),active:await page.evaluate(()=>({tag:document.activeElement.tagName,text:document.activeElement.textContent}))});
 await detail.getByRole('button',{name:'删除任务',exact:true}).click();
 await page.getByRole('alertdialog').waitFor();
 await page.keyboard.press('Escape');await page.waitForTimeout(200);
 record('escape_nested_delete',{detailOpen:await detail.count(),confirmOpen:await page.getByRole('alertdialog').count(),taskStillExists:!!await readTask('t0')});
 await page.goto('http://127.0.0.1:5175/#/notes/n1');
 await page.getByRole('button',{name:/继续核对/}).click();
 record('continue_confirm',{active:await page.evaluate(()=>({text:document.activeElement.textContent,field:document.activeElement.closest('[data-field-key]')?.getAttribute('data-field-key')}))});
 await page.locator('[data-field-key="deadline"]').getByRole('button',{name:'确认',exact:true}).click();await page.waitForTimeout(150);
 record('confirm_deadline',{nextLabel:await page.getByRole('button',{name:/继续核对/}).innerText(),createEnabled:await page.getByRole('button',{name:'创建任务',exact:true}).isEnabled()});
 // Test overflow beyond short ordinary text: source and field JSON with an unbroken long string.
 await page.evaluate(async()=>{await new Promise((resolve,reject)=>{let req=indexedDB.open('jxl-product',2);req.onsuccess=()=>{const db=req.result,tx=db.transaction('docs','readwrite'),r=tx.objectStore('docs').get('n1');r.onsuccess=()=>{let n=r.result;n.fields[0].raw='https://example.test/'+('A'.repeat(300));tx.objectStore('docs').put(n)};tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}})});
 await page.reload();await page.setViewportSize({width:390,height:844});
 await page.locator('[data-field-key="title"] summary').click();await measure('mobile-notes-json');await shot('issue-mobile-json');
 await page.setViewportSize({width:820,height:1000});await page.goto('http://127.0.0.1:5175/#/notes/n1');await shot('tablet-notes');await measure('tablet-notes');
 fs.writeFileSync(path.join(__dirname,'interaction.json'),JSON.stringify({checks,errors,overflow},null,2));
 fs.writeFileSync(path.join(__dirname,'capture.json'),JSON.stringify({base:'http://127.0.0.1:5175',seed:'与 visual-review-2026-11-19/capture.cjs 完全相同的虚构数据',errors,overflow,scope:'isolated headless context, no API analyze calls, no product source changes during capture'},null,2));
 console.log(JSON.stringify({errors,overflow},null,1));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});