#!/usr/bin/env node
// herd-survey.mjs — the ratchet-herd supervisor's spine: a poll loop that
// surveys reality via `gh`, a state file rebuilt from reality (never trusted
// blindly), and the escalation channel later stages append to. This slice only
// observes and reconciles — it never dispatches, and it NEVER merges, approves,
// closes, or labels a PR or issue. When reality contradicts the state file, the
// supervisor escalates for a human rather than improvising.
//
// State file (.ratchet/herd-state.json): issue -> { adapter, pid, logFile,
// attempts, status, pr }. On each poll it is reconciled against `gh` and
// process liveness, so a stale pid or a concluded PR can never masquerade as a
// live worker. Every outside-world call is injectable, so the whole loop is
// exercised offline with no network and no spawned CLIs. Zero dependencies.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REQUEUE_MARKER } from "./ratchet-requeue.mjs";

export const STATE_FILE = ".ratchet/herd-state.json";
export const ESCALATIONS_FILE = ".ratchet/herd-escalations.md";
export const EVENTS_FILE = ".ratchet/events.jsonl";
// Round-robin rotation cursors, one per route source (e.g. "routing.default").
// Kept in its own file — not the issue-keyed herd-state map — so it never shows
// up as a phantom worker row anywhere state is iterated. A plain string→cursor
// map; the deterministic form of "spread work across adapters" that avoids
// Math.random, so a supervisor's dispatch order is reproducible offline.
export const ROUTING_FILE = ".ratchet/herd-routing.json";

// Repo-root path resolution. The constants above are repo-relative names; every
// herd script anchors them at the repository root, NOT the process cwd, so a
// script invoked from any subdirectory reads and writes the one true `.ratchet/`
// — and a script invoked from outside any checkout fails loudly instead of
// silently spawning a fresh, empty `.ratchet/` wherever it happens to stand.
export class RepoRootError extends Error {}

// Walk up from `startDir` to the nearest ancestor that is a git checkout (its
// `.git` is a directory in a normal clone, a file inside a worktree — existsSync
// accepts both). Throws RepoRootError naming `startDir` when no checkout
// encloses it, so the caller can exit non-zero rather than resolve to cwd.
export function resolveRepoRoot(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new RepoRootError(
        `herd: not inside a Ratchet checkout — no .git found at or above ${startDir}`,
      );
    }
    dir = parent;
  }
}

// The absolute `.ratchet/*` paths every herd stage reads and writes, anchored at
// `root`. Derived from the relative constants above so the file names stay
// defined in exactly one place.
export function ratchetPaths(root) {
  return {
    root,
    statePath: join(root, STATE_FILE),
    escalationsPath: join(root, ESCALATIONS_FILE),
    eventsPath: join(root, EVENTS_FILE),
    routingPath: join(root, ROUTING_FILE),
  };
}

// Status of the survey's stale-claim sentinel: a bookkeeping entry
// (pid/adapter/pr null) that records a stale claim ref already escalated so it
// is escalated exactly once. It is NOT a worker. Exported as the single source
// of the string so the monitor (herd-monitor.mjs) recognises and skips it rather
// than mis-classifying the pid-null entry as a dead worker — the two scripts
// share one constant instead of each hard-coding "stale-claim" and drifting.
export const STALE_CLAIM_STATUS = "stale-claim";
export const HERD_EVENT_TYPES = Object.freeze([
  "dispatch",
  "resume",
  "rework",
  "claim-detected",
  "pr-detected",
  "worker-exit",
  "worker-kill",
  "escalation",
  // Liveness proof: the supervisor appends one of these per poll pass so the
  // dashboard can tell "still polling" apart from "UI server merely up". Unlike
  // every other event it is not about an issue, so it carries no `issue` field.
  "heartbeat",
  // The conditional-survey fast path could not use an ETag this tick — either a
  // response carried no ETag header or the conditional `gh` call failed — so the
  // supervisor fell back to a full unconditional survey. Logged (not silent) so
  // an operator can see when the 304 short-circuit is not paying off.
  "survey-fallback",
  // A supervisor pass (tick or event-triggered) threw and was caught: it is
  // logged here rather than crashing the loop, so a failed reactive pass is
  // visible and the next periodic tick reconciles (plan 0173). No `issue` field.
  "supervisor-pass-error",
  // Dead-worker claim auto-recovery (plan 0178): a worker the supervisor watched
  // claim died at the rework cap with no PR, so the supervisor deleted the claim
  // ref it observed its own worker create and requeued the issue. One per
  // recovery — the single permitted deletion, made visible in the event stream.
  "claim-recovered",
]);

// Statuses the pipeline has already resolved — a stage escalated or handed them
// off, and no later pass acts on them again. "awaiting-verification" hands off
// to PR verification (herd-verify.mjs); "ready-for-review"/"verify-escalated"
// are that stage's terminal outcomes and must not be dragged back to
// verification; "escalated" is a human's to clear; "dispatch-failed" was already
// killed+escalated by dispatch. Lives here (not herd-monitor) because both the
// monitor and pollOnce's terminal-entry prune key off it; herd-monitor re-exports
// it so existing importers are undisturbed.
export const TERMINAL_STATUS = new Set([
  "awaiting-verification",
  "ready-for-review",
  "verify-escalated",
  "escalated",
  "dispatch-failed",
]);

const pexec = promisify(execFile);

