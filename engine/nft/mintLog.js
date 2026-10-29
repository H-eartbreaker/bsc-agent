// 读 data/mint-logs/*.json（free-mint.mjs 每次运行写一个），给 NFT 页的「mint 历史」和统计用。只读。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const str = (v, n) => String(v ?? '').slice(0, n);

export function readMintHistory(dir, { limit = 300, since = 0, includeDry = true } = {}) {
  const max = Math.max(1, Math.min(500, Math.floor(Number(limit) || 300)));
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, max); } catch { /* 目录还没有 */ }
  const rows = [];
  for (const file of files) {
    let log;
    try { log = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
    const parts = file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
    const at = parts ? Date.parse(`${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}.${parts[5]}Z`) : null;
    if (since && at && at < since) continue;
    if (!includeDry && log.dry === true) continue;
    for (const r of Array.isArray(log.results) ? log.results : []) {
      rows.push({
        time: file.replace(/\.json$/, '').replace('T', ' '), at: Number.isFinite(at) ? at : null,
        name: str(r.name || 'NFT', 120), contract: str(r.contract, 42), method: str(r.method, 80),
        qty: Number.isFinite(r.qty) ? r.qty : null, status: str(r.status, 30), reason: str(r.reason, 240), tx: str(r.tx, 70),
        tokenIds: Array.isArray(r.tokenIds) ? r.tokenIds.slice(0, 50).map((x) => str(x, 40)) : [],
        gasBnb: r.gasBnb ? str(r.gasBnb, 24) : '', valueBnb: r.valueBnb ? str(r.valueBnb, 24) : '', dry: log.dry === true, source: log.source === 'auto' ? 'auto' : 'manual',
      });
    }
  }
  return rows.slice(0, 500);
}

export function summarize(rows) {
  const real = rows.filter((r) => !r.dry);
  const ok = real.filter((r) => r.status === '成功');
  return {
    projectsOk: ok.length,
    nftsMinted: ok.reduce((n, r) => n + (r.tokenIds?.length || r.qty || 0), 0),
    failed: real.filter((r) => r.status === '失败' || r.status === '未确认(查链上)').length,
    skipped: real.filter((r) => r.status === '跳过').length,
    gasBnb: Number(ok.reduce((n, r) => n + (Number(r.gasBnb) || 0), 0).toFixed(6)),
    paidBnb: Number(ok.reduce((n, r) => n + (Number(r.valueBnb) || 0), 0).toFixed(6)),
  };
}
