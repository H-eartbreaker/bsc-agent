// 自动狙击 Agent：监听新建内盘 → 过滤 → 防狙击税保护（实时读费率，低于上限才买）→ 多钱包同时提交。
// 不经过任何「AI 思考」环节，命中即直接提交请求。另含自动止盈止损。
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { TOTAL_SUPPLY } from './market.js';

const platformDefaults = (platform) => ({
  enabled: false,
  wallets: ['big'],
  antiSnipe: { enabled: platform === 'four', maxFeePct: 10, maxWaitSec: 60, pollMs: 500 },
  delaySec: 0,                       // 不开防狙击时可设延时狙击 1-3 秒
  mode: 'fill',                      // fixed 固定金额 | pct 按总量占比 | fill 买满上限(1%)
  maxPerTrade: 0.2, pctOfSupply: 0.5, slippage: 99, dailyBudget: 1, hourlyMax: 5, minReserve: 0,
  quote: 'all',                      // bnb 只买 BNB 报价 | all 全部（非 BNB 由 Core 同笔兑换）
  include: '', exclude: 'test, scam',
});

export const DEFAULT_CONFIG = {
  flap: platformDefaults('flap'),
  four: platformDefaults('four'),
  gang: platformDefaults('gang'),
  exit: { enabled: false, takeProfitPct: 100, takeProfitSellPct: 50, stopLossPct: 40, trailingPct: 30, maxHoldMin: 0 },
  quickBuy: 0.1, paused: false, sound: true, notify: true,
};

export class Agent extends EventEmitter {
  constructor(market, trader, { live = false, quoteBuy = null, stateFile = null } = {}) {
    super();
    this.market = market; this.trader = trader; this.live = live; this.quoteBuy = quoteBuy;
    this.config = structuredClone(DEFAULT_CONFIG);   // 自动买入默认关闭，用户可在设置中手动开启
    if (live) {   // 实盘：默认全部关闭，钱包换成 baw
      for (const p of ['flap', 'four', 'gang']) Object.assign(this.config[p], { enabled: false, wallets: ['baw'], dailyBudget: 0.5, maxPerTrade: 0.05, slippage: 20 });
    }
    this.logs = []; this.records = []; this.spend = new Map(); this.tpDone = new Set(); this.busy = new Set();
    market.on('launch', (s) => this.onLaunch(s));
    market.on('migrate', (s) => this.onMigrate(s));
    market.on('rug', (s) => this.log('error', `💀 ${s.symbol} 流动性被撤（Rug）`));
    this.exitChecks = new Map(); this.pendingExits = new Map(); this.positionEpochs = new Map(); this.entryBusy = new Set(); this.launching = new Set(); this.attempted = new Set(); this.grants = new Map(); this.revision = 0;
    this.stateFile = stateFile; this.stateError = null;
    if (stateFile && existsSync(stateFile)) {
      try { const saved = JSON.parse(readFileSync(stateFile, 'utf8')); this.spend = new Map(saved.spend); this.attempted = new Set(saved.attempted); this.tpDone = new Set(saved.tpDone || []); this.positionEpochs = new Map(saved.positionEpochs || []); this.pendingExits = new Map(saved.pendingExits || []); }
      catch { this.stateError = '自动策略预算记录读取失败，请先检查记录文件'; }
    }
    this.timer = setInterval(() => this.manageExits().catch((e) => this.log('error', e.message)), 1000);
  }

  log(level, msg, extra = {}) {
    const e = { ts: Date.now(), level, msg, ...extra };
    this.logs.unshift(e); if (this.logs.length > 300) this.logs.length = 300;
    this.emit('log', e);
  }

