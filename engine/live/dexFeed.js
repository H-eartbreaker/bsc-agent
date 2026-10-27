// 已发射（迁移）到 PancakeSwap V2 的币：直接读池子的 Swap 事件当外盘成交，和内盘 K 线接成一条完整的线。
// Flap / Four / Gang 毕业后都在 PancakeSwap V2 建「代币 / 报价币」池（见 dexDirect.js）。以前外盘只用 GeckoTerminal 分钟 K 线，
// Gang 盘连这个都没接，详情页 K 线停在毕业那一刻，成交列表、成交量也没有外盘的部分。
//   链上：公共节点只给最近约 1 小时（几千个区块）的日志，第一次从「最新区块 − 4500」读起，之后详情页每 3 秒刷新时从上次读到的区块接着读
//   更早的历史：GeckoTerminal 分钟 K 线（currency=token，直接是报价币单位），从迁移时间往后翻页补齐，10 分钟重拉一次
// 区块时间按每段首尾两个区块的时间戳插值（不逐块查），K 线够用。价格、金额都是报价币单位（和内盘 K 线一致）
import { ethers } from 'ethers';
import { pfetch } from '../netProxy.js';

const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const SWAP = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'), SYNC = ethers.id('Sync(uint112,uint112)');
const SPAN = 4500;          // 公共节点 getLogs 每次最多 5000 个区块，且只保留最近约 5000 个区块的日志
const MAX_SWAPS = 20_000;
const i = new ethers.Interface([
  'function getPair(address,address) view returns (address)', 'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)', 'function decimals() view returns (uint8)',
]);
const abi = ethers.AbiCoder.defaultAbiCoder();
const isW = (a) => !a || a === ethers.ZeroAddress || String(a).toLowerCase() === WBNB;

export class DexFeed {
  constructor(provider) { this.p = provider; this.bts = new Map(); }

  async call(to, fn, args = []) { return i.decodeFunctionResult(fn, await this.p.call({ to, data: i.encodeFunctionData(fn, args) })); }

  // 池子：和盘的报价币配的优先，其次和 WBNB 配的；只认有储备的
  async pairOf(t) {
    if (t.dexInfo) return t.dexInfo;
    if (t.dexInfoAt && Date.now() - t.dexInfoAt < 30_000) return null; t.dexInfoAt = Date.now();
    for (const q of [...new Set([isW(t.quoteAddress) ? WBNB : String(t.quoteAddress).toLowerCase(), WBNB])]) {
      const pair = (await this.call(FACTORY, 'getPair', [t.address, q]))[0];
      if (pair === ethers.ZeroAddress) continue;
      const [r0, r1] = await this.call(pair, 'getReserves'); if (!(r0 > 0n && r1 > 0n)) continue;
      const t0 = (await this.call(pair, 'token0'))[0].toLowerCase();
      const [tDec, qDec] = await Promise.all([this.call(t.address, 'decimals').then((x) => Number(x[0])).catch(() => 18), isW(q) ? 18 : this.call(q, 'decimals').then((x) => Number(x[0])).catch(() => 18)]);
      return (t.dexInfo = { pair: pair.toLowerCase(), quote: q, tokenIs0: t0 === t.address.toLowerCase(), tDec, qDec });
    }
    return null;
  }

  async ts(n) { if (this.bts.has(n)) return this.bts.get(n); const b = await this.p.getBlock(n); const v = b.timestamp * 1000; if (this.bts.size > 2000) this.bts.clear(); this.bts.set(n, v); return v; }