// Default gh caller: run `gh <args>` and parse its JSON stdout. Injected in
// tests so the survey runs with no network.
export async function ghJson(args) {
  const { stdout } = await pexec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// Is this pid a live process? A signal-0 probe: no such process -> not alive;
// EPERM means it exists but we don't own it (still alive). A bad pid is dead.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// The exact command a human runs to delete a stale claim ref on origin, freeing
// the issue for re-work. It is the mirror of the atomic claim in AGENTS.md §2
// (which *creates* refs/heads/agent/issue-<N>). Shared so the survey and the
// dispatcher quote the identical command — an operator copies one string.
export function deleteRefCommand(issue) {
  return `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/agent/issue-${issue}`;
}

// The exact command a human runs to requeue an issue after its claim ref is
// gone. Paired with deleteRefCommand in the recovery escalation (plan 0178) so a
// gh failure mid-recovery hands the operator the identical two-step by hand.
export function requeueCommand(issue) {
  return `node scripts/ratchet-requeue.mjs --issue ${issue} --reason "<why>"`;
}

// Auto-recover a claim ref the supervisor watched its own worker create (plan
// 0178): delete the ref on origin, then requeue the issue exactly as
// ratchet-requeue does — comment FIRST (so an interrupted run leaves an
// explained state), then a single label flip to state:ready. This is the ONE
// deletion the supervisor is permitted, and only ever over a ref backed by a
// live supervisor state entry — the caller guarantees ownership; this function
// performs the janitor work and nothing else. `gh` is the injected CLI runner
// (array args). Any gh failure throws so the caller escalates once with the
// exact deleteRefCommand + requeueCommand rather than leaving a half-recovery.
export async function recoverClaim({ gh, issue, reason }) {
  await gh(["api", "-X", "DELETE", `repos/{owner}/{repo}/git/refs/heads/agent/issue-${issue}`]);
  await gh(["issue", "comment", String(issue), "--body", `${reason}\n\n${REQUEUE_MARKER}`]);
  await gh(["issue", "edit", String(issue), "--add-label", "state:ready", "--remove-label", "state:in-progress"]);
}

// List the claim refs agent/issue-<N> present on origin, as issue numbers.
// Uses GitHub's matching-refs prefix query, which returns [] (not 404) when no
// ref matches. Throws on a gh failure so the caller can skip stale detection
// this poll rather than escalate on a transient blip. `gh` is injected.
export async function listClaimRefs(gh) {
  const refs = await gh(["api", "repos/{owner}/{repo}/git/matching-refs/heads/agent/issue-?per_page=100"]);
  const issues = [];
  for (const r of refs || []) {
    const m = /^refs\/heads\/agent\/issue-(\d+)$/.exec((r && r.ref) || "");
    if (m) issues.push(Number(m[1]));
  }
  return issues;
}

// Does the claim ref agent/issue-<N> resolve on origin right now? True only on a
// definitive success; a 404 (absent) or any transient gh error reads as false,
// so a caller never invents a stale ref it could not confirm. `gh` is injected.
export async function claimRefPresent(gh, issue) {
  try {
    await gh(["api", `repos/{owner}/{repo}/git/ref/heads/agent/issue-${issue}`]);
    return true;
  } catch {
    return false;
  }
}

// Is GitHub issue #N still open? True on OPEN, false on CLOSED. Throws on a
// transient gh failure so the caller can skip this ref this poll and retry on
// the next — a blip never changes the escalation outcome. `gh` is injected.
export async function issueIsOpen(gh, issue) {
  const data = await gh(["issue", "view", String(issue), "--json", "state"]);
  return data?.state === "OPEN";
}

// Given the claim refs on origin plus current reality, return the issues whose
// ref is stale: no live worker in the state file AND no open PR. A ref backed by
// a live worker (a legitimate in-flight claim) or an open PR is never returned.
// Pure — the caller owns gh, dedup, and escalation. `openPrHeads` is the set of
// open PR head refs; `isAlive` probes a pid.
export function findStaleClaims(claimIssues, state, openPrHeads, isAlive) {
  const stale = [];
  for (const issue of claimIssues) {
    const entry = state[String(issue)];
    const liveWorker = !!entry && entry.pid != null && isAlive(entry.pid);
    const hasOpenPr = openPrHeads.has(`agent/issue-${issue}`);
    if (!liveWorker && !hasOpenPr) stale.push(issue);
  }
  return stale;
}

// Survey the world in one pass: the ready queue, the in-progress issues, and
// every open PR. `gh` is injected; returns already-parsed arrays.
export async function surveyReality(gh) {
  const [ready, inProgress, openPrs] = await Promise.all([
    gh(["issue", "list", "--state", "open", "--label", "state:ready", "--json", "number,title", "--limit", "200"]),
    gh(["issue", "list", "--state", "open", "--label", "state:in-progress", "--json", "number,title", "--limit", "200"]),
    gh(["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "200"]),
  ]);
  return { ready, inProgress, openPrs };
}

// The endpoints the survey polls, in a fixed order. Each carries a stable `key`
// (the in-memory ETag cache is keyed by it), a REST `path` for conditional
// `gh api` requests, and a `map` that normalizes the raw REST body to the exact
// shape `surveyReality` returns — so the downstream reconcile logic is identical
// whether the data arrived over the conditional fast path or the fallback.
export const SURVEY_ENDPOINTS = Object.freeze([
  {
    key: "ready",
    path: "repos/{owner}/{repo}/issues?state=open&labels=state:ready&per_page=200",
    map: (rows) => (rows || []).map((r) => ({ number: r.number, title: r.title })),
  },
  {
    key: "inProgress",
    path: "repos/{owner}/{repo}/issues?state=open&labels=state:in-progress&per_page=200",
    map: (rows) => (rows || []).map((r) => ({ number: r.number, title: r.title })),
  },
  {
    key: "openPrs",
    path: "repos/{owner}/{repo}/pulls?state=open&per_page=200",
    map: (rows) => (rows || []).map((p) => ({ number: p.number, headRefName: p.head?.ref })),
  },
]);

// Default conditional caller: `gh api --include` with an optional If-None-Match
// header, parsed into { status, etag, body }. A 304 comes back with no body; a
// 200 returns the parsed JSON. Injected in tests so nothing hits the network —
// exactly like `ghJson`, this default is exercised only against the live API.
export async function ghConditional(path, etag) {
  const args = ["api", "--include"];
  if (etag) args.push("-H", `If-None-Match: ${etag}`);
  args.push(path);
  const { stdout } = await pexec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  const text = String(stdout);
  const sep = text.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const cut = text.indexOf(sep);
  const head = cut >= 0 ? text.slice(0, cut) : text;
  const bodyText = cut >= 0 ? text.slice(cut + sep.length) : "";
  const lines = head.split(/\r?\n/);
  const statusMatch = /\b(\d{3})\b/.exec(lines[0] || "");
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  let responseEtag = null;
  for (const line of lines.slice(1)) {
    const m = /^etag:\s*(.+)$/i.exec(line.trim());
    if (m) { responseEtag = m[1].trim(); break; }
  }
  const body = status === 200 && bodyText.trim() ? JSON.parse(bodyText) : null;
  return { status, etag: responseEtag, body };
}

// Conditional survey: probe each endpoint with its cached ETag. `etags` is the
// in-memory cache the supervisor keeps across ticks — one entry per endpoint key
// ({ etag, body }); the first tick per endpoint is unconditional (no cache).
//
//   - Every endpoint 304  -> { changed: false }: nothing upstream moved, so the
//     caller skips the whole reconcile/verify/review pass and writes no state.
//   - Any endpoint 200    -> { changed: true, reality }: the full pass runs. A
//     200 body is fresh and its ETag replaces the old one; a 304 body is reused
//     from cache (a 304 *means* the body is byte-identical to last time).
//   - A gh failure, or a 200 with no ETag header, falls back to a full
//     unconditional survey and logs one `survey-fallback` herd event — never a
//     crash, never a silently skipped pass.
export async function surveyConditional({ ghc, gh, etags, eventsPath, now, log = () => {} }) {
  try {
    const results = [];
    for (const ep of SURVEY_ENDPOINTS) {
      const cached = etags[ep.key];
      results.push({ ep, res: await ghc(ep.path, cached?.etag ?? null) });
    }
    let changed = false;
    let missingEtag = false;
    for (const { ep, res } of results) {
      // A 304 backed by a cached entry is genuinely unchanged: keep the cache.
      if (res.status === 304 && etags[ep.key]) continue;
      // Anything else (a 200, or a 304 with no prior cache) is a real body.
      changed = true;
      etags[ep.key] = { etag: res.etag ?? null, body: ep.map(res.body) };
      if (!res.etag) missingEtag = true;
    }
    if (missingEtag) {
      appendHerdEvent(eventsPath, { now, event: "survey-fallback", status: "no-etag" }, () => {});
      log("herd: survey response carried no ETag; next tick will be unconditional.");
    }
    if (!changed) return { changed: false };
    return {
      changed: true,
      reality: {
        ready: etags.ready.body,
        inProgress: etags.inProgress.body,
        openPrs: etags.openPrs.body,
      },
    };
  } catch (e) {
    // The conditional call itself failed: drop the whole cache so the next tick
    // re-primes ETags cleanly, log the fallback, and survey unconditionally via
    // the plain `gh` boundary — the pass runs, it just costs full rate limit.
    for (const ep of SURVEY_ENDPOINTS) delete etags[ep.key];
    appendHerdEvent(eventsPath, { now, event: "survey-fallback", status: "gh-error" }, () => {});
    log(`herd: conditional survey failed (${e.message}); falling back to a full survey.`);
    return { changed: true, reality: await surveyReality(gh) };
  }
}

// Read the state file, tolerating a missing or corrupt file by returning {} —
// the supervisor then rebuilds from reality rather than crashing.
export function readState(path = STATE_FILE) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

// Read the round-robin rotation cursors, tolerating a missing or corrupt file by
// returning {} — a fresh rotation simply starts every route at index 0.
export function readRouting(path = ROUTING_FILE) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeRouting(path, cursors) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursors, null, 2) + "\n");
}

