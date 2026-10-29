import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, periodStats, monthCells } from '../public/portfolio.js';
test('calendar uses device-local dates and Monday-first leap-month cells',()=>{
  assert.equal(dayKey(new Date(2024,1,29,23,59)), '2024-02-29');
  const cells=monthCells('2024-02');assert.equal(cells.indexOf('2024-02-01'),3);assert.equal(cells.filter(Boolean).length,29);assert.equal(cells.length%7,0);
});
test('calendar totals exclude missing costs without turning unknown results into zero',()=>{
  const events=[{ts:new Date(2026,9,29,12).getTime(),pnl:4,cost:10},{ts:new Date(2026,9,29,13).getTime(),pnl:null,cost:null},{ts:new Date(2026,9,28,13).getTime(),pnl:-1,cost:2}];
  const day=periodStats(events,'2026-10-29');assert.equal(day.pnl,4);assert.equal(day.unknown,1);assert.equal(day.sells,2);assert.equal(day.cost,10);
  const month=periodStats(events,'2026-10');assert.equal(month.pnl,3);assert.equal(month.wins,1);assert.equal(month.losses,1);
});
