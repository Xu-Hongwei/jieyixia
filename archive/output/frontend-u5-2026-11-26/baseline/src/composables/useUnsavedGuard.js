import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

// 表单宿主共用一个确认结果；并发的关闭/返回不能覆盖等待者。
export function useUnsavedGuard(isDirty, isBusy, discard) {
  const discardOpen = ref(false)
  let pending = null
  let resolve = null
  function settle(allowed) {
    if (allowed) discard()
    discardOpen.value = false
    resolve?.(allowed)
    resolve = null
    pending = null
  }
  watch(discardOpen, (open) => { if (!open) settle(false) })
  async function guardLeave() {
    if (isBusy()) return false
    if (!isDirty()) return true
    if (!pending) {
      pending = new Promise((done) => { resolve = done })
      discardOpen.value = true
    }
    return pending
  }
  function beforeUnload(event) {
    if (isDirty() || isBusy()) { event.preventDefault(); event.returnValue = '' }
  }
  onMounted(() => window.addEventListener('beforeunload', beforeUnload))
  onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); settle(false) })
  return { discardOpen, guardLeave, settle }
}
