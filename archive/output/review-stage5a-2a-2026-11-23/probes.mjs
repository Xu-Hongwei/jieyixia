// Read-only product review. Synthetic fake-indexeddb + controlled clock; no browser/user DB.
import { createServer } from '../../frontend/node_modules/vite/dist/node/index.js'
import { IDBFactory, IDBObjectStore, IDBDatabase } from '../../frontend/node_modules/fake-indexeddb/build/esm/index.js'
import { writeFile } from 'node:fs/promises'
globalThis.indexedDB = new IDBFactory()
const server=await createServer({root:'E:/qoder/frontend',configFile:'E:/qoder/frontend/vite.config.js',server:{middlewareMode:true},appType:'custom'})
const results=[]
let svc
try {
  const db=await server.ssrLoadModule('/src/services/storage/db.js')
  const focus=await server.ssrLoadModule('/src/domains/focus.js')
  const plan=await server.ssrLoadModule('/src/domains/plan.js')
  const {createFocusService}=await server.ssrLoadModule('/src/services/focus/service.js')
  const T='2026-11-23T10:00:00+08:00'
  const stamp=Date.parse(T)
  const ws='isolated-review'
  let n=0
  const env={ws,wallNow:T,ownerId:'review',newId:()=>`id-${++n}`,params:{LEASE_MS:600000}}
  const t={id:'t',kind:'task',workspace_id:ws,title:'虚构任务',status:'todo',current_action_id:null,deadline:{value:null,precision:'none'}}
  const a={id:'a',kind:'action',workspace_id:ws,task_id:'t',text:'原行动',minutes:30,done:false}
  const a2={...a,id:'a2',text:'换了行动'}
  const p={id:'p',kind:'plan_item',workspace_id:ws,task_id:'t',date:'2026-11-23',state:'planned',action_text:'虚构安排',planned_minutes:30,actual_minutes:null,focus_session_id:null,task_ref_state:'active',order:1}
  const begin={taskId:'t',actionId:'a',planItemId:'p',expected:plan.planSnapshot(p),facts:focus.beginFactsOf(t,a,'2026-11-23')}
  // Planned with ended history must first be manually reconciled; corrupt history must not start an unfinishable session.
  for(const invalid of [false,true]) {
    const hist={id:'old',kind:'focus_session',workspace_id:ws,task_id:'t',action_id:'a',plan_item_id:'p',started_at:'2026-11-22T10:00:00+08:00',ended_at:'2026-11-22T10:01:00+08:00',running:false,accumulated_ms:invalid?-1:60000,outcome:'partial',draft_md:'旧成果'}
    const docs=[t,a,p,hist]
    const r=focus.beginPlan(docs,[],env,begin)
    const merged=[...docs,...r.puts.filter(x=>!docs.some(d=>d.id===x.id))].map(d=>r.puts.find(x=>x.id===d.id)||d)
    let endError=null
    try {focus.endPlan(merged,r.runtimePuts,env,{sessionId:r.info.session.id,epoch:r.info.runtime.epoch,draftSeq:1,draftMd:'新成果',outcome:'partial',planProgress:'partial',expected:plan.planSnapshot(p),historyConfirm:plan.historySignature(plan.summarizePlanTime(p,docs))})}catch(e){endError=e.code}
    results.push({probe:'begin-with-unreviewed-or-invalid-history',invalidHistory:invalid,beginCreated:!!r.info.session,endError})
  }
  db.configureWorkspace(ws)
  for(const d of [t,a,a2,p]) await db.putDoc(d)
  svc=createFocusService({getWorkspaceId:()=>ws,ownerId:'review',wallNow:()=>T,newId:()=>`service-${++n}`,scheduler:{set:()=>0,clear:()=>{}},params:{LEASE_MS:600000}})
  const envelope=svc.issueRequest('begin',begin)
  const original={...begin,requestId:envelope.request_id,issuedAtMs:envelope.issued_at_ms}
  const originalPut=IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put=function(value,...rest){if(this.name==='docs' && value.kind==='focus_session')throw new Error('injected precommit failure');return originalPut.call(this,value,...rest)}
  let failed
  try{failed=await svc.begin(original)}finally{IDBObjectStore.prototype.put=originalPut}
  const changed={...original,actionId:'a2',facts:focus.beginFactsOf(t,a2,'2026-11-23')}
  const retried=await svc.begin(changed)
  results.push({probe:'changed-input-after-aborted-first-attempt',first:failed.code,secondOk:retried.ok,secondCode:retried.code,savedAction:retried.session?.action_id,sameRequest:original.requestId===changed.requestId})
  const end={sessionId:retried.session_id,outcome:'partial',draftMd:'original text',planProgress:'partial',expected:plan.planSnapshot(p),historyConfirm:null,requestId:'review-end',issuedAtMs:stamp}
  const ended=await svc.end(end)
  const changedEnd={...end,draftMd:'unsaved new text',planProgress:'done'}
  const normal=await svc.end(changedEnd)
  const origTx=IDBDatabase.prototype.transaction
  let injected=false
  IDBDatabase.prototype.transaction=function(names,mode,...rest){if(!injected && mode==='readwrite' && Array.isArray(names) && names.includes('focus_runtime')){injected=true;throw new Error('injected transaction open failure')}return origTx.call(this,names,mode,...rest)}
  let fallback
  try{fallback=await svc.end(changedEnd)}finally{IDBDatabase.prototype.transaction=origTx}
  const rows=(await db.allDocs()).records
  results.push({probe:'fallback-replay-skips-input-validation',firstEndOk:ended.ok,normalChangedCode:normal.code,injected,fallback,savedText:rows.find(x=>x.id===end.sessionId).draft_md,savedPlanState:rows.find(x=>x.id==='p').state})
  await writeFile(new URL('./results.json',import.meta.url),JSON.stringify(results,null,2))
  console.log(JSON.stringify(results,null,2))
}finally{svc?.stop();await server.close()}
