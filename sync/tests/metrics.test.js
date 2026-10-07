/* Unit tests for docs/metrics.js against a tiny hand-built dataset.
   Run from the repo root:  node sync/tests/metrics.test.js */
const assert = require("assert");
const path = require("path");
const M = require(path.join(__dirname, "..", "..", "docs", "metrics.js"));

const settings = {
  quad_start: "2026-09-02",
  statuses: { done: ["Done"], in_progress: ["In Progress"], in_flight: ["In Progress", "In Review"], blocked: ["Blocked"], ignored: ["Closed - OUTDATED"] },
  flags: { quiet_working_days: 5, wip_threshold: 4, overload_ratio: 1.5, blocked_days: 2, stale_pr_days: 5, review_backlog_count: 3, review_backlog_days: 3, carryover_ratio: 0.5, stale_sync_hours: 36 },
  bots: ["renovate[bot]"],
};
const sprints = [
  { key: "7.1", title: "Sprint 7.1", start: "2026-09-02", end: "2026-09-15", days: 14 },
  { key: "7.2", title: "Sprint 7.2", start: "2026-09-16", end: "2026-09-29", days: 14 },
  { key: "7.3", title: "Sprint 7.3", start: "2026-09-30", end: "2026-10-13", days: 14 },
  { key: "7.4", title: "Sprint 7.4", start: "2026-10-14", end: "2026-10-27", days: 14 },
];
const NOW = Date.parse("2026-10-07T12:00:00Z");
const item = (o) => Object.assign({ id: o.id, content_id: "C" + o.id, project: 13, type: "issue", archived: false, number: +o.id.slice(1), repo: "HHS/simpler-grants-gov",
  title: "t" + o.id, url: "u", state: "OPEN", state_reason: null, created_at: "2026-08-20T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", closed_at: null, merged_at: null,
  assignees: ["Alice"], labels: [], status: "Todo", status_updated_at: null, sprint: null, points: 3 }, o);
const sp = (key, start, end) => ({ key, title: "Sprint " + key, start, end, native: true });

