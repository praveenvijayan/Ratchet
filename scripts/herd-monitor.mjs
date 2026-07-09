#!/usr/bin/env node
// herd-monitor.mjs — the ratchet-herd monitor. A worker is done when its process
// exits, and the exit *shape* decides what happens next:
//   1. exit 0 + an open PR with head `agent/issue-<N>` -> hand off to PR
//      verification (status "awaiting-verification"; issue #0055 acts on it).
//   2. exit 0 + no PR -> escalate with the log tail quoted, so the agent's own
//      report (drained queue, blocked question) reaches the human, not a retry.
//   3. nonzero exit OR crash (unknown code) -> a failure: bump `attempts` and
//      relaunch via the adapter's `resume` command (its `launch` when no
//      `resume` is configured — normalizeConfig resolves that).
//   4. attempts has reached `reworkCap` -> escalate and never retry again.
// PR takes precedence: a run that opened a PR then exited 0 is a hand-off. A
// "crash" is any dead worker with no recorded exit 0 — which also covers a
// supervisor restart that lost the exit event, so an orphan is safely retried
// (ratchet-next makes re-dispatch idempotent) rather than mis-escalated. Every
// state change prints ONE compact status line. Like the rest of herd, the
// supervisor never merges, approves, closes, or labels. Every outside-world call
// is injectable, so the monitor runs offline in tests. Zero dependencies.

import { readFileSync } from "node:fs";
import { substitute } from "./herd.mjs";
import { STATE_FILE, ESCALATIONS_FILE, EVENTS_FILE, readState, writeState, appendEscalation, appendHerdEvent, isPidAlive } from "./herd-survey.mjs";
import { spawnWorker, recordExit } from "./herd-dispatch.mjs";

// Statuses the monitor has already resolved — never acted on again.
// "awaiting-verification" hands off to PR verification (herd-verify.mjs);
// "ready-for-review"/"verify-escalated" are that stage's terminal outcomes and
// must not be dragged back to verification; "escalated" is a human's to clear;
// "dispatch-failed" was already killed+escalated by dispatch.
export const TERMINAL_STATUS = new Set([
  "awaiting-verification",
  "ready-for-review",
  "verify-escalated",
  "escalated",
  "dispatch-failed",
]);

// The last `maxLines` lines of a log file, quoted into an escalation so the
// agent's own final words reach the human. A missing/unreadable file is
// reported, never thrown — the monitor must not crash on a vanished log.
export function tailLog(logFile, maxLines = 20) {
  if (!logFile) return "(no log file recorded)";
  let text;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return `(log file unavailable: ${logFile})`;
  }
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const tail = lines.slice(-Math.max(1, maxLines));
  return tail.length ? tail.join("\n") : "(log empty)";
}

// Decide a dead worker's fate from its exit shape and the open-PR map. Pure and
// total: `prByHead` maps a PR head ref -> its number; `reworkCap` bounds retries.
export function classifyExit(issue, entry, { prByHead, reworkCap }) {
  const pr = prByHead.get(`agent/issue-${issue}`);
  if (pr != null) return { action: "verify", pr };
  if (entry.exitCode === 0) return { action: "escalate-clean" };
  const attempts = Number.isInteger(entry.attempts) ? entry.attempts : 1;
  if (attempts >= reworkCap) return { action: "escalate-capped", attempts };
  return { action: "retry", attempts: attempts + 1 };
}

// The resume dispatch for an issue: the adapter's `resume` argv (falling back to
// `launch`), its env, and the same log file so the resumed run appends. Returns
// null when the state entry's adapter is gone from the config — caller escalates.
export function buildResume(config, entry, issue) {
  const adapter = config.adapters[entry.adapter];
  if (!adapter) return null;
  const command = Array.isArray(adapter.resume) && adapter.resume.length ? adapter.resume : adapter.launch;
  const prompt = substitute(adapter.promptTemplate || "", { issue });
  return {
    argv: substitute(command, { prompt, issue }),
    env: adapter.env || {},
    logFile: entry.logFile || `${config.logDir}/issue-${issue}.log`,
  };
}

