// Mind & Money — 20 years of what people cared about (top), who moved money (middle), and where money sits (bottom).
//
// Everything on screen comes from the data files built by tools/build_money.py, build_attention.py and build_mood.py:
//   mind cell      = Google search interest in one topic vs its own previous 36 months (faint disc = usual size)
//   pool circle    = amount held there (area ∝ amount)
//   ribbon + dots  = measured net buying this quarter; ribbon width ∝ amount, one dot = a fixed amount; blue in, orange out
//   dashed thread  = a search topic and a pool that moved together over 20 years (|r| ≥ 0.25), lit while the topic is hot
//   dashed ring    = the pool's size one year ago
//   three sentences = strongest mood, largest money move, largest price change of that moment
// Motion that is not data: dots travelling along their stream, a slow shimmer. Nothing else moves by itself.

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const REGION = new URLSearchParams(location.search).get('r') === 'kr' ? 'kr' : 'us';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DATA = '../money/';

const GROUPS = [
  { id: 'cash', label: 'Cash', c: '#5ee4ff' }, { id: 'bonds', label: 'Bonds', c: '#7ea8ff' },
  { id: 'real', label: 'Real assets', c: '#ffcf6b' }, { id: 'stocks', label: 'Stocks', c: '#b48cff' },
  { id: 'crypto', label: 'Crypto', c: '#ff8ad8' },
];
const GC = Object.fromEntries(GROUPS.map((g) => [g.id, g.c]));
const MOODC = { fear: '#ff5d5d', greed: '#ffb020', play: '#d08bff', life: '#4ade80', future: '#38bdf8', other: '#7d86a8' };
// searching for stocks and coins spikes in manias and in crashes alike, so this mood is called Investing, not Greed
const MOODN = { greed: 'Investing' };
const C_IN = '#5ee4ff', C_OUT = '#ffad5c';
const UNIT = REGION === 'kr' ? 1000 : 10;                    // billions of local currency per dot
const UNIT_TXT = REGION === 'kr' ? '₩1조' : '$10B';
const ACTOR = { households: 'Households', foreign: 'Foreign investors', fed: 'The Fed', bok: 'Bank of Korea', inst: 'Institutions' };
const ACTOR_SHORT = { foreign: 'Foreign', bok: 'BoK', inst: 'Institutions' };
const POOL_WORD = { deposits: 'bank deposits', mmf: 'money market funds', treasuries: 'Treasuries', mbs: 'mortgage bonds', corpbonds: 'corporate bonds',
  stocks: 'stocks', realestate: 'real estate', gold: 'gold', bitcoin: 'bitcoin', stable: 'stablecoins', bonds: 'bonds', housing: 'housing' };
const WHY = REGION === 'kr'
  ? [['krrate', 'BoK rate'], ['krcpi', 'Inflation'], ['usdkrw', 'Won per $'], ['oilp', 'Oil'], ['kospi', 'KOSPI'], ['ccsi', 'Consumer mood']]
  : [['ff', 'Fed rate'], ['cpi', 'Inflation'], ['oilp', 'Oil'], ['dxy', 'Dollar'], ['goldp', 'Gold'], ['sent', 'Consumer mood']];

// amounts are billions of the region's currency
const fmtB = (b) => {
  if (b == null || !isFinite(b)) return '—';
  const a = Math.abs(b);
  if (REGION === 'kr') return a >= 1000 ? `₩${(b / 1000).toLocaleString('en-US', { maximumFractionDigits: a >= 100000 ? 0 : 1 })}조` : `₩${Math.round(b * 10).toLocaleString('en-US')}억`;
  return a >= 1000 ? `$${(b / 1000).toFixed(a >= 10000 ? 1 : 2)}T` : `$${Math.round(b)}B`;
};
const fmtSB = (b) => (b == null || !isFinite(b) ? '—' : `${b >= 0 ? '+' : '−'}${fmtB(Math.abs(b))}`);
const fmtPct = (p) => (p == null || !isFinite(p) ? '—' : `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(Math.abs(p) >= 10 ? 0 : 1)}%`);
const big = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : null);
const fmtLane = (l, v, delta = false) => (l.unit === '%' || l.unit === 'pp' ? `${v.toFixed(2)}${delta ? 'pp' : '%'}`
  : l.unit === '$' ? `$${big(v) ?? v.toFixed(0)}` : l.unit === '₩' ? `₩${Math.round(v).toLocaleString('en-US')}` : big(v) ?? v.toFixed(1));
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const ym = (t) => new Date(t).toISOString().slice(0, 7);
const quarterOf = (t) => { const d = new Date(t); return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };
const yearAgo = (arr, i) => (i >= 52 ? arr[i - 52] : null);
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

const S = { threads: [], D: null, M: null, A: null, T: 0, playing: !REDUCED, speed: 4.345, lastI: -1, mouse: null, pools: [], moods: [], actors: [], flows: [], evNow: null };
let L = null, tlBase = null, clock = 0;

