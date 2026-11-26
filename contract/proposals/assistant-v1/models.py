"""阶段5B-0 智能体协议提案 —— 历史提案与协议测试入口（5B-1B 起不再是唯一手写来源）。

A 批 51 个持久模型 + 4 个枚举已迁入 contract/assistant_models.py（5B-1B）；
B 批采用信封/回执/台账 9 型已迁入同文件（M1）；C 批 propose HTTP 17 型 + Intent 已迁入
contract/assistant_http.py（M2），均经 contract/models.py 再导出，schema 0.5.0。本目录保留：
- FixtureCase 样本容器与 ALL_PROPOSAL_MODELS / PROPOSAL_ENDPOINTS 登记；
- 对已迁移类型的再导出，供 selftest.py / generate.py / typecheck 继续做协议测试。

规则：
- 已迁移类型只有 contract/assistant_models.py（持久）与 contract/assistant_http.py（HTTP）各一份运行时定义；本文件不得重复手写。
- 生产前后端仍不得 import 本目录；本目录反过来 import 正式契约（单向）。
- schema.json / typedefs.d.ts / limits.json 由本目录 generate.py 导出，不要手改生成物。
- 结构校验写在 pydantic validator；跨对象引用/依赖/守恒等语义校验见 selftest.py。

依据：devlog/coordination/2026-11-24-阶段5B-0协议与产品规则开工单.md（D01–D15、§3–§8）
与 2026-11-24-阶段5B-1B草案存储与备份恢复开工单.md §4。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Literal

from pydantic import Field as PydField, model_validator

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from contract.models import (  # noqa: E402
    ContractModel,
    FieldOrigin,
    FieldStatus,
    TaskStatus,
    RefState,
    PlanItemState,
    LIMITS,
    KEY_RE,
    SHA256_RE,
    JS_SAFE_INT_MAX,
    _check_real_date,
    _check_real_datetime,
    _check_existing_deadline_value,
    _consecutive_days,
)
from contract.assistant_models import (  # noqa: E402
    Priority,
    Strength,
    DraftStatus,
    UnscheduledReason,
    DraftRef,
    ExistingRef,
    TypedRef,
    ObjectRef,
    SourceExcerptEvidence,
    NoteFieldEvidence,
    UserMessageEvidence,
    ExistingFactEvidence,
    EvidenceRef,
    DeadlineCandidate,
    TaskProposalCreate,
    TaskProposalLink,
    TaskUpdateFields,
    TaskProposalUpdate,
    TaskProposal,
    ActionProposalCreate,
    ActionProposalReuse,
    ActionProposal,
    WorkItemProposal,
    PriorityRequirementValue,
    SplittableRequirementValue,
    OrderingRequirementValue,
    RequirementCandidate,
    Assumption,
    ProposalWarning,
    AssistantModelProposal,
    ConfirmedRequirement,
    PlanningTaskFact,
    DayBudget,
    OccupancyEntry,
    PlanningWorkItem,
    PlanningInput,
    Segment,
    DaySummary,
    UnscheduledEntry,
    UnknownItem,
    ExcludedItem,
    PlanningConflict,
    PlanningWarning,
    PlanningResult,
    ThreadMessage,
    ClarificationTurnRecord,
    UserAuthoredInput,
    render_user_authored_text,
    AssistantThread,
    DraftRevisionSnapshot,
    UserConfirmation,
    SourceFingerprint,
    NoteFieldBaseline,
    FactBaseline,
    IdMapEntry,
    ApplicationCounts,
    AppliedSummary,
    AssistantDraft,
    SourceFieldConfirmation,
    PreparedTaskCreate,
    PreparedTaskUpdate,
    PreparedActionCreate,
    PreparedPlanItemCreate,
    PreparedWriteSet,
    ApplicationEnvelope,
    ApplicationReceipt,
    AssistantOpRecord,
    AssistantThreadsPayload,
    AssistantDraftsPayload,
    PayloadEntry,
    BackupManifestV2,
)
from contract.assistant_http import (  # noqa: E402
    ASSISTANT_PROTOCOL_VERSION,
    Intent,
    ClarificationQuestion,
    ContentFingerprint,
    NoteFieldCandidate,
    SelectedSource,
    ExistingDeadline,
    SelectedTask,
    SelectedAction,
    ContextDayBudget,
    ProtectedPlanSummary,
    PlanningContext,
    PreviousDraft,
    AssistantProposeRequest,
    ClarificationPayload,
    ProposalPayload,
    ExplanationPayload,
    ResponsePayload,
    AssistantProposeResponse,
    ProposalApiError,
    PROPOSE_ENDPOINT,
)

TARGET_SCHEMA_VERSION = "0.5.0"
TARGET_DB_VERSION = 4
TARGET_BACKUP_FORMAT_VERSION = 2

ProposalModel = ContractModel


# ---------------------------------------------------------------- 枚举与 HTTP 类型
# Intent 与 C 批 propose HTTP 17 型已于 M2 迁入正式契约 contract/assistant_http.py（见顶部 import）。
# 唯一文案差异：PROPOSE_ENDPOINT.phase 由「5B-3（本批仅提案，不实现）」改为「M2」。
# 差异记录：devlog/coordination/2026-11-25-M2-propose契约差异.md。ALL_PROPOSAL_MODELS 名单不变。

# ---------------------------------------------------------------- 采用信封 / 回执 / 台账
# B 批 9 型已于 M1 迁入正式契约 contract/assistant_models.py（见顶部 import 复用）。
# 唯一形状差异：PreparedTaskCreate.deadline 改用正式 Deadline（与 ExistingDeadline 同口径）。
# 差异记录：devlog/coordination/2026-11-25-M1采用类型契约差异.md。ALL_PROPOSAL_MODELS 名单不变。


# ---------------------------------------------------------------- fixture 容器与登记


class FixtureCase(ProposalModel):
    """一份样本：正向接受 / 负向拒绝 / 场景预期（设计验证）。全部虚构。"""

    id: str = PydField(min_length=1, max_length=64)
    title: str = PydField(min_length=1, max_length=200)
    layer: Literal["http", "model", "planning", "draft", "application", "backup", "scenario"]
    mode: Literal["accept", "reject", "expect"]
    target: str = PydField(min_length=1, max_length=80)
    acceptance: list[str] = PydField(default_factory=list, max_length=10)
    implement_batch: str = PydField(min_length=1, max_length=20)
    payload: Any = None
    expected_error: str | None = None
    expected: Any = None
    notes: str = PydField(default="", max_length=1000)

    @model_validator(mode="after")
    def _check(self) -> FixtureCase:
        if self.mode == "reject" and not self.expected_error:
            raise ValueError("负向样本必须给预期拒绝原因")
        if self.mode == "expect" and self.expected is None:
            raise ValueError("场景样本必须给预期结果")
        return self


ALL_PROPOSAL_MODELS: list[type[ProposalModel]] = [
    DraftRef, ExistingRef, ObjectRef,
    SourceExcerptEvidence, NoteFieldEvidence, UserMessageEvidence, ExistingFactEvidence,
    DeadlineCandidate, TaskProposalCreate, TaskProposalLink, TaskUpdateFields, TaskProposalUpdate,
    ActionProposalCreate, ActionProposalReuse, WorkItemProposal,
    PriorityRequirementValue, SplittableRequirementValue, OrderingRequirementValue,
    RequirementCandidate, Assumption, ProposalWarning, AssistantModelProposal, ClarificationQuestion,
    ContentFingerprint, NoteFieldCandidate, SelectedSource, ExistingDeadline, SelectedTask, SelectedAction,
    ContextDayBudget, ProtectedPlanSummary, PlanningContext, ConfirmedRequirement, PreviousDraft,
    AssistantProposeRequest, ClarificationPayload, ProposalPayload, ExplanationPayload,
    AssistantProposeResponse, ProposalApiError,
    PlanningTaskFact, DayBudget, OccupancyEntry, PlanningWorkItem, PlanningInput,
    Segment, DaySummary, UnscheduledEntry, UnknownItem, ExcludedItem,
    PlanningConflict, PlanningWarning, PlanningResult,
    ThreadMessage, AssistantThread, DraftRevisionSnapshot, UserConfirmation,
    ClarificationTurnRecord, UserAuthoredInput,
    SourceFingerprint, NoteFieldBaseline, FactBaseline, IdMapEntry, ApplicationCounts,
    AppliedSummary, AssistantDraft,
    SourceFieldConfirmation, PreparedTaskCreate, PreparedTaskUpdate, PreparedActionCreate,
    PreparedPlanItemCreate, PreparedWriteSet, ApplicationEnvelope, ApplicationReceipt, AssistantOpRecord,
    AssistantThreadsPayload, AssistantDraftsPayload, PayloadEntry, BackupManifestV2,
    FixtureCase,
]

PROPOSAL_ENDPOINTS: list[dict[str, Any]] = [PROPOSE_ENDPOINT]