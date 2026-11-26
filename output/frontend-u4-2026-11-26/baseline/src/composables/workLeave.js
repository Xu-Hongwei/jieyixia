// 页面离开协调（单例）：路由守卫与 WorkspaceSwitcher 共用当前页面的保护流程，
// 执行页保存并暂停，任务总览保护未保存的任务/安排。批准一次后发一次性令牌，
// 让随后由空间切换触发的路由守卫直接放行，不重复弹窗。
let handler = null
let approved = false

export function registerWorkLeave(fn) {
  handler = fn
  approved = false
  return () => {
    if (handler === fn) handler = null
    approved = false
  }
}

// 返回 true 才允许导航/切空间。无处理器时直接放行。
export async function requestWorkLeave() {
  if (approved) {
    approved = false
    return true
  }
  if (!handler) return true
  const ok = await handler()
  if (ok) approved = true
  return ok
}

// 同路由参数更新（/work/A → /work/B）复用组件、不卸载，离开令牌不会随 unregister 清掉。
// 参数守卫放行后必须显式消费残留令牌，否则下一次参数变化会凭它跳过保存/暂停检查。
export function resetWorkLeaveApproval() {
  approved = false
}
