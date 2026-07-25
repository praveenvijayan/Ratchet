#!/usr/bin/env node
// gates-hermetic.test.mjs — behaviour tests for the agent-CLI-free gate run.
// Zero dependencies. Run:  node scripts/gates-hermetic.test.mjs
//
// One test per acceptance criterion of issue #497, exercised through the public
// interface (the exported decisions and the guard CLI as a subprocess) against
// FIXTURE suites in a temp dir — a guard asserted against this repo's real
// suites would prove nothing about tomorrow's.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hiddenBinaries, suiteRows, REQUIRES_MARKER } from "./gates-hermetic.mjs";
import { defaultConfig } from "./herd.mjs";

// fileURLToPath (not url.pathname) so a repo path containing spaces resolves to
// a real filename rather than a percent-encoded one node can't open.
const GUARD = fileURLToPath(new URL("./gates-hermetic.mjs", import.meta.url));
const gatesFile = fileURLToPath(new URL("../GATES.md", import.meta.url));

const gatesTable = (rows) =>
  ["# Gates", "", "| Order | Gate | Command | Pass condition |", "|---|---|---|---|", ...rows, ""].join("\n");

// A fixture project: a stub `claude` binary on its own PATH, plus suites that
// only pass while that stub is reachable. This is the shape of the PR #495
// incident — a suite that green-lights on a developer's machine alone.
function fixture(suites) {
  const dir = mkdtempSync(join(tmpdir(), "gates-hermetic-test-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "claude"), 0o755);

  const rows = [];
  const logs = {};
  suites.forEach(({ name, declares }, i) => {
    const log = join(dir, `${name}.runs`);
    logs[name] = log;
    writeFileSync(log, "");
    const declaration = declares ? `// ${REQUIRES_MARKER}: ${declares} — fixture declaration\n` : "";
    writeFileSync(
      join(dir, "scripts", `${name}.test.mjs`),
      `${declaration}import { accessSync, appendFileSync, constants } from "node:fs";\n` +
        `import { join, delimiter } from "node:path";\n` +
        `appendFileSync(${JSON.stringify(log)}, "ran\\n");\n` +
        `const onPath = String(process.env.PATH || "").split(delimiter).some((d) => {\n` +
        `  try { accessSync(join(d, "claude"), constants.X_OK); return true; } catch { return false; }\n` +
        `});\n` +
        `if (!onPath) { console.error("claude is not on PATH"); process.exit(1); }\n`,
    );
    rows.push(`| ${i + 1} | test: ${name} | \`node scripts/${name}.test.mjs\` | exit 0 |`);
  });
  writeFileSync(join(dir, "GATES.md"), gatesTable(rows));
  return { dir, binDir, logs, path: `${binDir}:${process.env.PATH}` };
}

// Run the guard against a fixture. BASE_GATES_FILE is blanked because CI sets
// it and it would otherwise leak in and point the guard at the real repo.
function runGuard({ dir, path }) {
  const res = spawnSync("node", [GUARD], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: path, GATES_FILE: "GATES.md", BASE_GATES_FILE: "" },
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

const runCount = (log) => readFileSync(log, "utf8").split("\n").filter(Boolean).length;

// --- Criterion 1: a suite that needs an agent CLI is named by the gate ----
{
  const fx = fixture([{ name: "needs-claude" }]);

  // It passes under the developer's PATH — exactly why the incident shipped.
  const normal = spawnSync("node", ["scripts/needs-claude.test.mjs"], {
    cwd: fx.dir,
    encoding: "utf8",
    env: { ...process.env, PATH: fx.path },
  });
  assert.equal(normal.status, 0, "the fixture suite must pass while the stub binary is reachable");

  const red = runGuard(fx);
  assert.notEqual(red.status, 0, "a suite that needs an agent CLI must make the guard exit non-zero");
  assert.ok(red.out.includes("needs-claude.test.mjs"), `the red guard must name the failing suite (out: ${red.out})`);
}

// --- Criterion 2: the hidden set comes from the adapter config ------------
{
  const shipped = hiddenBinaries(defaultConfig());
  assert.ok(shipped.includes("claude"), "the shipped config's launch binaries are hidden");

  const extended = { adapters: { ...defaultConfig().adapters, gemini: { launch: ["gemini-cli", "-p", "{prompt}"] } } };
  const hidden = hiddenBinaries(extended);
  assert.ok(
    hidden.includes("gemini-cli"),
    "adding an adapter to the config must extend the hidden set with no edit to the guard",
  );
  for (const exe of shipped) assert.ok(hidden.includes(exe), `${exe} must stay hidden alongside the new adapter`);
}

// --- Criterion 3: a suite may declare the host binary it needs -----------
{
  const fx = fixture([{ name: "declared-need", declares: "claude" }, { name: "undeclaring-need" }]);
  const res = runGuard(fx);

  assert.notEqual(res.status, 0, "the undeclared suite must still fail the guard");
  assert.ok(/SKIP\s+.*declared-need/.test(res.out), `the declared suite must be skipped (out: ${res.out})`);
  assert.equal(runCount(fx.logs["declared-need"]), 0, "a skipped suite is not run at all");
  assert.ok(res.out.includes("undeclaring-need.test.mjs"), "the undeclared suite must be named as failing");
  assert.ok(!/FAIL\s+.*declared-need/.test(res.out), "the declared suite must not be reported as a failure");
}

// --- Criterion 4: GATES.md runs the guard as its own row ------------------
{
  const gatesText = readFileSync(gatesFile, "utf8");
  const commands = suiteRows(gatesText).map((row) => row.command);
  assert.ok(
    commands.some((cmd) => /scripts\/gates-hermetic\.test\.mjs/.test(cmd)),
    "GATES.md must run this suite",
  );
  // The guard itself is not a `*.test.mjs` row (it must never re-run itself), so
  // its row is checked against the raw table.
  assert.match(
    gatesText,
    /\|\s*[^|]*\|\s*`?node scripts\/gates-hermetic\.mjs`?\s*\|/,
    "GATES.md must run scripts/gates-hermetic.mjs as its own gate row",
  );
}

// --- Test note: two failing suites are both named, not just the first -----
{
  const fx = fixture([{ name: "first-red" }, { name: "second-red" }]);
  const res = runGuard(fx);

  assert.notEqual(res.status, 0, "two failing suites must make the guard exit non-zero");
  for (const name of ["first-red", "second-red"])
    assert.ok(res.out.includes(`${name}.test.mjs`), `${name} must be named too, not hidden by the first failure`);
}

// --- Non-functional: only the suites, once -------------------------------
{
  const mixed = gatesTable([
    "| 1 | test: alpha | `node scripts/alpha.test.mjs` | exit 0 |",
    "| 2 | test-coverage | `node scripts/gates-coverage.mjs` | exit 0 |",
    "| 3 | build | TODO: build command | — |",
    "| 4 | test: beta | `node scripts/beta.test.mjs` | exit 0 |",
  ]);
  assert.deepEqual(
    suiteRows(mixed).map((row) => row.file),
    ["scripts/alpha.test.mjs", "scripts/beta.test.mjs"],
    "the guard re-runs the test suites only — never the whole gate table",
  );

  const fx = fixture([{ name: "counted-one" }, { name: "counted-two" }]);
  runGuard(fx);
  for (const name of ["counted-one", "counted-two"])
    assert.equal(runCount(fx.logs[name]), 1, `${name} must be executed exactly once per guard run`);
}

console.log("gates-hermetic.test.mjs: all tests passed");
