// gang.fun V2 盘（报价币盘：WBNB / GANG / NVDAB / BNCB / ZEC…）内盘买卖，支持 V2 0x1B8F…966E 以及同接口的 U / S 两个 pad：
//   buy(token, quoteIn, minTokensOut) / sell(token, tokensIn, minQuoteOut)，买卖都用报价币（ERC20），1% 平台费
// 依据：站上真实交易 0xa59ac6dd（buy）/ 0x6a272462（sell）解码；报价公式照官方 gang CLI 的 LaunchpadV2 曲线（_prepBuy / _quoteOut），
// 并用状态覆盖的 eth_call 核对过：帮派（U pad）、YAYA（V2）、GANGSTER（U pad）公式结果与合约返回完全一致。
// 买：BNB →（WBNB 盘用 deposit 包装，其他用 baw 市价单换）报价币 → 授权本次数量 → buy；卖：授权本次数量 → sell → 报价币换回 BNB。非原子，2～3 笔交易。
import { ethers } from 'ethers';
import * as baw from './baw.js';
import { capFor, capLabel, sendApproval } from './approvals.js';
import { BNB_NATIVE } from './config.js';

export const V2_PADS = ['0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb', '0x60aee38576035E757deD30fF8db8A8DA476430C1'];
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const pad = new ethers.Interface([
  'function buy(address token, uint256 quoteIn, uint256 minTokensOut) returns (uint256)',
  'function sell(address token, uint256 tokensIn, uint256 minQuoteOut) returns (uint256)',
  'function curves(address) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, bool taxed, address pair, address refPair)',
  'function walletRoom(address token, address buyer) view returns (uint256)',
]);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function deposit() payable', 'function withdraw(uint256)']);
const VT = 1066666666666666666666666667n, BPS = 10000n, FEE = 100n;   // LaunchpadV2 常量：虚拟代币储备、1% 平台费
const ceil = (a, b) => (b === 0n ? 0n : (a + b - 1n) / b);
const minOut = (v, slip) => (v * BigInt(10000 - Math.min(9900, Math.round(slip * 100)))) / 10000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWbnb = (a) => !a || a === ethers.ZeroAddress || a.toLowerCase() === WBNB.toLowerCase();

export class GangV2 {
  constructor(provider, send) { this.provider = provider; this.send = send; this.pads = new Map(); this.slots = new Map(); }

  async call(to, i, fn, args, from) { return i.decodeFunctionResult(fn, await this.provider.call({ to, from, data: i.encodeFunctionData(fn, args) })); }

  // 这个币在哪个 pad 上（creator ≠ 0 的那个），带曲线状态
  async curve(token) {
    const p = this.pads.get(token.toLowerCase());
    const tryPad = async (a) => { const c = await this.call(a, pad, 'curves', [token]).catch(() => null); return c && c.creator !== ethers.ZeroAddress ? c : null; };
    if (p) { const c = await tryPad(p); if (c) return { pad: p, c }; }
    for (const a of V2_PADS) { const c = await tryPad(a); if (c) { this.pads.set(token.toLowerCase(), a); return { pad: a, c }; } }
    throw new Error('不是 gang.fun V2 合约上的代币');
  }

  quoteToken(c) { return isWbnb(c.quote) ? WBNB : c.quote; }

  // 买入报价（和合约 _prepBuy 一样的算法）：quoteIn 报价币 → 能拿到多少代币；到 1% 上限 / 毕业门槛时只花一部分，其余退回
  buyQuote(c, quoteIn, room) {
    const vq = BigInt(c.virtualQuote), sold = BigInt(c.sold), raised = BigInt(c.realQuote), grad = BigInt(c.gradAmt);
    const k = vq * VT, qR = vq + raised, tR = VT - sold;
    const out = (net) => tR - ceil(k, qR + net), inFor = (tok) => ceil(k, tR - tok) - qR;
    const refee = (gross, net) => { let sg = ceil(net * BPS, BPS - FEE); if (sg > gross) sg = gross; const fee = (sg * FEE) / BPS; return { fee, net: sg - fee, refund: gross - sg }; };
    let fee = (quoteIn * FEE) / BPS, net = quoteIn - fee, refund = 0n;
    const left = grad > raised ? grad - raised : 0n;
    if (net > left) ({ fee, net, refund } = refee(quoteIn, left));
    let tokens = out(net);
    if (room != null && tokens > room) { tokens = room; ({ fee, net, refund } = refee(quoteIn, inFor(room))); }
    return { tokens, fee, refund, spent: quoteIn - refund };
  }

