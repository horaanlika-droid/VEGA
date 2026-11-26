// Реестр направлений обмена: ₽ → BTC / LTC / USDT (TRC20/ERC20) и USD gift-карты.
// Одно место, где описаны ключи настроек, точность, правила адресов и номиналов.
// key — стабильный идентификатор направления (используется в настройках и заявках).
//
// direction — что клиент делает:
//   'buy'  — платит рубли, получает крипту (₽ → BTC/LTC/USDT);
//   'sell' — отдаёт код USD-подарочной карты, получает выплату в BTC.
const GIFT_KEY = 'GOOGLE_USD';
const GIFT_KEYS = ['GOOGLE_USD', 'ITUNES_USD', 'XBOX_USD', 'APPLE_STORE_USD'];
const GIFT_ALIASES = {
  GOOGLE: 'GOOGLE_USD',
  GOOGLE_GIFT_CARD: 'GOOGLE_USD',
  GIFTCARD: 'GOOGLE_USD',
  ITUNES: 'ITUNES_USD',
  ITUNES_GIFT_CARD: 'ITUNES_USD',
  XBOX: 'XBOX_USD',
  XBOX_GIFT_CARD: 'XBOX_USD',
  APPLE: 'APPLE_STORE_USD',
  APPLE_STORE: 'APPLE_STORE_USD',
  APPLE_STORE_GIFT_CARD: 'APPLE_STORE_USD',
};

function giftPair(key, label, coin, symbol) {
  return {
    key,
    direction: 'sell',
    currency: key,
    network: null,
    coin,
    symbol,
    label,
    name: `${label} USD`,
    kind: 'gift',
    payoutCurrency: 'BTC',
    payoutDecimals: 8,
    decimals: 0, // номинал храним целым числом долларов
    display: 0,
    rateDecimals: 8,
    // Общий BTC-курс за $1 для USD gift-карт с учётом giftPercent.
    rateKey: 'rateGOOGLEUSD',
    baseKey: null,
    feeKey: 'giftPercent',
    rateLabel: 'BTC за $1 номинала',
    unit: 'USD',
    step: 10,
    minUnits: 10,
    walletOptional: false,
    walletHint: 'Адрес Bitcoin-кошелька (bc1… / 1… / 3…)',
    walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    walletError: 'Проверьте адрес Bitcoin-кошелька — он выглядит некорректно.',
    infoNote:
      'Карту можно купить на любом маркетплейсе — Яндекс Маркет, Ozon, Wildberries и т. д. ' +
      'Нужна карта для региона США с номиналом в USD; карты других регионов и валют не принимаются.',
    currencyNote: 'Проверьте регион карты: США, валюта номинала — USD ($).',
    ttlMinutes: 60,
    note: 'Код карты оператор проверит вручную и выплатит BTC на указанный кошелёк.',
  };
}

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
  // Все подарочные карты выплачиваются в BTC по общему USD/BTC-курсу.
  GOOGLE_USD: giftPair('GOOGLE_USD', 'Google Gift Card', 'google', '🎁'),
  ITUNES_USD: giftPair('ITUNES_USD', 'iTunes Gift Card', 'itunes', '🎵'),
  XBOX_USD: giftPair('XBOX_USD', 'Xbox Gift Card', 'xbox', '🎮'),
  APPLE_STORE_USD: giftPair('APPLE_STORE_USD', 'Apple Store Gift Card', 'apple', '🍎'),
};

const LIST = Object.values(PAIRS);

const norm = (v) => String(v ?? '').trim().toUpperCase();

// Ключ направления из пары «валюта + сеть» (заявки хранят их раздельно).
function keyOf(currency, network) {
  const cur = norm(currency);
  if (GIFT_KEYS.includes(cur)) return cur;
  if (GIFT_ALIASES[cur]) return GIFT_ALIASES[cur];
  if (cur === 'USDT') {
    const net = norm(network);
    if (net === 'TRC20' || net === 'TRON') return 'USDT_TRC20';
    if (net === 'ERC20' || net === 'ETH' || net === 'ETHEREUM') return 'USDT_ERC20';
    return null;
  }
  return PAIRS[cur] ? cur : null;
}

const find = (currency, network) => PAIRS[keyOf(currency, network)] || null;
const get = (key) => PAIRS[keyOf(key, null)] || null;
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

