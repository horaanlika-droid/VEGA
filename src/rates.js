// Официальные курсы BTC/LTC/USDT к рублю: автообновление с публичных источников.
// Итоговый курс для клиентов = официальный × (1 + комиссия/100).
// Комиссию задаёт оператор в админ-панели, официальный курс трогать не нужно.
const store = require('./store');

const INTERVAL_MS = Number(process.env.RATES_INTERVAL_MS) || 5 * 60 * 1000;
const DISABLED = process.env.RATES_DISABLED === '1';

// Параметры запросов стабильны и не зависят от времени, но передаём их явно:
// это удобно логировать и тестировать.
const P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const P2P_QUERY = { page: 1, rows: 10, asset: 'USDT', fiat: 'RUB' };

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'VEGA-exchange/1.0', accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

// Середина лучшего бида/аска по P2P — самая честная «рыночная» цена USDT за рубли.
function p2pMid(sellRows, buyRows) {
  const price = (row) => num(row?.adv?.price);
  const sell = sellRows.map(price).filter(Number.isFinite).sort((a, b) => a - b);
  const buy = buyRows.map(price).filter(Number.isFinite).sort((a, b) => b - a);
  if (!sell.length || !buy.length) return NaN;
  return (sell[0] + buy[0]) / 2;
}

// Binance P2P: USDT/RUB — основной источник для USDT (P2P-рынок РФ).
// Берём отдельно лучший аск (SELL-объявления) и лучший бид (BUY-объявления) и усредняем.
async function fromBinanceP2P() {
  const url = (tradeType) =>
    `${P2P_URL}?page=${P2P_QUERY.page}&rows=${P2P_QUERY.rows}` +
    `&payTypes=&countries=&publisherType=&asset=${P2P_QUERY.asset}&fiat=${P2P_QUERY.fiat}&tradeType=${tradeType}`;
  const [sell, buy] = await Promise.all([
    fetchJson(url('SELL')).catch(() => null),
    fetchJson(url('BUY')).catch(() => null),
  ]);
  const rows = (d) => (Array.isArray(d?.data) ? d.data : []);
  // Округляем до копеек: курс USDT в интерфейсе и в базе показываем с 2 знаками.
  return { usdt: Math.round(num(p2pMid(rows(sell), rows(buy))) * 100) / 100 };
}

// CoinGecko: прямые пары к рублю.
async function fromCoinGecko() {
  const d = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin,tether&vs_currencies=rub'
  );
  return { btc: num(d?.bitcoin?.rub), ltc: num(d?.litecoin?.rub), usdt: num(d?.tether?.rub) };
}

// Coinbase: кросс-курсы BTC→RUB и LTC→RUB.
async function fromCoinbase() {
  const [btc, ltc] = await Promise.all([
    fetchJson('https://api.coinbase.com/v2/exchange-rates?currency=BTC'),
    fetchJson('https://api.coinbase.com/v2/exchange-rates?currency=LTC'),
  ]);
  return { btc: num(btc?.data?.rates?.RUB), ltc: num(ltc?.data?.rates?.RUB), usdt: NaN };
}

// Kraken (USD-пары) × курс ЦБ (USD→RUB): запасной вариант для BTC/LTC.
async function fromKrakenCbr() {
  const [ticker, cbr] = await Promise.all([
    fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,LTCUSD'),
    fetchJson('https://www.cbr-xml-daily.ru/daily_json.js'),
  ]);
  const usd = num(cbr?.Valute?.USD?.Value);
  const btcUsd = num(ticker?.result?.XXBTZUSD?.c?.[0]);
  const ltcUsd = num(ticker?.result?.XLTCZUSD?.c?.[0]);
  return { btc: btcUsd * usd, ltc: ltcUsd * usd, usdt: usd };
}

// ЦБ РФ: если P2P и CoinGecko недоступны, считаем USDT ≈ USD.
async function fromCbrUsdt() {
  const cbr = await fetchJson('https://www.cbr-xml-daily.ru/daily_json.js');
  return { usdt: num(cbr?.Valute?.USD?.Value) };
}

// Запасной источник USDT — MOEX/ЦБ (см. выше): USDT ≈ USD.
async function fromCbrUsdt() {
  const cbr = await fetchJson('https://www.cbr-xml-daily.ru/daily_json.js');
  return { usdt: num(cbr?.Valute?.USD?.Value) };
}

// Источники возвращают частичный результат: курсы разных монет можно брать из разных источников.
const SOURCES = [
  ['coingecko', fromCoinGecko],
  ['binance-p2p', fromBinanceP2P],
  ['coinbase', fromCoinbase],
  ['kraken+cbr', fromKrakenCbr],
  ['cbr-usdt', fromCbrUsdt],
];

