// Observe the already submitted call. Never execute/re-submit a transaction here.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lower = value => String(value || '').toLowerCase();

export async function waitForContractConfirmation({ provider, history, wallet, to, valueWei, inputData,
  nonce, startedAt, requestId, orderId, message, label,
  maxMs = 15 * 60_000, intervalMs = 3000, now = Date.now, wait = sleep }) {
  const pending = () => Object.assign(new Error(`${label} 仍待确认：${message || '请在币安 App 确认'}；不要重复提交`),
    { code: 'APP_CONFIRM', requestId, orderId });
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw pending();
  const end = now() + maxMs;
  while (now() < end) {
    let data;
    try { data = await history(startedAt - 5000); } catch { await wait(intervalMs); continue; }
    const rows = data?.transactions || data?.list || data?.items || [];
    const hashes = new Set(rows.flatMap(row => [row.txHash, ...(row.txHashList || []).map(t => typeof t === 'string' ? t : t.txHash)]).filter(h => /^0x[\da-f]{64}$/i.test(h)));
    for (const hash of hashes) {
      try {
        const tx = await provider.getTransaction(hash);
        if (!tx || lower(tx.from) !== lower(wallet) || lower(tx.to) !== lower(to)
          || lower(tx.data) !== lower(inputData) || BigInt(tx.value) !== BigInt(valueWei) || tx.nonce !== nonce) continue;
        const receipt = await provider.getTransactionReceipt(hash);
        if (!receipt) continue;
        // The nonce and exact payload disambiguate identical historical calls; the block time adds a second check.
        const block = await provider.getBlock(receipt.blockNumber);
        if (!block || block.timestamp * 1000 < startedAt - 5000) continue;
        if (receipt.status !== 1) throw Object.assign(new Error(`${label} 链上执行失败：${hash}`), { code: 'CHAIN_FAILED', tx: hash });
        return hash;
      } catch (error) { if (error.code === 'CHAIN_FAILED') throw error; }
    }
    await wait(intervalMs);
  }
  throw pending();
}
