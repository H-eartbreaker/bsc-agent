import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('429 后进入冷却，冷却期内不再发请求；之后的请求直接返回 limited', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { status: 429, ok: false, json: async () => ({ status: { error_code: 429 } }) }; };
  const { geckoJson, geckoCooldownMs } = await import('../engine/live/gecko.js');
  const a = await geckoJson('https://api.geckoterminal.com/api/v2/x');
  assert.equal(a.limited, true);
  assert.ok(geckoCooldownMs() > 50_000, '冷却约 60 秒');
  const before = calls;
  const b = await geckoJson('https://api.geckoterminal.com/api/v2/y');
  assert.equal(b.limited, true);
  assert.equal(calls, before, '冷却期内没有新请求');
});
