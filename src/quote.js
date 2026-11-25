// Согласование суммы по заявке: оператор называет рубль за крипту, клиент
// соглашается или отказывается — сделка продолжается только после согласия.
const store = require('./store');
const bus = require('./bus');

// Оператор называет сумму в рублях: заявка переходит в «quote» и ждёт клиента.
const setQuote = (orderId, rub) =>
  store.updateOrder(Number(orderId), { rub: Number(rub), payRub: Number(rub), status: 'quote' });

// Клиент согласен: заявка возвращается в «new» (ждёт реквизиты), клиент видит сумму.
const acceptQuote = (orderId) => {
  const o = store.getOrder(orderId);
  if (!o || o.status !== 'quote') return null;
  const upd = store.updateOrder(o.id, { status: 'new' });
  bus.emit('order_event', { order: upd, type: 'quote_accepted' });
  return upd;
};

// Клиент не согласен: заявка отменяется, оператор получает уведомление.
const declineQuote = (orderId) => {
  const o = store.getOrder(orderId);
  if (!o || o.status !== 'quote') return null;
  const upd = store.updateOrder(o.id, { status: 'cancelled', cancelReason: 'Клиент не согласился с суммой' });
  bus.emit('order_event', { order: upd, type: 'quote_declined' });
  return upd;
};

module.exports = { setQuote, acceptQuote, declineQuote };
