const { Bot, InlineKeyboard } = require('grammy');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const { esc, fmtRub, fmtCrypto, fmtDate, plural, parseNum } = require('./util');

let bot = null;
const flows = new Map(); // adminId -> { type, orderId? }

const isAdmin = (ctx) => !!config.adminId && String(ctx.from && ctx.from.id) === String(config.adminId);

const STATUS_LABEL = {
  new: '🔍 Идёт подбор реквизитов',
  details: '💳 Ожидает оплаты клиентом',
  paid: '⏳ Клиент оплатил — нужно подтверждение',
  completed: '🟢 Завершена',
  rejected: '🔴 Отклонена',
  cancelled: '⚪ Отменена клиентом',
};

/* ---------- рендер сообщений ---------- */

function orderText(o) {
  const ref = o.referrer ? store.getUser(o.referrer) : null;
  return (
    `📥 <b>Заявка #${o.id}</b>\n` +
    `👤 ${esc(o.userName)}${o.userUsername ? ' (@' + esc(o.userUsername) + ')' : ''} · <code>${esc(o.userId)}</code>\n` +
    `💵 Сумма: <b>${fmtRub(o.rub)}</b>\n` +
    `🪙 Валюта: <b>${o.currency}</b> ≈ ${fmtCrypto(o.crypto, o.currency)}\n` +
    `👛 Кошелёк: <code>${esc(o.wallet)}</code>\n` +
    `🧬 Реферер: ${ref ? esc(ref.name) + ' (#' + esc(ref.id) + ')' : '—'}\n` +
    (o.requisites ? `🏦 Реквизиты: ${esc(o.requisites)}\n` : '') +
    (o.payRub ? `💰 К оплате: <b>${fmtRub(o.payRub)}</b>\n` : '') +
    `🕒 ${fmtDate(o.createdAt)}\n` +
    `Статус: ${STATUS_LABEL[o.status] || o.status}`
  );
}

function orderKb(o) {
  const kb = new InlineKeyboard();
  if (o.status === 'new') {
    kb.text('💳 Выдать реквизиты', `o:${o.id}:req`).text('❌ Отклонить', `o:${o.id}:reject`);
  } else if (o.status === 'details') {
    kb.text('✅ Оплачено (подтвердить)', `o:${o.id}:confirm`)
      .row()
      .text('✏️ Изменить сумму', `o:${o.id}:amt`)
      .text('❌ Отклонить', `o:${o.id}:reject`);
  } else if (o.status === 'paid') {
    kb.text('✅ Подтвердить и завершить', `o:${o.id}:confirm`)
      .row()
      .text('❌ Оплата не поступила', `o:${o.id}:unpaid`);
  } else {
    kb.text(' К списку заявок', 'm:orders');
  }
  return kb;
}

async function sendOrUpdateOrderAdmin(o) {
  if (!bot || !config.adminId) return;
  const opts = { parse_mode: 'HTML', reply_markup: orderKb(o) };
  if (o.adminMsgId) {
    try {
      await bot.api.editMessageText(config.adminId, o.adminMsgId, orderText(o), opts);
      return;
    } catch {
      /* упадёт, если сообщение старое — отправим новое */
    }
  }
  try {
    const m = await bot.api.sendMessage(config.adminId, orderText(o), opts);
    store.updateOrder(o.id, { adminMsgId: m.message_id });
  } catch (e) {
    console.error('[bot] send order:', e.message);
  }
}

/* ---------- события заказов из веб-части ---------- */

async function onOrderEvent({ order, type }) {
  if (!bot || !config.adminId) return;
  if (type === 'new') {
    await sendOrUpdateOrderAdmin(order);
  } else if (type === 'paid') {
    await sendOrUpdateOrderAdmin(order);
    try {
      await bot.api.sendMessage(
        config.adminId,
        `🔔 <b>Клиент нажал «Я оплатил» по заявке #${order.id}!</b>\nПроверьте поступление ${fmtRub(order.payRub || order.rub)} и подтвердите завершение.`,
        { parse_mode: 'HTML', reply_markup: orderKb(order) }
      );
    } catch {}
  } else {
    await sendOrUpdateOrderAdmin(order);
  }
}

/* ---------- меню ---------- */