// ------------------------------------------------------------------ layout
const stage = $('stage'), g = stage.getContext('2d');
function valAt(arr, T) {
  const i = Math.floor(T), f = T - i, a = arr[i], b = arr[Math.min(i + 1, arr.length - 1)];
  if (a == null) return b ?? null;
  return b == null ? a : a + (b - a) * f;
}
function layout() {
  const W = innerWidth, H = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2), narrow = W < 820;
  // wide screens: every topic is a labelled bar in a left column and the money map gets the rest of the screen
  const wide = W >= 980 && H >= 640 && S.moods.length > 0;
  document.body.classList.toggle('wide', wide);
  stage.width = Math.round(W * dpr); stage.height = Math.round(H * dpr);
  // the sentences change length every month: reserve a fixed block for them so the map never jumps
  const lines = wide ? (W < 1280 ? 158 : W < 1700 ? 134 : 110) : narrow ? 112 : W < 1280 ? 132 : 92;
  const top = Math.max($('now').getBoundingClientRect().bottom, $('story').getBoundingClientRect().top + lines) + (narrow ? 4 : 8);
  const bot = $('dock').getBoundingClientRect().top - 8;
  const Hs = Math.max(220, bot - top);
  const x0 = wide ? 320 : 0, mw = W - x0;                       // the map's left edge and width
  const nM = Math.max(1, S.moods.length);
  const rc = clamp(Math.min(W / nM * 0.9 / 13.5, Hs * 0.036), 4.2, 19);     // one topic cell at its usual size
  const hh = rc * 3.05;                                                       // half height of a two-row cluster
  const mindY = top + (narrow ? 16 : 22) + hh;
  const wikiY = mindY + hh + (narrow ? 28 : 40);
  const whoY = wide ? top + 34 : wikiY + (narrow ? 44 : 52);
  const labelH = narrow ? 30 : 68;
  const poolSpace = bot - labelH - (whoY + 26);
  const rCap = Math.max(18, Math.min(poolSpace * (narrow ? 0.3 : wide ? 0.36 : 0.37), mw * (wide ? 0.15 : 0.13)));
  // radius scale: area ∝ amount, as large as fits both the band height and the row width over all 20 years
  const slotMin = narrow ? Math.max(22, (W - 16) / Math.max(1, S.pools.length) * 0.7) : wide ? 60 : 62, gap = narrow ? 3 : wide ? 12 : 10, avail = mw - (narrow ? 12 : 48);
  let maxV = 1;
  for (const p of S.pools) for (const v of p.p.v) if (v > maxV) maxV = v;
  let k = rCap / Math.sqrt(maxV);
  const N = S.D.weeks.length;
  const widthAt = (kk, i) => S.pools.reduce((s, p) => s + Math.max(2 * kk * Math.sqrt(p.p.v[i] || 0), slotMin) + gap, 0);
  for (let it = 0; it < 80; it++) {
    let ok = true;
    for (let i = 0; i < N; i += 13) if (widthAt(k, i) > avail) { ok = false; break; }
    if (ok && widthAt(k, N - 1) <= avail) break;
    k *= 0.95;
  }
  // centres sit on one line, as low as the largest pool ever needs; labels go under it
  const poolY = bot - labelH - Math.min(rCap, Math.max(24, k * Math.sqrt(maxV)));
  const wk = (narrow ? 20 : wide ? 44 : 36) / (S.qRef || 1);   // ribbon width per unit of money: the largest flows ever ≈ 36-44 px
  L = { W, H, dpr, narrow, wide, x0, mw, top, bot, Hs, wk, rc, hh, mindY, wikiY, whoY, poolY, rCap, k, slotMin, gap };
  $('wiki').style.top = `${wikiY - 12}px`;
  if (wide) {
    const el = $('mind'), pt = $('now').getBoundingClientRect().bottom + 12, Hp = bot - pt + 2, rows = S.mindRows.length || 1;
    el.style.top = `${pt}px`; el.style.height = `${Hp}px`;
    const rh = clamp((Hp - 22 - 20 - S.moods.length * 20 - (S.moods.length - 1) * 7) / rows, 10.5, 22);
    el.style.setProperty('--rh', `${rh.toFixed(2)}px`); el.style.setProperty('--fs', `${clamp(rh - 3.4, 9, 13.5).toFixed(1)}px`);
    const right = el.getBoundingClientRect().right;
    for (const r of S.mindRows) { const b = r.el.getBoundingClientRect(); r.c.x = right + 3; r.c.y = b.top + b.height / 2; r.c.r = 0; }
  }
  S.moods.forEach((m, j) => {
    if (wide) return;
    m.x = W * (j + 0.5) / nM; m.y = mindY;
    const n = m.cells.length, n0 = n <= 5 ? n : Math.ceil(n / 2), sx = rc * 2.7, sy = rc * 2.45;
    m.cells.forEach((c, q) => {
      const row = q < n0 ? 0 : 1, cnt = row ? n - n0 : n0, k = row ? q - n0 : q;
      c.x = m.x + (k - (cnt - 1) / 2) * sx; c.y = mindY + (n <= 5 ? 0 : row ? sy / 2 : -sy / 2);
    });
  });
  const nA = S.actors.length, span = Math.min(mw * 0.8, nA * (wide ? 300 : 250));
  S.actors.forEach((a, j) => { a.x = x0 + mw / 2 + (j - (nA - 1) / 2) * (span / nA); a.y = whoY; });
  tlBase = null;
}

// the left column on wide screens: every topic, always in the same place, as a bar against its usual level
function buildMind() {
  const el = $('mind'); S.mindRows = [];
  el.innerHTML = `<div class="mh">What people search for <span>vs their usual</span></div>` + S.moods.map((m, j) =>
    `<div class="fam" style="--hue:${m.c}"><h4>${esc(m.m.name)}</h4>${m.cells.map((c, q) =>
      `<div class="tr" data-m="${j}" data-c="${q}"><span class="n">${esc(c.p.label)}</span><span class="b"><i></i></span><span class="v">—</span></div>`).join('')}</div>`).join('');
  for (const row of el.querySelectorAll('.tr')) {
    const m = S.moods[+row.dataset.m], c = m.cells[+row.dataset.c];
    S.mindRows.push({ m, c, el: row, bar: row.querySelector('i'), pv: row.querySelector('.v'), last: undefined });
  }
  el.addEventListener('pointermove', (e) => {
    const row = e.target.closest('.tr'); if (!row) { hideTip(); return; }
    const m = S.moods[+row.dataset.m], c = m.cells[+row.dataset.c];
    showTip(cellTip(m, c, Math.round(S.T)), e.clientX, e.clientY);
  });
  el.addEventListener('pointerleave', hideTip);
}
function updateMind(i) {
  for (const r of S.mindRows || []) {
    const v = r.c.p.v[i]; if (v === r.last) continue; r.last = v;
    r.el.classList.toggle('hot', v != null && v >= 15); r.el.classList.toggle('none', v == null);
    r.pv.textContent = v == null ? '—' : fmtPct(v);
    const w = v == null ? 0 : Math.min(Math.abs(v), v >= 0 ? 100 : 50) / 150 * 100;      // % of the track; usual sits at one third
    r.bar.style.left = v != null && v < 0 ? `${33.3 - w}%` : '33.3%'; r.bar.style.width = `${w}%`;
  }
}

