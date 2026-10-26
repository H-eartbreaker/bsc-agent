// Flap Agent Curve 链上 Reader：分页拉市场卡片（flap.sh Agent 专区列表），读详情与税率。
import { ethers } from 'ethers';
import { EventEmitter } from 'node:events';
import { READER, ZERO, QUOTE_BY_ADDRESS } from './config.js';

const PAGE = 16;
const FALLBACK = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com', 'https://bsc-dataseed1.defibit.io'];
const ABI = [
  'function marketPage(uint256 cursor,uint256 limit) view returns (address[] marketAddresses,uint256 nextCursor,uint256 total)',
  'function marketCards(address[] markets) view returns (tuple(address market,address quoteToken,string name,string symbol,string meta,address predictedToken,address token,address pair,uint8 phase,uint256 poolRaw,uint256 capRaw,uint256 progressBps,uint256 buyCount,uint256 sellCount,uint256 curveH,uint256 curveK)[] cards)',
  'function marketDetail(address market) view returns ((address market,address creator,address quoteToken,uint8 quoteDecimals,uint256 capRaw,uint256 poolRaw,uint256 remainingRaw,uint256 progressBps,uint8 phase,address predictedToken,address token,address pair,uint256 curveReserveRaw,uint256 totalShares,uint256 claimedShares,uint256 maxWalletShares,uint256 predictedInitialBuyNetRaw,bytes32 configHash,uint256 flapBuyFeeBps,uint256 flapSellFeeBps,uint256 agentFeeBps,uint256 buyCount,uint256 sellCount,uint256 cumulativeBuyGrossRaw,uint256 cumulativeBuySubmittedRaw,uint256 cumulativeBuyNetRaw,uint256 cumulativeBuyFeesRaw,uint256 cumulativeBuyRefundRaw,uint256 cumulativeBuyShares,uint256 cumulativeBuyCurveRaw,uint256 cumulativeSellDebitRaw,uint256 cumulativeSellPayoutRaw,uint256 cumulativeSellFeesRaw,uint256 cumulativeSellShares,uint256 cumulativeSellCurveRaw,uint256 cumulativeSellReserveRefundRaw,uint256 claimCount,uint256 uniqueBuyerCount,uint256 holderCount,uint256 virtualCurveVolumeRaw,uint256 cumulativeAgentFeesRaw,uint256 launchedAt,uint256 statsStartBlock,bool statsComplete,bool quoteBalanceKnown,uint256 quoteBalanceRaw,bool quoteBackingEnough,bool inventoryKnown,uint256 inventoryRaw,bool inventoryEnough) info)',
  'function marketSettings(address market) view returns (tuple(tuple(string name,string symbol,string meta,bytes32 salt,address beneficiary,uint16 buyTaxRate,uint16 sellTaxRate,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint16 maxWalletBps) launch,address quoteToken,uint8 quoteDecimals,uint256 capRaw,address quoteHelper,bytes32 quoteConfigHash,uint8 curveType,uint256 curveR,uint256 curveH,uint256 curveK,uint256 predictedInitialBuyNetRaw,uint256 virtualReserveAtCapRaw,uint256 maxWalletShares) info)',
];
export const PHASE = { 1: 'curve', 2: 'launching', 3: 'graduated' };
const quoteSym = (a) => (!a || a === ZERO ? 'BNB' : QUOTE_BY_ADDRESS[a.toLowerCase()] || 'TOKEN');
const f18 = (x, d = 18) => Number(ethers.formatUnits(x, d));

export class AgentCurve extends EventEmitter {
  constructor(provider, pollMs = 3000) {
    super();
    this.reader = new ethers.Contract(READER, ABI, provider);
    this.pollMs = pollMs; this.seen = new Map(); this.tax = new Map(); this.cold = true;
    this.status = { connected: false, total: 0, lastError: null, lastPollMs: 0 };
  }

  start() { this.tick(); this.timer = setInterval(() => this.tick(), this.pollMs); }

  async tick() {
    if (this.busy) return; this.busy = true; const t0 = Date.now();
    try { await this.poll(); this.status.connected = true; this.status.lastError = null; }
    catch (e) {
      this.fails = (this.fails || 0) + 1; this.status.lastError = e.shortMessage || e.message;
      if (this.fails >= 2) this.status.connected = false;   // 单次偶发错误（missing response 等）不报红
      if (this.fails % 2 === 0) { const u = FALLBACK[(this.rpcIdx = ((this.rpcIdx || 0) + 1) % FALLBACK.length)]; this.reader = new ethers.Contract(READER, ABI, new ethers.JsonRpcProvider(u, 56, { staticNetwork: true })); this.status.rpc = u; }
    }
    finally { if (this.status.lastError === null) this.fails = 0; this.busy = false; this.status.lastPollMs = Date.now() - t0; }
  }

