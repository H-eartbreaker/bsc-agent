// 下单耗时记录：每笔订单结束（成交/失败）追加一行 JSON 到 data/latency.jsonl，并提供统计
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dataFile } from './config.js';
import { redactSecrets } from './rpc.js';
export const LAT_FILE = dataFile('latency.jsonl');
const seen = new Set();
let loaded = false;
function load() {
  if (loaded) return; loaded = true;
  for (const r of readAll()) { if (r.id) seen.add(r.id); if (r.tx) seen.add(r.tx); }
}
export function readAll() {
  if (!existsSync(LAT_FILE)) return [];
  return readFileSync(LAT_FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export function normStep(n = '') {
  const ap = /授权/.test(n);
  if (/查询余额|持有|检查 BNB 余额/.test(n)) return '查询余额';
  if (/已广播|已提交/.test(n)) return ap ? '授权广播' : '广播';
  if (/已上链|完成$|完成；/.test(n)) return ap ? '授权上链' : '上链';
  if (/报价|quote/i.test(n)) return '报价';
  if (/预演/.test(n)) return '预演';
  return n.split(/\s/)[0].slice(0, 16) || '其他';
}
export function sourceOf(o) {
  if (o.side === 'transfer') return 'transfer';
  if (o.side === 'approve' || o.via === 'preapprove') return 'preapprove';
  if (o.via === 'quick') return 'quick';
  if (/^跟单/.test(o.source || '')) return 'copy';
  if (/自动/.test(o.source || '')) return 'auto';
  return 'manual';
}
export function record(o, extra = {}) {
  if (!o || !['filled', 'failed'].includes(o.status)) return false;
  load();
  if (seen.has(o.id) || (o.tx && seen.has(o.tx))) return false;
  seen.add(o.id); if (o.tx) seen.add(o.tx);
  const row = { id: o.id, ts: o.ts, wallet: o.wallet || null, symbol: o.symbol, token: o.token, platform: o.platform || null, side: o.side, source: sourceOf(o), status: o.status,
    latencyMs: o.latencyMs ?? null, doneMs: o.doneMs ?? null, clickToServerMs: o.clientTs ? Math.max(0, o.ts - o.clientTs) : null, preMs: o.preMs ?? null, route: o.route || null, venue: o.venue || null,
    steps: (o.steps || []).map((s) => ({ name: normStep(s.name), ms: s.ms, at: s.at ?? null, raw: s.name })),
    rpc: extra.rpc || null, gasLevel: extra.gasLevel || null, amountIn: o.amountIn ?? o.amount ?? null, out: o.out ?? null, tx: o.tx || null, error: o.status === 'failed' ? (o.reason || null) : null };
  try { mkdirSync(dataFile(''), { recursive: true }); appendFileSync(LAT_FILE, redactSecrets(JSON.stringify(row)) + '\n'); } catch {}   // RPC 地址含 key：写盘前打码
  return true;
}
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
export function stats(days = 1) {
  const since = Date.now() - days * 86400_000;
  const rows = readAll().filter((r) => r.ts >= since);
  const groups = {};
  for (const r of rows) (groups[`${r.side}|${r.platform || '?'}`] ||= []).push(r);
  const out = Object.entries(groups).map(([k, rs]) => {
    const [side, platform] = k.split('|');
    const lat = rs.filter((r) => r.status === 'filled' && r.latencyMs != null).map((r) => r.latencyMs);
    const st = {};
    for (const r of rs) for (const s of r.steps || []) if (s.ms > 0) (st[s.name] ||= []).push(s.ms);
    return { side, platform, count: rs.length, failed: rs.filter((r) => r.status === 'failed').length,
      failRate: +(rs.filter((r) => r.status === 'failed').length / rs.length).toFixed(3),
      p50: pct(lat, 50), p90: pct(lat, 90), max: lat.length ? Math.max(...lat) : null,
      stepAvg: Object.fromEntries(Object.entries(st).map(([n, a]) => [n, Math.round(a.reduce((x, y) => x + y, 0) / a.length)])),
      slowest: [...rs].sort((a, b) => (b.latencyMs || 0) - (a.latencyMs || 0)).slice(0, 5).map((r) => ({ id: r.id, ts: r.ts, symbol: r.symbol, source: r.source, status: r.status, latencyMs: r.latencyMs, tx: r.tx, steps: r.steps.map((s) => `${s.name} ${s.ms}`).join(' → ') })) };
  });
  return { days, since, count: rows.length, groups: out };
}

// —— 「下单耗时」页面：每笔买卖从点击到上链，按时间线拆成几个阶段 ——
// 每一步记录了 at（距订单开始的毫秒），相邻两步的差就是这一段花的时间，归到这一步所属的阶段；老订单没有 at，只能用每步自己的 ms 估算（partial）
// net = 点击到后端开始下单（含「买 N%」报价、主后端转发给其他钱包）；wait = 交给后台等币安 App 确认 / 结果未知的那段
export const STAGES = ['net', 'pre', 'approve', 'quote', 'call', 'confirm', 'wait', 'other'];
export function routeKind(r) {
  const rt = r.route || '', p = r.platform;
  if (/market-order|DEX 聚合/.test(rt)) return 'baw 市价单';
  if (/Gang V3/.test(rt)) return 'Gang V3';
  if (/Gang V2/.test(rt) || (p === 'gang' && !rt)) return 'Gang V2 计价币路线';
  if (p === 'four') return 'Four';
  if (/swapExactInput|Agent ID/.test(rt)) return 'Flap Portal 直连';
  if (p === 'flap') return 'Flap 其他';
  if (p === 'quote' || p === 'swap') return '计价币换回 BNB';
  return p || '其他';
}
// multi：这笔是「BNB→计价币→买 / 卖→计价币→BNB」多笔交易的路线，计价币那几笔单独算「计价币兑换」
const MAIN_TX = /^(Gang V\d|Flap Portal|Portal\.|OpenFour)/;
export function stageOf(raw = '', multi = false) {
  if (/^转入后台等待：上链/.test(raw)) return 'confirm';
  if (/^转入后台等待/.test(raw)) return 'call';   // baw 调用返回「要在 App 里确认」/ 没等到结果
  if (/授权已生效/.test(raw)) return 'wait';   // 在币安 App 里确认授权花的时间
  if (/^收到|接着换回/.test(raw)) return multi ? 'quote' : 'other';
  const leg = multi && /→|包装|解包/.test(raw) && !MAIN_TX.test(raw);
  if (/已广播|已提交/.test(raw)) return /授权/.test(raw) ? 'approve' : leg ? 'quote' : 'call';
  if (/已上链|完成$|完成；/.test(raw)) return /授权/.test(raw) ? 'approve' : leg ? 'quote' : 'confirm';
  if (/跳过授权|查询|余额|持有|已有足够|直接使用|等前一笔|可领取|报价|预演|模拟|换差额/.test(raw)) return 'pre';
  if (/授权/.test(raw)) return 'approve';
  return 'other';
}
export function breakdown(r) {
  const multi = /Gang V\d|BNCB|buyWithQuote|非原子/.test(r.route || '');
  const st = Object.fromEntries(STAGES.map((k) => [k, 0]));
  let prev = 0, partial = false, first = null, waiting = false, mainTx = false;
  const steps = (r.steps || []).map((s) => {
    const name = s.raw || s.name || '';
    let stage = stageOf(name, multi);
    // 后台等待之后的那一段（到「收到报价币」或结束）算 wait；老订单没有「转入后台等待」这一步：卖出那笔没有广播记录就收到了报价币，也是在等 App 确认 / 结果
    if (waiting || (multi && /接着换回/.test(name) && !mainTx)) { stage = 'wait'; waiting = false; }
    if (/^转入后台等待/.test(name) && !/上链/.test(name)) waiting = true;
    if (MAIN_TX.test(name) && /已广播/.test(name)) mainTx = true;
    let d;
    if (s.at != null) { d = Math.max(0, s.at - prev); prev = Math.max(prev, s.at); } else { partial = true; d = Math.max(0, s.ms || 0); prev += d; }
    st[stage] += d; first ||= { stage, d };
    return { name: name.slice(0, 120), stage, ms: d, at: prev };
  });
  const end = Math.max(r.latencyMs || 0, prev, r.doneMs || 0);   // doneMs：转入后台等待的订单真正结束的时刻
  st[waiting ? 'wait' : 'other'] += end - prev;   // 最后一步之后到订单结束（读回执、记账；还在后台等待的话算 wait）
  const pre = Math.min(r.preMs || 0, first ? first.d : end - prev);   // 开头的下单前检查（钱包锁、在途）从第一段里分出来
  if (pre > 0) { st[first ? first.stage : 'other'] -= pre; st.pre += pre; }
  const net = r.clickToServerMs || 0; st.net = net;
  return { total: net + end, net, stages: st, steps, partial, appWait: st.wait > 0, noMain: !st.call && !st.wait };   // noMain：旧版本没记主交易那一步
}
export function ordersView(days = 7, wallet = null) {
  const since = Date.now() - days * 86400_000;
  return readAll().filter((r) => r.ts >= since && (r.side === 'buy' || r.side === 'sell')).map((r) => ({
    id: r.id, ts: r.ts, wallet: r.wallet || wallet, symbol: r.symbol, token: r.token, platform: r.platform, side: r.side, source: r.source, status: r.status,
    kind: routeKind(r), route: r.route, gasLevel: r.gasLevel, tx: r.tx, error: r.error ? String(r.error).slice(0, 200) : null, ...breakdown(r) }));
}
