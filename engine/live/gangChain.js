// gang.fun 新盘：直接监听链上「创建」事件，比轮询 gang.fun 接口快（接口约 5～11 秒，链上约 1～2 秒）。
// 事件格式按真实创建交易核对过（2026-10）：
// - 老盘 0x315B…23A7：topic0 0xe57a519f…，topics = [token, creator]，data = (string name, string symbol)
// - V2 Launchpad 0x1B8F…966E：topic0 0xd23a4470…，topics = [token, creator, quote]，data = (string name, string symbol, string logo, uint256, address, uint256)
//   （另外两个 V2 pad 0xF81C… / 0x60ae… 只有买卖事件，新盘都在 0x1B8F 上创建）
// 有 WSS（NODEREAL_RPC 自动换成 wss）就订阅 logs，另外每 15 秒用 getLogs 补查一次，防止断线漏掉；没有 WSS 就每 2 秒 getLogs。
// 只读：不发交易。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { NODEREAL_RPC } from './config.js';

export const GANG_OLD_PAD = '0x315Ba2e8952D06094CC636b2B84229FA32fb23A7';
export const GANG_V2_LAUNCHPAD = '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E';
const T_OLD = '0xe57a519fe6a031fac5d360f4b8ce246c86dd280b40dc37b68c0a7cc7394ef9c0';
const T_V2 = '0xd23a447045c377a966a79f59983bae21db7b92fead61df8ace4aea5628043791';
const FILTER = { address: [GANG_OLD_PAD, GANG_V2_LAUNCHPAD], topics: [[T_OLD, T_V2]] };
const coder = ethers.AbiCoder.defaultAbiCoder();
const KNOWN_QUOTES = { '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'BNB', '0x0c6302401aa5325c2e36f170f52c00b1d220b405': 'GANG', '0x4902c5ebc598265ed2212b559b042de8a5eeec3f': 'BNCB' };
const addr = (topic) => ethers.getAddress('0x' + topic.slice(26));

export class GangChain extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;   // 读链的 FailoverProvider（NodeReal 主节点）
    this.seen = new Set(); this.blockTs = new Map(); this.quoteSym = new Map(Object.entries(KNOWN_QUOTES));
    this.status = { mode: 'off', connected: false, found: 0, lastAt: 0, lastError: null, lastBlock: 0 };
  }

  async start() {
    try { this.status.lastBlock = await this.provider.getBlockNumber(); } catch (e) { this.status.lastError = e.shortMessage || e.message; }
    const wss = NODEREAL_RPC ? NODEREAL_RPC.replace(/^https:/, 'wss:').replace('/v1/', '/ws/v1/') : '';
    if (wss.startsWith('wss:')) this.subscribe(wss);
    this.pollLoop();
  }

  // WSS 订阅：断线 5 秒后重连
  subscribe(url) {
    let ws;
    try { ws = new ethers.WebSocketProvider(url, 56); } catch (e) { this.status.lastError = e.message; return setTimeout(() => this.subscribe(url), 5000); }
    this.ws = ws; this.status.mode = 'wss';
    ws.on(FILTER, (log) => { this.status.connected = true; this.handle(log).catch(() => {}); });
    ws.on('block', (b) => { this.status.connected = true; this.status.lastWssBlock = b; });
    const sock = ws.websocket;
    const retry = () => { if (this.ws !== ws) return; this.status.connected = false; this.ws = null; try { ws.destroy(); } catch { /* ignore */ } setTimeout(() => this.subscribe(url), 5000); };
    sock?.addEventListener?.('close', retry); sock?.addEventListener?.('error', retry);
  }

  // 补查：WSS 正常时每 15 秒，没有 WSS 时每 2 秒
  async pollLoop() {
    for (;;) {
      await new Promise((r) => setTimeout(r, this.ws && this.status.connected ? 15_000 : 2_000));
      try {
        const head = await this.provider.getBlockNumber();
        const from = Math.max(this.status.lastBlock + 1, head - 2000);
        if (head >= from) {
          for (const log of await this.provider.getLogs({ ...FILTER, fromBlock: from, toBlock: head })) await this.handle(log);
          this.status.lastBlock = head;
        }
        if (!this.ws) this.status.mode = 'poll';
        this.status.lastError = null;
      } catch (e) { this.status.lastError = e.shortMessage || e.message; }
    }
  }

  async handle(log) {
    const token = addr(log.topics[1]).toLowerCase();
    if (this.seen.has(token)) return; this.seen.add(token);
    const seenAt = Date.now();
    const v2 = log.topics[0] === T_V2;
    let name = '', symbol = '', logo = null, quoteAddress = null;
    try {
      if (v2) { const d = coder.decode(['string', 'string', 'string'], log.data); [name, symbol, logo] = [d[0], d[1], d[2] || null]; quoteAddress = addr(log.topics[3]).toLowerCase(); }
      else { const d = coder.decode(['string', 'string'], log.data); [name, symbol] = [d[0], d[1]]; }
    } catch { /* 解析失败时名称留空，等 gang.fun 接口补上 */ }
    let createdAt = Math.floor(seenAt / 1000);
    try { createdAt = await this.blockTime(log.blockNumber); } catch { /* 用发现时间 */ }
    const quoteSymbol = !v2 ? 'BNB' : await this.symbolOf(quoteAddress);
    this.status.found++; this.status.lastAt = seenAt; this.status.lastBlock = Math.max(this.status.lastBlock, log.blockNumber);
    this.emit('token', {
      address: token, name, symbol, creator: addr(log.topics[2]).toLowerCase(), createdAt, graduated: false, raisedQuote: 0, progressPct: 0,
      quoteSymbol, quoteAddress: v2 ? quoteAddress : null, logo: logo ? new URL(logo, 'https://gang.fun').href : null, track: v2 ? 'v2' : 'v1',
      fromChain: true, block: log.blockNumber, tx: log.transactionHash, seenAt,
    });
  }

  async blockTime(n) {
    if (!this.blockTs.has(n)) { const b = await this.provider.getBlock(n); this.blockTs.set(n, Number(b.timestamp)); if (this.blockTs.size > 200) this.blockTs.delete(this.blockTs.keys().next().value); }
    return this.blockTs.get(n);
  }

  async symbolOf(a) {
    if (!a) return 'BNB';
    if (!this.quoteSym.has(a)) {
      try { this.quoteSym.set(a, await new ethers.Contract(a, ['function symbol() view returns (string)'], this.provider).symbol()); } catch { return '?'; }
    }
    return this.quoteSym.get(a);
  }
}
