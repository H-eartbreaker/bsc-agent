// 只给被墙的行情站 / 图片站走代理（Clash 等）。.env 里设 BSC_AGENT_PROXY=http://127.0.0.1:7897 才启用；没设就完全直连。
// 下单、RPC、WSS 都不经过这里，不会被代理拖慢。代理连不上时自动回退直连。
import https from 'node:https';
const PROXY_HOSTS = /(^|\.)(dexscreener\.com|geckoterminal\.com)$/i;
const agents = new Map();
export const proxyUrl = () => process.env.BSC_AGENT_PROXY || '';
export const needsProxy = (url) => { try { return !!proxyUrl() && PROXY_HOSTS.test(new URL(url).hostname); } catch { return false; } };
export function proxyAgentFor(url) {
  if (!needsProxy(url)) return undefined;
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
