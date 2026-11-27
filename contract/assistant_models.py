"""正式契约 0.5.0 助手持久类型（5B-1B）——唯一手写来源，由 models.py 并入 ALL_MODELS。

来源：contract/proposals/assistant-v1/models.py 的持久化/备份依赖闭包（契约差异包 §1.3 A 批，
51 模型 + 4 枚举），逐字段迁移不改语义；共享枚举/基类/时间校验复用 models.py，不复制同名定义。
本文件不是提案：生产前后端经 contract.models 使用这些类型；提案目录保留为历史/协议测试入口。

D-3（已批准）：BackupManifestV2 补回 v1 容器字段 format/source_count/image_count。
限额 LIMITS 是前后端与测试共同引用的单一来源（D-1），generate.py 导出 contract/limits.json。
"""

from __future__ import annotations

import re
from datetime import date as _date, timedelta
from enum import Enum
from typing import Annotated, Any, Literal, Union

from pydantic import Field as PydField, model_validator

# 双上下文导入：包上下文（backend 的 contract.models）与脚本上下文（generate.py 裸 models）都可用。
# models.py 在文件末尾导入本文件；彼时共享基类/枚举/正则/时间校验已定义，循环安全。
if __package__:
    from .models import (
        ContractModel,
        Deadline,
        FieldOrigin,
        FieldStatus,
        TaskStatus,
        RefState,
        PlanItemState,
        DATE_RE,
        DEADLINE_VALUE_RE,
        _check_real_datetime,
    )
else:
    from models import (
        ContractModel,
        Deadline,
        FieldOrigin,
        FieldStatus,
        TaskStatus,
        RefState,
        PlanItemState,
        DATE_RE,
        DEADLINE_VALUE_RE,
        _check_real_datetime,
    )

KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

JS_SAFE_INT_MAX = 2**53 - 1


def _check_real_date(value: str, label: str) -> None:
    if not DATE_RE.match(value):
        raise ValueError(f"{label} 必须是 YYYY-MM-DD：{value}")
    try:
        _date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{label} 含非法日历日期：{value}") from exc


def _check_deadline_value(value: str, precision: str, label: str) -> None:
    """模型新候选的规范输出规则：datetime 必须带秒（DEADLINE_VALUE_RE），比旧事实更严。"""
    if precision == "date":
        _check_real_date(value, label)
        return
    if not DEADLINE_VALUE_RE.match(value):
        raise ValueError(f"{label} 必须是单一 date 或规范 datetime：{value}")
    _check_real_datetime(value, label)


def _check_existing_deadline_value(value: str, precision: str, label: str) -> None:
    """既有事实快照：与正式 Task.Deadline 同口径（datetime 用 DATETIME_RE）。

    正式 0.4.0 Deadline 允许无秒/naive/小数秒；不得用新候选的严格规则缩窄旧数据可读集合。
    naive 按北京时间解释；保留原值与原精度，不做规范化改写。
    """
    if precision == "date":
        _check_real_date(value, label)
        return
    _check_real_datetime(value, label)


def _consecutive_days(start: str, days: list[str], label: str) -> None:
    base = _date.fromisoformat(start)
    for i, d in enumerate(days):
        if d != (base + timedelta(days=i)).isoformat():
            raise ValueError(f"{label} 必须是从 {start} 起的连续自然日：第{i + 1}天 {d} 不符")


# ---------------------------------------------------------------- 限额唯一清单
# generate.py 原样导出 limits.json；selftest 交叉核对。future_config 是 5B-1/3 的接入映射，
# 不是当前已存在的配置项。更低的已配置上限优先；单接口不得放宽全局保护。

LIMITS: dict[str, dict[str, Any]] = {
    "max_targets": {"value": 20, "unit": "count", "scope": "一次 propose：新建+已有 Task 目标合计", "future_config": "backend propose 校验 + 前端选择器"},
    "max_work_items": {"value": 100, "unit": "count", "scope": "一次 propose / 一份草案的工作项", "future_config": "backend propose 校验 + domains/planning"},
    "max_new_actions": {"value": 100, "unit": "count", "scope": "一次 propose 新建 Action 建议", "future_config": "backend propose 校验"},
    "max_selected_sources": {"value": 20, "unit": "count", "scope": "一次 propose 选定资料", "future_config": "前端选择器 + backend 校验"},
    "max_new_images_per_batch": {"value": 3, "unit": "count", "scope": "一批新截图；逐份走既有 analyze", "future_config": "前端附件区"},
    "max_user_message_chars": {"value": 16000, "unit": "chars", "scope": "本轮用户文字 / 单条线程消息", "future_config": "前后端同值校验"},
    "max_source_excerpt_chars": {"value": 2000, "unit": "chars", "scope": "单来源片段；超限提示缩小范围，不静默删约束", "future_config": "前端截断提示 + backend 校验"},
    "max_propose_body_bytes": {"value": 524288, "unit": "bytes", "scope": "propose 请求体 UTF-8 实际字节，分块累计；不得放宽全局 max_body_bytes", "future_config": "backend BodyLimit 按路径覆盖（5B-3）"},
    "max_model_output_bytes": {"value": 131072, "unit": "bytes", "scope": "propose 模型输出解码文本", "future_config": "backend 输出读取上限（5B-3）"},
    "propose_profile_max_tokens": {"value": 8192, "unit": "tokens", "scope": "propose 专用 profile；不改旧 analyze profile 默认值", "future_config": "backend model registry 新 profile（5B-3）"},
    "propose_budget_s": {"value": 120, "unit": "seconds", "scope": "一次 propose 整体预算；含重试/结构修复/fallback", "future_config": "backend propose 编排（5B-3）"},
    "propose_max_vendor_attempts": {"value": 2, "unit": "attempts", "scope": "一次 propose 全部实际厂家 HTTP 尝试合计；额度耗尽禁止 fallback 绕过", "future_config": "backend attempt_gate 共享每日额度（5B-3）"},
    "daily_budget_minutes_min": {"value": 0, "unit": "minutes", "scope": "单日预算下界", "future_config": "约束卡 + PlanningInput"},
    "daily_budget_minutes_max": {"value": 1440, "unit": "minutes", "scope": "单日预算上界；未指定为 null 并澄清，不默认 0", "future_config": "约束卡 + PlanningContext"},
    "buffer_pct_min": {"value": 0, "unit": "percent", "scope": "缓冲比例下界", "future_config": "约束卡"},
    "buffer_pct_max": {"value": 50, "unit": "percent", "scope": "缓冲比例上界", "future_config": "约束卡"},
    "buffer_pct_default": {"value": 15, "unit": "percent", "scope": "缓冲比例默认", "future_config": "约束卡"},
    "min_segment_minutes_default": {"value": 25, "unit": "minutes", "scope": "默认最小工作段", "future_config": "约束卡 + domains/planning"},
    "min_segment_minutes_min": {"value": 1, "unit": "minutes", "scope": "最小工作段下界", "future_config": "约束卡"},
    "min_segment_minutes_max": {"value": 240, "unit": "minutes", "scope": "最小工作段上界", "future_config": "约束卡"},
    "horizon_days": {"value": 7, "unit": "days", "scope": "首版固定连续 7 个北京时间自然日", "future_config": "PlanningInput/PlanningContext"},
    "max_clarification_questions": {"value": 3, "unit": "count", "scope": "每轮集中澄清问题数", "future_config": "backend propose + 助手卡片"},
    "max_thread_messages": {"value": 200, "unit": "count", "scope": "单线程消息数；达到上限提示新建线程", "future_config": "assistant store（5B-1）"},
    "max_draft_bytes": {"value": 1048576, "unit": "bytes", "scope": "单条草案序列化（含 revision_history）；达到上限提示基于当前内容新建草案", "future_config": "assistant store（5B-1）"},
    "max_draft_revisions": {"value": 20, "unit": "count", "scope": "每草案版本数含当前；旧版只读", "future_config": "assistant store（5B-1）"},
    "max_occupancy_entries": {"value": 2000, "unit": "count", "scope": "PlanningInput 完整窗口占用条目", "future_config": "domains/planning（5B-1）"},
    "max_segments": {"value": 700, "unit": "count", "scope": "PlanningResult 段数上界（100 项 × 7 天）", "future_config": "domains/planning（5B-1）"},
    "js_safe_int_max": {"value": JS_SAFE_INT_MAX, "unit": "int", "scope": "分钟/order 等数值安全上界；超出拒绝不溢出", "future_config": "前后端数值校验"},
}


