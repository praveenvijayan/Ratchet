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
import { dirname, basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const STATE_FILE = ".ratchet/herd-state.json";
export const ESCALATIONS_FILE = ".ratchet/herd-escalations.md";

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
      changes.push({ issue, what: `tracked PR #${e.pr} is no longer open (merged or closed)`, logFile: e.logFile || null });
      e.status = "pr-concluded";
      e.pid = null;
    } else if (e.pid != null && !isAlive(e.pid)) {
      changes.push({ issue, what: `worker pid ${e.pid} is not alive`, logFile: e.logFile || null });
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

export function appendEscalation(path, entry) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, formatEscalation(entry) + "\n");
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
      logFile: c.logFile,
      action: "reconciled on startup — review the log and re-queue the issue if its work is unfinished",
    });
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
      `${prunedLogs} log file(s) pruned.`,
  );
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
