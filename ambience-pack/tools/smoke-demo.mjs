// Прогон демо-движка на заглушке AudioContext: ловим опечатки и падения.
const param = (v = 0) => ({
  value: v,
  setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {},
  cancelScheduledValues: () => {}, setTargetAtTime: () => {},
});
const node = (extra = {}) => ({
  connect(t) { return t && t.connect ? t : this; },
  disconnect() {}, ...extra,
});
class StubCtx {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.destination = node(); this.created = []; }
  _t(kind, n) { this.created.push(kind); return n; }
  createGain() { return this._t('gain', node({ gain: param(1) })); }
  createOscillator() { return this._t('osc', node({ type: 'sine', frequency: param(440), detune: param(0), start() {}, stop() {} })); }
  createBufferSource() { return this._t('src', node({ buffer: null, loop: false, playbackRate: param(1), start() {}, stop() {} })); }
  createBiquadFilter() { return this._t('biquad', node({ type: 'lowpass', frequency: param(350), Q: param(1) })); }
  createStereoPanner() { return this._t('panner', node({ pan: param(0) })); }
  createConvolver() { return this._t('convolver', node({ buffer: null })); }
  createDynamicsCompressor() {
    return this._t('comp', node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }));
  }
  createBuffer(ch, len, rate) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, getChannelData: (i) => data[i] };
  }
  decodeAudioData() { return Promise.resolve({ duration: 40, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(48000) }); }
  resume() { return Promise.resolve(); }
}
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
const { createEngine, SCENES } = await import('../demo/engine.js');
const ctx = new StubCtx();
const engine = createEngine(ctx);
let last = null;
engine.onStatus((s) => { last = s; });
for (const s of SCENES) {
  await engine.play(s.id);
  await new Promise((r) => setTimeout(r, 30));
  ctx.currentTime += 0.5;
}
engine.setVolume(0.5);
engine.stop();
await new Promise((r) => setTimeout(r, 50));
const counts = ctx.created.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
console.log('сцены проиграны:', SCENES.length);
console.log('узлы:', JSON.stringify(counts));
console.log('статус последней сцены:', last ? `${last.chord} | мотив ${last.motif}` : 'не пришёл');
console.log('running после стопа:', engine.running);
globalThis.fetch = realFetch;
