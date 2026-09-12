// Автоматическое обновление официального курса BTC/LTC (₽).
// Оператор в админ-панели задаёт только комиссию (наценку в %),
// а курс для клиентов считается как market * (1 + commission/100).
const store = require('./store');

const TIMEOUT = 8000;

const PROVIDERS = [
  {
    name: 'CoinGecko',
    async fetch() {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin&vs_currencies=rub',
        { signal: AbortSignal.timeout(TIMEOUT) }
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const btc = j.bitcoin && j.bitcoin.rub;
      const ltc = j.litecoin && j.litecoin.rub;
      if (!btc || !ltc) throw new Error('нет данных');
      return { btc, ltc };
    },
  },
  {
    name: 'CryptoCompare',
    async fetch() {
      const res = await fetch(
        'https://min-api.cryptocompare.com/data/pricemulti?fsyms=BTC,LTC&tsyms=RUB',
        { signal: AbortSignal.timeout(TIMEOUT) }
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const btc = j.BTC && j.BTC.RUB;
      const ltc = j.LTC && j.LTC.RUB;
      if (!btc || !ltc) throw new Error('нет данных');
      return { btc, ltc };
    },
  },
];

async function refreshRates() {
  for (const provider of PROVIDERS) {
    try {
      const { btc, ltc } = await provider.fetch();
      store.mutate((db) => {
        db.settings.marketBTC = btc;
        db.settings.marketLTC = ltc;
        db.settings.ratesUpdatedAt = Date.now();
      });
      console.log(`[rates] официальный курс обновлён (${provider.name}): BTC ${btc} ₽, LTC ${ltc} ₽`);
      return true;
    } catch (e) {
      console.error(`[rates] ${provider.name}:`, e && e.message);
    }
  }
  return false;
}

function startRatePolling(intervalMs = 60000) {
  const ms = Number.isFinite(intervalMs) && intervalMs >= 15000 ? intervalMs : 60000;
  refreshRates().catch(() => {});
  const timer = setInterval(() => refreshRates().catch(() => {}), ms);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[rates] автопоиск курса каждые ${Math.round(ms / 1000)} с`);
  return timer;
}

module.exports = { refreshRates, startRatePolling };
