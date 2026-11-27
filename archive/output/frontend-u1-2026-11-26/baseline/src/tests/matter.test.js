import { describe, expect, it } from 'vitest'
import {
  cascadeDeleteNotePlan, deleteMatterPlan, deleteTaskPlan, migratePlan, normalizeDeadline, setMatterPlan, undoDeletePlan,
} from '../domains/matter'

const NOW = '2026-11-19T10:00:00+08:00'
const byId = (docs, id) => docs.find((d) => d.id === id)

describe('normalizeDeadline：无截止映射契约形状', () => {
  it('null / 空值都归一为 precision=none 且 value 为空', () => {
    expect(normalizeDeadline(null)).toEqual({ value: null, precision: 'none' })
    expect(normalizeDeadline({ value: null, precision: 'date' })).toEqual({ value: null, precision: 'none' })
  })
  it('合法截止原样保留（同一引用，不产生无谓写入）', () => {
    const dl = { value: '2026-11-20', precision: 'date', source: 'manual', confirmed_at: NOW }
    expect(normalizeDeadline(dl)).toBe(dl)
  })
})

describe('migratePlan：旧 Group → 契约 Matter（幂等，不清数据）', () => {
  const legacy = [
    { id: 'g1', kind: 'group', name: '课程', created_at: NOW, updated_at: NOW },
    { id: 'n1', kind: 'note', title: '通知', status: 'draft', fields: [], group_id: 'g1' },
    { id: 'n2', kind: 'note', title: '评分说明', status: 'draft', fields: [], group_id: 'g1', matter_role: 'requirement' },
    { id: 't1', kind: 'task', title: '交报告', status: 'todo', note_ids: [], group_id: 'g1', deadline: null },
    { id: 'n3', kind: 'note', title: '未归组', status: 'draft', fields: [], matter_role: 'reference' },
    { id: 't2', kind: 'task', title: '无截止', status: 'todo', note_ids: [], deadline: null },
    { id: 'n4', kind: 'note', title: '悬空归组', status: 'draft', fields: [], group_id: 'g-missing' },
  ]
  const apply = (docs, plan) => {
    const { puts, deletes } = plan(docs)
    const gone = new Set(deletes)
    const byKey = new Map(docs.filter((d) => !gone.has(d.id)).map((d) => [d.id, d]))
    for (const p of puts) byKey.set(p.id, p)
    return [...byKey.values()]
  }
  it('group 换 kind 沿用原 id，name → title，成员 group_id → matter_id', () => {
    const { puts, deletes } = migratePlan(legacy)
    expect(deletes).toEqual(['g1'])
    const next = apply(legacy, migratePlan)
    expect(byId(next, 'g1').kind).toBe('matter')
    expect(byId(next, 'g1').title).toBe('课程')
    expect(byId(next, 'n1').matter_id).toBe('g1')
    expect('group_id' in byId(next, 'n1')).toBe(false)
    expect(byId(next, 't1').matter_id).toBe('g1')
    expect(puts.length).toBeGreaterThan(0)
  })
  it('Matter.note_ids 由便签归属回填，任务不进 note_ids', () => {
    const next = apply(legacy, migratePlan)
    expect(byId(next, 'g1').note_ids.sort()).toEqual(['n1', 'n2'])
  })
  it('契约不变量：未归组/悬空归组便签不得有资料角色，非法角色清空', () => {
    const next = apply(legacy, migratePlan)
    expect(byId(next, 'n3').matter_id).toBeNull()
    expect(byId(next, 'n3').matter_role).toBeNull()
    expect(byId(next, 'n4').matter_id).toBeNull()
    const weird = apply([{ id: 'm', kind: 'matter', title: 'x', note_ids: [] }, { id: 'n', kind: 'note', matter_id: 'm', matter_role: 'boss' }], migratePlan)
    expect(byId(weird, 'n').matter_role).toBeNull()
  })
  it('旧 deadline:null 归一为契约空截止；已有合法截止不动', () => {
    const next = apply(legacy, migratePlan)
    expect(byId(next, 't1').deadline).toEqual({ value: null, precision: 'none' })
    expect(byId(next, 't2').deadline).toEqual({ value: null, precision: 'none' })
  })
  it('幂等：迁移结果再跑一次 puts/deletes 均为空', () => {
    const once = apply(legacy, migratePlan)
    const twice = migratePlan(once)
    expect(twice.puts).toEqual([])
    expect(twice.deletes).toEqual([])
  })
  it('不删除任何便签/任务/资料本体', () => {
    const next = apply(legacy, migratePlan)
    for (const id of ['n1', 'n2', 'n3', 'n4', 't1', 't2']) expect(byId(next, id)).toBeTruthy()
  })
})

