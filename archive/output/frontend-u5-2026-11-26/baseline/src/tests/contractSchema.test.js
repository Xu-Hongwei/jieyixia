import { describe, it, expect } from 'vitest'
import {
  validateAgainstDef,
  validateAgainstFrozen040Def,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_DEFS,
  FROZEN_040_SCHEMA_VERSION,
  FROZEN_040_DEFS,
} from '@/services/backup/contractSchema'

const TS = '2026-11-24T10:00:00+08:00'

describe('contractSchema 双来源（活 0.6.0 / 冻结 0.4.0）', () => {
  it('版本与定义集合按各自 schema 隔离', () => {
    expect(CONTRACT_SCHEMA_VERSION).toBe('0.6.0')
    expect(FROZEN_040_SCHEMA_VERSION).toBe('0.4.0')
    expect(CONTRACT_DEFS).toContain('AssistantDraft')
    expect(CONTRACT_DEFS).toContain('BackupManifestV2')
    expect(FROZEN_040_DEFS).not.toContain('AssistantDraft')
    expect(FROZEN_040_DEFS).not.toContain('BackupManifestV2')
    expect(FROZEN_040_DEFS.length).toBeLessThan(CONTRACT_DEFS.length)
  })

  it('活校验器认识助手类型；冻结校验器不认识（v1 旧备份不得混入助手对象）', () => {
    const draft = { id: 'd1', workspace_id: 'w', thread_id: 'th1', revision: 1, created_at: TS, updated_at: TS }
    expect(validateAgainstDef('AssistantDraft', draft).ok).toBe(true)
    expect(() => validateAgainstFrozen040Def('AssistantDraft', draft)).toThrow(/无定义/)
    expect(validateAgainstDef('AssistantDraft', { ...draft, revision: '2' }).ok).toBe(false)
    // revision≤20 等数值界限属 model_validator 语义，由域层 draft.js 把关（与 minutes:-5 同口径）。
  })

  it('冻结校验器仍能校验 0.4.0 业务对象（v1 备份恢复用）', () => {
    const action = { id: 'a1', workspace_id: 'personal', task_id: 't1', text: '写教育背景', minutes: 25, basis: 'user', done: false, created_at: TS }
    expect(validateAgainstFrozen040Def('Action', action).ok).toBe(true)
    expect(validateAgainstFrozen040Def('Action', { ...action, kind: 'action' }).ok).toBe(false)
  })

  it('oneOf 判别联合：task_ref 按 kind 收窄到 DraftRef/ExistingRef', () => {
    const base = { key: 'a-new', text: '写教育背景', minutes: 25 }
    expect(validateAgainstDef('ActionProposalCreate', { ...base, task_ref: { kind: 'draft', key: 't-new' } }).ok).toBe(true)
    expect(validateAgainstDef('ActionProposalCreate', { ...base, task_ref: { kind: 'existing', id: 't1' } }).ok).toBe(true)
    // 负对照：kind 不在判别映射内 / 分支字段错配 / 未知字段
    const bad1 = validateAgainstDef('ActionProposalCreate', { ...base, task_ref: { kind: 'other', id: 't1' } })
    expect(bad1.ok).toBe(false)
    expect(bad1.errors.some((e) => e.message.includes('oneOf'))).toBe(true)
    expect(validateAgainstDef('ActionProposalCreate', { ...base, task_ref: { kind: 'draft', id: 't1' } }).ok).toBe(false)
    expect(validateAgainstDef('ActionProposalCreate', { ...base, task_ref: { kind: 'existing', key: 't-new' } }).ok).toBe(false)
    expect(validateAgainstDef('ActionProposalCreate', { ...base, task_ref: { kind: 'draft', key: 't-new', extra: 1 } }).ok).toBe(false)
  })

  it('oneOf 判别联合：evidence_refs 逐项按 kind 收窄', () => {
    const base = { key: 'a-new', text: '写教育背景', minutes: 25, task_ref: { kind: 'draft', key: 't-new' } }
    const ev = { kind: 'source_excerpt', source_id: 'src1', excerpt: '报名截止 12 月 1 日' }
    expect(validateAgainstDef('ActionProposalCreate', { ...base, evidence_refs: [ev] }).ok).toBe(true)
    const bad = validateAgainstDef('ActionProposalCreate', { ...base, evidence_refs: [{ kind: 'source_excerpt', source_id: 'src1' }] })
    expect(bad.ok).toBe(false)
    expect(bad.errors.some((e) => e.path.includes('evidence_refs[0]') && e.message.includes('oneOf'))).toBe(true)
    expect(validateAgainstDef('ActionProposalCreate', { ...base, evidence_refs: [{ kind: 'bogus', source_id: 'src1', excerpt: 'x' }] }).ok).toBe(false)
  })
})