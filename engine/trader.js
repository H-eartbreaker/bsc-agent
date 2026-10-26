// 执行层（模拟盘）。核心思路照推文：交易本质就是一个链上请求，慢都慢在提交前的流程。
// 所以这里 tx 模板预先构建好、nonce 本地缓存，下单只做「填参数 → 签名 → 多 RPC 同时广播 → 等出块」。
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { TOTAL_SUPPLY } from './market.js';

const GAS = { buy: 210_000, sell: 230_000, approve: 46_000 };
export const GAS_PRESETS = { normal: 0.1, high: 1, turbo: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

export class SimTrader extends EventEmitter {
  constructor(market) {
    super();
    this.market = market;
    // 只有一个钱包（和币安 Agentic Wallet 一样）
    this.wallets = [
      { id: 'big', label: '我的钱包', color: 'linear-gradient(135deg,#f0b90b,#3fb950)', address: '0x9EFE' + randomBytes(16).toString('hex') + '49AC', bnb: 3.4485, agentId: true, whitelisted: true, nonce: 412 },
    ];
    this.positions = new Map();
    this.orders = [];
    this.settings = { gas: 'high', execPath: 'direct', multiRpc: true, autoClaim: true };
  }

  wallet(id) { const w = this.wallets.find((x) => x.id === id); if (!w) throw new Error(`未知钱包 ${id}`); return w; }

  pos(wid, token) {
    const k = `${wid}:${token}`;
    if (!this.positions.has(k)) this.positions.set(k, { walletId: wid, token, amount: 0, costBnb: 0, boughtBnb: 0, soldBnb: 0, peak: 0, openedAt: 0 });
    return this.positions.get(k);
  }

  // 交易资格检查（对应合约里的白名单 / 每钱包上限）
  eligibility(w, t) {
    if (t.platform !== 'four') return { ok: true };
    if (t.officialTest) return { ok: false, reason: '未在白名单（仅官方测试地址可买）' };
    if (!w.agentId) return { ok: false, reason: '钱包未绑定 Binance Agent ID' };
    if (!w.whitelisted) return { ok: false, reason: '未在白名单' };
    return { ok: true };
  }

  capLeft(w, t) {   // Agent 专属内盘每钱包最多买总量 1%
    if (t.platform !== 'four' || t.stage !== 'curve') return Infinity;
    return Math.max(0, TOTAL_SUPPLY * 0.01 - (t.holders.get(`user:${w.id}`) || 0));
  }

  route(t, side) {
    const venue = t.stage === 'curve' ? `${t.platform === 'four' ? 'Four' : 'Flap'} 内盘` : 'PancakeSwap V2';
    const fn = t.stage !== 'curve' ? (side === 'buy' ? 'swapExactETHForTokens' : 'swapExactTokensForETH')
      : side === 'buy' ? 'Core.buyByBudget' : 'Core.sellToken';
    return `${venue} · ${t.quote === 'BNB' ? 'BNB' : `BNB→${t.quote}`} ${side === 'buy' ? '买入' : '卖出'}（${fn}）`;
  }

  preview({ walletId, token, side, amount, slippage }) {
    const t = this.market.get(token); if (!t) return null;
    const w = this.wallet(walletId);
    const p = this.pos(walletId, token);
    const amountIn = side === 'buy' ? Number(amount) : p.amount * Number(amount) / 100;
    if (!(amountIn > 0)) return { route: this.route(t, side) };
    let out = this.market.quote(t, side, amountIn);
    if (side === 'buy') out = Math.min(out, this.capLeft(w, t));
    const feePct = side === 'buy' ? this.market.buyFeePct(t) : this.market.sellFeePct(t);
    return { route: this.route(t, side), amountIn, out, minOut: out * (1 - slippage / 100), feePct, feeBnb: side === 'buy' ? amountIn * feePct / 100 : out * feePct / (100 - feePct) };
  }

  // side=buy: amount = BNB；side=sell: amount = 持仓百分比
  async execute({ walletId, token, side, amount, slippage = 35, source = '手动', gas, maxFeePct }) {
    const t = this.market.get(token); if (!t) throw new Error('代币不存在');
    const w = this.wallet(walletId);
    const p = this.pos(walletId, token);
    const gwei = GAS_PRESETS[gas || this.settings.gas] ?? 1;
    const order = {
      id: randomBytes(5).toString('hex'), ts: Date.now(), walletId, wallet: w.label, token, symbol: t.symbol, platform: t.platform,
      side, amount: Number(amount), slippage, source, route: this.route(t, side), status: 'pending', steps: [],
    };
    this.orders.unshift(order); if (this.orders.length > 300) this.orders.length = 300;
    this.emit('order', order);
    const step = (name, ms) => order.steps.push({ name, ms: Math.round(ms) });

    if (side === 'buy') {
      const el = this.eligibility(w, t);
      if (!el.ok) return this.fail(order, `合约拒绝：${el.reason}`);
    }
    // ① 传统 Agent 路径：AI 思考 → 询问 → 再执行（对照组）
    if (this.settings.execPath === 'ai') { const ms = rnd(2500, 6500); await sleep(ms); step('AI 思考/确认', ms); }

    // ② 直接提交路径
    const amountIn = side === 'buy' ? Number(amount) : p.amount * Math.min(100, Number(amount)) / 100;
    const gasBnb = (GAS[side] * gwei) / 1e9 + (side === 'sell' && !p.approved ? (GAS.approve * gwei) / 1e9 : 0);
    if (!(amountIn > 0)) return this.fail(order, side === 'buy' ? '金额无效' : '没有可卖出的持仓');
    if (w.bnb < (side === 'buy' ? amountIn : 0) + gasBnb) return this.fail(order, 'BNB 余额不足');
    if (side === 'buy' && maxFeePct != null && this.market.buyFeePct(t) > maxFeePct) return this.fail(order, `当前费率 ${this.market.buyFeePct(t).toFixed(1)}% 高于上限`);
    if (side === 'buy' && this.capLeft(w, t) <= 1) return this.fail(order, '已达每钱包上限（总量 1%）');

    const expected = side === 'buy' ? Math.min(this.market.quote(t, side, amountIn), this.capLeft(w, t)) : this.market.quote(t, side, amountIn);
    const minOut = expected * (1 - slippage / 100);
    let ms = rnd(1, 4); step('填充预构建 tx', ms);
    ms = rnd(1, 3); step(`签名 nonce=${w.nonce}`, ms);
    w.nonce++;
    ms = this.settings.multiRpc ? rnd(25, 70) : rnd(60, 220); await sleep(ms); step(this.settings.multiRpc ? '广播 48Club+GetBlock+PublicNode' : '广播 PublicNode', ms);
    // 等出块：BSC 0.75s，gas 低的有概率排到下一个块
    ms = rnd(80, 750) + (gwei < 0.5 && Math.random() < 0.4 ? 750 : 0); await sleep(ms); step(`打包进块 #${this.market.block}`, ms);

    w.bnb -= gasBnb; order.gasBnb = gasBnb;
    if (side === 'sell') p.approved = true;
    if (t.dead) return this.fail(order, '执行回滚：流动性已撤（疑似 Rug）');
    let actualIn = amountIn;
    if (side === 'buy') {   // 买满上限：多余部分按比例退回
      const cap = this.capLeft(w, t);
      const q = this.market.quote(t, 'buy', amountIn);
      if (q > cap) actualIn = this.market.costFor(t, cap);
    }
    const actual = this.market.quote(t, side, actualIn);
    if (actual < minOut * (actualIn / amountIn)) return this.fail(order, `执行回滚：滑点超限（预期 ${fmt(expected)}，实际 ${fmt(actual)}）`);

    const { out, price, trade } = this.market.swap(t, side, actualIn, `user:${walletId}`);
    if (side === 'buy') {
      if (p.amount <= 0) p.openedAt = Date.now();
      w.bnb -= actualIn; p.amount += out; p.costBnb += actualIn; p.boughtBnb += actualIn; p.peak = Math.max(p.peak, price);
    } else {
      const part = p.amount ? p.costBnb * (actualIn / p.amount) : 0;
      w.bnb += out; p.costBnb -= part; p.soldBnb += out; p.amount -= actualIn;
      if (p.amount < 1) { p.amount = 0; p.costBnb = 0; p.peak = 0; }
    }
    Object.assign(order, { status: 'filled', amountIn: actualIn, out, price, feePct: side === 'buy' ? this.market.buyFeePct(t) : this.market.sellFeePct(t), tx: trade.tx, block: trade.block, latencyMs: Date.now() - order.ts });
    this.emit('order', order);
    return order;
  }

  fail(order, reason) {
    Object.assign(order, { status: 'failed', reason, latencyMs: Date.now() - order.ts });
    this.emit('order', order);
    return order;
  }

  positionsView() {
    const out = [];
    for (const p of this.positions.values()) {
      if (p.amount <= 0 && !p.boughtBnb) continue;
      const t = this.market.get(p.token); if (!t) continue;
      const price = this.market.price(t);
      const value = p.amount > 0 ? this.market.quote(t, 'sell', p.amount) : 0;
      if (p.amount > 0) p.peak = Math.max(p.peak, price);
      out.push({
        ...p, symbol: t.symbol, platform: t.platform, stage: t.dead ? 'rugged' : t.stage, price, valueBnb: value, valueUsd: value * this.market.bnbUsd,
        pnlBnb: value + p.soldBnb - p.boughtBnb, pnlPct: p.costBnb > 0 ? ((value - p.costBnb) / p.costBnb) * 100 : 0,
        drawdownPct: p.peak ? ((price - p.peak) / p.peak) * 100 : 0, wallet: this.wallet(p.walletId).label,
      });
    }
    return out.sort((a, b) => b.openedAt - a.openedAt);
  }

  walletsView() { return this.wallets.map(({ nonce, ...w }) => ({ ...w, nonce })); }
}

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(2) + 'K' : n.toFixed(6));