  // GeckoTerminal 分钟 K 线（报价币单位），从最新往前翻页，翻到迁移时间或最多 6 页（约 4 天）为止
  async history(t, info) {
    if (t.dexHistAt && Date.now() - t.dexHistAt < 600_000) return false; t.dexHistAt = Date.now();
    const out = []; let before = '';
    for (let page = 0; page < 6; page++) {
      const j = await (await pfetch(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${info.pair}/ohlcv/minute?aggregate=1&limit=1000&currency=token&token=${t.address}${before}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })).json();
      const l = j?.data?.attributes?.ohlcv_list || []; if (String(j?.meta?.base?.address || '').toLowerCase() !== t.address.toLowerCase()) break;
      out.push(...l); if (l.length < 1000) break;
      const min = Math.min(...l.map((x) => x[0])); if (t.migratedAt && min * 1000 <= t.migratedAt) break; before = `&before_timestamp=${min}`;
    }
    if (!out.length) { t.dexHistAt = Date.now() - 570_000; return false; }   // 没取到：30 秒后再试，不要等 10 分钟
    const seen = new Set(); t.dexHist = out.filter((x) => !seen.has(x[0]) && seen.add(x[0])).sort((a, b) => a[0] - b[0]).map(([ts, o, h, l, c, v]) => ({ t: ts, o, h, l, c, v, dex: 1 }));
    return true;
  }

  // 价格用这笔成交之后池子的现价（同一笔交易里紧挨着的 Sync 事件给的储备），和 GeckoTerminal / 市值口径一致；没有 Sync 时退回成交均价
  parse(log, info, ts, sync) {
    const [a0In, a1In, a0Out, a1Out] = abi.decode(['uint256', 'uint256', 'uint256', 'uint256'], log.data);
    const [tIn, tOut, qIn, qOut] = info.tokenIs0 ? [a0In, a0Out, a1In, a1Out] : [a1In, a1Out, a0In, a0Out];
    const buy = tOut > tIn, tok = Number(ethers.formatUnits(buy ? tOut - tIn : tIn - tOut, info.tDec)), q = Number(ethers.formatUnits(buy ? qIn - qOut : qOut - qIn, info.qDec));
    if (!(tok > 0) || !(q > 0)) return null;
    // 买入的收币地址就是买家（经路由也是）；卖出时 to 多半是路由（换成 BNB 再转给卖家），不当成交易者
    let price = q / tok;
    if (sync && sync.transactionHash === log.transactionHash) { const [r0, r1] = abi.decode(['uint112', 'uint112'], sync.data); const rt = Number(ethers.formatUnits(info.tokenIs0 ? r0 : r1, info.tDec)), rq = Number(ethers.formatUnits(info.tokenIs0 ? r1 : r0, info.qDec)); if (rt > 0 && rq > 0) price = rq / rt; }
    return { side: buy ? 'buy' : 'sell', tokens: tok, bnb: q, price, ts, tx: log.transactionHash, block: log.blockNumber, trader: buy ? '0x' + log.topics[2].slice(26) : null, dex: 1 };
  }

  // 补到最新区块。第一次从迁移的区块开始（不知道迁移时间就从最近约 8 小时开始）；同一个币同时只跑一个
  async sync(t) {
    if (t._dexBusy) return false; t._dexBusy = true;
    try {
      const info = await this.pairOf(t); if (!info) return false;
      const [latest, res] = await Promise.all([this.p.getBlockNumber(), this.call(info.pair, 'getReserves').catch(() => null)]);
      if (res) t.dexQuoteRes = Number(ethers.formatUnits(info.tokenIs0 ? res[1] : res[0], info.qDec));   // 池子里的报价币，算底池用
      if (!t.dexSwaps) { t.dexSwaps = []; t.dexTo = latest - SPAN; }
      let added = (await this.history(t, info).catch(() => false)) ? 1 : 0;
      while (t.dexTo < latest) {
        const a = t.dexTo + 1, b = Math.min(a + SPAN - 1, latest);
        const logs = await this.p.getLogs({ address: info.pair, topics: [[SWAP, SYNC]], fromBlock: a, toBlock: b });
        if (logs.length) {
          const [ta, tb] = await Promise.all([this.ts(a), this.ts(b)]);
          let sync = null;
          for (const l of logs) {
            if (l.topics[0] === SYNC) { sync = l; continue; }
            const r = this.parse(l, info, Math.round(ta + ((tb - ta) * (l.blockNumber - a)) / Math.max(1, b - a)), sync); if (r) { t.dexSwaps.push(r); added++; }
          }
          if (t.dexSwaps.length > MAX_SWAPS) t.dexSwaps.splice(0, t.dexSwaps.length - MAX_SWAPS);
        }
        t.dexTo = b;
      }
      return added > 0;
    } finally { t._dexBusy = false; }
  }
}

// 外盘 K 线：GeckoTerminal 历史分钟线（链上成交之前的部分）+ 链上成交按时间分桶（桶大小自动放大，外盘部分最多约 2000 根）
const BUCKETS = [1, 5, 15, 60, 300, 900, 3600, 14400];
export function dexBars(swaps, hist = []) {
  const first = swaps.length ? Math.floor(swaps[0].ts / 1000 / 60) * 60 : Infinity, older = hist.filter((c) => c.t < first);
  if (!swaps.length) return compactCandles(older, 2000);
  const span = (swaps.at(-1).ts - swaps[0].ts) / 1000, max = Math.max(200, 2000 - older.length);
  const b = BUCKETS.find((x) => span / x <= max) || BUCKETS.at(-1); const out = [];
  for (const s of swaps) {
    const k = Math.floor(s.ts / 1000 / b) * b, l = out[out.length - 1];
    if (l && l.t === k) { l.h = Math.max(l.h, s.price); l.l = Math.min(l.l, s.price); l.c = s.price; l.v += s.bnb; }
    else { const o = l ? l.c : s.price; out.push({ t: k, o, h: Math.max(o, s.price), l: Math.min(o, s.price), c: s.price, v: s.bnb, dex: 1 }); }
  }
  return compactCandles(older, 2000 - out.length).concat(out);
}

// 整条 K 线超过 max 根时按时间合并（以前直接只取最后 max 根，外盘成交一多内盘那段就看不到了）
export function compactCandles(cs, max) {
  if (cs.length <= max) return cs;
  const span = cs.at(-1).t - cs[0].t; const b = BUCKETS.find((x) => span / x <= max) || BUCKETS.at(-1); const out = [];
  for (const c of cs) {
    const k = Math.floor(c.t / b) * b, l = out[out.length - 1];
    if (l && l.t === k) { l.h = Math.max(l.h, c.h); l.l = Math.min(l.l, c.l); l.c = c.c; l.v += c.v; } else out.push({ ...c, t: k });
  }
  return out.slice(-max);
}
