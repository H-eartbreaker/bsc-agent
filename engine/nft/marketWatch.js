// 盯 NFT 市场价：只读。读 OKX NFT 市场公开页面（不用 key）里每个项目的地板价，涨过你设的线就记一条提醒。不碰钱包，不发交易。
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pfetch } from '../netProxy.js';

const PAGE = 'https://web3.okx.com/zh-hans/nft/collection';
const UA = 'Mozilla/5.0 (compatible; BSC-Agent)';
const BNB_SYMBOLS = new Set(['BNB', 'WBNB']);
const NONE_RETRY_MS = 6 * 3600_000;   // 查不到集合的项目，隔多久再问一次
const RISE_AGAIN = 1.5;               // 已提醒过的项目，地板价再涨 50% 才再提醒一次
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class MarketWatch {
  constructor({ file, chain = 'bsc', fetcher = pfetch, log = () => {}, now = () => Date.now(), gapMs = 700 }) {
    this.file = file; this.chain = chain; this.fetcher = fetcher; this.log = log; this.now = now; this.gapMs = gapMs;
    this.running = false; this.timer = null; this.pausedUntil = 0; this.lastError = '';
    this.state = { minFloor: 0.02, minVolume24h: 1, intervalMin: 15, checkedAt: 0, prices: {}, alerts: {} };
    try { const j = JSON.parse(readFileSync(file, 'utf8')); this.state = { ...this.state, ...j, prices: j.prices || {}, alerts: j.alerts || {} }; } catch { /* 第一次用 */ }
    delete this.state.alerts.test;   // 清掉旧版本留下的模拟提醒
  }

  save() {
    try { const tmp = this.file + '.tmp'; writeFileSync(tmp, JSON.stringify(this.state)); renameSync(tmp, this.file); } catch { /* 写不了不影响本次使用 */ }
  }

  setMinFloor(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error('提醒线必须是 0 到 1000 之间的数字（单位 BNB）');
    this.state.minFloor = n; this.save(); return n;
  }

  setMinVolume24h(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100000) throw new Error('成交量提醒线必须是 0 到 100000 之间的数字（单位 BNB，0 表示不提醒）');
    this.state.minVolume24h = n; this.save(); return n;
  }

  setIntervalMin(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 5 || n > 1440) throw new Error('检查间隔必须是 5 到 1440 分钟（太频繁会被 OKX 限制访问）');
    this.state.intervalMin = n; this.save(); this.reschedule(); return n;
  }

  ack(contract) {
    for (const [c, a] of Object.entries(this.state.alerts)) if (!contract || c === String(contract).toLowerCase()) a.seen = true;
    this.save();
  }

  pendingAlerts() {
    return Object.entries(this.state.alerts).filter(([, a]) => !a.seen).map(([contract, a]) => ({ contract, ...a }));
  }

  // 页面里内嵌了一段 JSON，按大括号配平把 collectionProjectStats 取出来；页面改版取不到时报错，不会乱给价格
  static parseStats(html) {
    const tag = '"collectionProjectStats":', i = html.indexOf(tag);
    if (i < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let k = i + tag.length; k < html.length; k++) {
      const c = html[k];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(i + tag.length, k + 1)); } catch { return null; } }
    }
    return null;
  }

  async page(contract) {
    const r = await this.fetcher(`${PAGE}/${this.chain}/${contract}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 404) return null;
    if (r.status === 403 || r.status === 429) throw Object.assign(new Error('OKX 暂时限制访问，稍后自动重试'), { backoff: true });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  // 返回 true 表示这个项目查询完成（不论有没有价格），false 表示这轮应该停下
  async check(contract) {
    const key = contract.toLowerCase(), old = this.state.prices[key] || {};
    if (old.status === 'none' && this.now() - old.at < NONE_RETRY_MS) return true;
    // OKX 页面偶尔会返回没带数据的版本，读不到就隔一会儿重试，最多 3 次
    let st = null;
    for (let n = 0; n < 3 && !st; n++) {
      const html = await this.page(key);
      if (html == null) { this.state.prices[key] = { status: 'none', at: this.now() }; return true; }
      st = MarketWatch.parseStats(html); this.lastHtml = html;
      if (!st && n < 2) await new Promise((r) => setTimeout(r, this.gapMs * 3));
    }
    if (!st) throw new Error('OKX 页面暂时没读到价格，下一轮自动重试');
    const html = this.lastHtml;
    const day = /"faqs":(\{[^{}]*\})/.exec(html); let faq = {}; try { faq = day ? JSON.parse(day[1]) : {}; } catch { /* 没有就算了 */ }
    const f = st.platformFloorPrice?.specifyFloorPrice?.floorPrice || {};
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    this.state.prices[key] = {
      status: 'ok', at: this.now(), floor: num(f.price), symbol: String(f.currency || '').toUpperCase() || null,
      volume: num(st.totalVolume?.price), volume24h: num(faq.volume), trades24h: num(faq.transactions), owners: num(st.numOwners), listed: num(st.totalListed),
    };
    this.raise(key);
    return true;
  }

  // 地板价和 24h 成交量各自判断：超过提醒线才算，已提醒过的要再涨 50% 才再提醒
  raise(key) {
    const p = this.state.prices[key];
    if (!p || p.status !== 'ok') return;
    const prev = this.state.alerts[key] || {}, isBnb = BNB_SYMBOLS.has(p.symbol);
    const floorHit = isBnb && p.floor > 0 && p.floor >= this.state.minFloor && !(prev.floorAt && p.floor < prev.floorAt * RISE_AGAIN);
    const mv = this.state.minVolume24h;
    const volHit = mv > 0 && p.volume24h != null && p.volume24h >= mv && !(prev.volAt && p.volume24h < prev.volAt * RISE_AGAIN);
    if (!floorHit && !volHit) return;
    this.state.alerts[key] = {
      reason: floorHit && volHit ? 'both' : floorHit ? 'floor' : 'volume', floor: p.floor, symbol: p.symbol, volume24h: p.volume24h, at: this.now(), seen: false,
      floorAt: floorHit ? p.floor : prev.floorAt, volAt: volHit ? p.volume24h : prev.volAt,
    };
  }

  // 重新判断全部已有价格是否越过（刚调低提醒线时用）
  reevaluate() { for (const k of Object.keys(this.state.prices)) this.raise(k); this.save(); }

  async refresh(contracts) {
    if (this.running || this.now() < this.pausedUntil) return { skipped: true };
    this.running = true; this.lastError = '';
    try {
      for (const c of [...new Set(contracts.filter((x) => ADDRESS.test(x)).map((x) => x.toLowerCase()))]) {
        try { await this.check(c); }
        catch (e) {
          this.lastError = e.message;
          if (e.backoff) { this.pausedUntil = this.now() + 5 * 60_000; break; }
          this.state.prices[c] = { ...(this.state.prices[c] || {}), status: this.state.prices[c]?.status === 'ok' ? 'ok' : 'error', err: e.message, at: this.state.prices[c]?.at || 0 };
        }
        await new Promise((r) => setTimeout(r, this.gapMs));
      }
      this.state.checkedAt = this.now();
    } finally { this.running = false; this.save(); }
    return { ok: true };
  }

  // 每轮结束后按当前设置的间隔排下一轮，改了间隔马上生效
  start(getContracts) {
    if (this.timer || this.started) return;
    this.started = true;
    this.tick = async () => { try { await this.refresh(await getContracts()); } catch (e) { this.log('[nft-market] ' + e.message); } this.schedule(); };
    this.schedule(8000);
  }

  schedule(ms = this.state.intervalMin * 60_000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.tick, ms); this.timer.unref?.();
  }

  reschedule() { if (this.started && !this.running) this.schedule(); }

  view() {
    return { minFloor: this.state.minFloor, minVolume24h: this.state.minVolume24h, intervalMin: this.state.intervalMin, checkedAt: this.state.checkedAt, running: this.running, error: this.lastError, paused: this.now() < this.pausedUntil };
  }

  priceOf(contract) {
    const p = this.state.prices[String(contract).toLowerCase()];
    const a = this.state.alerts[String(contract).toLowerCase()];
    return { status: p?.status || 'unknown', floor: p?.floor ?? null, symbol: p?.symbol || null, volume: p?.volume ?? null, volume24h: p?.volume24h ?? null, trades24h: p?.trades24h ?? null, owners: p?.owners ?? null, listed: p?.listed ?? null, at: p?.at || 0, err: p?.err, alert: a && !a.seen ? a : null };
  }
}
