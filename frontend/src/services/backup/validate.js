// 恢复前三层校验（纯规则，零写入，离线浏览器可跑）。开工单 §5。
// A 归档/内容完整性：manifest+必需文件唯一、路径规范、声明与实际一致、SHA-256/字节/类型/限额。
// B 结构/数据：复用权威契约 schema.json（contractSchema）校验业务核心 + 补 models.py 的
//   model_validator 语义（真实时间/数值/版本/跨字段）+ ID 唯一/单一来源空间/计数/禁运运行时凭据。
// C 关系闭包：按 generate.py 的跨记录不变量解析活引用/历史引用/嵌套 Quote，≤1 未结束会话。
// 输入是已解析归档模型 { entries:[{path,bytes:Uint8Array}], zipBytes?:Uint8Array }（4-0 不接真实 ZIP）。
// 所有错误带对象+原因一次性列出；v0 旧缺失引用走预览说明（notes），不伪造已删事件、不硬拒。
import {
  LIMITS, MANIFEST_PATH, SOURCES_PATH, DOCS_PATH,
  ASSISTANT_THREADS_PATH, ASSISTANT_DRAFTS_PATH, ASSISTANT_PATHS,
  requiredPathsFor, compatFor, BACKUP_FORMAT_VERSION, SCHEMA_VERSION,
  isAllowedArchivePath, validateManifestShape, sha256Hex, detectImageType,
  bytesToUtf8, IMAGE_EXTS,
} from './format'
import { validateAgainstDef, validateAgainstFrozen040Def } from './contractSchema'
import { businessCoreOfDoc, businessCoreOfSource, DOC_KINDS, KIND_TO_DEF, focusRecordVersion } from './adapt'
import { isValidTimeValue, isValidDate } from '@/domains/time'
import { checkDraftBounds, checkThreadBounds } from '@/domains/assistant/draft'
import { validatePlanningInput } from '@/domains/planning/schedule.js'
import { validatePlanningResult } from '@/domains/planning/validate.js'
import { KEY_RE, checkDeadlineCandidateValue, checkExistingDeadlineValue } from '@/domains/planning/protocol.js'

// models.py 的时间形状正则（权威契约口径；time.js 的 isValidTimeValue 负责真实日历/时刻/偏移）。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:\d{2}|Z)?$/
const DEADLINE_VALUE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)?)?$/

// 真实 ISO 日期时间：形状 + 去小数秒后按 time.js 校验日历/时刻/偏移（naive 按北京解释，不猜设备时区）。
function realDatetimeOk(value) {
  if (typeof value !== 'string' || !DATETIME_RE.test(value)) return false
  return isValidTimeValue(value.replace(/\.\d+/, ''))
}
function deadlineValueOk(value, precision) {
  if (typeof value !== 'string') return false
  if (precision === 'date') return DATE_RE.test(value) && isValidDate(value)
  return realDatetimeOk(value)
}
function timeNodeValueOk(value) {
  if (typeof value !== 'string' || !DEADLINE_VALUE_RE.test(value)) return false
  return value.includes('T') ? isValidTimeValue(value) : isValidDate(value)
}

const err = (errors, layer, message, extra = {}) => errors.push({ layer, message, ...extra })

// 禁运的运行时/凭据字段：业务记录不得携带持有者/租约/纪元/修订/草稿序号/令牌/运行占位。
const FORBIDDEN_KEYS = new Set([
  'owner_id', 'lease_expires_at', 'epoch', 'revision', 'draft_seq', 'last_checkpoint_at',
  'recovery', 'run_id', 'session_runtime', 'focus_runtime', 'token', 'access_token',
  'api_key', 'secret', 'password', 'authorization',
])
function scanForbidden(value, path, objectId, errors, layer = 'B') {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach((v, i) => scanForbidden(v, `${path}[${i}]`, objectId, errors, layer)); return }
  for (const k of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(k)) err(errors, layer, `业务记录不得携带运行时/凭据字段 ${k}`, { objectId, path: `${path}.${k}` })
    scanForbidden(value[k], `${path}.${k}`, objectId, errors, layer)
  }
}

// ---------------------------------------------------------------- 语义补充（镜像 models.py model_validator）
// schema.json 只管结构/类型/枚举/未知字段；以下跨字段/真实时间/数值/版本规则是 Python 校验器独有。

function semTimeNode(n, path, objectId, errors) {
  if (n.value != null && !timeNodeValueOk(n.value)) err(errors, 'B', `time_node.value 必须是单一 date 或规范 datetime 且日历合法：${n.value}`, { objectId, path: `${path}.value` })
  if ((n.basis === 'relative' || n.basis === 'inferred') && n.derived !== true) err(errors, 'B', 'relative/inferred 节点必须标 derived', { objectId, path: `${path}.basis` })
  if (n.reference_at != null && !DATE_RE.test(n.reference_at)) err(errors, 'B', 'reference_at 必须是 YYYY-MM-DD', { objectId, path: `${path}.reference_at` })
  if (n.message_date != null && !DATE_RE.test(n.message_date)) err(errors, 'B', 'message_date 必须是 YYYY-MM-DD', { objectId, path: `${path}.message_date` })
}

function semField(f, path, objectId, errors) {
  if (f.key === 'time_nodes' && f.value != null) {
    if (!Array.isArray(f.value)) err(errors, 'B', 'time_nodes 的 value 必须是 TimeNode 数组', { objectId, path: `${path}.value` })
    else f.value.forEach((n, i) => { if (n && typeof n === 'object') semTimeNode(n, `${path}.value[${i}]`, objectId, errors) })
  }
  if (f.status === 'missing' && f.value != null) err(errors, 'B', 'missing 字段不得带 value', { objectId, path: `${path}.value` })
  if ((f.status === 'candidate' || f.status === 'unresolved') && f.raw && f.quote == null) err(errors, 'B', '有原文的 candidate/unresolved 字段必须带 quote', { objectId, path: `${path}.quote` })
  if (f.status === 'unresolved' && !f.raw && f.derived !== true) err(errors, 'B', 'unresolved 必须给出原文或标明推算值', { objectId, path: `${path}.status` })
  if (f.derived === true && f.status !== 'unresolved' && f.status !== 'confirmed') err(errors, 'B', 'derived 推算值必须保持 unresolved 或 confirmed', { objectId, path: `${path}.derived` })
  if (f.status === 'confirmed' && f.value == null) err(errors, 'B', 'confirmed 必须有有效值，不能确认 null', { objectId, path: `${path}.value` })
}

