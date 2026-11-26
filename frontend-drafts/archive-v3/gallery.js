document.querySelectorAll('[data-compare]').forEach(button=>button.addEventListener('click',()=>{
 const view=button.dataset.compare;
 document.querySelectorAll('[data-compare]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});
 document.querySelectorAll('[data-concept]').forEach(link=>{const key=link.dataset.concept;link.href=`app.html?concept=${key}&view=${view}`;const img=link.querySelector('img');img.style.display='block';img.src=`output/playwright/round3/${key}${view==='inbox'?'':'-'+view}.png`;img.alt=`${link.querySelector('h2').textContent} · ${button.textContent} 实际页面截图`;});
}));

document.querySelector('[data-grayscale]').addEventListener('click',event=>{const button=event.currentTarget,active=button.getAttribute('aria-pressed')!=='true';button.setAttribute('aria-pressed',String(active));button.classList.toggle('active',active);document.querySelector('.gallery-grid').classList.toggle('grayscale',active);});
