import limitsDoc from '@contract/limits.json'

// 资料选择只需要这一数值，不应把生成请求与契约校验器带入资料页。
export const MAX_SELECTED_SOURCES = limitsDoc.limits.max_selected_sources.value
