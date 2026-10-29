// 持仓视图：数量以链上为准（trader.positions 由 syncHoldings 按 sharesOf / 钱包余额同步），
// 成本和成交历史来自 baw wallet tx-history（钱包每笔交易的 send / receive），所以在别处（3788、gang.fun 网页）买的也能算进去。
// Flap 曲线份额不是代币，tx-history 里看不到收到了什么，这类只用本程序自己的订单记录算成本。
import * as baw from './baw.js';
import { QUOTE_TOKENS } from './config.js';
import { ethers } from 'ethers';
import { cache } from './cache.js';
import { realizedTrades } from './realized.js';

const HIST_MS = 60_000;
const lc = (a) => String(a || '').toLowerCase();
const BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const WBNB = lc(QUOTE_TOKENS.WBNB);
// 一笔钱包交易的唯一键：它的链上交易哈希（没有就用时间 + 内容）
const txId = (t) => (t.txHashList || []).map((h) => h.txHash).filter(Boolean).join(',') || t.id || `${t.txTime}:${JSON.stringify(t).length}`;

export class Holdings {
  constructor(market, trader) { this.market = market; this.trader = trader; this.hist = new Map(); this.histAt = 0; this.loading = null; this.swaps = new Map(); this.checks = new Map(); this.bnbH = new Map(); }

