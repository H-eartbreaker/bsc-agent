import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Market, SNIPE_FEE_CURVE } from './engine/market.js';
import { SimTrader, GAS_PRESETS } from './engine/trader.js';
import { Agent } from './engine/agent.js';
import { costForPct } from './engine/live/costForPct.js';
import { Blocklist } from './engine/blocklist.js';
import { Favorites } from './engine/favorites.js';
import { MODE, LIVE_TRADE } from './engine/live/config.js';
import { isLocalRequest, localBoundary, rejectUnsafeBody, isAllowedImageUrl } from './engine/security.js';
import * as latency from './engine/live/latency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

// MODE=live：真实行情（shrine + Flap Agent Curve Reader + fsi）+ baw 报价/预演；再加 LIVE_TRADE=1 才能真实下单；自动还需本人开启策略
const LIVE = MODE === 'live';
let market, trader;
if (LIVE) {
  const { LiveMarket } = await import('./engine/live/liveMarket.js');
  const { LiveTrader } = await import('./engine/live/liveTrader.js');
  market = new LiveMarket();
  trader = new LiveTrader(market);
  await trader.init();
  // 按币的「发射后转出」监控（data/transferWatch.json，与 AUTO_TRANSFER_FOUR 无关）
  const { startTransferWatch } = await import('./engine/live/transferWatch.js');
  startTransferWatch(trader, market.provider, { intervalMs: 3000, dryRun: !LIVE_TRADE });
} else {
  market = new Market();
  trader = new SimTrader(market);
}
const agent = new Agent(market, trader, { live: LIVE, quoteBuy: (q) => costForPct({ market, trader, live: LIVE }, q), stateFile: LIVE ? path.join(__dirname, 'data/automatic-state.json') : null });
if (LIVE) {
  trader.automaticPolicy = (order) => agent.allowAutomatic(order);
  trader.status.automaticTrading = LIVE_TRADE && !agent.stateError;
  trader.status.automaticError = agent.stateError;
}
const favorites = new Favorites();
// 行情列表满了会淘汰最老的币：持有中（本程序记录 + 持仓快照）和收藏的币不能被淘汰，否则持仓页会少掉它们
market.keepSet = () => new Set([
  ...[...(trader.positions?.values?.() || [])].filter((p) => p.amount > 0).map((p) => String(p.token).toLowerCase()),
  ...(() => { try { return holdSnap?.rows || []; } catch { return []; } })().filter((r) => r.amount > 0).map((r) => String(r.token).toLowerCase()),   // 启动早期 holdSnap 还没定义
  ...Object.keys(favorites.items || {}).map((a) => a.toLowerCase()),
]);
const blocklist = new Blocklist(); agent.isBlocked = (s) => blocklist.has(s);   // 屏蔽的币不自动买
// 实盘的 ⚡ 快捷买入金额存进 data/live-settings.json，重启后沿用（以前每次重启都回到默认 0.1）
if (LIVE) { const q = Number(trader.loadSaved?.().quickBuy); if (q > 0) agent.setConfig({ quickBuy: q }); }
// 持仓页：链上数量 + baw 钱包历史算成本（只在实盘模式）
const holdings = LIVE ? new (await import('./engine/live/holdings.js')).Holdings(market, trader) : null;
market.start();

const net = { wss: 302, rpc: 102, detect: 146, detectAt: Date.now() };
setInterval(() => {
  if (LIVE) Object.assign(net, market.netStatus());
  else { net.wss = Math.round(260 + Math.random() * 90); net.rpc = Math.round(80 + Math.random() * 50); }
}, LIVE ? 1000 : 3000);
agent.on('detect', (ms) => { net.detect = ms; net.detectAt = Date.now(); });
const modeInfo = () => ({ mode: LIVE ? 'live' : 'sim', baw: LIVE ? trader.status : null });

