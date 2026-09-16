/* ============================================================
   demo/engine.js — как должна звучать новая версия эмбиента
   ------------------------------------------------------------
   Три слоя, каждый решает свою задачу:

     1. ЗЕМЛЯ  — реальные записи (CC0): лес, дождь, костёр, море.
        Две копии одной петли со случайными смещениями, каждая со
        своим медленным «дыханием» громкости и панорамы: петля
        перестаёт читаться как петля.
     2. ПОЛОТНО — аккорды, как было, но тише и мягче: по 3–4 голоса
        на аккорд, вход 12–22 с, уход 18–30 с.
     3. ГОЛОС    — мелодия: маленький мотив из 3–5 нот, который
        транспонируется под каждый аккорд и живёт по правилам
        фразировки (дыхание, человеческие задержки, затухание
        последней ноты). Это и есть «мелодичнее»: не случайные
        ноты, а повторяющийся мотив, который слушатель узнаёт.

   Плюс редкие настоящие акценты: колокольчики (тоже запись, CC0)
   заходят раз в 40–120 секунд очень тихо.
   ============================================================ */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* ---------- сцены ---------- */
export const SCENES = [
  {
    id: 'sea',
    title: 'Ночное море',
    text: 'Волны, которые никуда не спешат.',
    root: 57,                              // A3
    mode: [0, 2, 3, 5, 7, 8, 10],          // натуральный минор
    progression: [0, 5, 2, 6],             // i — VI — III — VII
    chordSec: [30, 38],
    file: '../assets/sea.m4a',
    bed: { level: 0.42, tone: 900, spread: 0.3, drift: [41, 29] },
    melody: { level: 0.17, register: [69, 93], gap: [12, 26], rest: 0.35 },
    accents: { gap: [50, 120], level: 0.07 },
    reverb: { seconds: 4.2, wet: 0.4 },
  },
  {
    id: 'rain',
    title: 'Дождь на стекле',
    text: 'Ровный дождь, за которым хорошо работается.',
    root: 50,                              // D3
    mode: [0, 2, 3, 5, 7, 9, 10],          // дорийский
    progression: [0, 5, 3, 4],
    chordSec: [26, 34],
    file: '../assets/rain.m4a',
    bed: { level: 0.4, tone: 1400, spread: 0.28, drift: [37, 27] },
    melody: { level: 0.15, register: [70, 94], gap: [10, 22], rest: 0.3 },
    accents: { gap: [70, 150], level: 0.05 },
    reverb: { seconds: 3, wet: 0.32 },
  },
  {
    id: 'hearth',
    title: 'У очага',
    text: 'Тёплый треск и очень мягкие ноты.',
    root: 48,                              // C3
    mode: [0, 2, 4, 5, 7, 9, 11],          // мажор
    progression: [0, 5, 3, 4],
    chordSec: [28, 36],
    file: '../assets/hearth.m4a',
    bed: { level: 0.46, tone: 1100, spread: 0.24, drift: [43, 31] },
    melody: { level: 0.18, register: [67, 91], gap: [9, 20], rest: 0.3 },
    accents: { gap: [45, 110], level: 0.06 },
    reverb: { seconds: 3.4, wet: 0.36 },
  },
  {
    id: 'forest',
    title: 'Утро в лесу',
    text: 'Птицы, листва и светлые ноты.',
    root: 52,                              // E3
    mode: [0, 2, 4, 5, 7, 9, 11],          // мажор
    progression: [0, 4, 5, 3],
    chordSec: [24, 30],
    file: '../assets/forest.m4a',
    bed: { level: 0.44, tone: 1600, spread: 0.34, drift: [35, 25] },
    melody: { level: 0.19, register: [72, 96], gap: [8, 18], rest: 0.28 },
    accents: { gap: [40, 100], level: 0.08 },
    reverb: { seconds: 2.6, wet: 0.3 },
  },
  {
    id: 'lullaby',
    title: 'Колыбельная',
    text: 'Очень низко, очень медленно, почти без воздуха.',
    root: 57,                              // A3
    mode: [0, 2, 3, 5, 7, 8, 10],
    progression: [0, 5, 2, 6],
    chordSec: [40, 52],
    file: '../assets/lullaby.m4a',
    bed: { level: 0.3, tone: 600, spread: 0.2, drift: [49, 37] },
    melody: { level: 0.14, register: [64, 86], gap: [16, 34], rest: 0.4 },
    accents: { gap: [90, 180], level: 0.04 },
    reverb: { seconds: 5.4, wet: 0.5 },
  },
  {
    id: 'space',
    title: 'Тихий космос',
    text: 'Стеклянные ноты в высоком шёпоте.',
    root: 55,                              // G3
    mode: [0, 2, 4, 6, 7, 9, 11],          // лидийский
    progression: [0, 4, 5, 3],
    chordSec: [34, 44],
    file: '../assets/space.m4a',
    bed: { level: 0.34, tone: 2200, spread: 0.4, drift: [47, 33] },
    melody: { level: 0.16, register: [74, 98], gap: [14, 30], rest: 0.36 },
    accents: { gap: [60, 140], level: 0.05 },
    reverb: { seconds: 6, wet: 0.5 },
  },
];

