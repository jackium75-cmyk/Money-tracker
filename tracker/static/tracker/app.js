/* Money Tracker — single-page app. Everything updates in place: no page loads. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = $('[name=csrfmiddlewaretoken]').value;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON = MONTHS.map(m => m.slice(0, 3));
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n, exact) => (exact && Math.round(n) !== n ? nf2 : nf0).format(n || 0);
  const cur = () => S.lists?.currency || 'KES';
  const money = (n, { exact = true, sign = false } = {}) => {
    const s = `${cur()} ${num(Math.abs(n), exact)}`;
    if (n < 0) return `−${s}`;
    return sign && n > 0 ? `+${s}` : s;
  };
  const pct = (n, d = 0) => `${((n || 0) * 100).toFixed(d)}%`;

  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmtDate = (s, withDow = false) => {
    if (!s) return '';
    const d = parseISO(s);
    const base = `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
    return withDow ? `${DOW[(d.getDay() + 6) % 7]} ${base}` : base;
  };
  const fmtTime = t => {
    if (!t) return '';
    let [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${pad(m)} ${ap}`;
  };
  const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const monthRange = (y, m) => [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
  const statusClass = s => ({ 'OK': 'OK', 'Watch': 'Watch', 'OVER': 'OVER', 'No budget': 'nobudget' }[s] || '');
  const pill = s => s && s !== '-' ? `<span class="pill ${statusClass(s)}">${esc(s)}</span>` : '<span class="muted">–</span>';
  const chip = (name, icon, color) => name
    ? `<span class="chip" style="--c:${esc(color)}"><span class="ic">${esc(icon)}</span><span class="truncate">${esc(name)}</span></span>`
    : '<span class="chip" style="--c:#cbd5e1"><span class="ic">❔</span>Uncategorised</span>';
  const bar = (p, status, pace) => `<div class="bar ${statusClass(status)}"><i style="width:${Math.min(Math.max(p, 0), 1) * 100}%"></i>${pace != null ? `<span class="pace" style="left:${Math.min(pace, 1) * 100}%" title="Where you should be today"></span>` : ''}</div>`;
  const opts = (items, sel, empty) => (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
    items.map(o => `<option value="${o.id}" ${String(o.id) === String(sel ?? '') ? 'selected' : ''}>${o.icon ? esc(o.icon) + ' ' : ''}${esc(o.name)}</option>`).join('');
  const active = list => list.filter(o => !o.archived);
  const catById = id => S.lists.categories.find(c => c.id === id);

  // ------------------------------------------------------------------ state
  const now = new Date();
  const S = {
    lists: null, rev: 0, today: iso(now),
    year: now.getFullYear(), month: now.getMonth() + 1,
    view: 'dashboard', charts: [], soft: false,
    tx: { filters: {}, sort: '-date', rows: [], meta: null, selected: new Set(), showMore: false, range: 'month' },
    inc: { filters: {}, sort: '-date', rows: [], meta: null, range: 'month' },
    yearSel: now.getFullYear(),
  };

  // ------------------------------------------------------------------ api + live sync
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('money-tracker') : null;

  async function api(path, { method = 'GET', body, form } = {}) {
    const init = { method, headers: { 'X-CSRFToken': csrf, 'Accept': 'application/json' }, credentials: 'same-origin' };
    if (form) init.body = form;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(path, init); } catch (e) { setLive('off'); throw Object.assign(new Error('You appear to be offline'), { offline: true }); }
    if (res.redirected && res.url.includes('/login')) { location.href = res.url; return new Promise(() => {}); }
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-json */ }
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { field: data.field, status: res.status });
    setLive('on');
    if (data.revision !== undefined) {
      if (method !== 'GET') {
        S.rev = data.revision;
        channel?.postMessage({ rev: S.rev });
      }
    }
    return data;
  }

  function setLive(state) {
    const el = $('#live');
    el.classList.toggle('off', state === 'off');
    el.classList.toggle('sync', state === 'sync');
    $('#live-text').textContent = state === 'off' ? 'Offline – retrying' : state === 'sync' ? 'Syncing…' : 'Live';
  }

  async function pullChanges(fromOther) {
    setLive('sync');
    await loadLists();
    await refresh();
    setLive('on');
    if (fromOther) toast('🔄 Updated with changes from another tab/device');
  }

  channel && (channel.onmessage = e => { if (e.data?.rev > S.rev) { S.rev = e.data.rev; pullChanges(true); } });

  async function poll() {
    if (document.hidden) return;
    try {
      const { revision } = await fetch('/api/sync', { credentials: 'same-origin' }).then(r => r.json());
      setLive('on');
      if (revision > S.rev) { S.rev = revision; pullChanges(true); }
    } catch (e) { setLive('off'); }
  }
  setInterval(poll, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('online', poll);

  async function loadLists() {
    S.lists = await api('/api/lists');
    S.rev = Math.max(S.rev, S.lists.revision);
  }

  /** Call after any change made in this tab: lists + current view re-render softly. */
  async function changed({ lists = false } = {}) {
    if (lists) await loadLists();
    await refresh();
  }

  // ------------------------------------------------------------------ toasts / drawer / modal
  function toast(msg, { undo, error, ms = 4200 } = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (error ? ' err' : '');
    el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>Undo</button>' : ''}`;
    $('#toasts').appendChild(el);
    const kill = () => el.remove();
    if (undo) el.querySelector('button').onclick = async () => { kill(); await undo(); };
    setTimeout(kill, undo ? 7000 : ms);
  }
  const fail = e => toast(e.message || 'Something went wrong', { error: true });

  function showScrim(on) { $('#scrim').classList.toggle('on', on); }
  function openDrawer(html) {
    $('#drawer-body').innerHTML = html;
    $('#drawer').classList.add('on');
    $('#drawer').setAttribute('aria-hidden', 'false');
    showScrim(true);
    $('#drawer-body').scrollTop = 0;
    return $('#drawer-body');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('on');
    $('#drawer').setAttribute('aria-hidden', 'true');
    if (!$('#modal-wrap').classList.contains('on')) showScrim(false);
    S.drawerRefresh = null;
  }
  function openModal(html) {
    $('#modal').innerHTML = html;
    $('#modal-wrap').classList.add('on');
    showScrim(true);
    setTimeout(() => $('#modal [autofocus]')?.focus(), 30);
    return $('#modal');
  }
  function closeModal() {
    $('#modal-wrap').classList.remove('on');
    if (!$('#drawer').classList.contains('on')) showScrim(false);
  }
  $('#scrim').onclick = () => { closeModal(); closeDrawer(); $('.sidebar').classList.remove('open'); };
  $('#modal-wrap').addEventListener('mousedown', e => { if (e.target.id === 'modal-wrap') closeModal(); });
  document.addEventListener('click', e => {
    if (e.target.closest('[data-close-drawer]')) closeDrawer();
    if (e.target.closest('[data-close-modal]')) closeModal();
  });

  function markInvalid(form, err) {
    $$('.invalid', form).forEach(x => x.classList.remove('invalid'));
    $$('.field-err', form).forEach(x => x.remove());
    const input = err.field && form.querySelector(`[name="${err.field}"]`);
    if (input) {
      input.classList.add('invalid');
      input.insertAdjacentHTML('afterend', `<small class="field-err">${esc(err.message)}</small>`);
      input.focus();
    } else fail(err);
  }
  const formData = form => Object.fromEntries(new FormData(form).entries());

  /** Auto-save each field as soon as it changes (the "no Save button" editing used in drawers). */
  function autosave(form, url, onSaved) {
    const hint = form.querySelector('.saved-hint');
    const send = async el => {
      const value = el.type === 'checkbox' ? el.checked : el.value;
      try {
        const res = await api(url, { method: 'PATCH', body: { [el.name]: value } });
        el.classList.remove('invalid');
        el.nextElementSibling?.classList.contains('field-err') && el.nextElementSibling.remove();
        if (hint) { hint.classList.add('on'); clearTimeout(hint._t); hint._t = setTimeout(() => hint.classList.remove('on'), 1400); }
        onSaved?.(res.item);
      } catch (e) { markInvalid(form, e); }
    };
    const typed = debounce(send, 600);
    form.addEventListener('change', e => e.target.name && send(e.target));
    form.addEventListener('input', e => { if (e.target.name && e.target.matches('input[type=text],input:not([type]),textarea')) typed(e.target); });
    form.addEventListener('submit', e => e.preventDefault());
  }

  // ------------------------------------------------------------------ charts
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function chart(canvas, config) {
    if (!window.Chart || !canvas) return null;
    Chart.defaults.font.family = css('--font') || 'system-ui';
    Chart.defaults.color = css('--muted');
    Chart.defaults.borderColor = css('--border');
    if (S.soft) config.options = { ...config.options, animation: false };
    const c = new Chart(canvas, config);
    S.charts.push(c);
    return c;
  }
  const destroyCharts = () => { S.charts.forEach(c => c.destroy()); S.charts = []; };
  const moneyTick = v => (Math.abs(v) >= 1000 ? `${nf0.format(v / 1000)}k` : nf0.format(v));

  // ------------------------------------------------------------------ router
  const VIEWS = {
    dashboard: { title: 'Dashboard', render: renderDashboard },
    transactions: { title: 'Transactions', render: renderTransactions },
    income: { title: 'Income', render: renderIncome },
    budget: { title: 'Budget', render: renderBudget },
    goals: { title: 'Savings Goals', render: renderGoals, noPeriod: true },
    recurring: { title: 'Recurring Bills & Income', render: renderRecurring, noPeriod: true },
    year: { title: 'Year View', render: renderYear, yearly: true },
    settings: { title: 'Settings', render: renderSettings, noPeriod: true },
  };

  function route() {
    const name = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'dashboard';
    S.view = VIEWS[name] ? name : 'dashboard';
    $$('[data-view]').forEach(a => a.classList.toggle('active', a.dataset.view === S.view));
    $('#view-title').textContent = VIEWS[S.view].title;
    $('.sidebar').classList.remove('open');
    updatePeriodLabel();
    refresh({ hard: true });
  }
  window.addEventListener('hashchange', route);

  function updatePeriodLabel() {
    const v = VIEWS[S.view];
    $('#period').classList.toggle('hidden', !!v.noPeriod);
    $('#period-label').textContent = v.yearly ? String(S.yearSel) : `${MONTHS[S.month - 1]} ${S.year}`;
  }

  let renderSeq = 0;
  async function refresh({ hard = false } = {}) {
    const seq = ++renderSeq;
    const view = $('#view');
    S.soft = !hard;
    const scroll = window.scrollY;
    if (hard) view.innerHTML = skeleton();
    try {
      const html = await VIEWS[S.view].render(seq);
      if (seq !== renderSeq || html === undefined) return;
      destroyCharts();
      view.innerHTML = html;
      VIEWS[S.view].after?.();
      if (!hard) window.scrollTo(0, scroll);
      if (S.drawerRefresh) S.drawerRefresh();
    } catch (e) {
      if (seq === renderSeq) {
        if (hard) view.innerHTML = `<div class="card empty"><div class="big">⚠️</div><h3>Couldn't load this page</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
        else fail(e);
      }
    }
  }
  const skeleton = () => `<div class="kpis">${'<div class="card skeleton" style="height:104px"></div>'.repeat(6)}</div>
    <div class="dash-grid"><div class="card skeleton span-8" style="height:300px"></div><div class="card skeleton span-4" style="height:300px"></div></div>`;

  function setPeriod(y, m) {
    S.year = y; S.month = m;
    store.set('mt-period', { y, m, at: S.today });
    // Transactions / income lists follow the chosen month when their range is "month".
    if (S.tx.range === 'month') Object.assign(S.tx.filters, rangeFilters('month'));
    if (S.inc.range === 'month') Object.assign(S.inc.filters, rangeFilters('month'));
    updatePeriodLabel();
    refresh();
  }
  function stepPeriod(step) {
    if (VIEWS[S.view].yearly) { S.yearSel += step; updatePeriodLabel(); return refresh(); }
    let m = S.month + step, y = S.year;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    setPeriod(y, m);
  }
  $('#period').addEventListener('click', e => {
    const b = e.target.closest('[data-step]');
    if (b) stepPeriod(Number(b.dataset.step));
  });
  $('#period-label').onclick = () => {
    if (VIEWS[S.view].yearly) { S.yearSel = now.getFullYear(); updatePeriodLabel(); return refresh(); }
    openModal(`<h2>Jump to month</h2>
      <div class="row" style="margin-bottom:14px"><button class="icon-btn" data-y="-1">‹</button><b id="jy" style="flex:1;text-align:center;font-size:18px">${S.year}</b><button class="icon-btn" data-y="1">›</button></div>
      <div class="grid-3" id="jm">${MON.map((m, i) => `<button class="btn ${i + 1 === S.month ? 'btn-primary' : ''}" data-m="${i + 1}">${m}</button>`).join('')}</div>
      <div class="form-actions"><button class="btn" data-today>This month</button><span class="spacer"></span><button class="btn btn-ghost" data-close-modal>Close</button></div>`);
    let y = S.year;
    $('#modal').onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.y) { y += Number(t.dataset.y); $('#jy').textContent = y; }
      if (t.dataset.m) { closeModal(); setPeriod(y, Number(t.dataset.m)); }
      if ('today' in t.dataset) { closeModal(); setPeriod(now.getFullYear(), now.getMonth() + 1); }
    };
  };

  function rangeFilters(range) {
    const t = parseISO(S.today);
    switch (range) {
      case 'month': { const [from, to] = monthRange(S.year, S.month); return { from, to }; }
      case '7': return { from: iso(addDays(t, -6)), to: S.today };
      case '30': return { from: iso(addDays(t, -29)), to: S.today };
      case 'today': return { from: S.today, to: S.today };
      case 'year': return { from: `${S.year}-01-01`, to: `${S.year}-12-31` };
      default: return { from: '', to: '' };
    }
  }

  function goTransactions(filters = {}, range = 'custom') {
    S.tx.range = range;
    S.tx.filters = { ...rangeFilters(range === 'custom' ? 'all' : range), ...filters };
    S.tx.selected.clear();
    if (location.hash === '#/transactions') refresh({ hard: true }); else location.hash = '#/transactions';
  }

  // ================================================================== DASHBOARD
  async function renderDashboard(seq) {
    const d = await api(`/api/dashboard?year=${S.year}&month=${S.month}`);
    if (seq !== renderSeq) return;
    S.dash = d;
    const k = d.kpi, h = d.health, ins = d.insights;
    const pace = d.is_current && k.budget ? d.days_elapsed / d.days_in_month : null;
    const statusAccent = { 'OVERSPENDING': 'var(--danger)', 'WATCH OUT': 'var(--warn)', 'ON TRACK': 'var(--ok)' }[k.status] || 'var(--primary)';
    const delta = (ch, goodWhenUp) => ch == null ? '' :
      `<span class="delta ${ch >= 0 ? 'up' : 'down'} ${goodWhenUp ? (ch >= 0 ? 'good' : 'bad') : ''}">${ch >= 0 ? '▲' : '▼'} ${pct(Math.abs(ch))}</span>`;
    const emptyMonth = !k.tx_count && !k.income_count;

    const catsWithSpend = d.categories.filter(c => c.spent > 0).sort((a, b) => b.spent - a.spent);
    const budgetRows = d.categories.filter(c => c.budget > 0 || c.spent > 0)
      .sort((a, b) => (b.pct || (b.spent ? 9 : 0)) - (a.pct || (a.spent ? 9 : 0)));

    VIEWS.dashboard.after = () => {
      // Daily spending vs allowance
      const ctx = $('#ch-daily');
      if (ctx) chart(ctx, {
        type: 'bar',
        data: {
          labels: d.daily.map(x => parseISO(x.date).getDate()),
          datasets: [
            { type: 'line', label: 'Daily allowance', data: d.daily.map(x => x.allowance || null), borderColor: css('--warn'), borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0 },
            {
              label: 'Spent', data: d.daily.map(x => x.spent), borderRadius: 6, maxBarThickness: 22,
              backgroundColor: d.daily.map(x => x.status === 'OVER' ? css('--danger') : x.date === S.today ? css('--primary-2') : css('--primary')),
            },
          ],
        },
        options: {
          maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { callbacks: { title: i => fmtDate(d.daily[i[0].dataIndex].date, true), label: i => `${i.dataset.label}: ${money(i.raw)}` } } },
          scales: { y: { beginAtZero: true, ticks: { callback: moneyTick } }, x: { grid: { display: false } } },
          onClick: (e, els) => { if (els.length) openDay(d.daily[els[0].index].date); },
          onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        },
      });
      const dn = $('#ch-donut');
      if (dn && catsWithSpend.length) chart(dn, {
        type: 'doughnut',
        data: { labels: catsWithSpend.map(c => c.name), datasets: [{ data: catsWithSpend.map(c => c.spent), backgroundColor: catsWithSpend.map(c => c.color), borderWidth: 2, borderColor: css('--surface'), hoverOffset: 8 }] },
        options: {
          maintainAspectRatio: false, cutout: '68%',
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: i => `${i.label}: ${money(i.raw)} (${pct(i.raw / k.spent)})` } } },
          onClick: (e, els) => { if (els.length) openCategory(catsWithSpend[els[0].index]); },
        },
      });
      const wd = $('#ch-weekday');
      if (wd) chart(wd, {
        type: 'bar',
        data: { labels: DOW, datasets: [{ data: ins.weekday, backgroundColor: css('--primary'), borderRadius: 5, maxBarThickness: 26 }] },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: i => money(i.raw) } } }, scales: { y: { display: false, beginAtZero: true }, x: { grid: { display: false } } } },
      });
      $$('[data-cat]').forEach(el => el.onclick = () => openCategory(d.categories.find(c => String(c.id) === el.dataset.cat)));
      $$('[data-day]').forEach(el => el.onclick = () => openDay(el.dataset.day));
      $$('[data-week]').forEach(el => el.onclick = () => {
        const ws = addDays(parseISO(d.start), 7 * Number(el.dataset.week));
        const we = new Date(Math.min(addDays(ws, 6), parseISO(d.end)));
        goTransactions({ from: iso(ws), to: iso(we) });
      });
      $$('[data-tx]').forEach(el => el.onclick = () => openTx(d.top.find(t => String(t.id) === el.dataset.tx)));
      $('#kpi-spent')?.addEventListener('click', () => goTransactions({}, 'month'));
      $('#kpi-income')?.addEventListener('click', () => { S.inc.range = 'month'; S.inc.filters = rangeFilters('month'); location.hash = '#/income'; });
      $('#kpi-budget')?.addEventListener('click', () => { location.hash = '#/budget'; });
      $$('[data-goto]').forEach(el => el.onclick = () => { location.hash = el.dataset.goto; });
      $$('[data-rec]').forEach(el => el.onclick = () => { location.hash = '#/recurring'; });
      $('#first-add')?.addEventListener('click', () => quickAdd('expense'));
    };

    // Calendar heatmap
    const firstDow = (parseISO(d.start).getDay() + 6) % 7;
    const maxDay = Math.max(...d.daily.map(x => x.spent), 1);
    const calCells = Array(firstDow).fill('<div class="c blank"></div>').concat(d.daily.map(x => {
      const a = x.spent ? 0.12 + 0.75 * (x.spent / maxDay) : 0;
      const cls = [x.date === S.today && 'today', x.status === 'OVER' && 'over', x.date > S.today && 'future'].filter(Boolean).join(' ');
      return `<div class="c ${cls}" data-day="${x.date}" title="${fmtDate(x.date, true)}: ${money(x.spent)}${x.income ? ' · income ' + money(x.income) : ''}" style="${a ? `background:color-mix(in srgb, var(--primary) ${Math.round(a * 100)}%, var(--surface))` : ''}">
        <span class="dn">${parseISO(x.date).getDate()}</span>${x.spent ? `<span class="sp" style="color:${a > .5 ? '#fff' : 'inherit'}">${moneyTick(x.spent)}</span>` : ''}${x.income ? '<span style="position:absolute;top:3px;right:5px;font-size:8px">🟢</span>' : ''}</div>`;
    })).join('');

    const peakHour = ins.hours.some(Boolean) ? ins.hours.indexOf(Math.max(...ins.hours)) : null;
    const busiestDay = ins.weekday.some(Boolean) ? DOW[ins.weekday.indexOf(Math.max(...ins.weekday))] : null;
    const hourLabel = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

    return `
      <div class="banner banner-${d.banner.level}"><span>${{ ok: '✅', warn: '⚠️', danger: '🚨', info: 'ℹ️' }[d.banner.level]}</span><span>${esc(d.banner.text)}</span></div>
      ${emptyMonth ? `<div class="card empty" style="margin-bottom:16px"><div class="big">🌱</div><h3>Nothing recorded for ${d.month_name} ${d.year} yet</h3><p>Add your first expense or income — the dashboard updates the moment you save.</p><button class="btn btn-primary" id="first-add">＋ Add a transaction</button></div>` : ''}
      <div class="kpis">
        <div class="card kpi clickable" id="kpi-income" style="--accent:var(--income)"><div class="label">Total income</div><div class="value pos num">${money(k.income, { exact: false })}</div><div class="sub">${k.income_count} income entr${k.income_count === 1 ? 'y' : 'ies'} ${delta(ins.income_change, true)}</div></div>
        <div class="card kpi clickable" id="kpi-spent" style="--accent:var(--expense)"><div class="label">Total spent</div><div class="value neg num">${money(k.spent, { exact: false })}</div><div class="sub">${k.tx_count} transaction${k.tx_count === 1 ? '' : 's'} ${delta(ins.spent_change, false)}</div></div>
        <div class="card kpi" style="--accent:${k.net >= 0 ? 'var(--income)' : 'var(--expense)'}"><div class="label">Net savings</div><div class="value num ${k.net >= 0 ? 'pos' : 'neg'}">${money(k.net, { exact: false })}</div><div class="sub">${k.net >= 0 ? 'Income minus spending' : 'Spending is above income'}</div></div>
        <div class="card kpi"><div class="label">Savings rate</div><div class="value num">${pct(k.savings_rate)}</div><div class="sub">${!k.income ? 'No income recorded' : k.savings_rate >= .2 ? 'Healthy saving habit 💪' : k.savings_rate >= 0 ? 'Room to improve' : 'Spending more than you earn'}</div></div>
        <div class="card kpi clickable" id="kpi-budget"><div class="label">Budget used</div><div class="value num">${pct(k.budget_used)}</div><div class="sub" style="margin-bottom:6px">of ${money(k.budget, { exact: false })} budget</div>${bar(k.budget_used, k.budget_used > 1 ? 'OVER' : k.budget_used >= S.lists.warn_pct ? 'Watch' : 'OK', pace)}</div>
        <div class="card kpi" style="--accent:${statusAccent}"><div class="label">Budget status</div><div class="value" style="color:${statusAccent};font-size:19px">${esc(k.status)}</div><div class="sub">${!k.budget ? 'Add budgets to track' : k.spent > k.budget ? `Over by ${money(k.spent - k.budget, { exact: false })}` : `${money(k.budget - k.spent, { exact: false })} left to spend`}</div></div>
      </div>

      <div class="dash-grid">
        <div class="card span-8">
          <div class="card-h"><h3>Daily spending vs daily allowance</h3><span class="spacer"></span><span class="muted small">${esc(d.period_note)} · click a bar for details</span></div>
          <div class="chart-box"><canvas id="ch-daily"></canvas></div>
        </div>
        <div class="card span-4">
          <div class="card-h"><h3>Spending health</h3></div>
          <div class="stats">
            <div class="stat"><span class="k">Total budget for the month</span><span class="v num">${money(h.budget)}</span></div>
            <div class="stat"><span class="k">Spent so far</span><span class="v num">${money(h.spent)}</span></div>
            <div class="stat"><span class="k">Budget remaining</span><span class="v num ${h.remaining < 0 ? 'neg' : ''}">${money(h.remaining)}</span></div>
            <div class="stat"><span class="k">Expected spend by today (pace)</span><span class="v num">${money(h.expected)}</span></div>
            <div class="stat"><span class="k">Ahead (+) / behind (−) of pace</span><span class="v num ${h.ahead > 0 ? 'neg' : 'pos'}">${money(h.ahead, { sign: true })}</span></div>
            <div class="stat"><span class="k">Projected month-end spend</span><span class="v num">${money(h.projected)}</span></div>
            <div class="stat"><span class="k">Projected over (+) / under (−)</span><span class="v num ${h.projected_over > 0 ? 'neg' : 'pos'}">${money(h.projected_over, { sign: true })}</span></div>
            <div class="stat"><span class="k">Safe to spend per day</span><span class="v num pos">${money(h.safe_per_day)}</span></div>
            <div class="stat"><span class="k">Average spend per day</span><span class="v num">${money(h.avg_per_day)}</span></div>
            <div class="stat"><span class="k">Categories over budget</span><span class="v">${h.cats_over ? `<span class="pill OVER">${h.cats_over}</span>` : '<span class="pill OK">0</span>'}</span></div>
          </div>
        </div>

        <div class="card span-7">
          <div class="card-h"><h3>Budget vs actual by category</h3><span class="spacer"></span><button class="btn btn-sm" data-goto="#/budget">Edit budgets</button></div>
          ${budgetRows.length ? `<div class="cat-list">${budgetRows.map(c => `
            <div class="cat-row" data-cat="${c.id}">
              <div>${chip(c.name, c.icon, c.color)}</div>
              <div class="barcol">${c.budget ? bar(c.pct, c.status, pace) : bar(c.spent ? 1 : 0, 'Watch')}
                <div class="meta"><span>${c.count} item${c.count === 1 ? '' : 's'}${c.budget ? ` · ${pct(c.pct)} used` : ''}</span><span>${c.budget ? (c.remaining >= 0 ? `${money(c.remaining, { exact: false })} left` : `<span class="neg">${money(-c.remaining, { exact: false })} over</span>`) : 'No budget'}</span></div>
              </div>
              <div class="amt num"><b>${money(c.spent, { exact: false })}</b><span class="muted small">${c.budget ? 'of ' + money(c.budget, { exact: false }) : ''}</span> ${pill(c.status)}</div>
            </div>`).join('')}</div>` : `<div class="empty"><div class="big">🎯</div><p>No spending or budgets for this month yet.</p></div>`}
        </div>
        <div class="card span-5">
          <div class="card-h"><h3>Where the money went</h3></div>
          ${catsWithSpend.length ? `<div class="donut-wrap"><div class="chart-box short" style="height:180px"><canvas id="ch-donut"></canvas></div>
            <div class="legend">${catsWithSpend.slice(0, 8).map(c => `<div class="li" data-cat="${c.id}"><span class="sw" style="background:${esc(c.color)}"></span><span class="truncate">${esc(c.icon)} ${esc(c.name)}</span><span class="num">${pct(c.spent / k.spent)}</span></div>`).join('')}</div></div>`
            : '<div class="empty"><div class="big">🍩</div><p>Your spending breakdown appears here.</p></div>'}
        </div>

        <div class="card span-12">
          <div class="card-h"><h3>Weekly breakdown</h3><span class="spacer"></span><span class="muted small">Weekly budget = monthly budget spread evenly across the days of each week</span></div>
          <div class="weeks">${d.weeks.map((w, i) => `
            <div class="week" data-week="${i}">
              <div class="row"><span class="w">${w.label}</span><span class="spacer"></span>${w.status === 'Upcoming' ? '<span class="pill">Upcoming</span>' : pill(w.status)}</div>
              <div class="d">${esc(w.dates)}</div>
              <div class="s num">${money(w.spent, { exact: false })}</div>
              <div class="muted small" style="margin-bottom:6px">of ${money(w.budget, { exact: false })}</div>
              ${bar(w.budget ? w.spent / w.budget : 0, w.status)}
            </div>`).join('')}</div>
        </div>

        <div class="card span-4">
          <div class="card-h"><h3>Spending calendar</h3><span class="spacer"></span><span class="muted small">🟢 = income</span></div>
          <div class="cal">${DOW.map(x => `<div class="dow">${x[0]}</div>`).join('')}${calCells}</div>
        </div>
        <div class="card span-4">
          <div class="card-h"><h3>Income by source</h3></div>
          ${d.by_source.length ? d.by_source.map(r => `<div class="share-row"><span class="truncate">${esc(r.name)}</span><b class="num pos">${money(r.amount, { exact: false })}</b><span class="muted num right">${pct(r.share)}</span><div class="bar"><i style="width:${r.share * 100}%;background:var(--income)"></i></div></div>`).join('')
            : '<div class="empty"><div class="big">💵</div><p>No income this month.</p></div>'}
        </div>
        <div class="card span-4">
          <div class="card-h"><h3>Spending by payment method</h3></div>
          ${d.by_method.length ? d.by_method.map(r => `<div class="share-row"><span class="truncate">${esc(r.name)}</span><b class="num">${money(r.amount, { exact: false })}</b><span class="muted num right">${pct(r.share)}</span><div class="bar"><i style="width:${r.share * 100}%;background:var(--primary)"></i></div></div>`).join('')
            : '<div class="empty"><div class="big">💳</div><p>No spending this month.</p></div>'}
        </div>

        <div class="card span-6">
          <div class="card-h"><h3>Top 5 biggest expenses</h3></div>
          ${d.top.length ? `<div class="list">${d.top.map((t, i) => `
            <div class="list-item" data-tx="${t.id}"><span class="ic-lg" style="--c:${esc(t.category_color)}">${esc(t.category_icon)}</span>
              <div class="grow"><div class="t1 truncate">${i + 1}. ${esc(t.item)}</div><div class="t2">${fmtDate(t.date)} · ${esc(t.category || 'Uncategorised')}${t.payment_method ? ' · ' + esc(t.payment_method) : ''}</div></div>
              <b class="num neg">${money(t.amount)}</b></div>`).join('')}</div>` : '<div class="empty"><div class="big">🧾</div><p>No expenses yet.</p></div>'}
        </div>
        <div class="card span-6">
          <div class="card-h"><h3>Insights</h3></div>
          <div class="insight-grid">
            <div class="insight"><div class="k">vs last month spending</div><div class="v">${ins.spent_change == null ? '–' : `${ins.spent_change >= 0 ? '▲' : '▼'} ${pct(Math.abs(ins.spent_change))} <span class="muted small">(${money(ins.prev_spent, { exact: false })})</span>`}</div></div>
            <div class="insight"><div class="k">Biggest category</div><div class="v truncate">${esc(ins.biggest_category || '–')}</div></div>
            <div class="insight"><div class="k">No-spend days 🎉</div><div class="v">${ins.no_spend_days}</div></div>
            <div class="insight"><div class="k">Peak spending time</div><div class="v">${peakHour == null ? '–' : hourLabel(peakHour) + ' – ' + hourLabel((peakHour + 1) % 24)}</div></div>
            <div class="insight"><div class="k">Most frequent purchase</div><div class="v truncate">${ins.top_items[0] ? `${esc(ins.top_items[0].item)} <span class="muted small">×${ins.top_items[0].count}</span>` : '–'}</div></div>
            <div class="insight"><div class="k">Busiest day of week</div><div class="v">${busiestDay || '–'}</div></div>
          </div>
          <div class="chart-box short" style="height:120px;margin-top:12px"><canvas id="ch-weekday"></canvas></div>
          ${d.upcoming.length ? `<h4 style="margin:14px 0 6px;font-size:13px" class="muted">UPCOMING RECURRING</h4><div class="list">${d.upcoming.map(r => `
            <div class="list-item" data-rec="${r.id}"><span>${r.kind === 'income' ? '💵' : '🔁'}</span><div class="grow"><div class="t1 truncate">${esc(r.name)}</div><div class="t2">${fmtDate(r.next_date, true)}${r.auto_post ? ' · auto' : ' · reminder'}</div></div><b class="num ${r.kind === 'income' ? 'pos' : 'neg'}">${money(r.amount)}</b></div>`).join('')}</div>` : ''}
        </div>
      </div>`;
  }

  async function openCategory(c) {
    if (!c) return;
    const [from, to] = monthRange(S.year, S.month);
    const render = async () => {
      const q = new URLSearchParams({ from, to, category: c.id ?? 'none', limit: 200 });
      const [res, dash] = await Promise.all([api(`/api/transactions?${q}`), api(`/api/dashboard?year=${S.year}&month=${S.month}`)]);
      const cc = dash.categories.find(x => x.id === c.id) || c;
      const body = openDrawer(`
        <div class="drawer-head"><span class="ic-lg" style="--c:${esc(cc.color)}">${esc(cc.icon)}</span><h2>${esc(cc.name)}</h2><button class="icon-btn" data-close-drawer>✕</button></div>
        <div class="drawer-hero"><div class="amt num">${money(cc.spent)}</div><div class="muted">spent in ${MONTHS[S.month - 1]} ${S.year} ${pill(cc.status)}</div>
          ${cc.budget ? `<div style="margin-top:12px">${bar(cc.pct, cc.status)}</div><div class="muted small" style="margin-top:6px">${pct(cc.pct)} of ${money(cc.budget)} · ${cc.remaining >= 0 ? money(cc.remaining) + ' left' : money(-cc.remaining) + ' over'}</div>` : '<div class="muted small" style="margin-top:8px">No budget for this category</div>'}
        </div>
        <div class="row" style="margin-bottom:10px"><h3 style="font-size:14px">${res.count} transaction${res.count === 1 ? '' : 's'}</h3><span class="spacer"></span>
          ${cc.id ? `<button class="btn btn-sm" id="cat-add">＋ Add</button>` : ''}<button class="btn btn-sm" id="cat-all">Open in Transactions</button></div>
        <div class="list">${res.results.map(t => `<div class="list-item" data-txd="${t.id}"><div class="grow"><div class="t1 truncate">${esc(t.item)}</div><div class="t2">${fmtDate(t.date, true)}${t.time ? ' · ' + fmtTime(t.time) : ''}${t.payment_method ? ' · ' + esc(t.payment_method) : ''}</div></div><b class="num neg">${money(t.amount)}</b></div>`).join('') || '<div class="empty">Nothing here yet.</div>'}</div>`);
      $$('[data-txd]', body).forEach(el => el.onclick = () => openTx(res.results.find(t => String(t.id) === el.dataset.txd)));
      $('#cat-all', body).onclick = () => { closeDrawer(); goTransactions({ category: cc.id ?? 'none' }, 'month'); };
      $('#cat-add', body)?.addEventListener('click', () => quickAdd('expense', { category: cc.id }));
    };
    S.drawerRefresh = render;
    render().catch(fail);
  }

  async function openDay(date) {
    const render = async () => {
      const [tx, inc] = await Promise.all([
        api(`/api/transactions?from=${date}&to=${date}&sort=date&limit=200`),
        api(`/api/income?from=${date}&to=${date}&limit=100`),
      ]);
      const allowance = S.dash?.daily.find(x => x.date === date)?.allowance || 0;
      const body = openDrawer(`
        <div class="drawer-head"><span class="ic-lg">📅</span><h2>${fmtDate(date, true)}</h2><button class="icon-btn" data-close-drawer>✕</button></div>
        <div class="drawer-hero"><div class="amt num neg">${money(tx.total)}</div><div class="muted">spent${allowance ? ` · allowance ${money(allowance, { exact: false })}` : ''}${inc.total ? ` · <span class="pos">earned ${money(inc.total)}</span>` : ''}</div>
          ${allowance ? `<div style="margin-top:10px">${bar(tx.total / allowance, tx.total > allowance ? 'OVER' : 'OK')}</div>` : ''}</div>
        <div class="row" style="margin-bottom:8px"><h3 style="font-size:14px">Spending</h3><span class="spacer"></span><button class="btn btn-sm" id="day-add">＋ Expense</button><button class="btn btn-sm" id="day-inc">＋ Income</button></div>
        <div class="list">${tx.results.map(t => `<div class="list-item" data-txd="${t.id}"><span class="ic-lg" style="--c:${esc(t.category_color)}">${esc(t.category_icon)}</span><div class="grow"><div class="t1 truncate">${esc(t.item)}</div><div class="t2">${t.time ? fmtTime(t.time) + ' · ' : ''}${esc(t.category || 'Uncategorised')}${t.payment_method ? ' · ' + esc(t.payment_method) : ''}</div></div><b class="num neg">${money(t.amount)}</b></div>`).join('') || '<div class="empty" style="padding:20px">No spending this day 🎉</div>'}</div>
        ${inc.results.length ? `<h3 style="font-size:14px;margin:16px 0 8px">Income</h3><div class="list">${inc.results.map(i => `<div class="list-item" data-incd="${i.id}"><span class="ic-lg" style="--c:#10b981">💵</span><div class="grow"><div class="t1 truncate">${esc(i.source || 'Income')}</div><div class="t2">${esc(i.description)}</div></div><b class="num pos">${money(i.amount)}</b></div>`).join('')}</div>` : ''}`);
      $$('[data-txd]', body).forEach(el => el.onclick = () => openTx(tx.results.find(t => String(t.id) === el.dataset.txd)));
      $$('[data-incd]', body).forEach(el => el.onclick = () => openIncome(inc.results.find(t => String(t.id) === el.dataset.incd)));
      $('#day-add', body).onclick = () => quickAdd('expense', { date });
      $('#day-inc', body).onclick = () => quickAdd('income', { date });
    };
    S.drawerRefresh = render;
    render().catch(fail);
  }

  // ================================================================== QUICK ADD
  function quickAdd(kind = 'expense', preset = {}) {
    const L = S.lists;
    const last = store.get('mt-last', {});
    const st = { kind, category: preset.category ?? null };
    const m = openModal(`
      <div class="row" style="margin-bottom:14px"><h2 style="margin:0">Add</h2><span class="spacer"></span>
        <div class="seg kind" id="qa-kind"><button type="button" data-kind="expense">💸 Expense</button><button type="button" data-kind="income">💵 Income</button></div>
        <button class="icon-btn" data-close-modal>✕</button></div>
      <form id="qa" class="form-stack" autocomplete="off">
        <div class="amount-input"><span class="cur">${esc(cur())}</span><input name="amount" inputmode="decimal" placeholder="0" autofocus required value="${preset.amount ?? ''}"></div>
        <div class="exp-only suggest field"><span>Item / product</span><input name="item" placeholder="e.g. Lunch at Java House" maxlength="200"><div class="suggest-list hidden" id="qa-sug"></div></div>
        <div class="exp-only field"><span>Category</span><div class="cat-picker" id="qa-cats">${active(L.categories).map(c => `<button type="button" data-id="${c.id}" style="--c:${esc(c.color)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div></div>
        <div class="inc-only field"><span>Income source</span><select name="source">${opts(active(L.income_sources), last.source, '— Choose —')}</select></div>
        <div class="inc-only field"><span>Description</span><input name="description" placeholder="e.g. October salary" maxlength="200"></div>
        <div class="grid-2">
          <label class="field"><span>Date</span><input type="date" name="date" value="${preset.date || S.today}" required></label>
          <label class="field exp-only"><span>Time</span><input type="time" name="time" value="${preset.date && preset.date !== S.today ? '' : nowTime()}"></label>
          <label class="field inc-only"><span>Received via</span><select name="received_via">${opts(active(L.payment_methods), last.received_via, '—')}</select></label>
        </div>
        <div class="grid-2">
          <label class="field exp-only"><span>Paid with</span><select name="payment_method">${opts(active(L.payment_methods), last.payment_method, '—')}</select></label>
          <label class="field"><span>Notes</span><input name="notes" placeholder="Optional" maxlength="300"></label>
        </div>
        <div class="form-actions"><button type="button" class="btn" id="qa-more" title="Shift+Enter">Save & add another</button><span class="spacer"></span><button class="btn btn-ghost" type="button" data-close-modal>Cancel</button><button class="btn btn-primary" type="submit">Save <span class="kbd" style="background:transparent;color:inherit;border-color:rgba(255,255,255,.4)">↵</span></button></div>
      </form>`);
    const form = $('#qa', m);
    const setKind = k => {
      st.kind = k;
      $$('#qa-kind button', m).forEach(b => b.classList.toggle('on', b.dataset.kind === k));
      $$('.exp-only', m).forEach(x => x.classList.toggle('hidden', k !== 'expense'));
      $$('.inc-only', m).forEach(x => x.classList.toggle('hidden', k !== 'income'));
    };
    const setCat = id => {
      st.category = id;
      $$('#qa-cats button', m).forEach(b => b.classList.toggle('on', String(b.dataset.id) === String(id)));
    };
    setKind(kind);
    setCat(st.category);
    $('#qa-kind', m).onclick = e => { const b = e.target.closest('button'); if (b) setKind(b.dataset.kind); };
    $('#qa-cats', m).onclick = e => { const b = e.target.closest('button'); if (b) setCat(st.category == b.dataset.id ? null : b.dataset.id); };

    // Item autocomplete – remembers the category/method/amount you used last time.
    const item = form.item, sug = $('#qa-sug', m);
    let sugs = [], sel = -1;
    const pick = s => {
      item.value = s.item;
      if (s.category_id) setCat(s.category_id);
      if (s.payment_method_id) form.payment_method.value = s.payment_method_id;
      if (!form.amount.value) form.amount.value = s.amount;
      sug.classList.add('hidden');
    };
    const drawSug = () => {
      sug.innerHTML = sugs.map((s, i) => { const c = catById(s.category_id); return `<div data-i="${i}" class="${i === sel ? 'on' : ''}"><span>${c ? esc(c.icon) + ' ' : ''}${esc(s.item)}</span><span class="muted num">${money(s.amount)} · ×${s.uses}</span></div>`; }).join('');
      sug.classList.toggle('hidden', !sugs.length);
    };
    item.addEventListener('input', debounce(async () => {
      const q = item.value.trim();
      if (!q) { sugs = []; return drawSug(); }
      sugs = (await api(`/api/suggest?q=${encodeURIComponent(q)}`)).results.filter(s => s.item.toLowerCase() !== q.toLowerCase() || s.uses > 0);
      sel = -1; drawSug();
    }, 150));
    item.addEventListener('keydown', e => {
      if (sug.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, sugs.length - 1); drawSug(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); drawSug(); e.preventDefault(); }
      if (e.key === 'Enter' && sel >= 0) { pick(sugs[sel]); e.preventDefault(); }
      if (e.key === 'Escape') { sug.classList.add('hidden'); e.stopPropagation(); }
    });
    item.addEventListener('blur', () => setTimeout(() => sug.classList.add('hidden'), 150));
    sug.onmousedown = e => { const d = e.target.closest('[data-i]'); if (d) pick(sugs[d.dataset.i]); };

    const save = async again => {
      const f = formData(form);
      let body, url;
      if (st.kind === 'expense') {
        if (!f.item.trim()) f.item = st.category ? catById(Number(st.category))?.name || 'Expense' : 'Expense';
        body = { date: f.date, time: f.time, item: f.item, amount: f.amount, category: st.category, payment_method: f.payment_method, notes: f.notes };
        url = '/api/transactions';
        store.set('mt-last', { ...last, payment_method: f.payment_method });
      } else {
        body = { date: f.date, source: f.source, description: f.description, amount: f.amount, received_via: f.received_via, notes: f.notes };
        url = '/api/income';
        store.set('mt-last', { ...last, source: f.source, received_via: f.received_via });
      }
      try {
        const res = await api(url, { method: 'POST', body });
        S.flash = res.item.id;
        toast(`${st.kind === 'expense' ? '💸' : '💵'} Saved ${money(res.item.amount)}${st.kind === 'expense' ? ' · ' + res.item.item : ''}`, {
          undo: async () => { await api(`${url}/${res.item.id}`, { method: 'DELETE' }); changed(); toast('Removed'); },
        });
        if (again) {
          form.amount.value = ''; form.notes.value = ''; if (form.item) form.item.value = ''; if (form.description) form.description.value = '';
          form.time.value = nowTime(); form.amount.focus();
        } else closeModal();
        changed();
      } catch (e) { markInvalid(form, e); }
    };
    form.onsubmit = e => { e.preventDefault(); save(false); };
    $('#qa-more', m).onclick = () => save(true);
    form.addEventListener('keydown', e => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); save(true); } });
  }
  $('#quick-add').onclick = () => quickAdd('expense');
  $('#fab').onclick = () => quickAdd('expense');

  // ================================================================== TRANSACTION DRAWER
  function openTx(t) {
    if (!t) return;
    const L = S.lists;
    S.drawerRefresh = null;
    const render = item => {
      const body = openDrawer(`
        <div class="drawer-head"><span class="ic-lg" style="--c:${esc(item.category_color)}">${esc(item.category_icon)}</span><h2 class="truncate">${esc(item.item)}</h2><button class="icon-btn" data-close-drawer>✕</button></div>
        <div class="drawer-hero"><div class="amt num neg">${money(item.amount)}</div><div class="muted">${fmtDate(item.date, true)}${item.time ? ' · ' + fmtTime(item.time) : ''}</div></div>
        <form class="form-stack" id="tx-form">
          <div class="row"><span class="muted small">Changes save automatically</span><span class="spacer"></span><span class="saved-hint">✓ Saved</span></div>
          <label class="field"><span>Item / product</span><input name="item" value="${esc(item.item)}" maxlength="200"></label>
          <div class="grid-2">
            <label class="field"><span>Amount (${esc(cur())})</span><input name="amount" inputmode="decimal" value="${item.amount}"></label>
            <label class="field"><span>Category</span><select name="category">${opts(L.categories.filter(c => !c.archived || c.id === item.category_id), item.category_id, '— Uncategorised —')}</select></label>
            <label class="field"><span>Date</span><input type="date" name="date" value="${item.date}"></label>
            <label class="field"><span>Time</span><input type="time" name="time" value="${item.time}"></label>
          </div>
          <label class="field"><span>Paid with</span><select name="payment_method">${opts(L.payment_methods, item.payment_method_id, '—')}</select></label>
          <label class="field"><span>Notes</span><textarea name="notes" rows="2" maxlength="300">${esc(item.notes)}</textarea></label>
        </form>
        <div class="form-actions"><button class="btn" id="tx-dup">⧉ Duplicate today</button><span class="spacer"></span><button class="btn btn-danger" id="tx-del">🗑 Delete</button></div>
        <h3 style="font-size:14px;margin:22px 0 8px">History of “${esc(item.item)}”</h3><div id="tx-hist" class="list"><div class="skeleton" style="height:40px"></div></div>`);
      autosave($('#tx-form', body), `/api/transactions/${item.id}`, saved => {
        $('.drawer-hero', body).innerHTML = `<div class="amt num neg">${money(saved.amount)}</div><div class="muted">${fmtDate(saved.date, true)}${saved.time ? ' · ' + fmtTime(saved.time) : ''}</div>`;
        $('.drawer-head h2', body).textContent = saved.item;
        const ic = $('.drawer-head .ic-lg', body); ic.textContent = saved.category_icon; ic.style.setProperty('--c', saved.category_color);
        t = saved;
        changed();
      });
      $('#tx-del', body).onclick = () => { closeDrawer(); deleteTx([item]); };
      $('#tx-dup', body).onclick = async () => {
        try {
          const { item: copy } = await api('/api/transactions', { method: 'POST', body: { ...item, id: undefined, category: item.category_id, payment_method: item.payment_method_id, date: S.today, time: nowTime() } });
          S.flash = copy.id; toast(`⧉ Duplicated for today · ${money(copy.amount)}`); changed(); render(copy);
        } catch (e) { fail(e); }
      };
      api(`/api/transactions?q=${encodeURIComponent(item.item)}&limit=8`).then(h => {
        const el = $('#tx-hist', body);
        if (!el) return;
        const others = h.results.filter(x => x.item.toLowerCase() === item.item.toLowerCase());
        el.innerHTML = others.length > 1
          ? `<div class="muted small" style="margin-bottom:6px">${others.length}${h.has_more ? '+' : ''} times · average ${money(others.reduce((a, x) => a + x.amount, 0) / others.length)}</div>` +
            others.map(x => `<div class="list-item ${x.id === item.id ? 'selected' : ''}" data-h="${x.id}"><div class="grow"><div class="t1">${fmtDate(x.date, true)}</div><div class="t2">${esc(x.category)}</div></div><b class="num">${money(x.amount)}</b></div>`).join('')
          : '<div class="muted small">First time you bought this.</div>';
        $$('[data-h]', el).forEach(r => r.onclick = () => render(others.find(x => String(x.id) === r.dataset.h)));
      }).catch(() => {});
    };
    render(t);
  }

  async function deleteTx(items) {
    try {
      if (items.length === 1) await api(`/api/transactions/${items[0].id}`, { method: 'DELETE' });
      else await api('/api/transactions/bulk-delete', { method: 'POST', body: { ids: items.map(i => i.id) } });
      S.tx.selected.clear();
      toast(`🗑 Deleted ${items.length} transaction${items.length === 1 ? '' : 's'}`, {
        undo: async () => {
          for (const t of items) {
            await api('/api/transactions', { method: 'POST', body: { date: t.date, time: t.time, item: t.item, amount: t.amount, category: t.category_id, payment_method: t.payment_method_id, notes: t.notes } });
          }
          toast('Restored'); changed();
        },
      });
      changed();
    } catch (e) { fail(e); }
  }

  // ================================================================== TRANSACTIONS VIEW
  async function fetchTx(offset = 0, limit = 60) {
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(S.tx.filters).filter(([, v]) => v !== '' && v != null)), sort: S.tx.sort, offset, limit });
    return api(`/api/transactions?${q}`);
  }

  async function renderTransactions(seq) {
    if (!S.tx.filters.from && !S.tx.filters.to && S.tx.range === 'month') Object.assign(S.tx.filters, rangeFilters('month'));
    const keep = Math.max(S.tx.rows.length, 60);
    const res = await fetchTx(0, S.soft ? Math.min(keep, 500) : 60);
    if (seq !== renderSeq) return;
    S.tx.rows = res.results; S.tx.meta = res;
    const f = S.tx.filters, L = S.lists;
    const ranges = [['month', `${MON[S.month - 1]} ${S.year}`], ['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['year', `Year ${S.year}`], ['all', 'All time']];

    VIEWS.transactions.after = () => {
      const v = $('#view');
      const apply = debounce(() => reloadTx(), 220);
      $$('[data-f]', v).forEach(el => el.addEventListener('input', () => {
        f[el.dataset.f] = el.value;
        if (el.dataset.f === 'from' || el.dataset.f === 'to') { S.tx.range = 'custom'; $$('.quick-ranges button', v).forEach(b => b.classList.remove('on')); }
        apply();
      }));
      $('.quick-ranges', v).onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        S.tx.range = b.dataset.r; Object.assign(f, rangeFilters(b.dataset.r));
        $$('.quick-ranges button', v).forEach(x => x.classList.toggle('on', x === b));
        $('[data-f=from]', v).value = f.from; $('[data-f=to]', v).value = f.to;
        reloadTx();
      };
      $('#tx-more-btn', v).onclick = () => { S.tx.showMore = !S.tx.showMore; $('#tx-more', v).classList.toggle('hidden', !S.tx.showMore); };
      $('#tx-clear', v).onclick = () => { S.tx.filters = rangeFilters('month'); S.tx.range = 'month'; refresh({ hard: true }); };
      $('#tx-export', v).onclick = () => { const q = new URLSearchParams(Object.entries(f).filter(([, x]) => x)); location.href = `/export/transactions.csv?${q}`; };
      bindTxTable();
      setupInfinite();
      if (S.focusSearch) { $('[data-f=q]', v).focus(); S.focusSearch = false; }
    };

    return `
      <div class="card" style="margin-bottom:16px">
        <div class="quick-ranges">${ranges.map(([r, l]) => `<button data-r="${r}" class="${S.tx.range === r ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="filters">
          <input data-f="q" type="search" placeholder="🔍 Search item or notes… e.g. naivas, uber  ( / )" value="${esc(f.q || '')}">
          <input data-f="from" type="date" value="${f.from || ''}" title="From date">
          <input data-f="to" type="date" value="${f.to || ''}" title="To date">
          <select data-f="category"><option value="">All categories</option><option value="none" ${f.category === 'none' ? 'selected' : ''}>❔ Uncategorised</option>${opts(L.categories, f.category)}</select>
          <select data-f="method"><option value="">Any payment method</option>${opts(L.payment_methods, f.method)}</select>
        </div>
        <div id="tx-more" class="filters more ${S.tx.showMore ? '' : 'hidden'}">
          <label class="field"><span>Time from</span><input data-f="time_from" type="time" value="${f.time_from || ''}"></label>
          <label class="field"><span>Time to</span><input data-f="time_to" type="time" value="${f.time_to || ''}"></label>
          <label class="field"><span>Min amount</span><input data-f="min" inputmode="decimal" value="${f.min || ''}"></label>
          <label class="field"><span>Max amount</span><input data-f="max" inputmode="decimal" value="${f.max || ''}"></label>
        </div>
        <div class="row wrap"><button class="btn btn-sm btn-ghost" id="tx-more-btn">⚙ More filters (time of day, amount)</button><span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="tx-clear">Reset</button><button class="btn btn-sm" id="tx-export">⬇ Export CSV</button></div>
      </div>
      <div id="tx-results">${txResults()}</div>`;
  }

  function txResults() {
    const r = S.tx.meta, rows = S.tx.rows, sel = S.tx.selected;
    const sortIcon = k => S.tx.sort === k ? ' ↑' : S.tx.sort === '-' + k ? ' ↓' : '';
    if (!r.count) return `<div class="card empty"><div class="big">🔍</div><h3>No transactions found</h3><p>Try a different date range or search — or add one now.</p><button class="btn btn-primary" data-new>＋ Add expense</button></div>`;
    return `
      <div class="result-bar"><span>Matches found <b class="num">${nf0.format(r.count)}</b></span><span>Total <b class="num neg">${money(r.total)}</b></span><span class="muted">Average ${money(r.total / r.count)}</span><span class="spacer"></span><span class="muted small">Click a row to view &amp; edit</span></div>
      ${sel.size ? `<div class="bulk-bar"><b>${sel.size} selected</b><span>· ${money(rows.filter(x => sel.has(x.id)).reduce((a, x) => a + x.amount, 0))}</span><span class="spacer"></span><button class="btn btn-sm" data-bulk-clear>Clear</button><button class="btn btn-sm" data-bulk-del>🗑 Delete selected</button></div>` : ''}
      <div class="card" style="padding-top:6px"><div class="table-wrap"><table class="t">
        <thead><tr><th style="width:28px"><input type="checkbox" data-all ${rows.length && rows.every(x => sel.has(x.id)) ? 'checked' : ''}></th>
          <th class="sortable" data-sort="date">Date${sortIcon('date')}</th><th class="hide-m">Time</th><th class="sortable" data-sort="item">Item / Product${sortIcon('item')}</th>
          <th class="hide-m">Category</th><th class="hide-m">Paid with</th><th class="sortable right" data-sort="amount">Amount${sortIcon('amount')}</th><th style="width:70px"></th></tr></thead>
        <tbody>${rows.map(t => `
          <tr class="click ${sel.has(t.id) ? 'selected' : ''} ${S.flash === t.id ? 'flash' : ''}" data-id="${t.id}">
            <td><input type="checkbox" data-sel ${sel.has(t.id) ? 'checked' : ''}></td>
            <td class="num">${fmtDate(t.date)}</td><td class="hide-m muted num">${fmtTime(t.time)}</td>
            <td class="item-cell"><div class="truncate">${esc(t.item)}</div>${t.notes ? `<div class="note truncate">${esc(t.notes)}</div>` : ''}</td>
            <td class="hide-m">${chip(t.category, t.category_icon, t.category_color)}</td><td class="hide-m muted">${esc(t.payment_method)}</td>
            <td class="right num neg"><b>${money(t.amount)}</b></td>
            <td class="right"><button class="icon-btn" data-dup title="Duplicate for today">⧉</button><button class="icon-btn danger" data-del title="Delete">🗑</button></td>
          </tr>`).join('')}</tbody>
      </table></div>
      ${r.has_more || rows.length < r.count ? `<div style="text-align:center;padding:14px" id="tx-sentinel"><button class="btn btn-sm" id="tx-load">Load more (${nf0.format(r.count - rows.length)} left)</button></div>` : `<div class="muted small" style="text-align:center;padding:12px">All ${nf0.format(r.count)} shown</div>`}
      </div>`;
  }

  async function reloadTx() {
    const seq = renderSeq;
    try {
      const res = await fetchTx(0, 60);
      if (seq !== renderSeq) return;
      S.tx.rows = res.results; S.tx.meta = res;
      $('#tx-results').innerHTML = txResults();
      bindTxTable(); setupInfinite();
    } catch (e) { fail(e); }
  }

  async function loadMoreTx() {
    if (S.tx.loading || S.tx.rows.length >= S.tx.meta.count) return;
    S.tx.loading = true;
    try {
      const res = await fetchTx(S.tx.rows.length, 100);
      S.tx.rows = S.tx.rows.concat(res.results); S.tx.meta = { ...res, has_more: res.has_more };
      $('#tx-results').innerHTML = txResults(); bindTxTable(); setupInfinite();
    } finally { S.tx.loading = false; }
  }

  function setupInfinite() {
    const s = $('#tx-sentinel');
    if (!s) return;
    $('#tx-load').onclick = loadMoreTx;
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(es => { if (es[0].isIntersecting) { io.disconnect(); loadMoreTx(); } }, { rootMargin: '300px' });
      io.observe(s);
    }
  }

  function bindTxTable() {
    const wrap = $('#tx-results');
    if (!wrap) return;
    S.flash = null;
    const byId = id => S.tx.rows.find(x => x.id === Number(id));
    const redraw = () => { $('#tx-results').innerHTML = txResults(); bindTxTable(); setupInfinite(); };
    wrap.onclick = async e => {
      if (e.target.closest('[data-new]')) return quickAdd('expense');
      const th = e.target.closest('[data-sort]');
      if (th) { const k = th.dataset.sort; S.tx.sort = S.tx.sort === '-' + k ? k : '-' + k; return reloadTx(); }
      if (e.target.closest('[data-all]')) { const on = e.target.checked; S.tx.rows.forEach(x => on ? S.tx.selected.add(x.id) : S.tx.selected.delete(x.id)); return redraw(); }
      if (e.target.closest('[data-bulk-clear]')) { S.tx.selected.clear(); return redraw(); }
      if (e.target.closest('[data-bulk-del]')) return deleteTx(S.tx.rows.filter(x => S.tx.selected.has(x.id)));
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const t = byId(tr.dataset.id);
      if (e.target.closest('[data-sel]')) { S.tx.selected.has(t.id) ? S.tx.selected.delete(t.id) : S.tx.selected.add(t.id); return redraw(); }
      if (e.target.closest('[data-del]')) return deleteTx([t]);
      if (e.target.closest('[data-dup]')) {
        try {
          const { item } = await api('/api/transactions', { method: 'POST', body: { date: S.today, time: nowTime(), item: t.item, amount: t.amount, category: t.category_id, payment_method: t.payment_method_id, notes: t.notes } });
          S.flash = item.id; toast(`⧉ Duplicated for today · ${money(item.amount)}`); changed();
        } catch (err) { fail(err); }
        return;
      }
      openTx(t);
    };
  }

  // ================================================================== INCOME
  function openIncome(i) {
    if (!i) return;
    const L = S.lists;
    S.drawerRefresh = null;
    const body = openDrawer(`
      <div class="drawer-head"><span class="ic-lg" style="--c:#10b981">💵</span><h2 class="truncate">${esc(i.source || 'Income')}</h2><button class="icon-btn" data-close-drawer>✕</button></div>
      <div class="drawer-hero"><div class="amt num pos">${money(i.amount)}</div><div class="muted">${fmtDate(i.date, true)}</div></div>
      <form class="form-stack" id="inc-form">
        <div class="row"><span class="muted small">Changes save automatically</span><span class="spacer"></span><span class="saved-hint">✓ Saved</span></div>
        <div class="grid-2">
          <label class="field"><span>Amount (${esc(cur())})</span><input name="amount" inputmode="decimal" value="${i.amount}"></label>
          <label class="field"><span>Date</span><input type="date" name="date" value="${i.date}"></label>
        </div>
        <label class="field"><span>Income source</span><select name="source">${opts(L.income_sources, i.source_id, '—')}</select></label>
        <label class="field"><span>Description</span><input name="description" value="${esc(i.description)}" maxlength="200"></label>
        <label class="field"><span>Received via</span><select name="received_via">${opts(L.payment_methods, i.received_via_id, '—')}</select></label>
        <label class="field"><span>Notes</span><textarea name="notes" rows="2">${esc(i.notes)}</textarea></label>
      </form>
      <div class="form-actions"><span class="spacer"></span><button class="btn btn-danger" id="inc-del">🗑 Delete</button></div>`);
    autosave($('#inc-form', body), `/api/income/${i.id}`, saved => {
      $('.drawer-hero', body).innerHTML = `<div class="amt num pos">${money(saved.amount)}</div><div class="muted">${fmtDate(saved.date, true)}</div>`;
      $('.drawer-head h2', body).textContent = saved.source || 'Income';
      changed();
    });
    $('#inc-del', body).onclick = () => { closeDrawer(); deleteIncome(i); };
  }

  async function deleteIncome(i) {
    try {
      await api(`/api/income/${i.id}`, { method: 'DELETE' });
      toast(`🗑 Deleted income ${money(i.amount)}`, {
        undo: async () => { await api('/api/income', { method: 'POST', body: { date: i.date, source: i.source_id, description: i.description, amount: i.amount, received_via: i.received_via_id, notes: i.notes } }); changed(); },
      });
      changed();
    } catch (e) { fail(e); }
  }

  async function renderIncome(seq) {
    if (!S.inc.filters.from && !S.inc.filters.to && S.inc.range === 'month') Object.assign(S.inc.filters, rangeFilters('month'));
    const f = S.inc.filters;
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), sort: S.inc.sort, limit: 500 });
    const res = await api(`/api/income?${q}`);
    if (seq !== renderSeq) return;
    const rows = res.results;
    const bySrc = {};
    rows.forEach(r => { bySrc[r.source || 'Unspecified'] = (bySrc[r.source || 'Unspecified'] || 0) + r.amount; });
    const srcRows = Object.entries(bySrc).sort((a, b) => b[1] - a[1]);
    const ranges = [['month', `${MON[S.month - 1]} ${S.year}`], ['30', 'Last 30 days'], ['year', `Year ${S.year}`], ['all', 'All time']];
    const palette = ['#10b981', '#0ea5e9', '#6366f1', '#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6', '#64748b'];

    VIEWS.income.after = () => {
      const v = $('#view');
      const apply = debounce(() => refresh(), 220);
      $$('[data-f]', v).forEach(el => el.addEventListener('input', () => { f[el.dataset.f] = el.value; if (['from', 'to'].includes(el.dataset.f)) S.inc.range = 'custom'; apply(); }));
      $('.quick-ranges', v).onclick = e => { const b = e.target.closest('button'); if (!b) return; S.inc.range = b.dataset.r; Object.assign(f, rangeFilters(b.dataset.r)); refresh(); };
      $$('tr[data-id]', v).forEach(tr => tr.onclick = e => {
        const i = rows.find(x => x.id === Number(tr.dataset.id));
        if (e.target.closest('[data-del]')) return deleteIncome(i);
        openIncome(i);
      });
      $('[data-new]', v)?.addEventListener('click', () => quickAdd('income'));
      $$('[data-sort]', v).forEach(th => th.onclick = () => { S.inc.sort = S.inc.sort === '-' + th.dataset.sort ? th.dataset.sort : '-' + th.dataset.sort; refresh(); });
      const c = $('#ch-src');
      if (c && srcRows.length) chart(c, {
        type: 'doughnut',
        data: { labels: srcRows.map(r => r[0]), datasets: [{ data: srcRows.map(r => r[1]), backgroundColor: palette, borderWidth: 2, borderColor: css('--surface') }] },
        options: { maintainAspectRatio: false, cutout: '65%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: i => `${i.label}: ${money(i.raw)}` } } } },
      });
    };

    return `
      <div class="dash-grid">
        <div class="span-8">
          <div class="card" style="margin-bottom:16px">
            <div class="quick-ranges">${ranges.map(([r, l]) => `<button data-r="${r}" class="${S.inc.range === r ? 'on' : ''}">${l}</button>`).join('')}</div>
            <div class="filters" style="grid-template-columns:2fr 1fr 1fr 1.3fr">
              <input data-f="q" type="search" placeholder="🔍 Search description or notes" value="${esc(f.q || '')}">
              <input data-f="from" type="date" value="${f.from || ''}"><input data-f="to" type="date" value="${f.to || ''}">
              <select data-f="source"><option value="">All sources</option>${opts(S.lists.income_sources, f.source)}</select>
            </div>
            <div class="row"><span class="spacer"></span><a class="btn btn-sm" href="/export/income.csv">⬇ Export CSV</a><button class="btn btn-sm btn-primary" data-new>＋ Add income</button></div>
          </div>
          ${rows.length ? `<div class="card" style="padding-top:6px"><div class="table-wrap"><table class="t">
            <thead><tr><th class="sortable" data-sort="date">Date</th><th>Source</th><th class="hide-m">Description</th><th class="hide-m">Received via</th><th class="sortable right" data-sort="amount">Amount</th><th></th></tr></thead>
            <tbody>${rows.map(i => `<tr class="click ${S.flash === i.id ? 'flash' : ''}" data-id="${i.id}"><td class="num">${fmtDate(i.date)}</td><td><b>${esc(i.source || '—')}</b></td><td class="hide-m truncate" style="max-width:260px">${esc(i.description)}${i.notes ? `<div class="note">${esc(i.notes)}</div>` : ''}</td><td class="hide-m muted">${esc(i.received_via)}</td><td class="right num pos"><b>${money(i.amount)}</b></td><td class="right"><button class="icon-btn danger" data-del>🗑</button></td></tr>`).join('')}</tbody>
            <tfoot><tr><td colspan="4">Total · ${res.count} entr${res.count === 1 ? 'y' : 'ies'}</td><td class="right num pos">${money(res.total)}</td><td></td></tr></tfoot>
          </table></div></div>` : `<div class="card empty"><div class="big">💵</div><h3>No income in this range</h3><p>Record every payment you receive — salary, client payments, side income, gifts.</p><button class="btn btn-primary" data-new>＋ Add income</button></div>`}
        </div>
        <div class="span-4">
          <div class="card kpi" style="--accent:var(--income);margin-bottom:16px"><div class="label">Total in range</div><div class="value pos num">${money(res.total)}</div><div class="sub">${res.count} entries${res.count ? ' · avg ' + money(res.total / res.count, { exact: false }) : ''}</div></div>
          <div class="card"><div class="card-h"><h3>By source</h3></div>
            ${srcRows.length ? `<div class="chart-box short" style="height:180px"><canvas id="ch-src"></canvas></div><div class="legend" style="margin-top:12px">${srcRows.map((r, i) => `<div class="li"><span class="sw" style="background:${palette[i % palette.length]}"></span><span class="truncate">${esc(r[0])}</span><span class="num">${money(r[1], { exact: false })}</span></div>`).join('')}</div>` : '<p class="muted">Nothing yet.</p>'}
          </div>
        </div>
      </div>`;
  }

  // ================================================================== BUDGET
  async function renderBudget(seq) {
    const [b, d] = await Promise.all([api('/api/budgets'), api(`/api/dashboard?year=${S.year}&month=${S.month}`)]);
    if (seq !== renderSeq) return;
    const lines = b.results, L = S.lists;
    const budgeted = new Set(lines.map(x => x.category_id));
    const unbudgeted = d.categories.filter(c => c.id && !budgeted.has(c.id) && c.spent > 0);
    const totals = lines.reduce((a, x) => { const activeNow = (!x.starts || x.starts <= S.today) && (!x.ends || x.ends >= S.today); if (activeNow) { a.d += x.per_day; a.w += x.per_week; a.m += x.per_month; } return a; }, { d: 0, w: 0, m: 0 });

    VIEWS.budget.after = () => {
      const v = $('#view');
      $$('tr[data-id]', v).forEach(tr => {
        const id = tr.dataset.id;
        const send = async el => {
          try {
            const { item } = await api(`/api/budgets/${id}`, { method: 'PATCH', body: { [el.name]: el.value } });
            el.classList.remove('invalid');
            tr.querySelector('[data-pd]').textContent = money(item.per_day);
            tr.querySelector('[data-pw]').textContent = money(item.per_week, { exact: false });
            tr.querySelector('[data-pm]').textContent = money(item.per_month, { exact: false });
            toast('✓ Budget updated', { ms: 1500 });
            changed();
          } catch (e) { el.classList.add('invalid'); fail(e); }
        };
        $$('[name]', tr).forEach(el => el.addEventListener('change', () => send(el)));
        tr.querySelector('[data-del]').onclick = async () => {
          const line = lines.find(x => String(x.id) === id);
          try {
            await api(`/api/budgets/${id}`, { method: 'DELETE' });
            toast('🗑 Budget line removed', { undo: async () => { await api('/api/budgets', { method: 'POST', body: { category: line.category_id, period: line.period, amount: line.amount, starts: line.starts, ends: line.ends } }); changed(); } });
            changed();
          } catch (e) { fail(e); }
        };
      });
      const form = $('#b-new', v);
      form.onsubmit = async e => {
        e.preventDefault();
        try { await api('/api/budgets', { method: 'POST', body: formData(form) }); toast('🎯 Budget added'); changed(); } catch (err) { markInvalid(form, err); }
      };
      $$('[data-quick-budget]', v).forEach(btn => btn.onclick = async () => {
        try { await api('/api/budgets', { method: 'POST', body: { category: btn.dataset.quickBudget, period: 'Monthly', amount: Math.ceil(Number(btn.dataset.amt) / 100) * 100 } }); toast('🎯 Budget added'); changed(); } catch (err) { fail(err); }
      });
      $$('[data-cat]', v).forEach(el => el.onclick = () => openCategory(d.categories.find(c => String(c.id) === el.dataset.cat)));
    };

    const periodSel = (name, val) => `<select name="${name}">${['Daily', 'Weekly', 'Monthly'].map(p => `<option ${p === val ? 'selected' : ''}>${p}</option>`).join('')}</select>`;
    return `
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
        <div class="card kpi"><div class="label">${MON[S.month - 1]} budget</div><div class="value num">${money(d.kpi.budget, { exact: false })}</div><div class="sub">${d.days_in_month} days in month</div></div>
        <div class="card kpi" style="--accent:var(--expense)"><div class="label">Spent</div><div class="value num neg">${money(d.kpi.spent, { exact: false })}</div><div class="sub">${pct(d.kpi.budget_used)} used</div></div>
        <div class="card kpi" style="--accent:var(--income)"><div class="label">Remaining</div><div class="value num ${d.health.remaining < 0 ? 'neg' : 'pos'}">${money(d.health.remaining, { exact: false })}</div><div class="sub">${d.is_current ? `${money(d.health.safe_per_day, { exact: false })}/day for ${d.days_left} days` : esc(d.period_note)}</div></div>
        <div class="card kpi"><div class="label">Active lines today</div><div class="value num">${money(totals.d, { exact: false })}<span class="muted small"> /day</span></div><div class="sub">${money(totals.w, { exact: false })}/week · ${money(totals.m, { exact: false })}/month avg</div></div>
      </div>
      <div class="dash-grid">
        <div class="card span-12">
          <div class="card-h"><h3>Budget lines</h3><span class="spacer"></span><span class="muted small">Set once — repeats every month. Edits save instantly.</span></div>
          <p class="muted small" style="margin-top:-6px">Need to change a budget without altering past months? Put an <b>Ends</b> date on the old line and add a new line with a <b>Starts</b> date.</p>
          <div class="table-wrap"><table class="t">
            <thead><tr><th>Category</th><th>Period</th><th>Amount</th><th class="hide-m">Starts</th><th class="hide-m">Ends</th><th class="right hide-m">Per day</th><th class="right hide-m">Per week</th><th class="right">Per month</th><th></th></tr></thead>
            <tbody>${lines.map(x => `<tr data-id="${x.id}">
              <td class="edit" style="min-width:170px"><select name="category">${opts(L.categories, x.category_id)}</select></td>
              <td class="edit" style="min-width:105px">${periodSel('period', x.period)}</td>
              <td class="edit" style="min-width:110px"><input name="amount" inputmode="decimal" value="${x.amount}"></td>
              <td class="edit hide-m"><input type="date" name="starts" value="${x.starts}"></td>
              <td class="edit hide-m"><input type="date" name="ends" value="${x.ends}"></td>
              <td class="right num hide-m" data-pd>${money(x.per_day)}</td><td class="right num hide-m" data-pw>${money(x.per_week, { exact: false })}</td><td class="right num" data-pm>${money(x.per_month, { exact: false })}</td>
              <td><button class="icon-btn danger" data-del title="Remove">🗑</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">No budgets yet — add your first one below 👇</td></tr>'}</tbody>
          </table></div>
          <form id="b-new" class="row wrap" style="margin-top:14px;padding:12px;border:1px dashed var(--border);border-radius:12px">
            <select name="category" style="flex:2;min-width:160px">${opts(active(L.categories).filter(c => !budgeted.has(c.id)).concat(active(L.categories).filter(c => budgeted.has(c.id))), '', '— Category —')}</select>
            <div style="flex:1;min-width:100px">${periodSel('period', 'Monthly')}</div>
            <input name="amount" inputmode="decimal" placeholder="Amount" style="flex:1;min-width:100px">
            <input type="date" name="starts" title="Starts (optional)" style="flex:1;min-width:130px">
            <button class="btn btn-primary">＋ Add budget</button>
          </form>
          ${unbudgeted.length ? `<div class="banner banner-info" style="margin:14px 0 0;flex-direction:column"><b>💡 You spent on these without a budget this month:</b>
            <div class="row wrap">${unbudgeted.map(c => `<button class="btn btn-sm" data-quick-budget="${c.id}" data-amt="${c.spent}">${esc(c.icon)} ${esc(c.name)} · budget ${money(Math.ceil(c.spent / 100) * 100, { exact: false })}/mo</button>`).join('')}</div></div>` : ''}
        </div>
        <div class="card span-12">
          <div class="card-h"><h3>This month vs budget</h3></div>
          <div class="cat-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:6px 22px">${d.categories.filter(c => c.budget > 0).map(c => `<div data-cat="${c.id}" style="padding:8px 4px;cursor:pointer">
            <div class="row" style="margin-bottom:5px"><span class="truncate">${esc(c.icon)} ${esc(c.name)}</span><span class="spacer"></span>${pill(c.status)}</div>
            ${bar(c.pct, c.status, d.is_current ? d.days_elapsed / d.days_in_month : null)}
            <div class="row small muted" style="margin-top:3px"><span class="num">${money(c.spent, { exact: false })} / ${money(c.budget, { exact: false })}</span><span class="spacer"></span><span class="num">${pct(c.pct)}</span></div></div>`).join('') || '<p class="muted">Add budget lines to see progress here.</p>'}</div>
        </div>
      </div>`;
  }

  // ================================================================== GOALS
  async function renderGoals(seq) {
    const res = await api('/api/goals');
    if (seq !== renderSeq) return;
    const goals = res.results;
    const tSaved = goals.reduce((a, g) => a + g.saved, 0), tTarget = goals.reduce((a, g) => a + g.target, 0);
    VIEWS.goals.after = () => {
      const v = $('#view');
      $$('[data-new]', v).forEach(b => b.onclick = () => goalModal());
      $$('[data-goal]', v).forEach(card => {
        const g = goals.find(x => String(x.id) === card.dataset.goal);
        card.querySelector('[data-edit]').onclick = () => goalModal(g);
        card.querySelector('[data-add]').onclick = () => contributeModal(g);
        card.querySelector('[data-del]').onclick = async () => {
          try { await api(`/api/goals/${g.id}`, { method: 'DELETE' }); toast(`🗑 Deleted goal “${g.name}”`, { undo: async () => { await api('/api/goals', { method: 'POST', body: g }); changed(); } }); changed(); } catch (e) { fail(e); }
        };
      });
    };
    return `
      <div class="row wrap" style="margin-bottom:16px">
        <div class="card kpi" style="flex:1;min-width:220px;--accent:var(--income)"><div class="label">Saved across goals</div><div class="value num pos">${money(tSaved, { exact: false })}</div><div class="sub">of ${money(tTarget, { exact: false })} · ${pct(tTarget ? tSaved / tTarget : 0)}</div></div>
        <button class="btn btn-primary" data-new>＋ New goal</button>
      </div>
      ${goals.length ? `<div class="goals">${goals.map(g => `
        <div class="card goal" data-goal="${g.id}">
          <div class="goal-top"><div class="ring" style="--p:${Math.min(g.pct * 100, 100)};--c:${esc(g.color)}"><span>${pct(g.pct)}</span></div>
            <div style="min-width:0;flex:1"><h3 class="truncate">${esc(g.icon)} ${esc(g.name)}</h3><div class="num" style="font-weight:750;font-size:17px;margin-top:2px">${money(g.saved, { exact: false })} <span class="muted small">/ ${money(g.target, { exact: false })}</span></div></div></div>
          <div class="muted small">${g.pct >= 1 ? '🎉 Goal reached!' : g.deadline ? (g.days_left >= 0 ? `${g.days_left} days left (${fmtDate(g.deadline)}) · save <b>${money(g.per_month_needed, { exact: false })}/month</b> to make it` : `Deadline passed (${fmtDate(g.deadline)})`) : `${money(g.target - g.saved, { exact: false })} to go`}</div>
          <div class="row"><button class="btn btn-sm btn-primary" data-add>＋ Add money</button><button class="btn btn-sm" data-edit>Edit</button><span class="spacer"></span><button class="icon-btn danger" data-del>🗑</button></div>
        </div>`).join('')}</div>`
        : `<div class="card empty"><div class="big">🏆</div><h3>Save towards something</h3><p>Emergency fund, school fees, a trip, a new phone… set a target and watch it grow.</p><button class="btn btn-primary" data-new>＋ Create your first goal</button></div>`}`;
  }

  function goalModal(g) {
    const m = openModal(`<h2>${g ? 'Edit goal' : 'New savings goal'}</h2>
      <form class="form-stack" id="g-form">
        <div class="row"><label class="field" style="width:70px"><span>Icon</span><input name="icon" value="${esc(g?.icon || '🎯')}" maxlength="4" style="text-align:center"></label>
          <label class="field" style="flex:1"><span>Name</span><input name="name" value="${esc(g?.name || '')}" placeholder="e.g. Emergency fund" autofocus></label>
          <label class="field"><span>Colour</span><input type="color" name="color" value="${esc(g?.color || '#6366f1')}"></label></div>
        <div class="grid-2"><label class="field"><span>Target (${esc(cur())})</span><input name="target" inputmode="decimal" value="${g?.target ?? ''}"></label>
          <label class="field"><span>Already saved</span><input name="saved" inputmode="decimal" value="${g?.saved ?? 0}"></label></div>
        <label class="field"><span>Deadline (optional)</span><input type="date" name="deadline" value="${g?.deadline || ''}"></label>
        <div class="form-actions"><span class="spacer"></span><button type="button" class="btn btn-ghost" data-close-modal>Cancel</button><button class="btn btn-primary">${g ? 'Save' : 'Create goal'}</button></div>
      </form>`);
    const form = $('#g-form', m);
    form.onsubmit = async e => {
      e.preventDefault();
      try { await api(g ? `/api/goals/${g.id}` : '/api/goals', { method: g ? 'PATCH' : 'POST', body: formData(form) }); closeModal(); toast(g ? '✓ Goal saved' : '🏆 Goal created'); changed(); } catch (err) { markInvalid(form, err); }
    };
  }

  function contributeModal(g) {
    const m = openModal(`<h2>${esc(g.icon)} ${esc(g.name)}</h2>
      <form class="form-stack" id="c-form">
        <div class="seg" id="c-mode"><button type="button" class="on" data-m="add">＋ Add</button><button type="button" data-m="withdraw">− Withdraw</button></div>
        <div class="amount-input"><span class="cur">${esc(cur())}</span><input name="amount" inputmode="decimal" placeholder="0" autofocus></div>
        <label class="row small" id="c-log"><input type="checkbox" name="log_transaction"> Also record it as money going out (spending) today</label>
        <label class="field hidden" id="c-cat"><span>Category for the spending entry</span><select name="category">${opts(active(S.lists.categories), S.lists.categories.find(c => /loan|saving|other/i.test(c.name))?.id, '— Uncategorised —')}</select></label>
        <div class="form-actions"><span class="spacer"></span><button type="button" class="btn btn-ghost" data-close-modal>Cancel</button><button class="btn btn-primary">Save</button></div>
      </form>`);
    const form = $('#c-form', m);
    let mode = 'add';
    $('#c-mode', m).onclick = e => { const b = e.target.closest('button'); if (!b) return; mode = b.dataset.m; $$('#c-mode button', m).forEach(x => x.classList.toggle('on', x === b)); $('#c-log', m).classList.toggle('hidden', mode !== 'add'); };
    form.log_transaction.onchange = () => $('#c-cat', m).classList.toggle('hidden', !form.log_transaction.checked);
    form.onsubmit = async e => {
      e.preventDefault();
      const f = formData(form);
      try {
        await api(`/api/goals/${g.id}/contribute`, { method: 'POST', body: { amount: (mode === 'withdraw' ? '-' : '') + f.amount, log_transaction: !!f.log_transaction, category: f.category } });
        closeModal(); toast(mode === 'add' ? `💰 Added ${money(Number(f.amount.replace(/,/g, '')))} to ${g.name}` : 'Withdrawn'); changed();
      } catch (err) { markInvalid(form, err); }
    };
  }

  // ================================================================== RECURRING
  async function renderRecurring(seq) {
    const res = await api('/api/recurring');
    if (seq !== renderSeq) return;
    const rows = res.results;
    const monthly = (r) => r.frequency === 'weekly' ? r.amount * 52 / 12 : r.frequency === 'yearly' ? r.amount / 12 : r.amount;
    const outM = rows.filter(r => r.active && r.kind === 'expense').reduce((a, r) => a + monthly(r), 0);
    const inM = rows.filter(r => r.active && r.kind === 'income').reduce((a, r) => a + monthly(r), 0);
    VIEWS.recurring.after = () => {
      const v = $('#view');
      $$('[data-new]', v).forEach(b => b.onclick = () => recurringModal());
      $$('tr[data-id]', v).forEach(tr => {
        const r = rows.find(x => String(x.id) === tr.dataset.id);
        tr.onclick = async e => {
          if (e.target.closest('[data-post]')) {
            try { await api(`/api/recurring/${r.id}/post`, { method: 'POST' }); toast(`✓ Recorded ${r.name} · ${money(r.amount)}`); changed(); } catch (err) { fail(err); }
          } else if (e.target.closest('[data-toggle]')) {
            try { await api(`/api/recurring/${r.id}`, { method: 'PATCH', body: { active: !r.active } }); changed(); } catch (err) { fail(err); }
          } else if (e.target.closest('[data-del]')) {
            try { await api(`/api/recurring/${r.id}`, { method: 'DELETE' }); toast(`🗑 Removed ${r.name}`); changed(); } catch (err) { fail(err); }
          } else recurringModal(r);
        };
      });
    };
    return `
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
        <div class="card kpi" style="--accent:var(--expense)"><div class="label">Fixed costs / month</div><div class="value num neg">${money(outM, { exact: false })}</div><div class="sub">bills, subscriptions, chama…</div></div>
        <div class="card kpi" style="--accent:var(--income)"><div class="label">Regular income / month</div><div class="value num pos">${money(inM, { exact: false })}</div><div class="sub">salary, rent received…</div></div>
        <div class="card kpi"><div class="label">Left after fixed costs</div><div class="value num ${inM - outM < 0 ? 'neg' : ''}">${money(inM - outM, { exact: false })}</div><div class="sub">per month</div></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>Recurring items</h3><span class="spacer"></span><button class="btn btn-primary btn-sm" data-new>＋ Add recurring</button></div>
        <p class="muted small" style="margin-top:-6px"><b>Auto</b> items are recorded for you automatically on their due date. <b>Reminder</b> items show on the dashboard — tap “Record now” when you pay.</p>
        ${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Type</th><th class="right">Amount</th><th class="hide-m">Every</th><th>Next due</th><th class="hide-m">Mode</th><th></th></tr></thead>
          <tbody>${rows.map(r => `<tr class="click" data-id="${r.id}" style="${r.active ? '' : 'opacity:.5'}">
            <td><b>${esc(r.name)}</b><div class="note">${esc(r.kind === 'income' ? r.source : r.category)}${r.payment_method ? ' · ' + esc(r.payment_method) : ''}</div></td>
            <td>${r.kind === 'income' ? '<span class="pill OK">Income</span>' : '<span class="pill OVER">Expense</span>'}</td>
            <td class="right num ${r.kind === 'income' ? 'pos' : 'neg'}"><b>${money(r.amount)}</b></td>
            <td class="hide-m">${r.frequency[0].toUpperCase() + r.frequency.slice(1)}</td>
            <td class="num">${fmtDate(r.next_date)}${r.next_date < S.today ? ' <span class="pill OVER">Due</span>' : ''}</td>
            <td class="hide-m">${r.auto_post ? '⚡ Auto' : '🔔 Reminder'}</td>
            <td class="right" style="white-space:nowrap"><button class="btn btn-sm" data-post>Record now</button><button class="icon-btn" data-toggle title="${r.active ? 'Pause' : 'Resume'}">${r.active ? '⏸' : '▶'}</button><button class="icon-btn danger" data-del>🗑</button></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div class="big">🔁</div><h3>No recurring items yet</h3><p>Add rent, Netflix, school fees or your salary once — never type them again.</p><button class="btn btn-primary" data-new>＋ Add recurring</button></div>`}
      </div>`;
  }

  function recurringModal(r) {
    const L = S.lists;
    const m = openModal(`<h2>${r ? 'Edit recurring item' : 'New recurring item'}</h2>
      <form class="form-stack" id="r-form">
        <div class="seg kind" id="r-kind"><button type="button" data-kind="expense">💸 Expense</button><button type="button" data-kind="income">💵 Income</button></div>
        <input type="hidden" name="kind" value="${r?.kind || 'expense'}">
        <label class="field"><span>Name</span><input name="name" value="${esc(r?.name || '')}" placeholder="e.g. Rent, Netflix, Salary" autofocus></label>
        <div class="grid-2">
          <label class="field"><span>Amount (${esc(cur())})</span><input name="amount" inputmode="decimal" value="${r?.amount ?? ''}"></label>
          <label class="field"><span>Repeats</span><select name="frequency">${[['monthly', 'Monthly'], ['weekly', 'Weekly'], ['yearly', 'Yearly']].map(([v, l]) => `<option value="${v}" ${r?.frequency === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>Next due date</span><input type="date" name="next_date" value="${r?.next_date || S.today}"></label>
          <label class="field"><span>Paid / received via</span><select name="payment_method">${opts(active(L.payment_methods), r?.payment_method_id, '—')}</select></label>
        </div>
        <label class="field r-exp"><span>Category</span><select name="category">${opts(active(L.categories), r?.category_id, '—')}</select></label>
        <label class="field r-inc"><span>Income source</span><select name="source">${opts(active(L.income_sources), r?.source_id, '—')}</select></label>
        <label class="row small"><input type="checkbox" name="auto_post" ${!r || r.auto_post ? 'checked' : ''}> Record automatically on the due date</label>
        <div class="form-actions"><span class="spacer"></span><button type="button" class="btn btn-ghost" data-close-modal>Cancel</button><button class="btn btn-primary">${r ? 'Save' : 'Add'}</button></div>
      </form>`);
    const form = $('#r-form', m);
    const setKind = k => { form.kind.value = k; $$('#r-kind button', m).forEach(b => b.classList.toggle('on', b.dataset.kind === k)); $('.r-exp', m).classList.toggle('hidden', k !== 'expense'); $('.r-inc', m).classList.toggle('hidden', k !== 'income'); };
    setKind(form.kind.value);
    $('#r-kind', m).onclick = e => { const b = e.target.closest('button'); if (b) setKind(b.dataset.kind); };
    form.onsubmit = async e => {
      e.preventDefault();
      const body = { ...formData(form), auto_post: form.auto_post.checked };
      try {
        await api(r ? `/api/recurring/${r.id}` : '/api/recurring', { method: r ? 'PATCH' : 'POST', body });
        closeModal(); toast(r ? '✓ Saved' : '🔁 Recurring item added'); changed();
      } catch (err) { markInvalid(form, err); }
    };
  }

  // ================================================================== YEAR VIEW
  async function renderYear(seq) {
    const d = await api(`/api/year?year=${S.yearSel}`);
    if (seq !== renderSeq) return;
    const t = d.total;
    const cats = {};
    d.category_months.forEach(r => { (cats[r.name] ||= { ...r, months: Array(12).fill(0), total: 0 }); cats[r.name].months[r.month - 1] += r.amount; cats[r.name].total += r.amount; });
    const catRows = Object.values(cats).sort((a, b) => b.total - a.total);
    const maxCell = Math.max(1, ...catRows.flatMap(c => c.months));
    VIEWS.year.after = () => {
      chart($('#ch-year'), {
        data: {
          labels: MON,
          datasets: [
            { type: 'bar', label: 'Income', data: d.months.map(m => m.income), backgroundColor: css('--income'), borderRadius: 6, maxBarThickness: 26 },
            { type: 'bar', label: 'Spent', data: d.months.map(m => m.spent), backgroundColor: css('--expense'), borderRadius: 6, maxBarThickness: 26 },
            { type: 'line', label: 'Budget', data: d.months.map(m => m.budget || null), borderColor: css('--warn'), borderDash: [6, 4], pointRadius: 0, borderWidth: 2 },
            { type: 'line', label: 'Net savings', data: d.months.map(m => m.net), borderColor: css('--primary'), backgroundColor: css('--primary'), tension: .35, pointRadius: 3 },
          ],
        },
        options: {
          maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { callbacks: { label: i => `${i.dataset.label}: ${money(i.raw)}` } } },
          scales: { y: { ticks: { callback: moneyTick } }, x: { grid: { display: false } } },
          onClick: (e, els) => { if (els.length) { S.year = S.yearSel; location.hash = '#/dashboard'; setPeriod(S.yearSel, els[0].index + 1); } },
        },
      });
      $$('tr[data-m]').forEach(tr => tr.onclick = () => { location.hash = '#/dashboard'; setPeriod(S.yearSel, Number(tr.dataset.m)); });
    };
    return `
      <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
        <div class="card kpi" style="--accent:var(--income)"><div class="label">Income ${d.year}</div><div class="value num pos">${money(t.income, { exact: false })}</div></div>
        <div class="card kpi" style="--accent:var(--expense)"><div class="label">Spent ${d.year}</div><div class="value num neg">${money(t.spent, { exact: false })}</div></div>
        <div class="card kpi"><div class="label">Net savings</div><div class="value num ${t.net >= 0 ? 'pos' : 'neg'}">${money(t.net, { exact: false })}</div><div class="sub">Savings rate ${pct(t.savings_rate)}</div></div>
        <div class="card kpi"><div class="label">Budget used</div><div class="value num">${pct(t.budget_used)}</div><div class="sub">of ${money(t.budget, { exact: false })} ${pill(t.status)}</div></div>
      </div>
      <div class="card" style="margin-bottom:16px"><div class="card-h"><h3>Month by month</h3><span class="spacer"></span><span class="muted small">Click a month to open its dashboard</span></div><div class="chart-box tall"><canvas id="ch-year"></canvas></div></div>
      <div class="card" style="margin-bottom:16px"><div class="table-wrap"><table class="t">
        <thead><tr><th>Month</th><th class="right">Income</th><th class="right">Spent</th><th class="right">Net savings</th><th class="right hide-m">Savings rate</th><th class="right hide-m">Budget</th><th class="right">Budget used</th><th>Status</th></tr></thead>
        <tbody>${d.months.map(m => `<tr class="click" data-m="${m.month}"><td><b>${m.name}</b></td><td class="right num pos">${money(m.income, { exact: false })}</td><td class="right num neg">${money(m.spent, { exact: false })}</td><td class="right num ${m.net >= 0 ? '' : 'neg'}">${money(m.net, { exact: false })}</td><td class="right num hide-m">${pct(m.savings_rate)}</td><td class="right num hide-m">${money(m.budget, { exact: false })}</td><td class="right num">${pct(m.budget_used)}</td><td>${pill(m.status)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>YEAR TOTAL</td><td class="right num pos">${money(t.income, { exact: false })}</td><td class="right num neg">${money(t.spent, { exact: false })}</td><td class="right num">${money(t.net, { exact: false })}</td><td class="right num hide-m">${pct(t.savings_rate)}</td><td class="right num hide-m">${money(t.budget, { exact: false })}</td><td class="right num">${pct(t.budget_used)}</td><td>${pill(t.status)}</td></tr></tfoot>
      </table></div></div>
      ${catRows.length ? `<div class="card"><div class="card-h"><h3>Spending by category & month</h3></div><div class="table-wrap"><table class="t" style="font-size:12.5px">
        <thead><tr><th>Category</th>${MON.map(x => `<th class="right">${x}</th>`).join('')}<th class="right">Total</th></tr></thead>
        <tbody>${catRows.map(c => `<tr><td style="white-space:nowrap">${esc(c.icon)} ${esc(c.name)}</td>${c.months.map(v => `<td class="right num" style="${v ? `background:color-mix(in srgb, ${c.color} ${Math.round(8 + 50 * v / maxCell)}%, transparent)` : ''}">${v ? moneyTick(v) : '<span class="muted">·</span>'}</td>`).join('')}<td class="right num"><b>${money(c.total, { exact: false })}</b></td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  }

  // ================================================================== SETTINGS
  async function renderSettings() {
    const L = S.lists;
    const editor = (kind, items, withIcon) => `<div class="list-editor" data-kind="${kind}">
      ${items.map((o, i) => `<div class="le-row ${o.archived ? 'archived' : ''}" data-id="${o.id}">
        ${withIcon ? `<input class="icon" data-k="icon" value="${esc(o.icon)}" maxlength="4"><input type="color" data-k="color" value="${esc(o.color)}" style="width:34px;height:34px">` : ''}
        <input class="name" data-k="name" value="${esc(o.name)}">
        ${withIcon ? `<span class="uses" title="Transactions">${o.uses || ''}</span>` : ''}
        <button class="icon-btn" data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="icon-btn" data-archive title="${o.archived ? 'Show in pickers again' : 'Hide from pickers (keeps history)'}">${o.archived ? '👁' : '🙈'}</button>
        <button class="icon-btn danger" data-del title="Delete">🗑</button></div>`).join('')}
      <form class="le-row le-add" style="margin-top:6px">${withIcon ? '<input class="icon" name="icon" placeholder="📦" maxlength="4"><input type="color" name="color" value="#6366f1" style="width:34px;height:34px">' : ''}<input class="name" name="name" placeholder="Add new…"><button class="btn btn-sm">Add</button></form>
    </div>`;

    VIEWS.settings.after = () => {
      const v = $('#view');
      $$('.list-editor', v).forEach(ed => {
        const kind = ed.dataset.kind;
        const listKey = { categories: 'categories', methods: 'payment_methods', sources: 'income_sources' }[kind];
        $$('.le-row[data-id]', ed).forEach(row => {
          const id = row.dataset.id;
          const o = L[listKey].find(x => String(x.id) === id);
          $$('[data-k]', row).forEach(inp => inp.addEventListener('change', async () => {
            try { await api(`/api/lists/${kind}/${id}`, { method: 'PATCH', body: { [inp.dataset.k]: inp.value } }); toast('✓ Saved', { ms: 1200 }); changed({ lists: true }); } catch (e) { inp.classList.add('invalid'); fail(e); }
          }));
          row.querySelector('[data-archive]').onclick = async () => { await api(`/api/lists/${kind}/${id}`, { method: 'PATCH', body: { archived: !o.archived } }).catch(fail); changed({ lists: true }); };
          row.querySelector('[data-del]').onclick = async () => {
            const msg = o.uses ? `“${o.name}” is used by ${o.uses} transaction(s). They will become Uncategorised. Tip: hide it instead (🙈). Delete anyway?` : `Delete “${o.name}”?`;
            if (!confirm(msg)) return;
            await api(`/api/lists/${kind}/${id}`, { method: 'DELETE' }).catch(fail); toast('🗑 Deleted'); changed({ lists: true });
          };
          row.querySelector('[data-move]').onclick = async () => {
            const ids = L[listKey].map(x => x.id);
            const i = ids.indexOf(Number(id));
            if (i > 0) { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; await api(`/api/lists/${kind}/reorder`, { method: 'POST', body: { ids } }).catch(fail); changed({ lists: true }); }
          };
        });
        $('.le-add', ed).onsubmit = async e => {
          e.preventDefault();
          const f = formData(e.target);
          if (!f.name.trim()) return;
          try { await api(`/api/lists/${kind}`, { method: 'POST', body: f }); toast(`＋ Added “${f.name}”`); changed({ lists: true }); } catch (err) { markInvalid(e.target, err); }
        };
      });
      const pf = $('#prefs', v);
      $$('[name]', pf).forEach(inp => inp.addEventListener('change', async () => {
        try { await api('/api/settings', { method: 'PATCH', body: { [inp.name]: inp.name === 'warn_pct' ? inp.value / 100 : inp.value } }); toast('✓ Saved', { ms: 1200 }); changed({ lists: true }); } catch (e) { markInvalid(pf, e); }
      }));
      const wp = $('[name=warn_pct]', pf);
      wp.addEventListener('input', () => { $('#warn-val').textContent = wp.value + '%'; });
      $$('[data-theme-set]', v).forEach(b => b.onclick = () => setTheme(b.dataset.themeSet));

      const dz = $('#dropzone', v), file = $('#imp-file', v);
      dz.onclick = () => file.click();
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) doImport(e.dataTransfer.files[0]); };
      file.onchange = () => file.files[0] && doImport(file.files[0]);
    };

    const theme = document.documentElement.dataset.theme || 'auto';
    return `
      <div class="set-grid">
        <div class="card"><div class="card-h"><h3>🏷 Expense categories</h3></div><p class="muted small" style="margin-top:-6px">Rename, recolour, reorder. Hide a category instead of deleting it to keep old transactions tidy.</p>${editor('categories', L.categories, true)}</div>
        <div class="card"><div class="card-h"><h3>💳 Payment methods</h3></div>${editor('methods', L.payment_methods)}
          <div class="card-h" style="margin-top:22px"><h3>💼 Income sources</h3></div>${editor('sources', L.income_sources)}</div>
        <div class="cards">
          <div class="card" id="prefs"><div class="card-h"><h3>⚙️ Preferences</h3></div>
            <div class="form-stack">
              <label class="field"><span>Currency code</span><input name="currency" value="${esc(L.currency)}" maxlength="8"></label>
              <label class="field"><span>Warn me when budget used reaches <b id="warn-val">${Math.round(L.warn_pct * 100)}%</b></span><input type="range" name="warn_pct" min="50" max="100" step="5" value="${Math.round(L.warn_pct * 100)}"></label>
              <p class="muted small" style="margin:0">At or above this level a category shows <span class="pill Watch">Watch</span>. Above 100% it shows <span class="pill OVER">OVER</span>.</p>
              <div class="field"><span>Theme</span><div class="seg">${[['auto', '🖥 Auto'], ['light', '☀️ Light'], ['dark', '🌙 Dark']].map(([k, l]) => `<button type="button" data-theme-set="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
            </div></div>
          <div class="card"><div class="card-h"><h3>📥 Import</h3></div>
            <div class="dropzone" id="dropzone"><div style="font-size:28px">📄</div><b>Drop your Money Tracker .xlsx here</b><div class="muted small">or click to choose · also accepts a .csv of transactions</div></div>
            <input type="file" id="imp-file" accept=".xlsx,.xlsm,.csv" class="hidden">
            <label class="row small" style="margin-top:8px">CSV contains <select id="imp-kind" style="width:auto"><option value="transactions">transactions</option><option value="income">income</option></select></label>
            <div id="imp-result"></div></div>
          <div class="card"><div class="card-h"><h3>📤 Export & backup</h3></div>
            <div class="form-stack"><a class="btn" href="/export/backup.xlsx">⬇ Full backup (.xlsx, same layout as the workbook)</a>
              <a class="btn" href="/export/transactions.csv">⬇ Transactions (.csv)</a><a class="btn" href="/export/income.csv">⬇ Income (.csv)</a>
              <p class="muted small" style="margin:0">Tip: back up at month-end. The .xlsx can be imported again.</p></div></div>
          <div class="card"><div class="card-h"><h3>⌨️ Keyboard shortcuts</h3></div>${shortcutsHTML()}</div>
        </div>
      </div>`;
  }

  async function doImport(f) {
    const out = $('#imp-result');
    out.innerHTML = '<div class="banner banner-info" style="margin:12px 0 0">⏳ Importing…</div>';
    const fd = new FormData();
    fd.append('file', f);
    fd.append('kind', $('#imp-kind').value);
    try {
      const { summary: s } = await api('/api/import', { method: 'POST', form: fd });
      out.innerHTML = `<div class="banner banner-ok" style="margin:12px 0 0">✅ Imported ${s.transactions ?? 0} transactions, ${s.income ?? 0} income entries${s.budgets != null ? `, ${s.budgets} budget lines` : ''}${s.new_list_items ? `, ${s.new_list_items} new list items` : ''}.${s.skipped ? ` Skipped ${s.skipped} incomplete rows.` : ''}</div>`;
      changed({ lists: true });
    } catch (e) { out.innerHTML = `<div class="banner banner-danger" style="margin:12px 0 0">${esc(e.message)}</div>`; }
  }

  // ================================================================== theme / shortcuts / boot
  function setTheme(t) {
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    try { if (t === 'auto') localStorage.removeItem('mt-theme'); else localStorage.setItem('mt-theme', t); } catch (e) { /* ignore */ }
    refresh();
  }
  $('#theme-btn').onclick = () => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(dark ? 'light' : 'dark');
  };

  const shortcutsHTML = () => `<div class="shortcuts">
    <span class="kbd">N</span><span>New expense</span><span class="kbd">I</span><span>New income</span>
    <span class="kbd">/</span><span>Search transactions</span><span class="kbd">[</span><span>Previous month</span>
    <span class="kbd">]</span><span>Next month</span><span class="kbd">T</span><span>Jump to this month</span>
    <span class="kbd">1</span><span>…</span><span class="kbd">8</span><span>Switch tabs</span>
    <span class="kbd">D</span><span>Dark / light mode</span><span class="kbd">Shift ↵</span><span>Save & add another</span>
    <span class="kbd">Esc</span><span>Close panel</span></div>`;
  $('#help-btn').onclick = () => openModal(`<h2>Keyboard shortcuts</h2>${shortcutsHTML()}<div class="form-actions"><span class="spacer"></span><button class="btn" data-close-modal>Close</button></div>`);
  $('#menu-btn').onclick = () => { $('.sidebar').classList.add('open'); showScrim(true); };

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if ($('#modal-wrap').classList.contains('on')) closeModal(); else closeDrawer(); $('.sidebar').classList.remove('open'); return; }
    if (e.target.closest('input,select,textarea,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#modal-wrap').classList.contains('on')) return;
    const k = e.key;
    const views = Object.keys(VIEWS);
    if (k === 'n' || k === 'N') { e.preventDefault(); quickAdd('expense'); }
    else if (k === 'i' || k === 'I') { e.preventDefault(); quickAdd('income'); }
    else if (k === '/') { e.preventDefault(); S.focusSearch = true; if (S.view === 'transactions') $('[data-f=q]')?.focus(); else location.hash = '#/transactions'; }
    else if (k === '[') stepPeriod(-1);
    else if (k === ']') stepPeriod(1);
    else if (k === 't' || k === 'T') setPeriod(now.getFullYear(), now.getMonth() + 1);
    else if (k === 'd' || k === 'D') $('#theme-btn').click();
    else if (k === '?') $('#help-btn').click();
    else if (/^[1-8]$/.test(k)) location.hash = '#/' + views[Number(k) - 1];
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => refresh());

  async function boot() {
    try {
      const b = await api('/api/bootstrap');
      S.lists = b; S.rev = b.revision; S.today = b.today;
      const p = store.get('mt-period');
      if (p && p.at === S.today) { S.year = p.y; S.month = p.m; }
      $('#username').textContent = b.username;
      $('#avatar').textContent = (b.username[0] || '?').toUpperCase();
      if (b.recurring_posted) setTimeout(() => toast(`🔁 ${b.recurring_posted} recurring item${b.recurring_posted === 1 ? ' was' : 's were'} recorded automatically`), 600);
      route();
      // Roll over to the new day/month automatically if the tab stays open past midnight.
      setInterval(() => { const t = iso(new Date()); if (t !== S.today) { S.today = t; api('/api/bootstrap').then(() => pullChanges(false)); } }, 60000);
    } catch (e) {
      $('#view').innerHTML = `<div class="card empty"><div class="big">⚠️</div><h3>Couldn't start the app</h3><p>${esc(e.message)}</p></div>`;
    }
  }
  boot();
})();
