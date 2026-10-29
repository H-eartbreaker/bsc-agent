// 一次性登录 Telegram 账号，保存会话到 data/tg-session.txt，并列出标题含关键词（默认 Aibot）的群/频道及 id，把 id 填进 .env 的 TG_CHANNEL_ID（不输出会话内容）。
// 运行：node scripts/tg-login.mjs [关键词]（手机号、验证码、2FA 密码都在终端输入）
import { createInterface } from 'node:readline/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { SESSION_FILE, apiCredentials, tgProxy } from '../engine/nft/tgConfig.js';

const { apiId, apiHash } = apiCredentials();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3, proxy: tgProxy() });
await client.start({
  phoneNumber: () => ask('手机号（带国家码，如 +86...）：'),
  phoneCode: () => ask('Telegram 发来的验证码：'),
  password: () => ask('2FA 密码（没有就直接回车）：'),
  onError: (e) => console.error('登录错误:', e.message),
});

mkdirSync(dirname(SESSION_FILE), { recursive: true });
writeFileSync(SESSION_FILE, client.session.save(), { mode: 0o600 });
console.log(`会话已保存: ${SESSION_FILE}`);

const dialogs = await client.getDialogs({ limit: 300 });
const kw = (process.argv[2] || 'aibot').toLowerCase();
const hits = dialogs.filter((d) => (d.title || '').toLowerCase().includes(kw));
if (!hits.length) console.log(`没找到标题含「${kw}」的群，请确认你已经加入该群。`);
for (const d of hits) console.log(`群: ${d.title} | id: ${d.id} | 类型: ${d.isChannel ? '频道' : '群'}`);

rl.close();
await client.disconnect();
process.exit(0);
