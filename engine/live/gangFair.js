// gang.fun 打新（fair mint）：列出在打的盘 + 本钱包和 WALLET_PEERS 里的其他钱包并行提交；BSC Agent 买卖（认购 / 退出）也用这里的 fairBuy / fairSell。
// 依据官方仓库 github.com/gangfun/gang-launchpad（skill/gang-cli/src/fair.js、src/router/GangRouter.sol）：
// - 打新和 V3 曲线在同一个 GangLaunchpad（pad）上，kindOf = 2 是打新。sales(token) 给单价、每地址上限份数、已卖份数，共 10000 份，卖满即上 PancakeSwap
// - WBNB 盘、有 Agent ID 门槛（gate）时走 GangRouter.fairMintBNB(token, shares, minShares, deadline)，value = 份数 × 单价 × (1 + mintFee)，
//   router 只收实际成交那部分，多余 BNB 同笔退回。minShares 取 1：别人先打导致剩余不足时能拿多少拿多少，不整笔回滚
// - 注意：gang.fun /api/v3/config 的 router 字段是 taxHandler（0x6d8d…），调它会回滚；真实打新交易都发到 0xE040…（它的 pad() 指向官方 pad）
// 不做预报价：一次 sales() 读单价，每个钱包各自 baw contract-call preview → execute。其他钱包直接用它自己的 baw 命令（比如 docker exec 容器里的 baw），不经过它的后端。
// 每个钱包提交前核对地址：本钱包 = WALLET_ADDRESS；其他钱包 = WALLET_PEERS 里的 address，没写就问它后端的 /api/wallet-info（容器的 WALLET_ADDRESS）。核对不了的钱包不提交。
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { RPC_URL, LIVE_TRADE, dataFile, env, WALLET_SLOT, WALLET_PEERS, EXPECT_WALLET } from './config.js';
import { runBaw } from './baw.js';

export const FAIR_PAD = '0x15cfd2dc8278fb87a1783ef42111618e20874365';
export const FAIR_ROUTER = '0xe040445690aa56c8b68b7f7038c7b2562b5079c4';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const API = 'https://gang.fun/api';
// 其他钱包的 baw 命令：WALLET_PEERS 里的 bawCmd（如 "docker exec bsc-agent-wallet2 baw"），或 FAIR_BAW_CMD_<slot>，或从 signin（"docker exec -it 容器 baw auth signin"）推出来
const peerCmd = (p) => {
  const c = p.bawCmd || env(`FAIR_BAW_CMD_${p.slot}`, '') || (/^docker exec (?:-\w+ )*([\w.-]+) baw\b/.exec(String(p.signin || '')) ? `docker exec ${RegExp.$1} baw` : '');
  return c ? String(c).split(/\s+/).filter(Boolean) : null;
};
const expects = new Map();
async function peerExpect(p) {
  const v = p.address || env(`EXPECT_WALLET_${p.slot}`, '') || expects.get(p.slot);
  if (v) return String(v).toLowerCase();
  const r = await fetch(String(p.url || '').replace(/\/$/, '') + '/api/wallet-info', { headers: { 'x-bsc-agent-token': p.token || env('BSC_AGENT_API_TOKEN', '') }, signal: AbortSignal.timeout(3000) }).then((x) => x.json()).catch(() => null);
  const a = String(r?.expect || '').toLowerCase();
  if (ethers.isAddress(a)) expects.set(p.slot, a);
  return ethers.isAddress(a) ? a : '';
}
export async function fairWallets() {
  return [{ slot: WALLET_SLOT, expect: EXPECT_WALLET, cmd: null },
    ...(await Promise.all(WALLET_PEERS.map(async (p) => ({ slot: p.slot, expect: await peerExpect(p), cmd: peerCmd(p) }))))];
}
const I = new ethers.Interface([
  'function sales(address token) view returns (address creator, uint64 progressAt, uint16 capShares, uint16 holdBps, address quote, uint16 sold, bool launched, uint16 mintFeeBps, uint16 exitFeeBps, address gate, uint128 sharePrice, address pair, address refPool, uint16 markSold)',
  'function status(address token) view returns (uint8)',
  'function positions(address token, address user) view returns (uint16)',
  'function fairMintBNB(address token, uint256 shares, uint256 minShares, uint256 deadline) payable returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)', 'function symbol() view returns (string)',
  'event Minted(address indexed token, address indexed user, uint256 shares, uint256 cost, uint256 fee, uint256 userShares, uint256 sold)',
  'error NotMinting()', 'error WalletCapReached()', 'error NotAgent()', 'error Slippage()', 'error BadAmount()', 'error ZeroAmount()', 'error UnknownToken()',
  'error NotEnoughValue()', 'error NotWbnbQuote()', 'error Expired()',
]);
const ERR_ZH = { NotMinting: '盘子已经打满 / 不在打新中', WalletCapReached: '这个钱包已经打到上限', NotAgent: '这个钱包没有 Agent ID', Slippage: '剩余份数不够', NotEnoughValue: 'BNB 不够', UnknownToken: '不是打新盘' };
let provider;
const prov = () => (provider ||= new ethers.JsonRpcProvider(RPC_URL, 56, { staticNetwork: true }));
const read = (to, fn, args = []) => prov().call({ to, data: I.encodeFunctionData(fn, args) }).then((r) => I.decodeFunctionResult(fn, r));
const revertName = (e) => { const d = e?.data || e?.info?.error?.data; if (!d) return null; try { const n = I.parseError(d)?.name; return n ? (ERR_ZH[n] ? `${ERR_ZH[n]}（${n}）` : n) : null; } catch { return null; } };

