import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';

export function loadApiToken(file, configured = process.env.BSC_AGENT_API_TOKEN) {
  if (configured !== undefined && configured !== '') {
    if (configured.length < 32 || /\s/.test(configured)) throw new Error('BSC_AGENT_API_TOKEN 必须至少 32 位且不含空白');
    return configured;
  }
  mkdirSync(new URL('.', file), { recursive: true });
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (value.length < 32 || /\s/.test(value)) throw new Error('本地 API Token 文件无效');
    chmodSync(file, 0o600); return value;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const value = randomBytes(32).toString('hex');
  try { writeFileSync(file, value + '\n', { mode: 0o600, flag: 'wx' }); return value; }
  catch (e) { if (e.code === 'EEXIST') return loadApiToken(file, ''); throw e; }
}
export function tokenMatches(value, expected) {
  if (!expected || typeof value !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
// Host / Origin / Fetch Metadata 先由原有本机边界验证，令牌不能绕过恶意来源检查。
export function hasApiAccess(req, token, websocket = false) {
  if (req.headers.origin) return true;
  if (!websocket && ['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-site'] === 'same-origin') return true;
  return tokenMatches(req.headers['x-bsc-agent-token'], token);
}
export function apiAuth(token) {
  return (req, res, next) => {
    if (req.path.startsWith('/api/') && !hasApiAccess(req, token)) return res.status(403).json({ error: '缺少或无效的访问令牌（x-bsc-agent-token）' });
    next();
  };
}
