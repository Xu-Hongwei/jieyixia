// S3：DB v2→v3 迁移（只增 focus_runtime，旧数据不丢）、versionchange/blocked 处理、
// transformFocusAtomic 跨 store 原子性、clearWorkspace 清 runtime。
// 每个用例全新 IDBFactory + resetModules，模块状态互不污染。
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function openRaw(version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', version)
    req.onupgradeneeded = () => upgrade(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(Object.assign(new Error('raw open blocked'), { code: 'RAW_BLOCKED' }))
  })
}
function putRaw(db, store, value) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    t.objectStore(store).put(value)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
const runRecord = (ws, sessionId) => ({ id: `run:${ws}`, kind: 'running', workspace_id: ws, session_id: sessionId, updated_at: 1 })

let db
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('../services/storage/db')
})

describe('v2→v3 迁移：只增 focus_runtime，旧数据原样保留', () => {
  it('v2 遗留 sources/docs/workspaces 全保留，新 store 可读写', async () => {
    const v2 = await openRaw(2, (d) => {
      d.createObjectStore('sources', { keyPath: 'id' })
      d.createObjectStore('docs', { keyPath: 'id' })
      d.createObjectStore('workspaces', { keyPath: 'id' })
    })
    await putRaw(v2, 'docs', { id: 'legacy-note', kind: 'note', title: '旧便签', workspace_id: 'w1' })
    await putRaw(v2, 'sources', { id: 'legacy-src', kind: 'text', text: '旧资料', workspace_id: 'w1' })
    await putRaw(v2, 'workspaces', { id: 'personal', name: '个人空间', is_demo: false })
    v2.close()

    db.configureWorkspace('w1')
    const docs = await db.allDocs()
    expect(docs.records.map((d) => d.id)).toContain('legacy-note')
    expect((await db.allSources()).records.map((s) => s.id)).toContain('legacy-src')
    expect((await db.allWorkspaces()).map((w) => w.id)).toEqual(['personal'])

    expect(await db.allFocusRuntime()).toEqual({ workspace_id: 'w1', records: [] })
    const applied = await db.transformFocusAtomic(() => ({ runtimePuts: [runRecord('w1', 's1')] }))
    expect(applied.workspace_id).toBe('w1')
    expect((await db.allFocusRuntime()).records).toEqual([runRecord('w1', 's1')])

    const check = await openRaw(undefined, () => {})
    for (const name of ['sources', 'docs', 'workspaces', 'focus_runtime']) {
      expect(check.objectStoreNames.contains(name)).toBe(true)
    }
    check.close()
  })
  it('v1→v3 链式迁移：一次升级补齐 workspaces 与 focus_runtime', async () => {
    const v1 = await openRaw(1, (d) => {
      d.createObjectStore('sources', { keyPath: 'id' })
      d.createObjectStore('docs', { keyPath: 'id' })
    })
    await putRaw(v1, 'docs', { id: 'n1', kind: 'note', title: 't', workspace_id: 'w1' })
    v1.close()
    db.configureWorkspace('w1')
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['n1'])
    const check = await openRaw(undefined, () => {})
    expect(check.objectStoreNames.contains('workspaces')).toBe(true)
    expect(check.objectStoreNames.contains('focus_runtime')).toBe(true)
    check.close()
  })
})