async function mainMenu(ctx, edit = false) {
  const s = store.get().settings;
  const active = store.activeOrders().length;
  const kb = new InlineKeyboard()
    .text(`📥 Заявки${active ? ` (${active})` : ''}`, 'm:orders')
    .text('📊 Статистика', 'm:stats')
    .row()
    .text('⚙️ Настройки', 'm:settings')
    .text('🔗 Ссылки', 'm:links');
  const text =
    `🌌 <b>VEGA | Official</b> — пульт оператора\n` +
    `${s.online ? '🟢 Обменник <b>ОНЛАЙН</b>' : '🔴 Обменник <b>ОФФЛАЙН</b>'}\n` +
    `₿ ${fmtRub(s.rateBTC)} · Ł ${fmtRub(s.rateLTC)}\n` +
    `Активных заявок: ${active}`;
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

async function ordersMenu(ctx, edit = true) {
  const list = store.activeOrders().sort((a, b) => b.createdAt - a.createdAt);
  const kb = new InlineKeyboard();
  if (!list.length) {
    kb.text('↩️ Назад', 'm:home');
    const text = '📥 <b>Заявки</b>\n\nАктивных заявок нет. Новые появятся здесь автоматически.';
    return edit
      ? ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
      : ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
  for (const o of list.slice(0, 8)) {
    kb.text(`#${o.id} · ${o.currency} · ${fmtRub(o.rub)} · ${o.status === 'new' ? '🔍' : o.status === 'paid' ? '⏳' : '💳'}`, `o:${o.id}`).row();
  }
  kb.text('🔄 Обновить', 'm:orders').text('↩️ Назад', 'm:home');
  const text = '📥 <b>Активные заявки</b> — нажмите, чтобы открыть:';
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

function settingsKb(s) {
  return new InlineKeyboard()
    .text('₿ Курс BTC', 's:rateBTC')
    .text('Ł Курс LTC', 's:rateLTC')
    .row()
    .text('⬇️ Мин. сумма', 's:min')
    .text('⬆️ Макс. сумма', 's:max')
    .row()
    .text(s.online ? '🟢 Онлайн' : '🔴 Оффлайн', 's:online')
    .text('🎁 Реф. %', 's:ref')
    .row()
    .text('📢 Объявление', 's:ann')
    .text('📇 Оператор', 's:op')
    .row()
    .text('📣 Канал', 's:ch')
    .text('💬 Чат', 's:chat')
    .row()
    .text('↩️ Назад', 'm:home');
}

function settingsText(s) {
  return (
    `⚙️ <b>Настройки</b> (применяются мгновенно)\n\n` +
    `₿ Курс BTC: <b>${fmtRub(s.rateBTC)}</b>\n` +
    `Ł Курс LTC: <b>${fmtRub(s.rateLTC)}</b>\n` +
    `Лимиты: ${fmtRub(s.minRub)} — ${fmtRub(s.maxRub)}\n` +
    `🎁 Реферальный процент: <b>${s.refPercent}%</b>\n` +
    `Статус: ${s.online ? '🟢 Онлайн' : '🔴 Оффлайн'}\n` +
    `📢 ${esc(s.announcement)}\n` +
    `📇 ${esc(s.operator)} · 📣 ${esc(s.channel)}\n💬 ${esc(s.chat)}`
  );
}

async function settingsMenu(ctx, edit = true) {
  const s = store.get().settings;
  const opts = { parse_mode: 'HTML', reply_markup: settingsKb(s) };
  if (edit) await ctx.editMessageText(settingsText(s), opts).catch(() => {});
  else await ctx.reply(settingsText(s), opts);
}

async function statsMenu(ctx, edit = true) {
  const t = store.stats();
  const text =
    `📊 <b>Статистика</b>\n\n` +
    `Всего заявок: <b>${t.total}</b>\n` +
    `🔍 Новых: ${t.new} · 💳 Ждут оплаты: ${t.details} · ⏳ Ждут подтверждения: ${t.paid}\n` +
    `🟢 Завершено: <b>${t.completed}</b> на <b>${fmtRub(t.volumeDone)}</b>\n` +
    `🔴 Отклонено/отменено: ${t.rejected}\n\n` +
    `👥 Клиентов: ${t.users} · 🧬 С реферерами: ${t.refs}`;
  const kb = new InlineKeyboard().text('🔄 Обновить', 'm:stats').text('↩️ Назад', 'm:home');
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

async function linksMenu(ctx, edit = true) {
  const s = store.get().settings;
  const url = s.publicUrl || '(появится автоматически после первого открытия сайта)';
  const text =
    `🔗 <b>Ссылки</b>\n\n` +
    `🌐 Сайт обменника:\n${esc(url)}\n\n` +
    `Адрес определяется автоматически при первом открытии сайта и сразу прописывается в кнопку меню Telegram.\n\n` +
    `📇 Оператор: ${esc(s.operator)}\n📣 Канал: ${esc(s.channel)}\n💬 Чат: ${esc(s.chat)}`;
  const kb = new InlineKeyboard().text('↩️ Назад', 'm:home');
  if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
}

/* ---------- FSM ввода от админа ---------- */

const SET_FIELDS = {
  rateBTC: { label: 'новый курс BTC (₽ за 1 BTC)', num: true },
  rateLTC: { label: 'новый курс LTC (₽ за 1 LTC)', num: true },
  min: { label: 'минимальную сумму обмена (₽)', num: true, key: 'minRub' },
  max: { label: 'максимальную сумму обмена (₽)', num: true, key: 'maxRub' },
  ref: { label: 'реферальный процент (например 1)', num: true, key: 'refPercent' },
  ann: { label: 'текст объявления для сайта' },
  op: { label: 'юзернейм оператора (например @VEGA_obmen)' },
  ch: { label: 'ссылку на канал' },
  chat: { label: 'ссылку на чат' },
};

async function handleAdminText(ctx) {
  const f = flows.get(ctx.from.id);
  if (!f) return;
  const text = ctx.text.trim();
  if (/^\/(cancel|stop)|^отмена$/i.test(text)) {
    flows.delete(ctx.from.id);
    return ctx.reply('❌ Ввод отменён.', { reply_markup: homeKb() });
  }
  if (f.type === 'req') {
    store.updateOrder(f.orderId, { requisites: text.slice(0, 900) });
    const o = store.getOrder(f.orderId);
    flows.set(ctx.from.id, { type: 'amt', orderId: f.orderId });
    return ctx.reply(
      `Реквизиты сохранены.\nТеперь отправьте точную сумму к оплате в ₽ (или «так же», если ${fmtRub(o.rub)}).`,
      { parse_mode: 'HTML' }
    );
  }
  if (f.type === 'amt') {
    const o = store.getOrder(f.orderId);
    let pay = /^(так|таk|так же|same|=|\.)$/i.test(text) ? o.rub : parseNum(text);
    if (!isFinite(pay) || pay <= 0) return ctx.reply('Не понял сумму. Пришлите число в рублях или «так же».');
    flows.delete(ctx.from.id);
    const upd = store.updateOrder(f.orderId, { payRub: pay, status: 'details' });
    await sendOrUpdateOrderAdmin(upd);
    return ctx.reply(`✅ Заявка #${o.id} отправлена клиенту с реквизитами и суммой ${fmtRub(pay)}.`, {
      parse_mode: 'HTML',
      reply_markup: homeKb(),
    });
  }
  if (f.type && f.type.startsWith('set:')) {
    const field = SET_FIELDS[f.type.slice(4)];
    if (field) {
      if (field.num) {
        const n = parseNum(text);
        if (!isFinite(n) || n <= 0) return ctx.reply('Нужно число. Пример: 10250000');
        store.mutate((db) => {
          db.settings[field.key || f.type.slice(4)] = n;
        });
      } else {
        store.mutate((db) => {
          db.settings[field.key || f.type.slice(4)] = text.slice(0, 500);
        });
      }
      flows.delete(ctx.from.id);
      return settingsMenu(ctx, false).then(() =>
        ctx.reply('✅ Сохранено и уже применилось на сайте.', { reply_markup: homeKb() })
      );
    }
  }
}

function homeKb() {
  return new InlineKeyboard()
    .text('📥 Заявки', 'm:orders')
    .text('⚙️ Настройки', 'm:settings')
    .row()
    .text('📊 Статистика', 'm:stats')
    .text('🔗 Ссылки', 'm:links');
}

/* ---------- регистрация обработчиков ---------- */

function register() {
  bot.command('start', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔️ Этот бот — пульт оператора обменника VEGA.');
    flows.delete(ctx.from.id);
    await mainMenu(ctx, false);
  });
  bot.command('menu', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await mainMenu(ctx, false);
  });

  bot.on('callback_query:data', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: '⛔️' });
    const d = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery().catch(() => {});
    flows.delete(ctx.from.id);

    if (d === 'm:home') return mainMenu(ctx, true);
    if (d === 'm:orders') return ordersMenu(ctx, true);
    if (d === 'm:settings') return settingsMenu(ctx, true);
    if (d === 'm:stats') return statsMenu(ctx, true);
    if (d === 'm:links') return linksMenu(ctx, true);

    if (d === 's:online') {
      store.mutate((db) => {
        db.settings.online = !db.settings.online;
      });
      return settingsMenu(ctx, true);
    }
    if (d.startsWith('s:')) {
      const key = d.slice(2);
      if (SET_FIELDS[key]) {
        flows.set(ctx.from.id, { type: d });
        await ctx.editMessageText(`✍️ Отправьте ${SET_FIELDS[key].label}.\n( /cancel — отмена )`, {
          parse_mode: 'HTML',
        }).catch(() => {});
        return;
      }
    }

    const m = d.match(/^o:(\d+)(?::(\w+))?$/);
    if (m) {
      const id = Number(m[1]);
      const act = m[2];
      const o = store.getOrder(id);
      if (!o) return ctx.editMessageText('Заявка не найдена.', { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('↩️ Назад', 'm:orders') }).catch(() => {});
      if (!act) {
        return ctx.editMessageText(orderText(o), { parse_mode: 'HTML', reply_markup: orderKb(o) }).catch(() => {});
      }
      if (act === 'req') {
        flows.set(ctx.from.id, { type: 'req', orderId: id });
        return ctx.editMessageText(
          `💳 Заявка #${id}.\nОтправьте одним сообщением реквизиты для оплаты клиентом (карта / СБП / счёт):\n\n<code>Например:\nСбер: 2202 20XX XXXX 2024\nПолучатель: VEGA\nСБП: +7 9XX XXX-XX-XX</code>\n\n( /cancel — отмена )`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      if (act === 'amt') {
        flows.set(ctx.from.id, { type: 'amt', orderId: id });
        return ctx.editMessageText(`✏️ Заявка #${id}. Отправьте точную сумму к оплате в ₽ (сейчас ${fmtRub(o.payRub || o.rub)}).`, { parse_mode: 'HTML' }).catch(() => {});
      }
      if (act === 'reject') {
        const upd = store.updateOrder(id, { status: 'rejected' });
        return sendOrUpdateOrderAdmin(upd);
      }
      if (act === 'unpaid') {
        const upd = store.updateOrder(id, { status: 'rejected' });
        return sendOrUpdateOrderAdmin(upd);
      }
      if (act === 'confirm') {
        const upd = store.updateOrder(id, { status: 'completed' });
        await sendOrUpdateOrderAdmin(upd);
        return ctx.reply(
          `📨 <b>Заявка #${id} завершена.</b>\nОтправьте клиенту вручную:\n🪙 <b>${fmtCrypto(upd.crypto, upd.currency)}</b>\n👛 <code>${esc(upd.wallet)}</code>`,
          { parse_mode: 'HTML' }
        );
      }
    }
  });

  bot.on('message:text', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await handleAdminText(ctx);
  });
}

