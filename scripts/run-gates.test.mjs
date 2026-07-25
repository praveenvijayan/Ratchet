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
// Plus #89: a run with zero real gates exits non-zero (red) so it is
// distinguishable in the PR checks list (AC1); a run with at least one real
// gate keeps the normal green success presentation (AC2).
// Plus #88: unrelated extra tables in GATES.md do not abort gate parsing (AC1);
// malformed rows inside the gates table still fail loudly naming the row (AC2).
// Plus #494: a spawned gate command inherits neither gate-config variable (C1);
// a CI-like run uses its own fixture table and terminates (C2); the per-suite
// strips PR #492 added are gone and both affected suites still pass (C3).

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

// The fixture environment for a spawned runner is simply this process's own —
// no per-suite scrubbing. run-gates.mjs strips BASE_GATES_FILE and GATES_FILE
// from every gate command it spawns (#494), so when CI runs this suite as a gate
// it never sees them; the strip PR #492 added here is no longer load-bearing and
// is gone. The tests that need either variable set it explicitly.

// Write a GATES.md fixture and run the runner against it. GITHUB_STEP_SUMMARY
// points at a per-invocation file so we can assert on the check summary.
let n = 0;
async function runGates(rows) {
  const gatesFile = join(dir, `GATES-${n}.md`);
  const summaryFile = join(dir, `summary-${n}.md`);
  n++;
  await writeFile(gatesFile, gatesTable(rows));
  const res = spawnSync("node", [RUNNER], {
    encoding: "utf8",
    env: { ...process.env, GATES_FILE: gatesFile, GITHUB_STEP_SUMMARY: summaryFile },
  });
  const summary = await readFile(summaryFile, "utf8").catch(() => "");
  return { status: res.status, out: (res.stdout || "") + (res.stderr || ""), summary };
}

async function runGatesText(text) {
  const gatesFile = join(dir, `GATES-${n}.md`);
  const summaryFile = join(dir, `summary-${n}.md`);
  n++;
  await writeFile(gatesFile, text);
  const res = spawnSync("node", [RUNNER], {
    encoding: "utf8",
    env: { ...process.env, GATES_FILE: gatesFile, GITHUB_STEP_SUMMARY: summaryFile },
  });
  const summary = await readFile(summaryFile, "utf8").catch(() => "");
  return { status: res.status, out: (res.stdout || "") + (res.stderr || ""), summary };
}

// Build a GATES.md table body from rows (shared by both helpers).
const gatesTable = (rows) =>
  [
    "# Gates",
    "",
    "| Order | Gate | Command | Pass condition |",
    "|-------|------|---------|----------------|",
    ...rows.map((r) => `| ${r.order} | ${r.gate} | ${r.command} | — |`),
    "",
  ].join("\n");

// #84: run with a base-branch GATES.md (BASE_GATES_FILE) alongside the PR's own
// working-tree GATES.md (GATES_FILE). The runner must judge by the base copy and
// flag the PR's copy when it differs.
async function runGatesWithBase(baseRows, headRows) {
  const baseFile = join(dir, `base-GATES-${n}.md`);
  const headFile = join(dir, `head-GATES-${n}.md`);
  const summaryFile = join(dir, `summary-base-${n}.md`);
  n++;
  await writeFile(baseFile, gatesTable(baseRows));
  await writeFile(headFile, gatesTable(headRows));
  const res = spawnSync("node", [RUNNER], {
    encoding: "utf8",
    env: { ...process.env, GATES_FILE: headFile, BASE_GATES_FILE: baseFile, GITHUB_STEP_SUMMARY: summaryFile },
  });
  const summary = await readFile(summaryFile, "utf8").catch(() => "");
  return { status: res.status, out: (res.stdout || "") + (res.stderr || ""), summary };
}

// A node one-liner as a gate command — no shell pipes, so it stays inside one
// markdown table cell and runs identically on macOS and Linux CI.
const echo = (token) => `\`node -e "console.log('${token}')"\``;
const fail = "`node -e \"process.exit(3)\"`";

