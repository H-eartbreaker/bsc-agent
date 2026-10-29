#!/usr/bin/env node
// 一次性：建好公开 Gist，把 Gist ID 和令牌写进本机 .env，把别人默认读取的地址写进 engine/nft/feedSync.js。
// 用法：node scripts/setup-feed-gist.mjs        （按提示粘贴令牌，输入不显示）
// 令牌：GitHub → Settings → Developer settings → Personal access tokens (classic)，只勾 gist。令牌只写进 .env，不会打印、不会进 Git。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const SYNC_FILE = path.join(ROOT, 'engine', 'nft', 'feedSync.js');
const FORCE = process.argv.includes('--force');
const API = 'https://api.github.com';
const die = (m) => { console.error('✗ ' + m); process.exit(1); };

function readEnv() { return fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''; }
const envGet = (txt, k) => (txt.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() || '';
function envSet(txt, k, v) {
  const line = `${k}=${v}`, re = new RegExp(`^${k}=.*$`, 'm');
  return re.test(txt) ? txt.replace(re, () => line) : txt + (txt && !txt.endsWith('\n') ? '\n' : '') + line + '\n';
}

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };   // 只显示提示，不回显输入
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const gh = (token, p, init = {}) => fetch(API + p, {
  ...init, signal: AbortSignal.timeout(20_000),
  headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'bsc-agent-setup', ...init.headers },
});

const env0 = readEnv();
if (envGet(env0, 'NFT_FEED_GIST_ID') && !FORCE) die(`.env 里已经有 NFT_FEED_GIST_ID（${envGet(env0, 'NFT_FEED_GIST_ID')}），不重复创建。要重建请加 --force。`);

const token = process.env.GIST_TOKEN || await askHidden('粘贴 GitHub 令牌（只勾了 gist 的经典令牌，输入不显示）：');
if (!token) die('没有输入令牌。');

let me;
try {
  const r = await gh(token, '/user');
  if (r.status === 401) die('令牌无效或已过期。');
  if (!r.ok) die('GitHub 返回 HTTP ' + r.status);
  me = await r.json();
  const scopes = (r.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!scopes.includes('gist')) die('这个令牌没有 gist 权限（细粒度令牌不支持 Gist，请用经典令牌并勾选 gist）。');
  if (scopes.some((s) => s !== 'gist')) die(`令牌权限太大（${scopes.join(', ')}）。请重建一个只勾 gist 的令牌，权限越小越安全。`);
} catch (e) { if (e?.name === 'TimeoutError' || e?.cause) die('连不上 GitHub（网络或代理）：' + (e.cause?.code || e.message)); throw e; }

const seed = JSON.stringify({ updatedAt: 0, items: [] });
const r = await gh(token, '/gists', { method: 'POST', body: JSON.stringify({ description: 'BSC Agent NFT feed (auto-updated)', public: true, files: { 'nft-feed.json': { content: seed } } }) });
if (!r.ok) die('创建 Gist 失败：HTTP ' + r.status);
const g = await r.json();
const rawUrl = `https://gist.githubusercontent.com/${me.login}/${g.id}/raw/nft-feed.json`;

let env1 = envSet(env0, 'NFT_FEED_GIST_TOKEN', token);
env1 = envSet(env1, 'NFT_FEED_GIST_ID', g.id);
fs.writeFileSync(ENV_FILE, env1, { mode: 0o600 });
fs.chmodSync(ENV_FILE, 0o600);   // 文件已存在时 mode 参数不生效，这里强制只有本人可读

const sync = fs.readFileSync(SYNC_FILE, 'utf8');
if (!/^export const DEFAULT_FEED_URL = '.*';/m.test(sync)) die('feedSync.js 里找不到 DEFAULT_FEED_URL，请手动填：' + rawUrl);
fs.writeFileSync(SYNC_FILE, sync.replace(/^export const DEFAULT_FEED_URL = '.*';/m, () => `export const DEFAULT_FEED_URL = '${rawUrl}';`));

console.log('✓ 公开 Gist 已创建：' + g.html_url);
console.log('✓ .env 已写入 NFT_FEED_GIST_ID 和令牌（令牌没有显示）');
console.log('✓ 别人默认读取的地址已写进 engine/nft/feedSync.js：' + rawUrl);
console.log('下一步：重启服务，监听就会开始往这个 Gist 发布。');
