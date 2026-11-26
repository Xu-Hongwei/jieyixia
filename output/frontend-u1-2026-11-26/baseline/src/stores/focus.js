// 专注会话 store 接入（3B-1 S7）：只读当前空间事实并暴露服务结果，不新增页面入口。
// 所有写入经 createFocusService 协调层（无直接 put 旁路）；本地 ref 只在归属匹配时更新，
// 晚到的原空间结果不污染新空间。切空间/初始化由 app store 触发 loadWorkspace 重载。
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { allDocs, allFocusRuntime } from '@/services/storage/db'
import { createFocusService } from '@/services/focus/service'
import { sessionsOf } from '@/domains/focus'
import { useAppStore } from './app'

export const useFocusStore = defineStore('focus', () => {
  const app = useAppStore()
  const sessions = ref([])
  const coordination = ref([])
  const running = ref(null)
  const ready = ref(false)
  // ownerId 默认每次页面加载新生成：刷新后走接管/恢复，不冒充旧持有者。
  const service = createFocusService({ getWorkspaceId: () => app.workspaceId })

  const unfinished = computed(() => sessions.value.filter((s) => s.ended_at == null))

  async function loadWorkspace() {
    const ws = app.workspaceId
    const state = await service.loadState()
    const docRes = await allDocs()
    const rtRes = await allFocusRuntime()
    if (state.stale || docRes.workspace_id !== ws || rtRes.workspace_id !== ws) return { stale: true }
    sessions.value = sessionsOf(docRes.records)
    coordination.value = rtRes.records.filter((r) => r.kind === 'session' && r.workspace_id === ws)
    const run = rtRes.records.find((r) => r.kind === 'running' && r.session_id)
    running.value = run ? { workspace_id: run.workspace_id, session_id: run.session_id } : null
    ready.value = true
    return { stale: false }
  }

  // 操作后按数据库重读（唯一事实来源）；归属不匹配只返回结果，不动本地 ref。
  // 请求信封（调用端适配）：store 绝不给未知 requestId 补当前时间——刷新后旧 ID 的首见
  // 不是新意图。完整信封（requestId+issuedAtMs）记录下来供后续缺时刻的重试复用原签发时刻；
  // 未知裸 ID 原样交给服务凭本地/台账验证，不可验证即拒绝（REQUEST_ENVELOPE_REQUIRED）。
  // 新意图不带 requestId，由服务签发；issueRequest 供 UI 在意图产生时预取信封。
  const envelopes = new Map()
  async function run(op, input) {
    let effective = input
    if (input.requestId != null) {
      if (input.issuedAtMs != null) envelopes.set(input.requestId, input.issuedAtMs)
      else if (envelopes.has(input.requestId)) effective = { ...input, issuedAtMs: envelopes.get(input.requestId) }
    }
    const result = await service[op](effective)
    if (result.request_id != null && result.issued_at_ms != null) envelopes.set(result.request_id, result.issued_at_ms)
    if (result.workspace_id === app.workspaceId) {
      await loadWorkspace()
      // begin/end-done/计划联动结束会改写任务/行动/安排文档：同步刷新 app.docs，日程与任务详情不读旧快照。
      // partial/blocked 计划结束同样改 PlanItem；成功 replay 只回摘要，也按归属重读刷新。
      if (result.ok && (result.task || result.action || result.planItem || result.replayed)) await app.reloadDocs()
    }
    return result
  }

  return {
    sessions, coordination, running, ready, unfinished,
    ownerId: service.ownerId,
    loadWorkspace,
    // 请求信封：UI 在用户意图产生时取一次（request_id + issued_at_ms），失败重试复用同一信封；
    // 不携带信封的裸 requestId 重试在服务端不可验证时会被拒绝（REQUEST_ENVELOPE_REQUIRED）。
    issueRequest: (op, input) => service.issueRequest(op, input),
    begin: (input) => run('begin', input),
    checkpoint: (input) => run('checkpoint', input),
    pause: (input) => run('pause', input),
    resume: (input) => run('resume', input),
    end: (input) => run('end', input),
    saveDraft: (input) => run('saveDraft', input),
    recover: (input) => run('recover', input),
    takeover: (input) => run('takeover', input),
    legacyEnd: (input) => run('legacyEnd', input),
    stop: () => service.stop(),
  }
})