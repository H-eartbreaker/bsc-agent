import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { hasApiAccess, loadApiToken, tokenMatches } from '../engine/apiAuth.js';
import { isLocalRequest } from '../engine/security.js';
const token = 'fixture-'.repeat(8);
test('scripts need a token; same-origin browsers still work; tokens cannot bypass the local boundary', () => {
  const req = { method: 'POST', headers: { host: '127.0.0.1:8787' } };
  assert.equal(hasApiAccess(req, token), false);
  assert.equal(hasApiAccess({ ...req, headers: { ...req.headers, 'x-bsc-agent-token': token } }, token), true);
  assert.equal(hasApiAccess({ ...req, headers: { origin: 'http://127.0.0.1:8787' } }, token), true);
  assert.equal(hasApiAccess({ method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } }, token), true);
  assert.equal(hasApiAccess({ method: 'GET', headers: {} }, token), false);
  assert.equal(hasApiAccess({ method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } }, token, true), false);
  assert.equal(tokenMatches(token + 'wrong', token), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(isLocalRequest({ ...req, headers: { ...req.headers, origin: 'https://evil.example', 'x-bsc-agent-token': token } }, 8787), false);
});
test('generated token is persistent and private, while invalid configured values fail closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bsc-agent-api-auth-')); t.after(() => rmSync(dir, { recursive: true }));
  const f = pathToFileURL(join(dir, 'api-token')), first = loadApiToken(f, '');
  assert.equal(first.length, 64); assert.equal(loadApiToken(f, ''), first);
  assert.equal(statSync(f).mode & 0o777, 0o600); assert.equal(readFileSync(f, 'utf8').trim(), first);
  assert.throws(() => loadApiToken(f, 'short'), /32/);
});

test('HTTP and WebSocket protect authenticated script access without weakening browser origin checks', async t => {
  const [{ default: express }, http, { once }, { WebSocket, WebSocketServer }, { apiAuth, hasApiAccess }, { localBoundary }] = await Promise.all([import('express'), import('node:http'), import('node:events'), import('ws'), import('../engine/apiAuth.js'), import('../engine/security.js')]);
  const app = express(), server = http.createServer(app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port, url = `http://127.0.0.1:${port}`;
  app.use(localBoundary(port)); app.use(apiAuth(token)); app.use(express.json()); app.get('/api/state', (req, res) => res.json({ ok: true })); app.post('/api/test', (req, res) => res.json({ ok: true }));
  const wss = new WebSocketServer({ server, verifyClient: ({ req }) => isLocalRequest(req, port) && hasApiAccess(req, token, true) });
  t.after(async () => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  assert.equal((await fetch(url + '/api/state')).status, 403);
  assert.equal((await fetch(url + '/api/state', { headers: { 'x-bsc-agent-token': token } })).status, 200);
  assert.equal((await fetch(url + '/api/test', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal((await fetch(url + '/api/state', { headers: { origin: 'https://evil.example', 'x-bsc-agent-token': token } })).status, 403);
  const ws = new WebSocket(url.replace('http:', 'ws:'), { headers: { 'x-bsc-agent-token': token } }); await once(ws, 'open'); ws.close(); await once(ws, 'close');
  await new Promise((resolve, reject) => { const denied = new WebSocket(url.replace('http:', 'ws:')); denied.on('error', e => { assert.match(e.message, /401/); resolve(); }); denied.on('open', () => { denied.terminate(); reject(Error('Unauthenticated WebSocket allowed')); }); });
});
