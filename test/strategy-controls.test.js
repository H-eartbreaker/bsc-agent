import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { Agent } from '../engine/agent.js';
import { LiveTrader } from '../engine/live/liveTrader.js';
import { costForPct } from '../engine/live/costForPct.js';

function fixture(t) {
  const market = new EventEmitter(); market.get = () => ({ address: 'token', platform: 'gang' });
  const calls = [];
  const trader = { status: { dryRun: true }, wallet: () => ({ label: 'wallet', bnb: 0 }), eligibility: () => ({ ok: true }), positionsView: () => [], settings: {}, execute: async (o) => { calls.push(o); return { ...o, status: 'dry_run', latencyMs: 0 }; } };
  const agent = new Agent(market, trader, { live: true, quoteBuy: async (q) => { assert.equal(q.pct, 0.3); return { bnb: 0.02 }; } });
  clearInterval(agent.timer); t.after(() => clearInterval(agent.timer));
  return { agent, market, trader, calls };
}

test('Gang has an independent disabled strategy and percentage sizing reaches the order path', async (t) => {
  const { agent, calls } = fixture(t);
  assert.equal(agent.config.gang.enabled, false);
  assert.deepEqual(agent.config.gang.wallets, ['baw']);
  agent.setConfig({ gang: { enabled: true, mode: 'pct', pctOfSupply: 0.3 } });
  await agent.onLaunch({ address: 'token', platform: 'gang', symbol: 'COIN', name: 'coin', quote: 'BNB' });
  assert.equal(calls.length, 1); assert.equal(calls[0].amount, 0.02);
  assert.equal(calls[0].source, '自动狙击');
  assert.equal(agent.usageView().gang.lastHour, 1);
  assert.equal(agent.config.four.enabled, false);
});

test('Gang keyword exclusion and global pause stop automatic orders', async (t) => {
  const { agent, calls } = fixture(t);
  agent.setConfig({ gang: { enabled: true, mode: 'fixed' } });
  await agent.onLaunch({ address: 'token', platform: 'gang', symbol: 'TEST', name: 'test', quote: 'BNB' });
  assert.equal(calls.length, 0);
  agent.setConfig({ paused: true });
  await agent.onLaunch({ address: 'token', platform: 'gang', symbol: 'COIN', name: 'coin', quote: 'BNB' });
  assert.equal(calls.length, 0);
});

test('automatic exits evaluate take profit but a dry run never marks it as filled or spams each tick', async (t) => {
  const { agent, trader, calls } = fixture(t);
  trader.positionsView = () => [{ amount: 100, walletId: 'baw', token: 'token', symbol: 'COIN', platform: 'gang', pnlPct: 150 }];
  agent.setConfig({ exit: { enabled: true } });
  await agent.manageExits(); await agent.manageExits();
  assert.equal(calls.length, 1); assert.equal(calls[0].side, 'sell'); assert.equal(calls[0].amount, 50);
  assert.equal(agent.tpDone.has('baw:token'), false);
  assert.match(agent.records[0].msg, /未真实卖出/);
});

test('stop loss, trailing stop and maximum hold time reach the backend sell path', async (t) => {
  for (const p of [{ pnlPct: -50 }, { pnlPct: 10, drawdownPct: -35, trailing: true }, { pnlPct: null, openedAt: Date.now() - 120_000 }]) {
    const { agent, trader, calls } = fixture(t);
    trader.positionsView = () => [{ amount: 100, walletId: 'baw', token: 'token', symbol: 'COIN', platform: 'gang', ...p }];
    agent.setConfig({ exit: { enabled: true, maxHoldMin: p.openedAt ? 1 : 0 } });
    if (p.trailing) agent.tpDone.add('baw:token');
    await agent.manageExits(); assert.equal(calls.length, 1); assert.equal(calls[0].amount, 100);
  }
});

test('Gang position valuation converts quote currency into BNB and refuses an unknown cost basis', () => {
  const trader = Object.create(LiveTrader.prototype);
  trader.positions = new Map([['one', { token: 'token', walletId: 'baw', amount: 10, costBnb: 0.1, boughtBnb: 0.1, soldBnb: 0, peak: 0 }]]);
  trader.wallets = [];
  trader.market = { bnbUsd: 500, quoteUsd: () => 2, get: () => ({ symbol: 'G', platform: 'gang', quote: 'GANG', price: 5 }) };
  assert.equal(trader.positionsView()[0].valueBnb, 0.2);
  assert.equal(trader.positionsView()[0].pnlPct, 100);
  trader.positions.get('one').costBnb = 0;
  assert.equal(trader.positionsView()[0].pnlPct, null);
  trader.market.quoteUsd = () => 0;
  assert.equal(trader.positionsView()[0].drawdownPct, null);
});

test('shared manual/automatic percentage sizing respects Gang one percent cap without sending transactions', async () => {
  let previews = 0;
  const market = { get: () => ({ platform: 'gang', source: 'gang' }) };
  const trader = { status: { maxTradeBnb: 0 }, wallet: () => ({ bnb: 0 }), preview: async ({ amount }) => { previews++; return { out: amount * 1e9 }; } };
  const q = await costForPct({ market, trader, live: true }, { wallet: 'baw', token: 'token', pct: 2, slippage: 5 });
  assert.equal(q.pct, 1); assert.equal(q.bnb, 0.01); assert.equal(q.capped, true); assert.ok(previews > 0);
});

