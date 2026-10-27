// Gang 新盘狙击：gang.fun 上出现新币（链上创建事件，GangChain 订阅，出块后约 1 秒）时，用选中的钱包各买总量的 N%（默认 1%，合约本身限制每个钱包最多 1%）。
// 安全规则照跟单：
//   - 默认「关闭」+「模拟」（只记录会买多少，不下单），都要本人在页面上打开；有「急停」按钮（立刻关闭）；
//   - 服务器端强制上限：每个钱包单笔 BNB、每天合计 BNB（所有钱包加起来）、每天最多狙几个币；另外还受交易设置里的单笔上限约束；
//   - 只狙「刚创建」的盘（发现时间晚于 maxDelaySec 的不买）、已被买走太多的不买、屏蔽的开发者不买；
//   - 每一次决定（下单 / 模拟 / 跳过及原因）都写进记录，并推给页面弹提示。
// 自动卖出（例：涨到 2 倍卖 50% 出本）：狙到的币每 3 秒按曲线现价对比买入均价，到了档位就卖出这一档的比例；
//   可选止损（跌到买入价的 X% 以下全卖）；超过 holdHours 不再盯。模拟狙到的币只记录「会卖」。「急停」只停买入，自动卖出有单独的开关。
// 下单走 placeOrder（和页面、跟单同一条路：多钱包、登录检查、地址锁定、单笔上限都照常），来源记为「狙击 Gang」。
// 速度：直接挂在 GangChain 的 token 事件上（不等接口）；按曲线公式一次算出买 N% 要多少 BNB（不走 costForPct 的多轮试算）；
// 记住这个币在哪个 pad 上，下单时少一次探测；钱包里已有够用的 WBNB 并且已授权时，只发 buy 一笔交易。
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from './config.js';
import { GANG_V2_LAUNCHPAD } from './gangChain.js';
import { V3_TRADE } from './gangV3.js';

const STATE = dataFile('snipe.json'), LOG = dataFile('snipe-log.jsonl');
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { mkdirSync(new URL('.', f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); } catch { /* ignore */ } };
const append = (f, v) => { try { mkdirSync(new URL('.', f), { recursive: true }); appendFileSync(f, JSON.stringify(v) + '\n'); } catch { /* ignore */ } };
const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const VT = 1066666666666666666666666667n, BPS = 10000n, FEE = 100n, SUPPLY = 10n ** 27n;   // LaunchpadV2：虚拟代币储备、1% 平台费、总量 10 亿
const ceil = (a, b) => (a + b - 1n) / b;
// 已知的非 BNB 报价币（符号大写 → 地址）：开着狙击时后台每 20 秒刷新一次 BNB 汇率，新盘出现时不用冷等 baw 报价（约 1.8 秒）
const QUOTE_ADDR = { XAUT: '0x21caef8a43163eea865baee23b9c2e327696a3bf', GANG: '0x0c6302401aa5325c2e36f170f52c00b1d220b405', BNCB: '0x4902c5ebc598265ed2212b559b042de8a5eeec3f', BEM: '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a', GOOGLB: '0x3f53de71c126bdabae20f9cd64848d317f6c3238' };
export const HARD_MAX_BUY = 0.3;   // 无论参数怎么填，每个钱包单笔不超过 0.3 BNB

export const SNIPE_DEFAULTS = {
  pct: 1, wallets: [1], quotes: ['BNB', 'XAUT', 'BEM'], maxBnbPerBuy: 0.08, dailyCapBnb: 0.5, maxTokensPerDay: 0,
  maxDelaySec: 8, maxSoldPct: 15, partial: true, slippage: 35, buffer: 5, dryRun: false,
  wbnbFloat: 0.15, autoSell: true, tiers: [{ mult: 2, pct: 50 }], stopLossPct: 0, sellSlippage: 20, holdHours: 72,
};

