#!/usr/bin/env node
// sweep-stale-claims.mjs — the pure decision core of the sweep-stale-claims
// workflow. Given one issue's current state plus the freshness signals already
// fetched from the API, decide whether the sweep returns it to state:ready,
// whether its claim ref should be deleted, and the human-readable comment that
// explains why. Kept out of the workflow YAML so it can be unit-tested without
// the network (see sweep-stale-claims.test.mjs) and so what CI runs and what the
// tests assert can never diverge — the same split unblock-dependents uses for
// scripts/criteria.mjs.
//
// Zero dependencies. Node 20+ (ESM).

// Freshness for the time-based states is the shared lease rule (sweep-lease.mjs,
// added for the renewable-lease heartbeat): the freshest proof of life among the
// branch's last commit, a heartbeat comment, and the claim event. Reusing it here
// keeps "is this claim alive?" defined in exactly one place.
import { leaseReference, isStale, isHeartbeat } from "./sweep-lease.mjs";
import { classifyRequeue } from "./criteria.mjs";
import { fileURLToPath } from "node:url";

// The three lifecycle states the sweep patrols. state:in-progress is the
// original claim lease; in-review and changes-requested close the holes where a
// vanished agent used to strand an issue in a non-terminal state forever.
export const SWEPT_STATES = new Set([
  "state:in-progress",
  "state:in-review",
  "state:changes-requested",
]);

// The prefix every sweep comment starts with, one per swept state. This is the
// single source of truth for those markers: the comments below are built from
// it, and ratchet-metrics imports it to count sweeps by exactly the set the
// sweep emits. Add a fourth swept state here and both the comment it posts and
// the metric that counts it stay in lockstep — there is no second list to drift.
export const SWEEP_COMMENT_PREFIXES = {
  "state:in-progress": "Stale claim swept:",
  "state:in-review": "Stale review swept:",
  "state:changes-requested": "Stale rework swept:",
};

// Decide the sweep's action for one issue. All time inputs are epoch ms.
//   input.state        — the issue's current state:* label (see SWEPT_STATES)
//   input.now          — Date.now()
//   input.staleMs      — the configurable inactivity window, in ms
//   input.staleHours   — the same window as a string, for the comment text
//   input.branch       — agent/issue-<N>, for the comment text
//   input.aheadBy      — commits the claim branch is ahead of main (null if none/absent)
//   input.lastCommitAt — the branch's last-commit time, or null
//   input.claimAt      — most recent state:in-progress labeled-event time, or null
//   input.heartbeatAt  — most recent lease-heartbeat comment time, or null
//   input.updatedAt    — issue.updated_at
//   input.branchExists — false when the agent branch is known to be gone
//   input.prState      — open/merged/closed-with-feedback/closed/unknown (in-review only)
//   input.prNumber     — matching PR number, when known
//   input.prClosedAt   — closed PR timestamp, when known
//   input.reworkGraceMs — configurable grace before closed feedback is requeued
//   input.reworkGraceHours — same window as a string, for comment text
// Returns { sweep: false } to leave the issue untouched, or
// { sweep: true, deleteRef, targetState, reason, comment } to move it to
// targetState. `reason` is the diagnostic sentence (why the claim was
// reclaimed); `comment` is the full note, reason plus the outcome sentence.
// The orchestration re-reads the issue at write time and runs the decision
// through classifyRequeue, which rebuilds the comment from `reason` and
// downgrades a state:ready outcome to state:draft when the live body has lost
// its acceptance criteria.
export function decideSweep(input) {
  switch (input.state) {
    case "state:in-progress": return decideInProgress(input);
    case "state:in-review": return decideInReview(input);
    case "state:changes-requested": return decideChangesRequested(input);
    default: return { sweep: false }; // not a swept state — never touch
  }
}

