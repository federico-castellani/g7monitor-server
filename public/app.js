// G7 Monitor web: vanilla JS, no dependencies (strict CSP: only same-origin scripts).

const MMOL = 18.0182;
const DEFAULTS = { unit: 'mgdl', low: 70, high: 180, hours: 6 };
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ preferences (per browser)

function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('g7prefs') ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
const prefs = loadPrefs();
function savePrefs() {
  try { localStorage.setItem('g7prefs', JSON.stringify(prefs)); } catch { /* private mode */ }
}

// ------------------------------------------------------------------ API

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/api/auth/')) showLogin();
  if (res.status === 403 && data?.error === 'cambio_password_richiesto') showForcePassword();
  if (!res.ok) {
    throw Object.assign(new Error(data?.message ?? `Errore ${res.status}`), { code: data?.error, status: res.status });
  }
  return data;
}

// ------------------------------------------------------------------ formatting

const isMmol = () => prefs.unit === 'mmol';
const unitLabel = () => (isMmol() ? 'mmol/L' : 'mg/dL');
const nf1 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const timeFmt = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function fmt(mgdl) {
  if (mgdl <= 39) return 'LOW';
  if (mgdl >= 401) return 'HIGH';
  return isMmol() ? nf1.format(mgdl / MMOL) : String(Math.round(mgdl));
}
function fmtDelta(d) {
  const sign = d >= 0 ? '+' : '−';
  return sign + (isMmol() ? nf1.format(Math.abs(d) / MMOL) : Math.abs(d));
}
const rangeClass = (v) => (v < prefs.low ? 'low' : v > prefs.high ? 'high' : 'in');

/** Same thresholds as the app (mg/dL per minute). */
function trend(rate) {
  if (rate == null) return null;
  if (rate >= 3) return { arrow: '⇈', label: 'In rapida salita' };
  if (rate >= 2) return { arrow: '↑', label: 'In salita' };
  if (rate >= 1) return { arrow: '↗', label: 'In leggera salita' };
  if (rate > -1) return { arrow: '→', label: 'Stabile' };
  if (rate > -2) return { arrow: '↘', label: 'In leggera discesa' };
  if (rate > -3) return { arrow: '↓', label: 'In discesa' };
  return { arrow: '⇊', label: 'In rapida discesa' };
}

const roleLabel = (u) => (u.role === 'admin' ? 'Amministratore' : u.canWrite ? 'Utente · lettura e caricamento' : 'Utente · solo lettura');

// ------------------------------------------------------------------ state

let me = null;
/** Sorted by time: { t: ms, v: mg/dL, r: mg/dL/min | null } */
let readings = [];
/** Blood glucose meter results, sorted by time: { t: ms, v: mg/dL, meter } */
let fingersticks = [];
let stream = null;
let geom = null; // chart geometry, for touch inspection

const toReading = ([ts, mgdl, trend10]) => ({ t: ts * 1000, v: mgdl, r: trend10 == null ? null : trend10 / 10 });

async function loadReadings() {
  const to = Math.floor(Date.now() / 1000) + 600;
  const from = to - 600 - prefs.hours * 3600;
  const data = await api(`/api/readings?from=${from}&to=${to}`);
  readings = data.r.map(toReading);
  fingersticks = (data.f ?? []).map(toFingerstick);
  render();
}

const toFingerstick = ([ts, mgdl, meter]) => ({ t: ts * 1000, v: mgdl, meter });

function mergeFingersticks(rows) {
  const start = Date.now() - prefs.hours * 3600e3;
  const all = [...fingersticks, ...rows.map(toFingerstick)].filter((f) => f.t >= start);
  const seen = new Set();
  fingersticks = all.sort((a, b) => a.t - b.t).filter((f) => !seen.has(`${f.t}:${f.v}`) && seen.add(`${f.t}:${f.v}`));
  render();
}

