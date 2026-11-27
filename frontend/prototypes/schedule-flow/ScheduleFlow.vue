<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ArrowRight, CalendarDays, Check, CheckCheck, Clock3, FileText, Flag, ListTodo, Pause, Play, Plus, RotateCcw, ScanText, Square, X } from 'lucide-vue-next'
import './schedule.css'

const dates = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const today = 1 // 固定演示周，便于桌面和手机复核同一个工作流。
const templates = [
  { id: 'read', title: '整理三篇参考文献', task: '课程报告', minutes: 30, day: 1 },
  { id: 'write', title: '写出报告初稿', task: '课程报告', minutes: 60, day: 3 },
  { id: 'review', title: '核对引用与格式', task: '课程报告', minutes: 20, day: null },
  { id: 'slides', title: '准备小组发言提纲', task: '课堂讨论', minutes: 25, day: null },
  { id: 'figures', title: '标注实验图表', task: '课程报告', minutes: 35, day: 1 },
  { id: 'notes', title: '汇总组员的问题和讨论纪要', task: '课堂讨论', minutes: 25, day: 1 },
  { id: 'proof', title: '校对研究方法与参考文献格式', task: '课程报告', minutes: 20, day: 1 },
  { id: 'rehearse', title: '练习小组汇报', task: '课堂讨论', minutes: 45, day: 2 },
]
const materials = {
  '课程报告': { title: '课程报告提交要求', text: '请在周五 18:00 前提交报告 PDF。正文需引用三篇参考文献，并在文末列出出处。' },
  '课堂讨论': { title: '小组讨论通知', text: '请准备发言提纲，整理组员的问题，并在讨论结束后提交纪要。' },
}
const scene = ref('轻量周')
const day = ref(today)
const rows = ref([])
const history = ref([])
const active = ref('')
const item = computed(() => rows.value.find(row => row.id === active.value))
const scheduled = computed(() => rows.value.filter(row => row.day !== null))
const backlog = computed(() => rows.value.filter(row => row.day === null))
const deadlines = computed(() => scene.value === '空周' ? [] : [
  { day: 4, time: '18:00', task: '课程报告' },
  ...(scene.value === '繁忙周' ? [{ day: 0, time: '17:00', task: '课堂讨论' }] : []),
])
const modal = ref(null)
const stage = ref('week')
const panel = ref('')
const selectedTask = ref('')
const notes = ref('')
const outcome = ref('部分完成')
const progress = ref('还要继续')
const blockReason = ref('')
const dateChecked = ref(false)
const elapsed = ref(0)
const running = ref(false)
let since = 0
let previous = 0
let timer
const toast = ref('')
const nextAction = ref('')
function materialText(task) {
  if (scene.value === '空周' && task === '课程报告') return '先整理三篇参考文献，再撰写初稿。具体提交日期待通知。'
  return materials[task].text
}
const timeText = computed(() => {
  const seconds = Math.floor(elapsed.value / 1000)
  return [Math.floor(seconds / 60), seconds % 60].map(n => String(n).padStart(2, '0')).join(':')
})
function reset() {
  rows.value = templates.slice(0, scene.value === '繁忙周' ? 8 : 4).map(r => ({
    ...r, day: scene.value === '空周' ? null : r.day, status: '待执行', actionStatus: '未开始',
  }))
  history.value = []
  active.value = ''
  toast.value = ''
  day.value = today
}
reset()
function dateLabel(d) { return '11 月' + (23 + d) + ' 日 · ' + dates[d] }
function openPanel(type) {
  panel.value = type
  nextTick(() => { if (!modal.value.open) modal.value.showModal() })
}
function closePanel() {
  modal.value?.close()
  panel.value = ''
}
function inspect(row) {
  active.value = row.id
  day.value = row.day
  nextAction.value = ''
  dateChecked.value = false
  toast.value = ''
  openPanel('detail')
}
function add(row) {
  row.day = day.value
  toast.value = row.title + '已安排在' + dates[day.value]
}
function clockStart() {
  since = performance.now()
  running.value = true
  timer = window.setInterval(() => { elapsed.value = previous + performance.now() - since }, 200)
}
function clockStop() {
  if (running.value) previous += performance.now() - since
  elapsed.value = previous
  running.value = false
  clearInterval(timer)
}
onBeforeUnmount(clockStop)
function startWork() {
  if (item.value.day !== today && !dateChecked.value) { openPanel('date'); return }
  if (item.value.actionStatus === '完成' && nextAction.value.trim()) {
    item.value.actionTitle = nextAction.value.trim()
    item.value.actionStatus = '未开始'
  }
  closePanel()
  stage.value = 'work'
  notes.value = ''
  elapsed.value = previous = 0
  outcome.value = '部分完成'
  progress.value = '还要继续'
  blockReason.value = ''
  clockStart()
  nextTick(() => document.getElementById('work-title')?.focus())
}
function continueWithNextAction() {
  if (!nextAction.value.trim()) return
  startWork()
}
function finish() {
  clockStop()
  openPanel('finish')
}
async function save() {
  if (outcome.value === '受阻' && !blockReason.value.trim()) return
  const row = item.value
  row.status = progress.value === '已完成' ? '已完成' : '还要继续'
  row.actionStatus = outcome.value
  history.value.unshift({ id: row.id, title: row.actionTitle || row.title, task: row.task, time: timeText.value, outcome: outcome.value, progress: progress.value, notes: notes.value.trim(), reason: outcome.value === '受阻' ? blockReason.value.trim() : '' })
  day.value = row.day
  toast.value = '已记录 · 行动' + outcome.value + '，' + dates[row.day] + '的安排' + progress.value
  closePanel()
  stage.value = 'week'
  await nextTick()
  const trigger = document.querySelector('[data-item="' + row.id + '"]')
  trigger?.focus()
}
const currentRecords = computed(() => history.value.filter(record => record.id === active.value))
</script>

