<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowLeft, ArrowRight, CalendarDays, X } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import notice from '@/assets/tutorial/competition-notice.png'
import replay from '@/assets/tutorial/competition-replay.json'

const props = defineProps({ step: { type: Number, required: true } })
const emit = defineEmits(['step', 'close', 'finish'])
const dialog = ref(null)
const heading = ref(null)
const scrollArea = ref(null)
const titles = ['从一张群通知开始', '核对助手拆出的任务', '看这两天怎么安排']
const nextLabels = ['查看识别与拆解', '查看采用后的日程', '用我的资料试试']
const days = [...new Set(replay.schedule.map(row => row.date))]
const deadline = computed(() => replay.deadline.slice(5, 16).replace('-', ' 月 ').replace('T', ' 日 '))
function forward() {
  if (props.step === 2) emit('finish')
  else emit('step', props.step + 1)
}
function focusStep() {
  scrollArea.value?.scrollTo(0, 0)
  heading.value?.focus({ preventScroll: true })
}
onMounted(() => { dialog.value.showModal(); focusStep() })
onBeforeUnmount(() => dialog.value?.close())
watch(() => props.step, () => nextTick(focusStep))
</script>

<template>
  <dialog ref="dialog" aria-labelledby="tutorial-heading" class="tutorial" @cancel.prevent="emit('close')">
    <header class="flex items-center justify-between gap-4 border-b px-5 py-3 sm:px-8">
      <span class="text-sm font-medium">截下来 <span class="ml-2 text-muted-foreground">使用教学</span></span>
      <Button size="sm" variant="ghost" @click="emit('close')">{{ step === 2 ? '结束教学' : '跳过教学' }}<X /></Button>
    </header>
    <div ref="scrollArea" class="tutorial-body">
      <div class="mb-5 flex items-center gap-3 text-xs text-muted-foreground">
        <span class="tabular-nums">{{ step + 1 }} / 3</span>
        <span v-for="i in 3" :key="i" aria-hidden="true" class="h-0.5 w-7" :class="i <= step + 1 ? 'bg-primary' : 'bg-border'"></span>
      </div>
      <h1 id="tutorial-heading" ref="heading" tabindex="-1" class="workspace-title outline-none">{{ titles[step] }}</h1>
      <div v-if="step === 0" class="source-layout">
        <figure class="overflow-hidden rounded-lg bg-muted"><img :src="notice" alt="电子设计大赛报名群通知原图，要求三人组队，11 月 25 日 17:00 截止" class="mx-auto block h-auto w-full max-w-[480px]" /></figure>
        <div class="self-center">
          <p class="text-sm font-medium text-primary">给助手的要求</p>
          <blockquote class="mt-2 text-base leading-relaxed">{{ replay.request }}</blockquote>
          <p class="mt-4 text-xs leading-relaxed text-muted-foreground">真实案例回放 · 以 2026 年 11 月 24 日为起点</p>
        </div>
      </div>
      <template v-else-if="step === 1">
        <p class="mt-4 font-medium">{{ replay.title }}</p>
        <p class="mt-1 text-sm text-muted-foreground">原文写着「{{ replay.deadlineQuote }}」，核对后作为报名总截止。</p>
        <ul class="mt-5 divide-y border-y">
          <li v-for="action in replay.actions" :key="action.text" class="flex items-baseline justify-between gap-5 py-3">
            <span class="text-sm leading-relaxed">{{ action.text }} <small v-if="action.suggested" class="text-muted-foreground">助手建议</small></span>
            <span class="shrink-0 text-sm tabular-nums">{{ action.minutes }} 分钟</span>
          </li>
        </ul>
        <details class="mt-4 text-sm"><summary class="cursor-pointer text-primary">对照识别出的报名要求</summary>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-muted-foreground"><li v-for="line in replay.requirements" :key="line">{{ line }}</li></ul>
        </details>
      </template>
      <template v-else>
        <p class="mb-4 mt-3 text-sm text-muted-foreground">前两项自动排入。最后一项在核对时手动选了次日上午 9 点。</p>
        <section v-for="date in days" :key="date" class="day">
          <h2 class="font-semibold tabular-nums">{{ date.slice(5).replace('-', '/') }}</h2>
          <ul class="divide-y"><li v-for="row in replay.schedule.filter(r => r.date === date)" :key="row.title" class="flex items-baseline justify-between gap-3 py-2 text-sm"><span>{{ row.title }}</span><span class="shrink-0 text-muted-foreground">{{ row.minutes }} 分钟</span></li></ul>
        </section>
        <p class="mt-4 flex items-center gap-2 text-sm font-medium text-primary"><CalendarDays class="size-4" />报名总截止 · {{ deadline }}</p>
      </template>
    </div>
    <footer class="flex items-center justify-between gap-3 border-t px-5 py-3 sm:px-8">
      <Button v-if="step" variant="ghost" @click="emit('step', step - 1)"><ArrowLeft />上一步</Button>
      <Button class="ml-auto" @click="forward">{{ nextLabels[step] }}<ArrowRight /></Button>
    </footer>
  </dialog>
</template>

<style scoped>
.tutorial { position: fixed; inset: 0; margin: auto; width: min(46rem, calc(100% - 1.5rem)); max-width: none; max-height: min(90dvh, 48rem); overflow: hidden; padding: 0; border: 1px solid var(--border); border-radius: 1rem; background: var(--card); color: var(--foreground); box-shadow: 0 1.5rem 5rem #12241e35; }
.tutorial[open] { display: flex; flex-direction: column; }
.tutorial::backdrop { background: rgb(24 35 31 / .52); }
.tutorial-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: clamp(1.15rem, 3vw, 2rem); }
.source-layout { display: grid; gap: 1.25rem; margin-top: 1.25rem; }
.day { display: grid; grid-template-columns: 4rem 1fr; align-items: baseline; gap: .5rem; padding: .45rem 0; border-top: 1px solid var(--border); }
@media (min-width: 640px) { .source-layout { grid-template-columns: 1.5fr 1fr; } }
</style>
