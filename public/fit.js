const BASE = 1220;
const root = document.documentElement;
function fit() {
  const w = window.innerWidth;
  const z = w < BASE ? Math.max(0.4, Math.floor(((w - 2) / BASE) * 1000) / 1000) : 1;
  root.style.zoom = z < 1 ? String(z) : '';
  root.classList.toggle('fit', z < 1);
  root.style.setProperty('--vp-h', Math.round(window.innerHeight / z) + 'px');
}
fit();
window.addEventListener('resize', fit);
