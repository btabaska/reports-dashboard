#!/usr/bin/env python3
"""
Nightly sync for the Direct Reports Dashboard.

Pulls GitHub Projects (v2) items, pull requests, and issue status timelines for
the projects/repos in config/settings.json, then writes:

  data/snapshots/YYYY-MM-DD.json  compact daily snapshot (status / sprint / points / assignees per item)
  data/timeline_events.json       per-item status-change events from the issue timeline (authoritative)
  data/latest.json                everything the dashboard reads: sprints, items, prs, history, meta

Only work from `quad_start` onward is kept. Standard library only (no pip).

Environment:
  GH_TOKEN   token that can read the org projects. A classic PAT with `read:project`
             is the safe choice; the repos are public so no repo scope is needed.

Usage:
  python sync/sync.py                 # incremental (timelines refreshed only for recently-updated issues)
  python sync/sync.py --full          # refetch every timeline (first run does this automatically)
  python sync/sync.py --dry-run       # fetch and report, write nothing
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

API = "https://api.github.com/graphql"
UTC = dt.timezone.utc

# ----------------------------------------------------------------------------- helpers


def log(msg: str) -> None:
    print(f"[{dt.datetime.now(UTC).strftime('%H:%M:%S')}] {msg}", flush=True)


def parse_dt(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def parse_date(s: str) -> dt.date:
    return dt.date.fromisoformat(s[:10])


class RateLimited(Exception):
    pass


class GitHub:
    """Tiny GraphQL client with retries and rate-limit awareness."""

    def __init__(self, token: str):
        self.token = token
        self.cost_used = 0
        self.remaining = None
        self.reset_at = None
        self.calls = 0

    def gql(self, query: str, variables: dict | None = None, *, allow_partial: bool = True) -> dict:
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        last_err: Exception | None = None
        for attempt in range(6):
            req = urllib.request.Request(
                API,
                data=body,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                    "User-Agent": "reports-dashboard-sync",
                    "GraphQL-Features": "sub_issues,issue_types",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    payload = json.load(resp)
                self.calls += 1
                rl = (payload.get("data") or {}).get("rateLimit")
                if rl:
                    self.cost_used += rl.get("cost", 0)
                    self.remaining = rl.get("remaining")
                    self.reset_at = rl.get("resetAt")
                    if self.remaining is not None and self.remaining < 150:
                        self._sleep_until_reset()
                errors = payload.get("errors") or []
                if errors:
                    types = {e.get("type") for e in errors}
                    if "RATE_LIMITED" in types:
                        self._sleep_until_reset()
                        continue
                    if payload.get("data") is None or not allow_partial:
                        raise RuntimeError(f"GraphQL errors: {json.dumps(errors)[:2000]}")
                    # Partial data (e.g. a FORBIDDEN node) - log once, keep going.
                    log(f"  warning: {len(errors)} GraphQL error(s), continuing with partial data: "
                        f"{errors[0].get('message', '')[:200]}")
                return payload["data"]
            except urllib.error.HTTPError as e:  # noqa: PERF203
                last_err = e
                if e.code in (401,):
                    raise RuntimeError("GitHub rejected the token (401). Check the GH_TOKEN secret.") from e
                if e.code in (403, 429):
                    reset = e.headers.get("x-ratelimit-reset")
                    retry_after = e.headers.get("retry-after")
                    if retry_after:
                        wait = int(retry_after)
                    elif reset:
                        wait = max(5, int(reset) - int(time.time()) + 5)
                    else:
                        wait = 60 * (attempt + 1)
                    log(f"  HTTP {e.code}; sleeping {wait}s")
                    time.sleep(min(wait, 3600))
                    continue
                if e.code >= 500:
                    wait = 10 * (attempt + 1)
                    log(f"  HTTP {e.code}; retrying in {wait}s")
                    time.sleep(wait)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last_err = e
                wait = 10 * (attempt + 1)
                log(f"  network error {e}; retrying in {wait}s")
                time.sleep(wait)
        raise RuntimeError(f"GraphQL request failed after retries: {last_err}")

    def _sleep_until_reset(self) -> None:
        reset = parse_dt(self.reset_at) if self.reset_at else None
        wait = 60
        if reset:
            wait = max(5, int((reset - dt.datetime.now(UTC)).total_seconds()) + 5)
        log(f"  rate limit low ({self.remaining}); sleeping {wait}s until reset")
        time.sleep(min(wait, 3700))


RATE = "rateLimit { cost remaining resetAt }"

# ----------------------------------------------------------------------------- queries

PROJECT_META_Q = """
query($org: String!, $number: Int!) {
  organization(login: $org) {
    projectV2(number: $number) {
      id title url closed
      fields(first: 60) {
        nodes {
          __typename
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          ... on ProjectV2IterationField {
            id name dataType
            configuration {
              iterations { id title startDate duration }
              completedIterations { id title startDate duration }
            }
          }
        }
      }
    }
  }
  %s
}
""" % RATE


def build_items_query(field_aliases: dict[str, str]) -> str:
    """field_aliases: alias -> exact project field name (only fields that exist)."""
    parts = []
    for alias, name in field_aliases.items():
        safe = json.dumps(name)
        parts.append(
            f"""{alias}: fieldValueByName(name: {safe}) {{
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {{ name updatedAt }}
              ... on ProjectV2ItemFieldIterationValue {{ title startDate duration iterationId updatedAt }}
              ... on ProjectV2ItemFieldNumberValue {{ number updatedAt }}
              ... on ProjectV2ItemFieldDateValue {{ date updatedAt }}
              ... on ProjectV2ItemFieldTextValue {{ text updatedAt }}
            }}"""
        )
    fields_block = "\n".join(parts)
    return f"""
