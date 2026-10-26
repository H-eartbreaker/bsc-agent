#!/usr/bin/env node
// 用法：node scripts/latency-report.js --days 1
import { stats } from '../engine/live/latency.js';
const i = process.argv.indexOf('--days'); const days = Number(i > 0 ? process.argv[i + 1] : 1) || 1;
const s = stats(days); const f = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(1) + 's');
const side = { buy: '买入', sell: '卖出', approve: '预授权', transfer: '转出', claim: '领取' };
console.log(`== 下单耗时报告（最近 ${days} 天，共 ${s.count} 笔）==`);
for (const g of s.groups) {
  console.log(`\n【${side[g.side] || g.side} · ${g.platform}】${g.count} 笔，失败 ${g.failed}（${(g.failRate * 100).toFixed(0)}%）`);
  console.log(`  总耗时 p50 ${f(g.p50)} · p90 ${f(g.p90)} · 最慢 ${f(g.max)}`);
  console.log(`  各步平均：${Object.entries(g.stepAvg).map(([n, v]) => `${n} ${f(v)}`).join('，') || '-'}`);
  for (const o of g.slowest) console.log(`  · ${new Date(o.ts).toLocaleString('zh-CN', { hour12: false })} ${o.symbol} ${f(o.latencyMs)} ${o.status === 'failed' ? '失败' : ''} [${o.source}] ${o.steps}`);
}
