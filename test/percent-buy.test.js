import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { costForPct } from '../engine/live/costForPct.js';

function fixture(quote = async () => ({ bnb: 0.12 })) {
  const state = { selected: 'token', tokens: new Map([['token', { address: 'token', symbol: 'COIN' }]]), side: 'buy', amtMode: 'pct', slippage: 3, selWallets: new Set(['baw']), activeWallet: 'baw', fast: true };
  const nodes = { '#amount': { value: '1' }, '#quote': {}, '#route': {}, '#submit': { classList: { add() {}, remove() {} } } };
  const messages = [], calls = []; let pending;
  const context = vm.createContext({ S: state, $: (id) => nodes[id], api: async (url, body) => { calls.push({ url, body }); return url.startsWith('/api/cost-for-pct') ? quote() : { out: null }; }, toast: (o) => messages.push(o.reason), note: (text) => messages.push(text), topPop() {}, zhErr: (s) => s, esc: (s) => s, clearTimeout() {}, setTimeout: (fn) => { pending = fn; }, setInterval() {} });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(source.indexOf('let qTimer;'), source.indexOf('// 普通提示（不是订单结果）')), context);
  return { state, nodes, messages, calls, submit: context.submitOrder, refresh: async () => { context.refreshQuote(); await pending(); } };
}

test('percentage quote failures retain their reason and cannot create an order', async () => {
  for (const quote of [async () => ({ bnb: 0, error: '找不到兑换路径' }), async () => { throw new Error('节点限流'); }]) {
    const f = fixture(quote);
    await f.submit();
    assert.match(f.messages[0], /买入比例换算失败：(找不到兑换路径|节点限流)/);
    assert.equal(f.calls.some((c) => c.url === '/api/order'), false);
    assert.equal(f.messages.includes('请输入买入金额'), false);
  }
});

test('one percent uses its fresh BNB quote when creating an order', async () => {
  const f = fixture();
  f.state.pctBnb = 0.9;
  await f.submit();
  assert.match(f.calls[0].url, /pct=1&/);
  const orders = f.calls.filter((c) => c.url === '/api/order');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].body.amount, 0.12);
});

test('empty wallet selection is reported before quoting, without a misleading amount error', async () => {
  const f = fixture(); f.state.selWallets.clear();
  await f.submit();
  assert.equal(f.messages[0], '请先选择执行钱包');
  assert.equal(f.calls.length, 0);
});

test('the quote panel shows percentage failures instead of requesting a zero-amount preview', async () => {
  const f = fixture(async () => ({ bnb: 0, error: '已达单钱包上限 1%' }));
  await f.refresh();
  assert.match(f.nodes['#quote'].innerHTML, /已达单钱包上限/);
  assert.equal(f.calls.length, 1);
});

test('changing the percentage while a quote is pending discards the old order and preview', async () => {
  const f = fixture(async () => { f.nodes['#amount'].value = '2'; return { bnb: 0.12 }; });
  await f.submit();
  assert.equal(f.calls.some((c) => c.url === '/api/order'), false);
  assert.match(f.messages[0], /参数已改变/);
  f.nodes['#amount'].value = '1';
  await f.refresh();
  assert.equal(f.nodes['#quote'].innerHTML, undefined);
});

test('percentage sizing preserves the underlying preview failure', async () => {
  const q = await costForPct({ market: { get: () => ({ platform: 'flap' }) }, trader: { preview: async () => ({ error: '流动性不足' }) }, live: true }, { token: 'token', pct: 1 });
  assert.equal(q.bnb, 0);
  assert.equal(q.error, '流动性不足');
});

test('multi-wallet percentage buys use each wallet quote and cancel if inputs change during the second quote', async () => {
  for (const change of [false, true]) {
    let count = 0;
    const f = fixture(async () => { count++; if (change && count === 2) f.nodes['#amount'].value = '2'; return { bnb: count === 1 ? 0.12 : 0.25 }; });
    f.state.selWallets.add('wallet2'); await f.submit();
    const orders = f.calls.filter(c => c.url === '/api/order');
    assert.equal(count, 2);
    assert.deepEqual(orders.map(o => o.body.amount), change ? [] : [0.12, 0.25]);
  }
});
