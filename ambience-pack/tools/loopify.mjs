/* ============================================================
   loopify.mjs — сборка бесшовных петель для VEGA/дибитишки
   ------------------------------------------------------------
   Берёт рецепт (JSON), читает дорожки в виде сырого float32
   (моно, 48 кГц), складывает слои, нормирует по RMS, заворачивает
   петлю кроссфейдом и пишет результат снова сырым f32 — кодирование
   в .m4a делает ffmpeg (см. build-ambience.sh).

   Почему так:
     • Кроссфейд «хвост в голову» (wrap crossfade) убирает щелчок на
       стыке — материал остаётся непрерывным, а не «обрезанным».
     • Длинная петля (30–60 с) + два слоя со случайными смещениями
       в движке (ambience.js) дают то, что не читается как повтор.
     • RMS-нормировка вместо пиковой: подложка садится под музыку
       ровно, без «то тише, то громче» между сценами.

   Запуск: node tools/loopify.mjs tools/recipes.json out/
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const SR = 48000;
const [, , recipePath, outDir] = process.argv;
const recipes = JSON.parse(readFileSync(recipePath, 'utf8'));
const rawDir = join(process.env.RAW_DIR || 'work/raw');

const readF32 = (p) => {
  const buf = readFileSync(p);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
const dbToGain = (db) => Math.pow(10, db / 20);
const rms = (x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
};
const peak = (x) => {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
};
const dbfs = (v) => 20 * Math.log10(Math.max(v, 1e-9));

/** Повторяет дорожку до нужной длины, сшивая копии кроссфейдом. */
function tileTo(src, length, crossfadeSec) {
  const F = Math.round(crossfadeSec * SR);
  const out = new Float32Array(length);
  const period = Math.max(1, src.length - F); // каждая следующая копия входит на F раньше
  const seam = src.length - F;
  for (let x = 0; x < length; x++) {
    const i = x % period;
    let v = src[Math.min(src.length - 1, i)];
    if (i >= seam) {
      const k = (i - seam) / F;
      v = src[i] * Math.cos((k * Math.PI) / 2) + src[i - seam] * Math.sin((k * Math.PI) / 2);
    }
    out[x] = v;
  }
  return out;
}

/** Заворачивает дорожку в петлю: последние F секунд переходят в первые. */
function wrapLoop(src, seconds, crossfadeSec) {
  const F = Math.round(crossfadeSec * SR);
  const T = Math.min(src.length, Math.round(seconds * SR));
  const body = T - F;
  const out = new Float32Array(T);
  for (let i = 0; i < body; i++) out[i] = src[i];
  for (let k = 0; k < F; k++) {
    const x = k / F;
    const a = src[body + k];          // естественное продолжение
    const b = src[k];                 // то, что было в самом начале
    const w = Math.sin((x * Math.PI) / 2);
    out[body + k] = a * Math.cos((x * Math.PI) / 2) + b * w;
  }
  return out;
}

mkdirSync(outDir, { recursive: true });
const report = [];
for (const r of recipes) {
  const layers = r.layers.map((l) => {
    const data = readF32(join(rawDir, l.file));
    return { ...l, data };
  });
  const maxLen = Math.max(...layers.map((l) => (l.tile ? Math.round((l.seconds || 40) * SR) : l.data.length)));
  const mixed = new Float32Array(maxLen);
  for (const l of layers) {
    const src = l.tile ? tileTo(l.data, maxLen, l.tile_crossfade || 1.6) : l.data;
    const g = dbToGain(l.gain_db || 0);
    for (let i = 0; i < maxLen; i++) mixed[i] += (i < src.length ? src[i] : 0) * g;
  }
  const before = rms(mixed);
  const g = dbToGain(r.target_rms_dbfs || -26) / before;
  for (let i = 0; i < mixed.length; i++) mixed[i] *= g;

  const loop = wrapLoop(mixed, r.seconds || 45, r.crossfade || 6);

  // Мягкий лимитер: tanh бережно округляет редкие пики (капли, всплески),
  // не срезая их в полку — RMS при этом остаётся почти на месте.
  const ceiling = dbToGain(-1.5);
  const k = ceiling / 0.9;
  for (let i = 0; i < loop.length; i++) loop[i] = k * Math.tanh(loop[i] / k);

  // итоговая подстройка: цель по RMS, но без выхода за потолок
  const target = dbToGain(r.target_rms_dbfs || -26);
  let g2 = target / rms(loop);
  const p = peak(loop) * g2;
  if (p > ceiling) g2 *= ceiling / p;
  for (let i = 0; i < loop.length; i++) loop[i] *= g2;

  /* Проверка стыка — по громкости вокруг точки склейки, а не по отдельным
     сэмплам: ухо слышит скачок огибающей, а не разность двух отсчётов шума.
     Берём 20-мс кадры: пять до конца файла и пять после начала (по кругу) и
     смотрим, насколько кадры у самого стыка выбиваются из соседей. */
  const frame = Math.round(0.02 * SR);
  const frameRms = (start) => {
    let s = 0;
    for (let i = 0; i < frame; i++) {
      const x = loop[((start + i) % loop.length + loop.length) % loop.length];
      s += x * x;
    }
    return Math.sqrt(s / frame);
  };
  const around = [];
  for (let n = -4; n <= 4; n++) around.push(frameRms(loop.length + n * frame));
  const seamFrame = Math.max(around[3], around[5]); // кадры, между которыми стык
  const neighbours = around.filter((_, i) => i !== 3 && i !== 5);
  const med = neighbours.slice().sort((a, b) => a - b)[Math.floor(neighbours.length / 2)];
  const seamDevDb = dbfs(seamFrame / Math.max(med, 1e-9));

  const name = r.out;
  writeFileSync(join(outDir, `${name}.f32`), Buffer.from(loop.buffer, loop.byteOffset, loop.byteLength));
  report.push({
    out: name,
    seconds: +(loop.length / SR).toFixed(2),
    crossfade: r.crossfade || 6,
    rms_dbfs: +dbfs(rms(loop)).toFixed(2),
    peak_dbfs: +dbfs(peak(loop)).toFixed(2),
    seam_dev_db: +seamDevDb.toFixed(1),
    source_rms_dbfs: +dbfs(before).toFixed(2),
  });
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
for (const r of report) {
  console.log(`${r.out.padEnd(9)} ${String(r.seconds).padStart(6)} с  кроссфейд ${String(r.crossfade).padStart(2)} с  RMS ${String(r.rms_dbfs).padStart(6)} dBFS  пик ${String(r.peak_dbfs).padStart(6)} dBFS  стык ${String(r.seam_dev_db).padStart(5)} дБ`);
}