const app = express();
app.use(localBoundary(PORT));
app.use(express.json());
app.use(rejectUnsafeBody);
// 强制登录：实盘模式下币安钱包未登录时，所有动用资金的接口一律拒绝（买卖、兑换、换回 BNB、领取、撤销授权、单币转出规则）
const AUTH_GATED = new Set(['/api/order', '/api/swap', '/api/quote-to-bnb', '/api/claim', '/api/approvals/revoke', '/api/token-rules']);
app.use((req, res, next) => {
  if (LIVE && req.method === 'POST' && AUTH_GATED.has(req.path) && trader.status?.auth?.state !== 'ok') return res.status(401).json({ error: '币安钱包未登录', auth: trader.status?.auth?.state });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const state = () => ({
  ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, net,
  wallets: trader.walletsView(), settings: trader.settings, gasPresets: GAS_PRESETS, config: agent.config, usage: agent.usageView(),
  tokens: market.list(), positions: trader.positionsView(), snipeCurve: SNIPE_FEE_CURVE, claimable: LIVE ? trader.claimable : [],
});

app.post('/api/claim', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式能领取' }); res.json(await trader.claimOne(req.body.market, '手动领取')); });
app.post('/api/auth/login', async (req, res) => { try { res.json(LIVE ? await trader.startLogin() : null); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/auth/check', async (req, res) => res.json(LIVE ? await trader.checkAuth() : null));
setTimeout(() => { for (const o of [...trader.orders].reverse()) latency.record(o); }, 5000);   // 启动时把内存里已有订单补记一次（按 id/tx 去重）
app.get('/api/latency-stats', (req, res) => res.json(latency.stats(Math.max(0.01, Number(req.query.days) || 1))));
app.get('/api/state', (req, res) => res.json({ ...state(), holdings: holdSnap, orders: trader.orders.slice(0, 100), logs: agent.logs.slice(0, 150), records: agent.records, flow: market.named ? market.named(market.flow.slice(0, 80)) : market.flow.slice(0, 80) }));
// 持仓快照：后台每 5 秒算一次（下单 / 领取 / 转账结束后立刻再算），通过 WebSocket 推给页面、也放进 /api/state，
// 页面打开详情时直接用快照，不再每次现算（现算要读钱包历史和链上报价，慢）
let holdSnap = null, holdBusy = false, holdAgain = false;
async function refreshHoldSnap() {
  if (!holdings) return; if (holdBusy) { holdAgain = true; return; } holdBusy = true;
  try { holdSnap = await holdings.view(); broadcast({ type: 'holdings', data: holdSnap }); } catch { /* 下次再算 */ }
  holdBusy = false; if (holdAgain) { holdAgain = false; setTimeout(refreshHoldSnap, 200); }
}
if (holdings) { setTimeout(refreshHoldSnap, 3000); setInterval(refreshHoldSnap, 5000); }
app.get('/api/holdings', async (req, res) => {
  if (!holdings) return res.json({ rows: [], totals: {}, bnb: 0 });
  if (req.query.refresh) { trader.syncAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); await holdings.loadHistory(true).catch(() => {}); holdSnap = await holdings.view(); broadcast({ type: 'holdings', data: holdSnap }); return res.json(holdSnap); }
  res.json(holdSnap || await holdings.view());
});
// 计价币余额与一键换回 BNB（只在点击后执行；先 preview 给确认框看报价）
app.get('/api/quote-balances', async (req, res) => { if (!LIVE) return res.json([]); try { res.json(await trader.quoteBalances()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/quote-to-bnb/preview', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' }); try { res.json(await trader.quoteToBnbPreview(String(req.body.token || ''), Number(req.body.slippage) || 1)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/quote-to-bnb', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' }); res.json(await trader.quoteToBnb({ token: String(req.body.token || ''), slippage: Number(req.body.slippage) || 1 })); });
app.get('/api/trades/:token', async (req, res) => { try { const v = LIVE ? await market.tradesPage(req.params.token, Number(req.query.before) || 0, Math.min(500, Number(req.query.limit) || 100)) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/trader/:token/:addr', async (req, res) => { try { const v = LIVE ? await market.traderStats(req.params.token, req.params.addr) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/lookup/:a', async (req, res) => {
  const t = LIVE ? await market.lookup(req.params.a) : (market.get(req.params.a) ? market.summary(market.get(req.params.a)) : null);
  t ? res.json(t) : res.status(404).json({ error: '未找到该代币' });
});
app.get('/api/token/:a', async (req, res) => {
  if (LIVE) await market.refresh(req.params.a);
  const d = market.detail(req.params.a); d ? res.json(d) : res.status(404).json({ error: '代币不存在' });
});
// 地址 → 域名本地映射（前端定时拉取，ver 不变就返回空）
// 代币头像代理缓存：/api/img?u=<url> → data/img/<sha1>.<ext>，命中直接读盘，浏览器端 immutable 长缓存
const IMG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const imgInflight = new Map(), imgFail = new Map();
const IPFS_GW = ['https://flap.mypinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://cloudflare-ipfs.com/ipfs/'];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
async function imgFetchOne(u) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000);
  try {
    let r;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!isAllowedImageUrl(u)) throw new Error('image host is not allowed');
      r = await fetch(u, { signal: ac.signal, redirect: 'manual', headers: { accept: 'image/*' } });
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      await r.body?.cancel();
      if (redirects === 3 || !r.headers.get('location')) throw new Error('image redirect limit');
      u = new URL(r.headers.get('location'), u).href;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    const ct = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!Object.hasOwn(EXT, ct)) { await r.body?.cancel(); throw new Error('not image'); }
    if (Number(r.headers.get('content-length') || 0) > 2e6) { ac.abort(); throw new Error('too big'); }
    const chunks = []; let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > 2e6) { ac.abort(); throw new Error('too big'); }
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks); if (!buf.length) throw new Error('size');
    return { ct, buf };
  } finally { clearTimeout(tm); }
}
async function imgFetch(u) {
  const m = u.match(/\/ipfs\/(.+)$/); const urls = [u, ...(m ? IPFS_GW.map((g) => g + m[1]).filter((x) => x !== u) : [])];
  let err; for (const x of urls) { try { return await imgFetchOne(x); } catch (e) { err = e; } } throw err;
}
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (!isAllowedImageUrl(u) || u.length > 2000) return res.status(400).end();
  const key = crypto.createHash('sha1').update(u).digest('hex'); const meta = path.join(IMG_DIR, key + '.json');
  const send = (m) => { res.set({ 'Content-Type': m.ct, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Img-Cache': m.hit ? 'HIT' : 'MISS', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }); res.sendFile(path.join(IMG_DIR, m.file)); };
  try { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); if (fs.existsSync(path.join(IMG_DIR, m.file))) return send({ ...m, hit: true }); } catch { /* 未缓存 */ }
  if ((imgFail.get(key) || 0) > Date.now()) return res.status(404).set('Cache-Control', 'public, max-age=600').end();
  try {
    let p = imgInflight.get(key);
    if (!p) { p = imgFetch(u).then(({ ct, buf }) => { const file = key + '.' + (EXT[ct] || 'img'); fs.writeFileSync(path.join(IMG_DIR, file), buf); const m = { ct, file, url: u }; fs.writeFileSync(meta, JSON.stringify(m)); return m; }).finally(() => imgInflight.delete(key)); imgInflight.set(key, p); }
    send(await p);
  } catch { imgFail.set(key, Date.now() + 600_000); res.status(404).set('Cache-Control', 'public, max-age=600').end(); }
});
app.get('/api/names', (req, res) => {
  const n = market.names; if (!n) return res.json({ ver: 0, names: {} });
  if (Number(req.query.ver) === n.ver) return res.json({ ver: n.ver });
  res.json({ ver: n.ver, names: n.all() });
});

app.get('/api/preview', async (req, res) => {
  const q = req.query;
  res.json(await trader.preview({ walletId: q.wallet, token: q.token, side: q.side, amount: Number(q.amount), slippage: Number(q.slippage || 35) }));
});

// 按代币总量百分比买入：反推需要多少 BNB（多轮报价逼近）
app.get('/api/cost-for-pct', async (req, res) => res.json(await costForPct({ market, trader, live: LIVE }, req.query)));

app.post('/api/order', async (req, res) => {
  const { wallets = ['big'], token, side, amount, slippage, via, clientTs } = req.body;
  try {
    const out = await Promise.all(wallets.map((w) => trader.execute({ walletId: w, token, side, amount, slippage, source: '手动', via: via === 'quick' ? 'quick' : null, clientTs: Number(clientTs) || null })));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 单币规则（发射后领取 / 转出）。转账要本人在页面上点「确认」才会变成 armed
app.get('/api/token-rules', (req, res) => res.json(LIVE ? trader.rulesView() : {}));
app.post('/api/token-rules', (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(trader.setRule(req.body.token, req.body.remove ? null : req.body.patch || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/favorites', (req, res) => res.json(favorites.view()));
app.post('/api/favorites', (req, res) => { try { const v = favorites.op(req.body || {}); broadcast({ type: 'favorites', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/approvals', async (req, res) => { if (!LIVE) return res.json([]); try { res.json(await trader.allowancesView()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/approvals/revoke', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await trader.revokeApproval(String(req.body.token || ''), String(req.body.spender || ''))); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/token-info/:a', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await trader.tokenInfo(req.params.a)); } catch (e) { res.status(400).json({ error: e.shortMessage || e.message }); } });
app.post('/api/swap/quote', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const { from, to, amount, slippage } = req.body; res.json(await trader.swapQuote({ from, to, amount, slippage: Number(slippage) || 1 })); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/swap', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); const { from, to, amount, pct, slippage, clientTs } = req.body; res.json(await trader.swapManual({ from, to, amount, pct: pct != null ? Number(pct) : null, slippage: Number(slippage) || 1, clientTs: Number(clientTs) || null })); });
app.get('/api/blocklist', (req, res) => res.json(blocklist.view()));
app.post('/api/blocklist', (req, res) => { try { const v = blocklist.set(req.body.kind, req.body.address, !!req.body.on, req.body.label); broadcast({ type: 'blocklist', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/config', (req, res) => { try { agent.setConfig(req.body); if (LIVE && Number(req.body?.quickBuy) > 0) trader.saveSetting('quickBuy', Number(req.body.quickBuy)); res.json(agent.config); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/settings', (req, res) => {
  const { maxTradeBnb, sendTo, ...rest } = req.body;   // 转出地址只能在服务器配置里改，页面不能改
  if (maxTradeBnb !== undefined) { if (!LIVE) return res.status(400).json({ error: '只有实盘模式有单笔上限' }); try { trader.setMaxTrade(maxTradeBnb); } catch (e) { return res.status(400).json({ error: e.message }); } }
  if (LIVE && !trader.settings.sendTo && [rest.autoSendAfterClaim, rest.autoSendFourMigrated, rest.autoSendGangMigrated].includes(true)) return res.status(400).json({ error: '没有设置 AUTO_TRANSFER_TO（.env），不能打开自动转出' });
  Object.assign(trader.settings, rest);
  if (LIVE && rest.autoSendAfterClaim !== undefined) { trader.settings.autoSendAfterClaim = rest.autoSendAfterClaim === true; trader.saveSetting('autoSendAfterClaim', trader.settings.autoSendAfterClaim); console.log(`[settings] 领取后自动转出 ${trader.settings.autoSendAfterClaim ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (LIVE && rest.autoSendFourMigrated !== undefined) { trader.settings.autoSendFourMigrated = rest.autoSendFourMigrated === true; trader.saveSetting('autoSendFourMigrated', trader.settings.autoSendFourMigrated); console.log(`[settings] Four 发射后自动转出 ${trader.settings.autoSendFourMigrated ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (LIVE && rest.autoSendGangMigrated !== undefined) { trader.settings.autoSendGangMigrated = rest.autoSendGangMigrated === true; trader.saveSetting('autoSendGangMigrated', trader.settings.autoSendGangMigrated); console.log(`[settings] Gang 发射后自动转出 ${trader.settings.autoSendGangMigrated ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (rest.qbPresets !== undefined) { const q = rest.qbPresets; const ok = q && ['buy', 'sell'].every((k) => Array.isArray(q[k]) && q[k].length === 3 && q[k].every((a) => Array.isArray(a) && a.length === 8 && a.every((v) => Number(v) > 0 && Number(v) <= (k === 'sell' ? 100 : 1000))));
    if (!ok) return res.status(400).json({ error: '预设格式不对' }); trader.settings.qbPresets = q; if (LIVE) trader.saveSetting('qbPresets', q); }
  if (rest.sellToBnb !== undefined) { trader.settings.sellToBnb = rest.sellToBnb !== false; if (LIVE) trader.saveSetting('sellToBnb', trader.settings.sellToBnb); }
  if (rest.preApproveCap !== undefined) { trader.settings.preApproveCap = rest.preApproveCap !== false; if (LIVE) trader.saveSetting('preApproveCap', trader.settings.preApproveCap); }
  if (LIVE && rest.autoClaim !== undefined) { trader.saveSetting('autoClaim', !!rest.autoClaim); if (rest.autoClaim) trader.scanClaims(); } broadcast({ type: 'settings', data: trader.settings }); res.json(trader.settings); });
app.post('/api/wallet/:id', (req, res) => {
  if (LIVE) return res.status(400).json({ error: '实盘行情模式不能修改钱包' });
  const w = trader.wallet(req.params.id);
  const { whitelisted, agentId, faucet } = req.body;
  if (whitelisted != null) w.whitelisted = !!whitelisted;
  if (agentId != null) w.agentId = !!agentId;
  if (faucet) w.bnb += Number(faucet);
  res.json(trader.walletsView());
});
app.post('/api/launch', (req, res) => LIVE ? res.status(400).json({ error: '实盘行情模式不能模拟发射' }) : res.json(market.summary(market.launch(req.body || {}))));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024,
  verifyClient: ({ req }) => isLocalRequest(req, PORT),
});
// 序列化失败只跳过这一帧，不让整个服务崩溃
let badFrameLogged = false;
const broadcast = (msg) => {
  let s;
  try { s = JSON.stringify(msg); } catch (e) { if (!badFrameLogged) { badFrameLogged = true; console.error(`推送 ${msg?.type} 序列化失败，已跳过：${e.message}`); } return; }
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.stack || e));

wss.on('connection', (ws) => {
  ws.sub = null;
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'sub') {
        ws.sub = m.token;
        const send = () => { const d = market.detail(m.token); if (d && ws.sub === m.token) ws.send(JSON.stringify({ type: 'detail', full: true, data: d })); };
        send();
        if (LIVE) market.refresh(m.token).then(send);
      }
    } catch { /* ignore */ }
  });
});

market.on('trade', (t) => broadcast({ type: 'trade', data: t }));
market.on('launch', (s) => broadcast({ type: 'launch', data: s }));
// 实盘行情：选中的代币每 3 秒刷新一次详情
if (LIVE) setInterval(() => new Set([...wss.clients].map((c) => c.sub).filter(Boolean)).forEach((a) => market.refresh(a)), 3000);
market.on('detail', (a) => { for (const c of wss.clients) if (c.readyState === 1 && c.sub === a) c.send(JSON.stringify({ type: 'detail', full: true, data: market.detail(a) })); });
// 订单结束（成交或失败）后马上重读链上余额，3 / 5 / 20 秒后再读一次，等区块和 baw 索引跟上
const resync = async () => { trader.syncAt = 0; if (holdings) holdings.histAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); };
trader.on('order', (o) => { broadcast({ type: 'order', data: o }); if (LIVE && ['filled', 'failed', 'unknown'].includes(o.status)) { for (const ms of [3000, 5000, 20000]) setTimeout(() => resync(), ms); for (const ms of [1500, 6000, 15000]) setTimeout(refreshHoldSnap, ms); } });
trader.on('autoTransfer', (o) => broadcast({ type: 'autoTransfer', data: o }));
trader.on('rules', (r) => broadcast({ type: 'rules', data: r }));
trader.on('settings', (st) => broadcast({ type: 'settings', data: st }));
market.on('migrate', (s) => { if (LIVE && s?.platform === 'four') { trader.syncAt = 0; trader.refreshBalance?.(); } });
agent.on('log', (l) => broadcast({ type: 'log', data: l }));
agent.on('record', (r) => broadcast({ type: 'record', data: r }));
agent.on('config', (c) => broadcast({ type: 'config', data: c }));

setInterval(() => {
  broadcast({ type: 'tick', data: { ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, net, wallets: trader.walletsView(), usage: agent.usageView(), tokens: market.list(), positions: trader.positionsView(), claimable: LIVE ? trader.claimable : [] } });
  for (const c of wss.clients) {
    if (c.readyState !== 1 || !c.sub) continue;
    const d = market.detail(c.sub);
    if (d) c.send(JSON.stringify({ type: 'detail', full: false, data: { ...d, candles: d.candles.slice(-5) } }));
  }
}, 500);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  BSC Agent（${!LIVE ? '模拟盘' : LIVE_TRADE ? `实盘 · 手动可下单，自动策略开启后可下单 · 单笔上限 ${trader.status.maxTradeBnb || '不限'} BNB` : '实盘行情 · 只报价不下单'}）`);
  if (LIVE) console.log(`  baw：${trader.status.connected ? `已连接 ${trader.wallets[0].address}` : `未连接（${trader.status.error}）`}`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
});
