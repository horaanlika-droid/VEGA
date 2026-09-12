const config = require('./src/config');
const store = require('./src/store');
const { startWeb } = require('./src/web');
const { startBot } = require('./src/bot');
const { startRatePolling } = require('./src/rates');

console.log('🌌 VEGA | Official — BTC & LTC Exchange');
console.log(
  `[VEGA] HTTP ${config.host}:${config.port} ← ${config.portSource}` +
    (process.env.SERVER_PORT ? ` SERVER_PORT=${process.env.SERVER_PORT}` : '') +
    (process.env.PORT ? ` PORT=${process.env.PORT}` : '')
);

if (config.publicUrl && store.get().settings.publicUrl !== config.publicUrl) {
  store.mutate((db) => {
    db.settings.publicUrl = config.publicUrl;
  });
  console.log('[VEGA] PUBLIC_URL из окружения:', config.publicUrl);
}

startWeb();
startBot().catch((e) => {
  console.error('[VEGA] ошибка запуска бота:', e.message);
  console.error('[VEGA] сайт продолжит работать без бота.');
});

// Официальный курс обновляется автоматически; интервал можно задать через RATE_INTERVAL (мс).
startRatePolling(Number(process.env.RATE_INTERVAL) || 60000);

process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));