test('automatic orders only preview the platform route and never enter the real execution path', async () => {
  const trader = Object.create(LiveTrader.prototype);
  trader.market = { get: () => ({ address: 'token', symbol: 'G', platform: 'gang' }) };
  trader.orders = []; trader.wallets = [{ id: 'baw', label: 'wallet' }]; trader.wallet = () => trader.wallets[0];
  trader.emit = () => {}; trader.route = () => 'Gang route';
  trader.executeReal = () => assert.fail('real execution must not run');
  trader.preview = async () => ({ amountIn: 5, out: 0.1, route: 'Gang preview' });
  const order = await trader.execute({ walletId: 'baw', token: 'token', side: 'sell', amount: 50, source: '自动卖出' });
  assert.equal(order.status, 'dry_run'); assert.equal(order.venue, 'Gang preview'); assert.equal(order.dryRun, true);
});

test('enabling manual live execution still cannot submit automatic orders', () => {
  const code = `
    import assert from 'node:assert/strict';
    import { LiveTrader } from './engine/live/liveTrader.js';
    import { DRY_RUN } from './engine/live/config.js';
    assert.equal(DRY_RUN, false);
    const trader = Object.create(LiveTrader.prototype);
    trader.market = { get: () => ({ address: 'token', symbol: 'G', platform: 'gang' }) };
    trader.orders = []; trader.wallets = [{ id: 'baw', label: 'wallet' }];
    trader.wallet = () => trader.wallets[0]; trader.emit = () => {}; trader.route = () => 'Gang';
    trader.executeReal = () => assert.fail('automatic execution must stay blocked');
    trader.preview = async () => ({ amountIn: 5, out: 0.1, route: 'Gang preview' });
    for (const source of ['自动卖出', '自动狙击']) {
      const o = await trader.execute({ walletId: 'baw', token: 'token', side: 'sell', amount: 50, source });
      assert.equal(o.status, 'dry_run'); assert.equal(o.dryRun, true);
    }
    let manualCalls = 0;
    trader.inflight = new Set(); trader.lockStatus = async () => 'UNLOCKED';
    trader.executeReal = async (order) => { manualCalls++; return { ...order, status: 'filled' }; };
    const manual = await trader.execute({ walletId: 'baw', token: 'token', side: 'buy', amount: 0.1, source: '手动' });
    assert.equal(manual.dryRun, false); assert.equal(manualCalls, 1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, MODE: 'live', LIVE_TRADE: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('missing price data does not falsely trigger a trailing stop', async (t) => {
  const { agent, trader, calls } = fixture(t);
  agent.tpDone.add('baw:token');
  agent.setConfig({ exit: { enabled: true } });
  trader.positionsView = () => [{ amount: 1, walletId: 'baw', token: 'token', pnlPct: null, drawdownPct: null }];
  await agent.manageExits();
  assert.equal(calls.length, 0);
});

test('inline strategy form renders all three platforms and keeps risk fields visible in read-only mode', async (t) => {
  const { agent } = fixture(t);
  const elements = new Map();
  const state = { config: agent.config, settingsPlat: 'gang', wallets: [{ id: 'baw', label: 'Agent wallet', address: '0x1234' }], records: [], baw: { maxTradeBnb: 0.2 }, net: {}, block: 0 };
  const context = vm.createContext({ S: state, LIVE: () => true, REAL: () => false, esc: (v) => String(v ?? ''), short: (v) => v, $: (key) => { if (!elements.has(key)) elements.set(key, {}); return elements.get(key); } });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function renderSettings()'), source.indexOf('const setPath =')), context);
  context.renderSettings();
  let html = elements.get('#settingsBody').innerHTML;
  for (const field of ['gang.hourlyMax', 'gang.minReserve', 'gang.delaySec', 'gang.include', 'gang.exclude', 'gang.slippage', 'gang.antiSnipe.pollMs', 'exit.takeProfitSellPct', 'exit.trailingPct', 'exit.maxHoldMin']) assert.ok(html.includes(field), field);
  assert.match(html, /data-sp="gang"[^>]*class="active"/);
  assert.match(html, /id="maxTradeBnb"/);
  assert.match(html, /仅预演/);
  // A browser can load the new frontend before the older backend restarts.
  delete state.config.gang;
  context.renderSettings();
  html = elements.get('#settingsBody').innerHTML;
  assert.equal(state.settingsPlat, 'four');
  assert.match(html, /data-sp="gang" disabled/);
});

test('strategy UI distinguishes real-capable, paused and older preview-only backends', async t => {
  const { agent } = fixture(t), elements = new Map();
  const state = { config: agent.config, settingsPlat: 'four', wallets: [], records: [], baw: { automaticTrading: true }, net: {}, block: 0 };
  const context = vm.createContext({ S: state, LIVE: () => true, REAL: () => true, esc: String, short: String,
    $: key => { if (!elements.has(key)) elements.set(key, {}); return elements.get(key); } });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function renderSettings()'), source.indexOf('const setPath =')), context);
  context.renderSettings(); assert.match(elements.get('#settingsBody').innerHTML, /自动策略支持真实下单/);
  state.config.paused = true; context.renderSettings(); assert.match(elements.get('#settingsBody').innerHTML, /自动策略已暂停/);
  state.baw.automaticTrading = false; context.renderSettings(); assert.match(elements.get('#settingsBody').innerHTML, /当前后端未启用真实自动执行/);
});
