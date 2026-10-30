// G7 Monitor web: glucose reports, computed in the browser from the readings of the period.
// Modelled on the Ambulatory Glucose Profile (AGP) and on the international consensus on
// time in range (2019): fixed ranges 54 / 70 / 180 / 250 mg/dL, whatever the personal target.

const g7 = window.g7;
const $ = (id) => document.getElementById(id);
const DAY = 86_400_000;
const STEP = 300_000; // the G7 reads every 5 minutes

const VLOW = 54, LOW = 70, HIGH = 180, VHIGH = 250, TIGHT = 140;
const BANDS = [
  { key: 'vhigh', label: 'Molto alta', range: () => `> ${g7.fmt(VHIGH)}`, test: (v) => v > VHIGH },
  { key: 'high', label: 'Alta', range: () => `${g7.fmt(HIGH + 1)}–${g7.fmt(VHIGH)}`, test: (v) => v > HIGH && v <= VHIGH },
  { key: 'in', label: 'Nel range', range: () => `${g7.fmt(LOW)}–${g7.fmt(HIGH)}`, test: (v) => v >= LOW && v <= HIGH },
  { key: 'low', label: 'Bassa', range: () => `${g7.fmt(VLOW)}–${g7.fmt(LOW - 1)}`, test: (v) => v >= VLOW && v < LOW },
  { key: 'vlow', label: 'Molto bassa', range: () => `< ${g7.fmt(VLOW)}`, test: (v) => v < VLOW },
];
const PARTS = [
  { label: 'Notte', from: 0, to: 6 },
  { label: 'Mattina', from: 6, to: 12 },
  { label: 'Pomeriggio', from: 12, to: 18 },
  { label: 'Sera', from: 18, to: 24 },
];

