// 4-2 R3a 验收：store 目录接入（ensureWorkspace 限定/switchWorkspace 校验/init 回退/目录刷新/空间分类）
// + 恢复作业控制器（选择→检查→预览→确认→提交→完成；取消/换文件/双击/失败重试/资源释放/零写入零切空间）。
// 每个用例全新 IDBFactory + 全新模块实例 + 全新 pinia，互不污染。
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { packArchive } from '@/services/backup/zip'
import { buildCompleteBackup } from './backupFixtures'

let db, store, restore
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  vi.resetModules()
  setActivePinia(createPinia())
  db = await import('@/services/storage/db')
  store = (await import('@/stores/app')).useAppStore()
  restore = await import('@/services/backup/restore')
})

const fileOf = (bytes, name = '虚构备份.zip') => new File([bytes], name, { type: 'application/zip' })
async function backupFile(name = '虚构备份.zip') {
  const { entries } = await buildCompleteBackup()
  return fileOf(packArchive(entries), name)
}
async function invalidFile() {
  const { entries } = await buildCompleteBackup()
  const src = entries.find((e) => e.path === 'data/sources.json')
  const b = src.bytes.slice(); b[b.length - 2] ^= 0xff
  const bad = entries.map((e) => (e.path === 'data/sources.json' ? { path: e.path, bytes: b } : e))
  return fileOf(packArchive(bad))
}
const job = () => restore.restoreJob

describe('4-2 R3a store 目录接入（§7）', () => {
  it('switchWorkspace 到不存在的恢复 ID：报告不存在，绝不自动建「个人空间」壳', async () => {
    await store.init()
    const before = store.workspaceId
    const r = await store.switchWorkspace('ws-nonexistent')
    expect(r).toMatchObject({ ok: false, notFound: true })
    expect(store.workspaceId).toBe(before)
    expect(await db.getWorkspace('ws-nonexistent')).toBeUndefined()
    expect(store.banner.msg).toContain('不存在')
  })

  it('init：持久化当前空间已不在目录 → 解释并回到个人空间，不静默建壳', async () => {
    store.workspaceId = 'ws-gone'
    await store.init()
    expect(store.workspaceId).toBe('personal')
    expect(store.banner.msg).toContain('已不存在')
    expect(await db.getWorkspace('ws-gone')).toBeUndefined()
  })

  it('refreshWorkspaces：恢复成功后重读目录，新空间无需重启即可见', async () => {
    await store.init()
    expect(store.workspaces.some((w) => w.id === 'ws-r')).toBe(false)
    const file = await backupFile()
    await restore.selectBackupFile(file)
    const r = await restore.confirmRestore()
    expect(r.ok).toBe(true)
    // 控制器不主动改 store 目录；显式刷新后可见。
    expect(store.workspaces.some((w) => w.id === r.result.workspaceId)).toBe(false)
    await store.refreshWorkspaces()
    expect(store.workspaces.some((w) => w.id === r.result.workspaceId)).toBe(true)
  })

  it('切换到已存在恢复空间成功，workspaceKind=restore，名称取自目录', async () => {
    await store.init()
    const file = await backupFile()
    await restore.selectBackupFile(file)
    restore.setRestoreName('我的恢复空间')
    const r = await restore.confirmRestore()
    await store.refreshWorkspaces()
    const sw = await store.switchWorkspace(r.result.workspaceId)
    expect(sw).toBeUndefined() // 成功无错误返回
    expect(store.workspaceId).toBe(r.result.workspaceId)
    expect(store.currentWorkspace.name).toBe('我的恢复空间')
    expect(store.isRestore).toBe(true)
    expect(store.isDemo).toBe(false)
    expect(store.workspaceKind).toBe('restore')
  })

  it('workspaceKind 区分个人/演示/恢复', async () => {
    await store.init()
    expect(store.workspaceKind).toBe('personal')
    await store.switchWorkspace('demo')
    expect(store.workspaceKind).toBe('demo')
    expect(store.isDemo).toBe(true)
  })
})

