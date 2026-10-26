// 只读：通过公共节点监听 four.meme 主网新币创建（不需要私钥，不发任何交易）。
// 推文要点：大部分操作走链上查询最快，bsc.publicnode.com 提供免费 RPC/WSS。
// 用法：npm run watch:four   （可用 BSC_WSS 换成自己的节点，例如 48 Club / GetBlock）
import { ethers } from 'ethers';

const WSS = process.env.BSC_WSS || 'wss://bsc-rpc.publicnode.com';
// four.meme TokenManager2（BSC 主网）。如官方升级合约，改这里或设置 FOUR_MANAGER。
const MANAGER = process.env.FOUR_MANAGER || '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
const iface = new ethers.Interface([
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)',
]);

const provider = new ethers.WebSocketProvider(WSS);
const { chainId } = await provider.getNetwork();
if (chainId !== 56n) throw new Error(`期望 BSC 主网(56)，实际 ${chainId}`);
console.log(`已连接 ${WSS}，监听 ${MANAGER} 的新币事件…（Ctrl+C 退出）`);

provider.on('block', (n) => process.stdout.write(`\r区块 #${n}  `));
provider.on({ address: MANAGER }, async (log) => {
  const seen = Date.now();
  let parsed = null;
  try { parsed = iface.parseLog(log); } catch { /* 其它事件（买卖等） */ }
  if (!parsed || parsed.name !== 'TokenCreate') return;
  const { token, name, symbol, creator, launchTime } = parsed.args;
  const blk = await provider.getBlock(log.blockNumber);
  const lag = blk ? seen - Number(blk.timestamp) * 1000 : NaN;
  console.log(`\n🆕 ${symbol}（${name}） ${token}  创建者 ${creator}  launchTime=${launchTime}  区块 #${log.blockNumber}  出块→收到 ≈${lag}ms`);
});