// ------------------------------------------------------------------ per-week text (story, wiki chips, why chips)
function flowSentence(f, q) {
  const amt = `<b class="v">${fmtB(Math.abs(q))}</b>`;
  if (f.id === 'hh_loan') return q >= 0 ? `Households took out ${amt} of new loans` : `Households repaid ${amt} of loans`;
  if (f.id === 'cash_stable') return q >= 0 ? `${amt} of new stablecoins were minted` : `${amt} of stablecoins were redeemed`;
  const who = f.id === 'ind_stk' ? 'Individual investors' : ACTOR[f.from] || f.from;
  if (f.per === 'm') return `${who} ${q >= 0 ? 'bought' : 'sold'} ${amt} of stocks (net)`;
  const what = f.id === 'hh_funds' ? 'stock funds' : f.id === 'hh_eq' ? 'stocks directly' : POOL_WORD[f.to] || f.to;
  return q >= 0 ? `${who} put ${amt} into ${what}` : `${who} pulled ${amt} out of ${what}`;
}
function setHTML(el, html) {
  if (el._h === html) return;
  el._h = html; el.innerHTML = html;
  if (!REDUCED && el.animate) el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
}
function updateText(i) {
  const D = S.D, t = D.weeks[i], d = new Date(t);
  $('date').textContent = `${d.getUTCFullYear()} ${MON[d.getUTCMonth()]}`;
  $('week').textContent = `week of ${iso(t)} · ${quarterOf(t)}`;
  // MIND
  let mind;
  if (!S.moods.length) mind = 'Mood data is not built for this view yet.';
  else {
    const fam = S.moods.map((m) => { let b = null; for (const c of m.cells) { const v = c.p.v[i]; if (v != null && (!b || v > b.v)) b = { m, c, v }; } return b; }).filter(Boolean).sort((a, b) => b.v - a.v);
    const say = (x) => `<b class="v" style="color:${x.m.c}">${esc(x.c.p.label)}</b> ${fmtPct(x.v)} <span class="mute">${esc(x.m.m.name)}</span>`;
    if (!fam.length) mind = i > S.D.weeks.length - 7 ? 'Search data for this month is not complete yet.' : 'No search data for this month.';
    else if (fam[0].v >= 20) {
      const also = fam.slice(1).filter((x) => x.v >= 15).slice(0, innerWidth < 820 ? 1 : 2);
      mind = `Most above usual: ${say(fam[0])}.${also.length ? ` Also up: ${also.map(say).join(', ')}.` : ''}`;
    } else {
      let lo = null;
      for (const m of S.moods) for (const c of m.cells) { const v = c.p.v[i]; if (v != null && (!lo || v < lo.v)) lo = { m, c, v }; }
      mind = `Calm. No topic is far above its usual level${lo && lo.v <= -25 ? `; lowest is ${say(lo)}` : ''}.`;
    }
  }
  setHTML($('sMind'), mind);
  // MONEY
  const fl = S.flows.map((F) => ({ f: F.f, q: F.f.q[i] })).filter((x) => x.q != null && Math.abs(x.q) > 0).sort((a, b) => Math.abs(b.q) - Math.abs(a.q));
  const published = fl.some((x) => x.f.per === 'q');
  let money = fl.slice(0, 2).map((x) => flowSentence(x.f, x.q)).join('; ');
  money = money ? `${money} this quarter.` : '';
  if (!published) money = (i < S.firstQ
    ? `${esc(D.meta.flows_name || 'Official flow data')} starts in ${new Date(D.weeks[S.firstQ]).getUTCFullYear()}; nothing is measured here before that. `
    : `${esc(D.meta.flows_name || 'Official flow data')} for this quarter is not published yet (latest: ${esc(D.meta.z1_latest)}). `) + money;
  setHTML($('sMoney'), money || 'No measured flows.');
  // PRICES
  const ev = D.events.find((e) => Math.abs(e.t - t) < 17.5 * 86400e3);
  S.evNow = ev || null;
  let price;
  if (ev) price = `Big move: ${ev.moves.map((m) => `${esc(m.k)} <b class="v ${m.pct >= 0 ? 'up' : 'dn'}">${fmtPct(m.pct)}</b>`).join(', ')} in 4 weeks (to ${iso(ev.t)}).`;
  else {
    const ch = S.pools.map((p) => { const a = p.p.v[i], b = yearAgo(p.p.v, i); return { p, dd: a != null && b != null ? a - b : null, d: a != null && b ? (a / b - 1) * 100 : null }; })
      .filter((x) => x.dd != null).sort((a, b) => Math.abs(b.dd) - Math.abs(a.dd))[0];
    price = ch ? `${esc(ch.p.p.label.replace(/ \(.*\)/, ''))} ${ch.dd >= 0 ? 'grew' : 'shrank'} by <b class="v ${ch.dd >= 0 ? 'up' : 'dn'}">${fmtB(Math.abs(ch.dd))}</b> (${fmtPct(ch.d)}) from a year ago (price change plus money moved).` : 'Less than a year of data so far.';
  }
  setHTML($('sPrice'), price);
  // Wikipedia: chips under the mind row, or a fourth sentence on wide screens
  const w = S.M?.wikiBy?.[ym(t)], el = $('wiki'), wideNow = document.body.classList.contains('wide');
  if (w && !wideNow) {
    el.hidden = false;
    el.innerHTML = `<span class="h">Most read on Wikipedia</span>` + w.items.slice(0, L && L.narrow ? 2 : 4).map((x) =>
      `<span class="c" style="--hue:${MOODC[x.mood] || MOODC.other}"><i></i>${esc(x.title)}${x.type ? ` <em>${esc(x.type)}</em>` : ''}</span>`).join('');
  } else el.hidden = true;
  setHTML($('sWiki'), w ? 'Most read on Wikipedia: ' + w.items.slice(0, 4).map((x) => `<span class="wk" style="--hue:${MOODC[x.mood] || MOODC.other}"><i></i>${esc(x.title)}${x.type ? ` <em>${esc(x.type)}</em>` : ''}</span>`).join(' ')
    : `<span class="mute">${t < Date.UTC(2015, 6, 1) ? 'Wikipedia monthly top lists start in July 2015.' : 'This month\'s Wikipedia list is not complete yet.'}</span>`);
  updateMind(i);
  // why chips
  $('why').innerHTML = WHY.map(([id, name]) => {
    const l = D.lanes.find((x) => x.id === id); if (!l) return '';
    const v = l.v[i], v1 = yearAgo(l.v, i), dl = v != null && v1 != null ? v - v1 : null;
    return `<div class="wy" title="${esc(l.label)} · ${esc(l.src || '')} · change vs 1 year ago"><div class="k">${esc(name)}</div><div class="v">${v == null ? '—' : fmtLane(l, v)}<small class="mute">${dl == null ? '' : (dl >= 0 ? '▲' : '▼') + fmtLane(l, Math.abs(dl), true)}</small></div></div>`;
  }).join('');
}