describe('cascadeDeleteNotePlan：联删影响面与边界', () => {
  const docs = [
    { id: 'm1', kind: 'matter', title: '事项', note_ids: ['n1', 'n2'] },
    { id: 'n1', kind: 'note', title: '目标便签', matter_id: 'm1', matter_role: 'requirement' },
    { id: 'n2', kind: 'note', title: '其他便签', matter_id: 'm1', matter_role: 'reference' },
    { id: 't1', kind: 'task', title: 'note_ids', note_ids: ['n1'], deadline: { value: null, precision: 'none' } },
    { id: 't2', kind: 'task', title: '截止出处', note_ids: [], deadline: { value: '2026-11-20', precision: 'date', source: 'note', from_note_id: 'n1' } },
    { id: 't3', kind: 'task', title: '共享', note_ids: ['n1', 'n2'], deadline: { value: null, precision: 'none' } },
    { id: 't4', kind: 'task', title: '无关', note_ids: ['n2'], deadline: { value: null, precision: 'none' } },
  ]
  it('删除便签 + 去重后的关联任务，事项 note_ids 摘除，其他便签/任务保留', () => {
    const { puts, deletes, info } = cascadeDeleteNotePlan(docs, 'n1')
    expect(deletes.sort()).toEqual(['n1', 't1', 't2', 't3'])
    expect(info.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2', 't3'])
    expect(puts).toEqual([{ ...byId(docs, 'm1'), note_ids: ['n2'] }])
  })
  it('共享任务整体删除；孤立便签只删自身', () => {
    const { deletes, info } = cascadeDeleteNotePlan(docs, 'n2')
    expect(deletes).toEqual(['n2', 't3', 't4'])
    expect(info.note.id).toBe('n2')
    const lonely = cascadeDeleteNotePlan([{ id: 'nx', kind: 'note' }], 'nx')
    expect(lonely.deletes).toEqual(['nx'])
    expect(lonely.info.tasks).toEqual([])
  })
  it('便签不存在时零变更', () => {
    expect(cascadeDeleteNotePlan(docs, 'missing')).toEqual({ puts: [], deletes: [], info: { note: null, tasks: [], actions: [] } })
  })
})

describe('setMatterPlan / deleteMatterPlan：双向一致与 P04', () => {
  const base = [
    { id: 'm1', kind: 'matter', title: 'A', note_ids: ['n1'] },
    { id: 'm2', kind: 'matter', title: 'B', note_ids: [] },
    { id: 'n1', kind: 'note', title: '便签', matter_id: 'm1', matter_role: 'requirement' },
    { id: 't1', kind: 'task', title: '任务', matter_id: 'm1', note_ids: [], deadline: { value: null, precision: 'none' } },
  ]
  it('换组：旧事项摘除、新事项加入，角色不继承', () => {
    const { puts } = setMatterPlan(base, 'n1', 'm2', undefined, NOW)
    expect(byId(puts, 'n1').matter_id).toBe('m2')
    expect(byId(puts, 'n1').matter_role).toBeNull()
    expect(byId(puts, 'm1').note_ids).toEqual([])
    expect(byId(puts, 'm2').note_ids).toEqual(['n1'])
  })
  it('同事项省略角色沿用既有；显式 null 清空；非法角色清空', () => {
    expect(byId(setMatterPlan(base, 'n1', 'm1', undefined, NOW).puts, 'n1').matter_role).toBe('requirement')
    expect(byId(setMatterPlan(base, 'n1', 'm1', null, NOW).puts, 'n1').matter_role).toBeNull()
    expect(byId(setMatterPlan(base, 'n1', 'm1', 'reference', NOW).puts, 'n1').matter_role).toBe('reference')
    expect(byId(setMatterPlan(base, 'n1', 'm1', 'boss', NOW).puts, 'n1').matter_role).toBeNull()
  })
  it('移出事项清除角色并摘除引用', () => {
    const { puts } = setMatterPlan(base, 'n1', null, undefined, NOW)
    expect(byId(puts, 'n1').matter_id).toBeNull()
    expect(byId(puts, 'n1').matter_role).toBeNull()
    expect(byId(puts, 'm1').note_ids).toEqual([])
  })
  it('任务归组不写 Matter.note_ids', () => {
    const { puts } = setMatterPlan(base, 't1', 'm2', undefined, NOW)
    expect(byId(puts, 't1').matter_id).toBe('m2')
    expect(puts.some((p) => p.kind === 'matter')).toBe(false)
  })
  it('目标事项不存在则抛错（事务回滚）', () => {
    expect(() => setMatterPlan(base, 'n1', 'nope', undefined, NOW)).toThrow()
  })
  it('删事项只解除归组：成员本体保留，便签角色清除', () => {
    const { puts, deletes, info } = deleteMatterPlan(base, 'm1', NOW)
    expect(deletes).toEqual(['m1'])
    expect(info.members.map((m) => m.id).sort()).toEqual(['n1', 't1'])
    expect(byId(puts, 'n1').matter_id).toBeNull()
    expect(byId(puts, 'n1').matter_role).toBeNull()
    expect(byId(puts, 't1').matter_id).toBeNull()
    expect(byId(puts, 't1').deadline).toEqual({ value: null, precision: 'none' })
  })
  it('deleteTaskPlan 只删任务本体', () => {
    expect(deleteTaskPlan(base, 't1').deletes).toEqual(['t1'])
    expect(deleteTaskPlan(base, 't1').puts).toEqual([])
  })
})

describe('undoDeletePlan：冲突感知恢复，不覆盖用户新事实', () => {
  const note = { id: 'n1', kind: 'note', title: '便签', matter_id: 'm1', matter_role: 'requirement' }
  const task = { id: 't1', kind: 'task', title: '删除时标题', note_ids: ['n1'], matter_id: 'm1', deadline: { value: '2026-11-20', precision: 'date', source: 'note', from_note_id: 'n1', confirmed_at: NOW } }
  const last = { kind: 'note', note, tasks: [task] }
  it('记录已存在新版本 → 明确拒绝（抛错回滚）', () => {
    const latest = [{ id: 't1', kind: 'task', title: '用户新标题', note_ids: [], deadline: { value: null, precision: 'none' } }]
    expect(() => undoDeletePlan(latest, last)).toThrow(/不恢复/)
  })
  it('事项已删除 → 清除悬空 matter_id/matter_role，不恢复进已删事项', () => {
    const { puts } = undoDeletePlan([], last)
    expect(byId(puts, 'n1').matter_id).toBeNull()
    expect(byId(puts, 'n1').matter_role).toBeNull()
    expect(byId(puts, 't1').matter_id).toBeNull()
    expect(puts.some((p) => p.kind === 'matter')).toBe(false)
  })
  it('事项仍存在 → 用最新事项版本只补 note_ids，不覆盖用户改过的标题', () => {
    const latest = [{ id: 'm1', kind: 'matter', title: '用户改过的名称', note_ids: [] }]
    const { puts } = undoDeletePlan(latest, last)
    const m = byId(puts, 'm1')
    expect(m.title).toBe('用户改过的名称')
    expect(m.note_ids).toEqual(['n1'])
    expect(byId(puts, 'n1').matter_role).toBe('requirement')
  })
  it('任务引用的其他便签已不存在 → 拒绝恢复，不留悬空引用', () => {
    const orphan = { kind: 'task', task: { ...task, note_ids: ['n1', 'n-gone'] } }
    expect(() => undoDeletePlan([], orphan)).toThrow(/便签已不存在/)
  })
  it('截止出处便签缺失 → 拒绝恢复', () => {
    const bad = { kind: 'task', task: { ...task, note_ids: [], deadline: { ...task.deadline, from_note_id: 'n-gone' } } }
    expect(() => undoDeletePlan([], bad)).toThrow(/出处便签已不存在/)
  })
  it('无删除记录 → 抛错', () => {
    expect(() => undoDeletePlan([], null)).toThrow()
  })
})