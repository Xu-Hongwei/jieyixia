import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { allDocs, allWorkspaces, configureWorkspace, putWorkspace } from '../services/storage/db'

// 原始 IDB 操作包成 Promise，模拟「旧版本浏览器」先建 v1 库并写入数据。
function openRaw(version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('jxl-product', version)
    req.onupgradeneeded = () => upgrade(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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

describe('IndexedDB v1 → v2 迁移：只增 workspaces store，旧数据不丢', () => {
  it('升级后既有 sources/docs 原样保留，新增 workspaces 目录', async () => {
    // 1) 旧版本 v1：只有 sources/docs，写入一条遗留便签与原始资料。
    const v1 = await openRaw(1, (db) => {
      db.createObjectStore('sources', { keyPath: 'id' })
      db.createObjectStore('docs', { keyPath: 'id' })
    })
    await putRaw(v1, 'docs', { id: 'legacy-note', kind: 'note', title: '旧便签', workspace_id: 'w1' })
    await putRaw(v1, 'sources', { id: 'legacy-src', kind: 'text', text: '旧资料', workspace_id: 'w1' })
    v1.close()

    // 2) 模块以 v2 打开 → 触发升级。configureWorkspace 后读取，旧数据必须仍在。
    configureWorkspace('w1')
    const docs = (await allDocs()).records
    expect(docs.map((d) => d.id)).toContain('legacy-note')
    expect(docs.find((d) => d.id === 'legacy-note').title).toBe('旧便签')

    // 3) workspaces store 已存在且可读写（升级新增，未清空旧 store）。
    expect(await allWorkspaces()).toEqual([])
    await putWorkspace({ id: 'personal', name: '个人空间', is_demo: false })
    expect((await allWorkspaces()).map((w) => w.id)).toEqual(['personal'])

    // 4) 显式确认三个 store 都在。
    const check = await openRaw(undefined, () => {})
    expect(check.objectStoreNames.contains('sources')).toBe(true)
    expect(check.objectStoreNames.contains('docs')).toBe(true)
    expect(check.objectStoreNames.contains('workspaces')).toBe(true)
    check.close()
  })
})