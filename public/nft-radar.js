const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const R = { rows: [], history: [], filter: 'all', sort: 'new', social: false, selected: null, timer: 0, active: false, floatOpen: false, floatSide: localStorage.getItem('bscagent.nftFloatSide') || 'right', mode: 'projects', historyScope: 'session', auto: null, summary: null, msg: '' };
const viewButtons = () => $$('#viewSw button');
const isNftRoute = () => /^#\/?nft(?:$|\/)/.test(location.hash);

function setVisible(on) {
  R.active = on;
  $('#nft')?.classList.toggle('hidden', !on);
  for (const id of ['.layout', '#pulse', '#hold', '#track', '#snipe']) document.querySelector(id)?.classList.toggle('hidden', on);
  viewButtons().forEach((b) => b.classList.toggle('active', on ? b.dataset.view === 'nft' : b.dataset.view !== 'nft' && b.classList.contains('active')));
  if (on || R.floatOpen) { load(); clearInterval(R.timer); R.timer = setInterval(load, 15000); }
  else clearInterval(R.timer);
}

function ensureFloatPanel() {
  let panel = $('#nftFloatPanel');
  if (!panel) { panel = document.createElement('aside'); panel.id = 'nftFloatPanel'; panel.className = 'nft-float-panel hidden'; panel.setAttribute('aria-label', '新项目浮窗'); document.body.append(panel); }
  return panel;
}

function toggleFloat(force) {
  R.floatOpen = typeof force === 'boolean' ? force : !R.floatOpen;
  const panel = ensureFloatPanel();
  panel.classList.toggle('hidden', !R.floatOpen);
  const button = $('#nftFloatToggle');
  button?.classList.toggle('active', R.floatOpen);
  button?.setAttribute('aria-expanded', String(R.floatOpen));
  if (button) button.title = R.floatOpen ? '关闭新项目浮窗' : '打开新项目浮窗';
  if (R.floatOpen) { load(); render(); }
}

function setFloatSide(side) {
  R.floatSide = side === 'left' ? 'left' : 'right'; localStorage.setItem('bscagent.nftFloatSide', R.floatSide);
  const panel = ensureFloatPanel(); panel.classList.toggle('left', R.floatSide === 'left'); panel.classList.toggle('right', R.floatSide === 'right');
}