// ------------------------------------------------------------------ drawing
const FONT = 'Inter, "Pretendard Variable", Pretendard, system-ui, sans-serif', MONO = '"JetBrains Mono", ui-monospace, monospace';
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}
function anchor(id) {
  const p = S.poolBy[id]; if (p) return { pool: true, x: p.x, y: p.y - p.r - 2 };
  const a = S.actorBy[id]; if (a) return { pool: false, x: a.x, y: a.y + 13 };
  return null;
}
function draw(dt) {
  const { W, H, dpr, narrow, wide, x0, mw } = L, i = Math.round(S.T), D = S.D;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  // backdrop
  const bg = g.createRadialGradient(x0 + mw / 2, L.poolY, 40, x0 + mw / 2, L.poolY, Math.max(W, H) * 0.7);
  bg.addColorStop(0, 'rgba(60,70,150,.20)'); bg.addColorStop(1, 'rgba(5,6,13,0)');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  // band captions
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.font = `600 ${narrow ? 8.5 : 10}px ${FONT}`; g.fillStyle = 'rgba(111,120,155,.9)';
  const cap = (txt, y) => { g.save(); g.translate(x0 + (narrow ? 9 : 16), y); g.rotate(-Math.PI / 2); g.textAlign = 'center'; if ('letterSpacing' in g) g.letterSpacing = '2px'; g.fillText(txt, 0, 0); g.restore(); };
  if (!wide) cap('MIND', L.mindY);
  cap('WHO', L.whoY); cap('MONEY', L.poolY);

  // ---- pools: positions for this moment
  let x = 0; const row = [];
  for (const p of S.pools) {
    const v = valAt(p.p.v, S.T); p.v = v;
    const r = v == null ? 0 : Math.max(L.k * Math.sqrt(v), 2.6);
    const slot = Math.max(2 * r, L.slotMin);
    row.push({ p, r, slot, x0: x }); x += slot + L.gap;
  }
  const off = x0 + (mw - (x - L.gap)) / 2;
  for (const o of row) { o.p.r = o.r; o.p.x = off + o.x0 + o.slot / 2; o.p.y = L.poolY; }

  // ---- mind: one cell per topic, grouped in five families. A cell larger than its faint disc = more attention than usual.
  if (wide) { for (const m of S.moods) for (const c of m.cells) c.v = c.p.v[i]; }
  else for (const m of S.moods) {
    let best = null;
    for (const c of m.cells) {
      const v = c.p.v[i]; c.v = v;
      const target = v == null ? null : clamp(v, -70, 220);
      if (target != null) c.cur = c.cur == null ? target : c.cur + (target - c.cur) * (REDUCED ? 1 : Math.min(1, dt * 4));
      const r = v == null ? L.rc : L.rc * Math.sqrt(1 + c.cur / 100); c.r = r;
      const hot = v == null ? 0 : clamp(c.cur / 90, 0, 1);
      g.fillStyle = 'rgba(160,172,255,.08)'; g.beginPath(); g.arc(c.x, c.y, L.rc, 0, 7); g.fill();
      if (v != null) {
        g.save(); g.shadowColor = m.c; g.shadowBlur = 3 + 18 * hot;
        g.fillStyle = hexA(m.c, 0.10 + 0.5 * hot); g.strokeStyle = hexA(m.c, 0.45 + 0.55 * hot); g.lineWidth = 1 + hot;
        g.beginPath(); g.arc(c.x, c.y, r, 0, 7); g.fill(); g.stroke(); g.restore();
        if (!best || v > best.v) best = c;
      }
      if (S.hover === c) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(c.x, c.y, Math.max(r, L.rc) + 3, 0, 7); g.stroke(); }
    }
    m.best = best;
    g.textAlign = 'center';
    g.font = `700 ${narrow ? 8 : 10.5}px ${FONT}`; g.fillStyle = m.c;
    g.fillText(m.m.name.toUpperCase(), m.x, m.y - L.hh - (narrow ? 5 : 8));
    if (best) {
      const strong = best.v >= 12, pct = fmtPct(best.v), slot = W / S.moods.length - 6;
      g.font = `${strong ? 600 : 500} ${narrow ? 9 : 11}px ${FONT}`;
      let txt = `${best.p.label} ${pct}`;
      if (g.measureText(txt).width > slot) txt = pct;
      g.fillStyle = strong ? '#eef1ff' : 'rgba(111,120,155,.95)';
      g.fillText(txt, m.x, m.y + L.hh + (narrow ? 11 : 14));
    }
  }

  // ---- actors
  for (const a of S.actors) {
    g.font = `600 ${narrow ? 9.5 : wide ? 12.5 : 11.5}px ${FONT}`;
    const nm = narrow ? ACTOR_SHORT[a.h.id] || a.name : a.name;
    const tw = g.measureText(nm).width, w = tw + (narrow ? 14 : wide ? 30 : 24), h = narrow ? 20 : wide ? 30 : 26;
    a.pw = w; a.ph = h;
    g.fillStyle = 'rgba(14,17,34,.9)'; g.strokeStyle = 'rgba(200,208,255,.35)'; g.lineWidth = 1;
    g.beginPath(); g.roundRect(a.x - w / 2, a.y - h / 2, w, h, h / 2); g.fill(); g.stroke();
    g.fillStyle = '#eef1ff'; g.textAlign = 'center'; g.fillText(nm, a.x, a.y + (narrow ? 3.5 : 4));
  }

  // ---- proven links between a search topic and a pool (20 years of data): a dashed thread, lit while the topic is hot
  for (const th of S.threads) {
    const v = th.c.v, p = th.pool; if (narrow || v == null || v < 25 || p.v == null) continue;
    const a = clamp((v - 25) / 120, 0.25, 0.8), tx = th.c.x, ty = th.c.y + (wide ? 0 : th.c.r + 2), x1 = p.x, y1 = p.y - p.r - 3, ym = ty + (y1 - ty) * 0.55;
    g.save(); g.setLineDash([2, 5]); g.strokeStyle = hexA(th.m.c, a); g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(tx, ty);
    if (wide) g.bezierCurveTo((tx + x1) / 2, ty, x1, ty + (y1 - ty) * 0.25, x1, y1); else g.bezierCurveTo(tx, ym, x1, ym, x1, y1);
    g.stroke(); g.restore();
  }

  // ---- flows: a ribbon whose width is the amount, with travelling dots (1 dot = a fixed amount)
  const live = [];
  for (const F of S.flows) {
    const q = F.f.q[i]; F.q = q;
    if (q == null || q === 0) continue;
    const pa = S.poolBy[F.f.from], pb = S.poolBy[F.f.to], aa = S.actorBy[F.f.from], ab = S.actorBy[F.f.to];
    if (!(pa || aa) || !(pb || ab)) continue;
    live.push({ F, q, pa, pb, aa, actor: aa || ab, pool: pb || pa });
  }
  // fan the streams out along each pill and each pool top, ordered by where the other end is, so they cross as little as possible
  for (const a of S.actors) {
    const mine = live.filter((x) => x.actor === a).sort((x, y) => x.pool.x - y.pool.x);
    const step = mine.length > 1 ? Math.min(narrow ? 7 : 14, ((a.pw || 90) - 20) / (mine.length - 1)) : 0;
    mine.forEach((x, k) => { x.ax = a.x + (k - (mine.length - 1) / 2) * step; });
  }
  for (const p of S.pools) {
    const mine = live.filter((x) => x.pool === p && x.actor).sort((x, y) => x.actor.x - y.actor.x);
    const step = mine.length > 1 ? Math.min(p.r * 1.1 / (mine.length - 1), 14) : 0;
    mine.forEach((x, k) => { x.px = p.x + (k - (mine.length - 1) / 2) * step; });
  }
  for (const x of live) {
    let A, B, toPool = true;                                   // A = the flow's "from" end, B = its "to" end
    if (x.actor) {
      const dx = x.px - x.pool.x, P = [x.px, x.pool.y - Math.sqrt(Math.max(0, x.pool.r * x.pool.r - dx * dx)) - 2];
      const Q = [x.ax, x.actor.y + (x.actor.ph || 26) / 2 + 1], actorIsFrom = x.actor === x.aa;
      A = actorIsFrom ? Q : P; B = actorIsFrom ? P : Q; toPool = actorIsFrom;
    } else { A = [x.pa.x, x.pa.y - x.pa.r - 2]; B = [x.pb.x, x.pb.y - x.pb.r - 2]; }
    const fwd = x.q > 0, src = fwd ? A : B, dst = fwd ? B : A, into = x.actor ? fwd === toPool : true;
    let c1, c2;
    if (!x.actor) { const lift = 34 + Math.abs(A[0] - B[0]) * 0.12; c1 = [src[0], src[1] - lift]; c2 = [dst[0], dst[1] - lift]; }
    else { const ymid = (src[1] + dst[1]) / 2; c1 = [src[0], ymid]; c2 = [dst[0], ymid]; }
    x.g = { src, c1, c2, dst, col: into ? C_IN : C_OUT, w: clamp(Math.abs(x.q) * L.wk, 1, narrow ? 22 : 40) };
  }
  g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'butt';
  for (const x of live) {
    const { src, c1, c2, dst, col, w } = x.g;
    const gr = g.createLinearGradient(src[0], src[1], dst[0], dst[1]);
    gr.addColorStop(0, hexA(col, 0.07)); gr.addColorStop(1, hexA(col, 0.26));
    g.strokeStyle = gr; g.lineWidth = w;
    g.beginPath(); g.moveTo(src[0], src[1]); g.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], dst[0], dst[1]); g.stroke();
  }
  const rad = narrow ? 1.3 : 1.9;
  for (const x of live) {
    const { src, c1, c2, dst, col, w } = x.g, F = x.F;
    const n = clamp(Math.round(Math.abs(x.q) / UNIT), 1, F.ph.length), faint = Math.abs(x.q) < UNIT * 0.5, spread = Math.max(w / 2 - 1, 1.2);
    g.fillStyle = hexA(col, faint ? 0.35 : 0.92);
    g.beginPath();
    for (let k = 0; k < n; k++) {
      const t = (F.ph[k] + (REDUCED ? 0 : clock / F.dur)) % 1, pt = cubic(src, c1, c2, dst, t);
      const px = pt[0] + F.jx[k] * spread, py = pt[1];
      g.moveTo(px + rad, py); g.arc(px, py, rad, 0, 7);
    }
    g.fill();
  }
  g.restore();
  // amounts written on the largest streams
  const flowLabs = [];
  for (const x of [...live].sort((a, b) => Math.abs(b.q) - Math.abs(a.q)).slice(0, narrow ? 2 : 4)) {
    const pt = cubic(x.g.src, x.g.c1, x.g.c2, x.g.dst, x.actor ? 0.56 : 0.5);
    if (flowLabs.some((o) => Math.abs(o.x - pt[0]) < 62 && Math.abs(o.y - pt[1]) < 16)) continue;
    flowLabs.push({ x: pt[0], y: pt[1], txt: fmtB(Math.abs(x.q)), col: x.g.col });
  }

  // ---- pool circles + labels (two rows, never overlapping)
  const rNow = Math.max(24, ...S.pools.map((p) => p.r || 0));
  const taken = [[], []], baseY = L.poolY + Math.min(L.rCap, rNow) + (narrow ? 14 : 20);
  const order = [...S.pools].sort((a, b) => (b.v || 0) - (a.v || 0)), F1 = narrow ? 9 : wide ? 12 : 11, F2 = narrow ? 9.5 : wide ? 13 : 12, LH = wide ? 16 : 14;
  for (const p of S.pools) {
    if (p.v == null) continue;
    const c = GC[p.p.group], gr = g.createRadialGradient(p.x - p.r * 0.3, p.y - p.r * 0.35, p.r * 0.1, p.x, p.y, p.r);
    gr.addColorStop(0, hexA(c, 0.95)); gr.addColorStop(1, hexA(c, 0.42));
    g.save(); g.shadowColor = c; g.shadowBlur = 18; g.fillStyle = gr; g.beginPath(); g.arc(p.x, p.y, p.r, 0, 7); g.fill(); g.restore();
    const pv1 = yearAgo(p.p.v, i);
    if (pv1 != null && !narrow) {
      const r1 = Math.max(L.k * Math.sqrt(pv1), 2.6);
      if (Math.abs(r1 - p.r) > 1.5) { g.setLineDash([2, 3]); g.strokeStyle = r1 > p.r ? 'rgba(255,255,255,.4)' : 'rgba(5,6,13,.55)'; g.lineWidth = 1; g.beginPath(); g.arc(p.x, p.y, r1, 0, 7); g.stroke(); g.setLineDash([]); }
    }
    if (S.hover === p) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(p.x, p.y, p.r + 3, 0, 7); g.stroke(); }
  }
  g.textAlign = 'center';
  for (const p of order) {
    if (p.v == null) continue;
    const name = p.short, est = p.p.est && p.p.est[i], v1 = yearAgo(p.p.v, i), d = v1 ? (p.p.v[i] / v1 - 1) * 100 : null;
    const amt = `${est ? '~' : ''}${fmtB(p.v)}`;
    g.font = `500 ${F1}px ${FONT}`; const w1 = g.measureText(name).width;
    g.font = `600 ${F2}px ${MONO}`; const w2 = g.measureText(amt + (narrow || d == null ? '' : ' ' + fmtPct(d))).width;
    const w = Math.max(w1, w2) + 8, rect = [p.x - w / 2, p.x + w / 2];
    let rowI = -1;
    for (let rr = 0; rr < (narrow ? 1 : 2); rr++) if (!taken[rr].some((t) => rect[0] < t[1] && rect[1] > t[0])) { rowI = rr; break; }
    p.labeled = rowI >= 0;
    if (rowI < 0) continue;
    taken[rowI].push(rect);
    const y = baseY + rowI * (narrow ? 0 : wide ? 33 : 30);
    if (rowI === 1) { g.strokeStyle = 'rgba(160,172,255,.18)'; g.lineWidth = 1; g.beginPath(); g.moveTo(p.x, p.y + p.r + 3); g.lineTo(p.x, y - 11); g.stroke(); }
    g.font = `500 ${F1}px ${FONT}`; g.fillStyle = GC[p.p.group]; g.fillText(name, p.x, y);
    g.font = `600 ${F2}px ${MONO}`;
    if (narrow || d == null) { g.fillStyle = '#fff'; g.fillText(amt, p.x, y + (narrow ? 11 : LH)); }
    else {
      const pt = ' ' + fmtPct(d), wa = g.measureText(amt).width, wp = g.measureText(pt).width, lx = p.x - (wa + wp) / 2;
      g.textAlign = 'left'; g.fillStyle = '#fff'; g.fillText(amt, lx, y + LH);
      g.fillStyle = d >= 0 ? '#5fe3a1' : '#ff7a7a'; g.fillText(pt, lx + wa, y + LH); g.textAlign = 'center';
    }
  }
  // labels that sit on top of everything: stream amounts, link notes
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const o of flowLabs) {
    g.font = `600 ${narrow ? 9.5 : 11}px ${MONO}`;
    const w = g.measureText(o.txt).width + 10, h = narrow ? 15 : 17;
    g.fillStyle = 'rgba(5,6,13,.82)'; g.beginPath(); g.roundRect(o.x - w / 2, o.y - h / 2, w, h, 5); g.fill();
    g.fillStyle = o.col; g.fillText(o.txt, o.x, o.y + 0.5);
  }
  g.textBaseline = 'alphabetic';
  // dot legend
  g.textAlign = 'right'; g.font = `500 ${narrow ? 9 : 10.5}px ${FONT}`; g.fillStyle = 'rgba(111,120,155,.95)';
  const ly = L.whoY + (narrow ? -18 : -22);
  const LEG = narrow ? `1 dot = ${UNIT_TXT} moved this quarter` : `1 dot = ${UNIT_TXT} moved this quarter · dashed ring = a year ago${S.threads.length && W >= 1200 ? ' · dotted thread = searches linked to a pool' : ''}`;
  g.fillText(LEG, W - (narrow ? 10 : 22), ly);
  if (!narrow) {
    const tx = W - 22 - g.measureText(LEG).width - 14;
    g.fillStyle = C_OUT; g.beginPath(); g.arc(tx, ly - 3.5, 2.6, 0, 7); g.fill(); g.fillStyle = 'rgba(111,120,155,.95)'; g.fillText('out', tx - 7, ly);
    const tx2 = tx - 7 - g.measureText('out').width - 12;
    g.fillStyle = C_IN; g.beginPath(); g.arc(tx2, ly - 3.5, 2.6, 0, 7); g.fill(); g.fillStyle = 'rgba(111,120,155,.95)'; g.fillText('in', tx2 - 7, ly);
  }
}

