const fs=require('node:fs');
(async()=>{
 const {createServer}=await import('file:///E:/qoder/frontend/node_modules/vite/dist/node/index.js');
 const server=await createServer({root:'E:/qoder/frontend',server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
 try {
  const {validateRecords,validateBackup}=await server.ssrLoadModule('/src/services/backup/validate.js');
  const {fictionalRecords,assembleArchive}=await server.ssrLoadModule('/src/tests/backupFixtures.js');
  const base=fictionalRecords();const manifest=(await assembleArchive(base)).manifest;
  const baseline=validateRecords(manifest,base.sources,base.docs,base.assets);
  const old=structuredClone(base);const legacy=old.docs.find(d=>d.kind==='focus_session'&&d.record_version===0);if(!legacy)throw Error('No legacy fixture');delete legacy.record_version;
  const legacyResult=validateRecords(manifest,old.sources,old.docs,old.assets);
  const renamed=structuredClone(base);const matter=renamed.docs.find(d=>d.kind==='matter');matter.title='改名后的合法事项';matter.updated_at='2026-11-22T13:00:00+08:00';
  const matterResult=validateRecords(manifest,renamed.sources,renamed.docs,renamed.assets);
  const summary=r=>({ok:r.ok,errors:r.errors,notes:r.notes});
  const result={baseline:summary(baseline),legacyMissingVersion:summary(legacyResult),renamedMatter:summary(matterResult),fullArchive:{baseline:summary(await validateBackup(await assembleArchive(base))),legacyMissingVersion:summary(await validateBackup(await assembleArchive(old))),renamedMatter:summary(await validateBackup(await assembleArchive(renamed)))}};
  const badV1=structuredClone(base);delete badV1.docs.find(d=>d.kind==='focus_session'&&d.record_version===1).task_snapshot;
  const badTime=structuredClone(renamed);badTime.docs.find(d=>d.kind==='matter').updated_at='not-a-time';
  const unknown=structuredClone(base);unknown.docs.find(d=>d.kind==='matter').unapproved_field='x';
  result.negative={v1MissingSnapshot:summary(await validateBackup(await assembleArchive(badV1))),invalidMatterTime:summary(await validateBackup(await assembleArchive(badTime))),unknownMatterField:summary(await validateBackup(await assembleArchive(unknown)))};
  const {buildRemap}=await server.ssrLoadModule('/src/services/backup/remap.js');
  const {docToBackup,docFromBackup}=await server.ssrLoadModule('/src/services/backup/adapt.js');
  let seq=0;const mapped=buildRemap({manifest,sources:renamed.sources,docs:renamed.docs,targetWorkspaceId:'review-target',targetName:'审查目标',createdAt:'2026-11-22T13:00:00+08:00',newId:()=>`review-id-${++seq}`});
  const mappedMatter=mapped.docs.find(d=>d.kind==='matter');
  result.roundTrip={validation:summary(validateRecords(mapped.remappedManifest,mapped.sources,mapped.docs,renamed.assets)),matter:docFromBackup(docToBackup(mappedMatter)),originalLegacyStillMissingVersion:!('record_version' in legacy)};
  fs.writeFileSync('E:/qoder/output/backup-recheck-2026-11-22/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{await server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});