const HDR = { 'sec-fetch-site': 'same-origin' };
function syncTaskState() { window.__nftAutoOn = !!R.auto?.enabled; window.dispatchEvent(new Event('bscagent:task-state')); }
async function loadAuto() {
  try { const r = await fetch('/api/nft/auto', { headers: HDR }); if (r.ok) { R.auto = await r.json(); syncTaskState(); } } catch { /* 服务还没重启或离线 */ }
}
async function saveAuto(body) {
  R.msg = '';
  try {
    const r = await fetch('/api/nft/auto', { method: 'POST', headers: { 'content-type': 'application/json', ...HDR }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `保存失败 (${r.status})`);
    R.auto = { ...R.auto, ...j }; syncTaskState();
  } catch (e) { R.msg = e.message; }
  await loadAuto(); await loadHistory(); render();
}
async function loadHistory() {
  const since = R.historyScope === 'session' && R.auto?.sessionStart ? `&since=${R.auto.sessionStart}` : '';
  try { const r = await fetch(`/api/nft/mint-history?limit=300${since}`, { headers: HDR }); if (r.ok) { const h = await r.json(); R.history = Array.isArray(h.rows) ? h.rows : []; R.summary = h.summary || null; } } catch { /* 保留旧数据 */ }
}

async function load() {
  if (!R.active && !R.floatOpen) return;
  try {
    const feed = await fetch('/api/nft/feed?limit=200', { headers: HDR });
    if (!feed.ok) throw new Error('NFT feed unavailable');
    const j = await feed.json(); R.rows = Array.isArray(j.rows) ? j.rows : [];
    await loadAuto(); await loadHistory();
    render();
  } catch (e) {
    const grid = $('#nftProjectGrid'); if (grid) grid.innerHTML = `<div class="empty">NFT 监听暂不可用：${esc(e.message)}</div>`;
  }
}

function filtered() {
  let rows = R.rows.filter((p) => {
    if (R.filter === 'eligible' && !p.eligible) return false;
    if (R.filter === 'free' && !p.free) return false;
    if (R.filter === 'paid' && p.free) return false;
    if (R.filter === 'website' && !p.website) return false;
    if (R.filter === 'x' && !p.xHandle) return false;
    if (R.social && !p.website && !p.xHandle) return false;
    return true;
  });
  rows.sort((a, b) => R.sort === 'minted' ? (b.minted ?? -1) - (a.minted ?? -1) : R.sort === 'total' ? (b.total ?? -1) - (a.total ?? -1) : new Date(b.postedAt || 0) - new Date(a.postedAt || 0));
  return rows;
}

function badge(p) {
  const out = [];
  if (p.eligible) out.push('<i class="nft-badge good" title="符合当前自动 mint 规则">符合规则</i>');
  else if (p.free) out.push('<i class="nft-badge">免费</i>');
  else out.push('<i class="nft-badge warn">付费手动</i>');
  if (p.agentGated) out.push('<i class="nft-badge gate">Agent ID</i>');
  if (p.website) out.push('<i class="nft-badge link">官网</i>');
  if (p.xHandle) out.push('<i class="nft-badge link">X</i>');
  return out.join('');
}

function card(p) {
  const initial = esc((p.symbol || p.name || 'N').slice(0, 2).toUpperCase());
  const progress = p.total && p.minted != null ? Math.min(100, p.minted / p.total * 100) : 0;
  return `<button class="nft-project-card ${p.contract === R.selected ? 'selected' : ''}" data-nft-select="${esc(p.contract)}">
    <span class="nft-project-art">${initial}</span><span class="nft-project-body"><span class="nft-project-title"><b>${esc(p.name)}</b><small>${esc(p.symbol)}</small></span><span class="nft-project-badges">${badge(p)}</span><span class="nft-project-price">${esc(p.priceLine || (p.free ? 'mint 免费（仅付 gas）' : '价格待核对'))}</span><span class="nft-project-meta">${p.minted != null ? `已 mint ${p.minted}${p.total != null ? ` / ${p.total}` : ''}` : 'mint 数量未知'}<span>${p.postedAt ? new Date(p.postedAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}</span></span><span class="nft-progress"><i style="width:${progress}%"></i></span></span>
  </button>`;
}

function newProjectItem(p) {
  const initial = esc((p.symbol || p.name || 'N').slice(0, 2).toUpperCase());
  return `<button class="nft-new-item" data-nft-select="${esc(p.contract)}"><span class="nft-project-art small">${initial}</span><span class="nft-new-copy"><span class="nft-new-title"><b>${esc(p.name)}</b>${p.symbol ? `<small>${esc(p.symbol)}</small>` : ''}<time>${p.postedAt ? new Date(p.postedAt).toLocaleString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—'}</time></span><span class="nft-project-badges">${badge(p)}</span><span class="nft-new-desc">${esc(p.priceLine || (p.free ? 'mint 免费（仅付 gas）' : '价格待核对'))}</span><span class="nft-new-desc">${p.minted != null ? `已 mint ${p.minted}${p.total != null ? ` / ${p.total}` : ''}` : 'mint 数量未知'}${p.perWallet ? ` · 每钱包 ${p.perWallet}` : ''}</span></span></button>`;
}

function newProjectPanel(rows) {
  const latest = [...rows].sort((a, b) => new Date(b.postedAt || b.seenAt || 0) - new Date(a.postedAt || a.seenAt || 0));
  return `<div class="nft-new-head"><div><b>最新NFT</b><span>${latest.length} 个</span></div><div class="nft-new-head-actions"><button class="nft-side-toggle" data-nft-side="${R.floatSide === 'right' ? 'left' : 'right'}" title="切换浮窗靠${R.floatSide === 'right' ? '左' : '右'}">靠${R.floatSide === 'right' ? '左' : '右'}</button><button class="nft-new-live" title="监听列表来自本机 Telegram feed">● 实时</button></div></div><div class="nft-new-tabs"><button class="active">全部</button><button>代币</button><button>NFT</button><button>占座</button></div><div class="nft-new-list">${latest.slice(0, 30).map(newProjectItem).join('') || '<div class="empty">暂无新项目</div>'}</div>`;
}

const SOCIAL_LABEL = { any: '不限', site: '必须有官网', x: '必须有 X', either: '官网或 X 至少一个', both: '官网和 X 都要有' };
const fmtT = (ms) => ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';
const txLink = (tx) => tx ? `<a href="https://bscscan.com/tx/${esc(tx)}" target="_blank" rel="noopener" class="mono">${esc(tx.slice(0, 10))}…</a>` : '';

function manager() {
  const au = R.auto, rules = au?.rules;
  if (!au || !rules) return '<div class="empty">自动 mint 服务暂不可用（服务没重启或离线）。重启一次本地服务即可。</div>';
  const w = au.watcher || {}, on = !!au.enabled, dry = !!rules.dry;
  const watcherTxt = w.state === 'running' ? '监听运行中' : w.state === 'external' ? '监听由外部进程运行' : w.state === 'restarting' ? '监听重连中' : w.configured ? '监听待启动' : '监听未配置（见 README「NFT 监听」）';
  const mode = !on ? '未开启' : dry ? '试运行中（不发交易）' : '真实 mint 中';
  const opt = (v, cur, label) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
  const s = R.summary || { projectsOk: 0, nftsMinted: 0, failed: 0, gasBnb: 0 };
  const last = au.lastRun;
  const lockWarn = !au.canExecute ? '<p class="nft-muted">当前是演示/只读模式（LIVE_TRADE 未开），只能试运行。</p>' : '';
  return `<div class="nft-manager-head"><div><h2>自动 mint 管理</h2><p>只处理「免费 + Agent ID」项目，付费项目永远手动。每个项目先链上模拟、再 baw 预览，通过才发交易，花费只有 gas。</p></div><span class="nft-preview-lock ${on && !dry ? 'live' : ''}">${mode}</span></div>
    ${R.msg ? `<p class="nft-muted bad">${esc(R.msg)}</p>` : ''}
    <div class="nft-manager-grid"><section class="nft-settings-card"><h3>自动规则</h3>
      <label class="nft-setting-row"><span>开启 NFT 自动 mint 任务</span><input type="checkbox" data-nft-enable ${on ? 'checked' : ''}></label>
      <label class="nft-setting-row"><span>试运行（只检查，不发交易）</span><input type="checkbox" data-nft-rule="dry" ${dry ? 'checked' : ''}></label>
      <label class="nft-setting-row"><span>必须有 Agent ID</span><input type="checkbox" data-nft-rule="agentOnly" ${rules.agentOnly ? 'checked' : ''}></label>
      <label class="nft-setting-row"><span>官网 / X 条件</span><select data-nft-rule="social">${Object.entries(SOCIAL_LABEL).map(([k, v]) => opt(k, rules.social, v)).join('')}</select></label>
      <label class="nft-setting-row"><span>每钱包数量</span><select data-nft-rule="quantity">${opt('all', rules.quantity, '按项目上限')}${opt('one', rules.quantity, '每项目 1 个')}</select></label>
      <label class="nft-setting-row"><span>上限未知时最多试</span><input type="number" min="1" max="50" data-nft-rule="maxQty" value="${rules.maxQty}" style="width:70px"></label>
      <label class="nft-setting-row"><span>处理范围</span><select data-nft-rule="scope">${opt('new', rules.scope, '只处理开启后的新项目')}${opt('all', rules.scope, '也处理监听里已有的')}</select></label>
      <label class="nft-setting-row"><span>排除关键词</span><input type="text" data-nft-rule="exclude" value="${esc(rules.exclude.join(', '))}" placeholder="逗号分隔，如 test, scam" style="width:200px"></label>
      <p class="nft-muted">${watcherTxt}。每 10 秒检查一次新项目；失败按 2 分钟 / 10 分钟 / 30 分钟 / 2 小时间隔重试；已广播的交易不会重发。重启服务后任务不会自动恢复，需要你重新开启。</p>${lockWarn}
    </section><section class="nft-settings-card"><h3>当前任务</h3>
      <div class="nft-manager-metrics"><b>${s.projectsOk}<small>成功项目</small></b><b>${s.nftsMinted}<small>已 mint NFT</small></b><b class="${s.failed ? 'bad' : ''}">${s.failed}<small>失败</small></b><b>${s.gasBnb}<small>gas (BNB)</small></b></div>
      <p class="nft-muted">${on ? `开启于 ${fmtT(au.sessionStart)}` : au.sessionStart ? `上次任务开启于 ${fmtT(au.sessionStart)}` : '还没开启过'}${au.busy ? ' · 正在执行…' : ''}${last ? ` · 最近一次 ${fmtT(last.at)}：${last.error ? '出错 ' + esc(last.error) : `${last.picked} 个项目，成功 ${last.ok}${last.dry ? '（试运行）' : ''}`}` : ''}</p>
      <p class="nft-muted">${R.rows.filter((p) => p.eligible).length} 个监听项目符合免费 + Agent ID，共 ${R.rows.length} 个。</p>
      <button class="nft-action primary" data-nft-mode="history">查看 mint 历史</button> <button class="nft-action" data-nft-mode="projects">查看项目列表</button></section></div>`;
}

function historyMarkup() {
  const au = R.auto, start = au?.sessionStart || 0, rows = R.history, s = R.summary || { projectsOk: 0, nftsMinted: 0, failed: 0, gasBnb: 0 };
  const where = R.historyScope === 'session' ? (start ? `当前任务：${fmtT(start)} 起` : '还没有开启过任务') : '全部历史（含手动 mint）';
  return `<div class="nft-manager-head"><div><h2>mint 历史</h2><p>${where} · 成功 ${s.projectsOk} 个项目 / ${s.nftsMinted} 枚 NFT · 失败 ${s.failed} · gas ${s.gasBnb} BNB</p></div><div class="nft-history-tools"><button class="nft-history-scope ${R.historyScope === 'session' ? 'active' : ''}" data-nft-history-scope="session">当前任务</button><button class="nft-history-scope ${R.historyScope === 'all' ? 'active' : ''}" data-nft-history-scope="all">全部历史</button><span class="nft-muted">${rows.length} 条</span></div></div><div class="nft-history-table"><div class="nft-history-row nft-history-head"><span>时间</span><span>项目 / 合约</span><span>数量</span><span>结果</span><span>原因 / 交易 / tokenId</span></div>${rows.map((x) => `<div class="nft-history-row"><span>${x.at ? fmtT(x.at) : esc(x.time || '—')}<small>${x.dry ? '试运行' : x.source === 'auto' ? '自动' : '手动'}</small></span><span><b>${esc(x.name || 'NFT')}</b><small class="mono">${esc(x.contract || '—')}</small></span><span>${x.tokenIds?.length || x.qty || '—'}</span><span class="${x.status === '成功' ? 'good' : x.dry ? '' : 'bad'}">${esc(x.status || '—')}</span><span class="nft-history-reason">${esc(x.reason || '')} ${txLink(x.tx)} ${x.tokenIds?.length ? `<small>#${esc(x.tokenIds.slice(0, 6).join(', #'))}${x.tokenIds.length > 6 ? '…' : ''}</small>` : ''}</span></div>`).join('') || '<div class="empty">这段时间还没有记录。</div>'}</div>`;
}

function detail(p) {
  if (!p) return '<div class="empty">选择一个项目查看详情</div>';
  const max = p.perWallet || null;
  return `<div class="nft-detail-back"><button data-nft-back>‹ 新项目</button><span class="nft-muted">项目详情</span></div><div class="nft-detail-head"><div class="nft-project-art large">${esc((p.symbol || p.name || 'N').slice(0, 2).toUpperCase())}</div><div><h2>${esc(p.name)} <small>${esc(p.symbol)}</small></h2><div class="nft-project-badges">${badge(p)}</div></div></div>
    <div class="nft-detail-kv"><span>合约</span><b class="mono">${esc(p.contract)}</b><button class="nft-copy" data-nft-copy="${esc(p.contract)}">复制</button></div>
    <div class="nft-detail-stats"><div><span>价格</span><b>${esc(p.priceLine || (p.free ? '免费 + gas' : '待核对'))}</b></div><div><span>已 mint</span><b>${p.minted ?? '—'}${p.total != null ? ` / ${p.total}` : ''}</b></div><div><span>每钱包上限</span><b>${max ?? '未知'}</b></div></div>
    <div class="nft-rule-box"><b>规则判断</b><p>${p.eligible ? '免费 + Agent ID，符合当前规则，仍需预览。' : p.free ? '免费但未满足当前规则，保留手动预览。' : '付费项目只展示，不自动 mint。'}</p>${p.paidHints?.length ? `<p class="nft-muted">${esc(p.paidHints.join('；'))}</p>` : ''}</div>
    <div class="nft-mint-box"><div class="nft-mint-head"><b>Mint 方式</b></div><p class="nft-muted">${p.eligible ? '开启「自动 mint 任务」后会自动处理这个项目（先模拟、再预览、通过才发交易）。' : p.free ? '免费但不满足自动规则，可手动处理：' : '付费项目不会自动 mint，请自己判断后在官网操作。'}</p>${p.free ? `<div class="nft-detail-kv"><span>手动试运行</span><b class="mono">node scripts/free-mint.mjs --dry ${esc(p.contract)}</b><button class="nft-copy" data-nft-copy="node scripts/free-mint.mjs --dry ${esc(p.contract)}">复制</button></div>` : ''}</div>
    `;
}

function render() {
  const rows = filtered(), grid = $('#nftProjectGrid'); if (!grid) return;
  const auto = R.rows.filter((p) => p.eligible).length, free = R.rows.filter((p) => p.free).length;
  $('#nftSummary').textContent = `${R.rows.length} 个项目 · ${auto} 个符合规则 · ${free} 个免费`;
  const managerEl = $('#nftManager'), historyEl = $('#nftHistory'), layout = document.querySelector('#nft .nft-layout');
  grid.innerHTML = rows.length ? rows.map(card).join('') : '<div class="empty">没有符合筛选条件的项目</div>';
  managerEl?.classList.toggle('hidden', R.mode !== 'manage'); if (managerEl && R.mode === 'manage') managerEl.innerHTML = manager();
  historyEl?.classList.toggle('hidden', R.mode !== 'history'); if (historyEl && R.mode === 'history') historyEl.innerHTML = historyMarkup();
  layout?.classList.toggle('hidden', R.mode !== 'projects');
  document.querySelector('#nft .nft-filterbar')?.classList.toggle('hidden', R.mode !== 'projects');
  const selected = R.rows.find((p) => p.contract === R.selected);
  if (selected) { $('#nftDetail').innerHTML = detail(selected); const c = grid.querySelector(`[data-nft-select="${selected.contract}"]`); c?.classList.add('selected'); }
  else if (rows.length) $('#nftDetail').innerHTML = newProjectPanel(rows);
  else $('#nftDetail').innerHTML = '<div class="empty">监听列表为空，先启动 Telegram 监听。</div>';
  const float = ensureFloatPanel(); setFloatSide(R.floatSide); if (R.floatOpen) float.innerHTML = selected ? detail(selected) : newProjectPanel(rows);
}

document.addEventListener('click', async (e) => {
  const status = e.target.closest('[data-task-status]');
  if (status) { e.preventDefault(); const target = document.querySelector(`#viewSw button[data-view="${status.dataset.taskStatus}"]`); target?.click(); if (status.dataset.taskStatus === 'nft') { R.mode = 'manage'; $$('[data-nft-mode]').forEach((b) => b.classList.toggle('active', b.dataset.nftMode === R.mode)); load(); } return; }
  if (e.target.closest('#nftFloatToggle')) { e.preventDefault(); toggleFloat(); return; }
  const side = e.target.closest('[data-nft-side]'); if (side) { setFloatSide(side.dataset.nftSide); render(); return; }
  const nav = e.target.closest('#viewSw button[data-view="nft"]');
  if (nav) { e.preventDefault(); e.stopImmediatePropagation(); history.replaceState(null, '', '#/nft'); setVisible(true); return; }
  const select = e.target.closest('[data-nft-select]');
  if (select && (R.active || R.floatOpen)) { R.selected = select.dataset.nftSelect; render(); return; }
  if (e.target.closest('[data-nft-back]')) { R.selected = null; render(); return; }
  const filter = e.target.closest('[data-nft-filter]');
  if (filter && R.active) { R.filter = filter.dataset.nftFilter; $$('[data-nft-filter]').forEach((b) => b.classList.toggle('active', b === filter)); render(); return; }
  const mode = e.target.closest('[data-nft-mode]');
  if (mode && R.active) { R.mode = mode.dataset.nftMode; $$('[data-nft-mode]').forEach((b) => b.classList.toggle('active', b.dataset.nftMode === R.mode)); render(); return; }
  const scope = e.target.closest('[data-nft-history-scope]'); if (scope && R.active) { R.historyScope = scope.dataset.nftHistoryScope; loadHistory().then(render); return; }
  const copy = e.target.closest('[data-nft-copy]');
  if (copy) { try { await navigator.clipboard.writeText(copy.dataset.nftCopy); copy.textContent = '已复制'; } catch { copy.textContent = '复制失败'; } setTimeout(() => { copy.textContent = '复制'; }, 1200); }
}, true);
$('#nftRefresh')?.addEventListener('click', () => load());
$('#nftSort')?.addEventListener('change', (e) => { R.sort = e.target.value; render(); });
$('#nftRequireSocial')?.addEventListener('change', (e) => { R.social = e.target.checked; render(); });
document.addEventListener('change', (e) => {
  const en = e.target.closest('[data-nft-enable]');
  if (en) {
    const want = en.checked, live = !R.auto?.rules?.dry;
    if (want && live && !confirm('开启后会自动、真实地 mint 符合规则的免费 NFT（只花 gas）。\n\n每个项目都会先链上模拟 + baw 预览，任何异常都会放弃。确定开启？')) { en.checked = false; return; }
    saveAuto({ enabled: want }); return;
  }
  const rule = e.target.closest('[data-nft-rule]'); if (!rule) return;
  const key = rule.dataset.nftRule, val = rule.type === 'checkbox' ? rule.checked : rule.type === 'number' ? Number(rule.value) : rule.value;
  if (key === 'dry' && val === false && R.auto?.enabled && !confirm('关闭试运行后，符合规则的项目会被真实 mint。确定？')) { rule.checked = true; return; }
  saveAuto({ rules: { [key]: key === 'exclude' ? val.split(/[,，\s]+/).filter(Boolean) : val } });
}, true);
window.addEventListener('hashchange', () => setVisible(isNftRoute()));
ensureFloatPanel();
setVisible(isNftRoute());
loadAuto();
setInterval(loadAuto, 15000);
