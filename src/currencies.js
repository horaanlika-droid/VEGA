// Реестр направлений обмена: ₽ → BTC / LTC / USDT (TRC20/ERC20) / Google Gift Card USD.
// Одно место, где описаны ключи настроек, точность, правила адресов и номиналов.
// key — стабильный идентификатор направления (используется в настройках и заявках).
//
// direction — что клиент делает:
//   'buy'  — платит рубли, получает крипту/код (₽ → BTC/LTC/USDT);
//   'sell' — отдаёт код гифт-карты (номинал в $), получает USDT, сеть выбирает сам.
const PAIRS = {
  BTC: {
    key: 'BTC',
    direction: 'buy',
    currency: 'BTC',
    network: null,
    coin: 'btc', // ключ официального курса
    symbol: '₿',
    label: 'BTC',
    name: 'Bitcoin',
    decimals: 8, // точность суммы к выплате
    display: null, // точность отображения (null → по величине суммы)
    rateDecimals: 0, // точность курса, ₽
    rateKey: 'rateBTC',
    baseKey: 'baseRateBTC',
    feeKey: 'feePercent',
    walletHint: 'Адрес BTC-кошелька (bc1… / 1… / 3…)',
    walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    walletError: 'Проверьте адрес BTC-кошелька — он выглядит некорректно.',
  },
  LTC: {
    key: 'LTC',
    direction: 'buy',
    currency: 'LTC',
    network: null,
    coin: 'ltc',
    symbol: 'Ł',
    label: 'LTC',
    name: 'Litecoin',
    decimals: 8,
    display: null,
    rateDecimals: 0,
    rateKey: 'rateLTC',
    baseKey: 'baseRateLTC',
    feeKey: 'feePercent',
    walletHint: 'Адрес LTC-кошелька (ltc1… / L… / M… / 3…)',
    walletPattern: '^(ltc1[a-zA-HJ-NP-Z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    walletError: 'Проверьте адрес LTC-кошелька — он выглядит некорректно.',
  },
  'USDT_TRC20': {
    key: 'USDT_TRC20',
    direction: 'buy',
    currency: 'USDT',
    network: 'TRC20',
    coin: 'usdt',
    symbol: '₮',
    label: 'USDT TRC20',
    name: 'Tether (TRC20)',
    decimals: 6,
    display: 2,
    rateDecimals: 2,
    rateKey: 'rateUSDTTRC20',
    baseKey: 'baseRateUSDT',
    feeKey: 'feePercentUSDTTRC20',
    walletHint: 'Адрес USDT TRC20 (начинается с T, 34 символа)',
    walletPattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$',
    walletError: 'Это не похоже на адрес USDT в сети TRC20 — он начинается с T и содержит 34 символа.',
  },
  'USDT_ERC20': {
    key: 'USDT_ERC20',
    direction: 'buy',
    currency: 'USDT',
    network: 'ERC20',
    coin: 'usdt',
    symbol: '₮',
    label: 'USDT ERC20',
    name: 'Tether (ERC20)',
    decimals: 6,
    display: 2,
    rateDecimals: 2,
    rateKey: 'rateUSDTERC20',
    baseKey: 'baseRateUSDT',
    feeKey: 'feePercentUSDTERC20',
    walletHint: 'Адрес USDT ERC20 (0x + 40 символов)',
    walletPattern: '^0x[0-9a-fA-F]{40}$',
    walletError: 'Это не похоже на адрес USDT в сети ERC20 — нужен 0x и 40 hex-символов.',
  },
  // Подарочные карты: клиент отдаёт код карты с номиналом в долларах, мы проверяем
  // его и выплачиваем USDT (сеть выбирает клиент). Номинал — от $10 и кратно $10.
  // По умолчанию 1 $ номинала = 1 USDT; админ назначает комиссию (giftPercent).
  // Курс фиксированный относительно номинала: $10 → 8.5 USDT при комиссии 15%.
  GOOGLE_USD: {
    key: 'GOOGLE_USD',
    direction: 'sell',
    currency: 'GOOGLE_USD',
    network: null,
    coin: 'google',
    symbol: '🎁',
    label: 'Google Gift Card',
    name: 'Google Gift Card USD',
    kind: 'gift', // выплата кодом, а не переводом в сети
    decimals: 0, // номинал храним целым числом долларов
    display: 0,
    rateDecimals: 2,
    // Курс — сколько USDT платим за $1 номинала: (100 − giftPercent) / 100.
    // При giftPercent = 0 → 1 USDT за $1 (по номиналу, дефолт); 15% → 0.85 → карта $10 даёт 8.5 USDT.
    rateKey: 'rateGOOGLEUSD',
    baseKey: null,
    feeKey: 'giftPercent',
    rateLabel: 'USDT за $1 номинала',
    unit: 'USD',
    step: 10, // номинал кратен $10
    minUnits: 10, // минимум $10
    walletOptional: false, // адрес USDT нужен — это выплата
    walletHint: 'Адрес USDT-кошелька для выплаты (T… или 0x…)',
    walletPattern: '^(T[1-9A-HJ-NP-Za-km-z]{33}|0x[0-9a-fA-F]{40})$',
    walletError: 'Укажите адрес USDT: TRC20 начинается с T (34 символа), ERC20 — 0x и 40 hex-символов.',
    networkByWallet: true, // сеть определяем по адресу
    // Сноска для клиента: где взять карту и какую валюту выбирать.
    infoNote:
      'Карту можно купить на любом маркетплейсе — Яндекс Маркет, Ozon, Wildberries и т. д. ' +
      'Выбирайте карту именно в USD (долларах США): карты в рублях и других валютах не принимаются.',
    currencyNote: 'Проверьте валюту карты: нужен номинал в USD ($).',
    ttlMinutes: 60, // час на сделку
    note: 'Код карты оператор проверит вручную и сразу выплатит USDT на указанный кошелёк.',
  },
};

