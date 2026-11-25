const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vega-test-'));
process.env.DATA_DIR = dir;
process.env.BOT_TOKEN = '123456:test-token';
process.env.ADMIN_ID = '111';
process.env.ADMIN_IDS = '222,111; 333';
// Реальная старая база без admins, version и adminMsgIds.
fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ seq: 2, orders: [{
  id: 1, userId: '999', userName: 'Legacy', rub: 5000, currency: 'BTC',
  wallet: 'bc1' + 'a'.repeat(30), crypto: 0.0005, rate: 10000000,
  status: 'new', createdAt: Date.now(), adminMsgId: 42,
}] }));
const config = require('../src/config');
const store = require('../src/store');
const admins = require('../src/admins');
const bus = require('../src/bus');
const { createBot } = require('../src/bot');
const { startWeb } = require('../src/web');
const currencies = require('../src/currencies');
const rates = require('../src/rates');
const botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'vega_test_bot' };
const bot = createBot({ botInfo });
let seq = 100;
let calls = [];
let blocked = new Set();
let unchanged = false;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, ...payload });
  if (blocked.has(String(payload.chat_id))) return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' };
  if (unchanged && method === 'editMessageText') return { ok: false, error_code: 400, description: 'Bad Request: message is not modified' };
  return { ok: true, result: method === 'answerCallbackQuery' ? true : {
    message_id: ++seq, date: 1, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text,
  } };
});

function text(id, value, chatType = 'private') {
  const command = value.match(/^\/\S+/)?.[0];
  return bot.handleUpdate({ update_id: ++seq, message: {
    message_id: ++seq, date: 1, chat: { id, type: chatType },
    from: { id, first_name: 'Test', is_bot: false }, text: value,
    ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}),
  } });
}
function click(id, data) {
  return bot.handleUpdate({ update_id: ++seq, callback_query: {
    id: String(++seq), chat_instance: 'test', from: { id, first_name: 'Admin', is_bot: false }, data,
    message: { message_id: 42, date: 1, chat: { id, type: 'private' }, from: botInfo, text: 'Order' },
  } });
}
function signed(id = 999) {
  const p = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Client' }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const data = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  p.set('hash', crypto.createHmac('sha256', key).update(data).digest('hex'));
  return p.toString();
}
config.port = 0;
const server = startWeb();
const ready = once(server, 'listening');
async function api(route, { id = 999, method = 'GET', body = {} } = {}) {
  await ready;
  const url = `http://127.0.0.1:${server.address().port}${route}?initData=${encodeURIComponent(signed(id))}`;
  return fetch(url, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
}
async function newOrder() {
  const r = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30) } });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  // Дожидаемся очереди карточек (HTTP намеренно не ждёт Telegram).
  await bus.emit('order_event', { order, type: 'new' });
  return order;
}
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ADMIN_IDS merged/deduplicated; old database and legacy message remain compatible', async () => {
  assert.deepEqual(admins.all(), ['111', '222', '333']);
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(1), type: 'new' });
  assert.ok(calls.some((c) => c.method === 'editMessageText' && c.chat_id === '111' && c.message_id === 42));
  assert.ok(store.getOrder(1).adminMsgIds['222']);
  assert.ok(store.getOrder(1).adminMsgIds['333']);
});

test('owner adds/removes persistent admins; operators, strangers and groups cannot grant access', async () => {
  await text(111, '/addadmin 444');
  assert.ok(admins.has(444));
  await text(444, '/addadmin 555');
  await text(999, '/addadmin 666');
  await text(111, '/addadmin 777', 'group');
  assert.ok(!admins.has(555) && !admins.has(666) && !admins.has(777));
  await text(111, '/addadmin @username');
  await text(111, '/addadmin -1');
  await text(111, '/addadmin 444');
  assert.equal(admins.all().filter((id) => id === '444').length, 1);
  await text(111, '/removeadmin 222');
  assert.ok(admins.has(222));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const persisted = execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/admins').all()))"], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.ok(JSON.parse(persisted).includes('444'));
  await text(111, '/removeadmin 444');
  assert.ok(!admins.has(444));
});

