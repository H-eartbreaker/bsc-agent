// NFT 自动 mint 任务：盯着监听 feed，只对「免费 + 满足你规则」的项目调用 scripts/free-mint.mjs。
// 真正的安全闸门在 free-mint.mjs：链上模拟 value=0 → baw preview 无扣费/授权/风险 → 才 execute。这里只负责选项目、限次、记账。
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_RULES = Object.freeze({
  agentOnly: true,        // 必须 Agent ID 限定
  social: 'any',          // any 不限 | site 必须官网 | x 必须 X | either 官网或 X | both 官网和 X
  quantity: 'all',        // all 按项目上限 | one 每项目 1 个
  maxQty: 10,             // 「按项目上限」时最多试几枚（1-50）
  scope: 'new',           // new 只处理开启之后出现的新项目 | all 也处理 feed 里已有的
  exclude: [],            // 名称 / 代号 / 价格行里含这些词的跳过
  dry: false,             // 试运行：只检查，不发交易
});

const SOCIAL = new Set(['any', 'site', 'x', 'either', 'both']);
const RETRY_GAP_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 3600_000];   // 第 n 次失败后多久才能再试
const RETRY_WINDOW_MS = 12 * 3600_000;   // 项目发布超过这么久就不再重试
const NO_RETRY = /已\s*mint|额度已用|已领|sold\s*out|售罄|不再|closed|已结束/i;

export function cleanRules(input = {}) {
  const r = { ...DEFAULT_RULES, ...(input && typeof input === 'object' ? input : {}) };
  return {
    agentOnly: r.agentOnly !== false,
    social: SOCIAL.has(r.social) ? r.social : 'any',
    quantity: r.quantity === 'one' ? 'one' : 'all',
    maxQty: Math.max(1, Math.min(50, Math.floor(Number(r.maxQty) || DEFAULT_RULES.maxQty))),
    scope: 'new',   // 固定只处理开启之后出现的新项目
    exclude: (Array.isArray(r.exclude) ? r.exclude : String(r.exclude || '').split(/[,，\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 30),
    dry: false,   // 不再提供试运行：开启就是真实 mint（仍然先模拟、预览，通过才发交易）
  };
}

const postedMs = (row) => Date.parse(row.postedAt || row.seenAt || '') || 0;

function socialOk(mode, row) {
  const site = !!row.website, x = !!row.xHandle;
  return mode === 'site' ? site : mode === 'x' ? x : mode === 'either' ? site || x : mode === 'both' ? site && x : true;
}

// 这个项目现在该不该试：返回 null = 可以；否则返回跳过原因
export function skipReason(row, state, now = Date.now()) {
  const rules = state.rules;
  if (!row.freeOnAgentPath && !(rules.agentOnly === false && row.free)) return '不是免费项目';
  if (row.manualOnly) return '需要官网验证/名单，只能手动';
  if (rules.agentOnly && !row.agentGated) return '不是 Agent ID 限定';
  if (!socialOk(rules.social, row)) return '官网/X 不满足筛选';
  const text = `${row.name} ${row.symbol} ${row.priceLine}`.toLowerCase();
  if (rules.exclude.some((w) => text.includes(w))) return '命中排除关键词';
  if (rules.scope === 'new' && postedMs(row) < (state.enabledAt || 0)) return '开启任务之前的老项目';
  const a = state.attempts[row.contract];
  if (a) {
    if (a.done) return '已处理（' + a.status + '）';
    if (a.count > RETRY_GAP_MS.length) return `已重试 ${a.count} 次仍未成功`;
    if (a.noRetry) return '无需重试：' + (a.reason || a.status);
    if (now - a.lastAt < RETRY_GAP_MS[Math.min(a.count, RETRY_GAP_MS.length) - 1]) return '等待重试';
    if (now - postedMs(row) > RETRY_WINDOW_MS) return '超过重试时限';
  }
  return null;
}

export function pickProjects(rows, state, now = Date.now()) {
  const seen = new Set();
  return rows.filter((r) => skipReason(r, state, now) === null && !seen.has(r.contract) && seen.add(r.contract));
}

export class AutoMint {
  constructor({ feedFile, stateFile, runner, readFeed, log = () => {}, intervalMs = 10_000 }) {
    this.feedFile = feedFile; this.stateFile = stateFile; this.runner = runner; this.readFeed = readFeed; this.log = log; this.intervalMs = intervalMs;
    this.busy = false; this.timer = null; this.lastRun = null;
    this.state = { enabled: false, enabledAt: 0, sessionStart: 0, rules: cleanRules(), attempts: {} };
    try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); this.state = { ...this.state, ...s, rules: cleanRules(s.rules), attempts: s.attempts && typeof s.attempts === 'object' ? s.attempts : {} }; } catch { /* 第一次用 */ }
    // 开关只由人手动开/关；刷新页面、重启服务都不改它（开启时间和已处理记录一起保留，所以不会重复 mint 老项目）
  }

  save() {
    try { mkdirSync(dirname(this.stateFile), { recursive: true }); const tmp = this.stateFile + '.tmp'; writeFileSync(tmp, JSON.stringify(this.state, null, 1)); renameSync(tmp, this.stateFile); } catch (e) { this.log('[nft-auto] 保存状态失败 ' + e.message); }
  }

  view() {
    const { enabled, enabledAt, sessionStart, rules, attempts } = this.state;
    return { enabled, enabledAt, sessionStart, rules, busy: this.busy, lastRun: this.lastRun, attempted: Object.keys(attempts).length };
  }

  configure({ enabled, rules } = {}) {
    if (rules) {
      const next = cleanRules({ ...this.state.rules, ...rules });
      if (next.dry !== this.state.rules.dry) this.state.attempts = Object.fromEntries(Object.entries(this.state.attempts).filter(([, a]) => a.tx));   // 试运行 ↔ 真实切换：试运行的「已处理」不能挡住真实 mint，但已广播过的真实交易要保留，避免重复 mint
      this.state.rules = next;
    }
    if (typeof enabled === 'boolean' && enabled !== this.state.enabled) {
      this.state.enabled = enabled;
      if (enabled) { this.state.enabledAt = Date.now(); this.state.sessionStart = this.state.enabledAt; this.state.attempts = {}; }
    }
    this.save();
    if (this.state.enabled) this.kick();
    return this.view();
  }

  start() { if (!this.timer) { this.timer = setInterval(() => this.kick(), this.intervalMs); this.timer.unref?.(); } }
  stop() { clearInterval(this.timer); this.timer = null; }
  kick() { if (this.state.enabled && !this.busy) this.tick().catch((e) => this.log('[nft-auto] ' + e.message)); }

  async tick() {
    if (!this.state.enabled || this.busy) return [];
    const now = Date.now(), picks = pickProjects(this.readFeed(this.feedFile), this.state, now);
    if (!picks.length) return [];
    this.busy = true;
    const rules = this.state.rules;
    try {
      this.log(`[nft-auto] 发现 ${picks.length} 个符合规则的项目：${picks.map((p) => p.name).join('、')}${rules.dry ? '（试运行）' : ''}`);
      for (const p of picks) { const a = (this.state.attempts[p.contract] ||= { count: 0 }); a.count++; a.lastAt = now; a.status = '进行中'; }
      this.save();
      const maxQty = rules.quantity === 'one' ? 1 : Math.max(1, Math.min(50, Math.max(...picks.map((p) => p.perWallet || rules.maxQty))));
      const results = await this.runner(picks, { dry: rules.dry, maxQty });
      for (const p of picks) {
        const r = results.find((x) => String(x.contract || '').toLowerCase() === p.contract) || { status: '失败', reason: '没有拿到结果' };
        const a = this.state.attempts[p.contract];
        a.status = r.status; a.reason = r.reason || ''; a.tx = r.tx || ''; a.lastAt = Date.now();
        a.done = r.status === '成功' || !!r.tx || (rules.dry && r.status === '可mint(未执行)');   // 已广播过交易：绝不重发，避免重复 mint
        a.noRetry = !a.done && NO_RETRY.test(r.reason || '');
      }
      this.lastRun = { at: Date.now(), picked: picks.length, ok: results.filter((r) => r.status === '成功').length, dry: rules.dry };
      this.save();
      return results;
    } catch (e) {
      for (const p of picks) { const a = this.state.attempts[p.contract]; if (a) { a.status = '失败'; a.reason = e.message.slice(0, 200); } }
      this.lastRun = { at: Date.now(), picked: picks.length, ok: 0, error: e.message.slice(0, 200) };
      this.save();
      return [];
    } finally { this.busy = false; }
  }
}