// 可疑标记：测试名 My Token / MYT，或借用平台币 GANG 的名字
export function fairFlags({ name = '', symbol = '' }) {
  const n = String(name).trim(), s = String(symbol).trim(), out = [];
  if (/^my\s*token$/i.test(n) || /^myt$/i.test(s)) out.push('测试名 My Token / MYT');
  if (/^\$?gang$/i.test(n) || /^\$?gang$/i.test(s)) out.push('借用 GANG 名字（不是平台币）');
  return out;
}

export async function fairList(status = 'minting') {
  const r = await fetch(`${API}/fair/sales?status=${encodeURIComponent(status)}&limit=50`, { signal: AbortSignal.timeout(10_000) }).then((x) => { if (!x.ok) throw new Error(`gang.fun ${x.status}`); return x.json(); });
  return (r.items || []).map((x) => ({
    token: x.address, name: x.name, symbol: x.symbol, creator: x.creator, creatorHandle: x.creatorHandle || null, quote: x.quoteSymbol, logo: x.hasLogo ? x.logoUrl : null,
    raiseBnb: Number(ethers.formatEther(x.raiseBnb || '0')), progressPct: x.progressPct, sold: x.sold, sharesLeft: x.sharesLeft, minWalletsLeft: x.minWalletsLeft,
    participants: x.participants, capShares: x.capShares, sharePrice: Number(ethers.formatEther(x.sharePrice || '0')), mintFeeBps: x.mintFeeBps,
    createdAt: x.createdAt, lastMintAt: x.lastMintAt, status: x.status, flags: fairFlags(x),
  }));
}

export async function fairSale(token) {
  const s = await read(FAIR_PAD, 'sales', [token]);
  if (s.creator === ethers.ZeroAddress) return null;
  const st = Number((await read(FAIR_PAD, 'status', [token]))[0]);
  return { token: ethers.getAddress(token), creator: s.creator, status: ['none', 'minting', 'launched'][st] || String(st), capShares: Number(s.capShares), sold: Number(s.sold),
    quote: s.quote.toLowerCase(), mintFeeBps: Number(s.mintFeeBps), gate: s.gate, sharePrice: s.sharePrice, sharesLeft: 10_000 - Number(s.sold) };
}

function bawFor(w, args, timeoutMs) {
  if (!w.cmd) return runBaw(args, { timeoutMs }).then((j) => j.data ?? j);
  return new Promise((resolve, reject) => execFile(w.cmd[0], [...w.cmd.slice(1), '--json', ...args], { timeout: timeoutMs, maxBuffer: 8 << 20, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
    let j; try { j = JSON.parse(stdout); } catch { return reject(new Error(String(stderr || stdout || err?.message || '').trim().slice(0, 300) || 'baw 无输出')); }
    if (j.success === false) { const e = j.error || {}; return reject(new Error(`${e.name || e.code || 'baw_error'}: ${e.message || ''}`.trim())); }
    resolve(j.data ?? j);
  }));
}
const bscAddress = (w) => bawFor(w, ['wallet', 'address'], 20_000).then((d) => (d.addresses || []).find((a) => a.binanceChainId === '56')?.address || '');

