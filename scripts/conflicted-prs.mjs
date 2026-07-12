#!/usr/bin/env node
// conflicted-prs.mjs — orchestration for the conflicted-prs workflow.
// A scheduled pass that marks open PRs with merge conflicts
// (`mergeable_state: dirty`) with a `conflict` label so reviewers can see
// unmergeable work before spending a review. The label is removed once the PR
// becomes mergeable again. A PR whose mergeability GitHub has not yet computed
// (`mergeable: null`) is skipped, not labeled. Re-running the pass on an
// already-labeled conflicted PR changes nothing (idempotent): the label write
// only fires when the desired label state differs from the current one.
// The decision logic lives here so it is regression-tested off the network
// (see conflicted-prs.test.mjs); this workflow is only its trigger and env.
//
// Zero dependencies. Node 20+ (ESM).

import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

export const CONFLICT_LABEL = "conflict";

// Decide the label action for one PR from its mergeability fields. Pure and
// total — no API calls, no side effects. Tested directly (see
// conflicted-prs.test.mjs) and by main() driving the full orchestration.
//   mergeable      — true | false | null (null = GitHub still computing)
//   mergeableState — "dirty" | "clean" | "blocked" | "behind" | "unstable" | …
// Returns "add" (PR is conflicted, should carry the label), "remove" (PR is
// mergeable, label should come off), or "skip" (mergeability unknown — never
// label on doubt, so a transient null is never mistaken for a conflict).
export function decideAction(mergeable, mergeableState) {
  if (mergeable === null) return "skip";
  if (mergeableState === "dirty") return "add";
  return "remove";
}

const labelNames = (labels) => labels.map((l) => (typeof l === "string" ? l : l.name));

// Ensure the conflict label exists in the repo before the pass. Idempotent: if
// it already exists (422 from create, or the GET finds it), the run continues.
// A label-creation failure that is not "already exists" fails the run visibly.
async function ensureLabel(gh, repo) {
  try {
    await gh("GET", `/repos/${repo}/labels/${CONFLICT_LABEL}`);
    return; // already exists
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  try {
    await gh("POST", `/repos/${repo}/labels`, {
      name: CONFLICT_LABEL,
      color: "d73a4a",
      description: "PR has merge conflicts; not reviewable until rebased",
    });
  } catch (e) {
    // 422 = already exists (race or pre-created). Anything else is a real failure.
    if (e.status !== 422) throw e;
  }
}

export async function main({ auth = resolveAuth } = {}) {
  const { token, repo } = auth();
  const gh = ghClient(token);

  await ensureLabel(gh, repo);

  const prs = await paginate(gh, `/repos/${repo}/pulls?state=open`);
  let labeled = 0, unlabeled = 0, skipped = 0;

  for (const pr of prs) {
    const currentLabels = new Set(labelNames(pr.labels || []));
    // The list endpoint omits mergeability fields; the detail endpoint has them.
    let detail;
    try {
      detail = await gh("GET", `/repos/${repo}/pulls/${pr.number}`);
    } catch {
      console.log(`skipped PR #${pr.number}: could not read mergeability`);
      skipped++;
      continue;
    }
    const action = decideAction(detail.mergeable, detail.mergeable_state);
    const hasLabel = currentLabels.has(CONFLICT_LABEL);

    if (action === "skip") {
      console.log(`PR #${pr.number}: mergeability unknown (mergeable: null) — skipped.`);
      skipped++;
      continue;
    }
    if (action === "add") {
      if (hasLabel) {
        console.log(`PR #${pr.number}: conflicted, already labeled — no change.`);
        continue; // idempotent
      }
      try {
        await gh("POST", `/repos/${repo}/issues/${pr.number}/labels`, { labels: [CONFLICT_LABEL] });
      } catch (e) {
        throw new Error(`label add for PR #${pr.number} failed: ${e.status ?? e.message}`);
      }
      console.log(`PR #${pr.number}: conflicted — labeled "${CONFLICT_LABEL}".`);
      labeled++;
      continue;
    }
    // action === "remove"
    if (!hasLabel) {
      console.log(`PR #${pr.number}: mergeable, no label — no change.`);
      continue; // idempotent
    }
    try {
      await gh("DELETE", `/repos/${repo}/issues/${pr.number}/labels/${CONFLICT_LABEL}`);
    } catch (e) {
      throw new Error(`label remove for PR #${pr.number} failed: ${e.status ?? e.message}`);
    }
    console.log(`PR #${pr.number}: mergeable again — removed "${CONFLICT_LABEL}".`);
    unlabeled++;
  }
  console.log(`conflicted-prs pass complete: ${labeled} labeled, ${unlabeled} unlabeled, ${skipped} skipped.`);
  return { labeled, unlabeled, skipped };
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