const items = [
  // done inside 7.1, started in 7.1 -> cycle 3 days
  item({ id: "I1", status: "Done", state: "CLOSED", state_reason: "COMPLETED", closed_at: "2026-09-10T00:00:00Z", sprint: sp("7.1", "2026-09-02", "2026-09-15"), points: 5 }),
  // planned 7.1 by sprint-history (was 7.1 at end of 7.1, moved to 7.2 later), done in 7.2 -> carried over from 7.1, late in 7.2
  item({ id: "I2", status: "Done", state: "CLOSED", state_reason: "COMPLETED", closed_at: "2026-09-20T00:00:00Z", sprint: sp("7.2", "2026-09-16", "2026-09-29"), points: 2 }),
  // started in 7.1 (timeline), now in 7.3, still open: inferred carry-over from 7.1 (no sprint history)
  item({ id: "I3", status: "In Progress", sprint: sp("7.3", "2026-09-30", "2026-10-13"), points: 8 }),
  // blocked for 4 days in 7.3
  item({ id: "I4", status: "Blocked", status_updated_at: "2026-10-03T12:00:00Z", sprint: sp("7.3", "2026-09-30", "2026-10-13"), points: 1 }),
  // closed as not planned -> not completed
  item({ id: "I5", status: "Todo", state: "CLOSED", state_reason: "NOT_PLANNED", closed_at: "2026-09-12T00:00:00Z", sprint: sp("7.1", "2026-09-02", "2026-09-15") }),
  // Bob's: done in 7.3 with no sprint -> unplanned
  item({ id: "I6", assignees: ["bob"], status: "Done", state: "CLOSED", state_reason: "COMPLETED", closed_at: "2026-10-02T00:00:00Z", points: 3 }),
];
const history = [
  { at: "2026-09-04T09:00:00Z", item: "I1", f: "status", from: "Todo", to: "In Progress", src: "timeline" },
  { at: "2026-09-07T09:00:00Z", item: "I1", f: "status", from: "In Progress", to: "Done", src: "timeline" },
  { at: "2026-09-18T00:00:00Z", item: "I2", f: "sprint", from: "7.1", to: "7.2", src: "snapshot" },
  { at: "2026-09-19T09:00:00Z", item: "I2", f: "status", from: "In Progress", to: "Done", src: "timeline" },
  { at: "2026-09-10T09:00:00Z", item: "I3", f: "status", from: "Todo", to: "In Progress", src: "timeline" },
  { at: "2026-10-03T12:00:00Z", item: "I4", f: "status", from: "In Progress", to: "Blocked", src: "timeline" },
  { at: "2026-10-01T10:00:00Z", item: "I6", f: "status", from: "In Progress", to: "Done", src: "timeline" },
];
const prs = [
  { id: "P1", repo: "HHS/simpler-grants-gov", number: 500, title: "p1", url: "u", state: "MERGED", is_draft: false, author: "alice", created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-06T00:00:00Z", merged_at: "2026-09-06T00:00:00Z",
    pending_reviewers: [], review_requests: [{ reviewer: "bob", at: "2026-09-05T01:00:00Z", removed_at: null }], reviews: [{ author: "bob", state: "APPROVED", at: "2026-09-05T05:00:00Z" }], linked_issues: [] },
  { id: "P2", repo: "HHS/simpler-grants-gov", number: 501, title: "p2", url: "u", state: "OPEN", is_draft: false, author: "alice", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-26T00:00:00Z", merged_at: null,
    pending_reviewers: ["bob", "team:core"], review_requests: [{ reviewer: "bob", at: "2026-09-25T01:00:00Z", removed_at: null }, { reviewer: "team:core", at: "2026-09-25T01:00:00Z", removed_at: null }], reviews: [], linked_issues: [] },
  { id: "P3", repo: "HHS/simpler-grants-gov", number: 502, title: "bot", url: "u", state: "OPEN", is_draft: false, author: "renovate[bot]", created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z", merged_at: null, pending_reviewers: ["alice"], review_requests: [], reviews: [], linked_issues: [] },
];
const latest = { meta: { generated_at: "2026-10-07T11:00:00Z", first_snapshot: "2026-10-06" }, quad_start: "2026-09-02", sprints, projects: [], items, prs, history };
const roster = { people: [{ name: "Alice", login: "alice", since: "2026-09-02", active: true }, { name: "Bob", login: "bob", since: "2026-09-02", active: true }, { name: "New", login: "newbie", since: "2026-10-16", active: true }] };

const m = M.compute(latest, roster, settings, NOW);
assert.deepStrictEqual(m.sprints.map((s) => s.key), ["7.1", "7.2", "7.3"], "future sprints excluded");
assert.strictEqual(m.currentSprint.key, "7.3");
const alice = m.people.find((p) => p.login === "alice");
const a71 = alice.perSprint["7.1"], a72 = alice.perSprint["7.2"], a73 = alice.perSprint["7.3"];

// completion & attribution
assert.strictEqual(a71.completedCount, 1, "I1 completed in 7.1 (I5 closed as not planned must not count)");
assert.strictEqual(a71.completedPoints, 5);
assert.strictEqual(a71.cycleMedianDays, 3, "cycle time from In Progress to Done");
assert.strictEqual(a72.completedCount, 1, "I2 completed in 7.2");
assert.strictEqual(a72.lateCount, 0, "I2's sprint field was 7.2 at completion, so it is on plan for 7.2");
// planning & carry-over
assert.strictEqual(a71.plannedCount, 4, "I1, I2 (via sprint history), I5, and I3 (inferred) planned in 7.1");
assert.strictEqual(a71.inferredCount, 1, "I3 inferred into 7.1");
assert.strictEqual(a71.notFinished.length, 3, "I2, I5, I3 not finished in 7.1");
assert.strictEqual(a71.carriedCount, 2, "I2 and I3 carried into later sprints; I5 stayed in 7.1");
assert.strictEqual(a73.plannedCount, 2, "I3 and I4 planned in 7.3 (current)");
assert.strictEqual(a73.notFinished.length, 0, "current sprint has no not-finished yet");
// now
assert.strictEqual(alice.current.wip, 2, "I3 in progress + I4 blocked");
assert.strictEqual(alice.current.blocked.length, 1);
assert.ok(alice.current.blocked[0].blockedDays > 3.9 && alice.current.blocked[0].blockedDays < 4.1, "blocked ~4 days");
assert.strictEqual(alice.current.openPrs.length, 1, "P2 open; bot PR ignored");
assert.deepStrictEqual(alice.current.openPrs[0].pending, ["bob"], "team requests are not attributed");
assert.strictEqual(alice.current.pendingReviews.length, 0, "bot PR requesting alice's review is ignored");
// flags
const types = alice.flags.map((f) => f.type).sort();
// not quiet: I4 changed status on Oct 3, inside the 5-working-day window; over-committed: 9 pts planned vs 3.5 avg
assert.deepStrictEqual(types, ["blocked", "overcommitted", "stale_pr"], `alice flags: ${types}`);
// a week later with no new activity she is quiet
const later = M.compute(latest, roster, settings, Date.parse("2026-10-13T12:00:00Z"));
assert.ok(later.people.find((p) => p.login === "alice").flags.some((f) => f.type === "quiet"), "quiet after a week of silence");
assert.strictEqual(later.people.find((p) => p.login === "alice").current.activeDates.length, 0);
// bob: reviews & turnaround
const bob = m.people.find((p) => p.login === "bob");
assert.strictEqual(bob.perSprint["7.1"].reviewsCount, 1);
assert.strictEqual(bob.perSprint["7.1"].reviewTurnaroundMedianH, 4, "requested 01:00, reviewed 05:00");
assert.strictEqual(bob.current.pendingReviews.length, 1, "P2 waiting on bob");
assert.ok(bob.current.pendingReviews[0].waitingDays > 12, "waiting since Sep 25");
assert.ok(bob.flags.some((f) => f.type === "review_backlog"), "oldest pending > 3 days");
assert.strictEqual(bob.perSprint["7.3"].completedCount, 1);
assert.strictEqual(bob.perSprint["7.3"].unplannedCount, 1, "I6 had no sprint");
// roster start date
const newbie = m.people.find((p) => p.login === "newbie");
assert.strictEqual(newbie.perSprint["7.3"].active, false, "not on the team before 10/16");
assert.strictEqual(newbie.flags.length, 0, "no flags before start date");
// team & unrostered
assert.strictEqual(m.team.perSprint["7.1"].completedCount, 1);
assert.strictEqual(m.team.perSprint["7.1"].people, 2, "newbie excluded from 7.1 roll-up");
assert.deepStrictEqual(m.unrostered, [], "no unrostered humans");
assert.strictEqual(m.progress.elapsedDays, 7);
assert.strictEqual(m.sync.stale, false);
// case-insensitive assignee matching
assert.strictEqual(alice.itemCount, 5, "Alice matched case-insensitively");
console.log("ALL METRICS TESTS PASSED");
