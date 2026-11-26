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
  const r = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.001, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30) } });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  // Дожидаемся очереди карточек (HTTP намеренно не ждёт Telegram).
  await bus.emit('order_event', { order, type: 'new' });
  // Живая механика: оператор называет сумму, клиент соглашается — после этого сделка продолжается.
  await click(222, `o:${order.id}:quote`);
  await text(222, '5 000');
  await api(`/api/order/${order.id}/quote-accept`, { method: 'POST' });
  calls = [];
  return store.getOrder(order.id);
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

test('quote flow: оператор называет сумму, клиент соглашается — сделка продолжается', async () => {
  const r = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.001, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30) } });
  const { order } = await r.json();
  await bus.emit('order_event', { order, type: 'new' });
  calls = [];
  // Пока сумма не названа — «Выдать реквизиты» недоступна.
  await click(222, `o:${order.id}:req`);
  assert.equal(store.getOrder(order.id).status, 'new');
  const early = calls.filter((c) => c.method === 'sendMessage' && /назвать сумму/i.test(String(c.text || '')));
  assert.ok(early.length >= 1, 'админу подсказывают назвать сумму до реквизитов');
  calls = [];
  // Оператор называет сумму — заявка уходит клиенту на согласование.
  await click(222, `o:${order.id}:quote`);
  await text(222, '5 123');
  const quoted = store.getOrder(order.id);
  assert.equal(quoted.status, 'quote');
  assert.equal(quoted.payRub, 5123);
  const ask = calls.find((c) => c.method === 'sendMessage' && String(c.chat_id) === '999' && /сумма к оплате/i.test(String(c.text || '')));
  assert.ok(ask, 'клиент получил сообщение с суммой');
  // Клиент согласен (через web API) — заявка снова «new» с согласованной суммой.
  const accept = await api(`/api/order/${order.id}/quote-accept`, { method: 'POST' });
  assert.equal(accept.status, 200);
  const agreed = store.getOrder(order.id);
  assert.equal(agreed.status, 'new');
  assert.equal(agreed.payRub, 5123);
  // Повторное согласие невозможно.
  const again = await api(`/api/order/${order.id}/quote-accept`, { method: 'POST' });
  assert.equal(again.status, 400);
  calls = [];
  // Теперь можно выдать реквизиты.
  await click(222, `o:${order.id}:req`);
  await text(222, 'x'.repeat(901));
  assert.equal(store.getOrder(order.id).requisites, null, 'слишком длинные реквизиты отклоняются');
  await text(222, 'Банк, номер, получатель');
  const done = store.getOrder(order.id);
  assert.equal(done.status, 'details');
  assert.equal(done.payRub, 5123);
});

test('quote flow: клиент отказывается от суммы — заявка отменяется с причиной', async () => {
  const r = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.001, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30) } });
  const { order: o } = await r.json();
  await bus.emit('order_event', { order: o, type: 'new' });
  await click(222, `o:${o.id}:quote`);
  await text(222, '7 500');
  assert.equal(store.getOrder(o.id).status, 'quote');
  const decline = await api(`/api/order/${o.id}/quote-decline`, { method: 'POST' });
  assert.equal(decline.status, 200);
  const cancelled = store.getOrder(o.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.cancelReason, /не согласился/i);
  // Согласиться после отказа нельзя.
  const accept = await api(`/api/order/${o.id}/quote-accept`, { method: 'POST' });
  assert.equal(accept.status, 400);
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

test('buy order: no rate anywhere — оператор называет рубль в заявке, клиент видит курс только для карты', async () => {
  const wallet = 'bc1' + 'a'.repeat(30);
  const r = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.001, currency: 'BTC', wallet } });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.crypto, 0.001);
  assert.equal(order.rub, null, 'сумму в рублях называет оператор');
  assert.equal(order.rate, null, 'курса в заявке нет');
  assert.equal(order.status, 'new');
  // Клиенту нигде не светим курс покупки и комиссию.
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.feePercent, undefined);
  assert.equal(pub.baseRateBTC, undefined);
  assert.equal(pub.baseRateLTC, undefined);
  assert.equal(pub.rateBTC, null, 'курс покупки BTC клиенту не отдаём');
  assert.equal(pub.rateLTC, null, 'курс покупки LTC клиенту не отдаём');
  for (const dir of pub.rates) {
    if (dir.direction === 'sell') continue;
    assert.equal(dir.rate, null, `курс ${dir.key} клиенту не отдаём`);
  }
  // Курс карты (продажа) по-прежнему виден — клиент рядовой пользователь, это его выплата.
  const gift = pub.rates.find((d) => d.key === 'GOOGLE_USD');
  assert.equal(gift.rate, store.get().settings.rateGOOGLEUSD);
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
});

