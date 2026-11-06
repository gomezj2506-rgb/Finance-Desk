// Run: node --test internships/
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { keyFor, toDate, score, isUS, filterSimplify, loadProfile, appDoc, categoryFor } = require('./desk.js');

const profile = loadProfile();

test('a 12twenty digest posting and its confirmation email share one key', () => {
  // Digest line: "<Company> - <Role>"; confirmation subject: "... for <Role> - <Company>".
  assert.equal(
    keyFor('Student Careers at Example Partners', '2027 Summer Analyst Program - Insurance Risk - Liquidity'),
    keyFor('Student Careers at Example Partners ', '2027 Summer Analyst Program -  Insurance Risk - Liquidity'),
  );
  assert.equal(keyFor('Acme', 'Analyst'), keyFor('ACME', 'analyst'));
  assert.equal(
    keyFor('Example Chase & Co.', '2027 Business Management - Summer Analyst  (New York Metro)'),
    'example-chase--2027-business-management-summer-analyst-new-york-metro',
  );
  assert.equal(keyFor('BDO USA, P.C.', 'Assurance Intern'), 'bdo-usa--assurance-intern');
  assert.match(keyFor('A'.repeat(300), 'B'), /^[a-z0-9-]{1,150}$/);
});

test('toDate reads the date formats found in job emails and feeds', () => {
  assert.equal(toDate('Saturday, 24 October 2026 11:59PM EDT'), '2026-10-24');
  assert.equal(toDate('Oct 27, 2026'), '2026-10-27');
  assert.equal(toDate('10/1/2026'), '2026-10-01');
  assert.equal(toDate('2026-09-30'), '2026-09-30');
  assert.equal(toDate('2026-10-01T02:13:39.000Z'), '2026-09-30'); // 10:13pm ET the night before
  assert.equal(toDate(1790726400), '2026-09-30');
  assert.equal(toDate('rolling'), null);
  assert.equal(toDate(''), null);
});

test('scoring ranks core finance roles above tech and drops excluded ones', () => {
  const am = score(profile, { role: '2027 Asset Management Business Strategy Summer Internship', locations: ['New York, NY'] });
  const tax = score(profile, { role: 'Winter Tax Co-op Intern (2027) - Woburn, MA', locations: [] });
  const swe = score(profile, { role: 'Software Engineer Intern', locations: ['NYC'] });
  assert.equal(am.fit, 'strong');
  assert.equal(tax.fit, 'low');
  assert.equal(swe.excluded, true);
});

test('isUS separates US cities from abroad', () => {
  for (const l of ['NYC', 'SF', 'Jersey City, NJ', 'Remote in USA']) assert.equal(isUS(l), true, l);
  for (const l of ['London, UK', 'Toronto, ON, Canada', 'Remote in Canada']) assert.equal(isUS(l), false, l);
});

test('filterSimplify keeps only new, live, US, undergrad, in-season matches', () => {
  const base = { active: true, is_visible: true, terms: ['Summer 2027'], degrees: ["Bachelor's"],
    date_posted: 1790000000, company_name: 'Garda', title: 'Trading Analyst Intern - Credit', locations: ['NYC'], url: 'u' };
  const rows = [
    base,
    { ...base, title: 'Trading Analyst Intern - Credit', locations: ['Stamford, CT'] }, // same key, collapses
    { ...base, company_name: 'Old', date_posted: 1700000000 },                        // before --since
    { ...base, company_name: 'Closed', active: false },
    { ...base, company_name: 'Grad', degrees: ["Master's"] },
    { ...base, company_name: 'Abroad', locations: ['London, UK'] },
    { ...base, company_name: 'Later', terms: ['Summer 2028'] },
    { ...base, company_name: 'Tech', title: 'Software Engineer Intern' },
  ];
  const { docs } = filterSimplify(profile, rows, { sinceTs: 1789000000, today: '2026-10-01' });
  assert.deepEqual(docs.map(d => d.company), ['Garda']);
  assert.equal(docs[0].source, 'Simplify');
  assert.equal(docs[0].status, 'new');
});

