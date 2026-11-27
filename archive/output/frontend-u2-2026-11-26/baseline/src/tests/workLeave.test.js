// 离开协调单例：无处理器放行；拒绝不放行；批准发一次性令牌避免切空间+路由守卫双重弹窗。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerWorkLeave, requestWorkLeave, resetWorkLeaveApproval } from '@/composables/workLeave'

let unregister = null
afterEach(() => {
  if (unregister) unregister()
  unregister = null
})

describe('workLeave 协调', () => {
  it('不在执行页（无处理器）直接放行', async () => {
    expect(await requestWorkLeave()).toBe(true)
  })
  it('处理器拒绝 → 不放行，也不发令牌', async () => {
    const fn = vi.fn(async () => false)
    unregister = registerWorkLeave(fn)
    expect(await requestWorkLeave()).toBe(false)
    expect(await requestWorkLeave()).toBe(false)
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('批准一次后，紧随的路由守卫请求消费令牌直接放行，不重复询问', async () => {
    const fn = vi.fn(async () => true)
    unregister = registerWorkLeave(fn)
    expect(await requestWorkLeave()).toBe(true) // 切空间协调
    expect(await requestWorkLeave()).toBe(true) // 空间切换触发的路由守卫
    expect(fn).toHaveBeenCalledTimes(1)
    expect(await requestWorkLeave()).toBe(true) // 令牌已消费：再次离开重新询问
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('注销后放行；重新注册重置令牌', async () => {
    const fn = vi.fn(async () => true)
    const un = registerWorkLeave(fn)
    await requestWorkLeave()
    un()
    expect(await requestWorkLeave()).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    const fn2 = vi.fn(async () => true)
    unregister = registerWorkLeave(fn2)
    expect(await requestWorkLeave()).toBe(true)
    expect(fn2).toHaveBeenCalledTimes(1)
  })
})

describe('workLeave 同路由参数更新（组件复用，不卸载）', () => {
  it('参数守卫放行后重置令牌：下一次参数变化重新询问，不凭残留令牌跳过保存/暂停', async () => {
    const fn = vi.fn(async () => true)
    unregister = registerWorkLeave(fn)
    // A→B：update 守卫跑一次协调，批准后组件复用（不 unregister），显式消费残留令牌。
    expect(await requestWorkLeave()).toBe(true)
    resetWorkLeaveApproval()
    expect(fn).toHaveBeenCalledTimes(1)
    // B→C：令牌已清，必须再次跑协调，不能直接放行。
    expect(await requestWorkLeave()).toBe(true)
    resetWorkLeaveApproval()
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('用户取消（处理器拒绝）不发令牌：重置后仍逐次询问，连续切换不绕过', async () => {
    const fn = vi.fn(async () => false)
    unregister = registerWorkLeave(fn)
    expect(await requestWorkLeave()).toBe(false)
    resetWorkLeaveApproval()
    expect(await requestWorkLeave()).toBe(false)
    resetWorkLeaveApproval()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})