function merge(rows) {
  const byTime = new Map(readings.map((r) => [r.t, r]));
  for (const row of rows) {
    const r = toReading(row);
    byTime.set(r.t, r);
  }
  const start = Date.now() - prefs.hours * 3600e3;
  readings = [...byTime.values()].filter((r) => r.t >= start).sort((a, b) => a.t - b.t);
  render();
}

// ------------------------------------------------------------------ live updates (SSE)

function setLive(on) {
  $('live').classList.toggle('on', on);
}

function connectStream() {
  stream?.close();
  const es = new EventSource('/api/readings/stream');
  let missed = false;
  es.onopen = () => {
    setLive(true);
    if (missed) loadReadings().catch(() => {}); // fill the gap while disconnected
    missed = false;
  };
  es.onmessage = (e) => merge(JSON.parse(e.data));
  es.addEventListener('fingerstick', (e) => mergeFingersticks(JSON.parse(e.data)));
  es.onerror = () => {
    setLive(false);
    missed = true;
    // The browser retries by itself, except after an HTTP error (e.g. expired session).
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(() => {
        if (stream === es) api('/api/me').then(connectStream).catch(() => {});
      }, 15_000);
    }
  };
  stream = es;
}

// ------------------------------------------------------------------ rendering

function render() {
  renderHero();
  renderChart();
  renderStats();
}

function renderHero() {
  const hero = $('hero');
  const last = readings.at(-1);
  $('cur-unit').textContent = unitLabel();
  if (!last) {
    hero.className = 'card hero stale';
    $('cur-value').textContent = '––';
    $('cur-arrow').textContent = '';
    $('cur-trend').textContent = 'Nessuna lettura recente';
    $('cur-delta').textContent = '';
    $('cur-ago').textContent = '';
    document.title = 'G7 Monitor';
    return;
  }
  const minutes = Math.floor((Date.now() - last.t) / 60_000);
  const stale = minutes >= 15;
  const tr = stale ? null : trend(last.r);
  hero.className = `card hero ${stale ? 'stale' : rangeClass(last.v)}`;
  $('cur-value').textContent = fmt(last.v);
  $('cur-arrow').textContent = tr?.arrow ?? '';
  $('cur-trend').textContent = stale ? 'Dato non aggiornato' : tr?.label ?? '';
  const prev = readings.at(-2);
  $('cur-delta').textContent = prev && last.t - prev.t < 12 * 60_000 ? `${fmtDelta(last.v - prev.v)} ${unitLabel()}` : '';
  $('cur-ago').textContent = minutes < 1 ? 'adesso' : minutes < 60 ? `${minutes} min fa` : `alle ${timeFmt.format(last.t)}`;
  const finger = fingersticks.at(-1);
  $('cur-finger').textContent = finger ? `Glucometro ${fmt(finger.v)} alle ${timeFmt.format(finger.t)}` : '';
  document.title = `${fmt(last.v)}${tr ? ' ' + tr.arrow : ''} · G7 Monitor`;
}

