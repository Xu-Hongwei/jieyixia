"""「截下来」契约 v0.1 —— 唯一手写来源。

schema.json 与 typedefs.d.ts 由 generate.py 从本文件导出，不要手改生成物。
业务规则尽量写进 validator，让违规数据在边界处就被拒绝，而不是靠前端自觉。
"""

from __future__ import annotations

import re
from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, model_validator

SCHEMA_VERSION = "0.3.0"
API_VERSION = "v1"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)?$")
# v0.2：deadline 只接受单一 date 或规范 datetime（YYYY-MM-DDTHH:MM:SS±HH:MM）
DEADLINE_VALUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)?)?$")

# v0.2：键集合按内容类型封闭。title/deadline 通用；其余按类型。
UNIVERSAL_KEYS = {"title", "deadline"}
TYPE_KEYS = {
    "notice": {"requirement", "constraints", "submit_to", "reminder", "time_nodes"},
    "tutorial": {"summary", "steps", "cautions"},
    "reference": {"summary", "keywords"},
}
# v0.2.1 放宽：多条要求/提醒/步骤在真实通知里常见，数组更忠实；消费端两种形状都渲染
STR_OR_LIST_KEYS = {"requirement", "constraints", "reminder", "steps", "cautions", "keywords"}

# ---------------------------------------------------------------- v0.3 V3-1：语义单一来源
# 提示词由 render_prompt 从这些结构渲染生成，不再手写散文；validators 与 schema 共用同一来源。

FIELD_SEMANTICS: dict[str, dict[str, str]] = {
    "notice": {
        "title": "标题",
        "requirement": "要做什么、提交什么材料；多条可用字符串数组",
        "deadline": "行动时间节点：提交类取最早硬性提交/完成截止；活动/宣讲/培训类取最早开始时间；其余节点进 constraints；不要把多个日期拼进一个 value",
        "constraints": "字数/格式/实验组数等硬性限制，以及带标签的时间窗口、地点、其余场次或截止节点；字符串或字符串数组",
        "submit_to": "提交入口或提交对象",
        "reminder": "逾期后果、提醒类语句；不要放进 constraints",
        "time_nodes": "全部时间节点（notice 必须输出，不得只给 deadline）：每节点 label/raw/value/basis/role/reference_at/reference_source/message_date；role 候选 submission_deadline/event_start/event_end/other/unknown；reference_source 只能 message_date/user；deadline 由后端仅从 submission_deadline 选主",
    },
    "tutorial": {
        "title": "标题",
        "deadline": "如有明确时间节点（提交/截止）则填；无则 missing",
        "summary": "概括原文；可归纳但 quote 必须指向支撑片段",
        "steps": "操作步骤；段落叙述也归纳成字符串数组",
        "cautions": "注意事项；字符串数组",
    },
    "reference": {
        "title": "标题",
        "deadline": "如有明确时间节点（提交/截止）则填；无则 missing",
        "summary": "概括原文；可归纳但 quote 必须指向支撑片段",
        "keywords": "检索关键词；字符串数组",
    },
}

STATUS_SEMANTICS: dict[str, str] = {
    "candidate": "原文可确定的事实候选，待用户确认；value 不得为 null",
    "unresolved": "仅用于原文时间或事实无法确定（相对时间、缺年份、模糊表述）；多场次/多选项是确定事实，用 candidate+数组，不得标 unresolved",
    "missing": "原文没写；value=null、raw=\"\"；绝不推测补造",
    "confirmed": "只能由用户标记，模型不得输出；用户确认推算值时保留 derived=true 与原文引用（origin=user）",
}