// A gate command that reports what gate config it actually inherited. Asserting
// on this — not on run-gates.mjs's source text — is what proves a child was
// cleaned: a source grep only proves a variable name is written somewhere.
const envProbe =
  "`node -e \"console.log('CHILD_SAW BASE=[' + (process.env.BASE_GATES_FILE || '') + '] GATES=[' + (process.env.GATES_FILE || '') + ']')\"`";
const CHILD_SAW_NOTHING = "CHILD_SAW BASE=[] GATES=[]";

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

// --- Criterion 4 / #58 AC3 / #89: a TODO gate is skipped with a visible notice
// (never as passed); and — changed by #89 — a TODO-only run exits non-zero so the
// check is red (distinguishable) in the PR checks list, not green-but-vacuous ---
{
  const { status, out, summary } = await runGates([
    { order: 1, gate: "format", command: "TODO: format command" },
  ]);
  assert.notEqual(status, 0, "a TODO-only run is vacuous and must exit non-zero (#89)");
  assert.ok(/::notice::/.test(out) && /skip/i.test(out), "a TODO gate must emit a visible skip notice");
  assert.ok(/::error::/.test(out) && /vacuous/i.test(out), "a vacuous run must emit an error annotation (#89)");
  assert.ok(/skip/i.test(summary), "the TODO gate must be shown as skipped in the summary");
  assert.ok(/vacuous/i.test(summary), "the summary must mark the run as vacuous");
  assert.ok(!/passed/i.test(summary), "a skipped TODO gate must never be reported as passed");
}

// --- #89 AC1: a gates run in which zero real gates executed is distinguishable
// in the PR checks list itself — the run exits non-zero (red), not green ---
{
  const { status, out, summary } = await runGates([
    { order: 1, gate: "format", command: "TODO: format command" },
    { order: 2, gate: "lint", command: "TODO: lint command" },
  ]);
  assert.notEqual(status, 0, "a run with zero real gates must exit non-zero so the check is red in the PR list");
  assert.ok(/::error::/.test(out) && /vacuous/i.test(out), "the vacuous run must emit an error annotation visible without opening the run");
  assert.ok(/vacuous/i.test(summary), "the summary must mark the run as vacuous");
}