export function formatHerdEvent({ now = Date.now(), event, issue, adapter, pid, logFile, attempts, pr, status, costUsd, tokensIn, tokensOut }) {
  if (!HERD_EVENT_TYPES.includes(event)) throw new Error(`unknown herd event type: ${event}`);
  const line = { ts: new Date(now).toISOString(), event };
  // Every event but `heartbeat` is about an issue; a heartbeat is fleet-wide, so
  // it is logged with no `issue` field rather than a meaningless one.
  if (issue !== undefined && issue !== null) line.issue = Number(issue);
  // Usage fields (costUsd/tokensIn/tokensOut) are optional: omitted when
  // undefined (an adapter with no usage mapping), but a declared-yet-unreadable
  // value is passed as null and recorded as null — the absence of a mapping and
  // the failure to read one are deliberately distinct on the wire.
  for (const [key, value] of Object.entries({ adapter, pid, logFile, attempts, pr, status, costUsd, tokensIn, tokensOut })) {
    if (value !== undefined) line[key] = value;
  }
  return line;
}

export function appendHerdEvent(path = EVENTS_FILE, entry, warn = console.warn) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(formatHerdEvent(entry)) + "\n");
    return true;
  } catch (e) {
    warn(`herd: warning: failed to append event to ${path}: ${e.message}`);
    return false;
  }
}

// Normalize the optional claim-branch->PR-number map into a Map. Accepts a Map,
// a plain object (headRef -> number), or nothing (legacy callers pass none).
function normalizePrByHead(prByHead) {
  if (prByHead instanceof Map) return prByHead;
  if (prByHead && typeof prByHead === "object") {
    return new Map(Object.entries(prByHead).map(([k, v]) => [k, Number(v)]));
  }
  return new Map();
}

// Reconcile the state file against reality instead of trusting it: an entry
// whose tracked PR is no longer open (merged or closed), or whose worker pid is
// no longer alive, is cleared and flagged. Returns the reconciled state, the
// list of `changes` (each an escalation candidate), and the list of `adopted`
// entries (finished workers whose PR the supervisor rescued — see below).
//
// Adoption resolves the supervisor-downtime race: if the supervisor is down
// when a worker opens its PR and exits, only the monitor's exit handler would
// have recorded `entry.pr`, so on restart the entry has a dead pid and
// `pr: null`. Flagging it `dead` would escalate a finished worker and prune its
// open PR out of herd tracking. When `reality.prByHead` is supplied and a dead
// entry with no tracked PR has an open PR on its claim branch `agent/issue-<N>`
// — the same claim-branch lookup the monitor's `classifyExit` performs — adopt
// it into verification instead: status `awaiting-verification`, `pr` set to that
// PR, no `dead` change or escalation. Legacy callers that pass no `prByHead`
// keep the exact previous behavior.
export function reconcileState(state, reality, isAlive) {
  const openPrs = reality.openPrNumbers instanceof Set
    ? reality.openPrNumbers
    : new Set((reality.openPrNumbers || []).map(Number));
  const prByHead = normalizePrByHead(reality.prByHead);
  const next = {};
  const changes = [];
  const adopted = [];
  for (const [issue, entry] of Object.entries(state || {})) {
    const e = { ...entry };
    if (e.pr != null && !openPrs.has(Number(e.pr))) {
      changes.push({
        issue,
        what: `tracked PR #${e.pr} is no longer open (merged or closed)`,
        adapter: e.adapter,
        pid: e.pid,
        logFile: e.logFile || null,
        attempts: e.attempts,
        pr: e.pr,
        status: "pr-concluded",
      });
      e.status = "pr-concluded";
      e.pid = null;
    } else if (e.pid != null && !isAlive(e.pid)) {
      const orphanPr = e.pr == null ? prByHead.get(`agent/issue-${issue}`) : undefined;
      if (orphanPr != null) {
        e.status = "awaiting-verification";
        e.pr = Number(orphanPr);
        e.pid = null;
        adopted.push({
          issue,
          pr: Number(orphanPr),
          adapter: e.adapter,
          logFile: e.logFile || null,
          attempts: e.attempts,
        });
      } else {
        changes.push({
          issue,
          what: `worker pid ${e.pid} is not alive`,
          adapter: e.adapter,
          pid: e.pid,
          logFile: e.logFile || null,
          attempts: e.attempts,
          pr: e.pr,
          status: "dead",
        });
        e.status = "dead";
        e.pid = null;
      }
    }
    next[issue] = e;
  }
  return { state: next, changes, adopted };
}

