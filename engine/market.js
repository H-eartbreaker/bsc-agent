// 模拟 BSC 内盘市场：Four·Agent 专属（Binance Agent ID Exclusive 预设）与 Flap·Agent 曲线两类 bonding curve。
// 参数按截图校准：总量 1B，内盘出售 800M，募集目标 ≈13.5 BNB，起始市值 ≈$3.2K。
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

export const TOTAL_SUPPLY = 1_000_000_000;
export const CURVE_SALE = 800_000_000;
const VIRTUAL_TOKENS = 1_073_000_000;
const VIRTUAL_BNB = 4.6;
const BASE_FEE = 0.01;               // 协议 0.5% + 创建者 0.5%（代币税另计）
const CANDLE_SEC = 1;
const MAX_TOKENS = 120;

// Four 防狙击费率曲线（截图里的实测参考：Test 币买 0.01 BNB）
export const SNIPE_FEE_CURVE = [[0, 50.3], [0.5, 33.8], [1, 20.6], [1.5, 13.8], [2, 9.9], [2.5, 5.7], [3, 1.96]];
export function snipeFeePct(ageSec) {
  const c = SNIPE_FEE_CURVE;
  if (ageSec >= c[c.length - 1][0]) return 0;
  for (let i = 1; i < c.length; i++) {
    if (ageSec < c[i][0]) {
      const [t0, f0] = c[i - 1], [t1, f1] = c[i];
      return Math.max(0, f0 + ((f1 - f0) * (ageSec - t0)) / (t1 - t0) - 1.96); // 扣掉常态部分，只算额外费率
    }
  }
  return 0;
}

const WORDS = ['AI', 'Agent', 'GPT', 'Bot', 'Claw', 'Neuro', 'Pepe', 'Doge', 'Mochi', 'Koi', 'Build', 'SAFU', 'Moon', 'Turbo', 'Giga', 'Brain', 'Cyber', 'Byte', 'Nova', 'Zen',
  '币安人生', '龙虾', '修仙', '牛市', '发财', '老子', '小熊', '财神', 'Panda', 'Tiger', 'Frog', 'Cat', 'Wojak', 'Chad', 'Based', 'Lucky', 'Fomo', 'Alpha', 'Sigma', 'Echo'];
