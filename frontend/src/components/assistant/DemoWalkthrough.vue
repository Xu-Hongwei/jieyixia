<script setup>
import { ref } from 'vue'
import { ArrowLeft, ArrowRight, RotateCcw } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import notice from '@/assets/tutorial/course-notice.png'

const step = ref(0)
const titles = ['读一张作业通知', '核对提交要求', '把报告安排到三天', '开始第一项行动']
const captions = [
  '这是一份内置的课程通知。点继续，看看它如何变成每天能执行的安排。',
  '对照原文确认字数和交付物。通知只写了截止日期，具体时刻留空。',
  '采用这份安排后，每天都有自己的行动，总截止仍单独提醒。',
  '在 11 月 17 日的日程点「开始」，会直接打开这项行动的工作页。',
]
const days = [
  { date: '11 月 17 日', action: '整理两组实验结果', time: '45 分钟' },
  { date: '11 月 18 日', action: '撰写报告并插入对比图', time: '90 分钟' },
  { date: '11 月 19 日', action: '复核 PDF 和代码包，提交作业', time: '30 分钟' },
]
</script>

<template>
  <section aria-label="规划助手操作演示" class="mx-auto max-w-3xl">
    <header class="mb-5"><h1 class="workspace-title">规划助手</h1></header>
    <div class="overflow-hidden rounded-xl border bg-card">
      <div class="px-5 pt-5 sm:px-8 sm:pt-7" aria-live="polite" aria-atomic="true">
        <p class="text-sm text-muted-foreground">课程报告 · 操作演示 <span class="ml-2 tabular-nums">{{ step + 1 }} / {{ titles.length }}</span></p>
        <h2 class="mt-2 text-xl font-semibold">{{ titles[step] }}</h2>
        <p class="mt-2 text-sm leading-relaxed text-muted-foreground">{{ captions[step] }}</p>
      </div>
      <div class="mx-5 my-5 flex min-h-64 items-center sm:mx-8">
        <img v-if="step === 0" :src="notice" alt="机器学习课程报告通知，要求提交 PDF 和可运行代码，11 月 19 日截止" class="mx-auto max-h-80 w-full rounded-md border object-contain bg-white" />
        <dl v-else-if="step === 1" class="w-full divide-y border-y text-sm">
          <div v-for="[label, value] in [['交付物', 'PDF 报告 + 可运行代码压缩包'], ['报告要求', '至少 3000 字，包含至少两组实验对比'], ['总截止', '2026 年 11 月 19 日'], ['提交地点', '课程平台的「作业」入口']]" :key="label" class="grid grid-cols-[5rem_1fr] gap-3 py-3">
            <dt class="text-muted-foreground">{{ label }}</dt><dd class="font-medium">{{ value }}</dd>
          </div>
        </dl>
        <div v-else-if="step === 2" class="w-full">
          <ol class="divide-y border-y">
            <li v-for="day in days" :key="day.date" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 text-sm">
              <span class="text-muted-foreground">{{ day.date }}</span><strong class="min-w-32 flex-1">{{ day.action }}</strong><span>{{ day.time }}</span>
            </li>
          </ol>
          <p class="mt-3 border-l-2 border-primary pl-3 text-sm text-primary">总截止提醒 · 11 月 19 日提交课程报告</p>
        </div>
        <div v-else class="w-full border-l-2 border-primary bg-muted/40 px-5 py-7">
          <p class="text-sm text-muted-foreground">机器学习课程报告 · 工作页预览</p>
          <h3 class="mt-2 text-xl font-semibold">{{ days[0].action }}</h3>
          <p class="mt-2 text-sm">预计 {{ days[0].time }} · 完成后记录进展</p>
        </div>
      </div>
      <footer class="flex items-center justify-between gap-3 border-t px-5 py-4 sm:px-8">
        <Button variant="ghost" :disabled="step === 0" @click="step--"><ArrowLeft />上一步</Button>
        <Button v-if="step < titles.length - 1" @click="step++">继续<ArrowRight /></Button>
        <Button v-else @click="step = 0"><RotateCcw />重新演示</Button>
      </footer>
    </div>
  </section>
</template>
