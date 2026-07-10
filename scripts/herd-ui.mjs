#!/usr/bin/env node
// herd-ui.mjs — a dependency-free local web dashboard for the herd. Headless
// workers (`-p` CLIs) leave an operator blind; this serves one inline HTML page
// over node:http that renders fleet state from the SAME adapter-agnostic sources
// the supervisor writes: the event stream (.ratchet/events.jsonl), the state
// file (.ratchet/herd-state.json), and the escalation log
// (.ratchet/herd-escalations.md). Worker rows, attempt/claim gauges, and PR
// links come only from the state file and event stream — never from parsing an
// adapter's log format. Raw logs are display-only drill-down, streamed
// incrementally to the browser. Server-sent events push updates so the page
// never needs a manual reload. Binds localhost only; nothing leaves the machine.
// Zero dependencies: node:http, node:fs, node:child_process (git remote lookup).

import { createServer as httpCreateServer } from "node:http";
import { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { readState, STATE_FILE, EVENTS_FILE, ESCALATIONS_FILE } from "./herd-survey.mjs";
import { DEFAULTS, loadConfig, HerdConfigError } from "./herd.mjs";
import { defaultAvatarFor } from "./herd-avatars.mjs";
import { TERMINAL_STATUS } from "./herd-monitor.mjs";

export const DEFAULT_PORT = 4780;

// The one-line hint shown when there is nothing to display, so an empty
// dashboard reads as "not started yet" rather than "broken".
export const EMPTY_HINT = "No herd activity yet — start it with `node scripts/herd.mjs run`.";

// --- data sources (all tolerant: a missing/corrupt file is emptiness) --------

// Read the event stream as an array of parsed objects. A missing file is [];
// a malformed line is skipped, never fatal — the dashboard degrades to whatever
// it can parse rather than crashing on one bad append.
export function readEvents(path = EVENTS_FILE) {
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip a torn or partial line — a poll may be mid-append */
    }
  }
  return out;
}

// Parse the human-readable escalation log into structured, newest-first blocks.
// The format is the one herd-survey.mjs writes: a `## <ts> — issue #<N>` heading
// followed by `- What happened:`, `- Log file:`, `- Suggested action:` lines. A
// missing file is []; anything unrecognised is ignored, never fatal.
export function parseEscalations(mdOrPath = ESCALATIONS_FILE, { isPath = true } = {}) {
  let md = mdOrPath;
  if (isPath) {
    if (!existsSync(mdOrPath)) return [];
    try {
      md = readFileSync(mdOrPath, "utf8");
    } catch {
      return [];
    }
  }
  const blocks = [];
  const re = /^##\s+(\S+)\s+—\s+issue #(\d+)\s*$/gim;
  const heads = [];
  let m;
  while ((m = re.exec(md)) !== null) heads.push({ ts: m[1], issue: Number(m[2]), index: m.index, end: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const body = md.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].index : md.length);
    const field = (label) => {
      const fm = new RegExp(`^-\\s*${label}:\\s*(.*)$`, "im").exec(body);
      return fm ? fm[1].trim() : null;
    };
    blocks.push({
      ts: heads[i].ts,
      issue: heads[i].issue,
      what: field("What happened") || "",
      logFile: field("Log file"),
      action: field("Suggested action"),
    });
  }
  return blocks.reverse(); // newest escalations first, above the worker list
}

// --- derivations (pure) ------------------------------------------------------

// The timestamp the current attempt on `issue` began: the most recent dispatch
// or resume event for it. Claim age is measured from here. Null when the event
// stream carries no start for the issue (e.g. a hand-seeded state entry).
export function latestClaimTs(events, issue) {
  let ts = null;
  for (const e of events) {
    if (Number(e.issue) !== Number(issue)) continue;
    if (e.event !== "dispatch" && e.event !== "resume") continue;
    if (ts === null || String(e.ts) > ts) ts = String(e.ts);
  }
  return ts;
}

// Build a clickable PR URL from an "owner/repo" slug, or null when the slug is
// unknown (git remote absent) so the link simply does not render.
export function prUrl(repoSlug, prNumber) {
  if (!repoSlug || prNumber == null) return null;
  return `https://github.com/${repoSlug}/pull/${prNumber}`;
}

