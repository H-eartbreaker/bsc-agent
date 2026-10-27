import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture({ accept = true, fast = false, real = true } = {}) {
  const requests = [], confirmations = [];
  const context = vm.createContext({
    S: { fast, tokens: new Map([['token', { symbol: 'COIN' }]]) },
    REAL: () => real, esc: String,
    ui: { confirm: async (data) => { confirmations.push(data); return accept; } },
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ status: 'pending' }), text: async () => JSON.stringify({ status: 'pending' }) }; },
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const api ='), source.indexOf('let ws;')) + '\nglobalThis.callApi = api;', context);
  const order = { token: 'token', side: 'buy', amount: 0.1, slippage: 3, wallets: ['baw'], via: 'quick' };
  return { requests, confirmations, call: () => context.callApi('/api/order', order) };
}

test('live quick buys require confirmation and cancellation sends no request', async () => {
  const f = fixture({ accept: false });
  await assert.rejects(f.call(), /已取消下单/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.confirmations[0].address, 'token');
  assert.match(f.confirmations[0].body, /0.1 BNB/);
});

test('confirmed live quick buy sends the selected amount once', async () => {
  const f = fixture(); await f.call();
  assert.equal(f.confirmations.length, 1);
  assert.equal(f.requests.length, 1);
  const body = JSON.parse(f.requests[0].opts.body);
  assert.equal(body.amount, 0.1); assert.equal(body.token, 'token');
});

test('explicit fast mode skips the extra quick confirmation', async () => {
  const f = fixture({ fast: true }); await f.call();
  assert.equal(f.confirmations.length, 0); assert.equal(f.requests.length, 1);
});

test('read-only quote requests do not claim to submit real transactions', async () => {
  const f = fixture({ real: false }); await f.call();
  assert.equal(f.confirmations.length, 0); assert.equal(f.requests.length, 1);
});
