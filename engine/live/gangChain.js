// gang.fun 新盘：直接监听链上「创建」事件，比轮询 gang.fun 接口快（接口约 5～11 秒，链上约 1～2 秒）。
// 事件格式按真实创建交易核对过（2026-10）：
// - 老盘 0x315B…23A7：topic0 0xe57a519f…，topics = [token, creator]，data = (string name, string symbol)
// - V2 Launchpad 0x1B8F…966E：topic0 0xd23a4470…，topics = [token, creator, quote]，data = (string name, string symbol, string logo, uint256, address, uint256)
//   （另外两个 V2 pad 0xF81C… / 0x60ae… 只有买卖事件，新盘都在 0x1B8F 上创建）
// WebSocket 订阅 logs：先用 NodeReal（NODEREAL_RPC 自动换成 wss），连不上 / 被限流就换 publicnode 的 wss，10 分钟后再试回 NodeReal。
// 订阅正常时每 60 秒用 getLogs 补查一次（从上次查到的区块开始，断线期间漏的也会补上）；订阅不可用时每 3 秒查一次。补查走公共节点优先的 provider。
// 只读：不发交易。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { NODEREAL_WSS } from './config.js';
import { WsLogs, PUBLIC_WSS } from './rpc.js';
import { T_V3_CREATED, T_FAIR_CREATED, isV3Pad, verifyV3Pad } from './gangV3.js';

export const GANG_OLD_PAD = '0x315Ba2e8952D06094CC636b2B84229FA32fb23A7';
export const GANG_V2_LAUNCHPAD = '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E';
const T_OLD = '0xe57a519fe6a031fac5d360f4b8ce246c86dd280b40dc37b68c0a7cc7394ef9c0';
const T_V2 = '0xd23a447045c377a966a79f59983bae21db7b92fead61df8ace4aea5628043791';
const FILTER = { address: [GANG_OLD_PAD, GANG_V2_LAUNCHPAD], topics: [[T_OLD, T_V2]] };
// Gang V3（GangLaunchpad）主网地址还没公布：按新 Created topic 订阅全链，发出事件的合约在 handle 里核对是不是官方的（gangV3.verifyV3Pad）
const FILTER_V3 = { topics: [[T_V3_CREATED, T_FAIR_CREATED]] };
const coder = ethers.AbiCoder.defaultAbiCoder();
const KNOWN_QUOTES = { '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'BNB', '0x0c6302401aa5325c2e36f170f52c00b1d220b405': 'GANG', '0x4902c5ebc598265ed2212b559b042de8a5eeec3f': 'BNCB', '0x21caef8a43163eea865baee23b9c2e327696a3bf': 'XAUt', '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a': 'BEM', '0x3f53de71c126bdabae20f9cd64848d317f6c3238': 'GOOGLB' };
// 不是 18 位小数的报价币（gang.fun 接口和成交事件都按 18 位给数，要按这里换算）；不在表里的新报价币由 liveMarket 读链上 decimals()
export const QUOTE_DEC = { '0x21caef8a43163eea865baee23b9c2e327696a3bf': 6, '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a': 8 };
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
    this.sub = new WsLogs({ label: 'gang', urls: [...NODEREAL_WSS.slice().reverse(), PUBLIC_WSS] /* 和 Four 的订阅错开，先用另一个 key */, filters: [FILTER, FILTER_V3], onLog: (log) => this.handle(log).catch(() => {}), status: this.status }).start();
    this.status.mode = 'wss';
    this.pollLoop();
  }

  // 补查：订阅正常时每 60 秒，不正常时每 3 秒；每次最多查 2000 块一段，断线久了分段补齐（最多往回 5 万块）
  async pollLoop() {
    for (;;) {
      await new Promise((r) => setTimeout(r, this.sub?.live ? 60_000 : 3_000));
      this.status.mode = this.sub?.live ? 'wss' : 'poll';
      try {
        const head = await this.provider.getBlockNumber();
        let from = Math.max(this.status.lastBlock + 1, head - 50_000);
        while (from <= head) {
          const to = Math.min(head, from + 1999);
          for (const log of await this.provider.getLogs({ ...FILTER, fromBlock: from, toBlock: to })) await this.handle(log);
          for (const log of await this.provider.getLogs({ ...FILTER_V3, fromBlock: from, toBlock: to }).catch(() => [])) await this.handle(log);   // 不带地址的查询有的节点不支持，失败就只靠订阅
          this.status.lastBlock = to; from = to + 1;
        }
        if (!this.sub?.live) this.status.pollError = null;
      } catch (e) { this.status.pollError = e.shortMessage || e.message; }
    }
  }

  async handle(log) {
    const token = addr(log.topics[1]).toLowerCase();
    if (this.seen.has(token)) return; this.seen.add(token);
    const seenAt = Date.now();
    const v3 = log.topics[0] === T_V3_CREATED || log.topics[0] === T_FAIR_CREATED, fair = log.topics[0] === T_FAIR_CREATED;
    if (v3 && !isV3Pad(log.address) && !(await verifyV3Pad(this.provider, log.address, token))) return;   // 第一次看到这个内盘要核对 owner（一次 eth_call，约 0.2 秒）
    const v2 = log.topics[0] === T_V2 || v3;   // V3 事件的前几个字段（topics = [token, creator, quote]，data 开头 name / symbol / logo）和 V2 一样
    let name = '', symbol = '', logo = null, quoteAddress = null;
    try {
      if (v2) { const d = coder.decode(['string', 'string', 'string'], log.data); [name, symbol, logo] = [d[0], d[1], d[2] || null]; quoteAddress = addr(log.topics[3]).toLowerCase(); }
      else { const d = coder.decode(['string', 'string'], log.data); [name, symbol] = [d[0], d[1]]; }
    } catch { /* 解析失败时名称留空，等 gang.fun 接口补上 */ }
    // 先推送、后补区块时间（狙击要快：不等 getBlock 那一次查询，约 0.1～0.3 秒）。区块时间在缓存里就直接用；
    // 否则先按「发现时间 − 0.5 秒」估，查到真实区块时间后改掉同一个对象的 createdAt，timeP 给要用真实时间的地方 await
    const cached = this.blockTs.get(log.blockNumber);
    const timeP = cached != null ? Promise.resolve(cached) : this.blockTime(log.blockNumber).catch(() => null);
    let createdAt = cached ?? Math.floor((seenAt - 500) / 1000);
    const quoteSymbol = !v2 ? 'BNB' : this.quoteSym.get(quoteAddress) || await this.symbolOf(quoteAddress);   // 已知报价币同步取，不等
    this.status.found++; this.status.lastAt = seenAt; this.status.lastBlock = Math.max(this.status.lastBlock, log.blockNumber);
    const it = {
      address: token, name, symbol, creator: addr(log.topics[2]).toLowerCase(), createdAt, graduated: false, raisedQuote: 0, progressPct: 0,
      quoteSymbol, quoteAddress: v2 ? quoteAddress : null, logo: logo ? new URL(logo, 'https://gang.fun').href : null, track: fair ? 'v3fair' : v3 ? 'v3' : v2 ? 'v2' : 'v1', pad: v3 ? log.address.toLowerCase() : null,
      fromChain: true, block: log.blockNumber, tx: log.transactionHash, seenAt, timeP,
    };
    this.emit('token', it);
    timeP.then((ts) => { if (ts != null && ts !== it.createdAt) { it.createdAt = ts; this.emit('tokenTime', it); } });
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