TIME_RULES: list[str] = [
    "所有时间节点抽进 time_nodes，并给候选 role：submission_deadline（提交/完成截止）/event_start/event_end/other/unknown；basis 只能取 explicit（原文明确）/relative（相对换算）/inferred（补年）/superseded（被取代）；不得用 label 关键词代替 role",
    "活动开始、结束、补班日、背景日期不是 submission_deadline；它们保留在 time_nodes 按角色展示，不自动成为任务截止",
    "被新通知取代的旧日期标 basis=superseded，保留供溯源，不参与选主",
    "相对时间由你换算并标 basis=relative，且必须给 reference_at 与 reference_source：可靠参照只有两种——消息自身明确的绝对日期（message_date，reference_at 必须等于它）或用户指定参照（user，请求里会给出）；保存/收集时间 captured_at 永远不是可靠参照，当天保存也不行",
    "无可靠参照时相对节点 value=null、unresolved，展示原文；换算不出允许空，不硬算",
    "只有月日没有年份：参照可靠 reference_at 补年，basis=inferred",
    "原文明确绝对日期：value 用 YYYY-MM-DD；只有日期不补时刻（不补 23:59）；原文带时刻才用完整 ISO 日期时间",
    "「24:00」表示当日结束：输出 date 精度，不要输出 T24:00",
    "不要自行补时区：原文没有的时区不要写进 value",
    "deadline 由后端仅从 role=submission_deadline 且非 superseded 的节点中、在可比较候选里取最早；无有效截止或角色/比较关系不明时 deadline 缺席或为空，交用户选择",
]

CHAT_RULES: list[str] = [
    "聊天窗口截图只整理主消息气泡正文；忽略侧栏会话列表、群成员列表、与气泡无关的群公告",
    "不得把成员昵称或老师姓名当作 submit_to / reminder",
    "气泡内引用或转发的其它通知以气泡正文为准",
]

EXCLUSION_RULES: list[str] = [
    "礼貌语（请知悉/谢谢/收到请回复）、纯背景原因（如「因平台维护」）、宣传鼓励语不进任何字段；只有当原因构成限制或后果时才进 constraints / reminder",
    "只输出原文事实候选，不输出行动建议，不把推测写成要求",
    "每个 candidate/unresolved 字段必须带 raw 与 quote.text，逐字摘自原文不得改写；概括类字段（summary/keywords）的 quote 指向支撑片段",
]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- 枚举


class ContentType(str, Enum):
    notice = "notice"
    tutorial = "tutorial"
    reference = "reference"


class FieldStatus(str, Enum):
    candidate = "candidate"
    confirmed = "confirmed"
    unresolved = "unresolved"
    missing = "missing"


class FieldOrigin(str, Enum):
    model = "model"
    user = "user"


class NoteStatus(str, Enum):
    pending = "pending"
    draft = "draft"
    reviewed = "reviewed"
    failed = "failed"


class TaskStatus(str, Enum):
    todo = "todo"
    doing = "doing"
    blocked = "blocked"
    done = "done"


class MatterRole(str, Enum):
    requirement = "requirement"
    supplement = "supplement"
    reference = "reference"
    outcome = "outcome"
    other = "other"


class ActionBasis(str, Enum):
    requirement = "requirement"
    suggestion = "suggestion"
    user = "user"


class FocusOutcome(str, Enum):
    done = "done"
    partial = "partial"
    blocked = "blocked"


class PlanItemState(str, Enum):
    planned = "planned"
    done = "done"
    partial = "partial"
    moved = "moved"
    cancelled = "cancelled"


class ProposalStatus(str, Enum):
    pending = "pending"
    accepted = "accepted"
    dismissed = "dismissed"


class SourceKind(str, Enum):
    image = "image"
    text = "text"


# ---------------------------------------------------------------- 值对象


class Quote(ContractModel):
    """原文引用。引用存在不等于已核实（PRD 规则 4）。"""

    text: str
    source_id: str