function renderChart() {
  const el = $('chart');
  const W = el.clientWidth, H = el.clientHeight;
  if (!W || !H) return;
  let svg = el.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.prepend(svg);
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const padL = 34, padR = 6, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const now = Date.now();
  const span = prefs.hours * 3600e3;
  const start = now - span, end = now + span / 30;
  const visible = readings.filter((r) => r.t >= start && r.t <= end);
  const values = visible.map((r) => r.v);
  const maxV = values.length ? Math.max(...values) : 0;
  const minV = values.length ? Math.min(...values) : 400;
  const yMax = Math.min(400, Math.max(250, (Math.floor((maxV + 25) / 50) + 1) * 50));
  const yMin = Math.max(30, Math.min(40, minV - 10));
  const x = (t) => padL + ((t - start) / (end - start)) * plotW;
  const y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;
  const f = (n) => n.toFixed(1);
  const out = [];

  // target band and limits
  out.push(`<rect class="band" x="${padL}" y="${f(y(prefs.high))}" width="${plotW}" height="${f(y(prefs.low) - y(prefs.high))}" rx="6"/>`);
  // horizontal grid
  const step = isMmol() ? 3 * MMOL : 50;
  for (let v = (Math.floor(yMin / step) + 1) * step; v < yMax; v += step) {
    out.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${f(y(v))}" y2="${f(y(v))}"/>`);
    out.push(`<text class="axis" x="${padL - 6}" y="${f(y(v) + 4)}" text-anchor="end">${isMmol() ? Math.round(v / MMOL) : v}</text>`);
  }
  for (const v of [prefs.low, prefs.high]) {
    out.push(`<line class="limit" x1="${padL}" x2="${W - padR}" y1="${f(y(v))}" y2="${f(y(v))}"/>`);
  }
  // time axis: hours, or days for the weekly view
  const days = prefs.hours > 24;
  const hourStep = { 3: 1, 6: 1, 12: 2, 24: 4 }[prefs.hours] ?? 24;
  const t0 = new Date(start);
  t0.setMinutes(0, 0, 0);
  for (let t = t0.getTime() + 3600e3; t < end; t += 3600e3) {
    const d = new Date(t);
    if (days ? d.getHours() !== 0 : d.getHours() % hourStep !== 0) continue;
    const xx = x(t);
    if (xx < padL + 12 || xx > W - padR - 12) continue;
    out.push(`<line class="vgrid" x1="${f(xx)}" x2="${f(xx)}" y1="${padT}" y2="${padT + plotH}"/>`);
    out.push(`<text class="axis" x="${f(xx)}" y="${H - 4}" text-anchor="middle">${days ? dayFmt.format(d) : timeFmt.format(d)}</text>`);
  }

  if (!visible.length) {
    out.push(`<text class="empty" x="${padL + plotW / 2}" y="${padT + plotH / 2}" text-anchor="middle">Nessuna lettura in questo intervallo</text>`);
  } else {
    // trace, broken on gaps longer than 12 minutes
    let d = '';
    let prev = null;
    for (const r of visible) {
      d += `${prev && r.t - prev.t <= 12 * 60_000 ? 'L' : 'M'}${f(x(r.t))} ${f(y(r.v))}`;
      prev = r;
    }
    out.push(`<path class="trace" d="${d}"/>`);
    const radius = prefs.hours <= 6 ? 3.2 : prefs.hours <= 24 ? 2.4 : 1.5;
    for (const r of visible) {
      out.push(`<circle class="${rangeClass(r.v)}" cx="${f(x(r.t))}" cy="${f(y(r.v))}" r="${radius}"/>`);
    }
  }
  // meter results: outlined diamond with its value
  for (const s of fingersticks) {
    if (s.t < start || s.t > end) continue;
    const cx = x(s.t), cy = y(Math.min(Math.max(s.v, yMin), yMax)), h = 6;
    out.push(`<path class="finger ${rangeClass(s.v)}" d="M${f(cx)} ${f(cy - h)}L${f(cx + h)} ${f(cy)}L${f(cx)} ${f(cy + h)}L${f(cx - h)} ${f(cy)}Z"/>`);
    out.push(`<text class="axis finger-label" x="${f(cx)}" y="${f(Math.max(cy - h - 4, 10))}" text-anchor="middle">${fmt(s.v)}</text>`);
  }
  out.push(`<line class="now" x1="${f(x(now))}" x2="${f(x(now))}" y1="${padT}" y2="${padT + plotH}"/>`);
  out.push('<g id="cursor"></g>');
  svg.innerHTML = out.join('');
  geom = { x, y, visible, padT, plotH, W };
  $('tip').hidden = true;
}