// 曲线上从已卖出 sold 再买 tokens 个，要付多少报价币（含 1% 平台费）。和 gangV2Pads.buyQuote 同一套公式
export function costFor({ virtualQuote, realQuote = 0n, sold = 0n }, tokens) {
  const vq = BigInt(virtualQuote), k = vq * VT, qR = vq + BigInt(realQuote), tR = VT - BigInt(sold);
  if (tokens >= tR) return null;
  const net = ceil(k, tR - tokens) - qR;
  return ceil(net * BPS, BPS - FEE);
}

export class Sniper extends EventEmitter {
  constructor({ market, trader, placeOrder, isBlocked, floatFn, log }) {
    super();
    Object.assign(this, { market, trader, placeOrder, floatFn, isBlocked: isBlocked || (() => false), logFn: log || (() => {}) });
    const s = readJson(STATE, {});
    this.enabled = s.enabled === true; this.params = this.clean({ ...SNIPE_DEFAULTS, ...(s.params || {}) });
    this.days = s.days || {}; this.done = s.done || {}; this.pos = s.pos || {};   // pos：狙到的币（自动卖出盯着的持仓）   // done：已经处理过（下单 / 模拟）的币，不重复狙
    this.stats = { sims: 0, orders: 0, fails: 0, bnb: 0, ...(s.stats || {}) };
    this.recent = [];   // 最近发现的新盘和当时买 N% 的成本（页面上显示，帮着定上限）
    this.log = []; try { this.log = readFileSync(LOG, 'utf8').trim().split('\n').slice(-300).map((l) => JSON.parse(l)).reverse(); } catch { /* 第一次 */ }
    for (const r of this.log) if (r.cost != null && this.recent.length < 20) this.recent.push({ ts: r.ts, token: r.token, symbol: r.symbol, quote: r.quote, costBnb: r.cost, soldPct: r.soldPct });
    market.gangChain?.on('token', (it) => this.onLaunch(it).catch((e) => this.record(it, 'error', `出错：${e.message}`)));
    if (this.enabled) this.logFn(`[狙击] 启动时已开启（${this.params.dryRun ? '模拟' : '真实下单'}）`);
    // 开着的时候每 10 秒碰一下交易节点：连接保持热的，新盘出现时第一次读曲线约 0.13 秒（冷连接要 0.7～1 秒）
    setInterval(() => { if (this.enabled) this.trader.gangV2?.provider?.getBlockNumber?.().catch(() => {}); }, 10_000).unref?.();
    const warmRates = () => { if (!this.enabled) return; for (const q of this.params.quotes) if (QUOTE_ADDR[q]) this.trader.gangV2?.quoteRate(QUOTE_ADDR[q], { stale: 120_000 }).catch(() => {}); };
    setInterval(warmRates, 20_000).unref?.(); setTimeout(warmRates, 3000);
    setInterval(() => this.topUp(), 60_000).unref?.(); setTimeout(() => this.topUp(), 15_000);
    setInterval(() => this.checkSells().catch((e) => this.logFn(`[狙击] 自动卖出检查出错：${e.message}`)), 3000).unref?.();
  }

