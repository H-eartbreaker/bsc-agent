import dns from 'node:dns/promises';
import net from 'node:net';
// Local browser boundary. Loopback binding alone does not stop hostile websites.
const IMAGE_HOSTS = new Set([
  'flap.mypinata.cloud', 'ipfs.io', 'dweb.link', 'cloudflare-ipfs.com',
  'static.four.meme', 'four.meme', 'gang.fun', 'cdn.gang.fun',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isLocalRequest(req, port) {
  const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = String(req.headers.host || '').toLowerCase();
  if (!authorities.has(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  // Opening the homepage from a link is safe; cross-site API calls remain blocked.
  if (origin === undefined && req.method === 'GET' && String(req.url || '').split('?')[0] === '/'
    && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document') return true;
  return !site || site === 'same-origin' || site === 'none';
}

export function hasUnsafeKeys(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    for (const key of Object.keys(item)) {
      if (UNSAFE_KEYS.has(key)) return true;
      pending.push(item[key]);
    }
  }
  return false;
}

export function isAllowedImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443') && IMAGE_HOSTS.has(url.hostname);
  } catch { return false; }
}

export function localBoundary(port) {
  return (req, res, next) => {
    if (!isLocalRequest(req, port)) return res.status(403).json({ error: 'Only same-origin local access is allowed' });
    res.set({
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'JSON content type is required' });
    }
    next();
  };
}

export function rejectUnsafeBody(req, res, next) {
  if (hasUnsafeKeys(req.body)) return res.status(400).json({ error: 'Unsafe object key' });
  next();
}

// ---- 头像代理：允许任何公网 https 域名，但绝不碰内网 / 本机 / 云元数据地址 ----
export function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return isPrivateAddress(m[1]);
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;   // 不是合法 IP：当作不安全
}
export function isPublicImageUrl(value) {
  try {
    const url = new URL(value);
    const h = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && h.includes('.') && !net.isIP(h.replace(/^\[|\]$/g, '')) && h !== 'localhost' && !/\.(local|internal|localhost|lan|home|corp)$/.test(h) && String(value).length <= 2000;
  } catch { return false; }
}
// 给 https.request 的 lookup：解析出的任何一个地址是内网就整个拒绝（连接用的就是这里解析的地址，防 DNS 重绑定）
export function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }).then((list) => {
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) throw new Error('blocked address');
    if (options?.all) cb(null, list); else cb(null, list[0].address, list[0].family);
  }).catch((e) => cb(e));
}

// 发请求前先自己解析一次域名并检查：开了代理（Clash 等）时，Node 不会在本地解析目标域名，safeLookup 就没机会拦，所以这里补一道。
// Clash 的 fake-ip 模式会把域名解析成 198.18.0.0/15，这个段在代理下是正常的，放行；解析失败（国内常见）时有代理也放行，由代理去解析。
export async function assertPublicHost(hostname, viaProxy) {
  let list;
  try { list = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch (e) { if (viaProxy) return; throw e; }
  const bad = list.some((a) => isPrivateAddress(a.address) && !(viaProxy && /^198\.1[89]\./.test(a.address)));
  if (!list.length || bad) throw new Error('blocked address');
}
