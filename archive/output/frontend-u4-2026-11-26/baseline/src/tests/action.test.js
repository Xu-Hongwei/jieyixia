import { describe, expect, it } from 'vitest'
import {
  ACTION_DEFAULT_MINUTES, addActionPlan, deleteActionPlan, editActionPlan, makeAction,
  reopenTaskPlan, setActionDonePlan, setCurrentActionPlan, validCurrentAction,
} from '../domains/action'
import { cascadeDeleteNotePlan, deleteTaskPlan, migratePlan, undoDeletePlan } from '../domains/matter'

const NOW = '2026-11-20T10:00:00+08:00'
const task = (over = {}) => ({
  id: 't1', kind: 'task', title: '交报告', status: 'todo', note_ids: [], matter_id: null,
  deadline: { value: null, precision: 'none' }, current_action_id: null,
  created_at: NOW, updated_at: NOW, ...over,
})
const action = (over = {}) => ({
  id: 'a1', kind: 'action', task_id: 't1', text: '列提纲', minutes: 30, basis: 'user', done: false, created_at: NOW, ...over,
})
const apply = (docs, { puts, deletes }) => {
  const gone = new Set(deletes)
  const byKey = new Map(docs.filter((d) => !gone.has(d.id)).map((d) => [d.id, d]))
  for (const p of puts) byKey.set(p.id, p)
  return [...byKey.values()]
}

describe('makeAction：输入校验与契约形状', () => {
  it('合法输入生成 basis=user、done=false 的行动；30 只是默认值不是强制', () => {
    const a = makeAction('t1', '  列提纲  ', ACTION_DEFAULT_MINUTES, NOW)
    expect(a.text).toBe('列提纲')
    expect(a.minutes).toBe(30)
    expect(a.basis).toBe('user')
    expect(a.done).toBe(false)
    expect(a.task_id).toBe('t1')
    expect(a.created_at).toBe(NOW)
    expect(makeAction('t1', '写初稿', 45, NOW).minutes).toBe(45)
    expect(makeAction('t1', '写初稿', '45', NOW).minutes).toBe(45)
  })
  it('空内容 / 非正整数分钟一律拒绝', () => {
    expect(makeAction('t1', '', 30, NOW)).toBeNull()
    expect(makeAction('t1', '   ', 30, NOW)).toBeNull()
    expect(makeAction('t1', 'x', 0, NOW)).toBeNull()
    expect(makeAction('t1', 'x', -5, NOW)).toBeNull()
    expect(makeAction('t1', 'x', 1.5, NOW)).toBeNull()
    expect(makeAction('t1', 'x', 'abc', NOW)).toBeNull()
    expect(makeAction('t1', 'x', '', NOW)).toBeNull()
  })
  it('域模型不私塞未定义字段（无 updated_at；kind 仅为持久化元数据）', () => {
    const a = makeAction('t1', 'x', 30, NOW)
    expect('updated_at' in a).toBe(false)
    const { kind, ...domain } = a
    expect(kind).toBe('action')
    expect(Object.keys(domain).sort()).toEqual(['basis', 'created_at', 'done', 'id', 'minutes', 'task_id', 'text'])
  })
})

describe('addActionPlan / editActionPlan', () => {
  it('任务不存在时拒绝添加（抛错回滚）', () => {
    expect(() => addActionPlan([], action())).toThrow('任务已不存在')
  })
  it('添加只写行动本体', () => {
    const r = addActionPlan([task()], action())
    expect(r.puts).toHaveLength(1)
    expect(r.deletes).toEqual([])
  })
  it('编辑只改本行动的内容与分钟，不触碰任务', () => {
    const docs = [task(), action(), action({ id: 'a2', text: '另一项' })]
    const r = editActionPlan(docs, 'a1', '新内容', 60)
    expect(r.puts).toHaveLength(1)
    expect(r.puts[0].text).toBe('新内容')
    expect(r.puts[0].minutes).toBe(60)
    expect(r.puts[0].id).toBe('a1')
  })
  it('编辑空内容 / 非法分钟抛错；行动不存在零变更', () => {
    expect(() => editActionPlan([task(), action()], 'a1', '', 30)).toThrow('内容不能为空')
    expect(() => editActionPlan([task(), action()], 'a1', 'x', 0)).toThrow('正整数')
    expect(editActionPlan([task()], 'gone', 'x', 30).puts).toEqual([])
  })
})

