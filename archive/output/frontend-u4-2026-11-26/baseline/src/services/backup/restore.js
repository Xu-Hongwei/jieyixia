// 4-2 恢复作业控制器（开工单 §2/§6/§8）。模块级单例：解析作业 + 提交控制器不绑定组件生命周期，
// DataPage 仅做状态绑定与交互。状态机：idle→inspecting→preview→committing→done；任何错误→error。
// 选择/检查/预览/取消零业务写入、不建空空间、不切全局空间；提交只写固定目标（commitRestore 单事务）。
// 取消经 AbortSignal 传导；新文件递增作业号，旧解析晚到结果按作业号丢弃；完成/取消释放大字节。
import { reactive } from 'vue'
import { inspectBackupFile, restorePreview, prepareRestore } from './import'
import { commitRestore, findRestoreByOperation, readWorkspaceSnapshot, allFocusRuntime, allAssistantOps } from '@/services/storage/db'
import { runId, sessId } from '@/services/focus/runtime'
import { RECOVERY_OWNER_PREFIX } from './recovery'
import { detectImageType } from './format'
import { canonicalJson } from '@/domains/assistant/draft'
import { assistantRefEntries } from '@/domains/assistant/refs'

export const restoreJob = reactive({
  phase: 'idle', // idle | inspecting | preview | committing | done | error
  jobId: 0,
  filename: null,
  fileSize: 0,
  preview: null,
  errors: [], // 校验/准备阻断性原因（列表，禁止「忽略错误继续」）
  notes: [], // 已放行的 v0 缺引用兼容提示（区别于阻断错误）
  targetName: '',
  operationId: null,
  targetWorkspaceId: null,
  result: null,
  verifyProblems: [], // 已创建空间但核对异常（不假装零写入、不自动回滚）
  commitError: null, // 检查/提交操作异常 { code, message }
})

let currentInspected = null
let currentPrepared = null
let abortController = null

const releaseInspected = () => {
  if (currentInspected && currentInspected.assets instanceof Map) currentInspected.assets.clear()
  currentInspected = null
}
const releasePrepared = () => { currentPrepared = null }