// Parse "owner/repo" out of a git remote URL (https or ssh forms), or null.
export function resolveRepoSlug(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return null;
  const s = remoteUrl.trim().replace(/\.git$/, "");
  const m =
    /github\.com[/:]([^/]+\/[^/]+?)$/.exec(s) || // https://github.com/o/r or git@github.com:o/r
    /^([^/]+\/[^/]+)$/.exec(s); // already a bare slug
  return m ? m[1] : null;
}

// Best-effort read of the origin remote URL. Read-only, tolerant: a repo with no
// remote (or no git) yields null and the dashboard just omits PR links.
export function gitOriginUrl(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

// One worker view-row per state entry, adapter-agnostic — every field comes from
// the state file and the event stream, never from an adapter's log. claimStartTs
// is sent to the browser so it can tick the age locally; claimAgeSeconds is the
// server-side snapshot at `now` (handy for the API and tests).
export function buildWorkers({ state, events, config, now = Date.now(), repoSlug = null }) {
  const rows = [];
  for (const [issueStr, e] of Object.entries(state || {})) {
    const issue = Number(issueStr);
    const claimStartTs = latestClaimTs(events, issue);
    const claimAgeSeconds =
      claimStartTs !== null ? Math.max(0, Math.floor((now - Date.parse(claimStartTs)) / 1000)) : null;
    // Avatar the browser should try first: the adapter's own `avatar` when it
    // declared a non-empty one, else null so the row shows its bundled default.
    // The default is deterministic per adapter name (same mascot every restart)
    // and always a valid data URI, so it doubles as the load-failure fallback.
    const adapterCfg = config.adapters ? config.adapters[e.adapter] : undefined;
    const avatar =
      adapterCfg && typeof adapterCfg.avatar === "string" && adapterCfg.avatar !== "" ? adapterCfg.avatar : null;
    const status = e.status ?? "unknown";
    const claimActive = e.pid != null && !TERMINAL_STATUS.has(status);
    rows.push({
      issue,
      status,
      adapter: e.adapter ?? null,
      avatar,
      defaultAvatar: defaultAvatarFor(e.adapter ?? null),
      pid: e.pid ?? null,
      attempts: e.attempts ?? 0,
      reworkCap: config.reworkCap,
      claimStartTs,
      claimAgeSeconds,
      claimActive,
      claimTimeoutSeconds: config.claimTimeoutSeconds,
      pr: e.pr ?? null,
      prUrl: prUrl(repoSlug, e.pr ?? null),
      logFile: e.logFile ?? null,
    });
  }
  rows.sort((a, b) => a.issue - b.issue);
  return rows;
}

// The full dashboard payload. Never throws: every source is read tolerantly, so
// missing state/events/escalations yield an empty snapshot carrying `hint`.
export function readSnapshot({
  statePath = STATE_FILE,
  eventsPath = EVENTS_FILE,
  escalationsPath = ESCALATIONS_FILE,
  config,
  now = Date.now(),
  repoSlug = null,
} = {}) {
  const state = readState(statePath);
  const events = readEvents(eventsPath);
  const escalations = parseEscalations(escalationsPath);
  const workers = buildWorkers({ state, events, config, now, repoSlug });
  const hint = workers.length === 0 && escalations.length === 0 ? EMPTY_HINT : null;
  return { workers, escalations, hint };
}

// A change key that ignores the ever-advancing clock, so the live stream pushes
// only when the underlying data actually changed — not once per second because
// an age ticked. Ages are recomputed by the browser from claimStartTs.
export function snapshotKey(snapshot) {
  const workers = snapshot.workers.map(({ claimAgeSeconds, ...rest }) => rest);
  return JSON.stringify({ workers, escalations: snapshot.escalations, hint: snapshot.hint });
}

// --- incremental log tail ----------------------------------------------------

// Read only the bytes of `path` after `position`. Never re-reads the whole file:
// when position === size nothing is read. A file shorter than `position` was
// truncated or rotated, so it restarts from 0. Returns the new bytes plus the
// next position to resume from. A missing file is empty, position unchanged.
export function tailFrom(path, position = 0) {
  if (!path || !existsSync(path)) return { data: "", position, size: 0, missing: true };
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return { data: "", position, size: 0, missing: true };
  }
  try {
    const size = fstatSync(fd).size;
    let from = position;
    if (from > size) from = 0; // truncated/rotated — resume from the start
    if (from === size) return { data: "", position: size, size };
    const len = size - from;
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, from);
    return { data: buf.toString("utf8", 0, read), position: from + read, size };
  } finally {
    closeSync(fd);
  }
}

