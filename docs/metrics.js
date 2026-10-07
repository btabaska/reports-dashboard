/* metrics.js - pure functions that turn data/latest.json + roster + settings into the
   per-person, per-sprint model the dashboard renders. No DOM, no fetch; testable under Node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Metrics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const DAY = 86400000;
  const HOUR = 3600000;
  const ts = (s) => (s ? Date.parse(s) : null);
  const dayStart = (iso) => Date.parse(iso + "T00:00:00Z");
  const dayEnd = (iso) => Date.parse(iso + "T23:59:59.999Z");
  const lower = (s) => (s || "").toLowerCase();
  const inSprint = (t, s) => t != null && t >= dayStart(s.start) && t <= dayEnd(s.end);
  const sum = (arr, f) => arr.reduce((a, x) => a + (f ? f(x) : x), 0);
  const pts = (it) => (typeof it.points === "number" ? it.points : 0);
  const median = (arr) => {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const compareKeys = (a, b) => {
    // "7.10" > "7.9"; also tolerates non-numeric keys
    const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
    if (pa.some(isNaN) || pb.some(isNaN)) return String(a).localeCompare(String(b));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  function workingDaysAgo(now, n) {
    // timestamp n working days (Mon-Fri) before now
    let d = new Date(now);
    let left = n;
    while (left > 0) {
      d = new Date(d.getTime() - DAY);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) left--;
    }
    return d.getTime();
  }
  const dateKey = (t) => new Date(t).toISOString().slice(0, 10);

  // ------------------------------------------------------------------ per-item facts
  function buildItemFacts(latest, settings, now) {
    const S = settings.statuses || {};
    const doneSet = new Set(S.done || ["Done"]);
    const progressSet = new Set(S.in_progress || ["In Progress"]);
    const blockedSet = new Set(S.blocked || ["Blocked"]);
    const flightSet = new Set(S.in_flight || []);
    const ignoredSet = new Set(S.ignored || []);
    const byItem = new Map();
    for (const e of latest.history || []) {
      if (!byItem.has(e.item)) byItem.set(e.item, []);
      byItem.get(e.item).push(e);
    }
    for (const arr of byItem.values()) arr.sort((a, b) => ts(a.at) - ts(b.at));

    const facts = new Map();
    for (const it of latest.items || []) {
      const ev = byItem.get(it.id) || [];
      const statusEv = ev.filter((e) => e.f === "status");
      const sprintEv = ev.filter((e) => e.f === "sprint");
      const hasTimeline = statusEv.some((e) => e.src === "timeline");

      const isDone =
        doneSet.has(it.status) ||
        (!ignoredSet.has(it.status) && it.type === "issue" && it.state === "CLOSED" && it.state_reason !== "NOT_PLANNED") ||
        (it.type === "pr" && !!it.merged_at);
      let completedAt = null;
      if (isDone) {
        const lastDone = [...statusEv].reverse().find((e) => doneSet.has(e.to));
        completedAt = lastDone ? ts(lastDone.at) : ts(it.merged_at) || ts(it.closed_at) || (doneSet.has(it.status) ? ts(it.status_updated_at) : null);
        if (completedAt == null) completedAt = ts(it.updated_at);
      }
      const firstStart = statusEv.find((e) => progressSet.has(e.to));
      const startedAt = firstStart ? ts(firstStart.at) : ts(it.actual_start ? it.actual_start + "T12:00:00Z" : null);
      const isBlocked = blockedSet.has(it.status);
      let blockedSince = null;
      if (isBlocked) {
        const lastBlocked = [...statusEv].reverse().find((e) => blockedSet.has(e.to));
        blockedSince = lastBlocked ? ts(lastBlocked.at) : ts(it.status_updated_at) || ts(it.updated_at);
      }
      const inFlight = !isDone && (flightSet.has(it.status) || isBlocked);
      const currentKey = it.sprint ? it.sprint.key : null;

      // sprint value at time t, replaying snapshot-derived sprint events
      function sprintAt(t) {
        if (!sprintEv.length) return currentKey;
        let val = sprintEv[0].from === undefined ? null : sprintEv[0].from;
        for (const e of sprintEv) {
          if (ts(e.at) <= t) val = e.to;
          else break;
        }
        return val;
      }
      const keysEver = new Set([currentKey, ...sprintEv.flatMap((e) => [e.from, e.to])].filter(Boolean));
      const lastActivity = Math.max(ts(it.updated_at) || 0, ...ev.map((e) => (e.src === "timeline" ? ts(e.at) : 0)));
      facts.set(it.id, {
        item: it,
        isDone, completedAt, startedAt, isBlocked, blockedSince, inFlight,
        hasTimeline, hasSprintHistory: sprintEv.length > 0, currentKey, sprintAt, keysEver,
        cycleDays: completedAt != null && startedAt != null && completedAt >= startedAt ? (completedAt - startedAt) / DAY : null,
        leadDays: completedAt != null && it.created_at ? (completedAt - ts(it.created_at)) / DAY : null,
        lastActivity,
        activityDates: ev.filter((e) => e.src === "timeline").map((e) => dateKey(ts(e.at))),
        plannedKeyAtCompletion: completedAt != null ? sprintAt(completedAt) : null,
      });
    }
    return facts;
  }

  // ------------------------------------------------------------------ PR helpers
  function prFacts(latest, settings) {
    const bots = new Set((settings.bots || []).map(lower));
    const prs = (latest.prs || []).filter((p) => p.author && !bots.has(lower(p.author)));
    // per reviewer: list of {pr, requestedAt, reviewedAt, state}
    const requests = [];
    for (const p of prs) {
      const reviewsBy = new Map();
      for (const r of p.reviews || []) {
        if (!r.author) continue;
        const k = lower(r.author);
        if (!reviewsBy.has(k)) reviewsBy.set(k, []);
        reviewsBy.get(k).push({ at: ts(r.at), state: r.state });
      }
      for (const rq of p.review_requests || []) {
        if (!rq.reviewer || rq.reviewer.startsWith("team:")) continue;
        const k = lower(rq.reviewer);
        const reqAt = ts(rq.at);
        const first = (reviewsBy.get(k) || []).filter((r) => r.at >= reqAt).sort((a, b) => a.at - b.at)[0];
        requests.push({ pr: p, reviewer: k, requestedAt: reqAt, removedAt: ts(rq.removed_at), reviewedAt: first ? first.at : null, state: first ? first.state : null });
      }
    }
    return { prs, requests };
  }

  // ------------------------------------------------------------------ main
  function compute(latest, roster, settings, nowArg) {
    const now = nowArg != null ? nowArg : ts(latest.meta && latest.meta.generated_at) || Date.now();
    const F = settings.flags || {};
    const sprintsAll = [...(latest.sprints || [])].sort((a, b) => compareKeys(a.key, b.key));
    const sprints = sprintsAll.filter((s) => dayStart(s.start) <= now);
    const currentSprint = sprints.find((s) => inSprint(now, s)) || sprints[sprints.length - 1] || null;
    const pastSprints = sprints.filter((s) => !currentSprint || s.key !== currentSprint.key);
    const facts = buildItemFacts(latest, settings, now);
    const { prs, requests } = prFacts(latest, settings);
    const bots = new Set((settings.bots || []).map(lower));
    const people = (roster.people || []).filter((p) => p.login);

    const sprintEndOrNow = (s) => Math.min(dayEnd(s.end), now);
    const isAssigned = (it, login) => (it.assignees || []).some((a) => lower(a) === login);

    function personModel(p) {
      const login = lower(p.login);
      const mine = [...facts.values()].filter((f) => isAssigned(f.item, login));
      const authored = prs.filter((x) => lower(x.author) === login);
      const myRequests = requests.filter((r) => r.reviewer === login);
      const activeInSprint = (s) => !p.since || dayEnd(s.end) >= dayStart(p.since);

      const perSprint = {};
      for (const s of sprints) {
        const isCurrent = currentSprint && s.key === currentSprint.key;
        const endT = sprintEndOrNow(s);
        const explicit = mine.filter((f) => f.sprintAt(endT) === s.key || f.sprintAt(dayStart(s.start)) === s.key || (isCurrent && f.currentKey === s.key));
        // Before daily snapshots exist, an item that was started during S but now sits in a later sprint
        // (and wasn't finished in S) was almost certainly carried over from S. Count it, marked as inferred.
        const inferred = isCurrent ? [] : mine.filter((f) =>
          !explicit.includes(f) && !f.hasSprintHistory && f.startedAt != null && inSprint(f.startedAt, s) &&
          f.currentKey && compareKeys(f.currentKey, s.key) > 0 && (f.completedAt == null || f.completedAt > dayEnd(s.end)));
        const planned = [...explicit, ...inferred];
        const completed = mine.filter((f) => f.completedAt != null && inSprint(f.completedAt, s));
        const onPlan = completed.filter((f) => f.plannedKeyAtCompletion === s.key);
        const late = completed.filter((f) => f.plannedKeyAtCompletion && compareKeys(f.plannedKeyAtCompletion, s.key) < 0);
        const unplanned = completed.filter((f) => !f.plannedKeyAtCompletion);
        const notFinished = isCurrent ? [] : planned.filter((f) => f.completedAt == null || f.completedAt > dayEnd(s.end));
        const carried = notFinished.filter((f) => {
          const later = f.sprintAt(now);
          return later && compareKeys(later, s.key) > 0;
        });
        const unfinishedNotReplanned = notFinished.filter((f) => !carried.includes(f));
        const cycle = completed.map((f) => f.cycleDays).filter((x) => x != null);
        const merged = authored.filter((x) => x.merged_at && inSprint(ts(x.merged_at), s));
        const opened = authored.filter((x) => inSprint(ts(x.created_at), s));
        const reviews = [];
        for (const x of prs) {
          if (lower(x.author) === login) continue;
          for (const r of x.reviews || []) if (lower(r.author) === login && inSprint(ts(r.at), s)) reviews.push({ pr: x, at: ts(r.at), state: r.state });
        }
        const reviewedPrs = new Set(reviews.map((r) => r.pr.id));
        const turnaround = myRequests.filter((r) => r.reviewedAt != null && inSprint(r.reviewedAt, s)).map((r) => (r.reviewedAt - r.requestedAt) / HOUR);
        perSprint[s.key] = {
          key: s.key, isCurrent, active: activeInSprint(s),
          planned, plannedCount: planned.length, plannedPoints: sum(planned, (f) => pts(f.item)),
          inferredCount: inferred.length,
          completed, completedCount: completed.length, completedPoints: sum(completed, (f) => pts(f.item)),
          unpointedCompleted: completed.filter((f) => typeof f.item.points !== "number").length,
          onPlanCount: onPlan.length, lateCount: late.length, unplannedCount: unplanned.length,
          notFinished, carried, carriedCount: carried.length, unfinishedNotReplanned,
          carryoverRatio: planned.length && !isCurrent ? notFinished.length / planned.length : null,
          cycleMedianDays: median(cycle), cycleSample: cycle.length,
          prsMerged: merged, prsOpened: opened,
          reviews, reviewsCount: reviews.length, reviewedPrCount: reviewedPrs.size,
          approvals: reviews.filter((r) => r.state === "APPROVED").length,
          changesRequested: reviews.filter((r) => r.state === "CHANGES_REQUESTED").length,
          reviewTurnaroundMedianH: median(turnaround), reviewTurnaroundSample: turnaround.length,
        };
      }

      // ---- now
      const inFlight = mine.filter((f) => f.inFlight && !f.isBlocked);
      const blocked = mine.filter((f) => f.isBlocked).map((f) => ({ ...f, blockedDays: f.blockedSince ? (now - f.blockedSince) / DAY : null }));
      const openPrs = authored.filter((x) => x.state === "OPEN").map((x) => ({
        pr: x, ageDays: (now - ts(x.created_at)) / DAY, idleDays: (now - ts(x.updated_at)) / DAY,
        pending: (x.pending_reviewers || []).filter((r) => !r.startsWith("team:")),
        decision: x.review_decision,
      }));
      const pendingReviews = [];
      for (const x of prs) {
        if (x.state !== "OPEN" || x.is_draft) continue;
        if (!(x.pending_reviewers || []).some((r) => lower(r) === login)) continue;
        const req = myRequests.filter((r) => r.pr.id === x.id && !r.removedAt).sort((a, b) => b.requestedAt - a.requestedAt)[0];
        const since = req ? req.requestedAt : ts(x.created_at);
        pendingReviews.push({ pr: x, waitingDays: (now - since) / DAY, requestedAt: since });
      }
      pendingReviews.sort((a, b) => b.waitingDays - a.waitingDays);

      // ---- activity (for "quiet")
      const windowStart = workingDaysAgo(now, F.quiet_working_days || 5);
      const activeDates = new Set();
      for (const f of mine) for (const d of f.activityDates) if (Date.parse(d) >= windowStart - DAY) activeDates.add(d);
      // Only the person's own actions count: PRs they opened or merged, reviews they submitted,
      // and status changes on their items (PR updated_at moves when anyone comments, so it is ignored).
      for (const x of authored) {
        for (const t of [x.created_at, x.merged_at, x.ready_for_review_at]) if (t && ts(t) >= windowStart) activeDates.add(dateKey(ts(t)));
      }
      for (const x of prs) for (const r of x.reviews || []) if (lower(r.author) === login && ts(r.at) >= windowStart) activeDates.add(dateKey(ts(r.at)));
      const lastActivity = Math.max(0, ...mine.flatMap((f) => f.activityDates.map((d) => Date.parse(d))),
        ...authored.flatMap((x) => [ts(x.created_at) || 0, ts(x.merged_at) || 0]),
        ...prs.flatMap((x) => (x.reviews || []).filter((r) => lower(r.author) === login).map((r) => ts(r.at) || 0)));

      // ---- trailing & flags
      const pastActive = pastSprints.filter((s) => perSprint[s.key].active);
      const trailingAvgPoints = pastActive.length ? sum(pastActive, (s) => perSprint[s.key].completedPoints) / pastActive.length : null;
      const trailingAvgItems = pastActive.length ? sum(pastActive, (s) => perSprint[s.key].completedCount) / pastActive.length : null;
      const cur = currentSprint ? perSprint[currentSprint.key] : null;
      const lastPast = pastActive.length ? perSprint[pastActive[pastActive.length - 1].key] : null;
      const flags = [];
      const wip = inFlight.length + blocked.length;
      if (!p.since || dayStart(p.since) <= now) {
        if (activeDates.size === 0) flags.push({ type: "quiet", level: "warn", text: `No GitHub activity in the last ${F.quiet_working_days || 5} working days` });
        if (wip >= (F.wip_threshold || 4)) flags.push({ type: "overloaded", level: "warn", text: `${wip} items in flight at once` });
        if (cur && trailingAvgPoints && cur.plannedPoints > (F.overload_ratio || 1.5) * trailingAvgPoints)
          flags.push({ type: "overcommitted", level: "info", text: `${cur.plannedPoints} pts planned vs ${trailingAvgPoints.toFixed(1)} avg completed` });
        for (const b of blocked) if (b.blockedDays != null && b.blockedDays >= (F.blocked_days || 2))
          flags.push({ type: "blocked", level: "alert", text: `Blocked ${Math.floor(b.blockedDays)}d: #${b.item.number} ${b.item.title}`, url: b.item.url });
        for (const o of openPrs) if (!o.pr.is_draft && o.idleDays >= (F.stale_pr_days || 5))
          flags.push({ type: "stale_pr", level: "warn", text: `PR idle ${Math.floor(o.idleDays)}d: #${o.pr.number} ${o.pr.title}`, url: o.pr.url });
        const oldest = pendingReviews[0];
        if (pendingReviews.length >= (F.review_backlog_count || 3) || (oldest && oldest.waitingDays >= (F.review_backlog_days || 3)))
          flags.push({ type: "review_backlog", level: "warn", text: `${pendingReviews.length} review${pendingReviews.length === 1 ? "" : "s"} waiting${oldest ? `, oldest ${Math.floor(oldest.waitingDays)}d` : ""}` });
        if (lastPast && lastPast.carryoverRatio != null && lastPast.carryoverRatio >= (F.carryover_ratio || 0.5) && lastPast.plannedCount >= 2)
          flags.push({ type: "carryover", level: "info", text: `${lastPast.notFinished.length} of ${lastPast.plannedCount} planned items not finished in ${lastPast.key}` });
      }
      const projects = [...new Set(mine.map((f) => f.item.project))].sort();
      return {
        login: p.login, name: p.name || p.login, since: p.since || null, active: p.active !== false, notes: p.notes || "",
        projects, perSprint, current: { inFlight, blocked, openPrs, pendingReviews, wip, activeDates: [...activeDates].sort(), lastActivity: lastActivity || null },
        trailingAvgPoints, trailingAvgItems, flags, itemCount: mine.length,
      };
    }

    const models = people.map(personModel);
    const activeModels = models.filter((m) => m.active);

    // ---- team roll-up
    const team = { perSprint: {} };
    for (const s of sprints) {
      const rows = activeModels.map((m) => m.perSprint[s.key]).filter((r) => r && r.active);
      team.perSprint[s.key] = {
        key: s.key,
        plannedCount: sum(rows, (r) => r.plannedCount), plannedPoints: sum(rows, (r) => r.plannedPoints),
        completedCount: sum(rows, (r) => r.completedCount), completedPoints: sum(rows, (r) => r.completedPoints),
        carriedCount: sum(rows, (r) => r.carriedCount), notFinishedCount: sum(rows, (r) => r.notFinished.length),
        prsMerged: sum(rows, (r) => r.prsMerged.length), reviewsCount: sum(rows, (r) => r.reviewsCount),
        cycleMedianDays: median(rows.flatMap((r) => r.completed.map((f) => f.cycleDays).filter((x) => x != null))),
        people: rows.length,
      };
    }
    team.current = {
      wip: sum(activeModels, (m) => m.current.wip), blocked: sum(activeModels, (m) => m.current.blocked.length),
      openPrs: sum(activeModels, (m) => m.current.openPrs.length), pendingReviews: sum(activeModels, (m) => m.current.pendingReviews.length),
      flags: activeModels.flatMap((m) => m.flags.map((f) => ({ ...f, login: m.login, name: m.name }))),
    };
    let progress = null;
    if (currentSprint) {
      const total = (dayEnd(currentSprint.end) - dayStart(currentSprint.start)) / DAY;
      const elapsed = Math.min(total, Math.max(0, (now - dayStart(currentSprint.start)) / DAY));
      progress = { elapsedDays: Math.floor(elapsed), totalDays: Math.round(total), pct: total ? elapsed / total : 0 };
    }

    // ---- assignees in the data who aren't rostered
    const rostered = new Set(people.map((p) => lower(p.login)));
    const seen = new Map();
    for (const it of latest.items || []) for (const a of it.assignees || []) {
      const k = lower(a);
      if (rostered.has(k) || bots.has(k)) continue;
      if (!seen.has(k)) seen.set(k, { login: a, items: 0, prs: 0, projects: new Set() });
      seen.get(k).items++;
      seen.get(k).projects.add(it.project);
    }
    for (const x of prs) {
      const k = lower(x.author);
      if (rostered.has(k) || bots.has(k)) continue;
      if (!seen.has(k)) seen.set(k, { login: x.author, items: 0, prs: 0, projects: new Set() });
      seen.get(k).prs++;
    }
    const unrostered = [...seen.values()].map((u) => ({ ...u, projects: [...u.projects] })).sort((a, b) => b.items + b.prs - (a.items + a.prs));

    const generatedAt = ts(latest.meta && latest.meta.generated_at);
    const staleHours = generatedAt ? (Date.now() - generatedAt) / HOUR : null;
    return {
      now, sprints, sprintsAll, currentSprint, pastSprints, progress, people: models, team, unrostered,
      sync: { generatedAt, staleHours, stale: staleHours != null && staleHours > (F.stale_sync_hours || 36), meta: latest.meta || {} },
    };
  }

  return { compute, buildItemFacts, prFacts, median, compareKeys, workingDaysAgo, DAY, HOUR };
});
