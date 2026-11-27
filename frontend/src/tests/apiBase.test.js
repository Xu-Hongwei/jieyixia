import { afterEach, describe, expect, it, vi } from 'vitest'

describe('api 基址', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('默认与本地/Ubuntu 一致：保持 /api 原路径', async () => {
    vi.resetModules()
    const { API_BASE, apiUrl } = await import('../services/api/base')
    expect(API_BASE).toBe('')
    expect(apiUrl('/api/healthz')).toBe('/api/healthz')
    expect(apiUrl('/api/qwen/analyze')).toBe('/api/qwen/analyze')
  })

  it('Sites 构建：前缀同源 Function 且去掉多余尾斜杠', async () => {
    vi.stubEnv('VITE_API_BASE', '/functions/v1/app/')
    vi.resetModules()
    const { apiUrl } = await import('../services/api/base')
    expect(apiUrl('/api/healthz')).toBe('/functions/v1/app/api/healthz')
    expect(apiUrl('/api/qwen/propose')).toBe('/functions/v1/app/api/qwen/propose')
  })
})
