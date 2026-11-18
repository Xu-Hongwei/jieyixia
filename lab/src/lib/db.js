import { toRaw } from 'vue'

const DB_NAME = 'jxl-lab'
const DB_VERSION = 1

let dbPromise = null

// IndexedDB 结构化克隆不接受 Vue 响应式 Proxy；写库前先脱代理再深克隆，
// 同时保证库内快照与界面状态解耦（保存失败不会留下半截修改）。
const snapshot = (value) => structuredClone(toRaw(value))

function open() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        t.oncomplete = () => resolve(req ? req.result : undefined)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

export const putSource = (source) => tx('sources', 'readwrite', (s) => s.put(snapshot(source)))
export const getSource = (id) => tx('sources', 'readonly', (s) => s.get(id))
export const allSources = () => tx('sources', 'readonly', (s) => s.getAll())

export const putDoc = (doc) => tx('docs', 'readwrite', (s) => s.put(snapshot(doc)))
export const deleteDoc = (id) => tx('docs', 'readwrite', (s) => s.delete(id))
export const allDocs = () => tx('docs', 'readonly', (s) => s.getAll())
