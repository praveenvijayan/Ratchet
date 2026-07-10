#!/usr/bin/env node
// herd-review.mjs — the ratchet-herd review-verdict reactor. Verification ends a
// worker at the terminal status "ready-for-review" (herd-verify.mjs); nothing
// revisits it, so a human's Request Changes review on that PR used to fall on the
// floor in herd mode — no component polled the PR's review decision, and the
// worker that opened it had already exited (observed on PR #188 / issue #165:
// review submitted CHANGES_REQUESTED, label stuck at state:in-review with no
// rework dispatched). This stage closes that open circuit: each poll it reads the
// review decision of every tracked, ready-for-review PR and, on CHANGES_REQUESTED,
// dispatches exactly one rework worker on the issue's existing branch — the same
// role a human plays in chat mode when they notice the rejection and run
// /ratchet-next. It is detection + dispatch only; it never re-implements rework.
//
// Two signals gate a dispatch, and both must hold:
//   1. the PR's `reviewDecision` is CHANGES_REQUESTED (an APPROVED/COMMENTED/absent
//      verdict dispatches nothing), and
//   2. the issue still carries `state:changes-requested`.
// Signal 2 is the per-rejection dedup. `reviewDecision` stays CHANGES_REQUESTED
// until a *new* review is submitted, so it does not change when the rework worker
// pushes its fix — polling it alone would re-dispatch (and eventually escalate) a
// PR that is merely awaiting re-review. The label is authoritative: the
// review-verdict workflow (0098) sets state:changes-requested on each rejection,
// and the rework worker flips it back to state:in-review when its rework lands
// (AGENTS.md step 6). While the label reads changes-requested the rework is
// outstanding; once it reads in-review this stage stands down until the next
// rejection. A live worker on the entry is likewise left alone — a rework already
// in flight is never dispatched twice.
//
// A rework here counts against the same `entry.attempts` / `config.reworkCap`
// budget the monitor and verify stages share; at the cap the PR is escalated
// naming it and the cap, never re-dispatched. Like the rest of herd, this stage
// NEVER merges, approves, closes, or labels — the flip back to state:in-review is
// the dispatched worker's job, not the supervisor's. Every outside-world call is
// injectable, so it runs offline in tests. Zero dependencies.

import { substitute } from "./herd.mjs";
import { STATE_FILE, ESCALATIONS_FILE, EVENTS_FILE, readState, writeState, appendEscalation, appendHerdEvent, isPidAlive } from "./herd-survey.mjs";
import { spawnWorker, recordExit } from "./herd-dispatch.mjs";

// The rework a changes-requested PR gets: read the review feedback and address it
// on the existing branch, then push and hand the issue back to review. {issue}/{pr}
// are filled in before the adapter argv is rendered. Unlike a fresh dispatch this
// points the worker at the PR's review, and unlike the conflict rework it directs
// the AGENTS.md step 6 flip back to state:in-review so this stage stays label-free.
export const REVIEW_REWORK_PROMPT =
  "PR #{pr} for issue #{issue} received a Request Changes review. In its worktree (../wt/issue-{issue}), " +
  "read the PR's review feedback (the review summary and every line comment), address each point with " +
  "focused commits, re-run the GATES.md gates fail-fast (never push red), and push to update the existing " +
  "PR — do not open a new one. Reply to each review comment with the commit that resolves it, then set the " +
  "issue back to state:in-review for re-review.";

// Decide a tracked ready-for-review PR's fate from its review decision and whether
// its issue still carries state:changes-requested. Pure and total. `reworkCap`
// bounds the shared automation-attempt budget (`entry.attempts`, which
// dispatch/monitor/verify also count): a review rework is one more attempt.
export function classifyReview(issue, entry, { reviewDecision, changesRequested, reworkCap }) {
  // Only a Request Changes verdict acts; APPROVED / COMMENTED / null (no required
  // review, or GitHub still computing) dispatch nothing.
  if (reviewDecision !== "CHANGES_REQUESTED") return { action: "noop" };
  // The rework worker flips the issue back to state:in-review when its fix lands,
  // so a changes-requested verdict whose label already reads in-review is an
  // outstanding re-review, not a fresh rejection — stand down until the next one.
  if (!changesRequested) return { action: "noop" };
  const attempts = Number.isInteger(entry.attempts) ? entry.attempts : 1;
  if (attempts >= reworkCap) return { action: "escalate-review-capped", attempts };
  return { action: "rework", attempts: attempts + 1 };
}

// The rework dispatch for a changes-requested PR: the adapter's `resume` argv
// (falling back to `launch`) carrying the review-rework prompt, its env, and the
// same log file. Returns null when the entry's adapter is gone from the config —
// caller escalates.
export function buildReviewRework(config, entry, issue, pr) {
  const adapter = config.adapters[entry.adapter];
  if (!adapter) return null;
  const command = Array.isArray(adapter.resume) && adapter.resume.length ? adapter.resume : adapter.launch;
  const prompt = REVIEW_REWORK_PROMPT.replaceAll("{pr}", String(pr)).replaceAll("{issue}", String(issue));
  return {
    argv: substitute(command, { prompt, issue, model: adapter.model }),
    env: adapter.env || {},
    logFile: entry.logFile || `${config.logDir}/issue-${issue}`,
  };
}

