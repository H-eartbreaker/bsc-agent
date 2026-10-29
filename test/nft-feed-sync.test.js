import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeedSync } from '../engine/nft/feedSync.js';
import { FeedPublisher } from '../engine/nft/feedPublish.js';

const row = (n) => ({ contract: '0x' + String(n).padStart(40, '0'), name: 'P' + n, eligible: true, freeOnAgentPath: true, raw: 'secret text' });
const dir = () => mkdtempSync(join(tmpdir(), 'nftsync-'));

test('FeedSync writes the published items to the local feed file', async () => {
  const file = join(dir(), 'feed.json'), updatedAt = Date.now() - 60_000;
  const s = new FeedSync({ url: 'https://x', file, fetcher: async () => ({ ok: true, json: async () => ({ updatedAt, items: [row(1), { bad: 1 }] }) }) });
  await s.sync();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].contract, row(1).contract);
  assert.equal(s.status().state, 'ok');
  assert.equal(s.status().stale, false);
});

test('FeedSync reports a stopped publisher as stale and keeps old data on errors', async () => {
  const file = join(dir(), 'feed.json');
  writeFileSync(file, JSON.stringify([row(2)]));
  const old = Date.now() - 2 * 3600_000;
  const s = new FeedSync({ url: 'https://x', file, fetcher: async () => ({ ok: true, json: async () => [row(3)].length && { updatedAt: old, items: [row(2)] } }) });
  await s.sync();
  assert.equal(s.status().stale, true);
  s.fetcher = async () => { throw new Error('boom'); };
  await s.sync();
  assert.equal(s.status().state, 'error');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1);
});

test('FeedSync without a URL stays idle', () => {
  const s = new FeedSync({ url: '', file: join(dir(), 'f.json') });
  s.start();
  assert.equal(s.status().state, 'nourl');
});

test('FeedPublisher strips raw messages and skips unchanged data until the heartbeat', async () => {
  const file = join(dir(), 'feed.json');
  writeFileSync(file, JSON.stringify([row(4)]));
  const calls = [];
  const p = new FeedPublisher({ file, token: 't', gistId: 'g', fetcher: async (url, o) => { calls.push({ url, o }); return { ok: true }; } });
  await p.tick(); await p.tick();
  assert.equal(calls.length, 1);
  const body = JSON.parse(JSON.parse(calls[0].o.body).files['nft-feed.json'].content);
  assert.equal(body.items[0].raw, '');
  assert.ok(body.updatedAt > 0);
  assert.match(calls[0].url, /gists\/g$/);
  p.lastAt = Date.now() - 10 * 60_000;
  await p.tick();
  assert.equal(calls.length, 2);
});
