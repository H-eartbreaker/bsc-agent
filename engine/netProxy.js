// 只给被墙的行情站 / 图片站走代理（Clash、V2Ray 等）。.env 里设了 BSC_AGENT_PROXY 就用它；没设就自动找：先试直连，不通再读系统代理、试常见端口。
// 下单、RPC、WSS 都不经过这里，不会被代理拖慢。代理连不上时自动回退直连。
import https from 'node:https';
const PROXY_HOSTS = /(^|\.)(dexscreener\.com|geckoterminal\.com|four\.meme|pinata\.cloud|ipfs\.io|dweb\.link|w3s\.link|nftstorage\.link|gang\.fun|flap\.sh|githubusercontent\.com|okx\.com)$/i;
const agents = new Map();
export const proxyUrl = () => process.env.BSC_AGENT_PROXY || '';
export const needsProxy = (url) => { try { return !!proxyUrl() && PROXY_HOSTS.test(new URL(url).hostname); } catch { return false; } };
// force：NFT 元数据 / 图片托管在各种项目自己的域名上，名单里没有，设了代理就强制走代理
export function proxyAgentFor(url, force = false) {
  if (!(force ? !!proxyUrl() : needsProxy(url))) return undefined;
  const p = proxyUrl(); let a = agents.get(p);
  if (!a) { a = new https.Agent({ keepAlive: true, proxyEnv: { HTTPS_PROXY: p, https_proxy: p } }); agents.set(p, a); }
  return a;
}
function viaProxy(url, { signal, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: proxyAgentFor(url), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', ...headers }, signal: signal || AbortSignal.timeout(10_000) }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 5e6) { res.destroy(new Error('too big')); return; } chunks.push(c); });
      res.on('error', reject);
      res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => body, json: async () => JSON.parse(body) }); });
    });
    req.on('error', reject);
  });
}
// 和 fetch 用法一样（返回值有 ok / status / json() / text()）
export async function pfetch(url, opts = {}) {
  if (needsProxy(url)) { try { return await viaProxy(url, opts); } catch { /* 代理不通，回退直连 */ } }
  return fetch(url, opts);
}

// ---- 自动找代理（每个人的代理软件和端口都不一样，不用手填）----
import net from 'node:net';
import { execFile } from 'node:child_process';
const TEST_URL = 'https://api.dexscreener.com/latest/dex/search?q=bnb';
const COMMON_PORTS = [7897, 7890, 7891, 7899, 1087, 10809, 8889, 8888, 20171, 33210, 2080, 8118, 8080, 10887, 6152, 6153];
let state = { mode: 'unknown', url: '', at: 0, auto: false };
let running = null;
export const proxyState = () => ({ ...state });
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (e, out) => resolve(e ? '' : String(out))));
const portOpen = (host, port, ms = 400) => new Promise((resolve) => { const sock = net.connect({ host, port }); const done = (v) => { sock.destroy(); resolve(v); }; sock.setTimeout(ms, () => done(false)); sock.once('connect', () => done(true)); sock.once('error', () => done(false)); });
const clean = (u) => { u = String(u || '').trim(); if (!u) return ''; if (!/^https?:\/\//i.test(u)) { if (/^(socks|socks5|socks4)/i.test(u)) return ''; u = 'http://' + u; } return u.replace(/\/$/, ''); };
async function viaTest(proxy) {
  try { const old = process.env.BSC_AGENT_PROXY; process.env.BSC_AGENT_PROXY = proxy; try { const r = await viaProxy(TEST_URL, { signal: AbortSignal.timeout(6000) }); return r.ok; } finally { if (old === undefined) delete process.env.BSC_AGENT_PROXY; else process.env.BSC_AGENT_PROXY = old; } } catch { return false; }
}
async function candidates() {
  const c = [];
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) { const v = clean(process.env[k]); if (v) c.push(v); }
  if (process.platform === 'darwin') {
    const out = await run('scutil', ['--proxy']); const g = (k) => (out.match(new RegExp('\\b' + k + '\\s*:\\s*(\\S+)')) || [])[1];
    if (g('HTTPSEnable') === '1' && g('HTTPSProxy')) c.push(`http://${g('HTTPSProxy')}:${g('HTTPSPort') || 80}`);
    if (g('HTTPEnable') === '1' && g('HTTPProxy')) c.push(`http://${g('HTTPProxy')}:${g('HTTPPort') || 80}`);
  } else if (process.platform === 'win32') {
    const out = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer']); const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (m) { const v = m[1].includes('=') ? (m[1].match(/https?=([^;]+)/) || [])[1] : m[1]; if (v) c.push(clean(v)); }
  }
  for (const port of COMMON_PORTS) c.push(`http://127.0.0.1:${port}`);
  return [...new Set(c.filter(Boolean))];
}
// force=true：用户点了自检，重新找一遍（比如刚打开了代理软件）
export function autoProxy(force = false) {
  if (running) return running;
  if (!force && state.mode !== 'unknown' && Date.now() - state.at < 120_000) return Promise.resolve(state);
  running = (async () => {
    try {
      const explicit = clean(process.env.BSC_AGENT_PROXY);
      if (process.env.BSC_AGENT_PROXY && !state.auto) { state = { mode: explicit ? 'proxy' : 'direct', url: explicit, at: Date.now(), auto: false }; return state; }   // 手动填的优先；填 none / 空串 = 不用代理
      delete process.env.BSC_AGENT_PROXY;
      try { const r = await fetch(TEST_URL, { signal: AbortSignal.timeout(4500), headers: { accept: 'application/json' } }); if (r.ok) { state = { mode: 'direct', url: '', at: Date.now(), auto: true }; return state; } } catch { /* 直连不通，找代理 */ }
      for (const c of await candidates()) {
        const u = new URL(c); if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) || !(await portOpen(u.hostname, Number(u.port || 80)))) { if (/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) continue; }
        if (await viaTest(c)) { process.env.BSC_AGENT_PROXY = c; state = { mode: 'proxy', url: c, at: Date.now(), auto: true }; return state; }
      }
      state = { mode: 'none', url: '', at: Date.now(), auto: true }; return state;
    } finally { running = null; }
  })();
  return running;
}

// 手动填的代理：先真的试一下能不能通，通了才生效（页面「自检」里填的就是走这个）
export async function trySetProxy(raw) {
  const c = clean(raw); if (!c) return { ok: false, error: '地址格式不对，应该像 http://127.0.0.1:7890' };
  let u; try { u = new URL(c); } catch { return { ok: false, error: '地址格式不对，应该像 http://127.0.0.1:7890' }; }
  if (!(await viaTest(c))) return { ok: false, error: `用 ${u.host} 连不上行情站：确认代理软件已打开，端口号没填错` };
  process.env.BSC_AGENT_PROXY = c; state = { mode: 'proxy', url: c, at: Date.now(), auto: false }; return { ok: true, url: c };
}