function semDeadline(d, path, objectId, errors) {
  if (d.precision === 'none') {
    if (d.value != null) err(errors, 'B', 'precision=none 时 value 必须为空', { objectId, path: `${path}.value` })
    return
  }
  if (d.value == null) { err(errors, 'B', '有精度就必须有值', { objectId, path: `${path}.value` }); return }
  if (!deadlineValueOk(d.value, d.precision)) err(errors, 'B', `value 与 precision=${d.precision} 不符或日历非法：${d.value}`, { objectId, path: `${path}.value` })
  if (d.source === 'note' && d.from_note_id == null) err(errors, 'B', 'source=note 时必须记录出处便签', { objectId, path: `${path}.from_note_id` })
  if (d.source === 'manual' && d.from_note_id != null) err(errors, 'B', 'source=manual 时不得伪造便签出处', { objectId, path: `${path}.from_note_id` })
  if (d.confirmed_at == null) err(errors, 'B', '截止必须记录确认时间', { objectId, path: `${path}.confirmed_at` })
}

function semTaskSnapshot(s, path, objectId, errors) {
  if (!realDatetimeOk(s.captured_at)) err(errors, 'B', `captured_at 必须是真实 ISO 日期时间：${s.captured_at}`, { objectId, path: `${path}.captured_at` })
  if (s.deadline_precision === 'none') {
    if (s.deadline_value != null) err(errors, 'B', 'precision=none 时 deadline_value 必须为空', { objectId, path: `${path}.deadline_value` })
    return
  }
  if (s.deadline_value == null) { err(errors, 'B', '有精度就必须有值', { objectId, path: `${path}.deadline_value` }); return }
  if (!deadlineValueOk(s.deadline_value, s.deadline_precision)) err(errors, 'B', `deadline_value 与 precision=${s.deadline_precision} 不符或日历非法`, { objectId, path: `${path}.deadline_value` })
}

function semActionSnapshot(s, path, objectId, errors) {
  if (!realDatetimeOk(s.captured_at)) err(errors, 'B', `captured_at 必须是真实 ISO 日期时间：${s.captured_at}`, { objectId, path: `${path}.captured_at` })
  if (typeof s.text !== 'string' || !s.text.trim()) err(errors, 'B', '行动快照文本不能为空', { objectId, path: `${path}.text` })
  if (!(Number.isInteger(s.minutes) && s.minutes > 0)) err(errors, 'B', 'minutes 必须为正整数', { objectId, path: `${path}.minutes` })
}

function semFocusSession(s, objectId, errors) {
  const p = 'FocusSession'
  if (!(Number.isInteger(s.accumulated_ms) && s.accumulated_ms >= 0)) err(errors, 'B', 'accumulated_ms 不得为负', { objectId, path: `${p}.accumulated_ms` })
  if (s.running === true && (s.outcome != null || s.ended_at != null)) err(errors, 'B', '进行中的会话不得有 outcome / ended_at', { objectId, path: `${p}.running` })
  if (s.outcome === 'blocked' && !s.blocker) err(errors, 'B', '卡住必须记录具体卡点', { objectId, path: `${p}.blocker` })
  const v1Fields = ['timer_anchor_at', 'task_snapshot', 'action_snapshot', 'task_ref_state', 'action_ref_state']
  if (focusRecordVersion(s) === 0) {
    // 旧记录（含缺省 record_version）沿用 0.3.0：新字段出现即混版，拒绝；不补造过去快照，不收紧 started_at/ended_at。
    for (const f of v1Fields) if (s[f] != null) err(errors, 'B', `record_version=0 的旧记录不得携带 v1 字段 ${f}`, { objectId, path: `${p}.${f}` })
    return
  }
  if (!realDatetimeOk(s.started_at)) err(errors, 'B', `started_at 必须是真实 ISO 日期时间：${s.started_at}`, { objectId, path: `${p}.started_at` })
  if (s.ended_at != null && !realDatetimeOk(s.ended_at)) err(errors, 'B', `ended_at 必须是真实 ISO 日期时间：${s.ended_at}`, { objectId, path: `${p}.ended_at` })
  if (s.timer_anchor_at != null && !realDatetimeOk(s.timer_anchor_at)) err(errors, 'B', `timer_anchor_at 必须是真实 ISO 日期时间：${s.timer_anchor_at}`, { objectId, path: `${p}.timer_anchor_at` })
  if (s.task_snapshot == null || s.action_snapshot == null) err(errors, 'B', 'v1 会话开始即必须有任务与行动快照', { objectId, path: `${p}.task_snapshot` })
  else { semTaskSnapshot(s.task_snapshot, `${p}.task_snapshot`, objectId, errors); semActionSnapshot(s.action_snapshot, `${p}.action_snapshot`, objectId, errors) }
  if (s.task_ref_state == null || s.action_ref_state == null) err(errors, 'B', 'v1 会话必须分别标记任务与行动引用状态', { objectId, path: `${p}.task_ref_state` })
  if ((s.ended_at == null) !== (s.outcome == null)) err(errors, 'B', 'ended_at 与 outcome 必须成对存在', { objectId, path: `${p}.ended_at` })
  if (s.running === true) {
    if (s.timer_anchor_at == null) err(errors, 'B', 'v1 运行中会话必须有计时锚点', { objectId, path: `${p}.timer_anchor_at` })
  } else if (s.timer_anchor_at != null) err(errors, 'B', '暂停/结束的会话锚点必须为空', { objectId, path: `${p}.timer_anchor_at` })
  if (s.ended_at == null && (s.task_ref_state !== 'active' || s.action_ref_state !== 'active')) err(errors, 'B', '未结束会话（含暂停）的引用必须 active', { objectId, path: `${p}.task_ref_state` })
}

function semPlanItem(p, objectId, errors) {
  const path = 'PlanItem'
  if (typeof p.date !== 'string' || !DATE_RE.test(p.date)) err(errors, 'B', 'date 必须是 YYYY-MM-DD', { objectId, path: `${path}.date` })
  if (!(Number.isInteger(p.planned_minutes) && p.planned_minutes > 0)) err(errors, 'B', 'planned_minutes 必须为正整数', { objectId, path: `${path}.planned_minutes` })
  if (p.focus_session_id != null && p.actual_minutes == null) err(errors, 'B', '关联了专注会话就必须记录实际用时', { objectId, path: `${path}.actual_minutes` })
  if (p.state === 'planned' && p.task_ref_state === 'deleted') err(errors, 'B', '未执行计划不得继续指向已删任务', { objectId, path: `${path}.task_ref_state` })
}

