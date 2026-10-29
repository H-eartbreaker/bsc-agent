import { existsSync, readFileSync } from 'node:fs';

export function cleanRow(row) {
  if (!row || typeof row !== 'object') return null;
  const contract = String(row.contract || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(contract)) return null;
  return {
    contract,
    name: String(row.name || 'NFT 项目').slice(0, 120),
    symbol: String(row.symbol || '').slice(0, 40),
    priceLine: String(row.priceLine || '').slice(0, 240),
    free: row.free === true,
    freeOnAgentPath: row.freeOnAgentPath === true,
    agentGated: row.agentGated === true,
    manualOnly: row.manualOnly === true,
    eligible: row.eligible === true,
    paidHints: Array.isArray(row.paidHints) ? row.paidHints.map((x) => String(x).slice(0, 240)).slice(0, 10) : [],
    website: row.website ? String(row.website).slice(0, 240) : null,
    xHandle: row.xHandle ? String(row.xHandle).slice(0, 40) : null,
    minted: Number.isFinite(row.minted) ? row.minted : null,
    total: Number.isFinite(row.total) ? row.total : null,
    perWallet: Number.isFinite(row.perWallet) ? row.perWallet : null,
    msgId: Number.isFinite(Number(row.msgId)) ? Number(row.msgId) : null,
    postedAt: row.postedAt || null,
    seenAt: row.seenAt || null,
    raw: String(row.raw || '').slice(0, 5000),
  };
}

export function readNftFeed(file) {
  if (!existsSync(file)) return [];
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows.map(cleanRow).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function nftFeedList(file, { eligible = false, since = null, limit = 100 } = {}) {
  const cursor = Number.isFinite(Number(since)) ? Number(since) : null;
  const max = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  return readNftFeed(file).filter((row) => (!eligible || row.eligible) && (cursor == null || (row.msgId != null && row.msgId > cursor))).slice(0, max);
}

export function nftFeedOne(file, contract) {
  const key = String(contract || '').toLowerCase();
  return readNftFeed(file).find((row) => row.contract === key) || null;
}
