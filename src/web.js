const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./bus');
const { validateInitData, parseUser } = require('./validate');

const TERMINAL = ['completed', 'rejected', 'cancelled'];

const clientOrder = (o) => ({
  id: o.id,
  rub: o.rub,
  currency: o.currency,
  wallet: o.wallet,
  crypto: o.crypto,
  rate: o.rate,
  status: o.status,
  requisites: o.requisites,
  payRub: o.payRub,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

const clientUser = (u) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  referrer: u.referrer,
  referredCount: u.referredCount || 0,
});

function startWeb() {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'extended');
  app.use(express.json({ limit: '1mb' }));

  // Автоопределение публичного адреса сайта (для меню TG и ссылок) —
  // берём Host из первого внешнего захода, никаких ручных настроек.
  app.use((req, res, next) => {
    if (req.method === 'GET') {
      const proto = String(req.get('x-forwarded-proto') || 'https').split(',')[0].trim();
      const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
      if (
        host &&
        !/^(localhost|127\.|0\.0\.0\.0|\[|192\.168\.|10\.)/.test(host) &&
        !host.includes('127.0.0.1')
      ) {
        const url = `${proto}://${host}`.replace(/\/+$/, '');
        if (url !== store.get().settings.publicUrl) {
          store.mutate((db) => {
            db.settings.publicUrl = url;
          });
          console.log('[VEGA] публичный адрес определён автоматически:', url);
          bus.emit('public_url', url);
        }
      }
    }
    next();
  });

  // Аутентификация: валидный initData TG, либо демо-пользователь, если токен не задан.
  const auth = (req) => {
    const body = req.body || {};
    const q = req.query || {};
    const initData = body.initData || q.initData || '';
    if (config.botToken) {
      if (initData && validateInitData(initData, config.botToken)) {
        return { user: parseUser(initData), demo: false };
      }
      return null;
    }
    const d = body.demo || q.demo;
    if (d && d.id) {
      return { user: { id: String(d.id), first_name: d.name || 'Демо', username: d.username || '' }, demo: true };
    }
    return null;
  };

  const needAuth = (req, res) => {
    const a = auth(req);
    if (!a) {
      res.status(401).json({ error: 'unauthorized' });
      return null;
    }
    return a;
  };

  app.post('/api/init', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.body.startParam || '');
    res.json({ me: clientUser(user), settings: store.publicSettings(), demo: a.demo });
  });

  app.get('/api/settings', (req, res) => res.json(store.publicSettings()));

  app.get('/api/me', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const user = store.touchUser(a.user, req.query.startParam || '');
    res.json({ me: clientUser(user), orders: store.userOrders(user.id).map(clientOrder) });
  });

  app.post('/api/orders', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const s = store.get().settings;
    const rub = Number(req.body.rub);
    const currency = req.body.currency;
    const wallet = String(req.body.wallet || '').trim();
    if (!s.online) return res.status(403).json({ error: 'Обмен временно недоступен' });
    if (!['BTC', 'LTC'].includes(currency)) return res.status(400).json({ error: 'Неизвестная валюта' });
    if (!isFinite(rub) || rub < s.minRub) return res.status(400).json({ error: `Минимальная сумма — ${s.minRub} ₽` });
    if (rub > s.maxRub) return res.status(400).json({ error: `Максимальная сумма — ${s.maxRub} ₽` });
    if (wallet.length < 26 || wallet.length > 128 || /\s/.test(wallet))
      return res.status(400).json({ error: 'Проверьте адрес кошелька' });
    const user = store.touchUser(a.user, req.body.startParam || '');
    const rate = currency === 'BTC' ? s.rateBTC : s.rateLTC;
    const order = store.createOrder({
      userId: String(user.id),
      userName: user.name,
      userUsername: user.username,
      rub,
      currency,
      wallet,
      rate,
      crypto: rub / rate,
      referrer: user.referrer,
    });
    bus.emit('order_event', { order, type: 'new' });
    res.json({ order: clientOrder(order) });
  });

  app.get('/api/order/:id', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    res.json({ order: clientOrder(o) });
  });

  app.post('/api/order/:id/paid', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (o.status === 'details') {
      const upd = store.updateOrder(o.id, { status: 'paid' });
      bus.emit('order_event', { order: upd, type: 'paid' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  app.post('/api/order/:id/cancel', (req, res) => {
    const a = needAuth(req, res);
    if (!a) return;
    const o = store.getOrder(req.params.id);
    if (!o || o.userId !== String(a.user.id)) return res.status(404).json({ error: 'not found' });
    if (['new', 'details'].includes(o.status)) {
      const upd = store.updateOrder(o.id, { status: 'cancelled' });
      bus.emit('order_event', { order: upd, type: 'cancelled' });
      return res.json({ order: clientOrder(upd) });
    }
    res.json({ order: clientOrder(o) });
  });

  // ДЕМО-пульт оператора: существует ТОЛЬКО когда BOT_TOKEN не задан (превью без бота).
  if (!config.botToken) {
    app.post('/api/admin/order/:id/req', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const upd = store.updateOrder(o.id, {
        requisites: req.body.requisites || 'СБП: +7 999 123-45-67\nБанк: Т-Банк\nПолучатель: VEGA OFFICIAL',
        payRub: Number(req.body.payRub) || o.rub,
        status: 'details',
      });
      bus.emit('order_event', { order: upd, type: 'details' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/confirm', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const upd = store.updateOrder(o.id, { status: 'completed' });
      res.json({ order: clientOrder(upd) });
    });
    app.post('/api/admin/order/:id/reject', (req, res) => {
      const o = store.getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'not found' });
      const upd = store.updateOrder(o.id, { status: 'rejected' });
      res.json({ order: clientOrder(upd) });
    });
  }

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[VEGA] веб-сервер запущен на порту ${config.port}`);
  });
}

module.exports = { startWeb };