// ------------------------------------------------------------------ timeline
const tl = $('tl'), tg = tl.getContext('2d');
function timelineBase() {
  const r = tl.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2), W = r.width, H = r.height;
  const c = document.createElement('canvas'); c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const D = S.D, n = D.weeks.length, narrow = W < 700, x0 = narrow ? 44 : 84, w = W - x0 - 6, X = (k) => x0 + (k / (n - 1)) * w, cw = w / (n - 1) + 0.6;
  let y = 12;
  // mood rows
  const rh = narrow ? 6 : 8;
  for (const m of S.moods) {
    x.fillStyle = 'rgba(160,172,255,.05)'; x.fillRect(x0, y, w, rh);
    for (let k = 0; k < n; k++) { const z = m.heat[k]; if (z == null || z < 1.2) continue; x.fillStyle = hexA(m.c, clamp((z - 1.2) / 2.6, 0.1, 1)); x.fillRect(X(k), y, cw, rh); }   // lit when a topic in the family is unusually high for that topic (≥ 1.2 of its own standard deviations)
    x.font = `600 ${narrow ? 7.5 : 9.5}px ${FONT}`; x.fillStyle = m.c; x.textAlign = 'right'; x.fillText(narrow ? m.m.name.slice(0, 6) : m.m.name, x0 - 6, y + rh - (narrow ? 0 : 0.5));
    y += rh + 2;
  }
  y += 5;
  // stacked money
  const hA = H - y - 15, tot = D.weeks.map((_, k) => S.pools.reduce((s, p) => s + (p.p.v[k] || 0), 0)), mx = Math.max(...tot) || 1;
  const acc = new Float64Array(n);
  for (const p of S.pools) {
    x.beginPath();
    for (let k = 0; k < n; k++) { const yy = y + hA - (acc[k] / mx) * hA; k ? x.lineTo(X(k), yy) : x.moveTo(X(k), yy); }
    for (let k = n - 1; k >= 0; k--) { acc[k] += p.p.v[k] || 0; x.lineTo(X(k), y + hA - (acc[k] / mx) * hA); }
    x.closePath(); x.fillStyle = hexA(GC[p.p.group], 0.5); x.fill();
  }
  x.font = `600 ${narrow ? 7.5 : 9.5}px ${FONT}`; x.fillStyle = 'rgba(170,178,208,.9)'; x.textAlign = 'right';
  x.fillText('Money', x0 - 6, y + 10);
  if (!narrow) { x.font = `500 9px ${MONO}`; x.fillStyle = 'rgba(111,120,155,1)'; x.fillText(fmtB(tot[n - 1]), x0 - 6, y + 22); }
  // years
  x.font = `500 9.5px ${MONO}`; x.fillStyle = 'rgba(111,120,155,1)'; x.textAlign = 'center';
  let ly = null;
  D.weeks.forEach((t, k) => { const yr = new Date(t).getUTCFullYear(); if (yr !== ly) { ly = yr; if (yr % (narrow ? 5 : 2) === 0) { x.fillText(String(yr), X(k), H - 3); x.fillStyle = 'rgba(160,172,255,.07)'; x.fillRect(X(k), 10, 1, H - 24); x.fillStyle = 'rgba(111,120,155,1)'; } } });
  // big-move dots
  for (const e of D.events) { const k = D.weeks.findIndex((t) => t >= e.t); x.fillStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.arc(X(k), 5, 2.3, 0, 7); x.fill(); }
  return { img: c, x0, w, W, H, dpr };
}
function drawTimeline() {
  const r = tl.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (r.width < 50 || r.height < 30) return;
  if (tl.width !== Math.round(r.width * dpr) || tl.height !== Math.round(r.height * dpr)) { tl.width = Math.round(r.width * dpr); tl.height = Math.round(r.height * dpr); tlBase = null; }
  if (!tlBase) tlBase = timelineBase();
  tg.setTransform(1, 0, 0, 1, 0, 0); tg.clearRect(0, 0, tl.width, tl.height); tg.drawImage(tlBase.img, 0, 0);
  tg.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = tlBase.x0 + (S.T / (S.D.weeks.length - 1)) * tlBase.w;
  tg.fillStyle = 'rgba(255,255,255,.95)'; tg.fillRect(x - 0.75, 0, 1.5, r.height - 13);
  tg.beginPath(); tg.arc(x, 5, 3.6, 0, 7); tg.fill();
}
let drag = false;
const scrub = (cx) => { S.evHold = null; if (!tlBase) return; const r = tl.getBoundingClientRect(); S.T = clamp((cx - r.left - tlBase.x0) / tlBase.w, 0, 1) * (S.D.weeks.length - 1); };
tl.addEventListener('pointerdown', (e) => { drag = true; tl.setPointerCapture(e.pointerId); S.playing = false; updatePlay(); scrub(e.clientX); });
tl.addEventListener('pointermove', (e) => {
  if (drag) { scrub(e.clientX); return; }
  if (!tlBase) return;
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, D = S.D, n = D.weeks.length;
  const ev = y < 14 && D.events.find((v) => Math.abs(tlBase.x0 + (D.weeks.findIndex((t) => t >= v.t) / (n - 1)) * tlBase.w - x) < 6);
  if (ev) showTip(`<h4>Big move · ${iso(ev.t)}</h4><div class="sub">4-week change, unusually large for each series</div><table>${ev.moves.map((m) => `<tr><td>${esc(m.k)}</td><td class="${m.pct >= 0 ? 'up' : 'dn'}">${fmtPct(m.pct)}</td></tr>`).join('')}</table>`, e.clientX, r.top - 110);
  else if (y > 12 && x >= tlBase.x0 - 2) {
    const k = Math.round(clamp((x - tlBase.x0) / tlBase.w, 0, 1) * (n - 1)), d = new Date(D.weeks[k]);
    let top = null;
    for (const m of S.moods) for (const c of m.cells) { const v = c.p.v[k]; if (v != null && (!top || v > top.v)) top = { m, c, v }; }
    const tot = S.pools.reduce((s, p) => s + (p.p.v[k] || 0), 0);
    showTip(`<h4>${d.getUTCFullYear()} ${MON[d.getUTCMonth()]}</h4>${rowsT([['Most above usual', top ? `<span style="color:${top.m.c}">${esc(top.c.p.label)}</span> ${fmtPct(top.v)}` : '—'], ['Money in all pools', fmtB(tot)]])}<div class="src">Click to go there</div>`, e.clientX - 60, r.top - 104);
  } else hideTip();
});
tl.addEventListener('pointerup', () => { drag = false; });
tl.addEventListener('pointerleave', hideTip);

