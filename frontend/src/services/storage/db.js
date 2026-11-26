import { toRaw } from 'vue'
import { sourceContentVersion } from '../backup/format.js'

const DB_NAME = 'jxl-product'
// v2：新增 workspaces 目录 store；v3：新增 focus_runtime 运行元数据 store；
// v4：新增 assistant_threads/assistant_drafts/assistant_ops（5B-1B，只增 store 与索引）。
// 升级只「增 store」，绝不触碰既有 sources/docs/workspaces/focus_runtime，旧数据原样保留（迁移测试守着）。
const DB_VERSION = 4

let dbPromise = null
let workspaceId = null
// 世代号：每次 configureWorkspace 递增。异步操作调用时捕获 {ws, gen}，
// 写入发起前发现世代已变 → 拒绝/回滚（WORKSPACE_CHANGED）；已提交的事实带固定归属返回。
let generation = 0

export function configureWorkspace(id) {
  workspaceId = id
  generation += 1
}

const captureContext = () => ({ ws: workspaceId, gen: generation })
const workspaceChangedError = () =>
  Object.assign(new Error('工作区已切换，本次写入已回滚'), { code: 'WORKSPACE_CHANGED' })

// IndexedDB 结构化克隆不接受 Vue 响应式 Proxy。toRaw 只脱根一层：
// 嵌套的显式 reactive 数组/对象仍是 Proxy，必须逐层脱代理后再深克隆。
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
export const snapshot = (value) => structuredClone(deepRaw(value))

function open() {
  if (dbPromise) return dbPromise
  const p = new Promise((resolve, reject) => {
    let abandoned = false
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' })
      // v2 新增：工作区目录。已存在的 sources/docs 不动，旧数据不丢。
      if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', { keyPath: 'id' })
      // v3 新增：专注运行元数据（协调/运行位置/幂等台账）。不是用户成果，不进备份导出。
      if (!db.objectStoreNames.contains('focus_runtime')) db.createObjectStore('focus_runtime', { keyPath: 'id' })
      // v4 新增：助手线程/草案（进备份 v2）与采用台账（本批只建空 store，5B-2 才写入）。
      // assistant_ops 主键是 application_id（记录形状无 id 字段，keyPath 'id' 会 DataError）。
      if (!db.objectStoreNames.contains('assistant_threads')) {
        const s = db.createObjectStore('assistant_threads', { keyPath: 'id' })
        s.createIndex('by_workspace', 'workspace_id')
      }
      if (!db.objectStoreNames.contains('assistant_drafts')) {
        const s = db.createObjectStore('assistant_drafts', { keyPath: 'id' })
        s.createIndex('by_workspace', 'workspace_id')
        s.createIndex('by_thread', 'thread_id')
      }
      if (!db.objectStoreNames.contains('assistant_ops')) {
        const s = db.createObjectStore('assistant_ops', { keyPath: 'application_id' })
        s.createIndex('by_workspace', 'workspace_id')
      }
    }
    req.onsuccess = () => {
      const db = req.result
      if (abandoned) { db.close(); return }
      // 旧标签让位升级：关连接并清缓存，下次操作重新 open。
      db.onversionchange = () => {
        db.close()
        if (dbPromise === p) dbPromise = null
      }
      resolve(db)
    }
    // 其它标签页占着旧版本 → 可解释错误，不无限等待；关闭占用后重试即可。
    req.onblocked = () => {
      if (abandoned) return
      abandoned = true
      if (dbPromise === p) dbPromise = null
      reject(Object.assign(new Error('数据库升级被其它标签页占用，请关闭其它页面后重试'), { code: 'DB_UPGRADE_BLOCKED' }))
    }
    req.onerror = () => {
      if (dbPromise === p) dbPromise = null
      reject(req.error)
    }
  })
  dbPromise = p
  return p
}

// ctx 为调用时捕获的空间上下文：读写一律按捕获 ws 过滤/stamp，绝不读操作时的全局值。
// 写事务在发起写入前做世代检查：切换已发生 → 不发起写入，直接拒绝。
// 目录类操作（workspaces）传 null：非空间语义，不受切换世代约束。
function tx(store, mode, fn, ctx) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (ctx && mode === 'readwrite' && ctx.gen !== generation) {
          reject(workspaceChangedError())
          return
        }
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        t.oncomplete = () => resolve(req ? req.result : undefined)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

const stamp = (record, ws) => {
  if (!ws) throw new Error('workspace 未配置')
  if (record.workspace_id && record.workspace_id !== ws) {
    throw new Error('跨工作空间写入被拒绝')
  }
  return { ...snapshot(record), workspace_id: ws }
}
const inWorkspace = (record, ws) => record && record.workspace_id === ws

