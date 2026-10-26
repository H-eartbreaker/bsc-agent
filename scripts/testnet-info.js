// BSC 测试网（chainId 97）执行器自检：生成/读取一次性测试钱包并显示余额。
// 用法：npm run testnet:info
// 买卖：node scripts/testnet-info.js buy <代币地址> 0.01   |   node scripts/testnet-info.js sell <代币地址> 50
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestnetTrader } from '../engine/chain.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const t = new TestnetTrader(dir);
const [cmd, token, amount] = process.argv.slice(2);
console.log(await t.info());
if (cmd === 'buy' || cmd === 'sell') {
  console.log(await t.token(token));
  console.log(await t.execute({ token, side: cmd, amount: Number(amount), slippage: 15, gasGwei: 3 }));
}
