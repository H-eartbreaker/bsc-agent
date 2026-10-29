import test from 'node:test';
import assert from 'node:assert/strict';
import { realizedTrades } from '../engine/live/realized.js';
const calc = trades => realizedTrades(new Map([['token', { trades }]]));
const buy = (ts, qty, usd, more = {}) => ({ side: 'buy', ts, tokens: qty, usd, tx: 'buy' + ts, ...more });
const sell = (ts, qty, usd, more = {}) => ({ side: 'sell', ts, tokens: qty, usd, tx: 'sell' + ts, ...more });
test('partial sales use average cost including gas, and a new round starts after exiting', () => {
  const rows = calc([sell(4, 5, 9), buy(1, 10, 10, { feeUsd: 2 }), sell(2, 5, 10, { feeUsd: 1 }), buy(3, 10, 20), sell(5, 10, 12), buy(6, 2, 8), sell(7, 2, 10)]);
  assert.equal(rows[0].pnl, 3); assert.ok(Math.abs(rows[1].cost - 26 / 3) < 1e-9); assert.equal(rows.at(-1).pnl, 2);
});
test('missing initial buys and incoming transfers remain unknown instead of counting free profit', () => {
  assert.equal(calc([sell(1, 5, 10)])[0].pnl, null);
  assert.equal(calc([buy(1, 5, 0, { kind: 'transfer' }), sell(2, 5, 10)])[0].pnl, null);
});
test('outgoing transfers do not realize losses and duplicate transactions do not double count', () => {
  const sale = sell(3, 5, 10);
  const rows = calc([buy(1, 10, 10), sell(2, 5, 0, { kind: 'transfer' }), sale, sale]);
  assert.equal(rows.length, 1); assert.equal(rows[0].pnl, 5);
});
test('quote currencies are excluded to avoid counting both swap legs', () => {
  assert.deepEqual(realizedTrades(new Map([['quote', { trades: [buy(1, 1, 1), sell(2, 1, 2)] }]]), new Set(['quote'])), []);
});
