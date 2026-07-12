#!/usr/bin/env node
// unblock-dependents.mjs — orchestration for the unblock-dependents workflow.
// When an issue closes, two jobs: (1) strip the closed issue's own state:* label
// (the lifecycle labels describe open work), and (2) promote every issue blocked
// only by it — but only if it still carries acceptance criteria, else hold it at
// state:draft. The ready-vs-draft decision is the shared classifyUnblock rule
// (criteria.mjs), the same one plan-sync uses, so the two can never disagree.
//
// This used to live inline in the workflow YAML; moving it into a script invoked
// by thin YAML lets the orchestration be regression-tested against an in-memory
// API (see unblock-dependents.test.mjs). Zero dependencies. Node 20+ (ESM).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyUnblock } from "./criteria.mjs";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

const labelNames = (labels) => labels.map((l) => (typeof l === "string" ? l : l.name));

// The closed issue that triggered the run. In Actions the payload is at
// GITHUB_EVENT_PATH; a test or manual run can pass CLOSED_ISSUE directly.
function closedIssueNumber() {
  if (process.env.CLOSED_ISSUE) return Number(process.env.CLOSED_ISSUE);
  const path = process.env.GITHUB_EVENT_PATH;
  if (path && existsSync(path)) {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (payload.issue?.number) return payload.issue.number;
  }
  throw new Error("No closed issue to react to. Set CLOSED_ISSUE, or provide GITHUB_EVENT_PATH with issue.number.");
}

export async function main({ auth = resolveAuth, fetchImpl } = {}) {
  const { token, repo } = auth();
  const gh = ghClient(token, { fetchImpl });
  const closed = closedIssueNumber();

  // 1. A closed issue is done or discarded: strip its own lifecycle label so a
  // lingering state:in-review can never mislead.
  const closedIssue = await gh("GET", `/repos/${repo}/issues/${closed}`);
  const ownLabels = labelNames(closedIssue.labels || []);
  const kept = ownLabels.filter((l) => !l.startsWith("state:"));
  if (kept.length !== ownLabels.length) {
    await gh("PUT", `/repos/${repo}/issues/${closed}/labels`, { labels: kept });
  }

  // 2. Re-feed every issue blocked only by now-closed issues.
  const all = await paginate(gh, `/repos/${repo}/issues?state=open`);
  let promoted = 0;
  for (const issue of all) {
    if (issue.pull_request) continue;
    const blockers = [...(issue.body || "").matchAll(/Blocked by #(\d+)/g)].map((m) => Number(m[1]));
    if (!blockers.includes(closed)) continue;

    // All blockers closed? A single open blocker keeps it blocked.
    let allClosed = true;
    for (const n of blockers) {
      const b = await gh("GET", `/repos/${repo}/issues/${n}`);
      if (b.state !== "closed") { allClosed = false; break; }
    }
    if (!allClosed) continue;

    // Promote to ready only if criteria survive; else hold at draft.
    const { state, comment } = classifyUnblock(issue.body || "", closed);
    const labels = labelNames(issue.labels).filter((l) => !l.startsWith("state:"));
    labels.push(state);
    await gh("PUT", `/repos/${repo}/issues/${issue.number}/labels`, { labels });
    await gh("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body: comment });
    console.log(`unblocked #${issue.number} -> ${state}`);
    promoted++;
  }
  console.log(`unblock complete: ${promoted} dependent(s) updated (trigger #${closed}).`);
  return { promoted };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
