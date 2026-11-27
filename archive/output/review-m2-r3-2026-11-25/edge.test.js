// M2 真实生成生命周期单测（fake-indexeddb + mock API，零网络零费用）：
// 快乐路径 / 默认要求 / 取消 / 迟到拒收（换空间往返）/ 输入变化拒收 / 保存失败留结果重试不重调 /
// 澄清续轮 seq+1 / 自动分析上限与复用绑定 / 分析保存失败仅重试落库 / 重复点击不并行。
import '../../frontend/node_modules/fake-indexeddb/auto/index.mjs'
// Test APIs provided by isolated config globals.
import { createPinia, setActivePinia } from '../../frontend/node_modules/pinia/dist/pinia.mjs'

vi.hoisted(() => {
  const m = new Map()
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  }
})

vi.mock('../../frontend/src/services/api/client', () => ({
  healthz: vi.fn(async () => ({ ok: true, kind: 'http', status: 200, body: { status: 'ok', model_ready: true, provider: 'fixture' } })),
  analyze: vi.fn(),
  propose: vi.fn(),
  blobToBase64: vi.fn(async () => 'c3R1Yg=='),
}))

vi.mock('../../frontend/src/services/storage/db', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, transformAssistantAtomic: vi.fn(actual.transformAssistantAtomic), putDoc: vi.fn(actual.putDoc) }
})

import { useAppStore } from '../../frontend/src/stores/app'
import { useAssistantStore, DEFAULT_USER_MESSAGE } from '../../frontend/src/stores/assistant'

const TEXT = '虚构通知：周五交报告，包含资料整理、对比分析和结论。'
let app, store, api, db
beforeEach(async () => {
  localStorage.clear()
  setActivePinia(createPinia())
  api = await import('../../frontend/src/services/api/client')
  db = await import('../../frontend/src/services/storage/db')
  const actual = await vi.importActual('../../frontend/src/services/storage/db')
  api.analyze.mockReset()
  api.propose.mockReset()
  db.transformAssistantAtomic.mockReset()
  db.transformAssistantAtomic.mockImplementation(actual.transformAssistantAtomic)
  db.putDoc.mockReset()
  db.putDoc.mockImplementation(actual.putDoc)
  app = useAppStore()
  await app.init()
  await db.clearWorkspace('personal')
  await db.clearWorkspace('demo')
  await app.reload()
  store = useAssistantStore()
})

const evOf = (req) => {
  const src = req.selected_sources[0]
  return src
    ? [{ kind: 'source_excerpt', source_id: src.source_id, excerpt: (src.excerpt || '虚构片段').slice(0, 2000), locator: null }]
    : [{ kind: 'user_message', turn_id: req.turn_id, excerpt: req.user_message.slice(0, 2000) }]
}
const proposalBody = (req) => {
  const ev = evOf(req)
  return {
    protocol_version: '1.0', request_id: req.request_id, thread_id: req.thread_id, turn_id: req.turn_id,
    client_seq: req.client_seq, workspace_id: req.workspace_id, summary: '',
    payload: {
      kind: 'proposal',
      proposal: {
        task_proposals: [{ op: 'create', key: 't1', title: '虚构：完成报告', description: '虚构描述', completion_criteria: null, deadline_candidates: [], evidence_refs: ev }],
        action_proposals: [
          { op: 'create', key: 'a1', task_ref: { kind: 'draft', key: 't1' }, text: '整理资料', minutes: 45, basis: 'suggestion', evidence_refs: [] },
          { op: 'create', key: 'a2', task_ref: { kind: 'draft', key: 't1' }, text: '撰写结论', minutes: 60, basis: 'suggestion', evidence_refs: [] },
        ],
        work_items: [
          { key: 'w1', task_ref: { kind: 'draft', key: 't1' }, action_ref: { kind: 'draft', key: 'a1' }, deliverable: '资料清单', remaining_minutes: 45, estimate_origin: 'model', splittable: true, min_segment_minutes: 25, earliest_date: null, depends_on: [], priority: 'normal' },
          { key: 'w2', task_ref: { kind: 'draft', key: 't1' }, action_ref: { kind: 'draft', key: 'a2' }, deliverable: '报告结论', remaining_minutes: 60, estimate_origin: 'model', splittable: true, min_segment_minutes: 25, earliest_date: null, depends_on: ['w1'], priority: 'normal' },
        ],
        requirement_candidates: [], evidence_refs: ev, assumptions: [], warnings: [],
      },
    },
  }
}
const okPropose = (req) => Promise.resolve({ ok: true, kind: 'http', status: 200, body: proposalBody(req) })
const clarificationBody = (req) => ({
  protocol_version: '1.0', request_id: req.request_id, thread_id: req.thread_id, turn_id: req.turn_id,
  client_seq: req.client_seq, workspace_id: req.workspace_id, summary: '',
  payload: { kind: 'clarification', ready: false, questions: [{ question_id: 'q1', question: '报告交给谁？', options: ['导师', '班长'], blocking_reason: '虚构：影响交付对象', related_requirement_key: null }] },
})
const analyzeBody = (sourceId, fields = [{ key: 'title', value: '虚构通知', raw: '虚构原文', origin: 'model', status: 'candidate', derived: false }]) => ({
  ok: true, kind: 'http', status: 200,
  body: { source_id: sourceId, content_type: 'notice', fields, warnings: [] },
})
const seedText = async (text = TEXT) => (await app.saveText(text)).record
const seedImages = async (n) => {
  const files = Array.from({ length: n }, (_, i) => new File([new Uint8Array([i, 1, 2])], `虚构${i}.png`, { type: 'image/png' }))
  return (await app.saveImageFiles(files)).filter((r) => r.ok).map((r) => r.record)
}
const requesting = () => vi.waitFor(() => expect(store.gen?.phase).toBe('requesting'))


