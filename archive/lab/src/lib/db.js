import { toRaw } from 'vue'

const DB_NAME = 'jxl-lab'
const DB_VERSION = 1

let dbPromise = null

// IndexedDB 结构化克隆不接受 Vue 响应式 Proxy。toRaw 只脱根一层：
// 嵌套的显式 reactive 数组/对象仍是 Proxy，必须逐层脱代理后再深克隆，
// 同时保证库内快照与界面状态解耦（保存失败不会留下半截修改）。
export const deepRaw = (value) => {
  const raw = toRaw(value)
  if (Array.isArray(raw)) return raw.map(deepRaw)
  if (raw && typeof raw === 'object') {
    const proto = Object.getPrototypeOf(raw)
    if (proto !== Object.prototype && proto !== null) return raw // Blob/Date/File 等交给 structuredClone
    const out = {}
    for (const key of Object.keys(raw)) out[key] = deepRaw(raw[key])
    return out
  }
  return raw
}
const snapshot = (value) => structuredClone(deepRaw(value))

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

// 原子删除便签：同一事务内先写入解除关联后的任务，再删便签。
// IndexedDB 事务整体提交或整体回滚——任一写入失败都不会留下「便签已删但关联悬空」的半截状态。
export const deleteNoteAtomic = (noteId, updatedTasks) =>
  open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('docs', 'readwrite')
        const s = t.objectStore('docs')
        try {
          for (const task of updatedTasks) s.put(snapshot(task))
          s.delete(noteId)
        } catch (err) {
          t.abort()
          reject(err)
          return
        }
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