  clean(p) {
    const n = (v, d, lo = 0, hi = 1e9) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    return {
      pct: n(p.pct, 1, 0.01, 1), wallets: [1],   // 只支持单钱包
      quotes: (Array.isArray(p.quotes) ? p.quotes : ['BNB', 'XAUT']).map((x) => String(x).toUpperCase().slice(0, 12)).filter(Boolean),   // 报价币符号；'*' = 全部（非 BNB 盘要先用 baw 换报价币，慢几秒）
      maxBnbPerBuy: n(p.maxBnbPerBuy, 0.08, 0, HARD_MAX_BUY), dailyCapBnb: n(p.dailyCapBnb, 0.5, 0, 20), maxTokensPerDay: Math.round(n(p.maxTokensPerDay, 0, 0, 100000)),
      maxDelaySec: n(p.maxDelaySec, 8, 1, 120), maxSoldPct: n(p.maxSoldPct, 15, 0, 80), partial: p.partial !== false, slippage: n(p.slippage, 35, 1, 50), buffer: n(p.buffer, 5, 0, 30), dryRun: p.dryRun === true,
      autoSell: p.autoSell !== false, tiers: (Array.isArray(p.tiers) ? p.tiers : [{ mult: 2, pct: 50 }]).map((x) => ({ mult: n(x?.mult, 0, 0, 1000), pct: n(x?.pct, 0, 0, 100) })).filter((x) => x.mult >= 1.05 && x.pct >= 1).sort((a, b) => a.mult - b.mult).slice(0, 3),
      wbnbFloat: n(p.wbnbFloat, 0.15, 0, 2), stopLossPct: n(p.stopLossPct, 0, 0, 99), sellSlippage: n(p.sellSlippage, 20, 1, 50), holdHours: n(p.holdHours, 72, 1, 720),
    };
  }
  save() {
    const cut = Date.now() - 3 * 86400_000; for (const [k, v] of Object.entries(this.done)) if (v < cut) delete this.done[k];
    for (const d of Object.keys(this.days)) if (d < day(cut - 30 * 86400_000)) delete this.days[d];
    for (const [k, v] of Object.entries(this.pos)) if (v.closed && v.closedAt < cut) delete this.pos[k];
    writeJson(STATE, { enabled: this.enabled, params: this.params, days: this.days, done: this.done, stats: this.stats, pos: this.pos }); this.emit('state', this.view()); }
  // 今天的用量：真实和模拟分开记（模拟不占真实额度），按当前模式取
  today(sim = this.params.dryRun) { const d = (this.days[day()] ||= { bnb: 0, tokens: 0 }); if (!sim) return d; return (d.sim ||= { bnb: 0, tokens: 0 }); }
  view() { return { enabled: this.enabled, params: this.params, today: this.today(), stats: this.stats, recent: this.recent.slice(0, 20), typical: this.typical(), positions: this.posView(), hardMax: HARD_MAX_BUY, liveTrade: !this.trader?.status?.dryRun }; }
  setEnabled(v) { this.enabled = !!v; this.save(); if (this.enabled) setTimeout(() => this.topUp(), 500); this.logFn(`[狙击] ${this.enabled ? `已开启（${this.params.dryRun ? '模拟' : '真实下单'}）` : '已关闭'}`); return this.view(); }
  update(params) { this.params = this.clean({ ...this.params, ...(params || {}) }); this.v3Paused = null; this.save(); return this.view(); }

  // BNB 盘（虚拟储备 5 BNB）的参考成本：前面已经被买走 0% / 5% / 10% / 20% 时，再买 N% 要多少 BNB
  typical() {
    const tok = (SUPPLY * BigInt(Math.round(this.params.pct * 100))) / 10000n;
    const vq = 5n * 10n ** 18n;
    return [0, 5, 10, 20].map((s) => { const sold = (SUPPLY * BigInt(s)) / 100n, realQuote = ceil(vq * VT, VT - sold) - vq; return { soldPct: s, bnb: +Number(ethers.formatEther(costFor({ virtualQuote: vq, realQuote, sold }, tok))).toFixed(4) }; });
  }

  record(it, kind, reason, extra = {}) {
    const row = { ts: Date.now(), kind, reason, token: it?.address, symbol: it?.symbol, quote: it?.quoteSymbol, dryRun: this.params.dryRun, ...extra };
    this.log.unshift(row); if (this.log.length > 500) this.log.length = 500; append(LOG, row); this.emit('log', row);
    return row;
  }