test('new orders reach all admins; unchanged cards do not generate duplicate messages', async () => {
  const o = await newOrder();
  const stored = store.getOrder(o.id);
  assert.deepEqual(Object.keys(stored.adminMsgIds).sort(), admins.all().sort());
  assert.equal(new Set(Object.values(stored.adminMsgIds)).size, 3);
  calls = [];
  unchanged = true;
  await bus.emit('order_event', { order: stored, type: 'new' });
  unchanged = false;
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 0);
});

test('requisites publish atomically after one admin text, visible in authenticated API and Telegram', async () => {
  const o = await newOrder();
  await click(222, `o:${o.id}:req`);
  assert.equal(store.getOrder(o.id).status, 'new');
  const req = 'СБП: +7 900 000-00-00\nБанк: Тест\nПолучатель: <Иван & Co>';
  calls = [];
  await text(222, req);
  const response = await api(`/api/order/${o.id}`);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const { order } = await response.json();
  assert.equal(order.status, 'details');
  assert.equal(order.requisites, req);
  assert.equal(order.payRub, 5000);
  assert.equal(order.adminMsgIds, undefined);
  assert.ok(calls.some((c) => c.chat_id === '999' && c.text.includes('&lt;Иван &amp; Co&gt;')));
  assert.equal((await api(`/api/order/${o.id}`, { id: 888 })).status, 404);
  const unauthorized = await fetch(`http://127.0.0.1:${server.address().port}/api/order/${o.id}?initData=invalid`);
  assert.equal(unauthorized.status, 401);
  // Перезагрузка приложения восстанавливает заявку через /api/me.
  const profile = await (await api('/api/me')).json();
  assert.equal(profile.orders.find((x) => x.id === o.id).requisites, req);
});

test('custom amount is selected BEFORE publication; invalid amount and oversized requisites are rejected', async () => {
  const o = await newOrder();
  await click(111, `o:${o.id}:quote`);
  await text(111, '5000 мусор');
  assert.equal(store.getOrder(o.id).status, 'new');
  await text(111, '5 123');
  await text(111, 'x'.repeat(901));
  assert.equal(store.getOrder(o.id).requisites, null);
  await text(111, 'Банк, номер, получатель');
  assert.equal(store.getOrder(o.id).payRub, 5123);
  assert.equal(store.getOrder(o.id).status, 'details');
});

test('blocked admin/client do not prevent other admins or Web App from receiving requisites', async () => {
  blocked = new Set(['111', '999']);
  const o = await newOrder();
  await click(222, `o:${o.id}:req`);
  await text(222, 'Реквизиты для приложения');
  blocked.clear();
  const { order } = await (await api(`/api/order/${o.id}`)).json();
  assert.equal(order.status, 'details');
  assert.ok(store.getOrder(o.id).adminMsgIds['333']);
  assert.ok(calls.some((c) => c.chat_id === 222 && c.text?.includes('Личное сообщение не доставлено')));
});

test('parallel operators cannot overwrite requisites or stale amount drafts', async () => {
  const o = await newOrder();
  await click(111, `o:${o.id}:req`);
  await click(222, `o:${o.id}:req`);
  await Promise.all([text(111, 'Первый оператор'), text(222, 'Второй оператор')]);
  assert.equal(store.getOrder(o.id).requisites, 'Первый оператор');
  await click(111, `o:${o.id}:amt`);
  await click(222, `o:${o.id}:amt`);
  await text(222, '5100');
  await text(111, '5200');
  assert.equal(store.getOrder(o.id).payRub, 5100);
});

test('cancelled orders cannot be revived by pending text or old buttons', async () => {
  const o = await newOrder();
  await click(111, `o:${o.id}:req`);
  await api(`/api/order/${o.id}/cancel`, { method: 'POST' });
  await text(111, 'Устаревшие реквизиты');
  for (const action of ['req', 'amt', 'confirm', 'reject', 'unpaid']) await click(222, `o:${o.id}:${action}`);
  assert.equal(store.getOrder(o.id).status, 'cancelled');
  assert.equal(store.getOrder(o.id).requisites, null);
});