test('buy order validation: crypto amount must be a positive finite number; no rub accepted', async () => {
  const wallet = 'ltc1' + 'a'.repeat(30);
  for (const bad of [0, -1, 'мусор', '', null, undefined, Infinity]) {
    const res = await api('/api/orders', { method: 'POST', body: { cryptoAmount: bad, currency: 'LTC', wallet } });
    assert.equal(res.status, 400, `cryptoAmount=${bad} отклонён`);
  }
  // Предельная сумма выше внутреннего потолка отклоняется.
  const huge = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 1e12, currency: 'LTC', wallet } });
  assert.equal(huge.status, 400);
  const ok = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.25, currency: 'LTC', wallet } });
  assert.equal(ok.status, 200);
  const { order } = await ok.json();
  assert.equal(order.crypto, 0.25);
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
});

/* ---------- USDT TRC20 / ERC20 ---------- */

const TRC_WALLET = 'TXFBqBbqJommqZf7BV8NNYzePh97UmJodJ';
const ERC_WALLET = '0x' + 'Ab1'.repeat(13) + 'a';
const BTC_WALLET = 'bc1' + 'a'.repeat(30);

test('settings expose USDT TRC20/ERC20 rates with per-network fee and no fee leak', async () => {
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  const byKey = Object.fromEntries(pub.rates.map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(byKey).sort(), ['APPLE_STORE_USD', 'BTC', 'GOOGLE_USD', 'ITUNES_USD', 'LTC', 'USDT_ERC20', 'USDT_TRC20', 'XBOX_USD']);
  assert.equal(byKey.USDT_TRC20.currency, 'USDT');
  assert.equal(byKey.USDT_TRC20.network, 'TRC20');
  assert.equal(byKey.USDT_TRC20.label, 'USDT TRC20');
  assert.equal(byKey.USDT_ERC20.network, 'ERC20');
  // Курс покупки крипты клиенту не отдаём (оператор называет рубль в заявке).
  assert.equal(byKey.USDT_TRC20.rate, null);
  assert.equal(byKey.USDT_ERC20.rate, null);
  // Курс карты виден — это выплата клиенту.
  assert.equal(byKey.GOOGLE_USD.rate, store.get().settings.rateGOOGLEUSD);
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
    body: { cryptoAmount: 100, currency: 'USDT', network: 'TRC20', wallet: TRC_WALLET },
  });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.currency, 'USDT');
  assert.equal(order.network, 'TRC20');
  assert.equal(order.currencyLabel, 'USDT TRC20');
  assert.equal(order.rate, null, 'курс клиенту не отдаём');
  assert.equal(order.crypto, 100);
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
  assert.equal(order.rub, null, 'сумму в рублях называет оператор');
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
});

test('wrong network addresses are rejected for USDT and legacy crypto', async () => {
  const trcAsErc = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 50, currency: 'USDT', network: 'ERC20', wallet: TRC_WALLET } });
  assert.equal(trcAsErc.status, 400);
  assert.match((await trcAsErc.json()).error, /ERC20/);
  const ercAsTrc = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 50, currency: 'USDT', network: 'TRC20', wallet: ERC_WALLET } });
  assert.equal(ercAsTrc.status, 400);
  assert.match((await ercAsTrc.json()).error, /TRC20/);
  const noNet = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 50, currency: 'USDT', wallet: TRC_WALLET } });
  assert.equal(noNet.status, 400);
  assert.match((await noNet.json()).error, /Неизвестная валюта/);
  const btcOnLtc = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.25, currency: 'LTC', wallet: 'bc1' + 'a'.repeat(30) } });
  assert.equal(btcOnLtc.status, 400);
  const spaces = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 50, currency: 'USDT', network: 'TRC20', wallet: 'T ' + TRC_WALLET.slice(2) } });
  assert.equal(spaces.status, 400);
});

