// 生成物，请勿手改。来源：contract/proposals/assistant-v1/models.py
// 协议提案 assistant_protocol_version 1.1；目标业务契约 0.5.0（未生效）。生产代码不得 import 本文件。

/** 临时引用：key 只在一个草案版本内有效；正式 ID 由客户端采用时产生。 */
export interface DraftRef {
  kind?: "draft";
  key: string;
}

export interface ExistingRef {
  kind?: "existing";
  id: string;
}

/** 线程/草案对正式对象或草案的只读关联。 */
export interface ObjectRef {
  object_type: "source" | "note" | "task" | "action" | "plan_item" | "draft";
  id: string;
}

export interface SourceExcerptEvidence {
  kind?: "source_excerpt";
  source_id: string;
  excerpt: string;
  locator?: string | null;
}

export interface NoteFieldEvidence {
  kind?: "note_field";
  note_id: string;
  field_key: string;
}

export interface UserMessageEvidence {
  kind?: "user_message";
  turn_id: string;
  excerpt: string;
}

export interface ExistingFactEvidence {
  kind?: "existing_fact";
  object_type: "task" | "action" | "plan_item" | "focus_session" | "note" | "source";
  object_id: string;
  field_path: string;
}

export type FieldOrigin = "model" | "user";

/** 截止候选。模型不得输出 confirmed_at；确认发生在本地 Note/Task 字段。 */
export interface DeadlineCandidate {
  value?: string | null;
  precision?: "none" | "date" | "datetime";
  origin?: FieldOrigin;
  derived?: boolean;
  basis?: "explicit" | "relative" | "inferred";
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

export interface TaskProposalCreate {
  op?: "create";
  key: string;
  title: string;
  description?: string;
  completion_criteria?: string | null;
  deadline_candidates?: Array<DeadlineCandidate>;
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

/** 关联已有 Task：不改对象；必须选中明确 ID，不按名字自动合并。 */
export interface TaskProposalLink {
  op?: "link";
  key: string;
  target_id: string;
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

export interface TaskUpdateFields {
  title?: string | null;
  description?: string | null;
  completion_criteria?: string | null;
  deadline_candidates?: Array<DeadlineCandidate> | null;
}

/** 更新只允许 title/description/completion_criteria/deadline 四类字段。 */
export interface TaskProposalUpdate {
  op?: "update";
  key: string;
  target_id: string;
  changes: TaskUpdateFields;
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

export interface ActionProposalCreate {
  op?: "create";
  key: string;
  task_ref: DraftRef | ExistingRef;
  text: string;
  minutes: number;
  basis?: "requirement" | "suggestion";
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

/** 复用既有 Action：必须属于明确 Task；首版不批量修改或完成既有 Action。 */
export interface ActionProposalReuse {
  op?: "reuse";
  key: string;
  target_id: string;
  task_ref: ExistingRef;
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

export type Priority = "high" | "normal" | "low";

/** 本次剩余工作，不是历史投入换算。估时未知用 null，不能用 0。 */
export interface WorkItemProposal {
  key: string;
  task_ref: DraftRef | ExistingRef;
  action_ref: DraftRef | ExistingRef;
  deliverable: string;
  remaining_minutes?: number | null;
  estimate_origin?: FieldOrigin;
  splittable?: boolean;
  min_segment_minutes?: number;
  earliest_date?: string | null;
  depends_on?: Array<string>;
  priority?: Priority;
}

export interface PriorityRequirementValue {
  task_ref: DraftRef | ExistingRef;
  priority: Priority;
}

export interface SplittableRequirementValue {
  work_item_key: string;
  splittable: boolean;
}

export interface OrderingRequirementValue {
  before_key: string;
  after_key: string;
}

export type Strength = "hard" | "soft";

/** 约束候选白名单。confirmed 状态只能由本地交互产生，模型只建议。 */
export interface RequirementCandidate {
  key: string;
  type: "daily_budget" | "unavailable_days" | "start_date" | "task_priority" | "min_segment_minutes" | "splittable" | "ordering";
  value?: unknown;
  strength?: Strength;
  provenance?: "user" | "source" | "model";
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

export interface Assumption {
  id: string;
  text: string;
  /** 只能引用本版 work_items[].key（如 w1）；不得使用行动 key（如 a1）、任务 key 或正式 ID。 */
  related_keys?: Array<string>;
}

export interface ProposalWarning {
  code: "estimate_is_suggestion" | "deadline_ambiguous" | "capacity_unknown" | "soft_preference_unmet" | "source_parse_partial" | "possible_duplicate_task" | "extra_work_needs_confirmation";
  message: string;
  related_key?: string | null;
}

/** 模型只能建议；无授权、无持久化状态、无数据库命令。 */
export interface AssistantModelProposal {
  task_proposals?: Array<TaskProposalCreate | TaskProposalLink | TaskProposalUpdate>;
  action_proposals?: Array<ActionProposalCreate | ActionProposalReuse>;
  work_items?: Array<WorkItemProposal>;
  requirement_candidates?: Array<RequirementCandidate>;
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
  assumptions?: Array<Assumption>;
  warnings?: Array<ProposalWarning>;
}

export interface ClarificationQuestion {
  question_id: string;
  question: string;
  options?: Array<string>;
  blocking_reason: string;
  related_requirement_key?: string | null;
}

export interface ContentFingerprint {
  sha256: string;
  bytes: number;
}

export type FieldStatus = "candidate" | "confirmed" | "unresolved" | "missing";

/** 本地 Note 字段只读快照（含已确认状态）；模型不得在响应中输出 confirmed。 */
export interface NoteFieldCandidate {
  note_id: string;
  field_key: string;
  value?: unknown;
  raw?: string;
  origin?: FieldOrigin;
  status?: FieldStatus;
  derived?: boolean;
  quote_text?: string | null;
  precision?: "date" | "datetime" | null;
}

export interface SelectedSource {
  source_id: string;
  kind: "image" | "text";
  fingerprint: ContentFingerprint;
  excerpt?: string | null;
  note_candidates?: Array<NoteFieldCandidate>;
}

/** 既有 Task 截止事实快照（镜像 0.4.0 Deadline；confirmed_at 是本地事实，不是模型输出）。 */
export interface ExistingDeadline {
  value?: string | null;
  precision?: "none" | "date" | "datetime";
  source?: "note" | "manual";
  from_note_id?: string | null;
  confirmed_at?: string | null;
}

export type TaskStatus = "todo" | "doing" | "blocked" | "done";

export interface SelectedTask {
  id: string;
  title: string;
  status?: TaskStatus;
  deadline?: ExistingDeadline;
  current_action_id?: string | null;
  updated_at: string;
}

export interface SelectedAction {
  id: string;
  task_id: string;
  text: string;
  minutes: number;
  basis?: "requirement" | "suggestion" | "user";
  done?: boolean;
}

export interface ContextDayBudget {
  date: string;
  budget_minutes?: number | null;
  committed_minutes?: number;
}

export type PlanItemState = "planned" | "done" | "partial" | "moved" | "cancelled";

export interface ProtectedPlanSummary {
  plan_item_id: string;
  task_id: string;
  date: string;
  planned_minutes: number;
  state: PlanItemState;
}

export interface PlanningContext {
  timezone?: "Asia/Shanghai";
  today: string;
  start_date: string;
  horizon_days?: 7;
  days: Array<ContextDayBudget>;
  protected_plans?: Array<ProtectedPlanSummary>;
}

/** 本地经用户确认的约束；服务端接收到它也不获得数据库权限。 */
export interface ConfirmedRequirement {
  requirement_id: string;
  version: number;
  type: "daily_budget" | "unavailable_days" | "start_date" | "task_priority" | "min_segment_minutes" | "splittable" | "ordering";
  value?: unknown;
  strength?: Strength;
  confirmed_at: string;
  evidence_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

export interface PreviousDraft {
  draft_id: string;
  revision: number;
  scope_keys?: Array<string>;
  proposal: AssistantModelProposal;
  modification_summary?: string;
}

/** 一轮澄清的结构化记录。user_answer 由客户端按用户实际提交填写，绝不来自模型输出； */
export interface ClarificationTurnRecord {
  assistant_question: string;
  user_answer: string;
}

export type Intent = "new_plan" | "revise_draft" | "explain_today" | "replan_task";

/** 用户本轮进展说明与待安排清单；由前端实际提交形成，与模型建议分开。 */
export interface ProgressInput {
  statement?: string;
  work_items: Array<ProgressWorkItem>;
}

/** 用户明确填入/确认的本次待安排工作行；不是模型建议，不从模型文字解析。 */
export interface ProgressWorkItem {
  key: string;
  text: string;
  reuse_action_id?: string | null;
  minutes?: number | null;
  splittable?: boolean;
  min_segment_minutes?: number | null;
}

/** replan_task 专属受限上下文：单任务 + 用户进展/清单 + 待替换/保留摘要。 */
export interface ReplanContext {
  task_id: string;
  progress: ProgressInput;
  replacements: Array<ReplanPlanSummary>;
  kept?: Array<ReplanPlanSummary>;
}

/** 改排上下文里的旧安排摘要（待替换/保留共用）；机器快照，不是用户回答。 */
export interface ReplanPlanSummary {
  plan_item_id: string;
  date: string;
  planned_minutes: number;
  action_text: string;
  state: PlanItemState;
}

/** 真实用户输入的结构化记录：核验「用户明确要求」只读 original_user_request 与各 user_answer， */
export interface UserAuthoredInput {
  original_user_request: string;
  clarifications?: Array<ClarificationTurnRecord>;
}

export interface AssistantProposeRequest {
  protocol_version?: "1.0" | "1.1";
  request_id: string;
  thread_id: string;
  turn_id: string;
  client_seq: number;
  workspace_id: string;
  intent: Intent;
  user_message?: string;
  user_input?: UserAuthoredInput | null;
  selected_sources?: Array<SelectedSource>;
  selected_tasks?: Array<SelectedTask>;
  selected_actions?: Array<SelectedAction>;
  planning_context: PlanningContext;
  confirmed_requirements?: Array<ConfirmedRequirement>;
  pending_requirements?: Array<RequirementCandidate>;
  previous_draft?: PreviousDraft | null;
  replan_context?: ReplanContext | null;
}

export interface ClarificationPayload {
  kind?: "clarification";
  questions: Array<ClarificationQuestion>;
  ready?: false;
}

export interface ProposalPayload {
  kind?: "proposal";
  proposal: AssistantModelProposal;
}

/** 基于请求中已存在的事实说明；不携带隐式新建、删除或开始命令。 */
export interface ExplanationPayload {
  kind?: "explanation";
  explanation: string;
  fact_refs?: Array<SourceExcerptEvidence | NoteFieldEvidence | UserMessageEvidence | ExistingFactEvidence>;
}

/** 关联字段由服务端从请求复制，不让模型填写。协议版本=被接受请求版本。 */
export interface AssistantProposeResponse {
  protocol_version?: "1.0" | "1.1";
  request_id: string;
  thread_id: string;
  turn_id: string;
  client_seq: number;
  workspace_id: string;
  summary?: string;
  payload: ClarificationPayload | ProposalPayload | ExplanationPayload;
}

/** 复用现有 ApiError 外形；code 仍为开放字符串。 */
export interface ProposalApiError {
  code: string;
  message: string;
  retryable?: boolean;
  detail?: unknown;
}

/** 排程所需的任务事实：截止与逾期补做授权。截止不等于安排日。 */
export interface PlanningTaskFact {
  task_ref: DraftRef | ExistingRef;
  title: string;
  deadline_value?: string | null;
  deadline_precision?: "none" | "date" | "datetime";
  overdue_consent?: boolean;
  status?: TaskStatus;
}

export interface DayBudget {
  date: string;
  budget_minutes: number;
}

/** v0.4：活引用状态。deleted 后原 id 只是历史标识，禁止当活链接使用。 */
export type RefState = "active" | "deleted";

/** 按唯一 PlanItem ID 计占用。planned/partial/done 保守计入；cancelled/moved 不占用。 */
export interface OccupancyEntry {
  plan_item_id: string;
  task_id: string;
  date: string;
  planned_minutes: number;
  state: PlanItemState;
  task_ref_state?: RefState;
}

export interface PlanningWorkItem {
  key: string;
  task_ref: DraftRef | ExistingRef;
  action_ref: DraftRef | ExistingRef;
  deliverable: string;
  remaining_minutes?: number | null;
  estimate_origin?: FieldOrigin;
  splittable?: boolean;
  min_segment_minutes?: number;
  earliest_date?: string | null;
  depends_on?: Array<string>;
  priority?: Priority;
}

export interface PlanningInput {
  algorithm_version?: "daily-v1";
  timezone?: "Asia/Shanghai";
  today?: string | null;
  start_date: string;
  horizon_days?: 7;
  buffer_pct?: number;
  days: Array<DayBudget>;
  task_facts?: Array<PlanningTaskFact>;
  work_items?: Array<PlanningWorkItem>;
  occupancy?: Array<OccupancyEntry>;
  replacement_ids?: Array<string>;
  extra_work_acknowledged?: Array<string>;
}

/** 建议段。不含真实计时或完成结果；order 是当日明确顺序，不保证具体小时。 */
export interface Segment {
  segment_key: string;
  work_item_key: string;
  task_ref: DraftRef | ExistingRef;
  suggested_action_ref: DraftRef | ExistingRef;
  date: string;
  minutes: number;
  order: number;
  action_text: string;
  deliverable: string;
}

/** allocatable=floor(budget×(100-buffer_pct)/100)；free=max(0,allocatable-committed-allocated)。 */
export interface DaySummary {
  date: string;
  budget_minutes: number;
  buffer_minutes: number;
  committed_minutes: number;
  allocated_minutes: number;
  free_minutes: number;
  overbooked_minutes: number;
}

export type UnscheduledReason = "no_capacity" | "not_splittable" | "dependency_blocked" | "outside_horizon" | "deadline_window" | "needs_deadline_day_window" | "overdue_requires_consent";

export interface UnscheduledEntry {
  work_item_key: string;
  remaining_minutes: number;
  reason: UnscheduledReason;
}

export interface UnknownItem {
  work_item_key: string;
  reason?: "estimate_missing";
}

export interface ExcludedItem {
  work_item_key: string;
  excluded_by?: "user";
  reason: string;
}

export interface PlanningConflict {
  code: "hard_constraint_violation" | "invalid_occupancy" | "dependency_cycle" | "unknown_predecessor" | "cross_workspace_ref" | "overdue_without_consent";
  message: string;
  related_keys?: Array<string>;
}

export interface PlanningWarning {
  code: "existing_overbook" | "datetime_deadline_conservative" | "overdue_scheduled" | "heuristic_incomplete" | "unrecorded_calendar_notice" | "window_end_not_deadline";
  message: string;
  related_key?: string | null;
}

export interface PlanningResult {
  segments?: Array<Segment>;
  days: Array<DaySummary>;
  unscheduled?: Array<UnscheduledEntry>;
  unknown_items?: Array<UnknownItem>;
  excluded_items?: Array<ExcludedItem>;
  conflicts?: Array<PlanningConflict>;
  warnings?: Array<PlanningWarning>;
  complete?: boolean;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  type?: "text" | "understanding" | "clarification" | "proposal_card" | "schedule_card" | "change_summary" | "conflict_card" | "adoption_result";
  refs?: Array<ObjectRef>;
  created_at: string;
  user_input?: UserAuthoredInput | null;
}

export interface AssistantThread {
  id: string;
  record_version?: 1;
  workspace_id: string;
  title?: string;
  messages?: Array<ThreadMessage>;
  selected_refs?: Array<ObjectRef>;
  confirmed_requirements?: Array<ConfirmedRequirement>;
  created_at: string;
  updated_at: string;
}

/** 所选旧安排的完整语义快照（M3 §6.1）；历史字段无 updated_at，复核比内容不比时间戳。 */
export interface PlanItemSnapshot {
  plan_item_id: string;
  task_id: string;
  date: string;
  planned_minutes: number;
  action_text: string;
  state?: "planned";
  order: number;
  actual_minutes?: null;
  focus_session_id?: null;
  task_ref_state?: "active";
}

/** 替换基线：逐条完整快照 + 捕获时全空间 FocusSession 扫描清单（无引用前提的记录）。 */
export interface ReplacementBaseline {
  captured_at: string;
  items: Array<PlanItemSnapshot>;
  focus_session_ids?: Array<string>;
}

/** 一次只调整一个任务；替换集只由本地用户逐条勾选产生，模型不得产生。 */
export interface ReplanScope {
  task_id: string;
  start_date: string;
  replacement_ids: Array<string>;
}

/** 旧版本只读快照；不能采用。整体受单草案 1MiB 约束。 */
export interface DraftRevisionSnapshot {
  revision: number;
  proposal?: AssistantModelProposal | null;
  planning_input?: PlanningInput | null;
  planning_result?: PlanningResult | null;
  requirements?: Array<RequirementCandidate>;
  replan_scope?: ReplanScope | null;
  progress_input?: ProgressInput | null;
  replacement_baseline?: ReplacementBaseline | null;
  created_at: string;
}

/** 确认绑定草案版本+字段+值；改值使旧确认失效。确认≠改值。 */
export interface UserConfirmation {
  confirmation_id: string;
  draft_revision: number;
  object_type: "task" | "note_field" | "requirement" | "gap" | "overbook" | "extra_work" | "replan_scope";
  object_id_or_key: string;
  id_scope?: "draft" | "formal" | null;
  field_path?: string;
  old_value?: unknown;
  new_value?: unknown;
  confirmed_at: string;
}

export interface SourceFingerprint {
  source_id: string;
  sha256: string;
  bytes: number;
}

export interface NoteFieldBaseline {
  note_id: string;
  field_key: string;
  value?: unknown;
  status?: FieldStatus;
  origin?: FieldOrigin;
  derived?: boolean;
}

/** 复用行动的内容基线（M1 审查 R5）：预览/采用依赖的归属、正文、估时与完成状态。 */
export interface PlanningActionFact {
  action_ref: DraftRef | ExistingRef;
  task_id: string;
  text: string;
  minutes: number;
  done?: boolean;
}

/** 事务外冻结的事实快照；内容哈希只用于前置快照与证据，不在活事务内读 Blob 计算。 */
export interface FactBaseline {
  captured_at: string;
  task_facts?: Array<PlanningTaskFact>;
  action_facts?: Array<PlanningActionFact>;
  source_fingerprints?: Array<SourceFingerprint>;
  note_field_baselines?: Array<NoteFieldBaseline>;
  occupancy?: Array<OccupancyEntry>;
}

export interface IdMapEntry {
  draft_key: string;
  formal_id: string;
  object_type: "task" | "action" | "plan_item";
}

export interface ApplicationCounts {
  tasks_created: number;
  tasks_updated: number;
  actions_created: number;
  plan_items_created: number;
  plan_items_cancelled?: number;
  source_fields_confirmed: number;
}

/** 已应用草案的历史结果摘要；展示用，不是可执行回执。 */
export interface AppliedSummary {
  application_id: string;
  counts: ApplicationCounts;
  id_map?: Array<IdMapEntry>;
  unscheduled_kept?: Array<UnscheduledEntry>;
  cancelled_plan_item_ids?: Array<string>;
  replan_task_id?: string | null;
  applied_at: string;
}

export type DraftStatus = "editing" | "generating" | "needs_clarification" | "ready" | "needs_review" | "applying" | "applied" | "result_unknown" | "discarded";

export interface AssistantDraft {
  id: string;
  record_version?: 1;
  workspace_id: string;
  thread_id: string;
  revision: number;
  revision_history?: Array<DraftRevisionSnapshot>;
  status?: DraftStatus;
  mode?: "create" | "replan";
  proposal?: AssistantModelProposal | null;
  planning_input?: PlanningInput | null;
  planning_result?: PlanningResult | null;
  fact_baseline?: FactBaseline | null;
  replan_scope?: ReplanScope | null;
  progress_input?: ProgressInput | null;
  replacement_baseline?: ReplacementBaseline | null;
  assumptions?: Array<Assumption>;
  user_confirmations?: Array<UserConfirmation>;
  excluded_items?: Array<ExcludedItem>;
  source_refs?: Array<ObjectRef>;
  applied_summary?: AppliedSummary | null;
  created_at: string;
  updated_at: string;
}

/** 采用时写入 Note 字段确认；保留 origin/derived/quote，确认≠改值。 */
export interface SourceFieldConfirmation {
  note_id: string;
  field_key: string;
  confirmed_value?: unknown;
  origin?: FieldOrigin;
  derived?: boolean;
}

/** 只有日期就保持日期精度，不补 23:59（PRD F07）。来源可为便签或用户手动（P05）。 */
export interface Deadline {
  value?: string | null;
  precision?: "none" | "date" | "datetime";
  source?: "note" | "manual";
  from_note_id?: string | null;
  confirmed_at?: string | null;
}

export interface PreparedTaskCreate {
  formal_id: string;
  workspace_id: string;
  title: string;
  description?: string;
  completion_criteria?: string | null;
  deadline?: Deadline;
  note_ids?: Array<string>;
  matter_id?: string | null;
  status?: "todo";
  created_at: string;
  updated_at: string;
}

export interface PreparedTaskUpdate {
  target_id: string;
  expected_updated_at: string;
  changes: TaskUpdateFields;
}

export interface PreparedActionCreate {
  formal_id: string;
  workspace_id: string;
  task_id: string;
  text: string;
  minutes: number;
  basis?: "requirement" | "suggestion" | "user";
  done?: false;
  created_at: string;
}

/** 新 PlanItem 初始 planned、actual_minutes=null、focus_session_id=null、task_ref_state=active。 */
export interface PreparedPlanItemCreate {
  formal_id: string;
  workspace_id: string;
  task_id: string;
  date: string;
  planned_minutes: number;
  action_text: string;
  state?: "planned";
  actual_minutes?: null;
  focus_session_id?: null;
  order: number;
  task_ref_state?: "active";
}

/** 受限取消写集唯一形状（M3 §7）：预期内容全等 + 仅 planned→cancelled，其余字段保留。 */
export interface PlannedCancellation {
  plan_item_id: string;
  expected: PlanItemSnapshot;
  new_state?: "cancelled";
}

/** 完整准备写集。M3 增加受限取消分支；tasks_update/字段确认写入仍由前端领域层拒绝。 */
export interface PreparedWriteSet {
  source_field_confirmations?: Array<SourceFieldConfirmation>;
  tasks_create?: Array<PreparedTaskCreate>;
  tasks_update?: Array<PreparedTaskUpdate>;
  actions_create?: Array<PreparedActionCreate>;
  plan_items_create?: Array<PreparedPlanItemCreate>;
  plan_items_cancel?: Array<PlannedCancellation>;
  thread_result_update?: ThreadMessage | null;
}

export interface ApplicationEnvelope {
  application_id: string;
  workspace_id: string;
  draft_id: string;
  draft_revision: number;
  mode?: "create" | "replan";
  input_signature: string;
  id_map?: Array<IdMapEntry>;
  write_set: PreparedWriteSet;
  fact_baseline: FactBaseline;
  replan_scope?: ReplanScope | null;
  replacement_baseline?: ReplacementBaseline | null;
  capacity_baseline: Array<DaySummary>;
  user_confirmations?: Array<UserConfirmation>;
  planned_gaps?: Array<UnscheduledEntry>;
  gap_acknowledged?: boolean;
  overbook_acknowledged?: boolean;
  existing_overbook_dates?: Array<string>;
  issued_at: string;
}

/** 只能由本地成功事务产生。 */
export interface ApplicationReceipt {
  application_id: string;
  draft_id: string;
  draft_revision: number;
  input_signature: string;
  id_map?: Array<IdMapEntry>;
  counts: ApplicationCounts;
  unscheduled_kept?: Array<UnscheduledEntry>;
  cancelled_plan_item_ids?: Array<string>;
  replan_task_id?: string | null;
  committed_at: string;
}

/** assistant_ops 台账：pending 保留冻结信封，committed 保留回执。首版不自动清理。 */
export interface AssistantOpRecord {
  application_id: string;
  workspace_id: string;
  state: "pending" | "committed";
  envelope?: ApplicationEnvelope | null;
  receipt?: ApplicationReceipt | null;
  created_at: string;
  updated_at: string;
}

export interface AssistantThreadsPayload {
  schema_version?: "0.5.0" | "0.6.0";
  threads?: Array<AssistantThread>;
}

export interface AssistantDraftsPayload {
  schema_version?: "0.5.0" | "0.6.0";
  drafts?: Array<AssistantDraft>;
}

export interface PayloadEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** v2 必需 payload 含助手两文件（即使为空）。不导出 assistant_ops/在途请求/owner/租约/可重放写集。 */
export interface BackupManifestV2 {
  format: "jxl-backup";
  backup_format_version?: 2;
  schema_version?: "0.5.0" | "0.6.0";
  backup_id: string;
  exported_at: string;
  source_workspace: Record<string, unknown>;
  counts: Record<string, number>;
  source_count: number;
  image_count: number;
  payloads: Array<PayloadEntry>;
}

/** 一份样本：正向接受 / 负向拒绝 / 场景预期（设计验证）。全部虚构。 */
export interface FixtureCase {
  id: string;
  title: string;
  layer: "http" | "model" | "planning" | "draft" | "application" | "backup" | "scenario";
  mode: "accept" | "reject" | "expect";
  target: string;
  acceptance?: Array<string>;
  implement_batch: string;
  payload?: unknown;
  expected_error?: string | null;
  expected?: unknown;
  notes?: string;
}
