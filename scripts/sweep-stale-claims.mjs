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
import { fileURLToPath } from "node:url";

// The three lifecycle states the sweep patrols. state:in-progress is the
// original claim lease; in-review and changes-requested close the holes where a
// vanished agent used to strand an issue in a non-terminal state forever.
export const SWEPT_STATES = new Set([
  "state:in-progress",
  "state:in-review",
  "state:changes-requested",
]);

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
//   input.hasOpenPr    — an open PR exists from agent/issue-<N> (in-review only)
// Returns { sweep: false } to leave the issue untouched, or
// { sweep: true, deleteRef, comment } to requeue it to state:ready.
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
function decideInProgress({ now, staleMs, staleHours, branch, aheadBy, lastCommitAt, claimAt, heartbeatAt, updatedAt }) {
  const { ref, source } = leaseReference({
    lastCommitAt: aheadBy > 0 ? lastCommitAt : null,
    heartbeatAt, claimAt, fallbackAt: updatedAt,
  });
  if (!isStale(ref, now, staleMs)) return { sweep: false };
  // A pure claim (zero commits beyond main) is litter — delete the ref so the
  // issue can be cleanly re-claimed. A branch with commits is recoverable work:
  // keep it for a human to inspect.
  const deleteRef = aheadBy === 0;
  const comment = deleteRef
    ? `Stale claim swept: \`${branch}\` had no work for >${staleHours}h (measured from ${source}). Orphaned claim ref deleted; issue returned to \`state:ready\`.`
    : `Stale claim swept: no activity on \`${branch}\` for >${staleHours}h (measured from ${source}). Branch kept (has commits); issue returned to \`state:ready\`.`;
  return { sweep: true, deleteRef, comment };
}

// in-review: an issue whose PR was closed or abandoned (not merged) stays in
// review forever. The trigger is structural, not time-based — no open PR from
// the claim branch means nothing is driving it to merge, so requeue it. A
// still-open PR is live review work: never touched. The branch reached review,
// so it has commits — never delete it.
function decideInReview({ branch, hasOpenPr }) {
  if (hasOpenPr) return { sweep: false };
  return {
    sweep: true,
    deleteRef: false,
    comment: `Stale review swept: \`${branch}\` is \`state:in-review\` but has no open PR (closed or abandoned without merge). Issue returned to \`state:ready\` so it can be re-picked.`,
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
  return {
    sweep: true,
    deleteRef: false,
    comment: `Stale rework swept: \`${branch}\` is \`state:changes-requested\` with no activity for >${staleHours}h. Issue returned to \`state:ready\` so it can be re-picked.`,
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

export async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new Error("Missing token or repo. Set GITHUB_TOKEN (or GITHUB_PAT) and GITHUB_REPOSITORY.");
  }
  const owner = repo.split("/")[0];
  const staleHours = process.env.STALE_HOURS || "2";
  const staleMs = Number(staleHours) * 3600 * 1000;
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
    let aheadBy = null, lastCommitAt = null, claimAt = null, heartbeatAt = null, hasOpenPr = false;

    if (state === "state:in-progress" || state === "state:changes-requested") {
      try {
        const cmp = await gh("GET", `/repos/${repo}/compare/main...${branch}`);
        aheadBy = cmp.ahead_by;
      } catch {
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
        const prs = await gh("GET", `/repos/${repo}/pulls?state=open&head=${owner}:${branch}&per_page=1`);
        hasOpenPr = prs.length > 0;
      } catch {
        hasOpenPr = true; // PR list unreadable -> never sweep on doubt
      }
    }

    const decision = decideSweep({
      state, now, staleMs, staleHours, branch, aheadBy, lastCommitAt, claimAt, heartbeatAt,
      updatedAt: new Date(issue.updated_at).getTime(), hasOpenPr,
    });
    if (!decision.sweep) continue;

    const labels = labelNames(issue.labels).filter((l) => !l.startsWith("state:"));
    labels.push("state:ready");
    await gh("PUT", `/repos/${repo}/issues/${issue.number}/labels`, { labels });
    if (issue.assignees?.length) {
      await gh("DELETE", `/repos/${repo}/issues/${issue.number}/assignees`, {
        assignees: issue.assignees.map((a) => a.login),
      }).catch(() => {});
    }
    if (decision.deleteRef) {
      await gh("DELETE", `/repos/${repo}/git/refs/heads/${branch}`).catch(() => {});
    }
    await gh("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body: decision.comment });
    console.log(`swept #${issue.number} (${state}) -> state:ready${decision.deleteRef ? " (claim ref deleted)" : ""}`);
    swept++;
  }
  console.log(`sweep complete: ${swept} issue(s) returned to state:ready.`);
  return { swept };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