// One monitor pass: survey open PRs, then for every non-terminal worker whose
// process has exited, apply its exit-shape decision (verify / escalate / resume).
// A failed PR survey logs one line and skips the pass. Returns { ok, transitions }.
export async function monitorOnce(opts) {
  const {
    config,
    statePath = STATE_FILE,
    escalationsPath = ESCALATIONS_FILE,
    eventsPath = EVENTS_FILE,
    gh,
    isAlive = isPidAlive,
    spawn: spawnFn = spawnWorker,
    now = () => Date.now(),
    log = console.log,
    tailLines = 20,
  } = opts;

  let openPrs;
  try {
    openPrs = await gh(["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "200"]);
  } catch (e) {
    log(`herd: monitor PR survey failed: ${e.message}; skipping monitor this poll.`);
    return { ok: false };
  }
  const prByHead = new Map((openPrs || []).map((p) => [p.headRefName, Number(p.number)]));

  const state = readState(statePath);
  const transitions = [];
  for (const [issue, entry] of Object.entries(state)) {
    if (TERMINAL_STATUS.has(entry.status)) continue;
    if (entry.pid != null && isAlive(entry.pid)) continue; // still working — leave it

    const decision = classifyExit(issue, entry, { prByHead, reworkCap: config.reworkCap });
    const escalate = (what, action) => {
      entry.status = "escalated";
      entry.pid = null;
      appendEscalation(escalationsPath, {
        now: now(),
        issue,
        what,
        adapter: entry.adapter,
        pid: entry.pid,
        logFile: entry.logFile,
        attempts: entry.attempts,
        pr: entry.pr,
        status: entry.status,
        action,
      }, { eventsPath, warn: log });
    };
    let line;

    if (decision.action === "verify") {
      entry.status = "awaiting-verification";
      entry.pr = decision.pr;
      entry.pid = null;
      appendHerdEvent(eventsPath, {
        now: now(),
        event: "pr-detected",
        issue,
        adapter: entry.adapter,
        pid: entry.pid,
        logFile: entry.logFile,
        attempts: entry.attempts,
        pr: decision.pr,
        status: entry.status,
      }, log);
      line = `herd: issue #${issue} -> verify (PR #${decision.pr} open)`;
    } else if (decision.action === "escalate-clean") {
      escalate(
        `worker exited 0 without opening a PR — the agent reported a stop (drained queue or a blocked question). Log tail:\n\n${tailLog(entry.logFile, tailLines)}`,
        "read the quoted log tail and act on the agent's report — re-queue the issue, answer the question, or accept the drain",
      );
      line = `herd: issue #${issue} -> escalated (exit 0, no PR — agent report in escalations)`;
    } else if (decision.action === "escalate-capped") {
      escalate(
        `worker failed and reached the rework cap (${config.reworkCap} attempts) — not retrying. Log tail:\n\n${tailLog(entry.logFile, tailLines)}`,
        "inspect the log and decide manually; the automated retry budget is exhausted",
      );
      line = `herd: issue #${issue} -> escalated (reworkCap ${config.reworkCap} reached after ${decision.attempts} attempts)`;
    } else {
      const resume = buildResume(config, entry, issue);
      if (!resume) {
        escalate(
          `worker failed but adapter "${entry.adapter}" is no longer in the config — cannot resume.`,
          "restore the adapter in .ratchet/herd.json, or re-queue the issue for a fresh dispatch",
        );
        line = `herd: issue #${issue} -> escalated (adapter "${entry.adapter}" missing; cannot resume)`;
      } else {
        let pid = null;
        try {
          pid = spawnFn(resume.argv, resume.env, resume.logFile, (code, signal) => recordExit(statePath, issue, code, signal, { eventsPath, now, warn: log }));
        } catch (e) {
          escalate(`resume spawn failed: ${e.message}`, "check the adapter command in .ratchet/herd.json; the resume CLI may be missing or unexecutable");
          line = `herd: issue #${issue} -> escalated (resume spawn failed: ${e.message})`;
        }
        if (pid != null) {
          entry.attempts = decision.attempts;
          entry.pid = pid;
          entry.status = "resumed";
          delete entry.exitCode; // a stale exit must not classify the new run
          delete entry.exitSignal;
          appendHerdEvent(eventsPath, {
            now: now(),
            event: "resume",
            issue,
            adapter: entry.adapter,
            pid,
            logFile: resume.logFile,
            attempts: entry.attempts,
            pr: entry.pr,
            status: entry.status,
          }, log);
          line = `herd: issue #${issue} -> retry ${decision.attempts}/${config.reworkCap} (resume via ${entry.adapter}, pid ${pid})`;
        }
      }
    }

    log(line);
    transitions.push({ issue: Number(issue), action: decision.action, line });
  }

  writeState(statePath, state);
  return { ok: true, transitions };
}
