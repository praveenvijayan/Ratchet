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
import { existsSync, readFileSync, openSync, readSync, fstatSync, closeSync, appendFileSync, statSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { join, basename, extname, sep } from "node:path";
import { readState, STATE_FILE, EVENTS_FILE, ESCALATIONS_FILE, STALE_CLAIM_STATUS, resolveRepoRoot, ratchetPaths } from "./herd-survey.mjs";
import { DEFAULTS, CONFIG_PATH, loadConfig, HerdConfigError } from "./herd.mjs";
import { defaultAvatarFor } from "./herd-avatars.mjs";
import { TERMINAL_STATUS } from "./herd-monitor.mjs";
import { createNotifier } from "./herd-notify.mjs";

export const DEFAULT_PORT = 4780;

// The append-only log of operator-acknowledged escalations. Each line is a
// JSON object { issue, reason, ts }. The dashboard reads it to mark
// escalations as resolved; the acknowledge button appends to it. Like the
// escalations log, it is never rewritten — resolution is derived at read time.
export const RESOLUTIONS_FILE = ".ratchet/herd-resolutions.jsonl";

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

// Normalize the free-form `what` text of an escalation into a stable reason
// string, so repeated escalations with the same root cause (but different pids,
// PR numbers, issue numbers, or log tails) map to one dedup key. The first line
// is the reason; variable parts are placeholdered; multi-line log tails and
// delete commands are dropped (they vary per occurrence).
export function escalationReason(what) {
  if (!what) return "";
  let s = String(what).split("\n")[0].trim();
  s = s.replace(/agent\/issue-\d+/g, "agent/issue-N");
  s = s.replace(/\bpid \d+\b/g, "pid N");
  s = s.replace(/PR #\d+/g, "PR #N");
  s = s.replace(/issue #\d+/gi, "issue #N");
  s = s.replace(/\(\d+ attempts\)/g, "(N attempts)");
  s = s.replace(/adapter "[^"]*"/g, 'adapter "…"');
  s = s.replace(/resume spawn failed:.*/, "resume spawn failed");
  s = s.replace(/Delete it[^:]*:.*$/, "").trim();
  s = s.replace(/tried \d+ adapter\(s\):.*$/, "tried N adapter(s)");
  s = s.replace(/\.?\s*Log tail:?\s*$/, "").trim();
  return s;
}

// Group escalations by (issue, reason), counting occurrences. The input is
// newest-first (from parseEscalations); the first block seen for a key is the
// newest, so its ts/what/action/logFile are kept as the group's display data.
// Returns a new array with an added `reason` and `occurrences` count per block.
export function dedupEscalations(blocks) {
  const map = new Map();
  for (const b of blocks) {
    const reason = escalationReason(b.what);
    const key = `${b.issue}\t${reason}`;
    if (!map.has(key)) {
      map.set(key, { ...b, reason, occurrences: 1 });
    } else {
      map.get(key).occurrences += 1;
    }
  }
  return [...map.values()];
}

// Mark each escalation as resolved or unresolved based on the current state
// file, the set of closed issue numbers, and the set of acknowledged
// (issue, reason) keys. Resolution is derived state — the append-only log is
// never rewritten.
// - A stale-claim escalation is resolved when its ref no longer exists (the
//   survey removes the sentinel from the state file when the ref is gone).
// - A PR-concluded escalation is resolved when the issue has since closed.
// - An operator-acknowledged escalation is resolved when its (issue, reason)
//   key appears in the `acknowledged` set (the acknowledge button wrote it).
// - Other escalation types default to unresolved (the dashboard cannot derive
//   their resolution from the state file alone).
export function resolveEscalations(blocks, { state, closedIssues = new Set(), acknowledged = new Set() } = {}) {
  return blocks.map((b) => {
    const entry = state && state[String(b.issue)];
    let resolved = false;
    if (/stale claim ref/.test(b.what)) {
      resolved = !entry || entry.status !== STALE_CLAIM_STATUS;
    } else if (/is no longer open/.test(b.what)) {
      resolved = closedIssues.has(b.issue);
    }
    if (!resolved && acknowledged.has(`${b.issue}\t${b.reason}`)) resolved = true;
    return { ...b, resolved };
  });
}

// The dashboard shows all unresolved escalations plus at most this many of the
// most recent resolved ones, so a long history of handled problems never buries
// live alerts.
export const MAX_RESOLVED_SHOWN = 5;

// Keep all unresolved escalations plus at most `maxResolved` of the most recent
// resolved ones. Input is newest-first; output preserves that order.
export function limitEscalations(blocks, maxResolved = MAX_RESOLVED_SHOWN) {
  const out = [];
  let resolvedCount = 0;
  for (const b of blocks) {
    if (!b.resolved) {
      out.push(b);
    } else if (resolvedCount < maxResolved) {
      out.push(b);
      resolvedCount++;
    }
  }
  return out;
}

// Read the append-only resolutions log. Each line is a JSON object
// { issue, reason, ts }. A missing or malformed file is []; a bad line is
// skipped, never fatal — the dashboard degrades to whatever it can parse,
// exactly like readEvents and parseEscalations.
export function readResolutions(path = RESOLUTIONS_FILE) {
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
      const obj = JSON.parse(trimmed);
      if (obj && obj.issue != null && obj.reason != null) out.push(obj);
    } catch {
      /* skip a torn or partial line */
    }
  }
  return out;
}

// Append one resolution to the resolutions log. Throws on write failure so the
// caller (the HTTP handler) can catch it and surface the error to the operator.
// Never reads, rewrites, or truncates the file — it only appends, so concurrent
// appends interleave safely (each write is a single appendFileSync call).
export function appendResolution(path, { issue, reason, ts }) {
  const line = JSON.stringify({ issue: Number(issue), reason: String(reason), ts: String(ts) }) + "\n";
  appendFileSync(path, line);
}

// Extract the exact command from an escalation's "Suggested action" text. The
// action is free-form prose that may contain a backtick-quoted command (e.g.
// "run `gh api -X DELETE ...` to delete the stale claim ref"). Returns the
// command string inside the backticks, or null when the action has no
// backtick-quoted command.
export function extractCommand(action) {
  if (!action) return null;
  const m = /`([^`]+)`/.exec(String(action));
  return m ? m[1] : null;
}

// --- adapter failure aggregation (0095) --------------------------------------

// Per-adapter dispatch stats derived purely from the event stream. Each
// `dispatch` event carries the routed adapter and a status of "dispatched" (the
// worker started) or "dispatch-failed" (it never did). Group by adapter,
// counting dispatches, failures, and successes. A dispatch with no named adapter
// is a route-level failure (no adapter was available), not attributable to any
// one adapter, so it is skipped. Adapters with no recorded dispatch never enter
// the map, so they are omitted rather than shown as 0/0. Sorted worst-first so
// the most-failing adapter reads at a glance.
export function adapterDispatchStats(events) {
  const map = new Map();
  for (const e of events || []) {
    if (e.event !== "dispatch") continue;
    const adapter = e.adapter;
    if (!adapter) continue;
    if (!map.has(adapter)) map.set(adapter, { adapter, dispatches: 0, failures: 0, successes: 0 });
    const s = map.get(adapter);
    s.dispatches += 1;
    if (e.status === "dispatch-failed") s.failures += 1;
    else s.successes += 1;
  }
  return [...map.values()].sort((a, b) => b.failures - a.failures || a.adapter.localeCompare(b.adapter));
}

// The small failure count at which an all-failing adapter is called out as
// broken. Below it, a one-off failure stays just an individual escalation.
export const BROKEN_ADAPTER_THRESHOLD = 3;

// Adapters that look broken: at least `threshold` dispatches, every one of which
// failed. Returned as one aggregate alert per adapter — naming it and its
// failure ratio — to show alongside, not multiply, the individual escalations.
// An adapter with any success is a transient blip, never flagged.
export function brokenAdapters(stats, threshold = BROKEN_ADAPTER_THRESHOLD) {
  return (stats || [])
    .filter((s) => s.successes === 0 && s.failures >= threshold)
    .map((s) => ({ adapter: s.adapter, failures: s.failures, dispatches: s.dispatches, ratio: `${s.failures}/${s.dispatches}` }));
}

// --- Active Agents mascot deck (0120) ----------------------------------------

// How many docking bays the deck shows. Configured adapters fill bays from the
// front; the remainder render as empty "Bay open" placeholders up to this many,
// so the fleet's spare capacity reads at a glance.
export const DECK_CAPACITY = 10;

// An adapter's "family" label: the segment before the first hyphen of its
// configured name, or the whole name when it has none ("claude-opus" → "claude",
// "codex" → "codex"). Pure string logic on the name the operator chose — the
// framework bakes in no CLI, model, or vendor name, so the purity rule holds.
export function adapterFamily(name) {
  const s = typeof name === "string" ? name : "";
  const dash = s.indexOf("-");
  return dash > 0 ? s.slice(0, dash) : s;
}

// The URL prefix the static image route serves repo-local avatar art under.
// Framework-pure: names no CLI, model, or vendor — just the served directory.
export const MASCOT_ROUTE = "/mascots/";

// Resolve an adapter's avatar to the URL the browser loads. A remote URL
// (http://, https://) or an inline data: URI passes through unchanged. A
// repo-local path (no protocol) is served from the dashboard's static image
// route at /mascots/<basename>, so the photographic art loads by direct URL
// — never base64/data-URI inlined. A null/empty avatar stays null so the
// bundled default renders. Pure: same input → same URL, no I/O. The basename
// extraction means `mascots/fig-goggles.png` and `fig-goggles.png` both serve
// from the same route — the route validates the filename against traversal.
export function resolveAvatarUrl(avatar) {
  if (avatar == null || avatar === "") return null;
  if (/^(https?:|data:)/.test(avatar)) return avatar;
  const base = basename(avatar.replace(/^\/+/, ""));
  return base ? MASCOT_ROUTE + base : null;
}

// Content types for the static image route. The route serves whatever the
// host repo places in mascots/; the framework knows no specific art file.
const IMAGE_CONTENT_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
});

// Serve a single image file from mascotsDir, or return a 404 response. The
// filename is validated at every layer against path traversal: it must be a
// bare single-segment name (no /, \, .., or empty), and the joined path must
// still resolve inside mascotsDir. A traversal attempt gets a 404 — never file
// contents from outside the served directory. Exported for testing.
export function serveMascotImage(req, res, mascotsDir, url) {
  if (!mascotsDir || !existsSync(mascotsDir)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const raw = url.pathname.slice(MASCOT_ROUTE.length);
  let filename;
  try {
    filename = decodeURIComponent(raw);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  // Reject any multi-segment path, parent reference, or empty name — only a
  // bare filename directly in the served directory is served. This is the
  // primary traversal guard; the realpath check below is belt-and-braces.
  if (filename === "" || /[/\\]/.test(filename) || filename === "." || filename === "..") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const resolved = join(mascotsDir, filename);
  // Belt-and-braces: the joined path must still be inside mascotsDir. A
  // symlink or other escape resolves outside and gets a 404.
  const dirReal = realpathSync(mascotsDir);
  let fileReal;
  try {
    fileReal = realpathSync(resolved);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  if (!fileReal.startsWith(dirReal + sep) && fileReal !== dirReal) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  let st;
  try {
    st = statSync(fileReal);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  if (!st.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const ct = IMAGE_CONTENT_TYPES[extname(filename).toLowerCase()] || "application/octet-stream";
  const data = readFileSync(fileReal);
  // Cache the art in the browser so live-stream updates never re-transmit or
  // re-fetch it — the snapshot carries a URL, not the image data.
  res.writeHead(200, { "Content-Type": ct, "Content-Length": data.length, "Cache-Control": "public, max-age=3600" });
  res.end(data);
}

// One deck *entry* per *configured* adapter, in config order — the fleet roster,
// each joined with its dispatch counts and the issue any live worker currently
// holds on it. This is a projection of config, not the rendered deck: the
// browser draws a mascot card only for entries with a live worker (`activeIssue`
// set) and renders the rest of the capacity as open bays, so the deck shows the
// fleet that is actually running. The roster count (this array's length over
// DECK_CAPACITY) keeps configured composition visible. Pure: given the same
// config, dispatch stats, and workers it always returns the same entries.
export function buildDeck({ config, adapters = [], workers = [] }) {
  const stats = new Map();
  for (const a of adapters || []) stats.set(a.adapter, a);
  const configured = config && config.adapters ? Object.keys(config.adapters) : [];
  return configured.map((name) => {
    const cfg = config.adapters[name];
    const s = stats.get(name);
    // The issue a live worker is running on this adapter, if any — drives the
    // active duty chip and whether a card renders at all. First live match wins.
    // A null/undefined entry in the workers list is skipped, never dereferenced.
    const active = (workers || []).find((w) => w && w.adapter === name && w.claimActive) || null;
    // A live worker only counts when it carries a usable issue identifier — a
    // finite number or a non-empty string. Missing or malformed worker data (no
    // issue, NaN, an empty string, a non-scalar) leaves activeIssue null, so the
    // adapter reads as idle: no card, never a partial one and never a throw.
    const issue = active ? active.issue : null;
    const liveIssue =
      (typeof issue === "number" && Number.isFinite(issue)) ||
      (typeof issue === "string" && issue.trim() !== "")
        ? issue
        : null;
    return {
      name,
      family: adapterFamily(name),
      // Avatar the browser tries first: the adapter's own non-empty avatar,
      // resolved to a served URL for local paths (or passed through for remote
      // URLs / data URIs), else null so it renders the bundled default.
      // defaultAvatar is always a valid data URI, doubling as the load-failure
      // fallback — never a broken image.
      avatar: resolveAvatarUrl(cfg && typeof cfg.avatar === "string" && cfg.avatar !== "" ? cfg.avatar : null),
      defaultAvatar: defaultAvatarFor(name),
      dispatches: s ? s.dispatches : 0,
      failures: s ? s.failures : 0,
      successes: s ? s.successes : 0,
      activeIssue: liveIssue,
    };
  });
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

// Filter events for one issue and sort them chronologically by ts. A missing
// ts sorts first (never crashes on a partial event). Used by the /api/timeline
// endpoint and directly testable.
export function timelineEvents(events, issue) {
  return (events || [])
    .filter((e) => Number(e.issue) === Number(issue))
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
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
    // declared a non-empty one, resolved to a served URL for local paths (or
    // passed through for remote URLs / data URIs), else null so the row shows
    // its bundled default. The default is deterministic per adapter name (same
    // mascot every restart) and always a valid data URI, so it doubles as the
    // load-failure fallback.
    const adapterCfg = config.adapters ? config.adapters[e.adapter] : undefined;
    const avatar = resolveAvatarUrl(
      adapterCfg && typeof adapterCfg.avatar === "string" && adapterCfg.avatar !== "" ? adapterCfg.avatar : null,
    );
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

// Fetch a single issue's title and state from GitHub via `gh`. Returns an
// object { title, state } where state is "OPEN" or "CLOSED"; both are null on
// any failure (gh missing, network error, 404). Never throws — a title that
// cannot be fetched degrades to a placeholder, not a broken row. The state
// field feeds escalation resolution (a PR-concluded escalation whose issue has
// since closed is resolved, not an open alert).
export async function defaultFetchTitle(issue, repoSlug) {
  const jq = "{title:.title,state:.state}";
  const args = repoSlug
    ? ["issue", "view", String(issue), "--repo", repoSlug, "--json", "title,state", "--jq", jq]
    : ["issue", "view", String(issue), "--json", "title,state", "--jq", jq];
  try {
    const { stdout } = await pexec("gh", args);
    const parsed = JSON.parse(stdout);
    return { title: parsed.title || null, state: parsed.state || null };
  } catch {
    return { title: null, state: null };
  }
}

// A per-server title cache so `gh` is called at most once per issue — never on
// every poll. `ensure` starts an async fetch if the issue is new (idempotent —
// a pending or resolved entry is never re-fetched); `get` returns the title
// string, null (fetch failed), or undefined (not yet resolved). `getState`
// returns the issue state ("OPEN"/"CLOSED") the same way. The snapshot picks
// up the title on the next poll after the fetch resolves, and the change-key
// pushes it to the browser via SSE. Supports both string returns (title only,
// backwards compat with older fetchTitle mocks) and { title, state } objects.
export function createTitleCache({ fetchTitle = defaultFetchTitle, log = () => {} } = {}) {
  const cache = new Map(); // issue number -> { title, issueState, done }

  return {
    ensure(issue, repoSlug) {
      const n = Number(issue);
      if (cache.has(n)) return;
      cache.set(n, { title: undefined, issueState: undefined, done: false });
      Promise.resolve()
        .then(() => fetchTitle(n, repoSlug))
        .then((result) => {
          if (typeof result === "string" || result == null) {
            cache.set(n, { title: result ?? null, issueState: null, done: true });
          } else {
            cache.set(n, { title: result.title ?? null, issueState: result.state ?? null, done: true });
          }
        })
        .catch(() => {
          cache.set(n, { title: null, issueState: null, done: true });
        });
    },
    get(issue) {
      const entry = cache.get(Number(issue));
      return entry ? entry.title : undefined;
    },
    getState(issue) {
      const entry = cache.get(Number(issue));
      return entry ? entry.issueState : undefined;
    },
  };
}

// --- ready queue --------------------------------------------------------------

// Count of open state:ready issues via `gh`. Returns { count } on success, or
// { error } on any failure (gh missing, network error, bad repo) — never throws,
// so the summary strip can show a placeholder naming the failure instead of a
// misleading zero.
export async function defaultFetchReadyCount(repoSlug) {
  const base = ["issue", "list", "--state", "open", "--label", "state:ready", "--json", "number", "--jq", "length"];
  const args = repoSlug ? ["issue", "list", "--repo", repoSlug, "--state", "open", "--label", "state:ready", "--json", "number", "--jq", "length"] : base;
  try {
    const { stdout } = await pexec("gh", args);
    const count = Number(String(stdout).trim());
    if (!Number.isFinite(count)) return { error: "ready-queue query returned a non-numeric count" };
    return { count };
  } catch (e) {
    return { error: `ready-queue query failed: ${e.message || e}` };
  }
}

// A per-server cache for the ready-queue count so `gh` runs at most once per
// refreshMs, not every poll. `ensure` starts an async refresh when the value is
// missing or older than refreshMs (idempotent — a pending fetch is never
// duplicated); `get` returns { count } | { error } | undefined (first fetch not
// yet resolved). The snapshot picks the value up on the next poll and the SSE
// change-key pushes it to the browser.
export function createReadyQueueCache({ fetchReadyCount = defaultFetchReadyCount, refreshMs = 15_000 } = {}) {
  let entry; // { count?, error?, fetchedAt, pending }

  function doFetch(repoSlug) {
    if (entry) entry.pending = true;
    else entry = { pending: true, fetchedAt: null };
    Promise.resolve()
      .then(() => fetchReadyCount(repoSlug))
      .then((result) => {
        entry = { ...result, fetchedAt: Date.now(), pending: false };
      })
      .catch((e) => {
        entry = { error: `ready-queue query failed: ${e.message || e}`, fetchedAt: Date.now(), pending: false };
      });
  }

  return {
    ensure(repoSlug) {
      const now = Date.now();
      if (!entry) doFetch(repoSlug);
      else if (!entry.pending && entry.fetchedAt != null && now - entry.fetchedAt > refreshMs) doFetch(repoSlug);
    },
    get() {
      if (!entry || entry.fetchedAt == null) return undefined;
      return entry.error ? { error: entry.error } : { count: entry.count };
    },
  };
}

// --- summary strip (0087) -----------------------------------------------------

// The one-glance fleet-health strip: four counts answering "is the herd fine?".
// Each field is either { value: n } or { error: msg } (rendered as a placeholder
// with the failure in a tooltip) or { pending: true } — never a bare 0 for an
// unavailable source, which would read as "all clear". The ready-queue count is
// the one external query (it can fail); the other three derive from the state,
// event, and escalation streams the snapshot already read. `readyQueue` is the
// cache's current reading: { count }, { error }, or undefined while pending.
export function buildSummary({ workers = [], escalations = [], readyQueue } = {}) {
  const live = workers.filter((w) => w.pid != null && w.group === "live").length;
  const prs = new Set();
  for (const w of workers) {
    if (w.group === "awaiting-review" && w.pr != null) prs.add(w.pr);
  }
  const unresolved = escalations.filter((e) => !e.resolved).length;

  let ready;
  if (readyQueue === undefined) ready = { pending: true };
  else if (readyQueue.error) ready = { error: readyQueue.error };
  else ready = { value: readyQueue.count };

  return {
    ready,
    liveWorkers: { value: live },
    awaitingReview: { value: prs.size },
    unresolvedEscalations: { value: unresolved },
  };
}

// The full dashboard payload. Never throws: every source is read tolerantly, so
// missing state/events/escalations yield an empty snapshot carrying `hint`.
// When a checksCache is provided, each worker row with an open PR carries its
// combined checks status (passing/failing/pending/unknown) and the last-fetched
// timestamp; the fetch is triggered at most once per refreshMs per PR. When a
// titleCache is provided, each worker row carries an issueTitle (the cached
// title, or null while pending/failed) and the title fetch is triggered at most
// once per issue. Escalations are deduplicated (same issue + same reason → one
// block with an occurrence count), resolved (stale-claim with no sentinel,
// PR-concluded with a closed issue → visually de-emphasised), and capped (all
// unresolved plus at most MAX_RESOLVED_SHOWN recent resolved ones).
export function readSnapshot({
  statePath = STATE_FILE,
  eventsPath = EVENTS_FILE,
  escalationsPath = ESCALATIONS_FILE,
  resolutionsPath = RESOLUTIONS_FILE,
  config,
  now = Date.now(),
  repoSlug = null,
  checksCache = null,
  titleCache = null,
  readyQueueCache = null,
} = {}) {
  const state = readState(statePath);
  const events = readEvents(eventsPath);
  const rawEscalations = parseEscalations(escalationsPath);
  const workers = buildWorkers({ state, events, config, now, repoSlug });
  const closedIssues = new Set();
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
      const issueState = titleCache.getState(w.issue);
      if (issueState === "CLOSED") closedIssues.add(w.issue);
    }
    // Also ensure titles/states for issues that appear only in escalations,
    // so their resolution can be derived from the issue's open/closed state.
    for (const esc of rawEscalations) {
      titleCache.ensure(esc.issue, repoSlug);
      const issueState = titleCache.getState(esc.issue);
      if (issueState === "CLOSED") closedIssues.add(esc.issue);
    }
  }
  // Build the acknowledged set from the resolutions log: each entry's
  // (issue, reason) key marks that escalation as resolved.
  const acknowledged = new Set();
  for (const r of readResolutions(resolutionsPath)) {
    acknowledged.add(`${r.issue}\t${r.reason}`);
  }
  const escalations = limitEscalations(
    resolveEscalations(
      dedupEscalations(rawEscalations),
      { state, closedIssues, acknowledged },
    ),
  );
  const hint = workers.length === 0 && escalations.length === 0 ? EMPTY_HINT : null;
  const totals = fleetUsage(workers);

  // Supervisor liveness, distinct from UI-server liveness. lastHeartbeatTs and
  // thresholdSeconds are sent so the browser can re-derive the age (and the
  // silent/live transition) locally every second; ageSeconds/state are the
  // server-side snapshot for the API and tests.
  const lastHeartbeatTs = latestHeartbeatTs(events);
  const thresholdSeconds = heartbeatThresholdSeconds(config?.pollSeconds);
  // The poll cadence the supervisor promises, surfaced so the details area can
  // report it (0131). Falls back to the default when the config carries none.
  const pollSeconds = Number.isFinite(config?.pollSeconds) && config.pollSeconds > 0 ? config.pollSeconds : DEFAULTS.pollSeconds;
  const { state: hbState, ageSeconds } = heartbeatStatus({ lastHeartbeatTs, thresholdSeconds, now });
  const heartbeat = { lastHeartbeatTs, thresholdSeconds, pollSeconds, ageSeconds, state: hbState };

  // Per-adapter failure visibility (0095): fold repeated dispatch failures on
  // one adapter into a single aggregate alert plus a breakdown, so a broken
  // adapter reads as one problem rather than N unrelated escalations.
  const adapters = adapterDispatchStats(events);
  const broken = brokenAdapters(adapters);

  // One-glance summary strip (0087). The ready-queue count is fetched via `gh`
  // through an injected cache; the other three counts derive from the streams
  // already read. A pending/failed ready query surfaces as a placeholder.
  if (readyQueueCache) readyQueueCache.ensure(repoSlug);
  const summary = buildSummary({ workers, escalations, readyQueue: readyQueueCache ? readyQueueCache.get() : undefined });

  // Active Agents deck (0120): one card per configured adapter, joined with its
  // dispatch stats and live worker. A pure projection of config + adapters +
  // workers — all already reflected in snapshotKey — so it never needs its own
  // key entry to stream correctly.
  const deck = buildDeck({ config, adapters, workers });

  return { workers, escalations, hint, totals, heartbeat, adapters, brokenAdapters: broken, summary, deck };
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
  return JSON.stringify({
    workers,
    escalations: snapshot.escalations,
    hint: snapshot.hint,
    totals: snapshot.totals ?? null,
    heartbeat,
    adapters: snapshot.adapters ?? [],
    brokenAdapters: snapshot.brokenAdapters ?? [],
    summary: snapshot.summary ?? null,
  });
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
  resolutionsPath = RESOLUTIONS_FILE,
  config = { ...DEFAULTS },
  configPath = null,
  repoSlug = null,
  now = Date.now,
  pollMs = 1000,
  fetchChecks = null,
  checksRefreshMs = 30_000,
  fetchTitle = null,
  notify = null,
  fetchReadyCount = null,
  mascotsDir = null,
} = {}) {
  const checksCache = createChecksCache({ fetchChecks: fetchChecks || defaultFetchChecks, refreshMs: checksRefreshMs });
  const titleCache = createTitleCache({ fetchTitle: fetchTitle || defaultFetchTitle });
  const readyQueueCache = createReadyQueueCache({ fetchReadyCount: fetchReadyCount || defaultFetchReadyCount });
  // Re-read herd.json for every snapshot so operator edits (avatars,
  // claimTimeoutSeconds, pollSeconds …) reflect in the next snapshot the browser
  // receives, without restarting the server. One read per snapshot means the whole
  // snapshot is built from a single config value — never a half-old, half-new mix.
  // A missing or unparseable file (any HerdConfigError, or any read failure) keeps
  // the last good config and never crashes the request. With no configPath the
  // config stays fixed at the value passed in — the offline test path.
  let liveConfig = config;
  const resolveConfig = () => {
    if (!configPath) return liveConfig;
    try {
      liveConfig = loadConfig(configPath, { warn: false });
    } catch {
      // keep last good liveConfig
    }
    return liveConfig;
  };
  const snap = () => readSnapshot({ statePath, eventsPath, escalationsPath, resolutionsPath, config: resolveConfig(), now: now(), repoSlug, checksCache, titleCache, readyQueueCache });

  const server = httpCreateServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    // POST /api/acknowledge — records an operator's acknowledgement of an
    // escalation. The body is { issue, reason }. The handler appends a
    // resolution entry to the resolutions log; it never executes any command,
    // never mutates the escalations log, git refs, issues, or PRs. On a write
    // failure it returns a 500 with the error message so the operator sees it;
    // the escalation stays unresolved until the write succeeds.
    if (req.method === "POST" && url.pathname === "/api/acknowledge") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const issue = Number(parsed && parsed.issue);
        const reason = parsed && parsed.reason != null ? String(parsed.reason) : null;
        if (!Number.isInteger(issue) || reason == null) {
          sendJson(res, 400, { ok: false, error: "issue (number) and reason (string) required" });
          return;
        }
        try {
          appendResolution(resolutionsPath, { issue, reason, ts: new Date().toISOString() });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e.message || "failed to write resolution" });
          return;
        }
        sendJson(res, 200, { ok: true });
      });
      return;
    }

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
        // Fire desktop notifications for any new unresolved escalations. Fire
        // and forget — the notifier catches its own failures and never rejects,
        // so the SSE stream is never affected. The notifiedSet is shared across
        // all connections (held inside the notify closure), so the first tick
        // to see a new escalation fires the notification and subsequent ticks
        // see it is already notified and skip.
        if (notify) Promise.resolve(notify(snapshot.escalations)).catch(() => {});
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

    // Live timeline for one issue: sends the issue's events from the event
    // stream in chronological order, then pushes only new events as they
    // arrive — never a full re-send. Malformed lines in the file are skipped
    // by readEvents, so the timeline degrades to whatever it can parse.
    if (url.pathname === "/api/timeline") {
      const issue = Number(url.searchParams.get("issue"));
      if (!Number.isInteger(issue)) {
        sendJson(res, 400, { error: "issue query parameter required" });
        return;
      }
      res.writeHead(200, SSE_HEADERS);
      let sentCount = 0;
      const tick = () => {
        const events = timelineEvents(readEvents(eventsPath), issue);
        if (events.length < sentCount) sentCount = 0; // truncated/rotated
        if (events.length > sentCount) {
          const delta = events.slice(sentCount);
          res.write(`event: timeline\ndata: ${JSON.stringify(delta)}\n\n`);
          sentCount = events.length;
        }
      };
      tick();
      const timer = setInterval(tick, pollMs);
      req.on("close", () => clearInterval(timer));
      return;
    }

    // Static image route — serves the photographic mascot figures from the
    // repo's mascots/ directory. Path-traversal is rejected at every layer;
    // a request like /mascots/../.ratchet/herd.json gets a 404, never file
    // contents from outside the served directory. See serveMascotImage.
    if (req.method === "GET" && url.pathname.startsWith(MASCOT_ROUTE)) {
      serveMascotImage(req, res, mascotsDir, url);
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
  const resolutionsPath = join(root, RESOLUTIONS_FILE);
  const configPath = join(root, CONFIG_PATH);
  const config = loadConfigOrDefaults(configPath);
  const repoSlug = resolveRepoSlug(gitOriginUrl(cwd));
  const mascotsDir = join(root, "mascots");
  const server = createDashboardServer({ statePath, eventsPath, escalationsPath, resolutionsPath, config, repoSlug, notify: createNotifier(), mascotsDir });
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
<!-- Fonts are the ONLY external reference on this page. If the CDN is
     unreachable the link simply fails and every font-family below falls back to
     its generic family (serif/sans-serif/monospace) — rendering is never blocked. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Marcellus&family=Space+Grotesk:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: light;
    /* Santorini palette — design 040de050 "Herd Dashboard Santorini". */
    --paper:#e4e3f5; --paper-hi:#f4f2fc; --paper-lo:#d7d4ee;
    --ink:#3f3e78; --ink-deep:#2b2a58;
    --ink-soft:rgba(63,62,120,.55); --ink-faint:rgba(63,62,120,.22); --ink-hair:rgba(63,62,120,.12);
    --terra:#7c68c4;
    /* Supervisor-live green — the header dot only goes this colour while the
       supervisor is still emitting heartbeats (0131); grey/terra otherwise. */
    --live:#1f9d78;
    /* Type system — every family ends in a generic fallback so the page still
       renders when the fonts CDN is unreachable. */
    --serif:'Marcellus', serif; --sans:'Space Grotesk', sans-serif; --mono:'Space Mono', monospace;
    /* Legacy tokens — still consumed by the not-yet-reskinned section, stat,
       row, incident and log markup (restyled in slices 0121/0122). */
    --fg:#1a1a1a; --bg:#fafafa; --card:#fff; --line:#e2e2e2; --muted:#666; --accent:#0969da; --warn:#b35900; --over:#cf222e;
  }
  * { box-sizing: border-box; }
  body {
    margin:0;
    font-family:var(--sans); font-size:14px; line-height:1.5;
    color:var(--ink);
    background:
      radial-gradient(circle at 84% -8%, rgba(124,104,196,.12), transparent 44%),
      repeating-linear-gradient(0deg, transparent 0 47px, var(--ink-hair) 47px 48px),
      repeating-linear-gradient(90deg, transparent 0 47px, var(--ink-hair) 47px 48px),
      linear-gradient(168deg, var(--paper-hi) 0%, var(--paper) 46%, var(--paper-lo) 100%);
    min-height:100vh;
  }
  header {
    display:flex; align-items:center; gap:22px;
    padding:20px 36px;
    border-bottom:2px solid var(--ink);
    background:linear-gradient(180deg, var(--paper-hi), transparent);
  }
  .brand { display:flex; align-items:baseline; gap:14px; }
  .brand h1 { font-family:var(--serif); font-size:30px; font-weight:400; letter-spacing:.04em; text-transform:uppercase; line-height:1; margin:0; }
  .brand .ordinal { font-family:var(--mono); font-size:10px; letter-spacing:.28em; color:var(--ink-soft); text-transform:uppercase; }
  header .heartbeat { display:flex; align-items:center; gap:10px; margin-left:auto; font-family:var(--mono); font-size:12px; letter-spacing:.05em; color:var(--ink); }
  header .dot { width:10px; height:10px; border-radius:50%; background:var(--ink-faint); display:inline-block; }
  header .dot.live { background:var(--live); box-shadow:0 0 0 3px rgba(31,157,120,.35); animation:hb-pulse 2.2s ease-in-out infinite; }
  @keyframes hb-pulse { 0%,100% { box-shadow:0 0 0 3px rgba(31,157,120,.35); } 50% { box-shadow:0 0 0 7px rgba(31,157,120,.10); } }
  header .supervisor { display:flex; align-items:baseline; gap:8px; font-family:var(--mono); font-size:11px; letter-spacing:.05em; color:var(--ink-soft); }
  header .supervisor .sup-label { text-transform:uppercase; letter-spacing:.16em; color:var(--ink-faint); }
  header .supervisor .sup-status { text-transform:uppercase; font-weight:700; letter-spacing:.12em; }
  header .supervisor.live .sup-status { color:var(--live); }
  header .supervisor.silent .sup-status { color:var(--over); }
  header .supervisor.unseen .sup-status { color:var(--warn); }
  header .supervisor .sup-meta { color:var(--ink-soft); font-variant-numeric:tabular-nums; }
  header .fleettotals { color:var(--ink-soft); font-variant-numeric:tabular-nums; font-family:var(--mono); font-size:12px; }
  header .fleettotals.empty { display:none; }
  td.usage { text-align:right; font-variant-numeric:tabular-nums; }
  main { padding:34px 36px 70px; max-width:1480px; margin:0 auto; }
  .hint { color:var(--muted); padding:40px 0; text-align:center; }
  .hbbanner { border-radius:6px; padding:12px 16px; margin-bottom:16px; font-weight:600; border:1px solid; border-left-width:4px; }
  .hbbanner.silent { color:var(--over); border-color:var(--over); background:color-mix(in srgb, var(--over) 10%, transparent); }
  .hbbanner.unseen { color:var(--warn); border-color:var(--warn); background:color-mix(in srgb, var(--warn) 10%, transparent); }
  /* Two-column grid shell: work column + 400px incidents aside. The aside is
     the toggled errors panel, so the second track exists only when the panel is
     open (.panel-open) — otherwise the work column spans full width, preserving
     the existing toggle. Below 1180px the grid collapses to a single column. */
  .layout { display:grid; grid-template-columns:minmax(0,1fr); gap:34px; align-items:start; }
  .layout.panel-open { grid-template-columns:minmax(0,1fr) 400px; }
  @media (max-width:1180px) { .layout.panel-open { grid-template-columns:minmax(0,1fr); } }
  .fleet { flex:1 1 auto; min-width:0; }
  .fleet-toolbar { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
  /* Errors chip — Santorini alert treatment (design .errors-chip). Restyled in
     place; the #errtoggle / #errcount hooks and toggle behaviour are unchanged. */
  .errtoggle { display:inline-flex; align-items:center; gap:10px; border:1.5px solid var(--terra); color:var(--terra); background:rgba(124,104,196,.09); padding:7px 14px; cursor:pointer; font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; }
  .errtoggle:hover { background:rgba(124,104,196,.16); }
  .errcount { background:var(--terra); color:var(--paper-hi); border-radius:99px; padding:1px 9px; font-size:11px; font-weight:700; min-width:20px; text-align:center; }
  .errcount.zero { background:var(--ink-faint); color:var(--ink); }
  /* Incidents aside — Santorini panel (design aside/.panel-head/.incident).
     Bordered card with an ink-inverted head; hooks (#errpanel/#errclose,
     #adapterhealth/#escalations) and the toggle behaviour are unchanged. */
  .errpanel { border:1.5px solid var(--ink); background:var(--paper-hi); box-shadow:8px 8px 0 var(--ink-faint); overflow:auto; max-height:calc(100vh - 120px); align-self:stretch; }
  .errpanel-head { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1.5px solid var(--ink); background:var(--ink); color:var(--paper-hi); }
  .errpanel-head h2 { font-family:var(--serif); font-size:16px; font-weight:400; letter-spacing:.14em; text-transform:uppercase; margin:0; }
  .errpanel-head .errclose { background:none; border:none; cursor:pointer; font-family:var(--mono); font-size:15px; color:var(--paper-hi); opacity:.7; padding:2px 6px; }
  .errpanel-head .errclose:hover { opacity:1; }
  /* Adapter-failure alerts and breakdown share the incident-card language: a
     terra-accented alert card and a dashed-ruled table under an ink header. */
  .adapterhealth { padding:18px 20px 0; display:flex; flex-direction:column; gap:14px; }
  .adapterhealth:empty { display:none; }
  .adapter-alert { border:1.5px solid var(--terra); box-shadow:4px 4px 0 rgba(124,104,196,.22); background:var(--paper); padding:15px 17px; font-family:var(--mono); font-size:12px; line-height:1.55; color:var(--terra); }
  .adapter-breakdown { width:100%; border-collapse:collapse; border:1px solid var(--ink); background:var(--paper); font-family:var(--mono); }
  .adapter-breakdown th { text-align:right; padding:6px 8px; background:var(--ink); color:var(--paper-hi); font-size:9.5px; font-weight:400; letter-spacing:.12em; text-transform:uppercase; }
  .adapter-breakdown td { text-align:right; padding:5px 8px; font-size:11px; border-top:1px dashed var(--ink-faint); font-variant-numeric:tabular-nums; }
  .adapter-breakdown th:first-child, .adapter-breakdown td:first-child { text-align:left; }
  .adapter-breakdown tr.broken td { color:var(--terra); font-weight:700; }
  /* Summary strip — Santorini stat blocks (design .topstrip/.stat): bordered,
     offset shadow, serif number, mono uppercase label. Structure/hooks kept. */
  .summarystrip { display:flex; align-items:stretch; flex-wrap:wrap; gap:18px; margin:0 0 36px; }
  .summarystrip.empty { display:none; }
  .sumcell { display:flex; align-items:baseline; gap:12px; min-width:96px; padding:16px 22px; border:1.5px solid var(--ink); background:var(--paper-hi); box-shadow:5px 5px 0 var(--ink-faint); }
  .sumcell .sumnum { font-family:var(--serif); font-size:38px; line-height:1; font-weight:400; font-variant-numeric:tabular-nums; }
  .sumcell .sumlabel { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.22em; color:var(--ink-soft); max-width:90px; line-height:1.5; }
  .sumcell.alert { border-color:var(--terra); box-shadow:5px 5px 0 rgba(124,104,196,.22); }
  .sumcell.alert .sumnum { color:var(--terra); }
  .sumcell.unavailable { border-color:var(--terra); cursor:help; }
  .sumcell.unavailable .sumnum { color:var(--terra); }
  .sumcell.pending .sumnum { color:var(--ink-soft); }
  /* Incident cards (design .incident/.incident.flag). An unresolved incident is
     the flagged card: terra border, offset shadow, terra action buttons. A
     resolved one is de-emphasised to a faint ink outline (the esc-resolved
     class name and the display:none actions rule below are preserved hooks). */
  .escalations { padding:18px 20px; }
  .esc { border:1.5px solid var(--terra); box-shadow:4px 4px 0 rgba(124,104,196,.22); background:var(--paper); padding:15px 17px; margin-bottom:14px; display:flex; flex-direction:column; gap:10px; }
  .esc:last-child { margin-bottom:0; }
  .esc.resolved { border:1px solid var(--ink-faint); box-shadow:none; opacity:0.6; }
  .esc.resolved .top { font-weight:normal; color:var(--ink-soft); }
  .esc .top { font-family:var(--mono); font-weight:700; font-size:12.5px; color:var(--terra); display:flex; align-items:center; gap:10px; }
  .esc .top::after { content:""; flex:1; height:1px; background:var(--ink-faint); }
  .esc .what { margin:0; font-size:12.5px; line-height:1.55; }
  .esc .meta { font-family:var(--mono); font-size:10px; line-height:1.6; color:var(--ink-soft); border-top:1px dashed var(--ink-faint); padding-top:9px; overflow-wrap:anywhere; }
  .esc .occurrences { font-family:var(--mono); font-size:10px; font-weight:700; color:var(--terra); }
  .esc .actions { display:flex; gap:10px; flex-wrap:wrap; }
  .esc .act-btn { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; padding:7px 13px; border:1.5px solid var(--terra); background:var(--paper-hi); color:var(--terra); cursor:pointer; }
  .esc .act-btn:hover { background:var(--terra); color:var(--paper-hi); }
  .esc .act-btn.ack { background:var(--terra); color:var(--paper-hi); }
  .esc .act-btn.ack:hover { background:#5b4aa4; color:var(--paper-hi); }
  .esc .act-btn.copied { background:var(--ink); border-color:var(--ink); color:var(--paper-hi); }
  .esc .esc-error { font-family:var(--mono); font-size:11px; color:var(--terra); font-weight:700; }
  .esc.resolved .actions { display:none; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  .lifecycle-group { margin-bottom:44px; }
  .lifecycle-group:last-child { margin-bottom:0; }
  /* Section heading — design .sec: serif uppercase title, circled count tally,
     and a hairline rule ending in a diamond. The group-head hook is preserved. */
  .sec { display:flex; align-items:center; gap:14px; margin:0 0 18px; }
  .sec .group-head { font-family:var(--serif); font-size:19px; font-weight:400; letter-spacing:.16em; text-transform:uppercase; margin:0; }
  .sec .tally { font-family:var(--mono); font-size:11px; border:1px solid var(--ink); border-radius:50%; width:24px; height:24px; display:grid; place-items:center; }
  .sec .rule { flex:1; height:1px; background:var(--ink-faint); position:relative; }
  .sec .rule::after { content:""; position:absolute; right:0; top:-3px; width:7px; height:7px; background:var(--ink); transform:rotate(45deg); }
  .sec .note { font-family:var(--mono); font-size:9.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--ink-soft); }
  .sec .roster { font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-soft); }
  /* Active Agents mascot deck (0120) — center stage above the work column. */
  .deckwrap { margin:0 0 30px; }
  /* auto-fill grid flexes from 1 to 10 mascots without any layout change.
     padding-top:52px and row-gap:72px give the overflowing figures headroom
     so they never collide with the section header or the row of cards above. */
  .deck { display:grid; grid-template-columns:repeat(auto-fill, minmax(206px, 1fr)); gap:20px; padding-top:52px; row-gap:72px; }
  .mascot-card { position:relative; border:1.5px solid var(--ink); background:var(--paper-hi); box-shadow:6px 6px 0 var(--ink-faint); padding:26px 18px 18px; display:flex; flex-direction:column; align-items:center; gap:14px; transition:transform .18s ease, box-shadow .18s ease; }
  .mascot-card:hover { transform:translateY(-4px); box-shadow:8px 10px 0 var(--ink-faint); }
  .mascot-card::before { content:""; position:absolute; inset:6px; border:1px dashed var(--ink-faint); pointer-events:none; z-index:1; }
  .mascot-card .family { position:absolute; top:12px; left:14px; font-family:var(--mono); font-size:8.5px; letter-spacing:.2em; text-transform:uppercase; color:var(--ink-soft); z-index:4; }
  .mascot-card .slot-no { position:absolute; top:12px; right:14px; font-family:var(--mono); font-size:8.5px; letter-spacing:.14em; color:var(--ink-soft); z-index:4; }
  /* The mascot itself: a 3D vinyl figure popping out of the card frame. The
     slot is 132×126 but the image is 192px tall, absolutely positioned at the
     bottom, overflowing ~60px above the card's top border — unclipped, z-index:3
     so it sits over the card border and the dashed inner frame (::before). */
  .mascot { position:relative; width:132px; height:126px; margin-top:6px; }
  /* Contact shadow where the figure meets the card — an elliptical ground
     shadow, centered, sitting just below the slot. */
  .mascot::after { content:""; position:absolute; left:50%; bottom:-6px; transform:translateX(-50%); width:96px; height:16px; border-radius:50%; background:radial-gradient(closest-side, rgba(31,41,51,.28), rgba(31,41,51,0) 72%); z-index:2; }
  .mascot img { position:absolute; left:50%; bottom:0; transform:translateX(-50%); height:192px; width:auto; max-width:none; object-fit:contain; z-index:3; filter:drop-shadow(0 12px 10px rgba(31,41,51,.30)) drop-shadow(0 3px 3px rgba(31,41,51,.18)); transition:transform .22s ease, filter .22s ease; }
  .mascot-card:hover .mascot img { transform:translateX(-50%) translateY(-7px) scale(1.05); filter:drop-shadow(0 20px 16px rgba(31,41,51,.32)) drop-shadow(0 4px 4px rgba(31,41,51,.16)); }
  .mascot-card .name { font-family:var(--mono); font-weight:700; font-size:13px; text-align:center; overflow-wrap:anywhere; }
  .mascot-card .duty { display:inline-flex; align-items:center; gap:7px; font-family:var(--mono); font-size:9px; letter-spacing:.16em; text-transform:uppercase; padding:4px 10px; border:1px solid currentColor; }
  .duty.on { color:var(--ink-deep); background:rgba(63,62,120,.08); }
  .duty.idle { color:var(--ink-soft); }
  .duty .dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
  .duty.on .dot { animation:deckpulse 2.2s ease-in-out infinite; }
  @keyframes deckpulse { 0%,100% { opacity:1; } 50% { opacity:.25; } }
  .mascot-card .vitals { width:100%; display:grid; grid-template-columns:1fr 1fr 1fr; border-top:1px dashed var(--ink-faint); padding-top:12px; }
  .vitals .cell { display:flex; flex-direction:column; align-items:center; gap:3px; }
  .vitals .cell + .cell { border-left:1px solid var(--ink-hair); }
  .vitals .k { font-family:var(--mono); font-size:8.5px; letter-spacing:.18em; text-transform:uppercase; color:var(--ink-soft); }
  .vitals .v { font-family:var(--mono); font-size:14px; font-weight:700; }
  .vitals .v.zero { color:var(--ink-faint); font-weight:400; }
  /* Empty docking bays — dashed placeholders for the fleet's spare capacity. */
  .bay { border:1.5px dashed var(--ink-faint); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; min-height:262px; color:var(--ink-soft); }
  .bay .ring { width:64px; height:64px; border-radius:50%; border:1.5px dashed var(--ink-faint); display:grid; place-items:center; font-family:var(--serif); font-size:24px; color:var(--ink-faint); }
  .bay .k { font-family:var(--mono); font-size:9px; letter-spacing:.22em; text-transform:uppercase; color:var(--ink-faint); }
  .gauge.warn { color:var(--warn); }
  .gauge.over { color:var(--terra); font-weight:700; }
  /* Work rows — design .row cards: bordered, offset shadow, dashed telemetry. */
  .rows { display:flex; flex-direction:column; gap:14px; }
  .row { border:1.5px solid var(--ink); background:var(--paper-hi); box-shadow:5px 5px 0 var(--ink-faint); padding:16px 20px; display:flex; flex-direction:column; gap:11px; cursor:pointer; }
  .row.sel { border-color:var(--terra); box-shadow:5px 5px 0 rgba(124,104,196,.35); }
  .row-head { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .issue-no { font-family:var(--mono); font-weight:700; font-size:13px; text-decoration:underline; text-underline-offset:3px; color:var(--ink); }
  .status { font-family:var(--mono); font-size:10px; letter-spacing:.2em; text-transform:uppercase; padding:4px 10px; border:1px solid currentColor; color:var(--ink-soft); }
  .status.dispatched { color:var(--ink-deep); background:rgba(63,62,120,.08); }
  .status.review { color:#5654a8; background:rgba(143,154,208,.18); }
  .status.stale { color:var(--terra); background:rgba(124,104,196,.09); }
  .who { margin-left:auto; display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:11px; font-weight:700; }
  .who .empty { color:var(--ink-faint); font-weight:400; }
  /* Fixed dimension so a large source image can never break the card layout;
     object-fit crops rather than stretches, and the shape stays a circular chip. */
  img.avatar { width:20px; height:20px; flex:none; border-radius:50%; object-fit:cover; border:1.5px solid var(--ink); background:var(--paper-lo); }
  .row-title { font-size:15.5px; font-weight:500; line-height:1.4; }
  .row-title.empty { color:var(--ink-faint); font-style:italic; }
  .telemetry { display:flex; flex-wrap:wrap; border-top:1px dashed var(--ink-faint); padding-top:11px; }
  .tm { display:flex; flex-direction:column; gap:3px; padding-right:20px; margin-right:20px; border-right:1px solid var(--ink-hair); }
  .tm:last-child { border-right:0; margin-right:0; padding-right:0; }
  .tm .k { font-family:var(--mono); font-size:9px; letter-spacing:.2em; text-transform:uppercase; color:var(--ink-soft); }
  .tm .v { font-family:var(--mono); font-size:12.5px; font-weight:700; }
  .tm .v .empty { color:var(--ink-faint); font-weight:400; }
  a { color:var(--accent); }
  /* Log console (design .log-shell/.log-filter/.log-raw). Bordered shell with a
     serif head; the filter input carries the design's offset shadow and the raw
     log tail is an ink-inverted block. #logsearch/#lognomatch/pre#log unchanged. */
  .logpane { margin-top:34px; border:1.5px solid var(--ink); background:var(--paper-hi); box-shadow:5px 5px 0 var(--ink-faint); padding:20px 24px; }
  .logpane h2 { font-family:var(--serif); font-size:16px; font-weight:400; letter-spacing:.14em; text-transform:uppercase; margin:0 0 14px; }
  .logsearch { display:block; width:100%; margin:0 0 16px; font-family:var(--mono); font-size:12px; color:var(--ink); padding:10px 14px; border:1.5px solid var(--ink); background:var(--paper-hi); box-shadow:4px 4px 0 var(--ink-faint); outline:none; }
  .logsearch::placeholder { color:var(--ink-soft); }
  .logsearch:focus { border-color:var(--terra); }
  pre.log { border:1.5px solid var(--ink); background:var(--ink); color:var(--paper-lo); box-shadow:5px 5px 0 var(--ink-faint); padding:16px 18px; max-height:300px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; margin:0; font-family:var(--mono); font-size:11px; line-height:1.75; }
  .empty { color:var(--muted); }
  .checks { font-size:12px; font-weight:600; margin-left:4px; }
  .checks.pass { color:#2da44e; }
  .checks.fail { color:var(--over); }
  .checks.pend { color:var(--warn); }
  .checks.unknown { color:var(--muted); font-style:italic; font-weight:400; }
  .checks-time { font-size:11px; color:var(--muted); margin-left:2px; }
  /* Title styling lives on .row-title now; the .issue-title class is retained on
     the element only as a test/telemetry hook. */
  /* Structured log lines (design .log-lines/.log-line): timestamp / bold event
     / faint meta, dashed-ruled, with escalation events in the terra accent. */
  .timeline { margin-bottom:16px; max-height:200px; overflow:auto; display:flex; flex-direction:column; }
  .timeline-entry { display:flex; align-items:baseline; gap:10px; font-family:var(--mono); font-size:12px; line-height:1.5; padding:4px 0; border-bottom:1px dashed var(--ink-hair); }
  .timeline-entry:last-child { border-bottom:none; }
  .timeline-ts { color:var(--ink-soft); white-space:nowrap; }
  .timeline-event { font-weight:700; }
  .timeline-event.esc { color:var(--terra); }
  .timeline-fields { color:var(--ink-soft); }
  .lognomatch { font-family:var(--mono); font-size:12px; color:var(--ink-soft); padding:12px; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>Herd Dashboard</h1>
    <span class="ordinal">Santorini</span>
  </div>
  <div class="heartbeat"><span class="dot" id="livedot"></span> <span id="livetext" class="empty">connecting…</span></div>
  <div class="supervisor" id="hbdetails" hidden><span class="sup-label">Supervisor</span> <span class="sup-status" id="hbstatus"></span> <span class="sup-meta" id="hbmeta"></span></div>
  <span id="fleettotals" class="fleettotals empty"></span>
</header>
<main>
  <div class="summarystrip" id="summarystrip" aria-label="Fleet summary"></div>
  <div id="hbbanner" class="hbbanner" role="status" hidden></div>
  <section class="deckwrap" id="deckwrap" aria-label="Active agents" hidden>
    <div class="sec">
      <h2 class="group-head">Active Agents</h2>
      <span class="tally" id="decktally">0</span>
      <span class="roster" id="deckroster">0/${DECK_CAPACITY}</span>
      <span class="rule"></span>
      <span class="note">${DECK_CAPACITY} bays · new agents dock automatically</span>
    </div>
    <div class="deck" id="deck"></div>
  </section>
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
      <div class="adapterhealth" id="adapterhealth"></div>
      <div class="escalations" id="escalations"></div>
    </aside>
  </div>
  <div class="logpane" id="logpane" hidden>
    <h2 id="logtitle"></h2>
    <div id="timeline" class="timeline"></div>
    <input type="search" id="logsearch" class="logsearch" placeholder="Filter log lines…" autocomplete="off">
    <div id="lognomatch" class="lognomatch" hidden>No matches.</div>
    <pre class="log" id="log"></pre>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let selected = null, logSource = null, timelineSource = null, logBuffer = "", timelineBuffer = [], panelOpen = false, gotSnapshot = false;
  let snapshot = { workers: [], escalations: [], hint: null, heartbeat: null, adapters: [], brokenAdapters: [], summary: null, deck: [] };

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

  // The card's issue-number link, rendered in the row head.
  function issueLink(w) {
    const num = "#" + esc(w.issue);
    return w.issueUrl
      ? '<a class="issue-no" href="' + esc(w.issueUrl) + '" target="_blank" rel="noopener">' + num + "</a>"
      : '<span class="issue-no">' + num + "</span>";
  }
  // issueCell renders the row title. A missing title shows the faint em dash —
  // never blank or "undefined". (The .issue-title class is kept as a test hook.)
  function issueCell(w) {
    return w.issueTitle
      ? '<div class="row-title issue-title">' + esc(w.issueTitle) + "</div>"
      : '<div class="row-title issue-title empty">—</div>';
  }
  // Map a worker status to a chip variant: dispatched / ready-for-review /
  // stale-claim get distinct treatment; any other status uses the plain chip.
  function statusClass(s) {
    if (s === "dispatched") return " dispatched";
    if (s === "stale-claim") return " stale";
    if (s === "ready-for-review" || s === "in-review") return " review";
    return "";
  }

  function renderEscalations() {
    const el = $("escalations");
    if (!snapshot.escalations.length) { el.innerHTML = '<div class="empty">No errors.</div>'; return; }
    el.innerHTML = snapshot.escalations.map((e) => {
      const cls = e.resolved ? "esc resolved" : "esc";
      const count = e.occurrences > 1 ? ' <span class="occurrences">' + e.occurrences + "×</span>" : "";
      // Extract a backtick-quoted command from the action text for the copy
      // button. Only escalations whose action contains a command get one.
      const cmd = e.action ? (/\`([^\`]+)\`/.exec(e.action) || [])[1] : null;
      const copyBtn = cmd
        ? '<button class="act-btn" data-cmd="' + esc(cmd) + '" onclick="copyCmd(this)">Copy command</button>'
        : "";
      // Only unresolved escalations get an acknowledge button.
      const ackBtn = e.resolved ? "" : '<button class="act-btn ack" onclick="ackEsc(this)" data-issue="' + esc(e.issue) + '" data-reason="' + esc(e.reason || "") + '">Acknowledge</button>';
      const actions = (copyBtn || ackBtn) ? '<div class="actions">' + copyBtn + ackBtn + '</div>' : "";
      return '<div class="' + cls + '"><div class="top">issue #' + esc(e.issue) + count + "</div>" +
        '<div class="what">' + esc(e.what) + "</div>" +
        '<div class="meta">' + esc(e.ts) + (e.action ? " · " + esc(e.action) : "") + "</div>" +
        actions + "</div>";
    }).join("");
  }

  // Aggregate per-adapter failure view (0095): the broken-adapter alerts sit
  // above the individual escalations, and a breakdown table shows dispatches /
  // failures / successes per adapter so the worst one reads at a glance.
  // Active Agents deck (0129): one mascot card per adapter with a *live worker*,
  // then dashed empty bays out to the fleet's capacity. A configured adapter with
  // no live worker renders no card — the deck shows the fleet that is actually
  // running, not the configured roster (that count stays in the header). The
  // card's avatar tries the adapter's own image first (now a served URL for
  // repo-local photographic art, or a remote URL / data URI) and falls back to
  // the bundled data-URI mascot via avatarFallback — a broken image is never
  // shown. Zero vital counts keep their cell (faint treatment) so a fresh adapter
  // still reads all three.
  function renderDeck() {
    const wrap = $("deckwrap");
    if (!wrap) return;
    // The full configured roster (buildDeck's projection). 'live' is the subset
    // with a live worker — only these become mascot cards; the tally counts them.
    const cards = (snapshot.deck || []);
    const live = cards.filter((c) => c.activeIssue != null);
    const tallyEl = $("decktally");
    if (tallyEl) tallyEl.textContent = String(live.length);
    // Roster keeps configured composition visible (configured / capacity), so the
    // fleet's makeup is not lost even when zero workers are live.
    const rosterEl = $("deckroster");
    if (rosterEl) rosterEl.textContent = String(cards.length) + "/${DECK_CAPACITY}";
    const host = $("deck");
    // Hide only when nothing is configured at all. With adapters configured but
    // none live, the section still renders — zero cards, all bays open.
    if (!cards.length) { wrap.hidden = true; if (host) host.innerHTML = ""; return; }
    wrap.hidden = false;
    const bay = (n) => String(n).padStart(2, "0");
    const vital = (label, n) =>
      '<div class="cell"><span class="k">' + label + '</span><span class="v' +
      (n === 0 ? " zero" : "") + '">' + String(n) + "</span></div>";
    let html = live.map((c, i) => {
      const src = c.avatar || c.defaultAvatar;
      const duty = c.activeIssue != null
        ? '<span class="duty on"><span class="dot"></span>dispatched · #' + String(c.activeIssue) + "</span>"
        : '<span class="duty idle"><span class="dot"></span>standing by</span>';
      return '<article class="mascot-card">' +
        '<span class="family">' + esc(c.family) + "</span>" +
        '<span class="slot-no">bay ' + bay(i + 1) + "</span>" +
        '<div class="mascot"><img alt="' + esc(c.name) + ' mascot" src="' + esc(src) +
        '" data-default="' + esc(c.defaultAvatar) + '" onerror="avatarFallback(this)"></div>' +
        '<div class="name">' + esc(c.name) + "</div>" +
        duty +
        '<div class="vitals">' + vital("Disp.", c.dispatches) + vital("Fail", c.failures) +
        vital("Launched", c.successes) + "</div>" +
        "</article>";
    }).join("");
    for (let n = live.length + 1; n <= ${DECK_CAPACITY}; n++) {
      html += '<div class="bay"><span class="ring">' + bay(n) + '</span><span class="k">Bay open</span></div>';
    }
    host.innerHTML = html;
  }

  function renderAdapterHealth() {
    const el = $("adapterhealth");
    if (!el) return;
    const broken = snapshot.brokenAdapters || [];
    const stats = snapshot.adapters || [];
    let html = broken
      .map((b) => '<div class="adapter-alert">adapter <strong>' + esc(b.adapter) + "</strong> failed " + esc(b.ratio) + " dispatches</div>")
      .join("");
    if (stats.length) {
      html += '<table class="adapter-breakdown"><thead><tr><th>Adapter</th><th>Disp.</th><th>Fail</th><th>OK</th></tr></thead><tbody>' +
        stats
          .map((s) => {
            const cls = s.successes === 0 && s.failures > 0 ? ' class="broken"' : "";
            return "<tr" + cls + "><td>" + esc(s.adapter) + "</td><td>" + esc(s.dispatches) + "</td><td>" + esc(s.failures) + "</td><td>" + esc(s.successes) + "</td></tr>";
          })
          .join("") +
        "</tbody></table>";
    }
    el.innerHTML = html;
  }

  function renderErrToggle() {
    // The aggregate broken-adapter alerts count toward the badge alongside the
    // unresolved escalations, so a broken adapter is visible with the panel shut.
    const count = snapshot.escalations.filter((e) => !e.resolved).length + (snapshot.brokenAdapters || []).length;
    const badge = $("errcount");
    badge.textContent = String(count);
    badge.classList.toggle("zero", count === 0);
  }

  // Copy the exact command from an escalation's action to the clipboard. The
  // command was extracted server-side from the backtick-quoted text and stored
  // in the button's data-cmd attribute. No command is ever executed.
  window.copyCmd = function (btn) {
    const cmd = btn.dataset.cmd;
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => {
      btn.classList.add("copied");
      btn.textContent = "Copied!";
      setTimeout(() => { btn.classList.remove("copied"); btn.textContent = "Copy command"; }, 1500);
    });
  };

  // Acknowledge an escalation: POST to the server, which appends a resolution
  // entry to the resolutions log. On success the next snapshot push marks the
  // block as resolved. On failure a visible error appears on the block and the
  // escalation stays unresolved. The button never executes any command and
  // never mutates the escalations log, git refs, issues, or PRs — it only
  // records the operator's acknowledgement.
  window.ackEsc = function (btn) {
    const issue = Number(btn.dataset.issue);
    const reason = btn.dataset.reason;
    fetch("/api/acknowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue, reason }),
    }).then((r) => r.json()).then((data) => {
      if (!data.ok) {
        const block = btn.closest(".esc");
        if (block) {
          let err = block.querySelector(".esc-error");
          if (!err) { err = document.createElement("div"); err.className = "esc-error"; block.appendChild(err); }
          err.textContent = "Failed to acknowledge: " + (data.error || "unknown error");
        }
      }
    }).catch((e) => {
      const block = btn.closest(".esc");
      if (block) {
        let err = block.querySelector(".esc-error");
        if (!err) { err = document.createElement("div"); err.className = "esc-error"; block.appendChild(err); }
        err.textContent = "Failed to acknowledge: " + (e.message || "network error");
      }
    });
  };

  function applyPanel() {
    $("errpanel").hidden = !panelOpen;
    // Drive the grid shell: the 400px aside track exists only while the panel
    // is open, so a closed panel leaves the work column full width.
    $("layout").classList.toggle("panel-open", panelOpen);
  }

  // Display order and labels of the lifecycle groups — mirrors the server's
  // LIFECYCLE_GROUPS. "other" is the catch-all so an unmapped status is always
  // shown, never dropped.
  const GROUP_ORDER = [["live", "Live"], ["awaiting-review", "Awaiting review"], ["escalated", "Escalated"], ["terminal", "Terminal"], ["other", "Other"]];

  function rowHtml(w) {
    const prInner = w.prUrl ? '<a class="pr-link" href="' + esc(w.prUrl) + '" target="_blank" rel="noopener">#' + esc(w.pr) + "</a>"
      : (w.pr != null ? "#" + esc(w.pr) : '<span class="empty">—</span>');
    const checks = w.checksStatus
      ? '<span class="checks ' + checksClass(w.checksStatus) + '" title="' + checksTitle(w) + '">' + esc(w.checksStatus) + "</span>" +
        (w.checksFetchedAt ? '<span class="checks-time">' + esc(checksAgo(w.checksFetchedAt)) + "</span>" : "")
      : "";
    // Assignee with avatar chip; an unassigned worker shows the faint em dash.
    const who = w.adapter
      ? '<span class="who">' + avatarImg(w) + "<span>" + esc(w.adapter) + "</span></span>"
      : '<span class="who"><span class="empty">—</span></span>';
    const tm = (k, v) => '<div class="tm"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>";
    return '<article class="row' + (w.issue === selected ? " sel" : "") + '" data-issue="' + w.issue + '">' +
      '<div class="row-head">' + issueLink(w) +
        '<span class="status' + statusClass(w.status) + '">' + esc(w.status) + "</span>" + who + "</div>" +
      issueCell(w) +
      '<div class="telemetry">' +
        tm("Attempts", attemptsText(w)) +
        tm("Age", ageText(w)) +
        tm("PR", prInner + checks) +
        tm("Cost", usdCell(w.costUsd)) +
        tm("Tokens In", tokCell(w.tokensIn)) +
        tm("Tokens Out", tokCell(w.tokensOut)) +
      "</div></article>";
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
        '<div class="sec"><h2 class="group-head">' + esc(labelOf(key)) + "</h2>" +
        '<span class="tally">' + rows.length + '</span><span class="rule"></span></div>' +
        '<div class="rows">' + rows.map(rowHtml).join("") + "</div></section>";
    }
    host.innerHTML = html;
    host.querySelectorAll(".row").forEach((row) => row.addEventListener("click", () => select(Number(row.dataset.issue))));
  }

  function select(issue) {
    if (selected === issue) return;
    selected = issue;
    if (logSource) { logSource.close(); logSource = null; }
    if (timelineSource) { timelineSource.close(); timelineSource = null; }
    const pane = $("logpane");
    pane.hidden = false;
    $("logtitle").textContent = "Log — issue #" + issue;
    $("logsearch").value = "";
    logBuffer = "";
    timelineBuffer = [];
    renderTimeline();
    renderLog();
    renderWorkers();
    logSource = new EventSource("/api/log?issue=" + issue);
    logSource.addEventListener("log", (ev) => { logBuffer += JSON.parse(ev.data); renderLog(); });
    logSource.addEventListener("note", (ev) => { logBuffer = JSON.parse(ev.data); renderLog(); });
    timelineSource = new EventSource("/api/timeline?issue=" + issue);
    timelineSource.addEventListener("timeline", (ev) => { timelineBuffer = timelineBuffer.concat(JSON.parse(ev.data)); renderTimeline(); });
  }

  // Render the per-issue activity timeline from timelineBuffer — each event
  // shows its timestamp, event type, and any adapter/attempt/PR/pid fields it
  // carries. An empty buffer shows a one-line "no activity recorded" message,
  // never a blank pane. Malformed lines never reach here (readEvents skips
  // them server-side), so the timeline always renders cleanly.
  function renderTimeline() {
    const el = $("timeline");
    if (!timelineBuffer.length) {
      el.innerHTML = '<div class="empty">No activity recorded.</div>';
      return;
    }
    el.innerHTML = timelineBuffer.map((e) => {
      const ts = e.ts ? new Date(Date.parse(e.ts)).toLocaleTimeString() : "—";
      const fields = [];
      if (e.adapter) fields.push("adapter " + esc(e.adapter));
      if (e.pid != null) fields.push("pid " + esc(e.pid));
      if (e.attempts != null) fields.push("attempt " + esc(e.attempts));
      if (e.pr != null) fields.push("PR #" + esc(e.pr));
      const fieldStr = fields.length ? ' <span class="timeline-fields">' + fields.join(" · ") + "</span>" : "";
      // Escalation events (event: "escalation", emitted by appendEscalation) are
      // called out in the accent colour, matching the design's .log-line .ev.esc.
      const evCls = String(e.event || "").startsWith("escalat") ? "timeline-event esc" : "timeline-event";
      return '<div class="timeline-entry"><span class="timeline-ts">' + esc(ts) + '</span><span class="' + evCls + '">' + esc(e.event || "?") + "</span>" + fieldStr + "</div>";
    }).join("");
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
    const details = $("hbdetails"), statusEl = $("hbstatus"), metaEl = $("hbmeta");
    text.classList.remove("empty");
    // The details area is always populated once a snapshot arrives, so an
    // operator can read the supervisor's state, freshness, and poll cadence at
    // a glance regardless of which liveness state it is in.
    details.hidden = false;
    const poll = Number.isFinite(hb.pollSeconds) ? "polls every " + durText(hb.pollSeconds) : "";
    if (hb.lastHeartbeatTs == null || !Number.isFinite(Date.parse(hb.lastHeartbeatTs))) {
      dot.classList.remove("live");
      text.textContent = "supervisor not seen";
      details.className = "supervisor unseen";
      statusEl.textContent = "not seen";
      metaEl.textContent = "no heartbeat yet" + (poll ? " · " + poll : "");
      banner.hidden = false;
      banner.className = "hbbanner unseen";
      banner.textContent = "Supervisor has not been seen — no heartbeat in the event stream yet.";
      return;
    }
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(hb.lastHeartbeatTs)) / 1000));
    if (age > hb.thresholdSeconds) {
      dot.classList.remove("live");
      text.textContent = "supervisor silent";
      details.className = "supervisor silent";
      statusEl.textContent = "silent";
      metaEl.textContent = "last heartbeat " + durText(age) + " ago" + (poll ? " · " + poll : "");
      banner.hidden = false;
      banner.className = "hbbanner silent";
      banner.textContent = "Supervisor silent since " + durText(age) + " — last heartbeat " + durText(age) + " ago.";
    } else {
      dot.classList.add("live");
      text.textContent = "supervisor live · heartbeat " + durText(age) + " ago";
      details.className = "supervisor live";
      statusEl.textContent = "live";
      metaEl.textContent = "heartbeat " + durText(age) + " ago" + (poll ? " · " + poll : "");
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

  // One-glance summary strip (0087). Each cell is a labelled count. A field
  // carrying { error } renders a "—" placeholder with the failure in a tooltip
  // (never a 0 that reads as "all clear"); a { pending } field shows "…".
  function summaryCell(label, field, alert = false) {
    let text;
    let cls = "sumcell";
    if (alert) cls += " alert";
    let title = "";
    if (field && field.error) { text = "—"; cls += " unavailable"; title = field.error; }
    else if (!field || field.pending) { text = "…"; cls += " pending"; }
    else { text = String(field.value); }
    const attr = title ? ' title="' + esc(title) + '"' : "";
    return '<span class="' + cls + '"' + attr + '><span class="sumnum">' + esc(text) + '</span><span class="sumlabel">' + esc(label) + "</span></span>";
  }
  function renderSummaryStrip() {
    const el = $("summarystrip");
    if (!el) return;
    const s = snapshot.summary;
    if (!s) { el.innerHTML = ""; el.classList.add("empty"); return; }
    el.classList.remove("empty");
    el.innerHTML =
      summaryCell("ready", s.ready) +
      summaryCell("live workers", s.liveWorkers) +
      summaryCell("awaiting review", s.awaitingReview) +
      summaryCell("escalations", s.unresolvedEscalations, true);
  }

  function render() { renderSummaryStrip(); renderDeck(); renderErrToggle(); renderAdapterHealth(); renderEscalations(); renderWorkers(); renderTotals(); renderHeartbeat(); }

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
