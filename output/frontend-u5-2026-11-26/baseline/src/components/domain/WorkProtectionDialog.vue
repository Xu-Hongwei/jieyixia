<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle,
} from 'reka-ui'
import Button from '@/components/ui/Button.vue'
import { useAppStore } from '@/stores/app'

// 删除/完成保护统一引导（3B-3）：命中未结束会话（运行/暂停/旧版）时弹出，
// 明确「结束并保存后才能继续」，提供取消 / 前往处理工作；前往不自动执行删除，
// 处理完返回原对象须重新确认。暂停不解除保护，故文案不再说「先暂停或结束」。
// 关闭（取消/Escape/遮罩）只清空引导，不产生任何导航或删除。
const store = useAppStore()
const route = useRoute()
const router = useRouter()

const open = computed({
  get: () => !!store.workBlock,
  set: (v) => { if (!v) store.clearWorkBlock() },
})
const sessions = computed(() => (store.workBlock && store.workBlock.sessions) || [])

function gotoWork() {
  const s = sessions.value[0]
  store.clearWorkBlock()
  if (s) router.push({ path: '/work/' + s.id, query: { return: route.fullPath } })
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-4 shadow-lg"
      >
        <DialogTitle class="text-base font-semibold">先处理尚未结束的工作</DialogTitle>
        <DialogDescription class="mt-2 text-sm text-muted-foreground">
          这项操作涉及尚未结束的工作。结束并保存后，才能继续。
        </DialogDescription>
        <ul class="mt-3 space-y-2">
          <li v-for="s in sessions" :key="s.id" class="rounded-md border bg-background px-3 py-2 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <span class="break-words font-medium text-foreground">{{ s.title || '旧版记录（无快照）' }}</span>
              <span class="rounded bg-accent px-1.5 text-xs text-muted-foreground">{{ s.state }}</span>
            </div>
            <div v-if="s.actionText" class="mt-0.5 break-words text-xs text-muted-foreground">行动：{{ s.actionText }}</div>
            <div v-if="s.missingRefs" class="mt-0.5 text-xs text-muted-foreground">原任务/行动已缺失，可在专注页查看草稿并显式结束。</div>
          </li>
        </ul>
        <p class="mt-3 text-xs text-muted-foreground">前往处理不会立即删除；结束并保存后返回，需重新确认本次操作。</p>
        <div class="mt-4 flex justify-end gap-2">
          <Button variant="outline" @click="store.clearWorkBlock()">取消</Button>
          <Button @click="gotoWork">前往处理工作</Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>