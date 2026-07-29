/*
 * fetch-market.js
 * ----------------
 * Runs inside a GitHub Action once per trading day. It:
 *   1. asks Finnhub for a quote on each symbol below
 *   2. turns those quotes into the shape the webpage expects
 *   3. auto-writes a one-line "what led / what lagged" narrative
 *   4. saves everything to market-data.json (which the Action then commits)
 *
 * No external packages needed — Node 20+ has fetch() built in.
 * Your API key is read from an environment variable (a GitHub Secret),
 * so it never lives in the code. That's the important security habit.
 */

const fs = require('fs');

const API_KEY = process.env.FINNHUB_API_KEY;   // supplied by the GitHub Secret
if (!API_KEY) {
  console.error('Missing FINNHUB_API_KEY. Add it as a repo secret.');
  process.exit(1);
}

// ---- what to pull ---------------------------------------------------------
// Finnhub's free tier covers US stocks & ETFs. Real stock indices (like ^GSPC)
// need a paid plan, so we use the tracking ETF as a proxy — the % move is
// effectively identical to the index it follows.
const INDICES = [
  { sym: 'SPY', name: 'S&P 500' },
  { sym: 'QQQ', name: 'Nasdaq 100' },
  { sym: 'DIA', name: 'Dow Jones' },
  { sym: 'IWM', name: 'Russell 2000' },
];

const SECTORS = [
  { sym: 'XLK',  name: 'Technology' },
  { sym: 'SMH',  name: 'Semiconductors' },
  { sym: 'XLC',  name: 'Comm Svcs' },
  { sym: 'XLY',  name: 'Cons Disc' },
  { sym: 'XLP',  name: 'Staples' },
  { sym: 'XLV',  name: 'Health Care' },
  { sym: 'XLF',  name: 'Financials' },
  { sym: 'XLI',  name: 'Industrials' },
  { sym: 'XLE',  name: 'Energy' },
  { sym: 'XLU',  name: 'Utilities' },
  { sym: 'XLB',  name: 'Materials' },
  { sym: 'XLRE', name: 'Real Estate' },
];

// your actual book
const HOLDINGS = [
  { sym: 'INTC', name: 'Intel' },
  { sym: 'NVDA', name: 'Nvidia' },
  { sym: 'GOOGL', name: 'Alphabet' },
  { sym: 'URA',  name: 'Uranium ETF' },
  { sym: 'VOO',  name: 'S&P 500 ETF' },
];

const OIL = { sym: 'USO', name: 'Oil (USO)' };

// ---- helpers --------------------------------------------------------------
// One quote call. Returns { price, change, pct } or null on failure.
async function quote(sym) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) { console.warn(`${sym}: HTTP ${res.status}`); return null; }
    const q = await res.json();
    // Finnhub returns c=current, d=change, dp=percent change, pc=prev close
    if (q.c === 0 && q.pc === 0) { console.warn(`${sym}: no data`); return null; }
    return { price: q.c, change: q.d, pct: q.dp };
  } catch (e) {
    console.warn(`${sym}: ${e.message}`);
    return null;
  }
}

// gentle pacing so we never trip the 60-calls/minute free limit
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pull(list) {
  const out = [];
  for (const item of list) {
    const q = await quote(item.sym);
    if (q) out.push({ sym: item.sym, name: item.name, price: q.price, change: q.change, pct: q.pct });
    await sleep(250); // ~4 calls/sec, comfortably under the limit
  }
  return out;
}

// build the auto-narrative straight from the numbers, framed by session
function writeNarrative(session, sectors, holdings) {
  const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
  if (!sectors.length) return 'Sector data unavailable this run.';

  const sorted = [...sectors].sort((a, b) => b.pct - a.pct);
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const tech = sectors.find(s => s.sym === 'XLK');
  const semi = sectors.find(s => s.sym === 'SMH');
  const intc = holdings.find(h => h.sym === 'INTC');
  const nvda = holdings.find(h => h.sym === 'NVDA');

  const bookLine = (intc && nvda)
    ? ` Your book: INTC ${fmt(intc.pct)}, NVDA ${fmt(nvda.pct)}.`
    : '';
  const semiLine = semi
    ? ` Semis ${semi.pct >= 0 ? 'firm' : 'soft'} at ${fmt(semi.pct)}${tech ? `, broad tech ${fmt(tech.pct)}` : ''}.`
    : '';

  if (session === 'premarket') {
    // "what to expect" — where we stand going into the open + what to watch
    const risk = sorted.filter(s => s.pct < 0).slice(0, 2).map(s => s.name);
    const watch = risk.length ? risk.join(' and ') : 'megacap tech';
    return `Heading into the open — latest prints have ${top.name} firmest (${fmt(top.pct)}) ` +
           `and ${bottom.name} weakest (${fmt(bottom.pct)}).${semiLine}${bookLine} ` +
           `Watch today: ${watch}, plus any scheduled data or Fed headlines.`;
  }
  // close — where we ended and the factual why-skeleton
  return `At the close — ${top.name} led (${fmt(top.pct)}); ${bottom.name} lagged (${fmt(bottom.pct)}).` +
         semiLine + bookLine;
}

// ---- main -----------------------------------------------------------------
(async () => {
  console.log('Pulling market data from Finnhub…');
  const indices = await pull(INDICES);
  const sectors = await pull(SECTORS);
  const holdings = await pull(HOLDINGS);
  const oilArr = await pull([OIL]);
  const oil = oilArr[0] || null;

  const now = new Date();
  // figure out which run this is from the New York hour:
  // before noon ET  -> "premarket" (the ~8am run)   after noon ET -> "close" (the ~5pm run)
  const etHour = Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/New_York'
  }).format(now));
  const session = etHour < 12 ? 'premarket' : 'close';

  const label = now.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
  }) + ' ET';

  const data = {
    updated_utc: now.toISOString(),
    updated_label: label,
    session,                        // "premarket" or "close"
    source: 'Finnhub',
    indices,
    sectors,
    holdings,
    oil,
    narrative: writeNarrative(session, sectors, holdings),
  };

  fs.writeFileSync('market-data.json', JSON.stringify(data, null, 2));
  console.log(`Wrote market-data.json [${session}] — ${indices.length} indices, ${sectors.length} sectors, ${holdings.length} holdings.`);
})();
