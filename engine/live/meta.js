// 代币元数据（图标 / 简介 / 社交链接）：Flap 读 Reader 的 meta（IPFS CID），Four 读 TokenCreated 里的 tokenMetaUri（static.four.meme）。
// 低并发、带缓存；遇到 429 整体暂停一会儿，不刷对方接口。
import { isAllowedImageUrl } from '../security.js';
const IPFS = 'https://flap.mypinata.cloud/ipfs/';
const CONCURRENCY = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把 CID / ipfs:// / 相对路径统一成可直接加载的 https 地址
export function ipfsUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('ipfs://')) return IPFS + s.slice(7).replace(/^ipfs\//, '');
  if (s.startsWith('/')) return 'https://static.four.meme' + s;
  return IPFS + s;
}

export class MetaFetcher {
  constructor() { this.cache = new Map(); this.queue = []; this.active = 0; this.pausedUntil = 0; }

  // url → 回调 { image, description, website, twitter, telegram }；同一个 url 只请求一次
  get(url, cb) {
    if (!url || !isAllowedImageUrl(url)) return;
    const hit = this.cache.get(url);
    if (hit && hit !== 'pending') return cb(hit);
    if (hit === 'pending') return;
    this.cache.set(url, 'pending');
    this.queue.push({ url, cb });
    this.pump();
  }

  pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift(); this.active++;
      this.run(job).finally(() => { this.active--; this.pump(); });
    }
  }

  async run({ url, cb }) {
    for (let k = 0; k < 3; k++) {
      const wait = this.pausedUntil - Date.now(); if (wait > 0) await sleep(wait);
      try {
        // Token-controlled metadata must not redirect requests into the local network.
        const res = await fetch(url, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 429) { this.pausedUntil = Date.now() + 60_000; continue; }
        if (!res.ok) break;
        if (Number(res.headers.get('content-length') || 0) > 1e6) { await res.body?.cancel(); break; }
        const chunks = []; let size = 0;
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > 1e6) throw new Error('metadata too large');
          chunks.push(chunk);
        }
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const links = j.links || {};
        const v = { image: ipfsUrl(j.image || j.img), description: j.description || '', website: j.website || links.website || '',
          twitter: j.twitter || links.twitter || '', telegram: j.telegram || links.telegram || '' };
        this.cache.set(url, v); cb(v);
        return;
      } catch { await sleep(1500 * (k + 1)); }
    }
    this.cache.delete(url);   // 失败的下次再试
  }
}
