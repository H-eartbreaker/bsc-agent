import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ethers } from 'ethers';
import { Agent } from '../engine/agent.js';
import { Blocklist } from '../engine/blocklist.js';
import { capFor, setApprovalCtx, sendApproval } from '../engine/live/approvals.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const token = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';

function strategy(t, platform = 'gang') {
  const market = new EventEmitter();
  market.get = () => ({ address: token, platform });
  market.fetchBuyFeePct = async () => 1;
  const calls = [], quotes = [];
  const trader = {
    status: { dryRun: false }, settings: {},
    wallet: () => ({ label: 'fixture', bnb: 1 }),
    eligibility: () => ({ ok: true }), positionsView: () => [],
    execute: async (order) => { calls.push(order); return { ...order, status: 'filled', amountIn: order.amount, latencyMs: 1 }; },
  };
  const agent = new Agent(market, trader, { live: true, quoteBuy: async (q) => { quotes.push(q); return { bnb: 0.01 }; } });
  clearInterval(agent.timer); t.after(() => clearInterval(agent.timer));
  agent.setConfig({ [platform]: { enabled: true, mode: 'fixed', maxPerTrade: 0.01, dailyBudget: 0.1 } });
  const launch = () => agent.onLaunch({ address: token, platform, name: 'fixture', symbol: 'FIX', quote: 'BNB', createdAt: Date.now() });
  return { agent, market, trader, calls, quotes, launch, config: agent.config[platform] };
}

for (const platform of ['flap', 'four', 'gang']) {
  for (const mode of ['fixed', 'pct', 'fill']) {
    test(`${platform}: ${mode} sizing reaches the automatic order path with the selected wallet`, async (t) => {
      const f = strategy(t, platform); f.config.mode = mode; f.config.pctOfSupply = 0.3;
      await f.launch();
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].walletId, 'baw');
      assert.equal(f.calls[0].source, '自动狙击');
      assert.equal(f.calls[0].amount, 0.01);
      if (mode === 'fixed') assert.equal(f.quotes.length, 0);
      else assert.equal(f.quotes[0].pct, mode === 'fill' ? 1 : 0.3);
    });
  }
}

test('hourly limit, daily budget, reserve and eligibility each prevent an automatic request', async (t) => {
  for (const kind of ['hour', 'day', 'reserve', 'eligibility', 'block', 'quote']) {
    const f = strategy(t);
    if (kind === 'hour') { f.config.hourlyMax = 1; f.agent.usage('gang', 'baw').times = [Date.now()]; }
    if (kind === 'day') f.agent.usage('gang', 'baw').bnb = f.config.dailyBudget;
    if (kind === 'reserve') f.config.minReserve = 1;
    if (kind === 'eligibility') f.trader.eligibility = () => ({ ok: false, reason: 'not eligible' });
    if (kind === 'block') f.agent.isBlocked = () => true;
    if (kind === 'quote') { f.config.quote = 'bnb'; await f.agent.onLaunch({ address: token, platform: 'gang', name: 'fixture', symbol: 'FIX', quote: 'GANG' }); }
    else await f.launch();
    assert.equal(f.calls.length, 0, kind);
    assert.equal(f.agent.records[0].status, 'skip', kind);
  }
});

test('keyword inclusion, excluded words and disabling a platform stop entries', async (t) => {
  for (const patch of [{ include: 'missing' }, { exclude: 'fixture' }, { enabled: false }]) {
    const f = strategy(t); Object.assign(f.config, patch); await f.launch(); assert.equal(f.calls.length, 0);
  }
});

test('anti-sniping waits for acceptable fees and times out for unknown fees', async (t) => {
  const f = strategy(t, 'four');
  f.config.antiSnipe = { enabled: true, maxFeePct: 5, maxWaitSec: 1, pollMs: 1 };
  const fees = [20, null, 2]; f.market.fetchBuyFeePct = async () => fees.length ? fees.shift() : 2;
  await f.launch(); assert.equal(f.calls.length, 1); assert.equal(fees.length, 0);
  const blocked = strategy(t, 'four');
  blocked.config.antiSnipe = { enabled: true, maxFeePct: 5, maxWaitSec: 0, pollMs: 1 };
  blocked.market.fetchBuyFeePct = async () => null;
  await blocked.launch(); assert.equal(blocked.calls.length, 0); assert.match(blocked.agent.records[0].msg, /放弃/);
});

test('pausing while an entry is waiting stops the order', async (t) => {
  const f = strategy(t); f.config.delaySec = 0.01;
  const task = f.launch(); f.agent.setConfig({ paused: true }); await task;
  assert.equal(f.calls.length, 0);
});

test('budget is reserved during an order and a failed entry releases its amount', async (t) => {
  const f = strategy(t); f.trader.execute = async () => ({ status: 'failed', reason: 'fixture rejection' });
  await f.launch(); assert.equal(f.agent.usage('gang', 'baw').bnb, 0);
  assert.equal(f.agent.records[0].status, 'fail');
});

