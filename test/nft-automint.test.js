import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoMint, cleanRules, skipReason, pickProjects } from '../engine/nft/autoMint.js';
import { readMintHistory, summarize } from '../engine/nft/mintLog.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const row = (o = {}) => ({ contract: '0x' + 'a'.repeat(40), name: 'Alpha', symbol: 'ALP', priceLine: '免费', free: true, freeOnAgentPath: true, agentGated: true, manualOnly: false, website: 'https://a.io', xHandle: 'alpha', perWallet: 5, postedAt: new Date(NOW - 60_000).toISOString(), ...o });
const st = (rules = {}, extra = {}) => ({ enabledAt: NOW - 3600_000, attempts: {}, rules: cleanRules(rules), ...extra });

test('cleanRules clamps and normalises', () => {
  const r = cleanRules({ social: 'bogus', maxQty: 999, exclude: 'Foo, bar  baz' });
  assert.equal(r.social, 'any'); assert.equal(r.maxQty, 50); assert.deepEqual(r.exclude, ['foo', 'bar', 'baz']);
  assert.equal(cleanRules({ maxQty: 0 }).maxQty, 10);
});

test('paid / manual-only / non-agent projects are skipped', () => {
  assert.ok(skipReason(row({ free: false, freeOnAgentPath: false }), st(), NOW));
  assert.match(skipReason(row({ manualOnly: true }), st(), NOW), /手动/);
  assert.match(skipReason(row({ agentGated: false }), st(), NOW), /Agent/);
  assert.equal(skipReason(row(), st(), NOW), null);
});

test('social filter modes', () => {
  const both = row(), site = row({ xHandle: '' }), x = row({ website: '' }), none = row({ website: '', xHandle: '' });
  const ok = (mode, r) => skipReason(r, st({ social: mode }), NOW) === null;
  assert.deepEqual([both, site, x, none].map((r) => ok('any', r)), [true, true, true, true]);
  assert.deepEqual([both, site, x, none].map((r) => ok('site', r)), [true, true, false, false]);
  assert.deepEqual([both, site, x, none].map((r) => ok('x', r)), [true, false, true, false]);
  assert.deepEqual([both, site, x, none].map((r) => ok('either', r)), [true, true, true, false]);
  assert.deepEqual([both, site, x, none].map((r) => ok('both', r)), [true, false, false, false]);
});

test('exclude keywords and scope', () => {
  assert.match(skipReason(row({ name: 'Scam Coin' }), st({ exclude: ['scam'] }), NOW), /排除/);
  const old = row({ postedAt: new Date(NOW - 7200_000).toISOString() });
  assert.match(skipReason(old, st({ scope: 'new' }), NOW), /老项目/);
  assert.equal(skipReason(old, st({ scope: 'all' }), NOW), null);
});

test('retry gaps, done and noRetry', () => {
  const r = row();
  assert.match(skipReason(r, st({}, { attempts: { [r.contract]: { done: true, status: '成功' } } }), NOW), /已处理/);
  assert.match(skipReason(r, st({}, { attempts: { [r.contract]: { count: 1, lastAt: NOW - 30_000 } } }), NOW), /等待/);
  assert.equal(skipReason(r, st({}, { attempts: { [r.contract]: { count: 1, lastAt: NOW - 3 * 60_000 } } }), NOW), null);
  assert.match(skipReason(r, st({}, { attempts: { [r.contract]: { count: 1, lastAt: NOW - 3 * 60_000, noRetry: true, reason: '额度已用' } } }), NOW), /无需重试/);
  assert.match(skipReason(r, st({}, { attempts: { [r.contract]: { count: 9, lastAt: 0 } } }), NOW), /重试/);
  assert.equal(pickProjects([r, row({ contract: '0x' + 'b'.repeat(40), free: false, freeOnAgentPath: false })], st(), NOW).length, 1);
});

function make(runner, feed, rules) {
  const dir = mkdtempSync(join(tmpdir(), 'automint-'));
  const a = new AutoMint({ feedFile: 'x', stateFile: join(dir, 's.json'), runner, readFeed: () => feed, intervalMs: 1e9 });
  a.state.rules = cleanRules(rules);
  return { a, dir };
}

test('tick mints once, records tx and never resends', async () => {
  const calls = [];
  const feed = [row({ postedAt: new Date(Date.now() + 1000).toISOString() })];
  const { a } = make(async (rows, o) => { calls.push({ rows, o }); return [{ contract: rows[0].contract, status: '成功', tx: '0xtx' }]; }, feed, {});
  a.configure({ enabled: true });
  await a.tick(); await a.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].o.maxQty, 5); assert.equal(calls[0].o.dry, false);
  assert.equal(a.state.attempts[feed[0].contract].done, true);
});

test('a failed run with a broadcast tx is still treated as done (no double mint)', async () => {
  const feed = [row({ postedAt: new Date(Date.now() + 1000).toISOString() })];
  const { a } = make(async (rows) => [{ contract: rows[0].contract, status: '失败', reason: 'receipt timeout', tx: '0xabc' }], feed, {});
  a.configure({ enabled: true });
  await a.tick();
  assert.equal(a.state.attempts[feed[0].contract].done, true);
});

test('failure is retried only after the gap; runner crash does not lose state', async () => {
  const feed = [row({ postedAt: new Date(Date.now() + 1000).toISOString() })];
  let n = 0;
  const { a } = make(async () => { n++; throw new Error('boom'); }, feed, {});
  a.configure({ enabled: true });
  await a.tick(); await a.tick();
  assert.equal(n, 1);
  assert.equal(a.state.attempts[feed[0].contract].status, '失败');
  assert.equal(a.busy, false);
});

test('switching dry-run <-> live clears attempts; enabling resets session; restart does not auto-resume', async () => {
  const feed = [row({ postedAt: new Date(Date.now() + 1000).toISOString() })];
  const { a, dir } = make(async (rows) => [{ contract: rows[0].contract, status: '可mint(未执行)' }], feed, { dry: true });
  a.configure({ enabled: true });
  await a.tick();
  assert.equal(a.state.attempts[feed[0].contract].done, true);
  a.configure({ enabled: false });
  a.configure({ rules: { dry: false } });
  assert.deepEqual(a.state.attempts, {});
  const t0 = a.state.sessionStart;
  a.configure({ enabled: true });
  assert.ok(a.state.sessionStart >= t0);
  const b = new AutoMint({ feedFile: 'x', stateFile: join(dir, 's.json'), runner: async () => [], readFeed: () => [] });
  assert.equal(b.view().enabled, false);
});

test('mintLog reads history, filters by time and summarises', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mintlog-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-01-01T12-00-00-000Z.json'), JSON.stringify({ wallet: '0xw', dry: false, source: 'auto', results: [
    { name: 'A', contract: '0x1', status: '成功', qty: 3, tx: '0xt', tokenIds: ['1', '2', '3'], gasBnb: 0.001 },
    { name: 'B', contract: '0x2', status: '失败', reason: 'x' },
  ] }));
  const rows = readMintHistory(dir, { limit: 50 });
  assert.equal(rows.length, 2);
  const s = summarize(rows);
  assert.equal(s.projectsOk, 1); assert.equal(s.nftsMinted, 3); assert.equal(s.failed, 1);
  assert.equal(readMintHistory(dir, { since: Date.now() + 1e7 }).length, 0);
});
