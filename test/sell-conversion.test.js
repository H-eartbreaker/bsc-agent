import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ethers } from 'ethers';

const wallet = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const quote = '0x3333333333333333333333333333333333333333';
const venue = '0x4444444444444444444444444444444444444444';
const sellTx = '0x' + 'a'.repeat(64), swapTx = '0x' + 'b'.repeat(64);
const pIface = new ethers.Interface(['function sellAll(address,uint256) returns(uint256)', 'function sell(address,uint256,uint256,uint256) returns(uint256,uint256)']);
const pad = new ethers.Interface(['function sell(address,uint256,uint256)']);

function fixture(platform, scenario) {
  const submissions = [], polls = [];
  const baw = {
    async marketSwap(args) {
      submissions.push(args);
      if (scenario === 'submit-unknown') throw new Error('Submission timed out');
      return scenario === 'missing-id' ? {} : { orderId: 'original-order' };
    },
    async pollOrder(id) {
      polls.push(id);
      if (scenario === 'poll-unknown') throw new Error('History temporarily unavailable');
      if (scenario === 'finished') return { status: 'FINISHED', txHash: swapTx, toTokenActualQty: '0.000009' };
      return { status: scenario === 'failed' ? 'FAILED' : 'PENDING' };
    },
  };
  const source = readFileSync(new URL(platform === 'flap' ? '../engine/live/portal.js' : '../engine/live/gangV2Pads.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async sell('), end = source.indexOf('\n  }\n}', start) + 4;
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({
    ethers: { ...ethers, Contract: class { async decimals() { return 18; } async balanceOf() { return 90n * 10n ** 18n; } } },
    baw, pIface, pad, PORTAL: venue, BNB_NATIVE: ethers.ZeroAddress,
    ERC20_ABI: [], isBnbQuote: () => false, isWbnb: () => false,
    minOut: (v) => v * 97n / 100n,
  });
  const target = vm.runInContext('({' + source.slice(start, end) + '})', context);
  let balanceReads = 0;
  Object.assign(target, {
    provider: { call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [10n ** 18n]) },
    sharesOf: async () => 10n ** 18n, minShares: v => v * 97n / 100n,
    received: async () => 10n ** 18n,
    send: async () => sellTx,
    curve: async () => ({ pad: venue, c: {} }), quoteToken: () => quote,
    balanceOf: async (address) => address === token ? 10n ** 18n : (++balanceReads === 1 ? 90n : 91n) * 10n ** 18n,
    ensureAllowance: async () => null, sellQuote: () => ({ out: 10n ** 18n }), decimals: async () => 18,
  });
  return { submissions, polls, run: toBnb => target.sell({ wallet, token, market: venue, quoteAddress: quote, quoteSym: 'Q', pct: 100, slippage: 3, step() {}, toBnb }) };
}

for (const platform of ['flap', 'gang']) {
  for (const scenario of ['submit-unknown', 'missing-id', 'poll-unknown', 'pending', 'failed']) {
    test(`${platform}: ${scenario} stops conversion without resubmitting`, async () => {
      const f = fixture(platform, scenario), r = await f.run(true);
      assert.equal(f.submissions.length, 1);
      assert.equal(f.submissions[0].fromTokenQty, '1.0'); // Only newly received quote tokens, not the prior 90.
      assert.equal(f.submissions[0].slippage, 3);
      assert.equal(r.expected, null); assert.match(r.note, /勿重复提交/);
      assert.equal(r.conversion.orderId, ['submit-unknown', 'missing-id'].includes(scenario) ? null : 'original-order');
      assert.equal(f.polls.length, ['submit-unknown', 'missing-id'].includes(scenario) ? 0 : 1);
    });
  }
  test(`${platform}: confirmed conversion includes the final transaction and BNB output`, async () => {
    const f = fixture(platform, 'finished'), r = await f.run(true);
    assert.equal(f.submissions.length, 1); assert.equal(r.txHash, swapTx); assert.equal(r.expected, 0.000009);
  });
  test(`${platform}: conversion disabled leaves quote tokens and never submits a swap`, async () => {
    const f = fixture(platform, 'finished'), r = await f.run(false);
    assert.equal(f.submissions.length, 0); assert.equal(r.txHash, sellTx); assert.equal(r.expected, null);
  });
}
