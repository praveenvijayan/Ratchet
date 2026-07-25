#!/usr/bin/env node
// negative-assertions.mjs — the guard that keeps "this never happened"
// assertions honest.
//
// A test proves an absence by searching a captured stream: `!out.includes("42")`
// says the truncated gate command never ran. The stream it searches is a whole
// child process's stdout plus stderr, which also carries temp-dir paths, timings
// and CI annotations. A needle that short matches those by accident, so the
// assertion fails on noise and passes on a re-run — the flake that teaches the
// loop to re-run red until it turns green (#498, seen on PR #491).
//
// The fix is not a longer timeout: it is better evidence. Prove the absence with
// a side effect only the forbidden code can produce (a probe file), or anchor the
// needle so incidental text cannot match it — a full phrase, a `^`/`$`/`\b`
// anchor, or a line boundary.
//
// This module is the SINGLE definition of "is this negative assertion anchored",
// imported by its test and run as a gate itself. It is a static read of the test
// sources: it never executes a suite, so it costs milliseconds.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/negative-assertions.mjs
// Override the input for testing with SCRIPTS_DIR=/dir.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Receivers that name a captured process stream. The rule is deliberately scoped
// to these: searching a DOM string, a config file or an error message for a short
// token is honest, because the test owns every byte of what it is searching.
const STREAM_NAMES = new Set(["out", "output", "stdout", "stderr", "err", "combined"]);

// Anything that pins a needle to a boundary incidental text cannot cross:
// regex anchors, word boundaries, and whitespace (which makes a needle a phrase
// or ties it to a line break).
const ANCHORED = /[\^$]|\\b|\\B|\s|\\n|\\r|\\t|\\s/;

// Short enough to collide with a temp path, a duration or a CI annotation:
// any all-digit needle (`42`, `404`), or any needle of three characters or less.
const SHORT = (needle) => /^\d+$/.test(needle) || needle.length <= 3;

// True when a needle proves nothing on its own — unanchored AND short.
function isBare(needle) {
  return !ANCHORED.test(needle) && SHORT(needle);
}

// The trailing property of a member chain: `r.out` → `out`, `o.out[0]` → `out`.
function receiverName(chain) {
  const segments = chain.replace(/\[\s*\d+\s*\]/g, "").split(".");
  return segments[segments.length - 1];
}

const CHAIN = "[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*|\\s*\\[\\s*\\d+\\s*\\])*";

// `!out.includes("42")` — a negated substring search over a stream.
const NEGATED_INCLUDES = new RegExp(
  `!\\s*(${CHAIN})\\s*\\.\\s*includes\\(\\s*(['"\`])((?:\\\\.|(?!\\2)[^\\\\])*)\\2\\s*\\)`,
  "g",
);

// `!/42/.test(out)` — the regex form of the same mistake.
const NEGATED_REGEX_TEST = new RegExp(
  `!\\s*/((?:\\\\.|\\[[^\\]]*\\]|[^/\\\\\\n])+)/[gimsuy]*\\s*\\.\\s*test\\(\\s*(${CHAIN})\\s*\\)`,
  "g",
);

// Every bare negative assertion in one source, as
// `{ line, needle, receiver, form }`, in line order. `line` is 1-indexed so it
// can be printed as `file:line` and clicked.
export function findBareNegativeAssertions(source = "") {
  const findings = [];
  String(source)
    .split("\n")
    .forEach((text, index) => {
      for (const [re, form] of [
        [NEGATED_INCLUDES, "includes"],
        [NEGATED_REGEX_TEST, "regex"],
      ]) {
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const [chain, needle] = form === "includes" ? [m[1], m[3]] : [m[2], m[1]];
          if (!STREAM_NAMES.has(receiverName(chain))) continue;
          if (!isBare(needle)) continue;
          findings.push({ line: index + 1, needle, receiver: chain.trim(), form });
        }
      }
    });
  return findings.sort((a, b) => a.line - b.line);
}

// Every `*.test.mjs` suite in a scripts directory, sorted for stable output.
export function listTestFiles(scriptsDir) {
  return readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();
}

// Every offender across a scripts directory, as `{ file, line, needle, ... }`.
export function scanTestSuites(scriptsDir) {
  return listTestFiles(scriptsDir).flatMap((file) =>
    findBareNegativeAssertions(readFileSync(join(scriptsDir, file), "utf8")).map(
      (finding) => ({ file, ...finding }),
    ),
  );
}

// --- CLI guard ----------------------------------------------------------
// Runs as a GATES.md gate. Exits non-zero naming every offender as `file:line`,
// so a flaky absence proof cannot be added without being seen. Missing inputs
// fail loud with a clear message, never a stack trace and never a silent pass.
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const scriptsDir = process.env.SCRIPTS_DIR || "scripts";

  if (!existsSync(scriptsDir)) {
    console.error(
      `Scripts directory not found: ${scriptsDir}. Cannot check negative assertions.`,
    );
    process.exit(1);
  }

  let findings;
  let total;
  try {
    findings = scanTestSuites(scriptsDir);
    total = listTestFiles(scriptsDir).length;
  } catch (e) {
    console.error(`Could not read the test sources in ${scriptsDir}: ${e.message}`);
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(
      `${findings.length} negative assertion(s) prove an absence with a bare needle against captured process output:`,
    );
    for (const f of findings) {
      console.error(`  ${join(scriptsDir, f.file)}:${f.line}: "${f.needle}" in ${f.receiver}`);
    }
    console.error(
      "\nA short needle matches temp paths, timings and CI annotations by accident, so the",
    );
    console.error(
      "assertion flakes. Prove the absence with a side effect only the forbidden code can",
    );
    console.error(
      "produce (a probe file), or anchor the needle: a full phrase, or a `^`/`$`/`\\b` match.",
    );
    process.exit(1);
  }

  console.log(`OK: ${total} test suite(s) prove absences with anchored evidence.`);
}