const dateFmt = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const pct0 = (p) => `${Math.round(p)}%`;
const pct1 = (p) => `${p < 10 && p > 0 ? p.toFixed(1).replace('.', ',') : Math.round(p)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let days = Number(localStorage.getItem('g7report')) || 14;
let data = null; // { start, end, r, f, prev: { start, end, r } }
let loading = false;

// ------------------------------------------------------------------ data

const toReading = ([ts, v]) => ({ t: ts * 1000, v });
const toStick = ([ts, v, meter]) => ({ t: ts * 1000, v, meter });

async function load() {
  if (loading) return;
  loading = true;
  $('rep-body').innerHTML = '<section class="card"><p class="muted">Calcolo del report…</p></section>';
  try {
    const end = Date.now();
    const start = startOfDay(end - (days - 1) * DAY);
    const prevStart = start - days * DAY;
    const s = (ms) => Math.floor(ms / 1000);
    const [cur, prev] = await Promise.all([
      g7.api(`/api/readings?from=${s(start)}&to=${s(end)}`),
      g7.api(`/api/readings?from=${s(prevStart)}&to=${s(start) - 1}`),
    ]);
    data = {
      start, end,
      r: cur.r.map(toReading), f: (cur.f ?? []).map(toStick),
      prev: { start: prevStart, end: start, r: prev.r.map(toReading) },
    };
    render();
  } catch (e) {
    $('rep-body').innerHTML = `<section class="card"><p class="error">Report non disponibile: ${esc(e.message)}</p></section>`;
  } finally {
    loading = false;
  }
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ------------------------------------------------------------------ statistics

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Episodes of at least 15 minutes (consensus definition) in which test(v) holds. */
function episodes(r, test) {
  const out = [];
  let cur = null;
  for (const x of r) {
    if (test(x.v) && (!cur || x.t - cur.last <= 12 * 60_000)) {
      if (!cur) cur = { start: x.t, last: x.t, min: x.v, max: x.v };
      cur.last = x.t;
      cur.min = Math.min(cur.min, x.v);
      cur.max = Math.max(cur.max, x.v);
    } else {
      if (cur && cur.last - cur.start + STEP >= 15 * 60_000) out.push(cur);
      cur = test(x.v) ? { start: x.t, last: x.t, min: x.v, max: x.v } : null;
    }
  }
  if (cur && cur.last - cur.start + STEP >= 15 * 60_000) out.push(cur);
  return out;
}

function metrics(r, start, end) {
  const n = r.length;
  const expected = Math.max(1, (Math.min(end, Date.now()) - start) / STEP);
  if (!n) return { n, wear: 0 };
  const v = r.map((x) => x.v);
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const share = (test) => (v.filter(test).length / n) * 100;
  const bands = Object.fromEntries(BANDS.map((b) => [b.key, share(b.test)]));
  return {
    n,
    wear: Math.min(100, (n / expected) * 100),
    mean, sd,
    cv: (sd / mean) * 100,
    gmi: 3.31 + 0.02392 * mean,
    bands,
    tir: bands.in,
    tbr: bands.low + bands.vlow,
    tar: bands.high + bands.vhigh,
    tight: share((x) => x >= LOW && x <= TIGHT),
    min: Math.min(...v),
    max: Math.max(...v),
    lows: episodes(r, (x) => x < LOW),
    highs: episodes(r, (x) => x > VHIGH),
  };
}

/** What the sensor read at time t: interpolated between the readings around it (same rule as the app). */
function sensorAt(r, t) {
  let lo = 0, hi = r.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const after = r[lo], before = r[lo - 1];
  if (after?.t === t) return after.v;
  if (before && after && after.t - before.t <= 12 * 60_000) {
    return Math.round(before.v + ((after.v - before.v) * (t - before.t)) / (after.t - before.t));
  }
  const near = [before, after].filter((x) => x && Math.abs(x.t - t) <= 5 * 60_000);
  return near.length ? near.reduce((a, b) => (Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b)).v : null;
}

const minuteOfDay = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };

/** AGP: percentiles 5/25/50/75/95 by time of day, in 30-minute slots, lightly smoothed. */
function agp(r) {
  const SLOTS = 48;
  const slots = Array.from({ length: SLOTS }, () => []);
  for (const x of r) slots[Math.floor(minuteOfDay(x.t) / 30)].push(x.v);
  const raw = slots.map((s) => {
    const sorted = [...s].sort((a, b) => a - b);
    return sorted.length >= 3 ? [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => percentile(sorted, p)) : null;
  });
  // 1-2-1 smoothing across neighbouring slots (circular: 23:30 is next to 00:00)
  return raw.map((p, i) => {
    if (!p) return null;
    const a = raw[(i + SLOTS - 1) % SLOTS] ?? p, b = raw[(i + 1) % SLOTS] ?? p;
    return p.map((v, k) => (a[k] + 2 * v + b[k]) / 4);
  });
}

// ------------------------------------------------------------------ formatting helpers

function duration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
/** A spread (SD), not a glucose value: no LOW/HIGH, mg/dL or mmol/L as chosen. */
const spread = (mgdl) => (g7.isMmol() ? `${(mgdl / 18.0182).toFixed(1).replace('.', ',')} mmol/L` : `${Math.round(mgdl)} mg/dL`);
const perDay = (pct) => `${duration((pct / 100) * 1440)} al giorno`;
const glucose = (v) => `${g7.fmt(v)} ${g7.unitLabel()}`;

function status(ok) {
  return ok ? '<span class="goal ok">obiettivo raggiunto</span>' : '<span class="goal no">sopra l\'obiettivo</span>';
}

// ------------------------------------------------------------------ sections

function summarySection(m) {
  const tile = (label, value, note = '', cls = '') =>
    `<div class="tile ${cls}"><span>${label}</span><b>${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;
  return `
  <section class="card">
    <div class="card-head"><h2>Parametri principali</h2></div>
    <div class="tiles">
      ${tile('Glicemia media', glucose(m.mean))}
      ${tile('GMI (HbA1c stimata)', `${m.gmi.toFixed(1).replace('.', ',')}%`, `${Math.round((m.gmi - 2.152) * 10.929)} mmol/mol`)}
      ${tile('Variabilità (CV)', pct0(m.cv), 'obiettivo ≤ 36%', m.cv <= 36 ? 'good' : 'bad')}
      ${tile('Deviazione standard', spread(m.sd))}
      ${tile('Uso del sensore', pct0(m.wear), 'servono almeno 70%', m.wear >= 70 ? 'good' : 'bad')}
      ${tile(`Range stretto ${g7.fmt(LOW)}–${g7.fmt(TIGHT)}`, pct0(m.tight), 'come chi non ha il diabete: ~96%')}
    </div>
  </section>`;
}

