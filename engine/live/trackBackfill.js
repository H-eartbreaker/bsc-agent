// 追踪地址的历史回补：添加追踪时，从链上补出这些地址最近 N 小时在 Flap / Four / Gang V2 内盘上的买卖。
// 只读，不发交易。结果只写进追踪历史（标记 backfill），不响提示音、不触发跟单（跟单只对实时新成交生效）。
// 查询量：每个平台按大段（默认 4.9 万块）分段 getLogs，出错自动减半重试；Gang / Four 按交易者地址过滤，Flap 的事件没有带索引的交易者，只能按主题查完再筛。
import { ethers } from 'ethers';

const f18 = (v) => Number(ethers.formatEther(v));
const pad = (a) => ethers.zeroPadValue(a, 32);
const lc = (a) => String(a || '').toLowerCase();

// Flap：通用事件（见 flapChain.js）
const FLAP_T = '0x0483a030f7f57a91177910ed00ae51f19170eb9db2129394c858e7e3bc188aed';
// Gang V2：三个 pad 的买 / 卖（见 gangPadChain.js）
const GANG_PADS = ['0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb', '0x60aee38576035E757deD30fF8db8A8DA476430C1'];
const GANG_BUY = '0x6e59ac1e0b7a4b5c385ffff3601e05644c2ed9d875089895ed1b88e9cf8c632a';
const GANG_SELL = '0x00055e00ae56ca9d108326c7fd1ab1e6380614100b19bf3e4d1411240a726d86';
// Four（Agentic Wallet 专属模板）：OpenFourCore 的 TradeExecuted（见 fourMeme.js）
const FOUR_CORE = '0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3';
const fourIface = new ethers.Interface(['event TradeExecuted(address indexed token, address indexed trader, uint256 indexed presetId, bool isBuy, address quoteAsset, address vault, uint256 requestedTokenAmount, uint256 tokenAmount, uint256 curveQuoteAmount, uint256 traderQuoteAmount, uint256 lastPrice, uint256 slippageLimit, uint256 protocolFee, uint256 taxFee, uint256 devFee, uint256 antiSniperFee, uint256 totalRaised, uint256 remainingForSale)']);
const FOUR_T = fourIface.getEvent('TradeExecuted').topicHash;
const coder = ethers.AbiCoder.defaultAbiCoder();

// 分段 getLogs：一段出错就减半重试（最小 2000 块），返回全部日志
export async function getLogsChunked(provider, filter, from, to, step = 49_000) {
  const out = [];
  for (let f = from; f <= to;) {
    const t = Math.min(to, f + step - 1);
    try { out.push(...await provider.getLogs({ ...filter, fromBlock: f, toBlock: t })); f = t + 1; }
    catch (e) { if (step <= 2000) throw e; step = Math.floor(step / 2); }
  }
  return out;
}

// 返回 [{ platform, token, trader, side, bnb（报价币数量）, tokens, tx, block, logIndex }]，按区块从旧到新
export async function fetchTraderHistory(provider, addresses, { hours = 24, blockMs = 450 } = {}) {
  const who = [...new Set(addresses.map(lc))].filter((a) => /^0x[0-9a-f]{40}$/.test(a)); if (!who.length) return { trades: [], head: 0 };
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('回补范围须在 0～24 小时之间');
  const head = await provider.getBlockNumber();
  const latest = await provider.getBlock(head); if (!latest) throw new Error('读取区块失败');
  const cutoff = Number(latest.timestamp) - hours * 3600;
  // 用实际区块时间定位窗口，不假定 BSC 的出块速度恒定。
  let lo = 0, hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2), block = await provider.getBlock(mid);
    if (!block) throw new Error('读取历史区块失败');
    if (Number(block.timestamp) < cutoff) lo = mid + 1; else hi = mid;
  }
  const from = lo;
  const set = new Set(who), topicWho = who.map(pad), trades = [];
  // Gang V2
  for (const l of await getLogsChunked(provider, { address: GANG_PADS, topics: [[GANG_BUY, GANG_SELL], null, topicWho] }, from, head)) {
    if (l.topics.length < 3 || !set.has(lc('0x' + l.topics[2].slice(26)))) continue;
    const w = l.data.slice(2).match(/.{64}/g) || []; if (w.length < 4) continue;
    const buy = l.topics[0] === GANG_BUY, n = (x) => f18(BigInt('0x' + x));
    const tokens = buy ? n(w[3]) : n(w[0]); if (!(tokens > 0)) continue;
    trades.push({ platform: 'gang', token: lc('0x' + l.topics[1].slice(26)), trader: lc('0x' + l.topics[2].slice(26)), side: buy ? 'buy' : 'sell', bnb: buy ? n(w[0]) + n(w[1]) + n(w[2]) : n(w[3]), tokens, tx: l.transactionHash, block: l.blockNumber, logIndex: l.index });
  }
  // Four
  for (const l of await getLogsChunked(provider, { address: FOUR_CORE, topics: [FOUR_T, null, topicWho] }, from, head)) {
    let a; try { a = fourIface.parseLog(l).args; } catch { continue; }
    if (!set.has(lc(a.trader))) continue;
    trades.push({ platform: 'four', token: lc(a.token), trader: lc(a.trader), side: a.isBuy ? 'buy' : 'sell', bnb: f18(a.traderQuoteAmount), quoteAddress: lc(a.quoteAsset), tokens: f18(a.tokenAmount), tx: l.transactionHash, block: l.blockNumber, logIndex: l.index });
  }
  // Flap：按主题查，再按交易者筛
  for (const l of await getLogsChunked(provider, { topics: [FLAP_T] }, from, head)) {
    const kind = Buffer.from(l.data.slice(2, 66), 'hex').toString().replace(/\0+$/, ''); if (kind !== 'virtualBuyFill' && kind !== 'virtualSellFill') continue;
    let d; try { d = coder.decode(['bytes32', 'uint256', 'address', 'address', 'uint256', 'uint256'], l.data); } catch { continue; }
    if (!set.has(lc(d[2]))) continue;
    const tokens = f18(d[5]); if (!(tokens > 0)) continue;
    trades.push({ platform: 'flap', token: lc(d[3]), trader: lc(d[2]), side: kind === 'virtualBuyFill' ? 'buy' : 'sell', bnb: f18(d[4]), tokens, tx: l.transactionHash, block: l.blockNumber, logIndex: l.index });
  }
  trades.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { trades, head };
}

// 给回补的成交标动作：窗口开始前的持仓未知，按窗口内累计数量判断；
// 卖出时累计不够（之前就持有）：如果这是这个币最后一笔且现在余额 ≈ 0 → 清仓，否则减仓
export function labelActions(trades, currentBalance = new Map()) {
  const pos = new Map(), last = new Map();
  trades.forEach((t, i) => last.set(`${t.trader}|${t.token}`, i));
  return trades.map((t, i) => {
    const key = `${t.trader}|${t.token}`, before = pos.get(key) || 0; let action, pct = null;
    if (t.side === 'buy') { action = before <= t.tokens * 0.001 ? '建仓' : '加仓'; pos.set(key, before + t.tokens); }
    else {
      if (before >= t.tokens * 0.999) { const after = before - t.tokens; pct = Math.min(100, (t.tokens / before) * 100); action = after <= before * 0.005 ? '清仓' : '减仓'; pos.set(key, Math.max(0, after)); }
      else { const bal = currentBalance.get(key); action = last.get(key) === i && bal != null && bal <= t.tokens * 0.005 ? '清仓' : '减仓'; if (action === '清仓') pct = 100; pos.set(key, 0); }
    }
    return { ...t, action, pct };
  });
}
