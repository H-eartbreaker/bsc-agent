// 监听 Aibot打新提示群 的 NFT 推送，解析后写入 data/nft-feed.json（按合约地址去重）。
// 运行：node engine/nft/tgWatch.js
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { env } from '../live/config.js';
import { parseNftPost, autoEligible } from './parseFeed.js';
import { SESSION_FILE, apiCredentials, tgProxy } from './tgConfig.js';

const CHANNEL_ID = Number(env('TG_CHANNEL_ID', ''));
if (!CHANNEL_ID) { console.error('缺少 TG_CHANNEL_ID（要监听的 Telegram 频道 id，在 .env 里设置）'); process.exit(1); }
const FEED_FILE = join(dirname(SESSION_FILE), 'nft-feed.json');
const BACKFILL = Number(env('TG_BACKFILL', '30'));

function loadFeed() {
  if (!existsSync(FEED_FILE)) return [];
  try { return JSON.parse(readFileSync(FEED_FILE, 'utf8')); } catch { return []; }
}

function saveFeed(items) {
  mkdirSync(dirname(FEED_FILE), { recursive: true });
  const tmp = FEED_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(items, null, 1), { mode: 0o600 });
  renameSync(tmp, FEED_FILE);
}

// 同一时间只允许一个监听进程，否则两个进程会互相覆盖 nft-feed.json
const PID_FILE = join(dirname(SESSION_FILE), 'tg-watch.pid');
try { const other = Number(readFileSync(PID_FILE, 'utf8')); if (other && other !== process.pid) { process.kill(other, 0); console.error(`已有监听进程在运行（pid ${other}），本进程退出`); process.exit(3); } } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH' && !(e instanceof SyntaxError) && e.code !== undefined) throw e; }
writeFileSync(PID_FILE, String(process.pid));
const releasePid = () => { try { if (Number(readFileSync(PID_FILE, 'utf8')) === process.pid) rmSync(PID_FILE); } catch { /* 已经没了 */ } };
process.on('exit', releasePid); process.on('SIGTERM', () => process.exit(0));

const feed = loadFeed();
const known = new Set(feed.map((x) => x.contract));

function ingest(msg) {
  const text = msg.message || '';
  const parsed = parseNftPost(text);
  if (!parsed || known.has(parsed.contract)) return null;
  known.add(parsed.contract);
  const item = { ...parsed, eligible: autoEligible(parsed), msgId: msg.id, postedAt: new Date(msg.date * 1000).toISOString(), seenAt: new Date().toISOString(), raw: text };
  feed.unshift(item);
  saveFeed(feed);
  return item;
}

function describe(item) {
  const flags = [item.free ? '免费' : '非免费', item.agentGated ? 'Agent限定' : '无Agent限定', item.manualOnly ? '需官网验证' : '', item.website ? '官网' : '', item.xHandle ? 'X' : ''].filter(Boolean).join(' / ');
  return `${item.name}${item.symbol ? `（${item.symbol}）` : ''} ${item.contract} | ${flags} | 自动候选=${item.eligible ? '是' : '否'}`;
}

const { apiId, apiHash } = apiCredentials();
const client = new TelegramClient(new StringSession(readFileSync(SESSION_FILE, 'utf8').trim()), apiId, apiHash, { connectionRetries: 5, proxy: tgProxy() });
await client.connect();

const dialogs = await client.getDialogs({ limit: 300 });
const channel = dialogs.find((d) => Number(d.id) === CHANNEL_ID);
if (!channel) throw new Error(`没找到频道 ${CHANNEL_ID}，请确认已加入`);

const recent = await client.getMessages(channel.entity, { limit: BACKFILL });
let added = 0;
for (const msg of [...recent].reverse()) if (ingest(msg)) added++;
console.log(`回补完成：新增 ${added} 条，当前共 ${feed.length} 条`);

client.addEventHandler((event) => {
  const item = ingest(event.message);
  if (item) console.log(`[新] ${describe(item)}`);
}, new NewMessage({ chats: [channel.entity] }));

console.log('监听中…（Ctrl+C 停止）');
process.on('SIGINT', async () => { await client.disconnect(); process.exit(0); });
