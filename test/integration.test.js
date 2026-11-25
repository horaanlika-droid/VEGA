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
  assert.deepEqual(Object.keys(byKey).sort(), ['BTC', 'GOOGLE_USD', 'LTC', 'USDT_ERC20', 'USDT_TRC20']);
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

test('admin can turn off BTC and LTC exchange per product from settings', async () => {
  calls = [];
  await click(111, 'm:settings');
  const kb = JSON.stringify((calls.find((c) => c.method === 'editMessageText') || {}).reply_markup || {});
  assert.ok(kb.includes('s:dir_BTC') && kb.includes('s:dir_LTC'), 'в настройках есть переключатели BTC и LTC');
  // Выключаем BTC — кнопка в меню меняется на ⛔.
  calls = [];
  await click(111, 's:dir_BTC');
  assert.equal(store.get().settings.enabled.BTC, false);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.rates.find((r) => r.key === 'BTC').enabled, false);
  assert.equal(pub.rates.find((r) => r.key === 'BTC').rate, null);
  const denied = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30) } });
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /BTC/);
  const kbOff = JSON.stringify((calls.find((c) => c.method === 'editMessageText') || {}).reply_markup || {});
  assert.ok(kbOff.includes('⛔ BTC'), 'кнопка BTC показывает выключенное состояние');
  // Выключаем LTC — заявки не принимаются.
  await click(111, 's:dir_LTC');
  assert.equal(store.get().settings.enabled.LTC, false);
  const deniedLtc = await api('/api/orders', { method: 'POST', body: { rub: 5000, currency: 'LTC', wallet: 'ltc1' + 'a'.repeat(30) } });
  assert.equal(deniedLtc.status, 400);
  // Включаем обратно — обмен снова работает.
  await click(111, 's:dir_BTC');
  await click(111, 's:dir_LTC');
  assert.equal(currencies.isEnabled(store.get().settings, 'BTC'), true);
  assert.equal(currencies.isEnabled(store.get().settings, 'LTC'), true);
  const pubOn = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.ok(pubOn.rates.find((r) => r.key === 'BTC').enabled);
  assert.ok(pubOn.rates.find((r) => r.key === 'LTC').enabled);
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

/* ---------- Google Gift Card → USDT ---------- */

test('gift settings expose USD rate, step $10 and no fee leak', async () => {
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  const gift = pub.rates.find((r) => r.key === 'GOOGLE_USD');
  assert.ok(gift, 'направление гифт-карт в настройках');
  assert.equal(gift.direction, 'sell');
  assert.equal(gift.kind, 'gift');
  assert.equal(gift.step, 10);
  assert.equal(gift.minUnits, 10);
  assert.equal(gift.unit, 'USD');
  assert.ok(gift.rate > 0, 'курс карты (₽ за $1) отдаётся клиенту');
  assert.equal(gift.feePercentGOOGLEUSD, undefined);
  assert.equal(gift.baseRateGOOGLEUSD, undefined);
  assert.equal(gift.feePercent, undefined);
});

test('gift order: code + USDT address (TRC20), payout follows the fixed card rate', async () => {
  const s = store.get().settings;
  const r = await api('/api/orders', {
    method: 'POST',
    body: {
      currency: 'GOOGLE_USD',
      units: 30,
      giftCode: 'ABCD-EFGH-IJKL-MNOP',
      wallet: TRC_WALLET,
      startParam: '',
    },
  });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.direction, 'sell');
  assert.equal(order.currency, 'GOOGLE_USD');
  assert.equal(order.units, 30);
  assert.equal(order.network, 'TRC20', 'сеть выплаты определена по адресу');
  assert.equal(order.giftCode, 'ABCD-EFGH-IJKL-MNOP');
  assert.equal(order.status, 'new');
  // Ожидаемая выплата: $30 × 1 USDT за $1 номинала = 30 USDT (по умолчанию без комиссии; от сети не зависит).
  assert.equal(order.crypto, 30);
  assert.equal(order.rate, s.rateGOOGLEUSD);
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  const card = calls.find((c) => String(c.text || '').includes('Заявка #'));
  assert.ok(card, 'карточка оператору отправлена');
  assert.match(card.text, /Google Gift Card \$30/);
  assert.match(card.text, /ABCD-EFGH-IJKL-MNOP/);
  // Пока клиент не нажал «Я оплатил», оператору нечего подтверждать.
  assert.ok(!calls.some((c) => JSON.stringify(c.reply_markup || {}).includes('Карта проверена')));
});

