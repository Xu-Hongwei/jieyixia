// 3B-2 验收公共库：真实产品页面（127.0.0.1:5183）+ 真实 IndexedDB 断言。
// 虚构数据集经 db 模块 seeding（fixture 准备）；被测流程全部走真实 UI 与真实 store。
const { createRequire } = require('node:module')
const { chromium } = createRequire('E:/qoder/frontend/package.json')('playwright-core')
const fs = require('node:fs')

const BASE = 'http://127.0.0.1:5183'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const DIR = 'E:/qoder/output/playwright/stage3b2-review-2026-11-21'
const EPOCH = '2026-11-21T10:00:00+08:00'

async function launch() {
  return chromium.launch({ executablePath: EDGE, headless: true })
}

function recorder(tag) {
  const checks = []
  const check = (name, pass, detail) => {
    checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail })
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' :: ' + JSON.stringify(detail)}`)
  }
  const save = (extra = {}) => {
    const failed = checks.filter((c) => !c.pass)
    const out = { tag, at: new Date().toISOString(), total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks, ...extra }
    fs.writeFileSync(`${DIR}/${tag}-result.json`, JSON.stringify(out, null, 2))
    console.log(`== ${tag}: ${out.passed}/${out.total} passed ==`)
    return out
  }
  return { check, save, checks }
}

// 同一浏览器上下文内的新页面（共享 IndexedDB/localStorage，用于多页跨空间场景）。
async function pageIn(c, { clock } = {}) {
  const p = await c.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(String(e && e.message || e)))
  if (clock) await p.clock.install({ time: new Date(EPOCH) })
  return { p, errors }
}

async function newPage(b, { viewport, clock } = {}) {
  const c = await b.newContext({ viewport: viewport || { width: 1280, height: 900 } })
  const { p, errors } = await pageIn(c, { clock })
  return { c, p, errors }
}

async function openApp(p, path = '/today') {
  await p.goto(BASE + '/#' + path)
  await p.waitForFunction(() => {
    const m = document.querySelector('main')
    return m && m.innerText.trim().length > 0 && !m.innerText.includes('正在读取本地工作数据')
  }, { timeout: 20000 })
}

// 虚构数据集：求职准备事项 + 两张便签（文字/图片出处）+ 四个任务（含受阻/已完成/无资料独立任务）。
async function seed(p) {
  await p.evaluate(async () => {
    const db = await import('/src/services/storage/db.js')
    const now = new Date().toISOString()
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0))
    db.configureWorkspace('personal')
    await db.putSource({ id: 'src1', kind: 'text', text:'校招投递通知：简历投递截止 11 月 25 日 18:00，需 PDF。', captured_at: now, name: '通知.txt' })
    await db.putSource({ id: 'src2', kind: 'image', blob: new Blob([png], { type: 'image/png' }), captured_at: now, name: '项目截图.png' })
    await db.putDoc({ id: 'm1', kind: 'matter', title: '求职准备', note_ids: ['n1', 'n2'], created_at: now, updated_at: now })
    await db.putDoc({
      id: 'n1', kind: 'note', source_id: 'src1', status: 'reviewed', content_type: 'reference', title: '校招投递通知',
      fields: [
        { key: 'deadline', value: '2026-11-25T18:00', status: 'confirmed', origin: 'user', basis: 'absolute', derived: false },
        { key: 'requirement', value: 'PDF 简历', status: 'candidate', origin: 'ai', basis: 'absolute', derived: false },
      ],
      warnings: [], matter_id: 'm1', matter_role: null, created_at: now, updated_at: now,
    })
    await db.putDoc({
      id: 'n2', kind: 'note', source_id: 'src2', status: 'reviewed', content_type: 'reference', title: '项目要点截图',
      fields: [{ key: 'summary', value: '项目要点见原图', status: 'confirmed', origin: 'user', basis: 'absolute', derived: false }],
      warnings: [], matter_id: 'm1', matter_role: null, created_at: now, updated_at: now,
    })
    const task = (id, title, extra) => ({
      id, kind: 'task', title, description: '', completion_criteria: null, status: 'todo',
      matter_id: null, note_ids: [], deadline: { value: null, precision: 'none' }, current_action_id: null,
      created_at: now, updated_at: now, ...extra,
    })
    const action = (id, taskId, text, minutes, extra) => ({
      id, kind: 'action', task_id: taskId, text, minutes, basis: 'user', done: false, created_at: now, ...extra,
    })
    await db.putDoc(task('t1', '完成简历初稿', {
      matter_id: 'm1', note_ids: ['n1'], current_action_id: 'a1',
      deadline: { value: '2026-11-25T18:00', precision: 'datetime', source: 'note', from_note_id: 'n1', confirmed_at: now },
    }))
    await db.putDoc(action('a1', 't1', '写教育背景', 25))
    await db.putDoc(action('a2', 't1', '写项目经历', 30))
    await db.putDoc(task('t2', '整理下载文件夹', { current_action_id: 'a3' }))
    await db.putDoc(action('a3', 't2', '清理旧安装包', 15))
    await db.putDoc(task('t3', '等待推荐信', { status: 'blocked', current_action_id: 'a4' }))
    await db.putDoc(action('a4', 't3', '联系推荐人', 20))
    await db.putDoc(task('t4', '已完成的旧任务', { status: 'done', current_action_id: 'a5' }))
    await db.putDoc(action('a5', 't4', '旧行动', 10, { done: true }))
    db.configureWorkspace('demo')
    await db.putDoc(task('dt1', '演示任务：布置会场', { current_action_id: 'da1' }))
    await db.putDoc(action('da1', 'dt1', '摆放桌椅', 20))
    db.configureWorkspace('personal')
  })
}

// 当前空间 docs（经真实 db 模块，与 app 同一实例）。
async function docs(p) {
  return p.evaluate(async () => {
    const db = await import('/src/services/storage/db.js')
    return (await db.allDocs()).records
  })
}
async function runtime(p) {
  return p.evaluate(async () => {
    const db = await import('/src/services/storage/db.js')
    return (await db.allFocusRuntime()).records
  })
}
// 全库原始读取（跨空间断言）：直接开 IndexedDB。
async function rawAll(p, store) {
  return p.evaluate(async (name) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('jxl-product')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const out = await new Promise((res, rej) => {
      const tx = db.transaction(name, 'readonly')
      const q = tx.objectStore(name).getAll()
      q.onsuccess = () => res(q.result)
      q.onerror = () => rej(q.error)
    })
    db.close()
    return out
  }, store)
}
const sessions = (ds) => ds.filter((d) => d.kind === 'focus_session')
const byId = (ds, id) => ds.find((d) => d.id === id) || null

async function shot(p, name) {
  await p.screenshot({ path: `${DIR}/${name}.png`, fullPage: false })
}

// 受控时钟按秒推进并在每秒间留真实间隙：检查点事务（真实 IndexedDB 异步）得以完成，
// 租约/检查点节奏与真实运行一致，不产生假过期。
async function advance(p, ms) {
  const steps = Math.ceil(ms / 1000)
  for (let i = 0; i < steps; i++) {
    await p.clock.runFor(Math.min(1000, ms - i * 1000))
    await new Promise((r) => setTimeout(r, 25))
  }
}

module.exports = { BASE, EDGE, DIR, EPOCH, launch, recorder, newPage, pageIn, openApp, seed, docs, runtime, rawAll, sessions, byId, shot, advance }
