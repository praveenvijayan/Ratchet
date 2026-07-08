#!/usr/bin/env node
// archive-closed-plans-workflow.test.mjs — locks the wiring of the
// archive-closed-plans workflow to issue #51's three acceptance criteria.
// Zero dependencies. Run:  node scripts/archive-closed-plans-workflow.test.mjs
//
// The archive DECISION (what maps to a closed issue, and the quiet no-op) is
// exercised behaviourally in archive-closed-plans.test.mjs. What this file
// guards is the automation contract that lives only in the YAML: that the sweep
// runs on a recurring trigger with no manual command, that its output lands as a
// PR and never as a push to main, and that a clean run opens no empty PR. Those
// are exactly the regressions the issue exists to prevent, so they are asserted
// against the shipped workflow rather than left untested.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wf = readFileSync(
  fileURLToPath(new URL("../.github/workflows/archive-closed-plans.yml", import.meta.url)),
  "utf8",
);

// Split off the `on:` trigger block (up to the next top-level key) so trigger
// assertions can't be satisfied by a comment or an unrelated step elsewhere.
const onBlock = wf.match(/\non:\n([\s\S]*?)\n[a-z]/)?.[1] ?? "";

// Criterion 1: archived on a recurring trigger, no manual command required.
// A schedule with a cron expression is the recurring, automatic trigger; the
// job must actually invoke the archive script (not just be scheduled).
assert.match(onBlock, /schedule:/, "workflow must have a recurring `schedule:` trigger");
assert.match(onBlock, /cron:\s*["']?[\d*]/, "the schedule must carry a cron expression");
assert.match(
  wf,
  /node\s+scripts\/archive-closed-plans\.mjs/,
  "the workflow must actually run the archive sweep script",
);

// Criterion 2: moves land as a reviewable PR, never a direct push to main.
assert.match(wf, /gh pr create\b/, "the workflow must open a PR for the archived files");
assert.match(wf, /--base main\b/, "the PR must target main for human review");
// The head must be a dedicated feature branch, not main.
const head = wf.match(/--head\s+"?\$?\{?([A-Za-z0-9_./${}-]+)/)?.[1] ?? "";
assert.ok(head && !/main/.test(head), `PR head must be a feature branch, not main (got: ${head})`);
// Hard guard: no git push may target main under any spelling.
for (const push of wf.match(/git push[^\n]*/g) ?? []) {
  assert.ok(
    !/(^|[:/\s])main($|[\s"'])/.test(push) && !/HEAD:main\b/.test(push),
    `the workflow must never push to main, found: ${push}`,
  );
}

// Criterion 3: when nothing needs archiving, exit quietly without opening a PR.
// The PR steps must be guarded by a clean-tree check that returns before any
// `gh pr create` — a no-op run produces no branch, no commit, and no PR.
assert.match(
  wf,
  /git status --porcelain[\s\S]*?exit 0[\s\S]*?gh pr create/,
  "PR creation must sit behind a clean-tree guard that exits first when nothing was archived",
);

console.log("PASS archive-closed-plans-workflow.test.mjs (9 assertions)");
