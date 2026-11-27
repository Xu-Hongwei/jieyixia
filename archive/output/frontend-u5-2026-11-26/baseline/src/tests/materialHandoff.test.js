import { describe, expect, it } from 'vitest'
import { resolveMaterialHandoff } from '../domains/materialHandoff'
import { parseReturnPath } from '../domains/workNavigation'

const sources = [{ id: 'a', workspace_id: 'personal' }, { id: 'b', workspace_id: 'personal' }, { id: 'c', workspace_id: 'demo' }]
const resolve = query => resolveMaterialHandoff(query, 'personal', sources, 2)
describe('资料交接边界', () => {
  it('没有交接参数不修改现有输入', () => expect(resolve({})).toBeNull())
  it('仅接受明确选中且属于当前空间的资料，保持顺序', () => {
    expect(resolve({ sources: ['b', 'a'], workspace: 'personal' }).ids).toEqual(['b', 'a'])
    expect(resolve({ sources: 'a', workspace: 'personal' }).sources).toEqual([sources[0]])
  })
  it('拒绝缺失或不同的来源空间', () => {
    expect(resolve({ sources: 'a' }).ok).toBe(false)
    expect(resolve({ sources: 'a', workspace: 'demo' }).ok).toBe(false)
  })
  it('删除或跨空间资料整批拒绝，不静默改选', () => {
    expect(resolve({ sources: ['a', 'missing'], workspace: 'personal' }).ok).toBe(false)
    expect(resolve({ sources: ['a', 'c'], workspace: 'personal' }).ok).toBe(false)
  })
  it('拒绝超限、重复和非法形态', () => {
    for (const ids of [[], ['a', 'b', 'c'], ['a', 'a'], ['', 'b'], [null], { id: 'a' }]) {
      expect(resolve({ sources: ids, workspace: 'personal' }).ok).toBe(false)
    }
  })
  it('任务返回资料时保留面板对象与筛选，仍不接受外站', () => {
    const ctx = { docs: [], ws: 'personal', todayStr: '2026-11-26' }
    expect(parseReturnPath('/collect?status=pending&source=a', ctx)).toBe('/collect?status=pending&source=a')
    expect(parseReturnPath('https://example.com/collect?source=a', ctx)).toBeNull()
  })
})
