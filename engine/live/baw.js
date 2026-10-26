// 币安 Agentic Wallet CLI（baw）封装：钱包地址、余额、报价、合约调用预演；LIVE_TRADE=1 时才会用到 swap / contract-call execute。本程序不接触私钥。
// execFile 不经过 shell，参数逐个传入，地址都先校验。
import { execFile } from 'node:child_process';
import { ethers } from 'ethers';
import { BAW_BIN, BINANCE_CHAIN_ID, BAW_SLIPPAGE_UNIT, MODE, DRY_RUN } from './config.js';

const READ_ONLY_COMMANDS = new Set([
  'wallet status', 'wallet address', 'wallet balance', 'wallet agent-id',
  'wallet tx-history', 'wallet tx-lock', 'wallet settings',
  'market-order quote', 'market-order list', 'contract-call preview',
  'auth signin', 'auth verify',
]);

export function assertAddress(a, name = 'address') {
  if (!a || !ethers.isAddress(String(a))) throw new Error(`invalid_${name}`);
  return ethers.getAddress(String(a));
}

const slip = (pct) => (BAW_SLIPPAGE_UNIT === 'fraction' ? String(Number(pct) / 100) : String(pct));

let contractExecutionGuard = null;
// Only trusted local code can install a guard; no HTTP route exposes this hook.
export function setContractExecutionGuard(guard) {
  if (guard !== null && typeof guard !== 'function') throw new TypeError('Execution guard must be a function or null');
  contractExecutionGuard = guard;
}

function formatErr(parsed, fallback) {
  const e = parsed?.error;
  return e ? `${e.name || e.code || 'baw_error'}: ${e.message || ''}`.trim() : fallback;
}

export function runBaw(args, { timeoutMs = 90_000 } = {}) {
  // Fail closed at the only CLI invocation point, including claims, rules and approvals.
  if ((DRY_RUN || MODE !== 'live') && !READ_ONLY_COMMANDS.has(args.slice(0, 2).join(' '))) {
    return Promise.reject(Object.assign(new Error('只读模式禁止发送交易、转账或修改授权'), { code: 'READ_ONLY' }));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(BAW_BIN, ['--json', ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      const text = String(stdout || '').trim();
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch { /* 非 JSON */ } }
      if (err) {
        const msg = err.code === 'ENOENT' ? `找不到 baw 命令（npm i -g @binance/agentic-wallet）` : formatErr(parsed, String(stderr || err.message).slice(0, 400));
        return reject(Object.assign(new Error(msg), { baw: parsed }));
      }
      if (!parsed) return reject(new Error(`baw_bad_json: ${text.slice(0, 200) || stderr || 'empty'}`));
      if (parsed.success === false) return reject(Object.assign(new Error(formatErr(parsed, 'baw_failed')), { baw: parsed }));
      resolve(parsed);
    });
    child.on('error', reject);
  });
}

export async function walletStatus() { return (await runBaw(['wallet', 'status'], { timeoutMs: 20_000 })).data?.status || 'UNKNOWN'; }
export async function agentId() { return (await runBaw(['wallet', 'agent-id'], { timeoutMs: 20_000 })).data || {}; }

// 登录：signin 返回 urlForWeb + pairingCode（已登录时 status=ALREADY_CONNECTED）；verify 会阻塞到 App 里确认或 5 分钟超时
export async function authSignin() { return (await runBaw(['auth', 'signin'], { timeoutMs: 30_000 })).data || {}; }
export async function authVerify(qrCodeId) { return (await runBaw(['auth', 'verify', '--qrCodeId', String(qrCodeId)], { timeoutMs: 330_000 })).data || {}; }

// 钱包是否被锁：有一笔交易在等币安 App 确认时是 LOCKED，这时任何新交易都会被拒
export async function walletLock() { return (await runBaw(['wallet', 'tx-lock', '--binanceChainId', String(BINANCE_CHAIN_ID)], { timeoutMs: 20_000 })).data?.status || 'UNKNOWN'; }

export async function walletAddresses() { return (await runBaw(['wallet', 'address'], { timeoutMs: 20_000 })).data?.addresses || []; }

export async function walletBalance({ tokenAddress } = {}) {
  const args = ['wallet', 'balance', '--binanceChainId', String(BINANCE_CHAIN_ID), '--hideLowValue', 'false'];
  if (tokenAddress) args.push('--tokenAddress', assertAddress(tokenAddress, 'tokenAddress'));
  const res = await runBaw(args, { timeoutMs: 30_000 });
  return Array.isArray(res.data) ? res.data : [];
}

