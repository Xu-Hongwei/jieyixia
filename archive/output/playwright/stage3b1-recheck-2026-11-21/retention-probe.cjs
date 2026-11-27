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
    const result = await page.evaluate(async () => {
      let ms = Date.parse('2026-11-21T10:00:00+08:00');
      const clock = () => new Date(ms).toISOString();
      H.setWs('personal');
      await H.db.allDocs();
      await H.rawClear(['docs', 'focus_runtime']);
      await H.rawPut('docs', [
        { id: 't', kind: 'task', workspace_id: 'personal', title: '隔离审查任务', status: 'todo', note_ids: [], deadline: { value: null, precision: 'none' }, created_at: clock(), updated_at: clock() },
        { id: 'a', kind: 'action', workspace_id: 'personal', task_id: 't', text: '隔离审查行动', minutes: 30, basis: 'user', done: false, created_at: clock() },
      ]);
      const s = H.mkService({ ownerId: 'retention-review', wallNow: clock, scheduler: H.mkScheduler() });
      const original = await s.begin({ taskId: 't', actionId: 'a', requestId: 'original-begin' });
      if (!original.ok) throw new Error(JSON.stringify(original));
      await s.end({ sessionId: original.session_id, requestId: 'original-end', outcome: 'partial', draftMd: '第一段成果' });
      for (let i = 0; i < 102; i++) {
        ms += 610001;
        const begun = await s.begin({ taskId: 't', actionId: 'a', requestId: `cycle-${i}-begin` });
        if (!begun.ok) throw new Error(`begin ${i}: ${JSON.stringify(begun)}`);
        const ended = await s.end({ sessionId: begun.session_id, requestId: `cycle-${i}-end`, outcome: 'partial', draftMd: `成果 ${i}` });
        if (!ended.ok) throw new Error(`end ${i}: ${JSON.stringify(ended)}`);
      }
      const opsBefore = (await H.rawAll('focus_runtime')).find(r => r.kind === 'ops');
      const before = (await H.rawAll('docs')).filter(r => r.kind === 'focus_session').length;
      const retry = await s.begin({ taskId: 't', actionId: 'a', requestId: 'original-begin' });
      const after = (await H.rawAll('docs')).filter(r => r.kind === 'focus_session').length;
      s.stop();
      return { originalSessionId: original.session_id, tombstones: opsBefore.stale.length, originalTombstonePresent: opsBefore.stale.some(t => t.request_id === 'original-begin'), sessionsBefore: before, sessionsAfter: after, retry };
    });
    const evidence = { result, errors };
    fs.writeFileSync('E:/qoder/output/playwright/stage3b1-recheck-2026-11-21/retention-result.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