it('REVIEW: second clarification must retain first explicit answer', async()=>{
 store.input.userText='请帮我拆解报告';
 let round=0;
 api.propose.mockImplementation(async(req)=>{round++; const body=round<3?clarificationBody(req):proposalBody(req); if(round===2) body.payload.questions=[{question_id:'q2',question:'需要图表吗？',options:[],blocking_reason:'确认交付范围',related_requirement_key:null}];return {ok:true,kind:'http',status:200,body}});
 await store.generate();
 await store.continueClarification([{question_id:'q1',answer:'交给张老师'}]);
 await store.continueClarification([{question_id:'q2',answer:'需要三张图表'}]);
 const sent=api.propose.mock.calls[2][0].user_message;
 console.log('MULTI_CLARIFICATION',sent);
 expect(sent).toContain('交给张老师');
});
it('REVIEW: reloading clarification must recover a continuation entry', async()=>{
 const s=await seedText();store.input.sourceIds=[s.id];store.input.userText='保留我的要求';
 api.propose.mockImplementation(async(req)=>({ok:true,kind:'http',status:200,body:clarificationBody(req)}));
 await store.generate();const id=store.gen.draftId;
 setActivePinia(createPinia());app=useAppStore();await app.init();store=useAssistantStore();await store.init();await store.open(id);
 console.log('RELOAD_CLARIFICATION',JSON.stringify({status:store.activeDraft.status,gen:store.gen,input:store.input,messages:store.active.thread.messages.length}));
 expect(store.gen?.phase).toBe('clarification');
});
it('REVIEW: changing active draft must invalidate late generation', async()=>{
 store.input.userText='先做旧任务';api.propose.mockImplementation(okPropose);await store.generate();const oldId=store.activeDraft.id;
 store.close();store.input.userText='新任务';let release;
 api.propose.mockImplementation(req=>new Promise(resolve=>{release=()=>resolve(okPropose(req))}));
 const p=store.generate();await requesting();const pendingId=store.gen.draftId;
 await store.open(oldId);release();await p;
 console.log('SWITCH_DRAFT',JSON.stringify({oldId,pendingId,activeId:store.activeDraft.id,phase:store.gen?.phase}));
 expect(store.activeDraft.id).toBe(oldId);
 const pending=(await db.readAssistantSnapshot()).drafts.find(x=>x.id===pendingId);
 expect(pending.proposal).toBeNull();
});
it('REVIEW: invented user deadline must not become manual provenance',async()=>{
 const {beijingToday,beijingAddDays}=await import('../../frontend/src/domains/time');
 const today=beijingToday();const value=beijingAddDays(today,5);const dl={value,precision:'date'};
 store.input.userText='请拆解报告，我还没有决定截止日期。';
 api.propose.mockImplementation(async req=>{const body=proposalBody(req);body.payload.proposal.task_proposals[0].deadline_candidates=[{...dl,origin:'user',derived:false,basis:'explicit',evidence_refs:[{kind:'user_message',turn_id:req.turn_id,excerpt:`我明确要求在${value}之前完成`}]}];return {ok:true,kind:'http',status:200,body}});
 await store.generate();await store.confirmDeadline('t1',dl);
 const budgets=Object.fromEntries(Array.from({length:7},(_,i)=>[beijingAddDays(today,i),120]));
 const r=await store.reschedule({startDate:today,budgets});expect(r.ok,JSON.stringify(r)).toBe(true);
 await store.confirmDeadline('t1',dl);
 const p=await store.prepare();
 let applied=null;if(p.ok)applied=await store.adopt();
 const tasks=(await db.allDocs()).records.filter(x=>x.kind==='task');
 console.log('FORGED_PROVENANCE_ADOPTION',JSON.stringify({prepare:p.ok,adopt:applied?.ok,deadline:tasks[0]?.deadline}));
 expect(p.ok).toBe(false);
});


