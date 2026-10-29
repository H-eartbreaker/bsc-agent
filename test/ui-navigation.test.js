import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('main navigation keeps tracking and sniping as separate destinations', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const nav = html.match(/<nav class="viewsw"[\s\S]*?<\/nav>/)?.[0] || '';
  assert.match(nav, /data-view="track"/);
  assert.match(nav, /data-view="snipe"/);
  assert.match(nav, /data-view="nft"/);
  assert.doesNotMatch(nav, /追踪\/狙击/);
  assert.doesNotMatch(nav, /data-also=/);
});