function controls() {
  const requests = [], elements = new Map();
  const state = { selected: token, tokens: new Map([[token, { address: token, symbol: 'FIX' }]]), selWallets: new Set(['baw']), quickPct: 1, slippage: 1 };
  const context = vm.createContext({
    S: state, pBusy: new Set(), qBusy: { buy: false, sell: false },
    $: (key) => { if (!elements.has(key)) elements.set(key, { disabled: false, classList: { remove() {} } }); return elements.get(key); },
    api: async (url, body) => { requests.push({ url, body }); return body ? { status: 'filled' } : { bnb: 0.00001 }; },
    topPop() {}, toast() {}, note() {}, zhErr: String,
  });
  vm.runInContext(source.slice(source.indexOf('function normalizeQuickPct('), source.indexOf('async function submitQuick(')), context);
  vm.runInContext(source.slice(source.indexOf('async function quickOrder('), source.indexOf("$('#qBuy2').addEventListener")), context);
  return { context, state, requests, elements };
}

test('quick 1% uses the quoted BNB amount and only the selected wallet', async () => {
  const f = controls(); await f.context.quickOrder('buy', 1);
  assert.match(f.requests[0].url, /pct=1&/);
  const body = f.requests[1].body;
  assert.equal(body.amount, 0.00001); assert.deepEqual(Array.from(body.wallets), ['baw']);
  assert.equal(body.token, token); assert.equal(body.via, 'quick');
});

test('clear sends 100% for the selected token without selling other tokens', async () => {
  const f = controls(); await f.context.quickOrder('sell', 100);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.token, token);
  assert.equal(f.requests[0].body.side, 'sell'); assert.equal(f.requests[0].body.amount, 100);
  assert.equal(f.elements.get('#qClear').disabled, false);
});

test('quick actions do not submit without a wallet or after the same token is already busy', async () => {
  const f = controls(); f.state.selWallets.clear(); await f.context.quickOrder('sell', 100); assert.equal(f.requests.length, 0);
  f.state.selWallets.add('baw'); f.context.pBusy.add(token); await f.context.pulseBuy1(token); assert.equal(f.requests.length, 0);
});

test('quote failure cannot silently submit a quick purchase', async () => {
  const f = controls();
  f.context.api = async (url, body) => { f.requests.push({ url, body }); return { error: 'no route' }; };
  await f.context.quickOrder('buy', 1);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body, undefined);
});

test('approval cap toggle distinguishes exact amount from remembered balance allowance', async () => {
  const i = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
  const trader = { settings: { preApproveCap: false } };
  setApprovalCtx({ trader, market: { provider: { call: async () => i.encodeFunctionResult('balanceOf', [1000n]) } } });
  assert.equal(await capFor({ token, wallet: owner, amount: 10n, kind: 'sell' }), 10n);
  trader.settings.preApproveCap = true;
  assert.equal(await capFor({ token, wallet: owner, amount: 10n, kind: 'sell' }), 1010n);
  assert.equal(await capFor({ token, wallet: owner, amount: 2000n, kind: 'sell' }), 2000n);
});

test('an approval requiring App confirmation disables remembered allowance without retrying', async () => {
  const saved = [], calls = [];
  const trader = { settings: { preApproveCap: true }, saveSetting: (...a) => saved.push(a), emit() {} };
  setApprovalCtx({ trader });
  await assert.rejects(sendApproval({ token, wallet: owner, spender: owner, amount: 10n, cap: 100n,
    send: async (args) => { calls.push(args); throw Object.assign(new Error('App confirmation'), { code: 'APP_CONFIRM' }); },
  }), /App/);
  assert.equal(calls.length, 1); assert.equal(trader.settings.preApproveCap, false);
  assert.deepEqual(saved, [['preApproveCap', false]]);
});

test('token and developer blocks are case insensitive and unrelated tokens stay visible', () => {
  const list = Object.create(Blocklist.prototype); list.tokens = {}; list.devs = {}; list.save = () => {};
  list.set('token', token, true, 'fixture'); assert.equal(list.has({ address: token }), true);
  list.set('token', token, false); assert.equal(list.has({ address: token }), false);
  list.set('dev', owner, true, 'fixture'); assert.equal(list.has({ address: token, creator: owner.toUpperCase() }), true);
  assert.equal(list.has({ address: token, creator: token }), false);
});

test('approval panel explains an empty book and recovers its refresh button after errors', async () => {
  const elements = new Map([['#approvalBody', {}], ['#openApprovals', {}]]);
  const context = vm.createContext({ $: (key) => elements.get(key), AbortSignal,
    fetch: async () => ({ ok: true, json: async () => [] }),
  });
  vm.runInContext(source.slice(source.indexOf('async function openApprovals('), source.indexOf("$('#openApprovals').addEventListener")), context);
  await context.openApprovals(); assert.match(elements.get('#approvalBody').innerHTML, /尚无授权记录/);
  context.fetch = async () => { throw new Error('fixture offline'); };
  await context.openApprovals(); assert.match(elements.get('#approvalBody').textContent, /读取失败/);
  assert.equal(elements.get('#openApprovals').disabled, false);
});