function rangesSection(m) {
  const b = m.bands;
  const order = [...BANDS];
  // SVG, not inline styles: the page's CSP allows no style attributes.
  let top = 0;
  const bar = `<svg class="range-bar" viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true">${order.map((x) => {
    const h = b[x.key];
    const rect = `<rect class="f-${x.key}" x="0" y="${top.toFixed(2)}" width="10" height="${h.toFixed(2)}"><title>${x.label} ${pct1(h)}</title></rect>`;
    top += h;
    return rect;
  }).join('')}</svg>`;
  const rows = order.map((x) => `
      <tr>
        <td><i class="dot b-${x.key}"></i>${x.label}<small>${x.range()} ${g7.unitLabel()}</small></td>
        <td class="num"><b>${pct1(b[x.key])}</b></td>
        <td class="muted">${perDay(b[x.key])}</td>
      </tr>`).join('');
  return `
  <section class="card">
    <div class="card-head"><h2>Tempo negli intervalli</h2></div>
    <div class="ranges">
      ${bar}
      <table class="range-table"><tbody>${rows}</tbody></table>
    </div>
    <ul class="goals">
      <li><b>Nel range</b> ${pct0(m.tir)} · obiettivo oltre 70% ${m.tir > 70 ? status(true) : '<span class="goal no">sotto l\'obiettivo</span>'}</li>
      <li><b>Sotto ${g7.fmt(LOW)}</b> ${pct1(m.tbr)} · obiettivo meno del 4% ${status(m.tbr < 4)}</li>
      <li><b>Sotto ${g7.fmt(VLOW)}</b> ${pct1(b.vlow)} · obiettivo meno dell'1% ${status(b.vlow < 1)}</li>
      <li><b>Sopra ${g7.fmt(HIGH)}</b> ${pct0(m.tar)} · obiettivo meno del 25% ${status(m.tar < 25)}</li>
      <li><b>Sopra ${g7.fmt(VHIGH)}</b> ${pct1(b.vhigh)} · obiettivo meno del 5% ${status(b.vhigh < 5)}</li>
    </ul>
  </section>`;
}

