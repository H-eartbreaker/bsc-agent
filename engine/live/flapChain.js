// Read-only Flap Agent Curve event feed. It supplements shrine/fsi and
// immediately refreshes the Reader when a new market is created.
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';

const EVENT = '0x0483a030f7f57a91177910ed00ae51f19170eb9db2129394c858e7e3bc188aed';
const coder = ethers.AbiCoder.defaultAbiCoder();
const name32 = (hex) => Buffer.from(String(hex).slice(2, 66), 'hex').toString().replace(/\0+$/, '');

export class FlapChain extends EventEmitter {
  constructor(provider) { super(); this.provider = provider; this.lastBlock = 0; this.seen = new Set(); this.status = { connected: false, lastBlock: 0, trades: 0, pollError: null }; }
  async start() {
    try { this.lastBlock = await this.provider.getBlockNumber(); this.status.lastBlock = this.lastBlock; this.status.connected = true; } catch (e) { this.status.pollError = e.shortMessage || e.message; }
    this.poll();
  }
  async poll() {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.status.pollError ? 10_000 : 60_000));
      try {
        const head = await this.provider.getBlockNumber();
        for (let from = Math.max(this.lastBlock + 1, head - 20_000); from <= head; from += 2_000) {
          const to = Math.min(head, from + 1_999);
          for (const log of await this.provider.getLogs({ topics: [EVENT], fromBlock: from, toBlock: to })) this.handle(log);
        }
        this.lastBlock = head; this.status.lastBlock = head; this.status.connected = true; this.status.pollError = null;
      } catch (e) { this.status.connected = false; this.status.pollError = e.shortMessage || e.message; }
    }
  }
  handle(log) {
    const id = `${log.transactionHash}:${log.index}`; if (this.seen.has(id)) return; this.seen.add(id);
    if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
    const kind = name32(log.data);
    if (kind === 'virtualMarketCreated') return this.emit('created', { block: log.blockNumber, tx: log.transactionHash });
    if (kind !== 'virtualBuyFill' && kind !== 'virtualSellFill') return;
    let d; try { d = coder.decode(['bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256'], log.data); } catch { return; }
    const quote = Number(ethers.formatEther(d[4])), tokens = Number(ethers.formatEther(d[5])); if (!(tokens > 0)) return;
    this.status.trades++;
    this.emit('trade', { token: String(d[3]).toLowerCase(), trader: String(d[2]).toLowerCase(), side: kind === 'virtualBuyFill' ? 'buy' : 'sell', bnb: quote, tokens, price: quote / tokens, tx: log.transactionHash, block: log.blockNumber, ts: Date.now() });
  }
}
