#!/usr/bin/env node
/*
 * internships/desk.js
 * -------------------
 * The deterministic half of the /internships bot. Claude runs this; it does
 * the bulk work so that Claude only ever reads a short summary.
 *
 *   scan    Pull the public SimplifyJobs internship feed (~12 MB, ~17k rows),
 *           keep the Summer-2027 finance roles that match profile.json and
 *           were posted since the last scan, and write one tracker document
 *           per hit. Reading the raw feed would cost millions of tokens; this
 *           turns it into ~20 lines.
 *
 *   ingest  Turn rows Claude pulled out of email (12twenty digests, 12twenty
 *           "Application Confirmation" notices, LinkedIn alerts) into tracker
 *           documents with the same keys and fit scoring as `scan`, so a
 *           posting found in a digest and the confirmation for applying to it
 *           land on the same key.
 *
 *   key     Print the tracker key for one company + role.
 *
 * Every write-producing command saves documents as JSON files under --out and
 * prints the ArtifactData batch entries that point at them, so the document
 * bodies never have to pass through the conversation.
 *
 * WHY ONLY SIMPLIFY: the Claude cloud environment this runs in blocks
 * LinkedIn, Greenhouse, Lever, Ashby and Workday. raw.githubusercontent.com is
 * reachable, so the community-maintained SimplifyJobs feed is the one job
 * board this script can read directly. LinkedIn and 12twenty come in through
 * their alert emails instead (see .claude/skills/internships/SKILL.md).
 *
 * Node 20+ (fetch built in). No dependencies.
 */

const fs = require('fs');
const path = require('path');

const PROFILE_PATH = path.join(__dirname, 'profile.json');
const SIMPLIFY_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json';
const BATCH_MAX = 50;   // ArtifactData batch limit
const TZ = 'America/New_York';

// ---- small helpers ----------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

function todayET(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now); // YYYY-MM-DD
}

function pad(n) { return String(n).padStart(2, '0'); }