export const putSource = async (source) => {
  const ctx = captureContext()
  const record = stamp(source, ctx.ws)
  // R9：事务外按真实字节计算内容版本随记录落库，供 ready 提交事务内同步绑定核对（同尺寸图片替换可检出）。
  record.content_version = await sourceContentVersion(record)
  await tx('sources', 'readwrite', (s) => s.put(record), ctx)
  return { workspace_id: ctx.ws, record }
}
export const getSource = async (id) => {
  const ctx = captureContext()
  const record = await tx('sources', 'readonly', (s) => s.get(id), ctx)
  return { workspace_id: ctx.ws, record: inWorkspace(record, ctx.ws) ? record : undefined }
}
export const allSources = async () => {
  const ctx = captureContext()
  const records = await tx('sources', 'readonly', (s) => s.getAll(), ctx)
  return { workspace_id: ctx.ws, records: records.filter((r) => inWorkspace(r, ctx.ws)) }
}

export const putDoc = async (doc) => {
  const ctx = captureContext()
  const record = stamp(doc, ctx.ws)
  await tx('docs', 'readwrite', (s) => s.put(record), ctx)
  return { workspace_id: ctx.ws, record }
}
export const allDocs = async () => {
  const ctx = captureContext()
  const records = await tx('docs', 'readonly', (s) => s.getAll(), ctx)
  return { workspace_id: ctx.ws, records: records.filter((r) => inWorkspace(r, ctx.ws)) }
}

export const workspaceAssistantDrafts = async () => {
  const ctx = captureContext()
  const records = await tx('assistant_drafts', 'readonly', (s) => s.index('by_workspace').getAll(ctx.ws), ctx)
  return { workspace_id: ctx.ws, records }
}

// 一致只读快照（备份导出用，开工单 §4/§9.1）：sources/docs/workspaces/assistant_threads/assistant_drafts
// 在同一只读事务内读取，是同一时间点的固定快照，而非串行读取假设同一时刻。事务内绝不 await
// 压缩/哈希/文件读取（避免事务提前结束）；序列化/哈希/压缩一律在事务提交后于内存进行。
// 按显式 wsId 过滤（不依赖操作时全局空间）：导出中切换空间不会把新空间混入。
// 其它标签页此后的修改不影响已固定快照；不强制全局停写。空空间返回空数组（合法空备份）。
// assistant_ops/focus_runtime 永不进快照（运行台账/采用信封不是可导出成果）。
export const readWorkspaceSnapshot = (wsId) =>
  open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(['sources', 'docs', 'workspaces', 'assistant_threads', 'assistant_drafts'], 'readonly')
        const sReq = t.objectStore('sources').getAll()
        const dReq = t.objectStore('docs').getAll()
        const wReq = t.objectStore('workspaces').get(wsId)
        const thReq = t.objectStore('assistant_threads').getAll()
        const drReq = t.objectStore('assistant_drafts').getAll()
        let sources = []
        let docs = []
        let workspace = null
        let assistantThreads = []
        let assistantDrafts = []
        sReq.onsuccess = () => { sources = sReq.result.filter((r) => inWorkspace(r, wsId)) }
        dReq.onsuccess = () => { docs = dReq.result.filter((r) => inWorkspace(r, wsId)) }
        wReq.onsuccess = () => { workspace = wReq.result || null }
        thReq.onsuccess = () => { assistantThreads = thReq.result.filter((r) => inWorkspace(r, wsId)) }
        drReq.onsuccess = () => { assistantDrafts = drReq.result.filter((r) => inWorkspace(r, wsId)) }
        sReq.onerror = () => reject(sReq.error)
        dReq.onerror = () => reject(dReq.error)
        wReq.onerror = () => reject(wReq.error)
        thReq.onerror = () => reject(thReq.error)
        drReq.onerror = () => reject(drReq.error)
        t.oncomplete = () => resolve({ workspaceId: wsId, workspace, sources, docs, assistantThreads, assistantDrafts })
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )

