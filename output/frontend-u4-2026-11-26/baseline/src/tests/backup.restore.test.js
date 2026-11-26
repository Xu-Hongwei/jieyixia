// 4-2 R2 原子恢复事务 + 目录回执 + 幂等验收（开工单 §6 / R12 / R13）。
// 每个用例全新 IDBFactory + 全新 db 模块实例（dbPromise 未缓存），故障窗口可精确控制。
// 核心标准：恢复内容完整可用，原空间（及其它空间）逐字段 + 原图字节完全不变；失败四 store 零残留。
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { packArchive } from '@/services/backup/zip'
import { inspectBackupFile, prepareRestore } from '@/services/backup/import'
import { sha256Hex } from '@/services/backup/format'
import { runId, opsId, sessId } from '@/services/focus/runtime'
import { buildCompleteBackup, PNG_BYTES } from './backupFixtures'

let db
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  db = await import('@/services/storage/db')
})

const fileOf = (bytes, name = '虚构备份.zip') => new File([bytes], name, { type: 'application/zip' })
const codeOf = async (p) => { try { await p; return null } catch (e) { return e.code } }

// 由真实导出 ZIP 走完整检查→准备链，产出冻结 prepared（确定性 newId，便于冲突注入）。
// idPrefix 区分不同恢复意图的 ID 命名空间（生产用 crypto.randomUUID，天然全局唯一）。
async function preparedFor(target = 'ws-restore-1', op = 'op-1', overrides = {}, idPrefix = 'new') {
  const { entries } = await buildCompleteBackup()
  const zip = packArchive(entries)
  const ins = await inspectBackupFile(fileOf(zip))
  let c = 0
  const prep = prepareRestore({
    inspected: ins, targetWorkspaceId: target, targetName: '恢复空间', operationId: op,
    nowMs: 1_800_000_000_000, createdAt: '2026-11-22T16:00:00+08:00', newId: () => `${idPrefix}-${++c}`, ...overrides,
  })
  return { prep, ins, zip }
}

// 预置一个原空间（文本+图片+便签），返回独立 oracle：逐字段快照 + 原图字节摘要。
async function seedOriginal() {
  db.configureWorkspace('ws-original')
  await db.putWorkspace({ id: 'ws-original', name: '原空间', is_demo: false })
  await db.putSource({ id: 'orig-txt', kind: 'text', text: '原空间文本资料' })
  await db.putSource({ id: 'orig-img', kind: 'image', name: '原图.png', blob: new Blob([PNG_BYTES], { type: 'image/png' }) })
  await db.putDoc({ id: 'orig-note', kind: 'note', title: '原便签', status: 'draft', fields: [], warnings: [] })
  const sources = (await db.allSources()).records
  const docs = (await db.allDocs()).records
  const img = (await db.getSource('orig-img')).record
  const imgDigest = await sha256Hex(new Uint8Array(await img.blob.arrayBuffer()))
  return { sources, docs, imgDigest }
}

async function readOriginal() {
  db.configureWorkspace('ws-original')
  const sources = (await db.allSources()).records
  const docs = (await db.allDocs()).records
  const img = (await db.getSource('orig-img')).record
  const imgDigest = await sha256Hex(new Uint8Array(await img.blob.arrayBuffer()))
  return { sources, docs, imgDigest }
}

// 只扣住「第一个 readwrite 事务」的 oncomplete（即恢复提交），后续只读事务不受影响。
// 用于确定性定位「事务已提交、成功回调尚未执行（UI 失败/迟到）」窗口。
function gateFirstComplete() {
  const origTx = IDBDatabase.prototype.transaction
  let release
  let signalCommitted
  let gated = false
  const gate = new Promise((r) => { release = r })
  const committed = new Promise((r) => { signalCommitted = r })
  IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
    const t = origTx.call(this, stores, mode, ...rest)
    if (mode === 'readwrite' && !gated) {
      gated = true
      let handler = null
      Object.defineProperty(t, 'oncomplete', {
        configurable: true,
        get: () => handler,
        set: (fn) => { handler = (...a) => { signalCommitted(); gate.then(() => fn(...a)) } },
      })
    }
    return t
  }
  return { committed, release: () => release(), restore: () => { IDBDatabase.prototype.transaction = origTx } }
}

