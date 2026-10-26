import test from 'node:test';
import assert from 'node:assert/strict';
import { readAgeRange, matchesTokenAge } from '../public/trench-time.js';

const now = 1_800_000_000_000;
const token = (minutes) => ({ createdAt: now - minutes * 60_000 });
test('empty and old presets leave tokens visible, including unknown creation time', () => {
  for (const f of [{}, { minAge: '', maxAge: '' }]) {
    assert.equal(matchesTokenAge(token(3000), f, now), true);
    assert.equal(matchesTokenAge({}, f, now), true);
  }
});
test('creation-age window includes bounds and expires without needing a token update', () => {
  const f = { minAge: '2.5', maxAge: '10' };
  assert.equal(matchesTokenAge(token(2.49), f, now), false);
  assert.equal(matchesTokenAge(token(2.5), f, now), true);
  assert.equal(matchesTokenAge(token(10), f, now), true);
  assert.equal(matchesTokenAge(token(10), f, now + 1), false);
  assert.equal(matchesTokenAge({}, f, now), false);
});
test('one-sided and zero bounds work independently', () => {
  assert.equal(matchesTokenAge(token(100), { minAge: '10' }, now), true);
  assert.equal(matchesTokenAge(token(11), { maxAge: '10' }, now), false);
  assert.equal(matchesTokenAge(token(0), { maxAge: '0' }, now), true);
  assert.deepEqual(readAgeRange({ minAge: '0', maxAge: '' }), { min: 0, max: null });
});
test('invalid or reversed ranges cannot silently turn into an unlimited filter', () => {
  for (const f of [{ minAge: '-1' }, { maxAge: 'Infinity' }, { minAge: 'abc' }, { minAge: '20', maxAge: '10' }]) {
    assert.throws(() => readAgeRange(f));
    assert.equal(matchesTokenAge(token(5), f, now), false);
  }
});
