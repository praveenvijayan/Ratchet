#!/usr/bin/env node
// run-gates.mjs — run the verification gates declared in GATES.md, in order,
// fail-fast. This is the SINGLE SOURCE OF TRUTH for the gate commands: the
// local verify step (AGENTS.md step 4) and the `pr-gates` CI workflow both
// invoke this script, so the commands can never drift between a developer's
// machine and the PR check.
//
// Behaviour:
//   - Parses the gates table from GATES.md (the `| Order | Gate | Command |`
//     rows), preserving order.
//   - Runs each gate's command in order, stopping at the FIRST failure.
//   - A gate whose command starts with `TODO:` has no command yet: it is
//     SKIPPED with a visible notice and never counted as passed.
//   - A `|` inside a command runs as part of the command, not as a column
//     break, as long as it sits inside backticks (`npm test | tee log`) or is
//     escaped (`\|`). A row the parser cannot split unambiguously (unbalanced
//     backticks, or a stray pipe that changes the column count) FAILS the run
//     naming the row — a truncated command prefix is never executed.
//   - On failure the process exits non-zero and the failing gate's NAME is
//     written to the CI check summary and emitted as an error annotation, so a
//     red check names the gate that broke.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/run-gates.mjs
// Override the file for testing with GATES_FILE=/path/to/GATES.md.

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { GateParseError, parseGates } from "./gates-table.mjs";

const GATES_FILE = process.env.GATES_FILE || "GATES.md";

// Surface a line both in stdout and, when running in Actions, the check's job
// summary. Summary writes are best-effort — a summary hiccup must never mask a
// gate result.
function summary(line) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) {
    try {
      appendFileSync(f, line + "\n");
    } catch {
      /* summary is decorative; the exit code is the real signal */
    }
  }
}
// GitHub annotations render in the check's output; harmless plain text locally.
const notice = (msg) => console.log(`::notice::${msg}`);
const warning = (msg) => console.log(`::warning::${msg}`);
const errorAnnot = (msg) => console.log(`::error::${msg}`);

if (!existsSync(GATES_FILE)) {
  const msg = `Gates file not found: ${GATES_FILE}. Cannot verify — expected the project's GATES.md at the repo root.`;
  errorAnnot(msg);
  console.error(msg);
  process.exit(1);
}

let gates;
try {
  gates = parseGates(readFileSync(GATES_FILE, "utf8"), GATES_FILE);
} catch (e) {
  if (!(e instanceof GateParseError)) throw e;
  const msg = `Cannot verify — ${GATES_FILE} has an unparseable gate row, refusing to run a possibly-truncated command. ${e.message}`;
  errorAnnot(msg);
  summary(`### Gates\n\n❌ ${msg}`);
  console.error(msg);
  process.exit(1);
}

if (gates.length === 0) {
  const msg = `No gate rows found in ${GATES_FILE}. Nothing to verify — add a gates table with at least one row.`;
  notice(msg);
  summary(`### Gates\n\n${msg}`);
  console.log(msg);
  process.exit(0);
}

summary(`### Gates (${GATES_FILE})\n`);
let run = 0;
let skipped = 0;
for (const { order, gate, command } of gates) {
  if (/^TODO:/i.test(command)) {
    skipped++;
    const msg = `Gate ${order} "${gate}" skipped — no command defined yet (${command}).`;
    notice(msg);
    summary(`- ⏭️ **${gate}** — skipped, no command (\`${command}\`)`);
    console.log(`SKIP  gate ${order} ${gate}: ${command}`);
    continue;
  }
  console.log(`\n=== gate ${order} ${gate}: ${command} ===`);
  try {
    execSync(command, { stdio: "inherit" });
  } catch (e) {
    const code = typeof e.status === "number" ? e.status : "unknown";
    const msg = `Gate "${gate}" FAILED (command: ${command}, exit ${code}).`;
    errorAnnot(msg);
    summary(`- ❌ **${gate}** — FAILED (\`${command}\`)`);
    console.error(`\nFAIL  ${msg}`);
    process.exit(1);
  }
  run++;
  summary(`- ✅ **${gate}** — passed (\`${command}\`)`);
  console.log(`PASS  gate ${order} ${gate}`);
}

const done = run > 0
  ? `${run} gate(s) passed, ${skipped} skipped.`
  : `No runnable gates — ${skipped} skipped, 0 run.`;
if (run === 0) {
  warning(`${done} This green check is vacuous: GATES.md only contains TODO rows, so no real verification ran.`);
  summary("\n⚠️ **Green but vacuous:** every gate row is `TODO`, so this run verified no real commands.");
}
summary(`\n${done}`);
console.log(`\n${done}`);
