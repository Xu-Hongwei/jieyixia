// S1 工作区异步读写保护：三种切换时间窗口的故障注入验证。
// 每个用例全新 IDBFactory + 全新模块实例（dbPromise 未缓存），窗口可精确控制。
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

let db
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('../services/storage/db')
})

// 把 indexedDB.open 的成功回调挂到闸门上：模拟「延迟 open」窗口。
function gateOpen() {
  const realOpen = indexedDB.open.bind(indexedDB)
  let release
  const gate = new Promise((r) => { release = r })
  indexedDB.open = function (...args) {
    const req = realOpen(...args)
    let handler = null
    Object.defineProperty(req, 'onsuccess', {
      configurable: true,
      get: () => handler,
      set: (fn) => { handler = () => gate.then(() => fn()) },
    })
    return req
  }
  return () => { release() }
}

// 把事务 oncomplete 回调挂到闸门上：模拟「已提交、回调迟到」窗口。
// fake-indexeddb 的 oncomplete 是实例自有属性，逐实例重定义为延迟 setter。
function gateComplete() {
  const origTx = IDBDatabase.prototype.transaction
  let release
  let signalCommitted
  const gate = new Promise((r) => { release = r })
  // oncomplete 触发 = 事务已提交（回调被闸门扣住）；用此信号确定性地定位「提交后」时刻。
  const committed = new Promise((r) => { signalCommitted = r })
  IDBDatabase.prototype.transaction = function (...args) {
    const t = origTx.apply(this, args)
    let handler = null
    Object.defineProperty(t, 'oncomplete', {
      configurable: true,
      get: () => handler,
      set: (fn) => { handler = (...a) => { signalCommitted(); gate.then(() => fn(...a)) } },
    })
    return t
  }
  return {
    committed,
    release: () => { release() },
    restore: () => { IDBDatabase.prototype.transaction = origTx },
  }
}

// 原始 IDB 直写（不经模块），用于在延迟 open 前预置数据。
function seedRaw(workspaceId, records) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', 2)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('sources')) d.createObjectStore('sources', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('workspaces')) d.createObjectStore('workspaces', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const d = req.result
      const t = d.transaction('docs', 'readwrite')
      for (const r of records) t.objectStore('docs').put({ ...r, workspace_id: workspaceId })
      t.oncomplete = () => { d.close(); resolve() }
      t.onerror = () => reject(t.error)
    }
    req.onerror = () => reject(req.error)
  })
}

describe('窗口1：延迟 open 期间切空间', () => {
  it('写入在 open 完成后发现世代已变 → WORKSPACE_CHANGED，两个空间都不落库', async () => {
    db.configureWorkspace('w1')
    const release = gateOpen()
    const pending = db.putDoc({ id: 'late-write', kind: 'note', title: '迟到写入' })
    db.configureWorkspace('w2')
    release()
    await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' })
    expect((await db.allDocs()).records).toHaveLength(0)
    db.configureWorkspace('w1')
    expect((await db.allDocs()).records).toHaveLength(0)
  })

  it('读取按调用时空间返回固定归属，晚到结果不冒充新空间数据', async () => {
    await seedRaw('w1', [{ id: 'w1-note', kind: 'note', title: '原空间便签' }])
    db.configureWorkspace('w1')
    const release = gateOpen()
    const pending = db.allDocs()
    db.configureWorkspace('w2')
    release()
    const result = await pending
    expect(result.workspace_id).toBe('w1')
    expect(result.records.map((d) => d.id)).toEqual(['w1-note'])
    // 新空间自己的读取仍是空，不被旧结果覆盖。
    expect((await db.allDocs()).records).toHaveLength(0)
  })

  it('transformDocsAtomic 同样在 open 完成后拒绝，计划不执行', async () => {
    db.configureWorkspace('w1')
    const release = gateOpen()
    const plan = vi.fn(() => ({ puts: [], deletes: [] }))
    const pending = db.transformDocsAtomic(plan)
    db.configureWorkspace('w2')
    release()
    await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' })
    expect(plan).not.toHaveBeenCalled()
  })
})

describe('窗口2：事务排队期间、计划执行前切空间', () => {
  it('getAll 已发出、回调前切空间 → abort 整体回滚，计划不执行、数据不动', async () => {
    db.configureWorkspace('w1')
    await db.putDoc({ id: 'keep', kind: 'note', title: '原样' })
    const origGetAll = IDBObjectStore.prototype.getAll
    const plan = vi.fn(() => ({ puts: [], deletes: ['keep'] }))
    IDBObjectStore.prototype.getAll = function (...args) {
      const req = origGetAll.apply(this, args)
      db.configureWorkspace('w2') // 请求已发出、onsuccess 尚未执行
      return req
    }
    try {
      await expect(db.transformDocsAtomic(plan)).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' })
    } finally {
      IDBObjectStore.prototype.getAll = origGetAll
    }
    expect(plan).not.toHaveBeenCalled()
    db.configureWorkspace('w1')
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['keep'])
    db.configureWorkspace('w2')
    expect((await db.allDocs()).records).toHaveLength(0)
  })

  it('写入请求已发出后切空间：事实落在原空间（stamp 用捕获值），绝不写进新空间', async () => {
    db.configureWorkspace('w1')
    const origPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      db.configureWorkspace('w2') // put 已带 w1 stamp 发出
      return origPut.call(this, value, ...rest)
    }
    let result
    try {
      result = await db.putDoc({ id: 'in-flight', kind: 'note', title: '在途' })
    } finally {
      IDBObjectStore.prototype.put = origPut
    }
    expect(result.workspace_id).toBe('w1')
    expect(result.record.workspace_id).toBe('w1')
    expect((await db.allDocs()).records).toHaveLength(0) // 当前 w2：空
    db.configureWorkspace('w1')
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['in-flight'])
  })
})

