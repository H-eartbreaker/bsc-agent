// fsi.taxed.fun：Flap Agent Curve 的价格与成交历史（按 market 地址）
import { FSI_BASE } from './config.js';

async function side(market, ns, limit) {
  const res = await fetch(`${FSI_BASE}/${String(market).toLowerCase()}/G/${ns}?sort=time_desc&limit=${limit}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`fsi_${res.status}`);
  const page = await res.json();
  return Array.isArray(page.items) ? page.items : [];
}
const n = (v) => (v == null ? 0 : Number(v));
const ts = (v) => { const x = n(v); return x < 1e12 ? x * 1000 : x; };   // 兼容秒 / 毫秒

/** 成交（含价格），最新在前 */
export async function fetchTrades(market, limit = 100) {
  const [b, s] = await Promise.all([side(market, 'virtualBuyFill', limit), side(market, 'virtualSellFill', limit)]);
  return [...b, ...s].filter((i) => i?.confirmed).map((i) => {
    const isSell = String(i.ns || '').includes('Sell');
    const quote = n(i.amount) / 1e18, shares = n(i.extra) / 1e18;
    return { ts: ts(i.updatedAt), side: isSell ? 'sell' : 'buy', bnb: quote, tokens: shares, price: shares > 0 ? quote / shares : 0, trader: i.actor, tx: i.txHash, block: n(i.blockNumber) };
  }).sort((a, b2) => b2.ts - a.ts);
}

/** 现价跳动（virtualBuy / virtualSell 的 spot price WAD），旧→新 */
export async function fetchTicks(market, limit = 200) {
  const [b, s] = await Promise.all([side(market, 'virtualBuy', limit), side(market, 'virtualSell', limit)]);
  const m = new Map();
  for (const i of [...b, ...s]) if (i?.confirmed && i.extra != null) m.set(`${i.txHash}:${i.logIndex}`, { ts: ts(i.updatedAt), price: n(i.extra) / 1e18, logIndex: n(i.logIndex) });
  return [...m.values()].sort((a, c) => a.ts - c.ts || a.logIndex - c.logIndex);
}

/** 第一笔买入时间（≈ 创建时间，创建者首买在创建交易里），毫秒；没有成交返回 0 */
export async function firstTradeAt(market) {
  const res = await fetch(`${FSI_BASE}/${String(market).toLowerCase()}/G/virtualBuyFill?sort=time_asc&limit=1`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`fsi_${res.status}`);
  const it = ((await res.json()).items || [])[0];
  return it ? ts(it.updatedAt) : 0;
}
