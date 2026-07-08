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

// A GATES.md the runner cannot interpret unambiguously. Thrown by parseGates
// and caught below so the run fails loudly, naming the offending row, instead
// of running a command the parser had to guess at.
class GateParseError extends Error {}

// Split one markdown table row into its raw cells. A naive `split("|")` breaks
// a command that legitimately contains a pipe — `npm test | tee log` — into two
// cells, so the command column is silently truncated to `npm test` and that
// truncated prefix runs instead of the real gate. This splitter treats a `|`
// as a column delimiter ONLY when it is outside a backtick code span and not
// backslash-escaped (`\|`), matching how the table renders. It returns the
// cell list, or an `error` string when the row cannot be split unambiguously
// (an unbalanced code span leaves the delimiters undecidable).
function splitRow(line) {
  const cells = [];
  let cell = "";
  let fence = 0; // length of the backtick run that opened the current code span; 0 = outside
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      // Escaped pipe: a literal `|` in the cell, never a delimiter. Unescape it
      // so the command runs with a real pipe.
      cell += "|";
      i += 2;
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (line[j] === "`") j++; // measure the backtick run
      const runLen = j - i;
      // A code span opens on a backtick run and closes only on a run of equal
      // length (CommonMark), so pipes inside `` `a | b` `` stay literal.
      if (fence === 0) fence = runLen;
      else if (runLen === fence) fence = 0;
      cell += line.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "|" && fence === 0) {
      cells.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  cells.push(cell);
  if (fence !== 0) {
    return { error: "unterminated backtick code span — cannot tell which pipes are column delimiters" };
  }
  return { cells };
}

// --- parse the GATES.md table into ordered rows -------------------------
// Only markdown table rows are considered; the surrounding prose and the
// HTML comments (which may themselves mention `TODO:`) are ignored because
// they do not start with `|`. A row that starts with `|` but cannot be split
// unambiguously, or whose column count disagrees with the table's, throws a
// GateParseError rather than silently running a truncated command.
function parseGates(text) {
  const rows = [];
  let expectedCols = null;
  const lines = text.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    if (!line.startsWith("|")) continue;
    const split = splitRow(line);
    if (split.error) {
      throw new GateParseError(`GATES.md line ${ln + 1}: ${split.error}. Row: ${line}`);
    }
    // A required leading `|` yields an empty first segment; a trailing `|` an
    // empty last one. Drop exactly those edge delimiters, keeping real cells.
    let cells = split.cells.slice(1);
    if (line.endsWith("|")) cells = cells.slice(0, -1);
    cells = cells.map((c) => c.trim());
    // Every row of a markdown table has the same column count; the first row
    // (the header) sets it. A row that splits into a different number of cells
    // is malformed — refuse to guess which cell is the command.
    if (expectedCols === null) expectedCols = cells.length;
    else if (cells.length !== expectedCols) {
      throw new GateParseError(
        `GATES.md line ${ln + 1}: expected ${expectedCols} columns but found ${cells.length} — an unescaped pipe in a command truncates it. Wrap the command in backticks or escape the pipe as \\|. Row: ${line}`,
      );
    }
    if (cells.length < 3) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
    if (cells[0].toLowerCase() === "order" || cells[1].toLowerCase() === "gate") continue; // header row
    const command = cells[2].replace(/^`+|`+$/g, "").trim(); // strip the code-span backticks
    if (!command) continue;
    rows.push({ order: cells[0], gate: cells[1], command });
  }
  return rows;
}

let gates;
try {
  gates = parseGates(readFileSync(GATES_FILE, "utf8"));
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
