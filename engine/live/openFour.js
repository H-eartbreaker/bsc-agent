// four.meme Agentic Wallet 专属内盘（OpenFour，内盘阶段）买卖：按 binance-agentic-wallet 技能的官方流程，
// 用技能自带脚本 agent-id-exclusive-token-launches.mjs 报价并生成交易（info / quote-buy / quote-sell），再由 baw contract-call 执行。
// 内盘阶段 baw market-order 会被拒（"only Agentic Wallet with a Agent ID can trade this token"），已迁移的盘才走 market-order。
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { env } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = [
  env('OPENFOUR_SCRIPT', ''),
  path.join(here, '../../.agents/skills/binance-agentic-wallet/scripts/agent-id-exclusive-token-launches.mjs'),
  path.join(os.homedir(), '.claude/skills/binance-agentic-wallet/scripts/agent-id-exclusive-token-launches.mjs'),
].find((p) => p && existsSync(p));

function run(cmd, args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    if (!SCRIPT) return reject(new Error('找不到 agent-id-exclusive-token-launches.mjs（npx skills add binance/binance-skills-hub --skill binance-agentic-wallet）'));
    execFile(process.execPath, [SCRIPT, cmd, JSON.stringify(args)], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      let j = null; try { j = JSON.parse(String(stdout || '')); } catch { /* 非 JSON */ }
      if (!j) return reject(new Error(err ? err.message : 'openfour 脚本没有返回 JSON'));
      if (j.success === false) { const e = j.error || {}; return reject(new Error(`${e.code || 'ERROR'}: ${e.message || ''}${e.diagnosis ? `（${e.diagnosis}）` : ''}`.trim())); }
      resolve(j.data);
    });
  });
}

export const info = (token, wallet) => run('info', { token, wallet });
// payToken：不传 = 用 BNB 付（非 WBNB 计价币盘由 Core 的 ZapRouter 在同一笔里换成计价币）；传计价币地址 = 直接用钱包里的计价币付，amount 按计价币算
export const quoteBuy = (token, wallet, amount, slippageBps, payToken = null) => run('quote-buy', { token, wallet, amount: String(amount), slippageBps, ...(payToken ? { payToken } : {}) });
export const quoteSell = (token, wallet, amount, slippageBps) => run('quote-sell', { token, wallet, amount: String(amount), slippageBps });

// 模拟失败 / 余额不够时给出明确原因，不发交易
export function checkQuote(q) {
  if (q.simulation && q.simulation.ok === false) throw new Error(`预演失败：${q.simulation.error?.reason || q.simulation.error?.message || '交易会回滚'}`);
  if (q.pay && q.pay.sufficient === false) throw new Error(`BNB 余额不足（需要 ${q.pay.maxPay}，有 ${q.pay.balance}）`);
  return q;
}
