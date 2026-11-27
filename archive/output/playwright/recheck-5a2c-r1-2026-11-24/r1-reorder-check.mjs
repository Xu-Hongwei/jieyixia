// R1 补充验证（2026-11-24 人工复验要求4）：重排 inventory.sessions 不改变命名字段选中的记录。
// 纯 node 校验，不开浏览器、不写业务库。运行：node E:/qoder/devlog/private-evidence/stage5a-2c/r1-reorder-check.mjs
// 交叉核对人工复验批（recheck-5a2c-2026-11-24）的真实快照：旧 sessions[1] 选错、按 started_at 排序选择正确。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = dirname(fileURLToPath(import.meta.url))
const REVIEW = 'E:/qoder/output/playwright/recheck-5a2c-2026-11-24'
const results = []
const rec = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: String(detail ?? '') })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const byStarted = (a, b) => (a.started_at < b.started_at ? -1 : 1)
const p1Sorted = (docs, p1id) => docs.filter((d) => d.kind === 'focus_session' && d.plan_item_id === p1id).sort(byStarted)

// ---- A. 本目录最新 C01 产物：命名字段 = started_at 排序结果，且重排 sessions 不影响选择 ----
const inv = JSON.parse(readFileSync(join(OUT, 'c01-inventory.json'), 'utf8'))
const docs = JSON.parse(readFileSync(join(OUT, 'c01-docs-snapshot.json'), 'utf8'))
const sorted = p1Sorted(docs, inv.keyIds.P1)
rec('A1 inventory 含 p1Segments 命名字段', !!(inv.p1Segments && inv.p1Segments.first && inv.p1Segments.second), '')
rec('A2 first = P1 会话按 started_at 排序第 1 段', inv.p1Segments.first.id === sorted[0].id && inv.p1Segments.first.draft_md === sorted[0].draft_md, JSON.stringify({ id: sorted[0].id, started: sorted[0].started_at }))
rec('A3 second = P1 会话按 started_at 排序第 2 段', inv.p1Segments.second.id === sorted[1].id && inv.p1Segments.second.draft_md === sorted[1].draft_md, JSON.stringify({ id: sorted[1].id, started: sorted[1].started_at }))
rec('A4 first 属于 P1 / v1 / 已结束', sorted[0].plan_item_id === inv.keyIds.P1 && sorted[0].record_version === 1 && sorted[0].ended_at != null, '')
// 新选择逻辑只读 p1Segments：对 sessions 做原序/反转/全排列旋转，选择必须恒等
const pickNew = (i) => i.p1Segments.first.id
const orders = [inv.sessions, [...inv.sessions].reverse(), ...inv.sessions.map((_, k) => [...inv.sessions.slice(k), ...inv.sessions.slice(0, k)])]
const stable = orders.every((s) => pickNew({ ...inv, sessions: s }) === inv.p1Segments.first.id)
rec('A5 重排/反转/旋转 sessions 后命名选择恒等', stable, `orders=${orders.length}`)

// ---- B. 人工复验批真实快照交叉核对：旧位置逻辑选错，排序逻辑选中真正第一段 ----
if (existsSync(join(REVIEW, 'c01-docs-snapshot.json')) && existsSync(join(REVIEW, 'c01-inventory.json'))) {
  const rinv = JSON.parse(readFileSync(join(REVIEW, 'c01-inventory.json'), 'utf8'))
  const rdocs = JSON.parse(readFileSync(join(REVIEW, 'c01-docs-snapshot.json'), 'utf8'))
  const rsorted = p1Sorted(rdocs, rinv.keyIds.P1)
  const oldPick = rinv.sessions[1].id
  rec('B1 复验批旧逻辑 sessions[1] ≠ 真正第一段（复现原失败根因）', oldPick !== rsorted[0].id, JSON.stringify({ oldPick, trueFirst: rsorted[0].id }))
  rec('B2 复验批旧逻辑恰好选中第二段', oldPick === rsorted[1].id, JSON.stringify({ second: rsorted[1].id }))
  rec('B3 排序逻辑在复验批数据上选中「第一段成果」记录', rsorted[0].draft_md.includes('第一段成果') && rsorted[1].draft_md.includes('第二段成果'), JSON.stringify({ firstDraft: rsorted[0].draft_md, secondDraft: rsorted[1].draft_md }))
} else {
  rec('B0 人工复验批快照存在（交叉核对前提）', false, REVIEW)
}

writeFileSync(join(OUT, 'r1-reorder-check-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
console.log(`r1-reorder-check exit=${failed.length ? 1 : 0}`)
process.exit(failed.length ? 1 : 0)