class TimeNode(ContractModel):
    """v0.3：一个时间节点。模型给候选角色与参照，后端按语义选主，不靠 label 关键词或任意最小值。"""

    label: str = ""
    raw: str = ""
    value: str | None = None
    precision: Literal["date", "datetime"] | None = None
    tz_known: bool | None = None
    basis: Literal["explicit", "relative", "inferred", "superseded"] = "explicit"
    role: Literal["submission_deadline", "event_start", "event_end", "other", "unknown"] = "unknown"
    reference_at: str | None = None
    reference_source: Literal["message_date", "user"] | None = None
    message_date: str | None = None
    derived: bool = False

    @model_validator(mode="after")
    def _check(self) -> TimeNode:
        if self.value is not None and not DEADLINE_VALUE_RE.match(self.value):
            raise ValueError("time_node.value 必须是单一 date 或规范 datetime")
        if self.basis in ("relative", "inferred") and not self.derived:
            raise ValueError("relative/inferred 节点必须标 derived")
        if self.reference_at is not None and not DATE_RE.match(self.reference_at):
            raise ValueError("reference_at 必须是 YYYY-MM-DD")
        if self.message_date is not None and not DATE_RE.match(self.message_date):
            raise ValueError("message_date 必须是 YYYY-MM-DD")
        return self


class Field(ContractModel):
    """便签的每个重要字段。一个结构承载规则 2/4/7 与 F03 的字段级确认。"""

    key: str
    value: Any = None
    raw: str = ""
    origin: FieldOrigin = FieldOrigin.model
    status: FieldStatus = FieldStatus.candidate
    derived: bool = False
    quote: Quote | None = None
    # v0.2.1 additive：时间格式元数据，前端据此确定性渲染，不再猜字符串形状
    precision: Literal["date", "datetime"] | None = None
    tz_known: bool | None = None

    @model_validator(mode="after")
    def _check(self) -> Field:
        if self.status is FieldStatus.missing and self.value is not None:
            raise ValueError("missing 字段不得带 value（PRD F02：未提及的信息留空）")
        if self.status in (FieldStatus.candidate, FieldStatus.unresolved) and self.raw and self.quote is None:
            raise ValueError("有原文的 candidate/unresolved 字段必须带 quote（规则 4）")
        if self.status is FieldStatus.unresolved and not self.raw and not self.derived:
            raise ValueError("unresolved 必须给出原文或标明是推算值（规则 7）")
        if self.derived and self.status is FieldStatus.confirmed:
            if self.origin is not FieldOrigin.user:
                raise ValueError("derived 推算值只能由用户确认（origin=user），并保留推算标记与出处")
        elif self.derived and self.status is not FieldStatus.unresolved:
            raise ValueError("v0.2：derived 推算值必须保持 unresolved，待用户确认")
        if self.status is FieldStatus.confirmed and self.value is None:
            raise ValueError("v0.3：confirmed 必须有有效值，不能确认 null（D5）")
        return self


class Deadline(ContractModel):
    """只有日期就保持日期精度，不补 23:59（PRD F07）。来源可为便签或用户手动（P05）。"""

    value: str | None = None
    precision: Literal["none", "date", "datetime"] = "none"
    source: Literal["note", "manual"] = "note"
    from_note_id: str | None = None
    confirmed_at: str | None = None

    @model_validator(mode="after")
    def _check(self) -> Deadline:
        if self.precision == "none":
            if self.value is not None:
                raise ValueError("precision=none 时 value 必须为空")
            return self
        if self.value is None:
            raise ValueError("有精度就必须有值")
        pattern = DATE_RE if self.precision == "date" else DATETIME_RE
        if not pattern.match(self.value):
            raise ValueError(f"value 与 precision={self.precision} 不符：{self.value}")
        probe = self.value.replace("Z", "+00:00")
        if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$", probe):
            probe += ":00"
        try:
            datetime.fromisoformat(probe)
        except ValueError as exc:
            raise ValueError(f"value 含非法日历日期：{self.value}") from exc
        if self.source == "note" and self.from_note_id is None:
            raise ValueError("source=note 时必须记录已确认出处便签")
        if self.source == "manual" and self.from_note_id is not None:
            raise ValueError("source=manual 时不得伪造便签出处")
        if self.confirmed_at is None:
            raise ValueError("截止无论来源都必须记录确认时间（P05）")
        return self


class Warning(ContractModel):
    code: Literal[
        "demo_data",
        "origin_unknown",
        "relative_date_derived",
        "date_year_inferred",
        "candidate_without_value",
        "timezone_unspecified",
        "possible_deadline_change",
        "no_deadline_in_source",
        "deadline_unselectable",
    ]
    message: str
    field_key: str | None = None


