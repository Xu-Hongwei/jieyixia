export const TASK_LIST_LABELS = { all: '全部任务', unscheduled: '待安排', past: '过去未完成' }

// 列表偏好只携带已知字段，避免把一次性操作或嵌套 return 带入下一次导航。
export function cleanTaskListQuery(query = {}) {
  const out = /** @type {Record<string, string>} */ ({})
  if (query.list === 'unscheduled' || query.list === 'past') out.list = query.list
  if (typeof query.q === 'string' && query.q.trim()) out.q = query.q.slice(0, 200)
  if (query.status === 'open' || query.status === 'done') out.status = query.status
  if (query.undated === '1') out.undated = '1'
  if (typeof query.matter === 'string' && query.matter) out.matter = query.matter
  return out
}

export function taskListPath(query = {}) {
  const search = new URLSearchParams(cleanTaskListQuery(query)).toString()
  return `/tasks${search ? '?' + search : ''}`
}

// 分类仍由 planStore 给出，此处只做显示筛选，不复制“待安排”的业务定义。
export function filterTaskList(tasks, classification, query = {}) {
  const q = cleanTaskListQuery(query)
  const ids = q.list === 'unscheduled' ? classification.unscheduled
    : q.list === 'past' ? classification.pastUnfinished.map((x) => x.taskId) : null
  const included = ids ? new Set(ids) : null
  return tasks.filter((task) => (!included || included.has(task.id))
    && (!q.q || task.title.toLocaleLowerCase().includes(q.q.trim().toLocaleLowerCase()))
    && (!q.status || (q.status === 'done' ? task.status === 'done' : task.status !== 'done'))
    && (!q.undated || !task.deadline?.value)
    && (!q.matter || (q.matter === 'ungrouped' ? !task.matter_id : task.matter_id === q.matter)))
}