export const sceneById = (id) => SCENES.find((s) => s.id === id) || SCENES[0];

/* ---------- лад ---------- */
/** Нота по «ступени» лада: 0 — тоника, 7 — тоника следующей октавы. */
export function scaleNote(scene, degree) {
  const n = scene.mode.length;
  const oct = Math.floor(degree / n);
  const i = ((degree % n) + n) % n;
  return scene.root + oct * 12 + scene.mode[i];
}

/** Аккорд по ступени: трезвучие + септима + нона, всё внутри лада. */
export const chordDegrees = (d) => [d, d + 2, d + 4, d + 6, d + 8];

/* ---------- мотив ---------- */
/**
 * Маленькая тема: 3–5 шагов по ладу, начало и конец — на устойчивых
 * ступенях. Мотив придумывается один раз и потом повторяется в разных
 * тональностях — именно это слышится как музыка, а не как случайность.
 */
export function makeMotif() {
  const len = Math.random() < 0.5 ? 3 : Math.random() < 0.75 ? 4 : 5;
  const steps = [0];
  for (let i = 1; i < len; i++) {
    const prev = steps[i - 1];
    const dir = Math.random() < 0.62 ? 1 : -1;
    const size = Math.random() < 0.72 ? 1 : 2;
    let next = prev + dir * size;
    if (next === prev) next = prev + 1;
    steps.push(next);
  }
  // финал возвращаем к устойчивой ступени (тоника/терция/квинта),
  // чтобы фраза «закрывалась», а не обрывалась
  if (steps.length > 2) steps[steps.length - 1] = pick([0, 2, 4]);
  return steps;
}

/* ---------- рендер импульса для эха ---------- */
function impulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let energy = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const v = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
      d[i] = v;
      energy += v * v;
    }
    const norm = 1 / Math.sqrt(energy / len);
    for (let i = 0; i < len; i++) d[i] *= norm * 0.4;
  }
  return buf;
}

/* ============================================================
   Движок
   ============================================================ */
