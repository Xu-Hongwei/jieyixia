const DB_NAME = 'jxl-lab'
const DB_VERSION = 1

let dbPromise = null

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

export const putSource = (source) => tx('sources', 'readwrite', (s) => s.put(source))
export const getSource = (id) => tx('sources', 'readonly', (s) => s.get(id))
export const allSources = () => tx('sources', 'readonly', (s) => s.getAll())

export const putDoc = (doc) => tx('docs', 'readwrite', (s) => s.put(doc))
export const allDocs = () => tx('docs', 'readonly', (s) => s.getAll())
