import { pfetch } from '../netProxy.js';
import { cache } from './cache.js';

// GeckoTerminal 免费接口约每分钟 30 次。所有请求排队、间隔 ≥2 秒；收到 429 后整体冷却（60 秒起，连续被限翻倍，最长 5 分钟），冷却期间不再发请求
const GAP_MS = 2000;
let until = 0, strikes = 0, last = 0, chain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const geckoCooldownMs = () => Math.max(0, until - Date.now());

// 返回 { j, ok } 或 { limited: true }（冷却中 / 刚被限流）；网络错误照常抛出
export function geckoJson(url, { ttl = 0, signal } = {}) {
  const run = chain.then(async () => {
    if (ttl) { const hit = await cache.getJson('http:' + url).catch(() => null); if (hit != null) return { j: hit, ok: true }; }
    if (Date.now() < until) return { limited: true };
    const wait = last + GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    if (Date.now() < until) return { limited: true };
    last = Date.now();
    const res = await pfetch(url, { headers: { accept: 'application/json' }, signal: signal || AbortSignal.timeout(10_000) });
    const j = await res.json().catch(() => null);
    if (res.status === 429 || j?.status?.error_code === 429) { strikes++; until = Date.now() + Math.min(300_000, 60_000 * 2 ** (strikes - 1)); return { limited: true }; }
    if (res.ok) { strikes = 0; if (ttl && j) await cache.setJson('http:' + url, j, ttl); }
    return { j, ok: res.ok };
  });
  chain = run.catch(() => {});
  return run;
}
