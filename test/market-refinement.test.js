import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { LiveMarket } from '../engine/live/liveMarket.js';

function marketFixture(rows) {
  const market = Object.create(LiveMarket.prototype);
  market.four = { tokenTrades: async (_address, opts) => {
    assert.equal(opts.lookbackBlocks, 20_000);
    return rows;
  } };
  return { market, token: { address: 'token', candles: [], trades: [], price: 0 } };
}
const trade = (tx, ts, price = 1) => ({ tx, ts, side: 'buy', tokens: 10, bnb: 2, price });

test('Four charts hydrate history and preserve newer live prices without doubling volume', async () => {
  const history = [trade('older', 1000), trade('live', 2000, 2)];
  const { market, token } = marketFixture(history);
  token.trades = [history[1]];
  token.price = 2; token.lastTradeAt = 2000;
  market.pushCandle(token, 2000, 2, 2);
  await market.refreshFourHistory(token);
  assert.equal(token.historyState, 'ready');
  assert.equal(token.price, 2);
  assert.equal(token.candles.length, 2);
  assert.equal(token.candles.reduce((sum, c) => sum + c.v, 0), 4);
  token._fourHistoryAt = 0;
  await market.refreshFourHistory(token);
  assert.equal(token.candles.reduce((sum, c) => sum + c.v, 0), 4);
  assert.equal(token.trades.length, 2);
});

test('concurrent history requests share one RPC call and retry after an error', async () => {
  const { market, token } = marketFixture([]);
  let calls = 0, finish;
  market.four.tokenTrades = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const one = market.refreshFourHistory(token), two = market.refreshFourHistory(token);
  finish([]); await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.equal(token.historyState, 'empty');
  token._fourHistoryAt = 0;
  market.four.tokenTrades = async () => { throw new Error('rate limit'); };
  await market.refreshFourHistory(token);
  assert.equal(token.historyState, 'error');
  token._fourHistoryAt = 0;
  market.four.tokenTrades = async () => [trade('retry', 3000)];
  await market.refreshFourHistory(token);
  assert.equal(token.historyState, 'ready');
});

test('bounded empty history is marked partial, without synthetic candles', async () => {
  const rows = []; rows.historyPartial = true;
  const { market, token } = marketFixture(rows);
  await market.refreshFourHistory(token);
  assert.equal(token.historyPartial, true);
  assert.equal(token.candles.length, 0);
});

// Exercise the shipped click path with a fake API. No wallet or network is used.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function trenchBuy(');
const end = source.indexOf('\ndocument.addEventListener', start);
function buyFixture() {
  const posts = [], percents = [], notes = [];
  const state = { marketBuyMode: 'pct', marketBuyBnb: 0.02, slippage: 5, tokens: new Map([['token', { symbol: 'ABC' }]]), quickWallet: 'single', selWallets: new Set(['other']) };
  const context = vm.createContext({ S: state, P: () => ({ amt: 0.9, slip: 35 }), pBusy: new Set(), pulseBuy1: (a) => percents.push(a), note: (s) => notes.push(s), topPop: () => {}, api: async (url, body) => { posts.push({ url, body }); return [{ status: 'dry_run' }]; } });
  vm.runInContext(source.slice(start, end), context);
  return { state, posts, percents, notes, buy: context.trenchBuy };
}
test('market percent and fixed BNB use explicit mode and a single wallet, independent from trench', async () => {
  const f = buyFixture();
  await f.buy('token', 'market');
  assert.deepEqual(f.percents, ['token']); assert.equal(f.posts.length, 0);
  f.state.marketBuyMode = 'bnb';
  await f.buy('token', 'market');
  assert.equal(f.posts[0].body.amount, 0.02);
  assert.equal(f.posts[0].body.slippage, 5);
  assert.equal(f.posts[0].body.wallets.join(), 'single');
  await f.buy('token', 'new');
  assert.equal(f.posts[1].body.amount, 0.9);
  assert.equal(f.posts[1].body.slippage, 35);
  f.state.marketBuyBnb = 0;
  await f.buy('token', 'market');
  assert.equal(f.posts.length, 2); assert.equal(f.notes.length, 1);
});

test('Four chart history scans at most the requested block window', async () => {
  const { FourMeme } = await import('../engine/live/fourMeme.js');
  const four = Object.create(FourMeme.prototype);
  four.core = { tokens: async () => ({ createBlock: 100 }) };
  four.provider = { getBlockNumber: async () => 50_000 };
  four.headAt = { n: 50_000, ms: Date.now() };
  const ranges = [];
  four.logs = async (_topics, from, to) => { ranges.push([from, to]); return []; };
  const rows = await four.tokenTrades('0x0000000000000000000000000000000000000001', { lookbackBlocks: 20_000 });
  assert.equal(rows.historyPartial, true);
  assert.equal(ranges[0][0], 30_001);
  assert.equal(ranges.at(-1)[1], 50_000);
  assert.equal(ranges.reduce((n, [a, b]) => n + b - a + 1, 0), 20_000);
});