query($org: String!, $number: Int!, $cursor: String) {{
  organization(login: $org) {{
    projectV2(number: $number) {{
      items(first: 100, after: $cursor, archivedStates: [ARCHIVED, NOT_ARCHIVED]) {{
        pageInfo {{ hasNextPage endCursor }}
        totalCount
        nodes {{
          id type isArchived createdAt updatedAt
          {fields_block}
          content {{
            __typename
            ... on Issue {{
              id number title url state stateReason createdAt updatedAt closedAt
              repository {{ nameWithOwner }}
              assignees(first: 6) {{ nodes {{ login }} }}
              labels(first: 8) {{ nodes {{ name }} }}
              issueType {{ name }}
              milestone {{ title }}
              parent {{ number title }}
            }}
            ... on PullRequest {{
              id number title url prState: state isDraft createdAt updatedAt closedAt mergedAt
              repository {{ nameWithOwner }}
              author {{ login }}
              assignees(first: 6) {{ nodes {{ login }} }}
              labels(first: 8) {{ nodes {{ name }} }}
            }}
            ... on DraftIssue {{
              id title createdAt updatedAt
              assignees(first: 6) {{ nodes {{ login }} }}
            }}
          }}
        }}
      }}
    }}
  }}
  {RATE}
}}
"""


PRS_Q = """
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 40, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title url state isDraft createdAt updatedAt closedAt mergedAt
        baseRefName headRefName reviewDecision
        author { login }
        mergedBy { login }
        assignees(first: 6) { nodes { login } }
        labels(first: 8) { nodes { name } }
        closingIssuesReferences(first: 6) { nodes { number repository { nameWithOwner } } }
        reviewRequests(first: 10) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
        }
        reviews(first: 50) {
          nodes { author { login } state submittedAt }
        }
        timelineItems(first: 40, itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, READY_FOR_REVIEW_EVENT]) {
          nodes {
            __typename
            ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
            ... on ReviewRequestRemovedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
            ... on ReadyForReviewEvent { createdAt }
          }
        }
      }
    }
  }
  %s
}
""" % RATE


TIMELINE_Q = """
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      timelineItems(first: 80, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT, ADDED_TO_PROJECT_V2_EVENT, REMOVED_FROM_PROJECT_V2_EVENT]) {
        nodes {
          __typename
          ... on ProjectV2ItemStatusChangedEvent { createdAt status previousStatus project { number } }
          ... on AddedToProjectV2Event { createdAt project { number } }
          ... on RemovedFromProjectV2Event { createdAt project { number } }
        }
      }
    }
    ... on PullRequest {
      id
      timelineItems(first: 80, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT, ADDED_TO_PROJECT_V2_EVENT, REMOVED_FROM_PROJECT_V2_EVENT]) {
        nodes {
          __typename
          ... on ProjectV2ItemStatusChangedEvent { createdAt status previousStatus project { number } }
          ... on AddedToProjectV2Event { createdAt project { number } }
          ... on RemovedFromProjectV2Event { createdAt project { number } }
        }
      }
    }
  }
  %s
}
""" % RATE

# ----------------------------------------------------------------------------- fetchers


def fetch_project_meta(gh: GitHub, org: str, number: int) -> dict:
    data = gh.gql(PROJECT_META_Q, {"org": org, "number": number}, allow_partial=False)
    proj = (data.get("organization") or {}).get("projectV2")
    if not proj:
        raise RuntimeError(f"Project {org}/{number} not found or token cannot read it "
                           f"(classic PAT needs the read:project scope).")
    return proj


def resolve_field_names(meta: dict, wanted: dict[str, str]) -> dict[str, str]:
    """Map alias -> exact field name present in the project (case/whitespace-insensitive)."""
    present = {}
    for f in meta["fields"]["nodes"]:
        name = f.get("name")
        if name:
            present[re.sub(r"\s+", " ", name).strip().casefold()] = name
    out = {}
    for alias, name in wanted.items():
        key = re.sub(r"\s+", " ", name).strip().casefold()
        if key in present:
            out[alias] = present[key]
    return out


def fetch_project_items(gh: GitHub, org: str, number: int, aliases: dict[str, str]) -> list[dict]:
    q = build_items_query(aliases)
    cursor = None
    items: list[dict] = []
    total = None
    page = 0
    while True:
        data = gh.gql(q, {"org": org, "number": number, "cursor": cursor})
        conn = data["organization"]["projectV2"]["items"]
        total = conn.get("totalCount", total)
        nodes = [n for n in conn["nodes"] if n]
        items.extend(nodes)
        page += 1
        if page % 10 == 0 or not conn["pageInfo"]["hasNextPage"]:
            log(f"  project {number}: {len(items)}/{total} items (rate remaining {gh.remaining})")
        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]
    return items


def fetch_prs(gh: GitHub, repo: str, since: dt.datetime) -> list[dict]:
    owner, name = repo.split("/", 1)
    cursor = None
    prs: list[dict] = []
    while True:
        data = gh.gql(PRS_Q, {"owner": owner, "name": name, "cursor": cursor})
        repo_data = data.get("repository")
        if not repo_data:
            log(f"  warning: repository {repo} not readable; skipping")
            break
        conn = repo_data["pullRequests"]
        stop = False
        for pr in conn["nodes"]:
            if not pr:
                continue
            if parse_dt(pr["updatedAt"]) < since:
                stop = True
                break
            prs.append(pr)
        if stop or not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]
    log(f"  {repo}: {len(prs)} PRs updated since {since.date()} (rate remaining {gh.remaining})")
    return prs


def fetch_timelines(gh: GitHub, content_ids: list[str]) -> dict[str, list[dict]]:
    """content node id -> list of project status events."""
    out: dict[str, list[dict]] = {}
    for i in range(0, len(content_ids), 40):
        batch = content_ids[i:i + 40]
        data = gh.gql(TIMELINE_Q, {"ids": batch})
        for node in data.get("nodes") or []:
            if not node or "timelineItems" not in node:
                continue
            events = []
            for ev in node["timelineItems"]["nodes"] or []:
                if not ev:
                    continue
                proj = (ev.get("project") or {}).get("number")
                events.append({
                    "type": ev["__typename"],
                    "at": ev["createdAt"],
                    "project": proj,
                    "status": ev.get("status"),
                    "previous": ev.get("previousStatus"),
                })
            out[node["id"]] = events
    log(f"  timelines: {len(out)} items fetched (rate remaining {gh.remaining})")
    return out

# ----------------------------------------------------------------------------- normalization


def sprint_key(title: str, regex: re.Pattern) -> str | None:
    m = regex.search(title or "")
    return m.group(1) if m else None


def build_sprints(meta: dict, sprint_field: str, quad_start: dt.date, regex: re.Pattern) -> list[dict]:
    sprints = []
    for f in meta["fields"]["nodes"]:
        if f.get("name") != sprint_field or "configuration" not in f:
            continue
        cfg = f["configuration"]
        for it in cfg.get("iterations", []) + cfg.get("completedIterations", []):
            start = parse_date(it["startDate"])
            if start < quad_start:
                continue
            end = start + dt.timedelta(days=int(it["duration"]) - 1)
            sprints.append({
                "key": sprint_key(it["title"], regex) or it["title"],
                "title": it["title"],
                "start": start.isoformat(),
                "end": end.isoformat(),
                "days": int(it["duration"]),
                "iteration_id": it["id"],
            })
    sprints.sort(key=lambda s: s["start"])
    return sprints


def canonical_sprint_for(start: dt.date, duration: int, sprints: list[dict]) -> dict | None:
    """Map an arbitrary iteration onto the canonical sprint containing its midpoint."""
    mid = start + dt.timedelta(days=max(0, duration // 2))
    for s in sprints:
        if parse_date(s["start"]) <= mid <= parse_date(s["end"]):
            return s
    return None


def fv(node: dict | None, key: str):
    return node.get(key) if node else None


def normalize_item(raw: dict, project: int, sprints: list[dict], regex: re.Pattern, canonical: bool) -> dict | None:
    content = raw.get("content") or {}
    ctype = content.get("__typename")
    if raw.get("type") == "REDACTED" or not ctype:
        return None
    sprint_raw = raw.get("sprint")
    sprint = None
    if sprint_raw and sprint_raw.get("startDate"):
        start = parse_date(sprint_raw["startDate"])
        duration = int(sprint_raw.get("duration") or 14)
        if canonical:
            key = sprint_key(sprint_raw["title"], regex) or sprint_raw["title"]
            sprint = {"key": key, "title": sprint_raw["title"], "start": start.isoformat(),
                      "end": (start + dt.timedelta(days=duration - 1)).isoformat(), "native": True}
        else:
            canon = canonical_sprint_for(start, duration, sprints)
            sprint = {"key": canon["key"] if canon else None, "title": sprint_raw["title"],
                      "start": start.isoformat(),
                      "end": (start + dt.timedelta(days=duration - 1)).isoformat(), "native": False}
    assignees = [a["login"] for a in (content.get("assignees") or {}).get("nodes", []) if a]
    labels = [l["name"] for l in (content.get("labels") or {}).get("nodes", []) if l]
    item = {
        "id": raw["id"],
        "content_id": content.get("id"),
        "project": project,
        "type": {"Issue": "issue", "PullRequest": "pr", "DraftIssue": "draft"}.get(ctype, ctype.lower()),
        "archived": bool(raw.get("isArchived")),
        "number": content.get("number"),
        "repo": (content.get("repository") or {}).get("nameWithOwner"),
        "title": content.get("title"),
        "url": content.get("url"),
        "state": content.get("state") or content.get("prState"),
        "state_reason": content.get("stateReason"),
        "created_at": content.get("createdAt") or raw.get("createdAt"),
        "updated_at": max(filter(None, [content.get("updatedAt"), raw.get("updatedAt")])),
        "closed_at": content.get("closedAt"),
        "merged_at": content.get("mergedAt"),
        "author": (content.get("author") or {}).get("login"),
        "assignees": assignees,
        "labels": labels,
        "issue_type": (content.get("issueType") or {}).get("name"),
        "milestone": (content.get("milestone") or {}).get("title"),
        "parent": content.get("parent"),
        "status": fv(raw.get("status"), "name"),
        "status_updated_at": fv(raw.get("status"), "updatedAt"),
        "sprint": sprint,
        "sprint_updated_at": fv(sprint_raw, "updatedAt"),
        "points": fv(raw.get("points"), "number"),
        "track": fv(raw.get("track"), "name"),
        "workstream": fv(raw.get("workstream"), "name"),
        "priority": fv(raw.get("priority"), "name"),
        "deliverable": fv(raw.get("deliverable"), "name"),
        "actual_start": fv(raw.get("actual_start"), "date"),
        "actual_end": fv(raw.get("actual_end"), "date"),
    }
    return item


def in_window(item: dict, quad_start: dt.date, flight_statuses: set[str]) -> bool:
    qs = dt.datetime.combine(quad_start, dt.time.min, tzinfo=UTC)
    if item["sprint"] and item["sprint"].get("start") and parse_date(item["sprint"]["start"]) >= quad_start:
        return True
    for k in ("updated_at", "closed_at", "merged_at"):
        d = parse_dt(item.get(k))
        if d and d >= qs:
            return True
    if item.get("status") in flight_statuses and item.get("state") in ("OPEN", None):
        return True
    return False


def reviewer_id(node: dict | None) -> str | None:
    if not node:
        return None
    if node.get("__typename") == "User":
        return node.get("login")
    if node.get("__typename") == "Team":
        return f"team:{node.get('slug')}"
    return None


def normalize_pr(raw: dict, repo: str) -> dict:
    requested_events: list[dict] = []
    ready_at = None
    for ev in (raw.get("timelineItems") or {}).get("nodes") or []:
        if not ev:
            continue
        t = ev["__typename"]
        if t == "ReadyForReviewEvent":
            ready_at = ev["createdAt"]
        elif t == "ReviewRequestedEvent":
            rid = reviewer_id(ev.get("requestedReviewer"))
            if rid:
                requested_events.append({"reviewer": rid, "at": ev["createdAt"], "removed_at": None})
        elif t == "ReviewRequestRemovedEvent":
            rid = reviewer_id(ev.get("requestedReviewer"))
            for e in reversed(requested_events):
                if e["reviewer"] == rid and e["removed_at"] is None:
                    e["removed_at"] = ev["createdAt"]
                    break
    reviews = []
    for r in (raw.get("reviews") or {}).get("nodes") or []:
        if not r or not r.get("submittedAt"):
            continue
        reviews.append({"author": (r.get("author") or {}).get("login"), "state": r["state"], "at": r["submittedAt"]})
    return {
        "id": raw["id"],
        "repo": repo,
        "number": raw["number"],
        "title": raw["title"],
        "url": raw["url"],
        "state": raw["state"],
        "is_draft": bool(raw.get("isDraft")),
        "author": (raw.get("author") or {}).get("login"),
        "merged_by": (raw.get("mergedBy") or {}).get("login"),
        "created_at": raw["createdAt"],
        "updated_at": raw["updatedAt"],
        "closed_at": raw.get("closedAt"),
        "merged_at": raw.get("mergedAt"),
        "ready_for_review_at": ready_at,
        "base": raw.get("baseRefName"),
        "head": raw.get("headRefName"),
        "review_decision": raw.get("reviewDecision"),
        "assignees": [a["login"] for a in (raw.get("assignees") or {}).get("nodes", []) if a],
        "labels": [l["name"] for l in (raw.get("labels") or {}).get("nodes", []) if l],
        "linked_issues": [{"repo": (n.get("repository") or {}).get("nameWithOwner"), "number": n.get("number")}
                          for n in (raw.get("closingIssuesReferences") or {}).get("nodes", []) if n],
        "pending_reviewers": [rid for rid in (reviewer_id(n.get("requestedReviewer"))
                                              for n in (raw.get("reviewRequests") or {}).get("nodes", []) if n) if rid],
        "review_requests": requested_events,
        "reviews": reviews,
    }

# ----------------------------------------------------------------------------- snapshots & history


def snapshot_of(items: list[dict]) -> dict:
    snap = {}
    for it in items:
        snap[it["id"]] = {
            "s": it.get("status"),
            "sp": (it.get("sprint") or {}).get("key"),
            "spt": (it.get("sprint") or {}).get("title"),
            "p": it.get("points"),
            "a": sorted(it.get("assignees") or []),
            "st": it.get("state"),
            "pr": it.get("project"),
        }
    return snap


def load_snapshots(snap_dir: Path) -> list[tuple[str, dict]]:
    out = []
    for p in sorted(snap_dir.glob("*.json")):
        try:
            d = json.loads(p.read_text())
            out.append((d["date"], d["items"]))
        except Exception as e:  # noqa: BLE001
            log(f"  warning: could not read snapshot {p.name}: {e}")
    return out


def history_from_snapshots(snaps: list[tuple[str, dict]], skip_status_for: set[str]) -> list[dict]:
    events: list[dict] = []
    prev_date, prev = None, None
    for date, cur in snaps:
        if prev is not None:
            at = f"{date}T00:00:00Z"
            for iid, now in cur.items():
                before = prev.get(iid)
                if before is None:
                    if now.get("sp"):
                        events.append({"at": at, "item": iid, "f": "sprint", "from": None, "to": now["sp"], "src": "snapshot"})
                    continue
                if before.get("sp") != now.get("sp"):
                    events.append({"at": at, "item": iid, "f": "sprint", "from": before.get("sp"), "to": now.get("sp"), "src": "snapshot"})
                if before.get("s") != now.get("s") and iid not in skip_status_for:
                    events.append({"at": at, "item": iid, "f": "status", "from": before.get("s"), "to": now.get("s"), "src": "snapshot"})
                if before.get("p") != now.get("p"):
                    events.append({"at": at, "item": iid, "f": "points", "from": before.get("p"), "to": now.get("p"), "src": "snapshot"})
                if before.get("a") != now.get("a"):
                    events.append({"at": at, "item": iid, "f": "assignees", "from": before.get("a"), "to": now.get("a"), "src": "snapshot"})
            for iid in prev.keys() - cur.keys():
                events.append({"at": at, "item": iid, "f": "removed", "from": prev[iid].get("sp"), "to": None, "src": "snapshot"})
        prev_date, prev = date, cur
    return events


def history_from_timelines(items: list[dict], timelines: dict[str, list[dict]]) -> tuple[list[dict], set[str]]:
    """Convert content-level timeline events into item-level status history."""
    by_content: dict[tuple[str, int], str] = {}
    for it in items:
        if it.get("content_id"):
            by_content[(it["content_id"], it["project"])] = it["id"]
    events: list[dict] = []
    covered: set[str] = set()
    for cid, evs in timelines.items():
        for ev in evs:
            iid = by_content.get((cid, ev.get("project")))
            if not iid:
                continue
            covered.add(iid)
            if ev["type"] == "ProjectV2ItemStatusChangedEvent":
                events.append({"at": ev["at"], "item": iid, "f": "status", "from": ev.get("previous") or None,
                               "to": ev.get("status") or None, "src": "timeline"})
            elif ev["type"] == "AddedToProjectV2Event":
                events.append({"at": ev["at"], "item": iid, "f": "added", "from": None, "to": None, "src": "timeline"})
            elif ev["type"] == "RemovedFromProjectV2Event":
                events.append({"at": ev["at"], "item": iid, "f": "removed", "from": None, "to": None, "src": "timeline"})
    return events, covered

# ----------------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", default="config/settings.json")
    ap.add_argument("--out", default="data")
    ap.add_argument("--full", action="store_true", help="refetch all issue timelines")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        print("GH_TOKEN is not set", file=sys.stderr)
        return 2

    settings = json.loads(Path(args.settings).read_text())
    out_dir = Path(args.out)
    snap_dir = out_dir / "snapshots"
    quad_start = parse_date(settings["quad_start"])
    quad_start_dt = dt.datetime.combine(quad_start, dt.time.min, tzinfo=UTC)
    regex = re.compile(settings.get("sprint_key_regex", r"Sprint\s+(\d+\.\d+)"))
    flight = set(settings["statuses"].get("in_flight", [])) | set(settings["statuses"].get("blocked", []))
    started = dt.datetime.now(UTC)
    warnings: list[str] = []

    prev_meta = {}
    latest_path = out_dir / "latest.json"
    if latest_path.exists():
        try:
            prev_meta = json.loads(latest_path.read_text()).get("meta", {})
        except Exception:  # noqa: BLE001
            prev_meta = {}
    tl_path = out_dir / "timeline_events.json"
    timelines: dict[str, list[dict]] = {}
    if tl_path.exists() and not args.full:
        try:
            timelines = json.loads(tl_path.read_text())
        except Exception:  # noqa: BLE001
            timelines = {}
    first_run = not timelines
    last_success = parse_dt(prev_meta.get("last_success_at"))

    gh = GitHub(token)
    org = settings["org"]

    # 1. Projects: metadata, sprints, items
    projects_out = []
    sprints: list[dict] = []
    all_items: list[dict] = []
    metas: dict[int, dict] = {}
    for p in settings["projects"]:
        log(f"project {p['number']}: metadata")
        meta = fetch_project_meta(gh, org, p["number"])
        metas[p["number"]] = meta
        if p.get("canonical_sprints"):
            sprint_field = resolve_field_names(meta, {"sprint": settings["fields"]["sprint"]}).get("sprint")
            if not sprint_field:
                raise RuntimeError(f"Sprint field '{settings['fields']['sprint']}' not found in project {p['number']}")
            sprints = build_sprints(meta, sprint_field, quad_start, regex)
            log(f"  canonical sprints since {quad_start}: {[s['key'] for s in sprints]}")
    if not sprints:
        raise RuntimeError("No canonical sprints found; set canonical_sprints=true on one project")

    for p in settings["projects"]:
        meta = metas[p["number"]]
        aliases = resolve_field_names(meta, settings["fields"])
        missing = set(settings["fields"]) - set(aliases)
        if missing:
            warnings.append(f"project {p['number']}: fields not found: {sorted(missing)}")
        log(f"project {p['number']}: items")
        raw_items = fetch_project_items(gh, org, p["number"], aliases)
        kept = 0
        repos_seen: set[str] = set()
        for raw in raw_items:
            it = normalize_item(raw, p["number"], sprints, regex, bool(p.get("canonical_sprints")))
            if not it:
                continue
            if it.get("repo"):
                repos_seen.add(it["repo"])
            if in_window(it, quad_start, flight):
                all_items.append(it)
                kept += 1
        status_field = next((f for f in meta["fields"]["nodes"] if f.get("name") == aliases.get("status")), None)
        projects_out.append({
            "number": p["number"],
            "title": meta["title"],
            "url": meta["url"],
            "repos": p.get("repos", []),
            "repos_seen": sorted(repos_seen),
            "status_options": [o["name"] for o in (status_field or {}).get("options", [])],
            "items_total": len(raw_items),
            "items_in_window": kept,
        })
        extra = sorted(r for r in repos_seen if r not in p.get("repos", []))
        if extra:
            warnings.append(f"project {p['number']}: items from repos not in settings (PRs there are not synced): {extra}")
        log(f"  kept {kept} of {len(raw_items)} items in window")

    # 2. Pull requests per configured repo
    prs: list[dict] = []
    seen_repos: set[str] = set()
    for p in settings["projects"]:
        for repo in p.get("repos", []):
            if repo in seen_repos:
                continue
            seen_repos.add(repo)
            log(f"pull requests: {repo}")
            for raw in fetch_prs(gh, repo, quad_start_dt):
                prs.append(normalize_pr(raw, repo))

    # 3. Issue/PR timelines (authoritative status history)
    want: list[str] = []
    cutoff = (last_success - dt.timedelta(days=2)) if (last_success and not first_run and not args.full) else None
    for it in all_items:
        cid = it.get("content_id")
        if not cid or it["type"] == "draft":
            continue
        if cutoff is None or cid not in timelines or (parse_dt(it["updated_at"]) or started) >= cutoff:
            want.append(cid)
    want = sorted(set(want))
    log(f"timelines: fetching {len(want)} of {len(all_items)} items ({'full' if cutoff is None else 'incremental'})")
    if want:
        fetched = fetch_timelines(gh, want)
        timelines.update(fetched)
    # prune timelines for items no longer in window
    live_ids = {it.get("content_id") for it in all_items}
    timelines = {k: v for k, v in timelines.items() if k in live_ids}

    # 4. Snapshot + history
    today = started.date().isoformat()
    snap = snapshot_of(all_items)
    snaps = [s for s in load_snapshots(snap_dir) if s[0] != today]
    snaps.append((today, snap))
    snaps.sort(key=lambda s: s[0])
    tl_events, covered = history_from_timelines(all_items, timelines)
    snap_events = history_from_snapshots(snaps, covered)
    history = sorted(tl_events + snap_events, key=lambda e: (e["at"], e["item"]))

    finished = dt.datetime.now(UTC)
    meta = {
        "generated_at": finished.isoformat().replace("+00:00", "Z"),
        "last_success_at": finished.isoformat().replace("+00:00", "Z"),
        "duration_s": round((finished - started).total_seconds(), 1),
        "snapshot_date": today,
        "snapshot_count": len(snaps),
        "first_snapshot": snaps[0][0] if snaps else today,
        "graphql_calls": gh.calls,
        "graphql_cost": gh.cost_used,
        "rate_remaining": gh.remaining,
        "items": len(all_items),
        "prs": len(prs),
        "history_events": len(history),
        "timeline_items": len(timelines),
        "warnings": warnings,
        "repository": os.environ.get("GITHUB_REPOSITORY"),
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "schema_version": 1,
    }
    latest = {
        "meta": meta,
        "quad_start": quad_start.isoformat(),
        "sprints": sprints,
        "projects": projects_out,
        "items": all_items,
        "prs": prs,
        "history": history,
    }

    log(f"done: {len(all_items)} items, {len(prs)} PRs, {len(history)} history events, "
        f"{gh.calls} calls / {gh.cost_used} points in {meta['duration_s']}s")
    for w in warnings:
        log(f"warning: {w}")

    if args.dry_run:
        return 0
    snap_dir.mkdir(parents=True, exist_ok=True)
    (snap_dir / f"{today}.json").write_text(json.dumps({"date": today, "items": snap}, separators=(",", ":")))
    tl_path.write_text(json.dumps(timelines, separators=(",", ":")))
    latest_path.write_text(json.dumps(latest, separators=(",", ":")))
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        log(f"FAILED: {e}")
        sys.exit(1)
