import { Contract, formatUnits } from 'ethers';
import { CopyAuthority } from './engine/live/copyAuthority.js';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { Market, SNIPE_FEE_CURVE } from './engine/market.js';
import { SimTrader, GAS_PRESETS } from './engine/trader.js';
import { Agent } from './engine/agent.js';
import { costForPct } from './engine/live/costForPct.js';
import { Blocklist } from './engine/blocklist.js';
import { Favorites } from './engine/favorites.js';
import { MODE, LIVE_TRADE } from './engine/live/config.js';
import { isLocalRequest, localBoundary, rejectUnsafeBody, isPublicImageUrl, safeLookup, assertPublicHost } from './engine/security.js';
import { loadApiToken, hasApiAccess, apiAuth, tokenMatches } from './engine/apiAuth.js';
import { proxyAgentFor, pfetch, autoProxy, proxyState, trySetProxy } from './engine/netProxy.js';
import { WalletFleet, parsePeers } from './engine/live/walletFleet.js';
import { BAW_DIR, WALLET_LABEL, DATA_DIR as DATA_DIR_UI } from './engine/live/config.js';
import * as latency from './engine/live/latency.js';
import { redactSecrets } from './engine/live/rpc.js';
import { dataFile } from './engine/live/config.js';
import { cache } from './engine/live/cache.js';
import { fairPctBnb } from './engine/live/gangFair.js';
import { mountUpdater } from './engine/updater.js';
import { NftPortfolio } from './engine/live/nftPortfolio.js';
import { nftFeedList, nftFeedOne, readNftFeed } from './engine/nft/feedApi.js';
import { readMintHistory, summarize } from './engine/nft/mintLog.js';
import { AutoMint, scriptRunner } from './engine/nft/autoMint.js';
import { WatchSupervisor } from './engine/nft/watchSupervisor.js';

// 日志脱敏：控制台 / live.log 里出现的 RPC 地址（含 NodeReal key）一律打码
for (const k of ['log', 'info', 'warn', 'error']) { const f = console[k].bind(console); console[k] = (...a) => f(...a.map((x) => (typeof x === 'string' ? redactSecrets(x) : x instanceof Error ? redactSecrets(x.stack || x.message) : x))); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const API_TOKEN = loadApiToken(new URL('./data/api-token', import.meta.url));
const NFT_FEED_FILE = path.join(__dirname, 'data', 'nft-feed.json');
const MINT_LOG_DIR = path.join(__dirname, 'data', 'mint-logs');
const nftAuto = new AutoMint({
  feedFile: NFT_FEED_FILE, stateFile: path.join(__dirname, 'data', 'nft-automint.json'), readFeed: readNftFeed, log: (m) => console.log(m),
  runner: scriptRunner({ script: path.join(__dirname, 'scripts', 'free-mint.mjs'), cwd: __dirname, env: () => nftChildEnv() }),
});
const nftChildEnv = () => {
  const env = { ...process.env, FREE_MINT_SOURCE: 'auto' };
  const proxy = process.env.BSC_AGENT_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) { env.HTTPS_PROXY ||= proxy; env.HTTP_PROXY ||= proxy; env.NODE_USE_ENV_PROXY = '1'; }
  return env;
};
const nftWatcher = new WatchSupervisor({ root: __dirname, log: (m) => console.log(m) });

// MODE=live：真实行情（shrine + Flap Agent Curve Reader + fsi）+ baw 报价/预演；再加 LIVE_TRADE=1 才能真实下单；自动还需本人开启策略
const LIVE = MODE === 'live';
let market, trader, fleet;
let holdSnap = null, holdBusy = false, holdAgain = false;
const WALLET_SLOT = Number(process.env.WALLET_SLOT || 1);
if (!Number.isInteger(WALLET_SLOT) || WALLET_SLOT < 1 || WALLET_SLOT > 99) throw new Error('WALLET_SLOT 无效');
const copyAuthority = new CopyAuthority(API_TOKEN, WALLET_SLOT);
const WALLET_PEERS = [];   // 只支持单钱包
if (WALLET_PEERS.some(p => Number(new URL(p.url).port || 80) === PORT)) throw new Error('钱包 peer 不能指向自身端口');
if (LIVE) {
  const { LiveMarket } = await import('./engine/live/liveMarket.js');
  const { LiveTrader } = await import('./engine/live/liveTrader.js');
  market = new LiveMarket();
  trader = new LiveTrader(market);
  await trader.init();
} else {
  market = new Market();
  trader = new SimTrader(market);
}
const agent = new Agent(market, trader, { live: LIVE, quoteBuy: (q) => costForPct({ market, trader, live: LIVE }, q), stateFile: LIVE ? path.join(__dirname, 'data/automatic-state.json') : null });
if (LIVE) {
  trader.automaticPolicy = (order) => agent.allowAutomatic(order) || copyAuthority.consume(order) || (order.source === '狙击 Gang' && !!sniper?.enabled && sniper.params.dryRun !== true);   // 狙击：本人在页面上点了启动（且没选「试运行」）才真实下单
  trader.status.automaticTrading = LIVE_TRADE && !agent.stateError;
  trader.status.automaticError = agent.stateError;
}
const favorites = new Favorites();
// RPC 用量：每分钟汇总一次（按节点 / 用途 / 方法），打印到控制台并追加到 data/rpc-usage.jsonl；/api/rpc-usage 看最近 60 分钟
const rpcUsageLog = [];
if (LIVE) {
  const { takeUsage, takeCallers, cuOf } = await import('./engine/live/rpc.js');
  const { appendFileSync, mkdirSync } = await import('node:fs');
  setInterval(() => {
    const u = takeUsage(), callers = takeCallers(), nr = Object.entries(u).filter(([k]) => k.startsWith('NodeReal'));
    const total = nr.filter(([k]) => !k.endsWith('|ws_bytes')).reduce((a, [, n]) => a + n, 0);
    const perKey = {}; for (const [k, n] of nr) { const [node, , m] = k.split('|'); const o = (perKey[node] ||= { req: 0, cu: 0 }); if (m !== 'ws_bytes') o.req += n; o.cu += cuOf(m, n); }
    for (const o of Object.values(perKey)) o.cu = Math.round(o.cu);
    const row = { ts: Date.now(), nodereal: total, cu: Object.values(perKey).reduce((a, o) => a + o.cu, 0), perKey, all: Object.values(u).reduce((a, n) => a + n, 0), detail: u, callers };
    rpcUsageLog.push(row); if (rpcUsageLog.length > 60) rpcUsageLog.shift();
    const top = nr.filter(([k]) => !k.endsWith('|ws_bytes')).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`).join('，');
    console.log(`[RPC] 最近 1 分钟 NodeReal ${total} 次 / ${row.cu} CU（${Object.entries(perKey).map(([k, o]) => `${k} ${o.req} 次 ${o.cu} CU`).join('，')}）${top ? '：' + top : ''}`);
    const topC = Object.entries(callers).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}×${n}`).join('，');
    if (topC) console.log(`[RPC] 调用位置前 6（抽样估算，不含重试）：${topC}`);
    try { mkdirSync(path.join(__dirname, 'data'), { recursive: true }); appendFileSync(path.join(__dirname, 'data', 'rpc-usage.jsonl'), JSON.stringify(row) + '\n'); } catch { /* 写不了就算了 */ }
  }, 60_000);
}
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
const selfInfo = () => ({ slot: WALLET_SLOT, expect: trader.expectedWallet || null, label: process.env.WALLET_LABEL || '钱包 ' + WALLET_SLOT, auth: trader.status?.auth?.state || 'checking', agentId: trader.status?.auth?.agentId || null, address: trader.wallets?.[0]?.address || null, bnb: trader.wallets?.[0]?.bnb || 0, dryRun: trader.status?.dryRun !== false, login: trader.statusView?.().login || null, positions: trader.positionsView(), holdings: holdSnap, orders: trader.orders.slice(0, 100) });
const localOrder = async ({ token, side, amount, slippage, via, clientTs, source = '手动', copyGrant = null }) => {
  if (!market.get(token) && LIVE) await market.lookup(token).catch(() => null);
  const automaticAuthorization = String(source).startsWith('跟单 ') ? copyAuthority.authorize({token,side,amount,slippage,source},copyGrant) : null;
  if (String(source).startsWith('跟单 ') && !automaticAuthorization) throw new Error('跟单授权无效或已过期，未下单');
  return [await trader.execute({ walletId: 'baw', automaticAuthorization, token, side, amount, slippage, via: via === 'quick' ? 'quick' : null, clientTs: Number(clientTs) || null, source })];
};
const localQuery = async (path, q) => { if (!market.get(q.token) && LIVE) await market.lookup(q.token).catch(() => null); return path === '/api/preview' ? trader.preview({ walletId: 'baw', token: q.token, side: q.side, amount: Number(q.amount), slippage: Number(q.slippage || 35) }) : costForPct({ market, trader, live: LIVE }, q); };
if (LIVE) {
  fleet = new WalletFleet({ slot: WALLET_SLOT, label: selfInfo().label, peers: WALLET_PEERS, token: API_TOKEN, self: selfInfo, localOrder, localQuery, settings: () => trader.settings, save: (key, value) => { trader.settings[key] = value; trader.saveSetting(key, value); } });
  await fleet.refresh();
}
const walletViews = () => fleet ? fleet.cache : trader.walletsView();
const positionViews = () => fleet ? fleet.positions(trader.positionsView()) : trader.positionsView();
const holdView = () => fleet ? fleet.holdings(holdSnap) : holdSnap;
market.start();

