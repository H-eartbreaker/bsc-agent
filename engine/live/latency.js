// 下单耗时记录：每笔订单结束（成交/失败）追加一行 JSON 到 data/latency.jsonl，并提供统计
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
export const LAT_FILE = new URL('../../data/latency.jsonl', import.meta.url);
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
  if (/自动/.test(o.source || '')) return 'auto';
  return 'manual';
}
export function record(o, extra = {}) {
  if (!o || !['filled', 'failed'].includes(o.status)) return false;
  load();
  if (seen.has(o.id) || (o.tx && seen.has(o.tx))) return false;
  seen.add(o.id); if (o.tx) seen.add(o.tx);
  const row = { id: o.id, ts: o.ts, symbol: o.symbol, token: o.token, platform: o.platform || null, side: o.side, source: sourceOf(o), status: o.status,
    latencyMs: o.latencyMs ?? null, clickToServerMs: o.clientTs ? Math.max(0, o.ts - o.clientTs) : null, preMs: o.preMs ?? null, route: o.route || null, venue: o.venue || null,
    steps: (o.steps || []).map((s) => ({ name: normStep(s.name), ms: s.ms, at: s.at ?? null, raw: s.name })),
    rpc: extra.rpc || null, gasLevel: extra.gasLevel || null, amountIn: o.amountIn ?? o.amount ?? null, out: o.out ?? null, tx: o.tx || null, error: o.status === 'failed' ? (o.reason || null) : null };
  try { mkdirSync(new URL('../../data/', import.meta.url), { recursive: true }); appendFileSync(LAT_FILE, JSON.stringify(row) + '\n'); } catch {}
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
