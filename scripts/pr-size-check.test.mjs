#!/usr/bin/env node
// pr-size-check.test.mjs — behaviour tests for the agent PR size gate.
// Zero dependencies. Run:  node scripts/pr-size-check.test.mjs
//
// One test per acceptance criterion of issue #11, exercised through the public
// interface (invoking scripts/pr-size-check.mjs as a subprocess with a fixture
// GATES.md and the PR counts the workflow passes as env vars):
//   1. A PR over the configured limit fails the check (non-zero exit).
//   2. The failure message quotes the actual line/file counts, the limits, and
//      the split-and-requeue protocol from AGENTS.md step 3.
//   3. Thresholds are read from GATES.md, defaulting to ~400 lines / ~6 files.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (not url.pathname) so a repo path containing spaces decodes
// back to a real filename rather than a percent-encoded one node can't open.
const SCRIPT = fileURLToPath(new URL("./pr-size-check.mjs", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "pr-size-test-"));

let n = 0;
// Run the check against a fixture GATES.md with the given PR counts. `gates`
// is the raw GATES.md body (may omit the size config to exercise defaults).
async function check({ gates = "", additions, deletions, changedFiles }) {
  const gatesFile = join(dir, `GATES-${n++}.md`);
  await writeFile(gatesFile, gates);
  const res = spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      GATES_FILE: gatesFile,
      PR_ADDITIONS: String(additions),
      PR_DELETIONS: String(deletions),
      PR_CHANGED_FILES: String(changedFiles),
    },
  });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

const withLimits = (lines, files) =>
  `# Gates\n\n## PR size limit\n\n- max_changed_lines: ${lines}\n- max_changed_files: ${files}\n`;

// --- criterion 1: over-limit PR fails, within-limit PR passes ----------------
{
  const over = await check({ gates: withLimits(400, 6), additions: 300, deletions: 150, changedFiles: 3 });
  assert.equal(over.code, 1, "a PR of 450 changed lines must fail the size check");

  const overFiles = await check({ gates: withLimits(400, 6), additions: 10, deletions: 5, changedFiles: 7 });
  assert.equal(overFiles.code, 1, "a PR touching 7 files must fail the size check");

  const within = await check({ gates: withLimits(400, 6), additions: 200, deletions: 100, changedFiles: 5 });
  assert.equal(within.code, 0, "a PR within both limits must pass");
}

// --- criterion 2: message quotes counts, limits, and the protocol ------------
{
  const { code, out } = await check({ gates: withLimits(400, 6), additions: 300, deletions: 150, changedFiles: 8 });
  assert.equal(code, 1, "over-limit PR fails");
  assert.ok(out.includes("450"), `message must quote the actual 450 changed lines, got:\n${out}`);
  assert.ok(out.includes("8"), `message must quote the actual file count 8, got:\n${out}`);
  assert.ok(out.includes("400") && out.includes("6"), `message must quote the limits 400/6, got:\n${out}`);
  assert.ok(/split/i.test(out), "message must mention splitting");
  assert.ok(out.includes("state:ready") && out.includes("state:in-progress"), "message must quote the requeue protocol labels");
  assert.ok(out.includes("AGENTS.md step 3"), "message must cite AGENTS.md step 3");
}

// --- criterion 3: thresholds configurable in GATES.md, default 400/6 ---------
{
  // Configurable: a tightened limit fails a PR the default would pass.
  const tight = await check({ gates: withLimits(10, 6), additions: 8, deletions: 5, changedFiles: 2 });
  assert.equal(tight.code, 1, "a 13-line PR must fail when max_changed_lines is tuned down to 10");

  // Default when GATES.md has no size config: 400 lines / 6 files.
  const defaultFail = await check({ gates: "# Gates\n(no size config here)\n", additions: 250, deletions: 151, changedFiles: 1 });
  assert.equal(defaultFail.code, 1, "401 changed lines must fail under the default 400 limit");

  const defaultPass = await check({ gates: "# Gates\n(no size config here)\n", additions: 250, deletions: 149, changedFiles: 6 });
  assert.equal(defaultPass.code, 0, "399 lines / 6 files must pass under the defaults");
}

console.log("PASS pr-size-check.test.mjs (11 assertions)");
