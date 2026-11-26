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
