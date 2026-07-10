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
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { join } from "node:path";
import { readState, STATE_FILE, EVENTS_FILE, ESCALATIONS_FILE, resolveRepoRoot, ratchetPaths } from "./herd-survey.mjs";
import { DEFAULTS, CONFIG_PATH, loadConfig, HerdConfigError } from "./herd.mjs";
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

// The usage fields a worker-exit event may carry (0075). Kept in sync with
// herd.mjs's USAGE_FIELDS by shape, not import, so the dashboard stays a
// read-only consumer of whatever the supervisor already wrote to the stream.
const USAGE_KEYS = Object.freeze(["costUsd", "tokensIn", "tokensOut"]);

// A finite number stays itself; anything else (null from an unreadable log, a
// string, NaN, Infinity, undefined) normalises to null so no row or total ever
// carries a NaN/undefined into the browser.
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// True when an event carries any usage field at all — even valued null. A
// declared-but-unreadable usage (log crashed/truncated) writes the keys as
// null, and that exit is still the issue's most recent usage reading, so it
// counts as usage-bearing rather than being skipped for an older event.
export function isUsageBearing(e) {
  return e != null && USAGE_KEYS.some((k) => k in e);
}

// The usage numbers from the most recent usage-bearing event for `issue`, or
// null when no event for it carried usage (an adapter with no `usage` mapping,
// or usage not yet emitted). Each returned field is a number or null; a field
// absent from the winning event is normalised to null so every row exposes all
// three keys. "Most recent" is the lexicographically-greatest ISO ts, matching
// latestClaimTs — the stream's ts is always an ISO string.
export function latestUsage(events, issue) {
  let winner = null;
  let winnerTs = null;
  for (const e of events || []) {
    if (Number(e.issue) !== Number(issue)) continue;
    if (!isUsageBearing(e)) continue;
    const ts = String(e.ts);
    if (winnerTs === null || ts > winnerTs) {
      winnerTs = ts;
      winner = e;
    }
  }
  if (winner === null) return null;
  return {
    costUsd: numOrNull(winner.costUsd),
    tokensIn: numOrNull(winner.tokensIn),
    tokensOut: numOrNull(winner.tokensOut),
  };
}

// Fleet totals across worker rows: each field is the sum of its finite values,
// or null when no worker contributed a finite number for it (so the header
// renders a `—`, never 0, when nothing has usage). A null field on a row simply
// does not add to that total — a worker without usage never drags a sum down.
export function fleetUsage(workers) {
  let costUsd = null;
  let tokensIn = null;
  let tokensOut = null;
  const add = (acc, v) => (typeof v === "number" && Number.isFinite(v) ? (acc || 0) + v : acc);
  for (const w of workers || []) {
    costUsd = add(costUsd, w.costUsd);
    tokensIn = add(tokensIn, w.tokensIn);
    tokensOut = add(tokensOut, w.tokensOut);
  }
  return { costUsd, tokensIn, tokensOut };
}

// The timestamp of the newest heartbeat event, or null when the stream carries
// none — the supervisor has never been seen. Heartbeats are fleet-wide and
// carry no issue, so this scans only by event type.
export function latestHeartbeatTs(events) {
  let ts = null;
  for (const e of events) {
    if (e.event !== "heartbeat") continue;
    if (ts === null || String(e.ts) > ts) ts = String(e.ts);
  }
  return ts;
}

// How long the dashboard tolerates silence before it alarms, derived from the
// poll interval: a heartbeat lands every `pollSeconds`, so missing more than a
// couple of polls means the supervisor has stopped. The factor gives one whole
// missed poll of slack past that before the banner fires, so a single slow poll
// never cries wolf.
export const HEARTBEAT_SILENCE_FACTOR = 2.5;
export function heartbeatThresholdSeconds(pollSeconds) {
  const base = Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds : DEFAULTS.pollSeconds;
  return Math.max(1, Math.round(base * HEARTBEAT_SILENCE_FACTOR));
}