describe('setActionDonePlan：完成不自动完成任务，完成当前项清空引用', () => {
  it('完成普通行动：任务状态不变', () => {
    const docs = [task(), action()]
    const r = setActionDonePlan(docs, 'a1', true, NOW)
    const next = apply(docs, r)
    expect(next.find((d) => d.id === 'a1').done).toBe(true)
    expect(next.find((d) => d.id === 't1').status).toBe('todo')
    expect(r.info.clearedCurrent).toBe(false)
  })
  it('完成当前行动：同事务清空 current_action_id，不自动指定下一项', () => {
    const docs = [task({ current_action_id: 'a1' }), action(), action({ id: 'a2' })]
    const r = setActionDonePlan(docs, 'a1', true, NOW)
    const next = apply(docs, r)
    expect(next.find((d) => d.id === 't1').current_action_id).toBeNull()
    expect(next.find((d) => d.id === 'a2').done).toBe(false)
    expect(r.info.clearedCurrent).toBe(true)
  })
  it('重新打开行动不改任务；行动不存在零变更', () => {
    const docs = [task({ current_action_id: 'a1' }), action({ done: true })]
    const r = setActionDonePlan(docs, 'a1', false, NOW)
    const next = apply(docs, r)
    expect(next.find((d) => d.id === 'a1').done).toBe(false)
    expect(next.find((d) => d.id === 't1').current_action_id).toBe('a1')
    expect(setActionDonePlan(docs, 'gone', true, NOW).puts).toEqual([])
  })
})

describe('setCurrentActionPlan / validCurrentAction：归属与未完成约束', () => {
  it('显式选择属于本任务的未完成行动', () => {
    const docs = [task(), action()]
    const r = setCurrentActionPlan(docs, 't1', 'a1', NOW)
    expect(r.puts[0].current_action_id).toBe('a1')
  })
  it('跨任务 / 已完成 / 不存在的行动一律拒绝', () => {
    const docs = [task(), task({ id: 't2' }), action({ task_id: 't2' }), action({ id: 'a3', done: true })]
    expect(() => setCurrentActionPlan(docs, 't1', 'a1', NOW)).toThrow('不属于该任务')
    expect(() => setCurrentActionPlan(docs, 't1', 'a3', NOW)).toThrow('已完成')
    expect(() => setCurrentActionPlan(docs, 't1', 'gone', NOW)).toThrow('不属于该任务')
  })
  it('null = 用户主动取消选择', () => {
    const r = setCurrentActionPlan([task({ current_action_id: 'a1' }), action()], 't1', null, NOW)
    expect(r.puts[0].current_action_id).toBeNull()
  })
  it('validCurrentAction：悬空 / 跨任务 / 已完成引用都不算有效当前行动', () => {
    expect(validCurrentAction([task({ current_action_id: 'a1' }), action()], task({ current_action_id: 'a1' }))).toBeTruthy()
    expect(validCurrentAction([task({ current_action_id: 'gone' })], task({ current_action_id: 'gone' }))).toBeNull()
    expect(validCurrentAction([task({ current_action_id: 'a1' }), action({ done: true })], task({ current_action_id: 'a1' }))).toBeNull()
    expect(validCurrentAction([task({ id: 't2', current_action_id: 'a1' }), action()], task({ id: 't2', current_action_id: 'a1' }))).toBeNull()
  })
})

describe('deleteActionPlan / reopenTaskPlan', () => {
  it('删除当前行动同事务清空引用；删除普通行动不动任务', () => {
    const docs = [task({ current_action_id: 'a1' }), action()]
    const r = deleteActionPlan(docs, 'a1', NOW)
    expect(r.deletes).toEqual(['a1'])
    expect(r.puts[0].current_action_id).toBeNull()
    expect(r.info.wasCurrent).toBe(true)
    const r2 = deleteActionPlan([task(), action()], 'a1', NOW)
    expect(r2.puts).toEqual([])
    expect(r2.info.wasCurrent).toBe(false)
  })
  it('重新打开任务回 todo，不重开已完成行动；无效当前引用清空', () => {
    const docs = [task({ status: 'done', current_action_id: 'a1' }), action({ done: true })]
    const next = apply(docs, reopenTaskPlan(docs, 't1', NOW))
    expect(next.find((d) => d.id === 't1').status).toBe('todo')
    expect(next.find((d) => d.id === 't1').current_action_id).toBeNull()
    expect(next.find((d) => d.id === 'a1').done).toBe(true)
  })
  it('重新打开时有效当前引用保留', () => {
    const docs = [task({ status: 'done', current_action_id: 'a1' }), action()]
    const next = apply(docs, reopenTaskPlan(docs, 't1', NOW))
    expect(next.find((d) => d.id === 't1').current_action_id).toBe('a1')
  })
})

