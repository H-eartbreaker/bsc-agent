// 授权策略（预先授权，默认开，可在页面关闭；风险见 README）：
// 需要授权时，授一个「较大的固定额度」而不是本次数量，后面的交易就不用再单独授权。不是无限额。
// - 报价币（BNCB / GANG / 币股…）授权给 Flap Portal / Gang V2 pad：约等于 2 × 单笔上限的 BNB 价值（0.5 BNB 上限 → 约 1 BNB）
// - 卖出 meme 代币授权给各平台合约：当前全部余额 × 1.01（向上取整）
// - 至少不小于本次需要的数量；设置里关掉「预先授权」就回到「只授权本次数量」
// - 每次授权记到 data/approvals.json，页面「授权管理」据此读链上额度、提供「撤销」（approve 0，只在本人点击时发送）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
const FILE = new URL('../../data/approvals.json', import.meta.url);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const ctx = { trader: null, market: null };
export function setApprovalCtx(c) { Object.assign(ctx, c); }
export const enabled = () => ctx.trader?.settings?.preApproveCap !== false;

let book = null;
const load = () => { if (!book) { try { book = JSON.parse(readFileSync(FILE, 'utf8')); } catch { book = {}; } } return book; };
const save = () => { try { mkdirSync(new URL('.', FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(book, null, 1)); } catch { /* ignore */ } };
export function recordApproval({ token, spender, symbol, amount, kind }) {
  const b = load(), k = token.toLowerCase(), s = spender.toLowerCase(); b[k] ||= {};
  b[k][s] = { symbol: symbol || b[k][s]?.symbol || '', amount: String(amount), kind, at: Date.now() }; save();
}
export function listApprovals() { return load(); }

const call = async (to, fn, args) => erc20.decodeFunctionResult(fn, await ctx.market.provider.call({ to, data: erc20.encodeFunctionData(fn, args) }))[0];

// 这次授权该授多少（原始整数单位）。kind = 'quote'（报价币，按 BNB 价值）或 'sell'（卖出的代币，按全部余额）
export async function capFor({ token, wallet, amount, kind }) {
  amount = BigInt(amount);
  if (!enabled()) return amount;
  try {
    if (kind === 'sell') {
      const bal = BigInt(await call(token, 'balanceOf', [wallet]));
      const cap = (bal * 101n + 99n) / 100n;
      return cap > amount ? cap : amount;
    }
    const maxBnb = Number(ctx.trader?.status?.maxTradeBnb) || 0.5;
    const t = token.toLowerCase(), qUsd = ctx.market?.qUsd?.[t], bnbUsd = ctx.market?.bnbUsd;
    const rate = t === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' ? 1 : (qUsd && bnbUsd ? qUsd / bnbUsd : 0);
    if (!rate) return amount;   // 拿不到汇率就只授权本次数量
    const dec = Number(await call(token, 'decimals', []).catch(() => 18n));
    const cap = ethers.parseUnits(((2 * maxBnb) / rate).toFixed(Math.min(dec, 8)), dec);
    return cap > amount ? cap : amount;
  } catch { return amount; }
}
export const capLabel = (kind) => (enabled() ? (kind === 'sell' ? '预先授权：全部余额' : '预先授权：约 2 倍单笔上限') : '本次数量');

// 较大额度的授权如果触发了币安 App 确认（风控认为异常），自动关闭「预先授权」，以后回到只授权本次数量，并提示
export async function sendApproval({ send, wallet, token, spender, amount, cap, label, symbol, kind, step }) {
  try { const h = await send({ wallet, to: token, inputData: new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [spender, cap]), label, step }); recordApproval({ token, spender, symbol, amount: cap, kind }); return h; }
  catch (e) {
    if (e.code === 'APP_CONFIRM' && cap > BigInt(amount) && ctx.trader) {
      ctx.trader.settings.preApproveCap = false; ctx.trader.saveSetting?.('preApproveCap', false); ctx.trader.emit?.('settings', ctx.trader.settings);
      e.message = `较大额度的授权触发了币安 App 确认，已自动关闭「预先授权」，以后改为只授权本次数量。这一笔请在 App 里处理（同意或拒绝）。${e.message}`;
    }
    throw e;
  }
}