function agpSection(r) {
  const p = agp(r);
  const W = 720, H = 280, L = 40, R = 10, T = 10, B = 26;
  const yMin = 40, yMax = 350;
  const x = (slot) => L + (slot / 48) * (W - L - R);
  const y = (v) => T + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (H - T - B);
  const f = (n) => n.toFixed(1);
  const out = [];
  out.push(`<rect class="agp-target" x="${L}" y="${f(y(HIGH))}" width="${W - L - R}" height="${f(y(LOW) - y(HIGH))}"/>`);
  for (const v of [VLOW, LOW, HIGH, VHIGH]) {
    out.push(`<line class="agp-limit l${v}" x1="${L}" x2="${W - R}" y1="${f(y(v))}" y2="${f(y(v))}"/>`);
    out.push(`<text class="agp-axis" x="${L - 6}" y="${f(y(v) + 4)}" text-anchor="end">${g7.fmt(v)}</text>`);
  }
  for (let h = 0; h <= 24; h += 3) {
    const xx = x(h * 2);
    out.push(`<line class="agp-vgrid" x1="${f(xx)}" x2="${f(xx)}" y1="${T}" y2="${H - B}"/>`);
    out.push(`<text class="agp-axis" x="${f(xx)}" y="${H - 8}" text-anchor="middle">${String(h % 24).padStart(2, '0')}:00</text>`);
  }
  // Bands are drawn per run of slots with data (gaps stay empty).
  const runs = [];
  let run = [];
  p.forEach((v, i) => { if (v) run.push(i); else if (run.length) { runs.push(run); run = []; } });
  if (run.length) runs.push(run);
  const area = (lo, hi, cls) => {
    for (const s of runs) {
      const pts = [...s.map((i) => `${f(x(i + 0.5))},${f(y(p[i][hi]))}`), ...[...s].reverse().map((i) => `${f(x(i + 0.5))},${f(y(p[i][lo]))}`)];
      out.push(`<polygon class="${cls}" points="${pts.join(' ')}"/>`);
    }
  };
  area(0, 4, 'agp-outer');
  area(1, 3, 'agp-inner');
  for (const s of runs) {
    out.push(`<polyline class="agp-median" points="${s.map((i) => `${f(x(i + 0.5))},${f(y(p[i][2]))}`).join(' ')}"/>`);
  }
  if (!runs.length) out.push(`<text class="agp-axis" x="${W / 2}" y="${H / 2}" text-anchor="middle">Dati insufficienti</text>`);
  return `
  <section class="card wide">
    <div class="card-head">
      <h2>Profilo glicemico ambulatoriale (AGP)</h2>
      <div class="legend">
        <span><i class="sw agp-median-sw"></i>mediana</span>
        <span><i class="sw agp-inner"></i>25–75%</span>
        <span><i class="sw agp-outer"></i>5–95%</span>
      </div>
    </div>
    <p class="muted small">Tutti i giorni del periodo sovrapposti in un'unica giornata: la linea è il valore tipico a quell'ora,
      le fasce mostrano quanto varia da un giorno all'altro. Fasce larghe = orari poco prevedibili.</p>
    <svg class="agp" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profilo glicemico per ora del giorno">${out.join('')}</svg>
  </section>`;
}

function patternsSection(r, m) {
  const rows = PARTS.map((part) => {
    const inPart = (t) => { const h = new Date(t).getHours(); return h >= part.from && h < part.to; };
    const v = r.filter((x) => inPart(x.t)).map((x) => x.v).sort((a, b) => a - b);
    return {
      ...part,
      median: percentile(v, 0.5),
      tir: v.length ? (v.filter((x) => x >= LOW && x <= HIGH).length / v.length) * 100 : null,
      lows: m.lows.filter((e) => inPart(e.start)),
      highs: m.highs.filter((e) => inPart(e.start)),
    };
  });
  const notes = [];
  const most = (key) => rows.reduce((a, b) => (b[key].length > a[key].length ? b : a));
  const lowPart = most('lows');
  if (m.lows.length && lowPart.lows.length >= Math.max(2, m.lows.length / 2)) {
    notes.push(`Le glicemie basse sono più frequenti di <b>${lowPart.label.toLowerCase()}</b> (${lowPart.lows.length} su ${m.lows.length}).`);
  }
  const severe = m.lows.filter((e) => e.min < VLOW).length;
  if (severe) notes.push(`<b>${severe}</b> ${severe === 1 ? 'episodio' : 'episodi'} sotto ${glucose(VLOW)}: da valutare con il diabetologo.`);
  const highPart = most('highs');
  if (m.highs.length && highPart.highs.length >= Math.max(2, m.highs.length / 2)) {
    notes.push(`Le glicemie sopra ${glucose(VHIGH)} si concentrano di <b>${highPart.label.toLowerCase()}</b> (${highPart.highs.length} su ${m.highs.length}).`);
  }
  const withData = rows.filter((x) => x.tir != null);
  if (withData.length > 1) {
    const worst = withData.reduce((a, b) => (b.tir < a.tir ? b : a));
    const best = withData.reduce((a, b) => (b.tir > a.tir ? b : a));
    if (best.tir - worst.tir >= 15) notes.push(`Momento più difficile: <b>${worst.label.toLowerCase()}</b> (${pct0(worst.tir)} nel range, contro ${pct0(best.tir)} di ${best.label.toLowerCase()}).`);
  }
  if (m.cv > 36) notes.push(`Variabilità alta (CV ${pct0(m.cv)}): le oscillazioni aumentano il rischio di basse.`);
  if (!notes.length) notes.push('Nessuno schema ricorrente rilevato nel periodo.');
  const cell = (list, cls) => `<td class="num ${list.length ? cls : 'muted'}">${list.length || '–'}</td>`;
  return `
  <section class="card">
    <div class="card-head"><h2>Andamenti per fascia oraria</h2></div>
    <table class="data"><thead><tr><th></th><th class="num">Mediana</th><th class="num">Nel range</th><th class="num">Basse</th><th class="num">Alte</th></tr></thead>
    <tbody>${rows.map((x) => `<tr><td>${x.label}<small>${String(x.from).padStart(2, '0')}–${String(x.to).padStart(2, '0')}</small></td>
      <td class="num">${x.median == null ? '–' : g7.fmt(x.median)}</td><td class="num">${x.tir == null ? '–' : pct0(x.tir)}</td>
      ${cell(x.lows, 'bad')}${cell(x.highs, 'warn')}</tr>`).join('')}</tbody></table>
    <p class="muted small">Episodi di almeno 15 minuti: basse sotto ${glucose(LOW)}, alte sopra ${glucose(VHIGH)}.</p>
    <ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>
  </section>`;
}