// 提交后核对（§6）：按显式目标读回快照 + 协调数据，绝不切换全局空间。核对计数/图片/必要引用/未结束协调。
// 核对异常只报告「已创建空间，但核对异常」，不自动回滚可能已被用户编辑的空间。
export async function verifyCommittedRestore(prepared) {
  const problems = []
  const targetId = prepared.targetWorkspaceId
  const snap = await readWorkspaceSnapshot(targetId)
  const rt = (await allFocusRuntime()).records.filter((r) => r.workspace_id === targetId)
  const counts = {}
  for (const d of snap.docs) counts[d.kind] = (counts[d.kind] || 0) + 1
  for (const k of Object.keys(prepared.counts)) {
    if ((counts[k] || 0) !== prepared.counts[k]) problems.push(`记录计数不符：${k} 期望 ${prepared.counts[k]}，实际 ${counts[k] || 0}`)
  }
  if (snap.sources.length !== prepared.sourceCount) problems.push(`资料计数不符：期望 ${prepared.sourceCount}，实际 ${snap.sources.length}`)
  const srcById = new Map(snap.sources.map((s) => [s.id, s]))
  for (const ps of prepared.sources) {
    if (ps.kind !== 'image') continue
    const got = srcById.get(ps.id)
    if (!got || !got.blob) { problems.push(`图片资料 ${ps.id} 缺失或无字节`); continue }
    if (got.blob.size !== ps.blob.size) problems.push(`图片资料 ${ps.id} 字节数不符`)
    const magic = new Uint8Array(await got.blob.slice(0, 32).arrayBuffer())
    const type = detectImageType(magic)
    if (!type || got.blob.type !== type.mime) problems.push(`图片资料 ${ps.id} 类型不符`)
  }
  const docById = new Map(snap.docs.map((d) => [d.id, d]))
  for (const d of snap.docs) {
    if (d.kind === 'note' && d.source_id && !srcById.has(d.source_id)) problems.push(`便签 ${d.id} 的来源引用悬空`)
    if (d.kind === 'task') {
      if (d.current_action_id && !docById.has(d.current_action_id)) problems.push(`任务 ${d.id} 的当前行动引用悬空`)
      if (d.deadline && d.deadline.from_note_id && !docById.has(d.deadline.from_note_id)) problems.push(`任务 ${d.id} 的截止来源引用悬空`)
    }
  }
  const rtById = new Map(rt.map((r) => [r.id, r]))
  const run = rtById.get(runId(targetId))
  if (!run || run.session_id !== null) problems.push('目标空间运行位未重建为空（不应占用全局运行）')
  const nowMs = Date.now()
  for (const sid of prepared.unfinishedV1) {
    const doc = docById.get(sid)
    if (!doc || doc.running !== false || doc.ended_at !== null) problems.push(`未结束会话 ${sid} 未转为暂停待确认`)
    const sess = rtById.get(sessId(sid))
    if (!sess || !String(sess.owner_id).startsWith(RECOVERY_OWNER_PREFIX) || sess.lease_expires_at >= nowMs) {
      problems.push(`未结束会话 ${sid} 占位协调记录缺失或租约未过期`)
    }
  }
  for (const sid of prepared.legacyEnds) {
    const doc = docById.get(sid)
    if (!doc || doc.running !== false) problems.push(`旧版未结束会话 ${sid} 未暂停`)
  }
  // 5B-1B §9.4：助手核对——实际重读目标空间线程/草案，核对数量、身份、内容转换、引用、状态及零 ops。
  const prepThreads = prepared.assistantThreads || []
  const prepDrafts = prepared.assistantDrafts || []
  if (snap.assistantThreads.length !== prepThreads.length) {
    problems.push(`助手线程计数不符：期望 ${prepThreads.length}，实际 ${snap.assistantThreads.length}`)
  }
  if (snap.assistantDrafts.length !== prepDrafts.length) {
    problems.push(`助手草案计数不符：期望 ${prepDrafts.length}，实际 ${snap.assistantDrafts.length}`)
  }
  const threadById = new Map(snap.assistantThreads.map((r) => [r.id, r]))
  const draftById = new Map(snap.assistantDrafts.map((r) => [r.id, r]))
  const oldIds = new Set([...prepared.liveMap.keys(), ...prepared.historyMap.keys()])
  const checkAssistantRecord = (want, got, type, label) => {
    if (!got) { problems.push(`${label} ${want.id} 缺失`); return }
    if (got.workspace_id !== targetId) problems.push(`${label} ${want.id} 归属与目标空间不符`)
    // 内容转换核对：落库记录须与已冻结准备数据逐字段一致（含去授权转换后的状态/基线/确认）。
    if (canonicalJson(got) !== canonicalJson(want)) problems.push(`${label} ${want.id} 内容与准备数据不一致`)
    for (const e of assistantRefEntries(got, type)) {
      if (e.namespace !== 'formal') continue
      const v = e.get()
      if (typeof v === 'string' && oldIds.has(v)) problems.push(`${label} ${want.id} 引用 ${e.path} 仍指向原空间旧标识`)
    }
  }
  for (const th of prepThreads) checkAssistantRecord(th, threadById.get(th.id), 'thread', '助手线程')
  for (const dr of prepDrafts) {
    const got = draftById.get(dr.id)
    checkAssistantRecord(dr, got, 'draft', '助手草案')
    if (!got) continue
    if (got.status !== dr.status) problems.push(`助手草案 ${dr.id} 状态未按恢复规则转换（期望 ${dr.status}，实际 ${got.status}）`)
    if (got.fact_baseline != null) problems.push(`助手草案 ${dr.id} 事实基线未清除`)
    if (Array.isArray(got.user_confirmations) ? got.user_confirmations.length !== 0 : got.user_confirmations != null) {
      problems.push(`助手草案 ${dr.id} 可执行确认未清除`)
    }
    const owner = threadById.get(got.thread_id)
    if (!owner || owner.workspace_id !== targetId) problems.push(`助手草案 ${dr.id} 归属线程在目标空间缺失`)
  }
  const ops = (await allAssistantOps()).records.filter((r) => r.workspace_id === targetId)
  if (ops.length !== 0) problems.push(`目标空间存在 ${ops.length} 条采用台账（恢复不得导入或重建 ops）`)
  return { ok: problems.length === 0, problems }
}

// 重置作业（释放资源）。提交进行中禁止重置/换文件（§2：写入阶段不可取消）。
export function resetRestoreJob() {
  if (restoreJob.phase === 'committing') return { ok: false, busy: true }
  if (abortController) { abortController.abort(); abortController = null }
  releaseInspected()
  releasePrepared()
  restoreJob.phase = 'idle'
  restoreJob.filename = null
  restoreJob.fileSize = 0
  restoreJob.preview = null
  restoreJob.errors = []
  restoreJob.notes = []
  restoreJob.targetName = ''
  restoreJob.operationId = null
  restoreJob.targetWorkspaceId = null
  restoreJob.result = null
  restoreJob.verifyProblems = []
  restoreJob.commitError = null
  return { ok: true }
}