// 注入指定 store 的 add 同步抛错（沿用既有 put 注入手法）；errName 可模拟 QuotaExceededError。
function injectAddFailure(storeName, errName = 'Error') {
  const origAdd = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, ...rest) {
    if (this.name === storeName) {
      const e = new Error(`注入 ${storeName} 写入失败`)
      e.name = errName
      throw e
    }
    return origAdd.call(this, value, ...rest)
  }
  return () => { IDBObjectStore.prototype.add = origAdd }
}

async function targetResidue(target) {
  db.configureWorkspace(target)
  const sources = (await db.allSources()).records
  const docs = (await db.allDocs()).records
  const runtime = (await db.allFocusRuntime()).records.filter((r) => r.workspace_id === target)
  const ws = await db.getWorkspace(target)
  return { sources, docs, runtime, ws }
}

describe('4-2 R2 首次提交：四 store 原子写入 + 目录回执', () => {
  it('新空间数据完整、回执齐全、图片字节与已校验资产一致', async () => {
    const { prep } = await preparedFor()
    const result = await db.commitRestore(prep)
    expect(result.alreadyCommitted).toBe(false)
    expect(result.workspaceId).toBe(prep.targetWorkspaceId)

    const ws = await db.getWorkspace(prep.targetWorkspaceId)
    expect(ws.name).toBe('恢复空间')
    expect(ws.is_demo).toBe(false)
    const receipt = ws.restore_receipt
    expect(receipt.operation_id).toBe(prep.operationId)
    expect(receipt.source_file_hash).toBe(prep.fingerprint)
    expect(receipt.backup_id).toBe(prep.backupId)
    expect(receipt.target_name).toBe('恢复空间')
    expect(receipt.id_map_signature).toBe(prep.idMapSignature)
    expect(receipt.counts).toEqual(prep.counts)
    expect(typeof receipt.committed_at).toBe('string')

    db.configureWorkspace(prep.targetWorkspaceId)
    const sources = (await db.allSources()).records
    const docs = (await db.allDocs()).records
    expect(sources).toHaveLength(prep.sourceCount)
    expect(docs).toHaveLength(prep.docs.length)
    const runtime = (await db.allFocusRuntime()).records.filter((r) => r.workspace_id === prep.targetWorkspaceId)
    expect(runtime.some((r) => r.id === runId(prep.targetWorkspaceId))).toBe(true)
    expect(runtime.some((r) => r.id === opsId(prep.targetWorkspaceId))).toBe(true)
    const pausedId = prep.liveMap.get('focus-paused')
    expect(runtime.some((r) => r.id === sessId(pausedId))).toBe(true)

    const imgId = prep.liveMap.get('src-img')
    const img = (await db.getSource(imgId)).record
    expect(img.asset_path).toBeUndefined()
    expect(new Uint8Array(await img.blob.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('恢复后原空间逐字段 + 原图字节完全不变（独立 oracle）', async () => {
    const oracle = await seedOriginal()
    const { prep } = await preparedFor()
    await db.commitRestore(prep)
    const after = await readOriginal()
    expect(after.sources).toEqual(oracle.sources)
    expect(after.docs).toEqual(oracle.docs)
    expect(after.imgDigest).toBe(oracle.imgDigest)
    // 目录里原空间记录不变，且只新增一个恢复空间。
    const all = await db.allWorkspaces()
    expect(all.find((w) => w.id === 'ws-original').name).toBe('原空间')
    expect(all.filter((w) => w.restore_receipt)).toHaveLength(1)
  })
})

describe('4-2 R2 幂等：同意图只恢复一份（R12）', () => {
  it('同意图重试：alreadyCommitted=true，返回原空间不重写，目录仍一份', async () => {
    const { prep } = await preparedFor()
    const first = await db.commitRestore(prep)
    const second = await db.commitRestore(prep)
    expect(first.alreadyCommitted).toBe(false)
    expect(second.alreadyCommitted).toBe(true)
    expect(second.workspaceId).toBe(first.workspaceId)
    expect(second.receipt.committed_at).toBe(first.receipt.committed_at)
    const dirs = (await db.allWorkspaces()).filter((w) => w.id === prep.targetWorkspaceId)
    expect(dirs).toHaveLength(1)
    const residue = await targetResidue(prep.targetWorkspaceId)
    expect(residue.docs).toHaveLength(prep.docs.length)
    expect(residue.sources).toHaveLength(prep.sourceCount)
  })

  it('双击并发：两个相同 prepared 同时提交 → 恰好一份完整数据', async () => {
    const { prep } = await preparedFor()
    const [a, b] = await Promise.all([db.commitRestore(prep), db.commitRestore(prep)])
    expect([a.alreadyCommitted, b.alreadyCommitted].sort()).toEqual([false, true])
    expect((await db.allWorkspaces()).filter((w) => w.id === prep.targetWorkspaceId)).toHaveLength(1)
    const residue = await targetResidue(prep.targetWorkspaceId)
    expect(residue.docs).toHaveLength(prep.docs.length)
  })

  it('tx 已提交、成功回调被扣住（UI 失败窗口）：先查回执返原空间，重试幂等不重写', async () => {
    const { prep } = await preparedFor()
    const gate = gateFirstComplete()
    const pending = db.commitRestore(prep)
    await gate.committed // 事务确已提交，oncomplete 回调被扣住（模拟 UI 回调失败/迟到）
    // 此刻界面尚未拿到结果：控制器应先查回执，而非盲目重导。
    const found = await db.findRestoreByOperation(prep.operationId)
    expect(found).toBeTruthy()
    expect(found.workspaceId).toBe(prep.targetWorkspaceId)
    expect(found.receipt.source_file_hash).toBe(prep.fingerprint)
    gate.release()
    const result = await pending
    gate.restore()
    expect(result.alreadyCommitted).toBe(false)
    // 用户重试同意图 → 幂等返回原空间，绝不二次写入。
    const retry = await db.commitRestore(prep)
    expect(retry.alreadyCommitted).toBe(true)
    expect((await db.allWorkspaces()).filter((w) => w.id === prep.targetWorkspaceId)).toHaveLength(1)
  })

  it('刷新后按作业标识可查到已提交空间；未提交作业查不到（零残留）', async () => {
    const { prep } = await preparedFor()
    expect(await db.findRestoreByOperation(prep.operationId)).toBeNull()
    await db.commitRestore(prep)
    const found = await db.findRestoreByOperation(prep.operationId)
    expect(found.workspaceId).toBe(prep.targetWorkspaceId)
    expect(await db.findRestoreByOperation('op-never')).toBeNull()
  })

  it('同 op 但绑定不符（文件哈希不同）→ RESTORE_INTENT_MISMATCH，原提交不变', async () => {
    const { prep } = await preparedFor()
    await db.commitRestore(prep)
    const tampered = { ...prep, fingerprint: 'f'.repeat(64) }
    expect(await codeOf(db.commitRestore(tampered))).toBe('RESTORE_INTENT_MISMATCH')
    const found = await db.findRestoreByOperation(prep.operationId)
    expect(found.receipt.source_file_hash).toBe(prep.fingerprint)
  })

  it('同 op 但冻结 ID 映射签名不同 → RESTORE_INTENT_MISMATCH', async () => {
    const { prep } = await preparedFor()
    await db.commitRestore(prep)
    const tampered = { ...prep, idMapSignature: '{"live":[],"history":[]}' }
    expect(await codeOf(db.commitRestore(tampered))).toBe('RESTORE_INTENT_MISMATCH')
  })

  it('目录被其它意图占用 → RESTORE_TARGET_OCCUPIED，不覆盖既有空间', async () => {
    const { prep } = await preparedFor('ws-restore-1', 'op-1')
    await db.commitRestore(prep)
    const { prep: other } = await preparedFor('ws-restore-1', 'op-2')
    expect(await codeOf(db.commitRestore(other))).toBe('RESTORE_TARGET_OCCUPIED')
    const found = await db.findRestoreByOperation('op-1')
    expect(found.workspaceId).toBe('ws-restore-1')
    expect(await db.findRestoreByOperation('op-2')).toBeNull()
  })

  it('用户「再恢复一份」：新意图 + 新目标 → 两个独立空间互不影响', async () => {
    const { prep: a } = await preparedFor('ws-restore-A', 'op-A', {}, 'a')
    const { prep: b } = await preparedFor('ws-restore-B', 'op-B', {}, 'b')
    await db.commitRestore(a)
    await db.commitRestore(b)
    const dirs = (await db.allWorkspaces()).filter((w) => w.restore_receipt)
    expect(dirs.map((w) => w.id).sort()).toEqual(['ws-restore-A', 'ws-restore-B'])
    expect((await targetResidue('ws-restore-A')).docs).toHaveLength(a.docs.length)
    expect((await targetResidue('ws-restore-B')).docs).toHaveLength(b.docs.length)
  })
})

describe('4-2 R2 失败整体回滚：四 store 零残留，原库不变（R13）', () => {
  it('第一个 store（workspaces）写入失败 → 零残留，原空间不变', async () => {
    const oracle = await seedOriginal()
    const { prep } = await preparedFor()
    const restore = injectAddFailure('workspaces')
    let code
    try { code = await codeOf(db.commitRestore(prep)) } finally { restore() }
    expect(code).toBe('RESTORE_WRITE_FAILED')
    const residue = await targetResidue(prep.targetWorkspaceId)
    expect(residue.ws).toBeUndefined()
    expect(residue.sources).toHaveLength(0)
    expect(residue.docs).toHaveLength(0)
    expect(residue.runtime).toHaveLength(0)
    expect(await readOriginal()).toEqual(oracle)
  })

  it('最后一个 store（focus_runtime）写入失败 → 已写的 sources/docs 一并撤销', async () => {
    const oracle = await seedOriginal()
    const { prep } = await preparedFor()
    const restore = injectAddFailure('focus_runtime')
    let code
    try { code = await codeOf(db.commitRestore(prep)) } finally { restore() }
    expect(code).toBe('RESTORE_WRITE_FAILED')
    const residue = await targetResidue(prep.targetWorkspaceId)
    expect(residue.ws).toBeUndefined()
    expect(residue.sources).toHaveLength(0)
    expect(residue.docs).toHaveLength(0)
    expect(residue.runtime).toHaveLength(0)
    expect(await readOriginal()).toEqual(oracle)
  })

  it('中间 store（docs）配额超限 QuotaExceededError → RESTORE_QUOTA，整体回滚', async () => {
    const oracle = await seedOriginal()
    const { prep } = await preparedFor()
    const restore = injectAddFailure('docs', 'QuotaExceededError')
    let code
    try { code = await codeOf(db.commitRestore(prep)) } finally { restore() }
    expect(code).toBe('RESTORE_QUOTA')
    const residue = await targetResidue(prep.targetWorkspaceId)
    expect(residue.ws).toBeUndefined()
    expect(residue.sources).toHaveLength(0)
    expect(residue.docs).toHaveLength(0)
    expect(residue.runtime).toHaveLength(0)
    expect(await readOriginal()).toEqual(oracle)
  })

  it('新记录 ID 与现有对象冲突（含其它空间）→ RESTORE_ID_CONFLICT，整体回滚', async () => {
    const oracle = await seedOriginal()
    const { prep } = await preparedFor()
    // 确定性 newId 的首个活对象 ID 为 new-1；在原空间预置同 ID 对象触发全库冲突检查。
    const firstNewId = [...prep.liveMap.values()][0]
    db.configureWorkspace('ws-original')
    await db.putDoc({ id: firstNewId, kind: 'note', title: '占位冲突', status: 'draft', fields: [], warnings: [] })
    const before = await readOriginal()
    expect(await codeOf(db.commitRestore(prep))).toBe('RESTORE_ID_CONFLICT')
    const residue = await targetResidue(prep.targetWorkspaceId)
    expect(residue.ws).toBeUndefined()
    expect(residue.sources).toHaveLength(0)
    expect(residue.docs).toHaveLength(0)
    expect(residue.runtime).toHaveLength(0)
    expect(await readOriginal()).toEqual(before)
    expect(before.docs.some((d) => d.id === firstNewId)).toBe(true)
    expect(oracle.imgDigest).toBe(before.imgDigest)
  })

  it('prepared 记录归属与目标不符 → RESTORE_BAD_RECORD，整体回滚', async () => {
    const { prep } = await preparedFor()
    const bad = { ...prep, docs: prep.docs.map((d, i) => (i === 0 ? { ...d, workspace_id: 'other-ws' } : d)) }
    expect(await codeOf(db.commitRestore(bad))).toBe('RESTORE_BAD_RECORD')
    const residue = await targetResidue(prep.targetWorkspaceId)
    expect(residue.ws).toBeUndefined()
    expect(residue.docs).toHaveLength(0)
  })

  it('目标为 personal/demo → RESTORE_BAD_TARGET，零写入（commitRestore 独立守卫）', async () => {
    const { prep } = await preparedFor()
    for (const badTarget of ['personal', 'demo']) {
      const bad = { ...prep, targetWorkspaceId: badTarget }
      expect(await codeOf(db.commitRestore(bad))).toBe('RESTORE_BAD_TARGET')
      expect(await db.getWorkspace(badTarget)).toBeUndefined()
    }
  })

  it('失败后同意图可干净重试：修复故障后提交成功且只一份', async () => {
    const { prep } = await preparedFor()
    const restore = injectAddFailure('docs')
    try { expect(await codeOf(db.commitRestore(prep))).toBe('RESTORE_WRITE_FAILED') } finally { restore() }
    expect((await targetResidue(prep.targetWorkspaceId)).ws).toBeUndefined()
    const ok = await db.commitRestore(prep)
    expect(ok.alreadyCommitted).toBe(false)
    const again = await db.commitRestore(prep)
    expect(again.alreadyCommitted).toBe(true)
    expect((await db.allWorkspaces()).filter((w) => w.id === prep.targetWorkspaceId)).toHaveLength(1)
  })
})

describe('R9 内容版本与备份/恢复适配（本地字段，不进备份 schema，恢复写入口重算）', () => {
  it('commitRestore 事务外按真实字节重算 content_version：图片=PNG 摘要、文字=UTF-8 摘要', async () => {
    const { prep } = await preparedFor()
    await db.commitRestore(prep)
    db.configureWorkspace(prep.targetWorkspaceId)
    const img = (await db.getSource(prep.liveMap.get('src-img'))).record
    const txt = (await db.getSource(prep.liveMap.get('src-txt'))).record
    expect(img.content_version).toBe(await sha256Hex(PNG_BYTES))
    expect(txt.content_version).toBe(await sha256Hex(new TextEncoder().encode(txt.text)))
    // 非元数据派生：同长度全零字节版本不同，证明按真实内容而非尺寸。
    expect(img.content_version).not.toBe(await sha256Hex(new Uint8Array(PNG_BYTES.length)))
  })

  it('备份业务核心与导出记录均不含 content_version（导出删除，恢复重算，不改备份 schema）', async () => {
    const { businessCoreOfSource, sourceToBackup } = await import('@/services/backup/adapt')
    const local = { id: 's-1', workspace_id: 'w', kind: 'image', name: '虚构.png', captured_at: '2026-11-20T09:00:00+08:00', blob: new Blob([PNG_BYTES], { type: 'image/png' }), content_version: '本地版本不应外泄' }
    expect(businessCoreOfSource(local).content_version).toBeUndefined()
    const { record, asset } = await sourceToBackup(local)
    expect(record.content_version).toBeUndefined()
    expect(record.blob).toBeUndefined()
    expect(record.asset_path).toBe('assets/s-1.png')
    expect(asset.bytes).toEqual(PNG_BYTES)
  })
})