/* ---------- запуск ---------- */

async function startBot() {
  if (!config.botToken) {
    console.log('[VEGA] BOT_TOKEN не задан → сайт работает в ДЕМО-режиме, бот отключён.');
    return;
  }
  bot = new Bot(config.botToken);
  await bot.init();
  store.mutate((db) => {
    db.settings.botUsername = bot.botInfo.username;
  });
  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Главное меню' },
      { command: 'menu', description: 'Показать меню' },
    ])
    .catch(() => {});

  if (!config.adminId) {
    console.warn('[VEGA] ВНИМАНИЕ: ADMIN_ID не задан — бот никому не будет отвечать!');
  } else if (!store.get().flags.onboarded) {
    store.mutate((db) => {
      db.flags.onboarded = true;
    });
    await bot.api
      .sendMessage(
        config.adminId,
        `🚀 <b>VEGA запущен и настроен автоматически!</b>\n\n` +
          `🤖 Бот: @${esc(bot.botInfo.username)}\n` +
          `🗄 База создана, дефолтные курсы установлены (меняйте в ⚙️).\n` +
          `🌐 Сайт обменника раздаётся этим же процессом — публичный адрес определится сам при первом открытии и пропишется в кнопку меню Telegram.\n\n` +
          `Что дальше:\n1️⃣ /start — пульт оператора\n2️⃣ ️ Настройки → поставьте свои курсы\n3️⃣ Откройте сайт и проверьте обмен end-to-end`,
        { parse_mode: 'HTML' }
      )
      .catch((e) => console.error('[bot] onboarding:', e.message));
  }

  register();
  bus.on('order_event', onOrderEvent);
  bus.on('public_url', async (url) => {
    try {
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', url } });
      console.log('[VEGA] кнопка меню Telegram настроена на', url);
    } catch (e) {
      console.error('[VEGA] setChatMenuButton:', e.message);
    }
    if (config.adminId)
      bot.api
        .sendMessage(
          config.adminId,
          `🔗 Публичный адрес обменника определён автоматически:\n${url}\nОн же прописан в кнопку меню Telegram.`
        )
        .catch(() => {});
  });

  bot.catch((e) => console.error('[bot error]', e.message));
  bot.start();
  console.log('[VEGA] бот запущен: @' + bot.botInfo.username);
}

module.exports = { startBot };
