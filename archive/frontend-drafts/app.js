const concepts = {
  signal: { name: '酸性编辑部', en: 'SIGNAL', no: '01', initial: 'today' },
  orbit: { name: '午夜轨道', en: 'ORBIT', no: '02', initial: 'focus' },
  paper: { name: '纸上档案', en: 'ARCHIVE', no: '03', initial: 'inbox' },
  desktop: { name: '灵感桌面', en: 'PLAYGROUND', no: '04', initial: 'inbox' },
};
const param = new URLSearchParams(location.search).get('concept') || document.documentElement.dataset.concept;
const concept = concepts[param] ? param : 'signal';
const config = concepts[concept];
document.body.className = `workspace ${concept}`;
document.title = `截下来 · ${config.name}`;
const icons = {
  today: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h3m3 0h3"/>',
  inbox: '<path d="m3 13 3-9h12l3 9v7H3Z"/><path d="M3 13h5l2 3h4l2-3h5"/>',
  focus: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  file: '<path d="M14 2H5v20h14V7Z M14 2v6h5M8 12h8m-8 4h6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const esc = value => String(value).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const notes = [
  { title: '机器学习课程报告', category: '课程通知', date: '今天 09:42', desc: '提交课程报告，包含方法介绍、实验设置与结果分析。', raw: '请于 2026 年 11 月 22 日前提交机器学习课程报告。报告需包含方法介绍、实验设置与结果分析。请将 PDF 文件上传至课程平台。', requirements: '方法介绍、实验设置、结果分析', deadline: '2026 年 11 月 22 日', submit: '课程平台 · PDF 文件', tag: '要求' },
  { title: '报告评分标准补充', category: '评分标准', date: '今天 09:38', desc: '实验对比占 40%，关注消融实验和可复现性。', raw: '课程报告评分补充：实验对比占 40%，重点关注消融实验和可复现性。代码附录可作为补充材料。', requirements: '实验对比、消融实验与可复现性', deadline: null, submit: '未在原文提及', tag: '补充' },
  { title: '论文阅读：注意力机制', category: '学习资料', date: '昨天 18:20', desc: '整理注意力机制的核心公式与实现步骤。', raw: '阅读笔记：注意力机制通过 Query、Key 和 Value 计算加权结果。先理解缩放点积，再阅读多头注意力实现。', requirements: '理解缩放点积与多头注意力', deadline: null, submit: '未在原文提及', tag: '参考' },
];
const state = { view: config.initial, selected: 0, confirmed: {}, done: new Set(), created: false, raw: true, seconds: 1500, running: false, draft: '', focusTask: '列出课程报告提纲', filter: '', tempNotes: [], tab: 'all' };
const tasks = [
  { title: '列出课程报告提纲', project: '机器学习课程报告', time: '30 分钟', due: '11.22 截止' },
  { title: '复习条件概率与贝叶斯公式', project: '概率论期末复习', time: '45 分钟', due: '11.25 截止' },
  { title: '整理第一组实验数据', project: '研究实验', time: '45 分钟', due: '无截止时间' },
];
function studio() {
  return `<div class="studio-bar"><a href="index.html">↖ 全部方案</a><div class="concept-tabs">${Object.entries(concepts).map(([key,c]) => `<a href="app.html?concept=${key}" class="${key === concept ? 'active' : ''}" ${key === concept ? 'aria-current="page"' : ''}><span>${c.no}</span> ${c.name}</a>`).join('')}</div><span class="studio-note">视觉草案 · 演示数据</span></div>`;
}
function nav() {
  return `<a class="brand app-brand" href="index.html"><span class="brand-mark">截</span><span>截下来<small>${concept === 'desktop' ? 'PERSONAL WORKSPACE' : 'CAPTURE → ACTION'}</small></span></a><nav aria-label="工作区">${[['today','今天','01'],['inbox','收集箱','02'],['focus','专注','03']].map(([key,label,no])=>`<button data-view="${key}" class="nav-item ${state.view === key ? 'selected' : ''}" ${state.view === key ? 'aria-current="page"' : ''}>${icon(key)}<span>${label}</span><small>${no}</small></button>`).join('')}</nav><button class="add-button" data-action="add">${icon('plus')}<span>添加内容</span><kbd>＋</kbd></button><div class="sidebar-bottom"><span class="demo-dot"></span> 示例工作空间<small>本页临时演示 · 刷新重置</small><div class="user-avatar">J</div><span>我的工作空间 <b>↗</b></span></div>`;
}
function shell() {
  document.getElementById('app').innerHTML = `${studio()}<div class="app-shell"><aside class="sidebar">${nav()}</aside><main class="main-area"><header class="page-top"><div>${state.view === 'today' ? '工作空间 / 今天' : state.view === 'inbox' ? '资料库 / 收集箱' : '工作空间 / 专注'}</div><span><i></i> 演示数据 <span class="top-date">2026.11.18 · 星期三</span></span></header><div id="view"></div></main></div><dialog id="capture"><form id="capture-form"><div class="dialog-head"><span class="eyebrow">CAPTURE SOMETHING</span><button type="button" data-action="close-modal" class="icon-button" aria-label="关闭">${icon('close')}</button></div><h2>先收下来。</h2><p>添加文字或一张图片，放入当前演示收集箱。</p><label for="capture-text">文字内容</label><textarea id="capture-text" placeholder="粘贴一条通知、一段灵感，或一个想做的事…" rows="5"></textarea><label class="upload-label" for="capture-image">${icon('plus')} 选择图片 <small>PNG / JPG / WebP，最大 10 MB</small></label><input type="file" id="capture-image" accept="image/png,image/jpeg,image/webp"><div id="file-preview"></div><p class="demo-caption">仅在当前页面临时展示，不上传、不分析；刷新后清除。</p><button class="primary" type="submit">添加到演示收集箱 ${icon('arrow')}</button></form></dialog>`;
  renderView();
}
function taskRows() {
  return tasks.map((task, i)=>`<div class="task-row ${state.done.has(i) ? 'complete' : ''}"><button class="checkbox" data-done="${i}" aria-label="${state.done.has(i) ? '恢复' : '完成'}今日计划：${task.title}" aria-pressed="${state.done.has(i)}">${state.done.has(i) ? icon('check') : ''}</button><span class="task-index">0${i+1}</span><div class="task-info"><h3>${task.title}</h3><p>${task.project} <span>·</span> ${task.due}</p></div><span class="task-time">${task.time}</span><button class="task-start" data-start="${i}" aria-label="开始：${task.title}">${icon('arrow')}</button></div>`).join('');
}
function today() {
  const count = state.done.size;
  return `<section class="today-page"><div class="today-heading"><div><p class="eyebrow">WEDNESDAY, NOVEMBER 18</p><h1>${concept === 'signal' ? '今天，<br>推进一点。' : '今天，先做好这一件。'}</h1></div><div class="day-art" aria-hidden="true"><span>18</span><b>✳</b><small>NOVEMBER / 2026</small></div></div><div class="today-body"><div class="today-primary"><div class="section-label"><h2>今日计划 <span>${3-count} 待完成</span></h2><span>每天一点，刚刚好。</span></div><div class="task-list">${taskRows()}</div>${state.created ? '<div class="continue-strip"><div><small>新建的演示任务 · 尚未安排到今日计划</small><h3>完成课程报告</h3><p>11.22 截止 · 工时待填写 · 来源：已确认的课程通知</p></div></div>' : ''}<p class="plan-note">${icon('today')} 完成的是今日计划条目，任务仍可继续推进。</p><div class="continue-strip"><span class="continue-icon">↳</span><div><small>接着上次的思路</small><h3>课程报告 · 提纲草稿</h3><p>已写下 3 个要点，下一步补充实验对比。</p></div><button data-start="0" class="text-button">继续工作 ↗</button></div></div><aside class="today-aside"><div class="progress-block"><p class="eyebrow">TODAY'S MOMENTUM</p><strong>${String(count).padStart(2,'0')}<span>/03</span></strong><div class="progress-track"><i style="width:${count/3*100}%"></i></div><p>计划条目已完成</p></div><div class="review-callout"><span>还有一点需要你确认</span><h3>让下一步，<br>更有把握。</h3><p>收集箱里有 1 份课程通知，<br>截止时间和要求待核对。</p><button class="text-button" data-view="inbox">去核对 ${icon('arrow')}</button></div></aside></div><footer class="workspace-footer"><span>不必完成所有事。先开始一件事。</span><span>MAKE ROOM FOR WHAT MATTERS. ↗</span></footer></section>`;
}
function reviewContent() {
  const note = [...notes, ...state.tempNotes][state.selected];
  const confirmed = state.confirmed[state.selected] || {};
  if (state.selected >= notes.length) return `<div class="review-heading"><p class="eyebrow">CAPTURE / TEMPORARY</p><h2>${esc(note.title)}</h2><span class="status">仅临时收集 · 未分析</span></div><p class="temp-content">${esc(note.raw)}</p>${note.image ? `<img class="uploaded-image" src="${note.image}" alt="临时收集的原始图片">` : ''}<p class="demo-caption">当前草案未接入识别与保存，此内容刷新后清除。</p>`;
  const fields = [{key:'requirements',label:'报告要求',value:note.requirements},{key:'deadline',label:'截止日期',value:note.deadline},{key:'submit',label:'提交方式',value:note.submit === '未在原文提及' ? null : note.submit}];
  const used = fields.filter(f=>f.value);
  const ready = used.every(f=>confirmed[f.key]);
  return `<div class="review-heading"><p class="eyebrow">NOTE / ${String(state.selected+1).padStart(3,'0')}</p><div class="review-title"><h2>${note.title}</h2><span class="status">${ready ? '已确认所用字段' : '待核对'}</span></div><p>${note.desc}</p><div class="note-meta"><span>${note.category}</span><span>机器学习课程报告 / ${note.tag}</span></div></div><div class="review-columns"><div class="fields-panel"><div class="section-label"><h3>行动信息</h3><small>AI 示例提取 · 请逐项核对</small></div>${fields.map(f=>`<div class="field"><div><span>${f.label}</span><small>${f.value ? (confirmed[f.key] ? '✓ 已人工确认' : '原文提取 · 待确认') : '原文未提及'}</small></div><p>${f.value || '—'}</p>${f.value ? `<button class="confirm-button ${confirmed[f.key] ? 'confirmed' : ''}" data-confirm="${f.key}" aria-pressed="${!!confirmed[f.key]}">${confirmed[f.key] ? '已确认 ✓' : '确认此项'}</button>` : ''}</div>`).join('')}<div class="source-footnote">${icon('file')} 确认保留原文出处，不改变信息来源。</div><button class="primary create-task" ${state.selected !== 0 ? 'hidden' : ''} data-action="create-task" ${!ready || state.created ? 'disabled' : ''}>${state.created ? '已加入演示任务 ✓' : '从已确认信息建立任务'} ${icon('arrow')}</button><p class="demo-caption">${state.selected !== 0 ? '参考资料可供对照；建任务请选课程通知示例。' : state.created ? '演示任务已出现在「今天」，刷新后重置。' : ready ? '仅带入上方已确认字段；不持久保存。' : '先确认以上所有有值字段，再创建演示任务。'}</p></div><div class="source-panel"><div class="section-label"><h3>原始资料</h3><button class="text-button" data-action="toggle-raw" aria-expanded="${state.raw}">${state.raw ? '收起 −' : '展开 ＋'}</button></div>${state.raw ? `<div class="source-document"><div class="document-header">课程平台 <span>通知公告</span></div><small>2026 / 11 / 16 · 虚构示例</small><h3>${note.title}</h3><p>${note.raw}</p><div class="document-rule"></div><small>本资料为视觉草案专用示例<br>不是实时识别结果</small><span class="source-seal">原文</span></div><p class="source-caption">原始文字 · 与左侧信息对照核验</p>` : '<div class="source-collapsed">原文已收起，可随时展开核对。</div>'}</div></div>`;
}
function inbox() {
  const allNotes = [...notes,...state.tempNotes];
  const filtered = allNotes.map((n,i)=>({...n,i})).filter(n=>(!state.filter || `${n.title}${n.raw}`.includes(state.filter)) && (state.tab !== 'pending' || (n.i === 0 && !state.created)));
  return `<section class="inbox-page"><div class="inbox-heading"><div><p class="eyebrow">${concept === 'paper' ? 'THE PERSONAL ARCHIVE / VOL. 01' : 'A HOME FOR YOUR INFORMATION'}</p><h1>${concept === 'desktop' ? '我的资料桌面<span>✦</span>' : '收集箱'}<small>${String(allNotes.length).padStart(2,'0')}</small></h1></div><button class="text-button" data-action="add">收下一点新东西 ${icon('plus')}</button></div>${concept === 'desktop' ? `<div class="desktop-surface"><div class="desktop-greeting">好想法，值得被看见。<span>把散落的信息，放回自己的节奏里。</span></div><div class="sticky-note" tabindex="0" aria-label="演示便签，可用鼠标拖动"><div class="sticky-handle">NEXT LITTLE THING <span>↗</span></div><p>不用一口气<br>完成整份报告。</p><b>先列一个提纲。</b><small>从小小的一步开始。 ✳</small></div>` : ''}<div class="inbox-workbench"><aside class="note-list"><div class="window-title">${concept === 'desktop' ? '<span class="window-dots">● ● ●</span>' : icon('inbox')}<span>所有资料</span><small>${allNotes.length}</small></div><label class="search-box">${icon('search')}<input type="search" id="note-search" placeholder="搜索资料…" value="${esc(state.filter)}" aria-label="搜索资料"></label><div class="list-tabs"><button data-filter="all" class="${state.tab==='all'?'active':''}">全部</button><button data-filter="pending" class="${state.tab==='pending'?'active':''}">待核对 <span>${state.created ? 0 : 1}</span></button></div><div class="notes">${filtered.map(n=>`<button class="note-item ${n.i === state.selected ? 'active' : ''}" data-note="${n.i}" ${n.i===state.selected ? 'aria-current="true"' : ''}><span class="note-type">${n.category} <span>↗</span></span><h3>${esc(n.title)}</h3><p>${esc(n.desc)}</p><small>${n.date} <b>${n.tag}</b></small></button>`).join('') || '<p class="empty-state">没有符合条件的资料。</p>'}</div><div class="list-bottom">${icon('file')} 资料与行动，放在一起。</div></aside><article class="review-pane">${reviewContent()}</article></div>${concept === 'desktop' ? '</div>' : ''}<footer class="workspace-footer"><span>保存信息，也保留它的来处。</span><span>${config.en} / CAPTURE → ACTION</span></footer></section>`;
}
function focus() {
  return `<section class="focus-page"><div class="focus-heading"><div><p class="eyebrow">ONE THING AT A TIME</p><h1>现在，只做这一件。</h1></div><span class="focus-mode"><i></i> ${state.running ? '专注中' : '准备就绪'}</span></div><div class="focus-layout"><div class="focus-center"><p class="focus-project">机器学习课程报告 <span> / 下一步行动</span></p><h2>${esc(state.focusTask)}</h2><div class="timer-orbit"><svg class="timer-ring" viewBox="0 0 360 360" aria-hidden="true"><circle cx="180" cy="180" r="168"/><circle id="timer-progress" cx="180" cy="180" r="168" stroke-dasharray="1056" stroke-dashoffset="${1056*(1-state.seconds/1500)}"/></svg><span class="orbit-point"></span><div class="timer-inner"><p class="eyebrow">FOCUS SESSION / 01</p><strong id="time" role="timer" aria-label="剩余专注时间">${formatTime()}</strong><span id="timer-status">${state.running ? '保持这一刻的专注' : '给自己一段完整的时间'}</span></div></div><div class="timer-controls"><button class="primary timer-toggle" data-action="timer">${icon(state.running?'pause':'play')}<span>${state.running ? '暂停计时' : state.seconds===1500 ? '开始专注' : '继续专注'}</span></button><button class="reset-button" data-action="reset-timer">重置</button></div><p class="focus-tip">一个小步骤，也是一段真实的进展。</p></div><aside class="focus-context"><div class="section-label"><h3>随手记下</h3><span>01 / NOTES</span></div><label class="sr-only" for="focus-notes">本次专注记录</label><textarea id="focus-notes" placeholder="思路不用完美，先记下来。&#10;&#10;· 方法介绍&#10;· 实验设置&#10;· 结果分析">${esc(state.draft)}</textarea><div class="notes-status">当前页面临时草稿 · 刷新后重置</div><div class="focus-reference"><div class="section-label"><h3>手边的资料</h3><span>02 / SOURCES</span></div><button data-view="inbox">${icon('file')}<span>课程报告要求<small>3 项信息可对照原文</small></span>${icon('arrow')}</button><button data-note-open="1">${icon('file')}<span>评分标准补充<small>实验对比 · 可复现性</small></span>${icon('arrow')}</button></div><div class="focus-quote">“ 把注意力放回<br>能开始的那一步。”</div></aside></div><footer class="workspace-footer"><span>所有计时和记录仅供本页演示。</span><span>LESS NOISE. MORE FOCUS. ↗</span></footer></section>`;
}
function renderView() {
  document.querySelectorAll('[data-view]').forEach(button=>{button.classList.toggle('selected',button.dataset.view===state.view); if(button.classList.contains('nav-item'))button.setAttribute('aria-current',button.dataset.view===state.view?'page':'false');});
  document.getElementById('view').innerHTML = state.view === 'today' ? today() : state.view === 'inbox' ? inbox() : focus();
  document.querySelector('.page-top > div').textContent = state.view === 'today' ? '工作空间 / 今天' : state.view === 'inbox' ? '资料库 / 收集箱' : '工作空间 / 专注';
  if (concept === 'desktop') setupDrag();
}
function formatTime() { return `${String(Math.floor(state.seconds/60)).padStart(2,'0')}:${String(state.seconds%60).padStart(2,'0')}`; }
let toastTimeout;
function toast(message) { const el=document.getElementById('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.remove('show'),3200); }
function switchView(view) { state.view=view;renderView(); }
document.addEventListener('click', event=>{
  const el=event.target.closest('button');if(!el)return;
  if(el.dataset.view) switchView(el.dataset.view);
  if(el.dataset.note!==undefined){state.selected=Number(el.dataset.note);renderView();}
  if(el.dataset.noteOpen){state.selected=Number(el.dataset.noteOpen);switchView('inbox');}
  if(el.dataset.done!==undefined){const id=Number(el.dataset.done);state.done.has(id)?state.done.delete(id):state.done.add(id);renderView();toast('今日计划状态已更新；整个任务状态保持不变。');}
  if(el.dataset.start!==undefined){if(state.running){toast('请先到专注页暂停当前计时，再切换行动。');switchView('focus');return;}state.focusTask=tasks[Number(el.dataset.start)].title;state.seconds=1500;switchView('focus');}
  if(el.dataset.confirm){const key=el.dataset.confirm;state.confirmed[state.selected] ||= {};state.confirmed[state.selected][key]=!state.confirmed[state.selected][key];renderView();}
  if(el.dataset.filter){state.tab=el.dataset.filter;renderView();}
  switch(el.dataset.action){
    case 'add': document.getElementById('capture').showModal();break;
    case 'close-modal': document.getElementById('capture').close();break;
    case 'toggle-raw': state.raw=!state.raw;renderView();break;
    case 'create-task': if(!el.disabled){state.created=true;renderView();toast('演示任务已建立，可到「今天」查看；刷新后重置。');}break;
    case 'timer': state.running=!state.running;renderView();break;
    case 'reset-timer': state.running=false;state.seconds=1500;renderView();break;
  }
});
document.addEventListener('input',event=>{
  if(event.target.id==='focus-notes')state.draft=event.target.value;
  if(event.target.id==='note-search'){const input=event.target;const pos=input.selectionStart;state.filter=input.value;renderView();const next=document.getElementById('note-search');next.focus();try{next.setSelectionRange(pos,pos);}catch{}}
});
let imageUrl=null;
document.addEventListener('change', event=>{
  if(event.target.id!=='capture-image')return;
  if(imageUrl){URL.revokeObjectURL(imageUrl);imageUrl=null;}
  document.getElementById('file-preview').replaceChildren();
  const file=event.target.files[0];if(!file)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024){event.target.value='';toast('请选择 10 MB 以内的 PNG、JPG 或 WebP 图片。');return;}
  imageUrl=URL.createObjectURL(file);
  const img=document.createElement('img');img.src=imageUrl;img.alt='所选图片预览';document.getElementById('file-preview').append(img);
});
document.addEventListener('submit',event=>{
  if(event.target.id!=='capture-form')return;event.preventDefault();
  const text=document.getElementById('capture-text').value.trim();const file=document.getElementById('capture-image').files[0];
  if(!text&&!file){toast('先输入文字或选择一张图片。');return;}
  state.tempNotes.push({title:text?text.slice(0,24):file.name,raw:text||'图片仅作临时展示，尚未分析。',desc:text||'临时收集的图片',category:'临时收集',date:'刚刚',tag:'未分析',image:imageUrl});imageUrl=null;
  state.selected=notes.length+state.tempNotes.length-1;state.filter='';state.tab='all';document.getElementById('capture').close();event.target.reset();document.getElementById('file-preview').replaceChildren();switchView('inbox');toast('已放入演示收集箱，仅在当前页面保留。');
});
let lastTick=Date.now();
setInterval(()=>{const now=Date.now();const elapsed=Math.floor((now-lastTick)/1000);if(elapsed<1)return;lastTick+=elapsed*1000;if(!state.running)return;state.seconds=Math.max(0,state.seconds-elapsed);if(!state.seconds){state.running=false;toast('本次专注时间结束，任务不会自动标记完成。');renderView();}const time=document.getElementById('time');if(time)time.textContent=formatTime();const progress=document.getElementById('timer-progress');if(progress)progress.style.strokeDashoffset=1056*(1-state.seconds/1500);},250);
function setupDrag(){
  const sticky=document.querySelector('.sticky-note');if(!sticky)return;
  sticky.addEventListener('pointerdown',event=>{if(event.button!==0)return;const startX=event.clientX,startY=event.clientY;const surface=sticky.parentElement;const before=sticky.getBoundingClientRect();const bounds=surface.getBoundingClientRect();sticky.setPointerCapture(event.pointerId);sticky.classList.add('dragging');const move=e=>{const x=Math.max(0,Math.min(bounds.width-before.width,before.left-bounds.left+e.clientX-startX));const y=Math.max(0,Math.min(bounds.height-before.height,before.top-bounds.top+e.clientY-startY));sticky.style.left=x+'px';sticky.style.top=y+'px';sticky.style.right='auto';sticky.style.transform='rotate(0deg)';};const stop=()=>{sticky.removeEventListener('pointermove',move);sticky.classList.remove('dragging');};sticky.addEventListener('pointermove',move);sticky.addEventListener('pointerup',stop,{once:true});sticky.addEventListener('pointercancel',stop,{once:true});});
}
shell();