function inspect(clientX) {
  if (!geom?.visible.length) return;
  const rect = $('chart').getBoundingClientRect();
  const px = clientX - rect.left;
  const v = geom.visible;
  // binary search on x
  let lo = 0, hi = v.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (geom.x(v[mid].t) < px) lo = mid + 1; else hi = mid;
  }
  const r = lo > 0 && Math.abs(geom.x(v[lo - 1].t) - px) < Math.abs(geom.x(v[lo].t) - px) ? v[lo - 1] : v[lo];
  const cx = geom.x(r.t), cy = geom.y(r.v);
  document.getElementById('cursor').innerHTML =
    `<line class="cursor" x1="${cx}" x2="${cx}" y1="${geom.padT}" y2="${geom.padT + geom.plotH}"/>` +
    `<circle class="focus ${rangeClass(r.v)}" cx="${cx}" cy="${cy}" r="6"/>`;
  const tip = $('tip');
  tip.textContent = `${fmt(r.v)} ${unitLabel()} · ${(prefs.hours > 24 ? dateTimeFmt : timeFmt).format(r.t)}`;
  tip.hidden = false;
  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(Math.max(cx, half), geom.W - half)}px`;
}

function stopInspect() {
  const c = document.getElementById('cursor');
  if (c) c.innerHTML = '';
  $('tip').hidden = true;
}

function renderStats() {
  const v = readings.filter((r) => r.t >= Date.now() - prefs.hours * 3600e3).map((r) => r.v);
  $('stats-span').textContent = prefs.hours > 24 ? 'ultimi 7 giorni' : `ultime ${prefs.hours} ore`;
  const set = (id, text) => { $(id).textContent = text; };
  const bars = $('tir').querySelectorAll('.tir-bar i');
  if (!v.length) {
    for (const id of ['tir-low', 'tir-in', 'tir-high', 'st-avg', 'st-gmi', 'st-cv']) set(id, '–');
    set('st-n', '0');
    bars.forEach((b) => { b.style.width = '0'; });
    return;
  }
  const n = v.length;
  const low = v.filter((x) => x < prefs.low).length / n;
  const high = v.filter((x) => x > prefs.high).length / n;
  const inR = 1 - low - high;
  const avg = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - avg) ** 2, 0) / n);
  const pct = (p) => `${Math.round(p * 100)}%`;
  [low, inR, high].forEach((p, i) => { bars[i].style.width = `${p * 100}%`; });
  set('tir-low', pct(low));
  set('tir-in', pct(inR));
  set('tir-high', pct(high));
  set('st-avg', `${fmt(avg)} ${unitLabel()}`);
  set('st-gmi', `${nf1.format(3.31 + 0.02392 * avg)}%`);
  set('st-cv', `${Math.round((sd / avg) * 100)}%`);
  set('st-n', String(n));
}

// ------------------------------------------------------------------ views

function showOnly(id) {
  for (const v of ['login', 'force-pw', 'app']) $(v).hidden = v !== id;
  for (const d of ['settings', 'users']) if ($(d).open) $(d).close();
}

function showLogin() {
  stream?.close();
  stream = null;
  me = null;
  readings = [];
  showOnly('login');
  document.title = 'G7 Monitor';
  $('login-form').elements.username.focus();
}

function showForcePassword() {
  stream?.close();
  stream = null;
  showOnly('force-pw');
  const form = $('force-pw-form');
  form.elements.username.value = me?.username ?? '';
  form.elements.current.focus();
}

function showApp() {
  showOnly('app');
  $('open-users').hidden = me.role !== 'admin';
  markPressed($('window'), 'h', String(prefs.hours));
  connectStream();
  loadReadings().catch(() => {});
}

async function boot() {
  try {
    me = await api('/api/me');
  } catch {
    showLogin();
    return;
  }
  if (me.mustChangePassword) showForcePassword();
  else showApp();
}

function markPressed(group, key, value) {
  for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[key] === value));
}

function button(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn small ${cls}`;
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

// ------------------------------------------------------------------ settings sheet