// 按契约定义补语义。core 是投影掉本地字段后的业务核心。
function semByDef(defName, core, objectId, errors) {
  switch (defName) {
    case 'Note':
      if (core.status === 'reviewed' && core.reviewed_at == null) err(errors, 'B', 'reviewed 便签必须有 reviewed_at', { objectId, path: 'Note.reviewed_at' })
      if (core.matter_id == null && core.matter_role != null) err(errors, 'B', '未归组便签不得有资料角色', { objectId, path: 'Note.matter_role' })
      if (Array.isArray(core.fields)) core.fields.forEach((f, i) => { if (f && typeof f === 'object') semField(f, `Note.fields[${i}]`, objectId, errors) })
      break
    case 'Matter':
      if (core.deadline && typeof core.deadline === 'object') {
        semDeadline(core.deadline, 'Matter.deadline', objectId, errors)
        if (core.deadline.value && core.deadline.source !== 'manual') err(errors, 'B', '项目总截止须由用户设置', { objectId, path: 'Matter.deadline.source' })
      }
      if (Array.isArray(core.note_ids) && new Set(core.note_ids).size !== core.note_ids.length) err(errors, 'B', 'note_ids 不得重复', { objectId, path: 'Matter.note_ids' })
      break
    case 'Task':
      if (core.deadline && typeof core.deadline === 'object') semDeadline(core.deadline, 'Task.deadline', objectId, errors)
      if (core.deadline?.from_note_id != null && Array.isArray(core.note_ids) && !core.note_ids.includes(core.deadline.from_note_id)) err(errors, 'B', 'deadline 出处便签必须在 note_ids 中', { objectId, path: 'Task.deadline.from_note_id' })
      break
    case 'Action':
      if (!(Number.isInteger(core.minutes) && core.minutes > 0)) err(errors, 'B', 'minutes 必须为正整数', { objectId, path: 'Action.minutes' })
      break
    case 'FocusSession': semFocusSession(core, objectId, errors); break
    case 'PlanItem': semPlanItem(core, objectId, errors); break
    default: break
  }
}

// 本地额外字段的语义校验（core 已投影掉它们，故从原记录校验）。不放开 additionalProperties：
// 业务核心仍按 schema 严格校验，这里只补「已适配本地字段」的合法类型/时间，非法值仍拒。
function semLocalDocFields(d, objectId, errors) {
  if (d.kind === 'matter' && d.updated_at != null && !realDatetimeOk(d.updated_at)) {
    err(errors, 'B', `事项本地 updated_at 必须是真实 ISO 日期时间：${d.updated_at}`, { objectId, path: 'Matter.updated_at' })
  }
}

// ---------------------------------------------------------------- 助手记录语义（镜像 contract/assistant_models.py model_validator）
// 助手草案/线程是纯契约 JSON：schema additionalProperties:false 即白名单（revision 是合法契约字段，
// 不走 docs 的 FORBIDDEN_KEYS 扫描）。这里只补与活上下文无关的模型守卫；
// 引用缺失不在 B/C 层拒绝（历史宽容：恢复时隔离映射 + needs_review），容器归属损坏除外。
const SHA256_RE = /^[0-9a-f]{64}$/
const aErr = (errors, message, objectId, path) => err(errors, 'B', message, { objectId, path })

function semRequirementValue(type, value, path, objectId, errors) {
  if (type === 'daily_budget') {
    if (value != null && !(Number.isInteger(value) && value >= 0 && value <= 1440)) {
      aErr(errors, 'daily_budget 必须是 0–1440 整数或 null（未知待澄清，不默认 0）', objectId, path)
    }
  } else if (type === 'unavailable_days') {
    if (!Array.isArray(value) || value.length > 31 || !value.every((x) => typeof x === 'string' && DATE_RE.test(x) && isValidDate(x))) {
      aErr(errors, 'unavailable_days 必须是真实日期数组（≤31）', objectId, path)
    }
  } else if (type === 'start_date') {
    if (typeof value !== 'string' || !DATE_RE.test(value) || !isValidDate(value)) aErr(errors, 'start_date 必须是真实 YYYY-MM-DD', objectId, path)
  } else if (type === 'min_segment_minutes') {
    if (!(Number.isInteger(value) && value >= 1 && value <= 240)) aErr(errors, 'min_segment_minutes 必须是 1–240 整数', objectId, path)
  }
  // task_priority/splittable/ordering 的 value 结构由 schema 判别联合把关。
}

function semDeadlineCandidate(dc, path, objectId, errors) {
  if (!dc || typeof dc !== 'object') return
  const precision = dc.precision ?? 'none'
  if (precision === 'none') {
    if (dc.value != null) aErr(errors, 'precision=none 时 value 必须为空', objectId, `${path}.value`)
    return
  }
  if (dc.value == null) { aErr(errors, '有精度就必须有值', objectId, `${path}.value`); return }
  try { checkDeadlineCandidateValue(dc.value, precision, 'deadline_candidate.value') } catch (e) { aErr(errors, e.message, objectId, `${path}.value`) }
  if ((dc.basis === 'relative' || dc.basis === 'inferred') && dc.derived !== true) aErr(errors, 'relative/inferred 候选必须标 derived', objectId, `${path}.basis`)
  if (!Array.isArray(dc.evidence_refs) || dc.evidence_refs.length === 0) aErr(errors, '有值的截止候选必须给证据出处；无来源估计不能成为正式截止', objectId, `${path}.evidence_refs`)
}

function semKeyShape(key, label, path, objectId, errors) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) aErr(errors, `${label} key 形状非法：${key}`, objectId, path)
}

function semWorkItem(w, path, objectId, errors) {
  if (!w || typeof w !== 'object') return
  semKeyShape(w.key, 'work item', `${path}.key`, objectId, errors)
  if (w.remaining_minutes != null && !(Number.isSafeInteger(w.remaining_minutes) && w.remaining_minutes > 0)) {
    aErr(errors, 'remaining_minutes 必须为正安全整数或 null（未知），不能用 0', objectId, `${path}.remaining_minutes`)
  }
  if (w.earliest_date != null && !(typeof w.earliest_date === 'string' && DATE_RE.test(w.earliest_date) && isValidDate(w.earliest_date))) {
    aErr(errors, 'earliest_date 必须是真实 YYYY-MM-DD', objectId, `${path}.earliest_date`)
  }
  const deps = Array.isArray(w.depends_on) ? w.depends_on : []
  if (deps.includes(w.key)) aErr(errors, '工作项不得依赖自身', objectId, `${path}.depends_on`)
  if (new Set(deps).size !== deps.length) aErr(errors, 'depends_on 不得重复', objectId, `${path}.depends_on`)
}