// ------------------------------------------------------------------ tooltips on the stage
function showTip(html, x, y) { const t = $('tip'); t.innerHTML = html; t.style.display = 'block'; const w = t.offsetWidth, h = t.offsetHeight; t.style.left = clamp(x + 14, 8, innerWidth - w - 8) + 'px'; t.style.top = clamp(y + 14, 8, innerHeight - h - 8) + 'px'; }
function hideTip() { $('tip').style.display = 'none'; }
const rowsT = (rows) => `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
function moodTip(m, i) {
  const parts = m.m.parts.map((p) => ({ p, v: p.v[i] })).filter((x) => x.v != null).sort((a, b) => b.v - a.v);
  return `<h4 style="color:${m.c}">${esc(m.m.name)}</h4><div class="sub">Google searches this month vs the same topic's previous 3 years, compared with all topics</div>${rowsT(parts.map((x) => [esc(x.p.label) + (x.p.src === 'search' ? ' <span class="mute">keyword</span>' : ''), `<span class="${x.v >= 0 ? 'up' : 'dn'}">${fmtPct(x.v)}</span>`]))}<div class="src">Google Trends (${esc(S.M.meta.geo)}). Relative interest, not a number of people.</div>`;
}
function cellTip(m, c, i) {
  const v = c.p.v[i], v1 = yearAgo(c.p.v, i);
  return `<h4 style="color:${m.c}">${esc(c.p.label)} ${fmtPct(v)}</h4><div class="sub">${esc(m.m.name)} · ${c.p.src === 'search' ? 'search keyword' : 'Google search category'}</div>${rowsT([['This month vs its usual', fmtPct(v)], ['A year ago', v1 == null ? '—' : fmtPct(v1)]])}${S.threads.filter((t) => t.c === c).map((t) => `<div class="src" style="color:${m.c}">Linked (dotted thread): over 20 years these searches moved ${t.r > 0 ? 'with' : 'against'} ${esc(t.word)} (correlation ${Math.abs(t.r).toFixed(2)}).</div>`).join('')}<div class="src">Google Trends (${esc(S.M.meta.geo)}): searches vs this topic's own previous 3 years, after removing the change common to all topics. Not a number of people.</div>`;
}
function poolTip(p, i) {
  const v = p.p.v[i], v1 = yearAgo(p.p.v, i), est = p.p.est && p.p.est[i];
  const rows = [['Held', (est ? '~' : '') + fmtB(v)], ['vs 1 year ago', v != null && v1 ? `${fmtSB(v - v1)} (${fmtPct((v / v1 - 1) * 100)})` : '—']];
  for (const F of S.flows) if (F.f.to === p.p.id || F.f.from === p.p.id) { const q = F.f.q[i]; rows.push([esc(F.f.label.replace(/ \(.*\)/, '')), q == null ? '<span class="mute">not published</span>' : `<span style="color:${(q >= 0) === (F.f.to === p.p.id) ? C_IN : C_OUT}">${fmtSB(q)}</span> / qtr`]); }
  const krx = S.flows.some((F) => F.f.per === 'm' && F.f.to === p.p.id);
  return `<h4>${esc(p.p.label)}</h4><div class="sub">${esc(GROUPS.find((x) => x.id === p.p.group).label)}${est ? ' · this week is an estimate' : ''}${p.r <= 2.7 ? ' · drawn larger than scale' : ''}</div>${rowsT(rows)}${S.threads.filter((t) => t.pool === p).map((t) => `<div class="src" style="color:${t.m.c}">Linked (dotted thread): ${esc(t.c.p.label)} searches moved ${t.r > 0 ? 'with' : 'against'} ${esc(t.word)} over 20 years (correlation ${Math.abs(t.r).toFixed(2)}).</div>`).join('')}${krx ? '<div class="src">KRX: one group\'s net buying is another\'s net selling. It shows who is buying, not new money.</div>' : ''}<div class="src">${esc(p.p.src)}${p.p.note ? '<br>' + esc(p.p.note) : ''}</div>`;
}
function actorTip(a, i) {
  const rows = S.flows.filter((F) => F.f.from === a.h.id || F.f.to === a.h.id).map((F) => { const q = F.f.q[i]; return [esc(F.f.label.replace(/ \(.*\)/, '')), q == null ? '<span class="mute">not published</span>' : `${fmtSB(q)} / qtr`]; });
  return `<h4>${esc(a.h.label)}</h4><div class="sub">net buying this quarter</div>${rowsT(rows)}<div class="src">${esc(a.h.src)}</div>`;
}
function hit() {
  if (!S.mouse || !L) return null;
  const [mx, my] = S.mouse, i = Math.round(S.T);
  for (const p of S.pools) if (p.v != null && Math.hypot(mx - p.x, my - p.y) <= Math.max(p.r, 9) + 3) return { o: p, html: poolTip(p, i) };
  if (!L.wide) for (const m of S.moods) for (const c of m.cells) if (c.v != null && Math.hypot(mx - c.x, my - c.y) <= Math.max(c.r, L.rc) + 2) return { o: c, html: cellTip(m, c, i) };
  if (!L.wide) for (const m of S.moods) if (Math.abs(mx - m.x) <= L.rc * 7.5 && Math.abs(my - m.y) <= L.hh + 16) return { o: m, html: moodTip(m, i) };
  for (const a of S.actors) if (Math.abs(mx - a.x) <= a.pw / 2 && Math.abs(my - a.y) <= a.ph / 2 + 2) return { o: a, html: actorTip(a, i) };
  return null;
}
stage.addEventListener('pointermove', (e) => { S.mouse = [e.clientX, e.clientY]; });
stage.addEventListener('pointerdown', (e) => { S.mouse = [e.clientX, e.clientY]; });
stage.addEventListener('pointerleave', () => { S.mouse = null; S.hover = null; hideTip(); });