const net = { wss: 302, rpc: 102, detect: 146, detectAt: Date.now() };
setInterval(() => {
  if (LIVE) Object.assign(net, market.netStatus());
  else { net.wss = Math.round(260 + Math.random() * 90); net.rpc = Math.round(80 + Math.random() * 50); }
}, LIVE ? 1000 : 3000);
agent.on('detect', (ms) => { net.detect = ms; net.detectAt = Date.now(); });
const modeInfo = () => ({ mode: LIVE ? 'live' : 'sim', baw: LIVE ? { ...trader.statusView(), localDryRun: trader.status.dryRun, dryRun: fleet.cache.some(w => w.on && !w.dryRun) ? false : trader.status.dryRun } : null });

const app = express();
app.use(localBoundary(PORT));
app.use(apiAuth(API_TOKEN));
app.use(express.json());
app.use(rejectUnsafeBody);
// 强制登录：实盘模式下币安钱包未登录时，所有动用资金的接口一律拒绝（买卖、兑换、换回 BNB、领取、撤销授权、单币转出规则）
const AUTH_GATED = new Set(['/api/order', '/api/swap', '/api/quote-to-bnb', '/api/quote-to-bnb/sweep', '/api/quote-to-bnb/sweep-own', '/api/claim', '/api/approvals/revoke', '/api/token-rules']);
app.use((req, res, next) => {
  if (LIVE && req.method === 'POST' && AUTH_GATED.has(req.path) && !((req.path === '/api/order' || req.path === '/api/quote-to-bnb/sweep') && fleet) && !(req.path === '/api/quote-to-bnb' && Number(req.body?.slot) > 0 && Number(req.body.slot) !== WALLET_SLOT) && trader.status?.auth?.state !== 'ok') return res.status(401).json({ error: '币安钱包未登录', auth: trader.status?.auth?.state });
  next();
});
// 首页：把 app.js / style.css 的版本号换成文件修改时间（每次改动都是新地址，浏览器不会用旧缓存），首页本身不缓存
app.get(['/', '/index.html'], (req, res) => {
  try {
    const pub = path.join(__dirname, 'public'), v = (f) => Math.round(fs.statSync(path.join(pub, f)).mtimeMs);
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/(app\.js|style\.css)\?v=[^"']*/g, (m, f) => `${f}?v=${v(f)}`);
    res.setHeader('Cache-Control', 'no-store'); res.type('html').send(html);
  } catch (e) { res.status(500).send(e.message); }
});
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));   // 每次都向服务器确认有没有更新（没变就 304），避免浏览器一直用旧的 app.js / style.css
mountUpdater(app, { rootDir: __dirname });   // 版本提示（只提示你自己仓库的新版本，不自动更新）

const state = () => ({
  ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, gangMcap: market.gangMcap || 0, net,
  wallets: walletViews(), settings: trader.settings, gasPresets: GAS_PRESETS, config: agent.config, usage: agent.usageView(),
  tokens: market.list(), positions: positionViews(), snipeCurve: SNIPE_FEE_CURVE, claimable: LIVE ? trader.claimable : [],
});

