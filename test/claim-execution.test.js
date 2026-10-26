import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

// Exercise live-mode branches using mocked contract sends, never a real CLI.
process.env.MODE = 'live';
process.env.LIVE_TRADE = '1';
process.env.AUTO_TRANSFER_TO = '';
process.env.BAW_BIN = '/__bsc_agent_test_no_wallet_cli__';
const { LiveTrader } = await import('../engine/live/liveTrader.js');
const token = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const spender = '0x3333333333333333333333333333333333333333';
const tx = `0x${'1'.repeat(64)}`;

function fixture() {
  const trader = Object.create(LiveTrader.prototype), sends = [];
  const asset = { address: token, market: spender, platform: 'flap', symbol: 'FIX', stage: 'dex', source: 'agent-curve' };
  Object.assign(trader, {
    wallets: [{ id: 'baw', address: owner, label: 'fixture' }],
    status: { auth: { state: 'ok' } }, settings: { autoClaim: true, autoSendAfterClaim: false, sellToBnb: false },
    market: { list: () => [asset], get: () => asset },
    claimable: [], claimRetry: new Map(), claiming: new Set(), orders: [], emit() {},
    portal: {
      sharesOf: async () => 1000000000000000000n,
      claim: async (args) => { sends.push(args); return { venue: 'fixture', expected: 100, txHash: tx, hashes: [tx] }; },
      send: async (args) => { sends.push(args); return tx; },
    },
    lockStatus: async () => 'UNLOCKED',
  });
  return { trader, sends, asset };
}

test('automatic claim only selects migrated Flap markets with positive shares', async () => {
  const f = fixture(); const requests = [];
  f.trader.market.list = () => [f.asset, { ...f.asset, market: owner, stage: 'curve' }, { ...f.asset, market: token, source: 'four' }];
  f.trader.claimOne = async (market, source) => requests.push({ market, source });
  await f.trader.scanClaims();
  assert.equal(requests.length, 1); assert.equal(requests[0].market, spender); assert.equal(requests[0].source, '自动领取');
  f.trader.portal.sharesOf = async () => 0n;
  await f.trader.scanClaims(); assert.equal(requests.length, 1); assert.equal(f.trader.claimable.length, 0);
});

test('auto claim respects disabled settings, logout, in-flight claims and retry backoff', async () => {
  for (const guard of ['off', 'logout', 'inflight', 'backoff']) {
    const f = fixture(); let attempts = 0; f.trader.claimOne = async () => attempts++;
    if (guard === 'off') f.trader.settings.autoClaim = false;
    if (guard === 'logout') f.trader.status.auth.state = 'logged_out';
    if (guard === 'inflight') f.trader.claiming.add(spender);
    if (guard === 'backoff') f.trader.claimRetry.set(spender, { next: Date.now() + 60_000 });
    await f.trader.scanClaims(); assert.equal(attempts, 0, guard);
  }
});

test('successful claim clears pending shares and retries; failed claim backs off', async () => {
  const f = fixture(); f.trader.claimable = [{ market: spender }];
  f.trader.claimRetry.set(spender, { wait: 60_000 });
  const result = await f.trader.claimOne(spender, '自动领取');
  assert.equal(result.status, 'filled'); assert.equal(result.tx, tx); assert.equal(f.sends.length, 1);
  assert.equal(f.trader.claimable.length, 0); assert.equal(f.trader.claimRetry.has(spender), false);
  f.trader.portal.claim = async () => { throw new Error('fixture rejected'); };
  const failure = await f.trader.claimOne(spender, '自动领取');
  assert.equal(failure.status, 'failed'); assert.equal(f.trader.claiming.has(spender), false);
  assert.ok(f.trader.claimRetry.get(spender).next > Date.now());
});

for (const platform of ['gang-v2', 'flap']) {
  test(`${platform}: sell-to-BNB toggle reaches the sell contract route`, async () => {
    for (const enabled of [false, true]) {
      const f = fixture(); let received;
      const sell = async (args) => { received = args; return { expected: 0.00001, txHash: tx, hashes: [tx] }; };
      f.trader.gangV2 = { sell }; f.trader.portal.sell = sell;
      f.trader.useGangV2 = () => platform === 'gang-v2'; f.trader.useGang = () => false;
      f.trader.useOpenFour = () => false; f.trader.usePortal = () => platform === 'flap';
      f.trader.pos = () => ({ soldBnb: 0, amount: 100 }); f.trader.quoteCache = new Map(); f.trader.refreshBalance = async () => {};
      f.trader.settings.sellToBnb = enabled;
      const result = await f.trader.executeReal({ side: 'sell', amount: 100, slippage: 1, ts: Date.now() }, f.asset, f.trader.wallets[0], () => {});
      assert.equal(result.status, 'filled'); assert.equal(received.toBnb, enabled); assert.equal(received.pct, 100);
    }
  });
}

test('revocation sends approve(spender, 0) and does not grant a new allowance', async () => {
  const f = fixture(); const result = await f.trader.revokeApproval(token, spender);
  assert.equal(result.status, 'filled'); assert.equal(f.sends.length, 1);
  const i = new ethers.Interface(['function approve(address,uint256)']);
  const args = i.decodeFunctionData('approve', f.sends[0].inputData);
  assert.equal(args[0].toLowerCase(), spender); assert.equal(args[1], 0n);
});

test('revocation refuses an invalid address, logout or an App-locked wallet', async () => {
  for (const guard of ['address', 'logout', 'locked']) {
    const f = fixture();
    if (guard === 'logout') f.trader.status.auth.state = 'logged_out';
    if (guard === 'locked') f.trader.lockStatus = async () => 'LOCKED';
    await assert.rejects(f.trader.revokeApproval(guard === 'address' ? 'invalid' : token, spender));
    assert.equal(f.sends.length, 0, guard);
  }
});