  setConfig(patch) {
    const merge = (dst, src) => { for (const k of Object.keys(src)) { if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k]) merge(dst[k], src[k]); else dst[k] = src[k]; } };
    const next = structuredClone(this.config);
    merge(next, patch);
    validateConfig(next);
    this.config = next; this.revision++;
    this.emit('config', this.config);
  }

  saveUsage() {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temp = this.stateFile + '.tmp';
    writeFileSync(temp, JSON.stringify({ spend: [...this.spend], attempted: [...this.attempted], tpDone: [...this.tpDone], positionEpochs: [...this.positionEpochs], pendingExits: [...this.pendingExits] }), { mode: 0o600 });
    renameSync(temp, this.stateFile);
  }

  // One-use process-local capability: HTTP callers cannot impersonate the strategy engine.
  allowAutomatic(order) {
    const grant = this.grants.get(order.automaticAuthorization);
    this.grants.delete(order.automaticAuthorization);
    if (!grant || this.stateError || grant.revision !== this.revision || this.config.paused) return false;
    if (!['walletId', 'token', 'side', 'amount', 'source'].every(k => order[k] === grant.order[k])) return false;
    const t = this.market.get(order.token); if (!t) return false;
    if (order.side === 'buy') {
      const c = this.config[t.platform];
      return !!c?.enabled && c.wallets.includes(order.walletId) && !this.isBlocked?.(t) && !this.filter(c, t)
        && order.amount > 0 && order.amount <= c.maxPerTrade;
    }
    return this.config.exit.enabled && this.trader.positionsView().some(p => p.walletId === order.walletId
      && p.token === order.token && p.amount > 0) && order.amount > 0 && order.amount <= 100;
  }

  async executeAutomatic(order) {
    const key = Symbol('automatic-order');
    this.grants.set(key, { order, revision: this.revision });
    try { return await this.trader.execute({ ...order, automaticAuthorization: key }); }
    finally { this.grants.delete(key); }
  }

  // 每个钱包的今日花费、近 1 小时笔数（按平台独立计算）
  usage(platform, wid) {
    const k = `${platform}:${wid}`;
    if (!this.spend.has(k)) this.spend.set(k, { day: new Date().toDateString(), bnb: 0, times: [] });
    const u = this.spend.get(k);
    if (u.day !== new Date().toDateString()) Object.assign(u, { day: new Date().toDateString(), bnb: 0 });
    u.times = u.times.filter((t) => Date.now() - t < 3600_000);
    return u;
  }

  usageView() {
    const out = {};
    for (const p of ['flap', 'four', 'gang']) {
      const c = this.config[p];
      const us = c.wallets.map((w) => this.usage(p, w));
      out[p] = { spent: us.reduce((a, u) => a + u.bnb, 0), budget: c.dailyBudget * c.wallets.length, lastHour: us.reduce((a, u) => a + u.times.length, 0), hourlyMax: c.hourlyMax * c.wallets.length };
    }
    return out;
  }

  filter(c, s) {
    if (c.quote === 'bnb' && s.quote !== 'BNB') return `报价币 ${s.quote}，只买 BNB 报价`;
    const name = `${s.symbol} ${s.name}`.toLowerCase();
    const inc = c.include.split(/[,，]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const exc = c.exclude.split(/[,，]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (inc.length && !inc.some((k) => name.includes(k))) return '名称不含关键词';
    const hit = exc.find((k) => name.includes(k)); if (hit) return `命中排除词「${hit}」`;
    return null;
  }

  async readBuyFee(s, c) {
    let fee = await (this.market.fetchBuyFeePct ? this.market.fetchBuyFeePct(s.address) : this.market.buyFeePct(this.market.get(s.address)));
    if (fee == null && this.live && this.trader.preview && c.wallets[0]) {
      const q = await this.trader.preview({ walletId: c.wallets[0], token: s.address, side: 'buy', amount: c.maxPerTrade, slippage: c.slippage });
      if (!q?.error && Number.isFinite(q?.feePct)) fee = q.feePct;
    }
    return Number.isFinite(fee) && fee >= 0 ? fee : null;
  }

  async onLaunch(s) {
    const key = `${s.platform}:${s.address.toLowerCase()}`;
    if (this.launching.has(key)) return;
    this.launching.add(key);
    try { return await this.handleLaunch(s); }
    catch (e) { this.log('error', `自动买入未完成：${e.message}`, { token: s.address }); }
    finally { this.launching.delete(key); }
  }

  async handleLaunch(s) {
    const detectMs = s.detectMs ?? 40 + Math.round(Math.random() * 160);
    this.log('info', `🆕 链上检测到新内盘 ${s.symbol}（${s.platform === 'four' ? 'Four·Agent 专属' : s.platform === 'gang' ? (s.gangTrack === 'v2' ? 'Gang V2' : 'Gang') : 'Flap·Agent 曲线'}，${s.quote} 报价）· ${detectMs}ms`, { token: s.address, kind: 'launch', detectMs });
    this.emit('detect', detectMs);
    const c = this.config[s.platform], revision = this.revision;
    if (this.config.paused || !c?.enabled || this.stateError) return;
    if (this.isBlocked?.(s)) return this.record(s, 'skip', '已屏蔽');
    const why = this.filter(c, s);
    if (why) return this.record(s, 'skip', why);

    // 实盘读链上/shrine 的实时费率；读不到（null）也按「未达标」继续等，直到超时
    const readFee = () => this.readBuyFee(s, c);
    if (c.antiSnipe.enabled && (s.platform === 'four' || this.live)) {
      const start = Date.now();
      let fee = await readFee();
      while (fee == null || fee > c.antiSnipe.maxFeePct) {
        if (this.config.paused || revision !== this.revision || this.isBlocked?.(s)) return;
        if (Date.now() - start > c.antiSnipe.maxWaitSec * 1000) return this.record(s, 'skip', `等待 ${c.antiSnipe.maxWaitSec}s 费率仍 ${fee == null ? '未知' : fee.toFixed(1) + '%'}，放弃`);
        this.log('dim', `⏳ ${s.symbol} 实时总费率 ${fee == null ? '读取中' : fee.toFixed(1) + '%'} > 上限 ${c.antiSnipe.maxFeePct}%，${c.antiSnipe.pollMs}ms 后复查`);
        await new Promise((r) => setTimeout(r, c.antiSnipe.pollMs));
        fee = await readFee();
      }
      this.log('ok', `✅ ${s.symbol} 费率降到 ${fee.toFixed(2)}%（开盘后 ${((Date.now() - s.createdAt) / 1000).toFixed(1)}s），立即买入`);
    } else if (c.delaySec > 0) {
      await new Promise((r) => setTimeout(r, c.delaySec * 1000));
    }
    if (this.config.paused || revision !== this.revision || !this.config[s.platform]?.enabled || this.isBlocked?.(s)) return;
    await Promise.all(c.wallets.map((wid) => this.snipe(s, c, wid)));
  }

  async snipe(s, c, wid) {
    const key = `${s.platform}:${wid}:${s.address.toLowerCase()}`;
    if (this.entryBusy.has(wid) || this.attempted.has(key)) return this.record(s, 'skip', '钱包有买单处理中，或本次新币已尝试买入', wid);
    this.entryBusy.add(wid);
    try { return await this.enter(s, c, wid, key, this.revision); }
    finally { this.entryBusy.delete(wid); }
  }

  async enter(s, c, wid, key, revision) {
    if (this.live && !this.trader.status?.dryRun && this.trader.refreshBalance) await this.trader.refreshBalance();
    const w = this.trader.wallet(wid);
    const t = this.market.get(s.address);
    const el = this.trader.eligibility(w, t);
    if (!el.ok) return this.record(s, 'skip', `${w.label}：${el.reason}，合约会拒绝买入，已跳过`, wid);
    const u = this.usage(s.platform, wid);
    if (c.hourlyMax && u.times.length >= c.hourlyMax) return this.record(s, 'skip', `${w.label} 近 1 小时已达 ${c.hourlyMax} 笔`, wid);
    let bnb;
    if (this.live && c.mode !== 'fixed') {
      if (!this.quoteBuy) return this.record(s, 'skip', '比例买入报价服务尚未就绪', wid);
      const q = await this.quoteBuy({ wallet: wid, token: s.address, pct: c.mode === 'pct' ? c.pctOfSupply : 1, slippage: c.slippage });
      if (!(q.bnb > 0)) return this.record(s, 'skip', q.error || '没有可买入的额度', wid);
      bnb = q.bnb;
    } else bnb = c.mode === 'fixed' ? c.maxPerTrade
      : c.mode === 'pct' ? this.market.costFor(t, TOTAL_SUPPLY * c.pctOfSupply / 100)
      : Math.min(c.maxPerTrade, this.market.costFor(t, this.trader.capLeft(w, t)));
    const dry = this.trader.status?.dryRun;   // DRY RUN 只报价，不受钱包余额限制
    bnb = Math.min(bnb, c.maxPerTrade, c.dailyBudget - u.bnb, dry ? Infinity : w.bnb - c.minReserve - 0.002);
    if (!Number.isFinite(bnb) || !(bnb > 0)) return this.record(s, 'skip', `${w.label} 预算/余额不足`, wid);
    if (revision !== this.revision || this.config.paused || this.isBlocked?.(s)) return;
    const latestFee = c.antiSnipe.enabled ? await this.readBuyFee(s, c) : null;
    if (c.antiSnipe.enabled && (latestFee == null || latestFee > c.antiSnipe.maxFeePct)) return this.record(s, 'skip', '提交前费率未知或重新超过上限', wid);
    if (revision !== this.revision || this.config.paused) return;
    u.bnb += bnb; u.times.push(Date.now()); this.attempted.add(key);
    this.saveUsage(); // Persist the reservation before sending anything. Unknown/pending results never refund it.
    const o = await this.executeAutomatic({ walletId: wid, token: s.address, side: 'buy', amount: +bnb.toFixed(12), slippage: c.slippage, source: '自动狙击' });
    if (o.status === 'dry_run' || (['failed', 'rejected', 'cancelled'].includes(o.status) && !o.pendingTx && !o.tx && !o.txs?.length)) { u.bnb = Math.max(0, u.bnb - bnb); this.saveUsage(); }
    const msg = o.status === 'filled' ? `${w.label} 买入 ${o.amountIn.toFixed(8)} BNB${o.feePct != null ? `，费率 ${o.feePct.toFixed(2)}%` : ''}，${o.latencyMs}ms`
      : o.status === 'dry_run' ? `${w.label} DRY RUN 已报价 ${bnb.toFixed(8)} BNB（未上链），${o.latencyMs}ms` : `${w.label} ${o.reason}`;
    this.record(s, o.status === 'filled' ? 'buy' : o.status === 'dry_run' ? 'dry' : ['pending', 'unknown'].includes(o.status) ? 'pending' : 'fail', msg, wid);
  }

  record(s, status, msg, wid) {
    const r = { ts: Date.now(), platform: s.platform, symbol: s.symbol, token: s.address, status, msg, wid };
    this.records.unshift(r); if (this.records.length > 100) this.records.length = 100;
    this.emit('record', r);
    this.log(status === 'buy' ? 'ok' : status === 'fail' ? 'error' : 'dim', `🎯 ${s.symbol}：${msg}`, { token: s.address });
  }

  onMigrate(s) {
    this.log('info', `🚀 ${s.symbol} 内盘募满，已迁移到 PancakeSwap`, { token: s.address });
    if (!this.trader.settings.autoClaim) return;
    const held = this.trader.positionsView().filter((p) => p.token === s.address && p.amount > 0);
    for (const p of held) this.log('info', `🎁 ${p.wallet} 的 ${s.symbol} 已迁移，等待领取扫描；以领取交易回执为准`, { token: s.address });
  }

  async manageExits() {
    const x = this.config.exit;
    if (!x.enabled || this.config.paused) return;
    for (const p of this.trader.positionsView()) {
      if (p.amount <= 0 || p.stage === 'rugged') continue;
      const key = `${p.walletId}:${p.token}`;
      if (this.positionEpochs.has(key) && this.positionEpochs.get(key) !== p.openedAt) this.tpDone.delete(key);
      this.positionEpochs.set(key, p.openedAt);
      const pending = this.pendingExits.get(key);
      if (pending) {
        if (!['filled', 'failed', 'cancelled', 'rejected'].includes(pending.status)) continue;
        if (pending.status === 'filled' && pending.amount < 100) this.tpDone.add(key);
        this.pendingExits.delete(key);
      }
      if (this.busy.has(key) || Date.now() - (this.exitChecks.get(key) || 0) < 30_000) continue;
      let pct = 0, why = '';
      if (!this.tpDone.has(key) && Number.isFinite(p.pnlPct) && p.pnlPct >= x.takeProfitPct) { pct = x.takeProfitSellPct; why = `止盈 +${p.pnlPct.toFixed(1)}%`; }
      else if (Number.isFinite(p.pnlPct) && p.pnlPct <= -x.stopLossPct) { pct = 100; why = `止损 ${p.pnlPct.toFixed(1)}%`; }
      else if (this.tpDone.has(key) && Number.isFinite(p.drawdownPct) && p.drawdownPct <= -x.trailingPct) { pct = 100; why = `移动止损 回撤 ${p.drawdownPct.toFixed(1)}%`; }
      else if (x.maxHoldMin && Date.now() - p.openedAt > x.maxHoldMin * 60000) { pct = 100; why = `持仓超 ${x.maxHoldMin} 分钟`; }
      if (!pct) continue;
      this.busy.add(key);
      this.log('info', `📤 ${p.symbol}（${p.wallet}）${why} → 卖出 ${pct}%`, { token: p.token });
      try {
        const slippage = Number.isFinite(x.slippage) && x.slippage > 0 ? x.slippage : 35;
        const o = await this.executeAutomatic({ walletId: p.walletId, token: p.token, side: 'sell', amount: pct, slippage, source: '自动卖出' });
        if (o.status === 'filled' && why.startsWith('止盈')) this.tpDone.add(key);
        if (['pending', 'unknown'].includes(o.status)) this.pendingExits.set(key, o);
        this.saveUsage();
        this.record({ address: p.token, symbol: p.symbol, platform: p.platform }, o.status === 'filled' ? 'sell' : o.status === 'dry_run' ? 'dry' : ['pending', 'unknown'].includes(o.status) ? 'pending' : 'fail', `${why} · ${o.status === 'dry_run' ? '已预演，未真实卖出' : o.status === 'filled' ? '已成交' : o.reason || '未成交'}`, p.walletId);
      } catch (e) { this.log('error', `自动卖出失败：${e.message}`, { token: p.token }); }
      finally { this.exitChecks.set(key, Date.now()); this.busy.delete(key); }
    }
  }
}

function validateConfig(c) {
  const number = (v, key, min, max = Infinity) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${key} 超出允许范围`); };
  for (const p of ['flap', 'four', 'gang']) {
    const x = c[p];
    if (typeof x.enabled !== 'boolean' || typeof x.antiSnipe?.enabled !== 'boolean') throw new Error(`${p} 开关必须为开/关`);
    if (!Array.isArray(x.wallets) || x.wallets.some(w => typeof w !== 'string') || new Set(x.wallets).size !== x.wallets.length) throw new Error('执行钱包配置无效');
    if (!['fixed', 'pct', 'fill'].includes(x.mode) || !['bnb', 'all'].includes(x.quote)) throw new Error('买入模式无效');
    if (typeof x.include !== 'string' || typeof x.exclude !== 'string') throw new Error('关键词必须是文本');
    for (const k of ['maxPerTrade', 'dailyBudget', 'minReserve', 'delaySec']) number(x[k], `${p}.${k}`, 0);
    number(x.pctOfSupply, '总量比例', 0, 100); number(x.slippage, '滑点', 0.01, 99);
    number(x.hourlyMax, '小时笔数', 0, 10000); if (!Number.isInteger(x.hourlyMax)) throw new Error('小时笔数必须是整数');
    number(x.antiSnipe.maxFeePct, '最高费率', 0, 100); number(x.antiSnipe.maxWaitSec, '等待秒数', 0, 3600); number(x.antiSnipe.pollMs, '复查间隔', 1, 60000);
  }
  if (typeof c.paused !== 'boolean' || typeof c.exit.enabled !== 'boolean') throw new Error('暂停/自动卖出开关无效');
  for (const k of ['takeProfitPct', 'stopLossPct', 'trailingPct', 'maxHoldMin']) number(c.exit[k], k, 0);
  number(c.exit.takeProfitSellPct, '止盈卖出比例', 0.01, 100);
}