function semProposal(p, path, objectId, errors) {
  if (!p || typeof p !== 'object') return
  for (const [group, label] of [['task_proposals', 'task'], ['action_proposals', 'action'], ['work_items', 'work item'], ['requirement_candidates', 'requirement']]) {
    const list = Array.isArray(p[group]) ? p[group] : []
    const keys = list.map((x) => x && x.key)
    if (new Set(keys).size !== keys.length) aErr(errors, `${label} key 重复`, objectId, `${path}.${group}`)
    list.forEach((x, i) => semKeyShape(x && x.key, label, `${path}.${group}[${i}].key`, objectId, errors))
  }
  for (const [i, t] of (Array.isArray(p.task_proposals) ? p.task_proposals : []).entries()) {
    if (!t || typeof t !== 'object') continue
    const tp = `${path}.task_proposals[${i}]`
    if (t.op === 'create' && Array.isArray(t.deadline_candidates)) t.deadline_candidates.forEach((dc, j) => semDeadlineCandidate(dc, `${tp}.deadline_candidates[${j}]`, objectId, errors))
    if (t.op === 'update') {
      const c = t.changes
      if (!c || typeof c !== 'object' || (c.title == null && c.description == null && c.completion_criteria == null && c.deadline_candidates == null)) {
        aErr(errors, 'update 必须至少提出一个字段变更', objectId, `${tp}.changes`)
      } else if (Array.isArray(c.deadline_candidates)) {
        c.deadline_candidates.forEach((dc, j) => semDeadlineCandidate(dc, `${tp}.changes.deadline_candidates[${j}]`, objectId, errors))
      }
    }
  }
  for (const [i, a] of (Array.isArray(p.action_proposals) ? p.action_proposals : []).entries()) {
    if (a && a.op === 'create' && a.basis === 'requirement' && !(Array.isArray(a.evidence_refs) && a.evidence_refs.length)) {
      aErr(errors, '声称是原文要求就必须给证据', objectId, `${path}.action_proposals[${i}].evidence_refs`)
    }
  }
  for (const [i, w] of (Array.isArray(p.work_items) ? p.work_items : []).entries()) semWorkItem(w, `${path}.work_items[${i}]`, objectId, errors)
  for (const [i, r] of (Array.isArray(p.requirement_candidates) ? p.requirement_candidates : []).entries()) {
    if (r && typeof r === 'object') semRequirementValue(r.type, r.value, `${path}.requirement_candidates[${i}].value`, objectId, errors)
  }
}

function semTaskFact(f, path, objectId, errors) {
  if (!f || typeof f !== 'object') return
  const precision = f.deadline_precision ?? 'none'
  if (precision === 'none') {
    if (f.deadline_value != null) aErr(errors, 'precision=none 时 deadline_value 必须为空', objectId, `${path}.deadline_value`)
    return
  }
  if (f.deadline_value == null) { aErr(errors, '有精度就必须有值', objectId, `${path}.deadline_value`); return }
  try { checkExistingDeadlineValue(f.deadline_value, precision, 'deadline_value') } catch (e) { aErr(errors, e.message, objectId, `${path}.deadline_value`) }
}

function semOccupancyEntry(o, path, objectId, errors) {
  if (!o || typeof o !== 'object') return
  if (typeof o.date !== 'string' || !DATE_RE.test(o.date) || !isValidDate(o.date)) aErr(errors, 'occupancy.date 必须是真实 YYYY-MM-DD', objectId, `${path}.date`)
  if (!(Number.isSafeInteger(o.planned_minutes) && o.planned_minutes > 0)) aErr(errors, 'occupancy.planned_minutes 必须为正整数', objectId, `${path}.planned_minutes`)
  if (o.state === 'planned' && o.task_ref_state === 'deleted') aErr(errors, 'planned 占用断引用属于不可信数据：阻断并引导核对，不得按 0 计算', objectId, `${path}.task_ref_state`)
}

function semFactBaseline(fb, path, objectId, errors) {
  if (!fb || typeof fb !== 'object') return
  if (!realDatetimeOk(fb.captured_at)) aErr(errors, `fact_baseline.captured_at 必须是真实 ISO 日期时间：${fb.captured_at}`, objectId, `${path}.captured_at`)
  for (const [i, f] of (Array.isArray(fb.task_facts) ? fb.task_facts : []).entries()) semTaskFact(f, `${path}.task_facts[${i}]`, objectId, errors)
  for (const [i, f] of (Array.isArray(fb.source_fingerprints) ? fb.source_fingerprints : []).entries()) {
    if (f && (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256))) aErr(errors, 'sha256 必须是 64 位小写十六进制', objectId, `${path}.source_fingerprints[${i}].sha256`)
  }
  for (const [i, o] of (Array.isArray(fb.occupancy) ? fb.occupancy : []).entries()) semOccupancyEntry(o, `${path}.occupancy[${i}]`, objectId, errors)
}

// 确认的结构守卫（镜像 UserConfirmation._check）。不查 revision 绑定/活对象注册：
// 旧版本确认合法保留可读（授权由 ready 推导按当前版本判定），活引用缺失走历史宽容。
function semConfirmation(u, path, objectId, errors) {
  if (!u || typeof u !== 'object') return
  if (!realDatetimeOk(u.confirmed_at)) aErr(errors, `confirmed_at 必须是真实 ISO 日期时间：${u.confirmed_at}`, objectId, `${path}.confirmed_at`)
  if (u.object_type === 'task') {
    if (u.id_scope !== 'draft' && u.id_scope !== 'formal') aErr(errors, 'task 型确认必须显式携带 id_scope=draft/formal', objectId, `${path}.id_scope`)
  } else if (u.id_scope != null) {
    aErr(errors, '非 task 型确认命名空间已固定，不得携带 id_scope', objectId, `${path}.id_scope`)
  }
  if (u.object_type === 'task' && u.field_path === 'deadline') {
    for (const name of ['old_value', 'new_value']) {
      if (!Object.prototype.hasOwnProperty.call(u, name)) { aErr(errors, `task/deadline 确认必须显式携带 ${name}（缺失不得解释为明确无截止）`, objectId, `${path}.${name}`); continue }
      const v = u[name]
      if (v == null) continue
      if (typeof v !== 'object' || Array.isArray(v) || v.precision === undefined || v.value === undefined || Object.keys(v).length !== 2) {
        aErr(errors, `task/deadline 确认 ${name} 必须是 null 或 {value, precision} 投影`, objectId, `${path}.${name}`)
        continue
      }
      if (v.precision !== 'date' && v.precision !== 'datetime') { aErr(errors, `task/deadline 确认 ${name}.precision 必须是 date/datetime`, objectId, `${path}.${name}.precision`); continue }
      if (typeof v.value !== 'string') { aErr(errors, `task/deadline 确认 ${name}.value 必须是字符串`, objectId, `${path}.${name}.value`); continue }
      try { checkExistingDeadlineValue(v.value, v.precision, name) } catch (e) { aErr(errors, e.message, objectId, `${path}.${name}.value`) }
    }
  }
}

// planning_input/planning_result 同版配对（服务写入不变量）：有结果必须有同版输入且通过一致性校验。
function semPlanningPair(input, result, path, objectId, errors) {
  if (input != null) {
    try { validatePlanningInput(input) } catch (e) { aErr(errors, `planning_input 非法：${e.message}`, objectId, `${path}.planning_input`) }
  }
  if (result != null) {
    if (input == null) { aErr(errors, '有 planning_result 必须有同版 planning_input', objectId, `${path}.planning_result`); return }
    try { validatePlanningResult(input, result) } catch (e) { aErr(errors, `planning_input/planning_result 不属于同一次计算：${e.message}`, objectId, `${path}.planning_result`) }
  }
}