export function createEngine(ctx) {
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.knee.value = 14;
  glue.ratio.value = 2;
  glue.attack.value = 0.02;
  glue.release.value = 0.5;
  master.connect(glue).connect(ctx.destination);

  const bus = ctx.createGain();          // сюда идёт сухой сигнал
  bus.gain.value = 1;
  const wet = ctx.createGain();          // а сюда — эхо
  wet.gain.value = 0.38;
  const conv = ctx.createConvolver();
  bus.connect(master);
  bus.connect(conv).connect(wet).connect(master);

  let scene = SCENES[0];
  let running = false;
  let bedNodes = [];
  let padVoices = [];
  let voiceNodes = [];          // голоса мелодии: чтобы «стоп» глушил и запланированное вперёд
  let timers = [];
  const buffers = new Map();
  let motif = makeMotif();
  let degreeIndex = 0;
  let chord = null;
  let onStatus = () => {};

  /* ---------- загрузка записи ---------- */
  async function load(file) {
    if (buffers.has(file)) return buffers.get(file);
    const res = await fetch(file);
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    buffers.set(file, buf);
    return buf;
  }

  /* ---------- слой земли: две копии записи, дышащие вразнобой ---------- */
  function startBed(buf) {
    const cfg = scene.bed;
    bedNodes = [];
    for (let i = 0; i < 2; i++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // случайная точка входа: две копии никогда не совпадают по фазе,
      // поэтому повтора не слышно даже на коротких петлях
      src.start(ctx.currentTime, Math.random() * buf.duration);

      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = cfg.tone;
      tone.Q.value = 0.4;

      const g = ctx.createGain();
      g.gain.value = cfg.level / 2;

      // собственное «дыхание»: очень медленный LFO со своей фазой
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 1 / cfg.drift[i];
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = cfg.level * 0.22;
      lfo.connect(lfoGain).connect(g.gain);
      lfo.start(ctx.currentTime + Math.random() * cfg.drift[i]);

      const pan = ctx.createStereoPanner();
      pan.pan.value = (i === 0 ? -1 : 1) * cfg.spread;

      src.connect(tone).connect(g).connect(pan).connect(bus);
      bedNodes.push(src, lfo);
    }
  }

  function stopBed() {
    const t = ctx.currentTime;
    for (const n of bedNodes) {
      try {
        if (n.stop) n.stop(t + 2.5);
      } catch (e) {}
    }
    bedNodes = [];
  }

  /* ---------- полотно: аккорд входит и уходит очень медленно ---------- */
  function startChord(rootDegree, when, holdSec) {
    const degrees = chordDegrees(rootDegree);
    const voices = degrees.slice(0, 4);
    const t = when;
    chord = {
      label: degrees.map((d) => noteName(scaleNote(scene, d))).join(' · '),
      degree: rootDegree,
      at: t,
    };
    for (let i = 0; i < voices.length; i++) {
      const midi = scaleNote(scene, voices[i]);
      const freq = mtof(midi + (i === 0 ? -12 : 0));
      const g = ctx.createGain();
      g.gain.value = 0;
      const attack = rnd(12, 22);
      const release = rnd(18, 30);
      const peak = 0.055 * (i === 0 ? 1.15 : 1) / Math.sqrt(voices.length);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, t + Math.max(attack, holdSec - release));
      g.gain.linearRampToValueAtTime(0, t + holdSec + release);

      const pan = ctx.createStereoPanner();
      pan.pan.value = rnd(-0.5, 0.5) + (i === 0 ? 0 : 0);

      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = rnd(700, 1300);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = rnd(-7, 7);
      const osc2 = ctx.createOscillator();   // второй голос даёт мягкое биение
      osc2.type = 'sine';
      osc2.frequency.value = freq;
      osc2.detune.value = rnd(-9, 9);

      osc.connect(filt);
      osc2.connect(filt);
      filt.connect(g).connect(pan).connect(bus);
      osc.start(t);
      osc2.start(t);
      osc.stop(t + holdSec + release + 1);
      osc2.stop(t + holdSec + release + 1);
      padVoices.push(osc, osc2);
    }
  }

  /* ---------- голос: ноты мотива ---------- */
  function bell(freq, at, vel, holdSec, pan) {
    const out = ctx.createGain();
    out.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;

    // мягкая атака и длинный хвост: «палочки», а не синтезатор
    const attack = rnd(0.012, 0.03);
    const decay = Math.max(1.6, holdSec * 1.15);
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(vel, at + attack);
    out.gain.exponentialRampToValueAtTime(0.0008, at + decay);

    const partials = [
      [1, 1, 'sine'],
      [2.01, 0.3, 'sine'],
      [3.02, 0.12, 'sine'],
      [4.98, 0.05, 'triangle'],
    ];
    const started = [];
    for (const [mult, amp, type] of partials) {
      const o = ctx.createOscillator();
      o.type = type;
      // живая нестройность: у реальных колокольчиков её всегда слышно
      o.frequency.value = freq * mult;
      o.detune.value = rnd(-4, 4);
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(tone);
      o.start(at);
      o.stop(at + decay + 0.4);
      started.push(o);
    }
    tone.connect(out).connect(panner).connect(bus);
    voiceNodes.push({ gain: out, oscs: started });
    return started;
  }

  /** Одна фраза: 3–5 нот мотива под текущий аккорд, с дыханием и паузами. */
  function phrase(when) {
    if (!running) return;
    const m = scene.melody;
    const anchor = chord ? chord.degree + pick([0, 0, 2, 4]) : 0;
    const len = motif.length;
    const durs = [];
    for (let i = 0; i < len; i++) durs.push(pick([1.4, 2.2, 3.1, 4.2]) * (i === len - 1 ? 1.5 : 1));
    let t = when;
    const pan0 = rnd(-0.4, 0.4);
    for (let i = 0; i < len; i++) {
      const deg = anchor + motif[i];
      let midi = scaleNote(scene, deg) + 24;
      // укладываем в слышимый регистр сцены
      while (midi < m.register[0]) midi += 12;
      while (midi > m.register[1]) midi -= 12;
      const vel = m.level * rnd(0.62, 1) * (i === 0 ? 0.85 : 1) * (i === len - 1 ? 0.8 : 1);
      // человеческая задержка: без неё музыка звучит как метроном
      bell(mtof(midi), t + rnd(-0.06, 0.09), vel, durs[i], pan0 + rnd(-0.15, 0.15));
      // подголосок иногда дублирует ноту ниже — фраза становится «написанной»
      if (i === Math.floor(len / 2) && Math.random() < 0.45) {
        bell(mtof(midi - pick([7, 12, 5])), t + rnd(0.05, 0.25), vel * 0.45, durs[i] * 1.3, pan0);
      }
      t += durs[i] + (Math.random() < m.rest ? rnd(0.9, 2.4) : rnd(0.05, 0.35));
    }
    onStatus({ chord: chord && chord.label, motif: motif.join(' ') });
  }

  /* ---------- редкие настоящие акценты ---------- */
  async function accents() {
    let buf;
    try {
      buf = await load('../assets/chimes.m4a');
    } catch (e) {
      return;
    }
    const loop = async () => {
      if (!running) return;
      const cfg = scene.accents;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const off = Math.random() * Math.max(0, buf.duration - 4);
      const t = ctx.currentTime;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(bus);
      g.gain.linearRampToValueAtTime(cfg.level, t + rnd(3, 6));
      g.gain.setValueAtTime(cfg.level, t + rnd(4, 6));
      g.gain.linearRampToValueAtTime(0, t + 9);
      const pan = ctx.createStereoPanner();
      pan.pan.value = rnd(-0.5, 0.5);
      g.disconnect();
      g.connect(pan).connect(bus);
      src.start(t, off, 9.5);
      timers.push(setTimeout(loop, rnd(cfg.gap[0], cfg.gap[1]) * 1000));
    };
    loop();
  }

  /* ---------- прогрессия ---------- */
  function scheduleHarmony() {
    const [lo, hi] = scene.chordSec;
    const hold = rnd(lo, hi);
    startChord(scene.progression[degreeIndex % scene.progression.length], ctx.currentTime + 0.05, hold);
    // внутри аккорда — 1–2 фразы; их количество зависит от длины аккорда
    const phrases = hold > 32 ? 2 : 1;
    for (let i = 0; i < phrases; i++) {
      const at = ctx.currentTime + rnd(3, Math.max(4, hold * 0.4)) + i * rnd(11, 15);
      phrase(at);
    }
    degreeIndex++;
    timers.push(setTimeout(scheduleHarmony, (hold + rnd(2, 6)) * 1000));
  }

  /* ---------- управление ---------- */
  async function play(id) {
    stop();
    scene = sceneById(id);
    running = true;
    motif = makeMotif();
    degreeIndex = 0;
    conv.buffer = impulse(ctx, scene.reverb.seconds);
    wet.gain.value = scene.reverb.wet;
    const buf = await load(scene.file);
    if (!running) return;
    startBed(buf);
    scheduleHarmony();
    accents();
    return scene;
  }

  function stop() {
    running = false;
    for (const t of timers) clearTimeout(t);
    timers = [];
    stopBed();
    const t = ctx.currentTime;
    for (const v of voiceNodes) {
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setValueAtTime(Math.max(v.gain.gain.value, 0.0001), t);
        v.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        for (const o of v.oscs) o.stop(t + 0.7);
      } catch (e) {}
    }
    voiceNodes = [];
    for (const v of padVoices) {
      try {
        v.stop(t + 1.5);
      } catch (e) {}
    }
    padVoices = [];
    chord = null;
  }

  return {
    play,
    stop,
    setVolume: (v) => { master.gain.value = v; },
    onStatus: (fn) => { onStatus = fn; },
    get scene() { return scene; },
    get running() { return running; },
  };
}
