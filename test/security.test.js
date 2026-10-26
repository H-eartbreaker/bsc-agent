import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { isLocalRequest, isAllowedImageUrl, hasUnsafeKeys, localBoundary, rejectUnsafeBody } from '../engine/security.js';
import { MetaFetcher } from '../engine/live/meta.js';

const req = (headers) => ({ headers });

test('local boundary rejects hostile origins, DNS rebinding and cross-site requests', () => {
  const host = '127.0.0.1:8787';
  assert.equal(isLocalRequest(req({ host }), 8787), true);
  assert.equal(isLocalRequest(req({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }), 8787), true);
  const navigation = { method: 'GET', url: '/', headers: { host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } };
  assert.equal(isLocalRequest(navigation, 8787), true);
  assert.equal(isLocalRequest({ ...navigation, url: '/api/state' }, 8787), false);
  for (const headers of [
    { host, origin: 'https://attacker.example' },
    { host: 'attacker.example:8787' },
    { host, origin: 'null' },
    { host, origin: 'http://127.0.0.1:9000' },
    { host, 'sec-fetch-site': 'cross-site' },
    { host, 'sec-fetch-site': 'same-site' },
    { host: '127.0.0.1:8788' },
    {},
  ]) assert.equal(isLocalRequest(req(headers), 8787), false);
});

test('JSON bodies cannot pollute configuration or settings prototypes', () => {
  assert.equal(hasUnsafeKeys({ exit: { enabled: false }, quickBuy: 0.1 }), false);
  for (const json of ['{"__proto__":{"polluted":true}}', '{"exit":{"constructor":{"prototype":{"polluted":true}}}}', '{"a":[{"prototype":{}}]}']) {
    assert.equal(hasUnsafeKeys(JSON.parse(json)), true);
  }
  assert.equal({}.polluted, undefined);
});

test('image allowlist excludes local networks, userinfo, unknown hosts and unsafe schemes', () => {
  assert.equal(isAllowedImageUrl('https://static.four.meme/logo.png'), true);
  assert.equal(isAllowedImageUrl('https://ipfs.io/ipfs/test'), true);
  for (const url of [
    'http://127.0.0.1:8787/api/state', 'https://127.0.0.1/', 'https://192.168.31.1/',
    'https://[::1]/', 'https://169.254.169.254/', 'file:///etc/passwd',
    'https://static.four.meme.attacker.example/', 'https://static.four.meme@attacker.example/',
    'https://user:pass@static.four.meme/', 'https://static.four.meme:8443/',
  ]) assert.equal(isAllowedImageUrl(url), false);
});

for (const [mode, trade] of [['live', '0'], ['sim', '1']]) {
  test(`wallet execution is blocked before spawning baw in MODE=${mode}, LIVE_TRADE=${trade}`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { runBaw } from './engine/live/baw.js';
      for (const command of [['wallet','send'],['market-order','swap'],['contract-call','execute'],['wallet','signout'],['unknown','command']]) {
        await assert.rejects(runBaw(command), { code: 'READ_ONLY' });
      }
      // A missing stub proves permitted reads reach the spawn path without using a real wallet.
      await assert.rejects(runBaw(['wallet','status']), (e) => e.code !== 'READ_ONLY' && /找不到 baw/.test(e.message));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, MODE: mode, LIVE_TRADE: trade, BAW_BIN: '/nonexistent/bsc-agent-test-baw' },
    });
    assert.equal(result.status, 0, result.stderr);
  });
}

test('token metadata cannot enqueue private or untrusted URLs', () => {
  const meta = new MetaFetcher();
  for (const url of ['http://127.0.0.1:8787/api/state', 'https://192.168.31.1/', 'https://attacker.example/meta.json']) {
    meta.get(url, () => assert.fail('Untrusted metadata was loaded'));
  }
  assert.equal(meta.cache.size, 0);
  assert.equal(meta.queue.length, 0);
  assert.equal(meta.active, 0);
});

test('HTTP and WebSocket enforce the same local boundary', async (t) => {
  const app = express();
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  app.use(localBoundary(port));
  app.use(express.json());
  app.use(rejectUnsafeBody);
  app.get('/api/state', (req, res) => res.json({ mode: 'sim' }));
  app.post('/api/settings', (req, res) => res.json({ ok: true }));
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => isLocalRequest(req, port) });
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${port}`;
  const ok = await fetch(url + '/api/state');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-frame-options'), 'DENY');
  assert.match(ok.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(url + '/api/state', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(url + '/api/settings', { method: 'POST', body: 'autoClaim=true' })).status, 415);
  assert.equal((await fetch(url + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"__proto__":{"polluted":true}}' })).status, 400);
  assert.equal((await fetch(url + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"autoClaim":false}' })).status, 200);
  const allowed = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: url });
  await once(allowed, 'open');
  allowed.close();
  await once(allowed, 'close');
  await new Promise((resolve, reject) => {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://attacker.example' });
    denied.on('error', (error) => { assert.match(error.message, /401/); resolve(); });
    denied.on('open', () => { denied.terminate(); reject(new Error('Foreign WebSocket accepted')); });
  });
});
