import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectQwen, disconnectQwen, qwenConnected, requestQwen } from '../services/api/qwenConnection'

const secret = 'sk-synthetic-personal-key'
const ok = body => new Response(JSON.stringify(body), { status: 200 })
const connect = () => connectQwen(secret, new AbortController().signal)
beforeEach(() => {
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => { disconnectQwen(); vi.unstubAllGlobals() })

it.each(['sk-a', 'sk-' + 'a'.repeat(256)])('sends the complete key for verification regardless of length', async key => {
  vi.mocked(fetch).mockResolvedValueOnce(ok({ connected: true }))
  expect((await connectQwen(key, new AbortController().signal)).ok).toBe(true)
  expect(fetch).toHaveBeenCalledWith('/api/qwen/verify', expect.objectContaining({
    headers: expect.objectContaining({ 'X-JXL-Qwen-Key': key }),
  }))
})

it.each(['sk-', 'sk-a b', 'wrong-prefix'])('rejects malformed input before contacting the service', async key => {
  expect((await connectQwen(key, new AbortController().signal)).ok).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})

it('validates before enabling both model paths and stops sending on disconnect', async () => {
  expect((await requestQwen('analyze', {}, undefined)).ok).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
  vi.mocked(fetch).mockResolvedValueOnce(ok({ connected: true }))
  expect((await connect()).ok).toBe(true)
  for (const operation of ['analyze', 'propose']) {
    vi.mocked(fetch).mockResolvedValueOnce(ok({}))
    await requestQwen(operation, { text: 'sample' }, undefined)
    expect(fetch).toHaveBeenLastCalledWith('/api/qwen/' + operation, expect.objectContaining({
      headers: expect.objectContaining({ 'X-JXL-Qwen-Key': secret }), redirect: 'error', body: '{"text":"sample"}',
    }))
  }
  disconnectQwen()
  expect(qwenConnected.value).toBe(false)
  expect((await requestQwen('propose', {}, undefined)).ok).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('rejects insecure transport and cannot reconnect after a cancelled verification', async () => {
  vi.stubGlobal('isSecureContext', false)
  expect((await connect()).ok).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
  vi.stubGlobal('isSecureContext', true)
  vi.mocked(fetch).mockResolvedValueOnce(ok({ connected: true }))
  const pending = connect()
  disconnectQwen()
  expect((await pending).ok).toBe(false)
  expect(qwenConnected.value).toBe(false)
})
