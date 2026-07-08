#!/usr/bin/env node
// gates-coverage.mjs — the guard that keeps the GATES.md test table honest.
// Every `scripts/*.test.mjs` suite must be executed by some GATES.md gate row;
// otherwise a suite can exist yet run nowhere (neither local verify nor the
// `pr-gates` CI check invoke it), so a regression in that suite's subject would
// merge green. This module is the SINGLE definition of "is every test suite
// wired into GATES.md", imported by its test and run as a gate itself.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/gates-coverage.mjs
// Override the inputs for testing with SCRIPTS_DIR=/dir and GATES_FILE=/path.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGates } from "./gates-table.mjs";

// Runnable gate commands declared in a GATES.md table. TODO rows are skipped
// here for the same reason run-gates skips them: they are placeholders, not
// verification that can cover a test suite.
export function gateCommands(gatesText = "") {
  return parseGates(String(gatesText))
    .map((row) => row.command)
    .filter((command) => !/^TODO:/i.test(command));
}

// Every `*.test.mjs` suite in a scripts directory, sorted for stable output.
export function listTestFiles(scriptsDir) {
  return readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();
}

// True iff `file` is named by `command` as a whole path segment — anchored on a
// left boundary (start, whitespace, `/`, or a quote) so `plan-sync.test.mjs`
// never counts as covered merely because it is a substring of another suite.
function referencedBy(command, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s/"'])${escaped}`).test(command);
}

// The test suites present in `scriptsDir` that no GATES.md command runs. Empty
// array ⇒ every suite is wired into the gate table. Sorted basenames.
export function uncoveredTestFiles(scriptsDir, gatesText) {
  const commands = gateCommands(gatesText);
  return listTestFiles(scriptsDir).filter(
    (file) => !commands.some((cmd) => referencedBy(cmd, file)),
  );
}

// --- CLI guard ----------------------------------------------------------
// Runs as a GATES.md gate. Exits non-zero, naming the forgotten suites, when a
// `*.test.mjs` file exists that no gate row runs — so a new suite can't be
// added without wiring it in. Missing inputs fail loud, never silent-pass.
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const scriptsDir = process.env.SCRIPTS_DIR || "scripts";
  const gatesFile = process.env.GATES_FILE || "GATES.md";

  if (!existsSync(scriptsDir)) {
    console.error(`Scripts directory not found: ${scriptsDir}. Cannot check gate coverage.`);
    process.exit(1);
  }
  if (!existsSync(gatesFile)) {
    console.error(`Gates file not found: ${gatesFile}. Cannot check gate coverage.`);
    process.exit(1);
  }

  let uncovered;
  try {
    uncovered = uncoveredTestFiles(scriptsDir, readFileSync(gatesFile, "utf8"));
  } catch (e) {
    console.error(`Could not read gate coverage inputs: ${e.message}`);
    process.exit(1);
  }

  const total = listTestFiles(scriptsDir).length;
  if (uncovered.length > 0) {
    console.error(
      `::error::${uncovered.length} test suite(s) run by no ${gatesFile} gate: ` +
        `${uncovered.join(", ")}. Add a gate row that runs each, or they verify nothing.`,
    );
    process.exit(1);
  }
  console.log(`All ${total} test suite(s) in ${scriptsDir}/ are wired into ${gatesFile}.`);
}
