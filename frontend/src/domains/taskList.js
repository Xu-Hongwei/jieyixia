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

// 筛选仅影响展开的清单，项目进度始终以全部成员为分母。
export function projectTaskGroups(projects, tasks, visibleTasks, notes, filters = {}) {
  const section = project => ({ project, id: project?.id ?? 'ungrouped', total: 0, done: 0, tasks: [], notes: [] })
  const groups = projects.map(section)
  const standalone = section(null)
  const byId = new Map(groups.map(group => [group.id, group]))
  const groupOf = task => byId.get(task.matter_id) ?? standalone
  for (const task of tasks) {
    const group = groupOf(task)
    group.total++
    if (task.status === 'done') group.done++
  }
  for (const task of visibleTasks) groupOf(task).tasks.push(task)
  for (const note of notes) byId.get(note.matter_id)?.notes.push(note)
  const filteringTasks = filters.q || filters.status || filters.undated || filters.list
  return [...groups, standalone].filter(group => (!filters.matter || filters.matter === group.id)
    && (group.tasks.length || (group.project && !filteringTasks)))
}
