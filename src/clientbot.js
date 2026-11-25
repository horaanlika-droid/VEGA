// Клиентский бот VEGA — тот же обменник без Mini App, для тех, кто не хочет открывать приложение.
// Флоу: /start → меню → обмен (выбор актива → сумма/номинал → кошелёк → заявка), «Мои заявки»,
// «Поддержка», «Реферальная программа», «Инфо». Всё на обычных сообщениях и кнопках —
// работает у любого клиента Telegram без Mini App и без виджетов.
const { InlineKeyboard } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const receipts = require('./receipts');
const currencies = require('./currencies');
const { esc, fmtRub, fmtCrypto, fmtDate, parseNum } = require('./util');
const widget = require('./widget');
const quoteOps = require('./quote');

const clientFlows = new Map(); // userId -> FSM state
const isPrivate = (ctx) => ctx.chat?.type === 'private' && ctx.from;
const uidOf = (ctx) => String(ctx.from.id);
const isGiftOrder = (o) => o && (o.direction === 'sell' || currencies.isGift(o.currency, o.network));
const giftUnits = (o) => Number(o.units) || 0;
const payoutOf = (o, amount = o.crypto) =>
  `${fmtCrypto(amount, 'USDT', 2)} (${o.network || 'USDT'})`;

/* ---------- контент ---------- */

// Преимущество гифт-карт в минимизации цифрового следа.
const GIFT_PRIVACY =
  '🛡 <b>Минимальный цифровой след</b>\n' +
  '• Карту можно купить за наличные — она ничем не связана с вашим банковским счётом и паспортом.\n' +
  '• Мы не запрашиваем документы и регистрацию: только код карты и адрес USDT-кошелька.\n' +
  '• Выплата идёт сразу на ваш кошелёк — без банков, бирж и посредников.\n' +
  '• Меньше точек, где фиксируются ваши данные, — меньше цифрового следа.';

/* ---------- состояние ---------- */

const ensureUser = (ctx, refParam = '') =>
  store.touchUser({ id: ctx.from.id, first_name: ctx.from.first_name || 'Клиент', username: ctx.from.username || null }, refParam);

const availableBuy = () =>
  currencies.list().filter(
    (p) => p.direction !== 'sell' &&
      currencies.isEnabled(store.get().settings, p.key) &&
      currencies.rateOf(store.get().settings, p.currency, p.network) > 0
  );
const availableGift = () =>
  currencies.list().filter(
    (p) => p.direction === 'sell' &&
      currencies.isEnabled(store.get().settings, p.key) &&
      currencies.rateOf(store.get().settings, p.currency, p.network) > 0
  );

/* ---------- клавиатуры ---------- */

function menuKb(s) {
  const kb = new InlineKeyboard()
    .text('💱 Обменять', 'c:exchange').text('📦 Мои заявки', 'c:orders').row()
    .text('💬 Поддержка', 'c:support').text('ℹ️ Инфо', 'c:info').row()
    .text('🎁 Реферальная программа', 'c:refs');
  // Telegram шлёт web_app только по https — иначе всё сообщение отклоняется и клиент видит тишину.
  if (s.publicUrl && /^https:\/\//i.test(s.publicUrl)) kb.row().webApp('📱 Открыть приложение', s.publicUrl);
  return kb;
}

const backMenuKb = () => new InlineKeyboard().text('↩️ В меню', 'c:menu');

function assetKb() {
  const kb = new InlineKeyboard();
  const buy = availableBuy();
  for (let i = 0; i < buy.length; i += 2) {
    kb.text(`${buy[i].symbol} ${buy[i].label}`, `c:buy:${buy[i].key}`);
    if (buy[i + 1]) kb.text(`${buy[i + 1].symbol} ${buy[i + 1].label}`, `c:buy:${buy[i + 1].key}`);
    kb.row();
  }
  for (const p of availableGift()) {
    kb.text(' Подарочная карта — Google Gift Card', `c:buy:${p.key}`).row();
  }
  kb.text('↩️ В меню', 'c:menu');
  return kb;
}

/* ---------- показ экранов (редактируем сообщение на колбэках) ---------- */

async function show(ctx, text, kb) {
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, opts);
    } catch (e) {
      /* сообщение уже такое или слишком старое — просто отправим новое */
    }
  }
  try {
    return await ctx.reply(text, opts);
  } catch (e) {
    // Telegram отклонил reply_markup (например, не-https web_app-ссылка) —
    // отвечаем без кнопок, чтобы клиент не остался без ответа.
    console.error('[clientbot] ответ отклонён Telegram:', e && e.message);
    try {
      return await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (e2) {
      console.error('[clientbot] ответ без клавиатуры тоже отклонён:', e2 && e2.message);
      return null;
    }
  }
}

function clientMenu(ctx) {
  const s = store.get().settings;
  const online = s.online ? '🟢 Обменник <b>ОНЛАЙН</b>' : '🔴 Обменник <b>ОФФЛАЙН</b>';
  return show(ctx,
    `🌌 <b>VEGA | Official</b> — обменник\n${online}\n\n` +
    `Обменяем ваши деньги: ₽ → BTC / LTC / USDT (TRC20/ERC20) или Google Gift Card → USDT.\n` +
    `Что будем делать?`,
    menuKb(s));
}