// 默认执行器：起 free-mint.mjs 子进程，结果从它写出的 JSON 读回
export function scriptRunner({ script, cwd, env = process.env, timeoutMs = 6 * 60_000 }) {
  return (rows, { dry, maxQty, qty, quote, unitWei, valueWei }) => new Promise((resolve, reject) => {
    const tmp = join(tmpdir(), `nft-auto-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const list = join(tmp, 'targets.txt'), out = join(tmp, 'result.json');
    writeFileSync(list, rows.map((r) => `${String(r.name).replace(/[\r\n=]/g, ' ')} ${r.contract}`).join('\n'));
    const args = [script, '--file', list, '--max', String(maxQty || 10), ...(qty ? ['--qty', String(qty)] : []), '--json-out', out, ...(dry ? ['--dry'] : []), ...(quote ? ['--quote'] : []), ...(unitWei ? ['--unit-wei', String(unitWei)] : []), ...(valueWei ? ['--value-wei', String(valueWei)] : [])];
    execFile(process.execPath, args, { cwd, env: typeof env === 'function' ? env() : env, timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      let results = null;
      try { results = JSON.parse(readFileSync(out, 'utf8')).results; } catch { /* 下面报错 */ }
      rmSync(tmp, { recursive: true, force: true });
      if (results) return resolve(results);
      const lines = String(stderr || stdout || err?.message || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
      const msg = lines.find((l) => /^(\w*Error|ReferenceError|TypeError)\b/.test(l)) || lines.filter((l) => !/^Node\.js v/.test(l)).pop() || 'free-mint 没有产出结果';
      reject(new Error(msg.slice(0, 240)));
    });
  });
}
