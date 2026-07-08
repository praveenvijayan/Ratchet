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
// Plus #47 AC3: the summary names each distinct test gate it ran.
// Plus #49: a `|` inside a backticked command runs in full (AC1); a row the
// parser cannot interpret unambiguously fails the run naming the row, and the
// truncated command prefix never runs (AC2).

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

// --- #47 AC3: the summary names each distinct test gate it ran, so a reviewer
// reads suite-by-suite coverage at a glance rather than identical "test" rows --
{
  const { status, summary } = await runGates([
    { order: 1, gate: "test: plan-sync", command: echo("A") },
    { order: 2, gate: "test: criteria", command: echo("B") },
    { order: 3, gate: "format", command: "TODO: format command" },
  ]);
  assert.equal(status, 0, "all runnable gates passing must exit zero");
  for (const name of ["test: plan-sync", "test: criteria"]) {
    assert.ok(summary.includes(name), `the summary must name the test gate "${name}" it ran`);
  }
  assert.ok(/passed/i.test(summary), "each ran gate is reported as passed under its own name");
}

// --- #49 AC1: a `|` inside a backticked command is part of the command, not a
// column break — the full pipeline runs. The prefix before the pipe (`false`)
// exits non-zero on its own, so if the command were truncated at the pipe the
// gate would fail; a clean exit and the post-pipe token prove it ran in full --
{
  const piped = "`false | node -e \"console.log('PIPE_HONORED')\"`";
  const { status, out } = await runGates([
    { order: 1, gate: "test", command: piped },
  ]);
  assert.equal(status, 0, "a command with a pipe inside backticks must run in full and pass");
  assert.ok(out.includes("PIPE_HONORED"), "the command after the pipe must have run — the pipe was not a column break");
}

// --- #49 AC2a: an unbalanced backtick makes the column delimiters undecidable;
// the run must fail naming the row rather than guess at the command ----------
{
  const { status, out } = await runGates([
    { order: 1, gate: "test", command: "`npm test | tee" },
  ]);
  assert.notEqual(status, 0, "an unparseable gate row must fail the run");
  assert.ok(/unterminated/i.test(out), "the failure must explain the row could not be split");
  assert.ok(out.includes("npm test | tee"), "the failure message must name the offending row");
}

// --- #49 AC2b: a stray unescaped pipe changes the column count; rather than
// truncate the command to its prefix and run that, the run fails naming the row.
// The prefix computes `6*7`, so its output (`42`) differs from its source text
// (`6*7`, which the row echo contains): a missing `42` proves it never ran ----
{
  const command = "node -e \"console.log(6*7)\" | tee log";
  const { status, out } = await runGates([
    { order: 1, gate: "test", command },
  ]);
  assert.notEqual(status, 0, "a row with an ambiguous column count must fail the run");
  assert.ok(!out.includes("42"), "the truncated command prefix must never be executed");
  assert.ok(/column/i.test(out), "the failure must explain the row's column count is ambiguous");
}

console.log("PASS run-gates.test.mjs (7 criteria, 25 assertions)");