function dailySection(r, start, end) {
  const dayList = [];
  for (let d = startOfDay(end); d >= start; d -= DAY) dayList.push(d);
  const shown = dayList.slice(0, 31);
  const W = 240, H = 70, T = 4, B = 4;
  const y = (v) => T + (1 - (Math.min(Math.max(v, 40), 350) - 40) / 310) * (H - T - B);
  let best = null;
  const cards = shown.map((d) => {
    const next = d + DAY;
    const dr = r.filter((x) => x.t >= d && x.t < next);
    const m = metrics(dr, d, next);
    if (m.n && m.wear >= 70 && (!best || m.tir > best.tir)) best = { d, tir: m.tir };
    let path = '', prev = null;
    for (const x of dr) {
      const px = ((x.t - d) / DAY) * W;
      path += `${prev && x.t - prev.t <= 12 * 60_000 ? 'L' : 'M'}${px.toFixed(1)} ${y(x.v).toFixed(1)}`;
      prev = x;
    }
    return { d, m, svg: `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <rect class="agp-target" x="0" y="${y(HIGH).toFixed(1)}" width="${W}" height="${(y(LOW) - y(HIGH)).toFixed(1)}"/>
      <path class="day-trace" d="${path}"/></svg>` };
  });
  const html = cards.map(({ d, m, svg }) => `
    <div class="day ${best?.d === d ? 'best' : ''}">
      <div class="day-head"><b>${dayFmt.format(d)}</b>
        <span>${m.n ? `${pct0(m.tir)} nel range` : 'nessun dato'}</span></div>
      ${best?.d === d ? '<div class="best-tag">★ Giorno migliore</div>' : ''}
      ${svg}
      ${m.n ? `<div class="day-foot"><span>media ${g7.fmt(m.mean)}</span>${m.lows.length ? `<span class="bad">${m.lows.length} ${m.lows.length === 1 ? 'bassa' : 'basse'}</span>` : ''}</div>` : ''}
    </div>`).join('');
  return `
  <section class="card wide">
    <div class="card-head"><h2>Giorno per giorno</h2>
      <span class="muted small">${dayList.length > shown.length ? `ultimi ${shown.length} giorni` : ''}</span></div>
    <div class="days">${html}</div>
  </section>`;
}