// Classify supervisor liveness from the last heartbeat: "unseen" when there is
// none at all, "silent" when the newest is older than the threshold, "live"
// otherwise. Pure and clock-injectable so the server, the API, and the browser
// tick all reach the same verdict from the same inputs.
export function heartbeatStatus({ lastHeartbeatTs, thresholdSeconds, now = Date.now() }) {
  const parsed = lastHeartbeatTs ? Date.parse(lastHeartbeatTs) : NaN;
  // No heartbeat, or one whose timestamp will not parse, is "never seen" — never
  // silently reported as live with a nonsense age.
  if (!Number.isFinite(parsed)) return { state: "unseen", ageSeconds: null };
  const ageSeconds = Math.max(0, Math.floor((now - parsed) / 1000));
  return { state: ageSeconds > thresholdSeconds ? "silent" : "live", ageSeconds };
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

// Lifecycle groups the dashboard buckets rows into, in display order: live
// workers first, then work awaiting human review, then anything escalated for a
// human, then finished/terminal rows, and finally a catch-all so a status with
// no mapping is still visible rather than silently dropped. Exported so the
// browser renders the same ordered, labelled sections the server classifies to.
export const LIFECYCLE_GROUPS = Object.freeze([
  { key: "live", label: "Live" },
  { key: "awaiting-review", label: "Awaiting review" },
  { key: "escalated", label: "Escalated" },
  { key: "terminal", label: "Terminal" },
  { key: "other", label: "Other" },
]);

// Status → lifecycle group. Covers the full status vocabulary the supervisor
// writes (dispatch/monitor/verify/survey); "stale-claim" is grouped as escalated
// because, like an escalation, it needs a human to clear it. Anything unmapped
// falls to "other" so a new or unexpected status never vanishes from the table.
const STATUS_GROUP = Object.freeze({
  working: "live",
  dispatched: "live",
  resumed: "live",
  reworking: "live",
  "awaiting-verification": "awaiting-review",
  "ready-for-review": "awaiting-review",
  "in-review": "awaiting-review",
  escalated: "escalated",
  "verify-escalated": "escalated",
  "dispatch-failed": "escalated",
  "stale-claim": "escalated",
  dead: "terminal",
  "pr-concluded": "terminal",
});
export function lifecycleGroup(status) {
  return STATUS_GROUP[status] || "other";
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
    // Usage from the issue's latest usage-bearing worker-exit event (0075), or
    // all-null when it never carried usage. Each field is a number or null; the
    // browser renders null as a `—` placeholder cell.
    const usage = latestUsage(events, issue);
    rows.push({
      issue,
      status,
      group: lifecycleGroup(status),
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
      issueUrl: repoSlug ? `https://github.com/${repoSlug}/issues/${issue}` : null,
      logFile: e.logFile ?? null,
      costUsd: usage ? usage.costUsd : null,
      tokensIn: usage ? usage.tokensIn : null,
      tokensOut: usage ? usage.tokensOut : null,
    });
  }
  rows.sort((a, b) => a.issue - b.issue);
  return rows;
}

// Bucket issue-sorted worker rows into lifecycle groups for display: only
// non-empty groups, in LIFECYCLE_GROUPS order, each keeping its rows' issue
// order. A group key outside LIFECYCLE_GROUPS (should never happen — lifecycleGroup
// only emits known keys) is still appended so no row can ever disappear. Pure;
// the browser renders the identical structure so server and client never drift.
export function groupWorkers(workers) {
  const buckets = new Map();
  for (const w of workers || []) {
    const g = w.group || "other";
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push(w);
  }
  const known = LIFECYCLE_GROUPS.map((g) => g.key);
  const out = [];
  for (const { key, label } of LIFECYCLE_GROUPS) {
    const rows = buckets.get(key);
    if (rows && rows.length) out.push({ key, label, rows });
  }
  for (const key of [...buckets.keys()].filter((k) => !known.includes(k)).sort()) {
    out.push({ key, label: key, rows: buckets.get(key) });
  }
  return out;
}

