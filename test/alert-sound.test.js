import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertSound } from '../public/alert-sound.js';
const storage = () => { const values = new Map(); return { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) }; };
function context() {
  const nodes = [], gains = [];
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => { const n = { connect() { return this; }, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } }; nodes.push(n); return n; };
  const ctx = { currentTime: 0, state: 'running', destination: {},
    resume: async () => {}, decodeAudioData: async () => ({ duration: .3 }),
    createBufferSource: node, createGain() { const n = node(); n.gain = param(); gains.push(n); return n; },
    createOscillator() { const n = node(); n.frequency = param(); return n; },
  };
  return { ctx, nodes, gains };
}
const file = { size: 4, name: '我的提示.wav', arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
test('custom audio is persisted locally and playable after a new instance', async () => {
  const s = storage(), { ctx, nodes } = context();
  const first = new AlertSound(() => ctx, s); await first.upload(file);
  const second = new AlertSound(() => ctx, s); assert.equal(second.customName, file.name);
  await second.play('custom'); assert.equal(nodes.filter((n) => n.started).length, 1);
});
test('oversized, invalid, and long files cannot replace the saved sound', async () => {
  const s = storage(), { ctx } = context(), audio = new AlertSound(() => ctx, s);
  await audio.upload(file); const old = s.getItem('bsc-custom-alert');
  await assert.rejects(audio.upload({ ...file, size: 3 * 1024 * 1024 }), /2 MB/);
  ctx.decodeAudioData = async () => { throw new Error('invalid'); };
  await assert.rejects(audio.upload(file), /无法读取音频/);
  ctx.decodeAudioData = async () => ({ duration: 16 });
  await assert.rejects(audio.upload(file), /15 秒/);
  assert.equal(s.getItem('bsc-custom-alert'), old);
});
test('storage failures retain the previous custom sound', async () => {
  const s = storage(), { ctx } = context(), audio = new AlertSound(() => ctx, s);
  await audio.upload(file); s.setItem = () => { throw new Error('quota'); };
  await assert.rejects(audio.upload({ ...file, name: 'replacement.wav' }), /原来的声音已保留/);
  assert.equal(audio.customName, file.name);
});
test('playing another alert stops the previous source', async () => {
  const { ctx, nodes } = context(), audio = new AlertSound(() => ctx, storage());
  await audio.play('soft'); const previous = nodes.find((n) => n.started);
  await audio.play('wood'); assert.equal(previous.stopped, true);
  assert.equal(nodes.filter((n) => n.started).length, 2);
});
test('missing custom files fail clearly and blocked storage permits built-in sounds', async () => {
  const { ctx } = context(), audio = new AlertSound(() => ctx, { getItem() { throw new Error('denied'); } });
  await audio.play('soft'); await assert.rejects(audio.play('custom'), /先上传/);
});
