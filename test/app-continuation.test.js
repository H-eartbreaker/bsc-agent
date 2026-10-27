import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { ethers } from 'ethers';
import { waitForContractConfirmation } from '../engine/live/app-confirmation.js';

const wallet = '0x1111111111111111111111111111111111111111', venue = '0x2222222222222222222222222222222222222222';
const hash = n => '0x' + String(n).repeat(64);
function fixture(overrides = {}) {
  let clock = 100000, reads = 0;
  return { wallet, to: venue, valueWei: '0', inputData: '0xabcd', nonce: 9, startedAt: clock,
    orderId: 'original-order', requestId: 'original-preview', label: 'sell', message: 'High-risk transaction, please confirm in the App',
    maxMs: 50, intervalMs: 1, now: () => clock, wait: async () => { clock++; },
    history: async () => ({ transactions: ++reads === 1 ? [] : [{ txHash: hash('a') }] }),
    provider: { getTransaction: async () => ({ from: wallet, to: venue, data: '0xabcd', value: 0n, nonce: 9 }),
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 100 }), getBlock: async () => ({ timestamp: 100 }) }, ...overrides };
}

test('App confirmation waits for the exact transaction and returns only after its successful receipt', async () => {
  const f = fixture(); assert.equal(await waitForContractConfirmation(f), hash('a'));
});

test('wrong sender, contract, calldata, value, old nonce and old block cannot complete an App order', async () => {
  for (const patch of [{ from: venue }, { to: wallet }, { data: '0x' }, { value: 1n }, { nonce: 8 }, { nonce: 10 }, { oldBlock: true }]) {
    const f = fixture(); const read = f.provider.getTransaction;
    f.provider.getTransaction = async () => ({ ...await read(), ...patch });
    if (patch.oldBlock) f.provider.getBlock = async () => ({ timestamp: 1 });
    await assert.rejects(waitForContractConfirmation(f), e => e.code === 'APP_CONFIRM' && e.orderId === 'original-order');
  }
});

test('history failures and missing nonce remain pending, never trigger a new contract execution', async () => {
  for (const patch of [{ nonce: undefined }, { history: async () => { throw Error('offline'); } }]) {
    await assert.rejects(waitForContractConfirmation(fixture(patch)), e => e.code === 'APP_CONFIRM' && e.requestId === 'original-preview');
  }
});

test('a reverted confirmed transaction stops continuation with the original hash', async () => {
  const f = fixture(); f.provider.getTransactionReceipt = async () => ({ status: 0, blockNumber: 100 });
  await assert.rejects(waitForContractConfirmation(f), e => e.code === 'CHAIN_FAILED' && e.tx === hash('a'));
});

test('Portal send executes once, reports App message, waits and resumes instead of throwing immediately', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-app-resume-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'baw'), log = join(dir, 'calls');
  writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.CALL_LOG,process.argv.join(' ')+'\\n');console.log(JSON.stringify({success:true,data:process.argv.includes('execute')?{status:'PENDING_CONFIRMATION',orderId:'original-order',message:'High-risk transaction, please confirm in the App'}:{requestId:'original-preview',simulationResult:{simulationCode:'000000000'}}}));`, { mode: 0o700 });
  const code = `
    import assert from 'node:assert/strict'; import { Portal } from './engine/live/portal.js';
    const p=Object.create(Portal.prototype), steps=[];
    p.provider={getTransactionCount:async()=>9,getTransactionReceipt:async()=>({status:1})};
    let waited=false;
    p.confirmPending=async intent=>{assert.equal(intent.nonce,9);assert.equal(intent.orderId,'original-order');waited=true;return '${hash('a')}'};
    const tx=await p.send({wallet:'${wallet}',to:'${venue}',inputData:'0xabcd',label:'sell',step:(name,ms,x)=>steps.push(x)});
    assert.equal(tx,'${hash('a')}');assert.ok(waited);
    assert.ok(steps.some(s=>s?.stage==='app_confirmation' && s.message.includes('High-risk transaction')));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, MODE: 'live', LIVE_TRADE: '1', BAW_BIN: bin, CALL_LOG: log }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n'); assert.equal(calls.filter(c => c.includes('contract-call execute')).length, 1);
});

