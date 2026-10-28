#!/usr/bin/env node
// 免费 mint 固定流程：找 ABI → 链上模拟(value=0) 试出免费上限 → baw preview 安全检查 → execute → 回执/tokenId/耗时
// 用法：
//   node scripts/free-mint.mjs 0xAddr1 Name=0xAddr2 ...        # 直接给合约
//   node scripts/free-mint.mjs --file mints.txt                 # 文件里每行「名字 0x合约」或只写 0x合约
//   加 --dry 只检查不发交易；--max 10 最多试几枚；--from 0x… 指定钱包（默认取 baw 的 EVM 地址）
// 规则：只做 value=0 的 mint；preview 有任何异常（扣费/授权/风险/非 NFT 转入）就放弃该项；付费的只报告价格，不执行。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DRY = flag('--dry');
const MAX = Number(opt('--max', 10));
const BAW = process.env.BAW_BIN || 'baw';
const RPC = process.env.RPC_URL || 'https://bsc-dataseed.binance.org';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'mint-abi');
const LOGS = path.join(ROOT, 'data', 'mint-logs');

const targets = [];
const addTarget = (name, addr) => { if (!targets.some((t) => t.addr.toLowerCase() === addr.toLowerCase())) targets.push({ name: name || addr.slice(0, 8), addr: ethers.getAddress(addr.toLowerCase()) }); };
for (let i = 0; i < argv.length; i++) {
  if (['--file', '--max', '--from'].includes(argv[i])) { i++; continue; }
  const m = argv[i].match(/^(?:([^=]+)=)?(0x[0-9a-fA-F]{40})$/);
  if (m) addTarget(m[1], m[2]);
}
const file = opt('--file');
if (file) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/(0x[0-9a-fA-F]{40})/); if (!m) continue;
  addTarget(line.slice(0, m.index).replace(/[=:：\s]+$/, '').trim(), m[1]);
}
if (!targets.length) { console.error('没有合约地址。用法见脚本顶部注释。'); process.exit(1); }

