// 按币的「发射后转出」监控（与 AUTO_TRANSFER_FOUR 无关）：data/transferWatch.json = [{ token, recipient, addedAt, status }]
// 每 3 秒读链上 Gang 曲线状态（V1 老盘 / V2 各 pad 的 curves(token).graduated / pair），每 10 秒再看 gang.fun 接口的 graduated。
// 一旦发射就用 baw wallet send --max 把该币全部转到 recipient（最多 3 次），记录 tx，并推送弹窗。启动时也会立即检查一次。
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import * as baw from './baw.js';
const FILE = new URL('../../data/transferWatch.json', import.meta.url);
const PADS = ['0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb', '0x60aee38576035E757deD30fF8db8A8DA476430C1'];
const V2 = new ethers.Interface(['function curves(address) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, bool taxed, address pair, address refPair)']);
const ERC = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
const sh = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const MIN_GAS_BNB = 0.0002;

export function startTransferWatch(trader, provider, { intervalMs = 3000, dryRun = false } = {}) {
  let list = []; try { list = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* 没有文件就空 */ }
  const save = () => { try { writeFileSync(FILE, JSON.stringify(list, null, 1)); } catch { /* ignore */ } };
  const pad = new Map(); let apiAt = 0, busy = false, gasWarnAt = 0;
  const emit = (o) => { trader.emit('order', o); trader.emit('autoTransfer', o); };
  const note = (w, msg) => { console.log(`[transferWatch] ${msg}`); emit({ id: randomBytes(5).toString('hex'), ts: Date.now(), token: w.token, symbol: w.symbol || '?', platform: 'gang', side: 'transfer', to: w.recipient, toShort: sh(w.recipient), status: 'failed', reason: msg, steps: [], auto: true }); };

  async function graduated(w) {
    // 链上：找到这个币所在的 V2 pad，读 graduated / pair
    for (const p of pad.get(w.token) ? [pad.get(w.token)] : PADS) {
      try {
        const r = V2.decodeFunctionResult('curves', await provider.call({ to: p, data: V2.encodeFunctionData('curves', [w.token]) }));
        if (r.quote === ethers.ZeroAddress) continue;
        pad.set(w.token, p);
        if (r.graduated || r.pair !== ethers.ZeroAddress) return `链上 curves.graduated=${r.graduated} pair=${r.pair}`;
        w.progress = Number(r.gradAmt) ? +(Number(r.realQuote) / Number(r.gradAmt) * 100).toFixed(2) : null;
        break;
      } catch { /* 读失败换下一个 */ }
    }
    // 行情列表里的 stage（V1 老盘也覆盖）
    const t = trader.market.get?.(w.token); if (t && t.stage === 'dex') return '行情 stage=dex';
    // gang.fun 接口兜底（10 秒一次）
    if (Date.now() - apiAt > 10_000) {
      apiAt = Date.now();
      for (const path of ['stocks/tokens', 'tokens']) {
        try { const j = await (await fetch(`https://gang.fun/api/${path}/${w.token}`, { signal: AbortSignal.timeout(4000) })).json(); const x = j.token || j.item || j; if (x?.graduated) return `gang.fun 接口 graduated pair=${x.pair}`; } catch { /* ignore */ }
      }
    }
    return null;
  }

  async function checkGas(w) {
    const wal = trader.wallets?.[0]; if (!wal) return;
    const bnb = Number(ethers.formatEther(await provider.getBalance(wal.address)));
    w.gasBnb = bnb;
    if (bnb < MIN_GAS_BNB && Date.now() - gasWarnAt > 600_000) { gasWarnAt = Date.now(); note(w, `⚠️ 钱包 BNB 只剩 ${bnb.toFixed(6)}，可能不够发射后转出的 gas，请充一点 BNB`); }
  }

  async function transfer(w, why) {
    const wal = trader.wallets?.[0]; if (!wal) return;
    const c = new ethers.Contract(w.token, ERC, provider);
    const bal = await c.balanceOf(wal.address); const dec = Number(await c.decimals().catch(() => 18)); const qty = Number(ethers.formatUnits(bal, dec));
    w.migratedAt = w.migratedAt || Date.now(); w.why = why;
    if (bal === 0n) { w.status = 'empty'; save(); return note(w, `${w.symbol} 已发射，但钱包里没有余额，无需转出`); }
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: wal.id, wallet: wal.label, token: w.token, symbol: w.symbol || '?', platform: 'gang', side: 'transfer', amountIn: qty, to: w.recipient, toShort: sh(w.recipient), status: 'pending', steps: [], auto: true };
    if (dryRun) { w.status = 'dry_run'; save(); return note(w, `DRY_RUN：${w.symbol} 已发射，未真实转出`); }
    w.tries = (w.tries || 0) + 1;
    try {
      const d = await baw.sendMax({ tokenAddress: w.token, recipient: w.recipient, gasLevel: 'MEDIUM' });
      Object.assign(order, { status: 'filled', tx: d.txHash || d.hash || null, out: qty, reason: `已发射，已转出 ${qty.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 枚 → ${sh(w.recipient)}` });
      Object.assign(w, { status: 'done', tx: order.tx, qty, doneAt: Date.now() });
    } catch (e) {
      Object.assign(order, { status: 'failed', reason: `已发射，转出失败（第 ${w.tries}/3 次）：${e.message}` });
      w.lastError = e.message; w.status = w.tries >= 3 ? 'failed' : 'retry'; w.nextAt = Date.now() + 5000;
    }
    save(); emit(order); console.log(`[transferWatch] ${w.symbol} ${order.status} ${order.tx || order.reason}`);
  }

  async function tick() {
    if (busy) return; busy = true;
    try {
      for (const w of list) {
        if (!['watching', 'retry'].includes(w.status) || Date.now() < (w.nextAt || 0)) continue;
        const why = w.status === 'retry' ? w.why : await graduated(w);
        if (why) await transfer(w, why);
      }
    } catch (e) { console.error('transferWatch:', e.message); } finally { busy = false; }
  }
  const active = () => list.filter((w) => ['watching', 'retry'].includes(w.status));
  setTimeout(async () => { for (const w of active()) await checkGas(w).catch(() => {}); tick(); }, 3000);   // 启动时立即查一次（等钱包信息加载）
  setInterval(tick, intervalMs);
  setInterval(() => { for (const w of active()) checkGas(w).catch(() => {}); }, 300_000);
  return { list: () => list, intervalMs };
}