  async onLaunch(it) {
    if (!this.enabled) return;
    const p = this.params, t0 = Date.now(), delay = (it.seenAt - it.createdAt * 1000) / 1000;
    if (this.done[it.address]) return;
    if (it.track === 'v3fair') return this.record(it, 'skip', 'Gang V3 打新币（固定价认购）不狙');
    if (it.track === 'v3' && !V3_TRADE) return this.record(it, 'skip', 'Gang V3 新盘：真实买卖还没开启（GANG_V3_TRADE=1），只记录');
    if (it.track === 'v3' && this.v3Paused) return this.record(it, 'skip', `Gang V3 狙击已自动暂停：${this.v3Paused}（核对后在狙击设置里重新保存即可恢复）`);
    if (it.track !== 'v2' && it.track !== 'v3') return this.record(it, 'skip', 'Gang 老盘（0x315B）不狙');
    if (!p.quotes.includes('*') && !p.quotes.includes(String(it.quoteSymbol || '').toUpperCase())) return this.record(it, 'skip', `报价币 ${it.quoteSymbol} 不在狙击范围（${p.quotes.join(' / ')}）`);
    if (delay > p.maxDelaySec) return this.record(it, 'skip', `发现太晚（出块后 ${delay.toFixed(1)} 秒 > ${p.maxDelaySec} 秒）`);
    if (this.isBlocked({ address: it.address, creator: it.creator })) return this.record(it, 'skip', '代币或开发者在屏蔽列表里');
    const td = this.today();
    if (p.maxTokensPerDay > 0 && td.tokens >= p.maxTokensPerDay) return this.record(it, 'skip', `今天已狙 ${td.tokens} 个（上限 ${p.maxTokensPerDay}）`);
    // 曲线状态 → 买 N% 要多少报价币 → 换成 BNB
    const gv = this.trader.gangV2; gv.pads.set(it.address, it.pad || GANG_V2_LAUNCHPAD);   // 新盘都建在 0x1B8F 上，下单时不用再挨个 pad 探测
    const { c } = await gv.curve(it.address);
    const soldPct = Number((BigInt(c.sold) * 10000n) / SUPPLY) / 100;
    const tokens = (SUPPLY * BigInt(Math.round(p.pct * 100))) / 10000n;
    const qCost = costFor(c, tokens); if (qCost == null) return this.record(it, 'skip', '曲线上剩余不够');
    const wb = String(c.quote).toLowerCase() === WBNB || c.quote === ethers.ZeroAddress;
    const rate = wb ? 1 : await gv.quoteRate(c.quote, { stale: 120_000 });   // 后台已在刷新，这里一般直接用缓存   // 1 BNB = rate 个报价币
    const dec = wb ? 18 : await gv.decimals(c.quote);
    const cost = Number(ethers.formatUnits(qCost, dec)) / (rate || Infinity);
    this.recent.unshift({ ts: Date.now(), token: it.address, symbol: it.symbol, quote: it.quoteSymbol, costBnb: +cost.toFixed(5), soldPct }); if (this.recent.length > 20) this.recent.length = 20;
    if (!(cost > 0)) return this.record(it, 'skip', '拿不到报价币汇率，算不出成本', { soldPct });
    if (soldPct > p.maxSoldPct) return this.record(it, 'skip', `发现时已被买走 ${soldPct.toFixed(1)}%（上限 ${p.maxSoldPct}%）`, { cost, soldPct });
    // 每个钱包买 cost ×（1 + 缓冲）：同一区块里别人（包括我们另一个钱包）先买了价格会高一点；多出来的报价币合约退回，留在钱包
    let amt = cost * (1 + p.buffer / 100) * (wb ? 1 : 1.03), note = '';
    const cap = Math.min(p.maxBnbPerBuy, HARD_MAX_BUY, Number(this.trader.status?.maxTradeBnb) || HARD_MAX_BUY);
    if (amt > cap) { if (!p.partial) return this.record(it, 'skip', `买 ${p.pct}% 要 ${amt.toFixed(4)} BNB，超过单笔上限 ${cap}`, { cost, soldPct }); note = `（超过单笔上限，只买 ${cap} BNB ≈ ${(p.pct * cap / amt).toFixed(2)}%）`; amt = cap; }
    const nW = p.wallets.length || 1;
    if (p.dailyCapBnb > 0 && td.bnb + amt * nW > p.dailyCapBnb + 1e-9) return this.record(it, 'skip', `今天已用 ${td.bnb.toFixed(4)} BNB，再买 ${(amt * nW).toFixed(4)} 会超过每天上限 ${p.dailyCapBnb}`, { cost, soldPct });
    amt = +amt.toFixed(6);
    // 先占额度（成交 / 待确认算花掉，失败的退回），避免连着几个新盘同时超限
    this.done[it.address] = Date.now(); td.tokens++; td.bnb += amt * nW;
    const entry = Number(ethers.formatUnits(qCost, dec)) / Number(ethers.formatEther(tokens));   // 买入均价（报价币 / 个，含 1% 手续费）
    const open = (wallets, sim) => { this.pos[it.address] = { symbol: it.symbol, quote: it.quoteSymbol, entry, ts: Date.now(), wallets, dryRun: sim, bnb: amt * wallets.length, tiersDone: [], last: null }; };
    const base = { cost: +cost.toFixed(6), soldPct, amount: amt, wallets: p.wallets, delayMs: Date.now() - it.createdAt * 1000, calcMs: Date.now() - t0 };
    if (p.dryRun) {
      this.stats.sims++; open(p.wallets, true); this.save();
      return this.record(it, 'sim', `模拟买入：每个钱包 ${amt} BNB × ${nW} 个钱包（买 ${p.pct}% 约 ${cost.toFixed(4)} BNB，发现时已卖出 ${soldPct.toFixed(1)}%）${note}`, base);
    }
    this.save();
    this.emit('fire', { ...base, token: it.address, symbol: it.symbol });
    const list = [].concat(await this.placeOrder({ token: it.address, side: 'buy', amount: amt, slippage: p.slippage, slots: p.wallets, source: '狙击 Gang' }).catch((e) => [{ status: 'failed', reason: e.message }]) || []);
    const ok = list.filter((o) => o?.status === 'filled' || o?.status === 'pending');
    const refund = amt * (nW - ok.length); if (refund > 0) td.bnb = Math.max(0, td.bnb - refund);
    if (!ok.length) td.tokens = Math.max(0, td.tokens - 1);
    this.stats.orders += ok.length; this.stats.fails += list.length - ok.length; this.stats.bnb += amt * ok.length;
    setTimeout(() => this.topUp(), 8000);   // 这次用掉了 WBNB，补回来
    if (it.track === 'v3') this.checkV3Fill(it, ok);
    if (ok.length) open(ok.map((o) => o.walletSlot).filter((x) => x > 0).length ? ok.map((o) => o.walletSlot).filter((x) => x > 0) : p.wallets, false);
    this.save();
    return this.record(it, ok.length ? 'order' : 'fail', `狙击买入 ${amt} BNB${note}：${list.map((o) => `${o.wallet || ''} ${o.status === 'filled' ? '成交' : o.status === 'pending' ? '已提交待确认（已计入额度）' : '失败 ' + (o.reason || '')}`).join('；')}`,
      { ...base, totalMs: Date.now() - it.createdAt * 1000, results: list.map((o) => ({ wallet: o.wallet, status: o.status, tx: o.tx, reason: o.reason, out: o.out, latencyMs: o.latencyMs })) });
  }