function assetScreen(ctx) {
  const s = store.get().settings;
  if (!s.online) {
    return show(ctx, '⛔ <b>Обмен временно недоступен.</b>\nМы скоро вернёмся — загляните чуть позже.', backMenuKb());
  }
  if (!availableBuy().length && !availableGift().length) {
    return show(ctx, '💱 <b>Направления временно недоступны.</b>\nЗагляните чуть позже.', backMenuKb());
  }
  return show(ctx, '💱 <b>Выбор актива</b>\n\nВыберите, чем торгуем:', assetKb());
}

/* ---------- заявка: покупка крипты за рубли ---------- */

function buyPrompt(ctx, pair) {
  clientFlows.set(uidOf(ctx), { type: 'crypto', key: pair.key });
  const sub = pair.network ? ` · сеть ${pair.network}` : '';
  return show(ctx,
    `${pair.symbol} <b>${esc(pair.label)}</b>${esc(sub)}\n\n` +
    `Вы отдаёте рубли, получаете ${esc(pair.label)}.\n` +
    `Стоимость в рублях назовёт оператор после заявки — вы увидите её и согласитесь или откажетесь.\n\n` +
    `Сколько ${esc(pair.label)} хотите получить? Отправьте число (например <b>0.001</b>):\n\n` +
    `/cancel — отмена`,
    new InlineKeyboard().text('↩️ К выбору актива', 'c:exchange'));
}

function buySummary(ctx, pair, crypto) {
  clientFlows.set(uidOf(ctx), { type: 'confirm_buy', key: pair.key, crypto });
  const amount = fmtCrypto(crypto, pair.currency, currencies.displayDecimals(pair.currency, pair.network));
  return show(ctx,
    `💱 <b>Проверьте заявку</b>\n\n` +
    `Вы получаете: <b>${esc(amount)}</b>\n` +
    `Стоимость в рублях назовёт оператор — заявка уйдёт ему на рассмотрение.\n` +
    `<b>Ничего не переводите</b>, пока не согласитесь с суммой.\n\n` +
    `Оформляем?`,
    new InlineKeyboard()
      .text('✅ Оформить заявку', 'c:ok_buy').row()
      .text('✏️ Изменить сумму', 'c:change_buy').text('↩️ К активам', 'c:exchange'));
}

function createBuyOrder(ctx, pair, crypto, wallet) {
  const s = store.get().settings;
  if (!s.online || !currencies.isEnabled(s, pair.key)) return null; // направление выключили между шагами
  const floorCrypto = (v) => Math.floor(v * 10 ** pair.decimals + 1e-6) / 10 ** pair.decimals;
  const amount = floorCrypto(Number(crypto));
  if (!(amount > 0)) return null;
  const usr = ensureUser(ctx);
  const order = store.createOrder({
    userId: uidOf(ctx),
    userName: ctx.from.first_name || 'Клиент',
    userUsername: ctx.from.username || null,
    direction: 'buy',
    rub: null,
    currency: pair.currency,
    network: pair.network || undefined,
    wallet,
    rate: null,
    crypto: amount,
    referrer: usr && usr.referrer,
  });
  bus.emit('order_event', { order, type: 'new' });
  return order;
}

/* ---------- заявка: подарочная карта → USDT ---------- */

// Первое, что видит клиент: диалог с правилами передачи карты.
function giftRules(ctx) {
  clientFlows.delete(uidOf(ctx));
  return show(ctx,
    `🎁 <b>Продажа Google Gift Card</b>\n\n` +
    `<b>Правила передачи карты:</b>\n` +
    `1. Карта — <b>Google Gift Card</b> в валюте <b>USD</b>, с полным неизрасходованным балансом. Рубли и другие валюты не принимаем.\n` +
    `2. Сначала создаётся заявка, затем <b>подключается оператор</b>. <b>Ничего не отправляйте и никому не сообщайте код до его команды.</b>\n` +
    `3. Код карты вы отправляете здесь (или в приложении) <b>только после подключения оператора</b>. Он проверит карту (обычно 5–15 минут).\n` +
    `4. Выплата — в <b>USDT</b> на ваш кошелёк (сеть определим по адресу: T… → TRC20, 0x… → ERC20).\n` +
    `5. Поддержка никогда не просит код и деньги вне заявки. Не сообщайте код никому, кроме оператора в рамках заявки.\n` +
    `6. На сделку даётся <b>1 час</b> с момента создания заявки. Если карта недействительна — заявка отклоняется без выплаты.\n\n` +
    GIFT_PRIVACY,
    new InlineKeyboard().text('✅ Понятно — выбрать номинал', 'c:giftnom').row().text('↩️ К выбору актива', 'c:exchange'));
}

function giftIntro(ctx, pair) {
  const s = store.get().settings;
  const rate = currencies.rateOf(s, pair.currency, pair.network);
  const fee = Number(s.giftPercent) || 0;
  clientFlows.delete(uidOf(ctx));
  const kb = new InlineKeyboard()
    .text('$10', 'c:units:10').text('$20', 'c:units:20').text('$50', 'c:units:50').text('$100', 'c:units:100').row()
    .text('Другая сумма', 'c:giftnum').row()
    .text('↩️ К выбору актива', 'c:exchange');
  return show(ctx,
    `Google Gift Card → USDT\n\n` +
    `Вы отдаёте код карты Google Gift Card номинала в <b>USD</b>, мы выплачиваем USDT на ваш кошелёк.\n\n` +
    `💱 Курс: <b>1 $ = ${esc(rate)} USDT</b> (комиссия обменника: ${fee}%)\n` +
    `⏱ На сделку — 1 час с момента создания.\n` +
    `✅ Принимаем только карты в долларах (USD).\n\n` +
    GIFT_PRIVACY + `\n\n` +
    `Выберите номинал:`,
    kb);
}