  async poll() {
    const p0 = await this.reader.marketPage(0, PAGE);
    const total = Number(p0.total); this.status.total = total; if (!total) return;
    // 冷启动拉全量；之后只拉最新一页（新市场追加在末尾）
    const starts = this.cold ? Array.from({ length: Math.ceil(total / PAGE) }, (_, i) => i * PAGE) : [Math.max(0, total - PAGE)];
    const cards = [];
    for (const s of starts) {
      const page = s === 0 ? p0 : await this.reader.marketPage(s, PAGE);
      const ms = [...page.marketAddresses]; if (!ms.length) continue;
      cards.push(...(await this.reader.marketCards(ms)).map((c, i) => ({ c, idx: s + i })));
    }
    const changed = [];
    for (const { c, idx } of cards) {
      const k = c.market.toLowerCase();
      const h = [c.phase, c.progressBps, c.poolRaw, c.buyCount, c.sellCount, c.token].join('|');
      if (this.seen.get(k) === h) continue;
      const isNew = !this.seen.has(k);
      this.seen.set(k, h);
      changed.push({ c, idx, isNew });
    }
    for (let i = 0; i < changed.length; i += 8) {
      await Promise.all(changed.slice(i, i + 8).map(async (x) => { x.tax = await this.fetchTax(x.c.market); }));
    }
    const wasCold = this.cold; this.cold = false;
    for (const x of changed.sort((a, b) => a.idx - b.idx)) {
      // 修复参考版：Agent 曲线新市场也触发自动买；冷启动时的历史市场不触发
      this.emit('market', this.toItem(x.c, x.tax, x.idx), { isNew: x.isNew && !wasCold });
    }
  }

  async fetchTax(market) {
    const k = market.toLowerCase(); const hit = this.tax.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    try {
      const s = await this.reader.marketSettings(market);
      const row = { buyTaxBps: Number(s.launch.buyTaxRate), sellTaxBps: Number(s.launch.sellTaxRate), at: Date.now() };
      this.tax.set(k, row); return row;
    } catch { return { buyTaxBps: null, sellTaxBps: null, at: Date.now() }; }
  }

  toItem(c, tax, idx) {
    return {
      source: 'agent-curve', protocol: 'FLAP', market: c.market, index: idx,
      token: c.token !== ZERO ? c.token : c.predictedToken, realToken: c.token !== ZERO,
      name: c.name, symbol: c.symbol, meta: c.meta, quote: quoteSym(c.quoteToken), quoteAddress: c.quoteToken === ZERO ? null : c.quoteToken,
      phase: PHASE[Number(c.phase)] || 'curve', progress: Number(c.progressBps) / 100,
      pool: f18(c.poolRaw), cap: f18(c.capRaw), buys: Number(c.buyCount), sells: Number(c.sellCount),
      buyTaxBps: tax?.buyTaxBps, sellTaxBps: tax?.sellTaxBps,
    };
  }

  async detail(market) {
    const [d, s] = await Promise.all([this.reader.marketDetail(market), this.reader.marketSettings(market)]);
    const dec = Number(d.quoteDecimals) || 18;
    return {
      creator: d.creator, quoteDecimals: dec, pool: f18(d.poolRaw, dec), cap: f18(d.capRaw, dec), remaining: f18(d.remainingRaw, 18),
      totalShares: f18(d.totalShares), maxWalletShares: f18(d.maxWalletShares), holders: Number(d.holderCount),
      buys: Number(d.buyCount), sells: Number(d.sellCount), volume: f18(d.cumulativeBuyGrossRaw, dec) + f18(d.cumulativeSellPayoutRaw, dec),
      flapBuyFeeBps: Number(d.flapBuyFeeBps), flapSellFeeBps: Number(d.flapSellFeeBps), agentFeeBps: Number(d.agentFeeBps),
      buyTaxBps: Number(s.launch.buyTaxRate), sellTaxBps: Number(s.launch.sellTaxRate), maxWalletBps: Number(s.launch.maxWalletBps),
      launchedAt: Number(d.launchedAt) * 1000, phase: PHASE[Number(d.phase)] || 'curve', progress: Number(d.progressBps) / 100,
    };
  }
}