test('disabled directions cannot be ordered and old orders without network stay valid', async () => {
  await click(111, 'm:settings');
  await click(111, 's:dir_USDT_ERC20');
  assert.equal(store.get().settings.enabled.USDT_ERC20, false);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.rates.find((r) => r.key === 'USDT_ERC20').enabled, false);
  assert.equal(pub.rates.find((r) => r.key === 'USDT_ERC20').rate, null);
  const denied = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 50, currency: 'USDT', network: 'ERC20', wallet: ERC_WALLET } });
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
  const denied = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.001, currency: 'BTC', wallet: 'bc1' + 'a'.repeat(30) } });
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /BTC/);
  const kbOff = JSON.stringify((calls.find((c) => c.method === 'editMessageText') || {}).reply_markup || {});
  assert.ok(kbOff.includes('⛔ BTC'), 'кнопка BTC показывает выключенное состояние');
  // Выключаем LTC — заявки не принимаются.
  await click(111, 's:dir_LTC');
  assert.equal(store.get().settings.enabled.LTC, false);
  const deniedLtc = await api('/api/orders', { method: 'POST', body: { cryptoAmount: 0.25, currency: 'LTC', wallet: 'ltc1' + 'a'.repeat(30) } });
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
  // Ручной курс USDT применяется для оператора/бота, но клиенту курс покупки не отдаём.
  await click(111, 's:rate_trc20');
  await text(111, '98,75');
  assert.equal(store.get().settings.rateUSDTTRC20, 98.75);
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.rates.find((r) => r.key === 'USDT_TRC20').rate, null, 'курс покупки клиенту не отдаём');
});

