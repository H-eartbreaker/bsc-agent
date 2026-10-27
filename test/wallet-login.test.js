import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletLogin } from '../engine/live/walletLogin.js';
import { LiveTrader } from '../engine/live/liveTrader.js';

const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  let time = 1000, connected = false, timer, codes = 0, verifyCalls = 0;
  const verification = deferred();
  const code = { urlForWeb: 'https://web3.binance.com/en/agent-login?test=fixture', pairingCode: '001234', qrCodeId: 'internal-fixture', expireAt: '301000' };
  const flow = new WalletLogin({ signin: async () => { codes++; return { ...code }; }, verify: async (id, { signal }) => {
    assert.equal(id, code.qrCodeId); verifyCalls++;
    signal.addEventListener('abort', () => verification.reject(new Error('aborted')));
    return verification.promise;
  }, connected: () => connected, refresh: async () => { connected = true; }, now: () => time,
  setTimer: (cb) => { timer = cb; return cb; }, clearTimer: () => {}, ...overrides });
  return { flow, verification, code, counts: () => [codes, verifyCalls], expire: () => { time = 301001; timer(); }, connect: () => { connected = true; } };
}

test('duplicate requests reuse one sign-in and private QR id never reaches public state', async () => {
  const f = fixture();
  const [one, two] = await Promise.all([f.flow.start(), f.flow.start()]);
  assert.deepEqual(one, two); assert.deepEqual(f.counts(), [1, 1]);
  assert.equal(one.pairingCode, '001234'); assert.equal(one.urlForWeb, f.code.urlForWeb);
  assert.equal(JSON.stringify(one).includes('internal-fixture'), false);
  await f.flow.start(); assert.deepEqual(f.counts(), [1, 1]);
  f.verification.resolve({ status: 'SUCCESS' }); await f.flow.verifying;
  assert.equal(f.flow.view().state, 'done'); assert.equal(f.flow.view().urlForWeb, undefined);
});

test('verify success without wallet connection cannot unlock login', async () => {
  const f = fixture({ refresh: async () => {} }); await f.flow.start();
  f.verification.resolve({ status: 'SUCCESS' }); await f.flow.verifying;
  assert.equal(f.flow.view().state, 'failed');
});

test('expiry aborts only the expired verification and late success cannot overwrite a retry', async () => {
  const checks = [], timers = [];
  let now = 1000;
  const flow = new WalletLogin({ signin: async () => ({ urlForWeb: 'https://web3.binance.com/en/agent-login', pairingCode: '000001', qrCodeId: `id${checks.length}`, expireAt: now + 300000 }),
    verify: (_id, { signal }) => { const d = deferred(); checks.push({ ...d, signal }); return d.promise; },
    connected: () => false, refresh: async () => {}, now: () => now, setTimer: cb => { timers.push(cb); return cb; }, clearTimer: () => {} });
  await flow.start(); const old = flow.verifying;
  now += 300001; timers[0]();
  assert.equal(flow.view().state, 'expired'); assert.equal(checks[0].signal.aborted, true);
  assert.equal(flow.view().urlForWeb, undefined);
  await flow.start(); assert.equal(checks.length, 2);
  checks[0].resolve({ status: 'SUCCESS' }); await old;
  assert.equal(flow.view().state, 'waiting'); assert.equal(checks[1].signal.aborted, false);
  checks[1].reject(new Error('network')); await flow.verifying;
  assert.equal(flow.view().state, 'failed');
});

test('invalid links never reach verify and errors do not echo CLI secrets', async () => {
  for (const urlForWeb of ['javascript:alert(1)', 'https://web3.binance.com.evil.test/', 'https://user:password@web3.binance.com/', 'https://web3.binance.com:444/']) {
    const f = fixture({ signin: async () => ({ urlForWeb, qrCodeId: 'fixture', pairingCode: '000001' }), verify: () => assert.fail('invalid URL verified') });
    assert.equal((await f.flow.start()).state, 'failed');
  }
  const f = fixture({ signin: async () => { throw new Error('sessionToken=fixture-secret'); } });
  assert.equal(JSON.stringify(await f.flow.start()).includes('fixture-secret'), false);
});

test('already-connected CLI still requires status confirmation; connected wallets cannot replace sessions', async () => {
  const f = fixture({ signin: async () => ({ status: 'ALREADY_CONNECTED' }), refresh: async () => {} });
  assert.equal((await f.flow.start()).state, 'failed');
  f.connect(); await assert.rejects(f.flow.start(), /已经登录/);
});

function traderFixture() {
  let st = 'UNCONNECTED', address = '0x1111111111111111111111111111111111111111', reads = 0, balances = 0;
  const trader = Object.create(LiveTrader.prototype);
  Object.assign(trader, { status: { connected: false, auth: { state: 'logged_out' } }, wallets: [], expectedWallet: '', market: {},
    authApi: { walletStatus: async () => { reads++; return st; }, walletAddresses: async () => [{ binanceChainId: 56, address }], agentId: async () => ({ claimed: false }) },
    refreshBalance: async () => { balances++; } });
  return { trader, connect: () => { st = 'CONNECTED'; }, disconnect: () => { st = 'UNCONNECTED'; }, wrongAccount: () => { address = '0x2222222222222222222222222222222222222222'; }, counts: () => [reads, balances] };
}

test('external login restores an initially missing wallet without restarting timers', async () => {
  const f = traderFixture(); await f.trader.checkAuth(); assert.equal(f.trader.wallets.length, 0);
  f.connect(); await Promise.all([f.trader.checkAuth(), f.trader.checkAuth()]);
  assert.equal(f.trader.status.auth.state, 'ok'); assert.equal(f.trader.status.connected, true);
  assert.equal(f.trader.wallets[0].address, '0x1111111111111111111111111111111111111111');
  assert.deepEqual(f.counts(), [2, 1]);
  f.disconnect(); await f.trader.checkAuth();
  assert.equal(f.trader.status.connected, false); assert.equal(f.trader.status.auth.address, null); assert.equal(f.trader.wallets.length, 0);
  f.connect(); await f.trader.checkAuth(); assert.equal(f.trader.wallets.length, 1);
});

test('changing accounts fails closed and clears the old wallet instead of reusing its holdings', async () => {
  const f = traderFixture(); f.connect(); await f.trader.checkAuth(); f.wrongAccount(); await f.trader.checkAuth();
  assert.equal(f.trader.status.auth.state, 'wrong_account'); assert.equal(f.trader.status.connected, false);
  assert.equal(f.trader.wallets.length, 0); assert.equal(f.trader.status.auth.address, null);
  await f.trader.checkAuth(); assert.equal(f.trader.status.auth.state, 'wrong_account');
  assert.equal(f.counts()[1], 1);
});
