// 每日安排 store 薄入口（5A-0 §6/§11）：只暴露服务命令与纯读取，不新增页面缓存副本。
// 所有写入经 createPlanService 事务层（无直接 put 旁路）；本地只在归属匹配时刷新 app.docs，
// 晚到的原空间结果不污染新空间。读取直接用 domains/plan.js + week.js 纯函数读 app.docs  live 事实。
// 请求信封：UI 在用户意图产生时取一次（含预先固定的 PlanItem ID 与缺省北京今天），失败重试复用同一信封；
// store 绝不给未知裸 requestId 补当前时间——刷新后旧 ID 首见不是新意图。
import { acceptHMRUpdate, defineStore } from 'pinia'
import { createPlanService } from '@/services/plan/service'
import { beijingToday } from '@/domains/time'
import { classifyUnscheduled, planRisk, summarizePlanTime, assertPlanExecutable, existingUnfinishedSessionForPlan } from '@/domains/plan'
import { weekSchedule } from '@/domains/week'
import { useAppStore } from './app'

const CREATE_OPS = ['create', 'arrangeAnotherDay']

export const usePlanStore = defineStore('plan', () => {
  const app = useAppStore()
  const service = createPlanService({ getWorkspaceId: () => app.workspaceId })
  // requestId → { issuedAtMs, planItemId }：完整信封记录下来供缺时刻的重试复用原签发时刻与固定 ID。
  const envelopes = new Map()

  // 意图形成时固定缺省日期（实时北京今天）与新建 ID；重试不因跨午夜换日。返回可直接回传的 input。
  /** @param {string} op @param {Record<string, any>} [input] */
  function issueRequest(op, input = {}) {
    const effective = { ...input }
    if (CREATE_OPS.includes(op) && !effective.date) effective.date = beijingToday()
    const env = service.issueRequest(op, effective)
    if (CREATE_OPS.includes(op)) effective.planItemId = env.plan_item_id
    envelopes.set(env.request_id, { issuedAtMs: env.issued_at_ms, planItemId: env.plan_item_id })
    return { requestId: env.request_id, issuedAtMs: env.issued_at_ms, planItemId: env.plan_item_id, input: effective }
  }

  async function run(op, input) {
    let effective = { ...input }
    if (input.requestId != null) {
      const e = envelopes.get(input.requestId)
      if (input.issuedAtMs != null) {
        envelopes.set(input.requestId, { issuedAtMs: input.issuedAtMs, planItemId: input.planItemId ?? (e && e.planItemId) })
      } else if (e) {
        effective.issuedAtMs = e.issuedAtMs
        if (CREATE_OPS.includes(op) && !effective.planItemId && e.planItemId) effective.planItemId = e.planItemId
      }
    }
    const result = await service[op](effective)
    if (result.request_id != null && result.issued_at_ms != null) {
      envelopes.set(result.request_id, { issuedAtMs: result.issued_at_ms, planItemId: result.plan_item_id })
    }
    // 只应用提交成功且归属匹配的结果：安排命令改写 docs，刷新 app.docs（唯一事实来源）。
    if (result.workspace_id === app.workspaceId) await app.reloadDocs()
    return result
  }

  // —— 纯读取（无写入，读 app.docs live 事实，不缓存副本）——
  const docsOf = () => app.docs
  const tasksOf = () => app.docs.filter((d) => d.kind === 'task')
  const plansOf = () => app.docs.filter((d) => d.kind === 'plan_item')

  return {
    issueRequest,
    create: (input) => run('create', input),
    edit: (input) => run('edit', input),
    move: (input) => run('move', input),
    cancel: (input) => run('cancel', input),
    confirmProgress: (input) => run('confirmProgress', input),
    arrangeAnotherDay: (input) => run('arrangeAnotherDay', input),
    // 统一周聚合（兼容旧 weekGrid，不改页面）：上方每日安排、下方每日截止，同一组日期列。
    schedule: (startStr, nowD = new Date()) => weekSchedule({ docs: docsOf(), startStr, nowD }),
    // 待安排分类：读全量计划，不只看当前周；另外输出过去未完成集合。
    classify: (nowD = new Date()) => classifyUnscheduled(tasksOf(), plansOf(), nowD),
    // 实际用时纯汇总（区分未记录 null 与不足一分钟 0）。
    summary: (planItemId) => {
      const p = plansOf().find((x) => x.id === planItemId)
      return p ? summarizePlanTime(p, docsOf()) : null
    },
    // 截止风险只读派生。
    riskFor: (taskId, dateStr, nowD = new Date()) => {
      const t = tasksOf().find((x) => x.id === taskId)
      return t ? planRisk(t, dateStr, nowD) : null
    },
    // 执行资格纯校验（5A-2 接生产 focus.begin/end；本批只提供 helper）。
    checkExecutable: (planItemId, actionId) => assertPlanExecutable(docsOf(), planItemId, actionId),
    unfinishedSessionFor: (planItemId) => existingUnfinishedSessionForPlan(docsOf(), planItemId),
  }
})

// 更新安排规则时，同步替换已打开页面的保存动作；编辑表单仍使用原快照与请求凭据。
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePlanStore, import.meta.hot))
}
