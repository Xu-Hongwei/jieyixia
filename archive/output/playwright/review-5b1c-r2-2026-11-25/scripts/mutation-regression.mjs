// 1C-R2 C2 漏检回归运行器（2026-11-25）：证明整改后的内容断言能发现真实 DB 损坏。
// 顺序执行 5 个真实浏览器运行（各自独立 Vite origin/独立 IDB，全部虚构数据）：
//   normal       —— 正常全量链路：必须 exit 0、全部 pass、无 skipped；
//   action_text  —— 主链路副作用比较前改坏 Action.text（真实 putDoc+实读确认）→ 必须 FAIL 非零退出；
//   restored_note—— 恢复完成后改坏恢复空间 Note.title → 必须 FAIL 非零退出；
//   source_note  —— 恢复完成后改坏原空间 Note.title → 必须 FAIL 非零退出；
//   history_ref  —— 恢复完成后改坏恢复草案 revision_history 证据引用 → 必须 FAIL 非零退出。
// 注入运行用 ONLY_MAIN=1（四个注入点均在 MAIN 场景），其余场景记 skipped 不计 passed。
// 运行：node E:/qoder/devlog/private-evidence/stage5b-1/5B-1C/scripts/mutation-regression.mjs
// 产出：../remediation-r2/gates/mutation-regression.json；各运行明细在 output/playwright/stage5b-1c/run-2026-11-25*。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(HERE, 'real-1c.mjs')
const OUT_BASE = join('E:', 'qoder', 'output', 'playwright', 'review-5b1c-r2-2026-11-25', 'runs')

function run(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    p.stdout.on('data', (d) => { log += d })
    p.stderr.on('data', (d) => { log += d })
    p.on('close', (code) => resolve({ code, log }))
  })
}

const cases = [
  { name: 'normal', env: {}, expectPass: true, runDir: 'run-2026-11-25' },
  { name: 'action_text', env: { MUTATE: 'action_text', ONLY_MAIN: '1' }, expectPass: false, failItem: 'B1C-16', runDir: 'run-2026-11-25-mutate-action_text' },
  { name: 'restored_note', env: { MUTATE: 'restored_note', ONLY_MAIN: '1' }, expectPass: false, failItem: 'B1C-05', runDir: 'run-2026-11-25-mutate-restored_note' },
  { name: 'source_note', env: { MUTATE: 'source_note', ONLY_MAIN: '1' }, expectPass: false, failItem: 'B1C-05', runDir: 'run-2026-11-25-mutate-source_note' },
  { name: 'history_ref', env: { MUTATE: 'history_ref', ONLY_MAIN: '1' }, expectPass: false, failItem: 'B1C-05', runDir: 'run-2026-11-25-mutate-history_ref' },
]

const report = { at: new Date().toISOString(), runner: RUNNER, cases: [] }
let allOk = true
for (const c of cases) {
  console.log(`\n===== 运行 ${c.name} =====`)
  const { code, log } = await run(c.env)
  let summary = null
  try { summary = JSON.parse(readFileSync(join(OUT_BASE, c.runDir, 'results.json'), 'utf8')) } catch {}
  const fails = summary ? summary.results.filter((r) => r.pass === false) : []
  const injected = c.expectPass ? true : /MUTATE .*已改坏并实读确认/.test(log)
  let verdict
  if (!summary) verdict = '缺少 results.json'
  else if (c.expectPass) {
    verdict = code === 0 && summary.failed === 0 && summary.skipped === 0 && summary.passed === summary.total ? 'OK' : `正常链路未全过 exit=${code} failed=${summary.failed} skipped=${summary.skipped}`
  } else {
    const targeted = fails.some((r) => r.item === c.failItem)
    verdict = code !== 0 && targeted && injected ? 'OK' : `注入未被检出 exit=${code} targetedFail=${targeted} injected=${injected} fails=${JSON.stringify(fails.map((f) => f.item + ':' + f.name))}`
  }
  const ok = verdict === 'OK'
  allOk = allOk && ok
  report.cases.push({ name: c.name, expect: c.expectPass ? 'all-pass-exit-0' : `FAIL-nonzero(${c.failItem})`, exit: code, passed: summary?.passed ?? null, failed: summary?.failed ?? null, skipped: summary?.skipped ?? null, injected, failItems: fails.map((f) => `${f.item}: ${f.name}`), verdict })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${c.name}] exit=${code} passed=${summary?.passed} failed=${summary?.failed} skipped=${summary?.skipped} — ${verdict}`)
}
writeFileSync(join(HERE, '..', 'remediation-r2', 'gates', 'mutation-regression.json'), JSON.stringify(report, null, 2))
console.log(`\n漏检回归 ${allOk ? '全部符合预期（正常全过；4 项注入均被检出并非零退出）' : '存在不符合预期项'}`)
process.exit(allOk ? 0 : 1)
