// 生成物，请勿手改。来源：contract/models.py（schema_version 0.4.0）
// 供 Vue 3 + JavaScript 项目在 jsconfig.json 开启 checkJs 后做编辑器与 CI 校验。

/** 原文引用。引用存在不等于已核实（PRD 规则 4）。 */
export interface Quote {
  text: string;
  source_id: string;
}

/** v0.3：一个时间节点。模型给候选角色与参照，后端按语义选主，不靠 label 关键词或任意最小值。 */
export interface TimeNode {
  label?: string;
  raw?: string;
  value?: string | null;
  precision?: "date" | "datetime" | null;
  tz_known?: boolean | null;
  basis?: "explicit" | "relative" | "inferred" | "superseded";
  role?: "submission_deadline" | "event_start" | "event_end" | "other" | "unknown";
  reference_at?: string | null;
  reference_source?: "message_date" | "user" | null;
  message_date?: string | null;
  derived?: boolean;
}

export type FieldOrigin = "model" | "user";

export type FieldStatus = "candidate" | "confirmed" | "unresolved" | "missing";

/** 便签的每个重要字段。一个结构承载规则 2/4/7 与 F03 的字段级确认。 */
export interface Field {
  key: string;
  value?: unknown;
  raw?: string;
  origin?: FieldOrigin;
  status?: FieldStatus;
  derived?: boolean;
  quote?: Quote | null;
  precision?: "date" | "datetime" | null;
  tz_known?: boolean | null;
}

/** 只有日期就保持日期精度，不补 23:59（PRD F07）。来源可为便签或用户手动（P05）。 */
export interface Deadline {
  value?: string | null;
  precision?: "none" | "date" | "datetime";
  source?: "note" | "manual";
  from_note_id?: string | null;
  confirmed_at?: string | null;
}

export interface Warning {
  code: "demo_data" | "origin_unknown" | "relative_date_derived" | "date_year_inferred" | "candidate_without_value" | "timezone_unspecified" | "possible_deadline_change" | "no_deadline_in_source" | "deadline_unselectable";
  message: string;
  field_key?: string | null;
}

export type ContentType = "notice" | "tutorial" | "reference";

export type SourceKind = "image" | "text";

export interface AnalyzeRequest {
  source_id: string;
  kind: SourceKind;
  image_base64?: string | null;
  text?: string | null;
  captured_at: string;
  content_hint?: ContentType | null;
  reference_at?: string | null;
}

export interface AnalyzeResponse {
  source_id: string;
  content_type: ContentType;
  fields: Array<Field>;
  warnings?: Array<Warning>;
  analyzed_at: string;
  model_name: string;
  schema_version?: string;
}

export interface HealthResponse {
  model_ready: boolean;
  api_version?: string;
  schema_version?: string;
}

export interface MatterBrief {
  id: string;
  title: string;
}

export interface TaskBrief {
  id: string;
  title: string;
  deadline?: string | null;
}

export interface MatchRequest {
  note_id: string;
  note_summary: string;
  matters?: Array<MatterBrief>;
  tasks?: Array<TaskBrief>;
}

export interface MatchSuggestion {
  matter_id: string;
  confidence: number;
  reason: string;
}

/** 不确定时返回空数组，不强行归组（F05 第 231 行）。 */
export interface MatchResponse {
  suggestions?: Array<MatchSuggestion>;
}

export interface SuggestActionRequest {
  task_id: string;
  title: string;
  confirmed_fields?: Array<Field>;
  available_minutes: number;
  note_summaries?: Array<string>;
}

export type ActionBasis = "requirement" | "suggestion" | "user";

export interface SuggestActionResponse {
  text: string;
  minutes: number;
  basis: ActionBasis;
  evidence?: string | null;
}

/** 自然语言解析结果。任何不可靠项进 unresolved，绝不返回可直接入库的对象。 */
export interface TaskDraft {
  title: string;
  due_raw?: string | null;
  due_derived?: string | null;
  effort_raw?: string | null;
  effort_minutes?: number | null;
  unresolved?: Array<string>;
}

export interface ParseTasksRequest {
  text: string;
  reference_date?: string | null;
}

export interface ParseTasksResponse {
  tasks?: Array<TaskDraft>;
  warnings?: Array<Warning>;
}

export interface ApiError {
  code: string;
  message: string;
  retryable?: boolean;
  detail?: unknown;
}

export interface Source {
  id: string;
  workspace_id: string;
  kind: SourceKind;
  image_ref?: string | null;
  text?: string | null;
  captured_at: string;
  origin_url?: string | null;
  origin_title?: string | null;
  is_demo?: boolean;
}

export type MatterRole = "requirement" | "supplement" | "reference" | "outcome" | "other";

export type NoteStatus = "pending" | "draft" | "reviewed" | "failed";

export interface Note {
  id: string;
  workspace_id: string;
  source_id: string;
  status: NoteStatus;
  content_type: ContentType;
  title: string;
  fields?: Array<Field>;
  matter_id?: string | null;
  matter_role?: MatterRole | null;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  is_demo?: boolean;
}

export interface Matter {
  id: string;
  workspace_id: string;
  title: string;
  note_ids?: Array<string>;
  created_at: string;
  is_demo?: boolean;
}