// Run the actual Gang V2 sell method around a pending send to check composite ordering and balance isolation.
for (const approved of [true, false]) {
  test(`Gang V2 pending App ${approved ? 'approval resumes a single conversion' : 'timeout prevents conversion'}`, async () => {
    const source = readFileSync(new URL('../engine/live/gangV2Pads.js', import.meta.url), 'utf8');
    const method = (name) => {   // 按花括号配平截出方法（后面再加别的方法也不影响）
      let st = source.indexOf('  async ' + name + '('); if (st < 0) st = source.indexOf('  ' + name + '(');
      assert.ok(st >= 0, name + ' 不见了');
      let d = 0, i = source.indexOf(') {', st) + 2; for (; i < source.length; i++) { if (source[i] === '{') d++; else if (source[i] === '}' && --d === 0) break; }
      return source.slice(st, i + 1);
    };
    const methodsSrc = ['sell', 'swapBack', 'notGraduated'].map(method).join(',\n');
    const token = '0x3333333333333333333333333333333333333333', quote = '0x4444444444444444444444444444444444444444';
    const events = [], submissions = [];
    let release; const app = new Promise(resolve => release = resolve);
    const baw = { marketSwap: async args => { events.push('convert'); submissions.push(args); return { orderId: 'convert-original' }; },
      pollOrder: async () => ({ status: 'FINISHED', txHash: hash('b'), toTokenActualQty: '0.000009' }) };
    const context = vm.createContext({ ONDO_RE: /(?!)/, viaUsdt: () => false, markViaUsdt() {}, USDT: '0x5555555555555555555555555555555555555555', assertLiquid: async address => assert.equal(address, quote), ethers, baw, pad: new ethers.Interface(['function sell(address,uint256,uint256)']), isWbnb: () => false, minOut: v => v * 97n / 100n, BNB_NATIVE: ethers.ZeroAddress });
    const target = vm.runInContext('({' + methodsSrc + '})', context); let balanceReads = 0;
    Object.assign(target, { provider: { call: async () => '0x', getBlockNumber: async () => 100 }, curve: async () => ({ pad: venue, c: {} }), quoteToken: () => quote,
      balanceOf: async address => address === token ? 10n ** 18n : (++balanceReads === 1 ? 90n : 91n) * 10n ** 18n,
      needsUsdt: async () => false, ensureAllowance: async () => null, sellQuote: () => ({ out: 10n ** 18n }), decimals: async () => 18,
      send: async () => { events.push('sell-submitted'); await app; if (!approved) throw Object.assign(Error('pending'), { code: 'APP_CONFIRM' }); events.push('sell-confirmed'); return hash('a'); } });
    const result = target.sell({ wallet, token, pct: 100, slippage: 3, step() {}, toBnb: true });
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['sell-submitted']); assert.equal(submissions.length, 0);
    release();
    if (!approved) { await assert.rejects(result, e => e.code === 'APP_CONFIRM'); assert.equal(submissions.length, 0); }
    else { const r = await result; assert.deepEqual(events, ['sell-submitted', 'sell-confirmed', 'convert']); assert.equal(submissions.length, 1); assert.equal(submissions[0].fromTokenQty, '1.0'); assert.equal(r.txHash, hash('b')); }
  });
}

test('an App-pending sell never treats an earlier approval receipt as the completed sell', () => {
  const code = `
    import assert from 'node:assert/strict'; import { LiveTrader } from './engine/live/liveTrader.js';
    const t=Object.create(LiveTrader.prototype);
    t.market={get:token=>({address:token,symbol:'FIX'}),provider:{getTransactionReceipt:()=>assert.fail('old approval must not complete sell')}};
    t.orders=[];t.wallets=[{label:'fixture'}];t.wallet=()=>t.wallets[0];t.emit=()=>{};t.route=()=> 'fixture';t.inflight=new Set();t.lockStatus=async()=> 'UNLOCKED';
    let follow;
    t.followUp=async(o,e)=>{follow=o.pendingTx;};
    t.executeReal=async(o,token,w,step)=>{step('approval',1,{tx:'old-approval',stage:'broadcast'});step('App',1,{stage:'app_confirmation',orderId:'original',message:'confirm'});throw Object.assign(Error('pending'),{code:'APP_CONFIRM'})};
    const o=await t.execute({walletId:'baw',token:'token',side:'sell',amount:100});
    assert.equal(o.status,'pending');assert.equal(follow,null);assert.equal(o.orderId,'original');assert.ok(t.inflight.has('token'));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env: { ...process.env, MODE: 'live', LIVE_TRADE: '1' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