// --- config ------------------------------------------------------------------

// The two numbers the gauges need (reworkCap, claimTimeoutSeconds). The real
// config if present; otherwise framework defaults, so the dashboard still runs
// before `herd init` has ever been called.
export function loadConfigOrDefaults(path) {
  try {
    return path ? loadConfig(path) : loadConfig();
  } catch (e) {
    if (e instanceof HerdConfigError) return { ...DEFAULTS };
    throw e;
  }
}

// --- HTTP server -------------------------------------------------------------

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// Build (but do not listen on) the dashboard server. All paths and the clock are
// injectable so the whole thing runs offline against temp fixtures in tests.
// pollMs drives both the snapshot-diff stream and the log tail cadence.
export function createDashboardServer({
  statePath = STATE_FILE,
  eventsPath = EVENTS_FILE,
  escalationsPath = ESCALATIONS_FILE,
  config = { ...DEFAULTS },
  repoSlug = null,
  now = Date.now,
  pollMs = 1000,
} = {}) {
  const snap = () => readSnapshot({ statePath, eventsPath, escalationsPath, config, now: now(), repoSlug });

  const server = httpCreateServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("method not allowed");
      return;
    }

    if (url.pathname === "/") {
      const html = PAGE_HTML;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    if (url.pathname === "/api/snapshot") {
      sendJson(res, 200, snap());
      return;
    }

    // Live snapshot stream: push the current snapshot, then push again only when
    // the data changes (clock-independent key), so the page updates without a
    // manual reload and without a push every second.
    if (url.pathname === "/api/stream") {
      res.writeHead(200, SSE_HEADERS);
      let lastKey = null;
      const tick = () => {
        const snapshot = snap();
        const key = snapshotKey(snapshot);
        if (key !== lastKey) {
          lastKey = key;
          res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        }
      };
      tick();
      const timer = setInterval(tick, pollMs);
      req.on("close", () => clearInterval(timer));
      return;
    }

    // Live log tail for exactly one worker. Only the requested issue's log is
    // read, and each poll reads incrementally from the last byte position — never
    // a full re-read. The logFile is resolved from the live state each tick, so a
    // log that appears after selection starts streaming on its own.
    if (url.pathname === "/api/log") {
      const issue = Number(url.searchParams.get("issue"));
      if (!Number.isInteger(issue)) {
        sendJson(res, 400, { error: "issue query parameter required" });
        return;
      }
      res.writeHead(200, SSE_HEADERS);
      let position = 0;
      let announcedMissing = false;
      const tick = () => {
        const state = readState(statePath);
        const entry = state[String(issue)];
        const logFile = entry && entry.logFile ? entry.logFile : null;
        if (!logFile) {
          if (!announcedMissing) {
            announcedMissing = true;
            res.write(`event: note\ndata: ${JSON.stringify(`no log file recorded for issue #${issue} yet`)}\n\n`);
          }
          return;
        }
        announcedMissing = false;
        const { data, position: next } = tailFrom(logFile, position);
        position = next;
        if (data) res.write(`event: log\ndata: ${JSON.stringify(data)}\n\n`);
      };
      tick();
      const timer = setInterval(tick, pollMs);
      req.on("close", () => clearInterval(timer));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  return server;
}

// Listen on `port`, resolving to the bound port. Rejects with a one-line,
// port-naming error on EADDRINUSE so the CLI can print it and exit non-zero
// without a stack trace. Any other listen error rejects verbatim.
export function listenOrFail(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener("listening", onListening);
      if (e.code === "EADDRINUSE") reject(new Error(`herd-ui: port ${port} is already in use.`));
      else reject(e);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

// Parse `--port <n>`; falls back to DEFAULT_PORT when absent or not a positive
// integer (a bad flag never crashes the launch — it uses the default).
export function parsePort(argv) {
  const i = argv.indexOf("--port");
  if (i >= 0) {
    const n = Number(argv[i + 1]);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return DEFAULT_PORT;
}

// The testable entrypoint: resolve config + repo slug, build the server, bind
// it, and announce the URL. Returns the server and the bound port. Throws (via
// listenOrFail) on a port clash so the CLI wrapper can exit non-zero.
export async function run(argv, { log = console.log, cwd = process.cwd() } = {}) {
  const port = parsePort(argv);
  const config = loadConfigOrDefaults();
  const repoSlug = resolveRepoSlug(gitOriginUrl(cwd));
  const server = createDashboardServer({ config, repoSlug });
  const bound = await listenOrFail(server, port);
  log(`Herd dashboard on http://localhost:${bound}  (Ctrl-C to stop)`);
  return { server, port: bound };
}

// The single inline page: no external requests, no build step. It fetches the
// snapshot, subscribes to the live stream, renders escalations inside a
// toggleable side panel beside the worker list, and streams one selected
// worker's log. Ages tick locally from claimStartTs so the server pushes only
// on real change.
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Herd dashboard</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fafafa; --card:#fff; --line:#e2e2e2; --muted:#666; --accent:#0969da; --warn:#b35900; --over:#cf222e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6e6e6; --bg:#0d1117; --card:#161b22; --line:#30363d; --muted:#8b949e; --accent:#58a6ff; --warn:#d29922; --over:#f85149; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; }
  header h1 { font-size:16px; margin:0; }
  header .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); display:inline-block; }
  header .dot.live { background:#2da44e; }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  .hint { color:var(--muted); padding:40px 0; text-align:center; }
  .layout { display:flex; gap:16px; align-items:flex-start; }
  .fleet { flex:1 1 auto; min-width:0; }
  .fleet-toolbar { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
  .errtoggle { display:inline-flex; align-items:center; gap:6px; background:var(--card); border:1px solid var(--line); border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; color:var(--fg); }
  .errtoggle:hover { border-color:var(--accent); }
  .errcount { background:var(--over); color:#fff; border-radius:10px; padding:1px 7px; font-size:12px; font-weight:600; min-width:20px; text-align:center; }
  .errcount.zero { background:var(--muted); }
  .errpanel { flex:0 0 360px; background:var(--card); border:1px solid var(--line); border-radius:6px; overflow:auto; max-height:calc(100vh - 120px); align-self:stretch; }
  .errpanel-head { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid var(--line); }
  .errpanel-head h2 { font-size:14px; margin:0; }
  .errpanel-head .errclose { background:none; border:none; cursor:pointer; font-size:16px; color:var(--muted); padding:2px 6px; border-radius:4px; }
  .errpanel-head .errclose:hover { background:color-mix(in srgb, var(--fg) 10%, transparent); }
  .escalations { padding:10px 14px; }
  .esc { border:1px solid var(--over); border-left-width:4px; border-radius:6px; padding:10px 14px; margin-bottom:8px; }
  .esc .top { font-weight:600; }
  .esc .what { margin:4px 0; }
  .esc .meta { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  tr.worker { cursor:pointer; }
  tr.worker:hover { background:color-mix(in srgb, var(--accent) 8%, transparent); }
  tr.worker.sel { background:color-mix(in srgb, var(--accent) 16%, transparent); }
  .gauge.warn { color:var(--warn); }
  .gauge.over { color:var(--over); font-weight:600; }
  .status { font-variant:small-caps; }
  .adapter { display:inline-flex; align-items:center; gap:8px; }
  /* Fixed dimension so a large source image can never break the row layout;
     object-fit crops rather than stretches, and the shape stays a 20px circle. */
  img.avatar { width:20px; height:20px; flex:none; border-radius:50%; object-fit:cover; background:var(--line); }
  a { color:var(--accent); }
  .logpane { margin-top:18px; }
  .logpane h2 { font-size:14px; margin:0 0 6px; }
  .logsearch { width:100%; padding:6px 10px; border:1px solid var(--line); border-radius:6px; font:inherit; color:var(--fg); background:var(--card); margin-bottom:8px; }
  .logsearch:focus { outline:none; border-color:var(--accent); }
  pre.log { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:12px; max-height:360px; overflow:auto; white-space:pre-wrap; word-break:break-word; margin:0; font:12px/1.5 ui-monospace, monospace; }
  .empty { color:var(--muted); }
  .lognomatch { color:var(--muted); padding:12px; }
</style>
</head>
<body>
<header>
  <h1>Herd dashboard</h1>
  <span><span class="dot" id="livedot"></span> <span id="livetext" class="empty">connecting…</span></span>
</header>
<main>
  <div class="layout" id="layout">
    <div class="fleet" id="fleet">
      <div class="fleet-toolbar">
        <button id="errtoggle" class="errtoggle" type="button"><span>Errors</span> <span id="errcount" class="errcount zero">0</span></button>
      </div>
      <div id="workers"></div>
    </div>
    <aside class="errpanel" id="errpanel" hidden>
      <div class="errpanel-head">
        <h2>Errors &amp; escalations</h2>
        <button id="errclose" class="errclose" type="button" aria-label="Close error panel">\u2715</button>
      </div>
      <div class="escalations" id="escalations"></div>
    </aside>
  </div>
  <div class="logpane" id="logpane" hidden>
    <h2 id="logtitle"></h2>
    <input type="search" id="logsearch" class="logsearch" placeholder="Filter log lines…" autocomplete="off">
    <div id="lognomatch" class="lognomatch" hidden>No matches.</div>
    <pre class="log" id="log"></pre>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let selected = null, logSource = null, logBuffer = "", panelOpen = false, snapshot = { workers: [], escalations: [], hint: null };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

  // Swap a worker's avatar to its bundled default when the adapter's own image
  // fails to load (missing file, bad URL), so the row shows a mascot rather than
  // a broken-image icon. onerror is cleared first: the default is an inline data
  // URI that always loads, so this fires at most once and never loops.
  window.avatarFallback = function (img) {
    img.onerror = null;
    img.src = img.dataset.default;
  };
  // The image the browser tries first (adapter avatar, else the bundled
  // default), with the always-loadable default parked in data-default as the
  // fallback target. Rendered at a fixed size by CSS.
  function avatarImg(w) {
    const src = w.avatar || w.defaultAvatar;
    return '<img class="avatar" alt="" src="' + esc(src) + '" data-default="' + esc(w.defaultAvatar) +
      '" onerror="avatarFallback(this)">';
  }

  function ageText(w) {
    if (w.claimStartTs == null) return "—";
    const secs = Math.max(0, Math.floor((Date.now() - Date.parse(w.claimStartTs)) / 1000));
    const t = secs >= 60 ? Math.floor(secs / 60) + "m" + (secs % 60) + "s" : secs + "s";
    if (w.claimActive) {
      const cls = secs > w.claimTimeoutSeconds ? "over" : secs > w.claimTimeoutSeconds * 0.75 ? "warn" : "";
      return '<span class="gauge ' + cls + '">' + t + " / " + w.claimTimeoutSeconds + "s</span>";
    }
    return '<span class="gauge">' + t + "</span>";
  }
  function attemptsText(w) {
    const cls = w.attempts >= w.reworkCap ? "over" : w.attempts >= w.reworkCap ? "warn" : "";
    return '<span class="gauge ' + cls + '">' + w.attempts + " / " + w.reworkCap + "</span>";
  }

  function renderEscalations() {
    const el = $("escalations");
    if (!snapshot.escalations.length) { el.innerHTML = '<div class="empty">No errors.</div>'; return; }
    el.innerHTML = snapshot.escalations.map((e) =>
      '<div class="esc"><div class="top">issue #' + esc(e.issue) + "</div>" +
      '<div class="what">' + esc(e.what) + "</div>" +
      '<div class="meta">' + esc(e.ts) + (e.action ? " · " + esc(e.action) : "") + "</div></div>"
    ).join("");
  }

  function renderErrToggle() {
    const count = snapshot.escalations.length;
    const badge = $("errcount");
    badge.textContent = String(count);
    badge.classList.toggle("zero", count === 0);
  }

  function applyPanel() {
    $("errpanel").hidden = !panelOpen;
  }

  function renderWorkers() {
    const host = $("workers");
    if (!snapshot.workers.length) {
      host.innerHTML = snapshot.hint ? '<div class="hint">' + esc(snapshot.hint) + "</div>" : '<div class="hint">No workers.</div>';
      return;
    }
    const rows = snapshot.workers.map((w) => {
      const pr = w.prUrl ? '<a href="' + esc(w.prUrl) + '" target="_blank" rel="noopener">#' + esc(w.pr) + "</a>"
        : (w.pr != null ? "#" + esc(w.pr) : '<span class="empty">—</span>');
      return '<tr class="worker' + (w.issue === selected ? " sel" : "") + '" data-issue="' + w.issue + '">' +
        "<td>#" + esc(w.issue) + "</td>" +
        '<td class="status">' + esc(w.status) + "</td>" +
        '<td><span class="adapter">' + avatarImg(w) + "<span>" + esc(w.adapter || "—") + "</span></span></td>" +
        "<td>" + attemptsText(w) + "</td>" +
        "<td>" + ageText(w) + "</td>" +
        "<td>" + pr + "</td></tr>";
    }).join("");
    host.innerHTML = '<table><thead><tr><th>Issue</th><th>Status</th><th>Adapter</th><th>Attempts</th><th>Age</th><th>PR</th></tr></thead><tbody>' + rows + "</tbody></table>";
    host.querySelectorAll("tr.worker").forEach((tr) => tr.addEventListener("click", () => select(Number(tr.dataset.issue))));
  }

  function select(issue) {
    if (selected === issue) return;
    selected = issue;
    if (logSource) { logSource.close(); logSource = null; }
    const pane = $("logpane");
    pane.hidden = false;
    $("logtitle").textContent = "Log — issue #" + issue;
    $("logsearch").value = "";
    logBuffer = "";
    renderLog();
    renderWorkers();
    logSource = new EventSource("/api/log?issue=" + issue);
    logSource.addEventListener("log", (ev) => { logBuffer += JSON.parse(ev.data); renderLog(); });
    logSource.addEventListener("note", (ev) => { logBuffer = JSON.parse(ev.data); renderLog(); });
  }

  // Re-render the log pane from logBuffer, applying the active search query.
  // An empty query shows the full tail; a non-empty query filters to matching
  // lines (case-insensitive); zero matches shows a "no matches" message, never
  // a blank pane. New tailed lines arrive via the log/note handlers above, which
  // append to logBuffer and call renderLog, so the filter is always respected.
  function renderLog() {
    const q = $("logsearch").value.trim().toLowerCase();
    const pre = $("log");
    const nomatch = $("lognomatch");
    if (!q) {
      pre.hidden = false;
      pre.textContent = logBuffer;
      nomatch.hidden = true;
      pre.scrollTop = pre.scrollHeight;
      return;
    }
    const matched = logBuffer.split("\\n").filter((l) => l.toLowerCase().includes(q));
    if (matched.length === 0 && logBuffer.length > 0) {
      pre.hidden = true;
      nomatch.hidden = false;
    } else {
      pre.hidden = false;
      pre.textContent = matched.join("\\n");
      nomatch.hidden = true;
      pre.scrollTop = pre.scrollHeight;
    }
  }

  $("logsearch").addEventListener("input", renderLog);

  function render() { renderErrToggle(); renderEscalations(); renderWorkers(); }

  $("errtoggle").addEventListener("click", () => { panelOpen = !panelOpen; applyPanel(); });
  $("errclose").addEventListener("click", () => { panelOpen = false; applyPanel(); });

  const stream = new EventSource("/api/stream");
  stream.addEventListener("snapshot", (ev) => {
    snapshot = JSON.parse(ev.data);
    $("livedot").classList.add("live");
    $("livetext").textContent = "live";
    $("livetext").classList.remove("empty");
    render();
  });
  stream.onerror = () => { $("livedot").classList.remove("live"); $("livetext").textContent = "reconnecting…"; };

  // Tick ages locally once a second without waiting on a server push.
  setInterval(() => { if (snapshot.workers.length) renderWorkers(); }, 1000);
</script>
</body>
</html>`;

// --- CLI ---------------------------------------------------------------------

const isMain =
  process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  run(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
