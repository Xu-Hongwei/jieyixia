const {createRequire}=require('node:module');const {chromium}=createRequire('E:/qoder/frontend/package.json')('playwright-core');const fs=require('node:fs');
(async()=>{const b=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const c=await b.newContext({acceptDownloads:true});const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
try{
 await p.goto('http://127.0.0.1:5183/#/data');await p.waitForFunction(async()=>{const {useAppStore}=await import('/src/stores/app.js');return useAppStore().ready});
 await p.evaluate(async()=>{const db=await import('/src/services/storage/db.js');const {fictionalRecords}=await import('/src/tests/backupFixtures.js');const {sourceFromBackup}=await import('/src/services/backup/adapt.js');const v=fictionalRecords();for(const s of v.sources)await db.putSource({...sourceFromBackup(s,s.asset_path?v.assets.get(s.asset_path):null),workspace_id:'personal'});for(const d of v.docs)await db.putDoc({...d,workspace_id:'personal'});});
 await p.reload();await p.getByRole('button',{name:'导出当前空间备份',exact:true}).waitFor();
 const download=async name=>{const [d]=await Promise.all([p.waitForEvent('download'),p.getByRole('button',{name:'导出当前空间备份',exact:true}).click()]);await d.saveAs('E:/qoder/output/backup-export-review-2026-11-22/'+name+'.zip');await p.getByText('备份已生成，请在下载中确认：',{exact:false}).waitFor();return {filename:d.suggestedFilename(),successShown:true};};
 const baseline=await download('browser-baseline');
 await p.evaluate(async()=>{const db=await import('/src/services/storage/db.js');const d=(await db.allDocs()).records.find(d=>d.kind==='task');await db.putDoc({...d,unapproved_field:'字段不应被静默打包'});});
 const malformed=await download('browser-invalid');
 fs.writeFileSync('E:/qoder/output/backup-export-review-2026-11-22/browser-result.json',JSON.stringify({baseline,malformed,errors},null,2));console.log(JSON.stringify({baseline,malformed,errors},null,2));
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});
