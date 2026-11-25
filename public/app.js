/* VEGA | Official — клиентское Web App (BTC / LTC / USDT TRC20 / USDT ERC20 + поддержка + tx) */
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
  // dir — выбранное направление (ключ из /api/settings → rates[]).
  // screen — на каком под-экране обмена мы находимся: «picker» (выбор активов) или «form» (форма обмена).
  // sheet — какая шторка открыта (crypto | gift) или null.
  const S = { settings: null, me: null, orders: [], order: null, tab: 'exchange', dir: 'BTC', isDemo: false, calcFrom: 'rub', support: [], mode: 'buy', screen: 'picker', sheet: null };

  // Резервный реестр направлений: нужен, если сервер старой версии не прислал rates.
  const FALLBACK_DIRS = [
    { key: 'BTC', currency: 'BTC', network: null, label: 'BTC', symbol: '₿', coin: 'btc', decimals: 8, display: null, walletHint: 'Адрес BTC-кошелька (bc1… / 1… / 3…)', walletPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$', walletError: 'Проверьте адрес BTC-кошелька — он выглядит некорректно.', rate: null, enabled: true },
    { key: 'LTC', currency: 'LTC', network: null, label: 'LTC', symbol: 'Ł', coin: 'ltc', decimals: 8, display: null, walletHint: 'Адрес LTC-кошелька (ltc1… / L… / M…)', walletPattern: '^(ltc1[a-zA-HJ-NP-Z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$', walletError: 'Проверьте адрес LTC-кошелька — он выглядит некорректно.', rate: null, enabled: true },
    { key: 'USDT_TRC20', currency: 'USDT', network: 'TRC20', label: 'USDT TRC20', symbol: '₮', coin: 'usdt', decimals: 6, display: 2, walletHint: 'Адрес USDT TRC20 (T…, 34 символа)', walletPattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$', walletError: 'Это не похоже на адрес USDT в сети TRC20 — он начинается с T и содержит 34 символа.', networkHint: 'сеть TRON · низкая комиссия, зачисление 1–3 мин', rate: null, enabled: true },
    { key: 'USDT_ERC20', currency: 'USDT', network: 'ERC20', label: 'USDT ERC20', symbol: '₮', coin: 'usdt', decimals: 6, display: 2, walletHint: 'Адрес USDT ERC20 (0x + 40 символов)', walletPattern: '^0x[0-9a-fA-F]{40}$', walletError: 'Это не похоже на адрес USDT в сети ERC20 — нужен 0x и 40 hex-символов.', networkHint: 'сеть Ethereum · высокая комиссия сети, зачисление 5–15 мин', rate: null, enabled: true },
    { key: 'GOOGLE_USD', direction: 'sell', currency: 'GOOGLE_USD', network: null, kind: 'gift', label: 'Google Gift Card', symbol: '🎁', coin: 'google', decimals: 0, display: 0, unit: 'USD', step: 10, minUnits: 10, walletHint: 'Адрес USDT-кошелька (T… или 0x…)', walletPattern: '^(T[1-9A-HJ-NP-Za-km-z]{33}|0x[0-9a-fA-F]{40})$', walletError: 'Укажите адрес USDT: TRC20 начинается с T (34 символа), ERC20 — 0x и 40 hex-символов.', rate: null, enabled: true },
  ];

  // Все направления с итоговым курсом; старый формат settings.rateBTC/LTC тоже поддерживается.
  function dirs() {
    const s = S.settings;
    if (!s) return [];
    if (Array.isArray(s.rates) && s.rates.length) return s.rates;
    return FALLBACK_DIRS.map((d) => ({
      ...d,
      rate: d.key === 'BTC' ? s.rateBTC : d.key === 'LTC' ? s.rateLTC : null,
    }));
  }
  const isGiftDir = (d) => !!d && (d.kind === 'gift' || d.direction === 'sell');
  const available = () => dirs().filter((d) => d.enabled !== false && Number(d.rate) > 0);
  // Направления покупки (₽ → крипта) и продажи (гифт-карта → USDT).
  const buyDirs = () => available().filter((d) => !isGiftDir(d));
  const sellDirs = () => available().filter(isGiftDir);
  const currentSellDir = () => sellDirs()[0] || dirs().find(isGiftDir) || FALLBACK_DIRS[4];

  // Сеть выплаты USDT определяем по адресу клиента.
  function usdtNetworkOf(address) {
    const a = String(address || '').trim();
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return 'TRC20';
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'ERC20';
    return null;
  }
  // Курс USDT своей сети — по нему считаем, сколько USDT получит клиент за карту.
  function usdtRateFor(network) {
    const key = network === 'ERC20' ? 'USDT_ERC20' : 'USDT_TRC20';
    const d = dirs().find((x) => x.key === key);
    return d && Number(d.rate) > 0 ? Number(d.rate) : null;
  }
  // Сколько USDT даём за карту номиналом units $: курс карты (USDT за $1) не зависит от сети.
  function giftPayout(units, network) {
    const dir = isGiftDir(currentDir()) ? currentDir() : currentSellDir();
    const giftRate = Number(dir && dir.rate) || 0;
    if (!(giftRate > 0)) return null;
    // Нужно, чтобы выплата в этой сети была включена и настроена.
    if (!(usdtRateFor(network) > 0)) return null;
    return floorTo((Number(units) || 0) * giftRate, 2);
  }
  function currentDir() {
    const all = dirs();
    return all.find((d) => d.key === S.dir) || available()[0] || all[0] || FALLBACK_DIRS[0];
  }
  // При смене настроек оператором выбранное направление могло исчезнуть — берём доступное.
  function selectDir(key) {
    const all = dirs();
    const want = all.find((d) => d.key === key);
    const dir = want && want.enabled !== false && Number(want.rate) > 0 ? want : available()[0] || want || all[0];
    S.dir = dir ? dir.key : key;
    return S.dir;
  }
  // Точность хранения/округления (USDT — 6, BTC/LTC — 8).
  function decimalsOf(dir) {
    return Number.isFinite(Number(dir.decimals)) ? Number(dir.decimals) : 8;
  }
  // Точность для показа клиенту (USDT — 2 знака, BTC/LTC — 8).
  function displayOf(dir) {
    const d = dir.display;
    return Number.isFinite(Number(d)) && d !== null && d !== undefined ? Number(d) : decimalsOf(dir);
  }
  function dirLabel(o) {
    const d = dirs().find((x) => x.currency === o.currency && (x.network || null) === (o.network || null));
    if (d) return d.label;
    return o.currencyLabel || [o.currency, o.network].filter(Boolean).join(' ');
  }
  const floorTo = (v, dec) => Math.floor(Number(v) * 10 ** dec + 1e-6) / 10 ** dec;
  // Параметры направления по заявке (в заявке хранятся currency + network).
  function dirOfOrder(o) {
    const d = dirs().find((x) => x.currency === o.currency && (x.network || null) === (o.network || null));
    return d || FALLBACK_DIRS.find((x) => x.currency === o.currency && (x.network || null) === (o.network || null)) || { coin: String(o.currency || '').toLowerCase(), symbol: o.currency === 'BTC' ? '₿' : o.currency === 'LTC' ? 'Ł' : '₮', decimals: 8, display: o.currency === 'USDT' ? 2 : 8 };
  }
  const currenciesDecimals = (o) => displayOf(dirOfOrder(o));

  const STATUS = {
    new: { label: 'Подбор реквизитов', color: '#ffb648' },
    details: { label: 'Ожидает оплаты', color: '#38bdf8' },
    paid: { label: 'Подтверждение', color: '#ffb648' },
    completed: { label: 'Завершён', color: '#22e5a2' },
    rejected: { label: 'Отклонён', color: '#ff5470' },
    cancelled: { label: 'Отменён', color: '#8aa0b8' },
  };

  const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
  const fmtRub = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
  // dec — точность из направления (USDT — 2 знака, BTC/LTC — 8); без неё точность по величине.
  const fmtCrypto = (v, cur, dec) => {
    const n = Number(v) || 0;
    const d = Number.isFinite(Number(dec)) && dec !== null ? Number(dec) : n >= 1000 ? 2 : n >= 1 ? 4 : 6;
    const fixed = n.toFixed(d);
    const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
    return (trimmed || '0') + ' ' + cur;
  };
  const cryptoFromRub = (rub, rate, dec = 8) => floorTo((Number(rub) || 0) / rate, dec);
  const rubFromCrypto = (crypto, rate) => Math.ceil(Number(crypto) * rate - 1e-6);
  // Обрезает «хвост» нулей, но не больше precision знаков (USDT — 2).
  const fmtTrim = (v, precision = 8) => {
    const n = Number(v) || 0;
    if (!(n > 0)) return '';
    const d = Math.min(Math.max(Number(precision) || 8, 0), 8);
    return n.toFixed(d).replace(/\.?0+$/, '');
  };
  const fmtRate = (rate) => {
    const n = Number(rate) || 0;
    if (!(n > 0)) return '—';
    const text = n.toFixed(2).replace(/\.?0+$/, '');
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
  };
  const fmtDate = (ts) => {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
    return (n / 1024 / 1024).toFixed(1) + ' МБ';
  };
  let pendingReceipt = null;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(path + sep + q.toString(), {
        method: opts.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: opts.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: opts.method === 'POST' ? JSON.stringify(Object.assign({ initData, demo }, opts.body || {})) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  const ICONS = {
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 15.2c2.6.3 4.4 1.8 5 4.8"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l2-5.5A8.5 8.5 0 0 1 21 11.5Z"/><path d="M8 12h8"/><path d="M8 8h5"/></svg>',
    down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="m6 14 6 6 6-6"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
    bolt: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>',
    left: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    chevDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  };

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
      ['support', 'Чат', ICONS.chat],
      ['info', 'Инфо', ICONS.info],
    ];
    $('#nav').innerHTML = items
      .map(([id, l, ic]) => `<button data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${ic}<span>${l}</span>${id==='support' && S.support.length ? `<span class="badge">${S.support.length>99?'99+':S.support.length}</span>` : ''}</button>`)
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
        if (S.tab === 'support') renderSupport();
        syncTgBack();
      })
    );
  }

  // ---------- Выбор актива: экран «Выбор активов для обмена» + нижние шторки ----------
  // Обмен открывается на экране выбора активов (криптовалюта / подарочные карты).
  // Сам выбор актива — всегда через нижнюю шторку: и для криптовалюты, и для подарочных карт.
  // Пока принимаем только один вид карт — Google Gift Card.
  let sheetCloseTimer = null;
  let sheetFrames = [];
  function sheetRowsFor(kind) {
    return kind === 'gift' ? sellDirs() : buyDirs();
  }
  function renderAssetSheet(kind) {
    const rows = sheetRowsFor(kind);
    const cur = currentDir();
    const $title = $('#sheetTitle');
    if ($title) $title.textContent = kind === 'gift' ? 'Подарочные карты' : 'Криптовалюта';
    const list = $('#sheetList');
    if (!list) return;
    list.innerHTML = rows.length
      ? rows
          .map((d) => {
            const on = d.key === cur.key;
            const sub =
              kind === 'gift'
                ? `1 $ = ${Number(d.rate) || 0} USDT · выплата в USDT`
                : `1 ${d.currency} = ${fmtRate(d.rate)}${d.network ? ' · сеть ' + d.network : ''}`;
            return `<button class="sheet-row${on ? ' on' : ''}" data-key="${esc(d.key)}" role="option" aria-selected="${on ? 'true' : 'false'}">
              <span class="coin-ic ${esc(d.coin)}">${esc(d.symbol)}</span>
              <span class="sheet-row-text"><b>${esc(d.label)}</b><i>${esc(sub)}</i></span>
              <span class="sheet-check">${ICONS.check}</span>
            </button>`;
          })
          .join('')
      : '<div class="sheet-empty">Сейчас нет доступных направлений</div>';
    const foot = $('#sheetFoot');
    if (foot) {
      foot.textContent = kind === 'gift' ? 'Пока принимаем только Google Gift Card — другие карты совсем скоро' : '';
      foot.classList.toggle('hidden', !foot.textContent);
    }
    list.querySelectorAll('.sheet-row').forEach((b) =>
      b.addEventListener('click', () => pickAsset(b.dataset.key))
    );
  }
  function openAssetSheet(kind) {
    S.sheet = kind;
    if (sheetCloseTimer) { clearTimeout(sheetCloseTimer); sheetCloseTimer = null; }
    renderAssetSheet(kind);
    const sheet = $('#assetSheet');
    if (!sheet) return;
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
    // Двойной rAF — чтобы шторка появилась в DOM до запуска слайд-анимации.
    // Кадры отменяем при закрытии, чтобы «открыть и сразу закрыть» не оставляло шторку в подвисшем состоянии.
    sheetFrames = [requestAnimationFrame(() => { sheetFrames[1] = requestAnimationFrame(() => sheet.classList.add('open')); })];
    document.body.classList.add('sheet-lock');
    syncTgBack();
  }
  function closeAssetSheet() {
    S.sheet = null;
    document.body.classList.remove('sheet-lock');
    sheetFrames.forEach((f) => { try { cancelAnimationFrame(f); } catch (e) {} });
    sheetFrames = [];
    const sheet = $('#assetSheet');
    if (!sheet || sheet.classList.contains('hidden')) { syncTgBack(); return; }
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    if (sheetCloseTimer) clearTimeout(sheetCloseTimer);
    sheetCloseTimer = setTimeout(() => sheet.classList.add('hidden'), 320);
    syncTgBack();
  }
  function setScreen(name) {
    S.screen = name;
    const picker = $('#assetPicker');
    const form = $('#assetForm');
    if (picker) picker.classList.toggle('hidden', name !== 'picker');
    if (form) form.classList.toggle('hidden', name !== 'form');
    syncTgBack();
  }
  const goToAssetPicker = () => setScreen('picker');
  function syncAssetChip() {
    const dir = currentDir();
    const ic = $('#chipIc');
    if (ic) { ic.className = 'coin-ic ' + dir.coin; ic.textContent = dir.symbol; }
    const lb = $('#chipLabel');
    if (lb) lb.textContent = dir.label;
  }
  // Курсы/доступность могли измениться, пока форма открыта, — прячем опустевшие группы.
  function syncPickerAvailability() {
    const cryptoEmpty = buyDirs().length === 0;
    const giftEmpty = sellDirs().length === 0;
    const c = document.querySelector('[data-group="crypto"]');
    if (c) c.closest('.picker-group').classList.toggle('hidden', cryptoEmpty);
    const g = document.querySelector('[data-group="gift"]');
    if (g) g.closest('.picker-group').classList.toggle('hidden', giftEmpty);
    const empty = $('#pickerEmpty');
    if (empty) empty.classList.toggle('hidden', !(cryptoEmpty && giftEmpty));
    if (S.sheet) renderAssetSheet(S.sheet);
    syncAssetChip();
  }
  function pickAsset(key) {
    const want = dirs().find((d) => d.key === key);
    if (!want) return;
    S.dir = want.key;
    haptic('medium');
    closeAssetSheet();
    setScreen('form');
    const w = $('#inWallet');
    if (w) w.placeholder = want.walletHint;
    syncAssetChip();
    renderFormMeta();
  }
  // Системная кнопка «назад» в Telegram: закрывает шторку, иначе возвращает к выбору активов.
  function syncTgBack() {
    try {
      if (!tg || !tg.BackButton) return;
      const need = S.tab === 'exchange' && !S.order && (S.screen === 'form' || !!S.sheet);
      if (need) tg.BackButton.show(); else tg.BackButton.hide();
    } catch (e) { /* не-Telegram окружение */ }
  }
  function onTgBackButton() {
    if (S.sheet) { closeAssetSheet(); return; }
    if (S.tab === 'exchange' && S.screen === 'form') goToAssetPicker();
  }

  function renderExchange() {
    const dir = currentDir();
    const sell = currentSellDir();
    const giftOn = sellDirs().length > 0;
    const cryptoOn = buyDirs().length > 0;
    const step = Number(sell && sell.step) || 10;
    const minUnits = Number(sell && sell.minUnits) || step;
    $('#view-exchange').innerHTML = `
      <div id="exForm" class="${S.order ? 'hidden' : ''}">
        <div id="assetPicker" role="region" aria-label="Выбор активов для обмена">
          <div class="picker-head">
            <div class="picker-title">Выбор активов для обмена</div>
            <div class="picker-sub">Выберите, чем торгуем: криптовалюта или подарочная карта — откроется форма обмена.</div>
          </div>
          ${cryptoOn ? `
          <div class="picker-group">
            <div class="picker-group-label">КРИПТОВАЛЮТА</div>
            <button class="group-card" data-group="crypto">
              <span class="coin-ic btc group-ic">₿</span>
              <span class="group-text"><b>Криптовалюта</b><i>BTC · LTC · USDT TRC20 / ERC20</i></span>
              <span class="group-chev">${ICONS.right}</span>
            </button>
          </div>` : ''}
          ${giftOn ? `
          <div class="picker-group">
            <div class="picker-group-label">ПОДАРОЧНЫЕ КАРТЫ</div>
            <button class="group-card" data-group="gift">
              <span class="coin-ic google group-ic">🎁</span>
              <span class="group-text"><b>Подарочные карты</b><i>Google Gift Card — выплата в USDT</i></span>
              <span class="group-chev">${ICONS.right}</span>
            </button>
          </div>` : ''}
          <div class="picker-empty${cryptoOn || giftOn ? ' hidden' : ''}" id="pickerEmpty">Направления временно недоступны.<br>Загляните чуть позже.</div>
        </div>
        <div id="assetForm" class="hidden">
          <div class="form-topbar">
            <button class="back-btn" id="btnBackToAssets">${ICONS.left}<span>Выбор активов</span></button>
            <button class="asset-chip" id="assetChip" aria-label="Сменить актив">
              <span class="coin-ic ${esc(dir.coin)}" id="chipIc">${esc(dir.symbol)}</span>
              <span class="asset-chip-label" id="chipLabel">${esc(dir.label)}</span>
              ${ICONS.chevDown}
            </button>
          </div>
          <div id="buyForm">
          <div class="card">
            <div class="card-title">Направление обмена</div>
            <div class="f-label"><span>Вы отдаёте</span><span id="mmLabel"></span></div>
            <div class="f-box"><div class="coin-ic rub">₽</div><input id="inRub" type="number" inputmode="decimal" placeholder="5 000" min="0" step="any"></div>
            <div class="f-sep"><div class="arr">${ICONS.down}</div></div>
            <div class="f-label"><span>Вы получаете</span><span id="cryptoLimits"></span></div>
            <div id="netPick"></div>
            <div class="f-box" style="margin-top:10px"><div class="coin-ic" id="getIc">${esc(dir.symbol)}</div><input id="inCrypto" type="number" inputmode="decimal" placeholder="0.0005" min="0" step="any"></div>
            <div class="f-hint">Введите сумму в любом поле — второе посчитается автоматически</div>
            <div class="f-meta" id="fMeta"></div>
          </div>
          <div class="card">
            <div class="card-title">Кошелёк получателя</div>
            <div class="f-box"><div class="coin-ic" id="walIc">${esc(dir.symbol)}</div><input id="inWallet" placeholder="${esc(dir.walletHint)}" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"></div>
            <div class="f-hint" id="walHint"></div>
            <div class="f-err" id="fErr"></div>
          </div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnGo">${ICONS.bolt}<span>Найти реквизиты</span></button>
        </div>
        <div id="giftForm" class="hidden">
          <div class="card">
            <div class="card-title">Google Gift Card</div>
            <div class="f-label"><span>Номинал карты</span><span id="giftRule"></span></div>
            <div class="seg gift-nom" id="segNom"></div>
            <div class="f-box" style="margin-top:10px"><div class="coin-ic google">🎁</div><input id="inUnits" type="number" inputmode="numeric" placeholder="10" min="${minUnits}" step="${step}" value="10"></div>
            <div class="f-hint">Введите номинал карты: от $${minUnits}, кратно $${step}</div>
            <div class="f-sep"><div class="arr">${ICONS.down}</div></div>
            <div class="f-label"><span>Вы получаете</span><span id="giftLimits"></span></div>
            <div class="f-box"><div class="coin-ic usdt">₮</div><input id="outUsdt" type="text" readonly placeholder="—"></div>
            <div class="f-meta" id="giftMeta"></div>
            <div class="info-note" style="margin-top:10px">⏱ На сделку даётся <b>1 час</b>: пришлите код, нажмите «Я оплатил» — оператор проверит карту и выплатит USDT.</div>
          </div>
          <div class="card">
            <div class="card-title">Где взять карту</div>
            <div class="info-note" id="giftInfo">Карту можно купить на любом маркетплейсе — Яндекс Маркет, Ozon, Wildberries и т. д. Выбирайте карту именно в <b>USD</b> (долларах): карты в рублях и других валютах не принимаются.</div>
            <div class="info-warn">⚠️ Проверьте валюту карты: нужен номинал в <b>USD ($)</b>.</div>
          </div>
          <div class="card">
            <div class="card-title">Код карты</div>
            <div class="f-box"><div class="coin-ic google">🎁</div><input id="inGiftCode" placeholder="Например: XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="off"></div>
            <div class="f-hint">Код видит только оператор — он проверит карту и выплатит USDT</div>
            <div class="f-err" id="giftCodeErr"></div>
          </div>
          <div class="card">
            <div class="card-title">Кошелёк для выплаты USDT</div>
            <div class="f-box"><div class="coin-ic usdt">₮</div><input id="inUsdtWallet" placeholder="T… (TRC20) или 0x… (ERC20)" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"></div>
            <div class="f-hint" id="giftNetHint">Сеть определим по адресу: TRC20 начинается с T, ERC20 — с 0x</div>
            <div class="f-err" id="giftErr"></div>
          </div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnSell">${ICONS.bolt}<span>Обменять карту на USDT</span></button>
        </div>
        </div>
      </div>
      <div id="exOrder" class="${S.order ? '' : 'hidden'}"></div>
    `;

    // Выбор актива: группы на экране выбора → нижние шторки (криптовалюта / подарочные карты).
    $('#assetPicker').querySelectorAll('[data-group]').forEach((b) =>
      b.addEventListener('click', () => {
        haptic('light');
        openAssetSheet(b.dataset.group);
      })
    );
    $('#btnBackToAssets').addEventListener('click', () => { haptic('light'); goToAssetPicker(); });
    $('#assetChip').addEventListener('click', () => {
      haptic('light');
      openAssetSheet(isGiftDir(currentDir()) ? 'gift' : 'crypto');
    });
    $('#inRub').addEventListener('input', () => { S.calcFrom = 'rub'; renderFormMeta(); });
    $('#inCrypto').addEventListener('input', () => { S.calcFrom = 'crypto'; renderFormMeta(); });
    $('#btnGo').addEventListener('click', submitOrder);

    if (giftOn) {
      $('#segNom').innerHTML = [10, 20, 50, 100]
        .map((v) => `<button data-v="${v}" class="${v === 10 ? 'on' : ''}">$${v}</button>`)
        .join('');
      $('#segNom').querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          $('#inUnits').value = b.dataset.v;
          haptic('light');
          $('#segNom').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          renderFormMeta();
        })
      );
      const unitsInput = $('#inUnits');
      unitsInput.addEventListener('input', () => {
        // Номинал кратен $10: ввод 37 превращаем в 30.
        const n = Math.floor((Number(unitsInput.value) || 0) / step) * step;
        $('#segNom').querySelectorAll('button').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) === n));
        renderFormMeta();
      });
      unitsInput.addEventListener('blur', () => {
        const n = Math.max(minUnits, Math.floor((Number(unitsInput.value) || 0) / step) * step);
        unitsInput.value = String(n);
        renderFormMeta();
      });
      $('#inUsdtWallet').addEventListener('input', renderFormMeta);
      $('#inGiftCode').addEventListener('input', () => {
        const e = $('#giftCodeErr');
        if (e) e.textContent = '';
      });
      $('#btnSell').addEventListener('click', submitGiftOrder);
    }
    setScreen(S.screen || 'picker');
    syncAssetChip();
    renderFormMeta();
    renderOrderStage();
  }

  function renderFormMeta() {
    const s = S.settings;
    if (!s) return;
    const dir = currentDir();
    const rate = Number(dir.rate);
    const dec = displayOf(dir);
    const all = available();
    syncPickerAvailability();
    // Гифт-карта — отдельная форма: номинал в $ → USDT, без полей рублей и курса.
    const giftMode = isGiftDir(dir);
    if ($('#buyForm')) $('#buyForm').classList.toggle('hidden', giftMode);
    if ($('#giftForm')) $('#giftForm').classList.toggle('hidden', !giftMode);
    if (giftMode) return renderGiftMeta();
    // Выбранное направление выключили — переключаемся на доступное.
    if (!rate || dir.enabled === false) {
      if (all.length) {
        S.dir = all[0].key;
        return renderFormMeta();
      }
      const btn0 = $('#btnGo');
      if (btn0) {
        btn0.disabled = true;
        btn0.querySelector('span').textContent = '⛔ Направления временно недоступны';
      }
      return;
    }
    const inRub = $('#inRub');
    const inCrypto = $('#inCrypto');
    if (inRub && inCrypto) {
      if (S.calcFrom === 'crypto') {
        const c = parseFloat(inCrypto.value);
        inRub.value = c > 0 ? String(rubFromCrypto(c, rate)) : '';
      } else {
        const rub = parseFloat(inRub.value);
        inCrypto.value = rub > 0 ? fmtTrim(cryptoFromRub(rub, rate, dec), dec) : '';
      }
    }
    $('#mmLabel').textContent = `от ${fmtRub(s.minRub)} до ${fmtRub(s.maxRub)}`;
    const cl = $('#cryptoLimits');
    if (cl) cl.textContent = `≈ ${fmtTrim(s.minRub / rate, dec)}–${fmtTrim(s.maxRub / rate, dec)} ${dir.currency}`;
    const ic = $('#getIc');
    if (ic) { ic.className = 'coin-ic ' + dir.coin; ic.textContent = dir.symbol; }
    const wi = $('#walIc');
    if (wi) { wi.className = 'coin-ic ' + dir.coin; wi.textContent = dir.symbol; }
    const w = $('#inWallet');
    if (w) w.placeholder = dir.walletHint;
    const np = $('#netPick');
    if (np) {
      np.innerHTML = dir.network && dir.networkHint
        ? `<div class="net-note"><b>${esc(dir.label)}</b> · ${esc(dir.networkHint)}</div>`
        : '';
    }
    const wh = $('#walHint');
    if (wh) wh.textContent = dir.network
      ? `⚠️ Выплата только в сети ${dir.network}. Адрес из другой сети приведёт к потере средств.`
      : '';
    $('#fMeta').innerHTML = `
      <div class="row"><span>Курс</span><b>1 ${esc(dir.currency)} = ${fmtRate(rate)}</b></div>
      ${dir.network ? `<div class="row"><span>Сеть</span><b>${esc(dir.network)}</b></div>` : ''}
      ${s.rateUpdatedAt ? `<div class="row"><span>Курс обновлён</span><b>${fmtDate(s.rateUpdatedAt)}</b></div>` : ''}
      <div class="row"><span>Обработкой занимается</span><b>оператор VEGA</b></div>`;
    const btn = $('#btnGo');
    btn.disabled = !s.online;
    btn.querySelector('span').textContent = s.online ? 'Найти реквизиты' : '⛔ Обмен временно недоступен';
  }

  // Гифт-карта: номинал в $ → сколько USDT получим и в какой сети.
  function renderGiftMeta() {
    const units = $('#inUnits');
    if (!units) return;
    const s = S.settings;
    const dir = isGiftDir(currentDir()) ? currentDir() : currentSellDir();
    const step = Number(dir && dir.step) || 10;
    const minUnits = Number(dir && dir.minUnits) || step;
    const rate = Number(dir && dir.rate) || 0;
    const nominal = Math.max(0, Math.floor((Number(units.value) || 0) / step) * step);
    const wallet = ($('#inUsdtWallet') && $('#inUsdtWallet').value) || '';
    const network = usdtNetworkOf(wallet);
    const payout = network ? giftPayout(nominal, network) : giftPayout(nominal, 'TRC20');
    const out = $('#outUsdt');
    const amount = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
    if (out) {
      // Показываем ровную цену: $10 → 8.5 USDT (без лишних нулей).
      out.value = nominal && payout
        ? `${amount(payout)} USDT${network ? ' · ' + network : ''}`
        : '—';
    }
    const rule = $('#giftRule');
    if (rule) rule.textContent = `от $${minUnits} · кратно $${step}`;
    const info = $('#giftInfo');
    if (info && dir && dir.infoNote) info.innerHTML = esc(dir.infoNote).replace(/USD/g, '<b>USD</b>').replace(/Яндекс Маркет/, '<b>Яндекс Маркет</b>');
    const limits = $('#giftLimits');
    if (limits) {
      limits.textContent = rate
        ? `${rate} USDT за $1 номинала`
        : 'направление недоступно';
    }
    const hint = $('#giftNetHint');
    if (hint) {
      const trc = usdtRateFor('TRC20');
      const erc = usdtRateFor('ERC20');
      hint.textContent = network
        ? `Сеть ${network}: выплата ${payout ? amount(payout) : '—'} USDT за $${nominal}`
        : `Сеть определим по адресу: TRC20 (${trc ? fmtRate(trc) : '—'}) · ERC20 (${erc ? fmtRate(erc) : '—'})`;
    }
    const meta = $('#giftMeta');
    if (meta) {
      meta.innerHTML = `
        <div class="row"><span>Номинал карты</span><b>$${nominal}</b></div>
        <div class="row"><span>Курс</span><b>1 $ = ${rate ? rate + ' USDT' : '—'}</b></div>
        ${network ? `<div class="row"><span>Сеть выплаты</span><b>${esc(network)}</b></div>` : ''}
        <div class="row"><span>К выплате</span><b>${payout ? amount(payout) + ' USDT' : '—'}</b></div>`;
    }
    const btn = $('#btnSell');
    if (btn) {
      btn.disabled = !s.online || !rate;
      btn.querySelector('span').textContent = s.online ? 'Продать карту' : '⛔ Обмен временно недоступен';
    }
  }

  async function submitGiftOrder() {
    const s = S.settings;
    const err = $('#giftErr');
    const codeErr = $('#giftCodeErr');
    err.textContent = '';
    codeErr.textContent = '';
    const dir = isGiftDir(currentDir()) ? currentDir() : currentSellDir();
    const step = Number(dir && dir.step) || 10;
    const minUnits = Number(dir && dir.minUnits) || step;
    const units = Math.floor((Number($('#inUnits').value) || 0) / step) * step;
    const giftCode = ($('#inGiftCode').value || '').trim();
    const wallet = ($('#inUsdtWallet').value || '').trim();
    const network = usdtNetworkOf(wallet);
    if (!s.online) return (err.textContent = '⛔ Обмен временно недоступен — загляните позже.');
    if (!(Number(dir.rate) > 0)) return (err.textContent = 'Продажа карт сейчас недоступна.');
    if (!units || units < minUnits) return (err.textContent = `Минимальный номинал — $${minUnits}, сумма кратна $${step}.`);
    if (giftCode.length < 8) return (codeErr.textContent = 'Введите полный код карты (не менее 8 символов).');
    if (!network) return (err.textContent = 'Укажите адрес USDT: TRC20 начинается с T, ERC20 — с 0x (40 hex).');
    const payout = giftPayout(units, network);
    if (!(payout > 0)) return (err.textContent = 'Не удалось рассчитать выплату — проверьте адрес и номинал.');
    const btn = $('#btnSell');
    btn.disabled = true;
    haptic('medium');
    try {
      const r = await api('/api/orders', {
        method: 'POST',
        body: { units, giftCode, wallet, currency: 'GOOGLE_USD', startParam },
      });
      S.order = r.order;
      S.orders.unshift(r.order);
      haptic('heavy');
      $('#exForm').classList.add('hidden');
      $('#exOrder').classList.remove('hidden');
      renderOrderStage();
      toast('Код принят — нажмите «Я оплатил»');
    } catch (e) {
      err.textContent = e.message;
      toast(e.message);
    } finally {
      renderGiftMeta();
    }
  }

  async function submitOrder() {
    const s = S.settings;
    const err = $('#fErr');
    err.textContent = '';
    const dir = currentDir();
    const rate = Number(dir.rate);
    const dec = displayOf(dir);
    if (!(rate > 0)) return (err.textContent = 'Это направление сейчас недоступно — выберите другое.');
    const rawRub = parseFloat($('#inRub').value);
    const rawCrypto = parseFloat($('#inCrypto').value);
    const useCrypto = S.calcFrom === 'crypto' && isFinite(rawCrypto) && rawCrypto > 0;
    const cryptoAmount = useCrypto ? rawCrypto : null;
    const rub = useCrypto ? rubFromCrypto(rawCrypto, rate) : rawRub;
    const wallet = ($('#inWallet').value || '').trim();
    const limits = (v) => `${fmtTrim(cryptoFromRub(v, rate, dec), dec)} ${dir.currency}`;
    if (!s.online) return (err.textContent = '⛔ Обмен временно недоступен — загляните позже.');
    if (!isFinite(rub) || rub < s.minRub) return (err.textContent = `Минимальная сумма обмена — ${fmtRub(s.minRub)} (≈ ${limits(s.minRub)}).`);
    if (rub > s.maxRub) return (err.textContent = `Максимальная сумма обмена — ${fmtRub(s.maxRub)} (≈ ${limits(s.maxRub)}).`);
    let re = null;
    try { re = new RegExp(dir.walletPattern); } catch (e) { re = null; }
    if (re ? !re.test(wallet) : !/^[a-zA-Z0-9]{26,90}$/.test(wallet)) {
      return (err.textContent = dir.walletError || 'Проверьте адрес кошелька — он выглядит некорректно.');
    }
    const btn = $('#btnGo');
    btn.disabled = true;
    haptic('medium');
    try {
      const common = { currency: dir.currency, network: dir.network || undefined, wallet, startParam };
      const body = useCrypto ? { cryptoAmount, ...common } : { rub, ...common };
      const r = await api('/api/orders', { method: 'POST', body });
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

  function chip(st) {
    const m = STATUS[st] || { label: st, color: '#8aa0b8' };
    return `<span class="chip" style="color:${m.color};background:${m.color}1a;border:1px solid ${m.color}55">${m.label}</span>`;
  }

  // Гифт-заявка: клиент отдал код карты и ждёт выплату USDT.
  const isGiftOrder = (o) => !!o && (o.direction === 'sell' || o.currency === 'GOOGLE_USD');
  const giftNominal = (o) => Number(o.units) || 0;

  // Сколько осталось до конца срока (1 час на сделку).
  function timeLeft(expiresAt) {
    const left = Number(expiresAt) - Date.now();
    if (!(left > 0)) return null;
    const m = Math.floor(left / 60000);
    const sLeft = Math.floor((left % 60000) / 1000);
    return m >= 60 ? `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин` : `${m}:${String(sLeft).padStart(2, '0')}`;
  }
  const ttlText = (o) => {
    const left = timeLeft(o.expiresAt);
    return left ? `⏳ На сделку осталось <b>${left}</b>` : '⏳ Срок на сделку истёк';
  };

  function renderGiftStage(o) {
    const box = $('#exOrder');
    const payout = `${fmtCrypto(o.crypto, 'USDT', 2)} (${o.network || 'USDT'})`;
    if (o.status === 'new') {
      // Клиент прислал код → подтверждает оплату → оператор проверяет карту.
      box.innerHTML = `
        <div class="card stage">
          ${chip('details')}
          <div class="pay-dir">${ICONS.swap}<span>🎁 Google Gift Card <b>$${giftNominal(o)}</b> → ${payout}</span></div>
          <div class="stage-title">Подтвердите передачу карты</div>
          <div class="stage-sub">Заявка <b>#${o.id}</b>. Проверьте код — он уйдёт оператору, как только вы нажмёте «Я оплатил».</div>
          <div class="req-box" id="giftCodeBox">Код карты: ${esc(o.giftCode || '—')}</div>
          <div class="copy-row">
            <button class="btn btn-ghost btn-sm" id="cpGift">${ICONS.copy}<span>Копировать код</span></button>
          </div>
          <div class="note">${ttlText(o)}<br>После «Я оплатил» оператор проверит карту и выплатит ${payout}.</div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnGiftPaid">${ICONS.check}<span>Я оплатил</span></button>
          <button class="btn btn-ghost" style="margin-top:8px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#cpGift').addEventListener('click', () => copyText(o.giftCode || '', 'Код скопирован'));
      $('#btnGiftPaid').addEventListener('click', async () => {
        haptic('medium');
        await changeOrder(o, 'paid');
        const now = S.order;
        if (now && now.id === o.id && now.status === 'paid') {
          toast('Код отправлен на проверку ✅');
          renderOrderStage();
        }
      });
      $('#btnCancel').addEventListener('click', async () => { haptic('light'); await changeOrder(o, 'cancel'); });
      return true;
    }
    if (o.status === 'paid') {
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">🔎</div></div>
          <div class="stage-title">Карта на проверке</div>
          <div class="stage-sub">Оператор проверяет Google Gift Card на <b>$${giftNominal(o)}</b> и валюту (<b>USD</b>).<br>Как только всё подтвердится — пришлём ${payout} на ваш кошелёк. Обычно 5–15 минут.</div>
          <div class="req-box">Код карты: ${esc(o.giftCode || '—')}</div>
          <div class="note">Не передавайте код никому, кроме поддержки VEGA. Если карта окажется недействительной — заявка будет отклонена.</div>
        </div>`;
      return true;
    }
    if (o.status === 'completed') {
      box.innerHTML = `
        <div class="card stage">
          <svg class="okmark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="41"/><path d="M32 51l13 13 24-27"/></svg>
          <div class="stage-title">Карта принята — USDT выплачен</div>
          <div class="stage-sub">Google Gift Card $${giftNominal(o)} → <b>${payout}</b><br>отправлены на ваш кошелёк. Спасибо, что выбираете VEGA ✦</div>
          ${o.txUrl ? `
            <div class="tx-box">
              <div class="tx-label">🔗 Транзакция в блокчейне</div>
              <a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a>
              <button class="btn btn-ghost btn-sm" style="margin-top:10px" id="cpTx">${ICONS.copy}<span>Копировать ссылку</span></button>
            </div>` : `<div class="note" style="margin-top:12px">Выплата отправлена вручную. Ссылка на транзакцию появится здесь, если оператор её добавит.</div>`}
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новая заявка</button>
        </div>`;
      const cpTx = $('#cpTx');
      if (cpTx) cpTx.addEventListener('click', () => copyText(o.txUrl, 'Ссылка скопирована'));
      $('#btnNew').addEventListener('click', resetToForm);
      return true;
    }
    if (o.status === 'rejected' || o.status === 'cancelled') {
      const rej = o.status === 'rejected';
      const expired = o.cancelReason === 'Срок на сделку истёк';
      box.innerHTML = `
        <div class="card stage">
          <div class="failmark">${rej ? '🔴' : '⚪'}</div>
          <div class="stage-title">${rej ? 'Карта не принята' : expired ? 'Срок на сделку истёк' : 'Заявка отменена'}</div>
          <div class="stage-sub">${rej ? 'Оператор не смог подтвердить карту по заявке #' + o.id + '. Проверьте код или напишите в поддержку.' : expired ? 'На сделку даётся 1 час. Создайте новую заявку с тем же кодом карты.' : 'Вы отменили заявку #' + o.id + '.'}</div>
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новая заявка</button>
        </div>`;
      $('#btnNew').addEventListener('click', resetToForm);
      return true;
    }
    return false;
  }

  function renderOrderStage() {
    syncTgBack();
    const box = $('#exOrder');
    const o = S.order;
    if (!box) return;
    if (!o) { box.innerHTML = ''; return; }
    if (isGiftOrder(o) && renderGiftStage(o)) return;
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
        await changeOrder(o, 'cancel');
      });
    } else if (o.status === 'details') {
      box.innerHTML = `
        <div class="card stage">
          ${chip('details')}
          <div class="pay-dir">${ICONS.swap}<span>₽ → <b>${esc(dirLabel(o))}</b> · ${fmtCrypto(o.crypto, o.currency, currenciesDecimals(o))}</span></div>
          <div class="pay-amount"><div class="l">Переведите точно</div><div class="v">${fmtRub(o.payRub || o.rub)}</div></div>
          <div class="req-box" id="reqBox">${esc(o.requisites || 'Реквизиты готовятся…')}</div>
          <div class="copy-row">
            <button class="btn btn-ghost btn-sm" id="cpSum">${ICONS.copy}<span>Сумма</span></button>
            <button class="btn btn-ghost btn-sm" id="cpReq">${ICONS.copy}<span>Реквизиты</span></button>
          </div>
          <div class="file-box">
            <input type="file" id="inReceipt" accept=".pdf,application/pdf" hidden>
            <button class="btn btn-ghost btn-sm" id="btnPick">📎 <span>${o.receipt ? 'Заменить чек (PDF)' : 'Прикрепить чек (PDF)'}</span></button>
            <div class="file-name ${o.receipt ? 'ok' : ''}" id="fileName">${o.receipt ? `✅ ${esc(o.receipt.name)} (${fmtSize(o.receipt.size)})` : 'Без чека оплата не подтвердится'}</div>
          </div>
          <div class="note">Переведите <b>точную сумму</b> по реквизитам выше, прикрепите <b>чек в PDF</b>, затем нажмите кнопку ниже. После подтверждения оператор отправит ${fmtCrypto(o.crypto, o.currency, currenciesDecimals(o))} на ваш кошелёк.</div>
          <button class="btn btn-primary" style="margin-top:14px" id="btnPaid">${ICONS.check}<span>Я оплатил</span></button>
          <button class="btn btn-ghost" style="margin-top:8px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#cpSum').addEventListener('click', () => copyText(String(Math.round(o.payRub || o.rub)), 'Сумма скопирована'));
      $('#cpReq').addEventListener('click', () => copyText(o.requisites || '', 'Реквизиты скопированы'));
      wireReceiptPicker(o);
      $('#btnPaid').addEventListener('click', async () => {
        haptic('medium');
        await confirmPaidWithReceipt(o);
      });
      $('#btnCancel').addEventListener('click', async () => {
        haptic('light');
        await changeOrder(o, 'cancel');
      });
    } else if (o.status === 'paid') {
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">⏳</div></div>
          <div class="stage-title">Подтверждаем оплату</div>
          <div class="stage-sub">Оператор проверяет поступление ${fmtRub(o.payRub || o.rub)} по заявке <b>#${o.id}</b>.<br>Как только платёж подтвердится — мы отправим ${fmtCrypto(o.crypto, o.currency, currenciesDecimals(o))}.</div>
          ${o.receipt
            ? `<div class="note">🧾 Чек <b>${esc(o.receipt.name)}</b> отправлен оператору ✅</div>`
            : `<div class="file-box">
                 <input type="file" id="inReceipt" accept=".pdf,application/pdf" hidden>
                 <button class="btn btn-ghost btn-sm" id="btnPick">📎 <span>Выбрать чек (PDF)</span></button>
                 <div class="file-name" id="fileName">⚠️ Чек не прикреплён — без него оператор не подтвердит оплату</div>
                 <button class="btn btn-primary btn-sm" style="width:100%" id="btnSendReceipt">Отправить чек</button>
               </div>`}
        </div>`;
      if (!o.receipt) {
        wireReceiptPicker(o);
        $('#btnSendReceipt').addEventListener('click', async () => {
          const picked = pendingReceipt && pendingReceipt.orderId === o.id ? pendingReceipt.file : null;
          if (!picked) return toast('📎 Сначала выберите чек в формате PDF');
          const btn = $('#btnSendReceipt');
          btn.disabled = true;
          haptic('medium');
          try {
            const updated = await uploadReceipt(o, picked);
            pendingReceipt = null;
            S.order = updated;
            const i = S.orders.findIndex((x) => x.id === updated.id);
            if (i >= 0) S.orders[i] = updated;
            toast('Чек отправлен оператору ✅');
            renderOrderStage();
          } catch (e) {
            toast(e.message || 'Не удалось отправить чек');
            btn.disabled = false;
          }
        });
      }
    } else if (o.status === 'completed') {
      box.innerHTML = `
        <div class="card stage">
          <svg class="okmark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="41"/><path d="M32 51l13 13 24-27"/></svg>
          <div class="stage-title">Обмен завершён!</div>
          <div class="stage-sub">${fmtRub(o.payRub || o.rub)} → <b>${fmtCrypto(o.crypto, o.currency, currenciesDecimals(o))}</b> (${esc(dirLabel(o))})<br>отправлены на ваш кошелёк. Спасибо, что выбираете VEGA ✦</div>
          ${o.txUrl ? `
            <div class="tx-box">
              <div class="tx-label">🔗 Транзакция в блокчейне</div>
              <a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a>
              <button class="btn btn-ghost btn-sm" style="margin-top:10px" id="cpTx">${ICONS.copy}<span>Копировать ссылку</span></button>
            </div>
          ` : `<div class="note" style="margin-top:12px">Оператор отправит средства вручную. Ссылка на блокчейн появится здесь, если оператор её добавит.</div>`}
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Новый обмен</button>
        </div>`;
      const cpTx = $('#cpTx');
      if (cpTx) cpTx.addEventListener('click', () => copyText(o.txUrl, 'Ссылка скопирована'));
      $('#btnNew').addEventListener('click', resetToForm);
    } else {
      const rej = o.status === 'rejected';
      box.innerHTML = `
        <div class="card stage">
          <div class="failmark">${rej ? '🔴' : '⚪'}</div>
          <div class="stage-title">${rej ? 'Заявка отклонена' : 'Заявка отменена'}</div>
          <div class="stage-sub">${rej ? 'Оператор отклонил заявку #' + o.id + '. Если это ошибка — напишите в поддержку.' : 'Вы отменили заявку #' + o.id + '.'}</div>
          ${o.txUrl ? `<div class="tx-box"><div class="tx-label">🔗 Блокчейн</div><a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a></div>` : ''}
          <button class="btn btn-primary" style="margin-top:18px" id="btnNew">Создать заявку</button>
        </div>`;
      $('#btnNew').addEventListener('click', resetToForm);
    }
  }

  function wireReceiptPicker(o) {
    $('#btnPick').addEventListener('click', () => { haptic('light'); $('#inReceipt').click(); });
    $('#inReceipt').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('Нужен файл в формате PDF'); e.target.value = ''; return; }
      if (f.size > 8 * 1024 * 1024) { toast('PDF должен весить до 8 МБ'); e.target.value = ''; return; }
      pendingReceipt = { orderId: o.id, file: f };
      haptic('light');
      const fn = $('#fileName');
      if (fn) { fn.textContent = `📎 ${f.name} (${fmtSize(f.size)})`; fn.classList.remove('ok'); }
    });
    const picked = pendingReceipt && pendingReceipt.orderId === o.id ? pendingReceipt.file : null;
    if (picked && !o.receipt) {
      const fn = $('#fileName');
      if (fn) fn.textContent = `📎 ${picked.name} (${fmtSize(picked.size)})`;
    }
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || '');
        const idx = s.indexOf(',');
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      };
      r.onerror = () => reject(new Error('Не удалось прочитать файл'));
      r.readAsDataURL(file);
    });
  }

  async function uploadReceipt(order, file) {
    const base64 = await readAsBase64(file);
    const r = await api(`/api/order/${order.id}/receipt`, {
      method: 'POST',
      body: { filename: file.name, data: base64 },
    });
    return r.order;
  }

  async function confirmPaidWithReceipt(order) {
    const btn = $('#btnPaid');
    const label = btn && btn.querySelector('span');
    try {
      let current = S.order && S.order.id === order.id ? S.order : order;
      if (!current.receipt) {
        const picked = pendingReceipt && pendingReceipt.orderId === order.id ? pendingReceipt.file : null;
        if (!picked) {
          toast('📎 Сначала прикрепите чек в формате PDF');
          return;
        }
        if (btn) { btn.disabled = true; if (label) label.textContent = 'Отправляем чек…'; }
        current = await uploadReceipt(order, picked);
        pendingReceipt = null;
        S.order = current;
        const i = S.orders.findIndex((x) => x.id === current.id);
        if (i >= 0) S.orders[i] = current; else S.orders.unshift(current);
        if (label) label.textContent = 'Подтверждаем…';
      }
      await changeOrder(current, 'paid');
    } catch (e) {
      toast(e.message || 'Не удалось отправить. Проверьте связь и повторите.');
      renderOrderStage();
    }
  }

  async function changeOrder(order, action) {
    try {
      const r = await api(`/api/order/${order.id}/${action}`, { method: 'POST' });
      if (S.order?.id !== order.id) return;
      S.order = r.order;
      syncStatus();
      renderOrderStage();
    } catch (e) {
      toast('Не удалось отправить действие. Проверьте связь и повторите.');
    }
  }

  function resetToForm() {
    S.order = null;
    haptic('light');
    $('#exOrder').classList.add('hidden');
    $('#exForm').classList.remove('hidden');
    closeAssetSheet();
    setScreen('picker');
    renderOrderStage();
    syncTgBack();
  }

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
        <div class="card h-item" data-order="${o.id}" role="button" tabindex="0">
          <div class="h-ic ${esc(dirOfOrder(o).coin)}">${esc(dirOfOrder(o).symbol)}${o.network ? `<small>${esc(o.network === 'TRC20' ? 'TRC' : 'ERC')}</small>` : ''}</div>
          <div class="h-main">
            ${isGiftOrder(o)
              ? `<div class="h-top"><span>🎁 $${giftNominal(o)} карта → USDT</span><span>${fmtCrypto(o.crypto, 'USDT', 2)}</span></div>`
              : `<div class="h-top"><span>₽ → ${esc(dirLabel(o))}</span><span>${fmtRub(o.payRub || o.rub)}</span></div>`}
            <div class="h-sub"><span>#${o.id}${o.receipt ? ' 🧾' : ''}${o.txUrl ? ' 🔗' : ''} · ${fmtDate(o.createdAt)}</span>${chip(o.status)}</div>
            <div class="h-sub" style="margin-top:2px"><span>${esc(o.wallet.slice(0, 10) + '…' + o.wallet.slice(-6))}</span><b style="color:#9fd8ff">${fmtCrypto(o.crypto, o.currency, currenciesDecimals(o))}</b></div>
            ${o.txUrl ? `<div class="h-sub" style="margin-top:6px"><a href="${esc(o.txUrl)}" target="_blank" rel="noopener" style="color:var(--teal);font-size:11px;word-break:break-all">🔗 ${esc(o.txUrl.slice(0,50))}…</a></div>` : ''}
          </div>
        </div>`
        )
        .join('');
    // Клик по записи открывает карточку заявки — в том числе завершённой или истёкшей.
    v.querySelectorAll('[data-order]').forEach((el) =>
      el.addEventListener('click', () => openOrderFromHistory(Number(el.dataset.order)))
    );
  }

  // Открывает заявку из истории в карточке на вкладке «Обмен».
  function openOrderFromHistory(id) {
    const order = S.orders.find((o) => o.id === id);
    if (!order) return;
    S.order = order;
    S.tab = 'exchange';
    haptic('light');
    document.querySelectorAll('.view').forEach((vv) => vv.classList.add('hidden'));
    $('#view-exchange').classList.remove('hidden');
    renderNav();
    if (S.order) {
      if ($('#exForm')) $('#exForm').classList.add('hidden');
      if ($('#exOrder')) $('#exOrder').classList.remove('hidden');
    }
    renderOrderStage();
  }

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

  function renderInfo() {
    const s = S.settings;
    const opLink = 'https://t.me/' + String(s.operator || '').replace(/^@/, '');
    $('#view-info').innerHTML = `
      <div class="card">
        <div class="about"><b>VEGA</b> — современный сервис обмена Bitcoin, Litecoin и USDT (TRC20/ERC20). Честность, скорость и выгодные условия: мы создали сервис, которым удобно пользоваться каждый день.</div>
        <div class="feat">
          <div class="f"><span class="i">✅</span>Выгодный курс — максимум за каждый обмен</div>
          <div class="f"><span class="i">✅</span>Фиксированная сумма к оплате — известна заранее, без доплат</div>
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
      <div class="card">
        <div class="card-title">Поддержка в приложении</div>
        <div class="about" style="font-size:12.5px;line-height:1.6">Напишите нам прямо здесь — отвечаем в реальном времени. Перейдите во вкладку <b>Чат</b> в нижнем меню.</div>
        <button class="btn btn-ghost" style="margin-top:10px" id="goSupport">${ICONS.chat}<span>Открыть чат поддержки</span></button>
      </div>
      <div class="card"><div class="about" style="text-align:center;color:var(--mut);font-size:11.5px">VEGA — быстро. Надёжно. Выгодно. ✦</div></div>`;
    const go = $('#goSupport');
    if (go) go.addEventListener('click', () => {
      S.tab = 'support';
      document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
      $('#view-support').classList.remove('hidden');
      renderNav();
      renderSupport();
    });
  }

  /* ---------- поддержка чат ---------- */
  function renderSupport() {
    const v = $('#view-support');
    v.innerHTML = `
      <div class="card">
        <div class="card-title">Чат поддержки</div>
        <div class="about" style="font-size:12px;color:var(--mut);margin-bottom:10px">Задайте вопрос оператору — отвечаем в реальном времени. Обычно отвечаем за 1–3 минуты.</div>
        <div class="chat-box" id="chatBox">
          <div class="chat-empty" id="chatEmpty"><div class="e-ic">💬</div>Напишите сообщение — мы на связи 24/7</div>
          <div class="chat-list" id="chatList"></div>
        </div>
        <div class="chat-input">
          <textarea id="chatInput" placeholder="Напишите сообщение..." rows="1" maxlength="2000"></textarea>
          <button class="btn btn-primary btn-sm" id="btnSendChat">${ICONS.send}</button>
        </div>
        <div class="f-hint" style="margin-top:8px">Поддержка отвечает в этом чате и в Telegram. Не делитесь приватными ключами.</div>
      </div>
    `;
    const input = $('#chatInput');
    const sendBtn = $('#btnSendChat');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendSupportMessage();
      }
    });
    sendBtn.addEventListener('click', sendSupportMessage);
    renderSupportMessages();
    pollSupport(true);
  }

  function renderSupportMessages() {
    const list = $('#chatList');
    const empty = $('#chatEmpty');
    if (!list) return;
    if (!S.support.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = S.support.map((m) => {
      const isMe = m.from === 'user';
      return `<div class="msg ${isMe ? 'me' : 'them'}"><div class="msg-bubble">${esc(m.text).replace(/\n/g,'<br>')}</div><div class="msg-time">${fmtDate(m.at)} · ${isMe ? 'Вы' : 'Поддержка'}</div></div>`;
    }).join('');
    const box = $('#chatBox');
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function sendSupportMessage() {
    const input = $('#chatInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 2000) return toast('Сообщение слишком длинное');
    input.value = '';
    input.style.height = 'auto';
    const btn = $('#btnSendChat');
    if (btn) btn.disabled = true;
    haptic('light');
    try {
      const r = await api('/api/support/message', { method: 'POST', body: { text, startParam } });
      S.support.push(r.message);
      renderSupportMessages();
      renderNav();
    } catch (e) {
      toast(e.message || 'Не удалось отправить');
      input.value = text;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function pollSupport(force = false) {
    if (!force && S.tab !== 'support') return;
    try {
      const { messages } = await api('/api/support/messages');
      if (JSON.stringify(messages) !== JSON.stringify(S.support)) {
        S.support = messages;
        if (S.tab === 'support') renderSupportMessages();
        renderNav();
      }
    } catch (e) {
      // silent
    }
  }

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
      if (o.status === 'new' && isGiftOrder(o)) {
        // Демо: карта «проверена» — сразу завершаем и показываем выплату USDT.
        const r = await api(`/api/admin/order/${o.id}/confirm`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор проверил карту и выплатил USDT (демо)');
      } else if (o.status === 'new') {
        const r = await api(`/api/admin/order/${o.id}/req`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор выдал реквизиты (демо)');
      } else if (o.status === 'paid') {
        const r = await api(`/api/admin/order/${o.id}/confirm`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор подтвердил оплату (демо)');
      } else if (o.status === 'completed') {
        const url = prompt('Ссылка на блокчейн (опционально):', o.txUrl || 'https://blockchair.com/bitcoin/transaction/');
        if (url) {
          const r = await api(`/api/admin/order/${o.id}/tx`, { method: 'POST', body: { txUrl: url } });
          S.order = r.order;
          renderOrderStage();
          toast('Ссылка сохранена (демо)');
        }
      } else if (o.status === 'details') {
        toast('Теперь клиент жмёт «Я оплатил»');
      } else {
        toast('Заявка уже в финальном статусе');
      }
    };
  }

  function syncStatus(message = '') {
    $('#syncStatus').textContent = message;
    $('#syncStatus').classList.toggle('hidden', !message);
  }

  async function pollOrder() {
    const current = S.order;
    if (!current || TERMINAL.includes(current.status)) {
      // even if terminal, we still want to catch txUrl updates
      if (current && current.status === 'completed') {
        try {
          const { order } = await api('/api/order/' + current.id);
          if (S.order !== current) return;
          if (JSON.stringify(order) !== JSON.stringify(current)) {
            S.order = order;
            const i = S.orders.findIndex((o) => o.id === order.id);
            if (i >= 0) S.orders[i] = order; else S.orders.unshift(order);
            renderOrderStage();
          }
        } catch {}
      }
      return syncStatus();
    }
    try {
      const { order } = await api('/api/order/' + current.id);
      if (S.order !== current) return;
      syncStatus();
      if (JSON.stringify(order) !== JSON.stringify(current)) {
        S.order = order;
        const i = S.orders.findIndex((o) => o.id === order.id);
        if (i >= 0) S.orders[i] = order; else S.orders.unshift(order);
        renderOrderStage();
        if (order.status === 'completed') haptic('heavy');
      }
    } catch (e) {
      if (S.order === current) syncStatus('⚠️ Не удалось обновить заявку. Восстанавливаем связь автоматически…');
    }
  }

  async function pollSettings() {
    const s = await api('/api/settings');
    if (JSON.stringify(s) !== JSON.stringify(S.settings)) {
      S.settings = s;
      renderHeader();
      renderAnnounce();
      renderFormMeta();
      if (S.tab === 'refs') renderRefs();
      if (S.tab === 'info') renderInfo();
    }
  }

  async function pollProfile() {
    if (S.tab !== 'history' && S.tab !== 'refs') return;
    const m = await api('/api/me');
    S.orders = m.orders;
    S.me = m.me;
    if (!S.order) {
      const act = S.orders.find((o) => !TERMINAL.includes(o.status));
      if (act) {
        S.order = act;
        $('#exForm').classList.add('hidden');
        $('#exOrder').classList.remove('hidden');
        renderOrderStage();
      }
    }
    if (S.tab === 'history') renderHistory();
    else if (S.tab === 'refs') renderRefs();
  }

  function startPolling() {
    const running = new Set();
    const refresh = () => Promise.all([pollOrder, pollSettings, pollProfile, () => pollSupport(false)].map(async (poll) => {
      if (typeof poll !== 'function') return;
      if (running.has(poll)) return;
      running.add(poll);
      try { await poll(); }
      catch (e) { console.warn('[VEGA] Обновление не удалось:', e.message); }
      finally { running.delete(poll); }
    }));
    setInterval(refresh, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', refresh);
    if (tg && tg.onEvent) tg.onEvent('activated', refresh);
  }

  // Системная кнопка «назад» в Telegram и Escape на внешней клавиатуре.
  if (tg && tg.BackButton && tg.BackButton.onClick) {
    try { tg.BackButton.onClick(onTgBackButton); } catch (e) { /* старые клиенты */ }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.sheet) closeAssetSheet();
  });
  // Нижняя шторка выбора актива — разовая привязка (она в index.html, вне #view-exchange).
  const sheetCloseBtn = $('#sheetClose');
  if (sheetCloseBtn) sheetCloseBtn.addEventListener('click', () => { haptic('light'); closeAssetSheet(); });
  const sheetOverlay = $('#sheetOverlay');
  if (sheetOverlay) sheetOverlay.addEventListener('click', closeAssetSheet);

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
      // preload support
      try {
        const sup = await api('/api/support/messages');
        S.support = sup.messages || [];
      } catch {}
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
    renderSupport();
    renderInfo();
    // show correct initial tab
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + S.tab).classList.remove('hidden');
    renderDemoAdmin();
    startPolling();
  })();
})();
