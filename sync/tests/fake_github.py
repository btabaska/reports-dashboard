"""
Deterministic fake of the GitHub GraphQL responses that sync.py consumes.
Used by the tests and to produce docs/demo-data.js (the dashboard's demo mode).
The projects are real; the people, tickets, PRs and dates are invented.
"""
from __future__ import annotations

import datetime as dt
import random

UTC = dt.timezone.utc
TODAY = dt.datetime(2026, 10, 7, 10, 0, tzinfo=UTC)

SPRINTS_13 = [  # title, start, duration  (matches the real Sprint field)
    ("Sprint 6.9", "2026-08-19", 14),
    ("Sprint 7.1", "2026-09-02", 14), ("Sprint 7.2", "2026-09-16", 14), ("Sprint 7.3", "2026-09-30", 14),
    ("Sprint 7.4", "2026-10-14", 14), ("Sprint 7.5", "2026-10-28", 14), ("Sprint 7.6", "2026-11-11", 14),
    ("Sprint 7.7", "2026-11-25", 14), ("Sprint 7.8", "2026-12-09", 14), ("Sprint 7.9", "2026-12-23", 14),
]
SPRINTS_84 = [
    ("Sprint 6.9", "2026-08-19", 10),
    ("DBA - Sprint 1", "2026-08-31", 12), ("DBA - Sprint 2", "2026-09-14", 12), ("DBA - Sprint 3", "2026-09-28", 12),
    ("DBB - Sprint 1", "2026-10-12", 12), ("DBB - Sprint 2", "2026-10-26", 12),
]
STATUS_13 = ["Icebox", "Todo", "Design Review", "Ready for Refinement", "Ready to Pick Up", "In Progress",
             "Blocked", "In Review", "UAT", "Done", "Postponed", "Closed - OUTDATED"]
STATUS_84 = STATUS_13[:8] + ["QA"] + STATUS_13[8:]

# Fictional people for the demo (the real roster lives in config/roster.json and never enters demo data).
DEMO_ROSTER = [
    {"name": "Ada Lin", "login": "ada-lin"}, {"name": "Ben Okafor", "login": "bokafor"},
    {"name": "Chen Wu", "login": "chenwu-dev"}, {"name": "Dara Quinn", "login": "dquinn"},
    {"name": "Eli Novak", "login": "ENovakDev"}, {"name": "Fay Ibarra", "login": "fibarra"},
    {"name": "Gus Moreno", "login": "gmoreno-x", "notes": "Smarter Grants Management (project 84)"},
]
PEOPLE_13 = ["ada-lin", "bokafor", "chenwu-dev", "dquinn", "ENovakDev", "fibarra", "priya-k"]
PEOPLE_84 = ["gmoreno-x", "tomh-contrib"]
TRACKS = ["Backend / API", "Frontend", "Infra", "Data", "Testing"]
TITLES = ["Add pagination to {x} endpoint", "Fix flaky {x} test", "Migrate {x} to new auth flow",
          "Refactor {x} service", "Add validation for {x} form", "Improve {x} error handling",
          "Write ADR for {x}", "Instrument {x} with metrics", "Upgrade {x} dependency", "Harden {x} IAM policy"]
NOUNS = ["opportunity", "application", "attachment", "search", "agency", "form", "competition", "user", "NOFO", "award"]


def iso(d: dt.datetime) -> str:
    return d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sprint_bounds(title: str, table):
    for t, s, dur in table:
        if t == title:
            start = dt.datetime.fromisoformat(s).replace(tzinfo=UTC)
            return start, start + dt.timedelta(days=dur)
    raise KeyError(title)


