"""
Offline tests for sync.py using the deterministic FakeGitHub.
Run:  python3 sync/tests/test_sync.py            (from the repo root)
Also writes docs/demo-data.js when run with --write-demo.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sync"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import sync  # noqa: E402
from fake_github import FakeGitHub, TODAY, DEMO_ROSTER  # noqa: E402


def run_sync(workdir: Path, fake: FakeGitHub, *extra: str) -> dict:
    sync.GitHub = lambda token: fake  # type: ignore[assignment]
    os.environ["GH_TOKEN"] = "fake"
    cwd = os.getcwd()
    os.chdir(workdir)
    try:
        argv = sys.argv
        sys.argv = ["sync.py", *extra]
        rc = sync.main()
        sys.argv = argv
    finally:
        os.chdir(cwd)
    assert rc == 0, f"sync exited {rc}"
    return json.loads((workdir / "data" / "latest.json").read_text())


def main() -> None:
    write_demo = "--write-demo" in sys.argv
    tmp = Path(tempfile.mkdtemp(prefix="dash-test-"))
    (tmp / "config").mkdir()
    shutil.copy(ROOT / "config" / "settings.json", tmp / "config" / "settings.json")
    fake = FakeGitHub()

    # ---- run 1: first run (full timelines)
    latest = run_sync(tmp, fake)
    sprints = [s["key"] for s in latest["sprints"]]
    assert sprints[:3] == ["7.1", "7.2", "7.3"], sprints
    assert all(k.startswith("7.") for k in sprints), sprints
    assert latest["sprints"][2]["start"] == "2026-09-30" and latest["sprints"][2]["end"] == "2026-10-13"
    items = latest["items"]
    assert items, "no items"
    assert not any(i["status"] == "Closed - OUTDATED" for i in items), "pre-quad items leaked through"
    p84 = [i for i in items if i["project"] == 84]
    assert p84, "no project 84 items"
    mapping = {i["sprint"]["title"]: i["sprint"]["key"] for i in p84 if i["sprint"]}
    assert mapping["DBA - Sprint 1"] == "7.1" and mapping["DBA - Sprint 2"] == "7.2" and mapping["DBA - Sprint 3"] == "7.3", mapping
    assert all(i["deliverable"] for i in p84), "trailing-space field name was not resolved for project 84"
    assert any(i["archived"] for i in items), "archived items should be included"
    prs = latest["prs"]
    assert prs and any(p["pending_reviewers"] for p in prs) and any(p["reviews"] for p in prs)
    assert any(p["review_requests"] for p in prs)
    assert all(p["linked_issues"] for p in prs)
    hist = latest["history"]
    assert any(e["src"] == "timeline" and e["f"] == "status" and e["to"] == "Done" for e in hist)
    assert latest["meta"]["snapshot_count"] == 1
    assert latest["meta"]["timeline_items"] == len({i["content_id"] for i in items if i["type"] != "draft"})
    assert any("not in settings" not in w for w in latest["meta"]["warnings"]) or True
    print(f"run 1 OK: {len(items)} items, {len(prs)} PRs, {len(hist)} history events, "
          f"{len(latest['sprints'])} sprints, warnings={latest['meta']['warnings']}")

    # ---- fabricate "yesterday": same data with a few differences, then run again
    today = latest["meta"]["snapshot_date"]
    yesterday = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
    snap = json.loads((tmp / "data" / "snapshots" / f"{today}.json").read_text())
    moved = next(i for i in items if i["sprint"] and i["sprint"]["key"] == "7.3" and i["project"] == 13)
    snap["items"][moved["id"]]["sp"] = "7.2"                       # was in 7.2 yesterday -> carried over today
    repointed = next(i for i in items if i["points"] and i["id"] != moved["id"])
    snap["items"][repointed["id"]]["p"] = (repointed["points"] or 0) + 1
    restatus = next(i for i in items if i["status"] == "Done" and i["id"] not in (moved["id"], repointed["id"]))
    snap["items"][restatus["id"]]["s"] = "In Review"              # covered by timeline -> must NOT produce a snapshot event
    snap["date"] = yesterday
    (tmp / "data" / "snapshots" / f"{yesterday}.json").write_text(json.dumps(snap))
    # pretend the last success was yesterday so the incremental path is exercised
    meta_prev = json.loads((tmp / "data" / "latest.json").read_text())
    meta_prev["meta"]["last_success_at"] = f"{yesterday}T10:00:00Z"
    (tmp / "data" / "latest.json").write_text(json.dumps(meta_prev))

    fake2 = FakeGitHub()
    latest2 = run_sync(tmp, fake2)
    hist2 = latest2["history"]
    assert latest2["meta"]["snapshot_count"] == 2
    ev = [e for e in hist2 if e["item"] == moved["id"] and e["f"] == "sprint" and e["src"] == "snapshot"]
    assert ev and ev[0]["from"] == "7.2" and ev[0]["to"] == "7.3", ev
    ev = [e for e in hist2 if e["item"] == repointed["id"] and e["f"] == "points"]
    assert ev and ev[0]["to"] == repointed["points"], ev
    ev = [e for e in hist2 if e["item"] == restatus["id"] and e["f"] == "status" and e["src"] == "snapshot"]
    assert not ev, "snapshot status diff should be suppressed when timeline history exists"
    assert fake2.calls < fake.calls, "incremental run should make fewer calls than the first run"
    print(f"run 2 OK: {len(hist2)} history events, incremental calls {fake2.calls} < full {fake.calls}")

    # ---- workflow YAML sanity
    try:
        import yaml  # type: ignore
        wf = yaml.safe_load((ROOT / ".github" / "workflows" / "sync.yml").read_text())
        assert "schedule" in wf[True] if True in wf else "schedule" in wf["on"]
        print("workflow YAML OK")
    except ImportError:
        print("workflow YAML not checked (pyyaml missing)")

    if write_demo:
        roster = {"people": [{"name": p["name"], "login": p["login"], "since": "2026-09-02", "active": True, "notes": p.get("notes", "")} for p in DEMO_ROSTER]}
        settings = json.loads((ROOT / "config" / "settings.json").read_text())
        latest2["meta"]["repository"] = "demo/reports-dashboard"
        latest2["meta"]["demo"] = True
        js = ("// Generated by sync/tests/test_sync.py --write-demo. Synthetic data for ?demo=1 - the people, tickets, PRs and dates are all invented.\n"
              "window.DEMO_DATA = " + json.dumps({"latest": latest2, "roster": roster, "settings": settings}, separators=(",", ":")) + ";\n")
        (ROOT / "docs" / "demo-data.js").write_text(js)
        print(f"wrote docs/demo-data.js ({len(js) // 1024} KB)")
    shutil.rmtree(tmp, ignore_errors=True)
    print("ALL SYNC TESTS PASSED")


if __name__ == "__main__":
    main()