  sellQuote(c, tokensIn) {
    const vq = BigInt(c.virtualQuote), sold = BigInt(c.sold), raised = BigInt(c.realQuote);
    const k = vq * VT, out = vq + raised - ceil(k, VT - sold + tokensIn), fee = (out * FEE) / BPS;
    return { out: out - fee, fee };
  }

  async room(token, wallet) { const { pad: p } = await this.curve(token); return (await this.call(p, pad, 'walletRoom', [token, wallet]))[0]; }
  async balanceOf(token, wallet) { return (await this.call(token, erc20, 'balanceOf', [wallet]))[0]; }
  async decimals(token) { return Number((await this.call(token, erc20, 'decimals', []).catch(() => [18n]))[0]); }

  // BNB 金额 → 大约能换到多少报价币（WBNB 1:1，其他用 baw 报价）
  async bnbToQuote(q, amountBnb) {
    if (isWbnb(q)) return ethers.parseEther(String(amountBnb));
    const r = await baw.marketQuote({ fromTokenQty: String(amountBnb), fromToken: BNB_NATIVE, toToken: q });
    const dec = await this.decimals(q);
    return ethers.parseUnits(Number(r?.toCoinAmount || 0).toFixed(Math.min(12, dec)), dec);
  }

  async preview({ token, wallet, amountBnb }) {
    const { c } = await this.curve(token); const q = this.quoteToken(c);
    const quoteIn = await this.bnbToQuote(q, amountBnb);
    const r = this.buyQuote(c, quoteIn, await this.room(token, wallet).catch(() => null));
    return { quote: q, quoteIn, ...r, out: Number(ethers.formatEther(r.tokens)), feePct: 1 };
  }

  // 找报价币 balance / allowance 的存储槽，用来做「假装有余额和授权」的 eth_call 模拟（不用真的持有报价币）
  async findSlots(token, owner, spender) {
    const key = token.toLowerCase(); if (this.slots.has(key)) return this.slots.get(key);
    const enc = ethers.AbiCoder.defaultAbiCoder(), big = ethers.toBeHex(10n ** 30n, 32); let bal = null, alw = null;
    for (let s = 0; s < 30 && (bal == null || alw == null); s++) {
      const bk = ethers.keccak256(enc.encode(['address', 'uint256'], [owner, s]));
      const ak = ethers.keccak256(enc.encode(['address', 'bytes32'], [spender, ethers.keccak256(enc.encode(['address', 'uint256'], [owner, s]))]));
      const ov = (k) => ({ [token]: { stateDiff: { [k]: big } } });
      if (bal == null) { const r = await this.provider.send('eth_call', [{ to: token, data: erc20.encodeFunctionData('balanceOf', [owner]) }, 'latest', ov(bk)]).catch(() => null); if (r && BigInt(r) === 10n ** 30n) bal = s; }
      if (alw == null) { const r = await this.provider.send('eth_call', [{ to: token, data: erc20.encodeFunctionData('allowance', [owner, spender]) }, 'latest', ov(ak)]).catch(() => null); if (r && BigInt(r) === 10n ** 30n) alw = s; }
    }
    const v = bal != null && alw != null ? { bal, alw } : null; this.slots.set(key, v); return v;
  }