class FakeGitHub:
    """Drop-in for sync.GitHub: same .gql() signature, same response shapes."""

    def __init__(self, seed: int = 7, today: dt.datetime = TODAY):
        self.rng = random.Random(seed)
        self.today = today
        self.calls = 0
        self.cost_used = 0
        self.remaining = 4800
        self.reset_at = iso(today + dt.timedelta(hours=1))
        self.items = {13: [], 84: []}
        self.prs = {"HHS/simpler-grants-gov": [], "HHS/smarter-grants-management": []}
        self.timelines = {}
        self._n = 1000
        self._build()

    # ------------------------------------------------------------------ data
    def _build(self):
        r = self.rng
        profiles = {
            # login: (items per sprint, pr ratio, quirk)
            "ada-lin": (6, 0.9, None), "bokafor": (5, 0.8, "stale_pr"),
            "chenwu-dev": (7, 1.0, "overloaded"), "dquinn": (4, 0.7, "quiet"),
            "ENovakDev": (6, 0.9, "blocked"), "fibarra": (8, 1.0, "reviewer"),
            "priya-k": (3, 0.8, None), "gmoreno-x": (5, 0.9, None), "tomh-contrib": (4, 0.9, None),
        }
        for proj, people, table, repo in ((13, PEOPLE_13, SPRINTS_13, "HHS/simpler-grants-gov"),
                                          (84, PEOPLE_84, SPRINTS_84, "HHS/smarter-grants-management")):
            sprint_titles = [t for t, s, _ in table if s >= "2026-08-31" and s <= "2026-09-30"]
            for login in people:
                per, pr_ratio, quirk = profiles[login]
                for si, title in enumerate(sprint_titles):
                    s_start, s_end = sprint_bounds(title, table)
                    is_current = s_start <= self.today < s_end
                    n = per + r.randint(-1, 1)
                    for k in range(n):
                        self._make_item(proj, repo, login, people, table, title, si, sprint_titles, k, n,
                                        is_current, quirk, pr_ratio)
                # one pre-quad "Closed - OUTDATED" item that must be filtered out
                self._add_item(proj, repo, login, "Closed - OUTDATED", "Sprint 6.9", table, None,
                               created=dt.datetime(2026, 8, 20, tzinfo=UTC), closed=dt.datetime(2026, 8, 28, tzinfo=UTC),
                               updated=dt.datetime(2026, 8, 28, tzinfo=UTC), events=[])

    def _make_item(self, proj, repo, login, people, table, title, si, sprint_titles, k, n, is_current, quirk, pr_ratio):
        r = self.rng
        s_start, s_end = sprint_bounds(title, table)
        points = r.choice([1, 2, 3, 3, 5, 5, 8, None])
        created = s_start - dt.timedelta(days=r.randint(1, 20), hours=r.randint(0, 20))
        started = s_start + dt.timedelta(days=r.randint(0, 7), hours=r.randint(8, 18))
        events = [("Todo", "In Progress", started)]
        final_status, closed, sprint_title, pr_state = "Done", None, title, "MERGED"
        if not is_current:
            roll = r.random() if quirk != "quiet" else 0.1   # the quiet person finished everything inside past sprints
            if roll < 0.75:            # finished inside the sprint
                done = min(started + dt.timedelta(days=r.randint(1, 6), hours=r.randint(1, 9)), s_end - dt.timedelta(hours=2))
                events += [("In Progress", "In Review", done - dt.timedelta(days=1)), ("In Review", "Done", done)]
                closed = done
            elif roll < 0.9 and si + 1 < len(sprint_titles):   # carried into the next sprint, finished there
                nxt = sprint_titles[si + 1]
                n_start, n_end = sprint_bounds(nxt, table)
                sprint_title = nxt
                done = n_start + dt.timedelta(days=r.randint(1, 8), hours=5)
                if done > self.today:
                    final_status, closed, pr_state = "In Progress", None, "OPEN"
                else:
                    events += [("In Progress", "In Review", done - dt.timedelta(days=1)), ("In Review", "Done", done)]
                    closed = done
            else:                      # finished late without moving the sprint field
                done = s_end + dt.timedelta(days=r.randint(1, 5), hours=3)
                if done > self.today:
                    done = self.today - dt.timedelta(days=1)
                events += [("In Progress", "In Review", done - dt.timedelta(days=1)), ("In Review", "Done", done)]
                closed = done
        else:
            started = min(started, self.today - dt.timedelta(hours=6))
            events = [("Todo", "In Progress", started)]
            choice = r.random()
            if choice < 0.35:
                done = min(started + dt.timedelta(days=r.randint(1, 4)), self.today - dt.timedelta(hours=3))
                events += [("In Progress", "In Review", done - dt.timedelta(hours=20)), ("In Review", "Done", done)]
                closed = done
            elif choice < 0.6:
                final_status, pr_state = "In Progress", "OPEN"
            elif choice < 0.8:
                final_status, pr_state = "In Review", "OPEN"
                events += [("In Progress", "In Review", started + dt.timedelta(days=1))]
            else:
                final_status, pr_state, events = "Todo", None, []
            if quirk == "blocked" and k == 0:
                final_status, pr_state = "Blocked", "OPEN"
                events = [("Todo", "In Progress", started), ("In Progress", "Blocked", self.today - dt.timedelta(days=4))]
            if quirk == "overloaded":
                if final_status == "Todo":
                    final_status, pr_state, events = "In Progress", "OPEN", [("Todo", "In Progress", started)]
            if quirk == "quiet":
                # nothing touched since the sprint started: everything still Todo
                final_status, pr_state, events, closed = "Todo", None, [], None
        updated = closed or (events[-1][2] if events else created)
        if final_status == "Todo" and is_current:
            updated = s_start + dt.timedelta(hours=2)
        item = self._add_item(proj, repo, login, final_status, sprint_title, table, points, created, closed, updated, events)
        # PR for anything that got started
        if pr_state and r.random() < pr_ratio:
            self._make_pr(repo, login, people, item, events, closed, pr_state, quirk, is_current)

    def _add_item(self, proj, repo, login, status, sprint_title, table, points, created, closed, updated, events):
        self._n += 1
        num = self._n
        s_start, s_end = sprint_bounds(sprint_title, table)
        dur = next(d for t, s, d in table if t == sprint_title)
        content_id = f"I_{proj}_{num}"
        item_id = f"PVTI_{proj}_{num}"
        last_event = events[-1][2] if events else created
        node = {
            "id": item_id, "type": "ISSUE", "isArchived": status == "Done" and closed is not None and (self.today - closed).days > 10,
            "createdAt": iso(created), "updatedAt": iso(updated),
            "status": {"__typename": "ProjectV2ItemFieldSingleSelectValue", "name": status, "updatedAt": iso(last_event)},
            "sprint": {"__typename": "ProjectV2ItemFieldIterationValue", "title": sprint_title,
                       "startDate": s_start.date().isoformat(), "duration": dur, "iterationId": f"it_{sprint_title}",
                       "updatedAt": iso(created)},
            "points": {"__typename": "ProjectV2ItemFieldNumberValue", "number": points, "updatedAt": iso(created)} if points else None,
            "track": {"__typename": "ProjectV2ItemFieldSingleSelectValue", "name": self.rng.choice(TRACKS)},
            "workstream": {"__typename": "ProjectV2ItemFieldSingleSelectValue", "name": "Apply" if proj == 13 else "Opp Publishing"},
            "priority": {"__typename": "ProjectV2ItemFieldSingleSelectValue", "name": self.rng.choice(["P1 - High", "P2 - Medium", "P2 - Medium", "P3 - Low"])},
            "deliverable": {"__typename": "ProjectV2ItemFieldSingleSelectValue", "name": "Simpler Application Pilot *" if proj == 13 else "SGM Task Management"},
            "actual_start": None, "actual_end": None,
            "content": {
                "__typename": "Issue", "id": content_id, "number": num,
                "title": self.rng.choice(TITLES).format(x=self.rng.choice(NOUNS)),
                "url": f"https://github.com/{repo}/issues/{num}",
                "state": "CLOSED" if closed else "OPEN", "stateReason": "COMPLETED" if closed else None,
                "createdAt": iso(created), "updatedAt": iso(updated), "closedAt": iso(closed) if closed else None,
                "repository": {"nameWithOwner": repo},
                "assignees": {"nodes": [{"login": login}]},
                "labels": {"nodes": [{"name": self.rng.choice(["backend", "frontend", "infra", "bug", "tech-debt"])}]},
                "issueType": {"name": self.rng.choice(["Task", "Bug", "Task", "Enhancement"])},
                "milestone": None, "parent": {"number": 900 + proj, "title": "Epic: Simpler Apply pilot" if proj == 13 else "Epic: Opportunity publishing"},
            },
        }
        self.items[proj].append(node)
        self.timelines[content_id] = [
            {"__typename": "AddedToProjectV2Event", "createdAt": iso(created + dt.timedelta(hours=1)), "project": {"number": proj}},
        ] + [
            {"__typename": "ProjectV2ItemStatusChangedEvent", "createdAt": iso(t), "status": b, "previousStatus": a, "project": {"number": proj}}
            for a, b, t in events
        ]
        return node

    def _make_pr(self, repo, login, people, item, events, closed, pr_state, quirk, is_current):
        r = self.rng
        self._n += 1
        num = self._n
        started = events[0][2] if events else self.today - dt.timedelta(days=3)
        created = started + dt.timedelta(hours=r.randint(3, 30))
        if created > self.today:
            created = self.today - dt.timedelta(hours=5)
        merged = closed if pr_state == "MERGED" else None
        if merged and created >= merged:
            created = merged - dt.timedelta(hours=r.randint(6, 40))
        is_draft = pr_state == "OPEN" and item["status"]["name"] == "In Progress" and r.random() < 0.5 and quirk != "stale_pr"
        reviewers = [p for p in people if p != login]
        reviewer_pool = ["fibarra"] * 3 + reviewers if "fibarra" in reviewers else reviewers
        wanted = r.sample(reviewer_pool, k=min(len(set(reviewer_pool)), r.choice([1, 1, 2])))
        wanted = list(dict.fromkeys(wanted))
        req_at = created + dt.timedelta(hours=r.randint(1, 6))
        if is_draft:
            wanted = []
        timeline = [{"__typename": "ReviewRequestedEvent", "createdAt": iso(req_at),
                     "requestedReviewer": {"__typename": "User", "login": w}} for w in wanted]
        reviews, pending = [], []
        quiet_since = self.today - dt.timedelta(days=8)   # dquinn has been silent for a week (demo "quiet" flag)
        for w in wanted:
            turnaround = dt.timedelta(hours=r.choice([2, 4, 8, 20, 30, 48, 72]))
            if w == "fibarra":
                turnaround = dt.timedelta(hours=r.choice([1, 2, 3, 6]))
            at = req_at + turnaround
            end = merged or self.today
            if w == "dquinn" and at >= quiet_since:
                end = quiet_since
            if at < end - dt.timedelta(hours=1):
                state = r.choice(["APPROVED", "APPROVED", "APPROVED", "CHANGES_REQUESTED", "COMMENTED"])
                reviews.append({"author": {"login": w}, "state": state, "submittedAt": iso(at)})
                if state == "CHANGES_REQUESTED" and merged:
                    reviews.append({"author": {"login": w}, "state": "APPROVED", "submittedAt": iso(at + dt.timedelta(hours=10))})
            else:
                pending.append(w)
        updated = merged or (max([dt.datetime.fromisoformat(x["submittedAt"].replace("Z", "+00:00")) for x in reviews] + [created]))
        if quirk == "stale_pr" and pr_state == "OPEN" and not is_draft:
            created = self.today - dt.timedelta(days=9)
            req_at = created + dt.timedelta(hours=2)
            timeline = [{"__typename": "ReviewRequestedEvent", "createdAt": iso(req_at), "requestedReviewer": {"__typename": "User", "login": w}} for w in wanted]
            reviews, pending, updated = [], wanted, created + dt.timedelta(hours=3)
        decision = None
        if reviews:
            last = {}
            for rv in reviews:
                last[rv["author"]["login"]] = rv["state"]
            if "CHANGES_REQUESTED" in last.values():
                decision = "CHANGES_REQUESTED"
            elif "APPROVED" in last.values():
                decision = "APPROVED"
        elif wanted:
            decision = "REVIEW_REQUIRED"
        node = {
            "id": f"PR_{num}", "number": num, "title": "[" + item["content"]["title"] + "]",
            "url": f"https://github.com/{repo}/pull/{num}",
            "state": pr_state, "isDraft": is_draft,
            "createdAt": iso(created), "updatedAt": iso(updated), "closedAt": iso(merged) if merged else None,
            "mergedAt": iso(merged) if merged else None,
            "baseRefName": "main", "headRefName": f"{login}/{item['content']['number']}-work",
            "reviewDecision": decision,
            "author": {"login": login}, "mergedBy": {"login": login} if merged else None,
            "assignees": {"nodes": []}, "labels": {"nodes": []},
            "closingIssuesReferences": {"nodes": [{"number": item["content"]["number"], "repository": {"nameWithOwner": repo}}]},
            "reviewRequests": {"nodes": [{"requestedReviewer": {"__typename": "User", "login": w}} for w in pending]},
            "reviews": {"nodes": reviews},
            "timelineItems": {"nodes": timeline},
        }
        self.prs[repo].append(node)

    # ------------------------------------------------------------------ gql dispatch
    def gql(self, query: str, variables=None, *, allow_partial=True):
        self.calls += 1
        self.cost_used += 1
        v = variables or {}
        rl = {"cost": 1, "remaining": self.remaining, "resetAt": self.reset_at}
        if "fields(first" in query:
            num = v["number"]
            table = SPRINTS_13 if num == 13 else SPRINTS_84
            statuses = STATUS_13 if num == 13 else STATUS_84
            fields = [
                {"__typename": "ProjectV2Field", "id": "f_title", "name": "Title", "dataType": "TITLE"},
                {"__typename": "ProjectV2SingleSelectField", "id": "f_status", "name": "Status", "dataType": "SINGLE_SELECT",
                 "options": [{"id": f"o{i}", "name": s} for i, s in enumerate(statuses)]},
                {"__typename": "ProjectV2IterationField", "id": "f_sprint", "name": "Sprint", "dataType": "ITERATION",
                 "configuration": {
                     "iterations": [{"id": f"it_{t}", "title": t, "startDate": s, "duration": d} for t, s, d in table if s >= "2026-09-30"],
                     "completedIterations": [{"id": f"it_{t}", "title": t, "startDate": s, "duration": d} for t, s, d in table if s < "2026-09-30"],
                 }},
                {"__typename": "ProjectV2Field", "id": "f_points", "name": "Story Points", "dataType": "NUMBER"},
                {"__typename": "ProjectV2SingleSelectField", "id": "f_track", "name": "Track", "dataType": "SINGLE_SELECT", "options": [{"id": "t1", "name": t} for t in TRACKS]},
                {"__typename": "ProjectV2SingleSelectField", "id": "f_ws", "name": "Workstream", "dataType": "SINGLE_SELECT", "options": []},
                {"__typename": "ProjectV2SingleSelectField", "id": "f_pri", "name": "Priority", "dataType": "SINGLE_SELECT", "options": []},
                {"__typename": "ProjectV2SingleSelectField", "id": "f_del", "name": "Deliverable" if num == 13 else "Deliverable ", "dataType": "SINGLE_SELECT", "options": []},
                {"__typename": "ProjectV2Field", "id": "f_as", "name": "Actual Start", "dataType": "DATE"},
                {"__typename": "ProjectV2Field", "id": "f_ae", "name": "Actual End", "dataType": "DATE"},
            ]
            title = "Simpler Grants.gov Product" if num == 13 else "Smarter Grants Management"
            return {"organization": {"projectV2": {"id": f"PVT_{num}", "title": title,
                                                   "url": f"https://github.com/orgs/HHS/projects/{num}", "closed": False,
                                                   "fields": {"nodes": fields}}}, "rateLimit": rl}
        if "items(first" in query:
            num = v["number"]
            items = self.items[num]
            start = int(v.get("cursor") or 0)
            page = items[start:start + 100]
            nxt = start + 100
            return {"organization": {"projectV2": {"items": {
                "pageInfo": {"hasNextPage": nxt < len(items), "endCursor": str(nxt)},
                "totalCount": len(items), "nodes": page}}}, "rateLimit": rl}
        if "pullRequests(first" in query:
            repo = f"{v['owner']}/{v['name']}"
            prs = sorted(self.prs[repo], key=lambda p: p["updatedAt"], reverse=True)
            start = int(v.get("cursor") or 0)
            page = prs[start:start + 40]
            nxt = start + 40
            return {"repository": {"pullRequests": {"pageInfo": {"hasNextPage": nxt < len(prs), "endCursor": str(nxt)},
                                                    "nodes": page}}, "rateLimit": rl}
        if "nodes(ids" in query:
            out = []
            for cid in v["ids"]:
                out.append({"__typename": "Issue", "id": cid, "timelineItems": {"nodes": self.timelines.get(cid, [])}})
            return {"nodes": out, "rateLimit": rl}
        raise AssertionError("unexpected query")