// 单事务「读最新 docs → 纯函数计划算变更 → 先删后写」。plan 抛错即整体回滚，界面不更新。
// 联删、事项归组、结构迁移、冲突感知恢复共用此原语：决策依据事务内最新状态，不用陈旧内存快照。
// 先删后写允许同 id 换 kind（group → matter）。返回实际写入的已 stamp 记录与删除 id，带固定归属。
// 计划执行前（getAll 回调里）再查一次世代：排队期间切空间 → abort 整体回滚。
export const transformDocsAtomic = (plan) => {
  const ctx = captureContext()
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (ctx.gen !== generation) {
          reject(workspaceChangedError())
          return
        }
        const t = db.transaction('docs', 'readwrite')
        const s = t.objectStore('docs')
        let applied = { workspace_id: ctx.ws, puts: [], deletes: [], info: null }
        const req = s.getAll()
        req.onsuccess = () => {
          try {
            if (ctx.gen !== generation) throw workspaceChangedError()
            const latest = req.result.filter((r) => inWorkspace(r, ctx.ws))
            const { puts = [], deletes = [], info = null } = plan(latest) || {}
            for (const id of deletes) s.delete(id)
            const stamped = puts.map((doc) => stamp(doc, ctx.ws))
            for (const doc of stamped) s.put(doc)
            applied = { workspace_id: ctx.ws, puts: stamped, deletes, info }
          } catch (err) {
            t.abort()
            reject(err)
          }
        }
        req.onerror = () => reject(req.error)
        // 已提交事实不可回滚：晚到回调照常完成原空间写入，结果带调用时归属，由 store 决定是否应用。
        t.oncomplete = () => resolve(applied)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

// 专注会话共同协调原语：单一读写事务覆盖 docs + focus_runtime。
// 事务内读最新 docs（按捕获空间过滤）与全量 runtime（run 记录需跨空间读）→
// plan(latestDocs, runtime, ctx) 返回 { puts, deletes, runtimePuts, runtimeDeletes, info } →
// 计划执行前再查世代 → 先删后写。任何抛错 abort 整体回滚；已提交事实带固定归属。
// runtime 写入只允许本空间记录（跨空间 run 位置由各自空间的事务维护）。
export const transformFocusAtomic = (plan) => {
  const ctx = captureContext()
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (ctx.gen !== generation) {
          reject(workspaceChangedError())
          return
        }
        const t = db.transaction(['docs', 'focus_runtime'], 'readwrite')
        const docsStore = t.objectStore('docs')
        const rtStore = t.objectStore('focus_runtime')
        let applied = { workspace_id: ctx.ws, puts: [], deletes: [], runtimePuts: [], runtimeDeletes: [], info: null }
        let docsResult = null
        let rtResult = null
        let pending = 2
        const maybePlan = () => {
          pending -= 1
          if (pending > 0) return
          try {
            if (ctx.gen !== generation) throw workspaceChangedError()
            const latest = docsResult.filter((r) => inWorkspace(r, ctx.ws))
            // allDocs：事务内未过滤全量 docs，供全局运行互斥扫描全库真实会话（含无 runtime 元数据的旧版）。
            const { puts = [], deletes = [], runtimePuts = [], runtimeDeletes = [], info = null } = plan(latest, rtResult, { ...ctx, allDocs: docsResult }) || {}
            for (const id of deletes) docsStore.delete(id)
            const stamped = puts.map((doc) => stamp(doc, ctx.ws))
            for (const doc of stamped) docsStore.put(doc)
            for (const id of runtimeDeletes) rtStore.delete(id)
            const rtStamped = runtimePuts.map((r) => {
              if (!r || r.workspace_id !== ctx.ws) throw new Error('跨工作空间 runtime 写入被拒绝')
              return snapshot(r)
            })
            for (const r of rtStamped) rtStore.put(r)
            applied = { workspace_id: ctx.ws, puts: stamped, deletes, runtimePuts: rtStamped, runtimeDeletes, info }
          } catch (err) {
            t.abort()
            reject(err)
          }
        }
        const docsReq = docsStore.getAll()
        const rtReq = rtStore.getAll()
        docsReq.onsuccess = () => { docsResult = docsReq.result; maybePlan() }
        rtReq.onsuccess = () => { rtResult = rtReq.result; maybePlan() }
        docsReq.onerror = () => reject(docsReq.error)
        rtReq.onerror = () => reject(rtReq.error)
        t.oncomplete = () => resolve(applied)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

// 全量运行元数据（含跨空间 run 位置）；归属为捕获空间，由调用方决定过滤。
export const allFocusRuntime = async () => {
  const ctx = captureContext()
  const records = await tx('focus_runtime', 'readonly', (s) => s.getAll(), ctx)
  return { workspace_id: ctx.ws, records }
}

// 全量助手采用台账（只读，验证恢复零 ops 用）；不按当前空间过滤，调用方按 workspace_id 筛。
// 恢复流程绝不写入 assistant_ops，也不根据 applied_summary 重建（§9.4）。
export const allAssistantOps = async () => {
  const ctx = captureContext()
  const records = await tx('assistant_ops', 'readonly', (s) => s.getAll(), ctx)
  return { workspace_id: ctx.ws, records }
}

// 助手线程/草案一致只读快照（读取基线用）：threads/drafts/ops/docs/sources 同一 readonly 事务，
// 按捕获空间过滤。引用解析/ready 推导/并发基线/采用信封复用都基于这一份固定快照，不串行假设同一时刻。
export const readAssistantSnapshot = () => {
  const ctx = captureContext()
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(['assistant_threads', 'assistant_drafts', 'assistant_ops', 'sources', 'docs'], 'readonly')
        const thReq = t.objectStore('assistant_threads').getAll()
        const drReq = t.objectStore('assistant_drafts').getAll()
        const opReq = t.objectStore('assistant_ops').getAll()
        const sReq = t.objectStore('sources').getAll()
        const dReq = t.objectStore('docs').getAll()
        let threads = []
        let drafts = []
        let ops = []
        let sources = []
        let docs = []
        thReq.onsuccess = () => { threads = thReq.result.filter((r) => inWorkspace(r, ctx.ws)) }
        drReq.onsuccess = () => { drafts = drReq.result.filter((r) => inWorkspace(r, ctx.ws)) }
        opReq.onsuccess = () => { ops = opReq.result.filter((r) => inWorkspace(r, ctx.ws)) }
        sReq.onsuccess = () => { sources = sReq.result.filter((r) => inWorkspace(r, ctx.ws)) }
        dReq.onsuccess = () => { docs = dReq.result.filter((r) => inWorkspace(r, ctx.ws)) }
        thReq.onerror = () => reject(thReq.error)
        drReq.onerror = () => reject(drReq.error)
        opReq.onerror = () => reject(opReq.error)
        sReq.onerror = () => reject(sReq.error)
        dReq.onerror = () => reject(dReq.error)
        t.oncomplete = () => resolve({ workspace_id: ctx.ws, threads, drafts, ops, sources, docs })
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

// 助手写入共同原语（5B-1B §6）：单一 readwrite 事务覆盖 assistant_threads + assistant_drafts；
// sources/docs/assistant_ops 纳入同一事务只读供事实核对与刷新结算回执验证（mode 属整个事务，
// 只读 store 由代码约束——本原语绝不写 sources/docs/assistant_ops）。事务内读捕获空间最新
// threads/drafts/ops 与业务事实 → plan({ threads, drafts, ops, docs, sources }, ctx) 返回
// { threadPuts, draftPuts, info } → 计划执行前再查世代 → 写入。任何抛错 abort 整体回滚。
// 并发基线比较与规则判定在 plan 内同步完成（重摘要由服务在事务外预算）；绝不 await 非 IDB 工作。
// 关键不变量：记录形状（id/record_version）、草案 thread_id 必须解析到同空间线程（现有或同批写入）。
export const transformAssistantAtomic = (plan) => {
  const ctx = captureContext()
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (ctx.gen !== generation) {
          reject(workspaceChangedError())
          return
        }
        const t = db.transaction(['assistant_threads', 'assistant_drafts', 'assistant_ops', 'sources', 'docs'], 'readwrite')
        const thStore = t.objectStore('assistant_threads')
        const drStore = t.objectStore('assistant_drafts')
        let applied = { workspace_id: ctx.ws, threadPuts: [], draftPuts: [], info: null }
        const results = {}
        let pending = 5
        const maybePlan = () => {
          pending -= 1
          if (pending > 0) return
          try {
            if (ctx.gen !== generation) throw workspaceChangedError()
            const latest = {
              threads: results.threads.filter((r) => inWorkspace(r, ctx.ws)),
              drafts: results.drafts.filter((r) => inWorkspace(r, ctx.ws)),
              ops: results.ops.filter((r) => inWorkspace(r, ctx.ws)),
              docs: results.docs.filter((r) => inWorkspace(r, ctx.ws)),
              sources: results.sources.filter((r) => inWorkspace(r, ctx.ws)),
            }
            const { threadPuts = [], draftPuts = [], info = null } = plan(latest, ctx) || {}
            const stampAssistant = (rec) => {
              if (!rec || typeof rec.id !== 'string' || !rec.id) throw new Error('助手记录缺少合法 id')
              if (rec.record_version !== 1) throw new Error('助手记录 record_version 必须为 1')
              return stamp(rec, ctx.ws)
            }
            const thStamped = threadPuts.map(stampAssistant)
            const drStamped = draftPuts.map(stampAssistant)
            const threadIds = new Set([...latest.threads.map((r) => r.id), ...thStamped.map((r) => r.id)])
            for (const d of drStamped) {
              if (typeof d.thread_id !== 'string' || !d.thread_id) throw new Error('草案缺少 thread_id')
              if (!threadIds.has(d.thread_id)) throw Object.assign(new Error('草案 thread_id 指向不存在或跨空间的线程'), { code: 'THREAD_REF_INVALID' })
            }
            for (const r of thStamped) thStore.put(r)
            for (const r of drStamped) drStore.put(r)
            applied = { workspace_id: ctx.ws, threadPuts: thStamped, draftPuts: drStamped, info }
          } catch (err) {
            t.abort()
            reject(err)
          }
        }
        for (const [name, store] of [['threads', thStore], ['drafts', drStore], ['ops', t.objectStore('assistant_ops')], ['sources', t.objectStore('sources')], ['docs', t.objectStore('docs')]]) {
          const req = store.getAll()
          req.onsuccess = () => { results[name] = req.result; maybePlan() }
          req.onerror = () => reject(req.error)
        }
        t.oncomplete = () => resolve(applied)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

// 采用提交原语（M1 §9.5 / M3 §7）：单一 readwrite 事务覆盖 assistant_threads/drafts/ops + docs；
// sources 只读供绑定核对。plan(latest, ctx) 返回 { threadPuts, draftPuts, opPuts, docAdds, docCancels, info }。
// 业务对象一律 add()（绝不覆盖）：新 ID 已存在（含其它空间占用）→ 整体拒绝 ID_CONFLICT。
// docCancels 是受限取消（M3）：同空间同任务、预期语义内容逐项全等、仅 state planned→cancelled，
// 其余字段原样保留；任何不符整体 abort。不接受任意 docPuts/字段覆盖。
// 线程/草案过 stampAssistant（id + record_version=1）与 thread_id 解析；ops 过 stamp 归属。
// 任何抛错 abort 整体回滚：业务对象、草案状态、台账要么全部落库要么全不落库。
export const transformAdoptionAtomic = (plan) => {
  const ctx = captureContext()
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (ctx.gen !== generation) {
          reject(workspaceChangedError())
          return
        }
        const t = db.transaction(['assistant_threads', 'assistant_drafts', 'assistant_ops', 'sources', 'docs'], 'readwrite')
        const thStore = t.objectStore('assistant_threads')
        const drStore = t.objectStore('assistant_drafts')
        const opStore = t.objectStore('assistant_ops')
        const docStore = t.objectStore('docs')
        let applied = { workspace_id: ctx.ws, threadPuts: [], draftPuts: [], opPuts: [], docAdds: [], docCancels: [], info: null }
        const results = {}
        let pending = 5
        const maybePlan = () => {
          pending -= 1
          if (pending > 0) return
          try {
            if (ctx.gen !== generation) throw workspaceChangedError()
            const latest = {
              threads: results.threads.filter((r) => inWorkspace(r, ctx.ws)),
              drafts: results.drafts.filter((r) => inWorkspace(r, ctx.ws)),
              ops: results.ops.filter((r) => inWorkspace(r, ctx.ws)),
              docs: results.docs.filter((r) => inWorkspace(r, ctx.ws)),
              sources: results.sources.filter((r) => inWorkspace(r, ctx.ws)),
            }
            const { threadPuts = [], draftPuts = [], opPuts = [], docAdds = [], docCancels = [], info = null } = plan(latest, ctx) || {}
            const stampAssistant = (rec) => {
              if (!rec || typeof rec.id !== 'string' || !rec.id) throw new Error('助手记录缺少合法 id')
              if (rec.record_version !== 1) throw new Error('助手记录 record_version 必须为 1')
              return stamp(rec, ctx.ws)
            }
            const thStamped = threadPuts.map(stampAssistant)
            const drStamped = draftPuts.map(stampAssistant)
            const threadIds = new Set([...latest.threads.map((r) => r.id), ...thStamped.map((r) => r.id)])
            for (const d of drStamped) {
              if (typeof d.thread_id !== 'string' || !d.thread_id) throw new Error('草案缺少 thread_id')
              if (!threadIds.has(d.thread_id)) throw Object.assign(new Error('草案 thread_id 指向不存在或跨空间的线程'), { code: 'THREAD_REF_INVALID' })
            }
            const opStamped = opPuts.map((rec) => {
              if (!rec || typeof rec.application_id !== 'string' || !rec.application_id) throw new Error('采用台账缺少合法 application_id')
              return stamp(rec, ctx.ws)
            })
            // ID 冲突核对用未过滤全量：docs keyPath 全局唯一，其它空间占用同样整体拒绝。
            const allDocIds = new Set(results.docs.map((r) => r.id))
            const docStamped = docAdds.map((rec) => {
              if (!rec || typeof rec.id !== 'string' || !rec.id) throw new Error('业务对象缺少合法 id')
              if (allDocIds.has(rec.id)) throw Object.assign(new Error(`对象标识 ${rec.id} 已存在，采用整体拒绝，绝不覆盖`), { code: 'ID_CONFLICT' })
              allDocIds.add(rec.id)
              return stamp(rec, ctx.ws)
            })
            // 受限取消（M3）：重读活记录，同空间同任务 + 预期语义内容逐项全等 + 仅 planned→cancelled。
            const cancelIds = new Set()
            const cancelStamped = docCancels.map((c) => {
              if (!c || typeof c.plan_item_id !== 'string' || !c.plan_item_id) throw new Error('取消项缺少合法 plan_item_id')
              if (cancelIds.has(c.plan_item_id)) throw new Error(`取消项 ${c.plan_item_id} 重复`)
              cancelIds.add(c.plan_item_id)
              if (c.new_state !== 'cancelled') throw new Error('受限取消只允许 planned→cancelled')
              const rec = results.docs.find((r) => r.id === c.plan_item_id)
              if (!rec) throw Object.assign(new Error(`取消安排 ${c.plan_item_id} 已不存在，整体拒绝`), { code: 'REPLAN_ITEM_MISSING' })
              if (!inWorkspace(rec, ctx.ws)) throw Object.assign(new Error(`取消安排 ${c.plan_item_id} 跨工作空间，整体拒绝`), { code: 'REPLAN_ITEM_OTHER_WORKSPACE' })
              if (rec.kind !== 'plan_item') throw Object.assign(new Error(`取消对象 ${c.plan_item_id} 不是安排记录`), { code: 'REPLAN_ITEM_INVALID' })
              const exp = c.expected
              if (!exp || exp.plan_item_id !== c.plan_item_id) throw new Error('取消项预期快照与 plan_item_id 不一致')
              if (rec.task_id !== exp.task_id) throw Object.assign(new Error(`取消安排 ${c.plan_item_id} 归属任务已变化`), { code: 'REPLAN_TASK_MISMATCH' })
              const cur = {
                plan_item_id: rec.id, task_id: rec.task_id, date: rec.date,
                planned_minutes: rec.planned_minutes, action_text: rec.action_text,
                state: rec.state, order: rec.order ?? 0,
                actual_minutes: rec.actual_minutes ?? null, focus_session_id: rec.focus_session_id ?? null,
                task_ref_state: rec.task_ref_state ?? 'active',
              }
              for (const k of Object.keys(exp)) {
                if (cur[k] !== exp[k]) {
                  throw Object.assign(new Error(`取消安排 ${c.plan_item_id} 的 ${k} 与预期不符，整体拒绝重新核对`), { code: 'REPLACEMENT_CONTENT_CHANGED' })
                }
              }
              return { ...rec, state: 'cancelled' }
            })
            for (const r of thStamped) thStore.put(r)
            for (const r of drStamped) drStore.put(r)
            for (const r of opStamped) opStore.put(r)
            for (const r of docStamped) docStore.add(r)
            for (const r of cancelStamped) docStore.put(r)
            applied = { workspace_id: ctx.ws, threadPuts: thStamped, draftPuts: drStamped, opPuts: opStamped, docAdds: docStamped, docCancels: cancelStamped, info }
          } catch (err) {
            t.abort()
            reject(err)
          }
        }
        for (const [name, store] of [['threads', thStore], ['drafts', drStore], ['ops', opStore], ['sources', t.objectStore('sources')], ['docs', docStore]]) {
          const req = store.getAll()
          req.onsuccess = () => { results[name] = req.result; maybePlan() }
          req.onerror = () => reject(req.error)
        }
        t.oncomplete = () => resolve(applied)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

// 只删捕获空间内的记录：先读后验归属，跨空间 id 拒绝，绝不误删其它空间数据。
export const deleteDoc = async (id) => {
  const ctx = captureContext()
  await open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (ctx.gen !== generation) {
          reject(workspaceChangedError())
          return
        }
        const t = db.transaction('docs', 'readwrite')
        const s = t.objectStore('docs')
        const req = s.get(id)
        req.onsuccess = () => {
          try {
            if (ctx.gen !== generation) throw workspaceChangedError()
            const record = req.result
            if (record && !inWorkspace(record, ctx.ws)) throw new Error('跨工作空间删除被拒绝')
            if (record) s.delete(id)
          } catch (err) {
            t.abort()
            reject(err)
          }
        }
        req.onerror = () => reject(req.error)
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
  return { workspace_id: ctx.ws, id }
}

// 工作区目录（personal/demo 元数据）。目录本身不按当前空间过滤——它列出所有空间，不受切换世代约束。
export const putWorkspace = (ws) => tx('workspaces', 'readwrite', (s) => s.put(snapshot(ws)), null)
export const getWorkspace = (id) => tx('workspaces', 'readonly', (s) => s.get(id), null)
export const allWorkspaces = () => tx('workspaces', 'readonly', (s) => s.getAll(), null)

// 仅清空指定工作区的 sources/docs/focus_runtime 与三个助手 store（demo 重置用），同一事务，
// 绝不触碰其它空间。runtime 一并清：重置不留运行锁/租约/台账。
// assistant_ops 主键是 application_id（无 id 字段），删除键不能用 rec.id。
export const clearWorkspace = (id) =>
  open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const stores = ['sources', 'docs', 'focus_runtime', 'assistant_threads', 'assistant_drafts', 'assistant_ops']
        const t = db.transaction(stores, 'readwrite')
        try {
          for (const name of stores) {
            const store = t.objectStore(name)
            const keyPath = name === 'assistant_ops' ? 'application_id' : 'id'
            const req = store.getAll()
            req.onsuccess = () => {
              for (const rec of req.result) {
                if (rec && rec.workspace_id === id) store.delete(rec[keyPath])
              }
            }
          }
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

// 4-2 §6 / 5B-1B §9.4：备份恢复原子提交。单一 readwrite 事务覆盖
// workspaces/sources/docs/focus_runtime/assistant_threads/assistant_drafts 六 store。
// 显式目标空间（prepared.targetWorkspaceId），绝不依赖全局 configureWorkspace、绝不临时切空间。
// 解码/哈希/Blob 创建/ID 重建/记录复检全部在事务外完成（backup/import.js prepareRestore）；事务内
// 只做 IDB 读写与同步校验，绝不 await 非 IDB 工作。写入一律 add（非覆盖）：任何冲突/失败/配额 →
// 整体 abort，六 store 零残留，原库逐字段不变。assistant_ops 不导入、不根据 applied_summary 重建。
// 目录记录附最小本地恢复回执（目录元数据，非业务契约、
// 不进导出、不是用户运行台账）。幂等绑定：operation_id + 目标 + 原始 ZIP 字节 SHA-256 + backup_id +
// 目标名 + 冻结 ID 映射签名 + 助手计数（旧 v1 回执缺字段按 0 解释，不改写旧回执）。
// 同意图已提交 → 返回原恢复空间不重写；绑定不符 → 拒绝；目录被其它意图
// 占用 → 拒绝。绝不「冲突后自动换新 ID 继续」。
export const commitRestore = async (prepared) => {
  // R9：恢复写入口同样在事务外按真实字节计算内容版本（不在活事务内等待哈希），事务内只同步落库。
  const sources = await Promise.all((prepared?.sources ?? []).map(async (s) => ({ ...s, content_version: await sourceContentVersion(s) })))
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const targetId = prepared && prepared.targetWorkspaceId
        const settle = (code, message, extra) =>
          reject(Object.assign(new Error(message), { code }, extra || {}))
        if (!targetId || targetId === 'personal' || targetId === 'demo') {
          settle('RESTORE_BAD_TARGET', '恢复目标不能是个人空间或演示空间')
          return
        }
        const t = db.transaction(
          ['workspaces', 'sources', 'docs', 'focus_runtime', 'assistant_threads', 'assistant_drafts'],
          'readwrite',
        )
        const wStore = t.objectStore('workspaces')
        const sStore = t.objectStore('sources')
        const dStore = t.objectStore('docs')
        const rStore = t.objectStore('focus_runtime')
        const thStore = t.objectStore('assistant_threads')
        const drStore = t.objectStore('assistant_drafts')
        let outcome = null
        let settled = false
        const abort = (code, message, extra) => {
          if (settled) return
          settled = true
          try { t.abort() } catch { /* 事务可能已结束 */ }
          settle(code, message, extra)
        }
        const writeErr = (req, label) => {
          const e = req.error
          const code = e && e.name === 'QuotaExceededError' ? 'RESTORE_QUOTA' : 'RESTORE_WRITE_FAILED'
          abort(code, `${label}失败：${(e && e.message) || e}`, { cause: e })
        }
        const wReq = wStore.get(targetId)
        const sReq = sStore.getAll()
        const dReq = dStore.getAll()
        const rReq = rStore.getAll()
        const thReq = thStore.getAll()
        const drReq = drStore.getAll()
        let pending = 6
        const maybeCommit = () => {
          pending -= 1
          if (pending > 0 || settled) return
          try {
            const existingWs = wReq.result
            // 目录已存在：同意图幂等返回，或拒绝（绑定不符 / 被其它意图占用）。
            if (existingWs) {
              const receipt = existingWs.restore_receipt
              if (receipt && receipt.operation_id === prepared.operationId) {
                const sameBinding =
                  receipt.source_file_hash === prepared.fingerprint &&
                  receipt.backup_id === prepared.backupId &&
                  receipt.target_name === prepared.targetName &&
                  receipt.id_map_signature === prepared.idMapSignature &&
                  (receipt.assistant_thread_count ?? 0) === (prepared.assistantThreadCount ?? 0) &&
                  (receipt.assistant_draft_count ?? 0) === (prepared.assistantDraftCount ?? 0)
                if (sameBinding) {
                  outcome = { alreadyCommitted: true, workspaceId: targetId, workspace: existingWs, receipt }
                  return
                }
                abort('RESTORE_INTENT_MISMATCH', '同一恢复作业绑定了不同的文件/目标/名称或 ID 映射，已拒绝')
                return
              }
              abort('RESTORE_TARGET_OCCUPIED', `目标空间 ${targetId} 已存在，恢复不覆盖既有空间`)
              return
            }
            // 目录未占用：校验全部 prepared 记录归属目标，且新 ID（活+历史）不与现有对象冲突。
            const existingSourceIds = new Set(sReq.result.map((r) => r.id))
            const existingDocIds = new Set(dReq.result.map((r) => r.id))
            const existingRuntimeIds = new Set(rReq.result.map((r) => r.id))
            const existingThreadIds = new Set(thReq.result.map((r) => r.id))
            const existingDraftIds = new Set(drReq.result.map((r) => r.id))
            const newIds = new Set([...prepared.liveMap.values(), ...prepared.historyMap.values()])
            for (const id of newIds) {
              if (existingDocIds.has(id) || existingSourceIds.has(id) || existingThreadIds.has(id) || existingDraftIds.has(id)) {
                abort('RESTORE_ID_CONFLICT', `恢复新标识 ${id} 与现有对象冲突，已整体回滚`)
                return
              }
            }
            for (const s of sources) {
              if (s.workspace_id !== targetId) { abort('RESTORE_BAD_RECORD', '恢复资料归属与目标空间不符'); return }
              if (existingSourceIds.has(s.id)) { abort('RESTORE_ID_CONFLICT', `资料标识 ${s.id} 已存在，已整体回滚`); return }
            }
            for (const d of prepared.docs) {
              if (d.workspace_id !== targetId) { abort('RESTORE_BAD_RECORD', '恢复记录归属与目标空间不符'); return }
              if (existingDocIds.has(d.id)) { abort('RESTORE_ID_CONFLICT', `记录标识 ${d.id} 已存在，已整体回滚`); return }
            }
            for (const r of prepared.runtimePuts) {
              if (r.workspace_id !== targetId) { abort('RESTORE_BAD_RECORD', '恢复协调数据归属与目标空间不符'); return }
              if (existingRuntimeIds.has(r.id)) { abort('RESTORE_ID_CONFLICT', `协调标识 ${r.id} 已存在，已整体回滚`); return }
            }
            const preparedThreads = prepared.assistantThreads || []
            const preparedDrafts = prepared.assistantDrafts || []
            for (const th of preparedThreads) {
              if (th.workspace_id !== targetId) { abort('RESTORE_BAD_RECORD', '恢复助手线程归属与目标空间不符'); return }
              if (existingThreadIds.has(th.id)) { abort('RESTORE_ID_CONFLICT', `助手线程标识 ${th.id} 已存在，已整体回滚`); return }
            }
            for (const dr of preparedDrafts) {
              if (dr.workspace_id !== targetId) { abort('RESTORE_BAD_RECORD', '恢复助手草案归属与目标空间不符'); return }
              if (existingDraftIds.has(dr.id)) { abort('RESTORE_ID_CONFLICT', `助手草案标识 ${dr.id} 已存在，已整体回滚`); return }
            }
            const receipt = {
              operation_id: prepared.operationId,
              source_file_hash: prepared.fingerprint,
              backup_id: prepared.backupId,
              target_name: prepared.targetName,
              id_map_signature: prepared.idMapSignature,
              committed_at: new Date().toISOString(),
              counts: prepared.counts,
              source_count: prepared.sourceCount,
              image_count: prepared.imageCount,
              assistant_thread_count: preparedThreads.length,
              assistant_draft_count: preparedDrafts.length,
            }
            const wsRecord = { ...snapshot(prepared.targetWorkspace), id: targetId, restore_receipt: receipt }
            // add 非覆盖：目录已确认未占用；sources/docs/runtime 用 add，冲突即整体 abort。
            const wAdd = wStore.add(wsRecord)
            wAdd.onerror = () => writeErr(wAdd, '写入工作区目录')
            for (const s of sources) {
              const req = sStore.add(snapshot(s))
              req.onerror = () => writeErr(req, `写入资料 ${s.id}`)
            }
            for (const d of prepared.docs) {
              const req = dStore.add(snapshot(d))
              req.onerror = () => writeErr(req, `写入记录 ${d.id}`)
            }
            for (const r of prepared.runtimePuts) {
              const req = rStore.add(snapshot(r))
              req.onerror = () => writeErr(req, `写入协调数据 ${r.id}`)
            }
            for (const th of preparedThreads) {
              const req = thStore.add(snapshot(th))
              req.onerror = () => writeErr(req, `写入助手线程 ${th.id}`)
            }
            for (const dr of preparedDrafts) {
              const req = drStore.add(snapshot(dr))
              req.onerror = () => writeErr(req, `写入助手草案 ${dr.id}`)
            }
            outcome = { alreadyCommitted: false, workspaceId: targetId, workspace: wsRecord, receipt }
          } catch (err) {
            const code = err && err.name === 'QuotaExceededError' ? 'RESTORE_QUOTA' : 'RESTORE_WRITE_FAILED'
            abort(code, `恢复提交异常：${err.message}`, { cause: err })
          }
        }
        wReq.onsuccess = maybeCommit
        sReq.onsuccess = maybeCommit
        dReq.onsuccess = maybeCommit
        rReq.onsuccess = maybeCommit
        thReq.onsuccess = maybeCommit
        drReq.onsuccess = maybeCommit
        wReq.onerror = () => abort('RESTORE_READ_FAILED', '读取工作区目录失败', { cause: wReq.error })
        sReq.onerror = () => abort('RESTORE_READ_FAILED', '读取资料失败', { cause: sReq.error })
        dReq.onerror = () => abort('RESTORE_READ_FAILED', '读取记录失败', { cause: dReq.error })
        rReq.onerror = () => abort('RESTORE_READ_FAILED', '读取协调数据失败', { cause: rReq.error })
        thReq.onerror = () => abort('RESTORE_READ_FAILED', '读取助手线程失败', { cause: thReq.error })
        drReq.onerror = () => abort('RESTORE_READ_FAILED', '读取助手草案失败', { cause: drReq.error })
        t.oncomplete = () => { if (!settled) { settled = true; resolve(outcome) } }
        t.onerror = () => { if (!settled) { settled = true; reject(t.error) } }
        t.onabort = () => { if (!settled) { settled = true; reject(t.error) } }
      }),
  )
}

// 迟到回调/刷新后按恢复作业标识查目录回执（§6：tx 已提交但 UI 回调失败 → 先查回执，不盲目重导）。
// 只读目录，命中返回 { workspaceId, workspace, receipt }，否则 null。不触发任何写入。
export const findRestoreByOperation = (operationId) =>
  open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction('workspaces', 'readonly')
        const req = t.objectStore('workspaces').getAll()
        req.onsuccess = () => {
          const hit = (req.result || []).find(
            (w) => w && w.restore_receipt && w.restore_receipt.operation_id === operationId,
          )
          resolve(hit ? { workspaceId: hit.id, workspace: hit, receipt: hit.restore_receipt } : null)
        }
        req.onerror = () => reject(req.error)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
