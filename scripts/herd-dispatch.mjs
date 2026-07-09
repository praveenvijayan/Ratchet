#!/usr/bin/env node
// herd-dispatch.mjs — the ratchet-herd dispatcher. Picks the top ready issue in
// queue order, routes it to an adapter, spawns a detached worker with its log
// on disk, and serializes the claim window so two workers never race claims in
// the shared clone. One issue -> one worker, ever: the state file is the lock,
// claim-window serialization is the backstop. The supervisor never touches
// worktrees or branches (ratchet-next does) and never merges, approves, closes,
// or labels — a stuck claim escalates rather than improvising.
//
// Every outside-world call (spawn, gh, kill, clock, sleep) is injectable, so
// tests drive stub adapter CLIs offline with no real fleet.
// Zero dependencies. Requires Node 20+.

import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { resolveAdapter, substitute } from "./herd.mjs";
import {
  STATE_FILE,
  ESCALATIONS_FILE,
  readState,
  writeState,
  appendEscalation,
  isPidAlive,
} from "./herd-survey.mjs";

const PRIORITY_RANK = { "priority:high": 0, "priority:medium": 1, "priority:low": 2 };
const labelNames = (issue) => (issue.labels || []).map((l) => l.name);

// Pick the top issue by priority (high > medium > low) then age (oldest first),
// the same ordering AGENTS.md prescribes. Ties break on issue number for
// determinism. Returns null for an empty list.
export function pickNext(ready) {
  const ranked = [...ready].sort((a, b) => {
    const pa = Math.min(99, ...labelNames(a).map((n) => PRIORITY_RANK[n] ?? 99));
    const pb = Math.min(99, ...labelNames(b).map((n) => PRIORITY_RANK[n] ?? 99));
    if (pa !== pb) return pa - pb;
    const ta = a.createdAt || "";
    const tb = b.createdAt || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.number - b.number;
  });
  return ranked.length ? ranked[0] : null;
}

// Resolve an issue to its concrete dispatch: the routed adapter, the argv with
// {prompt}/{issue} substituted, the merged env, and the log file path.
export function buildDispatch(config, issue) {
  const { name, adapter } = resolveAdapter(config, labelNames(issue));
  const prompt = substitute(adapter.promptTemplate || "", { issue: issue.number });
  return {
    adapter: name,
    argv: substitute(adapter.launch, { prompt, issue: issue.number }),
    env: adapter.env || {},
    logFile: `${config.logDir}/issue-${issue.number}.log`,
  };
}

// Spawn a detached worker, redirecting stdout+stderr to logFile (creating its
// directory), with `env` merged over the current environment. Returns the pid.
export function spawnWorker(argv, env, logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...env },
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

export async function surveyReady(gh) {
  return gh(["issue", "list", "--state", "open", "--label", "state:ready", "--json", "number,createdAt,labels", "--limit", "200"]);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultKill = (pid) => process.kill(pid, "SIGTERM");
const liveWorkers = (state, isAlive) =>
  Object.values(state).filter((e) => e.pid != null && isAlive(e.pid)).length;

// Poll gh until the issue leaves state:ready (the worker claimed it) or the
// bounded timeout elapses. A transient gh error is treated as "still waiting"
// so a blip never counts as a claim. Returns { claimed }.
export async function waitForClaim({ gh, issue, timeoutMs, intervalMs = 1000, now = () => Date.now(), sleep = defaultSleep }) {
  const start = now();
  for (;;) {
    let labels = null;
    try {
      labels = labelNames(await gh(["issue", "view", String(issue), "--json", "labels"]));
    } catch {
      labels = null; // transient — keep waiting until the timeout
    }
    if (labels && !labels.includes("state:ready")) return { claimed: true };
    if (now() - start >= timeoutMs) return { claimed: false };
    await sleep(intervalMs);
  }
}

// Dispatch at most one worker this pass. Skips issues already in the state file
// (one worker per issue, ever) and refuses to exceed maxWorkers. On --dry-run
// it returns the plan without spawning. After spawning it serializes on the
// claim window; a timeout kills the worker, marks it dispatch-failed, and
// escalates.
export async function dispatchOne(opts) {
  const {
    config,
    ready,
    statePath = STATE_FILE,
    escalationsPath = ESCALATIONS_FILE,
    spawn: spawnFn = spawnWorker,
    gh,
    isAlive = isPidAlive,
    now = () => Date.now(),
    sleep = defaultSleep,
    log = console.log,
    kill = defaultKill,
    dryRun = false,
    maxWorkers = config.maxWorkers,
    claimTimeoutMs = 60000,
    claimIntervalMs = 1000,
  } = opts;

  const state = readState(statePath);
  const issue = pickNext((ready || []).filter((i) => !(String(i.number) in state)));
  if (!issue) return { dispatched: null, reason: "no-eligible-issue" };

  const plan = buildDispatch(config, issue);
  if (dryRun) {
    log(`herd dry-run: issue #${issue.number} -> ${plan.adapter}: ${plan.argv.join(" ")}`);
    return { dispatched: null, dryRun: true, plan: { issue: issue.number, adapter: plan.adapter, command: plan.argv } };
  }

  const live = liveWorkers(state, isAlive);
  if (live >= maxWorkers) return { dispatched: null, reason: "at-capacity", live, maxWorkers };

  const pid = spawnFn(plan.argv, plan.env, plan.logFile);
  state[issue.number] = { adapter: plan.adapter, pid, logFile: plan.logFile, attempts: 1, status: "dispatched", pr: null };
  writeState(statePath, state);

  const { claimed } = await waitForClaim({ gh, issue: issue.number, timeoutMs: claimTimeoutMs, intervalMs: claimIntervalMs, now, sleep });
  if (!claimed) {
    try {
      kill(pid);
    } catch {
      /* worker already gone */
    }
    const after = readState(statePath);
    if (after[issue.number]) {
      after[issue.number].status = "dispatch-failed";
      after[issue.number].pid = null;
      writeState(statePath, after);
    }
    appendEscalation(escalationsPath, {
      now: now(),
      issue: issue.number,
      what: `worker did not claim the issue within ${Math.round(claimTimeoutMs / 1000)}s; killed pid ${pid}`,
      logFile: plan.logFile,
      action: "inspect the log; the adapter CLI may be missing, misconfigured, or failing to claim",
    });
    return { dispatched: issue.number, claimed: false, status: "dispatch-failed" };
  }
  return { dispatched: issue.number, claimed: true, pid, adapter: plan.adapter };
}
