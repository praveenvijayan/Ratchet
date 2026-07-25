#!/usr/bin/env node
// negative-assertions.test.mjs — behaviour tests for the bare-negative-assertion
// guard. Zero dependencies. Run:  node scripts/negative-assertions.test.mjs
//
// One test per acceptance criterion of issue #498, exercised through the public
// interface (the exported decision and the CLI as a subprocess), never against
// the regexes themselves. Criterion 1 (the #49 AC2b probe rewrite) lives in
// run-gates.test.mjs, next to the assertion it repairs:
//   2. A fixture suite asserting an absence with a bare needle against captured
//      process output is reported with `file:line`; this repo has none.
//   3. An anchored negative assertion — a full phrase, or a `^`/`$` line match —
//      is not reported, so honest absence proofs keep passing.
//   4. GATES.md runs the guard as its own row, and gates-coverage finds this
//      suite wired in.
//
// The fixture suites below are BUILT, never written literally: a literal
// offending assertion in this file would be a real offender to the guard, which
// reads every scripts/*.test.mjs including this one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findBareNegativeAssertions, scanTestSuites } from "./negative-assertions.mjs";
import { uncoveredTestFiles } from "./gates-coverage.mjs";
import { parseGates } from "./gates-table.mjs";

// fileURLToPath (not url.pathname) so a repo path containing spaces resolves to
// a real filename rather than a percent-encoded one node can't open.
const GUARD = fileURLToPath(new URL("./negative-assertions.mjs", import.meta.url));
const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const gatesFile = fileURLToPath(new URL("../GATES.md", import.meta.url));

const SLASH = "/"; // keeps a regex-form fixture out of this file's own source
const quoted = (needle) => JSON.stringify(needle);

function runGuard(env) {
  const res = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

// --- Criterion 2: a bare needle against captured output is reported ------
{
  const suite = [
    'const out = (res.stdout || "") + (res.stderr || "");',
    `assert.ok(!out.includes(${quoted("42")}), "the prefix must never run");`,
    `assert.ok(!${SLASH}42${SLASH}.test(res.stderr), "still nothing");`,
  ].join("\n");

  const findings = findBareNegativeAssertions(suite);
  assert.deepEqual(
    findings.map((f) => [f.line, f.needle, f.form]),
    [
      [2, "42", "includes"],
      [3, "42", "regex"],
    ],
    "both forms of a bare needle against a captured stream must be reported, with their lines",
  );

  const dir = await mkdtemp(join(tmpdir(), "negative-assertions-test-"));
  await writeFile(join(dir, "flaky.test.mjs"), suite);
  const red = runGuard({ SCRIPTS_DIR: dir });
  assert.notEqual(red.status, 0, "a bare negative assertion must make the guard exit non-zero");
  assert.ok(red.out.includes("flaky.test.mjs:2"), "the guard must name the offender as file:line");
  assert.ok(red.out.includes("flaky.test.mjs:3"), "every offending line must be named, not just the first");
  assert.ok(!/\n\s+at\s+/.test(red.out), "a clear message, never a stack trace");

  // ...and this repo carries none, so the gate is green on a clean tree.
  assert.deepEqual(
    scanTestSuites(scriptsDir).map((f) => `${f.file}:${f.line}`),
    [],
    "no suite in this repo may prove an absence with a bare needle",
  );
  const green = runGuard({ SCRIPTS_DIR: scriptsDir });
  assert.equal(green.status, 0, `the guard must pass against this repo (out: ${green.out})`);
}

// --- Criterion 3: an anchored negative assertion is left alone -----------
{
  const suite = [
    `assert.ok(!out.includes(${quoted("exit code 42")}), "the phrase never appears");`,
    `assert.ok(!${SLASH}^42$${SLASH}m.test(out), "no output line is exactly the answer");`,
    `assert.ok(!${SLASH}\\b404\\b${SLASH}.test(res.out), "no raw 404 reaches the user");`,
    `assert.ok(!out.includes(${quoted("GAMMA_RAN")}), "the gate after the failure never ran");`,
    `assert.ok(!body.includes(${quoted("42")}), "a page the test owns may be searched freely");`,
  ].join("\n");

  assert.deepEqual(
    findBareNegativeAssertions(suite),
    [],
    "phrases, line-anchored matches, word boundaries and non-stream receivers must all pass",
  );

  const dir = await mkdtemp(join(tmpdir(), "negative-assertions-anchored-"));
  await writeFile(join(dir, "honest.test.mjs"), suite);
  const { status, out } = runGuard({ SCRIPTS_DIR: dir });
  assert.equal(status, 0, `anchored negative assertions must keep passing (out: ${out})`);
  assert.ok(/anchored evidence/i.test(out), "the green guard reports what it verified");
}

// --- Criterion 4: GATES.md runs the guard as its own row -----------------
{
  const gatesText = await readFile(gatesFile, "utf8");
  const commands = parseGates(gatesText)
    .map((row) => row.command)
    .filter((command) => !/^TODO:/i.test(command));

  assert.ok(
    commands.some((c) => /negative-assertions\.mjs/.test(c) && !/\.test\.mjs/.test(c)),
    "GATES.md must run the guard itself as its own row, not only its test suite",
  );
  assert.deepEqual(
    uncoveredTestFiles(scriptsDir, gatesText).filter((f) => f === "negative-assertions.test.mjs"),
    [],
    "gates-coverage must find this suite wired into GATES.md",
  );
}

console.log("PASS negative-assertions.test.mjs (3 criteria, guard verified against repo and fixtures)");
