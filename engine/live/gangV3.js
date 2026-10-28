// gang.fun V3（合并内盘 GangLaunchpad：V3 税收币曲线 + 打新，同一个合约地址，kindOf(token) 1 = V3 曲线、2 = 打新）。
// 依据：官方公开仓库 github.com/gangfun/gang-launchpad（2026-10-27 合并，src/gang/*、skill/gang-cli/src/v3.js），
// 并在 BSC 测试网第 8 套部署（pad 0x4f73…94e7）上核对过：事件 topic、curves() 12 个字段、kindOf。
// - 曲线公式和 V2 完全一样（虚拟代币储备、1% 手续费、毕业截断、单钱包 1%）；内盘不收税，买卖税只在毕业后的外盘收
// - curves() 比 V2 多两个字段：taxed 换成 buyTaxBps / sellTaxBps / dividendBps
// - Buy / Sell 事件 topic 和 V2 相同（字段顺序也一样，tax 恒为 0）；Created 是新 topic（V3 8 字段 / 打新 13 字段）
// 主网地址官方还没公布（CLI 里 MAINNET_GANG.pad = ''）：.env 填 GANG_V3_PAD，或者链上自动发现——
// 按新的 Created topic 订阅全链，发出事件的合约 owner / pendingOwner 是 gang 部署钱包或平台多签才认，认过的存 data/gang-v3-pads.json。
// 真实买卖默认开启；.env 设 GANG_V3_TRADE=0 可关闭（只报价）。打新币只显示，不交易。
import { readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { env, dataFile } from './config.js';

export const T_V3_CREATED = '0x416fe98c8f1ea2977674a1a4ee6252eb72597a8392fc2d7d0599a2bf5d8fdb63';     // Created(token, creator, name, symbol, logoURI, quote, refPair, gradAmt)
export const T_FAIR_CREATED = '0xd46f0c9c36ad8c7839cf830c7cb08aa3a24392965d09cf84e5c8d3bf098d6a4f';   // 打新 Created（13 字段）
export const V3_TRADE = env('GANG_V3_TRADE', '1') === '1';
// gang 的部署钱包和平台多签（仓库 config/GangDeployRefs.sol、MainnetAddresses.sol）
const OFFICIAL = new Set(['0x4eedcdf5fab775e10c0d09951b6f59ab81ba19d3', '0x2866369f7acefc9760bde7779362fae5cd68b41e']);
export const v3PadAbi = new ethers.Interface([
  'function curves(address) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)',
  'function kindOf(address token) view returns (uint8)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
]);

const FILE = dataFile('gang-v3-pads.json');
const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')).pads || []; } catch { return []; } };
// 当前认可的 V3 内盘（小写）。数组本身会被别的模块直接引用（订阅过滤器），只往里 push，不换对象
export const V3_PADS = [...new Set([...String(env('GANG_V3_PAD', '')).split(',').map((s) => s.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)), ...load()])];
export const isV3Pad = (a) => !!a && V3_PADS.includes(String(a).toLowerCase());
export const v3Events = new EventEmitter();   // 'pad' (address)：发现新的 V3 内盘

const checking = new Map();
// 链上看到 V3 Created 事件的合约：是不是 gang 官方的内盘（owner / pendingOwner 是部署钱包或多签，且认这个币）
export const v3Pending = () => Promise.all([...checking.values()]);
export function verifyV3Pad(provider, pad, token) {
  const a = String(pad).toLowerCase(); if (isV3Pad(a)) return Promise.resolve(true);
  if (checking.has(a)) return checking.get(a);
  const call = (fn, args = []) => provider.call({ to: pad, data: v3PadAbi.encodeFunctionData(fn, args) }).then((r) => v3PadAbi.decodeFunctionResult(fn, r)[0]).catch(() => null);
  const job = (async () => {
    const [owner, pending, kind] = await Promise.all([call('owner'), call('pendingOwner'), token ? call('kindOf', [token]) : 1n]);
    const ok = [owner, pending].some((x) => x && OFFICIAL.has(String(x).toLowerCase())) && (kind === 1n || kind === 2n);
    if (!ok) { console.log(`[Gang V3] ${a} 发出了 V3 创建事件，但 owner ${owner || '?'} 不是 gang 官方，忽略`); return false; }
    V3_PADS.push(a);
    try { writeFileSync(FILE, JSON.stringify({ pads: V3_PADS, updatedAt: new Date().toISOString() }, null, 1)); } catch { /* 写不了下次重新发现 */ }
    console.log(`[Gang V3] 发现主网 V3 内盘 ${a}（owner ${owner}）${V3_TRADE ? '' : '；真实买卖未开启（GANG_V3_TRADE=1 打开），只报价'}`);
    v3Events.emit('pad', a);
    return true;
  })().finally(() => checking.delete(a));
  checking.set(a, job); return job;
}

// V3 curves() → 和 V2 一样的字段（taxed = 有买卖税），多带 v3 税率信息
export function normCurve(c) {
  const buyTaxBps = Number(c.buyTaxBps), sellTaxBps = Number(c.sellTaxBps), dividendBps = Number(c.dividendBps);
  return { creator: c.creator, quote: c.quote, realQuote: c.realQuote, sold: c.sold, gradAmt: c.gradAmt, virtualQuote: c.virtualQuote, graduated: c.graduated,
    taxed: buyTaxBps > 0 || sellTaxBps > 0, pair: c.pair, refPair: c.refPair, v3: { buyTaxBps, sellTaxBps, dividendBps } };
}

export function assertV3Trade() {
  if (!V3_TRADE) throw Object.assign(new Error('Gang V3 真实买卖还没开启（主网合约未核对真实交易，只报价）。确认后在 .env 设 GANG_V3_TRADE=1 并重启'), { code: 'V3_DISABLED' });
}
