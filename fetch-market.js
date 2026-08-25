/*
 * fetch-market.js  (Tier 1: data + news + weekly brief)
 * -----------------------------------------------------
 * Runs in a GitHub Action on a schedule. It:
 *   1. pulls quotes (indices, sectors, your holdings, oil) from Finnhub
 *   2. pulls real market + company news headlines
 *   3. tries the economic calendar (skips quietly if the free tier blocks it)
 *   4. keeps a rolling 10-session history file so it can see WEEKLY trends
 *   5. writes an auto "brief" — big picture, rotation, your book, week, what to watch
 *   6. saves everything to market-data.json (the Action commits it)
 *
 * Every sentence in the brief is assembled from real numbers/headlines.
 * It never invents a causal "why" — that stays a labeled analyst note in the UI.
 *
 * ---------------------------------------------------------------------------
 * THE PRE-MARKET BUG (fixed here)
 * ---------------------------------------------------------------------------
 * Finnhub's free /quote endpoint has NO extended-hours data. Before the 9:30
 * bell it keeps returning the LAST REGULAR SESSION's numbers: `c` is still
 * yesterday's close and `dp` is still yesterday's percent move.
 *
 * The old 8:00am ET run therefore pulled yesterday's result, and the board
 * printed it under "BEFORE OPEN · <today> — where every sector stands going
 * into the open." On 2026-08-25 that put semis at -2.43% on a day SMH
 * actually closed +1.65%. The data was never live; the label just claimed it
 * was.
 *
 * The fix has two halves:
 *   - here: session is derived from the real ET clock and has three honest
 *     states — prior_close / intraday / close — plus a quote-age check so a
 *     stale feed announces itself instead of hiding.
 *   - in the workflow: no run happens before the bell any more.
 *
 * Node 20+ (fetch built in). API key comes from the FINNHUB_API_KEY secret.
 */

const fs = require('fs');

const API_KEY = process.env.FINNHUB_API_KEY;
if (!API_KEY) { console.error('Missing FINNHUB_API_KEY.'); process.exit(1); }
const BASE = 'https://finnhub.io/api/v1';

// ---- universe -------------------------------------------------------------
const INDICES = [
  { sym: 'SPY', name: 'S&P 500' }, { sym: 'QQQ', name: 'Nasdaq 100' },
  { sym: 'DIA', name: 'Dow Jones' }, { sym: 'IWM', name: 'Russell 2000' },
];

// NOTE ON `theme`: there are exactly 11 GICS sectors, and SMH is not one of
// them — it's a sub-industry slice that sits *inside* Technology. Leaving it in
// the breadth math both inflated the denominator (7/12 instead of 7/11) and
// double-counted tech weakness. It stays in the heatmap because it's the single
// most relevant line for your book; it just no longer votes on breadth.
const SECTORS = [
  { sym: 'XLK',  name: 'Technology',     kind: 'cyclical' },
  { sym: 'SMH',  name: 'Semiconductors', kind: 'cyclical', theme: true },
  { sym: 'XLC',  name: 'Comm Svcs',      kind: 'cyclical' },
  { sym: 'XLY',  name: 'Cons Disc',      kind: 'cyclical' },
  { sym: 'XLF',  name: 'Financials',     kind: 'cyclical' },
  { sym: 'XLI',  name: 'Industrials',    kind: 'cyclical' },
  { sym: 'XLB',  name: 'Materials',      kind: 'cyclical' },
  { sym: 'XLE',  name: 'Energy',         kind: 'cyclical' },
  { sym: 'XLV',  name: 'Health Care',    kind: 'defensive' },
  { sym: 'XLP',  name: 'Staples',        kind: 'defensive' },
  { sym: 'XLU',  name: 'Utilities',      kind: 'defensive' },
  { sym: 'XLRE', name: 'Real Estate',    kind: 'defensive' },
];
const HOLDINGS = [
  { sym: 'INTC', name: 'Intel' }, { sym: 'NVDA', name: 'Nvidia' },
  { sym: 'GOOGL', name: 'Alphabet' }, { sym: 'URA', name: 'Uranium ETF' },
  { sym: 'VOO', name: 'S&P 500 ETF' },
];
const OIL = { sym: 'USO', name: 'Oil (USO)' };