// 选择备份文件 → 正在检查。新文件递增作业号并取消旧解析；旧结果晚到按作业号丢弃，绝复现。
export async function selectBackupFile(file) {
  if (restoreJob.phase === 'committing') return { ok: false, busy: true }
  if (abortController) abortController.abort()
  releaseInspected()
  releasePrepared()
  const myJob = ++restoreJob.jobId
  abortController = new AbortController()
  const signal = abortController.signal
  restoreJob.phase = 'inspecting'
  restoreJob.filename = (file && file.name) || '备份.zip'
  restoreJob.fileSize = (file && file.size) || 0
  restoreJob.preview = null
  restoreJob.errors = []
  restoreJob.notes = []
  restoreJob.targetName = ''
  restoreJob.operationId = null
  restoreJob.targetWorkspaceId = null
  restoreJob.result = null
  restoreJob.verifyProblems = []
  restoreJob.commitError = null
  let ins
  try {
    ins = await inspectBackupFile(file, { signal })
  } catch (e) {
    if (restoreJob.jobId !== myJob) return { ok: false, stale: true }
    if (e.code === 'ZIP_CANCELLED') { restoreJob.phase = 'idle'; return { ok: false, cancelled: true } }
    restoreJob.phase = 'error'
    restoreJob.commitError = { code: e.code || 'INSPECT_FAILED', message: e.message }
    return { ok: false, error: restoreJob.commitError }
  }
  if (restoreJob.jobId !== myJob) return { ok: false, stale: true }
  currentInspected = ins
  restoreJob.notes = ins.notes || []
  if (!ins.ok) {
    restoreJob.phase = 'error'
    restoreJob.errors = ins.errors || []
    return { ok: false, errors: restoreJob.errors }
  }
  restoreJob.preview = restorePreview(ins)
  restoreJob.targetName = restoreJob.preview.defaultName
  restoreJob.phase = 'preview'
  return { ok: true, preview: restoreJob.preview }
}

// 取消检查（仅检查阶段）：零写入、零目录。晚到的旧解析结果由作业号守卫丢弃。
export function cancelInspection() {
  if (restoreJob.phase !== 'inspecting') return { ok: false }
  if (abortController) abortController.abort()
  releaseInspected()
  restoreJob.phase = 'idle'
  return { ok: true }
}

// 预览阶段编辑目标名（trim 与长度由 prepareRestore 在确认时校验）。
export function setRestoreName(name) {
  if (restoreJob.phase !== 'preview') return { ok: false }
  restoreJob.targetName = String(name == null ? '' : name)
  return { ok: true }
}

// 确认恢复（唯一写入按钮）：冻结文件/名/目标/作业号/ID 映射/准备数据；双击不产生第二意图。
// 提交失败可同意图重试（复用冻结 prepared，绝不重新随机）；tx 已提交但回调失败 → 先查回执返原空间。
export async function confirmRestore() {
  if (restoreJob.phase === 'committing') return { ok: false, busy: true }
  if (restoreJob.phase !== 'preview' && restoreJob.phase !== 'error') return { ok: false }
  if (!currentPrepared) {
    if (restoreJob.phase !== 'preview' || !currentInspected || !currentInspected.ok) return { ok: false }
    const operationId = restoreJob.operationId || crypto.randomUUID()
    const targetWorkspaceId = restoreJob.targetWorkspaceId || `ws-restore-${crypto.randomUUID()}`
    let prepared
    try {
      prepared = prepareRestore({ inspected: currentInspected, targetWorkspaceId, targetName: restoreJob.targetName, operationId })
    } catch (e) {
      // 准备失败（名/目标/复检）：文件仍有效，回到预览供修正后重试，列原因不写入。
      restoreJob.phase = 'preview'
      restoreJob.errors = e.errors || []
      restoreJob.commitError = { code: e.code || 'PREPARE_FAILED', message: e.message }
      return { ok: false, error: restoreJob.commitError }
    }
    currentPrepared = prepared
    restoreJob.operationId = operationId
    restoreJob.targetWorkspaceId = targetWorkspaceId
    restoreJob.targetName = prepared.targetName
    restoreJob.errors = []
    restoreJob.commitError = null
  }
  const prepared = currentPrepared
  restoreJob.phase = 'committing'
  let outcome
  try {
    outcome = await commitRestore(prepared)
  } catch (e) {
    const found = await findRestoreByOperation(prepared.operationId).catch(() => null)
    if (found) {
      outcome = { alreadyCommitted: true, workspaceId: found.workspaceId, workspace: found.workspace, receipt: found.receipt }
    } else {
      restoreJob.phase = 'error'
      restoreJob.commitError = { code: e.code || 'RESTORE_FAILED', message: e.message }
      return { ok: false, error: restoreJob.commitError }
    }
  }
  const verify = await verifyCommittedRestore(prepared).catch((e) => ({ ok: false, problems: [`核对读取失败：${e.message}`] }))
  restoreJob.result = {
    workspaceId: outcome.workspaceId,
    name: prepared.targetName,
    alreadyCommitted: !!outcome.alreadyCommitted,
    counts: prepared.counts,
    sourceCount: prepared.sourceCount,
    imageCount: prepared.imageCount,
    unfinishedV1: prepared.unfinishedV1.length,
    legacyEnds: prepared.legacyEnds.length,
    assistantThreadCount: (prepared.assistantThreads || []).length,
    assistantDraftCount: (prepared.assistantDrafts || []).length,
  }
  restoreJob.verifyProblems = verify.problems
  restoreJob.phase = 'done'
  releaseInspected()
  releasePrepared()
  return { ok: true, result: restoreJob.result, verifyOk: verify.ok }
}