export async function marketQuote({ fromTokenQty, fromToken, toToken, slippage }) {
  const args = ['market-order', 'quote', '--fromTokenQty', String(fromTokenQty), '--fromToken', assertAddress(fromToken, 'fromToken'),
    '--toToken', assertAddress(toToken, 'toToken'), '--binanceChainId', String(BINANCE_CHAIN_ID)];
  if (slippage != null) args.push('--slippage', slip(slippage));
  return (await runBaw(args, { timeoutMs: 45_000 })).data;
}

// contract-call 预演（模拟 + 风控检查），不执行。需要先在 baw wallet settings 打开 devMode。
export async function contractPreview({ from, to, valueWei = '0', inputData }) {
  const pre = (await runBaw(['contract-call', 'preview', '--binanceChainId', String(BINANCE_CHAIN_ID), '--from', assertAddress(from, 'from'),
    '--to', assertAddress(to, 'to'), '--value', String(valueWei), '--inputData', String(inputData)], { timeoutMs: 45_000 })).data || {};
  const riskDetails = pre.risks?.riskDetails || [];
  return { dryRun: true, requestId: pre.requestId, simulation: pre.simulationResult?.simulationCode, risks: riskDetails.length,
    riskTitles: riskDetails.map((r) => r.title).filter(Boolean), requireConfirmation: !!pre.requireConfirmation,
    parsedTx: pre.parsedTx, simulationResult: pre.simulationResult, riskDetails };
}

// 真实执行：先 preview，再用 requestId execute。返回 BROADCASTED（带 txHash）或 PENDING_CONFIRMATION（需在币安 App 里确认）。
export async function contractCall({ from, to, valueWei = '0', inputData }) {
  const pre = await contractPreview({ from, to, valueWei, inputData });
  if (!pre.requestId) throw new Error('baw 预演没有返回 requestId（可能被风控拦截）');
  if (contractExecutionGuard) await contractExecutionGuard({ from, to, valueWei: String(valueWei), inputData, preview: pre });
  // execute 之后结果不确定（超时 / 断网）时不能当失败：交易可能已经发出去了
  let ex;
  try { ex = (await runBaw(['contract-call', 'execute', '--requestId', String(pre.requestId)], { timeoutMs: 150_000 })).data || {}; }
  catch (e) { if (/timeout|timed out|ETIMEDOUT|killed|SIGTERM|ECONNRESET|fetch failed|network/i.test(e.message)) throw Object.assign(new Error('已提交执行，但没等到结果（可能已经上链）'), { code: 'UNKNOWN_SUBMIT' }); throw e; }
  return { ...pre, dryRun: false, orderId: ex.orderId, status: ex.status, txHash: ex.txHash || null, message: ex.message || null };
}

export async function marketSwap({ fromTokenQty, fromToken, toToken, slippage, mev = false, gasLevel = 'HIGH' }) {
  const args = ['market-order', 'swap', '--fromTokenQty', String(fromTokenQty), '--fromToken', assertAddress(fromToken, 'fromToken'),
    '--toToken', assertAddress(toToken, 'toToken'), '--binanceChainId', String(BINANCE_CHAIN_ID), '--mev', mev ? 'true' : 'false', '--gasLevel', gasLevel];
  if (slippage != null) args.push('--slippage', slip(slippage));
  return (await runBaw(args, { timeoutMs: 90_000 })).data || {};
}

export async function marketOrder(orderId) {
  return (await runBaw(['market-order', 'list', '--orderId', String(orderId)], { timeoutMs: 30_000 })).data?.list?.[0] || null;
}

// orderId 只表示已提交，必须轮询到 FINISHED / FAILED 才算有结果
export async function pollOrder(orderId, { maxMs = 60_000, intervalMs = 250 } = {}) {
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < maxMs) {
    last = await marketOrder(orderId).catch(() => last);
    if (last?.status === 'FINISHED' || last?.status === 'FAILED') return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

// 代币转账：baw wallet send --max（转出全部余额）
export async function sendMax({ tokenAddress, recipient, gasLevel = 'MEDIUM' }) {
  const args = ['wallet', 'send', '--binanceChainId', String(BINANCE_CHAIN_ID), '--max', '--tokenAddress', assertAddress(tokenAddress, 'tokenAddress'), '--recipient', assertAddress(recipient, 'recipient'), '--gasLevel', gasLevel];
  return (await runBaw(args, { timeoutMs: 90_000 })).data || {};
}