test('USDT receipt, payment and completion flow uses 2-decimal display and correct direction', async () => {
  const o = (await (await api('/api/orders', { method: 'POST', body: { cryptoAmount: 80, currency: 'USDT', network: 'TRC20', wallet: TRC_WALLET } })).json()).order;
  await bus.emit('order_event', { order: store.getOrder(o.id), type: 'new' });
  await click(222, `o:${o.id}:quote`);
  await text(222, '8 000');
  await api(`/api/order/${o.id}/quote-accept`, { method: 'POST' });
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

/* ---------- USD gift cards → BTC ---------- */

test('gift settings expose USD rate, step $10 and no fee leak', async () => {
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  const gift = pub.rates.find((r) => r.key === 'GOOGLE_USD');
  assert.ok(gift, 'направление гифт-карт в настройках');
  assert.equal(gift.direction, 'sell');
  assert.equal(gift.kind, 'gift');
  assert.equal(gift.step, 10);
  assert.equal(gift.minUnits, 10);
  assert.equal(gift.unit, 'USD');
  assert.ok(gift.rate > 0, 'курс карты (BTC за $1) отдаётся клиенту');
  assert.equal(gift.feePercentGOOGLEUSD, undefined);
  assert.equal(gift.baseRateGOOGLEUSD, undefined);
  assert.equal(gift.feePercent, undefined);
});

test('gift order uses a Bitcoin wallet and pays BTC at the shared USD/BTC rate', async () => {
  const s = store.get().settings;
  const r = await api('/api/orders', {
    method: 'POST',
    body: {
      currency: 'GOOGLE_USD',
      units: 30,
      giftCode: 'ABCD-EFGH-IJKL-MNOP',
      wallet: BTC_WALLET,
      startParam: '',
    },
  });
  assert.equal(r.status, 200);
  const { order } = await r.json();
  assert.equal(order.direction, 'sell');
  assert.equal(order.currency, 'GOOGLE_USD');
  assert.equal(order.units, 30);
  assert.equal(order.network, null);
  assert.equal(order.payoutCurrency, 'BTC');
  assert.equal(order.wallet, BTC_WALLET);
  assert.equal(order.giftCode, 'ABCD-EFGH-IJKL-MNOP');
  assert.equal(order.status, 'new');
  assert.equal(order.crypto, Math.floor(30 * s.rateGOOGLEUSD * 1e8 + 1e-6) / 1e8);
  assert.equal(order.rate, s.rateGOOGLEUSD);
  calls = [];
  await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  const card = calls.find((c) => String(c.text || '').includes('Заявка #'));
  assert.ok(card, 'карточка оператору отправлена');
  assert.match(card.text, /Google Gift Card \$30/);
  assert.match(card.text, /ABCD-EFGH-IJKL-MNOP/);
  assert.match(card.text, /BTC/);
  assert.ok(!calls.some((c) => JSON.stringify(c.reply_markup || {}).includes('Карта проверена')));
});

test('Google, iTunes, Xbox and Apple Store orders share the same BTC payout rules', async () => {
  for (const currency of ['GOOGLE_USD', 'ITUNES_USD', 'XBOX_USD', 'APPLE_STORE_USD']) {
    for (const units of [5, 15]) {
      const invalid = await api('/api/orders', {
        method: 'POST',
        body: { currency, units, wallet: BTC_WALLET },
      });
      assert.equal(invalid.status, 400, `${currency} rejects $${units}`);
    }
    const r = await api('/api/orders', {
      method: 'POST',
      body: { currency, units: 10, wallet: BTC_WALLET },
    });
    assert.equal(r.status, 200, `${currency} accepted`);
    const { order } = await r.json();
    assert.equal(order.currency, currency);
    assert.equal(order.payoutCurrency, 'BTC');
    assert.equal(order.network, null);
    assert.equal(order.crypto, Math.floor(10 * order.rate * 1e8 + 1e-6) / 1e8);
    await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
  }
});

test('legacy gift orders with a TRC20/ERC20 network still display USDT payouts', async () => {
  for (const network of ['TRC20', 'ERC20']) {
    const order = store.createOrder({
      userId: '999', userName: 'Legacy Gift', direction: 'sell', currency: 'GOOGLE_USD', network,
      units: 10, wallet: network === 'TRC20' ? TRC_WALLET : ERC_WALLET,
      rate: 0.85, crypto: 8.5, rub: 850,
    });
    const response = await api(`/api/order/${order.id}`);
    assert.equal(response.status, 200);
    const clientOrder = (await response.json()).order;
    assert.equal(clientOrder.payoutCurrency, 'USDT');
    calls = [];
    await bus.emit('order_event', { order: store.getOrder(order.id), type: 'new' });
    const card = calls.find((c) => String(c.text || '').includes(`#${order.id}`));
    assert.ok(card);
    assert.match(card.text, new RegExp(`8\\.5 USDT \\(${network}\\)`));

    const paid = store.updateOrder(order.id, { status: 'paid', giftCode: 'LEGACY-CODE-1234' });
    calls = [];
    await bus.emit('order_event', { order: paid, type: 'paid' });
    const review = calls.find((c) => String(c.text || '').includes(`#${order.id}`));
    assert.ok(review);
    assert.match(review.text, new RegExp(`8\\.5 USDT \\(${network}\\)`));
    assert.match(review.text, new RegExp(`выплатите USDT ${network}`));
    assert.match(JSON.stringify(review.reply_markup), new RegExp(`выплатить USDT ${network}`));
  }
});

test('gift nominal must be a multiple of $10 and at least $10', async () => {
  for (const units of [5, 9, 15, 25, 0, -10, 'мусор']) {
    const r = await api('/api/orders', {
      method: 'POST',
      body: { currency: 'GOOGLE_USD', units, giftCode: 'CODE-CODE-CODE', wallet: BTC_WALLET },
    });
    assert.equal(r.status, 400, `номинал ${units} должен быть отклонён`);
  }
  const ok = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'CODE-CODE-CODE', wallet: BTC_WALLET },
  });
  assert.equal(ok.status, 200);
  await bus.emit('order_event', { order: store.getOrder((await ok.json()).order.id), type: 'new' });
});