# V3-3：模型自造码的同义归一；不在码表且无同义的丢弃
WARNING_SYNONYMS = {
    "relative_date_unresolved": "relative_date_derived",
    "date_derived": "relative_date_derived",
    "year_inferred": "date_year_inferred",
    "tz_unknown": "timezone_unspecified",
    "timezone_unknown": "timezone_unspecified",
}
WARNING_CODES = set(Warning.model_fields["code"].annotation.__args__)
# 这些码由后端权威生成；模型自报的同码忽略，避免跨来源重复
BACKEND_GENERATED_CODES = {
    "relative_date_derived",
    "date_year_inferred",
    "candidate_without_value",
    "timezone_unspecified",
}


# ---------------------------------------------------------------- API：P0


class AnalyzeRequest(ContractModel):
    source_id: str
    kind: SourceKind
    image_base64: str | None = None
    text: str | None = None
    captured_at: str
    content_hint: ContentType | None = None
    reference_at: str | None = None  # 用户指定参照日期（可选）；无则相对时间不得借 user 名义换算

    @model_validator(mode="after")
    def _check(self) -> AnalyzeRequest:
        if not DATETIME_RE.match(self.captured_at):
            raise ValueError("captured_at 必须是 ISO 日期时间；它是收集时间，不等于消息发布时间")
        if self.reference_at is not None and not DATE_RE.match(self.reference_at):
            raise ValueError("reference_at 必须是 YYYY-MM-DD")
        if self.kind is SourceKind.image and not self.image_base64:
            raise ValueError("kind=image 必须带 image_base64")
        if self.kind is SourceKind.text and not self.text:
            raise ValueError("kind=text 必须带 text")
        return self


class AnalyzeResponse(ContractModel):
    source_id: str
    content_type: ContentType
    fields: list[Field]
    warnings: list[Warning] = []
    analyzed_at: str
    model_name: str
    schema_version: str = SCHEMA_VERSION

    @model_validator(mode="after")
    def _check(self) -> AnalyzeResponse:
        allowed = UNIVERSAL_KEYS | TYPE_KEYS[self.content_type.value]
        for f in self.fields:
            if f.origin is not FieldOrigin.model:
                raise ValueError("AI 产出的字段 origin 必须是 model")
            if f.status is FieldStatus.confirmed:
                raise ValueError("AI 不得返回 confirmed 字段（规则 3：确认优先）")
            if f.key not in allowed:
                raise ValueError(f"v0.2：键 {f.key} 不属于 {self.content_type.value} 的封闭集合")
            value = f.value
            if value is None:
                if f.status not in (FieldStatus.unresolved, FieldStatus.missing):
                    raise ValueError(f"v0.2：字段 {f.key} 为 candidate 却无值")
                continue
            if f.key == "time_nodes":
                if not isinstance(value, list):
                    raise ValueError("v0.3：time_nodes 必须是数组")
                for node in value:
                    TimeNode.model_validate(node)
                continue
            if f.key in STR_OR_LIST_KEYS:
                if not (isinstance(value, str) or (isinstance(value, list) and all(isinstance(x, str) for x in value))):
                    raise ValueError(f"v0.2：{f.key} 必须是字符串或字符串数组")
            elif f.key == "deadline":
                if not isinstance(value, str) or not DEADLINE_VALUE_RE.match(value):
                    raise ValueError(f"v0.2：deadline 必须是单一 date 或规范 datetime，不得拼接多个节点：{value!r}")
            elif not isinstance(value, str):
                raise ValueError(f"v0.2：{f.key} 必须是字符串")
        return self


class HealthResponse(ContractModel):
    model_ready: bool
    api_version: str = API_VERSION
    schema_version: str = SCHEMA_VERSION


# ---------------------------------------------------------------- API：P1


class MatterBrief(ContractModel):
    id: str
    title: str


class TaskBrief(ContractModel):
    id: str
    title: str
    deadline: str | None = None


class MatchRequest(ContractModel):
    note_id: str
    note_summary: str
    matters: list[MatterBrief] = []
    tasks: list[TaskBrief] = []