describe('transformFocusAtomic：docs + focus_runtime 同一事务', () => {
  beforeEach(() => db.configureWorkspace('w1'))
  it('跨 store 一起提交；docs 按空间过滤、runtime 全量可见', async () => {
    await db.putDoc({ id: 't1', kind: 'task', title: '任务' })
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'docs', { id: 't-other', kind: 'task', title: '他空间', workspace_id: 'w2' })
    await putRaw(raw, 'focus_runtime', runRecord('w2', 'other-sess'))
    raw.close()
    let seenDocs = null
    let seenRuntime = null
    const applied = await db.transformFocusAtomic((latest, runtime) => {
      seenDocs = latest.map((d) => d.id)
      seenRuntime = runtime.map((r) => r.id)
      return { puts: [{ id: 'f1', kind: 'focus_session', task_id: 't1' }], runtimePuts: [runRecord('w1', 'f1')], info: { ok: true } }
    })
    expect(seenDocs).toEqual(['t1'])
    expect(seenRuntime).toContain('run:w2')
    expect(applied.puts[0].workspace_id).toBe('w1')
    expect(applied.info).toEqual({ ok: true })
    expect((await db.allDocs()).records.map((d) => d.id).sort()).toEqual(['f1', 't1'])
    const rt = (await db.allFocusRuntime()).records
    expect(rt.find((r) => r.id === 'run:w1').session_id).toBe('f1')
    expect(rt.find((r) => r.id === 'run:w2').session_id).toBe('other-sess')
  })
  it('写入中途失败 → 两个 store 都原样保留（整体回滚）', async () => {
    await db.putDoc({ id: 't1', kind: 'task', title: '任务' })
    await db.transformFocusAtomic(() => ({ runtimePuts: [runRecord('w1', null)] }))
    const origPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (value && value.kind === 'running') throw Object.assign(new Error('先处理进行中的专注会话'), { code: 'RELATION_INVALID' })
      return origPut.call(this, value, ...rest)
    }
    try {
      await expect(db.transformFocusAtomic(() => ({
        puts: [{ id: 't1', kind: 'task', title: '改' }],
        runtimePuts: [runRecord('w1', 'x')],
      }))).rejects.toMatchObject({ code: 'RELATION_INVALID' })
    } finally {
      IDBObjectStore.prototype.put = origPut
    }
    expect((await db.allDocs()).records.find((d) => d.id === 't1').title).toBe('任务')
    expect((await db.allFocusRuntime()).records.find((r) => r.id === 'run:w1').session_id).toBeNull()
  })
  it('plan 直接抛错（保护谓词）→ 无任何写入', async () => {
    await db.putDoc({ id: 't1', kind: 'task', title: '任务' })
    await expect(db.transformFocusAtomic(() => {
      throw Object.assign(new Error('先处理进行中的专注会话'), { code: 'RELATION_INVALID' })
    })).rejects.toMatchObject({ code: 'RELATION_INVALID' })
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['t1'])
    expect((await db.allFocusRuntime()).records).toEqual([])
  })
  it('跨空间 runtime 写入被拒绝并回滚', async () => {
    await expect(db.transformFocusAtomic(() => ({ runtimePuts: [runRecord('w2', 'x')] }))).rejects.toThrow('跨工作空间 runtime 写入被拒绝')
    expect((await db.allFocusRuntime()).records).toEqual([])
  })
  it('排队期间切空间 → 计划不执行，WORKSPACE_CHANGED 整体回滚', async () => {
    await db.putDoc({ id: 't1', kind: 'task', title: '任务' })
    const orig = IDBObjectStore.prototype.getAll
    let planCalled = false
    IDBObjectStore.prototype.getAll = function (...args) {
      const req = orig.apply(this, args)
      db.configureWorkspace('w2') // 请求已发出、回调尚未执行
      return req
    }
    try {
      await expect(db.transformFocusAtomic(() => { planCalled = true; return { puts: [{ id: 'x', kind: 'task' }] } })).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' })
    } finally {
      IDBObjectStore.prototype.getAll = orig
    }
    expect(planCalled).toBe(false)
    db.configureWorkspace('w1')
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['t1'])
  })
})

describe('clearWorkspace：runtime 一并清，不留运行锁', () => {
  it('只清指定空间的 docs/sources/runtime，其它空间保留', async () => {
    db.configureWorkspace('w1')
    await db.putDoc({ id: 't1', kind: 'task', title: '任务' })
    await db.transformFocusAtomic(() => ({ runtimePuts: [runRecord('w1', 'f1')] }))
    const raw = await openRaw(undefined, () => {})
    await putRaw(raw, 'docs', { id: 't2', kind: 'task', title: '他空间', workspace_id: 'w2' })
    await putRaw(raw, 'focus_runtime', runRecord('w2', 'f2'))
    raw.close()
    await db.clearWorkspace('w1')
    expect((await db.allDocs()).records).toEqual([])
    expect((await db.allFocusRuntime()).records.map((r) => r.id)).toEqual(['run:w2'])
    db.configureWorkspace('w2')
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['t2'])
  })
})

describe('升级协调：blocked 可解释、versionchange 让位', () => {
  it('旧标签占库 → DB_UPGRADE_BLOCKED；关闭占用后重试成功', async () => {
    const v2 = await openRaw(2, (d) => {
      d.createObjectStore('sources', { keyPath: 'id' })
      d.createObjectStore('docs', { keyPath: 'id' })
      d.createObjectStore('workspaces', { keyPath: 'id' })
    })
    await putRaw(v2, 'docs', { id: 'n1', kind: 'note', title: 't', workspace_id: 'w1' })
    db.configureWorkspace('w1')
    await expect(db.allDocs()).rejects.toMatchObject({ code: 'DB_UPGRADE_BLOCKED' })
    v2.close()
    const res = await db.allDocs()
    expect(res.records.map((d) => d.id)).toEqual(['n1'])
  })
  it('其它连接发起更高版本升级 → 本连接关闭并清缓存，下次操作重新 open', async () => {
    db.configureWorkspace('w1')
    await db.putDoc({ id: 'n1', kind: 'note', title: 't' })
    let openCalls = 0
    const origOpen = indexedDB.open.bind(indexedDB)
    indexedDB.open = (...args) => { openCalls += 1; return origOpen(...args) }
    const v5 = await openRaw(5, (d) => { d.createObjectStore('extra', { keyPath: 'id' }) })
    expect(v5.objectStoreNames.contains('extra')).toBe(true)
    expect(v5.objectStoreNames.contains('docs')).toBe(true)
    // 旧连接已让位（否则上面的升级会被 blocked）。本模块版本低于库版本 → 重新 open 报 VersionError，
    // 证明 dbPromise 已清、连接已关，而不是拿着失效连接继续。
    await expect(db.allDocs()).rejects.toMatchObject({ name: 'VersionError' })
    expect(openCalls).toBeGreaterThanOrEqual(2)
    v5.close()
    indexedDB.open = origOpen
  })
})