# ---------------------------------------------------------------- 枚举（0.5.0 新增；共享枚举复用 models.py）


class Priority(str, Enum):
    high = "high"
    normal = "normal"
    low = "low"


class Strength(str, Enum):
    hard = "hard"
    soft = "soft"


class DraftStatus(str, Enum):
    editing = "editing"
    generating = "generating"
    needs_clarification = "needs_clarification"
    ready = "ready"
    needs_review = "needs_review"
    applying = "applying"
    applied = "applied"
    result_unknown = "result_unknown"
    discarded = "discarded"


class UnscheduledReason(str, Enum):
    no_capacity = "no_capacity"
    not_splittable = "not_splittable"
    dependency_blocked = "dependency_blocked"
    outside_horizon = "outside_horizon"
    deadline_window = "deadline_window"
    needs_deadline_day_window = "needs_deadline_day_window"
    overdue_requires_consent = "overdue_requires_consent"


# ---------------------------------------------------------------- 判别引用


class DraftRef(ContractModel):
    """临时引用：key 只在一个草案版本内有效；正式 ID 由客户端采用时产生。"""

    kind: Literal["draft"] = "draft"
    key: str

    @model_validator(mode="after")
    def _check(self) -> DraftRef:
        if not KEY_RE.match(self.key):
            raise ValueError(f"draft key 形状非法：{self.key}")
        return self


class ExistingRef(ContractModel):
    kind: Literal["existing"] = "existing"
    id: str = PydField(min_length=1, max_length=64)


TypedRef = Annotated[Union[DraftRef, ExistingRef], PydField(discriminator="kind")]


class ObjectRef(ContractModel):
    """线程/草案对正式对象或草案的只读关联。"""

    object_type: Literal["source", "note", "task", "action", "plan_item", "draft"]
    id: str = PydField(min_length=1, max_length=64)


# ---------------------------------------------------------------- 证据（判别联合）


class SourceExcerptEvidence(ContractModel):
    kind: Literal["source_excerpt"] = "source_excerpt"
    source_id: str = PydField(min_length=1, max_length=64)
    excerpt: str = PydField(min_length=1, max_length=2000)
    locator: str | None = PydField(default=None, max_length=200)


class NoteFieldEvidence(ContractModel):
    kind: Literal["note_field"] = "note_field"
    note_id: str = PydField(min_length=1, max_length=64)
    field_key: str = PydField(min_length=1, max_length=64)


class UserMessageEvidence(ContractModel):
    kind: Literal["user_message"] = "user_message"
    turn_id: str = PydField(min_length=1, max_length=64)
    excerpt: str = PydField(min_length=1, max_length=2000)


class ExistingFactEvidence(ContractModel):
    kind: Literal["existing_fact"] = "existing_fact"
    object_type: Literal["task", "action", "plan_item", "focus_session", "note", "source"]
    object_id: str = PydField(min_length=1, max_length=64)
    field_path: str = PydField(min_length=1, max_length=120)


EvidenceRef = Annotated[
    Union[SourceExcerptEvidence, NoteFieldEvidence, UserMessageEvidence, ExistingFactEvidence],
    PydField(discriminator="kind"),
]


# ---------------------------------------------------------------- 模型建议对象


class DeadlineCandidate(ContractModel):
    """截止候选。模型不得输出 confirmed_at；确认发生在本地 Note/Task 字段。"""

    value: str | None = None
    precision: Literal["none", "date", "datetime"] = "none"
    origin: FieldOrigin = FieldOrigin.model
    derived: bool = False
    basis: Literal["explicit", "relative", "inferred"] = "explicit"
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check(self) -> DeadlineCandidate:
        if self.precision == "none":
            if self.value is not None:
                raise ValueError("precision=none 时 value 必须为空")
            return self
        if self.value is None:
            raise ValueError("有精度就必须有值")
        _check_deadline_value(self.value, self.precision, "deadline_candidate.value")
        if self.basis in ("relative", "inferred") and not self.derived:
            raise ValueError("relative/inferred 候选必须标 derived")
        if not self.evidence_refs:
            raise ValueError("有值的截止候选必须给证据出处；无来源估计不能成为正式截止")
        return self


class TaskProposalCreate(ContractModel):
    op: Literal["create"] = "create"
    key: str
    title: str = PydField(min_length=1, max_length=200)
    description: str = PydField(default="", max_length=4000)
    completion_criteria: str | None = PydField(default=None, max_length=2000)
    deadline_candidates: list[DeadlineCandidate] = PydField(default_factory=list, max_length=10)
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check(self) -> TaskProposalCreate:
        if not KEY_RE.match(self.key):
            raise ValueError(f"task key 形状非法：{self.key}")
        return self


class TaskProposalLink(ContractModel):
    """关联已有 Task：不改对象；必须选中明确 ID，不按名字自动合并。"""

    op: Literal["link"] = "link"
    key: str
    target_id: str = PydField(min_length=1, max_length=64)
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check(self) -> TaskProposalLink:
        if not KEY_RE.match(self.key):
            raise ValueError(f"task key 形状非法：{self.key}")
        return self


class TaskUpdateFields(ContractModel):
    title: str | None = PydField(default=None, min_length=1, max_length=200)
    description: str | None = PydField(default=None, max_length=4000)
    completion_criteria: str | None = PydField(default=None, max_length=2000)
    deadline_candidates: list[DeadlineCandidate] | None = PydField(default=None, max_length=10)


class TaskProposalUpdate(ContractModel):
    """更新只允许 title/description/completion_criteria/deadline 四类字段。

    不能改 status/current_action_id/空间/历史；重要字段更新须逐字段确认（见 UserConfirmation）。
    """

    op: Literal["update"] = "update"
    key: str
    target_id: str = PydField(min_length=1, max_length=64)
    changes: TaskUpdateFields
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check(self) -> TaskProposalUpdate:
        if not KEY_RE.match(self.key):
            raise ValueError(f"task key 形状非法：{self.key}")
        c = self.changes
        if all(x is None for x in (c.title, c.description, c.completion_criteria, c.deadline_candidates)):
            raise ValueError("update 必须至少提出一个字段变更")
        return self


TaskProposal = Annotated[
    Union[TaskProposalCreate, TaskProposalLink, TaskProposalUpdate],
    PydField(discriminator="op"),
]


class ActionProposalCreate(ContractModel):
    op: Literal["create"] = "create"
    key: str
    task_ref: TypedRef
    text: str = PydField(min_length=1, max_length=500)
    minutes: int = PydField(gt=0, le=JS_SAFE_INT_MAX)
    basis: Literal["requirement", "suggestion"] = "suggestion"
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check(self) -> ActionProposalCreate:
        if not KEY_RE.match(self.key):
            raise ValueError(f"action key 形状非法：{self.key}")
        if self.basis == "requirement" and not self.evidence_refs:
            raise ValueError("声称是原文要求就必须给证据")
        return self


class ActionProposalReuse(ContractModel):
    """复用既有 Action：必须属于明确 Task；首版不批量修改或完成既有 Action。"""

    op: Literal["reuse"] = "reuse"
    key: str
    target_id: str = PydField(min_length=1, max_length=64)
    task_ref: ExistingRef
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check(self) -> ActionProposalReuse:
        if not KEY_RE.match(self.key):
            raise ValueError(f"action key 形状非法：{self.key}")
        return self


ActionProposal = Annotated[
    Union[ActionProposalCreate, ActionProposalReuse],
    PydField(discriminator="op"),
]


class WorkItemProposal(ContractModel):
    """本次剩余工作，不是历史投入换算。估时未知用 null，不能用 0。"""

    key: str
    task_ref: TypedRef
    action_ref: TypedRef
    deliverable: str = PydField(min_length=1, max_length=500)
    remaining_minutes: int | None = PydField(default=None, le=JS_SAFE_INT_MAX)
    estimate_origin: FieldOrigin = FieldOrigin.model
    splittable: bool = True
    min_segment_minutes: int = PydField(default=25, ge=1, le=240)
    earliest_date: str | None = None
    depends_on: list[str] = PydField(default_factory=list, max_length=20)
    priority: Priority = Priority.normal

    @model_validator(mode="after")
    def _check(self) -> WorkItemProposal:
        if not KEY_RE.match(self.key):
            raise ValueError(f"work item key 形状非法：{self.key}")
        if self.remaining_minutes is not None and self.remaining_minutes <= 0:
            raise ValueError("remaining_minutes 必须为正安全整数或 null（未知），不能用 0")
        if self.earliest_date is not None:
            _check_real_date(self.earliest_date, "earliest_date")
        if self.key in self.depends_on:
            raise ValueError("工作项不得依赖自身")
        if len(set(self.depends_on)) != len(self.depends_on):
            raise ValueError("depends_on 不得重复")
        return self