// Accepts ISO dates/timestamps, unix seconds, "24 October 2026",
// "Saturday, 24 October 2026 11:59PM EDT", "Oct 24, 2026" and "10/24/2026".
// Returns YYYY-MM-DD or null. Never guesses a year.
function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  // Feed timestamps (SimplifyJobs date_posted) are midnight-UTC day stamps, so
  // read them as UTC; converting to ET would land on the previous evening.
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    // A full timestamp is converted to the ET calendar day; a bare date is kept.
    return s.length > 10 && !Number.isNaN(Date.parse(s)) ? todayET(new Date(s)) : `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = s.match(/(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})/);
  if (m) {
    const mi = monthIndex(m[2]);
    if (mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(+m[1])}`;
  }
  m = s.match(/([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mi = monthIndex(m[1]);
    if (mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(+m[2])}`;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  return null;
}

function monthIndex(word) {
  const w = word.toLowerCase();
  return w.length < 3 ? -1 : MONTHS.findIndex(name => name.startsWith(w));
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const COMPANY_NOISE = /\b(inc|llc|llp|l\.?p|p\.?c|ltd|corp|corporation|co|the)\b\.?/gi;

// One posting, one key, whichever source it came from. Doc ids are capped at
// 200 bytes by the store; 150 leaves room and stays readable.
function keyFor(company, role) {
  const c = slug(String(company || '').replace(/,?\s*&\s*co\.?\s*$/i, ' ').replace(COMPANY_NOISE, ' '));
  const r = slug(role);
  return `${c}--${r}`.slice(0, 150).replace(/-+$/, '');
}

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// ---- profile scoring ---------------------------------------------------------

function loadProfile(p = PROFILE_PATH) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function lc(s) { return ` ${String(s || '').toLowerCase()} `; }

function isUS(loc) {
  const s = String(loc || '').trim();
  if (/^(NYC|SF|LA|DC)$/i.test(s)) return true;
  if (/\b(USA|United States)\b/i.test(s)) return true;
  if (/canada|\bUK\b|united kingdom|india|ireland|germany|france|singapore|hong kong|japan|australia|mexico|brazil|poland|netherlands|switzerland|israel/i.test(s)) return false;
  return /,\s*[A-Z]{2}$/.test(s);
}

// Returns { score, fit, why, excluded }.
function score(profile, { role, company = '', locations = [] }) {
  const title = lc(role);
  if (profile.exclude.some(w => title.includes(w.toLowerCase()))) {
    return { score: 0, fit: 'low', why: 'excluded', excluded: true };
  }
  let pts = 0;
  const why = [];
  for (const g of profile.roles) {
    if (g.match.some(w => title.includes(w.toLowerCase()))) { pts += g.weight; why.push(g.label); }
  }
  for (const a of profile.avoid) {
    if (a.match.some(w => title.includes(w.toLowerCase()))) pts += a.weight;
  }
  const locText = locations.join(' | ') + ' ' + role;
  if (profile.locations.home.some(h => locText.includes(h))) { pts += 15; why.push('NY/NJ'); }
  else if (profile.locations.remote.some(r => locText.includes(r))) { pts += 5; why.push('Remote'); }
  else if (profile.locations.require_local && locations.length) {
    // Known locations, none commutable: only worth it with relocation help,
    // which feeds don't report, so park it under low fit with the reason.
    const fit = 'low';
    why.push('Outside commute area: check for relocation help');
    return { score: pts, fit, why: why.join(' · '), excluded: false };
  }

  const fit = pts >= profile.fit.strong ? 'strong' : pts >= profile.fit.possible ? 'possible' : 'low';
  return { score: pts, fit, why: why.join(' · '), excluded: false };
}

// ---- documents -----------------------------------------------------------------

function leadDoc(profile, r, today) {
  const locations = [].concat(r.locations || r.location || []).filter(Boolean);
  const s = score(profile, { role: r.role, company: r.company, locations });
  return {
    s,
    doc: {
      key: keyFor(r.company, r.role),
      company: clean(r.company),
      role: clean(r.role),
      source: r.source || 'Other',
      location: locations.slice(0, 3).join('; '),
      category: categoryFor(r.role),
      deadline: toDate(r.deadline),
      posted: toDate(r.posted),
      link: r.link || '',
      fit: s.fit,
      score: s.score,
      why: s.why,
      found: today,
      status: 'new',
    },
  };
}

// The status ladder and dropdown lists from the original Internship_Tracker
// workbook, kept verbatim so the page, the bot and the Excel export agree.
const STAGES = ['Not Open Yet', 'Researching', 'Interested', 'Applying', 'Applied', 'Online Assessment',
  'Interviewing', 'Final Round', 'Offer', 'Rejected', 'Withdrawn', 'Closed'];
const CATEGORIES = ['Asset Management', 'Wealth Mgmt / Planning', 'Corporate Finance', 'Operations', 'Banking',
  'Markets', 'Risk', 'Other'];
const SOURCES = ['12twenty', 'LinkedIn', 'Company Site', 'Career Fair', 'Handshake', 'Referral', 'Simplify', 'Other'];
const FOLLOW_UP_DAYS = 12;   // the old sheet's rule: follow up 10-14 days after applying

function categoryFor(role) {
  const t = String(role || '').toLowerCase();
  if (/wealth|private client|financial planning|private bank/.test(t)) return 'Wealth Mgmt / Planning';
  if (/risk/.test(t)) return 'Risk';
  if (/investment banking|m&a|restructuring/.test(t)) return 'Banking';
  if (/asset management|investment management|investments?\b|portfolio|distribution|private (equity|credit|markets)|real estate/.test(t)) return 'Asset Management';
  if (/advisory|banking|structured|credit|underwrit/.test(t)) return 'Banking';
  if (/trading|sales|markets|fixed income|equities/.test(t)) return 'Markets';
  if (/operations/.test(t)) return 'Operations';
  if (/financ|fp&a|treasury|accounting|business management/.test(t)) return 'Corporate Finance';
  return 'Other';
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function appDoc(r, today) {
  const stage = STAGES.includes(r.stage) ? r.stage : 'Applied';
  // An explicit null (an imported row with no date) stays blank; only a row that
  // never mentioned a date defaults to today.
  const applied = toDate(r.applied || r.date) || (stage === 'Applied' && r.applied === undefined && r.date === undefined ? today : null);
  const since = applied || today;
  return {
    key: keyFor(r.company, r.role),
    company: clean(r.company),
    role: clean(r.role),
    location: clean(r.location),
    category: CATEGORIES.includes(r.category) ? r.category : categoryFor(r.role),
    tier: ['Lead', 'Target', 'Reach'].includes(r.tier) ? r.tier : '',
    source: SOURCES.includes(r.source) ? r.source : 'Other',
    stage,
    deadline: toDate(r.deadline),
    deadline_note: toDate(r.deadline) ? '' : clean(r.deadline_note || (typeof r.deadline === 'string' ? r.deadline : '')),
    applied,
    followup: toDate(r.followup) || (applied ? addDays(applied, FOLLOW_UP_DAYS) : null),
    next: clean(r.next),
    contact: clean(r.contact),
    pay: clean(r.pay),
    link: r.link || '',
    notes: r.notes || '',
    updated: since,
    history: [{ date: since, stage, note: r.note || (applied ? `Applied via ${r.source || 'unknown source'}` : 'Added to tracker') }],
  };
}

// Writes docs to <out>/<collection>/<key>.json and returns batch entries.
function writeDocs(out, collection, docs) {
  const dir = path.resolve(out, collection);
  fs.mkdirSync(dir, { recursive: true });
  return docs.map(d => {
    const file = path.join(dir, `${d.key}.json`);
    fs.writeFileSync(file, JSON.stringify(d, null, 1));
    // Relative paths are shorter to pass through the conversation; ArtifactData
    // resolves them against the session's working directory.
    const rel = path.relative(process.cwd(), file);
    return { op: 'set', collection, doc_id: d.key, file_path: rel.startsWith('..') ? file : rel };
  });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function printBatches(entries) {
  if (!entries.length) { console.log('\nNo documents to write.'); return; }
  const batches = chunk(entries, BATCH_MAX);
  batches.forEach((b, i) => {
    console.log(`\nBATCH ${i + 1}/${batches.length} (pass as ArtifactData action "batch", writes =)`);
    console.log(JSON.stringify(b));
  });
}

// ---- scan (SimplifyJobs) ---------------------------------------------------------

async function loadSimplify(file) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(SIMPLIFY_URL);
  if (!res.ok) throw new Error(`SimplifyJobs feed returned HTTP ${res.status}`);
  return res.json();
}

function filterSimplify(profile, listings, { sinceTs, today }) {
  const seasons = profile.seasons.map(s => s.toLowerCase());
  const hits = [];
  const stats = { total: listings.length, live: 0, season: 0, recent: 0, kept: 0 };
  for (const x of listings) {
    if (!x.active || !x.is_visible) continue;
    stats.live++;
    if (!(x.terms || []).some(t => seasons.includes(String(t).toLowerCase()))) continue;
    stats.season++;
    if (sinceTs && (x.date_posted || 0) < sinceTs) continue;
    stats.recent++;
    if (Array.isArray(x.degrees) && x.degrees.length && !x.degrees.includes(profile.degree)) continue;
    const locations = x.locations || [];
    if (profile.locations.us_only && !locations.some(isUS)) continue;
    const { s, doc } = leadDoc(profile, {
      company: x.company_name, role: x.title, source: 'Simplify', locations,
      posted: x.date_posted, link: x.url,
    }, today);
    if (s.excluded || s.fit === 'low') continue;
    hits.push(doc);
  }
  // Same role posted for several cities collapses onto one key; keep the first.
  const seen = new Set();
  const unique = hits.filter(d => !seen.has(d.key) && seen.add(d.key));
  unique.sort((a, b) => b.score - a.score || String(b.posted).localeCompare(String(a.posted)));
  stats.kept = unique.length;
  return { docs: unique, stats };
}

function sinceToTs(since) {
  if (!since) return 0;
  const t = Date.parse(since.length === 10 ? `${since}T00:00:00-04:00` : since);
  if (Number.isNaN(t)) throw new Error(`--since is not a date: ${since}`);
  return Math.floor(t / 1000);
}

function line(d) {
  const when = d.deadline ? `due ${d.deadline}` : d.posted ? `posted ${d.posted}` : '';
  return `${d.fit === 'strong' ? '★' : '·'} ${d.company} — ${d.role} [${d.location || 'location n/a'}] ${when}  (${d.why || 'no keyword match'})`;
}

async function cmdScan(opts) {
  const profile = loadProfile(opts.profile);
  const today = todayET();
  const limit = +opts.limit || 40;
  const listings = await loadSimplify(opts.file);
  const { docs, stats } = filterSimplify(profile, listings, { sinceTs: sinceToTs(opts.since), today });
  const kept = docs.slice(0, limit);

  console.log(`SIMPLIFY: ${stats.total} rows · ${stats.live} live · ${stats.season} ${profile.seasons.join('/')} · ` +
    `${stats.recent} posted since ${opts.since || 'ever'} · ${stats.kept} match profile` +
    (stats.kept > limit ? ` (keeping top ${limit})` : ''));
  for (const d of kept.slice(0, 15)) console.log(line(d));
  if (kept.length > 15) console.log(`… ${kept.length - 15} more go straight to the tracker.`);
  printBatches(writeDocs(opts.out, 'leads', kept));
}

// ---- ingest (email rows) ----------------------------------------------------------

function cmdIngest(file, opts) {
  const profile = loadProfile(opts.profile);
  const today = todayET();
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('ingest expects a JSON array of rows');

  const leads = new Map();
  const apps = new Map();
  const problems = [];
  rows.forEach((r, i) => {
    if (!r || !r.company || !r.role) { problems.push(`row ${i}: needs company and role`); return; }
    if (r.type === 'app') {
      const d = appDoc(r, today);
      apps.set(d.key, d);
    } else if (r.type === 'lead') {
      const { s, doc } = leadDoc(profile, r, today);
      if (s.excluded) return;
      leads.set(doc.key, doc);
    } else {
      problems.push(`row ${i}: type must be "lead" or "app"`);
    }
  });
  // A posting that is also in this run's applications is already handled.
  for (const k of apps.keys()) leads.delete(k);

  const L = [...leads.values()].sort((a, b) => String(a.deadline || '9').localeCompare(String(b.deadline || '9')));
  const A = [...apps.values()];
  console.log(`INGEST: ${rows.length} rows → ${A.length} applications, ${L.length} leads` +
    (problems.length ? `, ${problems.length} skipped` : ''));
  for (const p of problems) console.log(`  skipped ${p}`);
  for (const d of A) console.log(`✓ ${d.stage}${d.applied ? ' ' + d.applied : ''}: ${d.company} — ${d.role}`);
  for (const d of L.slice(0, 15)) console.log(line(d));
  if (L.length > 15) console.log(`… ${L.length - 15} more go straight to the tracker.`);
  printBatches([...writeDocs(opts.out, 'apps', A), ...writeDocs(opts.out, 'leads', L)]);
}

// ---- cli ------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[k] = true;
      else { opts[k] = next; i++; }
    } else opts._.push(a);
  }
  return opts;
}

const USAGE = `usage:
  node internships/desk.js scan   --out DIR [--since YYYY-MM-DD|ISO] [--limit 40] [--file listings.json]
  node internships/desk.js ingest ROWS.json --out DIR
  node internships/desk.js key "Company" "Role"`;

async function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, ...rest] = opts._;
  if (cmd === 'key') {
    if (rest.length < 2) throw new Error(USAGE);
    console.log(keyFor(rest[0], rest[1]));
  } else if (cmd === 'scan') {
    if (!opts.out) throw new Error(USAGE);
    await cmdScan(opts);
  } else if (cmd === 'ingest') {
    if (!rest[0] || !opts.out) throw new Error(USAGE);
    cmdIngest(rest[0], opts);
  } else {
    throw new Error(USAGE);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { keyFor, slug, toDate, score, isUS, filterSimplify, leadDoc, appDoc, categoryFor, loadProfile, todayET, STAGES, CATEGORIES, SOURCES };