<template>
  <header class="top">
    <div class="brand"><ScanText :size="25" />截下来</div><span class="slash">/</span><span>{{ stage === 'week' ? '日程' : '工作' }}</span>
    <div class="demo-tools">
      <label>交互样板 <select v-model="scene" aria-label="示例数据" :disabled="stage !== 'week'" @change="reset"><option>空周</option><option>轻量周</option><option>繁忙周</option></select></label>
      <button class="icon" title="重置本页示例" aria-label="重置本页示例" :disabled="stage !== 'week'" @click="reset"><RotateCcw :size="15"/></button>
    </div>
  </header>
  <main v-if="stage === 'week'" class="canvas">
    <div class="mast">
      <div><p class="eyebrow">2026 年 11 月 · 北京时间</p><h1>这一周的日程</h1><p class="sub">11 月 23 日 — 29 日</p></div>
      <div class="week-count"><CalendarDays :size="17"/> {{ scheduled.length }} 项安排 <span>／</span> {{ deadlines.length }} 项截止</div>
    </div>
    <p role="status" class="saved" v-if="toast"><Check :size="16"/>{{ toast }}</p>
    <div class="desk">
      <section aria-label="七天日程" class="planner" :style="{ '--chosen': day + 1 }">
        <div class="date-axis">
          <button v-for="(name,i) in dates" :key="name" :class="{chosen: day === i}" :aria-label="dateLabel(i)" :aria-pressed="day === i" @click="day=i">
            <small>{{ name }}</small><strong>{{ 23+i }}</strong><i v-if="i === today" aria-label="示例中的今天"></i>
          </button>
        </div>
        <h2 class="band"><ListTodo/>每日工作</h2>
        <div class="grid-seven work-band">
          <div v-for="(_,i) in dates" :key="i" class="day-cell" :class="{chosen: i === day}">
            <button v-for="row in scheduled.filter(r=>r.day===i)" :key="row.id" class="entry" :class="{complete:row.status==='已完成'}" :data-item="row.id" @click="inspect(row)">
              <span class="entry-task">{{ row.task }}</span><strong>{{ row.title }}</strong>
              <small><Clock3 :size="12"/>{{ row.minutes }} 分钟</small><span v-if="row.status!=='待执行'" class="entry-state">{{ row.status }}</span>
            </button>
            <span v-if="!scheduled.some(r=>r.day===i)" class="blank-day"><span class="desktop-dash">—</span><span class="mobile-empty">当天没有安排</span></span>
          </div>
        </div>
        <h2 class="band due"><Flag/>每日截止</h2>
        <div class="grid-seven">
          <div v-for="(_,i) in dates" :key="i" class="day-cell" :class="{chosen: i === day}">
            <button v-for="due in deadlines.filter(d=>d.day===i)" :key="due.task" class="due-entry" @click="selectedTask=due.task;openPanel('source')"><small>{{ i < today ? '已逾期 · ' : '' }}{{ due.time }}</small><strong>{{ due.task }}</strong></button>
            <span v-if="!deadlines.some(d=>d.day===i)" class="blank-day"><span class="desktop-dash">—</span><span class="mobile-empty">当天没有截止</span></span>
          </div>
        </div>
      </section>
      <aside class="queue">
        <div class="section-line"><h2>待安排</h2><span>{{ backlog.length }}</span></div>
        <p class="quiet small">排入 {{ dateLabel(day) }}</p>
        <div v-for="row in backlog" :key="row.id" class="queue-row"><div><strong>{{ row.title }}</strong><small>{{ row.task }} · {{ row.minutes }} 分钟</small></div><button class="icon" :aria-label="'安排'+row.title" @click="add(row)"><Plus :size="17"/></button></div>
        <p v-if="!backlog.length" class="quiet">所有行动都有安排了。</p>
        <div class="section-line recent"><h2>最近工作</h2><span>{{ history.length }}</span></div>
        <p v-if="!history.length" class="quiet small">结束一次工作后，在这里回看成果。</p>
        <button v-for="(record,index) in history" :key="index" class="history-row" @click="active=record.id;openPanel('records')"><CheckCheck :size="16"/><span>{{ record.title }}<small>{{ record.outcome }} · {{ record.time }}</small></span></button>
      </aside>
    </div>
  </main>

  <main v-else class="canvas working">
    <p class="eyebrow">{{ item.task }} <span>／</span> {{ dateLabel(item.day) }}</p>
    <h1 id="work-title" tabindex="-1">{{ item.actionTitle || item.title }}</h1>
    <div class="timer-line"><span class="live-dot" :class="{paused:!running}"></span><strong>{{ timeText }}</strong><span>{{ running ? '正在计时' : '已暂停' }}</span>
      <button class="subtle" @click="running ? clockStop() : clockStart()"><component :is="running?Pause:Play" :size="15"/>{{ running?'暂停':'继续' }}</button>
      <button class="primary" @click="finish"><Square :size="13"/>结束本次</button></div>
    <div class="work-desk">
      <section><label for="note" class="section-line"><strong>本次成果</strong></label><textarea id="note" v-model="notes" placeholder="记下读到了什么，以及下次从哪里继续…" /></section>
      <aside><div class="section-line"><h2>参考资料</h2><FileText :size="17"/></div><h3>{{ materials[item.task].title }}</h3><p class="quiet">{{ materialText(item.task) }}</p></aside>
    </div>
  </main>

  <dialog ref="modal" :class="{drawer:panel==='detail'}" @cancel="panel=''" @click="event => { if(event.target===modal) closePanel() }" aria-labelledby="panel-title">
    <div class="dialog-inner">
      <header class="dialog-top"><span>{{ {detail:'安排详情',finish:'工作记录',date:'核对执行日期',records:'已保存的工作',source:'任务截止'}[panel] }}</span><button class="icon" aria-label="关闭" @click="closePanel"><X :size="18"/></button></header>
      <template v-if="panel==='detail' && item">
        <div class="kicker">{{ item.task }} <span>／</span> {{ item.status }}</div><h2 id="panel-title">{{ item.title }}</h2>
        <p class="meta"><CalendarDays/>{{ dateLabel(item.day) }} <span>·</span><Clock3/>{{ item.minutes }} 分钟</p>
        <div class="paper-note"><FileText :size="17"/><div><strong>{{ materials[item.task].title }}</strong><p>{{ materialText(item.task) }}</p></div></div>
        <form v-if="item.status==='还要继续' && item.actionStatus==='完成'" class="next-action" @submit.prevent="continueWithNextAction"><label class="reason">这项行动已完成。接下来做什么？<input v-model="nextAction" placeholder="下一项行动"></label><button class="primary" :disabled="!nextAction.trim()">开始下一项行动</button></form>
        <div class="dialog-foot"><button v-if="item.status!=='已完成' && item.actionStatus!=='完成'" class="primary" @click="startWork"><Play :size="15"/>开始工作</button><button v-if="currentRecords.length" class="subtle" @click="openPanel('records')">查看工作记录</button></div>
      </template>
      <template v-if="panel==='date'"><h2 id="panel-title">{{ item.day > today ? '提前开始这项工作？' : '今天继续这项工作？' }}</h2><p class="quiet">原安排在{{ dateLabel(item.day) }}。示例中的今天是周二，原安排日期保留。</p><div class="dialog-foot"><button class="subtle" @click="openPanel('detail')">返回</button><button class="primary" @click="dateChecked=true;startWork()">确认并开始</button></div></template>
      <template v-if="panel==='finish'"><h2 id="panel-title">结束这次工作</h2><p class="quiet">{{ item.actionTitle || item.title }} · 本次用时 {{ timeText }}</p>
        <fieldset><legend>这次行动做到了哪一步？</legend><div class="choices"><label v-for="v in ['完成','部分完成','受阻']" :key="v"><input type="radio" v-model="outcome" name="action" :value="v">{{ v }}</label></div></fieldset>
        <label v-if="outcome==='受阻'" class="reason">遇到了什么问题？<input v-model="blockReason" placeholder="写下卡点"></label>
        <fieldset><legend>{{ dates[item.day] }}的安排还要继续吗？</legend><div class="choices"><label v-for="v in ['还要继续','已完成']" :key="v"><input type="radio" v-model="progress" name="schedule" :value="v">{{ v }}</label></div></fieldset>
        <p class="small quiet">任务「{{ item.task }}」保持进行中。</p><div class="dialog-foot"><button class="subtle" @click="closePanel">返回工作</button><button class="primary" :disabled="outcome==='受阻' && !blockReason.trim()" @click="save">保存并回日程 <ArrowRight :size="15"/></button></div>
      </template>
      <template v-if="panel==='source'"><h2 id="panel-title">{{ selectedTask }}</h2><p class="meta"><Flag/>{{ dateLabel(deadlines.find(d=>d.task===selectedTask).day) }} · {{ deadlines.find(d=>d.task===selectedTask).time }}</p><div class="paper-note"><FileText :size="17"/><p>{{ materials[selectedTask].text }}</p></div></template>
      <template v-if="panel==='records'"><h2 id="panel-title">{{ item.task }} · 工作记录</h2><article v-for="(r,i) in currentRecords" :key="i" class="record"><strong>{{ r.title }}</strong><small>行动{{ r.outcome }} · 安排{{ r.progress }} · {{ r.time }}</small><p v-if="r.notes">{{ r.notes }}</p><p v-if="r.reason">卡点 · {{ r.reason }}</p></article></template>
    </div>
  </dialog>
</template>
