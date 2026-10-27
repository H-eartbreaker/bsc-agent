// 历史数据缓存（可选）：MySQL 存不会再变的历史（各盘从开盘起的成交、外盘分钟 K 线、BNB 小时价、钱包交易记录），
// 重启或再次点开同一个币时只补上次之后的新数据；Redis 存外部接口的短时响应（DexScreener / GeckoTerminal），几个后端共用。
// 都是可选的：.env 不填 MYSQL_URL / REDIS_URL 就不启用，程序和以前完全一样。连不上、超时、报错一律当作没有缓存，
// 走原来的路径（直接查链 / 接口），30 秒后再试连。依赖 mysql2 / ioredis 是可选依赖，没装也能跑。
import { pfetch } from '../netProxy.js';
import { env } from './config.js';

const MYSQL_URL = env('MYSQL_URL', '');
const REDIS_URL = env('REDIS_URL', '');
const RETRY_MS = 30_000;
// 刚启动的 2 分钟里（数据库容器可能和程序一起刚起来）连不上就 5 秒后再试，之后 30 秒
const T0 = Date.now(), retryMs = () => (Date.now() - T0 < 120_000 ? 5_000 : RETRY_MS);
// 正在连的时候，调用方最多等这么久，等不到就先走原来的路径（不让一次慢连接卡住行情 / 历史）
const WAIT_MS = 300;
const waitFor = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), WAIT_MS))]);
const lc = (a) => String(a || '').toLowerCase();
const log = (m) => console.log(`[缓存] ${m}`);

