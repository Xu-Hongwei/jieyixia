// 统一 HTTP 入口：网络错误、接口错误、主动取消分开分类，页面按 kind/status/code 降级。
export async function request(path, options = {}) {
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