// Грубая проверка правдоподобности, чтобы мусор из API не попал в курсы.
// Источники могут прислать только часть монет — берём то, что похоже на правду.
function clean(part) {
  const out = {};
  const btc = Number(part?.btc);
  const ltc = Number(part?.ltc);
  const usdt = Number(part?.usdt);
  if (Number.isFinite(btc) && btc > 10000 && btc < 1e9) out.btc = btc;
  if (Number.isFinite(ltc) && ltc > 100 && ltc < 1e7) out.ltc = ltc;
  if (Number.isFinite(usdt) && usdt > 20 && usdt < 400) out.usdt = usdt;
  if (out.btc && out.ltc) {
    const ratio = out.btc / out.ltc;
    if (!(ratio > 50 && ratio < 50000)) {
      delete out.btc;
      delete out.ltc;
    }
  }
  return out;
}

// Приоритет источников для USDT: P2P-рынок РФ честнее всего отражает реальную цену.
const USDT_PRIORITY = ['binance-p2p', 'coingecko', 'kraken+cbr', 'cbr-usdt'];

async function fetchOfficial() {
  const errors = [];
  const parts = {};
  await Promise.all(
    SOURCES.map(async ([name, fn]) => {
      try {
        const checked = clean(await fn());
        if (!Object.keys(checked).length) {
          errors.push(`${name}: неправдоподобные значения`);
          return;
        }
        parts[name] = checked;
      } catch (e) {
        errors.push(`${name}: ${e.message}`);
      }
    })
  );

  const result = {};
  const sources = [];
  // BTC/LTC: первый источник (в порядке SOURCES), который дал пару курсов.
  for (const [name] of SOURCES) {
    const part = parts[name];
    if (!part || part.btc === undefined || part.ltc === undefined) continue;
    result.btc = part.btc;
    result.ltc = part.ltc;
    sources.push(name.split('-')[0]);
    break;
  }
  // USDT: строгий приоритет P2P → CoinGecko → биржи/ЦБ.
  for (const name of USDT_PRIORITY) {
    const part = parts[name];
    if (!part || part.usdt === undefined) continue;
    result.usdt = part.usdt;
    sources.push(name.split('-')[0]);
    break;
  }

  if (result.btc === undefined || result.ltc === undefined || result.usdt === undefined) {
    throw new Error(errors.join('; ') || 'нет источников курса');
  }
  result.source = [...new Set(sources)].join('+') || 'manual';
  return result;
}

const applyFee = (base, fee, decimals = 0) => {
  const v = base * (1 + fee / 100);
  const mul = 10 ** decimals;
  return Math.max(decimals ? 1 / mul : 1, Math.round(v * mul) / mul);
};

function applyRates(official) {
  return store.mutate((db) => {
    const s = db.settings;
    const fee = Number(s.feePercent) || 0;
    s.baseRateBTC = Math.round(official.btc);
    s.baseRateLTC = Math.round(official.ltc);
    s.baseRateUSDT = Math.round(official.usdt * 100) / 100;
    s.rateBTC = applyFee(official.btc, fee);
    s.rateLTC = applyFee(official.ltc, fee);
    s.rateUSDTTRC20 = applyFee(official.usdt, Number(s.feePercentUSDTTRC20) || 0, 2);
    s.rateUSDTERC20 = applyFee(official.usdt, Number(s.feePercentUSDTERC20) || 0, 2);
    s.rateUpdatedAt = Date.now();
    s.rateSource = official.source;
    return s;
  });
}

// Пересчёт итоговых курсов после смены комиссии (официальные не трогаем).
function recomputeWithFee() {
  return store.mutate((db) => {
    const s = db.settings;
    const fee = Number(s.feePercent) || 0;
    if (s.baseRateBTC) s.rateBTC = applyFee(s.baseRateBTC, fee);
    if (s.baseRateLTC) s.rateLTC = applyFee(s.baseRateLTC, fee);
    if (s.baseRateUSDT) {
      s.rateUSDTTRC20 = applyFee(s.baseRateUSDT, Number(s.feePercentUSDTTRC20) || 0, 2);
      s.rateUSDTERC20 = applyFee(s.baseRateUSDT, Number(s.feePercentUSDTERC20) || 0, 2);
    }
    return s;
  });
}

async function refreshRates() {
  const official = await fetchOfficial();
  return { settings: applyRates(official), source: official.source };
}

function startRates() {
  if (DISABLED) {
    console.log('[rates] автообновление курса отключено (RATES_DISABLED=1)');
    return null;
  }
  console.log(`[rates] автообновление официального курса каждые ${Math.round(INTERVAL_MS / 1000)} c`);
  refreshRates()
    .then(({ source }) => console.log('[rates] курс обновлён, источник:', source))
    .catch((e) => console.error('[rates] первичное обновление не удалось, оставлены текущие курсы:', e.message));
  const timer = setInterval(() => {
    refreshRates()
      .then(({ source }) => console.log('[rates] курс обновлён, источник:', source))
      .catch((e) => console.error('[rates] обновление не удалось:', e.message));
  }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = { startRates, refreshRates, recomputeWithFee, applyFee, fetchOfficial };