  // Gang V3 主网合约在上线前没法核对真实成交：每笔 V3 狙击成交后读回执，交易成功且收到了这个币（代币合约的 Transfer）才算对；
  // 不对就暂停 V3 狙击（V2 照常）并推一条失败记录提醒。暂停只在内存里，重启或重新保存狙击设置后恢复
  async checkV3Fill(it, ok) {
    const T = ethers.id('Transfer(address,address,uint256)'), pv = this.trader.gangV2.provider;
    for (const o of ok.filter((x) => x.status === 'filled' && x.tx)) {
      const rc = await pv.getTransactionReceipt(o.tx).catch(() => null);
      const got = rc?.status === 1 && rc.logs.some((l) => l.address.toLowerCase() === it.address && l.topics[0] === T && BigInt(l.data) > 0n);
      if (rc && !got) { this.v3Paused = `${it.symbol} 的狙击单 ${o.tx.slice(0, 10)}… 没收到代币`; this.record(it, 'fail', `Gang V3 成交核对不通过，已暂停 V3 狙击：${this.v3Paused}`); return; }
    }
    if (ok.some((x) => x.status === 'filled')) this.record(it, 'order', 'Gang V3 成交核对通过（链上收到代币）');
  }

  // ---------- 自动卖出 ----------
  posView() {
    return Object.entries(this.pos).filter(([, v]) => !v.closed).map(([token, v]) => ({ token, symbol: v.symbol, quote: v.quote, ts: v.ts, dryRun: v.dryRun, bnb: v.bnb, wallets: v.wallets, mult: v.last?.mult ?? null, at: v.last?.at ?? null, tiersDone: v.tiersDone })).sort((a, b) => b.ts - a.ts).slice(0, 50);
  }
  forget(token) { const v = this.pos[String(token).toLowerCase()]; if (v) { v.closed = true; v.closedAt = Date.now(); v.closeReason = '手动停止盯盘'; this.save(); } return this.view(); }
  // 现价（报价币 / 个）：还在内盘的读曲线边际价（不依赖页面列表），已毕业的用行情列表里的价格
  async price(token) {
    try { const { c } = await this.trader.gangV2.curve(token); if (!c.graduated) { const dec = String(c.quote).toLowerCase() === WBNB || c.quote === ethers.ZeroAddress ? 18 : await this.trader.gangV2.decimals(c.quote); return Number(ethers.formatUnits(BigInt(c.virtualQuote) + BigInt(c.realQuote), dec)) / Number(ethers.formatEther(VT - BigInt(c.sold))); } } catch { /* 用行情价 */ }
    const t = this.market.get?.(token); return t?.price > 0 ? t.price : null;
  }
  async checkSells() {
    if (this.checking) return; this.checking = true;
    try {
      const p = this.params, now = Date.now(); let dirty = false;
      for (const [token, v] of Object.entries(this.pos)) {
        if (v.closed) continue;
        if (now - v.ts > p.holdHours * 3600_000) { Object.assign(v, { closed: true, closedAt: now, closeReason: `超过 ${p.holdHours} 小时，不再盯` }); dirty = true; continue; }
        if (!p.autoSell || (v.retryAt && now < v.retryAt)) continue;
        const px = await this.price(token); if (!(px > 0) || !(v.entry > 0)) continue;
        const mult = px / v.entry; v.last = { mult: +mult.toFixed(3), at: now };
        let sell = null;
        if (p.stopLossPct > 0 && mult <= 1 - p.stopLossPct / 100) sell = { pct: 100, why: `跌到买入价的 ${(mult * 100).toFixed(0)}%，止损全卖`, key: 'sl', last: true };
        else { const i = p.tiers.findIndex((x) => mult >= x.mult && !v.tiersDone.includes(x.mult)); if (i >= 0) { const x = p.tiers[i]; sell = { pct: x.pct, why: `涨到 ${mult.toFixed(2)} 倍（档位 ${x.mult} 倍），卖出 ${x.pct}%${x.mult === 2 && x.pct === 50 ? '（出本）' : ''}`, key: x.mult, last: x.pct >= 100 }; } }
        if (!sell) continue;
        await this.doSell(token, v, sell); dirty = true;
      }
      if (dirty) this.save(); else if (Object.values(this.pos).some((v) => !v.closed)) this.emit('state', this.view());
    } finally { this.checking = false; }
  }
  async doSell(token, v, s) {
    const it = { address: token, symbol: v.symbol, quoteSymbol: v.quote };
    if (s.key !== 'sl') v.tiersDone.push(s.key);   // 先标记，避免下一轮重复卖
    const close = () => Object.assign(v, { closed: true, closedAt: Date.now(), closeReason: s.why });
    if (v.dryRun) { if (s.last || v.tiersDone.length >= this.params.tiers.length) close(); return this.record(it, 'sim', `模拟自动卖出：${s.why}`, { side: 'sell', pct: s.pct, mult: v.last?.mult }); }
    const list = [].concat(await this.placeOrder({ token, side: 'sell', amount: s.pct, slippage: this.params.sellSlippage, slots: v.wallets, source: '狙击 Gang' }).catch((e) => [{ status: 'failed', reason: e.message }]) || []);
    const ok = list.filter((o) => o?.status === 'filled' || o?.status === 'pending');
    if (ok.length) { if (s.last || v.tiersDone.length >= this.params.tiers.length) close(); v.fails = 0; v.retryAt = 0; }
    else {   // 全部失败：撤销标记，30 秒后再试；连续 3 次都失败就不再盯这个币
      if (s.key !== 'sl') v.tiersDone = v.tiersDone.filter((k) => k !== s.key);
      v.fails = (v.fails || 0) + 1; v.retryAt = Date.now() + 30_000;
      if (v.fails >= 3) Object.assign(v, { closed: true, closedAt: Date.now(), closeReason: '自动卖出连续 3 次失败，不再盯（请手动处理）' });
    }
    return this.record(it, ok.length ? 'order' : 'fail', `自动卖出 ${s.pct}%：${s.why}：${list.map((o) => `${o.wallet || ''} ${o.status === 'filled' ? '成交' : o.status === 'pending' ? '已提交待确认' : '失败 ' + (o.reason || '')}`).join('；')}`,
      { side: 'sell', pct: s.pct, mult: v.last?.mult, results: list.map((o) => ({ wallet: o.wallet, status: o.status, tx: o.tx, reason: o.reason, out: o.out })) });
  }

