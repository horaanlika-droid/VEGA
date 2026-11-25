// Реестр направлений обмена: ₽ → BTC / LTC / USDT (TRC20) / USDT (ERC20).
// Одно место, где описаны ключи настроек, точность и правила адресов.
// key — стабильный идентификатор направления (используется в настройках и заявках).
const PAIRS = {
  BTC: {
    key: 'BTC',
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
};

const LIST = Object.values(PAIRS);

const norm = (v) => String(v ?? '').trim().toUpperCase();

// Ключ направления из пары «валюта + сеть» (заявки хранят их раздельно).
function keyOf(currency, network) {
  const cur = norm(currency);
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
    rate: rateOf(settings, p.currency, p.network),
    enabled: isEnabled(settings, p.key),
  }));
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
  decimalsOf,
  displayDecimals,
  validateWallet,
};