const SCHEMA = [
  // 某个盘的历史成交：src = four / flap-nft / gang；uid 是去重键；j 是整条成交（JSON）
  `CREATE TABLE IF NOT EXISTS trades (src VARCHAR(16) NOT NULL, token CHAR(42) NOT NULL, uid VARCHAR(160) NOT NULL, ts BIGINT NOT NULL, trader CHAR(42) NOT NULL DEFAULT '',
     j TEXT NOT NULL, PRIMARY KEY (src, token, uid), KEY by_ts (src, token, ts), KEY by_trader (src, token, trader)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // 某个盘的历史补到哪里了：链上来源是区块号，gang.fun 是 1 = 已经拉全
  `CREATE TABLE IF NOT EXISTS hist_cursor (src VARCHAR(16) NOT NULL, token CHAR(42) NOT NULL, cur BIGINT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (src, token)) ENGINE=InnoDB`,
  // 外盘池子的分钟 K 线（GeckoTerminal，美元计）
  `CREATE TABLE IF NOT EXISTS ohlcv (pool CHAR(42) NOT NULL, t INT NOT NULL, o DOUBLE, h DOUBLE, l DOUBLE, c DOUBLE, v DOUBLE, PRIMARY KEY (pool, t)) ENGINE=InnoDB`,
  // BNB/USDT 小时价（开盘收盘平均）
  `CREATE TABLE IF NOT EXISTS bnb_hourly (h BIGINT NOT NULL PRIMARY KEY, px DOUBLE NOT NULL) ENGINE=InnoDB`,
  // 钱包交易记录（baw wallet tx-history），按钱包地址分开
  `CREATE TABLE IF NOT EXISTS wallet_tx (wallet CHAR(42) NOT NULL, id VARCHAR(255) NOT NULL, ts BIGINT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT '', j MEDIUMTEXT NOT NULL,
     PRIMARY KEY (wallet, id), KEY by_ts (wallet, ts)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

class Cache {
  constructor() {
    this.my = null; this.rd = null; this.myAt = 0; this.rdAt = 0; this.myP = null; this.rdP = null;
    this.stats = { hits: 0, misses: 0, errors: 0, lastError: null };
  }
  get enabled() { return !!MYSQL_URL; }
  status() {
    const mask = (u) => (u ? u.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@') : '');
    return { mysql: MYSQL_URL ? { url: mask(MYSQL_URL), up: !!this.my } : null, redis: REDIS_URL ? { url: mask(REDIS_URL), up: !!this.rd } : null, ...this.stats };
  }
  fail(where, e) {
    this.stats.errors++; this.stats.lastError = `${where}: ${e?.message || e}`;
    if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|PROTOCOL_CONNECTION_LOST|closed state|Connection is closed|ENOTFOUND|EHOSTUNREACH/i.test(String(e?.code || '') + String(e?.message || ''))) {
      if (where.startsWith('redis')) { this.rd?.disconnect?.(); this.rd = null; this.rdAt = Date.now(); } else { this.my?.end?.().catch(() => {}); this.my = null; this.myAt = Date.now(); }
      log(`${where} 连不上，先走原来的路径，${retryMs() / 1000} 秒后再试：${e?.message || e}`);
    }
    return null;
  }

  // MySQL 连接池；连不上返回 null（30 秒内不重试）
  async mysql() {
    if (!MYSQL_URL) return null; if (this.my) return this.my;
    if (this.myP) return waitFor(this.myP);
    if (Date.now() - this.myAt < retryMs()) return null;
    return (this.myP = (async () => {
      try {
        const { default: mysql } = await import('mysql2/promise');
        const pool = mysql.createPool({ uri: MYSQL_URL, connectionLimit: 4, connectTimeout: 5000, enableKeepAlive: true, supportBigNumbers: true, bigNumberStrings: false });
        for (const s of SCHEMA) await pool.query(s);
        this.my = pool; log('MySQL 已连接'); return pool;
      } catch (e) { this.myAt = Date.now(); this.stats.lastError = `mysql: ${e.message}`; log(`MySQL 不可用，先不用缓存：${e.code === 'ERR_MODULE_NOT_FOUND' ? '没装 mysql2（npm install）' : e.message}`); return null; }
      finally { this.myP = null; }
    })());
  }
  async q(sql, args) { const db = await this.mysql(); if (!db) return null; try { return (await db.query(sql, args))[0]; } catch (e) { return this.fail('mysql', e); } }

  async redis() {
    if (!REDIS_URL) return null; if (this.rd) return this.rd;
    if (this.rdP) return waitFor(this.rdP);
    if (Date.now() - this.rdAt < retryMs()) return null;
    return (this.rdP = (async () => {
      try {
        const { default: Redis } = await import('ioredis');
        const r = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 3000, commandTimeout: 500, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
        r.on('error', () => {});   // 错误在调用处处理
        r.on('end', () => { if (this.rd === r) { this.rd = null; this.rdAt = Date.now(); } });
        await r.connect(); await r.ping();
        this.rd = r; log('Redis 已连接'); return r;
      } catch (e) { this.rdAt = Date.now(); this.stats.lastError = `redis: ${e.message}`; log(`Redis 不可用，先不用缓存：${e.code === 'ERR_MODULE_NOT_FOUND' ? '没装 ioredis（npm install）' : e.message}`); return null; }
      finally { this.rdP = null; }
    })());
  }

  // ---- Redis：短时 JSON ----
  async getJson(key) { const r = await this.redis(); if (!r) return null; try { const s = await r.get('bsc-agent:' + key); if (s == null) { this.stats.misses++; return null; } this.stats.hits++; return JSON.parse(s); } catch (e) { return this.fail('redis', e); } }
  async setJson(key, v, ttlSec) { const r = await this.redis(); if (!r) return; try { await r.set('bsc-agent:' + key, JSON.stringify(v), 'EX', Math.max(1, Math.round(ttlSec))); } catch (e) { this.fail('redis', e); } }
  // 外部接口 GET（JSON）：Redis 里有就直接用，没有就请求并存 ttlSec 秒。只缓存请求成功的结果
  async fetchJson(url, ttlSec, init) {
    const hit = await this.getJson('http:' + url); if (hit != null) return hit;
    const res = await pfetch(url, init);   // 被墙的行情站走代理（BSC_AGENT_PROXY）
    const j = await res.json();
    if (res.ok) await this.setJson('http:' + url, j, ttlSec);
    return j;
  }

  // ---- MySQL：成交历史 ----
  // 读出某个盘已存的成交（按时间升序）和补到的位置；数据库不可用返回 null
  async loadTrades(src, token) {
    const k = lc(token);
    const [rows, cur] = await Promise.all([this.q('SELECT j FROM trades WHERE src=? AND token=? ORDER BY ts, uid', [src, k]), this.q('SELECT cur FROM hist_cursor WHERE src=? AND token=?', [src, k])]);
    if (!rows || !cur) return null;
    const list = []; for (const r of rows) { try { list.push(JSON.parse(r.j)); } catch { /* 坏行跳过 */ } }
    if (list.length || cur.length) this.stats.hits++; else this.stats.misses++;
    return { rows: list, cursor: cur.length ? Number(cur[0].cur) : null };
  }
  // 存新成交（uidOf 给去重键，重复的覆盖）和新的位置。返回是否存成功
  async saveTrades(src, token, list, cursor, uidOf) {
    const k = lc(token);
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500).map((x) => [src, k, String(uidOf(x)).slice(0, 160), Math.round(Number(x.ts) || 0), lc(x.trader).slice(0, 42), JSON.stringify(x)]);
      if (part.length && (await this.q('INSERT INTO trades (src, token, uid, ts, trader, j) VALUES ? ON DUPLICATE KEY UPDATE ts=VALUES(ts), trader=VALUES(trader), j=VALUES(j)', [part])) == null) return false;
    }
    if (cursor != null) return (await this.q('INSERT INTO hist_cursor (src, token, cur, at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE cur=VALUES(cur), at=VALUES(at)', [src, k, Math.round(cursor), Date.now()])) != null;
    return true;
  }
  // 增量历史的通用流程：已存的 + fetchFrom(上次位置) 拿到的新成交，按 uid 去重合并，新的存回去。
  // fetchFrom(null, null) = 没有缓存，按原来的方式从头拉；第二个参数是已存的 { rows, cursor }。返回合并后的成交（升序）
  async history(src, token, fetchFrom, uidOf) {
    const old = await this.loadTrades(src, token).catch(() => null);
    const { rows, cursor } = await fetchFrom(old?.cursor ?? null, old);
    if (!old) return rows;   // 数据库不可用：和以前一样
    this.saveTrades(src, token, rows, cursor, uidOf).catch(() => {});
    const m = new Map(old.rows.map((x) => [uidOf(x), x])); for (const x of rows) m.set(uidOf(x), x);
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  }

  // ---- 外盘分钟 K 线（美元）----
  async saveBars(pool, bars) {
    const p = lc(pool); if (!bars.length) return;
    for (let i = 0; i < bars.length; i += 500) await this.q('INSERT INTO ohlcv (pool, t, o, h, l, c, v) VALUES ? ON DUPLICATE KEY UPDATE o=VALUES(o), h=VALUES(h), l=VALUES(l), c=VALUES(c), v=VALUES(v)', [bars.slice(i, i + 500).map((b) => [p, b[0], b[1], b[2], b[3], b[4], b[5]])]);
  }
  async loadBars(pool, limit = 4000) { const r = await this.q('SELECT t, o, h, l, c, v FROM ohlcv WHERE pool=? ORDER BY t DESC LIMIT ?', [lc(pool), limit]); return r ? r.reverse().map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]) : null; }

  // ---- BNB 小时价 ----
  async loadBnbHourly(fromMs) { const r = await this.q('SELECT h, px FROM bnb_hourly WHERE h >= ?', [fromMs]); return r ? r.map((x) => [Number(x.h), x.px]) : null; }
  async saveBnbHourly(entries) { if (entries.length) await this.q('INSERT INTO bnb_hourly (h, px) VALUES ? ON DUPLICATE KEY UPDATE px=VALUES(px)', [entries]); }

  // ---- 钱包交易记录 ----
  async loadWalletTx(wallet, limit) { const r = await this.q('SELECT j FROM wallet_tx WHERE wallet=? ORDER BY ts DESC LIMIT ?', [lc(wallet), limit]); return r ? r.map((x) => JSON.parse(x.j)) : null; }
  async saveWalletTx(wallet, list, idOf) {
    const rows = list.map((t) => [lc(wallet), String(idOf(t)).slice(0, 255), Date.parse(t.txTime) || 0, String(t.status || '').slice(0, 16), JSON.stringify(t)]);
    if (rows.length) await this.q('INSERT INTO wallet_tx (wallet, id, ts, status, j) VALUES ? ON DUPLICATE KEY UPDATE ts=VALUES(ts), status=VALUES(status), j=VALUES(j)', [rows]);
  }
}

export const cache = new Cache();
