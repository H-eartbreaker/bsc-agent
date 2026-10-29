// 让 Telegram 监听随主服务启动：配好 TG_API_ID/TG_API_HASH 并登录过（data/tg-session.txt）就自动跑，崩了自动重启。
// 已经有一个监听进程在跑（比如你手动开的）时，tgWatch 会以退出码 3 让位，这里只定期再看看。
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../live/config.js';

export class WatchSupervisor {
  constructor({ root, log = () => {} }) {
    this.root = root; this.log = log; this.child = null; this.timer = null; this.backoff = 5000; this.info = { state: 'idle' };
  }

  configured() {
    return env('NFT_WATCH', '1') !== '0' && !!env('TG_API_ID', '') && !!env('TG_API_HASH', '') && !!env('TG_CHANNEL_ID', '') && existsSync(join(this.root, 'data', 'tg-session.txt'));
  }

  status() { return { ...this.info, configured: this.configured() }; }

  start() {
    if (this.timer || this.child) return;
    if (!this.configured()) { this.info = { state: 'unconfigured' }; return; }
    this.spawn();
  }

  stop() { clearTimeout(this.timer); this.timer = null; this.child?.kill(); this.child = null; }

  // 手动开的旧监听进程没有 pid 锁：mac/linux 上用 pgrep 兜底，避免同一个 Telegram 会话被两个进程同时使用
  foreignWatcher() {
    if (process.platform === 'win32') return Promise.resolve(false);
    return new Promise((resolve) => execFile('pgrep', ['-f', 'engine/nft/tgWatch\\.js'], (err, out) => resolve(!err && String(out).split('\n').some((x) => x.trim() && Number(x) !== process.pid && Number(x) !== this.child?.pid))));
  }

  async spawn() {
    this.timer = null;
    if (await this.foreignWatcher()) { this.info = { state: 'external' }; this.timer = setTimeout(() => this.spawn(), 60_000); this.timer.unref?.(); return; }
    const child = spawn(process.execPath, [join(this.root, 'engine', 'nft', 'tgWatch.js')], { cwd: this.root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; this.info = { state: 'running', pid: child.pid, since: Date.now() };
    const out = (b) => { for (const l of String(b).split('\n')) if (l.trim()) this.log('[nft-watch] ' + l.trim().slice(0, 200)); };
    child.stdout.on('data', out); child.stderr.on('data', out);
    child.on('error', (e) => this.log('[nft-watch] 启动失败 ' + e.message));
    child.on('exit', (code) => {
      this.child = null;
      if (code === 3) { this.info = { state: 'external' }; this.timer = setTimeout(() => this.spawn(), 60_000); return; }
      this.info = { state: 'restarting', lastExit: code, at: Date.now() };
      this.timer = setTimeout(() => this.spawn(), this.backoff); this.backoff = Math.min(this.backoff * 2, 300_000);
    });
    child.on('spawn', () => { setTimeout(() => { if (this.child === child) this.backoff = 5000; }, 60_000).unref?.(); });
    this.timer?.unref?.();
  }
}