// 一个钱包：核对地址 → 交易参数 → dry 时 eth_call 模拟，否则 baw contract-call preview + execute
async function mintOne(w, sale, shares, dry) {
  const t0 = Date.now(), steps = [], mark = (name) => steps.push({ name, ms: Date.now() - t0 });
  try {
    if (!ethers.isAddress(w.expect || '')) throw new Error('没配置这个钱包的预期地址（WALLET_ADDRESS / WALLET_PEERS 的 address），不提交');
    if (w.slot !== WALLET_SLOT && !w.cmd) throw new Error('没配置这个钱包的 baw 命令（WALLET_PEERS 的 bawCmd），不提交');
    const addr = await bscAddress(w); mark('核对地址');
    if (addr.toLowerCase() !== w.expect.toLowerCase()) throw new Error(`钱包地址不对：${addr || '未登录'}，预期 ${w.expect}`);
    const cost = sale.sharePrice * BigInt(shares), value = cost + (cost * BigInt(sale.mintFeeBps)) / 10_000n;
    const data = I.encodeFunctionData('fairMintBNB', [sale.token, BigInt(shares), 1n, BigInt(Math.floor(Date.now() / 1000) + 1800)]);
    if (dry || !LIVE_TRADE) {
      const got = await prov().call({ from: addr, to: FAIR_ROUTER, data, value }).then((r) => Number(I.decodeFunctionResult('fairMintBNB', r)[0]))
        .catch((e) => { throw new Error(`模拟回滚：${revertName(e) || e.shortMessage || e.message}`); });
      mark('eth_call 模拟');
      return { slot: w.slot, ok: true, dry: true, shares: got, valueBnb: ethers.formatEther(value), ms: Date.now() - t0, steps, note: LIVE_TRADE ? null : 'LIVE_TRADE 没开，只模拟' };
    }
    const pre = await bawFor(w, ['contract-call', 'preview', '--binanceChainId', '56', '--from', addr, '--to', FAIR_ROUTER, '--value', value.toString(), '--inputData', data], 45_000); mark('baw 预演');
    if (!pre.requestId) throw new Error('baw 预演没给 requestId（可能被风控拦截）');
    let ex;
    try { ex = await bawFor(w, ['contract-call', 'execute', '--requestId', String(pre.requestId)], 150_000); }
    catch (e) { if (/timeout|timed out|ETIMEDOUT|killed|SIGTERM|ECONNRESET|fetch failed|network/i.test(e.message)) throw new Error('已提交执行，但没等到结果（可能已经上链，先查钱包再重试）'); throw e; }
    mark('baw 执行');
    const pending = ex.status === 'PENDING_CONFIRMATION';
    return { slot: w.slot, ok: !!ex.txHash || ex.status === 'BROADCASTED', pending, status: ex.status, txHash: ex.txHash || null, shares, valueBnb: ethers.formatEther(value),
      ms: Date.now() - t0, steps, note: pending ? '需要在币安 App 里确认' : ex.message || null };
  } catch (e) {
    return { slot: w.slot, ok: false, error: e.message, ms: Date.now() - t0, steps };
  }
}

// 多钱包打新。slots 不填 = 所有钱包；shares 默认每地址上限
export async function fairJoin(token, { shares, slots = null, dry = false } = {}) {
  if (!ethers.isAddress(String(token || ''))) throw new Error('CA 不对');
  const t0 = Date.now();
  const sale = await fairSale(token);
  if (!sale) throw new Error('官方打新合约上查不到这个盘（不是 gang 打新盘）');
  if (sale.status !== 'minting') throw new Error(`这个盘已经${sale.status === 'launched' ? '打满开盘' : `是 ${sale.status} 状态`}，不能打新`);
  if (sale.quote !== WBNB) throw new Error('报价币不是 WBNB，暂不支持');
  const n = Math.max(1, Math.min(Math.floor(Number(shares)) || sale.capShares, sale.capShares));
  const ws = (await fairWallets()).filter((w) => !slots || slots.includes(w.slot));
  if (!ws.length) throw new Error('没有选中的钱包');
  const results = await Promise.all(ws.map((w) => mintOne(w, sale, n, dry)));
  const out = { token: sale.token, sold: sale.sold, sharesLeft: sale.sharesLeft, capShares: sale.capShares, shares: n, sharePrice: ethers.formatEther(sale.sharePrice), dry: dry || !LIVE_TRADE, ms: Date.now() - t0, results };
  try { appendFileSync(dataFile('gang-fair.jsonl'), JSON.stringify({ ts: Date.now(), ...out }) + '\n'); } catch { /* 记录失败不影响 */ }
  return out;
}