// in-progress: the original claim lease. Freshness is the freshest proof of life
// — the branch's last commit, a heartbeat comment, or the claim event — via the
// shared lease rule, otherwise a quiet main would make every fresh, still-
// building claim look instantly stale. A zero-commit claim (aheadBy === 0) must
// not time from its tip (which IS main HEAD), so its commit signal is withheld.
function decideInProgress({ now, staleMs, staleHours, branch, branchExists = true, aheadBy, lastCommitAt, claimAt, heartbeatAt, updatedAt }) {
  const { ref, source } = leaseReference({
    lastCommitAt: aheadBy > 0 ? lastCommitAt : null,
    heartbeatAt, claimAt, fallbackAt: updatedAt,
  });
  if (!isStale(ref, now, staleMs)) return { sweep: false };
  // A pure claim (zero commits beyond main) is litter — delete the ref so the
  // issue can be cleanly re-claimed. A branch with commits is recoverable work:
  // keep it for a human to inspect.
  const deleteRef = aheadBy === 0;
  const prefix = SWEEP_COMMENT_PREFIXES["state:in-progress"];
  let reason;
  if (branchExists === false) {
    reason = `${prefix} branch no longer exists for \`${branch}\` and no activity was found for >${staleHours}h (measured from ${source}).`;
  } else {
    reason = deleteRef
      ? `${prefix} \`${branch}\` had no work for >${staleHours}h (measured from ${source}). Orphaned claim ref deleted.`
      : `${prefix} no activity on \`${branch}\` for >${staleHours}h (measured from ${source}). Branch kept (has commits).`;
  }
  return { sweep: true, deleteRef, targetState: "state:ready", reason, comment: `${reason} Issue returned to \`state:ready\`.` };
}

// in-review: use the actual PR state from the agent branch. A still-open PR is
// live review work. A merged PR means the work is already done but the issue
// stayed open, so keep it out of the ready queue and make the human cleanup
// visible. A closed PR with review feedback gets a grace window before requeue,
// because AGENTS.md routes that path through same-branch rework.
function decideInReview({ now, branch, prState = "closed", prNumber = null, prClosedAt = null, reworkGraceMs = 0, reworkGraceHours = "0" }) {
  const prefix = SWEEP_COMMENT_PREFIXES["state:in-review"];
  if (prState === "open" || prState === "unknown") return { sweep: false };
  if (prState === "merged") {
    const reason = `${prefix} \`${branch}\` is \`state:in-review\`, but PR #${prNumber} was merged while this issue stayed open.`;
    return {
      sweep: true,
      deleteRef: false,
      targetState: "state:blocked",
      reason,
      comment: `${reason} Issue moved to \`state:blocked\` for human cleanup instead of \`state:ready\`, so merged work is not re-picked.`,
    };
  }
  if (prState === "closed-with-feedback" && (!prClosedAt || now - prClosedAt < reworkGraceMs)) {
    return { sweep: false };
  }
  if (prState === "closed-with-feedback") {
    const reason = `${prefix} \`${branch}\` is \`state:in-review\`, and PR #${prNumber} was closed with review feedback more than ${reworkGraceHours}h ago.`;
    return {
      sweep: true,
      deleteRef: false,
      targetState: "state:ready",
      reason,
      comment: `${reason} Issue returned to \`state:ready\` so it can be re-picked.`,
    };
  }
  const reason = prNumber
    ? `${prefix} \`${branch}\` is \`state:in-review\`, and newest PR #${prNumber} is closed with no review feedback.`
    : `${prefix} \`${branch}\` is \`state:in-review\` but has no open PR from the agent branch.`;
  return {
    sweep: true,
    deleteRef: false,
    targetState: "state:ready",
    reason,
    comment: `${reason} Issue returned to \`state:ready\` so it can be re-picked.`,
  };
}

// changes-requested: after a human asked for changes, a vanished agent leaves
// the issue frozen. Activity is the most recent of the issue's own update
// (comments, label and review events all bump it), the branch's last commit
// (pushed fixes do not bump the issue), and a heartbeat comment (a long rework
// renewing its lease without a push). Recent activity on any front means the
// rework is live — never touched. Its branch has commits — never delete it.
function decideChangesRequested({ now, staleMs, staleHours, branch, lastCommitAt, heartbeatAt, updatedAt }) {
  const activity = Math.max(updatedAt, lastCommitAt ?? 0, heartbeatAt ?? 0);
  if (now - activity < staleMs) return { sweep: false };
  const reason = `${SWEEP_COMMENT_PREFIXES["state:changes-requested"]} \`${branch}\` is \`state:changes-requested\` with no activity for >${staleHours}h.`;
  return {
    sweep: true,
    deleteRef: false,
    targetState: "state:ready",
    reason,
    comment: `${reason} Issue returned to \`state:ready\` so it can be re-picked.`,
  };
}

