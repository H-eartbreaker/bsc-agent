// 版本提示：底栏右下角的版本号。只提示你自己仓库里有没有新版本，不会自动更新、替换或重启任何东西。
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (v) => 'v' + String(v || '').replace(/^v/i, '').replace(/(\.\d+)\.0$/, '$1');
const hm = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
let V = null, open = false;
const btn = $('#vmBtn'), pop = $('#vmPop');

async function load(refresh) {
  try { const r = await fetch(`/api/version${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' }); V = r.ok ? await r.json() : V; }
  catch { V = V && { ...V, error: '连不上本地服务' }; }
  paint();
}

function paint() {
  if (!V) return;
  const upd = V.hasUpdate;
  btn.innerHTML = `BSC Agent ${short(V.running || V.current)}${upd ? '<i class="vm-new">NEW</i>' : ''}`;
  btn.classList.toggle('on', open);
  ghPaint();
  btn.title = upd ? `你的仓库有新版本 ${V.latest}，点开查看` : '版本提示（只提示，不自动更新）';
  if (!open) return;
  const status = !V.configured ? '<span class="muted">未设置检查地址</span>'
    : V.error ? `<span class="r">${esc(V.error)}</span>`
    : !V.latest ? '<span class="muted">还没检查</span>'
    : upd ? `<span class="y">你的仓库有新版本 ${esc(short(V.latest))}</span>` : '<span class="g">已是最新版本</span>';
  pop.innerHTML = `
    <div class="vm-h"><b>版本提示</b>${upd ? '<i class="vm-new">NEW</i>' : ''}<span class="spacer"></span><button class="vm-x" data-vm-close>×</button></div>
    <div class="vm-line">当前版本 <b class="mono">${esc(short(V.current))}</b> · ${status}</div>
    <div class="vm-sub muted">${V.checkedAt ? `上次检查 ${hm(V.checkedAt)} · ` : ''}只检查你自己的仓库${V.repoUrl ? ` · <a href="${esc(V.repoUrl)}" target="_blank" rel="noopener">打开仓库</a>` : ''}</div>
    ${V.pendingRestart ? `<div class="vm-warn">代码已是 ${esc(short(V.current))}，服务还在跑 ${esc(short(V.running))}，重启后生效</div>` : ''}
    ${upd ? `<div class="vm-notes">${V.notes ? esc(V.notes).split('\n').filter(Boolean).map((l) => `<div class="vm-nl">${l}</div>`).join('') : '<div class="muted">（没有更新说明）</div>'}</div>
      <div class="vm-sub muted">这里不会自动更新。要更新：自己把新代码拿下来，再手动重启服务（data/、.env 不会被动）。</div>` : ''}
    ${V.configured ? '<div class="vm-btns"><button class="vm-b" data-vm-check>重新检查</button></div>' : '<div class="vm-sub muted">在 .env 里设置 BSC_AGENT_UPDATE_REPO=用户名/仓库名 才会检查。</div>'}`;
}

btn.addEventListener('click', () => { open = !open; pop.classList.toggle('hidden', !open); paint(); if (open && !V?.checkedAt) load(false); });
pop.addEventListener('click', (e) => {
  const t = e.target.closest('[data-vm-close],[data-vm-check]'); if (!t) return;
  if (t.dataset.vmClose != null) { open = false; pop.classList.add('hidden'); paint(); }
  else { t.textContent = '检查中…'; load(true); }
});
document.addEventListener('click', (e) => { if (open && !e.target.closest('#vmPop,#vmBtn')) { open = false; pop.classList.add('hidden'); paint(); } });
load(false); setInterval(() => load(false), 30 * 60_000);

// ---- 顶部 GitHub 图标：有新版本亮红点，并自动弹一次提示（点「本版不再提醒」就不再弹这个版本）----
const gh = $('#ghBtn'), seenKey = 'bsc-upd-dismissed';
const seen = () => { try { return localStorage.getItem(seenKey); } catch { return null; } };
function ghPaint() {
  if (!gh || !V) return;
  const upd = !!V.hasUpdate; gh.querySelector('.gh-dot')?.classList.toggle('hidden', !upd);
  gh.title = upd ? `GitHub 有新版本 ${short(V.latest)}，点这里查看` : 'GitHub：有新版本会提醒';
  if (upd && seen() !== V.latest && !document.querySelector('.gh-upd')) showUpd();
}
function showUpd() {
  document.querySelector('.ui-dlg-back.gh-upd')?.remove();
  const logo = gh?.querySelector('svg')?.outerHTML.replace(/width="22" height="22"/, 'width="18" height="18"') || '';
  const lines = String(V.notes || '').split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  const el = document.createElement('div'); el.className = 'ui-dlg-back gh-upd';
  el.innerHTML = `<div class="ui-dlg" role="dialog" aria-modal="true" aria-label="GitHub 有新版本">
    <div class="ui-h gh-h">${logo}<span>GitHub 有新版本</span><span class="gh-ver">${esc(short(V.running || V.current))} → <b>${esc(short(V.latest))}</b></span></div>
    <div class="ui-b">${lines.length ? `<div class="gh-list">${lines.map((l) => `<div><i></i>${esc(l)}</div>`).join('')}</div>` : '<p class="ui-note">作者没写更新说明。</p>'}
      <p class="ui-note">更新：在项目文件夹运行 <code>git pull</code> 和 <code>npm install</code>，再重启服务。只提醒，不会自动更新；钱包和设置（data/、.env）不会被动。</p></div>
    <div class="ui-f"><button class="ui-btn" data-g="later">稍后提醒</button><button class="ui-btn" data-g="skip">本版不再提醒</button><a class="ui-btn ok" href="${esc(V.repoUrl || 'https://github.com/H-eartbreaker/bsc-agent')}" target="_blank" rel="noopener">去 GitHub 看看</a></div></div>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-g]'); if (e.target === el || b?.dataset.g === 'later') return el.remove();
    if (b?.dataset.g === 'skip') { try { localStorage.setItem(seenKey, V.latest); } catch {} el.remove(); }
  });
  document.body.appendChild(el); requestAnimationFrame(() => el.classList.add('in'));
}
gh?.addEventListener('click', (e) => { if (V?.hasUpdate) { e.preventDefault(); showUpd(); } });
window.__updDemo = () => { V = { ...(V || {}), configured: true, hasUpdate: true, latest: '0.3.0', running: V?.running || '0.2.0', current: V?.current || '0.2.0', notes: '- 战壕卡片更清爽\n- GANG 历史 K 线补全\n- 新增 GitHub 新版本提醒', repoUrl: 'https://github.com/H-eartbreaker/bsc-agent' }; try { localStorage.removeItem(seenKey); } catch {} paint(); };
