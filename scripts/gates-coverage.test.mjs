#!/usr/bin/env node
// gates-coverage.test.mjs — behaviour tests for the GATES.md coverage guard.
// Zero dependencies. Run:  node scripts/gates-coverage.test.mjs
//
// One test per acceptance criterion of issue #47, exercised through the public
// interface (the exported guard function and the CLI as a subprocess), never
// against parser internals:
//   1. Every scripts/*.test.mjs suite in this repo is run by a GATES.md gate row.
//   2. The guard fails when a *.test.mjs file exists that no gate row runs.
// Plus issue #83:
//   3. gates-coverage parses GATES.md rows with the same shared parser run-gates
//      executes them with.
//   4. A test file mentioned only in a TODO: command is reported as uncovered.
//   5. A backticked gate command containing a pipe, with the suite filename
//      after the pipe, counts as covered without a false failure.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { uncoveredTestFiles } from "./gates-coverage.mjs";

// fileURLToPath (not url.pathname) so a repo path containing spaces resolves to
// a real filename rather than a percent-encoded one node can't open.
const GUARD = fileURLToPath(new URL("./gates-coverage.mjs", import.meta.url));
const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const gatesFile = fileURLToPath(new URL("../GATES.md", import.meta.url));

// Run the guard CLI against a given scripts dir + GATES.md, returning its exit
// status and combined output.
function runGuard(env) {
  const res = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

// --- Criterion 1: every real test suite is wired into GATES.md -----------
{
  const gatesText = await readFile(gatesFile, "utf8");
  const uncovered = uncoveredTestFiles(scriptsDir, gatesText);
  assert.deepEqual(
    uncovered,
    [],
    `every scripts/*.test.mjs must be run by a GATES.md gate; unwired: ${uncovered.join(", ")}`,
  );

  // ...and the guard agrees at the CLI level, exiting green against this repo.
  const { status, out } = runGuard({ SCRIPTS_DIR: scriptsDir, GATES_FILE: gatesFile });
  assert.equal(status, 0, `the guard must pass against this repo (out: ${out})`);
  assert.ok(/wired into/i.test(out), "the guard reports the suites it verified as wired");
}

// --- Criterion 2: a suite no gate row runs makes the guard fail ----------
{
  const dir = await mkdtemp(join(tmpdir(), "gates-coverage-test-"));
  await writeFile(join(dir, "covered.test.mjs"), "");
  await writeFile(join(dir, "forgotten.test.mjs"), "");
  const gates = join(dir, "GATES.md");

  // A gates table that runs only one of the two suites.
  const coveredRow = "| 1 | test: covered | `node scripts/covered.test.mjs` | exit 0 |";
  const partial = [
    "# Gates",
    "",
    "| Order | Gate | Command | Pass condition |",
    "|-------|------|---------|----------------|",
    coveredRow,
    "",
  ].join("\n");
  await writeFile(gates, partial);

  // The pure decision names exactly the forgotten suite.
  assert.deepEqual(
    uncoveredTestFiles(dir, partial),
    ["forgotten.test.mjs"],
    "the guard must report a test file that no gate row runs",
  );

  // The CLI turns that into a red gate that names the forgotten suite.
  const red = runGuard({ SCRIPTS_DIR: dir, GATES_FILE: gates });
  assert.notEqual(red.status, 0, "an unwired suite must make the guard exit non-zero");
  assert.ok(red.out.includes("forgotten.test.mjs"), "the red guard must name the forgotten suite");

  // Wiring the second suite in clears the guard — green once nothing is orphaned.
  const full = partial.replace(
    coveredRow,
    `${coveredRow}\n| 2 | test: forgotten | \`node scripts/forgotten.test.mjs\` | exit 0 |`,
  );
  await writeFile(gates, full);
  assert.deepEqual(uncoveredTestFiles(dir, full), [], "wiring the suite in clears the guard");
  const green = runGuard({ SCRIPTS_DIR: dir, GATES_FILE: gates });
  assert.equal(green.status, 0, "once every suite is wired, the guard exits zero");
}

// --- #83 Criterion 1: gates-coverage shares run-gates' row parser --------
{
  const dir = await mkdtemp(join(tmpdir(), "gates-coverage-shared-parser-"));
  await writeFile(join(dir, "escaped-pipe.test.mjs"), "");
  const gatesText = [
    "# Gates",
    "",
    "| Order | Gate | Command | Pass condition |",
    "|-------|------|---------|----------------|",
    "| 1 | test: escaped pipe | node -e \"console.log('a')\" \\| node scripts/escaped-pipe.test.mjs | exit 0 |",
    "",
  ].join("\n");

  assert.deepEqual(
    uncoveredTestFiles(dir, gatesText),
    [],
    "gates-coverage must use the same escaped-pipe-aware row parser as run-gates",
  );
}

// --- #83 Criterion 2: TODO commands do not count as coverage -------------
{
  const dir = await mkdtemp(join(tmpdir(), "gates-coverage-todo-"));
  await writeFile(join(dir, "todo-only.test.mjs"), "");
  const gatesText = [
    "# Gates",
    "",
    "| Order | Gate | Command | Pass condition |",
    "|-------|------|---------|----------------|",
    "| 1 | test: todo only | TODO: node scripts/todo-only.test.mjs | - |",
    "",
  ].join("\n");

  assert.deepEqual(
    uncoveredTestFiles(dir, gatesText),
    ["todo-only.test.mjs"],
    "a suite mentioned only in a TODO gate is still uncovered because run-gates skips it",
  );
}

// --- #83 Criterion 3: backticked pipes keep filenames after the pipe -----
{
  const dir = await mkdtemp(join(tmpdir(), "gates-coverage-piped-command-"));
  await writeFile(join(dir, "after-pipe.test.mjs"), "");
  const gatesText = [
    "# Gates",
    "",
    "| Order | Gate | Command | Pass condition |",
    "|-------|------|---------|----------------|",
    "| 1 | test: after pipe | `node -e \"console.log('prefix')\" | node scripts/after-pipe.test.mjs` | exit 0 |",
    "",
  ].join("\n");

  assert.deepEqual(
    uncoveredTestFiles(dir, gatesText),
    [],
    "a backticked pipe command must cover the suite named after the pipe",
  );
}

console.log("PASS gates-coverage.test.mjs (5 criteria, guard verified against repo and fixtures)");
