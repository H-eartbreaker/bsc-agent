// four.meme「Agentic Wallet 专属」内盘（OpenFour 模板 1778027615735）的链上行情：
// 只读 OpenFourCore 的 TokenCreated / TradeExecuted 事件（按模板 presetId 过滤），不依赖 four.meme 网站 API。
// 先回补最近 BACKFILL 个区块，然后每 POLL_MS 轮询新区块。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { maskRpc } from './rpc.js';
import { env } from './config.js';

export const CORE = '0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3';
export const AGENT_ID_TEMPLATE = 1778027615735n;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
// 扫 Four 事件（getLogs）：有 NodeReal 就用它，一次最多查约 5 万块；没有就用 publicnode，一次 5000 块。主节点出错时这一段自动拆成 5000 块用 publicnode 重查
const NODEREAL = env('NODEREAL_RPC', '');
const LOG_RPC = env('FOUR_LOG_RPC', NODEREAL || 'https://bsc-rpc.publicnode.com');
const STEP = Number(env('FOUR_LOG_STEP', NODEREAL && LOG_RPC === NODEREAL ? 49000 : 5000));
const FALLBACK_LOG_RPC = 'https://bsc-rpc.publicnode.com';
// 启动时回补的区块数：以前是 2 万块（BSC 出块快，只有两三个小时），更早发射、又没进 data/fourTokens.json 的盘（如 4AGENT）就再也不出现，「已迁移」里也看不到。
// 改成 15 万块（约一天），回补完的盘都会存进 fourTokens.json，之后重启从那里恢复
const BACKFILL = Number(env('FOUR_BACKFILL_BLOCKS', 150000));
const POLL_MS = 1000, POLL_SLOW_MS = 3000;
// 限流自动降速：连续 3 次限流 → 退回旧间隔 3000ms，冷却 10 分钟后再试快速
const RL_RE = /429|rate.?limit|too many requests|-32005|limit exceeded|限流/i;
function rlNote(st, err) {
  const now = Date.now();
  if (err && RL_RE.test(String(err.shortMessage || err.message || err) + ' ' + (err.code ?? '') + ' ' + (err.error?.code ?? ''))) {
    st.rlHits = (st.rlHits || 0) + 1;
    if (st.rlHits >= 3 && !(st.backoffUntil > now)) { st.backoffUntil = now + 10 * 60_000; st.backoffCount = (st.backoffCount || 0) + 1; console.log(`[Four] 连续限流 ${st.rlHits} 次，轮询退回 3000ms，10 分钟后再试 1000ms`); }
  } else if (!err) st.rlHits = 0;
  if (st.backoffUntil && st.backoffUntil <= now) { st.backoffUntil = 0; st.rlHits = 0; console.log('[Four] 限流冷却结束，恢复 1000ms 轮询'); }
  st.intervalMs = st.backoffUntil > now ? 3000 : 1000;
  return st.intervalMs;
}


const T_CREATED = '0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f';
const tradeIface = new ethers.Interface(['event TradeExecuted(address indexed token, address indexed trader, uint256 indexed presetId, bool isBuy, address quoteAsset, address vault, uint256 requestedTokenAmount, uint256 tokenAmount, uint256 curveQuoteAmount, uint256 traderQuoteAmount, uint256 lastPrice, uint256 slippageLimit, uint256 protocolFee, uint256 taxFee, uint256 devFee, uint256 antiSniperFee, uint256 totalRaised, uint256 remainingForSale)']);
const T_TRADE = tradeIface.getEvent('TradeExecuted').topicHash;
const TPL = ethers.zeroPadValue(ethers.toBeHex(AGENT_ID_TEMPLATE), 32);
const CORE_ABI = ['function tokens(address) view returns (uint32 version,address creator,uint256 presetId,address token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address tokenModule,address customData,uint256 createBlock,bool exists,bool paused,bool antiSniperEnabled)'];

