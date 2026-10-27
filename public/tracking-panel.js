const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '未知钱包';
const num = n => n != null && Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US', {maximumFractionDigits: 6}) : '—';
const elapsed = ts => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? `${Math.floor(s)}秒前` : s < 3600 ? `${Math.floor(s / 60)}分钟前` : s < 86400 ? `${Math.floor(s / 3600)}小时前` : `${Math.floor(s / 86400)}天前`; };
export const actionLabel = r => ({open:'建仓', add:'加仓', reduce:'减仓', close:'清仓', buy:'买入', sell:'卖出'}[r.action] || r.action || (r.side === 'buy' ? '买入' : '卖出'));
export function filteredFeed(feed, wallet = '', min = 0) {
  return feed.filter(r => (!wallet || r.target?.toLowerCase() === wallet.toLowerCase()) && (!min || Number(r.bnb) >= min));
}
export function feedMarkup(rows) {
  return rows.map(r => `<article class="wt-event"><div class="wt-event-top"><span class="wt-action ${r.side === 'buy' ? 'g' : 'r'}">${escapeHtml(actionLabel(r))}</span><b title="${escapeHtml(r.target)}">${escapeHtml(r.targetName || short(r.target))}</b><strong class="${r.side === 'buy' ? 'g' : 'r'}">${num(r.bnb)} <small>BNB</small></strong></div><div class="wt-event-bottom"><button data-wt-token="${escapeHtml(r.token)}" title="查看代币行情">${escapeHtml(r.symbol || short(r.token))}</button><span>MC ${r.mcapUsd ? '$' + num(r.mcapUsd) : '—'}</span><time title="${escapeHtml(new Date(r.ts).toLocaleString())}">${elapsed(r.ts)}${r.backfill ? ' · 历史' : ''}</time></div></article>`).join('');
}
export function copyLogMarkup(rows, targets = []) {
  const labels = {order:'执行结果',fail:'失败',skip:'跳过',sim:'模拟',dry_run:'模拟',pending:'待确认',error:'错误',stop:'已停止'};
  const states = {filled:'成交',pending:'待确认',unknown:'待确认',dry_run:'预演',failed:'失败'};
  return rows.map(r => {
    const wallet = targets.find(t => t.address?.toLowerCase() === r.target?.toLowerCase());
    const identity = r.taskName || wallet?.name || wallet?.domain || (r.target ? short(r.target) : r.task || '未关联任务');
    const results = (r.results || []).map(v => `<span>${escapeHtml(v.wallet || '执行钱包')} · ${escapeHtml(states[v.status] || v.status || '状态未知')}${/^0x[\da-f]{64}$/i.test(v.tx || '') ? ` <a href="https://bscscan.com/tx/${escapeHtml(v.tx)}" target="_blank" rel="noopener noreferrer">查看交易</a>` : ''}</span>`).join('');
    return `<article class="wt-log"><time>${elapsed(r.ts)}</time><b class="${['fail','error'].includes(r.kind) ? 'r' : r.kind === 'pending' ? 'y' : ''}">${escapeHtml(labels[r.kind] || '记录')}</b><strong>${escapeHtml(identity)}</strong><span class="wt-log-context">${r.target ? escapeHtml(wallet?.name || short(r.target)) + ' · ' : ''}${escapeHtml(r.symbol || (r.token ? short(r.token) : '未关联代币'))}</span><span>${escapeHtml(r.reason || '未提供原因')}</span>${results}</article>`;
  }).join('');
}
const icon = (path) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${path}</svg>`;
const icons = {
  close: icon('<path d="m6 6 12 12M18 6 6 18"/>'),
  float: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M13 11h6v8h-6z"/>'),
  dock: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M14 3v18"/>'),
  dockLeft: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M10 3v18"/>'),
  minimize: icon('<path d="M6 12h12"/>')
};
export function createTrackingPanel({getState, refresh, manage, openToken, copyTarget, editWallet, viewTask}) {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('wallet-tracking-panel') || '{}'); } catch { /* use defaults */ }
  let mode = ['floating', 'left'].includes(saved.mode) ? saved.mode : 'dock', open = !!saved.open, tab = 'feed', minimized = false, wallet = '', min = 0;
  const el = document.createElement('aside'); el.id = 'walletTrackingPanel'; el.className = 'wt-panel hidden'; el.setAttribute('aria-label', '钱包追踪');
  el.innerHTML = `<header class="wt-header"><b>钱包追踪 <span id="wtCount">0</span></b><button data-wt-manage>管理</button><span class="wt-modes"><button data-wt-mode="left" title="固定到左边" aria-label="固定到左边"></button><button data-wt-mode="dock" title="固定到右边" aria-label="固定到右边"></button><button data-wt-mode="floating" title="悬浮窗（可拖动、改大小）" aria-label="悬浮窗"></button></span><button data-wt-min title="收起面板" aria-label="收起面板">${icons.minimize}</button><button data-wt-close title="关闭面板" aria-label="关闭钱包追踪">${icons.close}</button></header><div class="wt-content"><nav class="wt-tabs" aria-label="钱包追踪内容"><button data-wt-tab="feed" class="active">追踪动态</button><button data-wt-tab="wallets">钱包</button><button data-wt-tab="copy">跟单</button></nav><div class="wt-filters"><select id="wtWallet" aria-label="按钱包筛选"><option value="">全部钱包</option></select><label>最小 <input id="wtMin" type="number" min="0" step="0.001" placeholder="0" aria-label="最小成交金额 BNB"/> BNB</label></div><div id="wtStatus" class="wt-status" role="status"></div><div id="wtBody" class="wt-body"></div><footer class="wt-footer"><span>Flap / Four / Gang 公开成交</span><button data-wt-refresh>刷新</button></footer></div>`;
  el.insertAdjacentHTML('beforeend', ['nw', 'ne', 'sw', 'se'].map(c => `<i class="wt-rs ${c}" data-wt-rs="${c}"></i>`).join(''));   // 悬浮时四个角拖动改大小
  let sz = {w: saved.width || '', h: saved.height || ''};
  if (saved.left) { el.style.left = saved.left; el.style.top = saved.top; }
  document.body.appendChild(el);
  const body = el.querySelector('#wtBody'), status = el.querySelector('#wtStatus'), selector = el.querySelector('#wtWallet');
  function save() { try { localStorage.setItem('wallet-tracking-panel', JSON.stringify({mode, open, left: el.style.left, top: el.style.top, width: sz.w, height: sz.h})); } catch { /* storage unavailable */ } }
  function clampPosition() {
    if (mode !== 'floating') return;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(r.left, innerWidth - r.width - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(r.top, innerHeight - Math.min(r.height, innerHeight - 16) - 8)) + 'px';
  }
  function layout() {
    el.classList.toggle('hidden', !open); el.classList.toggle('floating', mode === 'floating'); el.classList.toggle('minimized', minimized);
    document.body.classList.toggle('tracking-docked', open && mode === 'dock' && !minimized);
    document.body.classList.toggle('tracking-docked-left', open && mode === 'left' && !minimized); el.classList.toggle('dock-left', mode === 'left');
    const mi = {left: icons.dockLeft, dock: icons.dock, floating: icons.float};
    el.querySelectorAll('[data-wt-mode]').forEach(btn => { btn.innerHTML = mi[btn.dataset.wtMode]; btn.classList.toggle('on', btn.dataset.wtMode === mode); btn.setAttribute('aria-pressed', String(btn.dataset.wtMode === mode)); });
    const minButton = el.querySelector('[data-wt-min]'); minButton.title = minButton.ariaLabel = minimized ? '展开面板' : '收起面板'; minButton.setAttribute('aria-expanded', String(!minimized));
    document.querySelector('#walletTrackingToggle')?.setAttribute('aria-expanded', String(open));
    const fl = mode === 'floating';   // 自定义大小只在悬浮窗生效；固定到右侧栏时清掉，回到悬浮再恢复
    el.style.width = fl ? sz.w : ''; el.style.height = fl ? sz.h : ''; el.style.maxWidth = el.style.maxHeight = fl && (sz.w || sz.h) ? 'none' : '';
    if (open && mode === 'floating') clampPosition();
    window.dispatchEvent(new Event('resize')); save();
  }
  function update() {
    const s = getState();
    const scroll = body.scrollTop;
    el.querySelector('#wtCount').textContent = s.targets.length;
    document.querySelector('#walletTrackingCount').textContent = s.targets.length;
    if (!open) return;
    selector.innerHTML = '<option value="">全部钱包</option>' + s.targets.map(t => `<option value="${escapeHtml(t.address)}">${escapeHtml(t.remark || t.name || t.domain || short(t.address))}</option>`).join('');
    if (!s.targets.some(t => t.address === wallet)) wallet = ''; selector.value = wallet;
    el.querySelector('.wt-filters').hidden = tab !== 'feed';
    const message = s.loading ? '正在读取追踪数据…' : s.error ? `读取失败：${s.error}，请刷新重试。` : '';
    status.textContent = message; status.hidden = !message;
    el.querySelectorAll('[data-wt-tab]').forEach(b => { b.classList.toggle('active', b.dataset.wtTab === tab); b.setAttribute('aria-pressed', String(b.dataset.wtTab === tab)); });
    if (tab === 'wallets') {
      body.innerHTML = s.targets.length ? s.targets.map(t => `<article class="wt-wallet"><div><b>${escapeHtml(t.remark || t.name || t.domain || short(t.address))}</b><small>${t.remark && t.name ? escapeHtml(t.name) + ' · ' : ''}${escapeHtml(short(t.address))}</small></div><button data-wt-remark="${escapeHtml(t.address)}">备注</button><button data-wt-copy="${escapeHtml(t.address)}">设置跟单</button></article>`).join('') : empty('还没有追踪钱包', '在成交地址旁点“跟踪”，动态就会出现在这里。');
    } else if (tab === 'copy') {
      body.innerHTML = `<div class="wt-copy-note">${s.paused ? '全部跟单已暂停' : '追踪钱包不会自动创建跟单'}<button data-wt-manage="copy">管理跟单</button></div>` + (s.tasks.length ? s.tasks.map(t => `<article class="wt-task"><b>${escapeHtml(t.name || s.targets.find(w => w.address === t.target)?.name || short(t.target))}</b><div><span class="${s.paused || t.status !== 'running' ? 'muted' : 'g'}">${s.paused ? '全局暂停' : ({running:'运行中',paused:'已暂停',closed:'已关闭'}[t.status] || t.status)}</span><span class="${t.params?.dryRun === false ? 'r' : 'y'}">${t.params?.dryRun === false ? (s.execution?.live ? '真实下单 · 会花钱' : '真实模式 · 当前不可用') : '模拟 · 不会下单'}</span><span>${t.params?.mode === 'ratio' ? '对方金额 ' + num(t.params.ratioPct) + '%' : '每次 ' + num(t.params?.amountBnb || 0.01) + ' BNB'}</span></div><p class="wt-note">目标：${escapeHtml(s.targets.find(w=>w.address===t.target)?.remark || s.targets.find(w=>w.address===t.target)?.name || short(t.target))}<br>${t.params?.followSell?'跟目标卖出':'不跟卖，需手动卖出'} · 止盈 ${t.params?.takeProfitPct||'未设'}${t.params?.takeProfitPct?'%':''} · 止损 ${t.params?.stopLossPct||'未设'}${t.params?.stopLossPct?'%':''}</p><button data-wt-task="${escapeHtml(t.id)}">查看详情／编辑策略</button></article>`).join('') : empty('还没有跟单任务', '在“钱包”里选一个地址设置跟单，任务默认模拟、暂停。')) + `<h4 class="wt-log-title">最近跟单记录</h4>` + (s.log.length ? copyLogMarkup(s.log.slice(0, 30), s.targets) : '<p class="wt-note">任务运行后，模拟、跳过及执行结果显示在这里。</p>');
    } else {
      const rows = filteredFeed(s.feed, wallet, min).map(r => ({...r,targetName: s.targets.find(t => t.address?.toLowerCase() === r.target?.toLowerCase())?.remark || r.targetName}));
      body.innerHTML = rows.length ? feedMarkup(rows) : empty(s.targets.length ? '暂无匹配的成交动态' : '还没有追踪钱包', s.targets.length ? '等待这些钱包在 Flap / Four / Gang 成交，或调整筛选。从添加追踪后开始记录，不拉取历史成交。' : '在实时成交的地址旁点“跟踪”，不用离开行情页。');
    }
    body.scrollTop = scroll;
  }
  function empty(title, help) { return `<div class="wt-empty"><b>${title}</b><p>${help}</p><button data-wt-manage>打开追踪管理</button></div>`; }
  async function reload(button) { if (button) button.disabled = true; try { await refresh(); } finally { if (button) button.disabled = false; } }
  function show(nextTab) { open = true; minimized = false; if (nextTab) tab = nextTab; layout(); update(); reload(); }
  el.addEventListener('click', e => {
    if (e.target.closest('[data-wt-close]')) { open = false; layout(); document.querySelector('#walletTrackingToggle')?.focus(); }
    const mb = e.target.closest('[data-wt-mode]'); if (mb) { mode = mb.dataset.wtMode; el.style.left = ''; el.style.top = ''; layout(); }
    if (e.target.closest('[data-wt-min]')) { minimized = !minimized; layout(); }
    const m = e.target.closest('[data-wt-manage]'); if (m) { manage(m.dataset.wtManage === 'copy' ? 'copy' : 'feed'); }
    const t = e.target.closest('[data-wt-tab]'); if (t) { tab = t.dataset.wtTab; update(); }
    const task = e.target.closest('[data-wt-task]'); if(task) viewTask(task.dataset.wtTask);
    const remark = e.target.closest('[data-wt-remark]'); if (remark) editWallet(remark.dataset.wtRemark);
    const c = e.target.closest('[data-wt-copy]'); if (c) copyTarget(c.dataset.wtCopy);
    const token = e.target.closest('[data-wt-token]'); if (token && /^0x[\da-f]{40}$/i.test(token.dataset.wtToken)) openToken(token.dataset.wtToken);
    if (e.target.closest('[data-wt-refresh]')) reload(e.target.closest('button'));
  });
  selector.addEventListener('change', () => { wallet = selector.value; update(); });
  el.querySelector('#wtMin').addEventListener('input', e => { min = Math.max(0, Number(e.target.value) || 0); update(); });
  el.querySelector('.wt-header').addEventListener('pointerdown', e => {
    if (mode !== 'floating' || e.target.closest('button') || e.button !== 0) return;
    const start = el.getBoundingClientRect(), x = e.clientX, y = e.clientY, header = e.currentTarget;
    header.setPointerCapture(e.pointerId);
    const move = ev => { el.style.left = start.left + ev.clientX - x + 'px'; el.style.top = start.top + ev.clientY - y + 'px'; clampPosition(); };
    const end = () => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', end); header.removeEventListener('pointercancel', end); save(); };
    header.addEventListener('pointermove', move); header.addEventListener('pointerup', end); header.addEventListener('pointercancel', end);
  });
  el.addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-wt-rs]'); if (!h || mode !== 'floating' || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); h.setPointerCapture(e.pointerId);
    const c = h.dataset.wtRs, r = el.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, MW = 300, MH = 240;
    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy; let l = r.left, t = r.top, w = r.width, hh = r.height;
      if (c.includes('e')) w = Math.max(MW, Math.min(innerWidth - l - 4, r.width + dx)); else { w = Math.max(MW, Math.min(r.right - 4, r.width - dx)); l = r.right - w; }
      if (c.includes('s')) hh = Math.max(MH, Math.min(innerHeight - t - 4, r.height + dy)); else { hh = Math.max(MH, Math.min(r.bottom - 4, r.height - dy)); t = r.bottom - hh; }
      Object.assign(el.style, {left: l + 'px', top: t + 'px', right: 'auto', bottom: 'auto', width: w + 'px', height: hh + 'px', maxWidth: 'none', maxHeight: 'none'});
    };
    const end = () => { sz = {w: el.style.width, h: el.style.height}; h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', end); h.removeEventListener('pointercancel', end); save(); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  });
  window.addEventListener('resize', clampPosition);
  if (saved.left) el.style.left = saved.left; if (saved.top) el.style.top = saved.top;
  layout(); update();
  return {update, show, hide() { open = false; layout(); }, toggle() { if (!open || minimized) show(); else { open = false; layout(); } }};
}
