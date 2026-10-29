// 作者端：把监听到的新项目发布成一个公开 JSON（GitHub Gist），其他人的程序直接拉这份数据，不用各自配 Telegram。
// 只发项目字段，不发原始监听消息；每 5 分钟至少更新一次，让别人能看出「推送还在」。
import { readFileSync, existsSync } from 'node:fs';
import { cleanRow } from './feedApi.js';

export class FeedPublisher {
  constructor({ file, token, gistId, log = () => {}, intervalMs = 30_000, heartbeatMs = 5 * 60_000, fetcher = fetch }) {
    this.file = file; this.token = token; this.gistId = gistId; this.log = log; this.intervalMs = intervalMs; this.heartbeatMs = heartbeatMs; this.fetcher = fetcher;
    this.timer = null; this.lastHash = ''; this.lastAt = 0; this.info = { state: 'idle' };
  }

  status() { return { ...this.info }; }

  rows() {
    if (!existsSync(this.file)) return [];
    try { const a = JSON.parse(readFileSync(this.file, 'utf8')); return (Array.isArray(a) ? a : []).map(cleanRow).filter(Boolean).slice(0, 100).map((r) => ({ ...r, raw: '' })); } catch { return []; }
  }

  start() {
    if (this.timer || !this.token || !this.gistId) return;
    this.tick(); this.timer = setInterval(() => this.tick(), this.intervalMs); this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    const rows = this.rows(), hash = JSON.stringify(rows), now = Date.now();
    if (hash === this.lastHash && now - this.lastAt < this.heartbeatMs) return;
    try {
      const res = await this.fetcher(`https://api.github.com/gists/${this.gistId}`, {
        method: 'PATCH', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'bsc-agent-nft-feed' },
        body: JSON.stringify({ files: { 'nft-feed.json': { content: JSON.stringify({ updatedAt: now, items: rows }) } } }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.lastHash = hash; this.lastAt = now; this.info = { state: 'ok', at: now, count: rows.length };
    } catch (e) {
      this.info = { state: 'error', at: now, error: String(e.message || e).slice(0, 120) };
      this.log('[nft-feed] 发布失败：' + this.info.error);
    }
  }
}