describe('删除与联删同批处理行动（3A 扩展）', () => {
  const docs = [
    { id: 'n1', kind: 'note', title: '通知', fields: [] },
    task({ note_ids: ['n1'], deadline: { value: '2026-11-25', precision: 'date', source: 'note', from_note_id: 'n1', confirmed_at: NOW } }),
    action(), action({ id: 'a2', text: '写初稿' }),
    task({ id: 't2', title: '无关任务' }), action({ id: 'a3', task_id: 't2' }),
  ]
  it('删任务同批删除其行动，不碰其它任务的行动', () => {
    const r = deleteTaskPlan(docs, 't1')
    expect(r.deletes.sort()).toEqual(['a1', 'a2', 't1'])
    expect(r.info.actions.map((a) => a.id).sort()).toEqual(['a1', 'a2'])
    const next = apply(docs, r)
    expect(next.find((d) => d.id === 'a3')).toBeTruthy()
  })
  it('便签联删：便签 + 关联任务 + 这些任务的行动同一事务删除', () => {
    const r = cascadeDeleteNotePlan(docs, 'n1')
    expect(r.deletes.sort()).toEqual(['a1', 'a2', 'n1', 't1'])
    expect(r.info.actions).toHaveLength(2)
    const next = apply(docs, r)
    expect(next.find((d) => d.id === 't2')).toBeTruthy()
    expect(next.find((d) => d.id === 'a3')).toBeTruthy()
  })
})

describe('undoDeletePlan：行动恢复与当前行动关系（冲突感知）', () => {
  const base = [task({ current_action_id: 'a1' }), action(), action({ id: 'a2', text: '写初稿' })]
  it('撤销任务删除：任务与行动同批恢复，有效当前关系保留', () => {
    const del = deleteTaskPlan(base, 't1')
    const after = apply(base, del)
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions }
    const r = undoDeletePlan(after, last, NOW)
    const next = apply(after, r)
    expect(next.find((d) => d.id === 't1').current_action_id).toBe('a1')
    expect(next.filter((d) => d.kind === 'action')).toHaveLength(2)
  })
  it('撤销行动删除：任务无另选时恢复本次被清空的当前选择', () => {
    const del = deleteActionPlan(base, 'a1', NOW)
    const after = apply(base, del)
    expect(after.find((d) => d.id === 't1').current_action_id).toBeNull()
    const last = { kind: 'action', action: del.info.action, wasCurrent: del.info.wasCurrent }
    const next = apply(after, undoDeletePlan(after, last, NOW))
    expect(next.find((d) => d.id === 'a1')).toBeTruthy()
    expect(next.find((d) => d.id === 't1').current_action_id).toBe('a1')
  })
  it('期间用户已另选当前行动 → 只恢复行动本体，不覆盖新选择', () => {
    const del = deleteActionPlan(base, 'a1', NOW)
    let after = apply(base, del)
    after = apply(after, setCurrentActionPlan(after, 't1', 'a2', NOW))
    const last = { kind: 'action', action: del.info.action, wasCurrent: true }
    const next = apply(after, undoDeletePlan(after, last, NOW))
    expect(next.find((d) => d.id === 't1').current_action_id).toBe('a2')
    expect(next.find((d) => d.id === 'a1')).toBeTruthy()
  })
  it('行动已有新版本 → 明确拒绝，不覆盖', () => {
    const del = deleteActionPlan(base, 'a1', NOW)
    const after = apply(base, del)
    const recreated = [...after, action({ text: '新写的同名行动' })]
    const last = { kind: 'action', action: del.info.action, wasCurrent: true }
    expect(() => undoDeletePlan(recreated, last, NOW)).toThrow('已有新版本')
  })
  it('所属任务已不存在 → 拒绝恢复行动，不制造悬空记录', () => {
    const del = deleteActionPlan(base, 'a1', NOW)
    const after = apply(base, del).filter((d) => d.id !== 't1')
    const last = { kind: 'action', action: del.info.action, wasCurrent: true }
    expect(() => undoDeletePlan(after, last, NOW)).toThrow('任务已不存在')
  })
  it('恢复时当前引用指向已完成行动 → 清空引用但行动本体恢复', () => {
    const doneDocs = [task({ current_action_id: 'a1' }), action({ done: true })]
    const del = deleteTaskPlan(doneDocs, 't1')
    const after = apply(doneDocs, del)
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions }
    const next = apply(after, undoDeletePlan(after, last, NOW))
    expect(next.find((d) => d.id === 't1').current_action_id).toBeNull()
    expect(next.find((d) => d.id === 'a1').done).toBe(true)
  })
  it('便签联删撤销：便签 + 任务 + 行动全部恢复', () => {
    const withNote = [{ id: 'n1', kind: 'note', title: '通知', fields: [] }, task({ note_ids: ['n1'] }), action()]
    const del = cascadeDeleteNotePlan(withNote, 'n1')
    const after = apply(withNote, del)
    const last = { kind: 'note', note: del.info.note, tasks: del.info.tasks, actions: del.info.actions }
    const next = apply(after, undoDeletePlan(after, last, NOW))
    expect(next.map((d) => d.id).sort()).toEqual(['a1', 'n1', 't1'])
  })
})

