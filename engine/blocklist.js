// 屏蔽列表（全局、存服务器文件，换浏览器 / 重启都在）：按代币地址，或按创建者（开发者）地址
// 被屏蔽的币：战壕、左侧列表不显示，不响提示音、不弹通知、不自动买；搜索还能找到，持仓照常显示
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const FILE = new URL('../data/blocklist.json', import.meta.url);
const lc = (a) => String(a || '').toLowerCase();

export class Blocklist {
  constructor() { try { const d = JSON.parse(readFileSync(FILE, 'utf8')); this.tokens = d.tokens || {}; this.devs = d.devs || {}; } catch { this.tokens = {}; this.devs = {}; } }
  view() { return { tokens: this.tokens, devs: this.devs }; }
  save() { mkdirSync(new URL('.', FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(this.view(), null, 2)); }
  set(kind, address, on, label) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) throw new Error('地址无效');
    const m = kind === 'dev' ? this.devs : this.tokens, a = lc(address);
    if (on) m[a] = { label: String(label || '').slice(0, 60), at: Date.now() }; else delete m[a];
    this.save(); return this.view();
  }
  has(t) { return !!(t && (this.tokens[lc(t.address)] || (t.creator && this.devs[lc(t.creator)]))); }
}