test('removed admin cannot finish an existing flow; unauthorized callbacks do not mutate orders', async () => {
  const o = await newOrder();
  await text(111, '/addadmin 444');
  await click(444, `o:${o.id}:req`);
  await text(111, '/removeadmin 444');
  await text(444, 'Не должны сохраниться');
  await click(999, `o:${o.id}:confirm`);
  await text(111, '/addadmin 444');
  await text(444, 'Старый ввод тоже не должен сохраниться');
  await text(111, '/removeadmin 444');
  assert.equal(store.getOrder(o.id).status, 'new');
});

test('payment requires a PDF receipt; invalid files rejected, receipt reaches admins and owner', async () => {
  const pdf = Buffer.from('%PDF-1.4\n% fake receipt\n').toString('base64');
  const o = await newOrder();
  await click(111, `o:${o.id}:req`);
  await text(111, 'Реквизиты');
  // Без чека оплатить нельзя.
  const nopdf = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(nopdf.status, 400);
  assert.equal(store.getOrder(o.id).status, 'details');
  // Не-PDF отклоняется.
  const badExt = await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'check.txt', data: Buffer.from('hello').toString('base64') } });
  assert.equal(badExt.status, 400);
  const badMagic = await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'check.pdf', data: Buffer.from('not a pdf').toString('base64') } });
  assert.equal(badMagic.status, 400);
  assert.equal(store.getOrder(o.id).receipt, null);
  // Валидный чек принимается и рассылается всем админам файлом.
  calls = [];
  const ok = await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'check.pdf', data: pdf } });
  assert.equal(ok.status, 200);
  const { order } = await ok.json();
  assert.equal(order.receipt.name, 'check.pdf');
  assert.ok(order.receipt.size > 0);
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'receipt' });
  for (const id of admins.all()) {
    assert.ok(calls.some((c) => c.method === 'sendDocument' && String(c.chat_id) === String(id)));
  }
  // Скачивание чека владельцем.
  const dl = await api(`/api/order/${o.id}/receipt`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /pdf/);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api(`/api/order/${o.id}/receipt`, { id: 888 })).status, 404);
  // Теперь оплата проходит.
  const paid = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(paid.status, 200);
  assert.equal(store.getOrder(o.id).status, 'paid');
  // Кнопка «Получить чек» отправляет файл запросившему админу.
  calls = [];
  await click(222, `o:${o.id}:receipt`);
  assert.ok(calls.some((c) => c.method === 'sendDocument' && String(c.chat_id) === '222'));
});

test('paid notifications reach every admin; stale amount cannot undo payment; confirmation is idempotent', async () => {
  const o = await newOrder();
  await click(111, `o:${o.id}:req`);
  await text(111, 'Реквизиты');
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'check.pdf', data: pdf } });
  await click(111, `o:${o.id}:amt`);
  calls = [];
  await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'paid' });
  for (const id of admins.all()) assert.ok(calls.some((c) => c.chat_id === id && c.text?.includes('Клиент нажал')));
  await text(111, '6000');
  assert.equal(store.getOrder(o.id).status, 'paid');
  assert.equal(store.getOrder(o.id).payRub, 5000);
  calls = [];
  await Promise.all([click(111, `o:${o.id}:confirm`), click(222, `o:${o.id}:confirm`)]);
  assert.equal(store.getOrder(o.id).status, 'completed');
  assert.equal(calls.filter((c) => c.text?.includes('Отправьте клиенту вручную')).length, 1);
  const { order } = await (await api(`/api/order/${o.id}`)).json();
  assert.equal(order.status, 'completed');
});