describe('4-2 R3a 恢复控制器：检查/预览/取消（零写入零目录零切空间）', () => {
  it('选择→检查→预览：摘要齐全，零业务写入、零目录', async () => {
    const r = await restore.selectBackupFile(await backupFile())
    expect(r.ok).toBe(true)
    expect(job().phase).toBe('preview')
    expect(job().preview.defaultName).toContain('恢复')
    expect(job().preview.counts.focus_session).toBe(4)
    expect(job().targetName).toBe(job().preview.defaultName)
    expect(await db.allWorkspaces()).toHaveLength(0)
    db.configureWorkspace('personal')
    expect((await db.allDocs()).records).toHaveLength(0)
    expect((await db.allSources()).records).toHaveLength(0)
  })

  it('取消检查：phase 回 idle，零写入零目录', async () => {
    const p = restore.selectBackupFile(await backupFile())
    restore.cancelInspection()
    const r = await p
    expect(r.cancelled).toBe(true)
    expect(job().phase).toBe('idle')
    expect(await db.allWorkspaces()).toHaveLength(0)
  })

  it('第二个文件递增作业号并取消旧解析：旧结果晚到不复现', async () => {
    const f1 = await backupFile('旧.zip')
    const f2 = await backupFile('新.zip')
    const p1 = restore.selectBackupFile(f1)
    const p2 = restore.selectBackupFile(f2)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.stale || r1.cancelled).toBe(true)
    expect(r2.ok).toBe(true)
    expect(job().jobId).toBe(2)
    expect(job().phase).toBe('preview')
    expect(job().filename).toBe('新.zip')
  })

  it('非法备份：列阻断原因，phase=error，零写入，确认被拒', async () => {
    const r = await restore.selectBackupFile(await invalidFile())
    expect(r.ok).toBe(false)
    expect(job().phase).toBe('error')
    expect(job().errors.length).toBeGreaterThan(0)
    expect(await db.allWorkspaces()).toHaveLength(0)
    const c = await restore.confirmRestore()
    expect(c.ok).toBe(false)
    expect(await db.allWorkspaces()).toHaveLength(0)
  })

  it('setRestoreName 仅预览阶段有效', async () => {
    expect(restore.setRestoreName('x').ok).toBe(false) // idle
    await restore.selectBackupFile(await backupFile())
    expect(restore.setRestoreName('  自定义名  ').ok).toBe(true)
    expect(job().targetName).toBe('  自定义名  ')
  })
})

describe('4-2 R3a 恢复控制器：确认/提交/完成/重试', () => {
  it('确认恢复：冻结意图→单事务提交→done，核对通过，不切全局空间', async () => {
    db.configureWorkspace('personal')
    await restore.selectBackupFile(await backupFile())
    restore.setRestoreName('我的恢复')
    const r = await restore.confirmRestore()
    expect(r.ok).toBe(true)
    expect(r.verifyOk).toBe(true)
    expect(job().phase).toBe('done')
    expect(job().result.name).toBe('我的恢复')
    expect(job().verifyProblems).toEqual([])
    const ws = await db.getWorkspace(r.result.workspaceId)
    expect(ws.restore_receipt.operation_id).toBe(job().operationId)
    // 全局空间仍是 personal：恢复数据只在目标空间，未污染当前空间。
    expect((await db.allDocs()).records).toHaveLength(0)
    expect((await db.allSources()).records).toHaveLength(0)
  })

  it('双击确认：第二次 busy，目录恰好一份', async () => {
    await restore.selectBackupFile(await backupFile())
    const [a, b] = await Promise.all([restore.confirmRestore(), restore.confirmRestore()])
    expect(a.ok).toBe(true)
    expect(b.busy).toBe(true)
    const dirs = (await db.allWorkspaces()).filter((w) => w.restore_receipt)
    expect(dirs).toHaveLength(1)
  })

  it('提交失败可同意图重试：复用冻结 prepared（同 operationId），修复后成功只一份', async () => {
    await restore.selectBackupFile(await backupFile())
    const origAdd = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (v, ...rest) {
      if (this.name === 'docs') throw new Error('注入失败')
      return origAdd.call(this, v, ...rest)
    }
    let first
    try { first = await restore.confirmRestore() } finally { IDBObjectStore.prototype.add = origAdd }
    expect(first.ok).toBe(false)
    expect(job().phase).toBe('error')
    expect(job().commitError.code).toBe('RESTORE_WRITE_FAILED')
    const opId = job().operationId
    expect((await db.allWorkspaces()).filter((w) => w.restore_receipt)).toHaveLength(0)
    // 重试：复用冻结意图，绝不重新随机 ID/目标。
    const second = await restore.confirmRestore()
    expect(second.ok).toBe(true)
    expect(job().operationId).toBe(opId)
    expect(job().phase).toBe('done')
    expect((await db.allWorkspaces()).filter((w) => w.restore_receipt)).toHaveLength(1)
  })

  it('提交进行中禁止重置/换文件（写入阶段不可取消）', async () => {
    await restore.selectBackupFile(await backupFile())
    // 替换文件先备好：confirmRestore 同步进入 committing，selectBackupFile 的 busy 检查也在首个 await 前，
    // 断言不再依赖「生成文件期间提交尚未完成」的调度时序。
    const swapFile = await backupFile('换.zip')
    const p = restore.confirmRestore()
    expect(job().phase).toBe('committing')
    expect(restore.resetRestoreJob().busy).toBe(true)
    const swap = await restore.selectBackupFile(swapFile)
    expect(swap.busy).toBe(true)
    await p
    expect(job().phase).toBe('done')
  })

  it('完成后重置回 idle 并释放；准备失败回预览供修正名后重试', async () => {
    await restore.selectBackupFile(await backupFile())
    restore.setRestoreName('   ') // 空白名 → 准备失败
    const bad = await restore.confirmRestore()
    expect(bad.ok).toBe(false)
    expect(job().phase).toBe('preview')
    expect(job().commitError.code).toBe('BAD_NAME')
    restore.setRestoreName('修正后的名字')
    const ok = await restore.confirmRestore()
    expect(ok.ok).toBe(true)
    expect(job().result.name).toBe('修正后的名字')
    expect(restore.resetRestoreJob().ok).toBe(true)
    expect(job().phase).toBe('idle')
    expect(job().result).toBeNull()
  })
})