// ------------------------------------------------------------------ controls
function updatePlay() {
  $('playIco').setAttribute('d', S.playing ? 'M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z' : 'M5 3.5v9l7-4.5z');
  for (const b of document.querySelectorAll('[data-sp]')) b.classList.toggle('on', +b.dataset.sp === S.speed);
}
$('bPlay').onclick = () => { if (S.T >= S.D.weeks.length - 1.01) S.T = 0; S.playing = !S.playing; updatePlay(); };
for (const b of document.querySelectorAll('[data-sp]')) b.onclick = () => { S.speed = +b.dataset.sp; S.playing = true; updatePlay(); };
function jumpEvent(dir) {
  const D = S.D, t = D.weeks[Math.round(S.T)];
  const e = dir > 0 ? D.events.find((v) => v.t > t + 86400e3) : [...D.events].reverse().find((v) => v.t < t - 86400e3);
  if (!e) return;
  S.T = Math.max(0, D.weeks.findIndex((w) => w >= e.t)); S.playing = false; updatePlay();
}
$('bPrev').onclick = () => jumpEvent(-1); $('bNext').onclick = () => jumpEvent(1);
for (const [btn, sheet] of [['helpBtn', 'help'], ['findBtn', 'find']]) {
  $(btn).onclick = () => { $(sheet).hidden = false; };
  $(sheet).onclick = (e) => { if (e.target === $(sheet) || e.target.closest('[data-close]')) $(sheet).hidden = true; };
}
addEventListener('keydown', (e) => {
  if (!S.D) return;
  if (e.key === ' ') { e.preventDefault(); $('bPlay').click(); }
  else if (e.key === 'ArrowRight') { e.shiftKey ? jumpEvent(1) : (S.T = Math.min(S.D.weeks.length - 1, Math.round(S.T) + 1), S.playing = false, updatePlay()); }
  else if (e.key === 'ArrowLeft') { e.shiftKey ? jumpEvent(-1) : (S.T = Math.max(0, Math.round(S.T) - 1), S.playing = false, updatePlay()); }
  else if (e.key === 'Escape') { $('help').hidden = true; $('find').hidden = true; }
});
addEventListener('resize', () => { if (S.D) { layout(); S.lastI = -1; } });