// Заявка создаётся БЕЗ кода: код клиент отправит только после подключения оператора.
function askGiftWallet(ctx, units) {
  clientFlows.set(uidOf(ctx), { type: 'gift_wallet', units });
  return show(ctx,
    `👛 <b>Адрес USDT-кошелька</b>\n\n` +
    `Куда выплатить USDT? Отправьте адрес <b>TRC20</b> (T…) или <b>ERC20</b> (0x…) — сеть определим по адресу.\n\n` +
    `/cancel — отмена`,
    new InlineKeyboard().text('↩️ К номиналу', 'c:buy:GOOGLE_USD'));
}

function createGiftOrder(ctx, units, wallet) {
  const s = store.get().settings;
  if (!s.online) return { error: 'Обмен временно недоступен — попробуйте чуть позже.' };
  const giftNetwork = currencies.networkByWallet(wallet);
  if (!giftNetwork) return { error: 'Не похоже на адрес USDT: TRC20 начинается с T, ERC20 — с 0x. Попробуйте ещё раз.' };
  const payout = currencies.giftPayout(s, units, giftNetwork);
  if (!payout || !(payout.crypto > 0)) {
    return { error: `Выплата USDT в сети ${giftNetwork} недоступна. Укажите адрес в другой сети.` };
  }
  const usr = ensureUser(ctx);
  const order = store.createOrder({
    userId: uidOf(ctx),
    userName: ctx.from.first_name || 'Клиент',
    userUsername: ctx.from.username || null,
    direction: 'sell',
    expiresAt: Date.now() + (Number(currencies.gift().ttlMinutes) || 60) * 60 * 1000,
    rub: Math.round(payout.crypto * (payout.usdtRate || 0)),
    units,
    currency: 'GOOGLE_USD',
    network: giftNetwork,
    wallet,
    rate: payout.rate,
    crypto: payout.crypto,
    referrer: usr && usr.referrer,
  });
  bus.emit('order_event', { order, type: 'new' });
  return { order };
}

/* ---------- «Мои заявки» ---------- */

const statusIcon = (o) => {
  if (o.status === 'quote') return '💰';
  if (o.status === 'completed') return '🟢';
  if (o.status === 'rejected' || o.status === 'cancelled') return '⚪';
  if (o.status === 'paid') return '⏳';
  if (o.status === 'details' && isGiftOrder(o)) return '🤝';
  return '🔍';
};
const amountOf = (o) =>
  isGiftOrder(o) ? `🎁 $${giftUnits(o)}` : fmtRub(o.payRub || o.rub);
const shortOf = (o) =>
  isGiftOrder(o) ? 'Google Gift Card' : currencies.shortLabel(o.currency, o.network);

function ordersList(ctx) {
  const all = store.userOrders(uidOf(ctx));
  const active = all.filter((o) => !['completed', 'rejected', 'cancelled'].includes(o.status));
  const recent = all.filter((o) => ['completed', 'rejected', 'cancelled'].includes(o.status)).slice(0, 3);
  const shown = [...active, ...recent].slice(0, 8);
  if (!shown.length) {
    return show(ctx,
      '📦 <b>У вас пока нет заявок.</b>\nОформите первый обмен — он появится здесь.',
      new InlineKeyboard().text('💱 Обменять', 'c:exchange').text('↩️ В меню', 'c:menu'));
  }
  const kb = new InlineKeyboard();
  for (const o of shown) {
    kb.text(`${statusIcon(o)} #${o.id} · ${shortOf(o)} · ${amountOf(o)}`, `c:order:${o.id}`).row();
  }
  kb.text('💱 Обменять', 'c:exchange').text('↩️ В меню', 'c:menu');
  return show(ctx, `📦 <b>Ваши заявки</b>\n\n${active.length ? `Активных: ${active.length}` : 'Активных нет'}. Нажмите на заявку, чтобы открыть:`, kb);
}

async function loadOwnOrder(ctx, id) {
  const o = store.getOrder(id);
  if (!o || String(o.userId) !== uidOf(ctx)) return null;
  return store.expireIfNeeded(o) || o;
}

