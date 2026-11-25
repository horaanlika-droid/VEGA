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
  assert.match(a.document.querySelector('#exOrder').textContent, /Ищем реквизиты/);
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

test('calculator converts both ways and never mentions any fee', async (t) => {
  const done = { ...initial, status: 'completed' };
  const a = await app(t, done);
  const rub = a.document.querySelector('#inRub');
  const crypto = a.document.querySelector('#inCrypto');
  assert.ok(rub && crypto, 'both inputs rendered');
  // Рубли → крипта.
  rub.value = '5000';
  rub.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(crypto.value, '0.0005');
  // Крипта → рубли к оплате (наценка уже внутри курса, видна только итоговая сумма).
  crypto.value = '0.001';
  crypto.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(rub.value, '10000');
  // Смена валюты пересчитывает пассивное поле, активное не трогает.
  a.document.querySelectorAll('#segCur button')[1].click();
  assert.equal(crypto.value, '0.001');
  assert.equal(rub.value, String(Math.ceil(0.001 * settings.rateLTC - 1e-6)));
  assert.match(a.document.querySelector('#cryptoLimits').textContent, /LTC/);
  assert.ok(!/комисси/i.test(a.document.querySelector('#view-exchange').textContent));
});

/* ---------- USDT TRC20 / ERC20 ---------- */

const giftDir = {
  key: 'GOOGLE_USD', direction: 'sell', currency: 'GOOGLE_USD', network: null, kind: 'gift',
  label: 'Google Gift Card', symbol: '🎁', coin: 'google', decimals: 0, display: 0,
  unit: 'USD', step: 10, minUnits: 10,
  walletHint: 'Адрес USDT-кошелька (T… или 0x…)',
  walletPattern: '^(T[1-9A-HJ-NP-Za-km-z]{33}|0x[0-9a-fA-F]{40})$',
  walletError: 'Укажите адрес USDT: TRC20 начинается с T (34 символа), ERC20 — 0x и 40 hex-символов.',
  rate: 86.02, enabled: true,
};

