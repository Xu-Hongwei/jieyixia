// URL 只交接资料 ID 与来源空间；接受前和点击时均重新校验。
export function resolveMaterialHandoff(query, workspaceId, sources, limit) {
  if (query.sources == null) return null
  if (query.workspace !== workspaceId) return { ok: false, message: '这些资料来自其他空间，请返回原空间重新选择。' }
  const ids = Array.isArray(query.sources) ? query.sources : [query.sources]
  if (!ids.length || ids.length > limit || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    return { ok: false, message: `资料选择无效，一次最多选择 ${limit} 份。` }
  }
  const selected = ids.map(id => sources.find(source => source.id === id && source.workspace_id === workspaceId))
  if (selected.some(source => !source)) return { ok: false, message: '部分资料已不存在，请返回资料库重新选择。' }
  return { ok: true, ids, sources: selected }
}
