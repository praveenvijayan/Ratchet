#!/usr/bin/env node
// plan-sync-concurrency.test.mjs — guards the plan-sync concurrency guard.
// Zero dependencies. Run:  node scripts/plan-sync-concurrency.test.mjs
//
// The bug this guards (issue #6): with no concurrency group, two planning PRs
// merged in quick succession run two syncs in parallel; both list issues
// before either creates, both see a slug as new, and both create it —
// duplicate issues with the same plan-id. The fix is a workflow-level
// concurrency group. There is no GitHub Actions runtime to exercise here, so
// the workflow YAML is the public interface: the three acceptance criteria
// map one-to-one onto three properties of that file.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = new URL("../.github/workflows/plan-sync.yml", import.meta.url);
const yaml = await readFile(workflow, "utf8");

// --- extract the top-level `concurrency:` block ------------------------------
// A top-level key sits at column 0; its block is the following indented lines,
// up to the next column-0 line. Strip trailing `# comments` from each value.
function topLevelBlock(src, key) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}:`));
  if (start === -1) return null;
  const block = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break; // dedent to column 0 → block ended
    const m = line.match(/^\s+([\w-]+):\s*(.*)$/);
    if (m) block[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return block;
}

const concurrency = topLevelBlock(yaml, "concurrency");

// --- criterion 1: a concurrency group is declared ----------------------------
// "plan-sync.yml declares a concurrency group so at most one sync runs at a time"
assert.ok(concurrency, "plan-sync.yml must declare a top-level `concurrency:` block");
assert.ok(
  concurrency.group && concurrency.group.length > 0,
  `concurrency must name a group, got: ${JSON.stringify(concurrency.group)}`,
);

// --- criterion 2: queued, not cancelled --------------------------------------
// "A sync triggered while another is running queues (cancel-in-progress: false)
//  rather than being cancelled, so no batch is ever dropped"
assert.equal(
  concurrency["cancel-in-progress"],
  "false",
  `cancel-in-progress must be false so a queued batch is never dropped, got: ${JSON.stringify(concurrency["cancel-in-progress"])}`,
);

// --- criterion 3: rapid merges collapse to one lane → one issue per slug ------
// "Two rapid merges touching plan/** result in exactly one issue per new slug."
// The guard only prevents duplicates if BOTH merges land in the SAME group. A
// group keyed by a per-run value (github.sha / github.run_id / github.run_number)
// would put each merge in its own lane and reintroduce the race. So the group
// must be a stable literal with no per-run interpolation.
assert.ok(
  !/\$\{\{/.test(concurrency.group),
  `concurrency group must be a stable literal (no \${{ ... }} interpolation) so both rapid merges share one lane, got: ${JSON.stringify(concurrency.group)}`,
);

console.log("PASS plan-sync-concurrency.test.mjs (4 assertions)");
