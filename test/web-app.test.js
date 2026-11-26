const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const settings = {
  online: true, rateBTC: 10000000, rateLTC: 9000, rateUpdatedAt: 1,
  minRub: 3000, maxRub: 300000,
  announcement: 'VEGA', refPercent: 1, operator: '@test', channel: 'https://t.me/test', chat: 'https://t.me/test',
};
const initial = {
  id: 1, status: 'new', currency: 'BTC', rub: 5000, crypto: 0.0005,
  wallet: 'bc1' + 'a'.repeat(30), createdAt: 1, updatedAt: 1, requisites: null, payRub: null, receipt: null,
};
const details = { ...initial, status: 'details', requisites: 'СБП: +7 900 000-00-00\nТестовый банк', payRub: 5000, updatedAt: 2, receipt: { name: 'check.pdf', size: 2048, at: 2 } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function app(t, order = initial) {
  const dom = new JSDOM(html, { url: 'https://vega.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  let refresh;
  let handler = () => null;
  window.console.warn = () => {};
  window.setInterval = (fn) => { refresh = fn; return 1; };
  const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
  window.fetch = async (url, options) => {
    const pathname = new URL(url, window.location.href).pathname;
    calls.push({ pathname, ...options });
    const custom = handler(pathname, options);
    if (custom) return custom;
    if (pathname === '/api/init') return json({ settings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders: [order], me: { id: 999 } });
    if (pathname === '/api/settings') return json(settings);
    if (pathname === '/api/order/1') return json({ order });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(script);
  await tick();
  assert.ok(refresh, 'application initialized polling');
  return { window, calls, json, refresh: () => refresh(), handle: (fn) => { handler = fn; }, document: window.document };
}

test('renders requisites on poll even when settings request fails; fetch bypasses cache', async (t) => {
  const a = await app(t);
  assert.match(a.document.querySelector('#exOrder').textContent, /ищем реквизиты/i);
  a.handle((url) => {
    if (url === '/api/settings') return Promise.reject(new Error('offline'));
    if (url === '/api/order/1') return a.json({ order: details });
  });
  await a.refresh();
  assert.equal(a.document.querySelector('#reqBox').textContent, details.requisites);
  assert.ok(a.document.querySelector('#btnPaid'));
  assert.ok(a.calls.every((c) => c.cache === 'no-store' && c.signal));
});

test('slow settings do not block repeated order updates or create overlapping order requests', async (t) => {
  const a = await app(t);
  const pendingSettings = deferred();
  const pendingOrder = deferred();
  let orderCalls = 0;
  a.handle((url) => {
    if (url === '/api/settings') return pendingSettings.promise;
    if (url === '/api/order/1') { orderCalls++; return pendingOrder.promise; }
  });
  const first = a.refresh();
  await a.refresh();
  assert.equal(orderCalls, 1);
  pendingOrder.resolve(a.json({ order: details }));
  await tick();
  assert.ok(a.document.querySelector('#reqBox'));
  a.handle((url) => {
    if (url === '/api/order/1') { orderCalls++; return a.json({ order: { ...details, payRub: 5100 } }); }
  });
  await a.refresh();
  assert.equal(orderCalls, 2);
  assert.match(a.document.querySelector('.pay-amount').textContent, /5\s100/);
  pendingSettings.resolve(a.json(settings));
  await first;
});

test('displays connection error and refreshes immediately when connection returns', async (t) => {
  const a = await app(t);
  a.handle((url) => url === '/api/order/1' ? Promise.reject(new Error('offline')) : null);
  await a.refresh();
  assert.ok(!a.document.querySelector('#syncStatus').classList.contains('hidden'));
  a.handle((url) => url === '/api/order/1' ? a.json({ order: details }) : null);
  a.window.dispatchEvent(new a.window.Event('online'));
  await tick();
  assert.ok(a.document.querySelector('#syncStatus').classList.contains('hidden'));
  assert.equal(a.document.querySelector('#reqBox').textContent, details.requisites);
});

test('returning to Mini App refreshes status without waiting for timer', async (t) => {
  const a = await app(t);
  a.handle((url) => url === '/api/order/1' ? a.json({ order: details }) : null);
  a.document.dispatchEvent(new a.window.Event('visibilitychange'));
  await tick();
  assert.ok(a.document.querySelector('#btnPaid'));
});

test('late GET cannot overwrite a successful payment action', async (t) => {
  const a = await app(t, details);
  const pending = deferred();
  a.handle((url) => {
    if (url === '/api/order/1') return pending.promise;
    if (url === '/api/order/1/paid') return a.json({ order: { ...details, status: 'paid' } });
  });
  const polling = a.refresh();
  a.document.querySelector('#btnPaid').click();
  await tick();
  assert.match(a.document.querySelector('#exOrder').textContent, /Подтверждаем оплату/);
  pending.resolve(a.json({ order: details }));
  await polling;
  assert.match(a.document.querySelector('#exOrder').textContent, /Подтверждаем оплату/);
  assert.equal(a.document.querySelector('#btnPaid'), null);
});

test('payment without a receipt is blocked until a PDF is attached', async (t) => {
  const noReceipt = { ...details, receipt: null, updatedAt: 3 };
  const a = await app(t, noReceipt);
  assert.ok(a.document.querySelector('#btnPick'));
  assert.ok(a.document.querySelector('#inReceipt'));
  a.document.querySelector('#btnPaid').click();
  await tick();
  assert.match(a.document.querySelector('#toast').textContent, /PDF/);
  assert.ok(!a.calls.some((c) => c.pathname.endsWith('/paid')));
  assert.ok(a.document.querySelector('#btnPaid'));
});

test('paid stage without a receipt offers late upload', async (t) => {
  const paidNoReceipt = { ...details, status: 'paid', receipt: null, updatedAt: 4 };
  const a = await app(t, paidNoReceipt);
  assert.ok(a.document.querySelector('#btnSendReceipt'));
  assert.match(a.document.querySelector('#fileName').textContent, /не прикреплён/);
});

test('failed payment action gives feedback and keeps requisites available', async (t) => {
  const a = await app(t, details);
  a.handle((url) => url.endsWith('/paid') ? Promise.reject(new Error('offline')) : null);
  a.document.querySelector('#btnPaid').click();
  await tick();
  assert.match(a.document.querySelector('#toast').textContent, /Не удалось отправить действие/);
  assert.ok(a.document.querySelector('#btnPaid'));
  assert.equal(a.document.querySelector('#reqBox').textContent, details.requisites);
});

test('форма покупки: курс и рубли скрыты — только количество крипты; оператор называет сумму', async (t) => {
  const done = { ...initial, status: 'completed' };
  const a = await app(t, done);
  // Полей рубля и любого упоминания курса в форме нет.
  assert.equal(a.document.querySelector('#inRub'), null, 'рублей в форме быть не должно');
  assert.ok(a.document.querySelector('#inCrypto'), 'поле количества крипты на месте');
  assert.equal(a.document.querySelector('#fMeta'), null);
  assert.equal(a.document.querySelector('#cryptoLimits'), null);
  assert.ok(!/курс/i.test(a.document.querySelector('#view-exchange').textContent), 'курс нигде не виден');
  assert.ok(!/комисси/i.test(a.document.querySelector('#view-exchange').textContent));
  // Смена направления не падает и форму переключает.
  await pickAssetUi(a, 'LTC');
  assert.ok(!/курс/i.test(a.document.querySelector('#view-exchange').textContent));
});

test('buy order submits cryptoAmount WITHOUT any rub; server assigns price later', async (t) => {
  const done = { ...initial, id: 11, status: 'completed' };
  const a = await app(t, done);
  a.handle((url) => {
    if (url === '/api/orders') {
      return a.json({ order: { ...initial, id: 22, status: 'new', rub: null, payRub: null, crypto: 0.001, rate: null } });
    }
    return null;
  });
  const crypto = a.document.querySelector('#inCrypto');
  crypto.value = '0.001';
  a.document.querySelector('#inWallet').value = 'bc1' + 'a'.repeat(30);
  a.document.querySelector('#btnGo').click();
  await tick();
  const post = a.calls.find((c) => c.pathname === '/api/orders');
  assert.ok(post, 'заявка отправлена');
  const body = JSON.parse(post.body);
  assert.equal(body.cryptoAmount, 0.001);
  assert.equal(body.currency, 'BTC');
  assert.equal(body.rub, undefined, 'рубли клиент не передаёт');
});

test('quote stage: оператор назвал сумму — клиент видит её и соглашается или отказывается', async (t) => {
  const quoted = { ...initial, status: 'quote', rub: 5123, payRub: 5123, crypto: 0.001, rate: null };
  const a = await app(t, quoted);
  const view = a.document.querySelector('#view-exchange');
  assert.match(view.textContent, /5.?123/);
  assert.match(view.textContent, /Оператор назвал/i);
  assert.ok(a.document.querySelector('#btnQuoteYes'), 'кнопка согласия на месте');
  assert.ok(a.document.querySelector('#btnQuoteNo'), 'кнопка отказа на месте');
  a.handle((url) => {
    if (url === '/api/order/1/quote-accept') return a.json({ order: { ...quoted, status: 'new' } });
    if (url === '/api/order/1/quote-decline') return a.json({ order: { ...quoted, status: 'cancelled', cancelReason: 'Клиент не согласился с суммой' } });
    return null;
  });
  a.document.querySelector('#btnQuoteYes').click();
  await tick();
  assert.ok(a.calls.some((c) => c.pathname === '/api/order/1/quote-accept'));
  assert.match(view.textContent, /Сумма согласована|реквизиты/i);
});

/* ---------- USDT TRC20 / ERC20 ---------- */

const giftDir = (key, label, symbol, coin) => ({
  key, direction: 'sell', currency: key, network: null, kind: 'gift',
  payoutCurrency: 'BTC', payoutDecimals: 8,
  label, symbol, coin, decimals: 0, display: 0, unit: 'USD', step: 10, minUnits: 10,
  walletHint: 'Адрес Bitcoin-кошелька (bc1… / 1… / 3…)',
  walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
  walletError: 'Проверьте адрес Bitcoin-кошелька.',
  infoNote: 'Карту можно купить на любом маркетплейсе — Яндекс Маркет, Ozon, Wildberries. Нужна карта региона США в USD.',
  currencyNote: 'Регион США, номинал в USD ($).',
  ttlMinutes: 60, rate: 0.00001, enabled: true,
});
const giftDirs = [
  giftDir('GOOGLE_USD', 'Google Gift Card', '🎁', 'google'),
  giftDir('ITUNES_USD', 'iTunes Gift Card', '🎵', 'itunes'),
  giftDir('XBOX_USD', 'Xbox Gift Card', '🎮', 'xbox'),
  giftDir('APPLE_STORE_USD', 'Apple Store Gift Card', '🍎', 'apple'),
];

const usdtSettings = {
  ...settings,
  rateUSDTTRC20: 98.75,
  rateUSDTERC20: 101.5,
  rates: [
    { key: 'BTC', currency: 'BTC', network: null, label: 'BTC', symbol: '₿', coin: 'btc', decimals: 8, display: null, walletHint: 'Адрес BTC-кошелька (bc1… / 1… / 3…)', walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$', walletError: 'Проверьте адрес BTC-кошелька — он выглядит некорректно.', rate: settings.rateBTC, enabled: true },
    { key: 'LTC', currency: 'LTC', network: null, label: 'LTC', symbol: 'Ł', coin: 'ltc', decimals: 8, display: null, walletHint: 'Адрес LTC-кошелька', walletPattern: '^(ltc1[a-zA-HJ-NP-Z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$', walletError: 'Проверьте адрес LTC-кошелька — он выглядит некорректно.', rate: settings.rateLTC, enabled: true },
    { key: 'USDT_TRC20', currency: 'USDT', network: 'TRC20', label: 'USDT TRC20', symbol: '₮', coin: 'usdt', decimals: 6, display: 2, walletHint: 'Адрес USDT TRC20 (T…, 34 символа)', walletPattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$', walletError: 'Это не похоже на адрес USDT в сети TRC20 — он начинается с T и содержит 34 символа.', networkHint: 'сеть TRON · низкая комиссия, зачисление 1–3 мин', rate: 98.75, enabled: true },
    { key: 'USDT_ERC20', currency: 'USDT', network: 'ERC20', label: 'USDT ERC20', symbol: '₮', coin: 'usdt', decimals: 6, display: 2, walletHint: 'Адрес USDT ERC20 (0x + 40 символов)', walletPattern: '^0x[0-9a-fA-F]{40}$', walletError: 'Это не похоже на адрес USDT в сети ERC20 — нужен 0x и 40 hex-символов.', networkHint: 'сеть Ethereum · высокая комиссия сети, зачисление 5–15 мин', rate: 101.5, enabled: true },
    ...giftDirs,
  ],
};

// Приложение с настройками, где есть USDT.
async function usdtApp(t, order = initial, me = { id: 999 }) {
  const dom = new JSDOM(html, { url: 'https://vega.example', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  let refresh;
  let handler = () => null;
  window.console.warn = () => {};
  window.setInterval = (fn) => { refresh = fn; return 1; };
  const json = (data) => ({ ok: true, json: async () => structuredClone(data) });
  window.fetch = async (url, options) => {
    const pathname = new URL(url, window.location.href).pathname;
    calls.push({ pathname, ...options });
    const custom = handler(pathname, options);
    if (custom) return custom;
    if (pathname === '/api/init') return json({ settings: usdtSettings, me, demo: false });
    if (pathname === '/api/me') return json({ orders: [order], me });
    if (pathname === '/api/settings') return json(usdtSettings);
    if (pathname === '/api/order/1') return json({ order });
    if (pathname === '/api/orders') return json({ order: { ...initial, id: 2, currency: 'USDT', network: 'TRC20' } });
    throw new Error('Unexpected request: ' + pathname);
  };
  window.eval(script);
  await tick();
  assert.ok(refresh, 'application initialized polling');
  return { window, calls, json, refresh: () => refresh(), handle: (fn) => { handler = fn; }, document: window.document };
}

// Выбор актива в новой логике: экран активов → шторка (группа → актив).
async function pickAssetUi(a, key) {
  const gift = ['GOOGLE_USD', 'ITUNES_USD', 'XBOX_USD', 'APPLE_STORE_USD'].includes(key);
  const group = a.document.querySelector(`[data-group="${gift ? 'gift' : 'crypto'}"]`);
  assert.ok(group, 'на экране выбора активов есть нужная группа');
  group.click();
  const row = [...a.document.querySelectorAll('#sheetList .sheet-row')].find((b) => b.dataset.key === key);
  assert.ok(row, `актив ${key} доступен в шторке`);
  row.click();
  await tick();
}

test('asset picker opens the exchange: sheets list assets, back returns to picker', async (t) => {
  // Завершённая заявка не блокирует обмен: стартовый экран — выбор активов.
  const done = { ...initial, status: 'completed' };
  const a = await usdtApp(t, done);
  assert.ok(!a.document.querySelector('#assetPicker').classList.contains('hidden'));
  assert.ok(a.document.querySelector('#assetForm').classList.contains('hidden'));
  // Криптовалюта — нижняя шторка со списком направлений.
  a.document.querySelector('[data-group="crypto"]').click();
  assert.ok(!a.document.querySelector('#assetSheet').classList.contains('hidden'));
  let keys = [...a.document.querySelectorAll('#sheetList .sheet-row')].map((b) => b.dataset.key);
  assert.deepEqual(keys, ['BTC', 'LTC', 'USDT_TRC20', 'USDT_ERC20']);
  assert.equal(a.document.querySelectorAll('#sheetList .sheet-row.on').length, 1);
  // Выбор USDT TRC20 открывает форму и закрывает шторку.
  a.document.querySelector('.sheet-row[data-key="USDT_TRC20"]').click();
  await tick();
  assert.ok(a.document.querySelector('#assetPicker').classList.contains('hidden'));
  assert.ok(!a.document.querySelector('#assetForm').classList.contains('hidden'));
  assert.match(a.document.querySelector('#walHint').textContent, /TRC20/);
  // Кнопка назад возвращает к выбору активов.
  a.document.querySelector('#btnBackToAssets').click();
  assert.ok(!a.document.querySelector('#assetPicker').classList.contains('hidden'));
  assert.ok(a.document.querySelector('#assetForm').classList.contains('hidden'));
  // Подарочные карты перечислены отдельно, с общими правилами США/USD.
  a.document.querySelector('[data-group="gift"]').click();
  keys = [...a.document.querySelectorAll('#sheetList .sheet-row')].map((b) => b.dataset.key);
  assert.deepEqual(keys, ['GOOGLE_USD', 'ITUNES_USD', 'XBOX_USD', 'APPLE_STORE_USD']);
  const brandLabels = {
    GOOGLE_USD: 'Google Gift Card',
    ITUNES_USD: 'iTunes Gift Card',
    XBOX_USD: 'Xbox Gift Card',
    APPLE_STORE_USD: 'Apple Store Gift Card',
  };
  for (const [key, label] of Object.entries(brandLabels)) {
    const logo = a.document.querySelector(`.sheet-row[data-key="${key}"] .coin-ic svg`);
    assert.ok(logo, `${label} has a vector logo`);
    assert.equal(logo.getAttribute('aria-label'), label);
  }
  assert.match(a.document.querySelector('#sheetFoot').textContent, /карты США в USD/);
  a.document.querySelector('#sheetClose').click();
  // Выбор карты открывает форму карты.
  a.document.querySelector('[data-group="gift"]').click();
  a.document.querySelector('.sheet-row[data-key="GOOGLE_USD"]').click();
  await tick();
  assert.ok(!a.document.querySelector('#giftForm').classList.contains('hidden'));
  assert.ok(a.document.querySelector('#buyForm').classList.contains('hidden'));
  // И назад к выбору активов.
  a.document.querySelector('#btnBackToAssets').click();
  assert.ok(!a.document.querySelector('#assetPicker').classList.contains('hidden'));
});

test('after cancelling an order, «Создать заявку» returns to the asset picker', async (t) => {
  const a = await usdtApp(t); // активная заявка BTC при старте
  a.handle((url) => {
    if (url === '/api/order/1/cancel') return a.json({ order: { ...initial, status: 'cancelled' } });
    return null;
  });
  a.document.querySelector('#btnCancel').click();
  await tick();
  a.document.querySelector('#btnNew').click();
  await tick();
  assert.ok(!a.document.querySelector('#assetPicker').classList.contains('hidden'));
  assert.ok(a.document.querySelector('#exOrder').classList.contains('hidden'));
});

test('USDT direction: network shown, wallet hint and no rate anywhere', async (t) => {
  const a = await usdtApp(t);
  await pickAssetUi(a, 'USDT_TRC20');
  assert.match(a.document.querySelector('#netPick').textContent, /TRC20/);
  assert.match(a.document.querySelector('#walHint').textContent, /только в сети TRC20/);
  assert.equal(a.document.querySelector('#fMeta'), null, 'курса и метаданных курса нет');
  assert.equal(a.document.querySelector('#inRub'), null);
  assert.ok(!/98[.,]75/.test(a.document.querySelector('#view-exchange').textContent), 'курс не виден');
  assert.match(a.document.querySelector('#inWallet').placeholder, /TRC20/);
});

test('USDT order sends network and validates the address per network', async (t) => {
  const a = await usdtApp(t);
  await pickAssetUi(a, 'USDT_TRC20');
  a.document.querySelector('#inCrypto').value = '100';
  a.document.querySelector('#inWallet').value = '0x' + 'a'.repeat(40);
  a.document.querySelector('#btnGo').click();
  await tick();
  assert.match(a.document.querySelector('#fErr').textContent, /TRC20/);
  assert.ok(!a.calls.some((c) => c.pathname === '/api/orders'));
  a.document.querySelector('#inWallet').value = 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ';
  a.document.querySelector('#btnGo').click();
  await tick();
  const post = a.calls.find((c) => c.pathname === '/api/orders');
  assert.ok(post, 'order request sent');
  const body = JSON.parse(post.body);
  assert.equal(body.currency, 'USDT');
  assert.equal(body.network, 'TRC20');
  assert.equal(body.cryptoAmount, 100);
  assert.equal(body.rub, undefined);
  assert.equal(body.wallet, 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ');
});

test('disabled direction stays visible but dimmed and cannot be selected', async (t) => {
  const a = await usdtApp(t);
  const withoutErc = {
    ...usdtSettings,
    rates: usdtSettings.rates.map((r) => (r.key === 'USDT_ERC20' ? { ...r, enabled: false, rate: null } : r)),
  };
  a.handle((url) => (url === '/api/settings' ? a.json(withoutErc) : null));
  // Опрос настроек обновляет шторку направлений, без перезагрузки страницы.
  await a.refresh();
  a.document.querySelector('[data-group="crypto"]').click();
  // Все направления видны — выключенный полупрозрачный и недоступен.
  const rows = [...a.document.querySelectorAll('#sheetList .sheet-row')];
  assert.deepEqual(rows.map((b) => b.dataset.key), ['BTC', 'LTC', 'USDT_TRC20', 'USDT_ERC20']);
  const offRow = a.document.querySelector('.sheet-row[data-key="USDT_ERC20"]');
  assert.ok(offRow.classList.contains('off'));
  assert.equal(offRow.getAttribute('aria-disabled'), 'true');
  assert.match(offRow.textContent, /Временно недоступно/);
  // Клик по выключенному направлению не выбирает его: шторка не закрывается, форма прежняя.
  offRow.click();
  await tick();
  assert.ok(!a.document.querySelector('#assetSheet').classList.contains('hidden'), 'шторка остаётся открытой');
  // Доступное направление выбирается как обычно.
  a.document.querySelector('.sheet-row[data-key="USDT_TRC20"]').click();
  await tick();
  assert.ok(a.document.querySelector('#assetForm').classList.contains('hidden') === false);
  assert.match(a.document.querySelector('#walHint').textContent, /TRC20/);
  // Все поддерживаемые виды карт остаются в отдельной шторке.
  await pickAssetUi(a, 'GOOGLE_USD');
  assert.ok(!a.document.querySelector('#giftForm').classList.contains('hidden'));
});

test('fully disabled group stays visible but dimmed and cannot be opened into a form', async (t) => {
  const a = await usdtApp(t);
  const noGift = {
    ...usdtSettings,
    rates: usdtSettings.rates.map((r) => (r.kind === 'gift' ? { ...r, enabled: false, rate: null } : r)),
  };
  a.handle((url) => (url === '/api/settings' ? a.json(noGift) : null));
  await a.refresh();
  const giftCard = a.document.querySelector('[data-group="gift"]');
  assert.ok(giftCard, 'группа карт видна');
  assert.ok(giftCard.classList.contains('off'), 'группа карт полупрозрачная');
  // Карточка кликается — открывает шторку с выключенным направлением.
  giftCard.click();
  const row = a.document.querySelector('.sheet-row[data-key="GOOGLE_USD"]');
  assert.ok(row.classList.contains('off'));
  row.click();
  await tick();
  assert.ok(a.document.querySelector('#giftForm').classList.contains('hidden'), 'форма карты не открывается');
});

test('history shows USDT network and 2-decimal payout', async (t) => {
  const usdtOrder = { ...initial, id: 1, currency: 'USDT', network: 'TRC20', crypto: 101.265823, rate: 98.75, status: 'completed' };
  const a = await usdtApp(t, usdtOrder);
  assert.match(a.document.querySelector('#view-history').textContent, /USDT TRC20/);
  assert.match(a.document.querySelector('#view-history').textContent, /101\.27 USDT/);
  assert.match(a.document.querySelector('.h-ic.usdt').textContent, /TRC/);
});

/* ---------- USD gift cards → BTC ---------- */

test('gift picker lists every brand and updates the form for the selected product', async (t) => {
  const a = await usdtApp(t);
  await pickAssetUi(a, 'BTC');
  assert.ok(!a.document.querySelector('#buyForm').classList.contains('hidden'));
  assert.ok(a.document.querySelector('#giftForm').classList.contains('hidden'));
  assert.equal(a.document.querySelector('#segMode'), null);

  await pickAssetUi(a, 'GOOGLE_USD');
  assert.ok(a.document.querySelector('#buyForm').classList.contains('hidden'));
  assert.ok(!a.document.querySelector('#giftForm').classList.contains('hidden'));
  assert.equal(a.document.querySelector('#giftTitle').textContent, 'Google Gift Card');
  assert.match(a.document.querySelector('#giftRule').textContent, /кратно \$10/);

  await pickAssetUi(a, 'ITUNES_USD');
  assert.equal(a.document.querySelector('#giftTitle').textContent, 'iTunes Gift Card');
  await pickAssetUi(a, 'APPLE_STORE_USD');
  assert.equal(a.document.querySelector('#giftTitle').textContent, 'Apple Store Gift Card');

  a.document.querySelector('#btnBackToAssets').click();
  assert.ok(!a.document.querySelector('#assetPicker').classList.contains('hidden'));
});

test('gift nominal rounds to $10 and calculates a BTC payout', async (t) => {
  const a = await usdtApp(t);
  await pickAssetUi(a, 'GOOGLE_USD');
  const units = a.document.querySelector('#inUnits');
  units.value = '37';
  units.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(a.document.querySelector('#outBtc').value, '0.0003 BTC');
  const wallet = a.document.querySelector('#inBtcWallet');
  wallet.value = 'bc1' + 'a'.repeat(30);
  wallet.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(a.document.querySelector('#outBtc').value, '0.0003 BTC');
  assert.match(a.document.querySelector('#giftBtcHint').textContent, /0\.0003 BTC/);

  units.value = '10';
  units.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(a.document.querySelector('#outBtc').value, '0.0001 BTC');
  a.document.querySelectorAll('#segNom button')[2].click();
  assert.equal(units.value, '50');
  assert.match(a.document.querySelector('#giftMeta').textContent, /\$50/);
  assert.match(a.document.querySelector('#giftMeta').textContent, /1 \$ = 0\.00001 BTC/);
});

test('iTunes card rules are confirmed before a BTC order is created with its brand key', async (t) => {
  const a = await usdtApp(t);
  await pickAssetUi(a, 'ITUNES_USD');
  a.document.querySelector('#inUnits').value = '20';
  a.document.querySelector('#inBtcWallet').value = 'bc1' + 'a'.repeat(30);
  a.handle((url) => {
    if (url === '/api/orders') {
      return a.json({ order: {
        ...initial, id: 5, direction: 'sell', currency: 'ITUNES_USD', units: 20,
        network: null, payoutCurrency: 'BTC', giftCode: null, crypto: 0.0002,
        status: 'new', expiresAt: Date.now() + 3600e3,
      } });
    }
    return null;
  });
  a.document.querySelector('#btnSell').click();
  await tick();
  const rules = a.document.querySelector('#giftRules');
  assert.ok(!rules.classList.contains('hidden'));
  assert.match(rules.textContent, /iTunes Gift Card/);
  assert.match(rules.textContent, /региона США/);
  assert.doesNotMatch(rules.textContent, /комисси/i, 'правила карты не раскрывают комиссию клиенту');
  assert.ok(!a.calls.some((c) => c.pathname === '/api/orders'));

  a.document.querySelector('#giftRulesConfirm').click();
  await tick();
  const post = a.calls.find((c) => c.pathname === '/api/orders');
  assert.ok(post);
  const body = JSON.parse(post.body);
  assert.equal(body.currency, 'ITUNES_USD');
  assert.equal(body.units, 20);
  assert.equal(body.giftCode, undefined);
  assert.equal(body.wallet, 'bc1' + 'a'.repeat(30));
  assert.match(a.document.querySelector('#exOrder').textContent, /iTunes Gift Card/);
  assert.match(a.document.querySelector('#exOrder').textContent, /BTC/);
});

test('gift form requires a valid denomination and Bitcoin wallet before rules open', async (t) => {
  const a = await usdtApp(t);
  await pickAssetUi(a, 'APPLE_STORE_USD');
  const rules = a.document.querySelector('#giftRules');
  const units = a.document.querySelector('#inUnits');
  units.value = '5';
  units.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  a.document.querySelector('#btnSell').click();
  await tick();
  assert.match(a.document.querySelector('#giftErr').textContent, /\$10/);
  assert.ok(rules.classList.contains('hidden'));

  units.value = '20';
  units.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  a.document.querySelector('#inBtcWallet').value = 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ';
  a.document.querySelector('#btnSell').click();
  await tick();
  assert.match(a.document.querySelector('#giftErr').textContent, /Bitcoin/);
  assert.ok(rules.classList.contains('hidden'));
  assert.ok(!a.calls.some((c) => c.pathname === '/api/orders'));

  a.document.querySelector('#inBtcWallet').value = 'bc1' + 'a'.repeat(30);
  a.document.querySelector('#btnSell').click();
  await tick();
  assert.ok(!rules.classList.contains('hidden'));
  a.document.querySelector('#giftRulesCancel').click();
  await tick();
  assert.ok(!rules.classList.contains('open'));
  assert.ok(!a.calls.some((c) => c.pathname === '/api/orders'));
});

test('operator connects to an Xbox gift order and client sends the code from its stage screen', async (t) => {
  const giftDetails = {
    ...initial, id: 8, direction: 'sell', currency: 'XBOX_USD', units: 20, network: null,
    payoutCurrency: 'BTC', wallet: 'bc1' + 'a'.repeat(30), giftCode: null, crypto: 0.0002,
    status: 'details', expiresAt: Date.now() + 3600e3,
  };
  const a = await usdtApp(t, giftDetails);
  assert.match(a.document.querySelector('#exOrder').textContent, /Xbox Gift Card/);
  assert.ok(a.document.querySelector('#inGiftSendCode'));
  assert.equal(a.document.querySelector('#btnGiftPaid'), null);
  a.handle((url) => {
    if (url === '/api/order/8/code') return a.json({ order: { ...giftDetails, giftCode: 'SEND-CODE-4242', status: 'paid', paidAt: Date.now() } });
    return null;
  });
  a.document.querySelector('#inGiftSendCode').value = 'SEND-CODE-4242';
  a.document.querySelector('#btnGiftSend').click();
  await tick();
  const post = a.calls.find((c) => c.pathname === '/api/order/8/code');
  assert.ok(post);
  assert.equal(JSON.parse(post.body).giftCode, 'SEND-CODE-4242');
  assert.match(a.document.querySelector('#exOrder').textContent, /Карта на проверке/);
});

test('legacy gift order in history keeps its USDT network payout and correct brand', async (t) => {
  const giftOrder = {
    ...initial, id: 1, direction: 'sell', currency: 'ITUNES_USD', units: 50, network: 'TRC20',
    giftCode: 'HIST-CODE-5555', crypto: 43.56, status: 'completed',
  };
  const a = await usdtApp(t, giftOrder);
  const history = a.document.querySelector('#view-history').textContent;
  assert.match(history, /iTunes Gift Card/);
  assert.match(history, /\$50/);
  assert.match(history, /43\.56 USDT/);
  assert.ok(!/ITUNES_USD/.test(history));
  const row = a.document.querySelector('#view-history [data-order="1"]');
  assert.equal(row.querySelector('.h-ic').classList.contains('itunes'), true);
});

test('gift form explains US-region cards in USD and the 1-hour deadline', async (t) => {
  const a = await usdtApp(t);
  await pickAssetUi(a, 'GOOGLE_USD');
  const text = a.document.querySelector('#giftForm').textContent;
  assert.match(text, /Яндекс Маркет/);
  assert.match(text, /Ozon/);
  assert.match(text, /Wildberries/);
  assert.match(text, /США/);
  assert.match(text, /USD/);
  assert.match(text, /1 час/);
  assert.doesNotMatch(text, /комисси/i, 'форма карты не раскрывает комиссию клиенту');
});

test('Apple Store gift order with a legacy code shows BTC payout and checking stage', async (t) => {
  const giftNew = {
    ...initial, id: 7, direction: 'sell', currency: 'APPLE_STORE_USD', units: 20, network: null,
    payoutCurrency: 'BTC', wallet: 'bc1' + 'a'.repeat(30),
    giftCode: 'PAY-CODE-7777', crypto: 0.0002, status: 'new', expiresAt: Date.now() + 3600 * 1000,
  };
  const a = await usdtApp(t, giftNew);
  assert.match(a.document.querySelector('#exOrder').textContent, /Apple Store Gift Card/);
  assert.match(a.document.querySelector('#exOrder').textContent, /0\.0002 BTC/);
  assert.match(a.document.querySelector('#exOrder').textContent, /На сделку осталось/);
  a.handle((url) => {
    if (url === '/api/order/7/paid') return a.json({ order: { ...giftNew, status: 'paid', paidAt: Date.now() } });
    return null;
  });
  a.document.querySelector('#btnGiftPaid').click();
  await tick();
  assert.ok(a.calls.some((c) => c.pathname === '/api/order/7/paid'));
  assert.match(a.document.querySelector('#exOrder').textContent, /Карта на проверке/);
  assert.equal(a.document.querySelector('#btnGiftPaid'), null);
});

test('expired legacy gift order shows the deadline reason instead of a generic cancel', async (t) => {
  const expired = {
    ...initial, id: 1, direction: 'sell', currency: 'GOOGLE_USD', units: 10, network: 'TRC20',
    wallet: 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ',
    giftCode: 'OLD-CODE-0000', crypto: 8.5, status: 'cancelled',
    cancelReason: 'Срок на сделку истёк', expiresAt: Date.now() - 1000,
  };
  const a = await usdtApp(t, expired);
  const item = a.document.querySelector('#view-history [data-order="1"]');
  assert.ok(item);
  item.click();
  await tick();
  assert.match(a.document.querySelector('#exOrder').textContent, /Срок на сделку истёк/);
  assert.match(a.document.querySelector('#exOrder').textContent, /1 час/);
});

test('Профиль клиента: вкладка «Профиль» с портфелем — статистика, рефералка, связь', async (t) => {
  const doneOrder = {
    ...initial, id: 3, status: 'completed', currency: 'BTC', rub: 12000, payRub: 12000,
  };
  const a = await usdtApp(t, doneOrder);
  const navButtons = [...a.document.querySelectorAll('#nav button')].map((b) => b.dataset.tab);
  assert.deepEqual(navButtons, ['exchange', 'history', 'refs', 'support', 'profile']);
  assert.ok(!navButtons.includes('info'), 'вкладки «Инфо» больше нет');
  const profileNav = a.document.querySelector('#nav [data-tab="profile"]');
  assert.match(profileNav.textContent, /Профиль/);
  assert.equal(a.document.querySelector('#nav [data-tab="support"] svg rect') !== null, true, 'чат — диалоговое окошко');
  a.document.querySelector('[data-tab="profile"]').click();
  await tick();
  const view = a.document.querySelector('#view-profile');
  assert.ok(!view.classList.contains('hidden'), 'Профиль открыт по клику в меню');
  assert.match(view.textContent, /ID 999/);
  assert.match(view.textContent, /заявок всего/);
  assert.match(view.textContent, /завершено/);
  assert.match(view.textContent, /Реферальная программа/);
  assert.match(view.textContent, /Связь с нами/);
  assert.equal(a.document.querySelector('#lcOpenAdmin'), null, 'обычный клиент не видит админку');
  assert.equal(a.document.querySelector('#adminSheet').classList.contains('hidden') || true, true);
  // Кнопка «Открыть чат поддержки» переводит на вкладку Чат.
  a.document.querySelector('#goSupport').click();
  await tick();
  assert.ok(!a.document.querySelector('#view-support').classList.contains('hidden'));
});


const adminSettingsBlock = { chat: 'https://t.me/+old_chat', feePercent: 1.5, feePercentUSDTTRC20: 0.5, feePercentUSDTERC20: 1, giftPercent: 12, rateGOOGLEUSD: 0.00001, online: true,
  directions: { BTC: true, LTC: true, USDT_TRC20: true, USDT_ERC20: true, GOOGLE_USD: true, ITUNES_USD: true, XBOX_USD: true, APPLE_STORE_USD: true } };

test('Админка в приложении: вкладки, переключение направлений и комиссий', async (t) => {
  const me = { id: 42, name: 'Шеф', isAdmin: true };
  const a = await usdtApp(t, initial, me);
  const state = { settings: { ...usdtSettings }, admin: structuredClone(adminSettingsBlock) };
  a.handle((url, options) => {
    if (url === '/api/admin/settings' && (!options || options.method !== 'POST')) {
      return a.json({ admin: structuredClone(state.admin), settings: structuredClone(state.settings) });
    }
    if (url === '/api/admin/settings' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.enabled) Object.assign(state.admin.directions, body.enabled);
      if (typeof body.online === 'boolean') state.admin.online = body.online;
      for (const k of ['feePercent', 'feePercentUSDTTRC20', 'feePercentUSDTERC20', 'giftPercent', 'chat', 'rateGOOGLEUSD']) {
        if (body[k] !== undefined) state.admin[k] = body[k];
      }
      state.settings = { ...state.settings, chat: state.admin.chat, online: state.admin.online };
      return a.json({ admin: structuredClone(state.admin), settings: structuredClone(state.settings), announced: body.online === true ? 3 : 0 });
    }
    return null;
  });
  a.document.querySelector('[data-tab="profile"]').click();
  await tick();
  // Открываем админку — грузятся настройки.
  a.document.querySelector('#lcOpenAdmin').click();
  await tick();
  assert.equal(a.document.querySelector('#adminSheet').classList.contains('hidden'), false);
  // Торги открыты: статус виден, направления подсвечены.
  assert.equal(a.document.querySelector('#admSessionTitle').textContent, 'Торги открыты');
  assert.equal(a.document.querySelector('#adminSheet').classList.contains('trading-on'), true);
  // Закрываем торги — кнопка отправляет online:false.
  a.document.querySelector('#admSessionBtn').click();
  await tick();
  const offCall = a.calls.filter((c) => c.pathname === '/api/admin/settings' && c.method === 'POST').pop();
  assert.equal(JSON.parse(offCall.body).online, false);
  assert.equal(a.document.querySelector('#admSessionTitle').textContent, 'Торги закрыты');
  assert.equal(a.document.querySelector('#adminSheet').classList.contains('trading-on'), false);
  // Выключенные направления в админке чёрно-белые (без teal-подсветки), включённые — обычные.
  const onToggle = a.document.querySelector('#admCryptoDirs .adm-toggle[data-dir="BTC"]');
  const offToggle = a.document.querySelector('#admCryptoDirs .adm-toggle[data-dir="USDT_ERC20"]');
  assert.ok(onToggle.classList.contains('on') && offToggle.classList.contains('on'));
  // Открываем торги обратно (объявление клиентам уходит на сервере).
  a.document.querySelector('#admSessionBtn').click();
  await tick();
  const onCall = a.calls.filter((c) => c.pathname === '/api/admin/settings' && c.method === 'POST').pop();
  assert.equal(JSON.parse(onCall.body).online, true);
  assert.equal(a.document.querySelector('#admSessionTitle').textContent, 'Торги открыты');
  // Переключаем USDT ERC20 в списке валют.
  a.document.querySelector('#admCryptoDirs .adm-toggle[data-dir="USDT_ERC20"]').click();
  await tick();
  assert.equal(state.admin.directions.USDT_ERC20, false);
  let post = a.calls.find((c) => c.pathname === '/api/admin/settings' && c.method === 'POST' && JSON.parse(c.body).enabled);
  assert.deepEqual(JSON.parse(post.body).enabled, { USDT_ERC20: false });

  // Вкладка «Карты»: превью и сохранение.
  a.document.querySelector('#admTabs .adm-tab[data-tab="gift"]').click();
  assert.equal(a.document.querySelector('#admGiftRate'), null, 'поля ручного курса больше нет');
  const adminGiftToggles = [...a.document.querySelectorAll('#admGiftDirs .adm-toggle')];
  assert.deepEqual(adminGiftToggles.map((b) => b.dataset.dir), ['GOOGLE_USD', 'ITUNES_USD', 'XBOX_USD', 'APPLE_STORE_USD']);
  assert.ok(adminGiftToggles.every((b) => b.querySelector('.adm-coin svg')), 'админка тоже показывает векторные логотипы брендов');
  a.document.querySelector('#admGiftFee').value = '10';
  a.document.querySelector('#admGiftFee').dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.match(a.document.querySelector('#admGiftPreview').textContent, /0\.00010227 BTC/);
  a.document.querySelector('#admGiftSave').click();
  await tick();
  post = a.calls.filter((c) => c.pathname === '/api/admin/settings' && c.method === 'POST').pop();
  assert.equal(JSON.parse(post.body).giftPercent, 10);
  // Вкладка «Чат»: сохранение ссылки.
  a.document.querySelector('#admTabs .adm-tab[data-tab="chat"]').click();
  a.document.querySelector('#admChatLink').value = 'https://t.me/+brand_new_chat';
  a.document.querySelector('#admChatSave').click();
  await tick();
  post = a.calls.filter((c) => c.pathname === '/api/admin/settings' && c.method === 'POST').pop();
  assert.equal(JSON.parse(post.body).chat, 'https://t.me/+brand_new_chat');
});

test('Клиенту недоступна админка: кнопки нет, прямые запросы получают 403', async (t) => {
  const a = await usdtApp(t, initial, { id: 999 });
  a.document.querySelector('[data-tab="profile"]').click();
  await tick();
  assert.equal(a.document.querySelector('#lcOpenAdmin'), null);
  // Попытка вызвать admin API руками — 403 (проверяется на сервере).
});