const SUFFIX = ['', '', 'AI', 'Agent', '2.0', 'X', 'Pro', 'Inu', 'DAO', 'Labs', '.ai', 'GPT'];
const QUOTES = [['BNB', 0.82], ['USD1', 0.1], ['USDT', 0.05], ['CAKE', 0.03]];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pickW = (a) => { let r = Math.random(); for (const [v, w] of a) { if ((r -= w) <= 0) return v; } return a[0][0]; };
export const addr = () => '0x' + randomBytes(20).toString('hex');
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export class Market extends EventEmitter {
  constructor() {
    super();
    this.tokens = new Map();
    this.bnbUsd = 744.35;
    this.block = 129_622_835;
    this.flow = [];        // 全市场成交流
  }

  start() {
    // 推文里的 4 个官方测试币：白名单只有官方测试地址，普通钱包打不了
    ['Test', 'Test2', 'Test3', 'Test4'].forEach((s, i) => this.launch({
      symbol: s, platform: 'four', createdAt: Date.now() - (21 - i * 0.7) * 3600_000, preRaised: [0.051, 0.011, 0, 0.02][i],
      officialTest: true, buyTax: 1, sellTax: 5, quote: 'BNB', quiet: true,
    }));
    for (let i = 0; i < 30; i++) this.launch({ createdAt: Date.now() - Math.random() * 3600_000, preRaised: Math.random() < 0.15 ? 14 : Math.random() * 9, quiet: true });
    this.timers = [
      setInterval(() => this.launch(), 6000 + Math.random() * 3000),
      setInterval(() => this.tick(), 250),
      setInterval(() => { this.block++; this.emit('block', this.block); }, 750),   // BSC 0.75s 出块
      setInterval(() => { this.bnbUsd *= 1 + gauss() * 0.0003; }, 2000),
    ];
  }

  stop() { this.timers?.forEach(clearInterval); }

  launch(o = {}) {
    const platform = o.platform || (Math.random() < 0.6 ? 'four' : 'flap');
    const symbol = o.symbol || (pick(WORDS) + pick(SUFFIX)).slice(0, 14);
    const t = {
      address: addr(), symbol, name: o.symbol ? o.symbol : `${symbol}`, creator: addr(), vault: addr(), createdAt: o.createdAt || Date.now(),
      platform, preset: platform === 'four' ? 'Binance Agent ID Exclusive' : 'Agent Curve', presetId: '0x19dfab' + randomBytes(3).toString('hex'),
      quote: o.quote || pickW(QUOTES), officialTest: !!o.officialTest,
      bnbReserve: VIRTUAL_BNB, tokenReserve: VIRTUAL_TOKENS, raised: 0, sold: 0, stage: 'curve',
      target: 13.5 + (platform === 'four' ? 0.1 * Math.floor(Math.random() * 2) : 0),
      drift: gauss() * 0.5 + 0.05, vol: 0.3 + Math.random(), rugRisk: Math.random() < 0.12,
      buyTax: o.buyTax ?? (Math.random() < 0.7 ? 1 : pick([0, 3, 5, 10])), sellTax: o.sellTax ?? (Math.random() < 0.7 ? 1 : pick([1, 5, 10])),
      holders: new Map(), trades: [], candles: [], dead: false, buys: 0, sells: 0, volume: 0,
    };
    this.tokens.set(t.address, t);
    if (o.officialTest) this.seedHistory(t, o.preRaised);
    else if (o.preRaised) this.swap(t, 'buy', o.preRaised, addr(), { silent: true, ignoreFee: true });
    if (o.preRaised && !o.officialTest) t.buys = 2 + Math.floor(Math.random() * 40), t.sells = Math.floor(t.buys * Math.random() * 0.7);
    if (this.tokens.size > MAX_TOKENS) {
      const old = [...this.tokens.values()].filter((x) => !x.officialTest && !x.pinned).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (old) this.tokens.delete(old.address);
    }
    if (!o.quiet) this.emit('launch', this.summary(t));
    return t;
  }

  // 官方测试币：只有官方测试地址在白名单里零星成交，按真实节奏回填历史
  seedHistory(t, target) {
    const n = 6 + Math.floor(Math.random() * 8);
    const span = Date.now() - t.createdAt;
    const testers = [addr(), addr(), addr()];
    for (let i = 0; i < n; i++) {
      const at = t.createdAt + (span * (i + 1)) / (n + 1);
      const who = testers[i % 3];
      if (i > 2 && Math.random() < 0.35 && t.holders.get(who)) this.swap(t, 'sell', t.holders.get(who) * 0.5, who, { at });
      else this.swap(t, 'buy', Math.max(0.0001, (target || 0.01) / n * (0.5 + Math.random())), who, { at, ignoreFee: true });
    }
  }

  price(t) { return t.bnbReserve / t.tokenReserve; }
  age(t) { return (Date.now() - t.createdAt) / 1000; }

  // 当前买入总费率（%）：基础费 + 买税 + 防狙击额外费
  buyFeePct(t) { return BASE_FEE * 100 + t.buyTax + (t.platform === 'four' ? snipeFeePct(this.age(t)) : 0); }
  sellFeePct(t) { return BASE_FEE * 100 + t.sellTax; }

  quote(t, side, amountIn) {
    const fee = (side === 'buy' ? this.buyFeePct(t) : this.sellFeePct(t)) / 100;
    if (side === 'buy') { const x = amountIn * (1 - fee); return Math.min(t.tokenReserve - (VIRTUAL_TOKENS - CURVE_SALE), (t.tokenReserve * x) / (t.bnbReserve + x)); }
    return ((t.bnbReserve * amountIn) / (t.tokenReserve + amountIn)) * (1 - fee);
  }

  // 买到 n 个代币需要多少 BNB（含费）
  costFor(t, tokens) {
    const fee = this.buyFeePct(t) / 100;
    if (tokens >= t.tokenReserve) return Infinity;
    return ((t.bnbReserve * tokens) / (t.tokenReserve - tokens)) / (1 - fee);
  }

  swap(t, side, amountIn, trader, { silent = false, ignoreFee = false, at } = {}) {
    if (t.dead) throw new Error('流动性已撤（Rug）');
    let out;
    if (side === 'buy') {
      const x = amountIn * (1 - (ignoreFee ? 0 : this.buyFeePct(t) / 100));
      out = (t.tokenReserve * x) / (t.bnbReserve + x);
      t.bnbReserve += x; t.tokenReserve -= out; t.raised += x; t.sold += out;
      t.holders.set(trader, (t.holders.get(trader) || 0) + out);
    } else {
      const bal = t.holders.get(trader) ?? amountIn;
      const amt = Math.min(amountIn, bal);
      const gross = (t.bnbReserve * amt) / (t.tokenReserve + amt);
      out = gross * (1 - this.sellFeePct(t) / 100);
      t.tokenReserve += amt; t.bnbReserve -= gross; t.raised -= gross; t.sold -= amt;
      const left = bal - amt; left > 1 ? t.holders.set(trader, left) : t.holders.delete(trader);
      amountIn = amt;
    }
    const now = at || Date.now();
    const price = this.price(t);
    const bnb = side === 'buy' ? amountIn : out;
    const trade = {
      ts: now, side, bnb, tokens: side === 'buy' ? out : amountIn, price, mcapUsd: price * TOTAL_SUPPLY * this.bnbUsd,
      usd: bnb * this.bnbUsd, trader, tx: '0x' + randomBytes(32).toString('hex'), block: this.block,
    };
    if (!silent) {
      t.trades.unshift(trade); if (t.trades.length > 100) t.trades.length = 100;
      side === 'buy' ? t.buys++ : t.sells++;
      this.flow.unshift({ ...trade, address: t.address, symbol: t.symbol, platform: t.platform }); if (this.flow.length > 150) this.flow.length = 150;
    }
    t.volume += bnb;
    this.pushCandle(t, now, price, bnb);
    if (t.stage === 'curve' && t.raised >= t.target) { t.stage = 'dex'; t.migratedAt = now; if (!silent) this.emit('migrate', this.summary(t)); }
    if (!silent) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade });
    return { out, price, trade };
  }

  pushCandle(t, ts, price, vol) {
    const b = Math.floor(ts / 1000 / CANDLE_SEC) * CANDLE_SEC;
    const last = t.candles[t.candles.length - 1];
    if (last && last.t === b) { last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; last.v += vol; }
    else {
      const o = last ? last.c : price;
      t.candles.push({ t: b, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: vol });
      if (t.candles.length > 4000) t.candles.shift();
    }
  }

  tick() {
    for (const t of this.tokens.values()) {
      if (t.dead || t.officialTest) continue;
      const age = this.age(t);
      if (age < 0.4) continue;                         // 高费率期机器人也不敢买
      const activity = Math.min(0.85, 0.05 + 40 / (age + 40)) * (t.stage === 'dex' ? 0.5 : 1);
      if (Math.random() > activity) continue;
      if (t.rugRisk && age > 45 && Math.random() < 0.003) { this.rug(t); continue; }
      const bots = [...t.holders.keys()].filter((k) => !k.startsWith('user:') && k !== 'mev');
      const buyBias = 0.5 + Math.tanh(t.drift) * 0.14;
      if (Math.random() < buyBias || !bots.length) this.swap(t, 'buy', Math.abs(gauss()) * 0.08 * t.vol + 0.003, Math.random() < 0.3 && bots.length ? pick(bots) : addr());
      else { const b = pick(bots); this.swap(t, 'sell', t.holders.get(b) * (0.25 + Math.random() * 0.75), b); }
      if (Math.random() < 0.02) t.drift += gauss() * 0.15;
    }
  }

  rug(t) {
    t.bnbReserve *= 0.03; t.dead = true;
    this.pushCandle(t, Date.now(), this.price(t), 0);
    this.emit('rug', this.summary(t));
  }

  get(a) { return a ? this.tokens.get(a) : null; }

  summary(t) {
    const price = this.price(t);
    return {
      address: t.address, symbol: t.symbol, name: t.name, platform: t.platform, preset: t.preset, presetId: t.presetId, quote: t.quote,
      creator: t.creator, vault: t.vault, createdAt: t.createdAt, migratedAt: t.migratedAt, officialTest: t.officialTest,
      stage: t.dead ? 'rugged' : t.stage, price, priceUsd: price * this.bnbUsd, mcapUsd: price * TOTAL_SUPPLY * this.bnbUsd,
      raised: Math.max(0, t.raised), target: t.target, progress: Math.max(0, Math.min(100, (t.raised / t.target) * 100)),
      remaining: Math.max(0, CURVE_SALE - t.sold), holders: t.holders.size, buys: t.buys, sells: t.sells, volume: t.volume,
      buyTax: t.buyTax, sellTax: t.sellTax, buyFeePct: this.buyFeePct(t), lastTradeAt: t.trades[0]?.ts || 0,
    };
  }

  list() { return [...this.tokens.values()].map((t) => this.summary(t)); }

  detail(a) {
    const t = this.get(a); if (!t) return null;
    return { ...this.summary(t), candles: t.candles.slice(-1800), trades: t.trades.slice(0, 60) };
  }
}