function semThread(t, objectId, errors) {
  const p = 'AssistantThread'
  if (!realDatetimeOk(t.created_at)) aErr(errors, `created_at 必须是真实 ISO 日期时间：${t.created_at}`, objectId, `${p}.created_at`)
  if (!realDatetimeOk(t.updated_at)) aErr(errors, `updated_at 必须是真实 ISO 日期时间：${t.updated_at}`, objectId, `${p}.updated_at`)
  for (const e of checkThreadBounds(t)) aErr(errors, `${e.code}: ${e.message}`, objectId, p)
  for (const [i, m] of (Array.isArray(t.messages) ? t.messages : []).entries()) {
    if (m && !realDatetimeOk(m.created_at)) aErr(errors, `消息 created_at 必须是真实 ISO 日期时间：${m.created_at}`, objectId, `${p}.messages[${i}].created_at`)
  }
  for (const [i, r] of (Array.isArray(t.confirmed_requirements) ? t.confirmed_requirements : []).entries()) {
    if (!r || typeof r !== 'object') continue
    if (!realDatetimeOk(r.confirmed_at)) aErr(errors, `confirmed_at 必须是真实 ISO 日期时间：${r.confirmed_at}`, objectId, `${p}.confirmed_requirements[${i}].confirmed_at`)
    semRequirementValue(r.type, r.value, `${p}.confirmed_requirements[${i}].value`, objectId, errors)
  }
}

function semDraft(d, objectId, errors) {
  const p = 'AssistantDraft'
  if (!realDatetimeOk(d.created_at)) aErr(errors, `created_at 必须是真实 ISO 日期时间：${d.created_at}`, objectId, `${p}.created_at`)
  if (!realDatetimeOk(d.updated_at)) aErr(errors, `updated_at 必须是真实 ISO 日期时间：${d.updated_at}`, objectId, `${p}.updated_at`)
  for (const e of checkDraftBounds(d)) aErr(errors, `${e.code}: ${e.message}`, objectId, p)
  semProposal(d.proposal, 'proposal', objectId, errors)
  semPlanningPair(d.planning_input, d.planning_result, p, objectId, errors)
  semFactBaseline(d.fact_baseline, 'fact_baseline', objectId, errors)
  for (const [i, u] of (Array.isArray(d.user_confirmations) ? d.user_confirmations : []).entries()) semConfirmation(u, `user_confirmations[${i}]`, objectId, errors)
  if (d.applied_summary && !realDatetimeOk(d.applied_summary.applied_at)) {
    aErr(errors, `applied_at 必须是真实 ISO 日期时间：${d.applied_summary.applied_at}`, objectId, 'applied_summary.applied_at')
  }
  for (const [i, h] of (Array.isArray(d.revision_history) ? d.revision_history : []).entries()) {
    if (!h || typeof h !== 'object') continue
    const hp = `revision_history[${i}]`
    if (!realDatetimeOk(h.created_at)) aErr(errors, `历史快照 created_at 必须是真实 ISO 日期时间：${h.created_at}`, objectId, `${hp}.created_at`)
    semProposal(h.proposal, `${hp}.proposal`, objectId, errors)
    semPlanningPair(h.planning_input, h.planning_result, hp, objectId, errors)
    for (const [j, r] of (Array.isArray(h.requirements) ? h.requirements : []).entries()) {
      if (r && typeof r === 'object') semRequirementValue(r.type, r.value, `${hp}.requirements[${j}].value`, objectId, errors)
    }
  }
}

// ---------------------------------------------------------------- A 层：归档/内容完整性
async function layerA(archive, errors) {
  const entries = Array.isArray(archive?.entries) ? archive.entries : []
  if (archive?.zipBytes instanceof Uint8Array && archive.zipBytes.length > LIMITS.ZIP_MAX_BYTES) {
    err(errors, 'A', `压缩文件超过上限 ${LIMITS.ZIP_MAX_BYTES} 字节（实际 ${archive.zipBytes.length}）`)
  }
  if (entries.length > LIMITS.MAX_ENTRIES) err(errors, 'A', `归档条目超过上限 ${LIMITS.MAX_ENTRIES}（实际 ${entries.length}）`)

  const byPath = new Map()
  let totalBytes = 0
  for (const e of entries) {
    const path = e?.path
    if (typeof path !== 'string' || !isAllowedArchivePath(path)) { err(errors, 'A', `非法归档路径：${JSON.stringify(path)}`); continue }
    if (byPath.has(path)) { err(errors, 'A', `归档路径重复：${path}`); continue }
    if (!(e.bytes instanceof Uint8Array)) { err(errors, 'A', `条目缺少字节：${path}`); continue }
    byPath.set(path, e.bytes)
    totalBytes += e.bytes.length
  }
  if (totalBytes > LIMITS.UNCOMPRESSED_MAX_BYTES) err(errors, 'A', `解压总字节超过上限 ${LIMITS.UNCOMPRESSED_MAX_BYTES}（实际 ${totalBytes}）`)

  const out = { manifest: null, sources: null, docs: null, assets: new Map(), assistantThreads: null, assistantDrafts: null }
  const manifestBytes = byPath.get(MANIFEST_PATH)
  if (!manifestBytes) {
    for (const req of requiredPathsFor(null)) if (!byPath.has(req)) err(errors, 'A', `缺少必需文件：${req}`)
    return out
  }

  let manifest
  try { manifest = JSON.parse(bytesToUtf8(manifestBytes)) } catch (e) { err(errors, 'A', `manifest.json 不是合法 UTF-8 JSON：${e.message}`); return out }
  for (const e of validateManifestShape(manifest)) errors.push(e)
  out.manifest = manifest
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.payloads)) return out

  // 版本组合决定必需文件与助手载荷合法性：v2 必须带两个助手载荷；v1 不得携带（错误组合已在形状层拒绝）。
  const fv = manifest.backup_format_version
  const isV2 = fv === BACKUP_FORMAT_VERSION && !!compatFor(fv, manifest.schema_version)
  for (const req of requiredPathsFor(isV2 ? BACKUP_FORMAT_VERSION : null)) if (!byPath.has(req)) err(errors, 'A', `缺少必需文件：${req}`)
  if (!isV2) {
    for (const p of ASSISTANT_PATHS) {
      if (byPath.has(p)) err(errors, 'A', `v1/旧格式归档不得携带助手载荷：${p}`)
    }
  }

  // 声明 vs 实际：每个非 manifest 条目必须被声明；每个声明必须存在；无未声明载荷。
  const declared = new Map()
  for (const p of manifest.payloads) {
    if (!p || typeof p.path !== 'string') continue
    if (declared.has(p.path)) { err(errors, 'A', `manifest.payloads 重复声明：${p.path}`); continue }
    declared.set(p.path, p)
  }
  for (const path of byPath.keys()) {
    if (path === MANIFEST_PATH) continue
    if (!declared.has(path)) err(errors, 'A', `归档含未声明载荷：${path}`)
  }
  for (const [path, p] of declared) {
    const bytes = byPath.get(path)
    if (!bytes) { err(errors, 'A', `manifest 声明的文件缺失：${path}`); continue }
    if (Number.isInteger(p.bytes) && bytes.length !== p.bytes) err(errors, 'A', `字节数与声明不符：${path}（声明 ${p.bytes}，实际 ${bytes.length}）`)
    if (typeof p.sha256 === 'string') {
      const actual = await sha256Hex(bytes)
      if (actual !== p.sha256) err(errors, 'A', `SHA-256 与声明不符（内容损坏或被改）：${path}`)
    }
    const isJson = path.startsWith('data/')
    const isAsset = path.startsWith('assets/')
    if (isJson) {
      if (bytes.length > LIMITS.JSON_MAX_BYTES) err(errors, 'A', `JSON 超过单文件上限 ${LIMITS.JSON_MAX_BYTES}：${path}`)
      let parsed
      try { parsed = JSON.parse(bytesToUtf8(bytes)) } catch (e) { err(errors, 'A', `${path} 不是合法 UTF-8 JSON：${e.message}`); continue }
      if (path === ASSISTANT_THREADS_PATH || path === ASSISTANT_DRAFTS_PATH) {
        // 助手载荷是契约包装对象 {schema_version, threads|drafts:[...]}，不是裸数组。
        const listKey = path === ASSISTANT_THREADS_PATH ? 'threads' : 'drafts'
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { err(errors, 'A', `${path} 必须是契约包装对象（schema_version + ${listKey}）`); continue }
        // 包装版本须与 manifest 声明一致（2/0.5.0 与 2/0.6.0 均合法组合；跨版本混装拒绝）。
        if (parsed.schema_version !== manifest.schema_version) err(errors, 'A', `${path}.schema_version 必须与 manifest 声明 ${manifest.schema_version} 一致（实际 ${parsed.schema_version}）`)
        for (const k of Object.keys(parsed)) {
          if (k !== 'schema_version' && k !== listKey) err(errors, 'A', `${path} 含未知字段 ${k}（契约包装对象只允许 schema_version/${listKey}）`)
        }
        if (!Array.isArray(parsed[listKey])) { err(errors, 'A', `${path}.${listKey} 必须是记录数组`); continue }
        if (path === ASSISTANT_THREADS_PATH) out.assistantThreads = parsed[listKey]
        else out.assistantDrafts = parsed[listKey]
        continue
      }
      if (!Array.isArray(parsed)) { err(errors, 'A', `${path} 必须是记录数组`); continue }
      if (path === SOURCES_PATH) out.sources = parsed
      if (path === DOCS_PATH) out.docs = parsed
    } else if (isAsset) {
      if (bytes.length > LIMITS.IMAGE_MAX_BYTES) err(errors, 'A', `图片超过单文件上限 ${LIMITS.IMAGE_MAX_BYTES}：${path}`)
      const ext = path.slice(path.lastIndexOf('.') + 1)
      const type = detectImageType(bytes)
      if (!type) err(errors, 'A', `资产不是支持的栅格图片（PNG/JPEG/WebP/GIF）：${path}`)
      else if (type.ext !== ext) err(errors, 'A', `图片实际类型 ${type.ext} 与扩展名 ${ext} 不符：${path}`)
      out.assets.set(path, bytes)
    }
  }
  return out
}

