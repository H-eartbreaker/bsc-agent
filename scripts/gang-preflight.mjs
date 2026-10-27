// Gang readiness check. Read-only: no order, swap, approval, transfer or contract execution.
import { ethers } from 'ethers';
import * as baw from '../engine/live/baw.js';
import { BNB_NATIVE, BINANCE_CHAIN_ID } from '../engine/live/config.js';

const checks = [];
const add = (name, ok, detail, required = true) => checks.push({ name, ok: !!ok, required, detail: String(detail || '') });
const safe = async (name, fn, required = true) => {
  try { return await fn(); } catch (e) { add(name, false, e.message, required); return null; }
};
const findKey = (value, names) => {
  const wanted = new Set(names.map((x) => x.toLowerCase()));
  const visit = (v) => {
    if (!v || typeof v !== 'object') return undefined;
    for (const [k, x] of Object.entries(v)) {
      if (wanted.has(k.toLowerCase())) return x;
      const nested = visit(x); if (nested !== undefined) return nested;
    }
    return undefined;
  };
  return visit(value);
};
const boolValue = (v) => v === true || v === 1 || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'enabled';

const status = await safe('钱包连接', () => baw.walletStatus());
add('钱包连接', status === 'CONNECTED', status || '无法读取');

const addresses = await safe('BSC 地址', () => baw.walletAddresses());
const bsc = addresses?.find((x) => String(x.binanceChainId) === String(BINANCE_CHAIN_ID));
add('BSC 地址', !!bsc?.address, bsc?.address ? '已读取 BSC 地址' : '没有 BSC 地址');

const agent = await safe('Agent ID', () => baw.agentId());
const agentClaimed = boolValue(agent?.claimed) || !!agent?.agentId || !!agent?.name;
add('Agent ID', agentClaimed, agentClaimed ? '已绑定 Agent ID' : '未发现已绑定 Agent ID');

const settings = await safe('钱包设置', async () => (await baw.runBaw(['wallet', 'settings'], { timeoutMs: 30_000 })).data || {});
const dev = findKey(settings, ['devMode', 'developerMode']);
const devEnabled = typeof dev === 'object' ? boolValue(dev.enabled) || boolValue(dev.active) : boolValue(dev);
const devExpiry = typeof dev === 'object' ? Date.parse(dev.expiresAt || dev.expireAt || '') : NaN;
add('Developer Mode', devEnabled && (!Number.isFinite(devExpiry) || devExpiry > Date.now()), devEnabled ? (Number.isFinite(devExpiry) ? `有效至 ${new Date(devExpiry).toISOString()}` : '已开启') : '未开启或已过期');

const allTokens = findKey(settings, ['tradeAllTokens', 'allTokens', 'tradeAll']);
add('Trade all tokens', boolValue(allTokens), allTokens === undefined ? '设置接口未返回该字段' : boolValue(allTokens) ? '已开启' : '未开启');

const balances = await safe('BNB 余额', () => baw.walletBalance());
const native = balances?.find((x) => String(x.address || '').toLowerCase() === BNB_NATIVE.toLowerCase()) || balances?.find((x) => String(x.symbol || '').toUpperCase() === 'BNB');
const bnb = Number(native?.balance);
add('BNB gas', Number.isFinite(bnb) && bnb > 0, Number.isFinite(bnb) ? `${bnb} BNB` : '无法读取余额');

const requiredOk = checks.filter((x) => x.required).every((x) => x.ok);
const result = { command: 'gang preflight', readOnly: true, canGoGang: requiredOk, checks, next: requiredOk ? '可以进入只读报价；下单仍需逐笔预览并由本人在 App 确认' : '先补齐失败项目，再运行一次 preflight' };
console.log(JSON.stringify(result, null, 2));
process.exitCode = requiredOk ? 0 : 1;