// ------------------------------------------------------------------ findings sheet
function renderFindings() {
  const rows = [];
  const lag = (k, who) => (k === 0 ? 'in the same month' : k > 0 ? `${who} moved ${k} month${k > 1 ? 's' : ''} first` : `${who} moved ${-k} month${k < -1 ? 's' : ''} later`);
  const NM = Object.fromEntries((S.M?.moods || []).map((m) => [m.id, m.name]));
  for (const p of S.M?.pairs || []) rows.push({ a: `<b style="color:${MOODC[p.mood]}">${esc(NM[p.mood])}</b> mood ↔ ${esc(p.target)}`, p, who: 'the mood' });
  for (const p of S.A?.pairs || []) rows.push({ a: `“${esc(p.kw)}” searches ↔ ${esc(p.target)}`, p, who: 'searches' });
  rows.sort((x, y) => Math.abs(y.p.r) - Math.abs(x.p.r));
  $('findRows').innerHTML = rows.map(({ a, p, who }) => `<div class="fr${p.weak ? ' weak' : ''}"><span class="a">${a}</span><span class="r" style="${p.weak ? '' : `color:${p.r > 0 ? C_IN : C_OUT}`}">${p.weak ? 'no clear link' : (p.r > 0 ? 'together ' : 'opposite ') + Math.abs(p.r).toFixed(2)}</span><span class="d">${p.weak ? `strongest correlation only ${p.r.toFixed(2)}` : lag(p.k, who)} · ${p.n} months</span></div>`).join('') || '<p class="note">No attention data built for this view.</p>';
  const strong = rows.filter((r) => !r.p.weak), follow = strong.filter((r) => r.p.k < 0).length, lead = strong.filter((r) => r.p.k > 0).length;
  $('findNote').textContent = rows.length ? `${strong.length} of ${rows.length} pairs show a link (|r| ≥ 0.25). In ${follow} of them attention moved after money, in ${lead} before it, in ${strong.length - follow - lead} in the same month. Read it as: people mostly look after things move.` : '';
}

// ------------------------------------------------------------------ loop + boot
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1); last = now; clock += dt;
  const N = S.D.weeks.length - 1;
  if (S.playing) {
    const tw = S.D.weeks[Math.round(S.T)], e = S.D.events.find((v) => Math.abs(v.t - tw) < 3.5 * 86400e3);
    if (e && S.evHold !== e.t && !REDUCED) { S.evHold = e.t; S.holdUntil = clock + (S.speed > 20 ? 1.3 : 2.8); }
    const slow = clock < (S.holdUntil || 0);                    // linger on each big move so it can be read
    document.body.classList.toggle('bigmove', slow);
    S.T += S.speed * dt * (slow ? 0.05 : 1);
    if (S.T >= N) { S.T = N; S.playing = false; updatePlay(); }
  } else document.body.classList.remove('bigmove');
  const i = Math.round(S.T);
  if (i !== S.lastI) { S.lastI = i; updateText(i); }
  draw(dt);
  drawTimeline();
  if (S.mouse && !drag) { const h = hit(); S.hover = h ? h.o : null; if (h) { showTip(h.html, S.mouse[0], S.mouse[1]); stage.style.cursor = 'help'; } else { if (!$('tip').innerHTML.startsWith('<h4>Big move')) hideTip(); stage.style.cursor = ''; } }
}
async function getJSON(name) { try { const r = await fetch(DATA + name, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch (e) { return null; } }
async function main() {
  $('rUS').classList.toggle('on', REGION === 'us'); $('rKR').classList.toggle('on', REGION === 'kr');
  $('hUnit').textContent = `${UNIT_TXT} per quarter`;
  const [D, M, A] = await Promise.all([getJSON(REGION === 'kr' ? 'data_kr.json' : 'data.json'), getJSON(`mood_${REGION}.json`), getJSON(`attention_${REGION}.json`)]);
  if (!D) { $('ldStep').textContent = REGION === 'kr' ? 'Korea data is not built yet (needs a Bank of Korea ECOS key and tools/build_money.py).' : 'Money data missing. Run python tools/build_money.py'; return; }
  S.D = D; S.M = M; S.A = A;
  if (REGION === 'us') fetch(DATA + 'data_kr.json', { method: 'HEAD' }).then((x) => { if (!x.ok) $('rKR').classList.add('off'); }).catch(() => {});
  if (REGION === 'kr') { document.title = 'Mind & Money · Korea'; $('sub').textContent = 'Korea · what people cared about · where the money went'; }
  // quarterly amount of every flow: official quarterly rates are w·13; weekly/monthly series sum their last 13 weeks
  for (const f of D.flows) {
    f.per ||= 'q';
    f.q = f.w.map((w, k) => { if (w == null) return null; if (f.per === 'q') return w * 13; let a = 0; for (let j = Math.max(0, k - 12); j <= k; j++) a += f.w[j] || 0; return a; });
  }
  S.firstQ = Math.max(0, D.weeks.findIndex((_, k) => D.flows.some((f) => f.per === 'q' && f.q[k] != null)));
  const ord = Object.fromEntries(GROUPS.map((x, k) => [x.id, k]));
  S.pools = D.pools.filter((p) => p.kind !== 'price').map((p, k) => ({ p, k, short: p.label.replace(/ \(.*\)/, '').replace('Money market funds', 'Money funds').replace('US real estate', 'Real estate') }))
    .sort((a, b) => ord[a.p.group] - ord[b.p.group] || a.k - b.k);
  S.poolBy = Object.fromEntries(S.pools.map((p) => [p.p.id, p]));
  S.actors = D.hubs.map((h) => ({ h, name: ACTOR[h.id] || h.label }));
  S.actorBy = Object.fromEntries(S.actors.map((a) => [a.h.id, a]));
  for (const m of M?.moods || []) m.name = MOODN[m.id] || m.name;
  S.moods = (M?.moods || []).map((m) => ({ m, c: MOODC[m.id] || m.color, cells: m.parts.map((p) => ({ p, cur: null })),
    heat: (() => {
      const sd = m.parts.map((p) => { const a = p.v.filter((v) => v != null); const mu = a.reduce((s, v) => s + v, 0) / (a.length || 1); return Math.sqrt(a.reduce((s, v) => s + (v - mu) ** 2, 0) / (a.length || 1)) || 1; });
      return D.weeks.map((_, k) => { let b = null; m.parts.forEach((p, q) => { const v = p.v[k]; if (v != null && (b == null || v / sd[q] > b)) b = v / sd[q]; }); return b; });
    })() }));
  buildMind();
  if (M) M.wikiBy = Object.fromEntries((M.wiki || []).map((w) => [w.m, w]));
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  S.flows = D.flows.map((f) => ({ f, ph: Float32Array.from({ length: 260 }, rnd), jx: Float32Array.from({ length: 260 }, () => rnd() * 2 - 1), dur: 3.2 + rnd() * 1.2 }));
  const qs = []; for (const f of D.flows) for (const q of f.q) if (q) qs.push(Math.abs(q));
  qs.sort((a, b) => a - b); S.qRef = qs[Math.floor(qs.length * 0.985)] || 1;
  const POOL_OF = [[/Bitcoin/, 'bitcoin', 'the bitcoin price'], [/S&P 500/, 'stocks', 'stock prices'], [/→ stocks/, 'stocks', 'net stock buying'], [/Gold/, 'gold', 'the gold price']];
  S.threads = [];
  for (const p of A?.pairs || []) {
    if (p.weak) continue;
    const hit = POOL_OF.find(([re]) => re.test(p.target)), pool = hit && S.poolBy[hit[1]]; if (!pool) continue;
    for (const m of S.moods) { const c = m.cells.find((x) => x.p.label === `“${p.kw}”`); if (c) S.threads.push({ m, c, pool, r: p.r, k: p.k, word: hit[2] }); }
  }
  renderFindings();
  updatePlay(); updateText(0); layout(); updateText(0); layout();
  document.body.classList.remove('booting');
  requestAnimationFrame(frame);
}
main();

// test hooks (headless screenshots)
window.__mm = S;
window.__seek = (date, play = false) => { const t = new Date(date).getTime(); S.T = Math.max(0, S.D.weeks.findIndex((w) => w >= t)); S.playing = play; updatePlay(); return iso(S.D.weeks[Math.round(S.T)]); };
