// BSC 测试网执行器（chainId 97）：PancakeSwap V2 Router 直接 swap。
// 只允许测试网；私钥是本地生成的一次性测试钱包，存放在 data/testnet-wallet.json，不会发送到任何地方。
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';

const RPC = process.env.BSC_TESTNET_RPC || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';
const ROUTER = '0xD99D1c33F9fC3444f8101754aBC46c52416550D1';
const WBNB = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function allowance(address,address) view returns (uint)', 'function approve(address,uint) returns (bool)',
];

export class TestnetTrader {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'testnet-wallet.json');
    this.provider = new ethers.JsonRpcProvider(RPC, 97, { staticNetwork: true });
    let pk;
    if (fs.existsSync(this.file)) pk = JSON.parse(fs.readFileSync(this.file, 'utf8')).privateKey;
    else {
      pk = ethers.Wallet.createRandom().privateKey;
      fs.writeFileSync(this.file, JSON.stringify({ note: '仅限 BSC 测试网的一次性钱包，切勿转入主网资产', privateKey: pk }, null, 2), { mode: 0o600 });
    }
    this.wallet = new ethers.Wallet(pk, this.provider);
    this.router = new ethers.Contract(ROUTER, ROUTER_ABI, this.wallet);
  }

  async assertTestnet() {
    const { chainId } = await this.provider.getNetwork();
    if (chainId !== 97n) throw new Error(`RPC chainId=${chainId}，只允许 BSC 测试网(97)`);
  }

  async info() {
    await this.assertTestnet();
    const bal = await this.provider.getBalance(this.wallet.address);
    return { address: this.wallet.address, bnb: Number(ethers.formatEther(bal)), rpc: RPC, faucet: 'https://www.bnbchain.org/en/testnet-faucet' };
  }

  async token(address) {
    const c = new ethers.Contract(address, ERC20_ABI, this.provider);
    const [symbol, decimals, bal] = await Promise.all([c.symbol(), c.decimals(), c.balanceOf(this.wallet.address)]);
    let priceBnb = null;
    try {
      const amounts = await this.router.getAmountsOut(10n ** BigInt(decimals), [address, WBNB]);
      priceBnb = Number(ethers.formatEther(amounts[1]));
    } catch { /* 无池子 */ }
    return { address, symbol, decimals: Number(decimals), balance: Number(ethers.formatUnits(bal, decimals)), priceBnb };
  }

  async execute({ token, side, amount, slippage = 10, gasGwei = 3 }) {
    await this.assertTestnet();
    const gasPrice = ethers.parseUnits(String(gasGwei), 'gwei');
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const started = Date.now();
    const slipBps = BigInt(Math.round((100 - slippage) * 100));
    if (side === 'buy') {
      const value = ethers.parseEther(String(amount));
      const amounts = await this.router.getAmountsOut(value, [WBNB, token]);
      const minOut = (amounts[1] * slipBps) / 10000n;
      const tx = await this.router.swapExactETHForTokensSupportingFeeOnTransferTokens(minOut, [WBNB, token], this.wallet.address, deadline, { value, gasPrice });
      const rc = await tx.wait();
      return { status: rc.status === 1 ? 'filled' : 'failed', tx: tx.hash, latencyMs: Date.now() - started };
    }
    const erc = new ethers.Contract(token, ERC20_ABI, this.wallet);
    const bal = await erc.balanceOf(this.wallet.address);
    const amountIn = (bal * BigInt(Math.round(Number(amount) * 100))) / 10000n;
    if (amountIn === 0n) throw new Error('没有可卖出的余额');
    if ((await erc.allowance(this.wallet.address, ROUTER)) < amountIn) await (await erc.approve(ROUTER, ethers.MaxUint256, { gasPrice })).wait();
    const amounts = await this.router.getAmountsOut(amountIn, [token, WBNB]);
    const minOut = (amounts[1] * slipBps) / 10000n;
    const tx = await this.router.swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, minOut, [token, WBNB], this.wallet.address, deadline, { gasPrice });
    const rc = await tx.wait();
    return { status: rc.status === 1 ? 'filled' : 'failed', tx: tx.hash, latencyMs: Date.now() - started };
  }
}