// --- #89 AC2: a run with at least one real gate keeps the normal success
// presentation (exit 0, green) even when some gates are TODO ---
{
  const { status, summary } = await runGates([
    { order: 1, gate: "format", command: "TODO: format command" },
    { order: 2, gate: "test", command: echo("REAL_GATE_RAN") },
  ]);
  assert.equal(status, 0, "a run with at least one real gate must keep normal success (green)");
  assert.ok(/passed/i.test(summary), "the real gate must be reported as passed");
  assert.ok(!/vacuous/i.test(summary), "a run with a real gate must not be marked vacuous");
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

// --- #88 AC1: an unrelated table elsewhere in GATES.md is documentation, not
// part of the gate table, so it must not abort parsing or block real gates ----
{
  const { status, out } = await runGatesText(`${gatesTable([
    { order: 1, gate: "test", command: echo("GATES_TABLE_RAN") },
  ])}
## Troubleshooting

| Symptom | Fix |
|---------|-----|
| foo | bar | baz |
`);
  assert.equal(status, 0, "an additional unrelated table must not abort the gate run");
  assert.ok(out.includes("GATES_TABLE_RAN"), "the real gates table must still run normally");
}

// --- #88 AC2: malformed rows inside the gates table still fail loudly and
// name the bad row, rather than being mistaken for unrelated documentation ----
{
  const { status, out } = await runGatesText([
    "# Gates",
    "",
    "| Order | Gate | Command | Pass condition |",
    "|-------|------|---------|----------------|",
    "| 1 | test | node -e \"console.log(6*7)\" | tee log | — |",
    "",
  ].join("\n"));
  assert.notEqual(status, 0, "a malformed row inside the gates table must fail the run");
  assert.ok(/line 5/i.test(out), "the failure must name the malformed row's line");
  assert.ok(out.includes("tee log"), "the failure must include the malformed row text");
  assert.ok(!out.includes("42"), "the truncated command prefix must never be executed");
}

// --- #84 AC1: gates are judged by the base-branch GATES.md, not the PR's copy.
// The PR softens its own gate to a no-op that would pass; the base still carries
// the real failing gate, so the run fails and the PR's command never runs — a PR
// cannot edit what it is judged by --------------------------------------------
{
  const { status, out } = await runGatesWithBase(
    [{ order: 1, gate: "guard", command: fail }], // base: the real, failing gate
    [{ order: 1, gate: "guard", command: echo("SELF_SERVED") }], // PR tries to soften it
  );
  assert.notEqual(status, 0, "the base-branch gate must decide the outcome, not the PR's edited copy");
  assert.ok(!out.includes("SELF_SERVED"), "the PR's own gate command must never run when a base config is provided");
}

// --- #84 AC2: a PR that modifies GATES.md gets a visible notice in the output
// and the job summary, so a legitimate config change is flagged for the reviewer
// rather than silently deferred ------------------------------------------------
{
  const { status, out, summary } = await runGatesWithBase(
    [{ order: 1, gate: "guard", command: echo("OK") }],
    [
      { order: 1, gate: "guard", command: echo("OK") },
      { order: 2, gate: "added-in-pr", command: echo("OK") },
    ],
  );
  assert.equal(status, 0, "a within-base gate config still passes while the edit is flagged");
  assert.ok(/base branch's config/i.test(out) && /after merge/i.test(out), "a modified GATES.md must be flagged in the check output");
  assert.ok(/changed in this PR/i.test(summary), "the summary must flag the GATES.md change for the reviewer");
}

// --- #84: an unmodified GATES.md draws no config-change notice (no false alarm)
{
  const rows = [{ order: 1, gate: "guard", command: echo("OK") }];
  const { status, summary } = await runGatesWithBase(rows, rows);
  assert.equal(status, 0, "identical base and PR gate config must pass");
  assert.ok(!/changed in this PR/i.test(summary), "identical config must not be flagged as a change");
}

// --- #84 AC3: DOCS.md documents how gate config changes are reviewed and when
// they take effect. Asserted on the key facts (base branch, after-merge timing),
// not exact prose, so it verifies the trust-boundary material without brittleness
{
  const docs = await readFile(fileURLToPath(new URL("../DOCS.md", import.meta.url)), "utf8");
  const section = docs.slice(docs.indexOf("gate config is judged from the base branch"));
  assert.ok(section.length > 0, "DOCS.md must carry a gate-config trust-boundary section");
  assert.ok(/base branch/i.test(section), "DOCS.md must state that gate config is judged from the base branch");
  assert.ok(/after (it )?merge/i.test(section), "DOCS.md must state a config change takes effect only after merge");
}

// --- #494 Criterion 1: every gate command run-gates spawns sees neither
// BASE_GATES_FILE nor GATES_FILE, while the runner itself still judges by the
// base copy. The probe is a real spawned gate that prints what it inherited —
// the only thing that proves the child was cleaned. The head table carries a
// different command for the same gate, so the #84 rule is asserted in the same
// run: the base copy decides, the PR's own copy never executes ----------------
{
  const { status, out } = await runGatesWithBase(
    [{ order: 1, gate: "env-probe", command: envProbe }],
    [{ order: 1, gate: "env-probe", command: echo("HEAD_CONFIG_RAN") }],
  );
  assert.equal(status, 0, `the probe gate must run and pass, got:\n${out}`);
  assert.ok(
    out.includes(CHILD_SAW_NOTHING),
    `a spawned gate command must inherit neither BASE_GATES_FILE nor GATES_FILE, got:\n${out}`,
  );
  assert.ok(!out.includes("HEAD_CONFIG_RAN"), "the runner must still judge by the base copy, not the PR's (#84)");
}

// --- #494 Criterion 2: a gate run under a CI-like environment (both config
// variables set on the runner) runs its own fixture table and terminates.
//
// The variables are paired the only way that can be asserted: BASE_GATES_FILE
// carries the two-row fixture — that is exactly what CI's BASE_GATES_FILE is, a
// copy of the base branch's gate table — while a copy of the REAL GATES.md sits
// in GATES_FILE as leak bait. Pointing BASE_GATES_FILE at the real copy instead
// cannot be asserted at all: it outranks GATES_FILE (#84), so the fixture would
// be ignored and the whole real gate table would re-run, which this guard must
// not do. Either variable reaching the nested runner is caught: the fixture's
// own second row spawns a runner, and the real copy carries `test: run-gates` —
// so a leak recurses instead of terminating, which is why the run is timed and
// the timeout kill is asserted against ---------------------------------------
{
  const realCopy = join(dir, "real-GATES-copy.md");
  await writeFile(realCopy, await readFile(fileURLToPath(new URL("../GATES.md", import.meta.url)), "utf8"));
  const innerFixture = join(dir, "inner-GATES.md");
  await writeFile(innerFixture, gatesTable([{ order: 1, gate: "inner", command: echo("INNER_FIXTURE_RAN") }]));
  const ciConfig = join(dir, "ci-GATES.md");
  await writeFile(
    ciConfig,
    gatesTable([
      { order: 1, gate: "env-probe", command: envProbe },
      { order: 2, gate: "test: nested-runner", command: `\`GATES_FILE="${innerFixture}" node "${RUNNER}"\`` },
    ]),
  );
  const summaryFile = join(dir, "summary-ci.md");
  const res = spawnSync("node", [RUNNER], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, BASE_GATES_FILE: ciConfig, GATES_FILE: realCopy, GITHUB_STEP_SUMMARY: summaryFile },
  });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.equal(res.signal, null, "the CI-like run must terminate on its own — a kill means it recursed");
  assert.equal(res.status, 0, `the CI-like run must pass, got:\n${out}`);
  assert.ok(/2 gate\(s\) passed/.test(out), `exactly the two fixture gates must run, got:\n${out}`);
  assert.ok(out.includes(CHILD_SAW_NOTHING), "the CI-like run's gate commands must inherit no gate config");
  assert.ok(out.includes("INNER_FIXTURE_RAN"), "the nested runner must use its own fixture table");
  assert.ok(!out.includes("test: plan-sync"), "no gate from the real table may run");
}

