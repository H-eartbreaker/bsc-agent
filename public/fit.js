// 窗口宽度 900–1220：整页等比缩小；< 900：所有页面改成「标签切换 + 单列」，不缩放。
const BASE = 1220;
const NARROW = 900;
const root = document.documentElement;
const pulse = document.getElementById('pulse');
const tabs = document.getElementById('pulseTabs');

function fit() {
  const w = window.innerWidth;
  const narrow = w < NARROW;
  const z = !narrow && w < BASE ? Math.max(0.4, Math.floor(((w - 2) / BASE) * 1000) / 1000) : 1;
  root.style.zoom = z < 1 ? String(z) : '';
  root.classList.toggle('fit', z < 1);
  root.classList.toggle('narrow', narrow);
  root.style.setProperty('--vp-h', Math.round(window.innerHeight / z) + 'px');
}

function pickTab(name) {
  if (!pulse || !tabs) return;
  pulse.dataset.pt = name;
  tabs.querySelectorAll('[data-pt]').forEach((b) => b.classList.toggle('active', b.dataset.pt === name));
}
if (pulse && tabs) {
  let saved = 'new';
  try { saved = localStorage.getItem('pulseTab') || 'new'; } catch {}
  pickTab(['new', 'soon', 'dex'].includes(saved) ? saved : 'new');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pt]'); if (!b) return;
    pickTab(b.dataset.pt);
    try { localStorage.setItem('pulseTab', b.dataset.pt); } catch {}
  });
  new MutationObserver(fit).observe(pulse, { attributes: true, attributeFilter: ['class'] });
}
const layout = document.querySelector('main.layout');
const tradeTabs = document.getElementById('tradeTabs');
function pickTv(name) {
  if (!layout || !tradeTabs) return;
  layout.dataset.tv = name;
  tradeTabs.querySelectorAll('[data-tv]').forEach((b) => b.classList.toggle('active', b.dataset.tv === name));
}
if (layout && tradeTabs) {
  pickTv('list');
  tradeTabs.addEventListener('click', (e) => { const b = e.target.closest('[data-tv]'); if (b) pickTv(b.dataset.tv); });
  const list = document.getElementById('tokenList');
  if (list) list.addEventListener('click', (e) => {
    if (root.classList.contains('narrow') && !e.target.closest('button, a, input, select')) pickTv('chart');
  });
  const sr = document.getElementById('searchResults');
  if (sr) sr.addEventListener('click', () => { if (root.classList.contains('narrow')) pickTv('chart'); });
}
fit();
window.addEventListener('resize', fit);
