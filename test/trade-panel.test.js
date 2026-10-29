import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function qbBind(el)');
const code = source.slice(start, source.indexOf("\ndocument.addEventListener('click'", start));
function fixture() {
  const handlers = {}, orders = [], notes = [];
  const state = { selected: 'token-a', activeWallet: 'wallet-a' };
  const panel = { floating: false, cb: '0.03', cs: '50', pb: 1, ps: 2 };
  const input = { value: '0.03' };
  const el = { addEventListener(name, fn) { (handlers[name] ||= []).push(fn); }, querySelector: () => input };
  let saves = 0, renders = 0;
  const context = { S: state, QBP: panel, submitOrder: (order) => orders.push(order), note: (...args) => notes.push(args),
    qbSave: () => saves++, renderQB: () => renders++, Event: class {}, window: { dispatchEvent() {} } };
  vm.createContext(context); vm.runInContext(code, context); context.qbBind(el);
  const click = async (dataset) => { const button = { dataset }; for (const fn of handlers.click) await fn({ target: { closest: () => button } }); };
  return { panel, input, orders, notes, click, stats: () => ({ saves, renders }) };
}
test('quick preset orders retain the active wallet and do not force confirmation bypass', async () => {
  const f = fixture(); await f.click({ qbgo: 'buy:0.05' });
  assert.equal(f.orders.length, 1); const order = f.orders[0];
  assert.equal(order.token, 'token-a'); assert.equal(order.side, 'buy');
  assert.deepEqual([...order.wallets], ['wallet-a']); assert.equal(order.amountFor(), 0.05);
  assert.notEqual(order.direct, true);
});
test('custom sell rejects invalid percentages before submitting', async () => {
  const f = fixture(); f.input.value = '101'; await f.click({ qbcgo: 'sell' });
  assert.equal(f.orders.length, 0); assert.match(f.notes[0][0], /不能超过 100/);
  f.input.value = '25'; await f.click({ qbcgo: 'sell' });
  assert.equal(f.orders.length, 1); assert.equal(f.orders[0].amountFor(), 25); assert.notEqual(f.orders[0].direct, true);
});
test('docking preserves both custom inputs and selected presets and sends no order', async () => {
  const f = fixture(); await f.click({ qbdock: '' }); assert.equal(f.panel.floating, true);
  await f.click({ qbdock: '' }); assert.equal(f.panel.floating, false);
  assert.deepEqual([f.panel.cb, f.panel.cs, f.panel.pb, f.panel.ps], ['0.03', '50', 1, 2]);
  assert.equal(f.orders.length, 0); assert.deepEqual(f.stats(), { saves: 2, renders: 2 });
});