describe('窗口3：事务已提交、回调迟到期间切空间', () => {
  it('putDoc 已提交：晚到回调完成原空间事实，返回固定归属，新空间列表不受影响', async () => {
    db.configureWorkspace('w1')
    const gate = gateComplete()
    const pending = db.putDoc({ id: 'committed', kind: 'note', title: '已提交' })
    await gate.committed // 事务确已提交，oncomplete 回调被扣住
    db.configureWorkspace('w2')
    gate.release()
    const result = await pending
    gate.restore()
    expect(result.workspace_id).toBe('w1')
    expect((await db.allDocs()).records).toHaveLength(0) // w2 不被污染
    db.configureWorkspace('w1')
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['committed'])
  })

  it('transformDocsAtomic 已提交：结果带原空间归属，变更只在原空间可见', async () => {
    db.configureWorkspace('w1')
    await db.putDoc({ id: 'old', kind: 'note', title: '旧' })
    const gate = gateComplete()
    const pending = db.transformDocsAtomic(() => ({
      puts: [{ id: 'new', kind: 'note', title: '新' }],
      deletes: ['old'],
    }))
    await gate.committed // 事务确已提交，oncomplete 回调被扣住
    db.configureWorkspace('w2')
    gate.release()
    const result = await pending
    gate.restore()
    expect(result.workspace_id).toBe('w1')
    expect(result.deletes).toEqual(['old'])
    expect(result.puts[0].workspace_id).toBe('w1')
    expect((await db.allDocs()).records).toHaveLength(0) // w2
    db.configureWorkspace('w1')
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['new'])
  })
})

describe('归属与目录语义', () => {
  it('getSource 跨空间 id 返回 undefined 记录但归属固定；deleteDoc 拒绝跨空间删除', async () => {
    db.configureWorkspace('w1')
    await db.putSource({ id: 's1', kind: 'text', text: '资料' })
    await db.putDoc({ id: 'd1', kind: 'note', title: '便签' })
    db.configureWorkspace('w2')
    const src = await db.getSource('s1')
    expect(src.workspace_id).toBe('w2')
    expect(src.record).toBeUndefined()
    await expect(db.deleteDoc('d1')).rejects.toThrow('跨工作空间删除被拒绝')
    db.configureWorkspace('w1')
    expect((await db.allDocs()).records.map((d) => d.id)).toEqual(['d1'])
  })

  it('workspaces 目录不受切换世代约束：切换后仍可写目录', async () => {
    db.configureWorkspace('w1')
    db.configureWorkspace('w2')
    await db.putWorkspace({ id: 'personal', name: '个人空间', is_demo: false })
    expect((await db.allWorkspaces()).map((w) => w.id)).toEqual(['personal'])
  })
})

describe('store 层：晚到读取不覆盖新空间列表', () => {
  it('reload 在途切空间：旧空间读取结果被丢弃，新空间列表由自己的 reload 建立', async () => {
    setActivePinia(createPinia())
    const { useAppStore } = await import('../stores/app')
    const store = useAppStore()
    await store.init() // personal
    await db.putDoc({ id: 'p-note', kind: 'note', title: '个人便签', status: 'draft', fields: [], warnings: [] })
    await store.reload()
    expect(store.notes.some((n) => n.id === 'p-note')).toBe(true)

    // 扣住后续 getAll 回调：personal 的 reload 在途时切到 demo。
    const origGetAll = IDBObjectStore.prototype.getAll
    let release
    const gate = new Promise((r) => { release = r })
    IDBObjectStore.prototype.getAll = function (...args) {
      const req = origGetAll.apply(this, args)
      let handler = null
      Object.defineProperty(req, 'onsuccess', {
        configurable: true,
        get: () => handler,
        set: (fn) => { handler = (...a) => gate.then(() => fn(...a)) },
      })
      return req
    }
    try {
      const staleReload = store.reload()
      const switching = store.switchWorkspace('demo')
      release()
      await Promise.all([staleReload, switching])
    } finally {
      IDBObjectStore.prototype.getAll = origGetAll
    }
    expect(store.workspaceId).toBe('demo')
    expect(store.notes.some((n) => n.id === 'p-note')).toBe(false)
    await db.putDoc({ id: 'd-note', kind: 'note', title: '演示便签', status: 'draft', fields: [], warnings: [] })
    await store.reload()
    expect(store.notes.map((n) => n.id)).toEqual(['d-note'])
  })
})