import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Contract } from 'ethers';
const bounded = async (work, ms = 3000) => { let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('read timeout')), ms); })]); } finally { clearTimeout(timer); } };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ABI = ['function ownerOf(uint256) view returns(address)', 'function name() view returns(string)', 'function symbol() view returns(string)', 'function tokenURI(uint256) view returns(string)'];
export function nftCandidates(logs, wallet) {
  const collections = new Map();
  for (const log of logs) {
    if (log.dry || String(log.wallet).toLowerCase() !== wallet.toLowerCase()) continue;
    for (const r of log.results || []) {
      if (r.status !== '成功' || !ADDRESS.test(r.contract)) continue;
      const key = r.contract.toLowerCase(), row = collections.get(key) || { contract: r.contract, name: String(r.name || 'NFT').slice(0, 100), ids: new Set() };
      for (const id of r.tokenIds || []) if (/^(?:0x[0-9a-f]+|\d+)$/i.test(String(id))) row.ids.add(BigInt(id).toString());
      collections.set(key, row);
    }
  }
  return [...collections.values()].filter(r => r.ids.size).map(r => ({ ...r, ids: [...r.ids] }));
}
export function inlineMetadata(uri) {
  if (typeof uri !== 'string' || uri.length > 1_000_000 || !uri.startsWith('data:application/json')) return null;
  try {
    const at = uri.indexOf(','), value = uri.slice(0, at).endsWith(';base64') ? Buffer.from(uri.slice(at + 1), 'base64').toString('utf8') : decodeURIComponent(uri.slice(at + 1));
    const j = JSON.parse(value); return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}
// 只检查本机成功 mint 日志里已知的合约和 tokenId，不声称是全钱包 NFT 索引。
export class NftPortfolio {
  constructor({ directory, provider, contract = address => new Contract(address, ABI, provider) }) { this.directory = directory; this.contract = contract; this.cache = new Map(); }
  async read(wallet) {
    if (!ADDRESS.test(wallet || '')) return { rows: [], unavailable: true };
    const key = wallet.toLowerCase(), old = this.cache.get(key);
    if (old && Date.now() - old.at < 120_000) return old.promise;
    const promise = this.load(wallet).catch(() => ({ rows: [], unavailable: true }));
    this.cache.set(key, { at: Date.now(), promise }); return promise;
  }
  async load(wallet) {
    const names = await readdir(this.directory).catch(() => []), logs = [];
    for (const f of names.filter(f => f.endsWith('.json')).slice(-500)) try { logs.push(JSON.parse(await readFile(path.join(this.directory, f), 'utf8'))); } catch { /* 跳过损坏日志 */ }
    const queue = nftCandidates(logs, wallet), rows = [], deadline = Date.now() + 15000;
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const r = queue.shift(), c = this.contract(r.contract), ids = []; let failed = false;
        for (const id of r.ids.slice(0, 100)) { if (Date.now() > deadline) { failed = true; break; } try { if (String(await bounded(c.ownerOf(id))).toLowerCase() === wallet.toLowerCase()) ids.push(id); } catch { failed = true; } }
        if(r.ids.length > 100) failed = true;
        if (!ids.length && !failed) continue;
        let uri = null, metadata = null;
        if (ids.length) try { uri = Date.now() < deadline ? await bounded(c.tokenURI(ids[0])) : null; metadata = inlineMetadata(uri); } catch { /* 元数据不影响所有权 */ }
        rows.push({ contract: r.contract, name: r.name, tokenIds: ids, count: ids.length, partial: failed, image: typeof metadata?.image === 'string' ? metadata.image.slice(0, 500_000) : null, tokenURI: typeof uri === 'string' && /^https:\/\//i.test(uri) ? uri : null, checkedAt: Date.now() });
      }
    }));
    return { rows, scope: '仅本机成功 mint 记录中的 NFT，已核对当前所有权；不含全部钱包资产，未提供市场估值。', updatedAt: Date.now() };
  }
}
