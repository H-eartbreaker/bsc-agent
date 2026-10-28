// gang.fun（BNB Chain 上只对 Binance Agentic Wallet + .ai Agent ID 开放的发射平台）行情：只读它的公开接口。
// 代币列表 /api/tokens（老的 BNB 盘）和 /api/stocks/tokens（V2 盘，报价币可以是 BNB / GANG / 币股，带 logoUrl）每 20 秒拉一次；
// 最近有成交的几个盘每 10 秒拉一次成交，进成交流和 K 线。V2 盘的价格和金额按报价币美元价换算成 BNB。
// 下单在 gangTrade.js：老盘（0x315B…23A7，BNB 计价）支持内盘买卖；V2 报价币盘只看行情。
import { EventEmitter } from 'node:events';
import { cache } from './cache.js';
import { pfetch } from '../netProxy.js';

const API = 'https://gang.fun/api';
const LIST_MS = 5_000, LIST_SLOW_MS = 20_000, TRADES_MS = 10_000, HOT = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 限流自动降速：连续 3 次限流 → 退回旧间隔 20000ms，冷却 10 分钟后再试快速
const RL_RE = /429|rate.?limit|too many requests|-32005|limit exceeded|限流/i;
function rlNote(st, err) {
  const now = Date.now();
  if (err && RL_RE.test(String(err.shortMessage || err.message || err) + ' ' + (err.code ?? '') + ' ' + (err.error?.code ?? ''))) {
    st.rlHits = (st.rlHits || 0) + 1;
    if (st.rlHits >= 3 && !(st.backoffUntil > now)) { st.backoffUntil = now + 10 * 60_000; st.backoffCount = (st.backoffCount || 0) + 1; console.log(`[Gang] 连续限流 ${st.rlHits} 次，轮询退回 20000ms，10 分钟后再试 5000ms`); }
  } else if (!err) st.rlHits = 0;
  if (st.backoffUntil && st.backoffUntil <= now) { st.backoffUntil = 0; st.rlHits = 0; console.log('[Gang] 限流冷却结束，恢复 5000ms 轮询'); }
  st.intervalMs = st.backoffUntil > now ? 20000 : 5000;
  return st.intervalMs;
}


export class GangFun extends EventEmitter {
  constructor() {
    super();
    this.seen = new Map();          // address → 上次看到的成交笔数，有变化才去拉成交
    this.lastTx = new Map();        // address → 已处理的最新成交时间
    this.v2 = new Map();            // V2 盘：address → { quoteUsd }，成交接口和换算要用
    this.bnbUsd = 0;
    this.status = { connected: false, total: 0, lastError: null, lastPollMs: 0, pausedUntil: 0 };
  }

  start() { this.loopList(); this.loopTrades(); }

  async get(path) {
    const wait = this.status.pausedUntil - Date.now(); if (wait > 0) await sleep(wait);
    const res = await pfetch(API + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) { this.status.pausedUntil = Date.now() + 60_000; throw new Error('gang.fun 限流（429），暂停 1 分钟'); }
    if (!res.ok) throw new Error(`gang.fun HTTP ${res.status}`);
    return res.json();
  }

  async loopList() {
    let first = true;
    for (;;) {
      const t0 = Date.now();
      try {
        const items = [];
        for (let off = 0; off < 1000;) { const j = await this.get(`/tokens?sort=new&limit=200&offset=${off}`); items.push(...(j.items || [])); if (!j.hasMore) break; off = j.nextOffset; }
        this.bnbUsd = Number(items[0]?.bnbUsd) || this.bnbUsd;
        for (let off = 0; off < 1000;) {
          const j = await this.get(`/stocks/tokens?limit=100&offset=${off}`);
          for (const x of j.items || []) items.push(this.fromV2(x));
          if (!j.hasMore) break; off = j.nextOffset;
        }
        for (const it of items) {
          const isNew = !first && !this.seen.has(it.address);
          this.emit('token', it, { isNew });
          if (!this.seen.has(it.address)) this.seen.set(it.address, -1);
        }
        this.status.total = items.length; this.status.connected = true; this.status.lastError = null; first = false; rlNote(this.status, null);
      } catch (e) { this.status.connected = false; this.status.lastError = e.message; rlNote(this.status, e); }
      this.status.lastPollMs = Date.now() - t0;
      await sleep(this.status.intervalMs || LIST_MS);
    }
  }