  // 用状态覆盖模拟买入：假设钱包已经有 quoteIn 的报价币并且已授权，返回合约实际给出的代币数
  async simulateBuy({ token, wallet, quoteIn, minTokens }) {
    const { pad: p, c } = await this.curve(token); const q = this.quoteToken(c);
    const sl = await this.findSlots(q, wallet, p); if (!sl) return { ok: null, note: '找不到报价币的存储槽，无法覆盖模拟' };
    const enc = ethers.AbiCoder.defaultAbiCoder();
    const bk = ethers.keccak256(enc.encode(['address', 'uint256'], [wallet, sl.bal]));
    const ak = ethers.keccak256(enc.encode(['address', 'bytes32'], [p, ethers.keccak256(enc.encode(['address', 'uint256'], [wallet, sl.alw]))]));
    const val = ethers.toBeHex(quoteIn * 2n, 32);
    try {
      const r = await this.provider.send('eth_call', [{ from: wallet, to: p, data: pad.encodeFunctionData('buy', [token, quoteIn, minTokens]) }, 'latest', { [q]: { stateDiff: { [bk]: val, [ak]: val } } }]);
      return { ok: true, tokens: pad.decodeFunctionResult('buy', r)[0] };
    } catch (e) { return { ok: false, error: e.info?.error?.message || e.shortMessage || e.message }; }
  }

  async ensureAllowance({ wallet, token, spender, amount, label, step, kind = 'quote', symbol = '' }) {
    if ((await this.call(token, erc20, 'allowance', [wallet, spender]))[0] >= amount) { step('授权额度够用，跳过授权', 0); return null; }
    const cap = await capFor({ token, wallet, amount, kind });
    const h = await sendApproval({ send: (o) => this.send(o), wallet, token, spender, amount, cap, label: `${label.replace(/（本次数量）/, '')}（${capLabel(kind)}）`, symbol, kind, step });
    for (let i = 0; i < 20; i++) { if ((await this.call(token, erc20, 'allowance', [wallet, spender]))[0] >= amount) break; await sleep(1000); }
    return h;
  }

