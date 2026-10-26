// RPC：有 NODEREAL_RPC 就用它当主节点，出错或被限流时自动换公共节点（bsc-dataseed / publicnode），30 秒后再试主节点。
// 地址里含 key，显示到页面 / 日志时一律用 maskRpc() 隐藏
import { ethers } from 'ethers';

export const maskRpc = (u) => String(u || '').replace(/(nodereal\.io\/v1\/)[A-Za-z0-9]+/i, '$1***').replace(/([?&](api[-_]?key|key|token)=)[^&]+/ig, '$1***');

// 页面上显示的节点名（不含 key）
export const nodeName = (u) => { const h = String(u || ''); return /nodereal/i.test(h) ? 'NodeReal' : /publicnode/i.test(h) ? 'PublicNode' : /dataseed|bnbchain/i.test(h) ? 'BNB Chain' : /48\.club/i.test(h) ? '48 Club' : h ? (h.match(/\/\/([^/:]+)/)?.[1] || '自定义') : '—'; };

export class FailoverProvider extends ethers.JsonRpcProvider {
  constructor(urls) {
    const list = urls.filter(Boolean);
    super(list[0], 56, { staticNetwork: true });
    this.urls = list; this.alts = list.slice(1).map((u) => new ethers.JsonRpcProvider(u, 56, { staticNetwork: true }));
    this.coolUntil = 0; this.lastUsed = maskRpc(list[0]); this.primaryErr = null;
  }
  get info() { return { active: nodeName(this.lastUsed), primary: nodeName(this.urls[0]), fallback: this.lastUsed !== maskRpc(this.urls[0]), coolUntil: this.coolUntil, primaryErr: this.primaryErr }; }
  async _send(payload) {
    if (Date.now() >= this.coolUntil) {
      try {
        const r = await super._send(payload);
        const bad = (Array.isArray(r) ? r : [r]).find((x) => x?.error && /limit|429|rate|too many|exceed/i.test(String(x.error.message)));
        if (!bad) { this.lastUsed = maskRpc(this.urls[0]); return r; }
        throw new Error(bad.error.message);
      } catch (e) { this.primaryErr = String(e.shortMessage || e.message || e).slice(0, 160); if (!this.alts.length) throw e; this.coolUntil = Date.now() + 30_000; }
    }
    let last;
    for (let i = 0; i < this.alts.length; i++) { try { const r = await this.alts[i]._send(payload); this.lastUsed = maskRpc(this.urls[i + 1]); return r; } catch (e) { last = e; } }
    throw last;
  }
}
