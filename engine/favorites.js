// 收藏（参考 GMGN）：代币按分组收藏，存服务器 data/favorites.json，换浏览器也在
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const FILE = new URL('../data/favorites.json', import.meta.url);
const lc = (a) => String(a || '').toLowerCase();
const okAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
const okName = (g) => { const s = String(g || '').trim().slice(0, 20); if (!s) throw new Error('分组名不能为空'); return s; };

export class Favorites {
  constructor() {
    try { const d = JSON.parse(readFileSync(FILE, 'utf8')); this.groups = d.groups?.length ? d.groups : ['默认']; this.items = d.items || {}; }
    catch { this.groups = ['默认']; this.items = {}; }
  }
  view() { return { groups: this.groups, items: this.items }; }
  save() { mkdirSync(new URL('.', FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(this.view(), null, 2)); return this.view(); }
  op(b) {
    switch (b.op) {
      case 'set': { if (!okAddr(b.address)) throw new Error('地址无效'); const g = this.groups.includes(b.group) ? b.group : '默认'; const a = lc(b.address);
        this.items[a] = { group: g, at: this.items[a]?.at || Date.now(), symbol: String(b.symbol || this.items[a]?.symbol || '').slice(0, 40), platform: b.platform || this.items[a]?.platform || null }; break; }
      case 'remove': delete this.items[lc(b.address)]; break;
      case 'addGroup': { const g = okName(b.group); if (!this.groups.includes(g)) this.groups.push(g); break; }
      case 'renameGroup': { const to = okName(b.to); if (b.group === '默认') throw new Error('「默认」分组不能改名'); const i = this.groups.indexOf(b.group); if (i < 0) throw new Error('分组不存在'); if (this.groups.includes(to)) throw new Error('已有同名分组');
        this.groups[i] = to; for (const v of Object.values(this.items)) if (v.group === b.group) v.group = to; break; }
      case 'deleteGroup': { if (b.group === '默认') throw new Error('「默认」分组不能删除'); this.groups = this.groups.filter((g) => g !== b.group); for (const v of Object.values(this.items)) if (v.group === b.group) v.group = '默认'; break; }
      default: throw new Error('未知操作');
    }
    return this.save();
  }
}