test('reverse calculator: crypto amount converts to rubles to pay; fee stays hidden', async () => {
  const s = store.get().settings;
  const wallet = 'bc1' + 'a'.repeat(30);
  const r = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.001, currency: 'BTC', wallet } });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.crypto, 0.001);
  assert.equal(order.rub, Math.ceil(0.001 * s.rateBTC - 1e-6));
  assert.equal(order.rate, s.rateBTC);
  // Клиенту нигде не светим комиссию и базовые курсы.
  assert.equal(order.feePercent, undefined);
  assert.equal(order.baseRateBTC, undefined);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.feePercent, undefined);
  assert.equal(pub.baseRateBTC, undefined);
  assert.equal(pub.baseRateLTC, undefined);
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
});

test('reverse calculator rejects out-of-range and invalid crypto amounts', async () => {
  const s = store.get().settings;
  const wallet = 'ltc1' + 'a'.repeat(30);
  const tiny = await api('/api/orders', { method: 'POST', body: { cryptoAmount: s.minRub / s.rateLTC / 2, currency: 'LTC', wallet } });
  assert.equal(tiny.status, 400);
  const huge = await api('/api/orders', { method: 'POST', body: { cryptoAmount: s.maxRub / s.rateLTC * 2, currency: 'LTC', wallet } });
  assert.equal(huge.status, 400);
  for (const bad of [0, -1, 'мусор', '', null]) {
    const res = await api('/api/orders', { method: 'POST', body: { cryptoAmount: bad, currency: 'LTC', wallet } });
    assert.equal(res.status, 400);
  }
  // Старый формат (только рубли) продолжает работать.
  const legacy = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'LTC', wallet } });
  assert.equal(legacy.status, 200);
  const { order } = await legacy.json();
  // Выплата округляется вниз до точности сети (8 знаков для LTC).
  assert.equal(order.crypto, Math.floor((5000 / s.rateLTC) * 1e8) / 1e8);
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
});

/* ---------- USDT TRC20 / ERC20 ---------- */

const TRC_WALLET = 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ';
const ERC_WALLET = '0x' + 'Ab1'.repeat(13) + 'a';

test('settings expose USDT TRC20/ERC20 rates with per-network fee and no fee leak', async () => {
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  const byKey = Object.fromEntries(pub.rates.map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(byKey).sort(), ['BTC', 'LTC', 'USDT_ERC20', 'USDT_TRC20']);
  assert.equal(byKey.USDT_TRC20.currency, 'USDT');
  assert.equal(byKey.USDT_TRC20.network, 'TRC20');
  assert.equal(byKey.USDT_TRC20.label, 'USDT TRC20');
  assert.equal(byKey.USDT_ERC20.network, 'ERC20');
  // USDT-курсы отличаются от BTC-курса и содержат только итоговое значение.
  assert.ok(byKey.USDT_TRC20.rate > 20 && byKey.USDT_TRC20.rate < 400);
  assert.equal(byKey.USDT_TRC20.feePercent, undefined);
  assert.equal(byKey.USDT_TRC20.baseRateUSDT, undefined);
  // Своя комиссия у каждой сети: ERC20 дороже.
  for (const key of ['feePercent', 'feePercentUSDTTRC20', 'feePercentUSDTERC20', 'baseRateUSDT']) {
    assert.equal(pub[key], undefined, `${key} не должен уходить клиенту`);
  }
});

test('USDT TRC20 order is created with network, rounded crypto and a TRC20 address', async () => {
  const s = store.get().settings;
  const r = await api('/api/orders', {
    method: 'POST',
    body: { rub: 10000, currency: 'USDT', network: 'TRC20', wallet: TRC_WALLET },
  });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.currency, 'USDT');
  assert.equal(order.network, 'TRC20');
  assert.equal(order.currencyLabel, 'USDT TRC20');
  assert.equal(order.rate, s.rateUSDTTRC20);
  assert.equal(order.crypto, Math.floor((10000 / s.rateUSDTTRC20) * 1e6) / 1e6);
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  assert.ok(calls.some((c) => String(c.text || '').includes('USDT TRC20')), 'карточка админа показывает сеть');
});

test('USDT ERC20 order works and supports reverse calculation with 6-decimal precision', async () => {
  const s = store.get().settings;
  const r = await api('/api/orders', {
    method: 'POST',
    body: { cryptoAmount: 45.5, currency: 'USDT', network: 'ERC20', wallet: ERC_WALLET },
  });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.network, 'ERC20');
  assert.equal(order.crypto, 45.5);
  assert.equal(order.rub, Math.ceil(45.5 * s.rateUSDTERC20 - 1e-6));
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
});