function hourlySection(r) {
  const hours = Array.from({ length: 24 }, () => []);
  for (const x of r) hours[new Date(x.t).getHours()].push(x.v);
  const rows = hours.map((v, h) => {
    const s = [...v].sort((a, b) => a - b);
    if (!s.length) return `<tr><td>${String(h).padStart(2, '0')}:00</td><td colspan="5" class="muted">nessun dato</td></tr>`;
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const low = (s.filter((x) => x < LOW).length / s.length) * 100;
    const high = (s.filter((x) => x > HIGH).length / s.length) * 100;
    return `<tr><td>${String(h).padStart(2, '0')}:00</td>
      <td class="num">${g7.fmt(percentile(s, 0.5))}</td><td class="num">${g7.fmt(mean)}</td>
      <td class="num">${g7.fmt(percentile(s, 0.1))}–${g7.fmt(percentile(s, 0.9))}</td>
      <td class="num ${low >= 4 ? 'bad' : ''}">${pct0(low)}</td><td class="num ${high >= 25 ? 'warn' : ''}">${pct0(high)}</td></tr>`;
  }).join('');
  return `
  <section class="card">
    <details class="fold">
      <summary><h2>Statistiche orarie</h2><span class="muted small">mediana, media e intervallo per ogni ora</span></summary>
      <table class="data compact"><thead><tr><th>Ora</th><th class="num">Mediana</th><th class="num">Media</th><th class="num">10–90%</th>
        <th class="num">&lt; ${g7.fmt(LOW)}</th><th class="num">&gt; ${g7.fmt(HIGH)}</th></tr></thead><tbody>${rows}</tbody></table>
    </details>
  </section>`;
}

function compareSection(m, prev) {
  if (!prev.n) {
    return `<section class="card"><div class="card-head"><h2>Confronto</h2></div>
      <p class="muted">Nessuna lettura nei ${days} giorni precedenti: il confronto comparirà quando ci saranno dati.</p></section>`;
  }
  // better: +1 when a higher value is better, -1 when lower is better
  const rows = [
    ['Nel range', m.tir, prev.tir, 1, pct0],
    ['Sotto ' + g7.fmt(LOW), m.tbr, prev.tbr, -1, pct1],
    ['Sopra ' + g7.fmt(HIGH), m.tar, prev.tar, -1, pct0],
    ['Media', m.mean, prev.mean, -1, glucose],
    ['GMI', m.gmi, prev.gmi, -1, (x) => `${x.toFixed(1).replace('.', ',')}%`],
    ['Variabilità (CV)', m.cv, prev.cv, -1, pct0],
    ['Episodi di bassa', m.lows.length, prev.lows.length, -1, String],
    ['Uso del sensore', m.wear, prev.wear, 1, pct0],
  ];
  const body = rows.map(([label, now, before, better, f]) => {
    const diff = now - before;
    const same = Math.abs(diff) < (label === 'Media' ? 3 : label.startsWith('Episodi') ? 1 : 1);
    const good = !same && Math.sign(diff) === better;
    return `<tr><td>${label}</td><td class="num muted">${f(before)}</td><td class="num"><b>${f(now)}</b></td>
      <td class="num ${same ? 'muted' : good ? 'good' : 'bad'}">${same ? '=' : diff > 0 ? '▲' : '▼'}</td></tr>`;
  }).join('');
  return `
  <section class="card">
    <div class="card-head"><h2>Confronto con i ${days} giorni prima</h2></div>
    <table class="data"><thead><tr><th></th><th class="num">Prima</th><th class="num">Ora</th><th class="num"></th></tr></thead><tbody>${body}</tbody></table>
    <p class="muted small">In verde i miglioramenti, in rosso i peggioramenti.</p>
  </section>`;
}

