const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const defaults = () => ({
  seq: 1,
  settings: {
    // Официальный рыночный курс обновляется автоматически; комиссию задаёт оператор.
    marketBTC: 10250000, // ₽ за 1 BTC (официальный курс)
    marketLTC: 9400, // ₽ за 1 LTC (официальный курс)
    commissionBTC: 0, // наценка к официальному курсу, %
    commissionLTC: 0,
    ratesUpdatedAt: null,
    minRub: 3000,
    maxRub: 300000,
    online: true,
    announcement:
      '🚀 VEGA официально начинает работу! Принимаем заявки на обмен BTC и LTC. Минимальная сумма обмена — от 3 000 ₽.',
    refPercent: 1,
    operator: '@VEGA_obmen',
    channel: 'https://t.me/VEGA_Official_65',
    chat: 'https://t.me/+tY5b6RUJ0xUwNmNh',
    publicUrl: null,
    botUsername: null,
  },
  admins: [], // дополнительные операторы; владельцы задаются через окружение
  users: {},
  orders: [],
  flags: {},
});

let db = null;
let saveTimer = null;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = Object.assign(defaults(), raw);
      db.settings = Object.assign(defaults().settings, raw.settings || {});
      // Миграция со старой схемы: ручной курс становится официальным (market), комиссия 0.
      const rs = raw.settings || {};
      if (rs.rateBTC != null && rs.marketBTC == null) db.settings.marketBTC = rs.rateBTC;
      if (rs.rateLTC != null && rs.marketLTC == null) db.settings.marketLTC = rs.rateLTC;
      delete db.settings.rateBTC;
      delete db.settings.rateLTC;
      return;
    }
  } catch (e) {
    console.error('[store] load error:', e.message);
  }
  db = defaults();
  save();
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[store] save error:', e.message);
    }
  }, 150);
}

const get = () => db;
const mutate = (fn) => {
  const r = fn(db);
  save();
  return r;
};

// Курс для клиента: официальный курс + комиссия оператора.
const clientRate = (currency) => {
  const s = db.settings;
  const market = currency === 'BTC' ? s.marketBTC : s.marketLTC;
  const commission = currency === 'BTC' ? s.commissionBTC : s.commissionLTC;
  return Math.round((Number(market) || 0) * (1 + (Number(commission) || 0) / 100));
};

function publicSettings() {
  const s = db.settings;
  return {
    rateBTC: clientRate('BTC'),
    rateLTC: clientRate('LTC'),
    marketBTC: s.marketBTC,
    marketLTC: s.marketLTC,
    commissionBTC: s.commissionBTC,
    commissionLTC: s.commissionLTC,
    ratesUpdatedAt: s.ratesUpdatedAt || null,
    minRub: s.minRub,
    maxRub: s.maxRub,
    online: !!s.online,
    announcement: s.announcement,
    refPercent: s.refPercent,
    operator: s.operator,
    channel: s.channel,
    chat: s.chat,
    publicUrl: s.publicUrl,
    botUsername: s.botUsername,
  };
}

function touchUser(u, refParam) {
  return mutate((d) => {
    const id = String(u.id);
    let user = d.users[id];
    if (!user) {
      user = d.users[id] = {
        id,
        name: u.first_name || u.name || 'Клиент',
        username: u.username || null,
        referrer: null,
        referredCount: 0,
        referredIds: [],
        createdAt: Date.now(),
      };
    }
    user.lastSeen = Date.now();
    if (u.first_name) user.name = u.first_name;
    if (u.username) user.username = u.username;
    if (refParam && !user.referrer) {
      const m = String(refParam).match(/^ref(\d{3,})$/);
      if (m && m[1] !== id) {
        user.referrer = m[1];
        const r = d.users[m[1]];
        if (r) {
          r.referredCount = (r.referredCount || 0) + 1;
          (r.referredIds = r.referredIds || []).push(id);
        } else {
          d.users[m[1]] = {
            id: m[1],
            name: '—',
            username: null,
            referrer: null,
            referredCount: 1,
            referredIds: [id],
            createdAt: Date.now(),
          };
        }
      }
    }
    return user;
  });
}

const getUser = (id) => db.users[String(id)] || null;

function createOrder(o) {
  return mutate((d) => {
    const order = {
      id: d.seq++,
      userId: o.userId,
      userName: o.userName || 'Клиент',
      userUsername: o.userUsername || null,
      rub: o.rub,
      currency: o.currency,
      wallet: o.wallet,
      rate: o.rate,
      crypto: o.crypto,
      status: 'new',
      requisites: null,
      payRub: null,
      referrer: o.referrer || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      adminMsgIds: {},
      version: 0,
    };
    d.orders.push(order);
    return order;
  });
}

const getOrder = (id) => db.orders.find((o) => o.id === Number(id)) || null;

function updateOrder(id, patch) {
  return mutate((d) => {
    const o = d.orders.find((x) => x.id === Number(id));
    if (!o) return null;
    Object.assign(o, patch, { updatedAt: Date.now(), version: (o.version || 0) + 1 });
    return o;
  });
}

const userOrders = (userId) =>
  db.orders.filter((o) => o.userId === String(userId)).sort((a, b) => b.createdAt - a.createdAt);

const activeOrders = () => db.orders.filter((o) => ['new', 'details', 'paid'].includes(o.status));

function stats() {
  const by = (s) => db.orders.filter((o) => o.status === s);
  const done = by('completed');
  return {
    total: db.orders.length,
    new: by('new').length,
    details: by('details').length,
    paid: by('paid').length,
    completed: done.length,
    rejected: by('rejected').length + by('cancelled').length,
    volumeDone: done.reduce((s, o) => s + (o.payRub || o.rub), 0),
    users: Object.keys(db.users).length,
    refs: Object.values(db.users).filter((u) => u.referrer).length,
  };
}

load();

module.exports = {
  DATA_DIR,
  get,
  mutate,
  publicSettings,
  clientRate,
  touchUser,
  getUser,
  createOrder,
  getOrder,
  updateOrder,
  userOrders,
  activeOrders,
  stats,
};
