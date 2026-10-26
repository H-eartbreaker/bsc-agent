// Shared read-only sizing for manual percentage orders and automatic strategies.
export async function costForPct({ market, trader, live: LIVE }, q) {
  let pct = Math.min(100, Number(q.pct) || 0);
  if (!(pct > 0)) return ({ bnb: 0 });
  // Four Agent 专属币每个钱包最多持有总量 1%，超过的部分买不到，按 1% 算，避免反推出离谱的 BNB
  const tk = market.get?.(q.token); let capped = false; const asked = pct; const notes = [];
  // Four / Gang 都是单钱包最多持有总量 1%
  if ((tk?.platform === 'four' || tk?.platform === 'gang') && pct > 1) { pct = 1; capped = true; }
  let target = 1_000_000_000 * pct / 100;
  // Four 单钱包最多 1%：扣掉当前持仓，只买剩下的部分
  if (tk?.platform === 'four') {
    try {
      const w = trader.wallet?.(q.wallet); const mine = w ? await trader.tokenBal(w, tk.address) : 0;
      const room = (1e7 - (mine || 0)) * 0.99;
      if (room <= 1e7 * 0.001) return ({ bnb: 0, capReached: true, error: '已达单钱包上限 1%' });
      if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
    } catch { /* 读不到持仓就按 1% */ }
  }
  // Gang 老盘：合约 walletRoom 直接给出这个钱包还能买多少
  if (tk?.source === 'gang' && (trader.useGang?.(tk) || trader.useGangV2?.(tk))) {
    try {
      const w = trader.wallet?.(q.wallet);
      const room = !w ? 1e7 : (trader.useGangV2(tk) ? Number(await trader.gangV2.room(tk.address, w.address)) / 1e18 : await trader.gangTrade.walletRoom(tk.address, w.address)) * 0.99;
      if (room <= 1e7 * 0.001) return ({ bnb: 0, capReached: true, error: '已达单钱包上限 1%' });
      if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
    } catch { /* 读不到额度就按 1% */ }
  }
  // Flap Agent 曲线有单钱包持仓上限 maxSharesPerWallet：目标不超过「上限 - 已持有」再留 1% 余量
  if (tk?.market && tk.source === 'agent-curve' && trader.portal?.provider) {
    try {
      const { ethers } = await import('ethers');
      const w = trader.wallet?.(q.wallet);
      const c = new ethers.Contract(tk.market, ['function maxSharesPerWallet() view returns (uint256)', 'function sharesOf(address) view returns (uint256)'], trader.portal.provider);
      const [cap, mine] = await Promise.all([c.maxSharesPerWallet().catch(() => 0n), w ? c.sharesOf(w.address).catch(() => 0n) : 0n]);
      if (cap > 0n) {
        const room = Number(ethers.formatEther(cap - (mine > cap ? cap : mine))) * 0.99;
        if (room <= 0) return ({ bnb: 0, capReached: true, error: '已达单钱包持仓上限' });
        if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
      }
    } catch { /* 读不到上限就按原目标 */ }
  }
  try {
    let a = 0.01, ok = false;
    for (let i = 0; i < 6; i++) {
      const p = await trader.preview({ walletId: q.wallet, token: q.token, side: 'buy', amount: a, slippage: Number(q.slippage || 35) });
      if (!(p?.out > 0) || !Number.isFinite(p.out)) return { bnb: 0, error: p?.error || p?.note || '拿不到报价，请稍后重试' };
      ok = true;
      const next = a * target / p.out;
      if (Math.abs(next - a) / a < 0.002) { a = next; break; }
      a = next;
    }
    if (!ok) return ({ bnb: 0, error: '拿不到报价' });
    // 下单前一次性把金额压到能成交的范围：持仓上限 → 单笔上限 → 余额（留 0.002 BNB 付 gas），不让后端先失败再重试
    if (capped) notes.push(asked > 1 && pct >= 0.98 ? `${asked}% 超过单钱包上限 1%，已按 1% 买入` : `${asked}% 超过单钱包剩余额度，已按剩余额度（约 ${pct}%）买入`);
    const maxTrade = LIVE ? Number(trader.status?.maxTradeBnb) || 0 : 0;
    if (maxTrade > 0 && a > maxTrade) { a = maxTrade; notes.push(`超过单笔上限 ${maxTrade} BNB，已按 ${maxTrade} BNB 买入`); }
    const w = trader.wallet?.(q.wallet); const bal = Number(w?.bnb) || 0;
    if (LIVE && bal > 0 && a > bal - 0.002) { a = Math.max(0, bal - 0.002); notes.push(`BNB 余额不足，已按余额 ${a.toFixed(4)} BNB 买入`); }
    if (!(a > 0)) return ({ bnb: 0, error: 'BNB 余额不足' });
    return ({ bnb: +a.toFixed(6), tokens: target, pct, capped, note: notes.join('；') || null });
  } catch (e) { return { bnb: 0, error: e.message }; }
}