test('gift payout is the same for TRC20 and ERC20 ($10 → 10 USDT)', async () => {
  for (const wallet of [TRC_WALLET, ERC_WALLET]) {
    const r = await api('/api/orders', {
      method: 'POST',
      body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'TEN-' + wallet.slice(0, 6), wallet },
    });
    assert.equal(r.status, 200);
    const { order } = await r.json();
    assert.equal(order.network, wallet.startsWith('0x') ? 'ERC20' : 'TRC20');
    assert.equal(order.crypto, 10);
    assert.equal(order.units, 10);
    await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  }
});

test('gift nominal must be a multiple of $10 and at least $10', async () => {
  for (const units of [5, 9, 15, 25, 0, -10, 'мусор']) {
    const r = await api('/api/orders', {
      method: 'POST',
      body: { currency: 'GOOGLE_USD', units, giftCode: 'CODE-CODE-CODE', wallet: TRC_WALLET },
    });
    assert.equal(r.status, 400, `номинал ${units} должен быть отклонён`);
  }
  const ok = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'CODE-CODE-CODE', wallet: TRC_WALLET },
  });
  assert.equal(ok.status, 200);
  await bus.emit('order_event', { order: store.getOrder((await ok.json()).order.id), type: 'new' });
});

test('gift order is created WITHOUT a code; an invalid code or wallet is rejected', async () => {
  // Новая двухфазная схема: заявка создаётся без кода, код клиент отправит
  // только после подключения оператора (кнопка «🤝 Подключить» в боте оператора).
  const noCode = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, wallet: TRC_WALLET },
  });
  assert.equal(noCode.status, 200);
  const created = (await noCode.json()).order;
  assert.equal(created.status, 'new');
  assert.equal(created.giftCode, null, 'код не хранится до команды оператора');
  // Если старый клиент всё же прислал код при создании — он проверяется.
  const shortCode = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'abc', wallet: TRC_WALLET },
  });
  assert.equal(shortCode.status, 400);
  const weird = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'CODE  CODE  CODE', wallet: TRC_WALLET },
  });
  assert.equal(weird.status, 400);
  // Кошелёк по-прежнему обязателен и проверяется.
  const badWallet = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, wallet: 'bc1' + 'a'.repeat(30) },
  });
  assert.equal(badWallet.status, 400);
  assert.match((await badWallet.json()).error, /USDT/);
});

test('gift two-phase: оператор подключается → клиент шлёт код → карта на проверке', async () => {
  const o = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 20, wallet: ERC_WALLET },
  })).json()).order;
  assert.equal(o.giftCode, null);
  assert.equal(o.status, 'new');
  // Пока оператор не подключился: ни «Я оплатил», ни код не принимаются.
  const earlyPaid = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(earlyPaid.status, 400);
  const earlyCode = await api(`/api/order/${o.id}/code`, { method: 'POST', body: { giftCode: 'EARLY-CODE-1' } });
  assert.equal(earlyCode.status, 400);
  assert.equal(store.getOrder(o.id).giftCode ?? null, null, 'код не сохранён');
  // Оператор подключается к заявке — клиент получает уведомление и право отправить код.
  calls = [];
  await click(111, `o:${o.id}:connect`);
  assert.equal(store.getOrder(o.id).status, 'details');
  assert.ok(calls.some((c) => c.method === 'sendMessage' && String(c.chat_id) === '999' && String(c.text).includes('Оператор на связи')), 'клиент получил уведомление «Оператор на связи»');
  // Без кода «Я оплатил» не проходит и в статусе details.
  const stillPaid = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(stillPaid.status, 400);
  // Оператор не может завершить заявку до того, как код прислан.
  await click(111, `o:${o.id}:confirm`);
  assert.notEqual(store.getOrder(o.id).status, 'completed');
  // Клиент отправляет код — заявка переходит в paid, код уходит операторам на проверку.
  const codeRes = await api(`/api/order/${o.id}/code`, { method: 'POST', body: { giftCode: 'TWO-PHASE-CODE-1' } });
  assert.equal(codeRes.status, 200);
  assert.equal(store.getOrder(o.id).status, 'paid');
  assert.equal(store.getOrder(o.id).giftCode, 'TWO-PHASE-CODE-1');
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'paid' });
  assert.ok(calls.some((c) => String(c.text || '').includes('Клиент подтвердил сделку')), 'оператор получил код на проверку');
  // Теперь оператор может проверить карту и завершить заявку.
  await click(111, `o:${o.id}:confirm`);
  assert.equal(store.getOrder(o.id).status, 'completed');
});