const orderActionsKb = (o) => {
  const kb = new InlineKeyboard();
  if (o.status === 'details' && isGiftOrder(o) && !o.giftCode) {
    // Оператор подключился — клиент отправляет код.
    kb.text('🎟 Отправить код карты', `c:sendcode:${o.id}`);
  } else if (o.status === 'details' && isGiftOrder(o)) {
    kb.text('🔄 Обновить', `c:order:${o.id}`);
  } else if (o.status === 'details') {
    if (!o.receipt) kb.text('📎 Прикрепить чек (PDF)', `c:receipt:${o.id}`).row();
    kb.text('✅ Я оплатил', `c:paid:${o.id}`);
  } else if (o.status === 'new' && isGiftOrder(o)) {
    if (o.giftCode) kb.text('✅ Я оплатил', `c:paid:${o.id}`); // совместимость со старыми заявками
    else kb.text('🔄 Обновить', `c:order:${o.id}`);
  } else if (o.status === 'quote') {
    kb.text('✅ Согласен, продолжить', `c:quote:${o.id}:yes`).row()
      .text('❌ Отказаться', `c:quote:${o.id}:no`);
  } else if (o.status === 'new') {
    kb.text('🔄 Обновить', `c:order:${o.id}`);
  } else if (o.status === 'paid') {
    kb.text('🔄 Обновить', `c:order:${o.id}`);
  }
  if (['new', 'details', 'quote'].includes(o.status)) kb.text('❌ Отменить', `c:cancel:${o.id}`);
  kb.row().text('📦 К заявкам', 'c:orders').text('↩️ В меню', 'c:menu');
  return kb;
};

function orderDetailText(o) {
  const head = `<b>Заявка #${o.id}</b> · ${esc(fmtDate(o.createdAt))}\n`;
  if (isGiftOrder(o)) {
    const payout = payoutOf(o);
    if (o.status === 'new') {
      if (o.giftCode) {
        // Совместимость со старыми заявками, где код был указан при создании.
        return head +
          `🎁 Google Gift Card <b>$${giftUnits(o)}</b> → ${payout}\n\n` +
          `🎟 Код <code>${esc(o.giftCode)}</code> уже у оператора.\n` +
          `Когда будете готовы отдать карту — нажмите «Я оплатил».`;
      }
      return head +
        `🎁 Google Gift Card <b>$${giftUnits(o)}</b> → ${payout}\n\n` +
        `⏳ <b>Ожидаем подключения оператора</b> — обычно несколько минут.\n` +
        `<b>Ничего не отправляйте и никому не сообщайте код</b> до команды оператора в этой заявке.`;
    }
    if (o.status === 'details' && !o.giftCode) {
      return head +
        `🎁 Google Gift Card <b>$${giftUnits(o)}</b> → ${payout}\n\n` +
        `🤝 <b>Оператор на связи.</b> Дождался и просит код карты.\n` +
        `Нажмите «🎟 Отправить код карты» и отправьте код одним сообщением.`;
    }
    if (o.status === 'details' && o.giftCode) {
      return head +
        `🎁 Google Gift Card <b>$${giftUnits(o)}</b> → ${payout}\n\n` +
        `🔎 Код отправлен — карта на проверке. Обычно 5–15 минут.`;
    }
    if (o.status === 'paid') {
      return head +
        `🎁 Google Gift Card <b>$${giftUnits(o)}</b> → ${payout}\n\n` +
        `🔎 Карта на проверке: оператор проверит номинал, валюту (<b>USD</b>) и баланс.\n` +
        `Обычно 5–15 минут.`;
    }
    if (o.status === 'completed') {
      return head + `🟢 <b>Завершена.</b> Выплата ${payout} отправлена на ваш кошелёк:\n<code>${esc(o.wallet)}</code>${o.txUrl ? `\n🔗 ${esc(o.txUrl)}` : ''}`;
    }
    return head + `${o.status === 'rejected' ? '🔴 Отклонена оператором.' : '⚪ Отменена.'}${o.cancelReason ? `\nПричина: ${esc(o.cancelReason)}` : ''}`;
  }
  const label = currencies.label(o.currency, o.network);
  const amount = fmtCrypto(o.crypto, o.currency, currencies.displayDecimals(o.currency, o.network));
  if (o.status === 'new') {
    if (!(o.payRub || o.rub)) {
      return head + `<b>${esc(amount)}</b> (${esc(label)})\n\n⏳ Оператор изучает заявку — скоро назовёт сумму в рублях. Мы ничего не переводим, пока вы не согласитесь с суммой.`;
    }
    return head + `${fmtRub(o.payRub || o.rub)} → <b>${esc(label)}</b> (≈ ${esc(amount)})\n\n🔍 Сумма согласована — ищем реквизиты, обычно меньше минуты. Реквизиты придут сюда, не закрывайте чат.`;
  }
  if (o.status === 'quote') {
    return head +
      `💰 <b>Оператор назвал сумму к оплате</b>\n\n` +
      `<b>${esc(amount)}</b> (${esc(label)}) = <b>${fmtRub(o.payRub || o.rub)}</b>\n\n` +
      `Продолжим сделку только с вашего согласия. Если сумма не подходит — откажитесь, заявка отменится.`;
  }
  if (o.status === 'details') {
    return head +
      `${fmtRub(o.payRub || o.rub)} → <b>${esc(label)}</b> (≈ ${esc(amount)})\n\n` +
      `🏦 Реквизиты:\n${esc(o.requisites || '—')}\n\n` +
      `💰 К оплате: <b>${fmtRub(o.payRub || o.rub)}</b>\n` +
      (o.receipt ? '🧾 Чек прикреплён ✅\n' : '🧾 Чек ещё не прикреплён\n') +
      `После перевода прикрепите чек (PDF) и нажмите «Я оплатил».`;
  }
  if (o.status === 'paid') {
    return head + `${fmtRub(o.payRub || o.rub)} → <b>${esc(label)}</b>\n\n⏳ Оператор проверяет поступление. Как только платёж подтвердится — отправим ${esc(amount)} на ваш кошелёк.`;
  }
  if (o.status === 'completed') {
    return head + `🟢 <b>Завершена.</b> ${fmtRub(o.payRub || o.rub)} → <b>${esc(amount)}</b> отправлены на ваш кошелёк:\n<code>${esc(o.wallet)}</code>${o.txUrl ? `\n🔗 ${esc(o.txUrl)}` : ''}\n\nСпасибо, что выбираете VEGA ✦`;
  }
  return head + `${o.status === 'rejected' ? '🔴 Отклонена оператором.' : '⚪ Отменена.'}${o.cancelReason ? `\nПричина: ${esc(o.cancelReason)}` : ''}\nЕсли это ошибка — напишите в поддержку.`;
}

