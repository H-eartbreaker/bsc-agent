// 地址 → 域名映射：优先币安 Agent ID（.ai，链上 handleOf），其次 SPACE ID 主域名（.bnb 等）。
// 查到的永久写入本地 data/names.json，重启不丢；查不到的 10 分钟后重查；查询出错不记为"没有"，稍后重试。
import fs from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from './config.js';
const FILE = dataFile('names.json');
const RPCS = (process.env.NAME_RPC || 'https://bsc-rpc.publicnode.com,https://bsc.publicnode.com,https://bsc-dataseed.bnbchain.org').split(',');
const regs = RPCS.map((u) => new ethers.Contract('0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F', ['function handleOf(address) view returns (string)'],
  new ethers.JsonRpcProvider(u, 56, { staticNetwork: true })));
const API = 'https://nameapi.space.id/getName?chainid=56&address=';
const NEG_TTL = 10 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NameCache {
  constructor() {
    this.map = new Map(); this.queue = []; this.queued = new Set(); this.running = 0; this.stats = { asked: 0, found: 0 }; this.ver = 0; this.rr = 0;
    try { for (const [k, name] of Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) this.map.set(k, { name, at: Date.now() }); } catch { /* 第一次没有文件 */ }
  }
  key(a) { return String(a || '').toLowerCase(); }
  save() { clearTimeout(this.saveT); this.saveT = setTimeout(() => { const o = {}; for (const [k, v] of this.map) if (v.name) o[k] = v.name; try { fs.mkdirSync(new URL('.', FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o, null, 1)); } catch { /* ignore */ } }, 1000); }
  set(address, name) { if (address && name) { this.map.set(this.key(address), { name, at: Date.now() }); this.ver++; this.save(); } }
  all() { const o = {}; for (const [k, v] of this.map) if (v.name) o[k] = v.name; return o; }

  peek(address) {
    const k = this.key(address); if (!/^0x[0-9a-f]{40}$/.test(k)) return null;
    const v = this.map.get(k);
    if (v && (v.name || Date.now() - v.at < NEG_TTL)) return v.name || null;
    if (!this.queued.has(k)) { this.queued.add(k); this.queue.push(k); this.kick(); }
    return null;
  }

  async lookup(k) {
    let err = null;
    for (let i = 0; i < regs.length; i++) {
      try { const h = await regs[(this.rr++) % regs.length].handleOf(k); if (h) return h + '.ai'; err = null; break; } catch (e) { err = e; }
    }
    try { const j = await (await fetch(API + k, { signal: AbortSignal.timeout(8_000) })).json(); if (j?.data?.name) return j.data.name; } catch (e) { err = err || e; }
    if (err) throw err;   // 链上没查成功：不当成"没有域名"
    return null;
  }

  // 页面「查域名」：.ai（币安 Agent ID）和 SPACE ID 主域名都现查一遍（不排队），查到的写进缓存
  async lookupBoth(address) {
    const k = this.key(address); let ai = null, sid = null, aiErr = null, sidErr = null;
    for (let i = 0; i < regs.length; i++) {
      try { const h = await regs[(this.rr++) % regs.length].handleOf(k); ai = h ? h + '.ai' : null; aiErr = null; break; } catch (e) { aiErr = e; }
    }
    try { const j = await (await fetch(API + k, { signal: AbortSignal.timeout(8_000) })).json(); sid = j?.data?.name || null; } catch (e) { sidErr = e; }
    if (aiErr && sidErr) throw aiErr;
    const name = ai || sid; if (name) { this.map.set(k, { name, at: Date.now() }); this.ver++; this.save(); }
    return { ai, sid, name, aiFailed: !!aiErr, sidFailed: !!sidErr };
  }

  kick() { while (this.running < 2 && this.queue.length) this.worker(); }
  async worker() {
    this.running++;
    while (this.queue.length) {
      const k = this.queue.pop();
      try { const name = await this.lookup(k); this.map.set(k, { name, at: Date.now() }); this.stats.asked++; if (name) { this.stats.found++; this.ver++; this.save(); } }
      catch { setTimeout(() => { this.queued.delete(k); this.peek(k); }, 5000); this.queued.add(k); await sleep(200); continue; }
      this.queued.delete(k);
      if (this.queue.length > 1000) this.queue.splice(0, this.queue.length - 1000).forEach((x) => this.queued.delete(x));
      await sleep(120);
    }
    this.running--;
  }
}