it('REVIEW R1: assistant question rejected by user is not user deadline evidence',async()=>{
 const {beijingToday,beijingAddDays}=await import('../../frontend/src/domains/time');const today=beijingToday();const value=beijingAddDays(today,5);const dl={value,precision:'date'};
 store.input.userText='请拆解报告，截止还没有决定';let round=0;
 api.propose.mockImplementation(async req=>{round++;let body;
 if(round===1){body=clarificationBody(req);body.payload.questions[0].question=`是否把截止设为${value}？`;}
 else {body=proposalBody(req);body.payload.proposal.task_proposals[0].deadline_candidates=[{...dl,origin:'user',derived:false,basis:'explicit',evidence_refs:[{kind:'user_message',turn_id:req.turn_id,excerpt:`是否把截止设为${value}？`}]}];}
 return {ok:true,kind:'http',status:200,body};});
 await store.generate();await store.continueClarification([{question_id:'q1',answer:'不要设截止日期'}]);
 await store.confirmDeadline('t1',dl);const budgets=Object.fromEntries(Array.from({length:7},(_,i)=>[beijingAddDays(today,i),120]));
 const r=await store.reschedule({startDate:today,budgets});expect(r.ok,JSON.stringify(r)).toBe(true);await store.confirmDeadline('t1',dl);
 const p=await store.prepare();let a=null;if(p.ok)a=await store.adopt();
 console.log('QUESTION_AS_USER',JSON.stringify({userMessage:api.propose.mock.calls[1][0].user_message,prepared:p.ok,adopted:a?.ok,deadline:(await db.allDocs()).records.find(x=>x.kind==='task')?.deadline}));
 expect(p.ok).toBe(false);
});
it('REVIEW R2: successful unplanned draft must restore original budget after reload',async()=>{
 const {beijingToday}=await import('../../frontend/src/domains/time');const today=beijingToday();
 const s=await seedText();store.input.sourceIds=[s.id];store.input.userText='保留预算45';store.input.budgets[today]=45;
 api.propose.mockImplementation(okPropose);await store.generate();const id=store.activeDraft.id;
 setActivePinia(createPinia());app=useAppStore();await app.init();store=useAssistantStore();await store.init();await store.open(id);
 console.log('SUCCESS_RELOAD',JSON.stringify({status:store.activeDraft.status,input:store.input}));
 expect(store.input.budgets[today]).toBe(45);expect(store.input.sourceIds).toContain(s.id);
});
it('REVIEW R1 multiline: example answer inside model question is not user evidence',async()=>{
 const {beijingToday,beijingAddDays}=await import('../../frontend/src/domains/time');const today=beijingToday();const value=beijingAddDays(today,5);const dl={value,precision:'date'};
 store.input.userText='请拆解报告，截止还没有决定';let round=0;
 const example=`截止设为${value}`;
 api.propose.mockImplementation(async req=>{round++;let body;
 if(round===1){body=clarificationBody(req);body.payload.questions[0].question=`请确认截止日期。\n参考回答：\n答：${example}`;}
 else {body=proposalBody(req);body.payload.proposal.task_proposals[0].deadline_candidates=[{...dl,origin:'user',derived:false,basis:'explicit',evidence_refs:[{kind:'user_message',turn_id:req.turn_id,excerpt:example}]}];}
 return {ok:true,kind:'http',status:200,body};});
 await store.generate();await store.continueClarification([{question_id:'q1',answer:'不要设截止日期'}]);
 const {userAuthoredSegments}=await import('../../frontend/src/domains/assistant/clarification');
 const message=api.propose.mock.calls[1][0].user_message;
 await store.confirmDeadline('t1',dl);const budgets=Object.fromEntries(Array.from({length:7},(_,i)=>[beijingAddDays(today,i),120]));
 const r=await store.reschedule({startDate:today,budgets});expect(r.ok,JSON.stringify(r)).toBe(true);await store.confirmDeadline('t1',dl);
 const p=await store.prepare();let a=null;if(p.ok)a=await store.adopt();
 console.log('MODEL_EXAMPLE_AS_USER',JSON.stringify({message,userSegments:userAuthoredSegments(message),prepared:p.ok,adopted:a?.ok,deadline:(await db.allDocs()).records.find(x=>x.kind==='task')?.deadline}));
 expect(p.ok).toBe(false);
});
