import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtResolver, toHttp } from '../engine/nft/artResolver.js';

test('ipfs 地址转成网关地址', () => {
  assert.equal(toHttp('ipfs://Qm123/1.png'), 'https://ipfs.io/ipfs/Qm123/1.png');
});

test('内嵌 JSON 的 tokenURI 能取到 image，失败的入口会跳过', async () => {
  const json = Buffer.from(JSON.stringify({ image: 'ipfs://QmAbc/a.png' })).toString('base64');
  const r = new ArtResolver({ provider: null, fetchJson: async () => ({}) });
  r.lookup = ArtResolver.prototype.lookup;
  assert.deepEqual(await r.metadata('data:application/json;base64,' + json), { image: 'ipfs://QmAbc/a.png' });
  assert.deepEqual(await r.metadata('data:application/json,%7B%22image%22%3A%22x%22%7D'), { image: 'x' });
  assert.equal(await r.metadata('ftp://x'), null);
});

test('同一合约并发只查一次，查不到的结果会缓存', async () => {
  let n = 0;
  const r = new ArtResolver({ provider: null, fetchJson: async () => ({}), now: () => 1 });
  r.lookup = async () => { n++; return null; };
  await Promise.all([r.resolve('0xAbC'), r.resolve('0xabc')]);
  await r.resolve('0xabc');
  assert.equal(n, 1);
});

test('网络/限流失败只缓存很短时间，之后会重新查', async () => {
  let t = 1000, n = 0;
  const r = new ArtResolver({ provider: null, fetchJson: async () => ({}), now: () => t });
  r.lookup = async (_c, state) => { n++; state.transient = true; return null; };
  await r.resolve('0xabc'); await r.resolve('0xabc');
  assert.equal(n, 1);
  t += 100 * 1000;
  await r.resolve('0xabc');
  assert.equal(n, 2);
});

test('lookup 遇到非合约回滚的错误会标记为临时失败', async () => {
  const r = new ArtResolver({ provider: null, fetchJson: async () => ({}) });
  const state = {};
  assert.equal(await r.lookup('0x8fb11ccf7b2e2ffd21a5de0da8569e51ddbe9bf4', state), null);
  assert.equal(state.transient, true);
});