const gift = (key = GIFT_KEY) => PAIRS[norm(key)] || PAIRS[GIFT_KEY];

// Для старых заявок сохраняем прежнюю валюту выплаты: network=TRC20/ERC20 означает USDT.
// Новые gift-заявки явно хранят payoutCurrency=BTC и не имеют сети.
function payoutCurrency(currency, network, explicitCurrency) {
  if (explicitCurrency) return norm(explicitCurrency);
  if (isGift(currency, network)) return network ? 'USDT' : 'BTC';
  return norm(currency);
}

function payoutCurrencyOf(order) {
  return order ? payoutCurrency(order.currency, order.network, order.payoutCurrency) : null;
}

// Точность суммы к выплате: для гифт-карт это точность валюты выплаты, не номинала.
function payoutDecimals(currency, network, explicitCurrency) {
  const payout = payoutCurrency(currency, network, explicitCurrency);
  return displayDecimals(payout, payout === 'USDT' ? network : null);
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
    payoutCurrency: p.payoutCurrency || null,
    payoutDecimals: p.payoutDecimals ?? null,
    unit: p.unit || null,
    rateLabel: p.rateLabel || null,
    infoNote: p.infoNote || null,
    currencyNote: p.currencyNote || null,
    ttlMinutes: p.ttlMinutes || null,
    step: p.step || null,
    minUnits: p.minUnits || null,
    walletOptional: !!p.walletOptional,
    note: p.note || null,
    rate: rateOf(settings, p.currency, p.network),
    enabled: isEnabled(settings, p.key),
    minRub: settings ? Number(settings.minRub) || 0 : 0,
    maxRub: settings ? Number(settings.maxRub) || 0 : 0,
  }));
}

const positiveRate = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Рыночный BTC за $1: вначале официальные BTC/USD-эквиваленты, до первого
// обновления курсов — стартовые курсы BTC и USDT, уже заданные в настройках.
function giftSpotRate(settings) {
  if (!settings) return null;
  const btcRub = positiveRate(settings.baseRateBTC) || positiveRate(settings.rateBTC);
  const usdRub =
    positiveRate(settings.baseRateUSD) ||
    positiveRate(settings.baseRateUSDT) ||
    positiveRate(settings.rateUSDTTRC20) ||
    positiveRate(settings.rateUSDTERC20);
  if (!(btcRub > 0) || !(usdRub > 0)) return null;
  return usdRub / btcRub;
}

// BTC за $1 номинала после скидки giftPercent.
function giftRateFromPercent(percent, settings) {
  const p = Number(percent);
  const safe = Number.isFinite(p) ? Math.min(Math.max(p, 0), 50) : 0;
  const spot = giftSpotRate(settings);
  if (!(spot > 0)) return null;
  return Math.round((spot * (1 - safe / 100)) * 1e12) / 1e12;
}

// Обратный пересчёт: какой процент скидки соответствует BTC-курсу.
function giftPercentFromRate(rate, settings) {
  const r = Number(rate);
  const spot = giftSpotRate(settings);
  if (!(r > 0) || !(spot > 0) || r > spot) return 0;
  return Math.round((1 - r / spot) * 10000) / 100;
}

// Сколько BTC получит клиент за выбранную карту. Выплата округляется вниз до сатоши.
function giftPayout(settings, units, currency = GIFT_KEY) {
  const pair = find(currency, null);
  if (!pair || pair.kind !== 'gift') return null;
  const cardRate = rateOf(settings, pair.currency, pair.network);
  if (!(cardRate > 0)) return null;
  const n = Number(units);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mul = 10 ** payoutDecimals(pair.currency, pair.network);
  const crypto = Math.floor(n * cardRate * mul + 1e-6) / mul;
  const btcRub = positiveRate(settings.baseRateBTC) || positiveRate(settings.rateBTC);
  return {
    crypto,
    rate: cardRate,
    cardRate,
    btcRub,
    rub: btcRub ? Math.round(crypto * btcRub) : null,
  };
}

function giftPayouts(settings) {
  if (!settings) return [];
  return GIFT_KEYS
    .map((key) => ({ currency: key, network: null, rate: rateOf(settings, key, null), enabled: isEnabled(settings, key) }))
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
  GIFT_KEYS,
  gift,
  payoutDecimals,
  payoutCurrency,
  payoutCurrencyOf,
  giftSpotRate,
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