  // 历史 BNB/USDT 价格：币安 1 小时 K 线（每根取开盘和收盘的平均），用来把每笔成交的 BNB 折成当时的美元
  async loadBnbHourly(fromMs) {
    const H = 3600_000; let start = Math.floor(fromMs / H) * H; const end = Date.now();
    if (!this.bnbHDb) { const rows = await cache.loadBnbHourly(start).catch(() => null); if (rows) { this.bnbHDb = true; for (const [h, px] of rows) this.bnbH.set(h, px); } }   // MySQL 缓存：存过的小时价不再请求币安
    const fresh = [];
    while (start < end) {
      if (this.bnbH.has(start) && start < end - 2 * H) { start += H; continue; }
      const j = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1h&startTime=${start}&limit=1000`)).json();
      if (!Array.isArray(j) || !j.length) break;
      for (const k of j) { const px = (Number(k[1]) + Number(k[4])) / 2; this.bnbH.set(k[0], px); if (k[0] < end - 2 * H) fresh.push([k[0], px]); }   // 最近 2 小时的还会变，不存
      start = j.at(-1)[0] + H;
    }
    if (this.bnbHDb && fresh.length) cache.saveBnbHourly(fresh).catch(() => {});
  }
  usdAt(ts) { const v = this.bnbH.get(Math.floor(ts / 3600_000) * 3600_000); return v || this.market.bnbUsd || 0; }

  quoteSet() { return new Set([...Object.values(QUOTE_TOKENS), ...Object.keys(this.market.qUsd || {})].map(lc)); }
  // 报价币 → BNB 的现价：WBNB = 1，其他按行情同一来源（qUsd）÷ BNB 美元价
  rateNow(q) { q = lc(q); if (!q || q === BNB || q === WBNB) return 1; const u = this.market.qUsd?.[q]; return u && this.market.bnbUsd ? u / this.market.bnbUsd : 0; }
  // 某笔交易当时的汇率：用时间最近（2 小时内）的一笔 BNB↔该报价币兑换；找不到就用现价
  rateAt(q, ts) {
    q = lc(q); if (q === BNB || q === WBNB) return 1;
    let best = null; for (const x of this.swaps.get(q) || []) if (Math.abs(x.ts - ts) < 2 * 3600_000 && (!best || Math.abs(x.ts - ts) < Math.abs(best.ts - ts))) best = x;
    return best ? best.rate : this.rateNow(q);
  }

  // 拉最近 3 个月的钱包交易（最多 5 页 × 100 条），按代币合约汇总：买入花的 BNB、卖出收回的 BNB、每笔明细
  async loadHistory(force = false) {
    if (!force && Date.now() - this.histAt < HIST_MS) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      // MySQL 缓存：钱包交易记录存下来，之后只翻到碰上已存的、已确认的那笔为止（通常 1 页），不再每次翻 5 页
      const wallet = this.trader.wallets?.[0]?.address; const stored = wallet ? await cache.loadWalletTx(wallet, 500).catch(() => null) : null;
      const known = new Set((stored || []).filter((t) => t.status === 'confirmed').map(txId));
      let txs = []; let cursor = null;
      for (let i = 0; i < 5; i++) {
        const args = ['wallet', 'tx-history', '--binanceChainId', '56', '--size', '100']; if (cursor) args.push('--nextCursor', cursor);
        const d = (await baw.runBaw(args, { timeoutMs: 30_000 })).data || {};
        txs.push(...(d.transactions || [])); cursor = d.nextCursor; if (!cursor || !(d.transactions || []).length) break;
        if (known.size && (d.transactions || []).some((t) => known.has(txId(t)))) break;   // 接上已存的了
      }
      if (stored) {
        cache.saveWalletTx(wallet, txs, txId).catch(() => {});
        const m = new Map(stored.map((t) => [txId(t), t])); for (const t of txs) m.set(txId(t), t);
        txs = [...m.values()].sort((a, b) => (Date.parse(b.txTime) || 0) - (Date.parse(a.txTime) || 0)).slice(0, 500);   // 和以前一样最多最近 500 笔
      }
      const minTs = Math.min(...txs.map((t) => Date.parse(t.txTime)).filter(Number.isFinite));
      if (isFinite(minTs)) await this.loadBnbHourly(minTs).catch(() => {});   // 拿不到就用现价
      // 先找 BNB↔报价币的兑换，得到每笔交易时的历史汇率（GANG、BNCB 等）
      const qs = this.quoteSet(); const swaps = new Map();
      const legs = (h) => { const ins = h.instructions || {}; const sum = (rows) => { const o = {}; for (const x of rows || []) { const a = lc(x.tokenInfo?.contractAddress); if (a) o[a] = (o[a] || 0) + Number(x.amount || 0); } return o; }; return { out: sum(ins.send), in: sum(ins.receive) }; };
      for (const t of txs) {
        if (t.status !== 'confirmed') continue;
        for (const h of t.txHashList || []) {
          const { out, in: inn } = legs(h); const ts = Date.parse(t.txTime);
          for (const q of qs) {
            if (out[BNB] > 0 && inn[q] > 0) (swaps.get(q) || swaps.set(q, []).get(q)).push({ ts, rate: out[BNB] / inn[q] });
            if (out[q] > 0 && inn[BNB] > 0) (swaps.get(q) || swaps.set(q, []).get(q)).push({ ts, rate: inn[BNB] / out[q] });
          }
        }
      }
      this.swaps = swaps;
      // 每笔交易按 BNB 计价：有 BNB 腿就用 BNB；没有（如 GANG→gangster）就把报价币那条腿按当时汇率折成 BNB
      const m = new Map();
      for (const t of txs) {
        if (t.status !== 'confirmed') continue;
        for (const h of t.txHashList || []) {
          const { out, in: inn } = legs(h); const ts = Date.parse(t.txTime);
          const fee = Number(h.networkFee?.feeValue || 0) / 10 ** (h.networkFee?.feeTokenDecimals || 18);
          const touched = new Set([...Object.keys(out), ...Object.keys(inn)].filter((a) => a !== BNB));
          for (const tok of touched) {
            const got = inn[tok] || 0, sent = out[tok] || 0;
            // 这笔交易里另一边的价值（BNB + 其他报价币折 BNB），以及用的报价币数量
            const other = (side) => { let bnb = side[BNB] || 0, qAmt = 0, qAddr = null; for (const [a, v] of Object.entries(side)) if (a !== tok && a !== BNB && qs.has(a) && v > 0) { bnb += v * this.rateAt(a, ts); qAmt += v; qAddr = a; } return { bnb, qAmt, qAddr }; };
            const r = m.get(tok) || { buys: 0, sells: 0, boughtBnb: 0, soldBnb: 0, boughtUsd: 0, soldUsd: 0, feesUsd: 0, boughtQty: 0, soldQty: 0, lastAt: 0, boughtQuote: 0, quote: null, fees: 0, firstAt: Infinity, trades: [] };
            const px = this.usdAt(ts);
            if (got > 0) {
              const o = other(out); let v = o.bnb;
              if (!v && qs.has(tok) && Object.keys(out).length) v = got * this.rateAt(tok, ts);   // 卖别的币换回报价币：按当时汇率记成本；单纯转入不算成本
              r.buys++; r.boughtBnb += v; r.boughtUsd += v * px; r.boughtQty += got; if (o.qAmt) { r.boughtQuote += o.qAmt; r.quote = o.qAddr; }
              r.trades.push({ side: 'buy', kind: v > 0 ? 'trade' : 'transfer', feeUsd: fee * px, ts, tokens: got, bnb: v, usd: v * px, quoteAmt: o.qAmt || null, quote: o.qAddr, tx: h.txHash });
            } else if (sent > 0) {
              const o = other(inn); let v = o.bnb;
              if (!v && qs.has(tok)) v = sent * this.rateAt(tok, ts);   // 报价币拿去买了别的币：按当时汇率记作转出价值
              r.sells++; r.soldQty += sent; r.soldBnb += v; r.soldUsd += v * px;
              r.trades.push({ side: 'sell', kind: Object.keys(inn).length && v > 0 ? 'trade' : 'transfer', feeUsd: fee * px, ts, tokens: sent, bnb: v, usd: v * px, quoteAmt: o.qAmt || null, quote: o.qAddr, tx: h.txHash });
            } else continue;
            r.fees += fee; r.feesUsd += fee * px; r.firstAt = Math.min(r.firstAt, ts); r.lastAt = Math.max(r.lastAt, ts); m.set(tok, r);
          }
        }
      }
      this.hist = m; this.histAt = Date.now();
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  // 链上卖出报价核对（Gang V2）：全部持仓 quoteSell → 报价币数量 × 汇率；60 秒缓存
  async sellCheck(t, rate) {
    const k = lc(t.address), amt = Math.round(this.trader.positionsView().find((p) => lc(p.token) === k)?.amount || 0), c = this.checks.get(k);
    if (c && c.amt === amt && Date.now() - c.at < 60_000) return c.v;   // 持仓数量变了（刚买 / 卖）就重新读链上报价
    let v = null;
    try {
      const g = this.trader.gangV2, w = this.trader.wallets[0]; const bal = await g.balanceOf(t.address, w.address);
      if (bal > 0n) { const { c: cv } = await g.curve(t.address); const q = Number(ethers.formatUnits(g.sellQuote(cv, bal).out, await g.decimals(cv.quote)));   /* 报价币不一定 18 位（BEM 8 位） */ v = { q, bnb: rate ? q * rate : null }; }
    } catch { /* 读链失败就不核对 */ }
    this.checks.set(k, { at: Date.now(), v, amt }); return v;
  }

  async view() {
    const sig = this.trader.positionsView().map((p) => `${p.token}:${Math.round(p.amount)}`).join(',');
    await this.loadHistory(sig !== this.sig).catch(() => {}); this.sig = sig;   // 持仓有变化（新买卖）就马上重读钱包历史，成本跟上
    const w = this.trader.wallets[0]; const bnbUsd = this.market.bnbUsd;
    const claim = new Map((this.trader.claimable || []).map((c) => [lc(c.token), c]));
    const rows = [];
    for (const p of this.trader.positionsView()) {
      const t = this.market.get(p.token); if (!t) continue;
      // Gang V2/V3 内盘还没价格（没进接口列表、没人点开过，XAUt 等非 18 位报价币常见）：按链上曲线补一次
      if (p.amount > 0 && !(t.price > 0) && t.source === 'gang' && (t.gangTrack === 'v2' || t.gangTrack === 'v3')) await this.market.gangV2Curve?.(t).catch(() => {});
      const h = this.hist.get(lc(p.token));
      // 有钱包历史就用历史（包括别处买的）；没有就用本程序的订单记录
      const bought = h ? h.boughtBnb : p.boughtBnb || 0, sold = h ? h.soldBnb : p.soldBnb || 0, fees = h ? h.fees : 0;
      // 价格以报价币计（GANG、BNCB…），折成 BNB：× 报价币/BNB 汇率（和行情同一来源）
      const isBnbQuote = !t.quote || ['BNB', 'WBNB'].includes(String(t.quote).toUpperCase());
      const rate = isBnbQuote ? 1 : (bnbUsd ? (this.market.quoteUsd?.(t) || 0) / bnbUsd : 0);
      let value = rate && t.price > 0 ? p.amount * t.price * rate : null, warn = rate ? null : `${t.quote} 对 BNB 的价格暂时拿不到，市值不显示`;
      // 校验：Gang V2 盘按链上 quoteSell（全部持仓）× 汇率核对，差 50% 以上或数值离谱就不显示，免得给出错误数字
      const chk = p.amount > 0 && this.trader.useGangV2?.(t) ? await this.sellCheck(t, rate) : null;
      if (value != null && chk?.bnb != null && Math.abs(value - chk.bnb) > 0.5 * Math.max(chk.bnb, 1e-12)) { warn = `按价格算 ${value.toFixed(4)} BNB，和链上卖出报价 ${chk.bnb.toFixed(4)} BNB 差太多，暂不显示`; value = null; }
      else if (value == null && chk?.bnb != null) value = chk.bnb;
      if (value != null && value > 1000) { warn = `市值算出来 ${value.toFixed(0)} BNB，明显不对，暂不显示`; value = null; }
      const supply = t.maxSupply || (t.source === 'agent-curve' ? t.totalShares : 0) || 1e9;
      const cost = bought + fees;
      rows.push({
        token: p.token, walletId: p.walletId, symbol: t.symbol, name: t.name, platform: t.platform, image: t.image || null, gangTrack: t.gangTrack || null,
        stage: claim.has(lc(p.token)) ? 'claim' : t.stage, claimMarket: claim.get(lc(p.token))?.market || null,
        amount: p.amount, supplyPct: supply ? (p.amount / supply) * 100 : null, price: t.price,
        quote: t.quote || 'BNB', quoteRate: rate || null, priceBnb: rate ? (t.price || 0) * rate : null,
        valueBnb: value, valueUsd: value != null ? value * bnbUsd : null, costBnb: cost, soldBnb: sold, warn, sellQuoteBnb: chk?.bnb ?? null, sellQuoteQ: chk?.q ?? null,
        avgCost: p.amount > 0 && bought ? (bought - sold > 0 ? (bought - sold) / p.amount : 0) : null,
        // 平均买入价：BNB 计（买入花的 BNB ÷ 买到的数量），报价币计（花的 GANG 等 ÷ 数量）
        avgBuyBnb: h?.boughtQty ? h.boughtBnb / h.boughtQty : (p.amount > 0 && bought ? bought / p.amount : null), avgBuyQuote: h?.boughtQty && h.boughtQuote ? h.boughtQuote / h.boughtQty : null,
        // 买入均价（美元）：钱包历史有就用每笔买入当时的美元 ÷ 买到的数量；只有本程序订单记录时按现价折算
        avgBuyUsd: h?.boughtQty ? h.boughtUsd / h.boughtQty : (p.amount > 0 && bought ? (bought * bnbUsd) / p.amount : null),
        pnlBnb: value != null ? value + sold - cost : null, pnlPct: value != null && cost > 0 ? ((value + sold - cost) / cost) * 100 : null,
        // 美元：市值按现在的 BNB 价；成本 / 卖出按每笔成交当时的 BNB 价（钱包历史里有的），本程序订单记录只能按现价
        costUsd: h ? h.boughtUsd + h.feesUsd : cost * bnbUsd, soldUsd: h ? h.soldUsd : sold * bnbUsd, usdBasis: h ? 'trade' : 'current',
        pnlUsd: value != null ? value * bnbUsd + (h ? h.soldUsd : sold * bnbUsd) - (h ? h.boughtUsd + h.feesUsd : cost * bnbUsd) : null,
        firstAt: h && isFinite(h.firstAt) ? h.firstAt : p.openedAt || null, lastAt: h?.lastAt || p.openedAt || null, boughtQty: h?.boughtQty || null, soldQty: h?.soldQty || 0, source: h ? 'wallet' : 'app',
        // 这个币同时是别的盘的报价币（如 GANG）：Gang V2 / Flap 买卖中间换出来的那部分也在这里，标出来方便换回 BNB
        isQuote: Object.keys(this.market.qUsd || {}).includes(lc(p.token)),
        trades: h ? h.trades.sort((a, b) => b.ts - a.ts).slice(0, 30) : [],
      });
    }
    rows.sort((a, b) => b.valueBnb - a.valueBnb || (b.firstAt || 0) - (a.firstAt || 0));
    const open = rows.filter((r) => r.amount > 0);
    const tot = (k, list = rows) => list.reduce((a, r) => a + (r[k] || 0), 0);   // 不显示的（null）按 0 计
    return {
      rows, realized: realizedTrades(this.hist, this.quoteSet()), historyScope: '最近可读取的钱包交易（最多 500 笔）；不含计价币兑换与仅有本地记录的曲线份额。成本按移动平均法，美元使用成交时小时价格，缺价时估算。', bnb: w?.bnb || 0, bnbUsd, historyAt: this.histAt, syncedAt: this.trader.syncAt || 0, updatedAt: Date.now(),
      totals: { valueBnb: tot('valueBnb', open), costBnb: tot('costBnb'), soldBnb: tot('soldBnb'), pnlBnb: tot('pnlBnb'), open: open.length,
        valueUsd: tot('valueUsd', open), costUsd: tot('costUsd'), soldUsd: tot('soldUsd'), pnlUsd: tot('pnlUsd') },
    };
  }
}
