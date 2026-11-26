import { readonly, ref } from 'vue'
import { request } from './http'

let key = ''
let connection = new AbortController()
let attempt = 0
const connected = ref(false)
export const qwenConnected = readonly(connected)
export const connectionOpen = ref(false)
const failure = (code, message) => ({ ok: false, kind: 'local', status: 0, body: null, code, message })

export function requireQwen() {
  if (!key) connectionOpen.value = true
  return !!key
}

export function disconnectQwen() {
  attempt++
  connection.abort()
  connection = new AbortController()
  key = ''
  connected.value = false
  connectionOpen.value = false
}

function post(operation, secret, body, signal) {
  return request('/api/qwen/' + operation, {
    method: 'POST', redirect: 'error', mode: 'same-origin', cache: 'no-store',
    headers: { 'X-JXL-Qwen-Key': secret, 'Content-Type': 'application/json' }, body, signal,
  })
}

export async function connectQwen(input, signal) {
  const generation = ++attempt
  const candidate = input.trim()
  if (!globalThis.isSecureContext) return failure('https_required', '请通过 HTTPS 或本机地址连接千问。')
  if (!/^sk-[A-Za-z0-9_-]{8,200}$/.test(candidate)) return failure('qwen_key_invalid', '请输入完整的百炼 API Key。')
  const result = await post('verify', candidate, undefined, signal)
  if (signal.aborted || generation !== attempt) return failure('cancelled', '连接已取消。')
  if (!result.ok) return result
  if (result.body?.connected !== true) return failure('verify_failed', '服务未能验证连接，请稍后重试。')
  key = candidate
  connected.value = true
  connectionOpen.value = false
  return result
}

export async function requestQwen(operation, payload, signal) {
  if (!requireQwen()) return failure('qwen_connection_required', '请先在右上角连接千问，再重试。')
  const current = connection
  const result = await post(operation, key, JSON.stringify(payload),
    signal ? AbortSignal.any([signal, current.signal]) : current.signal)
  if (connection === current && ['qwen_key_denied', 'qwen_key_invalid'].includes(result.code)) {
    disconnectQwen()
    connectionOpen.value = true
  }
  return result
}
