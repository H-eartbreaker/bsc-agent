import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const openTokenSource = source.slice(source.indexOf('function openToken(t)'), source.indexOf('\nsetInterval(', source.indexOf('function openToken(t)')));

test('opening any launchpad token from All preserves the All filter in its route', () => {
  const context = vm.createContext({ S: { view: 'trade', platform: 'all' }, location: { hash: '' } });
  vm.runInContext(openTokenSource, context);
  for (const platform of ['four', 'flap', 'gang']) {
    context.openToken({ platform, address: 'fixture', stage: 'curve' });
    assert.equal(context.location.hash, '#/all/curve/fixture');
    assert.equal(context.S.platform, 'all');
  }
  context.openToken({ platform: 'four', address: 'fixture', stage: 'dex' });
  assert.equal(context.location.hash, '#/all/dex/fixture');
});

test('specific launchpad and trench navigation retain their existing behavior', () => {
  const scroll = {};
  const context = vm.createContext({ S: { view: 'pulse', platform: 'four' }, location: { hash: '' }, pulseScroll: scroll, $$: () => [{ id: 'new', scrollTop: 42 }] });
  vm.runInContext(openTokenSource, context);
  context.openToken({ platform: 'four', address: 'fixture', stage: 'curve' });
  assert.equal(context.location.hash, '#/four/curve/fixture');
  assert.equal(scroll.new, 42);
});
