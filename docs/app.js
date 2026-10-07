/* app.js - loads data (GitHub API or demo), computes the model with metrics.js, renders the views,
   and handles the admin actions (roster/settings saves, run-sync). */
(function () {
  "use strict";
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAY = 86400000, HOUR = 3600000;
  const LS_KEY = "reports-dashboard.cfg";
  const PALETTE = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#475569", "#0d9488", "#9333ea"];

  const state = {
    cfg: { repo: "", token: "", branch: "" }, demo: false,
    latest: null, roster: null, settings: null, shas: {}, model: null,
    view: "overview", sprintKey: null, person: null, charts: [], dirtyRoster: false,
  };

  // ------------------------------------------------------------------ formatting
  const toDate = (t) => {
    if (typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t)) { const [y, m, d] = t.split("-").map(Number); return new Date(y, m - 1, d); } // date-only: no tz shift
    return new Date(typeof t === "number" ? t : Date.parse(t));
  };
  const fmt = {
    date: (t) => (t ? toDate(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"),
    dateTime: (t) => (t ? new Date(typeof t === "number" ? t : Date.parse(t)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"),
    rel: (t) => {
      if (!t) return "never";
      const ms = Date.now() - (typeof t === "number" ? t : Date.parse(t));
      if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))}m ago`;
      if (ms < DAY) return `${Math.round(ms / HOUR)}h ago`;
      return `${Math.round(ms / DAY)}d ago`;
    },
    days: (d) => (d == null || d < 0 ? "—" : d < 1 ? `${Math.round(d * 24)}h` : `${d.toFixed(d < 10 ? 1 : 0)}d`),
    hours: (h) => (h == null ? "—" : h < 48 ? `${Math.round(h)}h` : `${(h / 24).toFixed(1)}d`),
    pct: (x) => (x == null ? "—" : `${Math.round(x * 100)}%`),
    num: (n) => (n == null ? "—" : typeof n !== "number" ? String(n) : Number.isInteger(n) ? String(n) : n.toFixed(1)),
    int: (n) => (n == null ? "—" : String(Math.round(n))),
  };
  const sprintLabel = (key) => `Sprint ${key}`;
  const personColor = (login) => {
    const i = state.model.people.findIndex((p) => p.login === login);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  };
  const statusClass = (s) => {
    const S = state.settings.statuses || {};
    if ((S.done || []).includes(s)) return "done";
    if ((S.blocked || []).includes(s)) return "blocked";
    if ((S.in_progress || []).includes(s)) return "prog";
    if ((S.in_flight || []).includes(s)) return "review";
    return "";
  };
  const projBadge = (n) => `<span class="badge p${n}">P${n}</span>`;
  const itemLink = (it) => `<a href="${esc(it.url)}" target="_blank" rel="noopener" title="${esc(it.repo || "")}">#${esc(it.number)}</a>`;
  const prLink = (pr) => `<a href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(pr.repo)}">#${esc(pr.number)}</a>`;
  function toast(msg, ms) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms || 2600);
  }

  // ------------------------------------------------------------------ config
  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) Object.assign(state.cfg, JSON.parse(raw));
    } catch (e) { /* storage unavailable */ }
    if (!state.cfg.repo) state.cfg.repo = inferRepo();
  }
  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.cfg)); } catch (e) { /* ignore */ }
  }
  function inferRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return m && seg ? `${m[1]}/${seg}` : "";
  }

  // ------------------------------------------------------------------ GitHub API
  async function gh(path, opts) {
    opts = opts || {};
    const headers = {
      Authorization: `Bearer ${state.cfg.token}`,
      Accept: opts.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (opts.body) headers["Content-Type"] = "application/json";
    const res = await fetch(`https://api.github.com${path}`, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message || text; } catch (e) { /* raw */ }
      const err = new Error(`${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return opts.raw ? text : JSON.parse(text);
  }
  const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64dec = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));
  const contentsPath = (p) => `/repos/${state.cfg.repo}/contents/${p}?ref=${encodeURIComponent(state.cfg.branch)}`;

  async function loadLive() {
    const repo = await gh(`/repos/${state.cfg.repo}`);
    if (!state.cfg.branch) { state.cfg.branch = repo.default_branch || "main"; saveCfg(); }
    const [roster, settings] = await Promise.all([gh(contentsPath("config/roster.json")), gh(contentsPath("config/settings.json"))]);
    state.roster = JSON.parse(b64dec(roster.content));
    state.settings = JSON.parse(b64dec(settings.content));
    state.shas = { roster: roster.sha, settings: settings.sha };
    try {
      state.latest = JSON.parse(await gh(contentsPath("data/latest.json"), { raw: true }));
    } catch (e) {
      if (e.status === 404) { state.latest = null; return; }
      throw e;
    }
  }
  function loadDemo() {
    return new Promise((resolve, reject) => {
      if (window.DEMO_DATA) {  // already inlined (e.g. a self-contained preview build)
        const d = window.DEMO_DATA;
        state.latest = d.latest; state.roster = d.roster; state.settings = d.settings;
        return resolve();
      }
      const s = document.createElement("script");
      s.src = "demo-data.js";
      s.onload = () => {
        const d = window.DEMO_DATA;
        state.latest = d.latest; state.roster = d.roster; state.settings = d.settings;
        resolve();
      };
      s.onerror = () => reject(new Error("demo-data.js could not be loaded"));
      document.head.appendChild(s);
    });
  }
  async function putJson(path, obj, shaKey, message) {
    const body = { message, content: b64enc(JSON.stringify(obj, null, 2) + "\n"), branch: state.cfg.branch };
    if (state.shas[shaKey]) body.sha = state.shas[shaKey];
    const res = await gh(`/repos/${state.cfg.repo}/contents/${path}`, { method: "PUT", body });
    state.shas[shaKey] = res.content.sha;
  }
  async function dispatchSync(full) {
    await gh(`/repos/${state.cfg.repo}/actions/workflows/sync.yml/dispatches`, { method: "POST", body: { ref: state.cfg.branch, inputs: { full: full ? "true" : "false" } } });
  }
  async function latestRuns() {
    const r = await gh(`/repos/${state.cfg.repo}/actions/workflows/sync.yml/runs?per_page=5`);
    return r.workflow_runs || [];
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    const params = new URLSearchParams(location.search);
    state.demo = params.get("demo") === "1" || window.FORCE_DEMO === true;
    $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) showView(b.dataset.view); });
    $("#connectBtn").addEventListener("click", onConnect);
    $("#tokenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") onConnect(); });
    loadCfg();
    if (state.demo) {
      try { await loadDemo(); } catch (e) { return showSetup(e.message); }
    } else {
      if (!state.cfg.repo || !state.cfg.token) return showSetup();
      try { await loadLive(); } catch (e) { return showSetup(describeError(e)); }
    }
    start();
  }
  function describeError(e) {
    if (e.status === 401) return "GitHub rejected the token (401). Create a new fine-grained token and try again.";
    if (e.status === 403) return "Forbidden (403). The token needs Contents read access to this repository.";
    if (e.status === 404) return `Not found (404). Check the repository name, and that config/roster.json exists on the ${state.cfg.branch || "default"} branch.`;
    return e.message;
  }
  function showSetup(err) {
    $("#loading").classList.add("hidden");
    $("#app").classList.add("hidden");
    $("#setup").classList.remove("hidden");
    $("#repoInput").value = state.cfg.repo || "";
    $("#tokenInput").value = state.cfg.token || "";
    const box = $("#setupError");
    box.classList.toggle("hidden", !err);
    box.textContent = err || "";
  }
  async function onConnect() {
    state.cfg.repo = $("#repoInput").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
    state.cfg.token = $("#tokenInput").value.trim();
    state.cfg.branch = "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(state.cfg.repo)) return showSetup("Repository must look like owner/name.");
    if (!state.cfg.token) return showSetup("Token is required.");
    $("#connectBtn").disabled = true;
    try {
      await loadLive();
      saveCfg();
      $("#setup").classList.add("hidden");
      start();
    } catch (e) {
      showSetup(describeError(e));
    } finally {
      $("#connectBtn").disabled = false;
    }
  }
  function start() {
    $("#loading").classList.add("hidden");
    $("#setup").classList.add("hidden");
    $("#app").classList.remove("hidden");
    if (!state.latest) { state.view = "admin"; }
    compute();
    render();
  }
  function compute() {
    if (!state.latest) { state.model = null; return; }
    state.model = Metrics.compute(state.latest, state.roster, state.settings);
    const m = state.model;
    if (!state.sprintKey || !m.sprints.some((s) => s.key === state.sprintKey)) state.sprintKey = m.currentSprint ? m.currentSprint.key : (m.sprints[m.sprints.length - 1] || {}).key;
    if (!state.person || !m.people.some((p) => p.login === state.person)) state.person = (m.people.find((p) => p.active) || m.people[0] || {}).login || null;
  }

  // ------------------------------------------------------------------ render
  function render() {
    renderTopbar();
    renderSprintBar();
    renderView();
  }
  function showView(v) {
    state.view = v;
    render();
  }
  function renderTopbar() {
    $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
    const m = state.model;
    $("#quadLabel").textContent = m && m.currentSprint ? `Quad ${String(m.currentSprint.key).split(".")[0]}` : "";
    const pill = $("#syncPill");
    if (!m) {
      pill.innerHTML = `<span class="dot bad"></span> No data yet`;
      return;
    }
    const s = m.sync;
    const cls = s.stale ? "stale" : "";
    pill.innerHTML = `<span class="dot ${cls}"></span> Synced ${esc(fmt.rel(s.generatedAt))}${state.demo ? " · <b>demo data</b>" : ""} <button class="link-btn small" data-view="admin">details</button>`;
    pill.querySelector("button").addEventListener("click", () => showView("admin"));
  }
  function renderSprintBar() {
    const m = state.model;
    const chips = $("#sprintChips");
    const prog = $("#sprintProgress");
    if (!m) { chips.innerHTML = ""; prog.innerHTML = ""; return; }
    chips.innerHTML = m.sprints.map((s) => {
      const cur = m.currentSprint && s.key === m.currentSprint.key;
      return `<button class="chip ${s.key === state.sprintKey ? "active" : ""}" data-key="${esc(s.key)}" title="${esc(s.start)} → ${esc(s.end)}">${esc(sprintLabel(s.key))}${cur ? '<span class="live" title="in progress"></span>' : ""}</button>`;
    }).join("");
    $$("button", chips).forEach((b) => b.addEventListener("click", () => { state.sprintKey = b.dataset.key; render(); }));
    const sel = m.sprints.find((s) => s.key === state.sprintKey);
    if (sel && m.currentSprint && sel.key === m.currentSprint.key && m.progress) {
      prog.innerHTML = `<span>${esc(fmt.date(sel.start))} – ${esc(fmt.date(sel.end))} · day ${m.progress.elapsedDays + 1} of ${m.progress.totalDays}</span><div class="bar"><i style="width:${Math.round(m.progress.pct * 100)}%"></i></div>`;
    } else if (sel) {
      prog.innerHTML = `<span>${esc(fmt.date(sel.start))} – ${esc(fmt.date(sel.end))} · completed</span>`;
    } else prog.innerHTML = "";
  }
  function renderView() {
    $$(".view").forEach((v) => v.classList.add("hidden"));
    destroyCharts();
    const el = $(`#view-${state.view}`);
    el.classList.remove("hidden");
    if (!state.model && state.view !== "admin") {
      el.innerHTML = `<div class="card"><h2>No data yet</h2><p class="muted">The sync workflow hasn't produced <code>data/latest.json</code> yet. Open the Admin tab to run it.</p></div>`;
      return;
    }
    ({ overview: renderOverview, person: renderPerson, record: renderRecord, admin: renderAdmin })[state.view]();
  }
  function destroyCharts() {
    for (const c of state.charts) { try { c.destroy(); } catch (e) { /* ignore */ } }
    state.charts = [];
  }
  function chart(canvas, config) {
    if (typeof Chart === "undefined") { canvas.parentElement.innerHTML = `<p class="empty">Charts need Chart.js (cdnjs) — offline?</p>`; return; }
    const css = getComputedStyle(document.documentElement);
    Chart.defaults.color = css.getPropertyValue("--muted").trim();
    Chart.defaults.borderColor = css.getPropertyValue("--line").trim();
    Chart.defaults.font.family = css.getPropertyValue("--font");
    Chart.defaults.font.size = 11.5;
    const c = new Chart(canvas, config);
    state.charts.push(c);
    return c;
  }

  // ------------------------------------------------------------------ overview
  function flagsHtml(flags, withLinks) {
    if (!flags.length) return `<div class="flags"><span class="flag ok">No flags</span></div>`;
    return `<div class="flags">${flags.map((f) => `<span class="flag ${esc(f.level)}" title="${esc(f.text)}">${withLinks && f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(flagLabel(f))}</a>` : esc(flagLabel(f))}</span>`).join("")}</div>`;
  }
  const FLAG_LABELS = { quiet: "Quiet", overloaded: "Overloaded", overcommitted: "Over-committed", blocked: "Blocked", stale_pr: "Stale PR", review_backlog: "Review backlog", carryover: "High carry-over" };
  const flagLabel = (f) => FLAG_LABELS[f.type] || f.type;

  function renderOverview() {
    const m = state.model, key = state.sprintKey;
    const sprint = m.sprints.find((s) => s.key === key);
    const isCurrent = m.currentSprint && key === m.currentSprint.key;
    const t = m.team.perSprint[key] || {};
    const people = m.people.filter((p) => p.active);
    const attn = m.team.current.flags.slice().sort((a, b) => ({ alert: 0, warn: 1, info: 2 }[a.level] - { alert: 0, warn: 1, info: 2 }[b.level]));
    const byPerson = new Map();
    for (const f of attn) { if (!byPerson.has(f.login)) byPerson.set(f.login, []); byPerson.get(f.login).push(f); }

    const kpis = [
      { v: t.completedCount, s: `${fmt.num(t.completedPoints)} pts`, l: "Completed" },
      { v: t.plannedCount, s: `${fmt.num(t.plannedPoints)} pts`, l: isCurrent ? "Planned this sprint" : "Planned" },
      isCurrent ? { v: m.team.current.wip, l: "In flight now", d: `${m.team.current.blocked} blocked` } : { v: t.notFinishedCount, l: "Not finished", d: `${t.carriedCount} carried over` },
      { v: t.prsMerged, l: "PRs merged" },
      { v: t.reviewsCount, l: "Reviews given" },
      { v: fmt.days(t.cycleMedianDays), l: "Median cycle time", d: "In Progress → Done" },
      { v: m.team.current.openPrs, l: "Open PRs now", d: `${m.team.current.pendingReviews} reviews waiting` },
    ];
    $("#view-overview").innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <h2>${esc(sprintLabel(key))} · team of ${people.length}${isCurrent ? ' <span class="badge">in progress</span>' : ""}</h2>
          <div class="kpis">${kpis.map((k) => `<div class="kpi"><div class="v">${esc(fmt.num(k.v))}${k.s ? `<small>${esc(k.s)}</small>` : ""}</div><div class="l">${esc(k.l)}</div>${k.d ? `<div class="d">${esc(k.d)}</div>` : ""}</div>`).join("")}</div>
        </div>
        <div class="card">
          <h2>Needs attention <span class="faint small">as of last sync</span></h2>
          ${byPerson.size ? `<div class="attn">${[...byPerson.entries()].map(([login, fs]) => `<div class="attn-row"><div class="who"><a href="#" data-person="${esc(login)}">${esc(fs[0].name)}</a></div><div>${fs.map((f) => `<div><span class="flag ${esc(f.level)}">${esc(flagLabel(f))}</span> <span class="small">${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.text)}</a>` : esc(f.text)}</span></div>`).join("")}</div></div>`).join("")}</div>` : `<p class="empty">Nothing flagged. Thresholds are in Admin.</p>`}
        </div>
      </div>
      <div class="section-title">People · ${esc(sprintLabel(key))}</div>
      <div class="grid cards">${people.map((p) => personCard(p, key, isCurrent)).join("")}</div>
      <div class="grid cols-2" style="margin-top:14px">
        <div class="card"><h2>Story points completed, by sprint</h2><div class="chart-wrap"><canvas id="chPoints"></canvas></div></div>
        <div class="card"><h2>Reviews given, by sprint</h2><div class="chart-wrap"><canvas id="chReviews"></canvas></div></div>
      </div>
      <div class="card" style="margin-top:14px"><h2>Team: planned vs completed items, and median cycle time</h2><div class="chart-wrap"><canvas id="chTeam"></canvas></div></div>
      <p class="faint small" style="margin-top:12px">Carry-over and cycle time are exact from the first daily snapshot (${esc(fmt.date(m.sync.meta.first_snapshot))}) onward; earlier sprints use the issue timeline, and inferred items are marked ~.</p>`;
    $$("[data-person]", $("#view-overview")).forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); state.person = a.dataset.person; showView("person"); }));
    $$(".pcard", $("#view-overview")).forEach((c) => c.addEventListener("click", () => { state.person = c.dataset.login; showView("person"); }));

    const labels = m.sprints.map((s) => sprintLabel(s.key));
    chart($("#chPoints"), {
      type: "bar",
      data: { labels, datasets: people.map((p) => ({ label: p.name, data: m.sprints.map((s) => p.perSprint[s.key].active ? p.perSprint[s.key].completedPoints : null), backgroundColor: personColor(p.login), stack: "a" })) },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }, plugins: { legend: { position: "bottom" } } },
    });
    chart($("#chReviews"), {
      type: "bar",
      data: { labels, datasets: people.map((p) => ({ label: p.name, data: m.sprints.map((s) => p.perSprint[s.key].active ? p.perSprint[s.key].reviewsCount : null), backgroundColor: personColor(p.login), stack: "a" })) },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }, plugins: { legend: { position: "bottom" } } },
    });
    chart($("#chTeam"), {
      data: {
        labels,
        datasets: [
          { type: "bar", label: "Planned items", data: m.sprints.map((s) => m.team.perSprint[s.key].plannedCount), backgroundColor: "rgba(37,99,235,.35)", yAxisID: "y" },
          { type: "bar", label: "Completed items", data: m.sprints.map((s) => m.team.perSprint[s.key].completedCount), backgroundColor: "#16a34a", yAxisID: "y" },
          { type: "line", label: "Median cycle time (days)", data: m.sprints.map((s) => m.team.perSprint[s.key].cycleMedianDays), borderColor: "#f59e0b", backgroundColor: "#f59e0b", yAxisID: "y2", cubicInterpolationMode: "monotone" },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, position: "left" }, y2: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false } } }, plugins: { legend: { position: "bottom" } } },
    });
  }
  function personCard(p, key, isCurrent) {
    const r = p.perSprint[key];
    const inactive = !r || !r.active;
    const stats = inactive ? [] : isCurrent ? [
      { v: `${r.completedCount}<small class="muted"> · ${fmt.num(r.completedPoints)}p</small>`, l: "done" },
      { v: `${r.plannedCount}<small class="muted"> · ${fmt.num(r.plannedPoints)}p</small>`, l: "planned" },
      { v: p.current.wip, l: "in flight" },
      { v: r.prsMerged.length, l: "PRs merged" },
      { v: r.reviewsCount, l: "reviews" },
      { v: p.current.openPrs.length, l: "open PRs" },
    ] : [
      { v: `${r.completedCount}<small class="muted"> · ${fmt.num(r.completedPoints)}p</small>`, l: "done" },
      { v: `${r.plannedCount}<small class="muted"> · ${fmt.num(r.plannedPoints)}p</small>`, l: "planned" },
      { v: `${r.notFinished.length}${r.inferredCount ? '<small class="faint">~</small>' : ""}`, l: "not finished" },
      { v: r.prsMerged.length, l: "PRs merged" },
      { v: r.reviewsCount, l: "reviews" },
      { v: fmt.days(r.cycleMedianDays), l: "cycle (med)" },
    ];
    return `<div class="card pcard ${inactive ? "inactive" : ""}" data-login="${esc(p.login)}">
      <div class="who"><span class="name">${esc(p.name)}</span><span class="handle">@${esc(p.login)}</span><span style="margin-left:auto">${p.projects.map(projBadge).join(" ")}</span></div>
      ${inactive ? `<p class="empty">Joins ${esc(fmt.date(p.since))}</p>` : `<div class="stats">${stats.map((s) => `<div class="stat"><div class="v">${s.v}</div><div class="l">${esc(s.l)}</div></div>`).join("")}</div>${flagsHtml(p.flags)}`}
    </div>`;
  }

  // ------------------------------------------------------------------ person
  function renderPerson() {
    const m = state.model, key = state.sprintKey;
    const p = m.people.find((x) => x.login === state.person) || m.people[0];
    if (!p) { $("#view-person").innerHTML = `<div class="card"><p class="empty">No people on the roster. Add them in Admin.</p></div>`; return; }
    const isCurrent = m.currentSprint && key === m.currentSprint.key;
    const r = p.perSprint[key];
    const sprint = m.sprints.find((s) => s.key === key);
    const onPlanPct = r.completedCount ? r.onPlanCount / r.completedCount : null;
    const kpis = [
      { v: r.completedCount, s: `${fmt.num(r.completedPoints)} pts`, l: "Completed", d: r.unpointedCompleted ? `${r.unpointedCompleted} unpointed` : "" },
      { v: r.plannedCount, s: `${fmt.num(r.plannedPoints)} pts`, l: isCurrent ? "Planned this sprint" : "Planned", d: r.inferredCount ? `${r.inferredCount} inferred ~` : "" },
      isCurrent ? { v: p.current.wip, l: "In flight now", d: `${p.current.blocked.length} blocked` } : { v: r.notFinished.length, l: "Not finished", d: `${r.carriedCount} carried over` },
      { v: fmt.pct(onPlanPct), l: "Done in planned sprint", d: r.lateCount ? `${r.lateCount} late, ${r.unplannedCount} unplanned` : (r.unplannedCount ? `${r.unplannedCount} unplanned` : "") },
      { v: r.prsMerged.length, l: "PRs merged", d: `${r.prsOpened.length} opened` },
      { v: r.reviewsCount, l: "Reviews given", d: `${r.reviewedPrCount} PRs · ${r.changesRequested} changes req.` },
      { v: fmt.days(r.cycleMedianDays), l: "Median cycle time", d: r.cycleSample ? `${r.cycleSample} items with data` : "no data" },
      { v: fmt.hours(r.reviewTurnaroundMedianH), l: "Review turnaround", d: r.reviewTurnaroundSample ? `median of ${r.reviewTurnaroundSample}` : "no requests" },
    ];
    const itemRow = (f, extra) => {
      const it = f.item;
      return `<tr><td>${itemLink(it)} ${projBadge(it.project)}</td><td>${esc(it.title)}</td><td><span class="status ${statusClass(it.status)}">${esc(it.status || it.state)}</span></td><td class="num">${esc(it.points == null ? "—" : it.points)}</td>${extra || ""}</tr>`;
    };
    const completedRows = r.completed.slice().sort((a, b) => b.completedAt - a.completedAt).map((f) => {
      const planned = f.plannedKeyAtCompletion;
      const tag = !planned ? `<span class="tag">unplanned</span>` : planned !== key ? `<span class="tag late">planned ${esc(planned)}</span>` : "";
      return itemRow(f, `<td>${esc(fmt.date(f.completedAt))}${tag}</td><td class="num">${esc(fmt.days(f.cycleDays))}</td>`);
    });
    const openPlanned = r.planned.filter((f) => !(f.completedAt != null && f.completedAt <= Date.parse(sprint.end + "T23:59:59Z")));
    const plannedRows = openPlanned.map((f) => itemRow(f, `<td>${f.isDone ? `done ${esc(fmt.date(f.completedAt))}` : f.currentKey && f.currentKey !== key ? `now in ${esc(f.currentKey)}` : f.startedAt ? `started ${esc(fmt.date(f.startedAt))}` : "not started"}${r.planned.indexOf(f) >= r.planned.length - r.inferredCount ? '<span class="tag inferred">~ inferred</span>' : ""}</td>`));
    const now = m.now;
    $("#view-person").innerHTML = `
      <div class="card">
        <div class="row spread">
          <div class="row">
            <select id="personSelect">${m.people.map((x) => `<option value="${esc(x.login)}" ${x.login === p.login ? "selected" : ""}>${esc(x.name)}${x.active ? "" : " (inactive)"}</option>`).join("")}</select>
            <span class="muted">@${esc(p.login)} ${p.projects.map(projBadge).join(" ")}${p.since ? ` · on team since ${esc(fmt.date(p.since))}` : ""}${p.notes ? ` · ${esc(p.notes)}` : ""}</span>
          </div>
          <div class="row"><span class="small muted">Last activity ${esc(fmt.rel(p.current.lastActivity))}</span>${flagsHtml(p.flags, true)}</div>
        </div>
      </div>
      <div class="grid cols-2" style="margin-top:14px">
        <div class="card"><h2>${esc(sprintLabel(key))}${isCurrent ? ' <span class="badge">in progress</span>' : ""}${!r.active ? ' <span class="badge">before start date</span>' : ""}</h2><div class="kpis">${kpis.map((k) => `<div class="kpi"><div class="v">${esc(fmt.num(k.v))}${k.s ? `<small>${esc(k.s)}</small>` : ""}</div><div class="l">${esc(k.l)}</div>${k.d ? `<div class="d">${esc(k.d)}</div>` : ""}</div>`).join("")}</div></div>
        <div class="card"><h2>Trend across sprints</h2><div class="chart-wrap"><canvas id="chPerson"></canvas></div></div>
      </div>
      <div class="grid cols-2" style="margin-top:14px">
        <div class="card">
          <div class="section-title">In flight now (${p.current.inFlight.length + p.current.blocked.length})</div>
          ${p.current.inFlight.length + p.current.blocked.length ? `<div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Title</th><th>Status</th><th class="num">Pts</th><th>Since</th></tr></thead><tbody>
            ${p.current.blocked.map((f) => itemRow(f, `<td class="nowrap">blocked ${esc(fmt.days(f.blockedDays))}</td>`)).join("")}
            ${p.current.inFlight.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).map((f) => itemRow(f, `<td class="nowrap">${f.startedAt ? esc(fmt.days((now - f.startedAt) / DAY)) + " in progress" : "—"}${f.currentKey ? ` <span class="tag">${esc(f.currentKey)}</span>` : ""}</td>`)).join("")}
          </tbody></table></div>` : `<p class="empty">Nothing in flight.</p>`}
          <div class="section-title">Open PRs authored (${p.current.openPrs.length})</div>
          ${p.current.openPrs.length ? `<div class="tbl-wrap"><table><thead><tr><th>PR</th><th>Title</th><th>Review</th><th class="num">Age</th><th class="num">Idle</th></tr></thead><tbody>
            ${p.current.openPrs.slice().sort((a, b) => b.idleDays - a.idleDays).map((o) => `<tr><td>${prLink(o.pr)}</td><td>${esc(o.pr.title)}${o.pr.is_draft ? ' <span class="tag">draft</span>' : ""}</td><td class="small">${esc(o.decision ? o.decision.replace("_", " ").toLowerCase() : "no reviews")}${o.pending.length ? `<br><span class="faint">waiting on ${esc(o.pending.join(", "))}</span>` : ""}</td><td class="num">${esc(fmt.days(o.ageDays))}</td><td class="num">${esc(fmt.days(o.idleDays))}</td></tr>`).join("")}
          </tbody></table></div>` : `<p class="empty">No open PRs.</p>`}
          <div class="section-title">Waiting on their review (${p.current.pendingReviews.length})</div>
          ${p.current.pendingReviews.length ? `<div class="tbl-wrap"><table><thead><tr><th>PR</th><th>Title</th><th>Author</th><th class="num">Waiting</th></tr></thead><tbody>
            ${p.current.pendingReviews.map((q) => `<tr><td>${prLink(q.pr)}</td><td>${esc(q.pr.title)}</td><td>${esc(q.pr.author)}</td><td class="num">${esc(fmt.days(q.waitingDays))}</td></tr>`).join("")}
          </tbody></table></div>` : `<p class="empty">No pending review requests.</p>`}
        </div>
        <div class="card">
          <div class="section-title">Completed in ${esc(sprintLabel(key))} (${r.completed.length})</div>
          ${completedRows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Title</th><th>Status</th><th class="num">Pts</th><th>Done</th><th class="num">Cycle</th></tr></thead><tbody>${completedRows.join("")}</tbody></table></div>` : `<p class="empty">Nothing completed${isCurrent ? " yet" : ""}.</p>`}
          <div class="section-title">${isCurrent ? "Planned and still open" : "Planned but not finished in sprint"} (${plannedRows.length})</div>
          ${plannedRows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Item</th><th>Title</th><th>Status</th><th class="num">Pts</th><th>Where it went</th></tr></thead><tbody>${plannedRows.join("")}</tbody></table></div>` : `<p class="empty">Everything planned was finished.</p>`}
          <div class="section-title">PRs merged in ${esc(sprintLabel(key))} (${r.prsMerged.length})</div>
          ${r.prsMerged.length ? `<div class="tbl-wrap"><table><thead><tr><th>PR</th><th>Title</th><th>Merged</th><th class="num">Open for</th></tr></thead><tbody>${r.prsMerged.slice().sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at)).map((x) => `<tr><td>${prLink(x)}</td><td>${esc(x.title)}</td><td>${esc(fmt.date(x.merged_at))}</td><td class="num">${esc(fmt.days((Date.parse(x.merged_at) - Date.parse(x.created_at)) / DAY))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No PRs merged.</p>`}
          <div class="section-title">Reviews given in ${esc(sprintLabel(key))} (${r.reviewsCount})</div>
          ${r.reviews.length ? `<div class="tbl-wrap"><table><thead><tr><th>PR</th><th>Title</th><th>Author</th><th>Review</th><th>When</th></tr></thead><tbody>${r.reviews.slice().sort((a, b) => b.at - a.at).map((v) => `<tr><td>${prLink(v.pr)}</td><td>${esc(v.pr.title)}</td><td>${esc(v.pr.author)}</td><td class="small">${esc(v.state.replace("_", " ").toLowerCase())}</td><td>${esc(fmt.date(v.at))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No reviews.</p>`}
        </div>
      </div>`;
    $("#personSelect").addEventListener("change", (e) => { state.person = e.target.value; render(); });
    const labels = m.sprints.map((s) => sprintLabel(s.key));
    chart($("#chPerson"), {
      data: {
        labels,
        datasets: [
          { type: "bar", label: "Planned pts", data: m.sprints.map((s) => p.perSprint[s.key].active ? p.perSprint[s.key].plannedPoints : null), backgroundColor: "rgba(37,99,235,.3)", yAxisID: "y" },
          { type: "bar", label: "Completed pts", data: m.sprints.map((s) => p.perSprint[s.key].active ? p.perSprint[s.key].completedPoints : null), backgroundColor: personColor(p.login), yAxisID: "y" },
          { type: "line", label: "Items completed", data: m.sprints.map((s) => p.perSprint[s.key].active ? p.perSprint[s.key].completedCount : null), borderColor: "#16a34a", backgroundColor: "#16a34a", yAxisID: "y2", cubicInterpolationMode: "monotone" },
          { type: "line", label: "Reviews given", data: m.sprints.map((s) => p.perSprint[s.key].active ? p.perSprint[s.key].reviewsCount : null), borderColor: "#f59e0b", backgroundColor: "#f59e0b", yAxisID: "y2", cubicInterpolationMode: "monotone", borderDash: [4, 3] },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, title: { display: true, text: "points" } }, y2: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "count" } } }, plugins: { legend: { position: "bottom" } } },
    });
  }

  // ------------------------------------------------------------------ trailing record
  function recordRows() {
    const m = state.model;
    const rows = [];
    for (const p of m.people) for (const s of m.sprints) {
      const r = p.perSprint[s.key];
      rows.push({
        person: p.name, login: p.login, sprint: s.key, start: s.start, end: s.end, active: r.active,
        completed_items: r.completedCount, completed_points: r.completedPoints, planned_items: r.plannedCount, planned_points: r.plannedPoints,
        done_in_planned_sprint: r.onPlanCount, completed_late: r.lateCount, unplanned: r.unplannedCount,
        not_finished: r.notFinished.length, carried_over: r.carriedCount, inferred_planned: r.inferredCount,
        prs_opened: r.prsOpened.length, prs_merged: r.prsMerged.length, reviews_given: r.reviewsCount, prs_reviewed: r.reviewedPrCount,
        changes_requested: r.changesRequested, median_cycle_days: r.cycleMedianDays == null ? "" : +r.cycleMedianDays.toFixed(2),
        median_review_turnaround_hours: r.reviewTurnaroundMedianH == null ? "" : +r.reviewTurnaroundMedianH.toFixed(1),
      });
    }
    return rows;
  }
  function renderRecord() {
    const m = state.model;
    const people = m.people;
    const cell = (r, isCurrent) => !r.active ? `<span class="faint">—</span>` : `<div class="cell"><b>${r.completedCount}</b> done · ${fmt.num(r.completedPoints)}p<br><span class="muted">${r.plannedCount} planned${isCurrent ? "" : ` · ${r.notFinished.length} nf${r.carriedCount ? ` (${r.carriedCount} c/o)` : ""}`}${r.inferredCount ? "~" : ""}</span><br><span class="muted">${r.prsMerged.length} PR · ${r.reviewsCount} rev · cyc ${fmt.days(r.cycleMedianDays)}</span></div>`;
    $("#view-record").innerHTML = `
      <div class="card">
        <div class="row spread"><h2>Trailing record · ${esc(people.length)} people × ${esc(m.sprints.length)} sprints</h2>
          <div class="row"><button class="btn small" id="csvBtn">Download CSV</button><button class="btn small" id="printBtn">Print</button></div></div>
        <div class="tbl-wrap"><table class="record"><thead><tr><th>Person</th>${m.sprints.map((s) => `<th>${esc(sprintLabel(s.key))}${m.currentSprint && s.key === m.currentSprint.key ? " ●" : ""}<br><span class="faint" style="text-transform:none;font-weight:400">${esc(fmt.date(s.start))}–${esc(fmt.date(s.end))}</span></th>`).join("")}<th>Avg / sprint</th></tr></thead>
        <tbody>
          ${people.map((p) => `<tr class="${p.active ? "" : "inactive"}"><td><b>${esc(p.name)}</b><br><span class="faint small">@${esc(p.login)}</span></td>${m.sprints.map((s) => `<td>${cell(p.perSprint[s.key], m.currentSprint && s.key === m.currentSprint.key)}</td>`).join("")}<td class="cell">${p.trailingAvgItems == null ? "—" : `<b>${fmt.num(p.trailingAvgItems)}</b> items · ${fmt.num(p.trailingAvgPoints)}p<br><span class="faint small">past sprints</span>`}</td></tr>`).join("")}
          <tr class="team"><td>Team (active)</td>${m.sprints.map((s) => { const t = m.team.perSprint[s.key]; return `<td class="cell"><b>${t.completedCount}</b> done · ${fmt.num(t.completedPoints)}p<br><span class="muted">${t.plannedCount} planned · ${t.notFinishedCount} nf</span><br><span class="muted">${t.prsMerged} PR · ${t.reviewsCount} rev · cyc ${fmt.days(t.cycleMedianDays)}</span></td>`; }).join("")}<td></td></tr>
        </tbody></table></div>
        <p class="faint small" style="margin:10px 0 0">done = completed during the sprint (Status → Done, issue closed, or PR merged) · planned = in the sprint at its start or end · nf = planned but not finished in the sprint · c/o = re-planned into a later sprint · ~ = includes items inferred from the issue timeline (pre-snapshot) · cyc = median In Progress → Done.</p>
      </div>`;
    $("#csvBtn").addEventListener("click", () => {
      const rows = recordRows();
      const cols = Object.keys(rows[0] || {});
      const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => { const v = r[c]; const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(","))].join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `trailing-record-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    });
    $("#printBtn").addEventListener("click", () => window.print());
  }

  // ------------------------------------------------------------------ admin
  function renderAdmin() {
    const m = state.model;
    const meta = (state.latest && state.latest.meta) || {};
    const F = state.settings.flags || {};
    const thresholds = [
      ["quiet_working_days", "Quiet: no activity for N working days"], ["wip_threshold", "Overloaded: items in flight ≥"],
      ["overload_ratio", "Over-committed: planned pts > N × avg completed"], ["blocked_days", "Blocked: days blocked ≥"],
      ["stale_pr_days", "Stale PR: idle days ≥"], ["review_backlog_count", "Review backlog: pending reviews ≥"],
      ["review_backlog_days", "Review backlog: oldest pending (days) ≥"], ["carryover_ratio", "High carry-over: unfinished share ≥ (0–1)"],
      ["stale_sync_hours", "Sync considered stale after N hours"],
    ];
    const actionsUrl = `https://github.com/${state.cfg.repo}/actions/workflows/sync.yml`;
    const unrostered = m ? m.unrostered : [];
    $("#view-admin").innerHTML = `
      <div class="grid cols-2">
        <div class="card">
          <h2>Sync status</h2>
          ${state.latest ? `<div class="kpis">
            <div class="kpi"><div class="v">${esc(fmt.rel(meta.generated_at))}</div><div class="l">Last sync</div><div class="d">${esc(fmt.dateTime(meta.generated_at))}</div></div>
            <div class="kpi"><div class="v">${esc(fmt.num(meta.snapshot_count))}</div><div class="l">Daily snapshots</div><div class="d">since ${esc(fmt.date(meta.first_snapshot))}</div></div>
            <div class="kpi"><div class="v">${esc(fmt.num(meta.items))}</div><div class="l">Items in window</div><div class="d">${esc(fmt.num(meta.prs))} PRs · ${esc(fmt.num(meta.history_events))} events</div></div>
            <div class="kpi"><div class="v">${esc(fmt.num(meta.duration_s))}s</div><div class="l">Run time</div><div class="d">${esc(fmt.num(meta.graphql_cost))} API points · ${esc(fmt.num(meta.rate_remaining))} left</div></div>
          </div>
          ${m && m.sync.stale ? `<div class="error" style="margin-top:10px">Data is ${esc(Math.round(m.sync.staleHours))} hours old. Check the <a href="${esc(actionsUrl)}" target="_blank" rel="noopener">workflow runs</a>.</div>` : ""}
          ${(meta.warnings || []).length ? `<div class="notice" style="margin-top:10px"><b>Warnings from the last run</b><ul style="margin:6px 0 0 18px">${meta.warnings.map((w) => `<li class="small">${esc(w)}</li>`).join("")}</ul></div>` : ""}`
          : `<div class="notice">No <code>data/latest.json</code> yet. Run the sync once from the Actions tab (or the button below); the first run backfills from ${esc(state.settings.quad_start)}.</div>`}
          <div class="row" style="margin-top:12px">
            <button class="btn primary" id="runSyncBtn" ${state.demo ? "disabled" : ""}>Run sync now</button>
            <button class="btn" id="runFullBtn" ${state.demo ? "disabled" : ""}>Full re-sync</button>
            ${state.demo ? `<span class="faint small">disabled in demo mode</span>` : `<a class="small" href="${esc(actionsUrl)}" target="_blank" rel="noopener">Workflow runs ↗</a>`}
            <span id="runStatus" class="small muted"></span>
          </div>
          <p class="faint small" style="margin:10px 0 0">The workflow runs every day at 10:00 UTC. Nothing to do unless this panel goes stale.</p>
        </div>
        <div class="card">
          <h2>Connection</h2>
          <div class="field"><label>Repository</label><input type="text" id="cfgRepo" value="${esc(state.cfg.repo)}" ${state.demo ? "disabled" : ""}></div>
          <div class="field"><label>Branch</label><input type="text" id="cfgBranch" value="${esc(state.cfg.branch)}" placeholder="auto (default branch)" ${state.demo ? "disabled" : ""}></div>
          <div class="field"><label>Token (stored only in this browser)</label><input type="password" id="cfgToken" value="${esc(state.cfg.token)}" ${state.demo ? "disabled" : ""}></div>
          <div class="row"><button class="btn" id="cfgSave" ${state.demo ? "disabled" : ""}>Save &amp; reload</button><button class="btn danger" id="cfgClear">Sign out</button>${state.demo ? `<a class="small" href="index.html">Leave demo mode</a>` : ""}</div>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="row spread"><h2>Roster</h2><div class="row"><button class="btn small" id="addPersonBtn">+ Add person</button><button class="btn primary small" id="saveRosterBtn" ${state.demo ? "disabled" : ""}>Save roster to repo</button></div></div>
        <div class="tbl-wrap" style="max-height:none"><table class="roster-table"><thead><tr><th>Name</th><th>GitHub handle</th><th>On team since</th><th>Active</th><th>Notes</th><th></th></tr></thead><tbody id="rosterBody"></tbody></table></div>
        ${unrostered.length ? `<div class="section-title">Seen in the data but not on the roster</div><div class="chips pills" id="unrostered">${unrostered.map((u) => `<button class="chip" data-login="${esc(u.login)}" title="${esc(u.items)} items, ${esc(u.prs)} PRs">+ ${esc(u.login)} <span class="faint">(${esc(u.items)}i · ${esc(u.prs)}pr)</span></button>`).join("")}</div>` : ""}
        <p class="faint small" style="margin:10px 0 0">Metrics before a person's start date are shown as "—". Removing someone deletes their row only; the synced data keeps everyone, so adding them back restores history. People assigned together on one item are both credited.</p>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="row spread"><h2>Flag thresholds</h2><button class="btn primary small" id="saveSettingsBtn" ${state.demo ? "disabled" : ""}>Save settings to repo</button></div>
        <div class="thresholds">${thresholds.map(([k, label]) => `<div class="field"><label>${esc(label)}</label><input type="number" step="any" data-flag="${esc(k)}" value="${esc(F[k] == null ? "" : F[k])}"></div>`).join("")}</div>
        <p class="faint small" style="margin:10px 0 0">Edits apply immediately in this view; saving writes <code>config/settings.json</code> so they persist and the next sync picks them up.</p>
      </div>
      <div class="card" style="margin-top:14px">
        <details><summary>How the numbers are defined</summary>
          <ul class="defs">
            <li><b>Completed</b>: an item whose Status became Done, whose issue was closed as completed, or whose PR was merged — credited to the sprint in which that happened, to everyone assigned.</li>
            <li><b>Planned</b>: items whose Sprint field pointed at the sprint at its start or its end (or now, for the sprint in progress). Project 84's "DBA/DBB" iterations are mapped to the 7.x sprint containing their midpoint.</li>
            <li><b>Not finished / carried over</b>: planned items not completed by the sprint's end; "carried over" means the Sprint field now points at a later sprint. Exact from the first daily snapshot; for earlier sprints an item that was started during the sprint and now sits in a later one is inferred (~).</li>
            <li><b>Cycle time</b>: first Status → In Progress to the Done transition, from the issue timeline. Items that never passed through In Progress have no cycle time.</li>
            <li><b>Review turnaround</b>: from the review request to that reviewer's first review. Team review requests can't be attributed and are ignored.</li>
            <li><b>Quiet</b>: no PRs opened/merged, reviews submitted, or status changes on their items in the last N working days (as of the last sync). Comments and commits are not synced, so a quiet flag is a prompt to look, not a verdict.</li>
            <li><b>Not included</b>, by design: commit counts, lines of code, work outside projects 13 and 84.</li>
          </ul>
        </details>
      </div>`;
    renderRosterRows();
    $("#addPersonBtn").addEventListener("click", () => { state.roster.people.push({ name: "", login: "", since: new Date().toISOString().slice(0, 10), active: true, notes: "" }); state.dirtyRoster = true; renderRosterRows(); });
    $("#saveRosterBtn").addEventListener("click", saveRoster);
    $("#saveSettingsBtn").addEventListener("click", saveSettings);
    $$("#unrostered .chip").forEach((b) => b.addEventListener("click", () => { state.roster.people.push({ name: b.dataset.login, login: b.dataset.login, since: state.settings.quad_start, active: true, notes: "" }); state.dirtyRoster = true; recomputeFromRoster(); renderAdmin(); }));
    $$("[data-flag]").forEach((inp) => inp.addEventListener("change", () => { const v = parseFloat(inp.value); if (!isNaN(v)) { state.settings.flags[inp.dataset.flag] = v; compute(); } }));
    $("#runSyncBtn").addEventListener("click", () => runSync(false));
    $("#runFullBtn").addEventListener("click", () => runSync(true));
    $("#cfgSave").addEventListener("click", () => { state.cfg.repo = $("#cfgRepo").value.trim(); state.cfg.branch = $("#cfgBranch").value.trim(); state.cfg.token = $("#cfgToken").value.trim(); saveCfg(); location.reload(); });
    $("#cfgClear").addEventListener("click", () => { try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } location.href = location.pathname; });
  }
  function renderRosterRows() {
    const body = $("#rosterBody");
    body.innerHTML = state.roster.people.map((p, i) => `<tr>
      <td><input type="text" data-i="${i}" data-k="name" value="${esc(p.name)}" placeholder="Full name"></td>
      <td><input type="text" data-i="${i}" data-k="login" value="${esc(p.login)}" placeholder="github-handle" class="mono"></td>
      <td><input type="date" data-i="${i}" data-k="since" value="${esc(p.since || "")}"></td>
      <td><input type="checkbox" data-i="${i}" data-k="active" ${p.active !== false ? "checked" : ""}></td>
      <td><input type="text" data-i="${i}" data-k="notes" value="${esc(p.notes || "")}" placeholder="optional"></td>
      <td><button class="btn small danger" data-remove="${i}">Remove</button></td></tr>`).join("");
    $$("input", body).forEach((inp) => inp.addEventListener("change", () => {
      const p = state.roster.people[+inp.dataset.i];
      p[inp.dataset.k] = inp.type === "checkbox" ? inp.checked : inp.value.trim();
      state.dirtyRoster = true;
      recomputeFromRoster();
    }));
    $$("[data-remove]", body).forEach((b) => b.addEventListener("click", () => { state.roster.people.splice(+b.dataset.remove, 1); state.dirtyRoster = true; recomputeFromRoster(); renderAdmin(); }));
  }
  function recomputeFromRoster() { compute(); renderTopbar(); }
  async function saveRoster() {
    const bad = state.roster.people.find((p) => !p.login || !/^[A-Za-z0-9-]+$/.test(p.login));
    if (bad) return toast("Every person needs a valid GitHub handle.");
    const seen = new Set();
    for (const p of state.roster.people) { const k = p.login.toLowerCase(); if (seen.has(k)) return toast(`Duplicate handle: ${p.login}`); seen.add(k); }
    try {
      await putJson("config/roster.json", state.roster, "roster", "roster: update from dashboard");
      state.dirtyRoster = false;
      toast("Roster saved.");
    } catch (e) { toast(`Save failed: ${e.message}`, 5000); }
  }
  async function saveSettings() {
    try {
      await putJson("config/settings.json", state.settings, "settings", "settings: update thresholds from dashboard");
      toast("Settings saved.");
    } catch (e) { toast(`Save failed: ${e.message}`, 5000); }
  }
  async function runSync(full) {
    const status = $("#runStatus");
    try {
      status.textContent = "Starting…";
      await dispatchSync(full);
      const startedAt = Date.now();
      status.textContent = "Queued. Watching for completion…";
      const poll = async () => {
        const runs = await latestRuns();
        const run = runs.find((r) => Date.parse(r.created_at) >= startedAt - 60000);
        if (!run) { status.textContent = "Queued…"; return setTimeout(poll, 10000); }
        if (run.status !== "completed") { status.innerHTML = `${esc(run.status)}… <a href="${esc(run.html_url)}" target="_blank" rel="noopener">view</a>`; return setTimeout(poll, 15000); }
        if (run.conclusion === "success") { status.textContent = "Done. Reloading data…"; await loadLive(); compute(); render(); toast("Data refreshed."); }
        else status.innerHTML = `Run ${esc(run.conclusion)} — <a href="${esc(run.html_url)}" target="_blank" rel="noopener">see the log</a>`;
      };
      setTimeout(poll, 8000);
    } catch (e) {
      status.textContent = "";
      toast(`Could not start the workflow: ${e.message}`, 6000);
    }
  }

  window.addEventListener("beforeunload", (e) => { if (state.dirtyRoster && !state.demo) { e.preventDefault(); e.returnValue = ""; } });
  boot();
})();