function meterSection(r, f) {
  if (!f.length) return '';
  const pairs = f.map((s) => ({ ...s, sensor: sensorAt(r, s.t) })).filter((s) => s.sensor != null);
  const mard = pairs.length ? pairs.reduce((a, s) => a + Math.abs(s.sensor - s.v) / s.v, 0) / pairs.length * 100 : null;
  const bias = pairs.length ? pairs.reduce((a, s) => a + (s.sensor - s.v), 0) / pairs.length : null;
  const rows = [...f].reverse().slice(0, 6).map((s) => {
    const sensor = sensorAt(r, s.t);
    return `<tr><td>${dayFmt.format(s.t)} ${timeFmt.format(s.t)}${s.meter ? `<small>${esc(s.meter)}</small>` : ''}</td>
      <td class="num"><b>${g7.fmt(s.v)}</b></td><td class="num">${sensor == null ? '–' : g7.fmt(sensor)}</td>
      <td class="num">${sensor == null ? '–' : g7.fmtDelta(sensor - s.v)}</td></tr>`;
  }).join('');
  return `
  <section class="card">
    <div class="card-head"><h2>Glucometro e sensore</h2></div>
    <div class="tiles">
      <div class="tile"><span>Misurazioni</span><b>${f.length}</b></div>
      <div class="tile"><span>Scarto medio (MARD)</span><b>${mard == null ? '–' : pct0(mard)}</b><small>il G7 dichiara circa 8–9%</small></div>
      <div class="tile"><span>Il sensore segna in media</span><b>${bias == null ? '–' : `${g7.fmtDelta(Math.round(bias))} ${g7.unitLabel()}`}</b><small>rispetto al glucometro</small></div>
    </div>
    <p class="muted small">Ultime misurazioni (tutte nel file CSV):</p>
    <table class="data"><thead><tr><th>Quando</th><th class="num">Glucometro</th><th class="num">Sensore</th><th class="num">Differenza</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

// ------------------------------------------------------------------ page

function render() {
  if (!data) return;
  const { start, end, r, f, prev } = data;
  $('rep-range').textContent = `${dateFmt.format(start)} – ${dateFmt.format(end)} · ${days} giorni · ${r.length} letture`;
  for (const b of $('rep-period').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
  const m = metrics(r, start, end);
  if (!m.n) {
    $('rep-body').innerHTML = '<section class="card"><p class="muted">Nessuna lettura in questo periodo.</p></section>';
    return;
  }
  const pm = metrics(prev.r, prev.start, prev.end);
  $('rep-body').innerHTML = [
    summarySection(m),
    rangesSection(m),
    agpSection(r),
    patternsSection(r, m),
    compareSection(m, pm),
    meterSection(r, f),
    dailySection(r, start, end),
    hourlySection(r),
  ].join('');
}

function exportCsv() {
  if (!data) return;
  const two = (n) => String(n).padStart(2, '0');
  const d = (t) => { const x = new Date(t); return `${x.getFullYear()}-${two(x.getMonth() + 1)}-${two(x.getDate())}`; };
  const hm = (t) => { const x = new Date(t); return `${two(x.getHours())}:${two(x.getMinutes())}`; };
  const mmol = (v) => (v / 18.0182).toFixed(1).replace('.', ',');
  const lines = ['data;ora;mg/dL;mmol/L;tipo;glucometro'];
  const rows = [
    ...data.r.map((x) => ({ t: x.t, v: x.v, type: 'sensore', meter: '' })),
    ...data.f.map((x) => ({ t: x.t, v: x.v, type: 'glucometro', meter: x.meter ?? '' })),
  ].sort((a, b) => a.t - b.t);
  for (const x of rows) lines.push([d(x.t), hm(x.t), x.v, mmol(x.v), x.type, `"${String(x.meter).replace(/"/g, '""')}"`].join(';'));
  // BOM: Excel opens the accents and the "mmol/L" header correctly
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `glicemie-${d(data.start)}-${d(data.end)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ------------------------------------------------------------------ navigation between "Oggi" and "Report"

let ready = false;

function showView() {
  const report = location.hash === '#report';
  $('view-today').hidden = report;
  $('view-report').hidden = !report;
  for (const a of $('tabs').querySelectorAll('a')) a.toggleAttribute('aria-current', (a.dataset.view === 'report') === report);
  if (report && ready && !data) load();
  if (!report) window.dispatchEvent(new Event('resize')); // the chart measures itself again
}

window.addEventListener('hashchange', showView);
document.addEventListener('g7:ready', () => { ready = true; showView(); });
document.addEventListener('g7:logout', () => { ready = false; data = null; $('rep-body').innerHTML = ''; });
document.addEventListener('g7:prefs', () => render());

$('rep-period').addEventListener('click', (e) => {
  const n = Number(e.target.closest('button')?.dataset.days);
  if (!n || n === days) return;
  days = n;
  try { localStorage.setItem('g7report', String(n)); } catch { /* private mode */ }
  load();
});
$('rep-print').addEventListener('click', () => {
  for (const d of document.querySelectorAll('#rep-body details')) d.open = true; // everything on paper
  window.print();
});
$('rep-csv').addEventListener('click', exportCsv);
showView();
