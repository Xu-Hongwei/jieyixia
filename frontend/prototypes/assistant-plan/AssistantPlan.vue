<script setup>
import { computed, nextTick, ref } from 'vue'
import { ArrowLeft, ArrowRight, BookOpen, CalendarDays, Check, ChevronDown, Clock3, Flag, PanelsTopLeft } from 'lucide-vue-next'
import './plan.css'

// 两个入口使用同一份虚构通知。选择与采用都只影响本页的演示数据。
const review = new URLSearchParams(location.search).get('scene') === 'review'
const days = [
  { week: '周二', date: '11/24', budget: 60, existing: 10 },
  { week: '周三', date: '11/25', budget: review ? 60 : 120, existing: review ? 64 : 20 },
  { week: '周四', date: '11/26', budget: 100, existing: 25 },
  { week: '周五', date: '11/27', budget: 120, existing: 60 },
]
const actions = [
  { title: '整理三篇参考文献', minutes: 30 },
  { title: '写出报告初稿', minutes: 60 },
  { title: '核对引用，导出并提交 PDF', minutes: 25 },
]
const finalDay = ref(review ? null : 2)
const scheduledDays = computed(() => [0, review ? 2 : 1, finalDay.value])
const agenda = computed(() => days.map((day, index) => {
  const items = actions.filter((_, i) => scheduledDays.value[i] === index)
  const added = items.reduce((total, item) => total + item.minutes, 0)
  const limit = Math.floor(day.budget * .85)
  return { ...day, index, items, added, buffer: day.budget - limit,
    free: Math.max(0, limit - day.existing - added), over: Math.max(0, day.existing - limit) }
}))
const count = computed(() => scheduledDays.value.filter(day => day !== null).length)
const total = computed(() => agenda.value.reduce((sum, day) => sum + day.added, 0))
const confirmed = ref(false)
const deferred = ref(false)
const choosing = ref(false)
const choice = ref(null)
const timeChecked = ref(false)
const adopted = ref(false)
const calendar = ref(false)
const selected = ref(0)
const titleEl = ref(null)
const acknowledgeButton = ref(null)
const footerButton = ref(null)
const capacityOpen = ref(false)
const canAdopt = computed(() => (!review || confirmed.value) && (finalDay.value !== null || deferred.value))
const openDays = computed(() => agenda.value.filter(day => day.index >= scheduledDays.value[1] && day.free >= actions[2].minutes))
const deadlineDay = days.length - 1
async function togglePicker() {
  choosing.value = !choosing.value
  choice.value = null
  timeChecked.value = false
  if (choosing.value) {
    await nextTick()
    document.querySelector('.day-picker input')?.focus()
  }
}
function resolveGap(later) {
  if (!later && (!openDays.value.some(day => day.index === choice.value) || (choice.value === deadlineDay && !timeChecked.value))) return
  finalDay.value = later ? null : choice.value
  deferred.value = later
  choosing.value = false
  nextTick(() => footerButton.value?.focus())
}
async function primary() {
  if (!canAdopt.value) {
    if (finalDay.value === null && !deferred.value) {
      if (!choosing.value) await togglePicker()
      else document.querySelector('.day-picker input')?.focus()
    } else {
      capacityOpen.value = true
      await nextTick()
      acknowledgeButton.value?.focus()
    }
    return
  }
  if (adopted.value) {
    calendar.value = true
    selected.value = scheduledDays.value[0]
  } else {
    adopted.value = true
  }
  await nextTick()
  titleEl.value?.focus()
}
async function back() {
  calendar.value = false
  await nextTick()
  titleEl.value?.focus()
}
</script>

