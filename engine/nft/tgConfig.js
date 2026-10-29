import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../live/config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const SESSION_FILE = join(ROOT, 'data', 'tg-session.txt');

export function tgProxy() {
  const ip = env('TG_PROXY_HOST', '');
  const port = Number(env('TG_PROXY_PORT', 0));
  return ip && port ? { ip, port, socksType: 5, timeout: 10 } : undefined;
}

export function apiCredentials() {
  const apiId = Number(env('TG_API_ID', ''));
  const apiHash = env('TG_API_HASH', '');
  if (!apiId || !apiHash) throw new Error('缺少 TG_API_ID / TG_API_HASH（在 .env 里设置，见 .env.example 的「NFT 雷达」）');
  return { apiId, apiHash };
}
