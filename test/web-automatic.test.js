import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Agent } from '../engine/agent.js';

function fixture(t, options = {}) {
  const market = new EventEmitter(), orders = [];
  const token = { address: 'token', platform: 'four', symbol: 'FIX', name: 'fixture', quote: 'BNB', createdAt: Date.now() };
  market.get = () => token; market.fetchBuyFeePct = async () => 1;
  const trader = { status: { dryRun: false }, settings: {}, wallet: () => ({ label: 'fixture', bnb: 1 }),
    eligibility: () => ({ ok: true }), positionsView: () => [],
    execute: async o => { orders.push(o); return { ...o, status: 'filled', amountIn: o.amount, latencyMs: 1 }; } };
  const agent = new Agent(market, trader, { live: true, ...options });
  clearInterval(agent.timer); t.after(() => clearInterval(agent.timer));
  agent.setConfig({ four: { enabled: true, mode: 'fixed', maxPerTrade: 0.00001, dailyBudget: 0.00006 } });
  return { agent, trader, market, token, orders };
}

test('real LiveTrader path accepts website strategy capabilities, but cannot accept a forged/replayed one', () => {
  const code = `
    import assert from 'node:assert/strict'; import { EventEmitter } from 'node:events';
    import { Agent } from './engine/agent.js'; import { LiveTrader } from './engine/live/liveTrader.js';
    const market = new EventEmitter(); const token={address:'token',platform:'gang',quote:'BNB',symbol:'FIX',name:'fixture'};
    market.get=()=>token; market.fetchBuyFeePct=async()=>1;
    const trader=Object.create(LiveTrader.prototype);
    trader.market=market; trader.orders=[]; trader.wallets=[{id:'baw',label:'fixture',bnb:1}]; trader.wallet=()=>trader.wallets[0];
    trader.emit=()=>{}; trader.route=()=> 'fixture'; trader.inflight=new Set(); trader.lockStatus=async()=> 'UNLOCKED';
    trader.preview=async()=>({out:1,route:'fixture'}); trader.positionsView=()=>[{token:'token',walletId:'baw',amount:2,openedAt:Date.now()-120000,pnlPct:-50}];
    trader.eligibility=()=>({ok:true}); trader.status={dryRun:false}; trader.settings={};
    const real=[]; trader.executeReal=async o=>{o.status='filled';o.amountIn=o.amount;real.push(o);return o};
    const agent=new Agent(market,trader,{live:true});clearInterval(agent.timer);
    trader.automaticPolicy=o=>agent.allowAutomatic(o);
    agent.setConfig({gang:{enabled:true,mode:'fixed',maxPerTrade:0.00001,dailyBudget:0.00006},exit:{enabled:true}});
    await agent.onLaunch(token);await agent.manageExits();assert.equal(real.length,2);assert.equal(real[0].side,'buy');assert.equal(real[1].side,'sell');
    assert.equal((await trader.execute({...real[0],automaticAuthorization:Symbol('forged')})).status,'dry_run');
    assert.equal((await trader.execute(real[0])).status,'dry_run'); assert.equal(real.length,2);
    agent.setConfig({paused:true});await agent.executeAutomatic({walletId:'baw',token:'token',side:'buy',amount:0.00001,source:'自动狙击'});
    assert.equal(real.length,2);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, MODE: 'live', LIVE_TRADE: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('App-pending entries retain their budget and duplicate launch events cannot rebuy', async t => {
  const f = fixture(t); f.trader.execute = async o => { f.orders.push(o); return { status: 'pending', reason: 'App' }; };
  await Promise.all([f.agent.onLaunch(f.token), f.agent.onLaunch(f.token)]);
  await f.agent.onLaunch(f.token);
  assert.equal(f.orders.length, 1); assert.equal(f.agent.usage('four', 'baw').bnb, 0.00001);
});

test('changing strategy during an async percentage quote cancels the stale intent', async t => {
  let resolve; const quote = new Promise(r => resolve = r);
  const f = fixture(t, { quoteBuy: () => quote }); f.agent.setConfig({ four: { mode: 'pct' } });
  const pending = f.agent.onLaunch(f.token); await Promise.resolve();
  f.agent.setConfig({ four: { wallets: [] } }); resolve({ bnb: 0.00001 }); await pending;
  assert.equal(f.orders.length, 0);
});

test('fee lookup rechecks just before execution and blocks renewed tax or unavailable fee', async t => {
  for (const changed of [25, null]) {
    const f = fixture(t); let calls = 0; f.market.fetchBuyFeePct = async () => ++calls === 1 ? 1 : changed;
    await f.agent.onLaunch(f.token); assert.equal(f.orders.length, 0);
  }
});

test('cold fee cache may use an actual platform preview, but never invents a zero fee', async t => {
  const f = fixture(t); f.market.fetchBuyFeePct = async () => null;
  f.trader.preview = async () => ({ feePct: 2, out: 1 }); await f.agent.onLaunch(f.token);
  assert.equal(f.orders.length, 1);
});

test('a pending exit suppresses further exits and terminal take-profit arms the trailing stop', async t => {
  const f = fixture(t); const p = { walletId: 'baw', token: 'token', amount: 1, pnlPct: 150, openedAt: 1 };
  f.trader.positionsView = () => [p]; const pendingOrder = { status: 'pending', amount: 50 };
  f.trader.execute = async o => { f.orders.push(o); return pendingOrder; };
  f.agent.setConfig({ exit: { enabled: true } }); await f.agent.manageExits(); f.agent.exitChecks.clear(); await f.agent.manageExits();
  assert.equal(f.orders.length, 1);
  pendingOrder.status = 'filled'; await f.agent.manageExits(); assert.ok(f.agent.tpDone.has('baw:token'));
  p.pnlPct = 0; p.drawdownPct = -40; f.agent.exitChecks.clear(); await f.agent.manageExits(); assert.equal(f.orders.length, 2); assert.equal(f.orders[1].amount, 100);
});

test('reopening a position resets previous take-profit state', async t => {
  const f = fixture(t); const p = { walletId: 'baw', token: 'token', amount: 1, pnlPct: 150, openedAt: 1 };
  f.trader.positionsView = () => [p]; f.agent.setConfig({ exit: { enabled: true } });
  await f.agent.manageExits(); assert.equal(f.orders.length, 1);
  p.openedAt = 2; f.agent.exitChecks.clear(); await f.agent.manageExits(); assert.equal(f.orders.length, 2);
});

test('restart retains reservations and attempted tokens, while automatic switches default off', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-auto-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'state.json'), f = fixture(t, { stateFile });
  await f.agent.onLaunch(f.token);
  const second = new Agent(f.market, f.trader, { live: true, stateFile }); clearInterval(second.timer);
  assert.equal(second.config.four.enabled, false); assert.equal(second.config.exit.enabled, false);
  assert.equal(second.usage('four', 'baw').bnb, 0.00001); assert.ok(second.attempted.has('four:baw:token'));
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).spend.length, 1);
});

test('invalid configuration is rejected atomically without changing enabled strategies', t => {
  const f = fixture(t);
  for (const patch of [{ four: { slippage: 200 } }, { four: { enabled: 'yes' } }, { four: { wallets: ['baw', 'baw'] } }, { exit: { takeProfitSellPct: 101 } }, { four: { minReserve: NaN } }]) {
    assert.throws(() => f.agent.setConfig(patch)); assert.equal(f.agent.config.four.enabled, true); assert.equal(f.agent.config.four.slippage, 20);
  }
});

test('a partially executed multistep buy cannot release its reserved budget on later failure', async t => {
  const f = fixture(t); f.trader.execute = async () => ({ status: 'failed', pendingTx: 'already-broadcast', reason: 'buy failed after conversion' });
  await f.agent.onLaunch(f.token); assert.equal(f.agent.usage('four', 'baw').bnb, 0.00001);
});