// ---------------------------------------------------------------- B 层：结构/数据
function layerB(manifest, sources, docs, assets, errors, notes, assistant = {}) {
  const threads = Array.isArray(assistant.threads) ? assistant.threads : []
  const drafts = Array.isArray(assistant.drafts) ? assistant.drafts : []
  // v1/0.4.0 旧备份只认冻结 schema（不随活契约升级、不追溯收紧）；v2（0.5.0/0.6.0）用活契约。
  const compat = compatFor(manifest?.backup_format_version, manifest?.schema_version)
  const isV2 = compat ? compat.formatVersion === BACKUP_FORMAT_VERSION : true
  const validateDef = isV2 ? validateAgainstDef : validateAgainstFrozen040Def
  const wsId = manifest?.source_workspace?.id
  const idOwner = new Map() // 全局 ID 唯一（sources 与 docs 共用 store，按 id 键）
  const claimId = (id, kind, objectId) => {
    if (typeof id !== 'string' || !id) { err(errors, 'B', '记录缺少合法 id', { objectId, path: 'id' }); return }
    if (idOwner.has(id)) err(errors, 'B', `ID 重复（同 ID 不同对象/类型）：${id}（${idOwner.get(id)} 与 ${kind}）`, { objectId })
    else idOwner.set(id, kind)
  }
  const checkWs = (rec, objectId) => {
    if (rec.workspace_id !== wsId) err(errors, 'B', `记录不属于 manifest 声明的单一来源空间 ${wsId}（实际 ${rec.workspace_id}）`, { objectId, path: 'workspace_id' })
  }

  const counts = {}
  for (const k of DOC_KINDS) counts[k] = 0
  const unknownKinds = new Map()
  let imageCount = 0

  if (Array.isArray(sources)) {
    for (const s of sources) {
      const objectId = s?.id ?? '(无 id)'
      if (!s || typeof s !== 'object') { err(errors, 'B', 'source 记录必须是对象', { objectId }); continue }
      claimId(s.id, 'source', objectId)
      checkWs(s, objectId)
      scanForbidden(s, 'Source', objectId, errors)
      const core = businessCoreOfSource(s)
      for (const e of validateDef('Source', core).errors) err(errors, 'B', e.message, { objectId, path: e.path })
      if (!realDatetimeOk(core.captured_at)) err(errors, 'B', `captured_at 必须是真实 ISO 日期时间：${core.captured_at}`, { objectId, path: 'Source.captured_at' })
      if (core.kind === 'image') {
        imageCount++
        if (typeof s.asset_path !== 'string' || !s.asset_path) err(errors, 'B', '图片资料必须有 asset_path 指向归档原图', { objectId, path: 'Source.asset_path' })
        else if (!assets.has(s.asset_path)) err(errors, 'B', `图片 asset_path 在归档中缺失：${s.asset_path}`, { objectId, path: 'Source.asset_path' })
        else if (!detectImageType(assets.get(s.asset_path))) err(errors, 'B', `图片资产字节不是支持的栅格类型：${s.asset_path}`, { objectId, path: 'Source.asset_path' })
      } else if (core.kind === 'text') {
        if (typeof core.text !== 'string' || !core.text) err(errors, 'B', '文字资料必须有 text', { objectId, path: 'Source.text' })
      }
    }
  }

  if (Array.isArray(docs)) {
    for (const d of docs) {
      const objectId = d?.id ?? '(无 id)'
      if (!d || typeof d !== 'object') { err(errors, 'B', 'doc 记录必须是对象', { objectId }); continue }
      const kind = d.kind
      if (!DOC_KINDS.includes(kind)) {
        unknownKinds.set(kind, (unknownKinds.get(kind) || 0) + 1)
        claimId(d.id, `unknown:${kind}`, objectId)
        continue
      }
      counts[kind]++
      claimId(d.id, kind, objectId)
      checkWs(d, objectId)
      scanForbidden(d, kind, objectId, errors)
      const core = businessCoreOfDoc(d)
      const defName = KIND_TO_DEF[kind]
      for (const e of validateDef(defName, core).errors) err(errors, 'B', e.message, { objectId, path: e.path })
      semByDef(defName, core, objectId, errors)
      semLocalDocFields(d, objectId, errors)
    }
  }

  // 助手线程/草案（仅 v2；v1 携带助手载荷已在 A 层拒绝）。纯契约对象：schema 白名单 + 模型语义，
  // 不做 docs 的本地字段投影，也不扫 FORBIDDEN_KEYS（revision 是合法契约字段）。
  if (threads.length || drafts.length) {
    if (!isV2) err(errors, 'B', '旧格式备份不得携带助手记录')
    for (const t of threads) {
      const objectId = t?.id ?? '(无 id)'
      if (!t || typeof t !== 'object') { err(errors, 'B', 'assistant_thread 记录必须是对象', { objectId }); continue }
      claimId(t.id, 'assistant_thread', objectId)
      checkWs(t, objectId)
      for (const e of validateAgainstDef('AssistantThread', t).errors) err(errors, 'B', e.message, { objectId, path: e.path })
      semThread(t, objectId, errors)
    }
    for (const d of drafts) {
      const objectId = d?.id ?? '(无 id)'
      if (!d || typeof d !== 'object') { err(errors, 'B', 'assistant_draft 记录必须是对象', { objectId }); continue }
      claimId(d.id, 'assistant_draft', objectId)
      checkWs(d, objectId)
      for (const e of validateAgainstDef('AssistantDraft', d).errors) err(errors, 'B', e.message, { objectId, path: e.path })
      semDraft(d, objectId, errors)
    }
  }

  // 未适配 kinds：显式列计数并阻断（不悄悄遗漏；兼容适配须复审后才加）。
  for (const [kind, n] of unknownKinds) {
    err(errors, 'B', `含未适配的记录类型 ${kind}（${n} 条）：4-0 未定义其本地格式适配与完整引用映射，阻断恢复`, { objectId: `kind:${kind}` })
  }

  // 计数逐项与 manifest 一致。
  if (manifest && typeof manifest === 'object') {
    if (Number.isInteger(manifest.source_count) && Array.isArray(sources) && manifest.source_count !== sources.length) {
      err(errors, 'B', `source_count 与 manifest 不符（声明 ${manifest.source_count}，实际 ${sources.length}）`)
    }
    if (Number.isInteger(manifest.image_count) && manifest.image_count !== imageCount) {
      err(errors, 'B', `image_count 与 manifest 不符（声明 ${manifest.image_count}，实际 ${imageCount}）`)
    }
    const mc = manifest.counts || {}
    for (const k of DOC_KINDS) {
      if (Number.isInteger(mc[k]) && mc[k] !== counts[k]) err(errors, 'B', `counts.${k} 与 manifest 不符（声明 ${mc[k]}，实际 ${counts[k]}）`)
    }
    if (isV2) {
      if (Number.isInteger(mc.assistant_thread_count) && mc.assistant_thread_count !== threads.length) {
        err(errors, 'B', `counts.assistant_thread_count 与 manifest 不符（声明 ${mc.assistant_thread_count}，实际 ${threads.length}）`)
      }
      if (Number.isInteger(mc.assistant_draft_count) && mc.assistant_draft_count !== drafts.length) {
        err(errors, 'B', `counts.assistant_draft_count 与 manifest 不符（声明 ${mc.assistant_draft_count}，实际 ${drafts.length}）`)
      }
    }
    const knownCountKeys = isV2 ? [...DOC_KINDS, 'assistant_thread_count', 'assistant_draft_count'] : DOC_KINDS
    for (const k of Object.keys(mc)) {
      if (!knownCountKeys.includes(k) && Number.isInteger(mc[k]) && mc[k] > 0) err(errors, 'B', `manifest.counts 含未适配类型 ${k}=${mc[k]}`)
    }
  }
  return { counts, imageCount, sourceCount: Array.isArray(sources) ? sources.length : 0, assistantThreadCount: threads.length, assistantDraftCount: drafts.length }
}

