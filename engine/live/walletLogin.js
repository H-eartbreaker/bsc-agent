// 登录状态机不持有私钥；二维码 ID 只传给 CLI，不进入页面状态或日志。
export class WalletLogin {
  constructor({ signin, verify, connected, refresh, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { signin, verify, connected, refresh, now, setTimer, clearTimer });
    this.current = null;
    this.starting = null;
  }

  view() { return this.current ? { ...this.current } : null; }

  start() {
    if (this.starting) return this.starting;
    this.starting = this.begin().finally(() => { this.starting = null; });
    return this.starting;
  }

  async begin() {
    if (this.connected()) throw new Error('钱包已经登录，无需重新登录');
    if (this.current?.state === 'waiting') {
      if (this.now() < this.current.expireAt) return this.view();
      this.expire(this.current);
    }
    let d;
    try { d = await this.signin(); }
    catch { this.current = { state: 'failed', message: '获取登录链接失败，请检查本机网络后重试' }; return this.view(); }
    if (d.status === 'ALREADY_CONNECTED') {
      this.current = { state: 'checking', message: '正在确认钱包连接' };
      await this.finish(this.current);
      return this.view();
    }
    let url;
    try { url = new URL(d.urlForWeb); } catch { /* 下面统一拒绝 */ }
    const expireAt = Math.min(Number(d.expireAt) || Infinity, this.now() + 300_000);
    if (!url || url.protocol !== 'https:' || !['web3.binance.com', 'app.binance.com'].includes(url.hostname) || url.username || url.password || url.port || !d.qrCodeId || typeof d.pairingCode !== 'string' || !d.pairingCode || expireAt <= this.now()) {
      this.current = { state: 'failed', message: '登录链接无效或已过期，请重新获取' };
      return this.view();
    }
    const login = { state: 'waiting', urlForWeb: d.urlForWeb, pairingCode: d.pairingCode, expireAt, message: '请核对配对码并在币安 App 中确认' };
    this.current = login;
    this.controller = new AbortController();
    const controller = this.controller;
    const timer = this.setTimer(() => this.expire(login), expireAt - this.now());
    // 保持 verify 子进程运行到本人确认或二维码过期，不把 App 成功提示当成已连接。
    this.verifying = Promise.resolve().then(() => this.verify(d.qrCodeId, { signal: controller.signal }))
      .then(async (r) => {
        if (this.current !== login || login.state !== 'waiting') return;
        if (r.status !== 'SUCCESS') { login.state = 'failed'; login.message = '登录未完成，请重新获取链接'; return; }
        await this.finish(login);
      })
      .catch(() => { if (this.current === login && login.state === 'waiting') { login.state = 'failed'; login.message = '登录确认失败，请重新获取链接'; } })
      .finally(() => { this.clearTimer(timer); });
    return this.view();
  }

  expire(login) {
    if (this.current !== login || login.state !== 'waiting') return;
    login.state = 'expired'; login.message = '登录链接已过期，请重新获取';
    delete login.urlForWeb; delete login.pairingCode;
    this.controller?.abort();
  }

  async finish(login) {
    try {
      await this.refresh();
      if (this.current !== login || !['waiting', 'checking'].includes(login.state)) return;
      login.state = this.connected() ? 'done' : 'failed';
      login.message = this.connected() ? '钱包已连接' : '本机钱包尚未连接，请重新登录并核对账号';
    } catch { if (this.current === login && ['waiting', 'checking'].includes(login.state)) { login.state = 'failed'; login.message = '无法确认本机钱包连接，请重试'; } }
    if (login.state !== 'waiting') { delete login.urlForWeb; delete login.pairingCode; }
  }
}