app.post('/api/claim', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式能领取' }); res.json(await trader.claimOne(req.body.market, '手动领取')); });
app.post('/api/auth/login', async (req, res) => { try { res.json(LIVE ? loginView(await trader.startLogin()) : null); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/auth/login-cancel', (req, res) => { res.json(LIVE ? loginView(trader.cancelLogin()) : null); });
app.post('/api/auth/check', async (req, res) => res.json(LIVE ? await trader.checkAuth() : null));
setTimeout(() => { for (const o of [...trader.orders].reverse()) latency.record(o); }, 5000);   // 启动时把内存里已有订单补记一次（按 id/tx 去重）
app.get('/api/latency-stats', (req, res) => res.json(latency.stats(Math.max(0.01, Number(req.query.days) || 1))));
app.get('/api/state', (req, res) => res.json({ ...state(), holdings: holdView(), orders: fleet ? fleet.orderViews(trader.orders).slice(0, 100) : trader.orders.slice(0, 100), logs: agent.logs.slice(0, 150), records: agent.records, flow: market.named ? market.named(market.flow.slice(0, 80)) : market.flow.slice(0, 80) }));
app.get('/api/nft/feed', (req, res) => res.json({ rows: nftFeedList(NFT_FEED_FILE, { eligible: req.query.eligible === '1', since: req.query.since, limit: req.query.limit }), updatedAt: Date.now(), execution: { mode: 'preview', sendsTransactions: false } }));
app.get('/api/nft/feed/:contract', (req, res) => { const row = nftFeedOne(NFT_FEED_FILE, req.params.contract); row ? res.json(row) : res.status(404).json({ error: '没有找到这个 NFT 项目' }); });
app.get('/api/nft/mint-history', (req, res) => {
  const since = Math.max(0, Number(req.query.since) || 0), rows = readMintHistory(MINT_LOG_DIR, { limit: req.query.limit, since });
  res.json({ rows, summary: summarize(rows) });
});
// NFT 自动 mint 任务（免费才自动；付费永远手动）。开启后真实发送免费 mint；规则里勾「试运行」则只检查
app.get('/api/nft/auto', (req, res) => res.json({ ...nftAuto.view(), canExecute: LIVE && LIVE_TRADE, watcher: nftWatcher.status() }));
app.post('/api/nft/auto', (req, res) => {
  const b = req.body || {};
  const nextOn = typeof b.enabled === 'boolean' ? b.enabled : nftAuto.state.enabled, nextDry = typeof b.rules?.dry === 'boolean' ? b.rules.dry : nftAuto.state.rules.dry;
  if (nextOn && !nextDry && !(LIVE && LIVE_TRADE)) return res.status(400).json({ error: '当前是只看不下单模式（LIVE_TRADE=0），只能用试运行' });
  res.json({ ...nftAuto.configure({ enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, rules: b.rules && typeof b.rules === 'object' ? b.rules : undefined }), canExecute: LIVE && LIVE_TRADE, watcher: nftWatcher.status() });
});

// 地址追踪与跟单：新任务默认暂停 + 模拟，只有用户明确启动后才会运行。
let tracker = null;
if (LIVE) {
  const { Tracker } = await import('./engine/live/tracker.js');
  const placeTrackedOrder = async ({ token, side, amount, slippage, source, slots, taskId }) => {
    const task=tracker.tasks.find(t=>t.id===taskId);
    if(!LIVE_TRADE || !task || task.status!=='running' || task.params.dryRun || tracker.allPaused) throw new Error('任务未获真实跟单授权');
    if(slots.some(slot=>!task.params.wallets.includes(slot) && !(side==='sell' && task.tokens[token]?.lots?.[slot]?.qty>0))) throw new Error('执行钱包不属于该任务');
    await fleet.refresh();
    return (await Promise.all(slots.map(slot=>{
      const secret=slot===WALLET_SLOT?API_TOKEN:(WALLET_PEERS.find(p=>p.slot===slot)?.token||API_TOKEN);
      const order={token,side,amount,slippage,source:String(source||'跟单 '+task.name).slice(0,80),taskId,slot};
      return fleet.orders({slots:[slot],...order,copyGrant:copyAuthority.issue(order,secret)});
    }))).flat();
  };
  const walletBalance = async (slot,token) => {
    const w=fleet.cache.find(w=>w.slot===Number(slot));if(!w?.address||w.auth!=='ok')throw new Error('执行钱包未连接');
    const erc=new Contract(token,['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)'],market.provider);
    const [balance,decimals]=await Promise.all([erc.balanceOf(w.address),erc.decimals()]);return Number(formatUnits(balance,decimals));
  };
  tracker = new Tracker({ market, provider: market.provider, placeOrder: placeTrackedOrder, walletBalance, log: (m) => console.log(m) });
  market.on('trade', (t) => tracker.onTrade(t).catch(() => {}));
  tracker.on('reload', () => broadcast({ type: 'trackReload', data: {} }));
  tracker.on('event', (e) => broadcast({ type: 'track', data: e }));
  tracker.on('targets', (v) => broadcast({ type: 'trackTargets', data: v }));
  tracker.on('tasks', (v) => broadcast({ type: 'copyTasks', data: v }));
  tracker.on('log', (r) => broadcast({ type: 'copyLog', data: r }));
}
const trackerOnly = (res) => { if (!tracker) { res.status(400).json({ error: '只有实盘模式支持地址追踪和跟单' }); return false; } return true; };
app.get('/api/track', (req, res) => { if (!trackerOnly(res)) return; const page = tracker.feedPage(); res.json({ ...tracker.targetsView(), feed: page.items, more: page.more, nextCursor: page.nextCursor }); });
app.get('/api/track/feed', (req, res) => { if (!trackerOnly(res)) return; try { res.json(tracker.feedPage({ before: req.query.before === undefined ? Infinity : Number(req.query.before), cursor: req.query.cursor, limit: req.query.limit })); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/track/backfill', async (req, res) => { if (!trackerOnly(res)) return; try { res.json(await tracker.backfill(tracker.targets.map(t => t.address))); } catch { res.status(502).json({ error: '历史回补失败，请稍后重试' }); } });
app.post('/api/track/targets', (req, res) => { if (!trackerOnly(res)) return; try { const b = req.body || {}; if (b.remove) tracker.removeTarget(b.address); else tracker.addTarget(b); res.json(tracker.targetsView()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/copy', (req, res) => { if (!trackerOnly(res)) return; res.json({ ...tracker.tasksView(), execution: {live:LIVE_TRADE,reason:LIVE_TRADE?null:'LIVE_TRADE 未开启，不能真实下单',takeProfitStopLoss:true}, log: tracker.log.slice(0, 300) }); });
app.post('/api/copy/tasks', (req, res) => { if (!trackerOnly(res)) return; try { const b = req.body || {}; if (b.params) b.params.wallets = [1]; /* 只支持单钱包 */ if (b.remove && b.id) { const t0 = tracker.tasks.find((x) => x.id === b.id); if (t0 && t0.status !== 'closed') tracker.updateTask(b.id, { status: 'closed' }); return res.json(tracker.deleteTask(b.id)); } res.json(b.id ? tracker.updateTask(b.id, b) : tracker.createTask(b)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/copy/pause-all', (req, res) => { if (!trackerOnly(res)) return; tracker.setAllPaused(req.body?.paused !== false); res.json(tracker.tasksView()); });
// 全站急停：跟单全部暂停 + 狙击关闭（不动已买的币）。再次启动要你手动点
app.post('/api/pause-everything', (req, res) => {
  const done = [];
  try { if (tracker) { tracker.setAllPaused(true); done.push('跟单'); } } catch {}
  try { if (typeof sniper !== 'undefined' && sniper?.enabled) { sniper.setEnabled(false); done.push('狙击'); } } catch {}
  try { if (nftAuto.view().enabled) { nftAuto.configure({ enabled: false }); done.push('NFT 自动 mint'); } } catch {}
  res.json({ ok: true, paused: done });
});
// 系统自检：一眼看出哪里没配好（只返回是/否和说明，不含地址、余额、名字）
// 代理：页面里手动保存过的优先；没有就自动找（先直连，不通再读系统代理、试常见端口）。每 3 分钟没通就再找一次
const PROXY_FILE = path.join(__dirname, 'data/proxy.json');
try { const sv = JSON.parse(fs.readFileSync(PROXY_FILE, 'utf8')); if (sv?.url && !process.env.BSC_AGENT_PROXY) process.env.BSC_AGENT_PROXY = sv.url; } catch { /* 没存过 */ }
autoProxy().catch(() => {});
setInterval(() => { if (proxyState().mode === 'none') autoProxy(true).catch(() => {}); }, 180_000);
app.post('/api/proxy', async (req, res) => {
  const r = await trySetProxy(req.body?.url);
  if (r.ok) { try { fs.mkdirSync(path.dirname(PROXY_FILE), { recursive: true }); fs.writeFileSync(PROXY_FILE, JSON.stringify({ url: r.url })); } catch { /* 存不了也先用着 */ } }
  res.status(r.ok ? 200 : 400).json(r);
});
app.get('/api/selfcheck', async (req, res) => {
  const st = trader?.status || {}, items = [];
  const add = (name, ok, tip) => items.push({ name, ok: !!ok, tip: ok ? '' : tip });
  add('实盘模式', LIVE, '没有开实盘：启动时需要 MODE=live（用 start.sh 会自动带上）');
  add('允许真实下单', LIVE && LIVE_TRADE, '没有开真实下单：.env 里设 LIVE_TRADE=1，然后重启');
  add('币安 Agentic 钱包已登录', st.auth?.state === 'ok', '还没登录：页面中间会弹出登录窗口，点「登录币安钱包」，按提示在币安 App 里确认配对码；没弹出就点右上角「币安钱包未登录」');
  add('钱包连接正常', LIVE && st.connected !== false && !st.error, st.error ? '连接出错：' + String(st.error).slice(0, 80) : '钱包没连上，检查网络和代理');
  const pingNet = async () => { try { const r = await pfetch('https://api.dexscreener.com/latest/dex/search?q=bnb', { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } }); return r.ok; } catch { return false; } };
  let netOk = await pingNet(); if (!netOk) { await autoProxy(true).catch(() => {}); netOk = await pingNet(); }
  const ps = proxyState();
  items.push({ key: 'net', name: '能连上行情站（头像 / 池子 / K 线）' + (netOk && ps.mode === 'proxy' ? `，已走代理 ${ps.url.replace(/^https?:\/\//, '')}` : ''), ok: netOk, tip: netOk ? '' : '没找到能用的代理。请先打开你的代理软件（Clash / V2Ray 等），再点「重新检查」；还不行就把代理软件里的 HTTP 代理地址填在下面。' });
  add('自动转出地址', !!trader?.settings?.sendTo, '没设置也能用；想自动转出，在底部「自动转出」里填你自己的地址');
  add('追踪 / 跟单模块', !!tracker, '只有实盘主后端支持追踪和跟单');
  add('狙击模块', typeof sniper !== 'undefined' && !!sniper, '只有实盘主后端支持狙击');
  res.json({ items, ready: items.slice(0, 5).every((x) => x.ok) });
});
// 「下单耗时」页面（latency.html）：本钱包 + 其他钱包后端的每笔买卖耗时（own=1 只返回本钱包，给主后端汇总用）
app.get('/api/latency/orders', async (req, res) => {
  const days = Math.min(90, Math.max(0.01, Number(req.query.days) || 7));
  const rows = latency.ordersView(days, WALLET_LABEL).map((r) => ({ ...r, slot: WALLET_SLOT })), wallets = [{ slot: WALLET_SLOT, label: WALLET_LABEL, ok: true }];
  if (fleet && req.query.own !== '1') await Promise.all((fleet.peers || []).map(async (p) => {
    const label = p.label || `钱包 ${p.slot}`;
    try { const v = await fleet.query(fleet.id(p.slot), '/api/latency/orders', { own: '1', days }); for (const r of v?.rows || []) rows.push({ ...r, wallet: label, slot: p.slot }); wallets.push({ slot: p.slot, label, ok: true }); }
    catch (e) { wallets.push({ slot: p.slot, label, ok: false, error: e.status === 404 ? '这个钱包后端还没更新到有耗时接口的版本' : e.message }); }
  }));
  rows.sort((a, b) => b.ts - a.ts); wallets.sort((a, b) => a.slot - b.slot);
  res.json({ days, now: Date.now(), stages: latency.STAGES, wallets, rows });
});
// Agent ID 门槛盘：每个钱包持有几个门槛 NFT
async function nftHolders(nft) {
  const list = (fleet?.cache?.length ? fleet.cache : [{ slot: WALLET_SLOT, label: WALLET_LABEL, address: trader.wallets?.[0]?.address }]).filter((w) => w.address);
  return Promise.all(list.map(async (w) => ({ slot: w.slot, label: w.label, address: w.address, n: await trader.flapNft.holds(nft, w.address).catch(() => null) })));
}
// 持仓快照：后台每 5 秒算一次（下单 / 领取 / 转账结束后立刻再算），通过 WebSocket 推给页面、也放进 /api/state，
// 页面打开详情时直接用快照，不再每次现算（现算要读钱包历史和链上报价，慢）
async function refreshHoldSnap() {
  if (!holdings) return; if (holdBusy) { holdAgain = true; return; } holdBusy = true;
  try { holdSnap = await holdings.view(); broadcast({ type: 'holdings', data: holdView() }); } catch { /* 下次再算 */ }
  holdBusy = false; if (holdAgain) { holdAgain = false; setTimeout(refreshHoldSnap, 200); }
}
if (holdings) { setTimeout(refreshHoldSnap, 3000); setInterval(refreshHoldSnap, 5000); }
app.get('/api/holdings', async (req, res) => {
  if (!holdings) return res.json({ rows: [], totals: {}, bnb: 0 });
  if (req.query.refresh) { trader.syncAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); await holdings.loadHistory(true).catch(() => {}); holdSnap = await holdings.view(); broadcast({ type: 'holdings', data: holdView() }); return res.json(holdView()); }
  if (!holdSnap) holdSnap = await holdings.view(); res.json(holdView());
});
const nftPortfolio = new NftPortfolio({ directory: path.join(__dirname, 'data', 'mint-logs'), provider: market.provider });
app.get('/api/nft-holdings', async (req, res) => {
  if (!LIVE) return res.json({ rows: [], scope: '模拟盘不读取 NFT' });
  const wallet = trader.wallets?.[0]?.address;
  const result = await nftPortfolio.read(wallet);
  res.json({ ...result, wallet: wallet || null, walletLabel: WALLET_LABEL });
});
// ---------- 兼容层：把他的多钱包写法接到你的 WalletFleet 上 ----------
const loginView = (l) => (l ? { id: l.id, state: l.state, urlForWeb: l.urlForWeb, pairingCode: l.pairingCode, expireAt: l.expireAt, message: l.message, address: l.address || null } : null);
const walletOn = (slot) => (fleet ? fleet.enabled(slot) === true : slot === WALLET_SLOT);
const peerFetch = (peer, p, body, ms = 5000) => fleet.call(peer, p, body === null ? undefined : body, ms);
const walletsView = async () => (!LIVE ? [] : fleet ? await fleet.refresh() : trader.walletsView());
// 狙击 / 其他自动来源下单：走你的钱包队列；非「手动」来源没有策略授权就只模拟，不会真实上链
async function placeOrder({ wallets, token, side, amount, slippage, via, clientTs, slots, source = '手动', symbol = null }) {
  const o = { token, side, amount, slippage, via: via === 'quick' ? 'quick' : null, clientTs: Number(clientTs) || null, source: String(source || '手动').slice(0, 80), symbol: symbol ? String(symbol).slice(0, 32) : null };
  if (fleet) return fleet.orders({ ...(slots ? { slots } : wallets ? { wallets } : {}), ...o });
  return Promise.all((wallets?.length ? wallets : ['big']).map((w) => trader.execute({ walletId: w, ...o })));
}
// 计价币余额与一键换回 BNB（只在点击后执行；先 preview 给确认框看报价）
// 按钱包：?slot= / body.slot 是其他钱包时转给它自己的后端；不填 slot = 本钱包（其他后端合并时用）。?slot=0 = 所有「参与下单」的钱包，每行带 slot / label
const quotePeer = (slot) => (Number(slot) > 0 && Number(slot) !== WALLET_SLOT ? WALLET_PEERS.find((x) => x.slot === Number(slot)) || { missing: true } : null);
app.get('/api/quote-balances', async (req, res) => {
  if (!LIVE) return res.json([]);
  if (req.query.slot === undefined) { try { return res.json(await trader.quoteBalances()); } catch (e) { return res.status(500).json({ error: e.message }); } }
  const ws = sweepTargets(req.query.slot); const errs = [];
  const parts = await Promise.all(ws.map(async (w) => { try { return (w.self ? await trader.quoteBalances() : await peerFetch(w.peer, '/api/quote-balances', null, 30_000)).map((r) => ({ ...r, slot: w.slot, label: w.label })); } catch (e) { errs.push(`${w.label}：${e.message}`); return []; } }));
  if (errs.length && errs.length === ws.length) return res.status(500).json({ error: errs.join('；') });
  res.json(parts.flat());
});
app.post('/api/quote-to-bnb/preview', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' });
  const p = quotePeer(req.body.slot); if (p?.missing) return res.status(400).json({ error: '没有这个钱包' });
  try { res.json(p ? await peerFetch(p, '/api/quote-to-bnb/preview', { token: req.body.token, slippage: req.body.slippage }, 60_000) : await trader.quoteToBnbPreview(String(req.body.token || ''), Number(req.body.slippage) || 1)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/quote-to-bnb', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' });
  const p = quotePeer(req.body.slot); if (p?.missing) return res.status(400).json({ error: '没有这个钱包' });
  if (!p) return res.json(await trader.quoteToBnb({ token: String(req.body.token || ''), slippage: Number(req.body.slippage) || 1 }));
  const label = p.label || `钱包 ${p.slot}`;
  try { const o = await peerFetch(p, '/api/quote-to-bnb', { token: req.body.token, slippage: req.body.slippage }, 600_000); const x = { ...o, id: `w${p.slot}-${o.id}`, wallet: label, walletSlot: p.slot }; broadcast({ type: 'order', data: x }); res.json(x); }
  catch (e) { res.json({ status: 'failed', side: 'sell', wallet: label, walletSlot: p.slot, symbol: '换回 BNB', reason: e.status === 401 ? '币安钱包未登录' : e.name === 'TimeoutError' ? '等结果超时（可能已经在执行，请看订单记录，不要重复点）' : e.message }); }
});
// 一键全部换回 BNB：*-own 每个钱包后端都有（只管自己的钱包）；plan / sweep 由主后端分发给各钱包（slot = 只那一个钱包；不填 = 所有「参与下单」的钱包）。
// plan 只报价不发交易；sweep 只换页面确认框里列出的钱包 × 币（plan 已经按钱包选择过滤），各钱包同时执行、同一个钱包内按顺序
const sweepTargets = (slot) => { const all = [{ slot: WALLET_SLOT, label: WALLET_LABEL, self: true }, ...WALLET_PEERS.map((p) => ({ slot: p.slot, label: p.label || `钱包 ${p.slot}`, peer: p }))]; return slot === 'any' ? all : Number(slot) > 0 ? all.filter((w) => w.slot === Number(slot)) : all.filter((w) => walletOn(w.slot)); };
const sweepErr = (e) => (e.status === 401 ? '币安钱包未登录' : e.message);
app.post('/api/quote-to-bnb/plan-own', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' }); try { res.json(await trader.quoteSweepPlan(Number(req.body?.slippage) || 1)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/quote-to-bnb/sweep-own', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' }); res.json(await trader.quoteSweep({ tokens: Array.isArray(req.body?.tokens) ? req.body.tokens.slice(0, 30) : [], slippage: Number(req.body?.slippage) || 1 })); });
app.post('/api/quote-to-bnb/plan', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' });
  const ws = sweepTargets(req.body?.slot), slippage = Number(req.body?.slippage) || 1; if (!ws.length) return res.status(400).json({ error: '没有开启「参与下单」的钱包' });
  res.json(await Promise.all(ws.map(async (w) => {
    try { return { slot: w.slot, label: w.label, ...(w.self ? await trader.quoteSweepPlan(slippage) : await peerFetch(w.peer, '/api/quote-to-bnb/plan-own', { slippage }, 120_000)) }; }
    catch (e) { return { slot: w.slot, label: w.label, items: [], skipped: [], error: sweepErr(e) }; }
  })));
});
app.post('/api/quote-to-bnb/sweep', async (req, res) => {   // { plan: [{ slot, tokens }], slippage }
  if (!LIVE) return res.status(400).json({ error: '只有实盘模式可用' });
  const want = new Map((Array.isArray(req.body?.plan) ? req.body.plan : []).map((x) => [Number(x.slot), (Array.isArray(x.tokens) ? x.tokens : []).map(String).slice(0, 30)]));
  const ws = sweepTargets('any').filter((w) => want.get(w.slot)?.length), slippage = Number(req.body?.slippage) || 1;
  if (!ws.length) return res.status(400).json({ error: '没有要换的币' });
  res.json(await Promise.all(ws.map(async (w) => {
    const tag = (o) => ({ ...o, wallet: w.label, walletSlot: w.slot, ...(w.self ? {} : { id: `w${w.slot}-${o.id || Date.now()}` }) });
    try {
      if (w.self && trader.status?.auth?.state !== 'ok') throw Object.assign(new Error('币安钱包未登录'), { status: 401 });
      const r = w.self ? await trader.quoteSweep({ tokens: want.get(w.slot), slippage }) : await peerFetch(w.peer, '/api/quote-to-bnb/sweep-own', { tokens: want.get(w.slot), slippage }, 900_000);
      const orders = (r || []).map(tag); if (!w.self) orders.forEach((o) => broadcast({ type: 'order', data: o }));
      return { slot: w.slot, label: w.label, orders };
    } catch (e) { return { slot: w.slot, label: w.label, orders: [], error: e.name === 'TimeoutError' ? '等结果超时（可能已经在执行，请看钱包 / 订单记录，不要重复点）' : sweepErr(e) }; }
  })));
});
app.get('/api/trades/:token', async (req, res) => { try { const v = LIVE ? await market.tradesPage(req.params.token, Number(req.query.before) || 0, Math.min(500, Number(req.query.limit) || 100)) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/trader/:token/:addr', async (req, res) => { try { const v = LIVE ? await market.traderStats(req.params.token, req.params.addr) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/holders/:token', async (req, res) => { try { const v = LIVE ? await market.holders(req.params.token) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });   // HOLDERS_FEATURE 详情页「持有人」
app.get('/api/rpc-usage', (req, res) => res.json(rpcUsageLog));
app.get('/api/cache-status', (req, res) => res.json(cache.status()));   // 历史数据缓存（MySQL / Redis）是否启用、连上没有、命中次数
cache.mysql(); cache.redis();   // 启动时先连一下（没配置就什么都不做），日志里能看到连上没有
// 页面布局偏好（左侧钱包追踪栏开 / 关、宽度）：服务器也存一份，浏览器数据丢了或换了地址也能恢复
const UI_PREFS = path.join(DATA_DIR_UI, 'ui-prefs.json');
app.get('/api/ui-prefs', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(UI_PREFS, 'utf8'))); } catch { res.json({}); } });
app.post('/api/ui-prefs', (req, res) => {
  const b = req.body || {}, cur = (() => { try { return JSON.parse(fs.readFileSync(UI_PREFS, 'utf8')); } catch { return {}; } })();
  if (typeof b.trkPanel === 'boolean') cur.trkPanel = b.trkPanel; if (Number(b.trkPanelW) > 0) cur.trkPanelW = Math.min(640, Math.max(260, Number(b.trkPanelW)));
  try { fs.mkdirSync(path.dirname(UI_PREFS), { recursive: true }); fs.writeFileSync(UI_PREFS, JSON.stringify(cur)); } catch { /* ignore */ }
  res.json(cur);
});
// ---------- Gang 新盘狙击（只在实盘主后端；默认关闭 + 模拟，本人在顶栏「狙击」模块里打开）----------
let sniper = null;
if (LIVE && WALLET_SLOT === 1) {
  const { Sniper } = await import('./engine/live/sniper.js');
  const { wbnbTopUp } = await import('./engine/live/sniper.js');
  // 预备 WBNB：本钱包直接做，其他钱包发给它们自己的后端（/api/snipe/float）
  const floatFn = (target, slots) => Promise.all(slots.map((slot) => slot === WALLET_SLOT ? wbnbTopUp(trader, target, LIVE_TRADE)
    : (() => { const p = WALLET_PEERS.find((x) => x.slot === slot); return p ? peerFetch(p, '/api/snipe/float', { target }, 60_000).catch((e) => ({ wallet: p.label || `钱包 ${slot}`, error: e.message })) : { wallet: `钱包 ${slot}`, skip: '没有这个钱包' }; })()));
  sniper = new Sniper({ market, trader, placeOrder, floatFn, isBlocked: (t) => blocklist.has(t), log: (m) => console.log(m) });
  sniper.on('state', (v) => broadcast({ type: 'snipeState', data: v }));
  sniper.on('log', (r) => { broadcast({ type: 'snipeLog', data: r }); if (r.kind !== 'skip') console.log(`[狙击] ${r.symbol} ${r.kind}：${r.reason}`); });
}
// 交易节点保持热连接（每个钱包后端都做）：冷连接第一次读链要 0.7～1.8 秒，狙击时钱包 2 的后端也要马上能读曲线、模拟
if (LIVE) setInterval(() => trader.gangV2?.provider?.getBlockNumber?.().catch(() => {}), 10_000);
// 每个钱包后端都有：把自己钱包的 WBNB 补到 target（主后端的狙击调用；只在 LIVE_TRADE=1 时真的包装）
app.post('/api/snipe/float', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const { wbnbTopUp } = await import('./engine/live/sniper.js'); res.json(await wbnbTopUp(trader, Math.min(2, Math.max(0, Number(req.body?.target) || 0)), LIVE_TRADE)); } catch (e) { res.status(400).json({ error: e.message }); } });
const needSniper = (res) => { if (!sniper) { res.status(400).json({ error: '只有实盘主后端支持狙击' }); return false; } return true; };
app.get('/api/snipe', (req, res) => { if (!needSniper(res)) return; res.json({ ...sniper.view(), log: sniper.log.slice(0, 300) }); });
app.post('/api/snipe', (req, res) => {   // { params } 改参数；{ enabled: true/false } 开 / 关（急停 = enabled:false）
  if (!needSniper(res)) return; const b = req.body || {};
  try { if (b.params) sniper.update(b.params); if (b.forget) sniper.forget(b.forget); if (b.enabled !== undefined) sniper.setEnabled(b.enabled === true); res.json(sniper.view()); } catch (e) { res.status(400).json({ error: e.message }); }
});
const needTracker = (res) => { if (!tracker) { res.status(400).json({ error: '只有实盘主后端支持追踪 / 跟单' }); return false; } return true; };
/* (重复路由已合并到前面同名的实现) */
app.get('/api/track/resolve', async (req, res) => {   // .ai / .bnb 域名 → 地址
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  const name = String(req.query.name || '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(name)) return res.json({ address: name, name: market.names?.peek?.(name) || null });
  if (!/^[a-z0-9-_.]+\.[a-z]+$/.test(name)) return res.status(400).json({ error: '请填 .ai / .bnb 域名或 0x 地址' });
  try { const { resolveDomain } = await import('./engine/live/baw.js'); const d = await resolveDomain(name); if (!d?.address) throw new Error('没有解析到地址'); res.json({ address: String(d.address).toLowerCase(), name }); }
  catch (e) { res.status(400).json({ error: `解析失败：${e.message}` }); }
});
/* (重复路由已合并到前面同名的实现) */   // 追踪历史往回翻
/* (重复路由已合并到前面同名的实现) */
/* (重复路由已合并到前面同名的实现) */
/* (重复路由已合并到前面同名的实现) */
/* (重复路由已合并到前面同名的实现) */
app.get('/api/wallet-info', (req, res) => res.json(LIVE ? selfInfo() : null));
// 登录遮罩下的网络检测（只读，返回里不带任何密钥 / 节点地址）：币安接口（baw 连的 WALLET_API_URL，默认 www.binance.com；配了代理就经代理）、
// BSC 节点池 eth_blockNumber、本机代理端口。每项 5 秒超时；超过 NETCHECK_SLOW_MS（默认 1500ms）算高延迟
const NET_SLOW_MS = Number(process.env.NETCHECK_SLOW_MS || 1500), NET_TO = 5000;
const proxyUrl = () => { const v = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy; try { return v ? new URL(v) : null; } catch { return null; } };
const netTimed = async (name, fn) => {
  const t0 = Date.now(); let tm;
  try { const detail = await Promise.race([fn(), new Promise((_, no) => { tm = setTimeout(() => no(new Error('超时（5 秒）')), NET_TO); })]); const ms = Date.now() - t0; return { name, state: ms > NET_SLOW_MS ? 'slow' : 'ok', ms, detail: detail ?? null }; }
  catch (e) { return { name, state: 'fail', ms: Date.now() - t0, reason: String(e.code || e.message || e).slice(0, 100) }; }
  finally { clearTimeout(tm); }
};
const tcpOpen = (host, port) => new Promise((ok, no) => { const s = tcpConnect({ host, port }, () => { s.destroy(); ok(); }); s.on('error', no); });
const tlsHead = (opts, host) => new Promise((ok, no) => {   // 发一个 HEAD 请求，收到状态行就算通（不管状态码）
  const t = tls.connect({ ...opts, servername: host }, () => t.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nUser-Agent: bsc-agent-netcheck\r\n\r\n`));
  t.once('data', (d) => { const m = /^HTTP\/1\.[01] (\d{3})/.exec(d.toString('latin1')); t.destroy(); m ? ok(`HTTP ${m[1]}`) : no(new Error('响应格式不对')); });
  t.on('error', no); t.setTimeout(NET_TO, () => t.destroy(new Error('超时')));
});
const httpsHead = (u) => new Promise((ok, no) => {
  const url = new URL(u), host = url.hostname, port = Number(url.port || 443), px = proxyUrl();
  if (!px) return tlsHead({ host, port }, host).then(ok, no);
  const headers = px.username ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(px.username)}:${decodeURIComponent(px.password)}`).toString('base64') } : {};
  const r = http.request({ host: px.hostname, port: Number(px.port || 80), method: 'CONNECT', path: `${host}:${port}`, headers });
  r.on('connect', (res, sock) => { if (res.statusCode !== 200) { sock.destroy(); return no(new Error(`代理返回 ${res.statusCode}`)); } tlsHead({ socket: sock }, host).then(ok, no); });
  r.on('error', no); r.end();
});
async function netCheckOwn() {
  const px = proxyUrl(), api = process.env.WALLET_API_URL || 'https://www.binance.com', host = new URL(api).hostname;
  return Promise.all([
    netTimed(`币安接口 ${host}${px ? `（经代理 ${px.host}）` : ''}`, () => httpsHead(api)),
    netTimed('BSC 节点（eth_blockNumber）', async () => '#' + await market.provider.getBlockNumber()),
    ...(px ? [netTimed(`本机代理 ${px.host}`, () => tcpOpen(px.hostname, Number(px.port || 80)))] : []),
  ]);
}
app.get('/api/netcheck', async (req, res) => {
  if (req.query.own) return res.json(await netCheckOwn());
  res.json(await Promise.all([{ slot: WALLET_SLOT, label: WALLET_LABEL, self: true }, ...WALLET_PEERS.map((p) => ({ slot: p.slot, label: p.label || `钱包 ${p.slot}`, peer: p }))].map(async (w) => {
    if (w.self) return { slot: w.slot, label: w.label, items: await netCheckOwn() };
    const t0 = Date.now();
    try { return { slot: w.slot, label: w.label, items: await peerFetch(w.peer, '/api/netcheck?own=1', null, 12_000) }; }
    catch (e) { return { slot: w.slot, label: w.label, items: [{ name: '钱包后端', state: 'fail', ms: Date.now() - t0, reason: String(e.message).slice(0, 100) }] }; }
  })));
});
// 页面上按钱包点「登录」/「取消」：本钱包由自己的 baw 登录；其他钱包把请求转给它自己的后端（钱包 2 在 Docker 容器里用容器里的 baw 登录，绝不在本机为它发起）
app.post('/api/wallets/login', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘支持' });
  const slot = Number(req.body?.slot), cancel = !!req.body?.cancel;
  try {
    if (slot === WALLET_SLOT) return res.json(loginView(cancel ? trader.cancelLogin() : await trader.startLogin()));
    const p = WALLET_PEERS.find((x) => x.slot === slot); if (!p) return res.status(400).json({ error: '没有这个钱包' });
    res.json(await peerFetch(p, cancel ? '/api/auth/login-cancel' : '/api/auth/login', {}, 40_000));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/wallets', async (req, res) => res.json(LIVE ? await walletsView() : []));
app.post('/api/wallets', (req, res) => {   // 某个钱包是否「参与下单」（存在主后端的设置里）
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  const slot = Number(req.body?.slot); if (!slot) return res.status(400).json({ error: '缺少 slot' });
  trader.settings.walletOn = { ...(trader.settings.walletOn || {}), [slot]: req.body.on !== false }; trader.saveSetting('walletOn', trader.settings.walletOn);
  walletsView().then((v) => { broadcast({ type: 'wallets', data: v }); res.json(v); });
});
if (LIVE && WALLET_PEERS.length) setInterval(() => walletsView().then((v) => broadcast({ type: 'wallets', data: v })).catch(() => {}), 10_000);
app.get('/api/lookup/:a', async (req, res) => {
  // 搜索：最多等 1.5 秒（链上查 Four 盘）；查不到 = 不是本终端跟踪的内盘（外盘 / 已毕业 / 其他平台），页面改为打开 GMGN
  const t = LIVE ? await Promise.race([market.lookup(req.params.a).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]) : (market.get(req.params.a) ? market.summary(market.get(req.params.a)) : null);
  t ? res.json(t) : res.status(404).json({ error: '未找到该代币', external: true });
});
// 鼠标移到币上就先把详情和 K 线历史拉好（点进去时已经有了）；各币有自己的节流，重复调用不会重复请求
app.get('/api/warm/:a', (req, res) => { if (LIVE && /^0x[0-9a-fA-F]{40}$/.test(req.params.a)) market.refresh(req.params.a.toLowerCase()).catch(() => {}); res.status(204).end(); });
app.get('/api/token/:a', async (req, res) => {
  // 已经有 K 线缓存就立刻返回，后台刷新由 WebSocket 推送；第一次打开的币才等拉取
  if (LIVE) { const c = market.detail(req.params.a)?.candles?.length; if (c > 0) market.refresh(req.params.a).catch(() => {}); else await market.refresh(req.params.a); }
  const d = market.detail(req.params.a); if (!d) return res.status(404).json({ error: '代币不存在' });
  if (LIVE && d.nftGate) d.nftGate = { ...d.nftGate, wallets: await nftHolders(d.nftGate.nft).catch(() => []) };
  res.json(d);
});
// 地址 → 域名本地映射（前端定时拉取，ver 不变就返回空）
// 代币头像代理缓存：/api/img?u=<url> → data/img/<sha1>.<ext>，命中直接读盘，浏览器端 immutable 长缓存
const IMG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const imgInflight = new Map(), imgFail = new Map();
const IPFS_GW = ['https://flap.mypinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://cloudflare-ipfs.com/ipfs/'];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const VIA_PROXY = !!(process.env.BSC_AGENT_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy);
async function httpsGet(u, signal) {
  await assertPublicHost(new URL(u).hostname, VIA_PROXY);
  return new Promise((resolve, reject) => {
    const req = https.get(u, { lookup: safeLookup, agent: proxyAgentFor(u), signal, headers: { accept: 'image/*,*/*;q=0.5', 'user-agent': UA } }, resolve);
    req.on('error', reject);
  });
}
async function imgFetchOne(u) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000);
  try {
    let r;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!isPublicImageUrl(u)) throw new Error('image url is not allowed');
      r = await httpsGet(u, ac.signal);
      if (![301, 302, 303, 307, 308].includes(r.statusCode)) break;
      r.destroy();
      if (redirects === 3 || !r.headers.location) throw new Error('image redirect limit');
      u = new URL(r.headers.location, u).href;
    }
    if (r.statusCode < 200 || r.statusCode >= 300) { r.destroy(); throw new Error('http ' + r.statusCode); }
    const ct = String(r.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!Object.hasOwn(EXT, ct)) { r.destroy(); throw new Error('not image'); }
    if (Number(r.headers['content-length'] || 0) > 2e6) { r.destroy(); throw new Error('too big'); }
    const chunks = []; let size = 0;
    for await (const chunk of r) {
      size += chunk.length;
      if (size > 2e6) { r.destroy(); throw new Error('too big'); }
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
// 取头像：先读盘，没有就下载并存盘。/api/img 和后台预下载共用这一个入口。
const imgKey = (u) => crypto.createHash('sha1').update(u).digest('hex');
function imgCached(u) {
  const key = imgKey(u);
  try { const m = JSON.parse(fs.readFileSync(path.join(IMG_DIR, key + '.json'), 'utf8')); if (fs.existsSync(path.join(IMG_DIR, m.file))) return m; } catch { /* 未缓存 */ }
  return null;
}
async function ensureImg(u) {
  const hit = imgCached(u); if (hit) return { ...hit, hit: true };
  const key = imgKey(u);
  if ((imgFail.get(key) || 0) > Date.now()) throw new Error('recently failed');
  let p = imgInflight.get(key);
  if (!p) {
    p = imgFetch(u).then(({ ct, buf }) => { const file = key + '.' + (EXT[ct] || 'img'); fs.writeFileSync(path.join(IMG_DIR, file), buf); const m = { ct, file, url: u }; fs.writeFileSync(path.join(IMG_DIR, key + '.json'), JSON.stringify(m)); return m; })
      .catch((e) => { imgFail.set(key, Date.now() + 15_000); throw e; })
      .finally(() => imgInflight.delete(key));
    imgInflight.set(key, p);
  }
  return p;
}
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (!isPublicImageUrl(u)) return res.status(400).end();
  try {
    const m = await ensureImg(u);
    res.set({ 'Content-Type': m.ct, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Img-Cache': m.hit ? 'HIT' : 'MISS', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    res.sendFile(path.join(IMG_DIR, m.file));
  } catch { res.status(404).set('Cache-Control', 'no-store').end(); }
});
// 后台预下载：不等你在页面上看到，新币的头像先一步下好存盘，页面一打开就是现成的。每个地址最多试 6 次。
const prewarmTries = new Map();
setInterval(() => {
  if (!market?.list) return;
  const todo = market.list().filter((t) => t.image && isPublicImageUrl(t.image) && (prewarmTries.get(t.image) || 0) < 6 && !imgCached(t.image))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);
  for (const t of todo) { prewarmTries.set(t.image, (prewarmTries.get(t.image) || 0) + 1); ensureImg(t.image).catch(() => {}); }
}, 3000);
app.get('/api/names', (req, res) => {
  const n = market.names; if (!n) return res.json({ ver: 0, names: {} });
  if (Number(req.query.ver) === n.ver) return res.json({ ver: n.ver });
  res.json({ ver: n.ver, names: n.all() });
});

// 地址备注（不用追踪也能备注；追踪列表里的备注名优先）：data/remarks.json { 地址小写: 备注 }
const REMARKS_FILE = dataFile('remarks.json');
let remarks = {}; try { remarks = JSON.parse(fs.readFileSync(REMARKS_FILE, 'utf8')) || {}; } catch { /* 第一次没有文件 */ }
app.get('/api/remarks', (req, res) => res.json(remarks));
app.post('/api/remarks', (req, res) => {
  const a = String(req.body?.address || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return res.status(400).json({ error: '地址格式不对' });
  const v = String(req.body?.remark ?? '').trim().slice(0, 40); if (v) remarks[a] = v; else delete remarks[a];
  try { fs.writeFileSync(REMARKS_FILE, JSON.stringify(remarks, null, 1)); } catch (e) { return res.status(500).json({ error: `保存失败：${e.message}` }); }
  res.json(remarks);
});
// 地址 → .ai / .bnb 域名（反查，现查不排队）；模拟盘没有实盘行情的域名缓存，就临时建一个
let lookupNames = null;
app.get('/api/names/lookup', async (req, res) => {
  const a = String(req.query.address || '').trim().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return res.status(400).json({ error: '请填 0x 地址' });
  try { const nc = market.names || (lookupNames ||= new (await import('./engine/live/names.js')).NameCache()); res.json({ address: a, ...(await nc.lookupBoth(a)) }); }
  catch (e) { res.status(502).json({ error: `查询失败：${e.message}` }); }
});

/* (重复路由已合并到前面同名的实现) */
/* (重复路由已合并到前面同名的实现) */
/* (重复路由已合并到前面同名的实现) */
/* (重复路由已合并到前面同名的实现) */
// 这个内部入口只执行本钱包一次；禁止转发回 fleet，也不接受伪造的策略授权。
app.post('/api/wallet/order', async (req, res) => {
  if (!LIVE || !tokenMatches(req.headers['x-bsc-agent-token'], API_TOKEN)) return res.status(403).json({ error: '需要钱包后端访问令牌' });
  if (trader.status.auth.state !== 'ok') return res.status(401).json({ error: '钱包未登录' });
  try { const { token, side, amount, slippage, via, clientTs } = req.body; const source = req.body.source === '手动' ? '手动' : String(req.body.source||'跟单').slice(0,80); res.json(await localOrder({ token, side, amount, slippage, via, clientTs, source, copyGrant:req.body.copyGrant })); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/preview', async (req, res) => {
  try { if (fleet) return res.json(await fleet.query(req.query.wallet || 'baw', '/api/preview', req.query));
    const q = req.query; res.json(await trader.preview({ walletId: q.wallet, token: q.token, side: q.side, amount: Number(q.amount), slippage: Number(q.slippage || 35) }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/cost-for-pct', async (req, res) => { try { res.json(fleet ? await fleet.query(req.query.wallet || 'baw', '/api/cost-for-pct', req.query) : await costForPct({ market, trader, live: LIVE }, req.query)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/order', async (req, res) => {
  const { wallets, token, side, amount, slippage, via, clientTs } = req.body;
  try {
    const out = fleet ? await fleet.orders({ wallets, token, side, amount, slippage, via, clientTs, source: '手动', fast: true }) : await Promise.all((wallets || ['big']).map(w => trader.execute({ walletId: w, token, side, amount, slippage, source: '手动', via: via === 'quick' ? 'quick' : null, clientTs: Number(clientTs) || null })));
    for (const row of out) if (row.walletSlot && row.walletSlot !== WALLET_SLOT) broadcast({ type: 'order', data: row });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 单币规则（发射后立刻领取）
app.get('/api/token-rules', (req, res) => res.json(LIVE ? trader.rulesView() : {}));
// 页面只能改「是否领取」，以及取消规则
app.post('/api/token-rules', (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '只有实盘可用' });
  try {
    if (req.body.remove) return res.json(trader.setRule(req.body.token, null));
    const p = req.body.patch || {}, patch = {};
    if (p.claim !== undefined) patch.claim = p.claim === true;
    res.json(trader.setRule(req.body.token, patch));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/favorites', (req, res) => res.json(favorites.view()));
app.post('/api/favorites', (req, res) => { try { const v = favorites.op(req.body || {}); broadcast({ type: 'favorites', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/approvals', async (req, res) => { if (!LIVE) return res.json([]); try { res.json(await trader.allowancesView()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/approvals/revoke', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await trader.revokeApproval(String(req.body.token || ''), String(req.body.spender || ''))); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/token-info/:a', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { res.json(await trader.tokenInfo(req.params.a)); } catch (e) { res.status(400).json({ error: e.shortMessage || e.message }); } });
app.post('/api/swap/quote', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); try { const { from, to, amount, slippage } = req.body; res.json(await trader.swapQuote({ from, to, amount, slippage: Number(slippage) || 1 })); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/swap', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '只有实盘可用' }); const { from, to, amount, pct, slippage, clientTs } = req.body; res.json(await trader.swapManual({ from, to, amount, pct: pct != null ? Number(pct) : null, slippage: Number(slippage) || 1, clientTs: Number(clientTs) || null })); });
app.get('/api/blocklist', (req, res) => res.json(blocklist.view()));
app.post('/api/blocklist', (req, res) => { try { const v = blocklist.set(req.body.kind, req.body.address, !!req.body.on, req.body.label); broadcast({ type: 'blocklist', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
// 自动买入统一在「狙击」页：旧的 Agent 平台自动买入 / 自动卖出不再开放，旧设置里已打开的也在启动时关掉
const AGENT_OFF = { flap: { enabled: false }, four: { enabled: false }, gang: { enabled: false }, exit: { enabled: false } };
try { agent.setConfig(AGENT_OFF); } catch { /* 状态文件异常时由 stateError 提示 */ }
app.post('/api/config', (req, res) => { try { agent.setConfig({ ...req.body, ...AGENT_OFF, ...(req.body?.quickBuy !== undefined ? { quickBuy: req.body.quickBuy } : {}) }); if (LIVE && Number(req.body?.quickBuy) > 0) trader.saveSetting('quickBuy', Number(req.body.quickBuy)); res.json(agent.config); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/settings', (req, res) => {
  const { maxTradeBnb, ...rest } = req.body;
  if (maxTradeBnb !== undefined) { if (!LIVE) return res.status(400).json({ error: '只有实盘模式有单笔上限' }); try { trader.setMaxTrade(maxTradeBnb); } catch (e) { return res.status(400).json({ error: e.message }); } }
  // 自动转出地址：每个人自己设置（默认空）。需要重复输入同一地址确认；改地址会自动关掉三个转出开关，须重新打开
  if (LIVE && rest.sendTo !== undefined) {
    const a = String(rest.sendTo || '').trim();
    if (a && !/^0x[0-9a-fA-F]{40}$/.test(a)) return res.status(400).json({ error: '地址格式不对（要 0x 开头 42 位）' });
    if (/^0x0{40}$/i.test(a) || /^0x0{39}1$/i.test(a) || /^0x[dD]{4}0*[dD]{4}$/.test(a)) return res.status(400).json({ error: '这是黑洞/空地址，不能用' });
    if (a && String(rest.sendToConfirm || '').trim().toLowerCase() !== a.toLowerCase()) return res.status(400).json({ error: '两次输入的地址不一致' });
    trader.settings.sendTo = a; trader.saveSetting('sendTo', a);
    for (const k of ['autoSendAfterClaim', 'autoSendFourMigrated', 'autoSendGangMigrated']) { trader.settings[k] = false; trader.saveSetting(k, false); }
    console.log(`[settings] 自动转出地址已${a ? '修改' : '清除'}，三个自动转出开关已关闭`);
  }
  if (LIVE && !trader.settings.sendTo && [rest.autoSendAfterClaim, rest.autoSendFourMigrated, rest.autoSendGangMigrated].includes(true)) return res.status(400).json({ error: '还没设置转出地址，先在「自动转出」里设置地址' });
  for (const [k, n] of [['autoSendAfterClaim', '领取后'], ['autoSendFourMigrated', 'Four 发射后'], ['autoSendGangMigrated', 'Gang 发射后']])
    if (LIVE && rest[k] !== undefined) { trader.settings[k] = rest[k] === true; trader.saveSetting(k, trader.settings[k]); console.log(`[settings] ${n}自动转出 ${trader.settings[k] ? '打开' : '关闭'}`); }
  // 只接受已知的设置项，并且先校验再写入（以前先 Object.assign 再校验：格式错的预设会留在内存里直到重启，任意键也能写进 settings）
  if (rest.qbPresets !== undefined) { const q = rest.qbPresets; const ok = q && ['buy', 'sell'].every((k) => Array.isArray(q[k]) && q[k].length === 3 && q[k].every((a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number(v) > 0 && Number(v) <= (k === 'sell' ? 100 : 1000))));
    if (!ok) return res.status(400).json({ error: '预设格式不对' }); }
  if (rest.gas !== undefined) { if (!GAS_PRESETS[rest.gas]) return res.status(400).json({ error: 'gas 档位不对' }); trader.settings.gas = rest.gas; }
  if (rest.execPath !== undefined) trader.settings.execPath = rest.execPath === 'ai' ? 'ai' : 'direct';
  if (rest.multiRpc !== undefined) trader.settings.multiRpc = rest.multiRpc === true;
  if (rest.autoClaim !== undefined) trader.settings.autoClaim = !!rest.autoClaim;
  if (rest.qbPresets !== undefined) { trader.settings.qbPresets = rest.qbPresets; if (LIVE) trader.saveSetting('qbPresets', rest.qbPresets); }
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
  verifyClient: ({ req }) => isLocalRequest(req, PORT) && hasApiAccess(req, API_TOKEN, true),
});
// 序列化失败只跳过这一帧，不让整个服务崩溃
let badFrameLogged = false;
const broadcast = (msg) => {
  let s;
  try { s = JSON.stringify(msg); } catch (e) { if (!badFrameLogged) { badFrameLogged = true; console.error(`推送 ${msg?.type} 序列化失败，已跳过：${e.message}`); } return; }
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
// 钱包后端保有各自订单记录；主页面转发变化，刷新后也能看到远端订单。
if (fleet) {
  let last = new Map(fleet.orderViews([]).map(o => [o.id, JSON.stringify(o)]));
  setInterval(async () => {
    try {
      await fleet.refresh();
      const rows = fleet.orderViews([]), next = new Map();
      for (const row of rows) { const value = JSON.stringify(row); if (last.get(row.id) !== value) broadcast({ type: 'order', data: row }); next.set(row.id, value); }
      last = next; broadcast({ type: 'holdings', data: holdView() });
    } catch { /* 已在钱包视图中显示离线；不重发任何订单 */ }
  }, 5000);
}
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
if (LIVE) setInterval(() => new Set([...wss.clients].map((c) => c.sub).filter(Boolean)).forEach((a) => market.refresh(a)), 1000);
market.on('detail', (a) => { for (const c of wss.clients) if (c.readyState === 1 && c.sub === a) c.send(JSON.stringify({ type: 'detail', full: true, data: market.detail(a) })); });
// 订单结束（成交或失败）后马上重读链上余额，3 / 5 / 20 秒后再读一次，等区块和 baw 索引跟上
const resync = async () => { trader.syncAt = 0; if (holdings) holdings.histAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); };
trader.on('order', (o) => { broadcast({ type: 'order', data: o }); if (LIVE && ['filled', 'failed', 'unknown'].includes(o.status)) { for (const ms of [3000, 5000, 20000]) setTimeout(() => resync(), ms); for (const ms of [1500, 6000, 15000]) setTimeout(refreshHoldSnap, ms); } });
trader.on('rules', (r) => broadcast({ type: 'rules', data: r }));
trader.on('settings', (st) => broadcast({ type: 'settings', data: st }));
market.on('migrate', (s) => { if (LIVE && s?.platform === 'four') { trader.syncAt = 0; trader.refreshBalance?.(); } });
agent.on('log', (l) => broadcast({ type: 'log', data: l }));
agent.on('record', (r) => broadcast({ type: 'record', data: r }));
agent.on('config', (c) => broadcast({ type: 'config', data: c }));

setInterval(() => {
  broadcast({ type: 'tick', data: { ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, gangMcap: market.gangMcap || 0, net, wallets: walletViews(), usage: agent.usageView(), tokens: market.list(), positions: positionViews(), claimable: LIVE ? trader.claimable : [] } });
  for (const c of wss.clients) {
    if (c.readyState !== 1 || !c.sub) continue;
    const d = market.detail(c.sub);
    if (d) c.send(JSON.stringify({ type: 'detail', full: false, data: { ...d, candles: d.candles.slice(-5) } }));
  }
}, 500);

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`\n  BSC Agent（${!LIVE ? '模拟盘' : LIVE_TRADE ? `实盘 · 手动可下单，自动策略开启后可下单 · 单笔上限 ${trader.status.maxTradeBnb || '不限'} BNB` : '实盘行情 · 只报价不下单'}）`);
  if (LIVE) console.log(`  baw：${trader.status.connected ? `已连接 ${trader.wallets[0].address}` : `未连接（${trader.status.error}）`}`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
  nftAuto.start(); nftWatcher.start();
});
