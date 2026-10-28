import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { waitReceipt } from '../engine/live/receipts.js';

const HASH = '0x' + 'ab'.repeat(32);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// 每个节点的行为：函数返回 result（null 表示还没上链），或 'hang' 表示永不回应（直到 abort）
function stubRpc(behaviors) {
  const seen = [];
  globalThis.fetch = (url, opts) => {
    const b = behaviors[url];
    const body = JSON.parse(opts.body);
    seen.push({ url, method: body.method, params: body.params });
    if (b === 'hang') return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const result = typeof b === 'function' ? b() : b;
    return Promise.resolve({ json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
  };
  return seen;
}

test('轮询到回执后返回', async () => {
  let n = 0;
  const seen = stubRpc({ 'http://a': () => (++n < 3 ? null : { status: '0x1' }) });
  const rc = await waitReceipt(HASH, ['http://a'], { everyMs: 5, timeoutMs: 2000 });
  assert.equal(rc.status, 1);
  assert.equal(seen[0].method, 'eth_getTransactionReceipt');
  assert.deepEqual(seen[0].params, [HASH]);
  assert.equal(n, 3);
});

test('一个节点挂起不拖慢另一个节点', async () => {
  stubRpc({ 'http://slow': 'hang', 'http://fast': { status: '0x1', transactionHash: HASH } });
  const t = Date.now();
  const rc = await waitReceipt(HASH, ['http://slow', 'http://fast'], { everyMs: 5, perTryMs: 3000, timeoutMs: 5000 });
  assert.equal(rc.status, 1);
  assert.ok(Date.now() - t < 1000, `耗时 ${Date.now() - t}ms`);
});

test('超时没有回执返回 null', async () => {
  stubRpc({ 'http://a': null });
  const rc = await waitReceipt(HASH, ['http://a'], { everyMs: 5, perTryMs: 100, timeoutMs: 300 });
  assert.equal(rc, null);
});
