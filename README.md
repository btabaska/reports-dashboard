# Reports Dashboard

A private, self-updating view of what each of your direct reports is doing on
GitHub, sprint by sprint. A GitHub Actions workflow pulls both GitHub Projects
every night and commits a snapshot; the dashboard page reads that data through
the GitHub API with a token that never leaves your browser.

Sources: [HHS Project 13](https://github.com/orgs/HHS/projects/13) (Simpler
Grants.gov) and [HHS Project 84](https://github.com/orgs/HHS/projects/84)
(Smarter Grants Management), plus the pull requests in the repos behind them.
History starts at the beginning of quad 7 (sprint 7.1, 2026-09-02).

```
.github/workflows/sync.yml   nightly sync (10:00 UTC) + manual "Run workflow"
sync/sync.py                 the sync: GraphQL -> data/ (standard library only)
sync/tests/                  offline tests + the fake GitHub that generates demo data
config/settings.json         projects, quad start, status names, flag thresholds
config/roster.json           your direct reports (editable from the Admin tab)
docs/index.html              the dashboard (plus app.js, metrics.js, styles.css)
docs/demo-data.js            synthetic data for ?demo=1 - fictional people, tickets, PRs and dates
data/latest.json             written by the sync; what the dashboard reads
data/snapshots/YYYY-MM-DD.json  one compact snapshot per day (status/sprint/points/assignees)
data/timeline_events.json    per-issue project status history (authoritative)
```

## Setup (about 15 minutes)

### 1. Create the private repo and push this folder

```bash
cd reports-dashboard
git init -b main && git add . && git commit -m "Reports dashboard"
gh repo create reports-dashboard --private --source . --push      # or create it on github.com and push
```

### 2. Add the sync token as a repository secret

The sync needs a token that can read the two org projects. Projects (v2) data is
GraphQL-only and always needs a token, even for public projects.

1. github.com → Settings → Developer settings → Personal access tokens →
   **Tokens (classic)** → Generate new token.
2. Scope: **`read:project`** only. (The repos are public, so no repo scope is
   needed. If a run fails with a permissions error on pull requests, add
   `public_repo`.) If the HHS org enforces SAML SSO you may need to click
   *Configure SSO → Authorize* on the token for HHS.
3. In your new repo: Settings → Secrets and variables → Actions → New repository
   secret → name **`GH_PROJECTS_TOKEN`**, paste the token.

### 3. Run the first sync

Actions → **Sync dashboard data** → Run workflow. The first run backfills from
2026-09-02: it reads every item in both projects, PRs updated since then, and the
project status timeline of every issue in the window. Expect 1–3 minutes and a
`data/` commit when it finishes. The run summary shows the counts and any
warnings. After this it runs by itself every day at 10:00 UTC.

### 4. Create the browser token

The dashboard reads `data/latest.json` and saves roster/settings changes through
the API, so it needs a token scoped to **this repo only**.

Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
→ Generate new token:

* Repository access: *Only select repositories* → `reports-dashboard`
* Permissions → Repository: **Contents: Read and write**, **Actions: Read and
  write** (for the *Run sync now* button), Metadata: Read (added automatically)
* Expiration: up to a year; you'll re-enter it on the Admin tab when it expires.

### 5. Open the dashboard

Either:

* **GitHub Pages** – Settings → Pages → Source: *Deploy from a branch* → `main`,
  folder **`/docs`**. Pages on a private repo needs GitHub Pro (or Team/
  Enterprise if you move it to an org). The published page contains no data –
  it is an empty shell until you enter the token – so the URL being reachable
  is fine. Your URL will be `https://<you>.github.io/reports-dashboard/`.
* **Or just open `docs/index.html`** from your clone in a browser. It works the
  same way (the API allows requests from a local file).

Enter `owner/reports-dashboard` and the fine-grained token → Connect. The token
is kept in that browser's localStorage; *Sign out* on the Admin tab clears it.

Try it before setup: open `docs/index.html?demo=1` (or the Pages URL with
`?demo=1`) to explore the dashboard on synthetic data.

## Day to day

Nothing. The green dot in the top-right means the data is fresh; it turns amber
after 36 hours without a sync (threshold in Admin). GitHub emails you when a
scheduled run fails. *Run sync now* on the Admin tab triggers the workflow and
reloads when it finishes.

**Adding people (e.g. the 10/16 cohort):** Admin → Roster → *+ Add person*, or
click their handle under *Seen in the data but not on the roster* (the sync
keeps everyone assigned on the projects, so new reports show up there as soon as
they have an item). Set *On team since* so sprints before their start show as
"—". *Save roster to repo* commits `config/roster.json`; metrics recompute
immediately because the data already includes them.

**Removing people:** Remove → Save. Their data stays in `data/`, so re-adding
restores their history. Untick *Active* instead to keep them in the People view
but out of the team roll-up.

**Thresholds** for the flags live on the Admin tab and in
`config/settings.json`.

## What the numbers mean

* **Completed** – Status became *Done*, the issue was closed as completed, or
  the PR was merged. Credited to the sprint in which that happened, to every
  assignee on the item. "Done in planned sprint" compares that to the item's
  Sprint field at the time.
* **Planned** – items whose Sprint field pointed at the sprint at its start or
  end (or now, for the sprint in progress). Project 84's `DBA – Sprint n` /
  `DBB – Sprint n` iterations are mapped to the 7.x sprint that contains their
  midpoint, so Michael Sloan's work lines up with everyone else's.
* **Not finished / carried over** – planned items not completed by sprint end;
  *carried over* means the Sprint field now points at a later sprint. The Sprint
  field has no change history in GitHub's API, so this is exact from the first
  daily snapshot onward. For sprints before that, an item that was started
  during the sprint and now sits in a later one is counted as inferred (shown
  with `~`).
* **Cycle time** – first *In Progress* to *Done*, from the issue timeline
  (`ProjectV2ItemStatusChangedEvent`). Items that skipped *In Progress* have no
  cycle time and are excluded from the median.
* **Reviews given / turnaround** – reviews submitted on other people's PRs;
  turnaround is from the review request to that reviewer's first review.
  Requests addressed to a team can't be attributed and are ignored.
* **Flags** – *Quiet* (no PRs opened/merged, reviews, or status changes on
  their items for N working days, as of the last sync), *Overloaded* (items in
  flight ≥ N), *Over-committed* (planned points > N × their average completed
  points), *Blocked* (an item blocked ≥ N days), *Stale PR* (open non-draft PR
  idle ≥ N days), *Review backlog* (≥ N pending requests or oldest ≥ N days),
  *High carry-over* (≥ N of last sprint's planned items unfinished). Flags are
  prompts to look, not verdicts – comments and commits aren't synced.
* **Deliberately not included:** commit counts, lines of code, anything outside
  the two projects.

## Changing the window

`config/settings.json` → `quad_start`. The sync keeps items whose sprint starts
on/after that date, or that were updated/closed/merged after it, or that are
still in flight. Leave it at `2026-09-02` and the dashboard keeps showing every
sprint since; move it forward when you want to trim the view (older snapshots
stay in `data/snapshots/`). Sprint keys come from the Project 13 Sprint field
(`Sprint 7.3` → `7.3`), so quad 8 appears automatically.

## Troubleshooting

* **Run fails with "Project … not found or token cannot read it"** – the
  classic token is missing `read:project`, or needs SSO authorization for HHS.
* **"GitHub rejected the token (401)"** in the dashboard – the fine-grained
  token expired or was pasted wrong. Admin → Connection → re-enter.
* **Data stale, no failed runs** – GitHub disables scheduled workflows after 60
  days without repository activity on *public* repos; private repos are not
  affected, but a manual run re-enables it either way.
* **Pages shows 404** – Pages needs GitHub Pro on a private repo; open
  `docs/index.html` locally instead.
* **Rate limits** – a full run costs roughly 1,500–3,000 GraphQL points of the
  5,000/hour budget; the script sleeps until the reset if it gets low. The run
  summary prints the cost.
* **A field was renamed in the project** – update `config/settings.json`
  (`fields`), then *Full re-sync*. Field names are matched ignoring case and
  surrounding whitespace.

## Tests

```bash
python3 sync/tests/test_sync.py            # offline end-to-end test of the sync with a fake GitHub
python3 sync/tests/test_sync.py --write-demo   # also regenerates docs/demo-data.js
node sync/tests/metrics.test.js            # unit tests for the metric definitions
GH_TOKEN=... python3 sync/sync.py --dry-run    # real fetch, writes nothing
```

The GraphQL queries were validated against GitHub's published schema; the live
API has not been exercised from this scaffold, so the first real run is the
real test. If it fails, the log line that starts with `FAILED:` says why.
