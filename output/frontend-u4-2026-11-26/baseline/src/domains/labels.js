// 产品中文文案：内部枚举只作技术标注（title/详情），不作普通用户文案。
import { planSnapshotDiff } from './plan'

export const FIELD_LABELS = {
  title: '标题',
  deadline: '截止时间',
  requirement: '需要提交',
  constraints: '要求',
  submit_to: '提交入口',
  reminder: '提醒',
  time_nodes: '时间节点',
  summary: '摘要',
  steps: '步骤',
  cautions: '注意事项',
  keywords: '关键词',
}

export const STATUS_LABELS = {
  candidate: '待核对',
  confirmed: '已确认',
  unresolved: '待确认',
  missing: '原文未提',
  draft: '草稿',
  reviewed: '已审阅',
  failed: '分析失败',
  pending: '待处理',
  todo: '待办',
  doing: '进行中',
  blocked: '受阻',
  done: '已完成',
}

export const ROLE_LABELS = {
  submission_deadline: '提交截止',
  event_start: '活动开始',
  event_end: '活动结束',
  other: '其他',
  unknown: '未分类',
}

export const BASIS_LABELS = {
  explicit: '原文写明',
  relative: '相对换算',
  inferred: '补年推断',
  superseded: '已取代',
}

export const REF_SOURCE_LABELS = {
  user: '用户指定',
  message_date: '消息日期',
}

// 事项内的资料角色（契约 MatterRole，PRD F05：要求 / 补充 / 参考 / 成果 / 其他）。
export const MATTER_ROLE_LABELS = {
  requirement: '要求',
  supplement: '补充',
  reference: '参考',
  outcome: '成果',
  other: '其他',
}

export const CONTENT_TYPE_LABELS = {
  notice: '通知',
  tutorial: '教程',
  reference: '参考资料',
}

// 每日安排（契约 PlanItem）状态与历史原因文案（5A-1）：内部枚举只作技术标注。
export const PLAN_STATE_LABELS = {
  planned: '待执行',
  partial: '部分完成',
  done: '已完成',
  cancelled: '已取消',
  moved: '已改期',
}

export const PLAN_HISTORY_REASON_LABELS = {
  task_deleted: '原任务已删除',
  task_done: '任务已完成',
}

export const PLAN_PROBLEM_LABELS = {
  CONFLICTING_SESSION: '同 ID 记录冲突',
  INVALID_DURATION: '时长非法',
  INVALID_ENDED_AT: '结束时间非法',
}

export const SESSION_OUTCOME_LABELS = { done: '完成', partial: '部分完成', blocked: '受阻' }

// 开始确认事实八字段（5A-2B）：差异框列全变化，值文案与任务/行动展示同口径。
export const BEGIN_FACT_LABELS = {
  actionId: '将执行的行动', actionText: '行动内容', actionMinutes: '行动预计分钟',
  taskStatus: '任务状态', taskCurrentActionId: '任务当前行动',
  deadlineValue: '任务截止', deadlinePrecision: '截止精度', confirmDate: '确认日期',
}
export function beginFactValueLabel(field, value, actionTextOf) {
  if (value == null) return '无'
  if (field === 'taskStatus') return label(STATUS_LABELS, value)
  if (field === 'actionId' || field === 'taskCurrentActionId') return (actionTextOf && actionTextOf(value)) || value
  if (field === 'actionMinutes') return `${value} 分钟`
  return String(value)
}

// 实际用时展示：权威 null=未记录；0=有结束记录但不足一分钟；异常→待核对（不给数字）。
export function planActualLabel(summary) {
  if (!summary || !summary.authoritative) return '待核对'
  if (summary.actualMinutes == null) return '未记录'
  if (summary.actualMinutes === 0) return '<1分钟'
  return `${summary.actualMinutes} 分钟`
}

export const planHistoryReasonLabel = (reason) =>
  PLAN_HISTORY_REASON_LABELS[reason] || PLAN_STATE_LABELS[reason] || reason

export const label = (map, key) => map[key] || key

// 安排快照字段中文名与值文案（5A-1 P2 多字段差异）：编辑器与详情共用，避免两套展示规则。
export const PLAN_FIELD_LABELS = { task_id: '所属任务', date: '安排日期', state: '状态', action_text: '工作说明', planned_minutes: '预计分钟', task_ref_state: '任务引用' }
export const PLAN_REF_STATE_LABELS = { active: '引用有效', deleted: '任务已删除' }
export function planFieldValueLabel(field, value, taskTitle) {
  if (value == null) return '未记录'
  if (field === 'task_id') return taskTitle || value
  if (field === 'state') return label(PLAN_STATE_LABELS, value)
  if (field === 'task_ref_state') return label(PLAN_REF_STATE_LABELS, value)
  if (field === 'planned_minutes') return `${value} 分钟`
  return String(value)
}
// 差异框行模型：逐项列全部变化字段，当前值只取自开框冻结快照（与确认提交同版）；
// writes 标出本次草稿/操作将写入的字段值，未主动编辑却会被旧草稿覆盖的字段必须可见。
export function planStaleRows(expected, frozen, writes, titleOf) {
  return planSnapshotDiff(expected, frozen).map((r) => ({
    ...r,
    name: label(PLAN_FIELD_LABELS, r.field),
    expectedText: planFieldValueLabel(r.field, r.expected, titleOf(r.expected)),
    currentText: planFieldValueLabel(r.field, r.current, titleOf(r.current)),
    writeText: r.field in writes ? planFieldValueLabel(r.field, writes[r.field], titleOf(writes[r.field])) : null,
  }))
}