// 单个盘的链上状态 + 两个钱包已有份数、Agent ID、BNB
export async function fairInfo(token) {
  const sale = await fairSale(token);
  if (!sale) return null;
  const [name, symbol] = await Promise.all([read(token, 'name').then((r) => r[0]).catch(() => ''), read(token, 'symbol').then((r) => r[0]).catch(() => '')]);
  const wallets = await Promise.all((await fairWallets()).filter((w) => ethers.isAddress(w.expect || '')).map(async (w) => {
    const [held, bal, agent] = await Promise.all([read(FAIR_PAD, 'positions', [token, w.expect]).then((r) => Number(r[0])), prov().getBalance(w.expect),
      sale.gate === ethers.ZeroAddress ? null : read(sale.gate, 'balanceOf', [w.expect]).then((r) => Number(r[0])).catch(() => null)]);
    return { slot: w.slot, address: w.expect, held, bnb: Number(ethers.formatEther(bal)), agentId: agent };
  }));
  return { ...sale, name, symbol, flags: fairFlags({ name, symbol }), sharePrice: ethers.formatEther(sale.sharePrice), wallets };
}

// ---------- BSC Agent 快速买入 / 卖出（认购阶段）：本后端自己的钱包，走 baw.contractCall ----------
// 买：份数 = 金额 ÷ (单价 × (1 + 认购费))，夹到每地址剩余上限（上限 − 已持有）；router 只收实际成交部分，多余 BNB 退回
// 卖：认购阶段可以按打新价退出（pad.withdraw，扣撤出费，7 天没进展后免撤出费；认购费不退），收到的是 WBNB
const PAD_RW = new ethers.Interface([
  'function sales(address token) view returns (address creator, uint64 progressAt, uint16 capShares, uint16 holdBps, address quote, uint16 sold, bool launched, uint16 mintFeeBps, uint16 exitFeeBps, address gate, uint128 sharePrice, address pair, address refPool, uint16 markSold)',
  'function positions(address token, address user) view returns (uint16)',
  'function TOKENS_PER_SHARE() view returns (uint256)',
  'function previewWithdraw(address token, address user, uint256 shares) view returns (uint256 payout, uint256 fee)',
  'function withdraw(address token, uint256 shares, uint256 minPayout) returns (uint256)',
]);
const ZH = [[/WalletCapReached/i, '这个钱包已打满每地址上限'], [/NotAgent/i, '这个钱包没有 Agent ID，打新只限 Agent'], [/NotMinting/i, '已经打满开盘，认购结束（去外盘买）'],
  [/Slippage/i, '剩余份数不够（被别人先打了）'], [/NotEnoughValue/i, 'BNB 不够'], [/BadAmount/i, '卖出份数超过持有']];
