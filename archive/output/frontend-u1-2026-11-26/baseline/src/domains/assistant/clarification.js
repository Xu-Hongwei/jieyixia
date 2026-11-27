// 澄清合成消息的机器固定格式（契约 contract/assistant_models.py 权威定义的 JS 镜像）。
// 格式：原始要求：<user> / 空行 / 此前的澄清问题与我的回答： / 问：<model> 答：<user> … / 空行 / 请结合以上回答继续生成方案。
// 用户输入单独存成结构化字段（user_input）：核验只读 original_user_request 与各 user_answer，
// 模型提问无论含什么标记（包括「答：…」）都始终属于 assistant_question 字段，不取得用户身份。
export const CLARIFY_ORIGINAL_PREFIX = '原始要求：'
export const CLARIFY_HISTORY_HEADER = '此前的澄清问题与我的回答：'
export const CLARIFY_QUESTION_PREFIX = '问：'
export const CLARIFY_ANSWER_PREFIX = '答：'
export const CLARIFY_CONTINUE_TAIL = '请结合以上回答继续生成方案。'

// 由结构化用户输入渲染模型读到的合成文本（与契约 render_user_authored_text 同口径，单一来源）。
export function renderUserInputText(ui) {
  if (!ui.clarifications?.length) return ui.original_user_request
  const lines = [`${CLARIFY_ORIGINAL_PREFIX}${ui.original_user_request}`, '', CLARIFY_HISTORY_HEADER]
  for (const t of ui.clarifications) lines.push(`${CLARIFY_QUESTION_PREFIX}${t.assistant_question}`, `${CLARIFY_ANSWER_PREFIX}${t.user_answer}`)
  lines.push('', CLARIFY_CONTINUE_TAIL)
  return lines.join('\n')
}

// 结构化用户输入的真实用户段：原始要求 + 各轮回答（trim 非空）。出处接地只读本函数，不解析文本。
export function userInputSegments(ui) {
  return [ui.original_user_request, ...(ui.clarifications ?? []).map((t) => t.user_answer)]
    .map((s) => String(s ?? '').trim()).filter(Boolean)
}

// 保守前缀判定（契约 looks_like_composed_clarification 的 JS 镜像）：
// 以「原始要求：」开头即视为机器合成澄清文本。只识别格式，不解析问/答角色。
export function isComposedClarificationText(text) {
  return String(text ?? '').startsWith(CLARIFY_ORIGINAL_PREFIX)
}

// 旧记录（无 user_input 字段）的用户段信任规则（P2 收口，差异文档 §8）：
// 合成澄清文本零可信段——不猜用户身份，模型示例不得升级为 user_answer 或 manual 证据；
// 普通文本（首轮原话/手动改值归档）整条可信。新归档一律走 userInputSegments 结构化字段。
export function userAuthoredSegments(text) {
  const s = String(text ?? '')
  if (isComposedClarificationText(s)) return []
  return s.trim() ? [s] : []
}

// 旧合成记录的问/答回显解析：**仅供只读展示**（legacyDisplay），绝不进入 history/user_answer/核验段。
// 无法可靠区分模型示例与用户回答，展示原文让用户重新填写真实回答。
export function parseClarificationHistory(text) {
  const out = []
  const lines = String(text ?? '').split('\n')
  let pending = null
  for (const line of lines) {
    if (line.startsWith(CLARIFY_QUESTION_PREFIX)) pending = line.slice(CLARIFY_QUESTION_PREFIX.length)
    else if (line.startsWith(CLARIFY_ANSWER_PREFIX) && pending != null) { out.push({ question: pending, answer: line.slice(CLARIFY_ANSWER_PREFIX.length) }); pending = null }
  }
  return out
}