test('ingest writes app + lead docs and drops a lead the same run applied to', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const rows = [
    { type: 'lead', company: 'Example Asset Co', role: '2027 Asset Management Business Strategy Summer Internship', source: '12twenty', deadline: 'Sunday, 25 October 2026 11:59PM EDT' },
    { type: 'lead', company: 'Example Partners', role: '2027 Summer Analyst Program - Insurance Risk - Liquidity', source: '12twenty' },
    { type: 'app', company: 'Example Partners', role: '2027 Summer Analyst Program - Insurance Risk - Liquidity', source: '12twenty', applied: '2026-09-30T04:12:29Z' },
    { type: 'lead', company: '', role: 'missing company' },
  ];
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(rows));
  const out = execFileSync('node', [path.join(__dirname, 'desk.js'), 'ingest', path.join(dir, 'rows.json'), '--out', dir], { encoding: 'utf8' });
  assert.match(out, /1 applications, 1 leads, 1 skipped/);
  const lead = JSON.parse(fs.readFileSync(path.join(dir, 'leads', keyFor('Example Asset Co', rows[0].role) + '.json'), 'utf8'));
  assert.equal(lead.deadline, '2026-10-25');
  assert.equal(lead.fit, 'strong');
  const app = JSON.parse(fs.readFileSync(path.join(dir, 'apps', keyFor(rows[2].company, rows[2].role) + '.json'), 'utf8'));
  assert.equal(app.applied, '2026-09-30');
  assert.equal(app.stage, 'Applied');
  const batch = JSON.parse(out.split('\n').find(l => l.startsWith('[{')));
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map(b => b.collection).sort(), ['apps', 'leads']);
});

test('categoryFor sorts typical finance titles into the tracker categories', () => {
  assert.equal(categoryFor('2027 Summer Intern – Global Wealth Management, Private Client Group Analyst, US'), 'Wealth Mgmt / Planning');
  assert.equal(categoryFor('2027 Summer Analyst Program - Insurance Risk - Liquidity'), 'Risk');
  assert.equal(categoryFor('2027 Summer Analyst - Investment Banking'), 'Banking');
  assert.equal(categoryFor('Summer Analyst - Distribution'), 'Asset Management');
  assert.equal(categoryFor('2027 Summer Internship - Sales Rotation'), 'Markets');
  assert.equal(categoryFor('2027 Global Finance & Business Management - Summer Analyst'), 'Corporate Finance');
  assert.equal(categoryFor('Analyst, Trade and Customs'), 'Other');
});

test('appDoc sets a follow-up 12 days out and keeps watchlist rows unapplied', () => {
  const a = appDoc({ company: 'Example Investments', role: 'Operations Intern', source: 'Company Site', applied: '2026-09-30' }, '2026-10-01');
  assert.equal(a.stage, 'Applied');
  assert.equal(a.followup, '2026-10-12');
  const w = appDoc({ company: 'Example Pharma', role: 'Finance Intern', stage: 'Not Open Yet', deadline: 'Opens ~Oct', source: 'Company Site' }, '2026-10-01');
  assert.equal(w.applied, null);
  assert.equal(w.followup, null);
  assert.equal(w.deadline, null);
  assert.equal(w.deadline_note, 'Opens ~Oct');
  assert.equal(appDoc({ company: 'X', role: 'Y', source: 'Myspace' }, '2026-10-01').source, 'Other');
});

test('roles outside the commute area drop to low fit unless remote', () => {
  const far = score(profile, { role: '2027 Asset Management Summer Analyst', locations: ['Chicago, IL'] });
  assert.equal(far.fit, 'low');
  assert.match(far.why, /relocation/);
  assert.equal(score(profile, { role: '2027 Asset Management Summer Analyst', locations: ['Hoboken, NJ'] }).fit, 'strong');
  assert.notEqual(score(profile, { role: '2027 Asset Management Summer Analyst', locations: ['Remote in USA'] }).fit, 'low');
  // 12twenty digests carry no location; those stay scored on the role.
  assert.equal(score(profile, { role: '2027 Asset Management Summer Analyst', locations: [] }).fit, 'strong');
});