// --- orchestration: the sweep the workflow runs ------------------------------
// Everything above is the pure decision core (unit-tested without the network).
// Below is the thin driver that used to live inline in the workflow YAML: it
// gathers each issue's freshness signals from the GitHub REST API, calls
// decideSweep, and applies the sweep. Moving it here makes the workflow a single
// `node scripts/sweep-stale-claims.mjs` and lets the orchestration be regression-
// tested against an in-memory API (see sweep-stale-claims.test.mjs).

const API = "https://api.github.com";

// One GitHub REST call; throws (with .status) on any non-2xx so callers can
// distinguish an expected 404 (absent branch) from a real failure.
function ghClient(token) {
  return async function gh(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  };
}

async function paginate(gh, path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh("GET", `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const labelNames = (labels) => labels.map((l) => (typeof l === "string" ? l : l.name));

async function prStateForBranch(gh, repo, owner, branch) {
  const prs = await paginate(gh, `/repos/${repo}/pulls?state=all&head=${owner}:${branch}`);
  if (prs.some((pr) => pr.state === "open")) return { prState: "open" };
  const latest = prs
    .filter((pr) => pr.state === "closed")
    .sort((a, b) => new Date(b.closed_at || b.updated_at || b.created_at || 0) - new Date(a.closed_at || a.updated_at || a.created_at || 0))[0];
  if (!latest) return { prState: "closed" };

  if (latest.merged_at) {
    return {
      prState: "merged",
      prNumber: latest.number,
      prClosedAt: new Date(latest.closed_at || latest.merged_at).getTime(),
    };
  }

  let detail = latest;
  try {
    detail = await gh("GET", `/repos/${repo}/pulls/${latest.number}`);
  } catch {
    // The list response is enough to know the PR is closed; only feedback counts
    // degrade when the detail read fails.
  }
  const reviews = await paginate(gh, `/repos/${repo}/pulls/${latest.number}/reviews`);
  const hasReviewBody = reviews.some((r) => (r.body || "").trim() || r.state === "CHANGES_REQUESTED");
  const hasFeedback = (detail.comments || 0) > 0 || (detail.review_comments || 0) > 0 || hasReviewBody;
  return {
    prState: hasFeedback ? "closed-with-feedback" : "closed",
    prNumber: latest.number,
    prClosedAt: latest.closed_at ? new Date(latest.closed_at).getTime() : null,
  };
}

function hoursToMs(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number of hours, got ${JSON.stringify(value)}.`);
  }
  return n * 3600 * 1000;
}