  // ---------- 预备 WBNB ----------
  // BNB 盘每次狙击原本是「包装 BNB→WBNB」+「buy」两笔交易（实测各约 1.8 秒广播 + 0.7 秒上链）；钱包里事先有 WBNB 就只发 buy 一笔，快约 3 秒。
  // 真实狙击开着时，每 60 秒和每次狙击后检查每个钱包的 WBNB：低于目标一半就用 BNB 包装补到目标（留 0.02 BNB 付 gas）。包装 1:1，随时可在持仓页换回
  async topUp() {
    const p = this.params;
    if (!this.enabled || p.dryRun || !(p.wbnbFloat > 0) || !this.floatFn || this.topping) return;
    this.topping = true;
    try {
      for (const r of await this.floatFn(p.wbnbFloat, p.wallets)) {
        if (r.wrapped) this.record({ symbol: 'WBNB' }, 'prep', `${r.wallet || ''} 预备 WBNB：原有 ${(+r.have).toFixed(4)}，包装 ${(+r.wrapped).toFixed(4)} BNB${r.tx ? '' : ''}`, { results: [{ wallet: r.wallet, status: 'filled', tx: r.tx }] });
        else if (r.error) this.record({ symbol: 'WBNB' }, 'fail', `${r.wallet || ''} 预备 WBNB 失败：${r.error}`);
      }
    } catch (e) { this.logFn(`[狙击] 预备 WBNB 出错：${e.message}`); } finally { this.topping = false; }
  }
}