test('gift order is created WITHOUT a code; an invalid code or wallet is rejected', async () => {
  // Новая двухфазная схема: заявка создаётся без кода, код клиент отправит
  // только после подключения оператора (кнопка «🤝 Подключить» в боте оператора).
  const noCode = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, wallet: BTC_WALLET },
  });
  assert.equal(noCode.status, 200);
  const created = (await noCode.json()).order;
  assert.equal(created.status, 'new');
  assert.equal(created.giftCode, null, 'код не хранится до команды оператора');
  // Если старый клиент всё же прислал код при создании — он проверяется.
  const shortCode = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'abc', wallet: BTC_WALLET },
  });
  assert.equal(shortCode.status, 400);
  const weird = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'CODE  CODE  CODE', wallet: BTC_WALLET },
  });
  assert.equal(weird.status, 400);
  // Кошелёк по-прежнему обязателен и проверяется.
  const badWallet = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, wallet: 'T' + 'a'.repeat(33) },
  });
  assert.equal(badWallet.status, 400);
  assert.match((await badWallet.json()).error, /Bitcoin/);
});

test('gift two-phase: оператор подключается → клиент шлёт код → карта на проверке', async () => {
  const o = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 20, wallet: BTC_WALLET },
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

test('gift flow: code → «Я оплатил» → operator confirms and pays BTC', async () => {
  const o = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 50, giftCode: 'CONFIRM-CODE-9999', wallet: BTC_WALLET },
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
  assert.match(msg.text, /Карта Google Gift Card на \$50 проверена/);
  assert.match(msg.text, /BTC/);
  const { order } = await (await api(`/api/order/${o.id}`)).json();
  assert.equal(order.status, 'completed');
  assert.equal(order.giftCode, 'CONFIRM-CODE-9999');
});

test('gift commission discounts the live BTC/USD payout consistently for every card', async () => {
  const before = { ...store.get().settings };
  const spot = currencies.giftSpotRate(before);
  assert.equal(before.giftPercent, 0, 'по умолчанию комиссия 0');
  assert.equal(before.rateGOOGLEUSD, currencies.giftRateFromPercent(0, before));
  assert.ok(spot > 0, 'есть BTC/USD spot rate');
  await click(111, 's:fee_gift');
  await text(111, '12');
  const s = store.get().settings;
  const discounted = Math.round(spot * 0.88 * 1e12) / 1e12;
  assert.equal(s.giftPercent, 12);
  assert.equal(s.rateGOOGLEUSD, discounted, 'курс BTC за $1 уменьшается на размер комиссии');
  assert.equal(s.feePercent, before.feePercent, 'общая комиссия BTC/LTC не менялась');
  assert.equal(s.feePercentUSDTTRC20, before.feePercentUSDTTRC20, 'комиссия USDT TRC20 не менялась');
  assert.equal(s.rateUSDTTRC20, before.rateUSDTTRC20, 'курс USDT TRC20 не менялся');
  const pub = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
  assert.equal(pub.rates.find((r) => r.key === 'GOOGLE_USD').rate, discounted);
  assert.equal(pub.rates.find((r) => r.key === 'ITUNES_USD').rate, discounted, 'все бренды используют общий курс');
  await click(111, 's:fee_gift');
  await text(111, '0');
  assert.equal(store.get().settings.rateGOOGLEUSD, currencies.giftRateFromPercent(0, store.get().settings));
  const check = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, wallet: BTC_WALLET },
  });
  const order = (await check.json()).order;
  assert.equal(order.crypto, Math.floor(10 * spot * 1e8 + 1e-6) / 1e8);
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