describe('migratePlan：行动与历史保留、无效当前引用幂等清理', () => {
  it('action / focus_session / plan_item 记录原样保留，绝不删除历史', () => {
    const docs = [
      task(), action(),
      { id: 'f1', kind: 'focus_session', task_id: 't1', action_id: 'a1', started_at: NOW, accumulated_ms: 1000, running: false },
      { id: 'p1', kind: 'plan_item', task_id: 't1', date: '2026-11-20', planned_minutes: 30, action_text: '列提纲' },
    ]
    const r = migratePlan(docs)
    expect(r.deletes).toEqual([])
    const next = apply(docs, r)
    expect(next.find((d) => d.id === 'f1')).toEqual(docs[2])
    expect(next.find((d) => d.id === 'p1')).toEqual(docs[3])
    expect(next.find((d) => d.id === 'a1')).toEqual(docs[1])
  })
  it('悬空 / 跨任务 / 已完成的 current_action_id 幂等清空；有效引用不动', () => {
    const docs = [
      task({ id: 't1', current_action_id: 'gone' }),
      task({ id: 't2', current_action_id: 'a1' }),
      task({ id: 't3', current_action_id: 'a2' }),
      task({ id: 't4', current_action_id: 'a3' }),
      action({ id: 'a1', task_id: 't1' }),
      action({ id: 'a2', task_id: 't3', done: true }),
      action({ id: 'a3', task_id: 't4' }),
    ]
    const next = apply(docs, migratePlan(docs))
    expect(next.find((d) => d.id === 't1').current_action_id).toBeNull()
    expect(next.find((d) => d.id === 't2').current_action_id).toBeNull()
    expect(next.find((d) => d.id === 't3').current_action_id).toBeNull()
    expect(next.find((d) => d.id === 't4').current_action_id).toBe('a3')
    const twice = migratePlan(next)
    expect(twice.puts).toEqual([])
    expect(twice.deletes).toEqual([])
  })
})

