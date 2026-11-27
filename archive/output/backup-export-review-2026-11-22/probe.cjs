const fs=require('node:fs');
(async()=>{const {createServer}=await import('file:///E:/qoder/frontend/node_modules/vite/dist/node/index.js');const server=await createServer({root:'E:/qoder/frontend',server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
try{
 const {buildBackup}=await server.ssrLoadModule('/src/services/backup/export.js');
 const {validateBackup}=await server.ssrLoadModule('/src/services/backup/validate.js');
 const {unpackArchive}=await server.ssrLoadModule('/src/services/backup/zip.js');
 const {fictionalRecords,WS}=await server.ssrLoadModule('/src/tests/backupFixtures.js');
 const {sourceFromBackup}=await server.ssrLoadModule('/src/services/backup/adapt.js');
 const base=fictionalRecords();const sources=base.sources.map(s=>sourceFromBackup(s,s.asset_path?base.assets.get(s.asset_path):null));
 const snapshot={workspaceId:WS.id,workspace:WS,sources,docs:base.docs};
 const inspect=async(s,name)=>{try{const r=await buildBackup(s);fs.writeFileSync(`E:/qoder/output/backup-export-review-2026-11-22/${name}.zip`,r.zipBytes);const checked=await validateBackup({...unpackArchive(r.zipBytes),zipBytes:r.zipBytes});return {exportSucceeded:true,zipBytes:r.zipBytes.length,validation:{ok:checked.ok,errors:checked.errors}}}catch(e){return {exportSucceeded:false,code:e.code,message:e.message}}};
 const baseline=await inspect(snapshot,'baseline');
 const bad=structuredClone(snapshot);bad.docs.find(d=>d.kind==='task').unapproved_field='字段不应被静默打包';
 const malformed=await inspect(bad,'invalid-record');
 const large={workspaceId:WS.id,workspace:WS,sources:[{id:'large-text',workspace_id:WS.id,kind:'text',captured_at:'2026-11-22T00:00:00Z',text:'x'.repeat(25*1024*1024+1)}],docs:[]};
 const oversized=await inspect(large,'oversized-json');
 const result={baseline,malformed,oversized};fs.writeFileSync('E:/qoder/output/backup-export-review-2026-11-22/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await server.close();}})().catch(e=>{console.error(e);process.exitCode=1});
