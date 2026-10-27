import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tracker } from '../engine/live/tracker.js';
import { fetchTraderHistory, getLogsChunked } from '../engine/live/trackBackfill.js';
const who = '0x1111111111111111111111111111111111111111', token = '0x2222222222222222222222222222222222222222';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-agent-backfill-')); t.after(() => rmSync(dir, { recursive: true }));
  const files = Object.fromEntries(['TARGETS', 'TASKS', 'FEED', 'LOG'].map(n => [n, pathToFileURL(join(dir, n))]));
  const tracker = new Tracker({ files, market: { get: () => ({ symbol: 'FIX', quote: 'BNB', platform: 'four' }), bnbUsd: 100 }, provider: { getBlock: async () => ({ timestamp: 1000 }) }, placeOrder: () => assert.fail('history placed an order'), fetchHistory: async () => ({ head: 10, trades: [1, 2, 3].map(n => ({ trader: who, token, tx: `tx${n}`, side: 'buy', tokens: 1, bnb: 1, block: n, platform: 'four' })) }) });
  tracker.targets = [{ address: who, name: 'Fixture' }]; return { tracker, files };
}
test('historical events are deduplicated, never trigger orders, and equal timestamps paginate without loss', async t => {
  const { tracker, files } = fixture(t); let realtime = 0; tracker.on('event', () => realtime++);
  await tracker.backfill([who]); await tracker.backfill([who]);
  assert.equal(readFileSync(files.FEED, 'utf8').trim().split('\n').length, 3); assert.equal(realtime, 0);
  const a = tracker.feedPage({ limit: 2 }), b = tracker.feedPage({ limit: 2, cursor: a.nextCursor });
  assert.equal(a.more, true); assert.equal(b.more, false); assert.equal(new Set([...a.items, ...b.items].map(r => r.id)).size, 3);
  assert.ok(a.items.every(r => r.backfill));
  await tracker.decide({}, { backfill: true });
  assert.throws(() => tracker.feedPage({ cursor: 'bad' }), /游标/);
});
test('failed backfill exposes retry state and successful retry clears it', async t => {
  const { tracker } = fixture(t), fetch = tracker.fetchHistory;
  tracker.fetchHistory = async () => { throw Error('offline'); };
  await assert.rejects(tracker.backfill([who])); assert.equal(tracker.backfilling, false); assert.ok(tracker.targetsView().backfillError);
  tracker.fetchHistory = fetch; await tracker.backfill([who]); assert.equal(tracker.targetsView().backfillError, null);
});
test('24 hour window uses actual chain timestamps and RPC chunks shrink without gaps', async () => {
  const ranges = [];
  const provider = { getBlockNumber: async () => 100000, getBlock: async n => ({ timestamp: n * 2 }), getLogs: async f => { ranges.push(f); return []; } };
  await fetchTraderHistory(provider, [who]); assert.equal(ranges[0].fromBlock, 56800); assert.equal(ranges.at(-1).toBlock, 100000);
  let failures = 0; const seen = [];
  const logs = await getLogsChunked({ getLogs: async f => { if (f.toBlock - f.fromBlock > 2499) { failures++; throw Error('range'); } seen.push([f.fromBlock, f.toBlock]); return [f.fromBlock]; } }, {}, 1, 6000, 10000);
  assert.ok(failures > 0); assert.deepEqual(logs, [1, 2501, 5001]); assert.deepEqual(seen, [[1, 2500], [2501, 5000], [5001, 6000]]);
});

test('single-wallet copy caps apply to total spend and pending orders keep reservations', async t => {
  const { tracker } = fixture(t); let calls = 0;
  tracker.placeOrder = async o => { calls++; assert.equal(o.amount, 0.01); return [{ status: 'pending', amount: o.amount }]; };
  const task = tracker.createTask({ target: who, params: { wallets: [1], amountBnb: 0.01, maxPerToken: 0.015, dailyCap: 0.02, maxCopies: 1, dryRun: false } }); task.status = 'running';
  const ev = { token, ts: Date.now(), seenAt: Date.now(), platform: 'four', side: 'buy', action: '建仓', bnb: 1 };
  await Promise.all([tracker.enqueueDecision(task, ev), tracker.enqueueDecision(task, { ...ev, token: 'another' })]);
  assert.equal(calls, 1); assert.equal(task.tokens[token].bought, 0.01); assert.equal(Object.values(task.days)[0], 0.01);
  assert.equal(tracker.log.some(row => row.kind === 'fail'), false);
  assert.equal(task.stats.copies, 1); assert.equal(task.status, 'running'); assert.equal(task.tokens[token].pending, true);
});

test('adding a tracking target starts realtime-only mode without automatic history backfill', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-agent-realtime-track-')); t.after(() => rmSync(dir, {recursive:true}));
  const files = Object.fromEntries(['TARGETS','TASKS','FEED','LOG'].map(n => [n, pathToFileURL(join(dir,n))]));
  let calls=0; const tracker=new Tracker({files, market:{get:()=>null}, provider:{}, fetchHistory:async()=>{calls++;return {trades:[]};}});
  tracker.addTarget({address:who,name:'实时'}); await new Promise(r=>setTimeout(r,10));
  assert.equal(calls,0); assert.equal(tracker.targetsView().backfilling,false);
});