class MatchSuggestion(ContractModel):
    matter_id: str
    confidence: float
    reason: str

    @model_validator(mode="after")
    def _check(self) -> MatchSuggestion:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence 必须在 0..1")
        return self


class MatchResponse(ContractModel):
    """不确定时返回空数组，不强行归组（F05 第 231 行）。"""

    suggestions: list[MatchSuggestion] = []


class SuggestActionRequest(ContractModel):
    task_id: str
    title: str
    confirmed_fields: list[Field] = []
    available_minutes: int
    note_summaries: list[str] = []

    @model_validator(mode="after")
    def _check(self) -> SuggestActionRequest:
        if self.available_minutes <= 0:
            raise ValueError("available_minutes 必须为正")
        for f in self.confirmed_fields:
            if f.status is not FieldStatus.confirmed:
                raise ValueError("只能把已确认字段喂给行动建议（规则 3）")
        return self


class SuggestActionResponse(ContractModel):
    text: str
    minutes: int
    basis: ActionBasis
    evidence: str | None = None

    @model_validator(mode="after")
    def _check(self) -> SuggestActionResponse:
        if self.basis is ActionBasis.requirement and not self.evidence:
            raise ValueError("声称是原文要求就必须给证据（F09 第 314 行）")
        return self


class TaskDraft(ContractModel):
    """自然语言解析结果。任何不可靠项进 unresolved，绝不返回可直接入库的对象。"""

    title: str
    due_raw: str | None = None
    due_derived: str | None = None
    effort_raw: str | None = None
    effort_minutes: int | None = None
    unresolved: list[str] = []


class ParseTasksRequest(ContractModel):
    text: str
    reference_date: str | None = None


class ParseTasksResponse(ContractModel):
    tasks: list[TaskDraft] = []
    warnings: list[Warning] = []


class ApiError(ContractModel):
    code: str
    message: str
    retryable: bool = False
    detail: Any = None


# ---------------------------------------------------------------- 本地领域模型


class Source(ContractModel):
    id: str
    workspace_id: str
    kind: SourceKind
    image_ref: str | None = None
    text: str | None = None
    captured_at: str
    origin_url: str | None = None
    origin_title: str | None = None
    is_demo: bool = False

    @model_validator(mode="after")
    def _check(self) -> Source:
        if self.kind is SourceKind.image and not self.image_ref:
            raise ValueError("图片资料必须有 image_ref")
        if self.kind is SourceKind.text and not self.text:
            raise ValueError("文字资料必须有 text")
        return self


class Note(ContractModel):
    id: str
    workspace_id: str
    source_id: str
    status: NoteStatus
    content_type: ContentType
    title: str
    fields: list[Field] = []
    matter_id: str | None = None
    matter_role: MatterRole | None = None
    created_at: str
    updated_at: str
    reviewed_at: str | None = None
    is_demo: bool = False

    @model_validator(mode="after")
    def _check(self) -> Note:
        if self.status is NoteStatus.reviewed and self.reviewed_at is None:
            raise ValueError("reviewed 便签必须有 reviewed_at")
        if self.matter_id is None and self.matter_role is not None:
            raise ValueError("未归组便签不得有资料角色")
        return self


class Matter(ContractModel):
    id: str
    workspace_id: str
    title: str
    note_ids: list[str] = []
    created_at: str
    is_demo: bool = False

    @model_validator(mode="after")
    def _check(self) -> Matter:
        if len(set(self.note_ids)) != len(self.note_ids):
            raise ValueError("note_ids 不得重复")
        return self


class Task(ContractModel):
    id: str
    workspace_id: str
    title: str
    description: str = ""
    matter_id: str | None = None
    note_ids: list[str] = []
    deadline: Deadline = Deadline()
    status: TaskStatus = TaskStatus.todo
    completion_criteria: str | None = None
    current_action_id: str | None = None
    created_at: str
    updated_at: str
    is_demo: bool = False

    @model_validator(mode="after")
    def _check(self) -> Task:
        if self.deadline.from_note_id and self.deadline.from_note_id not in self.note_ids:
            raise ValueError("deadline 出处便签必须在 note_ids 中")
        return self


