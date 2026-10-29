// Short browser-local alerts. Custom files never leave this browser.
export class AlertSound {
  constructor(getContext, storage) {
    this.getContext = getContext;
    this.storage = storage;
    this.playId = 0;
    this.record = null;
    this.buffer = null;
    this.source = null;
    try {
      this.storage ||= globalThis.localStorage;
      const r = JSON.parse(this.storage.getItem('bsc-custom-alert') || 'null');
      if (r && typeof r.name === 'string' && typeof r.data === 'string' && r.data.length <= 2800000 && /^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) this.record = r;
    } catch { /* Unavailable storage leaves built-in sounds usable. */ }
  }
  get customName() { return this.record?.name || ''; }
  async upload(file) {
    if (!file || !file.size || file.size > 2 * 1024 * 1024) throw new Error('请选择不超过 2 MB 的音频文件');
    const bytes = await file.arrayBuffer();
    let decoded;
    try { decoded = await this.getContext().decodeAudioData(bytes.slice(0)); }
    catch { throw new Error('无法读取音频，请换用 MP3、WAV 或 OGG 文件'); }
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 15) throw new Error('提示音请控制在 15 秒以内');
    let binary = '';
    const view = new Uint8Array(bytes);
    for (let i = 0; i < view.length; i += 8192) binary += String.fromCharCode(...view.subarray(i, i + 8192));
    const record = { name: String(file.name || '自定义声音').slice(0, 160), data: btoa(binary) };
    try { this.storage.setItem('bsc-custom-alert', JSON.stringify(record)); }
    catch { throw new Error('浏览器存储空间不足，原来的声音已保留'); }
    this.record = record;
    this.buffer = decoded;
    return record.name;
  }
  async play(kind = 'soft') {
    const id = ++this.playId;
    const ctx = this.getContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (id !== this.playId) return;
    // Only one alert at a time, including previewing an uploaded file.
    try { this.source?.stop(); } catch { /* Previous source already ended. */ }
    this.source = null;
    if (kind === 'custom') {
      if (!this.record) throw new Error('请先上传自定义声音');
      if (!this.buffer) {
        const bytes = Uint8Array.from(atob(this.record.data), (c) => c.charCodeAt(0));
        this.buffer = await ctx.decodeAudioData(bytes.buffer);
      }
      if (id !== this.playId) return;
      if (this.buffer.duration > 15) throw new Error('自定义声音超过 15 秒，请重新上传');
      const source = ctx.createBufferSource(), gain = ctx.createGain();
      source.buffer = this.buffer; gain.gain.value = 0.45;
      source.connect(gain).connect(ctx.destination); this.source = source;
      source.onended = () => { source.disconnect(); gain.disconnect(); };
      source.start();
      return;
    }
    const start = ctx.currentTime, oscillator = ctx.createOscillator(), gain = ctx.createGain();
    const wood = kind === 'wood';
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(wood ? 440 : 784, start);
    oscillator.frequency.exponentialRampToValueAtTime(wood ? 220 : 659, start + (wood ? 0.10 : 0.35));
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.065, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + (wood ? 0.16 : 0.5));
    oscillator.connect(gain).connect(ctx.destination); this.source = oscillator;
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start); oscillator.stop(start + (wood ? 0.18 : 0.52));
  }
}