  // V2 盘统一成和老盘一样的字段；已筹 / 门槛保留报价币单位，价格换成 BNB
  // 分红：taxed=true 是税币（TaxLaunchToken）：内盘 + 外盘买卖 1% 税，一半按持仓分给持有 ≥1 万枚的地址（报价币发放，经分红金库），另一半 80% 回购销毁 GANG / 20% 进金库；
  // taxed=false 是普通币（LaunchToken）：内盘 1% 平台费（80% 回购销毁 GANG / 20% 金库），毕业后 0 税、不分红。dividends 里有累计 / 近 7 天 / 每万枚 / 年化
  fromV2(x) {
    const qUsd = Number(x.quoteUsd) || 0, bUsd = this.bnbUsd || 1;
    this.v2.set(x.address, { quoteUsd: qUsd });
    return { address: x.address, name: x.name, symbol: x.symbol, creator: x.creator, creatorHandle: x.creatorHandle, createdAt: x.createdAt, graduated: x.graduated, graduatedAt: x.graduatedAt || null, pair: x.pair,
      raisedQuote: Number(x.raisedQuote) || 0, gradAmtQuote: Number(x.gradAmtQuote) || 0, quoteSymbol: x.quoteSymbol || 'BNB', quoteAddress: x.quoteAddress,
      progressPct: x.progressPct, priceBnb: (Number(x.priceUsd) || 0) / bUsd, priceQuote: Number(x.priceQuote) || null, quoteUsd: qUsd, fdvUsd: x.fdvUsd, holders: x.holders, trades: x.trades, lastTradeAt: x.lastTradeAt,
      volume24hBnb: (Number(x.volume24hUsd) || 0) / bUsd, logo: x.logoUrl ? new URL(x.logoUrl, 'https://gang.fun').href : null, track: 'v2',
      taxed: x.taxed ?? null, taxBps: x.taxBps ?? null, dividends: x.dividends || null, dividendVault: x.dividends?.vault || x.v2DividendVault || null };   // logoThumbUrl 是相对路径且实际返回网页，不能用
  }

  // 成交：只拉最近有新成交的几个盘，避免频繁请求
  async loopTrades() {
    await sleep(3000);
    for (;;) {
      try {
        const hot = [...this.hotList()].slice(0, HOT);
        for (const a of hot) { await this.trades(a, 40); await sleep(300); }
      } catch (e) { this.status.lastError = e.message; }
      await sleep(TRADES_MS);
    }
  }

  hotList() { return this.hot || []; }
  setHot(list) { this.hot = list; }

  // 成交金额（报价币）：买入按「实际付出」= 接口里的净额 + 平台费（V2 是 quoteIn + taxPlat + taxDiv，老盘是 bnb + fee）；
  // 卖出接口给的已经是扣完费到手的数。以前买入用的是净额，成本少算了约 1%
  static amt(x, v2) {
    const n = (k) => Number(x[k] || 0);
    if (v2) return x.side === 'buy' ? n('quoteIn') + n('taxPlat') + n('taxDiv') : n('quoteIn') || n('quoteOut');
    return x.side === 'buy' ? n('bnb') + n('fee') : n('bnb');
  }

  // 全部成交历史（翻页，最多 max 条），只用来从开盘起重建 K 线，不当作新成交推送。返回按时间升序的 { ts, price, bnb }
  // 有 MySQL 缓存：从最新往回翻，接上库里最新的那笔（多翻 5 分钟重叠）就停，旧的从库里读。cursor = 1 表示库里已经从开盘起拉全
  async history(address, max = 4000) {
    const v2 = this.v2.get(address);
    const rows = await cache.history('gang', address, async (cur, old) => {
      const have = old?.rows || [], stopAt = have.length ? have.at(-1).ts - 300_000 : 0; const out = []; let full = false;
      for (let off = 0; off < max;) {
        const j = await this.get(`${v2 ? '/stocks' : ''}/tokens/${address}/trades?limit=200&offset=${off}&sort=ts_desc`);
        for (const x of j.items || []) out.push({ ts: x.ts * 1000, price: Number(x.price), bnb: GangFun.amt(x, v2), tx: x.tx, side: x.side, trader: x.trader, name: x.traderHandle || null, tokens: Number(x.tokens) });
        if (!j.hasMore || !j.nextOffset) { full = true; break; }
        if (stopAt && out.at(-1)?.ts < stopAt && (cur === 1 || have.length + out.length >= max)) { full = cur === 1; break; }   // 接上已存的了
        off = j.nextOffset; await sleep(250);
      }
      return { rows: out.reverse(), cursor: full ? 1 : 0 };
    }, (x) => `${x.tx}:${x.side}:${x.tokens}`);
    return rows.length > max ? rows.slice(-max) : rows;
  }

  // 拉一个盘的成交（选中代币时也会调用，limit 大一些用来画 K 线）
  async trades(address, limit = 200) {
    const v2 = this.v2.get(address);
    const j = await this.get(`${v2 ? '/stocks' : ''}/tokens/${address}/trades?limit=${limit}&offset=0&sort=ts_desc`);
    const last = this.lastTx.get(address) || 0;
    const k = 1;   // 和全站约定一致：价格 / 金额都用报价币单位，换美元时再乘 quoteUsd
    const rows = (j.items || []).map((x) => ({ token: address, side: x.side, trader: x.trader, name: x.traderHandle || null,
      bnb: GangFun.amt(x, v2) * k, tokens: Number(x.tokens),
      price: Number(x.price) * k, ts: x.ts * 1000, tx: x.tx })).reverse();
    for (const r of rows) this.emit('trade', r, { live: r.ts > last && last > 0 });
    if (rows.length) this.lastTx.set(address, Math.max(last, rows.at(-1).ts));
    return rows;
  }
}