class Action(ContractModel):
    id: str
    workspace_id: str
    task_id: str
    text: str
    minutes: int
    basis: ActionBasis = ActionBasis.user
    done: bool = False
    created_at: str

    @model_validator(mode="after")
    def _check(self) -> Action:
        if self.minutes <= 0:
            raise ValueError("minutes 必须为正")
        return self


class FocusSession(ContractModel):
    """墙上时钟：started_at + accumulated_ms + running，禁止用 setInterval 累加。"""

    id: str
    workspace_id: str
    task_id: str
    action_id: str
    plan_item_id: str | None = None
    started_at: str
    accumulated_ms: int = 0
    running: bool = False
    draft_md: str = ""
    outcome: FocusOutcome | None = None
    blocker: str | None = None
    ended_at: str | None = None
    is_demo: bool = False

    @model_validator(mode="after")
    def _check(self) -> FocusSession:
        if self.accumulated_ms < 0:
            raise ValueError("accumulated_ms 不得为负")
        if self.running and (self.outcome is not None or self.ended_at is not None):
            raise ValueError("进行中的会话不得有 outcome / ended_at")
        if self.outcome is not None and self.running:
            raise ValueError("已结束的会话不得仍在运行")
        if self.outcome is FocusOutcome.blocked and not self.blocker:
            raise ValueError("卡住必须记录具体卡点（F10 结束结果表）")
        return self


class PlanItem(ContractModel):
    """只引用 task_id，永不回写 Task（规则 11/12）。"""

    id: str
    workspace_id: str
    task_id: str
    date: str
    planned_minutes: int
    action_text: str
    state: PlanItemState = PlanItemState.planned
    actual_minutes: int | None = None
    focus_session_id: str | None = None
    order: int = 0

    @model_validator(mode="after")
    def _check(self) -> PlanItem:
        if not DATE_RE.match(self.date):
            raise ValueError("date 必须是 YYYY-MM-DD（按天规划，不排时间槽）")
        if self.planned_minutes <= 0:
            raise ValueError("planned_minutes 必须为正")
        if self.focus_session_id and self.actual_minutes is None:
            raise ValueError("关联了专注会话就必须记录实际用时")
        return self


class Unscheduled(ContractModel):
    task_id: str
    gap_minutes: int
    reason: Literal["no_capacity", "no_due_date", "not_splittable", "before_start_date", "outside_horizon"]


class PlanDraft(ContractModel):
    """未确认的草案。gap_total 必填，使「假装排完」无法表达（F13.3）。"""

    id: str
    workspace_id: str
    horizon_days: int
    daily_budgets: dict[str, int]
    buffer_pct: int = 15
    items: list[PlanItem] = []
    unscheduled: list[Unscheduled] = []
    gap_total: int = 0
    created_at: str
    confirmed_at: str | None = None

    @model_validator(mode="after")
    def _check(self) -> PlanDraft:
        if self.horizon_days not in (3, 7, 14):
            raise ValueError("V1 只支持 3 / 7 / 14 天（F13.2）")
        if not 0 <= self.buffer_pct <= 50:
            raise ValueError("buffer_pct 超出合理范围")
        if self.gap_total < 0:
            raise ValueError("gap_total 不得为负")
        return self


class ChangeProposal(ContractModel):
    """F06（P1）：只产生候选，用户确认前不得改动任务。"""

    id: str
    workspace_id: str
    task_id: str
    old_note_id: str
    new_note_id: str
    old_value: str
    new_value: str
    evidence: list[Quote]
    status: ProposalStatus = ProposalStatus.pending
    created_at: str
    resolved_at: str | None = None

    @model_validator(mode="after")
    def _check(self) -> ChangeProposal:
        if self.old_value == self.new_value:
            raise ValueError("无变化不得生成候选")
        if not self.evidence:
            raise ValueError("变更候选必须带新旧原文证据")
        if self.status is ProposalStatus.pending and self.resolved_at is not None:
            raise ValueError("pending 候选不得有 resolved_at")
        return self


# ---------------------------------------------------------------- fixture 容器


