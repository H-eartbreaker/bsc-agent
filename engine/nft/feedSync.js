// 普通用户不用配 Telegram：定时拉取作者发布的新项目数据，写成本地 data/nft-feed.json，后面的列表和自动 mint 照常用。
// 作者没开监听时远端数据停止更新，这里只会显示「推送已停止」，不影响已有数据。
import { renameSync, writeFileSync } from 'node:fs';
import { pfetch } from '../netProxy.js';
import { cleanRow } from './feedApi.js';

export const DEFAULT_FEED_URL = 'https://gist.githubusercontent.com/H-eartbreaker/30125fbc8f78a4c8a71fcaa3e6d14bdb/raw/nft-feed.json';
export const FEED_STALE_MS = 30 * 60_000;

export class FeedSync {
  constructor({ url, file, log = () => {}, intervalMs = 60_000, fetcher = pfetch }) {
    this.url = url; this.file = file; this.log = log; this.intervalMs = intervalMs; this.fetcher = fetcher;
    this.timer = null; this.info = { state: url ? 'idle' : 'nourl', updatedAt: null, checkedAt: null };
  }

  status() {
    const u = this.info.updatedAt;
    return { ...this.info, stale: !!u && Date.now() - u > FEED_STALE_MS, url: undefined };
  }

  start() {
    if (this.timer || !this.url) return;
    this.sync();
    this.timer = setInterval(() => this.sync(), this.intervalMs); this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async sync() {
    try {
      const res = await this.fetcher(this.url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = await res.json();
      const list = Array.isArray(doc) ? doc : Array.isArray(doc?.items) ? doc.items : null;
      if (!list) throw new Error('数据格式不对');
      const rows = list.map(cleanRow).filter(Boolean);
      const updatedAt = Number(doc?.updatedAt) || this.info.updatedAt || Date.now();
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(rows)); renameSync(tmp, this.file);
      this.info = { state: 'ok', updatedAt, checkedAt: Date.now(), count: rows.length };
    } catch (e) {
      this.info = { ...this.info, state: 'error', checkedAt: Date.now(), error: String(e.message || e).slice(0, 120) };
      this.log('[nft-feed] 拉取失败：' + this.info.error);
    }
  }
}

