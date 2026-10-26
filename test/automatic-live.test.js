import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Agent } from '../engine/agent.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('App confirmation preserves request/order identifiers and never polls a receipt before approval', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-app-pending-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'baw');
  writeFileSync(binary, `#!/usr/bin/env node\nconst execute=process.argv.includes('execute');console.log(JSON.stringify({success:true,data:execute?{status:'PENDING_CONFIRMATION',orderId:'fixture-order',message:'Please confirm in App'}:{requestId:'fixture-request',simulationResult:{simulationCode:'000000000'},risks:{riskDetails:[]},requireConfirmation:true}}));\n`, { mode: 0o700 });
  const code = `
    import assert from 'node:assert/strict';
    import { Portal } from './engine/live/portal.js';
    const portal = Object.create(Portal.prototype);
    portal.provider = {getTransactionReceipt: () => assert.fail('no receipt exists before App approval')};
    await assert.rejects(portal.send({wallet:'0x1111111111111111111111111111111111111111',to:'0x2222222222222222222222222222222222222222',inputData:'0x',label:'fixture',step:()=>{}}), error => {
      assert.equal(error.code, 'APP_CONFIRM');
      assert.equal(error.requestId, 'fixture-request');
      assert.equal(error.orderId, 'fixture-order');
      return true;
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, MODE: 'live', LIVE_TRADE: '1', BAW_BIN: binary }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('contract guard receives the preview and can stop execution before the CLI execute call', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-contract-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'baw'), log = join(dir, 'calls');
  writeFileSync(binary, `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(process.env.TEST_GUARD_LOG, process.argv.join(' ')+'\\n');console.log(JSON.stringify({success:true,data:{requestId:'fixture',simulationResult:{simulationCode:'000000000',authorityChanges:[]},parsedTx:{transactionType:'ContractInteraction'},risks:{riskDetails:[]}}}));\n`, { mode: 0o700 });
  const code = `
    import assert from 'node:assert/strict';
    import { contractCall, setContractExecutionGuard } from './engine/live/baw.js';
    let inspected = false;
    setContractExecutionGuard(({ preview, valueWei }) => {
      inspected = true;
      assert.equal(valueWei, '10000000000000');
      assert.equal(preview.parsedTx.transactionType, 'ContractInteraction');
      assert.deepEqual(preview.simulationResult.authorityChanges, []);
      throw new Error('test budget denied');
    });
    await assert.rejects(contractCall({from:'0x1111111111111111111111111111111111111111',to:'0x2222222222222222222222222222222222222222',valueWei:'10000000000000',inputData:'0x'}), /test budget denied/);
    assert.equal(inspected, true);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, MODE: 'live', LIVE_TRADE: '1', BAW_BIN: binary, TEST_GUARD_LOG: log }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1); assert.match(calls[0], /contract-call preview/); assert.doesNotMatch(calls[0], /contract-call execute/);
});

test('a scoped process policy permits only its authorized automatic token and side', () => {
  const code = `
    import assert from 'node:assert/strict';
    import { LiveTrader } from './engine/live/liveTrader.js';
    const t = Object.create(LiveTrader.prototype);
    t.market = { get: token => ({ address: token, symbol: 'FIX', platform: 'gang' }) };
    t.orders = []; t.wallets = [{ id: 'baw', label: 'fixture' }]; t.wallet = () => t.wallets[0];
    t.emit = () => {}; t.route = () => 'fixture'; t.inflight = new Set(); t.lockStatus = async () => 'UNLOCKED';
    t.preview = async () => ({ out: 1, route: 'fixture' });
    let realCalls = 0;
    t.executeReal = async order => { realCalls++; return { ...order, status: 'filled' }; };
    const buy = { walletId: 'baw', token: 'allowed', side: 'buy', amount: 0.00001, source: '自动狙击' };
    assert.equal((await t.execute(buy)).status, 'dry_run');
    t.automaticPolicy = o => o.token === 'allowed' && o.side === 'buy' && o.amount === 0.00001;
    assert.equal((await t.execute(buy)).status, 'filled');
    assert.equal((await t.execute({ ...buy, token: 'other' })).status, 'dry_run');
    assert.equal((await t.execute({ ...buy, amount: 0.1 })).status, 'dry_run');
    assert.equal((await t.execute({ ...buy, side: 'sell', source: '自动卖出' })).status, 'dry_run');
    t.automaticPolicy = () => Promise.resolve(true);
    assert.equal((await t.execute(buy)).status, 'dry_run');
    t.automaticPolicy = () => true;
    assert.equal((await t.execute({ ...buy, source: 'untrusted' })).status, 'dry_run');
    assert.equal((await t.execute({ ...buy, side: 'sell' })).status, 'dry_run');
    assert.equal(realCalls, 1);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, MODE: 'live', LIVE_TRADE: '1', BAW_BIN: '/__test_no_wallet_cli__' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('a 0.00001 BNB automatic entry reaches execution without raising its budget', async () => {
  const market = new EventEmitter(); market.get = () => ({ address: 'fixture', platform: 'gang' });
  const calls = [];
  const trader = { status: { dryRun: false }, settings: {}, wallet: () => ({ label: 'fixture', bnb: 1 }),
    eligibility: () => ({ ok: true }), positionsView: () => [], execute: async o => { calls.push(o); return { ...o, status: 'dry_run', latencyMs: 0 }; } };
  const agent = new Agent(market, trader, { live: true }); clearInterval(agent.timer);
  agent.setConfig({ gang: { enabled: true, mode: 'fixed', maxPerTrade: 0.00001, dailyBudget: 0.00001, hourlyMax: 1 } });
  await agent.onLaunch({ address: 'fixture', platform: 'gang', symbol: 'FIX', name: 'fixture', quote: 'BNB' });
  assert.equal(calls.length, 1); assert.equal(calls[0].amount, 0.00001);
  await agent.onLaunch({ address: 'fixture', platform: 'gang', symbol: 'FIX', name: 'fixture', quote: 'BNB' });
  assert.equal(calls.length, 1);
});