export async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new Error("Missing token or repo. Set GITHUB_TOKEN (or GITHUB_PAT) and GITHUB_REPOSITORY.");
  }
  const owner = repo.split("/")[0];
  const staleHours = process.env.STALE_HOURS || "2";
  const staleMs = hoursToMs("STALE_HOURS", staleHours);
  const reworkGraceHours = process.env.REWORK_GRACE_HOURS || staleHours;
  const reworkGraceMs = hoursToMs("REWORK_GRACE_HOURS", reworkGraceHours);
  // SWEEP_NOW pins the clock for the test; production uses the wall clock.
  const now = Number(process.env.SWEEP_NOW) || Date.now();
  const gh = ghClient(token);

  const open = await paginate(gh, `/repos/${repo}/issues?state=open`);
  let swept = 0;
  for (const issue of open) {
    if (issue.pull_request) continue;
    const state = labelNames(issue.labels).find((l) => SWEPT_STATES.has(l));
    if (!state) continue;
    const branch = `agent/issue-${issue.number}`;

    // Signals are fetched only where a state weighs them; every fetch degrades
    // to the helper's documented fallback rather than failing the whole sweep.
    let aheadBy = null, lastCommitAt = null, claimAt = null, heartbeatAt = null, branchExists = true;
    let prState = "closed", prNumber = null, prClosedAt = null;

    if (state === "state:in-progress" || state === "state:changes-requested") {
      try {
        const cmp = await gh("GET", `/repos/${repo}/compare/main...${branch}`);
        aheadBy = cmp.ahead_by;
      } catch (e) {
        if (e.status === 404) branchExists = false;
        // branch absent or uncomparable -> no commit signal
      }
      if (aheadBy > 0) {
        try {
          const commits = await gh("GET", `/repos/${repo}/commits?sha=${branch}&per_page=1`);
          const d = commits[0]?.commit?.committer?.date;
          lastCommitAt = d ? new Date(d).getTime() : null;
        } catch {
          // branch vanished between compare and list -> fall back in the helper
        }
      }
      try {
        const comments = await paginate(gh, `/repos/${repo}/issues/${issue.number}/comments`);
        const beats = comments.filter((c) => isHeartbeat(c.body || "")).map((c) => new Date(c.created_at).getTime());
        heartbeatAt = beats.length ? Math.max(...beats) : null;
      } catch {
        // comments unreadable -> leave null
      }
    }

    if (state === "state:in-progress") {
      try {
        const events = await paginate(gh, `/repos/${repo}/issues/${issue.number}/events`);
        const claims = events.filter((e) => e.event === "labeled" && e.label && e.label.name === "state:in-progress");
        claimAt = claims.length ? new Date(claims[claims.length - 1].created_at).getTime() : null;
      } catch {
        // timeline unreadable -> fall back to issue update inside the helper
      }
    }

    if (state === "state:in-review") {
      try {
        ({ prState, prNumber, prClosedAt } = await prStateForBranch(gh, repo, owner, branch));
      } catch {
        prState = "unknown"; // PR list unreadable -> never sweep on doubt
      }
    }

    const decision = decideSweep({
      state, now, staleMs, staleHours, branch, aheadBy, lastCommitAt, claimAt, heartbeatAt,
      updatedAt: new Date(issue.updated_at).getTime(), branchExists,
      prState, prNumber, prClosedAt, reworkGraceMs, reworkGraceHours,
    });
    if (!decision.sweep) continue;

    // Re-read at write time. The listing that produced `issue` may be minutes
    // and many API calls old, so writing labels from that stale snapshot can
    // clobber a state change an agent made in the window (e.g. it opened a PR
    // and moved the issue to state:in-review). Re-read the issue now: if its
    // state label no longer matches the one this decision was made on, someone
    // moved it — leave it alone. Otherwise recompute the labels from the fresh
    // snapshot, and gate the requeue on the fresh body so an issue that lost
    // its acceptance criteria after promotion is held at state:draft, not
    // re-exposed as state:ready.
    let fresh;
    try {
      fresh = await gh("GET", `/repos/${repo}/issues/${issue.number}`);
    } catch {
      console.log(`skipped #${issue.number}: could not re-read issue before write`);
      continue; // never overwrite on doubt
    }
    const freshLabels = labelNames(fresh.labels || []);
    const freshState = freshLabels.find((l) => SWEPT_STATES.has(l));
    if (freshState !== state) {
      console.log(`skipped #${issue.number}: state changed ${state} -> ${freshState ?? "(none)"} since listing`);
      continue;
    }

    const final = classifyRequeue(decision, fresh.body || "");
    const labels = freshLabels.filter((l) => !l.startsWith("state:"));
    labels.push(final.targetState || "state:ready");
    await gh("PUT", `/repos/${repo}/issues/${issue.number}/labels`, { labels });
    if (fresh.assignees?.length) {
      await gh("DELETE", `/repos/${repo}/issues/${issue.number}/assignees`, {
        assignees: fresh.assignees.map((a) => a.login),
      }).catch(() => {});
    }
    if (final.deleteRef) {
      await gh("DELETE", `/repos/${repo}/git/refs/heads/${branch}`).catch(() => {});
    }
    await gh("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body: final.comment });
    console.log(`swept #${issue.number} (${state}) -> ${final.targetState}${final.deleteRef ? " (claim ref deleted)" : ""}`);
    swept++;
  }
  console.log(`sweep complete: ${swept} issue(s) requeued.`);
  return { swept };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
