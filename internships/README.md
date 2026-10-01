# Internship bot

Type **`/internships`** in a Claude Code session on this repo (claude.ai/code on
phone, Mac or desktop). It only runs when you type it; nothing is scheduled.

| command | does | cost |
|---|---|---|
| `/internships` | logs new applications, moves statuses from replies, finds new postings, updates the tracker | most |
| `/internships status` | applications and replies only | low |
| `/internships find` | new postings only | medium (each 12twenty digest is ~12k tokens) |
| `/internships excel` | sends the tracker as an Excel workbook in the original layout | low |
| `/internships add applied to X via LinkedIn today` | records one change you tell it | lowest |
| `/internships import` (with a file attached) | merges a spreadsheet into the tracker | low |

**Where things live**

- The tracker itself is a private claude.ai page (the link is in
  `.claude/skills/internships/SKILL.md`). Your application data is stored there,
  never in this public repo.
- `desk.js` does the bulk work without spending tokens: it filters the
  SimplifyJobs feed (~17k postings) down to the handful that match
  `profile.json`, and turns rows pulled from email into tracker records.
- `profile.json` is what "a good fit" means: role keywords, locations, and
  the skills from your resume. Edit it to change what gets flagged.
- `export_xlsx.py` rebuilds the Excel tracker (Dashboard, Tracker, New Leads).

**Sources**

- 12twenty: weekly saved-search digests and "Application Confirmation" emails
  in your school Outlook (Microsoft 365 connector).
- LinkedIn: job-alert and "application was sent" emails, read through the
  Gmail connector. The cloud environment cannot open LinkedIn itself.
- SimplifyJobs: a public internship feed on GitHub.

**Filling out applications** happens in Cowork on your computer, not in the
cloud: it needs your browser, where you are signed in to 12twenty, LinkedIn and
employer sites. `cowork-apply/SKILL.md` is that skill. It pairs with a private
`answers.md` built from your resume (never committed here). Queue postings with
**Apply for me** on the tracker, then tell Cowork "apply to my queue". It fills
what the answer sheet covers, leaves the rest blank, and stops before Submit.

Tests: `node --test internships/desk.test.js`