// ---------------------------------------------------------------- C 层：关系闭包
function layerC(manifest, sources, docs, errors, notes, assistant = {}) {
  const wsId = manifest?.source_workspace?.id
  const byKind = {}
  for (const k of DOC_KINDS) byKind[k] = new Map()
  const sourceIds = new Map()
  if (Array.isArray(sources)) for (const s of sources) if (s && typeof s.id === 'string') sourceIds.set(s.id, s)
  if (Array.isArray(docs)) for (const d of docs) if (d && DOC_KINDS.includes(d.kind) && typeof d.id === 'string') byKind[d.kind].set(d.id, d)

  const sameWs = (rec) => rec && rec.workspace_id === wsId
  // 活引用：必须解析到正确类型、同空间的对象。
  const live = (map, id, kindLabel, objectId, path, extraCheck) => {
    if (id == null) return null
    const target = map.get(id)
    if (!target) { err(errors, 'C', `${kindLabel} 引用不存在的对象：${id}`, { objectId, path }); return null }
    if (!sameWs(target)) { err(errors, 'C', `${kindLabel} 引用的对象不在同一空间：${id}`, { objectId, path }); return null }
    if (extraCheck && !extraCheck(target)) err(errors, 'C', `${kindLabel} 引用归属不符：${id}`, { objectId, path })
    return target
  }
  // 历史引用（ref_state=deleted）：不得解析到包内活对象（假删除）。
  const history = (map, id, kindLabel, objectId, path) => {
    if (id != null && map.has(id)) err(errors, 'C', `${kindLabel} 标记 deleted 但对象仍存在（假删除历史）：${id}`, { objectId, path })
  }

  if (Array.isArray(docs)) {
    for (const d of docs) {
      if (!d || !DOC_KINDS.includes(d.kind)) continue
      const objectId = d.id
      switch (d.kind) {
        case 'note': {
          live(sourceIds, d.source_id, '便签资料', objectId, 'Note.source_id')
          if (d.matter_id != null) live(byKind.matter, d.matter_id, '便签事项', objectId, 'Note.matter_id')
          // 嵌套 Quote.source_id（fields[].quote，递归_defined_引用路径）。
          if (Array.isArray(d.fields)) d.fields.forEach((f, i) => {
            if (f && f.quote && typeof f.quote === 'object') live(sourceIds, f.quote.source_id, '字段原文资料', objectId, `Note.fields[${i}].quote.source_id`)
          })
          break
        }
        case 'matter':
          if (Array.isArray(d.note_ids)) d.note_ids.forEach((nid, i) => live(byKind.note, nid, '事项便签', objectId, `Matter.note_ids[${i}]`))
          break
        case 'task': {
          if (d.matter_id != null) live(byKind.matter, d.matter_id, '任务事项', objectId, 'Task.matter_id')
          if (Array.isArray(d.note_ids)) d.note_ids.forEach((nid, i) => live(byKind.note, nid, '任务便签', objectId, `Task.note_ids[${i}]`))
          if (d.deadline?.from_note_id != null) live(byKind.note, d.deadline.from_note_id, '截止出处便签', objectId, 'Task.deadline.from_note_id')
          if (d.current_action_id != null) live(byKind.action, d.current_action_id, '当前行动', objectId, 'Task.current_action_id', (a) => a.task_id === d.id)
          break
        }
        case 'action':
          live(byKind.task, d.task_id, '行动任务', objectId, 'Action.task_id')
          break
        case 'focus_session': {
          const v0 = focusRecordVersion(d) === 0
          // v1：deleted→历史不得解析到活对象；active→必须解析。v0：缺省按活引用解析，缺失走旧兼容预览说明。
          const refCheck = (map, id, stateField, kindLabel, path, extraCheck) => {
            if (!v0 && d[stateField] === 'deleted') { history(map, id, kindLabel, objectId, path); return }
            const target = map.get(id)
            if (!target) {
              if (v0) notes.push({ objectId, message: `v0 旧会话的 ${kindLabel} ${id} 在包内缺失（旧记录无引用状态）：按已批准旧缺失引用规则隔离映射，不伪造对象，恢复预览将提示` })
              else err(errors, 'C', `${kindLabel} 引用不存在的对象：${id}`, { objectId, path })
              return
            }
            if (!sameWs(target)) { err(errors, 'C', `${kindLabel} 引用的对象不在同一空间：${id}`, { objectId, path }); return }
            if (extraCheck && !extraCheck(target)) err(errors, 'C', `${kindLabel} 引用归属不符：${id}`, { objectId, path })
          }
          refCheck(byKind.task, d.task_id, 'task_ref_state', '会话任务', 'FocusSession.task_id')
          refCheck(byKind.action, d.action_id, 'action_ref_state', '会话行动', 'FocusSession.action_id', (a) => a.task_id === d.task_id)
          if (d.plan_item_id != null) live(byKind.plan_item, d.plan_item_id, '会话计划条目', objectId, 'FocusSession.plan_item_id', (p) => p.task_id === d.task_id)
          break
        }
        case 'plan_item': {
          if (d.task_ref_state === 'deleted') history(byKind.task, d.task_id, '计划任务', objectId, 'PlanItem.task_id')
          else live(byKind.task, d.task_id, '计划任务', objectId, 'PlanItem.task_id')
          if (d.focus_session_id != null) {
            const s = live(byKind.focus_session, d.focus_session_id, '计划快捷会话', objectId, 'PlanItem.focus_session_id', (t) => t.task_id === d.task_id && t.plan_item_id === d.id)
            if (s && s.ended_at == null) err(errors, 'C', 'focus_session_id 快捷引用只能指向已结束会话', { objectId, path: 'PlanItem.focus_session_id' })
          }
          break
        }
        default: break
      }
    }
  }

  // 助手容器归属：draft.thread_id 必须指向同包同空间线程；损坏拒绝整包，不能静默丢草案。
  // 其余正式引用缺失属历史宽容（恢复时隔离映射 + needs_review），不在此拒绝（开工单 §8）。
  const aThreads = Array.isArray(assistant.threads) ? assistant.threads : []
  const aDrafts = Array.isArray(assistant.drafts) ? assistant.drafts : []
  const threadById = new Map()
  for (const t of aThreads) if (t && typeof t.id === 'string') threadById.set(t.id, t)
  for (const d of aDrafts) {
    if (!d || typeof d !== 'object') continue
    const t = threadById.get(d.thread_id)
    if (!t) err(errors, 'C', `草案归属线程在包内不存在：${d.thread_id}（容器归属损坏，拒绝整包）`, { objectId: d.id, path: 'AssistantDraft.thread_id' })
    else if (!sameWs(t)) err(errors, 'C', `草案归属线程不在同一空间：${d.thread_id}`, { objectId: d.id, path: 'AssistantDraft.thread_id' })
  }

  // 同一来源空间至多一份未结束会话（ended_at 为空，含暂停）。
  const unfinished = (byKind.focus_session ? [...byKind.focus_session.values()] : []).filter((s) => s.ended_at == null)
  if (unfinished.length > 1) err(errors, 'C', `来源空间有 ${unfinished.length} 份未结束会话（含暂停，只允许 1 份）`, { objectId: unfinished.map((s) => s.id).join(',') })

  return { unfinishedCount: unfinished.length, unfinishedIds: unfinished.map((s) => s.id) }
}

