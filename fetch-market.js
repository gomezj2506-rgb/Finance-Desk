/*
 * fetch-market.js  (Tier 1: data + news + weekly brief)
 * -----------------------------------------------------
 * Runs in a GitHub Action, twice a day. It:
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
const SECTORS = [
  { sym: 'XLK', name: 'Technology', kind: 'cyclical' },
  { sym: 'SMH', name: 'Semiconductors', kind: 'cyclical' },
  { sym: 'XLC', name: 'Comm Svcs', kind: 'cyclical' },
  { sym: 'XLY', name: 'Cons Disc', kind: 'cyclical' },
  { sym: 'XLF', name: 'Financials', kind: 'cyclical' },
  { sym: 'XLI', name: 'Industrials', kind: 'cyclical' },
  { sym: 'XLB', name: 'Materials', kind: 'cyclical' },
  { sym: 'XLE', name: 'Energy', kind: 'cyclical' },
  { sym: 'XLV', name: 'Health Care', kind: 'defensive' },
  { sym: 'XLP', name: 'Staples', kind: 'defensive' },
  { sym: 'XLU', name: 'Utilities', kind: 'defensive' },
  { sym: 'XLRE', name: 'Real Estate', kind: 'defensive' },
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
async function quote(sym) {
  const q = await getJSON(`${BASE}/quote?symbol=${sym}&token=${API_KEY}`);
  if (!q || q._err || (q.c === 0 && q.pc === 0)) return null;
  return { price: q.c, change: q.d, pct: q.dp };
}
async function pull(list) {
  const out = [];
  for (const item of list) {
    const q = await quote(item.sym);
    if (q) out.push({ ...item, price: q.price, change: q.change, pct: q.pct });
    await sleep(220);
  }
  return out;
}

// ---- news -----------------------------------------------------------------
function cleanHeadlines(arr, n) {
  const seen = new Set(); const out = [];
  for (const a of (arr || [])) {
    if (!a || !a.headline || seen.has(a.headline)) continue;
    seen.add(a.headline);
    out.push({ headline: a.headline, source: a.source || '', url: a.url || '' });
    if (out.length >= n) break;
  }
  return out;
}
async function marketNews() {
  const d = await getJSON(`${BASE}/news?category=general&token=${API_KEY}`);
  if (!Array.isArray(d)) return [];
  return cleanHeadlines(d, 4);
}
async function companyNews(sym) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 4 * 864e5).toISOString().slice(0, 10);
  const d = await getJSON(`${BASE}/company-news?symbol=${sym}&from=${from}&to=${to}&token=${API_KEY}`);
  if (!Array.isArray(d)) return [];
  return cleanHeadlines(d, 1);
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

// weekly stats for a sector symbol from history (last up-to-5 closes)
function weekStats(hist, sym) {
  const days = hist.slice(-5).map(h => (h.sectors || {})[sym]).filter(v => typeof v === 'number');
  if (!days.length) return null;
  const cumul = days.reduce((a, b) => a + b, 0);
  const redCount = days.filter(v => v < 0).length;
  return { sessions: days.length, cumul, redCount };
}

// ---- the brief builder (data-true, no invented causation) -----------------
function buildBrief(session, label, indices, sectors, holdings, hist, mktNews, coNews, econ) {
  const green = sectors.filter(s => s.pct > 0.05);
  const red = sectors.filter(s => s.pct < -0.05);
  const sorted = [...sectors].sort((a, b) => b.pct - a.pct);
  const leaders = sorted.slice(0, 2);
  const laggards = sorted.slice(-2).reverse();
  const spx = indices.find(i => i.sym === 'SPY');
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b.pct, 0) / arr.length : 0;
  const cyc = avg(sectors.filter(s => s.kind === 'cyclical'));
  const def = avg(sectors.filter(s => s.kind === 'defensive'));

  // 1) big picture — a TONE score combining index direction + rotation + breadth
  let score = 0;
  if (spx) { if (spx.pct > 0.1) score++; else if (spx.pct < -0.1) score--; }
  if (cyc - def > 0.3) score++; else if (def - cyc > 0.3) score--;
  if (green.length >= 8) score++; else if (red.length >= 8) score--;
  const toneLabel = score >= 1 ? 'Risk-on' : score <= -1 ? 'Risk-off' : 'Mixed';
  const word = session === 'premarket' ? 'setup' : 'tone';
  const verb = session === 'premarket' ? 'indicated' : 'closed';
  // note the divergence when breadth and the index disagree — a genuinely useful read
  let divergence = '';
  if (spx && spx.pct < -0.1 && green.length >= 7) divergence = ' — positive breadth masked by megacap weakness';
  else if (spx && spx.pct > 0.1 && red.length >= 7) divergence = ' — index held up by megacaps despite weak breadth';
  const picture =
    `${toneLabel} ${word}${divergence}. ` +
    (spx ? `S&P ${session === 'premarket' ? 'pre-market' : verb} ${fmt(spx.pct)}, ` : '') +
    `${green.length}/${sectors.length} sectors higher. ` +
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
    // weekly sector leader/laggard from cumulative history
    const cumBySector = SECTORS.map(s => ({ name: s.name, c: (weekStats(hist, s.sym) || {}).cumul }))
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
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- main -----------------------------------------------------------------
(async () => {
  console.log('Pulling market data + news from Finnhub…');
  const indices = await pull(INDICES);
  const sectors = await pull(SECTORS);
  const holdings = await pull(HOLDINGS);
  const oil = (await pull([OIL]))[0] || null;

  const mktNews = await marketNews(); await sleep(220);
  const coNews = [];
  for (const sym of ['INTC', 'NVDA']) { coNews.push(...await companyNews(sym)); await sleep(220); }
  const econ = await econCalendar();

  const now = new Date();
  const etHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(now));
  const session = etHour < 12 ? 'premarket' : 'close';
  const label = now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';

  // history: on CLOSE runs, append today's sector snapshot (keep last 10)
  let hist = loadHistory();
  if (session === 'close' && sectors.length) {
    const secMap = {}; sectors.forEach(s => { secMap[s.sym] = Number(s.pct); });
    const today = now.toISOString().slice(0, 10);
    hist = hist.filter(h => h.date !== today);          // avoid dup if re-run same day
    hist.push({ date: today, sectors: secMap });
    hist = hist.slice(-10);
    saveHistory(hist);
  }

  const brief = buildBrief(session, label, indices, sectors, holdings, hist, mktNews, coNews, econ);

  const data = {
    updated_utc: now.toISOString(),
    updated_label: label,
    session,
    source: 'Finnhub',
    indices, sectors, holdings, oil,
    // one-line summary kept for the small "auto-read" strip
    narrative: `${brief.picture} ${brief.book}`,
    // rich structured brief for the "What to expect / Why we closed" panel
    brief,
  };

  fs.writeFileSync('market-data.json', JSON.stringify(data, null, 2));
  console.log(`Wrote market-data.json [${session}] — ${indices.length} idx, ${sectors.length} sectors, ${holdings.length} holdings, ${brief.headlines.length} headlines, econ:${econ.length}.`);
})();