// --- PR checks ----------------------------------------------------------------

const pexec = promisify(execFile);

// Aggregate per-check states into a single combined status. The `gh pr checks
// --json name,state` states are: SUCCESS, FAILURE, PENDING, SKIPPED, NEUTRAL,
// etc. Any failure makes the row "failing"; all-clear makes it "passing"; any
// pending (no failures) makes it "pending". An empty list means no checks
// have run yet — "pending". Anything unrecognised is "unknown".
export function aggregateChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return { status: "pending" };
  const states = checks.map((c) => String(c.state || "").toUpperCase());
  if (states.some((s) => s === "FAILURE" || s === "ERROR" || s === "CANCELLED" || s === "TIMED_OUT"))
    return { status: "failing" };
  if (states.some((s) => s === "PENDING" || s === "QUEUED" || s === "IN_PROGRESS" || s === "WAITING"))
    return { status: "pending" };
  if (states.every((s) => s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED" || s === ""))
    return { status: "passing" };
  return { status: "unknown" };
}

// Fetch a PR's combined checks status via `gh pr checks`. Returns
// { status, fetchedAt } on success, or { status: "unknown", fetchedAt } on any
// failure (gh missing, network error, 404). Never throws — a failed query
// surfaces as "unknown", never a broken row.
export async function defaultFetchChecks(pr, repoSlug) {
  const args = repoSlug
    ? ["pr", "checks", String(pr), "--repo", repoSlug, "--json", "name,state"]
    : ["pr", "checks", String(pr), "--json", "name,state"];
  try {
    const { stdout } = await pexec("gh", args);
    return aggregateChecks(JSON.parse(stdout));
  } catch {
    return { status: "unknown" };
  }
}

// A per-server checks cache so `gh` is called at most once per refreshMs per PR
// — not on every poll. `ensure` starts an async fetch if the PR is new or its
// cached result is older than refreshMs (idempotent — a pending fetch is never
// duplicated); `get` returns { status, fetchedAt } or undefined (not yet
// resolved). The snapshot picks up the status on the next poll after the fetch
// resolves, and the change-key pushes it to the browser via SSE.
export function createChecksCache({ fetchChecks = defaultFetchChecks, refreshMs = 30_000 } = {}) {
  const cache = new Map(); // pr number -> { status, fetchedAt, pending }

  function doFetch(n, repoSlug) {
    const existing = cache.get(n);
    if (existing) existing.pending = true;
    else cache.set(n, { status: "pending", fetchedAt: null, pending: true });
    Promise.resolve()
      .then(() => fetchChecks(n, repoSlug))
      .then((result) => {
        cache.set(n, { status: result.status || "unknown", fetchedAt: Date.now(), pending: false });
      })
      .catch(() => {
        cache.set(n, { status: "unknown", fetchedAt: Date.now(), pending: false });
      });
  }

  return {
    ensure(pr, repoSlug) {
      const n = Number(pr);
      if (!n) return;
      const entry = cache.get(n);
      const now = Date.now();
      if (!entry) {
        doFetch(n, repoSlug);
      } else if (!entry.pending && entry.fetchedAt != null && now - entry.fetchedAt > refreshMs) {
        doFetch(n, repoSlug);
      }
    },
    get(pr) {
      const entry = cache.get(Number(pr));
      if (!entry) return undefined;
      return { status: entry.status, fetchedAt: entry.fetchedAt };
    },
  };
}

// --- issue titles -------------------------------------------------------------

// Fetch a single issue's title from GitHub via `gh`. Returns the title string,
// or null on any failure (gh missing, network error, 404). Never throws — a
// title that cannot be fetched degrades to a placeholder, not a broken row.
export async function defaultFetchTitle(issue, repoSlug) {
  const args = repoSlug
    ? ["issue", "view", String(issue), "--repo", repoSlug, "--json", "title", "--jq", ".title"]
    : ["issue", "view", String(issue), "--json", "title", "--jq", ".title"];
  try {
    const { stdout } = await pexec("gh", args);
    const title = stdout.trim();
    return title || null;
  } catch {
    return null;
  }
}

// A per-server title cache so `gh` is called at most once per issue — never on
// every poll. `ensure` starts an async fetch if the issue is new (idempotent —
// a pending or resolved entry is never re-fetched); `get` returns the title
// string, null (fetch failed), or undefined (not yet resolved). The snapshot
// picks up the title on the next poll after the fetch resolves, and the
// change-key pushes it to the browser via SSE.
export function createTitleCache({ fetchTitle = defaultFetchTitle, log = () => {} } = {}) {
  const cache = new Map(); // issue number -> { title: string | null | undefined, state: "pending" | "resolved" }

  return {
    ensure(issue, repoSlug) {
      const n = Number(issue);
      if (cache.has(n)) return;
      cache.set(n, { title: undefined, state: "pending" });
      Promise.resolve()
        .then(() => fetchTitle(n, repoSlug))
        .then((title) => {
          cache.set(n, { title: title ?? null, state: "resolved" });
        })
        .catch(() => {
          cache.set(n, { title: null, state: "resolved" });
        });
    },
    get(issue) {
      const entry = cache.get(Number(issue));
      return entry ? entry.title : undefined;
    },
  };
}

// The full dashboard payload. Never throws: every source is read tolerantly, so
// missing state/events/escalations yield an empty snapshot carrying `hint`.
// When a checksCache is provided, each worker row with an open PR carries its
// combined checks status (passing/failing/pending/unknown) and the last-fetched
// timestamp; the fetch is triggered at most once per refreshMs per PR. When a
// titleCache is provided, each worker row carries an issueTitle (the cached
// title, or null while pending/failed), fetched at most once per issue.
export function readSnapshot({
  statePath = STATE_FILE,
  eventsPath = EVENTS_FILE,
  escalationsPath = ESCALATIONS_FILE,
  config,
  now = Date.now(),
  repoSlug = null,
  checksCache = null,
  titleCache = null,
} = {}) {
  const state = readState(statePath);
  const events = readEvents(eventsPath);
  const escalations = parseEscalations(escalationsPath);
  const workers = buildWorkers({ state, events, config, now, repoSlug });
  if (checksCache) {
    for (const w of workers) {
      if (w.pr != null) {
        checksCache.ensure(w.pr, repoSlug);
        const cached = checksCache.get(w.pr);
        w.checksStatus = cached ? cached.status : null;
        w.checksFetchedAt = cached && cached.fetchedAt != null ? cached.fetchedAt : null;
      }
    }
  }
  if (titleCache) {
    for (const w of workers) {
      titleCache.ensure(w.issue, repoSlug);
      w.issueTitle = titleCache.get(w.issue) ?? null;
    }
  }
  const hint = workers.length === 0 && escalations.length === 0 ? EMPTY_HINT : null;
  const totals = fleetUsage(workers);

  // Supervisor liveness, distinct from UI-server liveness. lastHeartbeatTs and
  // thresholdSeconds are sent so the browser can re-derive the age (and the
  // silent/live transition) locally every second; ageSeconds/state are the
  // server-side snapshot for the API and tests.
  const lastHeartbeatTs = latestHeartbeatTs(events);
  const thresholdSeconds = heartbeatThresholdSeconds(config?.pollSeconds);
  const { state: hbState, ageSeconds } = heartbeatStatus({ lastHeartbeatTs, thresholdSeconds, now });
  const heartbeat = { lastHeartbeatTs, thresholdSeconds, ageSeconds, state: hbState };

  return { workers, escalations, hint, totals, heartbeat };
}

// A change key that ignores the ever-advancing clock, so the live stream pushes
// only when the underlying data actually changed — not once per second because
// an age ticked. Ages are recomputed by the browser from claimStartTs.
export function snapshotKey(snapshot) {
  const workers = snapshot.workers.map(({ claimAgeSeconds, ...rest }) => rest);
  // Drop the clock-derived heartbeat fields (ageSeconds/state) for the same
  // reason as claim ages: the browser recomputes them each second, so keeping
  // them here would push a frame every tick. A new heartbeat changes
  // lastHeartbeatTs, which does re-push.
  const { ageSeconds, state, ...heartbeat } = snapshot.heartbeat || {};
  return JSON.stringify({ workers, escalations: snapshot.escalations, hint: snapshot.hint, totals: snapshot.totals ?? null, heartbeat });
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
  fetchChecks = null,
  checksRefreshMs = 30_000,
  fetchTitle = null,
} = {}) {
  const checksCache = createChecksCache({ fetchChecks: fetchChecks || defaultFetchChecks, refreshMs: checksRefreshMs });
  const titleCache = createTitleCache({ fetchTitle: fetchTitle || defaultFetchTitle });
  const snap = () => readSnapshot({ statePath, eventsPath, escalationsPath, config, now: now(), repoSlug, checksCache, titleCache });

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
  // Anchor the dashboard's files at the repo root, not the cwd, so it renders the
  // supervisor's real state from any subdirectory — and throws (caught by the CLI
  // guard below into a non-zero exit) rather than an empty dashboard when run
  // from outside any checkout.
  const root = resolveRepoRoot(cwd);
  const { statePath, eventsPath, escalationsPath } = ratchetPaths(root);
  const config = loadConfigOrDefaults(join(root, CONFIG_PATH));
  const repoSlug = resolveRepoSlug(gitOriginUrl(cwd));
  const server = createDashboardServer({ statePath, eventsPath, escalationsPath, config, repoSlug });
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
  header .fleettotals { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; }
  header .fleettotals.empty { display:none; }
  td.usage { text-align:right; font-variant-numeric:tabular-nums; }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  .hint { color:var(--muted); padding:40px 0; text-align:center; }
  .hbbanner { border-radius:6px; padding:12px 16px; margin-bottom:16px; font-weight:600; border:1px solid; border-left-width:4px; }
  .hbbanner.silent { color:var(--over); border-color:var(--over); background:color-mix(in srgb, var(--over) 10%, transparent); }
  .hbbanner.unseen { color:var(--warn); border-color:var(--warn); background:color-mix(in srgb, var(--warn) 10%, transparent); }
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
  .lifecycle-group { margin-bottom:18px; }
  .lifecycle-group:last-child { margin-bottom:0; }
  .group-head { display:flex; align-items:center; gap:8px; margin:0 0 6px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
  .group-count { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:0 7px; font-size:11px; font-weight:600; color:var(--fg); }
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
  .checks { font-size:12px; font-weight:600; margin-left:4px; }
  .checks.pass { color:#2da44e; }
  .checks.fail { color:var(--over); }
  .checks.pend { color:var(--warn); }
  .checks.unknown { color:var(--muted); font-style:italic; font-weight:400; }
  .checks-time { font-size:11px; color:var(--muted); margin-left:2px; }
  .issue-title { color:var(--muted); font-size:13px; }
  .issue-title.empty { font-style:italic; }
  .lognomatch { color:var(--muted); padding:12px; }
</style>
</head>
<body>
<header>
  <h1>Herd dashboard</h1>
  <span><span class="dot" id="livedot"></span> <span id="livetext" class="empty">connecting…</span></span>
  <span id="fleettotals" class="fleettotals empty"></span>
</header>
<main>
  <div id="hbbanner" class="hbbanner" role="status" hidden></div>
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
  let selected = null, logSource = null, logBuffer = "", panelOpen = false, gotSnapshot = false;
  let snapshot = { workers: [], escalations: [], hint: null, heartbeat: null };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

  // Usage formatters. A finite number renders; anything else (null from an
  // unreadable log or a worker with no usage mapping) becomes an em dash — never
  // blank, NaN, or undefined. usdText/tokText return the bare "—" for the header
  // line; usdCell/tokCell wrap it in the muted empty span for table cells.
  const isNum = (n) => typeof n === "number" && isFinite(n);
  const grp = (n) => String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  const usdText = (n) => isNum(n) ? "$" + n.toFixed(4) : "—";
  const tokText = (n) => isNum(n) ? grp(n) : "—";
  const usdCell = (n) => isNum(n) ? usdText(n) : '<span class="empty">—</span>';
  const tokCell = (n) => isNum(n) ? tokText(n) : '<span class="empty">—</span>';

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
  function checksClass(s) {
    return s === "passing" ? "pass" : s === "failing" ? "fail" : s === "pending" ? "pend" : "unknown";
  }
  function checksTitle(w) {
    if (!w.checksFetchedAt) return "checks status: " + esc(w.checksStatus);
    return "checks: " + esc(w.checksStatus) + " · fetched " + new Date(w.checksFetchedAt).toLocaleTimeString();
  }
  function checksAgo(ts) {
    const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return secs >= 60 ? Math.floor(secs / 60) + "m ago" : secs + "s ago";
  }

  function issueCell(w) {
    const num = "#" + esc(w.issue);
    const link = w.issueUrl ? '<a href="' + esc(w.issueUrl) + '" target="_blank" rel="noopener">' + num + "</a>" : num;
    if (w.issueTitle) {
      const title = esc(w.issueTitle);
      return link + ' <span class="issue-title">' + title + "</span>";
    }
    return link + ' <span class="issue-title empty">—</span>';
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

  // Display order and labels of the lifecycle groups — mirrors the server's
  // LIFECYCLE_GROUPS. "other" is the catch-all so an unmapped status is always
  // shown, never dropped.
  const GROUP_ORDER = [["live", "Live"], ["awaiting-review", "Awaiting review"], ["escalated", "Escalated"], ["terminal", "Terminal"], ["other", "Other"]];
  const THEAD = '<thead><tr><th>Issue</th><th>Status</th><th>Adapter</th><th>Attempts</th><th>Age</th><th>PR</th><th>Cost</th><th>Tokens in</th><th>Tokens out</th></tr></thead>';

  function rowHtml(w) {
    const pr = w.prUrl ? '<a href="' + esc(w.prUrl) + '" target="_blank" rel="noopener">#' + esc(w.pr) + "</a>"
      : (w.pr != null ? "#" + esc(w.pr) : '<span class="empty">—</span>');
    const checks = w.checksStatus
      ? '<span class="checks ' + checksClass(w.checksStatus) + '" title="' + checksTitle(w) + '">' + esc(w.checksStatus) + "</span>" +
        (w.checksFetchedAt ? '<span class="checks-time">' + esc(checksAgo(w.checksFetchedAt)) + "</span>" : "")
      : "";
    return '<tr class="worker' + (w.issue === selected ? " sel" : "") + '" data-issue="' + w.issue + '">' +
      "<td>" + issueCell(w) + "</td>" +
      '<td class="status">' + esc(w.status) + "</td>" +
      '<td><span class="adapter">' + avatarImg(w) + "<span>" + esc(w.adapter || "—") + "</span></span></td>" +
      "<td>" + attemptsText(w) + "</td>" +
      "<td>" + ageText(w) + "</td>" +
      "<td>" + pr + checks + "</td>" +
      '<td class="usage">' + usdCell(w.costUsd) + "</td>" +
      '<td class="usage">' + tokCell(w.tokensIn) + "</td>" +
      '<td class="usage">' + tokCell(w.tokensOut) + "</td></tr>";
  }

  function renderWorkers() {
    const host = $("workers");
    if (!snapshot.workers.length) {
      host.innerHTML = snapshot.hint ? '<div class="hint">' + esc(snapshot.hint) + "</div>" : '<div class="hint">No workers.</div>';
      return;
    }
    // Bucket rows by lifecycle group. snapshot.workers is issue-sorted, so each
    // bucket stays in issue order without re-sorting.
    const buckets = new Map();
    for (const w of snapshot.workers) {
      const g = w.group || "other";
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(w);
    }
    const known = new Set(GROUP_ORDER.map(([k]) => k));
    const labelOf = (k) => (GROUP_ORDER.find(([kk]) => kk === k) || [k, k])[1];
    // Known groups in fixed order, then any unforeseen group appended (a drift
    // guard so a row can never disappear even if a new group key reaches here).
    const order = GROUP_ORDER.map(([k]) => k).concat([...buckets.keys()].filter((k) => !known.has(k)).sort());
    let html = "";
    for (const key of order) {
      const rows = buckets.get(key);
      if (!rows || !rows.length) continue; // an empty group renders nothing
      html += '<section class="lifecycle-group" data-group="' + esc(key) + '">' +
        '<h3 class="group-head">' + esc(labelOf(key)) + ' <span class="group-count">' + rows.length + "</span></h3>" +
        "<table>" + THEAD + "<tbody>" + rows.map(rowHtml).join("") + "</tbody></table></section>";
    }
    host.innerHTML = html;
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

  function durText(secs) {
    if (secs < 60) return secs + "s";
    const m = Math.floor(secs / 60), s = secs % 60;
    return s ? m + "m" + s + "s" : m + "m";
  }

  // Supervisor liveness, recomputed locally every tick from the last heartbeat
  // so the age advances and the silent banner appears without a page reload or a
  // server push. The green dot means "supervisor still polling" — never merely
  // "UI server up": with no heartbeat at all the dot stays grey and labelled.
  function renderHeartbeat() {
    if (!gotSnapshot) return;
    const hb = snapshot.heartbeat || {};
    const dot = $("livedot"), text = $("livetext"), banner = $("hbbanner");
    text.classList.remove("empty");
    if (hb.lastHeartbeatTs == null || !Number.isFinite(Date.parse(hb.lastHeartbeatTs))) {
      dot.classList.remove("live");
      text.textContent = "supervisor not seen";
      banner.hidden = false;
      banner.className = "hbbanner unseen";
      banner.textContent = "Supervisor has not been seen — no heartbeat in the event stream yet.";
      return;
    }
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(hb.lastHeartbeatTs)) / 1000));
    if (age > hb.thresholdSeconds) {
      dot.classList.remove("live");
      text.textContent = "supervisor silent";
      banner.hidden = false;
      banner.className = "hbbanner silent";
      banner.textContent = "Supervisor silent since " + durText(age) + " — last heartbeat " + durText(age) + " ago.";
    } else {
      dot.classList.add("live");
      text.textContent = "supervisor live · heartbeat " + durText(age) + " ago";
      banner.hidden = true;
    }
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

  // The fleet totals line in the header: summed cost and summed tokens across
  // every worker with usage data. Hidden entirely when no worker has any finite
  // usage number, so it never reads "$0 · 0" before the first exit lands.
  function renderTotals() {
    const t = snapshot.totals || {};
    const el = $("fleettotals");
    const has = isNum(t.costUsd) || isNum(t.tokensIn) || isNum(t.tokensOut);
    if (!has) { el.textContent = ""; el.classList.add("empty"); return; }
    el.classList.remove("empty");
    el.textContent = "Fleet: " + usdText(t.costUsd) + " · " + tokText(t.tokensIn) + " in · " + tokText(t.tokensOut) + " out";
  }

  function render() { renderErrToggle(); renderEscalations(); renderWorkers(); renderTotals(); renderHeartbeat(); }

  $("errtoggle").addEventListener("click", () => { panelOpen = !panelOpen; applyPanel(); });
  $("errclose").addEventListener("click", () => { panelOpen = false; applyPanel(); });

  const stream = new EventSource("/api/stream");
  stream.addEventListener("snapshot", (ev) => {
    snapshot = JSON.parse(ev.data);
    gotSnapshot = true;
    render();
  });

  // Tick locally once a second without waiting on a server push: claim ages
  // advance, and the heartbeat age climbs so the silent banner appears on its
  // own the moment the supervisor stops emitting — the whole point of the alarm.
  setInterval(() => {
    if (snapshot.workers.length) renderWorkers();
    renderHeartbeat();
  }, 1000);
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