<template>
  <header class="mast">
    <span class="brand"><PanelsTopLeft :size="20"/>截下来</span>
    <span class="crumb">／ {{ calendar ? '日程' : '规划助手' }}</span>
    <nav aria-label="切换结果样板"><span>样板</span><a href="?scene=ready" :aria-current="!review ? 'page' : undefined">全部排好</a><a href="?scene=review" :aria-current="review ? 'page' : undefined">需要核对</a></nav>
  </header>
  <main>
    <template v-if="!calendar">
      <div class="intro">
        <p class="eyebrow"><span class="stroke"></span>{{ adopted ? '已加入日程' : '安排预览' }}</p>
        <h1 ref="titleEl" tabindex="-1">课程报告</h1>
        <p class="deadline"><Flag :size="15"/>总截止 <strong>11 月 27 日 周五 18:00</strong></p>
      </div>
      <div class="layout">
        <section aria-label="每日安排" class="agenda">
          <header class="section-head"><h2>每日安排</h2><span>{{ count }} 项 · {{ total }} 分钟</span></header>
          <template v-for="day in agenda" :key="day.date">
            <article v-if="day.items.length || day.over" class="day">
              <div class="date"><strong>{{ day.week }}</strong><small>{{ day.date }}</small></div>
              <div class="entries">
                <div v-for="item in day.items" :key="item.title" class="entry"><b>{{ item.title }}</b><span>{{ item.minutes }} 分钟</span></div>
                <div v-if="day.over" class="budget">
                  <button class="budget-head" :aria-expanded="capacityOpen" @click="capacityOpen = !capacityOpen"><span>已有安排超出 {{ day.over }} 分钟</span><ChevronDown :size="15"/></button>
                  <small>本次新增 {{ day.added }} 分钟{{ confirmed ? ' · 已核对' : '' }}</small>
                  <div v-if="capacityOpen" class="breakdown">
                    <dl><div><dt>当天可用</dt><dd>{{ day.budget }} 分钟</dd></div><div><dt>预留缓冲</dt><dd>{{ day.buffer }} 分钟</dd></div><div><dt>已有安排</dt><dd>{{ day.existing }} 分钟</dd></div></dl>
                    <p>可安排 {{ day.budget - day.buffer }} 分钟，已有 {{ day.existing }} 分钟，多出 {{ day.over }} 分钟。</p>
                    <button v-if="!confirmed" class="outline" :ref="el => { acknowledgeButton = el }" @click="confirmed = true; nextTick(() => footerButton?.focus())">保留当天已有安排</button>
                  </div>
                </div>
              </div>
            </article>
          </template>
          <section v-if="review && finalDay === null" class="gap">
            <div class="section-head"><h2>{{ deferred ? '留待安排' : '待安排' }}</h2><span>1 项</span></div>
            <div class="gap-line"><b>{{ actions[2].title }}</b><span>25 分钟</span></div>
            <p>周四写完初稿后，当天时间已用完。周五提交需核对截止时刻。</p>
            <template v-if="!adopted">
              <div class="choices"><button class="outline" :aria-expanded="choosing" @click="togglePicker"><CalendarDays :size="15"/>{{ choosing ? '收起日期' : '选一天' }}</button>
                <button v-if="!deferred" class="quiet" @click="resolveGap(true)">这次先不排</button></div>
              <fieldset v-if="choosing" class="day-picker"><legend>初稿完成后可用的日期</legend>
                <label v-for="d in openDays" :key="d.index"><input type="radio" v-model="choice" :value="d.index"/> {{ d.week }} {{ d.date }} · 剩 {{ d.free }} 分钟</label>
                <label v-if="choice === deadlineDay"><input type="checkbox" v-model="timeChecked"/> 我能在周五 18:00 前完成</label>
                <button class="primary" :disabled="choice === null || (choice === deadlineDay && !timeChecked)" @click="resolveGap(false)">排到所选日期</button>
              </fieldset>
            </template>
          </section>
        </section>
        <aside aria-label="计划依据">
          <h2>计划依据</h2>
          <details class="source"><summary><BookOpen :size="18"/><span><b>课程报告提交要求</b><small>课程通知 · 查看原文</small></span><ChevronDown :size="15"/></summary>
            <blockquote>请在 11 月 27 日（周五）18:00 前提交课程报告 PDF。正文至少引用三篇参考文献，提交前请核对引用与文末出处。</blockquote>
          </details>
          <div class="request"><h3>我的要求</h3><p>先整理文献，再写初稿，最后留一点时间核对和提交。</p></div>
        </aside>
      </div>
      <footer class="actions"><span role="status"><component :is="adopted ? Check : Clock3" :size="16"/>{{ adopted ? '样板日程已更新' : canAdopt ? '安排已核对' : '需要核对 ' + (Number(!confirmed) + Number(finalDay === null && !deferred)) + ' 项' }}</span>
        <button ref="footerButton" class="primary" @click="primary">{{ adopted ? '查看日程' : canAdopt ? '将 ' + count + ' 项安排加入日程' : '处理待核对项' }}<ArrowRight :size="16"/></button>
      </footer>
    </template>
    <template v-else>
      <button class="quiet back" @click="back"><ArrowLeft :size="16"/>返回计划</button>
      <p class="eyebrow"><span class="stroke"></span>样板日程 · 2026 年 11 月</p>
      <h1 ref="titleEl" tabindex="-1">课程报告的日程</h1>
      <div class="calendar"><div class="day-tabs" role="group" aria-label="查看日期"><button v-for="day in agenda" :key="day.index" :aria-pressed="selected === day.index" @click="selected = day.index">{{ day.week }} <b>{{ day.date }}</b></button></div>
        <div class="section-head"><h2>每日工作</h2><span>{{ agenda[selected].items.length }} 项新增安排</span></div>
        <div v-for="item in agenda[selected].items" :key="item.title" class="entry"><b>{{ item.title }}</b><span>{{ item.minutes }} 分钟</span></div>
        <p v-if="!agenda[selected].items.length">当天没有本计划新增的工作。</p>
        <div class="section-head due-head"><h2>每日截止</h2></div><p>{{ selected === deadlineDay ? '18:00 · 提交课程报告 PDF' : '当天没有截止事项' }}</p>
      </div>
    </template>
  </main>
</template>
