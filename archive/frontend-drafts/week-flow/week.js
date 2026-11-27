// 固定演示周。数据只在本页内使用，刷新后仍可重看三个步骤。
const week = ['一','二','三','四','五','六','日'];
const project = '机器学习课程报告';
const proposed = [
  {day:1,title:'整理实验数据',minutes:40},
  {day:2,title:'核对三组实验结果并补全误差分析表',minutes:45},
  {day:2,title:'画对比图',minutes:25},
  {day:2,title:'写结果段落',minutes:35},
  {day:3,title:'校对引用与图注',minutes:30}
].map(item=>({...item,project}));
const existing = [
  {day:2,title:'读综述引言',minutes:20,project:'文献综述',deadline:'12 月 2 日截止',existing:true},
  {day:2,title:'整理讨论纪要',minutes:15,project:'小组讨论',existing:true}
];
const deadline = {day:4,title:project,clock:'18:00',due:true};
const total = proposed.reduce((sum,item)=>sum+item.minutes,0);
const busyDays = [...new Set(proposed.map(item=>item.day))];
const app = document.querySelector('#app');
const dialog = document.querySelector('#detail');
let selectedDay = 3;
function row(item){
  return '<div class="row"><strong>'+item.title+'</strong><span class="duration">'+item.minutes+' 分钟</span></div>';
}
function dayGroup(day,preview){
  const kept = existing.filter(item=>item.day===day);
  const extra = preview && kept.length ? '<details><summary>当天已有 '+kept.length+' 项工作</summary>'+kept.map(item=>'<p>'+item.title+' · '+item.minutes+' 分钟</p>').join('')+'</details>' : '';
  return '<section class="day"><h2>11.'+(23+day)+'<small>周'+week[day]+'</small></h2><div>'+proposed.filter(item=>item.day===day).map(row).join('')+extra+'</div></section>';
}
function heading(kicker,title,subtitle,action=''){
  return '<div class="edition">'+kicker+'</div><div class="heading"><div><h1 tabindex="-1">'+title+'</h1><p>'+subtitle+'</p></div>'+action+'</div>';
}
function preview(){
  return heading('规划助手 / 预览',project,'11 月 23 日—29 日 · 3 天 · 预计 '+total+' 分钟','<button class="primary" data-go="confirm">核对采用清单 →</button>')+
    '<div class="preview-grid"><div>'+busyDays.map(day=>dayGroup(day,true)).join('')+'<p class="emptyline">周一、周五至周日无新增工作</p></div><aside class="aside"><h2>交付时间</h2><p class="due">周五 11 月 27 日 · 18:00</p><p class="meta">提交课程报告</p></aside></div>';
}
function confirm(){
  return '<div class="confirm">'+heading('规划助手 / 确认采用','加入本周日程',project+' · 新增 '+proposed.length+' 项工作 · '+total+' 分钟')+
    busyDays.map(day=>dayGroup(day,false)).join('')+
    '<section class="day"><h2>11.27<small>周五</small></h2><div class="row"><strong>提交课程报告</strong><span class="duration">18:00 截止</span></div></section>'+
    '<div class="confirm-foot"><button class="text-btn" data-go="preview">← 返回预览</button><button class="primary" data-go="schedule">采用计划并查看日程</button></div></div>';
}
const allWork = [...proposed,...existing];
function eventButton(item,index){
  const caption = item.due ? '18:00 截止' : item.project+' · '+item.minutes+' 分钟'+(item.deadline?' · '+item.deadline:'');
  return '<button class="event '+(item.due?'due':item.existing?'existing':'')+'" data-item="'+index+'"><strong>'+item.title+'</strong><em>'+caption+'</em></button>';
}
function band(name,isDue){
  return '<h2 class="band-title">'+name+'</h2><div class="band">'+week.map((_,day)=>{
    const entries = isDue ? (day===deadline.day?eventButton(deadline,allWork.length):'') : allWork.map((item,index)=>item.day===day?eventButton(item,index):'').join('');
    return '<div class="cell '+(day===selectedDay?'selected':'')+'">'+(entries||'<small class="mobile-day">'+(isDue?'当天无截止':'当天无工作')+'</small>')+'</div>';
  }).join('')+'</div>';
}
function schedule(){
  return '<div class="calendar">'+heading('日程 / 2026 年 11 月','11.23 — 11.29','本周 '+allWork.length+' 项工作 · 1 项截止 · 北京时间')+
    '<div class="axis" role="group" aria-label="选择日期">'+week.map((wd,day)=>'<button aria-label="周'+wd+'，'+(23+day)+'日，'+allWork.filter(item=>item.day===day).length+'项工作，'+(day===4?1:0)+'项截止" aria-pressed="'+(day===selectedDay)+'" data-day="'+day+'"><span>'+(day===3?'今天':'周'+wd)+'</span><b>'+(23+day)+'</b></button>').join('')+'</div>'+
    '<h2 class="mobile-day">周'+week[selectedDay]+'的安排</h2>'+band('每日工作',false)+band('每日截止',true)+
    '<div class="confirm-foot"><p class="week-note">本周含 2 项原有工作</p><button class="text-btn" data-go="preview">重看样稿</button></div></div>';
}
function render(focusHeading=false){
  const page=location.hash.slice(1);
  document.querySelector('#section').textContent=page==='schedule'?'日程':'规划助手';
  app.innerHTML=page==='schedule'?schedule():page==='confirm'?confirm():preview();
  if(focusHeading){app.querySelector('h1').focus({preventScroll:true});window.scrollTo(0,0);}
}
app.addEventListener('click',event=>{
  const button=event.target.closest('button');
  if(!button)return;
  if(button.dataset.go){location.hash=button.dataset.go;return;}
  if(button.hasAttribute('data-day')){
    selectedDay=Number(button.dataset.day);render();app.querySelector('[data-day="'+selectedDay+'"]').focus({preventScroll:true});return;
  }
  if(button.hasAttribute('data-item')){
    const item=[...allWork,deadline][Number(button.dataset.item)];
    const description=item.due?'周五 11 月 27 日 · 18:00 截止':'周'+week[item.day]+' · 预计 '+item.minutes+' 分钟 · '+item.project;
    document.querySelector('#detail-body').innerHTML='<p class="edition">'+(item.due?'任务截止':'工作安排')+'</p><h2 id="detail-title">'+item.title+'</h2><p>'+description+'</p>'+(item.deadline?'<p>'+item.deadline+'</p>':'');
    dialog.showModal();
  }
});
window.addEventListener('hashchange',()=>render(true));
render();