// --- #494 Criterion 3: the per-suite BASE_GATES_FILE strips PR #492 added to
// pr-size-check.test.mjs and run-gates.test.mjs are no longer load-bearing. Both
// were removed; this runs both suites the way CI does — as gate commands of a
// run-gates invocation whose OWN environment carries both config variables — and
// requires them to pass. The real GATES.md copy is again the leak bait: a suite
// that inherited it would read the real table instead of its fixtures and fail.
//
// The nesting sentinel is what keeps this finite: the inner copy of this suite
// skips this block only (every other test in it still runs), since it would
// otherwise run itself forever -----------------------------------------------
if (!process.env.RATCHET_TEST_NESTED_SUITES) {
  const scripts = fileURLToPath(new URL(".", import.meta.url));
  const realCopy = join(dir, "real-GATES-copy-suites.md");
  await writeFile(realCopy, await readFile(fileURLToPath(new URL("../GATES.md", import.meta.url)), "utf8"));
  const suitesConfig = join(dir, "suites-GATES.md");
  await writeFile(
    suitesConfig,
    gatesTable([
      { order: 1, gate: "test: pr-size-check", command: `\`node "${join(scripts, "pr-size-check.test.mjs")}"\`` },
      { order: 2, gate: "test: run-gates", command: `\`node "${join(scripts, "run-gates.test.mjs")}"\`` },
    ]),
  );
  const summaryFile = join(dir, "summary-suites.md");
  const res = spawnSync("node", [RUNNER], {
    encoding: "utf8",
    timeout: 300_000,
    env: {
      ...process.env,
      BASE_GATES_FILE: suitesConfig,
      GATES_FILE: realCopy,
      RATCHET_TEST_NESTED_SUITES: "1",
      GITHUB_STEP_SUMMARY: summaryFile,
    },
  });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.equal(res.signal, null, "the two suites must terminate on their own under a CI-like environment");
  assert.equal(
    res.status,
    0,
    `pr-size-check.test.mjs and run-gates.test.mjs must pass with BASE_GATES_FILE set on the runner, got:\n${out}`,
  );
  assert.ok(out.includes("PASS pr-size-check.test.mjs"), "pr-size-check.test.mjs must pass without its own strip");
  assert.ok(out.includes("PASS run-gates.test.mjs"), "run-gates.test.mjs must pass without its own strip");
}

console.log("PASS run-gates.test.mjs (17 criteria, 60 assertions)");