class Fixture(ContractModel):
    """一份 fixture 同时服务三处：后端测试输入、前端 mock 响应、F12 演示空间。"""

    id: str
    title: str
    kind: Literal["analysis", "workspace"]
    is_demo: bool = True
    depends_on: list[str] = []
    acceptance: list[str] = []
    source: Source | None = None
    analyze_request: AnalyzeRequest | None = None
    expected_analysis: AnalyzeResponse | None = None
    confirmed_note: Note | None = None
    matter: Matter | None = None
    task: Task | None = None
    action: Action | None = None
    focus_session: FocusSession | None = None
    plan_items: list[PlanItem] = []
    change_proposal: ChangeProposal | None = None

    @model_validator(mode="after")
    def _check(self) -> Fixture:
        if self.kind == "analysis":
            if not (self.source and self.analyze_request and self.expected_analysis and self.confirmed_note):
                raise ValueError("analysis fixture 必须四件齐全")
            if self.analyze_request.source_id != self.source.id:
                raise ValueError("analyze_request.source_id 与 source.id 不一致")
            if self.expected_analysis.source_id != self.source.id:
                raise ValueError("expected_analysis.source_id 与 source.id 不一致")
            if self.confirmed_note.source_id != self.source.id:
                raise ValueError("confirmed_note.source_id 与 source.id 不一致")
            if self.confirmed_note.status is not NoteStatus.reviewed:
                raise ValueError("confirmed_note 必须是 reviewed 状态")
        if self.kind == "workspace" and self.task is None:
            raise ValueError("workspace fixture 必须带 task")
        return self


# ---------------------------------------------------------------- 端点登记

ALL_MODELS: list[type[ContractModel]] = [
    Quote, TimeNode, Field, Deadline, Warning,
    AnalyzeRequest, AnalyzeResponse, HealthResponse,
    MatterBrief, TaskBrief, MatchRequest, MatchSuggestion, MatchResponse,
    SuggestActionRequest, SuggestActionResponse, TaskDraft,
    ParseTasksRequest, ParseTasksResponse, ApiError,
    Source, Note, Matter, Task, Action, FocusSession,
    PlanItem, Unscheduled, PlanDraft, ChangeProposal, Fixture,
]

ENDPOINTS: list[dict[str, Any]] = [
    {
        "path": "/api/analyze", "method": "POST", "phase": "P0",
        "request": "AnalyzeRequest", "response": "AnalyzeResponse",
        "errors": {
            "413": "图片超出体积上限；前端提示压缩后重试，原图已在本地",
            "422": "模型输出不合 schema 或请求非法；前端落 Note.status=failed，保留原图，可重试",
            "503": "模型不可用；前端隐藏 AI 入口但保留仅保存",
        },
        "idempotency": "source_id 由客户端生成；同一 source_id 重试不得产生第二份资料",
    },
    {
        "path": "/api/healthz", "method": "GET", "phase": "P0",
        "request": None, "response": "HealthResponse",
        "errors": {"503": "服务不可达；前端进入离线态，本地功能全部照常"},
        "idempotency": "只读",
    },
    {
        "path": "/api/match", "method": "POST", "phase": "P1",
        "request": "MatchRequest", "response": "MatchResponse",
        "errors": {"422": "请求非法", "503": "模型不可用；静默跳过建议，不阻塞归组"},
        "idempotency": "只读建议，无副作用",
    },
    {
        "path": "/api/suggest-action", "method": "POST", "phase": "P1",
        "request": "SuggestActionRequest", "response": "SuggestActionResponse",
        "errors": {"422": "请求非法或 basis=requirement 却无 evidence", "503": "不可用；手动填写行动仍可开始专注"},
        "idempotency": "只读建议，无副作用",
    },
    {
        "path": "/api/parse-tasks", "method": "POST", "phase": "P1",
        "request": "ParseTasksRequest", "response": "ParseTasksResponse",
        "errors": {"422": "请求非法", "503": "不可用；退回结构化批量录入"},
        "idempotency": "只读解析，结果必须经用户确认才入库",
    },
]