const EVENTS = {
  accesso_web: 'Accesso dal web',
  password_errata: 'Password errata',
  codice_2fa_errato: 'Codice di verifica errato',
  login_bloccato: 'Accesso bloccato (troppi tentativi)',
  dispositivo_aggiunto: 'Telefono collegato',
  dispositivo_rimosso: 'Telefono rimosso',
  password_cambiata: 'Password cambiata',
  cambio_password_fallito: 'Cambio password fallito',
  disconnessione_ovunque: 'Uscita da tutti i browser',
  account_creato: 'Account creato',
  account_creato_da_admin: 'Account creato da',
  password_reimpostata: 'Password reimpostata da',
  ruolo_cambiato: 'Ruolo cambiato in',
  scrittura_consentita: 'Caricamento consentito da',
  solo_lettura: 'Impostato in sola lettura da',
  utente_creato: 'Hai creato l\'utente',
  utente_modificato: 'Hai modificato l\'utente',
  utente_eliminato: 'Hai eliminato l\'utente',
  password_utente_reimpostata: 'Hai reimpostato la password di',
  '2fa_attivata': 'Verifica in due passaggi attivata',
  '2fa_disattivata': 'Verifica in due passaggi disattivata',
};
/** Events whose detail is a name worth showing (never a user agent). */
const WITH_DETAIL = new Set([
  'dispositivo_aggiunto', 'account_creato_da_admin', 'password_reimpostata', 'ruolo_cambiato', 'scrittura_consentita',
  'solo_lettura', 'utente_creato', 'utente_modificato', 'utente_eliminato', 'password_utente_reimpostata',
]);

function li(main, sub, ...buttons) {
  const item = document.createElement('li');
  const text = document.createElement('div');
  const strong = document.createElement('span');
  strong.textContent = main;
  text.append(strong);
  if (sub) {
    const small = document.createElement('small');
    small.textContent = sub;
    text.append(small);
  }
  item.append(text);
  if (buttons.length) {
    const actions = document.createElement('span');
    actions.className = 'actions';
    actions.append(...buttons);
    item.append(actions);
  }
  return item;
}

function emptyItem(text) {
  const item = document.createElement('li');
  item.className = 'empty';
  item.textContent = text;
  return item;
}

