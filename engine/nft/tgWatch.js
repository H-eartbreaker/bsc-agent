// 监听 Aibot打新提示群 的 NFT 推送，解析后写入 data/nft-feed.json（按合约地址去重）。
// 运行：node engine/nft/tgWatch.js
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { env } from '../live/config.js';
import { parseNftPost, autoEligible, feedWorthy } from './parseFeed.js';
import { SESSION_FILE, apiCredentials, tgProxy } from './tgConfig.js';

const CHANNEL_ID = Number(env('TG_CHANNEL_ID', ''));
if (!CHANNEL_ID) { console.error('缺少 TG_CHANNEL_ID（要监听的 Telegram 频道 id，在 .env 里设置）'); process.exit(1); }
const FEED_FILE = join(dirname(SESSION_FILE), 'nft-feed.json');
const BACKFILL = Number(env('TG_BACKFILL', '30'));
const AGENT_ONLY = env('NFT_FEED_AGENT_ONLY', '1') !== '0';

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

let feed = loadFeed();
if (AGENT_ONLY) {   // 启动时清掉以前存下的非 Agent ID 项目（先留一份备份，只备份一次）
  const keep = feed.filter((x) => feedWorthy(x, true));
  if (keep.length !== feed.length) {
    const bak = join(dirname(FEED_FILE), 'nft-feed.before-agent-filter.json');
    if (!existsSync(bak)) writeFileSync(bak, JSON.stringify(feed, null, 1), { mode: 0o600 });
    console.log(`清理：去掉 ${feed.length - keep.length} 个非 Agent ID 项目，保留 ${keep.length} 个`);
    feed = keep; saveFeed(feed);
  }
}
const known = new Set(feed.map((x) => x.contract));
const skipped = new Map();

function ingest(msg) {
  const text = msg.message || '';
  const parsed = parseNftPost(text);
  if (!parsed || known.has(parsed.contract)) return null;
  if (!feedWorthy(parsed, AGENT_ONLY)) {   // 机器人会先发简版、再编辑补全；被跳过的不记入 known，消息变了就重新判断
    if (skipped.get(parsed.contract) !== text) { skipped.set(parsed.contract, text); console.log(`[跳过] ${parsed.name || parsed.contract}：不是 Agent ID 项目`); }
    return null;
  }
  known.add(parsed.contract); skipped.delete(parsed.contract);   // 排序时间取「发出 / 最近编辑」里较晚的：编辑后才合格的项目会排到最前面
  const item = { ...parsed, eligible: autoEligible(parsed), msgId: msg.id, postedAt: new Date(Math.max(msg.date || 0, msg.editDate || 0) * 1000).toISOString(), seenAt: new Date().toISOString(), raw: text };
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
  try {
    if (Number(event.chatId) !== CHANNEL_ID) return;
    const item = ingest(event.message);
    if (item) console.log(`[新] ${describe(item)}`);
  } catch (e) { console.error('处理新消息出错：', e.message); }
}, new NewMessage({}));

// 兜底轮询：gramJS 的推送偶尔会悄悄断流（进程还活着但收不到新消息），每 30 秒主动拉一次最新消息；连续 3 次拉取失败就退出，让守护进程重启。
const POLL_MS = Number(process.env.TG_POLL_MS) || 30_000;
let pollFails = 0, polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    const latest = await Promise.race([client.getMessages(channel.entity, { limit: 15 }), new Promise((_, rej) => setTimeout(() => rej(new Error('拉取超时')), 20_000))]);
    pollFails = 0;
    for (const msg of [...latest].reverse()) { const item = ingest(msg); if (item) console.log(`[新·轮询] ${describe(item)}`); }
  } catch (e) {
    console.error(`轮询失败（${++pollFails}/3）：${e.message}`);
    if (pollFails >= 3) process.exit(1);
  } finally { polling = false; }
}, POLL_MS);

console.log('监听中…（Ctrl+C 停止）');
process.on('SIGINT', async () => { await client.disconnect(); process.exit(0); });
