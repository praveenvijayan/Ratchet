#!/usr/bin/env node
// ratchet-metrics.mjs — read-only loop-health metrics from GitHub data.
// Zero dependencies. Requires Node 20+ (global fetch). Uses your EXISTING gh
// auth only (token via GITHUB_TOKEN / GITHUB_PAT / `gh auth token`); it issues
// GET requests exclusively and never mutates an issue, label, file, ref, or
// anything else — no external service, no writes.
//
// Metrics, all aggregated from issue timelines and state labels:
//   - Queue depth by state (open issues)
//   - Cycle time: first `state:ready` → issue closed as completed (merged)
//   - Rework rate: share of completed issues that passed through
//     `state:changes-requested`
//   - Stale-claim sweeps: the marker comments sweep-stale-claims posts when it
//     requeues abandoned work — claim, review, and rework sweeps all counted
//
// A young repo with no completed issues yet gets a clear "not enough data"
// line per metric — never an error, never a misleading zero.
//
// Run:  GITHUB_TOKEN="$(gh auth token)" \
//       GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
//       node scripts/ratchet-metrics.mjs
// Tune the scan window with METRICS_LIMIT (default 200 most-recent issues).

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SWEEP_COMMENT_PREFIXES } from "./sweep-stale-claims.mjs";

const API = "https://api.github.com";

// Count a comment as a sweep if it starts with any prefix the sweep emits.
// The list is imported from the sweep script itself (not re-declared here), so
// a new sweep type can never be silently undercounted: whatever prefixes the
// sweep can post are exactly the prefixes this metric matches.
export const SWEEP_PREFIXES = Object.values(SWEEP_COMMENT_PREFIXES);
export const STATES = [
  "ready", "in-progress", "in-review", "changes-requested", "blocked", "draft",
];

// Every request goes through here: GET only, no body, ever.
export async function ghGet(fetchImpl, token, path) {
  const res = await fetchImpl(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function paginate(fetchImpl, token, basePath, cap) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    const batch = await ghGet(fetchImpl, token, `${basePath}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break;
    out.push(...batch);
    if (batch.length < 100 || out.length >= cap) break;
  }
  return out.slice(0, cap);
}

const stateOf = (issue) =>
  (issue.labels || [])
    .map((l) => (typeof l === "string" ? l : l.name))
    .find((n) => n && n.startsWith("state:"));

export async function computeMetrics({ fetchImpl, token, repo, limit = 200 }) {
  // All issues, newest first, capped — the endpoint also returns PRs, so drop
  // them (a PR carries a `pull_request` key).
  const raw = await paginate(
    fetchImpl, token,
    `/repos/${repo}/issues?state=all&sort=created&direction=desc`, limit,
  );
  const issues = raw.filter((i) => !i.pull_request);
  const open = issues.filter((i) => i.state === "open");

  const queueDepth = Object.fromEntries(STATES.map((s) => [s, 0]));
  let untracked = 0;
  for (const i of open) {
    const st = stateOf(i);
    const key = st ? st.slice("state:".length) : null;
    if (key && key in queueDepth) queueDepth[key]++;
    else untracked++;
  }

  const cycles = []; // ms, first ready -> completed close
  let completedConsidered = 0;
  let reworked = 0;
  let sweepCount = 0;

  for (const issue of issues) {
    const timeline = await paginate(
      fetchImpl, token, `/repos/${repo}/issues/${issue.number}/timeline`, 300,
    );

    // Sweeps can land on any issue, open or closed: count every automated
    // marker the sweep emits (claim, review, and rework sweeps alike).
    for (const ev of timeline) {
      if (ev.event === "commented" && typeof ev.body === "string" &&
          SWEEP_PREFIXES.some((p) => ev.body.startsWith(p))) sweepCount++;
    }

    // Cycle time and rework are only meaningful for issues that actually
    // completed (closed as `completed` = merged via Closes #N, not discarded).
    if (issue.state === "closed" && issue.state_reason === "completed") {
      completedConsidered++;
      const readyAt = timeline
        .filter((e) => e.event === "labeled" && e.label && e.label.name === "state:ready")
        .map((e) => new Date(e.created_at).getTime());
      if (timeline.some((e) => e.event === "labeled" && e.label && e.label.name === "state:changes-requested")) {
        reworked++;
      }
      const closedAt = issue.closed_at ? new Date(issue.closed_at).getTime() : null;
      if (readyAt.length && closedAt) {
        const firstReady = Math.min(...readyAt);
        if (closedAt >= firstReady) cycles.push(closedAt - firstReady);
      }
    }
  }

  return {
    totalIssues: issues.length, openCount: open.length,
    queueDepth, untracked, cycles, completedConsidered, reworked, sweepCount,
  };
}

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function humanizeMs(ms) {
  const h = ms / 3.6e6;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

export function renderReport(m) {
  const L = [];
  L.push("# Ratchet loop metrics");
  L.push(`Read-only, aggregated from ${m.totalIssues} issue(s) via the GitHub API.`);
  L.push("");

  L.push("## Queue depth by state (open issues)");
  if (m.openCount === 0) {
    L.push("- No open issues — the queue is empty.");
  } else {
    for (const s of STATES) L.push(`- ${s}: ${m.queueDepth[s]}`);
    if (m.untracked) L.push(`- (no state label): ${m.untracked}`);
  }
  L.push("");

  L.push("## Cycle time (ready → merged)");
  if (m.cycles.length === 0) {
    L.push("- Not enough data: no issue has completed the ready→merged path yet.");
  } else {
    L.push(`- median ${humanizeMs(median(m.cycles))} across ${m.cycles.length} completed issue(s)`);
  }
  L.push("");

  L.push("## Rework rate");
  if (m.completedConsidered === 0) {
    L.push("- Not enough data: no completed issues to measure rework against yet.");
  } else {
    const pct = (100 * m.reworked / m.completedConsidered).toFixed(0);
    L.push(`- ${pct}% (${m.reworked} of ${m.completedConsidered} completed issue(s) passed through changes-requested)`);
  }
  L.push("");

  L.push("## Stale-claim sweeps");
  L.push(`- ${m.sweepCount} sweep(s) recorded in the scanned window.`);
  return L.join("\n");
}

async function main() {
  // Local convenience: load .env (never overrides an already-set var).
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  const limit = Number(process.env.METRICS_LIMIT) || 200;
  if (!token || !repo) {
    console.error(
      "Missing GitHub auth. Provide GITHUB_TOKEN (e.g. \"$(gh auth token)\") and " +
      "GITHUB_REPOSITORY=owner/repo, then re-run. Nothing was read or changed.",
    );
    process.exit(1);
  }
  try {
    const m = await computeMetrics({ fetchImpl: fetch, token, repo, limit });
    console.log(renderReport(m));
  } catch (e) {
    console.error(`ratchet-metrics could not read GitHub data: ${e.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