const usdtSettings = {
  ...settings,
  rateUSDTTRC20: 98.75,
  rateUSDTERC20: 101.5,
  rates: [
    { key: 'BTC', currency: 'BTC', network: null, label: 'BTC', symbol: '₿', coin: 'btc', decimals: 8, display: null, walletHint: 'Адрес BTC-кошелька (bc1… / 1… / 3…)', walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$', walletError: 'Проверьте адрес BTC-кошелька — он выглядит некорректно.', rate: settings.rateBTC, enabled: true },
    { key: 'LTC', currency: 'LTC', network: null, label: 'LTC', symbol: 'Ł', coin: 'ltc', decimals: 8, display: null, walletHint: 'Адрес LTC-кошелька', walletPattern: '^(ltc1[a-zA-HJ-NP-Z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$', walletError: 'Проверьте адрес LTC-кошелька — он выглядит некорректно.', rate: settings.rateLTC, enabled: true },
    { key: 'USDT_TRC20', currency: 'USDT', network: 'TRC20', label: 'USDT TRC20', symbol: '₮', coin: 'usdt', decimals: 6, display: 2, walletHint: 'Адрес USDT TRC20 (T…, 34 символа)', walletPattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$', walletError: 'Это не похоже на адрес USDT в сети TRC20 — он начинается с T и содержит 34 символа.', networkHint: 'сеть TRON · низкая комиссия, зачисление 1–3 мин', rate: 98.75, enabled: true },
    { key: 'USDT_ERC20', currency: 'USDT', network: 'ERC20', label: 'USDT ERC20', symbol: '₮', coin: 'usdt', decimals: 6, display: 2, walletHint: 'Адрес USDT ERC20 (0x + 40 символов)', walletPattern: '^0x[0-9a-fA-F]{40}$', walletError: 'Это не похоже на адрес USDT в сети ERC20 — нужен 0x и 40 hex-символов.', networkHint: 'сеть Ethereum · высокая комиссия сети, зачисление 5–15 мин', rate: 101.5, enabled: true },
    giftDir,
  ],
};

// Приложение с настройками, где есть USDT.
async function usdtApp(t, order = initial) {
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
    if (pathname === '/api/init') return json({ settings: usdtSettings, me: { id: 999 }, demo: false });
    if (pathname === '/api/me') return json({ orders: [order], me: { id: 999 } });
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

test('direction segment offers BTC, LTC, USDT TRC20 and USDT ERC20', async (t) => {
  const a = await usdtApp(t);
  const buttons = [...a.document.querySelectorAll('#segCur button')];
  assert.deepEqual(buttons.map((b) => b.dataset.c), ['BTC', 'LTC', 'USDT_TRC20', 'USDT_ERC20']);
  assert.equal(buttons.filter((b) => b.classList.contains('on')).length, 1);
  assert.match(a.document.querySelector('#cryptoLimits').textContent, /BTC/);
});

test('USDT direction converts rub to 2-decimal amount and shows network', async (t) => {
  const a = await usdtApp(t);
  a.document.querySelectorAll('#segCur button')[2].click();
  assert.match(a.document.querySelector('#netPick').textContent, /TRC20/);
  assert.match(a.document.querySelector('#walHint').textContent, /только в сети TRC20/);
  assert.match(a.document.querySelector('#fMeta').textContent, /98[.,]75/);
  assert.match(a.document.querySelector('#inWallet').placeholder, /TRC20/);
  const rub = a.document.querySelector('#inRub');
  rub.value = '10000';
  rub.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  // 10000 / 98.75 = 101.265…, точность USDT — 2 знака (не больше).
  assert.equal(a.document.querySelector('#inCrypto').value, '101.26');
  // Обратный пересчёт тоже опирается на тот же курс.
  const crypto = a.document.querySelector('#inCrypto');
  crypto.value = '50';
  crypto.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(rub.value, String(Math.ceil(50 * 98.75 - 1e-6)));
});

test('USDT order sends network and validates the address per network', async (t) => {
  const a = await usdtApp(t);
  a.document.querySelectorAll('#segCur button')[2].click();
  a.document.querySelector('#inRub').value = '10000';
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
  assert.equal(body.wallet, 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ');
});

test('disabled direction disappears from the segment without breaking the form', async (t) => {
  const a = await usdtApp(t);
  const withoutErc = {
    ...usdtSettings,
    rates: usdtSettings.rates.map((r) => (r.key === 'USDT_ERC20' ? { ...r, enabled: false, rate: null } : r)),
  };
  a.handle((url) => (url === '/api/settings' ? a.json(withoutErc) : null));
  // Опрос настроек обновляет сегмент направлений на месте, без перезагрузки страницы.
  await a.refresh();
  const keys = [...a.document.querySelectorAll('#segCur button')].map((b) => b.dataset.c);
  assert.deepEqual(keys, ['BTC', 'LTC', 'USDT_TRC20']);
});

test('history shows USDT network and 2-decimal payout', async (t) => {
  const usdtOrder = { ...initial, id: 1, currency: 'USDT', network: 'TRC20', crypto: 101.265823, rate: 98.75, status: 'completed' };
  const a = await usdtApp(t, usdtOrder);
  assert.match(a.document.querySelector('#view-history').textContent, /USDT TRC20/);
  assert.match(a.document.querySelector('#view-history').textContent, /101\.27 USDT/);
  assert.match(a.document.querySelector('.h-ic.usdt').textContent, /TRC/);
});

/* ---------- Google Gift Card → USDT ---------- */

test('gift card lives in a separate "sell" mode, not in the buy segment', async (t) => {
  const a = await usdtApp(t);
  const keys = [...a.document.querySelectorAll('#segCur button')].map((b) => b.dataset.c);
  assert.deepEqual(keys, ['BTC', 'LTC', 'USDT_TRC20', 'USDT_ERC20'], 'карта не попадает в сегмент покупки');
  const modes = [...a.document.querySelectorAll('#segMode button')].map((b) => b.dataset.m);
  assert.deepEqual(modes, ['buy', 'sell']);
  assert.ok(a.document.querySelector('#sellForm').classList.contains('hidden'));
  a.document.querySelectorAll('#segMode button')[1].click();
  assert.ok(!a.document.querySelector('#sellForm').classList.contains('hidden'));
  assert.ok(a.document.querySelector('#buyForm').classList.contains('hidden'));
  assert.match(a.document.querySelector('#giftRule').textContent, /кратно \$10/);
});

test('gift nominal is rounded to a multiple of $10 and payout follows the USDT network', async (t) => {
  const a = await usdtApp(t);
  a.document.querySelectorAll('#segMode button')[1].click();
  const units = a.document.querySelector('#inUnits');
  units.value = '37';
  units.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  // 37 → 30; по умолчанию считаем TRC20: 30 × 86.02 / 98.75 = 26.13
  assert.equal(a.document.querySelector('#outUsdt').value, '26.13 USDT');
  // Адрес ERC20 меняет курс выплаты: 30 × 86.02 / 101.5 = 25.42
  const wallet = a.document.querySelector('#inUsdtWallet');
  wallet.value = '0x' + 'a'.repeat(40);
  wallet.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  assert.equal(a.document.querySelector('#outUsdt').value, '25.42 USDT · ERC20');
  // Быстрый номинал подставляет значение.
  a.document.querySelectorAll('#segNom button')[2].click();
  assert.equal(units.value, '50');
  assert.match(a.document.querySelector('#giftMeta').textContent, /\$50/);
});

test('selling a card sends units, code and wallet to the API', async (t) => {
  const a = await usdtApp(t);
  a.document.querySelectorAll('#segMode button')[1].click();
  a.document.querySelector('#inUnits').value = '20';
  a.document.querySelector('#inGiftCode').value = 'ABCD-EFGH-IJKL-MNOP';
  a.document.querySelector('#inUsdtWallet').value = 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ';
  a.handle((url, options) => {
    if (url === '/api/orders') {
      return a.json({ order: { ...initial, id: 5, direction: 'sell', currency: 'GOOGLE_USD', units: 20, network: 'TRC20', giftCode: 'ABCD-EFGH-IJKL-MNOP', crypto: 17.42, status: 'new' } });
    }
    return null;
  });
  a.document.querySelector('#btnSell').click();
  await tick();
  const post = a.calls.find((c) => c.pathname === '/api/orders');
  assert.ok(post, 'запрос на создание заявки ушёл');
  const body = JSON.parse(post.body);
  assert.equal(body.currency, 'GOOGLE_USD');
  assert.equal(body.units, 20);
  assert.equal(body.giftCode, 'ABCD-EFGH-IJKL-MNOP');
  assert.equal(body.wallet, 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ');
  assert.match(a.document.querySelector('#exOrder').textContent, /Проверяем карту/);
});

test('gift form rejects a missing code, a bad wallet and a nominal below $10', async (t) => {
  const a = await usdtApp(t);
  a.document.querySelectorAll('#segMode button')[1].click();
  const units = a.document.querySelector('#inUnits');
  units.value = '5';
  units.dispatchEvent(new a.window.Event('input', { bubbles: true }));
  a.document.querySelector('#btnSell').click();
  await tick();
  assert.match(a.document.querySelector('#giftErr').textContent, /\$10/);
  units.value = '20';
  a.document.querySelector('#btnSell').click();
  await tick();
  assert.match(a.document.querySelector('#giftCodeErr').textContent, /код/i);
  a.document.querySelector('#inGiftCode').value = 'GOOD-CODE-1234';
  a.document.querySelector('#inUsdtWallet').value = 'bc1' + 'a'.repeat(30);
  a.document.querySelector('#btnSell').click();
  await tick();
  assert.match(a.document.querySelector('#giftErr').textContent, /USDT/);
  assert.ok(!a.calls.some((c) => c.pathname === '/api/orders'));
});

test('completed gift order in history shows nominal and USDT payout', async (t) => {
  const giftOrder = {
    ...initial, id: 1, direction: 'sell', currency: 'GOOGLE_USD', units: 50, network: 'TRC20',
    giftCode: 'HIST-CODE-5555', crypto: 43.56, status: 'completed',
  };
  const a = await usdtApp(t, giftOrder);
  const history = a.document.querySelector('#view-history').textContent;
  assert.match(history, /\$50/);
  assert.match(history, /43\.56 USDT/);
  assert.ok(!/₽ → GOOGLE_USD/.test(history), 'в истории нет бессмысленной подписи рубль→карта');
});