class PriorityRequirementValue(ContractModel):
    task_ref: TypedRef
    priority: Priority


class SplittableRequirementValue(ContractModel):
    work_item_key: str
    splittable: bool


class OrderingRequirementValue(ContractModel):
    before_key: str
    after_key: str


class RequirementCandidate(ContractModel):
    """约束候选白名单。confirmed 状态只能由本地交互产生，模型只建议。"""

    key: str
    type: Literal[
        "daily_budget", "unavailable_days", "start_date", "task_priority",
        "min_segment_minutes", "splittable", "ordering",
    ]
    value: Any = None
    strength: Strength = Strength.hard
    provenance: Literal["user", "source", "model"] = "model"
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check(self) -> RequirementCandidate:
        if not KEY_RE.match(self.key):
            raise ValueError(f"requirement key 形状非法：{self.key}")
        t, v = self.type, self.value
        if t == "daily_budget":
            if v is not None and (not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 1440):
                raise ValueError("daily_budget 必须是 0–1440 整数或 null（未知待澄清，不默认 0）")
        elif t == "unavailable_days":
            if not isinstance(v, list) or len(v) > 31 or not all(isinstance(x, str) for x in v):
                raise ValueError("unavailable_days 必须是日期数组")
            for x in v:
                _check_real_date(x, "unavailable_days")
        elif t == "start_date":
            if not isinstance(v, str):
                raise ValueError("start_date 必须是 YYYY-MM-DD")
            _check_real_date(v, "start_date")
        elif t == "task_priority":
            PriorityRequirementValue.model_validate(v)
        elif t == "min_segment_minutes":
            if not isinstance(v, int) or isinstance(v, bool) or not 1 <= v <= 240:
                raise ValueError("min_segment_minutes 必须是 1–240 整数")
        elif t == "splittable":
            SplittableRequirementValue.model_validate(v)
        elif t == "ordering":
            OrderingRequirementValue.model_validate(v)
        return self


class Assumption(ContractModel):
    id: str = PydField(min_length=1, max_length=40)
    text: str = PydField(min_length=1, max_length=500)
    related_keys: list[str] = PydField(
        default_factory=list, max_length=20,
        description="只能引用本版 work_items[].key（如 w1）；不得使用行动 key（如 a1）、任务 key 或正式 ID。",
    )


class ProposalWarning(ContractModel):
    code: Literal[
        "estimate_is_suggestion", "deadline_ambiguous", "capacity_unknown",
        "soft_preference_unmet", "source_parse_partial", "possible_duplicate_task",
        "extra_work_needs_confirmation",
    ]
    message: str = PydField(min_length=1, max_length=500)
    related_key: str | None = PydField(default=None, max_length=40)