// Normalize the free-form `what` text of an escalation into a stable reason
// string, so repeated escalations with the same root cause (but different pids,
// PR numbers, issue numbers, or log tails) map to one dedup key. The first line
// is the reason; variable parts are placeholdered; multi-line log tails and
// delete commands are dropped (they vary per occurrence). Shared by the writer
// (herd-survey) and the dashboard (herd-ui) so both agree on what "same reason"
// means; herd-ui re-exports it for its existing callers.
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

// Low-level parse of the escalation log into file-order blocks, each carrying its
// character span (start/end) so a single block can be rewritten in place without
// disturbing its neighbours. This is the shared primitive; herd-ui.parseEscalations
// wraps it (adding newest-first order) for the dashboard. Anything unrecognised is
// ignored, never fatal.
export function parseEscalationsRaw(md) {
  const blocks = [];
  const re = /^##\s+(\S+)\s+—\s+issue #(\d+)\s*$/gim;
  const heads = [];
  let m;
  while ((m = re.exec(md)) !== null) heads.push({ ts: m[1], issue: Number(m[2]), index: m.index, end: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index;
    const end = i + 1 < heads.length ? heads[i + 1].index : md.length;
    const body = md.slice(heads[i].end, end);
    const field = (label) => {
      const fm = new RegExp(`^-\\s*${label}:\\s*(.*)$`, "im").exec(body);
      return fm ? fm[1].trim() : null;
    };
    const occ = field("Occurrences");
    blocks.push({
      ts: heads[i].ts,
      issue: heads[i].issue,
      what: field("What happened") || "",
      logFile: field("Log file"),
      action: field("Suggested action"),
      occurrences: occ != null && /^\d+$/.test(occ) ? Number(occ) : 1,
      start,
      end,
    });
  }
  return blocks;
}

// A human-readable escalation block: timestamp, issue, what happened, the log
// file to inspect, a suggested next action, and an occurrence count. The heading
// timestamp is the *last-seen* time — the deduplicating writer bumps it (and the
// count) each time the same cause recurs, so a persistent problem stays one
// entry that reads as newest. Kept factual — the supervisor escalates; the human
// decides.
export function formatEscalation({ now, issue, what, logFile, action, occurrences = 1 }) {
  const ts = new Date(now).toISOString();
  return [
    `## ${ts} — issue #${issue}`,
    `- What happened: ${what}`,
    `- Log file: ${logFile || "(none)"}`,
    `- Suggested action: ${action || "review the log and re-queue the issue if its work is unfinished"}`,
    `- Occurrences: ${occurrences}`,
    "",
  ].join("\n");
}

// Deduplicate at the source. Every escalation call path (survey, dispatch,
// monitor, reconcile, review) funnels through here, so one gate governs the whole
// file: an escalation whose (issue, reason-class) matches an existing *unresolved*
// entry bumps that entry's occurrence count and last-seen timestamp in place; a
// new reason-class, or the same reason for a different issue, appends a fresh
// block. "Unresolved" means the matching (issue, reason) has not been
// acknowledged — a recurrence of an acknowledged problem starts a fresh alert.
// The append-only file stays the record: a merge rewrites only the one matching
// block, never another entry's history. A malformed existing file never throws —
// the entry is appended and a warning is logged. Returns true on merge, false on
// append (or on any failure that falls back to append).
function mergeEscalation(path, entry, { acknowledged, warn }) {
  if (!existsSync(path)) return false;
  let md;
  try {
    md = readFileSync(path, "utf8");
    const reason = escalationReason(entry.what);
    const blocks = parseEscalationsRaw(md);
    // Non-empty content that yields no parseable block is corrupt (the file is
    // only ever written by this function): don't lose the escalation — append a
    // fresh entry and warn so an operator can inspect the damaged log.
    if (blocks.length === 0) {
      if (md.trim() !== "") {
        warn(`herd: escalation log ${path} is unparseable; appending a new entry.`);
      }
      return false;
    }
    // Newest matching, still-unresolved block (last in file order = newest).
    let target = null;
    for (const b of blocks) {
      if (String(b.issue) !== String(entry.issue)) continue;
      if (escalationReason(b.what) !== reason) continue;
      if (acknowledged.has(`${b.issue}\t${escalationReason(b.what)}`)) continue;
      target = b;
    }
    if (!target) return false;
    const rewritten = formatEscalation({
      now: entry.now,
      issue: target.issue,
      what: target.what,
      logFile: target.logFile,
      action: target.action,
      occurrences: target.occurrences + 1,
    });
    writeFileSync(path, md.slice(0, target.start) + rewritten + md.slice(target.end));
    return true;
  } catch (err) {
    // A torn or unreadable file must never lose an escalation: fall through to
    // append, but surface the reason so an operator can see the file needs care.
    warn(`herd: could not dedup escalation for issue #${entry.issue} (${err.message}); appending a new entry.`);
    return false;
  }
}

export function appendEscalation(path, entry, { eventsPath = EVENTS_FILE, warn = console.warn, acknowledged = new Set() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const merged = mergeEscalation(path, entry, { acknowledged, warn });
  if (!merged) appendFileSync(path, formatEscalation({ ...entry, occurrences: 1 }) + "\n");
  appendHerdEvent(
    eventsPath,
    {
      now: entry.now,
      event: "escalation",
      issue: entry.issue,
      adapter: entry.adapter,
      pid: entry.pid,
      logFile: entry.logFile,
      attempts: entry.attempts,
      pr: entry.pr,
      status: entry.status,
    },
    warn,
  );
}

// Delete worker log files in `logDir` that are older than `retentionDays` and
// whose issue has no live worker in `state`. A log referenced by a live worker
// (pid alive) is kept regardless of age — its file is being written right now.
// Call after reconcileState so dead/concluded pids are already cleared and no
// longer protect their logs. Only `*.log` files are considered, so the state
// and escalation files are never touched. Every filesystem hiccup (a missing
// directory, a file that vanishes mid-pass, an unremovable file) is swallowed
// so a poll never crashes on log hygiene; it simply prunes what it can and
// retries the rest next poll. Returns the count of files deleted.
export function pruneLogs({ logDir, retentionDays, state, isAlive = isPidAlive, now = Date.now() }) {
  if (!logDir || !existsSync(logDir)) return 0;
  const protectedLogs = new Set(
    Object.values(state || {})
      .filter((e) => e && e.pid != null && isAlive(e.pid) && e.logFile)
      .map((e) => basename(e.logFile)),
  );
  const cutoff = now - retentionDays * 86400 * 1000;
  let names;
  try {
    names = readdirSync(logDir);
  } catch {
    return 0; // logDir disappeared between the existsSync check and the read
  }
  let pruned = 0;
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    if (protectedLogs.has(name)) continue;
    const full = join(logDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // file vanished (e.g. a concurrent poll pruned it) — skip
    }
    if (!st.isFile() || st.mtimeMs >= cutoff) continue;
    try {
      rmSync(full);
      pruned++;
    } catch {
      /* unremovable (permissions, race) — leave it for the next poll */
    }
  }
  return pruned;
}

// One supervisor pass: survey, reconcile the state file, escalate anomalies,
// prune the concluded/dead entries those escalations describe (so a re-queued
// issue is no longer skipped forever), report a one-line summary, and point at
// /ratchet-status when the fleet is idle. A failed `gh` call logs one line and
// returns { ok: false } so the loop retries next poll instead of crashing.
// Injectable deps keep it fully offline in tests.
export async function pollOnce({
  gh,
  ghc = null,
  etags = null,
  isAlive = isPidAlive,
  now,
  statePath = STATE_FILE,
  escalationsPath = ESCALATIONS_FILE,
  eventsPath = EVENTS_FILE,
  log = console.log,
  config = null,
  prune = pruneLogs,
}) {
  const stamp = now ?? Date.now();

  // Heartbeat first, before anything that can fail. The point of the heartbeat
  // is to prove the supervisor is alive and still polling, so it must land once
  // per poll pass whether or not the survey below succeeds — a poll whose gh
  // survey fails is a live supervisor with a transient outage, not a dead one.
  // Its append failure is swallowed, not warned: a heartbeat fires every poll,
  // so a warning per poll on a broken events path would flood the log — and the
  // user-facing signal for missing heartbeats is the dashboard's "supervisor
  // not seen / silent" banner, not a log line.
  appendHerdEvent(eventsPath, { now: stamp, event: "heartbeat" }, () => {});

  let reality;
  if (ghc && etags) {
    // Conditional fast path: probe each endpoint with its cached ETag. When
    // every endpoint returns 304 the tick short-circuits here — no reconcile, no
    // state write, no downstream verify/review (the caller keys off `skipped`),
    // and the pass costs zero rate limit. Any 200 (or a fallback) yields the
    // full reality below, exactly as an unconditional survey would.
    let survey;
    try {
      survey = await surveyConditional({ ghc, gh, etags, eventsPath, now: stamp, log });
    } catch (e) {
      log(`herd: gh survey failed: ${e.message}; retrying next poll.`);
      return { ok: false };
    }
    if (!survey.changed) {
      log("herd: poll — no upstream changes (all endpoints 304); skipping survey/verify/review.");
      return { ok: true, skipped: true };
    }
    reality = survey.reality;
  } else {
    try {
      reality = await surveyReality(gh);
    } catch (e) {
      log(`herd: gh survey failed: ${e.message}; retrying next poll.`);
      return { ok: false };
    }
  }

  const openPrNumbers = new Set(reality.openPrs.map((p) => Number(p.number)));
  const prByHead = new Map(reality.openPrs.map((p) => [p.headRefName, Number(p.number)]));
  const { state, changes, adopted } = reconcileState(readState(statePath), { openPrNumbers, prByHead }, isAlive);

  // A finished worker whose PR the supervisor missed (down during its exit) is
  // adopted into verification rather than flagged dead and pruned. Log exactly
  // one pr-detected event per adoption — the same signal the monitor's
  // classifyExit emits — so the verify stage and the dashboard both see it.
  for (const a of adopted) {
    appendHerdEvent(eventsPath, {
      now: stamp,
      event: "pr-detected",
      issue: a.issue,
      adapter: a.adapter,
      pid: null,
      logFile: a.logFile,
      attempts: a.attempts,
      pr: a.pr,
      status: "awaiting-verification",
    }, log);
  }

  for (const c of changes) {
    appendEscalation(escalationsPath, {
      now: stamp,
      issue: c.issue,
      what: c.what,
      adapter: c.adapter,
      pid: c.pid,
      logFile: c.logFile,
      attempts: c.attempts,
      pr: c.pr,
      status: c.status,
      action: "reconciled on startup — review the log and re-queue the issue if its work is unfinished",
    }, { eventsPath, warn: log });
  }

  // Prune each reconciled entry only after its escalation is written. A stale
  // entry left in the state file makes dispatchOne skip that issue forever, so a
  // re-queued issue could never be picked up again. Remove an entry only when
  // its worker is gone (pid cleared or dead) AND it tracks no open PR — a live
  // worker or an open PR is always retained, no matter what was flagged.
  let pruned = 0;
  for (const c of changes) {
    const e = state[c.issue];
    if (!e) continue;
    const workerGone = e.pid == null || !isAlive(e.pid);
    const prConcluded = e.pr == null || !openPrNumbers.has(Number(e.pr));
    if (workerGone && prConcluded) {
      delete state[c.issue];
      pruned += 1;
    }
  }

  // Terminal entries reconcile never flags. A terminal status (dispatch-failed,
  // escalated, verify-escalated) carries pid:null/pr:null, so reconcileState —
  // which only flags a dead pid or a concluded PR — emits no change for it, and
  // the change-driven prune above never touches it. It then lingers in the state
  // file forever, and because dispatchOne skips any issue present in state, its
  // issue can never be re-dispatched (issue-0065 fixed this for the
  // pr-concluded/dead case; the no-pid/no-PR terminal case was missed). Its
  // escalation was already written when it entered the terminal state (dispatch,
  // the monitor, and verify each escalate at that point), so prune it here
  // without re-escalating — re-escalating every poll would spam the channel.
  // A terminal entry still backed by a live worker or an open PR
  // (awaiting-verification / ready-for-review) is always retained.
  let terminalPruned = 0;
  for (const [issue, entry] of Object.entries(state)) {
    if (!TERMINAL_STATUS.has(entry.status)) continue;
    const workerGone = entry.pid == null || !isAlive(entry.pid);
    const prConcluded = entry.pr == null || !openPrNumbers.has(Number(entry.pr));
    if (workerGone && prConcluded) {
      delete state[issue];
      terminalPruned += 1;
    }
  }

  // Stale claim refs. A branch agent/issue-<N> left on origin by a dead worker
  // (it raced the kill, or simply died) keeps the issue claimed forever: every
  // future claim 422s and the worker refuses the issue, with no signal to the
  // operator. The supervisor never deletes branches — it detects the ref, and
  // escalates naming it and the exact delete command. A gh failure listing refs
  // skips detection this poll, so a transient blip never fabricates a stale
  // claim. Each stale ref is escalated once: a `stale-claim` sentinel entry
  // remembers it (and makes dispatch skip the issue while the ref still blocks
  // it), cleared once the ref is gone so a genuine recurrence re-escalates.
  let staleEscalated = 0;
  let claimIssues = null;
  try {
    claimIssues = await listClaimRefs(gh);
  } catch (e) {
    log(`herd: stale-claim ref check failed: ${e.message}; skipping stale detection this poll.`);
  }
  if (claimIssues != null) {
    const openPrHeads = new Set(reality.openPrs.map((p) => p.headRefName));
    const stale = new Set(findStaleClaims(claimIssues, state, openPrHeads, isAlive));
    for (const [issue, entry] of Object.entries(state)) {
      if (entry.status === STALE_CLAIM_STATUS && !stale.has(Number(issue))) delete state[issue];
    }
    for (const issue of stale) {
      if (state[String(issue)]?.status === STALE_CLAIM_STATUS) continue; // already escalated once
      const del = deleteRefCommand(issue);
      let open;
      try {
        open = await issueIsOpen(gh, issue);
      } catch (e) {
        log(`herd: issue-state check failed for #${issue}: ${e.message}; skipping this stale ref this poll.`);
        continue;
      }
      if (open) {
        appendEscalation(escalationsPath, {
          now: stamp,
          issue,
          what:
            `stale claim ref agent/issue-${issue} on origin: no live worker and no open PR, yet the ref still holds the claim, ` +
            `so every future worker 422s and refuses the issue. Delete it to free the issue: ${del}`,
          logFile: null,
          action: `run \`${del}\` to delete the stale claim ref, then re-queue the issue if its work is unfinished`,
        });
        state[String(issue)] = { adapter: null, pid: null, logFile: null, attempts: 0, status: STALE_CLAIM_STATUS, pr: null };
      } else {
        appendEscalation(escalationsPath, {
          now: stamp,
          issue,
          what:
            `stale claim ref agent/issue-${issue} on origin: the issue is closed (work done), so the ref is pure garbage — ` +
            `nothing to re-queue. Delete it: ${del}`,
          logFile: null,
          action: `run \`${del}\` to delete the stale claim ref`,
        });
      }
      staleEscalated += 1;
    }
  }

  writeState(statePath, state);

  // Log hygiene runs after the state is reconciled and written: dead and
  // concluded entries are gone, so only genuinely live workers now protect
  // their logs. Skipped when no config is supplied (logDir/logRetentionDays
  // live there).
  const prunedLogs = config
    ? prune({ logDir: config.logDir, retentionDays: config.logRetentionDays, state, isAlive, now: stamp })
    : 0;

  const liveWorkers = Object.values(state).filter((e) => e.pid != null && isAlive(e.pid)).length;
  const idle = reality.ready.length === 0 && liveWorkers === 0;

  // One summary line per pass, so an operator watching the poll sees its shape —
  // including how many concluded state entries and stale log files it pruned.
  log(
    `herd: poll — ${reality.ready.length} ready, ${reality.inProgress.length} in-progress, ` +
      `${openPrNumbers.size} open PRs, ${liveWorkers} live workers, ` +
      `${pruned} concluded ${pruned === 1 ? "entry" : "entries"} pruned, ` +
      `${terminalPruned} terminal ${terminalPruned === 1 ? "entry" : "entries"} pruned, ` +
      `${prunedLogs} log file(s) pruned.`,
  );
  if (staleEscalated) {
    log(
      `herd: escalated ${staleEscalated} stale claim ${staleEscalated === 1 ? "ref" : "refs"} ` +
        `(agent/issue-<N> on origin with no live worker and no open PR) — see ${escalationsPath}.`,
    );
  }
  if (idle) {
    log(
      "herd: no state:ready issues and no live workers. Run /ratchet-status to diagnose the " +
        "queue (drafts missing criteria, blocked chains, or an unmerged planning PR).",
    );
  }

  return {
    ok: true,
    ready: reality.ready.length,
    inProgress: reality.inProgress.length,
    openPrs: openPrNumbers.size,
    reconciled: changes.length,
    adopted: adopted.length,
    pruned,
    terminalPruned,
    staleEscalated,
    liveWorkers,
    prunedLogs,
    idle,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serialize supervisor passes so no two overlap — the guarantee that keeps two
// claim windows from opening at once (plan 0173, AGENTS.md §2). Only one pass
// runs at a time; a tick or event arriving mid-pass sets a pending flag and is
// coalesced into one follow-up pass, a pending tick (heartbeat) winning over a
// pending event so heartbeats are never dropped nor doubled. A throwing pass is
// routed to onError and never propagates. `tick()`/`event()` return the batch's
// settle promise; `idle()` awaits the current batch.
export function createSupervisorPump({ runPass, onError = null }) {
  let running = false;
  let pendingTick = false;
  let pendingEvent = false;
  let chain = Promise.resolve();
  const drive = () => {
    if (running) return chain;
    running = true;
    chain = (async () => {
      try {
        for (;;) {
          let kind;
          if (pendingTick) {
            pendingTick = false;
            kind = "tick";
          } else if (pendingEvent) {
            pendingEvent = false;
            kind = "event";
          } else break;
          try {
            await runPass(kind);
          } catch (e) {
            if (onError) await onError(e, kind);
            else throw e;
          }
        }
      } finally {
        running = false;
      }
    })();
    return chain;
  };
  return {
    tick() {
      pendingTick = true;
      return drive();
    },
    event() {
      pendingEvent = true;
      return drive();
    },
    idle() {
      return chain;
    },
  };
}

// Pump onError: log a failed pass as a herd event and swallow it, so a throw in
// an event pass never crashes the supervisor — the next tick reconciles (plan
// 0173). A tick pass rethrows, preserving the pre-0173 "unexpected error stops
// the loop" contract (herd.mjs's onLoopError surfaces it).
function passErrorHandler({ eventsPath = EVENTS_FILE, log = console.log, now = () => Date.now() } = {}) {
  return (e, kind) => {
    appendHerdEvent(eventsPath, { now: now(), event: "supervisor-pass-error", kind, message: e.message }, () => {});
    log(`herd: ${kind} pass failed: ${e.message}; continuing — the next tick reconciles.`);
    if (kind !== "event") throw e;
  };
}

// The poll loop. `--once` runs one pass and returns; the default polls every
// pollSeconds. `step` is the per-pass work (defaulting to pollOnce; the
// dispatcher composes survey + dispatch into it, receiving the pass `kind`),
// `sleep` bounds the loop in tests, and `onExitSignal(fn)` registers a worker-
// exit listener so a local exit fires an immediate reactive pass. The tick
// metronome is independent of event passes, so a reaction never shifts cadence.
export async function runLoop(opts) {
  const { once = false, pollSeconds = 15, sleep = defaultSleep, step = pollOnce, onExitSignal = null } = opts;
  const pump = createSupervisorPump({
    runPass: (kind) => step({ ...opts, kind }),
    onError: passErrorHandler(opts),
  });
  if (onExitSignal) onExitSignal(() => pump.event());
  await pump.tick();
  await pump.idle();
  if (once) return;
  for (;;) {
    await sleep(pollSeconds * 1000);
    await pump.tick();
    await pump.idle();
  }
}

// ── Scoped runs (issue #357): a `herd run --issue/--issues` restricted to an
// explicit target set. Unlike the open-ended runLoop it reports *why* a named
// issue is skipped (never a silent drop) and is finite — it refuses to start
// when nothing is dispatchable and stops once every eligible target has finished.

// Exit code for a scoped run in which every requested issue was ineligible:
// nothing to dispatch, so it fails loudly rather than idling. Distinct from the
// config error (1) and argv parse error (2) — "targets all unrunnable" vs "bad flags".
export const SCOPED_NO_ELIGIBLE_EXIT = 3;

// Statuses at which a scoped target is finished from the supervisor's point of
// view: its PR is up for human review, or the pipeline escalated/failed and now
// waits on a human. This is deliberately a *subset* of TERMINAL_STATUS —
// `awaiting-verification` is excluded because the supervisor is still actively
// verifying that entry, so a scoped run must keep polling until it resolves one
// way or the other rather than declaring the target done mid-verification.
export const SCOPED_DONE_STATUS = new Set([
  "ready-for-review",
  "verify-escalated",
  "escalated",
  "dispatch-failed",
]);

// Fetch { state, labels } for each requested target issue, one `gh issue view`
// per number (in parallel). A per-issue gh failure is recorded as { error }
// rather than thrown, so one unreadable issue is reported as ineligible instead
// of aborting the whole run. Returns an object keyed by number; `gh` is injected.
export async function surveyTargets(gh, targets) {
  const entries = await Promise.all(
    (targets || []).map(async (n) => {
      try {
        const d = await gh(["issue", "view", String(n), "--json", "number,state,labels"]);
        return [n, { state: d?.state ?? null, labels: (d?.labels || []).map((l) => l.name) }];
      } catch (e) {
        return [n, { error: (e && e.message) || String(e) }];
      }
    }),
  );
  return Object.fromEntries(entries);
}

// Pure. Split the requested targets into the set eligible to dispatch and the
// ineligible ones, each carrying a single reason and human-readable detail. A
// requested issue is ineligible when it is unreadable, closed, `state:blocked`,
// already tracked in the state file, or not `state:ready` — mirroring the pick
// rule in AGENTS.md §1, so targeting is a selection filter and never a state
// bypass. Checks run most-specific first; the first match is the reason
// reported. `info` is surveyTargets' output; `state` is the current state file.
export function classifyTargets(targets, info, state) {
  const eligible = [];
  const ineligible = [];
  for (const n of targets || []) {
    const i = info[n] || info[String(n)] || {};
    const labels = new Set(i.labels || []);
    let reason = null;
    let detail = null;
    if (i.error || i.state == null) {
      reason = "not-found";
      detail = i.error ? `it could not be read from GitHub (${i.error})` : "it could not be read from GitHub";
    } else if (i.state === "CLOSED") {
      reason = "closed";
      detail = "the issue is closed";
    } else if (labels.has("state:blocked")) {
      reason = "blocked";
      detail = "the issue is state:blocked";
    } else if (String(n) in state) {
      reason = "already-tracked";
      detail = `the issue is already in the state file (status: ${state[String(n)]?.status ?? "unknown"})`;
    } else if (!labels.has("state:ready")) {
      const st = [...labels].find((l) => l.startsWith("state:")) || "no state label";
      reason = "not-ready";
      detail = `the issue is not state:ready (${st})`;
    }
    if (reason) ineligible.push({ issue: n, reason, detail });
    else eligible.push(n);
  }
  return { eligible, ineligible };
}

// The suggested-action line an ineligible target's escalation carries, keyed by
// the classify reason so an operator is told exactly how to make it runnable.
function scopedIneligibleAction(reason) {
  switch (reason) {
    case "closed":
      return "drop it from the target list — the issue is already closed";
    case "blocked":
      return "clear its blocker (see the blocking issue) and re-run once it is state:ready";
    case "already-tracked":
      return "let the in-flight worker finish, or clear its state-file entry, before targeting it again";
    case "not-found":
      return "check the issue number — it could not be read from GitHub";
    default:
      return "move it to state:ready (finish planning / unblock it) before targeting it";
  }
}

// Pure. Accumulate finished targets into `completed` and report whether every
// eligible target is now done. A target is finished when its issue is closed (a
// merge or manual close mid-run is terminal — see the test note on #357) or its
// state-file entry has reached a SCOPED_DONE_STATUS. Accumulating into a set is
// what makes this robust to pollOnce's terminal-entry prune: a status seen in
// one pass is remembered even though the next pass deletes the entry. Mutates
// and returns `completed`.
export function markScopedComplete(eligible, state, info, completed) {
  for (const n of eligible) {
    if (completed.has(n)) continue;
    const i = info[n] || info[String(n)] || {};
    const entry = state[String(n)];
    if (i.state === "CLOSED" || (entry && SCOPED_DONE_STATUS.has(entry.status))) completed.add(n);
  }
  return completed;
}

// Drive a scoped `herd run`. Up front it surveys and classifies the requested
// targets: every ineligible one is escalated once (with its reason and a fix)
// and logged, and never dispatched. If *every* requested issue is ineligible the
// run does not enter the loop at all — it returns SCOPED_NO_ELIGIBLE_EXIT with
// zero workers spawned. Otherwise it polls like runLoop but hands `step` only
// the eligible target set, and after each pass re-surveys the targets and marks
// the finished ones; the moment all eligible targets are done it exits 0 rather
// than polling forever. `step` is the same per-pass work the open loop runs;
// `--once`/`--dry-run` (once:true) still cap it at a single pass.
export async function scopedRun(opts) {
  const {
    gh,
    targets,
    statePath = STATE_FILE,
    escalationsPath = ESCALATIONS_FILE,
    eventsPath = EVENTS_FILE,
    log = console.log,
    step = pollOnce,
    once = false,
    dryRun = false,
    pollSeconds = 15,
    sleep = defaultSleep,
    now = () => Date.now(),
    onExitSignal = null,
    ...rest
  } = opts;

  const info = await surveyTargets(gh, targets);
  const { eligible, ineligible } = classifyTargets(targets, info, readState(statePath));
  for (const bad of ineligible) {
    log(
      `herd: issue #${bad.issue} is ineligible for this scoped run (${bad.reason}): ${bad.detail}. It will not be dispatched.`,
    );
    // A dry run previews the plan without touching the escalations log or event
    // stream — the reason is logged above, but nothing is persisted.
    if (dryRun) continue;
    appendEscalation(
      escalationsPath,
      {
        now: now(),
        issue: bad.issue,
        what: `requested as a scoped-run target but ineligible (${bad.reason}): ${bad.detail}. It was not dispatched.`,
        logFile: null,
        action: scopedIneligibleAction(bad.reason),
      },
      { eventsPath, warn: log },
    );
  }
  if (eligible.length === 0) {
    log(
      `herd: every requested issue (${(targets || []).map((n) => `#${n}`).join(", ")}) is ineligible; ` +
        "nothing to dispatch. Exiting non-zero.",
    );
    return { exitCode: SCOPED_NO_ELIGIBLE_EXIT, spawned: 0, eligible, ineligible };
  }

  log(
    `herd: scoped run over ${eligible.map((n) => `#${n}`).join(", ")}; ` +
      "will exit once every target has finished.",
  );
  const completed = new Set();
  let finished = false;
  const result = () => ({ exitCode: 0, spawned: eligible.length, eligible, ineligible, completed: [...completed] });
  // After each settled pass, re-survey the targets and accumulate the finished
  // ones — accumulating makes completion robust to pollOnce's terminal-entry
  // prune, and a concluding target is reported (why), never a silent drop.
  const checkComplete = async () => {
    const passInfo = await surveyTargets(gh, eligible).catch(() => ({}));
    const st = readState(statePath);
    const before = new Set(completed);
    markScopedComplete(eligible, st, passInfo, completed);
    for (const n of eligible) {
      if (before.has(n) || !completed.has(n)) continue;
      const closed = (passInfo[n] || passInfo[String(n)] || {}).state === "CLOSED";
      log(`herd: scoped target #${n} finished (${closed ? "issue closed" : st[String(n)]?.status ?? "terminal"}).`);
    }
    if (eligible.every((n) => completed.has(n))) {
      finished = true;
      log(`herd: all scoped targets finished (${eligible.map((n) => `#${n}`).join(", ")}). Exiting.`);
    }
  };
  const pump = createSupervisorPump({
    runPass: async (kind) => {
      await step({ gh, statePath, escalationsPath, eventsPath, log, once, pollSeconds, sleep, ...rest, kind, targets: eligible });
      await checkComplete();
    },
    onError: passErrorHandler({ eventsPath, log, now }),
  });
  // A local worker exit drives an immediate reactive pass; the moment it carries
  // the final target to a terminal state the run exits, even between ticks.
  if (onExitSignal) onExitSignal(() => pump.event());
  await pump.tick();
  await pump.idle();
  // `--once`/`--dry-run`: a single pass was requested, so stop even if targets
  // have not all finished — the caller only asked to survey/dispatch once.
  if (finished || once) return result();
  for (;;) {
    await sleep(pollSeconds * 1000);
    if (finished) return result(); // an event pass completed the run during the sleep
    await pump.tick();
    await pump.idle();
    if (finished) return result();
  }
}