const sh = (args) => new Promise((resolve) => execFile(BAW, args, { env: process.env, maxBuffer: 1e7 }, (e, so, se) => {
  const raw = so || se || String(e); try { resolve(JSON.parse(raw)); } catch { resolve({ success: false, raw: raw.slice(0, 400) }); }
}));
const clock = (t = Date.now()) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const RPCS = [...new Set([RPC, 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'])];
const nodes = RPCS.map((u) => new ethers.JsonRpcProvider(u, 56, { staticNetwork: true }));
const provider = nodes[0];
// 读链：限制并发；超时/网络错误换节点重试，合约 revert 直接抛出（那是真实结果）
let active = 0; const waiting = [];
const slot = async () => { if (active >= 6) await new Promise((r) => waiting.push(r)); active++; };
const free = () => { active--; waiting.shift()?.(); };
async function rpc(fn) {
  await slot();
  try {
    let last;
    for (let i = 0; i < nodes.length * 2; i++) {
      try { return await fn(nodes[i % nodes.length]); }
      catch (e) { if (e.code === 'CALL_EXCEPTION' || e.code === 'UNPREDICTABLE_GAS_LIMIT' || /revert/i.test(e.shortMessage || '')) throw e; last = e; }
    }
    throw last;
  } finally { free(); }
}

// 没有公开 ABI 时，按常见函数名盲试（照样只做 value=0 模拟，过了才算）
const FALLBACK = ['function mint()', 'function mint(uint256)', 'function mint(address,uint256)', 'function freeMint()', 'function freeMint(uint256)',
  'function publicMint(uint256)', 'function claim()', 'function claim(uint256)', 'function quickMint()', 'function safeMint(address)'];

async function loadAbi(addr) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, addr.toLowerCase() + '.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  let abi = null;
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/56/${addr}?fields=abi`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) abi = (await r.json()).abi || null;
  } catch { /* 查不到就走盲试 */ }
  const out = { verified: !!abi, abi: abi || FALLBACK };
  if (abi) fs.writeFileSync(f, JSON.stringify(out));
  return out;
}

// 给每个参数填值：uint → 数量，address 看名字（接收人=我，推荐人等=零地址），认不出的函数不试
function argBuilder(fn) {
  const slots = [];
  for (const p of fn.inputs) {
    if (p.type.startsWith('uint')) slots.push((q) => q);
    else if (p.type === 'address') slots.push(() => (/ref|invite|affiliate|promo|sponsor/i.test(p.name) ? ethers.ZeroAddress : ME));
    else return null;
  }
  return (q) => slots.map((s) => s(q));
}
const hasQty = (fn) => fn.inputs.some((p) => p.type.startsWith('uint'));

async function probe(t) {
  const t0 = Date.now();
  const { verified, abi } = await loadAbi(t.addr);
  const iface = new ethers.Interface(abi);
  const fns = iface.fragments.filter((f) => f.type === 'function' && /mint|claim/i.test(f.name) && f.stateMutability !== 'view' && f.stateMutability !== 'pure');
  const cands = [];
  for (const fn of fns) {
    const build = argBuilder(fn); if (!build) continue;
    const qs = hasQty(fn) ? Array.from({ length: MAX }, (_, i) => i + 1) : [1];
    const sims = await Promise.all(qs.map(async (q) => {
      try { await rpc((n) => n.estimateGas({ from: ME, to: t.addr, data: iface.encodeFunctionData(fn, build(q)), value: 0 })); return { q, ok: true }; }
      catch (e) { return { q, ok: false, why: (e.reason || e.shortMessage || e.message || '').replace(/^execution reverted:?\s*/, '').slice(0, 80) || 'revert' }; }
    }));
    let best = 0; for (const s of sims) { if (s.ok) best = s.q; else break; }
    if (best) cands.push({ fn, q: best, data: iface.encodeFunctionData(fn, build(best)) });
    else cands.push({ fn, q: 0, why: sims[0].why });
  }
  const win = cands.filter((c) => c.q).sort((a, b) => b.q - a.q)[0];
  const info = { ...t, verified, probeMs: Date.now() - t0 };
  if (win) return { ...info, fn: win.fn.format('sighash'), qty: win.q, to: t.addr, data: win.data };
  // 免费路径全不通：读一下价格提示，只报告不执行
  const hints = [];
  for (const f of iface.fragments.filter((f) => f.type === 'function' && (f.stateMutability === 'view' || f.stateMutability === 'pure') && f.inputs.length === 0 && /price|cost|fee/i.test(f.name))) {
    try { const v = await rpc((n) => new ethers.Contract(t.addr, iface, n)[f.name]()); if (typeof v === 'bigint') hints.push(`${f.name}=${v > 10n ** 12n ? ethers.formatEther(v) + ' BNB?' : v}`); } catch { /* 忽略 */ }
  }
  return { ...info, skip: cands.length ? '免费路径不通：' + cands.map((c) => `${c.fn.name}(${c.why})`).join('；') : verified ? '没有认得出的 mint 函数' : '无公开 ABI，盲试常见函数也不通', hints };
}

// preview 安全检查：不通过就不执行
function judge(r) {
  if (!r?.success) return 'preview 失败：' + (r?.raw || r?.message || r?.msg || JSON.stringify(r).slice(0, 120));
  const s = r.data?.simulationResult || {}, risks = r.data?.risks || {};
  if (s.simulationCode !== '000000000') return '模拟未通过 ' + s.simulationCode + ' ' + (s.simulationErrorDetail || '');
  if (s.authorityChanges?.length) return '含授权变更';
  if (s.allowanceChanges?.length) return '含额度变更';
  if (risks.riskDetails?.length || risks.riskBehaviors?.length) return '有风险标记 ' + JSON.stringify(risks).slice(0, 160);
  if (Number(s.gasTokenFromData || 0) > 0) return '交易里带了转账/扣费';
  const bad = (s.balanceChanges || []).filter((b) => !(/^Erc(721|1155)$/i.test(b.tokenType) && Number(b.change) > 0));
  if (bad.length) return '有非 NFT 转入的资产变化 ' + JSON.stringify(bad).slice(0, 160);
  if (!(s.balanceChanges || []).length) return '模拟里没有任何 NFT 转入';
  return null;
}

const T721 = ethers.id('Transfer(address,address,uint256)'), T1155 = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
const addrOf = (topic) => ('0x' + topic.slice(26)).toLowerCase();

let ME = opt('--from');
if (!ME) {
  const a = await sh(['wallet', 'address', '--json']);
  ME = a?.data?.addresses?.find((x) => x.binanceChainId === '56' || /^0x/.test(x.address))?.address;
  if (!ME) { console.error('取不到钱包地址（baw 没登录或没连上代理？）：', JSON.stringify(a).slice(0, 200)); process.exit(1); }
}
const startedAt = Date.now();
const bnb0 = await rpc((n) => n.getBalance(ME));
console.log(`钱包 ${ME}  余额 ${ethers.formatEther(bnb0)} BNB  合约 ${targets.length} 个${DRY ? '  【只检查不发交易】' : ''}`);

// 1) 并行：找 ABI + 模拟
const probed = await Promise.all(targets.map(probe));
for (const p of probed) console.log(p.skip ? `  ✗ ${p.name}  跳过：${p.skip}${p.hints?.length ? '  价格提示：' + p.hints.join(' ') : ''}` : `  ✓ ${p.name}  ${p.fn} × ${p.qty}（免费上限）  ${p.verified ? '' : '[盲试]'}  ${p.probeMs}ms`);

// 2) 并行：preview + 安全检查
const ok = probed.filter((p) => !p.skip);
await Promise.all(ok.map(async (p) => {
  const t = Date.now();
  p.preview = await sh(['contract-call', 'preview', '--binanceChainId', '56', '--from', ME, '--to', p.to, '--value', '0', '--inputData', p.data, '--json']);
  p.previewMs = Date.now() - t; p.reject = judge(p.preview);
  if (p.reject) p.skip = 'preview 不放行：' + p.reject;
}));
const go = ok.filter((p) => !p.skip);
for (const p of ok.filter((p) => p.skip)) console.log(`  ✗ ${p.name}  ${p.skip}`);
console.log(`preview 通过 ${go.length}/${ok.length}`);

// 3) 逐笔执行（串行，避免 nonce 冲突）
if (!DRY) for (const p of go) {
  const t = Date.now();
  const r = await sh(['contract-call', 'execute', '--requestId', p.preview.data.requestId, '--json']);
  p.execAt = clock(t); p.execMs = Date.now() - t; p.exec = r?.data;
  p.tx = r?.data?.txHash;
  if (!p.tx) { p.skip = `execute 无 txHash（${r?.data?.status || r?.raw || JSON.stringify(r).slice(0, 120)}）—— 若是待 App 确认，请在币安 App 里确认`; console.log(`  ✗ ${p.name}  ${p.skip}`); }
  else console.log(`  → ${p.name} 已广播 ${p.execAt}  ${p.execMs}ms  ${p.tx}`);
}

// 4) 收回执
const results = [];
for (const p of probed) {
  const row = { name: p.name, contract: p.addr, method: p.fn, qty: p.qty, status: p.skip ? '跳过' : DRY ? '可mint(未执行)' : '', reason: p.skip, hints: p.hints };
  if (!DRY && p.tx) {
    let rc = null; for (let i = 0; i < 60 && !rc; i++) { rc = await rpc((n) => n.getTransactionReceipt(p.tx)).catch(() => null); if (!rc) await new Promise((r) => setTimeout(r, 500)); }
    if (!rc) row.status = '未确认(查链上)';
    else {
      const blk = await rpc((n) => n.getBlock(rc.blockNumber));
      row.status = rc.status === 1 ? '成功' : '失败'; row.tx = p.tx; row.block = rc.blockNumber; row.confirmedAt = clock(blk.timestamp * 1000);
      row.broadcastAt = p.execAt; row.gasBnb = ethers.formatEther(rc.gasUsed * rc.gasPrice);
      row.tokenIds = rc.logs.flatMap((l) => (l.topics[0] === T721 && l.topics.length === 4 && addrOf(l.topics[2]) === ME.toLowerCase() ? [BigInt(l.topics[3]).toString()]
        : l.topics[0] === T1155 && addrOf(l.topics[3]) === ME.toLowerCase() ? [BigInt(l.data.slice(0, 66)).toString()] : []));
    }
  }
  results.push(row);
}

console.log('\n===== 结果 =====');
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name}${r.tokenIds?.length ? '  tokenId ' + r.tokenIds.join(',') : ''}${r.confirmedAt ? `  广播 ${r.broadcastAt} → 上链 ${r.confirmedAt}` : ''}${r.tx ? '\n         ' + r.tx : ''}${r.status === '跳过' ? '  ' + r.reason : ''}`);
const bnb1 = await rpc((n) => n.getBalance(ME));
console.log(`\n总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s  gas 花费 ${ethers.formatEther(bnb0 - bnb1)} BNB  余额 ${ethers.formatEther(bnb1)} BNB`);
fs.mkdirSync(LOGS, { recursive: true });
const logf = path.join(LOGS, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
fs.writeFileSync(logf, JSON.stringify({ wallet: ME, dry: DRY, results }, null, 1));
console.log('记录已存：' + path.relative(ROOT, logf));
