// Local browser boundary. Loopback binding alone does not stop hostile websites.
const IMAGE_HOSTS = new Set([
  'flap.mypinata.cloud', 'ipfs.io', 'dweb.link', 'cloudflare-ipfs.com',
  'static.four.meme', 'four.meme', 'gang.fun',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isLocalRequest(req, port) {
  const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
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