// One review-reactor pass: read every open PR's review decision plus the set of
// issues currently labelled state:changes-requested, then for every tracked,
// ready-for-review PR act on the deterministic outcome (rework / escalate / noop).
// A failed survey of either signal logs one line and leaves every entry untouched
// for the next poll — a transient read never misreads a verdict. Returns
// { ok, transitions }.
export async function reviewOnce(opts) {
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
  } = opts;

  // Read the review decision of every open PR. A failed read leaves all entries
  // untouched (retried next poll) rather than risk acting on a stale verdict.
  let openPrs;
  try {
    openPrs = await gh(["pr", "list", "--state", "open", "--json", "number,headRefName,reviewDecision", "--limit", "200"]);
  } catch (e) {
    log(`herd: review PR survey failed: ${e.message}; skipping review this poll.`);
    return { ok: false };
  }
  const reviewByHead = new Map(
    (openPrs || []).map((p) => [p.headRefName, { pr: Number(p.number), reviewDecision: p.reviewDecision }]),
  );

  // The authoritative per-rejection signal: issues a human has rejected and whose
  // rework has not yet flipped them back to state:in-review. A failed read is the
  // same transient-blip case — untouched, retried next poll.
  let crIssues;
  try {
    crIssues = await gh(["issue", "list", "--state", "open", "--label", "state:changes-requested", "--json", "number", "--limit", "200"]);
  } catch (e) {
    log(`herd: review label survey failed: ${e.message}; skipping review this poll.`);
    return { ok: false };
  }
  const changesRequested = new Set((crIssues || []).map((i) => Number(i.number)));

  const state = readState(statePath);
  const transitions = [];
  for (const [issue, entry] of Object.entries(state)) {
    // A rework already in flight is never dispatched twice.
    if (entry.pid != null && isAlive(entry.pid)) continue;
    // Only revisit PRs the supervisor already declared ready for review — the
    // exact terminal status nothing else reopens.
    if (entry.status !== "ready-for-review") continue;
    const review = reviewByHead.get(`agent/issue-${issue}`);
    if (!review) continue; // no open PR for this issue right now

    const decision = classifyReview(issue, entry, {
      reviewDecision: review.reviewDecision,
      changesRequested: changesRequested.has(Number(issue)),
      reworkCap: config.reworkCap,
    });
    if (decision.action === "noop") continue;

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
        pr: review.pr,
        status: entry.status,
        action,
      }, { eventsPath, warn: log });
    };
    let line;

    if (decision.action === "escalate-review-capped") {
      escalate(
        `PR #${review.pr} still has a Request Changes review after ${decision.attempts} attempt(s) — reworkCap ${config.reworkCap} reached, not re-dispatching.`,
        `address the review feedback on PR #${review.pr}'s branch by hand, then re-review`,
      );
      line = `herd: issue #${issue} -> escalated (PR #${review.pr} changes-requested; reworkCap ${config.reworkCap} reached after ${decision.attempts} attempts)`;
    } else {
      // rework
      const rework = buildReviewRework(config, entry, issue, review.pr);
      if (!rework) {
        escalate(
          `PR #${review.pr} has a Request Changes review but adapter "${entry.adapter}" is no longer in the config — cannot dispatch a rework.`,
          "restore the adapter in .ratchet/herd.json, or address the review feedback by hand",
        );
        line = `herd: issue #${issue} -> escalated (adapter "${entry.adapter}" missing; cannot rework)`;
      } else {
        let pid = null;
        try {
          pid = spawnFn(rework.argv, rework.env, rework.logFile, (code, signal) => recordExit(statePath, issue, code, signal, { config, eventsPath, now, warn: log }));
        } catch (e) {
          escalate(`review rework spawn for PR #${review.pr} failed: ${e.message}`, "check the adapter command in .ratchet/herd.json; the resume CLI may be missing or unexecutable");
          line = `herd: issue #${issue} -> escalated (review rework spawn failed: ${e.message})`;
        }
        if (pid != null) {
          entry.attempts = decision.attempts;
          entry.pid = pid;
          entry.status = "reworking";
          entry.pr = review.pr;
          delete entry.exitCode; // a stale exit must not re-classify the rework run
          delete entry.exitSignal;
          appendHerdEvent(eventsPath, {
            now: now(),
            event: "rework",
            issue,
            adapter: entry.adapter,
            pid,
            logFile: rework.logFile,
            attempts: entry.attempts,
            pr: review.pr,
            status: entry.status,
          }, log);
          line = `herd: issue #${issue} -> rework (PR #${review.pr} changes-requested; attempt ${decision.attempts}/${config.reworkCap}, ${entry.adapter} pid ${pid})`;
        }
      }
    }

    log(line);
    transitions.push({ issue: Number(issue), action: decision.action, line });
  }

  writeState(statePath, state);
  return { ok: true, transitions };
}
