const config = require('./src/config');
const store = require('./src/store');
const { startWeb } = require('./src/web');
const { startBot } = require('./src/bot');

console.log('🌌 VEGA | Official — BTC & LTC Exchange');

startWeb();
startBot().catch((e) => {
  console.error('[VEGA] ошибка запуска бота:', e.message);
  console.error('[VEGA] сайт продолжит работать без бота.');
});

process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));
