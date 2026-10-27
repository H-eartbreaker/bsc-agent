// 版本提示（只提示，不更新）：到「你自己的」GitHub 仓库看有没有更新的版本号，有就在页面右下角亮一个 NEW。
// 本程序不会下载、替换或重启任何东西——要更新，你自己 git pull / 拷文件，再手动重启。
// 仓库地址不写在代码里：在 .env 里设 BSC_AGENT_UPDATE_REPO=用户名/仓库名；不设 = 不检查。BSC_AGENT_UPDATE=0 关闭。
import fs from 'node:fs';
import path from 'node:path';
import { pfetch } from './netProxy.js';

const REPO = String(process.env.BSC_AGENT_UPDATE_REPO || 'H-eartbreaker/bsc-agent').trim();   // 默认检查官方仓库；想指向自己的仓库就在 .env 里改
const OFF = process.env.BSC_AGENT_UPDATE === '0';
const CACHE_MS = 30 * 60_000;
const vNorm = (s) => String(s || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
export const cmpVer = (a, b) => { const x = vNorm(a), y = vNorm(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

// 取 CHANGELOG.md 里某个版本的说明：「## v0.2.0 (2026-01-01)」下面到下一个「## 」之前
export function parseChangelog(md, ver) {
  const re = new RegExp(`^##\\s+v?${String(ver).replace(/\./g, '\\.')}\\b.*$`, 'm'), m = re.exec(md || '');
  if (!m) return '';
  const rest = md.slice(m.index + m[0].length), end = rest.search(/^##\s/m);
  return (end < 0 ? rest : rest.slice(0, end)).trim().slice(0, 1500);
}

async function get(url, ms = 12_000) {
  const r = await pfetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'bsc-agent-version-check', accept: 'application/vnd.github+json,text/plain,*/*' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export function mountUpdater(app, { rootDir }) {
  const pkgVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } };
  const startVersion = pkgVersion();
  let cache = null, checking = null;

  async function check(force) {
    if (!REPO || OFF) return null;
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
    if (checking) return checking;
    checking = (async () => {
      try {
        const base = `https://raw.githubusercontent.com/${REPO}/main`;
        const latest = JSON.parse(await get(`${base}/package.json`)).version;
        let notes = ''; try { notes = parseChangelog(await get(`${base}/CHANGELOG.md`), latest); } catch { /* 没有更新说明文件也行 */ }
        cache = { at: Date.now(), latest, notes, error: null };
      } catch (e) {
        cache = { at: Date.now(), latest: cache?.latest || null, notes: cache?.notes || '', error: `检查失败：${String(e.message).slice(0, 120)}` };
      } finally { checking = null; }
      return cache;
    })();
    return checking;
  }

  const view = (c) => {
    const current = pkgVersion();
    return {
      configured: !!REPO && !OFF, disabled: OFF, current, running: startVersion, pendingRestart: current !== startVersion,
      latest: c?.latest || null, hasUpdate: !!(c?.latest && cmpVer(c.latest, current) > 0), notes: c?.notes || '',
      checkedAt: c?.at || null, error: c?.error || null, repoUrl: REPO ? `https://github.com/${REPO}` : null, notifyOnly: true,
    };
  };

  app.get('/api/version', async (req, res) => {
    try { const c = req.query.cached ? cache : await check(!!req.query.refresh); res.json(view(c)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  setTimeout(() => check(false).catch(() => {}), 15_000);   // 启动后顺手查一次，之后页面打开时才按缓存时间再查
}
