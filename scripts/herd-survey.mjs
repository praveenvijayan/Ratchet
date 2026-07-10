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
  const line = { ts: new Date(now).toISOString(), event, issue: Number(issue) };
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

// Reconcile the state file against reality instead of trusting it: an entry
// whose tracked PR is no longer open (merged or closed), or whose worker pid is
// no longer alive, is cleared and flagged. Returns the reconciled state plus
// the list of changes (each an escalation candidate).
export function reconcileState(state, reality, isAlive) {
  const openPrs = reality.openPrNumbers instanceof Set
    ? reality.openPrNumbers
    : new Set((reality.openPrNumbers || []).map(Number));
  const next = {};
  const changes = [];
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
    next[issue] = e;
  }
  return { state: next, changes };
}

// A human-readable escalation block: timestamp, issue, what happened, the log
// file to inspect, and a suggested next action. Kept factual — the supervisor
// escalates; the human decides.
export function formatEscalation({ now, issue, what, logFile, action }) {
  const ts = new Date(now).toISOString();
  return [
    `## ${ts} — issue #${issue}`,
    `- What happened: ${what}`,
    `- Log file: ${logFile || "(none)"}`,
    `- Suggested action: ${action || "review the log and re-queue the issue if its work is unfinished"}`,
    "",
  ].join("\n");
}

export function appendEscalation(path, entry, { eventsPath = EVENTS_FILE, warn = console.warn } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, formatEscalation(entry) + "\n");
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
  isAlive = isPidAlive,
  now,
  statePath = STATE_FILE,
  escalationsPath = ESCALATIONS_FILE,
  eventsPath = EVENTS_FILE,
  log = console.log,
  config = null,
  prune = pruneLogs,
}) {
  let reality;
  try {
    reality = await surveyReality(gh);
  } catch (e) {
    log(`herd: gh survey failed: ${e.message}; retrying next poll.`);
    return { ok: false };
  }

  const openPrNumbers = new Set(reality.openPrs.map((p) => Number(p.number)));
  const { state, changes } = reconcileState(readState(statePath), { openPrNumbers }, isAlive);

  const stamp = now ?? Date.now();
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
    pruned,
    terminalPruned,
    staleEscalated,
    liveWorkers,
    prunedLogs,
    idle,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The poll loop. `--once` (once: true) runs a single pass and returns; the
// default keeps polling every pollSeconds. `step` is the per-pass work
// (defaulting to pollOnce; the dispatcher composes survey + dispatch into it),
// and `sleep` is injectable so tests can bound the otherwise-infinite loop.
export async function runLoop(opts) {
  const { once = false, pollSeconds = 60, sleep = defaultSleep, step = pollOnce } = opts;
  for (;;) {
    await step(opts);
    if (once) return;
    await sleep(pollSeconds * 1000);
  }
}