const zh = (m) => { for (const [re, s] of ZH) if (re.test(m)) return s; return m; };
async function fairReads(provider, token, wallet) {
  const c = (fn, args = []) => provider.call({ to: FAIR_PAD, data: PAD_RW.encodeFunctionData(fn, args) }).then((r) => PAD_RW.decodeFunctionResult(fn, r));
  const [s, held, tps] = await Promise.all([c('sales', [token]), c('positions', [token, wallet]).then((r) => Number(r[0])), c('TOKENS_PER_SHARE').then((r) => r[0])]);
  if (s.creator === ethers.ZeroAddress) throw new Error('官方打新合约上查不到这个盘');
  if (s.launched) throw new Error('已经打满开盘，认购结束（去外盘买）');
  return { s, held, tps, c };
}
export async function fairBuy({ provider, contractCall, wallet, token, amountBnb, step = () => {} }) {
  const t0 = Date.now();
  const { s, held, tps } = await fairReads(provider, token, wallet);
  const cap = Number(s.capShares), left = Math.max(0, cap - held);
  if (s.quote.toLowerCase() !== WBNB) throw new Error('报价币不是 WBNB，暂不支持认购');
  if (!left) throw new Error(`这个钱包已打满上限（${cap} 份）`);
  const unit = BigInt(s.sharePrice) * BigInt(10_000 + Number(s.mintFeeBps)) / 10_000n;   // 每份含认购费
  const want = Math.floor(Number(ethers.parseEther(String(amountBnb))) / Number(unit) + 1e-6);
  if (want < 1) throw new Error(`金额不够 1 份（每份 ${ethers.formatEther(unit)} BNB）`);
  const shares = Math.min(want, left);
  const value = BigInt(s.sharePrice) * BigInt(shares) * BigInt(10_000 + Number(s.mintFeeBps)) / 10_000n;
  step(`打新认购 ${shares} 份（已持有 ${held}/${cap}，已售 ${s.sold}/10000）· ${ethers.formatEther(value)} BNB`, Date.now() - t0);
  const data = I.encodeFunctionData('fairMintBNB', [token, BigInt(shares), 1n, BigInt(Math.floor(Date.now() / 1000) + 1800)]);
  const t1 = Date.now();
  let r; try { r = await contractCall({ from: wallet, to: FAIR_ROUTER, valueWei: value.toString(), inputData: data }); } catch (e) { throw new Error(zh(e.message)); }
  step(`GangRouter.fairMintBNB${r.status === 'PENDING_CONFIRMATION' ? '（等币安 App 确认）' : ''}`, Date.now() - t1);
  if (!r.txHash && r.status !== 'BROADCASTED') throw new Error(r.status === 'PENDING_CONFIRMATION' ? '需要在币安 App 里确认这笔认购' : `认购没发出去：${r.message || r.status || '未知'}`);
  return { venue: 'Gang 打新认购（GangRouter.fairMintBNB）', expected: Number(ethers.formatEther(BigInt(shares) * tps)), txHash: r.txHash, hashes: [r.txHash].filter(Boolean),
    spent: Number(ethers.formatEther(value)), shares, note: `认购 ${shares} 份 · ${ethers.formatEther(value)} BNB${shares < want ? `（按剩余上限 ${left} 份，多余的 BNB 没花）` : ''}` };
}
export async function fairSell({ provider, contractCall, wallet, token, pct, step = () => {} }) {
  const t0 = Date.now();
  const { held, c } = await fairReads(provider, token, wallet);
  if (!held) throw new Error('这个钱包在这个打新盘里没有份额');
  const shares = Math.max(1, Math.min(held, Math.floor(held * Math.min(100, pct) / 100)));
  const [payout, fee] = await c('previewWithdraw', [token, wallet, BigInt(shares)]);
  const minPayout = payout * 999n / 1000n;   // 价格固定，只有撤出费可能变（别人先认购会重启 7 天计时）
  step(`打新退出 ${shares}/${held} 份 · 预计 ${ethers.formatEther(payout)} WBNB（撤出费 ${ethers.formatEther(fee)}）`, Date.now() - t0);
  const t1 = Date.now();
  let r; try { r = await contractCall({ from: wallet, to: FAIR_PAD, valueWei: '0', inputData: PAD_RW.encodeFunctionData('withdraw', [token, BigInt(shares), minPayout]) }); } catch (e) { throw new Error(zh(e.message)); }
  step('GangLaunchpad.withdraw', Date.now() - t1);
  if (!r.txHash && r.status !== 'BROADCASTED') throw new Error(r.status === 'PENDING_CONFIRMATION' ? '需要在币安 App 里确认这笔退出' : `退出没发出去：${r.message || r.status || '未知'}`);
  return { venue: 'Gang 打新退出（按打新价，收 WBNB）', expected: Number(ethers.formatEther(payout)), txHash: r.txHash, hashes: [r.txHash].filter(Boolean), note: `退出 ${shares} 份，收到 WBNB（不是 BNB）；认购费不退` };
}
// 「买 N%」：N% × 10000 份，夹到每地址上限，换成要带的 BNB（含认购费）
export const fairPctBnb = (f, pct) => { const shares = Math.min(f.capShares, Math.max(1, Math.round(Number(pct) * 100))); return { shares, bnb: Math.ceil(shares * f.sharePrice * (1 + f.mintFeeBps / 10_000) * 1e8) / 1e8 }; };