// ---- low-level helpers ----------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%';

async function getJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { _err: res.status };
    return await res.json();
  } catch (e) { return { _err: e.message }; }
}

// `ts` is Finnhub's own timestamp for the quote (epoch seconds). We carry it
// through so the run can check how old its own data is — that single field is
// what would have caught the pre-market bug on day one.
async function quote(sym) {
  const q = await getJSON(`${BASE}/quote?symbol=${sym}&token=${API_KEY}`);
  if (!q || q._err || (q.c === 0 && q.pc === 0)) return null;
  return { price: q.c, change: q.d, pct: q.dp, ts: (q.t || null) };
}
async function pull(list) {
  const out = [];
  for (const item of list) {
    const q = await quote(item.sym);
    if (q) out.push({ ...item, price: q.price, change: q.change, pct: q.pct, ts: q.ts });
    await sleep(220);
  }
  return out;
}

// ---- news -----------------------------------------------------------------

// Some Finnhub items carry an API endpoint as their `url` instead of a real
// article link (https://finnhub.io/api/news?id=...). Those render as a headline
// you can click straight into a wall of JSON, so they're skipped.
function isReadableArticle(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (/finnhub\.io\/api\//i.test(url)) return false;
  return true;
}

// `seen` is passed in from the caller so dedup works ACROSS calls, not just
// within one. Previously each companyNews() call had its own Set, so when INTC
// and NVDA both surfaced the same wire story it printed twice.
//
// `allowUnlinked`: linked headlines always win. But if we can't fill the quota
// with real article links, it's better to show the headline with no link than
// to show nothing — an unreadable story you know about beats a story you don't.
// Used for your holdings, where Finnhub's free tier often returns wire items
// (ChartMill and friends) whose only "url" points back into its own API.
// index.html already renders url:'' as plain text instead of an <a>, so a
// linkless headline degrades cleanly with no front-end change.
function cleanHeadlines(arr, n, seen = new Set(), allowUnlinked = false) {
  const out = [];
  const unlinked = [];
  for (const a of (arr || [])) {
    if (!a || !a.headline) continue;
    const key = a.headline.trim().toLowerCase();
    if (seen.has(key)) continue;
    if (!isReadableArticle(a.url)) {
      if (allowUnlinked) unlinked.push({ headline: a.headline, source: a.source || '', key });
      continue;
    }
    seen.add(key);
    out.push({ headline: a.headline, source: a.source || '', url: a.url });
    if (out.length >= n) break;
  }
  // top up from the linkless pile only if real links came up short
  for (const u of unlinked) {
    if (out.length >= n) break;
    if (seen.has(u.key)) continue;
    seen.add(u.key);
    out.push({ headline: u.headline, source: u.source, url: '' });
  }
  return out;
}
async function marketNews(seen) {
  const d = await getJSON(`${BASE}/news?category=general&token=${API_KEY}`);
  if (!Array.isArray(d)) return [];
  return cleanHeadlines(d, 4, seen);
}
async function companyNews(sym, seen) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10);
  const d = await getJSON(`${BASE}/company-news?symbol=${sym}&from=${from}&to=${to}&token=${API_KEY}`);
  if (!Array.isArray(d)) return [];
  // allowUnlinked: your book's news matters more than its clickability
  return cleanHeadlines(d, 1, seen, true);
}
async function econCalendar() {
  // often premium-gated; try, and skip quietly if unavailable
  const to = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const from = new Date().toISOString().slice(0, 10);
  const d = await getJSON(`${BASE}/calendar/economic?from=${from}&to=${to}&token=${API_KEY}`);
  const list = d && d.economicCalendar;
  if (!Array.isArray(list)) return [];
  // keep only US, high-impact-ish events
  return list
    .filter(e => (e.country === 'US' || e.country === 'United States'))
    .filter(e => /CPI|Nonfarm|Payroll|Unemployment|FOMC|Fed|GDP|PPI|Retail|PCE|Jobless/i.test(e.event || ''))
    .slice(0, 4)
    .map(e => ({ event: e.event, date: e.time ? e.time.slice(0, 10) : (e.date || '') }));
}