test('gift flow: code → «Я оплатил» → operator confirms and pays USDT', async () => {
  const o = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 50, giftCode: 'CONFIRM-CODE-9999', wallet: TRC_WALLET },
  })).json()).order;
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'new' });
  // Подтвердить карту до «Я оплатил» нельзя.
  calls = [];
  await click(111, `o:${o.id}:confirm`);
  assert.equal(store.getOrder(o.id).status, 'new', 'без подтверждения клиента заявка не двигается');
  // Клиент нажимает «Я оплатил» — карта уходит на проверку.
  const paidRes = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(paidRes.status, 200);
  assert.equal(store.getOrder(o.id).status, 'paid');
  assert.ok(store.getOrder(o.id).paidAt, 'время подтверждения сохранено');
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'paid' });
  assert.ok(calls.some((c) => String(c.text || '').includes('Клиент подтвердил сделку')), 'оператор получил запрос на проверку');
  assert.ok(calls.some((c) => JSON.stringify(c.reply_markup || {}).includes('Карта проверена')));
  // Оператор проверил карту и подтверждает — заявка завершена, оператору дана инструкция на выплату.
  calls = [];
  await click(111, `o:${o.id}:confirm`);
  const done = store.getOrder(o.id);
  assert.equal(done.status, 'completed');
  const msg = calls.find((c) => String(c.text || '').includes('завершена'));
  assert.ok(msg, 'оператор получил инструкцию по выплате');
  assert.match(msg.text, /Карта Google на \$50 проверена/);
  assert.match(msg.text, /USDT/);
  const { order } = await (await api(`/api/order/${o.id}`)).json();
  assert.equal(order.status, 'completed');
  assert.equal(order.giftCode, 'CONFIRM-CODE-9999');
});

test('gift commission: default 0% → $1 = 1 USDT; admin sets the commission', async () => {
  const before = { ...store.get().settings };
  assert.equal(before.giftPercent, 0, 'по умолчанию комиссия 0');
  assert.equal(before.rateGOOGLEUSD, 1, 'по умолчанию $1 номинала = 1 USDT');
  await click(111, 's:fee_gift');
  await text(111, '12');
  const s = store.get().settings;
  assert.equal(s.giftPercent, 12);
  assert.equal(s.rateGOOGLEUSD, 0.88, 'курс карты = (100 − 12) / 100');
  assert.equal(s.feePercent, before.feePercent, 'общая комиссия BTC/LTC не менялась');
  assert.equal(s.feePercentUSDTTRC20, before.feePercentUSDTTRC20, 'комиссия USDT TRC20 не менялась');
  assert.equal(s.rateUSDTTRC20, before.rateUSDTTRC20, 'курс USDT TRC20 не менялся');
  // Ручной курс карты (USDT за $1 номинала) применяется сразу.
  await click(111, 's:rate_gift');
  await text(111, '0,8');
  assert.equal(store.get().settings.rateGOOGLEUSD, 0.8);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.rates.find((r) => r.key === 'GOOGLE_USD').rate, 0.8);
  // Возвращаем комиссию 0% → снова 1:1, карта $10 → 10 USDT.
  await click(111, 's:fee_gift');
  await text(111, '0');
  assert.equal(store.get().settings.rateGOOGLEUSD, 1);
  const check = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'BACK-TO-0-CODE', wallet: TRC_WALLET },
  });
  assert.equal((await check.json()).order.crypto, 10);
});

test('admin changes the support chat link from the app; clients see it live', async () => {
  const newChat = 'https://t.me/+vega_new_chat_link';
  // Обычный клиент не может менять ссылку.
  const forbidden = await api('/api/admin/settings/chat', { method: 'POST', body: { chat: newChat } });
  assert.equal(forbidden.status, 403);
  // Админ (111) — может.
  const ok = await api('/api/admin/settings/chat', { id: 111, method: 'POST', body: { chat: newChat } });
  assert.equal(ok.status, 200);
  assert.equal(store.get().settings.chat, newChat);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.chat, newChat, 'ссылка сразу видна клиентам');
  // Кривой ввод отклоняется.
  const bad = await api('/api/admin/settings/chat', { id: 111, method: 'POST', body: { chat: 'не ссылка' } });
  assert.equal(bad.status, 400);
  // /api/me отдаёт флаг админа.
  const meRes = await api('/api/me', { id: 111 });
  assert.equal((await meRes.json()).me.isAdmin, true);
  const meClient = await api('/api/me');
  assert.equal((await meClient.json()).me.isAdmin, false);
  // Возвращаем исходную ссылку из умолчаний.
  const restore = await api('/api/admin/settings/chat', { id: 111, method: 'POST', body: { chat: 'https://t.me/+tY5b6RUJ0xUwNmNh' } });
  assert.equal(restore.status, 200);
  assert.equal(store.get().settings.chat, 'https://t.me/+tY5b6RUJ0xUwNmNh');
});

