const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function receiptFrom(url, hash, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rc = (await res.json()).result ?? null;
    return rc && { ...rc, status: Number(rc.status) };   // 原始 RPC 的 status 是十六进制字符串 '0x1'，统一成数字 1（同 ethers）
  } catch {
    return null;
  }
}

// 同时问所有节点，谁先返回回执用谁；某个节点慢或超时不拖累其他节点
export function waitReceipt(hash, urls, { timeoutMs = 180_000, everyMs = 400, perTryMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (rc) => { if (done) return; done = true; clearTimeout(deadline); resolve(rc); };
    const deadline = setTimeout(() => finish(null), timeoutMs);
    for (const url of urls) {
      (async () => {
        while (!done) {
          const rc = await receiptFrom(url, hash, perTryMs);
          if (rc) return finish(rc);
          await sleep(everyMs);
        }
      })();
    }
  });
}
