// R2 真实 TypeScript 收窄验证（tsc --noEmit --strict）。
// 正向：判别字段收窄后能访问成员专属字段；反向：@ts-expect-error 断言未收窄/跨成员访问必须报错。
// 若生成器把联合丢成 unknown，@ts-expect-error 会因「没有错误可抑制」而编译失败，从而机械检出回归。
// 运行：node frontend/node_modules/typescript/bin/tsc -p contract/proposals/assistant-v1/typecheck/tsconfig.json
import type {
  AssistantModelProposal,
  AssistantProposeResponse,
  RequirementCandidate,
  NoteFieldCandidate,
} from '../typedefs'

type Expect<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false
type IsUnknown<T> = IsAny<T> extends true ? false : unknown extends T ? true : false

type TaskProposal = NonNullable<AssistantModelProposal['task_proposals']>[number]
type ActionProposal = NonNullable<AssistantModelProposal['action_proposals']>[number]
type EvidenceRef = NonNullable<AssistantModelProposal['evidence_refs']>[number]
type TypedRef = NonNullable<AssistantModelProposal['work_items']>[number]['task_ref']
type ResponsePayload = AssistantProposeResponse['payload']

// ---- ResponsePayload：kind 收窄 ----
export function payloadNarrow(p: ResponsePayload): string {
  // @ts-expect-error 未收窄不得访问 proposal 成员字段
  p.proposal
  if (p.kind === 'proposal') {
    const items: NonNullable<AssistantModelProposal['work_items']> | undefined = p.proposal.work_items
    void items
    return 'proposal'
  }
  if (p.kind === 'clarification') {
    const n: number = p.questions.length
    return `clarification:${n}`
  }
  if (p.kind === 'explanation') {
    return p.explanation
  }
  return 'unknown-kind'
}

// ---- TaskProposal：op 收窄 ----
export function taskNarrow(t: TaskProposal): string {
  // @ts-expect-error 联合上不得直接访问 update 专属 changes
  t.changes
  // @ts-expect-error 联合上不得直接访问 create 专属 title
  t.title
  if (t.op === 'create') {
    return t.title
  }
  if (t.op === 'update') {
    const dls = t.changes.deadline_candidates
    void dls
    return t.target_id
  }
  if (t.op === 'link') {
    return t.target_id
  }
  return 'unknown-op'
}

// ---- ActionProposal：op 收窄 ----
export function actionNarrow(a: ActionProposal): number {
  // @ts-expect-error 联合上不得直接访问 create 专属 minutes
  a.minutes
  if (a.op === 'create') {
    return a.minutes
  }
  if (a.op === 'reuse') {
    const id: string = a.target_id
    void id
    return 0
  }
  return -1
}

// ---- EvidenceRef：kind 收窄 ----
export function evidenceNarrow(e: EvidenceRef): string {
  // @ts-expect-error 联合上不得直接访问 source_excerpt 专属 source_id
  e.source_id
  if (e.kind === 'source_excerpt') {
    return e.source_id
  }
  if (e.kind === 'user_message') {
    return e.turn_id
  }
  if (e.kind === 'note_field') {
    return e.field_key
  }
  if (e.kind === 'existing_fact') {
    return `${e.object_type}/${e.object_id}`
  }
  return 'unknown-evidence'
}

// ---- DraftRef / ExistingRef：kind 收窄 ----
export function refNarrow(r: TypedRef): string {
  // @ts-expect-error 联合上不得直接访问 existing 专属 id
  r.id
  // @ts-expect-error 联合上不得直接访问 draft 专属 key
  r.key
  if (r.kind === 'draft') {
    return r.key
  }
  if (r.kind === 'existing') {
    return r.id
  }
  return 'unknown-ref'
}

// ---- 有意开放的 Any 字段保留 unknown（不机械消除） ----
type _requirementValueIsUnknown = Expect<IsUnknown<RequirementCandidate['value']>>
type _noteFieldValueIsUnknown = Expect<IsUnknown<NoteFieldCandidate['value']>>