from pathlib import Path
p=Path('output/playwright/frontend-u5-2026-11-26/runtime.mjs');s=p.read_text(encoding='utf8').replace("'runtime-r2'","'runtime-r3'").replace("p.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link'", "p.getByRole('navigation',{name:/^(主导航|移动主导航)$/}).filter({visible:true}).getByRole('link'")
s=s.replace("await shot(page,'cold-offline.png');await context.setOffline(false);await btn(page,'重试打开').click();await waitText(page,'提供资料与需求')", """await shot(page,'cold-offline.png');await btn(page,'新建任务').click();await page.getByLabel('新任务名称').fill('虚构未保存任务');await context.setOffline(false);await btn(page,'重试打开').click();await page.getByRole('alertdialog').getByRole('button',{name:'继续编辑',exact:true}).click()
 rec('guard','页面重试取消时保留未保存任务',await page.getByLabel('新任务名称').inputValue()==='虚构未保存任务','')
 await btn(page,'重试打开').click();await page.getByRole('alertdialog').getByRole('button',{name:'放弃修改',exact:true}).click();await waitText(page,'提供资料与需求')""")
s=s.replace("debugPage=page;await boot(page)\n for(const route", """debugPage=page;await boot(page)
 const late={...seedRecords()[0],id:'u5-late',title:'虚构：已逾期的提交',deadline:{value:D(-1),precision:'date',source:'manual',from_note_id:null,confirmed_at:NOW_ISO}}
 await page.evaluate(record=>new Promise(resolve=>{const r=indexedDB.open('jxl-product');r.onsuccess=()=>{const db=r.result,t=db.transaction('docs','readwrite');t.objectStore('docs').put(record);t.oncomplete=()=>{db.close();resolve()}}}),late);await page.reload();await waitText(page,'周视图')
 const chip=page.getByRole('button',{name:'任务详情：虚构：已逾期的提交',exact:true});rec('deadline','逾期截止同时显示文字和醒目左边框',(await chip.innerText()).includes('已逾期')&&await chip.evaluate(e=>getComputedStyle(e).borderLeftWidth==='2px'),'')
 for(const route""")
p.write_text(s,encoding='utf8')
