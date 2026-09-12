/* VEGA | Official — клиентское Web App (BTC & LTC обмен) */
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  let initData = '';
  let startParam = '';
  let demo = null;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor && tg.setHeaderColor('#02070f');
      tg.setBackgroundColor && tg.setBackgroundColor('#02070f');
    } catch (e) {}
    initData = tg.initData || '';
    startParam = tg.startParam || '';
  }
  if (!initData) {
    try {
      demo = JSON.parse(localStorage.getItem('vega_demo') || 'null');
      if (!demo) {
        demo = { id: 900000 + Math.floor(Math.random() * 99999), name: 'Гость' };
        localStorage.setItem('vega_demo', JSON.stringify(demo));
      }
    } catch (e) {
      demo = { id: 900001, name: 'Гость' };
    }
  }

  const $ = (s) => document.querySelector(s);
  const TERMINAL = ['completed', 'rejected', 'cancelled'];
  const S = { settings: null, me: null, orders: [], order: null, tab: 'exchange', currency: 'BTC', isDemo: false };

  const STATUS = {
    new: { label: 'Подбор реквизитов', color: '#ffb648' },
    details: { label: 'Ожидает оплаты', color: '#38bdf8' },
    paid: { label: 'Подтверждение', color: '#ffb648' },
    completed: { label: 'Завершён', color: '#22e5a2' },
    rejected: { label: 'Отклонён', color: '#ff5470' },
    cancelled: { label: 'Отменён', color: '#8aa0b8' },
  };

  /* ---------- утилиты ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtRub = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
  const fmtCrypto = (v, cur) => {
    const n = Number(v) || 0;
    const dec = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
    return n.toFixed(dec) + ' ' + cur;
  };
  const fmtDate = (ts) => {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const haptic = (t) => { try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(t || 'light'); } catch (e) {} };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copyText(t, msg) {
    try {
      await navigator.clipboard.writeText(t);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    haptic('light');
    toast(msg || 'Скопировано');
  }

  async function api(path, opts = {}) {
    const q = new URLSearchParams(opts.query || {});
    if (initData) q.set('initData', initData);
    else if (demo) { q.set('demo[id]', demo.id); q.set('demo[name]', demo.name); }
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(path + sep + q.toString(), {
      method: opts.method || 'GET',
      headers: opts.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: opts.method === 'POST' ? JSON.stringify(Object.assign({ initData, demo }, opts.body || {})) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    return data;
  }

  const ICONS = {
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 15.2c2.6.3 4.4 1.8 5 4.8"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
    down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="m6 14 6 6 6-6"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
    bolt: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  };

  /* ---------- шапка / объявление / навигация ---------- */
  function renderHeader() {
    const s = S.settings;
    let html = s.online
      ? '<span class="pill"><span class="dot"></span>ОНЛАЙН</span>'
      : '<span class="pill off"><span class="dot"></span>ОФФЛАЙН</span>';
    if (S.isDemo) html += ' <span class="pill demo">ДЕМО</span>';
    $('#hdrStatus').innerHTML = html;
  }

  function renderAnnounce() {
    const el = $('#announce');
    const t = S.settings && S.settings.announcement;
    el.classList.toggle('hidden', !t);
    el.textContent = t || '';
  }

  function renderNav() {
    const items = [
      ['exchange', 'Обмен', ICONS.swap],
      ['history', 'История', ICONS.clock],
      ['refs', 'Рефералы', ICONS.users],
      ['info', 'Инфо', ICONS.info],
    ];
    $('#nav').innerHTML = items
      .map(([id, l, ic]) => `<button data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${ic}<span>${l}</span></button>`)
      .join('');
    $('#nav').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        if (S.tab === b.dataset.tab) return;
        S.tab = b.dataset.tab;
        haptic('light');
        document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
        $('#view-' + S.tab).classList.remove('hidden');
        renderNav();
        if (S.tab === 'history') renderHistory();
        if (S.tab === 'refs') renderRefs();
        if (S.tab === 'info') renderInfo();
      })
    );
  }

  /* ---------- обмен: форма ---------- */
  function renderExchange() {
    $('#view-exchange').innerHTML = `
      <div id="exForm" class="${S.order ? 'hidden' : ''}">
        <div class="card">
          <div class="card-title">Направление обмена</div>
          <div class="f-label"><span>Вы отдаёте</span><span id="mmLabel"></span></div>
          <div class="f-box"><div class="coin-ic rub">₽</div><input id="inRub" type="number" inputmode="decimal" placeholder="5 000" min="0"></div>
          <div class="f-sep"><div class="arr">${ICONS.down}</div></div>
          <div class="f-label"><span>Вы получаете</span></div>
          <div class="seg" id="segCur">
            <button data-c="BTC" class="${S.currency === 'BTC' ? 'on' : ''}">₿&nbsp;BTC</button>
            <button data-c="LTC" class="${S.currency === 'LTC' ? 'on' : ''}">Ł&nbsp;LTC</button>
          </div>
          <div class="f-get" style="margin-top:10px"><div class="coin-ic" id="getIc">₿</div><div class="val" id="getVal">0 BTC</div></div>
          <div class="f-meta" id="fMeta"></div>
        </div>
        <div class="card">
          <div class="card-title">Кошелёк получателя</div>
          <div class="f-box"><div class="coin-ic" id="walIc">₿</div><input id="inWallet" placeholder="Адрес BTC-кошелька" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"></div>
          <div class="f-err" id="fErr"></div>
        </div>
        <button class="btn btn-primary" style="margin-top:14px" id="btnGo">${ICONS.bolt}<span>Найти реквизиты</span></button>
      </div>
      <div id="exOrder" class="${S.order ? '' : 'hidden'}"></div>
    `;
    $('#segCur').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        S.currency = b.dataset.c;
        haptic('light');
        $('#segCur').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        renderFormMeta();
      })
    );
    $('#inRub').addEventListener('input', renderFormMeta);
    $('#btnGo').addEventListener('click', submitOrder);
    renderFormMeta();
    renderOrderStage();
  }

  function renderFormMeta() {
    const s = S.settings;
    if (!s) return;
    const cur = S.currency;
    const rate = cur === 'BTC' ? s.rateBTC : s.rateLTC;
    const rub = parseFloat($('#inRub') && $('#inRub').value) || 0;
    $('#mmLabel').textContent = `от ${fmtRub(s.minRub)} до ${fmtRub(s.maxRub)}`;
    $('#getVal').textContent = rub > 0 ? '≈ ' + fmtCrypto(rub / rate, cur) : '0 ' + cur;
    const ic = $('#getIc');
    ic.className = 'coin-ic ' + cur.toLowerCase();
    ic.textContent = cur === 'BTC' ? '₿' : 'Ł';
    const wi = $('#walIc');
    wi.className = 'coin-ic ' + cur.toLowerCase();
    wi.textContent = cur === 'BTC' ? '₿' : 'Ł';
    $('#inWallet').placeholder = cur === 'BTC' ? 'Адрес BTC-кошелька (bc1… / 1… / 3…)' : 'Адрес LTC-кошелька (ltc1… / L… / M…)';
    $('#fMeta').innerHTML = `
      <div class="row"><span>Курс</span><b>1 ${cur} = ${fmtRub(rate)}</b></div>
      <div class="row"><span>Комиссия сервиса</span><b>0 ₽</b></div>
      <div class="row"><span>Обработкой занимается</span><b>оператор VEGA</b></div>`;
    const btn = $('#btnGo');
    btn.disabled = !s.online;
    btn.querySelector('span').textContent = s.online ? 'Найти реквизиты' : '⛔ Обмен временно недоступен';
  }

  async function submitOrder() {
    const s = S.settings;
    const err = $('#fErr');
    err.textContent = '';
    const rub = parseFloat($('#inRub').value);
    const wallet = ($('#inWallet').value || '').trim();
    if (!s.online) return (err.textContent = '⛔ Обмен временно недоступен — загляните позже.');
    if (!isFinite(rub) || rub < s.minRub) return (err.textContent = `Минимальная сумма обмена — ${fmtRub(s.minRub)}.`);
    if (rub > s.maxRub) return (err.textContent = `Максимальная сумма обмена — ${fmtRub(s.maxRub)}.`);
    if (!/^[a-zA-Z0-9]{26,90}$/.test(wallet)) return (err.textContent = 'Проверьте адрес кошелька — он выглядит некорректно.');
    const btn = $('#btnGo');
    btn.disabled = true;
    haptic('medium');
    try {
      const r = await api('/api/orders', { method: 'POST', body: { rub, currency: S.currency, wallet, startParam } });
      S.order = r.order;
      S.orders.unshift(r.order);
      haptic('heavy');
      $('#exForm').classList.add('hidden');
      $('#exOrder').classList.remove('hidden');
      renderOrderStage();
    } catch (e) {
      err.textContent = e.message;
      toast(e.message);
    } finally {
      btn.disabled = !S.settings.online;
    }
  }

  /* ---------- обмен: жизненный цикл заявки ---------- */
  function chip(st) {
    const m = STATUS[st] || { label: st, color: '#8aa0b8' };
    return `<span class="chip" style="color:${m.color};background:${m.color}1a;border:1px solid ${m.color}55">${m.label}</span>`;
  }

  function renderOrderStage() {
    const box = $('#exOrder');
    const o = S.order;
    if (!box) return;
    if (!o) { box.innerHTML = ''; return; }
    if (o.status === 'new') {
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">🔍</div></div>
          <div class="stage-title">Ищем реквизиты для оплаты</div>
          <div class="stage-sub">Заявка <b>#${o.id}</b> передана оператору.<br>Обычно это занимает меньше минуты — не закрывайте приложение.</div>
          <button class="btn btn-ghost" style="margin-top:18px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#btnCancel').addEventListener('click', async () => {
        haptic('light');
        const r = await api(`/api/order/${o.id}/cancel`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
      });
    } else if (o.status === 'details') {
      box.innerHTML = `
        <div class="card stage">
          ${chip('details')}
          <div class="pay-amount"><div class="l">Переведите точно</div><div class="v">${fmtRub(o.payRub || o.rub)}</div></div>
          <div class="req-box" id="reqBox">${esc(o.requisites || 'Реквизиты готовятся…')}</div>
          <div class="copy-row">
            <button class="btn btn-ghost btn-sm" id="cpSum">${ICONS.copy}<span>Сумма</span></button>
            <button class="btn btn-ghost btn-sm" id="cpReq">${ICONS.copy}<span>Реквизиты</span></button>
          </div>
          <div class="note">Переведите <b>точную сумму</b> по реквизитам выше, затем нажмите кнопку ниже. После подтверждения оператор отправит ${fmtCrypto(o.crypto, o.currency)} на ваш кошелёк.</div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnPaid">${ICONS.check}<span>Я оплатил</span></button>
          <button class="btn btn-ghost" style="margin-top:8px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#cpSum').addEventListener('click', () => copyText(String(Math.round(o.payRub || o.rub)), 'Сумма скопирована'));
      $('#cpReq').addEventListener('click', () => copyText(o.requisites || '', 'Реквизиты скопированы'));
      $('#btnPaid').addEventListener('click', async () => {
        haptic('medium');
        const r = await api(`/api/order/${o.id}/paid`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
      });
      $('#btnCancel').addEventListener('click', async () => {
        haptic('light');
        const r = await api(`/api/order/${o.id}/cancel`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
      });
    } else if (o.status === 'paid') {
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">⏳</div></div>
          <div class="stage-title">Подтверждаем оплату</div>
          <div class="stage-sub">Оператор проверяет поступление ${fmtRub(o.payRub || o.rub)} по заявке <b>#${o.id}</b>.<br>Как только платёж подтвердится — мы отправим ${fmtCrypto(o.crypto, o.currency)}.</div>
        </div>`;
    } else if (o.status === 'completed') {
      box.innerHTML = `
        <div class="card stage">
          <svg class="okmark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="41"/><path d="M32 51l13 13 24-27"/></svg>
          <div class="stage-title">Обмен завершён!</div>
          <div class="stage-sub">${fmtRub(o.payRub || o.rub)} → <b>${fmtCrypto(o.crypto, o.currency)}</b><br>отправлены на ваш кошелёк. Спасибо, что выбираете VEGA ✦</div>
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новый обмен</button>
        </div>`;
      $('#btnNew').addEventListener('click', resetToForm);
    } else {
      const rej = o.status === 'rejected';
      box.innerHTML = `
        <div class="card stage">
          <div class="failmark">${rej ? '🔴' : '⚪'}</div>
          <div class="stage-title">${rej ? 'Заявка отклонена' : 'Заявка отменена'}</div>
          <div class="stage-sub">${rej ? 'Оператор отклонил заявку #' + o.id + '. Если это ошибка — напишите в поддержку.' : 'Вы отменили заявку #' + o.id + '.'}</div>
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Создать заявку</button>
        </div>`;
      $('#btnNew').addEventListener('click', resetToForm);
    }
  }

  function resetToForm() {
    S.order = null;
    haptic('light');
    $('#exOrder').classList.add('hidden');
    $('#exForm').classList.remove('hidden');
    renderOrderStage();
  }

  /* ---------- история ---------- */
  function renderHistory() {
    const v = $('#view-history');
    if (!S.orders.length) {
      v.innerHTML = `<div class="card"><div class="empty"><div class="e-ic">🗂</div>История пока пуста.<br>Совершите первый обмен — он появится здесь.</div></div>`;
      return;
    }
    v.innerHTML =
      `<div class="card-title" style="padding:2px 4px 10px">История обменов</div>` +
      S.orders
        .map(
          (o) => `
        <div class="card h-item">
          <div class="h-ic ${o.currency.toLowerCase()}">${o.currency === 'BTC' ? '₿' : 'Ł'}</div>
          <div class="h-main">
            <div class="h-top"><span>₽ → ${o.currency}</span><span>${fmtRub(o.payRub || o.rub)}</span></div>
            <div class="h-sub"><span>#${o.id} · ${fmtDate(o.createdAt)}</span>${chip(o.status)}</div>
            <div class="h-sub" style="margin-top:2px"><span>${esc(o.wallet.slice(0, 10) + '…' + o.wallet.slice(-6))}</span><b style="color:#9fd8ff">${fmtCrypto(o.crypto, o.currency)}</b></div>
          </div>
        </div>`
        )
        .join('');
  }

  /* ---------- рефералы ---------- */
  function renderRefs() {
    const s = S.settings;
    const v = $('#view-refs');
    const link = s.botUsername ? `https://t.me/${s.botUsername}?startapp=ref${S.me.id}` : null;
    v.innerHTML = `
      <div class="card">
        <div class="card-title">Реферальная программа</div>
        ${
          link
            ? `<div class="ref-link" id="refLink">${esc(link)}</div>
               <button class="btn btn-primary" style="margin-top:10px" id="cpRef">${ICONS.copy}<span>Скопировать ссылку</span></button>`
            : `<div class="empty">Реферальная ссылка появится после подключения бота.</div>`
        }
        <div class="ref-stats">
          <div class="ref-stat"><div class="v">${S.me.referredCount || 0}</div><div class="l">приглашено</div></div>
          <div class="ref-stat"><div class="v">${s.refPercent}%</div><div class="l">бонус с обмена</div></div>
        </div>
        <div class="steps">
          <div class="step"><div class="n">1</div>Отправьте ссылку другу — она закрепит его за вами навсегда.</div>
          <div class="step"><div class="n">2</div>Друг совершает обмен в VEGA через ваше приложение.</div>
          <div class="step"><div class="n">3</div>Вы получаете ${s.refPercent}% с каждого его обмена — без лимитов.</div>
        </div>
      </div>`;
    const cp = $('#cpRef');
    if (cp) cp.addEventListener('click', () => copyText(link, 'Ссылка скопирована'));
  }

  /* ---------- инфо ---------- */
  function renderInfo() {
    const s = S.settings;
    const opLink = 'https://t.me/' + String(s.operator || '').replace(/^@/, '');
    $('#view-info').innerHTML = `
      <div class="card">
        <div class="about"><b>VEGA</b> — современный сервис обмена Bitcoin и Litecoin. Честность, скорость и выгодные условия: мы создали сервис, которым удобно пользоваться каждый день.</div>
        <div class="feat">
          <div class="f"><span class="i">✅</span>Выгодный курс — максимум за каждый обмен</div>
          <div class="f"><span class="i">✅</span>Минимальные комиссии, без скрытых платежей</div>
          <div class="f"><span class="i">✅</span>Быстрые сделки и живая поддержка оператора</div>
          <div class="f"><span class="i">✅</span>Безопасность каждой операции</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Связь с нами</div>
        <div class="contacts">
          <a class="contact" href="${esc(opLink)}" target="_blank" rel="noopener"><span class="ci">🧩</span><span>Оператор<small>${esc(s.operator)}</small></span></a>
          <a class="contact" href="${esc(s.channel)}" target="_blank" rel="noopener"><span class="ci">📣</span><span>Официальный канал<small>новости и курсы</small></span></a>
          <a class="contact" href="${esc(s.chat)}" target="_blank" rel="noopener"><span class="ci">💬</span><span>Чат поддержки<small>отвечаем быстро</small></span></a>
        </div>
      </div>
      <div class="card"><div class="about" style="text-align:center;color:var(--mut);font-size:11.5px">VEGA — быстро. Надёжно. Выгодно. ✦</div></div>`;
  }

  /* ---------- демо-пульт оператора (только без бота) ---------- */
  function renderDemoAdmin() {
    if (!S.isDemo) return;
    let el = $('#demoAdmin');
    if (!el) {
      el = document.createElement('button');
      el.id = 'demoAdmin';
      el.className = 'demo-admin';
      el.innerHTML = '🛠 <span>оператор</span>';
      document.body.appendChild(el);
    }
    el.onclick = async () => {
      if (!S.order) return toast('Сначала создайте заявку на обмен');
      const o = S.order;
      haptic('medium');
      if (o.status === 'new') {
        const r = await api(`/api/admin/order/${o.id}/req`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор выдал реквизиты (демо)');
      } else if (o.status === 'paid') {
        const r = await api(`/api/admin/order/${o.id}/confirm`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор подтвердил оплату (демо)');
      } else if (o.status === 'details') {
        toast('Теперь клиент жмёт «Я оплатил»');
      } else {
        toast('Заявка уже в финальном статусе');
      }
    };
  }

  /* ---------- поллинг: всё в реальном времени ---------- */
  function startPolling() {
    setInterval(async () => {
      try {
        const s = await api('/api/settings');
        if (JSON.stringify(s) !== JSON.stringify(S.settings)) {
          S.settings = s;
          renderHeader();
          renderAnnounce();
          renderFormMeta();
          if (S.tab === 'refs') renderRefs();
        }
        if (S.order && !TERMINAL.includes(S.order.status)) {
          const r = await api('/api/order/' + S.order.id);
          if (JSON.stringify(r.order) !== JSON.stringify(S.order)) {
            const was = S.order.status;
            S.order = r.order;
            const i = S.orders.findIndex((o) => o.id === r.order.id);
            if (i >= 0) S.orders[i] = r.order; else S.orders.unshift(r.order);
            renderOrderStage();
            if (r.order.status === 'completed' && was !== 'completed') haptic('heavy');
          }
        }
        if (S.tab === 'history' || S.tab === 'refs') {
          const m = await api('/api/me');
          S.orders = m.orders;
          S.me = m.me;
          if (!S.order) {
            const act = S.orders.find((o) => !TERMINAL.includes(o.status));
            if (act) { S.order = act; $('#exForm').classList.add('hidden'); $('#exOrder').classList.remove('hidden'); renderOrderStage(); }
          }
          if (S.tab === 'history') renderHistory(); else renderRefs();
        }
      } catch (e) {}
    }, 3000);
  }

  /* ---------- старт ---------- */
  (async () => {
    try {
      const r = await api('/api/init', { method: 'POST', body: { startParam } });
      S.settings = r.settings;
      S.me = r.me;
      S.isDemo = !!r.demo;
      const m = await api('/api/me');
      S.orders = m.orders;
      S.me = m.me;
      S.order = S.orders.find((o) => !TERMINAL.includes(o.status)) || null;
    } catch (e) {
      document.getElementById('announce').textContent = '⚠️ Не удалось подключиться к серверу. Обновите страницу.';
      return;
    }
    renderHeader();
    renderAnnounce();
    renderNav();
    renderExchange();
    renderHistory();
    renderRefs();
    renderInfo();
    renderDemoAdmin();
    startPolling();
  })();
})();
