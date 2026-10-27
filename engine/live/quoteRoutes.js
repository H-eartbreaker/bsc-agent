// 计价币兑换路线表与流动性门槛。只记录路线和公开池信息，不保存凭据。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pfetch } from '../netProxy.js';
import { dataFile, QUOTE_BY_ADDRESS } from './config.js';

const FILE = dataFile('quote-routes.json');
let table = null;
const load = () => {
  if (table) return table;
  try { table = JSON.parse(readFileSync(FILE, 'utf8')) || {}; } catch { table = {}; }
  return table;
};
export function getRoute(addr) { return load()[String(addr).toLowerCase()] || null; }
export const routeTokens = () => Object.entries(load()).map(([k, v]) => ({ token: k, symbol: v?.symbol || null }));   // 路线表里记过的所有币（计价币余额从链上读余额时用）
// 哪些地址算「计价币」：config 里固定的几个 + 路线表里有兑换路线记录的 + 运行时登记的（liveTrader 用行情里各盘的报价币登记）。
// 只有计价币才做下面的流动性检查；普通 meme 代币（内盘发射到外盘后的币）不检查：那是用户自己的持仓，池子再小也要能卖出
let quoteLookup = () => false;
export const setQuoteLookup = (fn) => { quoteLookup = fn; };
export function isQuoteToken(addr) { const k = String(addr || '').toLowerCase(); return !!QUOTE_BY_ADDRESS[k] || !!load()[k]?.buy || !!quoteLookup(k); }
// Ondo 代币化股票（FXIon / NVDAB / QQQB …）币安只允许和稳定币直接兑换，和 BNB 互换要拆成经 USDT 两步
export const USDT = '0x55d398326f99059fF775485246999027B3197955';   // BSC USDT（18 位小数）
export const ONDO_RE = /one side must be a supported stablecoin|Unsupported token pair for Ondo/i;
export const viaUsdt = (addr) => { const r = getRoute(addr); return r?.sell === 'via_USDT' || r?.buy === 'via_USDT'; };
export const markViaUsdt = (addr) => setRoute(addr, { buy: 'via_USDT', sell: 'via_USDT', note: '只能和稳定币直接兑换（Ondo 类）' });
export function setRoute(addr, route) {
  const k = String(addr).toLowerCase(), t = load();
  t[k] = { ...(t[k] || {}), ...route, checkedAt: Date.now() };
  try { mkdirSync(new URL('.', FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(t, null, 1)); } catch { /* 只读环境下保留内存结果 */ }
}

// 流动性门槛：计价币最深的池子流动性低于这个值（美元）就拒绝兑换，避免在小池子里吃大滑点。可用 QUOTE_MIN_LIQ_USD 调整。
// 只对计价币（isQuoteToken）生效；流动性未知（DexScreener 没收录）不拦
export const MIN_LIQ_USD = Number(process.env.QUOTE_MIN_LIQ_USD || 20000);
// 最深池子的流动性：先看路线表（实测时记下的），没有就查一次 DexScreener 记下来（同一个币 6 小时内不重复查）
async function deepestLiq(addr) {
  const k = String(addr).toLowerCase(), r = getRoute(k);
  if (r?.liqUsd != null && Date.now() - (r.liqAt || 0) < 6 * 3600_000) return r;
  if (r?.liqAt && r.liqUsd == null && Date.now() - r.liqAt < 10 * 60_000) return r;   // 上次 DexScreener 没收录（流动性未知）：10 分钟后再查
  try {
    const j = await (await pfetch('https://api.dexscreener.com/latest/dex/tokens/' + k, { signal: AbortSignal.timeout(6000) })).json();
    const pools = (j.pairs || []).filter((p) => p.chainId === 'bsc').map((p) => ({ pair: p.pairAddress, dex: p.dexId, labels: p.labels || [], liq: p.liquidity?.usd || 0, with: (p.baseToken.address.toLowerCase() === k ? p.quoteToken : p.baseToken).symbol })).sort((a, b) => b.liq - a.liq);
    // 没有查到任何池子 = 流动性未知（新池子 DexScreener 还没收录），不能记成 0，否则会被当成「池子太小」拒绝 6 小时
    setRoute(k, pools.length ? { liqUsd: pools[0].liq || 0, bestPool: pools[0], liqAt: Date.now() } : { liqUsd: null, bestPool: null, liqAt: Date.now() });
  } catch { return r; }   // 查不到就按已有记录（没有记录则不拦）
  return getRoute(k);
}
// 计价币美元价兜底（baw 余额列表没列出这个币、行情里也还没有价格时）：DexScreener 上这个币作为 base 的最深池子的价格，10 分钟缓存
const pxCache = new Map();
export async function dexPrice(addr) {
  const k = String(addr).toLowerCase(), c = pxCache.get(k); if (c && Date.now() - c.at < 10 * 60_000) return c.v;
  let v = null;
  try {
    const j = await (await pfetch('https://api.dexscreener.com/latest/dex/tokens/' + k, { signal: AbortSignal.timeout(6000) })).json();
    const p = (j.pairs || []).filter((x) => x.chainId === 'bsc' && x.baseToken?.address?.toLowerCase() === k && Number(x.priceUsd) > 0).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    v = p ? Number(p.priceUsd) : null;
  } catch { return c?.v ?? null; }
  pxCache.set(k, { at: Date.now(), v }); return v;
}
export async function assertLiquid(addr, symbol) {
  const r = await deepestLiq(addr); symbol ||= r?.symbol || r?.bestPool && null || `计价币 ${String(addr).slice(0, 6)}…${String(addr).slice(-4)}`;
  if (r?.liqUsd != null && r.liqUsd < MIN_LIQ_USD) throw new Error(`${symbol} 最深的池子流动性只有 $${Math.round(r.liqUsd).toLocaleString('en-US')}（低于 $${MIN_LIQ_USD.toLocaleString('en-US')}），为避免在小池子里吃大滑点，拒绝兑换`);
  return r;
}

// 等卖出到账的报价币：按 Transfer 日志（from = 卖出合约，to = 钱包）累加，不看余额差。
// 余额差会被同时进行的另一笔换回 BNB 抵掉（13:36 连卖两次 BEM，第二笔就一直等不到到账）
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad32 = (a) => '0x' + String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
export async function waitReceived({ provider, token, wallet, senders, fromBlock, ms = 5 * 60_000 }) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 2000))) {
    try {
      const logs = await provider.getLogs({ address: token, fromBlock, toBlock: 'latest', topics: [T_TRANSFER, senders.map(pad32), pad32(wallet)] });
      const got = logs.reduce((s, l) => s + BigInt(l.data), 0n); if (got > 0n) return got;
    } catch { /* 节点报错就下一轮再查 */ }
  }
  return 0n;
}
