// 统一 HTTP 入口：网络错误、接口错误、主动取消分开分类，页面按 kind/status/code 降级。
async function request(path, options) {
  let res
  try {
    res = await fetch(path, options)
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, kind: 'cancelled', status: 0, code: 'cancelled', message: '请求已取消' }
    }
    return { ok: false, kind: 'network', status: 0, code: 'network_unreachable', message: err.message }
  }
  const body = await res.json().catch(() => null)
  if (res.ok) return { ok: true, kind: 'http', status: res.status, body }
  return {
    ok: false,
    kind: 'http',
    status: res.status,
    code: (body && body.code) || 'http_error',
    message: (body && body.message) || `接口返回 ${res.status}`,
    body,
  }
}

export const healthz = () => request('/api/healthz')

export const analyze = (payload, /** @type {{ signal?: AbortSignal }} */ { signal } = {}) =>
  request('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })

export const propose = (payload, /** @type {{ signal?: AbortSignal }} */ { signal } = {}) =>
  request('/api/assistant/propose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}