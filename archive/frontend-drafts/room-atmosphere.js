(() => {
  const stage = document.querySelector('#room-stage');
  if (!stage) return;

  const viewA = stage.querySelector('.window-view-a');
  const viewB = stage.querySelector('.window-view-b');
  const sun = stage.querySelector('.sun');
  const moon = stage.querySelector('.moon');
  const stars = stage.querySelector('.stars');
  const clock = document.querySelector('#room-time');
  const clockLabel = document.querySelector('#room-time-label');
  const modeName = document.querySelector('#mode-name');
  const modeDetail = document.querySelector('#mode-detail');
  const sceneCaption = document.querySelector('#scene-caption');
  const buttons = [...document.querySelectorAll('[data-demo-time]')];
  const liveButton = document.querySelector('[data-live-time]');
  const images = {
    dawn: 'assets/window-town-dawn-v1.webp',
    noon: 'assets/window-town-noon-v1.webp',
    dusk: 'assets/window-town-dusk-v1.webp',
  };
  const labels = { dawn: '清晨', noon: '正午', dusk: '傍晚', night: '夜间' };
  let activeView = viewA;
  let currentImage = '';
  let timer = 0;

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const minutesOf = date => date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);

  function timeFromText(text) {
    const [hours, minutes] = text.split(':').map(Number);
    return hours * 60 + minutes;
  }

  function modeFor(minutes) {
    if (minutes >= 300 && minutes < 600) return 'dawn';
    if (minutes >= 600 && minutes < 960) return 'noon';
    if (minutes >= 960 && minutes < 1200) return 'dusk';
    return 'night';
  }

  function paintView(image) {
    if (currentImage === image) return;
    const next = activeView === viewA ? viewB : viewA;
    next.style.backgroundImage = `url("${image}")`;
    next.style.opacity = '1';
    activeView.style.opacity = '0';
    activeView = next;
    currentImage = image;
  }

  function paintCelestials(minutes, mode) {
    const day = minutes / 1440;
    let sunOpacity = 0;
    let sunX = 50;
    let sunY = 12;
    let moonOpacity = 0;
    let moonX = 72;
    let moonY = 22;
    let starOpacity = 0;
    let roomLight = '#b9dceb';
    let lightOpacity = .13;

    if (minutes >= 480 && minutes < 600) {
      const t = smooth((minutes - 480) / 120);
      sunOpacity = lerp(0, .78, t);
      sunX = lerp(12, 38, t);
      sunY = lerp(82, 48, t);
      roomLight = '#d4c28d';
      lightOpacity = lerp(.1, .18, t);
    } else if (minutes >= 600 && minutes < 960) {
      const t = (minutes - 600) / 360;
      sunOpacity = 1;
      sunX = lerp(42, 67, t);
      sunY = lerp(23, 29, t);
      roomLight = '#f0c47e';
      lightOpacity = .2;
    } else if (minutes >= 960 && minutes < 1200) {
      const t = (minutes - 960) / 240;
      sunOpacity = clamp(1 - t * 1.35);
      sunX = lerp(78, 108, t);
      sunY = lerp(33, 82, t);
      roomLight = '#e49c72';
      lightOpacity = lerp(.22, .12, t);
      moonOpacity = clamp((t - .55) / .45) * .65;
      moonX = lerp(76, 58, t);
      moonY = lerp(24, 18, t);
      starOpacity = clamp((t - .72) / .28) * .65;
    } else {
      const t = minutes < 300 ? (minutes + 240) / 300 : (minutes - 1200) / 300;
      moonOpacity = .9;
      moonX = lerp(72, 43, clamp(t));
      moonY = lerp(22, 15, clamp(t));
      starOpacity = .86;
      roomLight = '#526f9a';
      lightOpacity = .27;
    }

    if (mode === 'dawn') { moonOpacity = 0; starOpacity = 0; }
    if (mode === 'noon') { moonOpacity = 0; starOpacity = 0; }
    if (mode === 'dusk') { starOpacity = 0; }
    if (mode === 'night') { sunOpacity = 0; }

    sun.style.opacity = String(sunOpacity);
    sun.style.left = `${sunX}%`;
    sun.style.top = `${sunY}%`;
    sun.style.transform = `translate(-50%,-50%) scale(${sunOpacity ? 1 : .8})`;
    moon.style.opacity = String(moonOpacity);
    moon.style.left = `${moonX}%`;
    moon.style.top = `${moonY}%`;
    moon.style.transform = `translate(-50%,-50%) scale(${moonOpacity ? 1 : .8})`;
    stars.style.opacity = String(starOpacity);
    stage.style.setProperty('--room-light', roomLight);
    stage.querySelector('.room-light-layer').style.opacity = String(lightOpacity);
  }

  function update(minutes, source) {
    const mode = modeFor(minutes);
    const hour = Math.floor(minutes / 60) % 24;
    const minute = Math.floor(minutes % 60);
    const timeText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const image = images[mode === 'night' ? 'dusk' : mode];
    paintView(image);
    paintCelestials(minutes, mode);
    stage.dataset.time = mode;
    stage.dataset.mode = source;
    clock.textContent = timeText;
    clockLabel.textContent = source === 'live' ? '本地系统时间' : '审查时间（演示）';
    modeName.textContent = source === 'live' ? `跟随真实时间 · ${labels[mode]}` : `${labels[mode]} · ${timeText}`;
    modeDetail.textContent = mode === 'night' ? '月亮与星星已显现，室内进入冷蓝夜色' : '窗景底图、天体和室内色调分层运行';
    sceneCaption.textContent = `${source === 'live' ? '本地时间' : '演示时间'} ${timeText} · ${labels[mode]} · 窗户保持打开`;
    buttons.forEach(button => button.classList.toggle('active', source !== 'live' && button.dataset.demoTime === timeText));
    liveButton.classList.toggle('active', source === 'live');
  }

  function tick() {
    update(minutesOf(new Date()), 'live');
  }

  buttons.forEach(button => button.addEventListener('click', () => {
    window.clearInterval(timer);
    update(timeFromText(button.dataset.demoTime), 'demo');
  }));
  liveButton.addEventListener('click', () => {
    window.clearInterval(timer);
    tick();
    timer = window.setInterval(tick, 15000);
  });

  tick();
  timer = window.setInterval(tick, 15000);
})();