export type TaskStatus = "todo" | "doing" | "blocked" | "done";

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  description?: string;
  matter_id?: string | null;
  note_ids?: Array<string>;
  deadline?: Deadline;
  status?: TaskStatus;
  completion_criteria?: string | null;
  current_action_id?: string | null;
  created_at: string;
  updated_at: string;
  is_demo?: boolean;
}

export interface Action {
  id: string;
  workspace_id: string;
  task_id: string;
  text: string;
  minutes: number;
  basis?: ActionBasis;
  done?: boolean;
  created_at: string;
}

/** v0.4：会话开始时冻结的任务事实。不随活对象改名重写；不是原始资料备份。 */
export interface TaskSnapshot {
  title: string;
  matter_name?: string | null;
  deadline_value?: string | null;
  deadline_precision?: "none" | "date" | "datetime";
  captured_at: string;
}

/** v0.4：会话开始时冻结的行动事实。 */
export interface ActionSnapshot {
  text: string;
  minutes: number;
  captured_at: string;
}

export type FocusOutcome = "done" | "partial" | "blocked";

/** v0.4：活引用状态。deleted 后原 id 只是历史标识，禁止当活链接使用。 */
export type RefState = "active" | "deleted";

/** 墙上时钟：started_at（首次开始，不变）+ accumulated_ms（已提交累计）+ timer_anchor_at（本段起点）。 */
export interface FocusSession {
  id: string;
  workspace_id: string;
  task_id: string;
  action_id: string;
  plan_item_id?: string | null;
  started_at: string;
  accumulated_ms?: number;
  running?: boolean;
  draft_md?: string;
  outcome?: FocusOutcome | null;
  blocker?: string | null;
  ended_at?: string | null;
  is_demo?: boolean;
  /** 0=旧记录（0.3.0 形态），1=3B 起新会话；分版本校验，不混用 */
  record_version?: 0 | 1;
  /** 运行中本段尚未计入 accumulated_ms 的起点；v1 运行中必填，暂停/结束必须为 null */
  timer_anchor_at?: string | null;
  /** 开始时冻结的任务标题/事项名称/截止值及精度/捕获时刻；v1 必填 */
  task_snapshot?: TaskSnapshot | null;
  /** 开始时冻结的行动文本/预计分钟/捕获时刻；v1 必填 */
  action_snapshot?: ActionSnapshot | null;
  /** 任务活引用状态；deleted 后 task_id 只是历史标识；v1 必填，v0 必须缺席 */
  task_ref_state?: RefState | null;
  /** 行动活引用状态，与任务独立；v1 必填，v0 必须缺席 */
  action_ref_state?: RefState | null;
}

export type PlanItemState = "planned" | "done" | "partial" | "moved" | "cancelled";

/** 只引用 task_id，永不回写 Task（规则 11/12）。 */
export interface PlanItem {
  id: string;
  workspace_id: string;
  task_id: string;
  date: string;
  planned_minutes: number;
  action_text: string;
  state?: PlanItemState;
  actual_minutes?: number | null;
  /** 最近一次已结束专注会话的快捷引用；全部历史以 FocusSession.plan_item_id 反查 */
  focus_session_id?: string | null;
  order?: number;
  /** 任务活引用状态；旧记录缺省 active；planned 条目不得 deleted */
  task_ref_state?: RefState;
}

export interface Unscheduled {
  task_id: string;
  gap_minutes: number;
  reason: "no_capacity" | "no_due_date" | "not_splittable" | "before_start_date" | "outside_horizon";
}

/** 未确认的草案。gap_total 必填，使「假装排完」无法表达（F13.3）。 */
export interface PlanDraft {
  id: string;
  workspace_id: string;
  horizon_days: number;
  daily_budgets: Record<string, number>;
  buffer_pct?: number;
  items?: Array<PlanItem>;
  unscheduled?: Array<Unscheduled>;
  gap_total?: number;
  created_at: string;
  confirmed_at?: string | null;
}

export type ProposalStatus = "pending" | "accepted" | "dismissed";

/** F06（P1）：只产生候选，用户确认前不得改动任务。 */
export interface ChangeProposal {
  id: string;
  workspace_id: string;
  task_id: string;
  old_note_id: string;
  new_note_id: string;
  old_value: string;
  new_value: string;
  evidence: Array<Quote>;
  status?: ProposalStatus;
  created_at: string;
  resolved_at?: string | null;
}

/** 一份 fixture 同时服务三处：后端测试输入、前端 mock 响应、F12 演示空间。 */
export interface Fixture {
  id: string;
  title: string;
  kind: "analysis" | "workspace";
  is_demo?: boolean;
  depends_on?: Array<string>;
  acceptance?: Array<string>;
  source?: Source | null;
  analyze_request?: AnalyzeRequest | null;
  expected_analysis?: AnalyzeResponse | null;
  confirmed_note?: Note | null;
  matter?: Matter | null;
  task?: Task | null;
  action?: Action | null;
  focus_session?: FocusSession | null;
  plan_items?: Array<PlanItem>;
  change_proposal?: ChangeProposal | null;
}
