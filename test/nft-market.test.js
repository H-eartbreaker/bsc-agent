import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketWatch } from '../engine/nft/marketWatch.js';

const C = '0x' + 'a'.repeat(40);
const res = (status, text = '') => ({ status, ok: status >= 200 && status < 300, text: async () => text });
const html = (price, currency = 'BNB') => `<script>window.x={"a":"}{","collectionProjectStats":{"numOwners":"9","totalListed":"3","platformFloorPrice":{"specifyFloorPrice":{"floorPrice":{"currency":"${currency}","price":${price}}}},"totalVolume":{"price":5}},"nftData":{},"faqs":{"transactions":"7","volume":"0.5"}}</script>`;

function make(routes, extra = {}) {
  let t = 1000;
  const m = new MarketWatch({
    file: '/nonexistent/dir/x.json', gapMs: 0, now: () => t,
    fetcher: async (url) => routes(url), ...extra,
  });
  m.advance = (ms) => { t += ms; };
  return m;
}
const stats = (floor, symbol = 'BNB') => res(200, html(floor, symbol));

test('地板价超过提醒线会产生提醒，低于不会', async () => {
  const m = make(() => stats(0.05));
  m.setMinFloor(0.02);
  await m.refresh([C]);
  assert.equal(m.pendingAlerts().length, 1);
  const m2 = make(() => stats(0.01));
  await m2.refresh([C]);
  assert.equal(m2.pendingAlerts().length, 0);
});

test('读出 24 小时成交量和总成交量', async () => {
  const m = make(() => stats(0.05));
  await m.refresh([C]);
  const p = m.priceOf(C);
  assert.equal(p.volume, 5); assert.equal(p.volume24h, 0.5); assert.equal(p.trades24h, 7);
});

test('非 BNB 计价不提醒', async () => {
  const m = make(() => stats(5, 'ETH'));
  await m.refresh([C]);
  assert.equal(m.pendingAlerts().length, 0);
});

test('已提醒过，涨幅不到 1.5 倍不重复提醒，到了再提醒', async () => {
  let f = 0.05;
  const m = make(() => stats(f));
  await m.refresh([C]); m.ack();
  f = 0.07; await m.refresh([C]);
  assert.equal(m.pendingAlerts().length, 0);
  f = 0.08; await m.refresh([C]);
  assert.equal(m.pendingAlerts().length, 1);
});

test('查不到集合记为 none，6 小时内不重问', async () => {
  let n = 0;
  const m = make(() => { n++; return res(404); });
  await m.refresh([C]); await m.refresh([C]);
  assert.equal(n, 1);
  assert.equal(m.priceOf(C).status, 'none');
  m.advance(6 * 3600_000 + 1); await m.refresh([C]);
  assert.equal(n, 2);
});

test('403 / 429 暂停 5 分钟并给出错误', async () => {
  const a = make(() => res(403));
  await a.refresh([C]);
  assert.equal(a.view().paused, true); assert.match(a.view().error, /OKX/);
  const b = make(() => res(429));
  await b.refresh([C]);
  assert.equal(b.view().paused, true);
  b.advance(5 * 60_000 + 1); assert.equal(b.view().paused, false);
});

test('页面格式变了读不到价格会报错、不乱给价；没挂单时地板价为空', async () => {
  const bad = make(() => res(200, '<html>nothing</html>'));
  await bad.refresh([C]);
  assert.equal(bad.priceOf(C).floor, null); assert.match(bad.view().error, /暂时没读到/);
  const empty = make(() => res(200, html('null')));
  await empty.refresh([C]);
  assert.equal(empty.priceOf(C).status, 'ok'); assert.equal(empty.priceOf(C).floor, null);
  assert.equal(empty.pendingAlerts().length, 0);
});

test('提醒线非法会拒绝；调低提醒线后立刻重新判断', async () => {
  const m = make(() => stats(0.05));
  assert.throws(() => m.setMinFloor(-1)); assert.throws(() => m.setMinFloor('abc')); assert.throws(() => m.setMinFloor(5000));
  m.setMinFloor(1); await m.refresh([C]);
  assert.equal(m.pendingAlerts().length, 0);
  m.setMinFloor(0.01); m.reevaluate();
  assert.equal(m.pendingAlerts().length, 1);
});

test('24h 成交量达到提醒线会提醒；设为 0 不提醒', async () => {
  const m = make(() => stats(null));
  m.setMinVolume24h(0.4); await m.refresh([C]);
  assert.equal(m.pendingAlerts()[0].reason, 'volume');
  const off = make(() => stats(null)); off.setMinVolume24h(0); await off.refresh([C]);
  assert.equal(off.pendingAlerts().length, 0);
  assert.throws(() => off.setMinVolume24h(-1));
});

test('检查间隔：5–1440 分钟，超出范围拒绝；改间隔后下一轮按新间隔排', async () => {
  const m = make(() => stats(0.05));
  assert.equal(m.state.intervalMin, 15);
  assert.throws(() => m.setIntervalMin(1)); assert.throws(() => m.setIntervalMin(2000)); assert.throws(() => m.setIntervalMin('x'));
  m.start(async () => [C]);
  let ms; m.schedule = (x = m.state.intervalMin * 60_000) => { ms = x; };
  m.setIntervalMin(30);
  assert.equal(m.state.intervalMin, 30); assert.equal(ms, 30 * 60_000);
  clearTimeout(m.timer);
});

test('页面偶尔没带数据，重试后能读到', async () => {
  let n = 0;
  const m = make(() => (++n < 3 ? res(200, '<html>no data</html>') : stats(0.05)));
  await m.refresh([C]);
  assert.equal(n, 3); assert.equal(m.priceOf(C).floor, 0.05); assert.equal(m.view().error, '');
});
