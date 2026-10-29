// 解析 Aibot 打新提示群的 NFT 推送消息。
// 免费判断只看正文里有没有带数字的 BNB 价格或"付费"字样，不只看价格行（CHARM2 价格行写免费，正文却是 0.0006 BNB 付费抽取）。

const ADDR = /0x[0-9a-fA-F]{40}/;

export function parseNftPost(text) {
  const t = String(text || '');
  if (!/NFT[：:]/.test(t)) return null;
  const contract = (t.match(ADDR) || [])[0];
  if (!contract) return null;

  const head = t.match(/NFT[：:]\s*(.+)/);
  const nameLine = head ? head[1].trim() : '';
  const sym = nameLine.match(/^(.*?)[（(]([^）)]+)[）)]\s*$/);
  const name = sym ? sym[1].trim() : nameLine;
  const symbol = sym ? sym[2].trim() : '';

  const priceLine = (t.match(/价格[：:]\s*(.+)/) || [])[1] || '';
  const priceFree = /免费/.test(priceLine) && !/\d(\.\d+)?\s*BNB/.test(priceLine);

  const paidHints = t.split('\n').filter((line) => {
    if (/价格[：:]/.test(line) && /免费/.test(line)) return false;
    return /\d(\.\d+)?\s*BNB/.test(line) || /付费/.test(line);
  });

  const website = (t.match(/官网\s+((?:[a-z0-9-]+\.)+[a-z]{2,})/i) || [])[1] || null;
  const xHandle = (t.match(/推特\s*@?([A-Za-z0-9_]{1,15})/) || [])[1] || null;
  const agentGated = /Agent\s*ID/i.test(t);
  const manualOnly = /官网\s*mint|要过.*验证|项目方的验证|名单|抽取/.test(t);
  const freeOnAgentPath = priceFree && agentGated;

  const minted = t.match(/已\s*mint[：:]\s*([\d,]+)(?:\s*\/\s*([\d,]+))?/i);
  const perWallet = (t.match(/每个钱包最多\s*(\d+)/) || [])[1] || null;

  return {
    contract: contract.toLowerCase(),
    name,
    symbol,
    priceLine: priceLine.trim(),
    free: priceFree && paidHints.length === 0,
    paidHints,
    agentGated,
    freeOnAgentPath,
    manualOnly,
    website,
    xHandle,
    minted: minted ? Number(minted[1].replace(/,/g, '')) : null,
    total: minted && minted[2] ? Number(minted[2].replace(/,/g, '')) : null,
    perWallet: perWallet ? Number(perWallet) : null,
  };
}

export function autoEligible(p) {
  return !!p && p.freeOnAgentPath && !p.manualOnly;
}

// 监听只保留 Agent ID 限定的项目（NFT_FEED_AGENT_ONLY=0 可关闭）：其他项目不写进 feed，也就不会出现在列表和浮窗里
export function feedWorthy(p, agentOnly = true) {
  return !!p && (!agentOnly || p.agentGated === true);
}