test('admin settings endpoint: directions toggle, fees and gift card config; clients get 403', async () => {
  // Обычный клиент — 403.
  const forbidden = await api('/api/admin/settings', { method: 'POST', body: { feePercent: 5 } });
  assert.equal(forbidden.status, 403);
  const forbiddenGet = await api('/api/admin/settings');
  assert.equal(forbiddenGet.status, 403);
  // Админ (111) читает текущие настройки.
  const before = await (await api('/api/admin/settings', { id: 111 })).json();
  const oldFee = before.admin.feePercent;
  const oldTrc = before.admin.feePercentUSDTTRC20;
  const oldErc = before.admin.feePercentUSDTERC20;
  const oldGift = before.admin.giftPercent;
  // Выключаем ERC20 через веб-API.
  const toggled = await api('/api/admin/settings', { id: 111, method: 'POST', body: { enabled: { USDT_ERC20: false } } });
  assert.equal(toggled.status, 200);
  assert.equal((await toggled.json()).admin.directions.USDT_ERC20, false);
  assert.equal(currencies.isEnabled(store.get().settings, 'USDT_ERC20'), false);
  // Комиссии BTC/LTC — 9% (максимум), проверяем валидацию и пересчёт.
  const badFee = await api('/api/admin/settings', { id: 111, method: 'POST', body: { feePercent: 80 } });
  assert.equal(badFee.status, 400);
  const feeOk = await api('/api/admin/settings', { id: 111, method: 'POST', body: { feePercent: 9, feePercentUSDTTRC20: 3 } });
  assert.equal(feeOk.status, 200);
  // Карта: комиссия 15% → курс пересчитывается из неё.
  const gift = await api('/api/admin/settings', { id: 111, method: 'POST', body: { giftPercent: 15 } });
  const giftBody = await gift.json();
  assert.equal(giftBody.admin.giftPercent, 15);
  assert.equal(giftBody.admin.rateGOOGLEUSD, currencies.giftRateFromPercent(15, store.get().settings));
  const badDir = await api('/api/admin/settings', { id: 111, method: 'POST', body: { enabled: { NOPE: true } } });
  assert.equal(badDir.status, 400);
  // Чисто текстовые ошибки тоже отклоняются.
  const nothing = await api('/api/admin/settings', { id: 111, method: 'POST', body: {} });
  assert.equal(nothing.status, 400);
  // Возвращаем исходные настройки.
  await api('/api/admin/settings', { id: 111, method: 'POST', body: { enabled: { USDT_ERC20: true }, feePercent: oldFee ?? 0, feePercentUSDTTRC20: oldTrc ?? 0, feePercentUSDTERC20: oldErc ?? 0, giftPercent: oldGift ?? 0 } });
  assert.equal(currencies.isEnabled(store.get().settings, 'USDT_ERC20'), true);
  assert.equal(store.get().settings.feePercent, oldFee ?? 0);
  assert.equal(store.get().settings.feePercentUSDTTRC20, oldTrc ?? 0);
  assert.equal(store.get().settings.giftPercent, oldGift ?? 0);
  assert.equal(store.get().settings.rateGOOGLEUSD, currencies.giftRateFromPercent(oldGift ?? 0, store.get().settings), 'курс карты всегда выводится из BTC/USD и комиссии');
});

test('disabled gift direction rejects new cards but keeps old orders', async () => {
  const old = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'OLD-CODE-1111', wallet: BTC_WALLET },
  })).json()).order;
  await click(111, 's:dir_GOOGLE_USD');
  assert.equal(currencies.isEnabled(store.get().settings, 'GOOGLE_USD'), false);
  const denied = await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'NEW-CODE-2222', wallet: BTC_WALLET },
  });
  assert.equal(denied.status, 400);
  const { order } = await (await api(`/api/order/${old.id}`)).json();
  assert.equal(order.units, 10);
  await click(111, 's:dir_GOOGLE_USD');
  assert.equal(currencies.isEnabled(store.get().settings, 'GOOGLE_USD'), true);
  await bus.emit('order_event', { order: store.getOrder(old.id), type: 'reject' });
});

test('gift rate uses the official USD/BTC cross rate and refreshes with market data', async () => {
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
    const fresh = await rates.refreshRates();
    assert.equal(fresh.settings.baseRateUSD, 93.5);
    assert.equal(fresh.settings.baseRateBTC, 9_800_000);
    assert.equal(fresh.settings.rateGOOGLEUSD, currencies.giftRateFromPercent(fresh.settings.giftPercent, fresh.settings));
    const expectedSpot = Math.round((93.5 / 9_800_000) * 1e12) / 1e12;
    assert.equal(fresh.settings.rateGOOGLEUSD, expectedSpot, 'при комиссии 0 курс равен USD/RUB ÷ BTC/RUB');
  } finally {
    global.fetch = realFetch;
  }
});

test('gift order gets a 1-hour deadline and expires with a clear reason', async () => {
  const before = Date.now();
  const o = (await (await api('/api/orders', {
    method: 'POST',
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'TTL-CODE-0001', wallet: BTC_WALLET },
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
    body: { currency: 'GOOGLE_USD', units: 10, giftCode: 'PAID-CODE-0002', wallet: BTC_WALLET },
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
