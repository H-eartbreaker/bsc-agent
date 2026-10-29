import { Contract } from 'ethers';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ABI = ['function contractURI() view returns (string)', 'function tokenURI(uint256) view returns (string)', 'function image(uint256) view returns (string)'];
const MISS_TTL = 60 * 60 * 1000;
const RETRY_TTL = 90 * 1000;   // 网络/限流导致的失败只缓存很短时间，很快重试
const IPFS = 'https://ipfs.io/ipfs/';

export const toHttp = (u) => {
  const s = String(u || '').trim();
  if (/^ipfs:\/\//i.test(s)) return IPFS + s.replace(/^ipfs:\/\/(ipfs\/)?/i, '');
  if (/^ar:\/\//i.test(s)) return 'https://arweave.net/' + s.slice(5);
  return s;
};

function parseDataJson(uri) {
  const m = uri.match(/^data:application\/json(;[^,]*)?,(.*)$/is);
  if (!m) return null;
  const body = /;base64/i.test(m[1] || '') ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
  return JSON.parse(body);
}

export class ArtResolver {
  constructor({ provider, fetchJson, file, now = () => Date.now() }) {
    this.provider = provider; this.fetchJson = fetchJson; this.file = file; this.now = now;
    this.inflight = new Map();
    this.cache = {};
    try { if (file && existsSync(file)) this.cache = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { this.cache = {}; }
  }

  async metadata(uri) {
    const u = String(uri || '').trim();
    if (!u) return null;
    if (u.startsWith('data:')) return parseDataJson(u);
    const url = toHttp(u);
    return /^https:\/\//i.test(url) ? this.fetchJson(url) : null;
  }

  // state.transient：有调用是因为网络/限流失败（不是合约没这个函数），这时的"没图"不能当结论缓存太久
  async lookup(contract, state = {}) {
    const c = new Contract(contract, ABI, this.provider);
    const asImage = (v) => {
      const s = String(v || '').trim();
      return /^data:image\//i.test(s) ? s : null;
    };
    const tries = [() => c.contractURI(), () => c.tokenURI(1), () => c.tokenURI(0), () => c.tokenURI(2), () => c.image(1), () => c.image(0)];
    for (const t of tries) {
      try {
        const uri = await t();
        const direct = asImage(uri);
        if (direct) return direct;
        const meta = await this.metadata(uri);
        const img = meta && (meta.image || meta.image_url || meta.imageUrl);
        if (typeof img === 'string' && img) return img.startsWith('data:image/') ? img : toHttp(img);
      } catch (e) {
        if (e?.code !== 'CALL_EXCEPTION' && e?.code !== 'BAD_DATA') state.transient = true;   // 合约没有该函数/回滚是确定结论，其余都算临时失败
      }
    }
    return null;
  }

  async resolve(contract) {
    const key = String(contract).toLowerCase();
    const hit = this.cache[key];
    if (hit && (hit.image || this.now() - hit.at < (hit.retry ? RETRY_TTL : MISS_TTL))) return hit.image;
    let p = this.inflight.get(key);
    if (!p) {
      const state = {};
      p = this.lookup(key, state).then((image) => {
        this.cache[key] = image ? { image, at: this.now() } : { image: null, at: this.now(), retry: !!state.transient };
        try { if (this.file) writeFileSync(this.file, JSON.stringify(this.cache)); } catch { /* 缓存写不了不影响使用 */ }
        return image;
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}