// ---- history (rolling last 10 close sessions) -----------------------------
const HIST_FILE = 'market-history.json';
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch { return []; }
}
function saveHistory(hist) { fs.writeFileSync(HIST_FILE, JSON.stringify(hist, null, 2)); }

// Weekly stats for a sector symbol from history (last up-to-5 closes).
//
// This used to SUM the daily percentages. That's the approximation everyone
// reaches for, and it drifts: five +2% days is +10.4% compounded, not +10%.
// On a site that teaches valuation, the returns math should be the real thing.
function weekStats(hist, sym) {
  const days = hist.slice(-5).map(h => (h.sectors || {})[sym]).filter(v => typeof v === 'number');
  if (!days.length) return null;
  const growth = days.reduce((acc, d) => acc * (1 + d / 100), 1);
  const cumul = (growth - 1) * 100;
  const redCount = days.filter(v => v < 0).length;
  return { sessions: days.length, cumul, redCount };
}

// ---- the brief builder (data-true, no invented causation) -----------------
function buildBrief(session, label, indices, sectors, holdings, hist, mktNews, coNews, econ) {
  // breadth, rotation and leadership are judged on the 11 real sectors only
  const real = sectors.filter(s => !s.theme);
  const green = real.filter(s => s.pct > 0.05);
  const red = real.filter(s => s.pct < -0.05);
  const sorted = [...real].sort((a, b) => b.pct - a.pct);
  const leaders = sorted.slice(0, 2);
  const laggards = sorted.slice(-2).reverse();
  const spx = indices.find(i => i.sym === 'SPY');
  const iwm = indices.find(i => i.sym === 'IWM');
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b.pct, 0) / arr.length : 0;
  const cyc = avg(real.filter(s => s.kind === 'cyclical'));
  const def = avg(real.filter(s => s.kind === 'defensive'));

  // 1) big picture — a TONE score combining index direction + rotation + breadth
  //
  // The old thresholds let a single quiet tick decide the whole label: a -0.2%
  // S&P day scored -1 and printed "Risk-off" even with 7 sectors green, small
  // caps up and rotation flat. Two changes: the S&P has to actually move
  // (±0.25%) to vote, and it now takes TWO agreeing signals to earn a
  // directional label. Small caps get a vote too — they're a cleaner read on
  // risk appetite than the megacap-dominated S&P.
  let score = 0;
  if (spx) { if (spx.pct > 0.25) score++; else if (spx.pct < -0.25) score--; }
  if (iwm) { if (iwm.pct > 0.4) score++; else if (iwm.pct < -0.4) score--; }
  if (cyc - def > 0.3) score++; else if (def - cyc > 0.3) score--;
  if (green.length >= 8) score++; else if (red.length >= 8) score--;

  let toneLabel = score >= 2 ? 'Risk-on' : score <= -2 ? 'Risk-off' : 'Mixed';

  // Three honest sessions, three honest tenses. The old code had exactly two
  // and forced every morning run into the word "indicated" — which is how a
  // day-old close got described as a pre-market indication.
  const word = session === 'intraday' ? 'tape'
             : session === 'prior_close' ? 'tone (last session)'
             : 'tone';
  const verb = session === 'intraday' ? 'trading' : 'closed';

  // note the divergence when breadth and the index disagree — a genuinely useful read
  let divergence = '';
  if (spx && spx.pct < -0.1 && green.length >= 7) divergence = ' — positive breadth masked by megacap weakness';
  else if (spx && spx.pct > 0.1 && red.length >= 7) divergence = ' — index held up by megacaps despite weak breadth';

  // If the index and breadth are pulling opposite ways, that IS the mixed case.
  // Saying "Risk-off tone — positive breadth" in one sentence argues with itself.
  if (divergence) toneLabel = 'Mixed';

  const picture =
    `${toneLabel} ${word}${divergence}. ` +
    (spx ? `S&P ${verb} ${fmt(spx.pct)}, ` : '') +
    `${green.length}/${real.length} sectors higher. ` +
    `${leaders[0].name} led (${fmt(leaders[0].pct)}); ${laggards[0].name} lagged (${fmt(laggards[0].pct)}).`;

  // 2) rotation — defensive vs cyclical tilt
  let rotation;
  if (def - cyc > 0.3) rotation = `Money leaned toward defensives (Staples/Utilities/Health/Real Estate avg ${fmt(def)}) over cyclicals (${fmt(cyc)}) — a cautious, risk-off tilt.`;
  else if (cyc - def > 0.3) rotation = `Money leaned toward cyclicals (Tech/Financials/Industrials/Energy avg ${fmt(cyc)}) over defensives (${fmt(def)}) — a risk-on, growth-seeking tilt.`;
  else rotation = `No clear defensive/cyclical rotation — cyclicals ${fmt(cyc)} vs defensives ${fmt(def)}, roughly balanced.`;

  // 3) your book
  const semi = sectors.find(s => s.sym === 'SMH');
  const intc = holdings.find(h => h.sym === 'INTC');
  const nvda = holdings.find(h => h.sym === 'NVDA');
  const book = `Your book: ${semi ? `semis (SMH) ${fmt(semi.pct)}, ` : ''}` +
    `${intc ? `INTC ${fmt(intc.pct)}` : ''}${nvda ? `, NVDA ${fmt(nvda.pct)}` : ''}.`;

  // 4) the week — from history
  let week = '';
  const techW = weekStats(hist, 'XLK');
  const semiW = weekStats(hist, 'SMH');
  if (techW && techW.sessions >= 2) {
    week = `Past ${techW.sessions} sessions: Technology closed lower in ${techW.redCount} of ${techW.sessions} (${fmt(techW.cumul)} cumulative)` +
      (semiW ? `, semis ${fmt(semiW.cumul)}` : '') + `. `;
    // weekly sector leader/laggard from cumulative history (real sectors only)
    const cumBySector = SECTORS.filter(s => !s.theme)
      .map(s => ({ name: s.name, c: (weekStats(hist, s.sym) || {}).cumul }))
      .filter(x => typeof x.c === 'number').sort((a, b) => b.c - a.c);
    if (cumBySector.length >= 2) {
      week += `On the week, ${cumBySector[0].name} leads (${fmt(cumBySector[0].c)}) and ${cumBySector[cumBySector.length - 1].name} trails (${fmt(cumBySector[cumBySector.length - 1].c)}).`;
    }
  } else {
    week = `Weekly trend builds as history accumulates — a few more close runs and this line fills in.`;
  }

  // 5) what to watch — econ calendar if available, else holdings/earnings note
  let watch;
  if (econ && econ.length) {
    watch = 'Ahead: ' + econ.map(e => `${e.event}${e.date ? ` (${e.date.slice(5)})` : ''}`).join(', ') + '.';
  } else {
    watch = 'Ahead: watch scheduled macro prints (CPI/PPI, jobs, FOMC) and megacap tech earnings — the swing factors for your semis.';
  }

  // 6) headlines — real, attributed
  const headlines = [];
  (mktNews || []).slice(0, 3).forEach(h => headlines.push({ ...h, tag: 'Market' }));
  (coNews || []).forEach(h => headlines.push({ ...h, tag: 'Your book' }));

  return { asof: label, session, picture, rotation, book, week, watch, headlines };
}