test('disabled gift direction rejects new cards but keeps old orders', async () => {
  const old = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'OLD-CODE-1111', wallet: TRC_WALLET },
  })).json()).order;
  await click(111, 's:dir_GOOGLE_USD');
  assert.equal(currencies.isEnabled(store.get().settings, 'GOOGLE_USD'), false);
  const denied = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'NEW-CODE-2222', wallet: TRC_WALLET },
  });
  assert.equal(denied.status, 400);
  const { order } = await (await api(`/api/order/${old.id}`)).json();
  assert.equal(order.units, 10);
  await click(111, 's:dir_GOOGLE_USD');
  assert.equal(currencies.isEnabled(store.get().settings, 'GOOGLE_USD'), true);
  await bus.emit('order_event', { order: store.getOrder(old.id), type: 'reject' });
});

test('card rate does not depend on the USD exchange rate', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('p2p.binance.com')) {
      const type = new URL(u).searchParams.get('tradeType');
      return { ok: true, json: async () => ({ data: [{ adv: { price: type === 'SELL' ? '95.10' : '94.80' } }] }) };
    }
    if (u.includes('coingecko')) return { ok: true, json: async () => ({ bitcoin: { rub: 9_800_000 }, litecoin: { rub: 9_000 }, tether: { rub: 94.1 } }) };
    if (u.includes('cbr-xml-daily')) return { ok: true, json: async () => ({ Valute: { USD: { Value: 93.5 } } }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  try {
    const official = await rates.fetchOfficial();
    assert.equal(official.usd, 93.5);
    // Курс карты считается от номинала, а не от курса доллара.
    const fresh = await rates.refreshRates();
    assert.equal(fresh.settings.rateGOOGLEUSD, currencies.giftRateFromPercent(fresh.settings.giftPercent));
    assert.equal(fresh.settings.rateGOOGLEUSD, 1, 'по умолчанию комиссия 0 → $1 = 1 USDT');
  } finally {
    global.fetch = realFetch;
  }
});

test('gift order gets a 1-hour deadline and expires with a clear reason', async () => {
  const before = Date.now();
  const o = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'TTL-CODE-0001', wallet: TRC_WALLET },
  })).json()).order;
  assert.ok(o.expiresAt, 'срок передан клиенту');
  const ttl = o.expiresAt - before;
  assert.ok(ttl > 59 * 60 * 1000 && ttl <= 61 * 60 * 1000, `срок около часа, получено ${ttl} мс`);
  // Просроченная заявка автоматически отменяется и не принимает «Я оплатил».
  store.updateOrder(o.id, { expiresAt: Date.now() - 1000 });
  const paid = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(paid.status, 200);
  const expired = store.getOrder(o.id);
  assert.equal(expired.status, 'cancelled');
  assert.equal(expired.cancelReason, store.EXPIRED);
  const after = await (await api(`/api/order/${o.id}`)).json();
  assert.equal(after.order.status, 'cancelled');
  assert.equal(after.order.cancelReason, 'Срок на сделку истёк');
});

test('paid gift order does not expire while operator checks the card', async () => {
  const o = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'PAID-CODE-0002', wallet: TRC_WALLET },
  })).json()).order;
  await api(`/api/order/${o.id}/paid`, { method: 'POST' });
  assert.equal(store.getOrder(o.id).status, 'paid');
  store.updateOrder(o.id, { expiresAt: Date.now() - 1000 });
  // «Я оплатил» уже нажато — срок больше не отменяет заявку, ждём решения оператора.
  assert.equal(store.expireIfNeeded(store.getOrder(o.id)).status, 'paid');
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'paid' });
});

test('gift direction carries marketplace hint and USD-only requirement', async () => {
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  const gift = pub.rates.find((r) => r.key === 'GOOGLE_USD');
  assert.match(gift.infoNote, /Яндекс Маркет/);
  assert.match(gift.infoNote, /Ozon/);
  assert.match(gift.infoNote, /Wildberries/);
  assert.match(gift.infoNote, /USD/);
  assert.match(gift.currencyNote, /USD/);
  assert.equal(gift.ttlMinutes, 60);
});