describe('PlanItem 活引用闭合（契约 0.4.0：planned 随任务移除，已执行保留为 deleted 历史）', () => {
  const plan = (over = {}) => ({
    id: 'p1', kind: 'plan_item', workspace_id: 'w1', task_id: 't1', date: '2026-11-20',
    planned_minutes: 30, action_text: '列提纲', state: 'planned', actual_minutes: null,
    focus_session_id: null, order: 0, task_ref_state: 'active', ...over,
  })
  const endedSession = (over = {}) => ({
    id: 'f1', kind: 'focus_session', workspace_id: 'w1', task_id: 't1', action_id: 'a1', plan_item_id: null,
    started_at: NOW, ended_at: NOW, accumulated_ms: 1000, running: false, outcome: 'done', blocker: null,
    draft_md: '成果', record_version: 1, timer_anchor_at: null, task_ref_state: 'active', action_ref_state: 'active', ...over,
  })
  it('删任务：planned 条目移除，done 条目保留并置 task_ref_state=deleted，info 捕获供撤销', () => {
    const docs = [task(), action(), plan({ id: 'pp', state: 'planned' }), plan({ id: 'pd', state: 'done', actual_minutes: 25, focus_session_id: 'f1', order: 1 }), endedSession({ plan_item_id: 'pd' })]
    const r = deleteTaskPlan(docs, 't1', docs.filter((d) => d.kind === 'focus_session'))
    expect(r.deletes).toContain('pp')
    expect(r.deletes).not.toContain('pd')
    const next = apply(docs, r)
    expect(next.find((d) => d.id === 'pp')).toBeUndefined()
    expect(next.find((d) => d.id === 'pd').task_ref_state).toBe('deleted')
    expect(next.find((d) => d.id === 'pd').state).toBe('done')
    expect(next.find((d) => d.id === 'f1').task_ref_state).toBe('deleted')
    expect(r.info.planRemoved.map((p) => p.id)).toEqual(['pp'])
    expect(r.info.planDetached).toEqual([{ id: 'pd', from: 'active' }])
  })
  it('无 plan_item 时删除计划零写入（对现有数据无影响）', () => {
    const r = deleteTaskPlan([task(), action()], 't1')
    expect(r.info.planRemoved).toEqual([])
    expect(r.info.planDetached).toEqual([])
    expect(r.deletes.sort()).toEqual(['a1', 't1'])
  })
  it('便签联删：关联任务的 planned 移除、done 置 deleted，其它任务计划不动', () => {
    const docs = [
      { id: 'n1', kind: 'note', title: '通知', fields: [] },
      task({ note_ids: ['n1'] }), action(),
      plan({ id: 'pp', state: 'planned' }), plan({ id: 'pd', state: 'done', actual_minutes: 25 }),
      task({ id: 't2', title: '无关' }), plan({ id: 'p2', task_id: 't2', state: 'planned' }),
    ]
    const r = cascadeDeleteNotePlan(docs, 'n1')
    const next = apply(docs, r)
    expect(next.find((d) => d.id === 'pp')).toBeUndefined()
    expect(next.find((d) => d.id === 'pd').task_ref_state).toBe('deleted')
    expect(next.find((d) => d.id === 'p2').task_ref_state).toBe('active')
    expect(r.info.planRemoved.map((p) => p.id)).toEqual(['pp'])
  })
  it('撤销：planned 条目恢复 active、done 引用回补 active，顺序/用时不变', () => {
    const docs = [task(), action(), plan({ id: 'pp', state: 'planned' }), plan({ id: 'pd', state: 'done', actual_minutes: 25, order: 1 })]
    const del = deleteTaskPlan(docs, 't1')
    const after = apply(docs, del)
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions, sessionPatches: del.info.sessionPatches, planRemoved: del.info.planRemoved, planDetached: del.info.planDetached }
    const next = apply(after, undoDeletePlan(after, last, NOW))
    expect(next.find((d) => d.id === 'pp').state).toBe('planned')
    expect(next.find((d) => d.id === 'pp').task_ref_state).toBe('active')
    expect(next.find((d) => d.id === 'pd').task_ref_state).toBe('active')
    expect(next.find((d) => d.id === 'pd').actual_minutes).toBe(25)
    expect(next.find((d) => d.id === 'pd').order).toBe(1)
  })
  it('撤销：planned 条目 ID 被新对象占用 → 整体拒绝，不覆盖', () => {
    const docs = [task(), action(), plan({ id: 'pp', state: 'planned' })]
    const del = deleteTaskPlan(docs, 't1')
    let after = apply(docs, del)
    after = [...after, { id: 'pp', kind: 'note', title: '占位新便签', fields: [] }]
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions, planRemoved: del.info.planRemoved, planDetached: del.info.planDetached }
    expect(() => undoDeletePlan(after, last, NOW)).toThrow('已有新版本')
  })
  it('撤销：done 条目期间被改（ref 非 deleted）→ 该引用补丁拒绝，对象仍恢复，不笼统全成功', () => {
    const docs = [task(), action(), plan({ id: 'pd', state: 'done', actual_minutes: 25 })]
    const del = deleteTaskPlan(docs, 't1')
    let after = apply(docs, del)
    after = after.map((d) => (d.id === 'pd' ? { ...d, task_ref_state: 'active' } : d))
    const last = { kind: 'task', task: del.info.task, actions: del.info.actions, planRemoved: del.info.planRemoved, planDetached: del.info.planDetached }
    const r = undoDeletePlan(after, last, NOW)
    const next = apply(after, r)
    expect(next.find((d) => d.id === 't1')).toBeTruthy()
    expect(r.info.planRefs.refused.map((x) => x.id)).toEqual(['pd'])
    expect(r.info.planRefs.applied).toEqual([])
  })
  it('单删行动 / 删事项 / 完成任务不触碰 plan_item（任务仍在，活引用保持）', () => {
    const docs = [task({ current_action_id: 'a1' }), action(), plan({ id: 'pp', state: 'planned' })]
    const da = deleteActionPlan(docs, 'a1', NOW)
    expect(apply(docs, da).find((d) => d.id === 'pp').task_ref_state).toBe('active')
    expect(da.deletes).not.toContain('pp')
  })
})