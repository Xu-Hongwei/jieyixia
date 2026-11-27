import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { reactive, isReactive } from 'vue'
import { allDocs, allSources, clearWorkspace, configureWorkspace, deepRaw, putDoc, putSource, snapshot, transformDocsAtomic } from '../services/storage/db'

beforeEach(() => configureWorkspace('w1'))

describe('workspace 限定', () => {
  it('清空确认之后新增的任务触发整批回滚，重新确认只清目标空间', async () => {
    configureWorkspace('clear-example')
    await putSource({ id: 'clear-material', kind: 'text', text: '虚构资料' })
    const original = { docs: new Set(), sources: new Set(['clear-material']) }
    await putDoc({ id: 'new-after-preview', kind: 'task' })
    await expect(clearWorkspace('clear-example', original)).rejects.toThrow('空间内容已变化')
    expect((await allSources()).records).toHaveLength(1)
    expect((await allDocs()).records).toHaveLength(1)
    await clearWorkspace('clear-example', { ...original, docs: new Set(['new-after-preview']) })
    expect((await allSources()).records).toEqual([])
    expect((await allDocs()).records).toEqual([])
  })
  it('读写都按当前空间过滤，跨空间写入拒绝', async () => {
    await putDoc({ id: 'a', kind: 'note', title: 'w1 便签' })
    configureWorkspace('w2')
    expect((await allDocs()).records).toHaveLength(0)
    await expect(putDoc({ id: 'b', kind: 'note', workspace_id: 'w1' })).rejects.toThrow()
    configureWorkspace('w1')
    expect((await allDocs()).records.map((d) => d.id)).toEqual(['a'])
  })
})

describe('快照深脱代理', () => {
  it('嵌套 reactive 可结构化克隆且落库非响应式', () => {
    const nested = reactive({ list: reactive([{ x: 1 }]), when: new Date() })
    const snap = snapshot(nested)
    expect(isReactive(snap)).toBe(false)
    expect(isReactive(snap.list)).toBe(false)
    expect(snap.list[0].x).toBe(1)
    expect(deepRaw(nested).when).toBeInstanceOf(Date)
  })
})

describe('单事务读最新→计划→先删后写', () => {
  it('写入失败整体回滚：便签与任务关联均不变', async () => {
    await putDoc({ id: 'note-x', kind: 'note', title: 'n' })
    await putDoc({ id: 'task-x', kind: 'task', title: 't', note_ids: ['note-x'] })
    const origPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...rest) {
      if (value && value.kind === 'task') throw new Error('注入写入失败')
      return origPut.call(this, value, ...rest)
    }
    try {
      await expect(transformDocsAtomic((latest) => ({
        puts: latest.filter((d) => d.kind === 'task').map((d) => ({ ...d, note_ids: [] })),
        deletes: ['note-x'],
      }))).rejects.toThrow()
    } finally {
      IDBObjectStore.prototype.put = origPut
    }
    const docs = (await allDocs()).records
    expect(docs.find((d) => d.id === 'note-x')).toBeTruthy()
    expect(docs.find((d) => d.id === 'task-x').note_ids).toEqual(['note-x'])
  })
  it('计划抛错即回滚，不产生半份变更', async () => {
    await expect(transformDocsAtomic(() => { throw new Error('冲突拒绝') })).rejects.toThrow('冲突拒绝')
    const docs = (await allDocs()).records
    expect(docs.find((d) => d.id === 'note-x')).toBeTruthy()
    expect(docs.find((d) => d.id === 'task-x').note_ids).toEqual(['note-x'])
  })
  it('成功路径：便签删除且关联解除；计划读到的是事务内最新状态', async () => {
    const result = await transformDocsAtomic((latest) => {
      expect(latest.find((d) => d.id === 'task-x').note_ids).toEqual(['note-x'])
      return {
        puts: latest.filter((d) => d.kind === 'task').map((d) => ({ ...d, note_ids: [] })),
        deletes: ['note-x'],
        info: { seen: latest.length },
      }
    })
    expect(result.workspace_id).toBe('w1')
    expect(result.deletes).toEqual(['note-x'])
    expect(result.puts[0].workspace_id).toBe('w1')
    expect(result.info.seen).toBe(3)
    const docs = (await allDocs()).records
    expect(docs.find((d) => d.id === 'note-x')).toBeUndefined()
    expect(docs.find((d) => d.id === 'task-x').note_ids).toEqual([])
  })
  it('先删后写允许同 id 换 kind（group → matter 迁移）', async () => {
    await putDoc({ id: 'same-id', kind: 'group', name: '旧' })
    await transformDocsAtomic(() => ({ puts: [{ id: 'same-id', kind: 'matter', title: '新', note_ids: [] }], deletes: ['same-id'] }))
    const doc = (await allDocs()).records.find((d) => d.id === 'same-id')
    expect(doc.kind).toBe('matter')
    expect(doc.title).toBe('新')
  })
})

describe('personal / demo 工作区隔离', () => {
  it('两空间数据互不可见，切换后各自读取', async () => {
    configureWorkspace('personal')
    await putDoc({ id: 'p-note', kind: 'note', title: '个人便签' })
    await putSource({ id: 'p-src', kind: 'text', text: '个人资料' })
    configureWorkspace('demo')
    expect((await allDocs()).records).toHaveLength(0)
    expect((await allSources()).records).toHaveLength(0)
    await putDoc({ id: 'd-note', kind: 'note', title: '演示便签' })
    expect((await allDocs()).records.map((d) => d.id)).toEqual(['d-note'])
    configureWorkspace('personal')
    expect((await allDocs()).records.map((d) => d.id)).toEqual(['p-note'])
    expect((await allSources()).records.map((s) => s.id)).toEqual(['p-src'])
  })
  it('clearWorkspace(demo) 只清演示，personal 原样保留', async () => {
    configureWorkspace('demo')
    await putDoc({ id: 'd-note2', kind: 'note', title: '演示2' })
    await clearWorkspace('demo')
    expect((await allDocs()).records).toHaveLength(0)
    configureWorkspace('personal')
    expect((await allDocs()).records.map((d) => d.id)).toEqual(['p-note'])
    expect((await allSources()).records.map((s) => s.id)).toEqual(['p-src'])
  })
})
