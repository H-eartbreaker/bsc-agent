// 一个钱包一个后端；沿用上游 WALLET_PEERS / x-bsc-agent-token 协议，路由不重试资金请求。
import { ethers } from 'ethers';
export function parsePeers(raw = '[]', selfSlot = 1) {
  let list; try { list = JSON.parse(raw); } catch { throw new Error('WALLET_PEERS 必须是 JSON 数组'); }
  if (!Array.isArray(list)) throw new Error('WALLET_PEERS 必须是 JSON 数组');
  const slots = new Set([selfSlot]), urls = new Set();
  return list.map(p => {
    const slot = Number(p.slot); let url;
    try { url = new URL(p.url); } catch { throw new Error('钱包后端地址无效'); }
    if (!Number.isInteger(slot) || slot < 1 || slot > 99 || slots.has(slot)) throw new Error('钱包编号重复或无效');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('钱包后端仅允许本机 HTTP 根地址');
    if (urls.has(url.origin)) throw new Error('钱包后端地址重复');
    if (p.address && !ethers.isAddress(p.address)) throw new Error('钱包预期地址无效');
    if (p.token !== undefined && (typeof p.token !== 'string' || p.token.length < 32 || /\s/.test(p.token))) throw new Error('钱包 Token 无效');
    slots.add(slot); urls.add(url.origin);
    return { slot, url: url.origin, label: String(p.label || `钱包 ${slot}`).slice(0, 40), address: p.address?.toLowerCase() || null, token: p.token };
  });
}
export class WalletFleet {
  constructor({ slot = 1, label, peers = [], token, self, localOrder, localQuery, settings, save, request = fetch }) {
    Object.assign(this, { slot, label, peers, token, self, localOrder, localQuery, settings, save, request });
    this.cache = []; this.snapshots = new Map();
  }
  id(slot) { return slot === this.slot ? 'baw' : `wallet${slot}`; }
  slotFor(id) { if (id === 'baw') return this.slot; const peer = this.peers.find(p => this.id(p.slot) === id); if (!peer) throw new Error('未知钱包'); return peer.slot; }
  enabled(slot) { return this.settings().walletOn?.[slot] ?? slot === this.slot; }
  async call(peer, path, body, ms = 5000) {
    const r = await this.request(peer.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-bsc-agent-token': peer.token || this.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`钱包后端 HTTP ${r.status}`);
    return r.json();
  }
  view(info, slot, label, expected, reachable = true) {
    const address = ethers.isAddress(info?.address || '') ? info.address.toLowerCase() : null;
    const expect = expected || (ethers.isAddress(info?.expect || '') ? info.expect.toLowerCase() : null);
    const auth = !reachable ? 'offline' : Number(info?.slot) !== slot ? 'wrong_backend' : info?.auth === 'ok' && (!address || !expect || address !== expect) ? 'wrong_account' : info?.auth || 'checking';
    // 不透传 peer 的原始对象、错误文本、路径或认证信息。
    const login = info?.login;
    let safeLogin = null;
    if (login && ['waiting', 'failed', 'expired', 'done', 'checking'].includes(login.state)) {
      safeLogin = { state: login.state, message: login.state === 'waiting' ? '请核对配对码并在对应账号的币安 App 中确认' : '' };
      if (login.state === 'waiting') { try { const u = new URL(login.urlForWeb); if (u.protocol === 'https:' && ['web3.binance.com', 'app.binance.com'].includes(u.hostname) && !u.username && !u.password && !u.port && Number(login.expireAt) > Date.now()) Object.assign(safeLogin, { urlForWeb: login.urlForWeb, pairingCode: String(login.pairingCode || ''), expireAt: Number(login.expireAt) }); } catch { /* 不显示非法登录链接 */ } }
    }
    return { id: this.id(slot), slot, label, address, expect, auth, connected: auth === 'ok', reachable, on: this.enabled(slot) === true, bnb: Number(info?.bnb) || 0, handle: typeof info?.agentId === 'string' ? info.agentId : null, agentId: auth === 'ok', whitelisted: true, dryRun: info?.dryRun !== false, login: safeLogin, color: 'linear-gradient(135deg,#f0b90b,#3fb950)' };
  }
  refresh() {
    if (!this.refreshing) this.refreshing = this.read().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async read() {
    const own = this.self(), results = await Promise.all(this.peers.map(async peer => {
      try { const info = await this.call(peer, '/api/wallet-info'); const view = this.view(info, peer.slot, peer.label, peer.address); if (view.auth === 'ok') this.snapshots.set(peer.slot, info); else this.snapshots.delete(peer.slot); return view; }
      catch { this.snapshots.delete(peer.slot); return this.view(null, peer.slot, peer.label, peer.address, false); }
    }));
    this.cache = [this.view(own, this.slot, this.label, own.expect), ...results];
    const counts = new Map(); for (const w of this.cache) if (w.address && w.auth === 'ok') counts.set(w.address, (counts.get(w.address) || 0) + 1);
    for (const w of this.cache) if (counts.get(w.address) > 1) { w.auth = 'duplicate_account'; w.connected = false; this.snapshots.delete(w.slot); }
    return this.cache;
  }
  async setEnabled(slot, on) {
    if (slot !== this.slot && !this.peers.some(p => p.slot === slot)) throw new Error('未知钱包');
    await this.refresh(); const w = this.cache.find(w => w.slot === slot);
    if (on && w?.auth !== 'ok') throw new Error('钱包未连接、账号未校验或账号重复，不能参与下单');
    const walletOn = { ...(this.settings().walletOn || {}), [slot]: on === true };
    this.save('walletOn', walletOn); for (const row of this.cache) row.on = this.enabled(row.slot) === true;
    return this.cache;
  }
  async login(slot) {
    if (slot === this.slot) throw new Error('本机钱包请使用本机登录入口');
    const peer = this.peers.find(p => p.slot === slot); if (!peer) throw new Error('未知钱包');
    await this.call(peer, '/api/auth/login', {}, 40000); await this.refresh();
    return this.cache.find(w => w.slot === slot)?.login || { state: 'failed', message: '未获得有效登录链接，请重新检测' };
  }
  async query(id, path, query) {
    const slot = this.slotFor(id); if (slot === this.slot) return this.localQuery(path, { ...query, wallet: 'baw' });
    const peer = this.peers.find(p => p.slot === slot);
    return this.call(peer, path + '?' + new URLSearchParams({ ...query, wallet: 'baw' }));
  }
  async orders({ wallets, slots, fast = false, ...order }) {
    if (wallets !== undefined && (!Array.isArray(wallets) || !wallets.length)) throw new Error('请选择执行钱包');
    if (slots !== undefined && (!Array.isArray(slots) || !slots.length)) throw new Error('请选择执行钱包');
    // 快速下单只使用最近的钱包快照；链上执行在后台继续，避免页面一直等完整回执。
    if (!fast || !this.cache.length) await this.refresh();
    const selected = slots ? slots.map(Number) : wallets?.length ? wallets.map(id => this.slotFor(id)) : this.cache.filter(w => w.on).map(w => w.slot);
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(n => !this.cache.some(w => w.slot === n))) throw new Error('请选择有效且不重复的钱包');
    return (await Promise.all(selected.map(async slot => {
      const w = this.cache.find(w => w.slot === slot), base = { id: `wallet${slot}-${Date.now()}`, ts: Date.now(), wallet: w.label, walletSlot: slot, walletId: w.id, token: order.token, side: order.side, amount: order.amount };
      if (!w.on || w.auth !== 'ok') return [{ ...base, status: 'failed', reason: !w.on ? '钱包未开启参与下单，已跳过' : '钱包掉线或账号校验未通过，已跳过' }];
      if (fast) {
        if (slot === this.slot) {
          const before = this.self()?.orders?.[0]?.id;
          const job = this.localOrder(order);
          job.catch(() => {});
          const current = this.self()?.orders?.find(x => x.id !== before) || this.self()?.orders?.[0];
          return [{ ...(current || base), wallet: w.label, walletSlot: slot, walletId: w.id }];
        }
        // 远端钱包没有共享本地 WebSocket；先回 pending，后续刷新订单时会看到最终状态。
        void this.call(this.peers.find(p => p.slot === slot), '/api/wallet/order', order, 200000).catch(() => {});
        return [{ ...base, status: 'pending', stage: 'submitted', reason: '已提交到钱包后端，正在处理' }];
      }
      try {
        const rows = slot === this.slot ? await this.localOrder(order) : await this.call(this.peers.find(p => p.slot === slot), '/api/wallet/order', order, 200000);
        return [].concat(rows || []).map(row => ({ ...row, id: slot === this.slot ? row.id : `wallet${slot}-${row.id}`, wallet: w.label, walletSlot: slot, walletId: w.id }));
      } catch { return [{ ...base, status: 'unknown', reason: '钱包请求结果未确认，可能已提交；请查该钱包订单和余额，勿重复提交' }]; }
    }))).flat();
  }
  positions(own) {
    return [...own, ...this.peers.flatMap(p => { const rows = this.snapshots.get(p.slot)?.positions; return Array.isArray(rows) ? rows.map(r => ({ ...r, walletId: this.id(p.slot), wallet: p.label })) : []; })];
  }
  orderViews(own) {
    return [...own, ...this.peers.flatMap(p => { const rows = this.snapshots.get(p.slot)?.orders; return Array.isArray(rows) ? rows.map(r => ({ ...r, id: `wallet${p.slot}-${r.id}`, walletId: this.id(p.slot), walletSlot: p.slot, wallet: p.label })) : []; })].sort((a, b) => b.ts - a.ts).slice(0, 300);
  }
  holdings(own) {
    const parts = [{ slot: this.slot, label: this.label, snap: this.cache.find(w => w.slot === this.slot)?.auth === 'ok' ? own : null }, ...this.peers.map(p => ({ slot: p.slot, label: p.label, snap: this.snapshots.get(p.slot)?.holdings }))];
    const rows = parts.flatMap(p => (p.snap?.rows || []).map(r => ({ ...r, walletId: this.id(p.slot), wallet: p.label, walletSlot: p.slot })));
    const totals = {}; for (const p of parts) for (const [key, value] of Object.entries(p.snap?.totals || {})) if (typeof value === 'number') totals[key] = (totals[key] || 0) + value;
    const realized = parts.flatMap(p => (p.snap?.realized || []).map(r => ({ ...r, walletId: this.id(p.slot), wallet: p.label, walletSlot: p.slot })));
    return { ...own, rows, realized, totals, bnb: this.cache.filter(w => w.auth === 'ok').reduce((n, w) => n + w.bnb, 0), wallets: parts.map(p => ({ slot: p.slot, label: p.label, available: !!p.snap })), partial: parts.some(p => !p.snap) };
  }
}