// ---------------------------------------------------------------- 主入口
// 记录级 B+C 校验（不做 A 层字节完整性）。供 ID 映射后重校验、4-2 恢复前复检共用。
// assistant={threads,drafts}：v2 备份/恢复的助手记录；v1 与旧调用缺省为空。
export function validateRecords(manifest, sources, docs, assets = new Map(), assistant = {}) {
  const errors = []
  const notes = []
  const b = layerB(manifest, sources, docs, assets, errors, notes, assistant)
  const c = layerC(manifest, sources, docs, errors, notes, assistant)
  return { ok: errors.length === 0, errors, notes, manifest, summary: { ...b, ...c, assetCount: assets.size } }
}

// 返回 { ok, errors, notes, manifest, summary, sources, docs, assets, assistantThreads, assistantDrafts }。
// ok=false 时零写入；errors 一次性列全部对象+原因。业务数据是 A 层实际解析出的同一份，
// 供恢复预览/提交复用，绝不「校验一份、提交另一份未校验对象」。ok=false 时可能为 null/部分。
export async function validateBackup(archive) {
  const errors = []
  const { manifest, sources, docs, assets, assistantThreads, assistantDrafts } = await layerA(archive, errors)
  if (manifest && Array.isArray(sources) && Array.isArray(docs)) {
    const assistant = { threads: assistantThreads ?? [], drafts: assistantDrafts ?? [] }
    const r = validateRecords(manifest, sources, docs, assets, assistant)
    return { ok: r.errors.length === 0 && errors.length === 0, errors: [...errors, ...r.errors], notes: r.notes, manifest, summary: r.summary, sources, docs, assets, assistantThreads, assistantDrafts }
  }
  if (!errors.some((e) => e.layer === 'A')) err(errors, 'A', '归档缺少可解析的 manifest/sources/docs，无法进行结构与关系校验')
  return { ok: false, errors, notes: [], manifest, summary: null, sources, docs, assets, assistantThreads, assistantDrafts }
}

export { DATE_RE, DATETIME_RE, DEADLINE_VALUE_RE, realDatetimeOk }