// 本后端自己的钱包：WBNB 低于 target 的一半时包装补到 target。只在 LIVE_TRADE=1、已登录、钱包没被锁时做
export async function wbnbTopUp(trader, target, liveTrade) {
  const w = trader.wallets?.[0], label = w?.label || '';
  if (!liveTrade) return { wallet: label, skip: 'LIVE_TRADE 未开' };
  if (!w?.address || trader.status?.auth?.state !== 'ok') return { wallet: label, skip: '未登录' };
  const have = Number(ethers.formatEther(await trader.gangV2.balanceOf(WBNB, w.address)));
  if (have >= target / 2) return { wallet: label, have };
  await trader.refreshBalance();
  const amt = +Math.min(target - have, (w.bnb || 0) - 0.02).toFixed(6);
  if (!(amt >= 0.005)) return { wallet: label, have, skip: 'BNB 不够包装' };
  if ((await trader.lockStatus()) === 'LOCKED') return { wallet: label, have, skip: '钱包在等 App 确认' };
  try {
    const tx = await trader.portal.send({ wallet: w.address, to: WBNB, valueWei: ethers.parseEther(String(amt)), inputData: new ethers.Interface(['function deposit() payable']).encodeFunctionData('deposit', []), label: '狙击预备 WBNB', step: () => {} });
    return { wallet: label, have, wrapped: amt, tx };
  } catch (e) { return { wallet: label, have, error: e.message }; }
}