// ---- main -----------------------------------------------------------------
(async () => {
  console.log('Pulling market data + news from Finnhub…');
  const indices = await pull(INDICES);
  const sectors = await pull(SECTORS);
  const holdings = await pull(HOLDINGS);
  const oil = (await pull([OIL]))[0] || null;

  // one shared dedup set across every news call in this run
  const seenHeadlines = new Set();
  const mktNews = await marketNews(seenHeadlines); await sleep(220);
  const coNews = [];
  for (const sym of ['INTC', 'NVDA']) {
    coNews.push(...await companyNews(sym, seenHeadlines));
    await sleep(220);
  }
  const econ = await econCalendar();

  const now = new Date();

  // ---- SESSION: read the real ET clock, to the minute ---------------------
  //
  // The old line was `const session = etHour < 12 ? 'premarket' : 'close'`.
  // Two problems. It only knew two states, and neither of them was true for a
  // run that fired before the 9:30 bell — because Finnhub's free /quote has no
  // extended-hours data, a pre-open run gets the PREVIOUS session's numbers.
  // So "premarket" was a label pasted onto yesterday's close.
  //
  // Now the clock decides between three states that each describe what the
  // numbers in this file actually ARE:
  //   prior_close — ran before the bell; `c`/`dp` are the last session's
  //   intraday    — ran between 9:30 and 16:00; live, partial, still moving
  //   close       — ran after 16:00; final for the day
  const etParts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'America/New_York',
  }).formatToParts(now);
  const etHour = Number(etParts.find(p => p.type === 'hour').value) % 24;
  const etMin = Number(etParts.find(p => p.type === 'minute').value);
  const etMins = etHour * 60 + etMin;

  const OPEN_ET = 9 * 60 + 30;   // 09:30 ET
  const CLOSE_ET = 16 * 60;      // 16:00 ET

  const session = etMins < OPEN_ET ? 'prior_close'
    : etMins < CLOSE_ET ? 'intraday'
      : 'close';

  const label = now.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }) + ' ET';

  // ---- FRESHNESS CHECK ---------------------------------------------------
  //
  // Finnhub stamps every quote with `t`. If SPY's quote is hours old while we
  // think we're mid-session, the feed is stale (holiday, halt, free-tier lag)
  // and the board should say so rather than present old numbers as today's.
  const spyTs = (indices.find(i => i.sym === 'SPY') || {}).ts;
  const quoteAgeMin = spyTs ? Math.round((now.getTime() / 1000 - spyTs) / 60) : null;
  const stale = session === 'intraday' && quoteAgeMin !== null && quoteAgeMin > 90;
  if (stale) console.log(`WARNING: SPY quote is ${quoteAgeMin} min old during an intraday run — feed looks stale.`);

  // Ready-made display strings so the front end doesn't have to re-derive the
  // session logic (and can't drift out of sync with it again).
  const stampPrefix = session === 'prior_close' ? 'LAST CLOSE ·'
    : session === 'intraday' ? 'DURING SESSION ·'
      : 'AT CLOSE ·';
  const statusPill = session === 'prior_close' ? 'LAST CLOSE'
    : session === 'intraday' ? 'LIVE'
      : 'CLOSE';

  // history: on CLOSE runs, append today's sector snapshot (keep last 10)
  //
  // `session === 'close'` now already means "after the 4pm bell" by
  // construction, so the separate etHour guard the old version needed is gone.
  // A midday manual run lands in 'intraday' and can no longer write a half-day
  // move into the weekly history as though it were a close.
  let hist = loadHistory();
  if (session === 'close' && sectors.length) {
    const secMap = {}; sectors.forEach(s => { secMap[s.sym] = Number(s.pct); });
    // date in ET, so a late-evening UTC rollover can't file a close under tomorrow
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
    hist = hist.filter(h => h.date !== today); // avoid dup if re-run same day
    hist.push({ date: today, sectors: secMap });
    hist = hist.slice(-10);
    saveHistory(hist);
  } else {
    console.log(`Session is "${session}" (${etHour}:${String(etMin).padStart(2, '0')} ET) — not recording to weekly history.`);
  }

  const brief = buildBrief(session, label, indices, sectors, holdings, hist, mktNews, coNews, econ);

  const data = {
    updated_utc: now.toISOString(),
    updated_label: label,
    session,
    stamp_prefix: stampPrefix,
    status_pill: statusPill,
    quote_age_min: quoteAgeMin,
    stale,
    source: 'Finnhub',
    indices, sectors, holdings, oil,
    // one-line summary kept for the small "auto-read" strip
    narrative: `${brief.picture} ${brief.book}`,
    // rich structured brief for the "What to expect / Why we closed" panel
    brief,
  };

  fs.writeFileSync('market-data.json', JSON.stringify(data, null, 2));
  console.log(`Wrote market-data.json [${session}] — ${indices.length} idx, ${sectors.length} sectors, ${holdings.length} holdings, ${brief.headlines.length} headlines, econ:${econ.length}, quote age ${quoteAgeMin}m.`);
})();