class AssistantModelProposal(ContractModel):
    """模型只能建议；无授权、无持久化状态、无数据库命令。"""

    task_proposals: list[TaskProposal] = PydField(default_factory=list, max_length=20)
    action_proposals: list[ActionProposal] = PydField(default_factory=list, max_length=100)
    work_items: list[WorkItemProposal] = PydField(default_factory=list, max_length=100)
    requirement_candidates: list[RequirementCandidate] = PydField(default_factory=list, max_length=50)
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=100)
    assumptions: list[Assumption] = PydField(default_factory=list, max_length=50)
    warnings: list[ProposalWarning] = PydField(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def _check(self) -> AssistantModelProposal:
        for group, label in (
            (self.task_proposals, "task"),
            (self.action_proposals, "action"),
            (self.work_items, "work item"),
            (self.requirement_candidates, "requirement"),
        ):
            keys = [x.key for x in group]
            if len(set(keys)) != len(keys):
                raise ValueError(f"{label} key 重复")
        return self


# ---------------------------------------------------------------- 已确认要求


class ConfirmedRequirement(ContractModel):
    """本地经用户确认的约束；服务端接收到它也不获得数据库权限。"""

    requirement_id: str = PydField(min_length=1, max_length=40)
    version: int = PydField(ge=1)
    type: Literal[
        "daily_budget", "unavailable_days", "start_date", "task_priority",
        "min_segment_minutes", "splittable", "ordering",
    ]
    value: Any = None
    strength: Strength = Strength.hard
    confirmed_at: str
    evidence_refs: list[EvidenceRef] = PydField(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check(self) -> ConfirmedRequirement:
        _check_real_datetime(self.confirmed_at, "confirmed_at")
        probe = RequirementCandidate(
            key=self.requirement_id, type=self.type, value=self.value,
            strength=self.strength, evidence_refs=self.evidence_refs,
        )
        del probe
        return self


# ---------------------------------------------------------------- 排程输入（daily-v1）


class PlanningTaskFact(ContractModel):
    """排程所需的任务事实：截止与逾期补做授权。截止不等于安排日。"""

    task_ref: TypedRef
    title: str = PydField(min_length=1, max_length=200)
    deadline_value: str | None = None
    deadline_precision: Literal["none", "date", "datetime"] = "none"
    overdue_consent: bool = False
    status: TaskStatus = TaskStatus.todo

    @model_validator(mode="after")
    def _check(self) -> PlanningTaskFact:
        if self.deadline_precision == "none":
            if self.deadline_value is not None:
                raise ValueError("precision=none 时 deadline_value 必须为空")
            return self
        if self.deadline_value is None:
            raise ValueError("有精度就必须有值")
        _check_existing_deadline_value(self.deadline_value, self.deadline_precision, "deadline_value")
        return self


class PlanningActionFact(ContractModel):
    """复用行动的内容基线（M1 审查 R5）：预览/采用依赖的归属、正文、估时与完成状态。

    Action 无 updated_at，存在性+done 不足以发现正文/估时/归属漂移；重排时冻结，提交重读核对。
    """

    action_ref: TypedRef
    task_id: str = PydField(min_length=1, max_length=64)
    text: str
    minutes: int = PydField(ge=1)
    done: bool = False

    @model_validator(mode="after")
    def _check(self) -> PlanningActionFact:
        if self.action_ref.kind != "existing":
            raise ValueError("行动内容基线只针对既有行动（kind=existing）")
        return self


class DayBudget(ContractModel):
    date: str
    budget_minutes: int = PydField(ge=0, le=1440)

    @model_validator(mode="after")
    def _check(self) -> DayBudget:
        _check_real_date(self.date, "date")
        return self


class OccupancyEntry(ContractModel):
    """按唯一 PlanItem ID 计占用。planned/partial/done 保守计入；cancelled/moved 不占用。

    历史断引用的 partial/done 合法保留；planned 断引用属于不可信占用，阻断并引导核对，不按 0 计算。
    """

    plan_item_id: str = PydField(min_length=1, max_length=64)
    task_id: str = PydField(min_length=1, max_length=64)
    date: str
    planned_minutes: int = PydField(gt=0, le=JS_SAFE_INT_MAX)
    state: PlanItemState
    task_ref_state: RefState = RefState.active

    @model_validator(mode="after")
    def _check(self) -> OccupancyEntry:
        _check_real_date(self.date, "date")
        if self.state is PlanItemState.planned and self.task_ref_state is RefState.deleted:
            raise ValueError("planned 占用断引用属于不可信数据：阻断并引导核对，不得按 0 计算")
        return self


class PlanningWorkItem(ContractModel):
    key: str
    task_ref: TypedRef
    action_ref: TypedRef
    deliverable: str = PydField(min_length=1, max_length=500)
    remaining_minutes: int | None = PydField(default=None, le=JS_SAFE_INT_MAX)
    estimate_origin: FieldOrigin = FieldOrigin.model
    splittable: bool = True
    min_segment_minutes: int = PydField(default=25, ge=1, le=240)
    earliest_date: str | None = None
    depends_on: list[str] = PydField(default_factory=list, max_length=20)
    priority: Priority = Priority.normal

    @model_validator(mode="after")
    def _check(self) -> PlanningWorkItem:
        if not KEY_RE.match(self.key):
            raise ValueError(f"work item key 形状非法：{self.key}")
        if self.remaining_minutes is not None and self.remaining_minutes <= 0:
            raise ValueError("remaining_minutes 必须为正安全整数或 null（未知），不能用 0")
        if self.earliest_date is not None:
            _check_real_date(self.earliest_date, "earliest_date")
        if self.key in self.depends_on:
            raise ValueError("工作项不得依赖自身")
        if len(set(self.depends_on)) != len(self.depends_on):
            raise ValueError("depends_on 不得重复")
        return self


def _ref_token(ref: DraftRef | ExistingRef) -> str:
    return f"draft:{ref.key}" if isinstance(ref, DraftRef) else f"existing:{ref.id}"


class PlanningInput(ContractModel):
    algorithm_version: Literal["daily-v1"] = "daily-v1"
    timezone: Literal["Asia/Shanghai"] = "Asia/Shanghai"
    today: str | None = None
    start_date: str
    horizon_days: Literal[7] = 7
    buffer_pct: int = PydField(default=15, ge=0, le=50)
    days: list[DayBudget] = PydField(min_length=7, max_length=7)
    task_facts: list[PlanningTaskFact] = PydField(default_factory=list, max_length=20)
    work_items: list[PlanningWorkItem] = PydField(default_factory=list, max_length=100)
    occupancy: list[OccupancyEntry] = PydField(default_factory=list, max_length=2000)
    replacement_ids: list[str] = PydField(default_factory=list, max_length=100)
    extra_work_acknowledged: list[str] = PydField(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def _check(self) -> PlanningInput:
        _check_real_date(self.start_date, "start_date")
        if self.today is not None:
            _check_real_date(self.today, "today")
            if self.today > self.start_date:
                raise ValueError("today 不得晚于 start_date")
        _consecutive_days(self.start_date, [d.date for d in self.days], "days")
        # M3：replacement_ids 记录已验证可替换集 R；occupancy 必须是排除 R 后的有效占用，
        # 排程器只消费该结果，不得按 replacement_ids 二次扣减容量。
        if len(set(self.replacement_ids)) != len(self.replacement_ids):
            raise ValueError("replacement_ids 重复；去重拒绝，不静默扩大范围")
        if any(len(i) < 1 or len(i) > 64 for i in self.replacement_ids):
            raise ValueError("replacement_ids 每项必须是 1..64 字符的正式 PlanItem ID")
        occ_id_set = {o.plan_item_id for o in self.occupancy}
        if any(i in occ_id_set for i in self.replacement_ids):
            raise ValueError("occupancy 不得含 replacement_ids：有效占用须先排除已验证替换集")
        keys = [w.key for w in self.work_items]
        if len(set(keys)) != len(keys):
            raise ValueError("work item key 重复")
        key_set = set(keys)
        for w in self.work_items:
            for dep in w.depends_on:
                if dep not in key_set:
                    raise ValueError(f"depends_on 引用未知工作项：{dep}")
        # 依赖环拒绝（结构层即可判定）
        graph = {w.key: list(w.depends_on) for w in self.work_items}
        state: dict[str, int] = {}

        def visit(k: str) -> None:
            if state.get(k) == 1:
                raise ValueError(f"依赖环：{k}")
            if state.get(k) == 2:
                return
            state[k] = 1
            for dep in graph[k]:
                visit(dep)
            state[k] = 2

        for k in graph:
            visit(k)
        fact_tokens = {_ref_token(f.task_ref) for f in self.task_facts}
        if len(fact_tokens) != len(self.task_facts):
            raise ValueError("task_facts 引用重复")
        for w in self.work_items:
            if _ref_token(w.task_ref) not in fact_tokens:
                raise ValueError(f"工作项 {w.key} 的 task_ref 缺少对应 task_facts")
        occ_ids = [o.plan_item_id for o in self.occupancy]
        if len(set(occ_ids)) != len(occ_ids):
            raise ValueError("occupancy 按唯一 PlanItem ID 计占用；重复引用拒绝，不双计")
        ack = set(self.extra_work_acknowledged)
        if not ack <= key_set:
            raise ValueError("extra_work_acknowledged 引用未知工作项")
        return self


# ---------------------------------------------------------------- 排程输出


class Segment(ContractModel):
    """建议段。不含真实计时或完成结果；order 是当日明确顺序，不保证具体小时。"""

    segment_key: str = PydField(min_length=1, max_length=64)
    work_item_key: str = PydField(min_length=1, max_length=40)
    task_ref: TypedRef
    suggested_action_ref: TypedRef
    date: str
    minutes: int = PydField(gt=0, le=JS_SAFE_INT_MAX)
    order: int = PydField(ge=1, le=JS_SAFE_INT_MAX)
    action_text: str = PydField(min_length=1, max_length=500)
    deliverable: str = PydField(min_length=1, max_length=500)

    @model_validator(mode="after")
    def _check(self) -> Segment:
        _check_real_date(self.date, "date")
        return self


class DaySummary(ContractModel):
    """allocatable=floor(budget×(100-buffer_pct)/100)；free=max(0,allocatable-committed-allocated)。"""

    date: str
    budget_minutes: int = PydField(ge=0, le=1440)
    buffer_minutes: int = PydField(ge=0)
    committed_minutes: int = PydField(ge=0, le=JS_SAFE_INT_MAX)
    allocated_minutes: int = PydField(ge=0, le=JS_SAFE_INT_MAX)
    free_minutes: int = PydField(ge=0, le=JS_SAFE_INT_MAX)
    overbooked_minutes: int = PydField(ge=0, le=JS_SAFE_INT_MAX)

    @model_validator(mode="after")
    def _check(self) -> DaySummary:
        _check_real_date(self.date, "date")
        if self.buffer_minutes > self.budget_minutes:
            raise ValueError("buffer_minutes 不得超过 budget_minutes")
        allocatable = self.budget_minutes - self.buffer_minutes
        if not any(
            self.budget_minutes * (100 - pct) // 100 == allocatable
            for pct in range(0, 51)
        ):
            raise ValueError("buffer_minutes 必须对应某个 0–50 整数 buffer_pct 的 floor 结果")
        if self.overbooked_minutes != max(0, self.committed_minutes - allocatable):
            raise ValueError("overbooked_minutes = max(0, committed - allocatable)")
        if self.free_minutes != max(0, allocatable - self.committed_minutes - self.allocated_minutes):
            raise ValueError("free_minutes = max(0, allocatable - committed - allocated)")
        return self


class UnscheduledEntry(ContractModel):
    work_item_key: str = PydField(min_length=1, max_length=40)
    remaining_minutes: int = PydField(gt=0, le=JS_SAFE_INT_MAX)
    reason: UnscheduledReason


class UnknownItem(ContractModel):
    work_item_key: str = PydField(min_length=1, max_length=40)
    reason: Literal["estimate_missing"] = "estimate_missing"


class ExcludedItem(ContractModel):
    work_item_key: str = PydField(min_length=1, max_length=40)
    excluded_by: Literal["user"] = "user"
    reason: str = PydField(min_length=1, max_length=500)


class PlanningConflict(ContractModel):
    code: Literal[
        "hard_constraint_violation", "invalid_occupancy", "dependency_cycle",
        "unknown_predecessor", "cross_workspace_ref", "overdue_without_consent",
    ]
    message: str = PydField(min_length=1, max_length=500)
    related_keys: list[str] = PydField(default_factory=list, max_length=20)


class PlanningWarning(ContractModel):
    code: Literal[
        "existing_overbook", "datetime_deadline_conservative", "overdue_scheduled",
        "heuristic_incomplete", "unrecorded_calendar_notice", "window_end_not_deadline",
    ]
    message: str = PydField(min_length=1, max_length=500)
    related_key: str | None = PydField(default=None, max_length=40)


class PlanningResult(ContractModel):
    segments: list[Segment] = PydField(default_factory=list, max_length=700)
    days: list[DaySummary] = PydField(min_length=7, max_length=7)
    unscheduled: list[UnscheduledEntry] = PydField(default_factory=list, max_length=100)
    unknown_items: list[UnknownItem] = PydField(default_factory=list, max_length=100)
    excluded_items: list[ExcludedItem] = PydField(default_factory=list, max_length=100)
    conflicts: list[PlanningConflict] = PydField(default_factory=list, max_length=50)
    warnings: list[PlanningWarning] = PydField(default_factory=list, max_length=50)
    complete: bool = False

    @model_validator(mode="after")
    def _check(self) -> PlanningResult:
        seg_keys = [s.segment_key for s in self.segments]
        if len(set(seg_keys)) != len(seg_keys):
            raise ValueError("segment_key 重复")
        day_dates = [d.date for d in self.days]
        if len(set(day_dates)) != len(day_dates):
            raise ValueError("days 日期重复")
        for d in self.days:
            if d.overbooked_minutes > 0 and (d.free_minutes != 0 or d.allocated_minutes != 0):
                raise ValueError("已过载日 free 必须为 0 且不得新增安排")
        if self.complete and (self.unscheduled or self.unknown_items or self.conflicts):
            raise ValueError("complete=true 只在全部采用范围已知估时、无未排量、无阻断时成立")
        for group, label in ((self.unscheduled, "unscheduled"), (self.unknown_items, "unknown"), (self.excluded_items, "excluded")):
            keys = [x.work_item_key for x in group]
            if len(set(keys)) != len(keys):
                raise ValueError(f"{label} work_item_key 重复")
        return self


# ---------------------------------------------------------------- 草案持久对象（DB v4）

# 澄清合成消息的机器固定格式（契约权威定义；前端 clarification.js / 后端 semantics.py 为同口径镜像）。
# 差异记录：devlog/coordination/2026-11-25-M2-R1结构化用户输入契约差异.md。
CLARIFY_ORIGINAL_PREFIX = "原始要求："
CLARIFY_HISTORY_HEADER = "此前的澄清问题与我的回答："
CLARIFY_QUESTION_PREFIX = "问："
CLARIFY_ANSWER_PREFIX = "答："
CLARIFY_CONTINUE_TAIL = "请结合以上回答继续生成方案。"


class ClarificationTurnRecord(ContractModel):
    """一轮澄清的结构化记录。user_answer 由客户端按用户实际提交填写，绝不来自模型输出；
    assistant_question 无论含什么标记（包括「答：…」）都始终属于问题字段，不取得用户身份。"""

    assistant_question: str = PydField(min_length=1, max_length=500)
    user_answer: str = PydField(min_length=1, max_length=16000)


class UserAuthoredInput(ContractModel):
    """真实用户输入的结构化记录：核验「用户明确要求」只读 original_user_request 与各 user_answer，
    不从拼接文本解析角色。模型读到的合成上下文由 render_user_authored_text 从本记录渲染（单一来源）。"""

    original_user_request: str = PydField(min_length=1, max_length=16000)
    clarifications: list[ClarificationTurnRecord] = PydField(default_factory=list, max_length=50)


def render_user_authored_text(ui: UserAuthoredInput) -> str:
    if not ui.clarifications:
        return ui.original_user_request
    lines = [f"{CLARIFY_ORIGINAL_PREFIX}{ui.original_user_request}", "", CLARIFY_HISTORY_HEADER]
    for t in ui.clarifications:
        lines.append(f"{CLARIFY_QUESTION_PREFIX}{t.assistant_question}")
        lines.append(f"{CLARIFY_ANSWER_PREFIX}{t.user_answer}")
    lines.extend(["", CLARIFY_CONTINUE_TAIL])
    return "\n".join(lines)


def looks_like_composed_clarification(text: str) -> bool:
    """保守前缀判定：以「原始要求：」开头即视为机器合成澄清文本（渲染器指纹）。
    只识别格式，不解析问/答角色——旧合成记录的任何部分都不取得可信用户身份（P2 收口）。"""
    return (text or "").startswith(CLARIFY_ORIGINAL_PREFIX)


class ThreadMessage(ContractModel):
    id: str = PydField(min_length=1, max_length=64)
    role: Literal["user", "assistant", "system"]
    content: str = PydField(max_length=16000)
    type: Literal[
        "text", "understanding", "clarification", "proposal_card",
        "schedule_card", "change_summary", "conflict_card", "adoption_result",
    ] = "text"
    refs: list[ObjectRef] = PydField(default_factory=list, max_length=20)
    created_at: str
    user_input: UserAuthoredInput | None = None

    @model_validator(mode="after")
    def _check(self) -> ThreadMessage:
        _check_real_datetime(self.created_at, "created_at")
        if self.user_input is not None and self.role != "user":
            raise ValueError("user_input 只能挂在 role=user 的消息上")
        return self


class AssistantThread(ContractModel):
    id: str = PydField(min_length=1, max_length=64)
    record_version: Literal[1] = 1
    workspace_id: str = PydField(min_length=1, max_length=64)
    title: str = PydField(default="", max_length=200)
    messages: list[ThreadMessage] = PydField(default_factory=list, max_length=200)
    selected_refs: list[ObjectRef] = PydField(default_factory=list, max_length=40)
    confirmed_requirements: list[ConfirmedRequirement] = PydField(default_factory=list, max_length=50)
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def _check(self) -> AssistantThread:
        _check_real_datetime(self.created_at, "created_at")
        _check_real_datetime(self.updated_at, "updated_at")
        ids = [m.id for m in self.messages]
        if len(set(ids)) != len(ids):
            raise ValueError("消息 id 重复")
        return self


# ---------------------------------------------------------------- M3 改排（replan）输入与基线


class ReplanScope(ContractModel):
    """一次只调整一个任务；替换集只由本地用户逐条勾选产生，模型不得产生。"""

    task_id: str = PydField(min_length=1, max_length=64)
    start_date: str
    replacement_ids: list[str] = PydField(min_length=1, max_length=100)

    @model_validator(mode="after")
    def _check(self) -> ReplanScope:
        _check_real_date(self.start_date, "start_date")
        if len(set(self.replacement_ids)) != len(self.replacement_ids):
            raise ValueError("replacement_ids 重复；去重拒绝，不静默扩大范围")
        if any(len(i) < 1 or len(i) > 64 for i in self.replacement_ids):
            raise ValueError("replacement_ids 每项必须是 1..64 字符的正式 PlanItem ID")
        return self


class ProgressWorkItem(ContractModel):
    """用户明确填入/确认的本次待安排工作行；不是模型建议，不从模型文字解析。"""

    key: str = PydField(min_length=1, max_length=40)
    text: str = PydField(min_length=1, max_length=500)
    reuse_action_id: str | None = PydField(default=None, max_length=64)
    minutes: int | None = PydField(default=None, le=JS_SAFE_INT_MAX)
    splittable: bool = True
    min_segment_minutes: int | None = PydField(default=None, ge=1, le=240)

    @model_validator(mode="after")
    def _check(self) -> ProgressWorkItem:
        if not KEY_RE.match(self.key):
            raise ValueError(f"progress work item key 形状非法：{self.key}")
        if self.minutes is not None and self.minutes <= 0:
            raise ValueError("minutes 必须为正安全整数或 null（未知），不能用 0")
        return self


class ProgressInput(ContractModel):
    """用户本轮进展说明与待安排清单；由前端实际提交形成，与模型建议分开。

    保留安排工作范围确认走 UserConfirmation(object_type=replan_scope)，绑定草案版本。
    """

    statement: str = PydField(default="", max_length=2000)
    work_items: list[ProgressWorkItem] = PydField(min_length=1, max_length=50)

    @model_validator(mode="after")
    def _check(self) -> ProgressInput:
        keys = [w.key for w in self.work_items]
        if len(set(keys)) != len(keys):
            raise ValueError("progress work item key 重复")
        return self


class PlanItemSnapshot(ContractModel):
    """所选旧安排的完整语义快照（M3 §6.1）；历史字段无 updated_at，复核比内容不比时间戳。"""

    plan_item_id: str = PydField(min_length=1, max_length=64)
    task_id: str = PydField(min_length=1, max_length=64)
    date: str
    planned_minutes: int = PydField(gt=0, le=JS_SAFE_INT_MAX)
    action_text: str = PydField(min_length=1, max_length=500)
    state: Literal["planned"] = "planned"
    order: int = PydField(ge=0, le=JS_SAFE_INT_MAX)
    actual_minutes: None = None
    focus_session_id: None = None
    task_ref_state: Literal["active"] = "active"

    @model_validator(mode="after")
    def _check(self) -> PlanItemSnapshot:
        _check_real_date(self.date, "date")
        return self


class ReplacementBaseline(ContractModel):
    """替换基线：逐条完整快照 + 捕获时全空间 FocusSession 扫描清单（无引用前提的记录）。

    prepare/apply 都基于活快照复核资格与内容；本基线不证明当前仍无会话引用。
    """

    captured_at: str
    items: list[PlanItemSnapshot] = PydField(min_length=1, max_length=100)
    focus_session_ids: list[str] = PydField(default_factory=list, max_length=5000)

    @model_validator(mode="after")
    def _check(self) -> ReplacementBaseline:
        _check_real_datetime(self.captured_at, "captured_at")
        ids = [i.plan_item_id for i in self.items]
        if len(set(ids)) != len(ids):
            raise ValueError("replacement baseline items 按 plan_item_id 去重")
        if len(set(self.focus_session_ids)) != len(self.focus_session_ids):
            raise ValueError("focus_session_ids 重复")
        return self


class DraftRevisionSnapshot(ContractModel):
    """旧版本只读快照；不能采用。整体受单草案 1MiB 约束。"""

    revision: int = PydField(ge=1)
    proposal: AssistantModelProposal | None = None
    planning_input: PlanningInput | None = None
    planning_result: PlanningResult | None = None
    requirements: list[RequirementCandidate] = PydField(default_factory=list, max_length=50)
    replan_scope: ReplanScope | None = None
    progress_input: ProgressInput | None = None
    replacement_baseline: ReplacementBaseline | None = None
    created_at: str

    @model_validator(mode="after")
    def _check(self) -> DraftRevisionSnapshot:
        _check_real_datetime(self.created_at, "created_at")
        return self


class UserConfirmation(ContractModel):
    """确认绑定草案版本+字段+值；改值使旧确认失效。确认≠改值。"""

    confirmation_id: str = PydField(min_length=1, max_length=64)
    draft_revision: int = PydField(ge=1)
    object_type: Literal["task", "note_field", "requirement", "gap", "overbook", "extra_work", "replan_scope"]
    object_id_or_key: str = PydField(min_length=1, max_length=64)
    # 复验 C1（D-2 提前落地）：task 型对象键可能是草案 key 或正式 ID，必须显式判别命名空间。
    id_scope: Literal["draft", "formal"] | None = None
    field_path: str = PydField(default="", max_length=120)
    old_value: Any = None
    new_value: Any = None
    confirmed_at: str

    @model_validator(mode="after")
    def _check(self) -> UserConfirmation:
        _check_real_datetime(self.confirmed_at, "confirmed_at")
        if self.object_type == "task":
            if self.id_scope is None:
                raise ValueError("task 型确认必须显式携带 id_scope=draft/formal")
        elif self.id_scope is not None:
            raise ValueError("非 task 型确认命名空间已固定，不得携带 id_scope")
        # 5B-1A 整改 R4：task/deadline 确认的旧/新值统一为 {value, precision} 投影或 null（明确无截止）。
        # 值口径与既有事实快照一致（宽松）；新值是否须走严格候选规则由确认适配器按 keep-old 例外判定。
        if self.object_type == "task" and self.field_path == "deadline":
            # 复验 C2：缺失字段≠明确 null；必须显式提交 old_value 与 new_value（含显式 null）。
            for name in ("old_value", "new_value"):
                if name not in self.model_fields_set:
                    raise ValueError(f"task/deadline 确认必须显式携带 {name}（缺失不得解释为明确无截止）")
            for name, v in (("old_value", self.old_value), ("new_value", self.new_value)):
                if v is None:
                    continue
                if not isinstance(v, dict) or set(v.keys()) != {"value", "precision"}:
                    raise ValueError(f"task/deadline 确认 {name} 必须是 null 或 {{value, precision}} 投影")
                if v["precision"] not in ("date", "datetime"):
                    raise ValueError(f"task/deadline 确认 {name}.precision 必须是 date/datetime")
                if not isinstance(v["value"], str):
                    raise ValueError(f"task/deadline 确认 {name}.value 必须是字符串")
                _check_existing_deadline_value(v["value"], v["precision"], f"task/deadline 确认 {name}.value")
        return self


class SourceFingerprint(ContractModel):
    source_id: str = PydField(min_length=1, max_length=64)
    sha256: str
    bytes: int = PydField(ge=0)

    @model_validator(mode="after")
    def _check(self) -> SourceFingerprint:
        if not SHA256_RE.match(self.sha256):
            raise ValueError("sha256 必须是 64 位小写十六进制")
        return self


class NoteFieldBaseline(ContractModel):
    note_id: str = PydField(min_length=1, max_length=64)
    field_key: str = PydField(min_length=1, max_length=64)
    value: Any = None
    status: FieldStatus = FieldStatus.candidate
    origin: FieldOrigin = FieldOrigin.model
    derived: bool = False


class FactBaseline(ContractModel):
    """事务外冻结的事实快照；内容哈希只用于前置快照与证据，不在活事务内读 Blob 计算。"""

    captured_at: str
    task_facts: list[PlanningTaskFact] = PydField(default_factory=list, max_length=20)
    action_facts: list[PlanningActionFact] = PydField(default_factory=list, max_length=100)
    source_fingerprints: list[SourceFingerprint] = PydField(default_factory=list, max_length=20)
    note_field_baselines: list[NoteFieldBaseline] = PydField(default_factory=list, max_length=200)
    occupancy: list[OccupancyEntry] = PydField(default_factory=list, max_length=2000)

    @model_validator(mode="after")
    def _check(self) -> FactBaseline:
        _check_real_datetime(self.captured_at, "captured_at")
        return self


class IdMapEntry(ContractModel):
    draft_key: str = PydField(min_length=1, max_length=40)
    formal_id: str = PydField(min_length=1, max_length=64)
    object_type: Literal["task", "action", "plan_item"]


def _check_cancelled_refs(ids: list[str], task_id: str | None, count: int) -> None:
    """取消集/目标任务引用同空同有；数量与计数一致；ID 去重。"""
    if len(set(ids)) != len(ids):
        raise ValueError("cancelled_plan_item_ids 重复")
    if any(len(i) < 1 or len(i) > 64 for i in ids):
        raise ValueError("cancelled_plan_item_ids 每项必须是 1..64 字符的正式 PlanItem ID")
    if len(ids) != count:
        raise ValueError("cancelled_plan_item_ids 数量必须等于 counts.plan_items_cancelled")
    if bool(ids) != (task_id is not None):
        raise ValueError("取消集与 replan_task_id 必须同空同有")


class ApplicationCounts(ContractModel):
    tasks_created: int = PydField(ge=0, le=20)
    tasks_updated: int = PydField(ge=0, le=20)
    actions_created: int = PydField(ge=0, le=100)
    plan_items_created: int = PydField(ge=0, le=700)
    plan_items_cancelled: int = PydField(default=0, ge=0, le=100)
    source_fields_confirmed: int = PydField(ge=0, le=200)


class AppliedSummary(ContractModel):
    """已应用草案的历史结果摘要；展示用，不是可执行回执。"""

    application_id: str = PydField(min_length=1, max_length=64)
    counts: ApplicationCounts
    id_map: list[IdMapEntry] = PydField(default_factory=list, max_length=820)
    unscheduled_kept: list[UnscheduledEntry] = PydField(default_factory=list, max_length=100)
    cancelled_plan_item_ids: list[str] = PydField(default_factory=list, max_length=100)
    replan_task_id: str | None = PydField(default=None, max_length=64)
    applied_at: str

    @model_validator(mode="after")
    def _check(self) -> AppliedSummary:
        _check_real_datetime(self.applied_at, "applied_at")
        _check_cancelled_refs(self.cancelled_plan_item_ids, self.replan_task_id, self.counts.plan_items_cancelled)
        return self


class AssistantDraft(ContractModel):
    id: str = PydField(min_length=1, max_length=64)
    record_version: Literal[1] = 1
    workspace_id: str = PydField(min_length=1, max_length=64)
    thread_id: str = PydField(min_length=1, max_length=64)
    revision: int = PydField(ge=1, le=20)
    revision_history: list[DraftRevisionSnapshot] = PydField(default_factory=list, max_length=19)
    status: DraftStatus = DraftStatus.editing
    mode: Literal["create", "replan"] = "create"
    proposal: AssistantModelProposal | None = None
    planning_input: PlanningInput | None = None
    planning_result: PlanningResult | None = None
    fact_baseline: FactBaseline | None = None
    replan_scope: ReplanScope | None = None
    progress_input: ProgressInput | None = None
    replacement_baseline: ReplacementBaseline | None = None
    assumptions: list[Assumption] = PydField(default_factory=list, max_length=50)
    user_confirmations: list[UserConfirmation] = PydField(default_factory=list, max_length=200)
    excluded_items: list[ExcludedItem] = PydField(default_factory=list, max_length=100)
    source_refs: list[ObjectRef] = PydField(default_factory=list, max_length=40)
    applied_summary: AppliedSummary | None = None
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def _check(self) -> AssistantDraft:
        _check_real_datetime(self.created_at, "created_at")
        _check_real_datetime(self.updated_at, "updated_at")
        revs = [h.revision for h in self.revision_history]
        if len(set(revs)) != len(revs):
            raise ValueError("revision_history 版本重复")
        if any(r >= self.revision for r in revs):
            raise ValueError("历史版本必须小于当前 revision")
        if len(self.revision_history) + 1 > 20:
            raise ValueError("每草案最多 20 个版本（含当前）")
        if self.status is DraftStatus.applied and self.applied_summary is None:
            raise ValueError("applied 草案必须带 applied_summary")
        if self.status is not DraftStatus.applied and self.applied_summary is not None:
            raise ValueError("只有 applied 草案才有 applied_summary")
        if self.mode == "create":
            if self.replan_scope is not None or self.progress_input is not None or self.replacement_baseline is not None:
                raise ValueError("create 草案不得携带改排范围/进展/替换基线")
            if self.planning_input is not None and self.planning_input.replacement_ids:
                raise ValueError("create 草案的 replacement_ids 必须为空")
        else:
            if self.replan_scope is None or self.progress_input is None:
                raise ValueError("replan 草案必须携带 replan_scope 与 progress_input")
            if self.planning_result is not None and self.replacement_baseline is None:
                raise ValueError("replan 草案有排程结果时必须携带替换基线")
            if self.planning_input is not None:
                if self.planning_input.replacement_ids != self.replan_scope.replacement_ids:
                    raise ValueError("planning_input.replacement_ids 必须与 replan_scope.replacement_ids 逐项相等")
                if self.planning_input.start_date != self.replan_scope.start_date:
                    raise ValueError("planning_input.start_date 必须与 replan_scope.start_date 一致")
        return self


# ---------------------------------------------------------------- 采用协调（M1，B 批子集）
# 来源：contract/proposals/assistant-v1/models.py B 批（采用信封/回执/台账），逐字段迁移。
# 唯一形状差异：PreparedTaskCreate.deadline 复用正式 Deadline（与提案 ExistingDeadline 同口径，
# 见 devlog/coordination/2026-11-25-M1采用类型契约差异.md）。M1 支持范围（禁 Task update/
# 字段确认写入）由前端领域层显式拒绝，契约形状不缩窄，供后续 5B-2/M3 使用。
# assistant_ops 台账永不进备份导出（BackupManifestV2 校验拒绝）。


class SourceFieldConfirmation(ContractModel):
    """采用时写入 Note 字段确认；保留 origin/derived/quote，确认≠改值。"""

    note_id: str = PydField(min_length=1, max_length=64)
    field_key: str = PydField(min_length=1, max_length=64)
    confirmed_value: Any = None
    origin: FieldOrigin = FieldOrigin.model
    derived: bool = False


class PreparedTaskCreate(ContractModel):
    formal_id: str = PydField(min_length=1, max_length=64)
    workspace_id: str = PydField(min_length=1, max_length=64)
    title: str = PydField(min_length=1, max_length=200)
    description: str = PydField(default="", max_length=4000)
    completion_criteria: str | None = PydField(default=None, max_length=2000)
    deadline: Deadline = PydField(default_factory=Deadline)
    note_ids: list[str] = PydField(default_factory=list, max_length=20)
    matter_id: str | None = None
    status: Literal["todo"] = "todo"
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def _check(self) -> PreparedTaskCreate:
        _check_real_datetime(self.created_at, "created_at")
        _check_real_datetime(self.updated_at, "updated_at")
        if self.deadline.from_note_id and self.deadline.from_note_id not in self.note_ids:
            raise ValueError("deadline 出处便签必须在 note_ids 中")
        return self


class PreparedTaskUpdate(ContractModel):
    target_id: str = PydField(min_length=1, max_length=64)
    expected_updated_at: str
    changes: TaskUpdateFields

    @model_validator(mode="after")
    def _check(self) -> PreparedTaskUpdate:
        _check_real_datetime(self.expected_updated_at, "expected_updated_at")
        c = self.changes
        if all(x is None for x in (c.title, c.description, c.completion_criteria, c.deadline_candidates)):
            raise ValueError("update 必须至少一个字段变更")
        return self


class PreparedActionCreate(ContractModel):
    formal_id: str = PydField(min_length=1, max_length=64)
    workspace_id: str = PydField(min_length=1, max_length=64)
    task_id: str = PydField(min_length=1, max_length=64)
    text: str = PydField(min_length=1, max_length=500)
    minutes: int = PydField(gt=0, le=JS_SAFE_INT_MAX)
    basis: Literal["requirement", "suggestion", "user"] = "suggestion"
    done: Literal[False] = False
    created_at: str

    @model_validator(mode="after")
    def _check(self) -> PreparedActionCreate:
        _check_real_datetime(self.created_at, "created_at")
        return self


class PreparedPlanItemCreate(ContractModel):
    """新 PlanItem 初始 planned、actual_minutes=null、focus_session_id=null、task_ref_state=active。

    不携带 action_id：草案建议行动引用不升级为正式安排的隐式绑定。
    """

    formal_id: str = PydField(min_length=1, max_length=64)
    workspace_id: str = PydField(min_length=1, max_length=64)
    task_id: str = PydField(min_length=1, max_length=64)
    date: str
    planned_minutes: int = PydField(gt=0, le=JS_SAFE_INT_MAX)
    action_text: str = PydField(min_length=1, max_length=500)
    state: Literal["planned"] = "planned"
    actual_minutes: None = None
    focus_session_id: None = None
    order: int = PydField(ge=0, le=JS_SAFE_INT_MAX)
    task_ref_state: Literal["active"] = "active"

    @model_validator(mode="after")
    def _check(self) -> PreparedPlanItemCreate:
        _check_real_date(self.date, "date")
        return self


class PlannedCancellation(ContractModel):
    """受限取消写集唯一形状（M3 §7）：预期内容全等 + 仅 planned→cancelled，其余字段保留。"""

    plan_item_id: str = PydField(min_length=1, max_length=64)
    expected: PlanItemSnapshot
    new_state: Literal["cancelled"] = "cancelled"

    @model_validator(mode="after")
    def _check(self) -> PlannedCancellation:
        if self.expected.plan_item_id != self.plan_item_id:
            raise ValueError("取消项 plan_item_id 与预期快照不一致")
        return self


class PreparedWriteSet(ContractModel):
    """完整准备写集。M3 增加受限取消分支；tasks_update/字段确认写入仍由前端领域层拒绝。"""

    project_title: str | None = PydField(default=None, min_length=1, max_length=80)
    source_field_confirmations: list[SourceFieldConfirmation] = PydField(default_factory=list, max_length=200)
    tasks_create: list[PreparedTaskCreate] = PydField(default_factory=list, max_length=20)
    tasks_update: list[PreparedTaskUpdate] = PydField(default_factory=list, max_length=20)
    actions_create: list[PreparedActionCreate] = PydField(default_factory=list, max_length=100)
    plan_items_create: list[PreparedPlanItemCreate] = PydField(default_factory=list, max_length=700)
    plan_items_cancel: list[PlannedCancellation] = PydField(default_factory=list, max_length=100)
    thread_result_update: ThreadMessage | None = None

    @model_validator(mode="after")
    def _check(self) -> PreparedWriteSet:
        ids = [c.plan_item_id for c in self.plan_items_cancel]
        if len(set(ids)) != len(ids):
            raise ValueError("plan_items_cancel 按 plan_item_id 去重")
        return self


class ApplicationEnvelope(ContractModel):
    application_id: str = PydField(min_length=1, max_length=64)
    workspace_id: str = PydField(min_length=1, max_length=64)
    draft_id: str = PydField(min_length=1, max_length=64)
    draft_revision: int = PydField(ge=1, le=20)
    mode: Literal["create", "replan"] = "create"
    input_signature: str
    id_map: list[IdMapEntry] = PydField(default_factory=list, max_length=820)
    write_set: PreparedWriteSet
    fact_baseline: FactBaseline
    replan_scope: ReplanScope | None = None
    replacement_baseline: ReplacementBaseline | None = None
    capacity_baseline: list[DaySummary] = PydField(min_length=7, max_length=7)
    user_confirmations: list[UserConfirmation] = PydField(default_factory=list, max_length=200)
    planned_gaps: list[UnscheduledEntry] = PydField(default_factory=list, max_length=100)
    gap_acknowledged: bool = False
    overbook_acknowledged: bool = False
    existing_overbook_dates: list[str] = PydField(default_factory=list, max_length=7)
    issued_at: str

    @model_validator(mode="after")
    def _check(self) -> ApplicationEnvelope:
        if not SHA256_RE.match(self.input_signature):
            raise ValueError("input_signature 必须是 64 位小写十六进制")
        _check_real_datetime(self.issued_at, "issued_at")
        if self.planned_gaps and not self.gap_acknowledged:
            raise ValueError("有未排分钟必须取得独立「仍有未排工作」确认")
        if self.existing_overbook_dates and not self.overbook_acknowledged:
            raise ValueError("存在既有过载日必须取得独立确认")
        for d in self.existing_overbook_dates:
            _check_real_date(d, "existing_overbook_dates")
        keys = [e.draft_key for e in self.id_map]
        if len(set(keys)) != len(keys):
            raise ValueError("id_map draft_key 重复")
        formal = [e.formal_id for e in self.id_map]
        if len(set(formal)) != len(formal):
            raise ValueError("id_map formal_id 重复")
        if self.write_set.project_title is not None:
            tasks = self.write_set.tasks_create
            if self.mode != "create" or not tasks or any(t.matter_id != self.application_id for t in tasks):
                raise ValueError("新项目须包含本次新建的任务，且使用同一项目归属")
            if self.application_id in formal or not self.write_set.project_title.strip():
                raise ValueError("新项目标识或名称无效")
        if self.mode == "create":
            if self.replan_scope is not None or self.replacement_baseline is not None:
                raise ValueError("create 信封不得携带改排范围/替换基线")
            if self.write_set.plan_items_cancel:
                raise ValueError("create 信封夹带取消写集：整体拒绝")
        else:
            if self.replan_scope is None or self.replacement_baseline is None:
                raise ValueError("replan 信封必须携带改排范围与替换基线")
            cancel_ids = {c.plan_item_id for c in self.write_set.plan_items_cancel}
            if cancel_ids != set(self.replan_scope.replacement_ids):
                raise ValueError("取消写集必须与用户选择的 replacement_ids 完全相等")
            baseline_ids = {i.plan_item_id for i in self.replacement_baseline.items}
            if cancel_ids != baseline_ids:
                raise ValueError("取消写集必须与替换基线覆盖完全相等")
            if not self.write_set.plan_items_create:
                raise ValueError("replan 新安排为零不提供采用：避免整批清空")
        return self


class ApplicationReceipt(ContractModel):
    """只能由本地成功事务产生。"""

    application_id: str = PydField(min_length=1, max_length=64)
    draft_id: str = PydField(min_length=1, max_length=64)
    draft_revision: int = PydField(ge=1, le=20)
    input_signature: str
    id_map: list[IdMapEntry] = PydField(default_factory=list, max_length=820)
    counts: ApplicationCounts
    unscheduled_kept: list[UnscheduledEntry] = PydField(default_factory=list, max_length=100)
    cancelled_plan_item_ids: list[str] = PydField(default_factory=list, max_length=100)
    replan_task_id: str | None = PydField(default=None, max_length=64)
    committed_at: str

    @model_validator(mode="after")
    def _check(self) -> ApplicationReceipt:
        if not SHA256_RE.match(self.input_signature):
            raise ValueError("input_signature 必须是 64 位小写十六进制")
        _check_real_datetime(self.committed_at, "committed_at")
        _check_cancelled_refs(self.cancelled_plan_item_ids, self.replan_task_id, self.counts.plan_items_cancelled)
        return self


class AssistantOpRecord(ContractModel):
    """assistant_ops 台账：pending 保留冻结信封，committed 保留回执。首版不自动清理。"""

    application_id: str = PydField(min_length=1, max_length=64)
    workspace_id: str = PydField(min_length=1, max_length=64)
    state: Literal["pending", "committed"]
    envelope: ApplicationEnvelope | None = None
    receipt: ApplicationReceipt | None = None
    created_at: str
    updated_at: str

    @model_validator(mode="after")
    def _check(self) -> AssistantOpRecord:
        _check_real_datetime(self.created_at, "created_at")
        _check_real_datetime(self.updated_at, "updated_at")
        if self.state == "pending":
            if self.envelope is None or self.receipt is not None:
                raise ValueError("pending 必须保留冻结信封且不得有回执")
            if self.envelope.application_id != self.application_id:
                raise ValueError("信封 application_id 与台账不一致")
        else:
            if self.receipt is None:
                raise ValueError("committed 必须保留回执")
            if self.receipt.application_id != self.application_id:
                raise ValueError("回执 application_id 与台账不一致")
        return self


# ---------------------------------------------------------------- 备份格式 v2


class AssistantThreadsPayload(ContractModel):
    schema_version: Literal["0.5.0", "0.6.0"] = "0.6.0"
    threads: list[AssistantThread] = PydField(default_factory=list)


class AssistantDraftsPayload(ContractModel):
    schema_version: Literal["0.5.0", "0.6.0"] = "0.6.0"
    drafts: list[AssistantDraft] = PydField(default_factory=list)


class PayloadEntry(ContractModel):
    path: str = PydField(min_length=1, max_length=200)
    bytes: int = PydField(ge=0)
    sha256: str

    @model_validator(mode="after")
    def _check(self) -> PayloadEntry:
        if not SHA256_RE.match(self.sha256):
            raise ValueError("sha256 必须是 64 位小写十六进制")
        return self


class BackupManifestV2(ContractModel):
    """v2 必需 payload 含助手两文件（即使为空）。不导出 assistant_ops/在途请求/owner/租约/可重放写集。

    D-3（已批准）：补回 v1 容器字段 format/source_count/image_count，与 v1 容器校验同口径。
    """

    format: Literal["jxl-backup"]
    backup_format_version: Literal[2] = 2
    schema_version: Literal["0.5.0", "0.6.0"] = "0.6.0"
    backup_id: str = PydField(min_length=1, max_length=64)
    exported_at: str
    source_workspace: dict[str, Any]
    counts: dict[str, int]
    source_count: int = PydField(ge=0)
    image_count: int = PydField(ge=0)
    payloads: list[PayloadEntry]

    @model_validator(mode="after")
    def _check(self) -> BackupManifestV2:
        _check_real_datetime(self.exported_at, "exported_at")
        paths = {p.path for p in self.payloads}
        required = {"data/sources.json", "data/docs.json", "data/assistant_threads.json", "data/assistant_drafts.json"}
        missing = required - paths
        if missing:
            raise ValueError(f"v2 必需 payload 缺失：{sorted(missing)}")
        if "data/assistant_ops.json" in paths:
            raise ValueError("不得导出 assistant_ops 台账")
        for k in ("assistant_thread_count", "assistant_draft_count"):
            if k not in self.counts:
                raise ValueError(f"manifest.counts 缺少 {k}")
        return self


# ---------------------------------------------------------------- 登记（models.py 并入 ALL_MODELS）

ASSISTANT_PERSISTENT_MODELS: list[type[ContractModel]] = [
    # 引用/证据（8）
    DraftRef, ExistingRef, ObjectRef,
    SourceExcerptEvidence, NoteFieldEvidence, UserMessageEvidence, ExistingFactEvidence,
    DeadlineCandidate,
    # 建议层（14）
    TaskProposalCreate, TaskProposalLink, TaskUpdateFields, TaskProposalUpdate,
    ActionProposalCreate, ActionProposalReuse, WorkItemProposal,
    PriorityRequirementValue, SplittableRequirementValue, OrderingRequirementValue,
    RequirementCandidate, Assumption, ProposalWarning, AssistantModelProposal,
    # 已确认要求（1）
    ConfirmedRequirement,
    # 规划层（14）
    PlanningTaskFact, PlanningActionFact, DayBudget, OccupancyEntry, PlanningWorkItem, PlanningInput,
    Segment, DaySummary, UnscheduledEntry, UnknownItem, ExcludedItem,
    PlanningConflict, PlanningWarning, PlanningResult,
    # 草案层（13）
    ClarificationTurnRecord, UserAuthoredInput,
    ThreadMessage, AssistantThread, DraftRevisionSnapshot, UserConfirmation,
    SourceFingerprint, NoteFieldBaseline, FactBaseline, IdMapEntry, ApplicationCounts,
    AppliedSummary, AssistantDraft,
    # M3 改排（6）
    ReplanScope, ProgressWorkItem, ProgressInput, PlanItemSnapshot, ReplacementBaseline, PlannedCancellation,
    # 采用层（9，M1 自提案 B 批迁移）
    SourceFieldConfirmation, PreparedTaskCreate, PreparedTaskUpdate,
    PreparedActionCreate, PreparedPlanItemCreate, PreparedWriteSet,
    ApplicationEnvelope, ApplicationReceipt, AssistantOpRecord,
    # 备份 v2（4）
    AssistantThreadsPayload, AssistantDraftsPayload, PayloadEntry, BackupManifestV2,
]
