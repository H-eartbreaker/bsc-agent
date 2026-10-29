// 已实现盈亏按时间顺序使用移动平均成本；缺少买入记录时不补造成本。
export function realizedTrades(history, quoteTokens = new Set()) {
  const out = [];
  for (const [token, row] of history) {
    if (quoteTokens.has(token.toLowerCase())) continue;
    let amount = 0, cost = 0, known = true;
    const seen = new Set();
    for (const x of [...row.trades].sort((a, b) => a.ts - b.ts || (a.side === 'buy' ? -1 : 1))) {
      const key = `${x.tx}:${x.side}`;
      if (x.tx && seen.has(key)) continue;
      seen.add(key);
      const qty = Number(x.tokens), usd = Number(x.usd), fee = Number(x.feeUsd || 0);
      if (!(qty > 0) || !Number.isFinite(usd) || !Number.isFinite(fee)) continue;
      if (x.side === 'buy') {
        if (amount < 1e-12) { amount = 0; cost = 0; known = true; }
        amount += qty;
        if (x.kind === 'transfer' || !(usd > 0)) known = false;
        else cost += usd + fee;
      } else {
        const hasBasis = known && amount > 0 && qty <= amount * (1 + 1e-8);
        const basis = hasBasis ? cost * Math.min(1, qty / amount) : null;
        if (x.kind !== 'transfer' && usd > 0) out.push({ token, ts: x.ts, tx: x.tx, proceeds: usd, cost: basis, pnl: basis == null ? null : usd - fee - basis });
        if (amount > 0) cost *= Math.max(0, 1 - qty / amount);
        amount = Math.max(0, amount - qty);
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