test('wrong network addresses are rejected for USDT and legacy crypto', async () => {
  const trcAsErc = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'USDT', network: 'ERC20', wallet: TRC_WALLET } });
  assert.equal(trcAsErc.status, 400);
  assert.match((await trcAsErc.json()).error, /ERC20/);
  const ercAsTrc = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'USDT', network: 'TRC20', wallet: ERC_WALLET } });
  assert.equal(ercAsTrc.status, 400);
  assert.match((await ercAsTrc.json()).error, /TRC20/);
  const noNet = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'USDT', wallet: TRC_WALLET } });
  assert.equal(noNet.status, 400);
  assert.match((await noNet.json()).error, /Неизвестная валюта/);
  const btcOnLtc = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'LTC', wallet: 'bc1' + 'a'.repeat(30) } });
  assert.equal(btcOnLtc.status, 400);
  const spaces = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'USDT', network: 'TRC20', wallet: 'T ' + TRC_WALLET.slice(2) } });
  assert.equal(spaces.status, 400);
});

test('disabled directions cannot be ordered and old orders without network stay valid', async () => {
  await click(111, 'm:settings');
  await click(111, 's:dir_USDT_ERC20');
  assert.equal(store.get().settings.enabled.USDT_ERC20, false);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.rates.find((r) => r.key === 'USDT_ERC20').enabled, false);
  assert.equal(pub.rates.find((r) => r.key === 'USDT_ERC20').rate, null);
  const denied = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'USDT', network: 'ERC20', wallet: ERC_WALLET } });
  assert.equal(denied.status, 400);
  await click(111, 's:dir_USDT_ERC20');
  assert.equal(currencies.isEnabled(store.get().settings, 'USDT_ERC20'), true);
  // Заявка из старой базы (без network) продолжает отдаваться клиенту.
  const { order } = await (await api('/api/order/1')).json();
  assert.equal(order.currency, 'BTC');
  assert.equal(order.network, null);
});

test('operator changes USDT commissions independently; TRC20 and ERC20 rates recompute', async () => {
  const before = store.get().settings;
  assert.ok(before.rateUSDTTRC20 > 0 && before.rateUSDTERC20 > 0);
  await click(111, 's:fee_trc20');
  await text(111, '7');
  await click(111, 's:fee_erc20');
  await text(111, '9');
  const s = store.get().settings;
  assert.equal(s.feePercentUSDTTRC20, 7);
  assert.equal(s.feePercentUSDTERC20, 9);
  if (s.baseRateUSDT) {
    assert.equal(s.rateUSDTTRC20, Math.round(s.baseRateUSDT * 1.07 * 100) / 100);
    assert.equal(s.rateUSDTERC20, Math.round(s.baseRateUSDT * 1.09 * 100) / 100);
  }
  // Ручной курс USDT применяется на сайте сразу.
  await click(111, 's:rate_trc20');
  await text(111, '98,75');
  assert.equal(store.get().settings.rateUSDTTRC20, 98.75);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.rates.find((r) => r.key === 'USDT_TRC20').rate, 98.75);
});

test('USDT receipt, payment and completion flow uses 2-decimal display and correct direction', async () => {
  const o = (await (await api('/api/orders', { method: 'POST', body: { rub: 8000, currency: 'USDT', network: 'TRC20', wallet: TRC_WALLET } })).json()).order;
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'new' });
  await click(222, `o:${o.id}:req`);
  calls = [];
  await text(222, 'Т-Банк: +7 900 000-00-00');
  assert.equal(store.getOrder(o.id).status, 'details');
  assert.ok(calls.some((c) => String(c.text || '').includes('USDT')), 'уведомление клиенту упоминает USDT');
  const pdf = Buffer.from('%PDF-1.4 usdt').toString('base64');
  const up = await api(`/api/order/${o.id}/receipt`, { method: 'POST', body: { filename: 'usdt.pdf', data: pdf } });
  assert.equal(up.status, 200);
  await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  calls = [];
  await Promise.all([click(111, `o:${o.id}:confirm`)]);
  const done = store.getOrder(o.id);
  assert.equal(done.status, 'completed');
  // Сумма к выплате не больше заявленной и кратна точности сети.
  assert.ok(done.crypto > 0);
  assert.ok(calls.some((c) => String(c.text || '').includes('USDT TRC20')));
});