async function loadDevices() {
  const devices = await api('/api/devices');
  const admin = me.role === 'admin';
  $('devices').replaceChildren(...(devices.length ? devices.map((d) => {
    const reader = d.kind === 'reader';
    const remove = button('Rimuovi', 'danger-outline', async () => {
      const effect = reader ? 'smetterà di ricevere' : 'smetterà di caricare';
      if (!confirm(`Rimuovere "${d.name}"? Il telefono ${effect} le glicemie finché non viene ricollegato.`)) return;
      await api(`/api/devices/${d.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
      loadDevices();
    });
    const last = d.lastUsed ? `ultimo contatto ${dateTimeFmt.format(d.lastUsed * 1000)}` : 'mai usato';
    const who = admin ? `${d.username} · ` : '';
    return li(`${d.name} · ${reader ? 'riceve' : 'carica'}`, `${who}collegato il ${dateTimeFmt.format(d.createdAt * 1000)} · ${last}`, remove);
  }) : [emptyItem('Nessun telefono collegato')]));
}

async function loadActivity() {
  const items = await api('/api/activity');
  $('activity').replaceChildren(...(items.length ? items.map((a) => {
    const label = EVENTS[a.event] ?? a.event;
    const what = WITH_DETAIL.has(a.event) && a.detail ? `${label} ${a.detail}` : label;
    return li(what, `${dateTimeFmt.format(a.at * 1000)}${a.ip ? ' · ' + a.ip : ''}`);
  }) : [emptyItem('Nessuna attività')]));
}

function openSettings() {
  markPressed($('unit-seg'), 'unit', prefs.unit);
  $('range-low').value = prefs.low;
  $('range-high').value = prefs.high;
  $('account-info').textContent = `Accesso come ${me.username} · ${roleLabel(me)}`;
  $('devices-help').textContent = me.role === 'admin'
    ? 'Tutti i telefoni collegati: quelli che caricano le glicemie dal sensore e quelli che le ricevono. Rimuovili qui se vengono persi.'
    : 'I tuoi telefoni collegati dall\'app G7 Monitor. Rimuovili qui se li perdi.';
  $('twofa').textContent = me.totp
    ? 'Verifica in due passaggi attiva.'
    : 'Verifica in due passaggi non attiva: si attiva dal server con "npm run user -- totp-on".';
  $('pw-form').elements.username.value = me.username;
  $('pw-msg').textContent = '';
  $('settings').showModal();
  loadDevices().catch(() => {});
  loadActivity().catch(() => {});
}

// ------------------------------------------------------------------ user management (admins)

function usersMessage(text, ok = false) {
  const m = $('users-msg');
  m.className = ok ? 'error ok' : 'error';
  m.textContent = text;
}

function randomPassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

async function loadUsers() {
  const users = await api('/api/admin/users');
  $('user-list').replaceChildren(...users.map((u) => {
    const self = u.id === me.id;
    const item = document.createElement('li');
    item.className = 'user';

    const head = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = self ? `${u.username} (tu)` : u.username;
    const info = document.createElement('small');
    const last = u.lastLoginAt ? `ultimo accesso ${dateTimeFmt.format(u.lastLoginAt * 1000)}` : 'mai entrato';
    info.textContent = [last, u.mustChangePassword ? 'password temporanea' : '', u.totp ? '2FA' : '', u.locked ? 'BLOCCATO' : '']
      .filter(Boolean).join(' · ');
    head.append(name, info);

    const controls = document.createElement('div');
    controls.className = 'user-controls';

    const role = document.createElement('select');
    role.className = 'compact-select';
    role.setAttribute('aria-label', `Ruolo di ${u.username}`);
    role.innerHTML = '<option value="user">Utente</option><option value="admin">Amministratore</option>';
    role.value = u.role;
    role.disabled = self;
    role.onchange = () => update(u, { role: role.value });

    const writeLabel = document.createElement('label');
    writeLabel.className = 'check';
    const write = document.createElement('input');
    write.type = 'checkbox';
    write.checked = u.role === 'admin' || u.canWrite;
    write.disabled = u.role === 'admin';
    write.onchange = () => update(u, { canWrite: write.checked });
    writeLabel.append(write, document.createTextNode(' Può caricare'));

    controls.append(role, writeLabel);
    if (u.locked) controls.append(button('Sblocca', '', () => update(u, { unlock: true })));
    if (!self) {
      controls.append(button('Reimposta password', '', async () => {
        const pw = randomPassword();
        if (!confirm(`Impostare per "${u.username}" la password temporanea ${pw} ?\nVerrà disconnesso ovunque e dovrà sceglierne una nuova al prossimo accesso.`)) return;
        try {
          await api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: { password: pw } });
          usersMessage(`Password temporanea di ${u.username}: ${pw}`, true);
          loadUsers();
        } catch (e) { usersMessage(e.message); }
      }));
      controls.append(button('Elimina', 'danger-outline', async () => {
        if (!confirm(`Eliminare l'utente "${u.username}"? I suoi telefoni smetteranno di caricare. Le glicemie restano.`)) return;
        try {
          await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
          usersMessage(`Utente ${u.username} eliminato`, true);
          loadUsers();
        } catch (e) { usersMessage(e.message); }
      }));
    }
    item.append(head, controls);
    return item;
  }));
}

async function update(u, body) {
  try {
    await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
    usersMessage(`${u.username} aggiornato`, true);
  } catch (e) {
    usersMessage(e.message);
  }
  loadUsers().catch(() => {});
}

function openUsers() {
  usersMessage('');
  const form = $('new-user');
  form.reset();
  form.password.value = randomPassword();
  $('users').showModal();
  loadUsers().catch((e) => usersMessage(e.message));
}

