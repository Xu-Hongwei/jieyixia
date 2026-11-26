const { createRequire } = require('node:module');
const { chromium } = createRequire('E:/qoder/frontend/package.json')('playwright-core');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:5183/@fs/E:/qoder/devlog/private-evidence/stage3b1-2026-11-20/verify/focus.html');
    await page.waitForFunction(() => window.H_READY === true);
    const before = await page.evaluate(async () => {
      let ms = Date.parse('2026-11-21T10:00:00+08:00');
      const NativeDate = Date;
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [ms])); } static now() { return ms; } };
      await H.setupApp();
      H.setWs('personal');
      await H.rawClear(['docs', 'focus_runtime']);
      await H.rawPut('docs', [
        { id: 't', kind: 'task', workspace_id: 'personal', title: '隔离审查任务', status: 'todo', note_ids: [], deadline: { value: null, precision: 'none' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { id: 'a', kind: 'action', workspace_id: 'personal', task_id: 't', text: '隔离审查行动', minutes: 30, basis: 'user', done: false, created_at: new Date().toISOString() },
      ]);
      const store = H.useFocusStore();
      const envelope = store.issueRequest('begin'); const original = await store.begin({ taskId: 't', actionId: 'a', requestId: envelope.request_id, issuedAtMs: envelope.issued_at_ms });
      if (!original.ok) throw new Error(JSON.stringify(original));
      const ended = await store.end({ sessionId: original.session_id, outcome: 'partial', draftMd: '第一段成果' });
      if (!ended.ok) throw new Error(JSON.stringify(ended));
      store.stop();
      const s = H.mkRawService({ ownerId: 'retention-review', wallNow: () => new Date(ms).toISOString(), scheduler: H.mkScheduler() });
      for (let i = 0; i < 102; i++) {
        ms += 610001;
        const begun = await s.begin({ taskId: 't', actionId: 'a', requestId: `cycle-${i}-begin`, issuedAtMs: ms });
        if (!begun.ok) throw new Error(`begin ${i}: ${JSON.stringify(begun)}`);
        const end = await s.end({ sessionId: begun.session_id, requestId: `cycle-${i}-end`, issuedAtMs: ms, outcome: 'partial', draftMd: `成果 ${i}` });
        if (!end.ok) throw new Error(`end ${i}: ${JSON.stringify(end)}`);
      }
      const ops = (await H.rawAll('focus_runtime')).find(r => r.kind === 'ops');
      const explicit = await s.begin({ taskId: 't', actionId: 'a', requestId: original.request_id, issuedAtMs: original.issued_at_ms });
      const bare = await s.begin({ taskId: 't', actionId: 'a', requestId: original.request_id });
      const sameStore = await store.begin({ taskId: 't', actionId: 'a', requestId: original.request_id });
      s.stop(); store.stop();
      return { ms, original, tombstones: ops.stale.length, originalTombstonePresent: ops.stale.some(t => t.request_id === original.request_id), explicit, bare, sameStore, count: (await H.rawAll('docs')).filter(d => d.kind === 'focus_session').length };
    });
    await page.reload();
    await page.waitForFunction(() => window.H_READY === true);
    const after = await page.evaluate(async ({ ms, original }) => {
      const NativeDate = Date;
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [ms])); } static now() { return ms; } };
      await H.setupApp();
      const raw = H.mkRawService({ scheduler: H.mkScheduler() });
      const input = { taskId: 't', actionId: 'a', requestId: original.request_id };
      const rawBare = await raw.begin(input);
      const rawEnvelope = await raw.begin({ ...input, issuedAtMs: original.issued_at_ms });
      raw.stop();
      const store = H.useFocusStore();
      const storeRetry = await store.begin(input);
      const countAfterRetry = (await H.rawAll('docs')).filter(d => d.kind === 'focus_session').length;
      let ended = null;
      if (storeRetry.ok) ended = await store.end({ sessionId: storeRetry.session_id, outcome: 'partial', draftMd: '重复段' });
      const fresh = await store.begin({ taskId: 't', actionId: 'a' });
      store.stop();
      return { rawBare, rawEnvelope, storeRetry, countAfterRetry, ended, fresh };
    }, { ms: before.ms, original: before.original });
    const binding = await page.evaluate(async (fresh) => {
      const raw = H.mkRawService({ scheduler: H.mkScheduler() });
      const result = await raw.end({ sessionId: fresh.session_id, requestId: fresh.request_id, issuedAtMs: fresh.issued_at_ms, outcome: 'partial', draftMd: '不应接受错绑ID' });
      const persisted = (await H.rawAll('docs')).find(d => d.id === fresh.session_id);
      raw.stop();
      return { result, runningAfter: persisted.running, endedAt: persisted.ended_at };
    }, after.fresh);
    const evidence = { before, after, binding, errors };
    fs.writeFileSync('E:/qoder/output/playwright/stage3b1-envelope-final-2026-11-21/result.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ countBefore: before.count, tombstones: before.tombstones, originalTombstonePresent: before.originalTombstonePresent, beforeCodes: [before.explicit.code, before.bare.code, before.sameStore.code], afterCodes: [after.rawBare.code, after.rawEnvelope.code, after.storeRetry.code], storeRetryOk: after.storeRetry.ok, countAfterRetry: after.countAfterRetry, freshOk: after.fresh.ok, errors }, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