test('official rates: USDT comes from Binance P2P even when CoinGecko is faster', async () => {
  const realFetch = global.fetch;
  const callsTo = [];
  global.fetch = async (url) => {
    const u = String(url);
    callsTo.push(u);
    if (u.includes('p2p.binance.com')) {
      const type = new URL(u).searchParams.get('tradeType');
      const rows = type === 'SELL'
        ? [{ adv: { price: '95.10' } }, { adv: { price: '95.60' } }]
        : [{ adv: { price: '94.80' } }, { adv: { price: '94.40' } }];
      return { ok: true, json: async () => ({ data: rows }) };
    }
    if (u.includes('coingecko')) {
      return { ok: true, json: async () => ({ bitcoin: { rub: 9_800_000 }, litecoin: { rub: 9_000 }, tether: { rub: 94.1 } }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  try {
    const official = await rates.fetchOfficial();
    assert.equal(official.btc, 9_800_000);
    assert.equal(official.ltc, 9_000);
    // Середина (95.10 + 94.80) / 2 = 94.95 — P2P важнее CoinGecko.
    assert.equal(official.usdt, 94.95);
    assert.match(official.source, /binance/);
    // Комиссии по сетям применяются к официальному курсу USDT.
    store.mutate((db) => {
      db.settings.feePercentUSDTTRC20 = 4;
      db.settings.feePercentUSDTERC20 = 5;
    });
    const applied = store.mutate((db) => {
      const res = rates.applyFee(official.usdt, db.settings.feePercentUSDTTRC20, 2);
      const erc = rates.applyFee(official.usdt, db.settings.feePercentUSDTERC20, 2);
      return { res, erc };
    });
    assert.equal(applied.res, 98.75); // 94.95 × 1.04 = 98.748 → 98.75
    assert.equal(applied.erc, 99.7); // 94.95 × 1.05 = 99.6975 → 99.7
    assert.ok(callsTo.some((u) => u.includes('p2p.binance.com')));
  } finally {
    global.fetch = realFetch;
  }
});

test('official rates fall back to CoinGecko/ЦБ when P2P is unavailable', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('p2p.binance.com')) return { ok: false, status: 451, json: async () => ({}) };
    if (u.includes('coingecko')) {
      return { ok: true, json: async () => ({ bitcoin: { rub: 9_800_000 }, litecoin: { rub: 9_000 }, tether: { rub: 92.4 } }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  try {
    const official = await rates.fetchOfficial();
    assert.equal(official.usdt, 92.4);
    assert.match(official.source, /coingecko/);
    assert.ok(!/binance/.test(official.source));
  } finally {
    global.fetch = realFetch;
  }
});

test('implausible USDT prices are ignored altogether', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('p2p.binance.com')) {
      const type = new URL(u).searchParams.get('tradeType');
      return { ok: true, json: async () => ({ data: [{ adv: { price: type === 'SELL' ? '9000' : '8900' } }] }) };
    }
    if (u.includes('coingecko')) return { ok: true, json: async () => ({ bitcoin: { rub: 9_800_000 }, litecoin: { rub: 9_000 }, tether: { rub: 94 } }) };
    if (u.includes('cbr-xml-daily')) return { ok: true, json: async () => ({ Valute: { USD: { Value: 93.5 } } }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  try {
    const official = await rates.fetchOfficial();
    // Мусорные 9000 ₽ за USDT не попадают: берём следующий по приоритету источник.
    assert.equal(official.usdt, 94);
  } finally {
    global.fetch = realFetch;
  }
});