// TokenCreated 的非 indexed 字段（链上实际布局）：…, tokenMetaUri, 一个 uint, encodedTags；tokenMetaUri 指向 static.four.meme 的 JSON（含图标）
const CREATED_DATA = ['uint256', 'string', 'string', 'uint256', 'uint256', 'uint256', 'uint256', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'string', 'uint256', 'bytes'];
const metaUriOf = (log) => { try { return ethers.AbiCoder.defaultAbiCoder().decode(CREATED_DATA, log.data)[14] || null; } catch { return null; } };
const f18 = (v) => Number(ethers.formatEther(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quoteSym = (a) => (!a || a.toLowerCase() === WBNB || a === ethers.ZeroAddress ? 'BNB' : a.toLowerCase() === '0x4902c5ebc598265ed2212b559b042de8a5eeec3f' ? 'BNCB' : `${a.slice(0, 6)}…`);

export class FourMeme extends EventEmitter {
  constructor() {
    super();
    this.provider = new ethers.JsonRpcProvider(LOG_RPC, 56, { staticNetwork: true });
    this.core = new ethers.Contract(CORE, CORE_ABI, this.provider);
    this.known = new Set();
    this.blockMs = 750;
    this.status = { connected: false, total: 0, head: 0, backfilledFrom: 0, lastError: null, lastPollMs: 0, rpc: maskRpc(LOG_RPC) };
  }

  start() { this.loop().catch((e) => { this.status.connected = false; this.status.lastError = e.shortMessage || e.message; }); }

  async logs(topics, from, to) {
    try { const r = await this.provider.getLogs({ address: CORE, topics, fromBlock: from, toBlock: to }); this.status.rpcActive = this.status.rpc; return r; }
    catch (e) {
      if (LOG_RPC === FALLBACK_LOG_RPC) throw e;
      this.fb ||= new ethers.JsonRpcProvider(FALLBACK_LOG_RPC, 56, { staticNetwork: true }); const out = [];
      for (let f = from; f <= to; f += 5000) out.push(...await this.fb.getLogs({ address: CORE, topics, fromBlock: f, toBlock: Math.min(f + 4999, to) }));
      this.status.rpcActive = FALLBACK_LOG_RPC; this.status.rpcFallbackErr = String(e.shortMessage || e.message || e).slice(0, 160);
      return out;
    }
  }

  // 区块时间：回补时按出块间隔估算，避免逐块查询
  async calibrate(head) {
    try {
      const [a, b] = await Promise.all([this.provider.getBlock(head), this.provider.getBlock(head - 1000)]);
      this.blockMs = ((a.timestamp - b.timestamp) * 1000) / 1000 || 750;
      this.headAt = { n: head, ms: a.timestamp * 1000 };
    } catch { this.headAt = { n: head, ms: Date.now() }; }
  }
  tsOf(n) { return Math.min(Date.now(), this.headAt.ms - (this.headAt.n - n) * this.blockMs); }

  async onCreated(log, live) {
    const token = ethers.getAddress('0x' + log.topics[3].slice(26));
    if (this.known.has(token.toLowerCase())) return;
    this.known.add(token.toLowerCase());
    let info = null;
    for (let k = 0; k < 3 && !info; k++) { try { info = await this.core.tokens(token); } catch { await sleep(800); } }
    this.status.total = this.known.size;
    this.emit('token', {
      token, creator: info?.creator || ethers.getAddress('0x' + log.topics[2].slice(26)), name: info?.name || '', symbol: info?.symbol || '?',
      quoteAddress: info?.quoteAsset || null, quote: quoteSym(info?.quoteAsset), raiseAmount: info ? f18(info.raiseAmount) : 13.5,
      saleAmount: info ? f18(info.saleAmount) : 8e8, maxSupply: info ? f18(info.maxSupply) : 1e9, antiSniper: !!info?.antiSniperEnabled,
      paused: !!info?.paused, createdAt: live ? Date.now() : this.tsOf(log.blockNumber), metaUri: metaUriOf(log),
    }, { isNew: live });
  }

  // 搜索里粘贴的地址不在列表时：直接读 OpenFourCore.tokens() 补进来（不是 OpenFour 代币返回 null）
  async lookup(address) {
    let info; try { info = await this.core.tokens(address); } catch { return null; }
    if (!info?.exists) return null;
    const token = ethers.getAddress(address); this.known.add(token.toLowerCase());
    const createdAt = this.headAt ? this.tsOf(Number(info.createBlock)) : Date.now();
    const item = { token, creator: info.creator, name: info.name, symbol: info.symbol, quoteAddress: info.quoteAsset, quote: quoteSym(info.quoteAsset),
      raiseAmount: f18(info.raiseAmount), saleAmount: f18(info.saleAmount), maxSupply: f18(info.maxSupply), antiSniper: !!info.antiSniperEnabled, paused: !!info.paused,
      createdAt, agentOnly: info.presetId === AGENT_ID_TEMPLATE };
    this.emit('token', item, { isNew: false });
    return item;
  }

  // 某个币从创建到现在的全部成交（链上 TradeExecuted，按 token 过滤），旧→新
  async tokenTrades(token, { lookbackBlocks } = {}) {
    const info = await this.core.tokens(token).catch(() => null);
    const head = await this.provider.getBlockNumber(); let from = Number(info?.createBlock || 0) || head - BACKFILL;
    if (!this.headAt) await this.calibrate(head);
    // Chart hydration is bounded so old contracts cannot trigger an unbounded archive scan.
    const createBlock = from;
    if (lookbackBlocks > 0) from = Math.max(from, head - Math.floor(lookbackBlocks) + 1);
    const out = []; out.historyPartial = from > createBlock;
    for (; from <= head; from += STEP) {
      const logs = await this.logs([T_TRADE, ethers.zeroPadValue(token, 32)], from, Math.min(from + STEP - 1, head));
      for (const l of logs) { const a = tradeIface.parseLog(l).args; out.push({ ts: this.tsOf(l.blockNumber), side: a.isBuy ? 'buy' : 'sell', tokens: f18(a.tokenAmount), bnb: f18(a.traderQuoteAmount), price: f18(a.lastPrice), trader: a.trader, tx: l.transactionHash }); }
    }
    return out;
  }

  // 某个地址在某个币上的全部成交（链上 TradeExecuted，按 token + trader 过滤，从创建区块查到最新，每次 STEP 块）
  async traderTrades(token, trader) {
    const info = await this.core.tokens(token).catch(() => null);
    const head = await this.provider.getBlockNumber(); let from = Number(info?.createBlock || 0) || head - BACKFILL;
    const pad = (a) => ethers.zeroPadValue(a, 32); const out = [];
    for (; from <= head; from += STEP) {
      const logs = await this.logs([T_TRADE, pad(token), pad(trader)], from, Math.min(from + STEP - 1, head));
      for (const l of logs) { const a = tradeIface.parseLog(l).args; out.push({ ts: this.tsOf(l.blockNumber), side: a.isBuy ? 'buy' : 'sell', tokens: f18(a.tokenAmount), bnb: f18(a.traderQuoteAmount), price: f18(a.lastPrice), trader: a.trader, tx: l.transactionHash }); }
    }
    return out;
  }

  onTrade(log, live) {
    const a = tradeIface.parseLog(log).args;
    this.emit('trade', {
      token: a.token, trader: a.trader, side: a.isBuy ? 'buy' : 'sell', tokens: f18(a.tokenAmount), bnb: f18(a.traderQuoteAmount), curveBnb: f18(a.curveQuoteAmount),
      taxFee: f18(a.taxFee), antiSniperFee: f18(a.antiSniperFee),   // 代币自己的税和防狙击税（平台费 protocolFee / devFee 另算）
      price: f18(a.lastPrice), raised: f18(a.totalRaised), remaining: f18(a.remainingForSale), tx: log.transactionHash,
      ts: live ? Date.now() : this.tsOf(log.blockNumber),
    });
  }

  async scan(from, to, live) {
    const created = await this.logs([T_CREATED, TPL], from, to);
    for (const l of created) await this.onCreated(l, live);
    const trades = await this.logs([T_TRADE, null, null, TPL], from, to);
    for (const l of trades) { try { this.onTrade(l, live); } catch { /* 忽略解析失败 */ } }
  }

  async loop() {
    let head = await this.provider.getBlockNumber();
    await this.calibrate(head);
    const start = head - BACKFILL;
    this.status.backfilledFrom = start;
    // 旧→新回补，最新的盘最后进来
    for (let f = start; f <= head; f += STEP) {
      try { await this.scan(f, Math.min(f + STEP - 1, head), false); }
      catch (e) { this.status.lastError = `回补 ${f}: ${e.shortMessage || e.message}`; }
    }
    this.status.connected = true; this.status.head = head;
    this.emit('ready');
    for (;;) {
      await sleep(this.status.intervalMs || POLL_MS);
      const t0 = Date.now();
      try {
        const now = await this.provider.getBlockNumber();
        if (now <= head) continue;
        const to = Math.min(now, head + STEP);
        this.headAt = { n: to, ms: Date.now() };
        await this.scan(head + 1, to, true);
        head = to; this.status.head = head;
        this.status.connected = true; this.status.lastError = null; rlNote(this.status, null);
      } catch (e) { this.status.connected = false; this.status.lastError = e.shortMessage || e.message; rlNote(this.status, e); }
      this.status.lastPollMs = Date.now() - t0;
    }
  }
}