async function orderDetail(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  // Если включены виджеты и Telegram их принимает — показываем карточку заявки внутри сообщения.
  const sent = await widget.trySendOrderWidget(ctx, o);
  if (sent) return;
  return show(ctx, orderDetailText(o), orderActionsKb(o));
}

/* ---------- действия клиента ---------- */

async function clientPaid(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  if (isGiftOrder(o)) {
    if (o.status === 'new' && o.giftCode) {
      const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return show(ctx, `🔎 <b>Заявка #${o.id}</b>\nКод отправлен на проверку. Обычно 5–15 минут — оператор проверит карту и выплатит ${payoutOf(o)}.`, new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ В меню', 'c:menu'));
    }
    return show(ctx, orderDetailText(o), orderActionsKb(o));
  }
  if (o.status === 'details') {
    if (!o.receipt) {
      clientFlows.set(uidOf(ctx), { type: 'receipt', orderId: o.id });
      return show(ctx,
        `📎 <b>Сначала прикрепите чек об оплате (PDF, до 8 МБ).</b>\n\nОтправьте файл в этот чат как документ — и нажмите «Я оплатил» ещё раз.`,
        new InlineKeyboard().text('↩️ К заявке', `c:order:${o.id}`));
    }
    const upd = store.updateOrder(o.id, { status: 'paid' });
    bus.emit('order_event', { order: upd, type: 'paid' });
    return show(ctx, `⏳ <b>Заявка #${o.id}: чек принят.</b>\nОжидаем подтверждения оператора — ${fmtCrypto(o.crypto, o.currency, currencies.displayDecimals(o.currency, o.network))} (${esc(currencies.label(o.currency, o.network))}) отправим на ваш кошелёк.`, new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ В меню', 'c:menu'));
  }
  return show(ctx, orderDetailText(o), orderActionsKb(o));
}

async function clientCancel(ctx, id) {
  const o = await loadOwnOrder(ctx, id);
  if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
  if (!['new', 'details'].includes(o.status)) {
    return show(ctx, 'Отменить можно только новую или ожидающую оплаты заявку.', orderActionsKb(o));
  }
  if (o.status === 'cancelled' && o.cancelReason === store.EXPIRED) {
    return show(ctx, `${store.EXPIRED}. Создайте новую заявку.`, backMenuKb());
  }
  const upd = store.updateOrder(o.id, { status: 'cancelled' });
  bus.emit('order_event', { order: upd, type: 'cancelled' });
  return show(ctx, `⚪ <b>Заявка #${o.id} отменена.</b>`, new InlineKeyboard().text('💱 Новый обмен', 'c:exchange').text('↩️ В меню', 'c:menu'));
}

/* ---------- прочее: инфо, рефералы, поддержка ---------- */

function infoScreen(ctx) {
  const s = store.get().settings;
  return show(ctx,
    `ℹ️ <b>VEGA | Official</b>\n\n` +
    `Стоимость обмена в рублях оператор называет в заявке — вы всегда соглашаетесь с суммой до оплаты.\n\n` +
    `Статус: ${s.online ? '🟢 Онлайн' : '🔴 Оффлайн'}\n` +
    `${s.announcement ? `📢 ${esc(s.announcement)}\n\n` : '\n'}` +
    `📇 Оператор: ${esc(s.operator)}\n📣 Канал: ${esc(s.channel)}\n💬 Чат: ${esc(s.chat)}`,
    backMenuKb());
}

function refsScreen(ctx) {
  const s = store.get().settings;
  const me = store.getUser(uidOf(ctx));
  const botUsername = s.botUsername || null;
  const link = botUsername ? `https://t.me/${esc(botUsername)}?start=ref${uidOf(ctx)}` : null;
  return show(ctx,
    `🎁 <b>Реферальная программа</b>\n\n` +
    `Приглашайте друзей — получайте <b>${esc(s.refPercent)}%</b> с каждого их обмена.\n` +
    `Ссылка закрепляет друга за вами навсегда.\n\n` +
    (link ? `Ваша ссылка:\n<code>${link}</code>\n\n` : 'Ссылка появится после подключения бота.\n\n') +
    `Приглашено: <b>${me?.referredCount || 0}</b>`,
    backMenuKb());
}

function supportPrompt(ctx) {
  clientFlows.set(uidOf(ctx), { type: 'support' });
  return show(ctx,
    `💬 <b>Поддержка VEGA</b>\n\nНапишите ваш вопрос одним сообщением — передадим оператору.\nОтвет придёт сюда и в приложение.\n\n/cancel — отмена`,
    new InlineKeyboard().text('↩️ В меню', 'c:menu'));
}

/* ---------- виджет-действия (без рендера — виджет обновится сам) ---------- */

async function clientPaidWidget(ctxLike, id) {
  const userId = String(ctxLike.from?.id || '');
  const found = store.getOrder(id);
  const o = found && String(found.userId) === userId ? store.expireIfNeeded(found) || found : null;
  if (!o) return { ok: 0, error: 'not_found' };
  if (isGiftOrder(o)) {
    if (o.status !== 'new' || !o.giftCode) return { ok: 0, error: 'not_allowed' };
    const upd = store.updateOrder(o.id, { status: 'paid', paidAt: Date.now() });
    bus.emit('order_event', { order: upd, type: 'paid' });
    return { ok: 1, order: upd };
  }
  if (o.status !== 'details') return { ok: 0, error: 'not_allowed' };
  if (!o.receipt) return { ok: 0, error: 'receipt_required' };
  const upd = store.updateOrder(o.id, { status: 'paid' });
  bus.emit('order_event', { order: upd, type: 'paid' });
  return { ok: 1, order: upd };
}

async function clientCancelWidget(ctxLike, id) {
  const userId = String(ctxLike.from?.id || '');
  const found = store.getOrder(id);
  const o = found && String(found.userId) === userId ? store.expireIfNeeded(found) || found : null;
  if (!o) return { ok: 0, error: 'not_found' };
  if (!['new', 'details'].includes(o.status)) return { ok: 0, error: 'not_allowed' };
  const upd = store.updateOrder(o.id, { status: 'cancelled' });
  bus.emit('order_event', { order: upd, type: 'cancelled' });
  return { ok: 1, order: upd };
}

/* ---------- вход: /start, /menu ---------- */

async function clientStart(ctx, refParam = '') {
  if (!isPrivate(ctx)) return;
  ensureUser(ctx, refParam);
  // Если виджеты включены и Telegram их принимает — показываем живой виджет курсов вместо меню.
  if (await widget.trySendRatesWidget(ctx)) return;
  return clientMenu(ctx);
}

/* ---------- роутинг входящих ---------- */

async function handleClientCallback(ctx, d) {
  if (!isPrivate(ctx)) return ctx.answerCallbackQuery({ text: '' }).catch(() => {});
  await ctx.answerCallbackQuery().catch(() => {});
  const mq = d.match(/^c:quote:(\d+):(yes|no)$/);
  if (mq) {
    const o = await loadOwnOrder(ctx, Number(mq[1]));
    if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
    if (o.status !== 'quote') {
      return show(ctx, `ℹ️ По заявке <b>#${o.id}</b> уже есть решение — откройте её в списке.`, new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ В меню', 'c:menu'));
    }
    if (mq[2] === 'yes') {
      const upd = quoteOps.acceptQuote(o.id);
      return show(ctx, `✅ <b>Сумма ${fmtRub(upd.payRub || upd.rub)} согласована.</b>\nОператор пришлёт реквизиты в ближайшее время — ожидайте в этом чате и в приложении.`, new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ В меню', 'c:menu'));
    }
    quoteOps.declineQuote(o.id);
    return show(ctx, `⚪ <b>Заявка #${o.id} отменена</b> — вы отказались от предложенной суммы.\nСоздать новую заявку можно в любой момент.`, new InlineKeyboard().text('💱 Новый обмен', 'c:exchange').text('↩️ В меню', 'c:menu'));
  }
  if (d === 'c:menu') return clientMenu(ctx);
  if (d === 'c:exchange') return assetScreen(ctx);
  if (d === 'c:orders') return ordersList(ctx);
  if (d === 'c:info') return infoScreen(ctx);
  if (d === 'c:refs') return refsScreen(ctx);
  if (d === 'c:support') return supportPrompt(ctx);
  if (d === 'c:ok_buy') {
    const f = clientFlows.get(uidOf(ctx));
    if (!f || f.type !== 'confirm_buy') return assetScreen(ctx);
    const pair = currencies.get(f.key);
    clientFlows.set(uidOf(ctx), { type: 'wallet', key: f.key, crypto: f.crypto });
    return show(ctx,
      `👛 <b>Кошелёк получателя</b>\n\nОтправьте адрес ${esc(pair.label)}:\n<code>${esc(pair.walletHint)}</code>\n\n/cancel — отмена`,
      new InlineKeyboard().text('↩️ К активам', 'c:exchange'));
  }
  if (d === 'c:change_buy') {
    const f = clientFlows.get(uidOf(ctx));
    const pair = currencies.get((f && f.key) || 'BTC');
    return buyPrompt(ctx, pair);
  }
  if (d === 'c:giftnom') {
    const pair = currencies.get('GOOGLE_USD');
    const s = store.get().settings;
    if (!currencies.isEnabled(s, pair.key) || !currencies.rateOf(s, pair.currency, pair.network)) {
      return show(ctx, 'Продажа карт сейчас недоступна. Оставьте заявку в поддержке — мы напишем, когда включим.', assetKb());
    }
    return giftIntro(ctx, pair);
  }
  if (d === 'c:giftnum') {
    clientFlows.set(uidOf(ctx), { type: 'gift_units' });
    return show(ctx, 'Введите номинал карты в $ (кратно $10, минимум $10):\n\n/cancel — отмена', new InlineKeyboard().text('↩️ К номиналу', 'c:buy:GOOGLE_USD'));
  }
  if (d.startsWith('c:units:')) {
    const units = parseInt(d.slice(8), 10);
    if (!Number.isFinite(units) || units < 10) return giftIntro(ctx, currencies.get('GOOGLE_USD'));
    return askGiftWallet(ctx, units);
  }
  if (d.startsWith('c:buy:')) {
    const pair = currencies.get(d.slice('c:buy:'.length));
    if (!pair) return assetScreen(ctx);
    if (pair.direction === 'sell') return giftRules(ctx);
    const s = store.get().settings;
    if (!currencies.isEnabled(s, pair.key) || !currencies.rateOf(s, pair.currency, pair.network)) {
      return show(ctx, `Направление ${esc(pair.label)} сейчас недоступно. Выберите другое.`, assetKb());
    }
    return buyPrompt(ctx, pair);
  }
  if (d.startsWith('c:order:')) return orderDetail(ctx, Number(d.slice(8)));
  if (d.startsWith('c:sendcode:')) {
    const id = Number(d.slice(11));
    const o = await loadOwnOrder(ctx, id);
    if (!o || !isGiftOrder(o)) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
    if (o.status !== 'details') return show(ctx, 'Код можно отправить только после подключения оператора.', orderActionsKb(o));
    clientFlows.set(uidOf(ctx), { type: 'gift_send_code', orderId: o.id });
    return show(ctx,
      `🎟 <b>Код карты Google Gift Card на $${giftUnits(o)}</b>\n\nОператор в заявке и ждёт код. Отправьте код карты (например XXXX-XXXX-XXXX-XXXX) одним сообщением.\n\n/cancel — отмена`,
      new InlineKeyboard().text('↩️ К заявке', `c:order:${o.id}`));
  }
  if (d.startsWith('c:paid:')) return clientPaid(ctx, Number(d.slice(7)));
  if (d.startsWith('c:cancel:')) return clientCancel(ctx, Number(d.slice(9)));
  if (d.startsWith('c:receipt:')) {
    const id = Number(d.slice(10));
    const o = await loadOwnOrder(ctx, id);
    if (!o) return show(ctx, '🚫 Заявка не найдена.', backMenuKb());
    clientFlows.set(uidOf(ctx), { type: 'receipt', orderId: o.id });
    return show(ctx, '📎 Отправьте чек об оплате <b>файлом PDF</b> (до 8 МБ) в этот чат.', new InlineKeyboard().text('↩️ К заявке', `c:order:${o.id}`));
  }
  return clientMenu(ctx);
}

async function handleClientText(ctx) {
  if (!isPrivate(ctx)) return;
  const text = (ctx.message.text || '').trim();
  // /cancel в любой момент сценария — выходим в меню.
  if (/^\/(cancel|stop)(?:@\w+)?(?:\s|$)|^отмен\w*$/i.test(text)) {
    clientFlows.delete(uidOf(ctx));
    return clientMenu(ctx);
  }
  const f = clientFlows.get(uidOf(ctx));
  const s = store.get().settings;
  if (!f) {
    return ctx.reply('Я здесь, чтобы помочь с обменом 🌌\nОткройте меню — или нажмите /menu.', { reply_markup: menuKb(s) });
  }
  if (f.type === 'crypto') {
    const pair = currencies.get(f.key);
    const amount = parseNum(text);
    if (!isFinite(amount) || amount <= 0) {
      return ctx.reply('Отправьте положительное число — сколько крипты хотите получить. Например: 0.001');
    }
    return buySummary(ctx, pair, amount);
  }
  if (f.type === 'confirm_buy') {
    return buySummary(ctx, currencies.get(f.key), f.crypto); // повтор суммы на случай текста
  }
  if (f.type === 'wallet') {
    const pair = currencies.get(f.key);
    const err = currencies.validateWallet(pair.currency, pair.network, text);
    if (err) return ctx.reply(`⚠️ ${err}\n\nПопробуйте ещё раз:`);
    const order = createBuyOrder(ctx, pair, f.crypto, text.trim());
    if (!order) return show(ctx, '⛔ Направление временно недоступно — попробуйте позже.', assetKb());
    clientFlows.delete(uidOf(ctx));
    return show(ctx,
      `✅ <b>Заявка #${order.id} создана!</b>\n\n💰 Оператор скоро назовёт стоимость в рублях — она придёт сюда и появится в приложении. Мы ничего не переводим, пока вы не согласитесь с суммой.`,
      new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('💱 Ещё обмен', 'c:exchange'));
  }
  if (f.type === 'gift_units') {
    const n = parseNum(text);
    const units = currencies.floorUnits('GOOGLE_USD', null, n);
    if (!Number.isFinite(n) || units < 10) {
      return ctx.reply('Минимальный номинал — $10, кратно $10. Например: 20');
    }
    return askGiftWallet(ctx, units);
  }
  if (f.type === 'gift_wallet') {
    const wallet = text.trim();
    const { order, error } = createGiftOrder(ctx, f.units, wallet);
    if (error) return ctx.reply(`⚠️ ${error}`);
    clientFlows.delete(uidOf(ctx));
    const payout = payoutOf(order);
    return show(ctx,
      `✅ <b>Заявка #${order.id} создана!</b>\n\n` +
      `🎁 Google Gift Card <b>$${giftUnits(order)}</b> → <b>${payout}</b>\n\n` +
      `⏳ <b>Ожидаем подключения оператора</b> — дождитесь его сигнала в этом чате.\n` +
      `<b>Ничего не отправляйте и никому не сообщайте код карты</b> до команды оператора. На сделку даётся 1 час.`,
      new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('❌ Отменить', `c:cancel:${order.id}`));
  }
  if (f.type === 'gift_send_code') {
    const code = text.replace(/\s+/g, ' ').trim();
    if (code.length < 8 || code.length > 200 || /\s{2,}/.test(code)) {
      return ctx.reply('Код слишком короткий или с двойными пробелами (минимум 8 символов). Попробуйте ещё раз:');
    }
    const o = await loadOwnOrder(ctx, f.orderId);
    if (!o) { clientFlows.delete(uidOf(ctx)); return show(ctx, '🚫 Заявка не найдена.', backMenuKb()); }
    if (isGiftOrder(o) === false) { clientFlows.delete(uidOf(ctx)); return show(ctx, 'Это не гифт-заявка.', backMenuKb()); }
    if (o.status === 'paid') { clientFlows.delete(uidOf(ctx)); return show(ctx, orderDetailText(o), orderActionsKb(o)); }
    if (o.status !== 'details' && o.status !== 'new') {
      clientFlows.delete(uidOf(ctx));
      return show(ctx, 'Код сейчас не принимается по этой заявке.', orderActionsKb(o));
    }
    if (o.status === 'new' && !o.giftCode) {
      return ctx.reply('⏳ Оператор ещё не подключился. <b>Ничего не отправляйте</b> — дождитесь его сигнала.');
    }
    const upd = store.updateOrder(o.id, { giftCode: code, status: 'paid', paidAt: Date.now() });
    clientFlows.delete(uidOf(ctx));
    bus.emit('order_event', { order: upd, type: 'paid' });
    return show(ctx,
      `🔎 <b>Заявка #${o.id}: код отправлен оператору.</b>\nОбычно проверка занимает 5–15 минут. Выплата — ${payoutOf(upd)}.`,
      new InlineKeyboard().text('📦 Мои заявки', 'c:orders').text('↩️ В меню', 'c:menu'));
  }
  if (f.type === 'support') {
    ensureUser(ctx);
    const message = store.createSupportMessage(uidOf(ctx), 'user', text.slice(0, 2000));
    bus.emit('support_message', { message, user: { id: uidOf(ctx), first_name: ctx.from.first_name, username: ctx.from.username || null } });
    clientFlows.delete(uidOf(ctx));
    return show(ctx, '✅ <b>Передал оператору.</b>\nОтветим здесь и в чате поддержки приложения.', backMenuKb());
  }
  if (f.type === 'receipt') {
    return ctx.reply('Чек нужен файлом <b>PDF</b> — отправьте его как документ (не текстом).\n/cancel — отмена');
  }
  clientFlows.delete(uidOf(ctx));
  return ctx.reply('Что-то пошло не так — начнём заново.', { reply_markup: menuKb(s) });
}

/* Чек PDF от клиента: валидация + сохранение + привязка к заявке. */
async function handleClientDocument(ctx, bot) {
  if (!isPrivate(ctx)) return;
  const f = clientFlows.get(uidOf(ctx));
  if (!f || f.type !== 'receipt') return;
  const doc = ctx.message.document;
  const name = String(doc?.file_name || 'check.pdf').slice(0, 120);
  if (!/\.pdf$/i.test(name) && doc?.mime_type !== 'application/pdf') {
    return ctx.reply('Нужен файл в формате PDF. Попробуйте ещё раз.');
  }
  const size = Number(doc?.file_size) || 0;
  if (size > 8 * 1024 * 1024) {
    return ctx.reply('PDF должен весить до 8 МБ.');
  }
  try {
    const file = await bot.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('download failed');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return ctx.reply('Файл не похож на PDF. Попробуйте ещё раз.');
    }
    const o = await loadOwnOrder(ctx, f.orderId);
    if (!o) {
      clientFlows.delete(uidOf(ctx));
      return ctx.reply('Заявка не найдена.');
    }
    receipts.save(o.id, buf);
    const upd = store.setReceipt(o.id, { name, size: buf.length, at: Date.now() });
    clientFlows.delete(uidOf(ctx));
    bus.emit('order_event', { order: upd, type: 'receipt' });
    return ctx.reply('🧾 <b>Чек получен ✅</b>\nТеперь нажмите «Я оплатил» в заявке.', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('✅ Я оплатил', `c:paid:${o.id}`),
    });
  } catch (e) {
    console.error('[clientbot] receipt upload:', e.message);
    return ctx.reply('Не удалось скачать файл. Попробуйте ещё раз или загрузите чек в приложении.');
  }
}

module.exports = {
  clientStart, // точка входа для /start и /menu (ensureUser + виджет-или-меню)
  sendClientMenu: clientMenu, // обычный экран меню — используется из виджета («Обменять»)
  handleClientCallback,
  handleClientText,
  handleClientDocument,
  clientPaidWidget,
  clientCancelWidget,
  GIFT_PRIVACY,
};
