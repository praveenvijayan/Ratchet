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
//   - On failure the process exits non-zero and the failing gate's NAME is
//     written to the CI check summary and emitted as an error annotation, so a
//     red check names the gate that broke.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/run-gates.mjs
// Override the file for testing with GATES_FILE=/path/to/GATES.md.

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

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
const errorAnnot = (msg) => console.log(`::error::${msg}`);

if (!existsSync(GATES_FILE)) {
  const msg = `Gates file not found: ${GATES_FILE}. Cannot verify — expected the project's GATES.md at the repo root.`;
  errorAnnot(msg);
  console.error(msg);
  process.exit(1);
}

// --- parse the GATES.md table into ordered rows -------------------------
// Only markdown table rows are considered; the surrounding prose and the
// HTML comments (which may themselves mention `TODO:`) are ignored because
// they do not start with `|`.
function parseGates(text) {
  const rows = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
    if (cells[0].toLowerCase() === "order" || cells[1].toLowerCase() === "gate") continue; // header row
    const command = cells[2].replace(/^`+|`+$/g, "").trim(); // strip the code-span backticks
    if (!command) continue;
    rows.push({ order: cells[0], gate: cells[1], command });
  }
  return rows;
}

const gates = parseGates(readFileSync(GATES_FILE, "utf8"));

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
summary(`\n${done}`);
console.log(`\n${done}`);
