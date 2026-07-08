#!/usr/bin/env node
// run-gates.test.mjs — behaviour tests for the GATES.md gate runner.
// Zero dependencies. Run:  node scripts/run-gates.test.mjs
//
// One test per acceptance criterion of issue #9, exercised through the public
// interface (invoking scripts/run-gates.mjs as a subprocess against fixture
// GATES.md files), never against parser internals:
//   1. Runs the gates in order, fail-fast.
//   2. Gate commands are parsed from GATES.md itself.
//   3. A failing gate exits non-zero with the gate's name in the check summary.
//   4. A TODO: row is skipped with a visible notice, never treated as passed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (not url.pathname) so a repo path containing spaces decodes
// back to a real filename rather than a percent-encoded one node can't open.
const RUNNER = fileURLToPath(new URL("./run-gates.mjs", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "run-gates-test-"));

// Write a GATES.md fixture and run the runner against it. GITHUB_STEP_SUMMARY
// points at a per-invocation file so we can assert on the check summary.
let n = 0;
async function runGates(rows) {
  const gatesFile = join(dir, `GATES-${n}.md`);
  const summaryFile = join(dir, `summary-${n}.md`);
  n++;
  const table = [
    "# Gates",
    "",
    "| Order | Gate | Command | Pass condition |",
    "|-------|------|---------|----------------|",
    ...rows.map((r) => `| ${r.order} | ${r.gate} | ${r.command} | — |`),
    "",
  ].join("\n");
  await writeFile(gatesFile, table);
  const res = spawnSync("node", [RUNNER], {
    encoding: "utf8",
    env: { ...process.env, GATES_FILE: gatesFile, GITHUB_STEP_SUMMARY: summaryFile },
  });
  const summary = await readFile(summaryFile, "utf8").catch(() => "");
  return { status: res.status, out: (res.stdout || "") + (res.stderr || ""), summary };
}

// A node one-liner as a gate command — no shell pipes, so it stays inside one
// markdown table cell and runs identically on macOS and Linux CI.
const echo = (token) => `\`node -e "console.log('${token}')"\``;
const fail = "`node -e \"process.exit(3)\"`";

// --- Criterion 1: runs in order, fail-fast ------------------------------
{
  const { status, out } = await runGates([
    { order: 1, gate: "alpha", command: echo("ALPHA_RAN") },
    { order: 2, gate: "beta", command: fail },
    { order: 3, gate: "gamma", command: echo("GAMMA_RAN") },
  ]);
  assert.notEqual(status, 0, "a failing gate must make the run exit non-zero");
  assert.ok(out.includes("ALPHA_RAN"), "the gate before the failure must have run");
  assert.ok(!out.includes("GAMMA_RAN"), "fail-fast: no gate after the failure may run");
}

// --- Criterion 2: commands are parsed from GATES.md ---------------------
{
  const { status, out } = await runGates([
    { order: 1, gate: "solo", command: echo("PARSED_FROM_GATES_MD") },
  ]);
  assert.equal(status, 0, "an all-passing gates table must exit zero");
  assert.ok(out.includes("PARSED_FROM_GATES_MD"), "the command run must be the one written in GATES.md");
}

// --- Criterion 3: failing gate is red, with the gate name in the summary --
{
  const { status, summary } = await runGates([
    { order: 1, gate: "typecheck", command: fail },
  ]);
  assert.notEqual(status, 0, "a failing gate must exit non-zero (red check)");
  assert.ok(summary.includes("typecheck"), "the failing gate's name must appear in the check summary");
  assert.ok(/FAIL/i.test(summary), "the summary must mark the gate as failed");
}

// --- Criterion 4 / #58 AC3: TODO-only runs are visibly green but vacuous ---
{
  const { status, out, summary } = await runGates([
    { order: 1, gate: "format", command: "TODO: format command" },
  ]);
  assert.equal(status, 0, "a TODO-only table has nothing to fail on");
  assert.ok(/::notice::/.test(out) && /skip/i.test(out), "a TODO gate must emit a visible skip notice");
  assert.ok(/::warning::/.test(out) && /vacuous/i.test(out), "a TODO-only green run must emit a vacuous-check warning");
  assert.ok(/skip/i.test(summary), "the TODO gate must be shown as skipped in the summary");
  assert.ok(/green but vacuous/i.test(summary), "the summary must visibly distinguish no-op green from verified green");
  assert.ok(!/passed/i.test(summary), "a skipped TODO gate must never be reported as passed");
}

console.log("PASS run-gates.test.mjs (4 criteria, 13 assertions)");
