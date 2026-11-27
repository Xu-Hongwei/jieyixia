<script setup>
// M2 生成状态面板：进度/取消、失败重试、保存失败留结果重试、澄清集中作答。
// 只读 store.gen 阶段机；所有付费请求由 store 编排，这里不直接调 API。
import { computed, reactive, watch } from 'vue'
import { Loader2, XCircle } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Alert from '@/components/ui/Alert.vue'
import { useAssistantStore } from '@/stores/assistant'

const store = useAssistantStore()
const answers = reactive({})
const hasUnsaved = computed(() => store.gen?.phase === 'clarification' && Object.values(answers).some(value => String(value).trim()))
function discard() { for (const key of Object.keys(answers)) delete answers[key] }
defineExpose({ hasUnsaved, discard })
// 新一轮（requestId 变化）清空上一轮答案，不把旧回答混入新澄清。
watch(() => store.gen?.requestId, () => { for (const k of Object.keys(answers)) delete answers[k] })

const allAnswered = () => (store.gen?.questions ?? []).every((q) => (answers[q.question_id] ?? '').trim())
async function continueGen() {
  const qs = store.gen?.questions ?? []
  await store.continueClarification(qs.map((q) => ({ question_id: q.question_id, answer: (answers[q.question_id] ?? '').trim() })))
}
</script>

<template>
  <div v-if="store.gen" class="space-y-2">
    <template v-if="store.gen.phase === 'preparing' || store.gen.phase === 'requesting'">
      <Alert variant="info" class="flex items-center gap-2">
        <Loader2 class="size-4 shrink-0 animate-spin" />
        <span class="flex-1">{{ store.gen.progress }}</span>
        <Button size="sm" variant="outline" @click="store.cancelGeneration()"><XCircle class="size-4" />取消</Button>
      </Alert>
      <p class="text-xs text-muted-foreground">取消只停止本地等待，不承诺免除已发生的模型调用；输入与已有内容保留。</p>
    </template>

    <Alert v-else-if="store.gen.phase === 'failed'" variant="warning">
      {{ store.gen.error?.message || '生成失败' }}
      <div class="mt-2 flex gap-2">
        <Button size="sm" @click="store.retryGeneration()">重试生成</Button>
      </div>
    </Alert>

    <Alert v-else-if="store.gen.phase === 'save_failed'" variant="warning">
      {{ store.gen.error?.message || '结果已收到但本地保存失败' }}
      <div class="mt-2 flex gap-2">
        <Button size="sm" @click="store.retrySaveResult()">重试保存（不重调模型）</Button>
        <Button size="sm" variant="outline" @click="store.dismissGeneration()">放弃该结果</Button>
      </div>
    </Alert>

    <div v-else-if="store.gen.phase === 'clarification'" class="rounded-lg border bg-card p-4">
      <h3 class="text-sm font-semibold">模型需要澄清（集中回答后继续）</h3>
      <Alert v-if="store.gen.legacyUntrusted" variant="warning" class="mt-2">
        检测到旧版澄清记录：其中的问答无法可靠区分模型示例与你的回答，仅供下方展示，不会作为你的回答提交。请针对下方问题重新填写真实回答后继续。
      </Alert>
      <div v-if="store.gen.legacyDisplay?.length" class="mt-2 space-y-2 rounded-md border border-dashed p-3">
        <div class="text-xs font-medium text-muted-foreground">旧记录展示（不作为回答）</div>
        <div v-for="(h, i) in store.gen.legacyDisplay" :key="i" class="text-xs text-muted-foreground">
          <div class="whitespace-pre-wrap">问：{{ h.question }}</div>
          <div class="whitespace-pre-wrap">答：{{ h.answer }}</div>
        </div>
      </div>
      <div v-for="q in store.gen.questions ?? []" :key="q.question_id" class="mt-3 space-y-1 rounded-md border p-3">
        <div class="text-sm font-medium">{{ q.question }}</div>
        <div class="text-xs text-muted-foreground">为什么必须先回答：{{ q.blocking_reason }}</div>
        <div v-if="q.options?.length" class="flex flex-wrap gap-1">
          <Button v-for="opt in q.options" :key="opt" size="sm" :variant="(answers[q.question_id] ?? '') === opt ? 'default' : 'outline'" @click="answers[q.question_id] = opt">{{ opt }}</Button>
        </div>
        <Input v-model="answers[q.question_id]" placeholder="输入回答（可直接填写，不必选选项）" :aria-label="`回答：${q.question}`" />
      </div>
      <Button class="mt-3" :disabled="!allAnswered() || store.generating" @click="continueGen">继续生成</Button>
      <p class="mt-1 text-xs text-muted-foreground">原要求与历轮澄清问答会一并归档并发给模型；未回答完整不能继续。</p>
    </div>

    <Alert v-else-if="store.gen.phase === 'done'" variant="success">
      方案已生成（待核对，未采用）。
      <Button size="sm" class="ml-2" @click="store.open(store.gen.draftId)">打开草案核对</Button>
    </Alert>
  </div>
</template>