// ------------------------------------------------------------------ events

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button');
  const err = $('login-error');
  const body = { username: form.username.value.trim(), password: form.password.value };
  if (!$('totp-field').hidden && form.totp.value) body.totp = form.totp.value.trim();
  btn.disabled = true;
  err.textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body });
    form.reset();
    $('totp-field').hidden = true;
    await boot();
  } catch (ex) {
    if (ex.code === 'totp_richiesto') {
      $('totp-field').hidden = false;
      form.totp.focus();
    }
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

async function changePassword(form, msg) {
  msg.className = 'error';
  if (form.next.value !== form.again.value) {
    msg.textContent = 'Le nuove password non coincidono';
    return false;
  }
  try {
    me = await api('/api/me/password', { method: 'POST', body: { current: form.current.value, next: form.next.value } });
    form.reset();
    return true;
  } catch (ex) {
    msg.textContent = ex.message;
    return false;
  }
}

$('force-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await changePassword(e.currentTarget, $('force-pw-msg'))) showApp();
});
$('force-pw-logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('window').addEventListener('click', (e) => {
  const h = e.target.closest('button')?.dataset.h;
  if (!h) return;
  prefs.hours = Number(h);
  savePrefs();
  markPressed($('window'), 'h', h);
  loadReadings().catch(() => {});
});

const chart = $('chart');
chart.addEventListener('pointerdown', (e) => inspect(e.clientX));
chart.addEventListener('pointermove', (e) => inspect(e.clientX));
chart.addEventListener('pointerleave', stopInspect);
chart.addEventListener('pointercancel', stopInspect);
new ResizeObserver(() => renderChart()).observe(chart);

$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', () => $('settings').close());
$('open-users').addEventListener('click', openUsers);
$('close-users').addEventListener('click', () => $('users').close());
for (const id of ['settings', 'users']) {
  $(id).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close(); // click on the backdrop
  });
}

$('unit-seg').addEventListener('click', (e) => {
  const unit = e.target.closest('button')?.dataset.unit;
  if (!unit) return;
  prefs.unit = unit;
  savePrefs();
  markPressed($('unit-seg'), 'unit', unit);
  render();
});

for (const id of ['range-low', 'range-high']) {
  $(id).addEventListener('change', () => {
    const low = Number($('range-low').value), high = Number($('range-high').value);
    if (low >= 54 && high <= 300 && low < high) {
      prefs.low = low;
      prefs.high = high;
      savePrefs();
      render();
    } else {
      $('range-low').value = prefs.low;
      $('range-high').value = prefs.high;
    }
  });
}

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('pw-msg');
  if (await changePassword(e.currentTarget, msg)) {
    msg.className = 'error ok';
    msg.textContent = 'Password cambiata. Gli altri browser dovranno accedere di nuovo.';
    loadActivity().catch(() => {});
  }
});

$('logout-all').addEventListener('click', async () => {
  if (!confirm('Uscire da tutti i browser, compreso questo? I telefoni collegati continuano a caricare le glicemie.')) return;
  await api('/api/me/logout-all', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('gen-pw').addEventListener('click', () => { $('new-user').password.value = randomPassword(); });

$('new-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const body = {
    username: form.username.value.trim(),
    password: form.password.value,
    role: form.role.value,
    canWrite: form.canWrite.checked,
  };
  try {
    await api('/api/admin/users', { method: 'POST', body });
    usersMessage(`Utente ${body.username} creato. Password temporanea: ${body.password} (dovrà cambiarla al primo accesso)`, true);
    form.reset();
    form.password.value = randomPassword();
    loadUsers().catch(() => {});
  } catch (ex) {
    usersMessage(ex.message);
  }
});

// Mobile browsers suspend background tabs: refresh when the page comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !me || $('app').hidden) return;
  loadReadings().catch(() => {});
  if (!stream || stream.readyState === EventSource.CLOSED) connectStream();
});

setInterval(() => { if (me && !$('app').hidden) render(); }, 30_000);

boot();