const LIST = Object.values(PAIRS);

const norm = (v) => String(v ?? '').trim().toUpperCase();

// Ключ направления из пары «валюта + сеть» (заявки хранят их раздельно).
function keyOf(currency, network) {
  const cur = norm(currency);
  if (cur === 'GOOGLE_USD' || cur === 'GOOGLE' || cur === 'GIFTCARD' || cur === 'GOOGLE_GIFT_CARD') return GIFT_KEY;
  if (cur === 'USDT') {
    const net = norm(network);
    if (net === 'TRC20' || net === 'TRON') return 'USDT_TRC20';
    if (net === 'ERC20' || net === 'ETH' || net === 'ETHEREUM') return 'USDT_ERC20';
    return null;
  }
  return PAIRS[cur] ? cur : null;
}

const find = (currency, network) => PAIRS[keyOf(currency, network)] || null;
const get = (key) => PAIRS[norm(key)] || null;
const list = () => LIST;

const isEnabled = (settings, key) => {
  const pair = get(key);
  if (!pair) return false;
  const enabled = settings && settings.enabled;
  return !enabled || enabled[pair.key] !== false;
};

// Итоговый курс для клиента (с комиссией). null — направление ещё не настроено.
function rateOf(settings, currency, network) {
  const pair = find(currency, network);
  if (!pair || !settings) return null;
  if (!isEnabled(settings, pair.key)) return null;
  const rate = Number(settings[pair.rateKey]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

// Сети для формы клиента: подписи и подсказки по комиссии/скорости.
const NETWORKS = { TRC20: 'TRON (TRC20)', ERC20: 'Ethereum (ERC20)' };
const networkHint = (network) => {
  const net = norm(network);
  if (net === 'TRC20') return 'сеть TRON · низкая комиссия, зачисление 1–3 мин';
  if (net === 'ERC20') return 'сеть Ethereum · высокая комиссия сети, зачисление 5–15 мин';
  return null;
};

function label(currency, network) {
  const pair = find(currency, network);
  return pair ? pair.label : [norm(currency), norm(network)].filter(Boolean).join(' ');
}

function shortLabel(currency, network) {
  const pair = find(currency, network);
  return pair ? pair.key.replace('_', ' · ') : label(currency, network);
}

// Подарочная карта (код) либо перевод в сети.
const isGift = (currency, network) => {
  const pair = find(currency, network);
  return !!pair && pair.kind === 'gift';
};

const directionOf = (currency, network) => {
  const pair = find(currency, network);
  return pair ? pair.direction || 'buy' : 'buy';
};

const GIFT_KEY = 'GOOGLE_USD';
const gift = () => PAIRS[GIFT_KEY];

// Сеть USDT по адресу: T… → TRC20, 0x… → ERC20.
function networkByWallet(wallet) {
  const w = String(wallet ?? '').trim();
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(w)) return 'TRC20';
  if (/^0x[0-9a-fA-F]{40}$/.test(w)) return 'ERC20';
  return null;
}

// Точность суммы к выплате: у гифт-карт выплата в USDT, а не в номинале.
function payoutDecimals(currency, network) {
  if (isGift(currency, network)) return displayDecimals('USDT', 'TRC20');
  return decimalsOf(currency, network);
}

function payoutCurrency(currency, network) {
  return isGift(currency, network) ? 'USDT' : currency;
}

// Шаг номинала (кратность). null — свободная сумма.
const stepOf = (currency, network) => {
  const pair = find(currency, network);
  const step = Number(pair && pair.step);
  return Number.isFinite(step) && step > 0 ? step : null;
};

const minUnitsOf = (currency, network) => {
  const pair = find(currency, network);
  return Number.isFinite(Number(pair && pair.minUnits)) ? Number(pair.minUnits) : 0;
};

// Приводит номинал вниз к разрешённому значению (кратно шагу, не меньше минимума).
function floorUnits(currency, network, units) {
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = stepOf(currency, network) || 1;
  return Math.floor(n / step + 1e-9) * step;
}

// Возвращает текст ошибки или null, если номинал подходит направлению.
function validateUnits(currency, network, units) {
  const n = Number(units);
  const step = stepOf(currency, network);
  const min = minUnitsOf(currency, network);
  if (!Number.isFinite(n) || n <= 0) return 'Укажите номинал карты.';
  if (min && n < min) return `Минимальный номинал — $${min}.`;
  if (step && Math.abs(n / step - Math.round(n / step)) > 1e-9) return `Сумма должна быть кратна $${step}.`;
  return null;
}

function symbol(currency, network) {
  const pair = find(currency, network);
  return pair ? pair.symbol : '🪙';
}

function decimalsOf(currency, network) {
  const pair = find(currency, network);
  return pair ? pair.decimals : 8;
}

// Точность для сообщений/интерфейса: USDT — 2 знака, BTC/LTC — 8.
function displayDecimals(currency, network) {
  const pair = find(currency, network);
  if (!pair) return 8;
  return pair.display === null || pair.display === undefined ? pair.decimals : pair.display;
}

// Возвращает текст ошибки или null, если адрес подходит под направление.
function validateWallet(currency, network, wallet) {
  const pair = find(currency, network);
  const w = String(wallet ?? '').trim();
  if (!pair) return 'Неизвестная валюта';
  // Подарочная карта: реквизиты не нужны, код оператор отправит в чат.
  if (pair.walletOptional) return null;
  if (!w) return 'Укажите адрес кошелька для выплаты.';
  if (/\s/.test(w)) return 'Адрес кошелька не должен содержать пробелов.';
  if (w.length < 26 || w.length > 128) return pair.walletError;
  if (!new RegExp(pair.walletPattern).test(w)) return pair.walletError;
  return null;
}

// Публичное описание направлений для клиента: только итоговый курс с комиссией.
// baseRate*/fee* сюда не попадают — их видит лишь оператор в боте.
function publicRates(settings) {
  return LIST.map((p) => ({
    key: p.key,
    direction: p.direction || 'buy',
    currency: p.currency,
    network: p.network,
    label: p.label,
    name: p.name,
    symbol: p.symbol,
    coin: p.coin,
    decimals: p.decimals,
    display: p.display,
    walletHint: p.walletHint,
    walletPattern: p.walletPattern,
    walletError: p.walletError,
    networkHint: networkHint(p.network),
    kind: p.kind || 'crypto',
    unit: p.unit || null,
    rateLabel: p.rateLabel || null,
    infoNote: p.infoNote || null,
    currencyNote: p.currencyNote || null,
    ttlMinutes: p.ttlMinutes || null,
    step: p.step || null,
    minUnits: p.minUnits || null,
    walletOptional: !!p.walletOptional,
    networkByWallet: !!p.networkByWallet,
    note: p.note || null,
    rate: rateOf(settings, p.currency, p.network),
    enabled: isEnabled(settings, p.key),
    minRub: settings ? Number(settings.minRub) || 0 : 0,
    maxRub: settings ? Number(settings.maxRub) || 0 : 0,
  }));
}

// Сколько USDT получит клиент, отдавший карту на units долларов.
// Курс карты — доля номинала в USDT (при 0%: $10 → 10 USDT), от сети не зависит.
function giftPayout(settings, units, network) {
  const cardRate = rateOf(settings, GIFT_KEY, null);
  if (!(cardRate > 0)) return null;
  if (!isEnabled(settings, network === 'ERC20' ? 'USDT_ERC20' : 'USDT_TRC20')) return null;
  const dec = payoutDecimals(GIFT_KEY);
  const mul = 10 ** dec;
  const crypto = Math.floor((Number(units) || 0) * cardRate * mul + 1e-6) / mul;
  const usdtRate = rateOf(settings, 'USDT', network);
  return { crypto, rate: cardRate, cardRate, usdtRate };
}

const giftRateFromPercent = (percent) => {
  const p = Number(percent);
  const safe = Number.isFinite(p) ? Math.min(Math.max(p, 0), 95) : 0;
  return Math.round((100 - safe)) / 100;
};

// Обратный пересчёт: какой процент соответствует курсу (для ручного ввода).
const giftPercentFromRate = (rate) => {
  const r = Number(rate);
  if (!(r > 0) || r > 100) return 0;
  return Math.round((100 - r * 100) * 100) / 100;
};

function giftPayouts(settings) {
  if (!settings) return [];
  return ['TRC20', 'ERC20']
    .map((network) => ({
      network,
      rate: Number(settings[network === 'TRC20' ? 'rateUSDTTRC20' : 'rateUSDTERC20']) || null,
      enabled: isEnabled(settings, network === 'TRC20' ? 'USDT_TRC20' : 'USDT_ERC20'),
    }))
    .filter((p) => p.rate);
}

module.exports = {
  PAIRS,
  NETWORKS,
  networkHint,
  LIST,
  publicRates,
  keyOf,
  find,
  get,
  list,
  isEnabled,
  rateOf,
  label,
  shortLabel,
  symbol,
  isGift,
  directionOf,
  GIFT_KEY,
  gift,
  networkByWallet,
  payoutDecimals,
  payoutCurrency,
  giftRateFromPercent,
  giftPercentFromRate,
  giftPayout,
  giftPayouts,
  stepOf,
  minUnitsOf,
  floorUnits,
  validateUnits,
  decimalsOf,
  displayDecimals,
  validateWallet,
};