  // 真实买入：先拿报价币（已有足够的就直接用）→ 授权 → 报价 + 模拟 → buy
  async buy({ wallet, token, amountBnb, slippage, step }) {
    const { pad: p, c } = await this.curve(token); const q = this.quoteToken(c); const hashes = [];
    const dec = await this.decimals(q); const qSym = isWbnb(q) ? 'WBNB' : '报价币';
    let need = await this.bnbToQuote(q, amountBnb);
    const have = await this.balanceOf(q, wallet);
    if (have < need) {
      const before = have; const t0 = Date.now();
      if (isWbnb(q)) hashes.push(await this.send({ wallet, to: WBNB, valueWei: ethers.parseEther(String(amountBnb)), inputData: erc20.encodeFunctionData('deposit', []), label: 'BNB→WBNB 包装', step }));
      else {
        const sw = await baw.marketSwap({ fromTokenQty: String(amountBnb), fromToken: BNB_NATIVE, toToken: q, slippage });
        if (!sw.orderId) throw new Error('BNB→报价币兑换没有返回 orderId');
        step(`BNB→报价币 已提交 ${sw.orderId}`, Date.now() - t0);
        const o = await baw.pollOrder(sw.orderId);
        if (o?.status !== 'FINISHED') throw new Error(`BNB→报价币兑换${o?.status === 'FAILED' ? '失败' : '未完成'}（订单 ${sw.orderId}），后续步骤没有执行`);
        if (o.txHash) hashes.push(o.txHash);
      }
      let got = 0n; for (let i = 0; i < 10; i++) { got = (await this.balanceOf(q, wallet)) - before; if (got > 0n) break; await sleep(1000); }
      if (got <= 0n) throw new Error('报价币没有到账，停止后续步骤');
      need = got; step(`收到 ${ethers.formatUnits(got, dec)} ${qSym}`, Date.now() - t0);
    } else step(`钱包里已有足够${qSym}，直接使用 ${ethers.formatUnits(need, dec)}`, 0);
    const ap = await this.ensureAllowance({ wallet, token: q, spender: p, amount: need, label: `授权${qSym}`, step, kind: 'quote', symbol: qSym }); if (ap) hashes.push(ap);
    const { c: c2 } = await this.curve(token);
    const r = this.buyQuote(c2, need, await this.room(token, wallet).catch(() => null));
    if (r.tokens <= 0n) throw new Error('报价为 0：可能已到每个钱包 1% 上限，或盘已毕业');
    const data = pad.encodeFunctionData('buy', [token, need, minOut(r.tokens, slippage)]);
    try { await this.provider.call({ from: wallet, to: p, data }); } catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}`); }
    hashes.push(await this.send({ wallet, to: p, inputData: data, label: 'Gang V2 buy', step }));
    return { venue: `Gang V2 · BNB→${qSym}→buy（非原子）`, expected: Number(ethers.formatEther(r.tokens)), txHash: hashes.at(-1), hashes };
  }

  // 真实卖出：授权代币（本次数量）→ sell → 收到的报价币换回 BNB（WBNB 直接解包）
  async sell({ wallet, token, pct, slippage, step, toBnb = true }) {
    const { pad: p, c } = await this.curve(token); const q = this.quoteToken(c); const hashes = [];
    const bal = await this.balanceOf(token, wallet); if (bal <= 0n) throw new Error('没有可卖出的余额');
    const amt = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
    const ap = await this.ensureAllowance({ wallet, token, spender: p, amount: amt, label: '授权卖出', step, kind: 'sell' }); if (ap) hashes.push(ap);
    const { c: c2 } = await this.curve(token); const r = this.sellQuote(c2, amt);
    const data = pad.encodeFunctionData('sell', [token, amt, minOut(r.out, slippage)]);
    try { await this.provider.call({ from: wallet, to: p, data }); } catch (e) { throw new Error(`链上模拟失败：${e.shortMessage || e.message}`); }
    const before = await this.balanceOf(q, wallet);
    hashes.push(await this.send({ wallet, to: p, inputData: data, label: 'Gang V2 sell', step }));
    let got = 0n; for (let i = 0; i < 10; i++) { got = (await this.balanceOf(q, wallet)) - before; if (got > 0n) break; await sleep(1000); }
    if (!toBnb || got <= 0n) return { venue: 'Gang V2 sell', expected: null, txHash: hashes.at(-1), hashes, note: got > 0n ? `已卖出得到报价币 ${ethers.formatUnits(got, 18)}（「卖出后自动换回 BNB」已关闭，留在钱包）` : '已卖出，没读到报价币到账' };
    if (isWbnb(q)) { hashes.push(await this.send({ wallet, to: WBNB, inputData: erc20.encodeFunctionData('withdraw', [got]), label: 'WBNB→BNB 解包', step })); return { venue: 'Gang V2 sell → BNB', expected: Number(ethers.formatEther(got)), txHash: hashes.at(-1), hashes }; }
    const dec = await this.decimals(q);
    // 兑换只提交一次；超时或返回不完整不代表失败，必须先查原订单。
    let o = null, sw = {}, conversionError = '';
    try {
      sw = await baw.marketSwap({ fromTokenQty: ethers.formatUnits(got, dec), fromToken: q, toToken: BNB_NATIVE, slippage });
      if (sw.orderId) o = await baw.pollOrder(sw.orderId);
    } catch (e) { conversionError = e.message; }
    if (o?.txHash) hashes.push(o.txHash);
    if (o?.status !== 'FINISHED') return {
      venue: 'Gang V2 sell', expected: null, txHash: hashes.at(-1), hashes,
      conversion: { status: o?.status || 'UNKNOWN', orderId: sw.orderId || null, error: conversionError || null },
      note: `内盘卖出已完成；换回 BNB ${o?.status === 'FAILED' ? '失败' : '结果尚未确认'}（订单 ${sw.orderId || '未返回'}）。已停止自动兑换，请先查订单和余额，勿重复提交。${conversionError ? ' ' + conversionError : ''}`,
    };
    return { venue: 'Gang V2 sell → 报价币 → BNB', expected: Number(o.toTokenActualQty || 0), txHash: hashes.at(-1), hashes };
  }
}
